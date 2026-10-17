# fix/compact-empty-summary-wipe — `/compact` with an empty summary irreversibly wipes the conversation

> **Status:** done — 1st pass (fresh-context): APPROVE-WITH-NITS, nits resolved
> on branch; 2nd pass (deeper, first-person): APPROVE, holds. **Merged to `main`
> (2026-10-17).**
> **Branch:** `fix/compact-empty-summary-wipe`
> **Type:** fix · **Size:** S · **Blast:** cross-module · **Suited:** any model may execute the core guard; standard in-context Review, plus red-team of the persistence path (§7 "Persistence lives on the laptop").
>
> Promoted from `docs/eval/compact-empty-summary-wipe.md` (eval verdict 2026-10-17: **promote**), 2026-10-17.

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** is the claim "`/compact` with an empty summary
irreversibly wipes the conversation" real, how severe is it, and should it be
promoted to a `fix`?

### Evidence (source)

- `packages/agent/src/compact.ts:49-55` — `summarizeConversation` accumulates
  **only** `event.type === "text"` deltas and returns `summary.trim()`. Nothing
  checks for an empty result. `reasoning` events (`packages/core/src/model.ts:43`)
  are discarded.
- `packages/agent/src/session.ts:91-99` — `Session.compact()` calls
  `compactedHistory(this.messages, summary)` and replaces `this.messages`
  **unconditionally**, then `this.persist()`. No empty/length check.
- `packages/agent/src/compact.ts:96-106` — `compactedHistory` keeps only the
  system message plus `"Summary of the earlier conversation (compacted to save
  context):\n\n" + summary`. With `summary === ""` the whole conversation is gone.
- No upstream guard on any layer:
  `packages/daemon/src/hosted-session.ts:119-122` (passes through),
  `packages/daemon/src/connection.ts:126-133` (passes through),
  `packages/client/src/remote-session.ts:27-31` (passes through),
  `packages/tui/src/App.tsx:409-424` (only guards "not available" / "turn
  running"; on success prints `Context compacted — N → 2 messages`, so the user
  is told it **succeeded**).
- Worker path also overwrites the on-disk file:
  `packages/cli/src/local-runtime.ts:66-89` `persistingController.compact()` →
  `flush()` → `snapshot` (length 2 > 0, so the `messages.length > 0` guard at
  :71 does not stop it) → `store.save` with the **same uid**
  (`local-runtime.ts:116-124`) → `JsonSessionStore.save` is a plain overwrite
  of `<uid>.json` with no backup (`packages/agent/src/session-store.ts:63-66`).
  `--resume` cannot recover it.

### Two realistic empty-summary triggers (both reproduced through the real `OpenAIProvider`)

1. **Thinking model answers only in `reasoning_content`** (e.g. Qwen3 on
   llama.cpp spending the whole budget thinking, or `finish_reason: "length"`
   before any content). `openai-provider.ts:168-171` maps it to `reasoning`,
   which the summariser drops.
2. **In-band stream error with HTTP 200** (`data: {"error":{...}}`, as several
   OpenAI-compatible servers/proxies emit mid-stream). The chunk has no
   `choices` → silently skipped at `openai-provider.ts:159-161`; the stream then
   ends with `done` → empty summary. Unparseable chunks are also skipped
   (`parseChunk`, :239-243). This is arguably a separate provider defect
   (in-band errors are not surfaced) that *feeds* this bug.

### Secondary claim — whole transcript in one request

Confirmed: `compact.ts:34-46` joins every non-system message into one user
message; nothing truncates, chunks, or budgets it, and no `maxTokens` is set.
So compaction is most likely to fail exactly when it is most needed (context
already full). **But** the HTTP-error path is safe: a non-2xx response throws
`ModelRequestError` (`openai-provider.ts:132-133`) before `session.ts:94`
mutates anything, and the TUI shows `Compact failed: …`. The danger is only when
the failure is *silent* (case 2 above) or the output is empty/truncated.
Related, lesser: a `finish_reason: "length"` with *partial* text is accepted as
a complete summary (silent partial loss).

### Repro

Scratch scripts (repo untouched):
`/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/compact-empty.ts`
(fake model) and
`/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/compact-empty2.ts`
(real `OpenAIProvider` + injected `fetch`).

