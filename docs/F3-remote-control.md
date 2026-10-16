# F3 — Remote Control: Architecture & Design

Status: **implemented (core slices)** as of 2026-10-12. Shipped: F3.a transport
(`@tentacle/transport` — `RpcPeer` + in-memory channel), F3.b daemon core
(`@tentacle/daemon` — `SessionHost`/`HostedSession`/`Connection` + event &
permission mapping), F3.c WebSocket binding (`startWsServer` over `Bun.serve` +
a real-socket smoke test), F3.d client (`@tentacle/client` — `RemoteClient`/
`RemoteSession`, reused by the Ink `App` behind a `SessionController` interface)
and the `serve`/`connect` CLI, F3.e security (bearer-token auth, loopback-safe
bind refusal, Origin allow-list, server-side confinement/permissions), and the
F3.g protocol additions (`agent_usage`, `seq`, `max_iterations` stop reason,
diff-as-`resource` content). **Deferred:** F3.f reliability beyond the seq
replay buffer (heartbeat/idle-timeout/graceful-shutdown/reconnect wiring),
multi-client observers/fan-out, the `config.jsonc` `remote` block, TLS is coded
(`--tls-cert/--tls-key`) but only manually exercised, and F3.h operator docs.

This document is the implementation plan for F3. It builds on the locked decisions in `ARCHITECTURE.md` (ADR-002: WebSocket +
JSON-RPC 2.0 with an ACP-shaped vocabulary) and on the already-shipped
`@tentacle/protocol` package, which **already defines the entire wire
vocabulary** we need. F3 is therefore mostly *transport + daemon + client +
hardening*, not new protocol design.

---

## 1. Goal & scope

**Goal:** pilot a headless agent running on one machine ("the host") from a
client running somewhere else — another terminal, another machine on the LAN, or
across the internet — with the *same* streaming UX as the local TUI (live text,
reasoning, tool calls/diffs, token meter, and interactive permission prompts).

**In scope (F3):**
- A long-lived **daemon** that hosts `Agent`/`Session` instances and serves the
  JSON-RPC-over-WebSocket control channel.
- A **client runtime** that speaks the same protocol, plus a `connect` mode for
  the existing Ink TUI so it renders a *remote* session identically to a local one.
- **Auth, TLS, and bind/exposure controls** for local, LAN, and public use.
- **Reliability**: heartbeats, idle timeouts, reconnect, and turn-scoped
  resume/replay.
- **Multi-session / multi-client** hosting on one daemon.

**Non-goals (deferred):**
- Multi-tenant SaaS, user accounts/orgs, billing. (Single operator, token auth.)
- A hosted relay service we operate. (The daemon *is* the server; see §4.)
- Persistence of transcripts to a database (F4 covers session persistence).
- The browser client UI. (Protocol is browser-ready; a web client is post-F3.)

---

## 2. Requirements

### 2.1 Functional
1. Start a daemon: `tentacle serve [--host H] [--port P]`.
2. Connect a client: `tentacle connect <url> [--token T]` → full TUI.
3. Handshake negotiates `PROTOCOL_VERSION`; incompatible majors are refused.
4. Create/attach sessions; submit prompts; receive streamed updates; cancel a turn.
5. Interactive permission prompts round-trip to the connected client.
6. One daemon serves many sessions and many simultaneous clients.
7. Workspace write-confinement and the permission engine are enforced
   **server-side** (a client can never bypass them).

### 2.2 Non-functional
- **Performance:** streaming adds negligible latency over local; per-update
  overhead dominated by the network, not our code. Coalesce chunks to ~30–60 fps;
  avoid head-of-line stalls; backpressure-aware writes.
- **Efficiency:** one WebSocket per client (multiplex all sessions over it);
  `permessage-deflate` for text-heavy streams; no busy polling; O(1) routing.
