# fix/e2e-26-drawer-pro — flow 26 loses the rename sheet on the iPhone 17 Pro

> **Status:** implementation (APPROVED)
> **Branch:** `fix/e2e-26-drawer-pro`
> Type: fix · Size: S · Blast: contained · Suited: Sonnet
> **Size:** S · **Blast:** contained (e2e flows and their guard test; no app code) · **Suited:** Sonnet exec + standard Review; needs the simulator
> **Changelog:** none (test-only)

## Context

*— claude-sonnet-5-5, 2026-11-26*

`TODO.md` says `26-drawer` **always** fails on the iPhone 17 Pro (`0FA4B51F…`)
with `session-rename-save` not found, and passes on the Pro Max. It was seen by
the two-simulator validation (`docs/feat/e2e-parallel-gate.md:475-491`).

**The "always" does not hold on current `main` (`340ad571`): the unchanged flow
passed on the Pro twice, 2026-11-26.** The screen-size explanation is ruled out.
What is reproduced is the exact error, by forcing one specific tap (below).

### History on the Pro

| log (`.tentacle/tmp/orchestration/runs/`) | 26 on the Pro |
|---|---|
| `e2e-gate-1121b.log:245` (21/11) | FAIL, put down to an 08c cascade; the sheet was gone (`docs/fix/mobile-e2e-1121.md:48-52`) |
| `e2e-gate-1121c.log:244` (21/11) | PASS |
| `e2e-gate-2211.log:243` (22/11) | PASS |
| `e2e-gate-parallel-1.log:306` (23/11) | FAIL |
| `e2e-gate-parallel-single.log:66` (23/11) | FAIL |
| this task, two runs (26/11) | PASS, PASS |

Later two-simulator gates (`e2e-gate-2411b.log`, `e2e-gate-2511c.log`) put 26 on
the Pro Max, so they say nothing about the Pro. No screenshot or hierarchy of the
23/11 failures was found under `.tentacle/` or `~/.maestro/tests`.

### Repro (all on `0FA4B51F…`, simulator lock held, 2026-11-26)

**1. The TODO command, unchanged tree** (`repro-pro.log`, run `1795655404113`):

```
$ scripts/e2e-gate.sh 0FA4B51F-A0E3-421B-BE66-CE29EF45213D --only 26-drawer
app: cached db6b1cfc5b15 for the next run
✓ 26-drawer (iOS 26) pass
GATE PASS — 1 passed, 0 failed, 0 known-bug, 0 quarantined (of 1; 84 s)
```

**2. The pair that failed on 23/11** (`repro-pro-01-26.log`, run `1795656139399`):

```
$ scripts/e2e-gate.sh 0FA4B51F-… --only 01-shell,26-drawer
✓ 01-shell (iOS 26) pass
✓ 26-drawer (iOS 26) pass
GATE PASS — 2 passed, 0 failed, 0 known-bug, 0 quarantined (of 2; 116 s)
```

**Geometry from run 1's `maestro.log`** (points; screen 402×874), keyboard up:

| element | bounds |
|---|---|
| `session-rename-input` (at its tap) | `[47,258][355,304]` |
| `session-rename-save` | `[201,320][371,366]` |
| keyboard top (screenshot `rename-open.png`, run 3) | y ≈ 539 |

Save is about **170 pt above the keyboard**. The card ends at y ≈ 366. It is not
covered, off screen, behind a safe area, or in need of a scroll.

**3. Forced stale tap → the exact error** (`forced-race.log`, run
`1795656389865`). The flow's `tapOn session-rename-input` was replaced by a tap
at `50%,50%` (y = 437), about where the field sits while the card is still
centred on the whole screen, before the keyboard moves it up:

```
✗ 26-drawer (iOS 26) fail
GATE FAIL — 0 passed, 1 failed, 0 known-bug, 0 quarantined (of 1; 81 s)
maestro.log: [Failed] 26-drawer (1m 12s) (Element not found: Id matching regex: session-rename-save)
```

`rename-open.png`: card and Save fully visible above the keyboard, cursor already
in the field with no tap. `rename-after-stale-tap.png`: the sheet is gone, the
drawer is back, the title is still `compose`.

**4. The candidate fix** (`fix-candidate.log`, run `1795656499605`): no tap on the
field, `waitForAnimationToEnd`, then `eraseText` / `inputText` / Save:

```
✓ 26-drawer (iOS 26) pass
GATE PASS — 1 passed, 0 failed, 0 known-bug, 0 quarantined (of 1; 84 s)
```

Logs and runs 3–4's screenshots are in
`/Users/gmeghnag/tentacle/.tentacle/tmp/e2e-26-drawer-pro/` (runs 3–4 under
`harness/.tentacle/tmp/e2e-mobile/<run>/`). Runs 1–2's artefacts are in the
worktree's `.tentacle/tmp/e2e-mobile/`.

Runs 3–4 used a throwaway copy of the harness, so no repo flow was edited
(`mirror.ts <forced|fix>`, then
`bun …/harness/apps/mobile/e2e/run.ts --udid 0FA4B51F-… --app <worktree>/.tentacle/tmp/e2e-app-cache/db6b1cfc…/tentacle.app --only 26-drawer`):

```ts
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WT = "/Users/gmeghnag/tentacle/.tentacle/worktrees/e2e-26-drawer-pro";
const H = join(import.meta.dir, "harness");
const variant = process.argv[2];
const link = (from: string, to: string) => {
  if (!existsSync(to)) symlinkSync(from, to);
};
mkdirSync(join(H, "apps", "mobile"), { recursive: true });
for (const name of readdirSync(WT)) {
  if (name === "apps" || name === ".tentacle" || name === ".git") continue;
  link(join(WT, name), join(H, name));
}
for (const name of readdirSync(join(WT, "apps"))) {
  if (name !== "mobile") link(join(WT, "apps", name), join(H, "apps", name));
}
for (const name of readdirSync(join(WT, "apps", "mobile"))) {
  if (name !== "e2e") link(join(WT, "apps", "mobile", name), join(H, "apps", "mobile", name));
}
cpSync(join(WT, "apps", "mobile", "e2e"), join(H, "apps", "mobile", "e2e"), { recursive: true });

const flow = join(H, "apps", "mobile", "e2e", "flows", "26-drawer.yaml");
const original = readFileSync(flow, "utf8");
const tapInput = `- tapOn:
    id: "session-rename-input"
- eraseText
- inputText: "Renamed in drawer 26"
`;
if (!original.includes(tapInput)) throw new Error("anchor not found");
const replacement =
  variant === "forced"
    ? `- waitForAnimationToEnd
- takeScreenshot: rename-open
- tapOn:
    point: "50%,50%"
- waitForAnimationToEnd
- takeScreenshot: rename-after-stale-tap
- eraseText
- inputText: "Renamed in drawer 26"
`
    : `- waitForAnimationToEnd
- takeScreenshot: rename-open
- eraseText
- inputText: "Renamed in drawer 26"
- takeScreenshot: rename-typed
`;
writeFileSync(flow, original.replace(tapInput, replacement));
```

### Diagnosis, and what is not proven

- **Proven:** the app is usable on the Pro. The field takes focus by itself. A tap
  at the field's pre-keyboard position lands on the dismiss scrim and produces
  the flow's exact failure.
- **Inferred, not proven:** that the 23/11 runs failed this way. Maestro reads an
  element's bounds, then taps them. `assertVisible` (`26-drawer.yaml:56-57`)
  passes as soon as the field exists, so `tapOn` (`:58-59`) can read bounds
  while the keyboard is still rising and tap after the card has moved. Between
  the sheet opening and Save, this tap is the one step that aims at screen
  content that can move; a miss cancels the sheet, and `eraseText`/`inputText`
  do not fail with no field, so the first error is at Save.
- **Unknown:** why it hit the Pro 3 times and not the Pro Max. Timing or
  simulator state is the likely difference. `RenameSheet.tsx` is unchanged since
  the failing build's commit `e6fee2b0` (`git diff --stat e6fee2b0 HEAD`: only
  `SessionsDrawer.tsx` row marks, `theme.ts`, `package.json` among the files
  checked), so no app edit to the sheet explains the recovery.

## Implementation

*— claude-sonnet-5-5, 2026-11-26* — **APPROVED** (decisions delegated by the owner)

### Load-bearing assumption

The rename field focuses itself, so a flow never needs to tap it:
`apps/mobile/src/screens/RenameSheet.tsx:59` (`autoFocus`). Seen on the
simulator in run 3 (`rename-open.png`: keyboard up, cursor in the field, no tap)
and run 4 (typing without a tap reaches the daemon: `26-drawer.js` passed).

