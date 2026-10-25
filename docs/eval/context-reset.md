# eval/context-reset — The model renews its own context

> **Status:** context — owner decisions being taken one at a time (2026-10-25)
> **Branch:** none (an `eval`; promoted to `docs/feat/` when approved)
> **Type:** eval · **Size:** M (estimate) · **Blast:** load-bearing (agent loop, session history, protocol update, permission broker) · **Suited:** strong model plans and executes; mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-25*

**Owner request (2026-10-25):** a session should be able to renew itself: the
model calls a tool like "`/clear` + a new start prompt", useful when a new part
of a plan begins and a fresh context is better than a long one.

**Facts the design starts from (main `c408dba`):**
- `/clear` is a TUI action (`packages/tui/src/App.tsx:1325`): it closes the
  session (and its jobs) and opens a new one. The model runs daemon-side
  (in-process worker, pod, `serve` for the phone), where no TUI exists, so a
  model tool cannot drive `/clear`. `/clear` on a shared session also closes it
  for every device (task 6 QR3, `docs/eval/mobile-app.md`).
- Compaction (`packages/agent/src/compact.ts`, `Session.compact` in
  `packages/agent/src/session.ts:157`) already runs daemon-side and rebuilds
  the history as system prompt + a brief + the active skills; persistence,
  the `compaction` update to every client and the skills carry-over exist.
  The request is close to "a compaction whose brief the model writes itself,
  when it decides".

**Proposed shape (orchestrator):** a tool, e.g. `context_reset({ prompt })`.
The model writes the restart prompt (next step, where the plan lives — a file
rather than everything inline — what is done). An approval shows that prompt
(through the single broker, so it works from a pod and the phone). On yes the
daemon rebuilds the history (system prompt + active skills + the prompt,
marked as written by the model) and the turn continues on the fresh context.
The TUI keeps the old transcript above a "context renewed by the model"
separator (as for compaction, task 6 QR1). Anti-loop cap: at most N renewals
per user message.

## Owner decisions

1. **Same session, history replaced (compaction-like)** — not a new linked
   session. (2026-10-25: "si confermo stessa sessione, ha molto senso")
2. **Approval like every other tool that asks:** the prompt shows the model's
   restart prompt with Yes / Yes, always (rest of the session) / No; with
   auto-accept on (Shift+Tab) it passes without asking. Rationale: a reset
   touches no file, but the model loses whatever it did not write into the
   prompt, so the user sees it. (2026-10-25: "ok, trattiamolo come gli altri
   tools")

## Open questions (asked one at a time)

- Anti-loop cap value.
- What else survives the reset (todo list, background jobs, sub-agents).
- On-disk history: is the pre-reset history kept (archive) or replaced, as
  compaction does today.
- Tool name and how the TUI and the phone show it.
