# fix/mobile-step-rail — phone step rail: one shape for every step, no repeated outcome

Type: fix · Size: M · Blast: contained (apps/mobile rendering + pure view-model) · Suited: DeepSeek exec + Opus review (simulator screenshots)

## Context

Owner 2026-11-22 night, from phone screenshots and an orchestrator mockup (https://claude.ai/artifact/4Y65ry42icD5hnx36pfmbu, local copy `.tentacle/tmp/orchestration/prompts/mobile-step-rail-mockup.html` — sections «B», «D», «D2», «Ciano per tutto»). Decisions, all final:
1. **No ✓ / ✗ in step titles' trailing.** A done step's trailing = duration only (`52 ms`), for successes AND failures. Edit/Write keep their `+N -M` trailing, Read keeps no trailing (as today, `apps/mobile/src/tool-steps.ts` `StepRowView.trailing`).
2. **Failure (variant B):** the exit code goes at the END of the `$ command` sub-line: `$ podman ps … exit 125`, the command ellipsized (single line, `…`), `exit N` always visible (never cut), in the error colour. Failure stays told in TEXT (`exit N`) — owner is colour-blind. A failed tool without a shell sub-line keeps today's error text where it is today.
3. **Rail (variant D):** the vertical line stays continuous from the first to the last step of a run; where a step has a sub-line (`$ command`), a small curved branch leaves the rail and leads to that sub-line (the `⎿` idea, attached to the rail). No straight line ending on a tiny glyph any more.
4. **Thinking / Thought node:** the ∴ glyph is replaced by a DOT of the same size and position as the tool dots: while thinking («Thinking») a FILLED dot in the app accent (cyan, the same colour and blink clock as a running tool after fix/mobile-running-row), blinking; when done («Thought») a RING (outline only, ~2 pt) in a dim, "disabled" grey (close to the rail colour, a theme token — light and dark). Reduce Motion ⇒ steady dot. Labels unchanged («Thinking» / «Thought · 2 s»).
5. **Expanded step (tap on a shell step) — no repetition, aligned** (owner 03:00, screenshot `.tentacle/tmp/orchestration/prompts/mobile-step-rail-expanded.png`): today the open detail of a failed `podman ps` shows `$ podman ps` on the sub-line AND `podman ps` again as the first body line, then `⎿ exit=125` with its own `⎿` glyph not aligned with the rail or the text column, then the output indented by 2 extra spaces. Fix: the command appears ONCE (the sub-line; the body never repeats it); the exit code appears ONCE (the sub-line's `exit N`, decision 2 — no `exit=N` line in the body); no `⎿` glyph inside the body (the rail branch of decision 3 already says "this belongs to the step"); the output starts at the text column of the title/sub-line, no extra indent, monospace, error colour only for a failed step's stderr. Same rules for an ok shell step and for a step without an intent sentence. Pin with unit tests on the detail view-model.
Header spinner, FAB ring and message rows are out of scope. Light + dark, default + beta (Figtree) theme.

*— claude-opus-5-5 (orchestrator), 2026-11-22*

## Implementation

- Load-bearing assumption: the step rail's structure and trailing text are decided in pure modules (`apps/mobile/src/tool-steps.ts` `stepRowView`, the thinking-step view) and drawn by `apps/mobile/src/ui/` step components (+ `screens/transcript/TranscriptRow.tsx`); verify with `rg -n "trailing|subline|∴|thinking" apps/mobile/src` and cite file:line in Execution. Build ON TOP of fix/mobile-running-row (merged first: running dot + blink clock) — reuse its blink, never a second clock.
- Pure: `trailing` drops `✓`/`✗ exit N`; a new field for the sub-line's exit suffix (`exitSuffix?: "exit 125"`), the thinking node kind (`thinking-live` | `thought-done`). Unit tests red-before-green for each rule (ok shell, failed shell with long command, Edit, Read, thinking live, thought done).
- Render: rail continuous; branch for rows with a sub-line; sub-line = `numberOfLines={1}` command with ellipsis + a non-shrinking `exit N`; thought node ring in a theme token (add one if missing, both themes, both theme variants).
- Tokens only (no hex in components) — the mockup-kit generator reads the theme; run `bun run mockup-kit` and its test if tokens change.
- Simulator iPhone 17 Pro 0FA4B51F-A0E3-421B-BE66-CE29EF45213D: before/after screenshots (light/dark × default/beta) of a run with: a thought, a Read, an ok shell with intent, a failed shell with a LONG command, an Edit, a live Thinking — saved under `.tentacle/tmp/mobile-step-rail/`. Update any e2e flow that asserts the old glyphs; run only those flows with `scripts/e2e-gate.sh 0FA4B51F-A0E3-421B-BE66-CE29EF45213D --only <flows>`.
- changelog.d/mobile-step-rail.changed.md.

## Execution

## Review
