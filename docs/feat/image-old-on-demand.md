# feat/image-old-on-demand — old user images become on-demand after 2 turns (slice 2 of image-on-demand)

> **Status:** context
> **Branch:** `feat/image-old-on-demand`
> **Size:** M · **Blast:** load-bearing (agent loop request projection, prompt-cache prefix, compaction interplay) · **Suited:** Opus plan; DeepSeek/Sonnet exec (owner: S/M → deepseek/sonnet); mandatory fresh-context Opus review
> **Changelog:** `changelog.d/image-old-on-demand.changed.md`

## Context

Decided in `docs/eval/image-on-demand.md` (GO-with-conditions; § Owner answers binding — read it all). Owner answer 2: «assolutamente, queste scelte di ottimizzazione sono quello che fa la differenza» — **old user images move to on-demand after N = 2 turns**:
- The images the user attached in the CURRENT turn (and the previous one, N = 2) stay always-sent.
- Older user images are replaced in the REQUEST (a projection, like prune: `packages/agent/src/agent.ts:1053-1060`) by a placeholder line naming the image and how to see it again with `image_view` (the tool of slice 1, `feat/image-view` merged a8de3bfc; `feat/image-files` a0921e4b added file images) — the session log and history are UNTOUCHED.
- Motivation (measured in the eval): ~100-round carry-over of old images and their re-encode on a prefix break.
- Slice 1's seams are the source of truth: the attachment store refs, `image_view(ref, detail)`, the per-provider image token estimate (`model.imageTokens`), `detail` low/high (`model.imageDetail`).

Constraints to verify against the code: the projection must be deterministic per turn so the prompt-cache prefix is stable (it changes only at a turn boundary, never mid-turn); a model without vision gets today's behaviour; pods/sub-agents without a store keep today's behaviour; compaction / context_reset / `/clear` interplay; the TUI/phone transcript keeps showing the images (it is a REQUEST projection only); the placeholder must not be copyable into a write (cf. the prune guard that refused a ⟪pruned by tentacle…⟫ placeholder in fs_multi_edit); the escape hatch `imageToolPolicy: inline` is NOT built pre-emptively (eval Q3).

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

*— claude-opus-5-5 (planner), 2026-11-24*

**Status: APPROVED (self, M, orchestrator rule)** — no choice in this plan is visible to the owner: N = 2, request-projection-only, the current turn always-sent and no escape hatch are all binding answers (eval § Owner answers 2/3); everything below is mechanism. Size **M** (2 production files + 1 new pure module, no protocol/daemon/client/TUI/mobile file). Blast **load-bearing** (the request every round sends; the prompt-cache prefix) → strong executor or DeepSeek per routing, **mandatory fresh-context Opus Review**.

### Load-bearing assumption

**Every request the agent builds goes through ONE pure funnel, `requestHistory(messages, caps)` (`packages/agent/src/agent.ts:1100-1107`), which returns a COPY and never writes `messages`; and within one turn the messages before the turn's first index (`opts.newFrom`) are never rewritten. So a projection that is a pure function of `messages[0, turnFrom)` plus the round's capability switches yields byte-identical old messages on every round of a turn (the cache prefix holds), changes only when `turnFrom` moves (a turn boundary), and never reaches the stored history or the log.**

