# fix/tui-diff-tabs — A tab breaks the diff bars and long tool rows

> **Status:** done — reviewed (MERGE), owner merge OK 2026-10-25; gate 2662 pass / 2 skip / 0 fail
> **Branch:** `fix/tui-diff-tabs`
> **Size:** S · **Blast:** contained · **Suited:** Sonnet executes, Opus reviews

## Context

*— claude-sonnet-5-5, 2026-10-25*

Owner report (2026-10-25, screenshots): in a Write/Edit diff (full-width
green/red bars) every line that contains a TAB renders wrong — the bar sticks
out on the right, and under it a stray stripe of green background appears that
also starts further LEFT than the bars (left of the line-number gutter). The
background is not uniform.

**Cause (re-proved on current code, see Repro):** `renderBar`
(`render-lines.ts:174-199`) pads the bar to `width` with `plainLen =
row.text.length` — a tab counts as 1 cell, and CJK / emoji are miscounted too.
Ink passes the `\t` byte through to the terminal, which expands it to the next
8-column stop, so the "full-width" bar is wider than the screen; the terminal
hard-wraps it and the remainder is the stray stripe. The same pass-through
exists for tool output rows (`fs_read` / `shell` results keep `\t` after
`wrapLines`, `render-lines.ts:543`). Assistant markdown only partly expands tabs; the `wrapLines` catch-all covers
the rest.

**Owner decisions (fixed, not re-opened):**
1. A tab is shown as 4 spaces, exactly as in the prompt input: reuse
   `TAB_WIDTH` (`input-view.ts:36`). Display only: nothing sent to the model or
   stored changes.
2. Width math in display cells (`string-width`).
3. Diff colours like Claude Code (kept in `theme.ts` only; starting values, the
   owner will judge them on a build): added bg `rgb(2,40,0)`, word bg
   `rgb(4,71,0)`; removed bg `rgb(61,1,0)`, word bg `rgb(92,2,0)`; line text in
   the terminal's default foreground (changed words too); line number and
   `+`/`-` marker bright green `rgb(110,200,96)` / bright red `rgb(230,100,100)`.
4. The bar's left edge stays at the gutter column of the widest line number.
   Once the overflow is gone the stray stripe disappears; a test proves every
   bar row of one diff starts at the same column and has the same display width.

**Repro** (`.tentacle/tmp/tui-diff-tabs/repro.ts`, run 2026-10-25 on
`02e29a4`; width 60, `stringWidth` of a `\t` is 0, so the column is a lower
bound for tabbed rows; the bar should be 59 cells = 2 indent + 57):

```ts
import stringWidth from "../../../packages/tui/node_modules/string-width/index.js";
import { itemLines, stripAnsi, wrapLines } from "../../../packages/tui/src/render-lines.ts";

const W = 60;
const tool = (name: string, extra: object): any => ({
  kind: "tool", id: name, name, args: "{}", status: "ok", startedAt: 0, endedAt: 1, ...extra,
});
const diff = tool("fs_write", {
  detail: {
    kind: "diff", path: "p.go", added: 5, removed: 1,
    patch: "@@ -1,2 +1,6 @@\n-\told := 1\n+\tnew := 1\n+\t\t\"strings\"\n+中文中文中文\n+😀😀😀\n+x\n",
  },
});
const long = `func main() {\n\t${"word ".repeat(20)}\n}`;
const items = [
  ["diff", diff],
  ["fs_read", tool("fs_read", { args: '{"path":"m.txt"}', resultText: long })],
  ["shell", tool("shell", { args: '{"command":"cat m"}', resultText: long })],
] as const;
for (const [name, t] of items) {
  console.log("--", name);
  for (const r of wrapLines(itemLines(t, { width: W, expandAll: true } as any), W)) {
    const p = stripAnsi(r);
    console.log(p.includes("\t") ? "TAB" : "   ", String(stringWidth(p)).padStart(3), JSON.stringify(p));
  }
}
```

Output (before the fix; "TAB" = row still contains `\t`):

