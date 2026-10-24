# eval/send-now — interrupt the running turn and send the queued messages now (`Ctrl+X Ctrl+S`)

> **Status:** eval (context + drafted implementation; all owner decisions taken — S1–S3, D1–D5 — D3c confirmed by the owner 2026-10-22)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promotion → `feat/send-now` (split proposed: see *Files*)
> **Type:** eval → feat · **Size:** L (split into three: A = M, B = M, C = S) · **Blast:** load-bearing (the daemon busy slot, the steering no-await window, protocol, the single session path — AGENTS §7) · **Suited:** fresh-context Review mandatory (§10)

## Decisions

| # | Question | Decision | Status |
|---|---|---|---|
| S1 | Semantics | As Claude Code: cancel the whole turn (model stream AND running tools, through the existing cancel path), then start a new turn whose prompt is the queued messages joined | decided |
| S2 | Atomicity | A **new daemon method `session/send_now`** cancels and starts the new turn in one step: no other client's prompt can slip in between. Additive under protocol 10 (no bump): an old daemon answers `MethodNotFound` → the TUI falls back to cancel → wait for `turn_end` → `send`, with a one-time notice | decided |
| S3 | Queued rows | Show the `arc` spinner — **done** (`feat/queued-arc-spinner`, merged `d72606e`: `packages/tui/src/spinner.ts`, `components/QueuedMessages.tsx`); this task does not touch the row's glyph | decided |
| D1 | Join | All queued texts concatenated into **ONE user message, exactly as typed**, separated by **one blank line (`"\n\n"`)**, in queue order. No prefix, no numbering, no trimming | decided |
| D2 | Empty queue | Send-now does **nothing**: no request, no cancel, no notice | decided |
| D3 | Pending permission / running `/compact` / running hook | **Cancel it** (the suspended turn, the compaction, the hook) and send the queued messages | decided — see D3a–D3c in *Design*; D3c **confirmed by the owner 2026-10-22** (below) |
| D4 | Multi-client | Send **only the queued messages of the client that pressed the key**: the method's params carry that client's texts (with their enqueue ids), never the daemon's shared queue. Other clients' accepted-but-undrained steers **stay queued for the new turn** | decided |
| D5 | Keys | **Only `Ctrl+X Ctrl+S`** (a chord, 1500 ms window). No `Ctrl+Enter` | decided |

**D3c — confirmed by the owner (2026-10-22): queue locally during `/compact` (slice C).**
today the TUI has **no queue during `/compact`** — the TUI is not `running`
while a compaction runs (`/compact` is fire-and-forget, `App.tsx:573-588`), so
Enter starts a prompt the daemon rejects `CompactInProgress`
(`hosted-session.ts:736-742`). To make D3's "cancel `/compact` and send" reachable,
the TUI must queue locally while compacting. The plan does that (slice C) and,
for the case where the user does **not** press send-now, **sends the
compaction-time queue as one D1-joined prompt when the compaction ends**
(success or failure) — the only non-lossy option. Owner: confirm, or drop slice
C (then send-now during `/compact` is the D2 no-op, since the queue is empty).

## Context

*— claude-opus-5-5, 2026-10-22*

### The question

Approved in direction: a "send now" key, like Claude Code's (v2.1.275,
Sept 2026, per secondary sources — not verified against Claude Code itself).
While a turn runs, the user has typed messages that sit **queued** (steering:
injected at the next model-round boundary). Send-now **interrupts the running
turn and sends all queued messages at once, as one new prompt**, instead of
waiting for the boundary. This eval verifies the code it builds on and drafts
the plan.

### How queueing works today (verified)

- **TUI.** Enter mid-turn pushes an optimistic row into `queued: string[]`
  (`App.tsx:189`, push `:705`) and calls `ctrl.enqueue(text)` (`:713`); a
  reject drops one row and shows "_message not queued_" (`:713-717`). Each
  `steer` event drops the FRONT row (`:484-487`); the turn's `finally` clears
  them all (`:498`). Rows render only while `running` (`:1167`).
- **Client.** `RemoteSession.enqueue` binds the message to **its own** current
  turn (`this.turnId`, set only by its own `send`, `remote-session.ts:116-141`)
  with a fresh idempotency key, and calls `RemoteClient.enqueue` — a keyed
  `session/enqueue {sessionId, id, turnId, text}` (`remote-client.ts:496-503`;
  schema `protocol/src/session.ts:315-320`). The CLI wrapper forwards it
  (`cli/src/local-runtime.ts:159-160`). Every runtime goes through this one
  `RemoteClient` path (§7).
