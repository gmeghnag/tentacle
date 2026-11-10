# feat/agent-message-two-way — a background sub-agent writes to the agent, and wakes it (opt-in)

> **Status:** implementation
> **Branch:** `feat/agent-message-two-way`
> **Type:** feat · **Size:** M · **Blast:** load-bearing · **Suited:** DeepSeek exec, one Opus review (fresh context)

## Context

*— claude-opus-5-5, 2026-11-10*

Task 9 of the sub-agent live feature (`docs/eval/subagent-live.md`, B2 + B3, split row 9). Task 8
(`docs/feat/agent-message.md`, merged) gave the agent `agent_message(agent_id, text)`: agent →
child, one-way, never a wake. This task adds the other direction: a running **background** child
calls `agent_notify(text)`; the text reaches the PARENT agent as a note in its conversation and,
when the parent is idle, **wakes it** through the same wake path as a background exit. The parent
answers, if it wants, with task 8's `agent_message`.

Decided already (not re-asked): enabled by config `subagents.twoWay`, default `false`, carried P
(owner Q3 a). With it off, nothing changes: no child gets the tool. A wake budget bounds ping-pong
(eval B3). A child's text is never rendered as a user row (eval M2). The parent's `agent_message`
never wakes anything (task 8). A notify that arrives during `/compact` is held, not dropped (eval L5).

Constraints from the brief: the SAME wake path as a background exit (note + autoWake, in-process,
worker, `serve`, detached relay), never a second agent loop. A notify arriving while the parent's
turn runs is delivered at that turn's next boundary (steering), not as a wake. No new log entry
type. No `PROTOCOL_VERSION` bump if avoidable.

**Repro** (capability missing, `main` 125b38a, 2026-11-10):

```
$ rg -n "agent_notify|twoWay|subagent_notify|subagentsTwoWay" packages apps/mobile/src; echo "exit=$?"
exit=1
```

No tool, no key, no update. A child today can reach its parent only through its final report
(`[background] sub-agent sa-N … finished`, `agent.ts:1904-1909`).

## Implementation

*— claude-opus-5-5, 2026-11-10*

### Load-bearing assumption

**A child's `agent_notify` can enter the parent through the parent Agent's existing exit queue
(`pendingExits`), synchronously, in the same process. From there every existing waker sees it
with no new loop: the `serve` daemon through `pendingExitCount`, an attach through
`unflushedExits`, and the turn's start flush.**

Proof (current code):
1. **One `AgentJobs` per session, shared by the parent Agent and the child runner.** `wiring.ts:415`
   creates it (or reuses `options.agentJobs`). The same instance goes to the task tool
   (`wiring.ts:565`, `background: agentJobs`), to `agent_kill`/`agent_message` (`:577`, `:580`)
   and to the parent `Agent` (`wiring.ts:606-611`, `agentJobs`). A settings rebuild keeps it:
   `session-host.ts:1010-1013` treats a different instance as foreign, and
   `hosted-session.ts:1900-1913` hands the same `agentRuntime` to the rebuild.
2. **The child runs daemon-side, in that process.** The runner is built in the same `wiring`
   (`wiring.ts:535-549`). Its children are plain `Agent`s built per run (`subagent.ts:307-380`).
   They get no `agentJobs` (no match for `agentJobs` in `subagent.ts`), so a child never subscribes
   to anything.
3. **The parent collects exits synchronously.** The constructor subscribes:
   `config.agentJobs?.onExit((exit) => this.pendingExits.push(exit))` (`agent.ts:561-562`). A
   `retire` hands the queue to the next agent (`:570-576`, `adoptExits` `:603-605`). The turn
   start flushes all of it (`agent.ts:864`, `flushBackgroundExits` `:1889-1938`).
4. **Every waker reads that queue.**
   - `serve`: `maybeWake` checks `this.session.pendingExitCount > 0` (`hosted-session.ts:2156-2165`).
     A listener calls `kickWake` (`:2139-2147`), and every turn end calls it too (`:2128-2131`).
   - Attach: `session/open` reports `unflushedExits` (`hosted-session.ts:1279-1284`,
     `connection.ts:470`).
   - TUI and relay: they wake on a session-level notice (`App.tsx:736-768`, `relay.ts:425-427`)
     through `wakeDue` (`auto-wake.ts:35-37`). A turn start flushes everything, so N notices before
     a start give ONE wake (`auto-wake.ts:5-6`).

So a notify that `AgentJobs` pushes to the Agent the way it pushes an exit is collected, carried
across a rebuild, flushed and woken for by code that already exists. The new pieces are: the
source (`AgentJobs.notify`), a discriminated queue member, a mid-turn flush, and ONE notice so the
TUI and the relay can arm their wake.

The executor's first test (T1) pins it: an `AgentJobs.notify` → the parent's `pendingExitCount`
becomes 1 in the same synchronous stretch → `Session.send("")` → that turn's first request
contains the note. Red until `notify`/`onNotify` exist and the Agent subscribes.

### Preconditions

- `PendingExit = BackgroundJob | AgentJobExit` (`agent.ts:228`) is told apart today by
  `"agentId" in job` (`agent.ts:1896`). A notify also has `agentId`, so it needs an explicit
  `kind` checked FIRST. `BackgroundJob` has no `kind` field (`core/src/jobs.ts:18-28`), and
  neither does `AgentJobExit` (`agent-jobs.ts:66`).
- The steering drains run at the top of every iteration (`agent.ts:911-914`) and at the late drain
  (`:1040-1047`). From the late drain to `turn_end` there is no `await` (the invariant comment at
  `:1026-1039`). Whatever is added there must be synchronous.
- The user-message reset already exists: `opts.userMessage === true` (`agent.ts:797-799`) or a
  drained steer (`:800-806`). This is where the budgets reset.
- An empty `Session.send("")` is a continuation with `userMessage: false` (`session.ts:114-142`).
  It is used by the TUI wake (`App.tsx:766`), the relay wake (`relay.ts:441`) and the daemon wake
  (`hosted-session.ts:2181`).
- `context_note.reason` is a closed enum `["continue","background_exit","hook"]`
  (`protocol/src/updates.ts:121-124`). An older client gets a value outside it as a *malformed*
  known update, which is an error, not "unsupported" (`client/src/mapping.ts:52-58`). **So no new
  reason:** the flush emits `reason: "background_exit"`, which the TUI already hides
  (`tui/src/state.ts:488-489`).
- A new session-level update type IS free: it joins the union plus `UPDATE_CLASS` as `display`
  (`updates.ts:314-342`). An older client skips it as `unsupported` once (`mapping.ts:59-68`).
- A `ChatMessage.note.kind` is a free string. `resume.ts:13-27` renders an unknown kind as a
  notice, never as a user row. The ledger only reacts to `subagentReport`/`subagentLost`
  (`core/src/agent-job-ledger.ts:134`, `:247`), so a new kind cannot disturb it.
- The pattern for a session-level listener on the client is `subagents`: routing
  `remote-client.ts:2296-2298`, `onSessionSubagents` `:839`, `RemoteSession.onSubagents`
  `remote-session.ts:458`, the TUI's optional `onSubagents?` `App.tsx:300`, and the relay's
  `session.onSubagents?.` (`relay.ts:431`).
- Children never get parent-only tools: the filter is at `subagent.ts:307-326` and
  `readOnlyType` at `:494-515`. `SubagentRunControls.agentId` is set only on a child launched in
  the background (`subagent.ts:134-138`); a movable foreground child has `move` instead.
- Carried P key pattern: `subagentMaxParallel`. Wire field `protocol/src/session.ts:559`, `CARRIED`
  row `cli/src/carried-settings.ts:81-87`, schema `config/src/schema.ts:265-300`, resolution
  `config/src/resolve.ts:428,564,603`, `load.ts:163,856`, docs `config/src/key-docs.ts:521-535`.
- §7 pod rule: the tool runs in the pod daemon for `run`/`attach`. The only laptop effects are a
  notice and a wake. The wake is a turn the laptop's own driver starts, gated by the laptop's
  `autoWake`, and below by the laptop's `subagents.twoWay`. A pod can already cause the same
  effect today with a `background_exit` frame, so this adds no new trust path.

