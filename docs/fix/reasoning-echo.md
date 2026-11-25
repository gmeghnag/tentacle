# eval/anthropic-thinking-echo — echo Anthropic `thinking` blocks back on the next request

> **Status:** context (open question; not built)
> **Type:** eval · **Prospective work (if promoted):** Type: `feat` · Size: M · Blast: cross-module (provider decode/encode + a lossless place to carry provider-specific blocks in `ChatMessage`, persisted in the session file) · Suited: strong model + fresh-context Review by a different model.

## Context

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

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-17*

**Verdict: open.** Run the live test above first. If (b), promote to `fix/` at
high priority, because the Anthropic provider would 400 mid tool loop. If (a),
promote to `feat/` at normal priority (quality and continuity). Either way the
design question is the same: an opaque, provider-tagged `blocks` field on the
assistant `ChatMessage`, persisted, re-emitted only by the provider that
produced it.
