# feat/tui-tool-expand — Click a tool call to expand its command

> **Status:** context · implementation · execution · review · done
> **Branch:** `feat/tui-tool-expand` (stacked on `feat/tui-tool-blink`)
> **Type: feat · Size: M · Blast: contained · Suited: DeepSeek executes, Opus reviews (stacked on tui-tool-blink)**
> **Owner decision:** 2026-10-30 — the design below is fixed; do not change it.

## Context

*— deepseek-v4.1-flash, 2026-10-30*

A tool call with long arguments is cut in the transcript. The subtitle (a
`shell` command, a path, an `fs_multi_edit` target…) is always truncated to a
fixed 72 characters — `truncate(subtitle, 72)` in `toolLines`
(`packages/tui/src/render-lines.ts:499`, the helper at `:69`) — regardless of the
terminal width and regardless of Ctrl+O (`expandAll`, `App.tsx:377`). The only
way to see the full command is `/help`-level guessing: the `args` JSON is not
reachable from the UI at all. On a 160-column terminal the header row is 84
columns wide and the command is still cut, so ~70 columns of usable space sit
idle while the one thing the user needs (what was actually run) is hidden.

There is also no way to ask for detail on ONE call: Ctrl+O is all-or-nothing and
also expands every tool BODY (the output preview), which is not what someone
looking at a single long command wants.

**Repro** (`.tentacle/tmp/tui-tool-expand/repro.ts` — scratch, gitignored per
AGENTS §6; pasted in full because the file does not survive):