### Design

**1. Limits and the source: `AgentJobs.notify` (`packages/core/src/agent-jobs.ts`).** It is the one
source of truth for every limit, synchronous and never throwing, like `message` (`:393-430`).

```ts
export const AGENT_NOTIFY_PER_CHILD = 8;     // accepted notifies per child between two user messages
export const AGENT_NOTIFY_WAKES = 3;         // waking notifies per session between two user messages
// size: reuse AGENT_MESSAGE_MAX_CHARS (8_000, core/src/agent-inbox.ts:24)

export interface AgentNotify {
  readonly agentId: string;
  readonly description: string;
  readonly text: string;
  readonly wakes: boolean;
}
export type AgentNotifyResult = { ok: true; wakes: boolean } | { ok: false; reason: string };

notify(agentId: string, text: string): AgentNotifyResult;
onNotify(listener: (n: AgentNotify) => void): () => void;
/** A user message reached the parent: both budgets start over. */
userMessage(): void;
```

- The running entry (`:158-168`) gains `notified: number` (starts at 0). The class gains
  `private notifyWakesLeft = AGENT_NOTIFY_WAKES` and a `notifyListeners` Set. `dispose` clears
  that Set as well.
- `notify` checks in this order:
  1. Not in `running`: `${id} is not running: nothing was sent.`
  2. `killed`: `${id} is being stopped: nothing was sent.`
  3. Over `AGENT_MESSAGE_MAX_CHARS`: the same wording as `message`.
  4. `notifyListeners.size === 0`: `no parent agent is listening: nothing was sent. Put it in your
     final report.` This is never a silent drop.
  5. `entry.notified >= AGENT_NOTIFY_PER_CHILD`: `you already sent ${N} messages to the parent
     agent since the user last wrote: nothing was sent. Put the rest in your final report.`

  Otherwise: `entry.notified++`. `wakes = notifyWakesLeft > 0`, and if so `notifyWakesLeft--`.
  Call every listener with `{agentId, description: entry.job.description, text, wakes}`
  synchronously, then return `{ok: true, wakes}`. No `changed()`.
- `userMessage()` sets `notifyWakesLeft = AGENT_NOTIFY_WAKES` and every `entry.notified = 0`.

**2. The parent Agent (`packages/agent/src/agent.ts`).**
- The queue type: `export type PendingExit = BackgroundJob | AgentJobExit | PendingAgentMessage`,
  where `PendingAgentMessage = { readonly kind: "agent_message" } & AgentNotify`.
  Add `const isAgentMessage = (p: PendingExit): p is PendingAgentMessage => "kind" in p &&
  p.kind === "agent_message";`.
- The constructor adds `this.unsubscribeAgentNotify = config.agentJobs?.onNotify((n) =>
  this.pendingExits.push({ kind: "agent_message", ...n }))`. `retire` unsubscribes it too.
- `pendingExitCount` (`:598-600`) counts `pendingExits.filter((p) => !isAgentMessage(p) ||
  p.wakes).length`. A non-waking note is still flushed; it just never asks for a wake. (Task 7's
  planned `user_note` member is not counted either. See Compatibility.)
- The note builder `agentMessageNote(n): ChatMessage`, exported for tests:
  ```
  [sub-agent sa-1 → you] <text>
  (background sub-agent sa-1 (<description>) sent this while it was running. To answer, use agent_message({ agent_id: "sa-1", text }). Its final report still arrives as a [background] note.)
  ```
  `role: "user"`, `note: { kind: NOTE_KIND.subagentMessage, id: agentId }`.
- `flushBackgroundExits` (`:1889`): at the top of the loop body, `if (isAgentMessage(job)) {
  messages.push(agentMessageNote(job)); events.push({ type: "context_note", text, reason:
  "background_exit" }); continue; }`. This is BEFORE the `"agentId" in job` branch. Order is
  preserved, so a child's notify always comes before its own report.
- **The mid-turn flush.** Add `private flushAgentMessages(messages): AgentEvent[]`. It removes ONLY
  the `agent_message` members from `pendingExits` (rebuild the array in place: keep the others in
  order), builds the same notes, and is synchronous. Call it:
  - at the iteration boundary, right after the steer loop (`agent.ts:911-914`);
  - at the late drain (`:1040`): `const late = drain(); const notes =
    this.flushAgentMessages(messages); if (late.length > 0 || notes.length > 0) { …push/yield the
    steers, then yield the notes…; continue; }`. It must stay synchronous (the invariant
    comment).

  Exits are NOT flushed mid-turn: a shell or child exit keeps today's turn-start behaviour. The
  other drains (hook stop `:890`, max-iterations `:1096`, `:1155`) do not flush notes. Those notes
  stay queued, are delivered at the next turn start, and count in `pendingExitCount`, so the
  daemon's post-turn `kickWake` (`hosted-session.ts:2130`) and the TUI's post-turn
  `wakeIfPending` pick them up.
- After a flush with ≥ 1 note, set `this.notesFlushedMidTurn = true` (memory only).
- **The budget reset.** Where `resetsThisMessage = 0` runs for a user message (`:797-799`) and for
  a drained steer (`:800-806`), also call `this.config.agentJobs?.userMessage()`.
- **The stale-wake guard (narrow).** The TUI and the relay arm their wake on the notice (Design 4).
  If the note was then delivered mid-turn, their post-turn check starts a continuation over a
  history with nothing new. Right after the turn-start flush (`:864`), add:

  ```ts
  if (this.notesFlushedMidTurn && opts.userMessage !== true && opts.resumeFrom === undefined &&
      opts.skill === undefined && flushedAtStart.length === 0 && endsWithFinalAnswer(messages)) {
    const early = drain();
    if (early.length === 0) { this.notesFlushedMidTurn = false; yield { type: "turn_end", reason: "end_turn" }; return; }
    for (const text of early) { messages.push({ role: "user", content: text }); yield { type: "steer", text }; }
  }
  this.notesFlushedMidTurn = false;
  ```

  `endsWithFinalAnswer` means the last message is `assistant` with no `toolCalls`. Keep the
  `flushBackgroundExits` events in a local `flushedAtStart`. The guard fires only after a
  mid-turn note, so **with `twoWay` off the flag is never set and behaviour is exactly today's.**
  The early `turn_end` follows the hook-stop precedent (`:894-895`).

**3. The child tool (`packages/tools/src/background.ts`, beside `createAgentMessageTool`).**
`AGENT_NOTIFY_TOOL_NAME = "agent_notify"`. `createAgentNotifyTool(agentId: string, notify: (id,
text) => AgentNotifyResult)` takes `permission: "none"` and input `{ text: string.min(1) }`.

- Description: send a short message to the agent that launched you, while you keep working. Use it
  for an intermediate finding or a question it must decide. It may wake it. Your final report is
  still what it gets when you finish. At most 8 per user message, 8 000 characters each. A reply,
  if any, arrives as `[message from the parent agent]` before a later step. Do not stop and wait
  for one.
- Results:
  - ok, wakes: `sent to the parent agent (it reads it at its next step, now if it is idle). Keep
    working.`
  - ok, does not wake: `sent to the parent agent; it is not woken now (too many wakes since the user
    last wrote), it reads it at its next step. Keep working.`
  - refused: `{ content: reason, isError: true }`.

Export it from the tools package index like `createAgentMessageTool`.

**4. Register it in the CHILD only (`packages/agent/src/subagent.ts`).** `SubagentDeps` (`:244`)
gains `readonly notify?: (agentId: string, text: string) => AgentNotifyResult`. In `run`, after
the filter loop (`:307-326`): `if (deps.notify && controls?.agentId !== undefined)
childTools.register(createAgentNotifyTool(controls.agentId, deps.notify))`.

- It bypasses `type.tools` on purpose: it is a channel back, not a capability. A read-only
  `explore` child gets it too.
- The filter loop also skips `AGENT_NOTIFY_TOOL_NAME`, so a parent registry can never leak one,
  and `readOnlyType` (`:494-515`) ignores it.
- It is registered only for a child launched in the background. Owner Q3 decides moved children.