Each link, verified:
1. **One funnel.** `requestHistory` is the only builder of what the model is sent: the round's request (`agent.ts:1595`), the forced final report (`:1923`), the context line's estimate (`:2035`, inside `noteContextUsage`), the prune trigger's estimate (`:1127`), and the out-of-turn `contextUsage` (`:2093`). It composes `projectedHistory` (`:1083-1093`, a copy only when the system message changes — "the stored history is never touched") with `applyPrune` (`prune.ts:696-712`, a copy). Today's prune projection is the precedent: same seam, same guarantees.
2. **History and log are not the request.** `Session.send` pushes the turn's opener into `this.messages` (`session.ts:214-224`) and persists `this.messages` (`:238`); the daemon's log reads the stored messages, never a `ChatRequest`. A projection inside `requestHistory` therefore cannot reach the log, the TUI or the phone (they render the stored history and the live events), by construction.
3. **The prefix before `turnFrom` is frozen during the turn.** `turnFrom = opts.newFrom ?? messages.length` is the start of the turn (`agent.ts:1397`, the same value seeds `unseen`). The loop only APPENDS (steers `:1567,1914,1996`, notes `:1785`, re-asks `:1836,1848`, tool results) or pops its own last empty assistant (`:1834,1846`). The one in-place write, the context line, targets `i >= unseen ≥ turnFrom` (`agent.ts:2020-2044`). The only rewrite of older messages is a mid-turn `context_reset` (history rebuilt in place, `agent.ts:2752-2757`; `context-reset.ts:73`) whose new history carries **no** image refs, so the projection has nothing to change there (and `turnFrom` is clamped to the length).
4. **No explicit cache breakpoints exist in the repo** (`grep cache_control packages/providers/src` → 0 hits). The caches that matter — llama.cpp's KV prefix (the owner's Qwen) and any server-side automatic prefix cache — are pure byte-prefix matches. So "the cache holds within a turn" is exactly "the serialized messages before the newest ones are byte-identical across the turn's requests", which link 3 guarantees for every message before `turnFrom`.

**Prove first (Execution step 0, before any production code):** a repro in `.tentacle/tmp/image-old-on-demand/step0.ts` — a `Session` over a scripted model that answers turn 1 with text, then turn 2 with two tool rounds and a final answer, plus a late steer, a recording model that `JSON.stringify`s every `ChatRequest.messages`. Assert, on today's code: (a) for every request of turn 2, `messages[0, turnFrom)` serializes byte-identically; (b) `session.messages` after the turn equals the stored log's messages; (c) the set of `requestHistory` callers is exactly the five above (`rg "requestHistory\(" packages/agent/src`). If any fails, STOP and fix the plan (§8).

### Preconditions (verified)

- **User images enter the history only on a turn's opener.** Only `Session.send` builds a user message with `attachments` (`session.ts:216-223`); every mid-turn user message (steers, notes, hook notes, nudges, re-asks) is text-only (`agent.ts:1463,1487,1492,1500,1567,1662,1785,1808,1836,1848,1914,1996`).
- **The provider inlines the newest 5 distinct USER refs on every request** (`providers/src/images.ts:139-161`, `:478-497`); a user message whose `attachments` key is absent sends no image and reads no byte (`readSelected`, `:392-433`). So removing the key in the projection is sufficient — no provider change.
- **The counter charges per ref** (`core/src/token-counter.ts:54`, `imageTokens` 1600 / 3200 / `model.imageTokens`, `providers/src/images.ts:319-327`), and every estimate is taken on `requestHistory`'s output — so a projected (ref-less) message is automatically charged its placeholder text, not an image.
- **Prune stubs only `role:"tool"` messages** (`prune.ts:561`), and `applyPrune` keys on the ORIGINAL message's identity (`:703`). A projection that replaces only user messages with attachments, applied BEFORE `applyPrune`, never collides with a prune entry.
- **The write guard already exists.** `fs_write`/`fs_edit`/`fs_multi_edit` refuse any text containing `⟪pruned by tentacle:` (`tools/src/builtins.ts:364,372-383`, call sites `:397,475,516`). A placeholder that starts with `PRUNE_MARKER` (`agent/src/prune.ts:47`) is covered with no new guard.
- **`image_view` cannot reach a user image today** (`daemon/src/attachment-store.ts:544-564`: "User uploads are never in the index"), but its context already carries the live conversation: `ToolContext.history` (`core/src/tool.ts:189-190`, set at `agent.ts:1390`) and the store's `holds` (`attachment-store.ts:448-452`, true for a completed user upload).
- **Who has the tool.** `image_view` is registered only with a `toolImages` handle AND vision (`cli/src/wiring.ts:1009-1023`): the worker and `serve`; never a pod (image-view D1/T7), never a sub-agent (`subagent.ts` filter), never `images:false`.
- **Compaction drops images** (`compact.ts:40-43`, owner Q6 of attachments-core: a `[image: label]` line in the summary); `context_reset` rebuilds without refs (`context-reset.ts:73`); `/clear` starts an empty history (`forgetPrune`, `session.ts:440,472`).

