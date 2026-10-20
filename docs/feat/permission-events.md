# feat/permission-events — permission requests as session state, answered by any attached client

> **Status:** executed + reviewed (one fresh-context Review: REQUEST-CHANGES, findings 1–5 fixed; no second Review by owner's choice) — awaiting owner OK to commit/merge (2026-10-20). Scope: slice 7a only; 7b lives in `docs/eval/suspended-turn-resume.md` (owner decision D)
> **Branch:** `feat/permission-events`
> **Type:** feat · **Size:** L (7a: many small edits across 8 packages) · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (single-broker + pod-trust invariants, AGENTS §7)

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

### Revision for 7a, verified on `main` @ `52ca635` (2026-10-20)

*— claude-opus-5-5, 2026-10-20*

The draft below was written on `4914e9b`, before wire classes, turn events,
the history cut, the registry, TTL/limits and daemon-side persistence Part A
landed. This revision re-verifies it against the code as built. **Where it
disagrees with the draft, this revision wins**; the draft's "Slice 7b"
sub-sections are the source for `docs/eval/suspended-turn-resume.md` and are
not built here.

#### Load-bearing assumption (re-proved)

> **The daemon makes no novel decision.** For an `ask` tool, the only
> daemon-side approval without a client answer is a remembered grant the
> client's broker gave; every other outcome comes from a client, or is
> `cancelled` caused by a turn's cancel/close — never by a socket or a clock.

Today it is false in **three** places (the draft knew one):

- `HostedSession`'s requester (`hosted-session.ts:213-242`, the registry's
  interim routing): **nobody attached → `cancelled` at once** (`:214-217`).
- `Connection.requestPermission` (`connection.ts:290-300`): closed peer /
  timeout / malformed reply → `cancelled`; the timeout is
  `permissionTimeoutMs` (`connection.ts:51-52,96-98`), 5 min on `ws-server`
  (`ws-server.ts:29,227`).
- `session/cancel` does not settle a pending ask (the requester has no
  signal): the turn hangs until someone answers.

