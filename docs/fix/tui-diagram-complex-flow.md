# fix/tui-diagram-complex-flow — a real flowchart falls back to "source only in the terminal"

> **Status:** context · implementation (executor: repro FIRST with the exact source, then plan, then fix — pre-approved, orchestrator 2026-11-17)
> **Branch:** `fix/tui-diagram-complex-flow`
> **Size:** S–M · **Blast:** contained (packages/tui diagram renderer) · **Suited:** DeepSeek exec + Opus review
> **Changelog:** `changelog.d/tui-diagram-complex-flow.fixed.md`

## Context

Owner 2026-11-17 11:35 (screenshot `.tentacle/tmp/tui-diagram-complex-flow/owner.png`): with Qwen3.8, "crea un flow chart di come funziona un token che entra in un modello transformer" → the model called `diagram` correctly (title "Il viaggio di un token in un Transformer", valid flowchart), but the TUI showed only the highlighted source with `· source only in the terminal`. DeepSeek's simpler flowchart drew fine. So the MODEL did nothing wrong: `drawFlow` (`packages/tui/src/diagram-ascii-flow.ts`) returned `undefined` (one of its bail-outs: ranks, gap plan, frames, width, crossing/bent spans…) on a realistic diagram with: a `subgraph … end` with `direction TB`, ~25 nodes, two BACK edges (`ADD2 -->|strati 1 … N−1| LN1` into the subgraph, `OUT -.->|re-iniettato come nuovo token| IN` from the bottom to the top), `<br/>` in labels, `[[ … ]]` subroutine shapes, edge labels, Unicode (`Q·Kᵀ / √dₖ`, `W₁ → GELU → W₂`), terminal ~200 columns.

