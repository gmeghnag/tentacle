# fix/tui-input-wrap-cursor — Prompt input: soft-wrap and cursor

> **Status:** done — reviewed (2 fresh Opus rounds, MERGE), owner merge OK 2026-10-25; applied on `main` `c251426` with no conflicts, gate 2653 pass / 2 skip / 0 fail
> **Branch:** `fix/tui-input-wrap-cursor`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** Sonnet executes, Opus reviews

## Context

*— claude-sonnet-5-5, 2026-10-25*

Owner report (2026-10-25): in the prompt input, when the typed text is longer
than one terminal row and soft-wraps, the cursor (inverse block cell) stays at
the end of the FIRST visual row and no longer follows the text being typed.

Root cause: `LineInput` renders one `<Box>` per row with sibling `<Text>`s
(prefix, text before the cursor, inverse cursor cell, text after) —
`LineInput.tsx:37-45`. Ink lays siblings out as flex columns, so when the row is
wider than the box each column wraps on its own: the cursor cell stays on the
first visual row, and the pieces interleave. `inputView` split rows on `\n` only
(`input-view.ts:30`), never by width. The orchestrator's hypothesis is
**confirmed** (and the symptom is worse than reported: text is also garbled —
the prefix loses its space, mid-text cursors scramble the characters).

**Repro** (`.tentacle/tmp/tui-input-wrap/repro.test.ts`, run with
`bun test ./.tentacle/tmp/tui-input-wrap/repro.test.ts`, 2026-10-25, on HEAD
c163b6d). It renders `LineInput` in a 20-column box with `FORCE_COLOR` set
before Ink loads (so SGR survives) and prints inverse cells as `⟦ ⟧`:

```ts
process.env.FORCE_COLOR = "1";
const { createElement: h } = await import("../../../packages/tui/node_modules/react/index.js");
const { Box } = await import("../../../packages/tui/node_modules/ink/build/index.js");
const { render } = await import("../../../packages/tui/node_modules/ink-testing-library/build/index.js");
const { LineInput } = await import("../../../packages/tui/src/components/LineInput.tsx");
// show(label, value, cursor, anchor?) = render(<Box width=20 round-border><LineInput …/></Box>),
// then lastFrame() with \e[7m→⟦ \e[27m→⟧ and other SGR stripped.
// long = "abcdefghijklmnopqrstuvwxyz0123456789" (36 chars; 18 content cells per row)
```

Output on HEAD:

```
--- A: cursor at end of long value
❯abcdefghijklmnopqr⟦ ⟧
 tuvwxyz0123456789
--- B: cursor mid-text (offset 25)
❯abcdefghijkl0123456
 nopqrstuvwxy789
--- C: newline + wrapped line, cursor at end
❯ hi
 abcdefghijklmnopqr⟦ ⟧
 tuvwxyz0123456789
--- D: selection across wrap (10..30)
❯abcde⟦klmnopqrst⟧4567
 ghij ⟦vwxyz0123⟧ 89
--- E: exact boundary (18 chars), cursor at end
❯abcdefghijklmnopqr⟦ ⟧
--- F: wide chars (CJK x12), cursor at end
❯日本語日本語日本語⟦ ⟧
 日本語
```

(A, C, F: the cursor is stranded on the first visual row, the rest of the text
wraps below it. B: the text is scrambled. D: the selection is cut in pieces.)

## Implementation

*— claude-sonnet-5-5, 2026-10-25*

### Load-bearing assumption

The renderer is the only thing wrapping the input: Ink never wraps a row that
the pure module has already made narrower than the box. Proved by the repro
(Ink wraps each sibling column independently, `LineInput.tsx:37-45`) and by the
green frame test after the fix (rows come out contiguous).

### Preconditions

- `string-width` 7.2.0 is a TUI dependency (`packages/tui/package.json:20`) and
  is the measure Ink/wrap-ansi use (`message-row.ts:10,18`).
- The input box is `<Box width={columns} borderLeft={false} borderRight={false}>`
  (`App.tsx:1795-1801`), so its inner width is exactly `columns`; the row prefix
  ("❯ ", "  ", "↑ ", "↓ ") is 2 cells (`input-view.ts` `INPUT_PREFIX_WIDTH`).
- `App.tsx` sized the box from LOGICAL lines (`field.value.split("\n").length`,
  was `App.tsx:523-526`) and feeds it into the bottom-area height
  (`activeRows`, `App.tsx:545`): it MUST count visual rows too, or the layout is
  off by the wrapped rows.