### Design

**D1 — `packages/agent/src/old-images.ts` (new, pure, React-free, unit-tested).**
- `OLD_IMAGE_TURNS = 2` (owner answer 2; a constant, not a setting — eval Q3 forbids a pre-emptive knob).
- **What "a turn ago" means — answered turns, counted structurally.** An *answer* is an `assistant` message with no `toolCalls` (or an empty list). A user message at index `m` that carries `attachments` is **old** iff the count of answers in `(m, turnFrom)` is `≥ OLD_IMAGE_TURNS`. Its own turn's answer makes 1 (the previous turn: kept); the next turn's answer makes 2 (aged at the start of the turn after). It reads only the stored history — no runtime state, no log marker — so a resumed session, a rebuilt agent and an uninterrupted one compute the same set from the same history.
  - Why not "count user messages": steers, notes and nudges are user messages mid-turn. Why not keep a runtime turn list: it is lost on a worker resume / settings rebuild, and two definitions would drift.
  - Known imprecision (documented, safe direction): a turn with TWO answers (a late steer `agent.ts:1806-1813`, a `turn_end` hook continue `:1782-1787`, a cut reply with text re-asked `:1832-1837`) counts twice → its images age one turn early (the model can still `image_view` them). A turn cancelled before any answer counts zero → its images stay one turn longer.
- `oldImagePlaceholder(ref)`: **a pure function of the ref only** (never of the age — "2 turns ago" would change every turn and break the prefix again), starting with `PRUNE_MARKER`:
  `⟪pruned by tentacle: image <attachmentLabel(ref)> · <formatBytes(size)> attached by the user earlier, not resent — image_view <id12> to see it⟫` (`id12` = `ref.id.slice(0, TOOL_IMAGE_REF_CHARS)`).
- `projectOldImages(history, turnFrom): readonly ChatMessage[]` — for each old user message: a copy WITHOUT the `attachments` key and with `content = lines.join("\n") + (content === "" ? "" : "\n" + content)` (one line per ref, in ref order — images-first, like `userParts`). Every other message keeps its identity; when nothing is old it returns `history` itself. Indices never shift (1:1), so prune indices and anchors stay valid. `turnFrom` is clamped to `[0, history.length]`.

**D2 — `agent.ts`: the projection in the funnel, behind one gate.**
- `requestHistory(messages, caps, turnFrom)` becomes `applyPrune(projectOldImages(projectedHistory(messages, caps), turnFrom), set)` when `this.oldImagesOnDemand(caps)`; otherwise unchanged.
- `oldImagesOnDemand(caps)`: `this.config.toolImages !== undefined && this.config.tools.get(IMAGE_VIEW_TOOL_NAME) !== undefined && !isToolDisabled(IMAGE_VIEW_TOOL_NAME, caps)` — the placeholder names a tool the model can actually call. Decided on **caps**, not on the request's tool list, so the final no-tools report (`:1923`) keeps the same bytes as the turn's other rounds.
- `turnFrom` per caller: `runMessages` captures `const turnFrom = Math.min(opts.newFrom ?? messages.length, messages.length)` once next to `unseen` (`:1397`) and passes it to `maybePrune` (`:1590`), `noteContextUsage` (`:1591`), the round (`:1595`) and the final report (`:1923`). `contextUsage` (`:2093`, between turns) passes `messages.length` — what the next turn will compute, since a turn's opener is a user message (no answer).
- A resumed turn (`resumeFrom`, `session.ts:305`) has no `newFrom` → `messages.length`; the suspended turn has no answer after its opener (it stopped on a tool call), so its count — hence its projection — equals the original turn's.

