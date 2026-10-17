# Pod binary injection — architecture & plan

> **Status:** done — steps 1–7 shipped (details below) · legacy doc (pre-AGENTS §10), not retrofitted to the four sections

**Status:** steps 1–7 shipped; step 6 PROVEN live (UBI9 full success,
89 MB transfer + daemon; busybox fails cleanly at the `--version` probe — glibc
constraint). The working tree also carries, in the same commit: the `--pod`
flag → `run` subcommand (positional pod `<name>`, `--namespace=`, `--resume`),
the pod **delete-on-exit** safety net (Ctrl+C / SIGTERM), the missing-namespace
404 → actionable error, and the **single-line startup rendering** (spinner +
docker-pull bar on TTY, discrete ~10% lines when piped). All validated
(typecheck + lint clean, 519 pass / 0 fail / 1 skip). See §9 for the resume
checkpoint. This document is the single source of truth for the feature.
**Branch:** `feat/pod-binary-injection`, created from `main` @ `583e121`.
**Predecessor branch (superseded):** `feat/pod-daemon-healthcheck` (never committed; its 3-piece design
is folded into this plan as steps 1–2).

## 1. Goal

Let `tentacle run --namespace <ns> --image <ANY_LINUX_IMAGE>` work with an image that does
**not** contain `tentacle`. The CLI injects a Linux binary it built (or has cached) from the
laptop into the pod, over the exec channel, before starting the daemon.

Why: today the image is a build burden (must contain the tool, right arch, pushed to a registry —
see the `Exec format error` saga). With injection the image becomes **pure sandbox policy**
(distro, user, resources, isolation) and the tool version follows the laptop. Pattern is the same
as `kubectl cp` (stream via exec) and k3s (single binary into the box).

Constraints (user decision):
- **Linux binaries only** for the remote pod (the pod is always linux).
- Probe arch with `uname -m`; **if `uname` is missing → fall back to a linux binary** (default
  `linux-x64`), don't abort on the probe.
- Clean code, tests, no new dependencies (self-contained, like the rest of `@tentacle/k8s`).

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
sh -c "head -c <N> > /usr/local/bin/tentacle && chmod 755 /usr/local/bin/tentacle"
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
  → pick binary: cache dir dist/pod-bin/tentacle-<os>-<arch>
       missing/stale → build with TARGET=bun-linux-<arch> (Bun.build, same options as scripts/build.ts)
       → write to cache
  → read binary bytes + size N
  → runExecBinary(["sh","-c","head -c N > /usr/local/bin/tentacle && chmod 755 …"], bytes)
       → exitCode != 0 → throw with pod stderr (abort before RPC channel)
  → runExec(["tentacle","--version"])   # probe: catches bad arch/libc/broken binary
       → exitCode != 0 → throw with stderr ("Exec format error" etc.)
  → openExec(["tentacle","serve","--stdio","--model-proxy"])   # existing RPC path, unchanged
```

Install path `/usr/local/bin/tentacle` (PATH is searched; if the image already had the tool,
ours shadows it — fine, it's our sandbox; note: running as root is assumed, same as today's
`COPY tentacle /usr/bin/...` Dockerfile; if non-root, log a clear error from the exit status).

> **Third caller (F4.g, `exec` attach — branch `feat/pod-exec-attach`):**
> `startExecRuntime` runs the SAME sequence against a pod that already exists,
> but with a **preflight `tentacle --version`** in front: if it succeeds
> the whole injection is skipped (re-attach is a sub-second probe, no 89 MB
> transfer) and its stdout is the version label; only on failure does the full
> sequence above run. The pod is user-owned, so no create/delete wraps it and a
> failed injection leaves the pod untouched (the glibc hint still applies).
> Plan + as-built: `docs/feat/pod-exec-attach.md`.

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
/** Inject the tentacle binary into the pod and verify it runs. Throws with the
 *  pod's stderr on any failure (binary already cleaned up conceptually — pod is deleted
 *  by the caller's existing catch). */
export async function injectAgentBinary(deps: PodBinaryDeps): Promise<void>;
```

`injectAgentBinary` = the sequence in §2: probe → resolve bytes (log size) → `runExec`
`head -c N > path && chmod` (progress: TTY single-line bar / piped ~10% lines) →
`runExec(["tentacle","--version"])` → return the version label (the caller's
final line folds it in; no separate "ready in pod" log line).

**`pod-runtime.ts`** `startPodRuntime`: after `waitForReady`, before `openExec`, call
`await injectAgentBinary(…)`. The existing `catch` already deletes the pod on throw — unchanged.

