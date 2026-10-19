# feat/task-workflow — one task, one branch, one doc

> **Status:** done — merged to `main` (0ccc277) · status synced by audit 2026-10-19
> **Branch:** `feat/task-workflow`

## Context

*— claude-opus-4-8, 2026-10-16*

Work on this repo has been ad-hoc: plans scattered under `docs/` in varied
shapes, execution logs sometimes present (`*-esecution.md`) and sometimes not,
and — most painfully — multiple branches and a second worktree (`tentacle-perf`)
in flight at once, which produced the merge-conflict / parallel-edit mess we just
spent a session untangling. We want a repeatable standard so every change is
planned, executed, and reviewed the same way, on its own branch, and so we can
see *which model* did *what* on a task and how it behaved.

Decision (owner, 2026-10-16): three folders by type — `feat` / `fix` / `eval` —
each task a four-section doc (Context · Implementation · Execution · Review),
one task at a time on a dedicated branch named after the task, and each section
signed by the model that wrote it.

## Implementation

*— claude-opus-4-8, 2026-10-16*

Agreed design (all points confirmed by the owner):

- `docs/feat/`, `docs/fix/`, `docs/eval/`. `fix` (not `bug`) — it names the
  action and pairs with the `feat:`/`fix:` commit types. refactor/perf → `feat`
  if approved, `eval` if still being decided. An approved `eval` is promoted by
  `git mv` into `feat/`/`fix/` + branch rename (the move = the decision record).
- Branch ↔ doc 1:1: `<type>/<slug>` ↔ `docs/<type>/<slug>.md`.
- Four sections, **each signed** `*— <model-id>, <date>*`: Context,
  Implementation (the §8 plan), Execution (as-built + drift), Review
  (adversarial, not consensus-seeking — re-run the gate, red-team failure modes,
  non-vacuity; ideally fresh-context; report how the model behaved).
- Lifecycle Context → Implementation → Execution → Review → merge; `eval` often
  stops at Context + Review.
- `TODO.md` = index/backlog; `docs/library-bugs.md` = cross-cutting registry.

Files: `docs/TASK-TEMPLATE.md` (copyable template), a `README.md` in each of the
three folders, `AGENTS.md` §10 (the mandatory convention). Dogfooded: this very
change is the first task under the standard, on branch `feat/task-workflow`.

## Execution

*— claude-opus-4-8, 2026-10-16*

Done on branch `feat/task-workflow`:

- `git checkout -b feat/task-workflow`; `mkdir -p docs/{feat,fix,eval}`.
- Wrote `docs/TASK-TEMPLATE.md` (four signed sections + copy instructions).
- Wrote `docs/feat/README.md`, `docs/fix/README.md`, `docs/eval/README.md`
  (purpose + pointer to the template and AGENTS §10).
- Added `AGENTS.md` §10 "Task workflow" (the full mandatory convention).
- Wrote this doc as the dogfood/first task.

**Drift from Implementation (deliberate):** did **not** migrate the pre-standard
docs (`react-19-migration.md` → `eval/`, `tui-brand-color.md`/
`pod-attach-resilience.md` → `feat/`, etc.) into the new folders. Reason: that is
a separate, reviewable move (and retrofitting their shape into four sections is
busywork); AGENTS §10 marks pre-standard docs as legacy. Left as a follow-up to
keep this task's diff to "establish the standard".

## Review

*— claude-opus-4-8, 2026-10-16*

Adversarial pass on the standard itself:

- **Gate:** docs-only change — no TS/JS touched, and Biome does not lint
  Markdown, so `bun run check` is unaffected. Ran it to confirm: green
  (634 pass / 1 skip / 0 fail), see the Execution gate note.
- **Holes red-teamed:**
  - *Where do `chore`/release/dependency-bump tasks go?* Not every change is
    feat/fix/eval. Accepted: fold trivial chores into the related task or skip a
    doc for a one-line chore; revisit only if chores pile up. Not a blocker.
  - *Self-review blind spot — live here.* This Review is written in the **same
    context** that built the task, which is exactly the weakness §10 warns about.
    It is adequate for a docs/process change but, per the standard, a code task's
    Review should run fresh-context (subagent/`/code-review`). Noted, not
    violated for this low-risk meta-task.
  - *Multi-model signatures:* the per-section signature cleanly supports a task
    where (e.g.) the local Qwen executes and Opus reviews — the Execution and
    Review signatures will differ, which is the point.
- **Non-vacuity:** the standard is only real if enforced. AGENTS §10 makes it
  mandatory and TODO.md is the index, so new work is funnelled through it; the
  test is whether the *next* task actually follows it.
- **Verdict:** holds. Ship. Follow-ups: migrate the legacy docs; retrofit
  `TODO.md` entries to link task docs.
