# feat/a2a — `tentacle serve` speaks A2A (server MVP)

> **Status:** implementation — **NOT approved** (rev. 3 after the owner's addendum: owner questions round 3 open)
> **Branch:** `feat/a2a`
> **Size:** L → split into S/M slices · **Blast:** load-bearing (a new external session entry, AGENTS §7 "a remote is not trusted") · **Suited:** Opus plans + executes; mandatory fresh-context Opus review
> **Changelog:** `changelog.d/a2a.added.md`

## Context

*— claude-opus-5-5, 2026-11-25*

Owner 2026-11-25 ~11:25: «la challenge è portare dentro A2A entro stasera a
mezzanotte» — A2A merged on `main` by 24:00 today. TODO entry **feat/a2a** has
two sides; this task is the **SERVER MVP only**: another agent (any A2A
client) discovers `tentacle serve` and gives it a task. The CLIENT side (a
remote A2A agent as a sub-agent) is OUT — it rides
`feat/subagent-harness-runners`.

**What A2A 1.0 asks of a server** (spec https://a2a-protocol.org/latest/specification/, v1.0.0, read 2026-11-25):

- Discovery: `GET /.well-known/agent-card.json`, unauthenticated. Required card
  fields: `name`, `description`, `supportedInterfaces[{url, protocolBinding,
  protocolVersion}]`, `version`, `capabilities{streaming, pushNotifications}`,
  `defaultInputModes`, `defaultOutputModes`, `skills[{id,name,description,tags}]`;
  auth declared in `securitySchemes` (`{httpAuthSecurityScheme:{scheme:"Bearer"}}`)
  + `securityRequirements`.
- Bindings: JSON-RPC 2.0, gRPC, HTTP+JSON — an agent declares the ones it
  serves in `supportedInterfaces`. JSON-RPC methods (PascalCase in 1.0):
  `SendMessage`, `SendStreamingMessage` (SSE over POST, each `data:` a
  `StreamResponse` = one of `task|message|statusUpdate|artifactUpdate`; first
  event is the Task, the stream closes on a terminal or interrupted state),
  `GetTask`, `CancelTask`, `SubscribeToTask`, `ListTasks`, push-config methods.
- `TaskState`: `TASK_STATE_SUBMITTED|WORKING|COMPLETED|FAILED|CANCELED|REJECTED|INPUT_REQUIRED|AUTH_REQUIRED`
  (the last two "interrupted"; COMPLETED/FAILED/CANCELED/REJECTED terminal).
- Parts: presence-discriminated `text` | `raw` (base64) | `url` | `data`, + `mediaType`, `filename`.
- `A2A-Version: 1.0` header on every request; unsupported → `VersionNotSupportedError` −32009.
  A2A errors: TaskNotFound −32001, TaskNotCancelable −32002, PushNotificationNotSupported −32003,
  UnsupportedOperation −32004, ContentTypeNotSupported −32005.
- Credentials: `Authorization: Bearer <token>` on every request.

**SDK check — `@a2a-js/sdk` 1.3.0** (spec 1.0, PascalCase methods): one runtime
dependency (`jose`, pure JS); express/grpc/db are *optional* peers. Installed
size 4.9 MB (both). Its server core is framework-free:
`DefaultRequestHandler(card, InMemoryTaskStore, AgentExecutor)` +
`JsonRpcTransportHandler.handle(body, ServerCallContext)` → a response or an
async generator (the stream) — so it mounts on our existing `Bun.serve`
`fetch` with ~40 lines and **no express**. It gives us for free: JSON-RPC
validation and error codes, A2A-Version validation, the task store and its
state machine, blocking vs `returnImmediately`, the SSE event order,
`SubscribeToTask`, and a client for the e2e test.

**Repro (spike, 2026-11-25, Bun 1.4.3)** — `.tentacle/tmp/a2a-sdk/spike.ts`:
SDK server on a bare `Bun.serve` (bearer check in `fetch`) + an echo
`AgentExecutor`, driven by the SDK client and by raw `fetch`:

```
SendMessage → {"id":"696c…","contextId":"7e56…","status":{"state":3},"artifacts":[{"artifactId":"a1",…"value":"echo: hello"…
SendStreamingMessage events → task | artifactUpdate | statusUpdate
GetTask → 3 ctx true
CancelTask → 5
no token → 401
version 9.9 → {"jsonrpc":"2.0","id":null,"error":{"code":-32009,"message":"The requested A2A protocol version '9.9' is not supported. Supported versions: 1.0",…
unknown method → {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Invalid method."}}
RAW wire → {"jsonrpc":"2.0","id":7,"result":{"task":{"id":"5dbc…","contextId":"9b52…","status":{"state":"TASK_STATE_COMPLETED"},"artifacts":[{"artifactId":"a1","parts":[{"text":"echo: raw"}]}],…
bun 1.4.3
```

(3 = COMPLETED, 5 = CANCELED: the SDK's in-memory types are ts-proto — numeric
`TaskState`, parts as `{content:{$case:"text",value}}`; the WIRE is spec JSON
with string enums, as the RAW line shows. The executor must use the SDK's
`TaskState`/`Role` enums and `$case` parts.)

**Decision: SDK server core on our `Bun.serve`, JSON-RPC binding only.** Smallest
robust option: hand-writing the JSON-RPC dispatch, the task state machine,
blocking semantics, SSE ordering and resubscribe is ~500 lines we would have
to get right and keep in step with the spec; the SDK is one pure-JS dep and
the glue is small. Not express (an extra framework for one route), not
REST/gRPC (one binding is compliant; JSON-RPC is the one every A2A client
speaks).

Today `serve` has no A2A route: `startWsServer`'s `fetch` answers every
non-upgrade request with 401 or 426 (`packages/daemon/src/ws-server.ts:371-378`).

## Implementation

*— claude-opus-5-5, 2026-11-25 (rev. 2: Q1 option, Q3 scope; rev. 3: one work-unit vocabulary, A2A tasks a projection of the session log — no A2A store)*

### Load-bearing assumption

**An in-process client — a real `Connection` on one end of
`createChannelPair()` — drives the SAME `SessionHost` a phone does: the session
it creates is listed to, attachable, answerable and cancellable by the owner's
own client, with no new daemon path.** If this holds, A2A adds only a
transport-side adapter (AGENTS §7 "a new target adds only a transport"); no
agent loop, no session code, no protocol change.

Proved by running `.tentacle/tmp/a2a/seam.ts` (2026-11-25): a real
`SessionHost` + `Agent` whose model calls an `ask` tool, then answers; an
"a2a" peer and an "iPhone" peer, each `new Connection(daemonEnd, host)` +
`RpcPeer(clientEnd)` exactly as `ws-server.ts:391-399` builds a socket's
connection:

```
1. a2a open → a2a-ctx-1 created true
2. phone session/list → a2a-ctx-1 "A2A: hello"
3. ask seen by a2a: 1 by phone (replayed on attach): 1
4. a2a updates after phone answered → turn_start tool_call permission_request permission_resolved tool_call_phase tool_call_update agent_message_chunk:"done: 42" turn_end:end_turn
5. a2a tail after phone cancel → turn_end:end_turn turn_start turn_end:cancelled
```

The A2A-created session is listed to the phone (2), the ask is replayed to the
phone on attach and the PHONE's answer resumes the A2A turn (3–4), and the
phone's `session/cancel` ends the A2A turn as `cancelled` (5).

<details><summary>seam.ts (the repro, gitignored — pasted per AGENTS §6)</summary>

```ts
import { Agent } from "@tentacle/agent";
import { type ExecutionEnvironment, type ModelProvider, PermissionBroker, type StreamEvent } from "@tentacle/core";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "../../../packages/daemon/node_modules/zod";
import { Connection } from "../../../packages/daemon/src/connection.ts";
import { SessionHost } from "../../../packages/daemon/src/session-host.ts";

let rounds = 0;
let hang: (() => void) | undefined;
class Model implements ModelProvider {
  readonly id = "m";
  async *stream(): AsyncIterable<StreamEvent> {
    rounds++;
    if (rounds === 1) yield { type: "tool_call", toolCall: { id: "c1", name: "run", arguments: "{}" } };
    else if (rounds === 2) yield { type: "text", delta: "done: 42" };
    else await new Promise<void>((r) => { hang = r; }); // turn 2 hangs until cancelled
    yield { type: "done" };
  }
}
const host = new SessionHost({
  defaultCwd: "/tmp/a2a-seam",
  createAgent: () => {
    const permissions = new PermissionBroker();
    const run = { name: "run", description: "run", inputSchema: z.object({}).passthrough(), permission: "ask" as const, execute: async () => ({ content: "ok" }) };
    const agent = new Agent({ model: new Model(), tools: new ToolRegistry().register(run), env: {} as ExecutionEnvironment, requestPermission: (req, o) => permissions.request(req, o) });
    return { agent, permissions };
  },
});
const connect = async (name: string, updates: string[]) => {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const asks: string[] = [];
  const peer = new RpcPeer(c, {
    onNotification: (m, p: any) => {
      if (m !== "session/update") return;
      const u = p.update;
      updates.push(u.type + (u.type === "agent_message_chunk" ? `:${JSON.stringify(u.content?.text ?? u.content)}` : u.type === "turn_end" ? `:${u.stopReason}` : ""));
      if (u.type === "permission_request") asks.push(u.requestId);
    },
    onRequest: async (m) => { throw new Error(`unexpected ${m}`); },
  });
  await peer.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true }, clientInfo: { name, version: "0", host: name } });
  return { peer, asks };
};
const flush = async (n = 200) => { for (let i = 0; i < n; i++) await Promise.resolve(); await Bun.sleep(5); };

const a2aU: string[] = [];
const phoneU: string[] = [];
const a2a = await connect("a2a", a2aU);
const open: any = await a2a.peer.request("session/open", { sessionId: "a2a-ctx-1", create: true, title: { text: "A2A: hello", source: "user" } });
console.log("1. a2a open →", open.sessionId, "created", open.created);
await a2a.peer.request("session/prompt", { sessionId: "a2a-ctx-1", turnId: "task-1", content: [{ type: "text", text: "hello" }] });
await flush();
const phone = await connect("iPhone", phoneU);
const list: any = await phone.peer.request("session/list", {});
console.log("2. phone session/list →", list.sessions.map((s: any) => `${s.sessionId} "${s.title}"`).join(", "));
await phone.peer.request("session/open", { sessionId: "a2a-ctx-1" });
await flush();
console.log("3. ask seen by a2a:", a2a.asks.length, "by phone (replayed on attach):", phone.asks.length);
await phone.peer.request("session/resolve_permission", { sessionId: "a2a-ctx-1", requestId: phone.asks[0], optionId: "allow_once" });
await flush();
console.log("4. a2a updates after phone answered →", a2aU.join(" "));
await a2a.peer.request("session/prompt", { sessionId: "a2a-ctx-1", turnId: "task-2", content: [{ type: "text", text: "again" }] });
await flush();
phone.peer.notify("session/cancel", { sessionId: "a2a-ctx-1" });
hang?.();
await flush();
console.log("5. a2a tail after phone cancel →", a2aU.slice(-3).join(" "));
```
(`flush` sleeps here only because this is a throwaway repro; the real tests poll with `until`, §9.)
</details>

### Preconditions

- **One session path.** A socket becomes `new Connection(channel, sessionHost, …)`
  (`ws-server.ts:391-399`); the adapter builds the identical object over
  `createChannelPair()` (`packages/transport/src/channel.ts:77`). Every session
  command (`session/open` `session/prompt` `session/cancel` `session/detach`)
  is the phone's own (`packages/protocol/src/methods.ts:133-160`, `:290`).
- **Asks are session state, answered by any attached client; no timeout**
  (`packages/protocol/src/permission.ts:3-10`). An ask waits for a client when
  none is attached, and is denied at once only when some client IS attached
  and none declared `permission_request` (`hosted-session.ts:1652-1662`,
  re-checked on attach/detach `:1689-1702`). ⇒ The adapter MUST declare
  `permission_request` (or an A2A-only attachment denies every ask) and MUST
  NOT answer it.
- **`askedOn` lists only attachments that set `ClientInfo.host`**
  (`hosted-session.ts:1672-1682`) ⇒ the adapter sends no `host`, so the phone
  never says "also asked on A2A".
- **Hooks trust:** the host's own store decides first; otherwise the
  *prompting client* is asked via `hooks/trust` (`connection.ts:1179-1195`).
  The prompting client here is the adapter ⇒ it answers `{trusted:false}` (an
  untrusted remote never creates a lasting approval, AGENTS §7).
- **Cancel is per-turn:** `session/cancel{sessionId, turnId}` stops only that
  turn (`protocol/src/session.ts:538-548`, `connection.ts:1197-1205`).
- **Ids:** `SessionIdSchema` is any non-empty string (`session.ts:26`);
  `TurnIdSchema` ≤ 128 chars (`session.ts:439`), never `wake-…` (`:452`).
  A2A ids are UUIDs (36 chars) ⇒ `sessionId = "a2a-" + contextId`,
  `turnId = taskId`.
- **Persistence is free:** a `serve` session is persisted by the daemon's
  `SessionPersister` whoever created it (`packages/cli/src/serve.ts:595-602`);
  archiving on TTL/close is the host's (AGENTS §7 persistence).
- **No protocol change:** the adapter speaks the existing protocol as a client
  ⇒ no `protocol.d/` note, no `PROTOCOL_VERSION` bump.
- **Prompt blocks:** `text | image | resource | attachment | document`
  (`packages/protocol/src/content.ts:99-105`); `TurnInProgress` = −32004
  (`packages/protocol/src/jsonrpc.ts:34`); `DEFAULT_MAX_FRAME_BYTES` = 8 MiB
  (`packages/daemon/src/device-accept.ts:40`).
- **Exposure today:** `serve` takes `--token` / `--token-command`
  (`packages/cli/src/flags.ts:74,98-141`; `ServeOptions.token`,
  `serve.ts:117-120`), checked constant-time by `tokensMatch`
  (`ws-server.ts:201-208`); browsers are default-denied by `Origin`
  (`ws-server.ts:218-223`).

- **A reloaded turn keeps its `turnId`.** A turn suspended on its own call's
  permission is resumed under the SAME id (`ResumedTurn.turnId`,
  `packages/daemon/src/persisted-session.ts:343-346`, keyed on
  `record.turns` `:396`); any other cut turn is closed with
  `RESTART_TURN_END` (`stopReason:"error"`, "interrupted: the daemon
  restarted", `:335-341`).
- **A turn's state is readable without side effects:**
  `HostedSession.knownTurn(turnId)` → `{turnId}` (running) / `{turnId, ended}` /
  `undefined` (`hosted-session.ts:3275-3281`); the turn keys survive an
  archive/reopen (`:4950-4958`). ⇒ the projection READS a turn's state; nothing
  A2A-side ever re-sends a prompt (a key the daemon no longer has would
  otherwise RUN the task a second time).
- **The push grace already arbitrates "first answer wins":** an ask answered
  before its grace ends is never pushed; an attached device is never pushed
  (`packages/daemon/src/push-rules.ts:14-28`). The A2A adapter is not a
  registered device, so it never suppresses the owner's push.
- **SDK seams** (`@a2a-js/sdk` 1.3.0): `TaskStore { save, load, list }`
  (scoped by `context.user`) — implemented here as a projection; `AgentExecutor.execute` is called again with
  `requestContext.task` set for a follow-up message on an interrupted task;
  the handler keeps the event bus alive in `INPUT_REQUIRED`/`AUTH_REQUIRED`
  (`DefaultRequestHandlerOptions`, `dist/server/index.d.ts:267-280`).

### Owner answers

*2026-11-25 ~11:20, verbatim:*

1. **Who answers an A2A task's asks:** «deve essere opzionabile, per supportare entrambi gli scenari»
2. **Token:** dedicated A2A token (`--a2a-token-command`), opens only `/a2a` — as recommended.
3. **MVP cuts:** «preferisco sforare la mezzanotte ma fare le cose pulite in ottica design robusto e risparmio tokens se questo MVP non soddisfacesse queste richieste»
4. **SDK:** yes, `@a2a-js/sdk`.

*Addendum 2026-11-25 ~11:35 (binding), verbatim:* «riusciamo poi a uniformare i tasks dei workflows con questi? cerchiamo di deduplicare e tenere pulito e uniforme il più possibile» — an A2A Task must NOT become a fourth "unit of work with a state" beside workflow runs, sub-agents and turns.

### Survey — the units of work tentacle already has (rev. 3)

| | Turn | Workflow run | Background sub-agent |
|---|---|---|---|
| **Id** | `turnId`, client-chosen, ≤ 128 (`protocol/src/session.ts:439`); `wake-…` reserved for the daemon (`:452`) | `wf-N`, session-scoped (`agent/src/workflow-driver.ts:1152-1153`), never reused after a restart: seeded from history (`reserveRunIds`, `:607-616`); `WorkflowRunIdSchema` (`protocol/src/session-log.ts:323-326`); a rerun keeps the id (`workflow-driver.ts:1196-1199`) | `sa-N` (`protocol/src/session.ts:718-719`) |
| **States** | running → ended with `StopReason` `end_turn`/`max_tokens`/`max_iterations`/`max_token_budget`/`cancelled`/`error` (`session.ts:493-500`); suspended on a pending ask (`permission.ts:3-10`) | `needs-approval`/`running`/`waiting`/`ok`/`error`/`stopped` + stopReason `budget`/`timeout`/`cancelled`/`interrupted`/`changed` — free words (`session.ts:836-839`) | free string `state` (`session.ts:724-725`); end `stopReason` free, `killed` included (`session-log.ts:273-274`) |
| **Started by** | `session/prompt` | `session/workflow{action:"start", …, turnId}` — **the start already carries a `turnId`** (`session.ts:883-900`), logged as `workflow_start.turnId` (`session-log.ts:366-367`) | the `agent_task` tool, inside a turn |
| **Persisted (session log, all NON-critical)** | `turn_start{turnId}`, `turn_end{turnId, stopReason}` (`session-log.ts:227-241`) + the sidecar's turn keys and pending asks (`daemon/src/persisted-session.ts:343-346,396`) | `workflow_start`/`workflow_step`/`workflow_end{state, stopReason, reason}` (`session-log.ts:353-405`); `running`/`waiting` live in memory and on the wire only (`:316`) | `subagent_background`/`subagent_end{stopReason, report}` (`session-log.ts:257-276`) |
| **Closed honestly at load** | `RESTART_TURN_END` (`persisted-session.ts:335-341`) | `workflowLoadNotes` (`core/src/workflow-ledger.ts:286`) | `subagentLoadNotes` (`core/src/agent-job-ledger.ts:382`) |
| **Phone/TUI read** | `turn_start`/`turn_end` updates (mandatory, `protocol/src/updates.ts:572-573`), the snapshot | `workflows` update rows (`updates.ts:598-599`) + `workflow/list` (serve, every live session) | `subagents` update rows (`updates.ts:582-583`) |
| **Daemon holds in memory** | `knownTurn(turnId)` (`daemon/src/hosted-session.ts:3275-3281`) | the driver's runs + rows (`workflow-driver.ts:547-579`) | the job rows |

**Finding:** every fact an A2A Task needs is ALREADY durable in the session log
(the current segment is in memory: `daemon/src/session-log.ts:73-90`), keyed by
ids tentacle already mints. The three units differ only in their **state
words**. So the deduplication is: **one lifecycle vocabulary + one projection
seam**, and **no A2A store at all** (rev. 2's per-task files are dropped).

### Unification (rev. 3)

**One vocabulary — `packages/core/src/work-unit.ts` (pure, React-free, new):**

```ts
type WorkUnitKind = "turn" | "workflow";            // "subagent" = follow-up F2
type WorkUnitState = "working" | "waiting" | "completed" | "failed" | "canceled";
interface WorkUnit {
  kind: WorkUnitKind; id: string;                   // turnId | wf-N
  origin?: string;                                  // the turnId that started it (workflow_start.turnId)
  state: WorkUnitState;
  waitingFor?: "permission" | "approval";           // a tool ask | a workflow file's approval
  native: string;                                   // the unit's own word, kept for display/debug
  reason?: string;                                  // one line: why it ended / what it waits for
  startedAt?: number; endedAt?: number;
  result?: string;                                  // turn: the final round's text; workflow: end reason + last step report
}
```

Native → unified (one table each, unit-tested): turn `end_turn`/`max_*` →
`completed` (`max_*` keeps a `reason`), `cancelled` → `canceled`, `error` →
`failed`, pending ask → `waiting:permission`, else `working`. Workflow
`needs-approval` → `waiting:approval`, `waiting` → `waiting:permission`,
`running` → `working`, `ok` → `completed`, `error` → `failed`, `stopped:cancelled`
→ `canceled`, any other `stopped:*` → `failed` with the stopReason as `reason`;
an unknown free word → `working` if not ended, `failed` if ended (a newer
build's word never breaks a reader). Projections: `turnUnits(entries, live)`,
`workflowUnits(entries, rows)` → `WorkUnit[]`, from the log entries above plus
the live state — **no new entry, no new field, no wire change**.

**One seam — `HostedSession.workUnits()`** (daemon, read-only, ~40 lines): the
session's units projected from its in-memory segment + live state (`knownTurn`,
pending asks, the driver's rows). This is the ONE place an A2A task's state is
read; the log stays the ONE place it is stored.

**A2A Task = projection of a `WorkUnit`** (`daemon/src/a2a/task-projection.ts`):
- `taskId` ↔ the unit: a turn task's `turnId` IS the `taskId`; a workflow
  task's `workflow_start.turnId` IS the `taskId` (the SDK mints UUID task ids —
  `crypto.randomUUID()`, `@a2a-js/sdk dist/server/index.js:2802` — and we pass
  that id as the `turnId`). Rule: `turn_start{taskId}` exists → turn task, else
  `workflow_start{turnId: taskId}` → workflow task.
- `contextId` ↔ session `a2a-<caller>-<contextId>`; owner = caller (in the id).
- Task `status` ← `WorkUnitState` (table in Design); `artifacts[response]` ←
  `result`; `history` ← the caller's message (the turn's user message / the
  workflow's inputs), never agent text.
- The SDK `TaskStore`: `save` keeps ONLY in-flight tasks in memory (the SDK's
  streaming bookkeeping); `load`/`list` = the live entry if any, else the
  projection. A terminal task is dropped from memory: its truth is the log.
- `taskId → session` index: in memory, rebuilt lazily by scanning the
  caller's live `a2a-<caller>-*` sessions' segments (a derived cache, never
  persisted).

**What this buys:** a workflow started via A2A is an A2A task with no
workflow-specific A2A code (start = one `session/workflow` call; tracking =
the shared projection); every workflow run in a caller's context is pollable
by `GetTask`; restart needs no reconciliation (the daemon already reloads and
closes the log, the projection just reads it); deleting a session deletes its
tasks.

**Unified IN THIS BRANCH:** the vocabulary (turn + workflow tables), the
projection seam, A2A tasks as its projection, workflow start via A2A.

**Later, purely additive (named follow-ups, not in this branch):**
- **F1 `feat/work-units-wire`** — expose the seam as `session/work_units` (a new method: free per §7) so the phone/TUI show turns, runs and sub-agents with ONE state chip/vocabulary; `workflow/list` becomes its projection.
- **F2 `feat/subagents-as-work-units`** — the sub-agent table (`subagent_*` entries + rows) in the same vocabulary; background sub-agents of an A2A turn exposed as related tasks (`referenceTaskIds`).
- **F3 `feat/work-units-survive-compaction`** — carry each ended unit's terminal fact across a compaction/`context_reset` (a NON-critical entry, re-logged like `workflow_start` already is), so `GetTask` finds tasks older than the in-memory segments.
- **F4 `feat/a2a-archived-tasks`** — `GetTask` of a task in an ARCHIVED context reads the archived log read-only (never reopening it).
- **F5** — the workflow driver's free-string states typed from the vocabulary (internal; the wire words stay free).

### Scope (rev. 3 — every cut re-examined; owner Q3 + addendum)

A cut stays OUT only if adding it later is purely additive.

| Item | Rev. 3 | Why |
|---|---|---|
| Agent Card, `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `SubscribeToTask`, `ListTasks` | **in** | MVP; Subscribe/List are free with the SDK + projection |
| Task records | **no A2A store**: tasks are a projection of the session log + live state | addendum: no fourth store; the log is already durable, reloaded and closed honestly at start |
| Unified vocabulary + `workUnits()` seam (turn, workflow) | **in** | the one place state is read; the A2A mapping depends on it |
| Workflow start via A2A | **in**, behind a per-caller switch (Q5) | addendum: a workflow via A2A = a task with no extra code |
| Caller identity in the session id `a2a-<caller>-<contextId>` | **in** | adding it later would rename sessions (not additive) |
| Who answers asks: per-caller `owner \| both` | **in** | owner Q1 |
| Reopen an archived own context on a new message | **in** | multi-turn must not die at the idle TTL |
| Final-round-only `response` artifact, deltas streamed, history = caller messages only, no tool/thought/usage output | **in** | token saving |
| Tasks older than the in-memory segments / in archived contexts | **out** → `TaskNotFound` (Q6) | F3/F4, additive |
| Sub-agents as work units / tasks | **out** | F2, additive |
| Phone/TUI on the shared vocabulary | **out** | F1, additive |
| Per-tool status updates | **out** | token saving; opt-in extension later |
| Inbound `raw`/`url` parts (−32005); outbound files (later by reference); REST/gRPC; webhooks; A2A 0.3; extended/signed card; queueing on a busy context | **out** | each additive later (unchanged from rev. 2) |

### Design

```
A2A caller ──HTTP(S)── Bun.serve fetch (ws-server.ts) ──► a2a/http.ts (A2A token, Origin, size, card, SDK glue, SSE)
                                                             │ SDK DefaultRequestHandler + a2a/task-projection.ts (TaskStore = projection)
                                                             ▼                                   ▲ reads
                                                 a2a/executor.ts (AgentExecutor)        HostedSession.workUnits()  ◄── core/work-unit.ts (vocabulary + projections)
                                                             ▼ createChannelPair()               ▲
                                       Connection ──► SessionHost (the SAME one the phone/TUI use; its session log = the one store)
```

**WorkUnit → A2A (pure, `a2a/mapping.ts`):**

| WorkUnit | A2A `TaskState` |
|---|---|
| `working` | `WORKING` |
| `waiting:permission`, caller `owner` | `WORKING` + status message "waiting for the owner's approval: <title>" |
| `waiting:permission`, caller `both` | `INPUT_REQUIRED` + the ask (below) |
| `waiting:approval` (a workflow file) | `WORKING` + "waiting for the owner to approve workflow <name>" — **always owner-only**, in every mode: approving a file hash is a LASTING approval |
| `completed` | `COMPLETED` (+ `reason` as status message when present) |
| `failed` | `FAILED` (+ `reason`, already redacted) |
| `canceled` | `CANCELED` |

| A2A input | tentacle |
|---|---|
| caller (the A2A token's name; `default` from the CLI) | `ServerCallContext.user`; session-id prefix |
| `contextId` | session `a2a-<caller>-<contextId>` (`title:{text:"A2A: <first line ≤60>", source:"user"}`; reopened if archived) |
| `text` parts | one `{type:"text"}` block |
| `data` part `{"tentacle/workflow": {name, inputs}}` | `session/workflow{action:"start", name, inputs, turnId: taskId}` (only if the caller's `workflows` switch is on, Q5; else UnsupportedOperation) |
| `data` part `{"tentacle/permission": …}` | a caller's answer (below) |
| other `data` parts | `{type:"text"}` block of the JSON, fenced |
| `raw` / `url` parts | −32005, nothing opened |
| `agent_message_chunk` (our turn) | `artifactUpdate response`, `append:true`; first chunk after a `tool_call` → `append:false` (final round only) |
| `workflows` row change (our run) | `statusUpdate` from the projected unit; at the end `artifactUpdate response` = `result` |

**Asks answered by the caller (Q1)** — unchanged from rev. 2: per caller (=
per token) `asks: "owner"` (default) | `"both"`; in `both`, `INPUT_REQUIRED`
lists every pending ask of the task (a turn's, or a workflow step's: its asks
carry the run's `turnId` = the task id) with options filtered to
`allow_once`/`reject_once`; the caller answers with a `data` part
`{"tentacle/permission": {requestId, decision:"allow"|"deny", message?}}` or,
with exactly one ask pending, the text `allow`/`approve`/`yes` (anything else
= deny, the text as the refusal reply when offered: fail-closed). The adapter
(trusted, daemon-side) maps the decision to the ask's own `*_once` option; a
caller never names an `optionId`, so no lasting approval is reachable from
A2A. No "caller-only" mode: the owner is always raised the ask, and the push
grace keeps the phone silent when the caller answers in time
(`push-rules.ts:14-28`). Never sent by the adapter: `set_auto_accept`,
`set_capability`, `update_settings`, a `skill`, `hooks/trust: true`, a
workflow approval.

**Executor (`a2a/executor.ts`)** — `execute(requestContext, bus)`:
- **New task:** map parts → `createChannelPair()` + `new Connection(daemonEnd,
  host, onError, {hooksTrustPrecheck})` + `RpcPeer(clientEnd)` (`hooks/trust` →
  `{trusted:false}`, any other request → `MethodNotFound`) → `initialize`
  (`clientInfo:{name:"a2a"}`, no `host`; `updates` incl. `permission_request`)
  → `session/open{create:true, reopen:true}` on `a2a-<caller>-<contextId>`
  only → publish the Task (`WORKING`) → `session/prompt{turnId: taskId}` or
  `session/workflow{start, turnId: taskId}` → on each relevant update,
  re-project the unit (`workUnits()`) and publish what changed → at the
  terminal state `bus.finished()`, `session/detach`, close the channel.
- **Follow-up on a live task** (`requestContext.task` set) → the caller-answer
  path; on a terminal task → SDK error.
- **After a restart:** no reconciliation. A follow-up or `SubscribeToTask` on a
  task whose unit is still `working`/`waiting` (a resumed turn, `persisted-session.ts:343-346`)
  attaches a watcher lazily; `GetTask` just projects.
- `cancelTask(taskId)` → turn: `session/cancel{sessionId, turnId}`; workflow:
  `session/workflow{action:"stop", runId}`. `CANCELED` comes from the
  projection (one source of truth; the owner's stop from the phone is the
  same path).

**HTTP (`a2a/http.ts`)** — unchanged from rev. 2: public
`/.well-known/agent-card.json` (one skill `tentacle-session`; it names no
workflow — Q5), `POST
/a2a` with Origin → 401, A2A-token bearer → else 401 + audit, 1 MiB → 413,
`validateVersion`, JSON or SSE (`: ping` every 15 s), `server.timeout(req, 0)`;
off without an A2A token.

### Files

1. `packages/core/src/work-unit.ts` (new, pure) + `packages/core/src/index.ts` export — vocabulary, native→unified tables, `turnUnits`, `workflowUnits`.
2. `packages/daemon/src/hosted-session.ts` — `workUnits()` read-only seam (~40 lines).
3. `packages/daemon/package.json` — `"@a2a-js/sdk": "1.3.0"` (pinned) + `bun.lock`.
4. `packages/daemon/src/a2a/mapping.ts` (new, pure) — parts→blocks/workflow start, WorkUnit→A2A, round replace, ask message, answer parser, card, session id.
5. `packages/daemon/src/a2a/task-projection.ts` (new) — the SDK `TaskStore` as a projection + the derived `taskId → session` index.
6. `packages/daemon/src/a2a/executor.ts` (new) — the `AgentExecutor` + live watchers.
7. `packages/daemon/src/a2a/http.ts` (new) — route, auth, SDK glue, SSE.
8. `packages/daemon/src/ws-server.ts` — `WsServerOptions.a2a?`; `fetch` calls `a2a.handle(req)` first (≈10 lines).
9. `packages/daemon/src/index.ts` — exports.
10. `packages/cli/src/flags.ts` — `serve`: `a2a-token`, `a2a-token-command`, `a2a-asks`, `a2a-workflows`.
11. `packages/cli/src/serve.ts` — `ServeOptions.a2a` → `startWsServer`; startup line "A2A on …/a2a (asks: owner, workflows: off)".
12. `packages/cli/src/main.ts` — help text.
13. `changelog.d/a2a.added.md`; `README.md` "A2A" section; `TODO.md` (feat/a2a + the follow-ups F1–F5).

No `protocol.d/` note, no `PROTOCOL_VERSION` bump, no new log entry type
(critical or not), no on-disk format: nothing on the wire or on disk changes.

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| No / wrong token; browser `Origin` | 401 before parsing; audit `a2a-auth-failure`. Card stays public. |
| Unknown method / bad params / bad version | SDK: −32601 / −32602 / −32009. |
| Huge input | > 1 MiB → 413; nothing opened. |
| `raw`/`url` part | −32005, nothing opened. |
| Busy context (another task, the owner typing, a running workflow) | `TurnInProgress` / workflow `running` refusal → UnsupportedOperation; nothing queued, first unit unaffected. |
| Workflow start with the caller's switch off | UnsupportedOperation; nothing started. |
| Workflow file not approved / changed | Unit `waiting:approval` → `WORKING` + message; only the owner approves (every mode). `changed` refusal → `FAILED` with the reason. |
| Caller drops mid-stream | The unit continues; `SubscribeToTask`/`GetTask` read it. |
| `CancelTask` / owner stops | turn cancel / workflow stop → projection `canceled` → `CANCELED`; terminal → `TaskNotCancelable`. |
| Ask, `owner` / `both` | As rev. 2: `WORKING` + message / `INPUT_REQUIRED`, first answer wins, fail-closed text, `*_once` only, late answer = no effect. |
| Hooks trust asked | `false`: hooks run only if the host's own store trusts the folder. |
| `serve` restart | Nothing A2A-side to recover: the daemon reloads and closes its logs (cut turn → `RESTART_TURN_END` → `failed`; open run → `workflowLoadNotes` → `failed: interrupted`; a turn suspended on an ask resumes under the same id → `waiting`), and the projection reads that. |
| Crash mid-task | Same as restart: no second store can disagree with the log. |
| Task older than the in-memory segments (after compaction) / context archived | `TaskNotFound` (Q6; F3/F4). The session itself stays on the phone. |
| Owner deletes the session | Its tasks are gone (`TaskNotFound`): nothing else to clean. |
| Unknown future native state word | Mapped by the "unknown word" rule, never a crash. |
| Two callers | One today (`default`); ids carry the caller, the SDK scopes by owner. |
| contextId naming a phone session | Impossible: only `a2a-<caller>-…` is opened. |
| Model starts a workflow inside an A2A turn | Its `workflow_start.turnId` = the turn's id, but `turn_start{id}` exists → the task stays the TURN; the run is visible to the owner (and becomes a related task in F2's design). |
| Wake turn in an A2A session | Not a task (no caller id maps to it); visible to the owner. |

### Tests

Fakes: the daemon pattern (`session-auto-accept-asked-on.test.ts`: real
`SessionHost` + `Agent` + scripted `ModelProvider`, `Connection` over
`createChannelPair`), the workflow driver's own test fakes for runs; `until`
from `packages/client/test/support/fakes.ts`, never a sleep. Each test names
its mutation (§9).

- `core/test/work-unit.test.ts` (pure): both native→unified tables row by row; unknown words; `turnUnits` from `turn_start`/`turn_end`/messages + live (running, waiting, ended, cut by restart); `workflowUnits` from `workflow_*` + rows (needs-approval, waiting, each `stopped:*`); `result` = final round only / end reason + last report.
- `daemon/test/work-units.test.ts`: `hosted.workUnits()` over a real session for a turn and a workflow run, before and after a reload (mutation: read live state only → the reloaded unit is missing → red).
- `a2a-mapping.test.ts` (pure): WorkUnit→TaskState table (`waiting:approval` is never `INPUT_REQUIRED`, mutation-tested); parts; workflow data part; round replace; ask message `*_once` only; answer parser; card.
- `a2a-executor.test.ts`: as rev. 2 (create, stream, owner/both asks, never `resolve_permission` in owner mode, ask not auto-denied, `*_once` only, cancel, busy, hooks false, detach, reopen) + a workflow task: start via data part → `WORKING` → step ask → answer → `COMPLETED` with `result`; switch off → refused; `waiting:approval` with `both` → still `WORKING` (mutation: map approval like permission → red).
- `a2a-task-projection.test.ts`: `GetTask` of a running / ended / restarted (reloaded host) turn and workflow; `ListTasks` per context and owner; a deleted session → `TaskNotFound`; **no write anywhere** (spy on the store dir: zero A2A files — the "no fourth store" property; mutation: persist a record → red).
- `a2a-http.test.ts` (real `startWsServer`, loopback, port 0): as rev. 2.
- **e2e** `a2a-e2e.test.ts`: `startDaemon` + the **SDK client**: card → `sendMessage` → `sendMessageStream` → `getTask` → `listTasks` → `cancelTask` → a workflow task (switch on) → WS client sees `a2a-default-<ctx>`; caller aborts mid-stream, unit still completes; **restart** on the same store → `getTask` returns the finished turn and run.

### Slices (executor: Opus; wall-clock estimates)

| # | Slice | Size | Est. |
|---|---|---|---|
| S0 | **work-units** — `core/work-unit.ts` (vocabulary, tables, `turnUnits`, `workflowUnits`) + `HostedSession.workUnits()` + tests | M | 1 h 45 |
| S1 | **mapping** — dep + `bun build --compile` smoke + `a2a/mapping.ts` + tests | M | 1 h |
| S2 | **executor** — turn tasks: create/reopen, stream, round replace, cancel, detach, owner-mode asks, hooks + tests | M | 1 h 30 |
| S3 | **caller-asks** — `both` mode: `INPUT_REQUIRED`, live-watcher routing (incl. lazy after restart), `*_once` answers, owner-first + tests | M | 1 h 15 |
| S4 | **task-projection** — SDK `TaskStore` as projection, `taskId → session` index, `GetTask`/`ListTasks`, restart via reload + tests | M | 1 h 15 |
| S5 | **workflow-tasks** — start via data part, per-caller switch, `waiting:approval` owner-only, stop, `result` + tests | M | 1 h |
| S6 | **http-route** — `http.ts` + `ws-server.ts` hook, auth/Origin/413/version/SSE/timeout + tests | M | 1 h |
| S7 | **cli-e2e** — flags, serve wiring, help, README, changelog, TODO follow-ups, e2e (incl. restart) | M | 1 h 15 |
| R | **review** — fresh-context Opus (§7 "remote not trusted", single session path, "no fourth store", workflow approval owner-only) + one fix round + `bun run check` | — | 1 h 30 |
| | **Total** | | **≈ 11 h 30** (serial; from ~12:30 → ~24:00 — at the midnight line, as the owner accepted) |

### Owner questions (round 3)

5. **May an A2A caller START workflows?** **Recommendation: a per-caller switch, default OFF** (`serve --a2a-workflows`). When on: a workflow whose file you already approved runs without asking you again (that is what your approval of that hash means); a new or changed file waits for YOUR approval on the phone — never the caller's, in any asks mode. The public Agent Card names no workflows (the caller is told the names out of band, or by the follow-up extended card).
6. **Task retention for now:** `GetTask` finds a task while its context is live and the task is in the session's in-memory log segments; after a compaction, or once the context is archived by the idle TTL, it answers "not found" (the session itself stays, on your phone). Making them always findable is F3/F4 (additive). **Recommendation: accept for this branch.**

No new log entry, no `critical: true` type, no wire change in this branch.

## Execution

## Review