### Preconditions

- The scrim behind the card calls `onCancel` on any tap
  (`RenameSheet.tsx:41-45`).
- The card is centred inside a `KeyboardAvoidingView` (`RenameSheet.tsx:37-40`,
  `:124`), so it **moves** when the keyboard rises.
- One component serves both entry points: the drawer
  (`screens/SessionsDrawer.tsx:343-349`, flow 26) and the session title
  (`screens/SessionScreen.tsx:2530-2536`, flow 25).
- Both flows end on daemon truth for the rename (`26-drawer.js`,
  `25-session-info.js`), so typing that goes nowhere cannot pass silently.
- Flows are not app-cache inputs (`apps/mobile/e2e/README.md:67-70`): no rebuild
  is caused by this change.

### Design

Remove the redundant tap and let the sheet settle before typing. In both flows:

```yaml
- assertVisible:
    id: "session-rename-input"
# No tap on the field: it is auto-focused, and the card MOVES as the keyboard
# rises — a tap aimed at its old place hits the scrim and cancels the rename
# (docs/fix/e2e-26-drawer-pro.md).
- waitForAnimationToEnd
- eraseText            # flow 25 keeps `eraseText: 60`
- inputText: "…"
```

No app change, no retry tag, no coordinate tap, no change to the harness.

#### Orchestrator decisions

1. **Fix the flow, not the app.** Save is reachable with about 170 pt to spare.
   The rule was "app if unreachable, else flow".
2. **Fix flow 25 too.** It has the same tap (`25-session-info.yaml:117-118`) on
   the same component. Its earlier reds (`e2e-gate-2211d.log:233`) are **not**
   claimed to be this cause: their error was not found.
3. **No `flaky` tag.** A retry would hide a recurrence.
4. **Proceed although the original red does not reproduce on its own:** the exact
   error is reproduced by the forced tap, and the removed step has no purpose.
5. **The scrim's tap-to-cancel stays** (see Failure modes).

### Files

1. `apps/mobile/test/e2e-flows.test.ts` — new `describe` (write first, see it red).
2. `apps/mobile/e2e/flows/26-drawer.yaml:58-59` — drop the `tapOn`, add the
   comment and `waitForAnimationToEnd`.
3. `apps/mobile/e2e/flows/25-session-info.yaml:117-118` — same; keep the existing
   `eraseText: 60` and its comment (`:119-121`).

### Failure modes

| case | outcome |
|---|---|
| `waitForAnimationToEnd` returns before the keyboard has risen | Nothing aims at the moving card until after typing, when Save's bounds are read fresh. Lost keystrokes fail the daemon-truth script: red, never a false pass. |
| `autoFocus` removed, or not honoured from the title tap in flow 25 | Typing goes nowhere → daemon-truth red. The source pin below catches removal. Flow 25 without the tap has **not** been run yet: it must be run in validation. |
| No software keyboard (hardware keyboard connected) | The card does not move; `autoFocus` still applies. Not run. |
| Flow 26 reds again on the Pro with the same error | The diagnosis was wrong or partial. Keep the run directory (screenshot and hierarchy at the failing step) and reopen; do not tag `flaky`. |
| A person taps where the field was, mid-animation | The rename cancels with nothing sent. Existing behaviour, not observed from a user, out of scope (a native iOS alert would not dismiss on an outside tap: a possible follow-up). |

### Tests

Add to `apps/mobile/test/e2e-flows.test.ts` (line scan, `FLOWS_DIR` at `:25`):

1. No `.yaml` in `FLOWS_DIR` has `tapOn:` or `longPressOn:` with
   `id: "session-rename-input"`. **Red now** (flows 25 and 26).
2. In `25-session-info` and `26-drawer`, after
   `assertVisible session-rename-input` come (comments allowed)
   `waitForAnimationToEnd`, then `eraseText`. **Red now.**
3. Guard (green before and after, not the regression test):
   `src/screens/RenameSheet.tsx` still contains `autoFocus`.

Run: `bun test apps/mobile/test/e2e-flows.test.ts`, then
`bunx biome check apps/mobile/test/e2e-flows.test.ts`. Full `bun run check`
before done.

**Simulator validation, on the Pro**, under the lock
(`.tentacle/tmp/orchestration/sim.lock`), **twice**:

