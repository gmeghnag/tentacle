# fix/mobile-fan-jank-device — the hub fan opens in jerks while a turn streams (device)

> **Status:** execution
> **Branch:** `fix/mobile-fan-jank-device`
> Type: fix · Size: M · Blast: cross-module (transcript render path) · Suited: Opus
> **Changelog:** `changelog.d/mobile-fan-jank-device.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-19*

The owner tested build `164f0876` on a real iPhone 12 Pro. That build includes
`docs/feat/mobile-hub-native-driver.md`. The hub fan still opens "a scatti"
(in jerks) while the model is Thinking or streaming. That task measured on
the simulator and saw about 60 fps before and after. Its metrics were the UI
frame rate and the JS rAF rate. Neither metric tells whether the fan's items
actually get to their open state. A spinning arc keeps the screen updating at
60 fps even while the items are frozen. This task measures that property
directly (AGENTS §2: "prove the exact property").

Hypothesis from the brief, tested and not taken on trust: during a stream,
the JS thread is saturated by one transcript re-render per chunk, so the
fan's open waits behind it.

**Repro** (2026-11-19, iPhone 17 Pro Max simulator `0B43D716…`, iOS 26, a
Release build from the e2e harness on an ephemeral port, the mock model).
- New `ptrace` instrumentation (permanent, below).
- A temporary flow, `90-perf-fan` (added to `FLOWS` only for these two runs,
  then removed), does the following:
  1. Pairs and opens a seeded session.
  2. Runs two `SHOWCASE` turns, so the transcript holds markdown, tables and
     code.
  3. Opens and closes the fan 3× at rest.
  4. Sends `THINKHOLD FAST hub`. This is a new mock mode: a reasoning delta
     every 10 ms, about 88 folds/s measured, which is a real model's token
     rate.
  5. Opens and closes the fan 5× while that streams, holding each open ~0.9 s.
  6. Opens the fan once more and taps Stop.
- The `ptrace` lines are read from the app's
  `Documents/tentacle-log.txt` (`grep ptrace`).

Before the fix (HEAD + instrumentation only):

```
fan stream=false: n=3 start=[20, 24, 8]  settle=[1065, 1071, 1054] starts=[1, 1, 1]
fan stream=true:  n=6 start=[17, 18, 17, 22, 26, 18] settle=[-1, -1, -1, -1, -1, -1]
                  starts=[393, 394, 405, 390, 394, 424]
jank windows while streaming: 73 (1 s windows with a JS frame gap > 32 ms)
  gaps/s mean 3.9 · worst gap 133 ms (median of worsts 44) · lost 98 ms/s
  folds/s 88 · notifies/s 88 · renders/s 81 · SessionScreen render→commit 642 ms/s (7.9 ms each)
