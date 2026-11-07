# eval/subagent-live — live sub-agents: background on user input, agent→subagent messages, per-type models

> **Status:** eval (context + source-verified analysis; owner questions open)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promotion → the split in *Proposed split*
> **Type:** eval → feat · **Size:** L overall (split into 8 tasks, none XL) · **Blast:** load-bearing (the agent loop's steering window, the single session path, the model tunnel, protocol — AGENTS §7) · **Suited:** strong model + fresh-context Review for every load-bearing slice

Vocabulary (owner): **agent** = the main model the user chats with;
**subagent** = the child the agent starts with an `agent_task` tool call.

## Context

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
  block (`ModelConfigSchema`, `config/src/schema.ts:10-47`). Unset fields
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
- The child's permission asks carry the PARENT call id (`subagent.ts:107-122`).

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
  (`auto-wake.ts:24-37`; `cli/src/relay.ts:422`).
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
  (`hosted-session.ts:817`).
- On `detach`, `agent_task` resolves at once with
  `started in background as sa-<n>: <description>. Its report will arrive later
  as a [background] note; you can keep working.` The child keeps running. It
  moves into a session-level **agent-job registry**.
- **Transcript validity holds.** The `tool_call` gets a real `tool_result` in
  the same round (`agent.ts:1835-1836` pushes the tool message). The later
  report is a separate user-role note, like a shell exit's
  (`agent.ts:1858-1860`). The history-validity invariant
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
  spill transform as tool output (`subagent.ts:251-260`).
- `pendingExitCount` (`agent.ts:552-554`) counts both kinds, so the daemon
  wake (`hosted-session.ts:1757-1794`) works without a change. The live frame
  for TUI/relay wakes is a new display update `subagent_exit` (see A7). The
  TUI dedupes it against the turn-start flush, as it does for shell exits
  (`tui/src/App.tsx:684`).
- `retire/adoptExits` (`agent.ts:540-559`) already carry unflushed exits
  across an agent rebuild. The registry must move too, like `jobs`
  (`cli/src/wiring.ts:300-305`).

### A4. Persistence and resume

- A child's conversation lives only in memory (`subagent.ts:278-282`). The
  daemon persists only the PARENT history (`serve` only; pods and the
  in-process worker never persist — §7). A background subagent cannot survive a
  daemon restart, and it should not try to.
- **Proposal: derive "lost" from history; change no format.** A pure function
  over the parent messages finds each `agent_task` result that says `started in
  background as sa-N` with no later `[background] sub-agent sa-N` note. At open
  or reload, each such id gets ONE note: `[background] sub-agent sa-N was lost
  (the session restarted); its partial work may have had side effects.` The
  same function serves the laptop store (`--resume`) and the daemon reload. No
  `DAEMON_RECORD_VERSION` bump. The existing interrupted-subagent wording is
  the model (`daemon/src/persisted-session.ts:462-473`).
- `serve`: the daemon keeps running when the TUI detaches, so a background
  subagent keeps running too and wakes the session (`daemonWakeGate`). Pods: a
  detached run's relay keeps the pod daemon alive (docs/fix/detach-live.md),
  so the subagent runs on. A plain `run`/in-process session dies with its TUI,
  and the "lost" note covers it on resume.

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

**PROTOCOL_VERSION:** 17 today (`protocol/src/version.ts:7`). The background
slice bumps it to **18**. The display updates alone are free, but the
permission ask's changed meaning is not (an older client would attach the prompt
to a finished row, or the daemon would refuse it). The pod-models slice (C) also
needs a bump (C5). If both land in one release window, they share it.

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
  (`wiring.ts:472-475`).
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
  with the title model for `purpose:"title"` (`client/src/remote-client.ts:2452-2466`;
  `protocol/src/model.ts:53-67`).
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
- **F4 Resume / daemon reload.** The child is gone (memory only). The note is
  derived from history (A4), so it converges on the laptop store and the
  daemon record alike, and is never written twice: the note itself closes the
  id.
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
  The record is archived with the "lost" ids derivable.
- **F11 Agent rebuilt by a settings sync.** The registry carries over like
  `jobs` (`wiring.ts:300-305`), and unflushed agent exits move through
  `retire/adoptExits` (`agent.ts:540-559`).

## Proposed split into tasks

*— claude-opus-5-5, 2026-11-07*

In dependency order. Each one ships alone.

| # | Task | Size | Blast | Notes |
|---|---|---|---|---|
| 1 | `feat/subagent-general-rename` | S | contained | rename + tests + docs (C2). First: C's config keys name types, so rename before users write configs |
| 2 | `feat/subagent-tail-view` | S | contained | pure `subAgentView` rolling tail (A5). A weaker model may execute it |
| 3 | `feat/models-map` | M | cross-module | `models`, `subagents.types.<t>.model`, resolution, the C3 rule, per-endpoint slot limiter (C1, C3, C6). Local/serve only; in a pod a type model is still ignored, as today, with a daemon-log notice |
| 4 | `feat/models-map-pod` | M | load-bearing | `model` name on `model/stream*`/`slots`, laptop allowlist, carry `type→name` (C4, C5). Bumps `PROTOCOL_VERSION` |
| 5 | `feat/subagent-background` | L | load-bearing | `detach` seam, agent-job registry, exit note with report, own controller, cap, background ask (F2), "lost" derivation, `subagent_exit` + `subagents` updates, `agent_kill` tool/method. Bumps `PROTOCOL_VERSION`. TUI: a minimal footbar count only |
| 6 | `feat/subagent-panel` | M | cross-module | footbar list + openable panel on `tree-panel` (A6) |
| 7 | `feat/agent-message` | M | load-bearing | one-way `agent_message` (B1): child steering drain |
| 8 | `feat/agent-message-two-way` | M | load-bearing | `agent_notify`, wake, guard (B2, B3), behind the Q3 switch |

**Go first:** #1 (tiny, unblocks C naming). Then #2 (visible at once,
independent). #5 is the core of A. It depends on nothing in C, so the owner
may order it before #3–#4. #7 needs #5 (only background ids are addressable).
#8 needs #7.

## Owner questions

*— claude-opus-5-5, 2026-11-07*

**Q1. Can the user write directly to an opened subagent?**
(a) No, panel is read-only; (b) yes, the text goes to the child as with
`agent_message`, and the parent is told at its next turn
(`[user → sa-1] …`); (c) yes, and the parent is never told.
**Recommend (b)**, after #7, reusing its inbox. The parent's context stays
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
