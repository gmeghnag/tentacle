# eval/subagent-live — live sub-agents: background on user input, agent→subagent messages, per-type models

> **Status:** eval (context + source-verified analysis; owner questions open)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promotion → the split in *Proposed split*
> **Type:** eval → feat · **Size:** L overall (split into 9 tasks, none XL) · **Blast:** load-bearing (the agent loop's steering window, the single session path, the model tunnel, the persisted event log, protocol — AGENTS §7) · **Suited:** strong model + fresh-context Review for every load-bearing slice

Vocabulary (owner): **agent** = the main model the user chats with;
**subagent** = the child the agent starts with an `agent_task` tool call.

## Context

### Refresh 2026-11-08 (after session-log-laptop-store)

*— claude-sonnet-5-5, 2026-11-08*

Written against `main` @ `bd46999` (task 2 of the session log merged as `3031822`;
`PROTOCOL_VERSION` = 17, `protocol/src/version.ts:7`). What changed in this doc:
- **A4 rewritten** for the typed event log `<uid>.jsonl`. Key finding: everything the
  *model* sees about a subagent is already a `ChatMessage`, so it is already a `message`
  entry. The log needs NO new type for correctness. It does need two small NON-critical
  lifecycle markers, because the old plan ("derive lost from the note text") breaks after a
  compaction and cannot recover a report that finished but was not yet delivered.
- **A7** and **Failure modes** updated for the log (version skew of a new entry type, an
  older build reading subagent entries, superseded segments); F1, F4, F10 reworded, F12–F14 new.
- **Stale citations fixed** (A1–A3, A7, C1, C4): `relay.ts:422`→`:430`, `hosted-session.ts:817`→`:812-816`,
  `subagent.ts:107-122`→`:102-120`, `:251-260`→`:170,:250`, `schema.ts:10-47`→`:10-51`,
  `remote-client.ts:2452-2466`→`:2376,:2466-2473`, `protocol/model.ts:53-67`→`:60-68`,
  `wiring.ts:472-475`→`:473-476`. Every other persistence / steering / wake / event citation
  was re-checked and still holds.
- **Split**: one new task (log markers + a pure ledger) before the background task; 8 → 9 tasks.
- **Owner questions (round 2)** at the end: only what the new format opens. Round 1
  (Q1–Q7, the owner answers and additions) is untouched and binding.
- The sibling `feat/session-log-serve-store` (in flight, plan approved, not merged) adds no
  entry type and no `critical` value, and gives the daemon store the same `.jsonl` + a
  `<uid>.state.json` sidecar. Treat its details as provisional.

*— claude-opus-5-5, 2026-11-07*

### The question

How do we build A, B and C on the existing seams (the steering queue, the
background-job exit + auto-wake path, `tool_progress`, the panels, the model
tunnel), without a second session path (§7)?

### Owner decisions (2026-11-07, as decided)

**A. Chat with the agent while a subagent runs.** The messages go into the
agent's context. Shape: the subagent becomes a background job, like a shell
background job. The tool_result says "started (id X)"; the report comes later as
an exit + auto-wake.
- **Q1: background ONLY when the user writes while it runs.** The default stays
  foreground, as today.
- UI, foreground: show the subagent's LATEST updates (a rolling tail), not its
  first tool calls.
- UI, background: every background subagent is listed UNDER the footbar and is
  "openable" (you can inspect what it is doing).

**B. The agent writes into a subagent's context.** A new tool, e.g.
`agent_message(id, text)`, delivered at the subagent's next boundary, like the
steering queue. **One-way by default, two-way optional** (subagent→agent
messages wake the agent). Open: can the user write to an opened subagent?

**C. Per-type model config.** From the config, declare the model + endpoint +
key for each subagent type. Built-ins: `general-purpose` → **renamed
`general`**, and `explore`. It must work in pods too (today the proxy override
ignores the type's model). Approved shape:
- a NEW top-level `models` map: name → the same shape as the top-level `model`
  block (`ModelConfigSchema`, `config/src/schema.ts:10-51`). Unset fields
  inherit from `model`;
- `subagents.<type>.model: "<name>"` must name a `models` entry (unknown → a
  config error);
- NOT profiles (a profile carries tools/MCP/etc. too, so it is ambiguous);
- the top-level `model` stays the agent's default and the default for every
  unconfigured type.

The `/btw` side question is superseded or parked by A.

## Analysis (source-verified)

*— claude-opus-5-5, 2026-11-07*

### A1. How `agent_task` runs today

- The tool (`tools/src/task.ts:74-127`) awaits `run(...)` and returns the report
  as its result (`:109-125`). It hands the child the TURN's signal
  (`ctx.signal`, `:112`), `emitProgress` and its own `toolCallId` (`:113-114`).
- The runner (`agent/src/subagent.ts:207-313`) builds a fresh `Agent` per call
  with a filtered registry: no `agent_task` and no context reset, so depth is 1
  (`:217-226`). It runs `child.run(uuid, [prompt], signal)` (`:278-282`). The
  child's history is a local array that is never persisted. `Agent.run` passes
  NO steering drain (`agent/src/agent.ts:703-715`, `undefined` at `:711`).
- Progress: `subagent_start/tool/usage/end` (`subagent.ts:213,287,289,303`)
  become `tool_progress` frames keyed by the parent call id
  (`daemon/src/mapping.ts:250-270`; `protocol/src/updates.ts:124-147`,
  display class `:298`).
- Parallelism: spawns overlap in their own lane, capped by
  `effectiveAgentCap(maxParallel, slots)` per round (`agent.ts:1250`,
  `round-plan.ts:217-219`; docs/feat/parallel-agents.md).
- The child's permission asks carry the PARENT call id (`subagent.ts:102-120`).

### A2. Background jobs, exits, auto-wake, steering

- Shell jobs: `JobController` (`core/src/jobs.ts:35-54`) is
  command-shaped (`start(command)`, `BackgroundJob.command`, `:18-26`). The
  agent collects exits (`agent.ts:537`) into `pendingExits` (`:507`). At a
  turn's start, `flushBackgroundExits` (`:1844-1866`) pushes one user-role note
  per job and emits `background_exit` + `context_note{reason:"background_exit"}`.
- The daemon streams each exit live, even when idle (`hosted-session.ts:540-551`),
  and `kickWake` → `maybeWake` (`:1740-1794`) starts ONE continuation turn
  when `pendingExitCount > 0` and `daemonWakeGate` allows it (`core/src/auto-wake.ts:56-62`).
  The TUI and the detached relay decide their own wakes with `wakeStep/wakeDue`
  (`auto-wake.ts:24-37`; `cli/src/relay.ts:430`, `relayWakeDue`).
- Steering: `HostedSession.enqueue` (`hosted-session.ts:1934-1958`) →
  `Session.enqueue` (`agent/src/session.ts:211`). The loop drains the queue
  only at an iteration boundary (`agent.ts:864-868`) or in the late drain
  (`:981-998`). **While a tool call runs, a steer waits.** A foreground
  `agent_task` can run for minutes, so the user's message waits for it. That is
  exactly the problem A solves.

**Can a running subagent move to background mid-call? Yes, with one new seam.**
Nothing today tells a running tool that a steer arrived. Proposal:
- `ToolContext` gains `detach?: AbortSignal` (`core/src/tool.ts:89-114`). The
  agent fires it for every in-flight SPAWN call when `Session.enqueue` adds a
  text. This is synchronous: it adds no `await` to the steering window
  (`hosted-session.ts:812-816`).
- On `detach`, `agent_task` resolves at once with
  `started in background as sa-<n>: <description>. Its report will arrive later
  as a [background] note; you can keep working.` The child keeps running. It
  moves into a session-level **agent-job registry**.
- **Transcript validity holds.** The `tool_call` gets a real `tool_result` in
  the same round (`agent.ts:1835-1836` pushes the tool message). The later
  report is a separate user-role note, like a shell exit's
  (`agent.ts:1859`). The history-validity invariant
  (docs/eval/history-validity-invariant.md) is untouched.
- Non-spawn calls in the same round still run to completion. Only spawns
  detach. Then the round ends and the steer is drained at the next boundary
  (`agent.ts:864`).
- The child must stop using the TURN signal (`task.ts:112`). After it detaches,
  its own `AbortController` drives it. Otherwise an Esc on the next turn would
  kill every background subagent.

### A3. How the report re-enters

Reuse the exit path; do not build a second one.
- The agent-job registry exposes `onExit` like `JobController`. The agent's
  `pendingExits` becomes a union `{kind:"shell"} | {kind:"agent", id,
  description, report, stopReason}`, still flushed at a turn's start
  (`agent.ts:1844`). An agent exit's note carries the REPORT itself:
  `[background] sub-agent sa-1 (<description>) finished (end_turn):\n<report>`.
  The model needs no read tool for it. Large reports go through the same
  spill transform as tool output (`subagent.ts:170`, `:250`).
- `pendingExitCount` (`agent.ts:552-554`) counts both kinds, so the daemon
  wake (`hosted-session.ts:1757-1794`) works without a change. The live frame
  for TUI/relay wakes is a new display update `subagent_exit` (see A7). The
  TUI dedupes it against the turn-start flush, as it does for shell exits
  (`tui/src/App.tsx:684`).
- `retire/adoptExits` (`agent.ts:540-559`) already carry unflushed exits
  across an agent rebuild. The registry must move too, like `jobs`
  (`cli/src/wiring.ts:300-305`).

### A4. Persistence and resume

*— claude-sonnet-5-5, 2026-11-08 (rewrites the 2026-11-07 text, which assumed the
whole-record JSON store; verified on `main` @ `bd46999`)*

**Where things live now.** The laptop keeps one typed event log per session,
`<uid>.jsonl` (header line, then `session/log` entries; AGENTS §7). The daemon derives
the entries (`daemon/src/session-log.ts:56`, `SessionLog`: `commit` / `title` /
`turnStart` / `turnEnd` / `callStarted` / `checkpoint`) and the laptop writes only the
entries its client validated (`LogSessionStore`, `session-log-store.ts`). A turn cut
short is closed when the log is LOADED (`closeAtLoad`, `session-log-file.ts:392`,
`cutHistory` `:364`), not when saved. The `serve` daemon store moves to the same file in the
in-flight `feat/session-log-serve-store` (no new type, a `<uid>.state.json` sidecar, a
reload = `base{reason:"reload"}`). A child's conversation is still memory-only
(`subagent.ts:278`), and pods and the in-process worker still never persist on the daemon
side. A background subagent cannot survive a process restart, and it should not try to.

**Finding 1: the model-visible facts are already log entries.** Every one is a
`ChatMessage` pushed to the parent history and committed like any other
(`hosted-session.ts:1173`, `recordCut` → `SessionLog.commit` → `message` entry). No new
type is needed for them:

| Fact | Where it already lands | New log type? |
|---|---|---|
| `agent_task` call and its result `started in background as sa-N: …` | assistant + tool `message` entries | no |
| the report re-entry `[background] sub-agent sa-N (…) finished (…):\n<report>` (A3) | a user-role `message` (flushed at a turn's start, `agent.ts:1844-1866`) | no |
| `agent_message(id, text)` call + result (B1) | assistant + tool `message` entries | no |
| user → subagent `[user → sa-N] …` (owner answer Q1) | a user-role note in the parent, at its next turn: a `message` | no |
| a subagent's `agent_notify` text (B2) | a `[sub-agent sa-N]` user-role `message` (steer or exit note) | no |
| `agent_kill(id)` call + result (F7) | assistant + tool `message` entries | no |
| the "lost" note (below) | a `message` appended at load / reload | no |

The text that went INTO the child (`[message from the parent agent] …`, the user's text)
lives only in the child's memory: it is not persisted (the parent's own `[user → sa-N]`
note is the durable record, by design of Q1).

**Finding 2: two lifecycle markers ARE needed (non-critical).** The 2026-11-07 plan derived
"lost" from note text (`started in background as sa-N` with no later `[background] …
sa-N`). It breaks in two cases the log makes visible:
1. **Compaction / `context_reset` while a child runs.** A new segment starts at a `base`
   (`protocol/src/session-log.ts:76`); the summary may drop the `started … sa-3` result, so after a
   restart nothing says sa-3 existed and the model believes it is still running.
2. **A child that ENDED but whose report was not yet delivered.** The exit sits in the
   agent's `pendingExits` (memory only, `agent.ts:507`) until the next turn's start or wake
   (`maybeWake`, `hosted-session.ts:1757`). If the process dies in between, the report (the
   work product) is gone. A shell exit can be lost harmlessly; a subagent report cannot.

So the daemon emits, in the same synchronous stretches it already has (a child's
start/end handler, like `callStarted` at `hosted-session.ts:1632`; never an `await` in the
steering window):

| `type` | Payload | When | Critical |
|---|---|---|---|
| `subagent_background` | `{id, callId, agentType, description}` | the child becomes a background child (launched with `background: true`, or detached by a steer) | **no** (proposed; Q8) |
| `subagent_end` | `{id, stopReason, report?}` | the child ends (`end_turn`, `error`, `cancelled`, killed); `report` = the same text the exit note will carry, after the spill transform | **no** (proposed; Q8) |

A foreground child needs no marker: it dies with its turn, and the turn's cut already
labels its unanswered `agent_task` call ("Interrupted: … a sub-agent of this task …",
`persisted-session.ts:462-473`).
At each segment start (`base`: a compaction, `context_reset`, a reload, a reseed) the
daemon re-emits `subagent_background` for every child still running or ended-but-undelivered,
the way the title is re-logged at every segment start (`session-log.ts` `segment`; laptop-store
doc P1). A cold read from the last `base` (F5) then knows them without the earlier segment.
The architectural precedent is `call_started` / `turn_start`: owner decision 4 of
docs/feat/session-log.md (line 26) already names "sub-agent" as a type to add "when a reader
needs it". The reader here is `closeAtLoad`.

**Rendering-only: NOT persisted (AGENTS §7).** The `tool_progress` frames
(`subagent_start/tool/usage/end`, the rolling tail), the `subagents` full-state list, the live
`subagent_exit` frame, the panel rows, the child's own history and tool calls, a child's
permission ask (a pending ask is the sidecar's business on `serve`, and a child is lost on a
reload anyway: F2), the detach signal and the `session/agent_kill` request. The note
and the markers carry the durable facts; the rest is display. Opening a finished or lost
subagent after a resume therefore shows its summary line and report only, not its tool
trail (Q9).

**What `--resume` / a reload shows (honestly closed, like a cut turn).** The load derives,
from the CURRENT segment only (`currentSegment`, `session-log-file.ts:348`; a superseded
segment kept with `keepSuperseded` is never consulted, and its unmatched start is not a
loss):
- `subagent_background` with no `subagent_end` → **lost**: append ONE user-role note
  `[background] sub-agent sa-N (<description>) was lost (the session restarted); its partial
  work may have had side effects.` (a message only: the load writes nothing; the note rides
  the seed and the next persist, and the daemon's new segment then closes the id).
- `subagent_end` with a `report` but no `[background] sub-agent sa-N ` note after it in the
  messages → **undelivered**: append the exit note it would have carried, with the report.
  No wake (Q10).
- a note already present closes the id: the derivation is idempotent.

Where it runs (one pure function over a `LogSegment`, next to `closeAtLoad`, so both stores
share it): the laptop at `--resume` / `attach` load (`closeAtLoad`), and the `serve` daemon at
reload (after `feat/session-log-serve-store` lands: its loader folds through the same
`session-log-file.ts`). It runs at LOAD, not at save, like the turn cut. The resumed session is
seeded from the loaded (closed) projection (`open{messages}`), a superset of the raw disk, so
the next cold read finds it contained and sets no aside (laptop-store FM 13). The markers of
the old segment do not travel in a seed (`base{seed}` restates messages only); the note in the
messages is what closes the id from then on.
**The id counter** continues from the highest `sa-N` seen in the loaded markers or message
text (so a new child never reuses an old id the model has seen).

**Runtime, unchanged:** `serve`: the daemon keeps running when the TUI detaches, so a background
subagent keeps running and wakes the session (`daemonWakeGate`). Pods: a detached run's relay
keeps the pod daemon alive (docs/fix/detach-live.md), so the subagent runs on. A plain
`run`/in-process session dies with its TUI, and the "lost" note covers it on resume. A pod
daemon persists nothing: the laptop's copy holds what the laptop read before the pod died, and
a report that finished after the last read is gone (the child died with the pod anyway).

*— claude-sonnet-5-5, 2026-11-08*

### A5. TUI: today's rendering and the rolling tail

- State: `subagent_tool` appends a label and keeps the last 50
  (`tui/src/state.ts:189,415-427`). Render: `subAgentLines` prints ALL kept
  rows plus `└─ …` (`render-lines.ts:268-285`), so a busy child grows a
  50-row block. The owner reports that the first tool calls are what stays
  visible.
- "Latest updates" in the view-model: a pure `subAgentView(sub, maxRows)` that
  returns the head line, `… +K earlier` when it cuts, and the LAST `maxRows`
  activities (owner to confirm 5). It lives in a pure module (§7 "logic lives
  in pure modules"); `subAgentLines` only colours it. With `done` it keeps the
  last rows as well. It is an S task, contained, and independent of the rest.

### A6. Footbar list and the openable panel

- Panels: one panel state and one key route (`tui/src/panel.ts:1-30`). The
  mechanics are in `tree-panel.ts` (groups, head + children, cursor), and each
  projection is its own pure module (`mcp-panel.ts`, `sessions-panel.ts`,
  `skills-panel.ts`); `components/ListPanel.tsx` renders them.
- Proposal: a `subagents-panel.ts` projection over the same `TreeGroup`
  (head = `sa-1 · explore · 12 tool uses · 3.4k`, children = the tail of
  activities). It opens with `/agents` or with a click/key on the footbar row.
  The footbar list is a pure `backgroundAgentsView(state)` → up to N rows under
  `StatusBar` (`components/StatusBar.tsx`), with `+K more`.
- Data: the progress for a background child still arrives as `tool_progress`,
  keyed by its ORIGINAL `agent_task` call id. That id stays unique in history,
  so `updateTool` (`state.ts:393-431`) keeps working after the call's result
  landed. The session-level list (which ids are in background) is a new
  full-state display update, the same pattern as `queued`
  (`updates.ts:310`). It also goes in the open snapshot, so a second TUI
  attaching sees the same list.

### A7. Protocol

| Change | Class | Why |
|---|---|---|
| `subagents` (full list: id, toolCallId, type, description, state) | display | like `queued`: full state, also in the snapshot; nothing hangs |
| `subagent_exit` (id, stopReason) | display | like `background_exit` (`updates.ts:294`): the model is told server-side |
| `tool_progress` after the call's result | unchanged | already keyed by call id |
| `permission_request` from a background child | **changed meaning** | its `toolCallId` names a call that already has a result; it is asked outside any turn (see F2) |
| `session/agent_kill {sessionId, id}` (panel "stop") | method | an unknown method → `MethodNotFound` |
| log entry `subagent_background {id, callId, agentType, description}` | log type, **non-critical** (proposed, Q8) | a reader that does not know it SKIPS it (`protocol/src/session-log.ts:12-18`); it never changes the projection (`projectEntry` default branch, `:226-227`) |
| log entry `subagent_end {id, stopReason, report?}` | log type, **non-critical** (proposed, Q8) | same |

*— claude-sonnet-5-5, 2026-11-08 (the two log rows; the rest of the table is 2026-11-07)*

**Log entry rules (the session-log module, verified).** Each type has a strict (strip)
schema in `protocol/src/session-log.ts`, joins `KnownLogEntrySchema` (`:166`) and
`LOG_ENTRY_CRITICAL` (`:181`, a `Record<LogEntryType, boolean>`, so a missing value is a
type error). The client validates and re-serializes each entry it knows and drops an unknown
non-critical one before it reaches state or disk (F4), so a pod's `subagent_*` line never
reaches the laptop file verbatim. Adding a NON-critical type needs no version bump by the
module's own rule (`:16-18`: only a critical type does). The log's ordering contract
needs both entries to be emitted inside a synchronous stretch (like `callStarted`).
Everything else in the table is `session/update` display and does not touch the log.

**PROTOCOL_VERSION:** 17 today (`protocol/src/version.ts:7`; the in-flight
`serve-store` task adds no bump). The background
slice bumps it to **18**. The display updates alone are free, but the
permission ask's changed meaning is not (an older client would attach the prompt
to a finished row, or the daemon would refuse it). The pod-models slice (C) also
needs a bump (C5). If both land in one release window, they share it. The two log types
alone would NOT need a bump (non-critical); they ride the bump of the background slice for
the permission change, and ship earlier at 17 in the ledger slice (see the split).
If Q8 is answered "critical", the ledger slice itself bumps to 18.

### B1. `agent_message(id, text)`, one-way

- The child needs a steering drain. Today `Agent.run` passes none
  (`agent.ts:711`). The runner calls `child.runMessages(messages, sid, signal,
  () => inbox.splice(0), …)` instead, the same shape as `Session.send`
  (`session.ts:135`). The text lands at the child's next boundary
  (`agent.ts:864-868`) or in its late drain (`:981`). It is never dropped.
- The tool is registered on the PARENT only (children never get it, like
  `agent_task`, `subagent.ts:220`). Its results: `queued for sa-1`,
  `sa-1 already finished` (isError) or `no such sub-agent` (isError). It works
  for background children. For a foreground one, the call can only happen in a
  parallel round beside the running spawn, so v1 accepts background ids only.
- The child sees `[message from the parent agent] <text>`, a user-role
  message. The panel shows it as a row.

### B2. Two-way (optional)

- The child gets `agent_notify(text)` (a parent-only target). The text joins the
  parent's exits as `{kind:"agent_message"}` (A3). It counts in
  `pendingExitCount`, so it wakes an idle parent through the existing gate. If
  the parent's turn is running, the text is delivered as a steer at its next
  boundary (`Session.enqueue`, `session.ts:211`) with a `[sub-agent sa-1]`
  prefix. It is never mistaken for the user: the TUI renders it as a
  `context_note`, not a user row.
- Enablement: see owner question Q3. Recommendation: config
  `subagents.twoWay: boolean` (default false), carried as a P key
  (`cli/src/carried-settings.ts:42`), not a per-call flag the model decides.

### B3. Loop / ping-pong guard

- The wake gate already refuses after a bad end (`auto-wake.ts:45,60`). Add a
  wake budget: at most **3 child-originated wakes per user message** per session
  (the counter resets on a user prompt, as `resetsThisMessage` does,
  `agent.ts:751-753`). Over the budget, messages still queue but do not wake.
  The next user turn delivers them.
- Coalescing: N child messages before a turn starts give ONE wake (the
  flush-at-start rule, `auto-wake.ts:5-6`).
- A child's `agent_notify` is capped per child (e.g. 10). A parent's
  `agent_message` never wakes anything: one-way by construction.

### C1. The `models` map and `subagents.<type>.model`

- `settingsShape.model` (`schema.ts:189`) stays. Add `models:
  z.record(ModelConfigSchema)`. Resolution is a pure `resolveModel(name)`:
  `{...model, ...models[name]}`, so unset fields inherit. An `apiKeyCommand` is
  run once per entry, lazily, like today.
- **Collision:** `subagents` is a strict object with fixed keys
  (`schema.ts:221-261`: `enabled`, `maxIterations`, `execution`,
  `maxParallel`, `agentTaskDescription[File]`). Read literally,
  `subagents.<type>.model` puts a type named `enabled` in conflict with a
  setting, and the schema becomes a catchall. See Q6. Recommendation:
  `subagents.types.<type>.model`.
- Unknown names fail at load (owner rule): a `subagents.types.X.model` that is
  not in `models` is a config error. A type that does not exist (no built-in,
  no `agents/X.md`) gets a warning only, since `agents/` is loaded later
  (`wiring.ts:473-476`).
- Wiring: `modelFor` (`wiring.ts:481`) today takes a model id on the SAME
  endpoint (`cli/src/model-provider.ts:13-29`). It becomes
  `modelFor(type) → provider`, cached per `models` name.
  `configuredModelProvider` gets a resolved `ModelConfig` instead of
  `(config, id)`. `contextWindow` comes from the entry (it feeds
  `subagent.ts:229-233`).

### C2. Rename `general-purpose` → `general`

References (rg, 2026-11-07): `agent/src/subagent.ts:58`, `tools/src/task.ts:80`
(default fallback), tests (`agent/test/subagent.test.ts` ×16,
`parallel-agents.test.ts` ×3, `agent-defs.test.ts` ×2,
`permission-reply.test.ts`, `tools/test/task.test.ts` ×3,
`cli/test/wiring.test.ts` ×3, `cli/test/parallel-agents.test.ts`), and docs
(`docs/feat/parallel-agents.md` ×4, `packages.md`, `subagent-label-rename.md`,
`docs/eval/parallel-execution-plan.md`, `skills-subagent.md`). No `agents/*.md`
in the repo uses it.
- Old histories that hold `subagent_type: "general-purpose"` still resolve:
  an unknown name falls back to the default type (`task.ts:82-85`).
- A user's `agents/general-purpose.md` used to OVERRIDE the built-in
  (`agent/src/agent-defs.ts:132-147`). After the rename it becomes an extra
  type. Say it in the changelog; pre-public, no alias (§7).

### C3. User-defined `model` in `agents/*.md`

Today: a raw model id on the main endpoint (`agent-defs.ts:91-96`;
`subagent.ts:228`). **Proposed rule (Q4):** the frontmatter `model` is looked
up in `models` first; if it is not there, it is a model id on the main
endpoint (today's meaning). `subagents.types.<type>.model` in the config
beats the frontmatter. Precedence: config type → frontmatter → `model`.

### C4. Pods: a laptop-side proxy for several models

- Today in a pod, `modelOverride` (the tunnel) wins for every type
  (`wiring.ts:287-291,481`). The laptop serves a call with its main model, or
  with the title model for `purpose:"title"` (`client/src/remote-client.ts:2376,2466-2473`;
  `protocol/src/model.ts:60-68`).
- Design: `ModelStreamParams` (and the chunked, countTokens and slots params)
  gain `model?: string`, a **`models` NAME**, never an endpoint, id or key. The
  pod daemon builds one tunnel per name (`cli/src/serve.ts:408`,
  `tunnelFor(purpose)` → `tunnelFor(purpose, name)`). `modelFor(type)` maps
  the type to its name from the carried map (C5) and to the main tunnel when
  the type has none.
- **The laptop gates it (§7).** `servingModel` resolves the name in the
  LAPTOP's own `models`, and only if the laptop itself published that name for
  a type (the allowlist = the values of its `subagents.types.*.model`). Any
  other name → `InvalidRequest`. A hostile pod can choose among the models the
  user already assigned, and nothing more. The key never leaves the laptop.
- Version skew: an older laptop STRIPS an unknown `model` field (strip schemas)
  and silently serves the main model. That is a wrong-model call with no error.
  **So this bumps `PROTOCOL_VERSION`.**

### C5. Config-carry

`models` must NOT travel. It holds `baseURL`, `apiKey` and `apiKeyCommand`,
and the pod never needs them. What travels is the map `type → name` plus each
name's `contextWindow` (numbers, for context lines). It is a P (pinned) key:
the laptop decides which model serves its money and key
(`carried-settings.ts:1-14`, rows from `:42`). The pod's own `models`, if
any, is ignored over the tunnel.

### C6. llama.cpp slots with several endpoints

Today the cap is `min(maxParallel, slots of the agent's endpoint)`
(`agent.ts:1250`, `round-plan.ts:217`, `wiring.ts:340-354,548-555`). With
several endpoints:
- `subagents.maxParallel` stays the global ceiling (the work, the workspace).
- Each endpoint gets its own limiter, keyed by resolved `baseURL`, sized by its
  own `/props` slots (`provider.slots`), read lazily on first use. A child
  takes a slot from ITS endpoint. Children on a remote API (no `slots`) are
  limited only by the ceiling.
- Over a pod, `model/slots` carries the name too (C4), so the laptop answers for
  that endpoint.
- Background children hold their slot while they run, so the limiter must be
  session-level, not per round (A, F7).

## Failure modes

*— claude-opus-5-5, 2026-11-07*

- **F1 Disconnect (TUI detaches, `serve`/detached run).** The child keeps
  running daemon-side. Its exit wakes the session (`daemonWakeGate`). A
  reattaching client gets the `subagents` list from the snapshot plus the
  live progress. Nothing is lost.
- **F2 A background child's permission ask while the session is idle.** Today
  an ask with no live turn is auto-cancelled (`hosted-session.ts:610-616`).
  A background child would be denied silently, which is a bug. Options in Q5.
  Recommendation: the daemon holds the ask under the CHILD's signal, attributed
  to `sa-N` (no resumable pending on disk: a reload makes the child "lost",
  A4), shown through the single broker like any other ask.
- **F3 The user quits while a background child runs.** On `serve` /
  `--detach`, quitting only detaches (F1). An in-process or plain `run`
  session's daemon ends: the child is aborted with it, and on resume the
  "lost" note (A4) tells the model. The quit confirm should list the running
  children (Q7).
- **F4 Resume / daemon reload.** *(reworded 2026-11-08, claude-sonnet-5-5)* The child is
  gone (memory only). The "lost" (or "undelivered report") note is derived at LOAD from the
  current segment's `subagent_background` / `subagent_end` markers (A4), by one pure
  function shared by the laptop's `closeAtLoad` and the daemon reload. It is never written
  twice: the note, once in the messages, closes the id, and a seed restates messages only.
  A crash in the middle of the load changes nothing on disk (the load writes nothing).
- **F5 Pod.** The child runs in the pod daemon. Its model calls go through the
  tunnel, by name (C4). When the tunnel drops, the child's model call fails like
  the parent's (`proxy-model.ts`) and it exits with `error`. Its exit note says
  so.
- **F6 Two TUIs attached.** The list is daemon state, published as a full-state
  update (A6). Either TUI may stop a child (`session/agent_kill`, idempotent:
  a second stop answers "not running"). The detach trigger is ANY writer's
  steer, which is fine: the turn is shared.
- **F7 A child that never ends.** Bounded by `subagents.maxIterations`
  (`schema.ts:224-229`), unless the user set -1. Also killable from the panel
  and by the model with `agent_kill(id)` (the mirror of `shell_kill`,
  `tools/src/background.ts:54-71`). The cap (Q2) blocks new spawns while it
  runs: a spawn over the cap returns an error result that names the
  running ids.
- **F8 Cap reached at detach time.** Detach never fails: an already-running
  child only changes owner. The cap applies at SPAWN.
- **F9 Esc / cancel of the next turn.** It must not kill background children
  (A2: own controller). Only kill/stop does. A cancelled parent turn still sets
  `lastEndBad`, so the exit queues without waking (`auto-wake.ts:45`). This
  is existing behaviour, kept.
- **F10 The session closes or is archived.** `close` disposes jobs
  (`hosted-session.ts:2122`), and it must abort the agent-job registry too.
  The record is archived with the "lost" ids derivable *(2026-11-08: from the log's
  markers; an archived `serve` session is only reloaded by an explicit
  `session/open{reopen}`, so the lost note is written then, not at close)*. The
  `subagent_end{stopReason:"cancelled"}` of the aborted child is emitted before the close
  persist, so a close does not leave a start without an end.
- **F11 Agent rebuilt by a settings sync.** The registry carries over like
  `jobs` (`wiring.ts:300-305`), and unflushed agent exits move through
  `retire/adoptExits` (`agent.ts:540-559`).

*Added 2026-11-08 for the event log — claude-sonnet-5-5:*

- **F12 Version skew of a new entry type.** The two types are non-critical, so a build that
  does not know them SKIPS them: it loses only the lost-note derivation, never the
  projection. On the wire this needs the same `PROTOCOL_VERSION` anyway (the background slice
  bumps it for the permission meaning); an older laptop with a same-version newer pod daemon
  drops the unknown lines before state (F4). A **critical** type would make every older
  build refuse the whole log: that is why Q8 recommends non-critical and why no critical
  value is decided here.
- **F13 An older build reads a log that has subagent entries.** A post-task-2 build without
  these types: `parseLogFile` skips and counts the non-critical lines (`session-log-file.ts`,
  laptop-store FM 15); an APPEND leaves them as they are; a REPLACE that would drop them
  sets the bytes ASIDE (laptop-store Q2) — an extra `.aside` file after an old build writes,
  never data loss. Messages and notes are ordinary entries, so history and the report are
  intact. What the old build cannot do is turn an open marker into a lost note: the resumed
  model is told nothing, which is today's behaviour for a subagent. Pre-public, one build:
  noted in the changelog, no shim.
- **F14 Superseded segments with subagent history.** `keepSuperseded` (default off) keeps
  the pre-compaction segment, markers and notes included. Only the LAST segment decides
  "lost" (A4); a superseded segment's unmatched `subagent_background` is NOT a loss (the
  daemon re-emits the running ones at the new segment's start). With the option off, the
  superseded segment is dropped, and the re-emission is what keeps a running child known. A
  fork aside holds a held copy, never loaded, never consulted.
- **F15 Report finished, process dies before delivery.** The exit is in `pendingExits`
  (memory); the daemon has logged `subagent_end{report}`. On `serve` the daemon persists it
  at the next committed boundary; on a pod the laptop has it only if it read the log in
  between. At load: undelivered → the note is delivered with the report, without a wake (Q10).
- **F16 A hostile pod writes a marker.** A forged `subagent_background` makes the next
  resume say "sa-9 was lost", or a forged `subagent_end{report}` injects text into the
  model's context at load. Both are pod-supplied history, the same class as a forged
  message (AGENTS §7: a pod is not trusted; nothing durable from a pod prompt). The laptop
  keeps only schema-valid, size-bounded entries, and the report is capped like the exit
  note. Accepted, as the forged-lineage class of session-log task 1.
- **F17 Id reuse after a reload.** The counter continues from the highest `sa-N` in markers
  and message text (A4); without it, a new `sa-1` would collide with a note the model
  already read.

## Proposed split into tasks

*— claude-opus-5-5, 2026-11-07; rows 5–9, the Order and "Why a separate #5" paragraphs: claude-sonnet-5-5, 2026-11-08*

In dependency order. Each one ships alone.

| # | Task | Size | Blast | Notes |
|---|---|---|---|---|
| 1 | `feat/subagent-general-rename` | S | contained | rename + tests + docs (C2). First: C's config keys name types, so rename before users write configs |
| 2 | `feat/subagent-tail-view` | S | contained | pure `subAgentView` rolling tail (A5). A weaker model may execute it |
| 3 | `feat/models-map` | M | cross-module | `models`, `subagents.types.<t>.model`, resolution, the C3 rule, per-endpoint slot limiter (C1, C3, C6). Local/serve only; in a pod a type model is still ignored, as today, with a daemon-log notice |
| 4 | `feat/models-map-pod` | M | load-bearing | `model` name on `model/stream*`/`slots`, laptop allowlist, carry `type→name` (C4, C5). Bumps `PROTOCOL_VERSION` |
| 5 | `feat/subagent-ledger-log` | M | load-bearing | **new 2026-11-08.** The persistence contract of a background child, with no process behind it yet: a pure `AgentJobLedger` (running / ended / delivered, the `sa-N` counter, the re-emission set at a segment start), the two non-critical log types (A4/A7) with `SessionLog` methods + hooks, the shared load derivation (lost / undelivered, one pure function next to `closeAtLoad`, current segment only) for the laptop load AND the daemon reload, tests per F12–F17. Touches the §7 persistence invariant and a shared fold, so load-bearing, but the diff is small and each part is pure. No `PROTOCOL_VERSION` bump if Q8 = non-critical |
| 6 | `feat/subagent-background` | L | load-bearing | `detach` seam, session-level registry (the runtime around task 5's ledger), exit note with report, own controller, cap, background ask (F2), `subagent_exit` + `subagents` updates, `agent_kill` tool/method; it EMITS task 5's entries. Bumps `PROTOCOL_VERSION` to 18. TUI: a minimal footbar count only. Its former "lost derivation" moved to task 5 |
| 7 | `feat/subagent-panel` | M | cross-module | footbar list + openable panel on `tree-panel` (A6); user→subagent `[user → sa-N]` (owner Q1) reuses #8's inbox, so that line lands with #8 |
| 8 | `feat/agent-message` | M | load-bearing | one-way `agent_message` (B1): child steering drain; the user's panel text to a child (`[user → sa-N]` note in the parent, a plain `message`, no new type) |
| 9 | `feat/agent-message-two-way` | M | load-bearing | `agent_notify`, wake, guard (B2, B3), behind the Q3 switch |

**Order (changed 2026-11-08).** Rename stays first (#1: the code still says
`general-purpose` at `subagent.ts:58`, `task.ts:80`; nothing in the log changes that).
Then #2 (visible at once, independent). #3–#4 are unaffected by the log (a model name is not
persisted; the entries carry no model). **#5 waits for `feat/session-log-serve-store` to
merge**: its daemon-reload half edits the loader that task rewrites
(`persisted-session.ts` / the shared `session-log-file.ts`), and the plan says "restart
restates the saved point then appends fixes as normal entries", which is exactly where the
lost note goes. #6 needs #5. #8 needs #6 (only background ids are addressable), and #9 needs #8.
#7 needs #6; it may ship before #8 as read-only (its write-to-child half is #8).

**Why a separate #5 and not part of #6.** Splitting #6 along "log vs runtime" leaves no
dead code: the ledger is the state machine #6 plugs real children into, and its
derivation is testable with plain arrays (like `SessionLog` was). Folded into #6, one task
would hold a new seam in the agent loop, a protocol bump, the registry, the cap, the ask and
a persistence contract: an XL by AGENTS §10, which has no XL. If the owner prefers one task,
the cut line is exactly this one.

## Owner questions

*— claude-opus-5-5, 2026-11-07*

**Q1. Can the user write directly to an opened subagent?**
(a) No, panel is read-only; (b) yes, the text goes to the child as with
`agent_message`, and the parent is told at its next turn
(`[user → sa-1] …`); (c) yes, and the parent is never told.
**Recommend (b)**, after #7 (renumbered #8 on 2026-11-08), reusing its inbox. The parent's context stays
truthful about what steered its child.

**Q2. The background subagent cap.**
(a) Reuse `subagents.maxParallel` (default 4) for foreground + background
together; (b) a separate `subagents.maxBackground` (e.g. 4); (c) no cap.
**Recommend (a)**: one number for "how many children at once", already
lowered by slots (C6). Over the cap → an error result that names the running ids.

**Q3. Two-way enablement.**
(a) Config `subagents.twoWay` (default false, carried P); (b) per call, an
`agent_task` arg the model sets; (c) per type in `agents/*.md`.
**Recommend (a)**: the user decides the wake policy, not the model. (c) can be
added later as an override.

**Q4. User-defined `model` (agents/*.md) vs `models`.**
(a) A `models` name first, else a model id on the main endpoint (today's
meaning); (b) it must be a `models` name (a breaking change, an unknown name is
a warning and is ignored); (c) leave the frontmatter as is, configurable only
from config.
**Recommend (a)**, with config `subagents.types.<t>.model` beating the
frontmatter. Nothing breaks, and one lookup rule covers both.

**Q5. A background child's permission ask (F2).**
(a) The daemon holds it under the child's signal, attributed to `sa-N`, asked
even while idle; (b) deny it with "ask again in foreground" and let the child
report; (c) background children run with read-only tools only.
**Recommend (a)**. It is what "keep working while it runs" needs. Not
resumable across a reload (the child is lost anyway).

**Q6. Config key shape.** `subagents.<type>.model` collides with the existing
`subagents` settings (`schema.ts:221-261`).
(a) `subagents.types.<type>.model`; (b) keep `subagents.<type>` and reject the
reserved names as type names.
**Recommend (a)**: a strict schema, no reserved words.

**Q7. Quitting with running background children (non-serve).**
(a) The quit confirm lists them ("2 sub-agents running will be lost"); (b)
quit silently, and the "lost" note covers it on resume.
**Recommend (a)**: one more line in the existing confirm.

## Owner answers

*— claude-opus-5-5 (orchestrator, recording the owner's answers), 2026-11-08*

- **Q1: (b).** The user can write to an opened subagent. The text goes to the child as with `agent_message`, and the parent is told at its next turn (`[user → sa-1] …`).
- **Q2: (a).** One cap: `subagents.maxParallel` covers foreground and background together.
- **Q3: (a).** Two-way is enabled by the config key `subagents.twoWay` (default false).
- **Q4: (a).** An `agents/*.md` `model` is looked up as a `models` name first, else read as a model id on the main endpoint. `subagents.types.<t>.model` beats the frontmatter.
- **Q5: (a).** A background child's permission is asked anyway, as today: attributed to `sa-N`, and queued behind the agent's own ask.
- **Q6: (a).** The key shape is `subagents.types.<type>`.
- **Q7: (a).** The quit confirm lists the running background subagents ("2 sub-agents running will be lost").
- **Added by the owner:** the agent may also launch a subagent straight into the background, with an `agent_task` field (e.g. `background: true`). This is on top of the detach triggered by the user writing. It belongs to `feat/subagent-background`.
- **Added by the owner (2026-11-08): the agent may choose a subagent's model.**
  - It is opt-in and gated by `subagents.selectableModels: ["<models name>", …]`. Absent or empty means off.
  - Each `models` entry gets an optional `description`. Those descriptions are listed in the `agent_task` tool description, so the agent knows when to pick which.
  - `agent_task` gets an optional `model` argument that accepts only a listed name. Any other name is an error result and no child starts.
  - Precedence: the call's `model`, then `subagents.types.<t>.model`, then the `agents/*.md` `model`, then the top-level `model`.
  - In a pod the laptop checks the name against the same list before using a key (the task 4 allowlist).
  - It belongs to `feat/models-map` (task 3). Split it out only if that task grows past M.

## Owner questions (round 2)

*— claude-sonnet-5-5, 2026-11-08*

Only what the new on-disk format (`<uid>.jsonl`, the typed `session/log`) really opens. Round 1
(Q1–Q7) is closed and untouched. Q8–Q12 can be answered in one batch; AGENTS §10 says the
owner decides every `critical: true` type, so Q8 is the one that gates task 5.

**Q8. `critical` for the two new log types (`subagent_background`, `subagent_end`).**
(a) both NOT critical: an older build skips them (F12, F13); (b) `subagent_background` critical:
an older build refuses any log that holds a background child; (c) both critical.
**Recommend (a).** Neither changes the projection (`projectEntry` leaves them alone), so
nothing is lost by skipping them, and a critical type bumps `PROTOCOL_VERSION` and locks out
older builds. I decide no `critical: true` here: this question is the only one that would.

**Q9. Persist a subagent's tail / tool trail so it can be opened after a resume?**
(a) No: only the lifecycle markers and the report are durable, an opened finished/lost
subagent shows its summary line and report; (b) yes, a `subagent_tool` entry per step (a new
type, volume = every child tool call).
**Recommend (a).** The tail is rendering-only (AGENTS §7: never persist rendering-only events),
the child's history is memory-only today, and (b) would grow the log by every child step.

**Q10. At load, a lost or undelivered subagent is told to the model with a wake?**
(a) Write the note into the loaded history, NO wake: it is read at the user's next turn;
(b) queue it as a pending exit that wakes the resumed session at once.
**Recommend (a).** A resume is a human act, and an auto-wake on open would start a model turn
nobody asked for (the wake gate already refuses after a bad end, `auto-wake.ts:45,60`).

**Q11. Does `subagent_end` carry the report text?**
(a) Yes, capped by the same spill transform as the exit note (A3): a finished-but-undelivered
report survives a daemon restart; (b) no: a report not yet delivered when the process dies is
lost, and the load says so.
**Recommend (a).** The report is the work product; losing it silently to a crash a minute
after the child finished is the worst outcome of the feature. Cost: the report lives twice in
the log (entry and note), bounded by the spill cap.

**Q12. Order: task 5 (`feat/subagent-ledger-log`) after `feat/session-log-serve-store` merges?**
(a) Yes, wait; (b) no, do the laptop half first and the daemon-reload half after.
**Recommend (a).** The daemon-reload half edits the loader that task rewrites (and deletes
`DAEMON_RECORD_VERSION`); doing both at once is the parallel-edit mess AGENTS §10 forbids.
Tasks #1–#4 depend on neither, so the wait costs nothing.

### Owner answers — round 2 (2026-11-08)

*— claude-opus-5-5 (orchestrator, recording the owner's answers), 2026-11-08*

All follow the recommendation:
- **Q8: non-critical.** `subagent_background` and `subagent_end` are non-critical log types; an older build skips them. No `PROTOCOL_VERSION` bump for task 5.
- **Q9: (a).** Only the lifecycle markers and the report are durable; the tail / tool trail is rendering-only and is not persisted.
- **Q10: (a).** At load, a lost or undelivered subagent is written as a note into the loaded history, with NO wake; the model reads it at the user's next turn.
- **Q11: (a).** `subagent_end` carries the report, capped by the same spill transform as the exit note.
- **Q12: moot.** `feat/session-log-serve-store` merged on main (79ccf1b) before task 5 starts; task 5's Implementation re-verifies this eval's daemon-reload citations against the merged code (AGENTS §8).

## Architecture & UI/UX review (Opus)

*— claude-opus-5-5, 2026-11-08*

Verified against `main` @ `604522b` (this worktree), reading the CODE, not this eval's
citations. Owner decisions, answers and round 2 are binding and are not reopened here.

### Verdict: **sound with changes**

The decomposition is right: a subagent becomes a background job reusing the exit/auto-wake
path (`pendingExits` → `flushBackgroundExits`, `agent.ts:1844-1866`; `maybeWake`), with the
durable facts as ordinary `message` entries plus two non-critical markers. Every runtime stays
on the one session path, since everything runs daemon-side. The single broker is untouched.
The model stays on the laptop (C4's name-only allowlist is the right shape). The pod stays
untrusted (F16 is accepted, the same class as session-log task 1). No handler serializes the
peer (`agent_kill` is a short request). Nothing is a second agent loop.

The design does have four HIGH gaps, all in the runtime of a child that outlives its tool
call. Three are §7 interactions the eval does not see (the progress path, liveness, the ask's
signal). The fourth is a size problem: task 6 is an XL and must be split.

### Findings

#### HIGH

**H1. A background child's live progress has no path. "`tool_progress` unchanged" (A6, A7) is
wrong.** The agent pushes a call's progress into a per-call `EventQueue` that is closed when
the call settles (`agent.ts:1321-1326`, `:1338` `.finally(() => progress.close())`). After the
child detaches, its `onEvent` writes into a closed queue. The client also drops a turn-scoped
update outside its turn's brackets (`client/src/remote-session.ts:1258-1262`, "a null or
untracked stamp is dropped", the T-B0 contract). So an idle TUI would never see the tail, and
if a later turn is running, the daemon would stamp progress of an earlier turn's call into it.
**Change (task 6a):** the agent-job registry owns a session-level sink. A background child's
progress travels in the session-scoped `subagents` full-state update. Each child carries
`{id, callId, type, description, state, toolUses, tokens, startedAt, tail: last ≤ 8 labels}`.
Updates are coalesced (≤ 4/s), included in the open snapshot, and routed by a listener like
`queued` (`remote-client.ts:2179-2181`; `remote-session.ts:1250-1257` lists the not-turn-scoped
kinds). A foreground child keeps `tool_progress` inside its turn, exactly as today; at detach
its row moves to the session list. This also fixes a gap the eval missed: a `connect` client or
a second TUI attaching mid-run would otherwise see an empty tail.

**H2. A running background child is invisible to every liveness predicate.**
- The `serve` reaper's `busy` is `this.running`, the turn (`hosted-session.ts:1055` →
  `session-reaper.ts:99`). The idle TTL therefore closes a detached `serve` session while a
  child works, and F1's "nothing is lost" is false.
- The detached relay is idle when `turn over && asks 0 && jobs 0` (`relay-state.ts:183`).
  `jobs` counts running SHELL jobs only (`hosted-session.ts:1046`; `exitPlan`'s `use.jobs`,
  `relay-state.ts:324`). So a `run --detach` relay leaves while a child runs. The relay is the
  laptop end of `model/stream`, so the pod child loses its model and ends in `error`, and A4's
  "the subagent runs on" is false. With `--rm`, the relay deletes the workload under the
  running child, which breaks the §7 pod-lifecycle invariant ("removes only … a clean idle").

**Change (6a):** one predicate, "active work" = turn running ∨ shell jobs ∨ agent jobs. It
feeds `summary().jobs` (or a new free field `agents`, for `ps`) and `liveness().busy`. Tests go
in `relay-state` and `session-reaper`, beside the existing jobs cases. (Shell jobs have the
same reaper gap today; record it, don't widen 6a to fix it.)

**H3. The background ask is bound to the wrong signal and the wrong turn.**
- `awaitDecision` takes the CURRENT turn's signal and refuses while compacting
  (`hosted-session.ts:627-634`). While idle the ask is auto-cancelled (the eval knows this:
  F2). But during a LATER turn the ask is bound to that turn, so an Esc on an unrelated turn,
  or a `/compact`, cancels the child's ask.
- The client attributes an ask to the turn whose stream carried it (`remote-client.ts:2155-2157`,
  "the wire names none"). Auto-accept answers only "own" asks (`permission-ui.ts:60-68`).
  So the same child's ask is auto-accepted or prompted depending on timing, and a turnless
  (idle) ask is never auto-accepted.

**Change (6a):** for `origin: "subagent"` of a background child, `awaitDecision` takes the
CHILD's signal from the requester options. `permission_request` gains the SPAWNING turn's id
(an optional field that rides the bump to 18), so `ownRequest` works unchanged: the TUI that
owned the spawning turn auto-accepts per its toggle, and the others prompt.

What already holds (verified, no new code): asks queue one at a time in the client
(`permission-router.ts:85-114`), which is exactly owner Q5's "queued behind the agent's own".
A subagent ask is never resumable (`persisted-session.ts:140-151`, `origin === "call"` only),
so a reload never re-asks it. That matches "lost on reload".

**H4. Task 6 is an XL.** It holds a new seam in the agent loop's steering window, the registry,
the own controller, the cap, the exit note, the background ask (H3), the session progress sink
(H1), the liveness predicates (H2), `agent_kill` as a tool and a method, two updates, the quit
confirm (M7), the compaction carry (M4) and a protocol bump. AGENTS §10 has no XL.
**Split** (TODO.md updated):
- **6a `feat/subagent-background`** (L, load-bearing): the child is launched with
  `background: true` only (the owner's addition). It gets everything above except the detach
  seam, and it emits task 5's markers. It ships the owner's addition alone, and it is useful
  alone.
- **6b `feat/subagent-detach`** (M, load-bearing): `ToolContext.detach`, which fires when the
  USER writes while a spawn runs (M1), plus the send-now behaviour (Q13). It reuses 6a's whole
  runtime. Its one load-bearing assumption is cheap to prove alone (M1).

#### MEDIUM

**M1. The detach trigger is on the wrong layer.** A2 fires detach "when `Session.enqueue`
adds a text". `Session.enqueue` (`session.ts:211`) is also how a reload restores steers
(`hosted-session.ts:575-581`), and how B2 delivers `[sub-agent sa-1]`. So a child's notify
would detach every foreground sibling. **Change (6b):** fire detach from `HostedSession.enqueue`,
the user's path (`hosted-session.ts:1973-1999`, synchronous), and from `send_now` (Q13). Never
fire it from `Session.enqueue`. **6b's load-bearing assumption:** firing the signal inside the
synchronous `enqueue` adds no `await` to the steering window. Prove it with a test: a steer
during a foreground spawn gives `started in background as sa-N` in the SAME round, and the steer
is drained at the next boundary (`agent.ts:864-867`). Also start the child with its own
controller, LINKED to the turn signal until detach and unlinked then. Do not switch signals
mid-run.

**M2. Agent-originated text in the steering queue renders as the user, and pollutes queue
reconciliation.** Every drained steer becomes `{role:"user"}` plus a `steer` event
(`agent.ts:864-867`), and the TUI renders every `steer` as a user row (`state.ts:438-441`). B2's
"rendered as a `context_note`" has no path. **Change (task 9):** steering items become typed
`{origin: "user" | "subagent", id?, text}`, and a non-user item emits
`context_note{reason:"subagent_message"}`, not `steer`. **Task 8:** the parent's
`[user → sa-N]` note must NOT count in `pendingExitCount` (`agent.ts:552-554`). Otherwise
writing to a child wakes the agent, a model turn nobody asked for. It is a pending NOTE,
flushed at the next turn, not an exit.

**M3. Notes are recognised by parsing their text.** The load derivation (A4) matches
`[background] sub-agent sa-N `, and `--resume` renders EVERY user-role message as a user row
(`tui/src/resume.ts:32`). So after a resume, a multi-KB report shows as if the user had typed it
(shell exit notes already have this problem; reports make it much worse). There is a precedent
for display-only fields on `ChatMessage`: `spill`, `durationMs`, `denialReply`
(`core/src/model.ts:35-52`). **Change (task 5):** add an optional display-only
`note?: {kind: "background_exit" | "subagent_report" | "subagent_lost" | "user_to_subagent" |
"subagent_message", id}` on these messages. The derivation keys on `note.id` (structural, and
idempotent by construction). `resume.ts` and the live TUI render a notice, with the report
collapsed and expandable (Ctrl+O). It is an optional field on the wire `ChatMessage` (free,
strip schemas), carried by `message` entries.

**M4. The MODEL forgets running children after a compaction or `context_reset`.** A4 re-emits
the markers for the log, but the new context does not mention them: compaction carries skills
only (`compact.ts`, `carryOverSkills`; nothing about jobs). The model may re-spawn the same
work, or be puzzled when the report arrives. **Change (6a):** append one carried line to the
compaction/reset seed, "Still running in background: sa-3 (desc); job 2 (`npm test`)". Make it
shared for shell jobs and subagents.

**M5. On pod / in-process runs, the "undelivered report" is often not on the laptop.** The
laptop reads the log on `tool_result` and at turn end (`cli/src/local-runtime.ts:398-405`). A
child that ends while the session is idle, with the wake refused (`lastEndBad`) or `autoWake`
off, logs `subagent_end{report}` that the laptop never reads before a quit. So Q11 holds only
on `serve`. **Change (6a):** the client's `subagent_exit` listener calls the same coalesced
`flush()`. It is one line.

**M6. The panel hides the input, so `[user → sa-N]` cannot be typed.** Behind a list panel
nothing edits the input (`App.tsx:2646-2649`). A6's `tree-panel`/`ListPanel` is fine for
inspecting, but not for writing. **Change (7/8):** use two surfaces. The **list** (ListPanel:
inspect, stop) and a **focus** view: Enter on a row focuses `sa-N`, the transcript area shows its
tail, the input stays live with the border title `→ sa-1` (`modelBorder` already draws a
title), and Esc goes back. Focus is a pure module (`subagent-focus.ts`: input target, key
routing), so the App key handler (known debt) gains one dispatch and no logic.

**M7. The quit confirm owner Q7 extends does not exist where it is needed.** The only confirm
today is "N other terminals attached — close for all?" (`commands.ts:263-266`,
`App.tsx:1740-1753`). A plain in-process/`run` `/quit`, and Ctrl+C while idle
(`App.tsx:2384-2391`), exit without asking. **Change (6a):** `quitCommandStep` gets an `agents`
count, Ctrl+C while idle asks too when children run, and `quitConfirmText({others, agents})`
combines both. SIGHUP cannot ask: the lost note covers it. `connect` and `--detach` only detach,
so they get no confirm.

**M8. Background children compete with the agent for slots, and the limiter is in the wrong
task.** The per-round cap (`agent.ts:1248-1251`, `effectiveAgentCap`, `round-plan.ts:217-221`)
works today because the agent WAITS for its foreground children. Background children share the
endpoint with the agent's own requests: on llama.cpp `-np 2` with two background children, the
user's chat queues behind them. C6 also puts a session-level limiter in task 3, before any child
outlives a round. And the limiter must live outside `buildAgent`, which a settings sync rebuilds
(inject it like `jobs`, `wiring.ts:300-306`). **Change:** task 3 keeps per-endpoint slot SIZING
for foreground rounds (the type's endpoint, not the agent's). A new small task
**`feat/subagent-slots`** (M, cross-module), after 6a, adds the session-level per-endpoint
limiter that background children hold (no reservation for the agent: owner Q14 (b)).

#### LOW

- **L1.** The title is re-logged at four segment-start sites (`hosted-session.ts:543,1213,1939,2084`).
  Re-emitting the markers (A4) at each of them is easy to forget at a fifth. Use ONE helper,
  `logSegmentFacts()` (title + running/undelivered markers).
- **L2.** Q2's "over the cap → error" should apply to background launches. Foreground spawns
  over the cap stay serialized in their lane as today. Otherwise a 4-way fan-out with 2
  background children running errors two calls that would simply have waited.
- **L3.** C4's laptop allowlist must be the UNION of `subagents.types.*.model` values and
  `subagents.selectableModels` (the owner's addition); C4 names only the former.
- **L4.** Task 2 stands alone with no rebuild if `subAgentView` returns the view-model that 6a
  (footbar), 7 (panel) and focus reuse: `{head, hidden, rows, done}` with a `maxRows`. Keep the
  state cap of 50 (`state.ts:189`), since the panel shows more than the tail.
- **L5.** A notify that arrives during the user's `/compact` is held, not dropped (task 9 test).

**Load-bearing assumption per load-bearing task, and how to prove it.**
- **4:** the laptop serves a name only from its OWN published set. Prove it with a hostile-pod
  test (a name outside the set → `InvalidRequest`, key never used) and an older-peer
  `VersionMismatch` test.
- **5:** the derivation over the current segment is idempotent, and a seed restates messages
  only. Prove it: load twice → one note; a new segment seeded from a closed load → no second note.
- **6a:** a child outlives its tool call without the turn's stream (H1). Prove it: a background
  child's tool events reach an IDLE client, and a later turn's stream carries none of them.
- **6b:** see M1.
- **8:** the inbox drains only at the child's boundaries. This already holds: `runMessages`
  takes `drainSteering` (`agent.ts:732`).
- **9:** the wake budget bounds ping-pong: 4 child notifies → ≤ 3 wakes, and the rest is
  delivered at the next user turn.

### Failure modes red-teamed (beyond H1–H3)

| Case | What happens (with the changes above) |
|---|---|
| Background child running while the user's turn runs and the agent compacts / `context_reset`s | Its exit stays in `pendingExits` across both (neither clears it). The note flushes at the next turn start. The markers are re-emitted at the new segment (A4, L1). The model is told what still runs (M4). Its ask, if any, is unaffected by `compacting` (H3). |
| Child ask vs the agent's ask | One dialog at a time, FIFO (client router). The dialog names `sa-N · type · "desc" (background)`. Owner Q5 holds. A pod-side ask is the same `permission_request` through the single laptop broker: no new trust path. |
| Esc | Stops the TURN and its FOREGROUND children (today's `ctx.signal`). Never a background child (own controller). Stopping one = `x` in the list (y/N) or `agent_kill`. Esc in the list / focus only closes it. |
| Quit with children | in-process / plain `run`: confirm (M7), then the lost note at resume. `serve`/`connect`/`--detach`: detaches, the child runs on, the session stays alive (H2). |
| Detach the TUI on `serve`, a second TUI attaches | The snapshot carries the `subagents` list WITH its tail (H1). The exit wakes via `daemonWakeGate`. The ask goes to an attached client; with none attached it is held (`blockingUnsupported` keeps today's "held for a client to attach"). |
| Pod `run`/`attach` | The child's model goes through the tunnel by name (task 4). A relay stays while children run (H2). The undelivered report reaches the laptop (M5). |
| llama.cpp slots, several endpoints | Foreground rounds: per-endpoint sizing (task 3). Background children: session limiter, no reservation (`feat/subagent-slots`, owner Q14 (b)). Until that lands, oversubscription only QUEUES on the server, so it is slow but correct. |
| Two-way ping-pong | B3's budget (3 child wakes per user message) + coalescing + a per-child cap. Child text is never a user row (M2). A user → child note never wakes (M2). |

### UI/UX

**Today, for background shell jobs:** a RUNNING job has no indicator at all. Only its exit
appears, as a dimmed notice deduped by job id (`state.ts:178-186`). On resume, its note shows as
a user row (M3). Subagents should not copy that silence. The list below is the first "what is
running in background" surface, and Q15 proposes it covers both kinds, so they feel like one
system: the same row grammar, the same exit notice, the same Ctrl+O to expand.

**Keys** (checked against the App handler and `input-actions.ts`). Taken: Shift+Tab
(auto-accept), Esc (stop / close), Ctrl+C, Ctrl+O (expand), Ctrl+X Ctrl+S (send-now), Ctrl+A/E/W/V,
Meta+B/F/D, and the arrows (history/scroll). **Ctrl+T is free** (`t` is used only without Ctrl,
in the permission reply, `permission-reply.ts:132`). Proposal: `/agents` + Ctrl+T toggles the
list (Q16). In the list: ↑↓ move, Enter focus, `x` stop, Esc close. In focus: the input is live
and Esc goes back.

Glyphs below are illustrative; the real ones are `render-lines.ts`'s.

1. **Foreground, rolling tail (A5, task 2)**, ≥ 80 cols:
```
● agent_task  explore · find callers of parseConfig
  … +14 earlier
  │ fs_read packages/config/src/schema.ts
  │ fs_grep "parseConfig(" packages/
  │ fs_read packages/cli/src/wiring.ts
  │ fs_grep "loadConfig" packages/cli
  │ shell bun test packages/config
  └─ 19 tool uses · 12.4k tok · 1m12s
```
2. **The user writes while it runs → background (6b).** The block freezes in place and says so:
```
● agent_task  explore · find callers of parseConfig
  … +17 earlier
  │ shell bun test packages/config
  └─ → background as sa-1 · its report will arrive later
› also check the docs folder
```
3. **Footbar list (6a: a count only; 7: the rows)**, idle, 2 running, ≥ 80 cols:
```
╭──────────────────────────────────────────────── qwen3-27b ╮
│ >                                                         │
╰───────────────────────────────────────────────────────────╯
 ~/repo · ctx ████░░░░ 42% · ⏵⏵ auto-accept off (shift+tab)
 ◐ sa-1 explore  find callers of parseConfig      19 tools · 1m12s
 ◑ sa-2 general  migrate tests to bun   ⚠ waiting for permission
   job 3         npm run watch                     running · 5m   (Q15)
                                                   ctrl+t agents
```
   At ~46 cols: the type drops, the description is cut by CELLS (string-width, as `cells.ts`),
   at most 2 rows + `+K more`:
```
 ◐ sa-1 find callers of parseCo… 19t 1m
 ◑ sa-2 migrate tests to bun   ⚠ perm
 +1 more · ctrl+t
```
4. **List (Ctrl+T or `/agents`; `ListPanel` over `tree-panel`):**
```
 Background agents                                         esc close
 ▸ sa-1 · explore · find callers of parseConfig · running · 19 tools
     fs_grep "loadConfig" packages/cli
     shell bun test packages/config
   sa-2 · general · migrate tests to bun · waiting for permission
   sa-0 · explore · map the repo · done (end_turn) · report delivered
 enter focus · x stop · ↑↓ move
```
5. **Focus on sa-1 (7/8): you write to the child, the agent is told at its next turn:**
```
 sa-1 · explore · find callers of parseConfig · running      esc back
   … +17 earlier
   fs_read packages/cli/src/wiring.ts
   [you → sa-1] skip the tests folder
   fs_grep "loadConfig" packages/cli
╭ → sa-1 ───────────────────────────────────────────────────╮
│ > _                                                       │
╰───────────────────────────────────────────────────────────╯
```
6. **The report arrives later** (live `subagent_exit`; the same notice style as a shell exit,
   deduped against the turn-start flush). The wake turn follows if the gate allows it:
```
 ◆ sa-1 finished (end_turn) · 19 tools · 1m40s — report sent to the agent (ctrl+o to read)
```
7. **Background ask** (queued FIFO behind any open dialog):
```
 sa-2 · general · "migrate tests to bun" · background
 shell  bun test packages/config
 ❯ Allow once   Allow always   Deny   Deny with reply
```
8. **Quit (M7)**, one row; combined when a `serve` session also has other terminals:
```
 2 background sub-agents (sa-1, sa-2) will be lost — quit? (y/N)
 1 other terminal attached · 2 sub-agents running — close the session for all? (y/N)
```
9. **Resumed session / `connect` attach:** lost and undelivered children are notices, never
   user rows (M3). A `connect` client sees the live list with its tail from the snapshot (H1):
```
 ⚠ sa-1 (find callers of parseConfig) was lost: the session restarted
 ◆ sa-2 finished before the restart — report sent to the agent (ctrl+o to read)
```

### Task split (revised)

| # | Task | Size | Blast | Reviewer |
|---|---|---|---|---|
| 1 | `feat/subagent-general-rename` (on a branch) | S | contained | in-context |
| 2 | `feat/subagent-tail-view` (+ reusable view-model, L4) | S | contained | in-context; a weaker model may execute |
| 3 | `feat/models-map` (limiter moved out, M8; selectableModels stays) | M | cross-module | in-context, by a strong model (config schema) |
| 4 | `feat/models-map-pod` (allowlist = union, L3) | M | load-bearing | fresh-context, red-team "pod not trusted" + "model stays on laptop" |
| 5 | `feat/subagent-ledger-log` (+ `note` field, M3) | M | load-bearing | fresh-context, red-team persistence (aside, segments, idempotence) |
| 6a | `feat/subagent-background` (H1–H3, M4, M5, M7) | L | load-bearing | fresh-context, red-team one session path, single broker, pod lifecycle |
| 6b | `feat/subagent-detach` (M1, Q13) | M | load-bearing | fresh-context, red-team the steering window |
| 6c | `feat/subagent-slots` (M8, Q14) | M | cross-module | in-context |
| 7 | `feat/subagent-panel` (list + focus, M6) | M | cross-module | in-context + a TUI frame test per mockup |
| 8 | `feat/agent-message` (+ user → child, M2) | M | load-bearing | fresh-context |
| 9 | `feat/agent-message-two-way` (typed steers, M2) | M | load-bearing | fresh-context |

Order: 1 → 2 → 3 → 4 → 5 → 6a → 6b → 6c → 7 → 8 → 9. Tasks 2 and 3/4 are independent of 5/6.
6c only needs 6a and 3. 7 may ship read-only after 6a, with its focus/write half after 8.
None of these is XL any more.

### Owner questions (round 3)

Five real design choices; they can be answered in one batch.

**Q13. Send-now (Ctrl+X Ctrl+S) while a subagent is working in the foreground.** Send-now
stops the turn today.
(a) the subagent first moves to background, then your message is sent, so its work is kept;
(b) the subagent is stopped with the turn, as today.
**Recommend (a):** "writing while it runs moves it to background" (Q1) should hold for both ways
of writing.

**Q14. Local model server with few parallel slots (llama.cpp `-np N`).**
(a) keep one slot for the agent itself, so background subagents can never block your chat
(with `-np 1` nothing can be kept back, so everything shares the one slot, as in (b));
(b) no reservation: everything shares the slots.
**Recommend (a).**

**Q15. The list under the footbar.**
(a) one "background" list: subagents AND running shell jobs (shell rows as a small follow-up
task);
(b) subagents only; shell jobs stay invisible until they exit, as today.
**Recommend (a):** one place to see what is running.

**Q16. The key that opens the subagent list.**
(a) only the `/agents` command;
(b) `/agents` and Ctrl+T (free today);
(c) `/agents` and ↓ on an empty input.
**Recommend (b).** (c) conflicts with history navigation.

**Q17. How many recent steps a foreground subagent shows (A5, never confirmed).**
(a) 5; (b) 3; (c) 8.
**Recommend (a).** The list/focus view shows more.

### Owner answers — round 3 (2026-11-08)

*— claude-opus-5-5 (orchestrator, recording the owner's answers), 2026-11-08*

- **Q13: (a).** Send-now while a foreground subagent runs first moves it to background, then sends; its work is kept (task 6b).
- **Q14: (b), against the recommendation.** No slot reserved for the agent: the agent and background subagents share the endpoint's slots. Task 6c keeps the session-level per-endpoint limiter for background children (M8) but drops the reservation; a busy background may make a chat round wait for a slot.
- **Q15: (a).** One "background" list under the footbar: subagents and running shell jobs (the shell rows are a small follow-up task).
- **Q16: (b).** `/agents` and Ctrl+T open the list.
- **Q17: (a).** 5 recent steps, as built and live-tested in `feat/subagent-tail-view` (merged 2026-11-08).