```
$ bun .../scratchpad/compact-empty2.ts
A-http400 threw: ModelRequestError: model request failed with status 400: {"error":{"message":"exceeds context size"}}
A-http400 history: ["sys","important task","lots of work"]
A-http400 persisted: "<never persisted>"
B-inband-error result: {"summary":"","before":3,"after":2}
B-inband-error history: ["sys","Summary of the earlier conversation (compacted to save context):\n\n"]
B-inband-error persisted: [{"role":"system","content":"sys"},{"role":"user","content":"Summary of the earlier conversation (compacted to save context):\n\n"}]
C-reasoning-only result: {"summary":"","before":3,"after":2}
C-reasoning-only history: ["sys","Summary of the earlier conversation (compacted to save context):\n\n"]
C-reasoning-only persisted: [{"role":"system","content":"sys"},{"role":"user","content":"Summary of the earlier conversation (compacted to save context):\n\n"}]
```

`compact-empty.ts` (fake model yielding only `reasoning`) gives the same
`{summary:"", before:3, after:2}` and the same persisted 2-message history.

### Verdict

**CONFIRMED.** Main claim reproduced end-to-end at the `Session` layer with the
real provider; no guard exists in daemon, client, CLI or TUI; the worker-path
persist overwrites the session file. Secondary claim **confirmed with a
correction**: the one-shot request is real, but an HTTP error leaves history
intact — only silent/empty outcomes destroy it.

**Severity: high** — silent, irreversible user-data loss (whole conversation,
in memory and on disk), reported to the user as success. Trigger is realistic
for this repo's own target setup (local Qwen3 thinking model on llama.cpp).

**Repro:** `.tentacle/tmp/compact-empty-summary-wipe/repro.ts`, re-run on
`main` (2026-10-17) before any edit:

```
$ bun .tentacle/tmp/compact-empty-summary-wipe/repro.ts
1 reasoning-only  result:    {"summary":"","before":3,"after":2}
1 reasoning-only  history:   ["sys","Summary of the earlier conversation (compacted to save context):\n\n"]
1 reasoning-only  persisted: ["sys","Summary of the earlier conversation (compacted to save context):\n\n"]
2 in-band-error   result:    {"summary":"","before":3,"after":2}
2 in-band-error   history:   ["sys","Summary of the earlier conversation (compacted to save context):\n\n"]
2 in-band-error   persisted: ["sys","Summary of the earlier conversation (compacted to save context):\n\n"]
3 http-400        threw:     ModelRequestError: model request failed with status 400: {"error":{"message":"exceeds context size"}}
3 http-400        history:   ["sys","important task","lots of work"]
3 http-400        persisted: 0 snapshot(s)
```

Cases 1 and 2 (reasoning-only model; in-band SSE `{"error":…}` over HTTP 200
through the real `OpenAIProvider`) both wipe the history in memory **and** on
disk (`onPersist` fires with the 2-message wiped history); case 3 (HTTP 400)
throws before the mutation and leaves everything intact.

## Implementation

*— qwen3.8-27b-q6, 2026-10-17*

### Load-bearing assumption

`Session.compact()` is the single place where history is mutated and persisted
on the strength of a summary, and it awaits the summary **before** the first
mutation: `session.ts:91-99` — `const summary = await this.agent.summarize(...)`
(:93) precedes `compactedHistory` (:94), `this.messages.length = 0` (:95) and
`this.persist()` (:97). Therefore a throw from `summarizeConversation` (the
producer of the summary, `agent.ts:141-143`) happens before **any** state
change and before any persistence — for every runtime, because all of them
(in-process worker, pod, remote) funnel through `Session.compact` (one session
path, §7).

### Preconditions

Verified on current `main` (2026-10-17):

- `summarizeConversation` (`compact.ts:29-56`) is reached from exactly one
  production caller: `Agent.summarize` (`agent.ts:141-143`), called only from
  `Session.compact` (`session.ts:93`). No other code path consumes its result.
- The spill path uses the **separate** `summarizeText` (`compact.ts:64-84`),
  whose caller already catches failures and falls back to the head/tail
  pointer (`result-pipeline.ts:222-228`); `summarizeText` is left unchanged,
  so an empty spill summary keeps its existing fallback rather than erroring.
- Worker path: `persistingController.compact()` awaits `inner.compact()`
  **before** `flush()` (`local-runtime.ts:83-86`) — a reject skips the
  disk overwrite. No `try/finally` persist exists on this path, so a reject
  persists nothing.
