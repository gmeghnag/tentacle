# fix/tui-blink-off-width — the OFF half of the blink keeps the glyph, hides it

> **Status:** execution
> **Branch:** `fix/tui-blink-off-width`
> **Size:** S · **Blast:** contained · **Suited:** DeepSeek executes, orchestrator checks

## Context

*— deepseek-v4.1-flash, 2026-10-30*

The blink of a running tool call (`docs/feat/tui-tool-blink.md`) renders the OFF
half by swapping the bullet for two spaces (`BLANK`, `packages/tui/src/blink.ts:26`,
swapped in at `render-lines.ts:726` and via `blink.ts:133`). That relies on one
assumption: that `⏺` (U+23FA) is 2 columns wide everywhere.

Owner, real terminal, 2026-10-30 — the row shifts ONE column to the right during
the OFF phase:

```
OFF:    Bash sleep 10 && echo "done after 10s"
ON:  ⏺ Bash sleep 10 && echo "done after 10s" 10.0s
```

`string-width` measures `⏺` as 2 columns (`blink.test.ts` pins
`stringWidth(BULLET) === 2`), so OFF is `"  "`; the owner's terminal DRAWS `⏺` 1
column wide, so ON is one column narrower than the layout believes and the label
starts one column left of where OFF puts it. This is a real disagreement between
terminals about the width of U+23FA, so **no fixed count of spaces is right
everywhere** — the count that fixes this terminal breaks the next one.

**Approved fix (owner):** in the OFF phase emit the SAME `⏺`, wrapped in the SGR
conceal attribute (`chalk.hidden` → `ESC[8m … ESC[28m`). The cell width is then
identical to ON in every terminal by construction — it is the same character —
and only its visibility changes. Everything else of the blink design stays:
one shared clock, the phase rule, restart-ON per new call, the swap after the
wrap (no re-layout), only running rows repaint.

**Repro:** captured while proving the load-bearing assumption below —
`.tentacle/tmp/tui-blink-off-width/repro.ts` (Ink + `ink-testing-library` with
`chalk.level = 3`), pasted in full under *Load-bearing assumption*.

## Implementation

*— deepseek-v4.1-flash, 2026-10-30*

### Load-bearing assumption

**Ink's output pipeline (its ANSI tokenizer, its width-driven slicing/wrapping
and the output grid's `trimEnd`) PRESERVES `ESC[8m` … `ESC[28m` around the glyph
— it neither drops, moves nor strips them.** Without this, `availableWidth`,
`sliceAnsi` (`ansi-styles` knows the pair but Ink only has to keep it) or
`cli-truncate` could swallow the conceal codes and the OFF half would show a
solid bullet (fix silently dead) or a `[8m` literal.

Proven empirically, not by reading Ink:

```
$ cd .tentacle/tmp/tui-blink-off-width && bun repro.ts
--- OFF source ---
"\u001b[38;2;6;182;212m\u001b[8m⏺\u001b[28m\u001b[39m \u001b[1mBash\u001b[22m \u001b[38;2;140;140;140msleep 10 && echo \"done after 10s\"\u001b[39m..."
--- frame (raw escapes) ---
"\u001b[38;2;6;182;212m⏺\u001b[39m ...\n\u001b[38;2;6;182;212m\u001b[8m⏺\u001b[28m\u001b[39m \u001b[1mBash\u001b[22m ...\ntail"
frame has ESC[8m: true
frame has ESC[28m: true
OFF row: ESC[8m right before glyph: true
tail row untouched: "tail"
--- narrow (truncate) frame ---
"\u001b[38;2;6;182;212m\u001b[8m⏺\u001b[28m\u001b[39m \u001b[1mBash\u001b[22m \u001b[38;2;140;140;140msleep 10 && ec\u001b[39m…"
```

The pair survives verbatim in the rendered FRAME (not just in `toolLines`), it
stays adjacent to the glyph, the row after it is untouched, and it survives
Ink's truncate path too. `string-width` on the wrapped glyph is still 2, so the
layout is unchanged. A regression test re-captures this at frame level with
colours forced (`app.test.tsx`).

