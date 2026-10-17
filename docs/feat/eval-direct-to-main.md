# feat/eval-direct-to-main — evals are direct-to-main; de-ambiguate §10

> **Status:** implementation (ready to execute)
> **Branch:** `feat/eval-direct-to-main`
> **Size:** S · **Blast:** contained · **Suited:** a substantive AGENTS rule change (so it *is* a task, per the §10 carve-out point (c)); Opus authors; standard in-context Review. Docs-only.

## Context

*— claude-opus-4-8, 2026-10-17*

The task standard treats `feat`, `fix`, and `eval` identically — "every change
… is a single task with a single branch." But an `eval` is a **decision record**,
not code work: by nature you create many, often in parallel, many stay open, and
some are never built. Forcing branch-per-eval + "one task branch at a time"
means 100 evals = 100 branches, you can't hold more than one open, and you're
pushed to "close" (merge) records that should simply stay open. That is wrong —
and it directly contradicts the `docs-direct-commit-carveout` we just added,
whose whole point is that blast-nil prose doesn't need a branch.

The root fix: **an `eval` carries no code → it is committed directly to `main`,
no branch.** The branch discipline exists to protect *code* from parallel-edit /
merge conflicts (§10's own rationale); an eval has no code to protect. A branch
is born only for `feat`/`fix` (real code work), or when an eval is **promoted**.

**Decision (owner, 2026-10-17):** make §10 internally consistent on this — remove
**every** ambiguity between "eval as a branch-based task" and "eval as a
direct-to-main record". (This also retro-justifies that `eval/changelog-discipline`
should have been direct — the branch I made for it was unnecessary ceremony,
though the end state on `main` is identical.)

## Implementation

*— claude-opus-4-8, 2026-10-17*

### Load-bearing assumption

The two task shapes are cleanly separable by **"does it change code?"**:
`feat`/`fix` do (→ branch, lifecycle, merge); `eval` does not (→ direct-to-main
record, Context + Review verdict, promotion opens the branch later). Every §10
clause that currently says "branch" or "one at a time" for *all* tasks is fixed
by scoping it to the code tasks and stating the eval path explicitly. No code,
no behaviour — the gate (`bun run check`) cannot regress on a Markdown edit (§6,
Biome skips Markdown).

### Preconditions (verified)

The seven §10 spots that conflate eval with branch-based tasks (all in
`AGENTS.md` as it now stands):
1. Header `## 10. Task workflow (one task, one branch, one doc)`.
2. Intro: "Every change … is a single task with a single **branch**".
3. "One task at a time … exactly ONE task **branch** off `main` at a time".
4. `docs/eval/` folder desc + promotion ("`git mv` … and **rename the branch**").
5. "Branch ↔ doc, 1:1 … Branch `<type>/<slug>`" (states every type has a branch).
6. "Lifecycle: … → **merge**. An `eval` often stops at Context + Review."
7. Carve-out: inclusion "standalone decision/notes doc" **overlaps** exclusion
   (a) "a task's own doc (`docs/<type>/<slug>.md`) … rides the task's branch" —
   an eval doc matches *both*. This is the exact ambiguity the owner hit.

### Design

One consistent model, applied to all seven:
- **feat/fix** = code work → branch `<type>/<slug>`, doc rides the branch,
  **one code-task branch at a time**, lifecycle Context → Implementation →
  Execution → Review → merge.
- **eval** = decision record, no code → committed **directly to `main`**, no
  branch; any number open at once; lifecycle = Context + a Review verdict;
  Implementation/Execution empty until **promotion** (`git mv` to `feat/`|`fix/`
  **and open the code branch then**).
- **Carve-out** (direct-to-main prose): `TODO.md`, registries, READMEs,
  standalone notes, **and `eval` docs**. Exclusion (a) applies to **feat/fix**
  task docs only (they ride the code branch); an eval doc explicitly does not.
  (b) and (c) unchanged. Explicit-OK (§6) still required for every direct commit.

