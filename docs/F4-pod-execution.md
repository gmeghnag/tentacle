# F4 — Pod Execution: Architecture & Design

Status: **proposed (no code yet)** as of 2026-10-14. This document captures the
design so a later session can execute it directly. It builds on F3
(`docs/F3-remote-control.md`) and reuses **the entire client/daemon/RPC stack
unchanged** — F4 is a new *transport + lifecycle + reverse-tunnel*, not new
protocol design above the wire vocabulary.

---

## 1. Goal & scope

**Goal:** `agent-harness --pod --namespace <ns>` runs the agent **inside a
Kubernetes pod** (the sandbox), driven from the **local TUI on the laptop**.
The user types locally; the agent loop, tool execution, `/loop`, background
jobs, MCP servers — everything — run in the pod. Streaming UX, permission
prompts, and session persistence are identical to the local experience.

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
    ?container=<c>&stdin=true&stdout=true&stderr=true&command=agent-harness&command=serve&command=--stdio
Sec-WebSocket-Protocol: v4.channel.k8s.io
Authorization: Bearer <token>   (or client-cert TLS; see §4)
```

Framing: every WS binary message is prefixed by **one channel byte** —
`0`=stdin, `1`=stdout, `2`=stderr, `3`=error, `4`=resize. We send RPC frames on
channel 0 and read them on channel 1; channel 2 (stderr) is surfaced to the
local log; channel 3 carries the exec's terminal status.

- **Pod side:** a new `agent-harness serve --stdio` mode wraps `process.stdin` /
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
the pod reaches the model purely through the tunnel. `AbortSignal` maps onto a
`model/cancel` notification. This is the one genuinely new piece of protocol
surface in F4.

**Config bootstrap** mirrors the worker: the laptop sends the **locally-resolved
`HarnessConfig`** as the first frame, but with the model section replaced by the
proxy marker — "in base alle config salvate localmente" is literal, minus the
secret, which stays home behind the tunnel.

---

## 6. Pod lifecycle & workspace

`--pod` drives an **ephemeral sandbox** by default:

1. Resolve kubeconfig + namespace; render a Pod from a config template (§7).
2. `createPod` → poll `getPod` for `Ready` (spinner; image pull can be slow;
   bounded timeout → clean error, no silent hang).
3. Open the exec WS → handshake the `RemoteClient` → hand the TUI a
   `LocalRuntime`.
4. On exit (`dispose`): close the WS and **`deletePod`** (ephemeral) — tie the
   delete to process exit + SIGINT/SIGTERM, reusing the terminal-restore
   signal-safety pattern.

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
  "image": "registry/agent-harness:latest",
  "workspace": { "git": "https://…/repo.git", "ref": "main" },
  "resources": { "cpu": "1", "memory": "2Gi" },
  "securityContext": { "runAsNonRoot": true, "readOnlyRootFilesystem": true },
  "serviceAccount": "agent-harness",
  "ttlSeconds": 3600             // safety auto-delete
}
```

Env: `HARNESS_POD_NAMESPACE`, `HARNESS_POD_IMAGE`, … The model section is **not**
sent to the pod (reverse-tunnel, §5).

---

## 8. Execution plan (slices, each shippable green)

- **F4.a — `KubeClient` REST** — ✅ **done (2026-10-14)**, in `@agent-harness/k8s`
  (`client.ts` + `types.ts`): `createPod`/`getPod`/`deletePod` + `waitForReady`
  (polls, rejects on a terminal phase or timeout) + `podIsReady`, bearer-token
  auth, injectable `fetch`. Unit-tested against a mock API server
  (`k8s/test/client.test.ts`), like `cli/test/main.test.ts`.
  **Still to do in this slice:** kubeconfig parsing (needs a YAML dep) + TLS/CA +
  client-cert/exec-plugin auth — split out as **F4.a.2** so the REST layer could
  land dependency-free and green first.
- **F4.b — exec WS channel + `serve --stdio`** — ✅ **done (2026-10-14).**
  `transport/stream-channel.ts` (`streamChannel`: a newline-delimited
  `DuplexChannel` over a byte-stream pair) + `serve --stdio` (`startStdioDaemon`
  binds a `Connection` over `process.stdin`/`stdout`; logs to stderr since stdout
  is the RPC channel). In `@agent-harness/k8s`: `exec-frame.ts` (pure
  `encodeStdin` + `ExecDemux` channel-byte routing & newline re-chunk),
  `exec-channel.ts` (`execChannel` over a `WebSocketLike`, plus pure `buildExecUrl`
  https→wss and `execSubprotocols` with the bearer-token subprotocol), and
  `KubeClient.openExec`. Tests: stream-channel round-trip incl. a real `RpcPeer`
  handshake over newline framing, demux re-chunking, exec channel over a fake WS,
  URL/subprotocol builders, `openExec` wiring. **Validated LIVE** against a real
  apiserver (kind) by the opt-in `k8s/test/integration.live.test.ts` (skipped
  unless `HARNESS_K8S_SERVER` is set): REST create/ready/delete over TLS + an
  exec round-trip through `cat` over `v4.channel.k8s.io` with bearer-token auth.
  Finding for F4.a.2: **Bun honours `NODE_EXTRA_CA_CERTS` for both `fetch` and
  `WebSocket`**, so trusting the cluster CA is a matter of pointing it at the
  parsed CA file (bearer-token auth already works end-to-end). **Still not
  covered:** `serve --stdio` end-to-end against a spawned process.
- **F4.c — `startPodRuntime` + `--pod`/`--namespace`/`--image` + pod lifecycle**
  — ✅ **done (2026-10-14).** `k8s/pod.ts` `buildPodManifest` (keepalive
  container on the given image; the daemon is `exec`-ed in). `cli/pod-runtime.ts`
  `startPodRuntime` (create → waitForReady → `openExec(serve --stdio)` →
  `createLocalRuntime`; `dispose` closes the channel and deletes the pod; any
  pre-ready failure deletes the pod and rethrows — no in-process fallback).
  `main.ts` `--pod` branch: `--namespace` (default `default`), `--image`
  (required), persistence on the laptop, same TUI/permissions/auto-wake as local.
  Tested end-to-end over an in-memory channel wired to a real `Connection`
  (create/ready/exec/turn/persist/dispose/delete) + cleanup-on-failure +
  `buildPodManifest`. **Cluster auth is a stopgap:** `HARNESS_K8S_SERVER` +
  `HARNESS_K8S_TOKEN` env (kubeconfig auto-resolution is F4.a.2); no `pod` config
  block yet (flags/env only).
- **F4.d — reverse-tunnel model proxy** (`model/stream` protocol +
  `ProxyModelProvider` + client relay). The one new protocol slice; test the
  proxy round-trip in-memory first (no k8s needed).
- **F4.e — exec-plugin auth + hardening** (credential-plugin, CA edge cases,
  timeouts, clear errors) + operator docs.

MVP = **F4.a–F4.d**. F4.e is hardening.

## 9. Open risks

- **Exec WS robustness:** idle timeouts, half-closed streams, and the channel-3
  error frame must be handled; the re-chunking buffer is the subtle bit.
- **Model latency over the tunnel:** every token round-trips laptop↔pod; fine on
  a LAN, noticeable across a slow link. Acceptable for v1.
- **No reconnect:** a dropped exec kills the session (the `seq` replay buffer is
  there, but reconnect wiring is deferred, same as F3.f).
- **Auth-plugin sprawl:** cloud kubeconfigs vary; v1 covers the common cases and
  fails loudly on the rest.