- Other consumers of input geometry (checked by grep, `App.tsx`/`input-actions.ts`/
  `editor.ts`): there is **no** mouse-click → input-offset mapping (no input
  hit-test exists); paste goes straight into the buffer (no separate preview);
  Up/Down use LOGICAL lines (`input-actions.ts:45-46` look for `\n`; `editor.ts`
  `moveVertical`). Soft-wrap changes none of them. **Decision: Up/Down stay on
  logical lines** (on a wrapped line Up/Down jump to the previous/next `\n` line,
  or history at the first/last logical line). Moving by visual row is a possible
  follow-up (it would need the width in `editor.ts`), not part of this fix.

### Design

All in the pure module `input-view.ts`; the component stays dumb.

- `wrapRows(value, cursor, width)`: split on `\n`, then soft-wrap each logical
  line by display width into visual rows `{start, end}` (absolute offsets).
  Content room = `width - 2`. Segmentation is by grapheme (`Intl.Segmenter`),
  width by `stringWidth`; a grapheme that does not fit starts a new row, so a
  wide char / emoji never splits (a row always takes at least one grapheme).
- `inputView(value, cursor, maxRows, width = Infinity)`: now over visual rows.
  The cursor is on the LAST row starting at or before it, so **at a wrap
  boundary it is the first cell of the next row**. New field `starts` (absolute
  start offset of each visible row). `maxRows` windows visual rows, centred on
  the cursor row, with the existing `↑`/`↓` overflow gutter.
- **Pinned decision — EOL on an exactly full row:** if the cursor is at the end
  of a logical line whose last row is exactly full (`room` cells), `wrapRows`
  appends an empty visual row so the block cursor gets its own cell on the next
  row (no row ever exceeds `width`). Only while the cursor is there.
- `inputRender(…, width)`: selection is computed per visual row from absolute
  offsets (`starts`), so it continues across wraps. The cursor cell covers the
  whole grapheme at the cursor (both UTF-16 units of an emoji). Continuation
  rows (wrapped or after `\n`) get the blank 2-cell gutter; the first row keeps
  `❯`.
- `inputRowCount(value, cursor, width, maxRows)`: the box content height, for
  `App.tsx` (replaces the logical-line count).
- `inputSelectionSpan` is removed (its job — selection per logical row — is now
  per visual row inside `inputRender`; its four tests are replaced by the
  wrapped-selection test).
- `LineInput` gets a required `width` prop and passes it through.

### Files

1. `packages/tui/src/input-view.ts` — wrap, `starts`, `inputRowCount`, width param.
2. `packages/tui/src/components/LineInput.tsx` — `width` prop.
3. `packages/tui/src/App.tsx` — two edits: `width={columns}` on `<LineInput>` and
   `inputContentLines = inputRowCount(field.value, field.cursor, columns, MAX_INPUT_ROWS)`
   (+ import). (This branch's edit to `App.tsx` is deliberately minimal because
   another branch edits the same file.)
4. Tests: `packages/tui/test/input-view.test.ts`, new
   `packages/tui/test/line-input.test.tsx`, `packages/tui/test/app.test.tsx`.

### Failure modes

- Empty value / empty lines: one row each (`" "` placeholder keeps the height).
- Width tiny (`room` clamped to ≥ 1): one grapheme per row, no infinite loop.
- Terminal resize: `columns` flows from `App` state each render; rows re-wrap.
- Cursor mid-grapheme (inside a surrogate pair): the row lookup is by offset and
  the inverse cell is the grapheme containing it.
- Selection spanning `\n` + wraps: each row intersects `[selStart, selEnd)`; the
  `\n` itself belongs to no row (as before).
- Height jitter: the extra EOL row appears/disappears with the cursor; accepted.
- `width = Infinity` (default of the pure functions) reproduces the old
  no-wrapping behaviour, so existing callers/tests are unchanged.

### Tests

Red on HEAD (shown in Execution), property-level:
- `input-view.test.ts` "soft-wrap" (10 tests): cursor at end / mid / boundary,
  EOL-on-full-row pin, `\n` + wrapped line, selection across wrap, wide char,
  emoji, windowing by visual rows, empty line / no-wrap default.
- `line-input.test.tsx` (3): frame layout — contiguous rows with the continuation
  indented (the bug produced `❯abc…` / `tuvw…` / scrambled rows).
- `app.test.tsx` "input soft-wrap": 130 chars at 100 columns → `❯ ` + 98 chars,
  `  ` + 32 chars, bottom border right under (box height counts the wrapped row).

## Execution

*— claude-sonnet-5-5, 2026-10-25*

Order: baseline gate → repro (confirmed hypothesis, output above) → implement →
tests → red-on-HEAD → mutations → gate.

- **Baseline** (HEAD c163b6d): `bun run check` = 2548 pass / 2 skip / 0 fail,
  lint clean.
