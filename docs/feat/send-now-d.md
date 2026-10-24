# feat/send-now-d — TUI: queue while `/compact` runs; send-now cancels the compaction (D3c)

> **Status:** implementation (plan approved by the orchestrator 2026-10-23 — S · contained, owner rule)
> **Branch:** `feat/send-now-d` (off `main` **after `feat/send-now-c` is merged**)
> **Type:** feat · **Size:** S · **Blast:** contained (`App.tsx` `/compact` branch + the pure row/plan modules from c; no protocol, daemon or client change: a and b already accept `interrupt:{kind:"compaction"}`) · **Suited:** a weaker model may execute; standard in-context Review

Parent decision record: `docs/eval/send-now.md`, **D3c (confirmed by the
owner 2026-10-22)**: while `/compact` runs the TUI queues locally. Send-now
cancels the compaction and sends the queue. If the user does not press it,
the compaction-time queue is sent as **one D1-joined prompt when the
compaction ends, on success or failure**. This is the eval's slice C,
renamed d because the eval's A was split into a + b.

## Context

*— claude-opus-5-5, 2026-10-23*

**Why.** Today the TUI has no queue during a compaction. `/compact` is
refused while `running` and is otherwise fire-and-forget, with no signal
(`tui/src/App.tsx:573-588`). While it runs the TUI is not `running`, so Enter
starts a `prompt` that the daemon rejects with `CompactInProgress`
(`daemon/src/hosted-session.ts:736-742`). Esc does nothing (it requires
`running`, `App.tsx:897`). D3's "cancel `/compact` and send" is unreachable
without this task.

**Premises re-verified on `main` @ `be75584`:**
- `RemoteSession.compact()` → `RemoteClient.compact`, a `"once"` call, not
  re-sent after a drop (`client/src/remote-session.ts:96-101`,
  `client/src/remote-client.ts:485-490`).
- The daemon's `cancel()` aborts a compaction too (`hosted-session.ts:928-930`).
  `compact` then rejects `Cancelled`, with history untouched or fully
  replaced (`hosted-session.ts:882-888`, `agent/src/session.ts:151-162`).
- a: `send_now{interrupt:{kind:"compaction"}}` reserves the successor while
  `compacting` and starts it in `compact`'s `finally`. b:
  `sendNow(messages, "compaction", signal)`. c: rows (`queued.ts`), the chord,
  `planSendNow`, `runStream`.

**Repro (capability missing)**, 2026-10-23: in the existing TUI harness, a
fake controller whose `compact()` never settles. `/compact`, then type `hi` +
Enter → `send("hi")` is called at once, where it should be queued (the
executor writes this as T-D1, red on `main`).

## Implementation

*— claude-opus-5-5, 2026-10-23*

### Load-bearing assumption

