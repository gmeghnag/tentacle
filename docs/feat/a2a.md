# feat/a2a — `tentacle serve` speaks A2A (server MVP)

> **Status:** implementation — **NOT approved** (owner questions below)
> **Branch:** `feat/a2a`
> **Size:** M · **Blast:** load-bearing (a new external session entry, AGENTS §7 "a remote is not trusted") · **Suited:** Opus plans + executes; mandatory fresh-context Opus review
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

*— claude-opus-5-5, 2026-11-25*

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

### Design

```
A2A caller ──HTTPS/HTTP── Bun.serve fetch (ws-server.ts) ──► a2a/http.ts (auth, card, SDK glue)
                                                               │ SDK DefaultRequestHandler + InMemoryTaskStore
                                                               ▼
                                                   a2a/executor.ts (AgentExecutor)
                                                               │ one in-process client per running task
                                                               ▼ createChannelPair()
                                         Connection ──► SessionHost (the SAME one the phone/TUI use)
```

**Mapping (pure, `a2a/mapping.ts`):**

| A2A | tentacle |
|---|---|
| `contextId` | session `a2a-<contextId>` (created on first message, `title: {text:"A2A: <first line, ≤60>", source:"user"}`) |
| `taskId` | `turnId` of the turn that message starts |
| `message.parts` `text` | `{type:"text"}` block (parts joined in order) |
| `message.parts` `data` | `{type:"text"}` block of the JSON, fenced |
| `raw` / `url` parts | MVP: `ContentTypeNotSupportedError` (−32005) — see Q3 |
| `turn_start` | (Task already published as `WORKING`) |
| `agent_message_chunk` (text) | `artifactUpdate` on artifact `response`, `append:true` |
| `tool_call` | `statusUpdate WORKING`, message "running <tool>: <title>" (no args, no output) |
| `permission_request` | `statusUpdate WORKING`, message "waiting for the owner's approval: <title>" (Q1) |
| `turn_end end_turn` / `max_*` | `COMPLETED` (a `max_*` adds a status message with the reason) |
| `turn_end cancelled` | `CANCELED` |
| `turn_end error` | `FAILED`, message = the (already redacted) turn error |
| `session_closed` / channel closed mid-turn | `FAILED` "session closed" |
| thoughts, plan, usage, jobs, … | not forwarded |

