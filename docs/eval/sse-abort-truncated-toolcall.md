# eval/sse-abort-truncated-toolcall — does an interrupted SSE stream persist a truncated tool call?

> **Status:** eval (Context + Review; Implementation empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** S · **Blast:** cross-module · **Suited:** if promoted → a `fix` (providers + agent, ~2 files + tests); touches the agent loop's history-write path, so a strong model executes and Review is fresh-context

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** is the claimed bug real? The claim is that pressing
Esc during SSE streaming leaves an incomplete tool call (invalid-JSON `arguments`)
in the conversation history, which then poisons the session on strict servers. If
it is real, should it be promoted to a `fix`, and what is the right fix?

### The claimed code path (verified against the source)

1. `packages/providers/src/sse.ts:32-34`: at the top of each read loop,
   `if (signal?.aborted) { return; }`. That is a silent, normal completion, not a
   throw. Also, `emitFrom` (`sse.ts:17-27`) yields every line of an
   already-read chunk without checking the signal.
2. `packages/providers/src/openai-provider.ts:175-181`: when the SSE loop ends
   without a `finish_reason`, the provider flushes whatever
   `ToolCallAssembler` holds as complete `tool_call` events, then yields `done`.
   Nothing checks that `arguments` is valid JSON.
3. `packages/agent/src/agent.ts:213-243`: the abort-to-`cancelled` handling sits
   in the `catch`, so it runs only if the stream **throws**. If the stream ends
   normally, `agent.ts:244-248` pushes `{role:"assistant", toolCalls}` into
   history. The loop then **runs the tools** (`agent.ts:274+`). `runTool`
   (`agent.ts:415-432`) catches the JSON parse error, sends `{}` to the
   permission gate, and `ToolRegistry.execute` returns
   `invalid JSON arguments for <name>` (`packages/tools/src/registry.ts:66`).
   That tool error is also pushed. Only at the next iteration's
   `signal.aborted` check (`agent.ts:193-196`) does the turn end `cancelled`.
4. `packages/agent/src/session.ts` `send()` persists in `finally`, so the
   truncated assistant message is written to the session file.

### Repro 1: the prior fake-fetch repro (re-run)

```
$ bun /private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/sse-abort2.ts
{"type":"text","delta":"x"}
{"type":"tool_call","toolCall":{"id":"c1","name":"fs_write","arguments":"{\"path\":\"a.txt\",\"con"}}
{"type":"done"}
stream ended WITHOUT throwing
```

This reproduces at the provider level. But the abort happens **synchronously
inside the consumer**, while the generator is paused at a `yield`.

### Repro 2: end-to-end with a real `Bun.serve` SSE server, real Bun `fetch`, `OpenAIProvider` → `Agent` → `Session` (`onPersist` captured)

Script: `/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/sse-e2e.ts <mode> [delayMs]`
(Bun 1.4.3). The server sends a text delta and the first fragment of
`fs_write` args `{"path":"a.txt","con`. After that:

| mode | what happens | result |
|---|---|---|
| `stall` | server stops sending; `setTimeout(abort, 50)` | `events: text, turn_end:cancelled` · history: only the user message. **Clean.** Bun **rejects the pending `reader.read()`** on abort, so the `catch` path runs. |
| `fast` sweep | fragments 5 ms apart; abort by timer at 0,1,…,30 ms (18 points) | **0/18 truncations.** Every abort either cancels cleanly (no assistant message) or lands after the stream finished, so the *complete* call is kept. |
| `consumer` | abort called synchronously on the first `text` event | history: `assistant{toolCalls:[{arguments:"{\"path\":\"a.txt\",\"con"}]}` + `tool:"invalid JSON arguments for fs_write"`, then `turn_end:cancelled`. **Truncation persisted.** |
| `eof` (no abort) | server **closes the stream** after the partial fragment (no `finish_reason`, no `[DONE]`) | truncated call persisted **on every round**: 3× `assistant{arguments:"{\"path\":\"a.txt\",\"con"}` + 3× `invalid JSON arguments`, `turn_end:max_iterations`. |

### Is the abort trigger realistic?

In production, every abort source is a **macrotask**:
- `HostedSession.cancel()` from an RPC message (`packages/daemon/src/hosted-session.ts:131`)
- SIGINT (`packages/cli/src/main.ts:550`, `packages/cli/src/terminal.ts:23`)
- the TUI's own controller (`packages/tui/src/App.tsx:607/625/652`), which reaches the daemon over RPC

The consumer, `HostedSession.prompt` (`hosted-session.ts:100-110`), handles each
event synchronously. The chain from "a `read()` resolved" to "back at the top of
the loop" is all microtasks, so a macrotask abort cannot land inside it. It lands
while `read()` is pending, and Bun then rejects with `AbortError` (the `stall`
and `fast` rows). The silent-`return` branch is effectively **unreachable through
Esc today**. It is a latent trap: any future abort raised in the same tick
(a sub-agent watchdog, an output-size guard calling `abort()` from the consumer,
a consumer that `await`s per event) makes it live.

The pod reverse-tunnel path is not affected: `RemoteClient.onModelStream`
(`packages/client/src/remote-client.ts:165-173`) passes no signal. As a side
note, that means a cancel there does not cancel the laptop-side model call.

**The realistic trigger is a different one that reaches the same outcome:**
a **premature EOF**. The upstream closes the body cleanly before `finish_reason`,
for example because llama.cpp crashed or restarted, a proxy or idle timeout cut
the connection, or the context limit was hit mid-call. That goes straight through
the "flush if the stream ended without a finish_reason" branch
(`openai-provider.ts:175-181`), with no abort involved (row `eof`). An abrupt TCP
reset may surface as a fetch error instead. That case was not tested.

**Not reproduced here (inferred):** that llama.cpp then answers every later
request with `500 "parse error"`. It is consistent with the 2026-10-16 incident
in TODO.md ("Oversize / degenerate tool-call guard"), where unparseable
tool-call args in history produced exactly that error. The mock server here does
not validate history. To verify, replay a persisted session containing
`"arguments":"{\"path\":\"a.txt\",\"con"` against llama-server.

### Verdict

**PARTIALLY CONFIRMED.**
- **Confirmed:** the defect. An SSE stream that ends without `finish_reason`
  makes the provider emit partial tool calls as complete. The agent persists
  them, runs them (permission gate sees `{}`), and saves the result.
- **Not confirmed, as claimed:** that Esc during streaming triggers it. Under
  real Bun fetch, an abort during a pending read throws, and the cancel path is
  clean (0/18 timings). The silent `return` in `sse.ts:32-34` is reachable only
  by a same-tick abort, which no current caller does.
- **Severity: medium.** The realistic trigger (upstream drops mid-tool-call) is
  uncommon but real for a local llama.cpp setup. The consequence is session
  poisoning that needs a manual `jq` fix. The abort variant is a latent low.

## Implementation

*(empty — eval; filled if promoted to `docs/fix/`)*

## Execution

*(empty — eval)*

## Review

*— claude-opus-5-5, 2026-10-17*

**Recommendation: promote to `fix/` (S, cross-module)**, re-scoped from "abort
during streaming" to **"an incomplete stream must not produce or persist tool
calls"**. The abort hardening comes along at little extra cost.

Fix direction (to be source-verified in Implementation):
1. **Provider: treat a stream without `finish_reason`/`[DONE]` as incomplete,
   not done.** In `openai-provider.ts:175-181`, do not flush partial tool calls.
   Either throw a typed `IncompleteStreamError` (preferred: the agent surfaces it
   as a failed turn, nothing is pushed) or drop the partial calls and
   keep the text. Check first that tolerant servers which legitimately omit
   `finish_reason` still work. That is the reason the flush exists, so the fix
   may be "flush only calls whose `arguments` parse as JSON".
2. **`parseSSE`: on abort, throw `signal.reason` / an `AbortError`** instead of
   `return` (`sse.ts:32-34`). Also check the signal inside the `emitFrom` loop.
   Then every abort goes through the agent's `catch` → `cancelled` path.
3. **Agent: defence in depth before the history write** (`agent.ts:244`). If
   `signal.aborted` after the stream, end `cancelled` without pushing. Also
   validate each `toolCall.arguments` with `JSON.parse` before pushing. On
   failure, do not persist the raw args: store the call with sanitised args
   (`"{}"`) plus a tool-error result, so the model can retry. This is the same
   hook the **"Oversize / degenerate tool-call guard"** TODO item needs. Build
   one validation seam for both.
4. Separately, the agent runs a tool round even after an abort that arrived
   during the stream. The `consumer` row executed the complete `fs_write` once
   when the abort landed after the call was assembled. Consider an
   `if (signal?.aborted)` check before the tool loop.

Tests (red first, §9): fake-fetch provider test where the body EOFs mid-tool-call
→ no `tool_call` event / an error is thrown. Provider test where abort happens at
a `yield` → the stream rejects. `Agent` test with a scripted provider emitting
`tool_call{arguments:'{"a":'}` → history has no invalid-JSON arguments. Check
non-vacuity by restoring the `return` / flush.

Related TODO items: "Oversize / degenerate tool-call guard (anti-runaway)" (same
validation seam, same poisoning class). The 🔵 "cancelled turn just stops
silently" item (UX of the cancel path this touches).