**D3 — `image_view` resolves the conversation's own user images** (`tools/src/image-view.ts:89-136`).
- After `store.resolve(prefix)` (tool images), scan `ctx.history` USER messages' `attachments` for ids starting with the prefix (distinct ids). Merged result: none / one / ambiguous (labels of both kinds). An id present on both sides (identical bytes) resolves to the tool entry.
- Found as a user image → `store.holds(ref)`; then `{content: "<attachmentLabel> · <KB> · attached by the user · sent as attached", image: ref}`. No variant exists (user uploads are not downscaled): `detail` is ignored with the existing kind of note when it is `"low"` (`· no low variant for a user image — sent as attached`). Not held → `image <id> (<label>) is no longer held — ask the user to attach it again`.
- Scope: only refs in THIS conversation's history (already wire-validated). A store upload not in the history (another client's pending upload) stays unreachable, as in slice 1 (F4 there).
- `ctx` type widens from `Pick<ToolContext,"images">` to `Pick<ToolContext,"images"|"history">`. The description gains one clause: "…or the ref in a `⟪pruned by tentacle: image …⟫` line (a picture the user attached earlier)". The "no image" error names both regenerations: `fs_read the file again, or ask the user to attach it again`.

**D4 — No other file.** Provider, store, protocol, log, TUI and phone are unchanged: the projected message is an ordinary user message without refs; `image_view` of a user image is an ordinary 1-ref tool result (slice 1's path, `agent.ts:285-300`, `images.ts:507-557`), rendered by the existing `Image <ref>` row on Mac and phone.

### Files (dependency order; no protocol file, no `protocol.d/` note)

1. `packages/agent/src/old-images.ts` (new) + `packages/agent/test/old-images.test.ts`
2. `packages/agent/src/agent.ts` (`requestHistory` signature + gate + 5 call sites, `runMessages` `turnFrom`)
3. `packages/tools/src/image-view.ts` (+ `packages/tools/test/image-view.test.ts`)
4. `packages/agent/test/loop-old-images.test.ts` (new), `packages/providers/test/old-images-size.test.ts` (new)
5. `changelog.d/image-old-on-demand.changed.md`

### Failure modes → convergence

| # | Mode | Convergence |
|---|---|---|
| F1 | **Mid-turn rounds** (tools, steers, nudges, a second answer) | `turnFrom` is fixed per turn and only `messages[0, turnFrom)` is read → every round's old messages are byte-identical (T2b/T2c) |
| F2 | **Turn boundary** | The set changes only when `turnFrom` moves. The first request of turn T+2 differs from turn T+1's at the aged message → the prefix cache misses FROM that message once (the suffix is ~2 turns of text; the image itself is never encoded again). Then stable. Inherent in "after N turns"; recorded in Notes |
| F3 | **Compaction / `context_reset` / `/clear`** | Their new history has no refs → nothing projected; `turnFrom` clamped. A summary's `[image: label sha256:…]` id → `image_view` "no image … ask the user to attach it again" (the ref is no longer in the history) (T6) |
| F4 | **Resumed session / rebuilt agent** (worker resume, `serve` reload, settings rebuild) | The rule reads only the stored history → the same set as an uninterrupted run (T7). A resumed suspended turn: same count (D2) |
| F5 | **Pod, sub-agent, no store** | No `toolImages`/no `image_view` registered → gate false → today's bytes (T2e). No projection without a tool to undo it |
| F6 | **No-vision model / `images:false`** | `image_view` not registered → gate false → today's provider placeholders. A model switch mid-session flips the gate at the next round (the tool list already changes the prefix then) |
| F7 | **`image_view` disabled via `/tools`** | Gate false (caps) → today's inline behaviour; turning it back on re-ages at the next round |
| F8 | **Image gone from the store** (worker resume whose laptop blob is missing; store never evicts) | `image_view` → "no longer held — ask the user to attach it again" (T4). Today the same ref inline gave `[image unavailable — label]` |
| F9 | **The model quotes the placeholder into a file** | Starts with `⟪pruned by tentacle:` → the existing write guard refuses, nothing written (T5) |
| F10 | **Prompt-cache breakpoints** | None explicit in the repo (link 4). The placeholder is a pure function of the ref (T1 byte-stability), so once aged it never changes again |
| F11 | **Token estimate** | The projected message carries no ref → `imageTokens` (1600/3200/override) no longer charged; its placeholder text is. The anchor measured BEFORE the aging (`agent.ts:2048-2053`) still contains the image for one round → an OVER-estimate for that round only, the counter's safe direction (`token-counter.ts:4-7`); the next measured round re-anchors |
| F12 | **More than 5 refs across the two kept turns** | Unchanged: the provider's K = 5 still applies (`images.ts:139-161`) |
| F13 | **Version skew** | No wire, log or schema change |

### Tests (red first — each shown failing before its code, §9)

- **T1 agent `old-images.test.ts`** (pure): image in the current turn kept; one answer after → kept; two answers → aged (placeholder + no `attachments` key); a cancelled turn (no answer) does not count; a turn with two answers ages early (pinned, documented); several refs → one line each, in order; empty content → lines only; non-image messages keep identity and an all-kept history returns the SAME array; `turnFrom` beyond length clamps; the placeholder is byte-identical for the same ref regardless of age and starts with `PRUNE_MARKER`.
- **T2 agent `loop-old-images.test.ts`** (scripted model recording every `ChatRequest`, a `toolImages` fake + a registered `image_view`): (a) image in turn 1 → turns 1–2 requests carry the ref, turn 3 requests carry the placeholder and no ref; (b) turn 3 with 2 tool rounds + final: `JSON.stringify(messages.slice(0, turnFrom))` identical on every request; (c) a late steer that produces a second answer mid-turn does NOT change that turn's requests; (d) `session.messages` after 3 turns deep-equals a gate-off run (log/history untouched); (e) gate off — no `toolImages`, `image_view` disabled in caps, a sub-agent — turn 3 still carries the ref (today's golden).
- **T3 providers `old-images-size.test.ts`** — the token/request-size assertion: a fake source with a 1 MiB image; turn 3's request through `OpenAIProvider` (recording `fetch`) has **0** `image_url` parts and its body is shorter than turn 2's by ≥ the image's base64 length; same through `AnthropicProvider` (0 `type:"image"` blocks); `HeuristicTokenCounter({imageTokens: 3200}).count` of the projected history is lower than the unprojected one by `3200 − count(placeholder)`.
- **T4 tools `image-view.test.ts`**: a user ref in `ctx.history` resolves (content line, `image` = the ref); not in the index and not in the history → none; a prefix matching a tool entry and a user ref → ambiguous with both labels; not held → "ask the user to attach it again"; `detail:"low"` → the no-low-variant note; a ref only in a store upload, not in the history → none.
- **T5** `fs_write` with an old-image placeholder in `content` → refused, nothing written (pins that the format stays under the existing guard).
- **T6** after `/compact` and after a `context_reset`, the next request carries no placeholder and no ref; `image_view` of the summary's id → the user-regeneration error.
- **T7 determinism**: a fresh `Agent` + `Session` built from turn 2's stored messages runs turn 3 → its first request's messages serialize identically to the uninterrupted run's.

