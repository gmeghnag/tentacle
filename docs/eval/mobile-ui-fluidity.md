# eval/mobile-ui-fluidity — one session-state firehose starves every JS-timed UI

> **Status:** APPROVED by the owner 2026-11-28 — slices promoted one by one as `feat/mobile-ui-fluidity-s<N>`
> **Branch:** none (an `eval`, committed to `main`, AGENTS §10)
> Type: eval · Size: L (split below into S/M sub-tasks, no XL) · Blast: cross-module (mobile session screen, its controller, the hub, the transcript list; no protocol, persistence or §7 trust change) · Suited: Opus plans and reviews every slice (fresh-context review for the store and list slices); simulator-measured, AI-free perf gate per slice
> **Changelog:** none for the eval; each promoted slice names its own fragment

## Context

*— claude-opus-5-5, 2026-11-28*

### The question

Owner report, 28/11 ~00:24: iPhone 12 Pro, 4G, `serve` on the Mac with local
Qwen3.8-27B (long reasoning phases), session `FINANZA` (long: its header ring is
orange, i.e. ≥ 80 % context, `chat-header.ts:112`). While the model is
**Thinking**: (1) the `Thinking · N s` counter does not move, or moves in jumps;
(2) the hub button does not respond, or opens slowly showing ONE item (the
screenshot `.tentacle/tmp/mobile-thinking-jank/owner-screenshot.png`: the native
running arc is turning, only the Stop item has started to appear, the others are
missing). The owner suspects one cause blocking several components, and asked
for an **architectural** fix, not another local patch.

Decision this eval serves: which app-wide pattern makes the session screen (and
every screen that streams) keep its clocks, animations and touches alive under
any stream rate and any transcript length — and in what order to build it.

### Characterization (AGENTS §1)

- **Trigger:** a turn streaming reasoning (or text) on the screen in front. At
  rest the same long session behaves: the hub fan settles in 1068 ms (S3's last
  open, after the stream ended).
- **Magnitude:** scales with **transcript length**, not with the token rate.
  Same 88 deltas/s stream: short session → JS frame gaps ≤ 99 ms, fan settles in
  ~1.1 s; long session (≈ 360 rows) → median worst gap 508 ms, single gaps of
  3.4–10.2 s, fan settles in 4.6 s.
- **Collateral:** the **whole JS thread** is saturated (rAF, `setInterval`,
  `setTimeout`, PanResponder all wait). What keeps moving is only what runs on the
  UI thread: the hub's running arc and the step blink (native-driver loops). That
  is exactly the screenshot: arc turning, fan item 0 started, items 1…n not.

### Root cause (one sentence)

**Every streamed delta ends in a re-render of the WHOLE session screen — header,
composer, hub and every mounted transcript cell — whose cost grows with the
transcript (7 ms → 49 ms per render on the simulator), and those renders arrive
~2× more often than the 100 ms coalescer was designed to allow, so on a long
session the JS thread is 80 % busy on the simulator (more than 100 % on an A14),
and every JS-timed UI — the Thinking clock's `setInterval`, the fan's staggered
`Animated` delays, the hub's gesture — waits behind it.**

Proven (measured or shown by code + a falsifying test):

1. **Render cost ∝ transcript length.** Simulator `ptrace` (below): median
   `renderMs/renders` = **7.1 ms** short vs **48.8 ms** long; the screen's renders
   take a median **17 %** of each second short vs **80 %** long.
2. **Why a render touches every row.** `FlatList`'s `CellRenderer` is a
   `PureComponent` (`@react-native/virtualized-lists/Lists/VirtualizedListCellRenderer.js:63`),
   but the screen passes an inline `renderItem` (`SessionScreen.tsx:2108`, a new
   function per render) and an `extraData` (`:1180`, `:2156`) that changes on every
   stream render because it holds `layout`/`looks`, recomputed from the new `rows`
   (`:866`, `:871`). So every mounted cell re-runs `renderItem` and its memo
   comparison on every render; the `TranscriptCell` memo
   (docs/fix/mobile-fan-jank-device.md) saves the cell's body, not the per-cell
   walk. The pure projections are NOT the cost: `stepLayout + noticeLooks +
   reportsOf` over 701 rows = 0.05 ms JIT / 0.42 ms interpreter (`bench.ts`).
