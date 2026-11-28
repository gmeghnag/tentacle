# feat/mobile-ui-fluidity-s0 — the AI-free perf gate (`90-perf-stream`)

> **Status:** context · **implementation (APPROVED)** · execution · review · done
> **Branch:** `feat/mobile-ui-fluidity-s0`
> **Type:** feat · **Size:** M · **Blast:** contained · **Suited:** Sonnet plan/review, Sonnet exec (needs the simulator)
> **Changelog:** `none` — a test gate plus a correction to a diagnostic log line; no user-facing behaviour.

## Context

*— claude-sonnet-5-5, 2026-11-28*

Slice 0 of `docs/eval/mobile-ui-fluidity.md` (approved by the owner, 28/11). On a
long session a streaming turn saturates the phone's JS thread (eval § Root
cause). Slices 1–7 fix it; each needs a red→green measure with no AI in it. This
slice builds that measure, and nothing that fixes the jank:

1. e2e flow `90-perf-stream`: long seeded session, `THINKHOLD FAST`, 4 hub opens;
2. a pure checker over the app's `ptrace` lines. Budget: no jank window with a
   gap > 250 ms after the open settles; every `ev=fan` `settle` ≤ 1 500 ms;
   renders/s ≤ 11;
3. `ptrace` windows cut at `app-state` changes (eval § Device evidence:
   suspensions of 104–904 s read as jank).

**It MUST be red on today's app.**

**Repro** (2026-11-28, no simulator; `.tentacle/tmp/mobile-ui-fluidity-s0/`).
`repro.ts`:

```ts
// Repro: (1) the gate does not exist; (2) a background suspension is booked as jank.
import { createAppLog, entriesToText } from "../../worktrees/mobile-ui-fluidity-s0/apps/mobile/src/app-log.ts";
import { createPerfProbe } from "../../worktrees/mobile-ui-fluidity-s0/apps/mobile/src/perf-probe.ts";
import { existsSync, readFileSync } from "node:fs";

const e2e = `${import.meta.dir}/../../worktrees/mobile-ui-fluidity-s0/apps/mobile/e2e`;
console.log(
  `flow yaml: ${existsSync(`${e2e}/flows/90-perf-stream.yaml`)}, checker: ${existsSync(`${e2e}/perf-budget.ts`)}, in run.ts: ${readFileSync(`${e2e}/run.ts`, "utf8").includes("90-perf-stream")}`,
);

let t = 0;
const frames: ((t: number) => void)[] = [];
const probe = createPerfProbe(() => t, (fn) => frames.push(fn));
const log = createAppLog({ now: () => 0, capacity: 10 });
probe.attach(log);
const step = (ms: number): void => {
  t += ms;
  frames.shift()?.(t);
};
probe.streaming(true);
step(16);
step(16);
// the app goes to background here: no frame fires for 401 s; one render straddles it
probe.render(401_000);
step(401_000);
console.log(entriesToText(log.entries()));
process.exit(0);
```

```
flow yaml: false, checker: false, in run.ts: false
1970-01-01T00:00:00.000Z info ptrace ev=jank win=401016 gaps=1 worst=401000 lost=400983 stream=true folds=0 notifies=0 renders=1 renderMs=401000
```

**The budget against the eval's saved simulator traces** (`budget.ts`, same
folder; reads `../mobile-thinking-jank/{ptrace-S1-short-live,s2-only}.txt`, takes
`worst`, `settle`, and Σ`renders`·1000/Σ`win` over `stream=true` jank lines):

```
S1 short: jank=87 over250ms=0 fans=[1097,1074,1135,1067] renders/s(aggregate, streaming)=24.4
S2 long: jank=70 over250ms=68 fans=[4573,4630,4643,4640] renders/s(aggregate, streaming)=16.5
```

So today the long session breaks all three limits. The short one breaks only the
render rate: Maestro driving the app does not by itself break the gap or settle
limits there. Those traces were taken on `5f95746b`; the two later commits in
this branch's history are `docs(eval)`.

## Implementation

*— claude-sonnet-5-5, 2026-11-28* — **APPROVED** (details delegated by the owner;
no choice below touches an AGENTS §7 trust rule).

#### Orchestrator decisions