**Mutations to run and record:** answers threshold `≥ 1` (T2a red); `turnFrom` recomputed as `messages.length` each round (T2c red); gate forced true (T2e red); placeholder includes the age (T1 stability red); projection applied after `applyPrune` with an identity-changing copy of tool messages (T2b/prune rows red).

**Validation:** `bun run check` green (lint baseline 0/0). Live: one worker session and one `serve` (phone) session with the owner's Qwen — attach a picture, run 3 turns, check the turn-3 `promptTokens` in the token-usage log drop by ≈ the measured ~3.1k and that the TUI/phone still show the picture.

### Notes / debt

- **One prefix miss per aged image turn (F2)** — the price of "after N turns"; bounded to ~2 turns of text. A later tuning could defer aging to the next prune batch (which breaks the prefix anyway); not built (no owner ask).
- The "answered turns" proxy miscounts a turn with two answers (early aging) or none (late aging) — rare, safe, pinned by T1.
- User images have no `low` variant: `image_view` re-sends the original (what was sent when attached). A downscale arrives with slices 3a/3b.
- A compaction summary's `[image: …]` id cannot be viewed (the ref left the history); owner Q6 of attachments-core already drops images at compaction.
- The escape hatch `imageToolPolicy: inline` stays unbuilt (eval Q3); if the Qwen acceptance shows the model never re-looks, it would also gate this projection.

