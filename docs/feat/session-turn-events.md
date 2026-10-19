# feat/session-turn-events — `turn_start`/`turn_end` in the stream, prompt acked at once, idempotent `prompt`/`enqueue`, new turn driver

> **Status:** done — reviewed (REQUEST-CHANGES, all findings fixed), real-TUI checked, merged to `main` (2026-10-20)
> **Branch:** `feat/session-turn-events`
> **Type:** feat · **Size:** M · **Blast:** load-bearing (the steering invariant, the TUI-over-RPC session path, protocol version) · **Suited:** strong model executes; mandatory fresh-context Review (AGENTS §7)

Child **3b** of `docs/eval/session-event-stream.md` (plan of 3a → 3b → 3c),
itself child 3 of `docs/eval/session-reattach.md`. The eval keeps the whole
plan. This doc is 3b's plan, corrected against `main` @ `da20289`. Where the two
differ, this doc wins (see "Drift from the eval's §3b").

## Context

*— claude-opus-5-5, 2026-10-20*

The parent's review finding F5: a turn's outcome must be observable from the
stream **before** any later child (`session-registry`) lets a turn outlive its
socket. Today the outcome travels only as the `session/prompt` response, so a
client that loses the socket loses the outcome. 3b moves the turn lifecycle into
the stream:
- `prompt` acks at once with a client-chosen `turnId`;
- `turn_start{turnId, prompt}` and `turn_end{turnId, stopReason, error?}` are
  mandatory events;
- `prompt` and `enqueue` become idempotent by key, so a retry after a lost ack
  never runs or injects twice.

Owner decision **B** (parent): `turn_start` carries the prompt text.

Two constraints come from the 3a Review (`docs/feat/session-wire-classes.md`,
Findings 2–3). Both are pre-existing, and 3b must close them because it adds
the first mandatory events:
- **F2:** a frame that fails the *envelope* schema is dropped at the peer and
  never fails the turn: a hang once that frame is a `turn_end`.
- **F3:** the worker and `connect` runtimes build `RemoteClient` without
  `onError`.

Today (`main` @ `da20289`):
- `HostedSession.prompt` drives the whole turn inside the request
  (`daemon/src/hosted-session.ts:100-126`), and `Connection.prompt` awaits it
  (`daemon/src/connection.ts:216-223`). The ack is the end of the turn.
- `turn_end` maps to `null` (`daemon/src/mapping.ts:145`). Its stop reason is
  the response (`client/src/remote-session.ts:89-95`).
- A failing turn reaches a remote client as the opaque `prompt` rejection
  "internal error" (`transport/src/peer.ts:333-345`). Nothing reaches the
  stream.
- `enqueue` has no key: a retry after its turn ended is `NoTurnRunning`
  (`connection.ts:165-167`), so a client cannot tell "applied, ack lost" from
  "never applied".
- The client learns that the socket died only through the pending `prompt`'s
  rejection (`peer.ts:234-243`). `RpcPeerOptions` has no close hook
  (`peer.ts:60-83`).

**Repro** (2026-10-20, `main` @ `da20289`, `.tentacle/tmp/session-turn-events/missing.ts`):

```ts
// What 3b adds, shown missing on main. In-memory channel pair, real Connection.
import { Agent } from "@tentacle/agent";
import { type ChatRequest, type ModelProvider, PermissionBroker, type StreamEvent } from "@tentacle/core";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { RemoteClient } from "@tentacle/client";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection, SessionHost } from "@tentacle/daemon";

let release: () => void = () => {};
const gate = new Promise<void>((r) => { release = r; });
let calls = 0;
const model = (mode: "gated" | "throw" | "plain"): ModelProvider => ({
  id: "m",
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    calls++;
    if (mode === "gated") await gate;
    if (mode === "throw") throw new Error("provider 401: key sk-SECRET rejected by https://endpoint");
    yield { type: "text", delta: "hi" };
    yield { type: "done" };
  },
});
const env = { id: "noop", exec() { throw new Error("x"); }, readFile() { throw new Error("x"); }, writeFile() { throw new Error("x"); } };
const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function harness(mode: "gated" | "throw" | "plain") {
  const host = new SessionHost({ defaultCwd: "/tmp/x", createAgent: () => {
    const permissions = new PermissionBroker();
    return { agent: new Agent({ model: model(mode), tools: new ToolRegistry(), env: env as never }), permissions };
  } });
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const types: string[] = [];
  const client = new RpcPeer(c, { onNotification: (_m, p) => types.push((p as { update: { type: string } }).update.type) });
  return { client, types };
}

// 1. ack timing
{
  const { client } = harness("gated");
  await client.request("initialize", INIT);
  const { sessionId } = (await client.request("session/new", {})) as { sessionId: string };
  let acked = false;
  const p = client.request("session/prompt", { sessionId, content: [{ type: "text", text: "go" }] }).then(() => { acked = true; });
  await tick(20);
  console.log("1. prompt acked while model is blocked:", acked);
  release(); await p;
}
// 2. turn events in the stream, 3. retry of an ended turn, 4. late enqueue retry
{
  calls = 0;
  const { client, types } = harness("plain");
  await client.request("initialize", INIT);
  const { sessionId } = (await client.request("session/new", {})) as { sessionId: string };
  await client.request("session/prompt", { sessionId, content: [{ type: "text", text: "go" }] });
  await tick();
  console.log("2. update types of one turn:", JSON.stringify(types));
  const withId = await client.request("session/prompt", { sessionId, turnId: "t1", content: [{ type: "text", text: "go" }] }).then(() => "ok", (e) => `rejected: ${e.message}`);
  console.log("3a. prompt with a client turnId:", withId);
  await client.request("session/prompt", { sessionId, content: [{ type: "text", text: "go" }] });
  console.log("3b. resending the same prompt after its end runs the model again: calls =", calls);
  const enq = await client.request("session/enqueue", { sessionId, text: "x" }).then(() => "ok", (e) => `rejected: ${e.message}`);
  console.log("4. enqueue retried after the turn ended:", enq);
}
// 5. model error: what the client sees, and whether the stream carries it
{
  const { client, types } = harness("throw");
  await client.request("initialize", INIT);
  const { sessionId } = (await client.request("session/new", {})) as { sessionId: string };
  const r = await client.request("session/prompt", { sessionId, content: [{ type: "text", text: "go" }] }).then(() => "ok", (e) => `rejected: ${e.message}`);
  console.log("5. failing turn → prompt", r, "| stream types:", JSON.stringify(types));
}
// 6. 3a Review F2: envelope-invalid frame mid-turn never fails the turn
{
  const [d, c] = createChannelPair();
  const errors: string[] = [];
  const rc = new RemoteClient(c, new PermissionBroker(), undefined, { onError: (e) => errors.push(e.message) });
  const daemon = new RpcPeer(d, { onRequest: async (method) => {
    if (method === "initialize") return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { tools: true, permissions: true } };
    if (method === "session/new") return { sessionId: "s" };
    if (method === "session/prompt") {
      daemon.notify("session/update", { sessionId: "s", mandatory: true, update: { type: "turn_end" } }); // no seq
      return new Promise(() => {}); // the daemon never answers (as with ack-at-once)
    }
    return {};
  } });
  await rc.initialize();
  const sess = rc.newSession();
  let outcome = "pending";
  (async () => { try { for await (const _ of sess.send("go")) {} outcome = "ended"; } catch (e) { outcome = `failed: ${(e as Error).message}`; } })();
  await tick(30);
  console.log("6. turn after an envelope-invalid mandatory frame:", outcome, "| onError:", JSON.stringify(errors));
}
process.exit(0);
```
```
1. prompt acked while model is blocked: false
2. update types of one turn: ["agent_message_chunk"]
3a. prompt with a client turnId: rejected: invalid params for session/prompt
3b. resending the same prompt after its end runs the model again: calls = 2
4. enqueue retried after the turn ended: rejected: no turn is running
5. failing turn → prompt rejected: internal error | stream types: []
6. turn after an envelope-invalid mandatory frame: pending | onError: ["invalid params for notification session/update"]
```

