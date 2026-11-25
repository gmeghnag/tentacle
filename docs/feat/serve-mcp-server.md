# feat/serve-mcp-server — `tentacle serve` exposes an MCP server

> **Status:** implementation — **NOT approved** (owner questions below)
> **Branch:** `feat/serve-mcp-server`
> **Size:** L → slices (only slice 1 planned in full, the rest a ranked backlog) · **Blast:** load-bearing for S1a/S1c (a second external session entry: AGENTS §7 "a remote caller is not trusted", single session path, single broker); contained for S1b · **Suited:** Opus plans; per sub-slice Sonnet (pure, cheap to iterate) or Opus (touches §7); mandatory fresh-context Opus review
> **Changelog:** `changelog.d/serve-mcp-server.added.md` — "**`serve` is an MCP server.** Claude Code (or any MCP client) can start a tentacle session on your serve, steer it, read its status and result, and cancel it — with a dedicated MCP token; your phone still answers its approvals."

## Context

*— claude-opus-5-5, 2026-11-25*

Owner 2026-11-25 ~11:00 (TODO `feat/serve-mcp-server`): «pezzo-pezzo partendo
dalle cose più necessarie». `tentacle serve` should EXPOSE an MCP server so
Claude Code (or any MCP client) can drive tentacle: start/steer a session
(DeepSeek, …), read its status and events, run a workflow, push a notification
to the phone. Today tentacle is only an MCP **client** (`packages/mcp/`,
`docs/feat/serve-mcp.md`).

**The need, ranked.** The use case that pays first is *delegation*: Claude Code
hands a piece of work to a tentacle session on the owner's serve (cheaper model,
the project's tools, visible on the phone), goes on, and later reads the
result. That needs exactly four verbs — start, send (steer), status (+ result),
cancel — plus "which of my sessions exist". Everything else (answering asks from
Claude Code, a push to the phone, workflows, a full event feed, the owner's own
sessions, MCP tasks) is additive on top of those and is ranked in the backlog.

**Constraints that shape it:**

- **feat/a2a** (on its own branch, mid-execution; `git show
  feat/a2a:docs/feat/a2a.md`) adds the same kind of thing for A2A: a
  dedicated-token external entry on `serve` (`a2a/http.ts` hooked into
  `ws-server.ts` `fetch`, S9 — not built yet), an in-process adapter that drives
  sessions over `createChannelPair()` + a real `Connection` (S4 — not built
  yet), and the **work-units seam** (`HostedSession.workUnits()`,
  `feat/a2a:packages/daemon/src/hosted-session.ts:2567`, built in S2) with one
  state vocabulary for turns and workflow runs (`packages/core/src/work-unit.ts`,
  S0). This task REUSES all three; there must never be a second external-entry
  path or a second "unit of work with a state" (owner's A2A addendum: «cerchiamo
  di deduplicare e tenere pulito e uniforme»).
- **feat/subagent-harness-runners** is the reverse direction (tentacle drives
  Claude Code). Nothing here is shared with it except the vocabulary: a remote
  harness's run is a work unit too.
- **One serve = one project, one model config** (`docs/feat/serve-mcp.md`
  "One fact shapes the whole plan"; `SessionSettingsSchema` has no model field,
  `packages/protocol/src/session.ts:1560-1579`). "Start a DeepSeek session" =
  call the serve that runs the DeepSeek profile. A per-session model is out of
  scope (backlog B9).

**MCP spec facts (read 2026-11-25, `latest` = 2026-07-28):**

- Streamable HTTP, revision 2026-07-28
  (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md):
  ONE endpoint, POST only; `Accept: application/json, text/event-stream`; the
  server answers a request with `application/json` OR `text/event-stream`; a
  notification POST → `202`; **no GET stream, no `Mcp-Session-Id`, no
  resumability** (GET/DELETE → `405`); headers `MCP-Protocol-Version` (must
  match `_meta`), `Mcp-Method`, `Mcp-Name`; servers MUST validate `Origin`
  (invalid → `403`), SHOULD bind localhost, SHOULD authenticate; a client
  disconnect IS the cancellation of that request; the server MUST NOT send
  independent requests on a response stream.