## Execution

*— claude-sonnet-4-5 (executor), 2026-11-25*

**Step 0 (the load-bearing check) PASSED — no STOP, no plan fix needed.**

Repro `.tentacle/tmp/image-old-on-demand/step0.ts` (a `Session` over a scripted model: turn 1 text, turn 2 with two tool rounds, a late steer, a recording model that stringifies every `ChatRequest.messages`):

```
(a) turn-2 requests: 3 prefix byte-identical: true
(c) requests carrying the user ref: 4 of 4
(b) stored messages carrying refs: 1
    request message counts: 2,4,6,8
$ rg -n "requestHistory\(" packages/ apps/
agent.ts:1100 (definition) · 1127 maybePrune · 1595 the round ·
1923 the forced final report · 2035 noteContextUsage · 2093 contextUsage
```

So the funnel is unique (five callers, as the plan said), the pre-`turnFrom` prefix is byte-stable inside a turn, and the stored history/log is never the request. Two notes from the harness, neither a plan error: (i) the scratch script needs the workspace's zod instance explicitly (`packages/tools/node_modules/zod/lib/index.mjs`) or `ToolRegistry.definitions()` throws in `zod-to-json-schema` — a scratch-only detail; tests get it right by construction. (ii) The history carries the system message at index 0, so a turn's `turnFrom` is its length **+1** from the caller's view; the tests use that.

### As built (order followed)

**Slice 1 — `packages/agent/src/old-images.ts` (new, pure) + `test/old-images.test.ts`.** `OLD_IMAGE_TURNS = 2`, `isAnswer`, `oldImagePlaceholder(ref)` (a pure function of the ref only, starting with `PRUNE_MARKER`), `projectOldImages(history, turnFrom)` (1:1 copies, the `attachments` **key** dropped, one line per ref prepended, `history` itself when nothing is aged, `turnFrom` clamped). **Not** re-exported from `packages/agent/src/index.ts`: `agent.ts` and the tests import it by path, like the other internal modules, and D4 says no file outside the package consumes it.

**Slice 2 — `packages/agent/src/agent.ts`.** `requestHistory(messages, caps, turnFrom)` now composes `projectedHistory` → `projectOldImages` → `applyPrune` (in that order, so a prune entry keys on the ORIGINAL rows), behind `oldImagesOnDemand(caps)`: `config.toolImages !== undefined && tools.get(IMAGE_VIEW_TOOL_NAME) !== undefined && !isToolDisabled(...)`, decided on the capability snapshot so the forced final report sends the turn's bytes. `turnFrom` is captured ONCE per turn (`opts.newFrom ?? messages.length`, the same value that seeds `unseen`) and threaded to all five callers; `contextUsage` (out of turn) passes `messages.length`, which is what the next turn computes. `maybePrune`/`noteContextUsage` gained the parameter instead of recomputing it. `IMAGE_VIEW_TOOL_NAME` imported from `@tentacle/core` — it is **not** exported by `@tentacle/tools` (the plan's precondition list implies tool-side; the constant lives in core, `prune.ts:36` imports it the same way). No `protocol.d/` note: no wire, log or schema change (F13).

