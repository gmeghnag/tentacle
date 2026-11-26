# fix/tui-accidental-copy

> Round 0 shipped no task doc (the reviewer added the Review below). The Context /
> Implementation / Execution here were written in **Fix round 1** from the
> committed diff (`00b9ffa6`) plus fresh runs; the round-1 change is its own
> section in Execution.

## Context

**Problem.** A single left click in the TUI silently overwrote the person's
clipboard. A click is a press plus a release on the same cell, but a hand jitter
while focusing the terminal emits one drag report, so the "selection" reaches
release non-empty and `useMouse` wrote it to the clipboard. Press-release with
zero movement was enough. The copy was also invisible (by design: a notice
resets `scrollOffset` to the tail, jumping the viewport), so nothing told the
person it had happened.

**Evidence (repro on `main`).** `.tentacle/tmp/tui-accidental-copy/repro.ts`
drives `dispatchMouse` through press → drag → release against a tree exported
with `git archive main packages/tui/src`:

```ts
import { dispatchMouse, type MouseState } from "./packages/tui/src/mouse-stream.ts";
const snap = { listView: null, panelBodyTop: 0, statusRow: null, dockTop: null,
  dockView: null, visibleCount: 10, win: { start: 0 }, laid: [], expandAll: false,
  artifactOf: () => undefined, toolAt: () => null } as never;
const rep = (x: number, y: number, btn: number, press: boolean) => ({ x, y, btn, press }) as never;
function run(x0: number, y0: number, x1: number, y1: number): string[] {
  let state = { click: { armed: null }, selection: null } as unknown as MouseState;
  const out: string[] = [];
  for (const r of [rep(x0, y0, 0, true), rep(x1, y1, 32, true), rep(x1, y1, 0, false)]) {
    const step = dispatchMouse(state, r, snap);
    state = step.state;
    out.push(step.effects.map((e) => e.kind).join(",") || "-");
  }
  return out;
}
console.log("2-cell click   press(3,1) drag(5,1) release:", run(3, 1, 5, 1).join(" | "));
console.log("1-row jitter   press(3,1) drag(4,2) release:", run(3, 1, 4, 2).join(" | "));
console.log("3-cell drag    press(1,1) drag(4,1) release:", run(1, 1, 4, 1).join(" | "));
console.log("2-row drag     press(1,1) drag(6,3) release:", run(1, 1, 6, 3).join(" | "));
```

`bun ./repro.ts` on `main` — every gesture copies, including a 2-cell click:

```
2-cell click   press(3,1) drag(5,1) release: - | - | copySelection
1-row jitter   press(3,1) drag(4,2) release: - | - | copySelection
3-cell drag    press(1,1) drag(4,1) release: - | - | copySelection
2-row drag     press(1,1) drag(6,3) release: - | - | copySelection
```

**Constraints.** SGR-mouse coordinates reach the App as screen cells; the
decision must be pure (AGENTS §7: branching in a tested module, the component
only renders); the confirmation must not move the transcript; nothing here
touches the wire, persistence, the broker or raw terminal writes.

**Decision it serves.** A release copies only a DELIBERATE selection, and a real
copy says so without perturbing the viewport.

*— claude-opus-5-5, 2026-11-26*

## Implementation

**Load-bearing assumption.** A click's stray movement is *small* — a cell or two
— while an intended selection is measurably larger, so a threshold on the
selection's extent separates them. Verified by the repro above (a real drag
travels ≥ 3 cells or ≥ 2 rows) and by the geometry fact that a terminal cell is
≈ 2× taller than wide (so a 1-row jump is ~1 px of vertical jitter).

**Preconditions (verified against the source).**
- `copySelection` is emitted at exactly ONE site — the non-press branch of
  `dispatchMouse` (`packages/tui/src/mouse-stream.ts:335`) — so one guard covers
  every copy path; `useMouse.ts:139` still guards the empty text.
- A selection is set only by press/drag (`mouse-stream.ts:345-355`), so a release
  never *extends* it; release is the only place the guard is needed.
- `pushNotice` resets `scrollOffset` (`App.tsx`), so the confirmation must not use
  it; the status bar's suffix is a single row the frame height is pinned to
  (`StatusBar.tsx:126`, `statusLayout`).
- Ink measures an empty `<Text>` as 0×0 — no new row may be added by the note.

