# mobile-queued-stuck — a queue row that never leaves the phone

Type: fix · Size: S · Blast: contained · Suited: DeepSeek exec

**Status: DIAGNOSTIC SLICE ONLY.** No behaviour changed. The fix waits for the
owner's device capture (decision 17/11, option 2).

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
