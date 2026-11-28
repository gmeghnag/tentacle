# feat/mobile-ui-fluidity-s2 — owned clocks: the label counts from the event's own start, on the UI thread

> **Status:** implementation (APPROVED — orchestrator decisions below, owner delegated the details 28/11)
> **Branch:** `feat/mobile-ui-fluidity-s2`
> **Size:** M · **Blast:** cross-module (a new native module + the transcript fold + the step rows) · **Suited:** Opus plan + fresh-context Opus review, Sonnet exec (simulator)
> **Changelog:** `changelog.d/mobile-ui-fluidity-s2.fixed.md` — `- **The Thinking counter keeps time.** On the iPhone the "Thinking · N s" label and a running step's duration count from the moment the event started and tick on the UI thread, so a busy stream or reopening the session no longer freezes them or resets them to 0 s.`

Source of truth: `docs/eval/mobile-ui-fluidity.md` (APPROVED 28/11) — Root cause §4–5,
Owner decision 2 (native `ClockText`, now), Migration plan row 2. Scope = that row only.

## Context

*— claude-opus-5-5, 2026-11-28*

The eval proved the Thinking clock is a JS timer behind a saturated JS thread
(device: the JS thread 75–100 % busy for whole turns, single stalls of 24–42 s).
Two defects, both in this slice:

1. **Wrong origin.** `ThinkingNode` takes its origin from its MOUNT
   (`useRef(Date.now())`, `apps/mobile/src/ui/StepNode.tsx:699`), so a remount
   (reopen, resync, the list re-creating its footer) shows `0 s` again although
   the transcript already holds the real start times.
2. **JS-timed tick.** Every clock is `setInterval` + `setState` per mounted row
   (`useElapsed`, `StepNode.tsx:70-82`, used at `:473` and `:700`); behind the
   stream's renders it freezes, then jumps — measured: long session
   `1 1 1 1 11 11 15 17 s` against wall time (eval, Root cause §5).

Owner decision 2 (28/11): a small native view `ClockText` in `apps/mobile/modules/`
ticks on the main thread from the event's timestamp; the pure `clock.ts` stays the
source of the format and of the elapsed value (tests, web, the fallback); the
Swift side mirrors the format, pinned by ONE shared vector table. Needs a dev
build (not OTA). Earlier slices on `main`: s0 (perf gate `90-perf-stream`, the
gate for this slice: must improve or hold) and s1 (thumbnail feedback loop). Their
Execution sections report no drift touching clocks or the step rows.

**Repro** (`.tentacle/tmp/mobile-ui-fluidity-s2/repro.ts`, 2026-11-28, on `main` @ `87e90a4f`):

```ts
import { stepLayout } from "../../worktrees/mobile-ui-fluidity-s2/apps/mobile/src/tool-steps.ts";
import { apply, initialState } from "../../worktrees/mobile-ui-fluidity-s2/apps/mobile/src/transcript.ts";
const T0 = 1_800_000_000_000;
let s = initialState;
s = apply(s, { type: "user_message", text: "hi" } as never, T0);
s = apply(s, { type: "reasoning", delta: "hmm" } as never, T0 + 3000);
console.log("rows:", JSON.stringify(s.rows.map((r) => ({ kind: r.kind, at: (r as { at?: number }).at }))));
console.log("tail:", JSON.stringify(stepLayout(s.rows, true).tail));
```

```
rows: [{"kind":"user","at":1800000000000},{"kind":"reasoning","at":1800000003000}]
tail: {"thought":"hmm","up":false}
```

The rows carry the start times; the tail the Thinking node draws from carries
none, so the node can only count from its own mount.

## Implementation

*— claude-opus-5-5, 2026-11-28* — **APPROVED** (orchestrator, owner-delegated; no §7 trust rule touched).

### Load-bearing assumption

**A Swift Expo view can change its own text and report its new size to Yoga
without a JS render.** Proven by source (expo-modules-core 58.0.24, `bun.lock:1127`):
`ExpoView` is `ExpoFabricView` (`ios/Core/Views/ExpoView.swift:3`);
`ExpoFabricView.setViewSize(_ size: CGSize)` (`ios/Fabric/ExpoFabricView.swift:46-48`)
calls `setShadowNodeSize`, which on RN ≥ 82 submits a shadow-node size state patch
(`ios/Fabric/ExpoFabricViewObjC.mm:252-262`); the app is on RN 0.88
(`apps/mobile/package.json:36`). **Not proven by source:** that this state commit
lands without the JS thread. It is called only when the label's WIDTH changes
(at 1 s, 10 s, 1 min, 10 min, 1 h…), so at worst a boundary crossed during a JS
stall draws past its box briefly (Failure modes). Execution step 1 checks it on
the simulator before anything else is built on it.