**5. Wiring (`packages/cli/src/wiring.ts:535`).** Pass `...(config.subagentsTwoWay ? { notify:
(id, text) => agentJobs.notify(id, text) } : {})` to `createSubagentRunner`. That is the whole
switch. A settings sync rebuilds the wiring, so children launched after it follow the new value. A
running child keeps the registry it was launched with, and `agentJobs` is the same instance.

**6. Config key `subagents.twoWay` (P, carried).**
- `schema.ts` `subagents`: `twoWay: z.boolean().optional()`.
- `resolve.ts`/`load.ts`: `subagentsTwoWay: boolean`, default `false`
  (`DEFAULT_SUBAGENTS_TWO_WAY`), env `TENTACLE_SUBAGENTS_TWO_WAY`. Follow `subagentMaxParallel`
  line by line.
- Wire: `protocol/src/session.ts:559` area: `subagentsTwoWay: z.boolean().optional()`. It is a free
  field.
- `carried-settings.ts`: a `subagentsTwoWay` row, `class: "P"`, `configKey: "subagents.twoWay"`.
- `key-docs.ts`: entry `"subagents.twoWay"`. Summary: "Background sub-agents may message the agent
  (`agent_notify`); a message wakes an idle agent." Fields: kind leaf, type boolean, scope both,
  carried pinned, default false, env as above, sample `on`, example `true`. Details: the limits
  (8 per child and 3 wakes per user message, 8 000 characters); the wake follows `autoWake`; off
  means children never get the tool.

**7. The notice (protocol → daemon → client → TUI/relay).** This is the only wire addition. It is
display class, so no bump.
- `protocol/src/updates.ts`: `SubagentNotifySchema = z.object({ type: z.literal("subagent_notify"),
  agentId: z.string().min(1), text: z.string(), wake: z.boolean() })`. Add it to the union and set
  `UPDATE_CLASS.subagent_notify = "display"`. In `client/src/mapping.ts`, its reverse mapping
  returns `null` (non-turn, like `subagents`).
- `daemon/src/hosted-session.ts`, beside `agentRuntime?.onExit` (`:649-662`):
  `this.unsubscribeAgentNotify = agentRuntime?.onNotify((n) => { this.emit({ type:
  "subagent_notify", agentId: n.agentId, text: wireLine(n.text, AGENT_MESSAGE_MAX_CHARS), wake:
  n.wakes }); if (n.wakes) this.kickWake(); })`. Unsubscribe it on close beside
  `unsubscribeAgentExit`. Listener order is safe: the Agent's listener was added at construction,
  before this one. `kickWake` is a macrotask (`:2143`), and `maybeWake` reads `pendingExitCount`,
  so an over-budget note never wakes and a note already flushed mid-turn reads 0.
- `client`: routing beside `subagents` (`remote-client.ts:2296`) goes to
  `subagentNotifyChanged(entry, bounded)` and then to `onSessionSubagentNotify` listeners
  (pattern `:839`, `:1897`). Bound it in `client/src/subagents.ts` with `boundSubagentNotify`:
  `agentId` ≤ 64, `text` ≤ 8 000, control characters except `\n` stripped as `progressText`
  does. `RemoteSession.onSubagentNotify(listener)` follows the pattern of `remote-session.ts:458`.
- TUI (`App.tsx`): add an optional `onSubagentNotify?` on the session interface (`:300`) and
  subscribe beside `onSubagents` (`:1597`). On a notice:
  1. `stateRef.current = appendNotice(state, subagentNotifyNotice(n.agentId, n.text))`. Put
     `subagentNotifyNotice` in a pure module `packages/tui/src/subagent-notify.ts`. The notice is
     `sa-1 → agent: <first line, ≤ 200 chars, "…" if cut>`.
  2. If `n.wake && subagentsTwoWay`: run the same wake step as the exit handler (`:747-767`).
     Extract that step into a local `armWake()` used by both handlers. Do not duplicate it.

  `subagentsTwoWay` reaches `startTui` like `autoWakeOnJobExit` (`run.tsx:36`,
  `main.ts:1043/1836/1887`): add `subagentsTwoWay: config.subagentsTwoWay`. That check is the
  laptop gate (§7). On `connect`, `autoWakeOnJobExit` already makes the daemon the only waker, so
  the same rule holds for notes.
- Relay (`cli/src/relay.ts:425`):
  ```ts
  const offNotify = config.autoWake && config.subagentsTwoWay
    ? session.onSubagentNotify?.((n) => { if (n.wake) emit({ type: "job_exit" }); }) ?? (() => {})
    : () => {};
  ```
  Release it beside `offExit`. `relayWakeDue` is unchanged.

**What the user sees:** the live notice `sa-1 → agent: …` as the child sends it. If the parent
was idle and autoWake is on, a continuation turn follows. On `--resume`, the note renders as a
notice (`resume.ts:13-27`).

**What persists:** only the parent's note, once flushed: an ordinary `message` entry with
`note.kind = "subagent_message"`. No new log type. The `subagent_notify` update is rendering-only
and never persisted.

**Compatibility with task 7 (`feat/subagent-panel`, unmerged).** Task 7 plans
`session/subagent_message` plus a display update `subagent_message {agentId, text}` (user →
child), a `PendingExit` member `{kind: "user_note"}` and `NOTE_KIND.userToSubagent`. This task uses
other names in every place: the update `subagent_notify`, the member `kind: "agent_message"`, the
note kind `subagent_message`. Both members use the same `kind` discriminator; neither counts as a
wake unless it says so; each has its own client listener; the TUI notice helpers sit side by side
(`→ agent` versus `user → sa-1`). Whichever task lands second rebases onto the other's
`PendingExit` union, `pendingExitCount` filter and `NOTE_KIND` additions (additive, no conflict
in meaning). Task 7's `boundSubagentMessage` and this task's `boundSubagentNotify` can share one
helper; the second to land factors it.

### Files

Dependency order (protocol → core → agent → tools → config → daemon → client → cli → tui):

1. `packages/protocol/src/updates.ts`: `SubagentNotifySchema`, union, `UPDATE_CLASS`.
   `packages/protocol/src/session.ts`: `subagentsTwoWay` settings field. Index exports.
2. `packages/core/src/model.ts`: `NOTE_KIND.subagentMessage = "subagent_message"`.
3. `packages/core/src/agent-jobs.ts`: constants, `AgentNotify`, `notify`, `onNotify`,
   `userMessage`, `notified` on the entry, `dispose` clears the listeners. Index exports.
4. `packages/agent/src/agent.ts`: `PendingAgentMessage`, `isAgentMessage`, subscription and
   retire, `pendingExitCount`, `agentMessageNote`, the flush branch, `flushAgentMessages` (2 call
   sites), the budget reset, the stale-wake guard.
5. `packages/tools/src/background.ts`: `AGENT_NOTIFY_TOOL_NAME`, `createAgentNotifyTool`, plus the
   index export.
6. `packages/agent/src/subagent.ts`: `SubagentDeps.notify`, registration, filter and
   `readOnlyType` exclusion.
7. `packages/config/src/schema.ts`, `resolve.ts`, `load.ts`, `key-docs.ts`: `subagents.twoWay`.
8. `packages/cli/src/carried-settings.ts`: the P row. `packages/cli/src/wiring.ts`: `notify` into
   the runner.
9. `packages/daemon/src/hosted-session.ts`: `onNotify` → emit plus `kickWake`, unsubscribe.
10. `packages/client/src/subagents.ts` (bound), `remote-client.ts` (route plus listener),
    `remote-session.ts` (`onSubagentNotify`), `mapping.ts` (reverse `null`).
11. `packages/cli/src/relay.ts`: `offNotify`. `packages/cli/src/main.ts`: pass `subagentsTwoWay`
    to the TUI (3 call sites beside `autoWakeOnJobExit`).
12. `packages/tui/src/subagent-notify.ts` (new, pure). `packages/tui/src/App.tsx`: subscription,
    `armWake` extraction. `packages/tui/src/run.tsx`: option pass-through.
13. Tests (below). This doc's Execution section.

**Protocol:** one new `display` update (`subagent_notify`) and one optional settings field. Both
are free under v10 forward-compat. **No `PROTOCOL_VERSION` bump** (stays 21,
`protocol/src/version.ts:17`). No new log entry type, critical or not.

