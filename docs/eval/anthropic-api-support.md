# eval/anthropic-api-support — add a native Anthropic Messages API provider?

> **Status:** eval (Context + Review; direct-to-`main`, no branch; Implementation empty until promoted)
> **Prospective work (if promoted):** Type: `feat` · Size: M · Blast: cross-module (a new `ModelProvider` impl + provider selection in config/wiring + its own SSE parsing; no change to the agent loop or protocol) · Suited: strong model + standard Review.

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

*(empty — an eval is not built until promoted to a `feat`.)*

## Execution

*(empty.)*

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

**Promotion trigger:** on the owner's OK to build, `git mv` this doc to
`docs/feat/anthropic-api-support.md` and open branch `feat/anthropic-api-support`
then (per §10).

**What would change the recommendation:** if the only real need is "point at a
Claude endpoint" with no tool-use/caching fidelity requirement, the OpenAI-compat
shim (a `baseURL`, zero code) already covers it — then defer the native provider.
