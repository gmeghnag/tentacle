# fix/mobile-stream-lost-repeat — the "stream was lost" notice stacks and survives completed turns

> **Status:** implementation approved (owner 21/11: Q1 = ship both slices now)
> **Branch:** `fix/mobile-stream-lost-repeat`
> **Size:** S · **Blast:** contained · **Suited:** DeepSeek executes; standard in-context Review
> **Changelog:** `changelog.d/mobile-stream-lost-repeat.fixed.md`

Type: fix · Size: S · Blast: contained (re-rated from the TODO's `cross-module`:
the fix touches only the app's pure fold + its trace, no client/protocol/daemon
code) · Suited: DeepSeek exec, standard Review.

## Context

*— claude-opus-5-5, 2026-11-21*

**Symptom (owner, 2026-11-20, phone → relay → the `~/assistant` serve on :4001):**
the notice `that turn's stream was lost — what reached the phone is shown`
appears REPEATEDLY — three stacked, and again below a normal reply — although
the turns complete.

**Where the notice comes from (verified):**
- the text is `TURN_LOST_NOTICE`, `apps/mobile/src/transcript.ts:179`; it is
  pushed by `endTurn` (`transcript.ts:337-345`) for a `turn_ended` input whose
  outcome is `lost` (`outcomeNotice`, `transcript.ts:356-363`);
- `lost` is decided ONLY by `turnOutcome({threw: true})`
  (`apps/mobile/src/session-feed.ts:55-58`), i.e. the turn's event stream
  THREW: `foldStream`'s `catch` (`session-feed.ts:273-280`) — for an own send
  and for every foreign `turn` activity alike;
- `endTurn` appends unconditionally. It has no notion of which turn the notice
  is about, so (a) N throws give N stacked rows, and (b) when the SAME turn is
  then seen completing (a later foreign bracket for that `turnId` after a
  re-attach, which the client opens for a turn still running at attach —
  `session-feed.ts:322-329`) the notice stays above/below the full reply;
- the only thing that ever removes it is a full history REPLACE
  (`withHistory`, `transcript.ts:398-410`: rows rebuilt from the daemon's
  messages; notices are not messages). So notices accumulate between two
  resyncs — a foreground return / pull / reconnect-with-gap wipes them, a
  clean reconnect (replay with `since`) does not.

**Trigger — NOT reproduced (honest).** I could not make the client's stream
throw while the daemon's turn completes. Five rounds of a real in-process
daemon + the phone's `RemoteClient` + `createSessionController` +
`createSessionFeed` (the `apps/mobile/test/session-link.test.ts` pattern), all
GREEN (outcome `ended`/`interrupted`, zero `lost`):

| # | scenario | phone trace |
|---|---|---|
| A/B | own / foreign turn, link drop mid-turn, reconnect, turn completes | `turn-end ended` |
| F/I | own / foreign turn completes WHILE the link is down | `turn-end ended` |
| H | drop right after `session/prompt` (before any frame) | `turn-end ended` |
| K | drop on the 1st / 2nd inbound frame after `session/prompt` (the ack in flight) | `turn-end ended` |
| C/D | foreground resync (`leave` + `open`) mid own / foreign turn | foreign: `interrupted` then a new bracket `ended`; own: see *collateral* |
| J | drop + resync fired at link-up (+0/5/30 ms), racing the client's own re-attach | same as C/D |
| E/G | idle drops ×3 after a completed turn; resync, 3 drops, another own turn | no turn-end at all |
| K' | (instrumentation bug) a ~200× reconnect storm re-dropping every re-sent prompt | still no `lost` |
| M | one known update with a malformed payload (`text.delta: 42`) | `ended` (my mutation did not hit a live update frame — inconclusive) |

