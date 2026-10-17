# eval/compact-empty-summary-wipe — `/compact` with an empty summary irreversibly wipes the conversation

> **Status:** eval (Context + Review; Implementation empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** S · **Blast:** cross-module · **Suited:** if promoted → a `fix` (agent `session.ts`/`compact.ts`, optionally providers). Any model may execute the core guard; standard in-context Review, plus red-team of the persistence path (§7 "Persistence lives on the laptop").

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** is the claim "`/compact` with an empty summary
irreversibly wipes the conversation" real, how severe is it, and should it be
promoted to a `fix`?

### Evidence (source)

- `packages/agent/src/compact.ts:49-55` — `summarizeConversation` accumulates
  **only** `event.type === "text"` deltas and returns `summary.trim()`. Nothing
  checks for an empty result. `reasoning` events (`packages/core/src/model.ts:43`)
  are discarded.
- `packages/agent/src/session.ts:91-99` — `Session.compact()` calls
  `compactedHistory(this.messages, summary)` and replaces `this.messages`
  **unconditionally**, then `this.persist()`. No empty/length check.
- `packages/agent/src/compact.ts:96-106` — `compactedHistory` keeps only the
  system message plus `"Summary of the earlier conversation (compacted to save
  context):\n\n" + summary`. With `summary === ""` the whole conversation is gone.
- No upstream guard on any layer:
  `packages/daemon/src/hosted-session.ts:119-122` (passes through),
  `packages/daemon/src/connection.ts:126-132` (passes through),
  `packages/client/src/remote-session.ts:27-31` (passes through),
  `packages/tui/src/App.tsx:409-424` (only guards "not available" / "turn
  running"; on success prints `Context compacted — N → 2 messages`, so the user
  is told it **succeeded**).
- Worker path also overwrites the on-disk file:
  `packages/cli/src/local-runtime.ts:66-89` `persistingController.compact()` →
  `flush()` → `snapshot` (length 2 > 0, so the `messages.length > 0` guard at
  :71 does not stop it) → `store.save` with the **same uid**
  (`local-runtime.ts:116-124`) → `JsonSessionStore.save` is a plain overwrite
  of `<uid>.json` with no backup (`packages/agent/src/session-store.ts:63-66`).
  `--resume` cannot recover it.

### Two realistic empty-summary triggers (both reproduced through the real `OpenAIProvider`)

1. **Thinking model answers only in `reasoning_content`** (e.g. Qwen3 on
   llama.cpp spending the whole budget thinking, or `finish_reason: "length"`
   before any content). `openai-provider.ts:162-165` maps it to `reasoning`,
   which the summariser drops.
2. **In-band stream error with HTTP 200** (`data: {"error":{...}}`, as several
   OpenAI-compatible servers/proxies emit mid-stream). The chunk has no
   `choices` → silently skipped at `openai-provider.ts:153-156`; the stream then
   ends with `done` → empty summary. Unparseable chunks are also skipped
   (`parseChunk`, :228-234). This is arguably a separate provider defect
   (in-band errors are not surfaced) that *feeds* this bug.

### Secondary claim — whole transcript in one request

Confirmed: `compact.ts:34-46` joins every non-system message into one user
message; nothing truncates, chunks, or budgets it, and no `maxTokens` is set.
So compaction is most likely to fail exactly when it is most needed (context
already full). **But** the HTTP-error path is safe: a non-2xx response throws
`ModelRequestError` (`openai-provider.ts:126-128`) before `session.ts:94`
mutates anything, and the TUI shows `Compact failed: …`. The danger is only when
the failure is *silent* (case 2 above) or the output is empty/truncated.
Related, lesser: a `finish_reason: "length"` with *partial* text is accepted as
a complete summary (silent partial loss).

### Repro

Scratch scripts (repo untouched):
`/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/compact-empty.ts`
(fake model) and
`/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/compact-empty2.ts`
(real `OpenAIProvider` + injected `fetch`).

```
$ bun .../scratchpad/compact-empty2.ts
A-http400 threw: ModelRequestError: model request failed with status 400: {"error":{"message":"exceeds context size"}}
A-http400 history: ["sys","important task","lots of work"]
A-http400 persisted: "<never persisted>"
B-inband-error result: {"summary":"","before":3,"after":2}
B-inband-error history: ["sys","Summary of the earlier conversation (compacted to save context):\n\n"]
B-inband-error persisted: [{"role":"system","content":"sys"},{"role":"user","content":"Summary of the earlier conversation (compacted to save context):\n\n"}]
C-reasoning-only result: {"summary":"","before":3,"after":2}
C-reasoning-only history: ["sys","Summary of the earlier conversation (compacted to save context):\n\n"]
C-reasoning-only persisted: [{"role":"system","content":"sys"},{"role":"user","content":"Summary of the earlier conversation (compacted to save context):\n\n"}]
```

`compact-empty.ts` (fake model yielding only `reasoning`) gives the same
`{summary:"", before:3, after:2}` and the same persisted 2-message history.

### Verdict

**CONFIRMED.** Main claim reproduced end-to-end at the `Session` layer with the
real provider; no guard exists in daemon, client, CLI or TUI; the worker-path
persist overwrites the session file. Secondary claim **confirmed with a
correction**: the one-shot request is real, but an HTTP error leaves history
intact — only silent/empty outcomes destroy it.

**Severity: high** — silent, irreversible user-data loss (whole conversation,
in memory and on disk), reported to the user as success. Trigger is realistic
for this repo's own target setup (local Qwen3 thinking model on llama.cpp).

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-17*

**Verdict: promote to `fix/compact-empty-summary-wipe`.** The bug is real,
cheap to fix, and high-severity. Falsification attempts failed: the only path
that preserves history is a thrown error (HTTP non-2xx, abort); every
"successful but empty" stream wipes it.

**Fix direction (smallest first):**

1. **Core guard (mandatory):** in `Session.compact()` (or `summarizeConversation`),
   if the summary is empty/whitespace, **throw** (e.g. `CompactError("model
   returned an empty summary")`) *before* mutating `this.messages` or persisting.
   The existing TUI error branch (`App.tsx:422`) then shows `Compact failed: …`
   and the history stays intact. Red test: fake model yielding only `reasoning`
   → `compact()` rejects, `snapshot()` unchanged, `onPersist` not called.
2. **Provider (recommended, separate concern):** surface an in-band
   `{"error":…}` SSE chunk as a thrown `ModelRequestError` instead of skipping
   it — this also affects normal turns, not just compaction.
3. **Optional hardening:** treat `finish_reason: "length"` during compaction as
   a failure (or at least warn); optionally fall back to reasoning text only if
   explicitly chosen (not recommended — reasoning is not a briefing).
4. **Out of scope / follow-up eval:** chunked or budgeted compaction for an
   already-full context (summarise in windows, or keep the last N messages
   verbatim). That is a design change, not part of this fix.

**Unverified:** not exercised against a live llama.cpp/Qwen3 server; the
reasoning-only and in-band-error responses were simulated via injected `fetch`
with the real `OpenAIProvider` parser. Verify by running `/compact` against the
local Qwen3 endpoint with a small `max_tokens`/thinking budget.