- Remote path: a non-`RpcError` handler throw is answered to the client —
  either the real message for the local trusted connection
  (`exposeInternalErrors`, `connection.ts:41-47`) or an opaque internal error
  for remote (`transport/peer.ts:43-50`) — never a success. The client's
  `RemoteSession.compact` (`remote-session.ts:28-33`) rejects, and the TUI's
  error branch (`App.tsx:422-423`) shows `Compact failed: …`.
- `compactedHistory` (`compact.ts:96-106`) is a pure builder with no callers
  outside `Session.compact`; the guard does not need to live there.

### Design

One guard at the source of the empty summary, reusing the existing error
channel:

1. New `CompactError extends Error` in `compact.ts` (exported via the existing
   `index.ts` `export *`). Message: `model returned an empty summary —
   conversation left intact — retry /compact, or check the model emitted no
   visible text (a thinking model may have spent its budget on reasoning)`.
2. `summarizeConversation` throws `CompactError` when `summary.trim()` is
   empty, after draining the stream, before returning. This is the **single**
   choke point: both realistic triggers (reasoning-only output; in-band SSE
   error chunk → zero `text` events) land here, and so does any future silent
   empty stream.

`Session.compact` is deliberately left unguarded: the throw precedes its first
mutation, so it rejects with untouched `this.messages` and no `persist()` —
memory and disk both intact. No protocol/daemon/client/TUI changes: the
reject flows through the existing `session/compact` error response and the
TUI already renders it.

Out of scope (separate tasks): the provider defect that *feeds* trigger 2 —
in-band SSE `{"error":…}` chunk treated as an empty stream instead of a
`ModelRequestError` (tracked in `TODO.md` Block 8, OpenAI-provider item;
also affects normal turns) — and chunked/budgeted compaction for an
already-full context (follow-up eval).

### Files

1. `packages/agent/src/compact.ts` — add `CompactError`; throw it in
   `summarizeConversation` on an empty trimmed summary.
2. `packages/agent/test/compact.test.ts` — regression tests (below).

### Failure modes

- **Empty / whitespace-only summary** (both triggers + any silent empty
  stream): `summarizeConversation` throws → `Session.compact` rejects before
  :94-:97 → history untouched in memory; `onPersist` never called → on-disk
  file untouched (worker: `local-runtime.ts:83-86` skips `flush()`); remote:
  error response, TUI shows `Compact failed: …`. State converges to "nothing
  happened" in every runtime.
- **Mid-stream abort (Esc)**: the `AbortError` from the provider propagates
  from `summarizeConversation` exactly as today (the guard is after the drain,
  so it cannot mask it); same pre-mutation guarantee.
- **Whitespace-only visible text** (e.g. model emits only spaces): caught by
  the same `trim()` check — same behaviour as empty, which is correct (a blank
  summary is a blank summary).
- **Non-empty summary**: `trim()` non-empty → no throw → byte-identical
  behaviour to today (existing happy-path test pins this).
- **Provider HTTP error**: unchanged — `ModelRequestError` is thrown by the
  provider before any event is yielded (`openai-provider.ts:132-133`), so the
  guard is never reached; already safe (repro case 3).
- **Spill path**: untouched — `summarizeText` unchanged; its caller's existing
  `catch` fallback (`result-pipeline.ts:223-228`) still applies.

### Tests

In `packages/agent/test/compact.test.ts` (existing `ScriptedProvider` fake),
**red first** (run against unmodified `main` and show the failure):

1. `summarizeConversation` rejects with `CompactError` when the stream yields
   only `reasoning` events — pins "empty visible output ⇒ failure" at the
   producer, independent of `Session`.
2. `Session.compact()` rejects when the model emits only `reasoning`, and
   after the reject: `session.snapshot()` still holds the original 3 messages
   (exact contents), and the `onPersist` spy recorded **zero** calls — pins
   the exact property that kills the data loss (history stable AND no
   persistence of the wiped state), not the weaker "it threw".