So the in-memory transport path (drop, redial, `recovered` re-send, resync,
racing resync) never yields `lost`. What remains and is NOT covered by this
harness: (1) the relay itself (a half-open leg: the daemon side may keep the
old `Connection` while the phone redials — `serve.log` shows 5
`device-open`/`connection-close` pairs since 11:06 today, and the relay
restart at 10:36 dropped every leg); (2) version skew — the phone runs the iOS
build of 2026-11-20 12:18 (`3628eb28`), the serve ran a later `~/bin/tentacle`
(now `0.7.1+bfcfa4555fd8`): a frame the older phone schema rejects is
`classifyUpdate → error` (`packages/client/src/mapping.ts:87-103`) →
`RemoteSession.output` `case "error"` → `failAll`
(`packages/client/src/remote-session.ts:2041-2055`) → every tracked stream
throws → LOST, while the daemon's turn goes on (`git diff 3628eb28 HEAD --
packages/protocol/src` shows only additive optional fields, so no concrete
offending frame is identified); (3) iOS suspension (the foreground gate holds
the socket; JS frozen for minutes). The phone's app log cannot settle it: the
queue trace records `turn-end outcome=lost` but NOT the error that made the
stream throw (`apps/mobile/src/queue-trace.ts:147-151`; `foldStream`'s catch
drops the cause on the floor for the trace).

**Daemon-side evidence (read-only):**
`~/.config/tentacle/daemon/assistant-90d61226d0ae/ab22bf1c-….jsonl` shows the
turns complete cleanly (`turn_end stopReason end_turn` at seq 335 and 387,
each followed by a checkpoint); the one failed turn (seq 329,
`stopReason error`) is the model being unreachable, which the phone shows as a
`failed` notice, not this one. A `tentacle connect` TUI has been attached to
the same serve since 2026-11-20 13:46 — so the phone sees FOREIGN brackets too
(and two clients raise turns on one session).

**Magnitude (why 3).** One `lost` row per stream that threw, with no dedupe:
three throws (three brackets — e.g. three re-subscriptions of a running turn,
or three turns in a row) ⇒ three rows. Which of the two it was on 20/11 is
exactly what the app log export would tell (its `turn-start` lines carry the
turn's short id).

**Collateral found on the way (not this bug's cause, recorded):** a resync
(`leave` + `open`) during an OWN turn leaves the old own bracket's stream
open for ever — the trace shows `turn-start own:true` with no `turn-end`,
then a foreign bracket for the SAME `turnId` (scenarios C/G/J own). The
detached `RemoteSession` never ends or fails that turn (`detach`,
`remote-session.ts:1400-1428`, closes only `this.foreign`). Its fold is
harmless today (no further events), but it is a leaked bracket; see Notes.

**Repro (red, pure fold) — `.tentacle/tmp/mobile-stream-lost-repeat/fold.test.ts`, 2026-11-21:**

```ts
import { expect, test } from "bun:test";
import { TURN_LOST_NOTICE, apply, initialState, type State } from "../../../apps/mobile/src/transcript.ts";
const lost = (s: State) => s.rows.filter((r: any) => r.kind === "notice" && r.text === TURN_LOST_NOTICE).length;
test("one turn, its stream lost 3× (re-subscribed each reconnect), then completed: today 3 notices", () => {
  let s = initialState;
  for (let i = 0; i < 3; i++) {
    s = apply(s, { type: "turn_started", turnId: "T", own: i === 0 } as any);
    if (i === 0) s = apply(s, { type: "text", delta: "partial " } as any);
    s = apply(s, { type: "turn_ended", outcome: "lost" } as any);
  }
  s = apply(s, { type: "turn_started", turnId: "T", own: false } as any);
  s = apply(s, { type: "text", delta: "full reply" } as any);
  s = apply(s, { type: "turn_ended", outcome: "ended" } as any);
  expect(lost(s)).toBe(0); // design: the turn completed and the phone has the full reply
});
test("two different turns lost back-to-back, no completion seen: today 2 stacked notices", () => {
  let s = initialState;
  for (const id of ["A", "B"]) {
    s = apply(s, { type: "turn_started", turnId: id, own: false } as any);
    s = apply(s, { type: "turn_ended", outcome: "lost" } as any);
  }
  expect(lost(s)).toBe(1); // design: never stacked
});
```

```
$ bun test ./.tentacle/tmp/mobile-stream-lost-repeat/fold.test.ts
assistant:partial
notice:that turn's stream was lost — what reached the phone is shown
notice:that turn's stream was lost — what reached the phone is shown
notice:that turn's stream was lost — what reached the phone is shown
assistant:full reply
error: expect(received).toBe(expected)  Expected: 0  Received: 3
error: expect(received).toBe(expected)  Expected: 1  Received: 2
 0 pass  2 fail
