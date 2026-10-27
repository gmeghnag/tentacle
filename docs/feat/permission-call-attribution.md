# feat/permission-call-attribution — Attribute each permission ask to its call, not to the last `tool_start`

> **Status:** implementation
> **Branch:** `feat/permission-call-attribution`
> **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review that red-teams the single-broker invariant, the "pending on disk ⇒ never started" persistence invariant, and the pod-trust rule (AGENTS §7)

Task 4 of 7 in [`docs/eval/parallel-execution-plan.md`](../eval/parallel-execution-plan.md)
(§1.1(c), §2.2, split table). Tasks 1–3 are merged. Task 5 (`round-groups-persistence`) comes after this one.

## Context

*— claude-opus-5-5, 2026-10-26*

**Problem.** The daemon decides *which call* a permission ask belongs to by
looking at the most recent `tool_start`, not by asking the requester. Today
that works only because calls run strictly one after another. Tasks 6
(parallel tools) and 7 (parallel sub-agents) will have several calls in flight
at once, and then this guess names the wrong call in three places: the wire,
the persisted record, and the "resumable" classification.

Evidence (main `6bb7d4a`):

- **The gate drops the call id.** `GateCall` has `toolCallId`
  (`packages/agent/src/permission-gate.ts:86-90`), but the requester is called
  with the request only: `await this.requester(request)` (`:162`). No
  `PermissionRequestOptions` is passed at all.
- **The wiring drops options too.** Both agent factories pass
  `requestPermission: (req) => permissions.request(req)`
  (`packages/cli/src/wiring.ts:387` for sub-agents, `:428` for the main
  agent). The daemon's requester is `setRequester((req) => this.awaitDecision(req))`
  (`packages/daemon/src/hosted-session.ts:409`).
- **The daemon guesses.** `currentToolCallId` / `currentToolName`
  (`hosted-session.ts:301-302`) are overwritten on every `tool_start`
  (`:1234-1237`). `awaitDecision` uses them for the wire `toolCallId`
  (`:484`, with a `"pending"` fallback), the persisted `PendingPermission.toolCallId`
  (`:485-486`) and `resumable` (`:488-493` → `classifyPending`,
  `packages/daemon/src/persisted-session.ts:316-324`, which infers "own call"
  from `requestTool === currentToolName`).
- **`pending` is one slot.** `private pending: PendingPermission | undefined`
  (`hosted-session.ts:304`), overwritten by each ask (`:508`), cleared by the
  ask's own settle (`:526-533`), by every `history_commit` (`:1215-1222`), by
  `context_reset` (`:1228-1230`) and at turn end (`:1321`). The `asks` map
  already holds several asks (`:306`, doc comment "one at a time today").
- **Sub-agent asks have no identity.** A child `Agent` gets the parent's
  requester unchanged (`packages/agent/src/subagent.ts:185`); `TaskRunControls`
  carries only `signal` and `onEvent` (`packages/tools/src/task.ts:18-21`), and
  `ToolContext` has no call id (`packages/core/src/tool.ts:82-102`). The wire
  `permission_request` has no field saying which sub-agent asks
  (`packages/protocol/src/permission.ts:54-66`).

**Constraint.** "Sequential behaviour identical": with today's one-call-at-a-time
loop, every observable (wire updates, records, reload outcome, prompts shown)
must stay the same. This task only replaces an inference with an explicit
value, and makes the data structures able to hold several asks.

**Decision it serves.** Task 6 and 7 can then run calls concurrently without
touching the permission attribution again.

**PE-Q4 (one "Yes, always" for the whole session tree) is NOT in this task;
it belongs to task 7.** Reasons:
1. It changes behaviour even with sequential execution: today a sub-agent's
   "always" does not cover its parent or later sub-agents (each `Agent` builds
   its own `PermissionGate`, `packages/agent/src/agent.ts:417`). Sharing grants
   removes prompts the user sees today, which contradicts this task's
   "sequential behaviour identical" contract.
2. Its hard part is the grant race (repro C in the plan: the gate checks its
   rules at `permission-gate.ts:158` and writes them at `:164` with an `await`
   in between). That race only exists with concurrent asks, i.e. in task 7.