```
-- diff
TAB  58 "     - \told := 1                                           "
TAB  58 "   1 + \tnew := 1                                           "
TAB  57 "   2 + \t\t\"strings\"                                         "
     60 "   3 + 中文中文中文                                         "   <- 60 > 59
      5 "     "                                                         <- emoji row wrapped: bar split in two
     59 "   4 + 😀😀😀                                              "
     59 "   5 + x                                                   "
-- fs_read / shell
TAB  57 "  \tword word word word word word word word word word word "
     45 "word word word word word word word word word "
```

(In the terminal the `\t` rows are 8-stop wide: `" - "` + tab → col 8, so the
bar is ≥ 4 cells over; the CJK row is 1 cell over; the emoji row wraps.)

## Implementation

*— claude-sonnet-5-5, 2026-10-25*

### Load-bearing assumption

Every transcript row — collapsed view, Ctrl+O expanded view, row cache,
selection (`transcriptRows`) — goes through `wrapLines`: the only producers of
final rows are `itemRows` (`render-lines.ts:628`, the sole caller outside tests;
`layoutTranscript` `:663`, `transcriptRows` `:743`, `warmRowsChunk` `:725` all
go through `itemRows`). So expanding tabs at the top of `wrapLines` is a
catch-all for the tab byte. It is not enough for widths (a bar padded with the
wrong width stays wrong), hence the diff fix as well.

### Preconditions

- `TAB_WIDTH = 4`, display-only: `input-view.ts:36`, used `:63`, `:266`.
- `string-width` is already a `packages/tui` dependency (`input-view.ts:1`,
  `message-row.ts:10`).
- `wrapLines` input for user messages is `messageRows` (`render-lines.ts:65`),
  which measures with `stringWidth` — a `\t` is 0 cells there, so a tab in a
  user message would be padded wrong and then widened by the catch-all. It must
  be expanded before `messageRows` (display only: `item.text` is untouched).
- `/save` export and model input read `DisplayItem.text` / messages, not the
  rendered rows (rows are produced only by `render-lines.ts`, consumed by
  `App.tsx` for display and selection copy) — checked with grep below.

### Design

- `expandTabs(text)` in `input-view.ts` next to `TAB_WIDTH` (single source of
  the constant; `render-lines.ts` imports it): every `\t` → `TAB_WIDTH` spaces.
  Fixed-width replacement, not tab stops, to match the prompt input.
- `parseHunks` expands each row's `text` once, so `diffWords`, `changeRatio`
  and the padding see the same text; context rows are covered too.
- `renderBar`: `plainLen` by `stringWidth` (of `row.text` / of the word ops'
  values).
- `userLines`: `messageRows(expandTabs(text), …)`.
- `wrapLines`: `wrapAnsi(expandTabs(line), …)` — catch-all for tool output
  (`fs_read`, `shell`, sub-agent report, spill parts) and anything future.
- `theme.ts`: new diff palette (decision 3); `addFg`/`delFg` become identity
  (terminal default foreground), word styles carry only a background.

### Files

`packages/tui/src/input-view.ts`, `packages/tui/src/render-lines.ts`,
`packages/tui/src/theme.ts`; tests in `packages/tui/test/render-lines.test.ts`
and `packages/tui/test/input-view.test.ts`.

### Failure modes

- Tab inside a word-diff pair: both sides expanded before `diffWords` →
  identical text on both sides still pairs as `same`.
- Wide char at the width edge: `stringWidth` counts 2 cells, the pad is
  `max(0, …)`; a line longer than the bar is wrapped by `wrapAnsi` (as before).
- ANSI in a row: `expandTabs` only touches `\t`, never an escape sequence.
- Empty row: `wrapLines` still short-circuits `""`.
- Cache: `rowCache` keys on item identity + layout options; the change is
  deterministic in those, so no key change is needed.
- Tab/ESC inside shell output that the terminal would have rendered at a
  stop: now a fixed 4 spaces (decision 1), the only visible change.

### Tests

