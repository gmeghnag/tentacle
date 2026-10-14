# AGENTS.md

Operating rules for AI agents working in this repository.
Goal: correct results at minimum token cost, with explicit stop rules so work
never degrades into repetitive reasoning loops. These rules are mandatory, not
style suggestions.

## 0. Hard stop rules (anti-loop)

- **Two-strike rule**: if two attempts with the *same approach category*
  (static code reading, the same kind of experiment) fail to advance
  understanding, stop that category. Switch category (static → empirical, or
  vice versa) or ask the user. Never a third iteration of the same approach.
- **Repetition detector**: if you catch yourself re-deriving the same
  calculation, re-reading the same file region, or re-arguing a question you
  already answered — that is a loop. Break it with the single cheapest
  experiment that decides the question, or by asking the user one specific
  question.
- **Escalate, don't spin**: when blocked (missing access, ambiguous
  requirement, repeated failures), stop and report in 2–3 sentences: what was
  tried, what is known, the specific decision needed. Then wait.
- **Clarify constraints early**: if a user constraint is ambiguous ("don't
  write code" — does a throwaway repro in `/tmp` count?), ask one short
  question immediately. Do not burn reasoning budget navigating constraints.

## 1. Bugs: reproduce before diagnosing

- The first deliverable for a bug is **evidence, not a hypothesis**: the
  smallest possible reproduction that captures the actual observable
  (rendered frames, command output, state dump). A 20-line before/after diff
  usually contains the answer; 200 lines of code reading may not.
- **Characterize the symptom before reading code** — from the report, or with
  one question to the user:
  1. *Trigger*: which exact action/event causes it (press vs drag vs release;
     first render vs resize; …).
  2. *Magnitude*: how much does it deviate — fixed number, proportional,
     random? A constant tied to content structure ⇒ layout bug. A value tied
     to state (scroll offset, counters) ⇒ state bug.
  3. *Collateral*: what else changes at the same moment (spacing, colors,
     missing/extra lines, messages)?
- Only after a reproduction exists, read code — with the specific question the
  reproduction raised.
- **TUI bugs specifically**: this repo already has `ink-testing-library` and
  SGR mouse helpers in `packages/tui/test/app.test.tsx`. Copy that pattern.
  Do not derive rendering behavior by armchair reasoning over Ink source;
  capture frames and diff them.

## 2. Hypothesis discipline

- One hypothesis at a time. Each must be **falsifiable by a cheap test**
  (a command, a diff, a 10-line script). If you cannot name the cheap test,
  you have a story, not a hypothesis.
- Read code to *generate* hypotheses, not to *prove* them. Proof comes from
  execution.
- **Prove the exact property that kills the bug**, not a weaker correlated
  one. Classic trap: proving "frame height is constant" when the bug needs
  "content position is stable" — it feels like proof, it isn't.
- **One-sentence check** before each significant step on a multi-step task:
  "I know X for sure; my current hypothesis is Y; my next cheapest test is Z."
  If any of X/Y/Z is blank or vague, stop and fix that first.

## 3. Reading discipline

- Never open a file "to get the picture". Open it to answer one named
  question; name the question first.
- If the answer is likely in a file you already read, **re-read it with the
  new question** instead of opening a new file. (Documented failure mode:
  reading the one file that contains the answer and not registering it,
  because the question was aimed at the wrong layer.)
- Use `rg`/`grep` for "where is X" before reading whole files.

## 4. Verification

- During iteration: run only the relevant test file
  (`bun test packages/tui/test/app.test.tsx`), not the full suite.
- Before reporting done: full `bun test` + `bun run typecheck` + `bun run
  lint`, compared against the pre-existing lint baseline in §6 so the claim
  "no new issues" is true.
- Every fix ships with a regression test that was **shown failing on the
  buggy code** (red) before the fix (green). A test that passes on both
  proves nothing.

## 5. Output discipline

- Report: what changed (file:line), why (root cause in one sentence),
  evidence (command output, before/after). No narrative of the journey.
- Do not include failed-attempt history unless asked. State the unverified
  part in one line: what it is and how to verify it.

## 6. Repo facts (verified)

- Bun workspaces monorepo, 13 packages, TypeScript strict, Biome.
  - `bun test` — full suite (368 passing as of this writing).
  - `bun run typecheck` — `tsc --noEmit`.
  - `bun run lint` — `biome check .`
  - `bun run check` — typecheck + lint + test.
- **Lint baseline: clean (0 errors, 0 warnings).** `bun run lint` passes, so
  `bun run check` is green for lint; any new error/warning is yours. (The
  earlier baseline of 1 error + 5 warnings in `packages/tui` no longer
  reproduces — those were resolved since.)
- TUI stack: Ink 5.0.1, React 18.3.1, ink-testing-library 4.0.0.
- **Ink gotcha (already bit us once)**: an empty `<Text>` measures as `0×0`,
  so a per-row `<Text>` list collapses blank rows and shifts content up.
  Render blank rows as `" "` (the output grid `trimEnd()`s it back to `""`).
- **TUI repro from `/tmp`** (when the repo must stay untouched): bun cannot
  resolve bare/directory imports from `/tmp`, so import via absolute paths
  into the `.bun` store, and use `createElement` instead of JSX (avoids
  `react/jsx-runtime` resolution):
  ```ts
  import { createElement as h } from "<repo>/node_modules/.bun/react@18.3.1/node_modules/react/index.js";
  import { Box, Text } from "<repo>/node_modules/.bun/ink@5.0.1+d2b1a511eef311f2/node_modules/ink/build/index.js";
  import { render } from "<repo>/node_modules/.bun/ink-testing-library@4.0.0+2b82e8ab9dffa8af/node_modules/ink-testing-library/build/index.js";
  import { App } from "<repo>/packages/tui/src/App.tsx"; // TS/TSX source: absolute paths work
  ```
- Git: branch `main` has **no commits yet**; everything is untracked. Ask
  before creating the first commit.
- Docs: `README.md`, `ARCHITECTURE.md`, `docs/F3-remote-control.md` (proposed
  design, no code yet).
