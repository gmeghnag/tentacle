# fix/tool-duration — Tool rows show a daemon-measured duration, never a fake `0.0s`

> **Status:** done
> **Branch:** `fix/tool-duration`
> Type: fix · Size: M · Blast: load-bearing · Suited: strong model executes (agent loop + persisted format + wire); mandatory fresh-context Review that red-teams the on-disk record rule and the "permission wait is not tool time" property (AGENTS §7, §10)

## Context

*— claude-opus-5-5, 2026-10-26*

**Problem.** A tool row rebuilt from history (`--resume`, reconnect
`history_reset`, a session switch, a compaction replace) shows a fake `0.0s`.
`messagesToItems` stamps `startedAt: 0` (`packages/tui/src/resume.ts:31`) and
`endedAt: 0` (`resume.ts:42`). `toolLines` prints a duration whenever
`endedAt` is defined (`packages/tui/src/render-lines.ts:488-489`), so it prints
`formatDurationMs(0 - 0)` = `0.0s`. A live row is timed by the CLIENT when the
events arrive: `tool_start` stamps `startedAt: now` (`packages/tui/src/state.ts:266`),
`tool_result` stamps `endedAt: now` (`state.ts:288`), and `now` is
`Date.now()` at receipt (`packages/tui/src/App.tsx:969-971`). History carries
no timing at all: a tool `ChatMessage` is `role/content/toolCalls/toolCallId/spill`
(`packages/core/src/model.ts:28-41`). So the replayed row has nothing true to
show, and over `connect` the live value includes network latency.

**Owner decision (option A, 2026-10-26).** The DAEMON (agent side) measures each
tool call and stores the duration on the tool `ChatMessage` as display-only
metadata, like `spill` (`model.ts:35-40`). The model never sees it. The same
value rides the live update, so live and replayed rows show the same number. A
row with no measurement (an older record, a synthetic result) shows NO time.
Perf budget: two monotonic clock reads per call, nothing more.

**Repro** (`.tentacle/tmp/tool-duration/repro.ts`, run 2026-10-26 on `main` `b88c305`):

```ts
import { messagesToItems } from "../../../packages/tui/src/resume.ts";
import { applyEvent, initialState } from "../../../packages/tui/src/state.ts";
import { itemLines, stripAnsi } from "../../../packages/tui/src/render-lines.ts";
const call = { id: "c1", name: "shell", arguments: JSON.stringify({ command: "sleep 2" }) };
// 1) replayed history (resume / reattach / switch)
const replay = messagesToItems([
  { role: "user", content: "x" },
  { role: "assistant", content: "", toolCalls: [call] },
  { role: "tool", content: "ok", toolCallId: "c1" },
] as never);
console.log("REPLAY:", stripAnsi(itemLines(replay[1] as never, { width: 80 })[0] ?? ""));
// 2) live: tool_start at t=1000, tool_result at t=3000
let s = applyEvent(initialState as never, { type: "tool_start", ...call } as never, 1000);
s = applyEvent(s, { type: "tool_result", id: "c1", name: "shell", result: { content: "ok", isError: false } } as never, 3000);
const t = s.items.find((i) => i.kind === "tool");
console.log("LIVE:  ", stripAnsi(itemLines(t as never, { width: 80 })[0] ?? ""));
```

```
$ bun .tentacle/tmp/tool-duration/repro.ts
REPLAY: ⏺ Bash sleep 2 0.0s
LIVE:   ⏺ Bash sleep 2 2.0s
```

After the fix: REPLAY with no stored duration prints `⏺ Bash sleep 2` (no time);
with `durationMs: 2000` on the tool message it prints `… 2.0s`; LIVE prints the
`durationMs` the `tool_result` event carries, not `3000 - 1000`.

## Implementation

*— claude-opus-5-5, 2026-10-26*

### Load-bearing assumption

**The tool's own run is a separate, bracketable call that comes after the
permission prompt.** If authorization and execution were mixed into one call,
we could not exclude the prompt wait without a big change. They are not mixed.
`runToolCalls` calls `runTool` (`packages/agent/src/agent.ts:767`).
`runTool` first awaits `this.gate.authorize(...)` (`agent.ts:912-916`). This
covers both the `tool_call` pre-hooks and the permission prompt: the outcome
can be `by === "hook"` (`:925`) or `by === "unavailable"` (`:940`), or a user
denial (`:949`). Only after the gate does it call `this.config.tools.execute`
(`:959` unmodified, `:962` hook-modified). An unknown tool skips the gate
(`:909-910`). So we read the clock right before each `execute` and right after
it, and we measure exactly the tool's run. The prompt wait and the pre-hooks are
excluded by construction.

### Preconditions

- **Providers never serialize unknown message fields (zero context cost).**
  OpenAI `toWireMessage` copies `role`, `content`, `tool_calls` and
  `tool_call_id` only (`packages/providers/src/openai-provider.ts:217-229`).
  Anthropic copies `toolCallId`→`tool_use_id` and `content` only
  (`packages/providers/src/anthropic-provider.ts:301-321`). The pod
  reverse-tunnel `toWireRequest` copies field by field
  (`packages/daemon/src/proxy-model.ts:47-62`) into `WireChatMessageSchema`,
  which has no metadata (`packages/protocol/src/model.ts:19-24`). The
  `model_request` hook sends `{ role, content }` only (`packages/agent/src/hooks.ts:710`).
  The compaction transcript uses `renderMessage` (`packages/agent/src/compact.ts:25`),
  which takes role and content. This is the same proof the `spill` comment cites
  (`agent.ts:106-110`).
- **`tool_call_update` is `display`** (`packages/protocol/src/updates.ts:227`),
  and its schema is a strip object (`updates.ts:50-57`; file comment `:5-7`).
  `ChatMessageSchema` is strip too (`packages/protocol/src/session.ts:32-39`).
  An older peer drops an unknown optional field. This is the forward-compat
  rule (AGENTS §7), so there is **no `PROTOCOL_VERSION` bump**: it stays `11`
  (`packages/protocol/src/version.ts:7`). The `spill` feature added the same two
  fields with no bump (`docs/feat/tui-spill-note.md:245`, `:614`).
