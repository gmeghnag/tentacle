# feat/reviewer-brief-hardening — make the reviewer brief operational, not aspirational

> **Status:** done — merged 2026-10-17
> **Branch:** `feat/reviewer-brief-hardening`
> **Size:** S · **Blast:** contained (one Markdown brief, no code; it shapes how every review agent works, which is why it is a `feat` and not a direct edit, AGENTS §10) · **Suited:** any model executes; standard Review

## Context

*— claude-opus-5-5, 2026-10-17*

The review history of `docs/feat/anthropic-api-support.md` shows that the
current `docs/REVIEWER-BRIEF.md` does not stop a reviewer from doing a
procedurally correct but shallow review. Reviewer #1 (qwen, the same family as
the executor) re-ran the gate and ran three real mutations. Even so, it:
- **wrote code during Review and approved its own change.** It added an
  end-of-stream tool_use flush, which later reviews showed was the wrong
  convergence;
- **treated the plan text as the source of truth**, so it fixed the code to
  match a flawed failure-mode design instead of attacking that design;
- **missed a false premise.** The plan said "the agent loop guarantees valid
  JSON (`agent.ts:420`)", which the code contradicts;
- **missed the external contract.** It treated `stop_reason` as
  "informational", so a tool call truncated by `max_tokens` reached the agent
  as if it were complete;
- **dismissed prior art.** `docs/eval/sse-abort-truncated-toolcall.md`, about
  the same defect class, was in the tree and was treated as out of scope.

The brief already said "Attack the plan itself" (old lines 28-33), and it was
still not done. An abstract instruction is not enough for a weaker model. Each
gap above needs a concrete, checkable step whose result shows up in the review.

**Decision served:** the owner approved the proposed replacement text
(2026-10-17).

## Implementation

*— claude-opus-5-5, 2026-10-17*

### Load-bearing assumption

A reviewer follows **checkable steps with a required output artefact** (a
table, a list) more reliably than general exhortations. Evidence: reviewer #1
did everything with a concrete artefact (gate counts, mutation results) and
skipped everything that was only a general instruction ("attack the plan").
Reviewer #3 (claude-fable-5-1) was given these exact steps in its spawn prompt
and produced a premise table that caught the drifted cites, an "Attacks tried"
list, and an end-to-end trace (`docs/feat/anthropic-api-support.md`,
review #3).

### Preconditions

- The brief must stay ≲ one screen. That cap comes from
  `docs/feat/agent-briefs.md:73` and is enforced in Review (`:131`). The old
  brief is 46 lines.
- The brief operationalises AGENTS §10 and does not restate it. Nothing in §10
  forbids or requires a reviewer to fix code, so "no code in Review" is a brief
  rule and does not contradict §10.

### Design

Replace the "Verify" and "Write the Review section" blocks in
`docs/REVIEWER-BRIEF.md` with the following:
- **Premise table:** every cited `file:line` is marked TRUE or FALSE.
- **Attack the convergences:** ask whether each planned outcome turns a loud
  failure into a silent wrong state; fail-loud beats synthesising data.
- **External-contract mapping** for API, protocol and format work.
- **Prior-art grep** in `docs/eval`, `docs/fix`, `TODO.md` and
  `library-bugs.md`.
- **One end-to-end trace** of changed behaviour.
- **"You do not write code"**, with temporary mutations excepted; a needed fix
  means REQUEST-CHANGES.
- A new verdict, **REQUEST-CHANGES**.
- A required **"Attacks tried"** list (at least 3, each with its result).
- **Same model *family*** is flagged, not only the same model.

### Files

- `docs/REVIEWER-BRIEF.md`

### Failure modes

- **Brief bloat**, which breaks the one-screen cap: rewrite tightly. Target
  around 50 lines.
- **Steps that do not apply** (e.g. no external contract or no behaviour
  change in a doc-only task): each step is scoped ("API/protocol/format work",
  "of changed behaviour"), so a reviewer can mark it N/A instead of inventing
  work.
- **"No code" vs. the mutation step:** mutations are explicitly allowed as
  temporary edits that are reverted and verified byte-identical.
- **Owner asks the reviewer to fix** (as happened in anthropic-api-support): the
  brief does not override the owner. It then requires a *new* Review of those
  fixes. That is the pattern that worked there (review #3).

### Tests

No code. Validation: the line count stays near the cap; the old brief's checks
(gate, acceptance checks, mutation, scope, honest signature) are all still
present; and a `grep` for the old verdict list finds no other live consumer
(`docs/feat/agent-briefs.md:109` is a historical task record and is left
as-is).

## Execution

*— claude-opus-5-5, 2026-10-17*

- Rewrote `docs/REVIEWER-BRIEF.md` lines 21-46: 46 → **52 lines** (+6), within
  "≲ one screen".
- Every old check is still present. Gate counts and acceptance checks are now
  merged into one bullet. Mutation non-vacuity is kept. Scope check is
  shortened to "Scope: the diff is only this task". The honest model signature
  now also covers the same *family*.
- No drift from the Implementation.
- Gate: no code changed, and `bun run lint` does not check Markdown (§6), so
  there is nothing to run.

## Review

*— claude-opus-5-5, 2026-10-17 (in-context; the same model wrote it — standard Review is allowed for `contained` S, AGENTS §10)*

**Verdict: APPROVE-WITH-NITS.**
- **Holds:**
  - each anthropic-api-support failure maps to one step: premise table,
    convergence attack, external contract, prior art, no-code rule;
  - the size cap is kept (52 lines);
  - the steps are scoped, so doc-only tasks are not burdened.
- **Nit:** the brief now asks for more work per review. A weaker model may skim
  the lower bullets. The required artefacts (premise table, Attacks tried) are
  the counter-measure, since they make a skipped step visible in the review.
- **Not verified:** whether qwen actually follows the new brief. The first real
  review run will show it, so check its Review section for the premise table
  and the "Attacks tried" list.
- **Self-review caveat:** the author reviewed its own text. A different model
  would be a stronger check, but this is not required at this blast radius.