Experiment (2026-10-20, bun 1.4.3, `main` @ `52ca635`,
`.tentacle/tmp/permission-events/repro.ts` — real `Agent` + gate +
`SessionHost` + `Connection` + `shellTool`, scripted model, scripted client
`RpcPeer`, `DaemonBrokerSpy` logging what the daemon's gate gets back):

```ts
// (abridged: setup identical to the draft's experiment, ported to session/open + turnId)
// E2: the only client's socket drops while the ask is pending.
a.conn.close();          // → gate gets {allowed:false}
// E2b: the client detaches before the ask is raised (nobody attached).
// E3: session/cancel while pending; 300 ms later; then a late allow_once.
```

```
E2 dead socket: gate got ["rm -rf build -> {\"allowed\":false}"] exec=[] running=false history-tool=["Permission denied by the user: `shell` was not run."]
E2b nobody attached: gate got ["make deploy -> {\"allowed\":false}"] exec=[] history-tool=["Permission denied by the user: `shell` was not run."]
E3 cancel while pending: 300ms later running=true gate-calls=0
E3 late approve: running=false gate got ["make deploy -> {\"allowed\":true,\"scope\":\"once\"}"] exec=[] history-tool=["Cancelled by the user before this tool ran."]
```

E2/E2b: the model's history claims a user denial nobody gave. E3: the turn
hangs on cancel. The remembered-grant exit (draft E1) is unchanged
(`permission-gate.ts:70-72`). So the design must remove both daemon denials
and make cancel settle the ask — exactly the draft's §2/§3.

#### Corrections to the draft

1. **No `pendingPermissions` in the `open` result (draft Open question 3,
   dropped).** The ring never evicts past the pin (`ring.ts:67-74`) and the
   pin is the cut, which moves only at `history_commit`
   (`hosted-session.ts:542-545`; emitted by the agent at `agent.ts:281,343,364`,
   all outside a pending `runTool`) and at `finishTurn`. While an ask is
   pending, the agent is blocked inside `runTool`, so its
   `permission_request` (seq > cut) is pinned and every `attach` that replays
   from the cut (fresh open, resync) or from a `since` before it replays it
   (`hosted-session.ts:348-370`). **Correction (Review finding 2):** a `since`
   at or past the request's seq replays only what came after — so a client
   that re-attaches with `since` must keep the requests it already holds. No
   client re-attaches with `since` today; the obligation is recorded in
   `docs/eval/client-reattach.md` (8a).
   A second source of the same fact would only be a place for the two to
   disagree. Pinned instead by a test (T3 below). Same reasoning for the
   `state: "suspended"` that `client-reattach` Q3(a) deferred here: a suspended
   turn is derivable from the replayed `permission_request` without
   `permission_resolved`; not added.
2. **`resolve_permission` requires an `open` on this connection.** The draft
   allowed any connection; the built `Connection.lookup`
   (`connection.ts:229-239`) is the rule for every session command ("commands
   need an `open` first", identity-checked against the live session). Follow
   it: unknown / not-opened / stale → `UnknownSession`.
3. **The pending persistence of Part A stays and is re-wired, not removed.**
   `HostedSession` already writes `turn.pending` before the ask goes out and
   clears it durably before the gate may run the tool
   (`hosted-session.ts:210-241`; "pending on disk ⇒ never started", relied on
   by `reconcileOnReload`, `persisted-session.ts:269-306`). In the new
   requester: register → `persist()` → `emit(permission_request)`; `settle`
   stays synchronous through `emit(permission_resolved)`, then clears
   `this.pending`, `persist()`s, and resolves the gate only after
   `await this.persisted()` — the same order as today.
4. **Error code lives in `@tentacle/protocol`** (decision D7):
   `DomainErrorCode.PermissionNotPending = -32013` in `protocol/src/jsonrpc.ts`
   (next free after `DaemonRestarted: -32012`).
5. **`PROTOCOL_VERSION` 5 → 6** (`protocol/src/version.ts:7`).
6. **`Attachment` loses `requestPermission`** (`hosted-session.ts:68-71`):
   an attachment is only a sink. The interim routing tests
   (`registry.test.ts:511-552`) are replaced by their event-based inverses.
7. **The signal for the daemon's abort listener is the turn controller's**
   (`hosted-session.ts:139`), and only when the slot holds a turn
   (`!this.compacting`). A sub-agent's ask is covered: its signal derives from
   the parent's (`subagent.ts:178`), and its ask goes through the same broker.
8. **The client router has no `reconcile` input** (there is no list to
   reconcile from, correction 1) and gains `sessionClosed(sessionId)` and
   `connectionClosed()`: on either, abort the on-screen prompt and drop the
   session's (all) queued requests — a dead socket cannot answer, and with
   `client-reattach` the replay re-offers them. Entries are keyed by
   `sessionId` + `requestId` (a hostile pod picks its own ids).
9. **A prompt aborted via its signal resolves `dismissed`**, so no broker
   promise is left dangling; the router ignores an `answered` for an id that is
   not the current one.
10. **Obligations handed here by merged tasks**, now in scope: the dialog is
    withdrawn when its session closes (`session-registry` Review finding 6 —
    `close` aborts the turn → `permission_resolved{cancelled}`); "a suspended,
    detached session is not reaped after TTL + 1 h" (`session-ttl-limits`
    contract, test T18); `PermissionBroker.request(req, {signal})`
    (`client-reattach` Q5).

#### Files (as revised, dependency order)

1. `protocol`: `permission.ts` (new update/command schemas, remove
   request params/result), `updates.ts` (two members + `UPDATE_CLASS`
   mandatory), `methods.ts` (swap), `jsonrpc.ts` (`PermissionNotPending`),
   `version.ts` (6); `schema/protocol.json` regenerated (`bun run
   schema:export`); `test/permission.test.ts`, `test/json-schema.test.ts`.
2. `transport/test/peer.test.ts`: sample method `session/request_permission`
   → `model/stream` (no behaviour change).
3. `core/src/permission.ts`: `signal` option, `dismissed`, `holdUntilSet`;
   new `core/test/permission.test.ts`.
4. `agent/src/agent.ts`: abort-first in `runTool`; `agent/test/permission.test.ts`.
5. `daemon`: `permission-map.ts`, `hosted-session.ts`, `connection.ts`,
   `ws-server.ts`; tests `integration.test.ts`, `registry.test.ts`,
   `persistence.test.ts`, `history-cut.test.ts`, `session-reaper.test.ts`
   (`Attachment` shape; routing tests replaced).
6. `client`: new `permission-router.ts` (pure) + `remote-client.ts` +
   `mapping.ts` + `index.ts`; tests `permission-router.test.ts` (new),
   `remote.test.ts`.
7. `cli`: `main.ts`, `connect.ts` (`holdUntilSet` brokers, comment);
   `test/pod-runtime.test.ts` (`SpyBroker` options pass-through).
8. `tui`: `permission-ui.ts`, `App.tsx`; `test/app.test.tsx`.
9. Docs: `ARCHITECTURE.md`, `AGENTS.md` (the peer example names the method).

The draft's test list stands, with T3 re-aimed (replay, not a list) and T18
added; numbering below follows the draft.

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

*— claude-opus-5-5, 2026-10-20*

Built in the revised plan's order on `feat/permission-events` (off `main` @
`52ca635`), red first per slice. The revision above was written first; there
was no further drift from it except where noted.