## Implementation

*— claude-opus-5-5, 2026-10-20 (approved by the owner 2026-10-20; OQ resolved: `enqueue` bound to its `turnId`)*

### Drift from the eval's §3b (verified)

1. **`compacting` is not a thing yet.** The eval's step 1 checks "`controller`
   (or compacting)". `HostedSession` has no compaction flag
   (`hosted-session.ts:134-137`), and the guard is its own task
   (`docs/fix/daemon-compact-turn-guard.md`, a precondition of 3c, D8). 3b
   checks only `controller`. Compaction racing a turn stays exactly as on
   `main`.
2. **No contract orders the ack against the turn's stream** (new failure
   mode). The handler returns, then `handleRequest` sends the result a few
   microtasks later (`peer.ts:322-326`), while the turn runs concurrently.
   - *Measured* on the in-memory pair with a synchronous `ScriptedProvider`:
     the ack still arrives first, because the agent loop has many more
     microtask hops. The planning claim that the whole turn "can" precede the
     ack was not observed.
   - Nothing guarantees that order, though (a different transport, or a
     future fan-out). The client therefore accepts either order.
   - Pinned with a fake daemon that streams the whole turn *before* returning
     the ack (Tests 6).
3. **F2: the peer gains `onInvalidNotification`.** It is a generic hook, so the
   transport learns nothing about sessions. The eval had no shape for it.
   `RemoteClient` routes an envelope-invalid `session/update` with a readable
   string `sessionId` to that session's `fail`.
4. **F3 sinks.**
   - Worker: `startWorkerRuntime` passes `onPeerError` →
     `logDaemonError(config.configDir, e)`. This is the same file sink the
     worker's daemon side already uses (`worker.ts:104-110`).
   - `connect`: runs before config loading (`main.ts:153-168`), so it has no
     config dir. It gets a buffered sink, written to the terminal only after
     `startTui` returns. This follows the `createStderrSink` pattern
     (`pod-runtime.ts:66`; AGENTS §7: never write raw while Ink owns the
     terminal).
5. **The client handles `PromptResult.ended`.** The eval only defined it for the
   daemon. In 3b the client never retries, but if an ack carries `ended` and no
   `turn_end` was seen, the turn ends from the ack. This costs two lines and
   keeps the shape honest for `client-reattach`.
6. **A `turn_end` error is rebuilt as an `RpcError(code, message)`.** Today the
   TUI renders the `prompt` rejection, an `RpcError`, with `String(error)`
   (`tui/src/App.tsx:363`). Rebuilding the same class keeps the rendered text
   identical (parity, eval step 9).
7. **`enqueue` is bound to its turn** (eval open question 8, owner decision
   2026-10-20). Without it there is a gap: suppose an `enqueue` whose first
   attempt was rejected `NoTurnRunning`. Rejected attempts are not recorded. If
   its error response is lost and the client retries after a *new* turn has
   started, the steer lands in that turn.
   - The fix: `EnqueueParams.turnId` (required), and `NoTurnRunning` unless
     `turnId === activeTurnId`.
   - No latency cost: the client already holds the `turnId`, so no round-trip
     is added.

### Load-bearing assumption

**Moving the turn off the request keeps the steering invariant: from the
agent's last steering drain to `running === false` there is no macrotask
boundary.**

If this breaks, a `session/enqueue` arriving in that window is accepted and
then silently dropped by the next `send`'s reset
(`agent/src/session.ts:62-64`).

Proof on `main`, and why the new shape keeps it:
- Today, `prompt` consumes the generator with `for await`. On the agent's
  `turn_end` event it `return`s, which runs `finally { controller = null }`
  (`hosted-session.ts:118-125`). Between the drain (`agent.ts:279`) and that
  `finally` there are only the generator's own microtask hops: the `yield`,
  plus the `return()` the `for await` issues on early exit. There is no
  `await` on I/O.
- The new driver calls a **synchronous** `finishTurn` *inside the loop body* on
  the `turn_end` event, **before** `return`. So `controller = null` happens one
  `return()` earlier than today: strictly fewer hops.
- The sink is a synchronous call (`peer.notify` → `channel.send`,
  `peer.ts:213-222`).
- Pinned by the existing test "no macrotask fits between the last steering
  drain and the turn's end" (`daemon/test/integration.test.ts:467-515`, both
  `end_turn` and `max_iterations`). 3b rewrites it for the new driver and
  checks it by mutation (Tests 5). A pure-microtask `await` slipped into the
  driver is **not** caught by any test. That is why the Review must read the
  driver.

Second assumption, same weight:

**An `enqueue` sent right after the ack is not lost to the turn-start steering
reset.**
- `drive()` is called synchronously from `prompt` and reaches the
  `for await` first `next()` synchronously.
- An async generator's `next()` runs its body synchronously up to the first
  `await`/`yield`. So `Session.send`'s `this.steering = []`
  (`session.ts:62-64`) runs **before** `prompt` returns.
- Any `enqueue` is a later macrotask (production transports). This is verified
  by a test (Tests 4b), not by this argument alone.

### Preconditions

- Inbound requests dispatch concurrently: `void this.handleRequest`
  (`peer.ts:291`; AGENTS §7). `enqueue` therefore runs while a turn is in
  flight, and with ack-at-once no request stays open for the turn at all.
