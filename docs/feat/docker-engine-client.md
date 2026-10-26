# feat/docker-engine-client — `packages/docker`: a self-contained Docker/Podman Engine API client (docker-runtime slice A)

> **Status:** done
> **Branch:** `feat/docker-engine-client`
> **Type:** feat · **Size:** M (upper end: 9 src + 8 test files, all in one new package) · **Blast:** contained (new leaf package, no caller until slice B; no protocol / persistence / terminal-IO / §7-invariant change) · **Suited:** Opus 5.5 executes (hand-written HTTP framing is subtle even if contained); standard Review, fresh-context preferred but not mandatory.

## Context

*— claude-opus-5-5, 2026-10-26*

**Why.** `docs/eval/docker-runtime.md` (owner-approved build, queue item 4 in
`TODO.md:1011-1013`) makes `run`/`attach` work on a Docker or Podman engine,
local or remote, as a second implementation of the existing `PodCluster` seam
(`packages/cli/src/pod-runtime.ts:140-150`). Slice A is the bottom of that
stack: a new leaf package `@tentacle/docker` that speaks the Engine API with
no `docker` CLI (same rule as k8s, `docs/architecture/F4-pod-execution.md:26`),
and exposes the two things the runtime needs — an exec as a `DuplexChannel`
and a one-shot exec that resolves on exit — plus the container REST verbs.
Nothing calls it yet; slice B (`feat/sandbox-host-seam`, load-bearing) wires
it, slice C adds the CLI.

**Evidence the design rests on (eval probes, 2026-10-26, Docker Desktop 29.1.3, API 1.52, Bun 1.4.3):**
- Exec start is an HTTP/1.1 hijack (`Upgrade: tcp` → `101 UPGRADED`), stdout/stderr
  multiplexed with the 8-byte header `[stream,0,0,0,size32be]` when `Tty:false`
  (eval :81-94).
