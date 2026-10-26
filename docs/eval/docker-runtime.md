# eval/docker-runtime — `run`/`attach` on a Docker (or Podman) engine, local or remote

> **Status:** eval (Context + Review verdict; no code)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** n/a (the build, if approved, is split into 3 tasks: M·contained, M·load-bearing, M·cross-module — see Review) · **Blast:** n/a for the eval · **Suited:** owner decides; the load-bearing slice → strong model + fresh-context Review.

## Context

*— claude-opus-5-5, 2026-10-26*

### The question (owner, 2026-10-26)

> "Integrate the same `run`/`attach` mechanism with Docker: I run, or attach
> to, a container on the Docker that runs on my laptop or on a server. The
> optimum would be the same JSON-RPC-over-WebSocket pattern we use with k8s
> today — but let's understand."

Decided here: (a) which transport carries the RPC to a daemon inside a Docker
container; (b) how the binary gets in; (c) lifecycle + trust; (d) workspace;
(e) CLI shape — and whether "the same as k8s" is literally achievable.

### Constraints (AGENTS §7, all binding)

- **One session path** (AGENTS.md:142): a new target adds ONLY a transport (a
  `DuplexChannel`) + lifecycle. The RPC layer needs nothing else:
  `DuplexChannel` is four methods — `send/close/setOnMessage/setOnClose`
  (`packages/transport/src/channel.ts:9-18`).
- **Compute next to the code, identity with the user; the container is not
  trusted** (AGENTS.md:194); **model stays on the laptop** (AGENTS.md:190):
  the daemon runs `serve --stdio --model-proxy` and reaches the model over the
  RPC (`packages/cli/src/pod-runtime.ts:61-63`, `laptopModels` :72-85).
- **Pod lifecycle** (AGENTS.md:257): `run` creates AND deletes (with an
  exit net that survives `process.exit`); `attach` never creates/deletes;
  secrets via env, never argv.
- **Self-contained, no external CLI** (F4 design, `docs/architecture/F4-pod-execution.md:26`
  "No shelling out to `kubectl` / `oc`").

### 1. How k8s `run`/`attach` works today (from the code)