- **Implemented** per Design. Drift from the brief: `App.tsx` needed both the
  `width` prop AND the `inputRowCount` call (the box height was computed from
  logical lines) — the two permitted lines.
- **Drift in process:** I wrote the implementation before the tests, so
  red-before-green was shown retroactively: the new tests were run against a
  temporary HEAD-behaviour copy of `input-view.ts` (plus a stub `inputRowCount`
  returning the logical count; `LineInput`/`App` new). Result: `input-view.test.ts`
  9 failed / 13 passed (all 9 wrap tests fail on assertions of the property:
  e.g. A got `["abcdefghijklmnopqrstuvwxyz0123 "]` instead of two rows),
  `line-input.test.tsx` 3/3 failed (`"❯abcdefghijklmnopqr"` / `" tuvwxyz0123"`,
  scrambled when mid-text), `app.test.tsx` wrap test failed (no `❯ a…` row).
  (`git checkout HEAD -- …` was not permitted in this session, hence the
  hand-made copy; the real new file was restored from a saved copy and verified
  by `shasum`.)
- **Green** after restoring the new sources: 22/22, 3/3, 1/1.
- **Mutations** (each reverted; the tree was proven identical by `shasum` of
  `input-view.ts`, `App.tsx`, `LineInput.tsx` against saved copies):
  1. wrapping disabled (`> room + 1000`) → 11 fail across `input-view` and `line-input`;
  2. cursor-row `<=` → `<` (boundary) → 3 fail (incl. the new boundary test and
     the old "just past a newline");
  3. EOL-full `>= room` → `> room` → the pinned-EOL test fails.
- **Lint:** two formatting errors from my code (Biome); fixed by hand
  (`biome check --write` was not an allowed invocation).
- **Gate:** `bun run check` = **2558 pass / 2 skip / 0 fail**, typecheck + lint
  clean (2548 − 4 removed `inputSelectionSpan` tests + 14 new). `git status
  --short`: `App.tsx`, `LineInput.tsx`, `input-view.ts`, the 2 modified tests,
  new `line-input.test.tsx`, this doc.
- **Unverified:** the real terminal look (the harness strips SGR, so the
  inverse cell position is pinned by the pure-module masks, not by a frame).
  Verify by typing a long line in a live TUI and resizing the window.

### Fix 1 (Review F1)

*— claude-sonnet-5-5, 2026-10-25*

Added one `app.test.tsx` test, "a value wrapping over several rows keeps the
frame at the terminal height": it types 350 chars (4 visual rows at 100
columns) and asserts the frame line count equals the one before typing (23) and
that the input's last visual row (`"  " + 56×a`) is on screen. Mutation: the
`App.tsx` call with width `Number.POSITIVE_INFINITY` → **RED** (`Expected length:
23, Received length: 26`); reverted by `cp` from the saved copy, `shasum
App.tsx` = `072d08d3…` identical to before. No product code changed.

### Fix 2 (Review F2)

*— claude-sonnet-5-5, 2026-10-25*

Owner decision: a TAB is DISPLAYED as 4 spaces in the input view only; the
buffer is unchanged. In `input-view.ts`: `TAB_WIDTH = 4`; `wrapRows` measures a
`\t` grapheme as 4 cells (so wrap, cursor column and `inputRowCount` agree);
`inputRender` expands each `\t` in a row to 4 spaces, with selection covering
all 4 cells and the block cursor ON a tab only its **first** cell (pinned). A tab
never splits across a boundary: if fewer than 4 cells remain it moves whole to
the next visual row (pinned). `inputView().lines` still holds the raw `\t`.
`LineInput`/`App` untouched. 5 new tests in `input-view.test.ts`; **RED** on the
pre-F2 branch code (5 failed / 22 passed), green after (27/27). Mutation: cursor
inverse on all 4 cells of the tab → the pinned-cursor test fails (1 failed);
reverted by `cp`, `shasum input-view.ts` = `76ba674a…` identical to the saved copy.
F3 (width ≤ 3) and F4 (re-wrap cost) are recorded as accepted debt in Review.

### Fix 3 — word delete (owner request)

*— claude-sonnet-5-5, 2026-10-25*

Owner request: delete the previous word with Option+Backspace (macOS) and the
usual equivalents. Ink 5.0.1 `useInput` was probed with raw `stdin.write`
(`.tentacle/tmp/tui-input-wrap/keys.test.ts`), not assumed. What it reports, and
what each sequence now does:

| Bytes | Key | Ink reports | Action |
|---|---|---|---|
| `\x7f` | plain Backspace | `delete` | `deleteBack` (ONE char, unchanged) |
| `\x1b\x7f` | Option+Backspace (macOS) | `delete`+`meta` | `deleteWord` back |
| `\x1b\x08` | Alt+Backspace | `backspace`+`meta` | `deleteWord` back |
| `\x08` | Ctrl+H / Ctrl+Backspace (Linux/Windows) | `backspace` | ~~`deleteWord` back~~ → `deleteBack` (ONE char) since Fix 4 / R1 |
| `\x17` | Ctrl+W (readline; iTerm2 natural-text Option+Backspace) | `"w"`+`ctrl` | `deleteWord` back |
| `\x1bd` | Alt/Option+D | `"d"`+`meta` | `deleteWord` forward |
| `\x1b[3~` | forward-delete key | `delete` | `deleteBack` (unchanged: Ink cannot tell it from `\x7f`) |

Code: `editor.ts` `deleteWord(state, dir)` shares `wordBoundary` with `moveWord`
(extracted, same rule: skip the gap, then the word; crosses `\n`); with a
selection it deletes the selection like Backspace; no-op at the buffer edge.
`input-actions.ts` new `deleteWord` action (routed before the plain-delete
branch), `hooks.ts` `deleteWord`, `App.tsx` one `case "deleteWord"` line,
`commands.ts` `/help` Keys line lists "Option+Backspace/Ctrl+W delete word".

Collisions checked (`App.tsx` key handler, `input-actions.ts`, `chord.ts`): none.
Taken: Ctrl+C/O (App), Ctrl+V/A/E (input-actions), Ctrl+X/S chord, Option+B/F.
Ctrl+W and Alt+D were free. Two behaviour notes for the owner: (1) `\x08` used to
delete one char (the old test "Backspace → deleteBack" was split: `delete` stays
one char, `backspace` is now word-delete); a terminal that sends `\x08` for PLAIN
Backspace (some Windows consoles/ssh setups) would now delete a word per press;
(2) Alt+forward-delete (`\x1b[3;3~`) is reported as `delete`+`meta`, the same as
Option+Backspace, so it also deletes backward.

Tests: `editor.test.ts` "deleteWord" (9: word, gap+word, mid-word, punctuation,
start of buffer, across `\n`, unicode, selection both directions, forward +
end no-op, `desiredCol` cleared), `input-actions.test.ts` routing from the flags
of each raw sequence (7), `app.test.tsx` "word delete" (ESC DEL → word gone, a
following plain `\x7f` removes exactly one char). RED first against a no-op
`deleteWord` stub: editor 9 failed / 35 passed; routing 5 failed / 23 passed; App
test failed on the assertion. Mutation: ignore the selection branch → the
selection test fails (1); reverted by `cp`, `shasum editor.ts` = `1270cd16…`
identical to the saved copy.

### Fix 4 (Review round 2)

*— claude-sonnet-5-5, 2026-10-25*

- **R1 (owner decision):** removed the `|| key.backspace` word route
  (`input-actions.ts`). A bare `\x08` (`backspace` without meta: Ctrl+H, Ctrl+Backspace,
  or plain Backspace on a `^H` terminal) is `deleteBack` — one char. Still word
  delete: `\x1b\x7f` and `\x1b\x08` (meta), `\x17` Ctrl+W (previous), `\x1bd`
  (next). The routing test for `\x08` now pins one char. Fix 3's byte table updated.
- **R2:** `WORD` is now `/[\p{L}\p{M}\p{N}_]/u` in the shared `editor.ts` rule, so
  `moveWord` and word delete agree and never leave an orphan mark. New tests:
  NFD `café` both directions (move + delete), Devanagari `नमस्ते`, keycap
  `1️⃣`.
- **R4:** `/help` Keys line lists Alt+D ("delete next word"); the
  `resolveLineInput` doc comment and the word-delete inline comment now describe
  the actual routing (and the `\x08` ambiguity).
- **R3:** not changed (pre-existing: Fn+Delete `\x1b[3~` deletes backward because
  Ink reports it like `\x7f`; Alt+Fn+Delete deletes the previous word). Recorded
  as known in Round 2 for a TODO entry.
- **Red→green:** the 4 changed/new tests failed on the Fix 3 code (the `\x08`
  routing test; NFD; Devanagari; keycap), 75/75 after.

### Owner test — Apple Terminal (known limit)

*— claude-opus-5-5, 2026-10-25*

- **Observed (owner, MacBook, Apple Terminal, profile "Clear Dark"):** Ctrl+W
  deletes the previous word; Option+Backspace does not.
- **Orchestrator check (tmux, installed binary):** raw `\x1b\x7f`
  (Option+Backspace) and `\x17` (Ctrl+W) each delete one word. The routing is
  right.