The source is in the screenshot; transcribe it as a test fixture.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Executor: reproduce FIRST — a test that feeds this exact source at 200 and at 80 columns to `diagramView` and shows which bail-out fires (log the reason in the repro, not in the product). Then make this class of diagram draw: `<br/>` → multi-line box labels, back edges drawn as a return arrow along the side (the mockup's style), subgraph frames with edges crossing in/out, width-aware wrapping of long labels; keep the fallback only for genuinely undrawable cases and make the caption say WHY in a few words (e.g. "too wide for 80 columns — ^X^O to open") instead of a bare "source only". Keep the D3 invariants (no emoji glyphs, pure modules, cell-width-correct). Tests: the fixture draws at 200 cols (frame snapshot), degrades at narrow widths with the reason, plus the existing D3 tests green.

## Execution

*— deepseek-v4-pro, 2026-11-17. Branch `fix/tui-diagram-complex-flow`.*

**Load-bearing check (re-run first, passed).** `.tentacle/tmp/tui-diagram-complex-flow/repro.ts`
feeds the transcribed screenshot source to `lintDiagram` → `diagramModel` → `drawFlow`:
`lint ok: true`, `model.kind: flowchart nodes=22`, and `drawFlow(200|120|80) = undefined`.
A debug copy of `drawFlow` with a log on every `return undefined` named the bail-out:
**`drawFrames` → `false`** at every width (`diagram-ascii-flow.ts:301`, the frame-title
placement), *not* ranks/gap-plan/width as the Context guessed. Two model bugs sat behind
it, visible in the dump: the subgraph title parsed as `BLOCCO ["Blocco Transformer (…)" ]`
(id + brackets included) and `POS[["+ Codifica …"]]` parsed as a rect with a literal
`["…"]` label (`[[ ]]` was not in the shape table). So: model first, then the frame.

**Slice A — `packages/core/src/diagram/model.ts`: subgraph title, `[[ ]]`, `<br/>`.**
Tests first in `packages/core/test/diagram-model.test.ts` (red, then green):
1. `subgraphTitle()` reads Mermaid's three spellings — `Title`, `id [Title]`,
   `id ["Title"]` — so the id is never part of the title (`model.ts:130`).
2. `[[ … ]]` → a new `NodeShape` member `subroutine` (`model.ts:104`) — it was being
   read as `[` + a label starting `[`, which is why `[+ residuo …]` appeared verbatim.
3. `BR` / `multiline()` / `oneline()` (`model.ts:118`): a box's label and a subgraph's
   title keep their lines; an **edge** label is one line, so its `<br/>` becomes a space.

**Slice B — `packages/tui/src/diagram-ascii-flow.ts`: labels are rows, wrapping, frame
title, refusal reason.** New tests in `packages/tui/test/diagram-complex-flow.test.ts`
(5 red first against the un-fixed renderer):
- `boxLines()` (wrap at `labelCap` on spaces, `<br/>` lines kept, `[[ ]]` keeps its
  brackets, never an empty line) feeds `sizeVertex` (a box grows *down*) and `drawBox`
  (rows stacked and centred).
- `labelCap = min(46, max(12, width - 14))` — a width-aware wrap, so the width does not
  blow up on prose; `FLOW_MAX_NODES` still the readability ceiling.
- `drawFrames`: a title that no border stretch can hold is **shortened** to the longest
  stretch (`╰─ Blocco Transformer (ripe… ─…`), and both borders are compared so the top
  border's short run cannot win over the bottom's long one. Only a frame with *no* room
  (`MIN_FRAME_TITLE` = 6 cells) still refuses.
- `drawFlowResult()` returns `{ drawing }` or `{ reason }` (`too-wide` / `too-big` /
  `not-drawable`); `drawFlow()` stays the thin wrapper every existing test uses.

**Slice C — `packages/tui/src/diagram-lines.ts`: the caption says why.** `FLOW_REASON`
turns the reason into a few words (`too wide for 80 cols — widen the window or ^X^O`,
`too many boxes to draw — ^X^O for the source`, `cannot draw faithfully in a terminal —
^X^O for the source`); the bare `source only in the terminal` remains only for a type
with no drawing at all (class/gantt/…), where it is the true statement.

**Slice D — the `<br/>` fallout on the one-line summary.** `model.label` may now contain
`\n`, and `describeDiagram` (the phone's VoiceOver text) joins labels into ONE sentence:
`summary.ts` `flowShape()` now says a label's lines joined by a space. Red test added
first in `packages/core/test/diagram-summary.test.ts`.

**Drift from the Implementation, and why.**
- The plan named the bail-out candidates "ranks, gap plan, frames, width, crossing/bent
  spans". The repro proved it is **frames only** — no ranks/routing work was needed. The
  back edges already route correctly (return run along the side, `╎ re-iniettato come
  nuovo token`), so no new router code was written for them; the fixture test pins that
  they are drawn, which is the property that matters.
- The plan said "keep the fallback only for genuinely undrawable cases". Implemented as
  the *reason* split above; a diagram that is merely too wide now says so.
- Nothing in `docs/feat/model-diagrams.md`'s D3 invariants changed: no emoji glyphs
  (pinned in the new tests), pure modules (model + renderer stay I/O-free), cell width
  via `cellWidth`/`headCells`.

**Tests.** `bun test packages/tui/test/diagram-complex-flow.test.ts` (11),
`packages/tui/test/diagram-lines.test.ts` (47, +2 snapshots: `transform 200` and
`transform 80`), `diagram-row.test.ts` (10), `app-diagram.test.tsx`,
`packages/core/test/diagram-model.test.ts` (16), `diagram-summary.test.ts` (9) — all green.
Existing assertions that pinned the old bare caption were updated to the reason
(`diagram-lines.test.ts`, `diagram-row.test.ts`, `app-diagram.test.tsx`): each still
asserts the drawn-vs-source property, now with the honest sentence.

**Mutation checks (each restored after).** Reverting the frame-title shortening → 8 red
in `diagram-complex-flow.test.ts`. Reverting `subgraphTitle` → the model test, the
`<br/>` test and the frame-title test red. Reverting `multiline()` → the model `<br/>`
test and the renderer `<br/>` test red. Reverting the caption to the bare sentence → 7
red across the three TUI files. Ignoring `labelCap` (no wrap) → the wrap test and the
empty-line test red.

**Gate.** `bunx tsc --noEmit` clean · `bun run lint` clean (0 errors/warnings) ·
`bun test` 14511 pass, 5 opt-in skips, **1 fail in
`packages/docker/test/ssh-dialer.test.ts`** — pre-existing and unrelated: it also fails
on `main-ro` (2 fail there), it touches no file this task changed, and it asserts a
spawned ssh child's pid file. Unverified by me: whether that flake is environmental on
this host; it is not this branch's.

## Review

**Verdict: REQUEST-CHANGES.** Scope: `git diff c6b21370..HEAD` (the branch's own two
commits; `main...HEAD` has two merge bases and pulls in unrelated mobile-header-status files).

**Gate (re-run here).** The 6 touched test files: 101 pass, 0 fail, 14 snapshots ·
`bun run lint` clean · `bun run typecheck` clean. Full `bun test` was not re-run.

**Findings.**
1. **HIGH — `diagram-ascii-flow.ts:436-437` (`sizeVertex`, sideways branch).** A box's
   height in LR/RL is still `crossSize = max(base, k+2)`, so it never counts `boxLines`,
   but `drawBox` (`:678-690`) now stacks every line. The first and last lines are drawn
   over the top and bottom borders. Repro (`.tentacle/tmp/tui-diagram-complex-flow/rev/lr.ts`):
   `flowchart LR; A["uno<br/>due<br/>tre"] --> B[fine]` → `╭─uno─╮ / │ due ├► / ╰─tre─╯`.
   This is also a **regression on main**: an LR label longer than 46 cells drew fine in one
   wide box before, and is now wrapped into a broken box at 200 columns
   (`╭─a very long label that certainly goes past─╮`). Fix: in the sideways branch, set
   the height to `base + lines.length - 1` (taken with the k-based max), and add an LR test.
2. **MEDIUM — test gap behind #1.** None of the new tests (`diagram-complex-flow.test.ts`,
   snapshots) uses an LR/RL flowchart with a multi-line or wrapped label. That is how a
   broken drawing got through as "drawn".

**Premises.** The doc says the bail-out was `drawFrames` and that two model bugs sat behind
it (subgraph id in the title, `[[ ]]` missing). Both are TRUE in the diff (`model.ts:130`,
`:111`). The `FlowReason` mapping (`diagram-lines.ts:38-42`) matches the refusal sites.

**Attacks tried.** (a) LR/RL multi-line or wrapped label → broken (#1). (b) TD subroutine
plus a `<br/>` decision → drawn correctly (`◇` on the middle row). (c) A flowchart with one
node → draws. The `too-big` reason for a zero-node model reads oddly, but it is very
unlikely to be reached past lint. (d) Can `boxLines` loop forever? No: `outer ≥ 12` gives
a non-empty `head`. (e) §7: the modules stay pure, there are no protocol or persistence
changes, and nothing writes to the terminal. Holds.

**Mutation.** I could NOT re-run any: the mutation script needs a permission that was not
granted in this session. The executor's mutation claims are unverified by me.

**Executor behaviour.** A careful repro-first diagnosis that corrected the Context's guess.
But it pinned only the owner's TD fixture, and it missed the sideways path, which shares
`boxLines`/`drawBox`.

*— claude-opus-5-5, 2026-11-17 (different model family from the deepseek executor; fresh context)*

### Fix round 1

**Repro first (passed).** The reviewer's `.tentacle/tmp/tui-diagram-complex-flow/rev/lr.ts`
re-ran unchanged on this branch and reproduced #1 verbatim:
`A["uno<br/>due<br/>tre"] --> B[fine]` at 120 → `╭─uno─╮ / │ due ├► / ╰─tre─╯`, and the
>46-cell LR label at 200 → `╭─…goes past─╮ / │ … │ / ╰─…╯`. Root cause confirmed by
reading `sizeVertex` (`diagram-ascii-flow.ts:429-443`): the TD branch
(`v.mainSize = height`) counted `boxLines`, the sideways branch still set the box's
cross size (its HEIGHT in LR/RL) to `max(base, k + 2 + …)`, i.e. never counted them.

**HIGH #1 — FIXED.** `diagram-ascii-flow.ts:436-441`: the sideways branch's cross size is
now `Math.max(height, k + 2 + (cylinder ? 1 : 0))`, `height` the same `base + lines - 1`
the TD branch uses, so a box grows *down* in LR/RL exactly as it grows down in TD. A
wrapped LR label also keeps one wide box's rows inside its borders again (the repro's
second case draws both label rows inside a 5-row box rather than over the top/bottom).
`k` is kept in the max: a box with many edge channels still reserves the room it needs.

**MEDIUM #2 — FIXED.** New test `packages/tui/test/diagram-complex-flow.test.ts`
("a sideways (LR) box is tall enough for every label row") covers BOTH shapes the review
named: an LR `uno<br/>due<br/>tre` and an LR wrapped `parola ×20` label. It asserts the
*property*, not a rendering string: the box's own top and bottom rows are pure borders
(`/^[╭╮][─┬┴┼]*[╭╮]$/`) and every label word sits strictly between them — so any future
row-over-border regression fails regardless of the glyphs chosen.

**Red → green.** The new test was red on the buggy code **on the assertion of the
property**: `Expected … /^[╭╮][─┬┴┼]*[╭╮]$/ — Received: "╭─uno─╮"` (the label painted
over the top border). Green after the one-line branch change.

**Mutation check (non-vacuity).** Reverting the fix to
`v.crossSize = Math.max(base, k + 2 + (cylinder ? 1 : 0))` → **1 fail** in
`diagram-complex-flow.test.ts` (the new test); restored immediately, tree re-verified by
`git diff --stat` (only the intended two files).

**No regression in the drawn output elsewhere.** The sideways cross size only ever
grows, and only when a label needs the rows: the TD path is untouched, and
`diagram-lines.test.ts`'s `transform 200` / `transform 80` snapshots are unchanged.

**Gate.** `bunx tsc --noEmit` clean · `bun run lint` clean (1990 files, no fixes) ·
`bun test` **14513 pass, 5 opt-in skips, 1 fail** — the same
`packages/docker/test/ssh-dialer.test.ts` failure the previous round recorded, still
unrelated (a spawned ssh child's pid/process-group assertion; this branch touches only
`packages/tui`). Re-running that file alone on this branch gives 22 pass / 2 fail with a
*different* failing test each run, i.e. it is host-flaky, not caused by this diff. The
diagram suites in full: 69 + 90 pass, 0 fail, 14 snapshots.

Note for round 2: this executor ran on the **same model family as Review round 1**
(`claude-opus-5-5`, fresh context), so the fixes above are self-reviewed only in the weak
sense — a fresh-context round on a different family is still worth it for #1, since the
sideways geometry is shared by every LR/RL flowchart.

*— claude-opus-5-5, 2026-11-17*

### Round 2

**Verdict: PASS.** Scope: `git diff HEAD~1` (`dcd9dfc6`).

- **#1 (HIGH) fixed.** `diagram-ascii-flow.ts:439`: in LR/RL the box's cross size is now
  `max(height, k+2…)`, so it counts the label's rows. Re-running the round-1 repro
  (`.tentacle/tmp/tui-diagram-complex-flow/rev/lr.ts`): the `<br/>` box and the wrapped
  long label now draw intact, with the borders above and below the text.
- **#2 (MEDIUM) fixed.** New test `a sideways (LR) box is tall enough for every label row`.
  **Mutation:** with the fix reverted to `max(base, …)`, that test FAILS (11 pass / 1 fail).
  After restoring it, `git status` is clean.
- **Regression probes** (`rev/lr2.ts`): a multi-line LR cylinder plus a decision with three
  outgoing edges, and an RL subgraph with a back edge into a 3-row box. Both draw, with no
  label over a border. The cosmetics left in those probes come from the round-1 code, not
  from this diff: the decision's `◇` sits on an edge port row, and an edge label runs
  through a frame border. Not blocking.
- **Gate:** the 6 touched test files: 102 pass, 0 fail · `bun run lint` clean ·
  `bun run typecheck` clean. Full `bun test` not re-run.

*— claude-opus-5-5, 2026-11-17*