- **The laptop session store is strict, with no version.** `MESSAGE_KEYS`
  (`packages/agent/src/session-store.ts:213`) rejects any unknown key
  (`:248-251`). `spill` was added by extending the key set and adding a value
  check (`:215-217`, `:275-277`), and an older build refuses such a record
  loudly. The comment at `:211-212` says the key set mirrors the wire
  `ChatMessageSchema`, and `cli/test/session-resume.test.ts:282` pins the key
  list.
- **The daemon record reuses that strict message parser, and its shape is
  versioned.** `parseDaemonRecord` runs on a record "the session store already
  validated … strict messages" (`packages/daemon/src/persisted-session.ts:183-193`).
  `DAEMON_RECORD_VERSION = 5` (`:30`). `READABLE_VERSIONS = [1,2,3,4,5]` (`:32`).
  An unknown version is refused (`:201-206`). Precedent: `spill` bumped 4→5
  (`:26-28`), "a v4 daemon refuses every v5 record instead of dropping a spill at
  its next write".
- **History is message-identity-preserving.** The only constructors of tool
  messages are `toolMessage` (`agent.ts:111-118`), the cancel note
  (`agent.ts:745-749`), the compaction skill carry-over (`compact.ts:245`) and the
  restart notes (`persisted-session.ts:469`). Nothing else rebuilds tool messages
  field by field, so a field set in `toolMessage` reaches the snapshot, the
  record and `session/open{messages}` the same way `spill` does
  (`client/test/remote.test.ts:1512-1561` proves that path for `spill`).
- **Sub-agent progress never crosses the wire.** `subagent_start`,
  `subagent_tool` and `subagent_end` map to `null` (`packages/daemon/src/mapping.ts:224-234`).
  The child's rows are bare labels (`packages/agent/src/subagent.ts:194-196`;
  `ToolProgressEvent`, `packages/core/src/tool.ts:70-73`). They are out of scope.
- **A running tool row shows no timer today.** The only timing render is
  `render-lines.ts:488-489` (on `endedAt`). `ToolItem.startedAt`/`endedAt`
  (`state.ts:64-65`) are read nowhere else in `src`. So "what does the spinner
  show while running" is not a question here: nothing changes while running.

### Design

**1. What is measured (Q1).** It is the wall time of `this.config.tools.execute(...)`
for that call, read on a monotonic clock. Each of the three execute sites in
`runTool` is bracketed: unknown tool `agent.ts:910`, unmodified `:959`,
hook-modified `:962`. `runTool` returns `{ result, input, durationMs? }`.

- **Clock.** Add `AgentConfig.now?: () => number` (`agent.ts:203-229`),
  defaulting to `performance.now` (monotonic in Bun). It is injectable so tests
  are deterministic. The value is `Math.round(end - start)`, in integer ms ≥ 0.
  That is two clock reads per executed call and nothing else (owner perf
  constraint).
- **The permission prompt and `tool_call` pre-hooks are EXCLUDED.** They both
  live in `gate.authorize` (`:912`), which finishes before the first clock read.
- **`transformResult` (spill / summarise / `tool_result` hooks) is EXCLUDED.**
  *Recommendation:* the row says how long the TOOL ran. A transform is harness
  overhead. `summarizeLargeOutput` makes a model call per large result
  (`packages/agent/src/result-pipeline.ts:238-261`), and post-tool hooks run
  there (`agent.ts:886`). Counting those would show "the tool was slow" when it
  wasn't. (If the owner prefers end-to-end "time until the model sees it", move
  the end read after `transformResult` at `:772-775`. That is a one-line change.)
- **The sub-agent (`agent_task`) is the one leak.** Its `execute` runs a whole
  child loop, so its duration includes the CHILD's own permission prompts (the
  child gets `requestPermission`, `subagent.ts:172`). Excluding them would
  need a pause-accounting seam through `ToolContext` into the child's gate. →
  **Owner decision Q-A** (below). *Recommendation:* accept it for now and
  document it: the `agent_task` row is the delegated task's wall time.

**2. Which results get a duration (Q2).** The rule: **a duration exists iff
`tools.execute` (or the skill activator) actually ran.**

| Result | Where | Duration |
|---|---|---|
| Normal run (ok or tool error) | `agent.ts:959/962` | yes |
| Unknown tool (registry error) | `:910` | yes. `execute` ran; it is ~0 ms and true |
| Cancelled before start (`CANCELLED_TOOL_NOTE`) | `:739-757` | **no** |
| Cancelled after authorize (approval landed after abort) | `:921-923` | **no** |
| Denied by user / hook-blocked / permission unavailable | `:924-956` | **no** |
| Tool threw → registry error | inside `execute` | yes (as measured) |
| Suspended-turn resume (`resumeFrom`) | re-runs via `runToolCalls` (`agent.ts:374-378`) | yes, the new run's time |
| Restart notes (`NOT_RUN` / `INTERRUPTED`) | `persisted-session.ts:469` | **no** |
| User `/skill` round | `runUserSkill`, `agent.ts:813-817` | yes, bracketing `activator.activate(...)` only (not its `transformResult`). No when cancelled (`:806`), no activator (`:808`), or aborted mid-read (`:819-822`) |
| Model's `skill` tool | normal path | yes |
| Compaction skill carry-over | `compact.ts:245` | **no**: a re-load, not a run |

**3. The path end to end (Q3).** The value rides beside the result, not inside
`ToolResult`. A tool must never be able to set it. The agent sets it after the
run, so `ToolResult` (`core/src/tool.ts:~51`) is unchanged.

