# eval/session-event-stream — the stream as single source of truth: consistent cut, turn events, compaction barrier, idempotent commands

> **Status:** closed — fully delivered through its three promoted parts, all merged to `main` (3a `da20289`, 3b `6578e61`, 3c `2ac72ff`); kept as the design record · audit 2026-10-20. Split approved (2026-10-19); **3a promoted** → `docs/feat/session-wire-classes.md` (branch `feat/session-wire-classes`, merged); **3b promoted** → `docs/feat/session-turn-events.md` (branch `feat/session-turn-events`, supersedes §3b where they differ); **3c promoted** (2026-10-20) → `docs/feat/session-history-cut.md` (branch `feat/session-history-cut`, supersedes §3c where they differ)
> **Branch:** none until promoted (then, if the split is approved, `feat/session-wire-classes` → `feat/session-turn-events` → `feat/session-history-cut`, one at a time; else `feat/session-event-stream`)
> **Type:** eval → feat · **Size:** L overall → split into 3a (S) · 3b (M) · 3c (M) on promotion (verified scope spans 7 packages and three risk centres; see Implementation, open question 1) · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (protocol + TUI-over-RPC session path, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** make the per-session update stream complete and
replayable, so a client that was away can reconstruct exactly what happened —
*before* any change lets a turn outlive its socket (parent, review F5).

Evidence (parent has the repro): the replay buffer is reset per turn and capped
by count (`daemon/src/hosted-session.ts:26,96`); `turn_end` is not streamed
(`daemon/src/mapping.ts:65,105`) — the stop reason is the `prompt` response
(`client/src/remote-client.ts:162`), lost on disconnect; history is committed
per round (`agent/src/agent.ts:256,331`) while streamed chunks get a seq before
that; `compact` replaces history out of band (`agent/src/session.ts:95-96`);
the daemon keeps only text content and drops other blocks silently
(`daemon/src/mapping.ts:14-19`).

## Implementation

> **Owner decisions (2026-10-19):** the open questions below are resolved in
> the parent, `docs/eval/session-reattach.md` §"Owner decisions after the
> children's Implementation drafts" (A–G, D1–D10). Where a question or
> design point here disagrees, the parent decision wins.


*— claude-opus-5-5, 2026-10-19 (draft, awaiting owner approval)*

Verified against `main` @ `4914e9b` (bun 1.4.3). Scripts run in
`.tentacle/tmp/session-event-stream-impl/` (gitignored); pasted in full below.

### Open questions / contradictions (owner decides before promotion)

1. **Split (recommended): this scope is L, not M.** Verified size: protocol
   (new events, classes, prompt/enqueue/snapshot shapes), agent loop (commit
   marker, compaction hook), daemon (ring, cut, turn driver, idempotency,
   paging, content check), transport (`onClose`), client (`RemoteSession`
   rewrite, paging, unknown-event tolerance), cli/tui (switch cases,
   persistence paging), plus the existing steering test rewritten. That is
   many files across 7 packages with three independent risk centres. Proposal:
   three ordered code tasks, each its own `feat/` branch + doc (created from
   the matching section below when this eval is promoted; the doc keeps the
   whole plan until then):
   - **3a `session-wire-classes`** — event classes on the wire, unknown-display
     tolerance, wire-hygiene test, explicit reject of non-text prompt blocks.
     S · load-bearing (every client's decode path).
   - **3b `session-turn-events`** — `turn_start`/`turn_end{error}`, `prompt`
     acks at once with a client `turnId`, lifetime idempotency maps for
     `prompt` and `enqueue`, new turn driver (steering invariant), client
     `RemoteSession` ends turns from the stream, `onClose` so a dead socket
     still ends the turn. M · load-bearing.
   - **3c `session-history-cut`** — byte-bounded per-session ring (never reset),
     agent `history_commit` marker, consistent cut `(seq, length, epoch)`,
     `history_replaced` barrier, paged `snapshot` pinned to the cut, `replayFrom`
     for `session-registry`. M · load-bearing.
   Order 3a → 3b → 3c: the class mechanism exists before the first new
   mandatory event; 3b closes F5 (turn outcome in the stream) on its own;
   `session-registry` needs both 3b and 3c. Each bumps `PROTOCOL_VERSION`
   (1 → 2 → 3 → 4); the version is free pre-public (parent constraint) and it
   keeps every intermediate `main` honest at `initialize`.
2. **The load-bearing assumption is false at round granularity** (proof below).
   The plan therefore adds an explicit agent marker (`history_commit`), which
   the Review anticipated. Alternative considered: cut only at turn
   boundaries, no agent change — rejected because the ring must then pin the
   whole running turn (observed max ≈ 1 MiB wire, unbounded for an
   unlimited-iteration turn), needing a cap and a degraded "cannot resync
   mid-turn" mode. Owner: confirm the marker.
3. **The parent's test property cannot hold literally for resync.** History
   (`ChatMessage`, `core/src/model.ts:29`) does not store reasoning chunks,
   usage, tool `rawInput` titles, diff `details`, `background_exit` notices,
   nor the partial text of a cancelled/failed round (never pushed,
   `agent.ts:240-254`), and it stores messages that have no event (the
   empty-round nudge `agent.ts:296`, the background note `agent.ts:445`). So
   "reducer output via snapshot+replay == uninterrupted reducer output" is
   false for anything at or before the cut. Recommendation: state the property
   over a **projection** — `project(state)` = the committed transcript
   (user/assistant text, tool calls by id with their result text, steers) plus
   the in-flight round after the cut — and require *exact* equality of
   everything after the cut (incl. display events). Display-only data of rounds
   before the cut is best-effort and documented as lost on resync. This
   affects `client-reattach`'s property test; flag it there.
4. **The user's prompt is not in the stream today.** `Session.send` pushes it
   (`agent/src/session.ts:66-68`) and no event carries it; a client that
   replays a turn started elsewhere (laptop) would never see what was asked.
   Design: `turn_start` carries the prompt text. Not in the Review's scope
   list; owner confirm.
5. **`compact` is not serialized with turns** (`hosted-session.ts:124-127`, no
   guard: `docs/fix/daemon-compact-turn-guard.md`, CONFIRMED there, not
   merged). The barrier is only sound if compaction cannot overlap a turn.
   Recommendation: land `fix/daemon-compact-turn-guard` (S) **before 3c**;
   3c lists it as a precondition and does not re-implement it.
6. **The Review says the no-await window "has no test"; it has one.**
   `packages/daemon/test/integration.test.ts:424-472` ("no macrotask fits
   between the last steering drain and the turn's end", both `end_turn` and
   `max_iterations`), cited by the comment at `agent.ts:270-278`. 3b must
   *rewrite* it for the new driver (it calls `hosted.prompt` and expects the
   stop reason, which no longer exists) and keep it non-vacuous; the Review's
   "Review must check it by reading the new turn driver" stays as an addition.
7. **Turn errors and secrets.** Today a non-`RpcError` turn failure reaches a
   remote client as an opaque "internal error" (`transport/src/peer.ts:333-345`)
   and the full error goes to the daemon log; only the worker exposes it
   (`cli/src/worker.ts:97-104`). Once the error rides `turn_end`, the peer no
   longer sees it. Design keeps parity (redaction policy + log sink on
   `SessionHost`); owner confirm.
8. **Optional (not in design): bind `enqueue` to a turn.** An `enqueue` first
   rejected with `NoTurnRunning` is not remembered; if its ack is lost and the
   client retries after a *new* turn started, the steer lands in the wrong turn.
   A `turnId` on `enqueue` (reject if it is not the running turn) closes it for
   a few lines. Recommend adding it in 3b; left out until the owner says so.
9. **Pre-existing, out of scope:** a steer accepted mid-round is dropped if the
   turn then errors or is cancelled before the next drain (the TUI clears its
   pending list on turn end, `tui/src/App.tsx:366`). Not changed here; noted so
   nobody believes 3b closed it.

### Load-bearing assumption

*The daemon can observe the "history committed" boundary from the agent's event
stream.* **False at round granularity; true at turn granularity.**

Experiment (`commit-boundary.ts`): real `Agent` + `Session`, a scripted model
that yields each event after a 2 ms timer (one macrotask per event, like network
I/O). The consumer records the history's roles at receipt of each event, at the
next microtask and at the next macrotask. Round 1: text + a tool call; a steer
queued during round 1; round 2: a whitespace-only reply (the empty-round nudge
path); round 3: final text.

```ts
import { Agent, Session } from "@tentacle/agent";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";

const script: StreamEvent[][] = [
  [
    { type: "text", delta: "Let me " },
    { type: "text", delta: "look." },
    { type: "tool_call", toolCall: { id: "c1", name: "missing", arguments: "{}" } },
    { type: "done", usage: { promptTokens: 1, completionTokens: 1 } },
  ],
  [{ type: "text", delta: " " }, { type: "done" }],
  [{ type: "text", delta: "Done." }, { type: "done" }],
];
let turn = 0;
const model: ModelProvider = {
  id: "scripted",
  async *stream(_req: ChatRequest) {
    for (const e of script[turn++] ?? [{ type: "done" }]) {
      await new Promise((r) => setTimeout(r, 2));
      yield e;
    }
  },
};
const noopEnv = { id: "noop", exec() { throw new Error("x"); }, readFile() { throw new Error("x"); }, writeFile() { throw new Error("x"); } };
const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv as never });
const session = new Session(agent, "s1");
const send = session.send("go");
const roles = () => session.messages.map((m) => m.role[0]).join("");
const rows: string[] = [];
let i = 0;
for await (const ev of send) {
  const n = ++i;
  if (n === 1) session.enqueue("steer-A");
  const atReceipt = roles();
  const label = ev.type === "text" ? `text(${JSON.stringify(ev.delta)})` : ev.type;
  const row = { n, label, atReceipt, micro: "", macro: "" };
  queueMicrotask(() => { row.micro = roles(); });
  setTimeout(() => { row.macro = roles(); rows.push(`${String(row.n).padStart(2)} ${row.label.padEnd(16)} receipt=${row.atReceipt.padEnd(9)} microtask=${row.micro.padEnd(9)} macrotask=${row.macro}`); }, 0);
}
await new Promise((r) => setTimeout(r, 50));
for (const r of rows) console.log(r);
console.log("final:", session.messages.map((m) => `${m.role}:${JSON.stringify(m.content).slice(0, 24)}`).join(" | "));
```

Output (2026-10-19; `u`=user `a`=assistant `t`=tool):

```
 1 text("Let me ")  receipt=u         microtask=u         macrotask=u
 2 text("look.")    receipt=u         microtask=u         macrotask=u
 3 usage            receipt=u         microtask=u         macrotask=uatu
 4 tool_start       receipt=ua        microtask=ua        macrotask=uatu
 5 tool_result      receipt=ua        microtask=uatu      macrotask=uatu
 6 steer            receipt=uatu      microtask=uatu      macrotask=uatu
 7 text(" ")        receipt=uatu      microtask=uatu      macrotask=uatu
 8 text("Done.")    receipt=uatuu     microtask=uatuu     macrotask=uatuu
 9 turn_end         receipt=uatuua    microtask=uatuua    macrotask=uatuua
final: user:"go" | assistant:"Let me look." | tool:"unknown tool: missing" | user:"steer-A" | user:"Continue with the task. | assistant:"Done."
```

Read, per push site:
- **Assistant message** (`agent.ts:256`): no event of its own. With tool calls
  it is visible at `tool_start` receipt (row 4: `ua`); without tool calls the
  next event is a late `steer`, `turn_end`, or — nudge path — the *next round's*
  text (row 8).
- **Tool message** (`agent.ts:339-340`): the event comes **before** the push
  (row 5: `tool_result` received with `ua`, the `t` appears one microtask
  later). A cut taken at `tool_result` would lose the result on resync.
- **Steer** (`agent.ts:203-204`, `282-283`): push, then event (row 6) — fine.
- **Empty-round nudge** (`agent.ts:292-298`): the whitespace chunk (row 7) is
  emitted, the empty assistant is popped and a nudge pushed, with **no event**
  — history shrinks and grows silently.
- **Background note** (`agent.ts:445`) and the **user prompt**
  (`session.ts:66-68`): pushed with no wire event at all.
- **Turn end**: at `turn_end` receipt the history is final (row 9), on every
  path: `end_turn` (`:300`), `cancelled` (`:197,241,252,348,397,405`),
  `max_iterations` (`:422`, after the last pushes `:402,417`); a thrown model
  error leaves the generator with no further push.

Also: the in-memory test transport delivers frames as **microtasks**
(`transport/src/channel.ts:40`), so in tests a `session/snapshot` *can* run
between row 5's receipt and its push; production transports (ws, worker port,
stdio) deliver macrotasks. A design that is right only under macrotask delivery
would pass in production and be untestable — so the cut must not depend on
microtask order.

Consequence (adopted): the agent yields an explicit `history_commit` marker
where `messages` reflects every event so far; the daemon records the cut there
and at `turn_end`; `snapshot` **slices** history to the cut's length, which
makes a late or missing marker harmless (see Design 3c).

### Preconditions

- `HostedSession.emit` numbers updates per session (`hosted-session.ts:82-89`);
  the buffer is reset per prompt (`:96`) and count-bounded (`:26,85-87`).
- The agent loop mutates history only by `push`, except one `pop` of the
  just-pushed empty assistant (`agent.ts:294`), and `Session.compact`, which
  replaces it in place (`session.ts:95-96`). Verified with
  `rg "messages\.(pop|splice|length =|shift)" packages/agent/src packages/daemon/src`
  → exactly those two hits.
- An async-generator consumer (`HostedSession.prompt`, `hosted-session.ts:100`)
  emits each event synchronously before the generator resumes (row 4–6 above:
  pushes land after the previous event was handled).
- Inbound requests are dispatched concurrently (`transport/src/peer.ts:184`,
  AGENTS §7) — `enqueue`/`snapshot` run while a turn is in flight.
- Steering invariant: comment at `agent.ts:270-278`; test
  `daemon/test/integration.test.ts:424-472`. `enqueue` rejects when not running
  (`daemon/src/connection.ts:160-166`).
- The turn's stop reason travels only as the `prompt` response
  (`connection.ts:213-220`, `client/src/remote-session.ts:81-87`); a dead socket
  rejects it via `RpcPeer.handleClose` (`peer.ts:234-243`). `RpcPeerOptions` has
  no close hook (`peer.ts:60-83`).
- Notifications are schema-validated; an unknown `update.type` fails the whole
  frame and is dropped with `onError` (`peer.ts:355-363`).
- Only two `null`s on the wire: `exitCode` (`protocol/src/updates.ts:76`) and the
  JSON-RPC error `id` (`jsonrpc.ts:77`) (`rg nullable packages/protocol/src`).
- `contentToText` keeps text, drops other blocks silently (`daemon/src/mapping.ts:14-19`).
- Client persistence: `persistingController` snapshots after each turn and
  compaction (`cli/src/local-runtime.ts:63-90`).
- Error exposure: worker exposes (`cli/src/worker.ts:97-104`), ws-server and
  stdio do not (`daemon/src/ws-server.ts:182`, `cli/src/serve.ts:96-100`).
- Depends on `docs/feat/protocol-schema-export.md` (merged first): I assume its
  interface as written there — `bun run schema:export` regenerates a committed
  `packages/protocol/schema/protocol.json` from `RequestSchemas` /
  `NotificationSchemas`, and a drift test fails the gate. Each sub-task here
  regenerates it; 3a adds the class annotation that doc reserves for this child.
- 3c depends on `fix/daemon-compact-turn-guard` (open question 5).

### Design

Shared vocabulary (what siblings consume — exact shapes):

```ts
// protocol/src/updates.ts
TurnEnd        = { stopReason: StopReason, error?: { code?: number, message: string } }
turn_start     = { type: "turn_start", turnId: string, prompt: string }            // mandatory
turn_end       = { type: "turn_end", turnId: string } & TurnEnd                    // mandatory
history_replaced = { type: "history_replaced", reason: "compact" }                 // mandatory
SessionUpdateParams = { sessionId, seq: number /* now required */, mandatory?: true, update }
UPDATE_CLASS: Record<SessionUpdate["type"], "display" | "mandatory">               // source of truth
// protocol/src/session.ts
PromptParams   = { sessionId, turnId: string(1..128), content: ContentBlock[] }
PromptResult   = { turnId, ended?: TurnEnd }        // `ended` only on a retry of a finished turn
EnqueueParams  = { sessionId, id: string(1..128), text }
EnqueueResult  = {}
SnapshotParams = { sessionId, cursor?: string, limit?: int ≥ 1 }
SnapshotResult = { messages: ChatMessage[] /* chronological */, since?: string /* first page only */, cursor?: string }
// daemon/src/hosted-session.ts (consumed by session-registry / permission-events / client-reattach)
replayFrom(since: string): { replay: SessionUpdateParams[] } | { resync: true }
snapshotPage(cursor?, limit?): SnapshotResult
running: boolean; activeTurnId: string | null
```

`permission-events` adds its two mandatory events to `UPDATE_CLASS`; a
`Record` type makes forgetting the class a compile error.

#### 3a — classes, unknown-event tolerance, wire hygiene, non-text reject

> **Promoted 2026-10-19 → `docs/feat/session-wire-classes.md`, which supersedes
> this section.** Verified drift:
> - Step 2's `z.union([SessionUpdateSchema, UnknownUpdateSchema])` is refused by
>   the merged exporter, and every flat or `not`-based catch-all breaks Swift
>   codegen or strict validation. Adopted: a named wrapper
>   `SessionUpdateOrUnknown = anyOf[SessionUpdate, UnknownSessionUpdate]`.
> - `seq` becomes required in 3a.
> - The annotation is `x-event-class`.
> - The daemon `null`-frame test is dropped (`rawInput` is opaque).

1. `UPDATE_CLASS` in `protocol/src/updates.ts`: all existing types `display`.
   `HostedSession.emit` sets `mandatory: true` from it (omitted otherwise).
2. Tolerance: `SessionUpdateParamsSchema.update` becomes
   `z.union([SessionUpdateSchema, UnknownUpdateSchema])` with
   `UnknownUpdateSchema = z.object({ type: z.string() }).passthrough()` (no
   `refine` — the export must stay representable). The client re-parses with
   `SessionUpdateSchema`: success → handle; fail and `type` known → loud error
   (malformed known event, `onError` + fail the in-flight turn); fail and
   unknown → `mandatory` ? loud error ("daemon newer than this client — update")
   : ignore. One pure function `classifyUpdate(params)` in `client/src/mapping.ts`.
3. Wire hygiene: no schema change needed (already true); pinned by a test that
   walks the exported JSON Schema and fails on any `null` type outside the two
   allowed paths, and by a daemon test that every emitted frame round-trips
   without a `null` except `exitCode`.
4. Non-text prompt blocks: `HostedSession.prompt` rejects with `InvalidParams`
   (-32602, `jsonrpc.ts:20`) and message "only text content is supported (see
   attachments)" if any block is not `text`. A new domain code is not needed.
   `contentToText` stays for the text join.
