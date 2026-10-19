# eval/changelog-discipline — do we adopt a CHANGELOG, and in what form?

> **Status:** eval (Context + Review; Implementation empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Size:** S · **Blast:** contained · **Suited:** a process decision — Opus drafts the question + recommendation; owner decides. If promoted → a `feat` task edits AGENTS + seeds `CHANGELOG.md`.

## Context

*— claude-opus-4-8, 2026-10-17*

**The question being decided:** should tentacle keep a `CHANGELOG.md`, and if so
under what rule — and specifically, is "update a changelog after **every**
feature/bugfix" the right discipline?

**Evidence / what we already have.** Change history is already tracked three
ways, all **developer-facing**: conventional-commit git history (`feat`/`fix`/
`docs`), per-task docs under `docs/{feat,fix,eval}/` (Context · Implementation ·
Execution · Review), and `TODO.md` as the backlog/index. So the *how* and *why*
of every change is already captured for us and future contributors.

A `CHANGELOG.md` is a different artifact with a different audience: **user-facing**,
grouped by **release version**, phrased as what changed *for a user* ("Added X",
"Fixed Y that caused Z", breaking changes called out). Nobody reads it today —
there are no external users and it would duplicate the commit message + the
task's Execution.

**So the need is time-dependent:**
- *Now* (solo-dev, pre-public, daily-driver): not strictly needed; git + task
  docs cover it, and a per-commit changelog is pure ceremony — cutting against
  the `docs-direct-commit-carveout` we just adopted to *remove* ceremony.
- *At the public v0.1.0*: a real gap (flagged in the release-readiness
  assessment). Users then need "what's new / what broke / safe to upgrade?".

**Why "always, per feature/bugfix" is the wrong shape (two reasons):**
1. *Granularity mismatch* — a changelog is organised by **release** and by
   **user-visible** change, not by commit. Much recent work (agent-briefs, this
   carve-out, refactors, test-only) has zero user-facing value; "always" would
   pollute it with noise. A good changelog is **curated, not a commit mirror**.
2. *Ceremony* — forcing an entry on every commit now, with no reader, duplicates
   the commit and the Execution section for nothing.

**Options on the table:**
- **(A) None yet** — rely on git + task docs; reconstruct a changelog from
  history at release time. Risk: archaeology is error-prone and misses
  user-framing.
- **(B) Keep a Changelog + SemVer, curated, with a `## [Unreleased]` section**
  — a task with **user-visible** impact adds **one line** under Unreleased
  (Added/Changed/Deprecated/Removed/Fixed/Security; breaking changes explicit);
  internal/dev changes are excluded. At release, `[Unreleased]` → `[x.y.z] -
  date`. Light discipline, no archaeology, no per-commit ceremony.
- **(C) Per-commit changelog** (the "always" proposal) — rejected above
  (granularity + ceremony).

**Open sub-questions for the decision:**
- Start the `Unreleased` section **now** (cheap insurance against release-time
  archaeology) or only at the first public tag?
- Does the AGENTS rule live as its own short bullet, and is adding it itself a
  task (yes — a substantive AGENTS rule change, per the carve-out's point (c))?

## Implementation

*(empty — an eval is not built until promoted to a `feat`.)*

## Execution

*(empty.)*

## Review

*— claude-opus-4-8, 2026-10-17 (recommendation; owner decides)*

**Recommendation: option (B)**, adopted **lightly and now**.

- **Adopt (B), reject (C).** A curated, release-grouped, user-facing changelog is
  the standard that earns its keep; the per-commit "always" rule is the wrong
  granularity and adds ceremony we just worked to remove.
- **Start now, cheaply.** Create `CHANGELOG.md` with a `## [Unreleased]` section
  seeded with only the few **user-visible** changes to date (e.g. AGENTS.md
  auto-load is a behaviour change users would see; agent-briefs / this carve-out
  / workflow docs are internal → excluded). This avoids reconstructing v0.1.0 by
  git archaeology later, at near-zero ongoing cost.
- **The AGENTS rule** (draft): "`CHANGELOG.md` (Keep a Changelog + SemVer) is
  user-facing, curated per release — not a commit mirror. A task with
  user-visible impact adds one line under `## [Unreleased]` in the right category
  (Added/Changed/Fixed/Security/Deprecated/Removed), breaking changes explicit;
  internal changes (refactor, workflow, docs, test-only) are excluded. At
  release, `[Unreleased]` → `[x.y.z] - date`."

**Promotion trigger:** promote this eval to a `feat` task (`feat/changelog-
discipline`) when the owner approves — that task edits AGENTS (the rule above; a
substantive rule change, so it *is* a task per the carve-out's point (c)) and
seeds `CHANGELOG.md` on its branch. Until then this stays an eval.

**What would change the recommendation:** if the public release is abandoned or
indefinitely deferred, drop to option (A) — without users, even (B) is overhead.
