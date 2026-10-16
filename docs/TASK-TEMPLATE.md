<!--
Task doc template. Copy to docs/<type>/<slug>.md where <type> is feat | fix |
eval and <slug> matches the branch name <type>/<slug>. One task, one branch, one
doc. Each section is signed by the model that wrote it: `*— <model-id>, <date>*`.
See AGENTS.md §10.
-->

# <type>/<slug> — <Title>

> **Status:** context · implementation · execution · review · done
> **Branch:** `<type>/<slug>`

## Context

*— <model-id>, <YYYY-MM-DD>*

Why this task exists: the problem with evidence, the constraints, and the
decision it serves. For an `eval`, the exact question being decided.

## Implementation

*— <model-id>, <YYYY-MM-DD>*

The plan (AGENTS §8), verified against the source: cite `file:line`, name the
one load-bearing assumption and prove it, enumerate failure modes, list the
exact files in dependency order, and the tests. Approved before Execution
starts. (For an `eval`, left empty until the eval is promoted.)

## Execution

*— <model-id>, <YYYY-MM-DD>*

The as-built log: what was actually done, in order, and **any drift from
Implementation** (and why). Honest facts — the gate result (`bun run check`),
what was skipped — not a re-narration of the plan.

## Review

*— <model-id>, <YYYY-MM-DD>*

An **adversarial** pass, not a rubber stamp (AGENTS §10): re-run the gate,
red-team the Implementation's failure modes, confirm test non-vacuity (§9).
Ideally in a fresh context. State what holds, what does not, and how the
implementing model behaved on this task.