- `emit` numbers every update per session and calls the sink synchronously
  (`hosted-session.ts:90-97`). `toUpdateParams` sets `mandatory: true` from
  `UPDATE_CLASS` (`daemon/src/mapping.ts:47-56`). The client applies the class
  rule in `classifyUpdate` (`client/src/mapping.ts:35-51`). Adding
  `turn_start`/`turn_end` as `mandatory` in `UPDATE_CLASS` is the whole
  daemon-side class work, and the `Record` type forces it
  (`protocol/src/updates.ts:109`).
- Every agent exit path yields `turn_end`, except a thrown model/tool error:
  - `end_turn` (`agent.ts:300`);
  - `cancelled` (`agent.ts:197,241,252` and the tool loop);
  - `max_iterations` (after the last pushes).
  The thrown error leaves the generator, and today's `prompt` rejects with it.
- The non-text check runs before the busy check and records nothing
  (`hosted-session.ts:101-105`, 3a).
- `Connection.close` cancels each session's turn and disposes its jobs
  (`connection.ts:82-90`). The peer is then closed, so `notify` is a no-op
  (`peer.ts:213-216`).
- `RemoteClient` already has a per-session handler with `fail`
  (`remote-client.ts:42-46,97-119`). `RemoteSession.fail` cancels the turn
  daemon-side (`remote-session.ts:79-85`).
- `AsyncQueue.push/close/fail` are no-ops once closed (`client/src/queue.ts`).
  A double end (ack + `turn_end`, or `onClose` + `prompt` rejection) is
  therefore harmless by construction.
- Error exposure today:
  - the worker exposes the real message (`worker.ts:104-110`,
    `exposeInternalErrors`);
  - ws-server and stdio do not (`ws-server.ts:182`, `serve.ts:96-100`);
  - every non-`RpcError` handler throw reaches `onError` (`peer.ts:333-336`).
- `PROTOCOL_VERSION` is 2 (`protocol/src/version.ts:7`). The schema export and
  its drift gate are merged (`bun run schema:export`,
  `packages/protocol/schema/protocol.json`).

### Design

**Protocol (`protocol/src/updates.ts`, `protocol/src/session.ts`, `version.ts`).**
```ts
TurnEndSchema   = { stopReason: StopReason, error?: { code?: int, message: string } }   // strict
TurnStartSchema = { type: "turn_start", turnId: TurnId, prompt: string }
TurnEndUpdate   = { type: "turn_end", turnId: TurnId, stopReason, error? }
UPDATE_CLASS.turn_start = UPDATE_CLASS.turn_end = "mandatory"
TurnIdSchema    = z.string().min(1).max(128)
PromptParams    = { sessionId, turnId: TurnId, content: ContentBlock[] (min 1) }
PromptResult    = { turnId: TurnId, ended?: TurnEnd }
EnqueueParams   = { sessionId, id: z.string().min(1).max(128), turnId: TurnId, text }
EnqueueResult   = {}
PROTOCOL_VERSION = 3
```
The header comment of `session.ts` changes "resolves when the turn ends" to
"acks at once; the turn's end is `turn_end` in the stream". The schema is
regenerated.

**Transport (`transport/src/peer.ts`).**
- `RpcPeerOptions.onClose?: () => void`: called exactly once, from
  `handleClose`, after pending requests are rejected. This covers both a remote
  close and a local `close()`.
- `RpcPeerOptions.onInvalidNotification?: (method: string, params: unknown) => void`:
  called (in addition to `reportError`) when a *known* notification fails its
  params schema. Generic: the peer does not interpret `params`.

**Daemon (`daemon/src/hosted-session.ts`).** New state:
`activeTurnId: string | null`, `turns: Map<string, { end?: TurnEnd }>` and
`enqueued: Set<string>`. They live as long as the session, with no eviction
(parent F8). Ids are capped at 128 chars by the schema.
```
prompt(turnId, content): PromptResult          // synchronous, no await before the ack
  rec = turns.get(turnId); if rec → return { turnId, ...(rec.end ? { ended: rec.end } : {}) }   // key first
  assertTextOnly(content)
  if controller → throw TurnInProgress
  controller = new AbortController(); activeTurnId = turnId; turns.set(turnId, {})
  text = contentToText(content)
  emit(turn_start{ turnId, prompt: text })
  void drive(turnId, text, controller)
  return { turnId }

drive(turnId, text, controller): Promise<void>  // never rejects
  try:
    for await (event of session.send(text, controller.signal)):
      if tool_start → currentToolCallId = event.id
      if turn_end   → finishTurn(turnId, { stopReason: stopReasonToProtocol(event.reason) }); return
      update = eventToUpdate(event); if update → emit(update)
    finishTurn(turnId, { stopReason: "end_turn" })          // generator ended without turn_end (today's fallback)
  catch (e):
    onTurnError(e)                                          // full error, always
    finishTurn(turnId, { stopReason: "error", error: redact(e) })

finishTurn(turnId, end): void                   // synchronous, idempotent per turn
  rec = turns.get(turnId); if !rec || rec.end → return
  rec.end = end; controller = null; activeTurnId = null     // state first: a throwing sink cannot leave a turn "running"
  emit(turn_end{ turnId, ...end })

enqueue(id, turnId, text):
  if enqueued.has(id) → return                              // key BEFORE the running check
  if !controller || activeTurnId !== turnId → throw NoTurnRunning
  enqueued.add(id); session.enqueue(text)
```
- `redact(e)`:
  - `RpcError` → `{ code, message }`;
  - otherwise, with `exposeTurnErrors`, `{ message: e.message || "internal error" }`;
  - otherwise `{ message: "internal error" }`.
  This matches the peer's existing policy (`peer.ts:330-345`).
- `HostedSession` takes `{ exposeTurnErrors, onTurnError }` from `SessionHost`
  (constructor option bag, default `false` / no-op). A no-op default is
  acceptable only because every production host sets it. Tests 2 pin the
  worker/ws wiring.
- `daemon/src/mapping.ts`: `eventToUpdate("turn_end")` stays `null`. The driver
  owns it, and the doc comment is updated.
- `replayFrom` and `turnBuffer` are unchanged (3c replaces them). Today's reset
  moves from `prompt`'s start to just before `emit(turn_start)`, so the replay
  buffer of a turn begins with its `turn_start`.

**Daemon (`session-host.ts`, `connection.ts`).**
- `SessionHostOptions` gains:
  - `exposeTurnErrors?: boolean`;
  - `onTurnError?: (e: Error) => void`.
- `Connection.prompt` returns `hosted.prompt(turnId, content)` directly (no
  `async`).
- `Connection.enqueue`: the `running` check moves into `HostedSession.enqueue`
  (after the key). The comment explaining the `NoTurnRunning` reason moves with
  it.

**Agent (`agent/src/agent.ts:270-278`).** Comment only: "the daemon's
`HostedSession.prompt` clearing its controller" becomes
"`HostedSession.finishTurn`".

