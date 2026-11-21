# feat/tui-mascot — Polpetto, a pixel mascot in the TUI startup header

> **Status:** implementation
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

## Review
