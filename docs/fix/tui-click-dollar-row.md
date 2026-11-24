# fix/tui-click-dollar-row — the `⎿ $ cmd` row of a shell tool toggles it like the header

> **Status:** context
> **Branch:** `fix/tui-click-dollar-row`
> **Size:** S · **Blast:** contained · **Suited:** Sonnet plan+exec (self-approve for S), Opus review
> **Changelog:** `changelog.d/tui-click-dollar-row.fixed.md`

## Context

Owner 23/11 ~17:45: in the TUI only a tool row's HEADER (the intent sentence / title) is a click target. Since `fix/tui-shell-row-collapsed` the command sits on the `⎿ $ cmd  exit=N` row, which is where one naturally clicks to see the whole command, and that row does nothing (repro 23/11 on main: a click on head+1 leaves the block closed). Fix: for shell rows the `$` row (and its continuation rows when expanded) toggles too; output rows stay plain text (selection). Likely files: `packages/tui/src/tool-hit.ts` + `packages/tui/test/app-shell-row-collapsed.test.tsx` (SGR mouse helpers in `packages/tui/test/app.test.tsx`). Red first via a real-App frame test (AGENTS §1, §9).

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

**APPROVED (self, S, orchestrator rule)** — no owner-visible choice: a click target, no new glyph/layout.

**Load-bearing assumption (proved by reading):** a click is resolved ONLY against `LaidItem.start` — `toolCallAt` returns the id iff `absRow === item.start` (`tool-hit.ts:62`), and `LaidItem` carries no per-row info (`render-lines.ts:1613-1629`, built at `:1669`). The `$` row of a shell block is row 1 (described, `shellIntentLines` `:1101`) or, expanded plain shell, row 1+ (`:1122`); collapsed plain shell has `$` ON the header (`:1126`, already a hit). So nothing but a row count is missing. To be confirmed red-first by the real-App frame test (§1).

**Preconditions:** `dollarRows` (`:1185`) is the single source of the `$`/continuation/exit-spill rows and they are already width-fit (`wrapLines(room)`), so no re-wrap shifts them; `showDollar` is true in every `shellBlock` call except collapsed plain shell (`:1127`) where there are none; output/body rows follow `dollar` (`:1166`), so "first N rows after header" = the `$` rows.

**Design:** add `toggleRows: number` to `LaidItem` (rows from `start` that toggle; 1 for non-shell tools). Pure helper `shellToggleRows(tool, opts)` next to `shellIntentLines`/`plainShellLines`: `0` extra for non-shell, queued, or plain-collapsed; else `1 + dollarRows(row, cols, expanded).length` (header + `$` rows; empty-command case yields 0 or the exit-only row — both fine). `layoutTranscript` fills it for `tool` items named `shell`. `toolCallAt` returns id when `start <= absRow < start + toggleRows`. Output rows (after the `$` rows), body, blanks stay text/selection.

**Files:** `packages/tui/src/render-lines.ts` (LaidItem field, helper, `layoutTranscript`), `packages/tui/src/tool-hit.ts` (range test + header doc comment), `packages/tui/test/tool-hit.test.ts`, `packages/tui/test/app-shell-row-collapsed.test.tsx`, `changelog.d/tui-click-dollar-row.fixed.md`. Fix any other `LaidItem` literals (tests) for the new required field.

**Failure modes:** non-shell tool → 1 (unchanged); shell with long command expanded → every continuation + exit-spill row toggles; click on first output row → no toggle (boundary); running/queued shell (no body) → `$` row toggles, harmless; scrolled-up/out-of-viewport clicks still bounded by `toolCallAtViewport`; expanded↔collapsed changes the count, but layout is rebuilt from `expandedIds` per click so it is never stale (cache is per-slot rows only; count computed from the same opts).

**Tests (red first on current code):** (1) real-App frame test in `app-shell-row-collapsed.test.tsx`, copying the SGR helpers of `app.test.tsx`: click head+1 of a described shell → block expands (red: stays closed); click again → collapses; click on an output row → unchanged. (2) `tool-hit.test.ts`: `$` row, continuation rows and the exit-spill row of an expanded multi-line command hit; first output row → null; non-shell second row → null. (3) mutation: set `toggleRows` to 1 → tests fail.

*— claude-sonnet-5-5, 2026-11-24*

## Execution

- Load-bearing check re-run: red-first tests (before any src edit) failed on the property — App frame test (click on `$` row left the block closed) + 3 `tool-hit` tests; 13 pass / 4 fail.
- As built: `LaidItem.toggleRows` (`render-lines.ts`), helper `toggleRowsOf` (1 for non-shell/queued/plain-collapsed, else `1 + dollarRows(...).length`), filled in `layoutTranscript`; `toolCallAt` tests `start <= absRow < start + toggleRows` (`tool-hit.ts`, doc comment updated). Tests: new App test + 4 `tool-hit` tests; `mouse-stream.test.ts` literals got `toggleRows: 1`.
- Drift: the older `tool-hit.test.ts` test "an expanded call's command rows are text too" asserted the OLD behaviour; rewritten (`$` rows hit, output rows null). Helper name `toggleRowsOf` (not `shellToggleRows`), same semantics.
- Mutations: (M1) `toggleRows: 1` → 5 fail; (M2) `<` → `<=` in `toolCallAt` → 7 fail; both reverted, 42/42 green on tool-hit + app-shell-row-collapsed + mouse-stream.
- Not run (per budget): full suite, whole-repo typecheck/lint (script gate). Biome clean on the 5 touched files. No protocol change.