### Failure modes

| Case | What happens | Converges because |
|---|---|---|
| `twoWay` off | No child has `agent_notify`; `notify` is never called; the guard flag is never set | Wiring passes no `notify` (Design 5); the flag is set only by a mid-turn note |
| Parent turn running | The note is injected at the next iteration boundary or the late drain, in the same turn. The notice shows at once. The daemon's `kickWake` reads 0 after the flush, so no wake | `flushAgentMessages` at `agent.ts:911`/`:1040`, synchronous |
| Notify lands after the late drain, before `turn_end` / during a hook-stop or max-iterations end | Stays queued and counted. The post-turn `kickWake` (serve) or `wakeIfPending` (TUI, armed by the notice) starts ONE continuation; its start flushes it | `pendingExitCount` includes it; the turn-start flush |
| TUI or relay armed by a note that was then delivered mid-turn | Its post-turn continuation hits the guard: `turn_end end_turn`, no model request | `notesFlushedMidTurn` guard (Design 2) |
| Parent idle, autoWake off | The notice shows; no turn. The note is delivered at the next user turn's start | The TUI gate `enabled: false`; the note stays in `pendingExits` |
| Many children notify at once | All are queued; ONE wake; one turn start flushes all, in arrival order | Flush-at-start coalescing (`auto-wake.ts:5-6`) |
| Over the wake budget (4th waking notify since the user wrote) | Accepted with `wakes: false`: the notice shows, no client arms, the daemon reads it as uncounted. Delivered at the next boundary of any turn | `AGENT_NOTIFY_WAKES` in `AgentJobs`; `pendingExitCount` filter |
| Per-child cap (9th notify from one child since the user wrote) | Tool error to the child: "put the rest in your final report". Nothing is queued | `AGENT_NOTIFY_PER_CHILD` |
| Over 8 000 characters | Tool error; nothing is queued | Size check before anything else is changed |
| Ping-pong (child notify → wake → parent `agent_message` → child notify …) | At most 3 wakes; then notes queue without a wake; at most 8 per child. A parent's `agent_message` never wakes. Bounded until the user writes | Both budgets reset only on a user message (`agent.ts:797-806`) |
| Child ends (or is killed) right after notifying | The notify note is flushed before its report note (queue order); one wake for both | One array, order kept |
| Child already gone when its note flushes | The note says "sent this while it was running"; a parent `agent_message` gets task 8's "not a running background sub-agent" | Honest wording; task 8's refusal |
| No Agent subscribed (between retire and construct, or a library user without an Agent) | Tool error "no parent agent is listening" | Listener-count check (Design 1, step 4) |
| Settings rebuild while notes are pending | `retire` → `adoptExits` carries them, like exits | `agent.ts:570-576`, `:603-605`; T6 mirrors the existing exit test |
| `/compact` running | The note is held: the daemon gate is `busy`, the TUI defers. Flushed at the next start | `pendingExits` survives compaction (eval L5) |
| `/clear` | Children survive; pending notes survive (in-place reset) and are delivered into the cleared chat with their `sa-N` | The same array, not reset by clear |
| Quit (in-process / plain `run`) | Children are aborted (`dispose`); an unflushed note is lost with them, exactly like an unflushed shell exit today. The next open shows 6a's lost note for the child | Owner Q2 (recommend: accept, documented) |
| `serve` reload with an unflushed note | Same: memory-only, lost with the child; the lost note at load names the child | Owner Q2 |
| Detached run (relay) | The relay's `offNotify` emits `job_exit` on a waking notice and the relay starts the continuation; its `relayWakeDue` gates as for exits | `relay.ts:425-441` path reused |
| `connect` to `serve` | The daemon is the only waker (`autoWakeOnJobExit` already off for connect); the TUI shows the notice | `maybeWake` reads the counted queue |
| Pod sends a hostile `subagent_notify` | Bounded in the client; a wake only if the laptop's `twoWay` and `autoWake` are on. The same effect as a forged `background_exit` today | Laptop gate (Design 7) |
| Older client, newer daemon | `subagent_notify` shown `unsupported` once; no wake from it on that client; the note is delivered at the next turn | Display class |
| Older pod daemon (ignores `subagentsTwoWay`) | Two-way is off in that pod | A strip schema drops the field |

### Tests

Red-before-green (§9): write each test against the final API, stub the new code to the naive
behaviour, watch the assertion fail, then implement. A compile error is not a red. Use the
existing fakes: the scripted/gated `ModelProvider` from `packages/agent/test/subagent.test.ts` and
`packages/cli/test/agent-message.e2e.test.ts`. No real I/O.

- `packages/core/test/agent-jobs.test.ts` (extend)
  - T2 `notify` refusals: unknown id, killed, over-length, no listener, 9th from one child. Each
    is `ok: false`, and no listener call happens.
  - T3 wake budget: 4 notifies (two children) → `wakes` is `[true, true, true, false]`;
    `userMessage()` → the next is `true`; the per-child counter is reset too.
  - T4 listeners are called synchronously, before `notify` returns, with the description.
- `packages/agent/test/agent.test.ts` (extend; an `AgentJobs` with a fake started child)
  - **T1 (LBA)**: `jobs.notify("sa-1", "found X")` → `agent.pendingExitCount === 1` in the same
    stretch → `Session.send("")` → the first model request contains `[sub-agent sa-1 → you] found
    X` with `note.kind === "subagent_message"`, and the stream has `context_note{reason:
    "background_exit"}`. Red without the subscription.
  - T5 mid-turn: with a gated model, a notify during round 1 is in round 2's request, in the same
    turn. `pendingExitCount` is 0 at `turn_end`. A notify AFTER the last round (pushed from the
    gate release of the final round) → `continue`, one more round. Red with the late drain
    unchanged.
  - T7 a non-waking note is not counted in `pendingExitCount` but is still flushed at the next
    start. A child's notify flushes before its exit note.
  - T8 guard: a note flushed mid-turn, then `send("")` → `turn_end end_turn`, zero model requests.
    Without a mid-turn note, `send("")` over the same history DOES call the model (today's
    behaviour preserved, which proves the guard is narrow). Mutation: drop the
    `notesFlushedMidTurn` condition → the second half fails.
  - T9 the budget reset: a user `send("hi")` calls `agentJobs.userMessage()` (spy); a `send("")`
    does not.
- `packages/agent/test/replace-agent.test.ts` (extend) — T6: a pending note survives
  `retire`/`adoptExits` exactly once (mirror the existing exit case).
- `packages/agent/test/subagent.test.ts` (extend) — T10: with `deps.notify` and
  `controls.agentId`, the child's first request lists `agent_notify`. Without `notify`, or with a
  foreground child (no `agentId`), it does not. An `explore` child gets it too. `readOnlyType`
  is unchanged.
- `packages/tools/test/agent-notify.test.ts` (new, mirrors `agent-message.test.ts`) — T11: the
  result texts for ok+wake, ok+no-wake and a refusal (`isError`).
- `packages/config/test/…` (the existing key-docs/resolve tests) — T12: `subagents.twoWay`
  parses, defaults to false, has an env override and a key-docs entry (the registry completeness
  test must pass). `packages/cli/test/carried-settings…` — T13: the P row round-trips.
- `packages/daemon/test/serve-autowake.test.ts` (extend) — T14: idle `serve` session, a waking
  notify → the daemon starts ONE wake turn whose request has the note. A non-waking notify starts
  none. A notify during `/compact` is held and woken for after it.
- `packages/client/test/…` (beside the `subagents` routing tests) — T15: a `subagent_notify` frame
  reaches `onSubagentNotify`, bounded (control characters stripped, 8 000 cap); an unknown-field
  frame still parses.
- `packages/cli/test/relay-state.test.ts` / `relay.test.ts` (extend) — T16: a waking notice with
  `autoWake` and `twoWay` on drives one continuation; `wake: false` or `twoWay` off drives none.
- `packages/tui/test/auto-wake.test.tsx` (extend) — T17: a waking notice while idle starts a
  continuation; while running, it starts one after `turn_end`; `twoWay` off → a notice only.
  `packages/tui/test/subagent-notify.test.ts` (new) — T18: the notice text (first line, 200-char
  cut).
