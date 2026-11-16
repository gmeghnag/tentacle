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

## Review