**Client.**
- `client/src/mapping.ts`: `updateToEvent` maps `turn_start`/`turn_end` to
  `null`. `RemoteSession` handles them before mapping, so the TUI's
  `AgentEvent` stream is unchanged.
- `RemoteClient`:
  - `prompt(sessionId, turnId, text): Promise<PromptResult>`;
  - `enqueue(sessionId, id, turnId, text)`;
  - peer `onClose` → for each handler, `fail(new RpcError(InternalError, "connection closed"))`.
    This is exactly today's observable (`peer.ts:239-241`);
  - peer `onInvalidNotification`: `session/update` with
    `typeof params.sessionId === "string"` → that handler's `fail(new Error("malformed session/update frame from the daemon"))`.
    `onError` already got it via `reportError`.
- `RemoteSession.send`:
  - `turnId = crypto.randomUUID()`, kept in `this.turnId` (the latest turn's,
    **not cleared at its end**: Review F1); install the handler; then send
    `prompt`;
  - the handler's `update`:
    - `turn_start` → ignore;
    - `turn_end` with **this** `turnId` → `end(update)`;
    - `turn_start`/`turn_end` of another `turnId` → ignore;
    - else `updateToEvent`;
  - `end(e)`:
    - `stopReason === "error"` → `queue.fail(new RpcError(e.error?.code ?? InternalError, e.error?.message ?? "turn failed"))`;
    - else push `{type:"turn_end", reason: stopReasonFromProtocol(...)}` and `close()`;
  - ack:
    - with `ended` → `end(ended)`;
    - without → nothing (the stream ends the turn);
    - rejected → `queue.fail(error)`.
- `RemoteSession.enqueue`: sends a fresh `id = crypto.randomUUID()` and the
  latest turn's `turnId`.
  - Before any send: a no-op (resolved), as today.
  - After the turn ended: sent anyway, so the daemon rejects it
    `NoTurnRunning` (Review F1).
  - While the first send is still opening the session: waits for the id, as
    today. `send` assigns its `turnId` synchronously, before awaiting
    `opening`, so it is already known.

**CLI.**
- `worker.ts`: `SessionHost{ exposeTurnErrors: true, onTurnError: (e) => logDaemonError(config.configDir, e) }`.
- `serve.ts`:
  - `startDaemon` → `onTurnError: options.onError`;
  - `startStdioDaemon` → `onTurnError: (e) => log?.(\`error: ${e.message}\`)`;
  - both keep `exposeTurnErrors` off.
- `local-runtime.ts` `startWorkerRuntime` → `onPeerError: (e) => logDaemonError(config.configDir, e)`.
- `connect.ts`: `errors: Error[]` sink → `RemoteClient{ onError }`; after
  `startTui` (in `finally`), write each as `[connect] error: …`.

**TUI.** No change (eval step 9): the same `AgentEvent`s and the same thrown
error class.

### Files

Dependency order:
- `protocol/src/updates.ts`, `protocol/src/session.ts`, `protocol/src/version.ts`,
  `protocol/schema/protocol.json` (regenerated);
- `transport/src/peer.ts`;
- `agent/src/agent.ts` (comment);
- `daemon/src/hosted-session.ts`, `daemon/src/session-host.ts`,
  `daemon/src/connection.ts`, `daemon/src/mapping.ts` (comment);
- `client/src/mapping.ts`, `client/src/remote-client.ts`,
  `client/src/remote-session.ts`;
- `cli/src/worker.ts`, `cli/src/serve.ts`, `cli/src/local-runtime.ts`,
  `cli/src/connect.ts`.

Tests: `transport/test/peer.test.ts`, `daemon/test/integration.test.ts` (every
`session/prompt` user moves to "await `turn_end`", incl. the rewritten
steering-window test), `daemon/test/mapping.test.ts`,
`client/test/remote.test.ts` (the `fakeDaemon` helper acks + streams
`turn_end`), `client/test/mapping.test.ts`, `protocol/test/*` (schema snapshot
/ classes).

Docs: this doc, the eval's 3b header line, `TODO.md`.

### Failure modes

Each with how the state converges:

- **Ack lost, `prompt` retried** (turn running or ended) → the key wins: the
  cached ack, never a second run. If the turn ended, `ended` carries the
  outcome.
- **Same `turnId`, different content** → the key wins. This is documented as a
  client bug, not a daemon decision.
- **`prompt` while another turn runs** → `TurnInProgress`, after the key check.
  Nothing is recorded, so a later retry with that id starts a turn.
- **Non-text content** → `InvalidParams`, nothing recorded (3a).
- **Ack after `turn_end`** (Drift 2) → the client already ended the turn
  (`AsyncQueue` is closed). A later `ended` or ack is a no-op.
- **`enqueue` retried after its turn ended** → the cached `{}` (key before the
  running check). Never `NoTurnRunning`, never applied twice.
- **`enqueue` first rejected, retried during a later turn** → `NoTurnRunning`
  (its `turnId` is not the active one); never lands in the wrong turn.
- **Model/provider/tool throws** → `turn_end{stopReason:"error", error}` in the
  stream.
  - The full error always goes to `onTurnError`. On worker it is
    `daemon-errors.log`, exactly as today's handler throw (never silent).
  - Remote ws/stdio get "internal error" (parity: a provider message can
    carry endpoint or key material).
  - The worker gets the real message.
- **Socket dies after the ack** → peer `onClose` → every open `RemoteSession`
  fails with "connection closed" (no hang).
  - Daemon side, unchanged: `Connection.close` cancels the turn. It ends
    `cancelled` into a closed peer (`notify` no-op).
  - Detach semantics are `session-registry`'s.
- **Socket dies before the ack** → the `prompt` rejection and `onClose` both
  fail the queue. The second is a no-op.
- **Envelope-invalid `session/update`** (F2) → `onError` + that session's turn
  fails and is cancelled daemon-side. No hang.
  - If `sessionId` is unreadable, nothing can be routed: `onError` only. The
    turn then hangs until close. This is accepted and documented: the daemon
    always sets `sessionId`, and `classifyUpdate` covers everything inside a
    valid envelope.
- **Unknown mandatory event** (newer daemon at the same version) → loud error
  (3a rule).
- **`turn_end` of another turn** → ignored. Only the turn's own `turnId`
  closes it.
- **Sink throws inside `finishTurn`** → state was set first, so `running` is
  already false and the turn is recorded ended. The throw propagates out of
  `drive`'s loop into its `catch`.
  - The catch then calls `onTurnError`, and `finishTurn` is a no-op
    (idempotent), so there is no second `turn_end`.
  - `drive` never rejects: an unhandled rejection is impossible.
- **Connection closed mid-turn, turn keeps running briefly** → `emit` into a
  closed peer is a no-op. `cancel` was called, so the agent ends at its next
  check.
- **Memory**: one map entry per prompt/enqueue for the session's life (≤ 128
  chars). Accepted (parent F8: same principal already has a shell); cleared
  with the session.