- **`packages/cli/test/agent-message-two-way.e2e.test.ts` (new, the real `createLocalRuntime` ↔
  `Connection` stack of `agent-message.e2e.test.ts`, `subagents.twoWay: true`)**
  - T19 The parent launches `agent_task{background:true}` → `sa-1`; the parent's turn ends. The
    child's scripted round calls `agent_notify{text:"found X"}`. The client gets
    `onSubagentNotify({agentId:"sa-1", text:"found X", wake:true})`, and `session/open`'s
    `unflushedExits` is 1. The test then does what the TUI does: `send("")`. That turn's request
    contains the note. Then the parent calls `agent_message{agent_id:"sa-1", text:"go on"}`, and
    the child's next request contains `[message from the parent agent] go on`. The round trip is
    complete over RPC.
  - T20 the same stack with the parent's turn held by a gated model: the child notifies → the note
    is in the parent's NEXT request of the SAME turn; no second turn starts (count `turn_start`s).
  - T21 the same stack with `twoWay: false`: the child's request lists no `agent_notify`.
  - Non-vacuity: wire the runner's `notify` to a fresh `AgentJobs` instead of the session's (a
    mutation of `wiring.ts`) → T19 fails at the notice.

Gate before done: `bun run check` (typecheck, a clean lint baseline, the full test suite).

### Notes / debt

- An unflushed note is memory-only (quit, `serve` reload), like an unflushed shell exit (owner Q2).
- The guard can still let a spurious continuation through in one case: a note delivered mid-turn
  when a later user message never comes and the history does not end in a final answer (a
  tool-result end). That only happens after an error or cancel, where the TUI gate is already
  `lastEndBad`-style, or the daemon gate blocks. Accepted.
- The guard's early `turn_end` still produces `turn_start`/`turn_end` frames and log markers for a
  turn with no messages. That is cosmetic.
- The wake budget counts waking NOTIFIES, not wakes (3 notes coalesced into one wake use 3). This
  is conservative and simple.

## Owner questions

**Q1. Limits.**
- **(a) Recommended:** at most 3 waking notifies per session per user message (eval B3); at most
  8 notifies per child per user message, each at most 8 000 characters (task 8's 8 × 8 000).
  Over the wake budget the note is still delivered, without a wake. Over the per-child cap the
  child gets a tool error.
- (b) The eval's illustrative 10 per child.
- (c) Other numbers.

**Q2. An undelivered note at quit or at a `serve` reload.**
- **(a) Recommended:** lost with the child, exactly like an unflushed shell exit today. The child is
  lost too, and 6a's lost note names it. No new persisted state.
- (b) Persist pending notes in the `serve` sidecar (`<uid>.state.json`) and re-queue them at load.
  This means a sidecar field and reload logic, and it saves only the text of a child that is gone
  anyway.

**Q3. Which children get `agent_notify`.**
- **(a) Recommended:** only children launched in the background (`agent_task{background:true}`).
  A foreground child's parent is blocked on its report, which already is the reply. A child moved
  to the background later (6b) keeps the registry it was launched with, so it has no
  `agent_notify`.
- (b) Also movable foreground children. The tool is listed and returns "you are in the
  foreground: put it in your report" until the move. Small models waste steps calling it.

**Q4. A client armed by a note that was delivered mid-turn.**
- **(a) Recommended:** the narrow agent guard (Design 2). That continuation ends at once with no
  model request, and only after a mid-turn note, so with `twoWay` off nothing changes.
- (b) No guard: accept one extra model turn over an unchanged history in that case.
- (c) Arm the TUI and relay only when idle. A note that misses the late drain then gets no wake
  outside `serve` and waits for the next user turn.

### Answers (decided by the orchestrator overnight — to confirm by the owner)

Owner delegated the night of 2026-11-09→10 ("Decidi e fai merge"); each answer is the plan's recommendation:
- **Q1: (a)** 3 wakes per user message; 8 messages per child, 8 000 characters each.
- **Q2: (a)** an undelivered notification is lost with its child at quit / `serve` reload, like an undelivered shell exit today.
- **Q3: (a)** only children launched in background get `agent_notify`.
- **Q4: (a)** the narrow guard in the agent loop (a continuation armed for a message already delivered mid-turn ends at once, no model call).

*— orchestrator (claude-opus-5-5), 2026-11-10*

## Execution

*— deepseek (tentacle --profile deepseek), 2026-11-10*

### Repro, before any edit

On this branch (`aee5c6d`, plan only) the capability is absent:

```
$ grep -rn "agent_notify|twoWay|subagent_notify|subagentsTwoWay" packages apps/mobile/src
(nothing; exit 1)
```

### What was done, in the plan's file order

1. **Protocol** — `packages/protocol/src/updates.ts`: `SubagentNotifySchema`
   (`{type, agentId, text, wake}`), added to the union after `SubagentsUpdateSchema`, and
   `UPDATE_CLASS.subagent_notify = "display"`. `packages/protocol/src/session.ts`:
   `subagentsTwoWay: z.boolean().optional()` in `SessionSettingsSchema`.
   **No `PROTOCOL_VERSION` bump** (still 21, `version.ts:17`), as the plan says.
   `bun run schema:export` regenerated `packages/protocol/schema/protocol.json` (+29 lines:
   the new def with `"x-event-class": "display"`, the union member, the discriminator row, the
   settings field).
2. **`packages/core/src/model.ts`** — `NOTE_KIND.subagentMessage = "subagent_message"`.
3. **`packages/core/src/agent-jobs.ts`** — `AGENT_NOTIFY_PER_CHILD = 8`,
   `AGENT_NOTIFY_WAKES = 3`, `AgentNotify`, `AgentNotifyResult`; `notified` on the running
   entry (both creation sites: `start`, `adopt`); `notifyWakesLeft`; `notifyListeners`.
   `notify` (`:467`) checks in the plan's order (not running → killed → over
   `AGENT_MESSAGE_MAX_CHARS` → no listener → per-child cap) and only then `notified++`,
   decides `wakes`, and calls every listener synchronously in its own `try`. `onNotify`
   (`:520`). `userMessage` (`:530`) resets both budgets. `dispose` clears the listeners and
   the wake budget. No `changed()`.
4. **`packages/agent/src/agent.ts`** — `PendingExit` gained `PendingAgentMessage`
   (`{kind: "agent_message"} & AgentNotify`), told apart FIRST by `isAgentMessage`;
   the constructor subscribes `onNotify` into the same `pendingExits`; `retire`
   unsubscribes it; `pendingExitCount` counts a note only when `wakes`. Exported
   `agentMessageNote`. `flushBackgroundExits` handles a note BEFORE the `"agentId"` branch
   (order kept). `flushAgentMessages` (synchronous, rebuilds the array keeping the exits)
   is called at the iteration boundary after the steer loop and at the late drain; both set
   `notesFlushedMidTurn`. The budget reset rides both user-message sites. The narrow
   stale-wake guard sits right after the turn-start flush, gated on `notesFlushedMidTurn` &&
   not a user message && no resume && no skill && nothing flushed at this start &&
   `endsWithFinalAnswer(messages)`, and ends the turn with no model request.
5. **`packages/tools/src/background.ts`** — `AGENT_NOTIFY_TOOL_NAME`,
   `createAgentNotifyTool(agentId, notify)` (`permission: "none"`, `text: min(1)`), the
   three result texts of the plan; exported through the package index (`export *`).
6. **`packages/agent/src/subagent.ts`** — `SubagentDeps.notify`; registration after the
   filter loop, only with `deps.notify && controls?.agentId !== undefined`; the filter and
   `readOnlyType` both skip `AGENT_NOTIFY_TOOL_NAME`.
7. **Config** — `DEFAULT_SUBAGENTS_TWO_WAY = false` (`defaults.ts`), the schema key, the
   resolve `pick` + `ResolvedConfig`/`sources`, the load field, the `key-docs.ts` entry
   (`subagents.twoWay`, leaf/boolean/both/pinned, `TENTACLE_SUBAGENTS_TWO_WAY`, sample `on`).
