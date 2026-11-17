# feat/queue-unqueue — Take a queued message back (cancel / edit) before the model reads it

> **Status:** implementation (plan written, NOT approved — see Owner questions)
> **Branch:** `feat/queue-unqueue`
> **Size:** M · **Blast:** load-bearing (the steering queue/drain seam of a running turn, §7 "steering window") · **Suited:** Opus exec + mandatory fresh-context Opus review
> **Changelog:** `changelog.d/queue-unqueue.added.md` — "**Cancel or edit a queued message.** A message queued while the model runs can be taken back before the model reads it."

## Context

*— claude-opus-5-5, 2026-11-17*

A message typed while a turn runs is queued (`session/enqueue`) and injected at
the next model-round boundary. Today it cannot be taken back: the only exits
from `entries` are delivery (`steer`), a send-now that carries it, or its turn
ending (→ `returned`) — `packages/protocol/src/session.ts:594-600` says so
explicitly ("Nothing else removes one"). The owner picked, for the phone, mockup
**E1**: tap the pending bubble → inline **Edit · Send now · Cancel**; Edit puts
the text back in the field ("Editing pending message ×", ↑ re-queues, × restores)
(`.tentacle/mockups/mobile-queued-compose/README.md`, "CHOSEN", owner 17/11).
*Send now* exists (`session/send_now`); *Cancel* and *Edit* need a daemon
operation that does not exist. This task adds it (protocol → daemon → client),
so `feat/mobile-queued-compose` (TODO.md:31) only has to render it.

**Repro (capability missing), verified 2026-11-17 by source, not run:**
`rg -n 'Unqueue|unqueue' packages/ apps/` → no hits; the method table
`packages/protocol/src/methods.ts:131-137` has `Enqueue`, `SendNow`, `Reclaim`
and nothing that removes an `entries` row. The executor writes the runnable
repro first (a `HostedSession` with a scripted model: enqueue during a turn,
then assert there is no way to stop the row reaching the next request) in
`.tentacle/tmp/queue-unqueue/` and pastes it here.

## Implementation

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**"Still in the agent's own steering array" ⇔ "the model has not read it and
never will in this turn"**, and removing it from that array is atomic with
respect to the drain. Proven:

- The agent loop takes queued texts ONLY through the `drain` callback, which is
  `Session.drainSteering` — a synchronous `splice(0)` of `steering` and
  `voiceMarks` together (`packages/agent/src/session.ts:314-323`, wired at
  `:276`). Every injection site calls `drain()` then pushes and yields the texts
  it returned (`packages/agent/src/agent.ts:1368-1376, 1410-1413, 1477-1480,
  1712-1718, 1821-1824, 1901-1904`). A text not yet spliced cannot reach
  `messages`.
- JS is single-threaded and `HostedSession.enqueue` is synchronous
  (`packages/daemon/src/hosted-session.ts:3667-3700`); an RPC handler for the new
  method is likewise synchronous, so it runs strictly before or strictly after a
  `splice(0)` — never inside it.

Consequence for the design: the check must read the **agent's array**
(`Session.steering`), NOT the daemon's id mirror `this.queue`. The mirror is
shifted only when the `steer` EVENT reaches `drive`
(`hosted-session.ts:3085-3093`), which is after the drain; with several texts in
one drain, their `steer`s are yielded one by one, so the mirror can **lag** the
agent (hold rows already drained) — it can never lead it. A check against the
mirror alone would answer "removed" for a text the model is about to read.

### Preconditions