| Piece | Where | k8s-specific? |
|---|---|---|
| **Transport.** `KubeClient.openExec` builds the exec URL (`buildExecUrl`, `packages/k8s/src/exec-channel.ts:254-269`) and opens a `WebSocket` with subprotocol `v4.channel.k8s.io` (+ the bearer token as a `base64url.bearer…` subprotocol, :281-287); `execChannel` wraps it as a `DuplexChannel` (:102-242): RPC frames go out as channel-0 stdin `[0x00, …frame\n]` (`exec-frame.ts:21-27`), come back re-chunked on `\n` off channel 1 (`ExecDemux`, `exec-frame.ts:43-83`); stderr (ch. 2) → buffered sink; outbound frames queued until `open` (:111-132); keepalive = WS ping + blank stdin line, close after 2 silent ticks post-first-pong (:147-179). | The **framing** (channel byte, subprotocol, bearer subprotocol) and the WS ping keepalive are k8s-specific. The **pattern** (newline-delimited JSON frames over a process's stdin/stdout) is generic — it is exactly `streamChannel` (`packages/transport/src/stream-channel.ts:1-12`). |
| **Daemon.** `tentacle serve --stdio --model-proxy [--auto-title]` exec'd in the container (`pod-runtime.ts:61-63`, :372-379). A new exec = a new daemon; a reconnect re-dials the exec after a preflight (`execChannelFactory`, :252-269; `podDialError`, :215-243). | Generic (only the preflight verdict reads pod phases). |
| **One-shot exec** that resolves on exit (`runExecOverWebSocket`, `exec-run.ts:126-319`): exit code from the ch. 3 `Status` JSON (`parseKubeStatus`, :77-103 — k8s gives only Success/Failure → 0/1), backpressure on `bufferedAmount` (:211-237). | k8s-specific (status channel, no numeric exit code). |
| **Binary injection** (`injectAgentBinary`, `packages/cli/src/pod-binary.ts:128-216`): `uname -m` → `bun-linux-x64|arm64` (:37, :51-54) → resolve bytes (`resolvePodBinary`, `pod-binary-build.ts:245-309`, cross-compiled with `Bun.build compile.target`, :87-110) → one exec `sh -c "mkdir -p D && head -c N > P.new && chmod 755 P.new && mv -f P.new P"` with the bytes as stdin (`pod-binary.ts:166-187`) → verify `P --version` (:198-213). `head -c N` exists because **v4 cannot half-close stdin** (AGENTS.md:262-266; `exec-run.ts:8-11`). `--bin-dir` for a read-only rootfs (`pod-runtime.ts:143-147`, :298-300). glibc only: musl images fail with `libcMismatchHint` (`pod-binary.ts:104-117`). `attach` first probes `tentacle --version` and reuses/replaces (`pod-runtime.ts:507-602`). | **Generic** — written entirely against `PodCluster.runExec` (`pod-runtime.ts:127-137`); nothing in it is k8s. |
| **Lifecycle.** `run`: `checkPodBinaries` before any mutation (:320) → `createPod(buildPodManifest)` (`pod.ts:38-77`: keepalive `sleep infinity`, `restartPolicy: Never`, optional `activeDeadlineSeconds` TTL) → `registerPodCleanup` (`process.once("exit")` → `deletePodBestEffort`, :281-285) → `waitForReady` → inject → open exec → `createLocalRuntime(…, daemonKind:"container")` (:381-405); `dispose` closes the channel and deletes the pod (:388-394). `attach`: `getPod` (404 → actionable), terminal phase → refuse, bounded ready wait, probe/inject, same runtime, **no delete, no exit net** (:448-652). | The verbs are k8s REST; the **sequence** is generic. |
| **Exit net.** Detached, `unref`'d child: from a compiled binary it re-execs itself with the hidden `__delete-pod` (`main.ts:206-209`), from source `bun -e <script>`; config + token + TLS via `TENTACLE_POD_*` **env, never argv** (`pod-cleanup.ts:143-196`). | The mechanism is generic; the payload (one `DELETE /pods/<n>` URL + bearer) is k8s. |
| **Auth.** kubeconfig current context or `TENTACLE_K8S_SERVER/_TOKEN` (`main.ts:450-469`); Bun per-call `tls:{ca,cert,key}` on `fetch` and `WebSocket` (AGENTS.md:262). | k8s-specific. |

**Reusable seam that already exists:** `PodCluster` (`pod-runtime.ts:127-137`)
is the lifecycle+exec interface the whole runtime and the injector are written
against. Docker is a second implementation of (a generalised) `PodCluster`, not
a second runtime.

### 2. Docker transport options — probes

All probes are Bun scripts in `.tentacle/tmp/docker-runtime/` (gitignored; the
key ones pasted below). Environment, 2026-10-26: Docker Desktop **29.1.3,
linux/arm64, API 1.52 (min 1.44)**, socket `~/.docker/run/docker.sock`; Bun
1.4.3; contexts:

```
$ docker context ls
NAME              DESCRIPTION                               DOCKER ENDPOINT
default           Current DOCKER_HOST based configuration   unix:///var/run/docker.sock
desktop-linux *   Docker Desktop                            unix:///Users/gmeghnag/.docker/run/docker.sock
podman            Podman                                    unix:///var/folders/gf/…/podman/podman-machine-default-api.sock
```

**(P1) Engine REST over the unix socket — `fetch(url, { unix })`: works.**
```
$ bun p1-fetch-unix.ts ~/.docker/run/docker.sock
status=200 Version=29.1.3 ApiVersion=1.52 Os=linux Arch=arm64 Components=["Engine","containerd","runc","docker-init"] (11 ms)
_ping 200 OK Api-Version=1.52
$ bun p1-fetch-unix.ts <podman socket>
TypeError: ECONNREFUSED          ← the Podman machine is stopped; not started (out of scope)
```
Over TCP the same REST works with a plain `http://host:port` (P4 below, via a
local TCP→unix relay standing in for a remote daemon: `tcp-relay REST _ping: 200 OK`).

**(P2/P3) `exec` create + start — the start is an HTTP/1.1 hijack
(`Connection: Upgrade`, `Upgrade: tcp` → `101 UPGRADED`), stdout/stderr
multiplexed with the 8-byte header `[stream,0,0,0,size32be]` when `Tty:false`.**

```
$ bun p3-exec-duplex.ts
(A) response 101 arrived while the request body is still OPEN
(A) after writing 'one': "\u0001\u0000\u0000\u0000\u0000\u0000\u0000 {\"Detach\":false,\"Tty\":false}one\n"
(A) after writing 'two': "\u0001\u0000\u0000\u0000\u0000\u0000\u0000\u0004two\n"
(A) after closing body: done=true
(B) status line: HTTP/1.1 101 UPGRADED (1 ms)
(B) ping-pong: stdout:"alpha\n" | stdout:"beta\n"
(B) after shutdown(): stderr:"stdin-EOF-seen exit=0\n" ; socket closed 14 ms
(B) exec inspect: Running=false ExitCode=0
```
- **(A) Bun `fetch` + streaming body (`duplex:"half"`)** does get the 101 and
  is even interactive, **but the start-config JSON is delivered to the
  process's stdin** (`cat` echoed `{"Detach":false,"Tty":false}`): the engine
  never parsed the body as the start options. It works by accident (defaults
  happen to be what we want) on an undocumented shape — **rejected**.
- **(B) `Bun.connect({ unix })` + a hand-written HTTP/1.1 request** (explicit
  `Content-Length`, read the head up to `\r\n\r\n`, then raw bytes): a true
  duplex, deterministic. **Half-close works**: `socket.shutdown()` →
  the process sees stdin EOF → exits 0, exit code readable from
  `GET /exec/{id}/json`. So Docker does NOT need the k8s `head -c N` trick
  (it still works; see §3) and gives a **real numeric exit code** (k8s only
  gives Success/Failure, `exec-run.ts:43-50`).
- Over TCP (P8, same code with `hostname/port`): `status: HTTP/1.1 101 UPGRADED`,
  `frames over TCP: stdout:"over-tcp\n"`. Half-close over TCP was **not**
  proven (my relay closes both directions); TLS over `Bun.connect({tls})` was
  **not** probed (no remote TLS daemon available) — both are one cheap test on
  the first build slice.

**(P4/P5) `/containers/{id}/attach/ws` — a real WebSocket, opens, but stdin
never reaches the process on this engine.**
```
$ bun p4-attach-ws.ts            # main process: cat, OpenStdin:true
ws+unix: open (protocol="")
ws+unix: TIMEOUT got=[]
tcp-relay: open (protocol="")
tcp-relay: TIMEOUT got=[]
container logs (did stdin reach cat?): ""
hijack-attach: "\u0001\u0000\u0000\u0000\u0000\u0000\u0000\u000bvia-hijack\n"   ← control: the hijacked POST /attach works
$ bun p5-attach-ws-variants.ts
tty=false path=/v1.52: ws-echo="" logs="" rm=204
tty=false path=(unversioned): ws-echo="" logs="" rm=204
tty=true path=/v1.52: ws-echo="" logs="" rm=204
tty=true path=(unversioned): ws-echo="" logs="" rm=204
```
Bun's `WebSocket` does reach a unix socket (`ws+unix://<sock>:<path>` opened),
but binary or text frames were never written to `cat`'s stdin (empty logs) in
4 variants. Two strikes → category closed (AGENTS §0). Even if it worked it
would be the wrong design:
1. it attaches to the **main process** only — `attach` to an existing user
   container (whose PID 1 is the user's app) needs `exec` anyway, so it could
   never be the single mechanism;
2. the main process's stdout goes to the **container log driver**: every RPC
   frame (prompts, model output, file contents) would be persisted on the
   Docker host and readable with `docker logs`. Exec stdio is not logged
   (P6: `container log after all execs (exec stdio is NOT logged): ""`);
3. one `serve --stdio` per container lifetime: no re-dial after a drop (the
   k8s reconnect re-execs a fresh daemon, `pod-runtime.ts:245-269`).

**(—) Shelling out to `docker exec -i`.** Trivially a `DuplexChannel` (spawn +
`streamChannel`), and it would inherit `ssh://` contexts and credential
helpers. Against: it is the `kubectl` decision again (F4 doc :26, :105) — a
hard dependency on a CLI the user may not have (Podman-only, Colima, a server
reached only by socket), a subprocess per exec, process-group/exit plumbing,
and its stderr to keep off Ink's terminal (AGENTS "never write raw"). Not
probed — nothing to learn. **Rejected as the primary path**; at most a later
escape hatch for `ssh://` (see owner Q3).

**`ssh://` hosts.** The docker CLI implements them as `ssh host -- docker
system dial-stdio` (an HTTP connection over ssh's stdio). Native equivalents:
(a) the user forwards the socket (`ssh -L ~/.tentacle/d.sock:/var/run/docker.sock host`)
and points `DOCKER_HOST=unix://…` at it — zero code; (b) later, spawn
`ssh … docker system dial-stdio` and run the same hand-written HTTP over its
stdio (the hijack code is transport-agnostic if written over a byte duplex).

**Podman.** Its compat API serves the same `/v1.x/containers|exec` endpoints
with the same hijack; the context shows a plain unix socket. **Unverified
live** (machine stopped). Context resolution is file-based and cheap:
`~/.docker/contexts/meta/<sha256(name)>/meta.json` (verified:
`sha256("podman") = 2f259bab…` = `MetadataPath` of `docker context inspect podman`),
plus `DOCKER_HOST`, `DOCKER_CONTEXT`, `currentContext` in `~/.docker/config.json`,
`DOCKER_TLS_VERIFY`/`DOCKER_CERT_PATH` (`ca.pem`,`cert.pem`,`key.pem`).

### 3. Binary injection — probes

The linux binary was built with the repo's own builder
(`buildBinary`, `pod-binary-build.ts:87`) into the tmp dir.

```
$ bun p6-e2e.ts buildpack-deps:bookworm-curl tentacle-bun-linux-arm64 tentacle-bun-linux-arm64-musl
uname -m → aarch64 (exit 0)
[tentacle-bun-linux-arm64] PUT /archive (89.0 MB) → 200 in 629 ms
[tentacle-bun-linux-arm64] exec-stdin cat> (89.0 MB) → exit 0, 93309736 bytes in 557 ms
[tentacle-bun-linux-arm64] --version → exit 0 stdout="tentacle 0.1.0" stderr=""
[tentacle-bun-linux-arm64-musl] --version → exit 255 stderr="exec …-musl: no such file or directory"
serve --stdio initialize → {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":11,"agentCapabilities":{"tools":true,"permissions":true},"skills":[]}}
after stdin half-close: daemon Running=false ExitCode=0
container log after all execs (exec stdio is NOT logged): ""
$ bun p6-e2e.ts busybox:latest …-musl …glibc
[tentacle-bun-linux-arm64-musl] --version → exit 255 "exec …: no such file or directory"
[tentacle-bun-linux-arm64]      --version → exit 127 "error while loading shared libraries: libdl.so.2 …"
$ bun p6-e2e.ts alpine:3 …-musl …glibc
[tentacle-bun-linux-arm64-musl] --version → exit 127 "Error loading shared library libstdc++.so.6 …"
[tentacle-bun-linux-arm64]      --version → exit 255 "exec …: no such file or directory"
```
**The full k8s chain works on Docker unchanged in substance**: arch probe →
transfer → `--version` → `serve --stdio` answers a real `initialize`
(protocol 11) over the hijacked exec; stdin EOF ends the daemon cleanly.

- **`PUT /containers/{id}/archive`** (tar of one file, hand-built ustar):
  one request, ~0.6 s for 89 MB locally; needs **no `sh`/`head`/`cat` in the
  image** (distroless works), and the tar header carries the mode. Its
  behaviour on a read-only rootfs or a tmpfs path was **not** probed.
- **exec stdin** (`cat > P` + half-close, or the k8s `head -c N` command
  as-is): same speed, and **reuses `injectAgentBinary` verbatim** through a
  Docker `runExec`. Needs `sh` in the image (as k8s does).
- **Bind-mount the laptop binary**: only possible for a local engine, and the
  laptop binary is darwin — useless; a linux build bind-mounted from
  `<configDir>/bin` would work locally but not remotely → no.
- **Arch/libc.** Docker Desktop on Apple Silicon runs a linux/arm64 VM, so a
  darwin laptop needs the cross-built `bun-linux-arm64` (already what k8s
  resolves). **New fact:** Bun 1.4.3 *does* have `bun-linux-*-musl` targets
  (the build above succeeded; the comment "Bun has no static or musl build",
  `pod-binary.ts:107`, is stale), **but** the musl binary needs `libstdc++`/
  `libgcc` (absent from `alpine:3`), so "glibc image required" stays true out
  of the box. Alpine-with-libstdc++ is a possible later extension (unverified).
- **Env.** `inspect` shows a container's `Config.Env` in clear (P7:
  `["PROBE_CONTAINER_ENV=visible?"]`); an exec's `Env` is **not** in
  `GET /exec/{id}/json` (P7: `false`) — but visible inside the container via
  `/proc/<pid>/environ`. Same as k8s (pod spec env is readable with `get pod`).
  Moot for the daemon: **no secret enters the container at all** (model stays
  on the laptop). It matters only for the laptop-side exit-net child (env, as today).

### 4. Lifecycle & security (facts the design must respect)

- `run`: `POST /containers/create` (label `app.kubernetes.io/managed-by`-style
  `tentacle.managed-by=tentacle`, keepalive `sleep infinity`) → `start` →
  ready = `State.Running` (no readiness probe) → inject → exec daemon;
  `dispose` → `DELETE /containers/{id}?force=true`. Exit net: same detached
  child, payload = one `DELETE` over the unix socket (`fetch({unix})`) or TCP
  +TLS. Backstop equivalent to `activeDeadlineSeconds` (`pod.ts:64`): keepalive
  `sleep <ttl>` + `HostConfig.AutoRemove:true`.
- `attach <container>`: `GET /containers/{id}/json` (404 → actionable; not
  running → refuse), probe/inject, exec; **never create/delete**, no exit net.
- **The container is not trusted** (AGENTS.md:194): it already only speaks
  RPC frames to the laptop, which gates every effect through the single broker
  — unchanged. Docker-specific rules: **never** bind-mount the Docker socket
  into the container (that is host root), no `Privileged`, `CapDrop` sensible
  defaults, no host network/pid.
- **The Docker socket is root-equivalent on a Linux host** (on macOS it is
  root in the Desktop VM). Talking to it is what `docker` itself does; the risk
  is a **remote `tcp://` without TLS** (unauthenticated root on the server):
  refuse it unless explicitly opted in.

### 5. Workspace — the big difference from k8s

k8s has no access to the laptop's files: workspace = the image / a clone
(`F4-pod-execution.md:196-200`). A **local** Docker engine can bind-mount the
cwd (`HostConfig.Binds:["<cwd>:<cwd>"]`, `WorkingDir:<cwd>`, same absolute
path so tool output paths match the laptop's). That makes local Docker the
"sandboxed local TUI": same files, isolated processes/packages/network. It
also means an untrusted process gets **write access to the laptop cwd** —
which is exactly what the local TUI's tools already have, but now without the
host's other files. For a **remote** engine a laptop path means nothing on the
server: workspace = image / clone / a server volume, as k8s.

### 6. CLI shape

Today: `run --image <ref> [-n] [--bin-dir] [<name>]`, `attach <pod> [-n] [-c]
[--bin-dir]` (`main.ts:82-90`, :539-629). The runtime functions take a
`PodCluster` (`pod-runtime.ts:139-158`, :417-434), so the CLI only chooses
which client to build.

## Implementation

*(empty — an eval; filled when promoted)*

## Execution

*(empty)*

## Review

*— claude-opus-5-5, 2026-10-26*

### Verdict

**Recommend: build it**, as a second implementation of the existing
`PodCluster` seam, transport = **Engine API `exec` over a hand-written
HTTP/1.1 hijack on `Bun.connect` (unix socket, or TCP+TLS)**, demuxing the
8-byte stdout/stderr header into the same newline-delimited RPC frames.

**"The same JSON-RPC over WebSocket as k8s"? No — and it should not be.**
The only Docker WebSocket (`attach/ws`) did not deliver stdin on Docker 29.1.3
(P4/P5), attaches to PID 1 only (useless for `attach` to a user container) and
would write every RPC frame into `docker logs`. The right reading is **"the
same JSON-RPC over a different byte stream"**: the RPC layer only ever needed
a `DuplexChannel` (`channel.ts:9-18`), and the k8s WebSocket was just k8s's
byte stream. What is genuinely the same: `serve --stdio`, the frames, the
injection, the lifecycle sequence, the single broker, the laptop-side model.
Docker is even simpler than k8s: real stdin half-close and real exit codes.

What holds: P3/P6 prove the whole chain end-to-end on a real engine
(inject 89 MB in ~0.6 s → `--version` → `initialize` answered → clean exit on
EOF; nothing in `docker logs`). What is **not** proven: half-close over TCP,
TLS via `Bun.connect`, Podman live, `PUT /archive` on read-only rootfs —
each is one test in slice A below.

### Sketch of the design if approved

- **Generalise the seam (rename, no behaviour change):** `PodCluster` →
  `SandboxHost` (`create/get/waitForReady/delete/deleteBestEffort/openExec/runExec`)
  with a backend-neutral state (`running | starting | gone`) and the
  error translators (`podCreateError`, `containerExecError`, `podDialError`,
  `pod-runtime.ts:168-243`) moved behind it. `ExecTarget.pod` → `name`.
  `startPodRuntime`/`startAttachRuntime` stay ONE code path for both backends
  (AGENTS.md:142).
- **`packages/docker` (new):** `engine-endpoint.ts` (pure: `DOCKER_HOST`,
  `DOCKER_CONTEXT`/`--context`, `~/.docker/contexts/meta/<sha256>/meta.json`,
  `DOCKER_TLS_VERIFY`/`DOCKER_CERT_PATH` → `{unix}|{host,port,tls}`; `ssh://`
  → actionable error with the `ssh -L` recipe), `hijack.ts` (pure HTTP/1.1
  request builder + response-head parser), `stdcopy.ts` (pure 8-byte demux —
  the `StdDemux` of the probe), `exec-channel.ts` (`DuplexChannel` over a
  `Bun.connect` socket: buffer until 101, frames as `${json}\n`, stdout
  re-chunked on `\n`, stderr → `onStderr`, `shutdown()` on close; keepalive =
  blank stdin line + TCP keepalive, no WS ping), `exec-run.ts` (one-shot:
  write input with `drain` backpressure, half-close, exit code from
  `GET /exec/{id}/json`), `client.ts` (`DockerClient implements SandboxHost`,
  container create with labels/`AutoRemove`/TTL, bind-mount option),
  `cleanup.ts` (exit-net payload; the hidden `__delete-pod` becomes a
  backend-tagged `__cleanup`, env-only).
- **Injection:** keep `injectAgentBinary` as is (through `runExec`);
  `PUT /archive` only as a later optimisation for images without `sh`.
- **CLI:** see owner Q1; `daemonInPod`/`daemonKind:"container"` already fit.

| # | Task | Size · Blast | Notes |
|---|---|---|---|
| A | `feat/docker-engine-client` — `packages/docker`: endpoint resolution, hijack, stdcopy demux, exec channel, one-shot exec, REST verbs; unit tests with a fake socket + an opt-in live test (`TENTACLE_DOCKER_TESTS=1`, like the k8s opt-in). Closes the 4 unproven points above. | M · contained (new leaf package, no caller yet) | weaker model OK; standard Review |
| B | `feat/sandbox-host-seam` — `PodCluster` → backend-neutral `SandboxHost`, translators moved, `DockerClient` wired as the second impl; exit-net child generalised. | M · **load-bearing** (the run/attach path, the exit net, AGENTS "pod lifecycle") | strong model; mandatory fresh-context Review red-teaming "one session path" + "never delete on attach" |
| C | `feat/docker-run-attach-cli` — flags/help/env (`--docker`, `--context`, `--mount`), bind-mount default for a local engine, refuse plaintext remote TCP; docs (F4 + AGENTS §7 "Pod lifecycle" wording → "pod/container"). | M · cross-module | standard Review |

Order A → B → C (A is safe to land alone; B is the only risky one).

### Owner questions (with my recommendation)

1. **CLI shape?** `run --docker [--context <ctx>] --image …` / `attach --docker <container>`
   vs a generalised `--target k8s|docker`. → **`--docker` (+ `--context`,
   honouring `DOCKER_HOST`/`DOCKER_CONTEXT`)**, k8s stays the default; a
   `--target` enum buys nothing with two backends.
2. **Local workspace:** bind-mount the cwd read-write by default on a local
   engine? → **Yes, rw, same absolute path** (that is the point of a local
   sandbox), with `--no-mount` to opt out; never for a remote engine.
3. **`ssh://` contexts in v1?** → **No**: a clear error with the `ssh -L`
   socket-forward recipe; a native `dial-stdio` adapter only if asked for.
4. **Podman:** support in v1 (same API) and verify live once (start the
   machine)? → **Yes, verify in slice A** — it costs one opt-in test run.
5. **musl/Alpine:** pursue the `bun-linux-*-musl` targets (need `libstdc++`
   in the image)? → **Not now**; keep "glibc image" and fix the stale comment
   at `pod-binary.ts:107` in slice A.
6. **Remote plaintext `tcp://` (no TLS):** refuse unless
   `--insecure-docker-tcp`? → **Yes, refuse by default** (it is unauthenticated root on the server).

### How the evaluating model behaved

Probes first, then design. Dropped two directions on evidence (fetch-based
hijack: worked only by feeding the start JSON into stdin; `attach/ws`: 2
strikes). One contradiction with repo text surfaced (musl target exists).
Left unverified items listed, not papered over. Cleanup: every probe
container labelled `tentacle.eval=docker-runtime` and removed (`docker ps -a
--filter label=tentacle.eval=docker-runtime` → empty); the `alpine:3` image
pulled for the musl test is still present (its `docker rmi` needed approval).

### Owner answers

*— recorded by the orchestrator (claude-opus-5-5), 2026-10-26*

1. **CLI shape:** `--docker` (+ `--context`, honouring `DOCKER_HOST` /
   `DOCKER_CONTEXT`); k8s stays the default (owner: "si").
2. **Local workspace:** bind-mount the cwd read-write at the same absolute
   path on a local engine, `--no-mount` to opt out; never on a remote engine
   (owner: "perfetto direi").
3. **`ssh://` contexts: IN v1 — reverses the evaluator's recommendation.**
   tentacle spawns `ssh <host> docker system dial-stdio` (what the docker CLI
   does) and runs the same hand-written HTTP over its stdio; one transport
   code path over a byte duplex. Needs `ssh` on the laptop and `docker` on
   the server. Adds a small slice to the build (owner: "si").
4. **Podman:** supported in v1; verified live in slice A (start the Podman
   machine for the opt-in test, stop it after) (owner: "si").
5. **musl / Alpine:** not supported now; tentacle DETECTS a musl image and
   fails with a clear message ("this image uses musl (Alpine): use a
   glibc-based image") on BOTH Docker and k8s, never a cryptic crash; fix the
   stale comment at `pod-binary.ts:107` (owner: "perfetto").
6. **Plaintext `tcp://`:** refused by default with a message pointing to TLS
   (`:2376` + certs) or `ssh://`; explicit `--insecure-docker-tcp` to force
   it (owner: "ottimo").

Not yet decided: WHEN to build (promotion to `feat/`, queue position).

> **Owner decision (2026-10-26, supersedes `--docker` above):** the CLI selects the engine with ONE flag, `--engine kubernetes|docker|podman` (on `run` and `attach`), not a `--docker` boolean. The DEFAULT engine is configurable (config key `engine:`, project/user config; the flag overrides it); with nothing configured it stays `kubernetes` (today's behaviour). `podman` uses the same Docker-API code path but auto-discovers podman's socket (rootless, podman machine on macOS) so the user needs no `DOCKER_HOST`. Rejected names: `--runtime` (clashes with tentacle's own "runtime" = worker/run/attach/connect), `--sandbox` (promises isolation `attach` does not give), `--backend`/`--on` (vague / unusual). Proposal for slice B, to confirm when planned: name the seam `EngineHost` instead of `SandboxHost`.
