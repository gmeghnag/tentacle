# eval/parallel-tools — Run a round's tool calls in parallel

> **Status:** context — to evaluate after `connect-sessions` (task 7) and `context-reset` (owner, 2026-10-25)
> **Branch:** none (an `eval`)
> **Type:** eval · **Size:** to assess · **Blast:** load-bearing (the agent loop's tool round, suspended-turn persistence, the permission broker) · **Suited:** strong model plans; mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-25*

**Owner request (2026-10-25):** when the model asks for several tool calls in
one response, run them in parallel where it is safe. Needs an evaluation of
WHICH tools can run in parallel. The execution mode is a setting:
`sequential` or `parallel`; we must recommend the default (owner's first
idea: sequential for tools). A separate eval covers sub-agents
(`docs/eval/parallel-agents.md`).

**Today (main `0b1d89f`):** `Agent.runToolCalls`
(`packages/agent/src/agent.ts:732-738`) runs a round's calls strictly in
order: each is authorized, run, and its result pushed and committed before
the next starts. The comment states the invariant this buys: a history
suspended inside a call is always "earlier calls answered, this one and the
later ones not" (`suspendedCalls`, `docs/feat/suspended-turn-resume.md`).
A parallel mode must keep a reload honest when several calls are in flight.

**Questions to settle:**
- Which tools are parallel-safe: read-only ones (`fs_read`, search, list),
  vs writers (`fs_write`, `fs_edit`, `fs_multi_edit` on the same path),
  `shell` (side effects unknown), background jobs, MCP tools (unknown
  semantics), `skill`, `agent_task` (see the agents eval), `context_reset`
  (must be alone, `docs/eval/context-reset.md` decision 5). A static
  per-tool flag, a per-call analysis (paths), or both?
- Permissions: several calls needing approval at once — one prompt at a time
  through the single broker, a combined prompt, or approve-then-run?
- Ordering: results stay in the model's call order in the history; the TUI
  shows several running tools at once.
- Cancel (Esc/Ctrl+C) with calls in flight; one call failing.
- Suspended-turn persistence and reload with several calls in flight.
- Pod mode, MCP servers, output spill, limits (max concurrency).
- The setting: name, scope (global / per project / per session), default.