### Preconditions

- The rows already hold receipt times (epoch ms, phone clock for live inputs):
  `UserRow.at` (`src/transcript-rows.ts:44-50`), `ReasoningRow.at` = first delta's
  receipt (`:95-96`), `ToolRow.at` (`:110-115`), `ContextRow.at` (`:209-210`);
  `apply(state, input, now)` stamps them (`src/transcript.ts:232-233`, `:273`, `:290`).
  History rows carry the daemon's times (`:229-231` comment).
- A tool result's fold has the receipt time in hand but stores no end stamp:
  `applyToolResult(state, event, when: At)` (`src/transcript.ts:828-831`), the
  update at `:841-856` writes `durationMs` only.
- The tail exists iff `isThinking(rows, running)` (`src/tool-steps.ts:98-119`):
  last row reasoning/user/context, or a finished trailing tool batch; its shape
  `{ thought, up }` (`:67`, built at `:288`).
- Running step rows already use an EVENT time, not mount: `liveFrom: tool.at`
  (`src/screens/transcript/TranscriptRow.tsx:827`); the compaction slot passes
  `slot.since` (`src/ui/StepNode.tsx:758`). Only the Thinking node uses mount time.
- Two formats exist and must both move to `clock.ts` unchanged:
  `thinkingElapsed` (`src/thinking-motion.ts:99-110`: `0 s`, `1 min 05 s`, `1 h 02 min`)
  and `liveElapsed` (`src/tool-summary.ts:504-510`: `""` under 1 s, `2 min 5 s`).
  Spoken: `thinkingA11yLabel` (`src/tool-steps.ts:726-736`).
- Local modules autolink from `apps/mobile/modules/` with only
  `expo-module.config.json` + `ios/` (`modules/tentacle-preview/`, podspec
  `ios/TentaclePreview.podspec`); JS reaches them with
  `requireOptionalNativeModule` and degrades to `null`
  (`src/preview-native-expo.ts:10,23`); `expo` exports `requireNativeView`
  (`node_modules/expo/build/Expo.d.ts:5`).
- Swift logic is already pinned to shared JSON vectors by a SwiftPM package run
  as `bun run test:swift` (root `package.json:32`), symlinking the app's own sources
  (`apps/mobile/native-tests/PushCoreTests/Package.swift:1-29`, `Sources/LACore ->
  ../../../targets/live-activity/LACore`), loading vectors from the repo by
  `#filePath` (`Tests/PushCoreTests/PushCoreTests.swift:21-46`); it is a mandatory
  preflight of `bun run e2e:mobile` (`e2e/run.ts:471-478`).
- Source-pin tests that this slice must update, not delete:
  `test/tool-rows-wiring.test.ts:176-185` (`thinkingLabel(ms)` in `ThinkingNode`),
  `test/motion-literals.test.ts:69` (`STEP_ELAPSED_TICK_MS`), the export
  allowlist `test/thinking-motion.test.ts:199-200`.
- No protocol, persistence or §7 trust surface is touched (phone-only render path).

### Orchestrator decisions

1. **Where the Thinking clock starts — the period's opener, from the rows**
   (recommended, taken). `tail.since` = the stamp of the row that OPENED the
   thinking period: the user row's `at`, the context row's `at`, or the trailing
   finished tool batch's new `endedAt` (max of the batch); else (the opener is
   assistant text, or has no stamp) the first trailing reasoning row's `at`;
   else absent. This reproduces today's visible semantics exactly (the node
   mounts when the tail appears = the opener's receipt) but survives remounts.
   Rejected: "first reasoning delta" alone (the label would jump BACK from 3 s to
   0 s when reasoning starts after a prompt); a controller-held stamp (lost on
   reopen). Absent ⇒ no number (just `Thinking`), never mount time.
