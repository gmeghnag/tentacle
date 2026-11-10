# feat/agent-message — the agent writes to a running background sub-agent (one-way)

> **Status:** implementation
> **Branch:** `feat/agent-message`
> **Type:** feat · **Size:** M · **Blast:** load-bearing · **Suited:** DeepSeek exec, one Opus review (fresh context, red-team the inbox close)

## Context

*— claude-opus-5-5, 2026-11-10*

Task 8 of the sub-agent live feature (`docs/eval/subagent-live.md`, feature B, section B1;
split table row 8). The owner decided (2026-11-07, eval "B."): the agent gets a tool
`agent_message(id, text)` that writes into a RUNNING sub-agent's context, delivered at the
child's next boundary like the steering queue. One-way here; two-way (sub-agent → agent, with a
wake) is task 9, behind `subagents.twoWay` (owner Q3 a). The user writing to a sub-agent from the
panel (owner Q1 b: the text goes to the child "as with `agent_message`", and the parent is told
`[user → sa-1] …` at its next turn) is task 7, and must reuse this task's channel.

What 6a/6b give us (merged on main b6b8ffc): background children `sa-N` held by `AgentJobs`
(`packages/core/src/agent-jobs.ts:138`), `agent_kill` (`packages/tools/src/background.ts:88`),
the `subagents` display update, and 6b's move of a foreground child to the background when the
user writes (`packages/tools/src/task.ts:167-257`).

What is missing: a child has NO steering drain. `subagent.ts:372` runs it with `child.run(…)`,
and `Agent.run` passes `undefined` as the drain (`agent.ts:757`). No `agent_message` tool exists.

