# mobile-queued-stuck — a queue row that never leaves the phone

Type: fix · Size: M · Blast: cross-module · Suited: strong model (fix slice)

**Status:** diagnostic slice merged (deepseek-v4); **fix slice built** on the
owner's device capture (claude-opus-5-5, 17/11) — three defects, all fixed, see
"Context addendum" and the fix-slice sections. The qtrace lines stay.

## Context

*— deepseek-v4, 2026-11-17*

**The bug.** During a turn, a steer typed on the phone appears in the composer's
queue ("Queued · the agent reads these at its next step") and the row stays there
for ever — long after the reply lands, after the turn ends, and after later
messages are sent. Leaving the session screen and re-entering shows the correct
(empty) queue. Owner's report, with a screenshot of the stale row.

**What a previous run established** (`night-mobile-queued-stuck-exec1.log`, no
code committed — every layer the laptop can drive was green):

| Level | Sequence | Result |
|---|---|---|
| Pure state machine | `enqueueStarted` → `onQueued(listed)` → `enqueueAcked` → `onQueued([])` | row clears |
| Screen + fake handle | same | clears |
| Real in-process daemon, foreign turn | laptop holds the turn, phone steers, gate opens | `queuedOf` → `{entries:[]}`, `view.queued` → `[]` |
| Real in-process daemon, phone's own turn, mid-turn attach, multi-round tool turn | steer drained at the inner boundary | clears every time |

So the clearing `queued` update is emitted, broadcast, received and applied in
every configuration reproducible off-device. Two facts are nevertheless real and
are the whole reason this slice exists:

1. **A row leaves on ONE thing only**: a `queued` report that no longer lists it
   — `apps/mobile/src/compose-queue.ts:78-105` (`shownRows`; a row whose id is
   absent from `daemon.entries` and is `acked` is dropped). There is no other
   path out. If that one frame never arrives, or a later report re-lists the id,
   the row is shown for ever.
2. **The TUI also reconciles at turn end; mobile does not.** `packages/tui/src/queued.ts`
   clears its rows on a turn's end ("nothing stays queued"), called from
   `useTurnDriver.ts`. `apps/mobile/src/compose-state.ts` has no equivalent hook,
   so the two frontends differ in a load-bearing rule: the frame is the phone's
   *only* recovery.

`queued` is also in the daemon's droppable set (`packages/daemon/src/watch-queue.ts:62`),
i.e. it *can* be discarded under overflow — though that is the `tentacle logs`
watch path, not the session stream. The link's own loss surfaces as a forced
reopen + snapshot, not as a `lost: N` batch on this client.

**The open question.** Whether the device's missing frame is (a) never sent,
(b) sent and dropped, (c) received and applied but followed by a report that
re-lists the row, or (d) received and not applied. A screenshot cannot say, and
none of the four is reproducible from the laptop.

**Owner decision (17/11): option 2 — capture the device's frames first, fix
after.** This slice is that capture. It adds diagnostics to the log the app
already exports (Settings → "Export logs", `apps/mobile/src/app-log.ts` and its
rotating file `app-log-fs.ts`, drained by one interval in `App.tsx`), so one
device repro answers the question above.

### Context addendum — the device capture (fix slice)

*— claude-opus-5-5, 2026-11-17*

Owner's export, build `680b4b8b`, session `a764ba51` (`.tentacle/tmp/mobile-queued-stuck/capture-1.txt`, `capture-2.txt`; qtrace lines, verbatim):

