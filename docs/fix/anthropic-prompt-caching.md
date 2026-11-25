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

### Fix after revert

*— claude-sonnet-5-5, 2026-11-25*

Main gate red on `prune-loop.test.ts` "below the threshold the requests are exactly today's (no contextPrune)". Diagnosis: **not the breakpoints** — the diff the gate printed is only each tool message's `durationMs` (0 vs 1 vs 4): the test compares two separate runs' requests with `toEqual`, and `durationMs` is wall-clock. It uses a `Scripted` model, never the Anthropic provider; `applyCacheControl` runs only inside `AnthropicProvider.stream`, so nothing leaks into the loop's request (no `cache_control` in the diff). A pre-existing timing flake that lost the race under the parallel gate. Fix: the test now neutralises `durationMs` on both sides before the exact comparison (`packages/agent/test/prune-loop.test.ts`); everything else stays exact. Not reproducible on demand (passes 3/3 before and 5/5 after, so there is no honest red); the cause is read from the gate's diff. Full `bun run test` (parallel): 18418 pass, 5 skip, 0 fail. One other full run of mine showed 1 uncaptured fail (the next run was clean) — an unattributed flake; I did not identify it.

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

### Round 2

*— claude-opus-5-5, 2026-11-25 (same reviewer context as Round 1; executor claude-sonnet-5-5, same family)*

**Verdict: PASS.** M1 and M2 are fixed and each is pinned by a test that mutation proves non-vacuous. LOW 3 is documented. No regressions in providers. Reviewed: `git diff HEAD~1` (ef432e48).

**Each finding, verified**
- **M1 (one-shot writes) — fixed.** `anthropic-cache.ts:38` returns before any message breakpoint when `messages.length < 2`.
  - Trace through the real `summarizeConversation` → `AnthropicProvider.stream`: the compaction body has **no** `cache_control` in `messages`; only the system block has one, and it is below the cacheable minimum, so it is harmless.
  - Grepped every `ChatRequest = {` builder outside tests (`compact.ts:118,160`, `agent.ts:1664,2007`) plus `titleRequest`. The one-shots all send one message; the agent-loop ones send many and are re-read.
  - Mutation MA (guard back to `=== 0`): 2 fail.
- **M2 (lookback) — fixed.** `anthropic-cache.ts:42-53` adds a 3rd breakpoint on the nearest earlier `user` message. That is 3 of 4 at most: system (or last tool), plus the last message, plus the previous user message.
  - Trace, 3 rounds of 12 parallel calls each, through `stream`: every request has 3 markers. In round N+1, the content up to the previous-user breakpoint equals round N's whole `messages` once the markers are ignored and a single text block is treated as the same as a plain string. So round N's entry is hit exactly, at any round width.
  - Mutations, all with byte-identical restore checked by `cmp`:
    - MB, the previous-user breakpoint removed: 4 fail.
    - MC, the previous message marked whatever its role: 3 fail.
    - MD, no `break`, so every earlier user message is marked: 1 fail.
- **LOW 3 — documented** in Fix round 1 (prune, old-image projection, toggles, voice line).

**Attacks tried**
1. **String ↔ block form flip.** An older user text message is a string in one round and a one-block array in the next, as the breakpoint moves across it. So the exact match relies on the API treating the two as the same content. The executor's live run already supports this: round 2 read exactly the 20741 tokens round 1 wrote, even though the old code had turned that same message into a block in round 1. **Holds** (no extra API spend).
2. **Steering edge.** A user message enqueued after tool results makes two consecutive `user` turns, because `buildPayload` merges only tool turns. The previous-user breakpoint then lands on the tool-results turn, which round N never cached. The hit then depends on the ~20-block lookback again. That is a one-time miss only in a wide round that also has a steer. **LOW, no change needed.**
3. **First turn of a new session.** Round 1 now writes no message breakpoint, so round 2 re-writes the first user message. The cost is only that message's own tokens; tools and system still hit. **Accepted trade-off of M1.**
4. **Breakpoint limit / empty blocks.** At most 3. `mark` skips empty strings and empty arrays, as before. **Holds.**