Decided by the eval, not re-asked here: the tool is parent-only; v1 accepts background ids only
(a foreground child has no id, and the agent's turn is blocked on it — the only way to call the
tool beside it is a parallel round, B1); the child sees `[message from the parent agent] <text>`
as a user-role message (B1); the call and its result are ordinary parent `message` entries, the
text inside the child is not persisted (eval Finding 1, table row "`agent_message` call +
result … no new type", lines 187, 193-195); `agent_message` never wakes anything (B3).

**Repro** (2026-11-10, worktree at b6b8ffc) — the capability is missing:

```
$ rg -n "agent_message" packages/*/src
packages/protocol/src/updates.ts:32:  type: z.literal("agent_message_chunk"),
packages/protocol/src/updates.ts:315:  agent_message_chunk: "display",
packages/daemon/src/mapping.ts:212:      return { type: "agent_message_chunk", content: text(event.delta) };
packages/client/src/mapping.ts:213:    case "agent_message_chunk":
$ rg -n "runMessages\(messages, sessionId, signal, undefined" packages/agent/src/agent.ts
757:    yield* this.runMessages(messages, sessionId, signal, undefined, {
```

(only the unrelated ACP update `agent_message_chunk`; the child's run has no drain.)

## Implementation

*— claude-opus-5-5, 2026-11-10*

### Load-bearing assumption

**A message `AgentJobs` accepts is either drained into the child's history or reported back —
never accepted and then silently lost — provided the "is the child still reading?" decision and
the push are both synchronous, and the child closes its inbox synchronously right after its run's
last drain.**

Why it needs proving: the obvious design ("the running entry exists ⇒ queue the text") is wrong.
The child's last drain is the late drain (`agent.ts:1040`); from there to `turn_end` there is no
`await` (`agent.ts:1026-1039`, the invariant comment), but after `turn_end` the child's generator
returns through the runner's `for await` (`subagent.ts:372-391`), the runner's `return`, and
`drive`'s `await run(…)` (`agent-jobs.ts:408`); for a background child the closure in between also
awaits `shape` (`task.ts:394` → `ctx.shapeResult`, the spill transform: real I/O). Only then is the
entry deleted (`agent-jobs.ts:417`). During those awaits the parent's own loop (its tool call
`agent_message` is a promise chain in the same process) and RPC macrotasks can run. An entry that
is still in `running` therefore does NOT mean the child will drain again.

Proof the design closes it (all cited code is synchronous):
1. The drain is polled at the top of every iteration, before the request is built
   (`agent.ts:910-914`), and at the late drain (`agent.ts:1040-1047`); `drainSteering` is a plain
   synchronous function (`agent.ts:778`, `800-806`). So whatever is in the inbox at a boundary is
   injected.
2. After the run's generator ends, the runner calls `inbox.closeIfEmpty()` (new, synchronous): it
   returns any text that slipped in after the last drain (the inbox stays open → the runner
   continues the child, step 4) or, when empty, marks the inbox closed in the same stretch.
3. `AgentJobs.message` (new) is synchronous: it reads `inbox.closed` and pushes in one stretch.
   After the close it refuses with a tool error. No interleaving point exists between "child
   decided it is done reading" and "push refused".
4. A text found by `closeIfEmpty` is delivered by running the child again over its same history
   with a drain that yields that text first — it lands at the next iteration's drain
   (`agent.ts:911`) exactly like a steer.
5. A child that stops for any other reason (cancelled / killed / error / `max_iterations`) calls
   `inbox.close()`, which returns leftovers; the runner appends one line naming how many were
   unread to the report (step 4 of Design), which the parent reads in the `[background]` note.

The executor's FIRST test (T1 below) is the red that shows the naive design loses a message
(push accepted after the child's last drain, never delivered), then green with the close.

### Preconditions

- Background children: `AgentJobs.start` (`agent-jobs.ts:268-299`) and `adopt` (`:327-346`) are
  the only ways into `running`; `drive` deletes the entry after the run settles (`:416-418`);
  `dispose` aborts and clears everything (`:351-361`), called on session close
  (`hosted-session.ts:2613`). 
- `kill` marks `killed` and aborts the child's own controller (`agent-jobs.ts:253-262`).
- The child is an `Agent` built per run (`subagent.ts:322-366`); `startConversation()` is public
  and pure (`agent.ts:672-674`); `runMessages(messages, sid, signal, drain, opts)` is public
  (`agent.ts:774-780`).
- The runner ignores child events other than `text` / `tool_start` / `usage` / `turn_end`
  (`subagent.ts:377-390`): a child `steer` event reaches no client. Nothing renders the delivered
  text in v1 (task 7's panel adds that).
- Children never get parent-only tools: the filter at `subagent.ts:301-307` and `readOnlyType` at
  `:416-421` (the `agent_kill` precedent).
- `agent_kill` is registered only where the background runtime is (`cli/src/wiring.ts:573-576`),
  `permission: "none"` (`background.ts:94`).
- Children outlive `/clear`, a compaction and a context reset (`hosted-session.ts:2508-2510`,
  docs/feat/clear-keeps-jobs.md): nothing in this task must react to them.
- §7 pod rule: the tool runs daemon-side (in the pod for `run`/`attach`) and only touches children
  of that daemon; it has no laptop effect, so no laptop gate is involved.
- §7 protocol: tools are not protocol; the call and result travel as ordinary `tool_call` /
  `tool_result` updates.

### Design

**1. The inbox — `AgentInbox` (new, `packages/core/src/agent-inbox.ts`, pure).** One per child,
the shared delivery channel for every sender:

```ts
export type AgentMessageSender = "agent" | "user";
export const AGENT_INBOX_MAX = 8;              // unread texts per child (Owner Q2)
export const AGENT_MESSAGE_MAX_CHARS = 8_000;  // per text (Owner Q2)
export function inboxText(from: AgentMessageSender, text: string): string
  // "agent" → `[message from the parent agent] ${text}`
  // "user"  → `[message from the user] ${text}`        (used by task 7)
export type InboxPush = { ok: true } | { ok: false; reason: "closed" | "full" };
export class AgentInbox {
  get closed(): boolean;
  push(text: string): InboxPush;        // synchronous; refuses when closed or full
  drain(): string[];                    // splice(0); [] once closed
  closeIfEmpty(): string[];             // non-empty → returns them (stays OPEN); empty → closes, []
  close(): string[];                    // closes, returns leftovers (unread)
}
```

`push` stores the already-formatted text (`inboxText` is applied by `AgentJobs.message`), so the
child's drain returns ready user-message contents.

**2. `AgentJobs` owns the inboxes (`agent-jobs.ts`).**
- The `running` entry gains `readonly inbox: AgentInbox`.
- `start`: creates the inbox, stores it, passes it in `AgentJobControls` (new field
  `readonly inbox: AgentInbox`).
- `acquire`: creates an inbox for the foreground slot and exposes it as `slot.inbox` (new field
  on the `ok: true` variant). `adopt` moves THAT inbox into the running entry, and returns
  `undefined` (nothing moved) when `inbox.closed` — a child that has already stopped reading is
  not worth moving (and moving it would create an entry that accepts texts nobody reads).
- New method, THE seam for every sender:
  ```ts
  message(agentId: string, text: string, from: AgentMessageSender): AgentMessageResult
  // { ok: true } | { ok: false; reason: string }   — synchronous, never throws
  ```
  Order: not in `running` → `${id} is not a running background sub-agent (it finished, was
  stopped, or never existed): nothing was sent.`; `killed` → `${id} is being stopped: nothing was
  sent.`; text over `AGENT_MESSAGE_MAX_CHARS` → refused with the limit; `push` `closed` →
  `${id} is finishing and can no longer read messages: nothing was sent. Its report arrives as a
  [background] note.`; `full` → `${id} already has ${AGENT_INBOX_MAX} unread messages: nothing was
  sent. Wait for it to read them or for its report.` No `changed()` call (no row changes).
- `drive` is unchanged (the inbox dies with the entry).

**3. The tool — `createAgentMessageTool(jobs)` (`packages/tools/src/background.ts`, beside
`createAgentKillTool`).** `AGENT_MESSAGE_TOOL_NAME = "agent_message"`, `permission: "none"`,
input `{ agent_id: string.min(1), text: string.min(1) }` (descriptions say: the `sa-N` id
`agent_task` returned or moved to; one-way, no reply comes back; delivered before the child's next
model step; it does not wake you). `execute` calls `jobs.message(agent_id, text, "agent")`:
- ok → `{ content: "queued for sa-1: it reads it before its next model step. No reply comes back;
  its report still arrives as a [background] note." }` (not "delivered": honest — a child waiting
  on a long shell call or a permission ask reads it after that call).
- refused → `{ content: reason, isError: true }`.

**4. The child's drain and close (`packages/agent/src/subagent.ts`).** `SubagentRunControls` gains
`readonly inbox?: AgentInbox`. Replace `child.run(…)` (`:372-376`) with:

```ts
const messages = child.startConversation();
const newFrom = messages.length;
messages.push({ role: "user", content: opts.prompt });
const inbox = controls?.inbox;
let carry: string[] = [];
const drain = inbox
  ? () => (carry.length > 0 ? [...carry.splice(0), ...inbox.drain()] : inbox.drain())
  : undefined;
let first = true;
for (;;) {
  for await (const event of child.runMessages(messages, sid, controls?.signal, drain,
      first ? { newFrom, userMessage: true } : { userMessage: true })) { /* same switch as today */ }
  first = false;
  if (!inbox || stopReason !== "end_turn" || controls?.signal?.aborted) break;
  const more = inbox.closeIfEmpty();   // SYNCHRONOUS, right after the generator ended
  if (more.length === 0) break;        // closed
  carry = more;                        // run once more: delivered at the next iteration's drain
}
const unread = inbox?.close() ?? [];   // idempotent when already closed (returns [])
```

`sid` is the same `crypto.randomUUID()` for every pass (hoist it). `report` keeps accumulating
across passes (as it already does across rounds). When `unread.length > 0`, append to the final
report: `\n\n(${n} message(s) sent to this sub-agent arrived after it stopped and were not read.)`
— also on the error path (`catch` → close, then rethrow unchanged: the caller's error report
cannot carry it; acceptable, documented in Notes). The `onEvent subagent_end` calls stay where they
are. Also exclude `AGENT_MESSAGE_TOOL_NAME` in the child filter (`:301-307`) and in
`readOnlyType` (`:416-421`).

Why `runMessages` and not a new `Agent.run` parameter: the continuation needs the child's
history array; `run` hides it (`agent.ts:754`).

**5. Pass the inbox through `agent_task` (`packages/tools/src/task.ts`).** `TaskRunControls`
gains `readonly inbox?: AgentInbox` (type from `@tentacle/core`). Background path (`:378-386`):
add `inbox` from the `start` controls (`({ signal, agentId, inbox })`). Movable path
(`runMovable`, `:193-202`): pass `inbox: slot.inbox`. The non-movable foreground path (`:416`)
passes none — no id, no sender, unchanged. The `move` guard (`:221`) needs no change: `adopt`
already refuses a closed inbox (Design 2).

**6. Register the tool (`packages/cli/src/wiring.ts:576`).** `tools.register(
createAgentMessageTool(agentJobs))` right after `createAgentKillTool`, inside the same branch
(only where `background` is offered).

**What the agent sees:** its own tool call + the result above (both persisted as ordinary
`message` entries, so `--resume` and the log show the agent messaged `sa-1`). **What the child
sees:** a user-role `[message from the parent agent] <text>` at its next boundary.

**Seams the next tasks call (no rework):**
- **Task 7** (user → sub-agent): a new RPC method (e.g. `session/subagent_message{agentId, text}`,
  free under v10 forward-compat, no bump) → `HostedSession` → `this.agentRuntime.message(id, text,
  "user")`, and on `ok` the parent's `[user → sa-N]` pending note (eval M2: not counted in
  `pendingExitCount`, `agent.ts:598`). The inbox, its limits, its close and the child's
  `[message from the user]` formatting are already built and unit-tested here.
- **Task 9** (sub-agent → agent): the opposite direction — a child tool `agent_notify` feeding
  the parent's exits/steering (B2). It does not touch the inbox; the parent answers a notify with
  this task's `agent_message`. The sender type `AgentMessageSender` is where a third origin would
  go if ever needed.

### Files

Dependency order (no protocol, no daemon, no client, no TUI change):

1. `packages/core/src/agent-inbox.ts` (new) + export from `packages/core/src/index.ts`.
2. `packages/core/src/agent-jobs.ts` — `inbox` on the running entry, `AgentJobControls.inbox`,
   `slot.inbox`, `adopt` refuses a closed inbox, `message(…)`.
3. `packages/agent/src/subagent.ts` — `SubagentRunControls.inbox`, the drain/close loop, unread
   line, tool exclusion ×2.
4. `packages/tools/src/task.ts` — `TaskRunControls.inbox`, pass it on the background and movable
   paths.
5. `packages/tools/src/background.ts` — `AGENT_MESSAGE_TOOL_NAME`, `createAgentMessageTool`
   (exported through the package index like `createAgentKillTool`).
6. `packages/cli/src/wiring.ts` — register the tool.
7. Tests (below); this doc's Execution.

**Protocol: no change, no `PROTOCOL_VERSION` bump.** No new log entry type (critical or not).

### Failure modes

| Case | What happens | Converges because |
|---|---|---|
| Unknown id / foreground child (no id) / id from before a reload | tool error "not a running background sub-agent … nothing was sent" | synchronous lookup in `running`; nothing queued |
| Child already finished | same error (its entry is gone, `agent-jobs.ts:417`) | — |
| Child killed, run not settled yet | "is being stopped" error | `killed` flag (`agent-jobs.ts:256`) |
| Message lands after the child's late drain, before its runner closes | `closeIfEmpty` returns it → the child runs one more pass and reads it | the close is synchronous with the check (LBA) |
| Message after the inbox closed (child shaping its report / spilling) | "is finishing" error | `push` refuses when `closed` |
| Child stops cancelled / error / `max_iterations` with texts queued | report gains "N message(s) … were not read" | `close()` returns leftovers; the report is the durable `subagent_end{report}` + the `[background]` note |
| Many messages queued | each is a separate user message, all injected at the next boundary (`agent.ts:911-914`), in order; the 9th unread is refused | `AGENT_INBOX_MAX` |
| Very long text | refused with the limit | `AGENT_MESSAGE_MAX_CHARS` |
| Child waiting on a permission ask (or a long tool call) | text waits in the inbox; read after that tool round | boundary semantics; the tool result says "before its next model step", not "now" |
| Foreground child moved by 6b, then messaged | accepted: its inbox came over with `adopt`, its runner drains it | the runner got `slot.inbox` at launch |
| Child closed its inbox, then a person writes (6b move) | not moved; finishes foreground as today | `adopt` returns `undefined` on a closed inbox |
| Parallel round: `agent_task{background}` + `agent_message` to the new id in the same round | the id does not exist yet when the model wrote the call — it cannot know `sa-N`; any guess gets the normal error or reaches a real running child (the agent named it) | ids come from tool results |
| `/clear`, compaction, context reset | nothing changes: children and inboxes survive (`hosted-session.ts:2508`) | — |
| Quit / session close | `dispose` aborts children; queued texts die with them; the parent log keeps "queued for sa-1" and the next open shows 6a's lost note | no promise left to the agent beyond "queued" |
| `serve` reload | as quit: in-memory inbox gone, children lost (6a), lost note at load | eval: a background child cannot survive a restart |
| Cap (`maxParallel`) | messages take no slot; unaffected | — |
| Pod run | tool runs in the pod daemon, children there; no laptop effect, no laptop gate needed (§7) | — |
| Version skew (old client) | none: no wire change; the call renders as a generic tool row | — |

### Tests

Red-before-green: each new test is shown failing first (missing API → type/compile error is NOT a
red; write the test against the final API, stub the new method to the naive behaviour, see the
assertion fail, then implement). Fakes: the scripted `ModelProvider` and gated model patterns of
`packages/agent/test/subagent.test.ts` and `packages/cli/test/parallel-agents.test.ts`; no real I/O.

- `packages/core/test/agent-inbox.test.ts` (new)
  - T1 **LBA red**: push after `closeIfEmpty()` closed → `{ok:false, reason:"closed"}` and
    `drain()` stays `[]`; with the naive stub (`closeIfEmpty` that never closes) the assertion
    fails. `closeIfEmpty` with items returns them and leaves the inbox open.
  - T2 `close()` returns leftovers then `[]`; `full` at `AGENT_INBOX_MAX`; order kept.
  - T3 `inboxText("agent"|"user", …)` prefixes.
- `packages/core/test/agent-jobs.test.ts` (extend)
  - T4 `message` to an unknown id, a killed id, an ended id → `ok:false` with the reasons; to a
    running id → `ok:true` and the text appears in the `inbox` the run received, formatted.
  - T5 over-length text refused; nothing pushed.
  - T6 `adopt` with a closed `slot.inbox` → `undefined`, the slot stays foreground; with an open
    one → the running entry's inbox IS `slot.inbox` (a text pushed via `message(newId)` is drained
    from the inbox the runner holds).
- `packages/agent/test/subagent.test.ts` (extend)
  - T7 a child given an inbox: a text pushed while its first model round streams (gated model) is
    in the second request as a user message `[message from the parent agent] …`.
  - T8 **the window**: push right AFTER the child's last round ended (scripted model ends with
    `end_turn`; push from inside the gate release, before the runner returns) → the child runs one
    more pass and its next request contains the text; the inbox ends closed. Red with the naive
    runner (no `closeIfEmpty` loop): the text is never in any request.
  - T9 child cancelled with a queued text → report ends with the "1 message(s) … were not read"
    line; `inbox.closed` true.
  - T10 a child never receives `agent_message` (registry filter) and `readOnlyType` ignores it.