5. `PROTOCOL_VERSION` 1 → 2; regenerate the schema; annotate each update variant
   with `"x-tentacle-class"` in the export script from `UPDATE_CLASS`.

#### 3b — turn events, ack-at-once, idempotency, turn driver

> **Constraints from the 3a Review (2026-10-20), both pre-existing on `main`, both
> must be closed here because 3b adds the first mandatory events:**
> 1. A frame that fails the *envelope* schema (no `seq`, empty `type`, a
>    non-object `update`) is dropped at the peer (`transport/src/peer.ts:360-363`)
>    and never reaches `classifyUpdate`/`fail`: a malformed mandatory frame
>    (e.g. `turn_end`) mid-turn would hang the turn. Route envelope failures of
>    `session/update` to the session's handler (`fail`) when `sessionId` is readable.
> 2. The in-process worker (`cli/src/local-runtime.ts:219`) and `connect`
>    (`cli/src/connect.ts:21`) build `RemoteClient` without `onError`, so a stream
>    error with no turn in flight is silent there. Wire a sink (never a raw
>    terminal write, AGENTS §7).

1. `prompt` is **synchronous** (no `await` before the ack):
   ```
   prompt(turnId, content):
     rec = turns.get(turnId); if rec → return { turnId, ...(rec.end ? { ended: rec.end } : {}) }   // key first
     assertTextOnly(content)                                   // 3a
     if controller (or compacting) → throw TurnInProgress
     controller = new AbortController(); activeTurnId = turnId; turns.set(turnId, {})
     emit(turn_start{turnId, prompt: text})
     void drive(turnId, text, controller)                       // not awaited by the handler
     return { turnId }
   ```
   `Connection.prompt` returns it directly.