All in `render-lines.test.ts` unless noted; each red on `02e29a4` first:
1. A diff with tab-indented, CJK, emoji lines and a word-diff pair: no row
   contains `\t`; every bar row has the same display width (≤ width) and
   starts at the same column (the gutter), at several widths.
2. `fs_read` and `shell` items with a long tabbed line: no row has `\t`, all
   rows ≤ width.
3. User message with a tab: no `\t`, row width == width.
4. `wrapLines` direct: `\t` never survives, ANSI intact.

No palette test: the stylers in `theme.ts` bake chalk's colour level at import
time, so a test cannot force truecolour without a second theme instance; the
palette is pure data the owner judges on a build.

## Execution

*— claude-sonnet-5-5, 2026-10-25*

1. Baseline `bun run check` on `02e29a4`: typecheck ok, lint clean, **2653
   pass / 2 skip / 0 fail**.
2. Repro (Context) re-run before any edit: confirmed — tabbed bar rows keep
   `\t`, the CJK bar is 60 > 59 cells, the emoji bar wraps into two rows,
   `fs_read`/`shell` rows keep `\t`.
3. Tests written first (`render-lines.test.ts`, new `describe` "display cells…",
   8 tests). Red on the unfixed code: 8 failures (tab in diff rows, bar
   marker column / width, 4-space tab, word-diff pair, `fs_read`, `shell`, user
   message, `wrapLines`).
4. Fix: `expandTabs` next to `TAB_WIDTH` (`input-view.ts`); `parseHunks`
   expands every row (`render-lines.ts`); `renderBar` measures with
   `stringWidth`; `userLines` expands before `messageRows`; `wrapLines`
   expands before `wrapAnsi` (catch-all); `theme.ts` diff palette per owner
   decision 3 (`addFg`/`delFg` are identity functions).
5. Green: `render-lines.test.ts` 43 pass. Mutations (each reverted, the four
   touched files re-hashed byte-identical with `shasum`):
   - `plainLen` back to `.length` → bar-width test red;
   - no `expandTabs` in the `add` branch of `parseHunks` → bar-width and
     word-diff-pair tests red (the `wrapLines` catch-all alone leaves the bar
     wrong, as designed);
   - no `expandTabs` in `wrapLines` → `fs_read`, `shell`, `wrapLines` tests red;
   - no `expandTabs` in `userLines` → user-message test red (2 rows instead
     of 1).
6. Gate after: `bun run check` → typecheck ok, lint clean (Biome re-sorted one
   import), **2661 pass / 2 skip / 0 fail** (= 2653 + 8).

**Drift from Implementation:** (a) no `expandTabs` unit test and no palette
test (reason in Tests: the first would be red only by missing import; chalk
level is baked into the theme). (b) the width test uses a line short enough to
fit at width 30: a line longer than the bar is wrapped by `wrapAnsi` and its
continuation row is not a bar — pre-existing behaviour, untouched. (c) git
stash was not available in the session, so the "red on old code" run was done
before the fix, and the per-assertion red is shown by mutation.

**Checked, untouched:** rendered rows are consumed only inside `packages/tui`
(`rg` of `itemLines|wrapLines|transcriptRows` over `packages/`: no hit in
`cli`, `core`, `client`), so `/save` and the model input are not affected.
`queued-row`/prompt-input paths were not touched.

**Unverified:** the look of the new palette in a real terminal (owner to judge
on a build; values live only in `theme.ts:79-93`).

### Fix 2 (Review)

*— claude-sonnet-5-5, 2026-10-25*

1. Owner decision on the palette: line text no longer uses the terminal default
   foreground (unreadable on light themes). `addFg` / `delFg` are now
   `rgb(248,248,242)`, and `addWord` / `delWord` carry the same foreground on
   top of their background. Backgrounds and gutter colours unchanged
   (`theme.ts`).
2. Review finding 2: new test "a word-diff pair with CJK and emoji renders bars
   of exactly width cells" (`render-lines.test.ts`). Red under mutation M1
   (`stringWidth(op.value)` → `op.value.length` in the word-diff branch of
   `renderBar`): bar 60 cells instead of 59. Reverted; `shasum` of
   `render-lines.ts` identical before and after.
