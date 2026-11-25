# feat/a2a — `tentacle serve` speaks A2A (server MVP)

> **Status:** implementation — **APPROVED (owner answers 2026-11-25)** (revision 2: scope re-examined per owner Q3)
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

*— claude-opus-5-5, 2026-11-25 (rev. 2 after the owner answers: Q1 option, Q3 scope re-examined)*

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
  archive/reopen (`:4950-4958`). ⇒ restart reconciliation READS the turn's
  state; it never re-sends a prompt (a key the daemon no longer has would
  otherwise RUN the task a second time).
- **The push grace already arbitrates "first answer wins":** an ask answered
  before its grace ends is never pushed; an attached device is never pushed
  (`packages/daemon/src/push-rules.ts:14-28`). The A2A adapter is not a
  registered device, so it never suppresses the owner's push.
- **Deleted sessions are known to `serve`:** `TombstoneFile(dir)`
  (`serve.ts:594`).
- **SDK seams** (`@a2a-js/sdk` 1.3.0): `TaskStore { save, load, list }`
  (scoped by `context.user`); `InMemoryTaskStore(ownerResolver?)` implements
  all three; `AgentExecutor.execute` is called again with
  `requestContext.task` set for a follow-up message on an interrupted task;
  the handler keeps the event bus alive in `INPUT_REQUIRED`/`AUTH_REQUIRED`
  (`DefaultRequestHandlerOptions`, `dist/server/index.d.ts:267-280`).

### Owner answers

*2026-11-25 ~11:20, verbatim:*

1. **Who answers an A2A task's asks:** «deve essere opzionabile, per supportare entrambi gli scenari»
2. **Token:** dedicated A2A token (`--a2a-token-command`), opens only `/a2a` — as recommended.
3. **MVP cuts:** «preferisco sforare la mezzanotte ma fare le cose pulite in ottica design robusto e risparmio tokens se questo MVP non soddisfacesse queste richieste»
4. **SDK:** yes, `@a2a-js/sdk`.

### Scope (revision 2 — every cut re-examined)

Rule (owner Q3): a cut stays OUT only if adding it later is **purely
additive** (no rework, no breaking change, no migration of stored data);
otherwise it comes IN. Second lens: **token saving** for the caller (what we
send) and for us (what we store/resend).

| Item | Draft 1 | Rev. 2 | Why |
|---|---|---|---|
| Agent Card, `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask` | in | **in** | the MVP |
| `SubscribeToTask` | in | **in** | free with the SDK; the way back after a dropped stream |
| Task records | memory only | **in: persisted** (one file per task, write on state change) + restart reconciliation | memory-only is NOT additive to fix: tasks created before the fix would be lost, and a restart today breaks `GetTask` on a live session; an interrupted task (`INPUT_REQUIRED`) must survive a restart since the daemon resumes its turn |
| `ListTasks` | out | **in** | a persistent `TaskStore` must implement `list` anyway; owner-scoped by the SDK |
| Caller identity on every record + session id | none | **in**: `a2a-<caller>-<contextId>`, task owner = caller | adding it later would mean migrating records/ids (not additive). One caller (`default`) today; more callers later = config only |
| Who answers asks (Q1) | owner only | **in**: per-caller `asks: owner \| both` | owner answer |
| Continue an ARCHIVED context (idle TTL) | error | **in**: `reopen` own `a2a-<caller>-…` only | multi-turn over hours must not die at the TTL; one param |
| Response size (token saving) | all text, streamed | **in**: artifact `response` = the **final round's** text (a new round after a tool call starts with `append:false`, replacing); streamed as deltas | the caller gets the answer, not "let me read the file…" narration; `GetTask` returns only the final text |
| Per-tool status updates | status message per tool call | **out** | they cost the caller's tokens on every stream; adding them later as an opt-in A2A extension is additive |
| Task `history` | user message | **in**: caller messages only (never agent chunks); `historyLength` honoured | no re-sending of what the caller already has |
| Thoughts, plans, usage, tool output | not sent | **not sent** | token saving; tool output stays on the host |
| Inbound `raw`/`url` file parts | refused (−32005) | **out** (−32005) | accepting later turns an error into success = additive; `url` fetch is an SSRF surface needing its own design |
| Outbound files / presented artifacts | not sent | **out**; when added: **by reference** (`url` part to an authenticated `/a2a/files/<sha>`), never inline base64 | new artifacts beside `response` = additive |
| HTTP+JSON (REST), gRPC bindings | out | **out** | a new `supportedInterfaces` entry = additive |
| A2A push notifications (webhooks) | out | **out** (`capabilities.pushNotifications:false`) | additive; caller-supplied URLs = egress/SSRF, own design |
| A2A 0.3 compat (missing `A2A-Version`) | out | **out** (−32009) | SDK `legacyCompat` later = additive |
| Extended / signed Agent Card | out | **out** | additive card fields |
| Message to a busy context | error | **error** (UnsupportedOperation) | queueing later turns an error into success = additive |

