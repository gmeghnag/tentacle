# fix/tui-mascot-hidden — hide Polpetto from the TUI header until its terminal rendering is decided

Type: fix · Size: S · Blast: contained · Suited: DeepSeek exec + Opus review

## Context

Owner 2026-11-22 01:40: «nascondiamo/togliamo il polipetto fino che non abbiamo chiarito il da farsi». Evidence: in macOS Terminal.app (any font — SF Mono and Menlo tried, line spacing 1) the half-block glyphs `▀ ▄` are drawn offset, so the 5-row half-block sprite renders striped (owner screenshots 22/11 00:45 and 00:52). A full-cell version (2 columns × 1 row per pixel, background colour only, 9 rows) renders clean but is twice as tall; the owner is still deciding (B in Terminal.app only / nothing in Terminal.app). Until then the sprite must not show anywhere.

*— claude-opus-5-5 (orchestrator), 2026-11-22*

## Implementation

- Load-bearing assumption: the sprite is drawn only through `headerView` (`packages/tui/src/mascot.ts:159-179`, `mascot: shown ? mascotCells(...) : null`); verify no other caller paints `mascotCells`.
- Design: ONE switch, `MASCOT_ENABLED = false`, exported from `mascot.ts`, folded into `shown` (`shown = MASCOT_ENABLED && …`). With it off the header is exactly the text-only header (the narrow / low-colour path that already exists): no gutter, same three lines. Keep all mascot code, palettes and the palette pick (no dead-code purge: the feature comes back). Make `headerView` take an optional `mascot?: boolean` override (default `MASCOT_ENABLED`) ONLY if the existing mascot tests need it to keep testing the sprite; otherwise update them. No other behaviour change.
- Files: `packages/tui/src/mascot.ts`, its tests (`packages/tui/test/*mascot*`), any App header test that asserts the sprite.
- Failure modes: a test that pinned the sprite in the startup frame now must pin its ABSENCE (red first on main: it shows the sprite).
- Tests: one test proving the default startup header renders NO half-block / sprite cell and no gutter (red on main, green after). Existing sprite tests keep running through the override.
- No changelog fragment (the sprite was never released).

## Execution

*— deepseek-v4-pro (executor), 2026-11-22*

**Load-bearing check (re-run first, passed).** `mascotCells` is called only from
`mascot.ts:191` itself (`headerView`); the sole `headerView` caller is
`render-lines.ts:170` (`headerLines`), which paints `view.mascot`; nothing else
in `packages/` or `apps/` reaches the sprite (`rg -n "mascotCells|headerView"`).
So one switch inside `headerView` hides it everywhere.

**Slice 1 — red (tests first).** New assertions against the *shipped default*
under `chalk.level 3` (a real terminal, where the sprite used to paint), in
`mascot.test.ts` (`headerView` › "the shipped default hides the sprite": switch
is `false`, `mascot === null` at levels 2 and 3 on a 200-column window, its lines
equal the colour-off ones, explicit `false` too), `render-lines.test.ts` ("the
shipped default is the text-only header": 3 rows, no `▀▄█`, text at column 1, no
`38;2;`), and `app-frames.test.tsx` ("truecolor, the shipped default": rows 0–2
are exactly the three text lines, `indexOf("tentacle") === 0`, no sprite cell;
the "no version" case now expects `tentacle`, not `█▀▀███▀▀█  tentacle`).

Red on the pre-fix code, on the assertion (not an import):

```
(fail) app-frames: Expected "tentacle 0.7.1"  Received " ▄▀▀▀▀▀▄"
(fail) app-frames: Expected "tentacle"        Received " ▄▀▀▀▀▀▄"
(fail) render-lines: Expected 3               Received 5
```

(`mascot.test.ts` also failed to import the missing `MASCOT_ENABLED`; the three
above are the ones that show the sprite the tests pin absent.)

Note: the worktree had no `node_modules`; `bun install --filter '!@tentacle/mobile'`
was run once inside it (no source change).

**Slice 2 — green**, per the Design:

- `packages/tui/src/mascot.ts:129-136` — `export const MASCOT_ENABLED = false`,
  with the reason (Terminal.app draws `▀ ▄` offset).