- **Security:** no unauthenticated code execution. Loopback-only by default;
  explicit opt-in for LAN/public; TLS + bearer token for anything non-loopback;
  `Origin`/`Host` checks; secrets never crossing the wire.
- **Reliability:** survive transient disconnects without losing an in-flight
  turn; detect dead peers within seconds (ping/pong); clean shutdown drains turns.
- **Observability:** structured logs, basic counters, an audit line per tool
  authorization and per shell command.

---

## 3. Do we need a public endpoint / a server?

**The daemon is the server.** There is no required third-party service. Three
deployment tiers, in increasing exposure:

| Tier | Bind | Transport | Auth | Use |
|------|------|-----------|------|-----|
| **Local** (default) | `127.0.0.1` | `ws://` | token optional | another terminal / IDE on the same box |
| **LAN** | `0.0.0.0` or a specific NIC | `ws://` or `wss://` | **token required** | your laptop → the homelab box (e.g. `192.168.1.17`) |
| **Public** | behind a reverse proxy | `wss://` only | **token required + TLS** | access from the internet |

**Reaching a daemon from the public internet — pick one, no app changes needed:**
- **Reverse proxy + TLS** (recommended for a fixed host): Caddy/nginx terminates
  TLS on `wss://agent.example.com` and proxies to the loopback daemon. Caddy gives
  automatic Let's Encrypt certs. The daemon still binds loopback; only the proxy is
  exposed.
- **Tunnel** (no open ports / dynamic IP): `cloudflared` or a Tailscale/`tailscale
  serve` tunnel maps a public/overlay hostname to the loopback daemon. Best for a
  homelab behind NAT; Tailscale also gives identity-based access control for free.
- **Direct TLS** (self-contained): the daemon serves `wss://` itself from a
  provided cert/key (`--tls-cert`, `--tls-key`). Useful when no proxy is wanted.

**Recommendation:** ship the daemon as **loopback `ws://` by default**, support
`--host`/`--tls-*`/`--token`, and *document* the Caddy and Tailscale recipes
rather than building our own relay. This keeps the attack surface minimal and
defers nothing we'd regret.

---

## 4. Component architecture

New packages (all depend on the existing `@tentacle/protocol`):

```
          ┌────────────────────────── host machine ──────────────────────────┐
          │                                                                   │
client ── WS ──▶  @tentacle/daemon                                        │
          │        ├─ WsServer (Bun.serve websocket)                           │
          │        ├─ Connection  (one per socket)                            │
          │        │    └─ RpcPeer (framing/validation/correlation)  ◀── shared│
          │        ├─ Auth (token/TLS/origin)                                  │
          │        └─ SessionHost                                              │
          │             └─ map<sessionId, HostedSession>                       │
          │                   ├─ Agent + Session   (existing @tentacle/agent)
          │                   ├─ HostExecution(root)  (write-confined)         │
          │                   └─ RemotePermissionRequester → session/request_permission
          └───────────────────────────────────────────────────────────────────┘

@tentacle/transport   RpcPeer: JSON-RPC 2.0 request/notify/response over a
                           duplex message channel; schema-validates with the
                           protocol registries; correlates ids; used by BOTH ends.

@tentacle/client      Client runtime: connects, handshakes, exposes
                           newSession/prompt/cancel + an async stream of
                           SessionUpdate; answers session/request_permission.
                           The Ink App consumes this exactly like a local Session.
```

Key idea: **`RpcPeer` is symmetric and transport-agnostic.** It takes a
`MessageChannel` interface (`send(text)`, `onMessage`, `onClose`) so the same
peer runs over a real WebSocket in production and over an in-memory pipe in tests.
Both daemon and client embed an `RpcPeer`; only the wiring differs.

### 4.1 Why a `transport` package separate from `daemon`/`client`
The request/response correlation, id generation, schema validation against
`RequestSchemas`/`NotificationSchemas`, timeouts, and error mapping are identical
on both sides. Isolating them makes the daemon and client thin and lets us unit-
test the hard part (framing/validation/cancellation) with zero sockets.

