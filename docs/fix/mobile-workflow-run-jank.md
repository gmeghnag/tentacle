# fix/mobile-workflow-run-jank — Run screen: the timer ticks, a step tap always opens

> **Status:** context · **implementation (APPROVED)** · execution · review · done
> **Branch:** `fix/mobile-workflow-run-jank`
> **Type:** fix · **Size:** S · **Blast:** contained (mobile workflow run screen + step layer) · **Suited:** Sonnet exec (simulator), standard review
> **Changelog:** `changelog.d/mobile-workflow-run-jank.fixed.md`

## Context

*— claude-sonnet-5-5, 2026-11-26*

Owner report (TODO.md, with iPhone screenshots of a running `demo-note` run, in
`.tentacle/tmp/mobile-workflow-run-jank/owner-{run-graph,step-sheet}.png`): on the
workflow run screen the elapsed timer sometimes stalls, and tapping a
finished/failed step node sometimes does not open it. Owner's hypothesis: reading
the run state blocks the JS thread.

What the code says (paths under `apps/mobile/`):

1. **Timer: nothing ticks.** The route passes `now={Date.now()}` (`App.tsx:2282`)
   and neither `WorkflowRunRoute` (`App.tsx:2193-2300`) nor
   `src/screens/WorkflowRun.tsx` has a timer. The strip computes
   `(endedAt ?? now) - startedAt` (`packages/client/src/workflow-run-graph.ts:592`),
   so a live run's time moves only when something else re-renders the screen: a
   `workflows` feed update or an ask change (`src/workflow-run-controller.ts:554,572-583`,
   `App.tsx:2262-2266`).
2. **Tap: reopening a step does not repaint.** `openStep` sets `openStepId` and
   never calls `changed()` itself (`src/workflow-run-controller.ts:543-547`). It
   relies on `readStep`, which returns silently when a final detail is already held
   (`:503-505`) or a read is in flight (`:498-500`). The layer then does not open:
   never on an ended run, late (at the next update) on a live one. The prev/next
   arrows use the same call (`src/screens/WorkflowRun.tsx:662`).
3. **Back tap swallowed (found while checking how presses survive updates).**
   `motion = morphLook(reduceMotion)` is a new object on every render
   (`src/screens/WorkflowStep.tsx:116`, `src/workflow-morph.ts:257-261`) and is a
   dependency of the flight effect (`:129-166`), so every re-render of the open
   layer restarts the flight and sets `busy`; `close()` ignores back/backdrop taps
   while `busy` (`:121-127`), up to 380 ms (`src/workflow-morph.ts:75`). A new
   `projection` also rebuilds `table` (`:108-115`), another dependency.
4. **Re-renders on a status update:** `state()` builds a new projection and cards
   (`src/workflow-run-controller.ts:398-430`) and the whole screen re-renders.
   Graph pills are **not** remounted: `Pill` is a module-level component keyed by
   `node.id` (`src/screens/WorkflowRun.tsx:270,359-361`). A lost first tap from
   remounting is therefore not supported by the code.

Owner's JS-blocking hypothesis: **unmeasured**. One candidate load exists: a taken
live edge animates on the JS thread (`useNativeDriver: false`,
`src/screens/WorkflowRun.tsx:203-210`). Implementation step 0 measures it.

**Repro** (2026-11-26, defect 2, pure level; defects 1 and 3 are shown on the
simulator in step 0). In `.tentacle/tmp/mobile-workflow-run-jank/` (the worktree
had no `node_modules`, hence the path override):

```sh
bun --tsconfig-override=./tsconfig.json ./reopen.ts
```

`tsconfig.json`:

```json
{ "compilerOptions": {
    "baseUrl": "../../worktrees/mobile-workflow-run-jank/packages",
    "paths": { "@tentacle/transport/*": ["transport/src/*.ts"], "@tentacle/*": ["*/src/index.ts"] } } }
```

`reopen.ts`:

```ts
import { createWorkflowRunController } from "../../worktrees/mobile-workflow-run-jank/apps/mobile/src/workflow-run-controller.ts";

const step = (id: string, state: string) => ({
  id, kind: "agent", where: "local", state, attempt: 0, round: 0, next: null, onFail: null, retry: 0,
});
const row = {
  runId: "wf-1", name: "t", version: 1, hash: "a".repeat(64), state: "ok", tokens: 0,
  startedAt: 1000, endedAt: 2000, history: [], historyDropped: 0,
  steps: [step("build", "ok"), step("review", "error")],
};
let paints = 0;
let reads = 0;
let release: () => void = () => {};
let hold = false;
const c = createWorkflowRunController({
  runId: "wf-1", sessionId: "s", borrowed: false, asks: null, leave() {},
  mode: { get: () => "graph", set() {} },
  onChange: () => { paints++; },
  open: async () => ({
    ok: true,
    session: {
      onWorkflows(fn: (rows: (typeof row)[]) => void) { fn([row]); return () => {}; },
      workflow: async () => ({ ok: false as const, reason: "-" }),
      workflowStep: () => {
        reads++;
        const a = { detail: { attempt: 0, round: 0, live: false, prompt: "p", report: "r" } };
        if (!hold) return Promise.resolve(a);
        return new Promise<typeof a>((r) => { release = () => r(a); });
      },
    },
  }),
});
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
c.start();
await flush();
const tap = async (label: string, id: string) => {
  const before = paints;
  c.openStep(id);
  console.log(label, "| paints on tap:", paints - before, "| openStepId:", c.state().openStepId);
  await flush();
};
await tap("1st open review      ", "review");
c.closeStep();
await tap("reopen review (error)", "review");
c.closeStep();
hold = true;
await tap("open build           ", "build");
c.closeStep();
await tap("reopen build in-flight", "build");
release();
await flush();
console.log("reads:", reads);
```

Output:

```
1st open review       | paints on tap: 1 | openStepId: review
reopen review (error) | paints on tap: 0 | openStepId: review
open build            | paints on tap: 1 | openStepId: build
reopen build in-flight | paints on tap: 0 | openStepId: build
reads: 2
```

## Implementation

*— claude-sonnet-5-5, 2026-11-26* — **APPROVED** (details delegated by the owner;
no AGENTS §7 trust rule is touched).

### Load-bearing assumption

The screen repaints only when the route's state changes, and the route's state
changes only through `onChange` (`App.tsx:2262-2266`). So an `openStep` path that
skips `changed()` is invisible. Proven by `src/workflow-run-controller.ts:498-505,
543-547` and the Repro (0 paints).

### Preconditions

- The controller is pure and injected, with an existing harness
  (`test/workflow-run-step-detail.test.ts:60-130`).
- An extra `changed()` is harmless: it only recomputes `state()`.
- `elapsedLabel` floors to whole seconds and clamps negatives to 0
  (`packages/client/src/workflow-run-graph.ts:146-147`).
- After a flight, `progress` stays at 1; later geometry reaches the layer through
  render-time interpolation (`src/screens/WorkflowStep.tsx:168-171`), not the effect.
- `test/motion-literals.test.ts` forbids numeric timer periods in `.tsx`;
  `STEP_ELAPSED_TICK_MS` exists (`src/motion.ts:22`).

### Design

**Step 0 — simulator reproduction, before any source edit.** `bun install` in the
worktree if needed. Take the sim lock as the other chains do: wait until
`/Users/gmeghnag/tentacle/.tentacle/tmp/orchestration/sim.lock` is absent and no
`xcodebuild` / Maestro process runs, `mkdir` it, and `rmdir` it on every exit path.
Use the e2e harness (`bun run e2e:mobile -- --only 45-workflow-run-view --hold`);
scratch files only in `.tentacle/tmp/mobile-workflow-run-jank/`. Record numbers in
Execution:

- **a. Timer drift.** A live run quiet for ≥30 s (scratch workflow with one
  `run: sleep 40` step in the held run's `.tentacle/workflows/`). Screenshot
  (`xcrun simctl io <udid> screenshot`) every 2 s; table wall time vs label.
  Expected on current code: frozen between updates.
- **b. Tap reliability.** On flow 45's ended run: tap `review`, back, tap `review`,
  10 cycles, count opens (expected: only the first). On a live run: 10 cycles on a
  finished node, count missed opens and missed backs.
- **c. JS stall** (owner's hypothesis). Temporary, never committed: a 100 ms
  interval in `WorkflowRunRoute` keeps the largest overshoot and shows it in the
  header subtitle (screenshot it; Release builds drop `console.log`). Run with a
  live flowing edge.

Re-run a–c after the fix with the same method. **Stop rules:** if (c) shows an
overshoot > 250 ms, or after the fix a first-time node tap is still missed or the
label lags wall time by > 2 s, STOP and report with the numbers; do not add a
speculative fix.

**1. Tap.** `openStep` calls `changed()` after `readStep(...)`, on every path. No
change to the read policy (one read in flight, final detail never re-read).

**2. Timer.** New pure module `src/run-clock.ts`:

- `startRunClock(run: { startedAt, endedAt? }, deps: { now(), schedule(fn, ms): cancel }, onTick(now)): stop`
- Live run: emits `now` at once, then schedules one timeout at a time to the next
  whole second **counted from `startedAt`**
  (`STEP_ELAPSED_TICK_MS - positiveMod(now - startedAt, STEP_ELAPSED_TICK_MS)`), so
  jitter never accumulates and no label is skipped or doubled by phase drift.
- Ended run: schedules nothing. `stop()` cancels the pending timeout.

`SummaryStrip` owns the `now` state and runs the clock in an effect keyed on
`startedAt` / `endedAt`. Only the strip re-renders each second; the graph, list and
step layer do not. The `now` prop of `WorkflowRunScreen` and the route's
`now={Date.now()}` are removed.

**3. Back tap.** In `WorkflowStepLayer`: `motion = useMemo(() => morphLook(reduceMotion), [reduceMotion])`
and `const flies = table !== null`; the flight effect depends on
`[motion, flies, progress, graphFade]`, not on `table`. The flight runs on open and
on a Reduce Motion toggle, never on a status update.

#### Orchestrator decisions

| Question | Options | Chosen (recommended) |
| --- | --- | --- |
| Where the 1 s tick lives | controller/route (whole screen re-renders) · **strip-local, pure clock** | strip-local: cheapest render, answers the owner's concern |
| Memoize graph / projection | now · **only if step 0 demands** | not now: no evidence |
| JS-driven edge animation | change now · **measure first (0c)** | measure; a stall means a re-plan |
| Back tap during the opening flight | allow · **keep ignored** | keep (existing D5 rule); only stop the restarts |
| Same `now={Date.now()}` on the runs list (`App.tsx:2171`) | include · **leave** | leave; record as follow-up in Review |

### Files

1. `apps/mobile/src/workflow-run-controller.ts` — `openStep` repaints.
2. `apps/mobile/src/run-clock.ts` — new.
3. `apps/mobile/src/screens/WorkflowRun.tsx` — strip uses the clock; drop `now`.
4. `apps/mobile/src/screens/WorkflowStep.tsx` — stable flight dependencies.
5. `apps/mobile/App.tsx` — drop `now` from `<WorkflowRunScreen>` only.
6. `apps/mobile/test/run-clock.test.ts` (new), `apps/mobile/test/workflow-run-step-detail.test.ts`.
7. `apps/mobile/e2e/flows/45-workflow-run-view.yaml` — reopen a ran step.
8. `changelog.d/mobile-workflow-run-jank.fixed.md` — "**Workflow run screen on
   iPhone.** The elapsed time now ticks every second, reopening a step always shows
   it, and Back is no longer ignored while the run updates."

### Failure modes

- Step tapped again while its read is in flight → paints the held record
  (`loading` or the live snapshot); the one read lands later. No second request.
- Tap for a step no longer on the feed → repaint, no card, no layer, no request
  (unchanged outcome).
- Run ends while shown → effect re-keys on `endedAt`, no timer left, final duration.
- Resume (`endedAt` disappears) → clock restarts.
- Unmount / leaving the screen → `stop()` cancels; no `setState` after unmount.
- App backgrounded → the pending timeout fires late; the next label is computed
  from `now`, so it is correct at once and re-aligned.
- Phone clock behind the daemon's → label stays `0s` until it catches up
  (unchanged clamp); scheduling delay stays in (0, 1000].
- Layer open across status updates → no new flight, `busy` stays false.
- Reduce Motion toggled with the layer open → the effect runs once (unchanged).
- Known, left: a visit tap for another attempt while a read is in flight keeps the
  first read's result (`src/workflow-run-controller.ts:498-500`, one read per step).

### Tests

Each red on the current code **on its assertion**, then green; outputs go in Execution.

1. `workflow-run-step-detail.test.ts` (harness gains an `onChange` counter): open →
   close → reopen an ended step raises the count and `stepCalls` stays 1; reopen
   while held in flight raises it with one call; the same through a `visit` open.
2. `run-clock.test.ts` with a fake clock/scheduler. Create `run-clock.ts` first as a
   no-op stub (today's behaviour) so red is an assertion: ticks for 1 s, 2 s, 3 s
   with late firings (e.g. +130 ms) without drift; ended run schedules nothing;
   `stop()` cancels; `now < startedAt` gives a delay in (0, 1000].
3. Source pins (TypeScript AST, as in `test/motion-literals.test.ts`), in the same
   file: `WorkflowRun.tsx` calls `startRunClock`; the flight effect in
   `WorkflowStep.tsx` does not depend on `table` and `motion` is memoized. Confirm
   non-vacuity by reverting each edit.
4. e2e flow 45: after the `fix` detail, open `workflow-node-review`, wait for the
   detail and `waitForAnimationToEnd`, back, tap `review` again, assert
   `workflow-step-back` visible. Run it **red before** the source edits and green
   after (`scripts/e2e-gate.sh --only 45-workflow-run-view`, under the sim lock).

Validation: `bun run check` against the clean baseline, flow 45, step 0 re-measured.

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Load-bearing check: holds.** Repro re-run before any edit: `reopen review (error)
| paints on tap: 0`, `reopen build in-flight | paints on tap: 0`, `reads: 2`; the
route's `setState` after creation is only in `onChange`. (Run it with
`bun run --tsconfig-override=<abs>/tsconfig.json <abs>/reopen.ts`.)

### As built, in order

1. `bun install` in the worktree; sim lock taken (`mkdir …/sim.lock`); iPhone 17
   Pro, iOS 26.5.
2. Flow 45 reopen steps added, run **red** on the unedited app (below).
3. Step 0 a–c measured on the unedited app (c on a temporary probe build).
4. Tap: `openStep` calls `changed()` after `readStep` (4 tests red → green).
5. Timer: `src/run-clock.ts` created as a no-op stub (5 tests red on assertions;
   the "ended run schedules nothing" one is green on a stub by nature, pinned by
   mutation M5), then implemented; `SummaryStrip` owns `now`; `now` removed from
   `WorkflowRunScreen` and the route.
6. Back: `motion` memoized, flight effect on `[motion, flies, progress,
   graphFade]` (3 source pins red → green).

### Step 0, before and after

Driver scripts (gitignored, `.tentacle/tmp/mobile-workflow-run-jank/`): `lib.ts`
spawns `e2e/run.ts … --only 45-workflow-run-view --hold`, starts live runs with a
trusted `RemoteClient` that allows the asks, and runs `open.yaml` (relaunch,
`_unlock`, hub → Workflows → the run) and `cycles.yaml` (10 × tap node, count
opens, Back, count a Back that left the layer up); `ab.ts` = a + b, `c.ts` = c,
`stitch.ts` stacks the screenshot bands.

**a. Timer** (one `sleep 90` step; screenshot about every 2.5 s; wall = whole
seconds since `startedAt`, read just before the capture):

| | wall → label |
|---|---|
| before | 32→26, 35→26, 37→26, 40→26, 42→26, 44→26, 47→26, 49→26, 52→26, 54→26, 57→26, 59→26, 62→26, 64→26, 67→26, 69→26, 72→26, 74→26 (frozen) |
| after | 51→53, 55→56, 58→59, 61→62, 64→65, 67→68, 70→71, 73→74, 76→76, 78→79, 81→81, 83→84, 86→86, 89→89, then Done `1m 30s` ×4 |

After the fix the label never lags; it reads 0–2 s ahead of the pre-capture
timestamp (the capture's own delay).

**b. Taps** (10 cycles each):

| | ended run, `review` | live run (an update every 3 s), `quick` | Back missed |
|---|---|---|---|
| before | **1**/10 opened | 10/10 on the probe build; 2/10 in an earlier pass whose 45 s run ended during the cycles | 0 |
| after | 10/10 | 10/10 | 0 |

On a live run the old defect is a LATE open: Maestro waits several seconds for the
layer, so a late repaint counts as an open. The swallowed Back (defect 3) did not
reproduce: Maestro waits for the screen to settle between taps. It is pinned only
by the source test.

**c. JS stall** (temporary 100 ms interval in `WorkflowRunRoute`, largest
overshoot, drawn under the header rather than in the subtitle; never committed,
`App.tsx` restored). "quiet" = one running step with a flowing edge; "busy" = 60 ×
`sleep 3` with the 10 tap cycles.

| | quiet | busy |
|---|---|---|
| before | 17 ms | 55 ms |
| after | 17 ms (label `1m 16s` at 76 s) | 56 ms |

All under the 250 ms stop rule: the owner's JS-blocking hypothesis is **not
supported on the simulator** (not measured on a device). No stop rule fired.

### Red, then green

- Flow 45 on the unedited app: `✗ 45-workflow-run-view` — `Assertion is false: id:
  workflow-step-back is visible` at the second `review` tap (screenshot: the graph,
  no layer). Fixed: `GATE PASS — 1 passed, 0 failed` (86 s).
- `workflow-run-step-detail.test.ts`: `23 pass 4 fail` (`Expected: > 0, Received:
  0`) → `27 pass 0 fail`.
- `run-clock.test.ts` on the stub: `1 pass 5 fail` → `6 pass`; the three source
  pins on the unedited screens: `6 pass 3 fail` → all pass.
- Related files (`apps/mobile/test/{workflow-,e2e-,motion,run-clock,hub-workflows,
  session-screen-catalogue}*`, `scripts/test/mockup-kit*`): `946 pass 0 fail`.
- Sim lock released, simulator shut down. The probe builds stay in
  `.tentacle/tmp/e2e-app-cache/` under the probe trees' own keys (no real tree
  matches them); the DerivedData product is the last probe build until the next
  e2e run.
- `bunx tsc -p apps/mobile`: clean. `bunx biome check` on the changed files: clean.
  The full gate is the orchestrator's.

### Mutations (`mutate.ts`: one at a time, file restored)

| Mutation | Fails |
|---|---|
| M1 `openStep` no repaint | 4 (all "every open repaints") |
| M2 fixed 1 s period | 4 |
| M3 signed remainder | 1 (clock behind) |
| M4 no `stopped` guard | 1 |
| M5 ended run ticks | 1 |
| M6 `stop` does not cancel | 1 |
| M7 flight depends on `table` | 1 |
| M8 `motion` not memoized | 1 |
| M9 clock effect not keyed on `endedAt` | 1 |
| M10 strip runs no clock | 1 |

### Drift from Implementation

- Added a fourth tap test (a step no longer on the feed repaints, no read — a
  listed failure mode) and a late-firing clock test.
- The pins assert the exact dependency lists, which is stricter than "not `table`".
- Step 0c's probe text sits under the header, not in the subtitle.
- Resume, unmount and the Reduce Motion toggle have no render test (no component
  harness): resume and unmount rest on the effect keys and `stop()`.

## Review

*— claude-sonnet-5-5, 2026-11-26* (the brief asked for a `claude-opus-5-5`
signature; this is the model that actually reviewed. Fresh context; same model as
the planner, not the executor, `deepseek` per the exec commit.)

**Verdict: PASS.** No HIGH or MEDIUM finding.

**Gate.** Three touched test files: 41 pass, 0 fail. `apps/mobile/test/{workflow-,e2e-}*`:
841 pass, 0 fail (40 files). `bun run lint`: clean (2725 files).
`bun run typecheck`: no errors. Not run here: full `bun run test`, flow 45,
simulator or device (verify with `bun run check` and
`scripts/e2e-gate.sh --only 45-workflow-run-view`).

**Premises** (against `main`): `openStep` without `changed()` and the
`fit === "final"` early return TRUE (M1 gives 4 fails); `elapsedLabel` floor/clamp
TRUE; flight effect on `[motion, table, …]` with an unmemoized `motion` TRUE;
`STEP_ELAPSED_TICK_MS` TRUE; `onChange` TRUE, but at `App.tsx:2250`, not `:2262-2266`.

**Mutations** (`review-mutate.ts`, files restored, `git diff HEAD` empty before
this section): M1–M10 each fail (M1: 4, M2: 4, M3–M10: 1). Three probes stay
green, so the source pins are weak (below MEDIUM): `const flies = table`;
the strip's effect dropping the clock's cleanup; `setNow` replaced by a no-op.

**Attacks tried.**
1. `busy` stuck true now that no update restarts the flight (a re-render detaching
   an interpolation would stop the animation): RN 0.88
   `createAnimatedPropsHook.js:291-305` attaches the new node first and detaches the
   old one in a microtask, so the value keeps a child. Not reachable by source
   reading; not run on a device.
2. `flies` flips or Reduce Motion toggles mid-flight: the effect re-runs, starts a
   new animation and that one clears `busy`. Holds.
3. Real-timer trace of `startRunClock`: 400, 1001, 2001, 3002, 4000 ms give
   0–4 s; no tick after `stop()`.
4. Removed `now` prop: only `SummaryStrip` consumed it. Resume can paint one stale
   frame before the effect emits; harmless.
5. Extra `changed()` on every `openStep` path (unknown step, read in flight, held
   final): repaint only, read policy unchanged.
6. §7: the clock is a pure injected module; no protocol, persistence or broker change.

**Follow-up** (plan): the runs list still has `now={Date.now()}` (`App.tsx:2171`).

**Executor.** Followed the plan; drift is declared; red/green and mutation claims
match what was reproduced.