8. **`packages/cli`** — the `CARRIED` P row `subagentsTwoWay`; `wiring.ts` passes
   `notify` to `createSubagentRunner` only when `config.subagentsTwoWay`.
9. **`packages/daemon/src/hosted-session.ts`** — `unsubscribeAgentNotify` beside the exit
   subscription: `emit({type: "subagent_notify", …})` with `wireLine` bounds, then
   `kickWake()` when `note.wakes`; unsubscribed in `close`.
10. **`packages/client`** — `subagents.ts`: `SubagentNotify`, `boundSubagentNotify`
    (id ≤ 64 via `progressText`, control characters except `\n` stripped, text ≤ 8 000);
    `remote-client.ts`: `SessionSubagentNotifyNotice`, `onSessionSubagentNotify`, the route
    (`subagentNotified`, bounded); `remote-session.ts`: `onSubagentNotify` plus the two
    "owned elsewhere" switch arms; `mapping.ts`: reverse `null`.
11. **`packages/cli/src/relay.ts`** — `offNotify`, released beside `offExit`.
    **DRIFT (see below):** the gate is a pure `notifyWakes(n, config)` in `relay-state.ts`.
    `main.ts` passes `subagentsTwoWay: config.subagentsTwoWay` at all three TUI sites.
12. **`packages/tui`** — new pure `src/subagent-notify.ts` (`subagentNotifyNotice`, first
    line, 200-char cut, control characters stripped); `App.tsx`: the exit handler's wake
    step extracted to `armWake` (used by both handlers), `onSubagentNotify` on the session
    interface, the subscription in `watchSession` (notice always, `armWake` only when
    `n.wake && subagentsTwoWay`), a `subagentsTwoWay` prop (default false); `run.tsx`
    pass-through; `local-runtime.ts` forwards `onSubagentNotify`.
13. Tests, `CHANGELOG.md` `[Unreleased]` entry, this section.

### Drift from the Implementation (and why)

1. **T16 is a pure test of the gate, not a `runRelay` test.** The Implementation says
   "`packages/cli/test/relay-state.test.ts` / `relay.test.ts` (extend) — T16: a waking notice
   with `autoWake` and `twoWay` on drives one continuation". Driving it end-to-end through
   `runRelay` needs a notify to originate in the pod daemon; the `resident` rig in
   `relay.test.ts` builds its `SessionHost` from a factory that the relay **also** uses for
   its context probe (`session-host.ts:316`), so the instance given to `agentJobs` is
   disposed by `newSessionContext` (`:332`) and the relay's own session then has no runtime.
   Two approaches on that rig stalled (`AgentJobs.start` refused "not available", then the
   relay's first turn failing `internal error`), so §0's two-strike rule was applied: the
   DECISION was moved into the pure `notifyWakes` in `relay-state.ts` (the plan's own §7
   preference — "logic in pure modules") and the relay calls it. The wake the relay starts
   after `emit({type:"job_exit"})` is the existing, already-tested path (`relayWakeDue` +
   `drive("")`, `relay-state.test.ts` "the wake on a job exit"). T16 pins all four
   combinations. **Not verified end-to-end:** a detached run actually waking on a note — see
   "Not done".
2. **T19/T20's `onSubagentNotify` is reached through `LocalRuntime`, not `RemoteSession`
   directly.** `createLocalRuntime`'s `PersistingController` needed the forwarding method
   (Design 7 did not name it); the e2e test drives the real runtime, so the forwarding is
   what T19 pins.
3. **`nextTui`/`main.ts`: three sites, not the two the plan implied.** `autoWakeOnJobExit`
   appears three times there (`:1043`, `:1836`, `:1887`); all three got `subagentsTwoWay`.
4. **`SubagentNotify` is mirrored in the TUI** as `SubagentNotifyView` (`subagent-notify.ts`),
   like `BackgroundAgentRow`: the TUI does not depend on `@tentacle/protocol`.
5. **Four pre-existing pinned tests were updated** for the new key/type (they are the repo's
   own completeness pins, not new behaviour): `carried-settings.test.ts` (23 CARRIED keys, P
   table, 21 keys carried by default), `key-docs-carried.test.ts` (23), `explain.test.ts`
   (`subagents` now 9 sub-keys), `daemon/test/mapping.test.ts` (a `subagent_notify` sample).
   `README.md`'s config table was regenerated with `bun run docs:config`.
6. **`agentMessageNote`'s answer hint** reads `agent_message({ agent_id: "sa-1", text })`
   (the plan wrote `text: ...`); `z.string()` args need no literal value, and the shorter
   form is what a model should copy.
7. **`session.test.ts`'s fake `agentJobs`** needed an `onNotify` stub (the Agent now
   subscribes in its constructor). One line; the fake was already `as never`.

### Tests: red before green

Every test below was run on the code **before** the step that makes it pass. Where a symbol
did not exist yet, the module was stubbed with the naive behaviour so the failure landed on
the ASSERTION (§9: a compile error is not a red); the mutations are listed with each group.

- **T2/T3/T4** (`core/test/agent-jobs.test.ts`) — stubbed `notify` to "always accept, always
  wake, notify synchronously". Red:
  ```
  (fail) AgentJobs.notify (T2) > an unknown id, a killed child and an over-length text …
  (fail) AgentJobs.notify (T2) > the 8-per-child cap: the 9th notify …
  (fail) AgentJobs.notify: the wake budget (T3) > 3 waking notifies …
  (fail) AgentJobs.notify: the listeners (T4) > unsubscribing stops the calls …
   22 pass / 6 fail
  ```
  then stubbed the delivery to `queueMicrotask` → T4 red alone
  (`Expected: 1 / Received: 0`). Green after the real implementation: `28 pass / 0 fail`.
- **T1/T5/T5b/T7/T7b/T8/T8b/T8c/T9** (`agent/test/agent.test.ts`) — red with the Agent
  changed only to accept `notify` (no subscription):
  ```
  (fail) T1: a notify counts at once …  expected {ok:true,wakes:true}, got {ok:false, reason:"no parent agent is listening…"}
  (fail) T7: a non-waking note is not counted … / T7: queue order / T5 / T9
   0 pass / 5 fail
  ```
  Green after the Agent work: `30 pass / 0 fail` for the file.
- **T6** (`agent/test/replace-agent.test.ts`) — green with the implementation, then the
  mutation `retire` drops the notify unsubscribe:
  ```
  Expected: 0 / Received: 1
  (fail) Agent.retire / adoptExits > T6: a pending child's note survives retire/adopt exactly once
  ```
- **T10** (`agent/test/subagent.test.ts`) — red before registration:
  ```
  (fail) T10b > a background child (with an agentId) is offered it; a foreground child is not
  (fail) T10b > a read-only (explore) child gets it too
  (fail) T10b > a parent registry holding one never leaks it
   1 pass / 3 fail
  ```
  Mutation after green (register for every child): the first fails, the other three pass.
- **T11** (`tools/test/agent-notify.test.ts`, new) — green with the tool, then mutated
  (`isError: false` on refusal; both texts `"delivered"`): all 5 fail.
- **T12** (`config/test/subagent-keys.test.ts`) — red before `key-docs.ts`:
  `Expected "subagents.twoWay", Received undefined`; plus the registry-completeness tests
  (`key-docs.test.ts` T1/T2/T3) red until the entry existed.
- **T13** (`cli/test/carried-settings.test.ts`) — mutation `class: "W"`: 3 tests fail
  (`9 P + 14 W`, `beats a pod's file`, `beats a pod's env`).
- **T14** (`daemon/test/serve-autowake.test.ts`, N-1…N-4) — green with the daemon listener,
  then mutated (listener removed):
  ```
  Expected: 2 / Received: 1
  (fail) N-1 a WAKING notify … starts ONE wake turn whose request has the note
  (fail) N-4 an attached client gets the notice …
  ```
- **T15** (`client/test/subagents.test.ts`) — mutation (route the raw frame, no
  `boundSubagentNotify`):
  ```
  -   "text": "line one line two [31m red",
  +   "text": "line one\nline two\u001b[31m red",
  (fail) T15 > a notify frame reaches onSubagentNotify, bounded
  ```
  Note: the daemon's `wireLine` already flattens the newline, so the client bound is pinned
  by `boundSubagentNotify`'s own unit test (8 000 cut) plus this route.
