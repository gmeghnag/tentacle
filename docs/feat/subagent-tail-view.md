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

- **Q1. Totals: on the head (as built) or on a closing row (mockup 1)?** Recommend **the head**: it
  costs no row and the totals stay visible while running. Amend the mockup rather than the code.
- **Q2. How should a non-clean end show?** Recommend closing with one row only when it is not
  `end_turn`, e.g. `└─ ✗ cancelled` or `└─ ✗ error`, computed in the view-model. Clean ends stay as
  they are.
- **Q3. Wording:** Recommend `… +7 earlier · ctrl+o to expand`: one grammar with the existing hint,
  33 cells with the indent, so it fits at 46 columns. It extends mockup 1's text, hence the question.

