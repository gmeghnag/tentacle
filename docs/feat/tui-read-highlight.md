# feat/tui-read-highlight — Syntax colours in file reads

> **Status:** execution
> **Branch:** `feat/tui-read-highlight`
> **Size:** S · **Blast:** contained · **Suited:** Sonnet executes, Opus reviews (standard in-context Review)

## Context

*— claude-sonnet-5-5, 2026-10-25*

Owner's TODO entry (`TODO.md`, "TUI: syntax colours in file reads, by the file's language", 2026-10-25): a `Read` result (preview AND the ctrl+o expanded view) is coloured by the language of the file it read — Go, Python, JS/TS, Markdown, YAML, shell, Rust… — using the `cli-highlight` (highlight.js) dependency the TUI already has.
- Language from the file EXTENSION, never content auto-detection; unknown extension → plain text as today.
- Computed once per tool item and cached with the existing line cache, never re-highlighted on scroll; colours follow the theme (dark / light). Measure the cost.
- Known limit, accepted: a preview cut starting inside a multi-line comment/string may colour its first lines wrongly.
- Later, not now: the same colouring inside edit diffs.

**Repro (feat missing):** `itemLines` of an `fs_read` tool with `resultText` of a Go file produces `theme.subtle(line)` for every line (`render-lines.ts` `plainToolBody`, one grey colour, no language awareness).

## Implementation

*— claude-sonnet-5-5, 2026-10-25*

### Load-bearing assumption

The file path is available client-side with no protocol/daemon change: `ToolItem.args` is the tool call's JSON args string (`state.ts`, already parsed for the header by `toolTitle` → `toolSubtitle`, `render-lines.ts` case `"fs_read"` → `str("path")`). So the extension is read from `JSON.parse(tool.args).path`. Verified: no wire change needed → stays contained.

### Preconditions

- A Read result is `resultText` (`state.ts:58`, set at `state.ts:254`); `fs_read` returns the raw file, or `[path lines A-B of N]\n<slice>` for a ranged read (`packages/tools/src/builtins.ts` `fsReadTool`). It carries **no per-line number prefixes**; the only non-code line is that header. The path itself may carry a `:start:end` suffix (`parsePathRange`).
- Results become lines in `plainToolBody` (`render-lines.ts`, the `resultText` branch: `split("\n").map(theme.subtle)`); `toolLines` then collapses (`body.length > threshold` → first `preview` lines + "… more") unless `expandAll` (ctrl+o). Preview and expand therefore share that one site.
- Layout is cached per item identity in `rowCache` (`itemRows`), keyed on width/expand/threshold/preview; scrolling slices cached rows and never re-enters `toolLines`. Width math is `wrapLines` → `wrap-ansi`, which measures visible width (SGR excluded).
- `cli-highlight` is a direct TUI dependency (`packages/tui/package.json`). It is used today **only indirectly**, by `marked-terminal` for fenced code blocks, with cli-highlight's DEFAULT theme — there is no existing theme mapping to reuse, and the TUI has no dark/light switch yet (`theme.message.dark|light` is the precedent: both palettes defined, `dark` default).

### Design

