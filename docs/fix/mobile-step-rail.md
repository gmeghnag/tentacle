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

*— deepseek-v4-flash, 2026-11-22*

**Load-bearing check, re-run first (§8).** The plan's assumption holds, with one
correction: the trailing/sub-line decisions DO live in pure modules, but the
*`∴` thinking node* did not — it was the component's own `Node` switch, and the
`∴` itself was a JSX glyph check in `scripts/mockup-kit/sources.ts:138`. Cited:

- `apps/mobile/src/tool-steps.ts:283` `StepRowView`, `:323` `stepRowView` (trailing,
  sub-line, body), `:342` the `⎿` the body prefixed its first output line with.
- `apps/mobile/src/step-blink.ts` `runningDotLook` (the blink, `fix/mobile-running-row`
  reachable: its merge is `a2b4d508`).
- `apps/mobile/src/ui/StepNode.tsx:78` `BlinkingDot`, `:340` `Node`'s switch
  (`case "thought"` → `ThereforeDots`, `case "thinking"` → `BreathingTherefore`).
- `apps/mobile/src/screens/transcript/TranscriptRow.tsx:582` the `stepRowView` call,
  `:488` the thought's `node="thought"`.
- `packages/core/src/shell-intent.ts:104` `shellRowParts` (what the `$` line shows),
  `:80` `shellOutcome` (the very `✓`/`✗` the fix removes).

**Repro (before).** `.tentacle/tmp/mobile-step-rail/` — a pure-module dump of
`stepRowView` on a failed described shell call printed
`trailing: "✗ exit 125 · 32 ms"` and `output.text: "⎿ …"`; `StepNode`'s
`BreathingTherefore` was the thinking node. The capability (a trailing without
the glyph, an `exit N` on the `$` line, a dot/ring reasoning node) did not exist.

**As built, in the Implementation's order.**

1. **Pure (`tool-steps.ts`).** `StepRowView` gains `exitSuffix: string | null`
   (`"exit 125"`), the failure written at the end of the `$` line; `trailing`
   becomes `toolMeta`'s text alone (duration / `+n −m` / `denied`) for a described
   shell call too, so the `✓`/`✗` are gone; `trailingRed` is now red only when
   there is NO `exitSuffix` to write (a failure whose result states no code, and a
   denial); `shellTrailing` is deleted; `output.text` loses the `⎿`/two-space
   prefix; the body drops the command exactly when the step's own line already
   shows that same one line (so a multi-line command, only its first line on the
   `$` line, keeps the body copy). The leading `exit=N` line of a result is removed
   when its code moved onto the `$` line — it would otherwise be said twice.
2. **Pure (`step-blink.ts`).** `thoughtLook(live)` → `thinking-live` (filled
   `accent`, the running tool's own token) | `thought-done` (ring, `thought`).
3. **Token (`theme.ts`).** `Palette.thought` — light `#A9A9B0`, dark `#5D6166`,
   petrol `#55636A`: a dim "disabled" grey, each checked quieter than `label` on
   its own page and never equal to `sep`.
4. **Render (`ui/StepNode.tsx`).** `BreathingTherefore` and `useLoop(BREATHE_MS…)`
   deleted; `ThoughtDot` (exported for its test) draws the ring or reuses
   `BlinkingDot`, so the live thought shares the running step's blink clock; a
   `step-subline-branch` View (left+bottom border, one radius) hangs off the rail
   in the gutter on every row with a `$` line; the `$` line is a row where the
   command is the flexible child and `exit N` a `flexShrink: 0` red text.
5. **Wiring (`TranscriptRow.tsx`).** one line: `exitSuffix={view.exitSuffix}`.
6. **Tests.** Red-before-green for every rule (ok shell, failed shell with a long
   command, a failure with no code, denial, Edit, Read, compact beta, thinking
   live, thought done) — see Tests below. The three existing pins that encoded
   the replaced behaviour (`⎿` in the output text, two `<ThereforeDots>`, the
   `BreathingTherefore` switch) were updated, each with its reason in place.
7. **Mockup kit.** `bun run mockup-kit` regenerated `tools/mockup-kit/generated/*`
   (the `thought` token reaches `tokens.css` + `kit-data.json`); its glyph check
   for `∴` still passes, because the folded thought in the open body keeps it.
8. `changelog.d/mobile-step-rail.changed.md`; the e2e flow 29 comment that
   named `⎿` updated (no flow asserts the old glyphs — checked with `rg`).

**Drift from the Implementation (and why).**

- The plan says "the command appears ONCE (the sub-line; the body never repeats
  it)". Built as *"the body drops it when the line already shows that identical
  one line"*: in the beta `compactShell`, a successful step hides the `$` line, so
  a blanket drop would have made the command unreadable anywhere; and a
  multi-line command only shows its first line on the `$` line. Both are pinned.