**Design.** Two pure decisions plus their wiring:
1. `isDeliberate(sel)` (`selection.ts`) — a release copies only when the
   selection crossed **two** rows, or travelled `COPY_MIN_CELLS` (= 3) cells along
   a row. **Round-2 correction:** physical travel, direction-free — round 1
   required the one-row travel to be *forward*, which refused the ordinary
   gesture for a phrase that wraps (the tail of one row down to the head of the
   next). Anything less is a click.
2. `copiedLabel(chars)` / `COPIED_NOTE_MS` (`selection.ts`) — the transient
   status-bar text and its 2 s life.
   `dispatchMouse` emits `copySelection` only for a deliberate selection;
   `useMouse` reports success through the new host callback `onCopied` instead of
   a transcript notice; `App` holds `copiedNote` and clears it on a timer;
   `AppViewModel.copiedNote` → `AppView` → `StatusBar`'s suffix.

**Files.** `selection.ts` (rules) · `mouse-stream.ts` (guard) · `useMouse.ts`
(`onCopied`) · `App.tsx` (state + timer) · `app-layout.ts`, `AppView.tsx`,
`StatusBar.tsx` (the one status row) · tests `accidental-copy.test.tsx` (new),
`mouse-stream.test.ts`, `app.test.tsx` · `changelog.d/tui-accidental-copy.fixed.md`.

**Failure modes.** *Clipboard write rejects* → `pushNotice("_Clipboard
unavailable._")` (unchanged). *Release with no selection* → no effect, empty
text guard still applies. *Second copy inside 2 s* → the timer restarts
(`clearTimeout`), so the note never expires early. *Unmount before the timer* →
`setState` on an unmounted tree is a no-op in React 18; App's effect count is
pinned by structural tests, so no cleanup effect was added. *One-row jitter* →
`isDeliberate` false (round 1). *Wrapped phrase* (tail of one row → head of the
next, head LEFT of the anchor) → `isDeliberate` true: the rule is direction-free
(round 2). *Selection scrolled out of view* → unchanged: the
App assembles the whole buffer on release.

**Tests.** Pure rule (extent thresholds, both orientations), integration through
the real App with an injected `clipboard` (2-cell click, one-row jitter, one-row
crossing with real travel, 3-cell drag + status-bar text, multi-row copy with the
scroll offset and transcript body unchanged, transience), and the dispatch seam
(`copySelection` only for a deliberate selection).

*— claude-opus-5-5, 2026-11-26*

## Execution

