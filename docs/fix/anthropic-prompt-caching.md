# fix/anthropic-prompt-caching — Prompt caching for the Anthropic provider

> **Status:** execution
> **Branch:** `fix/anthropic-prompt-caching`
> **Size:** S–M · **Blast:** cross-module (Anthropic provider) · **Suited:** weaker model + standard Review
> **Changelog:** `changelog.d/anthropic-prompt-caching.fixed.md`

## Context

*— claude-sonnet-5-5, 2026-11-25*

Live test T1.9 (`.tentacle/tmp/anthropic-tests/RESULTS.md`): tentacle sent no `cache_control`, so `cache_read_input_tokens = 0` on every one of ~70 requests while the fixed prefix (system prompt + tool definitions) is ~20.7k tokens. Every round of every turn paid the full prefix. With `cache_control` by hand (T1.9b) caching worked.

**Repro:** main binary, any multi-round task via the tap → `usage.cache_read = 0`, `input ≈ 20.7k` on every request.

## Implementation

*— claude-sonnet-5-5, 2026-11-25*

- **Load-bearing assumption:** the API caches the prefix in order tools → system → messages up to each breakpoint (max 4). Proven live (below).
- **Preconditions:** `buildPayload` (`anthropic-provider.ts`) emits `system` as one joined string, `tools` in `req.tools` order, messages in history order. Audit: no timestamps/ids in the system prompt or tool definitions (`grep Date` over agent/cli/tools system-prompt code finds none); tool order is the registry's fixed order. Live run confirms the prefix is stable (round 2 reads the full 20741 tokens written by round 1).
- **Design:** pure module `packages/providers/src/anthropic-cache.ts` (`applyCacheControl`) applied in `stream()` only after `buildPayload`: breakpoint 1 = the end of `system` (string → one text block; with no system, the last tool), covering tools+system; breakpoint 2 = last block of the last message (string content → text block), so round N+1 reads round N's prefix. 2 of 4 breakpoints used. `buildPayload` and `count_tokens` are unchanged; the OpenAI provider is untouched.
- **Minimum cacheable prefix:** a prefix below the model's minimum is silently not cached by the server (no error, no surcharge); the real prefix is ~20k, far above it.
- **Compaction / `context_reset`:** they rewrite the history, so the message breakpoint misses once (a cache write of the shorter history); the tools+system breakpoint still hits.
- **Failure modes:** empty messages/content → no breakpoint, no crash; no system and no tools → only the message breakpoint; content > 20 blocks between breakpoints is not an issue (a round adds ≤ a few messages).
- **Files:** `packages/providers/src/anthropic-cache.ts` (new), `anthropic-provider.ts` (call in `stream`), `packages/providers/test/anthropic-cache.test.ts`.
- **Tests:** exact request shape (system block, last block only, no-system case, empty), body through `AnthropicProvider.stream` with injected `fetch` (2 breakpoints; tools+system byte-identical across rounds; `buildPayload` stays clean).

## Execution

*— claude-sonnet-5-5, 2026-11-25*

Done as planned, no drift. Red: with the `applyCacheControl` call commented out the stream test fails (1 fail), restored → 5 pass; `anthropic-provider.test.ts` still green (31 pass total); typecheck clean.

**Live (claude-haiku-5-5, binary built from this worktree, 3-round headless task through the tap):**

| round | input | cache_creation | cache_read | $ |
|---|---|---|---|---|
| 1 | 4 | 20741 | 0 | 0.002620 |
| 2 | 2 | 89 | 20741 | 0.000245 |
| 3 | 2 | 69 | 20830 | 0.000253 |

Before: every request ≈ 20.7k uncached ≈ $0.00208+ (T1.10 rows). Measured saving per follow-up request ≈ **88%** (0.00208 → 0.00025); round 1 pays a one-time 1.25× write surcharge (+$0.0005). Fix cost $0.0031, ledger rows in `LEDGER.md` (cap $0.30).

## Review

*— pending (fresh context)*
