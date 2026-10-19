# feat/task-doc-structure — nest the §8 plan inside Implementation

> **Status:** done — merged to `main` (cd7b2be) · status synced by audit 2026-10-19
> **Branch:** `feat/task-doc-structure`
> **Size:** S · **Blast:** contained · **Suited:** any model + standard review

## Context

*— claude-opus-4-8, 2026-10-16*

Open question: is the old seven-part plan shape (Problem · Preconditions · Design
· Files · Tests · Validation · Notes) better than the new four-section lifecycle
(Context · Implementation · Execution · Review), or should they merge? They sit
at different levels: the seven-part is a *plan* structure; the four-section is
the *lifecycle* (and adds Execution + Review + per-section model signatures,
which the seven-part lacks). The four-section's `Implementation`, left as a
blob, under-specifies the plan — risky for a weak model (Qwen) that needs the
checklist. Decision (owner): **merge, nested** — four sections at the top, the §8
parts as sub-structure inside `Implementation`.

## Implementation

*— claude-opus-4-8, 2026-10-16*

### Load-bearing assumption

The two formats are **not peers** — the seven-part is a subset of
`Implementation`. Proven by mapping: Problem→Context, Validation→Execution/Review,
Notes→Review, and Preconditions/Design/Files/Tests sit wholly inside the plan
(the "how"). So nesting loses nothing and duplicates nothing.

### Preconditions

AGENTS §10 already says `Implementation` = "the plan per §8"
(`AGENTS.md`), so the substance is referenced; only the template did not spell
out the sub-sections. §8 itself defines the seven parts (`AGENTS.md` §8).

### Design

Keep the four lifecycle sections as the doc skeleton. Expand `## Implementation`
in `docs/TASK-TEMPLATE.md` into §8 sub-sections (Load-bearing assumption ·
Preconditions · Design · Files · Failure modes · Tests). Add a migration note
mapping a legacy §8 plan onto the four sections. Mirror the sub-section list in
the §10 Implementation bullet.

### Files

- `docs/TASK-TEMPLATE.md` — expand Implementation; add the legacy-mapping note.
- `AGENTS.md` §10 — list the Implementation sub-sections + the mapping.

### Failure modes

- *Over-ceremony for a tiny task:* mitigated — "drop a sub-section when it
  genuinely does not apply" is stated, so an S/contained task stays light.
- *Redundancy (Problem vs Context, Validation vs Execution):* avoided by the
  explicit mapping — each old part has exactly one home.

### Tests

Docs-only; no code test. The gate (`bun run check`) must stay green, and this
doc dogfoods the new Implementation sub-structure (if the shape were unusable,
writing this section would have shown it).

## Execution

*— claude-opus-4-8, 2026-10-16*

- `docs/TASK-TEMPLATE.md`: `## Implementation` expanded into the six §8
  sub-sections with guidance; top-comment gained the legacy-§8→four-section
  mapping.
- `AGENTS.md` §10: Implementation bullet now lists the sub-sections and the
  Problem→Context / Validation→Execution-Review / Notes→Review mapping.
- This doc written in the new shape (its own Implementation uses the
  sub-sections).

**Drift:** none. Existing docs not retrofitted (legacy, per §10); the
`tui-brand-color` plan will be reshaped when that task runs.

## Review

*— claude-opus-4-8, 2026-10-16*

- **Gate:** docs-only; `bun run check` green.
- **Red-team:** the sub-sections are the §8 checklist verbatim, so they inherit
  §8's rigor; the "drop when N/A" escape hatch keeps small tasks from bloating.
  The nesting resolves the Context/Problem and Validation overlaps cleanly (one
  home each). Writing this doc through the new shape was frictionless — evidence
  the structure is usable, including by a weaker model following the template.
- **Verdict:** holds. The task doc shape is now settled: four signed lifecycle
  sections, §8 sub-structure inside Implementation.