---

## 5. Wire protocol — reuse what we have

`@tentacle/protocol` already defines, as Zod schemas with a method registry:

- Framing: `JsonRpcRequest/Notification/Response`, `JsonRpcError`, `JSONRPC_VERSION`.
- Methods (request→response): `initialize`, `session/new`, `session/prompt`,
  `session/request_permission` (agent→client).
- Notifications: `session/update` (agent→client stream), `session/cancel`.
- `RequestSchemas`/`NotificationSchemas` + `isMethodName`/`isNotificationName`
  — the dispatcher validates `params` before handling and `result` before replying.
- `PROTOCOL_VERSION = 1`.

**Direction of calls:**
- Client → daemon: `initialize`, `session/new`, `session/prompt` (resolves at
  turn end with `{ stopReason }`), `session/cancel` (notification).
- Daemon → client: `session/update` (notifications, the stream) and
  `session/request_permission` (a request the client answers).

This is a **bidirectional** JSON-RPC peer: the daemon issues requests to the
client (for permissions), so `RpcPeer` must handle inbound *and* outbound requests
on the same socket. The existing schemas already anticipate this.

### 5.1 Gaps to close in `protocol` (small, additive)
These surfaced from the current `agent` ↔ `protocol` mismatch; all are additive
and keep `session/update` forward-compatible (it is intentionally non-strict):

1. **Usage reporting.** `AgentEvent` emits `usage` (prompt/completion tokens) and
   the TUI shows a context meter. `SessionUpdate` has no usage member. Add an
   `agent_usage` update `{ type:"agent_usage", usage:{promptTokens, completionTokens} }`
   (optional; older clients ignore it).
2. **Stop-reason mapping.** `AgentStopReason = end_turn | cancelled | max_iterations`
   vs protocol `StopReason = end_turn | max_tokens | cancelled | error`. Map
   `max_iterations → error` (or add `max_iterations` to the enum — **ADR candidate**,
   prefer adding the value to avoid lossy mapping).
3. **Tool result detail.** `ToolResultDetail` (the unified-diff payload) must ride
   inside `ToolCallUpdate.content` as a `resource`/`text` ContentBlock (e.g. a
   `text/x-diff` resource) so remote clients can render the same git-style diff.
4. **Permission vocabulary bridge.** Local `PermissionResponse {allowed, scope}`
   maps to protocol `PermissionOption`/`PermissionOutcome`
   (`allow_once|allow_always|reject_once|reject_always`). The daemon offers the
   options; the client's selection maps back to the gate's `once`/`session`.

### 5.2 AgentEvent → SessionUpdate mapping (daemon side)
| AgentEvent | session/update |
|---|---|
| `text` | `agent_message_chunk` (text block) |
| `reasoning` | `agent_thought_chunk` (text block) |
| `tool_start` | `tool_call` (status `in_progress`, `rawInput`=args) |
| `tool_result` | `tool_call_update` (status `completed`/`failed`, content incl. diff) |
| `usage` | `agent_usage` (new, §5.1) |
| `turn_end` | resolves the pending `session/prompt` with `{stopReason}` |

---

## 6. Connection lifecycle

```
client                                   daemon
  │  (TLS handshake if wss)                │
  │  WS upgrade  Authorization: Bearer T   │  auth: verify token, Origin, Host
  │ ─────────────────────────────────────▶│  (reject → close 1008/4401 before upgrade)
  │  initialize {protocolVersion, caps}    │
  │ ─────────────────────────────────────▶│  version check → InitializeResult{caps}
  │  session/new {cwd?}                     │  create HostedSession (confined cwd)
  │ ─────────────────────────────────────▶│  → {sessionId}
  │  session/prompt {sessionId, content}   │  drive Agent.runMessages
  │ ─────────────────────────────────────▶│
  │  ◀── session/update (agent_message…)   │  stream (coalesced ~30–60fps)
  │  ◀── session/update (tool_call…)        │
  │  ◀── session/request_permission ───────│  (blocks the turn)
  │  ──▶ result {outcome: selected|cancel}  │  resolve the gate
  │  ◀── session/update (tool_call_update)  │
  │  ◀── prompt result {stopReason}         │  turn end
  │  ...                                     │
  │  session/cancel {sessionId} (notif)     │  abort the turn's AbortController
  │  ping/pong (heartbeat)                  │
```

