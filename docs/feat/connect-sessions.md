# feat/connect-sessions — `connect`: quit detaches, `--resume`, `/sessions`, `/close`

> **Status:** implementation — APPROVED 2026-10-24 as ONE task (owner block at the end); **re-planned 2026-10-25** against `main` `0b1d89f` (after 2a, 3, 5, `tui-spill-note`, 6, `fix/tui-input-wrap-cursor`, `fix/tui-diff-tabs`, `fix/tui-expand-latency`); re-plan questions QN1–QN2 ANSWERED by the owner 2026-10-25 (see "Owner answers (re-plan)")
> **Branch:** `feat/connect-sessions` (one branch, no split)
> **Size:** L (5 packages: protocol, daemon, client, cli, tui) · **Blast:** load-bearing *(re-plan 2026-10-25: was cross-module)* — besides the additive wire method and `connect`'s lifecycle, the change now edits the `RemoteSession` stream path every runtime shares (the `error`-frame cancel, F1; a session refused on reconnect becomes a `closed` activity) and the AGENTS §7 "Persistence" text · **Suited:** strong model executes; mandatory fresh-context Review red-teaming §7 "TUI always over RPC — one session path", "Single-broker", "Never write raw to the terminal while Ink owns it", "Don't serialize the RPC peer"

Type: feat · Size: L · Blast: load-bearing · Suited: strong model + mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-24; re-verified 2026-10-25*

Row 7 of `docs/eval/mobile-app.md` decision 21 (Phase 2 — handoff, TUI side).
It turns the owner's decisions into `tentacle connect` behaviour:

- **Decision 4 (session lifetime):** "Leaving detaches, never closes: closing
  the app, quitting the TUI and losing the network are the same — the session,
  a running turn and background jobs keep going … Ending is explicit: 'End
  session' in the app, `/close` in the TUI; `/clear` = close + new … Deletion is
  manual only ('Delete' in app / TUI)."
- **Decision 5:** every client is a view of the SESSION; terminal → mobile →
  terminal without losing anything.
- **Decision 6/7:** one daemon per project; `session/list` entries carry the
  `cwd`.
- **Handoff eval** (`docs/eval/session-handoff.md`): G1 (a session cannot be
  found from `connect`), G2 (quitting `connect` destroys the session); Q1
  recommends `connect --resume [id]` mirroring the local one plus an in-TUI
  `/sessions`; Q2 detach-on-quit; Q8 "(c)'s detach-on-quit must not land before
  (b) [task 6], or a resumed session would look empty".
- **Carry-overs from task 1** (eval, "Owner decisions after…"): render
  `sessionId` safely (daemon-supplied); `MethodNotFound` on `session/list` =
  "daemon too old"; `updatedAt` is the daemon's clock.
- **Owner principle:** a client never guesses what the daemon knows; never
  decides by text or message shape — the daemon reports it.
- **Carried in from task 6 by the owner** *(re-plan 2026-10-25)*
  (`docs/eval/mobile-app.md:510-525`, `docs/feat/tui-foreign-turns.md` QR3,
  QR4, Review F1):
  - **QR3** — `/clear` on a shared session still closes it for every device
    (refused while any device's turn runs). Whether in `connect` it should only
    detach is decided here → QN1.
  - **QR4** — `/exit` sends no cancel, but `connect`'s exit still calls
    `closeSessions()` and so stops the phone's turn → fixed here by "quit =
    just close the socket". Re-proved below (repro (1)).
  - **Review F1** — the cancel the client sends on an unreadable `error` frame
    is blind and can stop a phone's turn → `cancel(id, <own turn id>)`, none
    while only a foreign turn streams. Re-proved below (repro (4)).

What exists today *(re-plan 2026-10-25: verified on `main` @ `0b1d89f`)*:

- `connect` always builds a NEW lazy session with a random id
  (`packages/cli/src/connect.ts:127`) and has no `--resume`/`--continue`
  (`packages/cli/src/flags.ts:56-60`, usage `:491-492`, `HELP`
  `packages/cli/src/main.ts:94`, `:118`; `main.ts:232-238` passes only url,
  token, tls).
- On quit it CLOSES every session it opened (`connect.ts:133-139`,
  `await client.closeSessions()` at `:136`). On `serve`, `session/close` ends
  the turn and jobs and ARCHIVES the session (`protocol/src/session.ts:447-453`,
  2a). Pinned by `packages/cli/test/connect.test.ts:189-230` ("quitting ends the
  sessions it opened").
- Quitting mid-turn: `/exit` during an OWN turn stops it first, then exits;
  during a FOREIGN turn it exits at once with no cancel (task 6 C4) —
  `packages/tui/src/commands.ts:197-210` `quitAction`, `App.tsx:1320-1341`.
  Ctrl+C mid-turn stops what runs, whoever started it (`App.tsx:1742-1753`).
- `connect` keeps NO laptop copy of the conversation: `connectTui` has no
  saver (`connect.ts:121-132`; compare `createLocalRuntime`, whose `dispose`
  flushes saves then closes, `packages/cli/src/local-runtime.ts:366-384`).
- Task 6 built the attach path but nobody calls it yet: `RemoteClient
  .newSession(…, { attach: { reopen? } })` (`client/src/remote-client.ts:480-487`)
  → `RemoteSession.open()` (`client/src/remote-session.ts:208-231`) →
  `RemoteClient.attachSession` (`remote-client.ts:497-517`: never `create`,
  rejects on `SessionArchived` / `SessionDeleted` / `UnknownSession`). The TUI
  subscribes `watch` FIRST, then calls `open?.()` (`App.tsx:1104-1121`).
  `RemoteClient.sessionList` (`remote-client.ts:442-449`) has no caller in
  `cli`/`tui` either (grep).
- A session closed by another device while we are attached: `session_closed`
  → `RemoteSession.onClosed` (`remote-session.ts:952-960`) fails its turns and
  raises a `closed` activity; the TUI shows `closedNotice`
  (`App.tsx:1063-1066`, `tui/src/turn-feed.ts:78-81`) — and stays on the dead
  session: every later prompt is refused "this session was closed on another
  device" (`remote-session.ts:608-615`). The owner's fix (a notice AND a fresh
  session) is this task's.
- A session ended (archived) or deleted while OUR link was down: the reconnect
  re-open is refused (`SessionArchived` / `SessionDeleted`; 2a's O1 fix,
  verified by `client/test/reattach.test.ts:1521` "DECISIVE …" and `:1624`).
  The client tells it only through `onError` (`failSession`,
  `remote-client.ts:1397-1404`) — on `connect` that is the buffered sink,
  printed after exit — and the next prompt fails with "could not resume the
  session: …". Not yet a notice in the TUI.
- There is no way to detach ONE session without closing the socket: the method
  registry has `session/close` / `session/delete` but no detach
  (`protocol/src/methods.ts:53-62`, `:92-101`); a connection detaches only when
  it closes (`daemon/src/connection.ts:120-129`), on a retried open (`:338-341`)
  or for a stale entry (`:352-359`). An unregistered method is answered
  `MethodNotFound` by the peer before any handler (`transport/src/peer.ts:332-336`).
- The blind `error`-frame cancel is at `client/src/remote-session.ts:746-752`
  (`if (this.id) this.client.cancel(this.id)`) on `main`.

**Repro** *(re-plan 2026-10-25; replaces the 2026-10-24 one, which imported a
read-only worktree)* — `.tentacle/tmp/connect-sessions/repro.ts`, run on `main`
`0b1d89f` with `bun repro.ts`. One in-process `SessionHost` (no persister), real
`Connection` + `RemoteClient` pairs; the model yields `x`, waits on gate 1,
yields `y`, waits on gate 2, yields `z`.

```ts
// (1) QR4: connect creates X; a phone attaches X (task 6 attach) and starts a long turn; the TUI quits.
await connectTui({ url: "ws://fake" }, () => {}, {
  dial: () => async () => c,
  startTui: async (_a, o) => {
    await drain(o.createSession?.().send("first") ?? []);
    const x = host.list({}).sessions[0]?.sessionId ?? "";
    reset();
    const phone = await dial();
    const ps = phone.client.newSession(undefined, x, undefined, { attach: {} });
    await ps.open();
    phoneTurn = drain(ps.send("phone turn"));
    await tick();
    console.log("(1) phone turn running, TUI attached too:", brief());
  },
});
console.log("(1) after connect quit:", brief(), "phone turn events:", JSON.stringify(await phoneTurn));

// (2) load-bearing: quit = just close the socket; a 2nd client's eager attach.
void drain(a.client.newSession(undefined, id).send("long turn"));
a.client.close(); // connect's quit minus closeSessions()
a.conn.close();   // what ws-server does on socket close
const sb = b.client.newSession(undefined, id, undefined, { attach: {} });
sb.watch((act) => { acts.push(act.kind); if (act.kind === "turn") foreign = drain(act.events); });
await sb.open();
openAll(); // the turn finishes daemon-side

// (3) attach of a gone id (closed / never existed): refused, nothing created.
await c.client.closeSession(id);
await c.client.newSession(undefined, id, undefined, { attach: {} }).open();

// (4) F1: the phone runs a turn; the attached TUI receives ONE malformed known-type
//     chunk (its channel rewrites `y` to `{ type: "agent_message_chunk" }`).
```

```
(1) phone turn running, TUI attached too: [{"id":"b98bc936","running":true,"attached":2}]
(1) after connect quit: [] phone turn events: ["text","turn_end:cancelled"]
(2) mid-turn: [{"id":"0bd7d61b","running":true,"attached":1}]
(2) after socket close: [{"id":"0bd7d61b","running":true,"attached":0}]
(2) 2nd client eager attach, activities: ["history","turn"] [{"id":"0bd7d61b","running":true,"attached":1}]
(2) foreign turn events on the 2nd client: ["user_message","text","text","text","turn_end:end_turn"]
(2) history after: user,assistant
(3) open of a closed id threw: unknown session: 0bd7d61b-… | sessions before/after: 0 0
(3) open of an unknown id threw: unknown session: 780620c3-… | sessions: 0
(4) TUI foreign stream: ["user_message","text","throw:malformed agent_message_chunk update from the daemon"]
(4) phone's OWN turn events: ["text","text","text","turn_end:cancelled"]
```

Reading:
- (1) is G2 and QR4 on today's code: quitting `connect` closes the session,
  and the PHONE's own turn ends `cancelled`.
- (2) is the load-bearing fact, re-proved after task 6: the socket closing
  leaves the session `running:true, attached:0`; task 6's eager attach of a
  second client gets the history, then the running turn as a foreign `turn`
  activity (the replay); the turn ends `end_turn` daemon-side.
- (3) a gone id is refused and nothing is created (on a host without a
  persister it is `UnknownSession`; on `serve` the archived / deleted cases are
  `SessionArchived` / `SessionDeleted`, pinned by
  `client/test/foreign-turns.test.ts:838`, `:869`).
- (4) is F1: one unreadable frame on the TUI's link cancels the phone's turn.

**Dependencies** *(re-plan 2026-10-25)*: 2a (`session-archive`, merged
`c4c7cd9`) and task 6 (`tui-foreign-turns`, merged `024ebb9`) are on `main`;
P7 below states exactly what this task reuses from them. Task 3 (titles) and
task 5 (queued broadcast) are merged too; their interplay is in Design.

## Implementation

*— claude-opus-5-5, 2026-10-24; re-planned in full 2026-10-25*

### Load-bearing assumption

*(re-plan 2026-10-25)*

**"Detach" needs no daemon change for the quit case: a `connect` that closes
its socket WITHOUT `session/close` leaves each session live on a `serve`
daemon — turn and jobs running, `attached: 0` in `session/list`, archived only
by the idle TTL / detached cap — and any later client re-attaches it with task
6's eager attach (`session/open{sessionId}`, never `create`), seeing its
history and, mid-turn, the running turn as a foreign turn.**

Proof on `0b1d89f`:
- `Connection.close()` only detaches, and cancels only on a model-serving
  connection (`daemon/src/connection.ts:114-129`); `servesModel` is set only
  for the stdio pod daemon (`options.servesModel`, `connection.ts:104`), never
  by `ws-server`.
- `RemoteClient.close()` sends no frame (`client/src/remote-client.ts:822-836`:
  timers, `stop`, `peer.close`).
- The TUI's unmount sends nothing either: no unmount effect aborts a turn
  (`abort()` is called only from key/command handlers, `App.tsx:1179`, `:1268`,
  `:1340`, `:1725`, `:1751`, `:1791`), and a dangling permission dialog is
  resolved `DISMISSED`, which over RPC sends nothing — the request stays
  pending for another client (`tui/src/permission-ui.ts:12-13`, `:214-219`).
- `HostedSession.detach` removes the attachment and re-checks asks
  (`daemon/src/hosted-session.ts:792-796`); `attach` replays and re-adds
  (`:767-790`).
- Repro (2): `running:true, attached:0` after the socket closed; a second
  client's eager attach → `history`, then `turn` (the replay of the running
  turn), which ends `end_turn` daemon-side.

The second assumption the in-TUI switch stands on — **"there is no existing way
to detach one session and keep the socket"** — holds: no detach in the method
registry (`protocol/src/methods.ts:53-62`), and the only detach call sites are
socket close, a retried open and a stale entry (`connection.ts:125`, `:339`,
`:355`). Hence the one new method.

### Preconditions

*(re-plan 2026-10-25: every line re-checked)*