- `agent.ts:140-145`: the `tool_result` `AgentEvent` gains `readonly durationMs?: number`.
- `agent.ts:111-118`: `toolMessage(callId, result, durationMs?)` adds
  `...(durationMs !== undefined ? { durationMs } : {})`.
- `agent.ts:776-777` and `:829-830` pass it through. The cancel at `:745-755`
  passes nothing.
- `core/src/model.ts:28-41`: `ChatMessage.durationMs?: number`, with a doc
  comment ("display only; provider mappers copy field by field, the model never
  sees it").
- `protocol/src/updates.ts:50-57`: `ToolCallUpdateSchema.durationMs:
  z.number().int().nonnegative().optional()`. `protocol/src/session.ts:32-39`:
  the same on `ChatMessageSchema`. Both are strip, additive and display. **No
  `PROTOCOL_VERSION` bump.** `UPDATE_CLASS` is unchanged (no new update kind).
- `daemon/src/mapping.ts:203-210`: `...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {})`.
  `HostedSession` forwards `eventToUpdate` output unchanged. It needs no edit.
- `client/src/mapping.ts:169-179`: the same, back onto the event.
- TUI (all pure modules; no component changes):
  - `tui/src/state.ts:52-68`: `ToolItem` **replaces `startedAt`/`endedAt`
    with `durationMs?: number`**. Client timing has no remaining reader once
    the row shows the daemon's value (Q7). The `tool_start` (`:259-269`) and
    `tool_result` (`:271-299`) reducers stop stamping time, and `tool_result`
    copies `event.durationMs` when present.
  - `tui/src/resume.ts:31,42`: drop the `0` stamps and copy `m.durationMs`
    when present.
  - `tui/src/render-lines.ts:488-489`: `tool.durationMs !== undefined ? \` ${formatDurationMs(tool.durationMs)}\` : ""`.
- Sub-agent progress rows: none (they never cross the wire, see Preconditions).
- `cli/src/render.ts:18` (the non-TUI line renderer) is untouched. It can
  ignore the field.

**4. Persistence (Q4).** We follow the `spill` precedent exactly.

- Laptop store: add `"durationMs"` to `MESSAGE_KEYS` (`session-store.ts:213`)
  and add a check in `messageProblem` (`:244-279`):
  `value.durationMs !== undefined && !isCount(value.durationMs)` →
  `"has a malformed durationMs"`. This reuses `isCount` (`:222`, zod 3
  `.int().nonnegative()` parity). The store has no version. An older build
  refuses a record holding the key loudly (`unknown key "durationMs"`) and
  never half-loads it.
- Daemon record: **`DAEMON_RECORD_VERSION` 5 → 6**, with
  `READABLE_VERSIONS = [1,2,3,4,5,6]` (`persisted-session.ts:30-32`). Extend the
  comment: "6: a tool message may carry `durationMs` (docs/fix/tool-duration.md):
  a v5 daemon refuses every v6 record instead of dropping durations at its next
  write. A v1–v5 record reads as a v6 one with no durations." Check that no
  version-gated read is bound to the current constant: the spill task's
  Drift-1 trap (`docs/feat/tui-spill-note.md:699-709`). Today only `:84`,
  `:113`, `:261` use `DAEMON_RECORD_VERSION`. `CHOSEN_TITLE_VERSION = 3` (`:34`)
  and `STEER_IDS_VERSION = 4` (`:36`) are pinned. The executor re-greps.
- **Version ordering:** this task goes FIRST and takes **6**. The pending plans
  that also claim 6 (`plans/context-awareness.md:331`, `plans/permission-reply.md:481`,
  and parallel-tools `inFlight`) must rebase to 7, 8, … in merge order. The
  owner/orchestrator updates those plans when this one merges.

**5. Pods (Q5).** In `run`/`attach` the duration is pod-supplied. It is
display-only data with no laptop effect: it opens no prompt, writes no file,
grants no approval and goes into no model request (the providers and
`proxy-model.ts:47-62` drop it). The laptop validates it at the boundary (zod
`int().nonnegative()` on the wire; `isCount` in the laptop store when the main
thread persists its snapshot copy). The worst a hostile pod can do is show a
wrong number on its own rows, which it can already do with the result text.
**No gate is needed.** The `ProxyModelProvider` path is unchanged.

**6. Compaction / snapshot (Q6).** A compaction drops every ordinary tool message
(`compactedHistory`, `compact.ts:228-248`, keeps system + summary + skill
carry-overs). There is no kept tool message to lose a field. The re-created skill
rounds get none (correct: not a run). Snapshot and `session/open{messages}` both
parse through `ChatMessageSchema`, so adding the field there is what keeps it
(the strip schema would silently DROP it otherwise). This is pinned by a protocol
test and the real-stack test below.

**7. Where logic goes (Q7).** `state.ts`, `resume.ts` and `render-lines.ts` are
already pure, React-free, unit-tested modules. The "show or hide" decision is
one ternary in `toolLines` and stays there. No component changes.
*Recommendation:* **live rows use the daemon value only, with no client
fallback.** Today a running row shows no timer (Preconditions), so there is no
spinner timing to keep. Every daemon of this build sends `durationMs` on a
measured result. A result without it is by definition unmeasured (a synthetic
note), and it shows no time, the same as on replay. Pre-public: no compat shim
for an older daemon (AGENTS §7).

### Files

In dependency order:

1. `packages/core/src/model.ts`: `ChatMessage.durationMs?`.
2. `packages/protocol/src/updates.ts`, `packages/protocol/src/session.ts`: the
   optional field on `ToolCallUpdateSchema` and `ChatMessageSchema`.
3. `packages/agent/src/agent.ts`: `AgentConfig.now`, the event field,
   `toolMessage`, the brackets in `runTool` (3 sites) and in `runUserSkill`,
   and the pass-through at `:776-777` and `:829-830`.
4. `packages/agent/src/session-store.ts`: the key and its check.
5. `packages/daemon/src/mapping.ts`: the event → update copy.
   `packages/daemon/src/persisted-session.ts`: v6.
6. `packages/client/src/mapping.ts`: the update → event copy.
7. `packages/tui/src/state.ts`, `resume.ts`, `render-lines.ts`: the field
   replaces `startedAt`/`endedAt`.
8. Tests (below), plus the existing tests that hard-code `startedAt`/`endedAt`
   (about 50 refs: `tui/test/render-lines.test.ts` 24, `cli/test/serve-limits.test.ts`
   10, others 1–4 each) and the record-version and key-list expectations
   (`daemon/test/persistence.test.ts:1463` and the V5 block,
   `cli/test/session-resume.test.ts:282`).
9. `docs/fix/tool-duration.md` (this doc) and the `TODO.md` entry.

### Failure modes

| Case | Convergence |
|---|---|
| Old laptop record / v1–v5 daemon record (no field) | It loads. Rows show no time (never `0.0s`). |
| v5 daemon finds a v6 record | Refused, file untouched (`persisted-session.ts:201-206`), or refused earlier by the store's `unknown key "durationMs"`. Loud, never half-loaded. |
| Older laptop build reads a new laptop record | `unknown key "durationMs"`: loud refusal, the same as `spill`. |
| Older client / mobile on a new daemon | The strip schema drops the field and the row shows the client's own receipt timing (old behaviour). No bump. |
| Malformed value (negative, float, string) from a peer | The frame/message fails zod. The record fails `isCount` → refused loudly. No silent coercion. |
| Tool throws inside `execute` | The registry converts it to an error result. The end read still happens after the await (bracket with `try/finally` or read after `execute` resolves; the registry never rejects, so a plain read suffices; the executor verifies `ToolRegistry.execute` catches). |
| Abort while the tool runs | `execute` returns (the tool honours the signal). The measured time up to its return is shown. That is honest: the tool ran that long. |
| Approval lands after cancel | `:921-923` returns before `execute` → no duration. |
| Clock skew between daemon and laptop | None: the value is a daemon-local monotonic delta. |
| Sub-agent with child prompts | Includes the child's prompt waits (Q-A). Documented. |

### Tests

Red first on today's `main`; each one gets a named mutation (AGENTS §9).

1. **`tui/test/resume.test.ts` (or `render-lines.test.ts`)**, replay without a
   duration: `messagesToItems` → `itemLines` header has **no** `0.0s` and no
   `\d+\.\ds` suffix. Red today (prints `0.0s`). Mutation: restore `endedAt: 0` →
   fails.
2. **Same file**, replay with `durationMs: 2000` on the tool message → the
   header ends `2.0s`. Red today (the field is ignored, prints `0.0s`).
   Mutation: drop the copy in `resume.ts` → fails.
3. **`tui/test/state.test.ts`**, live row uses the daemon value:
   `applyEvent(tool_start, now=1000)`, then `applyEvent(tool_result{durationMs: 450}, now=3000)`
   → `durationMs === 450` and the header shows `0.5s` (not `2.0s`). Red today.
   A `tool_result` without `durationMs` → no time. Mutation: compute
   `now - startedAt` → fails.
4. **`agent/test/agent.test.ts`, permission wait excluded.** Use a fake clock
   (`now: () => t`). `requestPermission` advances `t += 5000` and approves. The
   `ask` tool's `execute` advances `t += 200`. Assert the `tool_result` event's
   `durationMs === 200` and the pushed tool message's `durationMs === 200`. Red
   today (no field). Mutation: move the start read above `gate.authorize` →
   `5200` → fails. A second case: a `tool_result` hook / transform that
   advances `t += 1000` still gives `200` (mutation: end read after
   `transformResult` → fails).
5. **Same file, no duration for synthetic results.** Denied
   (`requestPermission` → `{ allowed: false }`), hook-blocked, cancelled before
   start (the existing `:470-509` setup), approval-after-cancel: the
   `tool_result` event and the tool message have **no** `durationMs` key.
   Mutation: stamp a duration on every `toolMessage` → fails.
6. **`agent/test/agent.test.ts`, user skill round:** a stub activator advancing
   `t += 30` → `durationMs === 30`. Cancelled → absent.
7. **`protocol/test/` (next to `spill.test.ts`):** `durationMs` is kept on
   `tool_call_update`, `ChatMessageSchema`, `SnapshotResultSchema` and
   `OpenParamsSchema`. `-1`, `1.5` and `"2"` make the frame invalid. Mutation:
   drop the field from `ChatMessageSchema` → the snapshot case fails.
8. **`client/test/remote.test.ts` real stack** (mirror `:1512-1561`): a tool
   with a fake `now` → the live `tool_result` event AND the later snapshot's
   tool message both carry the same `durationMs`. Mutation: drop it from
   `daemon/src/mapping.ts` → the live assertion fails; drop it from
   `ChatMessageSchema` → the snapshot assertion fails.
9. **`cli/test/session-resume.test.ts`, laptop store round-trip:** a record
   with `durationMs: 1234` parses and keeps it. `-1`, `1.5` and `"x"` are
   refused (`malformed durationMs`). A record without it loads. The key-list
   pin (`:282`) includes `durationMs`. Mutation: drop `"durationMs"` from
   `MESSAGE_KEYS` → the round-trip fails with `unknown key`.
10. **`daemon/test/persistence.test.ts` V6 block** (mirror V5-1..3 at
    `:2423-2515`): writes `schemaVersion: 6`. v7 is refused. v1–v5 read as v6
    with no durations. A restart keeps the field: the disk bytes pass the
    store's strict parser, and the snapshot after reload carries it. Mutation:
    `DAEMON_RECORD_VERSION = 5` → V6-1 fails; drop the store key → V6-3 fails.
11. **Repro re-run** (Context) shows the after-fix lines.

Gate before done: `bun run check` (typecheck → lint → test), against the clean
lint baseline (AGENTS §6).

### Owner decisions

- **Q-A, sub-agent child prompts:** the `agent_task` duration includes the
  child's permission waits (excluding them needs a pause-accounting seam).
  *Recommend:* accept and document it; open a follow-up only if it bothers in
  practice.
- **Q-B, `transformResult`:** excluded (the tool's own time; summarise is a
  model call). *Recommend:* exclude.
- **Q-C, live fallback:** the daemon value only, with no client receipt-time
  fallback; `ToolItem.startedAt/endedAt` are removed. *Recommend:* yes
  (pre-public, one source of truth). The cost is about 50 mechanical test edits.
- **Q-D, record version:** this task takes v6; context-awareness,
  permission-reply and parallel-tools renumber to 7+ in merge order.
  *Recommend:* yes.

### Owner answers

*— recorded by the orchestrator (claude-opus-5-5), 2026-10-26*

All four recommendations accepted; the plan is APPROVED as written.

- **Q-A:** accepted — the `agent_task` duration includes the child's
  permission waits ("start to finish" of the delegated work); documented,
  no pause-accounting seam (owner: "sisi").
- **Q-B:** `transformResult` (spill, summarise, post-tool hooks) excluded
  (owner: "si").
- **Q-C:** the daemon value only; the TUI's own timing (`startedAt` /
  `endedAt`) is removed (owner: "usare solo il valore del daemon ed eliminare
  il cronometro della TUI").
- **Q-D:** this task takes `DAEMON_RECORD_VERSION` 6; context-awareness,
  permission-reply and parallel-tools renumber to 7+ in merge order (owner:
  "ok").

## Execution

*— claude-opus-5-5, 2026-10-26*

### 0. Baseline and repro (before any edit)

- Gate on `fix/tool-duration` = `main` `b88c305`: `bun run check` → typecheck
  clean, `biome check .` clean (476 files), **2755 pass / 2 skip / 0 fail**.
- Context repro, today's code (`bun run .tentacle/tmp/tool-duration/repro.ts`):
  ```
  REPLAY: ⏺ Bash sleep 2 0.0s
  LIVE:   ⏺ Bash sleep 2 2.0s
  ```
  Reproduces. Every Implementation premise was re-verified at its `file:line`
  before editing; all held (agent.ts `runTool` gate-then-execute at
  `:903-973`, the 3 execute sites, `runUserSkill` `:813-827`; `ToolRegistry.execute`
  catches every throw (`tools/src/registry.ts:77-81`), so a plain clock read
  after the `await` suffices; only `:84`, `:113`, `:261` use
  `DAEMON_RECORD_VERSION`, the v3/v4 gates are pinned constants).

### 1. Tests written first, shown RED on the buggy code (on the assertion)

| Test | Red evidence on `b88c305` |
|---|---|
| `tui/test/resume.test.ts` replay w/o duration | `Expected "⏺ Bash sleep 2"`, `Received "… 0.0s"` |
| same, replay with `durationMs: 2000` | `durationMs` `Expected 2000 Received undefined` |
| `tui/test/state.test.ts` live uses daemon value (450) | `Expected 450 Received undefined` |
| same, live w/o `durationMs` shows no time | `Received "⏺ Bash sleep 2 2.0s"` |
| `agent/test/tool-duration.test.ts` (new): permission wait excluded, transforms excluded, pre-hook excluded, unknown tool → 0, default clock integer, `/skill` read → 30 | 6 × `Received undefined` / `isInteger(undefined)` |
| `protocol/test/tool-duration.test.ts` (new): kept on update/message/snapshot/open; `-1`, `1.5`, `"2"`, `null`, `NaN` invalid | `Received undefined`; malformed frame `Received true` (stripped) |
| `cli/test/session-resume.test.ts`: parity cases, key-list pin, round-trip + `malformed durationMs` | 7 fails, e.g. `message 0 has unknown key "durationMs"` |
| `daemon/test/persistence.test.ts` V6-1..3 | `written 5 ≠ 6`; v1–v5 read as `5 ≠ 6`; live update has no integer |
| `client/test/remote.test.ts` real stack | live `durationMs` `Received undefined` |
| `daemon/test/mapping.test.ts`, `client/test/mapping.test.ts` | the field missing on update / event |

Green on both by design (property/precondition pins, validated by mutation
below instead): the 5 "synthetic results carry none" agent cases and "/skill
cancelled → none"; `providers/test/tool-duration.test.ts` (new: OpenAI body
byte-identical with/without, Anthropic payload identical) and the
`proxy-model.test.ts` wire-request case; the protocol "older peer drops it;
`UPDATE_CLASS.tool_call_update === "display"`; `PROTOCOL_VERSION === 11`" case
(the no-bump proof: a schema without the field still parses the new frame).