3. It lives in a different seam (the gate's rule store in `@tentacle/agent`),
   not in attribution (requester options, daemon, wire). The plan's split
   table already lists "shared session grants" under task 7.

**Repro** (to be run by the executor on `main` before any edit, in
`.tentacle/tmp/permission-call-attribution/`; the planner brief was read-only,
so it has **not been run yet**. The expected output follows the cited code.)

```ts
// repro.ts — what the requester receives from the gate today
import { PermissionGate } from "../../../packages/agent/src/permission-gate.ts";
import type { Tool } from "@tentacle/core";
import { z } from "zod";

const tool: Tool = {
  name: "shell", description: "", inputSchema: z.object({ command: z.string() }),
  permission: "ask", async execute() { return { content: "" }; },
};
const gate = new PermissionGate(async (req, options) => {
  console.log("requester options:", JSON.stringify(options ?? null));
  return { allowed: false };
});
await gate.authorize(tool, { command: "ls" }, {
  sessionId: "s", toolCallId: "c1", signal: new AbortController().signal,
});
```

Expected today: `requester options: null` (the call id `c1` is lost).
After this task: `requester options: {"toolCallId":"c1","origin":"call"}`.

## Implementation

*— claude-opus-5-5, 2026-10-26*

### Load-bearing assumption

**In today's loop at most ONE permission ask is pending per session at any
time, and the gate's `call.toolCallId` always equals the daemon's
`currentToolCallId` when the ask is raised.** If that holds, replacing the
inference with the explicit value and the slot with a list is behaviour-neutral
on every existing path. Proof:

- Calls run strictly in order: `for (const call of calls)` yields `tool_start`
  (`agent.ts:1085`), then awaits `runTool` (`:1093`, `:1097`), whose
  `gate.authorize` gets `toolCallId: call.id` (`:1413-1417`). The daemon sets
  `currentToolCallId = event.id` from that very `tool_start`
  (`hosted-session.ts:1234-1235`) before the ask arrives. Same pairing for the
  context-reset path (`tool_start` `agent.ts:1147`, authorize `:1166-1170`).
- A sub-agent runs inside the parent's `agent_task` call, whose permission is
  `"none"` (`task.ts:52`), so the parent never asks while a child does. The
  child's own `tool_start` events are NOT parent `tool_start` events: they are
  forwarded as `subagent_tool` progress (`subagent.ts:211-213`,
  `agent.ts:244-254`), so `currentToolCallId` stays the parent's
  `agent_task` id. That is exactly the id the child wrapper will pass
  explicitly (Design §3).
- The daemon refuses to ask during a compaction (`hosted-session.ts:468`).
  Hooks trust (`askHooksTrust`) does not go through `awaitDecision`: it uses
  its own laptop-side path (`wiring.ts:473-481`).

The executor confirms it empirically with a test: on the unchanged
`permission-events.test.ts` / `persistence.test.ts` suites (which pass before
and after), plus an assertion that the explicit `toolCallId` equals the
`currentToolCallId` the old code would have used, in each existing scenario,
before deleting the field (see Tests, T0).

### Preconditions

- **Single broker (AGENTS §7).** This task adds no broker and no requester
  instance: it only forwards a second argument through the existing ones
  (`PermissionBroker.request(req, options)` already takes options,
  `packages/core/src/permission.ts`; `setRequester` replays held entries with
  their options). The daemon still installs exactly one requester on the
  factory's broker (`hosted-session.ts:409`).
- **Options are laptop/process-internal, never on the wire.** `PermissionRequestOptions`
  already carries `signal` and `turnId` with that rule
  (`core/src/permission.ts:64-74`). `toolCallId` / `origin` follow it. Only
  `agent` is projected onto the wire, explicitly, by the daemon.
- **Clients already handle several pending requests.** `PermissionRouter`
  queues FIFO and shows one dialog at a time
  (`packages/client/src/permission-router.ts:83-98`), dedupes replays by
  `requestId` (`:89-95`), and on resync keeps only what the replay re-offers
  (`retainOnly`, `:176`). The TUI requester already reads `options`
  (`packages/tui/src/permission-ui.ts:182`).
- **Settle is first-wins and synchronous** (`resolvePermission` / `settle`,
  `hosted-session.ts:579-610`); an unknown `requestId` is
  `PermissionNotPending` with no effect (`:580-583`).
- **Clear-before-run.** A settled ask's pending entry is cleared and the write
  awaited before the gate returns (`hosted-session.ts:525-533`), so "pending on
  disk ⇒ never started" holds. The new design keeps that exact sequence.
- **Record format.** `DAEMON_RECORD_VERSION = 7`
  (`persisted-session.ts:36`); `turn.pending` is a single object, strictly
  parsed (`:174-185`). The TODO assigns the next record version to task 5
  (`TODO.md:411-413`, PE-Q2; v8 is contested with `permission-reply`).
- **Forward-compat (AGENTS §7, since v10).** Payloads are strip schemas; a new
  optional field on a blocking update is dropped by an older parser.
  `permission_request` is `blocking` (`packages/protocol/src/updates.ts:269`).
  `PROTOCOL_VERSION = 13` (`packages/protocol/src/version.ts:7`).

### Design

**1. Requester options (core).** `PermissionRequestOptions` gains three
optional, process-internal fields:

```ts
/** The call the ask is for: the asking call itself, or the parent `agent_task` call of a sub-agent. */
readonly toolCallId?: string;
/** `call`: the call asked for itself. `subagent`: a sub-agent inside call `toolCallId` asked. */
readonly origin?: "call" | "subagent";
/** Which sub-agent asked (display only; set with `origin: "subagent"`). */
readonly agent?: { readonly type: string; readonly description: string };
```

`ToolContext` gains `readonly toolCallId?: string` (the call being executed;
absent outside the loop).

**2. Gate (agent).** `permission-gate.ts:162` becomes
`this.requester(request, { toolCallId: call.toolCallId, origin: "call" })`.
No `signal` is added (the daemon uses the turn's signal; adding it would be a
behaviour change outside this task). The loop sets `toolCallId: call.id` in
the per-call `ToolContext` (`agent.ts:1089-1092`).

**3. Sub-agent wrapper (tools + agent).** `TaskRunControls` and
`SubagentRunControls` gain `toolCallId?`. `agent_task` passes
`ctx.toolCallId` (`task.ts:57-60`). The runner builds the child's requester
as a wrapper whose fields WIN over the child gate's own:

```ts
(req, options) => deps.requestPermission(req, {
  ...options,
  ...(controls?.toolCallId !== undefined ? { toolCallId: controls.toolCallId } : { toolCallId: undefined }),
  origin: "subagent",
  agent: { type: type.name, description: opts.description },
})
```

A child's own call id must never escape: it is unknown to the parent history.
When the parent id is missing, `toolCallId` is cleared (see Failure modes).
The wrapper is a pure function in `subagent.ts`, unit-tested.

**4. Wiring (cli).** `wiring.ts:387` and `:428`:
`requestPermission: (req, options) => permissions.request(req, options)`.
Two one-line edits; nothing else in `packages/cli`.

**5. Daemon: explicit attribution, `pending` as a list.**
- `setRequester((req, options) => this.awaitDecision(req, options))`.
- Delete `currentToolCallId` / `currentToolName` and their `tool_start` write.
- `awaitDecision` takes `id = options?.toolCallId`, `origin = options?.origin`:
  - wire: `toPermissionRequestUpdate(requestId, id ?? "pending", req, options?.agent)`;
  - record: `{ toolCallId: id ?? "", tool: req.tool, resumable: classifyPending(messages, id, origin, req.tool), requestedAt }`.
- `classifyPending(messages, toolCallId, origin, requestTool)` returns
  `origin === "call" && toolCallId !== undefined && suspendedCalls(messages, toolCallId)?.[0]?.name === requestTool`.
  Explicit, not inferred from the tool name. It matches today's result in
  every sequential case: an own ask has `requestTool === call name`; a
  sub-agent ask fails on `origin` (today it fails on the name, the parent
  call being `agent_task`).
- **One source of truth for what is pending: the `asks` map.** `PendingAsk`
  gains `readonly record: PendingPermission`. The single `pending` slot is
  replaced by:
  - `asks` (live asks, each with its record), and
  - `carried: PendingPermission | undefined`: the resumed turn's record from
    disk (`hosted-session.ts:439`) until its re-ask arrives. It is replaced
    when an ask arrives with the same `toolCallId`, and cleared by
    `history_commit`, `context_reset` and turn end, exactly where `pending`
    is cleared today.
  - `pendingList()` = `carried` (if any) + every live ask's record, in
    request order.
- Settle: `settle` already deletes the ask synchronously. Then, in the
  `decided.then` of that ask, unconditionally `persist()` and
  `await untilAborted(this.persisted(), signal)` (today guarded by
  `this.pending === record`, which is always true in the sequential case; the
  guard is replaced by "this ask had a record", which is always true).
  Clear-before-run is unchanged.
- `history_commit` no longer clears live asks: it clears only `carried`.
  Sequentially there is no live ask at a commit (the agent commits between
  calls), so this is identical today; for task 7 it is the correct rule (a
  sibling's commit must not drop another call's pending ask).

**6. On-disk shape: unchanged in this task (no record bump).** A pure
projection `pendingForRecord(list)` in `persisted-session.ts`:
- 0 entries → no `pending`;
- exactly 1 → that entry (byte-identical to today);
- more than 1 → no `pending`. This is unreachable until task 6/7 (load-bearing
  assumption). If it happens, the reload closes the turn honestly ("Interrupted"
  for the first unanswered call, "Not run" for the rest, `persisted-session.ts:465-476`):
  never resumed, never re-run. Pinned by a test.

Task 5 already takes the next record version (PE-Q2, R2 `inFlight`). The list
goes on disk there, in the same bump, as the plan says (§1.1(c): "It goes in
the same record version bump"). Doing it here would spend a second version and
collide with `permission-reply`'s claim on v8. This is a sequencing choice,
not a product one; it is noted here so the Review can challenge it.

**7. Wire: `agent?` on `permission_request` (additive, no version bump).**
`PermissionRequestUpdateSchema` gains
`agent: z.object({ type: z.string(), description: z.string() }).optional()`.
No `.max()`: an over-long value from a pod must not make a blocking update
unparseable (it would stall or fail the turn). The laptop bounds it when it
renders it (task 7). `permission-map.ts` sets it from `options.agent`.

- **Why no `PROTOCOL_VERSION` bump:** it is a new optional field on an
  existing update. Strip schemas mean a v13 peer without the field drops it,
  and the update keeps its class (`blocking`), meaning and every existing
  field (AGENTS §7: "Fields and methods are free"). Nothing removed or
  re-meant.
- **`pending` as a list does not touch the wire.** It is daemon state and (in
  task 5) record format. The wire already allows several `permission_request`s
  outstanding, each with its own `requestId`; the client queues them.
- **`toolCallId` / `origin` stay off the wire** as new fields. The existing
  wire `toolCallId` simply becomes correct by construction.

**8. Client: carry `agent` to the laptop requester (no rendering).**
`PermissionRouter`'s `prompt` action carries `agent` from the update;
`RemoteClient.runPermissionActions` (`remote-client.ts:1865-1869`) puts it in
the options next to `turnId`. The TUI does not render it yet (task 7 owns the
dialog label; Owner question 1). No laptop decision reads it.

### Files

Dependency order (protocol → core → tools/agent → daemon → client → cli):

1. `packages/protocol/src/permission.ts`: `agent?` on `PermissionRequestUpdateSchema`.
2. `packages/core/src/permission.ts`: `PermissionRequestOptions.{toolCallId, origin, agent}`.
3. `packages/core/src/tool.ts`: `ToolContext.toolCallId?`.
4. `packages/tools/src/task.ts`: `TaskRunControls.toolCallId?`; pass `ctx.toolCallId`.
5. `packages/agent/src/permission-gate.ts`: pass `{ toolCallId, origin: "call" }`.
6. `packages/agent/src/agent.ts`: `toolCallId: call.id` in the per-call ctx.
7. `packages/agent/src/subagent.ts`: `SubagentRunControls.toolCallId?`; the pure child-requester wrapper.
8. `packages/daemon/src/persisted-session.ts`: `classifyPending(…, origin, …)`; `pendingForRecord`.
9. `packages/daemon/src/permission-map.ts`: `agent` onto the update.
10. `packages/daemon/src/hosted-session.ts`: requester with options; drop `currentToolCallId/Name`; `asks` records + `carried`; projection.
11. `packages/client/src/permission-router.ts`: `agent` on the `prompt` action.
12. `packages/client/src/remote-client.ts`: `agent` into the request options.
13. `packages/cli/src/wiring.ts`: two lines (`:387`, `:428`) forward `options`.

**Possible overlap with Docker slice B** (running in the primary checkout,
touching `cli`/`k8s`/`docker`): only `packages/cli/src/wiring.ts`, two
one-line lambdas at `:387` and `:428`, plus a test in
`packages/cli/test/wiring.test.ts`. No other `cli`, `k8s` or `docker` file.
A conflict there, if any, is trivial to resolve by hand.

Not touched: `packages/tui` (rendering is task 7), `apps/mobile`, the gate's
grant store (PE-Q4, task 7), `DAEMON_RECORD_VERSION` (task 5).

### Failure modes

- **Two requests pending at once** (unreachable sequentially; possible from
  task 6/7, and driven directly in a test). Each ask has its own `requestId`,
  record and abort listener in `asks`. Each wire update names its own
  `toolCallId`. Answering one settles only that one (`settle` by id). The
  client shows them one at a time (FIFO). On disk: no `pending` while more than
  one is live (Design §6); back to the single entry when one settles. A cancel
  aborts the turn signal, which settles all of them (`cancelled`), as today.
  `recheckAsks` already iterates all asks (`hosted-session.ts:561-569`).
- **Answer for a request already withdrawn** (settled by a cancel, answered by
  another client, or from before a restart): `PermissionNotPending`, no effect
  (`:580-583`). Unchanged. An answer can never bind to another pending ask:
  lookup is by `requestId`, a fresh nonce, never by `toolCallId`.
- **Reconnect with several pending.** While an ask is pending, the cut cannot
  move past it, so a replay from the cut re-offers it (`hosted-session.ts:20-29`);
  the router dedupes and keeps what the replay re-offers (`retainOnly`).
  Sequentially, unchanged. **Known limit for task 7, not this task:** the cut
  moves at every `history_commit` (`:1215-1222`); with parallel sub-agents, a
  sibling's commit would move the cut past a still-pending ask, and a client
  resyncing from the cut would miss it. Task 7 must handle it (e.g. replay
  live asks from `asks` on attach). Recorded here so it is not lost.
- **A pod forging `toolCallId` / `origin` / `agent`.** The pod runs the daemon,
  so it can already write any `permission_request` frame. `origin` never
  crosses the wire. The wire `toolCallId` and `agent` are display data on the
  laptop: no laptop decision reads them. Auto-accept is keyed on the
  laptop-derived `turnId` (`permission-ui.ts:51-57`). Grants live daemon-side
  in the gate, which AGENTS §7 already treats as UX, not security. So a forged
  `agent` can mislabel a dialog, as a forged `title` can today, and nothing
  more. It must be rendered as untrusted text, bounded and with control
  characters stripped. That rendering is task 7; until then it is not
  rendered. Inside a pod daemon, a forged `origin: "call"` could only mark an
  ask "resumable", but pod daemons never persist (AGENTS §7), so nothing
  reloads it.
- **Missing options** (a requester path not yet forwarding them; a sub-agent
  without a parent id). The wire falls back to `"pending"` (as today when
  `currentToolCallId` was empty), `resumable` is `false`, and the record's
  `toolCallId` is `""`. A reload then closes the turn honestly and never
  resumes the wrong call. The child wrapper clears `toolCallId` rather than
  leaking the child's id.
- **Resumed turn.** The carried record keeps the disk shape until the re-ask
  (same `toolCallId`, now explicit) replaces it. If the call is answered
  without a re-ask (cancel, hook allow), the next `history_commit` clears
  `carried`, as today.
- **Version skew.** A v13 client without `agent` support drops the field; a new
  client with an old daemon never receives it. No mismatch, no `unsupported`
  (it is a field, not a kind).

### Tests

Red before green, each pinning one property. Fakes: the existing daemon
permission harness (`packages/daemon/test/permission-events.test.ts`), the
record helpers (`persistence.test.ts`), the gate tests
(`packages/agent/test/permission.test.ts`), `subagent.test.ts`,
`packages/client/test/permission-router.test.ts`, `packages/cli/test/wiring.test.ts`.

- **T0 (load-bearing, before deleting the field):** in the existing daemon
  scenarios, the explicit `options.toolCallId` equals the current
  `currentToolCallId` at every ask. Then delete the field. The unchanged
  `permission-events` and `persistence` suites stay green: that is the
  "sequential identical" pin.
- **T1 gate:** the requester receives `{ toolCallId: "c1", origin: "call" }`.
  Red today (options are `undefined`).
- **T2 sub-agent wrapper:** a child ask reaches the parent requester with the
  PARENT `agent_task` id, `origin: "subagent"` and `agent: { type, description }`,
  even though the child gate passed its own id. Without a parent id,
  `toolCallId` is absent (never the child's).
- **T3 daemon attribution (red today):** an ask raised with
  `options.toolCallId = "c1"` after `tool_start` for `"c2"` streams
  `permission_request.toolCallId === "c1"` and records `toolCallId "c1"`.
- **T4 classification:** `origin: "subagent"` → `resumable: false` even when
  the tool name matches the call; `origin: "call"` with a history not
  suspended before the call → `false`; with the right history → `true`.
- **T5 two concurrent asks** (driven straight through the broker's requester):
  two updates with distinct `requestId`/`toolCallId`; answering one leaves the
  other in `asks` and resolvable; a stale answer to the first →
  `PermissionNotPending`; the written record has no `pending` while both live,
  and the single remaining one after the first settles; a cancel settles both.
- **T6 `pendingForRecord`:** 0 → absent, 1 → identical object, 2 → absent; a
  record written with 2 reloads closed (no `resume`, notes "Interrupted"/"Not run").
- **T7 commit keeps live asks:** a `history_commit` while an ask is live does
  not drop it from the record (red today: the slot is cleared). The carried
  resume entry is still cleared by a commit.
- **T8 wire:** the schema parses an update with `agent` and one without; an
  unknown extra field inside `agent` is stripped; the daemon maps
  `options.agent` onto the update.
- **T9 client:** a `permission_request` with `agent` produces a `prompt`
  action and laptop requester options carrying it, next to `turnId`.
- **T10 cli wiring:** both factories forward `options` to the broker. Check
  non-vacuity by mutation: put back `(req) => permissions.request(req)` and
  T10 must fail.

Gate before Review: `bun run check` (typecheck → lint → test) green, lint at
the clean baseline (AGENTS §6).

**Owner questions**

1. **Show the sub-agent label in the dialog now, or in task 7?** Sub-agent asks
   already happen one at a time today, so a label ("explore · find callers —
   Run a shell command") would help now. But it changes the UI, and this task's
   contract is "sequential behaviour identical". **Recommendation: task 7**
   (as the plan's split says). Task 4 only puts `agent` on the wire and in the
   requester options, tested at the client boundary.

## Execution

*— claude-opus-5-5, 2026-10-26*

**Baseline** (before any edit, `bun run check`): typecheck ok, lint clean
(526 files), `3156 pass / 3 skip / 0 fail`.

**Repro** (`.tentacle/tmp/permission-call-attribution/repro.ts`, the Context's
script with two import fixes: `../../../` from `.tentacle/tmp/<slug>/` resolves
to the PRIMARY checkout, not this worktree, so the gate is imported by absolute
worktree path, and `zod` from `packages/agent/node_modules/zod`):

```
before: requester options: null
after:  requester options: {"toolCallId":"c1","origin":"call"}
```

**As built, in order**

1. `protocol/src/permission.ts`: `agent?: { type, description }` on
   `PermissionRequestUpdateSchema` (no `.max()`). `schema/protocol.json`
   regenerated with `bun run schema:export`. `PROTOCOL_VERSION` stays 13.
2. `core/src/permission.ts`: `PermissionRequestOptions.{toolCallId, origin, agent}`.
   `core/src/tool.ts`: `ToolContext.toolCallId?`.
3. `tools/src/task.ts`: `TaskRunControls.toolCallId?`; `agent_task` passes `ctx.toolCallId`.
4. `agent/src/permission-gate.ts`: the requester gets `{ toolCallId: call.toolCallId, origin: "call" }`.
   `agent/src/agent.ts`: `toolCallId: call.id` in the per-call ctx (the
   context-reset path executes no tool with a ctx, so only the main loop).
5. `agent/src/subagent.ts`: `SubagentRunControls.toolCallId?`; pure
   `subagentRequester(requester, parentCallId, agent)` (exported, so public
   from `@tentacle/agent` via `export *`). It drops the child's `toolCallId`
   by destructuring (the key is absent, not `undefined`), keeps the other
   options (`signal`, `turnId`), sets `origin: "subagent"` and `agent`. Wrapped
   only when `deps.requestPermission` is set (unchanged default otherwise).
6. **T0** (see below), then `cli/src/wiring.ts`: the two lambdas forward
   `options` (`:387`, `:428`). Nothing else in `packages/cli/src`.
7. `daemon/src/permission-map.ts`: `toPermissionRequestUpdate(…, agent?)`
   copies `type`/`description` field by field.
   `daemon/src/persisted-session.ts`: `classifyPending(messages, toolCallId, origin, requestTool)`
   = `origin === "call" && toolCallId !== undefined && suspendedCalls(…)?.[0]?.name === requestTool`;
   `pendingForRecord(list)` (`length === 1 ? list[0] : undefined`).
   `DAEMON_RECORD_VERSION` stays 7.
8. `daemon/src/hosted-session.ts`: requester `(req, options) => this.awaitDecision(req, options)`;
   `currentToolCallId`/`currentToolName` and their `tool_start` write deleted
   (grep: no reference left); `PendingAsk.record`; slot `pending` → `carried`
   (resume only) + `pendingList()` (carried, then live asks in insertion
   order); `persistedState` writes `pendingForRecord(pendingList())`.
   `options.toolCallId || undefined` (an empty id counts as absent) →
   wire `"pending"`, record `""`, `resumable: false`. An ask whose id equals
   `carried.toolCallId` clears `carried`. The settle `.then` now always
   `persist()` + `await untilAborted(persisted(), signal)` (the
   `this.pending === record` guard is gone; `settle` already deleted the ask).
   `history_commit`, `context_reset` and turn end clear only `carried`.
9. `client/src/permission-router.ts`: `prompt` action carries `agent` (copied
   field by field) when the update has one. `client/src/remote-client.ts`:
   `agent` into the laptop requester's options, next to `signal`/`turnId`.
   No laptop decision reads it; `packages/tui` untouched (label → task 7).

**T0 (load-bearing assumption, measured before deleting the field).** A
temporary `console.error` in the daemon requester compared
`options.toolCallId` with `currentToolCallId` at every ask, over
`bun test packages/daemon packages/client packages/cli packages/tui` (1940
pass). After the wiring change: **160 asks MATCH, 0 production-path
mismatches**. The only mismatches were two fixtures that bypass the gate:
persistence A5 (a tool calling `broker.request` with no options; fixed, see
drift 2) and the `pod-runtime.test.ts` rig (drift 3). No existing daemon-path
test raises a real sub-agent ask (0 `origin: "subagent"` matches), so the
sub-agent half of the equivalence rests on T2 + T10 + A5. The instrumentation
was removed by restoring the file from a `cp` backup (`git diff --quiet` on it
was clean before the daemon edit).

**Tests (red → green)**

| Test | File | Red on unchanged code |
|---|---|---|
| T1 requester gets `{toolCallId:"c1", origin:"call"}`; a tool sees its own `ctx.toolCallId` | `agent/test/permission.test.ts` | yes: options `undefined`; ctx id `undefined` |
| T2 child ask → parent id, `origin: "subagent"`, `agent`; no parent id → no `toolCallId`; wrapper keeps `signal`/`turnId`; end-to-end through `agent_task` | `agent/test/subagent.test.ts` | written after the impl; red shown by mutation (below) |
| T3 ask raised for `c1` during `tool_start c2` → wire + record `c1` | `daemon/test/persistence.test.ts` | yes: `Received "c2"` |
| T4 `classifyPending` (A14 rewritten for the new signature + subagent/no-attribution cases) | same | signature change (compile); red shown by mutation |
| T5/T6 two live asks: distinct ids/`toolCallId`s, no `pending` on disk while both live, reload of that record closed (`Interrupted`, `RESTART_TURN_END`, no `resume`), single entry after one settles, stale answer → `PermissionNotPending` | same | yes: toolCallIds `["f1","f1"]` |
| T5 a cancel settles every live ask | same | green on main too (the `asks` map already did): a guard, not a red test |
| T6 `pendingForRecord` 0/1/2 | same | new symbol; red by mutation |
| T7 a `history_commit` keeps another call's live ask on disk | same | yes: `pending` cleared |
| T8 sub-agent ask streams `agent`, record `resumable:false`; no options → `"pending"` / `""` | same | yes: no `agent` |
| T8 schema: `agent` kept, inner extra stripped, 10 000-char description accepted, `agent` without `description` rejected | `protocol/test/permission.test.ts` | red by mutation |
| T9 router `prompt` carries `agent` (a queued request keeps its own/none) | `client/test/permission-router.test.ts` | yes |
| T9 scripted daemon → laptop broker options `{signal, turnId:"T", agent}`, no `toolCallId`/`origin` from the wire | `client/test/foreign-turns.test.ts` | yes |
| T10 `buildAgent`: main ask `{c1, call}`, sub-agent ask `{t1, subagent, agent}` (child's `k1` never escapes) | `cli/test/wiring.test.ts` | yes: `[undefined, undefined]` |

**Mutations** (each from a `cp` backup in `.tentacle/tmp/<slug>/`, restored by
`cp`, `shasum` identical to the backup afterwards):

- child gets the parent requester unwrapped (`subagent.ts`) → 3 T2 tests red;
- `agent_task` drops `ctx.toolCallId` (`task.ts`) → T2 end-to-end red;
- `wiring.ts` sub-agent factory back to `(req) => permissions.request(req)` → T10 red (2nd entry);
  main factory → T10 red (1st entry);
- `pendingForRecord` → `list[0]` → T6 unit + T5/T6 red;
- `classifyPending` without the `origin` check → A14/T4 red;
- `classifyPending` without origin AND name checks → A5, A14/T4, T8 red
  (verifies the updated A5 comment: each check alone still refuses);
- settle `.then` without `persist()` + `await` (clear-before-run) → H3, H4,
  B4, A6, T5/T6 red — "pending on disk ⇒ never started" stays pinned;
- schema without `agent` → T8 schema red.

**Drift from Implementation**

1. **Test rigs had to forward `options`.** The plan said the existing
   `permission-events`/`persistence` suites pass "unchanged". They cannot:
   every daemon/client test rig copies the old wiring lambda
   `requestPermission: (req) => permissions.request(req)`, so with the
   inference deleted their asks would be `"pending"`/`""`. Fixed
   mechanically (one `sed`, identical one-line edit) in 8 daemon + 5 client
   test files, plus `DaemonBrokerSpy.request` in `permission-events.test.ts`
   now forwards `options`. **No assertion changed**: the fixtures now mirror
   production `wiring.ts`; that is the "sequential identical" pin.
2. **A5 fixture** (persistence) modelled a sub-agent as a bare
   `broker.request(req)`. It now goes through the real `subagentRequester`
   with `ctx.toolCallId`; its assertions are unchanged (`toolCallId "t1"`,
   `resumable: false`, `SUBAGENT_INTERRUPTED_NOTE`). Its mutation comment was
   stale (the name check alone no longer flips it) and was corrected.
3. **`packages/cli/test/pod-runtime.test.ts` NOT touched** (to keep the cli
   overlap with Docker slice B to `wiring.ts` + `wiring.test.ts`). Its
   `SpyFakeCluster` daemon rig still uses `(req) => daemonBroker.request(req)`,
   so in that test the asks now stream `toolCallId: "pending"`. It asserts
   nothing about attribution and stays green, including the single-broker
   regression test. One-line follow-up for whoever owns cli next.
4. T5/T6 needed a `tick()` between `resolvePermission` and `persisted()`: the
   settled ask's write is scheduled in the `decided.then` microtask, after
   `resolvePermission` returns (same timing as on main).
5. T8 "the daemon maps `options.agent`" is covered at the boundary (the
   streamed update in the persistence T8 test), not by a separate
   `permission-map` unit test.
6. `carried` is replaced only by an ask for the SAME call (as designed); on
   main any ask overwrote the slot. Sequentially identical (the first ask
   after a resume is the resumed call's own re-ask, T0 + B1 green); noted for
   the Review.

**Gate at the end** (`bun run check`): typecheck ok, lint clean (526 files,
0 errors/warnings), **`3172 pass / 3 skip / 0 fail`** = baseline 3156 + 16
new tests; the 3 skips are the opt-in ones. Versions: `PROTOCOL_VERSION` 13,
`DAEMON_RECORD_VERSION` 7 (unchanged, the on-disk shape is unchanged).

**Unverified:** no end-to-end run of a real `serve`/pod session; behaviour is
pinned by the RPC-level suites above. To verify: `tentacle serve` + a
sub-agent that runs a shell command, and read the record's `turn.pending`
while the dialog is open.

## Review

> **Owner decisions (2026-10-26 23:00):** plan APPROVED. Sub-agent label in the permission dialog deferred to task 7 (with PE-Q4 shared "always").

*— claude-opus-5-5, 2026-10-27* (fresh context, but the SAME model as the
planner and the executor: blind spots they share can survive this pass.)

**Verdict: REQUEST-CHANGES (one test only; no production-code change asked).**

**Findings**

1. **MEDIUM — drift 4 is not pinned by any test** (`packages/daemon/src/hosted-session.ts:530-531`).
   Mutation: `if (toolCallId !== undefined && this.carried?.toolCallId === toolCallId)` → `if (false)`.
   Result: `bun test packages/daemon packages/client` gives **728 pass / 0 fail**.
   What the mutation breaks: after a `serve` reload, the resumed call is asked again,
   and the record then holds `carried` plus the live ask, 2 entries. `pendingForRecord`
   (`:662`) writes no `pending`, so a second restart while that dialog is open would
   close the turn ("Interrupted") instead of asking again. That breaks the AGENTS §7
   persistence rule "a turn suspended on its own call's permission runs again and is
   re-asked". On main the re-ask overwrote the slot, so this test would have been green.
   The production code is correct; only the pin is missing.
   Execution says "T0 + B1 green" covers this. That is not true: B1
   (`persistence.test.ts:328`) passes under the mutation.
   **Fix:** extend B1 (or add a test). While the re-ask is open, the written record's
   `turn.pending` is the single new entry (`toolCallId "c2"`, `resumable: true`).
   Optionally, a second reload from that record asks once more. Show it red under
   this exact mutation.
2. **LOW (reported, as asked) — drift 3 is a real but harmless gap**
   (`packages/cli/test/pod-runtime.test.ts:216`, its doc comment at `:192` now cites
   stale wiring). Its daemon rig drops `options`, so its asks stream `"pending"`. No
   assertion reads attribution. The single-broker test there is still meaningful: the
   *separate* daemon-side broker spy is untouched, and the invariant does not depend
   on options. Follow-up: forward `options` and update the `:192` comment when Docker
   slice B renames the file.

**Gate (re-run here):** typecheck ok; lint clean (526 files); **3172 pass / 3 skip /
0 fail** (3175 tests, 243 files). The 3 skips are the opt-in ones. Same as Execution.

**Mutations** (backups in `.tentacle/tmp/pca-review/`, restored by `cp`, `shasum`
identical to the backup afterwards: hosted-session `58145838…`, permission-gate
`96307785…`, subagent `9f8c1191…`):
- gate passes no `origin` (`permission-gate.ts`) → **9 red** (T1, T10, B1, B2, B5,
  B8, A26, Q-R2, Q9). Strong.
- `subagentRequester` keeps the child's `toolCallId` → **red** (T2: "without a parent
  call id … never its own").
- `carried` never replaced (finding 1) → **survives**.

**Attacks tried**
- *Sequential identical, wire:* there is one requester call site
  (`permission-gate.ts:164`). The only other `broker.request`, hooks-trust
  (`cli/src/hooks-trust.ts:185`), is on the laptop/in-process broker, not
  `awaitDecision`. The tool calls are pushed one by one, with a `history_commit` per
  call (`agent.ts:1082,1113`), so the old `currentToolCallId` always equalled
  `call.id` when an ask came in. Holds. (Main never reset `currentToolCallId`
  between turns, but no ask came before a `tool_start` in the same turn, so this
  difference cannot be seen.)
- *Sequential identical, `classifyPending`:* the new check
  `suspendedCalls(…)?.[0]?.name === requestTool` is equivalent to the old one.
  `suspendedCalls` returns `calls.slice(index)` (`agent/src/resume.ts:43`), so `[0]`
  is the call itself, and its name is the one the `tool_start` carried. A14 was
  rewritten with strictly more cases; no case was dropped. Holds.
- *Settle `.then` now persists every time:* on main the guard
  `pending === record` was always true while an ask was live. Turn end, commit and
  context reset all come after the gate returns. Holds; clear-before-run is still
  pinned (the executor's settle mutation, and this pass's gate mutation, turn
  B1/B2/B5 red).
- *Resume, then several calls:* `carried` is cleared by the per-call commit, so a
  later call's ask never meets it. Holds.
- *Single broker:* there is no new broker or requester. The 13 rig rewrites are one
  identical lambda each (`git diff` of the tests: the only removed lines are those
  lambdas, the stale A5 fixture/comment, and the old A14 lines). No assertion was
  weakened. `DaemonBrokerSpy` now forwards `options`, and it is still a separate
  daemon-side broker. Holds.
- *Pod forgery:* a forged `agent` reaches the laptop requester's options only.
  `permission-ui.ts` reads no `agent`/`origin`/`toolCallId`. `origin` and the
  options' `toolCallId` never come from the wire (`remote-client.ts:1866-1869`).
  Auto-accept stays keyed on the laptop's `turnId`. No lasting approval is possible.
  Holds, as long as task 7 renders `agent` as bounded, sanitised text.
- *`pending` as a list:* a stale answer gives `PermissionNotPending`, and a cancel
  settles every ask (T5). With two live asks, no `pending` is written, and a reload
  closes the turn (T6). A commit keeps a live ask (T7). Reconnect: the replay comes
  from the cut, unchanged when one ask is live. The limit for several asks is
  documented for task 7. Holds.
- *Protocol:* `agent?` is a new optional field in a strip schema, and the update
  class (`blocking`) is unchanged. Not bumping `PROTOCOL_VERSION` is honest under
  AGENTS §7 forward-compat. `protocol.json` was regenerated (+13 lines, `agent`). Both
  ends are wired: `permission-map.ts` and the router → `remote-client`.
- *RPC peer:* there is no new await or lock in a `Connection` handler. The only await
  is the existing `untilAborted(persisted())`, inside the turn. Holds.

**Premises spot-checked:** `permission-gate.ts:162` (requester without options on
main), `wiring.ts:387/:428`, `hosted-session.ts` slot/clears, `classifyPending` and
`suspendedCalls` semantics, `task.ts` controls: all TRUE.

**Executor behaviour:** disciplined. Measured T0 before deleting the field, ran
mutations for most new tests, and recorded its drifts honestly. One over-claim:
drift 4 is said to be pinned by B1, and it is not (finding 1).

### Execution — review fixes

*— claude-sonnet-5-5, 2026-10-27*

1. **Finding 1 (MEDIUM) fixed.** New test **B1b** in
   `packages/daemon/test/persistence.test.ts` (after B1): a turn suspended on
   c2 is reloaded and re-asks; the record written while that re-ask is open
   must hold a single `pending` (`c2`, `run`, `resumable: true`); a SECOND
   restore from that record runs again and asks again (new request id, no
   extra tool run). **Correction:** the Execution's claim that B1 pinned
   drift 4 was wrong — B1 passed under the mutation (the Review was right).
   Mutation `if (false)` at the `carried` branch (`hosted-session.ts:530`,
   backup `cp` in `.tentacle/tmp/pca-fix/`): B1b **red** (no `pending` on
   disk: `Matcher error: received value must be a non-null object`); restored
   from the backup, `shasum` identical (`58145838…`); B1b **green** on the
   real code.
2. **Finding 2 (LOW) recorded as debt, no code change:** `pod-runtime.test.ts`
   daemon rig drops `options` (asks stream `"pending"`; its `:192` comment is
   stale). Fix after Docker slice B merges (that file is renamed there):
   forward `options` in the rig and refresh the comment.
