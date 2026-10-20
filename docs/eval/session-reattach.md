# eval/session-reattach — sessions that outlive their connection (protocol v2 redesign, parent)

> **Status:** eval (Context + Review; Implementation lives in the child tasks once promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval (parent) · **Size:** L overall → split into the children below (no XL) · **Blast:** load-bearing · **Suited:** strong model executes every child; mandatory fresh-context Review per child (protocol, daemon `Connection`, TUI-over-RPC session path, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** what shape should the session ↔ connection model
take so that a client can lose its connection (mobile network, iOS suspending
the app, laptop Wi-Fi) and pick the session back up — from the same or another
device — without losing events, duplicating commands, or approving anything by
accident? And is that shape *better* than today's, not just more robust?

**Why now.** The goal is a React Native app to chat from a phone with a
tentacle running remotely (`tentacle serve`). On mobile, connection drops are
the normal case, not the exception. Tentacle is pre-public, so breaking protocol
changes are allowed when they improve the design (AGENTS §7, protocol rule,
commit `f1f5154`): this is the moment to design protocol v2 instead of bolting
fallbacks onto v1.

### Evidence (source, `main` @ `f1f5154`)

- **Sessions are owned by the connection.** `Connection` holds the session map
  (`packages/daemon/src/connection.ts:54`); `close()` cancels every session's
  turn (`connection.ts:80`), and `ws-server` calls it on socket close
  (`packages/daemon/src/ws-server.ts:193-195`). A second connection cannot see
  another connection's sessions.
- **No re-attach method.** `packages/protocol/src/methods.ts` has
  new/prompt/compact/snapshot (+ enqueue on the in-flight steering branch);
  nothing attaches to an existing session.
- **Groundwork exists but is unused.** `HostedSession` already numbers updates
  (`seq: ++this.seq`, `hosted-session.ts:83`), keeps a replay buffer
  (`MAX_REPLAY = 1024`, `:26`; `replayFrom`, `:78`) and can detach its sink
  (`setSink(null)`, `:73`) — the file header says "for reconnect". No method
  calls `replayFrom`.
- **The replay buffer is turn-scoped and count-bounded**: it is reset at every
  `prompt` (`hosted-session.ts:96`) and capped at 1024 updates. A
  `background_exit` emitted between turns is wiped by the next turn; a long turn
  (one update per streamed text chunk) overflows the cap mid-message.
- **The end of a turn is not in the stream.** `turn_end` maps to `null`
  (`packages/daemon/src/mapping.ts:65,105`); the stop reason travels only as the
  *response* to `session/prompt` (`packages/client/src/remote-client.ts:162`,
  `remote-session.ts:57-58`). That response dies with the socket.
- **Permission requests are bound to the creating connection.** `newSession`
  passes `(pp) => this.requestPermission(pp)` into `host.create`
  (`connection.ts:179`), which `HostedSession` captures once in
  `permissions.setRequester` (`hosted-session.ts:48`). A failure (closed, timed
  out) is coerced to `cancelled` (`connection.ts:208`) — safe, but a reconnected
  client can never answer it.
- **Mid-turn history is committed per round.** The agent loop pushes each
  assistant/tool message into the session's array as the round completes
  (`packages/agent/src/agent.ts:256,331`); `Session.snapshot()` copies that
  array (`packages/agent/src/session.ts:46-47`). So a snapshot taken mid-turn
  holds every completed round — only the round in flight is missing.
- **Limits are per connection.** `maxSessions` is checked per `Connection`
  (`DEFAULT_MAX_SESSIONS = 64`, `ws-server.ts:39`). The permission deadline is
  a flat 5 min (`ws-server.ts:38`).
- Related, not duplicated: `docs/eval/daemon-session-lifecycle.md` (orphaned
  background processes, no `session/close`, duplicate id clobbers a live
  session, `shell_kill` misses grandchildren).

### Repro

`.tentacle/tmp/session-reattach/repro.ts` (gitignored; pasted in full). Real
`Connection` + `SessionHost` + `Agent`; a slow scripted model (20 text chunks,
50 ms apart). Connection A prompts, drops after ~280 ms (calling
`Connection.close()` exactly as `ws-server.ts:195` does), then connection B
tries to pick the session up.

```ts
// Repro: today a hosted session dies with its connection, and there is no way
// to re-attach from a new connection. Same construction as daemon integration tests.
import { Agent } from "@tentacle/agent";
import { type ChatRequest, type ModelProvider, PermissionBroker, type StreamEvent } from "@tentacle/core";
import type { SessionUpdateParams } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../../../packages/daemon/src/connection.ts";
import { SessionHost } from "../../../packages/daemon/src/session-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let chunksProduced = 0;
// A slow model: 20 text chunks, 50 ms apart; honours the abort signal.
const model: ModelProvider = {
  id: "slow",
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    for (let i = 0; i < 20; i++) {
      if (req.signal?.aborted) return;
      await sleep(50);
      chunksProduced++;
      yield { type: "text", delta: `c${i} ` };
    }
    yield { type: "done" };
  },
};
const noopEnv = { id: "noop", exec() { throw new Error("unused"); }, readFile() { throw new Error("unused"); }, writeFile() { throw new Error("unused"); } };
const host = new SessionHost({
  defaultCwd: "/tmp/x",
  createAgent: () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv as never, requestPermission: (r) => permissions.request(r) });
    return { agent, permissions };
  },
});
const INIT = { protocolVersion: 1, clientCapabilities: { streaming: true } };

function connect(label: string) {
  const [d, c] = createChannelPair();
  const conn = new Connection(d, host);
  const updates: SessionUpdateParams[] = [];
  const peer = new RpcPeer(c, { onNotification: (m, p) => { if (m === "session/update") updates.push(p as SessionUpdateParams); } });
  return { label, conn, peer, updates };
}

const a = connect("A");
await a.peer.request("initialize", INIT);
const { sessionId } = (await a.peer.request("session/new", {})) as { sessionId: string };
const prompt = a.peer.request("session/prompt", { sessionId, content: [{ type: "text", text: "hi" }] })
  .then((r) => `resolved ${JSON.stringify(r)}`, (e) => `rejected: ${e.message}`);
await sleep(280);
console.log(`[A] updates before drop: ${a.updates.length}, last seq=${a.updates.at(-1)?.seq}`);
// What ws-server.ts does on socket close: fireClose + Connection.close().
a.conn.close();
console.log(`[A] prompt after drop: ${await prompt}`);
const producedAtDrop = chunksProduced;
await sleep(600);
console.log(`[daemon] chunks produced at drop=${producedAtDrop}, 600ms later=${chunksProduced} (of 20)`);

const b = connect("B");
await b.peer.request("initialize", INIT);
for (const [m, p] of [
  ["session/snapshot", { sessionId }],
  ["session/attach", { sessionId, afterSeq: 0 }],
  ["session/prompt", { sessionId, content: [{ type: "text", text: "again" }] }],
] as const) {
  const r = await b.peer.request(m, p).then((x) => `ok ${JSON.stringify(x)}`, (e) => `error ${e.code}: ${e.message}`);
  console.log(`[B] ${m} -> ${r}`);
}
process.exit(0);
```

Output (2026-10-19, bun 1.4.3; daemon sources identical to `main` @ `f1f5154`
except the uncommitted `fix/steering-over-rpc` changes, which do not touch
session ownership):

```
[A] updates before drop: 5, last seq=5
[A] prompt after drop: rejected: connection closed
[daemon] chunks produced at drop=5, 600ms later=6 (of 20)
[B] session/snapshot -> error -32003: unknown session: 9745e81f-4a09-492e-8c9c-62f41cd85009
[B] session/attach -> error -32601: unknown method: session/attach
[B] session/prompt -> error -32003: unknown session: 9745e81f-4a09-492e-8c9c-62f41cd85009
```

Read: the drop kills the turn (the model stops after one in-flight chunk, 6 of
20); the prompt's outcome is lost (`connection closed`, no stop reason); a new
connection cannot snapshot, attach to, or prompt the session — it is gone.

### Constraints

- AGENTS §7 invariants all hold unchanged except the protocol rule, which now
  allows this breaking change with a `PROTOCOL_VERSION` bump: one session path
  for every runtime; single `PermissionBroker` on the client; the client
  persists history from `snapshot`; the pod is not trusted; never serialize the
  RPC peer.
- The steering invariant (`fix/steering-over-rpc`, comment in
  `packages/agent/src/agent.ts` at the final steering drain): no `await` between
  that drain and the turn being marked ended, or a remote `session/enqueue` can
  be accepted and silently lost. v2 touches that stretch in three children
  (event stream: turn driver rewrite; registry: fan-out; daemon persistence:
  end-of-turn write) — each carries it as an explicit constraint.
- No compat shims for v1 peers (pre-public). A v1/v2 pair fails cleanly with
  `VersionMismatch` at `initialize`.

## Implementation

*(empty — a parent eval; each child carries its own Implementation when promoted)*

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19 (revised after the fresh-context adversarial review below)*

**Verdict: the problem is real (repro above) and the fix is a redesign, not a
patch.** Recommend the protocol-v2 shape below, delivered as the child tasks
listed at the end. The design went through two adversarial passes: an in-session
one, then a fresh-context review by `claude-fable-5-1` (recorded below with what
was accepted). What was rejected, and why, is recorded so it is not re-proposed.

### Target design (protocol v2)

```
commands (ack at once):  open · prompt{turnId} · enqueue{id} · cancel · resolve_permission{requestId}
                         · compact · close · snapshot{cursor?, limit?}
stream (per-session seq, byte-bounded ring, fanned out to every attached client):
  display (ignorable):   message/thought/tool/plan/usage/steer/background_exit
  mandatory:             turn_start{turnId} · turn_end{turnId, stopReason, error?}
                         · permission_request{requestId,…} · permission_resolved{requestId, outcome}
                         · history_replaced{reason:"compact"}
recovery:  open{since} → replay (seq > since), or resync = snapshot{messages, since: S} + replay (seq > S)
           where S is a consistent cut: messages == everything committed up to S
lifecycle: daemon-wide registry · 24 h idle TTL (never while a turn runs or is suspended) · explicit close · global limits
permissions: no timeout — a pending request suspends the turn until a human answers; survives daemon restart (serve)
schema:    zod stays the source of truth; JSON Schema exported per version, checked by the gate
PROTOCOL_VERSION: bumped by each breaking child
```

1. **Sessions belong to the daemon, connections are attachments.**
   `SessionHost` becomes the registry (create / get / close / reap). A
   `Connection` holds only its attachments. Lifecycle and cleanup live in one
   place — which also absorbs most of `daemon-session-lifecycle`.
2. **`session/open {sessionId?, since?, messages?}` replaces `new` + attach.**
   Live → attach (replay or resync). Not live + `messages` → recreate (today's
   `--resume` path). Otherwise `UnknownSession`. A live id is always an attach,
   never an overwrite — the duplicate-id clobber disappears by construction.
   **→ Decided A (2026-10-19):** the replay is delivered as ordinary
   `session/update` notifications sent *inside* the `open` handler, not as a
   field of the response (ordering + 8 MiB frame cap). The client buffers
   updates from the moment it sends `open` and orders by `seq` only.
3. **Commands ack at once; outcomes are stream events.** `prompt` returns
   `{turnId}` immediately; the result is `turn_end{stopReason, error?}`. A
   failing turn says so in the stream (today a model error is a `prompt`
   rejection, invisible to a client that was offline).
4. **Client-generated idempotency keys** on `prompt` (`turnId`) and `enqueue`
   (`id`). The typical mobile case: the command was sent, the link dropped
   before the ack — after re-attach the client re-sends and the daemon dedupes.
   **Dedup must not be count-bounded** (review F8: a phone backgrounded for
   hours retries with a key a count-bounded set already evicted → the turn runs
   twice). Rule: keys are remembered for the session's lifetime as
   `turnId → ack`; it is a small map (one entry per turn), cleared on close.
   Also removes the race where `turn_start` arrives before the `prompt` ack.
5. **Recovery = snapshot at a consistent cut + replay** (review F1). The cut is
   **not** the current seq counter. Streamed chunks of the round in flight
   already carry a seq but are folded into `messages` only when the round
   completes (`agent/src/agent.ts:256,331`); a snapshot taken mid-round with
   `since = counter` would hold neither those chunks (not committed) nor replay
   them (`seq ≤ since`) → a truncated message on resync. Definition: `since` =
   the seq of the **last committed history boundary** (round/turn end), so
   `messages` == everything up to `since` and replay `seq > since` carries the
   whole round in flight. `since` is opaque to clients (Matrix `/sync`
   `since`-token / Kafka-offset shape). The ring is per-session, bounded in
   **bytes**, never reset on turn boundaries. `since` older than the ring, or
   in the future (buggy/hostile client) → `resync: true`.
   **→ Decided D1 (2026-10-19):** `since = {epoch, seq}`. `epoch` changes on
   every session incarnation (re-create under the same id, daemon restart);
   `seq` is comparable only within one `epoch`; a different `epoch` → resync.
   The cut is emitted by the agent loop through a `history_commit` marker (D2).
6. **Compaction is a stream barrier** (review F6). `compact` replaces history
   wholesale (`agent/src/session.ts:95-96`) and is today an out-of-band command;
   a client replaying across it would apply new events over stale history. In
   v2 it emits `history_replaced` (mandatory) and moves the cut; any `since`
   older than the last compaction → `resync`. The only other resync trigger is
   ring eviction.
7. **Permissions are stream state, not a daemon→client request.**
   `permission_request` event + `session/resolve_permission{requestId,
   outcome}`. `requestId` is a fresh nonce per request (never reused across a
   cancelled/restarted turn), so a late answer cannot bind to a different
   request. First valid answer wins; a late/unknown answer is rejected with an
   explicit `PermissionNotPending` so the client closes its dialog — never
   dropped silently. `permission_resolved` tells every attached client.
   **Correction (review F3):** the daemon *does* decide on its own for
   session-remembered grants — `PermissionGate` auto-approves `grantedTools` /
   shell prefixes without asking (`agent/src/permission-gate.ts:70-77`); the
   "allow always" cache is daemon-side, `permission-map.ts:49-50` only maps the
   wire outcome. v2 keeps that; the rule is "the daemon makes no *novel*
   decision" (no fail-safe deny either: see point 8). Consequence (good): with multi-attach,
   an "allow always" given on one device holds for all of them.
8. **No permission timeout: a pending request suspends the turn until a human
   answers** (owner decision, 2026-10-19; supersedes the draft's deadlines and
   review F4's "own deadline"). A dead socket — a phone with a flat battery —
   must never turn into a denial. Waiting is exactly as safe as denying: the
   tool does not run while the request is pending. Today's 5 min deadline
   (`ws-server.ts:38`) exists because a request bound to one connection could
   hang a turn nobody else could unblock; in v2 the pending request is session
   state any attached client can see and answer (approve / deny) or cancel the
   turn, so a waiting turn is *suspended*, not hung. A denial only ever comes
   from a person (Deny) or an explicit cancel. Same rule when a client is
   attached but silent (the TUI left open over lunch).
   - The **suspension survives a daemon restart** on `serve`: the persisted
     history holds the assistant message with the not-yet-executed tool call;
     on restart the daemon rebuilds "turn suspended on permission X" and
     re-emits `permission_request`. Requires daemon-side persistence for
     `serve` (now a v2 child, `docs/eval/daemon-side-persistence.md`), and
     makes "tool call awaiting permission" a **legitimate** history state —
     `docs/eval/history-validity-invariant.md` must not "repair" it.
   - Background jobs keep running while suspended; only a session close stops
     them.
   - Known limit, pod `run` (`--model-proxy`): the wait needs no model, so the
     turn can stay suspended; but after approval the next model round needs the
     laptop — approving from a phone while the laptop is away ends the turn with
     an error.
9. **Multi-attach with fan-out, not "one controller, attach steals".** Every
   attached client gets the stream; any can issue commands; conflicts are
   already resolved daemon-side (`TurnInProgress`, first-answer-wins). Bonus:
   the TUI can watch while the phone answers.
10. **Lifecycle.** A session with **no running turn** and no attached client
    is closed after an **idle TTL of 24 h** (owner decision; configurable on
    `serve`. Why 24 h: on a host you own an idle session costs only memory
    plus the jobs it started; a day covers "I'll pick it up tomorrow" without
    piling up a week of abandoned sessions) — jobs included, which depends on process-group kill (see
    children). A session with a running or **suspended** turn is never reaped
    by the TTL; it ends only by an explicit `close`, a daemon-wide limit, or an
    optional admin cap (configurable, off by default — any default value would
    re-introduce, for someone, the silent loss point 8 rejects). Local runtimes (worker,
    `run`) send `session/close` on exit; the process-exit net stays. Session and
    resource limits become daemon-wide.
11. **Model-proxy sessions cannot run detached.** With `--model-proxy` (pod
    `run`) the model lives on the laptop; a detached turn would stall on the
    first `model/stream`. Rule: if the client serving the model detaches, the
    turn is cancelled as today, the *session* survives for re-attach. A phone
    never serves the model. Detached execution is meaningful only when the model
    is daemon-side (`serve`).
12. **Keepalive is server-side hygiene, not the mobile strategy** (review). A
    backgrounded iOS app is *frozen*: app-level pings do not run. The daemon
    sets `idleTimeout`/`sendPings` explicitly (today unset, `ws-server.ts`) only
    to reap half-open sockets; the mobile client's real model is
    reconnect-on-foreground (+ optional push to wake), owned by the mobile eval.
13. **Thin-client profile, written in the protocol.** With permissions as
    events, a client that does not serve the model handles **no** inbound
    request: it sends `initialize/open/prompt/enqueue/cancel/resolve_permission/
    snapshot/compact/close` and consumes `session/update`. Only the
    model-serving role (laptop in pod mode) also implements `model/stream*`.
    Holds for the TUI over `connect`, an ACP adapter, React Native, Swift.
14. **Event classes: ignorable vs mandatory.** A client MUST ignore an unknown
    *display* event (lets us add them later without a version bump — today an
    unknown discriminant breaks an old client, AGENTS §7 caveat). A new
    *mandatory* event (one a client must act on: turn/permission/history) always
    bumps the version, because silently ignoring a `permission_request` or a
    `turn_end` would be a hang. The class is part of the schema.
    **→ Decided E (2026-10-19):** the class travels in *every frame* (a
    per-frame `mandatory` flag), `seq` is required, and the union has a
    catch-all unknown member — so an unknown display event is skipped while
    its `seq` still counts (today the peer drops it and loses the seq → resync
    loop); a generated Swift decoder must not throw on it.
15. **Wire hygiene.** Optional fields are omitted, never `null`, except where
    `null` carries meaning (`exitCode`, JSON-RPC error `id`). Removes the
    optional/nullable ambiguity that bites every non-TS decoder.
16. **Paged snapshot.** `snapshot{cursor?, limit?}` returns the most recent
    messages first plus a cursor for older ones. A resync on a long session with
    large tool outputs no longer re-transfers the whole history; a phone loads
    the tail and scrolls back on demand.
17. **JSON Schema export.** zod in `@tentacle/protocol` stays the single source
    of truth. The protocol's request/notification maps (`RequestSchemas`,
    `NotificationSchemas`, `protocol/src/methods.ts:60,78`) are exported to a
    committed JSON Schema per version, and the gate fails if it drifts. It
    documents the wire and is the input for a non-TS client (Swift/Kotlin
    codegen) or an external integrator. `zod-to-json-schema` 3.23.5 is already
    a repo dependency (`packages/tools/package.json:13`).
18. **Attachments: shape decided now, built later.** The wire already has
    `image` (inline base64) and `resource` blocks (`protocol/src/content.ts`),
    but the daemon keeps only text and silently drops the rest
    (`daemon/src/mapping.ts:14-19`), history content is a `string`
    (`core/src/model.ts:29`), no provider sends images. Decided for v2: content
    blocks reference an attachment by **content hash** (`attachmentId` =
    sha256) instead of inlining bytes; bytes travel by a separate chunked (chunk size a proposal to calibrate),
    resumable, idempotent upload over the same RPC channel (no side HTTP
    endpoint — pod modes only have the exec stream); history stores references,
    not bytes. Built in the sister eval `docs/eval/attachments.md`. Until then,
    a non-text block must be **rejected explicitly**, not dropped.

### Considered and rejected

- **Resumable transport** (peer buffers unacked frames, resume token, mosh-like).
  Transparent to everything, but it does not survive the app being killed (state
  lost → snapshot needed anyway), cannot attach from another device, and gives
  the daemon no session lifecycle. Session-level recovery is required; a
  transport-level resume may still help `pod attach` later.
- **Single controller, attach steals.** Ping-pong: the evicted client
  auto-reconnects and steals back; TUI and phone flap forever. Multi-attach is
  simpler and strictly more useful.
- **Any permission timeout that ends in a deny** (the short one, or a longer
  "detached" deadline). Safe but wrong for the owner's use case: a flat battery
  is not a decision, and a model that continues after a synthetic deny acts
  blind and piles up more requests. Suspension (point 8) is equally safe.
- **Capability negotiation for v1 peers.** Pointless pre-public; a version bump
  is cleaner.
- **Keeping `prompt` long-lived and adding a parallel `turn_end`.** Two channels
  for one fact; the stream must be the single source of truth for re-attach.
- **`since` = the current seq counter.** Loses the in-flight round on resync
  (point 5, review F1).
- **Count-bounded idempotency memory.** Evicts keys before a late mobile retry
  (point 4, review F8).
- **Inline base64 attachments in `prompt`.** Blocks the single socket, not
  resumable, hits the 8 MiB frame cap (`ws-server.ts:40`), bloats history and
  every snapshot (point 18).

### The property the tests must prove (AGENTS §2, §9) — revised (review F2)

The first draft ("for every drop point *k*, reconstructed transcript ==
uninterrupted transcript", driven by a reconnecting client) was **vacuous for
the snapshot cut**: a client that keeps `since = k` only ever replays and never
consumes a snapshot, so breaking the cut would not fail it. The property is:

> For every drop point *k* **and both recovery paths** — (a) re-attach with the
> client's own `since`, (b) a fresh client, or a forced `resync`, opening
> mid-round — the **ordered event sequence the client reducer produces**
> (including the partial in-flight message at the observation point) equals the
> uninterrupted one, and the applied seqs are contiguous (no gap, no duplicate).

Non-vacuity by mutation: it must fail with `since` = the raw counter (F1), with
the ring reset at turn start, without the `history_replaced` barrier (a drop
around a `compact`), and with seq dedupe disabled. Comparing only the final
committed messages is not enough: it passes a run that drops mid-round chunks.

**→ Decided C (2026-10-19):** the comparison is on a **projected transcript**
(the reducer output minus what history does not keep: thoughts, usage,
cancelled partial text), because after a resync those are legitimately absent;
the literal "equals the uninterrupted one" cannot hold. The steering window
already has a test (`daemon/test/integration.test.ts:424-472`).

### Adversarial review — `claude-fable-5-1`, fresh context, 2026-10-19

Verdict: *approve with changes*. All `file:line` evidence verified true; repro
genuine (error codes match `transport/errors.ts:13`, `jsonrpc.ts:19`,
`peer.ts:303`); no rejected alternative should be revived. Findings, all
**accepted**:

| # | Finding | Resolution |
|---|---|---|
| F1 | snapshot@seq is not a consistent cut mid-round | point 5: cut = last committed boundary |
| F2 | test property vacuous for the snapshot path | revised property above |
| F3 | permission-events assumption false: daemon auto-approves remembered grants; citation mislocated | point 7 corrected; child restated |
| F4 | detached permission wait unbounded (reaper skips running turns) | resolved differently by owner decision: the unbounded wait is the *intended* behaviour, made explicit as a suspension (point 8) that survives restarts; the reaper skipping it is correct |
| F5 | child order leaves `main` broken: detach-on-close lands before `turn_end` is in the stream | children reordered: event stream before registry |
| F6 | compaction not in the stream → silent divergence on replay | point 6: `history_replaced` barrier |
| F7 | registry child is L, not M | split into `session-registry` + `session-ttl-limits` |
| F8 | count-bounded idempotency evicts keys before a mobile retry | point 4: lifetime map |

Improvements adopted from the review: opaque `since` cut token (Matrix/Kafka
shape), compaction as an event, per-request permission nonce, keepalive
reframed for iOS (point 12).

### Owner decisions after the children's Implementation drafts — 2026-10-19

The eight children got source-verified Implementation drafts (one agent each,
`claude-opus-5-5`). Where they converge on a correction to this parent, or
raise an owner question, the decision is recorded here and **wins over any
child text or point above that disagrees**. Children's "Open questions"
sections are resolved by this list.

Convergent corrections (two or more children independently):

- **A — replay as notifications inside `open`** (registry, client-reattach). See point 2.
- **B — `turn_start{turnId, prompt}`** carries the prompt text: today the user prompt never appears in the stream (event-stream, client-reattach).
- **C — projected-transcript property** (event-stream, client-reattach). See the property section.
- **D — restart rebuild of a suspended turn is its own task** after `permission-events`: `docs/eval/suspended-turn-resume.md` (persistence Part B + permission slice 7b). Until it lands, a turn suspended across a restart is closed honestly as "not executed", never as a denial nobody gave.
- **E — per-frame class + required `seq` + catch-all** (event-stream, client-reattach, schema-export). See point 14.
- **F — `closeOnBackpressureLimit`** in `session-registry` (Bun drops frames silently on a non-reading client and keeps the socket open).
- **G — limits only refuse new work, never close** an existing session (ttl-limits). Point 10's "ends by … a daemon-wide limit" is superseded.
- Connection state in the TUI is rendered by Ink in `StatusBar`, **not** `StatusLine` (AGENTS §7: `StatusLine` is finished before Ink mounts).

Owner decisions:

1. **D1 — `since = {epoch, seq}`** (see point 5).
2. **D2 — `history_commit` marker** emitted by the agent loop; the cut is the last commit, so the ring never has to hold an unbounded turn.
3. **D3 — `/clear` closes the old session, including its jobs**, on every runtime; the in-process path gets one `BackgroundJobs` per session so both paths behave the same (aligns `session-registry` with `background-process-groups`).
4. **D4 — sub-agent permission across a restart is not resumable**: accepted exception; the sub-agent gets an explicit "interrupted" result, never a denial.
5. **D5 — "allow always" grants are lost on restart**: accepted (you get asked again, never less). Persisting them is a later task.
6. **D6 — detached-session cap reached → refuse the new session** + audit log line; never evict the oldest.
7. **D7 — schema: `oneOf` + `discriminator`, reference codegen `swift-openapi-generator`** (not quicktype); `DomainErrorCode` moves into `@tentacle/protocol`.
8. **D8 — new prerequisites:** `docs/fix/daemon-compact-turn-guard.md` before event-stream 3c; `docs/eval/session-store-durability.md` before `daemon-side-persistence`.
9. **D9 — `pod-attach-resilience`:** Layer 2 (reconnect) is absorbed by `client-reattach-frontends`; Layer 1 shrinks to an S WebSocket ping in `exec-channel.ts` (Bun's client has `ping()`).
10. **D10 — attachments:** adopt the agent's recommendations (text placeholder when bytes are missing, only the last K images in full, images before text); detail numbers are decided when the first sub-task is promoted.

Splits adopted: event-stream → 3a/3b/3c (one doc, three branches, in order);
permission-events → 7a here + 7b into `suspended-turn-resume`;
daemon-side-persistence → Part A here + Part B into `suspended-turn-resume`;
client-reattach → 8a + `client-reattach-frontends` (8b); attachments → 4
sub-tasks (one doc, four branches). Per-child adversarial review is deferred
to promotion time (each child gets its mandatory fresh-context Review then).

### Children (dependency order; one code task at a time, AGENTS §10)

| # | Task | Size · Blast | Depends on |
|---|---|---|---|
| 1 | `docs/fix/background-process-groups.md` — group kill + process-exit net + dispose on connection close (promoted, in execution) | S–M · load-bearing | — |
| 2 | `docs/feat/protocol-schema-export.md` — JSON Schema export (`oneOf` + discriminator), drift gate, `DomainErrorCode` into protocol | S–M · cross-module | — |
| 2b | `docs/fix/daemon-compact-turn-guard.md` — prerequisite of 3c (D8) | see doc | — |
| 3a | `docs/eval/session-event-stream.md` §3a — event classes per frame, unknown-event tolerance, wire hygiene, non-text reject | S · load-bearing | 2 |
| 3b | same doc §3b — `turn_start{prompt}`/`turn_end`, prompt ack, idempotency, turn driver | M · load-bearing | 3a |
| 3c | same doc §3c — ring, `history_commit` cut, `history_replaced` barrier, paged snapshot | M · load-bearing | 3b, 2b |
| 4 | `docs/eval/session-registry.md` — registry, `open{since}` (replay as notifications), `close`, detach-on-close, fan-out, backpressure close, model-proxy rule | M (near L) · load-bearing | 1, 3c |
| 5 | `docs/feat/session-ttl-limits.md` — 24 h reaper, daemon-wide limits (refuse only), server keepalive | M · load-bearing | 4 |
| 5b | `docs/eval/session-store-durability.md` — prerequisite of 6 (D8) | see doc | — |
| 6 | `docs/eval/daemon-side-persistence.md` Part A — `serve` persists history; a turn suspended at restart is closed "not executed" | M · load-bearing | 4, 5b |
| 7a | `docs/eval/permission-events.md` (live slice) — permissions as events, nonce, first-wins, no timeout, cancel settles | L · load-bearing | 4 |
| 7b | `docs/eval/suspended-turn-resume.md` — rebuild a suspended turn after a `serve` restart | M · load-bearing | 6, 7a |
| 8a | `docs/eval/client-reattach.md` — `RemoteClient` reconnect, pure reducer, the property test | M · load-bearing | 3c, 4, 7a |
| 8b | `docs/eval/client-reattach-frontends.md` — connect/attach/run wiring, `StatusBar`, pod-attach Layer 2 | M · load-bearing | 8a |
| — | `docs/eval/attachments.md` (sister) — 4 sub-tasks; the first is independent | 4 × S–M · load-bearing | 3a (sub-tasks 2–4) |
| — | `docs/feat/pod-attach-resilience.md` Layer 1 — WS ping (D9) | S · contained | — |
| — | mobile app (React Native or Swift) — own eval | — | 8b |

Ordering rationale (F5): `turn_end` in the stream (3) lands before
detach-on-close (4), so `main` is never in a state where a turn survives the
socket but its outcome is unobservable. Each breaking child bumps
`PROTOCOL_VERSION` (free pre-public, AGENTS §7).

Separate question this redesign surfaces, not in its scope: per-device tokens with revocation (a single bearer
token with full daemon access on a losable phone) — to decide before shipping
the app. The ACP adapter (`docs/eval/acp-adapter.md`) is a frontend over
`createLocalRuntime` with no wire change, so it is unaffected, but the v2 wire
moves further from ACP's shape: note it there when that eval resumes.

**How the models behaved:** the first in-conversation draft had three errors
the in-session adversarial pass caught (turn-scoped replay, "attach steals",
auto-deny while detached) and one overstated rationale (a long-lived `prompt`
is *not* why the peer dispatches concurrently; `model/stream` and permissions
need it too). The first written draft of this doc still carried F1–F8; the
fresh-context review found them, every one verified against the code by the
integrating model (F3 re-checked at `permission-gate.ts:66-100`). A
self-review would likely have missed F1, F2 and F5 — the case for mandatory
fresh-context Review on load-bearing work.