### 2. Implementation, in plan order

1. `core/src/model.ts:41-46` — `ChatMessage.durationMs?` (doc: display only).
2. `protocol/src/updates.ts:57-58`, `protocol/src/session.ts:39-40` —
   `durationMs: z.number().int().nonnegative().optional()` on
   `ToolCallUpdateSchema` and `ChatMessageSchema`. No `PROTOCOL_VERSION` bump
   (stays 11), no new update kind.
3. `agent/src/agent.ts`:
   - `toolMessage(callId, result, durationMs?)` `:112-120`; new internal
     `ToolRun { result; durationMs? }` `:122-126`.
   - `tool_result` `AgentEvent.durationMs?` `:154`; `AgentConfig.now?` `:239-245`.
   - `private timed(work)` `:936-945`: `now()` → `await work()` → `now()`,
     `Math.max(0, Math.round(end - start))`, default `() => performance.now()`.
   - `runTool` `:954-1026`: the 3 `execute` sites wrapped in `timed` (unknown
     tool, unmodified, hook-modified); every synthetic return (cancelled after
     authorize, hook-blocked, unavailable, denied) carries no duration. The
     gate call and call order are unchanged — the round still suspends only in
     `authorize`.
   - `runToolCalls` `:788-801`: `durationMs` destructured from `runTool`,
     `transformResult` runs after (excluded, Q-B), event + message get it. The
     cancelled-before-start note `:756-774` unchanged (no duration).
   - `runUserSkill` `:817-870`: only `activator.activate` is timed; the
     transform is not; cancelled / no activator / aborted mid-read / error
     paths carry none.