**Binary resolution (`resolveBinary`)** — new module **`pod-binary-build.ts`** in the CLI:
- Cache dir: `dist/pod-bin/tentacle-<os>-<arch>` (next to the compiled binary; `dist/`
  is already git-ignored — confirmed in `.gitignore` line 5).
- Staleness check: compare cache mtime vs the source tree mtime? **v1: cache only by
  existence + an env override `TENTACLE_POD_BIN` (explicit path to a prebuilt binary — the
  user's real flow is "faccio io", so this is the primary knob).** Rebuild when missing or
  when `TENTACLE_POD_BIN` is set (read that file instead, no build).
- Build: `Bun.build` with the SAME options as `scripts/build.ts` (entrypoints main.ts +
  worker.ts as second entrypoint, yoga plugin, minify, `compile: { target }`). **Refactor
  `scripts/build.ts` to export the shared `buildBinary(outfile, target)` options so the pod
  path and the CLI build don't drift.** (The worker second entrypoint matters: the pod
  daemon runs the worker path… actually in the pod the daemon runs `serve --stdio` — check
  whether the pod path uses the worker; `serve --stdio` is the daemon, but keep the worker
  entrypoint for consistency with the local binary.)
- Reading the built file: `readFile` → `Uint8Array`.

### 3.3 `tentacle --version` — `packages/cli/src/main.ts`

- New flag, handled **before** config loading (like `--help`/`connect`):
  prints the app version and exits 0. This is the probe command and also user-facing.
- Version source: read `package.json` at build time via `compile.define` in
  `scripts/build.ts` (`process.env.TENTACLE_APP_VERSION` → JSON version), with runtime
  fallback `"dev"` when undefined (source runs). Pattern verified working in compiled
  binaries (see §5, note 1).
- Add `--version` to the `HELP` text.
- Test: `main(["bun","cli","--version"])` → exit 0, output contains a version string, and
  **does not require config** (works with `TENTACLE_CONFIG_DIR` pointing at an empty dir —
  important: it must not scaffold or load model config).

### 3.4 Docs/TODO
- `TODO.md`: add entry under F4 (after F4.d): `F4.e — pod binary injection` (unchecked until
  done, with the design summary + the `TENTACLE_POD_BIN` knob).
- `docs/F4-pod-execution.md`: one section (or a pointer) — the injection flow + the image no
  longer needs the tool.
- Update `pod.ts` header comment + `main.ts` `run` help text: `--image` now only needs to be
  a linux image with `sh` (+ `head`), the tool is injected.
- `dist/Dockerfile`: mark as optional/legacy (still valid for prebaked images) — comment only.

## 4. Order of implementation (each step committed, tests green)

1. [x] **`--version`** in `main.ts` (+ `define` in `scripts/build.ts`, HELP line, test in
   `main.test.ts`). Small, independent, unblocks the probe. — **shipped** (`70939c5`).
2. [x] **`runExec`** in `@tentacle/k8s` (`exec-run.ts` + `client.ts` + `index.ts` + tests
   with `FakeWS`-style fake: status→resolve, stdout/stderr collection, timeout reject,
   input chunking on channel 0, close-without-status reject). — **shipped** (`f9939cb`).
3. [x] **`PodCluster.runExec`** + **`injectAgentBinary`** (`pod-binary.ts`) with tests: a fake
   cluster records calls; assert sequence (uname → head -c N with bytes → --version),
   arch mapping, uname-failure fallback to x64, `head` failure → throw with stderr,
   `--version` failure → throw with stderr. Extend the existing `FakeCluster` in
   `pod-runtime.test.ts` with a `runExec`. — **shipped** (`7b650ee`).
4. [x] **`resolveBinary`** (`pod-binary-build.ts`): `TENTACLE_POD_BIN` path, cache, `Bun.build`
   with shared options from refactored `scripts/build.ts`; test the `TENTACLE_POD_BIN` and
   cache-hit paths (skip the real build in unit tests — it's slow; the build path is
   covered manually/live). — **shipped** (`65497b7`).
5. [x] **Wire into `startPodRuntime`** + log lines matching the existing `[pod]` style.
   — **shipped** (`280acd6`).
