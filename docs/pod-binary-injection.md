# Pod binary injection — architecture & plan

**Status:** in progress — §4 steps 1–5 shipped and committed (see §8, the as-built
log); steps 6–7 remain. The injection is functional end-to-end (unit-tested); live
validation on kind is the remaining proof. This document is the single source of
truth for the feature.
**Branch:** `feat/pod-binary-injection`, created from `main` @ `583e121`.
**Predecessor branch (superseded):** `feat/pod-daemon-healthcheck` (never committed; its 3-piece design
is folded into this plan as steps 1–2).

## 1. Goal

Let `agent-harness --pod --namespace <ns> --image <ANY_LINUX_IMAGE>` work with an image that does
**not** contain `agent-harness`. The CLI injects a Linux binary it built (or has cached) from the
laptop into the pod, over the exec channel, before starting the daemon.

Why: today the image is a build burden (must contain the tool, right arch, pushed to a registry —
see the `Exec format error` saga). With injection the image becomes **pure sandbox policy**
(distro, user, resources, isolation) and the tool version follows the laptop. Pattern is the same
as `kubectl cp` (stream via exec) and k3s (single binary into the box).

Constraints (user decision):
- **Linux binaries only** for the remote pod (the pod is always linux).
- Probe arch with `uname -m`; **if `uname` is missing → fall back to a linux binary** (default
  `linux-x64`), don't abort on the probe.
- Clean code, tests, no new dependencies (self-contained, like the rest of `@agent-harness/k8s`).

## 2. Transport design (decided — raw binary, no tar)

Stream the **raw binary bytes** into the pod. Rejected alternative: tar (`packages/k8s/src/tar.ts`
was drafted and **discarded** — a hand-rolled ustar writer failed against system `tar`; and it was
unnecessary, see below).

Key insight: our exec channel is **text-only** (`DuplexChannel.send(data: string)`, `ws.send` of
strings). Two options:
1. base64-encode everything into the text channel (+33% size, extra framing) — rejected;
2. **raw bytes via a bytes-capable one-shot channel** — chosen. The WebSocket itself is binary-
   capable (we already set `binaryType="arraybuffer"` and *receive* `Uint8Array` frames); the text
   restriction is a `DuplexChannel` interface choice, not a transport one.