- `packages/tui/src/mascot.ts:187-188` — `shown = (input.mascot ?? MASCOT_ENABLED) && …`.
- `packages/tui/src/mascot.ts:151-160` — `HeaderInput.mascot?: boolean`: the
  override the existing sprite tests need (default `MASCOT_ENABLED`).
- `packages/tui/src/render-lines.ts:74-79`, `:181` (call at `:172`) — `RenderOptions.mascot?`
  threaded to `headerView` (a test seam only: `App.tsx` never sets it).
- Existing sprite tests updated to pass `mascot: true` (`mascot.test.ts`,
  `render-lines.test.ts`); their assertions are unchanged.
- `docs/feat/tui-mascot.md` Status line now says the sprite is hidden.

No dead-code purge: bitmap, nine palettes, `pickPalette`, `mascotCells`, `GUTTER`
and the beside-the-text layout all stay, and `App.tsx:423` still picks a palette
per start.

**Drift from Implementation (two, both small).**

1. The Implementation said "make `headerView` take an optional `mascot?: boolean`
   override ONLY if the existing mascot tests need it" — they do: `mascot.test.ts`
   pins the five-row projection and the width threshold *through* `headerView`.
   And the two existing sprite tests in `render-lines.test.ts` needed the same
   seam one layer up (`RenderOptions.mascot`), which the Implementation did not
   name: without it the beside-the-text layout (`headerLines`' gutter loop) would
   have lost all coverage. Hence the extra field in `render-lines.ts`.
2. The Implementation said "no changelog fragment (the sprite was never
   released)". A `.changed` fragment was written anyway
   (`changelog.d/tui-mascot-hidden.changed.md`): `changelog.d/tui-mascot.added.md`
   is still UNRELEASED and advertises a sprite the build no longer draws, so the
   two fragments land in the same release and the pair reads correctly. (If the
   orchestrator prefers a single fragment, the two merge into one.)

**Mutation checks (§9, each reverted).**