**Gate (this worktree, at ef432e48)**
- `bun run typecheck` clean.
- `bun run lint` clean (2432 files).
- `bun test packages/providers`: 225 pass, 0 fail.
- Full `bun run test` (18423 tests, 5 skip), two runs:
  - run 1: 1 fail;
  - run 2: 2 fail, in `packages/tui/test/queue.test.tsx` (steering frame timing) and `scripts/test/release.test.ts` (a 5 s git-push timeout).
- Both files pass in isolation (40/40). Load average at the time was ~48 from other agents on the host. Neither file is touched by, or depends on, this diff. I judge them load-induced flakes, not regressions. Re-run the gate on an idle host before merge to confirm.

**Nit (not blocking):** the Implementation's *Design* line ("2 of 4") and its *Tests* line ("2 breakpoints") are stale. Fix round 1 supersedes them, but the orchestrator may want them edited in place.

**Executor behaviour:** fixed exactly the findings, with no scope creep. It reported its own red/mutation runs, which my mutations confirm. It was honest that the 3rd breakpoint was not re-verified live.

## Review (Round 1) — fresh re-review after "Fix after revert" (022aad6a)

*— claude-opus-5-5, 2026-11-25 (fresh context. The executor is claude-sonnet-5-5: a different model but the same family, so shared blind spots may survive. The earlier rounds were also Opus, in another context.)*

**Verdict: PASS (APPROVE-WITH-NITS).** No HIGH or MEDIUM findings. Scope: `git diff main...HEAD` (merge-base 20723e2f).

**Findings**

1. **LOW: the 5-minute TTL is not discussed.** `EPHEMERAL` (`anthropic-cache.ts:19`) is the default 5-minute TTL.
   - The case: the user takes more than 5 minutes between turns.
   - The effect: the next turn's first request re-writes the whole history at 1.25×, where main paid 1×. The rounds inside a turn are fast, so they read at 0.1×, and the net effect stays a large saving.
   - Ask: document it under Failure modes. A `ttl: "1h"` (2× write) belongs to a separate eval, not this fix.
2. **NIT: stale text.**
   - `anthropic-cache.ts:5` says "Two are placed" but lists three.
   - The changelog fragment says "end of tools+system, and the last message". It leaves out the previous-user breakpoint and the one-shot skip.
   - Implementation *Design* "2 of 4" and *Tests* "2 breakpoints" were already flagged in Round 2 and are still unfixed.
3. **NIT: the `anthropic-images.test.ts` normaliser hides one regression shape.** `bodyFor` (`:125-143`) folds a one-text-block last message back into a string. A `buildPayload` regression that turned a plain last text message into a block would be invisible in that file. Acceptable: that file is about images, and `buildPayload`'s own tests pin the string form.
4. **Scope note, not a defect.** `prune-loop.test.ts:142-145` is outside this task. It neutralises only `durationMs` (wall-clock) before the exact `toEqual`. It is the minimal relaxation, and it is justified by the gate diff recorded in "Fix after revert". There is no honest red for it (a flake), as the executor says.

**Questions asked**