2. `drive` consumes `session.send`; per event: `history_commit` → cut (3c; in
   3b ignored), `tool_start` → `currentToolCallId`, else `eventToUpdate` →
   `emit`. On the agent's **`turn_end` event**, inside the loop body, one
   synchronous `finishTurn(turnId, {stopReason})`: record `turns.get(turnId).end`,
   record the cut (3c), `emit(turn_end…)`, `controller = null`,
   `activeTurnId = null` — then `return`. A throw from the generator →
   `catch` → `finishTurn(turnId, {stopReason: "error", error: redact(e)})`; a
   generator that ends without `turn_end` → `finishTurn(..., "end_turn")`
   (today's fallback, `hosted-session.ts:112`). `finishTurn` is idempotent per
   turn (guard on `end` already set).
3. **Steering invariant kept:** from the agent's last drain to `controller =
   null` there are only the generator's own microtask hops (as today) and the
   synchronous `finishTurn`; the sink is a synchronous call
   (`peer.notify`). No `await`, no async hook. The `agent.ts:270-278` comment is
   updated to name `HostedSession.finishTurn` instead of `HostedSession.prompt`.
4. `enqueue(id, text)`: `if (enqueued.has(id)) return {}` → `if (!running) throw
   NoTurnRunning` → `enqueued.add(id); session.enqueue(text)`. Key **before**
   `running`. A rejected attempt is not recorded.
5. Lifetime maps: `turns: Map<turnId, {end?: TurnEnd}>` and `enqueued:
   Set<id>`, per `HostedSession`, no eviction (review F8); ids capped at 128
   chars by schema. Dropped with the session object (registry `close` later).
6. Error policy: `SessionHostOptions.exposeTurnErrors?: boolean` (worker:
   `true`, next to `exposeInternalErrors`) and `onTurnError?: (e: Error) => void`
   (worker: `logDaemonError`; ws/stdio: the existing `onError`/`log`). `redact`:
   `RpcError` → its code+message; else exposed ? `message` : `"internal error"`.
   `onTurnError` always gets the full error — never silent.
7. Transport: `RpcPeerOptions.onClose?: () => void`, called once from
   `handleClose` (`peer.ts:234`). `RemoteClient` keeps close listeners.
8. Client: `RemoteClient.prompt(sessionId, turnId, text)` → `PromptResult`.
   `RemoteSession.send` generates `turnId = crypto.randomUUID()`, installs the
   update handler, sends `prompt`; the queue ends on `turn_end` **with that
   `turnId`** (`error` → `queue.fail(new Error(error.message))`, otherwise push
   the local `turn_end` and close). A rejected `prompt` → `queue.fail`. A close
   while the turn is open → `queue.fail(new Error("connection closed"))`
   (today's observable, kept until `client-reattach` turns it into a
   reconnect). `turn_start`/`turn_end` of another `turnId` are ignored.
   `enqueue` sends a fresh `id`. `client/src/mapping.ts`: `turn_start`,
   `turn_end`, `history_replaced` → `null` (handled by `RemoteSession`).
9. `stopReasonFromProtocol` unchanged; TUI behaviour identical (it already
   renders a thrown error with `failTurn`, `App.tsx:361-362`).
10. `PROTOCOL_VERSION` → 3; schema regenerated.

#### 3c — ring, consistent cut, barrier, paged snapshot

1. **Agent marker.** `AgentEvent` gains `{ type: "history_commit" }`, yielded
   only at points where `messages` reflects every event yielded so far:
   (a) right after the assistant push **when it has tool calls**
   (`agent.ts:256-260`, before the tool loop); (b) right after each tool
   message push (`:340`); (c) right after the cancelled-tool `tool_result`
   yield (`:316-321`). Never in the no-tool branch (the `pop` at `:294` must stay
   beyond the cut). Turn end is a commit point recorded by the daemon. Consumers
   ignore it: `cli/src/render.ts` (`""`), `tui/src/state.ts` (state unchanged),
   `daemon/src/mapping.ts` (`null`); `agent/src/subagent.ts` uses an if-chain
   (`:180-185`) — no change. Yields are microtask-only, so the steering window is
   unaffected (none is added between the last drain and `turn_end`).
2. **Cut** `{ seq, length, epoch }`, opaque on the wire as `since =
   "<epoch>.<seq>"`. Recorded (synchronously) on `history_commit`, in
   `finishTurn`, and on history replacement. Snapshot returns
   `messages.slice(0, cut.length)` — so pushes after the cut (assistant,
   nudge, notes, the next user prompt) are invisible until the next cut, and
   replay `seq > cut.seq` carries them. This is why a lagging cut is always
   correct: the only requirement is that history is append-only beyond
   `cut.length` within an epoch (Preconditions: the `pop` is never across a
   marker; compaction bumps the epoch).
3. **Compaction barrier.** `Session.compact(signal, onReplaced?)` calls
   `onReplaced()` synchronously right after `this.messages.push(...next)`
   (`session.ts:96`), before `persist()`. `HostedSession`'s hook: `epoch++`,
   `emit(history_replaced{reason:"compact"})`, `cut = {seq, length, epoch}`. No
   microtask gap between replacement and barrier, whatever the transport.
4. **Ring.** `SessionRing`, a new pure module `daemon/src/ring.ts`: entries
   `{params, bytes = JSON.stringify(params).length}`, `push`, `evict` while
   `total > maxBytes` **but never an entry with `seq > cut.seq`** (pin), and
   `since(seq)` → entries after it or `null` when evicted. Never reset (the
   `turnBuffer = []` at `hosted-session.ts:96` goes). Default
   `maxBytes = 4 MiB` (`SessionHostOptions.ringBytes`, configurable on `serve`).
   The pin is bounded by one round + one tool's events (≤ 315 KiB observed).
5. **`replayFrom(since)`** (consumed by `session-registry`'s `open`): parse
   `since`; malformed, future seq, older epoch than current, or evicted →
   `{resync: true}`; else `{replay}`. Synchronous (the registry's attach must be
   one tick).
6. **Paged snapshot.** No cursor: `end = cut.length`, return
   `messages[max(0,end-limit), end)` chronologically, `since = cut`, and
   `cursor = "<epoch>.<start>"` iff `start > 0`. With a cursor: same epoch
   required (else `InvalidParams` "stale cursor — resync"), `end = start` from
   the cursor (validated `0 < end ≤ cut.length`). `since` is returned **only on
   the first page** (no cursor): later pages are older slices of the same epoch
   and must not move the client's cut. So `SnapshotResult.since` is optional,
   present iff the request had no cursor. `limit` omitted → all
   (one call; today's persistence path keeps working). `RemoteClient.snapshot`
   loops pages with `limit = 200` until no cursor and returns the joined
   history (persistence unchanged; a page is bounded by roughly 200 × the
   16 000-char inline tool-output cap, `config/src/defaults.ts:27`, ≈ 3.2 MB,
   under the 8 MiB frame cap — large diff resources are not counted there,
   unverified, see `oversize-frame-hang`).
7. `PROTOCOL_VERSION` → 4; schema regenerated.

Ring size calibration (`ring-calibration.ts`, over the 52 local session
records in `~/.config/tentacle/sessions`, sizes only; text sent as 4-char
deltas each paying a measured 141-byte envelope; reasoning is not in history,
so this underestimates reasoning-heavy models):

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2] ?? "";
const env = JSON.stringify({ sessionId: crypto.randomUUID(), seq: 123456,
  update: { type: "agent_message_chunk", content: { type: "text", text: "" } } }).length;
const DELTA = 4;
const wireText = (chars: number) => chars + Math.ceil(chars / DELTA) * env;
type Msg = { role: string; content: string; toolCalls?: { arguments: string }[] };
const turns: number[] = []; const rounds: number[] = []; let biggestMsg = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as { messages?: Msg[] };
  let cur = -1;
  for (const m of rec.messages ?? []) {
    const isTurnStart = m.role === "user" && m.content !== "Continue with the task." && !m.content.startsWith("[background]");
    if (isTurnStart) { if (cur >= 0) turns.push(cur); cur = 0; continue; }
    if (cur < 0) continue;
    let b = 0;
    if (m.role === "assistant") { b = wireText(m.content.length) + (m.toolCalls ?? []).reduce((s, c) => s + c.arguments.length + 150, 0); rounds.push(b); }
    else if (m.role === "tool") { b = m.content.length + 150; }
    biggestMsg = Math.max(biggestMsg, b); cur += b;
  }
  if (cur >= 0) turns.push(cur);
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
console.log(`chunk envelope = ${env} bytes; assumed delta = ${DELTA} chars`);
console.log(`turns=${turns.length}  p50=${kb(pct(turns, 50))}  p90=${kb(pct(turns, 90))}  p99=${kb(pct(turns, 99))}  max=${kb(Math.max(...turns))}`);
console.log(`assistant rounds=${rounds.length}  p50=${kb(pct(rounds, 50))}  p99=${kb(pct(rounds, 99))}  max=${kb(Math.max(...rounds))}`);
console.log(`largest single message (wire est.) = ${kb(biggestMsg)}`);
```
```
chunk envelope = 141 bytes; assumed delta = 4 chars
turns=184  p50=72.4 KiB  p90=279.3 KiB  p99=775.3 KiB  max=1054.8 KiB
assistant rounds=1697  p50=4.3 KiB  p99=134.1 KiB  max=315.2 KiB
largest single message (wire est.) = 315.2 KiB
```

So 4 MiB holds ≈ 5 p99 turns (≈ 55 median turns): a phone away across several
turns replays instead of resyncing. 64 sessions × 4 MiB = 256 MiB worst case;
daemon-wide memory limits belong to `session-ttl-limits`. Text chunks cost
~35× their content in envelopes — coalescing chunks is a possible later
optimisation, not needed for correctness.

### Files

Dependency order (protocol → transport → agent → daemon → client → cli → tui).

- **3a:** `protocol/src/updates.ts` (`UPDATE_CLASS`, `mandatory`, unknown
  union), `protocol/src/version.ts`, the export script + committed schema from
  `protocol-schema-export`; `daemon/src/hosted-session.ts` (emit flag, text-only
  check); `client/src/mapping.ts` (`classifyUpdate`), `client/src/remote-client.ts`
  (route through it); tests in `protocol/test`, `daemon/test/integration.test.ts`,
  `client/test/mapping.test.ts`.
- **3b:** `protocol/src/updates.ts` (`turn_start`, `turn_end`, `TurnEnd`),
  `protocol/src/session.ts` (`PromptParams/Result`, `EnqueueParams`), version,
  schema; `transport/src/peer.ts` (`onClose`); `agent/src/agent.ts` (comment
  only, `:270-278`); `daemon/src/hosted-session.ts` (prompt/drive/finishTurn,
  maps), `daemon/src/session-host.ts` (`exposeTurnErrors`, `onTurnError`),
  `daemon/src/connection.ts` (prompt/enqueue), `daemon/src/mapping.ts`;
  `client/src/remote-client.ts`, `client/src/remote-session.ts`,
  `client/src/mapping.ts`; `cli/src/worker.ts`, `cli/src/serve.ts`,
  `cli/src/main.ts` (wire the two `SessionHost` options); tests in
  `daemon/test/integration.test.ts` (incl. the rewritten steering-window test),
  `client/test/remote.test.ts`, `transport` peer test.
- **3c:** `protocol/src/updates.ts` (`history_replaced`),
  `protocol/src/session.ts` (`Snapshot*`), version, schema; `agent/src/agent.ts`
  (`history_commit` type + 3 yields), `agent/src/session.ts` (`onReplaced`);
  `daemon/src/ring.ts` (new, pure), `daemon/src/hosted-session.ts` (cut, ring,
  `replayFrom`, `snapshotPage`, compact hook), `daemon/src/session-host.ts`
  (`ringBytes`), `daemon/src/connection.ts` (snapshot), `daemon/src/mapping.ts`;
  `client/src/remote-client.ts` (paging loop), `client/src/mapping.ts`;
  `cli/src/render.ts`; `tui/src/state.ts`; tests in `agent/test/agent.test.ts`,
  `agent/test/session.test.ts`, `daemon/test/ring.test.ts` (new),
  `daemon/test/integration.test.ts`, `client/test/remote.test.ts`.

### Failure modes

- **Ring overflow mid-round** → impossible past the cut (pin). Older entries
  evicted → `replayFrom` answers `resync`; snapshot+replay from the cut always
  converges; the client discards its partial round (client-reattach).
- **Ack lost, `prompt` retried** (running or ended) → cached ack, never a second
  run; ended → `ended` carries the outcome even if `turn_end` left the ring.
- **Retry with same `turnId`, different content** → the key wins (documented;
  a client bug, not a daemon decision).
- **`prompt` while running / compacting** → `TurnInProgress`, after the key
  check.
- **`enqueue` retried after its turn ended** → cached `{}` (key before
  `running`); never `NoTurnRunning`, never applied twice.
- **Model/provider error** → `turn_end{stopReason:"error", error}` in the
  stream; full error to `onTurnError`; remote message redacted (parity).
- **Socket dies after the ack** → `RemoteSession` fails the turn via `onClose`
  (no hang). Daemon side unchanged in this child: `Connection.close` still
  cancels the turn (`connection.ts:82-87`), which ends it with `turn_end
  cancelled` into a detached sink — detach semantics are `session-registry`'s.
- **`turn_end` emitted, sink throws** → the sink is `peer.notify`, which returns
  after `channel.send`; a closed peer is a no-op. `finishTurn` sets state
  before emitting so a throw cannot leave `controller` set.
- **Compaction racing a snapshot** → old cut valid until the synchronous hook;
  after it, the new epoch. A cursor of the old epoch → explicit "stale cursor"
  error → client restarts paging. `since` of an old epoch → `resync`.
- **Compaction racing a turn** → excluded by the compact guard (precondition).
- **Paged snapshot racing new events** → pages are sliced from `cut.length` of
  the epoch, which is append-only; new events reach the client via replay.
- **Hostile/buggy `since` or `cursor`** (malformed, future, negative) →
  `resync` / `InvalidParams`; never a throw that kills the connection.
- **Unknown display event** (newer daemon, same version) → ignored; unknown
  mandatory → loud error; malformed known → loud error. Never silently.
- **Non-text block** → `InvalidParams`, nothing recorded, no turn starts.
- **Memory**: id maps grow one entry per prompt/enqueue for the session's life
  (ids ≤ 128 chars); a client spamming `enqueue` grows it — accepted (same
  principal already has shell), cleared with the session.
- **Version skew** → each sub-task bumps `PROTOCOL_VERSION`; mixed pairs fail at
  `initialize` with `VersionMismatch` (`connection.ts:181-186`).

### Tests

Red before green on the existing code for each; fakes and seams to reuse:
`ScriptedProvider`, `EchoSteerProvider`, `slowEnv`, `harness()`
(`daemon/test/integration.test.ts:19-77,286-327`), `createChannelPair`, the
`RpcPeer` client; for the agent, the scripted model pattern above.

**3a**
1. Daemon emits `turn_start` (3b) / a fake mandatory type with `mandatory: true`,
   display types without it. Property: `mandatory` present ⇔
   `UPDATE_CLASS[type] === "mandatory"`, over every frame of a full turn.
2. `classifyUpdate` table: known valid → handle; known malformed → error;
   unknown display → ignore; unknown mandatory → error. Red today: an unknown
   type is rejected by the peer (`peer.ts:360-363`).
3. Schema walk: no `null` outside `exitCode` and the error `id`.
4. `prompt` with an `image` block → `InvalidParams`, `model.calls.length === 0`.
   Red today (it runs with the text stripped).
Mutation: drop the `mandatory` check in `classifyUpdate` → 2 fails.

**3b**
1. `prompt` resolves **before** the first model event (a gated model): ack
   arrives while the model is blocked. Red today (prompt waits for the turn).
2. `turn_start{turnId, prompt}` is the first update of the turn and
   `turn_end{turnId, stopReason}` the last, each exactly once, for `end_turn`,
   `cancelled`, `max_iterations`, and a throwing model (`stopReason:"error"`,
   `error.message`; redacted to "internal error" without `exposeTurnErrors`,
   `onTurnError` spy called once with the real error).
3. Same `turnId` twice while running → same ack, `model.calls` unchanged; after
   the end → `ended` equals the streamed `turn_end`; after 50 more turns → still
   cached (not count-bounded — mutation: cap the map at 16 → red).
4. **Steering, exact sequence from the Review**: enqueue `{id}` accepted → drop
   its ack (call `hosted.enqueue` directly, discard the result) → turn ends →
   same `enqueue{id}` over the wire → `{}`, not `NoTurnRunning`; the model saw
   the text exactly once (`EchoSteerProvider.calls`). Mutation: check `running`
   before the key → red.
5. Rewritten steering-window test (both labels): the timer armed inside the last
   drain observes `running === false` **and** that `turn_end` was already
   emitted. Mutation: insert `await Promise.resolve()`+`setTimeout` (a macrotask
   wait) before `finishTurn` → red. (A pure microtask `await` is not caught by
   this test — that is why Review reads the driver.)
6. Client: `RemoteSession.send` ends on the stream's `turn_end`, ignores another
   `turnId`'s, and fails with "connection closed" when the channel closes after
   the ack (red today: hangs → test with a timeout). Peer test: `onClose` fires
   exactly once on remote close and on local `close()`.

**3c** — the exact property: *for every drop point k in a scripted turn
(text → tool → steer → text, plus a turn with a `compact` between turns), a
fresh client doing `snapshot` (all pages) + `replayFrom(since)` and feeding the
reducer projection yields the same projected transcript as an uninterrupted
client, and the applied seqs after `since` are contiguous.* Drive `k` by
calling `snapshot` from inside the update sink at the k-th emit — the
microtask-delivery worst case (`channel.ts:40`) — and once per k with a
macrotask delay.
1. Ring unit tests: eviction by bytes, pin respected, `since` after eviction →
   `null`, never reset across turns (a `background_exit` between two turns is
   still replayable after the second turn).
2. Agent: at every `history_commit`, `messages` contains the content of every
   yielded text/steer/tool_result (scripted runs of each branch incl. nudge,
   cancel mid-tool, `max_iterations`); no commit between the assistant push and
   the `pop`.
3. Compaction: `history_replaced` emitted; a `since` from before it → `resync`;
   an old cursor → "stale cursor".
4. Paging: newest page first, chronological inside; joined pages == full slice;
   `limit` omitted == today's result.
Mutations that must fail the property test: `since` = raw seq counter (no
cut); snapshot not sliced to `cut.length`; marker after the `tool_result`
yield but before the push (i.e. move it up one line); ring reset at turn start;
no `history_replaced` (drop point straddling a compact); pin disabled with a
tiny `ringBytes`.

Gate per sub-task: `bun run check` green; schema drift test regenerated.

### Why, item by item

- **Why an explicit marker, not inference from existing events.** The
  experiment shows four different orderings (event-then-push for tool results,
  push-then-event for steers, no event for nudges/notes/prompt, a pop). A daemon
  that infers commits encodes the agent loop's internals and breaks silently on
  the next loop edit; a marker states the contract where the pushes are.
- **Why slice the snapshot to the cut instead of returning all messages.** It
  turns the hard requirement ("the cut is exactly current") into an easy one
  ("the cut was consistent when recorded"): anything pushed after it is
  replayed, never doubled or lost, whatever the microtask order — which is what
  makes the property testable on the microtask channel pair.
- **Why only three marker sites.** Correctness needs none (a lagging cut is
  correct); markers only bound the ring pin to about one round. Fewer sites,
  fewer places to get wrong; none in the no-tool branch, where the `pop` lives.
- **Why the ring pins everything after the cut.** Otherwise a resync could be
  told `since = S` while `S+1…` is already evicted, and resync would loop
  forever. The pin is bounded by one round, so the byte bound still holds in
  practice.
- **Why `epoch` in `since`.** Compaction makes history non-append-only; an
  epoch makes "a `since`/cursor from before the compaction" detectable without
  storing history versions.
- **Why the compaction hook is synchronous inside `Session.compact`.** Awaiting
  `session.compact()` and then emitting leaves a microtask gap where history is
  new and the cut old; a snapshot there would slice the new array with the old
  length.
- **Why `turn_start` carries the prompt.** Otherwise replay cannot show what a
  turn started from another device was about (open question 4).
- **Why `prompt` is synchronous up to the ack.** Two prompts arriving together
  must see `controller` set by the first; an `await` before that admits both.
- **Why `finishTurn` runs inside the loop body on `turn_end`.** It keeps the
  window from the last drain to "turn ended" free of anything but the
  generator's own microtask hops — the same shape the steering fix proved.
- **Why `ended` in the cached ack.** A retry may come after `turn_end` left the
  ring; the outcome then lives only in the map. It costs one small object per
  turn, which the map already holds.
- **Why `mandatory` travels in each frame.** A client cannot look up the class
  of a type it does not know; without the flag "fail loudly on an unknown
  mandatory event" is impossible, and the version-bump rule is the only guard.
- **Why tolerate unknown types with a passthrough union, not `refine`.** A
  `refine` does not survive JSON Schema export (`protocol-schema-export` fails
  loudly on unrepresentable constructs); the client re-parse gives the same
  result in code.
- **Why `InvalidParams` for non-text.** It is what it is: the daemon does not
  accept these params yet. A domain code would be one more thing to remove when
  attachments land.
- **Why `onClose` in the transport.** With ack-at-once, the peer's rejection of
  the pending `prompt` (`peer.ts:239-242`) no longer ends the turn on the
  client; without a close signal a dropped socket hangs the TUI's spinner.
- **Why keep error redaction parity.** `turn_end.error` reaches remote clients
  on `serve`; a provider error can carry endpoint or key material. Redact
  exactly where the peer already does, and always log the real error.
- **Why `limit` omitted means "all".** Persistence (`local-runtime.ts:67-72`)
  and the TUI keep one call; only clients that want pages pay for the cursor
  logic.
- **Why split into three.** Three separate risk centres (decode path, steering
  window + client session path, agent loop + compaction) each deserve their own
  red-team Review; one branch would make the Review skim the hardest part.

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `protocol-schema-export`.** Scope (parent points
3–6, 14–16):
- Per-session ring bounded in **bytes**, never reset at turn boundaries; `seq`
  per-session monotonic. Exposes `replayFrom(since)` and the cut; the `open`
  method that serves them lands in `session-registry`.
- **Consistent cut**: the daemon tracks `committedSeq` = the seq at the last
  point where `messages` contains everything emitted so far (round end, turn
  end, compaction). `snapshot` returns `{messages, since: committedSeq}`.
  Replay `seq > since` then always carries the whole round in flight.
- `turn_start{turnId}`, `turn_end{turnId, stopReason, error?}`; `prompt{turnId}`
  acks at once; a failing turn ends with `turn_end{stopReason:"error", error}`.
- `history_replaced{reason}` emitted by `compact`; it advances the cut.
- Idempotency: `turnId → ack` map for the session's lifetime (not
  count-bounded, review F8); `enqueue` dedupes by `id` the same way.
