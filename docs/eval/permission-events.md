# eval/permission-events — permission requests as session state, answered by any attached client

> **Status:** implementation drafted — awaiting owner approval (2026-10-19)
> **Branch:** none until promoted (then `feat/permission-events`; slice 7b, if the split below is approved, gets its own doc and branch)
> **Type:** eval → feat · **Size:** L as a whole → proposed split: **7a** live permission events (L: many small edits across 8 packages) + **7b** suspension across a `serve` restart (M) · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (single-broker + pod-trust invariants, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** replace the daemon→client `session/request_permission`
request with a `permission_request` stream event plus a
`session/resolve_permission` command, so a pending approval survives a
disconnect and can be answered from whichever client is attached.

Evidence: the requester is captured once per session from the creating
connection (`daemon/src/connection.ts:179`, `hosted-session.ts:48`); a closed or
timed-out request is coerced to `cancelled` (`connection.ts:208`); the
deadline is a flat 5 min (`ws-server.ts:38`). Session-remembered grants
("allow always") are cached **daemon-side** in `PermissionGate`
(`agent/src/permission-gate.ts:70-77`: `isRemembered` → approve without asking;
`remember` on a `session`-scope answer); `daemon/src/permission-map.ts:49-50`
only maps the wire outcome to that scope.

## Implementation

> **Owner decisions (2026-10-19):** the open questions below are resolved in
> the parent, `docs/eval/session-reattach.md` §"Owner decisions after the
> children's Implementation drafts" (A–G, D1–D10). Where a question or
> design point here disagrees, the parent decision wins.


*— claude-opus-5-5, 2026-10-19 (draft, awaiting owner approval)*

### Open questions / contradictions

Each has a recommendation; the plan below assumes the recommendation.

1. **Ordering hole with `daemon-side-persistence` (child 6).** Child 6 lands
   *before* this one but its own tests say "restart mid-suspension →
   `permission_request` re-emitted", an event that does not exist until this
   child. Child 6 also says it persists "the pending permission record", whose
   shape and lifecycle only this child can define. **Recommendation:** child 6
   persists history + steering queue only (plus, if it proves its
   load-bearing assumption by building it, the agent "resume trailing tool
   calls" entry, see 7b). The pending record, its write/clear protocol and the
   rebuild belong to **7b** here. Child 6's restart test becomes "restart
   after `turn_end` → history intact"; the mid-suspension test moves to 7b.
2. **Split (no XL).** The whole scope (live events + restart rebuild) touches
   protocol, transport, core, agent, daemon, client, cli, tui *and* the
   persistence/agent-resume path. **Recommendation:** split into **7a
   `permission-events`** (this doc, promoted to `feat/`) and **7b
   `permission-suspension-restart`** (the "Slice 7b" sub-sections below, cut
   into `docs/eval/permission-suspension-restart.md` by the owner — this agent
   may only edit this doc). 7b depends on 6 and 7a. Until 7b lands, a `serve`
   restart ends a suspended turn the way it ends any turn (session reloaded by
   6 with a dangling call → repaired per `history-validity-invariant`); no
   deny is ever sent, so the owner's "never a synthetic deny" holds in 7a.
3. **Replay alone does not guarantee a re-attaching client sees a pending
   request.** It works today only because no commit boundary can happen while
   the loop is blocked in `gate.authorize`; it breaks if the byte ring evicts
   the event during an hours-long suspension (background-exit floods, a
   sibling ring policy change). **Recommendation:** the registry's `open`
   result (child 4) gains an additive field `pendingPermissions:
   PermissionRequestUpdate[]` — session *state*, not history — and the client
   reconciles from it (prompt what is listed, close dialogs for what is not).
   Owned and added here; child 4's `open` is not redesigned, only extended.
4. **Cancel today does not unblock a pending request** (experiment E3 below:
   the turn stays `pending` 300 ms after `session/cancel`, and ends only when
   the client answers). Harmless with a 5 min timeout; with *no* timeout it
   would make "cancel the turn" — the only non-human way out of a suspension —
   hang forever. Not a design choice to make, a bug to design out: the
   daemon's requester must settle on the turn's abort signal (Design §3).
5. **What the model reads after a cancel during a prompt.** `runTool` returns
   "Permission denied by the user" whenever the gate returns `false`
   (`agent/src/agent.ts:495-500`) and re-checks the abort only after an
   approval (`:502-507`). After a cancel the history would claim a user
   *denial* that never happened. **Recommendation:** check `ctx.signal.aborted`
   first in that branch and return `CANCELLED_TOOL_NOTE` (`agent.ts:46`) — a
   2-line agent-loop change, inside this task's load-bearing review.
6. **Client broker defaults to `allowAll`.** `PermissionBroker`'s default
   requester is `allowAll` (`core/src/permission.ts:56`) until the TUI installs
   its own in a `useEffect` (`tui/src/permission-ui.ts:77-91`). Today the
   session opens lazily on the first `send` (`client/src/remote-session.ts:60-61`),
   long after mount, so no ask can arrive early. In v2 a re-attach replays
   pending requests at `open`, possibly before the effect runs → silent
   auto-approve, the exact AGENTS §7 failure. **Recommendation:** an additive
   `holdUntilSet` broker option (Design §6) used by every RPC-path broker.
7. **Line drift in this doc's Context.** `connection.ts:179` / `:208` are now
   `:205` (requester passed to `host.create`) and `:231` (`.catch → cancelled`)
   on `main` @ `4914e9b`; `hosted-session.ts:48` and `ws-server.ts:38` are
   unchanged. Citations below are current.
8. **Error-code number.** `PermissionNotPending` takes the next free
   `DomainErrorCode` at implementation time (today `-32009`,
   `transport/src/errors.ts:10-19`); siblings may add codes first. The *name*
   is the contract, the number is not.
9. **Remembered grants after a restart (7b).** `PermissionGate` rules live in
   memory (`permission-gate.ts:56-58`); after a `serve` restart they are gone,
   so the user is asked again for things they had "always" allowed.
   **Recommendation:** accept (fail-closed: more prompts, never fewer); do not
   persist grants in this task.

### Load-bearing assumption

**The daemon makes no *novel* decision.** For an `ask` tool, the only path
on which the daemon approves without a client answer is a session-remembered
grant that the client's broker already gave; every new approval, and every
denial, comes from a client via its single `PermissionBroker`. Today there is
exactly one daemon-originated *deny* (the `.catch → cancelled` fail-safe),
and this task removes it.

Proof (source, `main` @ `4914e9b`):

- **The gate is the only decider in the agent.** `runTool` → `gate.authorize`
  (`agent/src/agent.ts:495`); the gate is built once per `Agent` from
  `config.requestPermission ?? allowAll` (`:133`). `authorize`
  (`agent/src/permission-gate.ts:63-79`) has four exits: `none` → `true`
  (`:64-66`, static tool policy), `deny` → `false` (`:67-69`, static tool
  policy), `isRemembered` → `true` (`:70-72`, **the only non-static daemon
  approval**), else `await this.requester(request)` (`:74`) and `remember` iff
  `allowed && scope === "session"` (`:75-77`). No other exit.
- **The daemon's requester is always the forwarder.** Production wires the
  agent to the factory's broker (`cli/src/wiring.ts:83,140`; sub-agents use the
  same closure, `:124`, `agent/src/subagent.ts:168`), and `HostedSession`'s
  constructor synchronously replaces that broker's `allowAll` default with the
  forwarder (`daemon/src/hosted-session.ts:48-52`) before any turn can run;
  nothing daemon-side ever calls `reset()` (`rg setRequester|reset\(` →
  only `tui/src/permission-ui.ts:81,96` and `core/src/permission.ts`).
- **The forwarder's only autonomous output is a deny.** `Connection.requestPermission`
  (`daemon/src/connection.ts:222-232`) maps any rejection — closed peer,
  timeout (`requestTimeoutMs` = `permissionTimeoutMs`, `:73-75`; 5 min on
  `ws-server`, `ws-server.ts:38,183`), malformed reply — to `cancelled`, which
  `outcomeToResponse` turns into `{allowed:false}` (`daemon/src/permission-map.ts:43-45`).
  That is the "dead socket → deny" the owner rejected.
- **The client's single broker decides.** `RemoteClient.onPermission` calls
  `this.permissions.request(req)` on the broker the runtime was given
  (`client/src/remote-client.ts:315-325`); the same instance is handed to the
  TUI (`cli/src/main.ts:288-312,345,415,474`; `cli/src/connect.ts:16-27`). Pinned
  by the existing regression tests "an `ask` tool's permission request is
  routed through the shared broker" (`cli/test/pod-runtime.test.ts:310-338`
  for `run`, `:763-790` for `attach`), which use a `SpyBroker` (`:162-168`) on
  the client and a *separate* daemon broker (`SpyFakeCluster`, `:184-203`).