- **T16** (`cli/test/relay-state.test.ts`) — mutation `return notify.wake;`:
  ```
  (fail) T16 > `subagents.twoWay` off: a note still arrives, and arms nothing
  (fail) T16 > `autoWake` off: the same, the laptop's other gate
  ```
- **T17** (TUI, `tui/test/auto-wake.test.tsx`) — green with the App change; `twoWay` off
  and non-waking cases red under a mutation that arms on any notice.
- **T18** (`tui/test/subagent-notify.test.ts`, new) — red before the module's line logic
  (`Received "sa-2 → agent: first line second third"`), then green.
- **T19/T20/T21** (`cli/test/agent-message-two-way.e2e.test.ts`, new) — T19 red on its own
  assertion with the plan's named mutation (the runner's `notify` wired to a fresh
  `AgentJobs`):
  ```
  Expected: true / Received: false
  (fail) T19: a child's notify reaches the parent over RPC; a reply completes the round trip
  ```
  T21 red under a mutation that always passes `notify`:
  ```
  Expected to not contain: "agent_notify"
  Received: [ "fs_read", "fs_write", "fs_edit", …, "skill", … ]
  ```
  T20 was green from the start (the mid-turn flush already carries it) — it is the
  regression pin for the turn count, and it fails under the M1 mutation below.

### Mutations on the load-bearing parts (§9 non-vacuity)

| # | Mutation | Result |
|---|---|---|
| M1 | drop the mid-turn `flushAgentMessages` at the iteration boundary | T5, T8, T8c fail (6 pass / 3 fail) |
| M2 | drop `notesFlushedMidTurn` from the guard's condition | T8b fails (the guard stops being narrow: a plain continuation is cut short) |
| M3 | `pendingExitCount` counts every note (drop the `wakes` filter) | T7 fails (a non-waking note asks for a wake) |
| M4 | drop `agentJobs.userMessage()` at the user-message site | T9 fails |
| M5 | **the plan's "`twoWay` off" check**: no `onNotify` subscription at all (= what a parent with no child runtime looks like) | T1, T5, T5b, T7×2, T8 fail; `notify` itself answers `ok:false "no parent agent is listening"` — with `twoWay` off, `wiring.ts` passes no `notify`, so a child never reaches this |
| M6 | register `agent_notify` on every child (drop the `agentId` guard) | T10b's foreground case fails |
| M7 | remove the daemon's notify listener | N-1 and N-4 fail |
| M8 | route the raw frame (no client bound) | T15 fails |
| M9 | `notifyWakes` ignores the config | T16's two gated cases fail |
| M10 | runner's `notify` → a fresh `AgentJobs` (the plan's own T19 mutation) | T19 fails at the notice |

M5 and M10 are the two that pin the LBA directly: the note enters through the ONE
`AgentJobs` the parent subscribed to, and with no subscription nothing enters at all.

### Gate

```
$ bun run check
$ tsc --noEmit && tsc -p apps/mobile --noEmit
$ biome check .
Checked 821 files in 263ms. No fixes applied.
$ bun test
 6343 pass
 3 skip
 0 fail
Ran 6346 tests across 445 files. [243.59s]
```

The 3 skips are the documented opt-in ones (live-k8s, live-docker, real-socket keepalive).
Lint is clean (0 errors, 0 warnings), so `bun run check` is green as a whole. `ran in the
worktree at .tentacle/worktrees/agent-message-two-way`, branch `feat/agent-message-two-way`.

### Not done / unverified

- **A detached run waking on a note, end to end.** The gate is pure-tested (T16) and the
  wake it triggers is the existing job-exit path, but no test drives `runRelay` with a real
  pod-originated notify (drift 1). To verify: give `relay.test.ts`'s `resident` rig a
  per-session `AgentJobs` (the probe's `newSessionContext` must not hand back the same
  instance), then fire a notify and assert one extra `session/prompt`.
- **The TUI's `armWake` sharing** is pinned behaviourally (T17a–T17c) but the exit path's own
  tests (`T-TUI-1`, `T-TUI-3`) also pass, which is the regression evidence; no test asserts
  the two handlers call the same function.
- **Owner Q2 (a)** is implemented as decided (an unflushed note is memory-only). Nothing
  new is persisted; the parent's note, once flushed, is an ordinary `message` entry.
- **Task 7 compatibility** (`docs/feat/subagent-panel`, unmerged) is by naming only, as the
  plan says: `subagent_notify` / `kind: "agent_message"` / `NOTE_KIND.subagentMessage` versus
  task 7's `subagent_message` / `"user_note"` / `userToSubagent`. Whichever lands second
  rebases onto the other's `PendingExit` union, `pendingExitCount` filter and `NOTE_KIND`.

## Review