- **Cause (likely, bytes not captured):** the profile has "Use Option as Meta
  key" off, so Apple Terminal does not prefix Option+Backspace with ESC. It
  reaches the TUI as a plain Backspace. The client cannot tell them apart and
  does not guess.
- **Owner decision:** no code change and no `/help` change; this note only.
  Workaround: Ctrl+W, or a terminal that sends `\x1b\x7f` (iTerm2, Ghostty).
  Turning on "Use Option as Meta key" also works, but on the Italian Mac layout
  it breaks Option-typed characters (`@`, `#`, `[`, `]`).

## Review

*— claude-opus-5-5 (fresh context; a different model from the executor, claude-sonnet-5-5), 2026-10-25*

**Verdict: REQUEST-CHANGES** (one small test gap, F1). The fix itself is correct
and the edge cases I tried render correctly. F2–F5 are low, or need an owner
decision, and do not block a merge.

### Findings

1. **F1 — medium, test gap (§4/§9).** The `App.tsx:525` wiring
   (`inputRowCount(…, columns, …)`) is not pinned by any test. Mutation: pass
   `Number.POSITIVE_INFINITY` as the width (the old logical-line count) → **all
   533 TUI tests still pass**, including the new `app.test.tsx` "input soft-wrap".
   That test checks for a bottom border under the wrapped row, but Ink grows the
   box on its own, so the check passes either way. The real effect is the frame
   height. Scratch repro: type 350 chars into `App` at 100 columns. With the fix
   the frame stays at 23 lines before and after; with the mutation it grows from
   23 to **26** lines, which is taller than the terminal. Fix: assert that the
   frame's line count does not change after typing a value that wraps over
   several rows, and show the assertion red under this mutation.
2. **F2 — low, owner decision.** Tab characters break the load-bearing
   assumption ("Ink never wraps a row we made narrower"). `stringWidth("\t")` is
   0, and pasted text keeps `\t` (`paste.ts:37-40`). So a row that contains a tab
   is measured narrower than the real terminal draws it (the tab expands to the
   next tab stop), and the terminal hard-wraps that row. The bug class existed
   before this change, but the new code still lets it through. Option: render
   `\t` as spaces in `input-view.ts`.
   **Owner 2026-10-25: tab shown as 4 spaces, value unchanged.** Done — see
   Execution, Fix 2.
3. **F3 — low.** On a very narrow box (`width ≤ 3`), `room` is clamped to 1
   (`input-view.ts:51-53`). A wide character, or the 2-cell prefix plus one cell
   at width 2, then overflows the box. Ink wraps it and the frame no longer
   matches `inputRowCount`: at width 3, `rowCount=5` but the frame has 6 rows. A
   terminal that narrow is unrealistic, so I am noting it rather than blocking.
   **Accepted debt (orchestrator recommendation, 2026-10-25):** `App` clamps
   `columns` to ≥ 20 (`App.tsx:509`), so width ≤ 3 is unreachable.
4. **F4 — low, owner decision (performance).** On every render the whole buffer
   is grapheme-segmented twice: once by `App` through `inputRowCount`, once by
   `LineInput` through `inputRender`. Measured cost of one `inputRender` call:
   10k chars ≈ 6.3 ms, 200k chars ≈ 118 ms. The paste cap is 1 MB
   (`paste.ts:18`). Typical prompts are fine; very large pastes will lag on each
   keystroke. Options: compute the rows once and share them, memoise them, or
   accept the cost.
   **Accepted debt (orchestrator recommendation, 2026-10-25):** accept the cost
   (~118 ms per keystroke only at 200k chars); revisit with memoisation if a
   large-paste lag is reported.
5. **F5 — info, owner decision (documented).** Up/Down still move by logical
   line (`input-actions.ts:45-46`). On a single long wrapped line, Up from any
   visual row recalls history. This was a deliberate decision in the
   Implementation. Moving by visual row would be a follow-up task.

### Gate (re-run by the reviewer)
`bun run check`: typecheck clean, lint clean (464 files), **2558 pass / 2 skip /
0 fail** (2560 tests, 206 files). The two skips are the opt-in ones.

### Mutations (each reverted)
- M1: `App` row count with width `Infinity` → **survives** (this is F1).
- M2: `LineInput` passes width `Infinity` (≡ the old behaviour) → 4/4 frame
  tests fail (3 in `line-input`, 1 in `app`). The failing frames reproduce the
  Context symptom (`❯abcdefghijklmnoz012` / `" qrstuvwxy       3"`).
- M3: cursor cell is one UTF-16 unit instead of the whole grapheme → the emoji
  test fails.
- M4: selection `rowStart = 0` → the wrapped-selection test and the multi-line
  selection test fail.
- After reverting: `shasum` of all 7 task files is identical to before, and
  `git status --short` is unchanged.