### Files

- `AGENTS.md` — the seven edits above (header, intro, one-at-a-time, eval
  folder+promotion, branch↔doc, lifecycle, carve-out). No code.
- `docs/TASK-TEMPLATE.md` — the `Branch:` header line gets a note that an `eval`
  has no branch (direct-to-`main`), so the template matches §10.

### Failure modes

- *New contradiction introduced elsewhere.* Mitigated: after editing, grep §10
  for "branch" and confirm each remaining use is scoped to feat/fix (Review
  step).
- *Over-correction — someone reads "eval = no branch" as "eval needs no Review".*
  Guarded: the eval path still has a Review verdict; only the branch and the
  merge gate are dropped, not the adversarial judgment.

### Tests

Docs-only; no code test. `bun run check` stays green (Markdown). Verification is
a re-read of §10 for internal consistency (no "branch"/"one at a time" clause
still applying to evals) — done in Review.

## Execution

*— claude-opus-4-8, 2026-10-17*

All seven §10 spots fixed, plus the template:

1. **Header** → "(one task, one living doc)".
2. **Intro** → states the two shapes: feat/fix = code + branch; eval = decision
   record, no code, direct to `main`.
3. **One-at-a-time** → "One **code** task at a time … ONE **code-task** branch";
   evals explicitly don't count and any number may be open.
4. **eval folder + promotion** → "carries no code, committed directly to `main`,
   no branch"; promotion = `git mv` to feat|fix **and open the code branch then**
   (was "rename the branch", which assumed one existed).
5. **Branch ↔ doc** → scoped "(`feat`/`fix` only)"; eval has only its doc on
   `main`.
6. **Lifecycle** → split: feat/fix Context→…→merge; **eval** = Context + Review
   verdict, straight to `main`, no merge.
7. **Carve-out** → inclusion now lists **`eval` docs**; exclusion (a) scoped to
   **feat/fix** task docs ("an `eval` doc does **not**" ride a branch). Killed the
   overlap the owner hit.
- `docs/TASK-TEMPLATE.md` — the `Branch:` line notes it is feat/fix only; an eval
  has no branch.

**Drift:** none — exactly the Files list.

**Verification:** grep of §10 for `branch` — every remaining use is either
feat/fix-scoped or an explicit "eval has no branch" (the one "one legible branch"
in the Size axis is about a too-big code task → split, correct as-is). `bun run
check` → green, 646 pass / 1 skip / 0 fail (Markdown-only edit).

## Review

*— claude-opus-4-8, 2026-10-17 (same-model, in-context — contained/S docs)*

**Verdict: APPROVE.**

1. **§10 re-read end to end:** every "branch" / "one at a time" clause is now
   scoped to `feat`/`fix`, and the eval→direct-to-`main` path is stated at each
   relevant place (intro, one-at-a-time, folder, branch↔doc, lifecycle,
   carve-out). No clause still implies a branch for evals.
2. **Carve-out collision resolved:** the inclusion explicitly lists `eval` docs;
   exclusion (a) is feat/fix-only and says an eval doc does not ride a branch —
   the two no longer overlap.
3. **No over-correction:** the eval path keeps its **Review verdict**; only the
   branch + merge gate are dropped, not the adversarial judgment or the Context.
4. **Gate:** green, 646 pass / 1 skip / 0 fail; Markdown-only.

**Self-red-team:** the promotion step now says "open the code branch then" —
consistent with "feat/fix has a branch". One residual: an eval that was *already*
direct-on-main, when promoted, needs its doc `git mv`-d onto the new feat/fix
branch; that is the normal "doc rides the code branch" rule, so no special case
needed. No fix outstanding.

**Note:** `eval/changelog-discipline` (already on `main`) retroactively conforms
— it is a direct-to-`main` eval record now; the branch it was created on was
unnecessary but left no trace beyond an extra merge commit.