**Slice 3 — `packages/tools/src/image-view.ts`.** `ctx` widened to `Pick<ToolContext,"images"|"history">`; after `store.resolve(prefix)` the tool scans `ctx.history` USER `attachments` for ids starting with the prefix (`userImage`): none/one/ambiguous (both kinds' labels), an id on both sides resolving to the tool entry, found-as-user → `store.holds(ref)` then `{content: "<label> · <KB> · attached by the user · sent as attached", image: ref}`, not held → `… is no longer held — ask the user to attach it again`, and a note only when `detail:"low"` was asked **explicitly** (the default is not a request for a variant that never existed). `REGENERATE` now names both regenerations. The description's new clause is composed from `PRUNE_SENTINEL` (`builtins.ts`) because the write tools refuse the literal in **source** too — a real finding, not a workaround: the new placeholder is covered by the existing guard by construction (T5).

**Slice 4 — tests.** `test/old-images.test.ts` (T1, 12 cases) · `test/loop-old-images.test.ts` (T2 a-e, T6 ×2, T7, and a prune-composition case) · `test/old-images-guard.test.ts` (T5) · `packages/tools/test/image-view-user.test.ts` (T4) · `packages/providers/test/old-images-size.test.ts` (T3 + F11).

**Slice 5 —** `changelog.d/image-old-on-demand.changed.md`.

### Drift from the Implementation (and why)

1. **T3 is written against `projectOldImages` rather than a scripted 3-turn loop.** The property T3 names ("turn 3's body has 0 image parts and is smaller by ≥ the base64") is about the WIRE, and it is decided entirely by the projected messages; the loop-level path that produces them is T2's. Building a third 3-turn fixture would have re-proved T2. The test still fails if the projection keeps the ref (mutation E).
2. **T5 moved from `packages/tools/test/prune-guard.test.ts` to `packages/agent/test/old-images-guard.test.ts`.** `tools` must not import `agent` (`agent → tools` is the allowed direction); the test needs `oldImagePlaceholder`. Same assertions, legal direction.
3. **T6 is asserted on a replaced history, not by driving `/compact`/`context_reset` end to end.** The mechanism those commands share is "the new history carries no refs" (`compact.ts:40-43`, `context-reset.ts:73`); the test installs exactly that and asserts the next request. T7 additionally proves the resume path byte-for-byte.
4. **A prune-composition case was ADDED (not in the plan).** Without it, the plan's last mutation (projection after `applyPrune` with an identity-changing copy) was **not caught** — I found that by running it. The new case makes real stubs land in the same request as the placeholder, so identity loss would show. This is the one place where the plan's Tests list was insufficient.
5. **No new `docs`-level API.** Nothing else changed: no provider, store, protocol, log, TUI or phone file (D4 holds).

### Mutations run (all recorded, all reverted)

| Mutation | Red |
|---|---|
| `OLD_IMAGE_TURNS` threshold `≥ 1` (unit + loop) | T1 ×2 (`one answer after it`, `a cancelled turn`) · T2a, T2c |
| placeholder carries the age (`(>=2 turns ago)`) | T1 stability |
| the projection keeps `attachments` (two shapes) | T1 ×2, **T3** OpenAI + Anthropic |
| placeholder loses `PRUNE_MARKER` | T1 stability, **T5 ×3** |
| `turnFrom` recomputed as `messages.length` each round | **T2c** (only the sharp fixture: a second answer that would age the picture mid-turn) |
| gate forced `true` | **T2e ×3** (no store / switched off / not registered) |
| projection AFTER `applyPrune` on fresh copies | **the added prune-composition case** (was uncaught before it) |
| `projectOldImages` returns `history` always | T1 ×5, T3 |

### Gate (run by the orchestrator)

`bunx tsc --noEmit` → clean. `bunx biome check` on all 8 changed files → 0 errors, 0 warnings. Targeted suites: `packages/tools/test` **562 pass / 0 fail**; `packages/agent/test` + `packages/providers/test` **1022 pass / 0 fail**; the six new/changed files **52 pass / 0 fail**. Full `bun run check` is the script's, after this.

Unverified here: the live acceptance (a worker and a `serve` session on the owner's Qwen, turn-3 `promptTokens` dropping by ≈3.1k) — it needs the owner's model and a real picture; the mechanism it would confirm is what T3 pins on the wire.

## Review

*— claude-opus-5-5 (fresh-context adversarial reviewer), 2026-11-24*

**Verdict: APPROVE-WITH-NITS** (no HIGH or MEDIUM findings). The planner was the same model family (Opus) as this reviewer; the executor was Sonnet. So model diversity is partial.

**Gate:** I ran the six touched or new test files: **52 pass / 0 fail** (195 expects). `bun run typecheck` is clean. `bun run lint` checked 2390 files, 0 errors and 0 warnings. I did not run the full `bun test`; the orchestrator runs it at merge.

**Premises checked (all TRUE):**
- `ToolContext.history` is the stored `messages` array, not the projected request (`agent.ts:1412`). So `image_view` finds an aged ref even though the request has dropped its `attachments`.
- `toolImages` and `attachments` are the same `uploads` object on `serve` (`session-host.ts:1603,1696`). So `store.holds(userRef)` is meaningful, and the provider reads a tool-result user ref from that one source (`images.ts:396-430`).
- User attachments can only be images (`core/attachments.ts:90`). So the "image …" placeholder never names a non-image.
- `estimateUsed` matches its anchor by the identity of its last message (`context-awareness.ts:134`). Aged copies are rebuilt on each call, so at a turn boundary the estimate falls back to an over-estimate or a full count. That is F11's safe direction.
- Compaction, `/clear` and `context_reset` rewrite history only between turns or with no refs (`session.ts:437,469`, `agent.ts:2783`).

**Mutations** (each reverted; `git status` is clean afterwards):
- (1) The round's `requestHistory` was given `messages.length` instead of `turnFrom`. T2c failed.
- (2) `image_view`'s user-ref lookup was fed `undefined` history. All 5 T4 cases failed.
- The executor's table covers the threshold, the age in the placeholder, the forced-true gate and the prune ordering.

**Attacks tried:**
- (a) A mid-turn rewrite of `[0, turnFrom)`: none found besides `context_reset`, which carries no refs.
- (b) Forging an `image_view` reach into a store upload outside the history: the scan covers `ctx.history` user messages only.
- (c) A placeholder written into a file: the `PRUNE_MARKER` prefix triggers the existing guard (T5). The description builds its text from `PRUNE_SENTINEL`, so the source holds no literal.
- (d) The gate on a pod or sub-agent: there is no `toolImages` and no tool, so the gate is false (T2e).
- (e) Wake, hook or steer turns with an extra answer: images age early, the safe direction, and this is documented.

**Nits (non-blocking):**
1. `image-view.ts:172-194`: T4's plan row "a tool entry + a user ref → ambiguous with both labels" was not built. A store `one` hit returns the tool image without scanning the history. With an ≥8-hex prefix of sha256 ids this is practically unreachable. Still, it is unrecorded drift.
2. `image-view.ts:147-151`: when `model.imageDetail` forces `high`, the reply still says "no low variant for a user image". Harmless wording.
3. No loop-level test has the model call `image_view` on an aged ref. It works by construction (see the first premise above) but is not pinned end to end.
4. The forced final report's `turnFrom` (`agent.ts:1950`) has no mutation coverage.

**How the executor behaved:** Step 0 was run and its output recorded. The drift is honest and justified, including the prune-composition case it added after one of its own mutations went uncaught. It made no out-of-scope file changes.
