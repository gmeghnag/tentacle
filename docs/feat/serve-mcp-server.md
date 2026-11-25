# feat/serve-mcp-server — `tentacle serve` exposes an MCP server

> **Status:** implementation — **APPROVED (owner answers 2026-11-25)** (rev. 2: Q1–Q6 answered; MCP tasks and caller asks into slice 1; re-sliced)
> **Branch:** `feat/serve-mcp-server`
> **Size:** L → slices (slice 1 = M1–M5 planned in full, the rest a ranked backlog) · **Blast:** load-bearing for M2–M4 (a second mount on the external session entry: AGENTS §7 "a remote caller is not trusted", single session path, single broker, durable task records); contained for M1 · **Suited:** Opus plans; Sonnet executes pure / cheap-to-iterate slices, Opus the §7 ones; mandatory fresh-context Opus review
> **Changelog:** `changelog.d/serve-mcp-server.added.md` — "**`serve` is an MCP server.** Claude Code (or any MCP client) can start a tentacle session on your serve, steer it, follow it as an MCP task, read its result and cancel it — with a dedicated MCP token; your phone answers its approvals (or, if you allow it, the caller answers one-time tool approvals)."

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
cancel — plus "which of my sessions exist". Per the owner's answers (Q4, Q5),
slice 1 also carries MCP tasks (negotiated) and caller-answered asks
(configurable). Everything else (a push to the phone, workflows, a full event
feed, the owner's own sessions) is additive and ranked in the backlog.

**Constraints that shape it:**

- **feat/a2a** (on its own branch, mid-execution; `git show
  feat/a2a:docs/feat/a2a.md`) adds the same kind of thing for A2A: a
  dedicated-token external entry on `serve`, an in-process adapter that drives
  sessions over `createChannelPair()` + a real `Connection`, caller-answered
  asks, and the **work-units seam**. Per the owner's decision of 13:20 (Q1
  here; recorded in a2a.md "Owner decision 2026-11-25 ~13:20"), the route, the
  session driver, the token check, the caller identity and the work-units
  projection land **protocol-neutral in `packages/daemon/src/external/`**, with
  only the A2A wire in `a2a/`. Also part of feat/a2a: the work-units seam (`HostedSession.workUnits()`,
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
- **Tasks** are an **extension**, stable for 2026-07-28
  (https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks.html,
  repo github.com/modelcontextprotocol/ext-tasks), `tools/call` only:
  - The client declares it **per request**:
    `_meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"] = {}`.
    The server declares it in `server/discover` `capabilities.extensions`.
  - The **server alone decides**, per request, whether to answer with a
    task. It MUST NOT send a task to a client that did not declare the
    extension (if it cannot answer without one: `-32021` +
    `data.requiredCapabilities`).
  - The answer is `CreateTaskResult {resultType:"task", taskId, status,
    statusMessage?, createdAt, lastUpdatedAt, ttlMs (int|null),
    pollIntervalMs?}`. It is returned **only once the task is durably
    created**.
  - `tasks/get {taskId}` → the task. At `input_required` it adds
    `inputRequests`. At `completed` it adds `result` (the `CallToolResult`,
    `isError:true` included). At `failed` it adds `error` (**JSON-RPC errors
    only**, never `isError`).
  - `tasks/update {taskId, inputResponses}` → an empty ack, eventually
    consistent. `tasks/cancel {taskId}` → an empty ack, cooperative.
  - There is **no `tasks/list` and no `tasks/result`**. An unknown taskId →
    `-32602`.
  - States are `working | input_required | completed | failed | cancelled`:
    our `WorkUnitState` one-to-one.
  - `inputRequests` is a map `key → {method:"elicitation/create",
    params:{mode:"form", message, requestedSchema}}` (keys never reused).
    `inputResponses` maps each key to an `ElicitResult {action, content}`.
  - `notifications/tasks` is optional and only on a `subscriptions/listen`
    stream. **`notifications/progress` MUST NOT be sent for tasks.**
  - The extension is not defined for legacy `initialize`-era clients (those
    pages are silent; the 2025-11-25 tasks semantics differ and are NOT
    implemented here).
  - Claude Code documents tasks on 2026-07-28 (v2.1.304+). The TS client is
    `@modelcontextprotocol/client` **2.4.0** + `@modelcontextprotocol/ext-tasks`:
    `createTaskSessionFromClient(client)`, then `session.callTool(...)` → a
    `ToolExecution` (`kind === "task"`, `settle()`, `cancel()`), and
    `session.task(taskId)` re-attaches
    (https://modelcontextprotocol.github.io/ext-tasks/typescript/).
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

*— claude-opus-5-5, 2026-11-25 (rev. 2: owner answers Q1–Q6; MCP tasks negotiated per request with the non-blocking tools as the fallback; caller asks configurable, reusing A2A's code; no extraction slice; re-sliced M1–M5)*

### Owner answers

*2026-11-25 ~13:25, verbatim as relayed by the orchestrator:*

1. **Q1 one protocol-neutral external entry** — «YES (the decision is now
   recorded in docs/feat/a2a.md on feat/a2a; slice 1 mounts on external/ once
   feat/a2a is merged — no extraction slice).»
2. **Q2 token** — «dedicated MCP token (--mcp-token-command, opens only /mcp) — yes.»
3. **Q3 implementation** — «hand-written server, official SDK v2 client only as
   a pinned devDependency for the e2e — yes.»
4. **Q4 long calls** — «MCP tasks subito, ma per chi non lo supporta i tool
   tornano subito; session_status {waitSeconds ≤ 120} aspetta con un progresso
   ogni 15 s» — implement MCP tasks in slice 1 for clients that declare support
   (negotiated), with the non-blocking tools + session_status wait as the
   fallback for the others; verify against the current spec (fetch it) and the
   SDK v2 client.
5. **Q5 who answers asks** — configurable like A2A (owner default / both, first
   answer wins, never a lasting approval from the caller), REUSING A2A's
   caller-asks code.
6. **Q6 scope** — only the sessions the MCP caller created (as recommended).

Consequences in this revision:

- **Q1:** the S1a extraction is gone. Slice M2 mounts on `external/`.
- **Q4:** MCP tasks move from backlog B6 into slice 1 (M4). Spec and SDK
  were re-read 2026-11-25 (Context).
- **Q5:** caller asks move from backlog B1 into slice 1 (M3).
- **SDK:** the e2e needs the ext-tasks client package beside
  `@modelcontextprotocol/client`. Both are official and test-only, so this is
  inside Q3, not a new choice.

### Load-bearing assumptions

1. **An in-process client — a real `Connection` on one end of
   `createChannelPair()` — drives the SAME `SessionHost` a phone does.** Its
   session is listed to, answerable by and cancellable from the owner's phone,
   with no new daemon path. A2A PROVED this with `.tentacle/tmp/a2a/seam.ts`
   (`feat/a2a:docs/feat/a2a.md`, Load-bearing assumption, re-run green before
   each of S0–S3). MCP reuses that very driver (`external/session-driver.ts`),
   so the proof carries over. M2 re-runs `seam.ts` first, and M2's own test
   pins it for an MCP-created session.
2. **No slice-1 call needs a server→client request mid-call.** Each is one
   stateless POST.
   - Start, send, cancel and answer are acks: `session/prompt` resolves at
     acceptance (`PromptResultSchema`,
     `packages/protocol/src/session.ts:527-533`).
   - Status is a bounded read.
   - A task's input is pulled by `tasks/get` and answered by `tasks/update`
     (spec: no independent requests on a response stream).
3. **(M4, prove FIRST) A turn's start can be made durable before the
   `CreateTaskResult` is returned.** The spec says MUST. `SessionPersister.flush(id)`
   resolves once the latest write scheduled for `id` has settled
   (`packages/daemon/src/session-persister.ts:585-596`). AGENTS §7 lists
   daemon writes at committed rounds, turn ends and compactions — **not
   explicitly at a turn's start**. M4's first step is a 10-line repro:
   `session/prompt` → see `turn_start` → `flush(id)` → kill (no stop) →
   reload → `workUnits()` shows that turnId (a turn cut mid-run is closed as
   `failed`; that is still a task, not `-32602`).
   - **If it holds:** the driver's `durable(sessionId, turnId)` = "await the
     `turn_start` update for that turn, then `flush`".
   - **If it does not:** STOP. M4 then adds a write at turn start through
     `SessionPersister.schedule` (a daemon write inside a turn, §7), and the
     plan is revised before code. This is a design step, not an owner choice.

### Preconditions

- **feat/a2a is merged to `main`**, and `main` is merged into this branch
  before M1. From it this task USES (M2 checks each one before any code):
  - `external/route.ts` — mounts, the dedicated-token check, caller identity
    `[A-Za-z0-9_]{1,32}`.
  - `external/session-driver.ts` — open/create/reopen, prompt, cancel, detach,
    the caller-answer path; hooks `{trusted:false}`; `permission_request`
    declared; no `host`.
  - The caller-asks pieces: `PendingAsk`, `AskMode`, `callerMayAnswer`,
    `onceOption`, `callerOptions`, `askMessage`, today in `a2a/mapping.ts`
    `:173-214` (S3), plus S5's `PermissionKind → once | owner-only` table in
    `core/src/permission.ts`.
  - The work-units projection and the archived read-only reader (A2A S6/S7).

  A neutral piece that the merge still leaves under `a2a/` is **moved** (move
  only, re-exported from `a2a/`, A2A tests unchanged) as M2's step 0, and the
  move is recorded in Execution. This is the rule a2a.md itself sets.
- **One session path:** a socket is `new Connection(channel, sessionHost, …)`
  (`ws-server.ts:391-399`); `createChannelPair()`
  (`packages/transport/src/channel.ts:77`). The verbs are existing methods:
  `session/open` `prompt` `enqueue` `cancel` `detach` `list`
  `resolve_permission` (`packages/protocol/src/methods.ts:134-160,290`).
- **Steering is retry-safe:** `session/enqueue{sessionId, id, turnId, text}`
  injects into the RUNNING turn. `id` is an idempotency key, and `turnId`
  binds the steer to that turn (`session.ts:1955-1976`).
- **`session/prompt` is idempotent by `turnId`** (`session.ts:527-533`).
  `TurnIdSchema` ≤ 128 chars, never `wake-…` (`session.ts:439,452`).
- **Asks wait for a client** when none is attached. They are denied at once
  only when a client IS attached and none declared `permission_request`
  (`hosted-session.ts:1652-1662`, re-checked `:1689-1702`).
- **First answer wins**: a late answer → `PermissionNotPending`, no effect. The
  push grace keeps the phone silent when the caller answers in time
  (`push-rules.ts:14-28`).
- **`workUnits()`** (`feat/a2a:…/hosted-session.ts:2567`) returns ended units
  (they survive restart, compaction, reset and `/clear` through the
  `unit_end` carry), the running turn (`waiting:permission` with a pending
  ask) and live runs. `result` = the final round's text, ≤ 16 KiB.
- **Exposure:** `--token`/`--token-command` resolver (`packages/cli/src/flags.ts:74,614-625`),
  `tokensMatch` (`ws-server.ts:201-208`), `serve` builds the server at
  `packages/cli/src/serve.ts:982-994`. Caps: 64 sessions, 16 detached
  (`session-host.ts:96-97`).
- **No protocol change:** the adapter is a protocol CLIENT, and `/mcp` is an
  HTTP face. So no `protocol.d/` note, no `PROTOCOL_VERSION` bump, no
  persisted-format change (no MCP store: a task is a projection of a work
  unit, the A2A rule).

### Design

```
Claude Code ─POST /mcp (Bearer MCP token)─► Bun.serve fetch ─► external/route.ts (feat/a2a; ONE entry, mounts /a2a and /mcp)
                                                                │ Origin 403 · bearer→caller 401 · 1 MiB 413 · audit
                                                                ▼
                                                          mcp/http.ts ── mcp/wire.ts (pure: dual-era JSON-RPC, headers, _meta caps, SSE)
                                                                │
                                         tools/call ────────────┼──────────── tasks/get · tasks/update · tasks/cancel
                                                                ▼                         │
                                                          mcp/tools.ts                    ▼
                                                                │                  mcp/task-projection.ts (pure: WorkUnit → MCP task)
                                                                ▼                         │
                                     external/session-driver.ts (A2A's) ─► Connection ─► SessionHost ◄─ workUnits() (read-only)
                                                                                                    ◄─ phone / TUI: same session
```

**1. Mount.** `/mcp` is one `ExternalMount` on the A2A-built `external/route.ts`.
Its callers are the MCP caller(s) only, so an A2A or WS token gets `401` here and
the MCP token gets `401` on `/a2a` and on the WS route. A browser `Origin` gets
`403` (the MCP spec's code), `WWW-Authenticate: Bearer` on `401`. With no MCP
token, `/mcp` is not mounted and paths behave as today.

**2. Wire (pure) — `packages/daemon/src/mcp/wire.ts`.** Hand-written, stateless,
**dual-era**:

| Inbound | Answer |
|---|---|
| `initialize` (legacy `2025-11-25`/`2025-06-18`/`2025-03-26`) | `{protocolVersion: the client's if supported else 2025-11-25, capabilities:{tools:{}}, serverInfo, instructions}`. **No `Mcp-Session-Id`**. Legacy requests never get a task. |
| `server/discover` (modern) | `{capabilities:{tools:{}, extensions:{"io.modelcontextprotocol/tasks":{}}}, supportedVersions, serverInfo}` |
| modern request | `MCP-Protocol-Version` header ≠ `_meta` version → `400`; unsupported → `-32022 {supported}`. Per-request caps read from `_meta["io.modelcontextprotocol/clientCapabilities"]`: `tasks` (extension declared) and `elicitationForm`. |
| notification | `202`, no body |
| `ping` / `tools/list` | `{}` / the tools, deterministic order, `inputSchema` + `outputSchema` + annotations |
| `tools/call` | `CallToolResult` (`content` text JSON + `structuredContent`, `isError` for a domain refusal) or `CreateTaskResult` (below) |
| `tasks/get` / `update` / `cancel` | below; a client that did not declare tasks on THAT request → `-32021` |
| GET/DELETE, unknown method, bad params | `405` / `-32601` / `-32602` |

Responses are `application/json`. The exception is a non-task
`session_status` with `waitSeconds > 0` and a `progressToken`: it answers
`text/event-stream`, with `notifications/progress` every 15 s (`progress` =
elapsed seconds, strictly increasing), then the result, then close. A client
disconnect ends only that wait.

**3. Ids (self-locating — no index, survives restart).**
- Session id: `mcp-<caller>-<s>`, where `<s>` is a UUID.
- Turn id = task id: `<s>.<t>` (73 chars, ≤ 128, never `wake-`), where `<t>`
  is a fresh UUID.
- `tasks/get` resolves the session from the taskId by parsing it, under the
  TOKEN's caller, so a forged taskId cannot reach another caller's session.
- The task is then the unit with `id === taskId` in that session's
  `workUnits()`, or in the archived read-only projection.
- Not found or malformed → `-32602` (the same answer whether or not the
  session exists: no oracle).

**4. Tools.** Every session id outside the caller's `mcp-<caller>-` prefix →
`isError` "unknown session".

| Tool | Input | Does | Task-capable client | Other client |
|---|---|---|---|---|
| `session_start` | `prompt` (1..64 KiB), `title?` (≤ 60) | `session/open{create, title:"MCP: …"}` on a fresh `mcp-<caller>-<s>` → `session/prompt{turnId:<s>.<t>}` | `CreateTaskResult` (taskId = turnId, `working`), returned after `durable()` (assumption 3) | `{sessionId, turnId}` at once |
| `session_send` | `sessionId`, `text`, `key?` (≤ 64) | idle → new turn (`open{reopen}` + `prompt`); a turn running → steer it (`enqueue{id:key}`) | new turn → `CreateTaskResult`; a steer → plain `{turnId, steered:true}` (no new unit) | `{turnId, steered}` |
| `session_status` | `sessionId`, `turnId?`, `waitSeconds?` (0..120) | `workUnits()` projected; a wait returns early on the unit's next change (`turn_end`, `permission_request`, `permission_resolved` on the driver's held attachment) | plain result (works for tasks too) | same; SSE progress when waiting |
| `session_answer` | `sessionId`, `requestId`, `decision: allow\|deny`, `message?` | only with `--mcp-asks both`, only a caller-answerable ask: `resolve_permission` with that ask's own `*_once` option | plain | plain |
| `session_cancel` | `sessionId`, `turnId?` | `session/cancel{sessionId, turnId}` | plain | plain |
| `session_list` | — | `session/list` filtered to the prefix, ≤ 50 newest | plain | plain |

The status output is `{turnId, state, waitingFor?, statusMessage?, asks?:
[{requestId, title, options:["allow","deny"]}] (only caller-answerable, only in
both), result?, resultDropped?, recent:[last 5 ended {turnId, state,
reason?}]}`. `result` is the final round's text only (token saving, far under
Claude Code's 25k cap).

**5. Task projection (pure) — `packages/daemon/src/mcp/task-projection.ts`.**
The A2A rules (`a2a/mapping.ts` `projectStatus`) with MCP words. The
"answerable?" decision is the SHARED `callerMayAnswer` + kind table, never a
copy:

| WorkUnit | MCP task |
|---|---|
| `working` | `working` |
| `waiting:permission`, mode `owner` | `working` + `statusMessage` "waiting for the owner's approval: <title>" |
| `waiting:permission`, mode `both`, a caller-answerable ask, **client declared elicitation form** | `input_required` + `inputRequests{<requestId>: {method:"elicitation/create", params:{mode:"form", message: askMessage, requestedSchema:{type:"object", properties:{decision:{type:"string", enum:["allow","deny"]}}, required:["decision"]}}}}` |
| same, client without elicitation form | `working` + `statusMessage` "approval needed: <title> — `session_answer` requestId=<id>" |
| owner-only ask kind (hooks, hop, workflow approval), any mode | `working` + "waiting for the owner" |
| `completed` | `completed` + `result` = `CallToolResult{content:[text: result], structuredContent:{turnId, result}}` |
| `failed` (model error, interrupted by a restart, `max_*`) | **`completed` + `result.isError:true`** + the reason. The spec keeps `failed` for JSON-RPC errors only. |
| `canceled` | `cancelled` |
| result dropped (over budget) | `completed` + text "result no longer retained" |

Each task also carries `createdAt` (the unit's `startedAt`, else the
acceptance time), `lastUpdatedAt`, `pollIntervalMs: 2000` and `ttlMs: null`.
- `ttlMs: null` because a task lives as long as its unit: the ended-units
  bounds (256 units / results budget) and the archive; after eviction
  `tasks/get` → `-32602`.
- M4 checks the ext-tasks schema meaning of `null`. If `null` means "never
  discarded", it sends `604800000` (7 d) and documents the count bound.

**6. Task methods.**
- **`tasks/update{taskId, inputResponses}`:** each key must be a pending,
  caller-answerable ask of THAT task. `{action:"accept", content:{decision}}`
  maps to that ask's `*_once` option through the shared driver answer path;
  `decline`/`cancel` → deny (fail-closed).
  - Unknown keys are ignored (spec).
  - A key naming an owner-only ask is ignored and audited
    (`mcp-answer-refused`); the ask is untouched.
  - The ack is empty, eventually consistent (first answer wins).
- **`tasks/cancel{taskId}`** → `session/cancel{sessionId, turnId}`. The ack is
  empty; the `cancelled` state shows up in the projection.

**7. Caller asks (Q5).** The switch is per caller: `--mcp-asks owner|both`,
default `owner`.
- In `owner` mode the adapter never answers.
- In `both` mode the caller may answer only kind `tool`, with `*_once` only,
  through the SAME code A2A uses (kind table, `callerMayAnswer`, `onceOption`,
  the driver's answer path).
- The owner is always asked too: first answer wins, and the push grace
  silences the phone when the caller answered.
- Never sent: `set_auto_accept`, `set_capability`, `update_settings`, a skill,
  `hooks/trust:true`, an `*_always` option, an answer to an owner-only kind.

**8. Untrusted caller (AGENTS §7).** The caller works only in its own
namespace. It changes no setting and creates no lasting approval. It never
sees tool output or the transcript (status/task carry the final round only).

Caps:
- ≤ 8 live `mcp-<caller>-*` sessions;
- prompt ≤ 64 KiB, body ≤ 1 MiB;
- one status wait per session, wait ≤ 120 s;
- `tasks/get` is a pure read, so it needs no rate cap beyond the body cap.

**9. Driver attachment.** The adapter holds ONE in-process attachment per live
MCP session (A2A's driver). It is kept while a turn runs: the idle TTL and the
detached cap never archive the session on our account, and the status waiter
gets its signal. It is released with `session/detach` 60 s after the turn
ends. After a restart it re-attaches lazily on the next call.

### Files (slice 1, dependency order)

| # | File | Slice |
|---|---|---|
| 1 | `packages/daemon/src/mcp/wire.ts` (new, pure) | M1 |
| 2 | (step 0, only if needed) neutral pieces moved `a2a/` → `external/`, re-exported | M2 |
| 3 | `packages/daemon/src/mcp/http.ts` (new: the `/mcp` `ExternalMount`, JSON/SSE writer) + `mcp/tools.ts` (new: start/send/status/cancel/list) + `daemon/src/index.ts` exports | M2 |
| 4 | `mcp/tools.ts` `session_answer` + status `asks`; the per-caller `asks` mode on the MCP caller | M3 |
| 5 | `packages/daemon/src/mcp/task-projection.ts` (new, pure) + `mcp/tasks.ts` (new: `tasks/get|update|cancel`, `CreateTaskResult` after `durable`) + `durable` hook option on the mount | M4 |
| 6 | `packages/cli/src/flags.ts` (`mcp-token`, `mcp-token-command`, `mcp-asks`), `packages/cli/src/serve.ts` (`ServeOptions.mcp` → the mount, `durable` = `persister.flush` after `turn_start`; startup line with a `claude mcp add` hint, `<token>` placeholder), `packages/cli/src/main.ts` help | M5 |
| 7 | `packages/daemon/package.json` devDependencies `@modelcontextprotocol/client` `2.4.0` + `@modelcontextprotocol/ext-tasks` (pinned, test-only) + `bun.lock` | M5 |
| 8 | `changelog.d/serve-mcp-server.added.md`, `README.md` "MCP server", `TODO.md` (backlog B-items) | M5 |

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| No / wrong token; WS or A2A token on `/mcp`; MCP token elsewhere | `401` before any parse; audit `mcp-auth-failure`. |
| Browser `Origin` | `403` before auth. |
| No MCP token configured | `/mcp` unmounted → today's `401`/`426`. |
| Legacy / modern / unknown version; header ≠ `_meta` | Both eras served; `-32022 {supported}`; `400`. |
| Legacy client and tasks | Never a task (not declared): the tools answer at once; status wait with progress. |
| Modern client without the tasks extension | Same fallback; `tasks/*` → `-32021`. |
| GET/DELETE, unknown method, bad params, > 1 MiB, prompt > 64 KiB | `405` / `-32601` / `-32602` / `413` / `-32602`; nothing opened. |
| Foreign session id or taskId (phone, `a2a-…`, another caller) | "unknown session" / `-32602`, untouched, same text as truly unknown. |
| `send` while a turn runs | Steer; `key` makes a retry a no-op. If the turn ended between read and enqueue → `NoTurnRunning` → one retry as a new turn. |
| Retried `session_start` | A second session (documented, visible in `session_list`); B5 if it bites. |
| Crash after `CreateTaskResult` | `durable()` happened first. The reload closes the cut turn → `completed`+`isError` "interrupted: the daemon restarted", or `input_required`/`working` if it was suspended on an ask (it resumes under its id). |
| `durable()` write fails | The persister reports it to the operator (it never throws). The tool then answers `isError` "could not record the task" and cancels the turn: no unrecorded task is ever handed out. |
| Ask in `owner` mode | Task `working` + message; the phone answers; no auto-deny (`permission_request` declared). |
| Ask in `both` mode | `input_required` (elicitation) or status `asks` (fallback). First answer wins; a late answer → no effect. |
| Caller answers an owner-only ask / tries `*_always` | Never offered. A crafted `requestId` → ignored + audit (tasks/update) or `isError` (session_answer); the ask is untouched. The caller only sends a decision; the host picks `*_once`. |
| `decline` / `cancel` / ambiguous answer | Deny (fail-closed). |
| Claude Code idle timeout (5 min, HTTP) | No call holds > 120 s. A held status emits progress every 15 s. Tasks are polled (`pollIntervalMs` 2 s). |
| Client disconnect mid-wait | Only the wait ends; the turn continues. |
| `tasks/cancel` / phone cancel / `session_cancel` | One `session/cancel` path → `cancelled`. |
| Compaction / reset / `/clear` / restart | `workUnits()` carries ended units → `tasks/get` and status unchanged. |
| Session archived (TTL after detach, owner close) | Read-only through the archived projection (never reopened by a read); `session_send` reopens it. |
| Ended unit evicted (> 256) or session deleted | `-32602` / "unknown session". |
| > 8 live MCP sessions | `isError` with the reason. |
| Prompt injection in Claude Code | Bounded by §8 above: own namespace, `*_once` tool asks at most (only if the owner chose `both`), no settings. |

### Tests

The fakes:
- the daemon pattern: real `SessionHost` + `Agent` + a scripted
  `ModelProvider`, `Connection` over `createChannelPair`, temp
  `LogSessionStore` + `SessionPersister` (as A2A's `work-units.test.ts`);
- `until` from `packages/client/test/support/fakes.ts`, never a sleep;
- loopback `port: 0` for the server under test.

Each test names its mutation (§9).

- **M1 `daemon/test/mcp-wire.test.ts`** (pure, table-driven):
  - `initialize` per legacy version; `server/discover` declares the tasks
    extension;
  - `_meta` caps parsing (tasks, elicitation form); header ≠ `_meta` → 400;
    `-32022`; `-32021` for `tasks/*` without the declaration;
  - notification → 202; `405`; `-32601`; `-32602`;
  - `CreateTaskResult` / task / `inputRequests` shapes against the ext-tasks
    schema (vendored as a test fixture);
  - progress strictly increasing (mutation: constant progress → red).
- **M2 `daemon/test/mcp-tools.test.ts`**:
  - start → status `working` → `completed` with the final round only
    (mutation: all rounds → red);
  - send idle → a new turn; send busy → `steered:true`; a retried `key` → one
    steer;
  - cancel; list shows only the prefix;
  - a foreign id (phone, `a2a-…`, another caller) → unknown and untouched
    (mutation: drop the prefix check → red);
  - the phone (a second `Connection`) sees the session and answers its ask,
    and the status wait returns (mutation: no `permission_request` declared →
    auto-deny → red);
  - phone cancel → `canceled`;
  - the adapter never sends `resolve_permission` in owner mode (spy peer);
  - 8-session cap;
  - progress over SSE.
- **M3 `daemon/test/mcp-caller-asks.test.ts`**:
  - `both`: status lists the tool ask; `session_answer allow` → that ask's
    `allow_once` (never `*_always`; mutation: pass the caller's choice through
    → red);
  - an owner-only ask (`workflow_approve`, `hooks_trust`) is never listed, and
    a crafted answer is refused with the ask untouched (mutation: route by
    `requestId` without the kind check → red);
  - phone answers first → the caller's answer has no effect;
  - `owner` mode → `session_answer` refused;
  - the caller answers in time → no push (the push spy as in
    `push-rules` tests).
- **M4 `daemon/test/mcp-tasks.test.ts`**:
  - a declaring client gets `CreateTaskResult`, a non-declaring one a plain
    result (mutation: always task → red);
  - **durable before the ack**: a kill right after the ack (no stop), then a
    reload → `tasks/get` finds the task (mutation: skip `durable` → red);
  - `tasks/get` through working → `input_required` (both + elicitation) →
    `tasks/update accept` → `completed` with `result`;
  - without elicitation → `working` + the `session_answer` hint;
  - failed turn → `completed` + `isError` (mutation: map to `failed` → red);
  - `tasks/cancel` → `cancelled`;
  - compaction and restart → `tasks/get` unchanged;
  - a forged taskId naming another caller's session → `-32602`;
  - archived session → read-only (store files byte-identical before/after).
- **M5 e2e `cli/test/serve-mcp-e2e.test.ts`**: `startDaemon` with an MCP token
  and a scripted model, three real clients:
  1. **SDK v2 + ext-tasks** (modern, tasks):
     `createTaskSessionFromClient` → `session_start` → `ToolExecution.kind ===
     "task"` → `settle()` → `completed` with the result; a second task →
     `cancel()` → `cancelled`.
  2. **SDK v2 without ext-tasks** (modern, no tasks): `session_start` → a plain
     result → `session_status{waitSeconds}` with `onprogress` until
     `completed`.
  3. **tentacle's own `packages/mcp` client** (legacy `initialize`): the same
     non-task flow.

  Plus: a WS client sees `mcp-default-…` in `session/list`; a wrong token →
  401.

  A **manual live check** is recorded in Execution: `claude mcp add
  --transport http tentacle http://127.0.0.1:<port>/mcp --header
  "Authorization: Bearer …"` in a real Claude Code (≥ v2.1.304), with one
  delegation end to end, noting whether Claude Code took the task path.

### Slices (slice 1 = M1–M5, after feat/a2a is merged)

| Slice | Executor | Est. | Scope |
|---|---|---|---|
| `M1-mcp-wire` | **sonnet** | 1 h 45 | pure dual-era JSON-RPC, headers, `_meta` caps, `server/discover`, tasks/elicitation shapes, error codes, SSE framing + tests |
| `M2-mcp-session-tools` | **opus** | 2 h | step 0 (check `external/`, move-only if needed) + the `/mcp` mount + start/send/status/cancel/list on the shared driver, ids, namespace, caps, status wait + progress (§7 single path, untrusted caller) |
| `M3-mcp-caller-asks` | **opus** | 1 h | `--mcp-asks`, `session_answer`, status `asks`, on A2A's caller-asks code (§7 broker, no lasting approval) |
| `M4-mcp-tasks` | **opus** | 2 h 15 | prove assumption 3 first; task projection, `CreateTaskResult` after `durable`, `tasks/get|update|cancel`, `input_required` via elicitation, restart/compaction/archived tests (durable records, §7 persistence) |
| `M5-cli-e2e` | **sonnet** | 1 h 45 | flags, serve wiring (`durable` = `flush`), startup line, help, README, changelog, TODO, devDeps, e2e with the three clients, live Claude Code check |
| `R-review` | opus (fresh) | 1 h 15 | §7 red-team: namespace escape, forged taskId, caller answers (kinds, `*_once`, first-wins), second entry path, durability; non-vacuity; `bun run check` |
| **Total** | | **≈ 10 h** | M1 may start before feat/a2a merges (pure, no `external/` import); M2–M5 after |

### Backlog (ranked by need; each a later slice, purely additive)

| # | Item | Shape / reuse | Executor |
|---|---|---|---|
| B2 | **Push to the phone** (`notify_owner{title, body}`) | a new push kind from an external caller, labelled "via MCP <caller>", rate-limited; push payload + app rendering to check (`push-notifier.ts`, app), phone/Mac parity | opus plan, sonnet exec |
| B3 | **Workflows** (`workflow_start{name, inputs}`, a task via `origin` = turnId) | `session/workflow{start, turnId}` (A2A S8), `--mcp-workflows` OFF by default, file approval owner-only | sonnet |
| B4 | **Events feed** (`session_events{sessionId, only?}`) | `session/watch` + `watch_next` (bounded long-poll, never an attachment, `packages/protocol/src/watch.ts`) | sonnet |
| B5 | **Start idempotency** (`key` on `session_start`) + long-result paging | `session/log` tail | sonnet |
| B6 | **`notifications/tasks`** over `subscriptions/listen` | optional in the spec; polling covers it | sonnet |
| B7 | **Owner's own sessions** (read / steer phone & TUI sessions) | opt-in caller scope; default stays own (Q6) | opus (§7) |
| B8 | **OAuth 2.1 + RFC 9728** | only if a client cannot send a static header | — |
| B9 | **Per-session model / pod target** | a different serve covers the model today; a pod launch from a remote caller is a laptop effect (§7) → eval first | eval |

## Execution

## Review
