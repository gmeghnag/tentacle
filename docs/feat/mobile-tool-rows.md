# feat/mobile-tool-rows — Tool calls as a thread of steps, thinking folded (mockup C)

> **Status:** implementation APPROVED (orchestrator, night delegation 2026-11-17; owner chose mockup C)
> **Branch:** `feat/mobile-tool-rows`
> **Size:** M overall, as 3 slices (S1 S · S2 M · S3 S, see Slices) · **Blast:** cross-module (mobile only: the transcript's tool and reasoning rows, the Session screen's list cell and footer; no protocol, persistence or §7 invariant moved) · **Suited:** Opus executes; mandatory fresh-context Review + visual check of simulator screenshots against mockup C
> **Changelog:** `changelog.d/mobile-tool-rows.changed.md` — one bullet: "**Tool calls on iPhone read like steps.** One line per call on a thin thread, readable MCP names and arguments, thinking folded into a ∴ marker; tap a step for its thought, command and result."

## Context

*— claude-opus-5-5, 2026-11-17*

On 2026-11-17 the owner looked at a live session on the iPhone
(`.tentacle/tmp/mobile-tool-rows/owner-now.png`) and saw a stack of rounded
cards: one 48 pt bordered card per tool call, raw JSON as the argument
(`{"width":430…`), MCP names cut off (`mcp__playwright…`), and a
`Thinking ›` row between almost every pair of cards. The owner compared six
phones in `.tentacle/mockups/mobile-tool-rows/index.html` (Today, TUI, A, B, C)
and chose **variant C, "Filo dei passi, pensiero piegato"**, in both of the
mockup's sections (the first grid, and "Insieme a un grafico": steps, then a
chart, then more steps). The owner said "facciamolo bene": do it properly.

**What C is (the look this task must match):**
- The tool calls between two reply paragraphs are **nodes on a thin vertical
  thread** at the left (mockup `.c-run`/`.c-step`: a 1 px `sep` line at x 4.5,
  7 pt dots ringed in the page colour). Each node is ONE line: a status dot
  (ok green, error red, running spinner, queued hollow ring), a human name
  (`playwright · resize`, the server part in `sec`), a mono `sec` argument
  summary, an optional small **∴**, and the duration (`5 ms`, red for an error).
- **No "Thinking" rows.** A ∴ on a step means the model thought before that
  call.
- **Tap opens the step**: its thought (italic, with a ∴), the full command, and
  the result. Errors are red. No card, no box: full width, on the conversation
  background, under a hairline `sepChat` rule, indented 20 pt.
- Steps, charts and text paragraphs follow each other cleanly: two short
  threads with a paragraph and a chart between them.
- Running state (mockup "In corso"): the finished steps, the running step with
  a spinner and a live `2.4 s`, and a last hollow node `sta pensando… 4 s`.

**Constraints from the brief:** light and dark; Dynamic Type; VoiceOver labels;
44 pt touch targets; a smooth expand animation; long (virtualised) transcripts
and streaming updates must not jump. Logic goes in pure, tested modules
(AGENTS §7); the components only draw. The phone ports the TUI's argument
summary instead of importing `@tentacle/tui` (`tool-summary.ts:7-9`). Mobile
only, unless a shared pure helper belongs in a package (decision: it does not,
for now — see Notes/debt).

**Coordination with `fix/mobile-open-at-end`** (owns scroll, open-at-end,
swipe-to-time). Checked on 2026-11-17: it is **NOT merged** (`git log
main..fix/mobile-open-at-end`: exec + review round 1, 30 files). It overlaps
this task in:
- `apps/mobile/src/screens/SessionScreen.tsx`: both edit the FlatList's
  `renderItem` (it wraps each `TranscriptRow` in `SwipeTime`);
- `apps/mobile/src/transcript-rows.ts` / `transcript.ts`: it adds `at?` to the
  user, assistant and tool rows and a `now` argument to `apply`;
- `apps/mobile/src/follow.ts`, `session-feed.ts`: the follow logic that has to
  absorb any height change this task causes.