- **Versioning** (`…/2026-07-28/basic/versioning.md`): no `initialize`
  handshake; `server/discover` MUST be implemented; the version rides
  `_meta["io.modelcontextprotocol/protocolVersion"]` per request; unsupported →
  `-32022` with `data.supported`. A **dual-era** server answers `initialize`
  (legacy: `2025-11-25` and earlier) AND the per-request modern form, picking
  the era per request; a modern-only server FAILS legacy clients.
- **Authorization is OPTIONAL** (`…/latest/basic/authorization`); if done it is
  OAuth 2.1 + RFC 9728 metadata. Static bearer tokens are not addressed by the
  spec; Claude Code supports them directly:
  `claude mcp add --transport http <name> <url> --header "Authorization: Bearer <t>"`
  (https://code.claude.com/docs/en/mcp).
- **Progress**: `params._meta.progressToken` → `notifications/progress
  {progressToken, progress, total?, message?}` on that request's own response
  stream, `progress` strictly increasing.
- **Tasks** are an **extension** (`io.modelcontextprotocol/tasks`,
  github.com/modelcontextprotocol/ext-tasks), states `working |
  input_required | completed | failed | cancelled` — the same shape as our
  `WorkUnitState`. Claude Code documents support on 2026-07-28 (v2.1.304+).
- **Elicitation** is no longer a server push: a `tools/call` result
  `resultType:"input_required"` + `inputRequests`, the client retries (MRTR).
- **Claude Code client limits** (code.claude.com/docs/en/mcp): a call with **no
  response and no progress for 5 min (HTTP)** is aborted
  (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`); calls over 2 min in the main
  conversation move to a background task; tool output capped at 25 000 tokens
  (`MAX_MCP_OUTPUT_TOKENS`). Its runtime is on MCP TypeScript SDK 2.0
  (2026-07-28).

**Repro (2026-11-25, Bun 1.4.3)** — `.tentacle/tmp/serve-mcp-server/repro.ts`:
a real `startWsServer` with a token, an MCP `initialize` POSTed to `/mcp`:

```ts
import { SessionHost } from "../../worktrees/serve-mcp-server/packages/daemon/src/session-host.ts";
import { startWsServer } from "../../worktrees/serve-mcp-server/packages/daemon/src/ws-server.ts";
const host = new SessionHost({ defaultCwd: "/tmp/x", createAgent: () => { throw new Error("no agent"); } } as never);
const srv = startWsServer({ host: "127.0.0.1", port: 0, sessionHost: host, token: "t" });
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "0" } } });
for (const auth of ["", "Bearer t"]) {
  const r = await fetch(`http://127.0.0.1:${srv.port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) }, body });
  console.log(`POST /mcp ${auth ? "with token" : "no token"} → ${r.status} ${await r.text()}`);
}
srv.stop();
```

```
POST /mcp no token → 401 unauthorized
POST /mcp with token → 426 expected a websocket upgrade
```

Every non-upgrade request is 401/426 (`packages/daemon/src/ws-server.ts:371-378`):
`serve` has no MCP endpoint.

## Implementation

*— claude-opus-5-5, 2026-11-25*

### Load-bearing assumption

**An in-process client — a real `Connection` on one end of
`createChannelPair()` — drives the SAME `SessionHost` a phone does, and its
session is listed to, answerable by and cancellable from the owner's phone with
no new daemon path.** Already PROVED for A2A by `.tentacle/tmp/a2a/seam.ts`
(`feat/a2a:docs/feat/a2a.md`, Load-bearing assumption, re-run green before
S0–S3). The MCP adapter is the same construction with a different HTTP face, so
it inherits the proof; the S1c executor re-runs `seam.ts` first, and S1c's own
test pins it for an MCP-created session (phone answers the ask, phone cancels).

The second assumption, specific to MCP: **one stateless POST per tool call is
enough for every slice-1 tool** — none needs a server→client request mid-call
(no elicitation, no sampling). True by design below: start/send/cancel are acks
(`session/prompt` resolves at acceptance, `PromptResultSchema`,
`packages/protocol/src/session.ts:527-533`), status is a bounded read.

### Preconditions

- **One session path.** A socket is `new Connection(channel, sessionHost, …)`
  (`ws-server.ts:391-399`); `createChannelPair()` gives the in-process pair
  (`packages/transport/src/channel.ts:77`). Every verb the MCP tools need is an
  existing method: `session/open` `session/prompt` `session/enqueue`
  `session/cancel` `session/detach` `session/list`
  (`packages/protocol/src/methods.ts:134-160,290`).
- **Steering exists and is retry-safe:** `session/enqueue{sessionId, id,
  turnId, text}` injects into the RUNNING turn at the next round boundary; `id`
  is an idempotency key and `turnId` binds it to that exact turn
  (`session.ts:1955-1976`).
- **`session/prompt` is an ack and idempotent by `turnId`** (`session.ts:527-533`):
  a retried id returns the same turn, with `ended` if it finished.
- **Asks wait for a client** when none is attached; denied at once only when a
  client IS attached and none declared `permission_request`
  (`hosted-session.ts:1652-1662`, re-checked `:1689-1702`) ⇒ the adapter
  declares `permission_request` and never answers (owner mode).
- **`askedOn`** lists only attachments with `ClientInfo.host` (`hosted-session.ts:1672-1682`)
  ⇒ the adapter sends no `host`.
- **Hooks trust** asks the prompting client (`connection.ts:1179-1195`) ⇒ the
  adapter answers `{trusted:false}` (AGENTS §7: no lasting approval from a remote).
- **Work units (feat/a2a S0+S2):** `HostedSession.workUnits()` returns the ended
  table + the running turn (`waiting:permission` when an ask is pending) + live
  runs (`feat/a2a:…/hosted-session.ts:2567`), surviving restart, compaction,
  reset, `/clear` (the `unit_end` carry). `WorkUnit.result` = the final
  round's text, ≤ 16 KiB (`core/src/work-unit.ts`, S0/S1).
- **Read-only follower exists:** `session/watch` / `watch_next` (long-poll,
  bounded queue, never an attachment, never offered an ask;
  `packages/protocol/src/watch.ts:1-23,145-190`) — the seam for the events
  feed (backlog B4), not needed in slice 1.
- **Exposure today:** `--token`/`--token-command` (`packages/cli/src/flags.ts:74,614-625`),
  `tokensMatch` constant-time (`ws-server.ts:201-208`), browser `Origin`
  default-denied (`ws-server.ts:218-223`), loopback unless a token
  (`ws-server.ts:291-295`); `serve` builds the server at
  `packages/cli/src/serve.ts:982-994`.
- **Session caps:** `DEFAULT_MAX_SESSIONS = 64`, `DEFAULT_MAX_DETACHED_SESSIONS
  = 16` (`packages/daemon/src/session-host.ts:96-97`).
- **No protocol change:** the adapter is a protocol CLIENT; `/mcp` is an HTTP
  face, not the tentacle wire ⇒ no `protocol.d/` note, no `PROTOCOL_VERSION`
  bump, no persisted-format change (sessions persist through serve's
  `SessionPersister` like any other).

### Design

```
Claude Code ─POST /mcp (Bearer MCP token)─► Bun.serve fetch (ws-server.ts)
                                             │ external/route.ts  ← ONE external entry (shared with /a2a):
                                             │   path → Origin(403) → bearer→caller(401) → 1 MiB cap(413) → audit
                                             ▼
                                         mcp/http.ts ── mcp/wire.ts (pure: JSON-RPC, dual-era, headers, schemas)
                                             │ tools/call
                                             ▼
                                         mcp/tools.ts ──► external/session-driver.ts (shared with A2A executor):
                                             │              createChannelPair + Connection + RpcPeer, own namespace,
                                             │              hooks false, asks never answered (owner mode), detach at end
                                             │ status: host.get(id).workUnits()  (read-only seam, feat/a2a S2)
                                             ▼
                                         SessionHost ── HostedSession ── phone/TUI see the same session
```

**1. One external entry, two mounts (prerequisite, S1a).** A2A's plan hooks
`a2a.handle(req)` into `fetch` before `authorize` (a2a.md Files 11–12). MCP must
not add a sibling hook. The entry is a protocol-neutral module,
`packages/daemon/src/external/route.ts`:

```ts
interface ExternalCaller { name: string /* [A-Za-z0-9_]{1,32} */; token: string; asks: "owner" | "both"; workflows: boolean }
interface ExternalMount { path: string /* "/a2a", "/mcp" */; public?: (req) => Response | undefined /* the agent card */;
                          callers: readonly ExternalCaller[]; handle(req: Request, caller: ExternalCaller): Promise<Response> }
function externalEntry(req, mounts, audit): Promise<Response> | undefined  // undefined = not ours → today's path
```

Order inside it: path match → browser `Origin` refused (MCP: `403` per spec;
A2A keeps its `401`) → bearer → caller by `tokensMatch` over that mount's
callers only (`401` + `WWW-Authenticate: Bearer`, audit `<mount>-auth-failure`)
→ body > 1 MiB → `413` → `handle`. A mount with no caller is not mounted (paths
behave as today). A2A's caller rule (`[A-Za-z0-9_]{1,32}`, a2a.md S3 drift) is
the shared one. **Coordination:** if feat/a2a's S9 is still unwritten when this
is approved, its executor builds `external/route.ts` directly (Q1); else S1a
extracts it from `a2a/http.ts` with A2A's tests unchanged and green.

**2. MCP wire (pure, S1b) — `packages/daemon/src/mcp/wire.ts`.** Hand-written
(Q3): the surface is small and our MCP client is hand-written too
(`packages/mcp/`, deps only `core` + `zod`). Stateless, **dual-era**:

| Inbound | Answer |
|---|---|
| `initialize` (legacy `2025-11-25`/`2025-06-18`/`2025-03-26`) | `{protocolVersion: the client's if supported else 2025-11-25, capabilities:{tools:{}}, serverInfo:{name:"tentacle", version}, instructions}`; **no `Mcp-Session-Id` minted** (optional in the legacy spec — verify in S1b against the 2025-11-25 transport page) |
| `notifications/initialized`, any notification | `202`, no body |
| `server/discover` (modern) | `{capabilities:{tools:{}}, supportedVersions:["2026-07-28", …legacy], serverInfo}` |
| modern request (`_meta` version) | header `MCP-Protocol-Version` must equal `_meta` → else `400`; unsupported → `-32022 {supported}` |
| `ping` | `{}` |
| `tools/list` | the slice's tools, deterministic order, `inputSchema` + `outputSchema` (JSON Schema from zod, the repo's `json-schema.ts` export) + annotations (`readOnlyHint` on status/list) |
| `tools/call` | `{content:[{type:"text", text: JSON}], structuredContent, isError?}`; a domain refusal is `isError:true` with a one-line reason; bad params → `-32602` |
| unknown method | `-32601`; GET / DELETE → `405` |

Responses are `application/json`, except a `tools/call` carrying a
`progressToken` on a tool that may hold (status with `waitSeconds`): then
`text/event-stream` — `notifications/progress` every 15 s (`progress` = elapsed
seconds, strictly increasing), then the result, then close. Closing the
request (client disconnect) aborts the wait only — never the session's turn.

**3. Slice-1 tools (S1c) — `packages/daemon/src/mcp/tools.ts`.** Names are short
(Claude Code shows `mcp__tentacle__session_start`). Every session the caller
touches is `mcp-<caller>-<uuid>`; any other id → `isError` "unknown session"
(never a hint that it exists).

| Tool | Input | Does | Output (structured) |
|---|---|---|---|
| `session_start` | `prompt` (1..64 KiB), `title?` (≤ 60) | `session/open{create, title:{text:"MCP: <title or first line>", source:"user"}}` on a fresh `mcp-<caller>-<uuid>` → `session/prompt{turnId}` | `{sessionId, turnId}` |
| `session_send` | `sessionId`, `text`, `key?` (idempotency, ≤ 64) | idle → new turn (`session/open{reopen}` + `session/prompt`); a turn running → steer it (`session/enqueue{id:key, turnId: running}`) | `{turnId, steered}` |
| `session_status` | `sessionId`, `turnId?`, `waitSeconds?` (0..120, default 0) | `workUnits()` projected; with a wait, returns early on the unit's next state change (signalled by the driver's held connection: `turn_end`, `permission_request`, `permission_resolved`) | `{state, waitingFor?, waiting?: "<ask title> — answer on your phone", reason?, result?, resultDropped?, turnId, units: [last 5 ended: {turnId, state, reason?}]}` |
| `session_cancel` | `sessionId`, `turnId?` (default: the running one) | `session/cancel{sessionId, turnId}` | `{cancelled: turnId}` or `isError` "nothing running" |
| `session_list` | — | `session/list` filtered to `mcp-<caller>-` | `[{sessionId, title, state, updatedAt}]` (≤ 50, newest first) |