**Round 0** (`00b9ffa6`, no doc — reconstructed from the commit).
- `selection.ts`: `COPY_MIN_CELLS = 3`, `isDeliberate` ("crossed a row, or ≥ 3
  cells on one row"), `COPIED_NOTE_MS = 2000`, `copiedLabel`.
- `mouse-stream.ts:335-345`: the release branch computes
  `copy = state.selection !== null && isDeliberate(state.selection)` and returns
  `NONE` otherwise.
- `useMouse.ts:140-151`: `clipboard(text).then(() => onCopied(text.length),
  () => pushNotice(...))` — success no longer a transcript notice.
- `App.tsx:2019-2033`: `copiedNote` + `onCopied` with a re-armed timer; passed at
  `:2043` and into the view-model at `:2498`.
- `app-layout.ts:557`, `AppView.tsx:71,295`, `StatusBar.tsx:77,119,126-129`: the
  note rides the existing status-bar suffix, in front of "↑N more"/"expanded".
- `app.test.tsx:1111`: "no Copied in the transcript" narrowed to the body rows
  (the status row legitimately says it now).

**Red before green.** The new tests were shown red with the guard removed
(mutation M1 below: 3 fail) — i.e. they fail on the *behaviour* `main` has, not
on a missing import.

**Mutations (round 0, all reverted).**
- M1 release copies any selection (`state.selection !== null && isDeliberate(...)`
  → `state.selection !== null`) → 3 fail: the 2-cell click, the one-row jitter,
  the dispatch seam. Reverted clean.
- M2 (reviewer) confirmation via `pushNotice` → 2 fail (scroll offset, transience).
- M3 (reviewer) row change not deliberate → 1 fail (pure rule only).

### Fix round 1

**Finding 1 (MEDIUM — no task doc / TODO entry / red evidence).** This doc now
carries Context (with the `main` repro and its output), Implementation (verified
`file:line`), Execution (as-built + red evidence + mutations), and `TODO.md` has
an **Owner review queue** entry pointing here.

**Finding 2 (MEDIUM — a 1-row vertical jitter still copied).** `isDeliberate`
accepted ANY row change, so anchor (r,c) → head (r+1,c) — one drag report one
pixel down — copied the rest of row r plus row r+1's prefix. Fixed at
`selection.ts:82-92`: two rows apart is deliberate; a ONE-row crossing must also
travel `COPY_MIN_CELLS` forward along the row (in the drag direction, so the
reading-order end is past the reading-order start); the same-row rule is
unchanged.

Red first, on the unfixed round-0 code (`bun test packages/tui/test/accidental-copy.test.tsx`):

```
(fail) isDeliberate (pure rule) > a one-row jump also needs COPY_MIN_CELLS along the row, in the drag direction
(fail) accidental copy > a one-row vertical jitter is a click, not a copy
(fail) dispatchMouse release > emits copySelection only for a deliberate selection
 7 pass
 3 fail
```

Green after the fix: `10 pass / 0 fail`.

Mutations for the round-1 fix (reverted; `selection.ts`'s diff is the fix only):

- M4 `Math.abs(rows) >= 2` → `>= 1` (the round-0 rule) → 3 fail: the pure rule,
  the one-row jitter integration test, the dispatch seam.
- M5 `forward >= COPY_MIN_CELLS` → `forward >= 2` → 2 fail: the pure rule and the
  dispatch seam (the integration test uses a 1-cell travel).

Drift: `mouse-stream.test.ts:317-322` ("a release COPIES the selection") used a
one-row span with 2 cells of travel, which the new rule rightly refuses; its
fixture became `head: { row: 1, col: 4 }` so the test keeps pinning the
*mechanism* (copy + empty selection) at a deliberate extent. The threshold itself
is pinned in `accidental-copy.test.tsx`. `changelog.d` reworded ("at least 3 cells
or two rows").

Touched tests, narrow: `accidental-copy`, `mouse-stream`, `app` — 158 pass / 0
fail. Full gate: run by the orchestrator (not by this round).

### Gate round 1: the parallel gate's one failure

The gate failed on ONE test, not ours:
`packages/daemon/test/device-store.test.ts` — "processStartedAt places our own
start" (`Received: 19047.27`, expected `< 5000`). Root cause is the test's
ORACLE, not the code: it built the expectation from `process.uptime()`, and under
`bun test --parallel` that is not the pid's age — the gate read them 19 s apart
(a worker's notion of "up"), while `ps -o etime=` answers for the process. Green
in isolation and with `--parallel` on this file alone, which is why it only ever
shows up in the full gate.

Fix (test only, `device-store.test.ts`): the expectation now comes from the OS's
own elapsed time for the pid (`psEtimeSeconds` helper next to the suite), plus
three assertions that keep the original intent: (a) `processStartedAt(pid, now)`
is within 2 s of `now - etime·1000`; (b) moving `now` an hour moves the answer
an hour (so nothing local-time/`lstart` enters — the timezone regression of
`docs/fix/daemon-records-stale.md`); (c) the same for a long-lived pid (`1`), so
a seconds-for-milliseconds mistake is days off, not our own process's few
seconds. Mutations, reverted: `now - elapsed` (units) → fail on (c); `… - 3_600_000`
(an hour off) → fail on (a)/(c). Green: `44 pass / 0 fail`; `biome check` clean
on both files touched.

*— deepseek, 2026-11-26*

*— claude-opus-5-5, 2026-11-26*

### Fix round 2

**R2 finding 1 (HIGH — a selection across a line break did not copy).** Root
cause: `isDeliberate`'s one-row case compared *displacement along the row in the
drag direction* (`selection.ts` round-1 lines 90-91), so the wrap gesture — press
(5,40), drag (6,5) — had a negative "forward" and was judged a click: highlight
shown, release copied nothing, silently.

Fix (`packages/tui/src/selection.ts:82-88`): the rule is physical travel and
direction-free —

```ts
const rows = Math.abs(sel.head.row - sel.anchor.row);
const cols = Math.abs(sel.head.col - sel.anchor.col);
return rows >= 2 || cols >= COPY_MIN_CELLS;
```

The doc comment now states *why* direction must not matter (the wrap gesture),
and `COPY_MIN_CELLS`'s comment was reworded ("travelled ≥ 3 cells along a row,
or crossed two rows"). No other call site changed: `mouse-stream.ts:340` is still the one
guard and `useMouse`'s empty-text guard is untouched.

**Red first** on the unfixed rule (`bun test packages/tui/test/accidental-copy.test.tsx`):

```
(fail) isDeliberate (pure rule) > a one-row jump needs COPY_MIN_CELLS of physical travel, on either axis
(fail) accidental copy > a wrapped phrase: tail of one row to the head of the next still copies
(fail) dispatchMouse release > emits copySelection only for a deliberate selection
 8 pass
 3 fail
```

Green after the fix: `11 pass / 0 fail`. The probe the reviewer used
(`.tentacle/tmp/tui-accidental-copy/r2.ts`), before → after:

```
jitter down (5,10)->(6,11): false -> false
wrap phrase down (5,40)->(6,5): false -> true
wrap phrase up   (6,5)->(5,40): false -> true
down-right (5,10)->(6,20): true -> true
```

**Tests added/changed** (`accidental-copy.test.tsx`): the pure-rule test is now
"needs COPY_MIN_CELLS of physical travel, on either axis" (the round-1 assertion
that pinned *backwards* travel as "no copy" is replaced by the wrap cases — it
pinned the bug); a new integration test presses (10,1) and drags to (2,2) —
a wrapped phrase through the real App — expecting exactly one copy whose text
contains a newline and "Copied · " in the status bar; the dispatch seam gained
`mk(5, 1, 40)` (anchor row 0 col 40 → head row 1 col 5, deliberate). The jitter
cases are unchanged and still refused.

**Mutations (both reverted; `git status` shows only the two intended files).**
- M6 forward-only travel again (`rows >= 2 || sel.head.col - sel.anchor.col >=
  COPY_MIN_CELLS`) → 4 fail: the single-row rule, the one-row rule, the wrap
  integration test, the dispatch seam. This is the round-1 bug, so the new tests
  are pinned against its return, not only against its absence.
- M7 any row change deliberate (`rows >= 1`) → 3 fail: the one-row rule, the
  one-row jitter integration test, the dispatch seam (the jitter direction is
  still guarded).

**Verification.** Narrow: `accidental-copy` + `mouse-stream` + `app` = 159
pass / 0 fail. `bunx biome check` on both changed files: clean. Drift: Implementation's Design item 1 and the Failure-modes line now state
the direction-free rule (round-2 correction, marked as such) — the plan described
the rule round 1 shipped, which the R2 review showed to be a regression.

Not addressed (round-2 note, not a finding): the UTF-16 `copyLabel` count nit.

*— claude (Anthropic; this CLI exposes no model id to the agent), 2026-11-26*

## Review

**Verdict: REQUEST-CHANGES** (code is sound; one process gap, one residual path).

Scope: `git diff main...HEAD` (00b9ffa6), 11 files.

### Findings

1. **MEDIUM — no task doc, no TODO entry, no red evidence** (AGENTS §10, §4, §9).
   `docs/fix/tui-accidental-copy.md` did not exist and `TODO.md` has no item, so
   there is no Context/Repro, no Implementation (failure modes) and no recorded
   red run of the new tests on the buggy code. Fix: write the doc (Repro on
   `main`, plan, as-built) and index it.
2. **MEDIUM — a 1-row vertical jitter still overwrites the clipboard**
   (`packages/tui/src/selection.ts:74-76`). `isDeliberate` demands ≥3 cells
   horizontally but accepts ANY row change. A cell is ~2× taller than wide, and
   a press near a row boundary needs only a 1-px downward jitter to emit one drag
   report on the next row: anchor (r,c) → head (r+1,c) is "deliberate", and the
   release copies the rest of row r plus row r+1's prefix (≈ a full row) — the
   exact bug this task fixes, via the other axis. Suggested: treat a row change
   as deliberate only when the reading-order extent is also non-trivial (e.g.
   |Δrow| ≥ 2, or |Δrow| = 1 with the head ≥ COPY_MIN_CELLS past the anchor's
   column in reading order), or owner confirms the asymmetry is accepted; pin it
   with an integration test (press (x,y), drag (x,y+1), release).

### Gate
- Touched tests: `accidental-copy`, `mouse-stream`, `app`, `selection` — 165 pass / 0 fail.
- `bun run lint`: clean (2709 files).
- `tsc --noEmit`: 23 errors, ALL in files this branch does not touch
  (`apps/mobile/src/highlight.ts`, `agent/.../a2a-map.ts`, `cli/test/a2a-wiring`,
  `cli/test/serve-mcp-e2e`) — a worktree type-resolution issue, not this diff;
  0 in `packages/tui`. Full `bun run test` not run by the reviewer.

### Mutation (non-vacuity, all reverted; `git status` clean after)
- M1 release copies any selection (drop `isDeliberate`) → 2 fail (integration 2-cell click, dispatch test). ✔
- M2 confirmation via `pushNotice` instead of `onCopied` → 2 fail (scroll-offset-unchanged, transient). ✔
- M3 row change not deliberate → 1 fail (pure rule only; no integration test pins a vertical-only drag — see finding 2). ✔

### Attacks tried
- Other copy paths: `copySelection` is emitted only at `mouse-stream.ts:343`; `useMouse.ts:136` still guards empty. Holds.
- Release at a different cell without a drag report: selection is set only by press/drag, so a release never extends it. Holds.
- Non-deliberate release leaves a stale highlight? No: state → `selection: null`, applied at `useMouse.ts:266`. Holds.
- Status-bar note moving the transcript: pinned by the multi-row test (body + "↑N more" unchanged). Holds.
- Timer after unmount: only `setState` (no-op in React 18); not cleared on unmount, acceptable.
- §7 invariants: no protocol, persistence, broker or raw-terminal write touched; logic is in pure `selection.ts`/`mouse-stream.ts`, components only render. Holds.

### Nits (not blocking)
- `copiedLabel(text.length)` counts UTF-16 units ("😀" = 2 chars).
- New tests sync on fixed `delay()`s (§9), matching the existing `app.test.tsx` style.

Reviewer: same model family as a likely Opus executor — fresh context only; shared blind spots possible.

*— claude-opus-5-5, 2026-11-26*

### Round 2

**Verdict: REQUEST-CHANGES.** Scope: `0be3d3a0` (fix) + `c90d3407` (gate).

- R1 finding 1 (no doc/TODO/red evidence): **resolved** — doc has Context with a
  `main` repro, Implementation, Execution; TODO entry added.
- R1 finding 2 (1-row jitter): **resolved for the jitter**, but the fix
  introduces a regression:
  1. **HIGH — a real selection across a line break no longer copies**
     (`packages/tui/src/selection.ts:90-91`). For a one-row crossing the rule
     requires `head.col − anchor.col ≥ 3` *in the drag direction*. Selecting the
     tail of one row and the head of the next — the ordinary gesture for a phrase
     that wraps — has the head LEFT of the anchor: press (5,40) → drag (6,5) →
     `isDeliberate` = **false** (also the upward mirror (6,5) → (5,40)). Probe
     (`.tentacle/tmp/tui-accidental-copy/r2.ts`): jitter (5,10)→(6,11) false ✔,
     wrap-phrase down false ✘, wrap-phrase up false ✘. The highlight shows ~40
     chars selected, release copies nothing and shows nothing, and the next paste
     is the OLD clipboard — a silent drop. The pure test even pins backwards
     travel as "no copy" (`accidental-copy.test.tsx` "Down a row but backwards").
     (My R1 wording "past the anchor's column in reading order" invited this.)
     Fix: physical travel, direction-free — deliberate iff `|Δrow| ≥ 2` or
     `|Δcol| ≥ COPY_MIN_CELLS`; add an integration test pressing near a row's end
     and dragging to the next row's start (must copy).
- Mutation: one-row crossing always deliberate (`|rows| >= 1`) → 3 fail (pure
  rule, integration jitter, dispatch seam). Reverted; `git status` clean.
- Gate: accidental-copy + mouse-stream + app + device-store = 202 pass / 0 fail;
  `bun run lint` clean; `bun run typecheck` 0 errors (R1's 23 were environmental).
- Note (not blocking): `c90d3407` edits `packages/daemon/test/device-store.test.ts`,
  unrelated to this task (gate unblock, documented in Execution); the orchestrator
  may prefer it on its own branch. Its oracle (`ps -o etime=` for self and pid 1)
  reads sound.

*— claude-opus-5-5, 2026-11-26*

