# F4 — Pod Execution: Architecture & Design

Status: **F4.a–F4.g shipped (2026-10-14/15 + branch `feat/pod-exec-attach`)**, validated live; the original
design is captured here and §8 records what actually shipped. The pod-binary
injection (F4.e) has its own detailed design + as-built log in
`docs/feat/pod-binary-injection.md`; the `exec` attach (F4.g) has its plan +
as-built in `docs/feat/pod-exec-attach.md`. It builds on F3
(`docs/architecture/F3-remote-control.md`) and reuses **the entire client/daemon/RPC stack
unchanged** — F4 is a new *transport + lifecycle + reverse-tunnel*, not new
protocol design above the wire vocabulary.

---

## 1. Goal & scope

**Goal:** `tentacle run --image <ref> [--namespace <ns>] [<name>]` runs
the agent **inside a Kubernetes pod** (the sandbox), driven from the **local
TUI on the laptop**; `tentacle attach <pod> [--namespace <ns>]` attaches
the **same** TUI to an **existing** pod (injecting the binary if it lacks one)
without creating or deleting anything. In both cases the user types locally
and the agent loop, tool execution, `/loop`, background jobs, MCP servers —
everything — run in the pod. Streaming UX, permission prompts, and session
persistence are identical to the local experience.

**Hard constraints (from the request):**
- **Self-contained.** No shelling out to `kubectl` / `oc`. The tool talks to the
  Kubernetes API server directly (kubeconfig auth + REST + the exec WebSocket
  subprotocol).
- **Reverse-tunnel for the model.** The user's model endpoint may only be
  reachable from the laptop (e.g. a local `llama.cpp` on `localhost:8080`). The
  pod must reach it **without** a second inbound connection to the laptop.

**Non-goals (v1):** persistent/detached daemon with reconnect (the exec session
is tied to the connection), multi-client fan-out, bidirectional file-sync of the
workspace, and auth-plugin coverage beyond what §4 lists.

---

## 2. Why this is mostly already built

The harness already separates **TUI (client)** from **agent daemon (server)**
behind a transport-agnostic `RpcPeer` over a `DuplexChannel`. Three transports
exist today: an in-memory pipe (tests), `messagePortChannel` (the default local
worker daemon), and WebSocket (`serve`/`connect`). **A pod is a fourth transport
scenario**; everything above it is reused verbatim:

- `session/prompt`, streamed `session/update`, `snapshot`, resume seed, and the
  `seq`/`turnBuffer`/`replayFrom` groundwork.
- **Permission prompts** route back to the local TUI over
  `session/request_permission` — already remote-capable in F3.
- **Persistence stays on the laptop**: the main thread owns the JSON store and
  `snapshot`s after each turn (the `persistingController` pattern in
  `cli/src/local-runtime.ts`), so `--resume` works and the pod is stateless.
- `HostExecution` confined to its `cwd` is the sandbox boundary — **in the pod,
  the pod itself is the sandbox** (namespace, `securityContext`, resource
  limits, NetworkPolicy, seccomp).

The new runtime is `startPodRuntime(config)`, analogous to `startWorkerRuntime`,
returning the same `LocalRuntime` (`createSession` / `jobs` / `dispose`) the TUI
already consumes. The TUI, agent loop, permissions, and persistence do **not**
change.

---

## 3. Transport: Kubernetes exec over `v4.channel.k8s.io`

The RPC channel to the pod daemon is a **WebSocket to the pod's `exec`
subresource**, which is directly implementable with Bun's WebSocket client (no
SPDY):

```
GET wss://<api-server>/api/v1/namespaces/<ns>/pods/<pod>/exec
    ?container=<c>&stdin=true&stdout=true&stderr=true&command=tentacle&command=serve&command=--stdio
Sec-WebSocket-Protocol: v4.channel.k8s.io
Authorization: Bearer <token>   (or client-cert TLS; see §4)
```

Framing: every WS binary message is prefixed by **one channel byte** —
`0`=stdin, `1`=stdout, `2`=stderr, `3`=error, `4`=resize. We send RPC frames on
channel 0 and read them on channel 1; channel 2 (stderr) is surfaced to the
local log; channel 3 carries the exec's terminal status.

- **Pod side:** a new `tentacle serve --stdio` mode wraps `process.stdin` /
  `process.stdout` as a `DuplexChannel` and binds one `Connection` — exactly
  what `cli/src/worker.ts` does with the worker port today. Frames are the same
  newline-delimited JSON used everywhere else.