```

What this shows:
1. **The root cause of the jerky open.** While a turn streams, the fan's
   opening animation is restarted about 400 times per open and never finishes
   (`settle=-1`). At rest it starts once and settles in about 1.06 s. The
   mechanism:
   - Every chunk triggers `setState` in `SessionScreen`.
   - That re-renders `FloatingActivity`, which is not memoized.
   - `FloatingActivity` passes `motion={fanMotion(reduceMotion)}`, and
     `fanMotion` returned a **new object per call**.
   - `HubFan`'s `useEffect(..., [grow, motion])` therefore ran again and
     re-`start()`ed every item's spring from where it stood. Each restart also
     re-applied the item's stagger `delay: i * 18 ms`.
   - With a re-render every ~11 ms, items past the first ones barely move, and
     the first ones restart with zero velocity: jerks.
   - The native driver could not help. The animation itself was being stopped
     and restarted from JS.
   - The simulator showed it as well; the native-driver task's metric (fps)
     could not see it.
2. **The brief's hypothesis is half right.** The JS thread does one
   `SessionScreen` render per streamed chunk: notifies = folds = 88/s. That
   costs ~64 % of the Mac's JS time, and on a phone's slower core that is
   saturation. On the simulator, though, the tap still reached JS in 8–26 ms
   (`wait`, `start`), so **the delay to the first frame was not the visible
   problem here**. The restarts were. The render load is the device-side risk
   that multiplies them. It is fixed too, because it is what makes a phone's JS
   thread fall behind.

## Implementation

*— claude-opus-5-5, 2026-11-19*

### Load-bearing assumption
A screen notification carries no data. `SessionScreen`'s listener calls
`setState(next)` with `controller.state()` read at notify time
(`session-screen-controller.ts` `emit` → `state()`). Deferring a notification
therefore delays a render but cannot lose or reorder content. This is proven by
`session-screen-stream-render.test.ts`: the deferred notification shows `w49`,
the last of 50 deltas, and the turn end shows `a b c` whole.

### Preconditions (checked)
- Streamed prose arrives as `text` / `reasoning` events
  (`packages/agent/src/agent.ts` `AgentEvent`). Every other event is rare and
  must show at once: tool cards, turn end, asks.
- `transcript.ts` keeps unchanged row objects (the `RowGuard` `resetKey`
  comment relies on it), and `joinRows` keeps identity when nothing joins.
  Row identity is therefore a valid memo key.
- `stepLayout` / `noticeLooks` rebuild their per-row objects on every pass, so
  those two must be compared by content.
- The repo has no RN component renderer for tests. Components are pinned from
  source (the `hub-native-driver-wiring` pattern), and the decisions live in
  pure modules (§7).

### Design
1. **The fan starts once per open.** `fanMotion` returns one frozen object per
   mode. `HubFan` is `memo`ized. `FloatingActivity` hands it a stable
   `onTapOverlay` (`useCallback` on the stable driver). Every other prop is
   already stable while the fan is unchanged (the `fan` state's fields,
   `palette`, `bounds`).
2. **Coalesced stream renders.** A pure `render-coalesce.ts` exports
   `createRenderCoalescer({ fire, clock, schedule })`:
   - `soon()` fires at once after a quiet window (leading edge), else at most
     once per `STREAM_RENDER_MS = 100` ms.
   - `now()` fires immediately and absorbs a pending `soon()`.
   - `dispose()` drops a pending fire.

   The feed tags a `text` / `reasoning` fold as `put(next, "stream")`. The
   controller calls `render.soon()` for those and `emit()` (= `render.now()`)
   for everything else.
3. **Memoized transcript cells.**
   - The `RowGuard → SwipeTime → TranscriptRow` subtree moves into
     `screens/transcript/TranscriptCell.tsx`, which is `memo`ized with
     `sameCellData` (pure, `transcript-cell.ts`).
   - The comparison is identity for every field, and content for the `StepCell`
     and `NoticeLook` objects.
   - Callbacks go through one stable `actions` ref that the screen refreshes on
     every render, so a skipped cell's tap still reaches the latest closures.
   - Result: a stream redraws its last row, not every visible row with its
     markdown re-parse.
4. **`ptrace`** (permanent): `perf-trace.ts` is pure, and `perf-probe.ts` holds
   the rAF loop and the sink into the ONE app log. App-log kind `ptrace`,
   numbers and enums only (D7/F16).
   - `ev=jank`: one line per 1 s window in which a JS frame gap was > 32 ms.
     Fields: `gaps`, `worst`, `lost`, `stream`, and what the screen did
     (`folds`, `notifies`, `renders`, `renderMs`).
   - `ev=fan`: one line per open. Fields: `wait` (touch → JS handler, from the
     native touch timestamp when it is on the JS clock, else `-1`), `start`,
     `settle` (`-1` = never finished), `starts`, `stream`.
   - The rAF loop runs only while a turn streams or a fan is opening, never at
     rest.

### Files
- `src/render-coalesce.ts`, `src/transcript-cell.ts`, `src/perf-trace.ts`,
  `src/perf-probe.ts`, `src/screens/transcript/TranscriptCell.tsx` (new).
- `src/session-feed.ts`: the `put` cause.
- `src/session-screen-controller.ts`: the coalescer, plus the `schedule` and
  `onStreamFold` deps.
- `src/hub-fan.ts`: `fanMotion` constants.
- `src/ui/HubFan.tsx`: memo, and start/settle probes.
- `src/ui/FloatingActivity.tsx`: the stable tap handler, and the
  touch/open/close probes.
- `src/screens/SessionScreen.tsx`: the cell, the actions ref, and the
  render/notify/streaming probes.
- `src/app-log.ts`: the `ptrace` kind.
- `App.tsx`: attaches the log and wires `onStreamFold`.
- `e2e/mock-model.ts`: `THINKHOLD FAST`.

### Failure modes
- **The last delta is never shown.** Impossible: a pending `soon()` always
  fires by the window's end, and the turn's `turn_ended` is a `now()`.
  Tested.
- **A tool card or ask is delayed by a pending delta.** No: `now()` fires
  synchronously and cancels the timer. Tested.
- **A timer fires after unmount.** `dispose()` cancels it, and `notifyListeners`
  also checks `disposed`.
- **A stale callback in a skipped cell.** Callbacks are read through
  `actions.current` at tap time.
- **A cell that should redraw is skipped.** Every drawn prop is in
  `sameCellData`, and each one is tested to force a redraw. A future prop added
  to `TranscriptRow` must be added there too; this is noted in the module
  header.
- **Wrong `wait` from a different clock base.** `usableTap` drops a timestamp
  that is after the handler or more than 5 s older than it.
- **Log volume.** At most one `jank` line per second, only while janky, plus one
  `fan` line per open. The ring holds 500.

### Tests
- `render-coalesce.test.ts` (8), `transcript-cell.test.ts` (3), and
  `perf-trace.test.ts` (11) for the pure modules.
- `session-screen-stream-render.test.ts` (3), at the controller boundary:
  50 deltas give ≤ 2 notifications; turn end is immediate and complete; a tool
  card is not delayed.
- `hub-fan.test.ts`: `fanMotion` identity.
- `fan-jank-wiring.test.ts` (7) for the source pins.
- `e2e-mock-thinkhold.test.ts`: `FAST`.
- Seven existing source-pin tests were retargeted from `renderItem`'s inline
  JSX to `TranscriptCell.tsx`, with the same properties: row guard, swipe time,
  notice look, hidden cell, chart labels, artifact card, agent-card focus.

## Execution

*— claude-opus-5-5, 2026-11-19*

1. Built the `ptrace` probe first and measured HEAD with it (Context, before).
   The bundle had 1527 modules.
2. Red at the boundaries, on the unfixed code:
   - `session-screen-stream-render`: `Expected <= 1, Received: 50`, one screen
     notification per delta.
   - `hub-fan` identity: `fanMotion(false) !== fanMotion(false)`.
3. Applied the fix (Design 1–3) and retargeted the source pins.
4. Measured the after build with the same flow on the same simulator. The bundle
   had 1530 modules, the three new ones.

```
fan stream=false: n=3 start=[13, 23, 10] settle=[1059, 1069, 1056] starts=[1, 1, 1]
fan stream=true:  n=6 start=[19, 17, 18, 24, 14, 21] settle=[1068, 1063, 1064, 1069, 1060, 1071]
                  starts=[1, 1, 1, 1, 1, 1]