4. `agent/src/session-store.ts:213-215,280-282` — `"durationMs"` in
   `MESSAGE_KEYS` + `isCount` check → `has a malformed durationMs`.
5. `daemon/src/mapping.ts:210` — event → update copy (incl. `0`).
   `daemon/src/persisted-session.ts:29-35` — v6 comment,
   `DAEMON_RECORD_VERSION = 6`, `READABLE_VERSIONS = [1, 2, 3, 4, 5, 6]`.
6. `client/src/mapping.ts:179-180` — update → event copy, beside `result`
   (never inside it: a tool cannot set it).
7. TUI (pure modules only; no component touched): `state.ts:63-65`
   `ToolItem.startedAt/endedAt` → `durationMs?`; `tool_start` no longer stamps
   time, `tool_result` copies `event.durationMs` only (`:287`); `resume.ts`
   drops both `0` stamps and copies `m.durationMs` (`:44`);
   `render-lines.ts:488` shows a time iff `durationMs` is defined.
8. Existing tests updated (mechanical): `startedAt: 0, endedAt: N` →
   `durationMs: N` (render-lines 13, read-highlight 2, idle-warm, commands);
   lone `startedAt` removed (render-lines, state); `state.test.ts:89`
   `endedAt` defined → no `durationMs` key (the event carried none); record
   version 5 → 6 / "v6 refused" → "v7 refused" (persistence U2, `:1313`,
   fixtures `:1094/:1163/:1283`, `:2175`, V5-1..3; session-list `:397`;
   session-titles D6; serve-persistence `:134/:200`, A11 `newer` → v7);
   key-list pin now includes `durationMs`. The old V5-1 ("written as v5; v6
   refused") became "a v5 record still reads as v6" — its write/refuse half
   moved to V6-1.
9. `TODO.md` entry: status line + link to this doc.

### 3. Mutations (AGENTS §9) — each red, each reverted

| # | Mutation | Failed |
|---|---|---|
| M1 | start read above `gate.authorize` | permission-wait test: `Received 5200` |
| M2 | end read after `transformResult` | transforms test: `Received 1200` |
| M3 | `toolMessage` always stamps `durationMs ?? 0` | denied, hook-blocked, approved-after-cancel, `/skill` cancelled |
| M3b | `durationMs: 0` on the cancelled-before-start note | cancelled-before-start |
| M4 | drop the duration from `runUserSkill` | `/skill` read: `Received undefined` |
| M5 | drop the field from `ChatMessageSchema` | protocol keep + malformed cases; real-stack **snapshot** assertion |
| M6 | drop the copy in `daemon/src/mapping.ts` | daemon mapping; real-stack **live** assertion; V6-3 |
| M7 | drop the copy in `client/src/mapping.ts` | client mapping; real-stack live |
| M8 | drop `"durationMs"` from `MESSAGE_KEYS` | parity, key-list, round-trip (`unknown key`), V6-3 |
| M8b | disable the `isCount` check | `-1`/`1.5`/`"x"` parity + `malformed durationMs` |
| M9 | `DAEMON_RECORD_VERSION = 5` | V6-1, V6-2, V6-3 |
| M10 | `resume.ts`: `durationMs: m.durationMs ?? 0` | replay shows `0.0s` again |
| M11 | `resume.ts`: drop the copy | replay with 2000; app idle-warm probe |
| M12 | `state.ts`: `durationMs: now - 1000` (receipt timing) | live 450 → `2000`; no-duration case gets a key |
| M13 | OpenAI `toWireMessage` spreads the message | body differs (`"durationMs":1234`) |
| M14 | `proxy-model.ts` `toWireRequest` copies it | wire request differs |
| M15 | Anthropic `tool_result` block copies it | payload differs |

Reverts proven byte-identical: `shasum` of the 10 mutated sources before =
after (e.g. `agent.ts 5b0ec72b…`, `session-store.ts 0460efb2…`,
`protocol/src/session.ts f25d2584…`, `persisted-session.ts 46d8cb6f…`), and
`git status --short` lists no change under `providers/src/` or
`daemon/src/proxy-model.ts` (M13–M15 left no trace).

### 4. After the fix

Repro (extended in `.tentacle/tmp/tool-duration/repro.ts` with the two
after-fix cases the Context promised; LIVE+ uses 450 so it cannot be confused
with the 2000 ms receipt delta):

```
REPLAY: ⏺ Bash sleep 2
LIVE:   ⏺ Bash sleep 2
REPLAY+: ⏺ Bash sleep 2 2.0s
LIVE+:   ⏺ Bash sleep 2 0.5s
```

(`LIVE` = the original event with no `durationMs` → no time: the old
receipt-time fallback is gone, Q-C.)

Gate: `bun run check` → typecheck clean, `biome check .` clean (479 files,
0 errors / 0 warnings — the baseline), **2789 pass / 2 skip / 0 fail**
(+34 tests vs 2755; the 2 skips are the same opt-in live-k8s and slow
keepalive tests).

### 5. Drift and decisions taken during execution

- **Agent tests live in a new file** `agent/test/tool-duration.test.ts`, not
  in `agent.test.ts` (one place for the property; the hook/skill fixtures it
  needs are not in `agent.test.ts`). Added cases beyond the plan: a passing
  `tool_call` pre-hook advancing the clock 3000 ms is excluded; the unknown
  tool is measured (`0`); the default real clock gives an integer ≥ 0.
- **Extra precondition tests the plan did not list**: provider bodies
  (OpenAI, Anthropic) and the pod reverse-tunnel wire request are byte-identical
  with and without `durationMs` — the "never reaches the model" proof is now
  executable (M13–M15), not only cited. `agent.test.ts:79-117` now injects
  `now: () => 0` and expects `durationMs: 0` on the in-memory `ChatRequest`
  message: the field IS on the provider's input object; it is the mappers that
  drop it.
- **`agent.test.ts` `observe` helper** (history_commit cut) now expects the
  message to carry the event's `durationMs` — event and message must agree.
- **`schema/protocol.json` regenerated** (`bun run schema:export`): the
  committed JSON-Schema drift gate (`protocol/test/json-schema.test.ts`)
  failed on the new field. Not in the plan's file list.
- **`tui/test/app.test.tsx` idle-warm test**: it counts layouts by spying on
  `formatDurationMs` and only worked because replayed rows printed the fake
  `0.0s`. Its 6 fixture tool messages now carry `durationMs: 100 * i`, so the
  probe still counts every header (red under M11, which proves it still
  measures layouts).
- **`Math.max(0, …)`** on the measured value: the default clock is monotonic,
  but an injected one could step back; this keeps the value inside the wire's
  `nonnegative()` instead of making the frame invalid.
- **`runUserSkill` restructure**: the `unlessAborted(...).catch(...)` chain now
  resolves to a `ToolRun`; a cancel or error after the read finished carries
  no duration (the result is a note, not the read's output).
- **The plan's mutation "restore `endedAt: 0`"** no longer applies (the field is
  gone); M10 (`?? 0` fallback) is its equivalent, and the test comments name
  the mutations actually run.

### 6. Open items for the owner / Review

- **Q-A (accepted) in code**: an `agent_task` row's duration includes the
  child's own permission waits. No test pins it (it follows from timing the
  whole `execute`).
