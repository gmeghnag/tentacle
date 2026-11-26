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

## Review