### Premise table
| Premise | Status |
|---|---|
| Symptom: the cursor is stranded on the first visual row and the text is scrambled | TRUE (M2 reproduces the Context frames) |
| `string-width` 7.2.0, the same instance Ink uses (`packages/tui/package.json:20`) | TRUE: both resolve to `.bun/string-width@7.2.0` |
| `message-row.ts:10,18` uses the same measure | TRUE |
| Input box `width={columns}`, no left/right border (`App.tsx:1794-1800`) | TRUE |
| The box height feeds `activeRows` (`App.tsx:544`) | TRUE |
| Up/Down use logical lines (`input-actions.ts:45-46`) | TRUE |
| `inputSelectionSpan` has no other users | TRUE (grep: only `input-view.ts` and old docs; `selection.ts` does not use it) |

### Attacks tried (scratch frames with SGR kept, `.tentacle/tmp/tui-input-wrap-review/`)
- CJK with an odd room (17 cells): the wide char moves to the next row and the
  cursor is right. **Holds.**
- A ZWJ family emoji and a combining `é` at the wrap boundary: neither is split,
  and the inverse cell covers the whole cluster. **Holds.**
- A row exactly full with the cursor at EOL: the cursor gets a new empty row,
  and the box height matches. With a selection active, the extra row is blank.
  **Holds.**
- A wide char at room−1: it moves to the next row. **Holds.**
- `\n` plus a wrapped line, cursor in the middle: **holds.**
- `maxRows=3` with the cursor in the middle and at the end: the `↑`/`↓` gutters
  show, the cursor row stays visible, and frame rows equal `inputRowCount`.
  **Holds.**
- Selection across a wrap: **holds.**
- Placeholder: **holds.**
- Width ≤ 3: **F3.** Tab: **F2.** A 200k-char buffer: **F4.**
- App frame height with wrapped input: correct, but unpinned (**F1**).
- §7 "logic in pure modules": no wrap or measure logic in `LineInput.tsx` or
  `App.tsx` (App only calls `inputRowCount`). **Holds.**
- A terminal resize re-wraps the rows: `columns` reaches both call sites through
  props or state on every render. Verified by reading the code only, not run in
  a live terminal.

### What holds
The pure-module design (`wrapRows` is the single source for both the rendered
rows and the height), grapheme-safe wrapping, cursor placement at the wrap
boundary, the pinned decision on an exactly full row, and windowing by visual
rows.

### Executor behaviour
Honest and accurate. The Execution section says plainly that the tests were
written after the code and that the red run was shown afterwards against a
hand-made copy of the old code. Every claim in the doc that I re-checked is
true. The gap is the one listed in F1: the second `App.tsx` edit, which the
executor called "needed", was never mutation-tested, so its test does not pin
it.

### Round 2 (Fix 1, Fix 2, Fix 3)

*— claude-opus-5-5 (fresh context; a different model from the executor, claude-sonnet-5-5; same model as the round-1 reviewer), 2026-10-25*

**Verdict: APPROVE-WITH-NITS.** Fix 1 closes round-1 F1. Fix 2 (tabs) is
correct in every edge case I tried. Fix 3 (word delete) does what it says and
collides with no other binding. One behaviour change needs an owner decision
(R1). It was already disclosed in Execution, and it is not a correctness bug in
the default setup. R2–R4 are low.

#### Findings

1. **R1 — medium, owner decision.** `input-actions.ts:124`: a bare `\x08`
   (Ink reports `backspace`) now means "delete the previous word". The code
   assumes that `\x08` is Ctrl+Backspace, but `\x08` is also:
   - **Ctrl+H**, on every terminal. In readline and emacs, Ctrl+H deletes one
     character.
   - **Plain Backspace**, on any terminal set to send `^H`. These are opt-in
     settings: macOS Terminal "Delete sends Ctrl-H", iTerm2 "Delete key sends
     ^H", GNOME "Backspace key generates: Control-H", PuTTY's Control-H mode,
     and some legacy ssh/serial setups.

   The defaults all send `\x7f` for Backspace and are unaffected: macOS Terminal,
   iTerm2, Ghostty, kitty, tmux, VS Code, GNOME, and Windows Terminal/WSL. On
   those, Ctrl+Backspace sends `\x08`, except VS Code, which sends `\x17`. Native
   Windows consoles, where libuv reports Backspace as `\b`, would be the big
   population, but there is no Windows build target (`.github/workflows/build.yml:40-43`).

   So the code guesses. Two facts it could use instead:
   - The tty's erase character (`stty -a` → `erase = ^H`). It would have to be
     read before Ink enables raw mode.
   - Not mapping `\x08` at all. It stays one character, as before, and
     Ctrl+Backspace users still have Ctrl+W and Option+Backspace.

   Options: (a) accept the change and document it; (b) read the erase character;
   (c) drop `|| key.backspace`.

   **Owner 2026-10-25: option (c). A bare `\x08` deletes ONE character, never a
   word; no `stty erase` read.** Worst case, Ctrl+Backspace deletes one char
   instead of a word, never more than intended; Ctrl+W covers word delete
   everywhere. Done — see Execution, Fix 4.
