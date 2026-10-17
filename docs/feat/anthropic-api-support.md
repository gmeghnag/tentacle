# feat/anthropic-api-support — a native Anthropic Messages API provider

> **Status:** done — approved by review #3 (fresh context, claude-fable-5-1); follow-ups applied; merged 2026-10-17
> **Branch:** `feat/anthropic-api-support`
> **Type:** `feat` · **Size:** M · **Blast:** cross-module (a new `ModelProvider` impl + provider selection in config/wiring + its own SSE decoding; no change to the agent loop, protocol, or persistence) · **Suited:** strong model + standard Review.
> **Promoted from** `docs/eval/anthropic-api-support.md` (2026-10-17, recommended: yes — native over a shim).

## Context

*— claude-opus-4-8, 2026-10-17*

**The question being decided:** should tentacle gain a **native Anthropic Messages
API** provider (`POST /v1/messages`), alongside today's single OpenAI-compatible
provider — and if so, native adapter vs leaning on an OpenAI-compat shim?

**Evidence (verified).**
- **One provider exists today:** OpenAI-compatible, hitting `/v1/chat/completions`
  — `packages/providers/src/openai-provider.ts:4,125` (`index.ts:5` documents the
  target endpoint). SSE parsing lives in `packages/providers/src/sse.ts`.
- **The seam is already abstracted:** the `ModelProvider` interface
  (`packages/core/src/model.ts`) is `stream(request: ChatRequest):
  AsyncIterable<StreamEvent>`. A second provider is **additive** — another impl
  behind the same interface; the agent loop (`agent.ts`) consumes `StreamEvent`s
  and never names a concrete provider.
- **The pod reverse-tunnel rides the same seam:** `ProxyModelProvider`
  (`cli/src/serve.ts`) is itself a `ModelProvider`, and the local provider is the
  one it proxies. An Anthropic provider plugs in at the same place, so the §7
  "model stays on the laptop" invariant holds unchanged — no pod/image creds.
- **Provider construction is centralised:** the concrete provider is built in
  `cli/src/wiring.ts`, so provider *selection* is one place to extend.

