# fix/reasoning-echo — send the model's own reasoning back to it, in every provider's format

> **Status:** implementation — **APPROVED (owner answers 2026-11-25)**
> **Branch:** `fix/reasoning-echo` (promoted from `eval/anthropic-thinking-echo`, owner 2026-11-25 ~17:30: absolute priority)
> **Size:** M–L · **Blast:** load-bearing (`ChatMessage` + the persisted `message` entry + the pod model wire + every provider) · **Suited:** Opus plan + Opus on the load-bearing slices, Sonnet on the cheap ones; mandatory fresh-context Opus Review
> **Changelog:** `changelog.d/reasoning-echo.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-25*

**Problem.** tentacle throws away the model's reasoning once it has been shown.
Every provider decodes it only as a display stream, and nothing keeps it. So on
the next request of a tool loop, the model no longer sees what it was thinking.
pi sends it back. Reasoning models are trained to receive it (DeepSeek, Qwen3
chat templates, Anthropic "pass thinking blocks back unchanged"). Without it the
model works it all out again on every round: «summarise / step back /
reconsider». That is the reasoning blow-up the harness-compare bench measured
(factor F5: ×3 on Qwen, ×15 on DeepSeek versus pi).

**Evidence.**
- *Bench, factor F8* (`~/github/gmeghnag/harness-compare/EXPERIMENTS.md`, F8 row
  and log 17:09–17:22). The logging proxy `lib/proxy.mjs` was run with
  `ECHO_REASONING=1`. It accumulates each response's `reasoning_content ||
  reasoning`, keys it by the response's tool_call ids (`REASON.set(c.id, …)`).
  On every later request, it sets `reasoning_content` on each assistant message
  that has tool_calls and no reasoning of its own, looked up by its FIRST
  tool_call id (the `echo` function). It does this for ALL earlier assistant
  messages, not only those of the current turn. tentacle's binary was not
  changed. DeepSeek on stale-taskrun, prompt-c + cap50k:

  | arm | result | wall | turns | out tokens | reasoning ch/turn |
  |---|---|---|---|---|---|
  | tentacle, **proxy echo** | PASS | 4.7 min | 46 | 20k | 1.1k (573 blocks echoed) |
  | tentacle, no echo (prompt-c+names+desc) | killed, not done | >25 min | 102 req | 174k | 6.3k |
  | pi | PASS | 4.4 min | 32 | 9.9k | 0.4k |

  n=1; at the time of writing the Qwen copy of the echo arm was still running.
- *Mock capture (17:15).* A mock OpenAI-compatible server returns
  `reasoning_content` + a tool call in its first response. In the SECOND
  request (the one after the tool result), pi's assistant message carries that
  `reasoning_content` and tentacle's does not. The capture was not saved to a
  file. The red repro below re-establishes the tentacle half of it against the
  real code.
- *Code (this branch, `d98eac90`):* the providers decode reasoning and the loop
  drops it. Cited in Implementation → Load-bearing assumption.

**Repro** (2026-11-25, `fix/reasoning-echo` = `d98eac90`, before any edit). The
script runs in `.tentacle/tmp/reasoning-echo/repro.ts` (gitignored, pasted here).
It uses the real `Agent` loop and the real `OpenAIProvider`. Only the server is a
fake (`Bun.serve`). Response 1 streams `reasoning_content` and then a `tool_calls`
delta. Response 2 is plain text. The script checks the assistant message of the
2nd request body:

```ts
import type { ExecutionEnvironment } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { OpenAIProvider } from "@tentacle/providers";
import { Agent } from "../../../packages/agent/src/agent.ts";
const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
const sse = (chunks: unknown[]): Response =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
const server = Bun.serve({ port: 0, async fetch(req) {
  bodies.push((await req.json()) as never);
  if (bodies.length === 1) return sse([
    { choices: [{ delta: { reasoning_content: "I should list the dir first." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "ls", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  return sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
} });
const env: ExecutionEnvironment = { id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""), writeFile: () => Promise.resolve() };
const agent = new Agent({ model: new OpenAIProvider({ baseURL: `http://127.0.0.1:${server.port}/v1`, model: "m" }),
  tools: new ToolRegistry(), env });
for await (const _ of agent.runMessages([{ role: "user", content: "go" }], "s1")) {}
server.stop(true);
const second = bodies[1]?.messages.find((m) => m.role === "assistant");
console.log("requests:", bodies.length);
console.log("2nd request, assistant message:", JSON.stringify(second));
const ok = second?.reasoning_content === "I should list the dir first.";
console.log(ok ? "PASS: reasoning echoed" : "FAIL (red): reasoning_content missing on the 2nd request");
process.exit(ok ? 0 : 1);
```

```
$ bun .tentacle/tmp/reasoning-echo/repro.ts; echo "exit=$?"
requests: 2
2nd request, assistant message: {"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"ls","arguments":"{}"}}]}
FAIL (red): reasoning_content missing on the 2nd request
exit=1
```

**Scope (owner).** This covers EVERY provider tentacle has. There are two
(`packages/providers/src/select-provider.ts:18`, `ProviderKind = "openai" |
"anthropic"`):
- `openai` (OpenAI-compatible: llama.cpp/Qwen, DeepSeek, vLLM, OpenRouter…).
  Reasoning comes in `reasoning_content` or `reasoning`.
- `anthropic` (Messages API). Reasoning comes as `thinking` blocks with a
  `signature`, and as `redacted_thinking`.

In both, the decoder keeps the reasoning, `ChatMessage` carries it, and the
encoder sends it back exactly as that provider expects.

**Out of scope.**
- Harness runners (`packages/agent/src/harness/`: Claude Code CLI, A2A). They
  own their histories (`harness/types.ts:1-8`: tentacle never builds their
  requests).
- Enabling Anthropic thinking where it is off today. `buildPayload` sends no
  `thinking` parameter (`anthropic-provider.ts:553-567`). A model that thinks by
  default (adaptive) is covered.

**Prior owner decision this touches.** `docs/fix/thought-placeholder.md`
(2026-11-18, option 3, binding): persist only a `thought: { ms }`
**placeholder**, never the reasoning text, for DISPLAY. That decision was about
what a reopened transcript shows. Echo needs the text as MODEL INPUT, which is a
different purpose, so whether to persist it was asked again: the owner chose to persist (Q1 A).
The display rule is unchanged (Q4 A).

### Earlier context — the Anthropic-only eval (history, kept as written)

*— claude-opus-5-5, 2026-10-17*

**The question:** should the native Anthropic provider
(`packages/providers/src/anthropic-provider.ts`) keep the `thinking` blocks of an
assistant turn, signature included, and send them back unchanged on later
requests? If so, where should that data live in the harness's
provider-agnostic history?

**Evidence (verified in code).**
- The decoder turns `thinking_delta` into `reasoning` events and discards the
  block itself. `signature_delta` is ignored (`anthropic-provider.ts`, the
  `content_block_delta` switch). `ChatMessage` (`packages/core/src/model.ts`)
  has no field for provider blocks, so `buildPayload` can only re-encode
  text and `tool_use`.
- Current Claude models run thinking that cannot be disabled (e.g. Claude Opus
  5.5: adaptive, always on). Text written between tool calls can come back as
  progress-update `thinking` blocks, which are empty under the default
  `display: "omitted"`. The API guidance is to pass thinking blocks back
  **unchanged** on every request.

**What is NOT known (why this is an eval).** The consequence of dropping the
blocks during a tool loop is undetermined. It is either:
- (a) **quality-only**: the model loses its own reasoning continuity across
  tool calls; or
- (b) **a hard 400** on some accounts or platforms. The "preserved thinking"
  history check is enforced per model and per account, e.g. for accounts
  created on or after 2026-08-31.

Static reading cannot decide this (review #3 of
`docs/feat/anthropic-api-support.md`, finding 1). **Decisive cheap test:** a
live tool loop against `https://api.anthropic.com/v1` with a real key, on the
default model, sending the second request without the first turn's thinking
blocks; record HTTP status and response.

**Constraints if promoted.**
- §7 "persistence lives on the laptop": the blocks must round-trip through
  the session JSON, otherwise `--resume` drops them again.
- The provider-agnostic contract must stay clean: the OpenAI provider must
  ignore the new field.
- Blocks are model-bound. After a model switch, the API drops blocks it
  cannot read (unbilled), so storing them is harmless.

## Implementation

*— claude-opus-5-5, 2026-11-25* — **APPROVED (owner answers 2026-11-25)**: Q1–Q5 all A, see Owner answers

Two points in the 2026-10-17 eval are superseded:
- It said the OpenAI provider must *ignore* the new field. Now it echoes its own
  format.
- It said storing blocks across a model switch was harmless. The echo is now
  strict by source instead (D5).

### Load-bearing assumption

**The reasoning of round N reaches the request of round N+1 only if four links
hold: the provider hands it to the loop, the loop stores it on the assistant
`ChatMessage`, every layer between the history and the encoder keeps the field,
and the encoder writes it in the provider's format.** Today the first two links
are missing:

- **Decode, OpenAI.** `openai-provider.ts:375-378` yields
  `delta.reasoning_content ?? delta.reasoning` as a `reasoning` event and keeps
  nothing. Which field it came in is lost too.
- **Decode, Anthropic.** `anthropic-provider.ts:273-276` yields `thinking_delta`
  as `reasoning`. `:283` ignores `signature_delta`. `content_block_start` stores
  only type/id/name (`:253-259`, the `OpenBlock` type at `:99-107`), so a
  `redacted_thinking` block's `data` and a block's `signature` are dropped.
- **Loop.** `agent.ts:1694-1696`, the `case "reasoning"` branch, only re-yields
  the delta. The assistant message is pushed with `content`, `toolCalls` and
  `thinking.fact()` (a duration placeholder) at `:1746`, `:1771`, `:1806-1810`
  and `:2052`, and never with the text.
- **Type.** `ChatMessage` (`packages/core/src/model.ts:33-128`) has no field
  for it. The closest is `thought?: ThoughtFact` (`:121-127`), a duration only.
- **Encode.** OpenAI `toWireMessage` (`openai-provider.ts:534-571`) writes
  role/content/tool_calls/tool_call_id only. Anthropic `buildPayload`
  (`anthropic-provider.ts:526-549`) writes text + `tool_use` only.

**Proven red** by the Repro in Context: the real loop and the real
`OpenAIProvider`, and the 2nd request's assistant message has no
`reasoning_content`. The same script becomes the e2e regression test (T1), and
it must go green.

The middle links are already transparent, so no projection drops the new field:
- `renderForModel` spreads `...rest` (`agent/src/context-awareness.ts:66-79`).
- `modelView` maps through it (`:88-97`).
- Prune rewrites only tool results (`agent/src/prune.ts:164-211`) and spreads
  the message (`:555`, `:600`, `:619`).

T1 pins this end to end.

### Preconditions

- **P1 — persistence is schema-driven.** The `thought` precedent (commit
  `ce433aba`) added a field to `ChatMessage` + `chatMessageShape`
  (`protocol/src/session.ts:96-206`), and the laptop log, the serve daemon log
  and its sidecar tail all carried it with no per-store code. Only tests were
  added there (`daemon/test/persistence.test.ts`). `MessageWithoutAttachmentsSchema`
  (`session.ts:236-239`, the `replace` entry) spreads the same shape. The daemon
  state sidecar parses with `ChatMessageSchema` (`daemon/src/daemon-state-file.ts:351`).
  ⇒ One schema field persists it everywhere. Schemas STRIP unknown keys
  (AGENTS §7), so leaving the field out of the schema would make it vanish
  silently on the first validated write.
- **P2 — the `message` entry is critical, and a field on it is additive.**
  `session-log.ts:12-17` holds the owner's critical table: `message` is critical.
  An older build parses a `message` that carries an unknown field and strips it.
  The entry loads, and the reasoning is lost for that build only. There is a
  precedent for a separate critical type when stripping would be a silent
  half-load: `media_message` (`session-log.ts:169-180`). Whether the reasoning
  counts as such a half-load was Q5: the owner chose A, an optional field on `message` (not a half-load: the transcript projects identically).
- **P3 — the pod model wire copies field by field.** A pod's agent loop calls
  `ProxyModelProvider`. `toWireRequest` (`daemon/src/proxy-model.ts:57-99`)
  copies role/content/attachments/toolCalls/toolCallId by hand, so a new field
  is dropped unless it is added there. `WireChatMessageSchema`
  (`protocol/src/model.ts:20-27`) and `WireStreamEventSchema` `done`
  (`:71-80`) strip too. On the laptop, `onModelStream`
  (`client/src/remote-client.ts:4619-4633`) passes the request through
  (`laptopRequest`, `:2673-2675`, spreads) and returns the provider's events
  as-is. `model.ts:57-69` is the documented precedent (`stopReason`): it got
  stripped on pods and became Review HIGH-1. It is optional and additive, so no
  `protocol.d` note.
- **P4 — reasoning already crosses RPC live.** `daemon/src/mapping.ts:291-292`
  turns `reasoning` into `agent_thought_chunk` (display class,
  `protocol/src/updates.ts:553`). Nothing new is shown live.
- **P5 — compaction and reset feed content only.** The compaction transcript is
  `role: content + calls` (`agent/src/compact.ts:44`), so reasoning never goes
  into the summary. The messages it replaces, and their reasoning, are gone from
  the live history. Context reset (`agent/src/context-reset.ts:76`) works the
  same way.
- **P6 — the context estimate counts content + tool calls + images only**
  (`core/src/token-counter.ts:49-60`). Reasoning that is sent but not counted
  would make prune and compaction trigger late. The real usage anchor
  (`agent.ts`, `anchorContext` on `done`) corrects it only up to the last
  measured request.
- **P7 — an endpoint that rejects a request field has a retry pattern already.**
  `openai-provider.ts:296-306` (F9) retries once without the field on a 400 and
  latches only if that retry SUCCEEDS.
- **P8 — the Anthropic cache marks the last block of a message.** `mark`
  (`providers/src/anthropic-cache.ts:57-66`) puts it on the last block of the
  last message and of the previous user message. Thinking blocks never sit last
  in an assistant message the encoder builds (D3), so `cache_control` never
  lands on one.
- **P9 — provider identity is deterministic.** It is `config.id ?? "openai:<model>"`
  (`openai-provider.ts:201`) and `config.id ?? "anthropic:<model>"`
  (`anthropic-provider.ts:116`). There is no main-model
  switch inside a session. A "switch" is a `--resume` under another
  profile/config, or a sub-agent with its own named model and its own history.

### Design

**D1 — one opaque, provider-owned record on the assistant message** (`core/src/model.ts`):

```ts
/** The model's own reasoning for this assistant message, as its provider must get it back. */
export interface ReasoningRecord {
  /** `ModelProvider.id` of the producer: only that provider re-sends it (D5). */
  readonly source: string;
  readonly body: ReasoningBody;
}
export type ReasoningBody =
  /** OpenAI-compatible: the text, and the field it arrived in (sent back in the same one). */
  | { readonly format: "openai"; readonly field: "reasoning_content" | "reasoning"; readonly text: string }
  /** Anthropic: the response's reasoning blocks, verbatim, in order. */
  | { readonly format: "anthropic"; readonly blocks: readonly AnthropicReasoningBlock[] };
export type AnthropicReasoningBlock =
  | { readonly type: "thinking"; readonly thinking: string; readonly signature: string }
  | { readonly type: "redacted_thinking"; readonly data: string };
// ChatMessage gains:  readonly reasoning?: ReasoningRecord;   (assistant only)
```

The loop never looks inside the record. Only the provider that produced it reads
it. That keeps the provider-agnostic contract clean. `thought` (the display
placeholder) is untouched.

**D2 — the provider hands the record over on `done`.** Add
`reasoning?: ReasoningRecord` to the `done` `StreamEvent` (`model.ts:233-237`).
This is the end of the response, when the record is complete. The deltas stay as
they are (`reasoning` events for live display).
- **OpenAI.** Accumulate the deltas, and remember the FIRST field name seen.
  Attach the record if the text is non-empty.
- **Anthropic.** Extend `OpenBlock` and the event types:
  - on `content_block_start`, read `thinking`, `signature` and `data`;
  - `thinking_delta` appends to the block's text;
  - `signature_delta` sets the block's signature;
  - on `content_block_stop`, a `thinking` block that has a signature, and any
    `redacted_thinking` block, are appended to `blocks` in stream order.
  - A thinking block with an empty text and a signature (`display: "omitted"`)
    is KEPT: it is exactly what the API wants back.
  - A block without a signature (cut stream) is dropped. It would 400.

**D3 — encode, in the provider's own format.** Only when
`record.source === this.id` and `record.body.format` is the provider's own
format:
- **OpenAI** `toWireMessage`: set `wire[field] = text` on the assistant message.
  The field is the one the text arrived in.
- **Anthropic** `buildPayload`: when the record is set, the assistant message
  always uses content blocks. The reasoning blocks go FIRST, verbatim and in
  order, then text, then `tool_use`. A reasoning-only assistant message (no
  text, no calls) is still dropped, as the empty one is today
  (`anthropic-provider.ts:532-537`). The API rejects an assistant turn whose
  only content is thinking.

**D4 — the loop stores it.** In `agent.ts`:
- `case "done"` keeps `event.reasoning`.
- The pushes at `:1806-1810` (normal end of a round, tool calls or not) and
  `:2052` (the forced final report) add `...(record ? { reasoning: record } : {})`.
- The throw paths `:1746` and `:1771` (a stream that failed or was cut) get no
  record: no `done` with a complete record arrived.
- A DSML-leak round pushes nothing, as today.

**D5 — strict by source (model switch).** A record is echoed only to the
provider whose `id` produced it. It is dropped on the wire (never deleted from
history) for any other provider: a resume under another profile, a pod whose
laptop now runs another model. There are three reasons:
- The reasoning of model A, given to model B as B's own, is misleading.
- An Anthropic signature from another model may be rejected.
- A switch back to A finds it intact.

This is my design choice, not an owner question: it is the conservative one and
it can be relaxed later.

**D6 — echo scope: always** (owner Q2 A):
- Every assistant message that has a record gets it on every request, as pi does
  and as the bench proxy did.
- The bytes of earlier messages never change, so the prompt cache prefix holds.
- The server's chat template decides what the model sees. Qwen3 and DeepSeek
  templates render reasoning only after the last user query. Anthropic keeps or
  strips earlier thinking per model.

**D7 — context estimate and pruning.**
- `TokenCounter.countMessages` counts `reasoning` too: the OpenAI text, or the
  sum of thinking + data of the Anthropic blocks.
- Compaction and reset drop it with the messages they replace (P5). Nothing more
  is needed.
- No cap and no extra pruning of reasoning (owner Q3 A): it is never truncated.

**D8 — wire (protocol, additive, no `protocol.d` note).**
- `chatMessageShape` gets `reasoning: ReasoningRecordSchema.optional().catch(undefined)`.
  It is FAIL-SOFT like `thought`: a malformed or oversized value is DROPPED and
  the critical `message` entry still loads.
- Schema bounds, a guard against malformed or hostile input and NOT a cap (Q3 A:
  nothing is ever truncated): `source` ≤ 256 chars, each text/data ≤ 1 MiB,
  blocks ≤ 64. A value over a bound is dropped whole (fail-soft), never cut.
  Confirm in s1 that real turns sit far below (DeepSeek: 6.3k ch/turn average).
- `WireChatMessageSchema` gets the same optional field. `WireStreamEventSchema`
  `done` gets `reasoning` optional.
- An older peer strips the field. The result is no echo, never a failed turn
  (the `stopReason` rule, `model.ts:57-69`).

**D9 — 400 fallback (OpenAI-compatible).** If a request that carried echoed
reasoning gets a 400:
- Retry ONCE with no reasoning fields, and latch `reasoningEchoRefused` only if
  that retry succeeds. This is the F9 pattern (P7).
- The latch is per provider instance. A daemon restart re-probes.
- Anthropic gets no fallback: dropping its blocks is today's behaviour. If the
  API demands them, the 400 is real and must surface.

**D10 — what crosses to the TUI and the phone.**
- `session/log` carries the field, because the laptop store needs it (P1).
- The TUI and the phone ignore it. The display stays the `thought` placeholder
  (thought-placeholder, binding; owner Q4 A: not shown after resume).

### Files (dependency order)

1. `packages/core/src/model.ts`: the `ReasoningRecord` types,
   `ChatMessage.reasoning`, `done.reasoning`.
   `packages/core/src/token-counter.ts`: count it (D7).
2. `packages/protocol/src/session.ts`: `ReasoningRecordSchema`, the field in
   `chatMessageShape` (fail-soft).
   `packages/protocol/src/model.ts`: `WireChatMessageSchema.reasoning`, `done.reasoning`.
   Regenerate `protocol/schema/protocol.json` (`bun run protocol:bump`, no notes).
3. `packages/providers/src/openai-provider.ts`: accumulate and attach on `done`,
   echo in `toWireMessage` (source-checked), the D9 retry.
4. `packages/providers/src/anthropic-provider.ts`: `OpenBlock` +
   `AnthropicEvent` with thinking/signature/data, collect blocks, attach on
   `done`, emit first in `buildPayload`.
   `anthropic-cache.ts` needs no change (P8). A test pins it.
5. `packages/agent/src/agent.ts`: D4 (`case "done"` plus the push sites).
6. `packages/daemon/src/proxy-model.ts`: `toWireRequest` copies `reasoning` (P3).
   `client/src/remote-client.ts` needs no change (it passes through). A test
   pins it.
7. `changelog.d/reasoning-echo.fixed.md`.

No TUI or mobile change (D10, owner Q4 A).

### Failure modes

| case | what happens | how it converges |
|---|---|---|
| Huge reasoning vs the context window | Counted in the estimate (D7). Prune and compaction fire on real size. Compaction drops it (P5). | The next request fits. Never a silent overflow. No cap (Q3 A). Only a message over the 1 MiB schema guard is dropped whole (fail-soft), so echo is lost for that message only. |
| Server rejects the unknown field (400) | D9: one retry without it, latched only on success. | The turn continues as today. A 400 for another cause fails both bodies and latches nothing. |
| Model switch (`--resume` under another profile, a pod's laptop on another model) | D5: not sent (source ≠ id). | History keeps it. A switch back echoes again. |
| Old session file without the field | Loads as today, nothing echoed for old messages. | New rounds carry it. |
| Older build reading a new file | Strips the field (P2) and loads; no echo. If that build rewrites the segment, the reasoning is gone from the file. | Accepted: owner Q5 A. |
| Pod / untrusted reasoning (AGENTS §7) | A pod can already put any text in `content` of the history it sends. `reasoning` adds no new trust edge to the model. The laptop stores it only as part of a validated message (bounded, fail-soft). | A forged Anthropic signature only 400s the pod's own turn. No laptop-side effect: no approval, no I/O. |
| Secrets in reasoning | Reasoning can quote tool output. Redaction (`agent/src/redact.ts`) runs before tool output enters the history, so the model saw masked text. Reasoning already crosses RPC live (P4), and tool output with the same content is already persisted. | No new exposure class on disk (persisted, owner Q1 A). |
| Cut stream / abort mid-reasoning | No `done` record (D4). Anthropic drops unsigned blocks (D2). | That round is not echoed. Never an invalid block. |
| `display: "omitted"` (empty thinking + signature) | Kept and echoed verbatim (D2). | As the API asks. |
| Thinking interleaved with text inside ONE Anthropic message | D3 re-emits all reasoning blocks first. Original positions are not kept. | Residual risk. The live Anthropic check (V3) decides. If it 400s, add per-block positions (S4 follow-up, contained). |
| Sub-agent | Its own `Agent` + history: covered by the same code. The parent never sees the child's reasoning. | Nothing to do. |
| Phone / TUI load size | `session/log` carries the text (D10). It is about 6k ch per round on bad runs, ~1k with echo. | Accepted (Q4 A: carried, not drawn). |

### Tests (red first, on `d98eac90`; fakes are injected `fetch` / `Bun.serve`, as in `providers/test/tool-call-split-e2e.test.ts`)

- **T1 (load-bearing, e2e, red today):** the Repro as `packages/agent/test/reasoning-echo.test.ts`.
  - The real `Agent` + `OpenAIProvider` against a `Bun.serve` fake.
  - Request 2's assistant message must carry `reasoning_content` with response
    1's text, byte-identical.
  - Variant: field `reasoning` in, `reasoning` out.
  - Variant: no reasoning in, no field out.
- **T2 (OpenAI encode/decode):**
  - `done.reasoning` accumulates across deltas.
  - The echo is skipped when `source` ≠ `id`.
  - D9: the fake 400s when the field is present → one retry without it →
    latched. A 400 for another cause (both bodies 400) → not latched.
- **T3 (Anthropic, fake Messages server):**
  - SSE with `thinking` (deltas + `signature_delta`), `redacted_thinking`
    (`data`), text, `tool_use`.
  - Request 2's assistant content must be `[thinking{thinking,signature},
    redacted_thinking{data}, text, tool_use]`, verbatim.
  - An omitted-display block (`thinking: ""` + signature) is echoed.
  - An unsigned block is not echoed.
  - No `cache_control` on a thinking block (P8).
  - A reasoning-only assistant message is dropped.
- **T4 (persistence, P1):**
  - Laptop log and serve daemon log + sidecar round-trip `reasoning`
    byte-identical (extend `daemon/test/persistence.test.ts` and the laptop
    store test, as the `thought` commit did).
  - A malformed or oversized `reasoning` is dropped and the critical entry still
    loads (`protocol/test/`).
  - A file without the field loads unchanged.
- **T5 (pod wire, P3):** a pod-side `ProxyModelProvider` request through
  `toWireRequest` keeps `reasoning`, and a `done.reasoning` from the laptop
  reaches the pod loop. Red today: `toWireRequest` drops it. Mutation check:
  remove the copy and the test fails.
- **T6 (estimate):** `countMessages` grows with the reasoning length.
- **T7 (compaction):** reasoning is not in the compaction transcript, and is
  gone from the compacted history.

Non-vacuity: T1 and T5 are red on `d98eac90`. T2–T4 are mutation-checked:
disable the echo and remove the schema field, and each must fail.

### Validation (after merge-ready, before merge)

- **V1 — bench, the real fix, NO proxy echo.**
  - Build `tentacle-bench` from this branch.
  - Re-run stale-taskrun with prompt-c + cap50k on DeepSeek and on Qwen, with
    `ECHO_REASONING` UNSET.
  - Target ≈ the proxy-echo numbers: DeepSeek PASS, ~5 min, ~20k out,
    ~1.1k reasoning ch/turn.
  - Also confirm on the proxy trace that requests carry `reasoning_content`
    (the trace's `last_message` / a body dump) and the proxy's `echoed` counter
    stays 0.
- **V2 — resume.** Run a turn, `--resume`, then the next turn. Request 1 after
  the resume carries the earlier reasoning (Q1 A: persisted).
- **V3 — live Anthropic.**
  - A short tool loop on the owner's API key (Keychain `tentacle-anthropic`,
    the cheapest thinking-capable model, `count_tokens` first).
  - Check that the 2nd request with echoed blocks is a 200 and that the
    interleaved case does not 400.
  - This is the 2026-10-17 eval's decisive test, now run as a check.

### Slices

| id | what | executor | why |
|---|---|---|---|
| s1 | Files 1–2: core types + protocol schemas + T4 + T6 | opus | Persisted critical entry and the wire. Load-bearing. |
| s2 | File 3: OpenAI decode/encode/D9 + T2 | sonnet | One file. Pattern exists (F9). Cheap to iterate. |
| s3 | File 4: Anthropic blocks + T3 + V3 | opus | Signature and order semantics. A mistake 400s every Anthropic turn. |
| s4 | Files 5–6: loop + pod wire + T1, T5, T7 | opus | Agent loop + §7 pod invariant. |
| s5 | V1–V2 bench + resume check, report into Execution | sonnet | Running and measuring only. |

Review: fresh-context Opus, red-teaming the §7 on-disk records rule
(P2, owner Q5 A), the pod wire (P3) and D5.

### Owner questions

**Q1 — Persist the reasoning text on disk (laptop log + `serve` daemon log), or keep it in memory only?**
- **A (recommended): persist.**
  - Without it, every `--resume`, re-attach, session hop or daemon restart
    loses the echo. The first rounds after it re-derive, and that is the bug we
    measured.
  - It does not reverse the 18/11 decision: that one was about display, and
    nothing is shown.
  - It costs disk: about 1–6k chars per round.
- B: memory only. The fix works only inside one live process.

**Q2 — Send it back always, or only for the current turn (after the last user message, as the chat templates do)?**
- **A (recommended): always.**
  - It is what pi and the bench proxy did.
  - The bytes of old messages never change, so the prompt cache holds.
  - The server's template already discards what it does not want.
- B: current turn only. Fewer bytes per request, but each new user message
  changes the earlier bytes (the cache restarts from there), and it departs from
  what was measured.

**Q3 — A size cap on stored/sent reasoning?**
- **A (recommended): no cap.**
  - It is counted in the context estimate, so prune and compaction handle it,
    and compaction drops it.
  - A cut Anthropic block is invalid anyway.
  - Only a single absurd message (over the 1 MiB schema bound) is dropped.
- B: an OpenAI-only cap per message (e.g. the last 32k chars). It is no longer
  the model's exact text.
- C: no cap, but the next prune batch also drops the reasoning of turns before
  the current one.

**Q4 — Show the reasoning on the phone/TUI after a resume?**
- **A (recommended): no.** Keep the `Thought · N s` placeholder (18/11). The
  text rides `session/log` but is not drawn.
- B: an expandable Thought row on the phone after a reload, as a separate
  follow-up task with mockups.
- C: like A, and also strip it from `session/log` for display clients, to save
  phone bandwidth. That needs a new request flag.

**Q5 — Critical log entries: put the field on the existing critical `message` entry, or add a new critical type?**
- **A (recommended): an optional field on `message`.**
  - An older build still opens the session and only loses the echo (and drops
    the field if it rewrites the file).
  - Losing it costs speed, not correctness: the transcript projects identically.
- B: a new critical `reasoning_message` type (like `media_message`). An older
  build REFUSES almost every new session.
- C: a separate non-critical `reasoning` entry keyed by message index. Older
  builds skip it, but it adds a second write and a new rule to keep in sync on
  replace/truncate.

### Owner answers

*Recorded verbatim, owner 2026-11-25 ~17:35:*

> Q1 A (persist on disk), Q2 A (send back always), Q3 A (no cap), Q4 A (not shown after resume; keep the Thought placeholder), Q5 A (optional field on the existing critical message entry) — all as you recommended.

The plan above already reflects these answers: D6, D7, D8, D10, the failure
modes and V2. Executors: Opus on the load-bearing slices, Sonnet on the cheap
ones. DeepSeek is paused by the owner until this fix merges.

SLICES: s1=opus s2=sonnet s3=opus s4=opus s5=sonnet

## Execution

### s1 — core types + protocol schemas + T4 + T6

*— claude-opus-5-5, 2026-11-25*

**Load-bearing check, re-run first** (before any edit, on this worktree's
sources: the Repro with its imports pointed at the worktree,
`.tentacle/tmp/reasoning-echo/repro-wt.ts`): still red, exactly as in Context —
`requests: 2`, the 2nd request's assistant message
`{"role":"assistant","content":"","tool_calls":[…]}`, `FAIL (red):
reasoning_content missing on the 2nd request`, exit 1. (s1 does not turn it
green: the decode/loop/encode links are s2–s4.)

**As built, in order (red first, then green):**
1. Tests written and shown RED on the assertion (not on an import):
   - T6 `packages/core/test/token-counter.test.ts` (new describe at the end):
     OpenAI text counted; Anthropic thinking + redacted data counted, the
     signature not. Red: `Expected: 35 / Received: 5`.
   - T4 schema half, new `packages/protocol/test/reasoning-record.test.ts`:
     valid record byte-identical (openai `reasoning_content`, openai
     `reasoning`, anthropic incl. an omitted-display block); malformed dropped
     whole, message still parses; bounds (at the bound kept, over dropped:
     source 256, text/thinking/signature/data 1 MiB, blocks 64); the critical
     `message` entry carries it and loads when malformed; older reader strips;
     the pod wire (`WireChatMessageSchema`, `done`) keeps / drops fail-soft.
     Red: 5 fail (the 2 that passed are the fail-soft/strip guards, true by
     stripping today — made non-vacuous by M2 below).
   - T4 persistence: `packages/daemon/test/persistence.test.ts` (serve daemon:
     log + sidecar through `parseFixture` → `restore` → `snapshotPage`, next to
     the `thought` test) and `packages/daemon/test/session-log-store.test.ts`
     (laptop `<uid>.jsonl`: a cold base + an appended round round-trip; a file
     without the field loads unchanged). Red: both round-trip tests fail
     (field stripped on load).
2. `packages/core/src/model.ts`: `ReasoningRecord` / `ReasoningBody` /
   `AnthropicReasoningBlock` (D1, verbatim), `ChatMessage.reasoning?`,
   `done.reasoning?` on `StreamEvent`.
3. `packages/core/src/token-counter.ts`: `countMessages` adds
   `countReasoning` (D7).
4. `packages/protocol/src/model.ts`: `REASONING_TEXT_MAX` (1 MiB),
   `REASONING_BLOCKS_MAX` (64), `AnthropicReasoningBlockSchema`,
   `ReasoningBodySchema` (both discriminated unions), `ReasoningRecordSchema`;
   `WireChatMessageSchema.reasoning` and `WireStreamEventSchema` `done.reasoning`,
   both `.optional().catch(undefined)`.
5. `packages/protocol/src/session.ts`: `chatMessageShape.reasoning =
   ReasoningRecordSchema.optional().catch(undefined)` (so `ChatMessageSchema`,
   `MessageWithAttachmentsSchema`, `MessageWithoutAttachmentsSchema` all carry it).
6. `bun run schema:export` → `packages/protocol/schema/protocol.json` (+139
   lines); `packages/protocol/test/json-schema.test.ts` union count 12 → 14
   (the two new tagged unions, comment added).
7. `changelog.d/reasoning-echo.fixed.md`.

**Drift from Implementation (and why):**
- `ReasoningRecordSchema` lives in `protocol/src/model.ts`, not `session.ts`:
  the pod wire schema (in `model.ts`) needs it too, and `model.ts` cannot
  import `session.ts` (which already imports `model.ts`) without a cycle.
  `session.ts` imports it. Same schema, one definition.
- The wire carriers (`WireChatMessageSchema.reasoning`, `done.reasoning`) are
  FAIL-SOFT too (`.catch(undefined)`), not just optional: D8 says "no echo,
  never a failed turn", and a strict field would fail a whole `model/stream`
  on one malformed record.
- Bounds made explicit beyond D8's list, all following D2: OpenAI `text`
  min 1 (D2 attaches only non-empty text); a `thinking` block's `signature`
  min 1 (an unsigned block is never stored — it would 400); `redacted_thinking`
  `data` min 1; `blocks` min 1; the signature is bounded at 1 MiB like the texts.
- Regenerated with `bun run schema:export`, not `protocol:bump`: there is no
  `protocol.d/` on this branch, so the two are the same schema refresh, and
  the version line stays the orchestrator's (AGENTS §7).
- D8 "confirm real turns sit far below the bound": only the average is
  measured (DeepSeek no-echo arm 6.3k ch/turn, Context table) — ≈166× under
  1 MiB. The per-turn MAX is unmeasured; s5's bench can record it.

**Mutation checks (each reverted, `rg MUTATION` clean afterwards):**

| mutation | result |
|---|---|
| M1 drop `reasoning` from `chatMessageShape` | 3 protocol tests fail + daemon restart test + laptop store round-trip fail |
| M2 drop `.catch(undefined)` on the `chatMessageShape` field | "malformed dropped", "bounds", "critical entry loads when malformed" fail |
| M3 drop the field from `WireChatMessageSchema` and from `done` | both pod-wire tests fail |
| M4 `countMessages` adds `0 * countReasoning` | both T6 tests fail |

**Verification (narrow, per the token budget):**
`bun test packages/core/test/token-counter.test.ts packages/protocol/test/` →
586 pass, 0 fail; `bun test packages/daemon/test/session-log-store.test.ts
packages/daemon/test/persistence.test.ts` → 165 pass, 0 fail; `bunx biome
check` on the 10 touched TS/JSON files → clean. Whole-repo typecheck/lint/test: the
orchestrator's gate (not run here). Typecheck risk noted: core's `readonly`
arrays vs protocol's inferred mutable ones — the core↔wire seams already cast
(`daemon/src/session-log.ts:478`, `client/src/remote-client.ts:4634`), as for
`toolCalls`.

**Status: s1 DONE.** s2–s5 untouched.

### s2 — OpenAI provider decode / encode / D9 + T2

*— claude-sonnet-5-5, 2026-11-25*

**Load-bearing check, re-run first:** the s2 links (`openai-provider.ts`
decode keeps nothing; `toWireMessage` writes role/content/tool_calls/
tool_call_id only) were read in the worktree sources as the plan states. Red
confirmed by the new test file below (5 of 9 fail on the buggy code, on the
assertions: no `done.reasoning`, no echoed field, no retry).

**As built (red first, then green):**
1. `packages/providers/test/reasoning-echo-openai.test.ts` (new, T2): decode
   (accumulate across deltas, field kept, none → no record); encode (both
   fields echoed, other `source` not sent and not deleted, anthropic-format
   record not sent); D9 (one retry without the field and latched only after
   success; a 400 for another cause fails both and is NOT latched; no echoed
   reasoning → no retry).
2. `packages/providers/src/openai-provider.ts`: `done` carries
   `reasoning` (`doneEvent` takes it; text accumulated, FIRST field name kept,
   attached only if non-empty); `ownOpenAIReasoning` (D5: assistant message,
   `source === this.id`, `format: "openai"`); `buildPayload`/`wireMessages`/
   `toWireMessage` take an `echoSource` and write `wire[field] = text`;
   `post` takes `echo`; `stream` computes `echoing` (own record present and
   not latched) and, on a 400 with `echoing`, retries once without it and
   sets `reasoningEchoRefused = res.ok` (per instance, F9 pattern).
3. The `/apply-template` token-count path (`countTokens`) builds its payload
   WITH the echo (unless latched), so the measured prompt matches what is sent.
4. `test/openai-provider.test.ts`: the existing `done` expectation now
   includes the `reasoning` record (the stream there does emit reasoning).

**Drift:** none from D2/D3/D5/D9. Note: the echo retry also drops the
"do not reason" switches if F9 latched in the same request (`off = wantOff &&
!reasoningSwitchesRefused`), so the two fallbacks compose.

**Mutations (each reverted, `rg MUTATION` clean; script
`.tentacle/tmp/reasoning-echo/mutate.ts`):**

| mutation | tests failing |
|---|---|
| M1 no echo write in `toWireMessage` | 3 (echoed same field; both D9 tests) |
| M2 no `source` check | 1 (other source not sent) |
| M3 latch always (`= true`) | 1 (400 other cause not latched) |
| M4 no echo retry | 2 (both D9 tests) |
| M5 field name not kept | 1 (`reasoning` remembered) |
| M6 no record on `done` | 2 (both decode tests) |

**Verification:** `bun test packages/providers` → 234 pass, 0 fail; `bunx biome
check` on the 3 touched files → clean; `tsc --noEmit` shows only the
pre-existing `serve-mcp-e2e.test.ts` missing-module errors (the
`@modelcontextprotocol/*` deps are not installed in this worktree), none in
providers. Changelog fragment `changelog.d/reasoning-echo.fixed.md` already
written in s1 (unchanged). Whole-repo gate: the orchestrator's.

**Status: s2 DONE.** s3–s5 untouched.

### s3 — Anthropic provider blocks / encode + T3 + V3

*— claude-opus-5-5, 2026-11-25*

**Load-bearing check, re-run first:** the s3 links read in the worktree as the
plan states (`content_block_start` kept type/id/name only; `signature_delta`
fell to `default`; `buildPayload` wrote text + `tool_use` only). Shown red by
T3 below.

**As built (red first, then green):**
1. `packages/providers/test/reasoning-echo-anthropic.test.ts` (new, T3, injected
   `fetch`): decode — thinking (deltas + `signature_delta`) and
   `redacted_thinking` (`data`) on `done`, in stream order, live `reasoning`
   deltas unchanged; omitted-display block (`""` + signature) kept; unsigned
   block dropped (⇒ no record); a block never closed (cut) dropped; no
   reasoning ⇒ no record. Encode — provider round trip, request 2's assistant
   content `[thinking, redacted_thinking, text, tool_use]` verbatim; a no-call
   assistant with a record → blocks, reasoning first; reasoning-only assistant
   dropped; another `source` / an openai-format record not sent (message
   unchanged); no `cache_control` on a reasoning block, both with and without
   calls, with `applyCacheControl` (P8). Red on the buggy code: 6 fail on the
   assertions (`Received: undefined` / missing blocks); the 4 passing were the
   guards (unsigned, none, reasoning-only, other source), made non-vacuous by
   the mutations below.
2. `packages/providers/src/anthropic-provider.ts`:
   - `OpenBlock` + `thinking` / `signature` / `data` (`:112`); `AnthropicEvent`
     reads them on `content_block` and `delta.signature`.
   - `stream`: `thinking_delta` also appends to the block; `signature_delta`
     sets it (`:303`); on `content_block_stop` a non-tool block goes through
     `reasoningBlock` (`:406`: signed thinking, or redacted with data) into
     `reasoning` (`:215`) in stream order; `doneEvent` (`:433`) attaches
     `{ source: this.id, body: { format: "anthropic", blocks } }` when any.
   - `buildPayload(…, echoSource?)` (`:547`); `ownReasoningBlocks` (`:656`,
     D5: assistant, `source === echoSource`, format `anthropic`). With
     own blocks a no-call assistant uses blocks; reasoning first, then text,
     then `tool_use`; a reasoning-only turn is still dropped (`:603`).
     `stream` (`:193`) and `countTokens` (`:150`) pass `this.id`, so the
     free count measures what is sent.
   - `anthropic-cache.ts` unchanged (P8, pinned by T3).

**Drift:** none from D2/D3/D5. Explicit: `buildPayload` echoes nothing when
called without `echoSource` (the 3 existing test callers keep today's bytes).
The thinking `signature` is SET from `signature_delta` (as D2 says), not
appended.

**Mutations (each reverted, `rg MUTATION` clean, diff stat unchanged; script
`.tentacle/tmp/reasoning-echo/mutate-s3.ts`):**

| mutation | T3 tests failing |
|---|---|
| M1 `signature_delta` ignored | 4 |
| M2 unsigned thinking kept | 1 (unsigned dropped) |
| M3 redacted dropped | 2 |
| M4 no record on `done` | 4 |
| M5 no `source` check | 1 (other source) |
| M6 no format check | 1 (openai-format record) — a first variant with `?? []` was an equivalent mutant and survived; replaced |
| M7 reasoning-only kept | 1 |
| M8 reasoning not first (reversed) | 3 (incl. P8) |
| M9 `stream` passes no `echoSource` | 1 (round trip) |
| M10 thinking text not accumulated | 3 |

**V3 — live Anthropic** (`.tentacle/tmp/reasoning-echo/v3.ts`: the REAL
`AnthropicProvider` from this worktree, key from Keychain `tentacle-anthropic`
never printed; the injected `fetch` adds the `thinking` param tentacle does not
send, everything else is the provider's own bytes). `claude-haiku-5-5`:
- `thinking: {type: "enabled"}` → 400 "not supported for this model, use
  adaptive". Adaptive with default effort on a trivial prompt → no thinking.
- adaptive + `output_config.effort: "high"` (display default = omitted):
  round 1 `thinking, text, tool_use` → record `thinking(0ch, sig 1524ch)`;
  count_tokens 825; **round 2 with echoed blocks: HTTP 200**, prompt 825 tokens
  vs **633 without** the echo (control, also HTTP 200). So the API does not
  400 on dropped blocks (the eval's case (a)): today's loss is silent, and the
  echo is what puts the reasoning back in front of the model.
- adaptive + `display: "summarized"`: record `thinking(193ch, sig 1380ch)`,
  round 2 HTTP 200 (770 tokens).
- Parallel calls (`thinking, text, tool_use, tool_use`): round 2 HTTP 200.
- **Interleaved within ONE message (thinking after text): NOT observed.** Even
  when the prompt asked for it, Haiku put all its thinking first. The failure-mode
  row stays a residual risk, unverified. To verify it, capture a real response
  whose block order is `thinking, text, thinking, …` (more likely on a
  Sonnet/Opus long tool round) and replay request 2.
- Spend ≈ $0.003 (5 Haiku calls of ≤ 900 prompt / ≤ 600 output tokens + free
  count_tokens).

**Verification:** `bun test packages/providers` → 244 pass, 0 fail; `bunx biome
check` on the 2 touched files → clean; `bunx tsc --noEmit -p .` → 0 errors.
Changelog fragment unchanged (s1's already names Anthropic's signed `thinking`
blocks). Whole-repo gate: the orchestrator's.

**Status: s3 DONE** (V3 done except the interleaved case, unverified as
above). s4–s5 untouched.

### s4 — loop + pod wire + T1, T5, T7

*— claude-opus-5-5, 2026-11-25*

**Load-bearing check, re-run first** (`.tentacle/tmp/reasoning-echo/repro-wt.ts`,
worktree sources, s1–s3 in): still red — `requests: 2`, 2nd assistant message
`{"role":"assistant","content":"","tool_calls":[…]}`, `FAIL (red)`. The
remaining missing link was the loop (D4), as planned. The plan's other claims
for s4 were confirmed in the source: `toWireRequest` copied field by field;
the laptop's `laptopRequest` spreads and `onModelStream`/`onModelStreamChunked`
return the provider's events as-is (`remote-client.ts:2680`, `:4625`, `:4840`).
**After s4 the repro prints `PASS: reasoning echoed`** (the 2nd request's
assistant message ends `"reasoning_content":"I should list the dir first."`).

**As built (red first, then green):**
1. T1 + T7, new `packages/agent/test/reasoning-echo.test.ts` (real `Agent` +
   real `OpenAIProvider` against a `Bun.serve` fake bound to `127.0.0.1`):
   `reasoning_content` in → out and `reasoning` in → out, byte-identical
   (unicode/quotes/newlines), the other field absent; no reasoning → no field;
   D6 always: request 3 carries rounds 1 AND 2 on their own messages, and the
   stored history holds the `openai:m` records; the forced final report
   (`maxIterations: 1`) stores its record and its request echoes round 1; a cut
   stream (no stop reason) keeps its text and stores NO record. T7: the
   compaction transcript contains the content, never the reasoning; the
   compacted history has no record. **Red on the buggy loop: 4 fail on the
   assertions** (`Received: undefined`); the 2 passing were guards (no
   reasoning; cut stream), plus T7 (true today by P5) — all made non-vacuous by
   M3/M6 below.
2. `packages/agent/src/agent.ts`: `let reasoning` per round (`:1689`), set in
   `case "done"` (`:1709`); the normal-end push adds it (`:1816`). The forced
   final report keeps its own `finalReasoning` (`:2032`, `:2036`) and pushes it
   (`:2072`). The throw paths (provider throw, `stopReason: "other"`, cut tool
   call) and the DSML re-ask push no record, unchanged.
3. T5, `packages/daemon/test/proxy-model.test.ts` (new describe at the end):
   `toWireRequest` keeps an openai AND an anthropic record, on `stream` and on
   `countTokens`, checked after `WireChatRequestSchema.parse` (as the laptop's
   peer parses it); a message without a record has no key. A POD `Agent` whose
   only model is `ProxyModelProvider`, the laptop side validating each request
   with `WireChatRequestSchema` and answering `done{reasoning}`: request 2 that
   reaches the laptop carries the record — chunked path and batch path
   (`ModelStreamResultSchema.parse`). **Red before the fix: 3 of 3 fail** on
   the assertions.
4. `packages/daemon/src/proxy-model.ts`: `toWireRequest` copies `reasoning`
   (`:98`) through `toWireReasoning` (`:60`).
5. Changelog: the s1 fragment `changelog.d/reasoning-echo.fixed.md` already
   states the end-to-end behaviour s4 delivers; unchanged.

**Drift from Implementation (and why):**
- `toWireReasoning` copies the Anthropic `blocks` array (`[...body.blocks]`)
  instead of passing the record through: core's `ReasoningRecord` has
  `readonly` arrays and the wire type is mutable, so the plain copy failed
  `tsc -p packages/daemon` (TS2322, the risk s1 noted). Same values, no cast —
  the pattern `toolCalls` already uses on the same function. T5's anthropic
  case pins it (M5).
- No other drift. `client/remote-client.ts` unchanged, as planned (the pod T5
  tests play the laptop with the real wire schemas; the `RemoteClient` pass-
  through itself was read, not run).

**Mutations (each reverted; script `.tentacle/tmp/reasoning-echo/mutate-s4.ts`,
run over both touched test files; `git diff --stat` of `src/` unchanged
afterwards):**

| mutation | tests failing |
|---|---|
| M1 `case "done"` does not keep `event.reasoning` | 6 (4 T1 + both T5 pod-loop) |
| M2 the final report does not keep its record | 1 (final report) |
| M3 the cut-stream push (`stopReason: "other"`) stores the record | 1 (cut stream) |
| M4 `toWireRequest` drops the field | 4 (all T5) |
| M5 `toWireReasoning` drops the anthropic blocks | 1 (anthropic wire) |
| M6 compaction transcript renders the reasoning | 1 (T7 transcript) |

**Verification (narrow):** `bun test packages/agent/test/reasoning-echo.test.ts
packages/daemon/test/proxy-model.test.ts` → 30 pass, 0 fail; existing loop
tests `thinking-placeholder`, `truncated-reply`, `agent`, `compact`,
`dsml-leak` → 81 pass, 0 fail; `bunx tsc --noEmit -p packages/agent` and
`-p packages/daemon` → 0 errors; `bunx biome check` on the 4 touched files →
clean. Whole-repo gate: the orchestrator's.

**Status: s4 DONE.** s5 untouched.

### Fix round 1 (Review s1–s5: two MEDIUM, both D9)

**Changed:** `packages/providers/src/openai-provider.ts` — the D9 block in
`stream()` and a new `namesEchoField()` next to `safeText()`;
`packages/providers/test/reasoning-echo-openai.test.ts` — two new D9 tests, and
the existing latch test's 400 body now names the field.

1. **Finding 1 (latch on a 400 it did not cause) — FIXED.** The echo latch now
   needs the retry to succeed AND the 400 body to name `reasoning_content` or
   `reasoning` as a whole word. `reasoning_effort` (an F9 switch) does not
   count. Any other 400 falls back for that one request and latches nothing.
   That makes the failure-mode row "a 400 for another cause … latches nothing"
   true again. *Not done:* the reviewer also suggested reporting the latch
   (`onRetry`/a log). `OpenAIProvider` has no reporting seam: no logger, and
   `onRetry` belongs to `RetryingModelProvider`. Adding one is outside the
   approved Implementation. With the evidence rule, a latch only fires on a
   400 that names the field, so it is no longer a silent wrong latch.
2. **Finding 2 (voice turn fails on an endpoint that refuses both) — FIXED.**
   When the D9 retry still carried the switches and 400ed, there is now one
   last request with neither. Its success latches `reasoningSwitchesRefused`.
   That is F9's own evidence: the only difference from the request just
   refused is the switches. So the next voice turn sends 2 requests, not 4.
   The echo latch still follows finding 1's rule.

**Red first** (tests on the unfixed code, 9 pass / 2 fail, both on the
property): the overflow test asserts the next small turn still echoes and got
`Expected: true, Received: false`. The both-refused test asserts the voice turn
succeeds and got `ModelRequestError … status 400: bad request`.
**Green:** `reasoning-echo-openai` + `reasoning-off` → 18 pass, 0 fail. All
six OpenAI/voice provider test files (`openai-{provider,images,stop-reason,
stream-error}`, `reasoning-off`, `reasoning-echo-openai`) → 47 pass, 0 fail.
`bunx biome check` on the 2 files → clean.

**Mutations** (each one alone, then reverted; a grep for the markers finds
none left):
| Mutation | Caught by |
|---|---|
| M1 echo latch ignores evidence (`res.ok`) | overflow test (1 fail) |
| M2 no last try with neither (`false && off …`) | both-refused test (1 fail) |
| M3 last try does not latch the switches | both-refused test, 2nd turn bound (1 fail) |
| M4 `namesEchoField` → `false` | "one retry … latched only after it succeeds" (1 fail) |

**Drift:** D9's rule ("latch only if the retry succeeds") is now stricter: the
400 must also name the field. On top of that, a voice turn gets one extra
request when both single drops fail. An endpoint that refuses the field with a
generic body pays 2 requests on each echoing turn, and never fails one. Gate:
the orchestrator's script.

*— claude-opus-5-5, 2026-11-25*

## Review

*(empty until Execution)*

### Eval verdict (history, 2026-10-17)

*— claude-opus-5-5, 2026-10-17*

**Verdict: open.** Run the live test above first. If (b), promote to `fix/` at
high priority, because the Anthropic provider would 400 mid tool loop. If (a),
promote to `feat/` at normal priority (quality and continuity). Either way the
design question is the same: an opaque, provider-tagged `blocks` field on the
assistant `ChatMessage`, persisted, re-emitted only by the provider that
produced it.

### Orchestrator note — 2026-11-25 ~19:50 (gate after s4)

The script gate after s4 was red on ONE test: `serve-log-store.test.ts` «S11 — a real SIGKILL at random points … 200 kills»
(`Received: "loads 0; "`). Known intermittent: it failed the same way on 2026-11-25 02:25 on feat/workflow-editor (no
reasoning-echo code). Alone: 1/9 fail on this branch (92f258c9), 0/6 on main b8d4d916, under load (an e2e gate was running).
Not attributed to s4 (s4 touches agent.ts + proxy-model.ts, not the log store). Reviewer: confirm the branch's
`session-log.ts` change cannot cause it (e.g. run S11 ×20 here vs main).

*— claude-opus-5-5 (orchestrator), 2026-11-25*

### s5 — V1–V2 bench + resume check

**Load-bearing check (re-run):** `bun test packages/agent/test/reasoning-echo.test.ts
packages/providers/test/reasoning-echo-{openai,anthropic}.test.ts` → 27 pass, 0 fail.
The four links hold in code (T1 e2e green).

**Status: s5 PARTIAL — BLOCKED, nothing measured.** V1 needs the external bench
(`~/github/gmeghnag/harness-compare`, stale-taskrun prompt-c cap50k, logging proxy,
live DeepSeek/Qwen runs and keys). That directory is outside this session's allowed
working dirs (listing refused), and the bench needs live models/credentials the
executor sandbox does not have. V2 (real `--resume` against a live model) needs the
same. No bench numbers, no proxy `echoed` counter, no per-turn MAX reasoning size
were produced; none are invented here.

**Decision needed (owner/orchestrator):** run V1/V2 from the orchestrator shell (which
has the bench dir and keys), or grant this executor access to the bench directory and
the DeepSeek/Qwen profile. The resume path is covered at unit level by s1/s4 tests
(persistence.test.ts), not by a live run.

No code changed in s5; no changelog fragment written (the s1–s4 slices own it, and
s5 adds no user-visible change).

*— claude-sonnet-5-5, 2026-11-25*

### Review — fresh-context adversarial, s1–s5 (`git diff main...HEAD`)

**Verdict: REQUEST-CHANGES** — two MEDIUM findings, both in the D9 fallback
(`openai-provider.ts`); everything else holds.

**Findings**

1. **MEDIUM — D9 latches echo OFF for the process on a 400 it did not cause**
   (`packages/providers/src/openai-provider.ts:330-336`). The retry drops the
   reasoning, so the body gets SMALLER. A 400 for another cause that a smaller
   body fixes (llama.cpp's context-overflow 400 near the limit) makes the retry
   succeed and sets `reasoningEchoRefused = true`. On the long-lived `serve`
   daemon the echo is then silently off until restart: the ×3/×15 regression
   this task fixes comes back with no trace. That is the class the F9 comment
   at :321-325 warns against. It also falsifies the failure-mode row "a 400 for
   another cause … latches nothing". Repro (`.tentacle/tmp/reasoning-echo/d9-latch.ts`,
   a fake endpoint that 400s when the body is over 600 B): near-limit turn
   `[[652, echo], [329, no echo]]`, then a small later turn `echoes? [false]`.
   Fix direction: latch only on evidence that names the field (the 400 body
   mentions `reasoning_content`/`reasoning`), or don't latch (per-request
   fallback); and report the latch (`onRetry`/log), so it is never silent.
   Add a red test for it.
2. **MEDIUM — a voice turn now FAILS where main succeeds, and keeps failing**
   (`openai-provider.ts:320-336`). Take an endpoint that 400s on both the F9
   switches and the echoed field, with a history that holds this provider's
   own record. The calls go: (off+echo) 400 → F9 (echo) 400, so
   `reasoningSwitchesRefused = false` → D9 `off = wantOff && !false = true` →
   (off, no echo) 400 → throw. Nothing is latched, so EVERY later voice turn
   fails the same way (a voice-only phone session never converges). On main
   the same turn is OK after 2 requests. Repro (`.tentacle/tmp/reasoning-echo/d9-voice.ts`):
   branch `voice turn 1: FAILED after 3 requests`, `voice turn 2: FAILED after 3`;
   no-record history `OK after 2`. This breaks D9's "never a failed turn".
   Fix direction: once both single drops have 400ed, make one last attempt
   with neither (or try the combinations in a fixed order); add a test that
   rejects both.

**Gate (this worktree, a4c05fe7):** `bun run test` → **19115 pass, 5 skip, 0 fail**
(1329 files, 58 s; the diff adds no skip). `bun run typecheck` clean.
`bun run lint` clean (2536 files). The 11 touched test files → 271 pass, 0 fail.

**Mutation (§9)** — six mutations applied together, each caught by its own
test (15 fails total), then reverted; `git status` clean, tree byte-identical:
loop push without `echo` (agent.ts) → T1 ×4 fail. `toWireRequest` without
`reasoning` (proxy-model.ts) → T5 ×4 fail. Anthropic source check removed →
"another source … not sent" fails. D9 latch forced `true` → "400 for another
cause is not latched" fails. `.catch(undefined)` removed from `chatMessageShape`
→ 3 fail-soft tests fail. `countReasoning` → 0 → both token-counter tests fail.

**Premises checked (TRUE):** provider ids are model-scoped
(`anthropic-provider.ts:126`, `openai-provider.ts:208`; the `RetryingModelProvider`
passes `inner.id` through, `retry.ts:174`), so D5 really keys on the model.
`canonicalMessage` (`session-log.ts:804`) does not hash `reasoning`, so the
digests and checkpoints already on disk stay valid. The log entry builders
(`session-log.ts:673-689`) pass the whole message, and no site copies `thought`
field by field, so the record reaches `session/log` and the laptop store with no
missed copy site. The laptop's `onModelStream` (`remote-client.ts:4625`) passes
the request and the events through whole, so the record crosses both ways.
`mark()` (`anthropic-cache.ts:57`) marks the LAST block, and reasoning is never
last (a reasoning-only message is dropped), so P8 holds.

**Attacks tried:**
- Pod forging a record with the laptop's provider id: no new trust edge. Its
  content is pod-controlled text like `content`; a forged signature 400s only
  its own turn; it is bounded and fail-soft. §7 holds.
- The S11 flake (orchestrator note): the branch's `session-log.ts` change is
  **type-only** (erased at runtime), so it cannot cause S11. The S11 test is
  green in the gate run above.
- Anthropic dormancy: the provider never sends a `thinking` param, so today
  the Anthropic echo fires only for models that think by default. The
  interleaved-order risk stays the documented residual (V3 did not observe it).
  Not a finding.
- Token count: Anthropic signatures are not counted, yet V3 shows an omitted
  block costs ~190 prompt tokens. The heuristic is re-anchored by real usage,
  so this is a nit, not a finding.
- `openai:${model}` leaves out `baseURL`: two endpoints serving the same model
  name share a source. The record is text only, so this is harmless.

**s5:** V1/V2 were not run (blocked on bench access); the resume path is
covered at unit level only. Live proof of the fix still needs the
orchestrator's V1.

**Executor behaviour:** clean, narrow diffs, honest Execution notes (s5 says
openly that nothing was measured). Tests are non-vacuous. The D9 tests cover
only one cause per endpoint, which is why both findings slipped.
Reviewer is the same model family as the s1/s3/s4 executor (fresh context only).

*— claude-opus-5-5, 2026-11-25*

### Round 2

**Verdict: PASS** (commit 157e1b62, `git diff HEAD~1`).

- **Finding 1: fixed.** The echo latch now needs the retry to succeed AND the
  400 body to name the field (`namesEchoField`, `openai-provider.ts:685`).
  `\breasoning(_content)?\b` does not match `reasoning_effort`. Round 1's
  repro `d9-latch.ts` now prints `later small turn echoes? [true]`.
- **Finding 2: fixed.** When both single drops 400, one last try goes out with
  neither (`openai-provider.ts:340-347`). It differs from the refused request
  only in the switches, so latching `reasoningSwitchesRefused` on it is sound
  F9 evidence. `d9-voice.ts` now prints: turn 1 OK after 4 requests, turn 2 OK
  after 2. main took 2.
- **Mutation:** each mutation was applied alone, then reverted (tree clean).
  - Latch on `res.ok` only → the overflow test fails.
  - Last try removed → the both-refuse test fails.
  - `namesEchoField` forced to false → "latched only after it succeeds" fails.
- **Gate:** `bun test packages/providers` → 246 pass, 0 fail. `bun run
  typecheck` clean. `bun run lint` clean (2536 files).
- **Regressions checked:** the body read for D9 is always the 400 of a request
  without the switches (F9 retries first), so the switches cannot name a false
  echo refusal.
- **Nit, accepted trade-off:** some endpoints refuse the field with a body that
  does not name it. On those the echo never latches. Each such request pays
  one extra 400 round trip, but the turn never fails.

*— claude-opus-5-5, 2026-11-25*
