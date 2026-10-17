<!--
Task doc template. Copy to docs/<type>/<slug>.md where <type> is feat | fix |
eval and <slug> matches the branch name <type>/<slug>. One task, one branch, one
doc. Each section is signed by the model that wrote it: `*— <model-id>, <date>*`.
See AGENTS.md §10.

Migrating a legacy §8 plan into this shape: Problem → Context; Preconditions /
Design / Files / Tests (+ the load-bearing assumption, failure modes) →
Implementation (sub-sections below); Validation → Execution (the gate result)
and Review (the judgment); Notes/debt → Review (+ follow-ups).
-->

# <type>/<slug> — <Title>

> **Status:** context · implementation · execution · review · done
> **Branch:** `<type>/<slug>` — `feat`/`fix` only; an `eval` has **no branch** (committed directly to `main`, see AGENTS §10)
> **Size:** S | M | L · **Blast:** contained | cross-module | load-bearing · **Suited:** <who executes + review level>

<!--
Size (effort): S one file/module, known approach · M a few files, some design ·
L many files / a new subsystem. No XL — split it. Blast (reach if it breaks):
contained (leaf code, no API/protocol/persistence/IO change) · cross-module
(shared util / several packages) · load-bearing (an AGENTS §7 invariant, the
agent loop, a widely-depended seam). Suited: `load-bearing` (any size) or `L`
→ strong model + mandatory fresh-context Review; `contained` S–M → a weaker
model + standard Review. See AGENTS.md §10.
-->


## Context

*— <model-id>, <YYYY-MM-DD>*

Why this task exists: the problem with evidence, the constraints, and the
decision it serves. For an `eval`, the exact question being decided.

**Repro:** the command/script that shows the problem (for a feat: that the
capability is missing) and the output observed, with its date. The executor
re-runs it on current `main` before any edit (`docs/EXECUTOR-BRIEF.md`).

## Implementation

*— <model-id>, <YYYY-MM-DD>*

The plan (AGENTS §8), verified against the source — approved before Execution
starts. (For an `eval`, left empty until the eval is promoted.) Fill the
sub-sections below; drop one only when it genuinely does not apply.

### Load-bearing assumption

The ONE thing the change stands or falls on. Prove it with `file:line` before
anything else; if you cannot cite it, you do not know it.

### Preconditions

Verified invariants / facts the change relies on, each cited `file:line`
(especially any AGENTS §7 invariant it leans on).

### Design

How it works. Prefer the additive, reuse-existing-seams shape (§7); name the
shared source of truth and wire both ends.

### Files

The exact files to change, smallest diff, in dependency order (protocol →
daemon → client → cli → tui).

### Failure modes

Not just the happy path: error, disconnect, race, empty input, version skew —
and, for each, how state converges. A silent drop is a bug; design it out.

### Tests

Red-before-green for a fix (§9); the exact property each test pins, with the
fakes/seams to use.

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