- **Version skew** → `PROTOCOL_VERSION` 3; a mixed pair fails at `initialize`
  with `VersionMismatch` (`connection.ts:184-189`).

### Tests

Red before green on `main` for each, unless marked "regression (green on both)".
Seams: `ScriptedProvider`, `EchoSteerProvider`, `harness()`,
`createChannelPair`, `fakeDaemon` (`client/test/remote.test.ts:642`), plus a
new `GatedProvider` (yields after an external `release()`), in the
integration file's style.

1. **Ack before the model runs.** With a gated model:
   - `session/prompt` resolves `{turnId}` while the model is blocked;
   - `turn_start{turnId, prompt:"go"}` was already streamed.

   Red today: the ack waits for the turn (repro 1).
2. **Turn bracket, every exit.** For `end_turn`, `cancelled` (cancel
   mid-model), `max_iterations` and a throwing model:
   - `turn_start` is the first update and `turn_end` the last, each exactly
     once, both `mandatory: true`, with seqs contiguous;
   - the throw → `stopReason:"error"`. The `error.message` is "internal error"
     by default and the real message with `exposeTurnErrors`;
   - the `onTurnError` spy is called once with the real `Error`.

   Mutation: drop `onTurnError` → red; expose by default → red.
3. **Idempotent `prompt`.**
   - Same `turnId` twice while running → same ack, `model.calls` unchanged.
   - After the end → `ended` deep-equals the streamed `turn_end` (minus
     `type`/`turnId`).
   - After 50 more turns → still cached. Mutation: cap the map at 16 → red.
   - A rejected `TurnInProgress` attempt is not recorded: the same id later
     starts a turn.
4. **Idempotent `enqueue`, the Review's exact sequence.**
   - Call `hosted.enqueue(id, turnId, "s")` directly and discard the result
     (the ack is "lost"); the turn ends; the same `enqueue{id}` over the wire
     → `{}`, not `NoTurnRunning`;
   - the model saw `"s"` exactly once (`EchoSteerProvider.calls`).
   - Mutation: check running before the key → red.
   - An `enqueue` with a stale `turnId` during a later turn →
     `NoTurnRunning`, and the model never sees it. Mutation: drop the
     `turnId` comparison → red.
   - **4b:** an `enqueue` sent on the ack's microtask (gated model) is seen by
     the model. This pins the second assumption.
5. **Steering window, rewritten** (both labels):
   - the timer armed inside the last drain observes `running === false`;
   - **and** `turn_end` was already emitted (sink spy).

   Mutation: put `await new Promise(r => setTimeout(r, 0))` before
   `finishTurn` → red (both labels).
6. **Ack after `turn_end`** (Drift 2), client level: a fake daemon streams
   `turn_start`, a chunk and `turn_end`, then acks with `ended`. `send` ends
   exactly once, with no error and no hang. Mutation: end the turn only on the
   ack → red.
7. **Client turn end from the stream** (`fakeDaemon` that acks at once):
   - ends on its own `turn_end`;
   - ignores a `turn_end` with another `turnId`, then ends on its own;
   - `stopReason:"error"` → throws an `RpcError` with the streamed code and
     message;
   - ack with `ended` and no stream → ends from `ended`.

   Red today: the client ends only on the ack.
8. **Close after the ack** → `send` throws "connection closed" within the
   timeout. Red on a 3b client without `onClose` (it hangs); the current main
   passes only because the ack is the turn. The red step is shown by mutation:
   remove the `onClose` wiring.
9. **F2**:
   - `turn_end` frame without `seq` mid-turn → `send` fails, `onError` got it,
     the daemon got `session/cancel`. Red today (repro 6: hangs);
   - an unreadable `sessionId` → `onError` only, no throw.
10. **Peer `onClose`**:
    - fires exactly once on remote close and on local `close()` (the two
      paths can both run);
    - `onInvalidNotification` fires for an invalid known notification and not
      for an unknown method.
11. **F3**: a unit check on `connect`'s buffered sink (its order, and that it
    flushes after the TUI callback). The worker wiring is a two-line change,
    covered by Review reading.
12. **Protocol**: the schema drift gate is regenerated, and
    `x-event-class: mandatory` is present on `TurnStart`/`TurnEnd`.
    `classifyUpdate` keeps both as known.

Gate: `bun run check` green (typecheck → lint → test), schema drift test
regenerated.

## Execution

*— claude-opus-5-5, 2026-10-20*

Built in the plan's order: protocol → transport → daemon → client → cli →
tests. The `main`@`da20289` repro was run first (Context).

**Drift from Implementation (all small, each for a reason):**
1. **`TurnErrorSchema` is a named schema**, and `TurnEndUpdateSchema` spells
   out its fields instead of `TurnEndSchema.extend`. The exporter refuses a
   shared `.optional()` instance: it exports as an anonymous cross-`$def` ref
   (`non-name $ref … TurnEndUpdate/properties/error -> TurnEnd/properties/error`).
2. **`TurnEndSchema` and the nested `error` are not `.strict()`.** Both also
   ride `turn_end`, whose members stay open by the `updates.ts` rule. A
   stricter nested object would make "a newer daemon adds a field" a loud
   failure (3a Review finding 5).
3. **`drive` and `prompt` are hardened against a throwing sink beyond the
   plan.** Found while writing Tests:
   - the planned code skipped `onTurnError` when the throw came from the
     `turn_end` emit itself: a silent drop;
   - a throw from `finishTurn` inside `catch` rejected `drive`: an unhandled
     rejection;
   - a throw from the `turn_start` emit in `prompt` left the controller set
     forever.

   Now every sink throw goes to `onTurnError`; `finishTurn` in `catch` is
   guarded; `turn_start` emit failure is reported and the turn still runs.
   Pinned by "a throwing sink never strands the session…" (mutation M8).
4. **Peer `onClose` is guarded**: a throwing hook goes to `onError`, never out
   of `close()`. One test.
5. **Drift 2 (ack vs. stream order) was corrected by measurement.** On the
   in-memory pair with a synchronous model, the ack *still* arrives first. The
   planning claim that the turn "can" precede the ack was not observed, so the
   real-daemon ordering test was replaced by a fake daemon that streams the
   whole turn before acking (Implementation Drift 2 and Tests 6 updated).
6. **`connect`: `client.initialize()` moved inside the `try`.** The client is
   now closed (and buffered errors flushed) when the handshake fails too.
   `connectTui` takes `write` from `main`.
7. **`enqueue{turnId}`:** the owner first answered "id only", then reversed to
   binding (2026-10-20). Built bound. The doc was updated both times; the final
   text is the bound design.

**Gate** (`bun run check`, branch tip before Review): typecheck clean, `biome
check` clean (267 files, 0 diagnostics), `bun test` **849 pass, 1 skip** (the
opt-in live-k8s), 0 fail.