- **Daemon.** `Connection.enqueue` (`daemon/src/connection.ts:200-205`) →
  `HostedSession.enqueue` (`hosted-session.ts:848-860`): idempotent by `id`
  (`enqueued` set, checked first), rejects `NoTurnRunning` unless `turnId` is the
  active turn, then `session.enqueue(text)` (a push, `agent/src/session.ts:130-132`)
  and a persist. The push is synchronous before the handler's only `await`.
- **Agent.** `Session.send` resets the queue (`session.ts:85`) and passes
  `() => this.steering.splice(0)` as `drainSteering` (`:90`). The loop drains at
  each iteration top **after** the abort check (`agent.ts:451-462`) and once more
  just before `turn_end` (late steer, `agent.ts:573-580`), emitting one `steer`
  per text, in order. Persisted daemon state carries the undrained queue as
  `steering: string[]` (`daemon/src/persisted-session.ts:29-30`).
- **Consequence for D4:** a client can enqueue only into a turn **it** started
  (`remote-session.ts:116-121`), and a client does not render a turn started
  elsewhere (`remote-session.ts:230`), so its TUI is not `running` and its Enter
  becomes a `prompt` (→ `TurnInProgress`). Today the daemon's shared queue
  therefore only ever holds the prompting client's steers. The design still
  keeps foreign steers queued (D4), so a future cross-client enqueue stays
  correct.

### The cancel path and history validity (verified)

- TUI Esc / Ctrl+C → `abortRef.current.abort()` (`App.tsx:896-898`, `:850-860`)
  → `RemoteSession` sends the `session/cancel` **notification**
  (`remote-session.ts:177-183`, re-sent on the ack if it raced the prompt
  `:207-213`; `remote-client.ts:506-510`) → `HostedSession.cancel()` aborts the
  busy-slot controller (`connection.ts:322-330`, `hosted-session.ts:928-930`).
- **Mid-stream:** the stream rejects or completes late; either way the
  partial assistant reply is **not pushed** and the turn ends `cancelled`
  (`agent.ts:493-513`).
- **Tools:** the running tool gets `ctx.signal` (`agent.ts:377-380`; bash passes
  it to exec, `tools/src/builtins.ts:284-289`); calls not yet started are
  answered with the synthetic `CANCELLED_TOOL_NOTE` so the assistant's
  `toolCalls` stay answered (`agent.ts:723-742`); a call whose permission was
  settled by the cancel also reads as cancelled, never as a denial
  (`agent.ts:902-908`). The loop top then yields `turn_end{cancelled}`
  (`agent.ts:452-456`). History stays valid on every path.
- **Hooks** (`tool_call`, `tool_result`, `turn_start`, `turn_end` — the blocking
  ones; `config/src/schema.ts:84-90`) receive the turn's signal
  (`agent.ts:424-428`, `:539-545`; `hooks.ts:543`, `:575`) and run through
  `env.exec(…, {signal})` (`hooks.ts:749-767`), so the hook process is killed on
  cancel. `model_request` hooks are notify-only (`agent.ts:697-702`).
- **A tool that ignores its signal** keeps the turn (and the slot) until it
  returns: `await resultPromise` (`agent.ts:753`) has no abort race — by design,
  a running effect is never abandoned.

### Permission prompts (verified)

A pending permission is session state, settled by the FIRST of a client's
answer or the turn's abort → `cancelled`; no timer, nobody-attached never
settles it (`hosted-session.ts:20-29`, `awaitDecision` `:315-385`, abort
listener `:345`). The owner's "a turn suspended on a HUMAN permission waits
forever" rule is about *no automatic decision*; an explicit user cancel already
ends it today (Ctrl+C in the dialog: `App.tsx:825-835`). Send-now is the same
explicit user action (D3). In the TUI the dialog swallows every key today
(`App.tsx:820-848`), so the chord must be matched **before** the dialog branch.

### `/compact` (verified)

- Daemon: compaction holds the same busy slot (`compacting = true`,
  `hosted-session.ts:870-880`); `cancel()` aborts it (`:928-930`), or the
  request's own `$/cancelRequest` (`:876`). It then rejects `Cancelled`
  (`:885-889`). The `fix/daemon-compact-turn-guard` work is merged
  (`docs/fix/daemon-compact-turn-guard.md` header), so prompt/compact exclusion
  is the `assertIdle` slot check (`:736-742`).
- **No half-applied compaction:** `Session.compact` checks the abort after each
  `await` and replaces the history in one synchronous stretch with its barrier
  callback (`agent/src/session.ts:151-163`): an abort before replacement leaves
  the history untouched; after it, the compaction has fully happened.
- TUI: `/compact` is refused while `running` and is fire-and-forget otherwise
  (`App.tsx:573-588`); it passes no signal, and Esc does nothing while it runs
  (Esc requires `running`, `:896`). So today the TUI can neither queue nor cancel
  during a compaction — see D3c.