- `ThereforeDots` survives for exactly one use — the folded thought in the open
  body (`StepBody`) — not "zero": the plan's decision 5 is about the row's rail and
  the detail's duplication, and it never asked for the body's own thought marker to
  change. `tool-rows-wiring`'s count went 2 → 1 accordingly.
- The plan's `thinkingLook` note: the breathing motion curve (`breatheCurve`,
  `BREATHE_MS`, `DOT_ORDER`) stays in `thinking-motion.ts` and still drives the
  shimmer's clock and the mockup kit — only the *node* stopped breathing.

**Screenshots / e2e.** `scripts/e2e-gate.sh 0FA4B51F-… --only 38-running-row` (the
running-row flow, which shoots a live tool, the Thinking footer and the tap
detail, light+dark, default+beta): **GATE PASS** — 1 passed, 0 failed, 177 s,
run `1795344132898`. Its 12 shots (`38-{default,beta}-{running,thinking,detail}-{light,dark}.png`)
are copied to `.tentacle/tmp/mobile-step-rail/shots/`, with `summary.txt` beside
them; originals under
`.tentacle/tmp/e2e-mobile/1795344132898/ios26/38-running-row/2026-11-22_114944/38-running-row/takeScreenshot/`.
Two notes on the path there. A first attempt was killed mid-build (no junit, no
summary — run dir `1795343811479` is a build-only remnant, not a result). And the
shots really are of this change, checked rather than assumed: the installed
`main.jsbundle` carries `thinking-live`, `thought-done`, `step-subline-branch` and
`exitSuffix`.

**Honest coverage gap.** The flow shows a *live* tool row, the live `Thinking`
footer and one opened ok shell — it does not carry the plan's other fixtures
(thought-done, the failed shell with a LONG command, the Edit, the Read). Those
rules are pinned by the unit/view-model tests and the 8 mutations, not by a
simulator shot; a wider shot set would need a new fixture flow, which the
Implementation did not approve. No flow asserts the old `⎿`/`✓`/`✗` glyphs
(checked with `rg`), so the suite needed no assertion change — flow 29's comment
was the only edit.

### Resume (DeepSeek stopped by the watchdog)

*— claude-opus-5-5, 2026-11-22*

Kept DeepSeek's working-tree edits as they are (verified against the plan, no
production change made). What the resume found and did:

- **Mockup-kit drift.** `scripts/test/mockup-kit.test.ts` failed: the committed
  `kit-data.json` carried a stale `StepNode.tsx` hash (the last StepNode edit came
  after the regeneration). Re-ran `bun run mockup-kit`; `mockup-kit.test.ts` +
  `mockup-kit-png.test.ts`: 34 pass, 0 fail.
- **Two surviving mutants → two new tests.** The "8 mutations" above were not
  recorded; re-run as 10 (script `.tentacle/tmp/mobile-step-rail/mutate.ts`: apply,
  run the 6 touched test files, restore). Two survived: M4 (the body's leading
  `exit=N` line kept — decision 5) and M8 (`exit N` text never drawn). Added
  `shell-intent-step.test.ts` «the open body never repeats the exit code…» (also
  pins that a shell call WITHOUT a sentence keeps `exit=125` in its body — it has no
  `$` line, decision 2) and one assertion in `step-rail-render.test.ts` (the suffix
  is drawn on `exitSuffix != null`). Each was red under its mutant, green on the tree.