2. **R2 — low.** `editor.ts:139-143` (`wordBoundary`, which `moveWord` already
   used before this task): the boundary is computed per UTF-16 unit with
   `\p{L}\p{N}_`, so combining marks (`\p{M}`) count as gap. Deleting backward is
   safe, because a mark follows its base character. Deleting forward is not: it
   stops right before a mark and leaves an orphan mark behind. Examples:
   - Alt+D on NFD `"café bar"`, the form macOS uses for Finder paths →
     `"́ bar"`.
   - Alt+D on a keycap `"1️⃣ z"` → `"️⃣ z"`.

   In scripts that use marks, such as Devanagari, a "word" stops at every vowel
   sign: Option+Backspace on `"नमस्ते"` → `"नमस्"`. Before this task, `moveWord`
   only put the cursor in the wrong place. Now the same boundary corrupts text.
   Fix: treat `\p{M}` as a word character (one-character class change, shared
   with `moveWord`), or snap the boundary to a grapheme boundary.
3. **R3 — low, pre-existing, not changed by Fix 3.** Forward delete is not
   available:
   - Plain Fn+Delete (`\x1b[3~`) deletes one character **backward**, before and
     after this task. Ink reports `delete` with `char === ""`, the same as for
     `\x7f`.
   - Alt+Fn+Delete (`\x1b[3;3~`) arrives as `delete`+`meta`, so it now deletes
     the previous word. The user meant the next one. This was disclosed in
     Execution.

   `useInput` cannot tell these keys apart. Only a raw stdin listener could
   (App already demuxes mouse reports from `char`). Alt+D is the only working
   forward word delete.

   **Known, out of scope (2026-10-25):** pre-existing, left for a TODO entry the
   orchestrator adds.
