# feat/agent-status — the parent's view of its sub-agents, merged into ONE `agent_control` tool

> **Status:** execution (merge into `agent_control` complete; Review pending)
> **Branch:** `feat/agent-status`
> **Type:** feat · **Size:** S–M · **Blast:** cross-module · **Suited:** DeepSeek exec

## Context

*— deepseek (tentacle --profile deepseek), 2026-11-10*

The main agent cannot see what its sub-agents are doing. It has `agent_task`
(launch), `agent_kill` (stop) and `agent_message` (write); a foreground child
returns only its report, a background one only a `[background]` exit note. Shell
jobs have `shell_output`; sub-agents have no equivalent — the owner hit the cee
case: an `explore` child at 183 steps / 18M tokens opening files in slices, and
the parent had no way to notice before it was asked to stop it. `agent_kill` is
only usable if you already know the child is runaway.

Constraints:
- The data already exists daemon-side: `AgentJobs.rows()`
  (`packages/core/src/agent-jobs.ts:277-301`) carries `id, callType,
  description, state, toolUses, tokens, startedAt, tail` (the last 8 tool
  labels, `AGENT_ROW_TAIL_MAX`, `agent-jobs.ts:167`), and the `subagents`
  display update is the same list projected for the wire
  (`packages/daemon/src/subagents-view.ts:33-50`). Nothing new has to be
  computed or persisted.
- No wire change: the tool runs daemon-side in the session's own process, so no
  `PROTOCOL_VERSION` bump (AGENTS §7).
- Read-only, and never given to a child (like `agent_kill` / `agent_message`): a
  child could name its siblings, and its report already goes to the parent.
- The description must say "never poll in a wait loop" — the owner saw an agent
  `sleep 5` in a loop; the idle parent is woken by the child's `[background]`
  note by itself.
- A pod's labels are pod text (AGENTS §7): whatever a child's tool call was,
  the label is a string its owner chose. One line, bounded, never presented as
  instructions.

**Repro** (`.tentacle/tmp/agent-status/repro.ts`, run 2026-11-10 on this
branch): build the real session tools with sub-agents on and off, list the
`agent_*` names.

```
subagents on  · agent_* tools: [ "agent_task", "agent_kill", "agent_message" ]
subagents off · agent_* tools: []
agent_status offered (on): false
```

The capability is missing. (Script is gitignored — kept in `.tentacle/tmp/agent-status/`.)

## Implementation

*— deepseek (tentacle --profile deepseek), 2026-11-10*

### Load-bearing assumption

**One thing**: the live per-child facts the parent needs are already in
`AgentJobs.rows()`, in the same process that runs the agent loop — so the tool is
a formatting seam, not a new subsystem, and needs no protocol/daemon plumbing.

Proved: `AgentJobs.rows()` at `packages/core/src/agent-jobs.ts:277-301` returns
`id, callId, agentType, description, state: "running", toolUses, tokens,
startedAt, tail` — folded from the child's own progress events by
`foldAgentProgress` (`agent-jobs.ts:169-200`: `subagent_tool` pushes the label
and keeps the last 8, `subagent_usage` adds tokens). The only fact a row lacks
is the unread inbox count: `AgentInbox` holds it privately
(`packages/core/src/agent-inbox.ts:46`) with no reader — so this task adds a
one-line getter, not a second source of truth.

### Preconditions

- The tool registry the main agent gets is built per session in
  `packages/cli/src/wiring.ts:389` (`buildAgent`), and the background runtime
  (`agentJobs`) exists there at `wiring.ts:415-416` — it is the SAME object the
  rows are read from (`wiring.ts:568` hands it to `agent_task` as `background`).
- `agent_kill` / `agent_message` are registered only inside the
  `config.subagentsEnabled` block (`wiring.ts:581-587`): without the runtime no
  child has an `sa-N`. `agent_status` rides the same switch — it names an id.
- A child's registry is a filtered copy of the parent's
  (`packages/agent/src/subagent.ts:336-359`), with an explicit skip list
  (`spawnToolName`, `CONTEXT_RESET_TOOL_NAME`, `AGENT_KILL_TOOL_NAME`,
  `AGENT_MESSAGE_TOOL_NAME`, `AGENT_NOTIFY_TOOL_NAME`,
  `subagent.ts:344-352`) — this is where a new parent-only tool must be added,
  otherwise a `tools: "all"` child inherits it.
- `startedAt` is a wall clock (`AgentJobHost.now`, `agent-jobs.ts:36-40`,
  bound to `Date.now` in `packages/daemon/src/hosted-session.ts:639`), so elapsed
  = `now - startedAt` computed at call time; nothing ticks.
- A tool result is plain text (`ToolResult.content`,
  `packages/core/src/tool.ts`); the sibling tools return `permission: "none"`
  and no `concurrency` key.

### Design

**One pure formatter, one thin tool** (AGENTS §7: a decision goes in a pure
module, the tool only feeds it).

New module `packages/tools/src/agent-status.ts`:

```ts
export interface AgentStatusInput { rows: readonly AgentJobRow[];
  pending: (agentId: string) => number;
  now: number; actions?: number; agentId?: string }
export function formatAgentStatus(input: AgentStatusInput): string
```

- **Selection**: no `agent_id` → every running child, in launch order (rows()
  order); with `agent_id` → just that one.
