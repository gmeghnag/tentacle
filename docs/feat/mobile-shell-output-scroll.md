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

**Load-bearing assumption (proved).** The output is ONE `Text` inside a `Pressable` in `StepBody` (`ui/StepNode.tsx:637-652`), fed by `view.output` (`tool-steps.ts:322-328, 377-390`). The cut is HEAD-only: `outputView` keeps `lines.slice(0, CUT_KEEP)` and hides the rest behind "+N more lines" → "show all" (`tool-summary.ts:464-474`; `SessionScreen.tsx:767`). So (a) no wrap = wrap that `Text` in a horizontal `ScrollView` like `CodeBlock` (`ui/CodeBlock.tsx:9`), and (b) "the TAIL" needs a cut change in `outputView`, not just UI. Sticky: the transcript is a plain `FlatList` (`SessionScreen.tsx:1755`) with one cell per row and no `stickyHeaderIndices`. A step's body is INSIDE its cell, so native sticky headers cannot express it → it needs an overlay driven by `onScroll` (`:654`) + measured block offsets.

**Preconditions.** `fix/mobile-open-at-bottom` edits `SessionScreen.tsx`/`follow.ts` in parallel. We touch only a NEW pure module + one `onScroll` tap-in + one overlay element in `SessionScreen.tsx`. Merge order: open-at-bottom first, then rebase ours. The output body keeps no tap action (selection untouched): drop the `Pressable`/`onShowAll` on the text; "show all" stays on the footer line only.

**Design.**
1. `tool-summary.ts`: `outputView` gains `tail` (keep the last CUT_KEEP lines, `hidden` = skipped head count; footer «… N earlier lines»). Pure, tested.
2. `StepBody`: output in a horizontal `ScrollView` (no wrap, same font 12/17, `palette.sec` ALWAYS, drop the red `output.error` colour), edge fade like `CodeBlock`, no line numbers. Failure stays in `exitSuffix` (`StepNode.tsx:569`).
3. New pure `src/output-sticky.ts`: `stickyState(scrollY, blocks[{key,top,bottom,headH}]) → {key, offsetY, line, total} | null`. A block sticks while `top <= scrollY < bottom`. `offsetY = min(0, bottom - headH - scrollY)` (the block's end pushes it up). The next block's head pushing the previous one (iOS handover) falls out of the same formula. Collapsed steps are not blocks.
4. Components: open output cells report top/bottom via `onLayout` into a ref map. `SessionScreen` computes `stickyState` in `onScroll` and sets state only when key/line changes (no per-frame render; `follow.ts` untouched). The overlay row shows the command, «line X of N» and «Collapse». Tap → toggle the step open state, then one `scrollToOffset` so the step row lands where the overlay was.
5. A horizontal `ScrollView` inside the vertical list: RN resolves by axis, and vertical drags are not captured.

**Files.** `tool-summary.ts`, `tool-steps.ts`, `ui/StepNode.tsx` (StepBody), new `ui/OutputBlock.tsx` + `ui/StickyStep.tsx`, new `output-sticky.ts`, `screens/SessionScreen.tsx`, `screens/transcript/TranscriptRow.tsx` (onLayout), `changelog.d/mobile-shell-output-scroll.changed.md`.

**Failure modes.** Row heights change on open/"show all" while stuck → recompute on `onLayout` and clamp. A stream appends to an open output at the bottom → `follow.ts` owns the scroll and the overlay only reads. Block shorter than the head → never sticks. Empty/null output → no block. Collapse while stuck → block removed, state null. Exit 0 / no code → `exitSuffix` unchanged.

**Tests (red first).**
- `output-sticky.test.ts`: stick, leave at the top, push by the end, handover of two blocks, collapsed, empty.
- `tool-summary` tail cut: last lines kept, `hidden` counts the head.
- `tool-step-view.test.ts`: an error output is not red, `exitSuffix` still set.
- StepBody render: horizontal ScrollView, no Pressable on the text (pattern of `step-rail-render.test.ts`).
- Mutation: break the push formula → the handover test fails.

### Owner questions
1. The overlay needs a one-shot scroll correction on collapse to "land exactly". If it jitters on device, OK to ship collapse without the exact landing? Rec: yes, device-test first.
2. With the tail shown, "show all" reveals the head above. OK that the footer reads «… N earlier lines»? Rec: yes.

**NOT approved** (M; the sticky overlay is new scroll machinery in a file shared with open-at-bottom).

*— claude-sonnet-5-5, 2026-11-24*

## Execution

## Review