Experiment (2026-10-19, bun 1.4.3, `.tentacle/tmp/permission-events-impl/repro.ts`,
gitignored — pasted in full). Real `Agent` + `PermissionGate` + `SessionHost`
+ `Connection` + `shellTool`; a scripted model; a scripted client `RpcPeer`;
`DaemonBrokerSpy` logs what the daemon's *gate* receives back from its
requester.

```ts
// permission-events: what decides a permission today, and what a dead socket / a cancel does.
// Real Agent + PermissionGate + SessionHost + Connection; a scripted model; a scripted client peer.
import { Agent } from "@tentacle/agent";
import { type ChatRequest, type ExecutionEnvironment, type ModelProvider, PermissionBroker,
  type PermissionRequest, type PermissionResponse, type StreamEvent } from "@tentacle/core";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../../../packages/daemon/src/connection.ts";
import { SessionHost } from "../../../packages/daemon/src/session-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INIT = { protocolVersion: 1, clientCapabilities: { streaming: true } };
const call = (id: string, command: string): StreamEvent =>
  ({ type: "tool_call", toolCall: { id, name: "shell", arguments: JSON.stringify({ command }) } });
class Scripted implements ModelProvider {
  readonly id = "s"; private n = 0;
  constructor(private readonly s: StreamEvent[][]) {}
  async *stream(_r: ChatRequest) { for (const e of this.s[this.n++] ?? [{ type: "done" } as StreamEvent]) yield e; }
}
/** Daemon-side broker spy: logs what the daemon's GATE receives from its requester. */
class DaemonBrokerSpy extends PermissionBroker {
  readonly log: string[] = [];
  override async request(req: PermissionRequest): Promise<PermissionResponse> {
    const r = await super.request(req);
    this.log.push(`${req.detail} -> ${JSON.stringify(r)}`);
    return r;
  }
}
function setup(script: StreamEvent[][], answer: (m: string, p: unknown) => Promise<unknown>) {
  const exec: string[] = [];
  const env: ExecutionEnvironment = { id: "rec",
    async exec(c) { exec.push(c); return { stdout: "ok", stderr: "", exitCode: 0 }; },
    async readFile() { return ""; }, async writeFile() {} };
  const daemonBroker = new DaemonBrokerSpy();
  const host = new SessionHost({ defaultCwd: "/tmp/x", createAgent: () => ({
    agent: new Agent({ model: new Scripted(script), tools: new ToolRegistry().register(shellTool), env,
      requestPermission: (req) => daemonBroker.request(req) }),
    permissions: daemonBroker }) });
  const [d, c] = createChannelPair();
  const conn = new Connection(d, host);
  const asked: string[] = [];
  const peer = new RpcPeer(c, { onRequest: (m, p) => { asked.push((p as { explanation?: string }).explanation ?? "?"); return answer(m, p); } });
  return { exec, daemonBroker, conn, peer, asked };
}
async function open(peer: RpcPeer) {
  await peer.request("initialize", INIT);
  return ((await peer.request("session/new", {})) as { sessionId: string }).sessionId;
}

// E1: the ONLY approval the daemon makes without asking: a session-remembered grant.
{
  const t = setup([[call("c1", "git status"), { type: "done" }], [call("c2", "git status -s"), { type: "done" }], [{ type: "done" }]],
    async () => ({ outcome: { outcome: "selected", optionId: "allow_always" } }));
  const sid = await open(t.peer);
  await t.peer.request("session/prompt", { sessionId: sid, content: [{ type: "text", text: "go" }] });
  console.log(`E1 remembered grant: client asked=${JSON.stringify(t.asked)} exec=${JSON.stringify(t.exec)} gate-requester-calls=${t.daemonBroker.log.length}`);
}
// E2: the socket dies while a request is pending -> today it becomes a DENY.
{
  const t = setup([[call("c1", "rm -rf build"), { type: "done" }], [{ type: "text", delta: "ok" }, { type: "done" }]],
    () => new Promise(() => {}));
  const sid = await open(t.peer);
  const p = t.peer.request("session/prompt", { sessionId: sid, content: [{ type: "text", text: "go" }] }).catch((e) => e.message);
  await sleep(50);
  t.conn.close();
  await sleep(50);
  console.log(`E2 dead socket: daemon gate got ${JSON.stringify(t.daemonBroker.log)} exec=${JSON.stringify(t.exec)} prompt=${await p}`);
}
// E3: session/cancel while a request is pending -> the gate keeps waiting (no signal on the requester).
{
  let release: (v: unknown) => void = () => {};
  const t = setup([[call("c1", "make deploy"), { type: "done" }], [{ type: "done" }]],
    () => new Promise((r) => { release = r; }));
  const sid = await open(t.peer);
  let settled = "pending";
  const p = t.peer.request("session/prompt", { sessionId: sid, content: [{ type: "text", text: "go" }] })
    .then((r) => { settled = JSON.stringify(r); });
  await sleep(50);
  t.peer.notify("session/cancel", { sessionId: sid });
  await sleep(300);
  console.log(`E3 cancel while pending: 300ms after cancel prompt=${settled} gate-requester-calls=${t.daemonBroker.log.length}`);
  release({ outcome: { outcome: "selected", optionId: "allow_once" } });
  await p;
  console.log(`E3 late approve after cancel: prompt=${settled} gate got ${JSON.stringify(t.daemonBroker.log)} exec=${JSON.stringify(t.exec)}`);
}
process.exit(0);
```