1. **Protocol** (v5 → **6**). `permission.ts`: `PermissionRequestUpdate`,
   `PermissionResolvedUpdate`, `session/resolve_permission` params/result
   (strict), `PermissionRequestIdSchema` (1–128 chars); the request
   params/result removed. `updates.ts`: two union members, both `mandatory`.
   `methods.ts`: `RequestPermission` → `ResolvePermission`. `jsonrpc.ts`:
   `PermissionNotPending = -32013`. `schema/protocol.json` regenerated. Tests:
   `permission.test.ts` rewritten (red: exports missing); `json-schema.test.ts`
   fixtures; the "unknown mandatory event" fixtures in `updates.test.ts`,
   `client/mapping.test.ts`, `client/remote.test.ts` used
   `permission_request` as the *unknown* type — now a known tag, so renamed to
   `future_mandatory` (otherwise they would test "malformed known", not
   "unknown").
2. **Transport**: `peer.test.ts`'s sample method → `model/stream` (the peer
   validates params by schema, so the sample had to be a real method).
3. **Core**: `PermissionRequester(req, {signal}?)`, `PermissionResponse.dismissed`,
   `DISMISSED`, `PermissionBroker(initial?, {holdUntilSet})`. Held requests
   drain in order into the next `setRequester`; an aborted held request
   resolves `DISMISSED` and is never handed over; a requester rejection
   propagates. New `core/test/permission.test.ts`: 6/7 red before, 7/7 after.
4. **Agent**: `runTool` checks the abort before `!allowed`
   (`agent.ts:518-531`). Red: `Received: "Permission denied by the user…"`.