3. Doc nit (finding 3): the Context line on markdown tabs is corrected above.
4. Gate: see the final `bun run check` result in the report.

## Review

*— claude-opus-5-5 (fresh context; executor claude-sonnet-5-5, same family), 2026-10-25*

**Verdict: APPROVE-WITH-NITS.** The owner's bug is fixed on every transcript
path: no `\t` reaches Ink, and every bar is exactly `width` cells. Nothing
blocks the merge. Finding 1 needs an owner decision. Finding 2 is a
test gap worth closing on this branch.

### Gate (re-run by the reviewer)

`bun run check`: typecheck ok · `biome check .` 469 files, clean ·
**2661 pass / 2 skip / 0 fail** (2663 tests, 209 files). The skips are the
two opt-in ones. Matches Execution.

### Findings

1. **Copying text now gives spaces instead of tabs (owner decision, medium).**
   `App.tsx:1602` copies `extractSelection(rows.map(stripAnsi), sel)`, and
   those rows are the expanded ones. So code copied from the transcript
   (`fs_read`, diff, `shell` output) has 4 spaces where the file has a tab. A
   Makefile recipe or Go code pasted back gets the wrong whitespace. Before the
   fix, the copy kept the tab (but the display was broken). This follows from
   "display only" (decision 1): the model, the store and `/save` are untouched,
   but the clipboard is not. Owner: accept it, or map selections back to the
   source text (a separate task).
2. **Test gap (nit, fix suggested).** The `stringWidth` in the word-diff branch
   of `renderBar` (`render-lines.ts:199`) is not pinned. **Mutation M1**: I set
   it back to `op.value.length` and all 43 tests still passed. The word-diff
   test is ASCII-only, and once tabs are expanded `.length` equals the width.
   Add a word-diff pair with CJK text (e.g. `-名前 a` / `+名前 b`) to the
   equal-width assertion.
3. **The Context claims "Assistant markdown already expands tabs". That is
   only partly true (doc nit).** `renderMarkdown` on `02e29a4` expands
   leading-indent tabs but keeps inner ones. Output: `"    a\tb"`, `"x\ty"`.
   The new `wrapLines` catch-all now covers them, so there is no
   bug. Only the premise wording is wrong.
4. **Redundant code (nit).** `expandTabs` on context rows (`render-lines.ts:132`)
   is redundant: a context row is not a padded bar, so `wrapLines` already
   handles it. **Mutation M2** (removing it) left everything green. It is
   harmless and keeps `parseHunks` consistent. Keep it or drop it.
5. **Out of scope. These break the same property but predate this fix. Report
   only:**
   - **Raw control bytes in diff/tool text.** `\x1b[0m` inside a changed line
     resets the bar background in the middle of the row. `\r` is counted as
     0 cells, and the terminal returns the cursor to column 0.
   - **Paths outside the transcript where a `\t` still reaches Ink.**
     `queuedRows` (`message-row.ts:72`) only flattens newlines and measures a
     tab as 0. The permission dialog (`PermissionPrompt.tsx:50`) truncates by
     `.length`. A queued message or a permission subject with a tab can
     overflow its row.
   - **Width narrower than gutter + content** (W=8). Bars and dashed rules
     wrap onto extra rows.
   - These are candidates for a follow-up `fix`.
6. **Palette readability (owner judges).** `addFg`/`delFg` use the terminal's
   default foreground on a very dark bg (`rgb(2,40,0)` / `rgb(61,1,0)`). On a
   light terminal theme (dark default foreground) the text is dark-on-dark,
   which is hard to read. On a dark theme it is fine. Check this on the build.

### Premise table

