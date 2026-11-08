# feat/subagent-tail-view — a foreground sub-agent shows a rolling tail (task 2/9)

> **Status:** review — review fixes applied (round 2); owner to confirm Q1–Q3 defaults
> **Branch:** `feat/subagent-tail-view` — stacked on `feat/subagent-general-rename` (task 1, not merged)
> **Size:** S · **Blast:** contained · **Suited:** a weaker model may execute; standard in-context Review

## Context

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

The owner (2026-11-07, in `docs/eval/subagent-live.md` §"Owner decisions"):
*"metti visibili gli ultimi aggiornamenti del subagent invece che mostrare le prime
tool call del subagent"* — a foreground sub-agent must show its LATEST steps (a rolling
tail), not its first tool calls.

Today it shows the first ones. The child's activity labels are kept newest-last, capped at
50 (`packages/tui/src/state.ts:190` `SUB_ACTIVITY_CAP = 50`, appended and sliced at
`:422`), and `subAgentLines` prints **every** kept row (`packages/tui/src/render-lines.ts:277-280`),
which the transcript then collapses from the TOP with `… +N more lines · ctrl+o to expand`
(`:573-575`, `toolLines`). So a busy child displays steps 1-5 and hides the newest behind a
collapse marker — exactly backwards for a live view.

Opus's architecture/UI review (`.tentacle/worktrees/eval-subagent-live-arch/docs/eval/subagent-live.md`,
**L4** and **mockup 1**) is binding for this task:
- **L4.** *"Task 2 stands alone with no rebuild if `subAgentView` returns the view-model that
  6a (footbar), 7 (panel) and focus reuse: `{head, hidden, rows, done}` with a `maxRows`.
  Keep the state cap of 50 (`state.ts:189`), since the panel shows more than the tail."*
- **Mockup 1 (Foreground, rolling tail)**: the head line, then `… +14 earlier`, then the last
  rows, then the closing row.
  **Amended after this task's Review (Q1, owner-recommended, to confirm):** the totals
  (`19 tool uses · 12.4k tok · 1m12s`) stay on the **head** row, not on a closing row — it costs
  no row and they stay visible while the child runs. The "closing row" is the last step (or
  `└─ …` while running), plus `└─ ✗ <reason>` when the child did not end cleanly (Q2). The
  earlier-steps row reads `… +N earlier · ctrl+o to expand` (Q3). See **Execution → Round 2
  (review fixes)** and the round-2 **Review**.

Scope: this task only — the pure view-model + the component that renders it. No background,
no footbar list, no panel, no protocol, no persistence change.

**Repro** (`.tentacle/tmp/subagent-tail-view/repro.ts`, 2026-11-08, on this branch): a
running foreground sub-agent with 12 steps, rendered through the real pipeline
(`itemLines` → `wrapLines` → an Ink frame) at 80 and 46 columns:

```
=== width 80 (frame rows: 8) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses · 12k
|  ├─ Read packages/config/src/schema.ts
|  ├─ Bash grep -n "parseConfig(" packages/
|  ├─ Read packages/cli/src/wiring.ts
|  ├─ Bash grep -n "loadConfig" packages/cli
|  ├─ Bash bun test packages/config
|  … +8 more lines · ctrl+o to expand
steps visible: 5/12
first step visible: true
last step visible: false

=== width 46 (frame rows: 8) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses · 12k
|  ├─ Read packages/config/src/schema.ts
|  ├─ Bash grep -n "parseConfig(" packages/
|  ├─ Read packages/cli/src/wiring.ts
|  ├─ Bash grep -n "loadConfig" packages/cli
|  ├─ Bash bun test packages/config
|  … +8 more lines · ctrl+o to expand
steps visible: 5/12
first step visible: true
last step visible: false
```

The capability is missing: the newest step (12, `Bash bun test packages/cli`) is never on
screen.

## Implementation

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

### Load-bearing assumption

The rolling tail can be computed **entirely from `SubAgentProgress`** — the same object the
renderer already holds — with no new state and no protocol change: `activities` is ordered
oldest-first and capped at 50 (`state.ts:60-74`, `:190`, `:422`), and the finished flag and
the stop reason arrive on `subagent_end` (`state.ts:428-431`; the event carries
`stopReason` — `packages/agent/src/agent.ts:264-270`, `packages/client/src/mapping.ts:128-139`
— but the reducer DROPS it today). Verified: `activities` is the only reader of the child's
step labels (`grep sub.activities` → `render-lines.ts:277` only).

### Preconditions

- AGENTS §7 "logic lives in pure modules; components only render": the pattern modules are
  `tool-phase-view.ts`, `spill-view.ts`, `target-view.ts` — pure, React-free, unit-tested;
  `render-lines.ts` is itself framework-free ("Pure and framework-free: no React, no Ink",
  `render-lines.ts:1-10`), so width fitting (`fitSubtitle`, `truncateCells`) belongs there.
- Glyphs available, no new ones: `◆` (accent, `render-lines.ts:276`), `├─`/`└─`
  (`:279`), the `⎿ `/`  ` body prefixes (`:65-67`), and the existing collapse wording
  `… +N more lines` (`:575`). Mockup 1's cut marker is `… +N earlier`.
- Cell-accurate cutting helper already exists: `truncateCells` (`packages/tui/src/cells.ts:38`).
- The tool rows are folded to the terminal width by `itemRows` → `wrapLines`
  (`render-lines.ts:798`), so a body row wider than the width WRAPS (grows the frame) rather
  than overflowing — hence per-row truncation, not a shorter label.
- `toolBody`/`plainToolBody` already receive the body width (`render-lines.ts:549`
  `Math.max(20, cols - INDENT.length - 1)`), so the width is plumbed without a new option.
- The state cap stays 50 (`state.ts:190`, untouched — L4).

### Design

**New pure module `packages/tui/src/subagent-view.ts`** (React-free, like `spill-view.ts`):

```ts
export const SUBAGENT_TAIL_ROWS = 5;          // ONE named constant (owner Q17 recommend (a))

export interface SubAgentHead {               // the head line's content
  readonly agentType: string;
  readonly description: string;
  readonly toolUses: number;
  readonly tokens: number;
}
export interface SubAgentOutcome {            // finished, and why
  readonly stopReason?: string;               // absent on an older daemon
}
export interface SubAgentView {
  readonly head: SubAgentHead;
  readonly hidden: number;                    // earlier steps not shown → `… +N earlier`
  readonly rows: readonly string[];           // the LAST maxRows labels, oldest first
  readonly done: SubAgentOutcome | null;      // null while running
}

export function subAgentView(
  sub: SubAgentProgress,
  opts: SubAgentViewOptions = {},
): SubAgentView;
```

`hidden = activities.length - rows.length`, `rows = activities.slice(-maxRows)`, `maxRows`
floored and clamped to `≥ 0`; `done = sub.done ? { stopReason? } : null`. The four keys are
exactly L4's, so 6a (footbar), 7 (panel) and focus reuse them without a rebuild.

**State**: the outcome has to exist to be returned — add `readonly stopReason?: string` to
`SubAgentProgress` (`state.ts:60-74`) and set it from the event in the `subagent_end` case
(`:428-431`). Display-only, rendering-only; the log is untouched (AGENTS §7
"Rendering-only: NOT persisted").

**Component** (`render-lines.ts`, `subAgentLines` `:268-285`): render only what the view-model
says, with the existing glyphs —

```
⎿ ◆ <agentType> · <n> tool uses[ · <tokens>]      head (unchanged grammar, body-indented)
  … +<hidden> earlier                             only when hidden > 0
  ├─ <row> … ├─ <row>└─ <row>                      the last rows; the last one is `└─` when done
  └─ …                                            while running (unchanged)
```