**EOF problem (the user's "terminator" idea):** exec stdin has no half-close/EOF frame.
Solution that needs **no terminator at all**: the receiver reads exactly the binary's length:

```
sh -c "head -c <N> > /usr/local/bin/agent-harness && chmod 755 /usr/local/bin/agent-harness"
```

`head -c N` consumes exactly N bytes from stdin and exits → the exec's command exits → the k8s
status channel (3) delivers the exit code → we resolve with a real exit status. No race, no
terminator, no tar. (Fallback if `head` is missing is out of scope: every linux base image we
target has coreutils `head`; if it's not there the exit status will say so and we surface it.)

**Why `sh -c`:** the k8s exec `command` param is an argv (no shell), so the pipeline/`>` must be
wrapped in a shell. `sh` exists in every target image (ubi/debian/alpine).

### Sequence (in `startPodRuntime`, after `waitForReady`)

```
createPod → waitForReady
  → runExec(["sh","-c","uname -m"])          # arch probe; on ANY failure → linux-x64 (user rule)
  → pick binary: cache dir dist/pod-bin/agent-harness-<os>-<arch>
       missing/stale → build with TARGET=bun-linux-<arch> (Bun.build, same options as scripts/build.ts)
       → write to cache
  → read binary bytes + size N
  → runExecBinary(["sh","-c","head -c N > /usr/local/bin/agent-harness && chmod 755 …"], bytes)
       → exitCode != 0 → throw with pod stderr (abort before RPC channel)
  → runExec(["agent-harness","--version"])   # probe: catches bad arch/libc/broken binary
       → exitCode != 0 → throw with stderr ("Exec format error" etc.)
  → openExec(["agent-harness","serve","--stdio","--model-proxy"])   # existing RPC path, unchanged
```

Install path `/usr/local/bin/agent-harness` (PATH is searched; if the image already had the tool,
ours shadows it — fine, it's our sandbox; note: running as root is assumed, same as today's
`COPY agent-harness /usr/bin/...` Dockerfile; if non-root, log a clear error from the exit status).

### `uname -m` → target mapping
- `x86_64` → `bun-linux-x64`
- `aarch64` → `bun-linux-arm64`
- anything else / `uname` missing / probe fails → `bun-linux-x64` (user rule: fallback, don't abort)
  — and the `--version` probe afterwards will loudly catch a wrong-arch binary.

## 3. Pieces & files

### 3.1 `KubeClient.runExec` + bytes-capable one-shot exec — `packages/k8s/src/`

**New file `exec-run.ts`** (keeps `client.ts` slim; pure-ish, testable with a fake WS like the
existing `exec-channel.test.ts` `FakeWS`):

```ts
export interface RunExecResult {
  readonly exitCode: number | null; // null = no status received (channel died)
  readonly stdout: string;
  readonly stderr: string;
  /** Terminal status message from channel 3 (k8s Status object JSON). */
  readonly status?: string;
}
export interface RunExecOptions {
  readonly timeoutMs?: number;   // default 30_000 — a probe must not hang
  readonly signal?: AbortSignal;
  readonly onProgress?: (bytesWritten: number) => void; // for the big transfer (log % every ~10%)
}
/**
 * Open an exec for `target`, stream `input` (optional) to stdin, and resolve when the
 * COMMAND EXITS (status on channel 3), or reject on timeout/close-without-status.
 * `input` is the raw bytes of the binary (sent on channel 0). Unlike `openExec` this
 * resolves on command exit, not on socket open — it's for one-shot commands.
 */
export function runExecOverWebSocket(
  makeWebSocket: (url: string, protocols: string[]) => WebSocketLike,
  url: string,
  subprotocols: string[],
  target: ExecTarget,
  input: Uint8Array | undefined,
  options?: RunExecOptions,
): Promise<RunExecResult>;
```

Implementation notes:
- Reuse `ExecDemux`? It re-chunks stdout on `\n` and drops unknown channels — fine for
  stdout/stderr, but for the **input** we need raw `channel 0` writes. Build a small
  channel-0 writer (same one byte `0x00` prefix as `encodeStdin`, but for `Uint8Array`
  without the `\n`), and collect channel-3 (status) + channel-2 (stderr) + channel-1 (stdout).
  A local demux here (or extend `ExecDemux` with raw/status support — decide when coding;
  prefer a local minimal demux so `ExecDemux` semantics for RPC stay untouched).
- **Chunk the input send** (e.g. 256 KB chunks) so we don't build one huge WebSocket frame
  and so `onProgress` can log. The binary is ~60 MB; chunking is mandatory.
- **Backpressure (v1: none, documented).** `ws.send` buffers in the socket layer; 60 MB is
  fine for a one-shot. If it ever stalls, add a readyState/`bufferedAmount` check — note in code.
- Status channel (3) carries a k8s `Status` JSON with `.status` ("Success"/"Failure") and
  `.details.causes[].message` (e.g. the `Exec format error`). Parse `Success` → exitCode 0;
  `Failure` → non-zero (k8s doesn't give the numeric exit code in the pod exec status — map
  to `1`; the **message** is what we surface). If the socket closes without status → reject.
- The existing `execChannel` buffering-until-open (f1363c6) applies here too: queue bytes
  until `open`.

**`client.ts`**: add
```ts
runExec(target: ExecTarget, input?: Uint8Array, options?: RunExecOptions): Promise<RunExecResult>
```
= build URL (`buildExecUrl`) + subprotocols (`execSubprotocols(this.token)`) + delegate to
`runExecOverWebSocket(this.makeWebSocket, …)`. This keeps `KubeClient` the single place that
knows URL/auth; the raw-WS logic stays injectable/testable.

**`types.ts`**: no change needed. **`index.ts`**: export the new module.

### 3.2 `PodCluster` interface + pod runtime — `packages/cli/src/pod-runtime.ts`

```ts
export interface PodCluster {
  createPod(pod: Pod, signal?: AbortSignal): Promise<Pod>;
  waitForReady(name: string, options?: WaitForReadyOptions): Promise<Pod>;
  deletePod(name: string, signal?: AbortSignal): Promise<void>;
  openExec(target: ExecTarget, options?: ExecChannelOptions): DuplexChannel;
  runExec(target: ExecTarget, input?: Uint8Array, options?: RunExecOptions): Promise<RunExecResult>; // NEW
}
```

New module **`pod-binary.ts`** (keeps `pod-runtime.ts` small):

```ts
export interface PodBinaryDeps {
  readonly kube: Pick<PodCluster, "runExec">;
  readonly podName: string;
  readonly container: string;      // AGENT_CONTAINER
  readonly podArch: () => Promise<"x64" | "arm64">;   // uname probe w/ fallback (testable seam)
  readonly resolveBinary: (target: "bun-linux-x64" | "bun-linux-arm64") => Promise<Uint8Array>;
  readonly log: (line: string) => void;
}
/** Inject the agent-harness binary into the pod and verify it runs. Throws with the
 *  pod's stderr on any failure (binary already cleaned up conceptually — pod is deleted
 *  by the caller's existing catch). */
export async function injectAgentBinary(deps: PodBinaryDeps): Promise<void>;
```

`injectAgentBinary` = the sequence in §2: probe → resolve bytes (log size) → `runExec`
`head -c N > path && chmod` (log progress ~every 10%) → `runExec(["agent-harness","--version"])`
→ on success log `[pod <name>] agent-harness <version> ready in pod`.

**`pod-runtime.ts`** `startPodRuntime`: after `waitForReady`, before `openExec`, call
`await injectAgentBinary(…)`. The existing `catch` already deletes the pod on throw — unchanged.

**Binary resolution (`resolveBinary`)** — new module **`pod-binary-build.ts`** in the CLI:
- Cache dir: `dist/pod-bin/agent-harness-<os>-<arch>` (next to the compiled binary; `dist/`
  is already git-ignored — confirmed in `.gitignore` line 5).
- Staleness check: compare cache mtime vs the source tree mtime? **v1: cache only by
  existence + an env override `HARNESS_POD_BIN` (explicit path to a prebuilt binary — the
  user's real flow is "faccio io", so this is the primary knob).** Rebuild when missing or
  when `HARNESS_POD_BIN` is set (read that file instead, no build).
- Build: `Bun.build` with the SAME options as `scripts/build.ts` (entrypoints main.ts +
  worker.ts as second entrypoint, yoga plugin, minify, `compile: { target }`). **Refactor
  `scripts/build.ts` to export the shared `buildBinary(outfile, target)` options so the pod
  path and the CLI build don't drift.** (The worker second entrypoint matters: the pod
  daemon runs the worker path… actually in the pod the daemon runs `serve --stdio` — check
  whether the pod path uses the worker; `serve --stdio` is the daemon, but keep the worker
  entrypoint for consistency with the local binary.)
- Reading the built file: `readFile` → `Uint8Array`.

### 3.3 `agent-harness --version` — `packages/cli/src/main.ts`

- New flag, handled **before** config loading (like `--help`/`connect`):
  prints the app version and exits 0. This is the probe command and also user-facing.
- Version source: read `package.json` at build time via `compile.define` in
  `scripts/build.ts` (`process.env.HARNESS_APP_VERSION` → JSON version), with runtime
  fallback `"dev"` when undefined (source runs). Pattern verified working in compiled
  binaries (see §5, note 1).
- Add `--version` to the `HELP` text.
- Test: `main(["bun","cli","--version"])` → exit 0, output contains a version string, and
  **does not require config** (works with `HARNESS_CONFIG_DIR` pointing at an empty dir —
  important: it must not scaffold or load model config).

### 3.4 Docs/TODO
- `TODO.md`: add entry under F4 (after F4.d): `F4.e — pod binary injection` (unchecked until
  done, with the design summary + the `HARNESS_POD_BIN` knob).
- `docs/F4-pod-execution.md`: one section (or a pointer) — the injection flow + the image no
  longer needs the tool.
- Update `pod.ts` header comment + `main.ts` `--pod` help text: `--image` now only needs to be
  a linux image with `sh` (+ `head`), the tool is injected.
- `dist/Dockerfile`: mark as optional/legacy (still valid for prebaked images) — comment only.

## 4. Order of implementation (each step committed, tests green)

1. [x] **`--version`** in `main.ts` (+ `define` in `scripts/build.ts`, HELP line, test in
   `main.test.ts`). Small, independent, unblocks the probe. — **shipped** (`70939c5`).
2. [x] **`runExec`** in `@agent-harness/k8s` (`exec-run.ts` + `client.ts` + `index.ts` + tests
   with `FakeWS`-style fake: status→resolve, stdout/stderr collection, timeout reject,
   input chunking on channel 0, close-without-status reject). — **shipped** (`f9939cb`).
3. [x] **`PodCluster.runExec`** + **`injectAgentBinary`** (`pod-binary.ts`) with tests: a fake
   cluster records calls; assert sequence (uname → head -c N with bytes → --version),
   arch mapping, uname-failure fallback to x64, `head` failure → throw with stderr,
   `--version` failure → throw with stderr. Extend the existing `FakeCluster` in
   `pod-runtime.test.ts` with a `runExec`. — **shipped** (`7b650ee`).
4. [x] **`resolveBinary`** (`pod-binary-build.ts`): `HARNESS_POD_BIN` path, cache, `Bun.build`
   with shared options from refactored `scripts/build.ts`; test the `HARNESS_POD_BIN` and
   cache-hit paths (skip the real build in unit tests — it's slow; the build path is
   covered manually/live). — **shipped** (`65497b7`).
5. [x] **Wire into `startPodRuntime`** + log lines matching the existing `[pod]` style.
   — **shipped** (`280acd6`).
6. [ ] **Live validation** (the real test, against kind):
   - build `TARGET=bun-linux-x64` (or via `HARNESS_POD_BIN` pointing at a prebuilt one),
   - run `./dist/agent-harness --pod --namespace test00 --image <busybox-or-ubi-without-tool>`
     (any linux image that has `sh`; `busybox` has `sh` + `head`),
   - expect: log lines for probe/transfer/progress/version, then the TUI opens and a turn
     works end-to-end (model via reverse tunnel).
   - Also verify the negative path: point `HARNESS_POD_BIN` at the macOS binary → expect a
     clear `[pod …] agent-harness --version failed: … Exec format error`-style message,
     pod deleted, no opaque "connection closed".
7. [ ] **Docs/TODO** (see 3.4).

## 5. Files to read when resuming (with why)

| File | Why |
|---|---|
| `packages/k8s/src/exec-channel.ts` | `WebSocketLike`, `execChannel` (buffer-until-open pattern to reuse), `buildExecUrl`, `execSubprotocols`, `ExecTarget` |
| `packages/k8s/src/exec-frame.ts` | channel bytes (0 stdin, 1 stdout, 2 stderr, 3 status), `ExecDemux`, `encodeStdin` |
| `packages/k8s/src/client.ts` | `KubeClient`, `openExec` (template for `runExec`), `KubeApiError` |
| `packages/k8s/src/pod.ts` | `buildPodManifest`, `AGENT_CONTAINER` (container name for exec) |
| `packages/k8s/test/exec-channel.test.ts` | `FakeWS` — the test double pattern for the new `exec-run.ts` tests |
| `packages/k8s/test/client.test.ts` | mock API server pattern for `KubeClient` tests |
| `packages/cli/src/pod-runtime.ts` | `startPodRuntime`, `PodCluster` (add `runExec`), log style, catch-deletes-pod |
| `packages/cli/test/pod-runtime.test.ts` | `FakeCluster` (add `runExec`), `ScriptedProvider`, test style |
| `packages/cli/src/main.ts` | arg flow: `--help`/`connect` handling (template for `--version`), `--pod` block, HELP text |
| `packages/cli/src/serve.ts` | `serve --stdio` (what the daemon command runs; check worker usage) |
| `scripts/build.ts` | the `Bun.build` options to share (`entrypoints` incl. worker second entrypoint, yoga plugin, `define` for version, `TARGET` env, mac codesign) |
| `packages/transport/src/channel.ts` | `DuplexChannel` (text-only — why `runExec` needs its own bytes path) |
| `TODO.md` (F4 section) + `docs/F4-pod-execution.md` | where to record F4.e |

## 6. Notes & pitfalls (learned so far)

1. **`compile.define` works in compiled binaries** (verified: `--define 'process.env.X="v"'`
   → `process.env.X` reads the literal in the binary; source falls back to the env/`dev`).
2. **Worker second entrypoint + URL-form specifier** is required for the worker in compiled
   binaries (Bun ≥ 1.4.3; `engines.bun` already bumped). Keep it in the pod build options too.
3. **The k8s exec status channel (3) does NOT carry the numeric exit code** — only a `Status`
   object (`Success`/`Failure` + `details.causes[].message`). That's fine: `Success` → 0,
   `Failure` → 1, and the **message** (e.g. `Exec format error`) is what we surface.
4. **`sh -c` is required** for `>`/pipelines in the k8s exec `command` param (it's argv, no shell).
5. **Binary is ~60 MB** → chunk the stdin sends (256 KB) + progress log; do not build one
   giant WS frame.
6. **Do NOT reuse the RPC `execChannel`/`DuplexChannel` for the transfer** — it's text-only and
   newline-framed for RPC; `runExec` needs raw channel-0 bytes + status-aware resolution.
   Small, separate module (`exec-run.ts`).
7. **`head -c N` is the EOF signal** — the known binary size terminates the write; no custom
   terminator needed (user's "terminator" idea, in its simplest form).
8. **`uname -m` probe must never abort** (user rule): any failure (no `uname`, non-zero exit,
   unknown output) → `bun-linux-x64` fallback; the `--version` probe then catches a mismatch
   with a clear error.
9. **Assumes the pod runs as root** (writing `/usr/local/bin`). Same assumption as the current
   `dist/Dockerfile` (`COPY … /usr/bin/…`); if a non-root image is used, the `head`/`chmod`
   exit status surfaces "Permission denied" — acceptable for v1, note in docs.
10. **`dist/` is git-ignored** (confirmed, `.gitignore` line 5) — the cache dir `dist/pod-bin/`
    is fine.
11. **Discarded:** a hand-rolled ustar writer (`packages/k8s/src/tar.ts`, deleted) — failed
    against system `tar` and was unnecessary given raw-byte streaming + `head -c`.
12. The old `feat/pod-daemon-healthcheck` branch is **empty** (confirmed: points at the same
    commit as `main`); its design lives in this doc (steps 1–2 + the `--version` probe).
    Delete it after this lands.

## 7. Open questions & decisions

- [x] **`onProgress` log granularity** — RESOLVED (step 3): one line per crossed 10% bucket
  (first at 10%, capped at 100%). A 60 MB transfer logs ~10 lines, not ~7.
- [x] **`chmod` in a second exec?** — RESOLVED (step 3): kept in the same `sh -c` one-liner
  as the `head -c` write (`head -c N > path && chmod 755 path`).
- [x] **Default install path** — RESOLVED (step 3): `/usr/local/bin/agent-harness`
  (`POD_BIN_PATH`); conventional, first in most PATHs, and the old Dockerfile's
  `/usr/bin` layout is superseded. Assumes the pod runs as root (same assumption as
  before); a non-root image surfaces "Permission denied" via the exec status.
- [x] **Cache invalidation** — RESOLVED (step 4, as intended): v1 = existence +
  `HARNESS_POD_BIN` override only (no mtime magic). Cache key is the full Bun target
  (`agent-harness-bun-linux-x64` / `-arm64`) so the two arches never collide; a stale
  binary is handled by deleting the cache file (or using the override).
- [x] **`runExecOverWebSocket` signature** — decided in step 2 (see §8): it takes a built
  `url` + `subprotocols` rather than an `ExecTarget`, so `KubeClient` stays the single
  place that knows URL/auth.
- [x] **Where `buildBinary` lives** — RESOLVED (step 4): in
  `packages/cli/src/pod-binary-build.ts` (not `scripts/build.ts`); the script imports it.
  Direction matters: `scripts/` is not part of the `tsc` project `include`, so the shared
  code must live in a package for type-checking, and the script (run by Bun) imports it.

## 8. Implementation log (as-built) — the source of truth

This section records what actually shipped, step by step, including deviations
from the plan in §2–§4. When this feature is done, this section (plus the code)
is the truth; §2–§4 remain the design rationale.

### Step 1 — `--version` (shipped, `70939c5`)
- `packages/cli/src/main.ts`: `--version` handled before config loading (like
  `--help`), prints `agent-harness <version>`, exits 0. Version from
  `process.env.HARNESS_APP_VERSION` (compile-time literal) with a `"dev"`
  fallback for source runs. Added to `HELP`.
- `scripts/build.ts`: reads the CLI package `version` and injects it via
  `compile.define`. The worker second entrypoint + yoga plugin are unchanged.
- Test (`main.test.ts`): exit 0, version line, and a fresh config dir is left
  unscaffolded (proves config is never loaded).
- **As planned.** Suite: 466 pass / 0 fail / 1 skip.

### Step 2 — one-shot `runExec` (shipped, `f9939cb`)
- `packages/k8s/src/exec-run.ts` (new): `runExecOverWebSocket(makeWebSocket,
  url, subprotocols, input?, options?)` — resolves on the k8s status channel
  (3), streams raw stdin on channel 0 in 256 KB chunks, buffers until the
  socket opens, supports timeout + abort, rejects on a close without a status.
  `parseKubeStatus` maps `Success`→0 / `Failure`→1 and extracts the most
  specific cause message (e.g. "Exec format error"); returns `null` on
  fragments so a status split across frames still resolves.
- `KubeClient.runExec(target, input?, options?)` builds URL + subprotocols and
  delegates; `index.ts` exports the module.
- **Deviation (intentional):** the low-level function takes a built `url` +
  `subprotocols`, not an `ExecTarget` — keeps `KubeClient` the single place
  that knows URL/auth and makes the WS logic injectable. (§7.)
- Tests: `FakeWS`-driven (resolve, reassembly, chunking + progress,
  buffer-until-open, timeout, close-without-status, abort, `parseKubeStatus`) +
  a `KubeClient.runExec` URL/subprotocol test.
- Suite: 480 pass / 0 fail / 1 skip.

### Step 3 — `injectAgentBinary` (shipped, `7b650ee`)
- `packages/cli/src/pod-binary.ts` (new): `mapUnameOutput`, `archToTarget`,
  `probePodArch` (never throws — any probe failure → x64), `injectAgentBinary`
  (install via `sh -c "head -c N > /usr/local/bin/agent-harness && chmod 755 …"`
  with ~10% progress + size-scaled timeout, then an `agent-harness --version`
  verify), and `POD_BIN_PATH`.
- `packages/cli/src/pod-runtime.ts`: `PodCluster` gains `runExec`.
- Tests (`pod-binary.test.ts`): arch mapping, probe fallbacks, the exact exec
  sequence + bytes, arm64 target selection, install/`--version` failures
  surfacing pod stderr, the size-scaled timeout, ~10% progress bucketing.
  `pod-runtime.test.ts`'s `FakeCluster` implements `runExec`.
- **Deviations (intentional):** progress logged per crossed 10% bucket; `chmod`
  in the same `sh -c`; install path `/usr/local/bin`. (§7.)
- **Not yet wired into `startPodRuntime`** — that is step 5. Until then the
  injection code is present and unit-tested but not invoked by `--pod`.
- Suite: 493 pass / 0 fail / 1 skip.

### Step 4 — `resolvePodBinary` (shipped, `65497b7`)
- `packages/cli/src/pod-binary-build.ts` (new):
  - `resolvePodBinary(target, { cacheDir?, build?, log? })` — resolution order:
    1. `HARNESS_POD_BIN` (explicit prebuilt path; read directly, never cached/built),
    2. cache `dist/pod-bin/agent-harness-<target>` (git-ignored),
    3. build into the cache. A failed build throws with a `TARGET=… bun run
       compile` + `HARNESS_POD_BIN` hint and leaves no partial cache entry.
  - `buildBinary(outfile, target)` — the `Bun.build` options (main.ts +
    worker.ts entrypoints, embedded yoga-wasm, version `define`, minify)
    extracted from `scripts/build.ts` so the CLI binary and the injected pod
    binary can never drift. `findYogaWasm` moved with it.
  - `podBinCacheDir()`, `ResolvePodBinaryOptions` (`cacheDir`/`build` are test
    seams; `log` mirrors the `[pod …]` style as `[pod-binary] …`).
- `scripts/build.ts` (refactored): now imports `buildBinary` and keeps only the
  `TARGET` env plumbing + the macOS ad-hoc re-sign. **Deviation (intentional):**
  the shared code lives in the CLI package, not the script — `scripts/` is not
  in the `tsc` project, so type-checking requires package-resident code (§7).
- Tests (`pod-binary-build.test.ts`): override wins (no cache/build),
  cache-miss builds, cache-hit skips the build, failed-build error + no
  partial entry. The real cross-compile stays out of unit tests (slow).
- Verified the refactor end-to-end on macOS: `bun run compile` → Mach-O arm64,
  `./dist/agent-harness --version` → `agent-harness 0.0.0` (version `define`
  intact after the move).
- **Pitfall hit (test-only):** in Bun, `process.env.X = undefined` stringifies
  to `"undefined"` (it does NOT delete the key) — env cleanup in tests must use
  `Reflect.deleteProperty(process.env, "X")` (also `noDelete`-clean for biome).
- Suite: 497 pass / 0 fail / 1 skip.

### Step 5 — wire into `startPodRuntime` (shipped, `280acd6`)
- `packages/cli/src/pod-runtime.ts`: `startPodRuntime` now runs
  `createPod → waitForReady → injectAgentBinary → openExec(serve --stdio)`,
  wiring the REAL seams (no fakes in production):
    - `podArch: () => probePodArch(kube, name, AGENT_CONTAINER)` — the
      `uname -m` probe with x64 fallback (never aborts).
    - `resolveBinary: (t) => resolvePodBinary(t, { log })` —
      `HARNESS_POD_BIN` override → `dist/pod-bin/` cache → shared
      `buildBinary` cross-compile.
    - `log: deps.log` — injection logs use the existing `[pod …]` style.
  Any injection failure throws inside the existing `try`, so the pod is
  deleted before the error surfaces (behavior unchanged). Module flow
  comment updated.
- Tests (`pod-runtime.test.ts`): the happy path now asserts the FULL
  sequence with the real `resolvePodBinary` wired (test sets
  `HARNESS_POD_BIN` to an 8-byte fake file → no build): create, ready,
  `uname -m`, the exact install shell command (`head -c 8 >
  /usr/local/bin/agent-harness && chmod 755 …`), `--version` verify, then
  the daemon exec — in that order. New negative test: a failing
  `--version` (e.g. wrong arch) rethrows with the pod stderr, deletes the
  pod, and never opens the daemon exec.
- **This makes the injection functional end-to-end.** Remaining: live
  validation (step 6) and docs (step 7).
- Suite: 498 pass / 0 fail / 1 skip.

### Step 6 — live validation (kind)
- Planned: build a Linux binary (or point `HARNESS_POD_BIN` at one), run
  `--pod` against an image without the tool, confirm probe/transfer/progress/
  version logs then a working turn; negative case = a wrong-arch binary must
  yield a clear `--version` failure, not an opaque close.

### Step 7 — docs/TODO
- Planned: `TODO.md` F4.e entry, `docs/F4-pod-execution.md` section, update
  `pod.ts` header + `--pod` help, mark `dist/Dockerfile` optional.