- `packages/tools/test/agent-message.test.ts` (new, mirrors `agent-kill.test.ts`)
  - T11 result texts: ok → "queued for sa-1 …", `isError` false; each refusal → `isError` true
    with the reason.
- `packages/tools/test/task-detach.test.ts` (extend)
  - T12 a movable child: before the move `message` has no id to target; after the move a
    `message(sa-1)` is drained by the SAME running child (its next request has it).
- `packages/cli/test/wiring.test.ts` (extend) — T13 `agent_message` registered exactly when
  `agent_kill` is.
- `packages/cli/test/agent-message.e2e.test.ts` (new, the real `createLocalRuntime` ↔
  `Connection` stack of `subagent-detach.e2e.test.ts`, with its gated model)
  - T14 the agent launches `agent_task{background}` → `sa-1`; next round the model calls
    `agent_message{agent_id:"sa-1", text:"also check X"}`; the client stream shows the tool result
    "queued for sa-1 …"; the child's next model request (gated provider sees the child's requests)
    contains `[message from the parent agent] also check X`; the child ends; the `[background]`
    note reaches the parent's next request. No extra parent turn is started by the message (no
    wake: count the parent's turns).
  - T15 same stack: `agent_message` to `sa-9` → `tool_result` `isError` with "not a running
    background sub-agent".