- **Laptop side:** a `k8sExecChannel()` adapter presents the channel-0/1
  framing as a `DuplexChannel` for the `RpcPeer`. A small concern to handle:
  **frame re-chunking** — WS messages do not preserve JSON message boundaries,
  so the adapter buffers channel-1 bytes and splits on the newline delimiter
  (the daemon stdio path must likewise newline-delimit; the SSE/JSON framing
  helpers already exist).

Auth is kubeconfig/RBAC (§4) — **no listening socket in the pod, no token
management** of our own. The daemon process lifecycle *is* the exec: it dies
when the WS closes.

**Alternative kept in reserve:** `serve` over a `portforward` WebSocket (also
`v4.channel.k8s.io`) + the existing `connect` ws path. It reuses more F3 code but
needs a listening server in the pod + a bearer token + port-forward lifecycle.
Exec/stdio is the recommended primary.

---

## 4. Self-contained auth (kubeconfig, no kubectl)

Parse `~/.kube/config` (or `$KUBECONFIG`) as YAML, resolve `current-context` →
`{ cluster, user, namespace }` (the `--namespace` flag overrides the context's).

- **Cluster:** `server` URL + CA (`certificate-authority` / `-data`, or
  `insecure-skip-tls-verify`). Build a TLS agent that trusts that CA for both the
  REST calls and the exec WS.
- **User auth — v1 supports:**
  - **client-cert**: `client-certificate(-data)` + `client-key(-data)` → mTLS.
  - **bearer token**: `token`, or `tokenFile`.
  - **exec credential plugin** (`users[].user.exec`, e.g. `aws eks get-token`,
    `gke-gcloud-auth-plugin`, generic OIDC): run the configured plugin and read
    the `ExecCredential` JSON from stdout for the bearer token. This is **not**
    kubectl/oc — it is the cloud credential helper the user's own kubeconfig
    already points at. Documented as a dependency of *their* cluster, not of us.
- **Deferred:** interactive OIDC refresh, `auth-provider` (legacy), impersonation.

A `KubeClient` wraps: `createPod`, `getPod` (readiness poll), `deletePod`, and
`execWebSocket` — all against the resolved server + auth. REST is plain
fetch+JSON over the CA-trusting TLS; only exec needs the WS upgrade.

---

## 5. Reverse-tunnel for the model (over the existing RPC channel)

The agent loop (model-stream ⇄ tool-exec, tightly interleaved) runs **wholly in
the pod**, so the pod needs model access. Rather than a second network
connection, **multiplex model calls back over the one exec channel** we already
have:

- Add a `model/stream` request to the protocol (daemon → client), carrying a
  `ChatRequest` and streaming `StreamEvent`s back (chunked as notifications or a
  streamed response; mirrors `session/update`'s shape).
- In the pod daemon, inject a **`ProxyModelProvider`** instead of
  `OpenAIProvider`: its `stream()` issues `model/stream` over the `RpcPeer` to
  the client.
- On the laptop, the client answers `model/stream` by calling the **local**
  `OpenAIProvider` (the resolved local `baseURL`/`apiKey`) and relaying events.

Result: the secret `apiKey` and the local endpoint **never leave the laptop**;
the pod reaches the model purely through the tunnel. This is the one genuinely
new piece of protocol surface in F4.

**As built (F4.d + F4.d.2).** Two methods, chosen per connection:
`model/streamChunked` (streaming: the laptop sends the events as generic
`$/progress { id, seq, value }` notifications tied to the request id — `value`
a batch of wire events, coalesced by a leading-edge 30 ms throttle with a
64 Ki-char cap — and replies `{ chunks }`, the frame count the daemon checks)
and `model/stream` (the first cut's single batch, kept for old peers; a
`MethodNotFound` probe latches the fallback). `AbortSignal` maps onto the
generic `$/cancelRequest { id }`: the daemon's request is cancelled, the
laptop's per-request signal aborts the local provider. A local provider error
reaches the pod opaque (`"internal error"`); a disconnect aborts the laptop
model. Design + evidence: `docs/fix/pod-model-streaming.md`.

**Config bootstrap** mirrors the worker: the laptop sends the **locally-resolved
`TentacleConfig`** as the first frame, but with the model section replaced by the
proxy marker — "in base alle config salvate localmente" is literal, minus the
secret, which stays home behind the tunnel.

---

## 6. Pod lifecycle & workspace

`run` drives an **ephemeral sandbox** by default:

1. Resolve kubeconfig + namespace (`--namespace` defaults to the context's);
   render a Pod from a config template (§7).
2. `createPod` → poll `getPod` for `Ready` (spinner; image pull can be slow;
   bounded timeout → clean error, no silent hang). A **missing namespace**
   fails the pod create with a 404, which `startPodRuntime` translates into an
   actionable error ("create it … or pass --namespace <existing>") — the
   namespace is deliberately NOT auto-created (it is admin-ish, often not
   allowed by RBAC, and a sign the context is stale).
3. Open the exec WS → handshake the `RemoteClient` → hand the TUI a
   `LocalRuntime`.
4. On exit (`dispose`): close the WS and **`deletePod`** (ephemeral) — tie the
   delete to process exit + SIGINT/SIGTERM, reusing the terminal-restore
   signal-safety pattern.

**Attach mode (`exec`, F4.g):** the same flow against a pod that already
exists — no create, and **no delete at all**. `startExecRuntime` does
`getPod` (missing → actionable error; terminal phase → reject) → a bounded
readiness wait → the F4.e injection **only if a preflight `tentacle
--version` shows the pod lacks it** (re-attach is a sub-second probe, no
binary transfer) → the same daemon exec + runtime. Because the pod is
user-owned, `dispose` only closes the exec channel (the pod daemon dies with
the exec) and **no exit safety net is registered**: closing the TUI detaches
and leaves the pod `Running` for reuse; the owner deletes it. See
`docs/feat/pod-exec-attach.md`.

**Workspace (the decision to make per use-case):** v1 uses `git clone` in an
init step (or an image that already contains the repo); results leave via git /
PR, not file-sync. PVC mount and local→pod sync are later options. The pod's
`cwd` = the cloned workspace = what `HostExecution` confines tools to.

---

## 7. Config shape

A new optional `pod` block in `config.jsonc` (same layered env > file > default
mechanism as the rest):

```jsonc
"pod": {
  "namespace": "dev",            // --namespace overrides
  "image": "registry/tentacle:latest",
  "workspace": { "git": "https://…/repo.git", "ref": "main" },
  "resources": { "cpu": "1", "memory": "2Gi" },
  "securityContext": { "runAsNonRoot": true, "readOnlyRootFilesystem": true },
  "serviceAccount": "tentacle",
  "ttlSeconds": 3600             // safety auto-delete
}
```

Env: `TENTACLE_POD_NAMESPACE`, `TENTACLE_POD_IMAGE`, … The model section is **not**
sent to the pod (reverse-tunnel, §5).

---

## 8. Execution plan (slices, each shippable green)

- **F4.a — `KubeClient` REST** — ✅ **done (2026-10-14)**, in `@tentacle/k8s`
  (`client.ts` + `types.ts`): `createPod`/`getPod`/`deletePod` + `waitForReady`
  (polls, rejects on a terminal phase or timeout) + `podIsReady`, bearer-token
  auth, injectable `fetch`. Unit-tested against a mock API server
  (`k8s/test/client.test.ts`), like `cli/test/main.test.ts`.
- **F4.a.2 — kubeconfig + TLS auth** — ✅ **done (2026-10-14).** `kubeconfig.ts`
  (pure: `parseKubeconfig` via the `yaml` dep + `resolveContext` → server,
  namespace, CA, and credential — bearer/client-cert/exec-plugin — decoding
  `-data` fields, leaving file paths for the I/O layer). `kube-auth.ts`
  (`loadKubeClientOptions`: reads `~/.kube/config` or `$KUBECONFIG`, materialises
  file/exec-plugin creds, and builds `fetch`/`makeWebSocket` carrying the cluster
  TLS via Bun's per-call `tls: { ca, cert, key, rejectUnauthorized }`). `main.ts`
  `run` now resolves from the kubeconfig by default (`--namespace` overrides;
  `TENTACLE_K8S_SERVER`/`_TOKEN` is an explicit override). Pure parser unit-tested
  (`k8s/test/kubeconfig.test.ts`); the full path **validated LIVE from a real kind
  kubeconfig with client-cert mTLS** — Bun honours `tls.{ca,cert,key}` on both
  `fetch` AND `WebSocket`, so the earlier `NODE_EXTRA_CA_CERTS` workaround is
  unnecessary. **Deferred:** `$KUBECONFIG` path-list merging (first entry only),
  interactive OIDC refresh, `auth-provider` (legacy), impersonation.
- **F4.b — exec WS channel + `serve --stdio`** — ✅ **done (2026-10-14).**
  `transport/stream-channel.ts` (`streamChannel`: a newline-delimited
  `DuplexChannel` over a byte-stream pair) + `serve --stdio` (`startStdioDaemon`
  binds a `Connection` over `process.stdin`/`stdout`; logs to stderr since stdout
  is the RPC channel). In `@tentacle/k8s`: `exec-frame.ts` (pure
  `encodeStdin` + `ExecDemux` channel-byte routing & newline re-chunk),
  `exec-channel.ts` (`execChannel` over a `WebSocketLike`, plus pure `buildExecUrl`
  https→wss and `execSubprotocols` with the bearer-token subprotocol), and
  `KubeClient.openExec`. Tests: stream-channel round-trip incl. a real `RpcPeer`
  handshake over newline framing, demux re-chunking, exec channel over a fake WS,
  URL/subprotocol builders, `openExec` wiring. **Validated LIVE** against a real
  apiserver (kind) by the opt-in `k8s/test/integration.live.test.ts` (skipped
  unless `TENTACLE_K8S_SERVER` is set): REST create/ready/delete over TLS + an
  exec round-trip through `cat` over `v4.channel.k8s.io` with bearer-token auth.
  Finding for F4.a.2: **Bun honours `NODE_EXTRA_CA_CERTS` for both `fetch` and
  `WebSocket`**, so trusting the cluster CA is a matter of pointing it at the
  parsed CA file (bearer-token auth already works end-to-end). **Still not
  covered:** `serve --stdio` end-to-end against a spawned process.
- **F4.c — `startPodRuntime` + `run`/`--namespace`/`--image` + pod lifecycle**
  — ✅ **done (2026-10-14; renamed `--pod` → `run` in 2026-10-15).** `k8s/pod.ts` `buildPodManifest` (keepalive
  container on the given image; the daemon is `exec`-ed in). `cli/pod-runtime.ts`
  `startPodRuntime` (create → waitForReady → `openExec(serve --stdio)` →
  `createLocalRuntime`; `dispose` closes the channel and deletes the pod; any
  pre-ready failure deletes the pod and rethrows — no in-process fallback).
  `main.ts` `run` branch: `--namespace` (default the kubeconfig context's),
  `--image` (required), an optional positional pod `<name>` (else random),
  persistence on the laptop, same TUI/permissions/auto-wake as local.
  Tested end-to-end over an in-memory channel wired to a real `Connection`
  (create/ready/exec/turn/persist/dispose/delete) + cleanup-on-failure +
  `buildPodManifest`. **Cluster auth is a stopgap:** `TENTACLE_K8S_SERVER` +
  `TENTACLE_K8S_TOKEN` env (kubeconfig auto-resolution is F4.a.2); no `pod` config
  block yet (flags/env only).
- **F4.d — reverse-tunnel model proxy** — ✅ **done (2026-10-14), non-streaming
  first cut.** Protocol: `model.ts` wire schemas (ChatRequest/StreamEvent) + the
  `model/stream` request. Daemon: `ProxyModelProvider` (tunnels each model call
  to the client) + `Connection.requestModelStream`; `serve --stdio --model-proxy`
  wires it (provider set after the Connection; the agent is built lazily on
  `session/new`, so the binding is ready). Client: `RemoteClient` serves
  `model/stream` by running the LOCAL provider and returning the turn's events;
  `createLocalRuntime` accepts a `modelProvider`, `startPodRuntime` passes the
  local `OpenAIProvider` and execs `serve --stdio --model-proxy`. So the endpoint
  + API key never leave the laptop. Round-trip tested in-memory
  (`cli/test/model-proxy.test.ts`). **Limitations (follow-ups):** the client
  returns the whole turn in one batch — **no token-by-token streaming over the
  tunnel** (the laptop TUI sees each model turn arrive at once) — and **no
  mid-call cancel** of a tunnelled model request (turn-level cancel between calls
  still works). Both are F4.d.2.
- **F4.d.2 — streaming + cancellable model tunnel** — ✅ **done (2026-10-18).**
  `model/streamChunked` + the generic peer primitives `$/progress` /
  `$/cancelRequest` (see §5 *As built*); `model/stream` kept for version skew.
  Measured on kind: first token in the TUI 0.22 s (was 47 s), Esc stops the
  laptop model in the same millisecond. Doc: `docs/fix/pod-model-streaming.md`.
- **F4.e — pod binary injection** — ✅ **done (2026-10-15).** The pod image
  no longer needs to contain `tentacle`: the runtime injects a Linux
  binary over the exec WebSocket before the daemon starts. Sequence (in
  `startPodRuntime`, after the pod is Ready): (1) `uname -m` arch probe —
  ANY failure/unknown output falls back to `bun-linux-x64` (never aborts);
  (2) resolve the binary's bytes on the laptop: `TENTACLE_POD_BIN` (explicit
  prebuilt) → the git-ignored `dist/pod-bin/tentacle-<target>` cache →
  `Bun.build` cross-compile with the SAME options as `bun run compile`
  (shared `buildBinary`, so the two never drift); (3) stream the raw bytes
  to the pod's stdin through a one-shot exec (`k8s/exec-run.ts`, resolves on
  the k8s status channel when the command EXITS — 256 KB chunks, buffer
  until the socket opens, size-scaled timeout, progress: a `docker pull`-style
  bar in the TTY single-line, or a discrete line per ~10% when piped):
  `sh -c "mkdir -p /usr/local/bin && head -c N > /usr/local/bin/tentacle
  && chmod 755 …"` — `head -c N` reads exactly N bytes and exits, so the
  known byte count IS the EOF (no tar, no terminator); (4) verify with
  `tentacle --version` (the new flag, exits before config load), which
  catches a wrong-arch / bad-libc / broken binary with the pod's stderr
  instead of an opaque channel close — a musl loader failure gets an
  appended "use a glibc-based image" hint. Any step throws → the existing
  `catch` deletes the pod. **Image constraint (decided, not avoidable):**
  Bun's compiled binary is always dynamically glibc-linked (needs
  `libc.so.6`, `libdl.so.2`, …; max `GLIBC_2.17`) and Bun has no musl or
  static target — so the image must be a Linux **glibc** image with
  `sh` + `head` (UBI9/Debian/RHEL/Amazon Linux OK; Alpine/busybox = musl →
  NO, and the `--version` probe fails cleanly with the hint). Validated
  LIVE on an x86_64 cluster: UBI9 full success (89 MB transfer 10%→100% +
  daemon in pod), busybox clean failure at the probe. Detail + as-built log:
  `docs/feat/pod-binary-injection.md`.
- **F4.f — exec-plugin auth + hardening** (credential-plugin, CA edge cases,
  timeouts, clear errors) + operator docs.
- **F4.g — `exec` attach to an existing pod** — ✅ **shipped (branch
  `feat/pod-exec-attach`)**. `tentacle attach <pod> [--namespace <ns>]
  [--container <c>] [--resume [uid]]` attaches the local TUI to a pod that
  already exists — the `run` flow minus the lifecycle. `startExecRuntime`
  (`cli/src/pod-runtime.ts`) is `startPodRuntime` with the create/delete
  removed: `getPod` (404 → actionable "use `run` to create one"; a terminal
  phase → "cannot attach") → a BOUNDED readiness wait (60 s — an attach, not a
  create) → a **preflight `tentacle --version`** that skips the whole
  injection when the pod already has a working binary (re-attach is
  sub-second; no 89 MB transfer), else the full F4.e `injectAgentBinary` →
  the same daemon exec + reverse-tunnel + persisting runtime. The pod is
  USER-OWNED: `dispose` only closes the exec channel (the pod-side daemon dies
  with it) and NO exit safety net is registered, so closing the TUI detaches
  but leaves the pod `Running` for reuse; cleanup is the owner's
  (`kubectl delete pod`). Plan + as-built: `docs/feat/pod-exec-attach.md`.

MVP = **F4.a–F4.e**. F4.f is hardening.

## 9. Open risks

- **Exec WS robustness:** idle timeouts, half-closed streams, and the channel-3
  error frame must be handled; the re-chunking buffer is the subtle bit.
- **Model latency over the tunnel:** every token round-trips laptop↔pod; fine on
  a LAN, noticeable across a slow link. Acceptable for v1.
- **No reconnect:** a dropped exec kills the session (the `seq` replay buffer is
  there, but reconnect wiring is deferred, same as F3.f).
- **Auth-plugin sprawl:** cloud kubeconfigs vary; v1 covers the common cases and
  fails loudly on the rest.