- **P1 — permission asks survive a detach.** An ask with no client able to
  answer waits (`daemon/src/hosted-session.ts:537-557`, "none is attached:
  then the ask waits for a client"); `detach` and `attach` re-check asks
  (`:795`, `:788`). The TUI's unmount dismisses locally without a frame
  (`permission-ui.ts:214-219`). So quitting or switching on a pending prompt
  leaves it for the next device.
- **P2 — `session_closed` reaches the client while idle**: `RemoteClient`
  drops the entry and withdraws its prompts (`remote-client.ts:1494-1501`),
  then `RemoteSession.route` → `onClosed` fails open turns and raises
  `{ kind: "closed", reason }` unless this object closed it itself
  (`remote-session.ts:927-929`, `:952-960`). Already built by task 6; this
  task only changes what the TUI does with it.
- **P3 — the router can withdraw one session's prompts**:
  `PermissionRouter.sessionClosed(id)` (`client/src/permission-router.ts:157`)
  — reused for a detach.
- **P4 — `/clear` closes the old session on every runtime today**
  (`App.tsx:1345-1370` → `RemoteSession.close`, `remote-session.ts:378-393`,
  fire-and-forget `closeSession`), refused while any device's turn runs
  (`commands.ts:157`, `App.tsx:1315-1318`). QN1 decides whether `connect`
  keeps that.
- **P5 — the local `--resume` seams to mirror**: flags `RESUME` / `CONTINUE` /
  `RESUME_CONFLICTS` (`flags.ts:46-51`); the picker types `SessionChoice` /
  `pickerView` / `pickerAge` (`tui/src/session-picker.ts:8-15`, `:41`, `:72`);
  the local resolution rules (`cli/src/session-resume.ts:48-130`).
- **P6 — the panel seam**: one `OpenPanel` union with one key route
  (`tui/src/panel.ts:22-28`; `App.tsx:1775-1788` routes `treeKey` →
  `applyPanel`), loaded through `openPanel` with a generation guard
  (`App.tsx:684-704`); a runtime that lacks a feature says so (`/mcp`,
  `App.tsx:1450`). Since `fix/tui-*` the existing panels are TREE panels
  (`tui/src/tree-panel.ts:14-34`, `:78`).
- **P7 — from task 6, verified present on `main`:** (a) attach-only
  `RemoteSession` (`newSession(…, { attach: { reopen? } })`, `open()`), which
  never creates: repro (3), `foreign-turns.test.ts:838`, `:869`; a reconnect
  of an attach that went live re-opens with `since` only (no `create`, no
  `reopen`), one never live re-attaches, never creates
  (`remote-client.ts:1220-1246`, `:1272-1277`); (b) its history arrives as a
  `history` activity, a running turn as a foreign `turn` activity, both
  buffered until `watch` subscribes (`remote-session.ts:233-243`); (c)
  `cancel(sessionId, turnId?)` (`remote-client.ts:798-805`) and the daemon's
  by-id cancel (`hosted-session.ts:1558-1571`); (d) `ownsTurn`
  (`remote-session.ts:193-198`). This task REUSES these; it builds no second
  open path.
- **P8 — the single broker** stays one instance: `connectTui` builds it once
  and hands it to both `RemoteClient` and `startTui` (`connect.ts:89`, `:114`,
  `:126`). Nothing here creates a client or a broker per session.
- **P9 — Ink owns the terminal** between `startTui` and its return; `connect`
  writes only through `bufferedErrorSink` and after the TUI exits
  (`connect.ts:36-55`, `:138`). A pre-mount failure is the plain
  `[connect error]` line (`main.ts:240-244`).
- **P10 — the peer is not serialized** (`transport/src/peer.ts:322`, `void
  this.handleRequest`): the new handler is synchronous, no lock.
- **P11 — the protocol version is an exact match** at `initialize`
  (`connection.ts:276`, `PROTOCOL_VERSION = 11`, `protocol/src/version.ts:7`):
  a peer without `session/detach` can only be a same-version build from before
  this task, and it answers `MethodNotFound` (`peer.ts:333-335`).

### Design

#### One rule per target (one session path, AGENTS §7)

*(re-plan 2026-10-25: `/clear` row per QN1; Ctrl+C / foreign columns added)*

Same `RemoteClient` ↔ `Connection` stack everywhere; only the lifecycle
OPTIONS differ, injected by the CLI:

| | quit (`/exit`, idle Ctrl+C) | `/exit` mid-own-turn | `/exit` mid-foreign-turn | Ctrl+C / Esc mid-turn | `/clear` | `/close` | `/sessions` | `--resume` source |
|---|---|---|---|---|---|---|---|---|
| `connect` (remote `serve`) | **detach** (socket closes, no `session/close`) | **detach at once** (turn keeps running) | detach at once (task 6: no cancel; now nothing closes either) | stop it (task 6, `cancel{turnId}`) | QN1 — recommended: **detach + new** | close + quit | **yes** (`session/list`) | **the daemon** (`session/list`) |
| in-process worker | close (today) | stop, then exit (today) | — (no foreign turns) | stop | close + new | close + quit | "isn't available on this runtime" | laptop store (today) |
| pod `run` / `attach` | close (today) | stop, then exit (today) | — | stop | close + new | close + quit | "isn't available on this runtime" | laptop store (today) |

Why the worker and pods keep closing: their daemon dies with the process /
exec stream and never persists (AGENTS §7 "Pod daemons … and the in-process
worker never persist"), no other device can reach it, so a "detached" session
there is only leaked jobs until the process ends. `/close` exists on every
runtime with ONE meaning ("end this session and quit").

#### Protocol — one additive method, no bump

`session/detach { sessionId } → {}` (`protocol/src/session.ts`, a
`// --- session/detach` block after `session/close`; `Method.Detach =
"session/detach"` + its `RequestSchemas` entry, `methods.ts`; regenerate
`protocol/schema/protocol.json` with `bun run schema:export`). Contract text:

> Stop receiving this session's updates on this connection; the session keeps
> running (turn, jobs, pending asks, queue) for any client, and counts as
> detached for the idle TTL, the detached cap and `session/list.attached` once
> no connection is attached. Idempotent: an id not open on this connection is
> a no-op success. On a connection that serves the model (pod reverse-tunnel)
> it also cancels the session's turn, exactly as closing that connection does.
> No update is sent to anyone. Additive: an older daemon answers
> `MethodNotFound`.

**Why no `PROTOCOL_VERSION` bump** (AGENTS §7 forward compatibility): a new
method is free; no field, update or meaning changes. The only peer that lacks
it is a same-version build from before this task (P11); its `MethodNotFound`
is handled (below) — refused, never shimmed.

#### Daemon (`packages/daemon/src/connection.ts`)

`case Method.Detach` → `detachSession(params)`: `entry =
this.attached.get(id)`; if present → `this.release(entry)` and
`this.attached.delete(id)`; `{}`. `release(entry)` = (`servesModel` ⇒
`entry.hosted.cancel()`), `entry.hosted.detach(entry.attachment)` — the two
calls `close()` makes per session (`:121-126`), factored into one private
method used by both. Synchronous, no await, no lock (P10). A stale entry (the
id was closed and recreated by someone else) is detached the same way — the
attachment belongs to the old object, which is exactly what we stop.

#### Client (`packages/client/src`)

*(re-plan 2026-10-25: `onClosed` dropped — task 6 built it as the `closed`
activity; F1 and the reconnect refusal added)*

- **`RemoteClient.detachSession(sessionId): Promise<void>`** — sends
  `session/detach` through the same `endSession` shape (`remote-client.ts:640-662`):
  marks the entry `closing` (so `closeSessions`, `drain` and a reconnect's
  `recover` skip it, `:1221-1224`), and on the answer — or a dropped link —
  forgets it and withdraws its prompts (`runPermissionActions(router
  .sessionClosed(id))`, P3). Unlike `closeSession` it REJECTS on
  `MethodNotFound`, un-marks `closing` and keeps the entry (the caller refuses
  the switch: nothing changed). While the link is down: forget locally and
  resolve (the dropped socket already detached it daemon-side — the
  load-bearing assumption).
- **`RemoteClient.drain(timeoutMs = CLOSE_SESSIONS_TIMEOUT_MS): Promise<void>`**
  (`:93`) — await every in-flight `endSession` request (close, delete,
  detach), bounded, never rejects. `endSession` adds its promise to a private
  `ending: Set<Promise<void>>` and removes it on settle. Replaces
  `closeSessions()` on `connect`'s exit path: a `/clear` or `/close` right
  before quitting must still reach the daemon (today `closeSessions` awaits
  only sessions not yet closing, `:671-686`; the in-memory pair drops a frame
  written just before `close()`, its doc says).
- **`RemoteClient.liveSessionIds(): string[]`** — ids of entries that went
  live (`everLive`) and are not closing (for the exit line).
- **A session refused on reconnect becomes `closed`** — `failSession`
  (`:1397-1404`): when `error` is an `RpcError` with code
  `DomainErrorCode.SessionArchived` → reason `closed`, `SessionDeleted` →
  `deleted` (by CODE, never text), it calls the listener's new optional
  `ended?(reason)` BEFORE the `fail` step; other errors unchanged.
  `RemoteSession.ended(reason)` = `this.onClosed(reason)` (P2's path: fail open
  turns, raise `closed` unless this object closed it). The `onError` line is
  kept (it is the sink's record).
- **F1 — the `error`-frame cancel names my turns only**
  (`remote-session.ts:746-752`): before `failAll`, collect the ids of MY unended
  turns `[this.active, this.next]` (own active, own waiting send-now; a
  `settling` turn is left to its in-flight prompt, as `failAll` already does);
  after it, `cancel(this.id, turnId)` for each. Only a foreign turn streaming →
  no cancel at all (that turn fails HERE only; the phone's turn runs on). The
  daemon's by-id cancel stops the active turn or the waiting successor and
  ignores any other id (`hosted-session.ts:1558-1571`), so a stale id is
  harmless.
- **`RemoteSession`** additions:
  - `get sessionId(): string | null` — `id ?? desiredId` (the TUI marks the
    current row and prints the exit line; never parsed).
  - `detach(): Promise<void>` — sets `closed` (later sends refused like after
    `close()`), unsubscribes the queue listener, ends a foreign turn's stream
    with no outcome (`closeWithoutOutcome`, `:862-869`; never a guessed
    `turn_end`), then `client.detachSession(id)` when opened (an `opening` /
    `attaching` in flight: detach after it settles; before any open: a no-op).
    On a `MethodNotFound` rejection it restores `closed = false` (nothing
    changed) and rethrows.

#### CLI (`packages/cli/src`)

- **Flags** (`flags.ts:56-60`): `ARGS.connect` gains `bools: { …,
  ...CONTINUE }`, `optional: RESUME`, `conflicts: RESUME_CONFLICTS` (the three
  constants `run`/`attach`/`tui` use, `:46-51`); `USAGE.connect` (`:491-492`) and
  `HELP` (`main.ts:94`, `:118`) gain `[--resume [id]|--continue]`.
  `RESUME.accepts` takes a UUID as the next word (`flags.ts:47`); any other
  daemon id needs `--resume=<id>` (`flags.ts:33-35`).
- **New pure module `connect-resume.ts`**: `planConnectResume(request, list?)
  → { kind: "new"; line? } | { kind: "open"; id; reopen; line? } | { kind:
  "pick"; choices: SessionChoice[] } | { kind: "error"; message }`, given `{
  wanted, id?, latest, tty }` and, when needed, the first `session/list` page
  (or its error). Rules (mirroring `session-resume.ts`):
  - no flag → `new` (today).
  - `--resume <id>` → `open`, `reopen: true` (the person named it: an
    explicit reopen, 2a's rule `protocol/src/session.ts:388-396`; on a live id
    `reopen` is ignored). No list needed.
  - `--continue`, or `--resume` without a terminal → the newest entry
    (`sessions[0]`, the daemon's order, `session.ts:662` — never re-sorted),
    `reopen: entry.archived`, line `[resume] <id8> — <title>`; no entry →
    `new` with `[resume] no session on this daemon; starting a new one`.
  - `--resume` on a terminal with ≥ 2 entries → `pick`; one → as `--continue`;
    empty → as above.
  - the list failed `MethodNotFound` → `error`: "this daemon cannot list
    sessions (no session/list) — update tentacle on the daemon, or pass
    --resume <id>". Any other failure → `error` with its message. Never a
    silent new session.
  Archived entries are listed and choosable; choosing one reopens it.
- **`SessionChoice` from a list entry** (`tui/src/session-picker.ts:8-15`):
  `messageCount` becomes optional and the choice gains optional `running`,
  `attached`, `archived`; `pickerView`'s meta renders what is present ("N msgs"
  for the local store; "running" · "on N devices" · "archived" for the
  daemon). Title (task 3: the daemon's `title`, one line by schema,
  `session.ts:644-645`) and id pass through `oneLine` (`commands.ts:49`); the
  id shows as its first 8 chars. Pure, in `session-picker.ts`.
- **`connectTui`** (`connect.ts:83-140`), in order:
  1. dial + `initialize` (today);
  2. if a resume is wanted: `planConnectResume` (calling
     `client.sessionList({})` only when the plan needs it, and the pre-mount
     picker on a terminal) — BEFORE Ink mounts (P9);
  3. `open` → `first = client.newSession(undefined, id, undefined, { attach:
     { reopen } })`, then `await first.open()` pre-mount, so a gone id fails
     as a plain error before mount: `SessionArchived` (only without reopen)
     / `SessionDeleted` / `UnknownSession` → "no session <id8> on this
     daemon (ended, deleted, or never created)"; `TooManySessions` → its
     message. Its history and a running turn are buffered as activities until
     the App's `watch` (P7 b) — no `resumeMessages`, no second history path;
  4. mount with `createSession` returning `first` on its FIRST call and a
     fresh lazy `client.newSession(undefined, crypto.randomUUID())` after
     (as today), `detachOnQuit: true`, `sessions` (the directory, below);
  5. `finally`: `await client.drain()` (NOT `closeSessions`),
     `client.close()`, `sink.flush(write)`, then for each
     `client.liveSessionIds()` one line `[connect] left session <id8> on the
     daemon — resume: tentacle connect <url> --resume <id>` (after Ink
     unmounted, P9; id and url are the ones we hold, rendered through
     `oneLine`).
  Cancelled picker → return without mounting (exit 0, as the local picker).
- **The directory** given to the TUI (`TuiOptions.sessions`, a small interface
  in `tui`): `list(): Promise<SessionsView>` (one page, `limit` =
  `MAX_SESSION_LIST`, `session.ts:632`; `more: boolean` from `cursor`),
  `open(id, reopen): SessionController` (a NEW attach-only `RemoteSession`;
  the App's `watchSession` subscribes, then calls its `open()` — the existing
  order, `App.tsx:1104-1121`), `remove(id): Promise<void>` (2a's
  `deleteSession`, `remote-client.ts:636-638`). Built in `connect.ts` from the
  ONE `RemoteClient`; worker/pod runtimes pass none.

#### TUI (`packages/tui/src`)

*(re-plan 2026-10-25: rewritten on task 6's `watch` / `open` / `closed`
activity and the tree panels)*

- **Options** (`run.tsx` `TuiOptions`, `App.tsx` `AppProps`): `detachOnQuit?:
  boolean` (default false), `sessions?: SessionDirectory`.
- **`SessionController`** (`App.tsx:125-191`) gains optional `detach?():
  Promise<void>` and `readonly sessionId?: string | null`.
- **`commands.ts`** (pure):
  - `SLASH_COMMANDS` (`:26`) += `/sessions` ("list this daemon's sessions and
    switch") and `/close` ("end this session and quit").
  - `quitAction(source, running, exitPending, foreign = false, detaches =
    false)` (`:197-210`): `source === "command"` and (`foreign` or `detaches`)
    → `"exit"` even mid-turn. Ctrl+C mid-turn stays `"stop"` (the stop key
    everywhere, owner Q2 of task 6).
  - `SESSION_MUTATING` (`:157`) += `/close`, `/sessions` is NOT in it (opening
    the panel mid-turn is a read; the switch itself is refused by
    `sessionsChoose`).
- **New pure module `sessions-panel.ts`**: the `/sessions` view-model and its
  decisions — `sessionsRows(view, currentId, now)` (title via `oneLine`, age
  via `pickerAge`, markers `current` / `running` / `on N devices` (for the
  current row `attached - 1`: we are one of them) / `archived`, a footer when
  `more`), `sessionsKey(input, key)` → `up | down | choose | delete | close |
  none`, and `sessionsChoose(row, currentId, busy)` → `{ kind: "stay" }` (the
  current row: close the panel) | `{ kind: "switch"; id; reopen:
  row.archived }` | `{ kind: "refused"; text }` (`busy` = a turn of ANY device
  runs in the view, or my compaction runs: "can't switch while a turn is
  running — stop it (esc), or wait"). `delete`: first press arms "press x again
  to delete <title>", any other key disarms, second press → `{ kind: "delete";
  id }`; on the current row → refused ("/close it first"). A flat list, not a
  tree: the panel kind has its own cursor; `panel.ts` dispatches to it, the
  tree panels are untouched.
- **`panel.ts`**: `OpenPanel` += `{ kind: "sessions"; data: SessionsView |
  null; cursor: number; armed: string | null }`; `panelView` dispatches to
  `sessions-panel.ts`; `applyPanel` / `panelClick` keep their tree behaviour
  for the other kinds.
- **`App.tsx`** (effects only; every branch is decided in the pure modules):
  - **One swap path.** `/clear`'s body (`App.tsx:1345-1370`: new controller,
    `watchReturned`, `watchSession`, latches, `initialState`, scroll, compaction
    rows back to the input) becomes `swapSession(next, why)`, used by `/clear`,
    the switch and closed-elsewhere. AGENTS §7 "logic lives in pure modules":
    the swap has no branching beyond what `/clear` has today.
  - `/sessions` → no `sessions` option → "_Sessions aren't available on this
    runtime._"; else `openPanel(sessionsPanel(), () => sessions.list()…,
    sessionsListError)` — `MethodNotFound` → "_This daemon is too old to list
    sessions._".
  - Panel key route (`App.tsx:1775-1788`): for `kind === "sessions"` use
    `sessionsKey`; `choose` → `sessionsChoose`; on `switch`, in ONE synchronous
    step: `watchSession(null)` (A's activities stop reaching the view, held
    ones dropped), then `await old.detach?.()` — rejected (`MethodNotFound`) →
    re-`watchSession(old)` and notice "_This daemon can't switch sessions on
    one connection — /exit, then `connect --resume <id8>`._", nothing changed;
    resolved → `swapSession(sessions.open(id, reopen))`, panel closed. The new
    session's `open()` failure is the existing notice (`App.tsx:1112-1118`)
    PLUS a swap to a fresh lazy session, so the view never stays on a session
    that is not open. `delete` → `sessions.remove(id)` then re-list.
  - `/close` → `sessionRef.current?.close?.()` then `exit()` (the runtime's
    exit path drains the close: `drain()` on `connect`, `dispose` → saves +
    `closeSessions` on the others, `local-runtime.ts:379-384`).
  - **`/clear` on `connect`** (QN1, recommended detach + new): with
    `detachOnQuit`, `/clear` calls `detach?.()` instead of `close?.()` — on a
    rejection (`MethodNotFound`) it falls back to today's close (the user asked
    for a fresh session; an older daemon can only close), with the notice
    "_this daemon can't keep it running — the old session was ended_". Then
    `swapSession(makeSession())` and the notice "_left <title8> running on the
    daemon — /sessions to return_". Worker/pods: close, as today.
  - **Closed elsewhere** (`App.tsx:1063-1066`): on the `closed` activity —
    live (`session_closed`) or refused on reconnect (the client's new
    `ended`) — `pushNotice(closedNotice(reason) + "_ — what you type next starts
    a new session (/sessions to reopen it)._")`, then `swapSession(makeSession())`
    WITHOUT resetting the transcript (it stays as scrollback; the next prompt
    goes to the fresh session). Pure: `closedNotice` gains the suffix in
    `turn-feed.ts`. A turn running at that moment has already failed (P2); the
    notice follows its error. Only while idle is the swap immediate; a `closed`
    that arrives while in flight is held by `nextStep` like today
    (`App.tsx:1058-1061`) and applied after.
  - `quitAction(…, foreign, detachOnQuit)` at the `/exit` call site
    (`App.tsx:1325-1331`); the Ctrl+C site (`:1745`) is unchanged (Ctrl+C
    mid-turn = stop).
  - The comment at `App.tsx:1322-1324` ("`connect` still closes the session on
    exit until task 7") is removed.

#### Interplay with the merged tasks *(re-plan 2026-10-25)*

- **Task 6, switching away while a foreign turn streams**: refused —
  `sessionsChoose` reads `stateRef.current.running`, which is true for a
  foreign turn (it streams through the same loop, `App.tsx:1084-1092`). The
  only window is a `turn_start` arriving between the user's Enter and the
  detach: closed by unsubscribing A's `watch` in the same synchronous step,
  and by `RemoteSession.detach()` ending A's foreign stream without outcome.
  A's turn runs on daemon-side.
- **Task 6, switching back mid-foreign-turn = replay**: the target's eager
  open resyncs; the first page names the running turn, so the reset starts a
  foreign turn with the replayed history (`remote-session.ts:872-903`,
  repro (2)). Nothing new.
- **Task 6, Ctrl+C / Esc after a switch**: the abort handle is the streamed
  turn's (`abortRef`, `App.tsx:1084-1086`); a foreign activity's `cancel`
  closes over ITS session's id and turn id (`remote-session.ts:850-852`), an
  own turn's over its own (`:667-670`). After the swap A's stream is ended and
  no handle of A remains; a late Esc in B names B's turn, and a stale id is a
  daemon no-op (P7 c).
- **Task 5, rows of a detached client**: my ACKED rows stay in the daemon's
  queue: the running turn drains them, or they become `returned` to their
  writer at its end. The writer's identity is `RemoteSession.mine`, in memory
  (`remote-session.ts:134`), so after a quit + `--resume` (a NEW
  `RemoteSession`) or a switch back, this TUI no longer knows them as mine:
  they wait daemon-side, visible only where others' `returned` rows are shown
  (task 13, QR2 of task 6). Unacked local rows at quit are lost as today. →
  QN2. A switch is refused while a turn runs, so a switch never strands rows
  mid-turn; compaction-time rows go back to the input through
  `swapSession` (as `/clear`).
- **2a, archive / tombstones / reopen**: `--resume <id>` reopens
  (explicit); a `/sessions` row reopens only if it was listed archived (a live
  row archived between list and choose → `SessionArchived` → notice "_it was
  ended meanwhile — /sessions to reopen it_", fresh lazy session); a deleted
  id → `SessionDeleted` (and `onSessionDeleted`), never recreated (P7 a); a
  reopen past `--max-sessions` → `TooManySessions`, the record stays archived
  (2a), shown as the error.
- **Task 3, titles**: `/sessions` shows the list's `title` (the daemon's;
  re-listed on each open). A live `session_title` while the panel is open is
  not applied (debt, below).

#### What the laptop store keeps for a detached session

**Nothing — unchanged.** `connect` has never kept a laptop copy
(`connect.ts:121-132`, no saver), and adding one now would make a SECOND
truth for a session other devices keep changing (the owner's principle). The
`serve` daemon is trusted and persists (AGENTS §7 "Persistence"); `connect
--resume` reads `session/list`, never `<configDir>/sessions`. Per owner Q4 this
task adds one line to AGENTS §7 "Persistence" (rides this branch): "`connect`
keeps no laptop copy — the `serve` daemon's record is the truth; `--resume`
and `/sessions` read `session/list`."

#### Seams left for later tasks

- Task 11/13 (app): `session/detach` is what an app switching sessions on one
  connection calls; `planConnectResume`'s list rules are pure and reusable.
- A live `session_title` could refresh an open `/sessions` panel (one more
  reducer case).
- Mid-turn switching would extend `sessionsChoose` + `RemoteSession.detach`
  (which already ends a foreign stream without outcome).

### Files

*(re-plan 2026-10-25: dependency order, one branch)*

1. `packages/protocol/src/session.ts` — `// --- session/detach` block,
   `DetachParamsSchema`, `DetachResultSchema`.
2. `packages/protocol/src/methods.ts` — `Method.Detach`, `RequestSchemas`
   entry; `packages/protocol/schema/protocol.json` regenerated
   (`bun run schema:export`).
3. `packages/daemon/src/connection.ts` — `case Method.Detach`,
   `detachSession`, shared `release(entry)` with `close()`.
4. `packages/client/src/remote-client.ts` — `detachSession`, `drain` (+ the
   `ending` set in `endSession`), `liveSessionIds`, `failSession` → listener
   `ended?(reason)` by code; the `SessionStreamListener` type gains `ended?`.
5. `packages/client/src/remote-session.ts` — `sessionId`, `detach`, `ended`,
   the F1 cancel.
6. `packages/cli/src/flags.ts` — `ARGS.connect`, `USAGE.connect`.
7. `packages/cli/src/connect-resume.ts` (new, pure).
8. `packages/tui/src/session-picker.ts` — `SessionChoice` optional fields,
   meta (needed by 7's types; `tui` is a dependency of `cli`).
9. `packages/tui/src/commands.ts` — `/sessions`, `/close`, `SESSION_MUTATING`,
   `quitAction(…, detaches)`.
10. `packages/tui/src/turn-feed.ts` — `closedNotice` suffix.
11. `packages/tui/src/sessions-panel.ts` (new, pure).
12. `packages/tui/src/panel.ts` — the `sessions` kind.
13. `packages/tui/src/run.tsx`, `App.tsx` — options, `SessionController`
    members, `swapSession`, `/sessions`, `/close`, `/clear` on `connect`,
    closed-elsewhere swap, panel route, `quitAction` call site.
14. `packages/cli/src/connect.ts` — resume pre-mount, first-session factory,
    `detachOnQuit`, directory, `drain`, exit line; `packages/cli/src/main.ts`
    — pass the resume request, `HELP`.
15. Docs (ride the branch): this doc; `AGENTS.md` §7 "Persistence" line (owner
    Q4); `README.md` `connect` section (`:80`: flags, quit = detach,
    `/sessions`, `/close`, `/clear`); `TODO.md` row.

### Failure modes

*(re-plan 2026-10-25: rewritten; each says how state converges)*

- **Quit mid-own-turn (connect).** `/exit` → `exit()` at once, no
  `session/cancel` (`quitAction` "exit"); the generator fails on
  `client.close()` (`linkClosed`, `remote-session.ts:978-980`) after Ink
  unmounted — nothing is rendered. Daemon: socket close → detach, turn runs on
  (repro (2)). A pending ask waits for the next device (P1). Converges: the
  next `--resume` attaches and replays.
- **Quit mid-foreign-turn (QR4).** Same, and now nothing closes the session:
  the phone's turn ends `end_turn` (red today: repro (1) `cancelled`).
- **Quit right after `/clear` / `/close` / a delete.** The end is
  fire-and-forget; `drain()` awaits it (bounded) before `client.close()`. Hung
  daemon → the bound expires, the socket closes, the session is merely
  detached (archived later by the TTL) — the worst case is today's "close
  lost", never a wrong close.
- **Link down at quit.** No frame can go out; the dropped socket already
  detached everything daemon-side. `drain` resolves at once.
- **Disconnect mid-switch.** Before the detach is sent: `detachSession`
  forgets locally and resolves (the load-bearing assumption: the drop
  detached it). After
  it is sent, before the answer: the call rejects with the peer → treated as
  done (forget), and `recover` skips a `closing` entry (`remote-client.ts:1221-1224`),
  so A is never re-attached. The new session's open waits for the link
  (`whenLive`); the link closed for good → the open rejects → notice + fresh
  lazy session.
- **Detach racing a `turn_start`.** The view is idle at choose time (else
  refused). A phone's turn that starts in the gap reaches A's `RemoteSession`
  after `watchSession(null)`: buffered in A's `unwatched` and dropped with A;
  `detach()` ends any foreign stream without outcome; a permission dialog for
  it is withdrawn by `router.sessionClosed` on the detach answer (P3) — an
  answer given first goes to A (first wins, harmless). The turn runs on.
- **Older same-version daemon (`MethodNotFound`).** Switch: refused, notice,
  A untouched (re-watched). `/clear` on `connect`: falls back to close, said
  so. `--resume` / `/sessions` list without `session/list` → the "too old"
  error. Quit needs no method.
- **`--resume <id>` of a vanished / deleted / archived id.** Eager open
  pre-mount: deleted → `SessionDeleted`, unknown → `UnknownSession` → plain
  error, exit 1, nothing created (repro (3)); archived → reopened (explicit).
  `TooManySessions` → error, record stays archived.
- **A listed session closed/deleted between list and choose.** Pre-mount:
  error, exit 1. In-TUI: the detach of A already happened (detach first, then
  open — the opposite order would hold two attachments and double-route
  prompts), so the failed open lands on a fresh lazy session with the notice.
- **Closed by another client while attached, idle** → `closed` activity →
  notice + fresh lazy session; no command ever hits the dead id. **Mid-turn**
  → the turn fails (P2), the activity is held, then the same notice + swap.
  **Our own `/clear` / `/close`** → `closed` already set → no activity
  (`remote-session.ts:956-959`, pinned by task 6; re-asserted here).
- **Closed or deleted elsewhere while OUR link was down** → the reconnect is
  refused by code → `ended(reason)` → the same notice + swap (red today: only
  the buffered `onError`).
- **Two clients switching the same session.** Each detach removes only its
  own connection's attachment (`this.attached` is per connection); A and B
  can both be attached, both leave, both come back — `session/list.attached`
  counts them. Both deleting: the second `session/delete` is a no-op success
  (2a).
- **An unreadable frame during a foreign turn (F1).** The foreign stream fails
  HERE; no cancel is sent; the phone's turn runs on. During my own turn: the
  cancel names my turn (and my waiting send-now), never another.
- **Many detached sessions** → `--max-detached-sessions` archives the oldest
  idle one (2a) — by design, decision 4.
- **Clock skew** → ages from the daemon's `updatedAt` against the local
  clock; `pickerAge` clamps a future stamp to "just now"
  (`session-picker.ts:41-44`). Display only; order is the daemon's.
- **Hostile/odd daemon strings** → titles are one-line, control-free by schema
  (`session.ts:644-645`) and still pass `oneLine` (bidi/zero-width,
  `commands.ts:49`); `sessionId` is shown only as `oneLine(id).slice(0, 8)`,
  used verbatim only as the opaque key.

### Tests

*(re-plan 2026-10-25)*

Red first: each test below is run on the unchanged code and shown failing (or,
for new modules, failing to import) before its slice is implemented. Mutations
named per test.

- **daemon** (`packages/daemon/test/` — the connection test file that covers
  `session/close`): `session/detach` → the session stays live, `attached`
  drops, the turn keeps running, updates stop reaching this connection while
  another connection still gets them; unknown id → `{}`; a model-serving
  connection cancels the turn. Mutation: drop the `hosted.detach` call →
  `attached` stays 1 → red.
- **client** (`packages/client/test/`):
  - `detachSession` withdraws that session's open prompt (a `SpyBroker`-style
    broker sees the abort) and not another session's; rejects `MethodNotFound`
    keeping the entry (a later `closeSessions` still closes it); resolves while
    down; a drop after the frame → `recover` does not re-open it. Mutation:
    leave `closing` unset → the reconnect re-attaches A → red.
  - `drain` awaits a close issued just before it over the in-memory pair.
    Mutation: `drain` returns at once → the close is dropped → red.
  - **F1**: a foreign turn streams; a malformed known-type frame → NO
    `session/cancel` frame is sent, the foreign stream fails; with an own turn
    → exactly `cancel{sessionId, turnId: own}`. Red today (blind cancel, repro
    (4)). Mutation: restore `cancel(this.id)` → red.
  - **reconnect refusal**: A's link drops, B closes (archived) / deletes S, A
    reconnects → A's `RemoteSession` raises `closed{closed}` / `closed{deleted}`
    (on the existing `reattach.test.ts:1521` / `:1624` fixtures). Red today
    (no activity). Mutation: map by message text instead of code → a test with
    an `RpcError` of the right code and different text stays red.
  - `RemoteSession.detach` ends a foreign stream without a `turn_end` and
    refuses a later send locally (no frame).
- **cli**:
  - `connect.test.ts` — FLIP `:189-230` into **"quitting detaches: the
    session stays live, its turn running"**: gated model, quit mid-turn via the
    injected `startTui`, assert `host.size === 1`, `{ running: true, attached:
    0 }`, and a second client's attach sees it. Red today (`host.size` 0).
    Mutation: put `closeSessions()` back → red.
  - `connect.test.ts` — **QR4**: a second client's turn running in the
    connect session survives the quit (`turn_end` reason `end_turn`, repro (1)
    as a test). Red today (`cancelled`).
  - `connect.test.ts` — **"/clear then quit"**: the old session is closed
    (or detached, per QN1) and the new one detached; the `drain` property.
    Mutation: drop `await client.drain()` → red.
  - `connect.test.ts` — **resume**: `--resume <id>` attaches (its `history`
    activity reaches the controller `startTui` gets); a deleted / unknown id
    rejects before `startTui` is called, and `host.size` is unchanged;
    `--continue` takes `sessions[0]` (an archived one is reopened); empty list
    → a new session + the line; `MethodNotFound` on the list → the error.
    Mutation: build the first session without `attach` (lazy create) → the
    unknown-id test sees a created session → red.
  - `connect.test.ts` — **exit line**: after quit, `write` received
    `[connect] left session <id8> …` exactly once, AFTER `startTui` resolved
    (P9); none for a fresh session never sent to.
  - `connect-resume.test.ts` (new, pure): every rule of `planConnectResume`,
    incl. no-TTY fallback, `reopen` per row, the error texts.
  - `flags.test.ts`: `connect --resume`, `--resume <uuid>`, `--resume=<any>`,
    `--continue`, the conflict.
- **tui**:
  - `commands.test.ts`: `quitAction("command", true, false, false, true)` →
    `"exit"`; Ctrl+C mid-turn with `detaches` → still `"stop"`; `/close` is
    session-mutating, `/sessions` is not.
  - `sessions-panel.test.ts` (new, pure): rows (markers, `on N devices`
    minus one on the current row, `oneLine` on a bidi title, 8-char id, footer
    when `more`), keys, `sessionsChoose` (current → stay; busy → refused,
    including a foreign turn; archived row → `reopen: true`), delete arming and
    disarming, current-row delete refused.
  - `session-picker.test.ts`: daemon-entry meta ("running · on 2 devices ·
    archived") next to the unchanged "N msgs".
  - `app.test.tsx` / `foreign-turns.test.tsx` (ink-testing-library, the
    repo's pattern): (a) `detachOnQuit` + `/exit` mid-own-turn → the app exits
    and the fake controller saw NO abort (red today: "Stopping the turn…");
    (b) `/sessions` with a fake directory → rows; Enter on another row →
    `detach` then `open` in that order, the new controller is watched and
    opened, transcript replaced by its `history`; a rejected `detach` → notice,
    controller unchanged and still watched; (c) Enter while a foreign turn
    streams → refused notice, no `detach`; (d) no directory → "isn't
    available"; (e) a `closed{deleted}` activity while idle → the notice, and
    the next prompt goes to a NEW controller (red today: the same controller
    refuses it); (f) `/close` → `close` called, app exits; (g) `/clear` with
    `detachOnQuit` → `detach` called, not `close` (per QN1); its
    `MethodNotFound` → `close` + notice. Mutation for (b): open before detach →
    the order assertion fails.

Gate before done: `bun run check` (typecheck → lint → test), lint baseline
clean (AGENTS §6).

### Notes / debt

- Rows of mine left `returned` after a quit or switch are not handed back to
  this TUI (QN2).
- An open `/sessions` panel does not follow live titles (re-listed on each
  open).
- `/sessions` shows the first page (≤ 200, `MAX_SESSION_LIST`); a footer says
  more exist. Paging is later.

### Questions for the owner (re-plan)

*— claude-opus-5-5, 2026-10-25*

- **QN1 (task 6 QR3) — `/clear` in `connect`: detach + new, or close + new?**
  Today `/clear` ends the session for every device (the phone sees "closed on
  another device"). Decision 4 says "`/clear` = close + new", but also "leaving
  detaches, never closes; ending is explicit — `/close`". With `/close` now
  the explicit end, **recommend: in `connect`, `/clear` = detach + new** (the
  old session stays running and listed, `/sessions` returns to it, the idle
  TTL archives it — nothing is purged); worker/pods keep close + new (their
  daemon dies with them). Side effect: task 5's debt "`/clear` closes before a
  reclaim, so rows stay in the archive" no longer applies on `connect`. Cost:
  many `/clear`s leave many live sessions until the TTL / detached cap — by
  design. Alternative: keep close + new (decision 4 literally); then the
  `/clear` row of the table and test (g) change, nothing else.
- **QN2 — my queued rows after a quit or a switch.** "Mine" is in memory
  (`RemoteSession.mine`), so rows I queued and the turn did not drain come
  back `returned` to a writer that no longer exists: after `--resume` or a
  switch back this TUI does not recognise them, and the TUI does not show
  others' returned rows (task 6 QR2 → task 13). They are not lost (the daemon
  keeps them; the phone of task 13 shows them), but the terminal user does not
  see them. **Recommend: accept in task 7, record as task 13 debt** (task 13
  owns returned rows of other writers, and F2 must be solved there first).
  Alternative: on `/exit` / switch with rows of mine still waiting, a notice
  "N queued messages stay on the daemon" — small, but it cannot say what
  happens to them later.

### Owner answers (re-plan)

*— recorded by the orchestrator (claude-opus-5-5), 2026-10-25*

- **QN1: keep `/clear` = close + new in `connect` too** (decision 4
  literally; the recommendation "detach + new" is rejected). Owner: "preferisco
  come è oggi, non voglio ambiguità tra telefono e TUI per una stessa
  sessione". So: the old session is closed (archived, reopenable, never
  purged), the phone sees it closed, `/clear` stays refused while any device's
  turn runs (task 6). The executor applies the alternative noted under QN1:
  the `/clear` row of the Design table and test (g) change accordingly;
  task 5's debt "`/clear` closes before a reclaim" still applies on `connect`.
- **QN2: accept + a notice.** Rows I queued that come back `returned` after a
  quit / switch are not recognised as mine by this TUI (in-memory `mine`):
  accepted in task 7 and recorded as **task 13 debt**. PLUS the small
  alternative: on `/exit` or a session switch with rows of mine still
  waiting, the TUI shows a notice "N queued messages stay on the daemon"
  (English, TUI strings). Owner: "ok" (2026-10-25).

## Execution

*— claude-opus-5-5, 2026-10-25*

Implemented in the plan's order (protocol → daemon → client → cli → tui →
connect/main → docs) on `feat/connect-sessions`, uncommitted. Every file:line
premise was re-checked before its edit and held (line numbers drifted only by
my own edits). The run moved accounts once mid-task (session limit); it
resumed from `git status --short` with nothing lost.

### Baseline

`bun run check` on `0b1d89f` + the plan doc: typecheck clean, `biome check .`
471 files, 0 errors / 0 warnings. The test run raced my first protocol edit
(I added `Method.Detach` while `bun test` ran), so it reported **2678 pass / 2
skip / 2 fail**: the 2 fails are exactly `protocol/test/json-schema.test.ts`'s
drift gate and fixture-completeness test, caused by that edit (schema not yet
regenerated). Pre-existing suite = **2680 pass / 2 skip / 0 fail**, as
expected. Not re-taken on a clean tree.

### Repro (before / after)

`.tentacle/tmp/connect-sessions/repro.ts` (the plan's) could not be run as a
script in this sandbox (`bun <file>` needs approval); it was copied to
`repro.test.ts` (same body, a trailing no-op `test()`, run with `bun test`).
Before any behaviour change (protocol additive only):

```
(1) phone turn running, TUI attached too: [{"id":"e352925b","running":true,"attached":2}]
(1) after connect quit: [] phone turn events: ["text","turn_end:cancelled"]
(2) after socket close: [{"id":"ca9a635c","running":true,"attached":0}]
(2) 2nd client eager attach, activities: ["history","turn"] …
(2) foreign turn events on the 2nd client: ["user_message","text","text","text","turn_end:end_turn"]
(3) open of a closed id threw: unknown session: … | sessions before/after: 0 0
(4) TUI foreign stream: ["user_message","text","throw:malformed agent_message_chunk update from the daemon"]
(4) phone's OWN turn events: ["text","text","text","turn_end:cancelled"]
```

After the change the same script hangs in (1): the phone's turn is no longer
cancelled, so it waits on the gate the script opens only after awaiting it.
`repro-after.test.ts` opens the gates first, nothing else changed:

```
(1) after connect quit (still running, TUI gone): [{"id":"bd326fce","running":true,"attached":2}]
(1) phone turn events: ["text","text","text","turn_end:end_turn"]
(4) TUI foreign stream: ["user_message","text","throw:malformed agent_message_chunk update from the daemon"]
(4) phone's OWN turn events: ["text","text","text","turn_end:end_turn"]
```

(`attached: 2` in (1) is the repro's own wiring: its connect-side
`Connection` is never `close()`d — in production `ws-server` does that on
socket close, `ws-server.ts:234`.)

### What changed, in order

1. **Protocol** — `session.ts` `// --- session/detach` block (the plan's
   contract text), `DetachParamsSchema` / `DetachResultSchema`;
   `methods.ts` `Method.Detach` + `RequestSchemas` entry; `protocol.json`
   regenerated (`bun run schema:export`); the two fixtures added to
   `json-schema.test.ts`. No `PROTOCOL_VERSION` bump.
2. **Daemon** — `connection.ts`: `close()`'s per-session step factored into
   `private release(entry)` (servesModel ⇒ `cancel`, then `detach`);
   `case Method.Detach` → `detachSession` (synchronous, no lock; id not
   attached → `{}`). Tests in `registry.test.ts` "session/detach": only this
   connection stops listening (turn runs on, `attached` drops, A gets nothing
   more, a later prompt from A is `UnknownSession`, a re-open re-attaches);
   last detach → live with `attached: 0`, idempotent / unknown → `{}`;
   model-serving connection cancels. RED: 3/3 (`unexpected method`).
3. **Client** —
   - `remote-client.ts`: `detachSession` (through `endSession`, now also
     typed for `Detach`: marks `closing`; on answer or drop forgets it AND
     withdraws its prompts via `router.sessionClosed`; on `MethodNotFound`
     un-marks `closing` and rethrows); a private `ending` set of settled
     promises + `drain(timeoutMs)`; `liveSessionIds()` (everLive && !closing);
     `SessionStreamListener.ended?(reason)`; `failSession` maps
     `SessionArchived` → `closed`, `SessionDeleted` → `deleted` BY CODE,
     forgets the entry, withdraws its prompts, calls `ended` before the
     `fail` step (the `onError` line is kept).
   - `remote-session.ts`: `ended(reason)` = `onClosed(reason)`; F1 — the
     `error`-frame branch collects my unended `[active, next]` ids before
     `failAll` and sends `cancel(id, turnId)` for each, none otherwise;
     `get sessionId` (`id ?? desiredId ?? null`); `stayingRows()`; `detach()`.
   - `hand-back.ts`: pure `stayingRows(state, mine, handedBack)` (QN2).
4. **CLI** — `flags.ts` `ARGS.connect` gains `CONTINUE` / `RESUME` /
   `RESUME_CONFLICTS`, `USAGE.connect`; new pure `connect-resume.ts`
   (`needsList`, `planConnectResume`, `planPicked`, `openError`, `shortId`).
5. **TUI** — `session-picker.ts` (`SessionChoice.messageCount` optional +
   `running` / `attached` / `archived`, pure `choiceMeta`); `commands.ts`
   (`/sessions`, `/close`, `SESSION_MUTATING += /close`,
   `quitAction(…, detaches)`); `turn-feed.ts` `closedNotice(reason,
   canList)`; new pure `sessions-panel.ts`; `panel.ts` `sessions` kind;
   `App.tsx` (below); `run.tsx` options; `index.ts` exports.
6. **`connect.ts` / `main.ts`** — `ConnectOptions.resume`, `ConnectDeps.pick`;
   `resumeFirst` (list only when needed, the pre-mount picker, the eager
   attach pre-mount, `openError` by code); `createSession` hands the resumed
   session first, then fresh lazy ones; `detachOnQuit: true`; the directory
   (`list` → `sessionList({limit: MAX_SESSION_LIST})`, `more` from `cursor`;
   `open` → a NEW attach-only `RemoteSession`; `remove` → `deleteSession`);
   `finally`: `await client.drain()` (no `closeSessions`), live ids + staying
   rows read, `client.close()`, `sink.flush`, then the exit lines. `main.ts`
   builds the resume request, passes `pickSession` on a TTY, `HELP` updated.
7. **Docs** — AGENTS §7 "Persistence" line (owner Q4); README `connect`
   paragraph; this section.

`App.tsx` (effects only): `SessionController` gains `detach?`, `sessionId?`,
`stayingRows?`; new `SessionDirectory`; props `detachOnQuit`, `sessions`.
`swapSession(next, {keepTranscript?, onOpenFailed?})` is `/clear`'s old body
and the ONE swap path (`/clear`, the switch, closed-elsewhere, a failed
open); `/clear` = `close?.()` + `swapSession(makeSession())` on every
runtime (QN1); `/close` = `close?.()` + `exit()`; `/sessions` opens the panel
(no directory → "_Sessions aren't available on this runtime._", list error by
code); the `/exit` call site passes `detachOnQuit` (Ctrl+C untouched);
`closed` activity → `closedNotice` + `swapSession(makeSession(),
{keepTranscript: true})`; `switchTo` = `watchSession(null)` +
`watchReturned(null)` in one step, `await old.detach()`, then swap to
`sessions.open(id, reopen)` (rejection → re-watch old + notice);
`watchSession` takes an `onOpenFailed` callback. The panel key route for
`sessions` calls the pure `sessionsKey` / `sessionsChoose` / `sessionsDelete`
and only executes.

### Red → green, and mutations (each reverted; tree byte-identical by `shasum`)

| Test | RED on the old code | Mutation → red |
|---|---|---|
| daemon `session/detach` ×3 | 3/3 (`unexpected method`) | drop `hosted.detach` in `release` → 2 red; drop the servesModel branch → 2 red (incl. the existing close test). `connection.ts` back to `bb3bd27…` |
| reconnect refusal ×3 (`reattach.test.ts`) | 3/3 (no `closed` activity, timeout) | map by `/archived/.test(message)` → the "another text" test red. `remote-client.ts` back to `58c9109…` |
| F1 ×2 (`foreign-turns.test.ts`) | 2/2: phone turn `cancelled`; own cancel without `turnId` | restore blind `cancel(this.id)` → 2 red. `remote-session.ts` back to `d9e0231…` |
| detach withdraws only its prompt | — (`detachSession` written first) | drop `router.sessionClosed` in `forget` → red |
| drop after the detach frame → never re-opened | — | plan's mutation (no `closing`) stays GREEN — see nuance 3; no `closing` AND no forget-on-drop → red |
| `drain` awaits a late close | — | `drain` returns at once → red (only over a 10 ms-latency channel, see nuance 4) |
| MethodNotFound keeps the entry; RemoteSession.detach | detach: missing method | — |
| `stayingRows` (pure) | new | — |
| flags ×2 | 2/2 (`unknown option --resume`) | — |
| `connect-resume` ×9 | new module | failed list → `new` → red. Back to `4f7bbf4…` |
| picker meta | 1 red (`undefined msgs`) | — |
| `commands` ×2 | 2/2 | — |
| `closedNotice` | written with the change; pinned by App (e) | — |
| `sessions-panel` ×8 | new module | ignore `busy` → red. Back to `8a8f7c2…` |
| App (a)(b)(b2)(c)(d)(e)(f), x-delete, QN2 | 9/11 red; (g) and the worker case green (pins of unchanged behaviour) | (a) drop `detachOnQuit` at `/exit` → red; (b) open before detach → (b),(b2) red; (e) no swap → red. `App.tsx` back to `3f1169e…` |
| connect ×8 | 8/8 red (incl. drain: old `closeSessions` skips an entry already `closing`) | `closeSessions` instead of `drain` → 6 red; no `drain` → drain test red; first session without `attach` → 2 resume tests red; exit lines from `handed` instead of `liveSessionIds` → exit-line test red. `connect.ts` back to `d0db7fa…` |

The three carry-overs: **QR4** — connect "RED (QR4)" (phone `end_turn`, was
`cancelled`); **F1** — client F1 ×2; **QN1** — App (g) pins `/clear` = close +
new, refused while another device's turn runs (green before and after by
design: behaviour unchanged).

Existing tests changed (planned behaviour, never weaker): `remote.test.ts`
four assertions `[{sessionId}]` → `[{sessionId, turnId: <own>}]` (F1; the
fakes now record the prompt's turn id); `connect.test.ts` "quitting ends the
sessions it opened" replaced by the new suite (the plan's flip);
`mcp-panel.test.ts` imports `TreePanel as OpenPanel` (type-only, see nuance 9).

### Gate (final)

`bun run check`: typecheck clean; `biome check .` 476 files, 0 errors / 0
warnings; `bun test` **2736 pass / 2 skip / 0 fail** (10 270 expects, 213
files). Baseline 2680 + 56 new tests; the 2 skips are the opt-in ones.

### Drift from the Implementation, and every nuance decided

1. **QN1 applied (owner):** `/clear` stays close + new on `connect`; no
   detach-on-`/clear`, no `MethodNotFound` fallback for it. Test (g) pins it.
2. **`ended` also forgets the entry and withdraws its prompts** (plan: only
   raise `closed`): else `liveSessionIds()` would list a dead session in the
   exit line, and a prompt for it could stay up.
3. **The plan's `closing` mutation is vacuous by construction**: a drop
   rejects the in-flight detach (→ `forget`) before any redial's `recover`
   runs. Either mechanism alone suffices; removing both turns the test red.
4. **`drain`'s non-vacuity needs latency**: on the in-memory pair any `await`
   delivers the queued frame, so the client and connect tests use a channel
   that sends 10 ms late. On the old code the connect drain test was red
   for the plan's stated reason (`closeSessions` skips an entry already
   `closing`).
5. **`RemoteSession.detach()` cleans up only after the daemon answered**
   (plan: unsubscribe first). The view already unwatched it; on a
   `MethodNotFound` the held activities are then handed back on re-watch.
   `closed` is set at once (sends refused while in flight), restored on
   rejection.
6. **`switchTo` also unwatches the returned rows** (`watchReturned(null)`)
   in the same step, re-watched on rejection.
7. **QN2 notice placement**: on a switch, the TUI notice ("N queued messages
   stay on the daemon") is pushed after the swap (the swap resets the
   transcript). On `/exit` a TUI notice would vanish with the unmount, so the
   count goes into connect's exit lines instead: `[connect] N queued
   message(s) stay on the daemon in session <id8>`. Owner asked for "a
   notice": this is the honest equivalent at exit; flag if a TUI-side one is
   wanted anyway.
8. **A failed open after a switch → fresh lazy session** via a callback
   passed only on the switch path (not generically in `watchSession`): a
   factory returning the same failing controller would otherwise loop.
9. **`panel.ts` types**: `OpenPanel = TreePanel | SessionsPanel`;
   `mcpPanel`/`skillsPanel` return `TreePanel`, `applyPanel`/`panelClick`
   have overloads (TreePanel → TreePanel) — no casts. Plan named the fields
   `cursor`, `armed`; they live in `state: SessionsState` plus `current`
   (the current id at open) and `now` (ages).
10. **Panel key route**: a `sessions` key that maps to no action falls through
    like the tree panels (mouse reports reach the click path; any other key
    disarms a pending delete). A click selects a row.
11. **Picker meta for a daemon entry**: "running · on N devices · archived",
    else **"idle"** (never an empty meta). Rows in `/sessions`: `title  age ·
    id8 · current · running · on N devices · archived` (current row counts
    `attached − 1`).
12. **`openError` / `sessionsListError` / `openFailedNotice` decide by code**;
    the TUI copies the two codes it needs (it does not depend on
    `@tentacle/protocol`, like `send-now.ts`). A listed-live row archived
    meanwhile → "_it was ended meanwhile — /sessions to reopen it_".
13. **`--resume` without a TTY** = no `pick` dep → newest. A cancelled picker
    writes `[resume] cancelled` and returns (exit 0). The resume line
    (`[resume] <id8> — <title>`) is written pre-mount after a successful
    attach.
14. **`closedNotice(reason, canList)`**: only a closed (archived) session
    offers "(/sessions to reopen it)", and only when the runtime lists.
15. **A delete failure** has its own notice ("_Couldn't delete the
    session: …_"); after a delete the panel re-lists (cursor back to 0).
16. **New built-ins `/sessions`, `/close`** now shadow any skill named
    `sessions` / `close` (BUILTIN_NAMES).
17. **The connect test of "quit detaches"** calls `conn.close()` after quit —
    what `ws-server` does on socket close; the in-memory pair does not. Its
    second client sees `["history", "turn"]` (as repro (2)).
18. **`TODO.md` row not touched**: there is no `connect-sessions` row to
    update; the index is the orchestrator's (direct-to-main carve-out).
19. **`MethodNotFound` on `session/list` at the connect level** is covered by
    the pure `planConnectResume` test only (wiring is the generic failed-list
    path).

### Open items for the owner

- The QN2 count at `/exit` is in the post-exit lines, not a TUI notice (7).
- While a switch's detach is in flight, a prompt typed in that window is
  refused by the old session ("this session was closed") — a tiny window,
  not designed out.
- An open `/sessions` panel does not follow live titles; first page only
  (≤ 200, footer) — as planned debt.

### Fix 1 (Review)

*— claude-opus-5-5, 2026-10-26*

**R1 (MEDIUM) — an in-flight switch was not latched.** Root cause: `switchTo`
marked nothing between `watchSession(null)` and the detach's answer, so a
second `/sessions` pick, `/close`, `/clear` or a prompt acted on the old,
already-`closed` session (a second switch left a session attached and
followed by nobody; `/close` / `/clear` only detached). This also closes the
open item above ("a prompt typed in that window").

Changes:
- `packages/tui/src/sessions-panel.ts` (pure): `SWITCHING_NOTICE`,
  `SWITCHING_PROMPT_NOTICE`, `switchingRefusal(switching, {kind: "prompt"} |
  {kind: "command", name})` — while switching, a prompt (a skill activation
  too) and `/clear`, `/close`, `/retry`, `/compact`, `/rename` are refused;
  `/exit` (quit only detaches), `/sessions` (a read) and the read-only
  commands stay allowed. `sessionsChoose(…, switching = false)` refuses any
  row while switching, before the busy and current checks.
- `packages/tui/src/App.tsx` (wiring only): `switchingRef`; `switchTo` sets it
  before the detach and clears it on every outcome — detach refused (old
  re-watched), `sessions.open` throwing (notice + fresh session), and the
  target's open settling (ok, or failed → fresh session). `watchSession`'s
  callback became `onOpened(ok)`, called on success too, and at once when the
  controller has nothing to open (a local session), so the latch can never
  stick; `swapSession` forwards it. The panel's choose passes the latch;
  `handleCommand` checks `switchingRefusal` for skills and commands; `submit`
  checks it for a plain prompt. A refused prompt / skill goes back to the
  input with the notice (never lost, never sent to the old session).

Tests (`tui/test/connect-sessions.test.tsx` "an in-flight switch is latched
(Review R1)"; `tui/test/sessions-panel.test.ts` "a switch in flight"):

| Test | Old code | Mutation (reverted) |
|---|---|---|
| second switch during the detach → refused; only B opened, A detached once, B followed, C untouched | RED (no notice; C opened) | `sessionsChoose` ignores `switching` → red (also the pure test) |
| `/close` during the switch → refused, nothing closed, no exit; works after | RED (A.close) | guarded commands not refused → red |
| `/clear` during the switch → refused; a prompt typed meanwhile back in the input, not sent to A | RED (A.close) | same mutation → red |
| a refused detach clears the latch | green (no latch existed) — convergence pin | keep the latch on the refused-detach branch → red |
| a target that fails to open clears the latch | green — convergence pin | keep the latch when the open fails → red |
| pure `switchingRefusal` / `sessionsChoose(…, true)` | new | see row 1 |

After the mutations `shasum` matched (`App.tsx` `5f8b294…`, `sessions-panel.ts`
`354292c…`). After that, one lint-only edit to `App.tsx`: `restoreInput`
added to `submit`'s deps.

The reviewer's repro (`.tentacle/tmp/connect-sessions-review/double-switch.test.ts`)
after the fix:

```
journal: ["A.watch","A.open","A.unwatch","A.detach","A.detached","dir.open:B","B.watch","B.open",
          "B.unwatch","B.detach","B.detached","dir.open:C","C.watch","C.open"]
```

A is detached once, and C is opened only after B was detached. The repro's
pick of C mid-switch was refused; its later `hello`+Enter lands in the
`/sessions` panel, which stays open after a refusal (the same as the
existing busy refusal), so Enter chooses C: an ordinary switch after the
first one settled. No session is left attached and unfollowed.

Nuances: a hung target open (link down) keeps the latch until that open
settles (the client rejects it when the link closes for good). `/exit`
stays allowed mid-switch: quitting only detaches. R2 and R3 are untouched
(owner).

Gate: `bun run check` green. Typecheck clean, `biome check .` 476 files with
0 errors and 0 warnings, `bun test` **2743 pass / 2 skip / 0 fail** (+7 tests).

### Fix 2 (owner R3)

*— claude-opus-5-5, 2026-10-26*

The owner decided R3 on 2026-10-26: deleting with `x` twice stays allowed for
a session that is running on another device, but the confirmation says what
will happen.

- `packages/tui/src/sessions-panel.ts`: new pure `deleteConfirmHint(entry)`,
  used by `sessionsView` for the armed row. If the entry's `running` (the
  daemon's `session/list` state, never text) is true, the hint is exactly
  "press x again — its running turn on another device will stop". Otherwise
  it is today's "press x again to delete <title> · any other key cancels".
  The armed row is never the current session (`sessionsDelete` refuses it),
  so a running turn there belongs to another device. `App.tsx` is unchanged:
  it renders the view's hint.
- Tests (`tui/test/sessions-panel.test.ts`):
  - A running entry shows the new hint. RED on the previous code: it showed
    the plain confirmation.
  - A non-running entry keeps the plain confirmation, even with 2 devices
    attached and a title that says "running turn". Green before and after:
    a pin.
- Mutation: ignore `running` → red. Reverted; `shasum`
  `sessions-panel.ts` `530971c…` identical.
- Nuance: `running` is also true for a turn that runs with no device
  attached (a detached session). The message's "on another device" is the
  owner's wording; deleting still stops that turn.
- Gate: `bun run check` green. Typecheck clean, `biome check .` 476 files with
  0 errors and 0 warnings, `bun test` **2745 pass / 2 skip / 0 fail** (+2).

### Fix 3 (Review round 2)

*— claude-opus-5-5, 2026-10-26*

**R2-1 (MEDIUM): `/sessions` during a switch kept the old session as
current.** The panel captured `current` when it opened. If it opened
mid-switch, that was the detaching session. After the switch, `x x` on the
new current session deleted the session being viewed (reviewer repro
`round2.test.ts` A1).
- `sessions-panel.ts`: `/sessions` added to `SWITCH_GUARDED`. Mid-switch it
  is refused with the same `SWITCHING_NOTICE`, and the doc comment is
  updated.
- `App.tsx` `swapSession`: an open `sessions` panel gets `current =
  next.sessionId`. `sessionRef` is the one source, and every swap updates the
  panel (`/clear`, a switch, closed elsewhere, a failed open). The key route
  still reads `panel.current`, which is now always the live id.
- Pure test: `/sessions` moved from the allowed list to the refused list
  (`sessions-panel.test.ts`).

**R2-4 (LOW): the latch release in the `sessions.open` throw branch was
untested.** New test: a directory whose `open` throws gives the notice and a
fresh session, and `/close` is then not refused (the app exits).

| Test (`connect-sessions.test.tsx`) | Old code | Mutation (reverted) |
|---|---|---|
| `/sessions` refused mid-switch; after the switch, `x x` on B (current) refused, no `dir.remove:B` | RED (panel opened, no notice) | drop `/sessions` from `SWITCH_GUARDED` → red |
| an open panel follows a swap (A closed elsewhere → A's `x` arms, not refused) | RED (refused "you are in") | drop the panel sync in `swapSession` → red |
| R2-4: open throws → latch cleared | green (coverage test) | M1, drop `switchingRef.current = false` in the throw branch → red |

After the mutations `shasum` matched (`App.tsx` `ac6016a…`,
`sessions-panel.ts` `3356791…`). After that, one formatting-only edit to
`App.tsx` (`biome check --write`). R2-2, R2-3 and R2-5 are untouched (owner).

Gate: `bun run check` green. Typecheck clean, `biome check .` 476 files with
0 errors and 0 warnings, `bun test` **2748 pass / 2 skip / 0 fail** (+3).

### Fix 4 (Review round 3)

*— claude-opus-5-5, 2026-10-26*

**R3-1 (MEDIUM, data loss).** Fix 3 synced a stored `current`, but closures
kept their own copies:
- the `/sessions` loader captured it when the panel opened;
- the post-delete reload captured it when `x x` was pressed, and re-opened
  the panel with `openPanel` even after the user closed it (a switch, Esc).

So `x x` could delete the session being viewed (reviewer repro
`round3.test.ts` B1, B2, B3).

The fix gives "current" ONE source: the live `sessionRef.current?.sessionId`,
read when it is used. It is never stored.
- `panel.ts`: `SessionsPanel` no longer has `current`, and
  `sessionsPanel(now, data?)` takes none. `panelView(panel, width, maxBody,
  current = null)` takes the live id; only the sessions kind uses it.
- `sessions-panel.ts` (pure): `sessionsRefreshApplies({startedGen, gen,
  open, switching})` is true only for the same panel generation, still
  `/sessions`, with no switch in flight. `refreshedSessions(state, view)`
  keeps the cursor in range and drops an armed delete.
- `App.tsx` (wiring only):
  - Render: `panelView(…, sessionRef.current?.sessionId ?? null)`.
  - Key route: `current` is read at the key, then given to `sessionsChoose`
    and `sessionsDelete`.
  - The `/sessions` loaders capture nothing.
  - `swapSession` re-renders an open sessions panel (`{ ...p }`) instead of
    writing a copy of `current`.
  - After a delete: it records `panelGenRef` when the delete starts. The
    re-list runs only if `sessionsRefreshApplies` holds when the remove
    resolves, and the result is applied only if it still holds when the
    list resolves. It updates the open panel in place and never calls
    `openPanel`.
  - A failed re-list says `sessionsListError`, no longer "Couldn't delete".
- Tests: `connect-sessions.test.tsx` "/sessions current is always the live
  session (Review R3-1)" and `sessions-panel.test.ts` (live-id marking, both
  pure helpers, call sites updated for the new signatures).

| Test | Old code | Mutation (reverted) |
|---|---|---|
| B1: the session closes elsewhere while the list loads → `x x` on the live N is refused, no `dir.remove:N` | RED (N deleted) | key route `current = null` (not the live id) → red |
| B3: a delete in flight, then a switch → the panel stays closed after the refresh; `x x` deletes nothing more | RED (panel re-opened) | re-open the panel unconditionally after remove (`openPanel`) → red |
| the refresh updates a panel still open (`Sessions (2)`, C gone) | green (pin of the legit path) | — |
| pure `sessionsRefreshApplies` / `refreshedSessions`, live-id marking | new | — |

After the mutations `shasum` matched (`App.tsx` `1aa199f…`,
`sessions-panel.ts` `5e20cac…`, `panel.ts` `4bce436…`). After that, one
formatting-only `biome check --write`. The reviewer's `round3.test.ts` now
fails on its own `expect` lines, because those asserted the bug. Journals
after the fix:
- B1: no `dir.remove:N`.
- B3: only `dir.remove:C`, and the panel is not re-opened.
- B2: `dir.remove:A`, which is legitimate (A was closed elsewhere and is no
  longer the session being viewed); N is never deleted.

R2-2, R2-3 and R2-5 are untouched (owner).

Gate: `bun run check` green. Typecheck clean, `biome check .` 476 files with
0 errors and 0 warnings, `bun test` **2753 pass / 2 skip / 0 fail** (+5).

### Fix 5 (owner R2-5, R4-1)

*— claude-opus-5-5 (orchestrator), 2026-10-26*

Owner: apply both now, no further review round.

- **R2-5:** `deleteConfirmHint` (`sessions-panel.ts`) keeps the title and
  "any other key cancels" for a running session too, and says where the turn
  runs from `attached` (the armed row is never current, so it counts other
  devices only): "press x again to delete <title> — its running turn on
  another device will stop · any other key cancels", or "… its running turn
  (no device attached) will stop · …" with `attached === 0`. Tests: the R3
  pin updated, a new `attached: 0` test; both red on the old wording.
- **R4-1:** the post-delete re-list's error notice is dropped when the panel
  closed meanwhile (`applies()` guard, `App.tsx`). Test "R4-1: a delete's
  re-list that fails after the panel closed leaves no notice" in
  `connect-sessions.test.tsx`: mutation (guard removed = the old code) → red;
  reverted, `App.tsx` `shasum` identical.

R2-2 and R2-3 stay as today (owner: not in this task).

## Review

> **Owner decision (2026-10-24): APPROVED as ONE task, no split** (L · cross-module; strong model, fresh-context Review). Branch `feat/connect-sessions`. Q2 yes: no session switch while a turn runs in v1 (the user is told to wait or stop it); quitting mid-turn still detaches. Q3 yes: delete from `/sessions` (`x` twice), via 2a's delete. Q4 yes: `/close` = end the session and quit; add the AGENTS §7 "Persistence" line that `connect` keeps no laptop copy (rides this branch). Q5: O1 (a reconnect revives an archived session) is fixed in 2a (owner, 2026-10-24) — here only verify it. The cryptic error after a session ended on another device → a notice and a fresh session. Depends on 2a and task 6 (eager open; opening a gone id must fail, not create an empty session).

*— claude-opus-5-5 (adversarial reviewer, fresh context), 2026-10-26*

**Verdict: REQUEST-CHANGES** — one finding (R1) leaves a silent wrong state on
the switch path; everything else holds. The fix is small and local to the App
(no protocol, client or daemon change).

> Same model as the executor (claude-opus-5-5); only the *context* is fresh.
> Shared blind spots can survive both passes; for a load-bearing task AGENTS
> §10 prefers a different model.

#### Findings

1. **R1 — MEDIUM — nothing guards a switch whose detach is still in flight**
   (`packages/tui/src/App.tsx` `switchTo`, ~`:1648-1674`; key route ~`:1925`).
   `switchTo` unwatches A and awaits `old.detach()`, but `sessionRef.current`
   stays A and nothing marks "switching". During that round trip:
   - **A second `/sessions` → Enter on C** runs `switchTo(C)` with `old = A`
     again. `RemoteSession.detach()` returns at once on a session already
     `closed` (`remote-session.ts:418-420`), so C is swapped in at once. Then
     the first detach resolves and swaps to B. **The view ends on B. C stays
     attached daemon-side and followed by the `RemoteClient`, and nobody
     watches it**: its permission prompts reach the single broker while the
     user looks at B, `liveSessionIds()` reports it, and it is never
     detached. Repro `.tentacle/tmp/connect-sessions-review/double-switch.test.ts`
     (real App, fakes whose `detach` is idempotent like `RemoteSession`):
     `["A.unwatch","A.detach","A.detach","dir.open:C","C.watch","C.open","A.detached","dir.open:B","C.unwatch","B.watch","B.open","B.send:hello"]`.
   - **`/close` in the window**: `close()` is a no-op on a session already
     `closed` (`remote-session.ts:378-380`), then `exit()`. **A is only
     detached, NOT ended**, and the user was told nothing (silent). `/clear`
     in the window does the same: A is not closed, and the fresh session is
     then overwritten by the late swap to B.
   - A prompt typed in the window is refused with "this session was closed".
     This is the window Execution admits under "Open items". It has the same
     root cause.

   Fix (executor's call): a `switching` latch set in `switchTo` and cleared
   when the switch settles. While it is set, `sessionsChoose` is `busy`, and
   `/close`, `/clear` and sends are refused (or held). Ship a regression test
   red on today's code: the double-switch journal above, and `/close` in the
   window must close.
2. **R2 — LOW, owner decision** — QN2 at `/exit` is printed only in
   `connect`'s post-exit lines (`packages/cli/src/connect.ts` `finally`,
   `[connect] N queued messages stay …`), not as a TUI notice. I judge it the
   honest equivalent: a notice pushed just before unmount is never seen, and
   the lines are written after Ink unmounted (P9 holds). On a switch it is a
   TUI notice, as asked. The owner should confirm that this placement
   satisfies "a notice".
3. **R3 — NIT** — a `/sessions` delete (`x` twice) of a row that is
   `running` on another device ends that turn. The row is marked `running`,
   but the "press x again" hint does not say so. Owner Q3 accepted delete as
   designed; consider "(its turn will stop)" in the armed hint.

#### Gate (re-run by me)

`bun run check`: typecheck clean; `biome check .` **476 files, 0 errors / 0
warnings**; `bun test` **2736 pass / 2 skip / 0 fail** (10 270 expects, 2738
tests, 213 files). The 2 skips are the opt-in ones. This matches the
orchestrator's post-reboot gate.

#### Mutations (each reverted; tree byte-identical)

| Mutation | Result |
|---|---|
| F1: blind `cancel(this.id)` restored in the `error` branch | 6 red (`foreign-turns` F1 ×2, `remote.test` ×4) |
| QR4: `closeSessions()` instead of `drain()` in `connectTui` | 6 red (quit detaches, QR4 phone `end_turn`, drain, resume, exit line, QN2) |
| reconnect refusal: drop `listener.ended?.()` in `failSession` | 3 red (`reattach.test` archived / deleted / by-code) |
| closed elsewhere: drop the swap in the `closed` activity | (e) red |
| QN1: `/clear` detaches instead of closing | (g) red |

After revert: `shasum` of `remote-session.ts` `d9e0231…`, `remote-client.ts`
`58c9109…`, `connect.ts` `d0db7fa…`, `App.tsx` `2f7c3b2…`, `connection.ts`
`bb3bd27…`. These are the same as before. `git status --short | shasum`
`145c123…` and `git diff | shasum` `d10c751…` did not change.

#### Changed existing tests (correction, not loosening)

- `remote.test.ts` ×4: `[{sessionId}]` → `[{sessionId, turnId: <own>}]`. This
  is stricter: it names the exact turn.
- `connect.test.ts` "quitting ends the sessions it opened": flipped as planned
  into the detach suite, under owner decision 4.
- `mcp-panel.test.ts`: a type-only alias (`TreePanel as OpenPanel`).
- `foreign-turns.test.ts`: only an import line changed.

No assertion was weakened. The baseline's 2 fails were the executor's own
schema drift; there is no hidden pre-existing failure.

#### Premise table (spot-checked)

| Premise | |
|---|---|
| Context symptom: quit closes, phone turn `cancelled` (repro 1) | TRUE on `0b1d89f` per executor log; after the change, `end_turn` is pinned by the QR4 test (red under my mutation) |
| `Connection.close()` only detaches; `servesModel` only via option, never `ws-server` | TRUE (`connection.ts:106`, `:132`; no match in `ws-server.ts`) |
| Peer dispatch not serialized (`peer.ts:322` `void this.handleRequest`); unknown method → `MethodNotFound` (`:334`) | TRUE; `detachSession` is synchronous |
| `PROTOCOL_VERSION = 11`, exact match | TRUE (`version.ts:7`); no bump, method additive |
| `UPDATE_CLASS` untouched | TRUE (no diff in `protocol/src/updates.ts`) |
| Unmount dismisses a prompt with no frame (`permission-ui.ts:12-16`, `:185`) | TRUE |
| `DomainErrorCode.SessionArchived = -32014` (copied in `sessions-panel.ts:213`) | TRUE (`jsonrpc.ts:48`) |

#### Attacks tried

1. **Double switch / `/close` during an in-flight detach**: FOUND R1.
2. **E2E over the real stack**
   (`.tentacle/tmp/connect-sessions-review/e2e.test.ts`: `SessionHost` +
   `Connection` + `RemoteClient`, two clients):
   - A detach raced a phone's `turn_start`: A stayed `running`, A's view got
     no activity, and `liveSessionIds` was `[]`.
   - A send on the detached A was refused locally.
   - Attach B → `["history"]`.
   - Detach B and switch back to A mid phone turn → `["history","turn"]`. The
     replayed foreign turn and the phone's own turn both ended `end_turn`.
   - Attach of a deleted id with `reopen` → `-32015 SessionDeleted`. `host.size`
     stayed 1 before and after: nothing created. Holds.
3. **Single broker after a switch**: one `RemoteClient` and one router.
   `detachSession` withdraws A's prompts on the answer
   (`router.sessionClosed`). An A prompt answered inside the window goes to A
   (keyed sessionId + requestId), never to B. Holds, apart from R1's hidden C.
4. **Older daemon (`MethodNotFound`)**: `endSession` un-marks `closing` and
   rethrows; `RemoteSession.detach` restores `closed`. App test (b2) pins the
   re-watch and the notice. Holds.
5. **Raw terminal writes**: `[resume]` lines are written pre-mount (after the
   picker's own Ink unmounted). The exit and QN2 lines go out in `finally`
   after `startTui` resolved and `sink.flush`. Holds.
6. **One session path**: `/clear`, the switch, closed-elsewhere and a failed
   open all go through `swapSession`. There is no second send/stream path.
   `App.tsx`'s new key-route code only executes the decisions of
   `sessions-panel.ts`; `connect-resume.ts` is pure. Holds, although the App
   key handler grew by about 40 lines of dispatch (known debt, no new
   branching logic).
7. **AGENTS §7 text**: accurate and minimal. "and quitting only detaches" is
   one clause beyond the owner's line, and it is true.

#### How the executor behaved

The split run fits together: no half-applied slice was found, and every file
in the plan is wired at both ends. Drift is documented honestly (QN2
placement; `ended` forgets and withdraws; the vacuous `closing` mutation
explained; the in-flight prompt window disclosed rather than hidden). The
miss: the disclosed "tiny window" was treated as cosmetic. Its real reach (a
lost `/close`, a hidden attached session) was not explored. Red-before-green
and mutation evidence check out where I re-ran them.

### Owner decisions on the Review findings

*— recorded by the orchestrator (claude-opus-5-5), 2026-10-26*

- **R1 (in-flight switch not latched):** a bug, fixed without an owner
  question — Execution "Fix 1 (Review)".
- **R2 (QN2 notice only in the post-exit lines):** accepted as is — the only
  place the user actually sees it after `/exit` (owner: "ok").
- **R3 (`x` twice deletes a session running on another device):** keep it
  allowed, but warn: the confirm hint for a running session reads "press x
  again — its running turn on another device will stop" (owner: "ok") —
  Execution "Fix 2 (owner R3)". Executor note: the hint also shows for a turn
  running with no device attached (left running after a quit).
- **R2-5 (hint wording, round 2):** adopt the reviewer's wording (owner:
  "si applica subito senza review") — Execution "Fix 5".
- **R4-1 (stray re-list notice, round 4):** fixed with R2-5, no review round
  (owner) — Execution "Fix 5".
- **R2-2, R2-3:** left as today; the owner gave the merge OK with them open.

### Round 2

*— claude-opus-5-5 (adversarial reviewer, fresh context), 2026-10-26*

> Same model as the executor and as round 1 (claude-opus-5-5); only the
> *context* is fresh. Shared blind spots can survive. Scope: Fix 1 and Fix 2,
> and what they may have broken.

**Verdict: REQUEST-CHANGES** — the latch converges on every outcome I drove,
but one action it leaves open (a `/sessions` panel opened mid-switch) can
delete the session being viewed (R2-1). The fix is one line in the pure module
plus a test.

#### Findings

1. **R2-1 — MEDIUM — a `/sessions` panel opened during a switch can delete the
   CURRENT session** (`packages/tui/src/sessions-panel.ts:73`, `SWITCH_GUARDED`
   leaves `/sessions` out as "a read". `App.tsx:1486` snapshots
   `current = sessionRef.current?.sessionId` when the panel opens. During the
   switch that is still A. `App.tsx:1984` then `sessionsDelete(…, panel.current)`).
   Once the switch settles on B, the open panel still shows A as `current`. `x x`
   on B is not refused, and B, the session now being viewed, is deleted. That
   cannot be undone. The daemon deletes an attached session
   (`daemon/src/connection.ts:393-394`). Repro
   `.tentacle/tmp/connect-sessions-review/round2.test.ts` A1 (real App, fakes):
   `["A.watch","A.open","A.unwatch","A.detach","A.detached","dir.open:B","B.watch","B.open","dir.remove:B"]`,
   and the armed hint was the plain "press x again to delete title B". Enter on
   B in the same panel would also "switch" to the session already shown
   (detach B, then re-open B). This breaks the `sessionsDelete` invariant "never
   the current session" on which Fix 2's "the armed row is never the current
   session" also depends. Proposed fix (executor's call): add `/sessions` to
   `SWITCH_GUARDED`. The panel cannot be opened mid-switch, which is the
   smallest change; the panel's own choose was already refused. A pure test,
   plus an App test red on today's code (A1 as the shape).
2. **R2-2 — LOW — `/exit` (or Ctrl+C) mid-switch: the switch completes after
   the unmount.** Repro A2: `exits = ["unmounted"]`, then on release
   `dir.open:B`, `B.watch`, `B.open`. With `connect` (`cli/src/connect.ts:190-195`)
   the late `open` either fails on the closed client or attaches B until
   `client.close()` drops the socket. Either way the daemon ends up detached, so
   it converges. But the `[connect] left session … --resume` line can name no
   session, or not the one the user meant. This is bounded and not silent data
   loss. Suggested fix: refuse quitting mid-switch the same way, or have the
   detach callback do nothing once the view has quit. Owner's call.
3. **R2-3 — LOW (disclosed) — a target `open` (or the detach) that never
   settles keeps the latch.** Repro A3: `/clear` is still refused 0.5 s after
   the open hung. Production sets no `requestTimeoutMs`
   (`transport/src/peer.ts:66`, no caller). Only a link close rejects the
   pending request (`peer.ts:213-220`), so the latch lasts as long as a hung
   daemon. `/exit` stays the way out. This matches Execution's "Nuances". I
   accept it as is, because the view is unusable then anyway, but it is not
   "can never stick".
4. **R2-4 — LOW, test gap** — the latch clear in the `sessions.open` *throw*
   branch (`App.tsx:1694`) is not pinned. Mutation M1 (drop it): **28/28
   green**. A `connect` `open` (`client.newSession`, `connect.ts:179-180`) can
   throw synchronously only defensively. Add a directory whose `open` throws,
   then assert that `/close` is not refused.
5. **R2-5 — NIT, owner wording (Fix 2)** — `deleteConfirmHint`
   (`sessions-panel.ts:168-171`) decides by `entry.running` only. That is
   correct: it is the `session/list` state, never the title, and the pin test
   shows a title "running turn" with `running:false` gets the plain hint. But
   (a) with `attached === 0` (a turn left running after a quit), "on another
   device" is false. (b) The running hint drops the title and "any other key
   cancels", the two facts that make an irreversible delete safe to confirm.
   Proposed wording:
   - `attached > 0`: "press x again to delete <title> — its running turn on
     another device will stop · any other key cancels"
   - `attached === 0`: "press x again to delete <title> — its running turn
     (no device attached) will stop · any other key cancels"

   Owner decides.

#### Gate (re-run by me)

`bun run check`: typecheck clean. `biome check .` **476 files, no fixes, 0
errors / 0 warnings**. `bun test` **2745 pass / 2 skip / 0 fail** (10 309
expects, 2747 tests, 213 files). The 2 skips are the opt-in ones. This matches
the executor's count.

#### Mutations (each reverted; tree byte-identical)

| Mutation | Result |
|---|---|
| M1: drop `switchingRef.current = false` in the `sessions.open` throw branch (`App.tsx:1694`) | **survives**: 28/28 green → R2-4 |
| M2: clear the latch only on a FAILED open (`if (!ok)` at `:1702`) | 3 red (`connect-sessions.test.tsx`) |
| M3: `switchingRefusal` returns null for a prompt | 2 red (`connect-sessions` /clear+prompt; `sessions-panel` pure) |

Before and after: `git status --short | shasum` `145c123…`, `git diff | shasum`
`07e534f…`, `App.tsx` `d0fa60b…`, `sessions-panel.ts` `530971c…`. These are
identical. Fix 1's own table (sessionsChoose ignoring `switching`; commands
not refused; latch kept on a refused detach / a failed open) was not re-run.
M2 and M3 cover the same properties from the other side.

#### Attacks tried

1. **Convergence on each outcome.**
   - Detach ok → open ok: cleared (M2 red).
   - Detach refused: cleared, old re-watched (pinned test).
   - Open fails, which also covers an archived or deleted id, since both
     reject `open`: fresh session, cleared (pinned).
   - `open` throws: cleared, but unpinned (R2-4).
   - Local session with no `open`: `onOpened(true)` at once (`App.tsx:1175`).
   - Closed-elsewhere swap before the target's open settles:
     `sessionRef.current !== target` skips the second swap, and the latch
     still clears.
   - The daemon dropping mid-switch: the pending request is rejected on close
     (`peer.ts:213-220`), which is the failure path. A hung daemon: R2-3.
     Unmount: R2-2.
2. **What is still accepted mid-switch.**
   - A `/sessions` panel, which leads to delete of current: **FOUND R2-1**.
   - `/exit` / Ctrl+C: R2-2.
   - Esc: no turn can be running (a switch is refused while `busy`), so there
     is nothing to cancel.
   - Permission answers: a switch needs `!running`. A prompt raised in the
     window is keyed by A's sessionId+requestId through the single broker, so
     it never reaches B (round 1 attack 3 holds).
   - Shift+Tab toggles the broker's auto-approve. It is global, not
     per-session, so it is harmless.
3. **Refused prompt fidelity.** `submit` calls `field.reset()`, then
   `restoreInput(text, …)` → `withRestored(draft, text)` into an empty draft.
   The text comes back trimmed, which is the same text that would have been
   sent. Pastes are inlined text, and the TUI has no separate attachment
   state. A skill keeps `raw`. Holds. The history entry is pushed before the
   refusal, the same as for a mid-turn refusal.
4. **AGENTS §7 "components only render".** Every decision is pure
   (`switchingRefusal`, `sessionsChoose`, `deleteConfirmHint`). `App.tsx` adds
   promise sequencing and one identity check (`sessionRef.current === target`).
   That is lifecycle wiring, not a decision. Holds.
5. **Fix 2 decided by state, not text.** It reads `entry.running` only. The pin
   test (title "running turn", `running:false`, 2 devices) shows the plain hint.
   Holds. Wording: R2-5.

#### Premise table (Fix 1 / Fix 2 claims)

| Claim | |
|---|---|
| Latch set before the detach, cleared on refused detach / open throw / open settle | TRUE (`App.tsx:1682`, `:1694`, `:1702`, `:1712`) |
| "The latch can never stick" | FALSE as stated: a never-settling request holds it (R2-3, disclosed in Nuances) |
| `/sessions` mid-switch is "a read" | FALSE in effect: the panel's delete acts on a stale `current` (R2-1) |
| A refused prompt / skill goes back to the input | TRUE (`App.tsx:1419-1423`, `:1739-1743`) |
| Armed row is never the current session | FALSE when the panel was opened mid-switch (R2-1) |
| Gate 2745 / 2 / 0 | TRUE |

#### How the executor behaved

Fix 1 is the shape round 1 asked for. The decisions are in the pure module,
the App only wires them, and every outcome branch clears the latch. The red
tests check out (M2/M3 red), and the hung-open limit was disclosed honestly.
The miss is the same kind as in round 1: an allowance was justified by a label
("a read") without following what the panel can *do* once open. The throw
branch also shipped untested. Fix 2 is correct and minimal. The owner's wording
was applied literally, and its inaccuracy for a detached running session was
flagged, which is the right call.

### Round 3

*— claude-opus-5-5 (adversarial reviewer, fresh context), 2026-10-26*

> Same model as the executor and as rounds 1–2 (claude-opus-5-5). Only the
> *context* is fresh, so shared blind spots can survive. Scope: Fix 3 (R2-1,
> R2-4) and what it may have broken. R2-2, R2-3 and R2-5 are the owner's and
> are not re-opened here.

**Verdict: REQUEST-CHANGES.** Fix 3 closes the path round 2 found. Round-2
A1 no longer deletes. Mutations Ma, Mb and M1 are all killed. But its claim
that "`panel.current` is now always the live id" is false. `current` is still
captured in two closures, `App.tsx:1488` and `App.tsx:1991`. A panel that
those closures build *after* a swap brings the stale id back. The post-delete
reload also re-opens the panel with no guard. Both lead to the round-2
consequence: the session being viewed is deleted (R3-1).

#### Findings

1. **R3-1 — MEDIUM — a stale `current` comes back through the panel's async
   (re)loads, so `x x` deletes the session being viewed.**
   - `swapSession` (`App.tsx:1216`) syncs the panel that is open *now*. Then
     `openPanel`'s `setPanel(loaded)` (`App.tsx:737`) replaces it with
     `sessionsPanel(current, …)`. That `current` was captured when the panel
     opened (`App.tsx:1488-1491`) or when the delete started
     (`App.tsx:1991-1996`).
   - The post-delete reload (`App.tsx:1992-1998`) is a second way into the
     panel. It calls `openPanel` without checking that the panel is still
     open, and without checking `switchingRef`. So it **re-opens a panel the
     user closed by switching**, and the stale id comes with it. If the delete
     settles mid-switch, the panel also opens mid-switch, around the new
     `SWITCH_GUARDED` gate.
   - Repro `.tentacle/tmp/connect-sessions-review/round3.test.ts` (real App,
     fakes), with the journal each case ends on:
     - **B3** (non-empty session, user-paced): on A, `x x` on C (its
       `session/delete` is slow), then ↑ Enter on B. The switch A→B runs and
       the panel closes. The delete settles, and the panel **re-opens** with
       current=A. `x x` on B then deletes B, the session being viewed:
       `["A.open","dir.remove:C","A.detach","dir.open:B","B.open","dir.remove:B"]`.
       On `connect` over a slow link, the window is one `session/delete`
       round-trip.
     - **B1** (A is closed on another device while the `/sessions` list
       loads): the loaded panel says current=A, the armed hint is the plain
       "press x again to delete title N", and the live fresh session N is
       deleted: `["A.open","N.open","dir.remove:N"]`.
     - **B2**: the same, but the close lands while a delete is in flight:
       `["A.open","dir.remove:B","N.open","dir.remove:N"]`.
   - Severity: in B1 and B2, N is empty, because keys are swallowed while
     the panel is open. So they alone would be LOW. B3 loses a real,
     non-empty session and cannot be undone, the same as R2-1.
   - Proposed fix (executor's call): ONE source for "current".
     - The key route passes `sessionRef.current?.sessionId ?? null` to
       `sessionsChoose` / `sessionsDelete` (`App.tsx:1976`, `:1986`), and
       both loaders read it when they resolve, not when they open.
     - The post-delete refresh only updates a sessions panel that is still
       open, under the same generation check. It never re-opens a closed one.
     - Pin it with B3 and B1 as App tests, red today.
2. No other finding in scope.

#### Gate (re-run by me)

`bun run check` exits 0. Typecheck is clean. `biome check .`: **476 files,
no fixes, 0 errors / 0 warnings**. `bun test`: **2748 pass / 2 skip / 0
fail** (10 318 expects, 2750 tests, 213 files). The 2 skips are the opt-in
ones. This matches the executor's count.

#### Mutations (each reverted; tree byte-identical)

| Mutation | Result |
|---|---|
| Ma: drop `/sessions` from `SWITCH_GUARDED` (`sessions-panel.ts:80`) | **killed**: 2 red (the App "refused mid-switch" test, and the pure `switchingRefusal` test) |
| Mb: drop the panel sync in `swapSession` (`App.tsx:1216`) | **killed**: 1 red ("the open panel follows the live session") |
| M1 (round 2): drop `switchingRef.current = false` in the `open`-throws branch (`App.tsx:1696`) | **killed**: 1 red (R2-4 test). Survived in round 2, so R2-4 is closed |

Ma and Mb are the pre-fix code for each half, so the two R2-1 tests are red
on the old code, as Execution says. Before and after: `App.tsx` `0a38275…`,
`sessions-panel.ts` `3356791…` (identical), and `git status --short` is
unchanged. `App.tsx` differs from Execution's `ac6016a…`. That is explained
by the `biome --write` formatting pass it records.

#### Attacks tried

1. **Round-2 A1 re-run** (`round2.test.ts`). The panel is refused mid-switch,
   so the journal never reaches `dir.remove:B`. A1's "bug present" assertion
   now fails, as intended. A2 and A3 behave as in round 2 (owner items).
2. **Every way into the panel during a switch.** `sessionsPanel(` is built
   only at `App.tsx:1490-1491` (`/sessions`, guarded through `submit` →
   `switchingRefusal` at `:1431`) and at `:1995-1996` (the post-delete
   reload, **not guarded**, see R3-1). No key binding or picker opens it. A
   panel open before the switch cannot act during it: Enter `closePanel()`s
   (`:1980`) before `switchTo`, and the generation bump drops its pending
   load (`:736`).
3. **"Current" after each swap outcome.**
   - ok, open fails, open throws, closed elsewhere: each one goes through
     `swapSession`, which syncs an open panel.
   - Detach refused: no swap, and the old session stays current, which is
     right.
   - Archived or deleted target: this is the open-fails path.
   - It holds for the panel object present at the swap. It fails for one
     built *later* from a captured id (R3-1, B1/B2/B3).
4. **AGENTS §7 "components only render".** Ma lives in the pure module, and
   its test is pure. Mb is one state write in `swapSession`. That is
   wiring, not a decision. Holds. R3-1's fix stays wiring too (which id is
   passed in). The decisions remain in `sessionsChoose` / `sessionsDelete`.

#### Premise table (Fix 3 claims)

| Claim | |
|---|---|
| `/sessions` refused mid-switch with `SWITCHING_NOTICE` | TRUE (`sessions-panel.ts:73-81`, `App.tsx:1429-1435`; Ma red) |
| An open panel takes the live id on every swap | TRUE for the open panel (`App.tsx:1216`; Mb red) |
| "The key route still reads `panel.current`, which is now always the live id" | **FALSE**: the loaders re-install a captured id (R3-1) |
| R2-4: the latch is cleared when `open` throws, and pinned | TRUE (`App.tsx:1696`; M1 red) |
| Gate 2748 / 2 / 0 | TRUE |

#### How the executor behaved

The fix is minimal and in the right places. The guard is pure, the sync is
in the one swap path, and both halves were proven red by mutation. R2-4 was
closed honestly. The miss is again the same kind: a fix to one *writer* of a
duplicated value (`panel.current`) was taken as an invariant ("always the
live id"), without checking the other writers, the two `openPanel` loaders.
Taking the id from `sessionRef` at the point of use removes the whole class.

### Round 4

*— claude-opus-5-5 (adversarial reviewer, fresh context), 2026-10-26*

> Same model as the executor and as rounds 1–3. Only the context is fresh.
> Scope: Fix 4 (R3-1) and what it may have broken. R2-2, R2-3 and R2-5 are
> the owner's, and this round does not re-open them.

**Verdict: APPROVE-WITH-NITS.** R3-1 is closed. "Current" now has one
source. It is not stored in the panel (`SessionsPanel` has no `current`). It
is read live in two places only: the render (`App.tsx:642`) and the key
route (`App.tsx:1976`, used by both `sessionsChoose` and `sessionsDelete`).
The `/sessions` loader captures nothing (`App.tsx:1494-1496`). The
post-delete refresh never calls `openPanel`. It is a functional `setPanel`
that is a no-op unless a sessions panel is open (`App.tsx:2013-2022`).
So no stale id can reach `session/delete` or `session/open`.

#### Findings

1. **R4-1 — LOW (cosmetic).** The re-list's error branch (`App.tsx:2024`)
   is not gated by `applies()`. If the panel was closed or switched away
   from, a failed re-list still pushes `sessionsListError` into the feed of
   the session now being viewed. No state is wrong. It is a notice about a
   panel the user no longer sees. Fix (optional): `if (applies())` around it.
2. **R4-2 — info, not blocking.** In the App, `sessionsRefreshApplies` is
   defense in depth. Mutation Mα (`return true`) survives every App test,
   because the functional update `p?.kind === "sessions" ? … : p` alone
   keeps a closed panel closed. So B3's safety really rests on "never
   `openPanel`" plus "the panel holds no id". In the App, the guard only
   stops an older refresh from overwriting a panel that was re-opened since
   with a newer list. It is pinned by the pure test only. That is
   acceptable, but Execution's table implies B3 pins the guard, and it pins
   the "no re-open" half.

No other finding in scope.

#### Gate (re-run by me)

`bun run check` exits 0. Typecheck is clean. `biome check .`: **476 files,
no fixes, 0 errors / 0 warnings**. `bun test`: **2753 pass / 2 skip / 0
fail** (10 332 expects, 2755 tests, 213 files). The 2 skips are the opt-in
ones. This matches the executor.

#### Mutations (each reverted; tree byte-identical)

| Mutation | Result |
|---|---|
| Mα: `sessionsRefreshApplies` → `return true \|\| …` (`sessions-panel.ts`) | **killed** by the pure test (1 red). App tests stay green (see R4-2) |
| Mβ: render passes `null` as current (`App.tsx:642`) | **killed**: 1 red (`/sessions (b)`, the `current` marker on the live row) |
| Mγ: invert the list guard (`if (applies()) return;`, `App.tsx:2012`) | **killed**: 1 red ("a delete's refresh updates a panel that is still open") |

Before and after: `App.tsx` `7d050d3…`, `sessions-panel.ts` `5e20cac…`, and
`git status --short` hashes to `145c123…`. All three are unchanged. The
`App.tsx` hash differs from Execution's `1aa199f…` because of the
formatting-only `biome --write` that Execution records.

#### Attacks tried

1. **Round-3 repro re-run** (`round3.test.ts`, the real App with fakes).
   All 3 cases now fail on their bug-asserting `expect`. That is the intent.
   The journals:
   - B1 `["A.open","N.open"]`: N is never deleted.
   - B3 `["A.open","dir.remove:C","A.detach","dir.open:B","B.open"]`: the
     panel is not re-opened, and B is never deleted.
   - B2 `["A.open","dir.remove:B","N.open","dir.remove:A"]`: A was closed
     elsewhere and is no longer viewed, so deleting it is legitimate. N is
     never deleted.
2. **Every writer of the panel.** Every `setPanel` that *replaces* the
   panel goes through `closePanel` or `openPanel`, and both bump
   `panelGenRef` (`App.tsx:724`, `:735`). Every other `setPanel` is a
   functional update of the existing panel (`:1221`, `:1969`, `:1980`,
   `:1994`, `:2013`). So the generation check is sound, and no path builds
   a sessions panel from a captured id.
3. **A delete in flight against each outcome.**
   - The user stays in the panel or moves the cursor: the gen is unchanged,
     so the refresh applies, the row disappears and the cursor is clamped
     (Mγ pins this).
   - Esc, then `/sessions` again: a new gen, so the old refresh is dropped,
     and the new panel lists for itself.
   - A switch: the panel closed, so it is dropped (B3).
   - Closed on another device while the panel stays open: the gen is
     unchanged, so only data is applied, and `current` is read live (B1/B2).
   - Two deletes in flight whose refreshes land out of order: the panel may
     briefly show a deleted row. That is display only. The row is never the
     viewed session, because `sessionsDelete` compares it with the live id.
4. **Enter with a stale row.** `sessionsChoose` takes the live id and
   `switchingRef` (`App.tsx:1983`). A row whose session was deleted
   elsewhere goes down the open-fails path, which is unchanged from round 3.
5. **`sessionId` null while an open is in flight**
   (`remote-session.ts:399-400`, `this.id ?? this.desiredId`). In that
   window `current` is null, so the viewed row would not be refused. This
   is the same source as before Fix 4, so Fix 4 did not cause it. It is
   also practically unreachable: a fresh session gets no daemon row until
   its first prompt opens it, and the panel swallows input. Out of scope,
   recorded only.
6. **AGENTS §7 (components only render).** The two new decisions,
   `sessionsRefreshApplies` and `refreshedSessions`, are pure and tested
   directly (`sessions-panel.test.ts:227-236`). `App.tsx` only reads refs
   and passes them in. Holds.

#### Premise table (Fix 4 claims)

| Claim | |
|---|---|
| `SessionsPanel` holds no `current`; `panelView(…, current)` takes the live id | TRUE (`App.tsx:642`; Mβ red) |
| The key route reads `current` at the key for both choose and delete | TRUE (`App.tsx:1976`, `:1983`, `:1993`) |
| The `/sessions` loader captures nothing | TRUE (`App.tsx:1494-1496`) |
| The refresh never re-opens a closed panel, and never applies mid-switch | TRUE (no `openPanel`, functional `setPanel`, `sessionsRefreshApplies`; B3 holds, Mα is killed by the pure test) |
| The refresh still updates a panel that stays open | TRUE (Mγ red) |
| A failed re-list says `sessionsListError` | TRUE (`App.tsx:2024`; ungated, R4-1) |
| Gate 2753 / 2 / 0 | TRUE |

#### How the executor behaved

The executor took the class fix that round 3 proposed: the id is read at
the point of use, so there is no second copy to keep in sync. It did not
patch a third writer. The diff is small and wiring-only, and the decisions
are in the pure module. B1 and B3 were reproduced as App tests and shown red
by mutation. The repro's journals were reported honestly, including B2's
legitimate `dir.remove:A`. The only overstatement is minor: the guard is
presented as what pins B3, when the functional update alone does that
(R4-2).