### Design

```
A2A caller ──HTTP(S)── Bun.serve fetch (ws-server.ts) ──► a2a/http.ts (A2A token, Origin, size, card, SDK glue, SSE)
                                                             │ SDK DefaultRequestHandler + a2a/task-store.ts (persisted)
                                                             ▼
                                                 a2a/executor.ts (AgentExecutor; one in-process client per live task)
                                                             ▼ createChannelPair()
                                       Connection ──► SessionHost (the SAME one the phone/TUI use)
```

**Mapping (pure, `a2a/mapping.ts`):**

| A2A | tentacle |
|---|---|
| caller (the A2A token's name; `default` from the CLI) | `ServerCallContext.user`; task owner; session-id prefix |
| `contextId` | session `a2a-<caller>-<contextId>` (created on first message, `title:{text:"A2A: <first line ≤60>", source:"user"}`; reopened if archived) |
| `taskId` | `turnId` of the turn that message starts |
| `text` parts | one `{type:"text"}` block (parts joined in order) |
| `data` parts | `{type:"text"}` block of the JSON, fenced — except a `tentacle/permission` answer (below) |
| `raw` / `url` parts | `ContentTypeNotSupportedError` (−32005), nothing opened |
| `agent_message_chunk` (text) | `artifactUpdate` `response`: `append:true`; the first chunk after a `tool_call` → `append:false` (replaces: final round only) |
| `permission_request` (our turn) | `owner`: none (task stays `WORKING`, one status message "waiting for the owner's approval"); `both`: `INPUT_REQUIRED` + the ask (below) |
| `permission_resolved` (owner answered first) | back to `WORKING` |
| `turn_end end_turn` / `max_*` | `COMPLETED` (`max_*` adds a status message with the reason) |
| `turn_end cancelled` | `CANCELED` |
| `turn_end error` | `FAILED`, message = the (already redacted) turn error |
| `session_closed` / channel closed mid-turn | `FAILED "session closed"` |
| thoughts, plan, usage, tool calls, jobs, … | not forwarded |

**Asks answered by the caller (Q1) — config per caller (= per token):**
`asks: "owner"` (default, the safe one) | `"both"`. CLI: `serve
--a2a-token-command <cmd> [--a2a-asks owner|both]` defines the caller
`default`. There is deliberately no "caller-only" mode: the owner is the
trusted party on this host and can always answer or cancel (they are always
raised the ask), and `both` already covers the unattended scenario — the push
grace keeps the phone silent when the caller answers in time
(`push-rules.ts:14-28`), and pings the owner when it does not.

In `both`, on a `permission_request` of the task's own turn the adapter
publishes `INPUT_REQUIRED` with `status.message` = one text part ("<tool>:
<title>. Answer allow or deny.") + one `data` part
`{"tentacle/permission": [{requestId, tool, title, explanation?, options:[{optionId, kind}], reply?:{maxChars}}]}`
listing EVERY pending ask of the turn, with options **filtered to
`allow_once` / `reject_once`**. The caller answers with `SendMessage{message.taskId}`:
- a `data` part `{"tentacle/permission": {requestId, decision:"allow"|"deny", message?}}` (one per ask), or
- text, only when exactly one ask is pending: `allow`/`approve`/`yes` (trimmed,
  case-insensitive, nothing else) → allow; **any other text → deny**, with the
  text as the refusal reply when the ask offers `reply` (fail-closed).

**Never a lasting approval, always decided on the host:** the adapter — daemon-side,
trusted code — maps `decision` to the ask's own `*_once` `optionId`; a caller
never names an `optionId`, so `allow_always`/`reject_always` are unreachable
from A2A. The adapter never sends `session/set_auto_accept`,
`session/set_capability`, `session/update_settings`, a `skill`, or a `hooks/trust`
`true`. In `owner` mode a caller's answer is refused
(UnsupportedOperation "this task waits for the owner"). A late answer
(`PermissionNotPending`) returns the task as it is now.

**Executor (`a2a/executor.ts`)** — `execute(requestContext, bus)`:
- **New task:** map parts → new `createChannelPair()` + `new Connection(daemonEnd,
  host, onError, {hooksTrustPrecheck})` + `RpcPeer(clientEnd)` whose `onRequest`
  answers `hooks/trust` → `{trusted:false}` and everything else
  `MethodNotFound` → `initialize` (`clientInfo:{name:"a2a"}`, no `host`;
  `updates` incl. `permission_request`) → `session/open{create:true, reopen:true}`
  on `a2a-<caller>-<contextId>` (never another id; never `autoAccept`,
  `capabilities`, `settings`, `messages`) → publish the Task (`WORKING`) →
  `session/prompt{turnId: taskId}` → translate updates of OUR `turnId` only →
  on the terminal state `bus.finished()`, `session/detach`, close the channel
  (the session returns to the host's normal TTL/archive life).
- **Follow-up on a live task** (`requestContext.task` set): route to that
  task's live watcher (a map taskId → watcher) → the caller-answer path above.
  A follow-up on a terminal task → SDK error.
- `cancelTask(taskId)` → `session/cancel{sessionId, turnId}`; the `CANCELED`
  comes from the resulting `turn_end` (one source of truth; the owner's cancel
  from the phone takes the same path).

**Task store (`a2a/task-store.ts`)** — `InMemoryTaskStore` (owner-scoped,
serves `load`/`list`) + write-through to
`<daemonStoreDir>/a2a/tasks/<taskId>.json` = `{schemaVersion:1, caller, task}`
(A2A wire JSON), atomic (tmp + rename), under serve's existing store lock. A
file is written only when the task's `status.state` changes (or at the
terminal state with the final artifact) — never per streamed chunk. Load at
start: an unknown `schemaVersion` or unreadable file is skipped with a notice
and left untouched (AGENTS §7 on-disk rule).

**Restart reconciliation** (at start, after the host reloaded its sessions),
for each non-terminal record, through an injected read-only
`HostReader { knownTurn(sessionId, turnId), isDeleted(sessionId) }`:
- session deleted (tombstone) → delete the record;
- `ended` → the mapped terminal state (a cut turn is `FAILED` "interrupted:
  the daemon restarted");
- running (a resumed, re-asked turn) → re-attach a watcher (`session/open`,
  no create) and re-publish the ask state (`INPUT_REQUIRED` in `both`);
- unknown turn / session not live → `FAILED` "interrupted by a restart".
  Never a re-prompt: nothing runs twice.
`GetTask`/`ListTasks` of a task whose session was deleted later → TaskNotFound
and the record is removed (lazy; `isDeleted` on load).

**HTTP (`a2a/http.ts`)** — `handle(req): Promise<Response> | undefined`,
called first in `startWsServer`'s `fetch`:
- `GET /.well-known/agent-card.json` → the card (public, per spec):
  `supportedInterfaces[0] = {url:"<request origin>/a2a", protocolBinding:"JSONRPC", protocolVersion:"1.0"}`,
  `capabilities{streaming:true, pushNotifications:false}`, modes
  `text/plain`+`application/json`, one skill `tentacle-session` (no path, no
  host name), `securitySchemes:{bearer:{httpAuthSecurityScheme:{scheme:"Bearer"}}}`
  + `securityRequirements`.
- `POST /a2a` → any `Origin` → 401 (cross-site POSTs are not preflighted) →
  bearer must match a caller's token (`tokensMatch`) else 401 + audit →
  body > 1 MiB → 413 → `validateVersion` → `JsonRpcTransportHandler.handle(body,
  ctx{user: caller})` → JSON, or SSE with a `: ping` comment every 15 s; and
  `server.timeout(req, 0)` so Bun's 10 s HTTP idle timeout never cuts a
  blocking `SendMessage` waiting on an approval.
- A2A disabled (no A2A token) → both paths behave exactly as today.

**Visible + stoppable by the owner:** an A2A session is an ordinary `serve`
session ("A2A: …") in the phone's/TUI's `session/list`: attach, read, answer
asks (always), cancel, close, delete — existing paths, proved above.

### Files

1. `packages/daemon/package.json` — `"@a2a-js/sdk": "1.3.0"` (pinned) + `bun.lock`.
2. `packages/daemon/src/a2a/mapping.ts` (new, pure) — parts→blocks, update→event (round replace), stopReason→state, ask→`INPUT_REQUIRED` message, caller-answer parser, card builder, session id.
3. `packages/daemon/src/a2a/executor.ts` (new) — the `AgentExecutor` + live watchers.
4. `packages/daemon/src/a2a/task-store.ts` (new) — persisted `TaskStore` + reconciliation.
5. `packages/daemon/src/a2a/http.ts` (new) — route, auth, SDK glue, SSE.
6. `packages/daemon/src/ws-server.ts` — `WsServerOptions.a2a?`; `fetch` calls `a2a.handle(req)` first (≈10 lines).
7. `packages/daemon/src/index.ts` — exports.
8. `packages/cli/src/flags.ts` — `serve`: `a2a-token`, `a2a-token-command`, `a2a-asks`.
9. `packages/cli/src/serve.ts` — `ServeOptions.a2a` → task store dir, `HostReader` (host + tombstones), `startWsServer`; one startup line "A2A on …/a2a (asks: owner)".
10. `packages/cli/src/main.ts` — help text.
11. `changelog.d/a2a.added.md`; `README.md` "A2A" section; `TODO.md` entry.

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| No / wrong token | 401 before parsing; audit `a2a-auth-failure`. Card stays public (spec). |
| Browser `Origin` on POST | 401 (CSRF), as the WS route. |
| Unknown method / bad params / bad version | SDK: −32601 / −32602 / −32009 (supported list). |
| Huge input | > 1 MiB → 413; nothing opened. |
| `raw`/`url` part | −32005, nothing opened. |
| Busy context (another task, or the owner typing) | `TurnInProgress` → UnsupportedOperation "a task is already running in this context"; nothing queued, first task unaffected. |
| Follow-up on a terminal task | SDK rejects; a new task needs no `taskId`. |
| Caller drops mid-stream | The turn continues; `SubscribeToTask`/`GetTask` read it. |
| `CancelTask` mid-turn / owner cancels | `session/cancel{turnId}` → `turn_end cancelled` → `CANCELED`; terminal → `TaskNotCancelable`. |
| Ask, `owner` mode | `WORKING` + status message; HTTP never times out (`timeout(req,0)`, SSE pings); a caller's answer is refused. |
| Ask, `both` mode | `INPUT_REQUIRED` (stream/blocking call ends, per spec); first answer wins (caller's `*_once`, or the owner's anything); owner first → `WORKING`. |
| Caller answers ambiguously | Fail-closed: anything but `allow`/`approve`/`yes` is a deny; several pending asks + text → InvalidParams, still `INPUT_REQUIRED`. |
| Caller tries a lasting approval | Impossible: it sends a decision, the host picks the `*_once` option. |
| Late answer | `PermissionNotPending` → the current task returned, no effect. |
| Hooks trust asked | `false` → hooks run only if the host's own store trusts the folder. |
| Session cap | `session/open` error → SendMessage error, nothing started. |
| Context archived (idle TTL) | reopened (own prefix only); deleted (tombstone) → error "context deleted by the owner". |
| `serve` restart | Records reload; non-terminal ones reconciled by READING `knownTurn` (never re-prompted); a resumed suspended turn gets its watcher and asks back. |
| Crash between state writes | The record is at most one state behind; reconciliation at start converges it from `knownTurn`. |
| Corrupt / future record file | Skipped with a notice, never rewritten. |
| Owner deletes the session | Its records go at the next start or on the next `GetTask`/`ListTasks`. |
| Two callers | Today one (`default`). Records and session ids carry the caller, so later callers cannot see or prompt each other's (SDK owner scoping + id prefix). |
| contextId naming a phone session | Impossible: only `a2a-<caller>-…` is ever opened. |
| Wake turn in an A2A session (a background job ends) | Not a task: ignored by the watcher (only our `turnId`); visible to the owner. |

### Tests

Fakes: the daemon pattern (`session-auto-accept-asked-on.test.ts`: real
`SessionHost` + `Agent` + scripted `ModelProvider`, `Connection` over
`createChannelPair`); `until` from `packages/client/test/support/fakes.ts`,
never a sleep; temp dirs for the store. Each test names its mutation (§9).

- `a2a-mapping.test.ts` (pure): stopReason→state table; parts→blocks; raw/url
  refused; round replace (`append:false` after a `tool_call`); ask message
  lists every pending ask with only `*_once` options; answer parser (data,
  `allow`/`yes`, any other text → deny with reply, several asks + text →
  invalid); card required fields + Bearer scheme; session id prefix.
- `a2a-executor.test.ts`:
  1. a message creates `a2a-default-<ctx>` and streams `task → artifactUpdate → COMPLETED`; the artifact holds only the final round;
  2. `owner`: status "waiting…", a "phone" connection answers → COMPLETED; the adapter never sent `resolve_permission` (mutation: adapter answers → red);
  3. adapter alone attached: the ask is NOT auto-denied (mutation: drop `permission_request` from its updates → red);
  4. `both`: `INPUT_REQUIRED`; the caller's `allow` → the daemon got the `allow_once` optionId (mutation: forward a caller-supplied optionId → an `allow_always` gets through → red); "no, use X" → reject with reply; owner answers first → `WORKING`;
  5. `cancelTask` → `CANCELED`; the phone's cancel → `CANCELED`;
  6. busy context → error, first task unaffected;
  7. `hooks/trust` → false; no `askedOn` entry for the adapter; detach after terminal (`attached` 0);
  8. archived context → reopened; tombstoned → error.
- `a2a-task-store.test.ts`: write only on state change (count writes over a streamed task); reload restores load/list with owner scoping; future `schemaVersion` skipped, file untouched; reconciliation table: ended / running → watcher / unknown → FAILED / deleted → removed; never a `session/prompt` during reconciliation (mutation: re-prompt → spy sees it → red).
- `a2a-http.test.ts` (real `startWsServer`, loopback, port 0): 401 no/wrong token; 401 with `Origin`; card public + well-formed; 413; −32009; −32601; A2A off → paths as today; WS route unaffected; a blocking call outlives 10 s idle (short `idleTimeout` in the test).
- **e2e** `a2a-e2e.test.ts`: `startDaemon` (scripted `createProvider`, temp store, `devices:false`, A2A token) + the **SDK client** with an auth `fetch`: card → `sendMessage` → `sendMessageStream` (order) → `getTask` → `listTasks` → `cancelTask` on a hanging turn → a WS client (serve token) sees `a2a-default-<ctx>`; caller aborts mid-stream, turn still completes; `both`: `INPUT_REQUIRED` → answer → COMPLETED; **restart**: stop + `startDaemon` on the same store → `getTask` returns the finished task.

### Slices (executor: Opus; times are wall-clock estimates)

| # | Slice | Size | Est. |
|---|---|---|---|
| S0 | **mapping** — dep + `bun build --compile` smoke + `mapping.ts` + tests | M | 1 h 15 |
| S1 | **executor** — new task, stream, round replace, cancel, detach, owner-mode asks, hooks, reopen + tests 1–3, 5–8 | M | 1 h 30 |
| S2 | **caller-asks** — `both` mode: `INPUT_REQUIRED`, live-watcher routing, once-only answers, owner-first + test 4 | M | 1 h 15 |
| S3 | **task-store** — persisted `TaskStore`, `ListTasks`, restart reconciliation via `HostReader` + tests | M | 1 h 30 |
| S4 | **http-route** — `http.ts` + `ws-server.ts` hook, auth/Origin/413/version/SSE/timeout + tests | M | 1 h |
| S5 | **cli-e2e** — flags, serve wiring, help, README, changelog, e2e (incl. restart) | M | 1 h 15 |
| R | **review** — fresh-context Opus (§7 "remote not trusted", single session path, on-disk rule) + one fix round + `bun run check` | — | 1 h 30 |
| | **Total** | | **≈ 9 h 15** (serial; from ~12:00 → ~21:30, margin to midnight) |

## Execution

## Review