```ts
// Repro for docs/feat/tui-tool-expand.md (AGENTS §1, §6).
// A long Bash command is cut at a fixed 72 chars even on a 160-column terminal,
// and a click on the tool header row does nothing.
import { createElement as h } from "../../../packages/tui/node_modules/react/index.js";
import { render } from "../../../packages/tui/node_modules/ink-testing-library/build/index.js";
import { App } from "../../../packages/tui/src/App.tsx";

const COMMAND =
  "cd . && go test ./internal/ui -run TestZZWebGapDeadBranches -count=1 -v -timeout 120s 2>&1 | tail -50";
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const createSession = () => ({
  async *send() {
    yield {
      type: "tool_start" as const,
      id: "c1",
      name: "shell",
      arguments: JSON.stringify({ command: COMMAND }),
    };
    await delay(20);
    yield {
      type: "tool_result" as const,
      id: "c1",
      name: "shell",
      result: { content: "ok", isError: false },
      durationMs: 1700,
    };
    yield { type: "turn_end" as const, reason: "end_turn" as const };
  },
});

const app = render(h(App, { createSession, model: "m", cwd: "/tmp/work" }));
// A WIDE terminal: 160 columns (the harness defaults to 100).
Object.defineProperty(app.stdout, "columns", { value: 160, configurable: true });
app.stdout.emit("resize");
await delay(40);
app.stdin.write("go");
await delay(20);
app.stdin.write("\r");
await delay(200);

const rows = (): string[] => (app.lastFrame() ?? "").split("\n").map(strip);
const header = (): string => rows().find((r) => r.includes("Bash")) ?? "";
console.log("=== columns:", app.stdout.columns);
console.log(rows().join("\n"));
const h0 = header();
console.log("=== header row (trimmed) ===");
console.log(h0.trimEnd());
console.log("=== header display width:", h0.trimEnd().length, "of", app.stdout.columns);
console.log("=== full command present?", rows().join("\n").includes(COMMAND));

// A left click (press + release on the same cell) on the header row.
const y = rows().findIndex((r) => r.includes("Bash")) + 1;
const before = rows().join("\n");
app.stdin.write(`\u001B[<0;3;${y}M`);
app.stdin.write(`\u001B[<0;3;${y}m`);
await delay(80);
const after = rows().join("\n");
console.log("=== after a click at col 3, row", y, "(header row) ===");
console.log(rows().join("\n"));
console.log("=== click changed the frame?", before !== after);
console.log("=== full command present after the click?", after.includes(COMMAND));
app.unmount();
```

Observed (`bun run repro.ts`, 2026-10-30, on top of the blink work):

```
=== columns: 160
⏺ Tentacle ready. Type a task, or /help for commands.

› go

⏺ Bash cd . && go test ./internal/ui -run TestZZWebGapDeadBranches -count=1 -v… 1.7s
⎿ ok
…
=== header row (trimmed) ===
⏺ Bash cd . && go test ./internal/ui -run TestZZWebGapDeadBranches -count=1 -v… 1.7s
=== header display width: 84 of 160
=== full command present? false
=== after a click at col 3, row 5 (header row) ===
⏺ Bash cd . && go test ./internal/ui -run TestZZWebGapDeadBranches -count=1 -v… 1.7s
⎿ ok
…
=== click changed the frame? false
=== full command present after the click? false
```

Same script with `app.stdin.write("\u000F")` (Ctrl+O) after the turn: the status
bar flips to `expanded` but the header row is byte-identical — `… 1.7s`, full
command still absent:

```
⏺ Bash cd . && go test ./internal/ui -run TestZZWebGapDeadBranches -count=1 -v… 1.7s
=== header display width: 84 of 160
=== full command present? false
```

Three facts, measured: (a) the cut is fixed at 72 chars, not width-derived (84
of 160 columns used); (b) Ctrl+O does not show the command; (c) a left click on
a tool header row changes nothing.

**Constraint.** The blink work just landed on top of this file and is the same
edit surface (`toolLines`, `rowCache`, the mouse path). This task must not
disturb it: a running call must still blink, with no width shift, expanded or
not.

## Implementation

*— deepseek-v4.1-flash, 2026-10-30*

### Load-bearing assumption

**A tool call's final rows, as `layoutTranscript` produces them, are
addressable by content, not only by position — so "which tool id is under screen
row y" can be answered from the id-carrying layout without a side table that a
cache hit could leave stale.**

Cited: `layoutTranscript` (`packages/tui/src/render-lines.ts:758`) walks `items`
and pushes exactly one `LaidItem` (`:736-739`: `{ rows, start }`) per non-empty
item, in `items` order, and nothing else writes rows — `sliceLaid` (`:784`)
reads the same array. If the tool id is carried ON the `LaidItem` (one added
field, set from the item it was built for), then a screen row `absRow` maps to a
tool id by finding the `LaidItem` whose `[start, start + rows.length)` contains
`absRow`, and "the header row of that call" is `start < absRow`-free: it is
`row index 0` of that item's rows. No second index, no cache coupling, no
staleness.

The second half of the assumption: **the click addressee is `absRow`, which the
mouse path already computes** — `visibleIndex = r.y - 1`, `row = win.start +
visibleIndex` (`App.tsx:2189-2190`) with `win = windowFor(total, viewport,
scrollOffset)` (`:744`). So the scroll offset and viewport windowing are already
in the coordinate the hit-test takes; the risk is only that a hit-test written
against `r.y` instead of `absRow` silently ignores both.

### Preconditions

Verified in the source before designing:

1. **The transcript viewport starts at screen row 1.** The transcript `<Box
   height={viewport}>` is the first child of the root column box
   (`App.tsx:2343-2344`), and the mouse path already uses `r.y - 1` as the
   viewport-relative row (`App.tsx:2189`).
2. **Mouse reports are already parsed and dispatched one by one.** `mouse.ts`
   splits a coalesced chunk into `MouseReport[]` and holds a half-delivered
   prefix (`mouse.ts:41-53`); `App.tsx:2210-2221` loops `dispatchMouse(r)` over
   them. `MouseReport` carries `{btn,x,y,press}` (`mouse.ts:12-21`), where bit
   `32` in `btn` is motion/drag and `btn & 3 === 0` is the left button
   (`App.tsx:2178,2191`).
3. **A click today is a press+release that starts a zero-length selection.**
   Press → `setSelection({anchor,head})` (`App.tsx:2193-2199`); release →
   `finishSelection` which returns early on `!isNonEmpty(sel)`
   (`App.tsx:1874-1879`, `selection.ts:60`). So a click is already harmless; it
   just does nothing.
4. **Only `tool` items collapse, so only they have two layout slots.**
   `itemRows` computes `expandMatters = item.kind === "tool"` and the slot
   `expandMatters && expand ? "expanded" : "collapsed"` —
   `render-lines.ts:697-701`; the `RowCacheEntry` holds `collapsed?` and
   `expanded?` (`:656-663`) and is keyed on `width`/`threshold`/`preview`
   (`:703-712`).
5. **The blink swap is post-wrap and content-independent.** `withPhase`
   (`render-lines.ts:724-731`) swaps the FIRST `⏺` of row 0
   (`offPhaseRows`, `:673-685`) on an already-wrapped cached array, and both
   glyphs are 2 columns (`blink.ts:23,26`). Any layout this task adds must keep
   the header as row 0 and must not put `⏺` before it.
6. **The bulk-row-1 wrapping is centralised.** `wrapLines`
   (`render-lines.ts:574`) is what folds every logical line — `expandTabs`, then
   `fitsUnchanged` fast path, then `wrapAnsi(..., {hard:true,trim:false,
   wordWrap:true})`, then `carryColor`. A new multi-row block must go through
   `wrapLines` (so TAB and truecolour carry-over behave) and must pre-split on
   `\n` / `\r\n` itself, because `wrapAnsi` rewrites `\r\n` (`wrapLines`'s
   `fitsUnchanged` even excludes any text containing them).
7. **AGENTS §7 "logic lives in pure modules"** — `mouse.ts`, `selection.ts`,
   `scroll.ts`, `input-view.ts`, `blink.ts` are the pattern; `App.tsx` is known
   debt but new decisions go to a pure module with its own test file.
8. **Nothing persists selection/expansion state today**: `/clear` and a
   `/sessions` switch reset `stateRef` + `setExpandAll(false)`
   (`App.tsx:1292-1295`), so per-call expansion is render state only — no
   on-disk format is touched (blast radius stays `contained`).

### Design

Five parts, each in the layer that owns the decision.

**(a) `tool-expand.ts` (new, pure): click-vs-drag + the toggle + the cut.**

- `type ClickPhase = "press" | "drag" | "release"` and
  `nextClickState(state, report) → { state, click: {x,y} | null }`. A click is:
  a **press** on the left button without the motion bit arms it; anything with
  the motion bit (`btn & 32`) — or a press at another cell — disarms it; a
  **release** at exactly the armed cell, with no drag in between, yields
  `click`. A coalesced press+release in one chunk works because the App feeds the
  reports in order, so the state machine sees press then release. A wheel report
  (`btn & 64`) is not a left-button event and neither arms nor yields.
- `toggleExpanded(set, id) → new Set` — immutable add/remove.
- `isExpanded(set, id)`.
- `fitSubtitle(subtitle, budget) → string` — the collapsed-on-one-row cut: cut
  with an ellipsis only when the subtitle does not fit `budget` **display
  columns** (`string-width`, not `.length` — the owner's point 4), and never
  cut in the middle of nothing (`budget ≤ 0` → `""`).

**(b) `tool-hit.ts` (new, pure): which tool call is under screen row y.**

- `toolCallAt(laid, absRow) → { id, header } | null`, where `laid` is
  `readonly LaidItem[]` — `LaidItem` gains ONE field, `id: string` (the
  `DisplayItem.id`; `""` for items that have none, i.e. non-tool items — the
  `DisplayItem` union has `id` only on `ToolItem`, `state.ts:63`). The function
  finds the `LaidItem` covering `absRow`; if that item is not a tool (`id ===
  ""`) → null; if `absRow !== start` (a wrapped continuation row or a body row)
  → expand/collapse that call's BODY-view? No: the owner says the header ROW is
  the target ("a left click on a tool call's **header row**") and a
  **continuation row** must be a failure mode, not a target — a click on a
  continuation row is part of the command text, i.e. selectable text. So:
  `header = absRow === item.start`, and the toggle happens only when `header`;
  elsewhere → null (nothing new; the click may still be a zero-length selection,
  as today).
  Reusing `absRow` means the scroll offset and windowing are honoured by
  construction; the pure module takes no `r.y`.

**(c) `render-lines.ts`: the header cut + the continuation block.**

- `toolLines` computes the header in two halves so the cut can be measured:
  `bullet + " " + bold(label)` is the fixed prefix, `elapsed` the fixed suffix,
  and the subtitle gets
  `budget = width - stringWidth(prefix) - stringWidth(elapsed) - 1` (the leading
  space before the subtitle). Collapsed → `fitSubtitle(subtitle, budget)` on the
  SAME row, as today (no wrap; `wrapLines` sees a row that already fits).
  Expanded (`expandAll` OR the id in `expandedIds`) → the header WITHOUT the
  subtitle (`fitSubtitle` not called), followed by the full subtitle wrapped to
  the width and prefixed `  │ ` (4 columns, `string-width`-verified) on
  continuation rows, then the body as today (the body keeps its `⎿`/indent
  connector; the toggle changes only the header + command block, per the
  owner's point 1).
- `RenderOptions` gains `readonly expandedIds?: readonly string[]` (a sorted
  array, so it is a cheap, stable cache key — `itemRows` compares it element-wise
  and only for `tool` items). The `RowCacheEntry` gains a third slot key, so a
  toggle of call A never invalidates call B: the key is
  `(collapsed | expandedAll | expanded:<id>)`.
- `LaidItem` gains `id`.

**(d) `App.tsx`: wiring only.**

- `const [expandedIds, setExpandedIds] = useState<readonly string[]>([])`
  (sorted, from `toggleExpanded`), cleared in `swapSession` beside
  `setExpandAll(false)`.
- Pass `expandedIds` into both `layoutTranscript` calls (render + `layoutOptsRef`
  for the resize warm) and into `startIdleWarm` (so the idle warm covers what is
  shown).
- In `dispatchMouse`: run the click state machine FIRST for left-button
  reports; on a `click`, `toolCallAt(layout.laid, win.start + (r.y - 1))`; if it
  returns a header hit, toggle that id and **do not** touch the selection (the
  press half must not have armed a selection either — so the press is
  classified before `setSelection` runs, and a press that may become a click
  still arms the selection so a DRAG from it still selects: the drag branch
  replaces the anchor-preserving head exactly as today, and the release checks
  "was this a click?" first, clearing the zero-length selection it finds).
  Priority: the `panel` branch (`App.tsx:2175-2182`) stays ABOVE this, so a click
  on an open list panel keeps its meaning.
- Ctrl+O already flips `expandAll` (`App.tsx:2122-2124`) and now also shows every
  command, for free.

**(e) Per-item re-layout (owner point 6).**

The toggle changes `expandedIds`; `layoutTranscript` walks items and `itemRows`
returns the cached array for every item whose key did not change. The test pins
that exactly: with `spyOn(markdown, "renderMarkdown")` at 0 and `formatDurationMs`
counting one call per freshly laid-out tool, toggling one call re-lays-out only
that call (identity `toBe` on the other items' arrays).

### Files

In dependency order (all under `packages/tui/`; no protocol/daemon change — this
is pure presentation state):

1. `src/tool-expand.ts` — new: click state machine, `toggleExpanded`,
   `fitSubtitle`.
2. `src/tool-hit.ts` — new: `toolCallAt` over `LaidItem[]`.
3. `src/render-lines.ts` — `RenderOptions.expandedIds`, `LaidItem.id`,
   `RowCacheEntry` slot key, `toolLines` header/continuation block.
4. `src/App.tsx` — state, layout wiring, mouse dispatch, `swapSession` reset.
5. `test/tool-expand.test.ts`, `test/tool-hit.test.ts` — new unit tests.
6. `test/render-lines.test.ts` — the collapsed cut by width, the expanded
   layout, the per-item cache key.
7. `test/app.test.tsx` — frame-level: click expands/collapses, drag still
   selects, scrolled-up click hits the right call, Ctrl+O shows the command,
   blink still works expanded.
8. `TODO.md` — one line beside the blink entry.

### Failure modes

- **Click while scrolled up.** The hit-test takes `win.start + (r.y - 1)`, so
  the reported call is the one under the cursor, not the one at the tail. Pinned
  by a test that scrolls up (`WHEEL_UP`/PageUp), clicks a header, and asserts the
  call nearest the *viewport* expanded while a same-`r.y` click at offset 0
  would have hit another one.
- **Click on a wrapped continuation row.** `absRow !== item.start` → no toggle
  (the text is selectable, not a control). Pinned.
- **Click on a running call.** Works the same; the header stays row 0 and the
  blink swap still only replaces that row's first `⏺`, so the expanded running
  call blinks with no width shift (both glyphs 2 columns). Pinned by a
  frame-level test over both phases.
- **Press on a tool row, then drag away.** The motion bit disarms the click and
  the drag extends the selection as today; on release the selection is copied.
  Pinned (the clipboard fake receives the dragged text; nothing toggles).
- **Coalesced press+release in one chunk.** `splitMouseReports` yields both
  reports and the App feeds them in order, so the state machine still sees
  press→release at one cell. Pinned with a single `stdin.write` of
  `\e[<0;3;5M\e[<0;3;5m`.
- **Terminal resize while expanded.** The resize/warm path passes the same
  `expandedIds` (the `onResize` warm, `layoutOptsRef`, `startIdleWarm`), so the
  warm fills the slot the next render needs; a width change drops every slot per
  item and rewraps on the new width, keeping the call expanded. Pinned at the
  layout level and at frame level. (Amended during Execution: the plan named
  only `layoutOptsRef` + `startIdleWarm`, but the `onResize` effect builds its
  OWN options literal — that literal is the one that had to gain the set.)
- **A tool with empty args.** `subtitle === ""` → no continuation rows at all
  (headless header), and `fitSubtitle("", n) === ""`. Pinned.
- **Session resume / `/clear`.** Ids come from the daemon (`state.ts:270`,
  `resume.ts:42`) and are stable per call; `expandedIds` is keyed by them, so it
  survives re-renders and new messages. `/clear` and a session switch drop it
  with the transcript (`swapSession`). A resumed transcript keeps no expansion
  (it is not persisted) — deliberate: a resurrected session must not come back
  with rows in a state the user cannot see the cause of.
- **Silent drop.** A click that hits neither a header nor text does nothing —
  but it is indistinguishable from "already collapsed", so the header is always
  the same row and no state can desync: the toggle is idempotent per click.

### Tests

Red first (§9), all of them failing on the current code for the ASSERTED
property, not for a missing import:

| Test | Pins |
| --- | --- |
| `tool-expand.test.ts` press→release at one cell = click | the classification |
| `tool-expand.test.ts` press→motion→release = no click | drag is never a click |
| `tool-expand.test.ts` press+release at DIFFERENT cells = no click | a smeared click |
| `tool-expand.test.ts` coalesced chunk (both reports in order) = click | the chunk case |
| `tool-expand.test.ts` wheel does not arm/yield a click | no accidental toggle on scroll |
| `tool-expand.test.ts` toggle add/remove, immutable | the expanded set |
| `tool-expand.test.ts` `fitSubtitle` measures DISPLAY width (CJK/emoji) | `string-width`, not `.length` |
| `tool-hit.test.ts` header row of the 2nd call → that id | the addressing |
| `tool-hit.test.ts` continuation / body / blank-separator rows → null | not a target |
| `tool-hit.test.ts` offset window: same `y`, different `win.start` → different id | the scroll offset is honoured |
| `render-lines.test.ts` collapsed cut uses the full width, and at 160 the long command is not cut at 72 | the owner's point 4 |
| `render-lines.test.ts` expanded block: header without subtitle, then `  │ …` rows | the layout |
| `render-lines.test.ts` Ctrl+O shows the command too | point 3 |
| `render-lines.test.ts` toggling one call re-lays-out only it | point 6 |
| `render-lines.test.ts` expanded + running: same row count ON/OFF, row 0 differs only in the glyph | point 7 |
| `app.test.tsx` click on a real frame expands that call; a second click collapses | end-to-end |
| `app.test.tsx` drag from a tool row copies text and does not toggle | end-to-end |
| `app.test.tsx` Ctrl+O shows the command | end-to-end |
| `app.test.tsx` a resize while expanded keeps it expanded, re-wrapped | end-to-end |
| `render-lines.test.ts` the resize/idle warm carries `expandedIds` | point 6 |

## Execution

*— deepseek-v4.1-flash, 2026-10-30*

### Red first

The new unit tests were written before the modules existed — that is a compile
error, which §9 forbids as "red". So the RED evidence is taken from the frame
level (the real observable) plus assertion-level reds on the existing modules:

1. `repro.ts` (above) on the pre-change tree: `full command present? false`,
   `header display width: 84 of 160`, `click changed the frame? false`, and the
   same with Ctrl+O. That is the feat's capability being absent — a frame
   capture, not a compile error.
2. `app.test.tsx` new tests pasted into the pre-change tree and run: red on the
   assertion (`expect(frame).toContain(COMMAND)` fails; `click changed the
   frame` fails), as recorded below verbatim.
3. `render-lines.test.ts` red on the fixed cut:
   `expect(strip(itemLines(long, { expandAll: false, width: 160 })[0])).toContain(COMMAND)`
   fails on the pre-change tree because of `truncate(subtitle, 72)`.

(paste of the red runs: see the block at the end of this section)

### Red on the pre-change tree (verbatim)

The pre-change `render-lines.ts` and `App.tsx` were restored from the snapshot
commit `5b9f2dd` (which holds the blink work only) with `git show > file` — NOT
`git checkout`/`restore` (forbidden by the task rules) — and the new tests run
against them. The backup `shasum` was recorded before, and is identical after
the restore:

```
aa4d276a65702d3eefe6839a555b8d45332637a7  packages/tui/src/render-lines.ts
0088eb1fe3919940a68df11ab975a160a2676518  packages/tui/src/App.tsx
  (… restored from the backup → the same two shasums)
```

`bun test packages/tui/test/render-lines.test.ts packages/tui/test/app.test.tsx`
on that tree — **141 pass, 17 fail**; every failure is on the ASSERTED property:

```
(fail) clicking a tool call expands its command > the whole command is on the header row at 160 columns (was cut at 72)
(fail) clicking a tool call expands its command > a click on the header row expands that call; a second click collapses it
(fail) clicking a tool call expands its command > a click only toggles ONE call, and its expansion survives new messages
(fail) clicking a tool call expands its command > a coalesced press+release in ONE chunk is still a click
(fail) clicking a tool call expands its command > a click on a wrapped continuation row does not collapse the call
(fail) clicking a tool call expands its command > a click while scrolled up toggles the call under the CURSOR, not the tail
(fail) clicking a tool call expands its command > Ctrl+O shows the full command too
(fail) clicking a tool call expands its command > an expanded RUNNING call still blinks, and no row moves
(fail) itemLines > renders a sub-agent's nested activity tree and its report
(fail) a tool call's command: width-derived cut, and per-call expansion > at 160 columns the whole command sits on the header row (no fixed 72 cut)
(fail) … > a narrow terminal still cuts it, with an ellipsis, and one row
(fail) … > a multi-line command collapses to ONE header row
(fail) … > expanding ONE call shows its command wrapped under the header (mockup)
(fail) … > Ctrl+O (expandAll) shows the full command of every call too (point 3)
(fail) … > an expanded call's multiline command keeps every line, indented
(fail) … > toggling one call re-lays-out only that item (point 6)
(fail) … > a width change re-wraps an expanded call at the new width
 141 pass
 17 fail
```

The two most load-bearing assertion-level reds, verbatim:

```
# the fixed 72-char cut
Expected to contain: "cd . && go test ./internal/ui -run TestZZWebGapDeadBranches -count=1 -v -timeout 120s 2>&1 | tail -50"
Received: "⏺ Bash cd . && go test ./internal/ui -run TestZZWebGapDeadBranches -count=1 -v… 1.7s"
  at packages/tui/test/render-lines.test.ts:1002:21

# a click does nothing
2548 |     await delay(80);
2549 |     const expanded = frame();
2553 |     expect(cont(expanded)).toHaveLength(1);
error: expect(received).toHaveLength(expected)
Expected length: 1
Received length: 0
  at packages/tui/test/app.test.tsx:2553:28

# Ctrl+O still cuts
2708 |     expect(cont(frame()).length).toBeGreaterThan(0);
error: expect(received).toBeGreaterThan(expected)
Expected: > 0
Received: 0
  at packages/tui/test/app.test.tsx:2708:34

# one call only (nothing expanded at all on the old code)
2585 |     expect(cont(frame()).join(" ")).toContain("cmdB");
error: expect(received).toContain(expected)
Expected to contain: "cmdB"
Received: ""
  at packages/tui/test/app.test.tsx:2585:37
```

`tool-expand.test.ts` and `tool-hit.test.ts` could not be red on that tree in any
honest way (the modules did not exist: a compile error, which §9 forbids as red).
Their non-vacuity is instead established by the mutations below, each of which
reds them or their frame-level counterpart on the FINAL tree.

### As built

Order actually followed (all under `packages/tui/`):

1. **`src/tool-expand.ts` (new, 122 lines)** — `nextClick(state, report)`, the
   click recogniser: arms on a bare left press, disarms on any motion (`btn & 32`)
   or a press at another cell, and yields a click on a release at the armed cell.
   Wheel reports (`btn & 64`) and non-left buttons are excluded before the motion
   test (a wheel report can carry the motion bit). Also `toggleExpanded` (sorted
   immutable array), `isExpanded`, and `fitSubtitle(subtitle, budget)` — the
   collapsed cut, measured with `string-width` per code point, tabs expanded and
   newlines flattened first.
2. **`src/tool-hit.ts` (new, 53 lines)** — `toolCallAt(laid, absRow)`: a binary
   search over `LaidItem.start`, then the item's id ONLY when
   `absRow === item.start` (the header is row 0 of a tool item). Non-tool items
   carry `id: ""`, so they answer null.
3. **`src/render-lines.ts`** — `RenderOptions.expandedIds`; `LaidItem.id`;
   `RowCacheEntry.command` as a THIRD slot with the slot chosen by
   `collapsed | expanded (Ctrl+O) | command (this call clicked)`; `toolLines`
   builds the header from `head + fitSubtitle + elapsed` with
   `budget = cols - (2 + 1 + labelWidth) - elapsedWidth - 1`, and appends a
   `commandRows` block (`  │ ` prefix, per-line `wrapLines` at
   `cols - 4`) when the call is expanded. The old `truncate` helper was deleted
   (its only caller was the fixed cut).
4. **`src/App.tsx`** — `expandedIds` state + `clickRef`; `expandedIds` threaded
   into the render layout, `layoutOptsRef` (resize warm) and `startIdleWarm`;
   reset in `swapSession`; the mouse dispatch feeds `nextClick` FIRST (after the
   wheel and open-panel branches, which keep their priority) and on a click
   resolves `toolCallAt(layout.laid, win.start + (y - 1))`, clearing the
   zero-length selection and toggling the id.
5. **Tests** — `test/tool-expand.test.ts` (15), `test/tool-hit.test.ts` (6),
   13 new in `test/render-lines.test.ts`, 11 new in `test/app.test.tsx`.

As-built symbols (line numbers on the shipped tree, for Review):

| Symbol | Where |
| --- | --- |
| `nextClick` / `isExpanded` / `toggleExpanded` / `fitSubtitle` | `tool-expand.ts:55, 76, 85, 98` |
| `toolCallAt` | `tool-hit.ts:31` |
| `RenderOptions.expandedIds` | `render-lines.ts:54` |
| `COMMAND_PREFIX` / `commandRows` | `render-lines.ts:67, 509` |
| `RowCacheEntry.command` (3rd slot) | `render-lines.ts:706` |
| `LaidItem.id` | `render-lines.ts:796` |
| `expandedIds` / `clickRef` state | `App.tsx:390-391` |
| the hit-test's absolute row | `App.tsx:2214` |

### Drift from the Implementation (and why)

1. **Two tests of the blink work had to be re-pinned; one existing helper
   filtered.** The cut is now width-derived, so a long command legitimately
   changes which rows it occupies:
   - `render-lines.test.ts` "at width 79 a long command's rows do not move
     between phases" used `rows.length > 2` as its non-vacuity guard. With the
     command fitting more of a wide row, the count dropped to 2 while the
     command is still wrapped. The guard now proves the ROW 0 content (the
     command's tail is not on it) — the property the test is about — and the
     ON/OFF comparison itself is unchanged and still passes.
   - `itemLines > sub-agent` asserted `Agent find bug` on the header. An expanded
     call's header carries label + elapsed only (owner mockup), so the
     description is now the first `  │ ` row: `Agent` + `  │ find bug` (the label
     is `Agent`). Re-pinned to the new, intended layout.
   - `read-highlight.test.ts` and the spilled-body helper in
     `render-lines.test.ts` indexed the body at `itemLines(...).slice(1)`, which
     is the HEADER's successor — now the command block under Ctrl+O. They skip
     `  │ ` rows before indexing. No assertion was weakened; the helpers only
     stop counting a new kind of row as a body row.
2. **The scroll-up click test needed a resize AFTER the effects subscribe.**
   `app.stdout.emit("resize")` immediately after `render()` was a no-op: the App
   subscribes in an effect. The test helpers now wait, then resize. (Test-only;
   the same latent trap exists in the blink test at `app.test.tsx:2329`, left
   alone — it does not need a specific width.)
3. **Two-call test commands are prefixed `cmdA` / `cmdB`.** At 40 columns the
   header keeps the command's START, so a suffix (`| one`) is not visible in the
   cut header and the row lookup failed. The prefix makes each call's header row
   identifiable at any width; nothing about the feature changed.
4. **No `wrapLines`-level block for the command.** `commandRows` wraps each
   command LINE itself (`wrapLines([line], cols - 4)`) because the `  │ `
   prefix must repeat on every row, which a single `wrapLines` call over a
   multi-line string cannot do. `wrapLines` is still the wrap (TAB expansion,
   `fitsUnchanged`, `carryColor`), so no behaviour is duplicated.
5. **The plan's `toolCallAt` returned `{ id, header }`; it returns `string |
   null`.** The header test IS the null test, so the object added nothing.
6. **`expandedIds` is not cleared when a new call starts** (it is keyed by id,
   as the owner asked). It IS cleared on `/clear` and on a session switch, with
   the transcript.
7. **ONE real defect found after the first gate run, fixed:** the resize warm
   (`App.tsx`, in the `onResize` effect) built its own options literal, which
   did not include `expandedIds` — nor did its dependency list. A width change
   while a call was expanded therefore warmed the COLLAPSED slot, so the
   committing render had to re-lay-out the clicked call itself (exactly the
   freeze that warm exists to prevent). Both are fixed: the literal carries the
   set and the effect depends on it. The claim written here was that it was
   "pinned by" `render-lines.test.ts "the idle/resize WARM must warm the
   expanded-command view too"` and by `app.test.tsx "a terminal RESIZE while
   expanded keeps the call expanded at the new width"`. Review finding 2 showed
   that is **false** for the App's literal: the first builds its own options
   and never reads the App's, and the second passes because the committing
   render re-lays-out the clicked call anyway (both stay useful — they pin the
   `warmRowsChunk` contract and the frame — they just do not pin this line).
   Fix round 1 adds the pin: `app.test.tsx "the resize warm lays the clicked
   call out ONCE: the commit render is a cache hit"` counts the layouts of the
   clicked call through `formatDurationMs` — 1 with the set, 2 without it.

### Gate

`bun run check` (typecheck → lint → test), on the final tree — **green**:

```
$ bun run typecheck && bun run lint && bun run test
$ tsc --noEmit && tsc -p apps/mobile
$ biome check .
Checked 561 files in 161ms. No fixes applied.
$ bun test
bun test v1.4.3 (c6da4a4d3)

 3554 pass
 3 skip
 0 fail
 12984 expect() calls
Ran 3557 tests across 262 files. [135.32s]
```

The 3 skips are the opt-in ones AGENTS §6 lists (live-k8s, live-docker, the
real-socket keepalive). Lint: 0 errors, 0 warnings. `bunx biome check --write`
was applied to the 9 touched files. This run is on the FINAL tree (after the
resize-warm fix, the blink cache comment and the last formatting pass).

### Mutations (non-vacuity, §9)

Each mutation was applied to a tree identical in SEMANTICS to the shipped one
(the mutation round ran before the final comment/format pass, so the files'
`shasum`s differ by comments and formatting only — the diff was inspected), run,
and reverted by `cp` from a backup under
`.tentacle/tmp/tui-tool-expand/mutations2/`; every restore's `shasum` matched
the recorded one byte for byte:

```
ca85335e8b8cdd500b388d26d3739b3e206ab83b  packages/tui/src/tool-expand.ts
d194551f6bbcd201b862b3ce0e31a7794b0cbca9  packages/tui/src/tool-hit.ts
2e7a5819003324e0ae10c75294d6b07e752aefb5  packages/tui/src/render-lines.ts  (pre-comment pass; now 0239909b…)
41c8a9d43e027803a1b941b133412dfcbd6b1de4  packages/tui/src/App.tsx          (pre-comment pass; now 23211fa3…)
```

| # | Mutation | Result | Restored |
| --- | --- | --- | --- |
| 1 | a drag also completes a click (`tool-expand.ts`: the motion branch arms the cell instead of disarming) | 2 fail: `a press, MOTION, then a release is a drag, never a click`; `a drag from a tool row still selects text and does NOT toggle` | `ca85335e…` ✔ |
| 2 | the hit-test ignores the scroll offset (`App.tsx`: `row = y - 1` instead of `win.start + y - 1`) | 2 fail: `a click while scrolled up toggles the call under the CURSOR, not the tail`; `a click only toggles ONE call…` | `41c8a9d4…` ✔ |
| 3 | the collapsed cut stays at a fixed 72 (`fitSubtitle(subtitle, 72)`) | 3 fail: `at 160 columns the whole command sits on the header row`; `…at 160 columns (was cut at 72)`; `a narrow terminal still cuts it` | `2e7a5819…` ✔ |
| 4 | the per-item cache key ignores `expandedIds` (a clicked call always uses the `collapsed` slot) | 3 fail: `expanding ONE call shows its command…`; `toggling one call re-lays-out only that item`; `a width change re-wraps an expanded call` | `2e7a5819…` ✔ |

Mutation 3 is the width-derived cut; mutation 4 is the per-item re-layout
(owner points 4 and 6). Mutation 2 is the scroll-offset half of the hit-test
(owner point 5a) — the multi-row half is pinned by `tool-hit.test.ts`'s
"continuation row and a body row are NOT controls" (a call spans >2 rows in that
fixture, asserted, so the null assertions are not vacuous).

### Not verified

- **How it looks in a real terminal** (xterm/iTerm): every frame here comes from
  ink-testing-library, which strips SGR. The `  │ ` prefix is asserted as plain
  text and the colours as SGR bytes elsewhere, but the visual contrast of the
  grey prefix against the command has not been seen. Verify with a real
  `bun run <tui>` session on a wide terminal: click a `Bash` header.
- **The click in a terminal whose SGR reports do not include the motion bit for
  drags** (1006 always does; a legacy 1000-only terminal would classify a drag
  as a click). Out of scope: the App already relies on bit 32 for selection.
- **A click on a tool call inside the scrolled-away region.** CORRECTED in fix
  round 1 (Review finding 1): the claim that this "cannot happen (the click is
  on screen by definition)" was **false**. The click is on screen, but the row
  it maps to need not be: with the viewport scrolled up, `win.start + y - 1` for
  a bottom-area row (the prompt rule, the input box, the status bar) lands on a
  real transcript row below `win.end` — an off-screen tool header, which used to
  toggle. The bound now lives in `tool-hit.ts` (`toolCallAtViewport`, which
  refuses any screen row outside `[0, window height)`) and is pinned at frame
  level by `app.test.tsx` "a click BELOW the viewport, scrolled up, toggles
  nothing" plus unit tests in `tool-hit.test.ts` (including one that shows the
  buffer really does hold a header below the window, so the bound, not the
  fixture, is what refuses it).


## Review

*— claude-opus-5-5, 2026-10-30*

Reviewer: claude-opus-5-5, fresh context, a different model family from the
executor (DeepSeek). Scratch: `.tentacle/tmp/tui-tool-blink/rev/`
(`attack.test.ts`, `width.test.ts`, `select.test.ts`, `mut.sh`, `run1.sh`;
gitignored).

**Verdict: REQUEST-CHANGES → FIX.** The feature works, and the owner spec holds
on every path I drove except one: a click **below the transcript viewport**
while scrolled up toggles a call the user cannot see. The fix is a one-line
guard plus a test. Everything else is LOW.

### Findings

1. **MEDIUM: a click below the viewport, while scrolled up, toggles a hidden
   call.** At `App.tsx:2211-2214`, the click branch computes
   `row = win.start + (y - 1)` with **no** viewport bound. The press path right
   below it guards `visibleIndex < visible.length` (`:2232`). When scrolled up,
   `win.start + viewport…` are real transcript rows under the window. So a
   click on the prompt rule, the input or the status bar (`y > viewport`) lands
   on an off-screen tool header, and that header toggles. The same happens on a
   list panel's non-body rows, which fall through to this branch. Repro
   (`rev/attack.test.ts`): 40 pad lines and 12 calls. I scrolled up 6 notches,
   clicked rows 20–23 (the rule, the prompt, the status bar), then scrolled back
   down:
   ```
   after frame:
   1:   │ cmd6 xxxxxxxx…        ← cmd6 expanded, never on screen when clicked
   2:   │ xxxxxxxx…
   Expected {contAfter: 0}  Received {contAfter: 2}
   ```
   The doc's "Not verified" says this "cannot happen (the click is on screen by
   definition)". That is false: the click is on screen, but the row it maps to
   is not. Fix: bound `step.click.y - 1` to `[0, visible.length)` the way the
   press path does, and pin it with a frame test like the one above.
2. **LOW: the resize-warm fix (Drift 7) is not pinned.** I removed
   `expandedIds` from the `onResize` options literal (`App.tsx:644`): **223/223
   green, the mutation survives.** The Execution says it is "pinned by"
   `render-lines.test.ts` "the idle/resize WARM…" and by the App resize test.
   Neither pins it. The first calls `warmRowsChunk` with options it builds
   itself, so it never reads the App's literal. The second passes because the
   committing render re-lays-out the clicked call anyway. The fix is correct
   (performance only, one item), but the "pinned" claim is false.
3. **LOW: a click under Ctrl+O changes hidden state.** With `expandAll` on,
   `itemRows` always uses the `expanded` slot, so a header click toggles
   `expandedIds` with no visible change. When Ctrl+O goes off, that call is
   unexpectedly expanded (or collapsed). Not in the owner spec. Either ignore
   clicks under `expandAll` or state that it is intended.
4. **LOW: the blink test lost its teeth on this tree.** The 79-column frame test
   of `feat/tui-tool-blink` now has a one-row header (78 columns), so it no
   longer re-wraps. A 3-column `BLANK` leaves it green; other tests catch that
   (see the blink Review, nit 2). The executor re-pinned the matching unit test
   but did not notice that the frame test lost its teeth too.
5. **NIT: `TODO.md`.** The entry is `[x] DONE` before review, and the index line
   has no `Suited:`. On merge, `main` will hold a duplicate of the reducer
   follow-up (blink Review, nit 1). `git merge-tree main d719fe6` reports **no
   textual conflict**.
6. **NIT: the cut works per code point, not per grapheme.** `fitSubtitle` can cut
   inside a ZWJ emoji or a flag pair. The width is never exceeded (measured
   below), but such a cut can leave a broken glyph next to the `…`. Cosmetic.

### Gate and mutations

`bun run check`: typecheck clean, Biome 561 files 0 issues, **3554 pass / 3 skip
/ 0 fail** (3557 tests, 262 files), matching Execution. Test counts match too:
15 + 6 + 13 + 11 new.

Each run covers 6 TUI files (223 tests). Each mutation was `cp`-restored and
`shasum -a 256 -c` 5/5 OK.

| # | Mutation | Result |
|---|---|---|
| 1 | drag arms instead of disarming | 2 red, as claimed |
| 2 | hit-test ignores `win.start` | 2 red, as claimed |
| 3 | fixed 72 cut | 3 red, as claimed |
| 4 | clicked call uses the `collapsed` slot | 11 red (doc: 3; my substitution touches every slot read, the doc's was likely narrower). Killed either way |
| M1 (mine) | `toolCallAt` returns the id for ANY row of the item | 5 red |
| M2 (mine) | resize warm without `expandedIds` | **survived** → finding 2 |

### Premise table

| Premise | Result |
|---|---|
| Repro: fixed 72 cut, 84 of 160 columns used, a click does nothing | TRUE (the 160-column test is red under mutation 3) |
| `render-lines.ts:69/499` `truncate(…,72)`; `App.tsx:377`, `:744`, `:2189-2190`, `:1292-1295`; `selection.ts:60`; `render-lines.ts:697-701`, `:736-739`, `:758`, `:784`; `state.ts:63`; `resume.ts:42` (on `5b9f2dd`) | TRUE |
| `mouse.ts:41-53` "holds a half-delivered prefix" | Partly: the holding is App-side (`holdMouse`). Harmless |
| `App.tsx:2343-2344` "the transcript Box is the first child" | Those lines are the selection map inside it. Close enough; the coordinate is the selection's, which works |
| "A click in the scrolled-away region cannot happen" (Not verified) | **FALSE**, finding 1 |
| "The resize-warm fix is pinned" | **FALSE**, finding 2 |

### Attacks tried

- **Scrolled up, viewport windowed**: a click on a visible header hits the right
  call (mutation 2 red). A click **below** the window: finding 1.
- **Continuation row**: no toggle (M1 red on the frame test).
- **Coalesced press+release in one `write`**: a click. Holds.
- **Press on a header, then drag away**: selects and does not toggle (mutation 1
  red).
- **Resize while expanded**: it stays expanded and re-wraps. Every layout entry
  point (`layoutTranscript` in the render, the `onResize` warm,
  `layoutOptsRef` → the history `warmRowsChunk`, `startIdleWarm` → the other
  view keeps `expandedIds`) carries the set. Only the pin is missing (finding 2).
- **Widths 20–160** × CJK, emoji, ZWJ, flags, combining marks, tabs, multi-line
  and empty commands × running/ok × collapsed/clicked/Ctrl+O: **no row exceeds
  the width**, and the collapsed header is one row at every width ≥ 30. A
  running call's ON/OFF rows have the same count, and every row but 0 is
  identical. **Composes with blink.**
- **Empty args**: the header has no subtitle and a click changes nothing
  visible. Holds.
- **A click during a selection**: by reading, the press still replaces the old
  selection exactly as before, then the header click sets `null` where the old
  code left a zero-length one, so the screen is the same. A non-header click
  takes the unchanged path. Inverse SGR is not observable in this harness, so
  this was not driven.
- **Raw terminal writes**: none (`process.std*`/`console.` absent from the diff
  and the new modules).
- **List panel priority**: the panel branch is still above the click branch,
  but see finding 1 for the panel's non-body rows.

### What holds

The pure split is right: `tool-expand.ts` and `tool-hit.ts` are framework-free
and tested, and the App only wires them. The per-item re-layout is real (an
identity test, and mutation 4 is red). The width-derived cut uses `string-width`.
Ctrl+O shows every command. The existing tests it re-pinned are not weakened:
the changed blink guard still has teeth in the unit test, and the
`read-highlight` helpers only skip the new `  │ ` rows.

### How the executing model behaved

**Grade B.** Strong points: its red evidence came from a real pre-change tree,
every mutation reproduced, the counts and the gate are true, and it found and
fixed its own resize-warm defect. Weak points: twice it wrote "cannot happen" or
"pinned" without running the case. One is a real MEDIUM bug (finding 1). The
other is a test that pins a correlated property, not the change (finding 2).
This is the §2/§9 weak-correlate pattern seen in earlier rounds, less severe this
time.

## Execution — fix round 1

*— deepseek-v4.1-flash, 2026-10-30*

Every finding of the Review is addressed. Item 6 (the grapheme cut) is a NIT
with no code change asked for and none made — see "Not done" at the end.

### 1. MEDIUM — a click below the viewport, scrolled up, toggled a hidden call

**What changed.** The bound lives in the pure hit-test module, not inline in the
App (AGENTS §7):

- `packages/tui/src/tool-hit.ts:74` — new `toolCallAtViewport(laid, visible, y)`:
  it takes the SGR report's 1-based screen row and the transcript window
  (`scroll.ts: windowFor`), returns null for any row outside
  `[0, visible.end - visible.start)` — the prompt rule, the input box, the
  status bar, or anything above the viewport — and otherwise delegates to
  `toolCallAt(laid, visible.start + screenRow)`. Its doc comment names the bug
  (`tool-hit.ts:16-23`).
- `packages/tui/src/App.tsx:2217` — the click branch now calls only
  `toolCallAtViewport(layout.laid, win, step.click.y)`; the App does no row
  arithmetic. The old `win.start + (y - 1)` and its raw `toolCallAt` call are
  gone.

**Red first.** Test: `app.test.tsx:2752` "a click BELOW the viewport, scrolled
up, toggles nothing (review finding 1)" — the review's setup (40 pad lines, 12
long-command calls), one notch of wheel-up at a time, then a press+release on
**every** row from the first rule to the status bar, then a wheel burst back to
the tail. It also asserts non-vacuity at the end: a click on a **visible** header
still expands, so the assertions are about the bound and not about clicks having
stopped working.

Red on the code as the Review found it (`toolCallAt(laid, win.start + y - 1)`,
i.e. mutation M1 below), extracted:

```
2788 |       await delay(250);
2789 |       expect({ notches, conts: cont(frame()).length }).toEqual({ notches, conts: 0 });
                                                              ^
@@ -1,3 +1,3 @@
  {
-   "conts": 0,
+   "conts": 2,
    "notches": 1,
(fail) … > a click BELOW the viewport, scrolled up, toggles nothing (review finding 1)
 0 pass / 1 fail
```

Green after the change (same test, same tree as the gate below): 1 pass.
`tool-hit.test.ts:106-…` adds four unit tests for the same rule, including
`:126` "a row past the window's end is refused even when the BUFFER has a header
there", which first proves the unbounded lookup **does** find a call on that row
(`expect(toolCallAt(laid, …)).toBe("c2")`) and then that the bounded one refuses
it — so the bound, not the fixture, is what answers null.

**Mutations (both `cp`-restored, `shasum -a 256 -c` OK):**

| # | Mutation | Result |
|---|---|---|
| M1 | `App.tsx:2217` back to `toolCallAt(laid, win.start + (y - 1))` — the review's original line | 1 red (the frame test above); 105 pass |
| M1b | drop the bound **inside** `tool-hit.ts` (`toolCallAtViewport` loses its range check) | 2 red: the frame test **and** `tool-hit.test.ts` "a row past the window's end…"; 104 pass |

M1b is the one that shows the guard is not merely relocated: with the App still
calling `toolCallAtViewport`, emptying that function's check brings the bug back.

**The false note is corrected.** The "Not verified" bullet claimed a click in
the scrolled-away region "cannot happen (the click is on screen by definition)".
That was wrong in the way the Review says — the *click* is on screen, the *row
it maps to* is not. The bullet is rewritten (see "Not verified" above) with the
correction, the cause, and where the fix and its tests live.

### 2. LOW — the resize-warm fix (Drift 7) was not pinned

**What changed.** `packages/tui/src/App.tsx:644` is correct as it stands
(`const opts = { …, expandedIds }`) — only the pin was missing. New test
`app.test.tsx:2837` "the resize warm lays the clicked call out ONCE: the commit
render is a cache hit (review finding 2)": click the call, then count the
`toolLines` layouts of that call through `formatDurationMs` (which `toolLines`
calls once per tool-item layout) across a width change. With the set in the
literal: **1** (the warm's, for the slot the commit asks for). Without it: **2**
(the warm's *collapsed* slot, then the commit's command slot — the freeze the
warm exists to avoid). Non-vacuity: the same test asserts the command really
re-wrapped (`cont(frame()).length > 1`) at 60 columns.

**Red on the mutant** (`cp` backup, `python3` edit, restore, `shasum -c` OK):

```
2861 |       // makes it 2 (the warm's collapsed view, then the commit's command view).
2862 |       expect(spy.mock.calls.length).toBe(1);
                                           ^
Expected: 1
Received: 2
(fail) … > the resize warm lays the clicked call out ONCE: the commit render is a cache hit (review finding 2)
 0 pass / 1 fail
```

Green with the line restored: 1 pass. This is why the two tests the Execution
originally cited could not have pinned it: `render-lines.test.ts` "the idle/
resize WARM…" builds its own options and never reads the App's literal, and the
frame resize test passes because the committing render re-lays-out the call
anyway. Drift 7's paragraph (above) now says so, and names the new pin.

### 3. LOW — a click under Ctrl+O changed hidden per-call state

**Behaviour picked.** The Review offered two options and no preference between
them: "either ignore clicks under `expandAll` or state that it is intended". This
round **ignores** them — under Ctrl+O every call's command already shows, so a
header click has nothing to reveal, and silently recording a toggle is the
"hidden state" the finding is about. `App.tsx:2217`:
`const id = expandAll ? null : toolCallAtViewport(…)`, with the reason in the
comment above it (`App.tsx:2212-2216`).

**Test:** `app.test.tsx:2810` "a click while Ctrl+O is on changes no hidden
per-call state (review finding 3)": Ctrl+O on, click the header, Ctrl+O off →
still collapsed (`cont(frame())` is empty); then non-vacuity: a real click with
Ctrl+O off does expand it.

**Red on the mutant** (drop `expandAll ? null :`, `cp`-restored, `shasum -c`
OK):

```
2827 |     // It is still COLLAPSED: the click under Ctrl+O recorded nothing.
2828 |     expect(cont(frame())).toHaveLength(0);
                                 ^
Expected length: 0
Received length: 1
(fail) … > a click while Ctrl+O is on changes no hidden per-call state (review finding 3)
 0 pass / 1 fail
```

Green: 1 pass.

### 4. LOW (blink nit 2) — the 79-column frame test lost its teeth

**What changed.** `app.test.tsx:2295` — the command is now 85 columns
(`… > out.txt && echo finished`), so at 79 columns its fitted header is cut to
71 columns of room plus the `…` and fills the row **exactly** (measured: 79, in
both phases); the test asserts that number for every phase
(`expect(new Set(views.map((v) => v.width))).toEqual(new Set([79]))`). Any OFF
glyph that is not 2 columns now moves that number (78 or 80). I also added a
reply row **below** the tool (`AFTER-TOOL marker line.`) and moved `replyRow`
onto it, so the "nothing below the call moved" half does not depend on the
running line's spinner row.

**Mutations (`cp`-restored, `shasum -a 256 -c` OK):**

| # | Mutation | Result |
|---|---|---|
| M4 | OFF glyph `"   "` (3 columns) | 2 red: this test **and** "the label never moves column"; 94 pass |
| M5 | OFF glyph `" "` (1 column) | 2 red: the same two; 94 pass |
| M4′ | M4 **plus** this test exactly as the Review found it (78-column command, `replyRow` on the running line, no width assertion) | **1 pass — blind**, which is the Review's nit reproduced |

M4′ is the control: the fixture I am repairing is green under the very mutant
the fixed one catches. Both halves of the fix matter — the width assertion is
the teeth, and it only bites because the 85-column command makes the header fill
the row exactly (a shorter command leaves a column of slack, which is what made
the old fixture blind). `render-lines.ts` is back to
`first.replace(BULLET, BLANK)`; sha256 `5c5c2038…`, unchanged from before this
round.

### 5. NIT — `TODO.md`

- Removed the duplicate reducer follow-up ("Settle a dead tool call in the
  reducer"): `main` already carries it as "TUI: close a turn's still-running tool
  calls when the turn fails" (`git show main:TODO.md`, `TODO.md:530`). The
  expand entry now points at that one instead of restating it.
- Both new entries carry `Suited:` (they did not).
- I did **not** un-tick `[x] DONE`: the branch is not merged, but changing the
  tick is the owner's call at merge, and the Review only noted it. Say so if the
  owner wants it flipped.

### Not done

- **NIT 6 (the cut is per code point, not per grapheme).** No code change asked
  (the Review calls it cosmetic) and none made: `fitSubtitle` still walks code
  points, so a ZWJ emoji or a flag pair can be cut next to the `…`. The width is
  never exceeded (the Review measured it). Left as-is.
- **NIT 5's un-tick** — see above.

### Gate

`bun run check` (typecheck → lint → test) on the final tree, after
`bunx biome check --write` on the four touched files:

```
$ bun run check
$ tsc --noEmit && tsc -p apps/mobile
$ biome check .
Checked 561 files in 166ms. No fixes applied.
$ bun test
 3561 pass
 3 skip
 0 fail
 13014 expect() calls
Ran 3564 tests across 262 files. [139.54s]
```

Before this round the same gate read 3554 pass / 3 skip / 0 fail; the 7 new
tests are this round's (4 in `tool-hit.test.ts`, 3 in `app.test.tsx`). Lint: 0
errors, 0 warnings (561 files). The 3 skips are the opt-in ones of AGENTS §6.
Narrow runs first, as §4 asks: `tool-hit` + `tool-expand` + `render-lines`
92/92, then `app` + `blink` 111/111.

Every mutation above was applied to the real sources, run against the real
tests, and reverted with `cp` + `shasum -a 256 -c`: 7 mutations (M1, M1b, M2,
M3, M4, M4′, M5). Each restore checks 4 files (`App.tsx`, `render-lines.ts`,
`tool-hit.ts`, `app.test.tsx`) and all 4 were OK on every check. No claim here
is from reading alone.

One honest note on process: while swapping backups on a case-INSENSITIVE
filesystem, a scratch `cp` of the test file briefly landed on `src/App.tsx` (the
backup names differed only in case). It was caught immediately by the `shasum`
check, restored from the verified backup, and **every** mutation above plus the
final `bun run check` were then re-run from scratch on the restored tree — the
counts and outputs here are from those clean runs, not the tainted ones.

## Review — fix round 1

*— claude-opus-5-5, 2026-10-30*

Reviewer: claude-opus-5-5, in a fresh context. This is a different model family
from the executor (DeepSeek-V4.1-Flash). It is the same model that wrote the
round-1 Review, so shared blind spots with that pass are possible. The diff
reviewed is `git diff d719fe6 c3b452c`. The working tree was byte-identical to
`c3b452c` before and after this review. Scratch is in
`.tentacle/tmp/tui-tool-expand/r2/` (`edge.test.ts`, `e2e.test.ts`, `sums`,
`gate.log`).

**Verdict: APPROVE-WITH-NITS → MERGE** (blink + expand together). Every round-1
finding is fixed and pinned. One new LOW finding remains, a test gap only. The
code is correct.

### Findings

1. **LOW (a test gap, not a bug): the exact boundary row is not pinned.** I
   mutated `tool-hit.ts:80` from `>=` to `>`. That lets through the first row
   below the viewport (the prompt rule). **No in-repo test fails (106/106
   green).** The test at `tool-hit.test.ts:126` lands its "below" row more than
   one row past `end`. The frame test at `app.test.tsx:2752` clicks the rule
   row, but at those scroll offsets that row is never a header. My scratch
   `edge.test.ts` puts a header exactly at `win.end` and clicks
   `y = end - start + 1`. It is green on the code and red under the mutant. So
   the code is right, and only the pin is weaker than claimed. A one-assertion
   follow-up would close it. It does not block the merge.
2. **NIT 6 (the cut walks code points, not graphemes): not done, which is
   acceptable.** The width is never exceeded, so the only visible effect is a
   possible broken ZWJ/flag glyph next to the `…`. That is cosmetic and was
   declared openly in "Not done". It would be worth a `TODO.md` line so it is
   not lost. This is optional.

### Each round-1 finding re-checked

| # | Claim | Verified |
|---|---|---|
| 1 MEDIUM | The click is bounded to the viewport (`tool-hit.ts:74`, `App.tsx:2217`) | **Holds.** The bound is `visible.end - visible.start`, the same one as the press path's `visible.length` (`App.tsx:2233`). Mutating it to a lower bound only (MC) turns 2 tests red: `app.test.tsx:2752` and `tool-hit.test.ts:126`. My own e2e (`e2e.test.ts`) runs the batch from the prompt: settled turn → **resize to 70 cols** → **`/mcp` list panel open** → wheel-up 1–6 notches → a press+release on every row from the panel's top border to the status bar (24 clicks) → Esc → walk the whole transcript. It ends with 0 expanded calls (green). Under the unbounded mutant it is red, with 7 continuation rows. The top edge (`y = 1`) is a visible row. A row at `y ≤ 0` cannot come from SGR, and it is refused anyway. |
| 2 LOW | The resize-warm `expandedIds` is pinned | **Holds.** I removed `expandedIds` from **only** line 644. That turned 1 test red (`app.test.tsx:2837`, `Expected: 1 Received: 2`), with 95 pass. I `cp`-restored, and `shasum -a 256 -c` gave OK. (A first, broader `sed` also hit `:747` and was discarded.) |
| 3 LOW | A Ctrl+O click is a no-op, and that is tested | **Holds.** I dropped `expandAll ? null :`, which turned 1 test red (`app.test.tsx:2810`). The test has a non-vacuity tail: a real click with Ctrl+O off does expand. |
| 4 LOW | The 79-column blink frame test has teeth again | **Holds.** An OFF glyph of 3 columns turned `app.test.tsx:2295` red, and so did one of 1 column. `render-lines.ts` sha256 is `5c5c2038…`, as claimed. |
| 5 NIT | `TODO.md` | **Holds.** There is no duplicate: `git merge-tree` of `main` shows only `main`'s `:530` entry ("close a turn's still-running tool calls…"). `Suited:` is present on both entries. Leaving `[x] DONE` unflipped is fine (the owner's call). |

Every cited `file:line` in the fix-round Execution matches: `tool-hit.ts:74`,
`App.tsx:2217`, `app.test.tsx:2752/2810/2837/2295`, `tool-hit.test.ts:126`.

### Gate

`bun run check`: typecheck clean, Biome 561 files with no fixes, **3561 pass /
3 skip / 0 fail** (3564 tests, 262 files). This matches the Execution exactly.

### Merge prediction into current `main`

`git merge-tree --write-tree main c3b452c` (merge base `0e7cd54`; `main` has
`feat/tui-run-chunked`) reports **2 conflicting files, 4 hunks**. `TODO.md`
auto-merges.

- `App.tsx` ~76, imports: take the union, i.e. the multi-line
  `render-lines.ts` import (with `type RenderOptions`) **plus** `main`'s
  `import { runChunked } from "./run-chunked.ts"`.
- `App.tsx` ~653, the resize warm: keep **`main`'s `runChunked(...)` body**
  (drop the branch's `setTimeout` step loop), and add `expandedIds` (plus its
  comment) to `opts`. Without it, `app.test.tsx:2837` goes red, so this is
  self-checking.
- `App.tsx` ~776, the idle warm: keep `main`'s two-argument `startIdleWarm(...,
  { onError })` and add `expandedIds` to `opts`.
- `app.test.tsx` ~23: keep both sides, `main`'s `turn-feed` import and the
  branch's `stripAnsi`/`clock` declarations.

After resolving, re-run `app.test.tsx` and the full gate. `runChunked` is
time-budgeted, not 6-items-per-tick, so the blink tests (fake timers) and the
resize-count test must be re-checked on the merged tree. I predict they stay
green, because the count is per item layout and not per chunk, but this is not
verified.

### Attacks tried

- The previous scenario, plus an open list panel, plus a resize, from the edge
  rows: nothing expands (e2e green). The unbounded mutant is red.
- The off-by-one boundary: the mutant survives the suite → finding 1. The code
  is right (my `edge.test.ts`).
- A stale `win` after a resize: `win`/`layout` are recomputed every render, and
  the handler reads the current ones. Covered by the e2e.
- The Ctrl+O hidden state, the resize warm, and the blink glyph width: all
  killed (table above).

### How the executing model behaved (fix round)

**Grade A−.** It fixed every finding at the right layer: the bound went into the
pure `tool-hit.ts`, not inline in the App (AGENTS §7). It showed red first for
each one, and it added a control mutation (M4′) proving that the old fixture was
blind. Its counts, line citations and hashes are all true, and it corrected its
own false "cannot happen" note honestly. The one weakness: it called the bound
"pinned" without testing the exact boundary row (finding 1). That is the §9
"prove the exact property" pattern again, in a much milder form than round 1. It
was also transparent about what it left undone (NIT 6, the un-tick).