```
22:13:55.911Z ev=turn-start turn=c5ad2a4a own=true
22:13:58.102Z ev=compose act=send-now row=9cbd2fa8
22:13:58.103Z ev=rows where=after-send-now n=1 id0=9cbd2fa8
22:13:58.241Z ev=queued-received src=live n=1 id0=9cbd2fa8 returned=0
22:13:58.241Z ev=rows where=after-queued-live n=1 id0=9cbd2fa8
22:13:58.246Z ev=turn-end turn=c5ad2a4a outcome=cancelled
22:13:58.246Z ev=rows where=after-turn-end n=1 id0=9cbd2fa8
22:13:58.246Z ev=queued-received src=live n=0 returned=0
22:13:58.246Z ev=rows where=after-queued-live n=1 id0=9cbd2fa8      ← the bug
22:14:17.415Z ws-close code=1000 / ev=link state=down
22:14:29.077Z app-state state=active                               (link still down)
22:14:30.001Z ev=link state=up      ← no attach / resync / history
22:16:08.210Z ev=link state=up      ← again none (26 s, row still shown)
22:16:36.543Z ev=attach state=start reopen=false                   (person re-entered)
22:16:37.601Z ev=history reason=none msgs=111                      (was 108)
22:16:37.602Z ev=queued-received src=current n=0 → rows n=0
```

The question the diagnostic asked is answered: **(c) of the table — received,
applied wrongly.** The clearing frame arrived (`n=0`) and the phone's fold kept
the row. The "dropped frame" hypothesis is disproved. Three defects, each
reproduced RED at its own level:

- **(a) the stuck row.** A send-now's minted row is `local`, not `acked`;
  `shownRows` shows such a row whenever the daemon does not list it
  (`compose-queue.ts:102`), and on the success path nothing ever acked it — the
  old `compose-controller.ts:882` awaited `handle.sendNow` and its `finally`
  (`:905`) only cleared `carried`. Worse, `handle.sendNow` DRAINED the whole new
  turn (old `compose-handle.ts:72`), so even its resolution came at that turn's
  end. A listed row was never treated as the daemon's either, so the `n=0` report
  re-surfaced it as "in flight".
- **(b) the invisible send-now turn.** The new turn ran daemon-side (108 → 111
  messages: the user message + the answer), yet no `turn-start` was traced in the
  19 s after the send-now. Why: the successor turn's events go ONLY to the
  iterable `RemoteSession.sendNow` returns (an own turn — not a foreign
  `turn` activity), and `compose-handle.ts` drained that iterable and threw it
  away. The feed (`session-feed.ts`, where `turn-start` is traced) never saw it:
  no bracket, no answer, no Stop, until a re-entry read the history.
- **(c) no resync after a return while offline.** `appState("active")` with the
  link down skipped the resync ("the redial re-attach owns the recovery"), and
  `link(up)` only folded the link status. The capture shows two link-ups with no
  attach and no history: the redial re-reads nothing on this screen.