```

The transport-level harness (`repro.test.ts`, same folder, ~150 lines: real
`SessionHost` + `Connection` + `createChannelPair`, a gated model, a phone
`RemoteClient` whose channel can be dropped / dropped on the Nth inbound frame
after `session/prompt` / have one update corrupted) stays green in every
scenario above; it is the base for a device-faithful repro once the cause is
known.

## Implementation

*— claude-opus-5-5, 2026-11-21*

Two slices in one branch: **(1)** the fold's rule (the owner-visible fix,
correct whatever throws the stream), **(2)** the cause in the trace (so the
next occurrence on the device names its trigger). The trigger itself is a
follow-up once (2) has a capture — see Q1.

### Load-bearing assumption

At `turn_ended`, the fold knows WHICH turn ended: `state.turn` is the open
bracket with its `turnId` (`transcript.ts:328-334` `startTurn`; `endTurn`
reads `state` before clearing it, `transcript.ts:340`). Verified: every
`turn_ended` comes from `foldStream.finish` (`session-feed.ts:241-244`), which
always follows its own `turn_started` (`session-feed.ts:189`). (Caveat, see
failure modes: the transcript holds ONE bracket; two overlapping brackets —
the leaked own bracket of the collateral — would make `state.turn` the later
one. The rule must therefore degrade to "no retraction", never to a wrong one.)

### Preconditions

- `lost` only ever comes from a stream that threw (`session-feed.ts:55-58`).
- A later bracket for the same `turnId` that ends `ended`/`cancelled` means
  the daemon's end arrived through a live subscription that replayed from the
  resync cut (`since`) — so the phone has the reply; a gap that cannot be
  replayed becomes a history REPLACE, which already drops every notice
  (`transcript.ts:398-410`).
- Notices are not persisted; a reload rebuilds from the log (no migration).

### Design

Pure, in `transcript.ts` (React-free, AGENTS §7):

1. **The notice knows its turns.** A LOST notice row carries
   `lostTurns: readonly string[]` (the `turnId`s whose streams threw) — a
   fold-only field; the notice's text, level and rendering are unchanged.
2. **Never stacked.** At `turn_ended{lost}` with open bracket `T`:
   - if a LOST notice already lists `T` → no new row (re-subscription of the
     same turn);
   - else if the LAST row is a LOST notice → add `T` to it (two different
     turns lost back-to-back read as one line);
   - else push a new LOST notice `{lostTurns: [T]}`.
3. **Retracted when the turn is known to have completed.** At
   `turn_ended{ended|cancelled}` with open bracket `T`: drop `T` from every
   LOST notice's `lostTurns`; a notice left with none is removed. `failed` /
   `interrupted` do not retract (the turn did not complete for the phone).
4. **No turn id ⇒ today's behaviour.** A bracket without `turnId` (none exist
   today, but the type allows `turn: null`) keeps the plain notice, never
   merged nor retracted — a guess must not delete a real loss.

Trace (slice 2): `TurnEndFacts.threw` gains the error's **class** — `error.name`
plus `RpcError.code` when present, plus the message truncated + `redact`ed
(`app-log.ts:119`, `DETAIL_MAX`) — carried to the `turn-end` trace event as
`cause`, written by `queue-trace.ts` on `outcome=lost` only. No secrets: the
message goes through the existing `redact`.

### Files

1. `apps/mobile/src/transcript.ts` — `Row` notice variant gets optional
   `lostTurns`; `endTurn` implements rules 2–4 (a small pure helper
   `foldLostNotice(state, turnId, outcome)`).
2. `apps/mobile/src/session-feed.ts` — `finish({ended:false, threw:true,
   cause})` from the `catch`; `turn-end` trace gets `cause`.
3. `apps/mobile/src/queue-trace.ts` — the `turn-end` event's optional `cause`
   field (logged on `lost`).
4. Tests: `apps/mobile/test/transcript.test.ts`,
   `apps/mobile/test/session-feed.test.ts`, `apps/mobile/test/queue-trace*.test.ts`
   (whichever pins `turn-end` today).
5. `changelog.d/mobile-stream-lost-repeat.fixed.md` — one bullet.

### Failure modes

- **Relay drop mid-turn, replayed reconnect:** the old stream throws → one
  notice `[T]`; the client re-attaches, a foreign bracket `T` streams the rest
  and ends `ended` → retracted. Phone has the full reply, no notice. ✔
- **Reconnect storm (N throws for one turn):** one notice (rule 2a), retracted
  at completion. ✔
- **Daemon restart mid-turn (serve reload, `recovered{recreated}`/turn re-run
  per `docs/feat/suspended-turn-resume.md`):** the turn's end, if any, arrives
  under the same `turnId` → retracted; if the daemon closes it as cut
  (`interrupted`) → the notice stays, which is honest. ✔
- **Foreground/background:** a return runs a resync = history REPLACE → all
  notices go (unchanged); the turn still running reopens as a foreign bracket
  and ends normally. ✔
- **Two phones / phone + laptop TUI:** brackets are per-client streams; the
  rule is per `turnId`, so another device's turn never retracts this one's
  loss unless it is the same turn. ✔
- **Turn really lost (daemon died, never ends):** no completion ever seen →
  the notice stays (one row). ✔
- **Two different turns lost, a reply between them:** the reply row breaks
  adjacency → two notices, each about a different real loss — allowed ("never
  stacked" = never two in a row). ✔
- **Overlapping brackets (the collateral's leaked own bracket):** `state.turn`
  is the newer bracket; a retraction keyed on it can only remove a notice for
  THAT turnId — never another turn's. Worst case: a notice not retracted
  (today's behaviour). ✔
- **A `turn_ended` with no open bracket:** no `turnId` → rule 4. ✔

### Tests (red first, then mutation)

All in the pure modules (fast, deterministic), copied from the repro above:

- T1 lost×3 same turn then completed → 0 notices (red today: 3).
- T2 lost A, lost B adjacent → 1 notice listing both (red today: 2).
- T3 lost A, assistant row, lost B → 2 notices (stays green — the boundary).
- T4 lost T then a bracket T ends `interrupted` / `failed` → the notice stays.
- T5 lost T, then a DIFFERENT turn U ends `ended` → the notice stays.
- T6 lost T then history replace → none (green today; pins the existing rule).
- T7 `session-feed`: a stream that throws `RpcError(code X, "msg")` → the
  trace's `turn-end` carries `cause` with `X` and the redacted message; a clean
  end carries none.
- **Mutations** (each must turn a test red, then revert): drop rule 2a (T1
  red), drop rule 2b (T2 red), retract on any `turn_ended` regardless of id
  (T5 red), retract on `interrupted` too (T4 red).

Gate: `bun run check` green (lint baseline clean).

### Owner questions

**Q1 — ship the fold rule before the trigger is proven?** The rule (one
notice per real loss, gone once the phone sees the turn complete) is correct
whatever makes the stream throw, but it also HIDES that throw from the person
when the turn later completes — the cause would then live only in the app log
(slice 2). Alternative: diagnose first (ship only slice 2, wait for a device
capture), fix after. **Recommendation: ship both now** — the stacked notices
are the owner-visible defect, and slice 2 makes the next occurrence
self-explaining; the trigger hunt continues as a follow-up from the capture.

**Owner decision 2026-11-21:** ship both slices now (fold rule + app log of the drop error).

## Execution

*(empty — to be filled by the executor)*

## Review

*(empty)*

### Notes / debt

- **Trigger follow-up:** after one device capture with `cause` (slice 2), open
  the trigger fix where it lives (client `failAll` on an `error` frame, relay
  half-open leg, or the outbox). An app-log export of 2026-11-20 would already
  tell whether the 3 notices were ONE `turnId` (re-subscriptions) or three
  turns — worth asking for, not blocking.
- **Leaked own bracket on resync mid own turn** (Context, collateral): the
  detached `RemoteSession` should end its own active turn without outcome on
  `detach` (as it does `this.foreign`), or the screen should not resync over a
  running own turn. Separate small fix (client, cross-module) — not bundled.