Non-vacuity (§9): T1/T8 by the naive stubs above; T14 by mutation — wire the tool to a fresh
`AgentJobs` instead of the session's: T14 must fail.

Gate before done: `bun run check` (typecheck, lint baseline clean, full test).

### Notes / debt

- Nothing renders the delivered text yet (a child `steer` reaches no client). Task 7's panel adds
  a row for it; a `ToolProgressEvent` kind for it belongs there.
- The error path (runner throws) drops the "unread" count line; the error report already says the
  child failed. Accepted.
- A continuation pass runs the child's `turn_start` hooks again (`agent.ts:871`); rare (only the
  close window), accepted.

## Owner questions

**Q1. Where does the user → sub-agent path (owner Q1 b) land?** The eval's split table (row 8,
line 576) puts "the user's panel text to a child (`[user → sa-N]` note)" in THIS task; row 7 says
task 7 "reuses #8's inbox". The task brief puts it in task 7.
- **(a) Recommended: task 7.** Task 8 ships the inbox with the `"user"` sender, unit-tested
  (T3/T4); task 7 adds the RPC method, the `HostedSession` call, the `[user → sa-N]` note (with
  eval M2/M3: `note.kind`, not counted in `pendingExitCount`) and the UI that sends it. Keeps this
  load-bearing task small and leaves no daemon method without a caller.
- (b) Task 8 also adds the RPC method + note (no bump: methods are free); task 7 is UI only. Dead
  until 7 lands; only the e2e calls it.

**Q2. Limits of the inbox.**
- **(a) Recommended:** at most 8 unread texts per child, 8 000 chars per text; over either →
  a tool error, nothing sent.
- (b) No limits (a looping agent can grow a child's context without bound).
- (c) Other numbers.

## Execution

## Review

### Answers (decided by the orchestrator overnight — to confirm by the owner)

Owner delegated the night of 2026-11-09→10 ("Decidi e fai merge"); each answer is the plan's recommendation:
- **Q1: (a)** the user → sub-agent path (RPC method, `[user → sa-N]` note, UI) belongs to task 7; task 8 delivers the inbox with the `"user"` sender already tested.
- **Q2: (a)** at most 8 unread texts per child and 8 000 characters per text; beyond that a tool error and nothing is sent.

*— orchestrator (claude-opus-5-5), 2026-11-10*
