# feat/tui-mascot — Polpetto, a pixel mascot in the TUI startup header

> **Status:** implementation — the sprite is currently HIDDEN in shipped builds
> (`MASCOT_ENABLED = false`, `fix/tui-mascot-hidden`): half blocks render offset
> in macOS Terminal.app, so how the sprite should draw is still being decided.
> **Branch:** `feat/tui-mascot`
> **Size:** M · **Blast:** cross-module · **Suited:** a weaker model may execute (no §7 invariant, no wire/persistence change); standard Review, plus the owner's eye on a real terminal (truecolor + 256 + light)
> **Changelog:** `changelog.d/tui-mascot.added.md`

## Context

*— claude-opus-5-5, 2026-11-21*

The owner wants a small mascot, **Polpetto**, drawn from their own 9×9 pixel
drawing, shown **only** in the TUI startup header, to the left of the header's
lines (tentacle + version, model · cwd, the `/help` hint). Nowhere else — not at
turn end, not on idle. Decoration only: colour carries no meaning. Decisions are
final (21/11); mockup: `.tentacle/mockups/mascot/index.html` (repo root,
gitignored) — the "intro" scene, `index.html:129-130`, draws exactly the target:
mascot left, then `tentacle 0.7.1` / `deepseek-v4 · ~/tentacle` / `/help …`.

**Owner spec (verbatim facts the executor must not reinterpret):**

- Half-block cells: one terminal cell = two vertical pixels. `▀` with fg = top
  pixel, bg = bottom pixel; `▄` / `█` / space when one side is empty or both
  are equal. 9 columns × 5 rows.
- Bitmap (`.` empty, `K` outline, `E` eyes, `F` body, `S` body shade, `B`
  blush), 10 pixel rows, the last one empty:

  ```
  ..KKKKK..
  .KSFFFSK.
  KSFFFFFSK
  KFEFFFEFK
  KFEFFFEFK
  KBBFSFBBK
  .KFFFFFK.
  KSSKSKSSK
  .KK.K.KK.
  .........
  ```

- One of 9 palettes picked **at random at each start**; outline is the plain
  `K` (no darker variant on dark terminals):

  | name  | K       | E       | F       | S       | B       |
  |-------|---------|---------|---------|---------|---------|
  | soft  | #7B3FC0 | #3E1A5E | #B387EA | #A274DE | #DDBFF8 |
  | logo  | #6E36AE | #3E1A5E | #A267DB | #9258CF | #CFA8F3 |
  | glow  | #C9A6F2 | #3E1A5E | #8E4BC4 | #8143B8 | #B583E0 |
  | cyan  | #0E8AA8 | #083A47 | #5FE0F2 | #3FCFE6 | #B7F3FB |
  | teal  | #14857A | #0A3B36 | #5CD6C4 | #40C2AF | #B5EEE4 |
  | coral | #C2475A | #5A1622 | #F58C93 | #EC7480 | #FFC6C2 |
  | mint  | #3C9A5C | #163D24 | #8FE0A6 | #73D28E | #CFF5D9 |
  | amber | #B7791F | #4A2E07 | #F7C35C | #EEB043 | #FFE3A8 |
  | sky   | #3A6FD0 | #13285A | #8DB4F7 | #73A0F0 | #CFE0FF |

- Static is acceptable for v1 (blink: see Design D7, recommendation: static).

**What exists today (verified) — the header the spec assumes does NOT exist.**
The TUI's only startup text is ONE assistant transcript item:

- `packages/tui/src/App.tsx:154` — `const WELCOME = "Tentacle ready. Type a task, or \`/help\` for commands.";`
- `packages/tui/src/App.tsx:405-412` — the initial `items` are the resumed
  transcript if any, else `[{ kind: "assistant", text: WELCOME }]`. `WELCOME`
  is referenced nowhere else (`rg WELCOME packages/tui/src` → these two lines),
  so `/clear` and a resume never show it.
- It renders as an ordinary reply: `render-lines.ts:1034-1035` →
  `assistantLines` (`render-lines.ts:131-139`, accent `●` + markdown).
- The TUI does not know the app version: `AppProps` (`app-types.ts:540-553`)
  and `TuiOptions` (`run.tsx:34ff`) carry `model`, `modelLabel`, `cwd`, no
  version. The version lives in the CLI (`cli/src/version.ts:116`
  `APP_RELEASE_VERSION`, `:119ff` `APP_VERSION`), which `tentacle --version`
  prints (`cli/src/main.ts:725`).

So this task must first **create** the 3-line header (replacing the `WELCOME`
line) and then put the mascot beside it — see Question 1.