The sub-agent's `description` is already on the tool header (`⏺ Agent <description>`,
`toolSubtitle` `:509-510`), so the tail head does not repeat it; it stays in the view-model for
the footbar/panel (mockup 1's `sa-1 · explore · <description>`), which draw no tool header.

Each row is cut with `truncateCells` to `width - 3` (`├─ ` = 3 cells) and the head to
`width - 2` (the `◆ ` glyph), so a long label is truncated instead of wrapping the frame.
`subAgentLines` gains the `width` argument `plainToolBody` already has (`:393-408`), and the
`expanded` flag (Ctrl+O) that widens `maxRows` to everything the state kept.

### Files

1. `packages/tui/src/subagent-view.ts` — new pure module (view-model + `SUBAGENT_TAIL_ROWS`).
2. `packages/tui/src/state.ts` — `SubAgentProgress.stopReason?` (`:60-74`); set it at `:428-431`.
3. `packages/tui/src/render-lines.ts` — `subAgentLines` renders the view-model + width cut;
   `plainToolBody` passes the width (`:406`).
4. `packages/tui/src/index.ts` — export the new module (the later tasks import it).
5. `packages/tui/test/subagent-view.test.ts` — new: the red-first unit tests.
6. `packages/tui/test/render-lines.test.ts` — the tail at 80/46 columns (rows, `… +N earlier`,
   no row over the width); the existing sub-agent tree test still holds.
7. `packages/tui/test/state.test.ts` — `stopReason` recorded; the 50 cap holds after 60 steps.
8. `packages/tui/test/app.test.tsx` — the frame test at 80 and 46 columns.

### Failure modes

- **Empty child (0 steps)**: head + `└─ …` only, `hidden` 0, never a `… +0 earlier` row.
- **Fewer steps than `maxRows`**: no cut row (5 steps → `hidden` 0, all 5 shown).
- **More than the cap (60 steps)**: the state kept 50, so `hidden` = 45 and the newest 5 are
  shown — the count is honest about what state holds; the panel shows more (L4).
- **maxRows 0 / negative / fractional**: clamped — no rows, `hidden` = all; never a negative
  `+N`.
- **A long label at 46 columns**: truncated with `…`, never wrapped (the frame keeps its height).
- **No `stopReason`** (an older daemon's frame, or a child still running): `done.stopReason` is
  absent, the block still closes honestly (`done !== null` is what draws `└─`).
- **Error / cancelled child**: `done.stopReason` is `error` / `cancelled`; the tail still shows
  the last steps (a failed child's trail is the thing you want to see).
- **Ctrl+O**: shows the whole kept trail (up to the 50 cap) — the escape hatch, and no longer
  the *default*. The panel/focus (task 7) is the richer view; this is the cheap one.
### Tests

Red-before-green (AGENTS §9), one mutation per group:
- **View-model** (`subagent-view.test.ts`): 0, 1, 5, 6, 12, 60 steps; `maxRows` 3 and the
  default; `done`/`error`/`cancelled`; the exact `rows` array and `hidden` count.
  Mutation: `activities.slice(-n)` → `slice(0, n)` must fail these.
- **Frame** (`render-lines.test.ts` + `app.test.tsx`): 12 steps at 80 and at 46 columns — the
  last 5 labels present, the first 7 absent, `… +7 earlier` present, no rendered row wider
  than the width. Mutation: drop the `truncateCells` cut (or the `slice(-n)`) must fail them.

## Execution

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

Done in the Implementation's order. `bun install --filter '!@tentacle/mobile'` first (the
worktree had no `node_modules`).

1. **Repro first** (AGENTS §1). `.tentacle/tmp/subagent-tail-view/repro.ts` renders a running
   foreground sub-agent with 12 steps through the real pipeline (`itemLines` → `wrapLines` →
   an Ink frame) at 80 and 46 columns. On this branch before any edit: the FIRST five steps,
   `… +8 more lines · ctrl+o to expand`, and the newest step never on screen — pasted in
   **Context**.
2. **Red-first** (AGENTS §9). `subAgentView` was written with today's behaviour
   (`activities.slice(0, max)`) as its stub, so the assertions fail on the property, not on a
   compile error: `bun test packages/tui/test/subagent-view.test.ts` → **8 pass, 7 fail** (the
   tail assertions: 6 steps, 12 steps, 60 steps, maxRows 3, maxRows floored, finished, and
   error/cancelled). Same for the frame tests: 3 fails in `render-lines.test.ts` (tail,
   finished close, 46-col cut) and 1 in `app.test.tsx`.
3. **Implementation.** New `packages/tui/src/subagent-view.ts` (pure, React-free:
   `SUBAGENT_TAIL_ROWS = 5`, `subAgentView(sub, { maxRows })` → `{ head, hidden, rows, done }`).
   `state.ts`: `SubAgentProgress.stopReason?` recorded from `subagent_end` (the event carried it
   and the reducer dropped it); the 50 cap untouched. `render-lines.ts`: `subAgentLines` takes
   `(tool, width, expanded)` and renders the view-model only, cutting each row with
   `truncateCells`. `index.ts`: exports the module for 6a/7. `rows.slice(-max)` flips the stub.
4. **Mutations** (cp backup + shasum restore, `.tentacle/tmp/subagent-tail-view/backup/`):
   - **view-model** `slice(-max)` → `slice(0, max)` in `subagent-view.ts`: **7 fail** in the
     unit tests **and 3** in `render-lines.test.ts`. Restored; final shasum
     `f922ac7a8b3e866d885672aca683586f7040cd8e`.
   - **frame**, cut removed (`truncateCells(label, width - 3)` → `label`): **1 fail**
     (`render-lines.test.ts`, the 46-col test) and, after the App test was made to bite on a
     real over-wide label, **1 fail** there too (`cutAt` 7 ≠ 6 — a wrapped continuation row).
   - **frame**, head cut removed: **1 fail** (`render-lines.test.ts`, the head at 46 cols).
   Restores verified by shasum (`render-lines.ts` `e8f6e407…`).
5. **Drift from Implementation** (and why):
   - **Ctrl+O keeps the whole kept trail** (`subAgentView(sub, { maxRows: Infinity })`) instead
     of leaving only the tail. The Implementation listed this as deliberate debt; the code is
     cheaper with the escape hatch, it preserves the existing expanded behaviour the
     `dump`/copy path uses, and it keeps the red test "Ctrl+O keeps the whole kept trail"
     meaningful. The draft `SubAgentDone` type is named `SubAgentOutcome` (no shadowing of the
     reducer's `done` boolean, and it reads as an outcome, not a flag).
   - **The tail no longer collides with the generic body collapse.** `toolLines`' `… +N more
     lines · ctrl+o to expand` collapses the BODY from the top when it is longer than
     `threshold` (8) — with 5 rows + head + cut row = 7 it no longer triggers at the default,
     and the view-model's `hidden` is the honest count (not the collapse's `body.length -
     preview`, which counted the head row as a "line"). The 80-col frame is 9 rows: header,
     head, cut row, 5 steps, `└─ …`.
   - `… +N earlier` sits at the body indent (`  … +7 earlier`), like every other body row
     (mockup 1 draws it indented too).

**Gate** (this worktree, 2026-11-08):
- `bunx tsc --noEmit` → exit 0.
- `bunx biome check .` → `Checked 757 files … No fixes applied` (0 errors, 0 warnings — the
  repo baseline).
- `bun test packages` → **5696 pass, 0 fail, 3 skip** (the three opt-in skips: live-k8s,
  live-docker, the real-socket keepalive — AGENTS §6), 62722 `expect()` calls, 388 files.

**After-frame** (same repro, `.tentacle/tmp/subagent-tail-view/repro.ts`):

```
=== width 80 (frame rows: 9) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses · 12k
|  … +7 earlier
|  ├─ Read packages/agent/src/agent.ts
|  ├─ Bash bun test packages/agent
|  ├─ Read docs/config.md
|  ├─ Bash grep -n "loadConfig" packages/daemon
|  ├─ Bash bun test packages/cli
|  └─ …
steps visible: 5/12
first step visible: false
last step visible: true

=== width 46 (frame rows: 9) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses · 12k
|  … +7 earlier
|  ├─ Read packages/agent/src/agent.ts
|  ├─ Bash bun test packages/agent
|  ├─ Read docs/config.md
|  ├─ Bash grep -n "loadConfig" packages/daem…
|  ├─ Bash bun test packages/cli
|  └─ …
steps visible: 4/12
first step visible: false
last step visible: true
```

At 46 columns the frame keeps the same 9 rows; the cut is visible on the one label that does
not fit (`packages/daem…`), which is why the repro's exact-substring counter says 4 there —
no row wraps, and the tail is the same 5 steps.

### Round 2 (review fixes)

*— deepseek-v4.1-flash (tentacle), 2026-11-08 — fixes the review above: H1, M1–M4, L1–L4,
and the three owner questions as recommended defaults. (Corrected in round 3, review N5: this
section said `claude-opus-5-5`, the reviewer's model, while commit e95e88a and the brief say
deepseek.)*

**What was fixed, and where the decision lives.** Every branch is in the pure view-model
(`packages/tui/src/subagent-view.ts`, AGENTS §7); `render-lines.ts` only colours, indents and
folds.

| Finding | Fix | Decision in |
|---|---|---|
| **H1** a finished child hides its newest step, its close and its report | A sub-agent's STEP TREE is exempt from `toolLines`' generic 8-row cut. Only the REPORT collapses, through the one shared `collapsedBody` (`render-lines.ts:555-566`), with the transcript's own `… +N more lines · ctrl+o to expand`. At most TWO cut markers per block, in one grammar pointing at one key: the earlier-steps row, and — only when the report is long — the report's own. A short report adds none (corrected in round 3, review N4). | `render-lines.ts:613-618` |
| **M1** `hidden` contradicted the head past the 50-label cap (`60 tool uses` over `… +45 earlier`) | The block counts off ONE number, `max(toolUses, activities.length)`, reported as BOTH `head.toolUses` and the base of `hidden` — so the head and the cut row can never describe it two ways. 60 steps now read `60 tool uses` over `… +55 earlier`. They are equal on a real stream (one `subagent_tool` bumps both); the two only diverge past the cap. | `subagent-view.ts:76-91` |
| **M2** Ctrl+O still cut a long label | `subAgentRow(label, width, expanded)` cuts only when collapsed; expanded, the label is whole and `wrapLines` folds it. | `subagent-view.ts:135-139` |
| **M3** a cancelled/errored child looked like a clean one | **Q2 (recommended default):** a non-clean end gets ONE closing row, `└─ ✗ <reason>` — `✗ cancelled`, `✗ error`, and `✗ max_iterations` for any other non-`end_turn` reason. Clean ends are unchanged (the last step row closes). | `subagent-view.ts:95-101`, `render-lines.ts:290-303` |
| **M4** undeclared drift from mockup 1 | **Q1 (recommended default):** the totals STAY on the head. Mockup 1's description in **Context** is amended, not the code. | Context, mockup 1 |
| **L1** false premise in a comment and a test name | `state.ts`'s `stopReason` doc now states the truth: a finished child always has one (`AgentEvent.stopReason` is required, `agent.ts:264-269`; the client DROPS a `subagent_end` without it, `client/src/mapping.ts:128-136`); optional only so a hand-built state types. The test is renamed `a done with no recorded reason (unreachable from the wire)`. | `state.ts:72-80` |
| **L2** no wide-char and no two-sub-agent test through the block; weak 46-col assertion | Added: CJK/emoji labels at 80 and 46 (cells, never over the width); two sub-agents in one transcript (`transcriptLines`, each block keeps its own rows, count and cut row); and the 46-col test now pins the exact cut text, not a bare `…`. | `render-lines.test.ts` |
| **L3** expect a small adapter in 6a | No change (a note). The view-model still takes `SubAgentProgress`; 6a narrows the input when the wire row lands. | — |
| **L4** a long type cut the COUNTS | `subAgentHeadRow(head, width)` cuts the TYPE alone, to the room the counts leave, so `7 tool uses · 12k` always survives. | `subagent-view.ts:103-120` |
| **Q3** wording | `… +N earlier · ctrl+o to expand` — one grammar with the transcript's other cut markers, both reading the ONE `EXPAND_HINT` (`tool-expand.ts:75-81`).In the EXPANDED view the hint is dropped (Ctrl+O is already on). **33 cells, 35 with the indent** at a 999-step worst case, so it fits at 46 columns (pinned by a test). | `subagent-view.ts:121-133` |

**Red before green** (AGENTS §9), each group shown failing on the pre-fix code:

| Group | Test(s) first run RED on the old code | Fail count |
|---|---|---|
| H1 | `render-lines.test.ts`: "a finished child keeps its newest step and its closing row beside a report", "a long report still collapses, from the top, beside the whole tree", "a 6-row tail: the exempt tree does not collapse" | 3 |
| M1 | `subagent-view.test.ts`: "60 steps … 55 counted earlier", "the wire's own shape (a tail of 8 labels, 19 tool uses)"; `render-lines.test.ts`: "the cut row counts what the head counts" | 3 |
| M3/Q2 | `subagent-view.test.ts`: "a non-clean end carries a closing row", "every other non-clean reason closes with a row too"; `render-lines.test.ts`: "`└─ ✗ cancelled`", "`└─ ✗ error`" | 4 |
| M2 | `render-lines.test.ts`: "Ctrl+O shows a long label in full, wrapped" | 1 |
| L4 | `subagent-view.test.ts`: "a long type is cut; the counts and the tokens always survive", "a width that cannot hold the counts alone still fits", "a short type is not cut at all"; `render-lines.test.ts`: "a very long type leaves the counts on the head" | 4 |
| Q3 | `render-lines.test.ts`: "the cut row carries the ctrl+o hint", "the cut row still fits at 46 columns"; `subagent-view.test.ts`: "one grammar with the transcript's other cut markers", "it fits at 46 columns even at the 999-step worst case" | 4 |

**Mutations, one per finding group** (cp backup + `shasum -c` restore,
`.tentacle/tmp/subagent-tail-view/r2-backup/`; both files restored to the final
`render-lines.ts 7370d2d7…` / `subagent-view.ts f660c120…`, verified by `shasum -c` after
every mutation; mutations A, B, C and F were re-run against the final code, the refactor's
frames were snapshotted in `frames-r2.after.txt` and were byte-identical, and every mutation's
fail count below is the final code's):

| # | Mutation | Result |
|---|---|---|
| A | H1: `tool.sub ? body : …` → `false ? body : …` (the tree back into the generic cut) | **7 fail** (6 in `render-lines.test.ts`, 1 in the app frame) |
| B | M1: `counted` back to `sub.activities.length` | **4 fail** (2 view-model, 2 render-lines) |
| C | Q3: drop `· ctrl+o to expand` from the earlier row | **3 fail** (render-lines) |
| D | M3/Q2: `closingRow` always returns `{}` | **5 fail** (2 view-model, 2 render-lines, 1 app frame) |
| E | M2: `subAgentRow` always cuts (`expanded ? label : …` → unconditional) | **1 fail** (render-lines) |
| F | L4: cut the joined head from the right (the old behaviour) | **3 fail** (1 view-model head-row test, 2 render-lines) |
| G | L2: cut a row by CODE POINTS instead of cells (`label.slice(0, width-3)`) | **1 fail** (the CJK/emoji test) |

**Frames re-captured after the fix** (`.tentacle/tmp/subagent-tail-view/review-frames-r2.ts`,
gitignored): the same pipeline as the review's — real `applyEvent` events → `itemLines` →
`wrapLines` → an Ink frame from `ink-testing-library`; SGR stripped; a row over the width would
be flagged `<< OVER` (**none was, at any width**). Heights are in the last pair of blocks.

```
=== 2 steps running @80 / @60 / @46 (rows 5, identical at all three) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 2 tool uses
|  ├─ Read packages/f1.ts
|  ├─ Read packages/f2.ts
|  └─ …

=== 12 steps running @80 / @60 / @46 (rows 9, identical at all three) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ …

=== 60 steps running @80 / @60 / @46 (rows 9) — M1: 55, matching `60 tool uses` ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 60 tool uses
|  … +55 earlier · ctrl+o to expand
|  ├─ Read packages/f56.ts
|  ├─ Read packages/f57.ts
|  ├─ Read packages/f58.ts
|  ├─ Read packages/f59.ts
|  ├─ Read packages/f60.ts
|  └─ …

=== 12 steps DONE end_turn, 1-line report @80 / @60 / @46 (rows 10) — H1: step 12, the close and the report are all there ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  The bug is in auth.ts.

=== 12 steps DONE end_turn, 12-line report @80 (rows 16) — only the REPORT collapses ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  report line 1
|  report line 2
|  report line 3
|  report line 4
|  report line 5
|  report line 6
|  … +6 more lines · ctrl+o to expand

=== 12 steps DONE end_turn, no report @80 (rows 8) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts

=== 12 steps stopReason=cancelled @80 / @46 (rows 11) — M3/Q2 ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ ✗ cancelled
|
|  partial

=== 12 steps stopReason=error, isError @80 / @46 (rows 11) — M3/Q2 ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ ✗ error
|
|  boom

=== 12 steps stopReason=end_turn, ok report @80 / @46 (rows 10) — the clean comparison ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  partial

=== Ctrl+O running 12 @80 (rows 16) ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  ├─ Read packages/f1.ts
|  ├─ … (f2 to f11, one row each)
|  ├─ Read packages/f12.ts
|  └─ …

=== Ctrl+O running, long label @46 (rows 8) — M2: whole, wrapped, never cut ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ $ bun test packages/config/src/a-very-lon
|g-directory-name/packages/config/src/a-very-lo
|ng-directory-name/packages/config/src/a-very-l
|ong-directory-name/
|  └─ …

=== collapsed running, long label @46 (rows 4) — still cut (the default is a tail, not a flood) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ $ bun test packages/config/src/a-very-l…
|  └─ …

=== very long type, 7 steps @80 (rows 9) — L4: the counts survive, the TYPE is cut ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ an-extremely-long-sub-agent-type-name-that-goes-on-and-on-fo… · 7 tool uses
|  … +2 earlier · ctrl+o to expand
|  ├─ Read packages/f3.ts
|  ├─ Read packages/f4.ts
|  ├─ Read packages/f5.ts
|  ├─ Read packages/f6.ts
|  ├─ Read packages/f7.ts
|  └─ …

=== very long type, 7 steps @46 (rows 9) — L4 at the narrow width: still the counts ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ an-extremely-long-sub-agen… · 7 tool uses
|  … +2 earlier · ctrl+o to expand
|  ├─ Read packages/f3.ts
|  ├─ Read packages/f4.ts
|  ├─ Read packages/f5.ts
|  ├─ Read packages/f6.ts
|  ├─ Read packages/f7.ts
|  └─ …

=== wide chars @46 (rows 5) — cut by CELLS, no row over the width ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 2 tool uses
|  ├─ Read 日本語のとても長いファイル名がここ…
|  ├─ $ echo 🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉…
|  └─ …

=== two in parallel (interleaved events) @80 (rows 19) — each block keeps its own rows and count ===
|⏺ Agent scan the auth module
|⎿ ◆ explore · 8 tool uses
|  … +3 earlier · ctrl+o to expand
|  ├─ Read a6.ts
|  ├─ Read a8.ts
|  ├─ Read a10.ts
|  ├─ Read a12.ts
|  └─ Read a14.ts
|
|  a report
|⏺ Agent migrate tests to bun
|⎿ ◆ general · 8 tool uses
|  … +3 earlier · ctrl+o to expand
|  ├─ Edit b7.ts
|  ├─ Edit b9.ts
|  ├─ Edit b11.ts
|  ├─ Edit b13.ts
|  ├─ Edit b15.ts
|  └─ …

=== two in parallel, one cancelled @80 (rows 20) ===
|⏺ Agent scan the auth module
|⎿ ◆ explore · 8 tool uses
|  … +3 earlier · ctrl+o to expand
|  ├─ Read a6.ts
|  ├─ Read a8.ts
|  ├─ Read a10.ts
|  ├─ Read a12.ts
|  ├─ Read a14.ts
|  └─ …
|⏺ Agent migrate tests to bun
|⎿ ◆ general · 8 tool uses
|  … +3 earlier · ctrl+o to expand
|  ├─ Edit b7.ts
|  ├─ Edit b9.ts
|  ├─ Edit b11.ts
|  ├─ Edit b13.ts
|  ├─ Edit b15.ts
|  └─ ✗ cancelled
|
|  partial

heights @80: steps 0..12 = 3,4,5,6,7,8,9,9,9,9,9,9,9 · done=8 · +1-line report=10 · +12-line report=16 · cancelled=11
heights @46: steps 0..12 = 3,4,5,6,7,8,9,9,9,9,9,9,9 · done=8 · +1-line report=10 · +12-line report=16 · cancelled=11
```

The height curve is unchanged while running (it stops at 9 at step 6, as before). The END
now GROWS, which is the H1 fix and is the point: a finished child is the one you read, so its
report is worth the rows — `+1-line report` 10 (was 8, and the report was invisible),
`+12-line report` 16 (report head 6 + its own cut row), `cancelled` 11 (the `✗` row is one of
them). At 46 columns the curve is identical: nothing wraps into an extra row.

**Drift from the Implementation** (and why):

- The Implementation's design kept a `headLimit` argument threaded into `plainToolBody`. The H1
  fix needs the collapse rules on BOTH sides of the same seam (the generic body and a
  sub-agent's report share one marker), so one `BodyFit` value (`expanded`, `limit`,
  `threshold`, `preview`) replaced it and `collapsedBody` became the single place a body is cut.
  `readLines`' highlight limit is unchanged (`fit.limit`).
- `toolLines`' cut is now SKIPPED for a `tool.sub` body. A sub-agent's rows are therefore never
  counted by the generic threshold — the property H1 needs, and the reason raising
  `SUBAGENT_TAIL_ROWS` to 6 (owner Q17) no longer risks collapsing the live tail.
- The earlier-steps row gained `· ctrl+o to expand` (Q3). The expanded view drops the hint,
  because past the state cap it cannot reveal the labels state no longer keeps — saying so
  there would promise something the escape hatch cannot deliver.
- **Owner questions, all three taken as the review's recommended defaults — the owner should
  confirm:** Q1 totals on the head (mockup amended in **Context**, code unchanged); Q2 one
  closing row for a non-`end_turn` reason, `└─ ✗ <reason>`; Q3 `… +N earlier · ctrl+o to expand`.
  Any of the three is a one-line revert in `subagent-view.ts`.

**Gate, after the fixes** (this worktree, 2026-11-08):

- `bunx tsc --noEmit` → exit 0.
- `bunx biome check .` → `Checked 757 files … No fixes applied` (0 errors, 0 warnings — the
  §6 baseline).
- `bun test packages` → **5721 pass, 3 skip, 0 fail**, 62844 `expect()`, 388 files, 5724 tests.
  The 3 skips are the three opt-in ones (`TENTACLE_K8S_SERVER`, `TENTACLE_DOCKER_TESTS=1`,
  `TENTACLE_SLOW_TESTS=1`, AGENTS §6) — no non-opt-in skip, no new failure. 25 new tests, 16 new
  `expect()` calls over the review's baseline of 5696 tests / 62828 `expect()`.

After the last self-check (the one-count change in `subagent-view.ts`), `tsc`, `biome` and
`bun test packages/tui` were re-run green (1170 pass); the full `bun test packages` was re-run
**5721 pass / 3 skip / 0 fail** on the final tree, and the six frames were regenerated
byte-identically.

**Files changed in round 2:** `packages/tui/src/subagent-view.ts` (the decisions: `hidden`,
`closing`, `subAgentHeadRow`, `subAgentEarlierRow`, `subAgentRow`),
`packages/tui/src/render-lines.ts` (`BodyFit`/`CollapseFit` + one `collapsedBody`; the tree
exempt; the closing row), `packages/tui/src/state.ts` (the `stopReason` doc),
`packages/tui/src/index.ts` (the new exports), `packages/tui/src/tool-expand.ts`
(`EXPAND_HINT`, one constant for both cut markers), `packages/tui/test/subagent-view.test.ts`,
`packages/tui/test/render-lines.test.ts` and `packages/tui/test/app.test.tsx`.

**Not fixed (deliberately, with the review's own reasoning):** L3 (a small adapter in 6a — no
code needed here); the `maxRows: Infinity` sentinel (kept: the view-model's contract is a
positive row budget, and task 7 will want an explicit cap anyway); the background row's
`state`/`sa-N` (task 6b). No protocol, no persistence, no `TODO.md`/`CHANGELOG.md` change.

### Round 3 (review round-2 fixes)

*— deepseek-v4.1-flash (tentacle), 2026-11-08 (signature corrected by the orchestrator: the executor had signed claude-opus-5-5) — fixes the review's round-2 REQUEST-CHANGES: N1 (MEDIUM) and
every nit in it (N2–N5), plus the owner-question default for a `max_iterations` end.*

**What was fixed, and where the decision lives.** Every branch stays in the pure modules
(AGENTS §7): the note de-duplication and the closing-row wording in `subagent-view.ts`,
the wrap-then-cut and the continuation indent in `render-lines.ts` (which only colours,
indents and folds). No component gained logic.

| Finding | Fix | Decision in |
|---|---|---|
| **N1** (MEDIUM) the report cut counted LOGICAL lines: a prose report rendered 49/65/81 rows at 80/60/46 | The report is folded to the BODY's width (`wrapLines`) **before** `collapsedBody` counts rows, so the cut counts the rows the terminal draws. The collapsed report now costs at most `threshold` (8) rows at any width — 6 preview rows + the cut marker. Measured before and after at 200/120/80/60/46/30/24 columns. | `render-lines.ts:477-490` |
| **N2** (LOW) under Ctrl+O a wrapped label restarted at column 0 and broke mid-word | One `subAgentStepRow`: expanded, the label is wrapped here to `width - prefix` and every continuation is indented to the LABEL's column (`  ├─ ` → 5 spaces), so each row already fits and `wrapLines` leaves it alone. Same seam as `commandRows`. Wrapping is unchanged (`wrapLines` folds at words where it can), so a label of words re-reads as the original once the indent is stripped. | `render-lines.ts:317-343` |
| **N3** (LOW) `└─ ✗ cancelled` was repeated by `_(sub-agent cancelled)_` | The note `agent_task` appends (`tools/src/task.ts:118-122`) is dropped at RENDER only, and only when it is the trailing text of the report: the tool result is untouched (the MODEL reads it, and the note is what tells it why the child stopped). A spilled report's trailing note goes the same way. | `subagent-view.ts:110-150` (`subAgentReport`, `subAgentOutcomeNote`), `render-lines.ts:400-425` |
| **N4** (LOW) "one cut marker per block, never two" was false | The behaviour is right (one grammar, one key); the sentence was wrong. Corrected in the H1 row of **Execution → Round 2** and in both test comments: a block has at most TWO cut markers — the earlier-steps row, and the report's own when the report is long; a short report adds none. | this doc, `render-lines.test.ts`, `app.test.tsx` |
| **N5** (LOW) the fix round was signed with the reviewer's model | **Execution → Round 2** and **Round 2: outcome** now read `deepseek-v4.1-flash (tentacle)`, matching commit e95e88a and the brief, with a note saying what was wrong. | this doc, lines 293-300 and 995-1000 |
| **Owner default** (awaiting confirmation): a `max_iterations` end read `✗ max_iterations` | Mapped in `closingRow`: `✗ iteration cap` (`cancelled` and `error` map to themselves). An UNMAPPED reason still prints as the wire says it — honest, and it cannot drift. Its `_(sub-agent hit its iteration cap)_` note goes with the `cancelled` one. | `subagent-view.ts:96-127` |

**Red before green** (AGENTS §9) — each test first run against the pre-fix code, in
`packages/tui/test/render-lines.test.ts` unless stated:

| Group | Test first run RED | Failures on the old code |
|---|---|---|
| N1 | "a prose report is wrapped before it is cut: at most 8 report rows at any width" | 1 (8 uncut paragraphs wrapped to 49/65/81 ROWS at 80/60/46 columns) |
| N1 bound | "the worst case is a report that just fits the threshold, not a long one" | passes both sides — kept as the BOUND's pin, not as the fix's proof (see below) |
| N2 | "Ctrl+O: a wrapped label's continuation sits under its row, never at column 0"; "Ctrl+O: a word-wrapped label keeps its words whole and its indent" | 2 (continuation started at column 0) |
| N3 | "a cancelled child says it ONCE: the note is dropped under `✗ cancelled`"; "a spilled report drops the note too"; `subagent-view.test.ts` × 6 (`subAgentReport`); `app.test.tsx` "a cancelled sub-agent closes with `└─ ✗ cancelled` on the real frame" (now asserting ONE mention) | 1 + 6 + 1 |
| Cap | "a capped child reads `└─ ✗ iteration cap`, and its note is not repeated"; `subagent-view.test.ts` "a capped end reads `✗ iteration cap`…" and the loop in "every other non-clean reason…" | 3 |

**Mutations** (AGENTS §9 non-vacuity; `cp` backup in
`.tentacle/tmp/subagent-tail-view/r3/backup/`, restored with `shasum -c SHASUMS` →
`render-lines.ts 4794fab0…`, `subagent-view.ts e21a7b6c…`, both `OK`):

| # | Mutation | Result |
|---|---|---|
| A | N1: `folded = report.flatMap((l) => wrapLines([l], width))` → `folded = report` | **1 fail**: "a prose report is wrapped before it is cut…" |
| B | N2: wrap/indent removed (`return [prefix + expandTabs(text)]`) | **2 fail**: both Ctrl+O continuation tests |
| C | N3: `subAgentReport` never drops (`\|\| note !== undefined`) | **5 fail**: 3 `subAgentReport` unit tests, the render-lines "says it ONCE", the cap's note test |
| D | N3 (spill): `spillBody(..., subAgentOutcomeNote(...))` → `spillBody(..., undefined)` | **1 fail**: "a spilled report drops the note too" |
| E | Cap: `✗ ${CLOSING_LABELS[stopReason] ?? stopReason}` → `✗ ${stopReason}` | **3 fail**: 2 in `subagent-view.test.ts`, the render-lines cap test |
| F | Cap/note (app path): mutation C, run on `app.test.tsx -t "cancelled sub-agent"` | **1 fail**: the real frame carries the word twice |

Mutation A is why the N1 test asserts *rendered* rows through `wrapLines`, not `itemLines`'
logical lines: it is the same observable the review measured (81 rows at 46 columns), so the
mutation lands on the exact property. The "worst case" test above is deliberately NOT counted as
N1's proof — it is green on both sides, because an 8-row report fits the threshold whole either
way; it pins the bound (17 rows at the default), which is the claim the doc makes.

**Real frames** (`.tentacle/tmp/subagent-tail-view/r3/frames-r3.ts` and
`frames-r3-app.ts`, both gitignored). Part A/B: real `applyEvent` → `itemLines` → `wrapLines` →
an Ink frame from `ink-testing-library`, SGR stripped, every row over the width flagged
(**none was, at any width**). Part C: the real `App` and `Agent`, two concurrent `agent_task`
calls (`peak concurrent agent_task calls: 2`), real Ctrl+O and Esc keys; the `agent_task` is a
fake that emits the progress events **and returns exactly what the real tool returns for a
cancelled child** (`content + "\n\n_(sub-agent cancelled)_"`, `task.ts:118-122`), so the frames
show the real note. As in `app.test.tsx`, `⏺ Agent` has no description there. SGR is stripped,
so colours are not evidenced.

```
=== done 12 steps, 8 PROSE paragraphs @80 (rows 16) — N1: 49 rows before ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  Paragraph 1: the parser reads the config once at startup and the watcher
|  re-reads it on change, so the parser reads the config once at startup and the
|   watcher re-reads it on change, so the parser reads the config once at
|  startup and the watcher re-reads it on change, so the parser reads the config
|   once at startup and the watcher re-reads it on change, so
|  Paragraph 2: the parser reads the config once at startup and the watcher
|  … +34 more lines · ctrl+o to expand

=== done 12 steps, 8 PROSE paragraphs @60 (rows 16) — 65 rows before ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  Paragraph 1: the parser reads the config once at startup
|  and the watcher re-reads it on change, so the parser
|  reads the config once at startup and the watcher re-reads
|   it on change, so the parser reads the config once at
|  startup and the watcher re-reads it on change, so the
|  parser reads the config once at startup and the watcher
|  … +50 more lines · ctrl+o to expand

=== done 12 steps, 8 PROSE paragraphs @46 (rows 16) — 81 rows before ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  Paragraph 1: the parser reads the config
|  once at startup and the watcher re-reads it
|   on change, so the parser reads the config
|  once at startup and the watcher re-reads it
|   on change, so the parser reads the config
|  once at startup and the watcher re-reads it
|  … +66 more lines · ctrl+o to expand

prose rows @80: 16 · @60: 16 · @46: 16

=== 12 steps, 12 PROSE paragraphs @46 (rows 16; over the threshold, so cut) ===
[the same block; only the count differs: `… +102 more lines · ctrl+o to expand`]
```

The bound, measured (`.tentacle/tmp/subagent-tail-view/r3/bound-probe.ts`): across 200/120/80/
60/46/30/24 columns × {no report, 1 line, 7/8/9 short lines, 8 prose} × {`end_turn`,
`cancelled`} × {0, 2, 12, 60 steps}, the collapsed block's worst height is **18 rows** — a
9-row tree (`✗` row included) + a blank + 8 report rows. The 8-row case is the worst one, not a
long report: a report within the threshold is shown WHOLE. Before the fix it was 81. At 30 and
24 columns the two cut/head rows wrap, which is the pre-existing `Math.max(20, …)` floor (not
new, not a real terminal size).

```
=== Ctrl+O, a long label @80 (rows 7) — N2: continuation under its row ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ $ bun test
|     packages/config/src/a-very-long-directory-name/packages/config/src/a-very-
|     long-directory-name/packages/config/src/a-very-long-directory-name/
|  └─ …

=== Ctrl+O, a long label @60 (rows 7) ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ $ bun test packages/config/src/a-very-long-directory-n
|     ame/packages/config/src/a-very-long-directory-name/pac
|     kages/config/src/a-very-long-directory-name/
|  └─ …

=== Ctrl+O, a long label @46 (rows 8) ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ $ bun test packages/config/src/a-very-lo
|     ng-directory-name/packages/config/src/a-
|     very-long-directory-name/packages/config
|     /src/a-very-long-directory-name/
|  └─ …

=== the same label COLLAPSED @46 (rows 4) — unchanged: one cut row, no wrap ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ $ bun test packages/config/src/a-very-l…
|  └─ …

=== Ctrl+O, two long labels, a finished tree @46 (rows 13) — `└─` folds the same way ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 2 tool uses
|  ├─ $ bun test packages/config/src/a-very-lo
|     ng-directory-name/packages/config/src/a-
|     very-long-directory-name/packages/config
|     /src/a-very-long-directory-name/
|  └─ $ bun test packages/config/src/a-very-lo
|     ng-directory-name/packages/config/src/a-
|     very-long-directory-name/packages/config
|     /src/a-very-long-directory-name/
|
|  ok

=== 12 steps CANCELLED (report + note) @80/60/46 (rows 11) — N3: said once ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ ✗ cancelled
|
|  partial findings

=== 2 steps CANCELLED @80/60/46 (rows 7) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 2 tool uses
|  ├─ Read packages/f1.ts
|  ├─ Read packages/f2.ts
|  └─ ✗ cancelled
|
|  partial findings

=== 12 steps CANCELLED with NO report (the placeholder + note) @46 (rows 11) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ ✗ cancelled
|
|  (the sub-agent produced no output)

=== 12 steps MAX_ITERATIONS @80/60/46 (rows 11) — the owner default, awaiting confirmation ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ ✗ iteration cap
|
|  ran out of budget

=== 12 steps ERROR @46 (rows 11) — unchanged ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ ✗ error
|
|  provider exploded

=== 12 steps, CLEAN end + 1-line report @46 (rows 10) — the comparison ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  The bug is in auth.ts.

=== 12 steps, 12 SHORT-line report @46 (rows 16) — N4: the second cut marker, by design ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  report line 1
|  report line 2
|  report line 3
|  report line 4
|  report line 5
|  report line 6
|  … +6 more lines · ctrl+o to expand

=== 60 steps running @46 (rows 9) — M1 unchanged ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 60 tool uses
|  … +55 earlier · ctrl+o to expand
|  ├─ Read packages/f56.ts
|  ├─ Read packages/f57.ts
|  ├─ Read packages/f58.ts
|  ├─ Read packages/f59.ts
|  ├─ Read packages/f60.ts
|  └─ …

=== wide labels @80 (rows 5) — CJK/emoji still cut by CELLS, unchanged ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 2 tool uses
|  ├─ Read 日本語のとても長いファイル名がここに続いています/設定スキーマ定義フ…
|  ├─ $ echo 🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉
|  └─ …
```

The height curve is unchanged where it should be: `heights @80/60/46: running 0..12 =
3,4,5,6,7,8,9,9,9,9,9,9,9 · done=8 · +1-line=10 · +8-prose=16 · cancelled=11`. Only the prose
case moved (81 → 16), which is N1.

**Real App frames** (real `App` + `Agent`, two concurrent `agent_task` calls, real Ctrl+O and
Esc). `@60` is omitted where it is identical to `@80` apart from the footbar's rules.

```
=== APP two in parallel, running @46 (viewport, rows 23) ===
|  … +4 earlier · ctrl+o to expand
|  ├─ Read a5.ts
|  ├─ Read a6.ts
|  ├─ Read a7.ts
|  ├─ Read a8.ts
|  ├─ Read a9.ts
|  └─ …
|
|⏺ Agent
|⎿ ◆ general · 9 tool uses
|  … +4 earlier · ctrl+o to expand
|  ├─ Read b5.ts
|  ├─ Read b6.ts
|  ├─ Read b7.ts
|  ├─ Read b8.ts
|  ├─ Read b9.ts
|  └─ …
|
|⠼ Working… 0s · esc/ctrl+c to stop
|────────────────────────────────────── qwen3 ─
|❯  Queue a task…
|──────────────────────────────────────────────
|/tmp/work · ↑7 ↓3 · ctx ░░░░░░░░░░ 0% (7/128k)

=== APP after a real Ctrl+O @46 (viewport, rows 23) ===
|  ├─ Read a7.ts
|  ├─ Read a8.ts
|  ├─ Read a9.ts
|  └─ …
|
|⏺ Agent
|⎿ ◆ general · 9 tool uses
|  ├─ Read b1.ts
|  ├─ Read b2.ts
|  ├─ Read b3.ts
|  ├─ Read b4.ts
|  ├─ Read b5.ts
|  ├─ Read b6.ts
|  ├─ Read b7.ts
|  ├─ Read b8.ts
|  ├─ Read b9.ts
|  └─ …
|
|⠋ Working… 0s · esc/ctrl+c to stop
|────────────────────────────────────── qwen3 ─
|❯  Queue a task…
|──────────────────────────────────────────────
|/tmp/work · ctx 0% (7/128k) · expanded

=== APP after a real Esc (CANCELLED) @46 (viewport, rows 23) — the prose report, cut, said once ===
|
|⏺ Agent 1.0s
|⎿ ◆ general · 9 tool uses
|  … +4 earlier · ctrl+o to expand
|  ├─ Read b5.ts
|  ├─ Read b6.ts
|  ├─ Read b7.ts
|  ├─ Read b8.ts
|  ├─ Read b9.ts
|  └─ ✗ cancelled
|
|  Paragraph 1: the parser reads the config
|  once at startup and the watcher re-reads it
|   on change, so the parser reads the config
|  once at startup and the watcher re-reads it
|   on change, so the parser reads the config
|  once at startup and the watcher re-reads it
|  … +66 more lines · ctrl+o to expand
|
|────────────────────────────────────── qwen3 ─
|❯  Type a task or /command
|──────────────────────────────────────────────
|/tmp/work · ↑7 ↓3 · ctx ░░░░░░░░░░ 0% (7/128k)
```

**Gate** (this worktree, final tree, 2026-11-08):

- `bunx tsc --noEmit` → exit 0.
- `bunx biome check .` → `Checked 757 files … No fixes applied` (0 errors, 0 warnings — the §6
  baseline).
- `bun test packages` → **5735 pass, 0 fail, 3 skip**, 63015 `expect()`, 388 files, 5738 tests.
  The 3 skips are the opt-in ones (`TENTACLE_K8S_SERVER`, `TENTACLE_DOCKER_TESTS=1`,
  `TENTACLE_SLOW_TESTS=1`, AGENTS §6): no non-opt-in skip, no new failure. Over the review's
  baseline (5721 pass / 62844 `expect()`) that is 14 new tests and 171 new `expect()` calls.

**Drift from the review's suggested fix, and why:**

- The review suggested `collapsedBody(wrapLines(report, width), fit)`. Built as a fold of the
  ALREADY-COLOURED report lines (one `wrapLines([l], width)` each), which is the same thing but
  keeps the colouring where it was: `wrapLines` is ANSI-aware, and `carryColor` re-emits a colour
  that spans a wrap point, so wrapping the raw text then colouring would lose that.
- The `_(sub-agent …)_` note is dropped at RENDER, not in `packages/tools/src/task.ts`. The note
  is model-facing: it tells the MODEL why the child stopped, and `task.ts` is where the result the
  model reads is built. Dropping it there would be a behaviour change to the agent loop, not to
  the block — out of this task's scope, and a worse one.
- An unmapped stop reason is NOT mapped to prose: `✗ budget_exceeded` stays as the wire says it.
  Inventing a phrase for a reason nobody has seen yet would be a claim the code cannot keep.

**Files changed in round 3:** `packages/tui/src/render-lines.ts` (wrap-then-cut for the report;
`subAgentStepRow`; the spill note), `packages/tui/src/subagent-view.ts` (`CLOSING_LABELS`,
`OUTCOME_NOTES`, `subAgentReport`, `subAgentOutcomeNote`), `packages/tui/src/index.ts` (the new
exports), `packages/tui/test/render-lines.test.ts`, `packages/tui/test/subagent-view.test.ts`,
`packages/tui/test/app.test.tsx`, and this doc.

**Not fixed (deliberately):** the panel/background surfaces (tasks 6a/6b), the `maxRows: Infinity`
sentinel (unchanged, as in round 2), and the pre-existing `Math.max(20, …)` width floor (below 23
columns a row wraps; not a real terminal size and not this task's). No protocol, no persistence,
no `TODO.md`/`CHANGELOG.md` change, no commit.

## Review

*— deepseek-v4.1-flash (tentacle), 2026-11-08 — in-context (AGENTS §10 allows it for a
`contained` S task; not a fresh-context review)*

**Gate re-run, from a clean tree read:** `bunx tsc --noEmit` exit 0 · `bunx biome check .`
757 files, no fixes, 0 errors/0 warnings (the §6 baseline) · `bun test packages` **5696 pass,
0 fail, 3 skip** — the three opt-in skips, so no new failure and no non-opt-in skip.

**The property the task hinges on, re-checked adversarially.** The claim is *"the newest step
is on screen and the oldest is not, at 80 and at 46 columns, with no row over the width."*
It is pinned by assertions, not by the shape of the code:
- `subagent-view.test.ts` asserts the exact `rows` array and `hidden` count for 0/1/5/6/12/60
  steps and for `maxRows` 3 and 0/negative/2.9 — so "the last N in chronological order" is what
  holds, not a weaker "contains the newest".
- `render-lines.test.ts` asserts *both* directions at 80 (`f1`–`f7` absent, `f8`–`f12` present,
  `… +7 earlier`, and `f8` before `f12` in row order) and the per-row `stringWidth ≤ width`
  loop at 46.
- `app.test.tsx` asserts it on a real Ink `lastFrame()` after a real `turn_start`/12
  `subagent_tool`/resize, at both widths.

**Non-vacuity confirmed by mutation (§9), restored by cp + shasum:**
- `slice(-max)` → `slice(0, max)`: 7 unit fails + 3 frame fails.
- `truncateCells(label, width - 3)` → `label`: 1 fail in `render-lines.test.ts`, and 1 in
  `app.test.tsx` (`cutAt` 7 ≠ 6: the long label wrapped into an unprefixed continuation row).
  The App assertion was *rewritten because the first version was vacuous*: with only short
  labels the width check passed under mutation. It now emits one 62-cell label and pins the
  block's row count and the `├─`/`└─` prefix on every step row.
- `truncateCells(head…)` → no cut on the head: 1 fail.

**Failure modes re-walked against the code (Implementation's list):**
- 0 steps → head + `└─ …`, no `… +0 earlier` (test). Fewer than `maxRows` → no cut row (test).
- 60 steps → state kept 50, `hidden` 45, newest 5 shown (test); the cap at `state.ts:190` is
  untouched, and `state.test.ts` now pins it (60 events → 50 labels, `f11`–`f60`, `toolUses`
  60 — the count is not capped, only the labels).
- `maxRows` 0 / negative / fractional → clamped and floored (test).
- Older daemon (no `stopReason`) → `done: {}`, still a finished block (test).
- `error` / `cancelled` → `done.stopReason` recorded, tail kept (test).
- Ctrl+O → the whole kept trail (test) — the escape hatch the transcript had.

**What does not hold / limits, stated plainly:**
- **`subAgentLines`' Ctrl+O path passed `Number.POSITIVE_INFINITY` to `maxRows`.** It works
  (the slice is a no-op) but it is a sentinel; a cleaner seam would be `maxRows: undefined`
  meaning "all". Left as is: the view-model's contract is a *positive* row budget for the
  footbar/panel, and an `Infinity` argument is honest at the call site. Flagged for task 7,
  which will want an explicit cap anyway.
- **`→ background as sa-1 …` (mockup 2)** is out of scope here (task 6b): the block says
  `└─ …` while it runs regardless of who owns the turn.
- **At 46 columns the type is kept and the tail is not truncated** (mockup 3 drops the type for
  the footbar rows; that is the footbar's view, task 6a/7, not this block).
- The transcript's own history does not change: this is a display projection only — nothing is
  persisted, no protocol field touched (AGENTS §7 "rendering-only: NOT persisted").
- `SUB_ACTIVITY_CAP` stays 50 and the tail is 5 of it; a resumed session still shows no trail
  (Q9: the trail is rendering-only), which is expected and unchanged.

**How the implementing model behaved on this task.** Two self-corrections, recorded rather
than hidden: the first App-level width assertion was vacuous (a short label can never overflow,
so it passed on the mutated code) and was rewritten to bite; and the "finished" frame fixture
first set only `tool.status: "ok"` — the block still drew `└─ …`, because `done` is the
sub-agent's own flag, not the tool row's. That is the fixture being wrong, not the code, and
the view-model test pins the distinction.

## Review (fresh-context, adversarial, code + UI/UX)

*— claude-opus-5-5, 2026-11-08 — different model from the executor (deepseek-v4.1-flash). Updated
the same day with real frames.*

### Verdict: **REQUEST-CHANGES**

The running tail is right at every width tried. A FINISHED sub-agent still hides its newest step
(H1, now seen in real frames), which is the defect this task exists to remove. M1–M3 are cheap and
should ride the same fix round.

**What the real frames changed:** H1 and M1–M4 are all **confirmed, none corrected**. One new LOW
(L4). One statement of mine was wrong and is fixed below: a one-line report does not add rows when
the block ends, because H1 collapses it.

### Frames: how they were captured, and their limits

`bun .tentacle/tmp/subagent-tail-view/review-frames.ts` (gitignored): real `applyEvent` events →
`itemLines` → `wrapLines` → an Ink frame from `ink-testing-library`; SGR stripped, a row over the
width would be flagged `<< OVER` (none was).

| Asked (item 2) | Result |
|---|---|
| 2 and 12 steps, 80/60/46 cols | OK, below. Short labels, so 60 matches 80 and 46; the cut was exercised at 46 and 80 only |
| Running vs done | OK while running; done → H1 |
| Error / cancelled | M3: same text as a clean end |
| Ctrl+O | Tail → whole trail, OK; long labels → M2. Driven by `expandAll`, the value the App passes, not by a keypress |
| Two sub-agents, interleaved | No mixing, counts right. Reducer level: interleaved events, not two concurrent App calls |
| Very long description | Header cut on one row, OK |
| Very long type | No wrap, but the counts are cut (L4) |
| CJK / emoji | Cut by cells at 46, no row over the width |
| Height | Stable past step 5, below |

```
=== 2 steps running @46 (rows 5) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 2 tool uses
|  ├─ Read packages/f1.ts
|  ├─ Read packages/f2.ts
|  └─ …

=== 12 steps running @46 (rows 9) ===     (80 and 60: identical)
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ …

=== Ctrl+O running 12 @80 (rows 16) ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  ├─ Read packages/f1.ts
|  ├─ … (f2 to f11, one row each)
|  ├─ Read packages/f12.ts
|  └─ …

=== parallel interleaved @80 (rows 17) ===
|⏺ Agent scan the auth module
|⎿ ◆ explore · 8 tool uses
|  … +3 earlier
|  ├─ Read a6.ts
|  ├─ Read a8.ts
|  ├─ Read a10.ts
|  ├─ Read a12.ts
|  └─ Read a14.ts
|⏺ Agent migrate tests to bun
|⎿ ◆ general · 8 tool uses
|  … +3 earlier
|  ├─ Edit b7.ts
|  ├─ Edit b9.ts
|  ├─ Edit b11.ts
|  ├─ Edit b13.ts
|  ├─ Edit b15.ts
|  └─ …

=== wide chars @46 (first rows) ===
|⎿ ◆ explore · 4 tool uses
|  ├─ Read 日本語のとても長いファイル名がここ…
|  ├─ $ echo 🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉…

heights @80: steps 0..12 = 3,4,5,6,7,8,9,9,9,9,9,9,9 · done=8 · +1-line report=8
heights @46: steps 0..12 = 3,4,5,6,7,8,9,9,9,9,9,9,9 · done=8 · +1-line report=8
```

Height: it grows by one per step up to 5, by one more when `… +1 earlier` appears at step 6, then
**stays at 9**. The end drops the `└─ …` row (9 → 8). The report adds no row today only because of
H1, so the H1 fix will make the block grow at the end, by the report's collapsed preview.

### Findings

#### HIGH

**H1. A finished sub-agent's newest step, closing row and report are hidden by the generic
collapse.** `plainToolBody` returns `[...tree, ...report]` (`render-lines.ts:438`). `toolLines`
then cuts any body over 8 rows to its first 6 (`:590-592`, `DEFAULT_THRESHOLD`/`DEFAULT_PREVIEW`,
`:61-62`). `run` never returns an empty report (`packages/agent/src/subagent.ts:304-312`), so a
finished child with ≥ 6 steps always has a body of at least 7 + 1 blank + 1 report = 9 rows.
**Confirmed by the real frame** (compare the same child with no report, which a real child shows
only between `subagent_end` and its `tool_result`):

```
=== 12 steps DONE end_turn, 1-line report @80 (rows 8) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  … +3 more lines · ctrl+o to expand

=== 12 steps DONE end_turn, no report @80 (rows 8) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
```

Step 12, the `└─` close and the report are gone, and two different cut markers sit in one block.
A 12-line report gives the same frame with `… +14 more lines`.
That contradicts the eval's A5 ("With `done` it keeps the last rows as well") and the owner's
decision. It also hides the only cancellation signal (M3). The test missed it because the finished
fixture has no `resultText` (`render-lines.test.ts`, "a finished sub-agent's tail closes…").
The same mechanism makes the running case correct only by arithmetic: head + `earlier` + 5 + `└─ …`
= 8 = the threshold, so raising `SUBAGENT_TAIL_ROWS` to 6 (owner Q17) would collapse the live tail
too. The Execution's "no longer collides" holds only for the running block at exactly 5.
**Fix:** a sub-agent body is exempt from the generic cut for its tree, and only the REPORT
collapses (with the existing `… +N more lines · ctrl+o to expand`). Red test: 12 steps, done, a
multi-line report: `Read f12.ts` and `└─` are present; and one with the tail constant at 6.

#### MEDIUM

**M1. `hidden` contradicts the head past the 50 cap, and will be wrong for the background row.**
`subagent-view.ts:61` counts `activities.length - rows.length`. At 60 steps the block reads
`60 tool uses` then `… +45 earlier` with 5 rows: 50, not 60 (the test at
`subagent-view.test.ts` pins 45 as correct). "Honest about what state holds" is not honest to the
reader. **Confirmed by the real frame:**

```
=== 60 steps running @80 (rows 9) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 60 tool uses
|  … +45 earlier
|  ├─ Read packages/f56.ts
|  ├─ Read packages/f57.ts
|  ├─ Read packages/f58.ts
|  ├─ Read packages/f59.ts
|  ├─ Read packages/f60.ts
|  └─ …
```

It is also the L4 reuse problem: 6a's wire row carries `tail: last ≤ 8 labels` plus
`toolUses` (review H1), so `hidden` would be 3 for 19 tool uses, against mockups 2 and 5
(`… +17 earlier`). **Fix:** `hidden = Math.max(sub.toolUses, sub.activities.length) - rows.length`,
floored at 0; both counters are per `tool_start` (`subagent.ts:286-287`, `state.ts`). Update the
60-step test to 55.

**M2. Ctrl+O still truncates labels.** `render-lines.ts:296` cuts by cells whether or not
`expanded` is set. Before this diff a long label wrapped in full, so the view documented as the
escape hatch can no longer show a long shell command (labels run up to 200 chars,
`client/src/mapping.ts:84`). The "Ctrl+O keeps the whole kept trail" test has only short labels.
**Confirmed by the real frame** (the label is 170 characters long):

```
=== Ctrl+O running, long label @46 (rows 5) ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ $ bun test packages/config/src/a-very-l…
|  └─ …
```

**Fix:** `expanded ? label : truncateCells(label, width - 3)`; `wrapLines` folds it. Red test: one
long label, `expandAll: true`, the whole text present.

**M3. A failed or cancelled child looks like a success.** `done.stopReason` is recorded and never
read: `render-lines.ts` tests only `view.done !== null`. `packages/tools/src/task.ts:118-125`
returns no `isError` for `cancelled`, `max_iterations` or a `turn_end` reason of `error`, so the
tool row is `ok` and the block matches a clean run. The only trace is the `_(sub-agent cancelled)_`
note at the END of the report, which H1 hides. **Confirmed by the real frames:** `stopReason`
`error`, `cancelled` and `end_turn` give the same eight rows, character for character, each ending
`… +3 more lines · ctrl+o to expand`:

```
=== 12 steps stopReason=cancelled, ok report @80 (rows 8) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  … +3 more lines · ctrl+o to expand
```

SGR is stripped, so a colour difference is not visible here. A thrown child (`isError`) can differ
by its bullet colour; a `cancelled` child's tool row is `ok`, so it has no such difference.
**Fix:** see Q2.

**M4. Undeclared drift from mockup 1, which is binding.** The mockup closes with
`└─ 19 tool uses · 12.4k tok · 1m12s`; the build keeps the totals on the `◆` head and closes on the
last step or `└─ …`, as every frame above shows (**confirmed**). The Context cites "then the
closing row" and the Execution's drift list omits it. The glyphs (`├─` for `│`) are declared illustrative, so they are fine. **Fix:** see Q1, and
record the outcome in Execution.

#### LOW

- **L1. False premise in a comment and a test name.** `state.ts:73` and "done with no stop reason
  (an older daemon's frame)" claim such a frame yields `done` with no reason. `client/src/mapping.ts:129`
  DROPS a `subagent_end` missing `stopReason`, and `AgentEvent.stopReason` is required
  (`agent.ts:264-269`). A finished child always has one; `done: {}` is unreachable. Fix the wording,
  or simplify `SubAgentOutcome.stopReason` to required.
- **L2. Test gaps.** No wide-character label and no two interleaved sub-agents are driven through
  the block (the second was already asked of `docs/feat/subagent-progress-wire.md`).
  `expect(joined).toContain("…")` (`render-lines.test.ts`, 46-col test) is weak: the next assertion
  does the work.
- **L3. Expect a small adapter in 6a, no rebuild.** `subAgentView` takes `SubAgentProgress`, while
  review H1's wire row names `type`/`tail`. The input could be narrowed then.
- **L4 (new, from the frames). A long type cuts the counts, not the type.** `render-lines.ts:287`
  cuts the joined string from the right, so the numbers go first. At 80 columns:
  `⎿ ◆ an-extremely-long-sub-agent-type-name-that-goes-on-and-on-forever · 7 tool…`; at 46 the
  counts are gone: `⎿ ◆ an-extremely-long-sub-agent-type-name-th…`. It needs a very long
  user-defined type name, so it is rare. **Fix:** cut `agentType` alone to the room the counts leave.

### 1. The view-model (L4)

`{head, hidden, rows, done}` with `maxRows` is the shape L4 asked for, and it is React-free. Once
M1 is fixed, 6a, 7 and focus can reuse it. What they will add is additive and comes from the
registry, not from this object: `sa-N`, `state` (`⚠ waiting for permission`), `startedAt`.
- Running step vs finished steps: not missing here. `subagent_tool` fires only on `tool_start`
  (`subagent.ts:286-287`), so the data does not exist; while `done === null` the last row is the
  running one by construction.
- Error row: there is no per-step error event, so `done.stopReason` is the right level.
- Stable id: a row has none, and needs none in a line renderer; the panel selects the sub-agent.
- AGENTS §7: holds. `render-lines.ts` is the framework-free layer, and what remains there is
  grammar and fitting. The `└─`/`├─` choice is presentation.

### 2. Wording

`… +7 earlier` follows mockup 1, but it is the only cut marker with no Ctrl+O hint, though Ctrl+O
does reveal those rows. In a finished block it now sits two rows above `… +3 more lines · ctrl+o
to expand` (H1 frame), so the two wordings are visibly inconsistent. See Q3.

### 3. State

Correct: `stopReason: event.stopReason` (`state.ts`, `subagent_end`), from `agent.ts:319` and
`client/src/mapping.ts:128-136`. Nothing is persisted: `.sub`/`activities` are read only in
`state.ts`, `render-lines.ts` and `subagent-view.ts`, and `resume.ts` has no such field. No log
entry or protocol schema is in the diff.

### 4. Tests and mutation

The executor's tests bite on what they pin. My mutation, `render-lines.ts:295`, `const last = false
&& …` (the close of a finished block): `bun test packages/tui/test/render-lines.test.ts
packages/tui/test/subagent-view.test.ts` → **87 pass, 2 fail** ("a finished sub-agent's tail
closes…", "a sub-agent whose report spilled"). Restored by `cp`; `shasum` before and after
`e8f6e4075f8f907735ad9e8bfc858c94d43789b6`. The App frame test's own mutation record is the
executor's and was not re-run.

### 5. Gate (2026-11-08, this worktree)

- `bunx tsc --noEmit` → exit 0.
- `bunx biome check .` → 757 files, no fixes.
- `bun test packages` → **5696 pass, 0 fail, 3 skip**, 62721 `expect()`, 388 files, 5699 tests.

### Premise table

| Premise | Result |
|---|---|
| Activities newest-last, cap 50 | TRUE (`SUB_ACTIVITY_CAP`, now `state.ts:195`; append at the `subagent_tool` case) |
| `subagent_end` carries `stopReason`; reducer dropped it | TRUE (`agent.ts:264-269`, `:319`; diff) |
| `truncateCells` at `cells.ts:38` | TRUE |
| Body width passed down (`cols - INDENT - 1`) | TRUE (now `render-lines.ts:566`) |
| Older daemon gives `done` with no reason | **FALSE** (L1) |
| "The tail no longer collides with the generic body collapse" | **FALSE once done** (H1, real frame) |
| Repro on `main` | **NOT RE-RUN**: it needs the pre-diff code, and the diff shows the old `sub.activities.map` directly |

### Attacks tried

1. Finished block with a report → **found H1** (real frame).
2. More steps than the cap → **found M1** (real frame).
3. Ctrl+O with a long label → **found M2** (real frame).
4. Cancelled/error outcome → **found M3** (real frames).
5. Multi-line or tabbed label wrapping the frame → nothing reachable. The repro feeds the reducer
   directly, and a raw tab label DID wrap at 46 columns (`|and more an…` on a row of its own). On the
   real path `progressText` turns control characters into spaces first
   (`client/src/mapping.ts:90-93`), and every runtime goes through it (AGENTS §7), so that frame is
   an artefact of the repro.
6. Stale `└─ …` after Esc → nothing new: `run` emits `subagent_end` on both paths
   (`subagent.ts:300,303`).
7. A per-call click expanding the tail → nothing: the real frame keeps `… +7 earlier` and the tail,
   and shows the command row only.
8. CJK and emoji labels at 80 and 46 → nothing: cut by cells, no row over the width.
9. A very long type and description → **found L4**; the description is fine.
10. Two interleaved sub-agents → nothing: each block has its own rows and counts.

### Executor behaviour

Solid on the view-model and honest about its two self-corrections. Its weak spot is the fixtures:
the finished-state test used no report, so the common end state went unexercised, and its
in-context Review re-walked its own failure-mode list without attacking it. The mockup drift went
unrecorded.

### Owner questions

**Owner answers (2026-11-08, after merge):** all four defaults CONFIRMED — Q1 totals stay on the head row; Q2 one closing `└─ ✗ cancelled` / `└─ ✗ error` row for a non-`end_turn` end; Q3 `… +N earlier · ctrl+o to expand`; `max_iterations` → `✗ iteration cap`.


- **Q1. Totals: on the head (as built) or on a closing row (mockup 1)?** Recommend **the head**: it
  costs no row and the totals stay visible while running. Amend the mockup rather than the code.
- **Q2. How should a non-clean end show?** Recommend closing with one row only when it is not
  `end_turn`, e.g. `└─ ✗ cancelled` or `└─ ✗ error`, computed in the view-model. Clean ends stay as
  they are.
- **Q3. Wording:** Recommend `… +7 earlier · ctrl+o to expand`: one grammar with the existing hint,
  33 cells with the indent, so it fits at 46 columns. It extends mockup 1's text, hence the question.

### Round 2: outcome, and what a fresh review should attack

*— deepseek-v4.1-flash (tentacle), 2026-11-08 — implementation, so this is a self-check, not the
fresh-context Review AGENTS §10 asks for; a **fresh** pass is still owed before merge. (Corrected in
round 3, review N5: this was signed `claude-opus-5-5`, the reviewer's model. The Round 2 work, like
this section, is deepseek's.)*

All ten findings are addressed, and Q1–Q3 are applied as the recommendations above. Evidence is in
**Execution → Round 2** (red-before-green per group, 7 mutations with `shasum -c` restores, and the
re-captured frames at 80/60/46 for running/done/cancelled/error/2/12/60 steps/Ctrl+O/parallel).
For that fresh pass, the parts to attack hardest:

1. **H1's new shape.** The tree is exempt from the generic cut and the report collapses on its own.
   The property that matters is *"a finished child's newest step, close row and report are all on
   screen, at a width where the whole block exceeds 8 rows"* — proven at 80/60/46 with a 12-line
   report. Attack: a report that is itself huge (a spill), a child with 0 steps and a report, a
   report with a trailing newline, a report whose first line is blank.
2. **The one `collapsedBody`.** It now serves the generic body and a sub-agent's report. Attack:
   does a plain `shell`/`fs_read` body still collapse to exactly 6 + 1 rows at the default (the
   `tool-body collapse` describe), and at `collapseThreshold` 50 (the cache test)?
3. **`hidden` past the cap.** The block now counts off ONE number (`max(toolUses,
   activities.length)`, also reported as `head.toolUses`), so the head and the cut row cannot
   disagree. Attack: the counter/label direction that cannot happen on the wire either way — both
   are pinned, and a real stream increments them together (`state.ts:427-430`).
4. **Q2's wording.** `✗ <stopReason>` printed the raw reason, so a future reason read as-is
   (`✗ budget_exceeded`). Round 3 mapped `cancelled` / `error` / `max_iterations` (`iteration cap`,
   a default awaiting the owner) and still prints an unmapped reason as the wire says it — all of it
   in `closingRow`, nowhere else.
5. **The app frame tests.** Both are real Ink frames, but the *cancelled* one asserts the string
   `└─ ✗ cancelled` after SGR stripping, so a colour-only difference is not covered; `theme.error`
   is applied, and that is a presentation claim no stripped-frame test can pin. A colour assertion
   would need the raw frame's SGR.

### Round 2 (re-review of e95e88a)

*— claude-opus-5-5, 2026-11-08 — adversarial re-review of commit e95e88a. Same model as the Round 1
review, whose recommendations this commit applied, and the Round 2 sections above carry the same
signature (N5): a shared blind spot is possible, and N1 below is one.*

#### Verdict: **REQUEST-CHANGES** (one MEDIUM, small fix)

H1, M1–M4 and L1–L4 are fixed, and nothing regressed outside the block. One new MEDIUM stops a
PASS: the report's cut counts logical lines, so an ordinary prose report fills the screen at 46
columns (N1). That problem comes from the fix I recommended in Round 1 ("only the REPORT
collapses"). The change is about one line plus a test; the rest are nits.

#### Gate (this worktree, e95e88a)

- `bunx tsc --noEmit` → exit 0.
- `bunx biome check .` → 757 files, no fixes.
- `bun test packages` → **5721 pass, 0 fail, 3 skip** (the opt-in baseline), 62844 `expect()`,
  5724 tests, 388 files.

#### Status of every finding

| Finding | Status | Evidence |
|---|---|---|
| H1 newest step, close, report hidden | **Fixed** | "12 steps done" frame; `render-lines.ts:431`, `:616` |
| M1 `hidden` against the head | **Fixed** | "60 steps" frames: `60 tool uses` over `… +55 earlier`; `subagent-view.ts:79,84,87` |
| M2 Ctrl+O cuts labels | **Fixed** (whole label shown; layout nit N2) | "long label Ctrl+O"; `subagent-view.ts:141` |
| M3 cancelled/error look clean | **Fixed** | "cancelled"/"error" frames; `subagent-view.ts:99-104`, `render-lines.ts:297-298`. Real Esc in the App too |
| M4 mockup drift | **Fixed** (Q1: mockup amended) | Context, lines 30-35; head row in every frame |
| L1 false premise | **Fixed** | `subagent-view.ts:29-34`, `state.ts` comment, test renamed |
| L2 test gaps | **Fixed** | `render-lines.test.ts:504`, `:525` |
| L3 adapter in 6a | **Unchanged, as agreed** | The `hidden` fix already handles a short wire tail |
| L4 long type cuts counts | **Fixed** | "long type" frames; `subagent-view.ts:113-123` |
| Q3 wording | **Applied** | Every cut frame; `tool-expand.ts:81` is the only literal in `src` (grep; the rest are comments) |

No finding regressed.

#### New findings

**N1 (MEDIUM). A prose report is not cut: 81 rows at 46 columns.** `collapsedBody` counts LOGICAL
lines (`render-lines.ts:431`, cut at `:555-561`) and `wrapLines` runs later. A report is usually
paragraphs on single long lines, so 8 of them pass the threshold (8) uncut. Round 1 showed 8 rows
for this block. With 12 paragraphs the cut does fire and the block is still 64 rows. Real frame
(abbreviated only where marked):

```
=== done 12 steps, 8 prose lines (at threshold) @46 (rows 81) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  Paragraph 1: the parser reads the config
|once at startup and the watcher re-reads it on
| change, so the parser reads the config once
|at startup and the watcher re-reads it on
   [... 68 more rows of the same shape, no cut marker ...]
```

The newest steps scroll off the top, which is what this task set out to avoid, and two parallel
children double it. The same pre-wrap count exists for every tool body, but before this commit a
child with ≥ 6 steps never reached it. **Fix:** `collapsedBody(wrapLines(report, width), fit)` at
`render-lines.ts:431`. The cut then counts real rows, the block is at most 16 rows at any width (17
with a `✗` row), and continuation rows keep the body indent. Generic tool bodies stay as they are. Red test: 8 long
paragraphs at 46 columns, expect a row count ≤ 16 and `more lines` present; a short report stays
uncut.

**N2 (LOW). Under Ctrl+O a wrapped label loses the tree.** The continuation starts at column 0 and
hard-breaks mid-word, as `wrapLines` does on the fully prefixed row. Not a regression (the same as
before this task), but it is the one untidy frame in the expanded view. Fix if cheap: wrap to
`width - 3` and indent continuation rows.

```
=== long label Ctrl+O @46 (rows 8) ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ $ bun test packages/config/src/a-very-lon
|g-directory-name/packages/config/src/a-very-lo
|ng-directory-name/packages/config/src/a-very-l
|ong-directory-name/
|  └─ …
```

**N3 (LOW). A non-clean end says it twice, and one spelling is raw.** `└─ ✗ cancelled` is followed
by `_(sub-agent cancelled)_` (`packages/tools/src/task.ts:119-122`), and `└─ ✗ max_iterations` by
`_(sub-agent hit its iteration cap)_`. See the owner question below.

**N4 (LOW). "One cut marker per block, never two" is false.** It is at line 304 of this doc and in
the comment at `render-lines.test.ts:375`. The frame "12 short lines" has both `… +7 earlier · ctrl+o
to expand` and `… +6 more lines · ctrl+o to expand`. The behaviour is fine (same grammar, the same
key reveals both); fix the sentence.

**N5 (LOW). Wrong signature on the fix round.** Execution → Round 2 (line 295) and "Round 2: outcome"
are signed `claude-opus-5-5`, while commit e95e88a says `(deepseek)`, as does the task brief. AGENTS
§10 uses these signatures to see which model did what. Correct them.

#### Red-team of the new code

| Attack | Result |
|---|---|
| Exemption with a hook on the call (`tool.hook`, `modified`) | Nothing: one extra row. A `blocked` hook ends the call before any child runs, so it has no `sub` |
| Report huge enough to spill | Nothing: collapsed 17 rows, Ctrl+O shows path and tail |
| 0 steps with a report; 0 steps cancelled | Nothing: head, then report or `└─ ✗ cancelled` |
| Report with leading blank lines | Three blank rows, not reachable: `run` trims the report (`subagent.ts:307`) |
| Shared `collapsedBody` on plain tools | Same condition as before (`!expandAll && length > threshold`); the existing suite is green |
| A false `✗` on a clean end | Nothing: `AgentStopReason` is `end_turn`, `cancelled`, `max_iterations` (`agent.ts:84`); `error` only on a throw (`subagent.ts:300`) |
| Step count past the cap under Ctrl+O | Honest: 50 rows under `… +10 earlier`, no hint (frame below) |
| Head at the width limit | Fine down to 23 columns. Below that the existing `Math.max(20, …)` floor makes rows wrap (`toolLines`); not new, and not a real terminal size |
| CJK and emoji, collapsed and Ctrl+O | Nothing: cut by cells, no row over the width |
| Height over time | Running 3,4,5,6,7,8,9,9…9 (stable from step 6); end 8; with a one-line report 10 |

#### Mutations (backup in `.tentacle/tmp/subagent-tail-view/r2b-backup/`)

Narrow run: `bun test packages/tui/test/render-lines.test.ts packages/tui/test/subagent-view.test.ts`.
None of the three is in the executor's list.

| Mutation | Result |
|---|---|
| `render-lines.ts:431`: `collapsedBody(report, fit)` → `report` | **1 fail**: "a long report still collapses…" |
| `render-lines.ts:294`: drop `&& closing === undefined` | **1 fail**: "a cancelled child closes with `└─ ✗ cancelled`…" |
| `subagent-view.ts:135`: always the hint | **1 fail**: "one grammar with the transcript's other cut markers" |

The last two ran together; each failure is attributed by its own test. Restored by `cp`, `shasum`
identical to before: `render-lines.ts 7370d2d7…`, `subagent-view.ts f660c120…`; `git status` clean.

#### UI/UX at 46 columns

**Clear and calm while it runs, and on a short report; not calm on a prose report (N1).** The
running block holds 9 rows from step 6, the cut row and `ctrl+o` hint fit, a long type keeps its
counts, and `✗` reads at once. The tail, the type cut and the outcome row are the right design.
Once N1 is fixed, a finished block is at most 16 rows at any width (17 with a `✗` row).

#### Real frames

`.tentacle/tmp/subagent-tail-view/review-frames-r2b.ts` (gitignored). Matrix and long cases: real
`applyEvent` → `itemLines` → `wrapLines` → Ink. **App frames:** the real `App` and `Agent`, two
concurrent calls (`peak concurrent agent_task calls: 2`), real Ctrl+O and Esc keys; the `agent_task`
is a fake that emits the progress events, as in `app.test.tsx`, so `⏺ Agent` has no description
there. SGR is stripped, so colours are not evidenced. No row was flagged over the width at 23 columns
or more. The title lists the widths that gave identical frames.

```
=== 2 steps running @80/60/46 (rows 5) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 2 tool uses
|  ├─ Read packages/f1.ts
|  ├─ Read packages/f2.ts
|  └─ …

=== 2 steps done @80/60/46 (rows 6) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 2 tool uses
|  ├─ Read packages/f1.ts
|  └─ Read packages/f2.ts
|
|  The bug is in auth.ts.

=== 2 steps cancelled @80/60/46 (rows 9) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 2 tool uses
|  ├─ Read packages/f1.ts
|  ├─ Read packages/f2.ts
|  └─ ✗ cancelled
|
|  partial findings
|
|  _(sub-agent cancelled)_

=== 2 steps error @80/60/46 (rows 7) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 2 tool uses
|  ├─ Read packages/f1.ts
|  ├─ Read packages/f2.ts
|  └─ ✗ error
|
|  provider exploded

=== 12 steps running @80/60/46 (rows 9) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ …

=== 12 steps done @80/60/46 (rows 10) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  The bug is in auth.ts.

=== 12 steps cancelled @80/60/46 (rows 13) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ ✗ cancelled
|
|  partial findings
|
|  _(sub-agent cancelled)_

=== 12 steps error @80/60/46 (rows 11) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ ✗ error
|
|  provider exploded

=== 60 steps running @80/60/46 (rows 9) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 60 tool uses
|  … +55 earlier · ctrl+o to expand
|  ├─ Read packages/f56.ts
|  ├─ Read packages/f57.ts
|  ├─ Read packages/f58.ts
|  ├─ Read packages/f59.ts
|  ├─ Read packages/f60.ts
|  └─ …

=== 60 steps done @80/60/46 (rows 10) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 60 tool uses
|  … +55 earlier · ctrl+o to expand
|  ├─ Read packages/f56.ts
|  ├─ Read packages/f57.ts
|  ├─ Read packages/f58.ts
|  ├─ Read packages/f59.ts
|  └─ Read packages/f60.ts
|
|  The bug is in auth.ts.

=== 60 steps cancelled @80/60/46 (rows 13) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 60 tool uses
|  … +55 earlier · ctrl+o to expand
|  ├─ Read packages/f56.ts
|  ├─ Read packages/f57.ts
|  ├─ Read packages/f58.ts
|  ├─ Read packages/f59.ts
|  ├─ Read packages/f60.ts
|  └─ ✗ cancelled
|
|  partial findings
|
|  _(sub-agent cancelled)_

=== 60 steps error @80/60/46 (rows 11) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 60 tool uses
|  … +55 earlier · ctrl+o to expand
|  ├─ Read packages/f56.ts
|  ├─ Read packages/f57.ts
|  ├─ Read packages/f58.ts
|  ├─ Read packages/f59.ts
|  ├─ Read packages/f60.ts
|  └─ ✗ error
|
|  provider exploded

=== Ctrl+O 60 done @46 (rows 56; f12 to f58 elided here) ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 60 tool uses
|  … +10 earlier
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f59.ts
|  └─ Read packages/f60.ts
|
|  ok

=== long label collapsed @80 (rows 4) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ $ bun test packages/config/src/a-very-long-directory-name/packages/config…
|  └─ …

=== long label collapsed @60 (rows 4) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ $ bun test packages/config/src/a-very-long-directory-…
|  └─ …

=== long label collapsed @46 (rows 4) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ $ bun test packages/config/src/a-very-l…
|  └─ …

=== long type @80 (rows 9; the five step rows elided here) ===
|⏺ Agent xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…
|⎿ ◆ an-extremely-long-sub-agent-type-name-that-goes-on-and-on-fo… · 7 tool uses
|  … +2 earlier · ctrl+o to expand

=== long type @60 (rows 9; the five step rows elided here) ===
|⏺ Agent xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…
|⎿ ◆ an-extremely-long-sub-agent-type-name-th… · 7 tool uses
|  … +2 earlier · ctrl+o to expand

=== long type @46 (rows 9; the five step rows elided here) ===
|⏺ Agent xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…
|⎿ ◆ an-extremely-long-sub-agen… · 7 tool uses
|  … +2 earlier · ctrl+o to expand

=== done 12 steps, 12 short lines @46 (rows 16; N4) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  report line 1
|  report line 2
|  report line 3
|  report line 4
|  report line 5
|  report line 6
|  … +6 more lines · ctrl+o to expand

=== APP two in parallel, running @46 (viewport, rows 23) ===
|  … +4 earlier · ctrl+o to expand
|  ├─ Read a5.ts
|  ├─ Read a6.ts
|  ├─ Read a7.ts
|  ├─ Read a8.ts
|  ├─ Read a9.ts
|  └─ …
|
|⏺ Agent
|⎿ ◆ general · 9 tool uses
|  … +4 earlier · ctrl+o to expand
|  ├─ Read b5.ts
|  ├─ Read b6.ts
|  ├─ Read b7.ts
|  ├─ Read b8.ts
|  ├─ Read b9.ts
|  └─ …
|
|⠼ Working… 0s · esc/ctrl+c to stop
|────────────────────────────────────── qwen3 ─
|❯  Queue a task…
|──────────────────────────────────────────────
|/tmp/work · ↑7 ↓3 · ctx ░░░░░░░░░░ 0% (7/128k)

=== APP after a real Ctrl+O @46 (viewport, rows 23) ===
|  ├─ Read a7.ts
|  ├─ Read a8.ts
|  ├─ Read a9.ts
|  └─ …
|
|⏺ Agent
|⎿ ◆ general · 9 tool uses
|  ├─ Read b1.ts
|  ├─ Read b2.ts
|  ├─ Read b3.ts
|  ├─ Read b4.ts
|  ├─ Read b5.ts
|  ├─ Read b6.ts
|  ├─ Read b7.ts
|  ├─ Read b8.ts
|  ├─ Read b9.ts
|  └─ …
|
|⠴ Working… 0s · esc/ctrl+c to stop
|────────────────────────────────────── qwen3 ─
|❯  Queue a task…
|──────────────────────────────────────────────
|/tmp/work · ctx 0% (7/128k) · expanded

=== APP after a second Ctrl+O @46: identical to "running" apart from the spinner ===

=== APP after a real Esc @46 (viewport, rows 23) ===
|
|  partial
|
|  _(sub-agent cancelled)_
|
|⏺ Agent 0.6s
|⎿ ◆ general · 9 tool uses
|  … +4 earlier · ctrl+o to expand
|  ├─ Read b5.ts
|  ├─ Read b6.ts
|  ├─ Read b7.ts
|  ├─ Read b8.ts
|  ├─ Read b9.ts
|  └─ ✗ cancelled
|
|  partial
|
|  _(sub-agent cancelled)_
|
|────────────────────────────────────── qwen3 ─
|❯  Type a task or /command
|──────────────────────────────────────────────
|/tmp/work · ↑7 ↓3 · ctx ░░░░░░░░░░ 0% (7/128k)
```

#### Owner question

- **`✗ max_iterations` is a raw identifier beside a prose note.** Your Q2 default named only `cancelled`
  and `error`. Recommend `✗ iteration cap`, mapped in `closingRow`, and leaving the `_(…)_` note to
  the report, since the model reads that text too.

### Round 3 (re-review of 51a5fa8)

*— claude-opus-5-5, 2026-11-08 — adversarial re-review of commit 51a5fa8. Same model and same session
as the two earlier review rounds, so a fresh model, not a fresh context; the code under review is
the executor's (the commit says deepseek).*

#### Verdict: **PASS with nits**

No MEDIUM or higher is open. N1 is fixed in real frames at every width, N2–N4 are fixed, and the
model still receives the note. The six nits below are all LOW and none blocks the merge.

#### Gate (this worktree, 51a5fa8)

- `bunx tsc --noEmit` → exit 0.
- `bunx biome check .` → 757 files, no fixes.
- `bun test packages` → **5735 pass, 0 fail, 3 skip** (the opt-in baseline), 63015 `expect()`,
  5738 tests, 388 files.

#### N1–N5

| Finding | Status | Evidence |
|---|---|---|
| N1 prose report not cut | **Fixed** | 16 rows at 80, 60 and 46, with 8 or 12 paragraphs (was 81 at 46); `render-lines.ts:485-486` |
| N2 Ctrl+O wrap loses the tree | **Fixed** | "long labels, Ctrl+O": continuations under the label; `render-lines.ts:325-342` |
| N3 outcome said twice | **Fixed** where the report has text; see nit 1 for the no-report case | "cancelled" and "iteration cap" frames; `subagent-view.ts:144-151`, `render-lines.ts:419` |
| N4 "never two" | **Fixed** | Execution → Round 3; the sentence is gone from the H1 row and both test comments |
| N5 wrong signature | **Fixed for Round 2, repeated for Round 3** (nit 2) | Lines 295 and 1403 now say deepseek; line 613 says `claude-opus-5-5`, commit 51a5fa8 says deepseek |
| Owner default | **Applied** | `└─ ✗ iteration cap`; `subagent-view.ts:104-108,126` |

Nothing regressed. **A correction to my Round 2 text:** I wrote that a finished block is at most 16
rows (17 with `✗`). The worst case is a report that fits exactly: 17 rows, and 18 with `✗`
("exactly 8 short rows" below). The executor's bound of 17 is the right one for a clean end.

#### Red-team

**Does the model still see the note? Yes, proven end to end.** The real `App`, `Agent` and
`createTaskTool` (fake runner only) ran two concurrent children (`peak concurrent children: 2`). The
frames drop the note; the model's next request carries it:

```
model's next request, tool results:
"found half of it\n\n_(sub-agent cancelled)_"
"ran out of steps\n\n_(sub-agent hit its iteration cap)_"
```

`state.resultText` keeps it too (`"partial\n\n_(sub-agent cancelled)_"`), so the drop is at render only.

**A report that IS only the note: two blank rows, and not reachable.** See nit 3. It cannot come from
the real tool: `subagent.ts:304-312` never returns an empty report, and `task.ts:124` has its own
fallback. What a childless-text cancel really shows is nit 1.

| Attack | Result |
|---|---|
| Wrap-before-cut: exactly 8 rows, 9 rows, one paragraph wrapping to 9 | Right: 8 whole, 9 → 6 + `… +3 more lines`, the same for the single paragraph |
| CJK prose, code fence, a tab in the report | Right: cut by cells, tab expanded, no row over the width |
| Ctrl+O on the report | Whole, and continuation rows now keep the body indent (an improvement) |
| Plain tool bodies | Untouched: `spillBody`'s new argument is optional, and the fold is inside the `tool.sub` branch |
| Note kept when the reason differs (`end_turn`) | Right: shown, nothing dropped |
| Note in the middle of a report | Right: `subagent-view.test.ts`, trailing match only |
| `subagent_end` lost, so no `stopReason` | Right by construction: no note is dropped |

#### Mutation (N1)

`render-lines.ts:485-486`, the original defect in a form the executor did not try: cut first, then
wrap (`collapsedBody(report, fit).flatMap(wrap)`). `bun test packages/tui/test/render-lines.test.ts`
→ **93 pass, 1 fail**: "a prose report is wrapped before it is cut…" (`Expected: <= 8, Received: 16`).
Restored by `cp`; `shasum` unchanged: `render-lines.ts 4794fab0…`, `subagent-view.ts e21a7b6c…`.

#### Nits (LOW, none blocking)

1. **A cancelled child with no text still says it twice.** Below `✗ cancelled` comes `(The explore
   sub-agent finished (cancelled) after 3 tool use(s) without producing a report. Try a narrower task
   or a higher step limit.)`, and that advice is written for the model. It is likely the commonest
   cancel. Drop it at render as the note is, keyed on the same reason.
2. **Round 3's signature repeats N5.** Line 613 says `claude-opus-5-5`; commit 51a5fa8 says deepseek.
3. **An empty report draws two blank rows** (`render-lines.ts:486`): `"".split("\n")` is `[""]`.
   Unreachable today; `folded.some((l) => l !== "")` closes it.
4. **A spilled report keeps a blank row where the note was** (`render-lines.ts:419`): the note goes,
   the blank line before it stays. Trim trailing blanks there as `subAgentReport` does.
5. **A wrapped row can start with a space** (the rows reading ` on change, so…` in the prose frames),
   since `wrapLines` uses `trim: false`. It is existing behaviour, but the report now reaches it often.
6. **A stop reason named like an `Object` member prints garbage** (`subagent-view.ts:126,136`):
   `✗ function Object() { [native code] }`, `✗ [object Object]`. The reason comes from the daemon,
   which in a pod is untrusted, but the effect is display only and nothing throws. Use
   `Object.hasOwn` or a `Map`.

#### Real frames

`.tentacle/tmp/subagent-tail-view/review-frames-r3.ts` (gitignored). Block frames: real `applyEvent` →
`itemLines` → `wrapLines` → Ink, at 80/60/46. App frames: the real `App`, `Agent` and `agent_task`
with a fake runner, at 80/60/46; between widths only the rules and the footer differ. SGR is stripped,
so colours are not evidenced. No row was flagged over the width.

```
=== prose report, 8 paragraphs, done @80 (rows 16; 12 paragraphs: same rows, +54) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  Paragraph 1: the parser reads the config once at startup and the watcher
|  re-reads it on change, so the parser reads the config once at startup and the
|   watcher re-reads it on change, so the parser reads the config once at
|  startup and the watcher re-reads it on change, so the parser reads the config
|   once at startup and the watcher re-reads it on change, so
|  Paragraph 2: the parser reads the config once at startup and the watcher
|  … +34 more lines · ctrl+o to expand

=== prose report, 8 paragraphs, done @60 (rows 16; tree rows as above) ===
|  Paragraph 1: the parser reads the config once at startup
|  and the watcher re-reads it on change, so the parser
|  reads the config once at startup and the watcher re-reads
|   it on change, so the parser reads the config once at
|  startup and the watcher re-reads it on change, so the
|  parser reads the config once at startup and the watcher
|  … +50 more lines · ctrl+o to expand

=== prose report, 8 paragraphs, done @46 (rows 16; 12 paragraphs: same rows, +102) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  └─ Read packages/f12.ts
|
|  Paragraph 1: the parser reads the config
|  once at startup and the watcher re-reads it
|   on change, so the parser reads the config
|  once at startup and the watcher re-reads it
|   on change, so the parser reads the config
|  once at startup and the watcher re-reads it
|  … +66 more lines · ctrl+o to expand

=== long labels, Ctrl+O @80 (rows 11) ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 3 tool uses
|  ├─ $ bun test
|     packages/config/src/a-very-long-directory-name/packages/config/src/a-very-
|     long-directory-name/packages/config/src/a-very-long-directory-name/
|  ├─ $ grep -rn callers of the parser in every package under packages/agent and
|      packages/cli and then some more words
|  ├─ Read 日本語のとても長いファイル名がここに続いています/設定スキーマ定義ファ
|     イル.ts
|  └─ …

=== long labels, Ctrl+O @60 (rows 12) ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 3 tool uses
|  ├─ $ bun test packages/config/src/a-very-long-directory-n
|     ame/packages/config/src/a-very-long-directory-name/pac
|     kages/config/src/a-very-long-directory-name/
|  ├─ $ grep -rn callers of the parser in every package
|     under packages/agent and packages/cli and then some
|     more words
|  ├─ Read 日本語のとても長いファイル名がここに続いています/
|     設定スキーマ定義ファイル.ts
|  └─ …

=== long labels, Ctrl+O @46 (rows 14) ===
|⏺ Agent
|  │ find callers of parseConfig
|⎿ ◆ explore · 3 tool uses
|  ├─ $ bun test packages/config/src/a-very-lo
|     ng-directory-name/packages/config/src/a-
|     very-long-directory-name/packages/config
|     /src/a-very-long-directory-name/
|  ├─ $ grep -rn callers of the parser in
|     every package under packages/agent and
|     packages/cli and then some more words
|  ├─ Read
|     日本語のとても長いファイル名がここに続い
|     ています/設定スキーマ定義ファイル.ts
|  └─ …

=== cancelled, partial report @80/60/46 (rows 11) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ ✗ cancelled
|
|  partial findings

=== iteration cap, partial report @80/60/46 (rows 11) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ ✗ iteration cap
|
|  ran out of steps

=== report IS only the cancel note @46 (rows 8; unreachable, nit 3) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 3 tool uses
|  ├─ Read packages/f1.ts
|  ├─ Read packages/f2.ts
|  ├─ Read packages/f3.ts
|  └─ ✗ cancelled
|
|

=== real empty cancelled child @46 (rows 11; nit 1) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 3 tool uses
|  ├─ Read packages/f1.ts
|  ├─ Read packages/f2.ts
|  ├─ Read packages/f3.ts
|  └─ ✗ cancelled
|
|  (The explore sub-agent finished (cancelled)
|   after 3 tool use(s) without producing a
|  report. Try a narrower task or a higher
|  step limit.)

=== spilled + note, collapsed @46 (rows 12; nit 4) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 2 tool uses
|  ├─ Read packages/f1.ts
|  ├─ Read packages/f2.ts
|  └─ ✗ cancelled
|
|  40.8k chars · too large, the model reads it
|   in parts
|  partial findings
|  … 39.6k chars omitted …
|  last line
|

=== exactly 8 short rows, cancelled (worst case) @46 (rows 18) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 12 tool uses
|  … +7 earlier · ctrl+o to expand
|  ├─ Read packages/f8.ts
|  ├─ Read packages/f9.ts
|  ├─ Read packages/f10.ts
|  ├─ Read packages/f11.ts
|  ├─ Read packages/f12.ts
|  └─ ✗ cancelled
|
|  row 1
|  row 2
|  row 3
|  row 4
|  row 5
|  row 6
|  row 7
|  row 8

=== reason = constructor @46 (rows 6; nit 6) ===
|⏺ Agent find callers of parseConfig
|⎿ ◆ explore · 1 tool use
|  ├─ Read packages/f1.ts
|  └─ ✗ function Object() { [native code] }
|
|  x

=== APP two running @46 (viewport, rows 23) ===
|  … +3 earlier · ctrl+o to expand
|  ├─ Read a4.ts
|  ├─ Read a5.ts
|  ├─ Read a6.ts
|  ├─ Read a7.ts
|  ├─ Read a8.ts
|  └─ …
|
|⏺ Agent migrate tests
|⎿ ◆ general · 8 tool uses
|  … +3 earlier · ctrl+o to expand
|  ├─ Read b4.ts
|  ├─ Read b5.ts
|  ├─ Read b6.ts
|  ├─ Read b7.ts
|  ├─ Read b8.ts
|  └─ …
|
|⠴ Working… 0s · esc/ctrl+c to stop
|────────────────────────────────────── qwen3 ─
|❯  Queue a task…
|──────────────────────────────────────────────
|/tmp/work · ↑7 ↓3 · ctx ░░░░░░░░░░ 0% (7/128k)

=== APP two ended (cancelled, cap) @46 (viewport, rows 23) ===
|  ├─ Read a8.ts
|  └─ ✗ cancelled
|
|  found half of it
|
|⏺ Agent migrate tests 0.4s
|⎿ ◆ general · 8 tool uses
|  … +3 earlier · ctrl+o to expand
|  ├─ Read b4.ts
|  ├─ Read b5.ts
|  ├─ Read b6.ts
|  ├─ Read b7.ts
|  ├─ Read b8.ts
|  └─ ✗ iteration cap
|
|  ran out of steps
|
|⏺ done.
|
|────────────────────────────────────── qwen3 ─
|❯  Type a task or /command
|──────────────────────────────────────────────
|/tmp/work · ↑7 ↓3 · ctx ░░░░░░░░░░ 0% (7/128k)
```