2. **`ToolRow.endedAt`** stamped at the result's receipt (`when.at`), live only;
   a history row has none (falls to rule 1's next case).
   *Amended in fix round 1 (claude-sonnet-5-5), review finding 3:* a history row
   takes the result message's daemon time (`times[i]`; `0` / missing → none).
3. **JS fallback ticker: ONE app-wide sampler at 250 ms, re-render only on a
   changed string** (recommended, taken over the eval's "1 s ticker"): a 1 s
   sampler shared by clocks with different origins skips or repeats a second when
   its phase meets an origin's; at 250 ms each subscriber's
   `useSyncExternalStore` snapshot is its FORMATTED label, so React re-renders a
   leaf only when its text changes (≤ 1/s). One timer while ≥ 1 subscriber, none
   otherwise.
4. **Native module `tentacle-clock`, view `ClockText`**, gated by
   `requireOptionalNativeModule("TentacleClock") !== null` (a build without it,
   web, tests ⇒ the JS `<Text>` fallback). Props: `since` (epoch ms), `format`
   (`"thinking" | "step"`), resolved `fontSize`/`lineHeight` (the JS side applies
   `min(fontScale, DENSE_FONT_SCALE)`, `theme.ts:395`, as the RN `Text` does
   today), `color`, `tabular`. iOS only, like the other two modules.
   *Amended in Execution (claude-sonnet-5-5):* plus an optional `fontFamily` —
   every RN text goes through the app-font seam (`ui/Text.tsx`, the Figtree beta
   theme), which a native `UILabel` would otherwise bypass.
5. **Swift format pinned by vectors through the existing SwiftPM package** (a new
   `ClockCore` target symlinked like `LACore`), vectors in
   `apps/mobile/test/fixtures/clock-format-v1.json`, read by the TS test and the
   Swift test. No second Swift package.
6. **Spoken label:** the Thinking row's `a11yLabel` keeps counting through
   `useSince` (JS, ≤ 1 re-render/s of that one row — what it costs today); the
   visible figures are native. Step rows' a11y labels are static (unchanged).
   Gating the spoken tick on VoiceOver is left as debt.
7. **Gate 0 clock check (the eval row's "label within 2 s of wall")** added to
   `90-perf-stream`: read the native label twice via Maestro `copyTextFrom`
   (id `thinking-clock`) across the 4 hub opens under load; a script asserts
   `|Δlabel − Δwall| ≤ 2 s`. AI-free. If `copyTextFrom` cannot read the label,
   STOP and report (do not swap in an AI/screenshot judge).

### Design

- **`src/clock.ts` (pure, React-free):** `type ClockFormat = "thinking" | "step"`;
  `formatClock(format, ms)` (the moved bodies of `thinkingElapsed` / `liveElapsed`;
  those names stay exported from their old modules as re-exports so their tests
  and allowlist stand); `elapsedSince(since, now) = max(0, now - since)`;
  `thinkingSince(rows)` is NOT here (it reads rows: `tool-steps.ts`);
  `createClockSampler({ now, schedule }, periodMs)` → `{ subscribe(fn) → unsubscribe,
  now() }`: one scheduled callback while subscribers exist, each wake re-aimed at
  the next `periodMs` boundary of `now()` (the `run-clock.ts:36-44` pattern), so a
  late wake is not carried forward.
- **`src/use-since.ts`:** the module's ONE sampler with real deps
  (`Date.now`, `setTimeout`), `CLOCK_SAMPLE_MS = 250` (in `motion.ts`, pinned);
  `useSince(since: number | undefined, render: (ms: number | null) => string): string` =
  `useSyncExternalStore(sampler.subscribe, () => render(since === undefined ? null : elapsedSince(since, sampler.now())))`
  (with `since` absent it does not subscribe; `null` renders the no-number form).
  Labels are derived, never stored: a remount reads the same value.
- **Fold:** `applyToolResult` adds `...(when.at === undefined ? {} : { endedAt: when.at })`.
- **`stepLayout`:** `tail: { thought, up, since? }`, `since` from
  `thinkingSince(rows)` (decision 1), spread only when defined (existing
  `toEqual` expectations on unstamped rows keep holding).
- **Native `modules/tentacle-clock/`:** `ios/ClockCore/ClockCore.swift`
  (Foundation-only: `formatClock(_ format: String, _ ms: Double) -> String`,
  byte-for-byte the TS rules); `ios/ClockTextView.swift` (`ExpoView` holding a
  `UILabel`; on prop set and on each tick: text = `formatClock(format, max(0, now − since))`,
  set only if changed; if the label's fitted width changed → `setViewSize`;
  `monospacedDigitSystemFont` when `tabular`; a block-based `Timer` with a weak
  self, added to `RunLoop.main` in `.common` mode (ticks while scrolling), each
  fire re-aimed at the next whole second of `now − since`; invalidated on
  `removeFromSuperview`/`deinit`; `clipsToBounds = false`; the view is an
  accessibility element whose label is the text, identifier from `testID`);
  `ios/TentacleClockModule.swift` (`Module { Name("TentacleClock"); View(ClockTextView.self) { Prop(...) } }`);
  `ios/TentacleClock.podspec`, `expo-module.config.json`, `README.md`.
- **`src/ui/ClockText.tsx` (dumb renderer):** native view when available, else
  `<Text>{useSince(since, (ms) => formatClock(format, ms))}</Text>` with the same
  style tokens; passes `testID`.
- **`StepNode.tsx`:** `useElapsed` deleted (no `setInterval`, no `Date.now` in the
  file). `StepNode` gets `clock?: ClockFormat` (default `"step"`); with `liveFrom`
  it draws `<ClockText since={liveFrom} format={clock} …/>` in the trailing slot,
  else `trailing` as today. `ThinkingNode({ since?, … })`: no `useRef(Date.now())`;
  `liveFrom={since}` `clock="thinking"`, `a11yLabel = useSince(since, thinkingA11yLabel)`
  (`"Thinking"` when absent); testID `thinking-clock` on the clock.
- **`SessionScreen.tsx:2177`:** `since={layout.tail.since}` (conditional spread).

### Files

In dependency order (no protocol/daemon/client change):

1. `apps/mobile/test/fixtures/clock-format-v1.json` (new) — the vector table: `{ thinking: [[ms, label]…], step: [[ms, label]…] }`, covering −5, 0, 999, 1000, 9 999, 10 000, 59 999, 60 000, 65 000, 125 400, 3 599 000, 3 600 000, 7 320 000, 36 000 000.
2. `apps/mobile/src/clock.ts` (new); `src/thinking-motion.ts`, `src/tool-summary.ts` (bodies → re-exports); `src/motion.ts` (`CLOCK_SAMPLE_MS`; `STEP_ELAPSED_TICK_MS` doc now names the native tick).
3. `apps/mobile/src/use-since.ts` (new).
4. `apps/mobile/src/transcript-rows.ts` (`ToolRow.endedAt?`), `src/transcript.ts` (`applyToolResult`).
5. `apps/mobile/src/tool-steps.ts` (`thinkingSince`, `tail.since`).
6. `apps/mobile/modules/tentacle-clock/` (new: `expo-module.config.json`, `README.md`, `ios/TentacleClock.podspec`, `ios/TentacleClockModule.swift`, `ios/ClockTextView.swift`, `ios/ClockCore/ClockCore.swift`).
7. `apps/mobile/native-tests/PushCoreTests/Package.swift` (+ `ClockCore` target), `Sources/ClockCore` (symlink → `../../../modules/tentacle-clock/ios/ClockCore`), `Tests/PushCoreTests/ClockCoreTests.swift` (new; its own `#filePath` loader for `clock-format-v1`).
8. `apps/mobile/src/ui/ClockText.tsx` (new), `src/ui/StepNode.tsx`, `src/screens/SessionScreen.tsx` (one prop).
9. `apps/mobile/e2e/flows/90-perf-stream.yaml`, `e2e/flows/90-clock-mark.js`, `e2e/flows/90-clock-check.js` (new); the flow pins in `test/e2e-flows.test.ts` if they count steps.
10. Tests (below); `changelog.d/mobile-ui-fluidity-s2.fixed.md`.

### Failure modes

| Case | What happens / how it converges |
|---|---|
| No stamp at all (unit fold, an older daemon's history with `times[i]` 0) | `since` absent → the node shows `Thinking` with no number; never mount time; the next stamped row restores it |
| Reopen / resync / footer remount mid-turn | label re-derived from `since` → same value, no `0 s` (the defect this slice fixes) |
| Reattach mid-reasoning | opener (user row) usually comes from history with the daemon's time → correct; reasoning rows rebuilt by replay get receipt times, used only when no opener stamp exists |
| Phone ↔ Mac clock skew on history stamps | clamp `≥ 0` (phone behind → `0 s` until it catches up); phone ahead → inflated by the skew (NTP: ≈ seconds). Accepted; live rows use the phone's own clock |
| JS thread stalled | native label keeps ticking (UI-thread `Timer`); only the spoken label and a width resize wait. A width boundary crossed during the stall draws past the box (`clipsToBounds = false`, trailing slot) until the size commit lands — checked in Execution step 1 |
| App backgrounded | timer suspended with the app; first fire after resume re-aims from wall time → correct label, no drift |
| Scroll in progress | `.common` run-loop mode → keeps ticking |
| Row unmounts / recycles | timer invalidated in `removeFromSuperview`/`deinit`; weak self → no retain cycle |
| Many running steps | N native timers on the UI thread (each ~1 µs/s); JS: one sampler, string-equal bail-out |
| Build without the module (old dev client, Android, web, bun tests) | `requireOptionalNativeModule` → `null` → JS `ClockText` (the old behaviour, minus per-row intervals) |
| Swift and TS formats drift | both suites read `clock-format-v1.json`; `test:swift` is a mandatory e2e preflight |
| Dynamic Type change | `fontScale` from `useWindowDimensions` (already read, `StepNode.tsx:476`) changes the resolved size prop → native re-measures |
| Reduce Motion | a clock is content, not motion: it ticks (as today) |

### Tests

Red first on the assertion (stubs/empty bodies, never an import error), then green (AGENTS §9):

- **`test/clock.test.ts` (new):** every vector of `clock-format-v1.json` through
  `formatClock` (red: stub returns `""`); the re-exports equal `formatClock`;
  sampler with a fake `{ now, schedule }`: 1 scheduled callback for 5 subscribers,
  0 after the last unsubscribes, a wake 900 ms late is re-aimed at the next
  boundary (delay ∈ (0, period]), `elapsedSince` clamps negative to 0.
- **`test/tool-steps*.test.ts`:** `tail.since` = user `at` (prompt then reasoning
  3 s later: still the user's — the "no jump back" property); = max `endedAt` of a
  finished parallel batch; = first reasoning `at` after assistant text; absent
  with no stamps. Red today: `since` is `undefined` (repro above).
- **`test/transcript*.test.ts`:** a `tool_result` folded with `now` sets `endedAt`;
  without `now`, none; a history fold, none.
- **`test/clock-wiring.test.ts` (new, source pins):** `ui/StepNode.tsx` has no
  `setInterval`, no `Date.now`, no `useRef(Date.now())`; `ThinkingNode` passes
  `since` through and `SessionScreen.tsx` passes `layout.tail.since`;
  `ClockText.tsx` gates on `requireOptionalNativeModule("TentacleClock")`;
  `ClockCore.swift` imports only Foundation; `ClockTextView.swift` uses
  `setViewSize`, `.common`, and `[weak self]`. Red today on the first three.
- **`test/tool-rows-wiring.test.ts:176-185`:** rewritten to the new shape (the
  label from `since`, tabular kept); `motion-literals` pins `CLOCK_SAMPLE_MS: 250`.
- **Swift `ClockCoreTests`:** every vector through `ClockCore.formatClock` (red
  with a stub returning `""`; `bun run test:swift`).
- **Mutations to run and record:** `thinkingSince` returning the first reasoning
  `at` (the "no jump back" test must fail); sampler without re-aim (the late-wake
  test must fail); one Swift vector rule changed (e.g. no zero-pad) → `test:swift` red.
- **Simulator (under `.tentacle/tmp/orchestration/sim.lock`, Release dev build, nothing published):**
  1. FIRST, the load-bearing check: with `ClockText` alone on a running step,
     block the JS thread (the s0 long session + `THINKHOLD FAST`) across the
     9 → 10 s and 59 s → 1 min boundaries; screenshots show the label ticking and
     the resized box. If the resize waits for JS, record it (Failure modes row) —
     no design change unless the text is clipped.
  2. `--only 90-perf-stream` on `main` (baseline) then on the branch: the clock
     check expected red on `main` (frozen JS label), green on the branch; gap /
     settle / renders-per-s violations **hold or improve** vs the baseline run.

## Execution

*— claude-sonnet-5-5, 2026-11-28* — **PARTIAL**: JS/TS done and green; the native
half is written but never compiled or run.

### Open before merge (this session's permissions denied `ln`, `swift`)

1. Create the symlink of file 7, from the worktree root:
   `ln -s ../../../modules/tentacle-clock/ios/ClockCore apps/mobile/native-tests/PushCoreTests/Sources/ClockCore`
   Until then `bun run test:swift` (and so the `e2e:mobile` preflight) fails for
   the WHOLE package: `Package.swift` already declares the `ClockCore` target.
2. `bun run test:swift`, plus its red/mutation proof (stub `formatClock` → `""`,
   or drop the zero-pad). Neither was run.
3. Dev build + both simulator steps (load-bearing resize check; `90-perf-stream`
   on `main` and branch). Not run. Watch two things: (a) whether Maestro can
   `copyTextFrom` `thinking-clock`, which sits inside the row's accessible
   `Pressable` — if not, STOP per decision 7; (b) `main` has no `thinking-clock`
   id, so its baseline fails on the missing element, not on a frozen figure.

### Checks before editing

- Load-bearing, by source: holds (`ExpoView.swift:3`,
  `ExpoFabricView.swift:46-48`, `ExpoFabricViewObjC.mm` `setShadowNodeSize` →
  `submitSizePatch`, `RCTAssertMainQueue`; RN 0.88.0). `setShadowNodeSize` is
  dropped while `_state` is nil. On-device half: open item 3.
- Repro (`.tentacle/tmp/mobile-ui-fluidity-s2/repro.ts`): before
  `tail: {"thought":"hmm","up":false}`; after
  `tail: {"thought":"hmm","up":false,"since":1800000000000}`.

### As built, per slice

| Slice (files) | State | Red first |
|---|---|---|
| vectors, `clock.ts`, `motion.ts`, old formatters delegate (1–2) | DONE | stub: 8 of 9 `clock.test.ts` fail |
| `use-since.ts` (3) | DONE | covered by sampler tests + source pins |
| `endedAt`, `thinkingSince`, `tail.since` (4–5) | DONE | 8 new tests fail |
| native module (6) | WRITTEN, not compiled | — |
| SwiftPM target + `ClockCoreTests` (7) | PARTIAL: no symlink, not run | — |
| `ClockText.tsx`, `StepNode.tsx`, `SessionScreen.tsx` (8) | DONE (JS) | 3 JS wiring pins fail; the 3 Swift source pins were written after the Swift, never red |
| flow 90 + two scripts (9) | WRITTEN, not driven | 2 new tests fail (order; scripts absent) |
| changelog fragment (10) | DONE | — |

### Drift from Implementation

- `fontFamily` prop (decision 4, amended above).
- `ClockText` measures on the next main-loop turn after props / layout / window,
  not inside the prop set: a first mount's props land before the shadow state.
  It compares with `bounds`, so a dropped request is retried at the next layout.
- `StepNode` also takes `clockTestID` (the compaction slot shares
  `node="thinking"`, so the id cannot follow the node kind).
- `thinkingElapsed` / `liveElapsed` stay as declared functions calling
  `formatClock` (the export allowlist reads declarations).
- Test-only, not in the file list: seven render tests now stub `expo`
  (`ClockText` imports it); `step-rail-render` and `transcript-type` pinned the
  removed `{shown}` and now pin `{trailing}` / `ClockText`'s `{label}`.
- `tools/mockup-kit/generated/` regenerated (`bun run mockup-kit`): the new
  constant, the removed `tabular` style, source hashes.
- No protocol or schema change.

### Mutations (each reverted)

```
thinkingSince returns the first reasoning `at`  tool-steps.test.ts 49 pass 3 fail
  (fail) … the prompt's stamp, and still the prompt's once reasoning starts (no jump back to 0 s)
sampler without re-aim (delay = periodMs)       clock.test.ts 8 pass 1 fail
  (fail) … a late wake is re-aimed at the next boundary, not carried forward
TS format without zero-pad                      clock.test.ts 8 pass 1 fail
  (fail) formatClock: the shared vector table > thinking: every vector
flow check one-sided (no Math.abs)              e2e-flows -t s2 1 pass 1 fail
Swift rule changed → test:swift red             NOT RUN
```

### Checks run

`bun test apps/mobile/test/` + the three mockup-kit files: 5926 pass, 0 fail
(363 files). Changelog tests: pass. `biome check` on the changed folders: clean.
`tsc -p apps/mobile`: clean. The full gate was not run (the orchestrator's).

### Fix round 1

*— claude-sonnet-5-5, 2026-11-28* — **PARTIAL**: finding 3 fixed; findings 1 and 2
need `ln` / `swift`, which this session's permissions refused (`ln -s …` and
`swift --version`: "requires approval"). Not worked around.

1. **`test:swift` broken — NOT FIXED, now caught by the gate.** To fix, from the
   worktree root, then commit the link:
   `ln -s ../../../modules/tentacle-clock/ios/ClockCore apps/mobile/native-tests/PushCoreTests/Sources/ClockCore`
   New pins in `test/clock-wiring.test.ts` ("the Swift package can load") are RED
   until then, **so `bun run test` fails on this branch, on purpose**:
   ```
   (fail) … every `.target` has its source folder      Received: ["ClockCore"]
   (fail) … `Sources/ClockCore` is the module's own folder   Expected true, Received false
   ```
   Their green side, by temporary edits (reverted): `ClockCore` target removed and
   the link pin aimed at `LACore` → 8 pass 0 fail; the `LACore` link checked
   against the clock folder → 7 pass 1 fail. Green with the real link: not seen.
2. **Native half never compiled or run — NOT FIXED.** Still open: `bun run
   test:swift` + its mutation, the dev build, both simulator steps (Execution
   "Open before merge" 2–3).
3. **Reopen during post-tool thinking — FIXED** (decision 2 amended, see below).
   `transcript-history.ts` stamps `endedAt` from the result message's daemon time
   (`0` / missing → none); `transcript-rows.ts` doc updated. A finished batch is
   committed before the next round (`agent.ts` `history_commit`), so it reopens
   as history. Red first: 2 of 3 new `transcript.test.ts` cases failed
   (`[undefined, undefined]`, `since` `undefined`); the "none" case guards. Drift:
   the old "a history carries none" assertion is replaced.
   ```
   endedAt = the call's `at`          transcript.test.ts 56 pass 3 fail
   endedAt = raw `times[index]` (0)   transcript.test.ts 58 pass 1 fail
     (fail) … an unknown time (no `times`, a short array, 0) stamps none
   ```
   Residual, by source only: a reconnect that REPLAYS a missed `tool_result`
   (attach with `since`) still stamps the replay's receipt time (replayed updates
   fold with the phone's clock).

Checks: `bun test apps/mobile/test/` + three mockup-kit files: 5927 pass, 2 fail
(the two pins above). `biome check` on the changed files: clean. `tsc -p
apps/mobile`: clean. Full gate not run (the orchestrator's).

### Fix round 2 (gate failures)

*— claude-sonnet-5-5, 2026-11-28* — **BLOCKED**, no code changed.

- The two "Swift package can load" fails: `ln -s` (command above) was refused again
  ("requires approval"). Not worked around. `clock-wiring.test.ts`: 6 pass, 2 fail.
  Needs the owner or orchestrator to run it, then fix round 1's open items 1–2.
- `pdf-extract.test.ts` "decompression bomb … RSS bounded": the branch touches nothing
  under `packages/`; alone it gives 28 pass, 0 fail. Likely load-sensitive (it samples
  process RSS; load average ≈ 7–16 here), not proven. Left unchanged.

## Review

*— claude-opus-5-5, 2026-11-28* (fresh context; same model family as the planner,
not the executor). **Verdict: REQUEST-CHANGES.**

Findings:

1. **HIGH — `test:swift` broken for the whole package.** `native-tests/PushCoreTests/Package.swift:26`
   declares `.target(name: "ClockCore")`, but `Sources/ClockCore` does not exist on the
   branch (`ls Sources/` → `LACore`, `PushCore` only). SwiftPM refuses a target with no
   source dir, so `bun run test:swift` (PushCore/LACore included) fails, and so does the
   mandatory `e2e:mobile` preflight (`e2e/run.ts:478`). Merge = the e2e gate on `main` red.
2. **HIGH — the native half has never been compiled or run.** `ClockTextView.swift`,
   `TentacleClockModule.swift` and the podspec autolink into the next dev build. A compile
   error stops the whole iOS build. The load-bearing assumption (`setViewSize` lands
   without JS), the Swift vector suite + its mutation, and both simulator steps (incl.
   decision 7's `copyTextFrom` on `thinking-clock`) are all open (Execution items 1–3).
   I checked the API surface against expo-modules-core 58.0.24 by eye
   (`ExpoFabricView.swift:46,50`, `ViewFactories.swift:70`): it matches. That is not a build.
3. **MEDIUM — a reopen during post-tool thinking still restarts the clock.** `transcript-history.ts:191-200`
   folds a tool result with no `endedAt`, even though `times[index]` (the result message's
   daemon time) is right there. Repro: the turn's last tool batch finished, the model is
   thinking, the phone reopens. `thinkingSince` (`tool-steps.ts:667-673`) then finds no
   batch stamp and falls back to the first reasoning row's receipt (≈ the reopen) or to
   nothing. The label reads `0 s` / no number. That is the common agentic case, and it
   contradicts the changelog ("reopening … no longer resets them to 0 s"). No Failure-modes
   row covers it. Fix: stamp `endedAt` from `atOf(times, index)` on the history result
   (decision 2 amended), plus a test.

Gate (this review): 17 touched test files 343 pass / 0 fail; `bun run lint` clean (2816
files); `bun run typecheck` clean. Full `bun run test` not run (the orchestrator's gate).
`test:swift` / `swift` were denied in this session too, so I did not run them.

Mutations (each reverted, `git status` empty afterwards):
- `thinkingSince` max → min: `tool-steps.test.ts` fails ("the LAST of its results").
- `endedAt` spread removed from `applyToolResult`: 2 `transcript.test.ts` fail.

Premises: `transcript.ts:828-856` TRUE. `isThinking` / tail shape TRUE. `liveFrom: tool.at` TRUE.
The old `thinkingElapsed` / `liveElapsed` bodies equal `formatClock` TRUE. Load-bearing
(on device): UNVERIFIED.

Attacks tried:
- **Max of a parallel batch with partly unstamped rows:** holds.
- **a11y when `since` is absent:** `thinkingA11yLabel(0)` = "Thinking", which matches
  the no-number visual. Holds.
- **Maestro reaching an id nested in the accessible `Pressable`:** precedent exists
  (`tool-…-running` via `labelTestID`). Plausible, still unproven for a native view.
- **Native view width 0 before the first fit:** the label draws past the right edge
  until the size commit lands. This is the plan's accepted row, but nobody has looked
  at it on a simulator.
- **The `useSyncExternalStore` snapshot is a string:** a label that has not changed
  causes no re-render. Holds.

Executor: honest. It marked itself PARTIAL and listed every open item. It never claimed
the Swift side was green.

### Round 2

*— claude-opus-5-5, 2026-11-28* — **Verdict: REQUEST-CHANGES.** Reviewed
`0cf12b3e..HEAD` (the fix is `a4e27574`; HEAD itself is docs only).

- **Finding 3 (MEDIUM): FIXED.** `transcript-history.ts:192,206` stamps `endedAt`
  from `atOf(times, index)`. Mutation (spread removed) → 2 new `transcript.test.ts`
  fail; reverted, `git status` clean. Unknown times (none, short, `0`) stamp nothing
  (tested). No regression in `apps/mobile/test/` apart from the 2 below.
- **Finding 1 (HIGH): OPEN.** `Sources/ClockCore` is still absent (the `ln -s` was
  refused again). The new pins `clock-wiring.test.ts` "the Swift package can load"
  fail (2 fails), so `bun run test` is red on this branch and `test:swift` is still
  broken. The pins themselves are correct: they fail on exactly this state.
- **Finding 2 (HIGH): OPEN.** Native code is still uncompiled. `test:swift` and both
  simulator steps have not run.
- Gate: `apps/mobile/test/` 5848 pass / 2 fail (the two above). Lint clean. Typecheck clean.
- Needed: someone with permission runs the `ln -s` (Execution item 1), then
  `bun run test:swift` + its zero-pad mutation, then a dev build + the simulator steps.
