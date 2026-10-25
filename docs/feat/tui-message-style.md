# feat/tui-message-style — Sent messages on a full-width background; queued ones look sent, in grey

> **Status:** execution
> **Branch:** `feat/tui-message-style`
> **Size:** S · **Blast:** contained · **Suited:** a weaker model may execute; standard Review (Opus reviews, per the TODO)

## Context

*— claude-sonnet-5-5, 2026-10-25*

Owner request (TODO.md, "TUI: sent messages on a full-width background; queued
messages look sent, in grey", 2026-10-25):

> **Sent user message:** every line of it on a background colour that spans the
> whole terminal row, left edge to right edge ("così sarà anche più facile
> individuarli quando si scrolla una sessione lunga"). Today only the `›` is
> coloured (`render-lines.ts` `userLines`). The tint comes from the theme:
> subtle on dark, a matching light tint on light themes; wrapped lines and
> blank lines inside the message keep it.
> **Queued messages:** the rotating arc goes away. Each queued message sits at
> the bottom of the conversation, just above the input, shaped exactly like a
> sent message (same `›`, same row background); the ONLY difference is the text
> colour: grey (the theme's subtle colour) instead of the normal text colour.
> Further queued messages stack below it, one per row; under the last one, in
> grey as today, "ctrl+x ctrl+s to send now". […] When it is delivered (the
> daemon says so — the steer event — never a client guess) the message turns to
> the normal text colour and stays in the conversation at the point where the
> model received it. Logic in a pure module; the component only maps it to
> colours. Tests on frames, plus a theme check for dark and light.

Owner confirmation (orchestrator): queued rows have the SAME row background as
sent ones; only the text colour differs.

Constraint: do not edit `App.tsx` / `queued.ts` (parallel task
`feat/queued-broadcast`).

**Repro (feature missing, before any edit):** `userLines` returned
`[chalk.cyan.bold("› ") + first, ...rest.map(l => "  " + l)]` — no background,
no padding (`render-lines.ts:54`); `QueuedMessages.tsx` rendered an `ARC` glyph
from a `setInterval` timer. Pinned by the new tests, which fail on that code
(see Execution).

## Implementation

*— claude-sonnet-5-5, 2026-10-25*

### Load-bearing assumption

A background reaches the right edge only if the row string itself is padded to
the width: `wrapAnsi` (`render-lines.ts:434` `wrapLines`) never pads, so padding
must be added AFTER wrapping, and `wrapLines` must then leave the row alone (a
row of exactly `width` cells does not wrap). Verified by the "wrapLines leaves
the prepared rows alone" test.

### Preconditions

- Transcript path: `itemLines(item, opts)` (`render-lines.ts:~402`) → logical
  lines → `wrapLines(lines, width)` inside `itemRows` (`render-lines.ts:~494`),
  memoised per item keyed on `width` (`RowCacheEntry.width`) → Ink renders the
  precomputed strings. So the width source is `RenderOptions.width`, which
  `App.tsx:518` sets from `columns` (`App.tsx:477`, from `size.columns`, updated
  by the resize handler at `App.tsx:435-469`). A resize changes the cache key ⇒
  user rows are re-laid-out at the new width. User items are a function of width
  alone (`expandMatters` is tool-only), so Ctrl+O does not invalidate them.
- Delivered steers already become a normal user item at the point of delivery:
  `state.ts:320-323` (`case "steer"` appends `{kind:"user", text}`), and
  `App.tsx:691-693` drops the front queued row (`onSteer`) on the same event.
  So "turns to normal colour, stays where the model received it" needs no App /
  `queued.ts` change.
- Queued rows are sized by `App.tsx:499`: one row per queued message
  (`runningRows`). Hence the queued component must stay one row per message and
  cannot add a hint row without editing App (see Notes).
- The spinner timer lived only in `QueuedMessages.tsx` (`spinner.ts` / `ARC` is
  otherwise used only by `spinner.test.ts`).
- No light-mode detection exists in the TUI (`theme.ts` is dark-tuned).

### Design

- New pure module `src/message-row.ts`: `messageRows(text, width, tone, style)`
  wraps the text to `width-2`, prefixes `› ` (first row) / two spaces, pads every
  row to `width` cells (a blank line becomes a padded row, so Ink does not
  collapse it, AGENTS §6 gotcha) and wraps the whole row in the theme's `bg`.
  `queuedRows(texts, width, hint, style)`: one row per message (multi-line text
  flattened, long text cut with `…`, hint beside the last and never cut), same
  `›` and `bg`, text in `queuedFg` grey. Cell width: small local `cellWidth`
  (CJK/emoji = 2, combining = 0) — `string-width` is not a declared dependency.
- `theme.ts`: `messageRgb` (dark + light triples) → `theme.message.{dark,light}`
  stylers `{bg, queuedFg}`. Dark: bg `38,38,46`, grey `140,140,140` (= `subtle`);
  light: bg `232,232,240`, grey `110,110,120`. Default is dark; no switch exists.
- `render-lines.ts`: `userLines(text, width)` → `messageRows`.
- `components/QueuedMessages.tsx`: no state, no timer; width from
  `useStdout().stdout.columns` (re-read on every render; a resize re-renders the
  App, hence this child) or an optional `columns` prop (tests); renders the
  `queuedRows` strings.

### Files

`src/theme.ts`, `src/message-row.ts` (new), `src/render-lines.ts`,
`src/components/QueuedMessages.tsx`; tests `test/message-row.test.ts` (new),
`test/queued-messages.test.tsx`, `test/queued-row.ts` (new shared matcher),
`test/queue.test.tsx` + `test/send-now-app.test.tsx` (their local `queuedRow`
helper matched the arc glyph; replaced by the shared matcher — those two files
are also touched by the parallel task, expect a trivial merge).

### Failure modes

- Resize: rows are keyed on width ⇒ re-laid-out; queued rows re-read columns on
  each render.
- Very narrow terminal: width clamped to ≥ 3 in the builders.
- Wide chars: counted 2 cells so a padded row never exceeds `width` (which would
  wrap into an extra row); exotic wide ranges not in the table underfill by a
  cell (cosmetic).
- Colourless terminal / pipe: chalk emits nothing; rows are still padded spaces
  (Ink trims trailing blanks of a colourless line), so the text is unchanged.
- Selection / copy: rows now carry trailing spaces inside the tint (as diff bars
  already do, `renderBar`).

### Tests

See Execution.

## Execution

*— claude-sonnet-5-5, 2026-10-25*

Done in the order above.

- Red: with `render-lines.ts` and `QueuedMessages.tsx` at `HEAD` and the new
  tests in place, `message-row.test.ts` + `queued-messages.test.tsx` gave
  5 pass / 6 fail (the failing ones: sent rows not full-width/tinted, resize,
  wrapLines-stable, queued tint + grey + no spinner, theme). The 5 passes are the
  pure-builder tests that exercise the new module directly.
- Green: after restoring the implementation, 12 pass / 0 fail.
- Mutations (each reverted, `cmp` byte-identical): (1) queued text coloured like
  sent → "same tint and shape… only the text is grey" and "theme" tests fail;
  (2) padding removed → 6 tests fail (full-width, tint reaches both edges,
  resize, wide chars, hint/truncation widths, queued frame).
- Test harness note: stylers bake the chalk level at import and the harness is
  colourless, so colour assertions use a forced-truecolor `Chalk` built from the
  same `messageRgb` triples (passed as `style`), not the shared chalk.
- Existing `queue.test.tsx` / `send-now-app.test.tsx` found queued rows by the
  arc glyph; with the `›` shape a queued row is textually like a sent one, so
  `test/queued-row.ts` matches by position (queued rows directly above the input
  rule).
- Drift / not done: (a) the hint stays BESIDE the last row (` · ctrl+x ctrl+s to
  send now`, grey, as today); the TODO says "under the last one", which is an
  extra row and needs `App.tsx:499` (`runningRows`) to count it — blocked by the
  no-App constraint. (b) A queued message longer than the width is truncated,
  not wrapped, for the same reason (`runningRows` assumes one row each). (c)
  Light palette exists and is tested but nothing selects it (no light-mode
  switch). (d) `spinner.ts`/`ARC` kept (still has its own test); now unused by
  the UI.
- Two pre-existing assertions in `render-lines.test.ts` (user row `=== "› hi"`)
  now `trimEnd()` the full-width pad.
- Gate: `bun run check` green — typecheck clean, lint clean (0 errors/warnings),
  `bun test` 2382 pass / 2 skip (opt-in) / 0 fail.

### Follow-up 3 (Review round 1)

*— claude-sonnet-5-5, 2026-10-25*

- F1: `message-row.ts` measures with `string-width` (declared in
  `packages/tui/package.json` at 7.2.0 = lockfile version; `--frozen-lockfile`
  ok) and cuts queued text per grapheme (`Intl.Segmenter`). Tests: ✅ ☕ ❤️ ⚠️ ⭐
  and CJK at 20 cols → one row, exactly 20 cells (sent + queued), plus a cut test.
  Red on the old table: 6 fail; green 16/16. Mutation (old file restored):
  7 fail; reverted, `cmp` identical.
- F2: `queue.test.tsx` "bottom-area height": frame line count with 2 queued +
  hint == before. Mutation (drop the `+1` in `runningRows`): fails; reverted,
  identical.
- F3: `<QueuedMessages … columns={columns} />` in `App.tsx`.
- F4: queued `›` is now the sent one (accent, bold). Test compares the marker
  SGR prefix; the harness chalk is colourless, so it is red/green only under
  `FORCE_COLOR=3` (red 7 fail → green); in the plain run it passes either way.
- F5: orphan comment removed from `queue.test.tsx`.
- Gate: `bun run check` green (2396 pass / 2 skip / 0 fail, lint clean);
  `bun run compile` ok.

## Review

*— claude-opus-5-5, 2026-10-25*

Fresh context, same model family as the orchestrator follow-ups (Opus), different
from the executor (Sonnet). Reviewed the uncommitted diff + untracked files,
including both orchestrator follow-ups below.

**Verdict: REQUEST-CHANGES** — one real layout bug on exactly the path the owner
asked to be checked (wide chars / emoji), plus a test gap on the bottom-area
height. Everything else holds.

### Findings

1. **[medium] `message-row.ts:18-33` — the local `cellWidth` table disagrees with
   `string-width` (what `wrap-ansi` and Ink measure with), so common emoji
   OVERFILL a padded row by one cell and it wraps onto a second row.** BMP emoji
   (U+2600–27BF: ✅ ☕ ❌ ⚠️; ⌚ U+231A, ⭐ U+2B50) are counted 1 but are 2; a
   VS16 sequence (❤️ = U+2764 U+FE0F) counts 1+0 but is 2. Repro below:
   `messageRows("done ✅ ok", 20)` is 21 cells; `layoutTranscript` gives the
   user item rows `["› done ✅ ok        ", " "]` — an extra (tinted) spill row —
   vs one row for `"done ok ok"`. Queued rows: same 21 cells in a 20-cell
   `wrap="truncate-end"` Text. ZWJ families / skin tones go the other way
   (underfill by 2–4 cells, cosmetic). The Implementation's failure-mode
   premise "exotic wide ranges … underfill by a cell (cosmetic)" is FALSE: the
   missing ranges overfill. Fix: measure with `string-width` (v7.2.0 is already
   installed transitively via `wrap-ansi`/Ink; declare it in
   `packages/tui/package.json`) for `textWidth` and cut queued text per grapheme
   (`Intl.Segmenter`) with the same measure. Regression test: ✅ / ❤️ / ☕ rows
   are exactly `width` by `string-width`, and `wrapLines` leaves them alone
   (red on the current table).
2. **[low, test gap] `App.tsx:500-502` `runningRows` hint row is correct but
   unpinned.** Mutation M1 (drop the `+1`) → `bun test packages/tui/test`
   459 pass / 0 fail. Its observable is real: frame-height repro (long
   transcript, running turn, 2 queued) gives 23 lines on the code, 24 under M1
   (one row over, i.e. the jump/clip the owner asked about). Add a frame test:
   frame line count with queued rows + hint == without them.
3. **[nit] `QueuedMessages.tsx:19` reads `stdout.columns`, not App's `columns`.**
   App lays out at `Math.max(20, size.columns)` and commits a width change only
   after the row-cache warm (`App.tsx:441-462`); the queued rows can briefly use a
   different width than the `Box width={columns}` around them (and below 20 cols
   they always differ). Pass `columns={columns}` at `App.tsx:1698` — one width
   source; the prop already exists.
4. **[nit] `message-row.ts:44` the queued `›` is grey, the sent one accent-bold.**
   The owner's wording is "same `›` … the ONLY difference is the text colour";
   whether the marker counts as "text" is an owner call — flag it, don't guess.
5. **[nit] `queue.test.tsx:16`** — orphaned doc comment (`/** A queued row: any
   arc spinner frame… */`) left after the helper moved to `queued-row.ts`.
6. **[debt, OK] light palette unselected.** `theme.message.light` exists and
   nothing picks it; mutation M3 (`light: messageStyle(messageRgb.dark)`)
   survives because the theme test injects its own forced-chalk style. Fine as
   staged debt: `TODO.md:1117` already plans Phase 2 (`theme` config
   `auto|dark|light` + OSC-11 probe). That task must wire `theme.message.light`
   and pin the mapping. `spinner.ts` `ARC` is now dead in the UI (debt (d), OK).

### Gate

`bun run check`: typecheck clean · lint clean (445 files, 0 errors / 0 warnings)
· `bun test` **2385 pass / 2 skip (opt-in) / 0 fail**, 9012 expects, 193 files —
matches follow-up 2's claim.

### Mutations (all reverted; `shasum -c` OK on App.tsx, message-row.ts,
format.ts, theme.ts; `git status --short` identical to before)

| # | Mutation | Result |
|---|---|---|
| M1 | `runningRows` hint `+1` → `+0` | **survives** (459/0) → finding 2 |
| M2 | `cellWidth` wide → 1 | killed ("wide characters still fill the row") |
| M3 | `theme.message.light` built from `dark` | **survives** → finding 6 |
| M4 | `formatTokens` k→M switch at `n < 1e6` | killed (`999_600` → "1000k") |
| M5 | `formatDurationMs` cut on `ms < 60000` | killed (`59_960` → "60.0s") |

Executor's own M1/M2 (queued coloured like sent; padding removed) not re-run;
M2 above covers the measure.

### Premise table

| Premise | Verdict |
|---|---|
| Context: `userLines` had no bg/pad; queued used an `ARC` `setInterval` | TRUE (diff of `render-lines.ts`, `QueuedMessages.tsx`) |
| `wrapAnsi` never pads; pad after wrap; a `width`-cell row is left alone | TRUE for ASCII/CJK (test); FALSE for the emoji in finding 1 |
| Width = `RenderOptions.width` = App `columns`; row cache keyed on width (`render-lines.ts:466-482`) ⇒ resize re-lays-out | TRUE |
| User items independent of Ctrl+O | TRUE (only tool items collapse) |
| Steer → `{kind:"user"}` at the delivery point (`state.ts:320-323`) + `onSteer` drops the front row (`App.tsx:695`, `queued.ts:42`) | TRUE — no client guess |
| Queued sized one row each + hint (`App.tsx:500-502`), rendered under the same `st.running \|\| compacting` (`App.tsx:1697`), `hint` always passed | TRUE — the count is exact |
| Spinner timer only in `QueuedMessages.tsx` | TRUE — no timer left; `ARC` only in `spinner.ts` |
| No light-mode detection exists | TRUE (`TODO.md:1117` Phase 2) |
| "Exotic wide ranges underfill by a cell" | **FALSE** (finding 1) |

### Attacks tried

- **Emoji / wide chars at a padded row** → found finding 1 (✅ ❤️ ☕ overfill,
  spill row in the transcript).
- **Blank and wrapped lines** (`"a\n\nb"`, a 50-char line at 20) → every row
  exactly 20 cells, blank line a padded row, `wrapLines` stable: holds.
- **Bottom-area height with a hint row** (frame repro + M1) → count correct,
  but unpinned (finding 2).
- **Resize** → user rows keyed on width; the queued width source is a separate
  read (finding 3).
- **Formatter boundaries**: 999 → "999", 1000 → "1k", 9_999 → "10k", 999_499 →
  "999k", 999_600 → "1M"; 59 → "59s", 60 → "1m 0s", 3599 → "59m 59s", 3600 →
  "1h 0m"; 59_900 → "59.9s", 59_960 ms → "1m 0s" (no "60.0s"). All hold, all
  pinned (M4/M5 killed). Unbounded above (1e9 → "1000M"): irrelevant for tokens.
- **Tab in a message** → counted 1 cell, `string-width` 0: underfill, cosmetic
  (the terminal's tab expansion is pre-existing behaviour).
- **§7 logic-in-pure-modules**: `message-row.ts` and `format.ts` are pure and
  unit-tested; components only map rows/strings. `runningRows` is in App (known
  App debt). Holds.

### Repro (`.tentacle/tmp/tui-message-style/`, outputs pasted)

`width.ts` — `messageRows(text, 20)` widths by `string-width`, then `wrapLines`:

```
"plain text"   widths [20]  after wrapLines 1
"done ✅ ok"   widths [21]  after wrapLines 2
"love ❤️ it"   widths [21]  after wrapLines 2
"☕ break"     widths [21]  after wrapLines 2
"fam 👨‍👩‍👧 x"  widths [16]  after wrapLines 1
"日本語"        widths [20]  after wrapLines 1
"a\n\nb"       widths [20,20,20] after wrapLines 3
```

`frame.ts` — `layoutTranscript([user, assistant], {width: 20})`:

```
done ok ok total rows 3 [["› done ok ok        "],["⏺ next"]]
done ✅ ok total rows 4 [["› done ✅ ok        "," "],["⏺ next"]]
```

`height.ts` — App frame, long transcript, running turn, queued `q1`,`q2` +
hint: 23 lines on the code, 24 with M1.

### Executor behaviour

Sonnet followed the plan and the no-App constraint, reported its drift honestly
(hint beside the row, truncation, unused light palette) and showed red/green
with its own mutations. Its weak spot is the one finding: it hand-rolled a
width table instead of the measure its own wrapper uses, and wrote an
untested, wrong failure-mode claim about it ("underfill, cosmetic"). The
orchestrator follow-ups are correct but left the new height arithmetic
without a pinning test.

### Orchestrator follow-up (hint under the last row)

*— claude-opus-5-5 (orchestrator), 2026-10-25*

The owner's spec puts "ctrl+x ctrl+s to send now" UNDER the queued rows, in
grey, off the message background; the executor had left it beside the last
row because moving it needs the bottom-area height in `App.tsx`, which it was
told not to edit (parallel task 5). Done here: `queuedRows` emits the hint as
its own `theme.subtle("  <hint>")` row after the last message (none when the
queue is empty); `App.tsx` `runningRows` counts that extra row; the
`queuedRow` test matcher and three tests (`queued-messages.test.tsx`,
`message-row.test.ts`, `queue.test.tsx`) assert the new layout — red on the
executor's beside-the-row output, green now. Conflict note for task 5: this is
a 4-line change in `App.tsx` next to `runningRows`. Gate: 2382 pass / 2 skip /
0 fail, typecheck and lint clean.

### Orchestrator follow-up 2 (owner request: compact tokens and durations)

*— claude-opus-5-5 (orchestrator), 2026-10-25*

Owner, 2026-10-25: "superati i 1000 si mostri 1k ecc, altrimenti diventano
numeri lunghi e difficili da leggere. inoltre il tempo che passa, dopo 60
secondi deve diventare "1m 50s"". Added to this branch (same TUI surface):
- New pure `packages/tui/src/format.ts`: `formatTokens` (moved from
  `StatusBar.tsx`, re-exported there): `999`, `1k`, `1.2k`, `54k`, `1M`,
  `1.2M`, `12M` — one decimal under 10, a whole value drops `.0`, `999,600`
  switches to `1M` instead of `1000k`; `formatDuration` (whole seconds):
  `59s`, `1m 50s`, `1h 5m`; `formatDurationMs` (tool durations): tenths
  under a minute (`12.3s`, as before), then `1m 50s`.
- Wired: the status bar `↑`/`↓` session totals (before: raw numbers), the
  live `thinking…`/`working…` timer (`Thinking.tsx`), the tool duration in
  the transcript (`render-lines.ts`).
- Tests: `packages/tui/test/format.test.ts` (3 tests, red before the module
  existed). Gate: 2385 pass / 2 skip / 0 fail, typecheck and lint clean.