- **Per child, two lines** (the tail is the TUI's own labels, so a person
  reading the panel and the model reading this see the same thing):
  ```
  sa-1 · general · Fix the parser · running 1m 24s · 12 tools · 74k tokens · 0 unread
    last 3: Read src/a.ts · Edit src/a.ts · $ bun test (+9 earlier)
  ```
  - `description`, `agentType` and each label are made ONE line and cut
    (control chars → space, whitespace collapsed): 60 chars each
    (`AGENT_STATUS_TEXT_MAX`) — pod text, bounded (AGENTS §7). The labels are
    shown as data, never as a directive.
  - `last N` (default 3, input `actions` clamped to `1..5`) of `row.tail`; when
    `row.toolUses` exceeds what is shown, `(+k earlier)` says how much is not
    here. No tool calls yet → `no tool calls yet`.
  - `elapsed` from `now - startedAt` in the TUI's own wording (`45s`, `1m 24s`,
    `1h 5m`) and counts compacted (`999`, `1.2k`, `18M`); the tool has its own
    three-line helpers because `packages/tui/src/format.ts` is the TUI's
    presentation layer and `tools` cannot depend on `tui`.
  - `unread` is `pending(id)` (texts an `agent_message` queued that the child
    has not drained).
- **Header**: `2 background sub-agents (of 4 allowed)`; one child → `1 background
  sub-agent (of 4 allowed)`. `maxParallel` is not on a row, so the header omits
  the parenthetical when the caller does not pass it (`cap?`).
- **Bounded output**: at most `AGENT_STATUS_MAX_ROWS = 10` children and
  `AGENT_STATUS_MAX_CHARS = 3000` in total; the rest is one closing line
  `… +N more (name one with agent_id)`. A runaway set of labels can never
  produce an unbounded tool result.
- **Empty**: `no background sub-agents are running` — plus, when the caller
  knows it, `(subagents.maxParallel = N)`; the tool adds
  `a [background] note arrives when one finishes`.
- **Unknown/finished id**: `formatAgentStatus` returns `undefined` for a
  selected id that has no row; the TOOL turns that into
  `no such background sub-agent: sa-9 — it finished, was stopped, or never
  existed. If it just finished, its report arrives as a [background] note.`
  with `isError: true` (the `shell_output` shape: a miss is an error the model
  can act on, and the sentence says what to do instead of retrying).

The tool (`createAgentStatusTool(jobs, options?)`):
- `name: "agent_status"`, `permission: "none"`, read-only.
- `concurrency`: one READ resource key `subagents` — a read-class call, so it
  never serializes a round and conflicts with nothing (nobody writes it).
- `inputSchema`: `{ agent_id?: string(min 1), actions?: number(int 1..5) }`.
- Description (short, and the three things the owner asked for):
  > Read-only: what your background sub-agents (sa-N) are doing — state, tool
  > uses, tokens, elapsed, their last actions, unread messages. Use it when you
  > need to know how one is doing, e.g. before deciding to stop or steer it. Do
  > not call it in a loop to wait: its report arrives as a [background] note
  > that wakes you.

`AgentJobs.pending(agentId)` (new, 3 lines) reads the entry's `AgentInbox` —
`0` for an id that is not running — and `AgentInbox.pending` exposes
`items.length`. That is the single source of truth for "unread"; no counter is
duplicated in the row (which would also tempt it onto the wire).

### Files

| # | File | Change |
|---|------|--------|
| 1 | `packages/core/src/agent-inbox.ts` | `get pending(): number` on `AgentInbox` (one reader for `items.length`). |
| 2 | `packages/core/src/agent-jobs.ts` | `pending(agentId): number` on `AgentJobs`. |
| 3 | `packages/tools/src/agent-status.ts` | **new**: `AGENT_STATUS_TOOL_NAME`, `formatAgentStatus` (pure), `createAgentStatusTool`. |
| 4 | `packages/tools/src/index.ts` | export the new module. |
| 5 | `packages/agent/src/subagent.ts` | skip `AGENT_STATUS_TOOL_NAME` in a child's registry (import + one condition). |
| 6 | `packages/cli/src/wiring.ts` | `tools.register(createAgentStatusTool(agentJobs))` beside `agent_kill` / `agent_message`. |
| 7 | `packages/tools/test/agent-status.test.ts` | **new**: formatter + tool on real `AgentJobs` state. |
| 8 | `packages/agent/test/subagent.test.ts` | a child is never offered `agent_status`. |
| 9 | `packages/cli/test/wiring.test.ts` | the real main-agent tools: on/off, and same switch as `agent_kill`. |
| 10 | `CHANGELOG.md` | `[Unreleased]` → Added. |
| 11 | `docs/feat/agent-status.md` | this doc. |

No `packages/protocol` change, no `packages/daemon` change, no
`PROTOCOL_VERSION` bump: the tool is daemon-side, the rows never leave the
process it already lives in.

### Failure modes

| Case | Behaviour |
|------|-----------|
| Unknown id | `isError: true`, names the id and says it finished/was stopped/never existed, and that a finished child's report arrives as a `[background]` note. No silent empty answer. |
| Child ends between the `rows()` read and the call | It has no row: same unknown-id text. Converges — the exit note is already queued for the parent by `AgentJobs`' own exit path (`agent-jobs.ts` `drive` → listeners), so nothing is lost by missing it here. |
| No background children (none ever, or the runtime not wired) | `no background sub-agents are running` (+ the cap when known, + "a [background] note arrives when one finishes"). Not an error: it is the normal answer, and it tells the model to stop asking. |
| Foreground child only | It has no `sa-N` and no row: it is invisible here, and the empty text says "background". Correct: a foreground child's call is still in flight, and its report is the call's result. |
| Huge counts (toolUses, tokens, 50 children, 8 long labels) | Counts compacted; ≤10 children; ≤3000 chars; tail capped to `actions`; labels cut to 60 chars. Over the row cap → `… +N more (name one with agent_id)`. |
| Pod-supplied text (control chars, newlines, `"` / backticks / fake `sa-99` line) | Every label and description is made one line and cut BEFORE it reaches the text, so a label cannot fake a child's line or a header. It is displayed as data only; nothing in the output is phrased as an instruction from the child. |
| A pod daemon, or `serve` | Works unchanged: `AgentJobs` lives in the daemon process in both. In a pod the tool's VIEW is pod-provided — which is why the text is bounded and never trusted; the parent's decisions (`agent_kill`, `agent_message`) still go through the laptop's gates (AGENTS §7). |
| `agent_id` naming a sibling from a CHILD | Impossible: the tool is not in a child's registry (`subagent.ts` filter). That is the load-bearing security-ish property, so it is tested. |
| A stopped-but-not-yet-exited child (`killed`) | Still has a row (`state: "running"`), so it is listed; its unread drops as the inbox closes. The exit note says `cancelled`. |