**Order:** S1 (pure modules, new files + `tool-summary.ts` only) may run now.
**S2 and S3 start only after `fix/mobile-open-at-end` is merged** into `main`
and this branch is rebased onto it. S2 then builds on its `renderItem` and
reads its `ToolRow.at` (the running step's elapsed time).

**Repro** (2026-11-17, from `.tentacle/tmp/mobile-tool-rows/`): what the row
says today for the owner's calls.

```ts
// repro.ts
import { toolMeta, toolSummary } from "../../worktrees/mobile-tool-rows/apps/mobile/src/tool-summary.ts";
const rows = [
  { name: "mcp__playwright__browser_resize", label: "mcp__playwright__browser_resize",
    args: '{"width":430,"height":932}', output: "Resized browser window to 430x932", status: "ok" as const, durationMs: 5 },
  { name: "mcp__veil__browser_open", label: "mcp__veil__browser_open", args: "{}", output: "", status: "ok" as const, durationMs: 2 },
  { name: "fs_read", label: "Read",
    args: '{"path":"packages/daemon/test/persist.test.ts","offset":1,"limit":120}', output: "x", status: "ok" as const, durationMs: 6 },
];
for (const r of rows) {
  const s = toolSummary(r); const m = toolMeta(r);
  console.log(JSON.stringify({ label: s.label, subtitle: s.subtitle, tone: m.tone, trailing: m.trailing }));
}
```

```
$ bun .tentacle/tmp/mobile-tool-rows/repro.ts
{"label":"mcp__playwright__browser_resize","subtitle":"{\"width\":430,\"height\":932}","tone":"ok","trailing":"5 ms"}
{"label":"mcp__veil__browser_open","subtitle":"{}","tone":"ok","trailing":"2 ms"}
{"label":"Read","subtitle":"packages/daemon/test/persist.test.ts","tone":"ok","trailing":"6 ms"}
```

The MCP name is raw, the argument is raw JSON (`{}` for an empty call), and a
ranged read loses its range. The cards, the `Thinking ›` rows and the 12-line
output cut are in the screenshot and in `TranscriptRow.tsx:33,223-341`.

## Implementation

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**The thread can be drawn with ONE list cell per transcript row.** The
FlatList's data stays `rows`, so keys, indices and every consumer of them stay
unchanged. A reasoning row that is folded into a step draws an empty cell. The
live "Thinking…" node is the list's footer, not a row.

Why it matters: other code depends on the row ↔ cell mapping.
- Cells are keyed by row key: `SessionScreen.tsx:704`
  (`keyExtractor={(row: Row) => row.key}`), and data is `state.view.rows`
  (`SessionScreen.tsx:379,703`).
- "Show in chat" scrolls to an index INTO `rows`: `showRow(rows, …)`
  (`SessionScreen.tsx:466`, `subagent-detail.ts:269`) →
  `scrollToIndex({ index })` (`SessionScreen.tsx:476`).
- The read-aloud button is decided on `rows` (`voice-view.ts:64-67`).
- open-at-end's `SwipeTime` wraps each cell's row.

If we re-grouped rows into "run" items, every one of these would have to be
re-indexed, and open-at-end's follow and swipe would be rebased onto a
different list. Per-row cells avoid that.

What has to hold, and the cheap test for it (**first step of S2, before any
styling**): a FlatList cell whose `renderItem` returns `null` lays out at
0 height, and `scrollToIndex` onto or past it still works. Test it on the
simulator: hide every reasoning row, then use "Show in chat" on a report below
hidden rows. If it fails, STOP and re-plan (the fallback is to filter the data
and map `showRow` through a key → index table: one more pure function, plus a
touch on open-at-end's follow).

The footer half: there is no `ListFooterComponent` today, on `main` or on
`fix/mobile-open-at-end` (grep of both `SessionScreen.tsx`). The `TurnRow`
comment already says the running indicator "sits under the transcript, so a
virtualised list's keys never shift" (`transcript-rows.ts:121-131`).

### Preconditions

Verified against the source (`main` @ `cd8613b8`):

1. **Where reasoning rows come from.** They are folded live, as
   append-only deltas into the last reasoning row
   (`transcript.ts:359-381`). A `tool_start` pushes a tool row with status
   `running` (`transcript.ts:382-391`). The stream order within one model round
   is reasoning → text → tool calls (the owner screenshot: `Thinking`, the
   paragraph, then the cards).
2. **History has NO reasoning, and NO error status.** `historyRows` maps
   assistant text + tool calls, then folds the result with status `"ok"` or
   `"denied"` (`transcript-history.ts:82-115`; "any other error flag is not
   stored"). So after a reload: no ∴, and a failed call shows a green dot. This
   is a limitation of the stored log, not of this task (Notes/debt).
3. **The TUI's summary rule is already ported**: `subtitleOf` in
   `tool-summary.ts:36-80` matches `toolSubtitle` in `render-lines.ts:563-620`
   case for case, pinned by the parity cases in `test/tool-summary.test.ts:95`.
   The TUI does NOT flatten MCP arguments: its `default` returns the raw args
   (`render-lines.ts:618`), and `toolLabel` leaves `mcp__x__y` unchanged
   (`core/src/tool-labels.ts:23`, `core/test/tool-labels.test.ts:21`). So the
   readable MCP name and the flattened arguments are NEW phone logic, not a
   port.
4. **MCP names** are exactly `mcp__${server}__${tool}`
   (`packages/mcp/src/tool-adapter.ts:40-42`).
5. **fs_read ranges** come from `offset`/`limit`, or from a `path:start:end`
   suffix (`packages/tools/src/builtins.ts:99-113`).
6. **The TUI's cut**: a body over 8 lines shows its first 6, then
   `… +N more lines · ctrl+o to expand` (`render-lines.ts:69-70,634-645`). An
   error body is red (`render-lines.ts:524`). The first body line carries `⎿`
   (`render-lines.ts:77,700`). An expanded call shows its full command on its
   own rows (`render-lines.ts:625-640,684-686`). The phone's cut today is 12
   lines with "Show N more lines" (`TranscriptRow.tsx:33,262-336`).
7. **The duration format** is `elapsed()` (`tool-summary.ts:104-113`): `42 ms`,
   `1.3 s`, `2 min 5 s`, the same format as the mockup. The trailing text
   rules (diff `+n −m`, `denied`, duration) are `toolMeta`
   (`tool-summary.ts:115-126`).
8. **One layout animation**: `animateNextLayout()` (`ui/animate.ts:9`,
   LayoutAnimation easeInEaseOut). The screen already reads the Reduce Motion
   and VoiceOver flags (`a11yFlags.reduceMotion`, `SessionScreen.tsx` ~842).
9. **Tokens**: `typography` (`theme.ts:194-213`, `MONO = "ui-monospace"`),
   `size.touch = 44`, `DENSE_FONT_SCALE = 1.4` (the font-scale cap on dense
   rows), and palette `sep`/`sepChat`/`sec`/`green`/`red`/`accent`/`page` in both
   schemes (`theme.ts:84-168`). These are the mockup's own values (its header:
   "palette = apps/mobile/src/theme.ts").
10. **The Maestro contract** asserts `tool-<callId>-<status>`
    (`e2e/flows/08-permission.yaml:57`, `08b…:42`, `08c…:48`), plus
    `tool-<id>-output`, `-reply`, `-progress`, `-activity`, `diff-<id>`
    (`TranscriptRow.tsx:10-13,282-321`). All of them are kept.
11. **The app's UI language is English** ("Thinking", "Jump to latest",
    "Message tentacle"). The mockup's Italian labels are mockup copy only.

### Design

Three layers, in dependency order. The first two are pure; the third only draws.

#### 1. What one step SAYS — `tool-summary.ts` (extended, pure)

The TUI-parity `subtitleOf` stays exactly as it is (the parity test keeps
pinning it). It becomes the FULL command shown in the open body. Added next to
it:

- `toolName(name, label) → { server?: string; tool: string }`. For
  `mcp__<server>__<tool>`: split on the first `__` after the prefix; the server
  is drawn `sec`, then ` · `, then the tool. Every other name is `{ tool: label }`
  (`Bash`, `Read`, …). An unparseable `mcp__…` (an empty part) falls back to
  the raw label: never an empty name. *(Owner Q5: the tool part is shown as
  is — `browser_resize`, not the mockup's `resize`.)*
- `rowSubtitle(name, args) → string`: the ONE line on the step.
  - `fs_read`/`fs_write`/`fs_edit`/`fs_multi_edit`: the **basename**, plus
    ` · A–B` for a ranged read (`offset`/`limit`, or a `:start:end` suffix:
    `persist.test.ts · 1–120`), plus the existing ` · N edits`. *(Owner Q4.)*
  - `shell`, `search`, `shell_output`/`shell_kill`, `agent_*`, `skill`: the
    TUI subtitle, unchanged (the row's `numberOfLines={1}` cuts it with `…`).
  - MCP (`mcp__…`): `mcpRowArgs(args)`. *(Owner Q6)*
    1. Not a JSON object → the raw text flattened to one line (tabs and
       newlines → spaces, as `fitSubtitle` does; `tool-expand.ts:106-111`).
    2. Numeric `width` + `height` → `430 × 932`.
    3. Else the first string value under a primary key, in this order:
       `url, path, filename, file, query, command, selector, text, name,
       element` (a path or filename is shown as its basename).
    4. Else flattened: `true` → the key alone (`fullPage`); `false`/`null` are
       dropped; a string or number → `key value`; a nested object or array →
       `key …`. Pairs are joined with ` · `, and `{}` gives `""`.
  - Any other unknown tool: the same `mcpRowArgs` (a plugin tool's JSON is
    still never shown raw).
- `bodyCommand(name, args) → readonly string[]`: what the open body shows as the
  command. For a TUI-summarised tool: `subtitleOf` (full command or path; a
  multi-line command keeps its lines). For MCP/unknown: one `key  value` line per
  leaf, with nested keys dotted (`a.b`, `items[0]`), capped at 20 lines, then
  `… +N more`. `[]` when there is nothing to add beyond the row (the row
  already says all of it, e.g. `BashKill bg-1`).
- `outputView(output, { full, error }) → { lines; hidden; error }`: the TUI's
  cut. More than 8 lines → the first 6 plus `hidden = N`. Trailing newlines are
  trimmed and escapes stripped (`stripAnsi`, already here). Replaces
  `OUTPUT_PREVIEW_LINES = 12`. *(Owner Q8)*
- `spokenDuration(ms)`: `14 milliseconds`, `1.3 seconds`, `2 minutes 5
  seconds`, for VoiceOver.

#### 2. How rows become steps — new `tool-steps.ts` (pure, React-free)

`stepLayout(rows: readonly Row[], running: boolean) → StepLayout`. It is
memoised in the screen on `[rows, running]` and is O(n).

```ts
type StepCell =
  | { kind: "hidden" }                       // a reasoning row folded elsewhere
  | { kind: "step"; thought: string | null; thread: ThreadPos } // a tool row
  | { kind: "thought"; text: string; thread: ThreadPos };       // an orphan thought
type ThreadPos = { up: boolean; down: boolean };  // draw the segment above / below the node
interface StepLayout {
  readonly cells: ReadonlyMap<string, StepCell>;  // by row key; rows absent = drawn as today
  readonly tail: { thought: string } | null;      // the live "Thinking…" footer node
}
```

Rules (each one is a test):
- **Fold:** a reasoning row folds into the NEXT tool row when only reasoning
  rows lie between them (no assistant text, no notice, no user row). That tool
  gets `thought` (the reasoning texts joined with a blank line), and the
  reasoning cell is `hidden`. In a parallel batch, only the first tool gets the
  thought. *(Owner Q3: a reasoning row separated from its tool by reply text
  is NOT moved across the text. Moving it would remove a line ABOVE text that
  is already on screen, which is a jump.)*
- **Orphan:** a reasoning row with no tool to fold into, when it is NOT the
  live tail, is a `thought` node: ∴ in the dot's place, "Thought" plus the
  first line of the text in `sec` italic, tap to open. *(Owner Q1.)*
- **Live tail:** while `running`, the turn is "thinking" when the last row is a
  reasoning row, a finished tool (`ok`/`error`/`denied`, nothing `running` or
  `queued` after it), or the user's own prompt (nothing streamed yet). Then
  `tail` is set, carrying the live reasoning text when there is any; that
  reasoning cell is `hidden`, because the footer shows it. Streaming text or a
  running tool means no tail: the text is the signal, or the spinner is.
  *(Owner Q2.)*
- **Thread:** a run is a maximal sequence of step/thought nodes in which hidden
  cells are transparent. Any other row (assistant text, notice, user) ends the
  run. `up` = a node of the same run comes before; `down` = one comes after,
  or the tail follows directly. Single-node runs draw no line at all (just the
  dot), like the mockup's short threads.

Why there is no jump while streaming. Every transition swaps one one-line
node for another one-line node at the BOTTOM of the list, or changes only a
dot or a trailing text:
- reasoning streams → footer `Thinking…`;
- `tool_start` → the footer goes, and the tool node appears with its ∴
  (same height);
- result → the dot and the duration change, and the collapsed height is
  unchanged;
- text starts after the reasoning → the footer goes, and the `Thought` node
  plus the text appear where the footer was.

A step never opens by itself.

Also pure, in `tool-steps.ts`:
- `stepA11yLabel(...)`: e.g. `"Bash, ls -la polpo-page.png, succeeded, 14
  milliseconds, thought first"`. The status words are `succeeded`, `failed`,
  `denied`, `running`, `queued`.
- `toggleOpen(ids, key)` and `isOpen(ids, key)`: a sorted id array, the TUI's
  `toggleExpanded` shape (`tool-expand.ts:92-97`). The open steps (and the
  "show all lines" set) live in the SCREEN, not in the cell. A virtualised
  cell that scrolls out of the window unmounts and would lose a local
  `useState`; that is today's behaviour, and it is a bug for long transcripts.

#### 3. Drawing — `ui/StepNode.tsx` (new) replaces `ui/ToolRow.tsx` (deleted)

`StepNode` is a dumb renderer. It receives the view (name parts, subtitle, tone,
trailing, ∴, thread, open, a11y label) and draws:
- **The gutter** (10 pt wide, plus a 10 pt gap): the 1 px `sep` thread, as a
  top half and a bottom half per `ThreadPos`, running the full height of the
  cell, so the line stays continuous past an open body. The node sits on the
  first line's centre:
  - ok/error: a 7 pt `green`/`red` dot ringed 3 pt in `page`;
  - running: a 10 pt ring spinner in `accent`, an `Animated` native-driver
    loop (a still dot under Reduce Motion);
  - queued: a hollow 7 pt `sec` ring;
  - thought: a 10 pt ∴ in `sec`.
  The thread is `accessibilityElementsHidden`.
- **The line** (a `Pressable`, `minHeight: size.touch` = 44, the whole row
  tappable; no chevron, as in C):
  - the name: 14/500 sans `label`, with the `server · ` part 14/400 `sec`;
  - the subtitle: mono 12.5 `sec`, `flex: 1`, one line;
  - an optional ∴ (10 pt `sec`, opacity 0.8);
  - the trailing text: 12 `sec`, or `red` for error/denied. A running step
    shows a live elapsed time from `row.at` (after open-at-end), ticking once
    a second inside this node only; when `at` is absent, it shows none rather
    than an invented time.
  Every text is capped at `DENSE_FONT_SCALE`. The name `flexShrink: 0` takes at
  most 45%. New `typography.step` (14/20/500) and `typography.stepMono` (12.5/18
  mono). `accessibilityRole="button"`, `accessibilityState={{ expanded }}`,
  the hint "Shows the thought, command and result". Not tappable when the body
  would be empty (no thought, no `bodyCommand`, no output, diff or denial).
- **The open body** (marginLeft 20, a hairline `sepChat` top rule, no
  background):
  - the thought (∴ plus italic 13.5 sans `sec`, full Dynamic Type);
  - the command (mono 12 `label`, wraps);
  - the result: `⎿ ` on its first line, mono 12 `sec`, or `red` for an error;
    when cut, a `… +N more lines` row that shows everything on tap;
  - the diff (`DiffView`, moved here from always-visible; *Owner Q7*);
  - the denial reply ("Your reply: …", red).
- **Kept under the line, outside the body**, indented 20 pt beside the thread:
  the sub-agent progress line and the `sa-N · Activity ›` link
  (`TranscriptRow.tsx:284-312`).
- **Expand animation**: `animateNextLayout()` right before the toggle, skipped
  under Reduce Motion (a `reduceMotion` argument added to `animate.ts`).

`TranscriptRow.tsx`:
- `ToolRowView` draws a `StepNode`.
- `ReasoningRowView` draws nothing (`hidden`), or a thought `StepNode`.
- A step's `Shell` has no vertical padding (the thread must touch the next
  cell). It gets `marginTop` 6 when `!up` and `marginBottom` 6 when `!down`:
  the mockup's 12 px run margin, split at each end.
- The `testID`s are unchanged: `tool-<id>-<status>` stays on the label, and
  `tool-<id>-output` on the result.

`SessionScreen.tsx`:
- `const layout = useMemo(() => stepLayout(rows, running), [rows, running])`.
- `renderItem` passes `layout.cells.get(item.key)`, `open` and `onToggle`.
- The `openSteps` state goes into `rowExtraData`.
- `ListFooterComponent` draws the tail as a `StepNode` (hollow `sec` ring,
  italic "Thinking…", `up` from the layout, elapsed from a footer-local start
  time keyed on the tail's identity, tap opens the live thought).
- Nothing else in the list changes.

Not built (deliberately): grouping into "N steps" (that was variant B), a
per-server dictionary of short MCP names, and persisting reasoning or error
status (Notes/debt).

### Files

In dependency order (all under `apps/mobile/`):

| Slice | File | Change |
|---|---|---|
| S1 | `src/tool-summary.ts` | + `toolName`, `rowSubtitle`, `mcpRowArgs`, `bodyCommand`, `outputView`, `spokenDuration`; `subtitleOf` unchanged |
| S1 | `src/tool-steps.ts` (new) | `stepLayout`, `stepA11yLabel`, `toggleOpen`/`isOpen` |
| S1 | `test/tool-summary.test.ts` | new cases (below); the parity cases unchanged |
| S1 | `test/tool-steps.test.ts` (new) | the layout rules |
| S2 | `src/theme.ts` | + `typography.step`, `typography.stepMono` |
| S2 | `src/ui/animate.ts` | `animateNextLayout(reduceMotion?)` |
| S2 | `src/ui/StepNode.tsx` (new) / `src/ui/ToolRow.tsx` (deleted) | the drawing |
| S2 | `src/screens/transcript/TranscriptRow.tsx` | tool + reasoning views → `StepNode`; `OUTPUT_PREVIEW_LINES` removed |
| S2 | `src/screens/SessionScreen.tsx` | the layout memo, open state, cell props, `ListFooterComponent` |
| S2 | `test/tool-rows-wiring.test.ts` (new) | source-pinned wiring (the `session-screen-follow-wiring.test.ts` pattern) |
| S3 | `e2e/mock-model.ts` | a `TOOLROWS` prompt: streams `reasoning_content`, text, then calls (shell ok, shell failing, ranged `fs_read`, an unknown `mcp__demo__browser_resize` → an error row), reasoning, a final reply |
| S3 | `e2e/flows/29-tool-rows.yaml` (new) | drives it; asserts the testIDs; `_shot` light/dark: collapsed, one open, running |
| S3 | `changelog.d/mobile-tool-rows.changed.md` | the bullet in the header |

### Failure modes

- **Unparseable or partial args** (a call still streaming its JSON, or
  non-JSON): `argsOf` already returns `{}`, and `mcpRowArgs` shows the raw text
  flattened to one line. Never a crash, never a blank name.
- **Odd MCP names** (`mcp__`, `mcp__x`, `mcp____y`): the raw label (tested).
- **Huge outputs or args**: `outputView` cuts at 6 lines until tapped;
  `bodyCommand` caps at 20 leaves. A "show all" of a 10 000-line output is
  bounded by the result the daemon sends (its spill already caps it). The
  body is a single `Text`, as today.
- **Long transcripts**: the open state is in the screen, so it survives
  unmounting. `stepLayout` is O(n) and memoised. Hidden cells are 0 pt (the
  load-bearing test). The 1 s tick re-renders only the running node and the
  footer, never the list.
- **A running turn that ends mid-thought** (cancel, disconnect, a lost
  stream): `running` turns false, the tail goes, and the reasoning row becomes
  an orphan `Thought` node (or stays folded if a tool follows). This happens
  the same way on a resync: the layout is a pure function of rows.
- **A reload/resync**: history has no reasoning, so there is no ∴ and no
  thoughts, and failed calls are green. This is honest about what the log
  stores; documented, not hidden (Notes/debt).
- **A tool result for an unknown id**, or tools out of order: the fold is
  unchanged (`updateTool`); the layout only reads the order of the rows.
- **A notice between two tools** (a truncation, a hook note): it ends the run.
  That gives two threads, which is correct (something else happened between
  them).
- **Dynamic Type at AX5**: the row stays one line (cap 1.4×, the text cut with
  `…`, and the full text is in the body and in the a11y label). The body wraps
  at full size.
- **VoiceOver**: one element per step (label, state, hint). The thread is
  hidden; the footer reads "Thinking, N seconds".
- **Reduce Motion**: no layout animation and no spinner rotation.
- **The merge with open-at-end**: S2 is executed after it lands, so
  `renderItem` is edited once, on top of `SwipeTime`. A hidden cell must not
  be swipeable (return `null` before wrapping it).

### Tests

S1, red before green (the new functions do not exist, so the cases fail
first):
- `tool-summary.test.ts`:
  - `toolName`: Bash, MCP, and the odd names.
  - `rowSubtitle`: a basename; a ranged read by offset/limit and by
    `:10:20`; multi-edit; shell unchanged (the existing parity cases still
    pass).
  - `mcpRowArgs`: each of the 4 rules — `430 × 932`, `polpo-page.png`,
    `fullPage`, `scale device · filename …`, `{}` → `""`, raw text.
  - `bodyCommand`: dotted keys and the 20-leaf cap.
  - `outputView`: 8 lines → whole; 9 → 6 + 3 hidden; `full` → whole; error
    flag.
  - `spokenDuration`.
- `tool-steps.test.ts`:
  - fold across reasoning-only gaps; NO fold across assistant text;
  - only the first tool of a batch gets the thought;
  - orphan thought;
  - tail on: the last row reasoning, a finished tool, the user's prompt;
  - tail off: streaming text, a running/queued tool, or not running;
  - thread `up`/`down` for 1, 2 and 3 nodes; a notice splits a run;
  - the tail extends `down`;
  - a resync (the same rows without reasoning) gives the same steps with no
    thoughts;
  - the a11y label;
  - `toggleOpen`.
- Mutation check (§9): drop the "no text between" condition, or make `down`
  ignore the tail, and confirm a named test fails each time; then revert.

S2:
- `tool-rows-wiring.test.ts` (source-pinned):
  - `renderItem` reads `layout.cells.get(item.key)`;
  - `ListFooterComponent` is wired to `layout.tail`;
  - no `useState` for open/all inside `TranscriptRow.tsx`;
  - the `tool-${tool.id}-${tool.status}` testID is still on the label;
  - `ToolRow.tsx` is gone.
- The existing `transcript*.test.ts`, `tool-summary` parity and open-at-end
  tests stay green.

**Visual check (S3, mandatory, done by the reviewer too):**
- iOS simulator (iPhone 16-class, 393 pt). Run flow 29 with Maestro, or, if
  the e2e build is still blocked (`mobile-chrome.md` Review), run a dev build
  plus the mock model by hand.
- Screenshots into `.tentacle/tmp/mobile-tool-rows/shots/`:
  - collapsed thread;
  - one step open with ∴, command and result;
  - error step open;
  - running (spinner + `Thinking…` footer);
  - steps → reply → chart/markdown → steps;
  - each in light AND dark (`xcrun simctl ui booted appearance dark`);
  - plus one at `xcrun simctl ui booted content_size accessibility-extra-large`.
- Compare side by side with mockup C (both sections): thread x and colour,
  dot size, one line per step, no boxes, the body indent, the spacing around
  paragraphs and the chart.
- VoiceOver: Accessibility Inspector on one step and the footer.
- Scroll a 300-row seeded session: no jump while a turn streams at the bottom,
  and an opened step stays open after scrolling far away and back.
- Paste the verdict and any deltas into Execution.

### Slices

| Slice | What | Size · Blast · Suited | Done when |
|---|---|---|---|
| S1 | Pure view-model: `tool-summary.ts` additions + `tool-steps.ts` | S · contained · any model; standard Review | the S1 tests red → green, mutation checked; can run before open-at-end merges |
| S2 | Drawing: `StepNode`, `TranscriptRow`, `SessionScreen` footer + open state | M · cross-module · Opus | the load-bearing simulator test passes first; wiring tests green; `bun run check` green |
| S3 | Mock-model turn, flow 29, screenshots, changelog | S · contained · Opus + fresh-context visual Review | screenshots match mockup C in light/dark/AX; Review signed |

### Notes / debt

- **Reasoning and tool error status are not in the session log**
  (`transcript-history.ts:82-115`). After a reload the ∴ markers vanish and a
  failed call shows green. Persisting them is a protocol/log change, so it is a
  separate task.
- **The readable MCP name and the flattened arguments live in the mobile app
  only.** The TUI still shows `mcp__…` and raw JSON (`render-lines.ts:618`). If
  the owner wants parity, move `toolName`/`mcpRowArgs` into `@tentacle/core`
  beside `toolLabel` (a cross-module follow-up with its own TUI tests).
- **`TranscriptRow` is not `React.memo`.** Toggling a step re-renders the
  visible window through `extraData`. That is acceptable at FlatList's window
  size; memoise it later only if a profile shows a need.

### Owner questions

The orchestrator answers these with the recommendations tonight (owner
asleep); the owner may overrule them on waking.

1. **Trailing thinking (a thought with no tool after it, e.g. before the final
   answer): how is it shown?** *Rec:* as a `Thought` node, with ∴ in the dot's
   place and the first line in `sec` italic, tap to open; on the thread when it
   follows steps, alone otherwise.
2. **A running turn's "sta pensando…": where?** *Rec:* the list's footer, as
   the thread's last node: a hollow ring, "Thinking…" and the seconds. It also
   shows before the first token, and tapping it opens the live thought. English
   copy, like the rest of the app.
3. **Fold a thought into the next tool even when reply text lies between
   them?** *Rec:* no. Fold only across thought-only gaps; otherwise it is a
   `Thought` node. Folding across text would remove a line above text already
   on screen, which is a jump.
4. **File paths on the row: the full path (TUI) or the basename + range
   (mockup C)?** *Rec:* basename + range (`persist.test.ts · 1–120`) on the
   row, the full path in the open body.
5. **MCP names: `playwright · browser_resize` (generic) or the mockup's
   `playwright · resize` (per-server shortening)?** *Rec:* generic: the
   server, then the tool name exactly. Predictable, and it matches what
   permissions and hooks show.
6. **MCP argument summary rules?** *Rec:* `W × H` for width/height; else the
   first of url/path/filename/file/query/command/selector/text/name/element;
   else `key value` pairs joined by ` · ` (`true` → the key, `false`/`null`
   dropped, nested → `key …`); the full `key value` list in the body; never
   raw JSON.
7. **Edit/Write diffs: always visible under the step (today), or inside the tap
   body?** *Rec:* in the body, with `+n −m` kept on the row. One line per step
   is the point of C.
8. **Output cut and `⎿`: C's body has no `⎿`; today's cut is 12 lines.**
   *Rec:* the TUI's rule (over 8 lines → 6 + `… +N more lines`, tap for all)
   and `⎿` on the result's first line, as the brief asks.

**Answers (orchestrator, 2026-11-17, owner asleep — night delegation):** Q1–Q8 all as recommended. The owner may overrule on waking. Persisting reasoning + tool error status (Notes/debt 1) is a separate task: it adds session-log entries, so the owner decides it (critical entries).

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Execution

*— claude-opus-5-5, 2026-11-17* — **S1 only** (S2, S3 not started)

**Load-bearing check.** The plan puts it as S2's first step (simulator:
`renderItem → null` lays out at 0 pt, and `scrollToIndex` still works). S1 is
pure, so it cannot run that check and does not depend on it. I re-checked the
static half: cells are keyed by `row.key` (`SessionScreen.tsx:704`), and
"Show in chat" indexes into `rows` (`showRow(rows, …)` :466 →
`scrollToIndex` :476). That still holds. **The simulator half is still owed by S2.**

**As built, in order (red → green):**
1. `test/tool-summary.test.ts`: added 20 cases (toolName, rowSubtitle,
   mcpRowArgs rules 1–4, bodyCommand, outputView, spokenDuration). Ran them
   against stubs that return the fallback values: **20 fail / 28 pass, all on
   assertions**. Then wrote `src/tool-summary.ts` (`toolName`, `mcpRowArgs`,
   `rowSubtitle`, `bodyCommand`, `outputView`, `spokenDuration`). Result: 48/48.
   `subtitleOf` is untouched, and its parity cases still pass.
2. `test/tool-steps.test.ts` (new, 26 cases) against a stub `src/tool-steps.ts`:
   **23 fail / 3 pass**. The 3 that pass are "tail off" cases, which are
   trivially `null` on a stub. M3 below covers them. Then wrote `stepLayout`,
   `stepA11yLabel`, `toggleOpen`/`isOpen`. Result: 26/26.
3. `changelog.d/mobile-tool-rows.changed.md`: the header's bullet. It is
   written now because the owner's executor brief asks for it; the plan had it in S3.

**Mutation checks (§9).** Each was applied by hand, then reverted, then the file re-run green:
- M1, drop "no text between" (text no longer flushes the pending reasoning) →
  4 fail: `NO fold across assistant text`, `no fold across a notice or a user
  row`, `a trailing thought before the final answer`, `an orphan thought is a
  node on the thread`.
- M2, `down` ignores the tail → 2 fail: `on: the last row is a finished tool`,
  `the tail extends the last node down…`.
- M3, the tail ignores a running/queued tool in the trailing batch → 2 fail:
  `off: a running or queued tool…`, `tool_start replaces the footer…`.
- M4, `outputView` cut off by one (`<= 9`) → 1 fail: `9 lines → the first 6 + 3 hidden`.

**Drift from Implementation (and why):**
- `StepLayout.tail` is `{ thought; up }`, not `{ thought }`. The design's
  footer takes "`up` from the layout", but the sketched type had no field
  for it.
- Several orphan reasoning rows in a row become ONE Thought node on the first
  row, and the others are `hidden`. An empty or whitespace-only reasoning row
  folds to no thought (`thought: null`), or is `hidden` when orphaned. The plan
  covered neither case. These choices avoid stacked or blank "Thought" lines.
- The tail rule "a finished tool, nothing running or queued after it" is read
  as: every tool of the trailing contiguous batch is finished. A parallel batch
  whose last row is done but an earlier one still runs has no tail. The
  spinner is the signal there.
- fs_read ranges: offset only → `A–`, limit only → `1–B`, and `path:N` →
  `N–`. These are the forms `parsePathRange` accepts (`builtins.ts:84-96`,
  offset 1-based).
- `bodyCommand` returns `[]` when the summarised subtitle is empty, and for
  `shell_output`, `shell_kill`, `agent_control`/`kill`/`message`/`status` and
  `skill`, whose row is an id or a name. Non-JSON MCP args return the raw lines,
  with the same 20-line cap.
- `stepA11yLabel`: an MCP step reads `server tool` (no `·`). A diff reads
  `N added, M removed` instead of a duration, mirroring `toolMeta`'s trailing
  priority.
- `spokenDuration` uses singular forms (`1 minute 1 second`), and a whole
  minute drops ` 0 seconds`.

**Gate:** `bun run typecheck` clean · `bun run lint` clean (1792 files, 0
issues) · `bun test`: 13088 pass, 5 skip, **1 fail**. The failure is
`cli main … apiKeyCommand stops neither the status probe` (ENXIO on a tty write
in `pod-resident.ts:783`). It is unrelated to this mobile-only change:
`bun test packages/cli/test/main.test.ts` alone gives 119/119. It is flaky
under full-suite load. The baseline counts 3 opt-in skips, and the suite now
reports 5. None of them come from this slice (the new tests have 0
`skip`), but I did not identify which 2 are extra.
No schema touched, so `protocol.json` is not regenerated and there is no `protocol.d/` note.

### Fix round 1

*— claude-opus-5-5, 2026-11-17* — addresses Review round 1. It had one finding, a test gap; the code is unchanged.

- **Finding 1 (MEDIUM, test gap) — FIXED.** Added `the tail extends ONLY the last run: an earlier run's last node stays down: false` to `apps/mobile/test/tool-steps.test.ts` (rows `a1, a2, text, b`, thinking). It asserts `a2` is `{up:true, down:false}`, `b` is `{up:false, down:true}`, and the tail is `{thought:"", up:true}`.
- **Red → green, by mutation:** `tool-steps.ts:157`, `(tailJoins && run === last)` → `tailJoins` gives **26 pass / 1 fail**: the new case, on its `toMatchObject` assertion. Reverted (`git diff src/` empty) → **27/27**.
- **Gate:** `bunx tsc --noEmit` clean · `tsc -p apps/mobile` clean · `bun run lint` clean (1792 files) · `bun test`: 13089 pass, 5 skip, **1 fail**. The failure is `packages/exec/test/confinement.test.ts` F2 (hard link, a `WorkspaceWriteError` on a `/var` vs `/private/var` temp path). It is unrelated: this branch touches nothing under `packages/`, and the file alone gives 46/46. It is flaky under full-suite load, like the round-0 CLI flake.

### Semantic fix after main merge

*— claude-opus-5-5, 2026-11-17* — main was merged into `feat/mobile-tool-rows` and left the gate red: `apps/mobile/test/tool-summary.test.ts` `shell, search, jobs, agents, skill: the TUI subtitle, unchanged` failed on `chart`. Root cause, one sentence: main added `chart` to the TUI's `toolSubtitle` switch (`packages/tui/src/render-lines.ts:625`), but the phone's copy of the rule kept its own hand-written `SUMMARISED` set (`tool-summary.ts:165`) without it, so `rowSubtitle` routed `chart` to `mcpRowArgs` and drew `type line · title Ricavi 2026 · datasets …` instead of the chart's title. The same drift class could hit any future TUI case, so the fix is structural, not a one-name patch.

- **One shared list.** `SUMMARISED_TOOLS` (`tool-summary.ts:46`) is now the single exported list, placed directly above `subtitleOf` and containing `chart`; `SUMMARISED` is `new Set(SUMMARISED_TOOLS)` (line 202) and `subtitleOf` gained the matching `chart` case (line 112, `str("title") ?? raw`, exactly the TUI's `str("title") ?? tool.args`). I checked every `case` in `toolSubtitle` against the list: `fs_read`, `fs_write`, `fs_edit`, `fs_multi_edit`, `shell`, `search`, `shell_output`, `shell_kill`, `agent_task`, `agent_control`, `agent_kill`, `agent_message`, `agent_status`, `skill`, `chart` — 15 names, all present; `chart` was the only omission.
- **Guard test.** New describe `SUMMARISED_TOOLS is the TUI's toolSubtitle switch, name for name` (`apps/mobile/test/tool-summary.test.ts`): it reads `packages/tui/src/render-lines.ts` from disk (a static import cannot — that module pulls `marked-terminal` into `tsc -p apps/mobile`), slices `function toolSubtitle(` … `function commandRows(`, regexes its `case "x":` labels, and asserts set equality with `SUMMARISED_TOOLS`. Three tests: the scan is non-vacuous (finds `shell` and `chart`), the two sides are equal, and every summarised name is actually routed into the switch rather than to the flattening (args `{"zzz":1}` → the switch says `""`/raw args, `mcpRowArgs` says `zzz 1`).
- **Red → green, by mutation:** removing `"chart"` from `SUMMARISED_TOOLS` gives **50 pass / 2 fail** — the new set-equality case (diff names `chart`) and the original parity case (`Expected: "Ricavi 2026"`, `Received: "type line · title Ricavi 2026 · datasets …"`). Restored → **52/52**.
- **Gate:** `bun test apps/mobile/test` — 2564 pass, 0 fail (182 files), the previously red case green. `bun run lint` — clean, 1851 files. `bunx tsc -p apps/mobile --noEmit` — 2 errors, both pre-existing and environment-only: `Cannot find module 'expo-document-picker'` (`src/pdf-source.ts:1`) and `'react-native-svg'` (`src/ui/chart/ChartView.tsx:24`) — those two packages are not installed in this worktree (`node_modules/` has neither); this diff imports neither.
- **Deliberately left:** the guard reads the TUI's source text, so renaming `toolSubtitle` or moving it into another file would make it fail loudly (its `indexOf` assertions) rather than silently pass — acceptable for a same-repo parity pin, and the `transcript-parity.test.ts` pattern already reads TUI files. This note records the fix; no `protocol.d/` note and no changelog fragment (internal wiring of a phone-side rule, no user-visible change beyond restoring intent).

### S2 — drawing

*— claude-opus-5-5, 2026-11-17* — **S2 only** (S3 not started).

**Load-bearing check: static half holds; simulator half NOT run (owed to S3).**
The simulator check needs a native build, and this worktree cannot bundle the
app: `react-native-svg` and `expo-document-picker` (both in
`apps/mobile/package.json`) are not installed here (`ls node_modules` shows
neither), and the sandbox blocks reading the installed app's bundle. The
cheapest evidence I could get is the RN 0.88 source. Every cell is
`<View onLayout>{element}</View>` (`@react-native/virtualized-lists`
`VirtualizedListCellRenderer.js:215-229`), so a `null` item is a measured 0 pt
cell. `ListMetricsAggregator.notifyCellLayout` (`:76`) stores it like any other
cell, so `scrollToIndex` onto or past it uses measured frames. The cells are
still keyed by `row.key`, and "Show in chat" still indexes `rows`
(unchanged). **To verify:** in S3's simulator run, use "Show in chat" on a
report below hidden reasoning rows. If that fails, the plan's fallback applies
(filter the data + a key → index map), and only `SessionScreen` changes.

**As built, in order:**
1. **Red first.** I wrote two new test files, `test/tool-step-view.test.ts`
   (the pure S2 view-model) and `test/tool-rows-wiring.test.ts` (source-pinned
   wiring). Against stubs, `tool-step-view` gave **14 fail / 1 pass**, all on
   assertions. The 1 pass is "no predicate = S1 behaviour", a guard that is
   meant to pass. `tool-rows-wiring` was red on every new-wiring assertion.
   I added `isBlockRow` later, red on its stub first (**1 fail**).
2. **Pure code** (`src/tool-steps.ts`, `src/tool-summary.ts`):
   - `stepRowView(row, thought, full)` gives the node everything it draws:
     the name parts, subtitle, dot, trailing text and its red flag, `live`,
     body thought, command, `⎿`-prefixed cut output, `tappable`, and the
     a11y label.
   - `thoughtRowView`.
   - `thinkingA11yLabel`.
   - `liveElapsed`: whole seconds, for the 1 s tick.
   - `isBlockRow`.
   - `stepLayout(rows, running, isBlock?)`.
3. `theme.ts`: added `typography.step` (14/20/500) and `typography.stepMono`
   (12.5/18 mono). `ui/animate.ts`: `animateNextLayout(reduceMotion = false)`
   is a no-op under Reduce Motion.
4. `ui/StepNode.tsx` (new):
   - `StepNode` draws a 10 pt gutter with the up/down 1 px `sep` segments
     (`accessibilityElementsHidden`). The node sits at the line's centre (22
     pt): a 7 pt dot ringed 3 pt in `page`, a 10 pt `accent` ring spinner (a
     native-driver `Animated.loop`, a still dot under Reduce Motion), a hollow
     `sec` ring, or ∴. Then the 44 pt `Pressable` line: the name (45% max,
     with `server · ` in `sec` 400), the mono subtitle, ∴, and the trailing
     text, or a live `liveElapsed` clock from `row.at`. Then `below`, then the
     open body under a `sepChat` hairline.
   - `StepBody` draws the italic thought, the mono command, the `⎿` result
     with `… +N more lines`, the diff and the reply.
   - `ThinkingNode` is the footer: a hollow ring, italic "Thinking…", and a
     clock from its own mount. A tap opens the live thought.
5. `TranscriptRow.tsx`:
   - `RowProps.step` (cell, open, full, reduceMotion, onToggle, onShowAll).
   - `StepShell`: no vertical padding, 6 pt at each end of a run.
   - `ToolRowView` draws a `StepNode`, and the artifact card keeps its band
     row.
   - `ReasoningRowView` draws `null` when `hidden`, else a Thought node.
   - Both views have no `useState`. I removed `OUTPUT_PREVIEW_LINES`.
   - The testIDs are unchanged: `tool-<id>-<status>` on the name, plus
     `-output`, `-reply`, `-progress`, `-activity` and `diff-<id>`.
6. `SessionScreen.tsx`:
   - `layout = useMemo(() => stepLayout(rows, running, isBlockRow), [rows, running])`.
   - `openSteps`/`fullSteps` live in the screen (`useState<readonly string[]>`)
     and go into `rowExtraData` together with `layout`.
   - `renderItem` returns `null` for a hidden cell **before** `SwipeTime`.
     Otherwise it passes `step={…}`, and the toggle calls
     `animateNextLayout(a11yFlags.reduceMotion)`.
   - `ListFooterComponent` is a `ThinkingNode` when `layout.tail` is set.
7. Deleted `ui/ToolRow.tsx` (it had no other importer).
8. `e2e/flows/08-permission.yaml`: the step is tapped before
   `assertVisible diff-<id>` (see drift).

**Mutation checks (§9):** each was applied by
`.tentacle/tmp/mobile-tool-rows/mutate.ts`, which runs the 3 narrow files and
then restores the file byte-for-byte. All 7 were killed:
- M5, the hidden cell is not returned `null` → 1 fail (`renderItem reads the row's cell, and a hidden cell is null BEFORE SwipeTime wraps it`).
- M6, `tappable` ignores the diff → 1 fail (`a diff alone makes the step tappable`).
- M7, `stepLayout` ignores `isBlock` → 3 fail (the three isBlock layout cases).
- M8, `live` ignores a missing `at` → 1 fail (`running: a spinner, and a live clock only when…`).
- M9, `liveElapsed` rounds instead of flooring → 1 fail (`liveElapsed … nothing under a second…`).
- M10, a `useState` back in `ToolRowView` → 1 fail (`no open/show-all state inside the tool or reasoning view`).
- M11, the footer is not wired to `layout.tail` → 1 fail (`the footer is the live tail…`).

**Drift from Implementation (and why):**
- **`isBlock` predicate + `isBlockRow`** (not in the plan). A valid chart
  (`chartRowSpec`) and a presented artifact draw as blocks, not steps. As
  nodes, they would leave a neighbour's thread segment dangling into a chart
  or card. They now end the run like assistant text does. A thought before a
  block becomes a Thought node and is not folded into it. Pinned by 5 cases.
- **`stepRowView` and friends are new pure functions.** The plan lists S2 as
  drawing only. But the tappable rule, the `⎿` join, the live clock rule and
  the footer label are branching logic, and AGENTS §7 puts that in a pure
  module. So `StepNode` only maps values.
- **`layout` is in `rowExtraData` too**, not only the open state. A reasoning
  row turns `hidden` when a tool follows it while the row object itself stays
  the same, so its cell must re-render.
- **Flow 08 taps the step before asserting `diff-<id>`.** The diff now lives
  in the open body (Owner Q7), so the old always-visible assertion would fail.
  I changed only that flow. No other flow asserts a body testID without a
  tap (grep).
- **Artifact branch.** The card row no longer draws a reply, diff or output
  under it. A presented artifact is set only on success, so none of them
  applies. It keeps the progress line and the Activity link.
- **Reasoning text is plain italic text in the body, no longer `Markdown`**
  (the design says "italic 13.5 sans").
- The changelog fragment from S1 already describes what S2 draws, so it is
  unchanged.

**Not verified here (S3's job):** anything on screen. That covers the
simulator half of the load-bearing check, the look against mockup C in
light, dark and AX, VoiceOver, the spinner, and no jump while streaming. The
e2e flow 08 edit has not been run.

**Gate:** `bunx tsc --noEmit` (root) clean. `tsc -p apps/mobile` gives 6
errors, all pre-existing and environmental. They are in untouched files that
import modules not installed in this worktree: `expo-document-picker`,
`react-native-webview` (×2, plus 2 TS7006 that follow from it) and
`react-native-svg`. No error is in an S2 file. `bun run lint` is clean (1953
files). `bun test`: **14201 pass, 5 skip, 0 fail** (1013 files). The skips
are the same 5 as in S1. No schema is touched, so there is no
`protocol.json` regeneration and no `protocol.d/` note.

### Fix round 1 (S2)

*— claude-opus-5-5, 2026-11-17* — addresses Review — S2 (one MEDIUM, a test gap). Only a test changed; no `src` change.

- **Finding 1 (MEDIUM): FIXED.** There are two new source pins in `apps/mobile/test/tool-rows-wiring.test.ts`:
  - `the footer node gets the tail's thought and its up segment`: `<ThinkingNode` carries `thought={layout.tail.thought}` and `up={layout.tail.up}`.
  - `the layout's cell reaches the node: the folded thought and the thread`:
    - `ToolRowView` passes `cell.thought` into `stepRowView` and derives `thread` from `cell.thread`.
    - `ReasoningRowView` derives `thread` from `cell.thread`.
    - Each view hands `thread={thread}` to both `StepShell` and `StepNode` (exactly 2 sites).
- **Red → green, by mutation** (`.tentacle/tmp/mobile-tool-rows/mutate-r1.ts`: it applies each mutation, runs wiring + step-view + steps, then restores the file byte-for-byte). The same 6 mutations ran against the HEAD test and against the new test:

  | Mutation | HEAD test | new test |
  |---|---|---|
  | F1 `ToolRowView` drops `cell.thought` | 53/0 (survived) | 54/1 |
  | F2 `ReasoningRowView` `cell.thread` → `LONE` | 53/0 | 54/1 |
  | F3 footer `up` → `false` | 53/0 | 54/1 |
  | F4 footer `thought` → `""` | 53/0 | 54/1 |
  | F5 `ToolRowView` `cell.thread` → `LONE` | 53/0 | 54/1 |
  | F6 `ReasoningRowView` node `thread={LONE}` | 53/0 | 54/1 |

  Every fail is on the matching new case's assertion. `git status` after the runs shows only the test file.
- **Gate:**
  - `bunx tsc --noEmit`: clean.
  - `bun run lint`: clean (1953 files).
  - Narrow tests (wiring, step-view, steps, summary): 107/107.
  - `bun test`: **14203 pass, 5 skip, 0 fail** (1013 files). These are the same 5 skips as S1 and S2.
- **Left as is:** the LOW issue (a chart whose `chartLayout` is null falls back to a LONE step) and the S3 simulator checks are out of scope for this round.

### S3 — mock turn, flow 29, screenshots

*— claude-opus-5-5, 2026-11-17* — **S3 only.**

**Load-bearing check (simulator half): the 0 pt half holds; the `scrollToIndex` half was NOT run.**
- `bun install --frozen-lockfile` installed the mobile deps that were missing from this worktree. It left `bun.lock` and `git status` unchanged. After that, `bun run typecheck` is fully clean, `apps/mobile` included: the 6 environmental errors from S2 are gone.
- The real e2e harness ran on iOS 26 (iPhone 17 Pro sim): `bun run e2e:mobile --ios 26 --only 08-permission,29-tool-rows`. Result: **`✓ 08-permission`, `✓ 29-tool-rows`, PASS**.
- **0 pt cell, observed.** In flow 29 the round-2 reasoning row is folded into `Read`, so its cell renders `null`. The gap `Bash ls missing-dir` → `Read` matches every other step gap (~100 px at 3×) in both the collapsed and the open shots. A hidden cell adds no height.
- **Not run: "Show in chat" → `scrollToIndex` past hidden rows.** It needs a sub-agent report below hidden reasoning, and flow 29 has none. To verify: a flow-27 child's report under a `TOOLROWS29` turn, then tap "Show in chat".

**As built:**
1. **Red first.** `apps/mobile/test/e2e-mock-toolrows.test.ts` goes through the real `OpenAIProvider` against a stub `TOOLROWS_PROMPT` export with no handler: **4 fail / 1 pass**, all on assertions. The pass is the "another prompt is untouched" guard.
2. **`apps/mobile/e2e/mock-model.ts`:**
   - `TOOLROWS29` is a three-round turn. The round is picked by `toolResultsThisTurn(body)`: tool results after the LAST user message, so an earlier turn's results do not count.
     - Round 1: reasoning, the text "Checking the workspace first.", then `shell` `seq 1 40 > notes.txt && wc -l notes.txt` (ok) and `shell` `ls missing-dir` (fails).
     - Round 2: reasoning with **no text**, so it folds; then `fs_read {path: notes.txt, offset 1, limit 20}` and `mcp__demo__browser_resize {430×932}`. The registry answers that one with `unknown tool:` and `isError`.
     - Round 3: 4 reasoning chunks spaced by `thinkMs`, then the markdown reply.
   - A new `MockModelOptions.thinkMs` option (default `TOOLROWS_THINK_MS` = 2500 ms) keeps the footer on screen for `_shot`. The unit test uses 5 ms.
   - Result: 5/5.
3. **`apps/mobile/e2e/flows/29-tool-rows.yaml`** (new):
   - Runs on its own session, `TOOLROWS_ID` in `run.ts` (`FLOWS` + `COMPOSE_SESSION_VARS`).
   - Approves the 2 shell asks, waits for `thinking-footer`, and asserts `tool-mocked-.*-ok` / `-error`.
   - Shoots `running`, then waits for `turn-idle` and asserts the footer is gone; shoots `collapsed`.
   - Taps an ok step (`-output` visible): `open`. Taps the error step: `error-open`. Each shot is light + dark.
4. **Changelog:** the existing `changelog.d/mobile-tool-rows.changed.md` now also names the live "Thinking…" node.

**Drift:**
- `thinkMs` is a new option, so the unit suite does not wait 10 s.
- The flow uses regex ids (`tool-mocked-.*`), because the mock mints ids across the whole run.
- No `steps → reply → chart → steps` shot (see below).

**Mutations (§9)** — `.tentacle/tmp/mobile-tool-rows/mutate-s3.ts`. It applies each mutation, runs the toolrows test, then restores the file byte-for-byte. `git status` afterwards showed only the intended files.

| Mutation | Result |
|---|---|
| M1 count every tool result (no `break` at the user) | 4 pass / 1 fail |
| M2 round 1 drops its text line | 4 pass / 1 fail |
| M3 round 2 says a line (no fold) | 4 pass / 1 fail |
| M4 round 2 read unranged | 4 pass / 1 fail |
| M5 round 3 never thinks | 4 pass / 1 fail |

**Visual check: what I compared, and the verdict.** Shots are in the worktree's run dir, `.tentacle/tmp/e2e-mobile/1794896889063/ios26/29-tool-rows/…/takeScreenshot/` (8 PNGs). They were NOT copied into `.tentacle/tmp/mobile-tool-rows/shots/`: the sandbox refused the copy.
- `collapsed-light`, `running-dark` and `open-light` match mockup C's structure:
  - a 1 px thread at the left, joining the 4 steps and the trailing Thought;
  - 7 pt dots, green ok and red error, with a red trailing duration on errors;
  - one line per step: `Bash <cmd>`, `Read notes.txt · 1–20`, `demo · browser_resize 430 × 932`;
  - ∴ on `Read` (the folded thought);
  - no boxes;
  - the first Thought standing ALONE, because text follows it (Q3);
  - the footer `○ Thinking… 3 s` as the thread's last node, and gone at idle;
  - the open body indented under the label: command, then `⎿ exit=0 / 40 notes.txt`.
- **Not done:**
  - the accessibility-extra-large shot;
  - VoiceOver / Accessibility Inspector;
  - a 300-row scroll (no jump while streaming, open state kept);
  - the `steps → reply → chart → steps` shot;
  - a pixel comparison against `.tentacle/mockups/mobile-tool-rows/index.html` (I compared structure only, not exact x or spacing).
  
  These are left for the mandatory fresh-context visual Review.

**Gate:**
- `bunx tsc --noEmit` clean, and `bun run typecheck` (root + mobile + relay) clean.
- `bun run lint` clean (1958 files).
- `bun test`: **14244 pass, 5 skip, 0 fail** (1016 files); the same 5 skips as before.
- No schema touched: no `protocol.json` regen, no `protocol.d/` note.

## Review

*— claude-opus-5-5, 2026-11-17* — **S1 only**, fresh context. This is the same model as the plan author and the S1 executor (Opus), so shared blind spots are possible.

**Verdict: REQUEST-CHANGES.** One MEDIUM finding, about tests only. The S1 code is correct.

**Findings**
1. **MEDIUM: test gap (§9).** `apps/mobile/src/tool-steps.ts:158` limits the tail's `down` to the LAST run (`tailJoins && run === last`). Mutation: drop `run === last` → **0 of 26 tests fail**. Failure scenario: rows `tool A, assistant text, tool B` while thinking. Under the mutation, A also gets `down: true`, so S2 would draw a thread segment that hangs below A into the text, and nothing would catch it. Fix: one `tool-steps.test.ts` case with two runs plus a tail, asserting that the first run's last node has `down: false`.

**Gate (touched files):** `tool-steps` + `tool-summary` tests 74/74 pass · `bun run lint` clean (1792 files) · `bun run typecheck` clean. I did not re-run the full suite.

**Mutations (each reverted, `git status` clean after):**
- Tail `down` on every run → **survived** (finding 1).
- Remove `user` from `isThinking` → 1 fail.
- MCP path shown without basename → 1 fail.
- Read range end off by one → 2 fail.
- Batch thought `batchOpen ? null : thought` → `thought` → survived, but this is **benign**. `pending` is emptied by the first tool, so a later tool in the batch can never receive a thought. `batchOpen` is redundant (a nit), not a gap.

**Attacks tried**
- `fs_read` `path:A:B` against `parsePathRange` (`packages/tools/src/builtins.ts:84-96`): same regex and same clamp. Holds.
- Thinking after a user row or after text: `tailJoins` is false because the last run is empty. Holds.
- Partial or streaming args (`{}`, non-JSON): no crash, no empty name. Holds.
- Odd MCP names: raw label is used. Holds.
- §7 scope: pure, React-free modules; no protocol, persistence or terminal paths touched. Holds.

**Executor behaviour:** honest. The Execution names its drift and the flaky unrelated CLI failure, and lists mutations M1–M4. It missed the over-extension direction of the tail rule.

### Round 2

*— claude-opus-5-5, 2026-11-17* — this round covers only `git diff HEAD~1` (c2182960), which adds one test and no source changes.

**Verdict: PASS.**

- **Finding 1 is fixed.** The new case `the tail extends ONLY the last run` (`apps/mobile/test/tool-steps.test.ts:180`) catches the change. I re-applied the round-1 mutation (drop `run === last` at `tool-steps.ts:158`), and that test now **fails** (1 fail). After reverting, `git status` is clean.
- **No regressions found.** No `src` file changed. The touched tests pass 75/75. `bun run lint` is clean (1792 files) and `bun run typecheck` is clean.
- **Still open, as a nit only:** `batchOpen` is redundant.

### Review — S2

*— claude-opus-5-5, 2026-11-17* — fresh context, **S2 only** (`git diff main...HEAD`, the S2 files). Same model as the executor: shared blind spots are possible.

**Verdict: REQUEST-CHANGES.** One MEDIUM finding (a test gap, §9). No HIGH.

1. **MEDIUM: the cell → StepNode hand-off is untested.** The layout's decisions reach the drawing in three places, and no test catches a break in any of them. Each mutation below was applied, the three narrow files run, then restored (`git status` clean): **0 fail** each time.
   - `TranscriptRow.tsx` ToolRowView: `cell.thought` → `null`. Failure scenario: reasoning → `tool_start`. `stepLayout` hides the reasoning row because it is folded into the tool, but the tool never receives it. There is no ∴ and no thought in the body, so the thought is **silently lost on screen**.
   - ReasoningRowView: `cell.thread` → `LONE`. An orphan Thought between steps breaks the thread.
   - SessionScreen: `up={layout.tail.up}` → `up={false}`. The footer node loses its thread segment.

   Fix: add source pins to `tool-rows-wiring.test.ts` for these three hand-offs (`cell.thought`, `cell.thread`, `layout.tail.up`). Then re-run these mutations and show each one red.

**Gate:** the touched tests (wiring, step-view, steps, summary) give **105 pass / 0 fail**. `bun run lint` is clean (1953 files). `bun run typecheck`: root and relay are clean. `tsc -p apps/mobile` gives 6 errors. All 6 are in untouched files and come from modules missing in this worktree (`expo-document-picker`, `react-native-webview`, `react-native-svg`), matching Execution. I did not re-run the full suite.

**Mutations killed (1 fail each):** `tappable` ignores `denialReply` · `trailingRed` ignores `denied` · no `⎿` on the output · `isBlockRow` ignores artifacts.

**Attacks tried:**
- Flows that assert a body testID without a tap. Only `08` (`diff-`) does, and it now taps first. `08b`/`08c` assert only the label. Holds.
- `null` before `SwipeTime`, and `styles.list` having no `gap` or separator (so a hidden cell adds no spacing). Holds.
- `isBlockRow` vs. `ChartRowView`. When `chartRowSpec` is non-null but `chartLayout` returns null, the row falls back to a LONE step with no thought folded into it. Cosmetic only, LOW.
- §7: logic is in pure modules; no protocol, persistence or terminal path is touched. Holds.

**Still owed (S3):** the simulator half of the load-bearing check (a 0 pt `null` cell, and `scrollToIndex` past hidden rows). The flow-08 edit has not been run.

**Executor behaviour:** honest. The drift is named, and the 7 mutations it lists are real. It missed the cell → node seams above.

### Round 2

*— claude-opus-5-5, 2026-11-17* — covers only `git diff HEAD~1` (8c0b17bb). That commit adds 2 wiring tests and changes no source file.

**Verdict: PASS.**

- **S2 #1 is fixed.** I re-applied the three mutations from round 1. Each now **fails** one test:
  - `cell.thought` → `null`;
  - `cell.thread` → `LONE` in ReasoningRowView;
  - `up={layout.tail.up}` → `up={false}`.
  
  The earlier R1–R4 mutations still fail too. After the mutations, `git status` is clean.
- **No regressions found.** No `src` file changed. The touched tests give 107 pass / 0 fail, and `bun run lint` is clean (1953 files). `bun run typecheck` gives the same 6 errors as round 1. They are the environment-only ones, in untouched files, from modules missing in this worktree. There are no new errors.
- **Still owed by S3:** the simulator half of the load-bearing check, and running flow 08.

## Review

### Review — S3

*— claude-opus-5-5, 2026-11-17*

**Verdict: PASS** (S3 only, scope `git diff main...HEAD`; no HIGH or MEDIUM findings).

- **Gate (re-run):** the touched mobile e2e/mock tests give 97 pass / 0 fail (10 files). `bun run lint` is clean (1958 files). `bun run typecheck` (root + mobile + relay) is clean.
- **Mutation (§9), my own:** round 2's `done < 4` changed to `done < 2` → 4 pass / 1 fail; reverted, and `git status` is clean. This agrees with the executor's M1–M5.
- **Attacks tried:**
  - Testid wiring: `thinking-footer` (`StepNode.tsx:328`), `tool-${id}-output` (`TranscriptRow.tsx:459`), `turn-idle` (`SessionScreen.tsx:1050`) and the `mocked-` prefix (`mock-model.ts:350`) all exist. Holds.
  - Round selection across turns: `toolResultsThisTurn` stops at the last user message, and a test pins it. Holds.
  - The `TOOLROWS29` handler runs before the other prompts' `!followUp` guards, but only on its own prompt word, so the other flows are untouched (the "another prompt" test). Holds.
- **§7:** no protocol, persistence or terminal path is touched; the changes are e2e harness, flow, test and changelog only.
- **LOW (not blocking):** at `29-tool-rows.yaml:85` the second `-output` assert can pass vacuously if the first step failed to close, because the regex then matches the still-open ok body.
- **Not re-done by me:** the simulator run and the visual items the Execution lists as not done (AX-XL shot, VoiceOver, 300-row scroll, `steps → reply → chart → steps`, the `scrollToIndex` half). They are still owed before merge, as the plan's mandatory visual check.
- **Executor behaviour:** honest. The Execution lists every gap and drift explicitly, and its claims matched the code.
