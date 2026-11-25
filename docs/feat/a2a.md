# feat/a2a — `tentacle serve` speaks A2A (server MVP)

> **Status:** implementation — **APPROVED (owner answers 2026-11-25)** (rev. 4: round-3 answers; F3 + F4 in; executor per slice)
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

*— claude-opus-5-5, 2026-11-25 (rev. 2: Q1 option, Q3 scope; rev. 3: one work-unit vocabulary, A2A tasks a projection of the session log — no A2A store; rev. 4: `unit_end` carry at every segment boundary (F3, corrects rev. 3 on restarts), archived read-only (F4), owner-only ask kinds, executor per slice)*

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

*Round 3, 2026-11-25 ~12:00, verbatim:*

5. **May an A2A caller start workflows:** the recommended switch — `--a2a-workflows` per caller, OFF by default; an approved file runs, a new/changed file always waits for the OWNER's approval, never the caller's.
6. **Task retention:** «Subito» — F3 (tasks survive compaction) and F4 (tasks of archived contexts) come INTO this branch, designed properly (robust, additive-safe); going past midnight is accepted.

*Routing, 2026-11-25:* «ottimizziamo con sonnet quando possiamo» — Sonnet executes where a mistake is cheap to iterate on (contained, well-tested seams); Opus where a slice touches an AGENTS §7 invariant; the final review stays a fresh-context Opus.

### Survey — the units of work tentacle already has

| | Turn | Workflow run | Background sub-agent |
|---|---|---|---|
| **Id** | `turnId`, client-chosen, ≤ 128 (`protocol/src/session.ts:439`); `wake-…` reserved for the daemon (`:452`) | `wf-N`, session-scoped (`agent/src/workflow-driver.ts:1152-1153`), never reused after a restart (`reserveRunIds`, `:607-616`); `WorkflowRunIdSchema` (`protocol/src/session-log.ts:323-326`); a rerun keeps the id (`workflow-driver.ts:1196-1199`) | `sa-N` (`protocol/src/session.ts:718-719`) |
| **States** | running → ended with `StopReason` `end_turn`/`max_tokens`/`max_iterations`/`max_token_budget`/`cancelled`/`error` (`session.ts:493-500`); suspended on a pending ask (`permission.ts:3-10`) | `needs-approval`/`running`/`waiting`/`ok`/`error`/`stopped` + stopReason `budget`/`timeout`/`cancelled`/`interrupted`/`changed` — free words (`session.ts:836-839`) | free string `state` (`session.ts:724-725`); end `stopReason` free, `killed` included (`session-log.ts:273-274`) |
| **Started by** | `session/prompt` | `session/workflow{action:"start", …, turnId}` — **the start already carries a `turnId`** (`session.ts:883-900`), logged as `workflow_start.turnId` (`session-log.ts:366-367`) | the `agent_task` tool, inside a turn |
| **Persisted (session log, all NON-critical)** | `turn_start{turnId}`, `turn_end{turnId, stopReason}` (`session-log.ts:227-241`) + the sidecar's turn keys and pending asks (`daemon/src/persisted-session.ts:343-346,396`) | `workflow_start`/`workflow_step`/`workflow_end{state, stopReason, reason}` (`session-log.ts:353-405`); `running`/`waiting` live in memory and on the wire only (`:316`) | `subagent_background`/`subagent_end{stopReason, report}` (`session-log.ts:257-276`) |
| **Carried into a NEW segment** (`logSegmentFacts`, `daemon/src/hosted-session.ts:2449-2471`) | **nothing** | only a LIVE run's `workflow_start` (`:2464-2470`) | **every fact, ended ones with their report** (`:2457-2463`) — the precedent this plan follows |
| **Closed honestly at load** | `RESTART_TURN_END` (`persisted-session.ts:335-341`) | `workflowLoadNotes` (`core/src/workflow-ledger.ts:286`) | `subagentLoadNotes` (`core/src/agent-job-ledger.ts:382`) |
| **Phone/TUI read** | `turn_start`/`turn_end` updates (mandatory, `protocol/src/updates.ts:572-573`), the snapshot | `workflows` update rows (`updates.ts:598-599`) + `workflow/list` | `subagents` update rows (`updates.ts:582-583`) |
| **Daemon holds in memory** | `knownTurn(turnId)` (`hosted-session.ts:3275-3281`) | the driver's runs + rows (`workflow-driver.ts:547-579`) | the job rows |

**Segment boundaries** — a new segment starts at a compaction, a
`context_reset`, a `/clear` (`historyReplaced`, `hosted-session.ts:4796-4838`)
**and at every reload** (`this.log.start(…, "reload", …)` then
`logSegmentFacts()`, `hosted-session.ts:1240-1255`). The in-memory
`SessionLog` holds the current (and previous) segment only
(`daemon/src/session-log.ts:73-90`).

> **Correction of rev. 3.** Rev. 3 said "restart needs no reconciliation: the
> projection reads the log". False for turns: after a reload the in-memory
> segment holds the messages but NOT the earlier `turn_start`/`turn_end`
> markers (`hosted-session.ts:1245`), and nothing carries them. So F3's carry
> is needed for RESTARTS too, not only for compactions. One mechanism covers
> all four boundaries (below).

**Finding:** the three units differ only in their state words and in what a
new segment keeps. Sub-agents already show the right shape: their ended facts
are carried into every new segment. Turns and workflow runs get the same
treatment, through one unified record.

### Unification

**1. One vocabulary — `packages/core/src/work-unit.ts` (pure, new):**

```ts
type WorkUnitKind = "turn" | "workflow";            // "subagent" = follow-up F2
type WorkUnitState = "working" | "waiting" | "completed" | "failed" | "canceled";
interface WorkUnit {
  kind: WorkUnitKind; id: string;                   // turnId | wf-N
  origin?: string;                                  // the turnId that started it (workflow_start.turnId)
  state: WorkUnitState;
  waitingFor?: "permission" | "approval";           // a tool ask | a workflow file's approval
  native: string;                                   // the unit's own word (display/debug)
  reason?: string;                                  // one line
  startedAt?: number; endedAt?: number;
  result?: string; resultDropped?: true;            // turn: final round's text; workflow: end reason + last step report
}
```