**Executor (`a2a/executor.ts`)** — per `execute(requestContext, bus)`:
1. Map parts (reject unsupported → throw the SDK's `ContentTypeNotSupportedError`).
2. New `createChannelPair()` + `new Connection(daemonEnd, host, onError, {hooksTrustPrecheck})`
   + `RpcPeer(clientEnd, {onNotification, onRequest})`. `onRequest`:
   `hooks/trust` → `{trusted:false}`; anything else → `MethodNotFound`.
3. `initialize` with `clientInfo:{name:"a2a",version}` (no `host`) and
   `clientCapabilities.updates` = the update types it handles, **including
   `permission_request`**.
4. `session/open{sessionId:"a2a-"+contextId, create:true, title}` — only ids
   with the `a2a-` prefix are ever opened, so a caller can never name a phone
   or TUI session. Never sends `autoAccept`, `capabilities`, `settings`,
   `skill`, `messages`, `reopen`.
5. Publish the Task (`WORKING`, history = the user message), then
   `session/prompt{turnId: taskId}`.
6. Translate updates whose `turnId` is ours (ignore another client's turn).
   On our `turn_end` publish the terminal status, `bus.finished()`, then
   `session/detach` + close the channel — the session returns to the host's
   normal idle TTL / archive life.
- `cancelTask(taskId, bus)` → `session/cancel{sessionId, turnId:taskId}`; the
  terminal `CANCELED` comes from the resulting `turn_end` (one source of truth;
  the owner's cancel from the phone takes the same path).

**HTTP (`a2a/http.ts`)** — a `handle(req): Promise<Response> | undefined`
plugged into `startWsServer`'s `fetch` BEFORE the plain-route `authorize`:
- `GET /.well-known/agent-card.json` → the card (no auth, per spec). Its
  `supportedInterfaces[0].url` = `<request origin>/a2a`, `protocolBinding:"JSONRPC"`,
  `protocolVersion:"1.0"`; `capabilities{streaming:true, pushNotifications:false}`;
  modes `text/plain`, `application/json`; one skill `tentacle-session`
  ("A coding agent session on this computer's project" — no path, no host);
  `securitySchemes:{bearer:{httpAuthSecurityScheme:{scheme:"Bearer"}}}`.
- `POST /a2a` → reject any `Origin` (browser CSRF: a cross-site POST is not
  preflighted) → bearer = the **A2A token** (`tokensMatch`) else 401 →
  body > 1 MiB → 413 (`maxRequestBodySize` + check) → `validateVersion` →
  `JsonRpcTransportHandler.handle` → JSON or SSE (`text/event-stream`, a
  `: ping` comment every 15 s) — and `server.timeout(req, 0)` so Bun's 10 s
  HTTP idle timeout never cuts a blocking `SendMessage` that waits on an
  owner approval.
- Any other path → unchanged (today's 401/426).
- Enabled ONLY when an A2A token is configured (`serve --a2a-token` /
  `--a2a-token-command`, Q2); otherwise the card path 404s exactly as today.

**Visible + stoppable by the owner:** the session is an ordinary `serve`
session (title "A2A: …") in the phone's/TUI's `session/list`; attach, read,
answer asks, cancel the turn, close it — all existing paths (proved above).
A push for its asks fires exactly as for any unattended session.

### Files

1. `packages/daemon/package.json` — `"@a2a-js/sdk": "1.3.0"` (pinned) + `bun.lock`.
2. `packages/daemon/src/a2a/mapping.ts` (new, pure) — parts→blocks, update→A2A event, stopReason→TaskState, card builder.
3. `packages/daemon/src/a2a/executor.ts` (new) — the `AgentExecutor` over an in-process `Connection`.
4. `packages/daemon/src/a2a/http.ts` (new) — route, auth, SDK glue, SSE.
5. `packages/daemon/src/ws-server.ts` — `WsServerOptions.a2a?: { token; … }`; `fetch` calls `a2a.handle(req)` first (≈10 lines).
6. `packages/daemon/src/index.ts` — export.
7. `packages/cli/src/flags.ts` — `serve`: `a2a-token`, `a2a-token-command`.
8. `packages/cli/src/serve.ts` — `ServeOptions.a2aToken` → `startWsServer`; one startup line "A2A on http://…/a2a".
9. `packages/cli/src/main.ts` — help text.
10. `changelog.d/a2a.added.md`; `README.md` short "A2A" section; `TODO.md` entry update.

### Failure modes

| Case | Behaviour / convergence |
|---|---|
| No / wrong token | 401 before parsing; audit line `a2a-auth-failure`. Card stays public (spec). |
| Browser `Origin` on POST | 401 (CSRF), same rule as the WS route. |
| Unknown method / bad params | SDK: −32601 / −32602. |
| `A2A-Version` unsupported | −32009 with supported list (SDK `validateVersion`). Missing header → SDK treats as 0.3 → −32009: verify what callers send in S2; if real clients omit it, accept missing as 1.0 (one line). |
| Huge input | > 1 MiB → 413; nothing opened. |
| `raw`/`url` part | −32005, nothing opened (Q3). |
| Second message to a context whose turn is running (another caller, or the owner typing) | `session/prompt` → `TurnInProgress` → the SendMessage fails with UnsupportedOperation "a task is already running in this context"; nothing queued. |
| Message with `taskId` of a terminal task | SDK rejects (task terminal); a new task needs no `taskId`. |
| Caller disconnects mid-stream | The turn continues (the executor is not tied to the HTTP response); `GetTask` / `SubscribeToTask` read it. Test pins it. |
| `CancelTask` mid-turn | `session/cancel{turnId}` → `turn_end cancelled` → `CANCELED`. On a terminal task → SDK `TaskNotCancelable`. |
| Owner cancels / closes from the phone | Same `turn_end` path → `CANCELED`; `session_closed` → `FAILED "session closed"`. |
| Ask pending for hours | Task stays `WORKING` + status message; HTTP not timed out (`timeout(req,0)` + SSE pings); the caller may drop and poll `GetTask`. |
| Hooks trust asked | Adapter answers `false` → hooks don't run unless the host's own store trusts the folder. |
| Session cap reached (`max-sessions`) | `session/open` error → SendMessage error, nothing started. |
| `serve` restarts | Sessions reload (persisted); the in-memory task store is gone → `GetTask` → TaskNotFound; a new message on the old `contextId` reopens `a2a-<ctx>` if live, or fails `SessionArchived` → mapped to an error (MVP; Q3). |
| Two A2A callers, different contexts | Two sessions, independent. Same token = same principal: one caller can read the other's tasks by id (MVP, Q2). |
| contextId naming a phone session | Impossible: only `a2a-` + contextId is ever opened. |

### Tests

Fakes: the daemon tests' pattern (`session-auto-accept-asked-on.test.ts`:
real `SessionHost` + `Agent` with a scripted `ModelProvider`, `Connection` over
`createChannelPair`); poll with `until` (`packages/client/test/support/fakes.ts`), never a sleep.

- `a2a-mapping.test.ts` (pure): every stopReason → state; text/data parts →
  blocks; raw/url refused; card has the required fields and the Bearer scheme.
- `a2a-executor.test.ts`:
  1. a message creates `a2a-<ctx>`, streams `task → artifactUpdate(s) → COMPLETED`, text = the model's;
  2. **owner-only asks**: an `ask` tool → status WORKING "waiting…"; a second "phone" connection answers → COMPLETED; the adapter never sent `resolve_permission` (mutation: let the adapter answer → test fails);
  3. **ask not auto-denied** with only the adapter attached (mutation: drop `permission_request` from its declared updates → the ask is cancelled → test fails);
  4. `cancelTask` → `CANCELED`; the phone's `session/cancel` → `CANCELED`;
  5. turn in progress → second message errors, first unaffected;
  6. `hooks/trust` asked → `false`; no `askedOn` entry for the adapter;
  7. the adapter detaches after the terminal state (session `attached` 0 in `session/list`).
- `a2a-http.test.ts` (real `Bun.serve` on port 0 via `startWsServer`, loopback):
  401 without/with wrong token; 401 with an `Origin`; card public and well-formed;
  413; −32009; −32601; route absent (404/426 as today) without an A2A token;
  the WS route still works beside it.
- **e2e** `a2a-e2e.test.ts`: `startDaemon` (scripted provider via
  `createProvider`, temp store, `devices:false`, `--a2a-token`), the **SDK
  client** (`ClientFactory` + `JsonRpcTransportFactory` with an auth `fetch`):
  card → `sendMessage` (COMPLETED + artifact text) → `sendMessageStream`
  (event order) → `getTask` → `cancelTask` on a hanging turn → a plain WS
  client with the serve token sees `a2a-<ctx>` in `session/list`; caller
  aborts mid-stream, the turn still completes (`getTask`).

### Slices (executor: Opus; times are wall-clock estimates)

| # | Slice | Est. |
|---|---|---|
| S0 | dep + `bun build --compile` smoke (the SDK bundles into the binary) + `mapping.ts` + its tests | 40 min |
| S1 | `executor.ts` + executor tests (1–7) | 1 h 30 |
| S2 | `http.ts` + `ws-server.ts` hook + http tests | 1 h |
| S3 | CLI flags/wiring/help + e2e + changelog/README | 1 h |
| R | fresh-context Opus review (red-team §7 "remote not trusted" + single session path) + one fix round + `bun run check` | 1 h 15 |
| | **Total** | **≈ 5 h 30** (merge by ~18:00–19:00 if approved by 12:30) |

### Owner questions

1. **Who answers a permission ask raised by an A2A task?** **Recommendation: only you** (phone/TUI, push as today); the A2A caller sees `WORKING` + "waiting for the owner's approval" and never gets `INPUT_REQUIRED`. Alternative: the caller answers via `INPUT_REQUIRED` — rejected because it is an untrusted remote approving effects on your machine (AGENTS §7).
2. **Which token?** **Recommendation: a dedicated A2A token** (`serve --a2a-token-command …`; A2A off without it) that opens ONLY `/a2a`. Reusing the serve token would hand the caller the full WS route — it could then answer its own asks and drive every session. (+15 min, already in the estimate.)
3. **MVP cuts OK?** JSON-RPC binding only; text + JSON parts only (files → "unsupported"); task records in memory (after a `serve` restart `GetTask` says not found — the session itself survives on your phone); `SubscribeToTask` in (free), `ListTasks` and push notifications out. **Recommendation: yes.**
4. **New dependency `@a2a-js/sdk`** (official, + `jose`, pure JS, ~5 MB, no express) instead of ~500 hand-written lines. **Recommendation: yes.**

## Execution

## Review