### Tests

Red-before-green (§9). For a feat the capability cannot be exercised before it
exists, so the red evidence is the MUTATIONS in Execution (A, B, C), each of
which was run and shown failing; that is the form §9 prescribes for
non-vacuity here. See Execution's "Red before green — stated honestly" for what
the first run of the new file actually showed.

1. `packages/tools/test/agent-status.test.ts`
   - **formatter** (pure): two rows → header + two 2-line blocks in launch
     order; one id → only that child; `actions` respected and `(+k earlier)`
     correct; a 0-action child says `no tool calls yet`; a label with `\n`,
     `\x1b` and 300 chars becomes one bounded line; the row cap; the TOTAL
     length cap at worst case (`AGENT_STATUS_MAX_CHARS`, hint included); empty
     list; unseen id → `undefined`.
   - **tool on real `AgentJobs` state**: start a child, fold progress events
     (`subagent_tool` ×3, `subagent_usage`), queue an `agent_message` → the
     output shows that child with 3 tools, its tokens, `1 unread` and its
     labels; after the gate resolves (child finished) the id → unknown-id
     error; an id that never existed → same error; no children → the empty
     text; `inputSchema` bounds (`actions: 9` refused, `agent_id: ""` refused).
2. `packages/agent/test/subagent.test.ts`: a `general` (`tools: "all"`) child is
   never offered `agent_status`, even when the parent's registry holds it.
   Mutation to check: remove the skip condition → red.
3. `packages/cli/test/wiring.test.ts`: `buildAgent({subagentsEnabled: true})`
   has `agent_status`; `subagentsEnabled: false` has none; and it appears
   exactly where `agent_kill` does. Mutation: register it outside the block
   (or drop the registration) → red.

Non-vacuity mutations (§9): (a) drop `AGENT_STATUS_TOOL_NAME` from the child
filter → the child-filter test must fail; (b) return the raw labels without the
one-line/cut step → the bounding test must fail; (c) return the text before the
`AGENT_STATUS_MAX_CHARS` branch → the length-cap test must fail. All three were
run and reverted (Execution).

### Merge into agent_control

*— deepseek (tentacle --profile deepseek), 2026-11-10*

**Owner decision (2026-11-10).** To cut the per-request cost of tool
definitions, the three PARENT-side sub-agent tools — `agent_kill`,
`agent_message`, `agent_status` — become ONE tool, `agent_control`. `agent_task`
(spawn) and the child's `agent_notify` stay as they are.

*Load-bearing assumption.* The model-facing cost of a tool is its
`description` + its compiled JSON Schema (`ToolRegistry.definitions()`,
`packages/tools/src/registry.ts:56-67`), and three tools cost three of those
plus three `properties` blocks of context at every request. **Measured before
any edit** (`.tentacle/tmp/agent-status/defs-chars.ts` on `feat/agent-status`,
`buildAgent({subagentsEnabled: true})`, chars = description + JSON.stringify of
the schema):

| tool | description | schema | total |
|---|---|---|---|
| `agent_kill` | 150 | 217 | 367 |
| `agent_message` (twoWay off / on) | 242 / 293 | 407 | 649 / 700 |
| `agent_status` | 314 | 323 | 637 |
| **three** | | | **1653** (off) / **1704** (on) |

*Design.*

- **Name** `agent_control`; ONE flat object, never a discriminated union
  (`oneOf` is handled poorly by local OpenAI-compatible models and is longer):
  `action: "status" | "message" | "kill"` (required, `z.enum`),
  `agent_id?: string(min 1)`, `text?: string(min 1)`. Which field an action
  needs is **validated in `execute`** with a tool error naming it — a zod
  refinement would answer "invalid arguments for agent_control: …" and the
  repair is clearer with our own sentence.
- **ONE description**, two variants by `subagents.twoWay` (as today's
  `agent_message`, `background.ts:170-176`): status is read-only and never a way
  to wait (the report is a `[background]` note that wakes you); the child reads
  a message before its next model step; kill stops it. Off = one-way ("no reply
  comes back"); on = "may answer with `agent_notify` (a `[sub-agent sa-N → you]`
  note that may wake you)". Target ≲ 400 chars for BOTH variants.
- **Status loses its `actions` param** (always the last 3):
  `formatAgentStatus` keeps its `actions?` input and clamp
  (`agent-status.ts:105-118`); the tool simply does not pass it.
- **Behaviour and result texts unchanged**: status text and unknown-id error
  are `formatAgentStatus` + the same sentence; message refusals/limits and
  "queued for sa-N …" are `AgentJobs.message`'s (unchanged) plus today's two
  result sentences; kill's two sentences are today's.
- **Class per action.** `permission` is a STATIC field on `Tool`
  (`packages/core/src/tool.ts:166`), so it cannot follow the input — **but all
  three were `permission: "none"`**, so `agent_control` is `"none"` and nothing
  changes. `concurrency` DOES take the (unvalidated) input
  (`tool.ts:201-204`), exactly like `spawnKind`: a TOTAL function returning the
  one read key `{mode:"read", resource:"subagents"}` for `action === "status"`
  and `"exclusive"` otherwise — byte-for-byte today's per-tool classes (status
  had the read key, message/kill had no `concurrency` ⇒ exclusive). Garbage
  input ⇒ `"exclusive"` (§7 safety pin).