- Peer dispatches requests concurrently (`transport/peer.ts`, §7 "Don't
  serialize the RPC peer"), so an unqueue is handled mid-turn exactly like an
  enqueue (`daemon/src/connection.ts:420, 658-660`).
- The queue is published as FULL state on every change (`queued` update,
  display class `protocol/src/updates.ts:553`; `publishQueue`
  `hosted-session.ts:1750-1761`); clients already converge on it
  (`session.ts:590-592`). No new update kind is needed.
- The queue is persisted from the mirror in the sidecar's `turn.steering` /
  `steeringIds` (`hosted-session.ts:1687-1699`) and restored into both the agent
  and the mirror (`:1102-1110`). `persist()` is the synchronous capture
  (`SessionPersister.schedule`, §7).
- A reserved send-now (`this.successor`) holds steers typed for it in memory
  only (`hosted-session.ts:3671-3681`) and seeds them into the new turn's queue
  at start (`:2780-2794`).
- `session/reclaim` (`session.ts:1486-1501`, `hosted-session.ts:1859-1868`) is
  the pattern to copy: keyed, idempotent, synchronous, persist then publish.

### Design

1. **Agent `Session` gets ids on its queue** (`packages/agent/src/session.ts`):
   `enqueue(text, voice?, id?)` stores `id` in a third parallel array (or one
   array of `{text, voice, id}` — executor's choice, `drainSteering` still
   returns `string[]` so `agent.ts` is untouched). New
   `unqueue(id): boolean` — synchronous; if `id` is in `steering`, splice it
   from all parallel arrays at the same index and return `true`; else `false`.
2. **`HostedSession.unqueue(ids): { removed: string[]; delivered: string[] }`**
   (`packages/daemon/src/hosted-session.ts`), synchronous, per id:
   - in the successor's `steers` (not yet started) → drop from `steers`, removed;
   - `session.unqueue(id) === true` → also filter the row out of `this.queue`
     **by id** (safe: an undrained row sits behind every drained one, so order
     and the head-shift on `steer` stay correct), removed;
   - otherwise (already drained / delivered / unknown / a send-now's own
     `messages`) → `delivered` (the client keeps showing what really happened).
   Then, if anything was removed: `persist()` then `publishQueue()` (the same
   order as `enqueue`/`reclaim`). Never throws `NoTurnRunning`: an unqueue after
   the turn ended is answered from the facts (the row is in `returned` → the
   client should `reclaim`; else `delivered`). Pass the id at the two other
   `session.enqueue` sites (restore `:1107`, successor seed `:2780-2794`) so
   every queued text is removable.
3. **Protocol** (`packages/protocol/src/session.ts`, `methods.ts`):
   `session/unqueue` — params `{ sessionId, ids: string[1..] }`, result
   `{ removed: string[]; delivered: string[] }`. Additive (a new method is free,
   v10 rule) → **no `protocol.d/` note**. Update the queue comment at
   `session.ts:594-600` ("Nothing else removes one" → "… or a
   `session/unqueue` of it").
4. **Client** (`packages/client/src/remote-client.ts`, `remote-session.ts`):
   `unqueue(ids)` like `reclaim` (`remote-client.ts:1676`), "keyed" call class.
   `MethodNotFound` from an older daemon → a typed "not supported" result, never
   a silent success.
5. **Edit = client composition**, not a daemon op: Edit tap → `unqueue([id])`;
   on `removed` the text goes to the composer; on `delivered` a notice ("already
   sent") and the field stays empty. ↑ = an ordinary `enqueue` (new id, tail of
   the queue). × = re-enqueue the original text (tail) — see Q2.
6. **UI scope**: see Q1. Logic in pure modules (`apps/mobile/src/compose-queue.ts`,
   `packages/tui/src/queued.ts`), components only render (§7).

### Files

`packages/agent/src/session.ts` → `packages/protocol/src/session.ts`,
`packages/protocol/src/methods.ts` (+ regenerated `schema/protocol.json` via
`bun run protocol:bump`, never by hand) → `packages/daemon/src/hosted-session.ts`,
`packages/daemon/src/connection.ts` → `packages/client/src/remote-client.ts`,
`packages/client/src/remote-session.ts` → (per Q1) `packages/cli/src/local-runtime.ts`,
`packages/tui/src/queued.ts` + key wiring, or none → `changelog.d/queue-unqueue.added.md`.
Mobile UI stays in `feat/mobile-queued-compose`.

### Failure modes

- **Race with the drain** (the core one): unqueue lands after `splice(0)` but
  before the `steer` event → `session.unqueue` is `false` → `delivered`; the
  mirror row leaves on its `steer` as today. Pinned by test T2.
- **Several texts in one drain, cancel the 2nd**: drained together → both
  `delivered`. Not drained → the mirror filter by id keeps the head-shift
  pairing right for the others (T3).
- **Turn ends / is cancelled meanwhile**: row moved to `returned` → `delivered`
  is wrong for it; answer it as a third bucket or let the client see it in
  `returned` and `reclaim` (Q3).
- **Reserved send-now**: a steer typed for it is removable until it starts; its
  `messages` (the send-now prompt) are not (→ `delivered`).
- **Retry / duplicate**: idempotent — a second unqueue of a removed id finds
  nothing → `delivered` would be a lie. Keep a small `unqueued` id set (like
  `enqueued`) so a retry answers `removed` again (T5).
- **Re-enqueue of the same id after an unqueue**: `enqueued.has(id)` makes it a
  silent no-op (`hosted-session.ts:3668`) — the client MUST use a fresh id for ↑
  (pinned client-side) — or Q4.
- **Restart between unqueue and next write**: `persist()` runs before return,
  same window as `enqueue`; the restored queue never resurrects it (T6).
- **Voice steer**: its voice mark is spliced with its text, so a cancelled voice
  steer never re-marks the turn (T4).
- **Multiple clients**: anyone holding the session token may unqueue any row (one
  principal, as `reclaim`); the other client sees the row leave via `queued`.
- **Older daemon**: `MethodNotFound` → UI says "this daemon can't cancel queued
  messages", row stays.
- **Pod daemon**: the pod is not trusted (§7) — unqueue only removes pending
  input, it creates no laptop-side effect; no gate needed.

### Tests

Red first: each fails on today's code (method missing / `Session.unqueue`
missing).
- **T1** agent `Session`: enqueue a,b,c (+ voice on b); `unqueue(b)` → true; the
  next drain returns `[a, c]` and no voice mark applies.
- **T2** daemon, scripted model (existing `HostedSession` fakes): drain happens,
  then unqueue before the `steer` reaches `drive` → `delivered`, and the next
  model request DOES contain the text (prove the property, not a correlate).
- **T3** enqueue a,b,c; unqueue b before the boundary → the next request has
  `[a, c]` and the `steer` events carry ids a, c (mirror pairing intact).
- **T4** voice steer cancelled → the turn stays a non-voice turn.
- **T5** retry idempotence; unknown id; empty turn; successor steer removable,
  successor `messages` not.
- **T6** persistence: unqueue then reload the sidecar → the row is absent from
  the restored queue.
- **T7** connection: `session/unqueue` round trip over `RemoteClient`; older
  daemon → `MethodNotFound` → typed unsupported.
- Non-vacuity (§9): mutate `HostedSession.unqueue` to check the mirror instead
  of `Session.steering` → T2 must fail.

### Owner questions

1. **UI scope of this branch** — protocol+daemon+client only, or also a TUI
   gesture? *Rec:* protocol+daemon+client + TUI "↑ on an empty input pulls the
   last queued message back to edit" (cheap parity, exercises the API end to
   end); phone UI stays in `feat/mobile-queued-compose`.
2. **Edit semantics** — unqueue at Edit tap (× re-queues at the tail, position
   lost) or keep it queued while editing and replace atomically on ↑ (risk: the
   old text is delivered while you edit)? *Rec:* unqueue at Edit tap — what you
   are editing is guaranteed not to reach the model.
3. **Unqueue of a row already moved to `returned`** (turn ended) — answer it as
   removed (drop it from `returned`, like `reclaim`) or report `delivered`? *Rec:*
   treat it as removed and drop it from `returned` — the person asked for it gone.
4. **Re-queue after edit** — always a fresh id, or allow re-using the id? *Rec:*
   fresh id (no change to the `enqueued` dedupe).
5. **Cancel confirmation on the phone** — immediate or "Undo" toast? *Rec:*
   immediate + a 5 s Undo that re-enqueues at the tail (client-only, no daemon
   change).

## Execution

*(empty — awaiting approval)*

## Review

*(empty)*