**The TUI knows exactly when a compaction it started has settled:
`session.compact()`'s promise settles once, success or failure.** That is the
trigger for both the auto-send and for clearing the flag
(`App.tsx:584-587`; `remote-client.ts:485-490` returns the request's promise).
Proof by T-D2/T-D3 (a fake `compact` that the test resolves or rejects).

### Preconditions

- c is merged: the rows model, the chord, and the `planSendNow` /
  `onSendNowError` pure modules.
- A compaction started by **another** client is invisible to this TUI (no
  update says "compacting"). This task covers only this TUI's own
  `/compact`. Another device's compaction still gives `CompactInProgress` on
  Enter (unchanged, out of scope).

### Design

- `compactingRef` (+ a render flag): set when `/compact` is sent, cleared in
  the promise's `finally`.
- **Enter while compacting** → a local row `{id: randomUUID(), text}` in the
  same `queued.ts` model. There is no `enqueue`, because no turn is running.
  Rows render while `running || compacting` (the `:1167` condition).
- **Chord while compacting** → `planSendNow` with
  `target: "compaction"` → `ctrl.sendNow(rows, "compaction", signal)`. The
  compaction rejects `Cancelled`, and the compaction notice reads
  "_Compaction cancelled — sending now._" (not "Compact failed"). The
  successor streams via `runStream` (c). On reject, c's `onSendNowError`
  applies, with one addition: on `MethodNotFound` the fallback here is
  `session/cancel` (the existing abort path aborts the compaction
  daemon-side) and the settle hook below sends the text.
- **Compaction settles with rows left, and no send-now** (D3c): send them as
  **one** prompt, `run(join(rows))` (D1), after the compaction's own notice.
  Success or failure alike: the only option that loses nothing.
- Esc / Ctrl+C during a compaction: unchanged (not decided; out of scope).

### Files

1. `packages/tui/src/send-now.ts`: `planSendNow` gains the `compacting` input / `"compaction"` target.
2. `packages/tui/src/App.tsx`: `/compact` branch (`:573-588`), Enter routing (`:703-723`), the render condition (`:1167`).

### Failure modes

| Case | Convergence |
|---|---|
| Compaction succeeds, rows queued | One joined prompt on the compacted history. T-D2. |
| Compaction fails, rows queued | Same, on the old history. T-D3. |
| Send-now during the compaction | Compaction `Cancelled`, then the successor turn with the rows. T-D4. |
| Old daemon | `MethodNotFound` → `session/cancel` → the compaction rejects → the settle hook sends the joined rows. One notice (c's latch). |
| `sendNow` rejects `TurnInProgress` (the compaction ended and another client's turn took the slot) | c's `restore` puts the texts back in the input field. |
| Link drops mid-compaction (`"once"`, rejects) | The settle hook still sends the rows. If the session is gone, that send fails visibly and the text goes back to the input field (c's restore on a failed prompt). |
| Empty rows when it settles | Nothing is sent. |

### Tests

`tui/test/queue.test.tsx`, with a fake controller whose `compact` the test
settles:
- **T-D1** `/compact`, then Enter `"hi"` → no `send`, one queued row. Red on
  `main`.
- **T-D2** rows `"A"`, `"B"`, then compact resolves → exactly one
  `send("A\n\nB")`.
- T-D3 the same with compact rejecting.
- **T-D4** rows + chord → `sendNow([...], "compaction", …)`. When compact
  rejects `Cancelled`, the settle hook does **not** also send (mutation: drop
  that guard → two prompts, red).
- `send-now.test.ts`: the `compacting` rows of the plan table.
- Gate: `bun run check`, lint baseline clean.

## Execution

*— claude-opus-5-5, 2026-10-24*

**Baseline** (`main` @ `6cc4a2e` + the untracked plan): `bun run check` →
typecheck clean, lint `Checked 418 files … No fixes applied`, **2150 pass / 2
skip / 0 fail** (2152 tests, 175 files).

### Premises re-verified (after 4c)

- `RemoteSession.sendNow(…, "compaction")` with no live turn **installs** the
  new turn synchronously (`client/src/remote-session.ts:206-238`: `current`
  is null during a compaction → `install(turn)` sets `turnId`), so an
  `enqueue` after the chord binds to the reserved turn; the daemon keeps it
  as that turn's steer (`daemon/src/hosted-session.ts:1147-1156`, addendum
  item 11). Holds.
- Daemon `sendNow{compaction}`: while `compacting` it reserves + aborts
  (`hosted-session.ts:855-862`); if the compaction already ended it decides
  itself (idle → a turn with the undelivered texts, `:864-878`). The TUI
  never guesses. Holds.
- `compact` rejects `Cancelled` when aborted (`hosted-session.ts:1196-1199`);
  the successor starts in its `finally` (`:1214`). Holds.
- **Does NOT hold:** the plan's `MethodNotFound` fallback ("`session/cancel`,
  the existing abort path aborts the compaction daemon-side"). The TUI has no
  abort path for a compaction: `App` calls `session.compact()` with no
  signal, and the remote stack drops one anyway
  (`cli/src/local-runtime.ts:170` `compact()` takes no argument;
  `client/src/remote-session.ts:120` neither). Wiring one would be a
  client + cli change (not `contained`). Chosen instead, contained (see
  Drift 1): on an older daemon the chord does **not** cancel the compaction;
  the rows wait for its end and go out joined (D3c's default path) — nothing
  lost, only the "cancel" part is missing. **Owner decision open** (below).

### Repro (capability missing) — T-D1 red on the unchanged `App.tsx`

```
bun test packages/tui/test/send-now-app.test.tsx -t "T-D"   # tests written, App untouched
632 |     expect(log.sends).toEqual(["first"]);
error: expect(received).toEqual(expected)
    "first",
+   "hi",
(fail) … T-D1: Enter during a compaction queues a row (with the send-now hint) instead of sending
```
All App tests T-D1…T-D9 were red the same way (assertion failures, not
import errors; log `.tentacle/tmp/send-now-d/red-app.log`), e.g. T-D2
received `["first","A","B"]` (each Enter its own prompt, both refused by a
real daemon with `CompactInProgress`), T-D4 `sendNows` length 0, T-D8
`started` 2. T-D3b (no rows → nothing sent) is a boundary guard, green on
both by nature.

### As built, in plan order

1. **`packages/tui/src/queued.ts`** — `requeue(rows)`: every row back to
   `queued` (a compaction's send-now refused `MethodNotFound`).
2. **`packages/tui/src/send-now.ts`**
   - `planSendNow` gains `compacting` and now returns a `SendNowPlan`
     object: `none` · `atomic{target:"turn"|"compaction"}` · `fallback` (the
     turn's stop-then-send, unchanged) · **`wait`** (compacting, but no
     `sendNow` or the latch is set: the rows stay, the compaction's end sends
     them). A running turn wins over `compacting` (T-D4b: the successor
     already streams while the compaction's `Cancelled` is still in flight).
   - `onCompactionSettled({result, rows, sendNowOwns, turnRunning})` →
     `{notice, send, restore}`: the notice (`Context compacted — b → a` /
     `Compact failed: …` / **`Compaction cancelled — sending now.`** only when
     a send-now of ours owns the compaction AND the error is `Cancelled`);
     `send` = the D1 join of all rows, null when a send-now owns them or no
     row; `restore` instead of `send` when a turn already streams here.
   - `compactionWaitNotice(who)`; `CompactionResult` type.
3. **`packages/tui/src/App.tsx`** (wiring only)
   - `compactingRef` + render state (`setCompacting`), `compactionOwnedRef`.
   - `/compact`: refused while one runs ("_A compaction is already
     running._"); sets the flag; its one settle (`then` both arms) calls
     `onCompactionSettled` and executes it — the notice first, then
     `run(join, {fallback: true})` (so c's "another prompt started first →
     back in the input" applies on `TurnInProgress`). A settle of a session
     `/clear` replaced is ignored.
   - Enter while compacting (and not running) → a local row
     `{id: randomUUID()}`; no `enqueue`.
   - Chord: `wait` → notice only; `atomic{compaction}` → `compactionOwnedRef
     = true`, the TUI shows the new turn at once (`startContinuation` — the
     client installed it at once), then `ctrl.sendNow(rows, "compaction",
     signal)`; ack/stream/Esc/successor-`Cancelled` are c's paths unchanged.
     Refusal: owned flag cleared; non-fallback → c's `planRefusal` (during a
     compaction nothing is `held` → every sent text restored); `MethodNotFound`
     → latch, `requeue`, idle, wait notice, and if the compaction already
     ended meanwhile, send the joined rows now.
   - `/clear`: the compaction flag drops; any rows go back to the input with
     a notice (never sent to the new session).
   - Render: rows (and their height in `runningRows`) show while `running ||
     compacting`. **Hint:** `SEND_NOW_HINT` beside the last row shows for
     compaction-time rows too — the chord works then (atomic) — and also when
     latched to `wait` (the chord then only says it can't cancel; kept for
     one consistent row style).

### Tests (`bun test` narrow, then the gate)

- `send-now.test.ts`: the `planSendNow` table rewritten to the object shape +
  5 compaction rows; `onCompactionSettled` (5 tests). `queued.test.ts`:
  `requeue`. Red first against stubs (15 fail on assertions,
  `.tentacle/tmp/send-now-d/red-pure.log`), then green; the `turnRunning`
  test was added after the implementation and proven by mutation M7.
- `send-now-app.test.tsx` (drift 2: not `queue.test.tsx`), helper
  `heldCompaction()` + `compactingWithRows()`: T-D1 queue + hint · T-D2
  success → one `"A\n\nB"` after the notice · T-D3 failure → same · T-D3b no
  rows · T-D4 chord → `sendNow(["A","B"], "compaction")`, Cancelled reads
  "sending now", nothing re-sent nor restored · T-D4b ack before the
  Cancelled · T-D5 row typed after the chord → `enqueue`, not sent at the
  settle · T-D6 refused → restored, settle sends nothing · T-D6b refused,
  then a new row during the compaction → sent at its end · T-D7
  `MethodNotFound` → no cancel, rows sent at the end, latch (second chord
  asks nothing) · T-D7b joined send refused `TurnInProgress` → back in the
  input · T-D8 one compaction at a time · T-D9 `/clear` → rows restored,
  never sent.

**Mutations** (each reverted from a backup in `.tentacle/tmp/send-now-d/`;
after all, `shasum` App.tsx `e6249111…`, send-now.ts `88c02719…`, queued.ts
`0a3ede03…` = the pre-mutation values; `git status --short` unchanged):

| # | Mutation | Red |
|---|---|---|
| M1 | plan's: drop the `sendNowOwns` guard on the settle send | pure "owns" test, T-D4, T-D5 (T-D4 first stayed green — the `turnRunning` guard turned the double send into a restore; T-D4/T-D4b were strengthened to assert nothing is restored, then red) |
| M2 | target hard-coded `"turn"` | T-D4 |
| M3 | no `startContinuation` at the chord | T-D5 (the late row would stay local, never reach the daemon) |
| M4 | no compaction branch on `MethodNotFound` (c's turn fallback runs) | T-D7 |
| M5 | owned flag not cleared on a refusal | T-D6b, T-D7 |
| M6 | `/clear` does not restore the rows | T-D9 |
| M7 | pure `turnRunning` guard off | the `turnRunning` test |

**Gate (final):** `bun run check` → typecheck clean, lint `Checked 418
files … No fixes applied` (0 errors / 0 warnings), **2174 pass / 2 skip / 0
fail** (2176 tests, 175 files) — baseline +24 tests, the same two opt-in
skips. No known flake fired.

### Drift from the Implementation

1. **Older-daemon fallback** (`MethodNotFound`, or a controller without
   `sendNow`): `wait` instead of `session/cancel` — the premise was wrong
   (above). Nothing is lost; the compaction just runs to its end.
2. Tests in `send-now-app.test.tsx` (4c's chord harness with the fake
   `sendNow`), not `queue.test.tsx` (no `sendNow` fake there; a known flake).
3. `planSendNow` returns an object (it now carries a target); c's table test
   was rewritten to that shape, same cases.
4. Added beyond the plan (failure modes the plan didn't list): `/compact`
   refused while one runs; `/clear` during a compaction; a refusal followed
   by more rows; the joined send losing the slot (T-D7b).

### Nuances for the owner (decided here, all recorded)

- **Open decision:** should an older daemon's fallback really cancel the
  compaction? That needs a client + cli change (pass a signal through
  `persistingController.compact` → `RemoteSession.compact` →
  `RemoteClient.cancel`) — a separate S task, `cross-module`. Today: the
  rows wait for the compaction's end (notice: "_this daemon can't cancel a
  compaction to send now — your queued messages go out when it ends_").
- The chord during a compaction shows the TUI "working…" at once, before the
  ack (the client installed the turn at once). A refusal returns it to idle
  with c's `showIdle` — which, as in c, leaves a "cancelled" turn end in the
  transcript.
- A row typed after the chord whose send-now is then refused: its `enqueue`
  named the reserved turn, which the daemon rejects (`NoTurnRunning`), so
  the row goes with c's "_message not queued: …_" notice — visible, but the
  text must be re-typed (↑ recalls it). Same as c's turn case.
- "_Compaction cancelled — sending now._" is shown when the compaction
  rejects `Cancelled` while our send-now owns it. If our send-now is then
  refused (another client's send-now cancelled the compaction first), that
  notice is followed by the refusal's "back in the input" notice — slightly
  contradictory, never lossy.
- A `Cancelled` with no send-now of ours (another client's Esc/send-now)
  reads "_Compact failed: …_" and the rows are still sent (D3c).
- The joined send uses c's fallback-send path, so its `TurnInProgress`
  notice reads "_send-now: another prompt started first — …_" even though
  no chord was pressed. Other failures of that send (link gone,
  `CompactInProgress` from another device's compaction) fail the turn
  visibly: the text is in the transcript's user bubble and in ↑ history,
  not put back in the input.
- `turnRunning` at the settle (a turn this TUI started during the
  compaction — a skill activation or a job-exit wake; the daemon refuses
  both with `CompactInProgress`, so in practice transient): the rows go
  back to the input and ALL rows are cleared, including any that turn had
  enqueued. Defensive, rare.
- The settle's session-identity guard (a `/clear` then a new `/compact`
  before the old one settles) has no test of its own (M-free): with it
  absent the old settle would clear the new compaction's flag.
- Esc during a compaction: unchanged (does nothing). Ctrl+C: unchanged
  (no turn → quits; compaction-time rows are lost with the quit, like any
  draft).
- A compaction started by another device: still invisible here (out of
  scope, as planned).
- Debt (AGENTS §7): the `MethodNotFound`-after-settle "send now" decision
  and the `/clear` restore are small branches in `App.tsx`, not in a pure
  module.

## Review

*— claude-opus-5-5, 2026-10-24 (fresh context; same model as the executor, different account — shared blind spots possible)*

**Verdict: REQUEST-CHANGES.** One reproducible silent loss of queued rows (F1),
on a path D3c promises "loses nothing". The rest holds.

### Findings

1. **[medium — must fix] Compaction-time rows are silently dropped when any
   turn of this TUI ends during the compaction.** `App.tsx:1165` puts local
   rows in the same model as a turn's rows. Any turn this TUI starts while
   `compactingRef` is set still goes out: `/retry` (`App.tsx:1058`), `/<skill>`
   (`:928`), and the **job-exit auto-wake** (`:383`, `autoWakeOnJobExit`
   defaults to `true`, `:227`, so no user action is needed). The also-new
   `wakeIfPending()` after a refused compaction send-now (`:871`) is the same
   path. The daemon refuses that turn with `CompactInProgress`. Then
   `streamTurn`'s `finally` runs `setRows(onTurnEnd)` (`:716`, `queued.ts:72`),
   which drops **every** row, local ones included. No notice. The text is not
   restored to the input. The settle hook then sees no rows and sends nothing.
   Repro `.tentacle/tmp/send-now-d/review-lost.test.ts` (fake `send` throws
   `-32005` while compacting): `/compact`, `A` ⏎ (row shown with the hint),
   `/retry` ⏎ → the frame shows "⚠ Error: a compaction is in progress" and **row
   A is gone**. Compact resolves → `sends: ["first","first"]`, "A" never sent
   (`expect(sends).toContain("A")` fails). The executor's `turnRunning` nuance
   saw the related settle-time case but not the turn-end drop. Fix direction
   (executor's call): don't start a turn while this TUI is compacting (wake →
   pending; `/retry`/skill → refused like `/compact`), and/or don't let
   `onTurnEnd` drop rows that were never enqueued. Needs a red test.
2. **[low — test gap] The settle's session-identity guard (`App.tsx:998-1000`)
   is untested.** Mutation R2 (guard removed) → all 59 narrow tests stay green.
   Without the guard the sequence `/compact` → `/clear` → `/compact` → old settle
   breaks: the old settle clears the new compaction's flag, and the new rows
   go out as a prompt into the still-compacting session. That prompt fails
   `CompactInProgress`, and the text survives only in the failed user bubble. T-D9 can't
   catch this: its `createSession` returns the same `ctrl` both times, so the
   identity never changes. Needs a test with two distinct controllers.
3. **[nit] Drift 1's "nothing lost" overstates.** True for the rows taken by the
   chord (`requeue` → sent at the settle, T-D7). A row typed *after* the chord
   enqueues to the client-installed turn id (`remote-session.ts:142`, captured
   before the rollback at `:261`). The daemon rejects that enqueue, and the
   row goes with c's visible "_message not queued_" notice. Depending on the
   race, this happens before the requeue/settle send (the text must be
   re-typed, ↑ has it) or after it (the text was sent, but the notice says it
   wasn't). Visible either way, never silent. Say so in Execution.
4. **[nit] §7 debt.** I agree with the two listed branches (`:850-865`
   MethodNotFound-on-compaction: requeue/idle/send-if-ended; `:965-974`
   `/clear` restore). The first is a real decision with three outcomes. It
   belongs in `send-now.ts` next to `onCompactionSettled`. Not blocking (T-D7
   pins it), but it's the same shape as the code §7 says goes into a pure
   module.

### Lost / duplicate red-team (attacks tried)

| Attack | Result |
|---|---|
| Success / failure settle, no chord | Exactly one joined send (T-D2/T-D3; my mutation R3 "no send on failure" → red). Holds. |
| Chord; `Cancelled` by our send-now | Settle sends nothing (`sendNowOwns`), the successor carries the rows. No duplicate. Holds. |
| Chord; compaction **succeeds** before the daemon sees `send_now` | Daemon `:864-878` starts a turn with the undelivered texts (local ids are never `isDelivered`). The settle sends nothing. No duplicate. Holds. |
| `Cancelled` by another client (Esc / its send-now) | Reads "Compact failed", rows sent. If the other client's successor holds the slot → `TurnInProgress` → restored (T-D7b path). Not lost. Holds. |
| Refusal with / without `held` during a compaction | The daemon holds no local id → every text restored (T-D6). Holds. |
| `/clear` mid-compaction, then a new `/compact` | Rows restored (T-D9). The identity guard is right but untested (F2). |
| Rows typed after the chord | Enqueued to the reserved turn, `hosted-session.ts:1149-1155` (T-D5). Older daemon: F3. |
| **A turn of ours ends during the compaction** | **LOST, silent (F1).** |
| Ctrl+C / Esc during a compaction | Unchanged (quit drops rows like a draft). Out of scope by owner decision, recorded. |

### Premise table

| Premise | Verdict |
|---|---|
| Symptom: Enter during `/compact` → `send` at once (red on old App) | TRUE (Execution's red log, and the R1 mutation reproduces it: T-D1 red) |
| `RemoteSession.compact()` takes no signal (`remote-session.ts:120`) | TRUE — confirms drift 1's wrong plan premise |
| `sendNow` with no live turn installs synchronously (`:206-238`), rolls back on refusal (`:253-264`) | TRUE |
| Daemon `send_now{compaction}` reserves + aborts while compacting (`hosted-session.ts:855-862`), else decides itself (`:864-878`) | TRUE |
| `compact` rejects `Cancelled` on abort; the successor starts in `finally` | TRUE (`:1196-1214` region) |
| Blast `contained` | TRUE — `git diff --stat`: only `packages/tui/{src,test}` |

### Gate and mutations

- `bun run check`: typecheck clean · lint `Checked 418 files … No fixes
  applied` · **2174 pass / 2 skip / 0 fail** (2176 tests, 175 files). It
  matches Execution, and no flake fired.
- Mutations (narrow: `send-now-app.test.tsx` + `send-now.test.ts`, 59 tests):
  R1 (no local row on Enter) + R3 (`onCompactionSettled` sends nothing on
  failure) together → 13 red, including T-D1…T-D9 and the two pure settle tests
  (R3 hits the pure tests and T-D3). R2 (identity guard removed) alone → **0 red** (F2).
  Reverted from backups; `shasum` App.tsx `e6249111…`, send-now.ts
  `88c02719…`, queued.ts `0a3ede03…` match the pre-mutation values. `git status
  --short` is unchanged.

### What holds

The pure split (`planSendNow` object, `onCompactionSettled`) is clean and
well tested. There is no client guessing: every "did the compaction end?" is
answered by the daemon or by `compact()`'s own settle, never by text or shape.
Blast is contained. The new tests are non-vacuous, except for the identity
guard.

### How the executor behaved

The executor was honest and thorough. They caught the wrong plan premise
(no compaction abort path) and chose a contained fallback over a silent scope
creep. They strengthened T-D4 after M1 stayed green, and they listed the
untested guard and the §7 debt themselves. They missed F1: the
`turnRunning` nuance was reasoned at the settle, not at the turn's end.

## Execution — follow-up 1

*— claude-opus-5-5, 2026-10-24*

Answers the Review's findings 1–4. Review left unedited.

**F1 (silent loss) — chosen: no turn of ours starts during our own
compaction.** The TUI knows when its own compaction runs (`compactingRef`),
and the daemon would refuse any such turn (`CompactInProgress`). So the
turn is not started: its end can then never clear the compaction-time rows.
This is better than a "rows survive `onTurnEnd`" patch, which would still
put a doomed turn and a ⚠ error on screen and would need a local-vs-enqueued
tag on every row. The guard is in `run`, the single entry for every turn this
TUI starts (Enter is routed to a row before it; the send-now successor does
not use `run`), so it also covers future callers.
- `send-now.ts:129` `planTurnStart({compacting, continuation})` →
  `start` | `defer` (a job-exit wake: `wakePendingRef = true`) | `refuse`
  (`/retry`, `/<skill>`: notice `COMPACTING_NO_TURN` "_A compaction is
  running — wait for it to end (Enter queues a message meanwhile)._", the
  command stays in ↑ history). Wired at `App.tsx:743-751`.
- The deferred wake fires at the settle (`App.tsx:1036`) unless the joined
  rows go out: their turn flushes the job exits at its start, so
  `wakePendingRef` is cleared (`:1027`), the same rule `settleSendNow`
  follows. The also-new `wakeIfPending()` after a refused compaction
  send-now goes through `run`'s guard, so it is deferred again while the
  compaction still runs.
- The `turnRunning` branch of `onCompactionSettled` is now reachable only if
  a turn other than ours runs here, which is not possible today. Kept as
  defence; its "clears all rows" nuance in Execution is moot.

**F2** — T-D11: two DISTINCT controllers: `/compact` (c1) → `/clear` →
`/compact` (c2) → row `B`. Then c1 resolves → `B` is still queued and the
new session got no send. c2 resolves → `["B"]`.

**F3 — correction to Execution drift 1:** "nothing lost" holds only for the
rows the chord took (`requeue` → sent at the end, T-D7). A row typed *after*
the chord on an older daemon enqueues to the client-installed turn id
(`remote-session.ts:142`, captured before the rollback at `:261`), which the
daemon rejects. The row goes with c's "_message not queued: …_" notice.
Depending on the race, this lands before the requeue/settle send (the text
must be re-typed, ↑ has it) or after it (the text was sent, but the notice
says it was not). Visible either way, never silent.

**F4** — `send-now.ts:149` `afterCompactionUnsupported(rows, compacting)` →
`{rows, send}`: still compacting (or no row) → rows requeued, nothing sent.
Already ended → one joined prompt now, no row left. `App.tsx:869` executes
it (requeue moved out of `App`, the `requeue` import dropped). The `/clear`
restore stays a small branch in `App` (listed debt).

**Red → green.**
- Narrow run before the App fix, log `.tentacle/tmp/send-now-d/red-fu1.log`:
  T-D10 (the reviewer's repro, ported: fake `send` refuses `-32005` while
  compacting; `/retry`), T-D10b (`/review now` skill), T-D10c (a job exit,
  with a row), T-D10d (a job exit, no row) all **red** on their first
  assertion. `sends` received an extra prompt, i.e. a turn started during
  the compaction.
- T-D11 was green on the guarded code by construction: it is the killer of
  mutation R2, below.
- After the fix: all green. The reviewer's own repro
  (`.tentacle/tmp/send-now-d/review-lost.test.ts`) → `sends: ["first","A"]`,
  1 pass.
- The pure tests for `planTurnStart` / `afterCompactionUnsupported` were
  written after the functions. Non-vacuity was proven by mutation instead.

**Mutations.** Backups `App.fu1.bak`, `send-now.fu1.bak`. All were reverted,
and afterwards `shasum` App.tsx `01bf1552…`, send-now.ts `20ebd202…`,
queued.ts `0a3ede03…` = the pre-mutation values. `git status --short` was
unchanged.

| # | Mutation | Red |
|---|---|---|
| F-a | `planTurnStart` always `start` | pure test, T-D10, T-D10b, T-D10c, T-D10d |
| R2 | session-identity guard at the settle removed | T-D11 |
| F-b | no `wakeIfPending()` at the settle | T-D10d |
| F-c | the settle's send does not clear `wakePendingRef` | T-D10c (an extra `""` wake after the joined prompt) |
| F-d | `afterCompactionUnsupported` ignores `compacting` | pure test, T-D7 |

**Gate:** `bun run check` → typecheck clean, lint `Checked 418 files … No
fixes applied`, **2183 pass / 2 skip / 0 fail** (2185 tests, 175 files) =
the previous 2174 + 9 new tests, the same two opt-in skips.

**Nuances for the owner.**
- `/retry` or a skill during a compaction is now refused with a notice,
  where before it was sent and failed. The text is in ↑ history.
- A job exit during a compaction is reacted to only after it ends. If rows
  were queued, the joined prompt's turn sees the exit (no extra wake).
- Still unchanged: another device's compaction is invisible here, so a turn
  started during IT is still refused by the daemon (out of scope, as
  planned). No compaction-time rows exist in that case, so nothing can be
  lost.

## Review — round 2

*— claude-opus-5-5, 2026-10-24 (same reviewer context as round 1; same model as the executor)*

**Verdict: REQUEST-CHANGES (small).** F1–F4 are closed, each one killed by a
mutation of my own. The F1 fix introduces one new regression (F5): a
deferred wake survives `/clear`. The fix is one line plus a test.

### Round-1 findings

| # | Closed? | Evidence |
|---|---|---|
| F1 | **Yes** | My repro `review-lost.test.ts` now gives `sends: ["first","A"]`, 1 pass. `planTurnStart` (`send-now.ts:129`) is guarded in `run` (`App.tsx:743-751`), the single entry point for our turns. The settle clears `compacting` (`:1017`) *before* its joined `run` (`:1029`), so the guard never blocks its own send. Mutation M-a (`refuse` → start) → T-D10, T-D10b red. Mutation M-b (defer without setting the flag) → T-D10d red. |
| F2 | **Yes** | T-D11 uses two distinct controllers. Mutation M-c (identity guard `:1014-1016` removed) → T-D11 red. |
| F3 | **Yes** | The wording in follow-up 1 is accurate. |
| F4 | **Yes** | `afterCompactionUnsupported` (`send-now.ts:149`) is executed at `App.tsx:869`. Mutation M-d (`compacting` ignored) → the pure test and T-D7 red. |

### New finding

5. **[low-medium — must fix] A wake deferred during our `/compact` survives
   `/clear` and fires as an unasked continuation in the NEW session.**
   - The defer sets `wakePendingRef` (`App.tsx:745`).
   - `/clear` (`:970-992`) resets `compacting` but not that flag. The settle of
     the old session is ignored (identity guard), so the flag is never
     consumed.
   - The new session's first turn ends, and `wakeIfPending` (`:718`) then runs
     `""` on the new session: a model turn the user didn't ask for, reacting to
     a job of the closed session.
   - Repro `.tentacle/tmp/send-now-d/review2-stale-wake.test.ts` (compact never
     settles, job exit, `/clear`, `hello`) → `sends: ["one:first","two:hello","two:"]`, 1 fail.
   - This is new: on `main` the flag could only be set while a turn ran, and
     `/clear` is refused while running, so the flag never crossed a `/clear`.
   - Fix direction: `/clear` drops `wakePendingRef`, as it already drops the
     other per-session latches (`:976-977`). Needs a red test.

### Attacks on the new guard

| Attack | Result |
|---|---|
| Is "compacting" a fact the TUI owns? | **Yes.** It is set only by our `/compact` (`:1008`) and cleared only by that call's own settle (`:1017`) or by `/clear` (`:983`). It is never inferred from daemon text or message shape. |
| Compaction that never settles → turns blocked forever? | **Bounded.** `compact` is a `"once"` request, so a dropped link rejects it and the settle runs. If the daemon hangs, there are two ways out: the chord with rows (atomic `sendNow{compaction}` makes the daemon abort it), or `/clear`. Without rows, `/retry` and skills stay refused with a visible notice, and wakes stay deferred. Acceptable; the old behaviour (every turn refused `CompactInProgress`) was no better. |
| `/clear` mid-compaction | `compacting` is cleared, rows are restored (T-D9), the old settle is ignored (T-D11). The pending wake leaks: **F5**. |
| A compaction started by another device | `compactingRef` stays false → no guard, unchanged behaviour (the daemon refuses visibly). No local rows exist then, so nothing is lost. Holds. |
| Deferred wake + joined send | The flag is cleared (`:1027`) and the joined turn flushes the exits. One prompt, no extra `""`. T-D10c, and executor mutation F-c. Holds. |
| Deferred wake + our chord → settle `sendNowOwns` | `wakeIfPending` (`:1036`) consumes the flag while running, so the wake is dropped. The successor turn flushes the exits at its start. **Nit:** if that send-now is *then* refused (another client's send-now won), the wake is gone and no turn of ours sees the exit. This is the same consume-while-running rule as c's `settleSendNow` (`:617`). Narrow; record it, don't fix it here. |
| Silent loss / duplicate reintroduced? | None found. Every path that empties rows either sends them (once), restores them with a notice, or hands them to an acknowledged send-now. |

### Gate and mutations

- `bun run check`: typecheck clean · lint `Checked 418 files … No fixes
  applied` · **2183 pass / 2 skip / 0 fail** (2185 tests, 175 files). This
  matches follow-up 1.
- Mutations M-a, M-b, M-c, M-d: each one was applied alone and the narrow run
  went red (68 tests: 2, 1, 1 and 2 fail). Each was reverted from a backup
  (`App.r2.bak`, `send-now.r2.bak`).
- Afterwards `shasum` matches the pre-mutation values: App.tsx `01bf1552…`,
  send-now.ts `20ebd202…`, queued.ts `0a3ede03…`. `git status --short` is
  unchanged.

### How the executor behaved

The executor answered every finding precisely. They chose the
structural F1 fix (don't start the doomed turn) over a row-tagging patch,
which was the right call. They ported my repro as T-D10 and proved the new
pure helpers by mutation. They missed the per-session nature of the new
deferred flag; it is the same class of gap as round 1 (a state lifetime
reasoned in one path, not across `/clear`).

## Execution — follow-up 2

*— claude-sonnet-5-5, 2026-10-24*

Answers the Review round 2 (F5 and the nit). Review left unedited.

**F5 — fix.** `/clear` now resets `wakePendingRef` (`App.tsx:977-979`, next
to the other per-session latches). A wake deferred during the old session's
compaction belongs to that session; its settle is ignored by the identity
guard, so nothing else would ever consume it.

**Red → green.** T-D12 (`send-now-app.test.tsx`, the reviewer's repro
`review2-stale-wake.test.ts` ported to the fake session/jobs harness):
`/compact` never settles, job exit, `/clear`, `hello`. Red before the fix:
`two.log.sends` received an extra `""` (the unasked continuation). Green
after: `["hello"]`.

**Mutation.** Dropping the reset → T-D12 red (37 pass / 1 fail). Reverted
from backup `App.fu2.bak`; `shasum` App.tsx `63dcd18c…`, send-now.ts
`20ebd202…`, queued.ts `0a3ede03…` = the values before the mutation.

**Gate.** `bun run check`: typecheck clean · lint `Checked 418 files … No
fixes applied` · **2184 pass / 2 skip / 0 fail** (2186 tests, 175 files) =
2183 + T-D12.

**Known debt (the review's nit, not fixed).** After a compaction settles
with `sendNowOwns` and that send-now is then refused (another client's
send-now won), `wakeIfPending` has already consumed the deferred wake, so no
turn of ours reacts to the job exit. Same consume-while-running rule as c's
`settleSendNow` (`App.tsx:617`); narrow.