- Event classes display/mandatory in the schema; clients ignore unknown display
  events.
- Wire hygiene: optional fields omitted, never `null` (except `exitCode`,
  JSON-RPC error `id`).
- Paged `snapshot{cursor?, limit?}` — newest first + cursor for older.
- A non-text content block is **rejected** with an explicit error instead of
  dropped (attachments come later, `docs/eval/attachments.md`).
- **Preserve the end-of-turn no-await window** (steering invariant, `packages/agent/src/agent.ts` (INVARIANT comment at the final steering drain, added by `fix/steering-over-rpc`)):
  from the final steering drain to the moment the turn is marked ended, the
  new turn driver must run synchronously — emitting `turn_end`, clearing the
  controller and recording the `turnId` ack happen in one synchronous segment.
  Update the `agent.ts` comment, which names `HostedSession.prompt` (that
  method changes shape here).
- **`enqueue` checks the idempotency key *before* `running`.** A key already
  seen returns the cached ack even if the turn has since ended; only an unseen
  key gets the `NoTurnRunning` check (`daemon/src/connection.ts`, steering
  branch).
- Bumps `PROTOCOL_VERSION`. Updates the exported schema (step 2).

**Why, item by item.**

- **Why a ring bounded in bytes, not in number of updates.** One update can be
  a 5-byte text chunk or a 500 KB tool result. A count bound bounds neither
  what we care about (memory) nor what we need (coverage): 1024 tiny chunks
  cover a fraction of one long answer, so the buffer overflows *mid-message*;
  1024 large tool results can be hundreds of MB. A byte bound limits memory
  directly, and the resync path handles anything older.