Non-vacuity per §9: temporarily remove the `throw` and confirm both tests
fail, then restore. The existing happy-path tests (text summary) stay green
before and after, proving the guard is narrow. The in-band-SSE variant needs
no separate agent test: the provider's skip path is pinned by its own suite,
and at the agent layer it is indistinguishable from any other zero-`text`
stream (trigger 1's test covers the property).

## Execution

*— qwen3.8-27b-q6, 2026-10-17*

In order, no drift from Implementation:

1. Promoted: `git checkout -b fix/compact-empty-summary-wipe`; `git mv`
   `docs/eval/…` → `docs/fix/…`; header + Repro + Implementation written into
   the doc (the Repro was re-run on current `main` first — same wiped output as
   the eval, plus the HTTP-400 control).
2. **RED:** added the two guard tests to `packages/agent/test/compact.test.ts`
   (reasoning-only stream) and ran them against unmodified code → failed
   (`Export named 'CompactError' not found`).
3. **Fix:** `packages/agent/src/compact.ts` — added `CompactError` and the
   empty-trimmed-summary throw in `summarizeConversation`. GREEN: the file's
   5 tests pass.
4. **Non-vacuity (§9):** commented out the `throw` → both guard tests failed;
   restored → green again.
5. **Repro before/after** (`.tentacle/tmp/compact-empty-summary-wipe/repro.ts`,
   now catches so it runs in both states): pre-fix cases 1–2 returned
   `{"summary":"","before":3,"after":2}` with the wiped history persisted;
   post-fix both `threw: CompactError`, history `["sys","important
   task","lots of work"]`, 0 snapshots persisted; case 3 (HTTP 400)
   `threw: ModelRequestError` in both.
6. `TODO.md`: the two items pointing at the eval now point at the fix.

**Gate:** `bun run check` green — typecheck clean, lint clean (baseline 0/0),
682 pass / 1 skip (the opt-in live-k8s, not a failure) / 0 fail.

**Skipped:** no provider change (the in-band-SSE `{"error":…}` skip at
`openai-provider.ts:147-160` stays — separate tracked item); no
`finish_reason:"length"` hardening (listed as optional in the eval, not in
scope for the guard).

## Review

*— claude-opus-5-5 (fresh-context sub-agent, same model family as the executor
`qwen3.8-27b-q6`), 2026-10-17*

**Verdict: APPROVE-WITH-NITS.** The guard is correct and minimal, the data-loss
bug is closed for every runtime, and the tests genuinely pin the property. One
cosmetic nit (stale cross-doc link after the `git mv`) does not warrant
requesting changes; fix it on merge.

**How I reviewed:** fresh context, re-derived everything from source. Re-ran the
gate, re-ran the Repro in BOTH states (post-fix tree, and pre-fix via a
temporary revert of `compact.ts` that I then restored byte-identically), did the
§9 mutation check, and wrote an end-to-end trace through the real RPC stack
(`.tentacle/tmp/compact-empty-summary-wipe/e2e-rpc.ts`). I did not rubber-stamp
the checklist — I attacked the persistence path and the caller graph (below).

### Gate (re-run by me, `bun run check`)

`bun run typecheck` (`tsc --noEmit`) clean · `bun run lint` (`biome check .`)
clean, 255 files, 0 errors / 0 warnings (baseline 0/0) · `bun test`:

```
682 pass
1 skip      (the opt-in live-k8s, TENTACLE_K8S_SERVER unset — not a failure)
0 fail
2100 expect() calls
Ran 683 tests across 90 files.
```

Exact counts: **682 pass / 1 skip / 0 fail / 2100 expect() / 90 files**. Matches
the Execution's gate claim.

### Premise table — every `file:line` the Implementation cites

Opened each; marked against current source (`compact.ts` line numbers are
pre-fix/`main`, which is what the Implementation verified).

| Premise | Cited | TRUE/FALSE |
|---|---|---|
| `summarizeConversation` is the sole producer; `Agent.summarize` its sole caller; `Session.compact` calls it | `agent.ts:141-143` | **TRUE** — `agent.ts:142-143` wraps it; `session.ts:93` is the only `summarize` caller |
| `Session.compact` awaits the summary **before** the first mutation, then persists | `session.ts:91-99` (summarize :93, `compactedHistory` :94, `messages.length=0` :95, `persist` :97) | **TRUE** — exactly those lines |
| `compactedHistory` is a pure builder, no callers outside `Session.compact` | `compact.ts:96-106` | **TRUE** — `compact.ts:96`; only caller `session.ts:94` |
| `summarizeConversation` is the single choke point reached from one production path | `compact.ts:29-56` | **TRUE** — `compact.ts:29` (main); confirmed by grep |
| Worker: `persistingController.compact` awaits `inner.compact()` **before** `flush()`; the `messages.length>0` guard cannot save it; reject skips the disk write | `local-runtime.ts:66-89` (compact :83-86, guard :71), store.save :116-124 | **TRUE** — `local-runtime.ts:84-85`, `:71`, `:118`; reject → `flush()` never reached |
| Remote: a non-`RpcError` handler throw is answered to the client — real msg if local/trusted, opaque if remote — never a success | `connection.ts:41-47`, `transport/peer.ts:43-50` | **TRUE (behaviour)** — the real logic is `peer.ts:213-235`; the cited lines are the option *docs*. The claim holds: an error response, not a success |
| Client `RemoteSession.compact` rejects | `remote-session.ts:27-31` | **TRUE** — `remote-session.ts:27-33` |
| TUI error branch shows `Compact failed: …` | `App.tsx:422-423` | **TRUE** — `App.tsx:422` |
| Spill path uses separate `summarizeText`; caller already catches + falls back | `compact.ts:64-84`, `result-pipeline.ts:222-228` | **TRUE** — `compact.ts:64`, `result-pipeline.ts:222-229` |
| `JsonSessionStore.save` is a plain overwrite, no backup | `session-store.ts:63-66` | **TRUE** — `session-store.ts:63-66` |

**Context symptom citations (drift, cosmetic):** most are exact, but
`openai-provider.ts:162-165` (reasoning map) is actually `:168-171`;
`:153-156` (no-`choices` skip) is actually `:159-161`; `:228-234` (`parseChunk`)
is `:239-243`; and `connection.ts:126-132` (compact handler) is `:126-133`. The
**behaviour in each is exactly as described**; only the line offsets are off by
a couple. Not a code problem, just sloppier than the Implementation's own
citations, which are accurate.

### Repro re-run (`.tentacle/tmp/compact-empty-summary-wipe/repro.ts`)

**Post-fix (current tree)** — matches the Execution record byte-for-byte:

```
1 reasoning-only  result:     threw: CompactError
1 reasoning-only  history:    ["sys","important task","lots of work"]
1 reasoning-only  persisted:  0 snapshot(s)
2 in-band-error   result:     threw: CompactError
2 in-band-error   history:    ["sys","important task","lots of work"]
2 in-band-error   persisted:  0 snapshot(s)
3 http-400        result:     threw: ModelRequestError
3 http-400        history:    ["sys","important task","lots of work"]
3 http-400        persisted:  0 snapshot(s)
```

**Pre-fix** — I temporarily restored `packages/agent/src/compact.ts` to its
`main` version, re-ran the repro, then restored the worktree file and confirmed
byte-identical (`cmp` clean, `git status` shows only the intended diff). Output:

```
1 reasoning-only  result:     {"summary":"","before":3,"after":2}
1 reasoning-only  history:    ["sys","Summary of the earlier conversation (compacted to save context):\n\n"]
1 reasoning-only  persisted:  1 snapshot(s)
2 in-band-error   result:     {"summary":"","before":3,"after":2}
2 in-band-error   history:    ["sys","Summary of the earlier conversation (compacted to save context):\n\n"]
2 in-band-error   persisted:  1 snapshot(s)
3 http-400        result:     threw: ModelRequestError
3 http-400        history:    ["sys","important task","lots of work"]
3 http-400        persisted:  0 snapshot(s)
```

This independently reproduces the bug (cases 1–2 wipe **and** persist the
2-message history; case 3 is safe) and confirms the fix closes it.

### Mutation non-vacuity (§9)

I disabled the guard (`if (false && trimmed.length === 0)`) and ran
`bun test packages/agent/test/compact.test.ts`:

```
(fail) empty-summary guard > summarizeConversation rejects with CompactError when the model emits no visible text
(fail) empty-summary guard > Session.compact leaves the history untouched and unpersisted when the summary is empty
 3 pass / 2 fail
```

Both new tests fail without the `throw`. Restored the file byte-identically
(`cmp` clean); the 5 tests pass again. The tests are **not** vacuous: the
second one pins the exact data-loss property (history stable **and** zero
`onPersist` calls), not just "it threw".

### E2E trace through the real RPC stack (`e2e-rpc.ts`)

Not a unit test of `Session.compact` — a `Connection`(daemon) ↔ `RpcPeer` ↔
`RemoteClient` pipeline, wrapped in the **actual** `persistingController`
(`local-runtime.ts:65`), run for both `exposeInternalErrors` settings:

- **Worker (`exposeInternalErrors=true`):** `session.compact()` rejects
  `RpcError: model returned an empty summary — conversation left intact — …`;
  TUI would print `_Compact failed: RpcError: model returned an empty summary
  — …_`; `persist` called **0** times; `snapshot()` reads back the original
  3 messages. **Wipe prevented: YES.**
- **Remote (`exposeInternalErrors=false`):** rejects `RpcError: internal error`;
  TUI would print `_Compact failed: RpcError: internal error_`; `persist` called
  **0** times; `snapshot()` reads back the original 3 messages. **Wipe
  prevented: YES.**

This confirms the brief's specific question: the reject **does** prevent the
on-disk overwrite for the in-process worker (via `persistingController`) and
the remote daemon path (no laptop disk to write; in-memory history intact; TUI
shows a failure, never a success).

### Attacks tried (the plan's "Failure modes" are the floor)

1. **Is there another runtime / caller that still wipes on disk?** — Grepped all
   of `summarizeConversation`, `Session.compact`, and `.compact(`. `summarizeConversation`
   has exactly one production caller (`agent.ts:143`); `Session.compact` is
   called only via `agent.summarize`. `.compact(` sites: `App.tsx:420`,
   `local-runtime.ts:84`, `connection.ts:109/131`, `hosted-session.ts:120`,
   `remote-session.ts:31` — all funnel through `Session.compact`. The
   **in-process fallback** (`main.ts:513-522`) uses `Session` directly with an
   `onPersist` that does `store.save`; a throw in `compact()` precedes
   `this.persist()`, so no write. The **pod `run`/`attach`** path goes through
   `createLocalRuntime` → `persistingController` (same as worker). The
   **`connect`** path has no laptop store at all. → **No other path to the
   wiped state.** Found nothing.
2. **Does the TUI show a *sensible* error for `CompactError` over RPC, and how
   does `RpcPeer` format a non-`RpcError` handler throw?** — `peer.ts:213-235`:
   a non-`RpcError` throw becomes an error response; local/trusted
   (`exposeInternalErrors`, the worker) carries the **real** `CompactError`
   message + stack, remote/untrusted is opaque "internal error". Either way the
   client rejects and `App.tsx:422` prints `Compact failed: …` — never a
   success. Worker: informative; remote: generic but still a clear failure.
   → **Sensible; found nothing to break.** (The message text is long but
   acceptable.)
3. **Does a mid-turn abort still behave as before?** — The guard runs **after**
   the `for await` drain (`compact.ts:63-75`), so an `AbortError` from the
   provider propagates out of `summarizeConversation` unchanged and is never
   masked as a `CompactError`; `Session.compact` rejects before any mutation,
   same as a normal error. → **Unchanged; found nothing.**
4. **Does the spill path stay untouched and correct?** — `summarizeText`
   (`compact.ts:64-84`) is byte-identical to `main`; its caller
   (`result-pipeline.ts:222-229`, wired via `wiring.ts:94`) already `catch`es
   and falls back to the head/tail pointer. The guard does not touch it, so an
   empty spill summary keeps its existing fallback rather than erroring. →
   **Untouched and correct; found nothing.**
5. **Whitespace-only / partial-summary edge cases** — Whitespace-only visible
   text is caught by the same `trim()` (correct). A `finish_reason:"length"`
   with *partial* text is **still accepted** as a complete summary — a known,
   documented, out-of-scope limitation (the eval listed it as optional
   hardening). → **Not a regression; left as documented.**

**What the plan missed:** essentially nothing on the functional path. The only
real gap is a **cosmetic doc-consistency** one (finding 2 below). The
Implementation's "Preconditions" even correctly *predicted* the remote-path
behaviour I re-derived, which is why the red-team found nothing functional to
break.

### Findings

1. **(nit, docs) Stale cross-doc link after the `git mv`.** The promotion moved
   the eval doc to `docs/fix/…`, but `docs/eval/history-validity-invariant.md`
   still points at the old path in two places: **`history-validity-invariant.md:110`**
   and **`:210`** ("see `docs/eval/compact-empty-summary-wipe.md`"). That file
   no longer exists, so those are now dangling references. The moved doc's own
   header (`:7`, "Promoted from `docs/eval/…`") is an intentional provenance
   note and is fine. **Fix on merge:** repoint the two `history-validity`
   references to `docs/fix/compact-empty-summary-wipe.md`. (The task's
   Implementation only enumerated the two code files, so this is a
   promotion-hygiene slip, not a plan violation.)
2. **(nit, docs) Minor `file:line` drift in the Context symptom citations**
   (listed in the premise table): `openai-provider.ts:162-165`→`:168-171`,
   `:153-156`→`:159-161`, `:228-234`→`:239-243`, `connection.ts:126-132`→`:126-133`.
   Behaviour in each is exactly as described; only offsets are off. The
   Implementation's own citations are accurate.

Both are nits; neither blocks the merge. The functional change (the guard in
`compact.ts` + the two regression tests) is correct, minimal, and verified.

### What holds

- **The bug is closed for every runtime.** In-memory and on-disk state both
  stay intact on an empty summary: the throw in `summarizeConversation`
  precedes `Session.compact`'s first mutation and `persist()`, and
  `persistingController` skips `flush()` on a reject. Verified by repro
  (pre/post), the agent test, and the real-RPC E2E trace.
- **The guard is the single choke point.** Both realistic triggers (reasoning-
  only model; in-band SSE `{"error":…}` chunk the provider skips) land at the
  same `trim()` check, as do any future zero-`text` streams.
- **Non-vacuous, red-first tests.** Both new tests fail with the `throw`
  removed and pass with it; the second pins history-stable-AND-no-persist, not
  "it threw". Existing happy-path tests stay green (the guard is narrow).
- **No collateral.** No other caller of `summarizeConversation` /
  `Session.compact` breaks; the spill path is untouched; aborts are unchanged;
  the gate is green with no new lint issues.
- **Scope is clean.** `git diff main` shows exactly this task: `compact.ts`
  (+24/-1), `compact.test.ts` (+44/-1), the doc `git mv`, and `TODO.md`
  index updates.

### How the executor behaved

Good, disciplined, honest execution. Followed Implementation order with no
drift, ran red-before-green (RED shown failing with `Export named 'CompactError'
not found`), did the §9 mutation check, re-ran the repro in both states, and
reported the exact gate counts. It correctly **scoped out** the two real but
separate defects (the provider in-band-SSE skip — tracked in `TODO.md`; the
`finish_reason:"length"` partial-summary case — optional per the eval) rather
than scope-creeping into them. The one slip is the `history-validity` cross-
doc link not being repointed after the `git mv`.

**Prior art / open items on the same path:** `TODO.md` "session/compact races
a turn on the daemon" (`docs/eval/daemon-compact-turn-guard.md`) is a
concurrency guard on the *same* `compact` path — separate concern, still open,
not touched by this fix. The in-band SSE error-chunk provider defect is the
known separate `TODO.md` Block item (it *feeds* trigger 2; unaffected here).
The `history-validity-invariant` eval notes `/compact` as the rescue path and
"depends on a non-empty summary" — this fix is exactly what makes that
rescue safe. No conflicting open item.

### Nits resolved (on this branch, post-Review)

- **Stale cross-doc link (nit 1):** `docs/eval/history-validity-invariant.md:110`
  and `:210` repointed `docs/eval/compact-empty-summary-wipe.md` →
  `docs/fix/compact-empty-summary-wipe.md` (broken by the promotion `git mv`;
  rides this branch).
- **Context line-number drift (nit 2):** all four citations in Context verified
  against current source and corrected: `openai-provider.ts:162-165` →
  `:168-171` (reasoning map), `:153-156` → `:159-161` (no-`choices` skip),
  `:228-234` → `:239-243` (`parseChunk`), `connection.ts:126-132` →
  `:126-133` (compact handler). A fifth, unflagged drift was also caught and
  fixed the same way: `openai-provider.ts:126-128` (non-2xx throw) is actually
  `:132-133`.

### Second review pass (second, deeper pass — first-person re-verification)

*— qwen3.8-27b-q6, 2026-10-17 (the implementing model; a second, independent
adversarial pass requested after the fresh-context pass above)*

**Verdict: APPROVE (holds).** The core guard is correct and the data-loss bug
is closed. This pass re-verified the load-bearing premises in first person
(re-ran the gate: 682 pass / 1 opt-in k8s skip / 0 fail / 2100 expect() / 90
files) and **traced the two runtime paths the first pass covered more thinly**
(the in-process fallback and the remote error-message surface). No functional
defect found; two findings below — one pre-existing (out of scope, recorded),
one a recommended follow-up (remote error-message opaqueness).

**Premises re-confirmed in first person** (not re-derived from the first pass):
- `Agent.summarize` has exactly ONE production caller, `Session.compact`
  (`session.ts:93`); the *other* `summarize(` hit in `result-pipeline.ts:223`
  is the spill path's injected callback → `summarizeText`, a different
  function. So the guard's blast radius is confined to `/compact`.
- `Session.compact` has **no** `try/finally` — the throw at
  `summarizeConversation` (before `compactedHistory`/`persist`) is the only
  thing standing between an empty summary and the mutation; confirmed there is
  no second persist on the error path.
- `exposeInternalErrors` is set `true` **only** for the worker
  (`worker.ts:103`) and is **not** passed for remote (`ws-server.ts:182-187`)
  — see Finding 4 for the consequence.

**Finding 3 (pre-existing, out of scope — recorded, NOT fixed here):
concurrent `/compact` is not re-entrancy-protected.** `running` is set `true`
only by `startTurn`/`startContinuation` (`state.ts:158,174`) and cleared by
`failTurn`/`endTurn` (`state.ts:147,307`); `/compact` never touches it
(`App.tsx:409-424`), and there is no `compacting` flag anywhere. A user who
fires `/compact` twice quickly gets **two concurrent `Session.compact()`
promises** over the same `this.messages`. With a *non-empty* summary this can
still interleave badly (two `length=0`+`push` sequences racing). It is a real
pre-existing defect, but **not introduced or worsened by this fix** — in the
empty-summary case both promises now *reject* before either mutates, so the
guard strictly *reduces* the dangerous window (before: the first compact could
wipe+persist; now: neither mutates). It is the same family as the open
`docs/eval/daemon-compact-turn-guard.md` (compact racing a turn) — whose
proposed guard already rejects "when a turn **or another compact is active**"
(`daemon-compact-turn-guard.md:112`) and shows the compact busy in the TUI —
so it is already scoped to that task, not here. **No test added** (out of
scope); recorded so the follow-up knows.

**Finding 4 (recommended follow-up, not blocking): the remote error message is
opaque.** `String(e)` in the TUI (`App.tsx:422`) shows the real, actionable
`CompactError` message on the **worker** path (`exposeInternalErrors:true` →
`peer.ts:222-230`), but on a **remote** `connect` the daemon's `Connection`
omits `exposeInternalErrors` (`ws-server.ts:182-187`) → `peer.ts:232-234` →
the client gets `RpcError: internal error`. The TUI therefore shows
`Compact failed: internal error` to a remote user — correct (the history
*is* safe) but unhelpful. This is the **intentional** untrusted-peer default
(docstring at `connection.ts:36-45` / `peer.ts:43-50`), not a regression. A
clean fix would be a dedicated `DomainErrorCode` (e.g. `EmptySummary`) mapped
to an `RpcError` so the *message* crosses the wire without exposing arbitrary
internals — a protocol addition (additive, version stays 1) that belongs to a
follow-up, not this minimal guard. Recorded; not fixed.

**Attacks tried (second pass, beyond the first):**
1. *Is `summarizeConversation` reachable from anywhere but `/compact`?* — No:
   sole caller `Agent.summarize` → `Session.compact` only; the spill path uses
   `summarizeText`. Guard blast radius is confined. **Found nothing.**
2. *Could a concurrent second `/compact` corrupt state or bypass the guard?* —
   The guard still holds (both reject pre-mutation on the empty path), but the
   *non-empty* concurrent case is a pre-existing race (Finding 3), not a
   regression. **Pre-existing issue surfaced, out of scope.**
3. *Does the in-process (no-worker) fallback persist on the error path?* —
   `main.ts:509-522` builds a `Session` with `onPersist → store.save`;
   `Session.compact` rejects before `persist()` is reached, so `store.save`
   never sees a wiped snapshot. **Holds.** (The TUI's `makeSession` uses this
   `createSession` factory in-process, `App.tsx:174-180`.)
4. *Does the guard accidentally swallow a mid-turn `AbortError`?* — No: the
   throw is after the stream drain, so a provider `AbortError` propagates first
   and the empty-check never runs. **Holds.**
5. *Is `CompactError` exported so tests/TUI can reference it?* — Yes, via
   `index.ts:8` `export * from "./compact.ts"`. **Holds.**

**What holds:** the guard is the single choke point for every silent-empty
summary across all runtimes (worker, in-process fallback, pod, remote); no
second persist path exists; the export is correct; the gate is green.

**What does not (pre-existing, not this fix's job):** concurrent non-empty
`/compact` re-entrancy (Finding 3) and remote error-message opaqueness
(Finding 4). Both are recorded with their owning follow-up.
