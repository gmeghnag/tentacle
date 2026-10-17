# eval/daemon-compact-turn-guard — `session/compact` is not mutually exclusive with a running turn on the daemon

> **Status:** eval (Context + Review; Implementation empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** S · **Blast:** load-bearing · **Suited:** strong model executes when promoted to `fix/`; mandatory fresh-context Review red-teaming "Don't serialize the RPC peer" (§7)

## Context

*— claude-opus-5-5, 2026-10-17*

**Question being decided:** is the claim "`session/compact` is not guarded against
a running turn on the daemon" real, which clients can actually trigger it, and
should it be promoted to a `fix/` task?

**Evidence (source).**
- `packages/daemon/src/hosted-session.ts:92-95` — `prompt()` rejects with
  `TurnInProgress` when `this.controller` is set. `compact()` (`:118-122`) has no
  such check, sets no busy state, and passes no `AbortSignal`.
- `packages/daemon/src/connection.ts:126-132` — `session/compact` goes straight to
  `hosted.compact()`; `onNotification` (`:191-196`) routes `session/cancel` only to
  `hosted.cancel()`, which aborts `this.controller` (`hosted-session.ts:130-132`)
  — `null` during a compact, so cancel is a no-op for it.
- `packages/transport/src/peer.ts:184` — `void this.handleRequest(...)`: inbound
  requests are dispatched concurrently by design (AGENTS §7).
- `packages/agent/src/session.ts:66-70` — a turn passes the session's own
  `this.messages` array into `Agent.runMessages`, which `push`es assistant/tool
  messages into it (`packages/agent/src/agent.ts:165-260`).
- `packages/agent/src/session.ts:91-99` — `compact` snapshots `before`, awaits
  `summarize` (a full model round-trip), then `this.messages.length = 0;
  push(...compactedHistory(...))` on that same array.
- Sessions are per-connection (`connection.ts:53`), so a *second* client cannot
  reach another client's session; the trigger is one client issuing overlapping
  requests.

**Repro** (`/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/repro.ts`,
the real `Connection` + `SessionHost` + `Agent` over `createChannelPair`, same
pattern as `packages/daemon/test/integration.test.ts`; a scripted model whose
summarize call and tool `exec` are gated by promises). Actual output:

```
A compact mid-turn -> {"ok":{"before":2,"after":1}}
A prompt -> {"stopReason":"end_turn"}
A final history:
  [0] user "Summary of the earlier conversation (com"
  [1] tool toolCallId=c0 "exit=0\nok"
  [2] assistant "done1"
A orphan tool messages: [ "c0" ]
B prompt during compact -> {"ok":{"stopReason":"end_turn"}}
B history after 2nd turn, before compact resolves: 8 msgs
B compact settled after cancel notification?  false
B compact -> {"before":4,"after":1}
B final history:
  [0] user "Summary of the earlier conversation (com"
```

- **A (compact during a turn):** compact is accepted, wipes the in-flight turn's
  user prompt and the assistant message carrying `tool_calls: [c0]`; the turn
  then appends `tool(c0)` after the summary. Final history has an **orphan tool
  message** — invalid for OpenAI-compatible APIs.
- **B (prompt during a compact):** the prompt is **not** rejected (controller is
  `null`), runs a whole turn (4 → 8 messages), then the compact resolves and
  replaces everything with a summary of the *stale 4-message* view: the second
  turn is **silently lost**. `session/cancel` during the compact had no effect.

**Veracity: CONFIRMED** (both directions, plus non-cancellable compact).
Unverified in one line: that the next model call on history A returns a provider
400 — inferred from the OpenAI tool-message contract, not executed against a
real endpoint. Persisting the corrupted history is also inferred: the main thread
persists `snapshot` after each turn (AGENTS §7), so a `--resume` would inherit it.

**Trigger / who can hit it.**
- **TUI, direction B — reachable today.** `/compact` is guarded only against
  `running` (`packages/tui/src/App.tsx:415`) and then fires `void
  session.compact()` (`:420`) without marking the session busy, so typing a
  prompt while "Compacting the conversation…" is shown sends `session/prompt`
  mid-compact. Summarising is a full LLM call (seconds), so the window is wide.
  (Static reading of `App.tsx`; not re-verified with an ink frame capture.)
- **TUI, direction A** — guarded client-side (TODO.md Block 6 FIXED item covers
  `/retry` and `/clear`; `/compact` has its own `running` check).
- **Any other protocol client** (`tentacle connect` targets a daemon over ws; a
  custom/script client, a future second frontend) — both directions are
  reachable; the daemon is the only place that can enforce it.

**Severity: 🟡 medium-high.** Silent conversation loss (B) and a poisoned
history that can 400 every subsequent turn and get persisted (A). Reachable from
the shipped TUI by an ordinary user action (B).

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-17*

**Verdict: CONFIRMED — promote to `fix/daemon-compact-turn-guard`.**

Attempts to falsify: (1) maybe `Session.compact` copies the array — no, it
mutates `this.messages` in place (`session.ts:96-97`), the same reference the
running `runMessages` holds; (2) maybe the peer serialises requests — no,
`peer.ts:184` is fire-and-forget; (3) maybe the TUI fully covers it — only for
direction A; direction B is open; (4) maybe cancel stops a compact — no, it only
aborts the turn controller. The repro output above is decisive for all four.

**Fix direction (do not serialise the peer, §7).** Make mutual exclusion a
per-session state in `HostedSession`, rejecting rather than queueing:
- `compact()` throws `TurnInProgress` (or a new additive domain code) when a turn
  or another compact is active; `prompt()` likewise rejects while a compact is
  active. Use one busy flag / shared `AbortController` set synchronously before
  the first `await`, cleared in `finally`.
- Give the compact its own `AbortController`, pass its signal to
  `session.compact(signal)` (already supported, `session.ts:91`), and let
  `cancel()` abort it, so `session/cancel` stops a long summarise.
- `running` (`hosted-session.ts:65`) should probably report true during a compact
  too; check its callers before changing its meaning.
- Optional defence in depth: `Session.compact` could re-check that
  `this.messages.length === before` after the `await` and refuse to overwrite.
- TUI: show the compact as busy (or reject prompts with a notice) — but the
  daemon guard is the real fix; the client must handle the rejection cleanly.

Failure modes to pin with red-first tests in `packages/daemon/test/integration.test.ts`
(ScriptedProvider + gated exec/summary, as in the repro): compact-during-turn is
rejected and the history stays valid; prompt-during-compact is rejected; cancel
aborts a pending compact and leaves the history untouched; a compact that throws
clears the busy state; `session/enqueue` / `request_permission` still flow
concurrently during a turn (non-serialisation regression).