- **Handshake must precede everything.** The dispatcher rejects any method other
  than `initialize` until initialized (JSON-RPC error, custom code).
- **Cancellation** is a notification so it isn't queued behind the in-flight
  request; the daemon aborts the session's `AbortController`.

---

## 7. Concurrency & session model

- **One daemon → many `HostedSession`s**, keyed by `sessionId`. Each owns its own
  `Agent`/`Session`, `AbortController`, and `HostExecution(root=session.cwd)`.
- **Multiplex all sessions over a single client WebSocket.** `sessionId` on every
  message routes it. No second connection per session.
- **Multiple clients:** a session has one *driver* (whoever created it) but may
  have N *observers* that receive the same `session/update` fan-out (read-only).
  Permission requests go to the **driver** only. (Observer vs driver is an
  authorization decision — **ADR candidate**; simplest v1: a session is bound to
  its creating connection and others get read-only attach.)
- **Backpressure:** if a client's socket buffer (`ws.bufferedAmount`) exceeds a
  threshold, coalesce harder / drop redundant intermediate chunks (never drop
  terminal events like `tool_call_update` or the prompt result). A slow observer
  must not stall the agent loop → per-connection outbound queue with a high-water
  mark; on overflow, disconnect the laggard rather than block the turn.

---

## 8. Performance plan

- **Chunk coalescing:** the agent emits many small `text` deltas. The daemon
  batches deltas per session on a ~16–33 ms timer into one `agent_message_chunk`
  (same idea as the TUI's 30fps throttle, but server-side so it helps every
  client). Terminal/structural events flush immediately.
- **Framing:** JSON text frames (debuggable) + `permessage-deflate` negotiated on
  the socket → big win on repetitive code/diff text. Binary frames reserved for a
  future bulk-resource transfer; not needed for v1.
- **No polling:** everything is event-driven (`Bun.serve` websocket handlers,
  async generators). Heartbeat is a timer, not a poll.
- **Allocation discipline:** reuse encoder; avoid re-validating our *own* outbound
  messages in hot paths (validate inbound always; trust constructed outbound,
  guard with tests).
- **Measure:** a `bench` that pumps N chunks through the in-memory `RpcPeer` pair
  to track per-message overhead and guard against regressions.

---

## 9. Security

Non-negotiable, because a control channel = remote code execution.

1. **Bind safe by default:** loopback only. Non-loopback bind **requires** a token
   (`--token`, or `TENTACLE_REMOTE_TOKEN`, or config). Refuse to start a
   non-loopback listener without one.