Output:

```
E1 remembered grant: client asked=["git status"] exec=["git status","git status -s"] gate-requester-calls=1
E2 dead socket: daemon gate got ["rm -rf build -> {\"allowed\":false}"] exec=[] prompt=connection closed
E3 cancel while pending: 300ms after cancel prompt=pending gate-requester-calls=0
E3 late approve after cancel: prompt={"stopReason":"cancelled"} gate got ["make deploy -> {\"allowed\":true,\"scope\":\"once\"}"] exec=[]
```

Read: **E1** — the client was asked once; the second command (`git status -s`,
covered by the remembered prefix `git status`) ran without reaching the
requester: the remembered grant is the daemon's only autonomous approval, and
it derives from a client answer. **E2** — a dead socket became
`{allowed:false}` at the gate: the one autonomous deny, removed here. **E3**
— `session/cancel` does not settle a pending request (the requester has no
signal); the turn ends only when someone answers, and `runTool`'s abort
re-check (`agent.ts:502-507`) is what keeps the late approval from running
the tool. With no timeout, E3 would hang forever → Open question 4 / Design §3.

**The assumption holds**, with one qualification the design must keep true:
the daemon's requester must never produce an outcome on its own except
`cancelled` *caused by a cancel/close of the turn* (a person or an explicit
lifecycle action — never a socket event or a clock).

Also verified (bun 1.4.3): `jest.useFakeTimers()` + `jest.advanceTimersByTime(24h)`
from `bun:test` fires a 5 min `setTimeout` (`.tentacle/tmp/permission-events-impl/faketimers.test.ts`,
1 pass), and `createChannelPair` delivers frames with `queueMicrotask`
(`transport/src/channel.ts:40,51,54`), so fake timers do not freeze the
in-memory transport — the "pending for hours" test is cheap and deterministic.

### Preconditions

Interfaces from earlier children are **assumed, not redesigned** (names are
the ones their docs use; the executor adapts to what actually merged and
records drift in Execution):

- From `session-event-stream` (3): `HostedSession.emit(update)` is
  synchronous and assigns the per-session `seq`; the update union carries an
  event **class** (display / mandatory); `turn_start{turnId}` /
  `turn_end{turnId, stopReason}`; `prompt` acks at once; the steering
  no-await window from the final drain to "turn ended" (`agent.ts:265-272`
  comment) is preserved — this child adds nothing to that stretch.
- From `session-registry` (4): `SessionHost` is the registry
  (`open/get/close`); `HostedSession` fans updates out to a **set** of sinks;
  `Connection.close()` **detaches** (no cancel) except for a model-proxy turn;
  `session/close` cancels the turn. `open` returns a result object this child
  extends additively (Open question 3).
- From `session-ttl-limits` (5): the reaper skips sessions whose turn is
  running. **A suspended turn is a running turn** — `running` is
  `controller !== null` (`hosted-session.ts:68-70`) and the controller is
  cleared only when the turn's generator finishes (`:113-115`), which cannot
  happen while `gate.authorize` awaits. So the reaper needs no new check.
- From `daemon-side-persistence` (6) — 7b only: an atomic per-session store
  on `serve` (`save(record)`, `loadAll()`), sessions reloaded detached, the
  steering queue persisted; a restart forces every client to resync (seq/
  `since` epoch handled there).
- From `history-validity-invariant`: a repair step for a trailing assistant
  message whose tool calls lack results. 7b needs one exception (below).

Facts this change relies on, verified:

- Tool calls of one round execute **sequentially** (`agent.ts:303-332`) and
  the assistant message with `toolCalls` is pushed **before** any of them runs
  (`:256-260`); tool results are pushed one by one (`:331`). So while call
  *X* awaits permission, history holds the assistant message, results for the
  calls before *X*, nothing for *X* or after. (Parallel tool calls, if ever
  built, are handled by the pending *table* being a map — Design §2.)
- `tool_start` for *X* is yielded before `runTool(X)` starts
  (`agent.ts:324-334`), and `HostedSession` records `currentToolCallId` on it
  (`hosted-session.ts:101-103`) before pulling the next event — so the
  requester sees the right `toolCallId`. A sub-agent's ask carries its
  parent's `agent_task` call id (same broker, `wiring.ts:124`); acceptable, the
  `title`/`explanation` identify the action.
- Sub-agents build their own `Agent`, hence their own `PermissionGate`
  (`agent/src/subagent.ts:162-170`): their remembered grants last one sub-run.
  Unchanged.
- The peer dispatches inbound requests concurrently (AGENTS §7,
  `transport/peer.ts` `void handleRequest`): a `resolve_permission` is never
  queued behind anything. The handler is synchronous anyway (Design §4).
- `--in-process` (no worker) does not use RPC at all: the TUI's broker *is*
  the agent's broker (`cli/src/main.ts:500-533`). This task does not change
  that path's semantics (Design §6 keeps its `allowAll` default and its
  unmount-deny).
- No CLI flag sets the permission timeout: it exists only as
  `WsServerOptions.permissionTimeoutMs` (`ws-server.ts:28-29`), defaulted at
  `:38`, passed at `:183`, consumed as `ConnectionOptions.permissionTimeoutMs`
  (`connection.ts:38-39,73-75`). `serve.ts:34-42` does not pass it; the stdio
  pod daemon (`serve.ts:96-100`) and the worker (`worker.ts:97-104`) never set
  it. It is also the only consumer of `RpcPeerOptions.requestTimeoutMs` in
  `src/` (the option stays; transport tests use it, `peer.test.ts:158`).

### Design

#### 1. Wire (protocol)

`packages/protocol/src/permission.ts` — keep `PermissionOptionKindSchema`,
`PermissionOptionSchema`, `PermissionOutcomeSchema`; **remove**
`RequestPermissionParamsSchema` / `RequestPermissionResultSchema`; add:

```ts
// session/update variants (both class: mandatory)
PermissionRequestUpdate  = { type: "permission_request", requestId: string(min 1),
                             toolCallId: string(min 1), tool: string, title: string,
                             explanation?: string, suggestion?: { prefix: string },
                             options: PermissionOption[] (min 1) }
PermissionResolvedUpdate = { type: "permission_resolved", requestId: string(min 1),
                             outcome: PermissionOutcome }   // selected{optionId} | cancelled
// command
session/resolve_permission: params { sessionId, requestId, optionId: string(min 1) } (strict)
                            result {}                        (strict)
```

`tool` and `suggestion` are new on the wire so the client rebuilds the same
`PermissionRequest` the daemon's gate built (today it sends `tool: ""` and
drops the suggestion, `remote-client.ts:316-322`, so the TUI labels a
prefix-scoped "always" as "this session", `tui/src/permission-ui.ts:27-29`).
Optional fields are omitted, never `null` (parent point 15).

