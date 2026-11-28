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
- The mock's `THINKHOLD FAST` sends a reasoning delta every 10 ms
  (`e2e/mock-model.ts:706,727-733`) for at most `holdMs` = 120 s
  (`e2e/run.ts:540`). The eval's S2 run fit about 70 windows.
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
| `TODO.md` | in the s0 item: ``e2e flow `90-perf-stream` `` (known-bug until the fix slices) |
| `apps/mobile/test/{perf-trace,perf-budget (new),fan-jank-wiring,e2e-flows}.test.ts` | below |

Beyond the eval's row 0: the probe + `App.tsx` (the TODO item's `app-state` cut),
`seed.ts` and the two scripts (where seeding and hook calls live).

### Failure modes

| Case | Convergence |
|---|---|
| Log unreadable, probe not wired, no lines | evidence violation → red, never a silent pass |
| Truncated / changed line format | violation; a contract test feeds the checker what the real writer produces |
| Stream ends (120 s) before the 4th open | `turn-running` assert fails, and `stream=false` fans miss the minimum |
| Session setup fails | existing catch, `run.ts:1030-1037` → `fail` |
| Flow dies before the cancel | the held turn ends by itself within 120 s; the app is terminated before the next flow (`run.ts:998`) |
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

*(empty)*

## Review

*(empty)*