### Preconditions

- The OFF glyph is swapped into an already-wrapped, already-cached row
  (`render-lines.ts:719-733`); the phase is applied after the wrap, so nothing
  re-wraps. Replacing two spaces with a same-width glyph keeps that property.
- `chalk.hidden` is `[8, 28]` (`ansi-styles@6.2.3/index.js:19`): an ANSI-16
  code, so it is emitted at every colour level ≥ 1.
- `packages/tui/test/read-highlight.test.ts:14-19` sets `chalk.level = 3` for its
  own file only; `bun test` runs with chalk OFF (level 0, verified), so under the
  test harness `chalk.hidden` emits a bare `⏺` — the compound-attribute path
  (`ansi-styles` `hidden.openAll` when another style is already open, or a
  `Chalk` instance with both) is otherwise untested and is exactly what the app
  uses in a real terminal. `blink.ts` therefore depends on `theme.ts` for the
  conceal styler (the file that owns colouring), and a test pins that the
  combined accent+hidden value keeps `ESC[8m` right before the glyph.
- `⚠`-free ✓: `render-lines.ts:533` budgets the header with
  `stringWidth(BULLET)`, unaffected; the OFF row's plain text is now byte-equal
  to the ON row's by construction (that is the property the test pins).

### Design

`blink.ts` gains one exported styler: `hiddenBullet()`, the OFF glyph — the SAME
`BULLET` wrapped by `theme.hidden` (`chalk.hidden`) — and loses `BLANK` (unused
after the swap). `toolBullet("running", phase)` returns `BULLET` when `blinkOn`
and `hiddenBullet()` otherwise, so the pure rule still owns "which glyph at this
phase" and only the glyph's visibility differs between phases. `render-lines.ts`
swaps `BULLET` for `hiddenBullet()` in `offPhaseRows` (same replace-after-wrap
seam, same memoised cache).

Nothing else changes: the clock, `blinkState`, `blinkPhase`, `advanceBlink`,
`syncBlink`, the App's arm/sync effects and the `withPhase` gate are untouched.
When colour is off (level 0: `NO_COLOR`, a pipe, the test harness) the OFF glyph
degrades to a plain `⏺` — the bullet then simply stays steady instead of
blinking, which is the honest degradation: a steady bullet is correct, a
mis-aligned row is not.

### Files

1. `packages/tui/src/theme.ts` — add `hidden: chalk.hidden` (the conceal styler,
   beside the other tokens).
2. `packages/tui/src/blink.ts` — `hiddenBullet()` replaces `BLANK`; `toolBullet`
   returns it in the OFF half; the doc comment is re-stated around "same
   character, hidden" instead of "same width".
3. `packages/tui/src/render-lines.ts` — `offPhaseRows` swaps to `hiddenBullet()`;
   the cache comment (771-733) is corrected.
4. Tests: `packages/tui/test/blink.test.ts`,
   `packages/tui/test/render-lines.test.ts`, `packages/tui/test/app.test.tsx`.
5. `TODO.md` — one line under the blink entry linking this doc.

### Failure modes

- **Colour disabled / `NO_COLOR` / a pipe** → `chalk.hidden` is the identity, so
  OFF is a plain `⏺`: the bullet stays steady, no row moves. Accepted and stated
  (the OFF half is a *visibility* effect; with no visibility channel there is
  nothing to hide, and a steady bullet is what the ON half already shows).
- **The conceal SGR leaking to the label** → the styler closes at `ESC[28m`
  before the trailing reset, and `ESC[39m`/`ESC[0m` also end conceal; a test
  asserts the label sits after `ESC[28m` (mutation: removing the close must
  fail it).
- **Text selection / copy of an OFF row** → copying a *rendered* row copies the
  glyph, not two spaces, i.e. byte-identical to copying an ON row (an
  improvement: OFF used to copy as blanks). `/copy` and the clipboard paths use
  assistant text, never these rows (`App.tsx:1717`), so nothing else changes.