`methods.ts`: remove `Method.RequestPermission` (`:42,70-73`), add
`Method.ResolvePermission = "session/resolve_permission"`. `updates.ts`: two
union members (`:85-94`). `version.ts`: `PROTOCOL_VERSION` bump (each breaking
child bumps; take current + 1). `transport/src/errors.ts`: add
`PermissionNotPending` (next free code). Regenerate the exported JSON Schema
(child 2's gate).

**Definitions (normative, go into the schema doc comments):**

- **Nonce.** `requestId = crypto.randomUUID()`, generated by the daemon at
  each invocation of the session's requester. It is never derived from
  `toolCallId`, `turnId` or a counter; a re-ask of the same tool call (after a
  cancel and a new turn, or after a restart rebuild in 7b) is a new
  invocation and gets a new id. Clients treat it as an opaque string.
- **First-wins.** For a given `requestId`, the first of {a valid
  `resolve_permission`, a cancel of the turn, a close of the session} to run
  `settle` decides the outcome. `settle` is synchronous end-to-end: look up →
  delete from the pending table → `emit(permission_resolved)` → resolve the
  gate's promise; no `await` in between, so a second attempt in any later
  tick (or later in the same tick) finds no entry. `permission_resolved` is
  emitted **before** the gate continues, so its `seq` precedes every event of
  the tool's execution.
- **`PermissionNotPending`.** Returned by `session/resolve_permission` when
  the session exists but `requestId` is not in its pending table: already
  resolved (answered elsewhere, cancelled, session closed), never issued, or
  issued before a daemon restart. It has no side effect. It is **not** used
  for: unknown session (`UnknownSession`), malformed params or an `optionId`
  that was not offered for that request (`InvalidParams`; the request **stays
  pending** — a bad frame is never a denial). The winning outcome reaches the
  loser through the `permission_resolved` event, not the error.

#### 2. Daemon: the pending table (`HostedSession`)

Replace the constructor's forwarder (`hosted-session.ts:46-52`) and the
`RemotePermission` parameter (`:23,41`) with:

```ts
private readonly pending = new Map<string, PendingPermission>();
// PendingPermission = { update: PermissionRequestUpdate; resolve(r: PermissionResponse): void;
//                      offered: Set<string>; detach(): void }

permissions.setRequester((req) => this.awaitDecision(req));   // still in the constructor, still synchronous

private awaitDecision(req: PermissionRequest): Promise<PermissionResponse> {
  const signal = this.controller?.signal;
  if (!signal || signal.aborted) return Promise.resolve({ allowed: false }); // see below
  const requestId = crypto.randomUUID();
  const update = toPermissionRequestUpdate(requestId, this.currentToolCallId || "pending", req);
  return new Promise((resolve) => {
    const onAbort = () => this.settle(requestId, { outcome: "cancelled" });
    signal.addEventListener("abort", onAbort, { once: true });
    this.pending.set(requestId, { update, resolve, offered: new Set(update.options.map(o => o.optionId)),
                                  detach: () => signal.removeEventListener("abort", onAbort) });
    this.emit(update);              // fanned out to every attached sink; mandatory class
  });
}

resolvePermission(requestId: string, optionId: string): void {   // synchronous
  const entry = this.pending.get(requestId);
  if (!entry) throw new RpcError(DomainErrorCode.PermissionNotPending, `permission request not pending: ${requestId}`);
  if (!entry.offered.has(optionId)) throw new RpcError(JsonRpcErrorCode.InvalidParams, `option not offered: ${optionId}`);
  this.settle(requestId, { outcome: "selected", optionId });
}

private settle(requestId: string, outcome: PermissionOutcome): void {
  const entry = this.pending.get(requestId);
  if (!entry) return;
  this.pending.delete(requestId);
  entry.detach();
  this.emit({ type: "permission_resolved", requestId, outcome });
  entry.resolve(outcomeToResponse(outcome));   // permission-map.ts:42-54, unchanged
}

pendingPermissions(): PermissionRequestUpdate[] { return [...this.pending.values()].map(e => e.update); }
```

- **No timer anywhere.** The only ways out are `resolvePermission` and the
  turn's abort signal (cancel, session close, model-proxy detach — all
  explicit lifecycle actions owned by children 4/5).
- `awaitDecision` with no running turn or an already-aborted turn returns
  `{allowed:false}` without emitting. Unreachable for the first case (the gate
  is only called from `runTool` inside a turn); the second is a cancel that
  landed between `tool_start` and the ask — the tool must not run and nobody
  must be prompted for it (same rule as `agent.ts:304-308`). Neither is a
  novel decision: there is no live turn to approve for.
- `outcomeToResponse` already maps `cancelled` → `{allowed:false}` and an
  unknown `optionId` → deny (`permission-map.ts:42-54`); the `offered` check
  makes the latter unreachable from the wire.
- `toPermissionRequestUpdate` replaces `toRequestPermissionParams`
  (`permission-map.ts:28-40`), adding `requestId`, `tool`, `suggestion`.
- `SessionHost.create` drops the `requestPermission` parameter
  (`session-host.ts:36,41`).

#### 3. Cancel settles the suspension (and the model is told the truth)

Covered by the abort listener above: `session/cancel` →
`HostedSession.cancel()` → `controller.abort()` (`hosted-session.ts:135-137`)
→ `settle(…, cancelled)` → `permission_resolved{cancelled}` → gate gets
`{allowed:false}` → `runTool`. In `runTool` (`agent.ts:495-507`) check
`ctx.signal.aborted` **before** the `!allowed` branch and return
`CANCELLED_TOOL_NOTE`; then the loop top ends the turn `cancelled`
(`agent.ts:198-201`). Result: cancel ends a suspended turn promptly, the
history says "cancelled", never "denied by the user".

#### 4. Daemon: the command (`Connection`)

