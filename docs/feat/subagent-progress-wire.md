# feat/subagent-progress-wire — Sub-agent progress and usage cross the wire

> **Status:** implementation (awaiting owner approval)
> **Branch:** `feat/subagent-progress-wire`
> **Size:** M · **Blast:** cross-module · **Suited:** a strong-or-mid model executes; standard in-context Review (additive display update, no §7 invariant, no persisted format)

## Context

*— claude-sonnet-5-5, 2026-10-26*

Row 2 of `docs/eval/parallel-execution-plan.md` ("Size, blast and proposed
split"; §2.4 and §2.3 "Token budget"). Valuable on its own, and the
prerequisite for rendering N parallel sub-agent trees later.

**Problem.** Every runtime is RPC (AGENTS §7), but the daemon maps
`subagent_start/tool/end` to `null` (`packages/daemon/src/mapping.ts:249-251`).
So the TUI's sub-agent tree (`packages/tui/src/state.ts:320-348`) is
unreachable: an `agent_task` renders as an opaque running tool. Also the
child's `usage` events are dropped (`packages/agent/src/subagent.ts:206-213`
forwards only `text`, `tool_start`, `turn_end`), so session token totals
under-count sub-agents.

**Repro (feat: capability missing).** `rg -n "subagent|tool_progress" packages/protocol packages/client`
→ empty (checked 2026-10-26); `packages/daemon/src/mapping.ts:249-251` returns
`null` for the three events.

## Implementation

*— claude-sonnet-5-5, 2026-10-26*

### Load-bearing assumption