*— claude-sonnet-5-5, 2026-11-24*

### Fix round 1

- H1 (per-frame cost): `toggleRowsOf` now memoises in `toggleRowsCache` (WeakMap on the item, keyed width + expanded; `render-lines.ts` ~1110); the count itself moved to `computeToggleRows`. Nit fixed: `mouse-stream.ts:326` comment.
- Test: `tool-hit.test.ts` "toggleRows is memoised per item": same item, args mutated after the first layout → count stays (cache hit); other width → recomputed. RED with the cache check disabled (`false &&`: expected 5, received 2), green restored. That disable is the mutation.
- Gate (touched files): tool-hit + app-shell-row-collapsed + mouse-stream 43 pass; biome clean on 3 files. Full gate left to the script.

*— claude-sonnet-5-5, 2026-11-24*

## Review

**Verdict: REQUEST-CHANGES** (1 HIGH).

**H1 — per-frame layout regression (`render-lines.ts:1698`, helper `:1110`).** `layoutTranscript` runs on every App render (`App.tsx:1071`: stream deltas, blink ticks) and is documented as O(items) cache lookups (`render-lines.ts:~1660`, `App.tsx:1066`). The new `toggleRowsOf` is NOT cached: per `shell` item per frame it re-parses the args JSON (`shellRowParts` + `shellRow`) and re-runs `cutCommand` / `wrapLines` via `dollarRows`. Measured (`.tentacle/tmp/tui-click-dollar-row/bench.ts`, warm cache, width 100, ~330-char commands): 300 shell calls → **25 ms/layout collapsed, 64 ms expanded**; 2000 → 181 / 440 ms. Same bench with `toggleRows: 1` (≈ main) → 0.04 ms. A long agent session janks on every token. Fix: memoise the count next to the rows (the `rowCache` slot in `itemRows`, same key) or compute it lazily only on a click (`toolCallAt`), and add a test that pins the cache hit (e.g. a spy/identity check, as the row cache tests do).

**Gate (touched files):** `tool-hit`, `app-shell-row-collapsed`, `mouse-stream`, `app.test.tsx` → 165 pass / 0 fail; `bun run lint` clean; `bun run typecheck` clean. Full `bun test` not re-run (narrow scope).

**Mutations (reverted, `git status` clean afterwards):** M1 `toggleRows: 1` → 5 fail (App frame test + 4 tool-hit); M2 over-count (`2 + dollarRows`) → 4 fail (output-row boundary held). Tests are non-vacuous.

**Premises:** `toolCallAt` was `absRow === item.start` — TRUE; `dollarRows` is the only source of `$`/continuation/exit-spill rows and output follows it (`shellBlock`) — TRUE; collapsed plain shell has no `$` rows (`showDollar=false`) — TRUE, matched by the `shellRowParts === null && !expanded` branch; `hangRows` only touches notices, so no re-flow — TRUE.

**Attacks tried:** (1) drag-select starting on the `$` row — still a selection (`mouse-stream.ts:314`: click = press+release same cell, no motion) — holds. (2) `expandAll` on — toggle gated off (`:328`) — holds. (3) queued described shell — returns 1 (its `$` row is not a target): conservative, not a bug. (4) per-frame cost — H1. (5) §7: no protocol/persistence/terminal-IO touched; logic stays in pure modules — holds.

**Nit (not blocking):** `mouse-stream.ts:326` comment still says "Only a tool call's HEADER row is a control".

**Executor:** followed red-first and mutation discipline honestly; it missed the cost contract of `layoutTranscript`. Reviewer is Opus, executor Sonnet/DeepSeek: different model, fresh context.

*— claude-opus-5-5, 2026-11-24*

### Round 2

**Verdict: APPROVE-WITH-NITS** (`981b2f61`).

- **H1 fixed:** `toggleRowsOf` is now memoised in a `WeakMap` keyed on the item, with `width` + `expanded` in the entry (`render-lines.ts:1116-1130`). The same benchmark gives 300 shell calls → 0.05 / 0.04 ms per layout (was 25 / 64), and 2000 → 0.20 / 0.11 ms, the same as non-shell items. The cache assumes items are immutable, which `rowCache` already assumes.
- **Mutations (reverted, `git status` clean):** turning the cache off → the new memo test fails (1 fail). Dropping `expanded` from the key → **0 fail** across `tool-hit`, `app-shell-row-collapsed` and `app.test.tsx`. The code is correct, but nothing checks that part of the key.
- **Nit:** add a test that lays out one described shell with a multi-row command collapsed and then expanded (`expandedIds`) on the SAME item object, and checks that a continuation row hits. That test would catch a stale `expanded` key.
- The nit on the `mouse-stream.ts:327` comment is fixed.
- **Gate:** `tool-hit`, `app-shell-row-collapsed`, `mouse-stream`, `app.test.tsx` and `render-lines.test.ts` → 295 pass / 0 fail. `bun run lint` and `bun run typecheck` are clean.

*— claude-opus-5-5, 2026-11-24*