| # | Question | Decision (recommended) | Rejected |
|---|---|---|---|
| D1 | A gate that is red on `main` | In `FLOWS`, tagged `known-bug`: it runs and shows red, but does not fail the verdict (`e2e/gate.ts:197-215`); a pass is reported as "drop the tag" | untagged (blocks every merge until the fixes land); left out of `FLOWS` (`--only` rejects it, `run.ts:1967-1971`) |
| D2 | Where the checker runs | `run.ts`, on the host, after the Maestro attempt; it can only turn a `pass` into `fail` | a new hook called from the flow (more surface: `hooks.ts` + its query list) |
| D3 | What "renders/s" is | one aggregate: Σ`renders`·1000 / Σ`win` over `stream=true` jank lines | per-window maximum (fan opens and one-off emits make single windows noisy) |
| D4 | Evidence required to pass | ≥ 4 `ev=fan` lines with `stream=true`; a `ptrace` jank/fan line missing a needed number is a violation. Zero jank lines is legal (a smooth window writes none) | passing on an empty log (vacuous) |
| D5 | Where the `app-state` cut lives | in the app's probe: nothing is measured while the state is not `active` | dropping long windows in the checker (would hide the real 24–42 s stalls of the device log) |
| D6 | Scenario | eval's S2 only (session open and settled, then stream, then 4 opens), 120 rounds | S3 attach-replay (belongs to slice 6) |

### Load-bearing assumption

**The `ptrace` lines in the app's log file, written during this scenario by a
Release build on the simulator, are enough to decide the budget, and today they
break it.** Evidence: the eval measured exactly this (§ Repro A) and the output
above applies the budget to those lines. The executor re-proves it with the real
flow (Validation); if the flow is not red for these reasons, STOP.

### Preconditions

- A jank line is written only for a window of ≥ 1 s that had a gap > 32 ms, with
  `win`, `worst`, `renders`, `stream` (`src/perf-trace.ts:101-125`). A fan line
  carries `settle` (−1 = never finished) and `stream` (`:172-188`).
- The rAF loop runs only while a turn streams or a fan is opening
  (`src/perf-probe.ts:76-96`), so opening the session at rest writes nothing.
  `pause()` makes the next frame start a fresh window and zero the counters
  (`src/perf-trace.ts:88-91,137-140`).
- The probe knows nothing about app state (no such member,
  `src/perf-probe.ts:28-51`). The app logs `app-state` only for `active`
  (`App.tsx:3346-3348`), so the log alone cannot say where a suspension began.
- The probe gets the log at `App.tsx:382`; the ring is drained to the file every
  2 s (`App.tsx:395,3448-3466`). Files: `Documents/tentacle-log.txt` and
  `.1.txt` (`src/app-log-fs-expo.ts:19-21`), rotated at 256 KB
  (`src/app-log-fs.ts:21`). Line format: `<iso> <level> <kind> k=v …`
  (`src/app-log.ts:245-255`).
- The harness's `appLogFile` returns the live file **or** the predecessor, never
  both (`e2e/run.ts:1111-1136`): the perf read needs its own concatenation.
- `_pair` launches with `clearState: true` (`e2e/flows/_pair.yaml:27`), so the
  log should hold only this flow's lines. Executor confirms on the first run
  (first `ptrace.txt` timestamp is after the flow started).
- The mock's `THINKHOLD FAST` sends a reasoning delta every 10 ms for
  `FAST_HOLDS` (3) × `holdMs` (120 s, `e2e/run.ts:548`) = 360 s, then the turn
  ends (`e2e/mock-model.ts`, fix round 1). The eval's S2 run fit about 70 windows.
- Hooks `laptop-prompt` / `laptop-cancel` start a turn without awaiting it and
  cancel it (`e2e/run.ts:765,772`; `e2e/seed.ts:353,404-410`).
- `serve` accepts a client-seeded history: `RemoteClient.openSession(cwd,
  messages, id)` (`packages/client/src/remote-client.ts:2245`); the eval's driver
  opened such sessions on the phone.
- A flow's own session is created just before it runs, through
  `COMPOSE_SESSION_VARS` (`e2e/run.ts:1982,2183-2189`) and the dispatch at
  `:1026-1027`.
- Guards a new flow must satisfy: flow files == `FLOWS`
  (`test/e2e-flows.test.ts:1179-1188`); pairs via `_pair` and names
  `${output.computerId}` (`:351-377`); a `known-bug` tag has its reason line and
  a `TODO.md` line containing ``e2e flow `90-perf-stream` ``
  (`test/e2e-gate.test.ts:315-330`).

