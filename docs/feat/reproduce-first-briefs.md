# feat/reproduce-first-briefs — re-verify the task's premise before executing it

> **Status:** done — merged 2026-10-17
> **Branch:** `feat/reproduce-first-briefs`
> **Size:** S · **Blast:** contained (three Markdown files, no code; it shapes how every executor/reviewer works, so it is a `feat`, AGENTS §10) · **Suited:** any model executes; standard Review

## Context

*— claude-opus-5-5, 2026-10-17*

Nothing in the current workflow makes the executor confirm, on current `main`,
that the behaviour a task describes actually happens before changing code:
- `docs/EXECUTOR-BRIEF.md:17` called Context and Implementation "your source of
  truth"; the executor stopped only when a *site* differed, not when the
  *symptom* did not reproduce.
- AGENTS §1 (reproduce) and §8 (verify against source) bind whoever *writes*
  the task, not whoever executes it later. An eval promoted days after it was
  written (§10 `git mv`) is never re-run.
- §9 red-before-green is only an indirect check, and a test can be red for the
  wrong reason. Example: the first red of `anthropicErrorHint` was an import
  failure; a mutation was needed to prove it (`docs/fix/anthropic-error-hints.md`).
- `docs/REVIEWER-BRIEF.md:24`'s premise table checked Implementation cites, not
  the Context's claim.

**Repro:** the audit's findings #1 (Esc trigger) and #5 (`--resume` trigger)
were overstated in their first write-up and were corrected only by the
verifying sub-agents (Block 8 in `TODO.md`). An executor following the old
brief would have treated them as true.

**Decision served:** the owner approved the proposal (2026-10-17).

## Implementation

*— claude-opus-5-5, 2026-10-17*

### Load-bearing assumption

A concrete, recorded step ("run the Repro, paste its output in Execution")
gets done; a general principle does not. This is the same evidence as
`docs/feat/reviewer-brief-hardening.md`.

### Design

- **`EXECUTOR-BRIEF.md`:**
  - "source of truth" becomes "the plan, to be verified against the code";
  - a new **Reproduce first** step: run the Repro on `main`, record the output,
    and STOP if it does not reproduce; for a feat, show the capability is missing;
  - red must be on the assertion, not on an import/compile error.
- **`TASK-TEMPLATE.md`:** a **Repro** field in Context (command, observed
  output, date).
- **`REVIEWER-BRIEF.md`:** the premise table's first row is the Context's
  symptom, with the Repro re-run.

### Files

`docs/EXECUTOR-BRIEF.md`, `docs/TASK-TEMPLATE.md`, `docs/REVIEWER-BRIEF.md`.

### Failure modes

- **No runnable repro** (doc-only task, a design feat): the "for a feat, show
  the capability is missing" wording covers it; a grep or citation is a valid
  Repro.
- **Brief bloat:** the briefs stay ≲ one screen (`docs/feat/agent-briefs.md:73`).
- **Legacy docs without a Repro field:** the executor writes the smallest repro
  itself ("or write the smallest one").

### Tests

No code. Check: line counts and that every old check is still present.

## Execution

*— claude-opus-5-5, 2026-10-17*

- Applied the Design as written; no drift.
- `EXECUTOR-BRIEF.md` 43 → 50 lines; `REVIEWER-BRIEF.md` 52 → 53;
  `TASK-TEMPLATE.md` 90 → 94.
- Gate: Markdown only, and `bun run lint` does not check Markdown (§6), so
  there is nothing to run.

## Review

*— claude-opus-5-5, 2026-10-17 (in-context; the same model wrote it — allowed for `contained` S, AGENTS §10)*

**Verdict: APPROVE-WITH-NITS.**
- **Holds:**
  - each gap in Context maps to one change;
  - the old checks are untouched;
  - both briefs are still about one screen.
- **Nit:** existing feat/fix docs have no Repro field. The executor falls back
  to writing one, which costs one step on legacy tasks.
- **Not verified:** whether a weaker model (qwen) actually stops on a
  non-reproducing task. Check this on the first Block 8 fix: its Execution
  should open with the repro output.
- **Self-review caveat:** the author reviewed its own text.