Native → unified (one table each, unit-tested): turn `end_turn`/`max_*` →
`completed` (`max_*` keeps a `reason`), `cancelled` → `canceled`, `error` →
`failed`, pending ask → `waiting:permission`, else `working`. Workflow
`needs-approval` → `waiting:approval`, `waiting` → `waiting:permission`,
`running` → `working`, `ok` → `completed`, `error` → `failed`,
`stopped:cancelled` → `canceled`, other `stopped:*` → `failed` + reason; an
unknown word → `working` if not ended, else `failed` (a newer build's word
never breaks a reader). Pure functions: `unitsFromSegment(entries)`
(native entries + carried `unit_end` entries of ONE segment → ended and open
units, results computed by ONE function `turnResult(messages, span)`) and
`unifyTurn` / `unifyWorkflow` for live state. *(S0 correction: no `messages`
parameter. A turn's span is only knowable by folding the entries
(`projectEntry`); a final `messages` array has no per-turn boundaries. A
segment cut mid-turn has no `turn_start`: `base.turn` names the turn and its
span starts after the base's `count` messages.)*

**2. One persisted record shape for an ended unit carried across segments —
`unit_end`, a NEW NON-critical log entry** (`protocol/src/session-log.ts`):

```ts
{ type: "unit_end", kind: Word, unitId: string(≤128), origin?: TurnId,
  state: Word, native: Word, reason?: string(≤2 KiB),
  startedAt?: int, endedAt: int, result?: string(≤ 16 KiB), resultDropped?: true }
```

- Written ONLY by `logSegmentFacts` (the carry), never at a unit's end: inside
  a segment the native entries (`turn_*`, `workflow_*`) are the record; across
  segments `unit_end` is. One fact is never stored twice in one segment.
- *(S0 correction for S1: `native` can be `stopped:<stopReason>` (≤ 65
  chars), so `Word` is a plain bounded string, NOT `WorkflowWordSchema`, whose
  regex refuses `:` and stops at 32.)*
- Every word is a **bounded free string, never an enum** (the workflow
  entries' rule, `session-log.ts:313-320`: a malformed KNOWN entry makes a
  reader refuse the whole log, so a newer word must never poison an older
  reader); the emitter caps every text.
- NON-critical ⇒ an older build skips it and loses nothing it can project
  (`session-log.ts:12-19`): **no `PROTOCOL_VERSION` bump, no `protocol.d/`
  note, no owner decision** (only `critical: true` types are the owner's).
  `protocol.json` is regenerated by `bun run protocol:bump` at merge, as
  always.
- **Bounds (decided here, documented, constants):** a session carries its
  newest **256** ended units; results share a **256 KiB** budget per segment,
  newest first, each ≤ **16 KiB** — a unit over budget keeps its state and
  reason with `resultDropped: true`. Same shape as the sub-agent report caps.

**3. One seam — `HostedSession.workUnits()`** (daemon, read-only): live units
(the running turn via `knownTurn` + its pending asks; the driver's live
runs) + the session's **ended-units table** (bounded as above). The table is
filled (a) at load, from `unitsFromSegment` over the last segment's entries
(`daemon-state-file.ts:520-536` already derives sub-agent and workflow notes
from the same `derivedFrom` entries), and (b) live, when a turn or run ends —
with the SAME `turnResult` function over the segment's entries, so a crash
and a live end give the identical record. `logSegmentFacts` carries the table
as `unit_end` entries. The log stays the one store; the table is a cache of
it.

**4. A2A Task = projection of a `WorkUnit`** (`daemon/src/a2a/task-projection.ts`):
- `taskId` ↔ unit: a turn task's `turnId` IS the `taskId`; a workflow task's
  `origin` (`workflow_start.turnId`) IS the `taskId`. The SDK mints UUIDs
  (`crypto.randomUUID()`, `@a2a-js/sdk dist/server/index.js:2802`) and we pass
  that id as the `turnId`. Rule: a turn unit with that id wins; else a
  workflow unit whose `origin` is that id.
- `contextId` ↔ session `a2a-<caller>-<contextId>`; owner = caller (in the id).
- `status` ← `WorkUnitState`; `artifacts[response]` ← `result` (with
  `resultDropped` → a status message "result no longer retained"); `history`
  ← the caller's messages while their segment is live, else empty (allowed by
  the spec; no re-sending).
- SDK `TaskStore`: `save` keeps ONLY in-flight tasks in memory; `load`/`list`
  = the live entry, else the projection. A terminal task leaves memory.
- **Archived contexts (F4):** a context archived by the idle TTL or a close is
  read **read-only, never reopened**: `store.readRaw(id)`
  (`daemon/src/session-log-store.ts:1229`) → the daemon loader's pure parse
  (`daemon-state-file.ts`, the same code a reload runs, which writes nothing)
  → `unitsFromSegment`. A small LRU (8 sessions, keyed on the file's size +
  mtime) avoids re-reading. An unknown `schemaVersion` / unreadable file →
  `TaskNotFound` + an audit line; the files are never touched (AGENTS §7
  on-disk rule).
- **`taskId → session` index:** in memory, derived, never persisted. Live
  sessions: from `workUnits()`. Archived ones: on the first miss, the caller's
  `a2a-<caller>-*` entries of `store.list()` (`session-log-store.ts:1388`,
  sidecar + first line only) are projected once (through the LRU) and indexed;
  a session's archive moves its units to the archived side of the index;
  a deleted (tombstoned) session is absent from `list()` → `TaskNotFound`.

**What this buys:** a workflow started via A2A is an A2A task with no
workflow-specific A2A code; every unit in a caller's context is pollable by
`GetTask` across restarts, compactions, resets, `/clear` and archive, within
the documented bounds; no A2A store exists anywhere.

**Unified IN THIS BRANCH:** the vocabulary (turn + workflow), `unit_end`,
the ended-units table and its carry at every segment boundary, the
`workUnits()` seam, A2A tasks as its projection (live and archived), workflow
start via A2A.

**Later, purely additive (named follow-ups):**
- **F1 `feat/work-units-wire`** — expose the seam as `session/work_units` (a new method, free per §7); the phone/TUI show turns, runs and sub-agents with one state vocabulary; `workflow/list` becomes its projection.
- **F2 `feat/subagents-as-work-units`** — the sub-agent table in the same vocabulary (its facts are already carried); background sub-agents of an A2A turn as related tasks (`referenceTaskIds`).
- **F5** — the workflow driver's free-string states typed from the vocabulary (internal; wire words stay free).

### Scope (rev. 4)

A cut stays OUT only if adding it later is purely additive.

| Item | Rev. 4 | Why |
|---|---|---|
| Agent Card, `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `SubscribeToTask`, `ListTasks` | **in** | MVP |
| Task records | **no A2A store**: a projection of the session log (+ live state) | addendum |
| Vocabulary + `unit_end` + ended-units table + `workUnits()` | **in** | the one record / one seam |
| Tasks across restart / compaction / reset / `/clear` (F3) | **in** | owner Q6 «Subito»; and rev. 3 was wrong about restarts |
| Tasks of archived contexts, read-only (F4) | **in** | owner Q6 |
| Workflow start via A2A, per-caller switch OFF by default | **in** | owner Q5 |
| Caller identity in the session id `a2a-<caller>-<contextId>` | **in** | not additive later |
| Who answers asks: per-caller `owner \| both`; file approvals owner-only | **in** | owner Q1/Q5 |
| Reopen an archived own context on a NEW message | **in** | multi-turn must survive the TTL (reads never reopen) |
| Final-round-only `response`, deltas streamed, history = caller messages only, no tool/thought/usage | **in** | token saving |
| Sub-agents as units/tasks (F2); phone/TUI on the vocabulary (F1); per-tool status; inbound `raw`/`url`; outbound files (later by reference); REST/gRPC; webhooks; A2A 0.3; extended/signed card; queueing on a busy context | **out** | each purely additive later |

### Design

```
A2A caller ──HTTP(S)── Bun.serve fetch (ws-server.ts) ──► a2a/http.ts (A2A token, Origin, size, card, SDK glue, SSE)
                                                             │ SDK DefaultRequestHandler + a2a/task-projection.ts
                                                             ▼                       ▲ live: workUnits()    ▲ archived: readRaw → loader parse → unitsFromSegment
                                                 a2a/executor.ts                     │                       │
                                                             ▼ createChannelPair()   │                       │
                                       Connection ──► SessionHost ── HostedSession (ended-units table ⇄ session log: native entries + unit_end carry)
                                                                                     ▲ core/work-unit.ts (vocabulary, unitsFromSegment, turnResult)
```

**WorkUnit → A2A (pure, `a2a/mapping.ts`):**

| WorkUnit | A2A `TaskState` |
|---|---|
| `working` | `WORKING` |
| `waiting:permission`, caller `owner` | `WORKING` + "waiting for the owner's approval: <title>" |
| `waiting:permission`, caller `both`, ask caller-answerable | `INPUT_REQUIRED` + the ask |
| `waiting:permission`, ask owner-only (below) | `WORKING` + "waiting for the owner" — in every mode |
| `waiting:approval` (a workflow file) | `WORKING` + "waiting for the owner to approve workflow <name>" — every mode |
| `completed` / `failed` / `canceled` | `COMPLETED` / `FAILED` / `CANCELED` (+ `reason` as status message) |

| A2A input | tentacle |
|---|---|
| caller (the token's name; `default` from the CLI) | `ServerCallContext.user`; session-id prefix |
| `contextId` | session `a2a-<caller>-<contextId>` (`title:{text:"A2A: <first line ≤60>", source:"user"}`; reopened if archived) |
| `text` parts | one `{type:"text"}` block |
| `data` `{"tentacle/workflow": {name, inputs}}` | `session/workflow{action:"start", name, inputs, turnId: taskId}` — only with the caller's `workflows` switch ON, else UnsupportedOperation |
| `data` `{"tentacle/permission": …}` | a caller's answer |
| other `data` parts | `{type:"text"}` block of the JSON, fenced |
| `raw` / `url` parts | −32005, nothing opened |
| `agent_message_chunk` (our turn) | `artifactUpdate response`, `append:true`; first chunk after a `tool_call` → `append:false` (final round only) |
| our run's `workflows` row change | `statusUpdate` from the projected unit; at the end `artifactUpdate response` = `result` |

**Asks answered by the caller (Q1, Q5).** Per caller (= per token): `asks:
"owner"` (default) | `"both"`. **Which asks a caller may ever answer is decided
by kind, fail-closed:** a classification table in core,
`Record<PermissionKind, "once" | "owner-only">` over the closed union
`"tool" | "hooks_trust" | "session_hop" | "workflow_approve"`
(`core/src/permission.ts:43`) — TypeScript forces every new kind to be
classified. Only `tool` is `once`. `workflow_approve` is owner-only because
its "allow" stores the file hash for good (`approvals.add`,
`agent/src/workflow-driver.ts:1112-1133`) — a lasting approval even when the
option is `allow_once`; `session_hop` and `hooks_trust` likewise. The adapter
recovers the kind from the wire ask with the client's own reverse mapping
(`packages/client/src/permission-map.ts`); an ask it cannot map is
owner-only. In `both`, `INPUT_REQUIRED` lists every caller-answerable pending
ask of the task (a turn's, or a workflow step's: those carry the run's
`turnId` = the task id) with options filtered to
`allow_once`/`reject_once`; the caller answers with a `data` part
`{"tentacle/permission": {requestId, decision:"allow"|"deny", message?}}`
or, with exactly one ask pending, the text `allow`/`approve`/`yes` (anything
else = deny, the text as the refusal reply when offered: fail-closed). The
adapter (daemon-side, trusted) maps the decision to that ask's own `*_once`
option — a caller never names an `optionId`. No "caller-only" mode: the owner
is always raised the ask; the push grace keeps the phone silent when the
caller answers in time (`push-rules.ts:14-28`). Never sent by the adapter:
`set_auto_accept`, `set_capability`, `update_settings`, a `skill`,
`hooks/trust: true`, an answer to an owner-only ask.

**Executor (`a2a/executor.ts`)** — `execute(requestContext, bus)`:
- **New task:** map parts → `createChannelPair()` + `new Connection(daemonEnd,
  host, onError, {hooksTrustPrecheck})` + `RpcPeer(clientEnd)` (`hooks/trust` →
  `{trusted:false}`, any other request → `MethodNotFound`) → `initialize`
  (`clientInfo:{name:"a2a"}`, no `host`; `updates` incl. `permission_request`)
  → `session/open{create:true, reopen:true}` on `a2a-<caller>-<contextId>`
  only → publish the Task (`WORKING`) → `session/prompt{turnId: taskId}` or
  `session/workflow{start, turnId: taskId}` → on each relevant update
  re-project the unit and publish what changed → at the terminal state
  `bus.finished()`, `session/detach`, close the channel.
- **Follow-up on a live task** → the caller-answer path; on a terminal task →
  SDK error; on a task of an ARCHIVED context → it is terminal (archive ends
  its turn) → SDK error; a NEW task (no `taskId`) on that context reopens it.
- **After a restart:** no reconciliation code. The reload rebuilds the
  ended-units table from the log; a turn suspended on an ask resumes under its
  id (`persisted-session.ts:343-346`); a follow-up or `SubscribeToTask` on a
  still-open unit attaches a watcher lazily; `GetTask` just projects.
- `cancelTask(taskId)` → turn: `session/cancel{sessionId, turnId}`; workflow:
  `session/workflow{action:"stop", runId}`; `CANCELED` comes from the
  projection (the owner's stop from the phone is the same path).

**HTTP (`a2a/http.ts`)** — public `/.well-known/agent-card.json` (one skill
`tentacle-session`; it names no workflow), `POST /a2a` with Origin → 401,
A2A-token bearer → else 401 + audit, 1 MiB → 413, `validateVersion`, JSON or
SSE (`: ping` every 15 s), `server.timeout(req, 0)`; off without an A2A token.

### Files

1. `packages/core/src/work-unit.ts` (new, pure) + `core/src/index.ts` — vocabulary, tables, `unitsFromSegment`, `turnResult`, bounds.
2. `packages/core/src/permission.ts` — the `PermissionKind → once | owner-only` table (exhaustive).
3. `packages/protocol/src/session-log.ts` — `LogUnitEndEntrySchema` (non-critical, bounded free words) in the known-entry union; `protocol.json` regenerated at merge.
4. `packages/daemon/src/session-log.ts` — `unitEnd(fact)` writer (like `subagentEnd`).
5. `packages/daemon/src/daemon-state-file.ts` — `units` from `unitsFromSegment(derivedFrom)` into the restored record.
6. `packages/daemon/src/hosted-session.ts` — ended-units table (bounded), live fill at turn/run end, carry in `logSegmentFacts`, `workUnits()`.
7. `packages/daemon/package.json` — `"@a2a-js/sdk": "1.3.0"` (pinned) + `bun.lock`.
8. `packages/daemon/src/a2a/mapping.ts` (new, pure) — parts, WorkUnit→A2A, round replace, ask message, `callerMayAnswer`, answer parser, card, session id.
9. `packages/daemon/src/a2a/task-projection.ts` (new) — `TaskStore` as projection, index, archived read-only LRU.
10. `packages/daemon/src/a2a/executor.ts` (new) — `AgentExecutor` + live watchers.
11. `packages/daemon/src/a2a/http.ts` (new) — route, auth, SDK glue, SSE.
12. `packages/daemon/src/ws-server.ts` — `WsServerOptions.a2a?`; `fetch` calls `a2a.handle(req)` first.
13. `packages/daemon/src/index.ts` — exports.
14. `packages/cli/src/flags.ts` — `serve`: `a2a-token`, `a2a-token-command`, `a2a-asks`, `a2a-workflows`.
15. `packages/cli/src/serve.ts` — `ServeOptions.a2a` → `startWsServer` + the store for archived reads; startup line "A2A on …/a2a (asks: owner, workflows: off)".
16. `packages/cli/src/main.ts` — help text.
17. `changelog.d/a2a.added.md`; `README.md` "A2A"; `TODO.md` (feat/a2a + F1, F2, F5).

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| No / wrong token; browser `Origin` | 401 before parsing; audit `a2a-auth-failure`. Card public. |
| Unknown method / bad params / bad version / huge input / `raw`-`url` part | −32601 / −32602 / −32009 / 413 / −32005; nothing opened. |
| Busy context | `TurnInProgress` / workflow `running` refusal → UnsupportedOperation; first unit unaffected. |
| Workflow start, switch off | UnsupportedOperation. |
| Workflow file new/changed | `waiting:approval` → `WORKING` + message; ONLY the owner approves, in every mode (kind table). `changed` refusal → `FAILED`. |
| Caller tries to answer an owner-only ask (file approval, hop, hooks) | Never listed to it; a crafted answer naming its `requestId` → InvalidParams, the ask untouched. |
| Caller tries a lasting approval | Impossible: it sends a decision; the host picks the `*_once` option of a `tool` ask. |
| Ask, `owner` / `both`; ambiguous text; late answer | As rev. 2: `WORKING`+message / `INPUT_REQUIRED`; fail-closed deny; `PermissionNotPending` → no effect. |
| Caller drops mid-stream | The unit continues; `SubscribeToTask`/`GetTask` read it. |
| `CancelTask` / owner stops | cancel / stop → `canceled` → `CANCELED`; terminal → `TaskNotCancelable`. |
| `serve` restart | The reload rebuilds the ended-units table from the last segment (native + `unit_end`) and carries it into the reload segment; a cut turn → `failed: interrupted`, an open run → `failed: interrupted` (`workflowLoadNotes`), a turn suspended on an ask → `waiting` under its id. |
| Crash between a unit's end and the next write | Its end is not on disk: the load closes it (`RESTART_TURN_END` / load notes) → `failed: interrupted` — honest, never a phantom success. |
| Compaction / `context_reset` / `/clear` | The new segment carries the table as `unit_end` → `GetTask` unchanged. |
| More than 256 ended units / results over 256 KiB | The oldest units leave the table (`TaskNotFound`); over-budget results → `resultDropped` (state and reason kept). Documented bounds. |
| Older tentacle reads a log with `unit_end` | Skips it (non-critical); its own projection is intact. |
| Malformed `unit_end` from a newer build | Free bounded words only, so a newer word parses; an oversize field is the emitter's bug, refused like any malformed known entry — pinned by a schema test at the caps. |
| Context archived | `GetTask`/`ListTasks` read it read-only (no reopen, no write); a new message reopens it. |
| Archived file unreadable / future `schemaVersion` | `TaskNotFound` + audit; files untouched. |
| Many archived contexts | Index built once per caller on the first miss, through the 8-entry LRU; `ListTasks` pages. |
| Owner deletes the session | Absent from `list()` → `TaskNotFound`; nothing else to clean. |
| Two callers | One today (`default`); ids carry the caller; the SDK scopes by owner. |
| contextId naming a phone session | Impossible: only `a2a-<caller>-…` is opened or read. |
| Model starts a workflow inside an A2A turn | Its `origin` = the turn's id, but the turn unit wins → the task is the TURN; the run is visible to the owner (F2 makes it a related task). |

### Tests

Fakes: the daemon pattern (`session-auto-accept-asked-on.test.ts`: real
`SessionHost` + `Agent` + scripted `ModelProvider`, `Connection` over
`createChannelPair`), the workflow driver's own fakes, a temp `LogSessionStore`
dir; `until` from `packages/client/test/support/fakes.ts`, never a sleep. Each
test names its mutation (§9).

- `core/test/work-unit.test.ts`: both native→unified tables row by row; unknown words; `unitsFromSegment` over native entries, over `unit_end` carries, and over both (a carried unit and a native one in one segment); `turnResult` = final round only; bounds (257th unit drops the oldest; result budget → `resultDropped`).
- `core/test/permission-kinds.test.ts`: only `tool` is `once` (mutation: mark `workflow_approve` once → red).
- `protocol/test/session-log-unit-end.test.ts`: parses at the caps; an unknown word parses; a reader that does not know `unit_end` skips it and projects the same history.
- `daemon/test/work-units.test.ts` (real host + temp store): a turn and a workflow run end → `workUnits()`; then **compaction**, **context_reset**, **/clear**, **reload** (stop + reload from the store) → each still lists them with the same result (mutation: drop the carry in `logSegmentFacts` → red after each boundary); crash before the end is written → `failed: interrupted`; the live end and the load derivation give identical records (mutation: compute the live result from stream chunks → red).
- `a2a-mapping.test.ts`: WorkUnit→TaskState table (approval and owner-only asks never `INPUT_REQUIRED`); `callerMayAnswer`; parts; workflow data part; round replace; ask message `*_once` only; answer parser; card.
- `a2a-executor.test.ts`: create, stream, owner/both asks (adapter never `resolve_permission` in owner mode; ask not auto-denied; `*_once` only), a `workflow_approve` ask in `both` → still `WORKING`, a crafted answer refused (mutation: route by `requestId` without the kind check → red); cancel, busy, hooks false, detach, reopen; workflow task start → step ask → answer → `COMPLETED`; switch off → refused.
- `a2a-task-projection.test.ts`: `GetTask` running / ended / after reload / after compaction / archived (read-only: the store dir's files are byte-identical before and after, mutation: reopen to read → red); `ListTasks` per context and owner; deleted → `TaskNotFound`; **no A2A file anywhere** in the store dir.
- `a2a-http.test.ts` (real `startWsServer`, loopback, port 0): 401s, card, 413, −32009, −32601, A2A off → paths as today, WS route unaffected, a blocking call outlives the idle timeout.
- **e2e** `a2a-e2e.test.ts`: `startDaemon` + the **SDK client**: card → `sendMessage` → `sendMessageStream` → `getTask` → `listTasks` → `cancelTask` → a workflow task (switch on) → WS client sees `a2a-default-<ctx>`; caller aborts mid-stream, unit completes; **restart** on the same store → `getTask` of a turn and a run; **archive** (short TTL) → `getTask` still answers and the session stays archived.

### Slices

Execution order = table order (each depends on the ones above it, except
`S3-a2a-mapping` and `S9-a2a-http-route`, which only need `S0`: they may run
beside `S1`–`S2` if the orchestrator has a second worktree — disjoint files).

| Slice | Executor | Est. | Scope |
|---|---|---|---|
| `S0-work-units-core` | sonnet | 1 h 15 | `core/work-unit.ts` (vocabulary, tables, `unitsFromSegment`, `turnResult`, bounds) + tests — pure, fully table-tested |
| `S1-unit-end-entry` | opus | 45 min | `unit_end` schema (non-critical, bounded free words) + `SessionLog.unitEnd` + skip/caps tests — persisted format (§7 on-disk) |
| `S2-work-units-seam` | opus | 2 h | ended-units table, live fill, carry in `logSegmentFacts`, loader `units`, `workUnits()` + the four-boundary tests — `HostedSession`, persistence (§7) |
| `S3-a2a-mapping` | sonnet | 1 h | dep + `bun build --compile` smoke + `a2a/mapping.ts` + tests — pure |
| `S4-a2a-executor` | opus | 1 h 30 | turn tasks on the single session path (§7): create/reopen, stream, round replace, cancel, detach, owner-mode asks, hooks |
| `S5-caller-asks` | opus | 1 h 30 | kind table (`core/permission.ts`), `both` mode, `INPUT_REQUIRED`, live-watcher routing, `*_once` answers, owner-only asks — the broker / "remote not trusted" (§7) |
| `S6-task-projection` | opus | 1 h 15 | `TaskStore` as projection, index, `GetTask`/`ListTasks`, owner scoping — the untrusted caller's view boundary |
| `S7-archived-tasks` | opus | 1 h 15 | read-only archived projection (`readRaw` → loader parse), LRU, index over `list()`, never reopen/write — persistence (§7) |
| `S8-workflow-tasks` | sonnet | 1 h | start via data part, per-caller switch, stop, `result` mapping + tests (the approval rule is S5's, already pinned) |
| `S9-a2a-http-route` | sonnet | 1 h | `http.ts` + `ws-server.ts` hook: auth, Origin, 413, version, SSE, timeout + tests |
| `S10-cli-e2e` | sonnet | 1 h 30 | flags, serve wiring, help, README, changelog, TODO follow-ups, e2e (restart, archive) |
| `R-review` | opus | 1 h 45 | fresh-context: §7 (single session path, remote not trusted, persistence/on-disk), "no fourth store", owner-only approvals, test non-vacuity; one fix round; `bun run check` |
| **Total** | | **≈ 15 h 30** serial (≈ 13 h 30 with S3 + S9 in parallel) | from ~12:30 → ~02:00–04:00 (owner accepted past midnight) |

## Execution

### S0-work-units-core — DONE

*— claude-sonnet-5-5, 2026-11-25*

**Load-bearing check re-run first** (`bun .tentacle/tmp/a2a/seam.ts` in the
worktree; HOLDS, same five lines as the plan):

```
1. a2a open → a2a-ctx-1 created true
2. phone session/list → a2a-ctx-1 "A2A: hello"
3. ask seen by a2a: 1 by phone (replayed on attach): 1
4. a2a updates after phone answered → turn_start tool_call permission_request permission_resolved tool_call_phase tool_call_update agent_message_chunk:"done: 42" turn_end:end_turn
5. a2a tail after phone cancel → turn_end:end_turn turn_start turn_end:cancelled
```

**As built:** `packages/core/src/work-unit.ts` (new, pure), exported from
`core/src/index.ts`; `packages/core/test/work-unit.test.ts`;
`changelog.d/a2a.added.md` (says `serve` does not speak A2A yet: **S10 must
rewrite it**). No schema change, so `protocol.json` is untouched.

**Red before green:** against a stub with the final signatures, 45 fail / 4
pass on assertions (the 4 matched the stub's defaults). Then 49 pass / 0 fail.

**Drift from Implementation:**
- `unitsFromSegment(entries)` has no `messages` argument (fixed above).
- `unit_end` is not in `KnownLogEntry` until S1, so core declares the
  structural `CarriedUnitEntry` and accepts `KnownLogEntry | CarriedUnitEntry`.
- Added `unitEndBody(unit)`, the capped inverse of the carried read (the
  round-trip test needs it; S1/S2 write through it). Unlike the workflow body
  builders it does not yet judge by a schema (S1 adds the schema). S1 also
  defines the schema's bounds in protocol (protocol cannot import core), and
  core should then import them rather than keep two copies.
- A turn's `reason` comes from its `stopReason` alone: `turn_end` logs nothing
  else, so a live-only error message would make live and load records differ.
- A carried unit of an unknown `kind` is skipped; a non-terminal or unknown
  carried `state` reads as `failed`.

**Notes for S2 / S4 / S8** (not verified by execution):
- For "live end = load derivation", derive live ends with `unitsFromSegment`
  over the live segment's entries (materialized: drop lazy checkpoint slots),
  not from the driver row, whose `endedAt` is its own clock.
- A run's result has only the last step report of the CURRENT segment: a live
  run carries just its `workflow_start` across a boundary (also re-stamping
  `startedAt`). A step that ended before the boundary is missing from `result`.
- The driver's row is born `needs-approval` before `launch`
  (`agent/src/workflow-driver.ts:1168`), so an already-approved run may be
  seen as `waiting:approval` briefly.

**Mutations** (`.tentacle/tmp/a2a/mutate-s0.ts`, original restored after each;
49/49 green afterwards). All 10 killed:

| Mutation | Fails |
|---|---|
| M1 `turnResult` = first assistant of the span | 3 |
| M2 silent final round falls back to an earlier one | 1 |
| M3 no result budget | 2 |
| M4 no 256 bound | 2 |
| M5 carried `unit_end` ignored | 4 |
| M6 `base.turn` span starts at 0 | 1 |
| M7 `stopped:cancelled` is a failure | 1 |
| M8 ended + non-terminal word stays non-terminal | 1 |
| M9 carried `state` trusted as is | 1 |
| M10 rerun keeps the old report | 1 |

**Gate (narrow):** `bun test` on `core/test/work-unit.test.ts`,
`core/test/workflow-ledger.test.ts`, `scripts/test/changelog.test.ts`,
`scripts/test/changelog-guard.test.ts` → 83 pass / 0 fail; `biome check` on the
three changed TS files clean; `tsc --noEmit` limited to `core/src/index.ts` and
the new test clean. The full `bun run check` was NOT run: the orchestrator's
script runs it.

### S1-unit-end-entry — DONE

*— claude-opus-5-5, 2026-11-25*

**Load-bearing check re-run first** (`bun .tentacle/tmp/a2a/seam.ts`): HOLDS,
the same five lines as above.

**As built:**
- `packages/protocol/src/session-log.ts` — `LogUnitEndEntrySchema` (skippable,
  every word a bounded free string: `kind`/`state`/`native` ≤ 128, `unitId`
  ≤ 128, `origin` = `TurnIdSchema`, `reason` ≤ 2 KiB, `result` ≤ 16 KiB,
  `startedAt?`/`endedAt` non-negative ints, `resultDropped?: true`) + the
  `UNIT_END_*_MAX_CHARS` constants; added to `KnownLogEntrySchema` and to
  `LOG_ENTRY_CRITICAL` as `false`; module comment.
- `packages/core/src/work-unit.ts` — the bounds and `CarriedUnitEntry` now come
  from protocol (one copy, as S0 asked: `WORK_UNIT_RESULT/REASON_MAX_CHARS`
  alias the protocol constants; `CarriedUnitEntry` = the entry minus its
  envelope). `unitEndBody` now cuts `unitId`/`native` to their bounds and
  judges the body by the schema (throws, never writes an invalid entry).
- `packages/core/src/workflow-ledger.ts` — `judged` exported (reused, not copied).
- `packages/daemon/src/session-log.ts` — `SessionLog.unitEnd(body)`, like `workflowEnd`.
- `packages/protocol/schema/protocol.json` regenerated (`bun run schema:export`).
- `packages/protocol/test/session-log.test.ts` — the critical-table pin gains `unit_end: false`.
- Tests: `packages/protocol/test/session-log-unit-end.test.ts` (non-critical,
  parses at every cap, one over each cap refused, documented bounds pinned,
  unknown words parse, required shapes, projects nothing);
  `packages/daemon/test/session-log-unit-end.test.ts` (writer emits a
  non-critical known entry; disk round trip `SessionLog` → `entryLines` →
  `parseLogFile` → `unitsFromSegment` gives the identical unit; an older reader
  — the same file with the type renamed to one it does not know — skips 1 line
  and projects the same history; the emitter caps words and throws on a body
  the schema refuses).
- No changelog change: S0's `changelog.d/a2a.added.md` is the task's one
  fragment; S1 has no user-visible effect of its own.

**Drift from Implementation:**
- The "older reader skips it" test lives in the DAEMON test, not protocol's:
  the file parser (`parseLogFile`) is the daemon's; protocol has no reader.
- `judged` is now a core export (it rides `export *` from `workflow-ledger.ts`).
- No `protocol.d/` note, no `PROTOCOL_VERSION` bump: a new non-critical type,
  as the plan says.

**Note for S2:** `unitEndBody` THROWS on a body the schema refuses. Its inputs
come from parsed entries (so `origin` is already a valid `TurnId`), but the
carry in `logSegmentFacts` should still not let one bad unit abort a segment
start: skip it (and say so) rather than throw.

**Red before green:** mutation R0 below (no `unit_end` in the known union, i.e.
the code before this slice) → 6 fail; then all green.

**Mutations** (`.tentacle/tmp/a2a/mutate-s1.ts`, each restored; all 9 killed):

| Mutation | Fails |
|---|---|
| R0 `unit_end` not in the known union | 6 |
| M1 `unit_end: true` in the critical table | 1 |
| M2 the writer marks it `critical: true` | 4 |
| M3 result cap 64 KiB | 1 (after pinning the documented bounds; it survived before) |
| M4 `kind` an enum | 4 |
| M5 `native` a `WorkflowWordSchema` | 5 |
| M6 the emitter does not cut words | 1 |
| M7 the emitter does not judge | 1 |
| M8 `origin` unbounded | 2 |

**Gate (narrow):** `bun test` on the two new files + protocol
`session-log`/`json-schema`/`forward-compat`, daemon `session-log`/`session-log-file`,
core `work-unit`/`workflow-ledger`, client `session-log-reader` → 182 pass / 0
fail; `biome check` on the 8 changed files clean; `tsc` limited to the changed
modules and tests (`.tentacle/tmp/a2a/tsconfig.s1.json`) clean. Full `bun run
check` NOT run (the orchestrator's script runs it).

### S2-work-units-seam — DONE

*— claude-opus-5-5, 2026-11-25*

**Load-bearing check re-run first** (`bun .tentacle/tmp/a2a/seam.ts`): HOLDS,
the same five lines as above.

**As built:**
- `packages/daemon/src/daemon-state-file.ts` — `rebuild` adds
  `units = unitsFromSegment(derivedFrom)` to the record: the SAME entries the
  sub-agent/workflow notes and the switches come from, so a unit ended after
  `logHead` is ignored like the rest of that tail.
- `packages/daemon/src/persisted-session.ts` — `DaemonSessionRecord.units?`
  and the pure `endedUnitsAtLoad(units, reconciledTurns, resumedTurnId, at)`:
  the record's ended units, then each unit the cut left open closed at `at`.
  A turn gets its reconciled key's end (a restart → `failed`, reason = the
  `RESTART_TURN_END` message; an archive → `canceled`), or `RESTART_TURN_END`
  when no key has one. A run gets `stopped:interrupted` → `failed`. The
  resumed turn stays out of the table, because it is live. The result is
  bounded (`boundEndedUnits`).
- `packages/daemon/src/session-host.ts` — `restore` passes
  `units: endedUnitsAtLoad(record.units, reconciled.turns, reconciled.resume?.turnId, now)`.
- `packages/daemon/src/hosted-session.ts` — `RestoredSessionState.units?`; the
  private `endedUnits` table, set from `restored.units` BEFORE the first
  segment. `logSegmentFacts` ends with one `log.unitEnd(unitEndBody(u))` per
  table unit; a unit the schema refuses is skipped and reported through
  `errorPolicy.onTurnError`, never aborting the segment start (S1's note).
  `refreshUnits()` re-derives the table as
  `unitsFromSegment(current segment's materialized entries).ended`. It runs
  right after `log.turnEnd` (in `finishTurn`) and after `log.workflowEnd` (the
  driver's `logEnd`). Public read-only `workUnits()` returns the table (oldest
  first), then the running turn (`waiting:permission` when one of its asks is
  pending), then the driver's live runs (`unifyWorkflow` over the rows without
  `endedAt`).
- `packages/daemon/test/work-units.test.ts` (new; real `SessionHost` + real
  `LogSessionStore` + `SessionPersister`, the real `WorkflowDriver`). It covers:
  - a turn and a run ending live, with their records and results;
  - the chain compaction → context reset → `/clear` → reload;
  - each boundary on its own (compaction, context_reset, clear, reload), with
    a NEW end after it;
  - the last segment on disk carrying the earlier units as `unit_end`;
  - live records equal to the reloaded ones;
  - a crash before the turn's and the run's ends: both load `failed`, the
    turn's reason is the restart message, the run's `native` is
    `stopped:interrupted`, and the reload segment carries them;
  - a turn suspended on an ask: `waiting:permission` live, still waiting under
    its id after a reload, then answered once → `completed`;
  - `endedUnitsAtLoad` table cases (pure).

**Drift from Implementation:**
- `persisted-session.ts` and `session-host.ts` were not in Files. The plan
  says the load fills the table but not who closes the units a crash left
  open ("a cut turn → `failed: interrupted`"). That is now
  `endedUnitsAtLoad`, next to `RESTART_TURN_END`.
- The live fill does not cache per-unit work. It re-derives the whole table
  from the current segment with THE load derivation, so a live end and a
  reload give the same record by construction. This is O(segment) entries,
  synchronous, and runs only at a turn's or a run's end. It reads
  `SessionLog.since()` (no new log accessor) and skips lazy checkpoint slots.
- The context reset in the tests goes through the private
  `historyReplaced("context_reset")` (cast, as `workflow-hosted.test.ts`
  does). It is the same barrier the agent's reset calls.
- A restart-closed unit's `reason` is the `RESTART_TURN_END` message, not
  `unifyTurn`'s generic "the turn failed". Such a unit exists only through the
  load path and is then carried, so live and load records still agree.

**Notes for S4 / S6 / S8** (not verified by execution):
- In `workUnits()` the LIVE turn has no `startedAt`: its `turn_start` time is
  not cached. Its ended record has one.
- A live run's `origin` comes from `driver.liveStart()`, which exists only once
  the run is approved. A `needs-approval` run has no `origin` yet, so S8 must
  map it to its task another way: either a small driver accessor (outside S2's
  files) or the start's own `turnId`.
- A run that ends before any `workflow_start` (refused unapproved/`changed`)
  produces no unit: `unitsFromSegment` ignores an end without a start. S8's
  "`changed` refusal → `FAILED`" needs a different source.
- The carry's skip-and-report path (a unit the schema refuses) is not
  exercised: through public paths every table unit comes from parsed
  entries. To verify it, inject a unit with a 129-char `origin` and watch
  `onTurnError`.

**Red before green:** R0 below (the slice's daemon wiring removed: no carry,
no load units, no live refresh) → 7 of 9 fail; then 9/9 green.

**Mutations** (`.tentacle/tmp/a2a/mutate-s2.ts`, each restored, tree verified
clean afterwards; all 11 killed):

| Mutation | Fails |
|---|---|
| R0 no carry + no load units + no live refresh | 7 |
| M1 no `unit_end` carry in `logSegmentFacts` (the plan's mutation) | 6 (each of the 4 per-boundary tests + the chain + the crash test) |
| M2 load keeps only `units.ended` (open units dropped) | 2 |
| M3 load ignores the reconciled key's end | 1 |
| M4 restore not given the record's units | 3 |
| M5 loader derives no units | 3 |
| M6 live turn record built from the stream, not derived (the plan's mutation) | 2 |
| M7 no refresh at a run's end | 5 |
| M8 `workUnits` ignores pending asks | 1 |
| M9 the resumed turn closed at load too (phantom end) | 2 |
| M10 `workUnits` omits the live run | 1 |

**Gate (narrow):** `bun test` on the new file and the covering ones (daemon
`workflow-load`, `workflow-hosted`, `persistence`, `clear-reload`,
`serve-subagent-reload`, `session-log-unit-end`, `serve-log-store`,
`context-reset-barrier`, `compaction-fact`, `clear`; core `work-unit`) →
254 pass / 0 fail. The segment-pinning files (client `session-titles`,
`session-log`, `session-log-reader`; daemon `session-log-file`,
`session-capabilities-log`, `session-fork`, `session-log`,
`attachments-log-file`, `clear-fork`, `history-cut`, `integration`; cli
`logs-cmd`, `log-events`) → 191 pass / 0 fail. `biome check` on the 5 changed
files is clean. `tsc` limited to `daemon/src/index.ts`, `session-host.ts` and
the new test (`.tentacle/tmp/a2a/tsconfig.s2.json`) is clean. No schema
change, so `protocol.json` is untouched. No changelog change (S0's fragment
covers the task). Full `bun run check` NOT run (the orchestrator's script
runs it).

### S3-a2a-mapping — PARTIAL (compile smoke not run)

*— claude-sonnet-5-5, 2026-11-25*

**Load-bearing check re-run first** (`bun .tentacle/tmp/a2a/seam.ts`): HOLDS,
the same five lines as above.

**As built:**
- `@a2a-js/sdk` pinned `1.3.0` in `packages/daemon/package.json` + `bun.lock`.
- `packages/daemon/src/a2a/mapping.ts` (new, pure): `a2aSessionId` /
  `a2aCallerPrefix` / `contextIdOf` / `a2aTitle`; `inboundParts` (text join,
  `tentacle/workflow`, `tentacle/permission`, fenced other-data, `raw`/`url`
  refused); `callerMayAnswer`, `onceOption`, `callerOptions`, `parseTextAnswer`,
  `askMessage`; `projectStatus` (WorkUnit → `TaskState` + message),
  `responseText`, `chunkAppend` (round replace), `buildAgentCard`.
- `packages/daemon/test/a2a-mapping.test.ts` (24 tests).
- No schema change: `protocol.json` untouched. No new changelog fragment: S0's
  `changelog.d/a2a.added.md` is the task's one (S10 rewrites it).

**Drift from Implementation:**
- **`bun build --compile` smoke NOT run**: the sandbox refused the command
  (approval needed, non-interactive). To verify: a file importing
  `@a2a-js/sdk/server` + `mapping.ts`, `bun build --compile`, run the binary.
  The SDK's Node-only entry points (`server/express`) are not imported by S3.
- SDK 1.3.0 is the A2A 1.0 protobuf-shaped API (`TaskState.TASK_STATE_*`,
  `Part.content.$case`), so mapping uses those types, not the plan's
  `WORKING`/`INPUT_REQUIRED` names.
- Caller names are restricted to `[A-Za-z0-9_]{1,32}` (no `-`) so the
  `a2a-<caller>-<ctx>` prefix is exact (caller `a` never matches `a2a-ab-…`);
  contextId `[A-Za-z0-9_.:-]{1,128}`; anything else → null (InvalidParams).
  S4/S10 must reject token names outside that set.
- The ask-kind table lives in core in S5; here `callerMayAnswer` is
  `mode === "both" && kind === "tool"` (unmapped = owner-only). S5 should make
  it read the core table.
- `PendingAsk.kind` is an input (S4/S5 get it from `client/permission-map`).

**Red before green:** the module did not exist before; the mutations below are
the non-vacuity proof (each turns assertions red, not an import error).

**Mutations** (`.tentacle/tmp/a2a/mutate-s3.ts`, original restored; 24/24 after):

| Mutation | Fails |
|---|---|
| M1 any ask kind answerable in `both` | 3 |
| M2 answer decision defaults to allow | 1 |
| M3 `callerOptions` shows `*_always` | 2 |
| M4 `raw` part accepted | 1 |
| M5 round replace ignores a tool call | 1 |
| M6 caller prefix without the `-` delimiter | 1 |
| M7 approval wait falls through to the ask path | 1 |
| M8 text answer with several asks pending | 1 |

**Gate (narrow):** `bun test packages/daemon/test/a2a-mapping.test.ts` 24 pass /
0 fail; `biome check --write` on the 2 files clean; `tsc` limited to the 2 files
(`.tentacle/tmp/a2a/tsconfig.s3.json`) clean. Full `bun run check` NOT run.

## Review