jank windows while streaming: 0 (no JS frame gap > 32 ms in the whole stream)
```

| | before | after |
|---|---|---|
| fan opening starts per open, streaming | 390–424 | 1 |
| fan settled, streaming | never (`-1` ×6) | 1060–1071 ms (= at rest, 1056–1069) |
| touch → animation start, streaming | 17–26 ms | 14–24 ms |
| 1 s windows with a JS gap > 32 ms while streaming | 73 | 0 |
| screen notifications per streamed delta | 1 (88/s) | ≤ 1 per 100 ms (test: 50 deltas → ≤ 2) |

The renders per second after the fix are not in the device trace: `jank` lines
are written only for janky windows, and none occurred. The ≤ 10/s figure comes
from the controller test, not from the simulator log.

5. Mutation (non-vacuity), reverted afterwards:
   - `render.soon()` → `emit()`.
   - `speak` dropped from `sameCellData`.
   - `fanMotion` returns a spread copy.

   Each was caught: 4 tests failed (stream-render, wiring, `sameCellData`,
   `fanMotion` identity).
6. Removed the temporary `90-perf-fan` flow and its two `run.ts` entries. The
   flow is kept for re-runs in `.tentacle/tmp/mobile-fan-jank-device/` along
   with both raw `ptrace` captures and `stats.py`.

Drift from the brief:
- The tap → first-frame path needed no "pre-mounted items / value flipped on
  press-in" rework. Measured, the touch → start latency is 14–26 ms with or
  without a stream. The jerks came from restarts, not from a late start.
  Pre-mounting would add an always-mounted fan (a dozen views and SVGs on every
  session screen) for no measured gain, so it was not done. If the device
  `ptrace` shows a large `wait`/`start` under a stream, revisit it.
- An accidental scratch copy under `/tmp` was made during the mutation step and
  deleted at once.

Gate (2026-11-19): `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit`
clean · `bun run lint` clean (2113 files) · `bun test`: 15537 pass, 5 skip, 0 fail
(5 skips = the same count the native-driver task recorded on `main`).

### Capturing `ptrace` on the iPhone (owner)
1. Install a build from this branch.
2. Open a session with real content and send a prompt that thinks and streams
   for a while.
3. While it streams, tap the hub 4–5 times, letting the fan open fully each
   time, and close it.
4. Optionally, open it 2–3 times at rest, after the turn ends.
5. Wait 3 s (the log drains to its file every 2 s). Then go to Settings →
   **Export logs** and share the file.
6. Run `grep ptrace tentacle-logs-*.txt`. What to read:
   - `ev=fan … starts=1 settle≈1060` is healthy.
   - `starts>1` means a re-render restarted the open.
   - `settle=-1` means it never finished.
   - A large `wait`/`start` means the tap waited on a busy JS thread.
   - `ev=jank` lines mean the JS thread missed frames in that second, with
     `renders`/`renderMs` saying how much of it was the session screen.