- **The per-action factories go away** (`createAgentKillTool`,
  `createAgentMessageTool`, `createAgentStatusTool`): one parent-side tool, one
  implementation, so no second registration path can re-split the cost. Their
  `AGENT_*_TOOL_NAME` constants stay as **legacy names** — the child filter and
  `readOnlyType` keep listing them, so an old `agents/*.md` naming
  `agent_status` in `tools:` is still filtered/read-only, and `rg agent_kill`
  still explains each site.
- **Children.** `subagent.ts` drops `agent_control` (added to both name lists)
  — a child must never read or control its siblings.
- **Old sessions.** Nothing on the wire or in a log changes: a tool call is a
  name + args, so an old `agent_kill`/`agent_message`/`agent_status` call still
  replays and renders as its own name (`toolLabel` falls through to the name,
  `packages/core/src/tool-labels.ts:20-22`; `toolSubtitle` falls through to the
  raw args, `render-lines.ts:592-593`). Pinned by a test, not assumed. The TUI
  additionally gets a subtitle for the NEW name (`agent_control` → `status` /
  `message sa-1` / `kill sa-1`) so the merged call reads better than raw JSON.
- **Texts that named a tool the model no longer has** are re-pointed at
  `agent_control`: `agent_task`'s neutral description ("then `agent_message` to
  steer it"), the parent's `[sub-agent sa-N → you]` note ("to answer, use
  `agent_message({…})`", `packages/agent/src/agent.ts:297`), `AgentJobs`'
  at-the-cap refusal ("stop one with `agent_kill`", `agent-jobs.ts:630`), and
  `subagents.twoWay`'s key docs.
- A hook matcher on the OLD names must be updated by the user — recorded in the
  CHANGELOG (a matcher is the tool name; §7 hooks match names, no alias table).

*Files.* (dependency order)

| # | File | Change |
|---|------|--------|
| 1 | `packages/tools/src/agent-control.ts` | **new**: `AGENT_CONTROL_TOOL_NAME`, the two descriptions, `agentControlInput`, `createAgentControlTool(jobs, {twoWay?, now?})`. |
| 2 | `packages/tools/src/background.ts` | drop `createAgentKillTool` / `createAgentMessageTool`; keep the name constants as legacy; `agent_notify` untouched. |
| 3 | `packages/tools/src/agent-status.ts` | drop `createAgentStatusTool`; keep `formatAgentStatus` + helpers + `AGENT_STATUS_TOOL_NAME` (legacy). |
| 4 | `packages/tools/src/index.ts` | export `agent-control.ts`. |
| 5 | `packages/agent/src/subagent.ts` | `AGENT_CONTROL_TOOL_NAME` added to the child filter and to `readOnlyType`'s list; the three old names stay. |
| 6 | `packages/cli/src/wiring.ts` | ONE `tools.register(createAgentControlTool(agentJobs, {twoWay: config.subagentsTwoWay}))` where the three were. |
| 7 | `packages/tools/src/task.ts` | neutral description: `agent_message` → `agent_control`. |
| 8 | `packages/agent/src/agent.ts` | the notify note's "to answer, use …" names `agent_control{action:\"message\"}`. |
| 9 | `packages/core/src/agent-jobs.ts` | the refusal's "stop one with agent_kill" → `agent_control`. |
| 10 | `packages/tui/src/render-lines.ts` | `agent_control` subtitle: action + id. |
| 11 | `packages/config/src/key-docs.ts` | `subagents.twoWay` details name `agent_control`. |
| 12 | tests | see below. |
| 13 | `CHANGELOG.md` | `[Unreleased]`: Added (status, now an action) + Changed (merge; old hook matcher). |
| 14 | `docs/feat/agent-status.md` | this doc. |

No `packages/protocol` change, no `PROTOCOL_VERSION` bump: the tool is
daemon-side and a tool call's name is not a schema.

*Failure modes.*

| Case | Behaviour |
|---|---|
| `action: "message"` without `agent_id` or `text` | `isError: true`, `action "message" needs agent_id and text.` — nothing is queued. |
| `action: "kill"` without `agent_id` | `isError: true`, `action "kill" needs agent_id.` |
| `action: "status"` with `agent_id` of a finished/unknown child | today's unknown-id error text, unchanged. |
| `action` missing / not one of the three | zod enum → the registry's own "invalid arguments for agent_control: …" (the model sees the allowed values). |
| A call with an unknown `action` reaching `execute` directly | a defensive `unknown action:` error, never a throw (the executor must not see a crash). |
| Old `agent_kill` call replayed from a log | renders as `agent_kill` + raw args (as today); no mapping needed, nothing dropped. |
| A child naming `agent_control` in an agent-def `tools:` list | dropped by the filter; `readOnlyType` still calls the type read-only. |
| Garbage input to `concurrency` | `"exclusive"` (total, §7). |
| `subagents.twoWay` flipped mid-session | the description is built at registration from the config, exactly as `agent_message`'s was. |
| Old `agent_message`/`agent_kill` in a saved log's transcript | display-only; no re-mapping, no data loss. |

*Tests* (§9 — red on the assertion, first).