- **Version renumbering** of context-awareness, permission-reply and
  parallel-tools plans to `DAEMON_RECORD_VERSION` 7+ is the orchestrator's,
  at merge (Q-D) — not done here.
- **Unverified end to end**: the laptop main thread persisting a snapshot
  that carries `durationMs` through `JsonSessionStore` and back on
  `--resume`. Covered piecewise (store round-trip, snapshot carries it,
  `messagesToItems` shows it); verify with a real `tentacle -i` turn → quit →
  `--resume` and check the row shows its time.
- `.tentacle/tmp/tool-duration/App.tsx.bak` pre-existed (not created by this
  run) and was left untouched.

## Review

*— claude-opus-5-5 (fresh context), 2026-10-26. **Same model as the executor**
(only the context is fresh): shared blind spots can survive both passes; a
load-bearing task would ideally get a different model as well (AGENTS §10).*

### Verdict: **APPROVE-WITH-NITS** (merge)

No correctness defect found. The clock brackets only `tools.execute` /
`activator.activate`; every synthetic result carries no duration; the field
never reaches a provider body; persistence and wire follow the `spill` precedent
exactly. The nits below need no code change before merge.

### Gate (re-run by the reviewer)

`bun run check` on the uncommitted tree: typecheck clean (incl. `apps/mobile`),
`biome check .` 479 files, 0 errors / 0 warnings (baseline), **2789 pass /
2 skip / 0 fail** (2791 tests, 216 files). The 2 skips are the opt-in live-k8s
and slow-keepalive tests. Matches Execution.