**Repro** (capability missing). Evidence in the tree, 2026-11-21: the pinned
first frame is `"● Tentacle ready. Type a task, or /help for commands."`
(`packages/tui/test/app-frames.test.tsx:127,158,197`; `app.test.tsx:1047`
"Row 1 is the welcome line"). The repro script below could not be run in this
worktree (it has no `node_modules`: `bun install` not run here); the executor
runs it after install, before any edit, and pastes the output here:

```ts
// .tentacle/tmp/tui-mascot/repro.ts — run: cd .tentacle/tmp/tui-mascot && bun repro.ts
import { createElement as h } from "../../../packages/tui/node_modules/react/index.js";
import { render } from "../../../packages/tui/node_modules/ink-testing-library/build/index.js";
import { App } from "../../../packages/tui/src/App.tsx";
const r = render(h(App, { model: "qwen3", cwd: "/tmp/work", createSession: () => ({}) as never }));
await new Promise((res) => setTimeout(res, 60));
console.log((r.lastFrame() ?? "").split("\n").slice(0, 6).join("\n"));
r.unmount();
process.exit(0);
```

Expected today: row 1 `● Tentacle ready. …`, no version, no model/cwd line, no
mascot. (After the change, set `chalk.level = 3` before `render` to see the
mascot's glyphs: the frame is SGR-free but the `▀▄█` remain.)

## Implementation

*— claude-opus-5-5, 2026-11-21*

### Load-bearing assumption

**The transcript is an ANSI-string scroll buffer laid out line by line, not Ink
flexbox — so the mascot is chalk-painted text rows inside one transcript item,
not an Ink `<Box>`/`<Text backgroundColor>`.** Proof: `render-lines.ts:1-10`
("The TUI owns layout line-by-line … Each display item becomes an array of
logical lines"), `itemLinesAt` (`render-lines.ts:1002-1056`) returns
`string[]`, `wrapLines` (`:1086-1105`) folds them to the width, and the per-item
row cache is keyed on item identity **+ width** (`RowCacheEntry.width`,
`render-lines.ts:1180-1188`; comment `:1156` "Width / expand / collapse options
are part of the key"). Consequences relied on below: (a) a resize re-lays the
header item at the new width, so the "too narrow → hide" decision re-runs for
free; (b) the item is created once, so a palette picked at creation is stable
across every re-render and resize.

### Preconditions

- **Colour emission & levels.** Colours are chalk stylers; `theme.ts:280-300`
  `ink()` maps a `#hex` to `chalk.hex`. chalk downgrades a hex itself by
  `chalk.level` (3 truecolor → 2 ansi256 → 1 ansi16 → 0 none); level 0 under
  `NO_COLOR` / no TTY is the repo's existing "colour off" signal
  (`chart-lines.ts:55,1099` `chalk.level > 0`; `components/Thinking.tsx:26-29`;
  `blink.ts:44-50`). Read `chalk.level` **at call time, never at import**
  (`blink.ts:43-46`: the test harness runs colour-off and a module-load capture
  freezes it). The 256 downgrade is already measured in tests with
  `new Chalk({ level: 2 })` (`test/theme-contrast.test.ts:86-91`) — reuse that
  pattern.
- **Truecolor fg carry across wraps is fg-only** (`carryColor`,
  `render-lines.ts:1119-1128`: only `38;2`). The mascot rows must therefore
  never be wrapped — guaranteed by D4 (shown only when the whole row fits).
- **Cells:** `cells.ts:14` `cellWidth` (= `string-width`); `▀ ▄ █` and space
  are 1 cell each by `string-width`.
- **Theme mode** is decided once per launch before the first row
  (`theme.ts:1-14`, `setThemeMode` `:417`); `theme.subtle`/`accent` exist
  (`theme.ts:105-107,374`).
- **Path shortening exists:** `status-line.ts:121-130` `shortPath(cwd, home, max)`
  (`$HOME` → `~`, `…` + tail over `max` cells); `App.tsx:162-168`
  `defaultHome()`.
- **DisplayItems are not persisted.** Persistence writes `ChatMessage`s
  (AGENTS §7 persistence bullet); a resume rebuilds items from messages
  (`resume.ts:125`). A new display-only item kind changes no on-disk format and
  no protocol.
- **Version is CLI-owned**; the TUI package must not import from `cli` (the
  dependency goes cli → tui). It has to be passed in as an option.
- `startTui` call sites (all must pass the version): `cli/src/main.ts:1423`
  (engine run/attach), `cli/src/main.ts:2283` (local), `cli/src/connect.ts:352`
  (connect: `model: "remote"`, `modelLabel`, `cwd: options.url`).

### Design

**D1 — Pure module `packages/tui/src/mascot.ts`** (React-free, chalk-free,
AGENTS §7 "logic in pure modules"):

- `MASCOT_BITMAP: readonly string[]` — the 10 rows above, verbatim.
- `MASCOT_PALETTES: Readonly<Record<PaletteName, Palette>>` with
  `Palette = { K, E, F, S, B }` hex strings — the table above, verbatim;
  `PALETTE_NAMES` in table order.
- `pickPalette(rand: () => number = Math.random): PaletteName` —
  `PALETTE_NAMES[Math.floor(rand() * 9)]`, clamped to index 8 for `rand() === 1`
  safety. Injectable, so tests are deterministic.
- `type MascotCell = { glyph: " " | "▀" | "▄" | "█"; fg?: string; bg?: string }`
  and `mascotCells(palette: Palette): MascotCell[][]` — 5 rows × 9 cells; for
  pixel pair (top `t`, bottom `u`), colour of `.` = none:
  - both none → `{ glyph: " " }`
  - `t === u` (same colour) → `{ glyph: "█", fg: t }`
  - only top → `{ glyph: "▀", fg: t }`; only bottom → `{ glyph: "▄", fg: u }`
  - both, different → `{ glyph: "▀", fg: t, bg: u }`
  Compare **resolved colours**, not letters (two letters can never share a hex
  in the given palettes, but the rule is "both equal").
- `headerView(input): HeaderView` — the whole header decision, pure:
  ```ts
  input = { version?: string; model: string; cwd: string; home?: string;
            width: number; colorLevel: number; palette: PaletteName }
  HeaderView = { mascot: MascotCell[][] | null;   // null = hidden
                 lines: [HeaderLine, HeaderLine, HeaderLine] }
  HeaderLine = { strong?: string; text: string }   // "tentacle" bold, rest subtle
  ```
  - lines: `{strong:"tentacle", text: version ? " " + version : ""}`,
    `{text: model + " · " + path}`, `{text: "/help for commands"}`.
  - **mascot shown iff** `colorLevel >= 2` **and**
    `width - GUTTER >= max(cellWidth(line1), cellWidth(line3), cellWidth(model) + 3 + MIN_PATH)`
    where `GUTTER = 9 + 2` (mascot + two spaces) and `MIN_PATH = 12`. When
    shown, `path = shortPath(cwd, home, width - GUTTER - cellWidth(model) - 3)`;
    when hidden, `path = shortPath(cwd, home, width - cellWidth(model) - 3)`
    (never below 1). So the text is always kept, the mascot is what yields.
  - Vertical placement: mascot rows 0–4, text on rows 1–3 (centred); rows 0 and
    4 carry the mascot alone.

**D2 — Display item.** Add a display-only kind to `state.ts:153`:
`HeaderItem { kind: "header"; version?: string; model: string; cwd: string;
home?: string; palette: PaletteName }`. A NEW kind (not a flag on
`AssistantItem`) so it can never be merged with streamed text (`state.ts:530-534`
extends a trailing non-notice assistant item), counted as an answer
(`state.ts:295`, `:321`), or exported by `/save` as `## Assistant`
(`commands.ts:574`). `tsc` lists every site the union touches; the known ones:
`render-lines.ts:1003` (switch — add the case), `commands.ts:566-585`
`transcriptToMarkdown` (the `else` branch assumes `tool` — skip `header`
explicitly). The other `item.kind ===` sites (`rg 'item.kind ===' src`) compare
against a specific kind and need no change.

**D3 — Seeding.** `App.tsx:405-412`: replace `{ kind: "assistant", text: WELCOME }`
with `{ kind: "header", version, model: modelLabel ?? model, cwd, home,
palette: pickPalette() }` (same condition: no resumed items). The palette is
picked once here, at mount → "random at each start", stable thereafter. Delete
`WELCOME`. `home` from the existing `defaultHome()` (`App.tsx:163`).

**D4 — Rendering (render-lines).** `case "header"`: call
`headerView({...item, width: opts.width ?? DEFAULT_WIDTH, colorLevel: chalk.level})`,
then map to strings — the only non-pure bit, presentation:
- a cell → `glyph` styled with `chalk.hex(fg)` and, if `bg`, `.bgHex(bg)`; a
  space cell is a plain space (default terminal background: works on light
  and dark).
- row = 9 mascot cells + `"  "` + text line (`chalk.bold("tentacle")` +
  `theme.subtle(rest)`), or the text line alone when `mascot === null`.
  Each cell is closed by chalk, so no SGR leaks into the text or the next row.
- When hidden, emit only the 3 text lines (no blank mascot rows).
Because the row fits by construction (D1), `wrapLines` takes the
`fitsUnchanged` path (`render-lines.ts:1098-1103`) and never splits a mascot row.

**D5 — Version plumbing.** `TuiOptions.version?: string` (`run.tsx:34`) →
`AppProps.version?: string` (`app-types.ts:540`) → `App` (pass-through at
`run.tsx:179ff`, same spread pattern as `modelLabel`). CLI passes
`APP_RELEASE_VERSION` at the three call sites (Preconditions). Use the release
version, not `APP_VERSION` (`+<build id>` is noise in a header; `--version`
still shows it). Absent (tests, an unwired host) → line 1 is `tentacle` alone.

**D6 — Colour off / low colour.** `chalk.level` 0 (`NO_COLOR`, non-TTY,
`FORCE_COLOR=0`) → mascot hidden. Level 1 (16 colours) → hidden too: chalk maps
every hex to one of 16 named colours, the 5-tone sprite collapses into a blob
(Question 3). Level 2 → shown with chalk's ansi256 downgrade; a test pins that
in every palette K, E and F stay **distinct** after the downgrade (so the face
survives). Level 3 → exact hex.

**D7 — Blink: recommendation static.** A blink would be width-safe (swap the
two `E` pixel pairs for `F` for one frame: same glyphs, same cells — the
`blink.ts:1-22` lesson), but it is not free: the existing tool-blink clock
ticks **only while a call runs** (`blink.ts` armed per running-call set) and
re-renders the App on each tick; a mascot blink needs a timer while the session
is IDLE (exactly when the header is on screen), a header row variant in the
row cache, and a guard to stop when the header scrolls out of the viewport or
the first prompt is sent. Every tick re-renders Ink's dynamic region — the
whole viewport — which is the flicker risk the owner ruled out. Cheap-ish but
not risk-free and not asked for v1 → **static**; a blink is a separate
follow-up if wanted.

### Files

1. `packages/tui/src/mascot.ts` — NEW: bitmap, palettes, `pickPalette`,
   `mascotCells`, `headerView` (imports `cellWidth` from `cells.ts`,
   `shortPath` from `status-line.ts`; no chalk, no React).
2. `packages/tui/src/state.ts` — `HeaderItem`, union at `:153`.
3. `packages/tui/src/render-lines.ts` — `case "header"` + `headerLines()`
   (chalk mapping, D4).
4. `packages/tui/src/commands.ts` — `transcriptToMarkdown` skips `header`.
5. `packages/tui/src/app-types.ts` — `AppProps.version?`.
6. `packages/tui/src/run.tsx` — `TuiOptions.version?` + pass-through.
7. `packages/tui/src/App.tsx` — seed the header item (`:405-412`), drop `WELCOME`.
8. `packages/cli/src/main.ts` (`:1423`, `:2283`), `packages/cli/src/connect.ts`
   (`:352`) — `version: APP_RELEASE_VERSION` (connect: import it from
   `./version.ts`).
9. Tests (below) + existing frame assertions updated: the welcome row is pinned
   in `test/app-frames.test.tsx` (13×), `app.test.tsx` (2×, incl. the
   selection test at `:1047` that presses row 1 col 3 — its coordinates move),
   `keys-app-seam.test.tsx` (2×), `app-structural-freshness.test.tsx` (1×).
   The harness runs colour-off, so those frames show the 3 text lines, no
   mascot.
10. `changelog.d/tui-mascot.added.md` — one bullet, e.g.
    `- **Polpetto in the startup header.** The TUI now opens with a header — tentacle and its version, the model and folder, the /help hint — and, beside it, a small pixel mascot in one of nine colours picked at random each start. It is hidden when colours are off (NO_COLOR, not a terminal, 16-colour terminals) or the window is too narrow.`

### Failure modes

| case | behaviour | how it converges |
|---|---|---|
| `NO_COLOR` / `FORCE_COLOR=0` / non-TTY (level 0) | mascot hidden, 3 text lines | decided per render from `chalk.level` |
| 16-colour terminal (level 1) | mascot hidden (Q3) | same |
| 256-colour (level 2, no `COLORTERM=truecolor`) | shown, chalk ansi256 downgrade; K/E/F stay distinct (tested) | — |
| narrow terminal (< gutter + text) | mascot hidden, text kept, cwd shortened `…tail` | row cache keyed on width → re-decided on every resize, back when wide again |
| extremely narrow (text itself wider) | text lines wrap normally (no mascot to break) | `wrapLines` |
| long cwd | shortened by `shortPath` to fit beside the mascot, down to `MIN_PATH`; below that the mascot yields | D1 rule |
| light theme | empty pixels use the terminal's default bg; sprite colours are fixed. `glow`'s light outline (#C9A6F2) is faint on white — accepted (owner: one outline, decoration only); see Q4 | — |
| connect | line 2 = served model label (or `remote`) · daemon URL | `modelLabel ?? model`, `cwd` as given |
| no version passed | `tentacle` alone | D5 |
| resume / `--continue` / attach with history | no header (today's `WELCOME` rule) (Q2) | — |
| `/clear` | header not re-shown (it is not today either) | — |
| screen readers | the TUI has no screen-reader mode (`rg -i 'screen.?reader' packages/tui/src` → none); a reader gets the 3 text lines plus, when coloured, a row of `▀▄█` glyphs — the same as any other glyph decoration in the TUI | not designed further in v1 |
| East-Asian-ambiguous-wide terminals | `▀▄█` are EA-Ambiguous: a terminal set to draw them 2 cells wide would widen the sprite; `string-width` (narrow) is the repo's measure (`cells.ts:1-8`) — known limit, same class as `docs/library-bugs.md` (Ink grid) | — |
| mouse selection over the header | copies the glyphs with the text | cosmetic, accepted |
| `/save` | header not exported | D2 skip |

### Tests

New `packages/tui/test/mascot.test.ts` (pure, no Ink):

- **Projection, each pixel pair:** for a tiny synthetic bitmap/palette (or by
  exporting the pair function), assert all five cases: `..`→space,
  `K.`→`▀` fg K no bg, `.K`→`▄` fg K, `KK`→`█` fg K, `KF`→`▀` fg K bg F.
- **The real sprite:** `mascotCells(soft)` has 5 rows; row 4 (pixel rows 8/9)
  is `▀` fg K exactly at columns 1,2,4,6,7 and space elsewhere; row 0 col 0
  is space, col 1 is `▄` fg K, col 2 is `▀` fg K bg S; row 1 col 2 is `▀` fg F
  bg E (the eye). These are derived by hand from the bitmap — the executor
  checks them against the table, not against the code.
- **Every row 9 cells wide:** `cellWidth(row.map(c => c.glyph).join("")) === 9`
  for all rows, every palette.
- **Palettes verbatim:** 9 names in order, each with K/E/F/S/B equal to the
  table (a typo in a hex is the likeliest bug).
- **`pickPalette` injectable:** `rand = () => 0` → `soft`; `() => 0.999` →
  `sky`; `() => 1` → `sky` (clamp); `() => 4/9` → `cyan`.
- **`headerView` show/hide:** level 0 → `mascot null`; level 1 → null;
  level 2/3 at width 80 → shown; at width = threshold → shown, threshold − 1 →
  null (boundary); text lines identical in content either way except the cwd
  budget; long cwd shortened with `…` when shown; no version → line 1
  `tentacle`.
- **256 survival:** with `new Chalk({ level: 2 })` (the
  `theme-contrast.test.ts:86` pattern), for every palette the SGR codes of K,
  E and F are pairwise different.

`render-lines` (in the existing render-lines test file): with `chalk.level`
forced to 3 (restored in `afterEach`), `itemLines(header, {width: 80})` gives 5
rows whose `stripAnsi` starts with the glyph row and contains `tentacle`; each
row's `cellWidth(stripAnsi(row)) <= 80`; at width 30 → 3 rows, no `▀▄█`.
With level 0 → 3 rows, no glyph. `transcriptToMarkdown([header])` → `""`.

App-level (`app.test.tsx` pattern): fresh mount shows `tentacle` + the model ·
cwd line + `/help for commands`; with `initialItems` → none of them (existing
`:1372` assertion re-targeted).

**Red before green:** write `mascot.test.ts` and the render-lines case first;
they fail (module/kind missing) — paste the red run in Execution. Non-vacuity
by mutation (§9): swap fg/bg in the `▀` case and flip the level threshold to
`>= 1`; both must turn a test red.

Gate: `bun test packages/tui/test/mascot.test.ts` while iterating; before done
`bun run check` (lint baseline clean, §6). Then the owner checks a real
terminal: truecolor dark, `TERM=xterm-256color` without `COLORTERM`, light
theme, `NO_COLOR=1`, and a narrow window.

### Questions (each with a recommendation)

**Owner 2026-11-21, Q1–Q4:** accepted as recommended. **Q5:** static in v1. Blink and wave stay in the backlog until they are properly designed (not in this task).

1. **The header does not exist** — today there is only the one-line
   `WELCOME` reply (`App.tsx:154,411`). Create the 3-line header (tentacle +
   version / model · cwd / `/help for commands`) and **replace** `WELCOME` with
   it, shown even when the mascot is hidden? **Recommend: yes** — it is what
   the mockup shows (`index.html:129`) and what the owner described; it needs
   the version plumbed from the CLI (D5). English text `/help for commands`
   (the mockup's Italian is mockup-only; repo artifacts are English).
2. **When is it shown?** Today `WELCOME` appears only on a fresh session (not
   on resume/`--continue`/attach with history, not after `/clear`).
   **Recommend: same rule** — "each start" = each fresh start; a resumed
   transcript keeps opening on its own history.
3. **16-colour terminals (chalk level 1):** hide the mascot? **Recommend:
   hide** — chalk maps each hex to one of 16 named colours and the five tones
   collapse into the "monochrome blob" the owner called ugly.
4. **`glow` on a light terminal:** its outline #C9A6F2 is faint on white.
   **Recommend: keep all 9 in both themes** (owner: one plain outline,
   decoration only); revisit only if the owner dislikes it on a real light
   terminal.
5. **Blink:** **Recommend: static for v1** (D7) — feasible width-safely, but
   needs an idle-time timer that re-renders the viewport, the flicker risk
   ruled out; a follow-up if wanted.

## Execution

*— deepseek (partial, stopped by the watchdog) then claude-opus-5-5, 2026-11-21*

**Load-bearing check (re-run): holds.** `itemLinesAt` returns `string[]` per
item and the header is one more `case` in it; the colour-off and truecolor
frames below are the lines `headerLines` returns, unwrapped.

**Repro.** Before (HEAD `312c634d`, `git show HEAD:packages/tui/src/App.tsx | rg WELCOME`):
`154: const WELCOME = "Tentacle ready. Type a task, or \`/help\` for commands.";`,
`412: : [{ kind: "assistant", text: WELCOME }]` — no version, no model · cwd
line, no mascot. After (`.tentacle/tmp/tui-mascot/repro.ts`: the plan's script,
with absolute imports into this worktree, `version: "0.7.1"` and `chalk.level`
from argv):

```
$ bun repro.ts 0
tentacle 0.7.1
qwen3 · /tmp/work
/help for commands
$ bun repro.ts 3          # SGR kept: 5 rows, sprite + 2 spaces + text on rows 1–3
 ▄▀▀▀▀▀▄
█▀▀███▀▀█  tentacle 0.7.1
█▀▀█▀█▀▀█  qwen3 · /tmp/work
▄▀▀▀▀▀▀▀▄  /help for commands
 ▀▀ ▀ ▀▀
```
(the level-3 row text above is shown with SGR stripped; the raw run carried
`38;2`/`48;2` per cell, closed by `39`/`49` before the gutter.)

**As built — files 1–10 exactly as Implementation lists them, no drift in design:**
`mascot.ts` (new: bitmap, palettes, `pickPalette`, `pairCell`/`mascotCells`,
`headerView` with `GUTTER = 11`, `MIN_PATH = 12`); `state.ts` `HeaderItem` +
union; `render-lines.ts` `headerLines` + `paintCell` + `case "header"`;
`commands.ts` `transcriptToMarkdown` skips `header`; `app-types.ts` /
`run.tsx` `version?` + pass-through; `App.tsx` seeds the header (palette drawn
once at mount), `WELCOME` deleted; `cli/main.ts` (engine + local call sites)
and `cli/connect.ts` pass `APP_RELEASE_VERSION`. Pinned welcome-row frames
updated in `app-frames`, `app`, `app-mouse-layer`, `keys-app-seam`,
`app-structural-freshness` (colour-off harness → 3 text lines, no sprite).

**Additions beyond the plan's test list:** `packages/cli/test/tui-version-option.test.ts`
(drives the real `main` on the local path and asserts `startTui` receives
`version === APP_RELEASE_VERSION`); a "feet row" test (row 4 = `▀` fg K at
exactly cols 1,2,4,6,7, space elsewhere — derived by hand from the bitmap, as
the plan asks; DeepSeek's version only checked cols 0–1).

**Red before green.** The red run (module/kind missing) predates this
resume and was not captured by the stopped executor — not re-creatable without
deleting the work. Non-vacuity is shown instead by mutation:

| mutation | result |
|---|---|
| `▀` case `fg: below, bg: above` (swap) | 2 fail: `the five pixel-pair cases`, `the eye row` |
| `colorLevel >= 1` | 1 fail: `16 colours (level 1): hidden too` |
| drop `version` at the local `startTui` call (`main.ts`) | 1 fail: `startTui gets version` |

All three reverted (verified by `rg`).

**Checks run (narrow, per budget):** the 8 touched test files → 292 pass, 0
fail; `mascot.test.ts` after the added test → 18 pass. `biome check` on the 17
touched files → clean. `tsc -p packages/tui` / `-p packages/cli`: no error on
any touched line (the per-package configs report pre-existing module-resolution
noise — `@tentacle/protocol`, `--jsx` — which the root `bun run typecheck`
does not). Full `bun run check`: left to the orchestrator's gate.

**Unverified:** the owner's real-terminal pass (truecolor dark,
`TERM=xterm-256color` without `COLORTERM`, light theme, `NO_COLOR=1`, narrow).

## Review

### Gate fix after exec — the mobile leg was environmental, plus one stale merge

*— claude-opus-5-5, 2026-11-21*

The orchestrator's gate failed on `apps/mobile/App.tsx` (`TS2307` on
`@react-navigation/*`, `react-native`, `expo-*`; `TS1286`/`TS1287` following from
the same cause). Two separate facts, both verified:

1. **Environmental, not a code regression.** This worktree had no
   `apps/mobile/node_modules` — CI installs with
   `bun install --frozen-lockfile --filter '!@tentacle/mobile'`
   (`.github/workflows/build.yml:52`), and the worktree inherited that state.
   Without the deps, `apps/mobile/tsconfig.json:2` `extends "expo/tsconfig.base"`
   fails (`TS6053`) and every downstream import resolves to nothing: 10 311
   errors, all cascading. `bun install --frozen-lockfile` (lockfile unchanged,
   `git status` clean) → `tsc -p apps/mobile --noEmit` → **0 errors**. No source
   file was touched for this.
2. **Three stale mobile test files, from a merge base two commits early.** The
   branch last merged main at `a82c085e`; main then landed `91c76dbe`
   (`fix(shell-intent-line): main-merge gate fails`), which updated exactly
   `apps/mobile/test/{notice-row,pairing-guards,tool-rows-wiring}.test.ts` to the
   source's current shape. Our copies still asserted the pre-shell-intent-line
   form, so 3 tests failed against correct source (`session/notice` `looks` dep
   as regex-membership; `shell-rows-expo.ts` in the Keychain-importer list;
   `node === "thinking" || shimmer === true`). Applied that upstream patch
   verbatim (`git apply`, files only — no checkout/merge/commit): 39 pass, 0 fail.

Gate status in this worktree after the fix: `tsc --noEmit` (root),
`tsc -p apps/mobile`, `tsc -p apps/relay` → all exit 0; `biome check` on the 3
changed files → clean; narrow tests: 39 (mobile) + 157 (tui) + 14 + 18 → 0 fail.
The full suite stays the orchestrator's.

### Main-merge fix

*— claude-opus-5-5, 2026-11-22*

Merging this branch into `main` (after `feat/shell-intent-line`) failed the gate
in exactly 5 tests, in two test files
(`.tentacle/tmp/tui-mascot-gate-main.log`). Both were ours to fix, in different
ways: one was a real violation, one was an expectation written before the
header existed.

**1. `theme-no-stray.test.ts` › no hex literal — a REAL violation, fixed in the
source.** The nine palettes sat as hex literals in `mascot.ts:55-63`. The rule
(`test/theme-no-stray.test.ts:1-18,49-55`) is that `theme.ts` is the ONE file
allowed to name a colour, because a hex written anywhere else escapes the light
palette and no test notices. The plan's `Files` list had this wrong when it put
the palettes in `mascot.ts`.

Fixed by moving the table, not by relaxing the rule:
`theme.ts:115-137` now declares `MascotTone` / `MascotPalettes` and
`MASCOT_PALETTE_NAMES` (the `const` tuple, so the union type survives), and
`MASCOT` (`theme.ts:186-206`) holds the nine palettes **verbatim**; it hangs off
`Tokens.mascot` and both `DARK`/`LIGHT` point at the same object
(`theme.ts:260,327`) — one set for both themes, exactly owner Q4
("keep all 9 in both themes"), which is why it is keyed off `tokens` and not off
a `ThemeMode`. `mascot.ts` keeps its pure half unchanged (bitmap, `pairCell`,
`mascotCells`, `headerView`, `pickPalette`) and now reads
`PALETTE_NAMES`/`MASCOT_PALETTES`/`Palette` from `tokens.dark.mascot`
(`mascot.ts:32-44`) — the tokens are read at call time like every other token,
never frozen into a module constant (`theme-contrast.test.ts`'s rule). No hex
value changed and no public name changed, so `mascot.test.ts`'s verbatim table
and its 256-downgrade distinctness check still pass untouched.

**2. `subagent-panel-frames.test.tsx` F15, 4 cases — a STALE expectation, not a
fit break; expectations updated under Q1.** The four failures were only the two
`nothing in the frame says the model` lines, at 190 and at 80 columns
(`:756`, `:770` before this change — `:776`, `:790` after). Key point: **the fit
contract itself was never broken** — every length/height assertion in `at()`
(`:727-733`, ≤ `columns` wide, ≤ 24 rows) passed at both widths, including with
the 3-line header present. What changed is that the frame now legitimately
contains the model name on the header's second line (`qwen3-27b · /tmp/work`,
line 2), which is Q1's **owner-accepted** decision: create the 3-line header and
**replace** `WELCOME` with it, on a fresh start (`docs/feat/tui-mascot.md`
Questions Q1/Q2, "Owner 2026-11-21, Q1–Q4: accepted as recommended"). So the
assertion, written when the input rule was the frame's only model mention, had
to be re-aimed rather than the header removed — the rule it encodes ("the dock
never repeats the model") is still real and still worth pinning.

The two `expect(lines.some(l => l.includes("qwen3-27b"))).toBe(false)` lines
became one helper, `expectNoModelOnTheDock` (`:747-758`): exactly ONE line names
the model, it is the header's own `<model> · <cwd>` shape (not a rule carrying
the name), and it sits ABOVE the dock's rule. That is strictly stronger than the
old line in the way that matters — the old form would also have passed with a
model-bearing rule two lines above the dock, and the new one cannot — and it is
unchanged in the way the test cares about: no rule of the dock names the model.
The dropdown case's separate `inputRule` plainness assertion
(`:773-774`, `/^─+$/`) was already there and is untouched.

**Verified.** `bun test packages/tui/test/subagent-panel-frames.test.tsx
packages/tui/test/theme-no-stray.test.ts` → 38 pass, 0 fail. Related files (so
the palette move is pinned beyond the scan): `mascot`, `theme`, `theme-contrast`,
`render-lines`, `app-frames` → 169 pass, 0 fail. `tsc --noEmit -p packages/tui`
→ 0 errors (with `@tentacle/protocol` linked into this worktree for the check
only; the link was removed afterwards). `biome check` on `packages/tui/src` +
`packages/tui/test` → clean.

**Test non-vacuity (both mutations run, then reverted).** (a) Making the PLAIN
rule carry the model (`status-line.ts` `case "plain": modelBorder(model, w)`) →
2 F15 failures, caught by the pre-existing `inputRule` plainness assertion, so
that property was already pinned. (b) Making only the TARGET rule carry the
model (``─ → ${rule.id}${keys} qwen3-27b ···``) → 2 F15 failures at 190 and 80,
caught by `expectNoModelOnTheDock` alone — i.e. the new helper is what holds the
"no model on the dock's rules" line where it was previously unproven. Both edits
restored; `git diff` shows only the three intended files.

### Adversarial review (fresh context)

*— claude-opus-5-5, 2026-11-21*

**Verdict: APPROVE.** No HIGH or MEDIUM findings. The scope reviewed is the
task's own diff, `312c634d..HEAD`. The rest of `main...HEAD` is merged main work.

- **Gate:** the 8 touched test files give 293 pass, 0 fail. `bun run lint` is
  clean (2218 files). `bun run typecheck` (root, mobile and relay) exits 0. I did
  not run the full `bun test` here; the orchestrator's merge gate runs it.
- **Mutations (each one reverted; `git status` clean afterwards):** changing the
  width rule from `>=` to `>` in `mascot.ts` fails 1 test (the width boundary).
  Disabling the `header` skip in `commands.ts` fails `/save never exports the
  header`. The executor's three mutations are recorded above and I did not
  repeat them.
- **§7 invariants:** persistence is unaffected, because `HeaderItem` is
  display-only and is never written or exported. No protocol schema or terminal
  I/O path changes. All three `startTui` call sites pass `version`, and the
  local site is pinned by a test that drives the real `main`. Logic sits in the
  pure `mascot.ts`, and `headerLines` only maps the result to strings.
- **Attacks that found nothing:**
  1. Code that depends on the old welcome being an assistant item. The `chat`
     merge at `state.ts:555`, the answer counts at `state.ts:319,345` and
     copy-last at `commands.ts:548` all now skip the header, which is better
     than before.
  2. `items[0]` or `items.length <= 1` checks: none exist.
  3. Splitting a sprite row on wrap. With the mascot shown, every row is at most
     `width` cells, so `fitsUnchanged` (`render-lines.ts:1238`) holds.
  4. Palette stability. `useRef`'s initializer calls `pickPalette` again on each
     render, but only the first value is ever stored.
- **Low notes:**
  - The header's model is captured at mount, so it is not updated after
    `/model`. This is acceptable because the header is history.
  - The red-before-green run was not captured; mutation evidence stands in
    for it.
- **Model:** the same family as the plan's author (Opus) and the executor's
  finishing pass, so shared blind spots are possible. The blast radius is
  `cross-module`, so this level of review is acceptable.