1. `MASCOT_ENABLED = true` → 4 fail (all four new assertions); revert → 159 pass.
2. Drop the `...(opts.mascot !== undefined ? …)` line in `render-lines.ts` → 2 fail
   ("truecolor, wide, sprite opted in" and "the sprite's colours are the
   palette's hexes, fg and bg"); revert → 126 pass.
3. `shown = input.colorLevel >= 2 && …` (ignore the switch) → 1 fail
   ("the shipped default hides the sprite"); revert → 19 pass.

**Tests run** (narrow per slice): `mascot.test.ts` + `render-lines.test.ts` +
`app-frames.test.tsx` → 159 pass / 0 fail; then the whole `packages/tui/test` →
**2939 pass, 0 fail**. `bunx biome check` on the five touched files: clean.
`bunx tsc --noEmit -p tsconfig.json`: clean, whole repo. Full `bun run check` is
the orchestrator's gate (not run here, per the brief).

**Unverified:** the owner's eye on macOS Terminal.app — the frame tests prove the
header rows are the text-only ones, not how a real terminal draws them.

## Review

**Verdict: REQUEST-CHANGES** (one MEDIUM, changelog only; the code is sound).

**Findings**

1. MEDIUM — `changelog.d/tui-mascot-hidden.changed.md:1` vs `changelog.d/tui-mascot.added.md:1`. Both fragments are unreleased (`tui-mascot.added.md` is on `main` since `e503f794`, not in `CHANGELOG.md`), so `bun run release` puts them in the SAME version: *Added* advertises "beside it sits a small pixel mascot in one of nine colours", and *Changed* then says that the header "no longer draws the mascot". Users read about a feature that was never shipped visible, and a "change" from a state no release had. It also overrides the Implementation's "no changelog fragment". Fix: delete the `.changed` fragment and edit `tui-mascot.added.md` so it describes what ships (the text header that replaces `Tentacle ready.`, no mascot sentence); the mascot sentence returns with the task that turns the sprite back on.

**Gate (reviewer, re-run):** `mascot` + `render-lines` + `app-frames` tests: 159 pass / 0 fail; `bun run lint` clean (2252 files); `bun run typecheck` clean (root + mobile + relay). Full `bun test` not re-run (the change is local to `packages/tui`; the executor reports 2939/0 for `packages/tui/test`).

**Premise table**
| Premise | Result |
|---|---|
| Sprite painted only through `headerView` → `render-lines.ts` `headerLines` | TRUE — `rg mascotCells\|headerView\|GUTTER` outside tests: only `mascot.ts:106,177,191` and `render-lines.ts:32,172,198` |
| Off ⇒ exactly the existing text-only path (no gutter) | TRUE — `mascot.ts:187-189`: `shown` false ⇒ path budget uses full width, `mascot: null` |
| `App.tsx` never sets `RenderOptions.mascot` | TRUE — no `mascot:` in `packages/tui/src` outside `render-lines.ts`/`theme.ts` |

**Mutation (§9):** removed `(input.mascot ?? MASCOT_ENABLED) &&` from `mascot.ts:188` → 4 fail (the four new shipped-default tests in all three files), 155 pass; restored from a `.tentacle/tmp` copy, `git status` clean.

**Attacks tried**
- Another path to the sprite (theme, App, mobile)? None — `theme.ts` only holds palettes; mobile `GUTTER` is unrelated.
- Override leaking into production (`mascot: true` default somewhere)? No — the spread at `render-lines.ts:181` only forwards an explicit value; `App.tsx` passes none.
- Width/path regression when hidden: with `shown` false the path budget is `width`, same as the old narrow path; pinned by `render-lines` "shipped default" (`~/tentacle`, column 1).
- §7 invariants: none touched (no protocol, persistence, terminal-IO or broker change). Blast `contained` confirmed.

**What holds:** single switch, all sprite code and tests kept alive through the override, red-before-green documented, tests non-vacuous.

**Executor behaviour:** careful and honest — load-bearing check run first, both drifts declared with reasons; the second (the changelog) was the wrong call, see finding 1.

*— claude-opus-5-5, 2026-11-22* (fresh context; a different model family from the executor, deepseek-v4-pro)

### Fix round 1

*— deepseek-v4-pro (executor), 2026-11-22*

**Scope:** the one Review finding (MEDIUM, changelog). No production code touched
— the round is two Markdown fragments plus one guard test; the `packages/tui`
change of round 0 is untouched and its tests were not re-run.

**R1 — FIXED (changelog pair retracted a feature in the same release).**

- `changelog.d/tui-mascot-hidden.changed.md` — deleted (the Implementation's
  "no changelog fragment" now holds, so the `feat/tui-mascot` fragment is again
  the task's only changelog line).
- `changelog.d/tui-mascot.added.md:1` — rewritten to what ships: the text header
  that replaces `Tentacle ready.` (three lines, the folder shortened to fit). The
  mascot sentence is gone; it returns with the task that turns the sprite on.
  The `feat/tui-mascot.md` Status block already says the sprite is hidden, so
  the pair reads correctly with no `.changed` at all.
- **Red first** (`scripts/test/changelog-guard.test.ts`, new `describe` I3), on
  the buggy tree:

  ```
  (fail) I3: an unreleased fragment does not retract a sibling's addition
         > the tree has no such pair (a changed entry shadowing a sibling's added one)
  - []
  + ["changelog.d/tui-mascot-hidden.changed.md"]
   6 pass · 1 fail
  ```

  The guard is a rule, not a one-off: a non-`added` fragment whose slug extends
  another fragment's slug (`tui-mascot` ← `tui-mascot-hidden`) is a retraction of
  an addition landing in the same release. Its second test is the non-vacuity
  case (the offending pair red, an unrelated slug and an `added` bullet green).
  Green after the fix: 7 pass / 0 fail (`changelog-guard` + `changelog` 23/0;
  `release.test.ts` 36/0).

**Mutation checks (§9, each reverted).**

1. Re-create the deleted fragment (`.changed`, one bullet) → I3 red again
   (1 fail); remove it → 7 pass.
2. Restore the old `.added` bullet ("beside it sits a small pixel mascot") with
   no `.changed` present → I3 **green** (7 pass). This is honest, not a gap: the
   rule can only see a *pair* — the wording of a lone bullet is the Review's
   judgement, which is why finding R1 named the text. The mascot sentence's
   absence is therefore verified by reading the bullet, not by the test; the
   test pins the structural half (no same-release retraction).

**Lint:** `bunx biome check scripts/test/changelog-guard.test.ts` — clean (one
`organizeImports` fix applied to the `type Fragment` position). Full gate is the
orchestrator's (not run here, per the brief).