3. **Twice the renders the design allows — a feedback loop.** The screen's effect
   keyed on `rows` (`SessionScreen.tsx:854-856`, added 20/11 in `06d8d093`, the day
   AFTER the fan-jank fix) calls `controller.window(...)` → `driver.view(...)`
   (`session-screen-controller.ts:2189-2191`) → `thumbnails.ts:312`
   `commit(step.state)` **unconditionally** → `onChange` → `emit()`
   (`session-screen-controller.ts:860-866`) → `render.now()`, a second full render
   for every coalesced one. Falsified in isolation (`feedback.ts`, below): 100
   deltas over 1 s give **10** notifications without the effect, **20** with it.
   On the simulator: **18–25 notifications/s** against a design of ≤ 10.
4. **The symptoms are JS timers.** The Thinking clock is `setInterval` +
   `setState` (`ui/StepNode.tsx:71-82`, used at `:700`); the fan's items start with
   `delay: i * staggerMs` (`ui/HubFan.tsx:96-103`, `hub-fan.ts:407`), which RN
   implements as a **JS `setTimeout`** even on the native driver
   (`react-native/Libraries/Animated/animations/SpringAnimation.js:236-237`), so
   item 0 (delay 0) starts natively and items 1…n wait for the JS thread — the
   screenshot. The hub's gesture is a JS `PanResponder` and its long-press a JS
   `setTimeout` (`ui/FloatingActivity.tsx:370`, `:419-455`).
5. **Symptom 1 reproduced.** Screenshots every ~2 s of the `Thinking` label while
   the stream runs: short session `4 6 8 9 11 13 15 17 s` (follows wall time);
   long session **`1 1 1 1 11 11 15 17 s`** — frozen ~8 s, then jumps (strips in
   `.tentacle/tmp/mobile-thinking-jank/strip-S{1,2}-*.png`).

Plausible, not proven:

- **The device is worse than the simulator.** The simulator runs Hermes on the
  Mac's CPU; an A14 is slower per core (roughly 1.5–2×, not measured). At 80 %
  JS busy on the Mac, the iPhone is past 100 % → the multi-second stalls the
  owner saw. **Not measured on a real device.** The owner's own build already
  writes these `ptrace` lines; an export would confirm (Owner question 3).
- **Attach/reconnect bursts add a one-off stall.** The daemon replays every delta
  past the cut as its own frame (`hosted-session.ts:2572-2600`; the cut moves only
  at commits, `:31-41`), so a phone that opens the screen (or comes back from
  background) 60 s into a reasoning gets ~5 000 frames at once. Measured phone-side
  ingestion (decrypt + parse + client + fold, no React) **≈ 110 µs/frame under
  Bun's interpreter (0.44 s for 4 000 frames), ≈ 10 µs JIT** (`ingest.ts`); 64 % of
  it is the pure-JS Noise decrypt (70 µs, `micro.ts`). Real but second-order: the
  render cost dominates (S3 below shows the same profile as S2 after the open).
- Steady-state ingestion is negligible: 40 deltas/s through Noise + client + fold
  costs a few % CPU (`ingest.ts` LIVE).

Ruled out: the native-driver fan restarts of docs/fix/mobile-fan-jank-device.md
(`starts=1` in every fan line), per-delta O(n) folding (0.12 ms/delta at 701
rows, interpreter), the shimmer and arc (native-driver loops, `StepNode.tsx:146-165`,
`FloatingActivity.tsx:467-480`).

### Why it is a class, not one bug