`onRequest` (`connection.ts:125-138`) gains
`case Method.ResolvePermission: return this.resolvePermission(params)`,
**synchronous** like `enqueue` (`:155-167`): look up the session in the
registry (`UnknownSession` if absent), call `hosted.resolvePermission`, return
`{}`. No requirement that this connection be attached to the session (same
token = same principal, registry doc); an unattached client cannot know a
nonce anyway. Remove `Connection.requestPermission` (`:222-232`), the
`(pp) => this.requestPermission(pp)` argument (`:205`), and the
`permissionTimeoutMs` option and its wiring (`:38-39,71-75`). In `ws-server.ts`
remove `permissionTimeoutMs` (`:28-29`), `DEFAULT_PERMISSION_TIMEOUT_MS`
(`:38`) and its use (`:183`). The `open` result gains `pendingPermissions:
hosted.pendingPermissions()` (Open question 3), computed in the same
synchronous segment as attach (registry's one-tick rule).

After this, the daemon sends **no** request to a `serve` client: the
thin-client profile (parent point 13) — only the model-serving role
(`model/stream*`, pod `run`) still handles inbound requests.

#### 5. Client: a pure permission router

New pure, React-free module `packages/client/src/permission-router.ts`
(AGENTS §7 "logic lives in pure modules"): per session, a reducer over
inputs → actions.

- Inputs: `request(update)`, `resolved(requestId, outcome)`,
  `answered(requestId, response)` (broker returned), `reconcile(pending[])`
  (from `open`), `sendFailed(requestId, error)`.
- State: FIFO `queue` of not-yet-prompted requests, `current` (the one on
  screen, at most one — the TUI has one dialog, `permission-ui.ts:57`),
  `resolved: Set<requestId>` (session lifetime; ids are 36 bytes, a few per
  turn).
- Actions: `prompt(req, requestId)`, `abortPrompt(requestId)`,
  `send(requestId, optionId)`.
- Rules: a `request` whose id is current, queued, or in `resolved` is ignored
  (replay dedupe). `resolved(id)` adds to `resolved`; if `id` is current →
  `abortPrompt`, then prompt the next; if queued → drop it. `answered` with
  `dismissed` → no send, `current = null` (the request stays pending
  daemon-side; it is re-offered by the next `reconcile`/attach); otherwise
  `send(id, responseToOutcome(response).optionId)` (`client/src/permission-map.ts:9-17`).
  `sendFailed` with `PermissionNotPending` → nothing (the event closes it);
  any other error (transport down) → forget `current` so a later `reconcile`
  re-prompts. `reconcile(list)` = `request` for each listed, `resolved`-like
  close for any current/queued id not listed.
- **Display-only rule (pod-trust).** `resolved` never produces `send`, never
  records an approval, never changes how a *future* request is handled. The
  router holds no grant cache at all; "allow always" is only forwarded.

`RemoteClient` (`remote-client.ts:86-103`) routes `permission_request` /
`permission_resolved` updates to the router *before* the per-turn handler
(like `background_exit` today, `:91-98`); executes `prompt` as
`this.permissions.request(req, { signal })` with an `AbortController` per
prompt, `abortPrompt` as `controller.abort()`, `send` as
`peer.request(Method.ResolvePermission, …)`. Remove `onPermission`
(`:315-325`) and the `RequestPermission` branch (`:105-107`). `client/src/mapping.ts`'s
`updateToEvent` maps both new variants to `null` (consumed by the router, not
the TUI's event stream); the exhaustiveness of its switch (`:82-121`) makes
the compiler flag a forgotten variant.

#### 6. Core: three additive broker changes

`packages/core/src/permission.ts`:

- `PermissionRequester = (req, options?: { signal?: AbortSignal }) => Promise<PermissionResponse>`
  and `PermissionBroker.request(req, options?)` passes it through. A
  requester that ignores it behaves as today.
- `PermissionResponse.dismissed?: true` — "no human decision was made" (the
  prompt was torn down). The gate treats it as `allowed:false` (in-process:
  same as today); the router treats it as "send nothing".
- `new PermissionBroker(initial?, { holdUntilSet?: boolean })`: while no
  requester has been set (or after `reset()`), `request()` **queues** instead
  of calling `allowAll`, and the queue drains into the next `setRequester`.
  A queued request whose `signal` aborts is dropped from the queue. Every
  RPC-path client broker is built with it (`cli/src/main.ts:345,415,474`,
  `cli/src/connect.ts:16`); the daemon-side and `--in-process` brokers keep
  today's default.

#### 7. TUI

`packages/tui/src/permission-ui.ts`: the installed requester honours
`options.signal` — on abort, if that request is the one on screen, clear
`pending` and drop the resolver (a dialog closed by `permission_resolved`). On
unmount (`:92-97`) resolve the dangling request with
`{ allowed: false, dismissed: true }` instead of a plain deny: quitting the TUI
is not a decision (with `connect`, the phone can still answer). `App.tsx:617-619`
(Ctrl+C in the dialog): answer `dismissed` then abort, so the turn ends as
*cancelled* rather than racing a deny against the cancel. Esc / `n` stay a
**Deny** — a person pressed it. Auto-accept (Shift+Tab, `permission-ui.ts:83-85`)
is unchanged: it is the client's broker deciding.

#### 8. Docs that ride the branch

`ARCHITECTURE.md:68` (`request_permission` → the event/command pair),
`AGENTS.md:202` (the "don't serialize the peer" example names
`session/request_permission`; replace with `session/resolve_permission` — a
wording fix, not a rule change), `cli/src/main.ts:288-293` comment, the
`daemon/src/connection.ts` and `hosted-session.ts` file headers.

#### Slice 7b — suspension survives a `serve` restart

(Proposed as its own task, Open question 2; depends on 6 and 7a.)

- **Pending record**, persisted with the session record on `serve` only:
  `pendingPermission?: { turnId, toolCallId }`. No request description is
  stored: the rebuild re-asks the gate, which rebuilds it with
  `describeToolCall` (`permission-gate.ts:24-48`) from the persisted tool
  input — so what the user approves after a restart is computed from the same
  bytes that will run.
- **Write protocol** (inside `awaitDecision`, outside the end-of-turn
  steering window, so awaiting is allowed):
  1. register the entry → `await store.save({…history, pendingPermission})`
     → `emit(permission_request)`. Persist-then-emit: every request a user
     can see is durable.
  2. on `settle` with an **approval**: `await store.save({…, pendingPermission:
     undefined})` **before** resolving the gate. Clear-before-run: a crash
     after this point leaves an unresolved call *without* a record →
     repaired as interrupted, never re-asked and re-run (at-most-once).
     `settle` stays synchronous up to `emit(permission_resolved)`; only the
     gate's resolution waits for the write. A deny/cancel clears the record
     without waiting (re-asking a denied call after a crash is harmless).
  3. disk full / write error on step 1 → do not emit; resolve the gate with
     `cancelled` **and** end the turn with `turn_end{error}` (child 3), so the
     client sees why. Not a silent deny: the turn ends, visibly, as an error.
- **Rebuild on reload.** For a reloaded session whose record has
  `pendingPermission` **and** whose history ends with an assistant message
  whose *first* unresolved tool call is `toolCallId`: start the turn
  (`turnId` from the record) through the agent entry
  `Agent.resumeMessages(messages, sessionId, signal, drainSteering)` —
  assumed from child 6 (its load-bearing assumption); if 6 landed without
  it, 7b adds it: run the trailing message's unresolved calls through the
  same per-call body (`agent.ts:303-332`, factored into a helper both entries
  use), then continue the normal loop. The gate asks again → a **new nonce**
  → `permission_request` re-emitted; persisted steering is re-queued (6).
- **history-validity exception, exactly:** skip the repair iff a pending
  record exists and its `toolCallId` is the first unresolved call of the
  trailing assistant message. Any other unresolved call (no record, or a
  record that does not match) is repaired. Client-supplied `open{messages}`
  never carries a record, so a client — or a pod, which persists nothing —
  cannot fabricate a resumable suspension (and even if it could, the resumed
  call still goes through the gate).
- Pods: unchanged — the pod daemon persists nothing (child 6).

### Files

7a, dependency order (protocol → transport/core → agent → daemon → client →
cli → tui), each with its tests:

1. `packages/protocol/src/permission.ts` — new schemas, remove request
   params/result. `updates.ts` — two union members. `methods.ts` — method
   swap. `version.ts` — bump. Exported JSON Schema regenerated (child 2).
   `packages/protocol/test/permission.test.ts` rewritten.
2. `packages/transport/src/errors.ts` — `PermissionNotPending`.
   `packages/transport/test/peer.test.ts` — the generic tests that use
   `session/request_permission` as a sample method (`:24-43,200-215,305-350`)
   switch to `model/stream` (a real daemon→client request) or a neutral
   unknown name; no behaviour change.
3. `packages/core/src/permission.ts` — `signal` option, `dismissed`,
   `holdUntilSet`. New `packages/core/test/permission-broker.test.ts` (or the
   existing core test file, if one covers the broker).
4. `packages/agent/src/agent.ts` — abort-first in `runTool` (`:495-507`).
   Test in `packages/agent/test/permission.test.ts`.
5. `packages/daemon/src/permission-map.ts` — `toPermissionRequestUpdate`.
   `hosted-session.ts` — pending table, `resolvePermission`,
   `pendingPermissions`, no `RemotePermission`. `session-host.ts` — drop the
   parameter. `connection.ts` — the command, remove the forwarder and the
   timeout option, `open` result field. `ws-server.ts` — remove the
   timeout. `packages/daemon/test/integration.test.ts` — port the three
   permission tests (`:118-207`), **delete** "times out and auto-denies"
   (`:209-245`) and replace it with its inverse; port the steering tests'
   `onRequest` permission stubs (`:334,392`) to `resolve_permission`.
6. `packages/client/src/permission-router.ts` (new, pure) + `remote-client.ts`
   + `mapping.ts` + `index.ts` export. `packages/client/test/permission-router.test.ts`
   (new), `remote.test.ts` (`:455-520` port).
7. `packages/cli/src/main.ts`, `connect.ts` — `holdUntilSet` brokers;
   comment at `main.ts:288-293`. `packages/cli/test/pod-runtime.test.ts` —
   the two SpyBroker tests keep their assertions (the ask now travels as an
   event); `SpyBroker.request` gains the `options` pass-through.
8. `packages/tui/src/permission-ui.ts`, `App.tsx` — signal, `dismissed`,
   Ctrl+C. `packages/tui/test/app.test.tsx`.
9. Docs: `ARCHITECTURE.md`, `AGENTS.md:202` example.

7b: `daemon` session record type + store calls (child 6's module),
`hosted-session.ts` (write/clear protocol), the registry's reload path,
`agent/src/agent.ts` (`resumeMessages`, only if 6 did not add it), the
history-validity repair (exception), and their tests.

### Failure modes

| Case | What happens | How state converges |
|---|---|---|
| Socket dies while pending (phone battery, Wi-Fi) | Registry detaches the sink (child 4); nothing settles; no timer exists | Turn stays suspended; any client that opens the session gets the request via `pendingPermissions` (+ replay) and can answer or cancel |
| TUI attached but silent for hours | Nothing — same as above | Same |
| Two clients answer | First `settle` wins; second gets `PermissionNotPending`; both receive `permission_resolved` | Both dialogs close on the event; the loser knows its click did not count |
| Answer races a cancel | Whichever runs `settle` first; the other is `PermissionNotPending` (answer) or a no-op (abort listener already detached) | Deterministic; a cancel that wins → tool not run, turn `cancelled` |
| Late answer for a request of a cancelled/restarted turn, same tool call id | The new request has a new nonce; the old id is not in the table → `PermissionNotPending` | Never binds to the new request |
| `optionId` not offered / malformed params | `InvalidParams`; request stays pending | The client can retry; never a denial |
| Unknown session | `UnknownSession` | Client re-opens / recreates (child 8) |
| Cancel while pending | Abort listener settles `cancelled`; `runTool` returns the cancelled note | Turn ends `cancelled` promptly (fixes E3) |
| Session closed (explicit `close`, daemon-wide limit, admin cap) | `close` cancels the turn → `cancelled` | A lifecycle action, never a socket/clock; the tool does not run |
| Model-proxy client (pod `run` laptop) detaches | Registry cancels that turn (parent point 11) → `cancelled` | Session survives; the laptop is the only client in pod modes anyway |
| Approved from a phone while the pod-`run` laptop is away | Approval settles; the next model round fails (no model) | `turn_end{error}` (child 3) — parent point 8's known limit |
| `permission_request` replayed / listed twice | Router dedupes by `requestId` | One dialog |
| `permission_request` arrives before the TUI installs its requester | `holdUntilSet` queues it | Prompted on mount; never auto-approved |
| TUI quits with a dialog open | `dismissed` → nothing sent | Request stays pending for other clients; local runtimes also `close` the session on exit (child 4), which cancels |
| Hostile pod sends a fake `permission_resolved` | Router closes a dialog, sends nothing, records nothing | Worst case the pod un-shows its own prompt: denial of service on itself; no laptop-side approval can be minted |
| Hostile pod sends a fake `permission_request` | The user is prompted; the answer goes to the pod | "Allow always" is remembered only in the pod's own gate (session-scoped); nothing lasting on the laptop (AGENTS §7 pod-trust) |
| Concurrent asks (future parallel tool calls / sub-agents) | The table is a map; each ask its own nonce | The router serializes dialogs FIFO |
| Version skew v1 ↔ v2 | `VersionMismatch` at `initialize` | Clean failure, no mid-turn decode error |
| 7b: crash between persist and emit | Record durable, nobody saw it | Rebuild re-asks with a new nonce |
| 7b: crash after approval, before the tool result is persisted | Record was cleared before the gate resolved | Repaired as interrupted; never re-run without a new approval |
| 7b: store write fails on suspend | No emit; turn ends `turn_end{error}` | Visible error, not a silent deny |
| 7b: restart drops remembered grants | More prompts after restart | Fail-closed (Open question 9) |

### Tests

Red-before-green: the "red" for every 7a daemon/client test is today's
behaviour (no event / a request; E2's deny; E3's hang); write each test
against the new API, confirm it fails on `main` for the reason stated (or
does not compile because the method/event does not exist — then show the red
with a temporary minimal stub that keeps today's behaviour), then implement.
Use the existing fakes: `harness()` + `ScriptedProvider` + recording `env` in
`daemon/test/integration.test.ts:19-75`, `SpyBroker` / `SpyFakeCluster` in
`cli/test/pod-runtime.test.ts:162-203`, a `DaemonBrokerSpy` (as in the
experiment) to observe what the daemon's gate receives, `ink-testing-library`
in `tui/test/app.test.tsx`. Fake timers: `jest.useFakeTimers()` from
`bun:test` (verified above).

Daemon (`integration.test.ts`, real `Connection` + `SessionHost`):

1. **Ask → event, not request.** An `ask` shell call emits exactly one
   `permission_request` (with `toolCallId: "c1"`, `tool: "shell"`, a
   non-empty `requestId`); the client peer receives **no** inbound request;
   the tool has not run. `resolve_permission{allow_once}` → `{}`,
   `permission_resolved{selected, allow_once}` precedes the tool's
   `tool_call_update`, the tool ran once. Property: the decision travels only
   through the command.
2. **Never auto-denied.** Fake timers; request pending; advance 24 h;
   assert: no `permission_resolved`, `DaemonBrokerSpy.log` empty, tool not
   run, session `running`. Then resolve → the tool runs. Mutation:
   re-introduce a 5 min `setTimeout` that settles `cancelled` (or
   `requestTimeoutMs`) → red.
3. **Dead socket ≠ deny.** Connection A drops mid-suspension (`close()`); B
   opens the session → `pendingPermissions` lists the request; B resolves →
   tool runs once. Red today = E2. Mutation: settle `cancelled` on
   `Connection.close()` → red.
4. **First-wins.** A and B attached; both receive the event; A resolves
   `allow_once`, B resolves `reject_once` → B gets `PermissionNotPending`,
   both get one `permission_resolved{allow_once}`, the tool ran once. Plus a
   unit test on `HostedSession`: two `resolvePermission` calls in the same
   tick → the second throws. Mutations: lookup without `delete` → red; an
   `await` between lookup and delete → the same-tick test red.
5. **Nonce.** Scripted model reuses `c1` in two turns: R1 pending → cancel →
   new turn → R2 pending → `resolve(R1, allow_once)` → `PermissionNotPending`,
   R2 still pending, tool not run. Mutation: `requestId = toolCallId` → red.
6. **Cancel settles.** `session/cancel` while pending → `permission_resolved{cancelled}`
   and `turn_end{cancelled}` without any answer; tool not run; the tool
   message in `snapshot` is `CANCELLED_TOOL_NOTE`, not "Permission denied".
   Red today = E3 (hang) and the "denied" note. Mutation: drop the abort
   listener → hang (test timeout) → red.
7. **Bad answers keep it pending.** `optionId: "reject_always"` (not offered)
   → `InvalidParams`, still pending; unknown `requestId` →
   `PermissionNotPending`; unknown session → `UnknownSession`.
8. **Remembered grant stays daemon-side and shared.** E1 as a test, with B
   attached: `allow_always` from A on `git status`; the next `git status -s`
   emits no `permission_request` to either client and runs. Pins the stated
   consequence ("allow always" on one device holds for all).
9. **No daemon-side broker bypass.** The factory's broker must be the one
   `HostedSession` installs on: an ask emits a `permission_request` and does
   not run before an answer. Mutation: `HostedSession` installs its requester
   on a broker of its own → the agent's gate falls back to the factory
   broker's `allowAll` → the tool runs with no event → red.

Client (`permission-router.test.ts`, pure; `remote.test.ts`, real stack):

10. Router: request → `prompt`; duplicate request (replay) → nothing;
    `resolved` for current → `abortPrompt` + next; answered → `send`;
    answered `dismissed` → nothing; `sendFailed(PermissionNotPending)` →
    nothing; `reconcile` opens listed / closes unlisted.
11. **Display-only (pod-trust).** Fake daemon peer sends
    `permission_resolved{allow_always}` for the prompted request and for an
    unknown id → no `resolve_permission` sent, broker not consulted again;
    a later `permission_request` for the same tool still prompts (spy count
    2). Mutation: let the router cache "allow always" from a resolved event
    and auto-answer → red.
12. **`holdUntilSet`.** A `permission_request` delivered before any
    `setRequester` → nothing sent; after `setRequester` → prompted once.
    Mutation: default `allowAll` → an `allow_once` is sent → red.
13. `remote.test.ts:455` ported: the prompt round-trips through the
    client's broker and the gate gets the mapped scope.

Single broker (`cli/test/pod-runtime.test.ts:310`, `:763`), kept green with
unchanged assertions. **Mutation (mandatory, AGENTS §9):** in
`startPodRuntime` / `startAttachRuntime`, hand `RemoteClient` a `new
PermissionBroker()` instead of `deps.permissions` → both tests red (spy empty,
the turn approves through the second broker's `allowAll` — today's silent
decoupling). Record the red output in Execution.

TUI (`app.test.tsx`): 14. a request aborted via its `signal` removes the
dialog from the frame; 15. unmount with a dialog open resolves
`{allowed:false, dismissed:true}`; 16. Esc still answers a plain deny.

Agent (`agent/test/permission.test.ts`): 17. gate returns `false` with the
signal aborted → tool result is `CANCELLED_TOOL_NOTE`.

7b (its own task): restart mid-suspension (store reloaded into a new
`SessionHost`) → `permission_request` re-emitted with a **different**
`requestId`, the old one → `PermissionNotPending`; approve → the tool runs
exactly once (recording env); crash simulated after approval and before the
result write → reload repairs the call as interrupted, no
`permission_request`, tool count still 1; a record whose `toolCallId` does
not match the first unresolved call → repaired, not resumed; a pod-mode
daemon writes no record. Mutations: emit before persist (crash between) →
the "re-emitted" test still passes but a "request seen ⇒ durable" test
(kill after the event) goes red; clear the record *after* resolving the gate
→ the crash-after-approval test re-asks → red.

Gate before done: `bun run check` (typecheck → lint → test), lint baseline
clean (AGENTS §6).

### Why, item by item

(Decisions not already argued in the Review below.)

- **Why `pendingPermissions` in the `open` result, not only replay.** A
  pending request is *state* that must survive for hours; the ring is a
  bounded *log*. Coupling "can I see the request?" to "has the ring evicted
  it?" makes correctness depend on unrelated traffic. The list is tiny and
  computed in the attach tick, so it is consistent with the replay.
- **Why `resolve_permission` carries only `optionId`, while the event's
  outcome can be `cancelled`.** Cancelling is a turn-level act with its own
  command (`session/cancel`); letting a client "answer cancelled" would add a
  second way to cancel and a way to end one request without ending the turn
  — a semantics nobody asked for. The event reports both because both can
  close a dialog.
- **Why a bad `optionId` keeps the request pending.** Today an unknown
  option maps to deny (`permission-map.ts:51-52`). With suspension, a buggy
  or older client's malformed frame would become a denial the user never
  gave — exactly the class the owner rejected.
- **Why `settle` emits before resolving the gate.** So a client replaying the
  stream always sees "resolved" before the tool's output; the reverse order
  would show a tool running under an open dialog.
- **Why the cancel listener lives on the turn's signal, not on the
  connection.** The connection is no longer the session's owner (child 4);
  the turn is the thing being suspended, and its signal already reaches
  every cancel path (cancel, close, model-proxy detach).
- **Why the agent-loop change for the cancelled note.** The model reads its
  history on the next turn; "denied by the user" after a cancel teaches it
  the user refused an action they never saw refused, and it may avoid or
  re-plan around it.
- **Why `holdUntilSet` in core instead of a flag in `RemoteClient`.** The
  hazard is the broker's `allowAll` default, so the fix belongs where the
  default lives; any future RPC-path consumer (ACP adapter, a headless
  approver) inherits it by constructing the broker that way. The in-process
  and daemon-side brokers keep `allowAll` (the daemon's is always replaced
  in the `HostedSession` constructor; the in-process one is the documented
  headless default).
- **Why `dismissed` instead of "never resolve".** The in-process path shares
  the same TUI hook and needs its gate to return; `dismissed` keeps
  `allowed:false` there (today's behaviour) while letting the RPC path send
  nothing.
- **Why Ctrl+C in the dialog stops sending a deny.** It means "stop
  everything", not "I refuse this command"; sending a deny first would put a
  false "denied" in the stream on every device and race the cancel.
- **Why the client gets `tool` and `suggestion`.** The nonce binds an
  approval to what the user saw; what the user saw must therefore be what
  the daemon will remember. Today an "always" shown as "this session" is
  stored as a narrower prefix — safe, but the label lies.
- **Why 7b persists before emitting and clears before running.** The two
  orders give the two guarantees we need across a crash: every request a
  person saw is still there after a restart, and no approved tool can run
  twice. The writes sit inside the requester, far from the steering
  invariant's end-of-turn window.
- **Why 7b stores no request description.** Re-describing from the
  persisted tool input means the post-restart prompt is computed from the
  exact bytes that will run; a stored description could drift from them
  (a schema change, a bug in a migration).
- **Why split 7b out.** 7a is a wire swap whose risk is the decision path;
  7b is a durability protocol whose risk is crash ordering and the agent
  resume entry. Reviewing them together dilutes the adversarial pass on
  both, and 7b cannot land before child 6 anyway.

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `session-registry` and `daemon-side-persistence`.** Scope:
- `permission_request{requestId, toolCallId, …}` (mandatory event);
  `session/resolve_permission{sessionId, requestId, outcome}`;
  `permission_resolved{requestId, outcome}` fanned out so every client closes
  its dialog.
- `requestId` is a fresh nonce per request, never reused across a
  cancelled/restarted turn.
- First valid answer wins; a late/unknown `requestId` → explicit
  `PermissionNotPending` (never silently dropped).
- **No timeout** (parent point 8, owner decision): a pending request
  *suspends* the turn until a person answers (approve / deny) or a client
  cancels the turn — attached or not. Remove the permission deadline
  (`permission-timeout` option, `ws-server.ts:38`) for this path; a dead socket
  never produces a deny. The TTL reaper skips suspended turns.
- **Suspension survives a daemon restart** (`serve`): from the daemon-persisted
  history, a trailing assistant tool call with no result and a recorded pending
  request → rebuild the suspended turn and re-emit `permission_request`
  (new nonce). Coordinate with `docs/eval/history-validity-invariant.md`:
  "awaiting permission" is a legitimate state, not a dangling call to repair.
- Bumps `PROTOCOL_VERSION`; removes `session/request_permission`; updates the
  exported schema.

**Why, item by item.**

- **Why an event instead of a daemon→client request.** A request is bound to the
  connection that received it: the requester is captured once at session
  creation (`connection.ts:179`, `hosted-session.ts:48`). After a reconnect
  nobody can answer it; today it is coerced to `cancelled` (`connection.ts:208`).
  An event is session state: it is replayed on attach and visible to every
  client.
- **Why `resolve_permission` is a command addressed to the session.** The answer
  must reach the session whatever socket it arrives on; a JSON-RPC response can
  only answer the request on the connection that issued it.
- **Why `permission_resolved` is fanned out.** With multi-attach both the phone
  and the TUI show the dialog. When one answers, the other must close it —
  otherwise the user answers twice, or believes they denied something the other
  device approved.
- **Why a fresh nonce per request.** Scenario: request R1 is pending, the turn is
  cancelled and restarted, and a new request for the same tool reuses the id. A
  late "approve" from the phone, meant for R1 — maybe a *different* command —
  approves R2. A nonce binds every approval to exactly what the user saw.
- **Why first-wins plus an explicit `PermissionNotPending`.** Two devices answer:
  the outcome must be deterministic, and the loser must learn its click did not
  count. A silent drop makes the losing UI lie ("you denied it" while the other
  device approved).
- **Why no timeout.** Owner decision (2026-10-19): a dead socket — a phone with
  a flat battery — must never turn into a denial. It is safe: while suspended,
  the tool does not run. And it is why the 5 min deadline (`ws-server.ts:38`)
  existed that makes it obsolete: a request bound to one connection could hang
  a turn nobody else could unblock; in v2 any attached client can answer or
  cancel, so a waiting turn is suspended, not hung. A synthetic deny is also
  harmful: the model continues blind and piles up further requests.
- **Why the suspension must survive a daemon restart.** A suspension can last
  hours on a host that restarts (an update, a reboot). In memory only, a reboot
  would silently erase the pending approval and the work before it — the exact
  loss the owner rejected.
- **Why coordinate with `history-validity-invariant`.** That eval treats a tool
  call with no result as broken history to repair. Here it is the *expected*
  state of a suspended turn; a repair on resume would delete the call and
  destroy the suspension.
- **Why the single-broker assumption is load-bearing.** Two decision points is
  the bug AGENTS §7 documents: a second broker's default `allowAll` auto-
  approves everything. `resolve_permission` must carry the client broker's
  decision, never create a second decider. Remembered grants staying
  daemon-side is existing behaviour, and it has a good consequence: "allow
  always" on one device holds on every device attached to the session.
- **Why fake `permission_resolved` events are display-only.** In pod modes the
  pod controls the daemon and can write any frame. A client that recorded a
  local approval because of such an event would let the pod mint approvals for
  its own input — forbidden by the pod-trust invariant.

Load-bearing assumption to prove first (restated, review F3): **the daemon
makes no *novel* decision.** Every new approval comes from the client's single
`PermissionBroker` (AGENTS §7) via `resolve_permission`; the daemon decides on
its own only for session-remembered grants already given by that broker
(`permission-gate.ts:70-77`, existing behaviour). There is no fail-safe deny
any more: the fail-safe is *not running* the tool while suspended.
Consequence to state in the design: with multi-attach, an "allow always" given
on one device holds for every device attached to that session.

Invariants to red-team: pod-trust — a pod-originated request must not create a
lasting approval for pod-supplied input ("allow always" stays session-scoped);
a hostile pod could emit fake `permission_resolved` events — the client treats
them as display-only (close a dialog), never as a decision.

Tests: request pending → drop → re-attach → the request is replayed and the
answer is accepted; two clients answer → first wins, second gets
`PermissionNotPending`; a request pending for hours (fake timers) is still
pending and approvable — never auto-denied; daemon restart mid-suspension →
the request is re-emitted and approving it runs the tool exactly once; a late answer after a restarted turn does not bind to the
new request; mutation: route the answer through a second broker → the existing
single-broker spy test fails.