### Keys and the terminal input path (verified)

- Key handling is one `useInput` in `App.tsx:813-…`; line editing is routed by
  the pure `resolveLineInput` (`tui/src/input-actions.ts`). No chord exists.
  Existing Ctrl bindings: C (`App.tsx:825,850`), O (`:900`), V, A, E
  (`input-actions.ts:72,113,116`). **Ctrl+X and Ctrl+S are free.**
- Ink 5.0.1: a C0 control byte parses as `ctrl+letter` (`parse-keypress.js:179-181`)
  and `useInput` hands `input = keypress.name` when `ctrl`
  (`hooks/use-input.js:67`): Ctrl+X → `("x", ctrl)`, Ctrl+S → `("s", ctrl)`.
- Ctrl+S is XOFF when the tty has `IXON`. Raw mode normally clears `IXON`
  (libuv does), so `0x13` reaches the app — **not verified under Bun's
  `setRawMode`**: the first executor step (*Tests*, R0).
- (`Ctrl+Enter` is out of scope per D5; for the record, nothing in tentacle
  enables CSI-u/kitty or modifyOtherKeys, and `input-actions.ts:75-79` already
  notes modified Enter is not distinguishable.)

### `turn_start` / `turn_end` and the multi-client registry (verified)

Every turn is bracketed by `turn_start{turnId, prompt}` and
`turn_end{turnId, stopReason, error?}` (`protocol/src/updates.ts:101-115`),
emitted to all attachments (`hosted-session.ts:661-672`). A `RemoteSession`
acts only on updates for its active `turnId` (`remote-session.ts:300-323`);
`turn_start.prompt` is rendered only after a reset (`:310-312`). `prompt` is
keyed by the client-chosen `turnId` (retry → cached ack, `hosted-session.ts:690-694`).

### Repro (capability missing)

```
$ rg -n -i 'send_now|sendNow|send-now|ctrl.*"x"' packages --glob '!**/node_modules/**'; echo "exit=$?"
exit=1
```
(2026-10-22, on `feat/release-script` working tree; no code path exists.)

## Implementation

*— claude-opus-5-5, 2026-10-22*

### Load-bearing assumption

**The busy slot is the single gate every turn-starting request passes, in one
synchronous step — so a hand-off that moves the slot from the interrupted turn
(or compaction) to the successor *without ever leaving it empty* admits no
other prompt between the cancel and the start, however long the cancel takes.**

Proof:
- `prompt` takes the slot via `assertIdle()` + `this.controller = …` with no
  `await` in between, synchronously up to the ack (`hosted-session.ts:684-733`,
  comment `:676-678`); `compact` calls `assertIdle()` before its first `await`
  (`:870-878`); `assertIdle` throws `TurnInProgress`/`CompactInProgress` while
  `controller !== null` (`:736-742`). Nothing else starts a turn (resume runs
  in the constructor, `:280-303`).
- The slot is cleared in exactly two places: `finishTurn` (`:827-831`,
  synchronous) and `compact`'s `finally` (`:890-895`). `close` goes through
  `finishTurn` (`:940-951`).
- Requests are dispatched concurrently (`transport/peer.ts:322`, `void
  this.handleRequest`) but on one JS thread, and `handleRequest` reaches the
  handler with no `await` before it (`peer.ts:332-352`), so a handler's
  synchronous stretch cannot interleave with another's.

**Held.** Therefore the hand-off must (a) install the successor's controller in
the same synchronous stretch that would have cleared the slot, and (b) never
`await` between them. Mutation check for the Review: replace the hand-off with
"clear, then start" across a `queueMicrotask`/`setTimeout(0)` → the atomicity
test (T-D1) must fail.

### Preconditions

- P1 — Concurrent dispatch, never serialized (§7; `peer.ts:322`). The new
  handler is synchronous up to its ack, like `prompt`.
- P2 — Steering no-await window: from the agent's last drain to `finishTurn`
  clearing the slot there is no `await` (`agent.ts:560-572`,
  `hosted-session.ts:748-755`). The hand-off lives **inside** `finishTurn`
  (synchronous), so the window is preserved; the successor's start must not
  `await` either.
- P3 — `steer` events are emitted one per drained text, in queue order
  (`agent.ts:459-462`, `:573-578`), so a FIFO mirror of `{id, text}` in
  `HostedSession` knows exactly which enqueue ids were drained.
- P4 — An aborted turn never drains again: the loop-top check precedes the
  drain (`agent.ts:452` before `:459`), and the late drain is reached only past
  the post-stream abort checks (`:510`, `:546`) with no macrotask in between.
  So after `send_now` aborts the turn, the set of drained ids is final.