**Red before green.**
- *Peer:* the 3 new tests were run red before the implementation: 23 pass,
  3 fail.
- *Protocol / daemon / client:* every existing test on the old shape failed
  once the code changed (15 fails), and was rewritten to the new contract.
- *New behaviour:* shown non-vacuous by mutation. Driver:
  `.tentacle/tmp/session-turn-events/mutate.py`, which applies one mutation,
  runs the named test, and restores the file.

| # | Mutation | Test that goes red |
|---|---|---|
| M1 | macrotask `await` before `finishTurn` | steering window (both labels) |
| M2 | running check before the enqueue key | enqueue: ack lost, retried → `{}` |
| M3 | drop the `turnId` comparison in `enqueue` | enqueue bound to a finished turn |
| M4 | cap the turn map at 16 | retried `turnId` never runs twice (50 turns) |
| M5 | start `drive` a macrotask later | enqueue right after the ack |
| M6 | drop `onTurnError` | bracket: throwing model |
| M7 | expose turn errors by default | bracket: throwing model (`sk-SECRET` leaks) |
| M8 | emit `turn_end` before clearing state | throwing sink |
| M9 | client without `onClose` | close after ack (hangs) |
| M10 | client without `onInvalidNotification` | envelope-invalid `turn_end` (hangs) |
| M11 | client ignores `turnId` on `turn_end` | ends on ITS `turn_end` |
| M12 | client ends only on the ack | `turn_end` before a plain ack (hangs) |
| M13 | client ignores `ack.ended` | ack carrying `ended` |

All 13 are red. M12 was first **green**, because the test's ack carried
`ended`, which ended the turn anyway. The test now runs with a plain ack and
with an `ended` ack, and is red on the plain one.

**After** (same repro adapted to `turnId`/`id`,
`.tentacle/tmp/session-turn-events/after.ts`):
```
1. prompt acked while model is blocked: true
2. update types of one turn: ["turn_start","agent_message_chunk","turn_end"]
3a. prompt with a client turnId: ok
3b. resending the same prompt after its end runs the model again: calls = 2
4. enqueue retried after the turn ended: rejected: turn t1 is not running
5. failing turn → prompt ok | stream types: ["turn_start","turn_end:{\"message\":\"internal error\"}"]
6. turn after an envelope-invalid mandatory frame: failed: malformed session/update frame from the daemon | onError: ["invalid params for notification session/update"]
```
How to read it:
- **3b:** two turns ran (t0 and t1); resending t1 ran nothing, since the
  count stayed 2.
- **4:** that `enqueue` was never accepted (no turn was running), so
  `NoTurnRunning` is right. The "accepted, ack lost, retried" case is the
  integration test.

**Not done / not verified:**
- The F3 worker wiring (`onPeerError` → `logDaemonError`, 2 lines) has no
  test; it is checked by reading only.
- No run of the real TUI. The `AgentEvent` stream and the thrown error class
  are unchanged and pinned at the `RemoteSession` boundary.

## Review

*— claude-opus-5-5, 2026-10-20*

**Verdict: REQUEST-CHANGES (small).** The load-bearing parts hold. The
steering invariant holds by reading and by mutation. The ack-at-once driver,
the idempotency key order, the redaction parity and the protocol bump are
correct. The gate is green. Two code defects need a fix before merge, each a
few lines:
- F1: a silent drop of a typed steer, a regression against `main`;
- F2: a throwing `onTurnError` strands the session, which contradicts the doc's
  "`drive` never rejects".

There are also two §9 test gaps where a mutation survives (F3). Everything else
is a nit.

**Reviewer / executor:** reviewed by `claude-opus-5-5` in a fresh context. The
executor was **also `claude-opus-5-5`**: same model, so shared blind spots are
likely. This task is `load-bearing`, so a different-model pass would be the
stronger check (AGENTS §10).

### Findings

1. **Silent drop of a steer typed after a failed turn** (medium: a §8 silent
   drop and a regression against `main`).
   - **Where:** `client/src/remote-session.ts:54-55`. `enqueue` resolves as a
     no-op whenever `this.turnId === null`, including *after* the first send.
     On `main`, once `this.id` was set, the steer went to the daemon, which
     rejected it `NoTurnRunning`. The TUI then reconciled its optimistic ⏳ row
     with a "message not queued" notice. That was the point of
     `fix/steering-over-rpc` (TODO.md:170-181).
   - **Window:** on an *error* end (`turn_end{error}`, `fail`), `RemoteSession`
     throws and its `finally` clears `turnId`. `persistingController.send`
     then awaits `flush()`, a `session/snapshot` round trip
     (`cli/src/local-runtime.ts:72-84`), before the throw reaches the TUI. For
     that whole round trip `stateRef.current.running` is still true, so a
     typed line goes to `enqueue`, resolves, and is wiped by the TUI's
     `setQueued([])`. No notice is shown and the daemon never sees it.
   - **Repro**
     (`.tentacle/tmp/session-turn-events-review/window.ts`: fake daemon, a
     `turn_end{error}`, a 100 ms snapshot):
     `TUI still running when steer typed: true | enqueue: resolved | daemon saw enqueue: false`.
   - A clean end (`end_turn`, `cancelled`) is not affected. The `turn_end`
     event reaches `applyEvent` (running → false) before `turnId` is cleared.
   - **Fix:** keep the no-op only for "no send ever started" (`!this.id &&
     !this.opening`). With an id and no open turn, reject with an `Error`
     ("no turn is running"), so the TUI shows its notice as on `main`. The
     Implementation's "a no-op (resolved), as today before any send" is
     inaccurate for this case. Add a client test.
2. **A throwing `onTurnError` strands the session as "running" and rejects
   unhandled** (low; the hook contract does not hold, and the doc claims the
   opposite).
   - **Where:** `daemon/src/hosted-session.ts:205` / `:218-220`. In `drive`'s
     `catch`, `reportTurnError(error)` runs *before* `finishTurn`, and it is
     unguarded.
   - **Effect:** if the hook throws, `finishTurn` never runs and `drive`
     rejects. The controller stays set forever: every later `prompt` is
     `TurnInProgress`, no `turn_end` is sent, and the client hangs until
     close.
   - **Repro** (`.tentacle/tmp/session-turn-events-review/hook.ts`):
     `UNHANDLED REJECTION: log sink down` /
     `running after failed turn with a throwing onTurnError: true | stream: ["turn_start"]`.
   - **Production exposure:**
     - the worker's `logDaemonError` never throws (`cli/src/daemon-log.ts`);
     - stdio's `log` writes stderr;
     - ws passes the embedder's `options.onError` as is.
   - The same applies to the `reportTurnError` calls at `:166` (the
     `turn_start` emit failure) and inside the inner `catch`.
   - **Fix:** wrap the hook call in `try/catch` inside `reportTurnError`, or
     call `finishTurn` before reporting. Pin it with a test that uses a
     throwing hook.