`state` is the `WorkUnitState` word (`working | waiting | completed | failed |
canceled`) — the same vocabulary A2A projects, and the same an MCP-tasks
projection would use (B7). `result` is only the final round's text: the token
saving A2A chose, and what keeps one status call far under Claude Code's 25k
output cap.

**4. Session driver (S1c, shared with A2A S4) —
`packages/daemon/src/external/session-driver.ts`.** Owns, per live
external-caller session, ONE held in-process attachment: built on first use
(`initialize{clientInfo:{name:"mcp"|"a2a"}, no host, updates incl.
permission_request}`; `hooks/trust` → `{trusted:false}`; any other inbound
request → `MethodNotFound`), kept while a turn runs (so the detached cap and
idle TTL never archive a session mid-turn on our account, and the status
waiter has its signal), released with `session/detach` at the turn's end + 60 s
grace (a follow-up `send` reuses it). Never sent: `resolve_permission` (owner
mode), `set_auto_accept`, `set_capability`, `update_settings`, `skill`,
`session/delete`, `session/clear`. **Coordination:** if A2A S4 is unwritten at
approval, its executor writes this module protocol-neutral and A2A's executor
uses it (Q1); else S1c extracts it from `a2a/executor.ts`.

**5. Asks (slice 1 = owner mode only).** An MCP session's asks go to the owner
exactly like a phone session's: replayed on the phone, pushed after the grace
(`push-rules.ts:14-28`; the adapter is not a registered device, so it never
suppresses a push). `session_status` says `waiting` + the ask's title + "answer
on your phone". `--mcp-asks both` (Claude Code answers `tool` asks with a
`*_once` decision, through A2A S5's kind table) is backlog B1 — it reuses
`callerMayAnswer`/`onceOption` (`feat/a2a:…/a2a/mapping.ts:173-184`) unchanged.