| Premise | Result |
|---|---|
| Context symptom: tab bars keep `\t`; CJK bar 60 > 59; emoji bar wraps | TRUE. Repro re-run by the executor. My repro on the fixed tree: all bars 39/39 at W=40, no `\t` |
| `renderBar` used `.length` (`:174-199` old) | TRUE (diff) |
| `TAB_WIDTH = 4`, display only (`input-view.ts:36`, uses `:68`, `:271`) | TRUE |
| `string-width` is already a tui dependency | TRUE (`message-row.ts:10`) |
| `itemRows` is the only producer and goes through `wrapLines` (`:640`); `layoutTranscript`, `warm`, `transcriptRows` go through `itemRows` | TRUE. `App.tsx:618` only uses `layoutTranscript` |
| Assistant markdown already expands tabs | PARTLY FALSE (finding 3) |
| Model input / store / `/save` untouched | TRUE. `expandTabs` is used only in `render-lines.ts` (rg). The clipboard is the exception (finding 1) |

### Mutations

Each was reverted. The four files were re-hashed with `shasum` and are
byte-identical. `git status --short` is unchanged.

| Mutation | Result |
|---|---|
| M1: word-branch width back to `.length` | **Survived** (finding 2) |
| M2: no `expandTabs` on context rows | Survived. The mutant is equivalent (finding 4) |
| M3: no `expandTabs` on `del` rows | **Red.** 2 tests fail (equal bar width; word-diff pair) |

The executor's four mutations cover the other sites.

### Attacks tried

Scripts: `.tentacle/tmp/tui-diff-tabs-review/{repro,perf,md}.ts`. The full
transcript goes through `transcriptRows` / `wrapLines(itemLines…)`.

| Attack | Result |
|---|---|
| Combining marks, ZWJ family, flag, VS16, half-width kana at W=40 | Every bar is 39 cells |
| Tab inside a changed word (`a\tb` → `a\tc`) | The word ops line up with the shown text, and both bars are 39 cells |
| Collapsed view (`expandAll:false`) with a 40-line tabbed diff | No `\t` |
| Assistant markdown with a code block and inner tabs | No `\t` after `wrapLines` |
| `fs_read` Go file through the highlighter | No `\t`. Alignment uses fixed 4 spaces, not tab stops. Mixed tab/space indents can drift by up to 3 columns compared with an 8-stop editor. That is acceptable under decision 1 and the same as the prompt input |
| User message with tabs | One full-width row |
| Performance: 2000-line diff at W=120 | About 715 ms per full render (the row cache absorbs repeats). `stringWidth` × 2000 rows measured alone costs about 5 ms (≈1 %). The rest is pre-existing work (word diff + `wrapAnsi`). No regression worth noting |
| Control bytes and narrow width | Finding 5 (pre-existing) |

### What holds

The root cause is fixed at the right layer. In `parseHunks`, the word diff
and the padding see the same text. `wrapLines` is a real catch-all for every
transcript row. The helpers are pure and tested (§7). There is no
protocol, persistence or invariant change, so the blast radius is
**contained**, as stated.

### How the executor behaved

The executor wrote the Repro first, showed red before green, ran four honest
mutations, and declared its drift. One miss: it did not notice that the
word-branch width was unpinned (M1). The executor model and I are the same
model family, so we may share blind spots.

### Owner decisions on the findings

*— claude-opus-5-5 (orchestrator), 2026-10-25*

- **Finding 1 (copy):** keep "copy what you see" — a mouse copy now gives 4
  spaces where the source had a tab. Recorded as a follow-up in `TODO.md`
  (`8ed8a57`); a faithful copy needs the source text kept next to each
  rendered row.
- **Finding 6 (palette):** line text and changed words use an explicit
  near-white `rgb(248,248,242)`, not the terminal default foreground, so a
  light terminal theme stays readable. Applied in Fix 2.
- **Finding 2 (M1 unpinned):** fixed in Fix 2 (CJK + emoji word-diff pair,
  red under M1: 60 ≠ 59 cells).
- **Findings 3–5:** 3 fixed in the doc (Fix 2); 4 (redundant expansion on
  context rows) left, harmless; 5 (control chars, `queuedRows`,
  `PermissionPrompt` tabs, width 8) pre-existing and out of scope.
- Orchestrator gate after Fix 2: 2662 pass / 2 skip / 0 fail, lint clean.