### Design

**1. The probe cut** (`src/perf-probe.ts`): new `appState(state: string)`.

- `suspended = state !== "active"`; no-op if unchanged (`inactive` → `background`).
- On becoming suspended: `report(null)` (an open fan is reported now, `settle=-1`,
  instead of across the suspension) and `meter.pause()`.
- `active()` becomes `!suspended && (isStreaming || fan !== null)`; after every
  change call `loop()`.
- Safe in both orders on resume: a stale rAF callback that fires while still
  suspended stops the loop; one that fires after `active` meets a paused meter and
  opens a fresh window. Renders counted during the gap are zeroed by that frame.
- `App.tsx`, next to `:382`:
  `AppState.addEventListener("change", (state) => PERF.appState(state));`
- Foreground stalls of any length are still reported.

**2. The checker** (`e2e/perf-budget.ts`, pure, no I/O; imports `PTRACE` from
`src/perf-trace.ts`):

```ts
export const PERF_FLOW = "90-perf-stream";
export const PERF_BUDGET = { maxGapMs: 250, maxSettleMs: 1500,
  maxRendersPerSecond: 11, minStreamingFans: 4 } as const;
export function checkPerf(logText: string): PerfReport; // ok, violations[], numbers
export function perfReportText(report: PerfReport): string; // 1st line PERF PASS | PERF FAIL
export function perfOutcome(outcome: AttemptStatus, report: PerfReport): AttemptStatus;
```

- Only lines whose 3rd token is `ptrace`; headers, other kinds and unknown `ev`
  are ignored.
- Every jank line (streaming or not): `worst > 250` is a violation.
- Every fan line: `settle < 0` or `> 1500` is a violation.
- Rate (D3) `> 11` is a violation; no streaming jank line → rate `n/a`.
- Fewer than 4 `stream=true` fan lines, or a missing/non-numeric needed field, is
  a violation (D4).
- The report shows counts, worst gap, every settle, the rate, and at most 10
  violating lines plus the total (S2 had 68).
- `perfOutcome`: `pass` + not ok → `fail`; `fail`/`timeout` unchanged.

**3. Seeding** (`e2e/seed.ts`): `PERF_ROUNDS = 120`, pure
`longHistory(rounds): ChatMessage[]` copied from the eval driver's `history()`
(user line; per round an assistant message — markdown on even rounds — with one
`fs_read` call, and an 80-line tool result; a closing markdown message), and
`longSessionOf(deps)`: `attach` → `openSession(undefined, longHistory(PERF_ROUNDS),
id)` → `drain`, `close` in `finally` (the `composeSessionOf` shape).

**4. The flow** (`e2e/flows/90-perf-stream.yaml`):

```yaml
appId: so.tentacle.app
tags:
  - known-bug
# known-bug: the session screen janks under a fast stream on a long session (docs/eval/mobile-ui-fluidity.md, slices 1-7)
---
```

then: `_pair` → tap `computer-${output.computerId}` → `scrollUntilVisible`
`session-${PERF_ID}` → tap → wait `session-view` and `floating-activity` (60 s) →
**5 s settle** → `90-laptop-think.js` → wait `turn-running` → 4 s →
`repeat: times: 4` { tap `floating-activity`; wait `hub-scrim` (30 s); **2 s
hold**; tap `hub-scrim` at `50%,20%`; wait not visible (30 s) } → assert
`turn-running` (the stream covered every open) → `90-laptop-cancel.js` → wait
`turn-idle`.

- Sleeps are the eval driver's idiom: `extendedWaitUntil` on `id: "never-there"`
  with `optional: true`. The hold is 2 s (> the 1.5 s budget) so a healthy open
  is never closed before it settles.
- The 30 s waits are generous on purpose: on today's app Maestro must still
  finish, so the **checker** is what turns the flow red.
- `90-laptop-think.js` / `90-laptop-cancel.js`: `http.get` on
  `laptop-prompt?session=${PERF_ID}&prompt=THINKHOLD%20FAST%2090` and
  `laptop-cancel?session=${PERF_ID}`; throw on non-ok.

**5. Wiring** (`e2e/run.ts`):

- `FLOWS`: `"90-perf-stream"` after `"38-running-row"` (before the lock flows).
- `COMPOSE_SESSION_VARS`: `"90-perf-stream": "PERF_ID"`; the dispatch at
  `:1026-1027` picks `longSessionOf` for it (add to the import at `:659-671`).
