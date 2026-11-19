# fix/tui-line-diff-render — repaint only the rows that changed (the flash on terminals without mode 2026)

> **Status:** implementation APPROVED by the owner (2026-11-19)
> **Branch:** `fix/tui-line-diff-render`
> **Type:** fix · **Size:** S–M · **Blast:** cross-module (terminal I/O path: every byte Ink writes) · **Suited:** strong model executes (one slice `all`; a byte-level renderer, the `fs_edit`-corruption class if it goes wrong); fresh-context Review + owner live check in a terminal WITHOUT mode 2026
> **Changelog:** `changelog.d/tui-line-diff-render.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-19*

Follow-up of `fix/tui-redraw-flash` (merged `7ca9a280`), its Q2: "Line-diff
renderer … the only cure on terminals without mode 2026 (Terminal.app) … build
only if the owner still sees the flash after this fix, or uses Terminal.app
daily." That fix bracketed every Ink frame in DEC synchronized output
(`packages/tui/src/sync-output.ts`, wired at `packages/tui/src/run.tsx:219-221`).
A terminal that implements mode 2026 (iTerm2, Ghostty, kitty, WezTerm, recent
tmux) no longer paints half a frame. A terminal that does not (Terminal.app is
the one named; an old tmux; the Linux console; some ssh-hop setups) still
receives, ~12.5×/s while "Thinking…", a write that **erases the whole screen and
redraws all of it** — the mechanism of the flash, untouched there.

**Symptom characterization (AGENTS §1).** Inherited from the redraw-flash
Context (trigger: the 80 ms Thinking tick; magnitude: random, "ogni tanto" ⇒
tearing; collateral: none). *Not yet re-characterized after the 2026 fix:*
which terminal still shows it is Owner question 1.

**Repro** (2026-11-19, `.tentacle/tmp/tui-line-diff-render/repro.ts`, run on
this branch = `main` @ `81e59f6b`). Real `App`, Ink's real non-debug renderer,
the shipped `synchronizedStdout` around a fake TTY (100×30) recording every
`write`, a `createSession` whose `send()` never yields. Each recorded write is
stripped of BSU/ESU and of Ink's `eraseLines(n)` prefix; the remaining frame body
is split into rows and compared with the previous frame's rows.

```ts
// core (full script: same harness as docs/fix/tui-redraw-flash.md's repro, + this)
const ERASE_UNIT = "\x1b[2K\x1b[1A";
const body = (w: string) => {               // BSU…ESU → eraseLines(n) + frame → frame
  let s = w.startsWith(BSU) ? w.slice(BSU.length, -ESU.length) : w; let n = 0;
  while (s.startsWith(ERASE_UNIT)) { s = s.slice(ERASE_UNIT.length); n++; }
  if (s.startsWith("\x1b[2K")) { s = s.slice(4); n++; }
  if (s.startsWith("\x1b[G")) s = s.slice(3);
  return { n, s }; };
