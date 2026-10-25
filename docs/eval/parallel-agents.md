# eval/parallel-agents — Run sub-agents in parallel

> **Status:** context — to evaluate after `connect-sessions` (task 7) and `context-reset` (owner, 2026-10-25)
> **Branch:** none (an `eval`)
> **Type:** eval · **Size:** to assess · **Blast:** load-bearing (the agent loop's tool round, sub-agent runner, permission broker, TUI progress) · **Suited:** strong model plans; mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-25*

**Owner request (2026-10-25):** when the model delegates several tasks to
sub-agents (`agent_task`) in one response, run them in parallel. The
execution mode is a setting: `sequential` or `parallel`; we must recommend
the default (owner's first idea: parallel for agents). A separate eval covers
ordinary tools (`docs/eval/parallel-tools.md`); the two may share the
round-level machinery, so evaluate them together but ship as two tasks.

**Today (main `0b1d89f`):** `agent_task` (`packages/tools/src/task.ts`) is a
tool like any other, so `Agent.runToolCalls`
(`packages/agent/src/agent.ts:732-738`) runs sub-agents one after another,
interleaving each one's live progress into the stream.

**Questions to settle:**
- Isolation: two sub-agents editing the same files (worktrees? read-only
  types only? a lock?), shared shell cwd, background jobs.
- Permissions: prompts from several sub-agents at once through the single
  broker; how the TUI says which sub-agent asks.
- Model/provider limits: concurrent requests to the same endpoint (local
  model servers often serve one request at a time), rate limits, token
  budget; max concurrency.
- TUI and phone: several progress trees at once; ordering of results.
- Cancel with several sub-agents in flight; one failing; suspended-turn
  persistence and reload.
- The setting: name, scope, default; per sub-agent type override?