6. [~] **Live validation** — done for UBI9 (full success) + busybox (clean probe
   failure); the negative Mach-O case is still pending. See §9.
   - build `TARGET=bun-linux-x64` (or via `TENTACLE_POD_BIN` pointing at a prebuilt one),
   - run `./dist/tentacle run --namespace test00 --image <busybox-or-ubi-without-tool>`
     (any linux image that has `sh`; `busybox` has `sh` + `head`),
   - expect: log lines for probe/transfer/progress/version, then the TUI opens and a turn
     works end-to-end (model via reverse tunnel).
   - Also verify the negative path: point `TENTACLE_POD_BIN` at the macOS binary → expect a
     clear `[pod …] tentacle --version failed: … Exec format error`-style message,
     pod deleted, no opaque "connection closed".
7. [x] **Docs/TODO** (see 3.4) — **done** (working tree; note `dist/Dockerfile`
   is git-ignored, its marker is local-only).

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
| `packages/cli/src/main.ts` | arg flow: `--help`/`connect` handling (template for `--version`), `run` block, HELP text |
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
- [x] **Default install path** — RESOLVED (step 3): `/usr/local/bin/tentacle`
  (`POD_BIN_PATH`); conventional, first in most PATHs, and the old Dockerfile's
  `/usr/bin` layout is superseded. Assumes the pod runs as root (same assumption as
  before); a non-root image surfaces "Permission denied" via the exec status.
- [x] **Cache invalidation** — RESOLVED (step 4, as intended): v1 = existence +
  `TENTACLE_POD_BIN` override only (no mtime magic). Cache key is the full Bun target
  (`tentacle-bun-linux-x64` / `-arm64`) so the two arches never collide; a stale
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
  `--help`), prints `tentacle <version>`, exits 0. Version from
  `process.env.TENTACLE_APP_VERSION` (compile-time literal) with a `"dev"`
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
  (install via `sh -c "head -c N > /usr/local/bin/tentacle && chmod 755 …"`
  with ~10% progress + size-scaled timeout, then an `tentacle --version`
  verify), and `POD_BIN_PATH`.
- `packages/cli/src/pod-runtime.ts`: `PodCluster` gains `runExec`.
- Tests (`pod-binary.test.ts`): arch mapping, probe fallbacks, the exact exec
  sequence + bytes, arm64 target selection, install/`--version` failures
  surfacing pod stderr, the size-scaled timeout, ~10% progress bucketing.
  `pod-runtime.test.ts`'s `FakeCluster` implements `runExec`.
- **Deviations (intentional):** progress logged per crossed 10% bucket; `chmod`
  in the same `sh -c`; install path `/usr/local/bin`. (§7.)
