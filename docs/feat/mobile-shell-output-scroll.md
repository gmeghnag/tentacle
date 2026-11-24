# feat/mobile-shell-output-scroll — shell output as a terminal block in the row (no wrap, horizontal scroll) + a sticky collapse row

> **Status:** context
> **Branch:** `feat/mobile-shell-output-scroll`
> **Size:** M · **Blast:** contained (app transcript rows) · **Suited:** Sonnet plan + exec (owner: S/M → deepseek/sonnet), Opus review
> **Changelog:** `changelog.d/mobile-shell-output-scroll.changed.md`

## Context

Owner 23/11 (iPhone screenshot of a failed `test` run): a shell step's output wraps line by line and a table becomes unreadable; a failed command's output is all red.

Owner decisions 24/11 (mockups `.tentacle/mockups/mobile-shell-output-scroll/index.inline.html`, binding):
- **B — «Terminale nella riga»**: today's body (same font 12/17, same place) but NO wrap: ONE horizontal scroll for the whole block, fade on the clipped edge like `CodeBlock`, **no line numbers** (output is not code), the TAIL of a long log (not the head). Output text NEUTRAL; the failure is carried by `exit N` (colour-blind owner).
- **Open long log — b «la riga del passo resta in alto»**: while the visible top of the screen is inside an OPEN output, the step's row sticks to the top (command, position «line 212 of 400», «Collapse»); tapping it collapses and the step row lands exactly where the sticky row was (no jump). It leaves when the block's end scrolls past (the block's bottom pushes it up) or when scrolling above the block's start (it returns in place). With two open outputs in a row, the next one's sticky row PUSHES the previous one away (iOS section-header handover, never a text swap). Collapsed steps never stick. iOS text selection (long-press / double-tap → Copy, Look Up, Search Web, Share) stays untouched: the output body itself has no tap action.
- Must coexist with the vertical transcript scroll (no gesture trap) and with `follow.ts` (auto-follow at the bottom) — `fix/mobile-open-at-bottom` is touching `SessionScreen.tsx`/`follow.ts` in parallel: list overlaps and order.

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

## Execution

## Review