1. `packages/tools/test/agent-control.test.ts` (**new**, migrating
   `agent-kill.test.ts` + `agent-message.test.ts` and the tool half of
   `agent-status.test.ts`, which are deleted/trimmed):
   - the three result texts are today's, byte for byte (kill killed/not-running;
     message "queued for sa-1 …" off and on, and its four refusals; status text
     through the real `AgentJobs` state);
   - per-action validation: `message` without `agent_id`/`text`, `kill` without
     `agent_id` → the two sentences, `isError`;
   - `inputSchema`: `{}` refused (action required), `action: "nope"` refused,
     `action: "status"` alone accepted, `agent_id: ""` refused;
   - class: `concurrency({action:"status"})` is the read key,
     `{action:"message"}`/`{action:"kill"}`/`{}`/`null` → `"exclusive"`;
     `permission: "none"`; no `spawnKind`;
   - the description follows `twoWay` (off is today's one-way facts; on has
     `agent_notify` + `[sub-agent sa-N → you]` + "may wake you");
   - status no longer takes `actions` (extra key is stripped by zod, not an
     error, and the answer is the last 3).
2. `packages/tools/test/agent-status.test.ts`: the pure formatter only.
3. `packages/agent/test/subagent.test.ts`: a `tools: "all"` child is never
   offered `agent_control` even when the parent's registry holds it.
4. `packages/cli/test/wiring.test.ts` (the REAL wiring): with sub-agents on the
   main agent gets `agent_control` and NONE of the three old names; with them
   off it gets none of the four; the pinned definition list; `agent_control`
   answers from the SAME `AgentJobs` the session runs (`action: "status"`).
5. `packages/cli/test/agent-task-description.test.ts` (REAL wiring, through
   `ChatRequest.tools`): the `agent_control` description off/on, and
   `agent_task`'s neutral text naming `agent_control`.
6. `packages/core/test/agent-jobs*.test.ts`, `packages/agent/test/agent.test.ts`,
   `packages/tui/test/render-lines.test.ts`: the re-pointed texts, and the old
   names still rendering.
7. e2e (`agent-message.e2e.test.ts`, `agent-message-two-way.e2e.test.ts`): the
   scripted parent calls `agent_control{action:"message"}` — the identical
   delivery path.

Mutations (non-vacuity, run and reverted in Execution): **A** drop the
per-action validation (`kill` with no `agent_id` reaches `jobs.kill("")`);
**B** drop `AGENT_CONTROL_TOOL_NAME` from the child filter; **C** make the
description ignore `twoWay`.

## Execution

*— deepseek (tentacle --profile deepseek), 2026-11-10*

### Repro, before any edit

`.tentacle/tmp/agent-status/repro.ts` on `feat/agent-status` (off `62081ae`):
`subagents on · agent_* tools: [ "agent_task", "agent_kill", "agent_message" ]`,
`agent_status offered (on): false`. The capability was missing.

### What changed (in the Implementation's order)

| File:line | Change |
|---|---|
| `packages/core/src/agent-inbox.ts:59` | `get pending(): number` — the one reader of `items.length`, so unread is never a second counter. |
| `packages/core/src/agent-jobs.ts:258` | `get limit()` — the cap in force (`subagents.maxParallel`), which the header reports; a settings sync shows at once. |
| `packages/core/src/agent-jobs.ts:499` | `pending(agentId)` — `0` for an id that is not running. |
| `packages/tools/src/agent-status.ts` (new, 210 lines) | `AGENT_STATUS_TOOL_NAME` (`:19`), the caps (`:22-30`), `formatCount` (`:50`), `formatElapsed` (`:59`), `formatAgentStatus` (pure, `:89`), the length cap's hint (`:121`), `createAgentStatusTool` (`:180`). |
| `packages/tools/src/index.ts:7` | exports the module. |
| `packages/agent/src/subagent.ts:352` | a child's registry skips `AGENT_STATUS_TOOL_NAME`; `:548` counts it as "never given to a child" for `readOnlyType`. |
| `packages/cli/src/wiring.ts:591` | `tools.register(createAgentStatusTool(agentJobs))`, inside `subagentsEnabled`, beside `agent_kill`/`agent_message`. |
| `CHANGELOG.md:13` | `[Unreleased]` → Added. |
| tests | `packages/tools/test/agent-status.test.ts` (new, 12 tests), `packages/agent/test/subagent.test.ts:341` (child filter), `packages/cli/test/wiring.test.ts:146` (on/off, same switch) + `:159` (the real `AgentJobs`), `:1017` (the pinned tool list), `packages/cli/test/models-pod.test.ts:119` (see Drift 2). |

No `packages/protocol` change, no `packages/daemon` change, **no `PROTOCOL_VERSION`
bump** — as planned: the tool runs daemon-side over `AgentJobs` in the session's
own process.

### The description, verbatim

```
Read-only: what your background sub-agents (sa-N) are doing — state, tool uses, tokens, elapsed, their last actions, unread messages. Use it when you need to know how one is doing, e.g. before deciding to stop or steer it. Do not call it in a loop to wait: its report arrives as a [background] note that wakes you.
```

### Sample output, verbatim

From `.tentacle/tmp/agent-status/sample.ts` on a real `AgentJobs` — an `explore`
runaway (183 slices, 18M tokens) and a `general` child with one unread message
(`all`, then one id with `actions: 1`):

```
2 background sub-agents (of 4 allowed)
sa-1 · explore · Map the parser's entry points · running 1m 24s · 187 tools · 18M tokens · 0 unread
  last 3: Read src/slice-180.ts · Read src/slice-181.ts · Read src/slice-182.ts (+184 earlier)
sa-2 · general · Fix the off-by-one in the lexer · running 1m 24s · 1 tool · 74k tokens · 1 unread
  last 1: Edit src/lexer.ts
```

```
1 background sub-agent (of 4 allowed)
sa-1 · explore · Map the parser's entry points · running 1m 24s · 187 tools · 18M tokens · 0 unread
  last 1: Read src/slice-182.ts (+186 earlier)
```