**TUI parity (`packages/tui/src/queued.ts` `onTurnEnd` = clear all rows).**
Not adopted, with evidence: the TUI has no daemon list, so its rows can only be
reconciled by echoes and the turn's end. The phone's rows ARE the daemon's full
`queued` report, and the daemon re-sends it at the turn's end — the capture
shows it landing in the same millisecond as `turn-end` (`22:13:58.246`). A
turn-end clear would instead drop a steer still in flight that the daemon
carries over to the next turn (`remote-session.ts` `sendNow`: "Enqueues keep
binding to the old turn until it ends (the daemon carries them over)"). The
convergence rule is put where the defect is — what makes a row the daemon's.

## Implementation

*— deepseek-v4, 2026-11-17*

**Load-bearing assumption**, and how it was verified:
`queued` reports reach the compose half through exactly one seam —
`ComposeHandle.onQueued`, implemented at `apps/mobile/src/compose-handle.ts:77-82`
over `RemoteClient.onSessionQueued` (`packages/client/src/remote-client.ts:1497`),
fed by `queuedChanged` (`:3486`). Every path into `ComposeState.daemon` — live
frame, subscribe replay, the read-through `queued()`, a resync snapshot — passes
through `applyQueued` (`compose-controller.ts`). Verified by reading all four
call sites of `applyQueued` and the `ComposeHandle` implementations; a fake handle
in the wiring test drives the same entry point the device does.

**Design — one pure formatter, dumb call sites (AGENTS §7).**

- `apps/mobile/src/queue-trace.ts` (new) owns *what a line may contain*: a sealed
  union of events (`queued-received`, `batch-lost`, `turn-start`, `turn-end`,
  `link`, `attach`, `history`, `resync`, `compose`, `cancel`, `rows`) and their
  formatting. Ids are cut to 8 characters (`app-log.ts` `shortId`), a long list
  is capped at 6 with the overflow counted (`more`), and **no event has a
  free-text field at all** — so no call site can put a row's words or the daemon's
  prose into a file a person shares (app-log D7/F16). `QTRACE = "qtrace"` is the
  kind; `ev` names the event, so `grep qtrace` finds the story.
  `queueTrace(sessionId, log)` binds the formatter to the app's ONE log, so a call
  site only ever calls `trace(event)`.
- `apps/mobile/src/app-log.ts` — one new kind, `"qtrace"`, in the closed union.
- Call sites (each only forwards an event):
  - `compose-controller.ts` — `applyQueued` traces the report *before* folding it
    (`queued-received`: source, listed ids, count, `returned` count) and the rows
    the UI shows after it (`rows where=after-queued-…`, from `queueRows`, the pure
    view function). The report's `source` distinguishes `live` (a frame),
    `replay` (the client's held state at subscribe), `current` (the one report read
    through `queued()`) and `snapshot` — the four ways a report can arrive, which
    is half the diagnosis. Local acts trace too: `enqueue` (steer), `send-now`,
    `reject`, and `cancel` (Stop, with the turn id and whose it was), each followed
    by `rows`. `turnClosed()` reports the rows still shown when a turn's bracket
    closes (see below).
  - `session-feed.ts` — `turn-start` / `turn-end` (with the outcome the fold
    decided), `link` up/down, and `history` (a snapshot or a replace, with the
    message count). This module is the one place a turn bracket opens and closes,
    so the turn lines are emitted there rather than guessed from a state diff. It
    gains `onTurnClosed`, a notification the screen uses **for the trace only**
    (nothing is cleared — that reconciliation is the fix, not the diagnostic).
  - `session-screen-controller.ts` — `attach` (start / ok / fail, `reopen`, typed
    failure reason), `resync` (start / done / kept / failed); builds the feed and
    the compose half with this session's trace.
  - `App.tsx` — `trace: queueTrace(sessionId, APP_LOG)` at `createSessionScreen`.
    `APP_LOG` is the same ring `Settings → Export logs` reads and the same one the
    2 s drain writes to the rotating file, so no new writer is needed.
- `batch-lost` (`lost: N`) is wired where a loss *would* be counted. The phone's
  stack has no `lost` surface today (`lost` exists only on the `tentacle logs`
  watch: `packages/client/src/watch.ts`, `protocol/src/watch.ts:178`), and a gap
  on the session stream surfaces as a forced reopen + snapshot instead. The event
  is kept so a capture can record it if it becomes reachable, and so the owner's
  requested field exists; it is emitted by nothing on the device path today.
  **Stated plainly because it is the one requested item that cannot be observed
  yet.**

**Failure modes.**
- *The log is not flushed in time.* The file is drained every 2 s (`LOG_DRAIN_MS`),
  and `Export logs` reads the in-memory ring directly, so an export taken right
  after the repro contains the entries regardless.
- *The ring overflows.* 500 entries; each trace line is ~60 bytes in the ring, and
  the export header states `dropped: N`. Taken immediately after the repro, a
  handful of lines cannot overflow it.
- *A trace throws.* `queueTrace` cannot throw (it formats, then calls `log.log`),
  and `AppLog.log` cannot throw. The `append` path already swallows.
- *Nothing traces.* `trace` is optional at every seam; absent it is a no-op, which
  is why the existing tests pass no log.
- *The trace changes behaviour.* It does not: no call site branches on it, and the
  one non-logging addition (`onTurnClosed`) clears nothing — pinned by a test.

**Tests.**
- `apps/mobile/test/queue-trace.test.ts` — the formatter: every event's fields,
  the empty report (`n=0`), the capped list with `more`, all four sources, and the
  negatives (a long id never survives whole, no free-text field exists, an empty
  id is `-`).
- `apps/mobile/test/compose-controller.test.ts` — the wiring, over the real
  compose half:
  - a `queued` update reaching the phone produces a `qtrace` line with the ids,
    the count and the source, and the row's TEXT is not in the export;
  - the report that clears a row is recorded as `n=0` followed by `rows … n=0`
    (the pair a capture needs, and the non-vacuity check for the fix's question);
  - a local enqueue and a send-now name the row they minted;
  - the turn's end records the rows still shown and **clears nothing**;
  - with no sink wired, nothing is logged and the acts still happen.
  Red-before-green: with the `queued-received` emission removed, two of these fail.

**Validation.** `bunx tsc -p apps/mobile --noEmit`, `bun run lint`, one full
`bun test`.

**Notes / debt.**
- This slice does not fix the bug. The fix (one candidate, not yet chosen: a
  `turnEnded(state, turnId)` in `compose-state.ts` clearing local rows and the
  rows the last report held, wired where the screen observes the turn's end — the
  TUI's `onTurnEnd`) is deliberately deferred: adding it before the capture would
  remove the very frame being hunted.
- Mobile has no turn-end queue reconciliation at all, unlike the TUI. Whether it
  should is a specification question for the fix, not for the diagnostic.
- The one `batch-lost` line cannot fire on the device path today (above).

## Execution

*— deepseek-v4, 2026-11-17*

As built, in dependency order:

1. `apps/mobile/src/queue-trace.ts` (new, 170 lines): the event union, `traceLine`
   (pure formatting), `queueTrace(sessionId, log)` (bind to the app log), `QTRACE`,
   `TRACE_IDS_MAX`, `TraceSource`.
2. `app-log.ts`: `"qtrace"` added to `AppLogKind` — a closed union, so the new
   kind is the only way the formatter can emit (a compiler-enforced boundary).
3. `compose-controller.ts`: `trace?: QueueTrace` on `ComposeDeps`; `applyQueued`
   takes a `TraceSource` (its three call sites now pass `live` / `replay` /
   `current`), emits `queued-received` before the fold and `rows` after;
   `traceRows(where)` helper; traces for enqueue, steer-ack, send-now, reject,
   cancel; `turnClosed()` on `Compose`.
4. `session-feed.ts`: `trace?`, `onTurnClosed?` on `SessionFeedDeps`; `turn-start`,
   `turn-end` + `onTurnClosed`, `link`, `history`.
5. `session-screen-controller.ts`: `trace?` on `SessionScreenDeps`; forwarded to
   the feed and to the compose half; `attach` (start/ok/fail) and `resync`
   (start/failed/kept/done) events; `onTurnClosed: () => compose?.turnClosed()`.
6. `App.tsx`: `trace: queueTrace(sessionId, APP_LOG)` in `createSessionScreen`.
7. Tests: `queue-trace.test.ts` (new, 14 tests) and five tests appended to
   `compose-controller.test.ts` (whose harness gained an optional `log`).

**Drift from Implementation:** none of substance. Two refinements found while
wiring: `cancel` became its own event rather than a `compose` act (a Stop has no
local row — it names a turn), and the app log's `qtrace` kind was added *before*
the formatter so `TraceLine.kind` could be a literal rather than a widened
string. The `batch-lost` event is as described: defined, formatted, unemitted.

Gate: `bunx tsc -p apps/mobile --noEmit` clean; `bun run lint` clean
(`biome check .`, 2045 files, no findings — imports re-sorted by
`biome check --write`); full `bun test` green.

**How to read a capture (for the owner).** Export logs right after the repro and:

```
grep qtrace tentacle-logs-*.txt
```

The row's id is the 8 characters in `act=enqueue row=…`. Then read, in order:
`ev=attach`/`ev=link` (did the link stay up?), `ev=turn-start`,
`ev=queued-received src=live n=…` (did a report arrive, and did it list the row?),
`ev=rows where=after-queued-live` (did the UI drop it?), `ev=turn-end` and
`ev=rows where=after-turn-end`. The four candidate causes read like this:

| What the log shows | What it means |
|---|---|
| no `queued-received` between the steer and `turn-end` | the frame never reached the phone (daemon / link / reducer) |
| `queued-received` listing the row, then no report without it | the frame was never sent (daemon side) |
| a report with `n=0` and no `id0`, but `rows … n=1` after it | received, applied wrongly (mobile state) |
| `rows … n=0` then a LATER `queued-received` listing the row again | a returning report revived it |

## Implementation — fix slice

*— claude-opus-5-5, 2026-11-17*

**Load-bearing assumption:** the daemon's `queued` report is a FULL state and
the turn's end re-sends it — verified by the capture itself (the `n=0` report at
`22:13:58.246`, with `turn-end`) and by `QueueState`'s contract quoted at
`compose-queue.ts:6-9`. So "listed, then not listed" is a sufficient exit for a
row, and no turn-end clear is needed.

**Preconditions (verified):** `RemoteSession.sendNow` resolves at the daemon's
ACK with the successor's events (`remote-session.ts`, the `sendPrompt` await,
then `this.stream(turn, …)`), and buffers them in the turn's `AsyncQueue` until
consumed; its turn is installed as `next` while the old turn streams, so its
events follow the old `turn_end`. The feed's `foldStream` opens its bracket
synchronously at the call (`turn_started`), and the transcript holds ONE bracket
(`transcript.ts` `startTurn`/`endTurn`).

**Design.**
1. (a) `compose-state.ts` `onQueued`: a local row the report LISTS becomes
   `acked` (it is the daemon's now, whatever our request says yet); the existing
   filter then drops it on the first report that no longer lists it. A row never
   listed and never acked is still in flight and stays.
   `sendNowAccepted` (acks every message of a send-now) runs when the send-now's
   ACK lands — the fallback for a row no report ever listed (the daemon carried
   it straight into the new prompt).
2. (b) `ComposeHandle.sendNow(messages, turnId, next)` resolves at the ACK with
   the successor's events instead of draining them; `next` names the
   successor's key and the Stop's signal. The compose half hands the request to
   the screen (`followSendNow`, the same rule as `prompt`), which mints the key
   (so `transcript.turn.turnId`, which steers bind to, is the daemon's), sets
   `ownControl` and folds the events through a new `feed.successorTurn`, which
   opens the bracket only after every stream being folded has closed — the ACK
   can land before the cancelled turn's `turn_end` is folded, and its
   `turn_ended` must not close the new bracket. `RemoteSession.sendNow` gains an
   optional `turnId` (additive, like `send`'s `{ turnId }`; no wire change).
3. (c) `session-screen-controller.ts`: a return while the link is down sets
   `resyncOnUp`; the next `link(true)` runs the silent resync once (same
   guards as the foreground path).

**Files:** `packages/client/src/remote-session.ts` · `apps/mobile/src/compose-state.ts`
· `compose-controller.ts` · `compose-handle.ts` · `session-feed.ts` ·
`session-screen-controller.ts` · tests (below) · `changelog.d/mobile-queued-stuck.fixed.md`.

**Failure modes → how state converges.**
- Plain steer consumed at the next step, before its enqueue ack: listed ⇒ acked,
  next report drops it; the late ack finds no row (test).
- Send-now of the field: listed n=1, turn cancelled, n=0 → gone (the capture,
  replayed at the pure AND controller level).
- Send-now carried straight into the prompt, never listed: gone at the ACK
  (`sendNowAccepted`), dropped at the next report (test).
- Two queued (mine + another device's), send-now carries mine: only the other
  stays (test).
- Cancel: the listed row comes back `returned` → given back once, not a row (test).
- Re-attach with the row still queued on the daemon: the replay lists it → it
  stays, with my text (test). Re-attach after it was consumed: the replay's
  `n=0` drops it (test).
- Send-now refused: unchanged path (`restoredByRefusal`); `followSendNow`
  restores the previous `ownControl` and folds nothing.
- Successor stream throws after the ACK: folded LOST by the feed (as any own
  turn), nothing back to the field.
- A link blip with no return in between: no resync (test); the owed resync runs
  once (test).

**Tests:** `compose-state.test.ts` (the 8 pure cases above),
`compose-controller.test.ts` (the capture replayed with the ACK held; a send-now
never listed), `session-screen-compose.test.ts` (b: the successor folds here,
after the cancelled turn's end), `session-screen.test.ts` (c: owed resync at
link up, once; no resync on a bare blip).

## Execution — fix slice

*— claude-opus-5-5, 2026-11-17*

Kept from the interrupted attempt: `sendNowAccepted` and the pure/controller
tests (they encoded the right contract); its controller wiring and the
listed ⇒ acked rule were missing, so all 7 were RED on the tree:

```
(fail) … > the device capture: a send-now's minted row, listed n=1, then n=0 → gone
(fail) … > a plain steer consumed at the next step BEFORE its enqueue ack resolves → gone
(fail) … > two queued (mine + another device's), send-now carries mine → only the other stays
(fail) … > cancel: the listed row comes back RETURNED → given back once, not left as a row
(fail) … > re-attach AFTER it was consumed while away → the replay drops it
(fail) … > the device capture, replayed: send-now row listed, turn cancelled, n=0 → the row leaves
        expect(h.compose.view().queued).toEqual([])  - []  + [{ id: "k1", mine: true, state: "queued", text: "now please" }]
(fail) … > a send-now the daemon never LISTS converges when its request succeeds
 51 pass / 7 fail
```

Then, in order: listed ⇒ acked in `onQueued` (`compose-state.ts:136-148`);
`sendNowAccepted` wired at the ACK (`compose-controller.ts:930`); the optional
`turnId` on `RemoteSession.sendNow` (`remote-session.ts:1422`);
`ComposeHandle.sendNow` returns the events (`compose-handle.ts:75`), with a
drain only when no screen follows (`compose-controller.ts:89`);
`feed.successorTurn` (`session-feed.ts:279,331`); `followSendNow`
(`session-screen-controller.ts:1320`); `resyncOnUp` (`:945, 1513, 1546`). Three
test fakes adapted to the new `sendNow` return type. Narrow suites: 155 pass, 0 fail.

**Mutation check** (each applied, the narrow suite run, then restored):

```
(a)  no listed⇒acked in onQueued          → 6 fail (the 5 pure cases + the controller replay)
(a') no sendNowAccepted at the ACK        → 1 fail (a send-now the daemon never LISTS …)
(b)  screen does not follow the successor → 1 fail (… successor turn folds HERE …)
(b') successor folded at once (no wait)   → 1 fail (same test, the "still running" line)
(c)  no resyncOnUp at link up             → 1 fail (… a return while OFFLINE is OWED …)
```

**Drift from the fix plan:** (b) and (c) were not in the original candidate fix
(a turn-end clear); the capture showed them, and the turn-end clear was rejected
(Context addendum). Blast rose from contained to cross-module (an additive
optional parameter in `@tentacle/client`, the screen controller); no protocol,
persistence or §7 invariant change — the send-now still goes through the ONE
`RemoteSession` path, the screen now folds what it used to drain.

**Gate:** `bunx tsc --noEmit` and `bunx tsc -p apps/mobile --noEmit` clean;
`bun run lint` clean (2046 files, 0 findings, after `biome check --write` on two
files for line length). One full `bun test`: 14860 pass, 5 skip, 2 fail. The two
failures are both in `packages/daemon/test/serve-log-store.test.ts` (S2 (a) timed
out at 20 s, then (b)), which this diff does not touch. Run alone, that file passes
22/22, so they are load flakes, not this change. This diff adds no skip.

**Unverified:** on-device behaviour of (b)/(c) — verify with one repro of the
capture's sequence on the next build (expect `ev=turn-start own=true` right
after the cancelled `turn-end`, and `ev=resync state=start` after a return's
`link state=up`).

## Review

*— deepseek-v4, 2026-11-17 (self-review, in-context; the diagnostic is contained
and changes no behaviour, so a fresh-context pass is not gated on it)*

- **Gate re-run:** `bunx tsc -p apps/mobile --noEmit` clean, `bun run lint` clean
  (0 errors, 0 warnings — matches the §6 baseline), full `bun test` green.
- **Non-vacuity:** confirmed by mutation — removing the `queued-received` emission
  from `applyQueued` fails two of the wiring tests (4 expected lines, 2 received;
  `ev=queued-received` absent). Restored.
- **Failure modes from the Implementation, re-checked:** presence in the export
  depends on the ring, read directly by `exportLogs` — not on the 2 s file drain,
  so an immediate export still contains the lines. The ring is 500 entries and
  the header reports `dropped`; a repro produces tens of lines.
- **The privacy property is structural, not a promise:** `QueueTraceEvent` has no
  string field a caller can fill with prose, each arm's formatting is `queue-trace.ts`'s,
  `fieldValue` still caps and scrubs anything a caller slips in, and a test asserts
  a row's text is absent from the export while the line itself is present.
- **What does not hold:** `batch-lost` has no producer on the device path (stated
  in the Implementation and again above) — the owner asked for it, and it exists,
  but a capture will not show it. Everything else the owner asked for is wired:
  `queued` reports received (ids + count, never text), turn start/end with ids,
  attach/resync/snapshot/link, local enqueue/send-now/cancel with the local row id,
  and the shown rows after each of them.

## Review — fix slice

*— claude-opus-5-5, 2026-11-17 (fresh-context adversarial review; SAME model as
the fix-slice executor, so shared blind spots may survive both passes)*

**Verdict: APPROVE.** No HIGH or MEDIUM findings.

- **Gate:** the touched suites plus `packages/client/test` give 970 pass, 0 fail.
  `bun run typecheck` is clean (root, mobile, relay). `bun run lint` is clean
  (2046 files). The full `bun test` was not re-run here.
- **Mutations** (each applied, the four narrow files run, all reverted; `git
  status` came back clean):
  1. No listed ⇒ acked in `onQueued`.
  2. `successorTurn` folds at once, without waiting.
  3. `resyncOnUp` never set.
  Together they make 8 tests fail: 5 pure cases, the controller replay, (b) and (c).
- **Attacks tried:**
  1. The plain `send()` path sets `ownControl = null` without checking it
     (`session-screen-controller.ts:1293`), which could clear the successor's
     Stop. It cannot happen: `send()` runs only when compose is null (`:1444`),
     and send-now needs compose.
  2. Send-now on a FOREIGN turn: its fold is `track`ed too
     (`session-feed.ts:324`), so the successor waits for its end.
  3. Two send-nows in a row: `RemoteSession` refuses while `next` is waiting.
     After promotion, successor 2 waits on successor 1's tracked fold. That is a
     chain, not a deadlock.
  4. A Stop before the successor's bracket opens: the signal triggers
     `client.cancel` on the successor's key. Correct.
  5. Other `createCompose` callers that would fall back to `drainSendNow`: none
     in production (`session-screen-controller.ts:716` wires `followSendNow`).
     The outbox `sendNow` is a different act.
  6. §7 invariants: one `RemoteSession` path, an additive optional parameter, no
     wire, persistence or broker change. They hold.
- **Nit (not blocking):** when a send-now's message is carried over into the
  daemon's queue rather than the new prompt, and the report arrives after the
  ACK, `sendNowAccepted` can drop the row for a moment before the report shows
  it again. That is a flicker; state still converges.
- **Executor behaviour:** the RED list and the mutation table in Execution match
  what was reproduced here. The drift in scope (adding (b) and (c)) is grounded in
  the device capture and stated honestly. Still unverified: on-device behaviour
  of (b) and (c), as Execution says.
