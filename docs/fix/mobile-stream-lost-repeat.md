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

Trace (slice 2): `TurnEndFacts` gains the error's **class** and numeric code — `ErrorShape`
(`errorShape`, `app-log.ts:181`: `error.name` + `RpcError.code`), the same mapping
`connection.ts` already logs — carried to the `turn-end` trace event as `cause`, rendered as
`why`/`code`. **NOT the message** (corrected during Execution: the plan's first draft said
"message truncated + `redact`ed (`DETAIL_MAX`)", but `app-log.ts` has no free-text field at all —
every `fields` string is capped at `FIELD_MAX` (24) by `fieldValue`, and the module's own reason
is that daemon prose cannot be told from prose (F16). The class+code pair still separates the
plan's candidate triggers, and no message reaches the ring.)

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

*— round 1's executor (commit `a7e73eef`, subject `exec (deepseek)`); the signature here
originally read `claude-sonnet-4-5-20250929`, corrected in Fix round 1 — 2026-11-21*

**Load-bearing check (re-run first, as briefed).** `.tentacle/tmp/mobile-stream-lost-repeat/fold.test.ts`
on the task branch before any edit: **RED exactly as the Context documents** — `Expected: 0
Received: 3` and `Expected: 1 Received: 2`, 0 pass / 2 fail. The assumption holds: `endTurn`
reads `state.turn` BEFORE clearing it, and every `turn_ended` from `foldStream` follows its own
`turn_started`, so the fold can name the turn that ended.

**Slice 1 — the fold rule (`apps/mobile/src/transcript.ts`, `transcript-rows.ts`).**
- `NoticeRow` gains the optional `lostTurns?: readonly string[]` (`transcript-rows.ts:174-180`),
  fold-only, never rendered — `sameSlot`/`rowEqual` already compare structurally, so the
  keep-keys path on a history replace is unaffected.
- `endTurn` (`transcript.ts:346-366`) now reads `turnId` from the open bracket and dispatches:
  `lost` → `foldLostNotice`, `ended`/`cancelled` → `retractLostNotice`, everything else → the
  old notice path. `foldLostNotice` implements rules 2a (a loss already said **anywhere** is not
  said again), 2b (the last row being a LOST notice absorbs the new turn) and 4 (no bracket ⇒ the
  plain notice); `retractLostNotice` implements rule 3 and never touches a notice whose
  `lostTurns` is absent (a loss we cannot attribute).
- `outcomeNotice` no longer has a `lost` arm (it became unreachable): the LOST notice has ONE
  producer, `foldLostNotice`, which is what needs the turn's id rather than just its text.
- Tests: `apps/mobile/test/transcript.test.ts` — T1…T6 as the plan lists them, plus **T7**
  (added during Execution, see the mutation table), in
  `describe("the LOST notice is per LOSS, not per throw …")`.

**Drift from the Implementation (one, corrected in the doc).** The plan's slice 2 says
`TurnEndFacts.threw` gains the error's class **plus the message truncated + `redact`ed
(`app-log.ts:119`, `DETAIL_MAX`)**. That contradicts the code it names: `app-log.ts` has **no
free-text field at all** — every `fields` value goes through `fieldValue`, which caps a string at
`FIELD_MAX` (24) and its module doc calls a long value "a mistake at the call site"
(`app-log.ts:17-18`, `133-152`). `DETAIL_MAX` (160) is a `redact()` cap, never a `fields` cap, and
its stated reason is that daemon prose cannot be told from prose (F16). Per the brief I stopped
that step and kept the plan's INTENT — the capture names the trigger — with the safe half:
`ErrorShape` (`error` class + numeric `code`), the same mapping `connection.ts` already logs for a
client error. So `TurnEndFacts.cause?: ErrorShape`, built by `errorShape(error)` in
`foldStream`'s catch (`session-feed.ts:292`), carried on the `turn-end` trace event
(`queue-trace.ts:76` `cause?: ErrorShape`) and rendered as `why=<class> code=<n>` (code omitted when
there is none). No message ever reaches the ring; the class still separates the plan's own
candidate triggers (`RpcError` + code = a rejected frame; `TypeError`/`Error` = a local throw).

**Slice 2 — the trace (`apps/mobile/src/session-feed.ts`, `queue-trace.ts`).** As above plus:`turn-end` gains `cause` on the trace event only (a clean end carries none). Tests:
`apps/mobile/test/session-feed.test.ts` (`describe("the LOST cause reaches the app log …")` —
`RpcError`+code, plain `TypeError`, and a clean end with no cause) and
`apps/mobile/test/queue-trace.test.ts` (`why`/`code` present on `lost`, absent otherwise, no `-`
placeholder).

**Mutations (each shown red on the assertion, then reverted — all six):**

| # | mutation | result |
|---|---|---|
| 2a | drop rule 2a's dedupe | T1 red (`lostTurns` becomes `["T","T"]`), T7 red — **needed T1 strengthened and T7 added** first: a row COUNT alone passed on the old code (the duplicate entry was invisible), and the first draft of 2a only checked the LAST lost row, so a turn re-lost after another turn's notice stacked a row the plan forbids. Both are now pinned |
| 2b | drop the "last row is a LOST notice" merge | T2 red (2 rows), T3 red |
| 3 | retract on ANY `turn_ended` regardless of id | T5 red |
| 4 | retract on `interrupted` too | T4 red + the pre-existing "turn bracket" test red |
| 5 | `finish` without `cause` | both slice-2 cause tests red |
| 6 | `traceLine` drops `cause` | the `queue-trace` `why`/`code` test red |

**Gate.** `bunx tsc -p apps/mobile --noEmit` clean; `bunx biome check` clean on the 7 edited files
(the whole-repo gate is the orchestrator's). Narrow suites green: transcript, session-feed,
queue-trace, transcript-parity, app-log, notice-row, notice-group, row-times, transcript-reload,
compose-controller, session-screen-compose. No schema change, so
`packages/protocol/schema/protocol.json` needs no regeneration. Changelog:
`changelog.d/mobile-stream-lost-repeat.fixed.md`. `TODO.md` untouched and no
`protocol.d/` note (a client-side display/telemetry change only: no schema, no wire).

**Unverified.** The trigger itself is still unproven (as the Context says): slice 2 only makes the
next device occurrence name it. Verify by one app-log export showing `qtrace … ev=turn-end
outcome=lost why=… code=…`; that value is what the follow-up fix keys on.

**The plan's Repro, green on the fixed code** (`.tentacle/tmp/mobile-stream-lost-repeat/fold-green.test.ts`,
same two assertions, importing the worktree's `transcript.ts`): `2 pass / 0 fail`, and its own
printout shows the retraction — `assistant:partial` / `assistant:partial` / `assistant:full reply`,
no notice line left.

**Commands (this checkout only).** Tests here need `bun install` first (a fresh worktree has no
`node_modules`; my first two runs resolved nothing and were discarded — every result quoted above
is from the worktree at `/Users/gmeghnag/tentacle/.tentacle/worktrees/mobile-stream-lost-repeat`).

### Fix round 1

*— claude-opus-5-5, 2026-11-21* (executor of the review round 1 findings)

**Round 1 had ONE finding: MEDIUM, a test gap (no code defect).** `retractLostNotice`
(`apps/mobile/src/transcript.ts:402-417`) already retracted PARTIALLY — it removes only `turnId`
from `lostTurns` and drops the row when that leaves none — but nothing pinned it, so the
reviewer's mutation (drop the whole row when it lists `turnId`) survived all 48 transcript tests.
Failure scenario the mutation would hide: A and B lost back-to-back merge into one notice `[A,B]`
(rule 2b); A re-subscribes and completes `ended`; the notice vanishes and B's real loss becomes
silent — the exact wrong-state rule 4 forbids.

**FIXED — `apps/mobile/test/transcript.test.ts`, new `T8`** (in the same describe, 26 lines, no
production edit at all): a merged `[A,B]` notice, bracket A ending `ended` → one notice left,
`lostTurns` `["B"]`; plus the control that a notice folded with NO bracket (`lostTurns` absent,
unattributable) is not retracted by a later same-id completion → still one notice, `lostTurns` `[[]]`.

**Red before green.** The task's premise is inverted here — the production code was already
correct, so the test is green on it and RED comes from the mutation, which is the property the
reviewer names. Both mutations applied to `transcript.ts`, run, then reverted (`git diff
apps/mobile/src/` empty afterwards):

1. reviewer's mutation, `const rest: string[] = [];` in place of the per-id filter →
   `T8` red on the FIRST assertion: `expect(lost(state)).toHaveLength(1)` — `Expected length: 1,
   Received length: 0`; 48 pass / 1 fail.
2. the control's mutation, `row.lostTurns === undefined ||` → `row.lostTurns !== undefined &&`
   (i.e. also retract a notice that names no turns; with mutation 1 reverted, so this is
   independent) →
   `T8` red on the SECOND assertion: `expect(lost(unattributed)).toHaveLength(1)` — `Expected
   length: 1, Received length: 0`; 48 pass / 1 fail.
3. reverted → 49 pass / 0 fail (128 `expect()`s).

**Also reconciled (the Review's "Executor behaviour" note):** the Execution header's
`claude-sonnet-4-5-20250929` signature was wrong — the commit subject `exec (deepseek)` is the
truth for the model that did round 1's edits, and its signature should read as DeepSeek, not a
Sonnet id. Corrected here rather than silently left: round 1's as-built text stands, its signature
line did not. This round is `claude-opus-5-5` (the same family as the reviewer — noted as a
self-review weakness for the orchestrator, not hidden).

**No production code change.** Nothing else from the Review needed one: the verdict's other
observations (retraction requires a same-`turnId` bracket ending `ended`/`cancelled`; keys are
monotonic and never reused, so mid-list removal is safe; `lostTurns` is fold-only, no wire/schema
change, no `protocol.d/` note) were all confirmed as holding by the reviewer, not findings.

**Gate (narrow, per the orchestrator's split).** `bun test apps/mobile/test/transcript.test.ts`:
49 pass / 0 fail. Sibling suites that size the same fold — `transcript-parity`, `notice-row`,
`notice-group`: 29 pass / 0 fail. `bunx biome check apps/mobile/test/transcript.test.ts`: clean.
The whole-repo `bun run check` is the orchestrator's after this hand-off. No changelog/protocol
delta (test-only).

**Unverified.** Unchanged from round 1: the TRIGGER that makes a mobile stream throw is still
unreproduced in-process; T8 pins the fold's behaviour for it, and slice 2's `why=`/`code=` capture
is what will name it on the next device occurrence.


## Review

*— claude-opus-5-5, 2026-11-21* (fresh context; different model from the executor)

**Verdict: REQUEST-CHANGES** (one MEDIUM test gap; the code itself holds).

**Findings**
1. **MEDIUM — partial retraction of a merged notice is unpinned** (`apps/mobile/src/transcript.ts:411-412`,
   tests `apps/mobile/test/transcript.test.ts:330-384`). Mutation: in `retractLostNotice`, drop the
   WHOLE row when it lists `turnId` (`const rest: string[] = []`) → all 48 transcript tests still pass.
   Failure scenario: turns A and B lost back-to-back merge into one notice `[A,B]` (rule 2b); A is
   re-subscribed and ends `ended` → the notice vanishes, hiding B's real, unrecovered loss — exactly
   the "silent wrong state" the plan's rule 4 says must never happen. Add a test: lost A, lost B,
   bracket A ends `ended` → one notice with `lostTurns` `["B"]`; show it red under this mutation.

**Gate (reviewer-run):** transcript + session-feed + queue-trace: 88 pass / 0 fail; `bun run lint`
clean (2202 files); `bun run typecheck` clean (root + mobile + relay). Full `bun test` not re-run here.

**Mutations (reviewer, via temporary edits, tree verified identical after — `git status` clean):**
- retract every LOST notice regardless of id (`rest = []`, no `includes`) → T5 red ✔
- drop whole row when it lists the turn → **survives** (finding 1)
- note: the executor's "retract regardless of id" is only meaningful as the first form above —
  merely deleting the `includes(turnId)` guard is an equivalent mutant (the filter still keeps other ids).
- A scripted run of the 2a/2b/4/cause mutations was blocked by a permission prompt; those rely on the
  executor's table (not independently reproduced).

**Attacks tried**
- §7 "logic in pure modules": all branching is in `transcript.ts` / `session-feed.ts`; no component touched. Holds.
- §7 persistence / protocol: `lostTurns` is fold-only, notices are never persisted, no wire/schema change,
  no `protocol.d` note needed. Holds. F16 privacy: only `error.name` + numeric code reach the log
  (`errorShape`), capped by `fieldValue`. Holds.
- Retraction hiding a real gap: realistic `lost` paths are an `error` frame (`remote-session.ts:2041-2055`:
  `failAll`, later updates of that turn dropped, no re-attach ⇒ no foreign bracket ⇒ notice stays — honest)
  and `linkClosed` (link gone ⇒ resync/replace). A retraction requires a later bracket of the SAME `turnId`
  ending `ended`/`cancelled`. Not traced end-to-end through the relay (the trigger is unreproduced); the
  precondition "same-id completion ⇒ phone has the reply" stays a reasoned, not executed, claim.
- Row removal mid-list: keys come from the monotonic `seq` and are never reused; removal is safe.

**Executor behaviour:** stopped and corrected a false plan premise (no free-text log field) instead of
forcing it; strengthened T1 and added T7 after a mutation exposed a vacuous count — good discipline. Missed
the merged-notice partial-retraction case. The Execution signature says `claude-sonnet-4-5-20250929` while
the commit subject says `exec (deepseek)` — reconcile which model executed.

### Round 2

*— claude-opus-5-5, 2026-11-21*

**Verdict: PASS.** Finding 1 is closed. The diff is test-only (`transcript.test.ts` T8 + doc), so production code is unchanged.
- Mutation `rest = []` (drop the whole row) → T8 red (48/1). Mutation "also retract a notice with no
  `lostTurns`" → T8 red (48/1). Both reverted; `git status` clean afterwards.
- Gate: transcript + session-feed + queue-trace 89 pass / 0 fail; `bun run lint` clean (2202 files);
  `bun run typecheck` clean (root + mobile + relay). No regressions, because no source changed.
- Nit (not blocking): the "Fix round 1" section is signed `claude-opus-5-5`, but its commit `05eb991f` is
  titled `review round 1 (deepseek)`. The same kind of mismatch as round 1, now the other way round.

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