Unknown id → `isError: true`,
`no such background sub-agent: sa-9 — it finished, was stopped, or never existed. If it just finished, its report arrives as a [background] note.`
Nothing running → `no background sub-agents are running (subagents.maxParallel = 4). A [background] note arrives when one finishes.`

### Red before green — stated honestly

The order I actually worked in was: repro → the pure module + tool → its tests →
the child-filter and wiring tests. So the FIRST run of
`packages/tools/test/agent-status.test.ts` was not a red-on-missing-code run;
it was **3 fail / 8 pass**, and all three failures were bugs in MY test, not in
the tool: `T1` expected `1 tool` from a row I had left at `toolUses: 0`; `T5`
miscounted the block shape (`22` vs `23` — it is header + 2×N + closing =
`1 + 2N + 1`, not `2 + 2N + 1`); `T8` compared an `sa-9` answer to an `sa-1`
one. I fixed the expectations; the tool changed for none of them. That run
therefore proves nothing about the code, and I am not claiming it as red.

The red evidence for this feat is the **mutations** below (§9's "confirm
non-vacuity by mutation" — the correct form for a feat, where the capability
cannot be exercised before it exists), plus two genuine reds seen on the way:
the on/off wiring test failed until `agent_status` was in the pinned tool list,
and the real-`AgentJobs` wiring test failed twice on its own property (first
`background sub-agents are not available in this mode` until the rig bound a
host as `HostedSession` does, then `of 4 allowed` vs `2` because `buildAgent`
sets the cap from the config — which is the property it pins).

### Mutations (non-vacuity, §9)

**A — the child filter.** Deleted `tool.name === AGENT_STATUS_TOOL_NAME ||` from
`subagent.ts:352`. `bun test packages/agent/test/subagent.test.ts -t agent_status`:

```
error: expect(received).not.toContain(expected)
Expected to not contain: "agent_status"
Received: [ "fs_read", "shell", "agent_status" ]
(fail) createSubagentRunner > a child is never offered agent_status: it would read its siblings
```

Reverted; green again. (The registry in that test really did hold the tool, so
the run is not vacuous.)

**B — the bounding.** Made `oneLine` return its input (no control-char strip, no
collapse, no cut). `bun test packages/tools/test/agent-status.test.ts`:

```
Expected: 3
Received: 7
(fail) agent_status: the formatter (pure) > T4: a pod's label and description are ONE bounded line
```

Reverted; green again.

**C — the total-length cap.** Returned `lines.join("\n")` before the
`AGENT_STATUS_MAX_CHARS` branch:

```
Expected: <= 3000
Received: 3605
(fail) agent_status: the formatter (pure) > T7: the total length cap holds even at worst case
```

Reverted; green again. A, B and C together show the three properties this task
exists for (never offered to a child; pod text can never grow or fake a line; a
bounded answer) are each actually pinned.

### One real bug the tests found, in my own code

Writing mutation C exposed a defect the Design had stated but the tool did not
have: the cut suffix (`… (cut: name one child with agent_id)`) was appended
OUTSIDE the budget, so a worst-case answer came out at **3038 > 3000** chars.
The fix (`agent-status.ts:116-123`) reserves the hint's length before slicing,
so the cap is a real ceiling. `T7` is its regression test, red under mutation C
and red on the pre-fix code (measured 3038 by
`.tentacle/tmp/agent-status/budget.ts`), green after.

### Gate

`bun run check` (typecheck → lint → test) from a clean tree:

```
$ tsc --noEmit && tsc -p apps/mobile --noEmit
$ biome check .   Checked 840 files … No fixes applied.
 6519 pass
 3 skip
 0 fail
 68254 expect() calls
Ran 6522 tests across 457 files.
```

The 3 skips are the documented opt-ins (`TENTACLE_K8S_SERVER`,
`TENTACLE_DOCKER_TESTS=1`, `TENTACLE_SLOW_TESTS=1`), not failures. Lint returned
to 0 errors after one `biome check --write` on the four files I touched.

### Drifts from the Implementation

1. **`maxParallel` is not an option on the tool** (Implementation said
   `options.maxParallel`): it reads `AgentJobs.limit` instead (`agent-jobs.ts:258`,
   a getter I added). Reason: `buildAgent` calls `setCap` from the config, so a
   settings sync changes it; a copy taken at registration would be stale. The
   formatter still takes it as plain input (pure). Small, and better.
2. **`packages/cli/test/models-pod.test.ts` needed a change — a real
   consequence, not a free pass.** With `agent_status` registered, the tool
   definitions JSON grows by ~692 chars (9,961 vs 9,269 measured on the real
   `buildAgent`), which crosses the first 1% `contextAwareness` step, so a pod
   child's tool *result* now renders with `\n\n[context: 3k / 128k tokens (2%)]`.
   Two tests compared that result with `toEqual(["from the MAIN model"])` and
   failed — `proved my change caused it`: removing only the `wiring.ts:591`
   registration made both pass again, re-adding it made both fail, 3/3 runs. They
   pin the **model** the child ran on, not the byte count, so I added a `plain()`
   helper (`models-pod.test.ts:119`) that strips a trailing context line, and used
   it on the four `main.results` assertions in that describe (`:192`, `:220`,
   `:226`, `:239`) — including the two that had not failed, so the next tool
   added cannot break them the same way. No other assertion was touched, and no
   expected value was relaxed. This is the one place the change is visible
   outside its own surface; a reviewer should satisfy themselves the helper is
   not hiding anything — it removes only the one documented suffix
   (`contextLine`, `packages/agent/src/context-awareness.ts:42`), and passes
   through everything else unchanged.
3. **`packages/tools/src/agent-status.ts` is 210 lines against the plan's
   sketch**: the extras are the two compactness helpers (duplicated from
   `packages/tui/src/format.ts` on purpose — `tools` must not depend on `tui`)
   and their doc comments. No behaviour beyond the Design.