A **new display-class `session/update` type is safe to add without a
`PROTOCOL_VERSION` bump**: an older client skips an unknown display type and
shows `unsupported` once (`packages/client/src/mapping.ts:42-68`,
`classifyUpdate`: unknown, not `mandatory` → `unsupported`; AGENTS §7 "display:
free to add"). Class lives in one table, `UPDATE_CLASS`
(`packages/protocol/src/updates.ts:228`), a `Record` keyed by the union's
types, so a missing class is a compile error.

### Preconditions

- Progress already exists end-to-end up to the daemon: tool →
  `ctx.emitProgress` (`packages/agent/src/agent.ts:1078`) → `progressToEvent`
  (`agent.ts:238-250`) → `AgentEvent` `subagent_*` (`agent.ts:194-205`) → only
  `eventToUpdate` drops it (`daemon/src/mapping.ts:249`).
- The TUI reducer already handles `subagent_*` keyed by the parent call id
  (`state.ts:320-348`, `updateTool`), tested in `tui/test/state.test.ts:40-43`.
  No reducer change for progress.
- `ToolProgressEvent` is the shared type (`core/src/tool.ts:70-73`); the child
  loop is `subagent.ts:201-214`.
- Progress is rendering-only: never a `ChatMessage`, never persisted (AGENTS §7
  persistence bullet). It is not replayed at re-attach (the snapshot carries
  the final tool result); a client that attaches mid-task shows the tool
  opaque until the end — same as today, acceptable (see failure modes).
- No §7 invariant touched: no broker, no persistence, no pod-trust path (a pod
  can send progress, which is display text only; the laptop never acts on it —
  see failure modes).
- `PROTOCOL_VERSION = 13` (`protocol/src/version.ts:7`); stays 13.

### Design

One wire update, three-plus-one kinds, mirroring `ToolProgressEvent`:

```ts
// protocol/src/updates.ts — display
ToolProgressSchema = z.object({
  type: z.literal("tool_progress"),
  toolCallId: z.string().min(1),          // the PARENT call (agent_task)
  kind: z.enum(["subagent_start","subagent_tool","subagent_end","subagent_usage"]),
  // per kind (all optional, strip schema; reverse mapping validates presence):
  agentType, description,                 // start
  label,                                  // tool
  toolUses, stopReason,                   // end
  promptTokens, completionTokens,         // usage
});
```

1. **core**: add `{kind:"subagent_usage", promptTokens, completionTokens}` to
   `ToolProgressEvent`.
2. **agent**: `subagent.ts` forwards the child's `usage` events as
   `subagent_usage` (`onEvent`); `agent.ts` `AgentEvent` + `progressToEvent`
   gain `subagent_usage`.
3. **protocol**: `ToolProgressSchema`, in the union, `UPDATE_CLASS.tool_progress
   = "display"` (a label/meter: skipping it hangs nothing and the final result
   rides `tool_call_update`). JSON-schema export and `x-event-class` follow
   automatically (`json-schema.ts:52`).
4. **daemon**: `eventToUpdate` maps the four events (no longer `null`).
5. **client**: `updateToEvent` reverse-maps back to the same `AgentEvent`s; a
   malformed frame (kind without its required fields) maps to the
   "ignored" result, not a throw (display, never fail a turn on a label).
6. **tui** (owner 2026-10-26): new `subagent_usage` case in `state.ts` sums the
   child's prompt+completion into that sub-agent row's own `tokens` — NOT
   `sessionTokens` (the session total is the main conversation only) and NOT
   `lastTurnTokens` (the parent's context meter). The row head shows it as a
   bare number via the shared `formatTokens` (`explore · 2 tool uses · 12k`).
   `cli/src/render.ts` gets a `subagent_usage` case (exhaustive switch; prints
   nothing). *(Was: add to `sessionTokens` only.)*
   **Wire `kind`** (owner 2026-10-26): a free `z.string()`; the client ignores
   unknown kinds. No schema length caps — the client sanitizes/truncates.

**Choice of shape**: flat `kind` + optional fields (matches the eval's
`tool_progress{toolCallId, kind, …}`), not a nested union: a nested union would
make an unknown future kind a *malformed known type* → `classifyUpdate` returns
an error (`mapping.ts:57-58`), failing the turn; with `kind: z.enum` the same
risk applies to an unknown `kind` (see failure modes and Owner question 1).

### Files

Dependency order (≈12 files, 5 of them tests):

1. `packages/core/src/tool.ts` — `subagent_usage` in `ToolProgressEvent`.
2. `packages/protocol/src/updates.ts` — schema, union, `UPDATE_CLASS`.
3. `packages/agent/src/subagent.ts`, `packages/agent/src/agent.ts` — forward + event.
4. `packages/daemon/src/mapping.ts` — map instead of `null`.
5. `packages/client/src/mapping.ts` — reverse mapping.
6. `packages/tui/src/state.ts`, `packages/cli/src/render.ts` — usage case.
7. Tests: `protocol/test/updates.test.ts` (+ json-schema/`UPDATE_CLASS` samples),
   `daemon/test/mapping.test.ts` (samples list line ~206-228 must include the new
   type — "covers every known type" test), `client/test/mapping.test.ts`,
   `agent/test/subagent.test.ts` (+`progress.test.ts`), `tui/test/state.test.ts`.
8. Docs: `TODO.md` index row, `docs/protocol*` listing if it enumerates
   updates (rg at execution).

### Failure modes

- **Old client + new daemon**: unknown display type → `unsupported` once,
  skipped; the tool just looks opaque as today. Converges.
- **New client + old daemon**: never receives it; opaque as today.
- **Future new `kind` from a newer daemon**: with `z.enum`, an older client
  treats it as a malformed `tool_progress` → turn error. Mitigation options in
  Owner question 1; recommended: make the wire `kind` a plain `z.string()` and
  have the reverse mapping ignore unknown kinds (forward-compatible).
- **Malformed fields** (missing `label` for `subagent_tool`): reverse mapping
  returns no event; never throws.
- **Dropped/reordered progress frames** (display class may be skipped):
  tree is cosmetic; `subagent_end` missing leaves `done:false` until the tool
  result arrives — the TUI should close it on `tool_result` (check `state.ts`
  at execution; add only if not already done).
- **Reconnect/re-attach mid-task**: progress is not in the snapshot; tree
  appears from the next frame (no stale state). Accepted; not persisted.
- **Pod is untrusted**: progress carries only strings/ints rendered as text;
  no effect on the laptop, no approval. Strings should be length-capped by the
  schema (`label`/`description`: reuse the `line()`-style cap) and token
  counts `int().nonnegative()`.
- **Usage double counting**: child usage goes only to `sessionTokens`; the
  parent's own `usage` events are unchanged. Not persisted anywhere, so no
  resume mismatch.

### Tests

Red before green; fakes only.

- protocol: `tool_progress` parses for each kind; `UPDATE_CLASS.tool_progress
  === "display"`; JSON-schema annotation test still passes; unknown extra
  field is stripped.
- daemon `eventToUpdate`: each `subagent_*` event → the update (was `null`);
  samples list includes the new type (the existing exhaustiveness test fails
  red until added); `mandatory` flag absent.
- client `updateToEvent`: round-trip (daemon map → client map) for all four
  kinds returns the original `AgentEvent`; malformed → ignored.
- agent `subagent.test.ts`: a child run with scripted usage emits
  `subagent_usage` via `onEvent`; `progress.test.ts`: it surfaces as an
  `AgentEvent` between `tool_start` and `tool_result`.
- tui `state.test.ts`: `subagent_usage` raises `sessionTokens` and leaves
  `lastTurnTokens` untouched (the exact property that matters).
- integration (daemon `integration.test.ts` pattern): a scripted `agent_task`
  over the real Connection pair delivers `tool_progress` updates to the client
  and the TUI-side events reach the reducer (proves the end-to-end wire).
- Non-vacuity by mutation: restore the `null` mapping → the round-trip and
  integration tests fail.

### Owner questions

1. **Wire shape for `kind`**: `z.enum` (strict, cheap) vs plain string with
   ignore-unknown in the client (forward-compatible). *Recommend the latter.*
2. **Child usage in totals**: add to the session total only (meter untouched),
   or also surface a separate "sub-agents" figure? *Recommend session total
   only now.*
3. **Late-attach replay** of the current tree in the snapshot: out of scope?
   *Recommend out of scope* (cosmetic, parallel-agents task can revisit).

## Execution

*— claude-sonnet-5-5, 2026-10-26*

**Baseline** (main `6f0ea1e`, before edits): `bun run check` green — 3121 pass / 3 skip / 0 fail, lint clean.

**Repro (capability missing).** On the baseline, `daemon/src/mapping.ts` returned `null` for the three `subagent_*` events and no `tool_progress` existed in `packages/protocol`/`packages/client`.

**Red (before any `src` edit)** — 17 failures, all on assertions (`bun test` on the touched test files):
`createSubagentRunner > forwards each child usage event as subagent_usage`, `agent interleaves tool progress … subagent_* events appear between tool_start and tool_result`, `session/update payloads > every update variant parses`, `tool_progress > is a display update`, `eventToUpdate: sub-agent progress rides the wire`, `toUpdateParams > covers every known type`, `updateToEvent: tool_progress > …`, `display state reducer > subagent_usage …`, `itemLines > renders a sub-agent's nested activity tree` (`explore · 2 tool uses · 12k`), `a running sub-agent row shows its own tokens` (ink frame). (The cli integration test was red too, but first for a wrong reason — the borrowed shell schema rejected `{}` args; fixed to valid args, and its non-vacuity is proven by M1 below.)

**As built** (dependency order):
1. `core/src/tool.ts` — `subagent_usage` in `ToolProgressEvent`.
2. `agent/src/agent.ts` (`AgentEvent` + `progressToEvent`), `agent/src/subagent.ts` — each child `usage` event is forwarded as `subagent_usage`.
3. `protocol/src/updates.ts` — `ToolProgressSchema` (flat, **`kind: z.string()`**, optional fields), in the union, `UPDATE_CLASS.tool_progress = "display"`; `schema/protocol.json` regenerated (`bun run schema:export`; the drift gate demanded it). `PROTOCOL_VERSION` stays 13.
4. `daemon/src/mapping.ts` — the four events map to `tool_progress` (no longer `null`).
5. `client/src/mapping.ts` — `progressToEvent`: unknown kind or a known kind missing fields → `null` (ignored, never a throw); text from the daemon is sanitized (control chars → space, cap 200).
6. `tui/src/state.ts` — `SubAgentProgress.tokens`; `subagent_usage` adds prompt+completion to **that row only** (not `sessionTokens`, not `lastTurnTokens`). `tui/src/render-lines.ts` — head `◆ explore · 2 tool uses · 12k` via the shared `formatTokens` (omitted at 0). `cli/src/render.ts` — `subagent_usage` prints nothing.
7. Tests: agent (`subagent`, `progress`), protocol `updates`, daemon `mapping`, client `mapping` (round trip, malformed, unknown kind, sanitization), tui `state` / `render-lines` / `app` (ink-testing-library frame: row shows `11k`, status bar stays `↑7 ↓3`), cli `local-runtime` (real Connection pair: events arrive between `tool_start` and `tool_result`).

**Mutations** (restored from `cp` backup, `shasum` identical each time):
- M1 daemon `subagent_tool` → `null`: fails the daemon round-trip test and the cli integration test.
- M2 `subagent_usage` also adds to `sessionTokens`: fails the reducer test (the first attempt mutated the object in place and slipped through because the test compared against the same object — the test now pins literal `{prompt:1000, completion:50}`).
- M3 client `progressText` made identity: fails the sanitization test.
- M4 render head never shows tokens: fails the ink frame test and the render-lines test.

**Drift from Implementation** (owner decisions 2026-10-26 applied):
- (owner 2026-10-26) `kind` is a free string; the client ignores unknown kinds (Owner Q1).
- (owner 2026-10-26) child usage is **not** added to `sessionTokens`; it feeds the sub-agent row only (replaces Design §6).
- (owner 2026-10-26) the row shows its own tokens as a bare number in the head, `explore · 2 tool uses · 12k` — I appended it to the existing head (`◆ <agentType> · <uses>`) rather than rewording it to `agent explore · 12k`; trivial to change if the exact wording matters.
- The schema carries **no string length caps** (plan said cap): a cap on a known type would make an over-long label a malformed update → turn error. The client sanitizes and truncates instead, so a label can never fail a turn.
- `subagent_usage` is per child model call (a delta), summed by the reducer.

**Not done / debt:** if a `subagent_end` frame is dropped (display class) the finished row keeps a `└─ …` tail (`done` stays false; `state.ts` does not close `sub` on `tool_result`). Cosmetic; not changed here. No doc enumerates updates beyond `ARCHITECTURE.md` (generic wording), so no other doc edit; `TODO.md` index row not touched.

## Review

*— claude-opus-5-5, 2026-10-26*

**Verdict: APPROVE-WITH-NITS** (MERGE). Nothing blocks; the nits are doc accuracy plus two cosmetic sanitiser gaps. The executor is a different model (Sonnet 5.5) from the reviewer (Opus 5.5), and this review ran in a fresh context.

**Gate** (re-run in the worktree): `bun run check` → typecheck clean, lint clean (523 files), **3132 pass / 3 skip / 0 fail** (3135 tests, 241 files). This matches Execution. The 3 skips are the opt-in ones.

**Premise table**

| Premise | Verdict |
|---|---|
| main `daemon/src/mapping.ts:249-251` maps `subagent_*` to `null` (Context symptom) | TRUE (`git diff`, the removed `case` fall-through) |
| `classifyUpdate` (client `mapping.ts:53-69` on main) treats an unknown non-mandatory type as `unsupported` and a known-but-malformed one as `error` | TRUE |
| `UPDATE_CLASS` is a `Record` keyed by the union, so a missing class is a compile error | TRUE (`updates.ts:263`, typecheck green) |
| `PROTOCOL_VERSION = 13`, unchanged | TRUE (`protocol/src/version.ts:7`) |
| A sub-agent cannot nest sub-agents | TRUE (`subagent.ts:160-166` drops the spawn tool) |
| "Progress is not replayed at re-attach … shows the tool opaque" (Preconditions) | **FALSE**: see finding 1 |
| Cancel emits `subagent_end` | TRUE: on abort the child yields `turn_end{cancelled}` (`agent.ts:715-947`), the `for await` ends normally, and `subagent.ts:220` emits the end event |

**Findings**

1. *(low, doc)* The Preconditions and Failure modes say progress "is not replayed at re-attach". In fact every streamed update, `tool_progress` included, enters the in-memory replay ring (`daemon/src/hosted-session.ts:5`, `:775-787`). So a mid-turn attach does get the tree replayed from the cut. The behaviour is better than the doc says, and it fits owner decision 3, which only asks for no *extra* work. The ring is never persisted (`persisted-session.ts` has no ring), so the Persistence invariant holds. A side cost: the frames, one per child call, use the ring's byte budget. That is small per frame.
2. *(low, doc)* Stale text still contradicts owner decision 2. Failure modes "Usage double counting" says "child usage goes only to `sessionTokens`", and Tests (tui) says "`subagent_usage` raises `sessionTokens`". The code and tests follow the owner decision; the prose should be fixed.
3. *(nit, doc)* The claim "a label never fails a turn" (`updates.ts:120-127`, client `mapping.ts:96-100`) is only true for string fields. A `tool_progress` with an empty `toolCallId`/`kind`, or with negative or non-integer counters, is a malformed known type. `classifyUpdate` then returns `error` and the turn fails. This is the same contract as the existing `agent_usage` (`updates.ts:74-78`), and the child runs on the same providers, so there is no new risk. Only the wording overstates it.
4. *(low, security-cosmetic)* `progressText` (client `mapping.ts:91-95`) strips C0, DEL and C1, which stops terminal escapes (verified: `ESC[2J`, OSC title, `\r\n` → spaces). It lets bidi controls (U+202E) and zero-width characters through. They cannot run anything, but a pod can visually reorder a label. The 200 cap counts UTF-16 units, so it can split a surrogate pair. Optional hardening.
5. *(nit)* The counters have no upper bound: `promptTokens: 1e300` parses (zod 3 `int()`, trace below) and reaches the row's `formatTokens`. A pod can show a silly number **on its own row only**. It can never reach the session total.

**Attacks tried**

- **Display class is honest**: `UPDATE_CLASS.tool_progress === "display"` (trace). An older client finds no `tool_progress` in its union, so it gets `unsupported` once and the turn goes on. Nothing waits on the frame (the result still rides `tool_call_update`), so no version bump is needed. Holds.
- **Unknown `kind`**: `{kind:"subagent_future", x:1}` parses (strip) and maps to `null`. A known kind with missing fields (`subagent_tool` with no `label`) also maps to `null`. Holds.
- **Sub-agent usage stays out of the session total and context meter**: the only consumer of `subagent_usage` is `state.ts:339-346`, which writes `sub.tokens` only. The `usage` event that feeds `sessionTokens`/`lastTurnTokens` (`state.ts:312-318`) is a separate type that the child never forwards. Mutation M-A below proves the tests guard this. The ink frame shows `↑7 ↓3`, the parent's usage only.
- **Same formatter**: the row uses `formatTokens` (`render-lines.ts:258`), the same as `StatusBar.tsx:40,93`. It renders as `◆ explore · 1 tool use · 11k` (frame).
- **Untrusted pod text**: an end-to-end trace (daemon `eventToUpdate` → `SessionUpdateSchema.parse` → client `updateToEvent`) with ESC/OSC/BEL/CRLF plus a 300-char string came out with the controls as spaces and the length capped. Bidi passes through (finding 4).
- **Lost `subagent_end`**: frames are not dropped on a live connection. Only an older client skips the whole type, and then no tree renders at all. Cancel emits the end event (premise table). What remains is a child that *throws* instead of yielding `turn_end`, which leaves `└─ …`. That case predates this task (the local path had it) and the executor recorded it as debt. Acceptable as cosmetic, not a stuck UI: the tool row itself still completes.
- **Two interleaved sub-agents**: every frame carries the parent `toolCallId` and the reducer updates per tool (`updateTool`), so the trees cannot mix. Nested sub-agents cannot happen (spawn tool dropped). *Unverified*: no test drives two parallel `agent_task` calls. The parallel-agents task should add one.
- **Persistence untouched**: no `ChatMessage`, no record field and no `DAEMON_RECORD_VERSION` change. The diff touches no persister or store file.
- **Pure modules**: the branching lives in client `mapping.ts`, `state.ts` and `render-lines.ts`, all React-free. No `.tsx` changed.

**Mutations** (`cp` backup → mutate → run → restore; `shasum` was byte-identical afterwards: `state.ts dfbeee65…`, `client/src/mapping.ts c2e2b609…`)

- M-A: `subagent_usage` also adds to `sessionTokens` (`state.ts`). **3 tests fail**: the reducer sum test, "unknown call changes nothing" and the ink frame `↑7 ↓3`.
- M-B: the sanitiser regex narrowed to `[\u0000-\u0019]`, so ESC passes through (client `mapping.ts`). **The sanitisation test fails** (`a[31mred` instead of `a [31mred`).

**What holds**: the wire is connected at both ends, the class is honest, the protocol version is correctly not bumped, the owner decisions are implemented (free `kind`, row-only tokens, same formatter, no extra replay), persistence is untouched and the tests are non-vacuous.

**How the executor behaved**: disciplined. It showed red tests before green, caught and documented its own vacuous first M2 mutation, and recorded the drifts honestly (no schema caps, the head wording, the debt). The only weakness: the Implementation prose was not updated after the owner decisions (finding 2), and one premise was never checked (finding 1).

> **Owner decisions (2026-10-26 21:40):** plan APPROVED with changes. (1) `kind` = free string, unknown kinds ignored by the client (orchestrator, forward-compat rule). (2) Sub-agent usage is NOT added to the session total (the session total = the main conversation only); instead each sub-agent shows ITS OWN tokens on its progress-tree row as a bare number, no "tok" suffix — e.g. `agent explore · 12k` — formatted exactly like the session total (same k/M rounding, shared formatter). An overall grand total (session + sub-agents) is out of scope. (3) No tree replay for a client attaching mid-turn (out of scope).

> **Orchestrator corrections (2026-10-26, from the Review):** (a) contrary to the plan text, progress updates DO reach a client re-attaching mid-turn — via the daemon replay buffer (`hosted-session.ts:775-787`, in memory only; persistence untouched). (b) Where "Failure modes"/"Tests" still mention `sessionTokens`, read them per owner decision 2: sub-agent usage never reaches the session total; the code follows the decision. Debt: bidi (U+202E) and zero-width characters are not stripped by the client sanitiser (`client/src/mapping.ts:91-95`) — visual only. **Owner (2026-10-26):** merge approved.