- **Why the ring is never reset at turn boundaries.** Today it is reset at
  every `prompt` (`hosted-session.ts:96`). Events between turns
  (`background_exit`) and the tail of the previous turn vanish as soon as the
  next turn starts: a phone away across two turns — one of them started from
  the laptop — loses the end of the first. Coverage must depend on size only,
  never on turn structure the client cannot see.
- **Why the cut is the last committed boundary, not the seq counter (F1).**
  Concretely: the model streams chunks with seq 41–45; the round is not yet
  committed (history is pushed only at round end, `agent.ts:256,331`). A
  snapshot with `since = 45` returns `messages` *without* those chunks, and
  replay `seq > 45` *excludes* them: the client shows the answer with its first
  part missing. With `since = 40` (last committed), replay 41..N re-sends the
  whole round and the client renders it complete.
- **Why `since` is opaque to clients.** Clients only echo it back. If they
  compared or computed with it, its meaning would be frozen in every client
  language; opaque, the daemon can change the cut granularity later (per round,
  per turn) without breaking anyone.
- **Why `turn_start` / `turn_end` in the stream and `prompt` acking at once.**
  The outcome of a turn must live where re-attach can find it. The response to
  a request dies with its connection — the repro shows exactly that (`prompt`
  rejected with `connection closed`, stop reason lost). `turn_start` lets a
  client that attaches mid-turn know a turn exists and which one (`turnId`).
  Keeping `prompt` long-lived *as well* would give two channels for one fact,
  and every client in every language would need code to reconcile them.