- After `spawnFlow`, inside the same `try`, for `PERF_FLOW`: wait 4 s (two drain
  periods), read `.1` then live (new `appLogText(udid)`; `appLogFile` unchanged),
  write `perf.txt` and `ptrace.txt` (the `ptrace` lines) into `outDir`, print the
  report, `outcome = perfOutcome(outcome, report)`.

### Files

| File | Change |
|---|---|
| `apps/mobile/src/perf-probe.ts` | `appState()` |
| `apps/mobile/App.tsx` | the `AppState` listener |
| `apps/mobile/e2e/perf-budget.ts` (new) | pure checker |
| `apps/mobile/e2e/seed.ts` | `PERF_ROUNDS`, `longHistory`, `longSessionOf` |
| `apps/mobile/e2e/flows/90-perf-stream.yaml`, `90-laptop-think.js`, `90-laptop-cancel.js` (new) | the flow |
| `apps/mobile/e2e/run.ts` | flow entry, session, post-flow check |
| `apps/mobile/e2e/mock-model.ts` | fix round 1: `FAST_HOLDS`; `THINKHOLD FAST` ends with its load |
| `TODO.md` | in the s0 item: ``e2e flow `90-perf-stream` `` (known-bug until the fix slices) |
| `apps/mobile/test/{perf-trace,perf-budget (new),fan-jank-wiring,e2e-flows}.test.ts` | below |

Beyond the eval's row 0: the probe + `App.tsx` (the TODO item's `app-state` cut),
`seed.ts` and the two scripts (where seeding and hook calls live).

### Failure modes

| Case | Convergence |
|---|---|
| Log unreadable, probe not wired, no lines | evidence violation → red, never a silent pass |
| Truncated / changed line format | violation; a contract test feeds the checker what the real writer produces |
| Stream ends (360 s) before the 4th open's assert | the turn ends with its load, so the `turn-running` assert fails (360 s is above the 282 s the flow's own waits allow, pinned in `e2e-flows.test.ts`) |
| Session setup fails | existing catch, `run.ts:1030-1037` → `fail` |
| Flow dies before the cancel | the held turn ends by itself within 360 s; the app is terminated before the next flow, but until then `serve` and the mock carry the stream while later flows run |
| Log rotated mid-flow | `.1` + live are both read |
| Resume: rAF vs `AppState` event order | both orders handled (Design 1). Not covered: iOS suspending before JS processed `background`; check in the next device export |
| Flow red for an unrelated reason (Maestro, pairing) | also shows `FAIL (known-bug)`: **a slice reads `perf.txt` and `maestro.log`**, never the status alone |
| `--only 90-perf-stream` exit code | `0` while tagged, even when red: read the summary and `perf.txt` |

### Tests

Red before green (AGENTS §9). Unit tests first:

1. `perf-trace.test.ts` (`createPerfProbe`, fake clock/frames, `:115-130`). Add a
   no-op `appState` stub first so red is on the assertion, not a `TypeError`:
   - background → a frame 401 s later → `active` → frames: no line has
     `win` > 2 000 or `renderMs` > 1 000;
   - same with no frame until after `active` (the other order), and the loop is
     running again;
   - `inactive` then `background` then `active` behaves as one suspension;
   - `streaming(true)` while suspended schedules no frame;
   - a fan open at `background` → exactly one fan line, `settle=-1`;
   - a 40 s gap with no state change is still reported (the cut is not a duration
     filter).
2. `perf-budget.test.ts` (inline lines, copied from the eval traces):
   - S2 sample (`win=10257 … worst=10206 … renders=165`, `settle=4573`) → all
     three violations;
   - S1 lines → only the rate; a healthy synthetic log → ok;
   - boundaries: gap 250/251, settle 1500/1501/−1, rate 11/above 11;
   - empty text, 3 streaming fans, 4 non-streaming fans, a missing field → not ok;
   - other kinds, the header line and an `app-state` line are ignored;
   - contract: `createPerfProbe` + `createAppLog` + `entriesToText` → `checkPerf`
     reads the fan and jank lines;
   - `perfOutcome` table; `longHistory(PERF_ROUNDS)`: 120 calls, each answered by
     its `toolCallId`, `PERF_ROUNDS === 120`.
