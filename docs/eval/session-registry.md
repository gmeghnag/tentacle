# eval/session-registry — daemon-owned sessions, `session/open` / `close`, detach, fan-out

> **Status:** implementation drafted — awaiting owner approval (2026-10-19)
> **Branch:** none until promoted (then `feat/session-registry`)
> **Type:** eval → feat · **Size:** M (upper bound, near L: four packages + protocol bump + new daemon test file; a clean M if open questions 3 and 8 are rejected) · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (daemon `Connection`, one-session-path invariant, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** move session ownership from `Connection` to a
daemon-wide registry in `SessionHost`, so a session outlives its connection and
any authenticated connection can attach to it.

Evidence and repro: parent `docs/eval/session-reattach.md`. The session map
lives on `Connection` (`daemon/src/connection.ts:54`); `close()` cancels every
turn (`:80`); `ws-server.ts:193-195` calls it on socket close. Absorbs part of
task 2 of `docs/eval/daemon-session-lifecycle.md` (no `session/close`,
duplicate id clobbers a live session, jobs never torn down); the TTL reaper,
limits and keepalive are split into `docs/eval/session-ttl-limits.md` (review
F7: together they were L).

## Implementation

> **Owner decisions (2026-10-19):** the open questions below are resolved in
> the parent, `docs/eval/session-reattach.md` §"Owner decisions after the
> children's Implementation drafts" (A–G, D1–D10). Where a question or
> design point here disagrees, the parent decision wins.


*— claude-opus-5-5, 2026-10-19 (draft, awaiting owner approval)*

Verified against `main` @ `4914e9b` (steering merged; line numbers below are
current — the Context's `connection.ts:54,80` are now `:56` (session map) and
`:82` (`close()`)). Experiments ran in `.tentacle/tmp/session-registry-impl/`
(gitignored; scripts and output pasted below), bun 1.4.3, macOS.

### Open questions / contradictions

Not silently resolved; each has a recommendation. The Design below follows the
recommendations — the owner strikes what they reject.

1. **Replay delivery: response field vs notifications (contradicts parent
   point 2 / Review "attach + `{replay}`").** If `open` returns the replay *in
   its response*, a live update can reach the client **before** that response:
   `RpcPeer.handleRequest` awaits the handler and only then writes the response
   (`transport/src/peer.ts:316-320`), so an emission already queued in the
   agent's microtask chain slips in between (E2 below: 24/60 placements on the
   in-memory pair; 0/60 on a `MessagePort`, i.e. it depends on the transport's
   delivery timing). The client would have to merge two sources by seq. Also, a
   replay of a byte ring in one frame can exceed the 8 MiB frame cap
   (`ws-server.ts:40`). **Recommendation:** the replay travels as ordinary
   `session/update` notifications, sent synchronously inside the `open`
   handler before the attachment joins the fan-out set; the response carries
   only `{sessionId, incarnation, created, resync}`. The wire order of updates
   is then the true order on every transport, and each update is its own frame.
   Client contract (documented in the schema, consumed by `client-reattach`):
   updates for a session may arrive before the `open` response; a client
   routes/buffers them from the moment it sends `open`.
