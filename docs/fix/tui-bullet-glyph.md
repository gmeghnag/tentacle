# fix/tui-bullet-glyph — the tool/notice bullet `⏺` renders as an emoji on iOS and WSL

`Type: fix · Size: S · Blast: contained · Suited: DeepSeek exec, Opus review`

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-16*

**Owner, 2026-11-16 (screenshot of tentacle.so on iPhone Safari; and live on a friend's Ubuntu in WSL):** the row bullet before `Bash`, `Edit`, `Tentacle ready…` shows as a white rounded square with a circle — the **emoji** "record button". The bullet is `⏺` U+23FA (`packages/tui/src/blink.ts:27`, `BULLET`). When the terminal's monospace font has no glyph for it (Windows Terminal/Cascadia under WSL; Safari's monospace on iOS), the OS falls back to the colour-emoji font (Segoe UI Emoji / Apple Color Emoji), which also may draw it two cells wide. On the owner's Mac (iTerm2/Ghostty) it falls back to a text symbol font, so it looked fine.

**Decision (owner, 2026-11-16): replace it with `●` U+25CF BLACK CIRCLE** — present in practically every monospace font (Menlo, SF Mono, Cascadia, DejaVu, Ubuntu Mono), no emoji variant, one cell in non-CJK locales.

## Implementation

*— claude-opus-5-5 (orchestrator), 2026-11-16*

- **Load-bearing assumption:** every user-visible `⏺` in the TUI comes from ONE constant (`BULLET`, `blink.ts:27`) or from a literal the executor finds with `rg -F "⏺" packages apps` (today also `packages/tui/src/render-lines.ts`). Executor: list every hit first; route literals through `BULLET` where they mean the same bullet.
- **Design:** `BULLET = "●"`. The blink (ON = `●`, OFF = the SAME glyph under SGR conceal, `blink.ts:4-8`) is unchanged, so the row width stays constant (the `fix/tui-blink-off-width` rule). No layout, colour or timing change.
- **Files:** `packages/tui/src/blink.ts`, `packages/tui/src/render-lines.ts` and any other code hit; the tests that assert the glyph (`packages/tui/test/render-lines.test.ts`, `tool-phase-view.test.ts`, `notice-palette.test.ts`, others from `rg`) — update them to `BULLET`/`●`. Leave historical docs (`docs/**`, `CHANGELOG.md`) as they are. `changelog.d/tui-bullet-glyph.fixed.md`: "- **The tool bullet no longer turns into an emoji.** On terminals whose font lacks `⏺` (Windows Terminal under WSL, some Linux fonts) the row bullet showed as a coloured emoji; it is now `●`, available everywhere."
- **Failure modes:** a literal `⏺` left somewhere (a test greps the TUI sources for `⏺` and fails if any remains — the regression test, red first); a width change breaking the blink OFF half (existing blink-width tests must stay green); CJK ambiguous width (accepted: same as most TUIs).
- **Tests (red first):** (1) a source scan test: no `⏺` under `packages/tui/src`; (2) `BULLET === "●"`; (3) existing blink/render tests green after updating expectations.
- Out of scope: the website `tentacle.so` (local `.tentacle/site`, deployed only with the owner's OK — the orchestrator handles it).

## Execution

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-16*

**Load-bearing check (re-run first, passed).** `rg -Fn "⏺" packages apps` → 78 hits: exactly ONE code
definition (`BULLET`, `blink.ts:27`) plus TWO other code literals the plan predicted
(`render-lines.ts:104` assistant bullet, `:716` notice bullet); every other hit was a comment or a test
expectation. So the assumption holds and the extra literals were routed through `BULLET` as instructed.
Two empirical facts, `.tentacle/tmp/tui-bullet-glyph/{check,width}.ts`: `⏺` matches `/\p{Emoji}/u` and
`stringWidth("⏺") === 2`, while `●` matches neither and is `stringWidth("●") === 1` — i.e. the root cause
is real (emoji-capable ⇒ the colour font may claim it) and the width the layout assigns changes 2→1.

**Repro / red-before-green.** New regression test `packages/tui/test/bullet-glyph.test.ts` (two independent
assertions: the VALUE is `●` and is not emoji-capable; a scan of every `.ts`/`.tsx` under `packages`/`apps`
skipping `test/` finds no U+23FA literal). On the unmodified tree it was red on BOTH properties:
`Expected: "●" / Received: "⏺"` and the scan listing 15 hits (`blink.ts` comments + `BULLET`, and
`render-lines.ts:104,716`). Green after the fix.

**As built, in plan order.**
1. `packages/tui/src/blink.ts:34` — `BULLET = "●"`; the module/`hiddenBullet`/`toolBullet` doc comments now
   describe `●` and carry the U+23FA rationale. The blink mechanism is untouched (OFF = the same glyph under
   SGR conceal).
2. `packages/tui/src/render-lines.ts:104,716` — the assistant and notice bullets now interpolate `BULLET`
   instead of the literal, so one constant owns the glyph. Comments updated; no logic change.
3. Test expectations updated to `●` (`app-frames.test.tsx`, `app.test.tsx`, `notice-palette.test.ts`,
   `resume.test.ts`, `state.test.ts`, `tool-phase-view.test.ts`, plus a comment in
   `packages/cli/test/settings-view.test.ts`'s mutation note — a CLI *test comment*, not the CLI's own glyph).

**Drift from the Implementation (2 items, both forced by the code — the plan's numbers, not its design,
were stale):**
- The plan's test list mentioned a literal `⏺` in `render-lines.test.ts`; the real breakage there was two
  *width* assertions that hard-coded the OLD glyph's metric — `expect(stringWidth(toolBullet("running", 0)))
  .toBe(2)` (`:1166-1167`) and, at frame level, `expect(new Set(widths)).toEqual(new Set([79]))`
  (`app.test.tsx:3411`). Those are the same class of bug the plan did not foresee: a test asserting the
  glyph's *width* rather than the phase *equality* it means. Rewritten to assert equality of the two phases'
  widths (`= stringWidth(BULLET)`, `:1167-1168`) and, at frame level, "one single width, 78–79"
  (`app.test.tsx:3415-3420`) — see the mutation M3
  below proving the frame test still bites. `render-lines.test.ts:1105,1183,1216,1862` now interpolate
  `${blink.BULLET}`.
- `render-lines.test.ts:1105`'s `startsWith("⏺ Bash")` and similar row assertions are `●` now; the header
  fills the row to 78 of 79 columns (the per-character cut leaves one spare) where the 2-column glyph made
  it exactly 79. No behavioural change — only the pinned number.

**Failure-mode coverage.** (a) *A left-over literal*: the scan assertion, mutation-verified (M2). (b) *A width
change breaking the blink OFF half*: all pre-existing blink/render/frame width tests are green, and mutation
M3 (OFF glyph made one column wider) reds 5 of them plus the frame test — so the guard is real, not vacuous.
(c) *CJK ambiguous width*: accepted per the plan; `●` U+25CF is Ambiguous-width, the same trade every TUI
makes, and the blink's two halves are the same character regardless.

**Mutation checks (each applied, observed, reverted — `cp` backups in `.tentacle/tmp/tui-bullet-glyph/`):**
- **M1** `BULLET = "⏺"` → `bullet-glyph.test.ts` red on BOTH assertions: `Expected: "●" / Received: "⏺"`
  and the 15-hit scan. Proves neither assertion is a tautology.
- **M2** `render-lines.ts:716` back to the literal while `BULLET` stays `●` → the VALUE assertion passes,
  the SCAN assertion alone reds. Proves the scan catches the bypass the value check cannot.
- **M3** `hiddenBullet()` returns `theme.hidden(\` ${BULLET}\`)` (OFF one column wider — the round-1 bug
  shape) → 5 red in `blink.test.ts` + `render-lines.test.ts` and the frame test red. Proves the relaxed
  width assertions still hold the property (they are not weakened into vacuity).

**Gate.** `bunx tsc --noEmit` clean · `bun run lint` clean (`Checked 1697 files`, 0 errors — one
`organizeImports` error was auto-found and hand-fixed in the new test) · `bun test` **12247 pass, 5 skip,
0 fail** across 881 files (the 5 skips are the documented opt-in k8s/docker/root/slow ones). No protocol
schema change, so `protocol.json` was not regenerated; no wire change, so no `protocol.d/` note.
Changelog: `changelog.d/tui-bullet-glyph.fixed.md` (one bullet), `CHANGELOG.md` untouched.
`scripts/test/changelog-guard.test.ts` + `changelog.test.ts` green (21 pass).

**Unverified / out of scope.** The visual result on the two terminals that reported it (iPhone Safari,
Windows Terminal under WSL) is not machine-checkable here — the property pinned is the *code point* and
its non-emoji capability, which is what made the fallback possible. The website `tentacle.so` is untouched
(plan: out of scope, orchestrator handles it).

One `⏺` deliberately remains: `packages/tui/test/clear-connect-unbound.test.tsx:9` quotes the OLD rendered
error text (`⏺ /clear failed: undefined is not an object …`) verbatim as history. It is inside a `test/`
tree, which renders nothing, so the scan skips it by design; changing it would falsify the quote.

## Review