4. **No `isParentOnlyAgentTool` helper**: the plan sketched one; the child filter
   is a name list in `subagent.ts` like the other three, and a second way to
   express "never given to a child" would be a second source of truth. I also
   dropped a stray `ToolRegistry` import/type-re-export I had written by mistake.
5. **`.tentacle/tmp/agent-status/` for this worktree is
   `.tentacle/worktrees/agent-status/.tentacle/tmp/agent-status/`** (the worktree
   is its own repo root, and the tool refuses writes outside it); the scripts and
   their output are pasted above and in Context.


## Execution — merge into agent_control

*— deepseek (tentacle --profile deepseek), 2026-11-10*

### Measured first, then merged

Before any edit, `.tentacle/tmp/agent-status/defs-chars.ts` on this branch
(`buildAgent({subagentsEnabled: true})`, chars = `description.length` +
`JSON.stringify(parameters).length`):

```
twoWay: false
  agent_kill      150 + 217 = 367
  agent_message   242 + 407 = 649
  agent_status    314 + 323 = 637
  TOTAL                     1653
twoWay: true
  agent_kill      150 + 217 = 367
  agent_message   293 + 407 = 700
  agent_status    314 + 323 = 637
  TOTAL                     1704
```

After (same script, `agent_control` as actually registered):

```
twoWay: false   agent_control  347 + 438 = 785   (all definitions 9961 → 8991)
twoWay: true    agent_control  400 + 438 = 838   (all definitions 9961 → 9162)
```

**1653 → 785 (−868, −52.5%)** with `subagents.twoWay` off; **1704 → 838
(−866, −50.8%)** with it on. The schema half is 438 chars against the three
tools' 947 (−509): one `properties` block, one `required: ["action"]`, and an
`enum` instead of three separate objects.

### What changed, in the Implementation's order

1. **`packages/tools/src/agent-control.ts` (new)** — `AGENT_CONTROL_TOOL_NAME`,
   the two descriptions (`agentControlDescription(twoWay)`), one flat
   `agentControlInput` (`action` required `z.enum`, `agent_id`/`text` optional
   `min(1)`), `createAgentControlTool(jobs, {twoWay, now})`. `execute` switches on
   the action and hands each to its own small private function, each keeping its
   old tool's `AgentJobs` call and texts **verbatim**.
2. **`packages/tools/src/background.ts`** — `createAgentKillTool` and
   `createAgentMessageTool` deleted (99 → ~40 changed lines); `agent_notify` and
   both shell tools untouched. `AGENT_KILL_TOOL_NAME` / `AGENT_MESSAGE_TOOL_NAME`
   stay, now documented as legacy names with three jobs (child filter,
   `readOnlyType`, old logs/transcripts).
3. **`packages/tools/src/agent-status.ts`** — `createAgentStatusTool` and its
   schema deleted; the pure formatter and `formatAgentStatus` stay untouched.
   `oneLine` is now exported, so the status error text reuses the SAME bounding
   helper instead of a second copy. `AGENT_STATUS_TOOL_NAME` stays as legacy.
4. **`packages/tools/src/index.ts`** — exports `agent-control.ts`.
5. **`packages/agent/src/subagent.ts`** — `AGENT_CONTROL_TOOL_NAME` added to the
   child filter and to `readOnlyType`'s list; the three old names kept in both
   (a child is not given a name that no longer exists either), with the comment
   rewritten. The two old child-filter tests became one, now also registering the
   old names as stubs, so the "old names are still dropped" property is pinned.
6. **`packages/cli/src/wiring.ts`** — one registration
   (`createAgentControlTool(agentJobs, { twoWay: config.subagentsTwoWay })`)
   replaces three, inside the same `if (config.subagentsEnabled)` block.
7. **Re-pointed texts** (all of them named a tool the model no longer has):
   `agent_task`'s neutral description (`task.ts`), the parent's
   `[sub-agent sa-N → you]` note (`agent.ts`, now
   `agent_control({ action: "message", … })`), `AgentJobs`' at-the-cap refusal
   (`agent-jobs.ts`, now `agent_control (action "kill")`), `subagents.twoWay`'s
   key docs, plus doc comments in `agent-inbox.ts`, `agent-jobs.ts`,
   `hosted-session.ts`, `protocol/session.ts`, `protocol/methods.ts`.
8. **`packages/tui/src/render-lines.ts`** — `toolSubtitle` gains
   `agent_control` (action, then the id: `status` / `message sa-2` / `kill
   sa-3`), plus the three OLD names → their `agent_id`, so an old session's
   transcript reads better than raw JSON. `toolLabel` needed nothing (it falls
   through to the name).
9. **Tests** — `agent-kill.test.ts` and `agent-message.test.ts` deleted;
   `agent-control.test.ts` (new, 18 tests) holds their assertions plus the new
   ones (per-action validation, class per action, the two descriptions, the
   twoWay message result). `agent-status.test.ts` keeps the formatter only (8).
   `subagent.test.ts` (child filter), `wiring.test.ts` (the REAL main-agent tool
   set: `agent_control` present, all three old names absent; the status answer
   from the session's own `AgentJobs`), `agent-task-description.test.ts` (the
   description through `ChatRequest.tools` for both flags),
   `render-lines.test.ts` (both new and old subtitles), the two e2e rigs
   (`agent_control{action:"message"}` over the real runtime) and the re-pointed
   `agent-jobs*` / `agent.test.ts` / `task*` texts.
10. **`CHANGELOG.md`** — `[Unreleased]`: the `agent_status` bullet now says it is
    `agent_control`'s `status` action; a new `Changed` bullet states the merge,
    the measured saving and the hook-matcher migration. The `[Unreleased]`
    bullets that described `agent_message`/`agent_kill` as tools were updated in
    place (they describe `[Unreleased]` behaviour, not shipped behaviour).