5. **Daemon**: `HostedSession` — `Attachment = {send}`, a pending-ask table,
   `awaitDecision` (signal = the turn controller's, never the compaction's),
   `resolvePermission`, `settle` (sync: delete → `permission_resolved` → wake
   the gate); Part A's pending record kept in the same order (capture before
   the emit; durable clear before the gate resumes). `Connection`: the
   `resolve_permission` handler (sync, via `lookup`), forwarder and
   `permissionTimeoutMs` removed; `ws-server`: the 5-min default removed.
   New `daemon/test/permission-events.test.ts` (T1, T1b, T1c, T2, T3, T3b, T4,
   T4b, T5, T6, T6b, T7, T8, T9, T18): **15/15 red on the old daemon** (no
   event / a deny at the gate / reaped after the deny), 15/15 green after.
   Ported: `Attachment` literals in five test files; `integration.test.ts`'s
   harness auto-answers via `resolve_permission` (`answer: "allow_once"`);
   its three old permission tests are deleted — superseded by T1, T1c and T2
   (the timeout test's inverse); `registry.test.ts`'s "interim permission
   routing" block deleted — superseded by T3, T4, T3b; `persistence.test.ts`'s
   client answers through `hosted.resolvePermission`; `mapping.test.ts` samples.
6. **Client**: new pure `permission-router.ts` (+ `toPermissionRequest`);
   `RemoteClient` routes the two events to it before the turn handler,
   executes its actions (prompt with an `AbortController`, abort, send;
   `PermissionNotPending` swallowed, other send errors → `onError`), feeds it
   `session_closed` and `onClose`; `onPermission` removed; `mapping.ts` maps
   both events to `null`. New `permission-router.test.ts` (10) and four
   real-stack tests in `remote.test.ts` (fidelity of the rebuilt request,
   display-only, dismissed-sends-nothing, `holdUntilSet`, losing answer silent
   + `session_closed` withdraws).
7. **CLI**: the three RPC brokers in `main.ts` and the one in `connect.ts` are
   `holdUntilSet`; `runPodTui` comment rewritten; `SpyBroker` passes options.
8. **TUI**: the requester honours `signal` (closes the dialog only if it is
   still that request's, resolves `DISMISSED`); unmount resolves `DISMISSED`;
   Ctrl+C in the dialog answers `DISMISSED` then aborts. Four tests in
   `app.test.tsx`: withdraw, unmount, Ctrl+C red before (3/4); **Esc → plain
   deny is green on both** — it pins unchanged behaviour, not the change.
9. **Docs**: `ARCHITECTURE.md` ADR-004 (the departure from ACP named),
   `AGENTS.md` peer example, `TODO.md` (the 5-min-timeout item marked
   superseded; index 7a), links in `session-reattach.md` and
   `suspended-turn-resume.md`. The historical `docs/architecture/F3/F4` designs
   still say `session/request_permission`; left as records of what shipped then.

**Mutation checks (each reverted, tree restored):**

| Mutation | Red |
|---|---|
| 5-min `setTimeout` settles `cancelled` in `awaitDecision` | T2 |
| `settle` looks up without deleting | T4, T4b, T5, T6 |
| `requestId = currentToolCallId` | T5 |
| no abort listener | T5, T6, T6b |
| option not offered → settle `cancelled` | T7 |
| nobody attached → `{allowed:false}` | T3b |
| requester installed on a broker of its own | all 15 |
| gate resumes before the durable clear (`await persisted()` dropped) | persistence A6 |
| router caches an `allow_always` from `permission_resolved` and answers | client display-only |
| router drops `tool`/`suggestion` | client fidelity |
| client broker without `holdUntilSet` | client holdUntilSet |
| **`RemoteClient` given a second (plain) broker in `createLocalRuntime`** | **both single-broker tests** (`pod-runtime.test.ts`, run + attach: `Expected length: 1, Received length: 0`) |

**Gate:** `bun run check` → tsc clean, `biome check .` clean (293 files),
`bun test` **1094 pass, 2 skip (opt-in live-k8s + slow keepalive), 0 fail**
(4295 expects, 112 files).

**Review fixes (2026-10-20, after the one fresh-context Review below — no
second Review, by the owner's choice):**

1. *Finding 1 (untested guard).* New daemon test **T6c**: a sink cancels the
   turn when the tool call is announced, before the ask — no
   `permission_request`, `turn_end{cancelled}`, tool not run. Green with the
   guard; **red with the `signal.aborted` early return removed** (the turn
   hangs), restored byte-identical.
2. *Finding 2 (false "any `since`" premise).* Revision Correction 1 and the
   `HostedSession` module comment corrected (a `since` at or past the request
   replays only what came after); the obligation recorded in
   `docs/eval/client-reattach.md` (8a must keep pending requests across a
   reconnect, or re-attach without `since`).
3. *Finding 3 (orphaned request).* Ctrl+C in the dialog dismisses only when
   there is a turn of ours to cancel (`App.tsx`); otherwise the dialog stays.
   TUI tests: "no turn → dialog stays, Esc then denies" (**red** with the old
   unconditional dismiss) and "during a turn → `DISMISSED`, tool not run, no
   'Permission denied'".
4. *Finding 4 (silent unsent "No").* The router emits an `unoffered` action;
   `RemoteClient` reports it to `onError`. Router test updated.
5. *Finding 5.* `TODO.md` entry: the ring is unbounded during a long suspension.

Gate after the fixes: `bun run check` → tsc clean, biome clean, **1096 pass,
2 skip (opt-in), 0 fail** (4305 expects, 112 files). One intermittent failure
seen while looping the gate: the GC-based "a connection forgets a session
another client closed" (`session-reaper.test.ts`), **pre-existing** — 1/8 full
runs on `main`, 3/8 on this branch, 0/40 isolated on both. Recorded in `TODO.md`,
not fixed here.

**Known limits, deliberately left:**
- At most one ask is pending per session today (tool calls run in order and a
  sub-agent's ask blocks its parent's call), so the persisted `turn.pending` is
  one record. The ask table is a map; if parallel tool calls land, the record
  must become a list (and 7b's rebuild with it).
- A hostile pod can flood `permission_request`s: each is one dialog, FIFO, and
  every answer goes to the pod — denial of service on itself only.
- The ring pins everything past the cut, so a background-job flood during an
  hours-long suspension grows the ring unboundedly (pre-existing property of
  the pin, not new here).
- 7b (rebuild across a `serve` restart) is not built: a restart still closes a
  suspended turn as "Not run" (Part A).

## Review

*— claude-opus-5-5 (fresh-context reviewer), 2026-10-20*

> The earlier text in this section (2026-10-19) was the eval's promotion
> recommendation. It has been replaced by this review; it is still in git history.

**Verdict: REQUEST-CHANGES (small).** I found no behavioural defect in the 7a
code. The daemon makes no decision of its own any more, the single broker
holds, pod-trust holds, and the gate is green. Two things still block: a
load-bearing guard has no test (§9), and a premise in the Revision is false
and contradicts a sibling plan. Both fixes are small (one test, plus doc
corrections). Everything else is a nit.

### Findings

1. **Medium: a load-bearing guard is untested.** The guard is the
   `signal.aborted` early return in `awaitDecision`
   (`packages/daemon/src/hosted-session.ts:254`). Mutation: `!signal || signal.aborted`
   → `!signal`. The **whole daemon suite still passes (176 pass, 0 fail)**.
   The mutation does real harm, as this probe shows
   (`.tentacle/tmp/permission-events-review/cancel-window.ts`: a sink cancels
   synchronously on the `tool_call` update, which is the "cancel lands between
   `tool_start` and the ask" case the plan names):
   ```
   real code:  running=false events=["turn_start","tool_call","tool_call_update","turn_end"]
   mutated:    running=true  events=["turn_start","tool_call","permission_request"]
   ```
   Without the guard, the ask registers a listener on a signal that has already
   aborted, and that listener never fires. The cancel is already spent, so the
   turn hangs until someone answers a prompt for a turn the user cancelled.
   Requested: a daemon test built like the probe. It should assert no
   `permission_request` and `turn_end{cancelled}`, and it should go red under
   this mutation.
2. **Medium: false premise and a hand-off conflict.** The claim is "every
   `attach` replays it — from any `since`" (Revision, Correction 1; module
   comment `hosted-session.ts:20-24`). That is false for `since ≥` the
   request's seq. `replayFrom` returns only `seq > since.seq`
   (`hosted-session.ts:456-466`, `ring.ts` `since`). Today this is harmless,
   because no client re-attaches with `since` (`remote-client.ts:215`), and a
   fresh client or a resync replays from the cut, which is before the request
   (verified below). But `PermissionRouter.connectionClosed()`
   (`client/src/permission-router.ts:126-133`) **drops** the on-screen and
   queued requests. `docs/eval/client-reattach.md:476-479` assumes the opposite:
   "the original broker promise is still pending because the client object
   survived". If client-reattach re-opens with its last `since`, a pending
   prompt is lost and the turn stays suspended with no dialog. Requested: fix
   the claim to read "from any `since` before the request, and from the cut on
   resync". Then record the obligation in `client-reattach.md`: keep router
   entries across a reconnect, or re-open from before the oldest pending
   request.
3. **Low: a dismissed prompt is not offered again on a live connection.**
   `answered(…, dismissed)` forgets the entry (`permission-router.ts:100-102`), and
   only a new connection replays it. The visible case: Ctrl+C in the dialog
   while `abortRef.current` is null (`tui/src/App.tsx:661-666`) answers
   `DISMISSED` and cancels nothing. The turn stays suspended with no dialog
   until the user quits (exit closes the session, which cancels). This is a
   narrow window; document it, or fall through to the quit path when there is
   no abort handle.
4. **Nit: a "No" can be dropped silently.** If a daemon offers fewer options
   (only a hostile pod would), a "No" with no `reject_once` is not sent
   (`permission-router.ts:104-109`). The dialog closes and the request stays
   pending. This only stalls the pod's own turn, which pod-trust accepts, but
   it is silent: an `onError` line would make it visible.
5. **Nit: the ring can now grow without limit.** With no timeout, the
   "ring grows during a long suspension" limit (Execution, Known limits) is no
   longer capped at 5 minutes. It deserves a `TODO.md` line, not just prose
   here.

### Gate (re-run by me)

`bun run check`: tsc clean; `biome check .`: 293 files, no fixes; `bun test`:
**1094 pass, 2 skip (the opt-in live-k8s and slow keepalive tests), 0 fail**,
4295 expect() calls, 1096 tests in 112 files. This matches the Execution
section exactly.

### Mutation outcomes (each reverted; `cmp` byte-identical; tree checked against a pre-run `git status` + `git diff main` snapshot)

I chose these mutations separately from the executor's table.

| Mutation | Result |
|---|---|
| A `agent.ts`: abort re-check moved back after `!allowed` | red: agent "a refusal that comes from a cancel is recorded as cancelled" |
| B `settle` emits no `permission_resolved` for `cancelled` | red: T6, T6b |
| C no `signal.aborted` early return in `awaitDecision` | **survives (176/176 daemon pass)**, finding 1 |
| D `setRequester` does not drain held requests | red: 3 holdUntilSet core tests |
| E `connectionClosed` keeps the on-screen prompt | red: router "session closed / connection closed" |
| F Ctrl+C in dialog answers a plain deny | red: TUI Ctrl+C test |
| G `resolve_permission` bypasses `lookup` (no open needed) | red: T7 |
| H unmount resolves a plain deny | red: TUI unmount test |
| I `RemoteClient` never feeds `session_closed` to the router | red: remote "session_closed withdraws the dialog" |
| J gate resumes before the durable clear | red: persistence A6 |
| K `createLocalRuntime` gives `RemoteClient` a second broker | red: both pod-runtime single-broker tests (timeouts) |

Mutation K shows that `holdUntilSet` changes what a single-broker violation
looks like: no silent `allowAll` any more, just a request that never shows
(a hang). That fails safe.

### Premise table

| # | Premise (Revision) | Verdict |
|---|---|---|
| 0 | Context symptom on `main` @ 52ca635: dead socket → deny, nobody attached → deny, cancel hangs | **TRUE**. I re-ran `.tentacle/tmp/permission-events/repro.ts` in a `main` worktree and got E2/E2b/E3 exactly as pasted |
| 1 | `hosted-session.ts:213-242` (main) interim requester; `:214-217` nobody attached → cancelled | TRUE |
| 2 | `connection.ts:290-300` (main) closed/timeout/malformed → cancelled; `:51-52,96-98` timeout option | TRUE |
| 3 | `ws-server.ts:29,227` (main) 5-min default | TRUE |
| 4 | Cut moves only at `history_commit` (`hosted-session.ts:542-545` main; agent `:281,343,364` main) and `finishTurn` | TRUE. The only `recordCut` callers are `drive`/`finishTurn`; `historyReplaced` runs only during compaction, which excludes a turn |
| 5 | Sub-agent progress cannot move the cut | TRUE. `progressToEvent` (`agent.ts:103-115`) maps only `subagent_start/tool/end` |
| 6 | Ring never evicts past the pin (`ring.ts:67-74`) | TRUE (`evict` breaks at `seq > pinSeq`) |
| 7 | "every attach replays it — from any `since`" | **FALSE** for `since ≥` request seq (finding 2). True for fresh attach and resync |
| 8 | `Connection.lookup` (`connection.ts:229-239` main) gates session commands | TRUE; `resolve_permission` uses it (mutation G) |
| 9 | Part A order: capture before emit, durable clear before gate resumes (`hosted-session.ts:210-241` main) | TRUE in the new code (`:284-295`); mutation J goes red |
| 10 | `DaemonRestarted = -32012` → `PermissionNotPending = -32013` | TRUE |
| 11 | `PROTOCOL_VERSION` 5 (`version.ts:7`) → 6 | TRUE |
| 12 | `Attachment` had `requestPermission` (`hosted-session.ts:68-71` main) | TRUE |
| 13 | Controller at `hosted-session.ts:139` (main); sub-agent signal from the parent (`subagent.ts:178`) | TRUE. The child runs with `controls?.signal` |
| 14 | Remembered grant is the only autonomous approval (`permission-gate.ts:70-72`) | TRUE |

### Attacks tried

1. **End-to-end, real stack** (`.tentacle/tmp/permission-events-review/e2e.ts`:
   real Agent + gate + SessionHost + two Connections + RemoteClient with one
   `holdUntilSet` broker driven like a TUI + a raw "phone" peer). Output:
   ```
   T1 before mount: prompts=0 exec=[] (held, not auto-approved)
   T1 after mount: prompts=[{"detail":"make one","result":"on-screen"}]
   T1 phone sees replayed pending=1
   T1 phone answers allow_once: ok; again: err -32013
   T1 laptop prompt: {"detail":"make one","result":"withdrawn"} exec=["make one"] gate=["make one -> {\"allowed\":true,\"scope\":\"once\"}"]
   T2 after drop: laptop prompt=withdrawn gate-calls=1 running=true
   T2 phone denies: ok ... history=[…,"Permission denied by the user: `shell` was not run."]
   T3 cancel while pending: tail=["permission_resolved{\"outcome\":\"cancelled\"}","tool_call_update","turn_end"] late answer=err -32013 history-last="Cancelled by the user before this tool ran."
   T4 close while pending: tail=["permission_resolved{\"outcome\":\"cancelled\"}","turn_end","session_closed"]
   ```
   Hold-before-mount, late-attach replay, first-wins, withdraw on the other
   device, no deny on socket drop, cancel and close settling: all hold.
2. **Cancel between `tool_start` and the ask.** The behaviour is correct, but
   nothing tests it (finding 1).
3. **Replay/cut.** I looked for any path that moves the cut while an ask is
   pending: sub-agent progress, background exits, `historyReplaced`, `close`.
   None exists. `close` aborts first, which emits `permission_resolved` and
   only then `finishTurn` moves the cut. The hole is only the `since` case in
   finding 2.
4. **Hostile pod frames.** A fake `permission_resolved` only closes a dialog.
   The router has no grant cache, and mutation I plus the display-only test
   cover it. A fake `permission_request` (even for a session the client never
   opened) prompts the user, and the answer goes back to the pod, so any
   approval lives only in the pod's own gate. Options the pod picks are
   ignored by the TUI, and a missing `reject_once` costs only the pod's own
   turn (finding 4). A flood means FIFO dialogs, which only hurts the pod. I
   found no way to mint an approval on the laptop or to send something the
   user did not choose (auto-accept is the user's own mode).
5. **No-novel-decision sweep.** `rg setRequester|reset()` in `src`: only
   `HostedSession` (constructor, synchronous) and `permission-ui.ts`. Other
   exits from `awaitDecision`: `compacting` (cannot happen: compaction calls
   no tools) and an aborted turn (finding 1). No timer, socket or attach
   count is involved. `permissionTimeout`, `request_permission` and
   `RequestPermission` are gone from all `src`, the schema and the
   ARCHITECTURE/AGENTS docs.
6. **Races.** Two answers in the same tick: T4b, synchronous `settle`. Answer
   after cancel: `-32013` (e2e T3). Cancel during the durable-clear await after
   an approval: the gate resumes, and the agent's abort-first check records
   "cancelled" and does not run the tool. Clients will already have seen
   `permission_resolved{allow_once}`, which is truthful. Model-proxy detach:
   `Connection.close` → `hosted.cancel()` (`connection.ts:104-112`) → the abort
   listener fires.
7. **Invariants not touched.** Steering window: `drive`/`finishTurn` are not
   in the diff. Peer: `transport/src` is not in the diff, and the handler is
   synchronous. In-process path: its broker is still the default (no
   `holdUntilSet`). Ctrl+C and unmount now resolve `DISMISSED`
   (`allowed:false`), which the gate reads as before. The TUI is mounted once
   per process (`tui-sessions.ts:64-92`), so `reset()`-then-hold has no
   remount path today.
8. **Protocol.** The version is bumped. `protocol.json` is regenerated and
   gated (`json-schema.test.ts:39`, "stale" message). Both ends are wired
   (daemon emit + `resolve_permission` handler; client mapping → `null` + the
   router). The old method is fully removed.

### Prior art

`session-registry` finding 6 (dialog withdrawn on close): met (T6b + client
`session_closed` test, mutation I). `session-ttl-limits` "busy for a suspended
turn" contract (`session-ttl-limits.md:130-133`): met (T18; a suspended turn
keeps its controller). The opt-in admin cap can still close a busy detached
session, which is an explicit lifecycle action → `cancelled`.
`client-reattach` Q5 (signal on the broker): met, but see finding 2 for the
conflict with its §"Permissions" assumption. `daemon-side-persistence` Part A
ordering: met (mutation J). Part B stays in `suspended-turn-resume`.

### What holds

The daemon makes no decision of its own. One broker is shared by the runtime
and the TUI, and `holdUntilSet` closes the pre-mount `allowAll` window. Pod
frames cannot mint laptop approvals. Answers are first-wins with a nonce per
ask. Cancel and close settle the ask and tell the model the truth
("cancelled"). Persistence ordering is preserved. The protocol bump is
honest, and the schema is gated.

### How the executor behaved

The executor worked in plan order, recorded red before green per slice, and
ran a broad mutation table, including the important single-broker mutation.
It reported drift honestly (`future_mandatory` fixture renames, the Esc test
being green on both trees) and listed its known limits. Every gate count it
reported reproduced exactly. It missed a test for one guard it designed
itself, and it overstated the replay claim, which carries into a sibling's
contract.

*Reviewer note: I am the same model as the executor (claude-opus-5-5), in a
fresh context only. Shared blind spots can survive both passes; per AGENTS
§10, a load-bearing task would ideally get a different-model review.*