- `fetch` + streaming body is **rejected** (the start JSON leaks into the
  process's stdin, eval :96-100); `Bun.connect` + a hand-written request is a true
  duplex and **half-close works over the unix socket** (`socket.shutdown()` →
  stdin EOF → exit 0, real numeric exit code from `GET /exec/{id}/json`, eval :101-107).
- `/containers/{id}/attach/ws` is **rejected** (stdin never delivered in 4
  variants, PID 1 only, frames land in `docker logs`; eval :114-142).
- The full chain works: inject 89 MB → `--version` → `serve --stdio` answers a
  real `initialize` (protocol 11) over the hijacked exec; exec stdio is not
  logged (eval :173-192).

**Owner answers that change the eval's sketch (eval :357-379):**
1. **`ssh://` is IN v1** (Q3 reversed): `ssh <host> docker system dial-stdio`,
   the SAME hand-written HTTP over the child's stdio. → This plan writes HTTP /
   hijack / exec over an abstract **`ByteDuplex`** so unix, TCP(+TLS) and
   ssh-stdio are three *dialers* of one code path. **The ssh dialer itself is a
   separate small slice A2** (see Design §9 and Review notes) — A ships the
   seam, the `ssh://` endpoint parsing, and a test that proves the client only
   ever sees a `Dialer`.
2. **Plaintext `tcp://` refused by default** → resolver option
   `allowInsecureTcp` (the `--insecure-docker-tcp` flag is slice C).
3. **Podman supported** → the opt-in live test runs per docker context
   (`podman` is one); it starts nothing itself.
4. **musl** → detect + clear message on Docker AND k8s. That detection lives
   in the backend-neutral injector (`packages/cli/src/pod-binary.ts`), NOT here
   — see "Not in this slice".

**Eval's four unproven points — what this slice proves and how:**

| Point | Proven here? | How |
|---|---|---|
| Half-close over TCP | **Yes, client side** (the side we own) | hermetic: our TCP dialer → `Bun.listen` loopback server; `end()` ⇒ server gets `end` and can still write; client still receives. Engine side: optional live run with `TENTACLE_DOCKER_TCP_HOST`. |
| TLS via `Bun.connect` | **Yes, hermetic** | fixture CA/server/client certs (checked in, like `packages/client/test/fixtures/`, `tls-trust.test.ts:24-29`): trusted → connects; unknown CA → actionable error; wrong hostname → actionable error; mTLS client cert presented (`TLSOptions.requestCert`, `bun.d.ts:2737`). Live remote TLS daemon: optional env. |
| Podman live | **Yes, opt-in** | `TENTACLE_DOCKER_CONTEXTS=desktop-linux,podman` after `podman machine start` (manual; the test starts nothing). |
| `PUT /archive` on read-only rootfs | **No — dropped by decision** | Slice A does not build `PUT /archive` (injection keeps exec, eval :316-317; nothing calls archive). Instead the live test proves the path we DO use on a hardened container: exec-injection into `ReadonlyRootfs:true` + a `Tmpfs` `/tmp` mounted `exec` (and prints, not asserts, whether Docker's default tmpfs is `noexec` — input for slice C's `--bin-dir` guidance). |

**Repro (capability missing), 2026-10-26, on `main` @ `7961bcc`:**
```
$ ls packages
agent cli client config core daemon exec k8s mcp protocol providers tools transport tui
$ rg -il docker packages/*/src     # only incidental mentions (syntax highlight, build comments)
packages/tui/src/read-highlight.ts
packages/cli/src/transfer-progress.ts
packages/cli/src/pod-binary-build.ts
packages/agent/src/shell-prefix.ts
```
No Engine API client exists. The probes that *do* exercise one are the eval's
(`.tentacle/tmp/docker-runtime/p3-exec-duplex.ts`, `p6-e2e.ts`; output pasted
in the eval :85-94, :173-189).

## Implementation

*— claude-opus-5-5, 2026-10-26*

### Load-bearing assumption

**A Docker/Podman exec can be driven as a true duplex over ONE hand-written
HTTP/1.1 connection carried by ANY byte stream**: write the request head +
`Content-Length` body, read a `101` head, then raw stdin out / 8-byte-framed
stdout+stderr in, and a write-side half-close = the process's stdin EOF.

- Proven on the unix socket end-to-end: eval :101-107 (P3-B), :180-181 (P6:
  `initialize` answered, `after stdin half-close: daemon Running=false ExitCode=0`).
- Proven over plain TCP for the 101 + frames: eval :108-110 (P8).
- Byte-stream-agnostic by construction: the engine sees only bytes on a
  connection; `docker system dial-stdio` is literally "this HTTP connection over
  ssh's stdio" (eval :153-158).
- **Not yet proven:** half-close over TCP and TLS from Bun → proven in this
  slice (hermetic, Tests T4). If Bun's `shutdown()` over TLS turned out to send
  a full close, the exec channel still works (close ⇒ engine closes stdin); only
  `runExec`-with-input would need the k8s `head -c N` command shape, which
  `injectAgentBinary` already uses (`pod-binary.ts:173-177`) — so the slice
  degrades, it does not fall. Executor: run T4 FIRST.

### Preconditions

- **`DuplexChannel` contract** (`packages/transport/src/channel.ts:9-18`):
  `send` is a no-op once closed; `close` is idempotent and fires `onClose`;
  one `onMessage` / one `onClose` handler (set replaces). The k8s channel fires
  `onClose` synchronously inside `close()` (`packages/k8s/src/exec-channel.ts:134-145`, :227-234) — mirror it.
- **`openExec` is synchronous** — `PodCluster.openExec(...): DuplexChannel`
  (`pod-runtime.ts:148`), called sync at :392, :630 and inside
  `execChannelFactory` (:280); the runtime sends `initialize` in the same turn.
  So the Docker channel must return immediately and **queue outbound frames
  until the 101** (k8s does the same until WS `open`, `exec-channel.ts:106-132`).
  Exec create (`POST /containers/{id}/exec`) and start (hijack) happen inside.
- **Frames are single-line JSON, newline-delimited; blank lines are dropped by
  the daemon** (`packages/transport/src/stream-channel.ts:7-11`, :50) → `${json}\n`
  out, re-chunk on `\n` in, and a blank stdin line is a safe keepalive (k8s
  relies on the same, `exec-channel.ts:84-85`).
- **`runExec` result shape** the injector consumes: `{ exitCode: number|null,
  stdout, stderr, status? }` and options `{ timeoutMs?, signal?, onProgress? }`
  (`packages/k8s/src/exec-run.ts:42-70`; used by `pod-binary.ts:179-216`).
  Docker returns a real numeric code (eval :106-107) — same shape, richer value.
- **Only `onStderr` is wired by the runtime** for exec channels
  (`pod-runtime.ts:390`, :628; it is the buffered sink, :103-136) → setup errors
  of an async-opened channel must be reported through `onStderr`, never thrown
  or written to the terminal (AGENTS §7 "never write raw").
- **Package shape to mirror** (`packages/k8s`): `package.json` with `exports
  ".": "./src/index.ts"` and `workspace:*` deps (`packages/k8s/package.json:1-14`);
  `tsconfig.json` extending the base (`packages/k8s/tsconfig.json:1-5`);
  `index.ts` re-exports (`packages/k8s/src/index.ts:1-14`); pure framing in its
  own module (`exec-frame.ts`), channel/run/client split
  (`exec-channel.ts`/`exec-run.ts`/`client.ts`); injectable I/O on the client
  (`client.ts:35-53`: `fetch`, `makeWebSocket`); opt-in live test gated by env
  with `test.skipIf` (`test/integration.live.test.ts:25-31`).
- **Root wiring:** `tsc` resolves workspace packages through root `paths`
  (`tsconfig.json:11-26`); `include` globs already cover `packages/*/src|test`
  (:28-34); Biome checks all non-ignored files (`biome.json:28`); workspaces are
  `packages/*` (`package.json:7`) → `bun install` adds a `bun.lock` entry
  (k8s's is `bun.lock:123-130`).
- **Bun typings lag the runtime:** `@types/bun` 1.1.14 (`package.json:28`) →
  `bun-types` 1.1.37 declares `TCPSocketConnectOptions.tls?: boolean`
  (`bun.d.ts:4721-4728`) while Bun ≥1.4.3 accepts `TLSOptions` there →
  one localized cast at the `Bun.connect` call (precedent: the `WebSocket` cast
  in `packages/client/src/ws-channel.ts:127`). `socket.write` returns the bytes
  written (`bun.d.ts:4295`, partial writes possible ⇒ queue + `drain`),
  `shutdown(halfClose?)` (:4355), `terminate()` (:4346), `setKeepAlive` (:4596),
  handlers `drain/end/close/error/connectError/handshake` (:4641-4680).
- **API versions:** Docker 29.1.3 reports API 1.52, min 1.44 (eval :58-59);
  Podman's compat API serves `/v1.x/…` (eval :160-161). → negotiate from
  `GET /_ping`'s `Api-Version` header (unversioned path), like the docker CLI.

### Design

New package `packages/docker` (`@tentacle/docker`), dependency
`@tentacle/transport` only (for the `DuplexChannel` type). No import from
`@tentacle/k8s` (slice B unifies types; structural typing keeps B trivial).

**1. `engine-endpoint.ts` — pure endpoint resolution.**
`resolveEngineEndpoint(input) → EngineEndpoint` with
`input = { env, context?: string, allowInsecureTcp?: boolean, configDir?: string, readFile: (p) => string | undefined }`
(fs injected → pure + testable). Precedence mirrors the docker CLI:
`context` arg (`--context`, slice C) > `DOCKER_HOST` > `DOCKER_CONTEXT` >
`currentContext` in `<configDir>/config.json` > `default`. `configDir` =
`DOCKER_CONFIG` ?? `~/.docker`. A named context reads
`<configDir>/contexts/meta/<sha256hex(name)>/meta.json` →
`Endpoints.docker.{Host,SkipTLSVerify}`, TLS material from
`<configDir>/contexts/tls/<sha256hex(name)>/docker/{ca,cert,key}.pem` (eval :162-166, verified hash).
`default` context = `DOCKER_HOST` or `unix:///var/run/docker.sock`.
`DOCKER_HOST=tcp://…` is TLS iff `DOCKER_TLS_VERIFY` is non-empty (CLI rule),
material from `DOCKER_CERT_PATH` ?? `configDir`.

```ts
type EngineEndpoint =
  | { kind: "unix"; path: string; local: true; source: string }
  | { kind: "tcp"; host: string; port: number; tls?: { ca?: string; cert?: string; key?: string }; insecure?: true; local: false; source: string }
  | { kind: "ssh"; host: string; user?: string; port?: number; local: false; source: string };
```
`source` = human label for errors (`context "podman"`, `DOCKER_HOST`).
`local` feeds slice C's bind-mount default (only `unix` is local — conservative).
Rules / errors (each an actionable `Error`):
- `tcp://` without TLS, **or** TLS with `SkipTLSVerify` (server not
  authenticated = same risk) → refused unless `allowInsecureTcp`:
  *"refusing plaintext tcp://h:2375 (DOCKER_HOST): an unauthenticated Docker API
  is root on that server. Use TLS (tcp://h:2376 + DOCKER_TLS_VERIFY=1 and
  DOCKER_CERT_PATH with ca.pem/cert.pem/key.pem) or ssh://user@h — or force it
  with --insecure-docker-tcp"*. Loopback is not special-cased (one rule; the
  opt-in covers Desktop's "expose on localhost:2375").
- TLS requested but `ca.pem`/`cert.pem`/`key.pem` missing → names the dir.
- `ssh://[user@]host[:port]` parsed; host/user starting with `-` or containing
  whitespace/control chars → refused (argv-injection guard for A2's `ssh … -- host`).
  A path in the ssh URL (`ssh://h/x`) → refused (the CLI ignores it; be explicit).
- Unknown context name → *"docker context "x" not found (looked in <dir>); `docker context ls`"*.
- `npipe://`, `fd://`, `http(s)://`, anything else → "unsupported Docker host scheme".
- Default ports: tcp 2375 plain / 2376 TLS; ssh none (ssh's own config decides).

**2. `byte-duplex.ts` — the transport seam + socket dialers.**
```ts
interface ByteDuplex {
  write(bytes: Uint8Array): void;      // never partial from the caller's view: the dialer queues the rest
  readonly buffered: number;           // queued-not-yet-in-kernel bytes (backpressure)
  setOnData(fn: (b: Uint8Array) => void): void;   // bytes arriving before a handler is set are held, then flushed
  setOnDrain(fn: () => void): void;
  setOnEnd(fn: (error?: Error) => void): void;    // peer finished (FIN) or the link failed; fires once
  end(): void;                         // write-side half-close (FIN), reading continues
  close(): void;                       // both directions, idempotent; fires onEnd once if not yet fired
}
type Dialer = (signal?: AbortSignal) => Promise<ByteDuplex>;
```
`socketDialer(ep: unix|tcp endpoint, opts?: { connectTimeoutMs?, keepAliveMs? })`
over `Bun.connect` (`{unix}` or `{hostname,port,tls:{ca,cert,key,serverName}}`):
partial `write` → pending queue flushed on `drain`; `end()` = `socket.shutdown()`
(what P3-B used); `close()` = `socket.end()` (or `terminate()` if already
failed); `setKeepAlive(true, keepAliveMs)` on TCP when present; connect timeout
by our own timer (default 10 s). Dial failures go through a pure
`dialError(ep, error)` translator (codes → messages, see Failure modes).
**The ssh dialer (A2) implements this same interface** over `Bun.spawn` stdio:
`write` → `stdin.write`, `buffered` = unflushed bytes (await `stdin.flush()` as
drain), `end()` → `stdin.end()`, `close()` → kill the process group, `onEnd`
error carries the captured stderr. The interface is shaped so that fits
(no socket-only member).

**3. `http.ts` — pure HTTP/1.1 framing (no I/O).**
- `buildRequest({ method, path, headers, body? }) → Uint8Array`:
  `Host: docker` (what the CLI sends over unix), explicit `Content-Length`
  (0 for no body on POST), `Content-Type: application/json` when body, never
  chunked requests; caller adds `Connection: close` or `Upgrade: tcp` +
  `Connection: Upgrade`.
- `ResponseReader`: incremental — `push(bytes)` until the head (`\r\n\r\n`) is
  complete (cap **64 KiB** → "malformed response head"), parse status line +
  headers (case-insensitive), then body by `Content-Length` **or**
  `Transfer-Encoding: chunked` (Go's `net/http` chunks any non-small response)
  **or** until EOF; returns `{ status, reason, headers, body }` and, for a
  hijack, the **leftover bytes after the head** (stream bytes may arrive in the
  same TCP segment as the 101 — must not be lost).

**4. `http-conn.ts` — request/hijack over a `Dialer`.**
- `request(dial, req, { signal, timeoutMs }) → HttpResponse`: fresh dial per
  request with `Connection: close` (simple and correct; unix/TLS cost is
  negligible — ssh latency is A2's concern, see Notes).
- `hijack(dial, req) → { duplex, leftover }`: sends the request with
  `Upgrade: tcp`; resolves on **`101`**, or on `200` whose `Content-Type` is
  `application/vnd.docker.raw-stream|multiplexed-stream` (engines that answer
  a hijack without an upgrade status); any other status → reads the body and
  throws `DockerApiError(status, message)` (engine JSON `{"message":…}`).

**5. `stdcopy.ts` — pure stdout/stderr demux (the probe's `StdDemux`).**
Incremental state machine over the 8-byte header `[stream,0,0,0,size32be]`:
emits payload **chunks as they arrive** (no whole-frame buffering), `stream`
0|1 → stdout (Docker's stdcopy treats 0 as stdout), 2 → stderr, 3 →
`systemErr` (engine-side error text). Header with bytes 1-3 ≠ 0 or stream > 3 →
`onError("malformed docker stream header …")` and stop. `finish()` reports
whether a frame was cut mid-way (`partial: bytes`).

**6. `exec-channel.ts` — `execChannel(dial, apiPath, target, options): DuplexChannel` (sync).**
Mirrors `packages/k8s/src/exec-channel.ts`: returns at once; frames encoded
`${json}\n` and **queued until the hijack completes**, then flushed in order;
async setup = `POST {v}/containers/{id}/exec` `{AttachStdin,AttachStdout,AttachStderr:true,Tty:false,Cmd,User?,WorkingDir?}`
→ `Id` → `hijack(POST {v}/exec/{Id}/start, {"Detach":false,"Tty":false})`.
Inbound: leftover + data → `StdDemux` → stdout through a streaming
`TextDecoder` (UTF-8 split across frames) → split on `\n`, drop blank lines →
`onMessage`; stderr → `options.onStderr`; systemErr → `onStderr("[docker] …")`.
Setup failure (dial, 404, 409, non-101) → `onStderr("[docker] exec failed: <actionable>\n")`
then close. `close()` = `duplex.end()` (daemon sees stdin EOF, exits 0) then
`duplex.close()`, fires `onClose` synchronously once; `send` after close is a
no-op; peer end / error → `onClose`. **Keepalive:** a blank stdin line every
15 s (injected `IntervalTimers`, same shape/defaults as k8s
`exec-channel.ts:58-82`) to keep NAT/LB idle timers alive; **no "missed"
logic** — a raw byte stream has no ping/pong to prove liveness (k8s also never
closes on silence without a pong, :154); dead links are detected by TCP
keepalive (TCP), process exit (ssh, A2 adds `ServerAliveInterval`), or socket
close (unix).
`ExecChannelOptions = { onStderr?, keepalive? }` (no `onStatus`: Docker has no
status channel).

**7. `exec-run.ts` — `runExec(dial, apiPath, target, input?, options) → RunExecResult` (one-shot).**
Mirrors `packages/k8s/src/exec-run.ts`: same `RunExecResult`/`RunExecOptions`
shape (:42-70), default timeout 30 s, `SEND_HIGH_WATER_BYTES` 4 MiB, 256 KiB
chunks. After the hijack: pump `input` while `duplex.buffered < HIGH_WATER`,
else wait for `onDrain` (event-driven, no polling — better than k8s's 15 ms
poll); `onProgress(bytesWritten)` per chunk; then **`end()` (half-close = the
command's stdin EOF; no `head -c N` needed, though it still works)**. Collect
stdout/stderr; on stream end `GET {v}/exec/{Id}/json` → `ExitCode`; if
`Running` is still true (stream-close vs inspect race) re-poll up to 20×25 ms,
then resolve `exitCode: null` + `status: "exec still running after its stream closed"`.
Rejects on: timeout / abort (closes the duplex), setup failure, malformed
stream, stream cut mid-frame. `status` carries systemErr text when present.

**8. `client.ts` — `DockerClient` (REST verbs + exec entry points).**
`new DockerClient({ dial: Dialer, endpointLabel: string, apiVersion?: string })`
— **the client only ever sees a `Dialer`** (that is what makes unix/TCP/TLS/ssh
one code path; T7 pins it). API negotiation: lazily `GET /_ping` once,
`v = min(Api-Version, MAX_API="1.52")`; `< MIN_API="1.41"` → *"Docker engine API
X is older than tentacle supports (≥ 1.41)"*. Paths are `/v{v}/…`.
Verbs (shaped for slice B's `SandboxHost`, named Docker-ly; B maps them):
`ping()`, `version()`, `pullImage(ref, signal?)` (streamed JSON lines; an
`{"error":…}` line → reject), `createContainer(name, body)` (body is a loose
passthrough `ContainerCreateBody`; the manifest builder is B/C),
`startContainer(id)` (304 = already running → ok), `inspectContainer(id)`,
`removeContainer(id)` (`force=true`; 404 → success, idempotent like
`deletePod`, k8s `client.ts:145-155`), `waitForRunning(id, opts)` (mirrors
`waitForReady`, `client.ts:178-198`: `State.Running` → resolve; `exited|dead` →
reject with `State.ExitCode`/`Error`; timeout/abort),
`openExec(target, options): DuplexChannel`, `runExec(target, input?, options)`.
`DockerExecTarget = { container: string; command: readonly string[]; user?; workingDir? }`.
`DockerApiError(status, message, body)` mirrors `KubeApiError` (`client.ts:25-33`).
**Not here:** best-effort delete / exit net (slice B generalises `pod-cleanup.ts`), container manifest (B/C).

**9. Not in this slice (and where it goes).**
- **ssh dialer → slice A2 `feat/docker-ssh-dialer` (S · contained, only
  `packages/docker/src/ssh-dialer.ts` + test + `bun.lock`).** Spec, so nothing
  is lost: argv `ssh -T -o BatchMode=yes -o ConnectTimeout=10
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 [-l user] [-p port] -- <host>
  docker system dial-stdio` (no secrets in argv; `--` + A's host validation
  stop option injection); spawned **`detached`** (new session ⇒ no controlling
  TTY: a host-key/passphrase prompt can never block — BatchMode makes it fail
  instead) with its own process group, `trackGroup`/`killGroup` from
  `@tentacle/exec` (`packages/exec/src/process-group.ts:96-154`) for close + the
  exit net; env = `scrubSensitiveEnv(process.env)` **plus `SSH_AUTH_SOCK`
  re-added** (the scrub drops it: `/AUTH/` in `packages/core/src/env.ts:11-12`);
  stderr piped and captured (cap 8 KiB), never inherited (precedent
  `packages/mcp/src/transport.ts:28-38`, :92-115), classified on early exit:
  spawn ENOENT → "ssh not found on PATH"; "Host key verification failed" →
  "verify the host key once with `ssh <host>`"; "Permission denied" → "load a
  key in ssh-agent / IdentityFile (batch mode: no password prompts)"; exit 127
  / "docker: command not found" → "ssh contexts need the docker CLI on the
  server"; resolve/refused/timeout → network message. Hermetic test: a fake
  `ssh` (a bun script on a temp PATH that bridges stdio to a `Bun.listen` unix
  fake engine) + a fake spawner seam (like `PodDeleteSpawner`,
  `packages/k8s/src/pod-cleanup.ts:155`); live: `TENTACLE_DOCKER_SSH_HOST`.
  **Why split:** A is already at the top of M; ssh adds a process lifecycle,
  stderr classification and its own live setup — independent of everything in
  A except the `ByteDuplex` interface, which A freezes.
- **musl detection → its own `fix/musl-image-detect` (S · contained,
  `packages/cli/src/pod-binary.ts` + `packages/cli/test/pod-binary.test.ts`),
  not slice A and not B.** It belongs in the backend-neutral injector
  (`injectAgentBinary`/`probePodArch`, `pod-binary.ts:61-76`, :132-216, written
  only against `runExec`), so k8s gets it now and Docker gets it for free in B.
  It is a live **bug** today: the glibc binary on Alpine fails with `exec …: no
  such file or directory` (exit 255, eval :188), which `libcMismatchHint`'s
  regex (`pod-binary.ts:113-117`) does not match → a cryptic error on k8s.
  Shape for that task: a pre-transfer probe (e.g. argv `ls /lib/ld-musl-*` —
  no `sh` needed) → fail before sending ~90 MB with *"this image uses musl
  (Alpine): use a glibc-based image"*. **The stale comment at
  `pod-binary.ts:106-108`** ("Bun has no static or musl build") is a 2-line
  docblock fix, but it is the very docblock that fix rewrites, and touching
  `packages/cli` here would break this slice's "only `packages/docker` + root
  files" footprint → **moved to `fix/musl-image-detect`** (owner may override:
  it is trivially doable here too).
- `PUT /archive`, exit net / `__cleanup`, container manifest, `SandboxHost`
  rename → B; flags, bind-mount, docs → C.

### Files

All new unless marked. Dependency order.

`packages/docker/` (new package):
1. `package.json` — `@tentacle/docker`, `exports "." → ./src/index.ts`, deps `@tentacle/transport: workspace:*`.
2. `tsconfig.json` — copy of `packages/k8s/tsconfig.json`.
3. `src/types.ts` — `ContainerInspect`, `ExecInspect`, `ContainerCreateBody` (loose), `DockerExecTarget`, `RunExecResult`, `RunExecOptions`, `ExecChannelOptions`.
4. `src/engine-endpoint.ts` — Design §1.
5. `src/byte-duplex.ts` — `ByteDuplex`, `Dialer`, `socketDialer`, `dialError` (Design §2).
6. `src/http.ts` — pure framing (§3).
7. `src/http-conn.ts` — `request`, `hijack` (§4).
8. `src/stdcopy.ts` — pure demux (§5).
9. `src/exec-channel.ts` — §6.
10. `src/exec-run.ts` — §7.
11. `src/client.ts` — `DockerClient`, `DockerApiError` (§8).
12. `src/index.ts` — re-exports.
13. `test/fake-duplex.ts` — shared `FakeDuplex` + `scriptedDialer` (not a `*.test.ts`, so not discovered).
14. `test/fixtures/{ca.pem,server.pem,server-key.pem,client.pem,client-key.pem,other-ca.pem}` — test-only, long-lived, SAN `IP:127.0.0.1,DNS:localhost`; the `openssl` commands that made them go in the header comment of `byte-duplex.test.ts` (hermetic at test time, like `packages/client/test/tls-trust.test.ts:24-29`).
15. `test/engine-endpoint.test.ts`, `test/http.test.ts`, `test/stdcopy.test.ts`, `test/byte-duplex.test.ts`, `test/exec-channel.test.ts`, `test/exec-run.test.ts`, `test/client.test.ts`, `test/integration.live.test.ts`.

**Outside `packages/docker/` (the overlap list for the orchestrator):**
- `tsconfig.json` — one line: `"@tentacle/docker": ["packages/docker/src/index.ts"]` in `paths` (:11-26).
- `bun.lock` — the `packages/docker` workspace entry (generated by `bun install`; do not hand-edit).
- `AGENTS.md` — §6 two fact lines: **"14 packages" → 15** (add `docker`, :92) and the baseline's **opt-in skips: two → three** (add `TENTACLE_DOCKER_TESTS=1`) — otherwise §6 is stale the moment this merges. (Rides this branch: a fact update bundled with code, not a rule change, §10 carve-out (b).)
- `docs/feat/docker-engine-client.md` — this task doc (rides the branch).
- *Not touched:* `packages/cli/**` (incl. `pod-binary.ts` — see §9), `TODO.md` (orchestrator, on `main`), `README.md`/`ARCHITECTURE.md` (no package list there; F4/AGENTS §7 wording is slice C).

Overlap with `feat/context-reset-refresh` (config/agent/wiring/tools): none in
`packages/`; the only plausible shared files are `AGENTS.md` (if that task also
edits §6) and `bun.lock` (only if it adds a dependency) — both trivially
re-mergeable (regenerate `bun.lock` with `bun install`).

### Failure modes

Every row ends in an actionable `Error` (rejection for verbs/`runExec`; an
`onStderr` line + `onClose` for the async channel) — never a hang, never a
silent drop. Messages name the endpoint `source` (context/`DOCKER_HOST`).

| Failure | Where detected | Outcome / convergence |
|---|---|---|
| Engine not running — unix socket **missing** (ENOENT) | `dialError` | *"Docker engine socket not found at <p> (context X) — is Docker Desktop running / `podman machine start`?"* |
| Socket exists, **nobody listening** (ECONNREFUSED — Podman machine stopped, eval :76) | `dialError` | *"nothing is listening on <p> — the engine is not running"* (+ podman hint when the path contains `podman`). |
| **Permission denied** on the socket (EACCES) | `dialError` | *"permission denied on <p> — on Linux add your user to the `docker` group (root-equivalent) or use rootless Docker/Podman"*. |
| TCP refused / timeout / DNS | `dialError`, connect timer | host:port + cause; connect timeout 10 s, never hangs. |
| **TLS cert errors** (unknown CA, hostname mismatch, expired, server demands a client cert) | `handshake`/`error` → `dialError` | *"TLS verification of h:2376 failed (<code>): check ca.pem in <dir> / the context's TLS material"*; handshake failure with no cert → mention cert.pem/key.pem. Never falls back to unverified. |
| Plaintext tcp / SkipTLSVerify | resolver | refused unless `allowInsecureTcp` (Design §1). |
| **API version mismatch** | `_ping` negotiation; engine 400 "client version … is too old" | engine older than 1.41 → "upgrade the engine"; engine minimum above 1.52 → "this engine needs a newer tentacle". Negotiated once per client. |
| Container missing (404) / **exec on a stopped container** (409 "is not running") | exec create | `DockerApiError` → *"container X is not running (state: exited) — start it or use `run`"*; channel: `onStderr` + close; `runExec`: reject. |
| **Hijack not 101** (and not a stream-typed 200) | `hijack` | body read → `DockerApiError(status, engine message)`; the duplex is closed. |
| Response head > 64 KiB / not HTTP | `ResponseReader` | "malformed response from the engine" — reject, close. |
| **Short / garbled frame header** | `StdDemux` | channel: `onStderr("[docker] malformed stream …")` + close (the RPC client's drop path takes over); `runExec`: reject. |
| **Peer close mid-frame** | `StdDemux.finish()` on `onEnd` | channel: partial trailing line dropped (as `streamChannel`), `onClose`; `runExec`: reject "stream ended mid-frame" (truncated output is not trustworthy). |
| Peer close **mid-line** (frame complete, no `\n`) | line splitter | channel: dropped + `onClose` (identical to `streamChannel`/`ExecDemux`). |
| **stdin backpressure** (89 MB injection) | `buffered` + `onDrain` | pump pauses at 4 MiB, resumes on drain; memory bounded; `onProgress` tracks the kernel, not the buffer. Partial `socket.write` is the dialer's job (queue + `drain`). |
| Send while the hijack is pending / after close | channel | queued then flushed in order / no-op (contract). |
| `close()` during setup (before 101) | channel | setup aborted (`AbortSignal` into dial/request), late 101 → duplex closed immediately; `onClose` fired once. |
| Timeout / abort in `runExec` | timer / signal | duplex closed, reject. The process inside may keep running (no exec-kill API) — same as k8s; documented. |
| Exit code race (stream closed, inspect still `Running`) | `runExec` | bounded re-poll, then `exitCode: null` + status (callers already treat `!== 0` as failure, `pod-binary.ts:190`). |
| Engine `systemErr` stream (3) | `StdDemux` | `runExec.status` + `onStderr`. |
| Pull error line / unknown image | `pullImage` / create 404 "No such image" | reject with the engine message + "pull it or check the name". |
| ssh missing / auth failure / host-key prompt | **A2** | specified in Design §9; A only guarantees the interface + host validation. |

### Tests

Not a fix → no red-before-green for a regression, but **each test must be shown
red by mutation** (§9): for every test file the executor breaks the property
once (listed per item) and records the failure in Execution.

Fakes (AGENTS §9 — match the existing ones): `FakeDuplex` mirrors k8s
`FakeWS` (`packages/k8s/test/exec-channel.test.ts:21-75`): records `written`
chunks, `ended`/`closed` flags, settable `buffered`, and driver methods
`receive(bytes)`, `peerEnd(error?)`, `drain()`. `scriptedDialer([...])` hands
out one `FakeDuplex` per dial **in order** and records dials, so a test plays
the engine: read the request bytes, assert method/path/headers/body, reply
with raw response bytes. Timers via the injected `IntervalTimers`
(k8s `manualTimers`, `exec-channel.test.ts:77+`); no real sleeps.

- **T1 `engine-endpoint.test.ts`** — precedence (`--context` > `DOCKER_HOST` >
  `DOCKER_CONTEXT` > config `currentContext` > default); meta path =
  `sha256("podman")` = `2f259bab…` (eval :164); context TLS files; `DOCKER_CONFIG`;
  `DOCKER_TLS_VERIFY`/`DOCKER_CERT_PATH`; plaintext tcp refused (message names
  TLS :2376, ssh://, `--insecure-docker-tcp`) and allowed with
  `allowInsecureTcp`; SkipTLSVerify refused likewise; `ssh://u@h:2222` parsed;
  `ssh://-oProxyCommand=x` / `ssh://u@h/path` refused; unknown context; npipe
  unsupported; `local` only for unix. *Mutation: drop the TLS check → the
  plaintext test fails.*
- **T2 `http.test.ts`** — request bytes exact (Content-Length, Host); head split
  across N pushes byte-by-byte; chunked body incl. chunk extensions and a split
  `\r\n`; Content-Length body; EOF-delimited body; 101 with leftover stream bytes
  in the same push preserved; head > 64 KiB → error; garbage status line → error.
  *Mutation: drop leftover → the leftover test fails.*
- **T3 `stdcopy.test.ts`** — header split at every offset 0..8; payload split;
  stream 0/1/2/3 routing; zero-length frame; size up to 2^31; bytes 1-3 ≠ 0 →
  error; stream 4 → error; `finish()` partial detection; a UTF-8 char split
  across two frames decodes once (via the channel's decoder).
- **T4 `byte-duplex.test.ts` (hermetic real sockets, `Bun.listen` on loopback
  and on a unix path in a short `mkdtemp` dir — macOS 104-byte limit)** — the
  eval's unproven points: (a) **half-close over TCP**: client `end()` → server
  `end` fires → server writes back → client receives → server closes → client
  `onEnd`; (b) same over **unix**; (c) **TLS**: fixture CA trusted → round-trip
  + half-close over TLS; `other-ca` → actionable TLS error; `serverName`
  mismatch → actionable error; server with `requestCert` sees the client cert;
  (d) partial writes: a 32 MiB write with a slow-reading server → all bytes
  arrive in order, `buffered` > 0 then 0, `onDrain` fired; (e) dial errors:
  missing path → ENOENT message; unix path with no listener → refused message;
  `chmod 000` socket → EACCES message; closed TCP port → refused; connect
  timeout (unroutable or a listener that never accepts → injected small timeout).
  *Mutation: make `end()` call `socket.end()` → (a) fails (server sees close,
  cannot reply).*
- **T5 `exec-channel.test.ts`** (scripted dialer) — returns synchronously;
  frames sent before 101 are queued and flushed in order after it (the k8s
  CONNECTING regression, mirrored); exec-create body exactly
  `{AttachStdin,AttachStdout,AttachStderr:true,Tty:false,Cmd}`; start is a hijack
  with `Upgrade: tcp`; stdout frames re-chunked on `\n`, blank lines dropped;
  stderr → `onStderr`; 409 on create → `onStderr` names "not running" + `onClose`,
  nothing thrown; non-101 start → same; garbled header → `onStderr` + close;
  peer end → `onClose` once; `close()` → `ended` then `closed`, `onClose`
  sync once, later `send` no-op; `close()` before 101 → no write after it;
  keepalive tick writes exactly `\n`. *Mutation: send before 101 → queue test
  fails.*
- **T6 `exec-run.test.ts`** — exit code from exec inspect (7 → 7, not 0/1);
  input chunked ≤ 256 KiB, pauses while `buffered ≥ 4 MiB`, resumes on `drain`,
  `onProgress` monotonic to N; `end()` called exactly once after the last
  chunk; Running-race re-poll then `null`; timeout / abort → reject + closed;
  mid-frame end → reject; systemErr → `status`. *Mutation: never call `end()`
  → the run never resolves (timeout).*
- **T7 `client.test.ts`** — `_ping` negotiation (1.52 → `/v1.52`, 1.41 →
  `/v1.41`, 1.40 → error; 1.60 → `/v1.52`); one `_ping` per client; 404 delete
  → success; 304 start → ok; `waitForRunning` (running / exited → reject with
  code / timeout); `pullImage` error line → reject; `DockerApiError` carries the
  engine `message`; **one-code-path property:** the same `DockerClient` test
  body run with two scripted dialers labelled "unix" and "ssh-stdio" produces
  byte-identical requests (the client has no transport branch).
- **T8 `integration.live.test.ts`** — gate `TENTACLE_DOCKER_TESTS=1`
  (`test.skipIf`, like `packages/k8s/test/integration.live.test.ts:25-31`).
  Endpoints: each context in `TENTACLE_DOCKER_CONTEXTS` (default: the current
  context), plus `TENTACLE_DOCKER_TCP_HOST` (+ the usual TLS env) if set.
  Image `TENTACLE_DOCKER_IMAGE` ?? `busybox:latest` (pulled via `pullImage`).
  Every container labelled `tentacle.test=docker-live`, removed in `finally`.
  Per endpoint: ping/version; create `sleep 300` → start → `waitForRunning`;
  `openExec(["cat"])` with 2 frames sent before 101 → both echoed; `close()` →
  exec inspect `Running=false, ExitCode=0` (half-close ends `cat`); `runExec`
  8 MiB into `sh -c 'cat > /tmp/b; wc -c < /tmp/b'` → `8388608`, exit 0;
  `sh -c 'echo e >&2; exit 7'` → 7 + stderr; stop the container → `runExec` →
  actionable "not running"; **read-only rootfs**: create with
  `HostConfig.ReadonlyRootfs:true, Tmpfs:{"/tmp":"rw,exec"}` → writing
  `/usr/local/bin/x` fails (non-zero, "Read-only"), writing+executing
  `/tmp/x` works; print (not assert) whether a default `Tmpfs:{"/tmp":""}`
  allows exec. How to run (header comment):
  ```
  TENTACLE_DOCKER_TESTS=1 bun test packages/docker/test/integration.live.test.ts
  podman machine start      # Podman is stopped by default; the test starts nothing
  TENTACLE_DOCKER_TESTS=1 TENTACLE_DOCKER_CONTEXTS=desktop-linux,podman \
    bun test packages/docker/test/integration.live.test.ts
  podman machine stop
  ```
  The executor runs both (Docker Desktop + Podman, owner answer 4) and pastes
  the output in Execution; afterwards `docker ps -a --filter
  label=tentacle.test=docker-live` must be empty.

Gate before done (§4): `bun test` (new opt-in skip = the docker live test;
everything else as baseline), `bun run typecheck`, `bun run lint` (baseline 0/0).

## Execution

*— claude-opus-5-5, 2026-10-26*

**Baseline (worktree @ `7961bcc`, before any edit):** `bun run check` →
typecheck ok, `biome check .` 483 files clean, `bun test` **2851 pass / 2 skip
/ 0 fail** (2853 tests, 220 files). Repro (capability missing): `ls packages`
had no `docker`; nothing to import.

**As built (plan order; T4 first as the plan asked):**
1. `packages/docker/{package.json,tsconfig.json}` (k8s copies), root
   `tsconfig.json` one `paths` line, `bun install` → `bun.lock` gets only the
   `packages/docker` workspace entry + its `@tentacle/docker` alias (9 lines).
2. `src/types.ts`, `src/engine-endpoint.ts`, `src/byte-duplex.ts`, `src/http.ts`,
   `src/http-conn.ts`, `src/stdcopy.ts`, `src/exec-channel.ts`, `src/exec-run.ts`,
   `src/client.ts`, `src/index.ts`; `test/fake-duplex.ts` (`FakeDuplex`,
   `scriptedDialer`, `response`, `frame`), 8 test files.
3. `AGENTS.md` §6: "14 packages" → 15 (+`docker`); opt-in skips two → three
   (+`TENTACLE_DOCKER_TESTS=1`).

**Transport probes (before writing `socketDialer`, `.tentacle/tmp/docker-engine-client/tls-probe.ts`, `write-probe.ts`, run via `bun test <file>`):**
```
tcp client [ "open", "data:reply-after-end", "close:undefined" ]          ← shutdown() = half-close; NO client "end" event, only close
tls-ok client [ "open", "hs:true…", "data:reply-after-end", "end", "close" ]
tls-other-ca client [ "open", "hs:false:DEPTH_ZERO_SELF_SIGNED_CERT:self signed certificate", "close" ]
tls-badname client [ "open", "hs:false:ERR_TLS_CERT_ALTNAME_INVALID:…" ]
tls-mtls-nocert client [ "open", "hs:true", "close" ]                     ← server rejects AFTER the client's handshake succeeds
tcp [ "first-write=5", "big-write=327212", "drain" ]                       ← partial writes
tls [ "first-write=0", "hs:true", "drain", "big-write=1572864", "drain" ]  ← write before handshake returns 0
```
Consequences built in: `Bun.connect` resolves at `open`, so a TLS dial resolves
only after `handshake(success)` (a failed one → `dialError`); unaccepted bytes are
queued and flushed on `drain`; `end()` waits for the queue before `shutdown()`;
`onEnd` fires on `end` OR `close`; a TLS connection without a client cert that
closes before any byte → onEnd error naming `cert.pem/key.pem`.

**Tests (86 new, 1 opt-in skip):** T1 engine-endpoint 16 · T2 http 12 · T3
stdcopy 9 · T4 byte-duplex 16 (real loopback TCP, unix, TLS, mTLS, 32 MiB
backpressure, ENOENT / stale socket ECONNREFUSED / ENOTSOCK / EACCES / TCP refused /
TLS handshake timeout / abort) · T5 exec-channel 12 · T6 exec-run 12 · T7 client 9
· T8 live 1 (skipped by default).

**Red → green / mutations** (new code ⇒ red shown by mutation, §9; each reverted,
`shasum` identical to the pre-mutation hash, e.g. `byte-duplex.ts`
`22be7d73…`, `http.ts` `8d1ba998…`, `stdcopy.ts` `5c0dde79…`, `exec-run.ts`
`e128f893…`, `exec-channel.ts` `b7a409d4…`, `engine-endpoint.ts` `c92a8329…`,
`client.ts` `9b4d7706…`):

| # | Mutation | Red |
|---|---|---|
| M1 half-close | `shutdown()` → `socket.end()` | T4 TCP + unix (`Received: ""`), 8 MiB-before-FIN (`8045768 ≠ 8388608`). **Note:** the TLS half-close test stays green under it — over TLS Bun's `end()` still lets the reply through, so only TCP/unix discriminate. |
| M2 head parser | drop the 101 leftover | T2 leftover test + T5 "stream bytes in the 101's segment" |
| M3 demux | stderr routed to stdout | T3 ×2, T5 re-chunk, T6 exit-code test |
| M3b demux | `getUint32` → `getInt32` | T3 "size up to 2^32-1" |
| M4 backpressure | high-water check disabled | T6 (`6291579 ≠ 4194304`) |
| M4b dialer partial write | remainder not queued | T4 32 MiB + 8 MiB (`buffered` 0) |
| M5 queue before 101 | frames dropped | T5 queue test |
| M6 stdin EOF | `runExec` never calls `end()` | T6 ×2 |
| M7 plaintext refusal | check disabled | T1 plaintext + SkipTLSVerify |
| M8 API clamp | no `min(…, 1.52)` | T7 (`1.60`) |

After the mutation round, `biome` required two hand edits in `byte-duplex.ts`
(`noUselessElse`, `useConst` on the connect timer; the else became an explicit
`if (ep.kind === "tcp")` — removing it as Biome suggested would apply tcp
mapping to unix codes); the package suite and the live test were re-run green
afterwards (M1/M4b's code was untouched by that edit).

**Live (Docker Desktop 29.1.3, current context `desktop-linux`, API 1.52):**
```
$ TENTACLE_DOCKER_TESTS=1 bun test packages/docker/test/integration.live.test.ts
[live] current context: unix:///Users/gmeghnag/.docker/run/docker.sock engine 29.1.3 API 1.52 → /v1.52
[live] missing binary → exit 127, status: command "no-such-binary-here" could not be started in container "3a37…" (exit 127): OCI runtime exec failed: exec failed: unable to start container process: exec: "no-such-binary-here": executable file not found in $PATH
[live] default Tmpfs /tmp → exit 0; tmpfs /tmp tmpfs rw,nosuid,nodev,noexec,relatime 0 0 sh: line 0: /tmp/x: Permission denied
 1 pass  0 fail  14 expect() calls
$ docker ps -a --filter label=tentacle.test=docker-engine-client
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
```
Proven live: 2 frames sent before the 101 echoed by `cat`; `close()` ends `cat`
(no `cat` left in `ps`); 8 MiB via stdin + half-close → `wc -c` = 8388608, exit 0;
exit 7 + stderr; exec into a stopped container → "is not running"; read-only
rootfs refuses `/bin/x` ("Read-only"), injection + exec in a `rw,exec` tmpfs
`/tmp` works. **Docker's default tmpfs is `noexec`** (input for slice C's
`--bin-dir`). Run twice (before and after the lint edit); `busybox:latest`
pulled, left in the image cache.

**Drift from Implementation (and why):**
- Container label `tentacle.test=docker-engine-client` (orchestrator's
  instruction), not `docker-live`.
- **Podman NOT run live**: the orchestrator forbade starting the Podman machine;
  the run command is in the live test header (`podman machine start` …
  `TENTACLE_DOCKER_CONTEXTS=desktop-linux,podman` … `podman machine stop`).
  Remote TCP/TLS engine not run live either (`TENTACLE_DOCKER_TCP_HOST`); TLS is
  proven hermetically only.
- TLS fixtures: **3 files copied from `packages/client/test/fixtures/`**
  (self-signed `server.pem` = CA + server + mTLS client cert, `server-key.pem`,
  `other-ca.pem`) instead of 6 new ones — `openssl` needed an approval not
  available. The hostname-mismatch case connects to `localhost` (SAN is only
  `IP:127.0.0.1`).
- `hijack(dial, req, { onData, onEnd, signal }) → ByteDuplex` instead of
  returning `{ duplex, leftover }`: handlers are installed before the promise
  resolves and the leftover is delivered first, so no byte can fall in the gap
  between the head and the caller.
- `DockerApiError` lives in `http-conn.ts` (needed by `hijack`; avoids a
  cycle), re-exported by `index.ts`; it carries `engineMessage`.
- TLS material rule softened to the docker CLI's: error only when the dir has
  **none** of `ca/cert/key.pem`, or a cert without its key (a lone `ca.pem` =
  server auth only is valid).
- `EngineTls` carries `dir` (for error messages); `ResolveEndpointInput.homeDir`
  added (fallback when `HOME` is unset).
- Added `stopContainer` (the live test needs it) and `v=true` on remove (anonymous
  volumes would otherwise leak); `ExecInspect`'s `Running` race exit is `null`.
- Added `ENOTSOCK` mapping (a regular file at the socket path).
- Owner answer 3 ("an image without a shell must fail clearly"): `runExec`
  turns exit 126/127 + "executable file not found / no such file / exec format"
  output into `status: command "<argv0>" could not be started in container …`
  (T6 + live). Consumers (slice B injector) must surface `status`.
- `buildRequest` refuses CR/LF in header names/values (not in the plan).

**Not done / open:** Podman live run; remote TLS live run; ssh dialer (A2);
the default-tmpfs `noexec` finding for slice C.

### Fix 1 (Podman live run)

*— claude-opus-5-5, 2026-10-26*

The orchestrator ran T8 on Podman (`TENTACLE_DOCKER_CONTEXTS=podman`, machine
started and stopped by them). Everything up to the stopped-container check
passed; two real bugs:

1. **Exec on a stopped container.** Docker: 409 "is not running" → our message.
   Podman: `500 can only create exec sessions on running containers: container
   state improper` → surfaced raw (the old code matched 409 + text).
   **Fix** (`src/exec-channel.ts`, `explainCreateFailure`): when exec create is
   refused, the client inspects the container and decides from the fact
   `State.Running`: 404 → `container "X" not found (…)`; `Running === false` →
   `container "X" is not running (state: <Status>) — start it or use \`run\``;
   running (or inspect unavailable) → the raw engine error. No engine text is
   matched any more; `describeExecError` became a plain `toError`.
2. **Cleanup leak.** The live `afterAll` timed out at bun's default 5 s, leaving
   2 labelled containers. Cause (from the code + Podman's semantics, **not
   reproduced on Podman here**): removals ran sequentially, and Podman's
   force-remove *stops* the container with its stop timeout (10 s) before
   removing it — our PID 1 is `sleep`, which ignores SIGTERM, so each removal
   waited ~10 s; Docker's force-remove SIGKILLs at once (Docker cleanup: 159 ms
   for 3). **Fix** (`src/client.ts`, `removeContainer`): `POST
   /containers/{id}/kill?signal=KILL` first (its status is not interpreted —
   already stopped/gone are fine and engines word them differently), then
   `DELETE ?force=true&v=true` whose status decides (204/404 ok); the whole call
   is bounded (`RemoveContainerOptions.timeoutMs`, default
   `REMOVE_TIMEOUT_MS` 30 s). Signature changed: `removeContainer(id, { timeoutMs?, signal? })`.
   Live hook: removals in parallel (`Promise.allSettled`), any failure fails the
   hook loudly, duration logged, explicit hook timeout 45 s. `@types/bun` 1.1 does
   not type `afterAll`'s timeout → a localized cast; Bun 1.4.3 honours it
   (probe `.tentacle/tmp/docker-engine-client/hook-timeout-probe.ts`: a 6 s hook
   with a 10 s timeout → `hook finished after 6 s`, 1 pass).
   `AutoRemove` is not set anywhere in slice A (the container manifest is slice
   B); B must use this `removeContainer` (kill + bounded delete) for its delete
   path and exit net, not a bare DELETE.

**Red → green.**
- Fix 1: T6 adds 4 tests (Docker 409 + exited, Podman 500 + exited → the SAME
  message; create fails while running → raw error; container gone → not found);
  T5's 409 test now plays Podman's 500 + an inspect. On the old code all 5 were
  red (each waited for the inspect request the old code never sent → timeout).
  Mutation (`cp` backup, `shasum` `e8bad880…` before and after restore):
  `Running === false` → `=== true` → 4 red on the message assertions.
- Fix 2: T7 adds/changes 3 tests (kill before delete; a refused kill — Podman 500
  — still deletes, 404 success; an engine that never answers → rejects within
  `timeoutMs: 30`); the one-code-path test now has 6 requests. On the old code: 4
  red (`Expected: "POST" Received: "DELETE"`, the 500 kill reply taken as the
  delete's answer, …). Mutation (`cp` backup, `shasum` `e7a7b107…` before and
  after restore): kill call removed → 3 red.

**Evidence.** Package: 91 pass / 1 skip. Docker Desktop live (twice):
```
[live] cleanup: 3 container(s) removed in 160ms
 1 pass  0 fail  14 expect() calls
$ docker ps -a --filter label=tentacle.test=docker-engine-client
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
```
Gate `bun run check`: typecheck ok, lint 504 files clean, **2942 pass / 3 skip
/ 0 fail**.

**Unverified:** the Podman re-run (the machine is not mine to start): `podman
machine start`, `TENTACLE_DOCKER_TESTS=1 TENTACLE_DOCKER_CONTEXTS=podman bun
test packages/docker/test/integration.live.test.ts` (expect the stopped-container
check green and `[live] cleanup … removed in <1 s`), `podman machine stop`, then
`podman ps -a --filter label=tentacle.test=docker-engine-client` empty.

### Fix 2 (Review)

*— claude-opus-5-5, 2026-10-26*

Every Review finding (F1–F5) is fixed, red first, in `packages/docker` only.

- **F1 (one budget for `removeContainer`).** `http-conn.ts`: new `deadline(ms,
  parent)` (one `AbortSignal` for a whole operation: a timer and/or the caller's
  signal, `expired()` tells a timeout from an abort) and `raceSignal`. `request`
  now starts its timer BEFORE the dial and passes the deadline's signal to
  `dial()`, so `timeoutMs` covers the connect. `client.ts`: `apiPath(signal?)`
  races the shared negotiation against the caller's signal. One caller's abort
  never fails the shared `_ping`, which keeps its own 60 s request bound.
  `removeContainer` builds ONE deadline (`timeoutMs` ?? 30 s, plus
  `options.signal`). It covers the negotiation, every dial and every request,
  and those requests get no timer of their own. On expiry it rejects with
  `removing container "<id>" timed out after <ms>ms`.
- **F2 (ownership guard).** `OWNER_LABEL = "tentacle.managed"`.
  `createContainer` always merges `tentacle.managed=true` into the caller's
  `Labels`. `removeContainer` first inspects the container: a 404 means
  already gone (success, nothing more sent); without the label it rejects with
  `refusing to remove container "<id>": it was not created by tentacle (no
  tentacle.managed=true label)` and sends no kill and no delete. Only then come
  the kill and the delete. A remove is now 3 requests (inspect → kill → delete);
  the one-code-path test has 7.
- **F3 (bounded exec start).** `hijack` has `headTimeoutMs` (default
  `DEFAULT_HIJACK_HEAD_TIMEOUT_MS` 30 s). It covers the connect and the wait for
  the `101`. On expiry it rejects with `the engine did not answer the exec start
  within <ms>ms` and the socket is closed. Once the head arrives the deadline is
  disposed, so the stream has no timer. `ExecChannelOptions.startTimeoutMs`
  passes it through; the channel then reports `[docker] exec failed: …` via
  `onStderr` and fires `onClose`. `runExec` uses the default (its own overall
  timeout still applies).
- **F4.** The `waitForRunning` poll delay removes its `abort` listener when the
  timer fires (and handles an already-aborted signal).
- **F5.** `exec-channel.ts` `parseJson` (returns `undefined`, never throws). An
  unreadable inspect body in `explainCreateFailure` keeps the engine's create
  error. The exec-id parse uses it too ("the engine did not return an exec id").

**Red → green.** New and changed tests: T7 — label on create (×2), the
ownership refusal (1 dial only), inspect→kill→delete, the refused-kill and
already-gone cases, `timeoutMs: 30` with a silent request, a stalled `_ping` with
`timeoutMs: 50` (the Reviewer's repro), a dial that never completes, `request`
`timeoutMs: 30` over a stalled dial, `waitForRunning` listener balance. T5 — a
silent exec start with `startTimeoutMs: 30`. T6 — a non-JSON inspect. Before the
fix: **13 red on assertions**, e.g. `Received message: "STILL PENDING after 400ms"`
(F1, the Reviewer's repro reproduced), `Expected: "/v1.52/containers/users-db/json"
Received: ".../kill?signal=KILL"` (F2), `Received: ""` (F3), `Received: 3` live
listeners (F4), `JSON Parse error: Unrecognized token '<'` (F5).

**Mutations** (each from a `cp` backup into
`.tentacle/tmp/docker-engine-client/`, restored with `cp`, `shasum` identical:
`client.ts` `a26f64a8…`, `http-conn.ts` `7fd62d71…`):
- `apiPath(life.signal)` → `apiPath()` together with the ownership guard turned
  off → 2 red: the stalled-`_ping` test (`STILL PENDING after 400ms`) and the
  refusal test (it sent a kill instead of refusing).
- `deadline(timeoutMs…)` and `deadline(headMs…)` → `deadline(0…)` → 2 red: the
  request-covers-connect test and the bounded-exec-start test.

**Evidence.** Package 99 pass / 1 skip. Docker Desktop live: `1 pass 0 fail`,
`[live] cleanup: 3 container(s) removed in 167ms`; `docker ps -a --filter
label=tentacle.test=docker-engine-client` empty. Gate `bun run check`: typecheck
ok, lint 504 files clean, **2950 pass / 3 skip / 0 fail**.

**Notes.**
- `call()`'s 400 "client version … too old" mapping still reads engine text
  (from the original slice; it only adds a hint, no decision depends on it).
- Slice B: containers it creates get the label automatically through
  `createContainer`. The exit net / detached delete child must use
  `removeContainer` (guarded + bounded).
- **Unverified:** a Podman re-run of the guard (needs the Podman machine).

## Review

*— claude-opus-5-5, 2026-10-26* (fresh context, **same model as the executor** —
shared blind spots can survive both passes; acceptable for `contained`, AGENTS §10)

**Verdict: REQUEST-CHANGES** — one small required fix (F1). Everything else holds.

**Findings**
1. **F1 (medium, required) — `removeContainer`'s "whole call bounded at 30 s" is false
   on a client that has not negotiated yet.** `client.ts:282` `await this.apiPath()`
   runs the `_ping` OUTSIDE the deadline, with `request`'s default 60 s timeout. Also
   every `request` (`http-conn.ts:63`) awaits `dial()` (10 s connect timeout) BEFORE its
   own timer starts, so the deadline does not include the two dials either. Repro
   (scratch, `scriptedDialer`, the engine never answers `_ping`):
   `removeContainer("c", { timeoutMs: 50 })` → **`STILL PENDING after 400ms`**. Worst case
   is ~60 s + 2×10 s + 30 s. This matters for slice B: the exit net / detached
   delete child builds a FRESH client, so its first call is exactly this `_ping`. Fix:
   one `AbortSignal` for the whole remove (`AbortSignal.any([options.signal,
   AbortSignal.timeout(ms)])`), passed to `apiPath`/ping and to both dials, plus a test
   with a stalled `_ping`.
2. **F2 (low, note for slice B) — the API shape lets a caller delete any container.**
   `removeContainer(id)` (`client.ts:276`) is SIGKILL + force-delete with no ownership
   check. Nothing calls it in A. But B must never reach it on the `attach` path (§7
   "attach is user-owned"). Suggest B either guards it with a label check
   (`tentacle.owner`/session label read from `inspectContainer`) or exposes only a
   `deleteOwnedContainer` to the runtime. Record it in B's preconditions.
3. **F3 (low) — the exec-start hijack has no timeout.** `hijack` (`http-conn.ts:147`)
   waits forever for the 101. `execChannel` (`exec-channel.ts:218`) adds none. Scratch A7:
   an engine that accepts the start and stays silent → `onClose` not fired after 300 ms,
   and it never fires. `runExec` is covered by its overall timeout. Parity with k8s
   (its WS open has no timer either), so this is not a regression. Cheap to bound it
   (e.g. 30 s → `onStderr` + close). Executor's choice.
4. **F4 (nit)** — `waitForRunning` adds an `abort` listener per poll and never removes
   it (`client.ts:316`). A long wait on a long-lived signal leaks listeners.
5. **F5 (nit)** — `explainCreateFailure` calls `JSON.parse` on the inspect body without
   a guard (`exec-channel.ts:90`). A non-JSON 200 throws a `SyntaxError`, which replaces
   the engine's create error. Wrap it and fall back to `createError`.

**Gate (re-run by me):** `bun run check` → typecheck ok, `biome check .` 504 files
clean, `bun test` **2942 pass / 3 skip / 0 fail** (2945 tests, 228 files). Package
alone: 91 pass / 1 skip / 0 fail.

**Mutations (non-vacuity, §9)**, run with a `cp` backup and restored from it:
- R1 `http.ts:197` drop the 101 leftover (`rest = new Uint8Array(0)`) → red: T2 "101 with
  stream bytes in the SAME push", T5 "stream bytes riding in the 101's segment".
- R2 `byte-duplex.ts:168` `shutdown()` → `end()` → red: T4 TCP half-close, unix
  half-close, "end() waits for queued bytes before the FIN".
- Together: 86 pass / 5 fail. Restored: `shasum` identical (`http.ts` `4b42ae51…`,
  `byte-duplex.ts` `cc893584…`), package back to 91/1/0.

**Live (Docker Desktop 29.1.3, API 1.52):** `TENTACLE_DOCKER_TESTS=1 bun test
packages/docker/test/integration.live.test.ts` → 1 pass / 0 fail, `[live] cleanup: 3
container(s) removed in 168ms`. `docker ps -a --filter
label=tentacle.test=docker-engine-client` is empty. I did not run Podman (I relied on the
orchestrator's run above).

**Premise table** (the ones the design stands on)
| Premise | Verdict |
|---|---|
| `DuplexChannel`: send no-op after close, idempotent close firing `onClose` sync, one handler each | TRUE. `execChannel` mirrors it (`exec-channel.ts:161-177`, `:257-278`); scratch A5: `close()` ×2 + late `peerEnd` → `onClose` once, calls `["end","close"]` |
| `openExec` must be sync and queue until 101 | TRUE. It returns at once; the queue is flushed in order (`exec-channel.ts:237-241`); T5 + live |
| Frames `${json}\n`, blank lines dropped | TRUE (`exec-channel.ts:185-196`, `:262`) |
| Half-close works over TCP/unix with `shutdown()` | TRUE. Proven by mutation R2 (only TCP/unix discriminate; the TLS gap is noted in Execution M1) |
| Stderr never reaches the terminal | TRUE. No `console`/`process.std*`/`Bun.write` in `src/` (rg). Daemon stderr, systemErr and setup errors all go to `options.onStderr` |

**Attacks tried** (scratch `.tentacle/tmp/docker-engine-client-review/attack.test.ts`,
over the real `hijack`/`runExec`/`execChannel`/`DockerClient` with the package's own fakes)
- A1: 101 head + 2 frames fed **byte by byte**, with a frame straddling `\r\n\r\n` → every
  stream byte delivered exactly once, in order (24/24). A1b: 101 + a frame in ONE push →
  the leftover is delivered once, before later data (`[11, 9]`). **Holds.**
- A2: non-101 500, **chunked** with a chunk extension, fed char by char (CRLF split) →
  `DockerApiError "status 500: boom!!!"`, duplex closed. A2b: 404 without a length +
  peer close → EOF body used as the message. **Holds.**
- A8: 70 KB without a head end → "no end of headers within 64 KiB". A non-HTTP
  status line (`SSH-2.0…`) → "bad status line". Both bounded and clear. **Holds.**
- A3/A3b: peer close mid-payload / mid-header (3 bytes) → `runExec` rejects "exec stream
  ended mid-frame (output truncated)". No hang, no silent truncation. **Holds.** (The
  channel drops a cut frame silently, like `streamChannel`. That is a documented choice.)
- A4: a 100 KB frame split over 3 pushes, a zero-length frame, stream 0 → stdout,
  stream 3 → `status`, stream 2 → stderr, real exit code 3. **Holds.** A4b: stream type 4 →
  rejects "malformed docker stream header". **Holds.**
- A5: close ordering / double close / late peer end. **Holds** (see premise table).
- A6: `removeContainer` bound with an unnegotiated client → **F1**.
- A7: a silent exec start → **F3**.
- Endpoint resolution (read against T1 + code): precedence `--context` > `DOCKER_HOST` >
  `DOCKER_CONTEXT` > `currentContext` > default; meta/TLS paths use `sha256(name)`;
  `DOCKER_TLS_VERIFY` non-empty ⇒ TLS (CLI rule, so `=0` also enables, as in the CLI);
  plaintext tcp and SkipTLSVerify are refused with the TLS/ssh/`--insecure-docker-tcp`
  message (M7 in Execution); `ssh://` rejects `-` prefixes, whitespace/control
  characters and paths. **Holds.** Gap, not a defect: `DOCKER_TLS` (TLS without verify)
  is not read, so it lands on the plaintext refusal, which is loud and safe.

**Footprint / merge risk:** outside `packages/docker/` only `AGENTS.md` (§6 lines
92-100), `tsconfig.json` (one `paths` line) and `bun.lock` (the generated workspace
entry). The main checkout's `AGENTS.md` §6 is byte-identical to the branch's pre-edit
text, so the edit should apply cleanly. **Unverified:** I could not run `git log
7961bcc..main` (git outside the worktree needs approval). Before merge, check that
main's new commits did not touch `AGENTS.md` §6 or `tsconfig.json` `paths`, and
regenerate `bun.lock` with `bun install` if it conflicts.

**What holds:** the hand-written HTTP is careful. It has a bounded head, chunked
parsing with split CRLFs, the leftover delivered before any later byte with the
handlers installed before resolve, and a strict demux with a cut-frame check. The
`Dialer`/`ByteDuplex` seam is clean (T7 shows byte-identical requests over two dialers).
Tests are non-vacuous (2/2 mutations red here; 10+2 in Execution).

**How the executor behaved:** it probed Bun's socket behaviour before writing the
dialer, recorded every drift honestly (fixtures, `hijack` shape, label, the Podman run
not done by it) and flagged the TLS-half-close blind spot of its own M1. Fix 1 picked a
fact (container state) over error-text matching, which is good. Its one overclaim is
F1: "the whole call is bounded" was tested only with an already-negotiated client and
a dial that resolves instantly.

<!-- Notes / debt for Review:
- Fresh dial per REST request (`Connection: close`): fine on unix/TLS; over ssh
  (A2) each dial is an ssh handshake — A2 measures it and, if needed, adds
  `-o ControlMaster=auto -o ControlPath=<configDir>/ssh-%C -o ControlPersist=60`
  (argv, no secrets) rather than a keep-alive pool here.
- A small line splitter duplicates ~15 lines of `ExecDemux`/`streamChannel`
  logic; deliberate (no `@tentacle/docker` → `@tentacle/k8s` dependency).
  Slice B may hoist a shared one into `@tentacle/transport`.
- Types mirror k8s's `RunExecResult`/`RunExecOptions` structurally; slice B
  unifies them under `SandboxHost`.
- Order: A → A2 → B → C (+ `fix/musl-image-detect` independent, any time).
-->

### Owner answers

*— recorded by the orchestrator (claude-opus-5-5), 2026-10-26*

The plan is APPROVED with these answers:

1. **ssh:** a separate slice A2 `feat/docker-ssh-dialer` (S · contained) right
   after A; A fixes the `ByteDuplex`/`Dialer` seam and parses `ssh://` (owner: "ok").
2. **musl detection:** a separate `fix/musl-image-detect` (S, `pod-binary.ts`),
   serving k8s and Docker, with the message "this image uses musl (Alpine): use
   a glibc-based image" (owner: "si"). The stale comment at `pod-binary.ts:107`
   moves to that fix (orchestrator: same comment block) — slice A does NOT
   touch `packages/cli`.
3. **`PUT /archive`:** not now; the live test proves exec injection on a
   read-only rootfs with a writable `/tmp`; an image without a shell must fail
   with a clear message, never an obscure one; `PUT /archive` → TODO (owner: "ok").

### Live run on Podman (orchestrator, 2026-10-26)

*— claude-opus-5-5 (orchestrator), 2026-10-26*

`podman machine start`; `TENTACLE_DOCKER_TESTS=1 TENTACLE_DOCKER_CONTEXTS=desktop-linux,podman bun test packages/docker/test/integration.live.test.ts`.
First run (before Fix 1): Podman failed — exec on a stopped container got HTTP 500
"can only create exec sessions on running containers: container state improper"
(Docker: 409), and the `afterEach` cleanup timed out at 5 s leaving 2 labelled
containers (removed by hand). After Fix 1: **2 pass / 0 fail** (Docker Desktop +
Podman); labelled containers left: 0 on both; machine stopped again.