- **Why a failing turn ends with `turn_end{error}`.** Today a model error is a
  rejection of `prompt`. A client that was offline when it happened would see a
  turn that never ends: a spinner forever.
- **Why `history_replaced` as a barrier (F6).** `compact` replaces the history
  array wholesale (`session.ts:95-96`) out of band. A client on the replay path
  would apply post-compaction events on top of its *pre-compaction* history:
  the conversation it shows no longer matches the daemon's, and nothing tells
  it. The barrier event forces a resync from the new cut.
- **Why idempotency keys live for the session's lifetime (F8).** Scenario: the
  phone sends a prompt in a tunnel, the ack is lost, the phone sleeps three
  hours, twenty turns run from the laptop, then the phone retries. A
  count-bounded key set has evicted the key → the prompt runs **twice** (think
  "deploy to staging"). One entry per turn is a few bytes; bounded by the
  session's life, cleared on close. A retry of a finished turn returns the
  cached ack, so the client converges instead of re-running.
- **Why `enqueue` gets an id too.** Same ambiguous-ack case: a duplicated steer
  injects the same instruction twice into the model's context.
- **Why event classes (display vs mandatory).** Today an unknown discriminant
  fails the whole frame (AGENTS §7 caveat). After going public we want to add
  display events (a progress bar, a new usage field) without breaking app
  versions users have not updated. But a *mandatory* event cannot be
  ignorable: an ignored `permission_request` is a turn suspended forever with
  no dialog; an ignored `turn_end` is a spinner forever. So the class is
  explicit in the schema, and a client fails **loudly** on an unknown mandatory
  event ("update the app") rather than hanging silently.
