# feat/docs-direct-commit-carveout — docs & index edits are not tasks

> **Status:** done — merged to `main` (94a6f48) · status synced by audit 2026-10-19
> **Branch:** `feat/docs-direct-commit-carveout`
> **Size:** S · **Blast:** contained · **Suited:** Opus authors (a rules change — wants the reasoning trail); standard in-context Review (docs-only, no §7 code invariant touched).

## Context

*— claude-opus-4-8, 2026-10-17*

Today every change — including a one-line edit to `TODO.md` or a standalone
notes doc — must, by the letter of the standard, go through a task branch:
AGENTS §6 says "if on `main`, branch first" and §10 says "every change … is a
single task with a single branch." That discipline exists to protect **code**
from parallel-edit / merge conflicts and to gate risk by blast radius. For a
blast-nil Markdown file that carries no code (Biome skips Markdown, §6; nothing
to typecheck, test, or build; no merge conflict with code) the ceremony buys
nothing.

**Decision (owner, 2026-10-17):** carve out a direct-to-`main` path for
blast-nil docs/index edits — `TODO.md`, `docs/library-bugs.md`, folder READMEs,
and standalone decision/notes docs under `docs/` — while keeping the branch
discipline exactly where it earns its keep.

Why this is itself a task (not done direct): the carve-out is **not yet explicit
in AGENTS**, so we are still under the current regime where every change is a
task. You cannot invoke a not-yet-existing exemption to skip the branch — the
rules are changed by following the rules in force. And a substantive change to
AGENTS's own rules is precisely the class that should keep its reasoning trail +
Review (see the Design's point (c)). So: a microtask.

## Implementation

*— claude-opus-4-8, 2026-10-17*

### Load-bearing assumption

The exemption is safe **only** for prose with no code reach. The branch rule's
whole purpose (§10: "prevents the parallel-edit / merge-conflict mess") is a
*code* concern; a Markdown file that is never typechecked, tested, or built, and
that no code imports, cannot break `main` or conflict with a code branch.
Verified: §6 states Biome "checks TS/JS/JSON; not Markdown", and `bun run check`
is typecheck→lint→test — none of which a doc-only edit can fail. So removing the
branch for this class removes ceremony, not a safety net.

### Preconditions (verified)

- AGENTS §6 — "Git: commit only on the user's explicit OK; if on `main`, branch
  first." The carve-out is the one exception to the second clause; the first
  clause (explicit OK) is **unchanged**.
- AGENTS §10 — "every change … is a single task"; `TODO.md` = the backlog/index,
  `docs/library-bugs.md` = a registry (reference, not a task). The carve-out
  slots in as a sibling bullet after "Index & registries".
- AGENTS §6 — Biome does not lint Markdown; the gate cannot be reddened by a
  doc-only edit. This is the fact the load-bearing assumption rests on.

### Design

Two edits, both in `AGENTS.md`, additive:

1. **New §10 bullet** after "Index & registries": define the carve-out and,
   critically, its boundaries — what is NOT exempt:
   - (a) a **task's own doc** (`docs/<type>/<slug>.md`) — it *is* the task, rides
     the task branch;
   - (b) a Markdown edit **bundled with a code change** — rides that code's task
     branch;
   - (c) a **substantive change to AGENTS's rules** — stays a task (process-load-
     bearing: it shapes how everyone works, so keep the reasoning trail +
     Review). A typo/link/formatting fix to any doc is fine direct.
   And restate: the carve-out removes the branch, **not** the explicit-OK (§6).
   Tie-break when unsure ("does this touch code / change a rule?") → treat as a
   task.
2. **§6 parenthetical** on the Git bullet: "if on `main`, branch first (except
   the docs/index carve-out in §10)" so the two sections don't contradict.

### Files

- `AGENTS.md` — the new §10 bullet + the §6 parenthetical. No other file.

### Failure modes

- *Scope creep — someone exempts a code-bearing or rule change.* Designed out by
  the explicit NOT-carved-out list (a)(b)(c) and the "when unsure, treat as a
  task" tie-break (err toward the branch).
- *Contradiction between §6 and §10.* Removed by the §6 parenthetical pointing at
  §10 (single cross-reference, one source of the exception).
- *Losing the reasoning trail for rule changes.* Prevented by (c): AGENTS rule
  changes stay tasks; only blast-nil prose is exempt.

### Tests

Docs-only; no code test. `bun run check` must stay green (Biome skips Markdown,
so this is "didn't break anything"). This task **dogfoods the boundary**: it is
itself an AGENTS rules change, and per its own point (c) it is run as a task —
evidence the rule classifies correctly from the first use.

## Execution

*— claude-opus-4-8, 2026-10-17*

Two `AGENTS.md` edits, as designed:

1. §6 Git bullet — appended "(except the docs/index carve-out in §10)" so the
   branch-first rule and the carve-out cross-reference instead of contradicting.
2. §10 — new bullet "Docs & index edits are not tasks (carve-out)" inserted
   after "Index & registries", before "Agent briefs": the direct-to-`main` path
   for blast-nil docs/index prose, the explicit NOT-carved-out list (a) task
   docs, (b) prose bundled with code, (c) substantive AGENTS rule changes, the
   preserved explicit-OK, and the "when unsure, treat as a task" tie-break.

**Drift:** none — exactly the two edits in Files, no other lines touched.

**Verification:** `bun run check` → green (Biome skips Markdown, so the edit
carries no lint surface; full suite unchanged, 646 pass / 1 skip / 0 fail).

## Review

*— claude-opus-4-8, 2026-10-17 (same-model, in-context — contained/S docs, §10 permits standard Review)*

**Verdict: APPROVE.**

1. **Gate:** `bun run check` green; 646 pass / 1 skip / 0 fail. Markdown-only.
2. **No contradiction:** §6's "branch first" now carries the `(except … §10)`
   pointer; §10 holds the single definition of the exception. One source.
3. **Scope-creep hole closed:** the (a)(b)(c) NOT-carved-out list plus the
   "when unsure, treat as a task" tie-break mean the exemption can only apply to
   prose with no code reach and no rule change. Erring upward (toward the branch)
   is the designed default.
4. **Explicit-OK preserved:** the bullet states the carve-out removes the branch,
   not the §6 OK — verified against the §6 edit (the OK clause is untouched).
5. **Self-consistent dogfood:** this very task is an AGENTS rule change and was
   run as a task per its own point (c) — the boundary classified correctly on
   first use.

**Self-red-team:** the one soft edge is judging "substantive rule change" vs
"typo/link fix" — a grey zone. Mitigated by the tie-break (unsure → task); the
cost of over-classifying is a cheap extra branch, the cost of under-classifying
is a rule change with no trail, so the asymmetry is set the safe way. No fix
needed.