**Why this is a real adapter, not a drop-in.** The Anthropic Messages API differs
from OpenAI chat-completions in shape, so a native provider needs a bidirectional
mapping `ChatRequest ⇄ Messages API` and an Anthropic-specific SSE→`StreamEvent`
decoder:
- **Request:** `system` is a top-level field (not a `role:"system"` message —
  note tentacle's single-system-message design, which maps cleanly); messages
  carry **content blocks**; tool definitions use Anthropic's `input_schema`.
- **Tool calling:** Anthropic emits `tool_use` content blocks and expects
  `tool_result` blocks back — different from OpenAI's `tool_calls` / `role:"tool"`.
  The `ChatRequest`/`StreamEvent` tool contract must map both directions.
- **Streaming:** Anthropic SSE events (`message_start`, `content_block_start`,
  `content_block_delta`, `message_delta`, `message_stop`) differ from OpenAI's
  delta chunks — a separate parser from `sse.ts`'s current shape.
- **Headers/versioning:** `x-api-key` + `anthropic-version`; optional
  prompt-caching (`cache_control`) and extended thinking are Anthropic-only.

## Implementation

*— qwen3.8-27b-q6, 2026-10-18*

> *Line cites refreshed against the post-fix tree and one false premise
> corrected (marked inline). Review #3, finding 5. — claude-opus-5-5, 2026-10-17*

The eval's verdict stands: **add a native Anthropic provider behind the existing
`ModelProvider` seam**. This section is that plan, verified against the source.

### Load-bearing assumption

The change stands or falls on **the `ChatRequest`/`StreamEvent` contract being
provider-agnostic enough to carry Anthropic semantics losslessly in both
directions**. Proven:
- `ModelProvider.stream(request: ChatRequest): AsyncIterable<StreamEvent>` —
  `packages/core/src/model.ts:56-61`; `ChatRequest` carries `messages`
  (`system|user|assistant|tool`), `tools`, `temperature`, `maxTokens`, `signal`
  (`model.ts:48-54`). `StreamEvent` is `text | reasoning | tool_call | done`
  (`model.ts:42-46`).
- **Round-trip check (both directions, the high-risk part from the eval):**
  - *In (request → wire):* tentacle's single-system-message design
    (`agent.ts:137-139` seeds exactly one `role:"system"`; `compactedHistory`
    `compact.ts:96-100` preserves the leading one) maps to the top-level
    `system` string. `assistant.toolCalls` → `tool_use` blocks; `role:"tool"` +
    `toolCallId` → a **single** `user` message of `tool_result` blocks. The
    agent loop emits exactly one `role:"tool"` message per call
    (`agent.ts:300` `messages.push({role:"tool", content, toolCallId})`) — the
    grouping rule (consecutive tool messages → one user turn) is exact for this
    harness's history.
  - *Out (wire → events):* `text_delta`→`text`; `thinking_delta`→`reasoning`;
    `input_json_delta` accumulated per block → one `tool_call` per block at
    block close (id/name from `content_block_start`); `message_delta.usage`
    (final `output_tokens`) + `message_start.usage` (`input_tokens`) → `done`
    with `Usage`. Every Anthropic surface that matters maps onto an existing
    `StreamEvent` member — no core change needed.
- The one contract constraint: **`tool_call` events must carry the complete call
  (id+name+full arguments)** — `agent.ts:223` pushes each to the round's
  `toolCalls` and `runTool` does `JSON.parse(call.arguments)` (`agent.ts:420`).
  The provider therefore must *accumulate* `input_json_delta` per block and emit
  the `tool_call` on `content_block_stop` (not per delta). The OpenAI provider
  already does exactly this (assembler drains on `finish_reason`,
  `openai-provider.ts:171-173`).

### Preconditions

Verified invariants / facts the change relies on:
- **§7 "TUI always over RPC — one session path":** untouched — no new session
  path; a provider is data behind an interface.
- **§7 "Model stays on the laptop":** the pod reverse-tunnel (`cli/src/serve.ts`)
  proxies whatever local provider `wiring.ts` builds. Both pod construction sites
  (`pod-runtime.ts:269,452`) build the provider from `config`, so an Anthropic
  local provider tunnels identically — no pod/image creds.
- **§7 "Protocol changes are additive":** no protocol change at all.
- **The `OpenAIProvider` is built at FOUR sites**, all `new OpenAIProvider({
  baseURL: config.baseURL, model, ...apiKey })`: `cli/src/wiring.ts:74` (main),
  `wiring.ts:115` (sub-agent `modelFor`), `cli/src/pod-runtime.ts:269` (run),
  `pod-runtime.ts:452` (exec). The selection logic must therefore live in a
  **single factory** in `@tentacle/providers` so the four call sites share one
  rule (the eval's "one place to extend" — `wiring.ts` alone is not enough).
- **SSE plumbing is reusable:** `parseSSE` (`sse.ts`) yields every `data:`
  payload and is event-agnostic; the Anthropic provider consumes it and switches
  on the JSON `type` field (the docs confirm each event's `data` repeats its SSE
  `event:` name as a `type` field — `message_start`/`content_block_delta`/… per
  the live streaming docs).
- **Config is strictly typed:** `ModelConfigSchema` is `.strict()`
  (`config/src/schema.ts:10-37`); a new optional key is additive and a typo'd key is
  still a loud error.
- **`@tentacle/providers` depends only on `@tentacle/core`** (`providers/
  package.json`), and `@tentacle/config` depends on nothing in the repo — a
  factory taking primitive inputs (not `TentacleConfig`) in `providers` creates
  **no dependency cycle**.
- **Default must stay OpenAI:** `DEFAULT_BASE_URL = http://localhost:8080/v1`
  (`config/src/defaults.ts:5`) — existing local-stack users must not change
  provider by default.

### Design

**Additive, reuse-existing-seams (§7).** No change to `ModelProvider`, the agent
loop, the protocol, or persistence.

1. **`packages/providers/src/anthropic-provider.ts`** — `AnthropicProvider
   implements ModelProvider`, mirroring `openai-provider.ts`:
   - **Config:** `{ baseURL (…/v1), model, apiKey?, id?, fetch?,
     anthropicVersion? }`. Headers: `x-api-key`, `anthropic-version` (default
     `2023-06-01`, overridable for gateways), `content-type`. `POST
     ${baseURL}/messages`, `stream: true`.
   - **Request mapping** (`buildPayload`):
     - `system` = join of the leading `role:"system"` message(s) with `\n\n`;
       omitted when absent. Non-leading system messages are not produced by this
       harness (precondition above) — if one ever appears, fold it in too
       (defensive, still a string).
     - `messages`: `user`/`assistant` → `content` as a string, or content blocks
       when the assistant carries `toolCalls` (text block when `content !== ""`
       + one `tool_use` block per call, `id`/`name`/`input` = `JSON.parse` of
       `arguments`; invalid JSON degrades to `{}`. **Corrected premise:** the
       agent loop does NOT guarantee valid JSON. `agent.ts:418-423` catches the
       parse error and falls back to `{}`, so a broken body reaches history
       as-is).
       Consecutive `role:"tool"` runs → a single `user` message of `tool_result`
       blocks (`tool_use_id` = `toolCallId`, `content` = the result string).
     - `tools` → `[{ name, description, input_schema: parameters }]`.
     - `max_tokens` **required** by the API: `request.maxTokens ?? 4096`.
     - `temperature` passed through when set.
   - **Stream decode** (over `parseSSE`): a small stateful reducer keyed on the
     event `type`:
     - `message_start` → record `message.usage.input_tokens` (promptTokens).
     - `content_block_start` → open a block at `index` (`text` | `tool_use` (keep
       `id`,`name`) | `thinking`).
     - `content_block_delta` → `text_delta`→yield `text`; `thinking_delta`→yield
       `reasoning`; `input_json_delta`→append `partial_json` to the block's arg
       buffer (do NOT yield yet).
     - `content_block_stop` → if the block is `tool_use`, yield `tool_call`
       `{ id, name, arguments: <accumulated JSON> }` (empty string → `"{}"`).
     - `message_delta` → record `usage.output_tokens` (completionTokens);
       `delta.stop_reason` is informational (the stream always ends with a
       `done`; `tool_use` stop reason ⇒ the emitted tool_calls drive the loop).
     - `message_stop` → stop reading.
     - After the loop: `yield { type:"done", usage? }` with the recorded
       input/output tokens when both are present, else a bare `done`.
   - **Errors:** non-2xx → throw `ModelRequestError(status, body)` (reused from
     the OpenAI provider — it is the shared error type). In-band error events
     (`overloaded_error` / `error` event types mid-stream) → throw, not swallow
     (the eval's failure mode).
   - **Abort:** pass `request.signal` into `fetch` init (the OpenAI provider's
     existing path; `parseSSE` already returns on `signal.aborted`).
2. **`packages/providers/src/select-provider.ts`** — the single factory:
   `createModelProvider({ provider?, baseURL, model, apiKey? }): ModelProvider`,
   where `provider` is `"openai" | "anthropic"`. Defaults to `openai` when
   unset. This is the one rule shared by all four construction sites.
3. **`packages/providers/src/index.ts`** — export the new provider + factory.
4. **`packages/config/src/schema.ts`** — add `provider:
   z.enum(["openai","anthropic"]).optional()` to `ModelConfigSchema` (stays
   `.strict()`); export the inferred type.
5. **`packages/config/src/resolve.ts` + `load.ts`** — carry `provider` through
   with the same `pick()` provenance pattern (env `TENTACLE_PROVIDER` > file
   `model.provider` > default `openai`), incl. a `sources.provider` entry.
6. **`packages/config/src/defaults.ts`** — `DEFAULT_PROVIDER = "openai"`;
   document the new key in `DEFAULT_CONFIG_JSONC`.
7. **`cli/src/wiring.ts` + `cli/src/pod-runtime.ts`** — replace the four
   `new OpenAIProvider(...)` sites with `createModelProvider({ provider:
   config.provider, baseURL, model, apiKey })`.
8. **Docs (ride this branch):** README.md model line + config table + package
   table; ARCHITECTURE.md ADR-003 note (second native provider alongside the
   OpenAI-compat one); `cli/src/main.ts` env-var help; `TODO.md` entry → done.

**Shared source of truth:** the `ModelProvider`/`ChatRequest`/`StreamEvent`
contract in `@tentacle/core` (unchanged). Both wire formats normalise into it.

### Files

Smallest diff, dependency order:
1. `packages/providers/src/anthropic-provider.ts` *(new)*
2. `packages/providers/src/select-provider.ts` *(new)*
3. `packages/providers/src/index.ts` *(exports)*
4. `packages/config/src/schema.ts` · `resolve.ts` · `defaults.ts` · `load.ts`
5. `packages/cli/src/wiring.ts` · `packages/cli/src/pod-runtime.ts`
6. `packages/providers/test/anthropic-provider.test.ts` *(new)* ·
   `packages/providers/test/select-provider.test.ts` *(new)* ·
   `packages/config/test/resolve.test.ts` (+ provider precedence)
7. Docs: `README.md` · `ARCHITECTURE.md` · `cli/src/main.ts` (env help) ·
   `TODO.md`

### Failure modes

Not just the happy path — for each, how state converges (a silent drop is a bug):
- **tool_use ⇄ tool_call mismatch (the high-risk one):** a tool turn only
  continues if the provider emits a complete, parseable `tool_call` and the next
  request carries the matching `tool_result`. Covered by a dedicated round-trip
  test: assistant-with-toolCalls → wire `tool_use`, then wire `tool_result` →
  back to the harness shape; and a streamed `input_json_delta` sequence → exactly
  one `tool_call` with valid JSON. Non-vacuity by mutation: emit the
  `tool_call` *per delta* (not at block close) and the round-trip test must fail.
- **Truncated `input_json_delta`** (stream ends mid-JSON, e.g. abort): flush any
  open block's accumulated args as the `tool_call` at end-of-stream (the OpenAI
  provider already flushes on missing `finish_reason`, `openai-provider.ts:178-
  182`), so the agent loop sees a well-formed call and `runTool`'s `JSON.parse`
  falls back to `{}` on a genuinely broken body — the turn errors visibly, not
  silently.
- **`max_tokens` absent:** Anthropic 400s. Default `4096` when the request omits
  it; never send the request without `max_tokens`.
- **Non-2xx / in-band error (429/overloaded/529):** throw `ModelRequestError`
  (pre-stream) / throw on an `error`/`overloaded_error` stream event (mid-stream)
  — surfaced by the agent loop's existing error path, never swallowed.
- **Abort mid-stream:** `signal` → `fetch` + `parseSSE` early-return; the agent
  loop turns the resulting AbortError into the clean `cancelled` turn_end
  (`agent.ts:233-241`). Same path as OpenAI.
- **No `system` message** (rare) → omit the `system` field (valid). **Multiple /
  trailing system messages** → folded into the `system` string defensively.
- **`stop_reason: tool_use` with zero blocks parsed** (server quirk) → still
  yield `done`; the loop treats an empty round as a stall and nudges (existing
  behaviour), so it cannot hang silently.
- **Provider selection default / skew:** `provider` unset ⇒ `openai` (default
  unchanged); an unknown value is rejected at config parse (`.strict()` +
  `z.enum`), a loud error, not a silent fallback.

### Tests

Red-before-green is N/A (new capability, no buggy code) — the discipline here is
**pin the exact property, prove non-vacuity by mutation** (§9):
- **`anthropic-provider.test.ts`** — a fake `fetch` (mirroring
  `openai-provider.test.ts`) that returns a scripted Anthropic SSE transcript:
  `message_start`(usage.input_tokens) → text block (text_deltas) → tool_use block
  (`content_block_start` with id/name, `input_json_delta` split across 2+
  events) → `message_delta`(usage.output_tokens, stop_reason) → `message_stop`.
  Asserts: concatenated `text` equals the scripted text; the single `tool_call`
  has the right id/name and **valid accumulated JSON**; `done` carries
  `{promptTokens, completionTokens}` from both usage events. Plus: reasoning
  (`thinking_delta`) → `reasoning`; a non-2xx → `ModelRequestError`; an in-band
  `error` event → throw; abort mid-stream returns cleanly. **Mutation check:**
  emit the `tool_call` per `input_json_delta` (instead of at block close) → the
  "exactly one tool_call" assertion fails.
- **Round-trip (the load-bearing property):** build a `ChatRequest` from a
  history the agent loop would produce (system, user, assistant+toolCalls,
  tool) → `buildPayload` → assert wire `system` string, `tool_use` blocks, and a
  single `user` `tool_result` message; and decode a `tool_use` stream → re-encode
  its result → assert the harness round-trips. This is the test that kills the
  high-risk mapping bug.
- **`select-provider.test.ts`** — `provider` unset/`openai` ⇒ `OpenAIProvider`;
  `anthropic` ⇒ `AnthropicProvider`; wrong-shape config is rejected upstream
  (config test) — factory only branches on the enum.
- **`config/test/resolve.test.ts`** — `provider` precedence env
  (`TENTACLE_PROVIDER`) > file (`model.provider`) > default `openai`, incl.
  `sources.provider`; an invalid env value falls through (matching the existing
  `parseBool`-style fall-through pattern).

## Execution

*— qwen3.8-27b-q6, 2026-10-18*

As-built, in dependency order (matches Implementation):
1. `packages/providers/src/anthropic-provider.ts` *(new)* — `AnthropicProvider`
   + exported `buildPayload`. Drift: **two** mapping refinements vs the plan,
   both caught by the first test run (red) and fixed before green:
   - plain `user`/`assistant` turns send `content` as a **string**, not a
     one-element text-block array (simplest valid wire form; only tool-bearing
     assistant turns use content blocks) — the plan's `content.length > 0 ?
     content : ""` would have sent `[]`/`[text]` unnecessarily.
   - the `noUncheckedIndexedAccess` strictness (on in this repo) forced an
     explicit `event.index === undefined` guard on the three content-block event
     arms, and a combined `case` block for the three indexed events.
2. `packages/providers/src/select-provider.ts` *(new)* — `createModelProvider`.
   Drift: the `switch` with `case "openai" + default` tripped Biome
   `noUselessSwitchCase`; reduced to a single `if (provider === "anthropic")`
   guard (openai = default path, per the plan's stated rule).
3. `packages/providers/src/index.ts` — exports the provider + factory +
   `ANTHROPIC_DEFAULT_VERSION` / `ANTHROPIC_DEFAULT_MAX_TOKENS`.
4. `packages/config`: `schema.ts` (`provider: z.enum(["openai","anthropic"])`,
   still `.strict()`), `defaults.ts` (`DEFAULT_PROVIDER` + template line),
   `resolve.ts` (`TENTACLE_PROVIDER` > file > default, `sources.provider`,
   `parseProvider` mirroring the `parseBool` fall-through pattern), `load.ts`
   (passthrough on `TentacleConfig`).
5. `cli/src/wiring.ts` + `cli/src/pod-runtime.ts` — all **four** construction
   sites now call `createModelProvider({ provider: config.provider, ... })`;
   stale "OpenAI provider" comments updated.
6. Tests: `providers/test/anthropic-provider.test.ts` (stream decoding incl.
   merged usage, reasoning, non-2xx, in-band error, headers, abort-signal
   contract; 8 `buildPayload` mapping tests incl. the round-trip),
   `providers/test/select-provider.test.ts`, `config/test/resolve.test.ts`
   (+precedence, +schema rejection of unknown kind), `config/test/load.test.ts`
   (+passthrough file/env).
7. Docs on the branch: README (tagline, model line, config table, features,
   packages), ARCHITECTURE (layer 2, topology, ADR-003 reframed as
   "contract, multiple native wire formats"), `cli/src/main.ts` env help,
   TODO.md index entry (eval → feat, in progress). Also: the now-stale
   `@tentacle/core` `model.ts` header comment (named only the OpenAI adapter)
   reworded to name both wire formats — comment-only, no code change.

**Non-vacuity (§9):** mutation-confirmed — temporarily making the provider emit
the `tool_call` *per `input_json_delta`* (instead of at block close) makes the
"exactly ONE tool_call with full JSON" test fail (3 calls instead of 1);
reverted.

**Gate:** `bun run check` green — typecheck clean, lint clean (0/0 vs the §6
baseline), full suite **669 pass, 1 skip** (the opt-in live-k8s skip, not a
failure), 0 fail.

**Deliberately not done (per Implementation's scope boundary):** prompt
caching, extended-thinking config (the `thinking` *block* is decoded to
`reasoning` events, but no `thinking: {type:"enabled"}` request option is sent
— out of scope), multi-block/vision content, `anthropic-version` in config
(code-constant + header, gateway override via the provider config only).

**Post-review fix (Review finding 1):** the Implementation's "truncated
`input_json_delta` → flush at end-of-stream" failure mode was planned but not
implemented on the first pass — added the post-loop flush of open `tool_use`
blocks (`anthropic-provider.ts`, `toolCallEvent` helper) with a red-first test
(truncated transcript). Gate re-run: 670 pass / 1 skip / 0 fail.

**Post-review fixes (review #2, on the owner's OK):**

*— claude-opus-5-5, 2026-10-17*

Red-first: 4 new or changed tests in `anthropic-provider.test.ts` failed on the
pre-fix code (17 run: 13 pass / 4 fail), then passed after the fix. All changes
are in `anthropic-provider.ts`:
- `ANTHROPIC_DEFAULT_MAX_TOKENS` 4096 → **64000**. Requests always stream, and
  current models allow at least 64K output tokens.
- Completed tool calls are **held until the stop reason is known**. If the stop
  reason is `max_tokens` or `refusal` and a tool call is present, the provider
  throws `ModelRequestError` ("…the call was not run (max_tokens=N)") instead of
  emitting a truncated call.
- A `tool_use` block still open at end-of-stream now **throws** instead of
  being flushed. This replaces review #1's flush and its test.
- `buildPayload` drops an empty-text user/assistant turn with no tool calls.
  The API merges consecutive same-role turns, so dropping it is safe.
- Nits: removed the dead `overloaded_error` case and corrected the
  "consecutive user turns" comment.

Gate: `bun run check` green: typecheck clean, lint 0/0,
**672 pass / 1 skip / 0 fail**. The end-to-end repro (scratchpad
`anth-review.ts`) now fails loudly on a call truncated by `max_tokens`, and the
assistant message never reaches the history.

**Review-#3 follow-ups (owner's decisions, 2026-10-17):**

*— claude-opus-5-5, 2026-10-17*

- **Per-provider default `baseURL`** (review #3, finding 2). With
  `provider: "anthropic"` and no `baseURL`, the default is now
  `https://api.anthropic.com/v1` (`DEFAULT_ANTHROPIC_BASE_URL`, used in
  `resolve.ts`). The global default provider stays `openai` with
  `localhost:8080`, and an explicit `baseURL` always wins.
- **`model.maxTokens` / `TENTACLE_MAX_TOKENS`** (review #3, finding 3).
  Precedence is env > file > unset; the schema requires a positive int. It
  flows through `createModelProvider` into both providers at all four
  construction sites. Unset, the OpenAI payload still omits `max_tokens`
  (behaviour unchanged, pinned by a test) and Anthropic uses 64000.
- **Implementation line cites refreshed** and the false "guarantees valid JSON"
  premise corrected inline (review #3, finding 5).
- **Thinking blocks not echoed back** (review #3, finding 1). Deferred to
  `docs/eval/anthropic-thinking-echo.md`.

Red-first: 5 new tests (`resolve.test.ts` ×2, `select-provider.test.ts` ×2,
plus the import of the new default) failed before the change and pass after.
Gate: `bun run check` green, **676 pass / 1 skip / 0 fail**, lint 0/0. These
follow-ups were not re-reviewed by a different model. They are additive config
plumbing, and their behaviour is pinned by tests.

## Review

*— claude-opus-4-8, 2026-10-17 (recommendation; owner decides)*

**Recommendation: yes — add a native Anthropic provider, behind the existing
`ModelProvider` seam; prefer native over an OpenAI-compat shim.**

- **Why native over a shim.** Some gateways expose Claude through an
  OpenAI-compatible `/v1/chat/completions` surface, which would need *zero* new
  code (just a `baseURL`). But the shim loses fidelity exactly where Claude is
  strongest and where this repo cares: tool-use block semantics, prompt caching,
  and extended thinking. Since Claude is the **strong model in this repo's
  mix**, first-class support earns its keep. Keep the shim path available (it
  already works via the OpenAI provider + a `baseURL`) as the zero-cost fallback.
- **Shape (additive, §7/§8).** New `packages/providers/src/anthropic-provider.ts`
  implementing `ModelProvider` (mirror `openai-provider.ts`), + an Anthropic SSE
  decoder (mirror `sse.ts`); a provider-kind selector in config
  (`openai | anthropic`, with `baseURL`/key/version header) read in
  `cli/src/wiring.ts`. `ModelProvider`, the agent loop, and the protocol are
  **untouched** — the proof the seam was right.
- **Failure modes to design out (for the plan):** tool_use ⇄ tool_calls mapping
  **both directions** (the highest-risk part — a silent mismatch breaks tool
  turns); the distinct SSE event set + `message_delta` stop reasons mapped to the
  existing `StreamEvent` end states; `anthropic-version` header required; error
  body shape (429/overloaded) surfaced, not swallowed; mid-stream cancel reuses
  the existing abort path; prompt-caching headers optional and off by default.
- **Scope boundary.** Transport + streaming + tool mapping first. Prompt caching,
  extended thinking, and multi-block/vision content are separable follow-ups —
  do not bundle (keep it one legible branch, §10).

**Promotion trigger (met 2026-10-18):** the owner OK'd building — doc moved to
`docs/feat/anthropic-api-support.md` and branch `feat/anthropic-api-support`
opened (per §10); the Implementation section above is the approved plan.

**What would change the recommendation:** if the only real need is "point at a
Claude endpoint" with no tool-use/caching fidelity requirement, the OpenAI-compat
shim (a `baseURL`, zero code) already covers it — then defer the native provider.

### Adversarial review (2026-10-18, fresh-context subagent)

*— qwen3 sub-agent (same model family as the executor — a fresh *context*, not a
different model; per AGENTS §10 routing this is the weaker of the two options for
a cross-module task), 2026-10-18*

**Verdict: REJECT → APPROVED after one blocker fix** (see below).

**Gate (re-run by the reviewer, `bun run check`):** typecheck clean, lint clean
(255 files, 0/0 vs the §6 baseline), tests **669 pass / 1 skip** (opt-in
live-k8s) **/ 0 fail**, 2066 `expect()` calls — matched the Execution claim
exactly.

**Acceptance checks — all PASS:**
- Every provider construction routes through the factory: non-test grep finds
  `new OpenAIProvider`/`new AnthropicProvider` only in
  `providers/src/select-provider.ts:33,35`; `createModelProvider({provider:
  config.provider, …})` at `cli/src/wiring.ts:74,114` (main + sub-agent
  `modelFor`) and `cli/src/pod-runtime.ts:269,451` (run + exec). No stray site.
- `TentacleConfig.provider` flows `schema.ts` (`.strict()` + `z.enum`) →
  `resolve.ts` (`pick` + `sources.provider`) → `load.ts` passthrough; the
  schema rejects an unknown kind (pinned in `resolve.test.ts`).
- §7 invariants hold: the pod reverse-tunnel is provider-agnostic (traced
  `wiring.ts`/`pod-runtime.ts` → `createLocalRuntime({model, modelProvider})` →
  `RemoteClient.onModelStream`; `ProxyModelProvider` tunnels `ChatRequest`→
  events and never names a wire format); `summarizeText`/`summarizeConversation`
  and sub-agent `modelFor` are provider-agnostic. `agent.ts` consumes streamed
  `tool_call` (id/name/arguments) exactly as emitted (`agent.ts:223`, `:420`).

**Mutation non-vacuity (§9) — all confirmed, all reverted byte-identical:**
- emit `tool_call` per `input_json_delta` → "streams text, an assembled tool_use"
  FAILS (3 calls, expected 1);
- disable the `tool_result` collapse → "collapses consecutive tool results into
  ONE user tool_result message" FAILS;
- drop the `max_tokens` default → "maps tools to input_schema and always sends
  max_tokens" FAILS (3 tests total).

**Findings:**
1. **[BLOCKER — fixed in this review] Missing end-of-stream flush of open
   `tool_use` blocks.** The Implementation "Failure modes" promised: *"flush any
   open block's accumulated args as the `tool_call` at end-of-stream (the OpenAI
   provider already flushes on a missing `finish_reason`,
   `openai-provider.ts:164-169`)"* — but the code had no post-loop flush. A
   stream cut mid-JSON (no `content_block_stop`) would yield **zero** `tool_call`
   events → the agent loop ends the turn as `end_turn` with no tool result: a
   **silent drop** on this feature's single highest-risk path. Fix applied:
   extracted `toolCallEvent(block)` and added a post-loop `for (const block of
   blocks.values())` flush in `anthropic-provider.ts`, mirroring the OpenAI
   provider's drain. **Red-before-green:** the new test
   "flushes a tool_use block still open when the stream ends (no silent drop)"
   (a truncated transcript: no `content_block_stop`/`message_delta`/
   `message_stop`) **FAILED** with the flush disabled, passes with it; gate
   re-run green (**670 pass / 1 skip / 0 fail**).
2. **[Nit, accepted] `parseProvider` case-folds** (`resolve.ts`,
   `trim().toLowerCase()`) so `TENTACLE_PROVIDER=Anthropic` is accepted from
   env. Consistent with the file's existing `parseBool`/`parsePositiveInt`
   style (env is lenient, the schema is the strict file-side gate); left as-is.
3. **[Nit, accepted] In-band error message truncation**
   (`JSON.stringify(event.error ?? event).slice(0, 200)`) can clip the error
   `type` on a very long body. Matches the OpenAI provider's
   `body.slice(0, 200)` convention; the throw itself is correct and tested.
4. **[Observation, pre-existing — follow-up] `Agent` never sets `maxTokens` on
   `ChatRequest`** (main loop, final turn, `compact.ts`), so the Anthropic
   default `4096` is always what reaches the wire. Pre-existing (OpenAI omits
   `max_tokens` when unset — optional there, *required* on Anthropic, hence the
   default). Follow-up: plumb a `maxTokens` (e.g. from `contextWindow`) into
   `ChatRequest` so Anthropic completions aren't capped at 4096.

**What holds:** round-trip tool mapping (tool_use ⇄ tool_call, `tool_use_id`,
single-user-message grouping), `StreamEvent` decode (text/reasoning/tool_call/
merged usage), headers/`x-api-key`, non-2xx + in-band error throws,
abort-signal contract, config provenance, factory centralisation, and the §7
"model stays on the laptop" invariant.

**Executor behaviour:** clean mechanical apply, no drift or corruption. Both
disclosed drifts (string-not-array content; single `if` instead of `switch`)
are honest and justified. The one gap (finding 1) was *planned but not
implemented* — the plan text was the source of truth the code failed to meet,
not a silent scope cut.

**Scope:** `git status --short` shows only the task files (4 new untracked +
modified files, incl. the `docs/eval → docs/feat` rename = the promotion). The
pre-existing `TODO.md` "Block 8" hunk and the untracked `docs/eval/*.md` files
were present before this task (not counted as creep). Nothing else extraneous.

### Adversarial review #2 (2026-10-17, different model, fresh pass)

*— claude-opus-5-5, 2026-10-17*

**Verdict: REQUEST CHANGES → findings fixed (see Execution, "Post-review fixes").**
Final scope: 2 should-fix findings (1, 3). Finding 2 was downgraded to a design
nit after a second opinion, and the fix applied the fail-loud variant anyway.
**The same model reviewed and then fixed this code**, so this pass cannot
approve its own changes. A fresh-context re-review by a different model is
required before merge.

**Gate (re-run):** `bun run check` → typecheck clean, lint 0/0 (255 files),
**670 pass / 1 skip / 0 fail** — matches the Execution claim. All four
construction sites route through `createModelProvider`; config provenance and
the §7 "model stays on the laptop" path (pod is always `--model-proxy`,
`pod-runtime.ts:263,445`) hold. Repro script (throwaway):
`/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/anth-review.ts`.

**Findings:**
1. **[should-fix] `max_tokens` truncation is turned into a "valid" tool call and
   the model is never told why it failed.** `stop_reason` is ignored
   (`anthropic-provider.ts:165-171`) and the default cap is 4096
   (`:32`, `:305`) — the agent never sets `maxTokens` (review #1, finding 4), so
   every request is capped at 4096 output tokens. Repro (A/B): a `tool_use` whose
   JSON is cut by `stop_reason:"max_tokens"` yields
   `tool_call{arguments:"{\"path\":\"big.ts\",\"content\":\"line1\\nline2"}`; the
   model sees only `invalid JSON arguments for write`, and on the next request
   `parseArgs` rewrites its own call to `input: {}`. Any `fs_write` of more than
   ~12 KB can therefore never succeed and the model is likely to retry the same
   write in a loop. Fix direction: raise/plumb the cap (config or a much larger
   default), and on `stop_reason === "max_tokens"` with an open/just-closed
   `tool_use`, don't emit a call that looks valid — surface an explicit
   "output limit reached" error (or a tool error that says so).
2. **[downgraded to nit — fixed anyway] The review-#1 "blocker fix" is the wrong fix.**
   *Correction:* an unterminated JSON object is never valid JSON, so the flush
   could not run a wrong-but-valid partial call. The harm is smaller than first
   stated: `parseArgs` rewrites the call to `{}` in the history, and a
   transport cut looks to the model like its own error. Original text follows. Flushing a
   `tool_use` block that never received `content_block_stop`
   (`anthropic-provider.ts:182-191`) creates a tool call from truncated JSON.
   That is exactly the defect class documented in
   `docs/eval/sse-abort-truncated-toolcall.md`, which was already in the tree
   (review #1 noticed it and treated it as out of scope). The Anthropic API
   always ends a stream with `message_stop`; if it is missing, the stream was
   truncated and should **throw** ("stream ended before message_stop"), not
   turn into a guessed tool call. The test "flushes a tool_use block still open
   when the stream ends" locks in the wrong behaviour. (The "silent drop" claim
   is also overstated: an empty round triggers the existing continue-nudge,
   `agent.ts:271-277`.)
3. **[should-fix] An empty assistant turn is sent to the API as-is.** The agent
   loop can persist `{role:"assistant", content:""}`: on the third empty round
   (`agent.ts:244-248` after the nudges run out), or on the late-steer path
   (`:258-265`). `buildPayload` forwards it unchanged (repro C). The Messages
   API rejects empty content on any assistant message that is not the final
   one, so on the Anthropic provider such a session fails on every later
   request. That rejection comes from the API docs and was not tested against a
   live endpoint. Fix: drop (or replace with a placeholder) an empty-text
   assistant message that has no tool calls.
4. **[nit] A false precondition in Implementation.** The plan says "the agent
   loop guarantees valid JSON (`agent.ts:420`)". It does not: `:420` catches the
   parse error and falls back to `{}`. That false belief is why `parseArgs`
   quietly rewrites history (see finding 1). Related:
   `docs/eval/history-validity-invariant.md`.
5. **[nit]** `case "overloaded_error"` (`:175`) is dead code, because in-band
   errors arrive as `type:"error"` with the kind in `error.type`. The comment
   "the Messages API forbids two `user` turns in a row" (`:261-263`) is wrong:
   the API merges consecutive same-role turns. `provider: "anthropic"` alone
   still points at `http://localhost:8080/v1` and model `default`, with no
   per-provider defaults and no warning. The Status line at the top is stale
   ("Review pending").

**Not a finding (checked):** the abort test asserts a *rejection*
(`anthropic-provider.test.ts:412-446`), so it does not lock in the
`parseSSE` silent-return behaviour.

**How the models behaved.**
- *Executor (qwen):* good plan discipline. It cited the source, found all four
  construction sites (the eval had named only `wiring.ts`), recorded its drift
  honestly, and the mutation check is real. Weak points: it took on at least
  one false premise without checking it (finding 4), and it called
  `stop_reason` "informational" without asking what `max_tokens` does to a
  tool call (finding 1).
- *Reviewer #1 (qwen, same family):* procedurally sound: it re-ran the gate and
  ran three real mutations. But it (a) treated the plan text as the source of
  truth instead of attacking it, so it "fixed" toward a flawed failure-mode
  design (finding 2). (b) It wrote code during Review and then approved its own
  change; that is self-approval of the only change nobody else reviewed. (c) It
  noticed the 4096 cap but did not connect it to tool-call truncation. (d) It
  saw the sibling eval about truncated tool calls and dismissed it. In short, it
  ran the checks correctly but did not challenge the design, which is the
  "same model family reviewer" risk its own signature line warns about.

**Follow-ups (not in this branch):**
- **Thinking blocks are not echoed back.** On current models, thinking cannot
  be disabled (Opus 5.5). The API guidance is to pass `thinking` blocks
  (including progress-update blocks between tool calls) back unchanged.
  `buildPayload` drops them, so reasoning continuity across a tool loop is
  lost. No request fails because of this, but quality may suffer. This
  belongs to the deferred thinking scope.
- **`model.maxTokens` config knob.** An older model with an output cap below
  64000 will 400 on the new default. Make the cap configurable, or plumb it
  from `contextWindow`.

**Process note:** the working tree also contains the unrelated 2026-10-17 audit
(`docs/eval/*.md` ×9 + the `TODO.md` "Block 8" hunk). These must go to `main`
separately (eval carve-out, §10), not into this branch's commit.

### Adversarial review #3 (fresh context, 2026-10-17)

*— claude-fable-5-1, 2026-10-17*

**Verdict: APPROVE-WITH-NITS.** Independent check of the whole feature diff, with
special attention to the review-#2 fixes (the fixer was also the reviewer, so
those were effectively unreviewed). The committed scope is correct, the tests
are non-vacuous, the OpenAI path is untouched, and the §7 "model on the laptop"
invariant holds. Every remaining item is either a disclosed deferred-scope
follow-up or a doc-hygiene nit — none blocks merge.

**Gate (re-run, `bun run check`):** typecheck clean · lint clean (255 files,
0 fixes) · **672 pass / 1 skip / 0 fail**, 2071 `expect()` across 90 files.
Matches the review-#2 Execution claim exactly. The 1 skip is the opt-in
live-k8s skip, not a failure.

**Mutation non-vacuity (§9) — all 5 confirmed FAIL on the mutant, source restored
byte-identical (sha `a3b23597…`, `diff` clean after each):**
1. disable the `max_tokens`/`refusal` throw (`stream`, the `TRUNCATING_STOP_REASONS`
   guard) → "throws on stop_reason max_tokens with a tool_use" FAILS.
2. remove the empty-turn drop (`buildPayload`, `if (message.content === "")`) →
   "drops an empty-text assistant turn with no tool calls" FAILS.
3. flush instead of throw on an open `tool_use` block at end-of-stream →
   "throws when the stream ends inside a tool_use block" FAILS.
4. `ANTHROPIC_DEFAULT_MAX_TOKENS` 64000 → 4096 → "maps tools to input_schema and
   always sends max_tokens" FAILS (the hard-coded `.toBe(64000)` is the real pin;
   the header test uses the constant, so it is self-referential — not a pin).
5. emit `tool_call` per `input_json_delta` → "streams text, an assembled
   tool_use" FAILS (plus 2 collateral throw-tests). Confirms assembly-at-block-close.

**Premise table (Implementation + review-#2 fix notes, verified against source):**
- `ModelProvider.stream` / `ChatRequest` / `StreamEvent` contract — **TRUE** (the
  cited lines `model.ts:96-100/78-85/62-66` have **drifted**: the file is 61
  lines; the interface is at `model.ts:56-61`, `ChatRequest` `48-54`, `StreamEvent`
  `42-46`. Substance holds; cites stale).
- single leading system seed (`agent.ts:136-138`), one `role:"tool"` per call
  (cited `:304`, actual `:300`), `toolCalls.push` (cited `:223`, actual `:224`) —
  **TRUE** (minor line drift).
- "the agent loop guarantees valid JSON (`agent.ts:420`)" — **FALSE** (already
  review-#2 finding 4): `:419-423` catches the parse error and falls back to `{}`.
  `buildPayload`'s `parseArgs` repeats the false belief in a comment but handles it
  safely (returns `{}`). No functional bug; the plan text is wrong.
- OpenAI drain premise (`openai-provider.ts:157-160/164-169`) — **TRUE** (drift:
  actual drain `:169-173`, flush `:177-181`).
- config `.strict()` + `z.enum`, four construction sites via `createModelProvider`
  (`wiring.ts:74,114`, `pod-runtime.ts:269,451`), `DEFAULT_BASE_URL`,
  no-dependency-cycle — **TRUE** (pod cite `:450` is actually `:451`).
- review-#2 fixes: 64000 default (`:38`), hold-until-stop-reason + throw
  (`:200-218`), throw-on-open-block (`:200-207`), empty-turn drop (`:323-325`),
  dead `overloaded_error` removed / comment corrected (`:190`, `:293-294`) — all
  **TRUE** and mutation-confirmed above.

**Attacks tried (≥3, incl. the ones that found nothing):**
1. *Throw convergence through the real agent loop (main + sub-agent).* Traced it.
   `AnthropicProvider.stream` throws **after** all text is streamed but **before**
   any `tool_call` is yielded (throw sites are post-`parseSSE`-loop), so the agent
   loop's `for await` throws at `agent.ts:214`; `signal.aborted` is false → re-throws
   (`:241`); the assistant push at `:244` never runs, so **no partial assistant
   message or truncated call is persisted** — `Session.send`'s `finally` persists a
   history with only the user turn. Main path: the error surfaces to the client
   (loud). Sub-agent path: the throw escapes `subagent.ts:175` (no catch) and
   `task.ts` `execute` (no catch), then is caught by `ToolRegistry.execute`'s
   try/catch (`registry.ts:~78`) and becomes an `isError` tool result the parent
   reads — no crash, no hang (the parent's `EventQueue` still closes via
   `.finally`). **Result: holds, and is strictly *more* correct than the OpenAI
   provider**, which flushes truncated calls (the exact defect in
   `docs/eval/sse-abort-truncated-toolcall.md`). The lost streamed text is
   acceptable — the turn errored and will be retried. No finding.
2. *Dropping empty turns breaks API ordering (first-user / tool_result-after-tool_use /
   consecutive same-role).* Walked `buildPayload` against what the loop emits.
   Only empty-content `user`/`assistant` **without** tool calls are dropped; system
   is hoisted to top-level; assistant-with-toolCalls (even empty text) keeps its
   `tool_use` blocks; tool runs collapse into one `user` message and the collapse
   guard (`prev.role==="user" && Array.isArray(prev.content)`) correctly refuses to
   append a `tool_result` onto a plain string user turn. A dropped empty assistant
   between a tool_result-user and a next user just leaves two consecutive user
   turns, which the API merges. First message stays `user`; tool_result always
   follows its tool_use. **Result: holds. No finding.**
3. *64000 safe across configurable models?* Checked the Claude API reference:
   64000 is **Anthropic's own recommended `max_tokens` default for streaming
   requests**, and every current model (Fable 5/5.1, Opus 5.5/5/4.8/4.7/4.6,
   Sonnet 5.5/5/4.6, Haiku 5.5) supports up to **128K** output — so the review-#2
   choice is safe for all current models (validates the fix). Only genuinely old
   Anthropic models (Haiku 4.5 / Claude 3.x, caps 4096–8192) would 400. →
   **Finding 3 (nit).**
4. *Thinking blocks not echoed → 400 with tool use?* Current models run **adaptive
   thinking always-on** even when `thinking` is omitted (which `buildPayload`
   always omits), so the model does think; `display` defaults to `"omitted"`, and
   tentacle never persists a thinking block into `ChatMessage`, so none is ever
   echoed back. Whether reconstructing assistant+tool_use turns **without** the
   preceding thinking block is rejected (400, "preserved thinking" history-editing
   check, enforced for accounts created on/after 2026-08-31 on some platforms) or
   is only a quality/continuity loss **could not be determined from the code or the
   bundled docs** — it is account-creation-date and platform dependent and needs a
   live endpoint to settle. → **Finding 1 (deferred, unverifiable).**
5. *OpenAI path byte-for-byte unchanged?* `git diff` of
   `packages/providers/src/openai-provider.ts` and `sse.ts` are **empty**; only
   `index.ts` (3 new exports) + the 4 new files changed in the package. **Holds.**
6. *Full stream-event / stop-reason contract (f).* `message_start`→input usage;
   `content_block_start/delta/stop`→blocks (text/thinking/input_json;
   `signature_delta` ignored = thinking-integrity, correctly unsurfaced);
   `message_delta`→output usage + stop_reason; `message_stop`→break; `error`→throw;
   unknown types (`ping`, keep-alive) fall to `default: break` = ignored
   (correct). Stop reasons: `end_turn`/`tool_use`/`stop_sequence` normal;
   `max_tokens`/`refusal` throw **only when a tool call is present** (see Finding 4);
   `pause_turn`/`model_context_window_exceeded` fall through to a bare `done`
   (edge, out of scope). **One gap → Finding 4.**

**Findings (none blocking the committed scope):**
1. **[nit — deferred thinking scope, unverifiable] Thinking blocks are never
   echoed back and thinking is always-on on current models.** Could be a hard 400
   on tool-loop turns for certain accounts/platforms (preserved-thinking check) or
   merely reasoning-continuity loss — not determinable statically (needs a live
   endpoint + known account). Explicitly in the deferred `thinking` scope and
   disclosed by review #2. Pin before enabling Anthropic as a tool-loop default.
2. **[nit] No per-provider config defaults.** `provider: "anthropic"` alone still
   resolves `baseURL=http://localhost:8080/v1`, `model="default"`, no key
   (`resolve.ts`), so it fails against the wrong endpoint until the user also sets
   `baseURL`/`apiKey`. Failure is loud (connection/4xx) but not self-explanatory.
3. **[nit] 64000 default has no config escape for old models.** The agent never
   sets `ChatRequest.maxTokens` (verified: the only `maxTokens` reference outside
   tests is the type decl, `model.ts:52`), so every Anthropic request sends 64000.
   Safe for all current models (Anthropic's recommended streaming default, 128K
   caps) but an older Anthropic model (<64K output cap) 400s on every request with
   no config-only fix. The follow-up (a `model.maxTokens` knob / plumb
   `contextWindow`) is already recorded.
4. **[nit] A `max_tokens` stop *without* a tool call silently truncates text.**
   The throw only fires when `toolCalls.length > 0`; a text-only response cut by
   `max_tokens` ends as a normal `end_turn` with no signal. Matches the OpenAI
   provider (which ignores `finish_reason:"length"`), so not a regression.
5. **[doc nit] Implementation line-cites have drifted** (`model.ts:96-100` →
   file is 61 lines; `agent.ts:304` → `:300`; `pod-runtime.ts:450` → `:451`), and
   the "agent loop guarantees valid JSON (`agent.ts:420`)" premise is false (it
   catches and falls back to `{}`). Cosmetic — the code is correct regardless.

**What holds:** round-trip tool mapping (`tool_use` ⇄ `tool_call`, `tool_use_id`,
single-user-message collapse), `StreamEvent` decode (text/reasoning/tool_call/
merged usage), `x-api-key`/`anthropic-version` headers, non-2xx + in-band `error`
throws, abort-signal contract, config provenance (env > file > default, `.strict()`
+ `z.enum` rejects unknown), factory centralisation across all four sites, the §7
"model stays on the laptop" invariant, and — notably — fail-loud truncation
handling that is more correct than the incumbent OpenAI provider.

**How each prior model behaved.**
- *Executor (qwen):* disciplined, source-cited plan; honest drift notes; a real
  mutation check. One carried-forward false premise (the valid-JSON guarantee),
  and it labelled `stop_reason` "informational" without probing `max_tokens` on a
  tool call — both later caught.
- *Reviewer #1 (qwen, same family):* ran the gate and three real mutations, but
  wrote code during Review (the end-of-stream flush) and approved its own change,
  and that flush was toward a design review #2 later replaced with a throw. Did
  not connect the 4096 cap to tool-call truncation. The "same-family reviewer"
  weakness its own signature warned about.
- *Reviewer #2 / fixer (opus):* found the substantive defects (max_tokens
  truncation masquerading as a valid call; empty assistant turns) and fixed them
  cleanly, red-first. It **initially overstated** finding 2 (claimed the flush
  produced a "wrong-but-valid partial call" — impossible, since unterminated JSON
  is never valid) and **correctly downgraded** it to a nit after a second opinion,
  applying the fail-loud throw anyway. The 64000 default it chose matches
  Anthropic's recommended streaming default — a good call, not a guess. Its fixes
  are confirmed non-vacuous here (mutations 1–4). Because it reviewed and fixed the
  same code, this pass (different model, fresh context) is the required independent
  check; it stands.

**Scope:** `git status --short` shows only this task's files (4 new untracked +
the modified config/cli/core/providers files). The untracked `docs/eval/*.md` and
the `TODO.md` "Block 8" hunk are the unrelated pre-existing audit (not creep).
No source, test, or config file was permanently changed by this review (provider
source sha `a3b23597…` unchanged; all mutations reverted and diff-verified).

*— claude-fable-5-1, 2026-10-17*