- **Why optional fields are omitted, never `null`.** zod distinguishes the two;
  TypeScript consumers tolerate both. Swift `Codable` and Kotlin serialization
  do not, cleanly: allowing both forces every client to handle three states per
  field (absent, null, value). One rule removes a state everywhere. Exceptions
  where `null` carries meaning: `exitCode` (`null` = killed by a signal, no
  code) and the JSON-RPC error `id`.
- **Why a paged snapshot, newest first.** `snapshot` returns the full history.
  A long session with large tool outputs reaches megabytes, and every resync
  re-transfers it: on mobile that is data, battery, and seconds before
  anything renders. It may also approach the 8 MiB frame cap
  (`ws-server.ts:40`; not verified, see `oversize-frame-hang`). Newest first
  because the UI shows the end of a conversation first and loads older parts on
  scroll, like every chat app.
- **Why reject non-text blocks explicitly now.** Today they are dropped
  silently (`daemon/src/mapping.ts:14-19`): a user sends a photo, the model
  answers as if there were none, and the user believes it saw it. Silent and
  plausible is the worst kind of failure; an explicit error is honest until
  `docs/eval/attachments.md` ships.
- **Why bump `PROTOCOL_VERSION`.** These are breaking changes; a mixed pair must
  fail at `initialize` with `VersionMismatch`, not mid-turn with a decode error
  (AGENTS §7).