3. `fan-jank-wiring.test.ts`: `App.tsx` passes `AppState` changes to
   `PERF.appState`.
4. `e2e-flows.test.ts`: flow 90 is tagged `known-bug`; think script after the
   `floating-activity` wait; `times:` equals `PERF_BUDGET.minStreamingFans`;
   `turn-running` asserted after the repeat and before the cancel script; `run.ts`
   maps `PERF_ID` and calls `checkPerf` / `perfOutcome`.

Mutation checks (revert after): drop the `suspended` term from `active()`; drop
the minimum-fans rule. Each must turn its test red.

**Validation (simulator).** `bun install` in this worktree first (it has no
`node_modules`). Take `.tentacle/tmp/orchestration/sim.lock` of the main checkout
(`mkdir`; wait if present), `rmdir` it afterwards, also on failure.

1. `bun run e2e:mobile --udid <sim> --only 90-perf-stream`, twice. Required:
   Maestro itself passes (`maestro.log`), the summary says `FAIL (known-bug)`, and
   `perf.txt` shows gap, settle and rate violations in both runs.
2. Control: temporarily `PERF_ROUNDS = 2`, run once, revert. Expected: no gap and
   no settle violation (rate only), as in S1. Otherwise the harness itself is
   tripping the budget: STOP and report.
3. A green run 1, or red only because Maestro failed: STOP, fix the plan.
4. `bun run check`.

Paste both `perf.txt` outputs into Execution.

### Notes / debt

- The long-session control for Maestro's own cost is indirect (short session under
  the flow; long session at rest settled in 1 068 ms in the eval's S3). If a gap
  survives slice 4, measure once without hierarchy polling before blaming the app.
- The rate is computed only over windows that had a gap: a perfectly smooth window
  writes no line. Slice 1's unit test pins the notification count independently.
- Whether 11/s is reachable is proven by the fix slices, not here. The slice that
  first shows `PASS (known-bug)` removes the tag and the TODO mention, after
  checking stability under a multi-simulator gate (shared CPU may add gaps).
- Device ≠ simulator: the owner's `grep ptrace` export stays the device check.

## Execution

*— claude-sonnet-5-5, 2026-11-28*

**Load-bearing check (before any edit):** `repro.ts` and `budget.ts` printed the
Context's output unchanged (gate missing; `win=401016 … renderMs=401000`; S1
24.4 and S2 16.5 renders/s, S2 70 windows with 68 over 250 ms).

**As built, in order** (each red on assertions before its code):

1. Probe cut — `src/perf-probe.ts` `appState()`, `App.tsx` module-scope
   listener. Red with a no-op stub: 5 of the 6 new probe tests (`win=401016`,
   `renderMs=401000`, a frame scheduled while suspended, no `settle=-1` fan
   line) and the wiring test. The sixth (a 40 s stall is still reported) guards
   against over-filtering and is green on both.
2. Checker `e2e/perf-budget.ts` and `longHistory` / `longSessionOf` in
   `e2e/seed.ts`. Red against stubs: 16 of 17 (the one pass: a smooth log is ok).
3. Flow, its two scripts, `run.ts` wiring (`appLogText`, `perfCheck`). Red
   before the wiring: the flow-list guard, the `PERF_ID` mapping test and the
   post-flow check test. The yaml-order test was written after the yaml.

**Drift from Implementation**

- Changelog: the header says `none`; the orchestrator's brief asked for one
  fragment, so `changelog.d/mobile-ui-fluidity-s0.fixed.md` describes the log cut.
- `TODO.md` untouched: the s0 item already names ``e2e flow `90-perf-stream` ``
  and the `e2e-gate` guard passes.
- A `ptrace` line with no `ev` at all is an evidence violation (a truncated
  line); only a present, unknown `ev` is ignored.
- The report lists whole-log verdicts (rate, fan minimum) and per-rule totals
  above the 10 quoted lines, so 68 gap lines cannot hide the rate.
- No protocol schema changed.

**Mutations** (applied, run, reverted)

| Mutation | Result |
|---|---|
| `active()` without `!suspended` | 15 pass, **2 fail** (`inactive → background → active is one suspension`; `a stream that starts while suspended schedules no frame`) |
| checker without the minimum-fans rule (`streamingFans < 0`) | 14 pass, **3 fail** (`not enough evidence is never a pass`; the report-cap test; the `perfOutcome` table) |