The fan-jank fix (19/11) coalesced renders to ≤ 10/s and memoized the fan and the
cells; one day later an unrelated effect re-doubled the renders, and nothing
noticed, because the property "a delta re-renders only what it changed" is not
expressible in today's shape: the screen holds ONE `SessionScreenState` object
(`SessionScreen.tsx:354`, set at `:398-401`) and every subscriber, effect and
child hangs off that one `setState`. Any new prop, effect or emit re-couples the
stream to everything. The same coupling is behind the workflow-run timer of
docs/fix/mobile-workflow-run-jank.md (a clock that only moved when something
else re-rendered the screen).

Affected or at risk (all on the JS thread, all behind the session screen's renders):

| Component | Mechanism | file:line |
|---|---|---|
| Thinking clock | `setInterval` + `setState`; origin = MOUNT time, so a remount (attach, resync, tool in between) shows `0 s` again | `ui/StepNode.tsx:71-82, 699-700` |
| Running step clock | same hook | `ui/StepNode.tsx:473` |
| Hub fan open | staggered `delay` = JS `setTimeout` per item | `ui/HubFan.tsx:96-103` |
| Hub tap / long-press / drag | JS `PanResponder`, JS long-press timer | `ui/FloatingActivity.tsx:370, 419-455` |
| Hub itself | not memoized, re-rendered by every screen render; its `world` effect runs every render | `ui/FloatingActivity.tsx:158, 401-410` |
| Fan open → 2 more full renders | `navigation.setOptions` + `refreshCatalogue()` on open, inside the stagger window | `screens/SessionScreen.tsx:1835-1845` |
| Activity sheet clock | `setInterval` + screen `setState` (re-renders the whole screen each second while open) | `screens/SessionScreen.tsx:1041-1049` |
| Activity sheet / workflow edge animations | `useNativeDriver: false` | `screens/ActivitySheet.tsx:228,234`, `screens/WorkflowRun.tsx:227` |
| Mascot scene | rAF + `setState` per frame | `ui/MascotScene.tsx:66-92` |
| Composer, header, pending bubbles, copy flash, scroll dim | children of the one state; re-rendered per delta | `screens/SessionScreen.tsx` (one component, 2 702 lines) |
| Transcript list | inline `renderItem` + per-render `extraData` → every mounted cell walks | `screens/SessionScreen.tsx:2101-2156` |
| Thumbnails | `view()` commits even when unchanged → `emit()` | `thumbnails.ts:304-312` |
| Workflow run strip clock | already isolated (`run-clock.ts`), but still a JS timer | `src/run-clock.ts` |

### Repro

All under `.tentacle/tmp/mobile-thinking-jank/` (gitignored), run 2026-11-28 on
`main` `5f95746b`, **no source edited**: a pristine Release build from the e2e
harness (`app: cached 07ad27b1611e`), iPhone 17 Pro simulator, iOS 26, sim lock held.

**A. Simulator (`driver.ts`).** Holds `bun apps/mobile/e2e/run.ts --udid <sim>
--only 02-session-list --hold` (pairs the app; serve + mock model stay up). A
laptop `RemoteClient` (token `e2e-token`) seeds three sessions with
`openSession(undefined, history(n), id)`: `short` = 2 rounds, `long`/`long2` =
120 rounds (each: an assistant message with markdown — heading, list, table, code
— every other round, an `fs_read` call, an 80-line result). Then:

- S1/S2: Maestro opens `short`/`long` (`open.yaml`: launch, `_unlock`, computer,
  `session-<id>`); the laptop sends `THINKHOLD FAST <tag>` (the mock's reasoning
  delta every 10 ms, `e2e/mock-model.ts:722-733`) — a foreign turn on the phone;
  after 4 s `fan.yaml` opens/closes the hub 4× (tap `floating-activity`, wait for
  `hub-scrim`, hold 1.4 s, tap the scrim) while `simctl io screenshot` runs every
  ~2 s.
- S3: phone on the session list; the laptop starts `THINKHOLD FAST` on `long2`;
  60 s later `open-fan.yaml` opens `long2` and opens the hub 3×.
- After each: `xcrun simctl get_app_container … data` →
  `Documents/tentacle-log.txt`, `grep ptrace` (the permanent trace of
  docs/fix/mobile-fan-jank-device.md: one `ev=jank` line per 1 s window with a
  JS rAF gap > 32 ms, one `ev=fan` line per open).

Output (`stats.py` over the `ev=jank` lines; ms; per 1 s window):

```
S1 short: windows=87 gaps/s=2.0 worst max=99   median=46  lost/s=59   folds/s=87  notifies/s=25 renders/s=25 renderMs/s=176  ms/render=7.1 (median)
S2 long:  windows=70 gaps/s=4.3 worst max=10206 median=508 lost/s=1444 folds/s=148 notifies/s=28 renders/s=28 renderMs/s=1466 ms/render=48.8 (median), render share of the window 80 % (median; S1: 17 %)
S3 attach long: windows=34 worst max=4279 median=515 notifies/s=24 ms/render=53.5
```

```
S1 fan: wait=21 start=34 settle=1097 · 20/23/1074 · 25/42/1135 · 17/20/1067   (starts=1 each)
S2 fan: wait=12 start=16 settle=4573 · 36/39/4630 · 6/9/4643 · 59/63/4640    (starts=1 each)
S3 fan: settle=-1 (never finished in 5 s) · 4600 · 1068 (the stream had ended)
S2 sample: ev=jank win=10257 gaps=1 worst=10206 lost=10189 stream=true folds=869 notifies=165 renders=165 renderMs=9901
```

`Thinking` label read off the screenshots (~2 s apart): S1 `4 6 8 9 11 13 15 17 s`;
S2 `1 1 1 1 11 11 15 17 s`.

**B. The render feedback loop, in isolation (`feedback.ts`, Bun, the real
controller; the screen's `rows`-keyed effect emulated):**

```ts
import type { SessionActivity, SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import { createSessionController } from "../../../apps/mobile/src/session-controller.ts";
import { type SendableHandle, type SessionScreenState, createSessionScreen } from "../../../apps/mobile/src/session-screen-controller.ts";
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
for (const wired of [false, true]) {
  let watcher: ((a: SessionActivity) => void) | null = null;
  const clock = { at: 1000 };
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  let notifies = 0;
  let lastRows: unknown = null;
  const handle: SendableHandle = { open: () => Promise.resolve(), detach: () => Promise.resolve(), watch: (fn) => { watcher = fn; return () => {}; }, async *send() {} };
  const screen = createSessionScreen({
    sessionId: "s1", archived: false, title: "A", project: "p",
    controller: createSessionController<SendableHandle>({ newSession: () => handle }),
    broker: new PermissionBroker(undefined, { holdUntilSet: true }),
    now: () => clock.at,
    schedule: (fn, ms) => { const t = { at: clock.at + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
  });
  screen.subscribe((s: SessionScreenState) => {
    notifies++;
    if (wired && s.view.rows !== lastRows) { lastRows = s.view.rows; queueMicrotask(() => screen.window(0, s.view.rows.length - 1, s.view.rows)); }
  });
  await screen.open(); await settle();
  const q: SessionEvent[] = []; let wake: (() => void) | null = null;
  const events = (async function* () { for (;;) { const n = q.shift(); if (n) { yield n; continue; } await new Promise<void>((r) => { wake = r; }); } })();
  watcher?.({ kind: "turn", turnId: "t1", events, cancel: () => {} } as SessionActivity);
  await settle();
  const before = notifies;
  for (let i = 0; i < 100; i++) {
    q.push({ type: "reasoning", delta: "tok " } as SessionEvent); wake?.(); await settle();
    clock.at += 10;
    for (const t of timers) if (t.live && t.at <= clock.at) { t.live = false; t.fn(); }
    await settle();
  }
  console.log(`window effect ${wired ? "wired" : "absent"}: ${notifies - before} screen notifications for 100 deltas over 1 s (design: <= 10)`);
}
process.exit(0);
```

```
window effect absent: 10 screen notifications for 100 deltas over 1 s (design: <= 10)
window effect wired: 20 screen notifications for 100 deltas over 1 s (design: <= 10)
```

**C. Pure costs (`bench.ts`, `ingest.ts`, `micro.ts`; `BUN_JSC_useJIT=0` is the
interpreter, a Hermes proxy).** Per delta fold at 701 rows: 0.014 ms JIT / 0.123 ms
interp. `stepLayout+noticeLooks+reportsOf` per render at 701 rows: 0.049 / 0.415 ms.
Phone-side end-to-end ingestion (real `SessionHost` + `Connection` → Noise →
`RemoteClient` → `createSessionScreen`, each frame its own macrotask): attach
replay of 4 000 deltas drained in 38 ms JIT / **442 ms interp**; Noise decrypt of a
219 B frame 6 µs JIT / **70 µs interp**; live 40 deltas/s: ~10.7 notifications/s,
a few % CPU.

### Device evidence (owner's iPhone log, iOS 18.3.1, 27/11 22:32–00:09, session FINANZA on local Qwen over the relay)

*— claude-opus-5-5, 2026-11-28 (read from the owner's exported `ptrace` log; 1 s windows: `lost` = JS time not given back, `renderMs` = time in session-screen renders)*

The device confirms the simulator diagnosis and is worse on a real session:

- **Fresh session** (right after `/clear`, 23:10:36–23:11:00): 16–28 renders/s at ≈ 13–14 ms each → 220–380 ms of renders per second, worst gap 80–210 ms. Already above the 10/s coalescer cap (the S1 feedback loop).
- **Same session a few turns later** (23:12:29, 23:21:20–25): only 4–6 renders/s but **160–270 ms each**, `lost` ≈ 1 000 ms per ~1 150 ms window → the JS thread is **~90 % busy for whole turns**.
- **Long session** (186–212 messages, 22:39–22:46): 12–20 renders/s at 55–65 ms each, `lost` 750–1 000 ms/s.
- **Single stalls while streaming:** 42.0 s (23:17:21, 140 renders = 39.9 s of render), 42.0 s (23:25:46), 30.2 s (23:12:17), 29.3 s (22:47:18), 24.2 s (22:44:37) — the "frozen, then jumps" Thinking clock.
- **Replay burst on reattach:** 23:21:19, `folds=23 932` in one 20 s window (9.4 s of renders) — slice 6 is real on device.
- **Hub fan:** while streaming most opens never settle (`settle=-1`: 23:21:46–23:24:37, 23:33:51, 23:45:47) or settle in 2.5–4.0 s (22:46:32, 22:48:52); idle opens settle in 1.06–1.15 s. Always `starts=1` — the "only one button" screenshot.
- **Instrumentation gap (fix in slice 0):** windows of 104–904 s with 1–2 renders (e.g. 23:44:05, 00:08:58) span the app in background; one even books 401 s as `renderMs`. The perf gate must cut windows at `app-state` changes, or it will read suspensions as jank.

### Owner decisions (2026-11-28)

1. **Pattern and order: APPROVED.** Slices 0 and 1 start now.
2. **UI-thread clock: YES, now** (owner leans to it; the device evidence above supports it: with the JS thread 75–100 % busy for whole turns and replay bursts of seconds, even a lighter stream path cannot *guarantee* a ticking label — only a clock that does not run on JS can). Shape: a small native view `ClockText` in `apps/mobile/modules/` (the repo already ships local Expo modules: `tentacle-speech`, `tentacle-preview`), given the event's start timestamp and the label format; it ticks on the main thread (no new dependency — Reanimated rejected as a large dependency for one label). The pure `clock.ts` stays the source of the format and of `since` (tests, fallback); the Swift side mirrors the format, pinned by one shared table of test vectors. Folded into **slice 2** (Size S→M). Needs a dev build (not OTA).
3. **Device log: received** (above).

## Implementation

*— claude-opus-5-5, 2026-11-28* — **proposal for the verdict; not approved.**
Each slice below is promoted to its own `feat/` doc (AGENTS §10) with the §8
seven parts; this section fixes the pattern and the order.

### The pattern: a session store with sliced subscriptions, owned clocks, and JS-free animation starts

**One sentence:** the stream is ingested once into a pure, frame-coalesced
**session store** whose state is split into **slices** (`tail`, `rows`,
`composer`, `header`, `hub`, `sheets`…), each component subscribes to its own
slice through a selector with structural equality — so a reasoning token wakes
only the live tail — and anything that moves on its own (a clock, an opening fan)
derives its value from a **timestamp** and is driven by one shared clock or one
native-driver value, never by the parent's renders or a JS timer chain.

It is AGENTS §7 "logic in pure modules, components only render" applied to the
data flow, not just to decisions:

- **`session-store.ts` (pure, React-free, unit-tested):** holds the controller's
  state as slices; `publish()` is the ONE place the controller hands state over;
  each slice keeps its identity when its content did not change (the rule the
  rows already follow, `transcript.ts`); a `subscribe(slice, fn)` fires only for
  that slice. The existing `render-coalesce.ts` becomes its publish policy (stream
  deltas ≤ one publish per window; anything else at once), applied once, at the
  boundary — so a component can no longer bypass it with an `emit()`.
- **`useSlice(store, key)` (one tiny hook over `useSyncExternalStore`):** the
  only way a component reads session state. Rendering rule, pinned by a source
  test: no component under `screens/SessionScreen*`/`ui/` receives the whole
  `SessionScreenState`; the screen shell renders children and passes the store.
- **Clocks:** `clock.ts` (pure) + `useSince(at)`: one shared 1 s ticker for every
  subscriber (one timer, not one `setInterval` per row), the value always
  `now - at` where `at` is the event's receipt time from the store (the Thinking
  tail's first reasoning delta, a step's start) — so a remount never resets to 0
  and a stall only delays, then corrects. Only the leaf label re-renders.
- **Animation starts that need no JS after the tap:** the fan opens on ONE
  native-driver progress value; each item interpolates its own sub-range
  (`hub-fan.ts` computes the ranges), so there is no per-item `delay` and so no
  `setTimeout`. A fan open/close does no work outside the hub (no
  `navigation.setOptions`/catalogue refresh inside the opening window: deferred to
  the settle callback).
- **Ingestion budget:** a backlog (attach, reconnect, 4G burst) is folded in
  slices of ≤ 8 ms, merging consecutive `text`/`reasoning` deltas into one fold
  (the existing, unused `stream-batch.ts` is that seam, its contract already
  "batched == unbatched"), yielding to the event loop between slices.
- **List rule:** `renderItem` is stable (reads the latest closures through a
  ref, as `cellActions` already does), `extraData` carries only what changes
  every cell; per-row derived data (`layout.cells`, `looks`) is read by the cell
  through its own selector. The streaming row and the Thinking tail render from
  the `tail` slice, so a token never touches the `FlatList` at all.

### Migration plan (dependency order; each slice its own `feat/` task)

| # | Slice | Size · Blast | Files (exact) | Verified by (AI-free gate) |
|---|---|---|---|---|
| 0 | **Perf gate flow** — `90-perf-stream`: the driver above made permanent (long seeded session + `THINKHOLD FAST` + hub opens + `ptrace` read-back), a pure checker over the `ptrace` lines | M · contained (e2e + a pure checker) | `apps/mobile/e2e/flows/90-perf-stream.yaml` (new), `e2e/run.ts` (seed a long session, flow entry), `e2e/perf-budget.ts` (new, pure), `test/perf-budget.test.ts` | RED on today's `main` (S2's numbers). Budget: no 1 s window with a gap > 250 ms after the open settles; every `ev=fan` `settle` ≤ 1 500 ms; renders/s ≤ 11 |
| 1 | **Break the thumbnail feedback loop** — `view()` commits only when the plan changed; the controller emits only on a real change | S · contained | `src/thumbnails.ts`, `src/session-screen-controller.ts`, `test/thumbnails*.test.ts`, `test/session-screen-stream-render.test.ts` (the screen's `window` effect emulated, as `feedback.ts`) | 100 deltas/1 s → ≤ 10 notifications with the effect wired (red today: 20) |
| 2 | **Owned clocks** — `clock.ts` + `useSince`; the Thinking tail and running steps read `at` from the transcript, not mount time; **plus a native `ClockText` view (owner 28/11) that ticks on the UI thread from that `at`** | M · contained | `src/clock.ts` (new), `src/tool-steps.ts` (tail `since`), `src/ui/StepNode.tsx`, `test/clock.test.ts` | pure: one ticker for N subscribers, a late tick self-corrects, a remount keeps the value; gate 0: label within 2 s of wall in screenshots |
| 3 | **Session store + `useSlice`** — slices, identity-preserving publish, the coalescer moved inside; the screen subscribes per slice (header, composer, hub, sheets) | M · cross-module | `src/session-store.ts` (new), `src/use-slice.ts` (new), `src/session-screen-controller.ts` (publish through the store), `src/screens/SessionScreen.tsx` (split into slice subscribers), `test/session-store.test.ts`, a source pin test | pure: a `reasoning` delta changes ONLY `tail`; `composer`/`hub`/`header` keep identity; source pin: no child takes `SessionScreenState` |
| 4 | **The list off the stream path** — stable `renderItem`, slim `extraData`, the streaming row + Thinking tail from the `tail` slice outside the `FlatList` data | M · cross-module | `src/screens/SessionScreen.tsx`, `src/screens/transcript/TranscriptCell.tsx`, `src/transcript-cell.ts`, `src/tool-steps.ts`, tests | gate 0: S2 `ms/render` within 2× of S1 (today 7×), renders of the list per delta = 0 while only the tail changes |
| 5 | **Fan without JS timers** — one native progress value + per-item ranges; no full-screen work inside the opening window | S · contained | `src/hub-fan.ts`, `src/ui/HubFan.tsx`, `src/screens/SessionScreen.tsx` (`onHubFan`), `test/hub-fan.test.ts`, `test/fan-jank-wiring.test.ts` | pure: ranges monotone, last item ends at 1; source pin: no `delay:` in `HubFan.tsx`; gate 0: `settle` ≤ 1 500 ms while streaming |
| 6 | **Ingestion budget** — backlog folded in ≤ 8 ms slices, prose deltas merged (wire `stream-batch.ts`) | S · contained | `src/session-feed.ts`, `src/stream-batch.ts`, `test/stream-batch.test.ts`, a feed test | 5 000 queued deltas → no single task > 8 ms (fake clock), final state == unbatched fold |
| 7 | **Sweep the rest of the class** — activity sheet clock and its `useNativeDriver: false`, mascot rAF `setState`, workflow edge; each onto `useSince`/a native value | S · contained (per screen) | `screens/ActivitySheet.tsx`, `screens/SessionScreen.tsx:1041-1049`, `ui/MascotScene.tsx`, `screens/WorkflowRun.tsx` | source pins + gate 0 |

Order rationale: 0 first so every slice is red→green on the real symptom; 1 is
the cheapest win (≈ halves renders); 2 fixes symptom 1's correctness (the `0 s`
on remount) independently of load; 3 is the architecture; 4 and 5 lean on it; 6
and 7 close the class. No slice touches the protocol, persistence or a §7 trust
rule. No new dependency.

### Failure modes / risks

- **A slice that should update does not (stale UI).** The store's slice
  identity is the memo key; a field added to the wrong slice freezes. Designed
  out by deriving slices in ONE pure function with an exhaustive test per field
  ("changing X changes slice S"), as `sameCellData` does for cells today.
- **Lost or reordered content under coalescing/batching.** Same contract as
  `render-coalesce.ts`/`stream-batch.ts`: a publish carries no data, the latest
  state is read at fire time; non-prose events flush first. Already tested.
- **Clock skew / mount races.** `useSince(at)` clamps `now - at ≥ 0` (as
  `thinkingElapsed` does); `at` comes from the phone's receipt clock, so phone↔Mac
  skew cannot show.
- **Fan interpolation feel differs from springs.** One spring drives all items;
  per-item sub-ranges keep the stagger. A visual check by the owner (mockup or
  simulator video) before merge.
- **Gate flakiness.** Simulator timing varies; thresholds sit far from both
  sides (today 4.6 s vs budget 1.5 s vs healthy 1.1 s). The checker reads numbers
  the app writes; no AI anywhere.
- **Device ≠ simulator.** The gate runs on the simulator; the owner's export
  (`grep ptrace`) is the device check after each milestone.

### Alternatives rejected

- **Raise `STREAM_RENDER_MS`** (e.g. 250 ms): fewer renders, same O(rows) cost
  each (49 ms sim, ~2× on device), still couples the hub to the stream; a
  patch, and choppier text.
- **More `memo`/`useCallback` here and there:** what the fan-jank fix did; the
  property regressed the next day (`06d8d093`). Without the store no test can
  state "a token re-renders only the tail".
- **Swap `FlatList` for FlashList/LegendList:** a new dependency that fixes only
  the per-cell walk, not the whole-screen coupling or the JS timers; can be
  reconsidered after slice 4 if the list is still the cost.
- **Reanimated / a native clock view for every clock:** a new native dependency
  and rebuild; it hides the symptom (the clock ticks) while the JS thread stays
  saturated (taps still wait). Kept as Owner question 2, after the store.
- **Daemon-side delta coalescing / merged replay:** touches the replay ring and
  the seq-contiguity invariant (`reattach.e2e.test.ts`) — load-bearing for a
  second-order cost (≈ 0.4 s per 4 000 frames, interpreter); slice 6 bounds it on
  the phone instead.

### Owner questions

1. **Approve the pattern and the order (0 → 7)?** Recommendation: yes; promote
   slices 0 and 1 now (small, immediate: 1 alone ≈ halves the renders), 3–4 as the
   architectural core under Opus with fresh-context reviews.
2. **UI-thread clock (Reanimated or a ~30-line native `ClockText` in
   `modules/`) after the store lands?** Recommendation: not now — measure with gate
   0 after slices 2–4; add it only if the device still shows a stalled label.
3. **Export the iPhone log once** (`Settings → Export logs`, during a long
   Thinking with a few hub taps) so the device numbers enter this record?
   Recommendation: yes — it is the only unverified link (device vs simulator).

## Execution

*(empty — an `eval`; filled by each promoted slice's own doc)*

## Review

*— claude-opus-5-5, 2026-11-28* — **proposed verdict: APPROVE the pattern; promote slices 0 and 1 first.** Pending the owner's decision.

What holds: the root cause is measured on a pristine `main` Release build on the
simulator (render cost 7.1 → 48.8 ms with transcript length; 80 % of the JS thread
during a stream; the Thinking label frozen then jumping; fan settle 1.1 → 4.6 s),
its mechanism is cited in code, and its doubling (the thumbnail feedback loop) is
shown red/green in isolation. What does not hold yet: no real-device numbers
(Owner question 3); the device factor (1.5–2×) is an estimate; the attach-burst
stall is measured under Bun's interpreter only, not on Hermes. Not done here, by
design: any code change.