- P5 — Cancel keeps history valid on every path (Context, *cancel path*).
- P6 — Single session path (§7): the feature is one method through
  `RemoteClient`; no second send path.
- P7 — Persistence (§7): only `ChatMessage`s; the interrupted turn persists what
  the agent already pushed (no partial reply, cancelled tool notes); the new
  prompt is one `user` message pushed by `Session.send`. No rendering-only state
  is persisted.

### Design

**Protocol — `session/send_now` (request, keyed, additive, protocol stays 10).**
```ts
SendNowParamsSchema = z.object({
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,                       // the NEW turn; idempotency key
  interrupt: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("turn"), turnId: TurnIdSchema }),
    z.object({ kind: z.literal("compaction") }),
  ]),
  messages: z.array(z.object({                // THIS client's queue, in order (D4)
    id: z.string().min(1).max(128),           // its enqueue key (or a fresh one if never enqueued)
    text: z.string().min(1),
  })).min(1),                                 // D2: empty never reaches the wire
});
SendNowResultSchema = PromptResultSchema;     // { turnId, ended? }
```
Errors: `NoTurnRunning` (target not running and nothing to send), `TurnInProgress`
(the slot is someone else's, or a different successor is already reserved),
`InvalidParams` (non-text / malformed).

**Daemon — `HostedSession.sendNow(turnId, interrupt, messages)`**, synchronous
to the ack:
1. `turns.get(turnId)` known → cached ack (like `prompt`, `:690-694`).
2. Target check: `interrupt.kind === "turn"` needs `activeTurnId === interrupt.turnId`;
   `"compaction"` needs `compacting`. Target not running:
   - slot free (the turn ended on its own just before) → run as a plain prompt
     with the **undrained** messages (step 4's filter, against the last turn's
     drained ids); none left → `NoTurnRunning` (they were all injected; nothing
     is lost);
   - slot held by something else → `TurnInProgress`.
3. A successor already reserved → same `turnId` is step 1; another →
   `TurnInProgress`.
4. Reserve `successor = { turnId, messages, cancelled: false, steers: [] }`;
   `turns.set(turnId, {})`; add every `messages[i].id` to `enqueued` (a late
   `session/enqueue` of the same id is then a no-op success — never a false
   "not queued", never a double); abort the slot's controller; ack. (The reservation is not persisted: a restart in the window is the crash row of *Failure modes*.)
5. **Hand-off** (the only new branch in the slot-clearing code):
   - in `finishTurn(old)`: record the end, emit the old `turn_end`, then —
     instead of `controller = null` — call `startSuccessor()` in the same
     synchronous stretch;
   - in `compact`'s `finally`: same, after the history settled.
   `startSuccessor()` builds the prompt from `messages` minus ids the mirror
   saw drained (P3/P4); seeds the new turn's steering with the old turn's
   undrained steers whose ids are **not** in `messages` (other clients', D4)
   followed by `successor.steers` (step 6); takes the slot
   (`controller = new AbortController()`, `activeTurnId = turnId`); emits
   `turn_start{turnId, prompt}` (prompt = D1 join of the remaining texts;
   `""` when all were drained — a continuation turn, the drained steers are
   in history unanswered); `void drive(…, session.send(prompt, signal,
   {steering}))`. No `await` anywhere in it.
6. While reserved: `enqueue(id, turnId === successor.turnId, text)` is
   accepted into `successor.steers` (the user keeps typing after pressing the
   key; those bind to the new turn, see client). Enqueues for the old turnId
   keep today's behaviour until `finishTurn` (accepted while it unwinds — they
   cannot drain, P4 — and re-seeded by step 5).
7. `cancel()` while reserved (Esc/Ctrl+C during a slow unwind): abort as
   today **and** mark `successor.cancelled`; the hand-off then ends the
   successor with `turn_end{turnId, stopReason:"cancelled"}` and **no**
   `turn_start`, re-seeding nothing (the client restores its texts, below).
   `close()` does the same before `session_closed`.
8. Steering mirror: `enqueue` appends `{id, text}`; `drive` shifts it on each
   `steer` event (and records the id as drained for the turn); `Session.send`
   gains `SendOptions.steering?: readonly string[]` replacing the reset at
   `session.ts:85` (`this.steering = [...(opts.steering ?? [])]`) — the one
   agent change. Persisted state gains an optional parallel `steeringIds`
   (additive; an old record without it → match by exact text, first
   occurrence).

**D3 per target (all through existing abort paths):**
- **D3a pending permission:** the abort settles the ask `cancelled` and streams
  `permission_resolved` to every client (`hosted-session.ts:345`, `:443-455`);
  `runTool` returns `CANCELLED_TOOL_NOTE` (`agent.ts:902-908`); the loop top
  ends the turn → hand-off. History: the call is answered; "pending on disk ⇒
  never started" holds (`:377-381`). TUI: the chord is matched before the
  dialog branch and does `permission.answer(DISMISSED)` like Ctrl+C
  (`App.tsx:831-833`) so the dialog closes without sending a deny.
- **D3b `/compact`:** `interrupt:{kind:"compaction"}` aborts the compaction;
  `compact` rejects `Cancelled` to its requester, history untouched or fully
  replaced (`session.ts:151-163`); hand-off in its `finally`. The successor's
  messages are the TUI's compaction-time queue (slice C).
- **D3c running hook:** a blocking hook belongs to the turn; the abort kills
  its process (`hooks.ts:766`) and the agent's post-hook abort checks end the
  turn (`agent.ts:421`, `:546-550`; `hooks.ts:545`, `:577`). The successor is a
  normal turn: its `turn_start` hooks run on the joined prompt.

**Client — `RemoteClient.sendNow(sessionId, params)`** (keyed `sessionCall`,
like `enqueue`). **`RemoteSession.sendNow(messages, signal)`**: chooses the new
`turnId`, sets `this.turnId` to it at once (so later Enters enqueue into the
successor, step 6), sends the request, and returns
`Promise<AsyncIterable<SessionEvent>>` that **resolves on the ack** (so the TUI
can fall back on `MethodNotFound`) to the successor's stream. The successor is
a second `ActiveTurn` held as `next`; when the old turn ends, `active = next`.
On the successor's `turn_start` it emits `user_message{prompt}` when the prompt
is non-empty — the daemon's prompt is authoritative for what was sent. Its
abort sends `session/cancel` (step 7). `persistingController` gains
`sendNow` that persists after the successor settles (like `send`,
`local-runtime.ts:135-158`); the old turn still persists through its own `send`.

**TUI.**
- `tui/src/chord.ts` (pure): `stepChord(state, input, key, now)` →
  `{state, action: "sendNow" | "consumed" | "pass"}`. Ctrl+X arms (consumed);
  Ctrl+S within 1500 ms → `sendNow`; any other key or a timeout disarms and
  that key is `pass`ed through unchanged. Called first in `useInput` (after
  Shift+Tab), before the permission branch.
- `tui/src/queued.ts` (pure): rows `{id, text, turn: "current" | "next"}` with
  `add`, `onSteer` (drop front current row), `onReject(id)`, `takeForSendNow`
  (all current rows), `onTurnEnd` (drop current rows, promote next rows).
  Replaces the bare `string[]`; `enqueue(text, id)` passes the row's id.
- `App.tsx` `sendNow()`: rows empty → return (D2). Else, `ctrl.sendNow` exists
  and not latched-unsupported → await the ack; the current `run` loop ends
  on the old `turn_end`, then a `runStream` consumes the successor. On
  `MethodNotFound`: latch, notice once ("_this daemon can't send-now
  atomically — stopping the turn, then sending_"), fallback = `abort()` then,
  in `run`'s `finally`, `run(join(rows))`; if that prompt fails
  (`TurnInProgress`, another client won) the joined text is put back in the
  input field — never dropped. Successor cancelled (step 7) → texts restored to
  the input field.
- Lines shown: the interrupted turn ends with the existing cancelled marker
  (as Esc today); the new prompt appears as one user bubble from
  `turn_start.prompt`. `/help` keys line adds "Ctrl+X Ctrl+S send queued now"
  (`commands.ts:230`).
- **Slice C (D3c):** a `compacting` flag set by `/compact` until it settles;
  Enter while compacting adds local rows (no enqueue — no turn); send-now →
  `interrupt:{kind:"compaction"}`; compaction settles with rows left → send
  them as one D1 prompt.

### Files

Slice **A** (M, load-bearing) — protocol → agent → daemon → client:
1. `packages/protocol/src/session.ts` — `SendNowParamsSchema`/`SendNowResultSchema`.
2. `packages/protocol/src/methods.ts` — `Method.SendNow: "session/send_now"` + `RequestSchemas` entry.
3. `packages/agent/src/session.ts` — `SendOptions.steering` (replaces the reset at `:85`).
4. `packages/daemon/src/hosted-session.ts` — `sendNow`, successor reservation, hand-off in `finishTurn`/`compact`, `enqueue` for the successor, `cancel`/`close`, steering mirror.
5. `packages/daemon/src/persisted-session.ts` — optional `steeringIds`.
6. `packages/daemon/src/connection.ts` — `case Method.SendNow`.
7. `packages/client/src/remote-client.ts` — `sendNow` (keyed).
8. `packages/client/src/remote-session.ts` — `sendNow`, `next` turn, `user_message` from successor `turn_start`, `enqueue(text, id?)`.

Slice **B** (M, cross-module) — cli → tui:
9. `packages/cli/src/local-runtime.ts` — `persistingController.sendNow`, `enqueue(text, id)`.
10. `packages/tui/src/chord.ts` (new, pure), `packages/tui/src/queued.ts` (new, pure).
11. `packages/tui/src/App.tsx` — `SessionController.sendNow?`/`enqueue?(text, id?)`, chord dispatch before the dialog, `sendNow()`, fallback, row model.
12. `packages/tui/src/commands.ts` — `/help` keys line.

Slice **C** (S, contained) — `App.tsx` compaction-time queue (D3c, on owner confirmation).

### Failure modes

| Case | Convergence |
|---|---|
| Disconnect mid-interrupt | `send_now` is keyed by the new `turnId`: resent after recovery, cached ack if it ran (step 1), runs once otherwise (then step 2 if the old turn ended meanwhile). The successor's `turn_start`/`turn_end` are in the ring → replayed on reattach. A lost `session/cancel` (step 7) is re-sent on the ack, as today (`remote-session.ts:207-213`). Pod model-proxy drop cancels the turns (`connection.ts:104-115`): the successor then fails its model call → `turn_end{error}`, prompt in history. |
| Daemon between cancel and start | The slot is held by the aborted old controller, then handed over with no gap (load-bearing assumption). Other prompts/compacts get `TurnInProgress`; old-turn enqueues are accepted and re-seeded; successor enqueues are folded (step 6). A daemon crash in the window: the reservation is not persisted; on restart the old turn is "cut short, closed honestly" (§7) and the client's resent `send_now` gets step 2 (slot free → runs as a prompt). |
| Cancel takes long (hung tool) | The successor waits; the TUI shows "_sending after the current step stops…_" once. Esc/Ctrl+C in the window → step 7 (successor ended `cancelled`, texts back in the input). A tool that never returns traps the slot exactly as today's Esc does — no new hazard. |
| Old daemon | `MethodNotFound` (`peer.ts:332-334`) → latched fallback with one notice; non-atomic by nature: if another client's prompt wins, our prompt fails `TurnInProgress` and the text returns to the input field. |
| Race: another client's prompt | Before `send_now`: it got `TurnInProgress` (our turn held the slot). After: same. Never between (assumption). If the old turn ended and another client's turn took the slot before `send_now` arrived → `TurnInProgress`; our rows were drained or rejected already. |
| Race: another client's enqueue | Today impossible (Context, D4). If added later: its steers are undrained, not in our `messages` → re-seeded into the successor's steering, drained at its first boundary. |
| Race: our own in-flight enqueue | Its id is in `messages` → added to `enqueued` → the late request is a no-op success (no false "not queued"). Drained before the abort → excluded from the prompt (already in history). |
| Turn ends naturally just before `send_now` | Late drain injected every accepted steer (P2); step 2 sends only never-accepted ones, or `NoTurnRunning` (TUI: rows already echoed — silent, nothing lost). |
| Compaction finishes before the abort lands | History fully replaced (synchronous replace, `session.ts:157-160`); hand-off in `finally` starts the successor on the compacted history. |
| Empty prompt after filtering | Continuation turn (`""`), the drained steers get their answer; no user bubble. |

### Tests

Red first, each on the narrowest file; fakes as in the steering tests (a
tool that blocks until released, `SpyBroker`, two `RemoteClient`s on one
in-memory daemon).

- **R0 (repro, `.tentacle/tmp/send-now/`)**: under `bun`, raw-mode stdin
  receives `0x18` then `0x13` for Ctrl+X Ctrl+S and Ink's `useInput` reports
  `("x", ctrl)`, `("s", ctrl)`. If Ctrl+S is eaten (IXON), stop and report
  (AGENTS §0).
- `protocol/test/methods.test.ts` — schema accepts/rejects (empty `messages`, missing `interrupt`).
- `daemon` (HostedSession/Connection tests):
  - **T-D1 atomicity** — turn blocked in a tool; client A `send_now`; client B
    `prompt` before the tool is released → `TurnInProgress`; after release the
    stream is old `turn_end{cancelled}` immediately followed by successor
    `turn_start` (no update between). Non-vacuity: the mutation above makes it fail.
  - T-D2 join and order: `messages` A, B → one user message `"A\n\nB"`; `turn_start.prompt` equal.
  - T-D3 drained exclusion: A drained at a boundary before `send_now` → prompt is B only; history has A once.
  - T-D4 foreign steer re-seeded (enqueue with an id not in `messages`) → drained in the successor's first round.
  - T-D5 late enqueue of an id in `messages` → no-op success, no second injection.
  - T-D6 permission pending → `permission_resolved{cancelled}`, cancelled tool note in history, successor runs.
  - T-D7 compaction: `send_now{compaction}` → compact rejects `Cancelled`, history length unchanged, successor runs on the old history.
  - T-D8 cancel during the window → successor `turn_end{cancelled}`, no `turn_start`.
  - T-D9 idempotent retry; `NoTurnRunning`/`TurnInProgress` paths; enqueue to the successor turnId folded.
- `client/test/remote.test.ts` — `sendNow` resolves on ack and streams the successor after the old `turn_end`; rejects `MethodNotFound`; successor `user_message` from `turn_start`.
- `tui/test/chord.test.ts`, `tui/test/queued.test.ts` — arm/fire/timeout/pass-through; FIFO steer, reject by id, take, promote.
- `tui/test/app.test.tsx` — chord with rows calls `sendNow` with `{id,text}` rows; empty rows → no call, no notice (D2); chord while the dialog is up → dismissed + `sendNow`; `MethodNotFound` → one notice, abort, then `send("A\n\nB")`.

## Execution

## Review

## Addendum — decisions taken during execution

*— claude-opus-5-5 (orchestrator), 2026-10-23. Owner decisions, recorded so
every nuance lives in the repo, not only in a task doc.*

Principle behind all of them (owner): **the client never guesses what the
daemon knows; the daemon never guesses by text or by shape.**

**Task 4a (`session/send_now`, daemon) — merged `e0f38e3`; detail in
`docs/feat/send-now-a.md` Execution follow-ups 1–3 + Review round 2.**
1. *send_now after Esc already cancelled the turn* → still accepted: it
   starts a new turn with the queued texts (reviewer: consistent with S1/S2).
2. *Texts already delivered but unanswered* (crash before the hand-off, the
   `max_iterations` end-of-turn drain, a `turn_start` hook stop) → a
   **continuation turn** (prompt `""`), stamping `lastChangeAt` like any turn
   start. `NoTurnRunning` only when there is nothing to answer.
3. *"Unanswered" is decided STRUCTURALLY*: the history's last message is a
   `user` message (whoever wrote it — a continuation answers another
   client's text too, which is correct). Rejected: matching the caller's
   texts against the history (`ChatMessage` has no id; texts repeat;
   compaction rewrites them).
4. *The compaction summary* (a `user` message by construction) does not count
   as unanswered; it is recognised by **identity** (the hosted session marks
   the message it installed), never by position — `[system, summary]` has the
   same shape as a first turn `[system, first prompt]`.
5. *After a daemon restart* the marker is gone: an idle `[system?, user]`
   record → `NoTurnRunning` (an unrequested turn could run tools). The text
   stays in the history; the next normal prompt gets it answered (re-sending
   the same text would put it in the history twice). A turn cut short by a
   crash (`cutShort`) is still continued. Stated in the contract comment.
6. *Collateral fix:* ids placed in a send-now prompt are marked delivered, so
   a second send_now never re-sends them.
7. *Known, documented, no code:* after the resume of a permission-suspended
   turn the D1 order inverts (only after a crash).

**Task 4b (client + cli) — in progress on `feat/send-now-b`; detail in
`docs/feat/send-now-b.md`.**
8. *Ambiguous resync* (the successor's `turn_start` hidden by the cut, then
   `cancelled`) → the client no longer infers "not delivered": the daemon
   reports it (an additive `delivered`-style field where the recovery path
   reads the outcome). Restore-the-texts (possible visible duplicate, never a
   silent loss) remains ONLY as the fallback for an older daemon without the
   field.
9. *The old turn's label after a resync past the hand-off* → exact if the
   real outcome is recoverable through an EXISTING path (the idempotent
   retry's `ended`) with no protocol change; otherwise it stays `cancelled`,
   documented as an approximation (label only — the content is complete via
   the resync snapshot).
10. *Carry-overs for 4c (TUI):* `createSession` still returns
    `SessionController` — c must widen it for `sendNow`; a local
    `NoTurnRunning` must not be treated as silent (the queued texts must still
    reach the daemon); an enqueue during a compaction while the send-now
    request is in flight is not covered by 4b's tests (c's TUI path).
11. *Compaction target* (4b drift): no live turn exists during a compaction,
    so the send-now turn is installed at once and an enqueue in that window
    binds to the reserved turn, which the daemon can only fold.

**As built (4b follow-up 1, Review 2026-10-23):**
- *Item 8:* the field is `delivered?: boolean` on `TurnEnd`
  (`protocol/src/session.ts`, mirrored in the `turn_end` update in
  `updates.ts`) — the one shape both recovery paths share (the streamed
  `turn_end` and the re-sent `send_now`'s `ended`, both ending in
  `RemoteSession.finish`). The daemon sets `false` on a send-now turn
  cancelled before it started, `true` once it started; it survives a daemon
  restart (persisted with the cached turn end). An older daemon omits it → the
  client keeps restore-the-texts as the fallback only.
- *Item 9:* exact, no protocol change — the daemon answers a re-sent
  `session/prompt` for a known turn with its cached outcome, and the client's
  recovery re-sends it after the reset, so the old turn takes its REAL end
  (e.g. `end_turn`). "A turn started by another client" cannot be a session's
  active turn on this client, so it does not arise.
- *Record version:* **no `DAEMON_RECORD_VERSION` bump** for `delivered`
  (reviewer, verified by a repro on the pre-change parser; orchestrator
  agreed). The older parser keeps the field, rewrites it and serves it on
  retries — the record is NOT half-loaded; at worst an older daemon does not
  add it to turns it closes itself → the fallback (a visible duplicate, never
  a silent loss). A bump would make every older daemon refuse all records of
  this build (sessions disappear on a downgrade). When task 2a bumps the
  version to 2, `delivered` rides along with no migration.

**As built (4c, Review rounds 1–3, 2026-10-24 — pending the owner's OK to merge):**
- *No client-side guessing (owner principle, applied overnight; CONFIRMED by
  the owner 2026-10-24):* the 4b client's `RemoteSession.sendNow` sends even when its own
  turn already ended (naming the last turn) and, while the first `send` is
  still opening the session, waits for its id; refused locally only with no
  daemon-side session or turn at all. The daemon decides: a turn with the
  texts it did not get, a continuation, or `NoTurnRunning`. The TUI reads
  `NoTurnRunning` as "the daemon already has everything": a notice, no
  re-send, no restore into the input. Guesses survive only in the
  older-daemon fallback (`MethodNotFound`), documented.
- *Refusal reports what the daemon holds:* a refused `send_now`
  (`TurnInProgress`, `CompactInProgress`) carries `error.data.held`
  (`SendNowRefusalSchema`, `protocol/src/session.ts`) — the request's ids the
  daemon will really keep: in the history, or queued for a turn that will
  drain them (a reserved send-now NOT cancelled, a running turn NOT aborted,
  not during a compaction). The client restores exactly the others. Additive:
  no `PROTOCOL_VERSION` bump, JSON Schema regenerated; an older daemon sends
  no `data` → the client restores all (a visible duplicate, never a loss); an
  older client ignores it. Found by the review: restoring on every
  `TurnInProgress` duplicated texts another client's send-now had carried
  over; first `held` version also counted a queue whose only consumer was
  cancelled → silent loss; both fixed and pinned by tests.
- *Permission dialog:* the chord no longer dismisses it up front — if the
  `send_now` is accepted the daemon withdraws the request (the dialog stays
  visible for one round trip); if refused it stays answerable. Both
  fallbacks (latched and first `MethodNotFound`) dismiss it like Ctrl+C.
- *Fallback notice and `MethodNotFound` latch are per session* (reset on
  `/clear`).
- *Daemon restart:* reloaded `[user "A"]` → `NoTurnRunning`, no turn, no model
  call; "A" stays unanswered until the next prompt (item 5).
- *DECIDED (owner, 2026-10-24) — `endUnstarted` gap (from 4a):* when ANOTHER client's
  reserved send-now is cancelled before it starts, or another client presses
  Esc on my turn, my undrained queued texts are dropped with no notice.
  Reviewer: a separate `fix` task (S–M, load-bearing), not in 4c — it changes
  4a's contract. Options and repro in `docs/feat/send-now-c.md` (Execution
  follow-up 3).
  **UX rule (owner, 2026-10-24): a queued message goes back to whoever wrote
  it, on their own device, visibly — never re-sent by itself.** When another
  device stops the turn (Esc) or cancels its send-now before it starts, the
  writer's undelivered rows do not vanish: on the PC they go back into the
  input field (joined, as send-now joins them) with a notice, e.g. "Turn
  stopped from another device: your 2 queued messages are back in the
  input"; on the phone they go back into the compose field with a banner.
  The writer decides: Enter to send, or delete. Nothing changes for whoever
  pressed Esc (the turn stops, as they wanted). Rejected: re-sending them
  automatically as a new turn (it would override the other device's Esc);
  keeping them queued for the next turn, whoever starts it (they would ride
  someone else's prompt by surprise). The daemon tells the writer which ids
  came back (a daemon fact, never inferred). **Built in task 5
  (`queued-broadcast`)**, not as a separate fix: task 5 already broadcasts
  the queue and redefines the fate of rows left at a turn's end (its
  question 1) — one design, not two. Low urgency: it needs two clients on
  one session (the app arrives at task 11).
- *Debt:* some dispatch branching stays in `App.tsx` (listed in the 4c doc).