A third, extra check for the yaml-order test: `times: 3` → 77 pass, **1 fail**.

**Validation (simulator)** — iPhone 17 Pro, iOS 26.5, Release,
`--only 90-perf-stream`, under `sim.lock` (released; simulator shut down). Run 1
built the app; run 2 and the control reused it (`999306f83751`, unchanged app
source).

| Run | Maestro | Summary | jank lines | worst gap | fan settle ms | renders/s | violations |
|---|---|---|---|---|---|---|---|
| 1 (`1795825265656`) | Passed | `FAIL (known-bug)`, 192 s | 83 | 3670 ms | 4616, 4531, 4706, 4903 | 16.4 | gap 77, settle 4, rate 1 |
| 2 (`1795825900647`) | Passed | `FAIL (known-bug)`, 188 s | 85 | 3427 ms | 4577, 4552, 4437, 4609 | 16.5 | gap 82, settle 4, rate 1 |
| control `PERF_ROUNDS = 2` (`1795826109486`, reverted) | Passed | `FAIL (known-bug)`, 154 s | 70 | 88 ms | 1040, 1083, 1067, 1082 | 23.6 | rate 1 only |

Red for the planned reasons in both runs, and the control matches S1, so the
harness does not trip gap or settle by itself. The `clearState`
precondition holds: run 1's first `ptrace` line (00:29:05Z) is after the flow
started (00:28:11Z). Both `perf.txt` outputs are in the appendix.

**Narrow gate:** after the last edit, 6 files (the task's plus `e2e-gate`,
`e2e-shard`) 221 pass / 0 fail; earlier, the e2e-runner suites (9 files) 325
pass / 0 fail; `biome check` on the changed files clean (after one format of
`run.ts`); `tsc -p apps/mobile` clean. Full gate: the orchestrator's script.

### Fix round 1

*— claude-sonnet-5-5, 2026-11-28*

**HIGH 1 (hub opens with no stream load count as evidence) — fixed.**

- `e2e/mock-model.ts`: `THINKHOLD FAST` keeps its load for `FAST_HOLDS` = 3
  holds (360 s in `run.ts`) and has no trickle tail: the `DELTAS` go out 20 ms
  apart and the turn ends. So the flow's `turn-running` assert after the 4th
  open now means every open ran under load. Plain `HOLD` and non-FAST
  `THINKHOLD` are unchanged.
- 360 s is above the 282 s of explicit waits the flow can spend between the
  think script and that assert (saved run: cancel at about +131 s). A run slower
  than 360 s fails on `turn-running`; it cannot read as a pass.
