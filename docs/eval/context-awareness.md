# eval/context-awareness — The model knows how full its context is

> **Status:** decided (2026-10-25) — to promote to `docs/feat/` and plan; runs BEFORE `context-reset`
> **Branch:** none (an `eval`)
> **Type:** eval → feat · **Size:** S–M (estimate) · **Blast:** cross-module (agent loop message assembly, config) — to confirm in the plan · **Suited:** to set in the plan (Sonnet if S · contained/cross-module; Opus review)

## Context

*— claude-opus-5-5, 2026-10-25*

**Owner question (2026-10-25):** does the model know how many tokens it has
used in the session and the maximum? **Today: no** (main `1bc4a33`). The
window (`contextWindow`, `packages/config/src/resolve.ts:215`) reaches only
the TUI status-bar meter (`packages/tui/src/components/StatusBar.tsx:95`),
never a message to the model. `ContextManager.needsCompaction`
(`packages/core/src/context.ts:43`) exists but nothing outside tests calls it.

It matters on its own (the model can wrap up or compact in time) and for
`context-reset` (`docs/eval/context-reset.md`): to decide when to renew, the
model must know how full the context is.

## Owner decisions

1. **A short usage line for the model**, e.g. `context: 82k / 128k tokens
   (64%)`, emitted **once per new percentage value** — not every turn (too
   costly). A jump of several points (40 → 47 %) yields one line with the new
   value; after a compaction or a context reset the percentage drops and the
   counting restarts from there. Cost: ~15 tokens a line, ≤ 100 lines for a
   full context (~1.5k tokens ≈ 1 % of a 128k window).
2. **Configurable, default on**, with a configurable step (default 1 %).
   Config key at TOP level, NOT under `context_reset`:
   `"contextAwareness": { "enabled": true, "stepPercent": 1 }` (camelCase like
   `contextWindow`, `autoTitle`; `contextUsage` rejected as it reads like the
   TUI meter).
3. **Where the line goes:** appended to the message that crosses the step (a
   tool result or the user's message), never in the system prompt (that would
   break the provider's prompt cache). The token count is the provider's
   reported usage when available, the heuristic counter only as a fallback.
4. **A separate task, before `context-reset`** (owner: "ok prima di
   context_reset"), not folded into it: it is useful alone and keeps the
   `context-reset` branch legible.

## Review

*— claude-opus-5-5, 2026-10-25*

**Verdict: decided.** Next: promote to `docs/feat/context-awareness.md` with a
source-verified plan: where the provider's usage is read (both providers,
streaming), which message the line rides on and how it is stored (persisted
or rendering-only? it is part of what the model saw, so likely persisted —
settle in the plan), the TUI showing or hiding it, sub-agents, the pod proxy.
