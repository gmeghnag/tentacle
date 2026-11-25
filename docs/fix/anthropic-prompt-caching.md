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
- **Failure modes:** empty messages/content → no breakpoint, no crash; no system and no tools → only the message breakpoint; the API looks back ~20 content BLOCKS from a breakpoint, and a wide parallel round adds more (text + N tool_use + N tool_result) — superseded by Fix round 1 (third breakpoint on the previous user message).
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

### Fix round 1

*— claude-sonnet-5-5, 2026-11-25*

- **M1 (one-shot writes never read):** `applyCacheControl` skips the message breakpoint when the payload has a single message (compaction summary, tool-output summary, title); tools+system keep theirs.
- **M2 (20-block lookback):** a third breakpoint on the last block of the previous user message (= the previous request's last message), so round N+1 hits round N's entry whatever the round's width. Now up to 3 of 4 breakpoints.
- **LOW 3 (documented):** besides compaction/`context_reset`, these also rewrite the prefix, each a one-time miss by design: `contextPrune`, old-image projection at turn boundaries, capability toggles (`projectTools`), and the voice spoken line (joins into `system`, so a voice↔text switch also misses tools+system; no tools-only breakpoint was added).
- **Tests (`anthropic-cache.test.ts`, 7 pass):** one-shot → system only; 12 parallel calls → exactly one breakpoint on the previous user message's last block; stream test now expects 1 breakpoint (single message) then 3. Red/mutation: `messages.length < 1` (M1 reverted) → 2 fail; previous-user `mark` removed (M2 reverted) → 4 fail; restored byte-identical (`cmp`). `bun test packages/providers`: 225 pass; typecheck and biome clean. Not re-verified live (the 3rd breakpoint adds no cost on a 3-round run; the ~20-block lookback is the API's documented behaviour).

## Review (Round 1)

*— claude-opus-5-5, 2026-11-25 (fresh context; different model from the executor, claude-sonnet-5-5, but the same family — shared blind spots possible)*

**Verdict: REQUEST-CHANGES** — the breakpoints sit on a prefix that really is stable, and the code and tests are clean. But there are two cost holes (M1, M2): in each, a request now pays a 1.25× cache write that is never read. Both are small fixes inside `anthropic-cache.ts`.

**Findings**