- Tests: `e2e-mock-thinkhold.test.ts` (load lasts more than two holds, turn ends
  less than half a hold after the last delta); `e2e-flows.test.ts` (load longer
  than the flow's waits, read from the yaml and `run.ts`). The old "4x as often"
  test now compares per hold, since FAST's load is longer.

**Red** (with only an unused `FAST_HOLDS = 1` added, so both fail on the
assertion): `81 pass, 2 fail` —
`Expected: > 282000, Received: 120000`;
`Expected: > 2000, Received: 988.22`. After the fix: `83 pass, 0 fail`.

**Mutations** (`.tentacle/tmp/mobile-ui-fluidity-s0/mutate-fix1.ts`; file
restored byte for byte):

```
== M1 trickle tail back          (hold && !loadOnly -> hold)
Expected: < 500      Received: 1023.32
(fail) THINKHOLD > FAST keeps its load past two holds and ends the turn with it
 82 pass, 1 fail
== M2 load is one hold           ((fast ? FAST_HOLDS : 1) -> 1)
Expected: > 16       Received: 8.67
(fail) THINKHOLD > FAST streams the reasoning about 4x as often
Expected: > 2000     Received: 994.83
(fail) THINKHOLD > FAST keeps its load past two holds and ends the turn with it
 81 pass, 2 fail
== M3 FAST_HOLDS = 2
Expected: > 282000   Received: 240000
(fail) flow 90 > the load outlasts every wait the flow can spend before its last assert
Expected: > 2000     Received: 1998.53
(fail) THINKHOLD > FAST keeps its load past two holds and ends the turn with it
 81 pass, 2 fail
restored: true
```

**Drift:** `mock-model.ts` was not in the Files table; its row, the mock
precondition and the two false failure-mode rows are corrected. A flow that dies
before its cancel now leaves the stream on `serve` for up to 360 s (was 240 s);
no host-side cancel was added.

**Narrow gate:** the 8 test files that import the mock, plus `perf-budget`,
`e2e-gate`, `e2e-shard`: 231 pass / 0 fail; `biome check` on the 3 changed files
clean; `tsc -p apps/mobile` clean. **Not run:** the simulator (verify with
`bun run e2e:mobile --udid <sim> --only 90-perf-stream`: Maestro passes and
`perf.txt` is red on gap, settle and rate). Full gate: the orchestrator's script.

## Review

**Verdict: REQUEST-CHANGES** (1 HIGH).

1. **HIGH — hub opens with no stream load count as evidence.**
   `apps/mobile/e2e/mock-model.ts:727-767` (not in the diff), used by
   `apps/mobile/e2e/flows/90-perf-stream.yaml:76-78` and `e2e/run.ts:548`.
   A `THINKHOLD FAST` turn does not end at `holdMs`: the fast phase stops, then
   the `hold` branch trickles the 5 `DELTAS`, `holdMs/5` apart. The turn lasts
   about 240 s, with load only for the first 120 s. So the planned failure mode
   "stream ends before the 4th open → `turn-running` fails, fans are
   `stream=false`" is **false**, and so is "ends by itself within 120 s".
   - Scaled probe (`holdMs=2000`): last reasoning delta +1998 ms, turn end
     +4017 ms.
   - Saved run `1795825265656`: think 00:29:04.1; the last window has `folds=0`
     at 00:31:05.2; `turn-running` still passes at about +131 s; cancel at +131.6 s.
   - Margin: the 4th fan settles 5–7 s before the load ends (runs …265656,
     …900647, …382110), at about 31.6 s per open.
   - Scenario: Maestro or a shared-CPU gate about 6 % slower puts open 4 (then 3)
     in the trickle. It logs `stream=true`, settles unloaded, meets
     `minStreamingFans` and `turn-running` passes. A slice whose app is still slow
     under load in the later opens can read `PASS (known-bug)`.
   - Needed: the load must cover every open, and its end must be loud (e.g. a
     longer fast phase for this flow, with the turn ending when it ends), pinned
     by a red-first test.

**Holds:** 6 touched/guard test files 221 pass / 0 fail; `bun run lint` clean
(2807 files); `bun run typecheck` clean. §7: no invariant touched (pure checker
and probe, one listener, seeding through `openSession`). Probe suspend/resume
orders hold; the uncovered one is already declared. Replaying `checkPerf` on the
4 saved `ptrace.txt` gives the table's numbers; the fourth run (…382110, not in
Execution) is red too.

**Mutations** (15, restored byte-for-byte): 13 killed. Survivors, below
MEDIUM: inverting `flow === PERF_FLOW` (`run.ts`), and `longHistory(2)` inside
`longSessionOf`; both are covered only by the simulator runs.

**Not run:** full `bun run check`, the simulator, the Context repro on `main`.

**Note:** commit `601dfd5f` says `exec (deepseek)`, but Execution is signed
`claude-sonnet-5-5`. The brief asked for an opus signature; the model that ran
this review is Sonnet 5.5, so it is signed as such. If the executor was also
Sonnet, only the context was fresh.

*— claude-sonnet-5-5, 2026-11-28*

## Appendix — history

`perf.txt` of validation runs 1 and 2, verbatim.

