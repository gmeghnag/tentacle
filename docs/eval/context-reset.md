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
3. **Anti-loop and config:**
   - A reset is refused (a tool error with the reason, seen by the model) when
     the model made no other tool call since the previous reset.
   - A cap on resets per user message, configurable, **default `-1` =
     unlimited**; when set and reached, the reset is refused the same way. The
     counter restarts at each user message.
   - The capability itself is configurable, **default on** (off = the tool is
     not offered to the model).
   (2026-10-25: "facciamo numero configurabile default -1 ovvero infinito, è
   anche la funzionalità per un modello di resettare se stesso deve poter
   essere configurabile, default attiva")
4. **On disk the history is replaced, as compaction does today**
   (`Session.compact`, `packages/agent/src/session.ts:157-169`): the
   pre-reset history is NOT kept in the record (no record-format change). The
   old transcript stays only on the screen of the clients that saw it.
   (2026-10-25: owner answered "no" to keeping it; considered keeping the
   last N messages on disk, configurable, then dropped it: "non salviamo
   nessun messaggio precedente, partiamo dal nuovo prompt")
   The model's new context holds no old message either: system prompt + the
   restart prompt (anything else carried over is decision 5).
5. **What the fresh context carries** (owner OK to the proposal, adding
   "naturalmente oltre ad AGENTS.md"):
   - the system prompt, which already folds in the identity, the project
     `AGENTS.md` and the skills catalog (`packages/config/src/resolve.ts:225-240`);
   - the restart prompt written by the model;
   - an automatic list of the background jobs still running (id + command),
     appended by tentacle — the jobs keep running and their exit notices reach
     the new context as today;
   - the active skills, reloaded as compaction does;
   - the user's queued messages, delivered in the new context;
   - the reset must be the ONLY tool call of its assistant message, else it is
     refused with the reason (the other results would land in the discarded
     history).

## Open questions (asked one at a time)

- Tool name and how the TUI and the phone show it.