```sh
scripts/e2e-gate.sh 0FA4B51F-A0E3-421B-BE66-CE29EF45213D --only 25-session-info,26-drawer
```

The chain's script gate runs changed flows on the **Pro Max** by default
(`night-task5.sh:35`), which passed before this fix. Start it with
`SIM=0FA4B51F-A0E3-421B-BE66-CE29EF45213D`, or run the command above by hand.

### Build launchers and the two-simulator gate

The form is `scripts/e2e-gate.sh <promax>,<pro>`. The TODO's "launchers stay
single-sim" is **out of date**: the newest ones already use two simulators
(owner, 25/11). Paths are under `.tentacle/tmp/orchestration/` (gitignored, not
part of this diff).

| where | state | action |
|---|---|---|
| `run-build-2511c.sh:6,14` (newest) | two-sim | none; copy it for the next build |
| `run-build-2511.sh:6,16`, `run-build-2411b.sh:6,16` | two-sim | none |
| `run-gate-build-2311.sh:4,9`, `run-gate-build-2211c.sh:4,7`, `run-gate-build-2211d.sh:4,9`, `run-gate-qa-build-2411.sh:4,9`, `run-merge-build-2411.sh:6,37`, `run-night-2411{,b,c,d}.sh` | single, Pro Max | dated one-offs: do not reuse unchanged |
| `run-gate-build-2211b.sh:8`, `run-day-build-2211.sh:16`, `run-night-build-2211.sh:18` | single, Pro | dated one-offs: same |
| `night-task5.sh:35`, `night-task6.sh:33` (`--only` branch gate) | single | stays single |
| `run-build-2511c.sh:17` (rerun of red flows; likewise `2511.sh:19`, `2411b.sh:19`) | single, `$SIM` = Pro Max | stays; note it can turn a Pro-only red green |
| `apps/mobile/e2e/README.md:98-104` (publishing instructions) | single-udid example | optional later edit, not in this task |

At merge, the orchestrator updates the `TODO.md` item (tick it, drop the
"stay single-sim" sentence).

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**The simulator validation on the Pro was NOT run** (see the end). The flows are
changed and guarded by source tests only.

### Done, in order

1. **Load-bearing check (source): holds.** `RenameSheet.tsx:59` is `autoFocus`.
   The simulator half rests on the Context's runs 3–4; it was not repeated.
2. **Reproduction:** the Context's simulator runs were not repeated. What was
   reproduced here is the new tests going red on the unchanged flows.
3. `apps/mobile/test/e2e-flows.test.ts`: new `describe`, three tests, written
   first. Red on the unchanged flows (both on their property assertion, the
   guard green):

   ```
   + "25-session-info.yaml: - tapOn:",
   + "26-drawer.yaml: - tapOn:",
   (fail) … > no flow taps or long-presses the rename input
   -   "erase": "- eraseText",          +   "erase": "id",
   -   "settle": "- waitForAnimationToEnd",   +   "settle": "- tapOn:",
   (fail) … > flows 25 and 26 let the sheet settle before they type
    70 pass
    2 fail
   ```

4. `26-drawer.yaml` and `25-session-info.yaml`: the `tapOn` on the field is
   replaced by the comment and `waitForAnimationToEnd`. Flow 25 keeps
   `eraseText: 60` and its comment. Green: `72 pass, 0 fail`.

### Mutations

One at a time, each file restored byte for byte
(`.tentacle/tmp/e2e-26-drawer-pro/mutate.ts`, run on the final test file):

```
M1 26: tap re-added: exit 1, 70 pass, 2 fail        (no tap · settle)
M2 26: long-press added: exit 1, 70 pass, 2 fail    (no tap · settle; a comment sits between the lines)
M3 26: settle removed: exit 1, 71 pass, 1 fail      (settle)
M4 25: settle removed: exit 1, 71 pass, 1 fail      (settle)
M5 26: settle after erase: exit 1, 71 pass, 1 fail  (settle)
M6 sheet: autoFocus removed: exit 1, 71 pass, 1 fail (guard)
```

### Checks

- `bun test` on `e2e-flows`, `e2e-shard`, `e2e-session-capabilities`,
  `row-value`: `157 pass, 0 fail`.
- `bunx biome check apps/mobile/test/e2e-flows.test.ts`: clean (after one
  `--write` format fix).
- Full `bun run check`: not run here; the orchestrator's script runs the gate.

### Drift

- The "no tap" test also matches the key without the leading `- ` (same rule,
  slightly wider).