1. **MEDIUM — one-shot requests pay the write surcharge and never read it.** `anthropic-cache.ts:33-45` puts the message breakpoint on the last message of *every* request. `summarizeConversation` (`agent/src/compact.ts:118-128`) sends the whole transcript as ONE user message. Compaction runs near the context window, so that is often 100k+ tokens. All of it is now written at 1.25×, and the next request (the rebuilt history) never reads it. `summarizeText` (`compact.ts:157-165`, large tool output) and `titleRequest` (`daemon/src/session-title.ts:87-98`) hit the same path. Trace (scratch, through the real `AnthropicProvider.stream`): the compaction body's only user message carries `cache_control: ephemeral`. Fix (cheapest): skip the message breakpoint when the payload has a single message. That loses only the first user message's own tokens on round 1→2, because tools+system are still cached. Alternative: a `ChatRequest` cache hint set to off by the one-shot callers.
2. **MEDIUM — the doc says "content > 20 blocks between breakpoints is not an issue", and that is false.** The API looks back about 20 *content blocks* (not messages) from a breakpoint for an earlier cache entry. In a round with N parallel calls, one assistant message holds text + N `tool_use` blocks and the user turn holds N `tool_result` blocks. Trace: 12 parallel calls → **25 blocks** between round N's breakpoint and round N+1's. So round N's entry is out of reach: the whole history misses and is re-written at 1.25× (only tools+system still hits). Fix: add a 3rd breakpoint (3 of 4) on the last block of the *previous* user message, i.e. the message that was last in the previous request, so round N+1 hits it exactly whatever the round's width. Pin it with a test. (PLAUSIBLE: the ~20-block lookback is the API's documented behaviour; not verified live, per the no-API rule.)
3. **LOW — the doc lists compaction/`context_reset` as the only prefix rewriters.** Others are missing, all by design and all a one-time miss each:
   - `contextPrune` (`applyPrune`, `agent.ts:1152`);
   - old-image projection at each turn boundary (`projectOldImages`, `agent.ts:1150`);
   - capability toggles (`projectTools`, `projectedHistory`);
   - the voice spoken line (`withSpokenLine`, `core/src/voice/turn-profile.ts:69`). It joins into `system`, so a voice↔text switch misses tools+system too: there is no tools-only breakpoint.

   Document them; there is no code change unless you want a tools-only breakpoint (that would be the 4th).

**Premise table**

| Premise | Where | Verdict |
|---|---|---|
| main sends no `cache_control` (symptom) | scratch copy, main's `anthropic-provider.ts` + the new tests | TRUE: the stream test fails on main's provider |
| `system` is one joined string | `anthropic-provider.ts:558-560` | TRUE |
| tools sent in `req.tools` order = the registry's fixed order | `anthropic-provider.ts:561-563`, `agent/src/capabilities.ts:153` | TRUE (stable within a session; toggles change it on purpose) |
| no timestamps/ids in the system prompt | `config/src/resolve.ts:500` (identity + AGENTS.md + skills catalog) | TRUE |
| `count_tokens` / `buildPayload` unchanged | `applyCacheControl` is called only in `stream` (`anthropic-provider.ts:178-185`) | TRUE |
| usage already accounts for cache tokens (context meter stays right) | `anthropic-provider.ts:227-241` (pre-existing) | TRUE |
| OpenAI provider untouched | `git diff main...HEAD --stat` | TRUE |
| ≤ 4 breakpoints | at most 2 (system *or* last tool, plus the last message) | TRUE |
| no `cache_control` on an empty text block or a thinking block | `buildPayload` drops empty content; `userParts` (`images.ts:488-495`) skips empty text; no thinking blocks in history | TRUE |
| ">20 blocks between breakpoints is not an issue" | trace: 25 blocks with 12 parallel calls | **FALSE** (finding 2) |

**Gate (this worktree):**
- `bun run typecheck` clean.
- `bun run lint` clean (2432 files).
- `bun run test`: **18416 pass, 5 skip, 0 fail** (1275 files). The diff adds no `.skip`/`skipIf`, so the 2 skips beyond the 3 opt-in ones come from the environment, not this task.
- `bun test packages/providers`: 223 pass.

**Red on main (scratch copy in `.tentacle/tmp/anthropic-prompt-caching-review/`, no checkout):**
- The new tests against main's `anthropic-provider.ts`: **24 pass, 1 fail** (the stream-body test).
- The same tests against the branch's file: 25 pass.
- `anthropic-images.test.ts` passes on both. Expected: its change only normalises the body (strips `cache_control`, folds a single text block back to a string), so the image assertions stay about images.

**Mutations (scratch copy, byte-identical restore checked with `cmp`):**
- M1, a breakpoint on every block of the last message → "last block … earlier ones not" FAILS.
- M2, no breakpoint on the last tool when there is no system → "no system prompt" FAILS.

**Attacks tried**
1. A silent invalidator inside the system prompt (date, cwd, ids): none, the prompt is static. Nothing found.
2. Tool order or schema keys varying per round: none, same registry order and deterministic `toWireTool`. Nothing found.
3. Usage regression (`input_tokens` drops to ~4 with caching, which would starve the context meter and auto-compaction): already handled. Nothing found.
4. One-shot calls: **found M1**.
5. Wide parallel rounds against the lookback window: **found M2**.
6. Other history rewriters (prune, old images, voice, toggles): one-time misses only → LOW 3.
7. Mutation aliasing (`applyCacheControl` mutating objects the caller's `ChatRequest` still holds): none, `buildPayload` builds fresh objects. Nothing found.

**What holds:**
- A pure module, called once in `stream`.
- `count_tokens` stays clean.
- Exact request-shape tests, plus one test through the real provider with an injected `fetch`.
- The live evidence is self-consistent: round 3 read 20830 = 20741 + 89 written by round 2. I relied on it and made no API calls.

**Executor behaviour:** a tight, honest diff. The Execution section reports its red test and its live cost. The one miss is in the plan's failure-mode reasoning (messages vs blocks), and it did not ask about one-shot callers of the same provider.
