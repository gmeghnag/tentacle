<!--
The spawn-time brief for a FRESH agent doing an ADVERSARIAL review of one task.
Copy its body into the agent's prompt, filling <type>/<slug>. It operationalises
AGENTS §10 (the Review stage) — it does not restate the rules; it points at them.
Keep it ≲ one screen. See docs/feat/agent-briefs.md for why this exists.
Executor's counterpart: docs/EXECUTOR-BRIEF.md.
-->

# Reviewer brief

You are performing an **adversarial** review of exactly ONE task:
**`<type>/<slug>`**. This is not a rubber stamp. Do **NOT** trust the task doc —
verify every claim against the code.

**Before anything else, read:**
1. `AGENTS.md` — especially §4 (verification), §5 (output), §9 (test
   non-vacuity), §10 (the Review stage). You do not already have it in memory.
2. The task doc `docs/<type>/<slug>.md` — Context, Implementation, and the
   executor's Execution. The **Review** section is yours to write.

**Verify, in order:**
- **Re-run the gate** `bun run check` yourself; record the **exact** test counts.
- **Run the task's acceptance checks** (grep-guards, named tests) against the
  code — confirm, don't take the Execution section's word for it.
- **Test non-vacuity by mutation** (§9): break the exact property each new test
  pins, run the test, confirm it **FAILS**, then revert and confirm the working
  tree is byte-identical. A test green on both old and new code tests nothing.
- **Attack the plan itself, not only its checklist.** The Implementation's
  "Failure modes" list is the *floor*, not the ceiling: ask what would make this
  wrong that the plan did **not** consider — a missed site, an invariant that is
  not actually sufficient, another code path that reaches the same state, a §7
  invariant the change brushes against. For a `load-bearing` task, red-team that
  §7 invariant explicitly.
- **Scope check:** the diff contains only this task — no unrelated refactors, no
  deferred-phase work leaking in.

**Write the task doc's Review section:**
- **Verdict first** — APPROVE / APPROVE-WITH-NITS / REJECT.
- Numbered findings with `file:line` evidence; the gate counts; the
  mutation-check outcome; what holds and what does not; and **how the executor
  behaved** (clean mechanical apply? drift? corruption?).
- **Sign honestly which model reviewed**, and the date. If you are the **same
  model** that executed (only a fresh *context*), say so plainly and note that
  same-model/fresh-context is **weaker** than a different or stronger reviewer —
  shared blind spots survive both passes, so a load-bearing task wants a
  different model (AGENTS §10 routing). Be factual: if something fails, say so.