**6. Auth (Q2).** A dedicated **MCP token** (`--mcp-token` /
`--mcp-token-command`, the same resolver as `--token`, `flags.ts:614-625`),
caller `default`. It opens `/mcp` only — not the WS route, not `/a2a`; the WS
token does not open `/mcp` either. Reason: Claude Code stores the header in its
config file, so this token WILL sit on disk; it must be the narrowest one, and
revocable alone. Startup line: `MCP on http://127.0.0.1:<port>/mcp (asks: owner)`
+ the exact `claude mcp add` command with a `<token>` placeholder (never the
token itself).

**7. Untrusted caller (AGENTS §7) — what it can and cannot reach.** It can
create sessions in its own namespace, prompt/steer/cancel them, and read their
units. It cannot: read or touch any other session (phone, TUI, A2A); change a
setting, auto-accept, a capability or hooks trust; answer an ask (slice 1); see
a tool's raw output or the transcript (status carries the final round only).
Caps: ≤ 8 live `mcp-<caller>-*` sessions (the 9th start → `isError` "too many
live MCP sessions; cancel or wait"), prompt ≤ 64 KiB, body ≤ 1 MiB, ≤ 1
in-flight status wait per session (a second → `isError`), wait ≤ 120 s.

### Files (slice 1, dependency order)

**Precondition:** feat/a2a merged to `main` (work units, and `external/` if Q1
lands there); then `main` is merged into this branch before S1a.

| # | File | Sub-slice |
|---|---|---|
| 1 | `packages/daemon/src/external/route.ts` (new, or extracted from `a2a/http.ts`) + `ws-server.ts` `WsServerOptions.external?` and the one call in `fetch` before `authorize` (`ws-server.ts:360-371`) | S1a |
| 2 | `packages/daemon/src/mcp/wire.ts` (new, pure) | S1b |
| 3 | `packages/daemon/src/external/session-driver.ts` (new or extracted from `a2a/executor.ts`) | S1c |
| 4 | `packages/daemon/src/mcp/tools.ts` (new) + `mcp/http.ts` (new: the `ExternalMount` for `/mcp`, SSE writer) | S1c |
| 5 | `packages/daemon/src/index.ts` — exports | S1c |
| 6 | `packages/cli/src/flags.ts` — `serve`: `mcp-token`, `mcp-token-command` | S1d |
| 7 | `packages/cli/src/serve.ts` — `ServeOptions.mcp` → the `/mcp` mount; startup line (`serve.ts:982-994`) | S1d |
| 8 | `packages/cli/src/main.ts` — help | S1d |
| 9 | `packages/daemon/package.json` — devDependency `@modelcontextprotocol/client` (SDK v2, pinned, test-only; Q3) + `bun.lock` | S1d |
| 10 | `changelog.d/serve-mcp-server.added.md`, `README.md` "MCP server", `TODO.md` (backlog items B1–B9) | S1d |

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| No / wrong token | `401` + `WWW-Authenticate: Bearer` before any parse; audit `mcp-auth-failure`. |
| Browser `Origin` (a web page on the laptop) | `403` before auth (spec MUST; WS route keeps its own rule). |
| WS token on `/mcp`, MCP token on WS or `/a2a` | `401`: each mount checks only its own callers. |
| No MCP token configured | `/mcp` not mounted → today's `401`/`426`; nothing else changes. |
| Legacy client (`initialize`) / modern client / unknown version | Both eras served; unknown → `-32022 {supported}`; header ≠ `_meta` → `400`. |
| GET / DELETE `/mcp`, unknown method, bad params | `405` / `-32601` / `-32602`; nothing opened. |
| Body > 1 MiB, prompt > 64 KiB | `413` / `-32602`. |
| Session id outside `mcp-<caller>-` | `isError` "unknown session" — same text as a truly unknown id (no oracle). |
| `send` while a turn runs | Steer (enqueue) into that turn; `key` makes a retry a no-op; the turn ended between read and enqueue → `NoTurnRunning` → retry once as a new turn. |
| Retried `session_start` (client retry after a lost response) | Creates a second session (no idempotency key on start in slice 1): visible in `session_list`, harmless; documented. B-item if it bites. |
| Ask pending | `waiting` + title; the phone answers; Claude Code's status wait returns on `permission_resolved`. No auto-deny (the adapter declares `permission_request`). |
| Claude Code idle timeout (5 min) | No call holds > 120 s, and a held one emits progress every 15 s. |
| Client disconnects mid-wait | That wait ends; the turn continues; the next status reads it. |
| Caller cancels / owner cancels from phone | Same `session/cancel` path → unit `canceled`. |
| `serve` restart | The adapter's attachments are gone; the reload restores sessions and the ended-units table (A2A S2); a cut turn reads `failed` ("interrupted: the daemon restarted"); a turn suspended on an ask is `waiting` under its id; the driver re-attaches lazily on the next call. |
| Compaction / reset / `/clear` | `workUnits()` carries ended units (`unit_end`) → status unchanged. |
| Session archived (idle TTL after the driver detached, or the owner closed it) | Slice 1: `session_status` reads it read-only through A2A S7's archived reader if merged, else `isError` "archived — open it from your phone"; `session_send` reopens it (`session/open{reopen:true}`, as A2A). Never purged. |
| Owner deletes the session | Absent from `list()` → "unknown session". |
| > 8 live MCP sessions; host at 64 | `isError` with the reason; the host's own cap refuses before ours if lower. |
| Two concurrent status waits on one session | Second → `isError`; never two waiters racing one signal. |
| Model of the session misbehaves (loop) | Owner sees it on the phone; Claude Code can `session_cancel`. |
| Prompt injection in Claude Code drives tentacle | Bounded by §7 above: own namespace, owner answers every ask, no setting/approval changes. |

### Tests

Fakes: the daemon pattern (real `SessionHost` + `Agent` + scripted
`ModelProvider`, `Connection` over `createChannelPair`, as
`session-auto-accept-asked-on.test.ts` and A2A's `work-units.test.ts`);
`until` from `packages/client/test/support/fakes.ts`, never a sleep (§9);
loopback `port: 0` for the server under test (a port that must stay closed is
`127.0.0.1:1`). Each test names its mutation.

- **S1a** `daemon/test/external-route.test.ts`: path routing, `403` Origin, `401`
  per mount (MCP token on `/a2a` → 401; mutation: one shared caller list → red),
  `413`, unmounted → today's 401/426; WS upgrade unaffected. If extracted:
  A2A's `a2a-http.test.ts` passes unchanged.
- **S1b** `daemon/test/mcp-wire.test.ts` (pure, table-driven): `initialize`
  per legacy version, `server/discover`, `_meta`/header mismatch → 400,
  `-32022`, notifications → 202, `405`, `-32601`, `-32602`, tool schemas;
  progress tokens strictly increasing (mutation: constant progress → red).
- **S1c** `daemon/test/mcp-tools.test.ts`: start → status `working` → `completed`
  with the final round only (mutation: concatenate all rounds → red); send idle
  → new turn, send busy → steer with `steered:true`, a retried `key` → one
  steer; cancel; a foreign session id (a phone session, an `a2a-…`, another
  caller's) → "unknown session", untouched (mutation: drop the prefix check →
  red); the ask: phone (a second `Connection`) answers it and the wait returns
  (mutation: adapter declares no `permission_request` → the ask is auto-denied
  → red); the adapter never sends `resolve_permission` / `hooks/trust:true`
  (spy peer); cap of 8; restart (stop + reload on the same store) → status of
  an ended turn and of a cut turn (`failed`); compaction → status unchanged.
  Pins the load-bearing assumption for an MCP-created session: listed to the
  phone, phone cancel → `canceled`.
- **S1d e2e** `cli/test/serve-mcp-e2e.test.ts`: `startDaemon` with an MCP token
  and a scripted model; **two real MCP clients**: the official SDK v2 client
  (`@modelcontextprotocol/client`, Streamable HTTP, modern era — the SDK Claude
  Code's runtime is built on) AND tentacle's own `packages/mcp` client (legacy
  `initialize` era): each `tools/list` → `session_start` → `session_status
  {waitSeconds}` with a `progressToken` until `completed` → `session_send` →
  `session_cancel`; a WS client sees `mcp-default-…` in `session/list`; wrong
  token → 401. Plus a **manual live check** recorded in Execution: `claude mcp
  add --transport http tentacle http://127.0.0.1:<port>/mcp --header
  "Authorization: Bearer …"` in a real Claude Code, one delegation end to end.

### Slices (slice 1 = S1a–S1d)

| Slice | Executor | Est. | Scope |
|---|---|---|---|
| `S1a-external-entry` | **opus** | 1 h | shared route (or extraction from A2A) — the auth path of `serve` (§7 untrusted) |
| `S1b-mcp-wire` | **sonnet** | 1 h 30 | pure dual-era JSON-RPC + headers + schemas + SSE framing — table-tested, cheap to iterate |
| `S1c-mcp-session-tools` | **opus** | 2 h | session driver on the single session path, the 5 tools, namespace, caps, asks never answered (§7 single path / broker / untrusted) |
| `S1d-cli-e2e` | **sonnet** | 1 h 30 | flags, wiring, startup line, help, README, changelog, e2e with both clients, live Claude Code check |
| `R-review` | opus (fresh) | 1 h | §7 red-team (namespace escape, ask answering, lasting approvals, second entry path), non-vacuity, `bun run check` |
| **Total** | | **≈ 7 h** | after feat/a2a merges |

### Backlog (ranked by need; each its own later slice, purely additive)

| # | Item | Why this rank | Shape / reuse | Executor |
|---|---|---|---|---|
| B1 | **Claude Code answers asks** (`--mcp-asks both`, `session_answer{sessionId, requestId, decision}`) | without it a delegated run blocks on the phone; with it Claude Code is a real driver | A2A S5 kind table + `callerMayAnswer`/`onceOption`, `*_once` only, owner-only kinds never listed | opus (§7 broker) |
| B2 | **Push to the phone** (`notify_owner{title, body}`) | "tell me when it's done" from Claude Code | a new push kind from an external caller, labelled "via MCP <caller>", rate-limited (e.g. 10/h); needs the push payload + app rendering checked (`push-notifier.ts`, app) — phone/Mac parity | opus plan (new push kind), sonnet exec |
| B3 | **Workflows** (`workflow_start{name, inputs}`, status via the same `session_status`) | owner's third item | `session/workflow{start, turnId}` → the run is a work unit with `origin` = turnId (A2A S8); per-caller `--mcp-workflows` OFF by default; file approval owner-only | sonnet |
| B4 | **Events feed** (`session_events{sessionId, since?, only?}`) | "status AND events": tool calls, errors, asks — for debugging a delegated run | `session/watch` + `watch_next` (long-poll, bounded, never an attachment, `watch.ts`), coalesced, capped per call | sonnet |
| B5 | **Owner's own sessions** (read, and optionally steer, phone/TUI sessions) | "list sessions" in the broad sense | opt-in caller scope `sessions: own \| all-read \| all`; default `own` | opus (§7) |
| B6 | **MCP tasks extension** (`io.modelcontextprotocol/tasks`) | Claude Code backgrounds long calls natively | a task = projection of a `WorkUnit` (same states), like A2A tasks; only after a live check that Claude Code uses it on our server | opus plan |
| B7 | **Start-idempotency + `session_result` paging** (long results over 16 KiB) | only if retries / truncation bite | `key` on start; transcript tail via `session/log` | sonnet |
| B8 | **OAuth 2.1 + RFC 9728** | only for third-party clients that cannot send a static header | out unless a real client needs it | — |
| B9 | **Per-session model / pod target** ("start a DeepSeek session in a k8s pod") | a different serve covers the model today; a pod target is `run`, laptop-side | needs its own eval (pod launch from a remote caller = laptop effect, §7) | eval |

### Owner questions

1. **One external entry, built once.** feat/a2a's S4 (executor) and S9 (HTTP
   route) are not written yet. Should their executor write them
   protocol-neutral — `external/route.ts` and `external/session-driver.ts`, with
   only the A2A mapping in `a2a/` — so MCP mounts on them with no extraction?
   **Recommendation: yes** — about +20 min on A2A, and it removes S1a's
   extraction and any risk of two entry paths.
2. **Token.** A dedicated MCP token (`--mcp-token-command`, opens only `/mcp`),
   or the existing serve token? **Recommendation: dedicated** — Claude Code
   keeps the header in its config file on disk, so it must be the narrowest,
   separately revocable credential (the serve token is full control of
   everything).
3. **Implementation + test client.** Hand-written server (no runtime
   dependency, like our MCP client) with the official SDK v2 client only as a
   pinned **devDependency** for the e2e, plus our own client for the legacy
   era? **Recommendation: yes** — the SDK server pulls express/hono and a
   second zod; our surface is ~5 methods.
4. **Long calls.** Slice 1 = non-blocking tools + `session_status
   {waitSeconds ≤ 120}` with progress every 15 s; MCP tasks (B6) later, after
   a live check. **Recommendation: yes** — works on every client and era
   today; tasks is an extension whose client support varies.
5. **Who answers asks in slice 1.** Only the owner (phone/TUI), with B1 (Claude
   Code answers `tool` asks, `*_once`, per-caller switch) as the very next
   slice? **Recommendation: yes** — mirrors A2A's default; B1 reuses A2A S5
   as-is once merged.
6. **Scope of slice 1.** Only sessions the MCP caller created
   (`mcp-default-*`); the owner's phone/TUI sessions stay invisible until B5.
   **Recommendation: yes** — a leaked or prompt-injected token can then only
   touch its own sessions.

## Execution

## Review