- **Updated in the working tree (this commit):** the progress presentation is now
  the single-line renderer (see §9 "Also in this working tree" #4) — a spinner
  line on a TTY (the bar is the transfer phase's text), discrete ~10% lines when
  piped; the arch probe is folded into the "resolving <target>" phase; and
  `injectAgentBinary` returns the `--version` label (the caller folds it into its
  final line) instead of logging a "ready in pod" line.
- **Not yet wired into `startPodRuntime`** — that is step 5. Until then the
  injection code is present and unit-tested but not invoked by `run`.
- Suite: 493 pass / 0 fail / 1 skip.

### Step 4 — `resolvePodBinary` (shipped, `65497b7`)
- `packages/cli/src/pod-binary-build.ts` (new):
  - `resolvePodBinary(target, { cacheDir?, build?, log? })` — resolution order:
    1. `TENTACLE_POD_BIN` (explicit prebuilt path; read directly, never cached/built),
    2. cache `dist/pod-bin/tentacle-<target>` (git-ignored),
    3. build into the cache. A failed build throws with a `TARGET=… bun run
       compile` + `TENTACLE_POD_BIN` hint and leaves no partial cache entry.
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
  `./dist/tentacle --version` → `tentacle 0.0.0` (version `define`
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
      `TENTACLE_POD_BIN` override → `dist/pod-bin/` cache → shared
      `buildBinary` cross-compile.
    - `log: deps.log` — injection logs use the existing `[pod …]` style.
  Any injection failure throws inside the existing `try`, so the pod is
  deleted before the error surfaces (behavior unchanged). Module flow
  comment updated.
- Tests (`pod-runtime.test.ts`): the happy path now asserts the FULL
  sequence with the real `resolvePodBinary` wired (test sets
  `TENTACLE_POD_BIN` to an 8-byte fake file → no build): create, ready,
  `uname -m`, the exact install shell command (`head -c 8 >
  /usr/local/bin/tentacle && chmod 755 …`), `--version` verify, then
  the daemon exec — in that order. New negative test: a failing
  `--version` (e.g. wrong arch) rethrows with the pod stderr, deletes the
  pod, and never opens the daemon exec.
- **This makes the injection functional end-to-end.** Remaining: live
  validation (step 6) and docs (step 7).
- Suite: 498 pass / 0 fail / 1 skip.

### Step 6 — live validation (done — real OpenShift x86_64 cluster, ns `test00`; details in §9)
- UBI9 full success (89 MB transfer 10%→100% + daemon in pod); busybox clean
  failure at the `--version` probe (glibc constraint, clear error + now the
  hint). **PENDING:** the negative case with `TENTACLE_POD_BIN` pointing at the
  macOS Mach-O binary (expect a clear `--version failed … Exec format error`,
  pod deleted, no opaque close).

### Step 7 — docs/TODO (done, working tree)
- `TODO.md` F4.e entry (MVP now F4.a–F4.e); `docs/F4-pod-execution.md` F4.e
  section + the old "F4.e hardening" renumbered F4.f + status header;
  `packages/k8s/src/pod.ts` header/doc + `main.ts` `run` help and
  `--image` error text (glibc + `sh`+`head` constraint, tool is injected,
  `TENTACLE_POD_BIN` knob documented); `dist/Dockerfile` marked optional/legacy
  — note: the file is git-IGNORED (`dist/`), so that marker is local-only and
  not committable.

## 9. CHECKPOINT 2026-10-15 — live validation + fixes (resume from here)

### Live validation (step 6, real OpenShift cluster, ns `test00`, node x86_64)
- ✅ **UBI9** (`registry.access.redhat.com/ubi9/ubi:latest`): FULL SUCCESS — cache-hit
  (`dist/pod-bin/tentacle-bun-linux-x64`, 89 MB), transfer 10%→100% over the WS
  exec, `tentacle 0.0.0 ready in pod`, daemon started. The live ~89 MB transfer
  (the one never proven by unit tests) WORKS.
- ⚠️ **busybox**: injection succeeded, `--version` probe failed with a CLEAR error
  (`error while loading shared libraries: libdl.so.2: cannot open shared object file`).
  The probe did its job (no opaque "connection closed").

### glibc constraint (decided — cannot be removed)
- `readelf` on the injected x64 binary: NEEDED `libc.so.6`, `ld-linux-x86-64.so.2`,
  `libpthread.so.0`, `libdl.so.2`, `libm.so.6`; max `GLIBC_2.17`.
- Bun has **no** static or musl compile target → the binary is ALWAYS glibc-linked.
  `libdl.so.2` (dlopen) is required by the Bun runtime itself; it cannot be dropped.
- **Real constraint (document in step 7): "Linux glibc image with `sh`+`head`"**
  (UBI9/Debian/RHEL/Amazon Linux OK; Alpine/busybox = musl → NO).

### Fixes in working tree — VALIDATED (typecheck+lint clean; 519 pass/0 fail/1 skip at commit)
1. `pod-binary-build.ts` — `repoRoot()`: in a compiled binary `import.meta.dir` is
   `/$bunfs/root`, so the cache resolved to `/dist/pod-bin` → `EROFS mkdir /dist`
   (real bug found in the user's live run). Fix: if `import.meta.url` contains
   `$bunfs`, walk up from `process.execPath` to the dir owning `package.json`;
   source path unchanged; fallback `process.cwd()`. Compiled probe confirmed
   `podBinCacheDir()` = `<repo>/dist/pod-bin` in BOTH modes. Also confirmed
   `Bun.build` WORKS inside a compiled binary (nested build probe) → cache-miss
   → build is viable at runtime.
2. `pod-binary.ts` — install command now `sh -c "mkdir -p /usr/local/bin &&
   head -c N > … && chmod 755 …"` (busybox/minimal images lack `/usr/local/bin`).
   Test asserts updated in `pod-binary.test.ts` + `pod-runtime.test.ts`.

### `libcMismatchHint` — done + validated (2026-10-15)
- `pod-binary.ts` — `libcMismatchHint(stderr)`: on a `--version` probe failure,
  appends an actionable hint ("appears to lack glibc … use UBI9/Debian/RHEL")
  when stderr matches `error while loading shared libraries` / `cannot open
  shared object file` (case-insensitive; any other failure gets NO hint, so the
  raw exec/loader error stays the primary signal). Tests: 3 unit cases (the real
  busybox error verbatim, each pattern case-insensitively, negatives for
  Exec-format / not-found / empty) + a sequence test asserting the full message
  on a musl `--version` failure. Validated: typecheck + lint clean, 502 pass /
  0 fail / 1 skip.

### Also in this working tree (same commit as the fixes)
1. **`--pod` flag → `run` subcommand** — `main.ts` + `flags.ts` (the parser now
   also accepts `--key=value`). `tentacle run --image <ref>
   [--namespace <ns>] [--resume [uid]] [<name>]`; `<name>` is an optional
   positional pod name (else random). The old `--pod` block is a relocated
   version of this one.
2. **Pod delete-on-exit safety net** — Ctrl+C / SIGTERM / crash calls
   `process.exit` *before* `runtime.dispose()`, so the normal async `deletePod`
   never ran and the pod was orphaned. `k8s/pod-cleanup.ts` (new) spawns a
   **detached, `unref`'d `bun -e` child** that issues one `DELETE /pods/<name>`
   (secrets via env, static script, 5 s client timeout) and self-terminates; it
   never blocks exit and never throws. `KubeClient.deletePodBestEffort` +
   `PodCluster.deletePodBestEffort` + `registerPodCleanup` (registered right after
   `createPod`, so pre-ready failures are covered). Design + as-built:
   `docs/fix/pod-delete-on-exit.md`. Tests: `k8s/test/pod-cleanup.test.ts` + the
   exit-cleanup test in `cli/test/pod-runtime.test.ts`.
3. **Missing-namespace 404 → actionable error** — `podCreateError` in
   `pod-runtime.ts` translates a pod-create 404 (`namespaces "…" not found`,
   JSON-escaped quotes stripped) into "create it … or pass --namespace <existing>";
   any other `KubeApiError` keeps its message. The namespace is deliberately NOT
   auto-created (admin-ish, often not allowed by RBAC). Two tests (404 + 403).
4. **Single-line startup rendering** — the 7-line startup is now ONE line on a
   TTY: `cli/src/status-line.ts` (new, braille spinner repainted in place, cursor
   hidden while active + an `exit` safety net that restores it, `finish()` clears
   the line) drives every phase — create → ready → the injection's own phases
   (probe/resolve/transfer/verify, via `injectAgentBinary`'s `onStatus`) — and
   `cli/src/transfer-progress.ts` (new) renders the `docker pull`-style bar that
   is the transfer phase's text. When piped (log/CI/test) the same phases log one
   discrete line each (the bar one per ~10%), so transcripts stay readable and the
   existing tests hold. The final "ready…starting the daemon" line is logged only
   when piped (the TUI opening is the confirmation on a TTY). The resolver's
   verbose cache/build path is dropped on a TTY (the phase line is enough).
   Phase strings were trimmed (arch probe folded into "resolving <target>",
   `verifying…`, `injecting tentacle <bar>`). Tests: `cli/test/status-line.test.ts`
   (new) + an `onStatus` sequence test in `pod-binary.test.ts`.

### Git state + next actions
- Tip before this commit: `5357d1e` (this checkpoint doc). The working tree
  carried 20 changed files (14 modified + 6 new): the 4 fix files
  (`pod-binary-build.ts`, `pod-binary.ts`, `pod-binary.test.ts`,
  `pod-runtime.test.ts`), the step 7 docs (`packages/cli/src/main.ts`,
  `packages/k8s/src/pod.ts`, `TODO.md`, `docs/F4-pod-execution.md`), and — from the
  items above — `flags.ts`, `pod-runtime.ts`, `k8s/src/client.ts`,
  `k8s/src/index.ts`, `k8s/src/kube-auth.ts`, plus the new `pod-cleanup.ts`,
  `pod-cleanup.test.ts`, `status-line.ts`, `transfer-progress.ts`,
  `status-line.test.ts`, and `docs/fix/pod-delete-on-exit.md`. `dist/` is git-IGNORED
  (`dist/Dockerfile`'s marker is local-only, not committable). All committed
  together (single commit — see the commit message).
- DONE in this commit: 1) the glibc fixes + `libcMismatchHint` (+tests), 2) the
  `run` subcommand + delete-on-exit + missing-namespace error, 4) docs/TODO,
  plus the single-line rendering + its tests. Remaining: 3) step 6 negative case
  (`TENTACLE_POD_BIN=$PWD/dist/tentacle`, the macOS Mach-O binary → expect a
  clear `--version failed … Exec format error`, pod deleted), and 5) merge to
  `main`, delete `feat/pod-daemon-healthcheck`.