*— claude-opus-5-5, 2026-11-10* (fresh context; same model family as the plan's author, a different one from the executor's (DeepSeek). Per the owner's token rule, only HIGH/MEDIUM findings are listed, in one round.)

**Verdict: REQUEST-CHANGES**: two MEDIUM findings, no HIGH.

**Gate (re-run):** `bun run check`: typecheck clean, `biome check .` clean (821 files), `bun test` **6343 pass / 3 skip (the opt-in ones) / 0 fail**, 6346 tests across 445 files.

**What holds (verified against the diff):**
- `twoWay` off: `wiring.ts` passes no `notify`, so no child gets `agent_notify`. `notesFlushedMidTurn` is never set and `pendingExitCount` is unchanged. No `subagent_notify` is emitted, because `AgentJobs.notify` is never called. `userMessage()` is still called, but it is a no-op reset.
- `connect` passes no `subagentsTwoWay` (`connect.ts:211`), so the TUI never arms on a notice there. The daemon is the only waker, and `kickWake` is a no-op without `wake`, which is the case on a pod daemon and the in-process worker. There is no double wake.
- Relay wiring (drift 1): `runtime.createSession()` returns a `PersistingController`, which forwards `onSubagentNotify` (`local-runtime.ts`). The `?.` at `relay.ts:439` is not a silent no-op, and `emit({type:"job_exit"})` goes into the existing `wakeStep`/`relayWakeDue` path. I found no concrete failure scenario beyond M1, which the relay shares.
- `subagent_notify` is `display` in `UPDATE_CLASS`, the reverse mapping is `null`, and both `RemoteSession` arms skip it. No `PROTOCOL_VERSION` bump is needed.
- Nothing can throw out of a void path: `notify` is synchronous and wraps each listener in `try`. No await or lock was added to the peer.
- Ordering: a child's note precedes its own exit in the one queue. The mid-turn flush removes only notes, so the exit still flushes at the next start, and the order is kept.
- Q3: only `controls.agentId` children get the tool. A child moved with `adopt` keeps its launch registry, so it never gets it. A finished or killed child gets the "not running" or "being stopped" error. A note already queued is still delivered.
- Budgets: the 9th notify per child is refused with an error. The 4th notify is accepted with `wakes:false` and is not counted by `pendingExitCount`, so neither the daemon nor a client arms for it. Both budgets reset only on `userMessage === true` or a drained steer.

### Findings

**M1: The Q4 guard misses the start-flush race. Two notices back to back give a second, spurious model turn on the TUI and relay drivers.** `packages/agent/src/agent.ts:1012` and `:1150` set the flag only on a mid-turn flush. The guard (`:939-958`) reads it at the turn start and then clears it unconditionally.
- *Scenario:* a child sends two `agent_notify` calls in one round (parallel tool calls), or two children notify close together. Both are `wake:true`, and the daemon emits notices A and B in the same stretch. The TUI handles A while idle and starts a continuation, setting `running`. It then handles B while running, so `wakeStep(exit)` sets `pending` again (`core/src/auto-wake.ts:24`). On the daemon, the prompt arrives after both notifies, so the turn START flushes A and B, which is not a mid-turn flush. When that turn ends, `wakeIfPending` sends `send("")`. `notesFlushedMidTurn` is false, so the guard does not fire, and the model runs a full turn over an unchanged history. The relay behaves the same way.
- This contradicts both the failure-mode row "Many children notify at once → ONE wake" and the Q4 (a) decision.
- *Repro* (`.tentacle/tmp/agent-message-two-way/race.test.ts`, real `Agent`/`Session`/`AgentJobs`): `send("hi")`, then `notify(A)`, `notify(B)`, then `send("")` (2 requests), then `send("")` again. Output: `model requests after the 2nd armed wake: 3`. It should be 2.
- *Fix:* also set the flag when the turn-start flush delivered a note. Right after the unconditional `this.notesFlushedMidTurn = false;` (`agent.ts:958`), add `if (<flushedAtStart delivered a subagent_message note>) this.notesFlushedMidTurn = true;`. To tell, have `flushBackgroundExits` report whether it hit the `isAgentMessage` branch, instead of re-reading the event texts. Rename the flag to `notesConsumed` if you like.
- This is still narrow. The guard keeps requiring `flushedAtStart.length === 0` and a history ending in a final answer, so it can never skip a wake with unread notes.
- Add the repro as a regression test, red before the fix.

**M2: The late-drain flush is untested. T5b is vacuous.** In `packages/agent/test/agent.test.ts:840-866`, T5b calls the notify tool in round 1, so its note is flushed at round 2's iteration boundary, exactly like T5. It never reaches the late drain.
- *Mutation run:* in `agent.ts:1143` I replaced `const lateNotes = this.flushAgentMessages(messages);` with `const lateNotes: AgentEvent[] = [];`. Result: `agent.test.ts` and `agent-message-two-way.e2e.test.ts` give **33 pass / 0 fail**. Reverted; `git status` is clean.
- That code sits inside the synchronous late-drain invariant window and has no pin. The plan's T5 asked for "a notify AFTER the last round (pushed from the gate release of the final round) → `continue`, one more round".
- *Fix:* add a test whose provider calls `jobs.notify(...)` inside the FINAL round's `stream()` (a text-only round, before `done`). Assert three things: three requests in ONE turn (`turn_end` ×1), the third request contains `[sub-agent sa-1 → you]`, and `pendingExitCount === 0` at the end. Show it red under the mutation above.

**Not findings (noted):**
- The wake budget also counts notes that were delivered mid-turn (3 progress notes during a user turn leave no wake for a later one). This is the plan's accepted debt.
- The end-to-end relay wake (drift 1) is still not driven. The wiring reads as correct.

## Execution — fix round 1

*— deepseek (tentacle --profile deepseek), 2026-11-10*

Exactly the Review's two MEDIUM findings; nothing else. No commit, no `TODO.md` edit.

### M1 — the Q4 guard missed the start-flush race → **FIXED**

**What changed.** `packages/agent/src/agent.ts`:
- `flushBackgroundExits` (`:2039-2097`) now returns `{ events, deliveredNote }` instead of a bare
  event list; `deliveredNote` is set in the `isAgentMessage` branch (`:2054`), i.e. it reports
  whether an `agent_notify` note was delivered — no re-reading of event texts.
- The call site (`:927-929`) reads `.events`, and the guard's condition (`:944`) keeps
  `flushedAtStart.events.length === 0`.
- Right after the flag reset (`:958`) and its comment, `:964-966` sets the flag again when
  `flushedAtStart.deliveredNote` — so the deferred continuation is recognised as stale.
- The guard's other conditions (`userMessage !== true`, no `resumeFrom`, no `skill`, nothing new
  at the start, `endsWithFinalAnswer`) are untouched, so a wake with unread notes is never
  skipped. No rename of the flag (the review offered it as optional; renaming would have widened
  the diff).

**Regression test.** `packages/agent/test/agent.test.ts` **T8d** (`:999`), real
`Agent`/`Session`/`AgentJobs` with the existing `notifyRig`/`startedChild` fakes: `send("hi")`,
two `jobs.notify` (both `wakes: true`), `send("")` (2 requests, both notes in request 2), then the
deferred `send("")` → must stay at 2 requests and emit one `turn_end end_turn`. It is the
reviewer's `.tentacle/tmp` repro, narrowed to the assertion.

**Red (before the fix, current code):**
```
(fail) … > T8d: two waking notes, both flushed at ONE turn start, arm no second continuation (M1)
error: expect(received).toHaveLength(expected)
Expected length: 2
Received length: 3
 at packages/agent/test/agent.test.ts:977:28
 0 pass / 30 filtered out / 1 fail
```
**Green (after):** `bun test packages/agent/test/agent.test.ts` → `32 pass / 0 fail`.

**Mutation (§9 non-vacuity)** — removed the `if (flushedAtStart.deliveredNote) …` block:
```
(fail) … > T8d: two waking notes, both flushed at ONE turn start, arm no second continuation (M1)
Expected length: 2
Received length: 3
 0 pass / 30 filtered out / 1 fail
```
Restored from a saved copy; `bun test packages/agent/test/agent.test.ts` → `32 pass / 0 fail`.
The reviewer's own repro, run unchanged against the fix, now prints
`model requests after the 2nd armed wake: 2` (it printed 3 before).

### M2 — T5b was vacuous (the late drain unpinned) → **FIXED**

**What changed.** Only the test: `packages/agent/test/agent.test.ts` gains
`NotifyOnFinalRoundProvider` (`:952`) and **T5c** (`:980`). No production change was needed — the
end-of-turn delivery at `agent.ts:1143` already exists; the finding is that nothing pinned it.

The provider calls `jobs.notify(...)` inside round 2's `stream()` — the FINAL, text-only round,
after the iteration boundary and before `done` — which is the window only the end-of-turn drain
covers (mid-round, so not the round-boundary flush; and it arrives too late for round 2's
request). T5c asserts: `model.requests` length 3 (round 1 = tool call, round 2 = the round the
note landed in, round 3 = the extra round the late drain asked for), request 3 contains
`[sub-agent sa-1 → you] late`, exactly one `turn_end` (ONE turn), and
`agent.pendingExitCount === 0` at the end. The existing T5b is left as is (it still pins the
round-boundary delivery; it was never wrong, just not the late drain).

**Red (with the end-of-turn delivery disabled at `agent.ts:1143`, as the review's mutation):**
```
const lateNotes: AgentEvent[] = []; // MUTATION: the end-of-turn delivery disabled
(fail) … > T5c: a notify during the FINAL text-only round is delivered by the late drain, in the same turn (M2)
error: expect(received).toHaveLength(expected)
Expected length: 3
Received length: 2
 at packages/agent/test/agent.test.ts:988:28
 0 pass / 31 filtered out / 1 fail
```
**Green:** restored `const lateNotes = this.flushAgentMessages(messages);` →
`32 pass / 0 fail` for the file.

### Gate

```
$ bun run check      # typecheck → lint → test, in the worktree, branch feat/agent-message-two-way
$ tsc --noEmit && tsc -p apps/mobile --noEmit
$ biome check .
Checked 821 files in 259ms. No fixes applied.
$ bun test
 6345 pass
 3 skip
 0 fail
Ran 6348 tests across 445 files. [245.31s]
```
6345 = the previous 6343 + the two new tests. The 3 skips are the documented opt-in ones
(live-k8s, live-docker, real-socket keepalive). Lint clean, 0 errors / 0 warnings — matches the
baseline.

`git diff --stat` (only intended files; no stray file, no `TODO.md`):
```
 packages/agent/src/agent.ts       | 28 +++++++++++---
 packages/agent/test/agent.test.ts | 81 +++++++++++++++++++++++++++++++++++++++
 2 files changed, 103 insertions(+), 6 deletions(-)
```

### Drift

- None from the Review's fixes. Two cosmetic notes: (1) the fix keeps the flag name
  `notesFlushedMidTurn` (the review's rename was optional and would have widened the diff) —
  its semantics are now "a note has been consumed in this turn / at its start"; (2) the new test
  IDs are **T8d** (M1) and **T5c** (M2) rather than reusing T5b/T8, so the pre-existing pins keep
  their names and the plan's Tests list stays traceable.
- Unverified: nothing from the two findings. The Review's "not findings" (the wake budget's
  mid-turn consumption; the relay's end-to-end wake) are untouched and stay as stated there.