2. **Auth:** bearer token in the `Authorization` header on the WS upgrade (and a
   `?token=` fallback only for clients that can't set headers). Constant-time
   compare. Reject *before* the upgrade completes. Future: per-client tokens / mTLS.
3. **TLS:** anything beyond loopback must be `wss://` — via reverse proxy,
   tunnel, or `--tls-cert/--tls-key`. Document; warn loudly on plaintext non-loopback.
4. **Origin/Host checks:** validate `Origin` (allow-list) and `Host` to blunt
   DNS-rebinding against a browser client.
5. **Server-side enforcement:** write-confinement (`HostExecution.root`) and the
   permission engine run on the **daemon**. The client only *renders* prompts and
   *sends a choice*; it cannot execute or widen scope. A malicious client can at
   most do what the operator already granted.
6. **Secrets stay home:** the model API key lives in daemon config and never
   crosses the control channel. Tool output may contain sensitive data — that is
   the operator's existing trust boundary, unchanged by F3.
7. **Rate/again limits:** cap sessions-per-connection and prompt rate; cap frame
   size; reject oversized/un-parseable frames with a JSON-RPC error then close on
   repeat abuse.
8. **Audit:** one structured log line per `session/request_permission` outcome and
   per shell command (command, sessionId, decision, scope).

---

## 10. Reliability: heartbeats, timeouts, reconnect, resume

- **Heartbeat:** WS ping every ~15 s; miss 2 → consider dead, close, free the
  connection's sessions' observers (driver sessions enter a "detached" grace).
- **Idle timeout:** close connections with no traffic for N minutes (configurable).
- **Graceful shutdown:** stop accepting; send a `shutting_down` close code; let
  in-flight turns finish or abort cleanly; flush audit logs.
- **Reconnect + resume (turn-scoped):** on reconnect the client re-`initialize`s
  and re-attaches by `sessionId`. The daemon keeps a **bounded per-session replay
  buffer** of the current turn's `session/update`s (sequence-numbered). The client
  sends the last sequence it saw; the daemon replays the tail. Completed turns are
  not replayed (the client already has the final state / or re-fetches via a future
  `session/history` once F4 persistence lands).
  - Add a monotonically increasing `seq` to `SessionUpdateParams` (**additive**,
    forward-compatible) to make replay exact and idempotent.
- **Idempotency:** `session/prompt` carries the client-chosen request id;
  re-delivery after a flaky disconnect is detected and not double-run.

---

## 11. Error model

- **Transport/protocol errors** → JSON-RPC error responses using
  `JsonRpcErrorCode` (ParseError/InvalidRequest/MethodNotFound/InvalidParams/
  InternalError) + a small custom range for domain errors
  (`Unauthorized`, `VersionMismatch`, `UnknownSession`, `TurnInProgress`).
- **Turn errors** (model/network/tool failure) are *not* transport errors: the
  turn ends with `stopReason: "error"` and the failure is surfaced as a normal
  `session/update`/tool result, mirroring the local TUI's `failTurn`.
- Never leak stack traces or secrets in `error.data` across the wire.

---

## 12. Versioning & compatibility

- `initialize` compares `PROTOCOL_VERSION`; **refuse incompatible majors**, accept
  newer minors (capabilities negotiate the rest).
- `session/update` is intentionally **non-strict** (see `updates.ts`): new optional
  members (`agent_usage`, `seq`) are forward-compatible — old clients ignore them.
- Request params/results are `.strict()`: changing them is a version bump.

---

## 13. Observability

- Structured logs (JSON) with `sessionId`/`connId` correlation; levels gated.
- Counters: active connections/sessions, updates/s, bytes out, auth failures,
  permission allow/deny, dropped-laggard disconnects.
- Optional: an `info`/metrics endpoint on the daemon (loopback only).

---

## 14. Testing strategy

Contracts before implementations, per the project's bar:
1. **`RpcPeer` unit tests** over an in-memory channel pair: request/response
   correlation, inbound+outbound requests on one peer, timeouts, cancellation,
   invalid-frame rejection, schema validation against the registries.
2. **Daemon↔client integration** using the in-memory channel (no sockets): full
   handshake → new → prompt → streamed updates → permission round-trip → cancel,
   driven by the existing `ScriptedProvider`.
3. **Mapping tests:** `AgentEvent → SessionUpdate` and permission vocabulary both
   directions (table-driven).
4. **Security tests:** non-loopback bind refuses without token; bad token rejected
   pre-upgrade; `Origin`/`Host` rejection; frame-size cap; confinement still blocks
   writes requested remotely.
5. **Reliability tests:** heartbeat death detection; reconnect + replay-by-seq
   yields no gaps/dupes; backpressure drops only coalescible chunks.
6. **One real-socket smoke test** over `Bun.serve` loopback (the only test that
   touches a real socket) to prove the `MessageChannel` adapter.
7. **Bench** (§8) as a perf guard.

All green via `bun run check` at each sub-slice.

---

## 15. CLI surface

```
tentacle serve [--host 127.0.0.1] [--port 4000] [--token T|--token-command CMD]
                    [--tls-cert FILE --tls-key FILE] [--cwd DIR]
tentacle connect ws(s)://host:port [--token T]      # launches the TUI, remote
```
- `serve` reuses `loadConfig()` (model, confined cwd, system prompt) and adds a
  `remote` config block (host/port/token/tls/limits). Refuses unsafe binds (§9.1).
- `connect` reuses the Ink `App` unchanged: it consumes a `RemoteSession` that
  exposes the same `send()` async-iterable of display events and installs an
  interactive `PermissionRequester` wired to `session/request_permission`.

Config additions (`config.jsonc`, env > file > default):
```jsonc
"remote": {
  "host": "127.0.0.1", "port": 4000,
  "tokenCommand": "cat ~/.cache/harness-remote-token",   // never store the token in plaintext
  "allowedOrigins": ["app://local"],
  "maxSessionsPerConnection": 16, "idleTimeoutMs": 900000
}
```

---

## 16. Implementation phasing (each slice ships green)

- **F3.a — transport:** `@tentacle/transport` `RpcPeer` + in-memory channel
  + `MessageChannel` interface. Tests §14.1. *No sockets.*
- **F3.b — daemon core:** `SessionHost`, `HostedSession`, AgentEvent→update
  mapping, dispatcher over `RpcPeer`. Drive with `ScriptedProvider` over the
  in-memory channel (§14.2–3). Still no sockets.
- **F3.c — WebSocket binding:** `Bun.serve` websocket adapter → `MessageChannel`;
  loopback `ws://`; one real-socket smoke test (§14.6).
- **F3.d — client runtime + `connect`:** `@tentacle/client`, `RemoteSession`,
  wire the Ink TUI to it (local vs remote behind one interface).
- **F3.e — security:** token auth, Origin/Host, safe-bind refusal, TLS flags,
  limits, audit (§9, §14.4).
- **F3.f — reliability:** heartbeats, idle timeout, graceful shutdown,
  reconnect + replay-by-`seq` (§10, §14.5).
- **F3.g — protocol additions landed cleanly:** `agent_usage`, `seq`, stop-reason
  enum, diff-as-content — as versioned, tested schema changes (§5.1).
- **F3.h — docs:** Caddy + Tailscale recipes; threat model; operator guide.

---

## 17. Open decisions (ADR candidates)

1. **Stop-reason:** add `max_iterations` to protocol `StopReason` vs map to
   `error`. (Prefer adding — lossless.)
2. **Observers vs single-driver** per session, and whether observers can send
   prompts. (v1: single driver; read-only attach for others.)
3. **Resume depth:** turn-scoped replay only (v1) vs full history (needs F4
   persistence).
4. **Transport dep:** hand-rolled `Bun.serve` websocket (zero deps, matches
   ADR-003's "control for testability") vs a library. (Prefer hand-rolled: Bun's
   server websocket is first-class and keeps us dependency-light.)
5. **Browser client:** out of scope for F3, but keep all frames JSON/text and
   auth header-or-query so a web client needs no protocol change later.

---

## 18. Summary

The protocol layer is done and well-shaped; F3 is a disciplined build of a
symmetric JSON-RPC peer, a session-hosting daemon, and a thin client that the
existing TUI reuses. Security and confinement stay **server-side**; exposure is
opt-in and layered (loopback → LAN+token → public via proxy/tunnel/TLS). No
third-party service is required — the daemon is the server. Build it in the
slices above, each green via `bun run check`, with the hard concurrency/transport
logic tested over an in-memory channel so almost nothing depends on real sockets.