- New pure module `src/read-highlight.ts`: `languageForPath(path)` (extension / `Dockerfile`/`Makefile` basename → highlight.js language; `:start:end` ignored; unknown → `undefined`), `pathOfArgs(args)`, and `highlightRead(text, path, mode="dark", limit?)` → styled lines or `undefined` (unknown language or highlighter error ⇒ caller keeps today's grey). Header line of a ranged read stays `theme.subtle`.
- Palettes `syntaxRgb.dark|light` in `theme.ts` (token class → RGB), turned into a cli-highlight `theme` object once per mode.
- `render-lines.ts`: `plainToolBody` uses `readLines(tool, headLimit)` for `fs_read` non-error results. `toolLines` passes `headLimit = max(threshold, preview)` when collapsed, `undefined` when expanded: a collapsed preview highlights only its head (rest grey, never shown), expand highlights everything. A `WeakMap<ToolItem,{limit,lines}>` memoises on item identity, so a resize / ctrl+o re-layout does not re-highlight for the same limit.
- Edit diffs untouched.

### Files

`packages/tui/src/theme.ts` (palettes) · `packages/tui/src/read-highlight.ts` (new) · `packages/tui/src/render-lines.ts` (wire + cache) · `packages/tui/test/read-highlight.test.ts` (new).

### Failure modes

- Unknown extension / no path / unparseable args → `undefined` → plain grey as today.
- Highlighter throws (`ignoreIllegals` set, plus try/catch) → plain grey.
- Error result (`status: "error"`) → red as today, never highlighted.
- Ranged read: header grey; preview cut inside a multi-line token mis-colours its first lines (accepted limit).
- Multi-line tokens: chalk closes/reopens SGR per line, so each split line is self-contained (test pins every line of a block comment coloured).
- Non-TTY: chalk disables colour, output degrades to plain text.

### Tests

`test/read-highlight.test.ts`: language mapping; known extension coloured with unchanged visible text; unknown plain; dark ≠ light; header grey; `limit` head-only; multi-line comment; error not highlighted; wrap rows' visible text equal to the plain render; preview head limit vs expand; cache hit (spy on `highlightRead`, 1 call across repeated `itemLines`, 2 for a new identity). Chalk level forced to 3 in the file since the harness has no TTY.

## Execution

*— claude-sonnet-5-5, 2026-10-25*

Built as planned, in order: palettes → `read-highlight.ts` → wiring in `render-lines.ts` → tests. Line numbers: the Read output carries none, so "line-number prefix untouched" is pinned as the ranged-read header `[path lines A-B of N]` staying exact grey `theme.subtle`.

**Languages covered:** Go, Python, JS (js/jsx/mjs/cjs), TS (ts/tsx/mts/cts), Markdown, YAML, shell (sh/bash/zsh), Rust, JSON, TOML/INI, Java, Kotlin, Swift, C/C++ (c/h/cc/cpp/hpp), CSS, SQL, Ruby, PHP, Lua, diff/patch, Dockerfile, Makefile. All verified `supportsLanguage` in the installed highlight.js.

**Cost** (`.tentacle/tmp/tui-read-highlight/cost.ts`, real TS source text, bun 1.4.3, chalk off so SGR emission not included): 40-line preview ≈ 0.6–1.9 ms (first call 2.7 ms incl. warm-up); 1000-line expand ≈ 8.4–11.9 ms. Matches the owner's estimate; paid once per tool item per limit (preview and expand are separate cache slots).

**Red→green:** the feature was absent before the edit (Repro). The tests were written after the code, so red is shown by mutation instead — each reverted, final shasum of the 4 touched files identical to the pre-mutation snapshot (checked before the `rgb()` type fix below):
| mutation | failing test(s) |
|---|---|
| `if (!language)` → `if (language)` | 7 (known coloured, unknown plain, palettes, header, limit, comment, body) |
| header detect → always 0 | ranged-header test |
| `Math.min(…, header+limit)` → `lines.length` | limit head-only test |
| `themeFor(mode)` → `themeFor("dark")` | palettes differ |
| drop chars from highlighted text | known-extension, body, wrap tests |
| drop the `status !== "error"` guard | error-not-highlighted test |
| disable the `readHlCache` lookup | cache-hit test |
| always `undefined` head limit | preview-head + cache tests |

**Drift:** (1) the TODO says "same theme mapping as markdown code blocks", but none exists (default cli-highlight theme via marked-terminal) — new `syntaxRgb` palettes instead. (2) A `tsc` error (spread of tuple into `chalk.rgb`) was fixed with a small `rgb()` helper after the mutation pass; covered by the final green run. (3) A mutation helper script was blocked by the permission layer, so mutations were done by hand.

**Gate:** `bun run check` green — typecheck clean, biome clean (459 files), `bun test`: 2486 pass, 2 skip (opt-in), 0 fail.

**Unverified:** visual look of the palettes in a real terminal (dark/light) — try `bun run` the TUI and read a `.go`/`.ts` file.

### Follow-up 1 (Review round 1)

*— claude-sonnet-5-5, 2026-10-25*

**Corrections to the claims above:** "preview and expand are separate cache slots" was FALSE as first built (one `{limit}` entry; 6 toggles = 6 highlights) — fixed in item 2. The languages list no longer has HTML/XML (item 5). The wrap test compared stripped text only and could not see SGR — replaced by SGR-level tests (item 1/6).

Order: new tests first, run on the then-current code (**RED: 6 of the 8 new tests failed** — SGR-open row, toggle count 6≠2, cap constant missing, CRLF rows differ, html mapped; the 2 that passed were the wrap-points test and the already-correct failure fallback, which pins existing behaviour and is killed by mutation instead), then the fixes.

1. **Wrapped colour** — new exported `carryColor(rows)` in `render-lines.ts`, applied to each wrapped line inside `wrapLines`. Why this approach: wrap-ansi 9.0.2 cannot be told to track `38;2`; wrapping *before* colouring would need a second wrap that must reproduce wrap-ansi's word-wrap points exactly (and the later `wrapLines` would still rewrap); carrying state across rows *after* the wrap changes no text and no wrap point by construction. It re-emits the open `38;2;…` at the start of each following row and closes with `39` at each row end; rows with no such colour pass through untouched. Side effect, intended: any truecolor foreground that wraps now stays coloured (e.g. a narrow-terminal tool header). Background colours are out of scope (diff bars are pre-wrapped).
2. **Cache** — `readHlCache` is `WeakMap<ToolItem, Map<limit, lines>>`; a plain (`undefined`) result is cached too. Test: 6 ctrl+o toggles → exactly 2 `highlightRead` calls.
3. **Size cap** — `READ_HIGHLIGHT_CAP = { lines: 2000, bytes: 200_000 }` (`read-highlight.ts`, one named constant; orchestrator default, the owner may change it). Above either, `highlightRead` returns `undefined` and the read renders plain as before. `bytes` counts UTF-16 code units. The cap tests the whole text, not the head, so a huge file never pays even for a preview.
4. **CR / NUL / CRLF** — `cleanReadText` (CRLF→LF, then lone CR and NUL dropped) is applied to every `fs_read` non-error result before both the coloured and the plain path, i.e. the plain rendering of a CRLF read also changes (no stray `\r`, no extra trailing row) — a deliberate, tiny behaviour change at the one shared point. As a safety net `highlightRead` returns `undefined` if the SGR-stripped output differs from its input.
5. **html/xml** — highlight.js has no switch for the `<script>`/`<style>` sub-language (`subLanguage` is an array of candidates in `xml.js:208,226`); all other mapped grammars use a fixed named sub-language (js→xml/css, markdown→xml, yaml→ruby, dockerfile→bash), which is deterministic, not detection. `.html`/`.xml` mappings removed → plain. Test pins `languageForPath` → `undefined`.
6. **Tests** — highlighter-throws fallback (`spyOn(cli-highlight, "highlight")` throws → `undefined`, no throw); no row ends with an open fg SGR; the tail rows of a wrapped token carry the colour from their first character; the safety net; the cap.

**Mutations** (one each, reverted; shasum of the 3 touched files identical afterwards): `carryColor` lead dropped → wrapped-colour test; closing `39` dropped → wrapped-colour + no-SGR-open tests; cache lookup disabled → cache-hit + toggle tests; `cleanReadText` not applied to the plain path → CRLF test; line cap neutered → cap test; byte cap removed → cap test; safety net removed → safety-net test; `catch` rethrows (Review M3) → fallback test; html re-mapped → html test. Review's M4 (open SGR at row end) is killed by the second mutation above.

**Gate:** `bun run check` green — tsc clean, biome clean (459 files), `bun test` 2495 pass, 2 skip (opt-in), 0 fail.

### Follow-up 2 (Review round 2)

*— claude-sonnet-5-5, 2026-10-25*

Tests only, no production change (Review round 2 findings 1–2). Both new tests passed on the unchanged code (they pin existing behaviour), so "red" is shown by the reviewer's mutations:
1. `the cap also holds on the preview path` — `highlightRead(…, "dark", 8)` on 2001 lines and on a >200 KB single line must be `undefined`; at exactly 2000 lines a preview is still coloured. Mutation `limit === undefined && lines.length > CAP` (`read-highlight.ts:193`) → this test red; reverted.
2. `carryColor stops carrying after an SGR reset` — for `\x1b[0m`, `\x1b[m` and `\x1b[39m` the next row must not get the stale `38;2` prefix. Mutation of the reset branch to `p === "39"` only (`render-lines.ts:503`) → this test red; reverted.

After both reverts the shasum of the 3 touched files was byte-identical to the snapshot. `bun run check`: see below.

## Review

*— claude-opus-5-5, 2026-10-25* (different model from the executor, fresh context)

**Verdict: REQUEST-CHANGES.** The language mapping, the plain fallback for unknown extensions and the pure-module split are correct. Findings 1–3 need fixing before merge.

**Gate** (`bun run check`, re-run): tsc clean · biome 459 files clean · `bun test` **2486 pass, 2 skip (opt-in), 0 fail**, 9398 expects, 203 files.

**Findings**
1. **Medium: colour is lost on wrapped rows** (`render-lines.ts:475` → wrap-ansi 9.0.2 `index.js:179`, which only tracks single-number `\x1b[<n>m`). Truecolor `38;2;r;g;b` is not tracked, so a token that wraps leaves row 1 with an open SGR, and its continuation rows have no colour. Repro: a 70-char string wrapped at 30 gives rows `…\x1b[38;2;152;195;121m"aaaa` / `aaaa…` (plain) / `aaa"\x1b[39m; `. In the Ink frame (ink-testing-library), Ink closes the colour at each row end, so **no bleed into the next row or item**. But the string is green on row 1 only. The visible text and the row count are identical to the plain render (9/9). The suite's wrap test compares only stripped text, so it cannot see this.
2. **Medium: the cache has one slot per item** (`render-lines.ts:288-301`). Execution says "preview and expand are separate cache slots". That is false: one `{limit}` entry, so every Ctrl+O toggle re-highlights. Measured: **6 toggles → 6 `highlightRead` calls**. Resize while expanded → 0 calls (correct). Ctrl+O expands every item, so one toggle re-highlights every Read in the transcript.
3. **Medium: no size cap.** `fs_read` returns the whole file by default (`tools/src/builtins.ts:74`). Expanding a 20k-line read blocks the render thread for **~160 ms**, synchronously, on every toggle (see 2). It does not throw. Needs a lines/bytes cap above which the read stays plain.
4. **Low: binary-ish or CRLF input does not render like the plain path.** cli-highlight drops `\r` and NUL. A CRLF file gets one extra trailing empty row, so `body.length` is off by one against the collapse threshold. It never throws: binary content, ESC sequences and a 1 MB single line all return lines.
5. **Low: one place still auto-detects.** `.html`/`.xml` → `xml`, whose `<style>`/`<script>` sub-languages are detected automatically among a subset (`highlight.js@10.7.3 lib/languages/xml.js:208,226`). Everywhere else the language comes from the extension: cli-highlight calls `hljs.highlight` with an explicit `language` (`dist/index.js:86`) and never calls `highlightAuto`. Either drop the html/xml mapping or record this as an accepted limit.
6. **Low: test gaps** (mutations M3 and M4 below survive). Nothing tests the highlighter-throws fallback, and nothing asserts that each row is self-contained at the SGR level.

**Mutations (each reverted; shasum of all 4 files identical to the pre-mutation snapshot; `git status --short` unchanged):**
| # | mutation | result |
|---|---|---|
| M1 | cache lookup disabled (`&& false`) | killed: cache test |
| M2 | unknown ext → `"plaintext"` (always highlight) | killed: 2 tests |
| M3 | `catch` rethrows | **survives** |
| M4 | each coloured line ends with an open `38;2` SGR | **survives** |

The suite is non-vacuous on mapping, limit and cache. It is vacuous on robustness and on SGR self-containment.

**Cost with colours ON** (chalk level 3, real TS source, bun 1.4.3): 40-line preview 0.5–1.0 ms (first call 6.2 ms); 1000-line expand 7.6–11.7 ms; `itemLines` of a 1000-line item when expanded, new identity, 6.4–8.2 ms; preview of a 1000-line file (limit 8) 0.1–0.4 ms; 20k lines ~160 ms. This is close to the executor's colour-off numbers: emitting SGR adds little. Size is the problem (findings 2 and 3).

**Contrast** (WCAG ratio, dark palette): on black, comment 4.57 and the others 6.6–12.2. On #1e1e1e, comment 3.63 and the others ≥5.2. Light palette on white: 4.1–5.5. Readable. Comments are the weakest colour, which is intended.

**Premises:** `ToolItem.args` carries the path (TRUE, `pathOfArgs`). One body site is shared by preview and expand (TRUE, `toolLines` → `toolBody`). "Width math is `wrap-ansi`, which measures visible width" is TRUE for the width, but the doc's implied corollary "colour survives the wrap" is FALSE for truecolor (finding 1). "Separate cache slots" is FALSE (finding 2). The Repro (plain grey on `main`) is consistent with the diff: the unknown-extension path is the old code, unchanged.

**Attacks tried:** wrap and Ink frame with a long string token → finding 1, no bleed past the row. Ctrl+O toggles and width changes, counting calls → finding 2. 20k lines → finding 3. Binary, ESC, CRLF, 1 MB line → no throw, finding 4. grep for `highlightAuto` and `subLanguage` → finding 5. Error status → stays red (the test holds). Light vs dark → they differ, but `render-lines.ts` hardcodes `"dark"` (acceptable: there is no switch yet). The logic lives in pure `read-highlight.ts` (AGENTS §7 holds).

**Executor behaviour:** honest about skipping red-before-green, and the substituted mutations were real (M1/M2 match). Two Execution claims are wrong or untested: the "separate cache slots", and the wrap test standing in for "no SGR bleeding" (it strips SGR). Cost was measured without SGR, as admitted.

### Review round 2

*— claude-opus-5-5, 2026-10-25* (fresh context; same model as round 1, different from the executor)

**Verdict: APPROVE-WITH-NITS (merge).** All six round-1 findings are closed. Neither side effect of the fix breaks anything: proven per cell against an oracle, not by reading the code. Nits 1–2 are test gaps: the behaviour is correct, but the suite does not pin it.

**Gate** (`bun run check`, re-run): tsc clean · biome 459 files clean · `bun test` **2495 pass, 2 skip (opt-in), 0 fail**, 9427 expects, 2497 tests / 203 files.

**Round-1 findings:** 1 wrapped colour → closed (oracle below). 2 cache → closed (`Map<limit>`, toggle test = 2 calls). 3 cap → closed (`READ_HIGHLIGHT_CAP`, checked on the whole text before `limit`, so the preview and the expanded view are both capped: `read-highlight.ts:189-195`). 4 CRLF → closed. 5 html/xml → removed. The spec asks for the language by extension and forbids auto-detection, and the TODO's list has no HTML, so plain is correct. 6 tests → the fallback and SGR-open tests are present.

**Findings**
1. **Low, test gap:** the cap test (`read-highlight.test.ts:213`) calls `highlightRead` only without `limit`. The mutation "cap only when expanded" (`limit === undefined && lines.length > CAP`, `read-highlight.ts:193`) **survives** all 23 tests. The behaviour is correct, but the claim "a huge file never pays even for a preview" is not pinned.
2. **Low, test gap:** in `carryColor`, the reset on `0`/`""` (`render-lines.ts:503`) is not pinned. The mutation `p === "39"` alone **survives** the whole TUI suite (502 pass). My oracle harness kills it: 9 lines get a stale colour after `\x1b[0m`. Nothing in the TUI emits `\x1b[0m` today (chalk closes per attribute), so this is latent only.
3. **Nit:** `cleanReadText` drops a lone CR (`read-highlight.ts:172`). A file with classic-Mac line endings (CR only) therefore shows as ONE row. Before, it was one row of `\r`s that overwrite each other in the terminal (also broken), so this is not a regression. CRLF → LF and NUL dropped: the text matches what the model saw except for invisible control characters. The plain path now also loses the stray `\r` and the spurious trailing row. That is an improvement, not a regression.
4. **Nit:** `carryColor` tracks only `38;2`. At chalk level 2 (a 256-colour terminal), `chalk.rgb` emits `38;5`, nothing is carried, and the wrapped tails lose their colour as before. This degrades gracefully and breaks nothing. Truecolor backgrounds (`48;2`) are not carried either. That is pre-existing: message rows and diff bars are pre-sized to the width, and the oracle shows identical bg in the old and new output.

**Attacks tried**
- **`carryColor` on the whole transcript** (`.tentacle/tmp/tui-read-highlight/r2-diff.ts`). Mixed items: a user message with a `48;2` bg, emoji and CJK; markdown with heading, bold, italic, code, link, quote, a fenced ts block and a table; a notice; an `fs_edit` diff with word-diff; shell ok/error; a Go read. Collapsed and expanded, widths 1, 2, 7, 10, 20, 33, 40, 79, 80, 81 and 200. Result: **16 994 rows, 0 row-count / text / bg / bold-dim-italic-underline differences** between the old wrap (wrap-ansi only) and the new one. The only change is fg default → `38;2`.
- **Exact property (oracle):** the per-character style of the unwrapped logical line must equal that of the new rows. **0 lines are worse than before.** 0 truecolor-fg mismatches. 49/230 lines still differ, and all of them were already wrong in the old wrap (122/230): bg `48;2` and basic codes at width 1, which are wrap-ansi limits. `carryColor` fixes 73 lines and breaks none. This harness kills mutation 2 (non-vacuous).
- **Cost:** 10 399 logical lines (the transcript ×200) take 806–813 ms with the old wrap and 811–816 ms with the new one: **< 1 %**, paid once per item (`rowCache`). The code is pure: no state outside `map`.
- **Safety net (does it kill colour on common files?):** 577 repo files (ts, tsx, json, md) plus 2 953 from `packages/tui/node_modules` (js, ts, md, json, yml, css, sh) → **0 fallbacks**. The synthetic cases → **0 fallbacks** across 22 languages, Dockerfile and Makefile: tab, `& < >`, literal HTML entities (`&amp;`, `&#x27;`), the three quote kinds, CJK, emoji, zero-width, trailing spaces, backslash, `<script>`. Only text with raw ESC/CR falls back, which is intended.
- **Cap on preview and expand:** confirmed by reading the code and by the mutation (finding 1).

**Mutations** (temporary, each reverted): cap only when expanded → survives (finding 1). `carryColor` without reset on `0` → survives the suite (finding 2), killed by the harness. Afterwards `shasum` of the 4 touched files plus this doc was identical to the snapshot taken before the mutations, and `git status --short` was unchanged.

**Executor behaviour:** Follow-up 1 is honest. It corrects its own earlier false claims, gives the red count (6/8), and admits the side effect of `carryColor` and of the plain path. Its stated mutations match what I see. Two of them were weaker than claimed: "line cap neutered" does not cover the preview path, and the reset branch was never mutated.
