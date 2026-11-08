# feat/subagent-tail-view — a foreground sub-agent shows a rolling tail (task 2/9)

> **Status:** review
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

