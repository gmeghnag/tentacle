# eval/context-reset — The model renews its own context

> **Status:** decided (2026-10-25) — 9 owner decisions; to promote to `docs/feat/`
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
6. **`AGENTS.md` is re-read fresh at every reset, from the first version**
   (not the copy folded in at session start), on every runtime. Pod mode: the
   planner must verify where `AGENTS.md` is read today for `run`/`attach`
   (laptop config vs the pod workspace) and route the re-read through the
   same owner; a pod-supplied file is untrusted input (AGENTS §7 "a pod is not
   trusted"). (2026-10-25: "voglio già da ora la rilettura fresca di
   AGENTS.md")
7. **The whole system prompt is rebuilt fresh at reset**, exactly as when a
   new session opens: identity (`PROMPT.md` / env / default), `AGENTS.md`
   and the skills catalog — one code path, not a special case for
   `AGENTS.md`. Supersedes the "system prompt" bullet of decision 5.
   (2026-10-25: "si")
8. **Tool `context_reset({ prompt })`**: one required argument, the text the
   model restarts from. An empty prompt is refused (tool error). The tool
   description tells the model what a self-sufficient restart prompt holds:
   the goal, where the plan lives (a file path rather than everything
   inline), what is done, the next step, constraints and decisions — the
   model will see nothing else. (2026-10-25: "ok context_reset")
9. **Display:** the TUI keeps the old transcript on screen, then a grey
   separator `↻ context reset by the model`, then the restart prompt shown in
   full as a message labelled "restart prompt"; the status-bar context meter
   drops accordingly. The phone and every other attached client see the same
   through a daemon update (as for compaction). `--resume` shows only from the
   restart prompt on (decision 4). TUI strings in English. (2026-10-25:
   "perfetto")

10. **Context usage for the model is a separate task, done BEFORE this one**:
   `docs/eval/context-awareness.md` (owner, 2026-10-25). This feature relies
   on it for the model to know when to renew; its config key is not under
   `context_reset`.

11. **Plan question 1 (skills at reset): A — re-read BOTH the skills catalog
   and the `skill` tool's own list** (fixed at session start today,
   `packages/cli/src/wiring.ts:238-260`), so a skill added mid-session is
   usable right after a reset; no exception for skills (decision 7 kept
   literally). If rebuilding the tool proves invasive, the planner reports
   it with evidence before any code. (2026-10-25: "si direi proprio A,
   prediligo il lavoro pulito e una perfetta, anzi superba UX")

12. **Plan question 2 (pod settings): the two `contextReset` keys come from the
   pod's config in `run`/`attach`**, like every other agent setting
   (`maxIterations`, `subagents`). A limit enforced in the pod is UX, not
   security (AGENTS §7: whoever controls the pod controls the daemon); the
   laptop-side approval is the guard. (2026-10-25: "ok va bene")

## Review

*— claude-opus-5-5, 2026-10-25*

**Verdict: decided** — all nine owner decisions taken. Next: promote to
`docs/feat/context-reset.md` with a source-verified plan (AGENTS §8). Size
and blast to confirm in the plan: the agent loop (a tool that replaces the
history mid-turn), the session record (no format change by decision 4), the
protocol (a new or reused `session/update` kind — classify it in
`UPDATE_CLASS`), config (two new keys: enable, cap), the system-prompt
rebuild on every runtime (pod: who reads `AGENTS.md`, trust). Strong model
plans and executes; mandatory fresh-context Review.