### Findings

1. **Nit — the field IS on the in-memory `ChatRequest.messages`**
   (`agent.ts:112-120`; the e2e trace below prints the second request's tool
   message keys `role, content, toolCallId, durationMs`). "The model never
   sees it" rests only on the field-by-field mappers
   (`openai-provider.ts:217-229`, `anthropic-provider.ts:301-321`,
   `proxy-model.ts:47-62`). This is the same design as `spill`, and it is now
   pinned by `providers/test/tool-duration.test.ts` and the `proxy-model` case
   (M13–M15). A future provider that spreads `...message` would leak it; the
   provider test is the guard. No change needed.
2. **Nit — the record-version bump is redundant for safety but consistent.** A
   v5 build already refuses a v6 record that holds a `durationMs`: the strict
   store parser rejects it with `unknown key "durationMs"`
   (`session-store.ts:215`). The bump also refuses v6 records that hold *no*
   duration (sessions without a tool run) on a downgrade. That is the same
   trade-off as `spill` (4→5, `persisted-session.ts:26-28`), and it keeps the
   "version says the shape" rule simple. Keep it as is (Q-D).
3. **Nit — the Execution's revert proof hash for `agent.ts` is stale.** It records
   `5b0ec72b…`, but the file on disk is `caf12f90…` (the diff is the one
   reviewed here). The other three hashes I checked match
   (`session.ts f25d2584…`, `persisted-session.ts 46d8cb6f…`). The file was
   probably edited (formatted?) after it was hashed. My own mutation/revert
   proof below covers it.
4. **Info — Q-A has no test.** The `agent_task` duration includes the child's
   permission waits. That follows from timing the whole `execute`; it is
   owner-accepted and documented. No test is needed for an accepted leak.
5. **Info — still unverified end to end:** the real `tentacle -i` → quit →
   `--resume` path through `JsonSessionStore`. It is covered piecewise (store
   round-trip, snapshot carries it, `messagesToItems` shows it). Verify it once
   manually, as Execution §6 says.
6. **TODO.md merge risk: low.** The branch touches only the tool-duration entry
   (+4 lines after line 1027). `main` `3382853` (docker-runtime eval) inserts
   5 lines at line ~1011, a separate hunk ~15 lines earlier with untouched
   context between them, so a clean merge is expected. I did not run a
   `git merge-file`; it needed an approval this run did not have.

### Premise table