- No changelog fragment, per this doc's header and AGENTS §10 (test-only). The
  executor's spawn prompt asked for one; the two disagree.

### Not run: simulator validation

At 04:33–04:34 CET `orchestration/sim.lock` was held (since 04:28) by another chain:
`xcodebuild` for `mobile-workflows-landing-v2` and a Maestro run on the Pro Max.
The executor may not sleep-poll, so it did not wait. Still owed, **twice**, under
the lock:

```sh
scripts/e2e-gate.sh 0FA4B51F-A0E3-421B-BE66-CE29EF45213D --only 25-session-info,26-drawer
```

Flow 25 without the tap has never been run on a simulator. The script gate's
default simulator is the Pro Max, so it does not cover the Pro unless started
with `SIM=0FA4B51F-A0E3-421B-BE66-CE29EF45213D`.

## Review

*— claude-opus-5-5, 2026-11-26* (fresh context; a different model from the
Sonnet planner and the DeepSeek executor)

**Verdict: APPROVE-WITH-NITS.** No HIGH or MEDIUM findings. Scope: `git diff main...HEAD`.

### Gate (re-run here)

- `bun test apps/mobile/test/e2e-flows.test.ts`: 72 pass, 0 fail.
- `bun run lint`: clean (2591 files). `bun run typecheck`: clean (root, mobile, relay).
- The chain's script gate (`.tentacle/tmp/e2e-26-drawer-pro-sgate.log`):
  full `bun test` 0 fail. `✓ 25-session-info` and `✓ 26-drawer` pass on the
  **Pro Max** (`0B43D716…`). So Execution's "flow 25 without the tap has never
  been run" is out of date: it ran green, on the Pro Max only.

### Premise table

| premise | verdict |
|---|---|
| `RenameSheet.tsx:59` `autoFocus` | TRUE |
| scrim `onPress={onCancel}` (`RenameSheet.tsx:44`) | TRUE |
| card inside a `KeyboardAvoidingView` (`:37`, `:118`) | TRUE |
| one component for both entry points (`SessionsDrawer.tsx:343`, `SessionScreen.tsx:2530`) | TRUE |
| both flows end on daemon truth (`26-drawer.yaml:124` → `26-drawer.js:16`; `25-session-info.yaml:129` → `.js`) | TRUE: lost keystrokes fail the flow; they never pass silently |

### Mutations (each one reverted; `git status` clean afterwards)

- A: put `tapOn session-rename-input` back after the settle step in 26. Both
  new tests fail (70/2).
- B: put the tap back in flow-mapping form (`- tapOn: { id: "session-rename-input" }`).
  Only test 2 fails, and only because of the adjacency check in 25/26. See nit 1.

### Attacks tried

1. **Typing goes nowhere and the flow still passes.** Not possible: the daemon-truth
   title check fails it.
2. **The TODO.md hunk (commit `f1a0c164`) breaks the merge.** It is byte-identical
   to main's `771517b1`, so it merges as a no-op. Main already has a duplicate
   `## Quarantined e2e flows` section (lines 126 and 866). That duplicate is
   pre-existing on main and was not added by this branch.
3. **Another flow taps the field.** `rg` finds the rename input only in flows 25 and 26.
4. **§7 invariants.** Not touched: there is no app, protocol, persistence or
   terminal change.

### Nits

1. `apps/mobile/test/e2e-flows.test.ts:1169`: the "no tap" scan only matches the
   block form. A `tapOn: { id: "session-rename-input" }`, or a block whose first
   key is not `id`, gets past test 1. Outside flows 25 and 26 nothing else would
   catch it.
2. The Pro validation the plan requires (twice, `0FA4B51F…`) has still not run.
   The reviewer took `sim.lock` but was not allowed to run the gate here, then
   released the lock. Flow 26's change matches the Context's run 4, which passed
   on the Pro. Flow 25 has passed only on the Pro Max. Run
   `scripts/e2e-gate.sh 0FA4B51F-A0E3-421B-BE66-CE29EF45213D --only 25-session-info,26-drawer`
   before ticking the TODO item.

### How the executor behaved

The executor stayed inside the plan. It wrote the tests first and showed them
red, then ran six mutations, each reverted. It reported honestly that it did not
run the simulator. The gate-fix round re-added TODO lines that main had
restored on its own in the meantime. That was harmless.
