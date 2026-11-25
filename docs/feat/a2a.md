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
  *(S7 correction: `store.list()` is NOT header + sidecar only — it runs
  `summarize` on every file, "the same walk as `load`"
  (`session-log-store.ts:1305-1306`), i.e. every archived history read in
  full. The header + sidecar index already exists: the HOST's archived index
  (`SessionHost.archived`, filled at start by `persister.loadState` →
  `addArchived`, `serve.ts:886-901`). So the archived source is the host:
  `SessionHost.archivedSessions()` (that index) + `readArchivedUnits(id)` =
  the resident record, else `persister.load(id)` (flush, `readRaw`, the
  loader's parse + `rebuild`; nothing written, `session-persister.ts:392-427`)
  → `archivedUnitsOf` (reconcile + `endedUnitsAtLoad` at `archivedAt`). The
  LRU's version is the index's `updatedAt` + `archivedAt`, not the file's
  size + mtime (no `stat`). No store handle is wired in `serve.ts`.)*

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
  `session/detach`, close the channel, return (the SDK settles the bus when
  `execute` returns — S4 correction: no `bus.finished()` of ours).
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
| Busy context | `TurnInProgress` / workflow `running` refusal → the task `REJECTED` + reason (S4: the SDK turns an `execute` error into a FAILED task, so a JSON-RPC error is impossible there); first unit unaffected. |
| Follow-up message naming a RUNNING task | Refused before `execute` by `A2ARequestHandler` → UnsupportedOperation (−32004): the task's bus is shared and a second `execute` would break its stream (S4). S5 lets a caller's answer through in `INPUT_REQUIRED`. |
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

### S4-a2a-executor — DONE (one finding against S2, outside S4's files)

*— claude-opus-5-5, 2026-11-25*

**Load-bearing check re-run first** (`bun .tentacle/tmp/a2a/seam.ts`): HOLDS,
the same five lines as above.

**As built:**
- `packages/daemon/src/a2a/executor.ts` (new):
  - `A2AExecutor implements AgentExecutor`. A NEW task:
    1. Checks the caller (`ServerCallContext.user`, authenticated), the ids
       (`a2aSessionId`) and the parts (`inboundParts`).
    2. Builds `createChannelPair()` + `new Connection(daemonEnd, host, onError,
       {hooksTrustPrecheck})` + `RpcPeer(clientEnd)`.
    3. Sends `initialize`: every `KNOWN_UPDATE_TYPES`, so `permission_request`
       is declared; `clientInfo {name:"a2a"}`, no `host`.
    4. Sends `session/open{create, reopen, title}` on `a2a-<caller>-<ctx>`.
    5. Publishes the Task `WORKING`.
    6. Sends `session/prompt{turnId: taskId}`.
    7. While that turn runs, maps its updates: `agent_message_chunk` →
       `artifactUpdate response` (`chunkAppend` round replace); asks → WORKING
       + "waiting for the owner's approval: <title>" (`projectStatus(…,
       "owner")`; the adapter never answers). It drops updates outside its own
       `turn_start`…`turn_end`.
    8. On its `turn_end`, reads the unit from `host.get(sid).workUnits()`, the
       same record `GetTask` will project. It publishes the final round whole
       (`append:false, lastChunk:true`, = `unit.result`), then the terminal
       status (`unit.reason`; a turn's error message is never forwarded).
       Then `session/detach` and close.
  - `cancelTask` → `session/cancel{sessionId, turnId}`; `CANCELED` comes from
    the turn's own end. A task not running here → `TaskNotCancelableError`.
  - `adapterRequest`: `hooks/trust` → `{trusted:false}`; anything else →
    `MethodNotFound`.
  - `A2ARequestHandler extends DefaultRequestHandler`: `sendMessage` /
    `sendMessageStream` call `executor.refuseFollowUp(message.taskId)` first.
- `packages/daemon/test/a2a-executor.test.ts` (new, 11 tests). It uses the
  real `A2ARequestHandler` + `InMemoryTaskStore`, a real `SessionHost` +
  `Agent` with a scripted model, a "phone" `Connection`, and a temp
  `LogSessionStore` for reopen. It covers:
  - stream order, round replace, the final artifact, the phone listing the
    session, unit = task;
  - detach;
  - owner-mode asks: not auto-denied, the phone answers, no `askedOn` label
    from the adapter;
  - `CancelTask`, and the phone's cancel;
  - busy;
  - hooks `false` + the host precheck honoured;
  - reopen of an archived context;
  - refusals open nothing;
  - follow-up on a running task refused (−32004) for both bindings;
  - cancel of an unknown task.
- No schema change (`protocol.json` untouched), no `protocol.d/` note, no new
  changelog fragment (S0's `changelog.d/a2a.added.md` stands; S10 rewrites it).

**Drift from Implementation:**
1. **Refusals are `REJECTED` tasks, not JSON-RPC errors.** The SDK runs
   `execute` detached and turns a rejection into a synthetic FAILED task
   (`_runExecutor`, `sdk dist/server/index.js:2914-2961`). So "busy →
   UnsupportedOperation" and "`raw`/`url` → −32005" cannot come from the
   executor. Busy → `REJECTED` + "the context is busy…". Bad ids, no caller,
   unsupported parts, a workflow part (until S8) and a bare answer (until S5)
   → `REJECTED` + a fixed reason. **Note for S9:** if −32005 must be a
   JSON-RPC error, check the parts in `http.ts` or in `A2ARequestHandler`
   before the SDK runs.
2. **New `A2ARequestHandler`, not in the plan.** A follow-up message naming
   a RUNNING task runs a second `execute` on the task's SHARED bus. Anything
   it publishes breaks a stream: a `task`/`message` breaks the running
   stream ("Stream ordering violation", `_advanceStreamPattern`
   `:3475-3492`, reproduced red), and a status first breaks the follow-up's.
   So it is refused BEFORE `execute`, as `UnsupportedOperationError` (−32004).
   **S9 must construct `A2ARequestHandler`, not `DefaultRequestHandler`.**
   **S5** relaxes `refuseFollowUp` for a task in `INPUT_REQUIRED`: the
   original stream has already ended at that state, so a second `execute`
   may publish there.
3. The executor never calls `bus.finished()`. The SDK settles the bus once
   `execute` returns (`_settleBus` `:2978-2987`). `execute` resolves at the
   turn's end, and a follow-up that slips past the guard waits for that end
   without publishing anything.
4. If the in-process channel closes before the end, NO terminal status is
   published: the turn may still run daemon-side, and `GetTask` (S6) reads
   its real state.
5. **Finding against S2 — STOPPED, not fixed here (outside S4's files).** A
   reopen of an archived session while its record is still RESIDENT (before
   its archive write lands, `session-host.ts:1036`, `:1384-1397`) restores
   from `SessionPersister.toRecord` (`session-persister.ts:538-568`). That
   record has **no `units`**, so the ended-units table comes back EMPTY. A
   reopen from disk keeps it. Experiment
   (`.tentacle/tmp/a2a/s4/reopen-units.test.ts`, one turn `t1`, then
   close → reopen):
   ```
   resident []
   disk [ "t1" ]
   ```
   Effect: after an idle-TTL archive + quick reopen, earlier tasks of that
   context drop out of `GetTask` (F3/F4 promise). Fix, for S2's owner (or
   S7): carry the table in the captured state → `toRecord` sets
   `units: {ended: table, open: []}`, plus a test reopening from the
   resident record. The S4 reopen test asserts only S4's property (the
   reopened conversation carries the first exchange), not the earlier unit.

**Notes for S5 / S6 / S9 / S10** (not verified by execution):
- S5: `askOf` sets no `kind` (fail-closed: owner-only). Map it with
  `client/permission-map`. `projectStatus` is called with `"owner"` in three
  places; make it the caller's mode.
- S6: the executor's live state is only `liveTaskIds()` and the bus. The
  projection should read `workUnits()` exactly as `endFromUnit` does.
- S9/S10: the executor's `version` option (`ClientInfo.version`) should get
  the build version. `daemon/src/index.ts` exports are not added yet (S9/S10
  wire them).

**Red before green:** the first run of the new file had 5 reds, each a real
defect, fixed in turn:
- the follow-up stream-ordering violation → drift 2;
- the phone's cancel needed an attached session;
- the hooks fake's request was invalid;
- the S2 reopen gap → drift 5;
- a wrong `askedOn` expectation.

Non-vacuity: R0 below (the executor's session wiring removed) → 9 of 11 fail.

**Mutations** (`.tentacle/tmp/a2a/mutate-s4.ts`, the file restored after each,
`restored true`):

| Mutation | Fails |
|---|---|
| R0 `execute` publishes WORKING and returns (no session path) | 9 |
| M1 `permission_request` not declared (the plan's "ask not auto-denied") | 2 |
| M2 the adapter answers the ask itself (the plan's "never `resolve_permission`") | 2 |
| M3 `hooks/trust` → `true` | 1 |
| M4 the host's precheck not passed | 1 |
| M5 open without `reopen` | 1 |
| M6 no `session/detach` | 2 |
| M7 `cancelTask` sends nothing | 2 |
| M8 busy → FAILED | 1 |
| M9 no round replace in the deltas | 1 |
| M10 `refuseFollowUp` lets a follow-up through | 1 |
| M11 no final whole-round artifact | 1 |
| M12 an unauthenticated user accepted | 1 (after adding `UnauthenticatedUser` + `isAuthenticated:false` cases; it survived with only `user: undefined`) |
| M13 `clientInfo` carries a `host` | 1 |
| M14 the terminal state from `turn_end` alone, not the session's unit | 2 |
| M15 an owner ask shown as plain WORKING | 2 |
| M16 a `turn_end` of ANY turn ends the task | **0 — survives** |

M16 is believed equivalent in reachable states (not proved). A session runs
one turn at a time, and the prompt is refused (`TurnInProgress`) while
another runs, so no other turn's `turn_end` reaches a watcher between its
accepted prompt and its own `turn_end`. The filter stays as defence.

**Gate (narrow):** `bun test` on `a2a-executor.test.ts` + `a2a-mapping.test.ts`
→ 35 pass / 0 fail. `biome check` on the 2 new files is clean. `tsc` limited
to the 2 files (`.tentacle/tmp/a2a/tsconfig.s4.json`) is clean. Full `bun run
check` NOT run (the orchestrator's script runs it).

### S5-caller-asks — DONE (the owner's `external/` move: partial, see drift 1)

*— claude-opus-5-5, 2026-11-25*

**Load-bearing check re-run first** (`bun .tentacle/tmp/a2a/seam.ts`): HOLDS,
the same five lines. **S5's own premise, checked in the SDK before coding:** a
follow-up on a task gets the SAME bus (`createOrGetByTaskId`,
`sdk dist/server/index.js:2125-2133`). Both the blocking call and the stream
stop at `INPUT_REQUIRED` (`ExecutionEventQueue` `:2181`). The bus outlives an
`execute` that returns in an interrupted state (`keepBusAliveStates` =
`INTERRUPTED_STATE_LIST`, `:2720`, `:2982`). An `execute` that returns while
the task is WORKING settles (closes) the shared bus. So every `execute` of a
task, the follow-ups included, awaits the turn's end.

**As built:**
- `packages/core/src/permission.ts`: `PermissionKind`, plus
  `EXTERNAL_ANSWER: {[K in PermissionKind]: "once" | "owner-only"}`. The type
  is exhaustive and only `tool` is `once`. Also `externalMayAnswer(kind)`:
  `undefined` → false.
- `packages/daemon/src/external/asks.ts` (new, pure, protocol-neutral, per
  the owner's decision):
  - `AskMode`, `PendingAsk` (+ `replyMax`) and `CallerAnswer`, moved from
    `a2a/mapping.ts`.
  - `callerMayAnswer`, now reading the core table, plus `onceOption` and
    `callerOptions`, also moved from `a2a/mapping.ts`.
  - New: `askIsOwn`, `askOf(update, own)` and `resolveCallerAnswer` (a
    decision → the ask's `*_once` `optionId`; a refusal's reply cleaned and
    clamped, sent only when the ask takes one).
- `a2a/mapping.ts` imports these from `external/asks.ts`. Nothing is
  re-exported (no shim). The mapping test imports from the new path.
- `a2a/executor.ts`:
  - `callerPolicy(caller) → {asks}` (absent → `owner`). The watcher carries
    `caller`, `mode` and `claim`. Both `projectStatus` calls use the mode.
  - Asks become `askOf(u, askIsOwn(u, taskId))`.
  - `refuseFollowUp` is replaced by `admitFollowUp(message, context)`, called
    by `A2ARequestHandler` before the SDK:
    - not the starting caller → `TaskNotFound`;
    - not INPUT_REQUIRED, or an answer already admitted → −32004;
    - not a valid answer to a caller-answerable ask → −32602
      (`RequestMalformedError`);
    - else the answer becomes the task's ONE claim. The handler releases it if
      the request fails before `execute` takes it.
  - The follow-up `execute` takes the claim, publishes the task (WORKING) as
    the follow-up stream's first event, and sends `session/resolve_permission`
    with that `optionId`. On any failure (e.g. the owner answered first), it
    re-projects the status. It then awaits the turn's end.
- Tests:
  - `core/test/permission-kinds.test.ts` (2) and
    `daemon/test/external-asks.test.ts` (4, pure).
  - `a2a-executor.test.ts`: the rig gains `asks` and a `workflow_approve`
    tool. That tool's wire name is what makes an ask owner-only, so it stands
    in for a file approval. 3 integration tests:
    - `both`: INPUT_REQUIRED; a data-part allow is `allow_once` (the next call
      asks again); a text refusal reaches the model with its reply;
    - an owner-only ask is never INPUT_REQUIRED, and a caller's answer is
      refused;
    - another caller, a bad answer, the claim released after an SDK refusal,
      a concurrent second answer, and a late answer after the owner's.

**Drift from Implementation:**
1. **Owner decision (`external/`), partly applied.** Moved: the ask policy,
   i.e. everything S5 touches. NOT moved:
   - the session driver (`connect` / `onUpdate` / `teardown` /
     `adapterRequest` in `a2a/executor.ts`);
   - the session id / caller helpers (`a2aSessionId`, `a2aCallerPrefix`,
     `contextIdOf` in `a2a/mapping.ts`).

   Splitting the driver from the SDK bus is a design step of its own: an event
   interface between the driver and the A2A publisher. S5's claim / bus rules
   are SDK-specific and sit on top of it. It belongs with S6, which builds the
   work-units projection in `external/` anyway. **S6 must do it.**
2. **The kind is not read through `client/permission-map`.** `@tentacle/daemon`
   does not depend on `@tentacle/client`. `askOf` applies the same one rule as
   the client's `toPermissionRequest` (`client/permission-router.ts:107-121`,
   `WORKFLOW_APPROVE_TOOL` → `workflow_approve`, else `tool`). On a daemon ask,
   `hooks_trust` and `session_hop` never appear: hooks trust is the
   `hooks/trust` request (answered NO), and a hop is the laptop's. The
   refusal-reply cleaning repeats the client's `normalizePermissionReply` in
   about 6 lines, for the same reason.
3. **Attribution, a gap the plan did not name.** A workflow step's ask (and a
   background child's) rides the background path. Its wire `turnId` is set
   only when the daemon knows the starting turn
   (`hosted-session.ts:1665-1671`, `workflow-driver.ts:1612-1620`). S4's
   watcher keeps such an ask while its turn runs. Unfiltered, a step of a run
   the OWNER started could become the caller's to answer. So an ask is the
   task's own only when it has no `turnId` and no `agent.id` (the turn's own,
   or a foreground sub-agent's), or when its `turnId` is the task. Anything
   else gets no kind, so it is owner-only.
4. **A crafted answer to an owner-only ask is −32004, not −32602, when it is
   the only pending ask.** In that case the task is not INPUT_REQUIRED (it
   reads WORKING + "waiting for the owner"), so the state refusal comes first.
   When a caller-answerable ask is pending too, the same answer is −32602.
   Either way the ask is untouched.
5. No schema change: `protocol.json` untouched, no `protocol.d/` note. The
   changelog fragment is unchanged: S5 has no user-visible effect until S9's
   route, and S10 rewrites it.

**Red before green:** the S5 tests passed on first run against the new code, so
the red proof is M1 below. M1 forces `owner` mode, which is exactly the pre-S5
behaviour, and both S5 tests that need `both` mode go red. The new pure modules
did not exist before.

**Mutations** (`/Users/gmeghnag/tentacle/.tentacle/tmp/a2a/mutate-s5.ts`, on
the 4 test files; each restored, `restored true` ×13):

| Mutation | Fails |
|---|---|
| M1 mode always `owner` (= pre-S5) | 2 |
| M2 allow → `allow_always` | 5 |
| M3 `workflow_approve` marked `once` (the plan's) | 6 |
| M4 resolve by `requestId` without the kind check (the plan's) | 1 |
| M5 `callerMayAnswer` ignores the kind | 5 |
| M6 every ask is the task's own | 1 |
| M7 no caller check in `admitFollowUp` | 1 (it survived at first, masked by the SDK's user-scoped store; a direct `admitFollowUp` assertion was added) |
| M8 the claim is never released | 1 |
| M9 no claim guard (two answers at once) | 1 |
| M10 any text allows | 2 |
| M11 the refusal reply dropped | 2 |
| M12 the follow-up publishes no task first | 2 |
| M13 the answer is never sent | 2 |

**Gate (narrow):** `bun test --rerun-each 3` on the 4 files → 132 pass / 0
fail (44 tests). `biome check` on the 8 changed files is clean. `tsc` limited
to them (`.tentacle/tmp/a2a/tsconfig.s5.json`, main checkout) is clean. Full
`bun run check` NOT run (the orchestrator's script runs it).

### S6-task-projection — DONE (archived contexts are S7's, as planned)

*— claude-opus-5-5, 2026-11-25*

**Load-bearing check re-run first.** `seam.ts` was gone (gitignored), so it was
re-extracted from this doc into `.tentacle/tmp/a2a/s6/seam.ts`, with its
imports pointed at THIS worktree's packages. It HOLDS, with the same five lines
(`1. a2a open → a2a-ctx-1 created true` … `5. … turn_end:end_turn turn_start
turn_end:cancelled`).

**S6's own premise, checked in the SDK before coding** (`@a2a-js/sdk`
`dist/server/index.js`):
- The store is read far more often than by `GetTask`:
  - `ResultManager` does load → merge → save for EVERY event (`:2311`,
    `:2341`, `:2452`);
  - a follow-up loads its task (`:2785`);
  - `cancelTask` re-loads after cancelling and needs CANCELED (`:3264`);
  - a stream's `task` event is re-read (`:3393`).
- So `load` must return the in-flight copy while the task streams, and a
  faithful projection once that copy is gone.

**As built:**
- `daemon/src/external/work-units.ts` (new, protocol-neutral, read-only):
  - `addressableUnits(units)`: a turn is addressed by its id, a run by its
    `origin` unless a turn has that id (the plan's rule), and a run with no
    origin is not addressable;
  - `callerUnits(source, protocol, caller, contextId?)` and
    `findCallerUnit(...)` read only the caller's `<protocol>-<caller>-*` live
    sessions, through `workUnits()`.
- `daemon/src/a2a/task-projection.ts` (new): `A2ATaskStore implements
  TaskStore`.
  - `save` keeps a task in memory, per caller, only while it is non-terminal.
    A terminal save deletes it, and an unauthenticated context keeps nothing.
  - `load` and `list` return the in-flight copy while
    `executor.isDriving(taskId)`, else the projection (`unitTask`). An undriven
    copy whose unit the session has ENDED is forgotten, because the session is
    the truth. An undriven copy whose unit has not ended (or that the session
    lacks) stays.
  - `list` follows the SDK in-memory store's filters, order (status timestamp
    desc, then id) and cursor format. Artifacts are included only on request.
  - Pure helpers: `unitTask` and `pageTasks`.
- `a2a/mapping.ts`:
  - `unitStatus(unit, mode)` is now the ONE status composition (projected
    state + message + the dropped-result note), used by both the executor's
    live end and the projection;
  - `textPart`, `responseArtifact` and `RESPONSE_ARTIFACT_ID` moved here from
    the executor (pure builders).
- `a2a/executor.ts`:
  - new `isDriving(taskId)`;
  - `endFromUnit` uses `unitStatus`;
  - the plumbing moved to `external/` (below).
- **Owner decision, the rest of S5's drift 1 (the `external/` move):**
  - `external/session-ids.ts`: `externalSessionId` / `callerPrefix` /
    `contextIdOf`, now taking a `protocol` word. They replace
    `a2aSessionId` / `a2aCallerPrefix` / `contextIdOf` of `a2a/mapping.ts`,
    which keeps only `A2A_PROTOCOL = "a2a"`. Same ids: `a2a-<caller>-<ctx>`.
  - `external/session-driver.ts`: the in-process client, i.e.
    `connectSession`, `openSession`, `detachSession` and `adapterRequest`:
    - `Connection` over `createChannelPair`;
    - `hooks/trust` always answered NO;
    - every update type declared;
    - no `host`;
    - open with create + reopen;
    - detach, then close.

    Its event seam is the raw `session/update` (`onUpdate` / `onClose`).
  - No shims: imports updated in the executor and the tests.
- Tests:
  - `daemon/test/a2a-task-projection.test.ts` (new, 12 tests: 7 integration
    tests with the real SDK handler and a real host, 5 pure);
  - `a2a-executor.test.ts`: the rig now wires `A2ATaskStore` instead of
    `InMemoryTaskStore`, so all 14 S4/S5 flows run on the projection. They
    passed unchanged, with no SDK `ResultManager` warning in the output.

**Drift from Implementation (and why):**
1. **`history` of a projected task is always empty.** The plan wanted "the
   caller's messages while their segment is live". No side-effect-free
   accessor gives a turn's user message, so it would need a new
   `HostedSession` method, which is S2's load-bearing file and outside S6's
   files. The spec allows empty history, and the caller sent those messages
   itself. An in-flight task keeps the history the SDK merged.
2. **The index is a scan, not a cache.** For live sessions the "taskId →
   session" index is derived on each miss, by walking the caller's live
   sessions' `workUnits()` (in memory, ≤ 256 units each). A cache would need
   invalidation on archive, delete and reopen; a scan cannot go stale. S7's
   archived side (disk reads) is where the plan's cached index and LRU belong.
3. **A projection never reads INPUT_REQUIRED.** Only a live watcher knows an
   ask's options, so a projected pending ask reads WORKING + "waiting for the
   owner's approval" in both modes (fail-closed). A caller's answer still goes
   through the live watcher (S5).
4. **A task that never became a unit is not retained.** That covers REJECTED
   (busy, bad ids, …) and FAILED at open. Once its terminal save lands,
   `GetTask` → `TaskNotFound`. This is "no A2A store" taken literally; it is
   pinned by a test.
5. **The driver split stops at the raw-update seam.** Turn-level interpretation
   (round replace, asks map, turn end), SDK bus publishing and claims stay in
   `a2a/executor.ts`. They are A2A-shaped. When MCP mounts it may lift a
   turn-event layer, but that layer has one user today.
6. Not done here (S7's, per S4 drift 5): the resident-record reopen that
   loses the ended-units table.
7. No schema change: no `protocol.d/` note, and `protocol.json` is untouched.
   The changelog fragment `a2a.added.md` is unchanged: S6 is invisible until
   S9's route, and S10 rewrites the fragment.

**Failure modes covered by tests** (`a2a-task-projection.test.ts`):
- ended → leaves memory, and `GetTask` = the session's unit (same result,
  deterministic);
- running → the in-flight copy for both `GetTask` and `ListTasks`, then the
  projection after the owner's answer;
- a unit the executor does not drive (the owner's own turn in the caller's
  context) → projected. `CancelTask` there → `TaskNotCancelable`, and the turn
  is still waiting (never a phantom CANCELED);
- owner scoping: another caller, an unauthenticated caller and a phone session
  all read nothing;
- `ListTasks`: per context, newest first, paged with a cursor, status filter,
  artifacts only on request;
- a deleted session → `TaskNotFound`, and a busy REJECTED task is not
  retained;
- reload into a fresh store and host from disk → an identical task, and the
  store dir holds only the session's own files (**no A2A file**);
- pure tests: the stale-copy rule (both arms), addressing, `unitTask`, and a
  malformed cursor.

**Red before green:** the new tests passed on their first run against the new
code, so the red proof is the mutations below. M1 is exactly the pre-S6 store
rule (`InMemoryTaskStore` keeps terminal tasks), and it turns 5 tests red. M2
(no projection) turns 10 red, the S4/S5 suite included.

**Mutations** (`.tentacle/tmp/a2a/mutate-s6.ts`, run on the projection,
executor and mapping test files; each restored, `restored true` ×15):

| Mutation | Fails |
|---|---|
| M1 `save` keeps terminal tasks (the in-memory store's rule) | 5 |
| M2 `load` reads memory only (no projection) | 10 |
| M3 the in-flight copy never used | 5 |
| M4 the copy trusted without `isDriving` | 1 |
| M5 drop the "projection not terminal" arm | 3 |
| M6 `contextIdOf` ignores the caller (the plan's owner scoping) | 2 |
| M7 `ownerOf` accepts an unauthenticated user | 1 |
| M8 `callerUnits` drops its `contextId` filter | **0 — equivalent**: `pageTasks` filters `contextId` again (the contract), so the first filter only saves work |
| M9 a run overrides a same-id turn | 1 |
| M10 `list` ignores in-flight copies | 1 (survived at first; a running-task `ListTasks` assertion was added) |
| M11 the live end and the read compose the status differently | 1 |
| D1 driver: `hooks/trust` → true | 1 |
| D2 driver: `clientInfo` names a `host` | 1 |
| D3 driver: no `session/detach` | 2 |
| D4 driver: open without `reopen` | 1 |

**Notes for S7 / S9** (not verified by execution):
- S9 wires the store as the executor test rig does:
  `new A2ATaskStore({host, isDriving: (id) => executor.isDriving(id),
  callerPolicy})`, with the SAME `callerPolicy` as the executor.
- S7 adds the archived side behind `findCallerUnit` / `callerUnits` (an
  `archived` source next to `UnitSource`). Live wins on the same id.

**Gate (narrow):**
- `bun test --rerun-each 3` on `a2a-task-projection`, `a2a-executor`,
  `a2a-mapping` and `external-asks` → 162 pass / 0 fail (54 tests).
- `biome check` on the 10 changed or new files is clean.
- `tsc` limited to them (`.tentacle/tmp/a2a/tsconfig.s6.json`) is clean.
- Full `bun run check` NOT run (the orchestrator's script runs it).

### S7-archived-tasks — DONE

*— claude-opus-5-5, 2026-11-25*

**Load-bearing check re-run first** (`.tentacle/tmp/a2a/s7/seam.ts`, copied
from S6's): HOLDS, the same five lines (`1. a2a open → a2a-ctx-1 created true`
… `5. … turn_end:end_turn turn_start turn_end:cancelled`).

**S7's own premise, checked before coding — it FAILED in part; the plan is
corrected inline (Unification §4, "S7 correction").**
- `store.readRaw` → the loader's parse holds, and it is exactly
  `SessionPersister.load` (`session-persister.ts:392-427`): flush, read, parse,
  `rebuild`, nothing written.
- `store.list()` is NOT "sidecar + first line only". It calls `summarize`, "the
  same walk as `load`" (`session-log-store.ts:1305-1306`), so it would read
  every history in full on an index miss.
- The header + sidecar index already exists in the HOST (`SessionHost.archived`,
  filled at start through `loadState` → `addArchived`). It also knows the
  resident record and the tombstones. So the archived source is the host, and
  no store handle is wired.

**Repro (red before any code):**
- `a2a-archived-tasks.test.ts` against a stub module: 6 fail. The capability
  is missing: an archived context's task → `TaskNotFound`.
- The S4-drift-5 test (reopen before the archive write lands, so the RESIDENT
  record is restored) failed on its assertion: the reopened session's units
  lack the earlier task (`- "eb521f5e-…"`, Expected 1 / Received 0). With the
  write landed first, it passed: that path reads from disk. That is why the
  test does not `flush`.

**As built (dependency order):**
1. `persisted-session.ts`:
   - `DaemonSessionState.units?: SegmentUnits` (archive's capture only, never
     written to disk);
   - `archivedUnitsOf(record)`, pure: `reconcileOnReload` (an archive resumes
     nothing) + `endedUnitsAtLoad` at `archivedAt ?? updatedAt`, so two reads
     of one record are equal;
   - the `ArchivedUnitsRead` type.
2. `hosted-session.ts`:
   - `segmentUnits()` extracted from `refreshUnits` (one derivation);
   - `archive()` captures it BEFORE the close, i.e. the units of the log part
     it writes, as a load of that file derives them.
3. `session-persister.ts` `toRecord`: carries `state.units`. This fixes S4
   drift 5: the resident record keeps the ended-units table.
4. `session-host.ts` (additive, read-only):
   - `ArchivedEntry.archivedAt`;
   - `archivedSessions()`: the archived index, metadata only;
   - `readArchivedUnits(id)`: resident record, else `persister.load`, then
     `archivedUnitsOf`. A failure returns `unreadable` and never drops or
     blocks the entry (a failed REOPEN does).
5. `external/archived-units.ts` (new, protocol-neutral): `ArchivedUnitIndex`.
   - The index, per archived session: its version (`updatedAt:archivedAt`),
     its context and its addressable units WITHOUT results. Only the
     caller's `<protocol>-<caller>-*` sessions are read; a new or changed one
     is read once at the next lookup; a gone one leaves the index and the LRU.
   - An LRU of the full units, 8 sessions (`ARCHIVED_LRU_CAPACITY`).
   - `find` (GetTask) and `units({contextId, results})` (ListTasks). Results
     are read through the LRU only when the list returns artifacts.
   - Unreadable → no task + `onUnreadable` once per version.
6. `a2a/task-projection.ts`:
   - options `archived?: ArchivedUnitSource` and
     `onArchivedUnreadable?(id, reason)` (S9/S10 wire `archived: host`
     and the audit line);
   - `load`: live, then archived;
   - `list`: live, then archived ids not already live, then in-flight copies.

**Drift from Implementation (and why):**
1. The archived source is the host, not the store, and no store handle is
   wired in `serve.ts` (the premise failure above). `session-host.ts`,
   `persisted-session.ts`, `hosted-session.ts` and `session-persister.ts` are
   touched although Files lists only `task-projection.ts` for S7. Two reasons:
   the host owns the only header-only index, and S4 drift 5 / S6 drift 6
   assigned the resident-record fix to S7.
2. The LRU version is the index's `updatedAt` + `archivedAt`, not the file's
   size + mtime: no `stat`, and a write that changes no unit (rename, pin,
   reclaim) does not invalidate.
3. The index and LRU live in `external/` (owner decision Q1, protocol-neutral),
   not in `a2a/task-projection.ts`.
4. The tests are in a new file, `a2a-archived-tasks.test.ts`, not in
   `a2a-task-projection.test.ts` (that file stays S6's; the rig is
   duplicated, small).
5. Known, not fixed: a cut unit's `endedAt` is `archivedAt` on an archived
   read but `now` on the reopen (`restore` passes `now`, unchanged here). So
   a task cut by the archive changes its status timestamp once, when its
   context is reopened. The state is the same (CANCELED).
6. No schema change, so no `protocol.d/` note and `protocol.json` is untouched.
   `changelog.d/a2a.added.md` is unchanged: S7 is invisible until S9's route,
   and S10 rewrites it.

**Failure modes covered** (`a2a-archived-tasks.test.ts`, 9 tests):
- archive, then a quick reopen from the RESIDENT record → the earlier task
  stays in `workUnits()` and in `GetTask`;
- archived `GetTask`/`ListTasks`, resident and from disk on a fresh host
  (indexed as `serve` does at start) → a task identical to the pre-archive
  one; the session stays archived (`get` undefined, `archivedCount` 1); every
  store file is byte-identical before and after (a writer's transient
  `.lock` aside);
- archived mid-turn (waiting on an ask) → CANCELED, identical resident and
  from disk;
- owner scoping (another caller reads nothing); an archived session deleted →
  `TaskNotFound`;
- a future `schemaVersion` and a garbage log → `TaskNotFound` twice, one audit
  line, the entry kept, the files untouched;
- index + LRU (pure, fake source):
  - built once per caller; hits come from the LRU; eviction past 8;
  - another caller's prefix reads nothing;
  - a changed session is re-read; a gone one leaves both caches;
  - an artifact-less list reads the index only, and results are stripped from
    it;
  - unreadable: reported once per version, also on the LRU-miss path.

**Mutations** (`.tentacle/tmp/a2a/mutate-s7.ts`, run on the archived and
projection test files; each restored, `restored true` ×17):

| Mutation | Fails |
|---|---|
| R1 `toRecord` drops the captured units (S4 drift 5) | 2 |
| R2 the archive capture carries no units | 2 |
| R3 the read REOPENS the session (`restore`) | 1 |
| R4 a failed read drops and blocks the entry (as a reopen) | 1 |
| R5 the store never reads archived (`load`) | 2 |
| R6 the store never lists archived | 1 |
| R7 the index ignores the version | 1 |
| R8 no LRU (every hit re-reads) | 3 |
| R9 a gone session stays indexed | 1 (survived at first: lookups never iterate it, memory only; `cachedCount` assertion added) |
| R9b a gone session stays in the LRU | 1 |
| R10 the index keeps results | 1 |
| R11 the list reads full units always | 1 |
| R12 unreadable reported on every read | 1 (survived at first: the index already avoids re-reads; the LRU-miss case was added) |
| R13 cut units closed at the read's clock | 1 |
| R14 no index (scan every session on each lookup) | 4 |
| M6 `contextIdOf` ignores the caller | 3 (archived + live) |

**Gate (narrow):**
- `a2a-archived-tasks`, `a2a-task-projection`, `a2a-executor`, `work-units`
  and `persistence` → 163 pass / 0 fail.
- The 14 existing files that exercise archive/reopen/close (daemon, client,
  cli) → 337 pass / 0 fail.
- `biome check` on the 7 changed or new files is clean.
- `tsc` scoped to them (`.tentacle/tmp/a2a/tsconfig.s7.json`) is clean.
- Full `bun run check` NOT run (the orchestrator's script runs it).

### S8-workflow-tasks — DONE

*— claude-sonnet-5-5, 2026-11-25*

**Load-bearing check (re-run):** the projection already addresses a run by its
`origin` (`external/work-units.ts:addressableUnits`), and
`session/workflow{start}` takes the task id as `turnId` and answers `runId`
synchronously (`hosted-session.ts:2838`, `workflow-driver.ts:691`) → holds.

**As built** (`packages/daemon/src/a2a/executor.ts` only; no protocol change):
- `CallerPolicy.workflows?: boolean` (default off). A `tentacle/workflow` data
  part with the switch off → the existing `REJECTED` + `REFUSED.workflow`, nothing opened.
- A `Watcher` has `kind: "turn" | "workflow"` and a `runId`. A run task opens
  `a2a-<caller>-<ctx>` (title `A2A: workflow <name>`), publishes `WORKING`, sends
  `session/workflow{start, name, inputs, turnId: taskId}` (`startRun`).
  Refusal: `running` → `REJECTED` + busy; any other refusal → `FAILED` + the
  daemon's own one-line reason; an unreadable answer → `FAILED`.
- `syncRun` projects the run on every `workflows` update, ask change and the
  start's answer: the session's own unit (`workUnits()`; ended → its result is
  the `response` artifact, the same record `GetTask` reads); if the row ended
  before the ended-units table, the row's own end (no result). A pending ask
  while the row says `running` → `waiting`. Mode/kind rules are `projectStatus`'s
  (S5): file approval → `WORKING` + message in every mode; a step's `tool` ask
  → `INPUT_REQUIRED` in `both`.
- Asks are admitted for a run only with `turnId === taskId` (strict; a turn also
  admits `undefined`). Turn-only events (`turn_start`, chunks, `turn_end`) are
  ignored by a run watcher.
- `cancelTask` of a run → `session/workflow{stop, runId}` (`CANCELED` from the
  run's `stopped:cancelled`); before the run id is known → `TaskNotCancelable`.

**Drift / limits:** (1) S2's note holds: a `needs-approval` run has no `origin`
yet, so `GetTask` cannot find it until approved; while the executor drives it,
the in-flight copy answers. (2) "`changed` refusal → FAILED" comes from the
start's own refusal (nothing is run, no unit), not from a unit. (3) The
flag/CLI wiring (`--a2a-workflows`) is S10's.

**Tests** `packages/daemon/test/a2a-workflow-tasks.test.ts` (8): switch off;
start→COMPLETED + artifact + GetTask + phone listing; refused start (inputs,
missing file); busy context; CancelTask → CANCELED; unapproved file in `both`
(never INPUT_REQUIRED, owner approves); `both` step ask → INPUT_REQUIRED →
caller's allow → COMPLETED (once); `owner` step ask → WORKING, owner answers.

**Red / mutations** (each restored; 8/8 green after): the feature is new — on
the S7 tree a workflow part was always REJECTED, so tests 2, 4–8 could not pass.
Mutations killed: switch ignored → "switch off" red; stop sent to `wf-999` →
CancelTask red; run asks not admitted (`inTurn:false`) → `both` ask red; mode
forced to `both` for a run → `owner` ask red; `running` mapped to FAILED → busy
red.

**Gate:** 3 daemon test files (workflow-tasks, executor, task-projection) 34
pass / 0 fail; `biome check` clean on the 2 touched files; `tsc -p packages/daemon`
clean. Full `bun run check` NOT run (the script runs it). Changelog: the
existing `changelog.d/a2a.added.md` still covers the feature (serve does not
speak A2A until S9/S10); no new fragment.

## Review

### Owner decision 2026-11-25 ~13:20 (from the feat/serve-mcp-server plan, Q1) — binding for the remaining slices

The external entry is **protocol-neutral**, written once for A2A and MCP: the session driver and the HTTP route live in `external/` (e.g. `external/session-driver.ts`, `external/route.ts`; the dedicated-token check, the caller identity, the work-units projection), and ONLY the A2A wire mapping lives in `a2a/`. MCP (feat/serve-mcp-server) will mount on the same `external/` seam with no extraction. If a slice already done put a protocol-neutral piece under `a2a/`, the NEXT slice moves it to `external/` (record the move in Execution). *— claude-opus-5-5 (orchestrator, recording the owner's decision), 2026-11-25*