| Premise (Implementation) | Verdict |
|---|---|
| Context symptom: replayed row `0.0s` (`resume.ts:31,42` stamps `0`; `render-lines.ts:488-489`) | TRUE: the old lines are visible in the diff; the executor's repro output matches |
| `runTool` = gate then execute; 3 execute sites; unknown tool skips the gate | TRUE (`agent.ts:954-1026` now); synthetic returns at `:970-1004` carry no duration |
| Providers / proxy copy field by field; `model_request` hook sends `{role, content}` | TRUE (`proxy-model.ts:49-61`, `hooks.ts:710`, `compact.ts:25`); no `JSON.stringify(message)` path in `agent`/`providers`/`daemon` src |
| `tool_call_update` display + strip; `ChatMessageSchema` strip; no `PROTOCOL_VERSION` bump | TRUE: additive optional fields only; `schema/protocol.json` gains exactly the 2 `durationMs` blocks |
| Strict laptop store; `isCount` = zod `.int().nonnegative()` | TRUE (`session-store.ts:215,224,280-282`) |
| Daemon record versioned; only `:87/:116/:264` use the constant; v3/v4 gates pinned | TRUE (re-grepped) |
| Tool messages built only by `toolMessage`, cancel note, compaction carry-over, restart notes | TRUE (grep `role: "tool"` / `toolCallId:` in src) |
| No other reader of `startedAt`/`endedAt` for tool rows | TRUE: the remaining hits are `exec/background.ts`, `core/jobs.ts` and `cli/local-runtime.ts` (background jobs, unrelated) |

### Mutations (re-run by the reviewer; each red, each reverted)

| # | Mutation | Result |
|---|---|---|
| R1 | `agent.ts`: start read moved above `gate.authorize` (unmodified site) | RED: permission-wait test `Received 5200`; pre-hook test `Received 3200` |
| R2 | `protocol/src/session.ts`: drop `durationMs` from `ChatMessageSchema` | RED: protocol keep + malformed cases; real-stack snapshot test (`remote.test.ts`); V6-3 |
| R3 | `tui/src/resume.ts`: `durationMs: m.durationMs ?? 0` | RED: "replay with no stored duration shows no time" |
| R4 | `persisted-session.ts`: `DAEMON_RECORD_VERSION = 5` | RED: V6-1, V6-2, V6-3 (and the v1/v4/v5 read-as-current cases) |

Revert: `shasum` of the 4 mutated files and of `git status --short` are
identical before and after (`agent.ts caf12f90…`, `session.ts f25d2584…`,
`resume.ts 8cd3102f…`, `persisted-session.ts 46d8cb6f…`, status `6f01c4fd…`).

### End-to-end trace (real clock, real code path)

`.tentacle/tmp/tool-duration-review/e2e.ts`: a real `Agent` with an `ask` tool
that sleeps 120 ms and a `requestPermission` that sleeps 300 ms. Every event goes
through `eventToUpdate`, then `SessionUpdateSchema.parse`, then `updateToEvent`,
then `applyEvent`. The history goes through `ChatMessageSchema.parse`, then
`messagesToItems`.

```
event durationMs: 122 wire: 122
LIVE  : ⏺ write {} 0.1s
REPLAY: ⏺ write {} 0.1s
2nd model request tool msg keys: [ "role", "content", "toolCallId", "durationMs" ]
```

The 300 ms prompt wait is excluded, and the live row equals the replayed row.
The last line is Finding 1.

### Attacks tried

- **Clock on the wrong side.** I checked cancel-before-start (`agent.ts:756-774`,
  no duration), approval-after-cancel (`:970`), deny / hook-block / unavailable
  (`:973-1004`), the hook-modified site (timed only around `execute`; the
  `[hook]` prefix is added after), unknown tool (timed; ~0 ms, true), and
  `/skill` (only `activate` is timed; cancel or error → no duration). For a
  suspended-turn resume, the re-run goes back through `runToolCalls` and gets
  the new run's time. MCP tools and background shell jobs are ordinary
  `execute` calls: a background job shows its spawn time, which is honest.
  Sub-agent rows never cross the wire. → nothing found.
- **Leak to the model / hooks / compaction.** I grepped for spreads and
  `JSON.stringify` of messages, read `proxy-model.ts` and `hooks.ts:704-711`,
  and ran R-style mutations M13–M15 per Execution. The only exposure is the
  in-memory `ChatRequest` (Finding 1). → no wire leak.
- **Persistence.** A v1–v5 record loads with no durations (V6-2). A v6 record
  is refused loudly by a v5 build: by version, or earlier by the store's
  unknown key. `-1`, `1.5` and `"x"` are refused (`malformed durationMs`). R4
  red. → holds.
- **Wire.** Strip schemas, `UPDATE_CLASS` unchanged, no `PROTOCOL_VERSION`
  bump, both ends wired (`daemon/mapping.ts:210`, `client/mapping.ts:179-180`,
  beside `result`, never inside it), JSON Schema regenerated. → holds.
- **TUI / §7 split.** Logic stays in pure modules (`state.ts`, `resume.ts`,
  `render-lines.ts`); no component changed. `applyEvent`'s `now` is still used
  by other reducers. The turn spinner/elapsed is untouched. `history_reset`,
  session switch and compaction replace all go through `messagesToItems`. →
  holds.
- **Pods.** A pod-supplied value is validated (`int().nonnegative()`; `isCount`
  in the laptop store), is display-only, and opens no prompt, approval or
  file. → no laptop effect.
- **Mobile / older client.** `apps/mobile` does not read the field; an older
  client strips it. → no impact.

### What holds

The "permission wait is not tool time" property and the on-disk record rule
(both red-teamed above). Test non-vacuity is shown by four reviewer mutations.
The gate is green against the clean lint baseline.

### How the executor behaved

The executor was disciplined. Every new test was shown red before the fix, and
16 mutations are documented. They added executable proofs the plan only cited
(the provider-body tests). Drift is reported honestly: the regenerated
`protocol.json`, the idle-warm fixture, and the `runUserSkill` restructure.
They named the one unverified e2e path. The only blemish is a stale `agent.ts`
hash in the revert proof (Finding 3).