// per frame: rows = s.split("\n"); changed = #k with rows[k] !== prev[k];
// openAtEnd(row) = the last SGR code in the row is not a reset/close (0/22/23/24/27/29/39/49)
render(h(App, props), { stdout: synchronizedStdout(out), stdin, stderr, exitOnCtrlC: false, patchConsole: false });
// (a),(b): type "hi", "\r", wait 300 ms, reset, record 3 s.  (c) type 10 chars, 60 ms apart.
```

Output (`FORCE_COLOR=3 bun .tentacle/tmp/tui-line-diff-render/repro.ts`):

| trigger | frames | rows rewritten | rows changed | changed/frame | body bytes | rows with SGR | rows with SGR open at end |
|---|---|---|---|---|---|---|---|
| (a) Thinking 3 s, short transcript | 39 | 1131 | **38** | **1–1** | 36 332 | 312 | **0** |
| (b) Thinking 3 s, styled transcript > rows | 39 | 1131 | **38** | **1–1** | 83 366 | 663 | **0** |
| (c) typing 10 chars, idle | 10 | 290 | **9** | **1–1** | 6 745 | 60 | **0** |

(Without `FORCE_COLOR` the counts are the same with no SGR at all: the fake TTY
does not make chalk colour; forcing it is what makes the last column meaningful.)

**What the evidence says.**
1. Every frame rewrites **29 rows** (`rows − 1`) and exactly **one** changed:
   the spinner/timer row while Thinking, the input row while typing. 96.6 % of
   the repaint — and all of the erase-then-draw window — is redundant.
2. **No row leaves an SGR attribute open** (0 of 975 styled rows). Each row can
   be rewritten on its own without inheriting or leaking colour from a
   neighbour. That is the property a per-row repaint needs (Implementation,
   load-bearing assumption).
3. Bytes per Thinking tick at 100×30 with colour: ~930 (a) to ~2 140 (b). A row
   diff sends one row: tens of bytes. Secondary win for ssh / slow links.

**Constraints.** Ink 5.0.1 + React 18.3.1 pinned (AGENTS §6; Ink 6+ needs React
19 — `docs/eval/react-19-migration.md` notes Ink 7's `incrementalRendering`
solves this upstream, not available to us). No patching `node_modules`. AGENTS §7
"never write raw to the terminal while Ink owns it": the fix may only *rewrite
Ink's own writes*, never add one of its own. §7 "logic lives in pure modules":
the diff is a pure, React-free, unit-tested function.

## Implementation

*— claude-opus-5-5, 2026-11-19*

### Load-bearing assumption

**Ink's frame write is `eraseLines(P) + body`, where `P` is exactly the
`"\n"`-split length of the previous frame body, and the terminal cursor before
it sits at column 1 of line `P − 1` relative to the frame's top line.** If that
holds, a stream wrapper that recognizes the write can replace it with "move to
each changed row, erase it, write it" and then park the cursor where Ink
believes it is — so the *next* Ink write, recognized or not, lands exactly as
it does today.

Evidence:
- `log-update.js:13-18`: `previousOutput = output; stream.write(ansiEscapes.eraseLines(previousLineCount) + output); previousLineCount = output.split('\n').length` with `output = str + '\n'`.
- `ansi-escapes/base.js:77-89` (7.3.0, the copy Ink resolves): `eraseLines(n)` = n × `ESC[2K`, a `ESC[1A` between each, then `ESC[G`; `eraseLines(0)` = `""`.
- Body ends in `"\n"`, so after writing it the cursor is at column 1 of line
  `split("\n").length − 1` = `P − 1`. `eraseLines(P)` then walks up `P − 1` lines
  to the frame top: consistent.
- Repro: the parser above recovers a 30-piece body from every write (29 rows +
  the empty piece after the trailing `\n`), i.e. `n = P = 30` on every frame.
- SGR self-containment per row: repro column "open at end" = 0.

### Preconditions

- The TUI's Ink stdout is already an injected wrapper at one call site
  (`run.tsx:219-221`, `fullscreen ? synchronizedStdout(process.stdout) : process.stdout`).
  The new wrapper composes with it (Ink → row diff → BSU/ESU; order corrected in Execution, drift 1): `lineDiffStdout(synchronizedStdout(process.stdout))`,
  so a diffed write is still one BSU…ESU update.
- The frame never moves: alt screen entered with `ESC[H` before mount
  (`terminal.ts:20`, `run.tsx:137`); the frame is always `rows − 1` rows
  (`app-layout.ts` `RESERVED_ROWS` slack row, redraw-flash Context §1), so Ink's
  normal path is `throttledLog`, not `clearTerminal` (`ink.js:121-134`).
- The only other Ink writes to stdout: `clearTerminal + static + output`
  (`ink.js:122`, frame ≥ rows), `log.clear()` + data + `log(lastOutput)` (patched
  console / `useStdout().write`, `ink.js:153-155`), `cliCursor.hide/show(stdout)`
  at mount/unmount, nothing for `<Static>` (unused: `rg "<Static" packages/tui/src`
  → a comment only). All of these are *unrecognized* by design (see Design 3) and
  pass through untouched.
- Frame rows carry SGR only — no cursor CSI, no OSC 8 (`rg '\]8;' packages/tui/src` →
  none; the only OSC is the pre-mount background probe, `terminal-background.ts:38`).
- `render.js` keys Ink instances by the stdout object (redraw-flash Review): one
  new wrapper per `startTui`, no clash.

### Design

1. **Pure module `packages/tui/src/line-diff.ts`** (React-free, no I/O):
   - `parseFrameWrite(chunk: string, prevCount: number): string[] | null` —
     returns the body rows iff `chunk === eraseLines(prevCount) + body`, `body`
     ends in `"\n"`, and `body` contains no `ESC` other than `ESC[…m` (SGR).
     Else `null`. Builds `eraseLines` locally (a 6-line copy of the 7.3.0
     function, pinned by a test against `ansi-escapes` itself — see T5).
   - `diffFrame(prev: string[], next: string[]): string | null` — `null` when
     `prev.length !== next.length` (height change ⇒ let Ink's own bytes through).
     Else, from the cursor at line `L = prev.length − 1`, for each index `i < L`
     with `next[i] !== prev[i]` in ascending order: a relative move
     (`ESC[{d}A` up / `ESC[{d}B` down from the current line, never absolute — the
     anchor stays Ink's), `\r`, `ESC[2K`, `next[i]`, plus `ESC[0m` only if
     `next[i]`'s last SGR leaves an attribute open (never today — repro — but it
     would otherwise tint the next `ESC[2K`). Finally move back down to
     line `L`, `\r`. No changed row ⇒ `""` (Ink already skips identical output,
     `log-update.js:12`, so this is defensive).
   - Row granularity only: a changed row is erased and rewritten whole — no
     intra-row diff (wide chars, SGR runs, wrap state are never split).
2. **Wrapper `lineDiffStdout(stream)`** in the same file (the thin stateful
   shell; the only state is `prev: string[] | null`, `prevCount: number`,
   `size: "colsxrows"`). Same delegation shape as `synchronizedStdout` (live
   `columns`/`rows`/`isTTY` getters, listeners forwarded to `stream`, explicit —
   not `Object.create`). `write(chunk, ...rest)`:
   - not a non-empty string ⇒ pass through, `prev = null`.
   - size changed since `prev` was recorded ⇒ pass through, re-seed from the
     parsed body if it parses, else `prev = null`. (Checked from the live
     getters inside `write`: no dependency on `resize` listener order.)
   - `rows = parseFrameWrite(chunk, prevCount)`; `rows && prev` and
     `diffFrame(prev, rows) !== null` ⇒ `stream.write(diff, ...rest)`;
     `prev = rows`.
   - parses but no `prev` / height changed ⇒ pass through (Ink's exact bytes),
     `prev = rows`.
   - anything else (clearTerminal, `log.clear()`, cursor show/hide, a
     `useStdout().write`) ⇒ pass through, `prev = null`, and track `prevCount`
     the way Ink does: a chunk that ends a recognizable frame sets it to the body
     length; a bare `eraseLines(k)` (Ink's `log.clear()`) sets it to 0; a
     `clearTerminal…` write sets it from its body. Rule of thumb, stated in the
     module comment: **when in doubt, emit Ink's bytes and forget `prev`** — the
     worst case is exactly today's behaviour for one frame.
3. **Wire once** in `run.tsx:219-221`:
   `lineDiffStdout(synchronizedStdout(process.stdout))`, same `fullscreen` gate.
   Kill switch per Owner question 3.
4. Not in scope: intra-row diffing; a periodic or Ctrl+L full repaint (Owner
   question 4); the session picker (no animation, as in redraw-flash Q5); the
   < 9-row `clearTerminal`-per-tick case (passes through, unchanged — redraw-flash Q4 debt).

§7 check: the wrapper adds no write of its own — it *replaces* one Ink write
with one write carrying the same visible end state, and every unrecognized write
is Ink's verbatim. No protocol, persistence or daemon change ⇒ no `protocol.d/`
note.

### Files

1. `packages/tui/src/line-diff.ts` — new, ~110 lines (pure `parseFrameWrite`,
   `diffFrame`, + `lineDiffStdout`).
2. `packages/tui/src/run.tsx` — the `stdout:` expression (one line + import,
   + the kill-switch read if Q3 = yes).
3. `packages/tui/test/line-diff.test.ts` — new: unit (T2–T5).
4. `packages/tui/test/line-diff-render.test.tsx` — new: T1 + T6 (real Ink on a
   fake TTY + a VT screen emulator, below).
5. `packages/tui/test/sync-output.test.tsx` — T3 there (wiring structure) is
   updated to the composed expression.
6. `changelog.d/tui-line-diff-render.fixed.md` — `- **Smoother redraws on every terminal.** The TUI now repaints only the rows that changed …`.

### Failure modes

- **Ink changes its write shape** (an Ink bump): `parseFrameWrite` stops
  matching ⇒ every write passes through ⇒ today's behaviour, no corruption. T5
  pins our `eraseLines` copy to `ansi-escapes`; an Ink 6+ migration
  (`docs/eval/react-19-migration.md`) must revisit this module (note it there).
- **Height change** (palette/dock open never changes it today, redraw-flash
  repro (c); a resize does): `diffFrame` → `null` ⇒ Ink's full write.
- **Resize**: size compared on every write via live getters ⇒ the first frame
  at the new size is Ink's full write (and its `clearTerminal` on shrink,
  redraw-flash (d), passes through). T4 pins it; mutation: cache the size at
  wrap time.
- **Cursor out of Ink's model after a diff**: the diff always ends at line `L`,
  column 1, `\r` — Ink's own post-frame position. Any following unrecognized
  write therefore behaves as today. T6 proves the end state on a screen model.
- **Screen disturbed outside Ink** (iTerm "Clear buffer" Cmd+K, a stray write by
  a child process — forbidden by §7 but possible): today an animating frame
  repaints everything every 80 ms and self-heals; with the diff only changed rows
  return. Idle is identical to today (Ink writes nothing when idle either).
  Recovery: any resize / height change / unrecognized write repaints fully.
  Owner question 4 decides whether to add Ctrl+L.
- **Width disagreement** (an emoji/ambiguous-width glyph Ink measures as 1 cell
  and the terminal as 2 ⇒ the row wraps into the next): today the whole frame is
  re-erased each tick, so the damage moves/heals; with the diff a wrapped row
  can corrupt an unchanged neighbour until it changes. Same root bug as today,
  more persistent. Mitigation is the width fix, not the renderer; listed as a
  Review attack.
- **SGR leak across rows**: assumption proven by repro (0 open rows) and pinned
  by T3: the guard in Design 1 (`ESC[0m` after a rewritten row whose last SGR
  is open) keeps an open attribute from tinting the next row's `ESC[2K`.
- **Partial `write`** / back-pressure: one diff = one `write` string ⇒ ordering
  holds, and it stays inside one BSU…ESU (composition order in Design 3).
- **Non-TTY / piped**: not wrapped (gate), bytes unchanged.
- **Unmount**: Ink's final `onRender` + `log.done()` (`ink.js:179-194`) — the
  last frame may be diffed (fine), then `LEAVE_FULLSCREEN` goes to raw
  `process.stdout` after unmount (`run.tsx:133`, `terminal.ts:56`) ⇒ unaffected.

### Tests

Red before green (§9): the executor first wires `lineDiffStdout` as an
**identity pass-through** in `run.tsx`; T1 must be red against it (output in
Execution), then the real diff makes it green.

- **T1 (the bug's property, red today): a Thinking tick repaints only the changed
  row.** Real `App`, Ink's real non-debug `render`, fake TTY 100×30 through
  `lineDiffStdout(synchronizedStdout(fake))`, hanging `send()`, `FORCE_COLOR`-style
  colour forced in the test (chalk level set explicitly). After ~400 ms of ticks,
  every write after the first frame contains **no** `ESC[2J` and **at most 1**
  `ESC[2K` (one changed row), and ≥ 3 such writes were recorded (non-vacuous).
  Identity ⇒ 30 `ESC[2K` per write ⇒ red.
- **T6 (the exact property: what the user SEES is unchanged).** Same mount, but
  the fake TTY also feeds every write into a minimal VT screen model in the test
  (`ESC[2K`, `ESC[nA/B`, `ESC[G`, `\r`, `\n`, SGR ignored, `ESC[2J ESC[3J ESC[H`)
  — ~40 lines in `test/`, no new dependency. Run the same session twice, once
  through `lineDiffStdout`, once raw; after each tick the two screen grids are
  **identical**, and the cursor ends at the same cell. This is the property the
  fix must not break; T1 alone ("fewer bytes") would pass on a renderer that
  draws the wrong row. Mutations: off-by-one in the up-move; skip the final
  move-down — each must turn T6 red.
- **T2 (unit, `diffFrame`):** equal height, one changed row ⇒ exactly one
  `ESC[2K`; first/last row changed; several rows (ascending, relative moves);
  no change ⇒ `""`; height differs ⇒ `null`.
- **T3 (unit, SGR guard):** a changed `next` row ending with an open SGR ⇒ the
  diff emits `ESC[0m` right after it; a closed one ⇒ no extra reset.
- **T4 (unit, wrapper fallbacks):** unknown write ⇒ verbatim + next frame
  verbatim; `clearTerminal…` ⇒ verbatim; bare `eraseLines(k)` (`log.clear()`)
  ⇒ verbatim and the following `eraseLines(0)+body` is recognized; size change
  ⇒ verbatim (mutation: size cached at wrap time ⇒ red); non-string / empty ⇒
  verbatim; `rest` (encoding/callback) forwarded; live getters + listeners on
  the real stream.
- **T5 (pin):** our `eraseLines(n)` === `ansi-escapes`' `eraseLines(n)` for
  n ∈ {0, 1, 2, 30} (imported from Ink's resolved copy).
- **Structure:** `sync-output.test.tsx` T3 asserts `run.tsx` passes
  `lineDiffStdout(synchronizedStdout(process.stdout))` under the `fullscreen`
  gate. Mutation: drop `lineDiffStdout` ⇒ red.
- **T7 (manual, the visible property):** owner, in the terminal named in Q1
  (and one 2026 terminal), a long Thinking turn: no flash, no stale/garbled
  rows; open/close the palette, resize, Cmd+K. Record which terminals.

### Owner questions

1. **Is the flash still visible after `fix/tui-redraw-flash`, and in which
   terminal?** This task is the conditional follow-up (redraw-flash Q2).
   *Recommendation: build it if the answer is "yes" or you use Terminal.app /
   tmux / ssh daily; otherwise park this doc (the repro stays valid) — it adds a
   byte-level renderer to the hottest I/O path.*
2. **Approach: row diff inside a stdout wrapper (this plan) vs. waiting for Ink 7
   `incrementalRendering` via the React 19 migration?** *Recommendation: the
   wrapper — ~110 lines, falls back to Ink's exact bytes on anything it does not
   recognize, and is deleted by the migration when it lands.*
3. **Kill switch** (`TENTACLE_TUI_FULL_REDRAW=1` → skip `lineDiffStdout`)?
   *Recommendation: yes, env only, undocumented in README — unlike mode 2026
   (ignored by spec), a renderer bug here would garble the screen, and the switch
   lets you keep working while it is fixed.*
4. **Ctrl+L forces a full repaint** (recovery after Cmd+K / a stray write)?
   *Recommendation: not in this task — idle already behaves like today and any
   resize repaints; add it as a follow-up only if T7 or daily use hits a stale
   screen (it needs App key-routing plumbing, the known debt).*
5. **Intra-row diff** (rewrite only the spinner glyph + timer, not the whole row)?
   *Recommendation: no — row granularity already cuts ~97 % of the repaint, and
   splitting rows reopens wide-char/SGR edge cases.*

#### Owner answers (2026-11-19)

1. Yes — the flash is visible: the demo terminal answers the DECRQM 2026 probe with nothing (Terminal.app-like). Build it.
2. The wrapper now; it is deleted by the React 19 / Ink migration when that lands (`docs/eval/react-19-migration.md` now notes Ink ≥ 6.8 ships `incrementalRendering`).
3. Yes — `TENTACLE_TUI_FULL_REDRAW=1`, env only, undocumented in README.
4. No Ctrl+L in this task (follow-up only if needed).
5. No intra-row diff — row granularity.
Stream render cap (the triage's 10–15 fps): left out; add only if Terminal.app still shows a flash after the row diff.

*— claude-opus-5-5 (orchestrator, recording the owner's answers), 2026-11-19*

## Execution

*— claude-opus-5-5, 2026-11-19*

**Load-bearing check (re-run first, holds).** `repro.ts` on this branch: every
Thinking/typing frame rewrites 29 rows and changes exactly 1; 0 of 975 styled rows
leave SGR open. Ink 5.0.1 `log-update.js` writes `eraseLines(previousLineCount) + str + "\n"`;
the `ansi-escapes` Ink resolves is 7.3.0 (`eraseLines` = n×`ESC[2K` with `ESC[1A`
between, then `ESC[G`).

**Built** (order of the plan):
1. `packages/tui/src/line-diff.ts` — pure `eraseLines` (pinned copy), `parseFrameWrite`,
   `sgrOpenAtEnd`, `diffFrame`; the stateful shell `lineDiffStdout` (state: `prev` rows +
   the `colsxrows` it was drawn at, read live at every write); `lineDiffEnabled(env)` /
   `FULL_REDRAW_ENV` (the kill switch, a pure function).
2. `packages/tui/src/run.tsx:219-227` — under the same `fullscreen` gate:
   `lineDiffEnabled(process.env) ? lineDiffStdout(synchronizedStdout(process.stdout)) : synchronizedStdout(process.stdout)`.
3. Tests: `test/line-diff.test.ts` (T2–T5 + kill switch, 24 tests),
   `test/line-diff-render.test.tsx` (T1, T6 with a VT screen model in the test, colour
   forced via `chalk.level = 3`), `test/sync-output.test.tsx` T3 updated to the composed
   expression.
4. `changelog.d/tui-line-diff-render.fixed.md`.

**Drift from Implementation (and why).**
1. **Composition order was inverted in the plan.** `synchronizedStdout(lineDiffStdout(x))`
   makes Ink write to the BSU/ESU wrapper first, so the row diff only ever sees
   `BSU + frame + ESU`, never parses it, and passes everything through (found by T1:
   30 `ESC[2K` per write). The order that matches the plan's intent ("a diffed write is
   still one BSU…ESU update") is `lineDiffStdout(synchronizedStdout(x))`: Ink → diff →
   bracket. Fixed in code, tests and the plan text above.
2. **No `prevCount` tracking.** `parseFrameWrite(chunk)` returns `{ erased, rows }` and
   the shell diffs only when `erased === prev.length` (same size, nothing unrecognized
   in between). The safety condition is read from Ink's own bytes instead of mirroring
   Ink's private counter — which matters: Ink's `clearTerminal` branch (`ink.js:121-124`)
   does NOT update `log-update`'s `previousLineCount`, so the plan's "a clearTerminal
   write sets it from its body" would have mirrored it wrongly (harmless — it falls back
   — but needless). Any `eraseLines(k)+body` re-seeds `prev` (verbatim write).
3. **SGR guard: fall back instead of appending `ESC[0m`.** If any row of `prev` or `next`
   leaves an attribute open, `diffFrame` returns `null` ⇒ Ink's full write. A reset after
   the rewritten row would stop it tinting its own `ESC[2K`, but not reproduce a
   neighbour's colour that Ink's full repaint lets a row inherit — so the screen could
   differ from Ink's. Falling back is the plan's own "when in doubt, Ink's bytes" rule.
   T3 asserts this shape (open ⇒ `null`; closed ⇒ diffed, no extra reset). Never hit
   today (0 open rows).
4. `parseFrameWrite` also rejects control bytes other than `\t`/`\n` in the body (a
   `\r` or a cursor CSI would break the per-row model).
5. Red-before-green done by mutation of the finished wrapper (identity `write`) rather
   than wiring an identity stub first — the same check.

**Red before green / non-vacuity (each mutation applied alone, then restored):**

| mutation | result |
|---|---|
| M1 wrapper identity (`if (false)` for the diff branch) | T1 red (30 `ESC[2K` per write), T6 red (non-vacuity guard) |
| M2 off-by-one up-move (`up(cursor - i - 1)`) | T6 red |
| M3 final move-down dropped | T6 red |
| M4 size cached at first write | T4 "size change" red |
| M5 SGR guard removed | T3 red |
| M6 `erased === prev.length` check removed | T4 "erase count" red |
| M7 `lineDiffStdout` dropped from `run.tsx` | sync-output T3 red |
| M8 composition order inverted in `run.tsx` | sync-output T3 red |

**Measurement 1 — fake TTY 120×40, triage harness** (`tui-flash-1119/capture.ts` adapted:
`FULL=1` = before = `synchronizedStdout` only; after = `lineDiffStdout(synchronizedStdout(…))`;
"lines rewritten" = `ESC[2K` per write; `FORCE_COLOR=3`):

| scenario | writes/s | lines rewritten/write before → after | bytes/s before → after | clearTerminal |
|---|---|---|---|---|
| A idle 3 s | 0 | – | 0 → 0 | 0 |
| B Thinking 5 s | 13 | 40 → **1** | 15 253 → **1 519** | 0 |
| B2 Thinking, long transcript | 13 | 40 → **1** | 44 412 → **1 538** | 0 |
| C streaming (token/15 ms), long transcript | 33 | 40 → **5.9** | 108 529 → **15 995** | 0 |
| D tool running | 14.3 | 40 → **1** | 18 630 → **1 735** | 0 |
| E resize shrink 120×40 → 80×24 | 6.7 | 20 → 20 (verbatim, by design) | 4 680 → 4 680 | 1/1 |
| F palette `/` open+close | 5 | 40 → 24.5 | 5 733 → 3 848 | 0 |
| G Thinking, tiny 120×8 | 14 | 0 → 0 (clearTerminal path, verbatim) | 11 709 → 11 709 | 42/42 |

**Measurement 2 — real pty 120×40, the CLI from this branch** (`bun packages/cli/src/main.ts`,
triage `pty.py` + `mock.ts` copied to `.tentacle/tmp/tui-line-diff-render/`, isolated HOME,
mock: 1.5 s silent then a token every 15 ms; `FULL=1` sets `TENTACLE_TUI_FULL_REDRAW=1`;
windows measured from the moment "hi⏎" is typed):

| run | Thinking (0.4–1.4 s) | streaming (2–7 s) |
|---|---|---|
| before (kill switch on) | 14.0 upd/s · 40.0 lines/upd · 24 278 B/s | 33.0 upd/s · 40.0 lines/upd · 95 445 B/s |
| after (row diff) | 14.0 upd/s · **1.0** lines/upd · **1 654** B/s | 32.6 upd/s · **1.1** lines/upd · **3 380** B/s |

(Streaming here starts from an empty transcript, so text does not scroll yet: 1.1 rows
change per update; once it scrolls, measurement 1 C applies, ~6 rows.) The kill switch
is thereby also verified end to end: with it, the bytes are exactly the old full repaint.

**Gate (2026-11-19):** `bunx tsc --noEmit` → 0 errors · `bun run lint` → `Checked 2122 files … No fixes applied` (clean) · full `bun test` → `15675 pass · 5 skip · 0 fail` (`Ran 15680 tests across 1113 files`); the new tests contain no skip, so the skips are the pre-existing opt-in ones. The full run left a stray `{"resident":false}` first line in `packages/tui/test/__snapshots__/diagram-lines.test.ts.snap` (a write by some other test, unrelated to this task); removed by hand — a pre-existing test-isolation leak worth its own fix.

**Owner check in Terminal.app (T7)** — from the repo, on this branch:
1. `bun packages/cli/src/main.ts` (or a build of this branch), send a prompt that thinks
   for a while: the screen must not flash; only the spinner row moves. Let it stream a
   long answer (scrolling): no flash, no stale or garbled rows. Open/close the palette
   (`/`, then Backspace), resize the window, Cmd+K.
2. Quit, then `TENTACLE_TUI_FULL_REDRAW=1 bun packages/cli/src/main.ts`, same prompt:
   that is the old renderer (the flash should be back) — the side-by-side difference.
3. Repeat step 1 once in iTerm2/Ghostty (mode 2026): must look exactly as before.
If anything garbles, `TENTACLE_TUI_FULL_REDRAW=1` is the workaround while it is fixed.

**Unverified:** a terminal whose glyph widths disagree with Ink's measurement (wrapped
row corrupting an unchanged neighbour, plan failure modes) — only the owner's T7 / the
Review can show it.

## Review

*— claude-opus-5-5, 2026-11-19* (fresh context, SAME model as the executor: shared blind spots possible)

**Verdict: APPROVE** — no HIGH/MEDIUM findings on `git diff main...HEAD`.

**Gate (touched scope):** `bun test` on `line-diff.test.ts`, `line-diff-render.test.tsx`,
`sync-output.test.tsx` → 32 pass · 0 fail · `bun run lint` clean (2122 files) ·
`bun run typecheck` 0 errors. Full `bun test` not re-run by this reviewer.

**Premises checked (TRUE):** `log-update.js:17` writes `eraseLines(previousLineCount) + output`;
`ink.js:121-122` clearTerminal branch does not update log-update's count (drift 2 is correct);
`ink.js:128-130`/`log.clear()` writes are erase-only (body lacks `"\n"` ⇒ unrecognized ⇒ `prev = null`);
`App.tsx:854-890` / `QueuedMessages.tsx` use `useStdout` only for size/resize, never `write`;
the only raw `process.stdout.write`s (`run.tsx:134,138,157`) are pre-mount/post-unmount.

**Mutations (own, each alone, tree restored byte-identical via `cmp` + clean `git status`):**
- `FORBIDDEN` guard disabled → `parseFrameWrite > rejects anything else` red.
- `prev = null` on an unrecognized write removed → 3 T4 fallback tests red.
The executor's M1–M8 table was not re-run in full (a batch script was not permitted).

**Attacks tried:**
1. useStdout/patched-console path (`log.clear` + data + `log(lastOutput)`): data ending `"\n"` is
   *recognized* and seeds `prev`, but the following `log()` erases 0 ≠ `prev.length ≥ 2` ⇒ verbatim.
   Holds.
2. Coincidental `erased === prev.length` after a non-Ink write: every non-frame Ink write is
   preceded by `log.clear()` (reset to 0), so the next erase is 0. Holds.
3. Resize races with the throttled log: size read live at each write; any write at a new size is
   verbatim; identical-output frames are skipped by log-update itself. Holds.
4. Full-width row + `CSI n B`/`CSI n A`: cursor moves clamp, never LF-scroll; ends at Ink's
   anchor via `\r`. T6 VT model pins screen+cursor equality. Holds.
5. SGR across rows: `diffFrame` falls back on any open attribute (drift 3) — stricter than plan.
   Holds.
6. Width disagreement (emoji measured 1, painted 2): diff can leave a neighbour corrupted until it
   changes — documented failure mode, kill switch `TENTACLE_TUI_FULL_REDRAW=1`; not a code defect.

**Nits (not blocking):** Failure-modes bullet "SGR leak" still describes the appended `ESC[0m`
design that Execution drift 3 replaced with a fallback — doc text is stale.

**Executor behaviour:** plan drift reported honestly (composition order, no prevCount mirror,
SGR fallback), mutation table and real-pty measurements included, unverified part named.
