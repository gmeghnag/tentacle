# Pod binary injection — architecture & plan

**Status:** planned (branch `feat/pod-binary-injection`, created from `main` @ `583e121`, empty working tree).
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

1. **`--version`** in `main.ts` (+ `define` in `scripts/build.ts`, HELP line, test in
   `main.test.ts`). Small, independent, unblocks the probe.
2. **`runExec`** in `@agent-harness/k8s` (`exec-run.ts` + `client.ts` + `index.ts` + tests
   with `FakeWS`-style fake: status→resolve, stdout/stderr collection, timeout reject,
   input chunking on channel 0, close-without-status reject).
3. **`PodCluster.runExec`** + **`injectAgentBinary`** (`pod-binary.ts`) with tests: a fake
   cluster records calls; assert sequence (uname → head -c N with bytes → --version),
   arch mapping, uname-failure fallback to x64, `head` failure → throw with stderr,
   `--version` failure → throw with stderr. Extend the existing `FakeCluster` in
   `pod-runtime.test.ts` with a `runExec`.
4. **`resolveBinary`** (`pod-binary-build.ts`): `HARNESS_POD_BIN` path, cache, `Bun.build`
   with shared options from refactored `scripts/build.ts`; test the `HARNESS_POD_BIN` and
   cache-hit paths (skip the real build in unit tests — it's slow; the build path is
   covered manually/live).
5. **Wire into `startPodRuntime`** + log lines matching the existing `[pod]` style.
6. **Live validation** (the real test, against kind):
   - build `TARGET=bun-linux-x64` (or via `HARNESS_POD_BIN` pointing at a prebuilt one),
   - run `./dist/agent-harness --pod --namespace test00 --image <busybox-or-ubi-without-tool>`
     (any linux image that has `sh`; `busybox` has `sh` + `head`),
   - expect: log lines for probe/transfer/progress/version, then the TUI opens and a turn
     works end-to-end (model via reverse tunnel).
   - Also verify the negative path: point `HARNESS_POD_BIN` at the macOS binary → expect a
     clear `[pod …] agent-harness --version failed: … Exec format error`-style message,
     pod deleted, no opaque "connection closed".
7. **Docs/TODO** (see 3.4).

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

## 7. Open questions (decide while coding, don't block)

- Cache invalidation: v1 = existence + `HARNESS_POD_BIN` override only (no mtime magic).
- `onProgress` log granularity: every ~10% (60 MB → ~7 lines).
- Should `runExec` also be used to `chmod` in a second exec instead of the `sh -c` one-liner?
  (One `sh -c` is simpler; keep it unless tests show a problem.)
- Default install path: `/usr/local/bin` vs `/usr/bin` — `/usr/local/bin` (conventional, and
  first in most PATHs; if the image has its own `agent-harness` in `/usr/bin`, PATH order
  decides — acceptable, note it).
