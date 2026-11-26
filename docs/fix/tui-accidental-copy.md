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
   selection crossed **two** rows, or travelled `COPY_MIN_CELLS` (= 3) along a
   row (for a one-row crossing, forward, in the drag direction). Anything less is
   a click.
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
`isDeliberate` false (round 1). *Selection scrolled out of view* → unchanged: the
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