2. **Hole: a `since` from a previous incarnation of the same id.** A session
   closed (or lost in a daemon restart) and recreated under the same id restarts
   `seq` at 1. A client holding `since = 500` from the old incarnation is
   "covered" as soon as the new one passes seq 500 and would get a silent,
   wrong replay; below 500 it is caught only by the "since in the future →
   resync" rule of `session-event-stream`. **Recommendation:** each
   `HostedSession` gets an `incarnation` (random UUID at creation), returned by
   `open`; `open{since}` is honoured only together with a matching
   `incarnation`, otherwise → `resync`. Cheap, and it removes the ambiguity
   instead of relying on numeric luck. (Related, for the owner of
   `session-event-stream` / `client-reattach`: event-stream calls `since`
   *opaque*, while client-reattach's reducer *compares* `seq` against it — the
   two docs should agree; this child only needs "a number the daemon can
   compare with `seq`" plus the incarnation.)
3. **Hole: other attached clients never learn of a `close`.** `session/close`
   from the laptop detaches the phone's sink silently; the phone shows a live
   session until its next command fails with `UnknownSession`, and
   `client-reattach` then recreates it from `messages` — resurrecting what the
   user just closed. **Recommendation:** `HostedSession.close()` emits a final
   **mandatory** `session_closed{reason: "closed"}` update to every attached
   sink before detaching them (`session-ttl-limits` adds `reason: "expired"`).
   It is one union member + its reverse mapping (AGENTS §7 protocol rule); this
   child bumps the version anyway. (A client that was *offline* at close time
   will still recreate from `messages` on its next `open` — acceptable: close
   frees daemon resources, it does not delete the user's local history.)
4. **`/clear` — close the previous session or not?** `background-process-groups`
   lists "`/clear` leaves the previous session's jobs running" as a residual
   "closed by `session/close` in `session-registry`". But the in-process path
   builds one agent (one `BackgroundJobs`) for all sessions
   (`cli/src/main.ts:503-524`), so there `/clear` keeps the jobs; closing on
   `/clear` over RPC would make the worker kill a dev server that the
   in-process path keeps — two behaviours for one action (AGENTS §7, one
   session path). **Recommendation:** do **not** close on `/clear` in this
   child; a client closes **every session it opened** at exit
   (`RemoteClient.closeSessions()`). The `/clear`-kills-jobs question is a
   product decision; if wanted, it should change both paths together.
5. **The model-proxy rule is not observable today.** `--model-proxy` exists only
   on the stdio daemon (`cli/src/serve.ts:57,70`), which resolves on stdin EOF
   (`serve.ts:106-119`) and then the process exits (`main.ts:194-197` →
   `main.ts:573` `process.exit`). So in every current topology the session dies
   with the process right after the detach; "the session survives for
   re-attach" (parent point 11) has no reachable consumer. **Recommendation:**
   implement it anyway as a 5-line `ConnectionOptions.servesModel` (cancel the
   turns of every session attached through that connection on detach; the
   sessions stay registered) plus one daemon test — it keeps the rule true the
   day a model-serving connection can detach from a longer-lived daemon, and it
   costs nothing. Alternative: drop it from this child and from the parent.
6. **Interim leak until `session-ttl-limits`.** After this child, a `connect`
   session whose socket *drops* (not an orderly exit) lives on `serve` forever,
   with its jobs; and the per-connection `maxSessions` (`ws-server.ts:39`) no
   longer bounds the daemon (each reconnect is a new connection).
   **Recommendation:** promote `session-ttl-limits` immediately after; do not
   cut a release between the two.
7. **Interim permission routing (until `permission-events`).** Today the
   requester is bound once to the creating connection
   (`connection.ts:205`, `hosted-session.ts:48`); after a detach it points at a
   closed peer (→ `peer is closed`, `peer.ts:134-135` → coerced to `cancelled`,
   `connection.ts:228-231`), even if another client is attached. The parent
   does not specify the interim. **Recommendation:** route each request to the
   **most recently attached** live attachment at request time; none attached →
   `cancelled` at once (today's fail-safe). The 5-min deadline
   (`ws-server.ts:38`) stays until `permission-events` removes it.
8. **Slow-sink drop: here or in `session-ttl-limits`?** E3 below: Bun's
   `ServerWebSocket` never blocks `send` (max 0.53 ms), but past
   `backpressureLimit` (default 16 MB) it **silently drops** frames (status
   `0`) and keeps the socket open — `WsChannel.send` ignores the status
   (`ws-server.ts:102-106`). That is a silent gap in the stream (exists today;
   fan-out to a frozen phone makes it likely). With `closeOnBackpressureLimit:
   true` the server closes the socket instead → detach → the client resyncs.
   **Recommendation:** set it here (one line in `ws-server.ts`'s `websocket`
   block, with an overridable `backpressureLimit`); it *is* the parent's "a sink
   that cannot keep up is dropped". `session-ttl-limits` edits the same block
   (keepalive) — coordinate, no conflict.
9. **Commands require an attachment on the issuing connection.** Parent is
   silent. **Recommendation:** `prompt`/`enqueue`/`compact`/`snapshot`/`cancel`
   act only on a session this connection has opened (else `UnknownSession`,
   message "session not open on this connection"); `close` acts on the registry
   directly (no attach needed, idempotent). Otherwise a client could drive a
   session whose stream it does not receive.
10. **Constraint for `daemon-side-persistence`.** The duplicate-open guarantee
    below rests on `SessionHost` creating synchronously. If child 6 makes
    creation async (load from disk), it must reserve the id in the registry
    *before* its first `await` (an in-flight entry that later opens attach to),
    or two concurrent `open`s build two agents again.
11. **New param `create` on `open` (not in the parent).** The parent's rule
    "absent + `messages` → recreate; else `UnknownSession`" breaks today's
    fresh-session-with-client-uid open (`local-runtime.ts:127-129`, no
    messages). **Recommendation:** an explicit `create: true` (see Design §1
    and "Why").
12. **Size.** Four packages + a protocol bump + a new daemon test file: upper
    **M**, close to L. Kept as one task (splitting detach from fan-out would
    land a detach nobody can re-attach to); if the owner rejects points 3 and 8
    it is a clean M.

### Load-bearing assumption

Two, both proven.

**(1) Nothing outside `Connection` relies on "a session dies with its
connection."** Every caller of `Connection.close()` and of session creation:

| Site | What happens today | Relies on session-dies-with-connection? |
|---|---|---|
| `ws-server.ts:193-195` (socket close) | `fireClose()` then `Connection.close()` → cancels every turn (`connection.ts:82-87`) | Only to *stop* work. That is the behaviour this child changes on purpose; the explicit stop moves to `session/close` (sent by `connect` on exit, below). |
| `cli/src/serve.ts:106-119` (stdio pod daemon, `run` and `attach`) | stdin EOF → `finish()` → `connection.close()` → resolve → `main.ts:194-197` returns 0 → `main.ts:573` `process.exit` | No: the session's lifetime is bounded by the **process**, which exits immediately; jobs are killed by `background-process-groups`' exit net. Each `attach` execs a fresh daemon (`pod-runtime.ts:449`), so no registry survives across attaches. |
| `cli/src/worker.ts:97-104` (worker daemon) | The `Connection` is never closed; `dispose()` → `worker.terminate()` (`local-runtime.ts:143-146,215`) | No: lifetime = worker thread (exit handlers fire on terminate, per `background-process-groups`' experiment). |
| in-process TUI (`main.ts:503-541`) | No `Connection` at all | N/A. |
| `cli/src/connect.ts:21-32` | `client.close()` on exit → server socket close → turns cancelled | **Yes, implicitly**: quitting `connect` mid-turn stops the agent. Preserved by sending `session/close` for every opened session before `client.close()` (Design §6). |
| session creation: `RemoteClient.openSession` (`client/src/remote-client.ts:140-151`), only caller `RemoteSession.send` (`remote-session.ts:59-67`) | `session/new {cwd?, messages?, sessionId?}` | — |
| `--resume`: `local-runtime.ts:123-129` passes `record.id` + `record.messages` | Daemon is always fresh (worker / stdio process), so the id is never live → today `create`; after: `open` → absent + `messages` → recreate. Same outcome. `connect` passes no id (`connect.ts:28`). | No. |
| tests | `remote.test.ts:157,206`, `local-runtime.test.ts:86` close the connection *after* the turn ended; no test asserts cancel-on-close (grep of `close()` near `cancel` in `packages/*/test`: only transport `$/cancelRequest` tests). | No. |

`Connection.requestModelStream*` (`connection.ts:94-116`) is bound by
`serve.ts:101-105` to the one stdio connection — unaffected (see open
question 5).

**(2) Attach — compute replay + add sink — is gap-free iff it is one
synchronous segment.** `emit` is synchronous today (`hosted-session.ts:82-89`:
seq, buffer push, sink call, no `await`), every `DuplexChannel.send` is
`void`/synchronous (`transport/src/channel.ts:11`; ws `ws-server.ts:102`, port
`port-channel.ts:50`, stdio `stream-channel.ts:60-62`), and JavaScript runs one
segment at a time, so nothing can emit between two statements with no `await`
between them. Experiment E1 shows the property and that even microtask
`await`s break it:

```ts
// attach-tick.ts — E1. Real HostedSession + Session + Agent; the model yields 40
// chunks with no timers (the whole turn is a microtask chain, the worst case).
// Sink A sees the start and is detached at seq 5; B "attaches" later from a
// microtask: replay = replayFrom(lastSeenByA), then setSink(B). Variants put
// nothing / 20 microtasks / one macrotask between the two steps.
import { Agent, Session } from "@tentacle/agent";
import { type ChatRequest, type ModelProvider, PermissionBroker, type StreamEvent } from "@tentacle/core";
import type { SessionUpdateParams } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { HostedSession } from "../../../packages/daemon/src/hosted-session.ts";

const model: ModelProvider = {
  id: "fast",
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    for (let i = 0; i < 40; i++) yield { type: "text", delta: `c${i} ` };
    yield { type: "done" };
  },
};
const noopEnv = { id: "noop", exec() { throw new Error("x"); }, readFile() { throw new Error("x"); }, writeFile() { throw new Error("x"); } };

async function run(variant: "sync" | "await-microtask" | "await-macrotask") {
  const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv as never });
  const hosted = new HostedSession("s", new Session(agent), new PermissionBroker(), async () => ({ outcome: "cancelled" }) as never);
  const seen: number[] = [];
  let lastA = 0;
  hosted.setSink((p: SessionUpdateParams) => {
    seen.push(p.seq ?? -1); lastA = p.seq ?? 0;
    if (lastA === 5) {
      hosted.setSink(null); // A drops
      queueMicrotask(async () => {   // B attaches while the turn keeps emitting
        const replay = hosted.replayFrom(lastA);
        if (variant === "await-microtask") for (let i = 0; i < 20; i++) await Promise.resolve();
        if (variant === "await-macrotask") await new Promise((r) => setTimeout(r, 0));
        for (const u of replay) seen.push(u.seq ?? -1);
        hosted.setSink((u) => seen.push(u.seq ?? -1));
      });
    }
  });
  await hosted.prompt([{ type: "text", text: "go" }]);
  const max = hosted.replayFrom(0).length; // everything the turn emitted (< MAX_REPLAY)
  const missing = [] as number[];
  for (let s = 1; s <= max; s++) if (!seen.includes(s)) missing.push(s);
  const dup = seen.length - new Set(seen).size;
  console.log(`${variant.padEnd(16)} emitted=${max} received=${seen.length} missing=[${missing.join(",")}] duplicates=${dup}`);
}
for (const v of ["sync", "await-microtask", "await-macrotask"] as const) await run(v);
```
```
sync             emitted=40 received=40 missing=[] duplicates=0
await-microtask  emitted=40 received=36 missing=[6,7,8,9] duplicates=0
await-macrotask  emitted=40 received=5 missing=[6,7,...,40] duplicates=0
```

So the rule is strict: **no `await` of any kind** between reading the ring and
adding the attachment. The design puts both in one synchronous method
(`HostedSession.attach`), and the same holds for "look up or create" in
`SessionHost.open` (the factory is synchronous: `AgentFactory` returns an
object, `session-host.ts:12-17`; `buildAgent` returns `WiredAgent`,
`cli/src/wiring.ts:71`).

### Preconditions

Interfaces assumed from earlier children (not yet implemented; names may
differ — the executor maps names, the **semantics** below are what this plan
relies on, and a mismatch is a STOP-and-fix-the-plan, AGENTS §8):

- **`background-process-groups`** (step 1): `JobController.dispose(): void`,
  synchronous and idempotent; `HostedSession.disposeJobs()`; and a
  `disposeJobs()` call inside `Connection.close()` — **this child removes that
  call** (detach instead of close) and moves disposal into
  `HostedSession.close()`. The process-exit net stays untouched.
- **`session-event-stream`** (step 3), per its Review:
  - `HostedSession.emit` stays synchronous; assigns a per-session monotonic
    `seq`; appends to a byte-bounded ring never reset at turn boundaries; then
    delivers. This child replaces only the *delivery* (one sink → a set).
  - `replayFrom(since): SessionUpdateParams[] | null` — `null` when `since` is
    not covered (older than the ring floor, older than the last
    `history_replaced` barrier, or in the future).
  - `committedSeq` (the consistent cut) readable synchronously.
  - `turn_start` / `turn_end{turnId, stopReason, error?}` are stream events;
    `prompt{turnId}` acks at once; `turn_end` is emitted inside the steering
    no-await window (comment at `agent/src/agent.ts:270-278`, pinned by
    `daemon/test/integration.test.ts:444`).
  - `snapshot` returns `{messages, since: committedSeq}` (paged).
  - `PROTOCOL_VERSION` already bumped once (this child bumps again).
- **`protocol-schema-export`** (step 2): a committed JSON Schema regenerated by
  its script and checked by the gate.

Verified facts on `main`:

- Session map and close: `connection.ts:56` (`sessions`), `:82-87` (`close`
  cancels each turn, closes the peer); creation `:194-211` (per-connection cap
  `:195-200`; the requester closure `:205`; the single sink `:208`).
- `HostedSession` has one `sink` (`hosted-session.ts:35,73-75`), captures the
  requester once (`:48-52`) and **drops** the `onExit` unsubscribe
  (`:57`, while `JobController.onExit` returns one, `core/src/jobs.ts:47-48`).
- `SessionHost.create` is synchronous and keeps no registry
  (`session-host.ts:33-42`).
- `RpcPeer.notify` on a closed peer is a no-op (`peer.ts:214-217`);
  `WsChannel.send` on a closed channel is a no-op (`ws-server.ts:102-106`). A
  sink built on them does not throw after a disconnect.
- Inbound requests dispatch concurrently (`peer.ts:291`, `void
  this.handleRequest`) — AGENTS §7; nothing here adds a lock.
- Error codes reused: `UnknownSession -32003`, `TooManySessions -32006`
  (`transport/src/errors.ts:13,16`). No new code.
- Bun websocket options `backpressureLimit` / `closeOnBackpressureLimit`
  (bun-types `bun.d.ts:2339-2346`); behaviour verified in E3.

### Design

**1. Registry — `SessionHost` owns sessions** (`daemon/src/session-host.ts`).

```ts
class SessionHost {
  private readonly sessions = new Map<string, HostedSession>();
  get(id: string): HostedSession | undefined;
  /** Synchronous: look up or create, then attach — one segment, no await. */
  open(params: OpenParams, attachment: Attachment): OpenOutcome;
  /** Idempotent; true if a live session was closed. */
  close(id: string): boolean;
  get size(): number;          // for session-ttl-limits
  values(): Iterable<HostedSession>;  // for the reaper
}
```

`open` (all synchronous):
- id given and live → `hosted.attach(attachment, since, incarnation)` →
  `{created: false, resync}`. `messages`/`create` are ignored (a live id is
  never overwritten — the clobber is impossible by construction).
- no id given, or id not live **and** (`create: true` or `messages` given) →
  create (`createAgent` + `Session` + `HostedSession`, as `create` does today;
  a missing id is `crypto.randomUUID()`, today's `connection.ts:201`), register
  **before** attaching, attach with no replay → `{created: true, resync:
  false}`.
- id given, not live, no `create`, no `messages` → `UnknownSession`.

The explicit `create?: boolean` (open question 11) exists because today a TUI
opens a *fresh* session with a client-chosen uid and no messages
(`local-runtime.ts:127-129`): `RemoteClient` sets it on its first open of a
session it owns; a re-attaching client omits it and gets `UnknownSession` if
the daemon lost the session, then decides to recreate with `messages`.

`close(id)`: `sessions.get(id)?.close()`, delete, return whether it existed.
Unknown id → `false`, never an error.

**2. `HostedSession` — attachments, fan-out, close** (`hosted-session.ts`).

```ts
interface Attachment {
  readonly send: UpdateSink;                 // synchronous; never awaited
  readonly requestPermission: RemotePermission;
}
readonly incarnation: string;                // crypto.randomUUID() at construction
private readonly attachments = new Set<Attachment>();
private closed = false;
attach(a: Attachment, since?: number, incarnation?: string): { resync: boolean };
detach(a: Attachment): void;
close(reason: "closed"): void;
get attachedCount(): number;                 // for session-ttl-limits
```

- `attach` (one synchronous segment): `const covered = since !== undefined &&
  incarnation === this.incarnation ? this.replayFrom(since) : null;` →
  `resync = covered === null`; `replay = covered ?? this.replayFrom(this.committedSeq) ?? []`
  (on resync, everything after the cut, so a snapshot taken later at a cut
  `S' ≥ S` plus the buffered updates `> S'` is complete — see "Why"); call
  `a.send(u)` for each replayed update; then `this.attachments.delete(a);
  this.attachments.add(a)` (re-insertion makes it "most recent" for permission
  routing). For a just-created session the replay is empty.
- **Fan-out in `emit`:** after the ring append, `for (const a of
  [...this.attachments]) { try { a.send(params) } catch { this.attachments.delete(a) } }`.
  Never `await`ed, return value ignored; iterating a copy so a detach inside a
  send cannot skip a sibling. A throwing sink is detached (it would otherwise
  throw on every event); the others continue. `emit` stays `void`.
- **Permission routing (interim, open question 7):** the requester installed
  once in the constructor (`:48`) now picks the last element of
  `this.attachments` at request time and calls its `requestPermission`; with no
  attachment it returns `outcomeToResponse({outcome: "cancelled"})` at once.
- **`close`** (synchronous, idempotent via `closed`): `controller?.abort()`;
  `emit({type: "session_closed", reason})` (reaches every sink); clear
  `attachments`; call the stored `onExit` unsubscribe; `jobs?.dispose()`
  (`background-process-groups`). After `closed`, `emit` still appends to the
  ring (the unwinding turn's `turn_end`) but there is nobody to send to;
  `attach` on a closed session throws an internal error (unreachable — it is
  no longer in the registry).
- `setSink` is removed (its two users are `Connection` and tests).

**3. `Connection` — attachments only** (`daemon/src/connection.ts`).

- `sessions: Map<string, HostedSession>` → `attachments: Map<string,
  {hosted: HostedSession; attachment: Attachment}>`. An attachment's `send` is
  `(u) => this.peer.notify(Notification.SessionUpdate, u)`; its
  `requestPermission` is today's `this.requestPermission`.
- `open(params)`: per-connection cap check counts `attachments.size` (unchanged
  limit semantics until `session-ttl-limits` makes it daemon-wide); if this
  connection already holds an attachment for the id, `detach` it first (a
  retried `open` from the same connection must not double-deliver); then
  `host.open(params, attachment)` and record it. Returns `{sessionId,
  incarnation, created, resync}`. The handler is synchronous (like `enqueue`,
  `connection.ts:150-167`).
- Lookup for every other command: `const a = this.attachments.get(id); if (!a ||
  this.host.get(id) !== a.hosted) → delete the stale entry, UnknownSession`.
  The identity check catches "closed by another client and recreated under the
  same id" — this connection must not silently drive the new incarnation.
- `closeSession(params)`: `this.attachments.delete(id); this.host.close(id);
  return {}` — no attach required, unknown id is a no-op.
- `close()`: for each attachment: if `options.servesModel`,
  `hosted.cancel()`; `hosted.detach(attachment)`. Then `peer.close()`. **No
  `cancel()` otherwise, no `disposeJobs()`** (removes the call
  `background-process-groups` adds). Sessions stay in the registry.
- `Notification.Cancel` uses the same attached lookup.

**4. Protocol** (`packages/protocol`).

- `session/open`: `OpenParams = {sessionId?, since?: number, incarnation?:
  string, create?: boolean, messages?: ChatMessage[], cwd?: string}` (strict);
  `OpenResult = {sessionId, incarnation, created: boolean, resync: boolean}`.
  `cwd` kept for parity with `session/new` (ignored server-side,
  `session-host.ts:4-6`).
- `session/close`: `{sessionId}` → `{}`.
- `session/new` removed from `Method`, `RequestSchemas` and `session.ts`.
- `session_closed{reason: "closed"}` added to the `SessionUpdate` union as a
  **mandatory** event (event classes from `session-event-stream`), with its
  reverse mapping in `client/src/mapping.ts` (→ no `AgentEvent`; the client
  drops the session's handler).
- Schema doc comment states the ordering contract (open question 1): replayed
  updates are ordinary `session/update`s and may precede the `open` response.
- `PROTOCOL_VERSION` bumped; exported JSON Schema regenerated.

**5. ws-server** (`daemon/src/ws-server.ts`): `websocket: {
closeOnBackpressureLimit: true, backpressureLimit: options.backpressureLimit ??
16 MiB, … }` (open question 8). A frozen client's socket is closed by Bun → the
existing `close` handler (`:193-195`) → `Connection.close()` → detach.

**6. Client and CLI.**

- `RemoteClient.openSession` sends `session/open {create: true, sessionId?,
  messages?, cwd?}` and returns the id (it ignores `resync`: today's clients
  never open a live id — table above; `client-reattach` handles it). It records
  the id in a `opened: Set<string>`.
- `RemoteClient.closeSessions(): void` — for each recorded id, `void
  this.peer.request(Method.Close, {sessionId}).catch(() => {})` (the frame is
  written synchronously by `peer.request`, `peer.ts:133-170`, before the caller
  closes the peer), then clear the set. Never throws, never an unhandled
  rejection.
- `cli/src/local-runtime.ts` `dispose`: `client.closeSessions()` before
  `client.close()` (worker/pod: harmless — the daemon dies anyway; it keeps
  the one-path rule). `cli/src/connect.ts` `finally`: the same. `/clear` closes
  nothing (open question 4).
- `cli/src/serve.ts` `startStdioDaemon`: `new Connection(…, { servesModel:
  options.modelProxy === true })` (open question 5).
- TUI: no change.

**7. Steering invariant.** Fan-out is synchronous and never awaited, so the
`turn_end` emitted inside the no-await window (`agent.ts:270-278`) stays one
segment. Update the comment there to name `HostedSession`'s fan-out (it names
`HostedSession.prompt`, which `session-event-stream` already reshapes).

### Files

Dependency order; smallest diff.

1. `packages/protocol/src/session.ts` — `OpenParams/Result`,
   `CloseParams/Result`; remove `NewSession*`; update the header flow comment
   (`:4-9`).
2. `packages/protocol/src/updates.ts` — `session_closed` member (mandatory).
3. `packages/protocol/src/methods.ts` — `Open: "session/open"`, `Close:
   "session/close"`; remove `NewSession`; `RequestSchemas`.
4. `packages/protocol/src/version.ts` — bump; regenerate the exported schema
   (`protocol-schema-export`'s command).
5. `packages/daemon/src/hosted-session.ts` — attachments, fan-out,
   `incarnation`, `attach`/`detach`/`close`, routed requester, kept `onExit`
   unsubscribe; remove `setSink`.
6. `packages/daemon/src/session-host.ts` — registry (`open`/`get`/`close`/
   `size`/`values`).
7. `packages/daemon/src/connection.ts` — attachments map, `open`/`closeSession`
   handlers, attached lookup, detaching `close()`, `servesModel` option; drop
   `newSession` and the `disposeJobs()` call.
8. `packages/daemon/src/ws-server.ts` — backpressure options.
9. `packages/agent/src/agent.ts` — comment only (`:270-278`).
10. `packages/client/src/mapping.ts` — `session_closed` reverse mapping.
11. `packages/client/src/remote-client.ts` — `openSession` → `session/open`,
    `opened` set, `closeSessions()`.
12. `packages/cli/src/serve.ts` — `servesModel`.
13. `packages/cli/src/local-runtime.ts`, `packages/cli/src/connect.ts` —
    `closeSessions()` before `close()`.
14. Tests: new `packages/daemon/test/registry.test.ts`; updates in
    `daemon/test/integration.test.ts` (`session/new` → `session/open`; the
    invariant test at `:444`), `daemon/test/ws-server.test.ts`,
    `client/test/remote.test.ts` (fake daemon at `:559` answers `Method.Open`),
    `cli/test/local-runtime.test.ts`, `protocol/test/session.test.ts`.

### Failure modes

How state converges in each:

- **Drop mid-turn** → detach only; the turn runs to `turn_end` (in the ring);
  a new connection's `open{since, incarnation}` replays the gap. If the client
  never returns: stays until `session-ttl-limits` (open question 6).
- **Two `open{create|messages}` for the same absent id, concurrently** (two
  devices, or a retry) → `host.open` is synchronous, so the first registers
  before the second's handler runs (`peer.ts:291` dispatches each request in
  its own call; neither handler awaits). The second gets `created: false,
  resync: true` (it sent no valid `since`) and fetches the snapshot. One agent.
- **Same connection opens twice** (ambiguous-ack retry) → the old attachment is
  detached in the same segment before re-attaching; every event once.
- **Open while closing** → `close` is synchronous and removes the entry, so an
  `open` sees either the live session or nothing (→ recreate with
  `create`/`messages`, else `UnknownSession`). The old incarnation's turn may
  still unwind and emit into its own ring; it has no sinks, and the new
  incarnation has a new `incarnation`, so no cross-talk.
- **Stale attachment after close + recreate by another client** → identity
  check in the lookup → `UnknownSession`; the client re-opens.
- **`since` from an earlier incarnation, from the future, or evicted** →
  `resync: true` + replay from the cut; never a silent wrong replay.
- **Daemon restart** → registry empty → `open` without `create`/`messages` →
  `UnknownSession` → client recreates with `messages` → `created: true`, new
  incarnation (client resets its cursor).
- **A sink throws** → detached, others continue; the agent loop is never
  affected. **A sink is slow** → `send` never blocks (E3); past the
  backpressure limit Bun closes the socket → detach → client resyncs. Worker
  `postMessage` and stdio writes buffer without dropping (memory only;
  single-client transports).
- **Permission request with nobody attached** → `cancelled` at once (fail-safe,
  as today). **Its target detaches while pending** → that peer's close rejects
  the request → `cancelled` (today's coercion, `connection.ts:228-231`).
- **`session/close` on an unknown id / twice** → `{}`; idempotent.
- **`close` while a turn awaits a permission** → abort; the late answer
  resolves into an aborted turn (harmless); other clients got
  `session_closed`.
- **Model-serving connection detaches** (`servesModel`) → its sessions' turns
  are cancelled (`turn_end{cancelled}` in the ring); sessions stay registered.
- **Client exits** → `closeSessions()` writes the frames, then the peer closes;
  over ws the frames precede the close frame (WebSocket ordering); in the
  in-memory pair the delivery microtasks are FIFO (`channel.ts:36-54`). Worker:
  `terminate()` may beat the frames — irrelevant, the daemon dies with it.
- **Version skew** → `initialize` fails with `VersionMismatch`
  (`connection.ts:181-186`); a v-old client never reaches `open`.
- **A client opening an id it did not create** → allowed (same token = same
  principal); documented in the schema comment, not prevented.

### Tests

Red before green on the exact property (§9). All daemon tests use the existing
in-memory harness (`createChannelPair`, `RpcPeer` client,
`ScriptedProvider`, `integration.test.ts:19-80`), extended to N connections
sharing one `SessionHost`; a **spy factory** (counts `createAgent` calls); the
existing `FakeJobs` pattern (`cli/test/local-runtime.test.ts:43-66`) gains
`dispose()` with a call counter. Each test lists the mutation that must turn it
red (non-vacuity); the executor applies each mutation once and records the red
in Execution.

1. **Drop mid-turn, re-attach, nothing lost** (the parent repro inverted): slow
   gated model (20 chunks); A opens and prompts, `Connection.close()` at chunk
   ~5; the model still produces all 20; B `open{sessionId, since: lastA,
   incarnation}` → `resync: false`; A's seqs ∪ B's replay ∪ B's live =
   1..N contiguous, no duplicate, ending with `turn_end{end_turn}`. *Red today*
   (repro: turn dies at 6/20; `session/open` unknown). *Mutation:*
   `Connection.close()` cancels again → turn ends `cancelled`, fails.
2. **Attach atomicity sweep** (E1/E2 shape, real `Connection`s): open B at
   every placement k ∈ 0..59 microtasks into a burst; for each k the union of
   updates B receives is contiguous from `since+1` to the end. *Mutation:*
   `for (…) await Promise.resolve()` between replay and `attachments.add` →
   gaps (E1).
3. **Duplicate open never builds a second agent:** two connections fire
   `open{sessionId: X, create: true}` without awaiting between them → spy count
   1, exactly one `created: true`, the other `resync: true`; a third `open` on X
   from A again → count still 1. *Mutation:* an `await` between `get` and
   create in `SessionHost.open` → count 2.
4. **Fan-out:** A and B attached; one turn → both receive the identical,
   contiguous seq list. *Mutation:* single-sink semantics (last attach wins) →
   A misses events.
5. **Same-connection re-open does not double-deliver:** A opens X twice → every
   event once. *Mutation:* skip the pre-detach → duplicates.
6. **No-await window survives fan-out:** extend
   `integration.test.ts:444` (both labels) with two attachments, one of whose
   `send` returns (cast) a promise resolved on a macrotask; still `running ===
   false` at the next macrotask. *Mutation:* make the fan-out `await` each send
   → fails. Plus: a throwing sink is detached and the other still receives
   every event.
7. **`session/close`:** closes; second close and unknown id → `{}`;
   `FakeJobs.dispose` called once; after close `FakeJobs.fire()` emits nothing
   (unsubscribed); B (attached) receives `session_closed` and its next prompt →
   `UnknownSession`; `open{X}` without `create` → `UnknownSession`; with
   `messages` → `created: true`, different `incarnation`. *Mutations:* drop the
   `dispose` call; drop the unsubscribe; drop the `session_closed` emit — each
   fails one assertion.
8. **Stale attachment:** A attached to X; B closes X and recreates X; A's
   `prompt{X}` → `UnknownSession`. *Mutation:* lookup without the identity
   check → A drives B's session.
9. **Incarnation guard:** close + recreate X, run the new incarnation past the
   old `since`; `open{since: old, incarnation: old}` → `resync: true`.
   *Mutation:* ignore `incarnation` → `resync: false` with a wrong replay.
10. **Model-proxy detach:** connection with `servesModel: true` closes
    mid-turn → turn ends `cancelled`, session still in `host.get`, a new
    connection's `open` replays `turn_end{cancelled}`. *Mutation:* ignore the
    option → turn completes, fails.
11. **Interim permission routing:** A creates and detaches, B attaches; a tool
    needing permission → B's client gets `session/request_permission` and its
    answer is used. With nobody attached → denied without any request.
    *Red today* (creator-bound → `cancelled`).
12. **ws backpressure** (`ws-server.test.ts`, E3 pattern: raw TCP socket that
    upgrades and stops reading, small `backpressureLimit`): the server closes
    the socket and the `Connection` detaches. *Mutation:*
    `closeOnBackpressureLimit: false` → socket stays open (E3).
13. **Client exit closes:** `local-runtime.test.ts` — after `runtime.dispose()`
    the daemon's `host.get(uid)` is undefined; `remote.test.ts` —
    `closeSessions()` sends one `session/close` per opened session and never
    rejects when the peer is already closed.
14. **Protocol:** `OpenParams` accepts `{}` and the full shape, rejects unknown
    keys; `isMethodName("session/new") === false`; `session_closed` is in the
    mandatory class.

Gate: `bun run check` green against the §6 baseline; the exported schema
regenerated and checked.

### Experiments (E2, E3)

E2 — can a live update precede the `open` response? (motivates open
question 1)

```ts
// response-order.ts — the handler attaches the sink synchronously and returns the
// "replay" in its response; the model is parked on a gate, then a burst of 40
// chunks (microtasks only) is released in the same macrotask as the request,
// with the request shifted k microtasks into the burst. Real RpcPeer over the
// in-memory pair and over a MessageChannel (the worker transport).
let release: () => void = () => {};
const model: ModelProvider = {
  id: "gated",
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "first " };
    await new Promise<void>((r) => { release = r; });
    for (let i = 0; i < 40; i++) yield { type: "text", delta: `c${i} ` };
    yield { type: "done" };
  },
};
async function run(label: string, [d, c]: [any, any], k: number): Promise<number> {
  const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv as never });
  const hosted = new HostedSession("s", new Session(agent), new PermissionBroker(), async () => ({ outcome: "cancelled" }) as never);
  const order: string[] = [];
  let replayUpTo = 0;
  let daemon: RpcPeer;
  daemon = new RpcPeer(d, {
    onRequest: async () => {
      const replay = hosted.replayFrom(0);
      hosted.setSink((u) => daemon.notify("session/update", u));
      replayUpTo = replay.at(-1)?.seq ?? 0; // what the response would carry
      return { messages: [] } as never;
    },
  });
  const client = new RpcPeer(c, { onNotification: (_m, p) => order.push(`update seq=${(p as { seq: number }).seq}`) });
  const turn = hosted.prompt([{ type: "text", text: "go" }]);
  await new Promise((r) => setTimeout(r, 10)); // parked on the gate
  release();
  for (let j = 0; j < k; j++) await Promise.resolve();
  const res = client.request("session/snapshot", { sessionId: "s" }).then(() => order.push(`RESPONSE(replay up to seq ${replayUpTo})`));
  await turn; await res; await new Promise((r) => setTimeout(r, 20));
  const i = order.findIndex((x) => x.startsWith("RESPONSE"));
  if (i > 0) console.log(`${label} k=${k}: ${order.slice(Math.max(0, i - 2), i + 1).join(" | ")}`);
  return i > 0 ? 1 : 0;
}
// for each transport: 60 placements k = 0..59, count the bad ones
```
```
in-memory pair k=3: update seq=2 | RESPONSE(replay up to seq 1)
in-memory pair k=4: update seq=2 | RESPONSE(replay up to seq 1)
in-memory pair k=8: update seq=3 | RESPONSE(replay up to seq 2)
...
in-memory pair k=59: update seq=13 | RESPONSE(replay up to seq 12)
in-memory pair: live update(s) arrived BEFORE the open response in 24/60 placements
MessagePort: live update(s) arrived BEFORE the open response in 0/60 placements
```

Read: whether the response precedes the next live update depends on the
transport's delivery timing (microtask vs macrotask), not on any contract. With
replay sent as notifications inside the handler, order is fixed by the single
ordered channel on every transport.

E3 — does a frozen ws client block or silently lose frames? (open question 8)

```ts
// backpressure.ts — raw TCP socket completes the upgrade, then never reads.
// Server pumps 16 KiB frames; backpressureLimit 256 KiB.
const server = Bun.serve({
  port: 0,
  fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
  websocket: {
    backpressureLimit: 256 * 1024,
    closeOnBackpressureLimit: closeOnLimit,           // false, then true
    open(ws) { /* pump ws.send(16 KiB) 64 per ms, tally status >0 / -1 / 0, time each call */ },
    message() {}, close() { closed = true; },
  },
});
const sock = net.connect(server.port, "127.0.0.1");
sock.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
  + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
sock.pause(); // never read again
await Bun.sleep(1500);
```
```
closeOnBackpressureLimit=false: sent ok=84 backpressure(-1)=17 dropped(0)=3995 socketClosedByServer=false maxSendMs=0.53
closeOnBackpressureLimit=true: sent ok=36 backpressure(-1)=29 dropped(0)=63 socketClosedByServer=true maxSendMs=0.06
```

Read: `send` never blocks (sub-millisecond); by default the frozen client's
socket stays open while thousands of frames are dropped silently; with the
option the server closes it (the few drops after are on a closing socket).

### Why, item by item

Only decisions not already argued in the Review.

- **Why replay as notifications, not in the response.** E2: the response is
  written after the handler's promise settles (`peer.ts:316-320`), so its
  position relative to live updates depends on the transport. Notifications
  sent inside the handler share one ordered channel with everything after, so
  "replay, then live" holds by construction; and each update stays its own
  frame instead of one frame the size of the ring (8 MiB cap, `ws-server.ts:40`).
- **Why replay from the cut on resync.** The client will fetch a snapshot at
  some later cut `S' ≥ S` (cuts only move forward; compaction moves it and
  emits `history_replaced`). Everything after `S'` is then either in the replay
  (sent from `S`) or live — the client keeps it buffered from the moment it
  sent `open`. Without the replay, events between the cut and the attach point
  would be in neither.
- **Why an `incarnation`.** `seq` restarts with a recreated session; a number
  alone cannot tell "your since in this session" from "a since in a session
  that no longer exists". A UUID per incarnation makes the mismatch explicit
  and costs one field.
- **Why an explicit `create` flag.** Today a TUI opens a *fresh* session with a
  client-chosen uid and no messages (`local-runtime.ts:127-129`). "Not live +
  no messages → `UnknownSession`" alone would break that; "not live → always
  create" would let a reattaching phone silently recreate an *empty* session
  after a daemon restart, losing its history. The flag says which one the
  client means.
- **Why `session_closed`.** Without it, an attached client cannot distinguish
  "closed" from "quiet", and its recovery path recreates what was closed.
- **Why "most recent attachment" for permissions (interim).** The creator-bound
  requester points at a dead peer after a detach — the exact case this child
  creates. The most recent attachment is the device the user is most likely
  holding; `permission-events` replaces this with stream events anyway, so the
  interim must only be fail-safe and better than a guaranteed deny.
- **Why a throwing sink is detached rather than retried.** A sink throws only
  on a programming error (closed peers no-op); retrying would throw on every
  event and could starve the others.
- **Why the per-connection cap still counts attachments.** It keeps today's
  bound for one socket without inventing a daemon-wide limit that
  `session-ttl-limits` designs properly.
- **Why `closeSessions()` at exit rather than per `RemoteSession`.** One call
  per client covers `/clear`ed sessions too (open question 4) and keeps the
  frontends unchanged (no `close` on `SessionController`, no TUI edit).

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `fix/background-process-groups` and
`session-event-stream`.** The order matters (review F5): detach-on-close is
only correct once `turn_end` is in the stream; otherwise a re-attached client
sees `running` and never learns the turn ended.

Scope:
- `SessionHost` = registry: `open` / `get` / `close`. `HostedSession` gets a
  **set** of attached sinks (fan-out) instead of one `sink`, and a `close()`
  that cancels the turn, detaches every sink, unsubscribes `onExit`, disposes
  its jobs.
- `session/open {sessionId?, since?, messages?}` replaces `session/new`: live →
  attach + `{replay}` or `{resync: true}` (from the event-stream ring/cut);
  absent + `messages` → recreate; else `UnknownSession`. A live id is never
  overwritten.
- `session/close {sessionId}`: idempotent; unknown id is a no-op.
- `Connection.close()` **detaches** instead of cancelling — and drops the
  `disposeJobs()` call that `background-process-groups` adds there today; job
  disposal moves to session `close` and the TTL reaper. Exception (parent
  point 11): a turn whose model is served through this connection
  (`--model-proxy`) is cancelled; the session survives.
- Local runtimes (worker, pod `run`) send `session/close` on exit; the
  process-exit net stays.
- Bumps `PROTOCOL_VERSION` (`session/new` removed); updates the exported schema.

**Why, item by item.**

- **Why move ownership to a registry at all.** The repro's root cause is that
  the session map's lifetime *is* the socket's lifetime (`connection.ts:54,80`).
  It cannot be fixed by "reconnecting to the same `Connection`": every new
  socket creates a new `Connection` object (`ws-server.ts` `open`). The
  registry is the only place whose lifetime is independent of sockets. It also
  gives teardown a single owner — the lifecycle eval found orphaned processes
  precisely because nobody owned the end of a session.
- **Why one `open` instead of `new` + `attach`.** With two methods the client
  must choose based on state it cannot know: did the daemon restart? did the
  TTL fire? did another device recreate it? Choosing wrong means a race (attach
  → reaped meanwhile → error → new → but another device already recreated it).
  The daemon knows; `open` puts the branch where the knowledge is.
- **Why a live id is never overwritten.** Today `session/new` with an existing
  id silently replaces a live session whose sink is still attached
  (`daemon-session-lifecycle` repro 2: misattributed updates, a second agent
  built). With `open`, an existing id *means* attach — the clobber is
  impossible by construction, not by a check someone can forget.
- **Why `open{messages}` recreates.** It preserves today's `--resume` path, and
  it is the only recovery when the daemon lost the session and has no store of
  its own (pod modes; `serve` before `daemon-side-persistence`).
- **Why `close` is idempotent.** It is called from exit paths, retries, and in
  races with the reaper. An error on an unknown id would force every exit path
  to handle an error that means nothing.
- **Why detach instead of cancel on socket close.** That *is* the requirement:
  work continues while the phone is away. Why not keep "cancel" for the TUI:
  one rule for every runtime (AGENTS §7, one session path). Local runtimes send
  `close` on exit, so what they observe does not change.
- **Why the model-proxy exception.** In pod `run` the model is reached through
  the laptop's connection. With it gone, the next `model/stream` fails anyway,
  mid-round, with an obscure transport error. Cancelling cleanly is honest and
  keeps the session for re-attach. A phone never serves the model: the key must
  stay on the identity host (AGENTS §7), and a backgrounded phone cannot keep a
  stream alive.
- **Why a set of sinks (fan-out).** Multi-attach (parent point 9): "attach
  steals" makes TUI and phone evict each other forever; fan-out is simpler and
  lets the TUI watch while the phone answers.
- **Why a slow sink must not block.** One frozen phone socket must not stall the
  agent loop or the laptop's stream. Writing to a sink must never be awaited by
  the emitter; a sink that cannot keep up is dropped and resyncs later — a
  dropped sink costs one resync, a blocking one stalls everyone. Second reason:
  `turn_end` is emitted inside the steering invariant's no-await window
  (`agent.ts`, see `session-event-stream`); an awaited fan-out there would let a
  `session/enqueue` be accepted and then dropped.
- **Why attach must be synchronous in one tick.** JavaScript is single-threaded:
  if an `await` separates "compute replay" from "add sink", events emitted in
  between are in neither → a gap. The reverse order gives duplicates, which
  seq dedupe absorbs; a gap nothing can repair.
- **Why "any authenticated client can open any session" is accepted.** One
  token already grants shell on the daemon; attaching to another session grants
  nothing creating one would not. Preventing it would add complexity for zero
  security. Per-device tokens (parent, out of scope) are the real fix.
- **Why local runtimes send `close` on exit.** Without it, every TUI that quits
  while connected to a `serve` leaves a session idle for 24 h holding memory
  and its jobs. `close` says "I am done" explicitly.

Load-bearing assumption to prove first: nothing outside `Connection` relies on
"session dies with its connection" — grep every `Connection.close` /
`newSession` caller (worker, `serve`, stdio pod daemon) and the `--resume` path.
Second: attach (compute replay + add sink) is synchronous in one tick, so no
event falls between replay and live.

Failure modes: open-while-closing race; two `open{messages}` for the same absent
id concurrently (second attaches, never recreates); daemon restart (sessions
gone → client recreates via `messages`); a client opening an id it never
created (same token = same principal; documented, not prevented); fan-out to a
slow sink must not block the others or the agent loop.

Tests: drop mid-turn → turn continues, a new connection attaches and receives
replay up to `turn_end`; duplicate `open` never builds a second agent (spy
factory); two attached clients both receive every event in order;
model-proxy detach cancels the turn but keeps the session.