- **The settled ok/error bullet** → untouched: `hiddenBullet` is only reachable
  for `status === "running"` (`withPhase` gate + `toolBullet`), and a test pins
  the ok/error rows at every phase.
- **An expanded/clicked running call** → the swap is row 0 only, below-the-fold
  `  │ ` rows are the same array; the existing point-7 tests keep pinning it.
- **A terminal that ignores SGR 8** → it draws a solid `⏺` (steady bullet), same
  as the colour-off case; the row still never moves. This is the limit of the
  fix and cannot be closed from inside the process.

### Tests

Red-before-green, in `blink.test.ts` (pure) and `render-lines.test.ts` /
`app.test.tsx` (frames), colours forced to 3 where the escape bytes are the
property:

- **(a) the property that kills the bug** — the OFF row's plain text (SGR
  stripped) is BYTE-IDENTICAL to the ON row's plain text: same glyph, same
  columns, at several widths. Today it differs (`   Bash` vs `⏺ Bash`).
- **(b)** the OFF row contains `ESC[8m` immediately before `⏺` and the conceal
  is closed (`ESC[28m`) before the label; the label and the elapsed time after
  it are visible plain text.
- **(c)** an Ink FRAME with colours forced keeps the conceal codes (the
  load-bearing assumption, at the boundary the user actually sees).
- Non-vacuity: the OFF glyph must not equal the ON glyph (it really hides).

Mutations (each must fail a test, restored from a `cp` backup verified by
`shasum`): OFF back to `"  "` · OFF = `" "` · the hide never closed.

## Execution

*— deepseek-v4.1-flash, 2026-10-30*

Done in the plan's order, with two drifts, both recorded below.

**1. Assumption proved first** (before any edit), `.tentacle/tmp/tui-blink-off-width/repro.ts`
— output pasted under *Load-bearing assumption*. Ink keeps `ESC[8m⏺ESC[28m`
verbatim in the rendered frame, adjacent to the glyph, and through the
truncate path. `string-width` on the wrapped glyph is still 2, so the layout is
unchanged.

**2. Tests first, RED on today's code.** Three files, run narrow:

```
$ bun test packages/tui/test/blink.test.ts
SyntaxError: Export named 'hiddenBullet' not found in module .../blink.ts   (1 error)

$ bun test packages/tui/test/render-lines.test.ts
Expected: "⏺ Bash cp a b"     Received: "   Bash cp a b"
  (fail) a running call blinks with the phase, and the rest of the row never moves
Expected: "⏺"                 Received: "  "
  (fail) at width 79 a long command's rows do not move between phases
Expected: "⏺ Bash 1.7s"       Received: "   Bash 1.7s"
  (fail) an expanded RUNNING call still blinks and no row moves (point 7)
 64 pass · 3 fail

$ bun test packages/tui/test/app.test.tsx
Expected: not ""              (the OFF frame really is concealed: it never was)
  (fail) the conceal codes survive into the Ink FRAME with colours forced
 + 6 phase/idempotence tests that could no longer see the phase
 96 pass · 7 fail
```

The two red assertions that matter: `Expected: "⏺ Bash cp a b" / Received: "   Bash
cp a b"` is the owner's bug as data (the OFF row's plain text is NOT the ON
row's), and the frame test's `not ""` is the load-bearing assumption failing to
see a conceal code at all.

**3. Implementation** exactly as planned: `theme.hidden` (`theme.ts:76-82`),
`hiddenBullet()` replacing `BLANK` (`blink.ts:29-48`), `toolBullet` returning it
in the OFF half (`blink.ts:151`), `offPhaseRows` swapping to it
(`render-lines.ts:729`). `BLANK` is gone (it had no other user).

**Evidence, from a real `App` frame with colours forced** (`chalk.level = 3`,
fake timers, one 5 s `sleep 10 && echo "done after 10s"` call — the owner's own
case):

```
phase 0 (ON):  "\u001b[36m⏺\u001b[39m \u001b[1mBash\u001b[22m \u001b[37msleep 10 && echo \"done after 10s\"\u001b[39m"
phase 1 (OFF): "\u001b[36m\u001b[8m⏺\u001b[28m\u001b[39m \u001b[1mBash\u001b[22m \u001b[37msleep 10 && echo \"done after 10s\"\u001b[39m"
```