```
PERF FAIL
jank lines: 83, fan lines: 4 (4 streaming)
worst gap: 3670 ms
fan settle ms: 4616, 4531, 4706, 4903
renders/s: 16.4
violations: gap 77, settle 4, rate 1
  rate: 16.4 renders/s > 11
  gap: worst=314 > 250 ms — 2026-11-28T00:29:05.307Z info ptrace ev=jank win=1006 gaps=5 worst=314 lost=634 stream=true folds=86 notifies=16 renders=16 renderMs=692
  gap: worst=251 > 250 ms — 2026-11-28T00:29:06.372Z info ptrace ev=jank win=1065 gaps=7 worst=251 lost=667 stream=true folds=91 notifies=19 renders=19 renderMs=756
  gap: worst=323 > 250 ms — 2026-11-28T00:29:08.445Z info ptrace ev=jank win=1054 gaps=7 worst=323 lost=627 stream=true folds=98 notifies=18 renders=18 renderMs=705
  gap: worst=3332 > 250 ms — 2026-11-28T00:29:12.756Z info ptrace ev=jank win=4310 gaps=9 worst=3332 lost=3736 stream=true folds=366 notifies=71 renders=71 renderMs=3756
  gap: worst=506 > 250 ms — 2026-11-28T00:29:13.880Z info ptrace ev=jank win=1124 gaps=6 worst=506 lost=741 stream=true folds=101 notifies=19 renders=19 renderMs=813
  gap: worst=556 > 250 ms — 2026-11-28T00:29:14.946Z info ptrace ev=jank win=1067 gaps=5 worst=556 lost=752 stream=true folds=93 notifies=18 renders=18 renderMs=809
  gap: worst=431 > 250 ms — 2026-11-28T00:29:15.955Z info ptrace ev=jank win=1009 gaps=3 worst=431 lost=816 stream=true folds=88 notifies=17 renders=17 renderMs=837
  gap: worst=500 > 250 ms — 2026-11-28T00:29:17.040Z info ptrace ev=jank win=1085 gaps=2 worst=500 lost=953 stream=true folds=92 notifies=18 renders=18 renderMs=957
  gap: worst=969 > 250 ms — 2026-11-28T00:29:18.043Z info ptrace ev=jank win=1003 gaps=1 worst=969 lost=953 stream=true folds=87 notifies=17 renders=17 renderMs=940
  gap: worst=3499 > 250 ms — 2026-11-28T00:29:21.589Z info ptrace ev=jank win=3546 gaps=1 worst=3499 lost=3482 stream=true folds=308 notifies=59 renders=58 renderMs=3387
  … 71 more violating lines (81 in all)
```

```
PERF FAIL
jank lines: 85, fan lines: 4 (4 streaming)
worst gap: 3427 ms
fan settle ms: 4577, 4552, 4437, 4609
renders/s: 16.5
violations: gap 82, settle 4, rate 1
  rate: 16.5 renders/s > 11
  gap: worst=457 > 250 ms — 2026-11-28T00:32:39.256Z info ptrace ev=jank win=1329 gaps=4 worst=457 lost=1084 stream=true folds=117 notifies=22 renders=22 renderMs=1115
  gap: worst=252 > 250 ms — 2026-11-28T00:32:40.262Z info ptrace ev=jank win=1006 gaps=7 worst=252 lost=539 stream=true folds=86 notifies=17 renders=17 renderMs=631
  gap: worst=254 > 250 ms — 2026-11-28T00:32:41.279Z info ptrace ev=jank win=1017 gaps=6 worst=254 lost=619 stream=true folds=84 notifies=17 renders=17 renderMs=687
  gap: worst=313 > 250 ms — 2026-11-28T00:32:42.374Z info ptrace ev=jank win=1095 gaps=6 worst=313 lost=727 stream=true folds=101 notifies=19 renders=19 renderMs=803
  gap: worst=2915 > 250 ms — 2026-11-28T00:32:46.510Z info ptrace ev=jank win=3083 gaps=2 worst=2915 lost=2947 stream=true folds=268 notifies=51 renders=51 renderMs=2892
  gap: worst=385 > 250 ms — 2026-11-28T00:32:47.597Z info ptrace ev=jank win=1086 gaps=4 worst=385 lost=830 stream=true folds=96 notifies=18 renders=18 renderMs=860
  gap: worst=447 > 250 ms — 2026-11-28T00:32:48.632Z info ptrace ev=jank win=1035 gaps=4 worst=447 lost=765 stream=true folds=90 notifies=17 renders=17 renderMs=800
  gap: worst=551 > 250 ms — 2026-11-28T00:32:50.181Z info ptrace ev=jank win=1549 gaps=5 worst=551 lost=1216 stream=true folds=134 notifies=26 renders=26 renderMs=1259
  gap: worst=486 > 250 ms — 2026-11-28T00:32:51.248Z info ptrace ev=jank win=1067 gaps=2 worst=486 lost=937 stream=true folds=93 notifies=18 renders=18 renderMs=941
  gap: worst=3404 > 250 ms — 2026-11-28T00:32:55.233Z info ptrace ev=jank win=3985 gaps=2 worst=3404 lost=3862 stream=true folds=348 notifies=67 renders=67 renderMs=3768
  … 76 more violating lines (86 in all)
```