3. **Two new behaviours pass with their code removed** (§9, test gaps;
   reviewer mutations R5 and R13, both survived the *whole* suite or file):
   - **R5:** the client's per-enqueue key made constant
     (`const key = "k"`, `remote-session.ts:57`). 850/850 still pass. In
     production, the second steer of a turn would be taken as a retry and
     silently dropped by the daemon. No test sends two steers in one turn.
     The code itself is correct: reviewer trace 1 shows both `a` and `b` reach
     the model.
   - **R13:** `prompt` ack rejection swallowed (`remote-session.ts:147`,
     `(error) => queue.fail(error)` → `() => {}`). `client/test/remote.test.ts`
     stays at 31/31. Now that the turn ends only from the stream, a rejected
     prompt with the socket still open (`TurnInProgress`, `InvalidParams`,
     `UnknownSession`) is a **hang** without this line. On `main` it was
     covered by construction. Reviewer trace 2 shows the code is right today:
     `threw: a turn is already running`.
4. **Tests 11 is half-built** (nit). `packages/cli/test/connect.test.ts` pins
   only the sink's order and once-only flush. Nothing pins "flushes after the
   TUI": mutation R8 (`sink.flush(write)` moved before `startTui`) passes all
   of `packages/cli/test`. The plan listed both checks. Either test
   `connectTui` with an injected `startTui`, or state in Execution that this
   is checked by reading only. As built (`connect.ts:56-58`, `finally` after
   `startTui`) it is correct.
5. **`onInvalidNotification` is unguarded** (nit). At `transport/src/peer.ts:382`,
   `onClose` (Drift 4) and `onNotification` are wrapped in `try/catch`, but
   this hook is not. Inside the `async handleNotification`, a throwing hook
   becomes an unhandled rejection. `RemoteClient`'s hook does not throw today,
   but the guard should be uniform.
6. **The `NoTurnRunning` message now carries a UUID** (nit, UX). The message
   is `turn ${turnId} is not running` (`hosted-session.ts:255`), and the TUI
   shows it verbatim as `_message not queued: turn 3f2a…-… is not running_`.
   That is noise to the user; "no turn is running" was the message on `main`.
7. **Gate count drift** (doc nit). Execution says 849 pass. The reviewer's run
   is **850 pass, 1 skip, 0 fail**: probably a test added after the count was
   taken. Update it.

### Gate (reviewer's run)

`bun run check` → exit 0:
- `tsc --noEmit` clean;
- `biome check .`: "Checked 267 files … No fixes applied" (0 diagnostics,
  matches the §6 baseline);
- `bun test`: **850 pass, 1 skip (the opt-in live-k8s), 0 fail**, 2713
  `expect()` calls, 851 tests across 96 files.

### Premises checked

| Premise | Result |
|---|---|
| Steering invariant: no `await` (incl. microtask-only) between the agent's last drain and `controller = null` | **TRUE.** `agent.ts:279` drains, and `:300` yields `turn_end` with no await in between. That event goes up through `Session.send`'s `yield*` (`session.ts:70`). In `drive`'s `for await`, the `turn_end` branch is the *first* statement of the loop body (`hosted-session.ts:187-190`): `finishTurn` is synchronous and clears the controller before the `return`. Only the generator's own resumption microtasks lie in between. The empty-round `continue` path drains again at the loop top. |
| `drive()` runs `Session.send`'s `this.steering = []` before `prompt` returns | **TRUE.** `drive` is called synchronously (`:168`). The `for await` first `next()` starts the async generator body synchronously, and the reset (`session.ts:62-64`) runs before the first `await`/`yield`. Empirically: M5 (drive deferred one macrotask) makes Test 4b red. Note: `createChannelPair` delivers by `queueMicrotask` (`transport/src/channel.ts:40`), so 4b runs under a *stricter* regime than production's macrotask transports. |
| Key check before the busy check (`prompt`); key before the running/turn check (`enqueue`); nothing recorded on rejection | **TRUE** (`:144-169`, `:246-259`). Pinned: R1, R2, R10 are red, as are the executor's M2 and M3. |
| `finishTurn` sets state before the emit, is idempotent, and is guarded by `activeTurnId` | **TRUE** (`:227-240`). M8 and R14 are red. |
| Redaction parity: worker exposes, ws/stdio redact, the real error goes to `onTurnError` | **TRUE.** `worker.ts` sets `exposeTurnErrors: true` plus `logDaemonError`. `serve.ts:33-34` (ws) and `:71-74` (stdio) set no expose. An `RpcError` keeps its code (R9 red) and matches the peer policy. `ProxyModelProvider` errors arrive as `RpcError`s already redacted by the laptop's peer, as on `main`. |
| No raw terminal write while Ink owns it | **TRUE.** `connect` buffers and flushes in the `finally` after `startTui`. The worker's peer errors go to the file log (`local-runtime.ts:228-233`). stdio goes to the piped stderr log. |
| `PROTOCOL_VERSION` 3; schema regenerated; `turn_start`/`turn_end` mandatory; members non-strict | **TRUE.** `version.ts:7`. `protocol.json` has `TurnEndUpdate`/`TurnStart` with `x-event-class: mandatory` (`:922`, `:958`), and the drift test passes. Neither member is `.strict()`. `client/src/mapping.ts` maps both to `null`, and `RemoteSession` consumes them first. |
| Both ends wired | **TRUE.** The only `Method.Prompt`/`Method.Enqueue` callers are `RemoteClient` (`:200`, `:215`), and the daemon serves both (`connection.ts:131-137`). |
| Context repro (`main`) | Not re-run on `main`: the branch is uncommitted and the brief forbids switching or stashing. The "after" behaviour was re-traced on the branch (below). |

### Mutation results

- **Executor's rows re-run:** M1, M5, M8 and M12 are all **RED**, as claimed
  (`.tentacle/tmp/session-turn-events/mutate.py M1 M5 M8 M12`).
- **Reviewer's own:** `.tentacle/tmp/session-turn-events-review/mutate.py`.
  Each mutation is applied alone and restored. The tree hash was identical
  before and after (`b795a6e…`).

| # | Mutation | Result |
|---|---|---|
| R1 | busy check before the `prompt` key | RED (retried turnId) |
| R2 | rejected `prompt` recorded | RED (TurnInProgress not recorded) |
| R3 | `finishTurn` in `catch` unguarded | RED (throwing sink) |
| R4 | `turn_start` emit unguarded | RED (throwing sink) |
| R5 | client enqueue key constant | **GREEN, survived the full suite** (F3) |
| R6 | client `fail` without the daemon cancel | RED (3 class tests) |
| R7 | `turn_end{error}` treated as a clean end | RED (2 tests) |
| R8 | `connect` flush before the TUI | **GREEN, survived** (F4) |
| R9 | redaction drops the `RpcError` code | RED |
| R10 | enqueue id recorded on rejection | RED |
| R11 | `onInvalidNotification` for unknown methods too | RED (peer) |
| R12 | client `onClose` fails nothing | RED |
| R13 | ack rejection swallowed | **GREEN, survived** (F3) |
| R14 | `finishTurn` records no `end` | RED (2 tests) |