| Question | Verdict / evidence |
|---|---|
| Is the prefix before the breakpoints stable (no timestamps, ids, unsorted keys or varying tool order)? | **Yes.** <br>• The system prompt is identity + AGENTS.md + the skills catalog (`config/src/resolve.ts:501-512`), with no `Date`, cwd or uuid. <br>• `buildPayload` joins all system messages into one string (`anthropic-provider.ts:557-559`). <br>• The only mid-session system additions are the voice line (`core/src/voice/turn-profile.ts:73`, a documented one-time miss) and `context-reset.ts:72`, which re-seeds the same prompt, so tools+system still hits. <br>• Tools are `req.tools.map(toWireTool)` in registry order. `projectTools` returns the same array when nothing is hidden (`agent/src/capabilities.ts:159-161`). <br>• No dynamic tool descriptions were found (grep `description: \``). <br>• No thinking blocks are sent back, so a breakpoint can never land on one. <br>• Old-image projection and prune are documented one-time misses (Fix round 1, LOW 3). |
| ≤ 4 breakpoints? | **Yes, at most 3:** system (or the last tool), the last message, and the previous user message (`anthropic-cache.ts:25-53`). |
| Compaction / `context_reset` handled? | **Yes.** <br>• The one-shot summary gets no message breakpoint (`:38`). <br>• The rebuilt history keeps the identical system and tools, so that breakpoint hits. |
| Pure module + exact request-shape tests? | **Yes.** `anthropic-cache.ts` is React-free and I/O-free, called once in `stream` (`anthropic-provider.ts:178-185`). <br>• 6 shape tests with exact `toEqual` and breakpoint counts. <br>• 1 test through the real `AnthropicProvider.stream` with an injected `fetch`. <br>• `buildPayload`, and so `count_tokens`, stays breakpoint-free. |
| OpenAI provider unchanged? | **Yes.** It is not in `git diff main...HEAD --stat`. |
| Usage / context meter still right? | **Yes.** `promptTokens = input + cache_creation + cache_read` (`anthropic-provider.ts:233-238`, pre-existing), so auto-compaction is not starved. |
| Red on main? | **Yes.** Scratch copy in `.tentacle/tmp/apc-review3/`, with `git show main:…anthropic-provider.ts` swapped in (no checkout). <br>• `anthropic-cache` + `anthropic-images` tests: **26 pass, 1 fail** (the stream-body test). <br>• With the branch's file: **27 pass, 0 fail**. |

**Mutations** (scratch copy of `anthropic-cache.ts`, `anthropic-cache.test.ts` run each time; restored byte-identical, confirmed with `cmp`). All killed:

| Mutation | Result |
|---|---|
| A: one-shot guard back to `< 1` | 2 fail |
| B: `break` removed, so every earlier user message is marked | 1 fail |
| C: previous-user `mark` removed | 4 fail |
| D: first block marked instead of the last | 2 fail |
| E: no system breakpoint | 3 fail |
| F: previous message marked whatever its role | 3 fail |

**Gate (this worktree, at 022aad6a; host load average ~32)**

| Check | Result |
|---|---|
| `bun run typecheck` | clean (exit 0) |
| `bun run lint` | clean (2432 files) |
| `bun test packages/providers packages/agent/test/prune-loop.test.ts` | 236 pass, 0 fail |
| `bun run test` (parallel) | **18418 pass, 5 skip, 0 fail** (18423 tests, 1275 files) |

The 5 skips are the same as in the earlier rounds. The diff adds no `.skip`.

**Live evidence:** I made no API calls (credits are scarce). I relied on the executor's tap rows: round 2 read 20741 = round 1's write, and round 3 read 20830 = 20741 + 89. Round 2 read round 1's user message back after it had flipped from a text block to a string, so the string ↔ block forms hash the same. The 3-breakpoint version itself was not re-verified live, as the executor says.

**Attacks tried**
1. Silent invalidators in system or tools: **none found** (table above).
2. A breakpoint on an invalid block (empty text or thinking): `mark` skips `""` and `[]`, `buildPayload` drops empty content, and there are no thinking blocks. **Holds.**
3. The usage regression with caching (`input_tokens` ≈ 4): already summed. **Holds.**
4. A pod run (`ProxyModelProvider`): `stream` runs on the laptop's `AnthropicProvider`, so caching applies, with no protocol change. **Holds.**
5. Idle longer than the TTL between turns: **LOW 1.**
6. The test normaliser masking regressions: **NIT 3.**

**Executor behaviour:** a tight diff that stays on task. The gate-flake fix is diagnosed from the gate's own diff, and the executor says honestly that it has no red for it. The Round 2 nit on stale text was not addressed (NIT 2).