- **Why the no-await window must survive the rewrite.** `fix/steering-over-rpc`
  proved that a remote `session/enqueue` is either drained into the turn or
  rejected with `NoTurnRunning` *only because* nothing between the final drain
  and "turn ended" yields to a macrotask: a transport message (WebSocket, worker
  `postMessage`, pod exec stream) cannot interleave. This child rewrites exactly
  that stretch (`prompt` acks at once; a separate turn driver emits `turn_end`
  and clears the controller). One `await` there — an async idempotency store, an
  awaited sink, an end-of-turn hook — reopens the window: the enqueue is
  accepted, the turn ends without draining it, the text is lost silently, the
  same bug class steering just closed. The invariant has no test (it depends on
  microtask order, fragile), so the only protection is that the plan names it.
- **Why the idempotency check comes before the `running` check.** Scenario:
  the phone sends a steer, the daemon drains it into the turn, the ack is lost,
  the turn ends, the phone re-attaches and re-sends `enqueue{id}`. Checking
  `running` first answers `NoTurnRunning`; the client concludes the steer was
  rejected and re-sends it as a new prompt — the instruction runs **twice**.
  The key says "already done"; it must win. Test it with exactly this sequence.
- **Ring size:** not fixed here on purpose — a proposal to calibrate in
  Implementation against real sessions (bytes per turn on long tool-heavy
  turns).

Load-bearing assumption to prove first: the daemon can observe the "history
committed" boundary. The agent pushes into `Session.messages` inside
`runMessages` (`agent.ts:256,331`) without emitting a dedicated event; verify
whether an existing `AgentEvent` (e.g. the round's final assistant/tool event)
always follows the push in the same tick. If not, the agent must emit a
`committed` marker — that touches the agent loop (load-bearing in itself).

Failure modes: ring overflow mid-round (→ resync from the cut; client discards
its partial round); `prompt` retried with an already-terminal `turnId` (return
the cached ack, never re-run); `compact` while a turn runs (coordinate with
`docs/fix/daemon-compact-turn-guard.md` — the barrier assumes compaction is
serialized with turns); paged snapshot racing new events (the cursor pins the
cut; later events come via replay).

Tests (steering): enqueue accepted → ack dropped → turn ends → same
`enqueue{id}` re-sent → cached ack, never `NoTurnRunning`, the model saw the
text once. The no-await window stays untested (microtask order); Review must
check it by reading the new turn driver.

Tests (daemon boundary, scripted client): the parent's revised property —
every drop point *k*, both re-attach and fresh/forced-resync mid-round, ordered
reducer output + seq contiguity. Mutations that must fail it: `since` = raw
counter; ring reset at turn start; no `history_replaced`; duplicate `turnId`
re-runs.