4. **R4 — nit.** The `/help` Keys line (`commands.ts:255`) does not list Alt+D.
   The `resolveLineInput` doc comment (`input-actions.ts:38-42`, "…backspace,
   then printable insert") does not mention word delete. Its inline comment
   (`:120-123`) calls `\x08` only "Ctrl+Backspace", which hides R1.

#### Gate (re-run by the reviewer)
`bun run check`: typecheck clean; lint clean (464 files); **2581 pass / 2 skip /
0 fail** (2583 tests, 206 files). This matches the orchestrator. The two skips
are the opt-in ones.

#### Mutations (each reverted)
- `wrapRows` measures `\t` with `stringWidth` (0) instead of `TAB_WIDTH` → 2
  input-view tests fail ("a tab never splits…", "tabs count as 4 cells…").
- Alt+D routed with `dir: -1` → the Alt+D routing test fails.
- `deleteWord` result `cursor: to` instead of `lo` → the forward deleteWord test
  fails.
- App `case "deleteWord"` calls `field.deleteBack()` → the App word-delete test
  fails.
- `|| key.backspace` removed → the `\x08` routing test fails.
- I ran the first four together. Each was caught by a different, attributable
  test (164 pass / 5 fail). I ran the fifth alone (27 pass / 1 fail).
- After restoring with `cp` from backups: `shasum` of all 81 `tui/src` +
  `tui/test` files is identical, and `git status --short` is identical.

#### Premise table (Fix 2/3 claims)
| Claim | Status |
|---|---|
| Ink 5.0.1: `\x7f`→`delete`, `\x08`→`backspace`, `\x1b\x7f`→`delete`+`meta`, `\x1b\x08`→`backspace`+`meta`, `\x17`→`"w"`+`ctrl`, `\x1bd`→`"d"`+`meta`, `\x1b[3~`→`delete` | TRUE (raw-byte probe below; `ink/build/parse-keypress.js:158-167`) |
| `\x1b[3;3~` arrives like Option+Backspace (deletes backward) | TRUE (`delete`+`meta`, modifier 3 → `meta`) |
| Plain `\x7f` still deletes ONE character | TRUE (probe + App test) |
| Ctrl+W / Alt+D were free | TRUE. Checked every `useInput`: App handler (`App.tsx:1407-1671`: chord, permission keys y/a/n/arrows/enter/esc, Ctrl+C, paste, panel `treeKey`, Esc-abort, Ctrl+O, palette, mouse), `chord.ts` (only Ctrl+X/Ctrl+S), `tree-panel.ts:78`, `SessionPicker` (`pickerKey`, no text field) |
| Word delete in other text fields | N/A. The prompt is the only text field: steer/queue use the same `field`, and the permission dialog and picker take keys, not text. So it behaves the same everywhere text is typed |
| Tab: value unchanged; `inputView().lines` keeps raw `\t` | TRUE |
| Copy of a selection containing a tab | N/A. No copy path exists for the input box: mouse selection covers only transcript rows (`App.tsx:1576-1577`), and `/copy` copies the last reply. Submit sends `field.value`, which keeps the `\t` |

#### Attacks tried (`.tentacle/tmp/tui-input-wrap-review2/`, SGR rendered as `⟦ ⟧`, width 12 → room 10)
- **Raw bytes** through a real Ink `useInput` + `resolveLineInput`, 13
  sequences:
  ```
  "\x7f"     {delete}        → deleteBack
  "\b"       {backspace}     → deleteWord -1    (R1: also Ctrl+H / ^H Backspace)
  "\x1b\x7f" {delete+meta}   → deleteWord -1
  "\x1b\b"   {backspace+meta}→ deleteWord -1
  "\x17"     "w" {ctrl}      → deleteWord -1
  "\x1bd"    "d" {meta}      → deleteWord 1
  "\x1bD"    "D" {shift+meta}→ none
  "\x1b[3~"  {delete}        → deleteBack       (R3, unchanged)
  "\x1b[3;3~"{delete+meta}   → deleteWord -1    (R3)
  "\x1b[3;5~"{ctrl+delete}   → deleteBack
  "\x1b[3;2~"{shift+delete}  → deleteBack
  ```
  Kitty CSI-u sequences leak in as text, but the TUI never enables that
  protocol, so terminals never send them. Not a finding.
- **Tabs.** Every case below holds. In every case the row count equals
  `inputRowCount`, and no row is wider than the box:
  ```
  tab at exact boundary  "abcdef\tXY"  → "❯ abcdef    " (w=12) / "  XY⟦ ⟧"
  tab crossing boundary  "abcdefg\tXY" → "❯ abcdefg" / "      XY⟦ ⟧"   (tab moves whole)
  cursor ON that tab                    → "  ⟦ ⟧   XY"                   (first cell only)
  tab fills row, cursor EOL "abcdef\t"  → extra row "  ⟦ ⟧"
  tab + wide "日本\t語語語"             → "❯ 日本    語" (w=12) / "  語語⟦ ⟧"
  selection over tab "ab\tcd" [1,4)     → "❯ a⟦b    c⟧d"
  ```
  A tab wider than the room (width 5) overflows. That width is unreachable,
  because columns are clamped to ≥ 20 (round-1 F3).
- **Editor edges.** These hold: empty buffer in both directions (no-op); end of
  buffer forward (no-op); all-punctuation `"...,,,"` (deleted in either
  direction); `"a\n\n\n"` backward (deletes across the newlines); astral letters
  `𝐀𝐁𝐂` (both halves of each surrogate pair are gap, so a pair is never split);
  a ZWJ family emoji (never split). Combining marks fail (**R2**). A cursor that
  is already mid-surrogate splits the pair, but only plain Left/Right can put it
  there (`moveCursor` steps one UTF-16 unit, before this task), so that is not
  new.
- Prior art: nothing in `TODO.md`, `docs/eval`, `docs/fix` or
  `docs/library-bugs.md` about word delete or `\x08`.
- Fix 1: the round-1 mutation (App width `Infinity`) is now RED, as Execution
  says. I did not re-run it, because the gate exercises the test and the
  executor's red output matches round 1's scratch measurement (23 → 26).

#### What holds
- `wordBoundary` is extracted, so jump and delete cannot drift apart.
- `deleteWord` is pure and unit-tested. With a selection it delegates to
  `deleteBack`.
- Routing stays in the pure `resolveLineInput`; App gets one `case` line (§7).
- Tab display is confined to `input-view.ts`, and measure, wrap, cursor and
  height all come from the same `wrapRows`.

#### Executor behaviour
Accurate and candid. The key table matches the probe byte for byte. Both risky
behaviours (R1, and Alt+Fn+Delete in R3) were disclosed unprompted in Execution
rather than buried. Red-first was shown against a stub, and the mutation was
reverted with a `shasum` proof. The one gap: for `\x08` the executor picked the
guess ("Ctrl+Backspace") over a fact the code could have used, the tty erase
character, and only flagged it. Under the owner's never-guess principle, that
choice belongs to the owner. Note: this round's reviewer is the same model as
round 1's (claude-opus-5-5), in a fresh context. It is a different model from
the executor.