### The description, verbatim

`subagents.twoWay` **off** (347 chars):

```
Control a background sub-agent (agent_task{background:true}). "status": read-only, what it is doing and its last actions; never a way to wait — its report arrives as a [background] note that wakes you. "message" (agent_id, text): read before its next model step; one-way, no reply comes back. "kill" (agent_id): stops it; its report still arrives.
```

`subagents.twoWay` **on** (400 chars) — one clause differs:

```
Control a background sub-agent (agent_task{background:true}). "status": read-only, what it is doing and its last actions; never a way to wait — its report arrives as a [background] note that wakes you. "message" (agent_id, text): read before its next model step; it may answer with agent_notify (a [sub-agent sa-N → you] note that may wake you). "kill" (agent_id): stops it; its report still arrives.
```

The schema as sent (`ToolRegistry.definitions()[0].parameters`, verbatim):

```json
{"type":"object","properties":{"action":{"type":"string","enum":["status","message","kill"],"description":"status: read-only view. message: write to one. kill: stop one."},"agent_id":{"type":"string","minLength":1,"description":"The sa-N agent_task returned. Required for message and kill."},"text":{"type":"string","minLength":1,"description":"What to tell it. Required for message."}},"required":["action"],"additionalProperties":false}
```

No `oneOf`, no two-level nesting: `enum` + `required: ["action"]`.

### Red before green, and the three mutations (§9)

The new file `agent-control.test.ts` could not import `../src/agent-control.ts`
before it existed, which is not a red on an assertion. So the red evidence is
the three mutations, each run on the finished code and reverted (backups in
`.tentacle/tmp/agent-status/*.bak*.ts`):

**A — per-action validation.** `message`: `agent_id`/`text` guards replaced by
`?? ""` + `if (false)`; `kill`: the same. → two tests red:

```
(fail) … message without agent_id or text is an error naming both
(fail) … kill without agent_id is an error, and nothing is stopped
16 pass · 2 fail
```

(The display texts were red too on the way in: the first run showed
`running 1m 25s` against my `1m 24s` — my rig recorded the real `startedAt` and
my `now` was a constant — and the first description draft at 419 chars against
the plan's ≤400 target. Both were fixed in the test/description, not by
loosening the assertion.)

**B — the child filter.** Deleted `tool.name === AGENT_CONTROL_TOOL_NAME ||`
from `subagent.ts` → two tests red:

```
(fail) a child is never offered agent_control, even in a registry that holds it
(fail) … a child is never offered agent_message (nor its old names), and readOnlyType ignores it
32 pass · 2 fail
```

**C — the twoWay text.** `agentControlDescription` made to ignore its argument
(`return DESCRIPTION_ONE_WAY`) → red in both the unit and the REAL-wiring test:

```
(fail) agent_control: the one description > twoWay on: … may answer with agent_notify
(fail) the sub-agent texts the agent is really given > twoWay on: both texts say …
19 pass · 2 fail
```

All three reverted; the files restored byte for byte (`git diff` shows only the
intended edits).

### Gate

`bun run check` (typecheck → lint → test) on the finished tree:

```
$ tsc --noEmit && tsc -p apps/mobile --noEmit      (clean)
$ biome check .   Checked 840 files in 266ms. No fixes applied.
 6523 pass
 3 skip
 0 fail
 68275 expect() calls
Ran 6526 tests across 456 files. [246.88s]
```

The 3 skips are the documented opt-ins (`TENTACLE_K8S_SERVER`,
`TENTACLE_DOCKER_TESTS=1`, `TENTACLE_SLOW_TESTS=1`), not failures. Lint needed
one `biome check --write` on the five touched files (import order + formatting);
it is back to 0 errors, 0 warnings.

### Drifts from the Implementation

1. **`permission` cannot follow the input — and did not need to.** The plan said
   "find how the interface lets a call's class depend on its input; if it cannot,
   pick the safe class". `permission` is a static `Tool` field
   (`packages/core/src/tool.ts:166`), but all three old tools were
   `permission: "none"`, so `"none"` is exactly right — no drift in behaviour.
   `concurrency` DOES take the input (`tool.ts:201-204`, the `spawnKind`
   arrangement), so the class is per action and identical to before; no safe-class
   fallback was needed.
2. **`agentTaskDescription`'s key docs were left as they are** (the plan named
   "docs of the key `agentTaskDescription`"): the description that key replaces
   no longer names a tool at all, so the docs text (`subagents.agentTaskDescription`,
   `summary: "Replaces the `agent_task` description …"`) is still true. The
   `subagents.twoWay` docs DID need re-pointing, and were.
3. **One extra doc-comment sweep** the plan did not enumerate (`agent-inbox.ts`,
   `agent-jobs.ts`, `hosted-session.ts`, `protocol/session.ts`,
   `protocol/methods.ts`): each said "the model's `agent_kill`/`agent_message`
   tool", which the merge makes false. Comments only, no behaviour.
4. **The old-name TUI subtitle is new behaviour** the plan listed only as "keep
   display support": `agent_kill`/`agent_message`/`agent_status` previously fell
   through to raw JSON args in the subtitle, and now show their `agent_id`. That
   is strictly better rendering for an old transcript, and it is pinned by a test.
5. **`agent-jobs-progress`/`agent-jobs` refusal text** now reads
   `agent_control (action "kill")` rather than the plan's bare `agent_control`:
   naming the tool alone would not tell the model which action stops a child.
6. **`.tentacle/tmp/agent-status/` in this worktree** is
   `.tentacle/worktrees/agent-status/.tentacle/tmp/agent-status/` (the worktree is
   its own repo root); scripts and output are pasted above.