The two rows differ by `ESC[8m` / `ESC[28m` and nothing else: the plain text is
byte-identical, so the label starts in the same cell in a terminal that draws
`⏺` 1 column and in one that draws it 2.

**Drift 1 — the phase is no longer visible in plain text.** With the same
character in both halves, no amount of SGR stripping can tell ON from OFF, and
`bun test` runs with chalk OFF (level 0, verified). Six existing App tests
detected the phase as `row.startsWith("⏺")` → `"off"`; that signal is gone by
design. They now detect it from the conceal code (`concealed(row)`) and set
`chalk.level = 3` for their own body, restoring it in `finally` — the same seam
as `read-highlight.test.ts:14-19`. Tests that assert a VISIBLE row
(`startsWith("⏺ Bash")`) now strip the SGR first, because `⏺` carries colour
there. This is a test-only consequence of the approved design, not a behaviour
change: the app always runs with a real TTY.

**Drift 2 — `hiddenBullet()` is a function, not a `const`.** A module-load
constant would capture whatever `chalk.level` was set at import time and ignore
a later change, so the colour-forced tests could not see the conceal code at all
(the harness's level-0 capture would be frozen in).

**4. Mutations** — `cp` backup, `shasum`-verified restore
(`77c7cc874462c1e1d819027f84d71388dda0e9f8`, identical before and after):

| Mutation | Result |
| --- | --- |
| OFF back to `"  "` | **12 fail** — `the OFF glyph is the SAME character…`, `conceal codes wrap the glyph only`, both render-lines phase tests, the frame test, 7 App blink/expand tests |
| OFF = `" "` | **12 fail** — the same 12 |
| hide never closed (`\x1b[8m⏺`, no `\x1b[28m`) | **3 fail** — `conceal codes wrap the glyph only`, `the bullet alternates…` (the frame's label index), `conceal codes survive into the Ink FRAME` |

Restored: `shasum` matches the backup, narrow run green (186 pass).

**5. Gate.** `bun run check` cannot be green in this worktree for reasons that
predate the branch and are outside it: `apps/mobile/tsconfig.json` needs Expo's
`tsconfig.base` (the mobile package is not installed here — CI installs with
`--filter '!@tentacle/mobile'`), and `apps/mobile` carries **untracked generated
JS** (`App.js`, `index.js`, `polyfills.js`, `src/rn-websocket.js`, `src/spike.js`,
`test/rn-websocket.test.js`, dated 2026-10-30 18:21–18:33, not created by this
task) whose tests need `@tentacle/client`, absent from this worktree's
`node_modules`. Measured, each half separately:

- `bunx tsc --noEmit` — clean (only the `apps/mobile` project fails, in
  `tsc -p apps/mobile`).
- `bunx biome check packages` — **clean, 544 files, 0 diagnostics**; the repo-wide
  86 errors + 1 warning are all under `apps/mobile` (pre-existing, the same
  untracked files).
- `bun test packages` — **3611 pass / 3 skip / 0 fail** (the 3 opt-in skips:
  live-k8s, live-docker, real-socket keepalive — AGENTS §6). The narrowed
  three files: 186 pass / 0 fail.
- The main-before baseline (3651 pass) counts the `apps/mobile` tests this
  worktree cannot resolve; `3611 + the mobile suite` is the same total, and the
  only delta in `packages` is this task's own 25 new assertions.

**Not verified:** how each REAL terminal renders SGR 8. Conceal is honoured by
xterm, VTE, iTerm2, kitty, alacritty, WezTerm and Windows Terminal; a terminal
that ignores it draws a solid `⏺` (a steady bullet, never a shifted row). That
last case cannot be closed from inside the process — it is the stated limit of
this fix, and it is strictly better than the width guess it replaces: the old
bug mis-aligned the row in EVERY phase on the owner's terminal.

## Review

*— <model-id>, <YYYY-MM-DD>*

(pending)