### Attacks tried

1. **A microtask `await` in the driver.** Read the code (premise 1): none.
   The comment at `:176-184` warns against adding one. Holds.
2. **An enqueue right after the ack** (second assumption): holds, by reading
   and by M5.
3. **End-to-end on the real stack**
   (`.tentacle/tmp/session-turn-events-review/e2e.ts`: real `Connection` +
   `RemoteClient` + `RemoteSession`):
   - two steers in one turn → `["text","steer:a","steer:b","text","turn_end"]`,
     model saw `["go","a","b"]`;
   - `prompt` rejected → `threw: a turn is already running`;
   - socket closed mid-turn → `threw: connection closed`;
   - enqueue after the turn → `resolved (no-op)`, which led to F1.
4. **Ack vs. stream order:** the client tolerates both, and the handler is
   installed before the `prompt` is sent. `turn_start` is emitted
   synchronously inside `prompt`, so it always precedes the ack frame. Holds.
5. **Another turn's `turn_end`** (e.g. a late `cancelled` from the previous
   turn after a client-side `fail`): ignored by `turnId` (M11 red). This is an
   improvement over `main`.
6. **A hook that throws:** `onClose` is guarded. `onTurnError` is not (F2).
   `onInvalidNotification` is not (F5).
7. **History after `turn_end`:** `turn_end` is now emitted *before*
   `Session.send`'s `finally` (persist hook) runs. The daemon's `Session` has
   no `onPersist`, though, and every message is pushed before the agent's
   `turn_end` yield. The client's post-turn `snapshot` is a later macrotask,
   so it sees the complete history. Holds.
8. **Error rendering parity:** the TUI renders `String(error)` on an
   `RpcError`. It is rebuilt with the streamed code (or `InternalError`), so
   the text matches `main`. Holds.
9. **Accepted, documented gaps** (not findings):
   - an envelope-invalid frame with an unreadable `sessionId` hangs the turn
     until close;
   - the idempotency maps are never evicted;
   - compaction racing a turn is unchanged (Drift 1).

### What holds

- The steering invariant and the turn-start reset.
- Exactly one effective `turn_end` per turn on every agent exit (end_turn,
  cancelled, max_iterations, throw), with the ack sent at once.
- `prompt`/`enqueue` idempotency and the `enqueue` turn binding.
- F2 and F3 of 3a are closed: an envelope-invalid frame now fails its turn,
  and the worker and `connect` runtimes have an `onError` sink.
- Redaction parity, the version bump and the schema.

### Executor behaviour

- Built in the plan's order and recorded seven drifts with their reasons.
  Drifts 3 and 5 are good catches: a throwing sink, and the measured ack order
  that corrected a planning claim.
- Mutation-checked 13 rows; the four sampled reproduce exactly. M12 was
  honestly reported as first-green and then fixed.
- Two weak spots remain:
  - mutation coverage targeted the daemon side and the new client paths, but
    missed the client's per-enqueue key and the ack-rejection branch (F3);
  - "drive never rejects" was asserted without considering the
    error-reporting hook itself (F2).
- Execution's "Not done" section is honest about the worker wiring and the
  real-TUI run. It does not mention the half-built Tests 11 (F4).

### Post-review fixes

*— claude-opus-5-5 (executor), 2026-10-20*

Each finding was verified against the code before the fix. F1 and F2 were
reproduced with the reviewer's scripts. Every fix ships with a test, and each
test is shown red by mutation (`.tentacle/tmp/session-turn-events/mutate.py`,
rows F1, F2, R5, R13, R8, F5: all RED).

| Finding | Fix | Test (red by mutation) |
|---|---|---|
| F1 (medium) steer after a failed turn silently dropped | `RemoteSession` keeps the latest `turnId` after the turn ends (`remote-session.ts`), so the steer reaches the daemon and is rejected `NoTurnRunning`, as on `main`. The no-op stays only before the first send. `window.ts` after the fix: `daemon saw enqueue: true` (its fake daemon answers `{}`; the real one rejects) | client "a steer typed after the turn ended REJECTS NoTurnRunning" |
| F2 (low) throwing `onTurnError` strands the turn | `reportTurnError` swallows a throw from the hook (nowhere left to report it). `hook.ts` after the fix: `running … false`, `turn_end` streamed | daemon "a throwing onTurnError … never strands the turn" |
| F3 / R5 constant enqueue key survives | no code change (correct today) | client "two steers in one turn … both reach the model" |
| F3 / R13 swallowed `prompt` rejection survives | no code change | client "a prompt the daemon refuses fails the turn" |
| F4 / R8 flush-before-TUI survives | `connectTui` takes injectable `{connect, startTui}` (defaults unchanged) | cli "a peer error raised while the TUI runs is written only after it exits" |
| F5 unguarded `onInvalidNotification` | guarded like `onNotification`, reported to `onError` | peer "a throwing onInvalidNotification is reported" |
| F6 UUID in the `NoTurnRunning` message | back to `main`'s "no turn is running" | — |
| F7 849 vs 850 | Both counts are right for their moment: 849 at the Execution gate, +1 when the M12 test was split into two variants before Review | — |

**Gate after the fixes** (`bun run check`): typecheck clean, biome clean,
**856 pass, 1 skip** (the opt-in live-k8s), 0 fail.

**Still open:** a second-model pass. The reviewer and the executor are the
same model (both noted it), so shared blind spots are possible on a
load-bearing task.

### Real TUI run

*— claude-opus-5-5 (executor), 2026-10-20*

The compiled binary (`bun run compile` → `dist/tentacle`), default worker
runtime, was driven in `tmux` against a deterministic fake OpenAI-compatible
endpoint. Config, sessions and logs were isolated under
`.tentacle/tmp/tui-run/`.

- **Normal turn:** it ends.
- **Steer mid-turn:** shown `⏳`, injected in the same turn, the model saw it,
  echoed, the turn ends.
- **Esc mid-stream:** the turn stops, with no late chunks. The server sees the
  request aborted.
- **Failing turn:** the real provider message is shown (worker exposure, same
  `RpcError: …` rendering), with the full stack in `daemon-errors.log`.
- **Persistence:** history is on disk after every turn, including the
  cancelled and the failed one.

**Not reachable by hand:** the F1 window, a steer typed during the post-turn
snapshot (one round trip). Covered by its client test.