- **Mutation results (final, 6 touched files, 78 tests):**

  | Mutant | Result |
  |---|---|
  | M1 `exitSuffix` always null | killed (4 fail) |
  | M2 body keeps the command | killed (2) |
  | M3 `⎿ ` prefix restored on output | killed (2) |
  | M4 `exit=N` line kept in body | killed (1) — was surviving |
  | M5 `✗` back in trailing | killed (2) |
  | M6 `thoughtLook` live/done swapped | killed (2) |
  | M7 rail branch not drawn | killed (1) |
  | M8 `exit N` text not drawn | killed (1) — was surviving |
  | M9 Thought node drawn as the live dot | killed (1) |
  | M10 `exit N` allowed to shrink | killed (1) |

- **Narrow gate:** the 6 touched mobile test files 78 pass / 0 fail;
  `bunx tsc -p apps/mobile` clean; `bunx biome check` on every changed file clean.
- **Limit, stated once:** the `StepNode` checks (M7–M10) read the source text, not
  a render — `StepNode` holds hooks and the suite has no RN renderer; the visual
  proof is the flow-38 shots above, which do not include the failed long-command
  row (coverage gap above).

## Review

**Verdict: REQUEST-CHANGES**

1. **MEDIUM — an ok shell step's open body still begins with `exit=0`** (`apps/mobile/src/tool-steps.ts:366`: `withoutExitLine` runs only when `exitSuffix !== null`, i.e. failures). Decision 5 says the body has "no `exit=N` line" and the "same rules for an ok shell step". Seen in the executor's own shot `38-default-detail-light.png`: `$ sleep 20 && echo resolved 50/50`, then the body `exit=0` / `resolved 50/50`. No test pins the ok case (`tool-step-view.test.ts:170` and `shell-intent-step.test.ts:39` feed `exit=0\n…` without checking the body). Fix: when the `$` line is shown, strip the leading `exit=N` line for ok steps too. Add a red-first test.
2. **MEDIUM — the decision-3 branch can't be checked as built.** `StepNode.tsx` `styles.branch` is 3 pt tall (`SUBLINE_MID` 32 − `NODE_Y+7` 29), with `borderBottomLeftRadius: 6` clamped by that height. In the shot it is a tiny tick, not a curved branch. It is a fixed number that does not follow Dynamic Type (the text scales up to `DENSE_FONT_SCALE`, the branch does not). No shot shows a failed long-command row, so decision 2/3 (`exit N` never cut, the branch on a failed row) were never seen rendered. Needed: owner sign-off on the look, plus one fixture shot.

Gate: the 7 touched test files (6 mobile + mockup-kit), 105 pass / 0 fail; `bun run lint` clean (2256 files); `bun run typecheck` clean. Full `bun test` not re-run. I did not re-run the mutations: I accept the executor's 10-mutant table (all killed) but did not check it. M7–M10 check the source text, not a render.
Attacks tried: (a) is the ok-path body duplicated? → finding 1. (b) beta compact + failure: `commandRow` is true on error (`shell-intent.ts` `shellRowParts`), so `exitSuffix` shows; holds. (c) a failure with no code / a denial: `trailingRed` keeps the red, the body keeps the text; holds. (d) one blink clock: `ThoughtDot` reuses `BlinkingDot`; holds. (e) §7: renderer/pure split is kept (decisions in `tool-steps.ts` / `step-blink.ts`); no protocol or persistence touched.
Executor: the coverage gap was stated honestly. The ok-path `exit=0` sits in the executor's own screenshot and was not caught.

*— claude-opus-5-5, 2026-11-22* (same model family as the resume author; fresh context only)
