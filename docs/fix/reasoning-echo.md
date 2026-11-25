# fix/reasoning-echo — send the model's own reasoning back to it, in every provider's format

> **Status:** implementation — **NOT approved** (owner questions Q1–Q5 open)
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
different purpose, so whether to persist it is asked again (Q1). The display
rule is unchanged unless the owner says otherwise (Q4).

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

*— claude-opus-5-5, 2026-11-25* — **NOT approved** (Q1–Q5 below)

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
  counts as such a half-load is Q5.
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

**D6 — echo scope** follows Q2. The recommended option is *always*:
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
- Q3 asks whether anything more (a cap, or pruning old turns' reasoning) is
  wanted.

**D8 — wire (protocol, additive, no `protocol.d` note).**
- `chatMessageShape` gets `reasoning: ReasoningRecordSchema.optional().catch(undefined)`.
  It is FAIL-SOFT like `thought`: a malformed or oversized value is DROPPED and
  the critical `message` entry still loads.
- Bounds: `source` ≤ 256 chars. Each text/data ≤ 1 MiB, blocks ≤ 64 (sizes to
  confirm in S1 against real DeepSeek turns: 6.3k ch/turn average, the max
  observed far below).
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
  (thought-placeholder, binding), unless Q4 says otherwise.

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

No TUI or mobile change (D10, if Q4 = A).

### Failure modes

| case | what happens | how it converges |
|---|---|---|
| Huge reasoning vs the context window | Counted in the estimate (D7). Prune and compaction fire on real size. Compaction drops it (P5). | The next request fits. Never a silent overflow. A single message over the schema bound is dropped from the persisted copy (fail-soft) and echo is lost for that message only. Q3 decides whether to cap. |
| Server rejects the unknown field (400) | D9: one retry without it, latched only on success. | The turn continues as today. A 400 for another cause fails both bodies and latches nothing. |
| Model switch (`--resume` under another profile, a pod's laptop on another model) | D5: not sent (source ≠ id). | History keeps it. A switch back echoes again. |
| Old session file without the field | Loads as today, nothing echoed for old messages. | New rounds carry it. |
| Older build reading a new file | Strips the field (P2) and loads; no echo. If that build rewrites the segment, the reasoning is gone from the file. | Accepted under Q5 = A. Q5 = B makes the older build refuse instead. |
| Pod / untrusted reasoning (AGENTS §7) | A pod can already put any text in `content` of the history it sends. `reasoning` adds no new trust edge to the model. The laptop stores it only as part of a validated message (bounded, fail-soft). | A forged Anthropic signature only 400s the pod's own turn. No laptop-side effect: no approval, no I/O. |
| Secrets in reasoning | Reasoning can quote tool output. Redaction (`agent/src/redact.ts`) runs before tool output enters the history, so the model saw masked text. Reasoning already crosses RPC live (P4), and tool output with the same content is already persisted. | No new exposure class on disk if Q1 = persist. With Q1 = memory-only, none at all. |
| Cut stream / abort mid-reasoning | No `done` record (D4). Anthropic drops unsigned blocks (D2). | That round is not echoed. Never an invalid block. |
| `display: "omitted"` (empty thinking + signature) | Kept and echoed verbatim (D2). | As the API asks. |
| Thinking interleaved with text inside ONE Anthropic message | D3 re-emits all reasoning blocks first. Original positions are not kept. | Residual risk. The live Anthropic check (V3) decides. If it 400s, add per-block positions (S4 follow-up, contained). |
| Sub-agent | Its own `Agent` + history: covered by the same code. The parent never sees the child's reasoning. | Nothing to do. |
| Phone / TUI load size | `session/log` carries the text (D10). It is about 6k ch per round on bad runs, ~1k with echo. | Q4 C would strip it for display clients. |

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
  the resume carries the earlier reasoning (only under Q1 = persist).
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
(P2/Q5), the pod wire (P3) and D5.

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

SLICES: s1=opus s2=sonnet s3=opus s4=opus s5=sonnet

## Execution

*(empty until Implementation is approved)*

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
