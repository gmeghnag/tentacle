# fix/think-tag-leak — a stray `</think>` and a doubled answer in a Qwen reply, caused by echoing last turn's reasoning

> **Status:** implementation — APPROVED (owner decision 2026-11-25)
> **Branch:** `fix/think-tag-leak`
> **Type:** fix · **Size:** S · **Blast:** contained (one provider's request builder; no protocol, no persistence) · **Suited:** Sonnet/DeepSeek exec, standard in-context Review
> **Changelog:** `changelog.d/think-tag-leak.fixed.md`

## Context

*— claude-sonnet-5-5, 2026-11-25*

**Problem.** A Qwen reply (llama.cpp, `unsloth/Qwen3.8-27B-UD-Q6_K_XL`) stored by tentacle carries a stray `</think>` and the answer twice: `No: 391 = 17 × 23, quindi è composto.\n</think>\n\nNo: 391 = …`. Seen on turn 2 of a session, the first turn with an echoed `reasoning` in history (fix/reasoning-echo). Direct non-streaming requests without tentacle's request shape did not reproduce it.

**Reproduced: YES — 6/12 two-turn tentacle runs, turn 2 only (turn 1: 0/12).** The stray tag is in the **RAW SSE stream of the server** (`delta.content`), before any tentacle parsing: **model/server behaviour, triggered by what tentacle sends — not a tentacle parsing bug.**

**Repro** (2026-11-25, `fix/think-tag-leak` = `8d29dd10`, `~/bin/tentacle` binary of the day, in `.tentacle/tmp/think-tag-leak/`, gitignored — scripts summarised here):
- `proxy.ts`: a Bun proxy on `127.0.0.1:18080` → `http://192.168.1.17:8080`. It reads the real key at runtime from the serve config and injects it (the key is in no file); it saves each full request body (`NNNN.req.json`) and the RAW response bytes (`NNNN.raw`).
- `drive.sh`: `TENTACLE_CONFIG_DIR=<tmp>/cfg` (a config with `baseURL` = the proxy, dummy key); per run a fresh cwd and `tentacle --plain` fed on stdin (there is no `-p`): turn 1 «Rispondi in una riga, senza usare strumenti: quanto fa 17 × 23, e in che giorno della settimana cade il 25 novembre 2026?», turn 2 (same session, sent after turn 1's stream ended) «E 391 è primo? Rispondi in una riga.». 12 runs = 24 calls. Every request: stream, `stream_options.include_usage`, 12 tools, the full system prompt, a `[context: …]` suffix on each user message, `reasoning_content` on the turn-1 assistant message (turn 2 only).
- `an.ts` on the raw files: `</think>` in `delta.content` of calls 4, 6, 10, 14, 22, 26 (all turn 2) = 6/12; in `reasoning_content`: 0; turn 1 (no echo in history): 0/12. The tentacle `out.txt` shows the tag in the same 6 runs.

Raw excerpt of call 0004 (turn 2), SSE chunks in order (`r` = `reasoning_content`, `c` = `content`):
```
r " number"  r "."                              ← reasoning ends: "…therefore it's a composite number." (no </think> seen in reasoning)
c "No" c ":" c " " … c " composto" c "."        ← draft answer, as content
c "\n</think>"                                   ← the stray tag, one content delta
c "\n\nNo" c ":" … c " composto."                ← the real answer, again
```
Content as concatenated from the wire: `'No: 391 = 17 × 23, quindi è composto.\n</think>\n\nNo: 391 = 17 × 23, quindi è composto.'` — the model re-opens a think/answer pattern after the server already switched to content; tentacle only stores what it receives.

**Bisect** (the captured call-0004 request replayed straight to the server, key at runtime; `bisect.ts`; stray `</think>` in the final content; streamed unless noted):

| variant | hits / n |
|---|---|
| baseline (the exact tentacle request) | 9/32 (28%) (+ tentacle's own 6/12) |
| **no `reasoning_content` on history messages** | **0/12** |
| **no `tools`** | **0/32** |
| no system prompt | 3/32 |
| no tools + no system | 0/12 |
| non-streaming (`stream:false`) | 9/32 → same rate as streaming, not a stream-parser artefact |
| no `[context: …]` suffix | 2/12 |

`/apply-template` of the same request (`tmpl-echo.txt` vs `tmpl-noecho.txt`): with the echo, the **prior-turn** assistant message is rendered as a full `<think>\n<whole reasoning>\n</think>\n\n<answer>` (the reasoning ends with a draft of the answer line); without it, as an empty `<think>\n\n</think>`. So the trigger is: reasoning of an EARLIER turn (before the last user message) echoed into history, with tools in the request (the template's tool-mode path).

**Not proved:** the exact mechanism inside llama.cpp/Qwen (the model imitating the "draft, `</think>`, answer" shape it sees in the history, vs. the server's reasoning parser closing early). It does not matter for the fix: removing the earlier-turn echo removes the trigger (0/12 and 0/32 are the controls; baseline rate 28% → p(0/12 | same rate) ≈ 2%).

## Implementation

*— claude-sonnet-5-5, 2026-11-25*

### Load-bearing assumption

fix/reasoning-echo's benefit comes from WITHIN-turn rounds (a tool loop: the model sees its own reasoning on the next request of the same turn). Reasoning of turns that are already finished is not needed — vendors drop it themselves (Qwen's own template renders earlier turns' thinking empty, as seen in `tmpl-noecho.txt`; DeepSeek/Anthropic docs say only the current tool-use turn's reasoning must be passed back). **Unverified for tentacle:** the F8 bench proxy echoed ALL earlier assistant messages (docs/fix/reasoning-echo.md, Context), so no number separates the two. Cheapest check before merge: the stale-taskrun arm on DeepSeek with the earlier-turn echo off, compared with the 4.7 min / 20k-token result — a single-turn task, so it should be identical by construction (nothing earlier than the turn exists).

### Preconditions

- The echo is decided per message in `toWireMessage(message, options, echoSource)` → `ownOpenAIReasoning` (`packages/providers/src/openai-provider.ts:612,650,501`), fed from `wireMessages` (`:555-586`) and `buildPayload` (`:517-523`). The `echoing` flag that guards the 400-retry (`:317-319`) is computed by scanning ALL messages → must use the same cut, or a harmless retry path stays armed with nothing to drop.
- Anthropic has the same per-message call (`anthropic-provider.ts:603`); the API already ignores earlier turns' thinking, so it is NOT changed here (out of the symptom).
- AGENTS §7: nothing persisted changes (`ChatMessage.reasoning` stays in the log, only the wire view is cut); no protocol field; the pod path (`ProxyModelProvider`) sends the same `ChatMessage`s to the laptop provider, which applies the cut — one place.

### Design

A pure helper (providers package, React-free, unit-tested): `echoFloor(messages): number` = the index of the last `user` message that STARTS a turn; reasoning is echoed only for assistant messages at an index ≥ that floor. `wireMessages` passes `echoSource` only for those messages; the `echoing` pre-scan uses the same helper. Open point for the executor, verify first: whether a mid-turn **steer** is a `role:"user"` message in `ChatMessage[]` (`rg steer packages/agent/src/agent.ts`) — if yes, the floor must skip steers (otherwise a steer would drop the turn's earlier rounds from the echo, a regression of fix/reasoning-echo); the turn-start marker is whatever the log already has for it.

Rejected: (a) stripping `</think>` from `content` — the output already doubles the answer, a strip leaves a half-fixed reply and treats a symptom, and would need retraction in the live stream; (b) never echo on OpenAI-compatible endpoints — throws away the measured win; (c) a llama.cpp request flag — none known, and endpoint-specific.

**Defensive layer (optional, decide with the owner):** with the trigger removed no stray tag is expected; if one still appears (another model/server), a post-stream normaliser "content containing `</think>` ⇒ keep the text after the last one, move the text before it to reasoning" could be added. Not proposed now: it needs a retraction path in the stream and there is no repro left to pin it.

### Files

1. `packages/providers/src/openai-provider.ts` — the helper + `wireMessages` + the `echoing` scan (`:317-319`).
2. `packages/providers/test/reasoning-echo-openai.test.ts` — new cases (below).
3. `changelog.d/think-tag-leak.fixed.md` — one bullet.

### Failure modes

- Single-turn tool loop (the F8 case): all assistant messages are after the floor → unchanged behaviour.
- Steer mid-turn (see Design): must not move the floor; test pins it.
- First request / no user message / history starting with an assistant (resume, compaction summary as first message): floor 0 or none → echo as today, no throw.
- After compaction the history may start with a summary `user` message: floor = that index, nothing older exists → fine.
- Endpoint that 400s on the echo (D9 retry): the `echoing` flag uses the same cut, so a history with only earlier-turn reasoning no longer sends the field and no longer arms the retry.
- Persisted sessions: nothing written differently; an old log loads and is cut at send time.

### Tests

Red before green (§9), on current `8d29dd10`, then mutation (move the floor to 0 → the first test must fail again):
1. `[user, assistant{reasoning}, user, ←request]`: the wire has NO `reasoning_content` on message 2 (red today: it is sent — this is the exact shape of the 6/12 repro).
2. `[user, assistant{reasoning, toolCalls}, tool, ←request]` (same turn): `reasoning_content` IS on the assistant message (pins that the F8 win is kept).
3. Two turns, the second with a tool round: only the second turn's assistant message carries it.
4. A steer `user` message inside a turn does not cut the earlier rounds (depends on the Design check).
5. `echoing` is false for a history whose only reasoning is earlier-turn → no retry path armed (fake `fetch`, existing `FakeWS`-style fake in that test file).

Live check after the fix (optional, GPU): re-run `drive.sh` ×12 through `proxy.ts` → expect 0/12 (baseline 6/12) and no stray tag in `content`.

### Owner decision (2026-11-25 ~21:45)

Owner, verbatim: «ok, per think-tag-leak vai con il turno corrente». This REPLACES reasoning-echo's Q2 A («send back always») for past turns: reasoning is echoed only for the CURRENT turn (the assistant messages after the last user message that opened it); a finished turn's reasoning stays on disk (Q1 A unchanged) but is not sent back. Update docs/fix/reasoning-echo.md's decision text with a pointer to this doc.

*— claude-opus-5-5 (orchestrator), 2026-11-25*

## Execution

*— (empty until approved)*

## Review

*— (empty until Execution)*
