# eval/client-reattach — `RemoteClient` reconnects and resumes transparently

> **Status:** implementation drafted — awaiting owner approval (2026-10-19) · eval (child of `docs/eval/session-reattach.md`, step 8)
> **Branch:** none until promoted (then `feat/client-reattach`)
> **Type:** eval → feat · **Size:** L as scoped by the Review → proposed split: 8a this doc **M** + 8b `client-reattach-frontends` **M** (Implementation, Q11) · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (TUI-over-RPC one-session-path invariant, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** the client half of re-attach — reconnect, `open`
with the last cut, apply replay or resync — living in `RemoteClient` so every
frontend (TUI over `connect`/`attach`, the future mobile app) gets it without
code of its own.

Evidence: today a dropped socket rejects the in-flight `prompt` with
`connection closed` and nothing reconnects (parent Repro).
`client/src/ws-channel.ts:69-77` builds the token URL with `URL.searchParams`
and passes headers as the 2nd `WebSocket` argument — fine on Bun, likely not on
React Native (unverified; a mobile client brings its own `DuplexChannel`
adapter, the "a new target adds only a transport" shape of AGENTS §7).

Related: `docs/feat/pod-attach-resilience.md` (keepalive + reconnect for pod
`attach`, not started) — likely absorbed by this child; decide when promoting.

## Implementation

> **Owner decisions (2026-10-19):** the open questions below are resolved in
> the parent, `docs/eval/session-reattach.md` §"Owner decisions after the
> children's Implementation drafts" (A–G, D1–D10). Where a question or
> design point here disagrees, the parent decision wins.


*— claude-opus-5-5, 2026-10-19 (draft, awaiting owner approval)*

Verified against `main` @ `4914e9b` (v1 code; children 3, 4, 7 not implemented).
Experiments live in `.tentacle/tmp/client-reattach-impl/` (gitignored) and are
pasted in full under **Experiments** below. Line numbers are `main` today; the
v2 children will move some of them — the executor re-checks each cited fact
on the post-children tree before editing (§0: a contradiction stops the work).

### Open questions / contradictions (owner decision needed before Execution)

Each item names the sibling that should own it and my recommendation. Q1–Q5
are **interface requirements on the unimplemented children**; if a child
lands without them, this plan cannot meet the parent property.

- **Q1 — Unknown event types are dropped by the peer today, seq included
  (Experiment 6).** `RpcPeer` validates every inbound notification
  (`transport/src/peer.ts:360-363`) against `SessionUpdateSchema`, a closed
  `discriminatedUnion` (`protocol/src/updates.ts:85-94`); an unknown `type`
  is reported to `onError` and never delivered, so its `seq` vanishes. A
  client with contiguity checks then sees a gap on *every* future display
  event → a forced-resync loop; a client without them silently tolerates
  real gaps. The parent's "ignore unknown display, fail loudly on unknown
  mandatory" (point 14) is **not implementable** unless the envelope carries
  the class and survives validation. **Recommendation (owner:
  `session-event-stream`):** `session/update` params become
  `{sessionId, seq, class: "display"|"mandatory", update}` where the `update`
  schema has a catch-all member (`{type: string}` passthrough) after the known
  ones; `seq` becomes required. The client applies `class` only for unknown
  types.
- **Q2 — The in-flight turn's user prompt is not in the stream.**
  `Session.send` pushes the user message synchronously
  (`agent/src/session.ts:66-68`) and no update carries it
  (`daemon/src/mapping.ts` has no user-message case). If the cut sits before
  that push (first round of a turn not committed yet), a resync rebuilds
  `messages` *without* the prompt and the replay has no event for it → the
  recovered transcript lacks the user bubble — the parent property fails for
  every drop in a turn's first round. **Recommendation (owner:
  `session-event-stream`):** `turn_start{turnId, prompt?: ContentBlock[]}`
  (absent for a continuation turn). It is also what a second device needs to
  render a turn it did not start.
- **Q3 — Turn status at the cut.** On resync, a `turn_end` with `seq ≤ since`
  is not replayed; the client cannot tell whether a turn is still running, or
  how *its own* turn ended. **Recommendation:** (a) the first `snapshot` page
  carries `turn?: {turnId, state: "running"|"suspended"}` as of its `since`
  (owner: `session-event-stream`); (b) the lifetime idempotency map (parent
  point 4, F8) stores `turnId → {ack, outcome?}`, and a re-sent
  `prompt{turnId}` for an ended turn returns `{turnId, outcome:{stopReason,
  error?}}` — so the client learns its own turn's end after any resync without
  a new method (owner: `session-event-stream`).
- **Q4 — What `open` does in resync mode.** `session-registry` says
  "live → attach + `{replay}` or `{resync: true}`" but not whether the sink is
  attached and what is replayed on resync. This plan assumes **Option A**:
  `open{sessionId, since?}` always attaches the sink in the same tick as it
  computes the replay (registry's own second assumption); in `replay` mode it
  sends `seq > since`, in `resync` mode it sends `seq > committedSeq` (the
  round in flight) — both as ordinary `session/update` notifications, **not**
  inline in the result. The client then pages `snapshot` and applies buffered
  events with `seq > snapshot.since`. A fresh client (no `since`) is the same
  path. Fallback if the registry picks otherwise: snapshot first, then
  `open{since: S}` (two round trips, one extra resync on a race). Owner:
  `session-registry`. Notifications-not-inline matters because live events can
  overtake the `open` response anyway (Experiment 1), so inline replay buys
  nothing and needs a second ordering rule.
- **Q5 — Withdrawing a pending broker prompt.** When `permission_resolved`
  (another device answered), `turn_end` or a resync removes a request, the
  TUI dialog must close. `PermissionRequester` has no cancel
  (`core/src/permission.ts:44`; `PermissionBroker.request`, `:68-70`).
  **Recommendation (owner: `permission-events`, which must already close the
  dialog on `permission_resolved`):** additive `PermissionRequest.signal?:
  AbortSignal`; `permission-ui.ts` closes the dialog on abort and the client
  never sends an answer for an aborted request. This plan assumes it; if
  `permission-events` lands without it, this child adds it (core + tui, ~20
  lines) and the Files list grows by two.
- **Q6 — `since` is "opaque" but the client must compare it.** Dedupe
  (`seq ≤ since`) and contiguity are numeric comparisons. Recommendation: the
  spec says `since` is a **seq number with one meaning** — "every event with
  `seq ≤ since` is reflected in `messages`" — clients may compare it with
  event seqs and must derive nothing else (granularity stays the daemon's).
  Owner: `session-event-stream` (wording only).
- **Q7 — "reconnecting…" cannot go through `StatusLine` (contradicts this
  doc's Review).** `StatusLine` writes raw `\r`/ANSI to the terminal
  (`cli/src/status-line.ts:1-16,49-71`) and AGENTS §7 requires it to be
  `finish()`ed *before* Ink mounts; mid-session it would corrupt Ink's frame —
  the exact bug the Review wanted to avoid. **Resolution in this plan:** the
  link status is Ink-rendered state: the runtime exposes `link` (a
  subscribable `LinkStatus`), the TUI renders it in `StatusBar`
  (`tui/src/components/StatusBar.tsx`, mounted at `App.tsx:963`). The Review's
  intent (no raw writes) holds; its mechanism was wrong.
- **Q8 — "stop retrying on 401" is not directly observable on Bun.** A
  rejected upgrade surfaces as `error` + `close(1002, "Expected 101 status
  code")`, for 401 *and* any other non-101 (403, a proxy's 502), vs
  `close(1006)` for unreachable (Experiment 5). The daemon answers a plain GET
  with 401 for a bad token and 426 for a good one
  (`daemon/src/ws-server.ts:166-173`). **Resolution:** on a 1002 the WebSocket
  channel factory makes one `fetch` probe (same URL as http(s), same
  `Authorization`): 401 → terminal `unauthorized`; anything else → transient.
  No daemon change.
- **Q9 — `compact` has no idempotency key in the parent design.** An
  ambiguous ack cannot be retried safely (a second compaction costs a model
  call and summarises a summary). Plan: never auto-re-send `compact`; if the
  recovered stream shows `history_replaced` it resolves, else it rejects with
  `LinkLost` and the user retries. Cheap alternative if the owner prefers:
  `compact{id}` in `session-event-stream`.
- **Q10 — Predecessors must port the client minimally.** Children 3/4/7
  remove `session/new`, the long-lived `prompt` result and
  `session/request_permission` — all consumed by the client today
  (`remote-client.ts:145,160-162,105-106`). Each must keep `bun run check`
  green, so each necessarily ports `RemoteClient`/`RemoteSession` to the new
  wire *without* reconnect. This plan builds on that port; it does not redo
  it. Confirm the predecessors' Implementations say so.
- **Q11 — Size: as scoped by the Review this is L** (client pure modules +
  shell + vectors + property test, cli wiring for three transports, TUI). Not
  XL, but two independent risk surfaces. **Proposed split** (recommended):
  **8a `client-reattach`** (this doc): the client package + the minimal TUI
  type/reducer change that the new output forces; reconnect is inert until a
  frontend passes a channel factory. **M · load-bearing.**
  **8b `client-reattach-frontends`** (new eval, to be created by the owner —
  I may edit only this doc): channel factories for `connect` / `attach` /
  `run`, persistence on resync, `--resume`-style recreate from the store,
  `LinkStatus` in `StatusBar`, absorbs `pod-attach-resilience` Layer 2.
  **M · load-bearing.** The sections below mark 8b items with **[8b]**; if
  the owner rejects the split, everything ships here as L.
- **Q12 — `pod-attach-resilience` verdict.** Layer 2 (reconnect-and-resume)
  is **absorbed** by 8b: the attach channel factory re-runs `openExec`
  (`cli/src/pod-runtime.ts:445`); the new `serve --stdio` is a new process
  (the old one ends on stdin EOF, `cli/src/serve.ts:105-120`), so `open`
  returns `UnknownSession` and the client recreates from its committed
  messages — exactly that doc's "new daemon + resume from the laptop's
  snapshot", now through the one session path. Layer 1 (keepalive) is **not**
  absorbed and that doc's premise is wrong: Bun 1.4.3's client `WebSocket`
  *does* have `ping()` and the server receives it (Experiment 4), so the exec
  keepalive is a WS ping in `k8s/src/exec-channel.ts` — no protocol `ping`
  method. It matters more after `background-process-groups`: an idle drop
  ends the stdio daemon and its exit net kills the user's background jobs.
  Recommend: shrink `pod-attach-resilience` to Layer 1 (S, contained); whether
  the apiserver/LB idle timers count WS pings is unverified (verify on a real
  cluster in that task).

### Load-bearing assumption

**Seq alone — never arrival order, never which frame carried an event — is
sufficient to merge replayed, live and post-snapshot events into one correct
sequence; and arrival order really cannot be trusted.** The whole reducer
design (buffer per session from *before* `open` is sent, apply strictly by
seq, dedupe `seq ≤ applied`, treat a gap as a forced resync) stands on it.

Proof, both halves:

1. *Arrival order cannot be trusted:* `RpcPeer.handleRequest` `await`s the
   handler before sending the response (`transport/src/peer.ts:321-325`), so
   even a fully synchronous attach yields at least one microtask before the
   response frame; a live update emitted in that window goes out first.
   Experiment 1 shows it: the notification `seq=11` arrives **before** the
   response of the request that attached the sink. So a client that waits for
   the `open` result before routing updates (today: `RemoteClient` routes only
   to a registered handler, `client/src/remote-client.ts:101`, and drops
   anything else) would lose them.
2. *Seq is sufficient:* `HostedSession.emit` stamps `seq: ++this.seq`
   per session for every emitted update (`daemon/src/hosted-session.ts:83`) —
   monotonic, +1, one counter per session — and one connection delivers frames
   in order (`transport/src/channel.ts:36-45`: FIFO microtasks; WebSocket is
   ordered). `session-event-stream` keeps this counter per session for its
   lifetime (its Review: "`seq` per-session monotonic") and Q1 makes every seq
   reach the client. Under those two facts a client that has applied
   `1..n` needs exactly `n+1` next; anything else is a duplicate (drop) or a
   gap (resync).

If Q1 is rejected (unknown types still dropped by validation), half 2 fails and
the plan must change (contiguity could no longer be checked) — STOP and report.

### Preconditions

Verified on `main` unless marked *(assumed: child N)*.

- **One session path.** `createLocalRuntime` builds one `RemoteClient` over a
  `DuplexChannel` (`cli/src/local-runtime.ts:117-121`) for worker
  (`:210-221`), pod `run` (`pod-runtime.ts:259,276`) and `attach`
  (`:445,462`). `connect` builds `RemoteClient` directly
  (`cli/src/connect.ts:17-29`) — same class, no persistence. Reconnect lives
  in `RemoteClient`, so all four get it from one place.
- **The `RemoteClient` object can outlive its channel.** It holds the broker,
  the model provider and the handler maps (`remote-client.ts:64-86`); only
  `peer` is per-channel (`:87`). Rebuilding the peer per channel "generation"
  keeps the **single `PermissionBroker`** (AGENTS §7): reconnect never
  constructs a broker.
- **The drop is observable before callers see the rejection.** A channel has
  one close handler, owned by the peer (`transport/src/channel.ts:16-17`,
  `peer.ts:119`); on close the peer rejects every pending request with
  `connection closed` (`peer.ts:234-243`) and aborts inbound handlers
  (`:247-250`, which stops a laptop-served model stream). A client-side
  channel decorator that wraps `setOnClose` sees the drop first, without a
  transport change (Experiment 3: `onDrop` runs, then the rejection observes
  `dropped=true`).
- **Late frames on a dead generation are possible.** `RpcPeer.receive` does
  not check `closed` (`peer.ts:260`) and `WebSocketChannel` forwards messages
  regardless of its `closed` flag (`client/src/ws-channel.ts:20-23`). So the
  client needs its own generation guard (ignore callbacks whose generation is
  not current).
- **The ambiguous-ack case is real and reproducible in memory.** Experiment
  2b, `k=5`: the `session/prompt` frame reached the daemon (model called once)
  and the link died before the response; the client got `connection closed`.
  Without a key the re-send runs the turn twice; without a re-send in the
  `k<5` case the prompt is lost.
- **Drop at every frame is implementable with existing seams.**
  `createChannelPair` (`transport/src/channel.ts:31-66`) + a send-wrapping
  decorator with one global counter cuts the link after exactly frame *k* in
  either direction, deterministically (Experiments 2, 2b, 11 consecutive k).
  Real daemon objects run in memory (`Connection`, `SessionHost`,
  `ScriptedProvider`, `RecordingGatedProvider` patterns in
  `client/test/remote.test.ts:22-31,80-105`; `SpyBroker` in
  `cli/test/pod-runtime.test.ts:162`). `@tentacle/daemon` is already a client
  devDependency (`packages/client/package.json`).
- **The TUI folds events through a pure reducer** (`tui/src/state.ts:183`,
  `applyEvent`) inside one `for await` over `session.send`
  (`tui/src/App.tsx:350-352`), and can already build items from messages
  (`tui/src/resume.ts:9`, `messagesToItems`). A resync therefore maps to "replace
  items from messages, then keep folding" — a small pure addition.
- **The TUI's permission dialog is broker-driven, not turn-driven**
  (`tui/src/permission-ui.ts` installs the requester). So a replayed
  `permission_request` for a turn the TUI did not start still shows the
  Approve/Deny dialog — the acceptance scenario needs no new TUI surface.
- *(assumed: 3 `session-event-stream`)* `turn_start{turnId, prompt?}`,
  `turn_end{turnId, stopReason, error?}`, `history_replaced{reason}`,
  `prompt{turnId}` acks at once, `enqueue{id}` dedupes (key checked before
  `running`), paged `snapshot{cursor?, limit?} → {messages, since, cursor?,
  turn?}`, event class on the envelope, required `seq` (Q1–Q3, Q6).
- *(assumed: 4 `session-registry`)* `session/open{sessionId, since?,
  messages?} → {mode: "replay"|"resync"|"created"}` with Option A semantics
  (Q4); `UnknownSession` (-32003, `transport/src/errors.ts:13`) when not live
  and no `messages`; `session/close` idempotent; detach on socket close;
  model-proxy turns cancelled on detach (session survives).
- *(assumed: 7 `permission-events`)* `permission_request{requestId, …}`
  (mandatory), `permission_resolved{requestId, outcome}`,
  `session/resolve_permission{sessionId, requestId, outcome}` →
  `PermissionNotPending` when late; no timeout; `PermissionRequest.signal`
  (Q5); the client's basic event→broker→resolve path (Q10).
- *(assumed: `cancel`)* the parent lists `cancel` among ack-at-once commands;
  today it is a notification (`protocol/src/methods.ts:51`,
  `remote-client.ts:176-178`). The plan treats it as an idempotent command
  `cancel{sessionId, turnId}`; if it stays a notification the outbox rule is
  identical (re-send while the turn is still running after recovery).

### Design

Three pure modules (AGENTS §7) and one imperative shell. Nothing in the pure
modules knows about sockets, timers or React.

**1. `session-reducer.ts` (pure) — the per-session view.**

```ts
type Phase = "opening" | "live" | "resyncing" | "down" | "fatal";
interface SessionView {
  readonly phase: Phase;
  readonly committed: readonly ChatMessage[]; // seed, or the last snapshot
  readonly cut: number;                       // snapshot.since; committed ⊇ all seq ≤ cut
  readonly applied: number;                   // last applied seq (contiguity)
  readonly tail: readonly SeqUpdate[];        // applied updates with seq > cut, in seq order
  readonly buffer: readonly SeqUpdate[];      // received, not yet applicable (opening/resyncing)
  readonly turn: { turnId: string; state: "running" | "suspended" } | null;
  readonly pending: ReadonlyMap<string, PermissionRequestUpdate>;
  readonly fatal?: string;
}
type Input =
  | { kind: "open_sent"; since: number | null }
  | { kind: "update"; params: SessionUpdateParams }          // validated envelope
  | { kind: "open_result"; mode: "replay" | "resync" | "created" }
  | { kind: "snapshot"; messages: readonly ChatMessage[]; since: number; turn: Turn | null } // all pages folded
  | { kind: "link_down" }
  | { kind: "recreated" };                                   // UnknownSession → open{messages}
type Output =
  | { kind: "reset"; messages: readonly ChatMessage[] }      // replace everything shown
  | { kind: "update"; seq: number; update: SessionUpdate }   // apply in order
  | { kind: "turn_lost"; turnId: string; reason: string }
  | { kind: "fatal"; reason: string };
type Effect =
  | { kind: "fetch_snapshot" }          // shell pages snapshot, feeds back one `snapshot` input
  | { kind: "reopen"; since: null }     // forced resync (gap, or history_replaced)
  | { kind: "committed"; messages: readonly ChatMessage[] }; // persist hook
function reduce(view: SessionView, input: Input): { view; out: Output[]; effects: Effect[] };
```

Rules (each one is a row in the vector tables):
- `open_sent` → `opening`; every `update` while `opening`/`resyncing` goes to
  `buffer` (sorted by seq, dedupe within it). This is the load-bearing rule.
- `open_result{replay}` → apply buffer entries with `seq > applied`, in seq
  order; first one must be `applied + 1`, else **gap → `reopen{since:null}`**.
- `open_result{resync}` (also the fresh-client path) → `resyncing` +
  `fetch_snapshot`. `snapshot{messages, since: S, turn}` → **discard the
  local tail (partial round)**, `committed = messages`, `cut = applied = S`,
  `turn` from the snapshot, `pending` cleared; emit `reset{messages ⊕ the user
  message of a buffered turn_start after S}` (Q2), then apply buffered
  `seq > S` with the contiguity check, then `committed` effect (persist).
- `live` + `update`: `seq ≤ applied` → drop (dedupe); `seq > applied + 1` →
  gap → `reopen`; else apply:
  - display known → `tail` + `update` output; display unknown → counts as
    applied, no output;
  - `turn_start` → `turn = running`; `turn_end` → `turn = null`, clear its
    `pending`, effect `fetch_snapshot` (persistence after `turn_end`, Review);
  - `permission_request` → `pending.set`, `turn.state = suspended`;
    `permission_resolved` → `pending.delete`, back to `running`;
  - `history_replaced` → `resyncing` + `fetch_snapshot` (the barrier: never
    apply later events over pre-compaction history);
  - unknown **mandatory** → `fatal` + `fatal` output ("this client is too old
    for the daemon; update it"); the shell stops reconnecting for the session.
- a `snapshot` arriving while `live` (the post-`turn_end` one) folds the tail:
  `committed = messages`, `cut = since`, `tail = tail.filter(seq > since)`; no
  `reset` output (nothing visible changes); `committed` effect.
- `link_down` → `down` (state kept: the UI keeps showing it, stale).
- `recreated` → the daemon lost the session: `turn` (if any) is ended locally
  with `turn_lost` ("the daemon restarted; the turn in flight was lost"),
  tail and pending cleared, `cut = applied = 0` (a new session's seq space),
  `reset{committed}`.
- Guard: more than 3 forced `reopen`s in 60 s for one session → `fatal`
  ("daemon stream inconsistent") — a hostile or buggy pod cannot spin us.

**2. `link-machine.ts` (pure) — connection lifecycle + outbox survival.**

States `connecting(attempt) | up(gen, since) | backoff(attempt, untilMs) |
stopped(reason)`. Inputs: `dial_ok`, `dial_failed(kind)`, `channel_down`,
`timer`, `ack_timeout`, `dispose`. Outputs: `dial`, `schedule(ms)`,
`reopen_all`, `flush_outbox`, `status(LinkStatus)`.
- Backoff: `min(30 s, 0.5 s · 2^attempt)` with full jitter (injected
  `random`). Attempt counter resets only after the link stayed `up` ≥ 10 s
  (flap guard: a socket that opens and dies immediately keeps backing off).
  Proposal values, constants in the module.
- Terminal: `dial_failed("unauthorized")` (Q8), `VersionMismatch` at
  `initialize` (-32002), `dispose`. Everything else (`unreachable`,
  `rejected` non-401, exec errors) is transient: the TUI shows the state and
  the user can quit; a phone's OS decides when to stop.
- `LinkStatus = {state: "up"} | {state: "reconnecting", attempt, nextAtMs} |
  {state: "stopped", reason}` — presentation-free; the frontend formats it.
- **Liveness without ping:** every ack-at-once command has an ack deadline
  (proposal 15 s, not applied to `snapshot` pages or inbound `model/*`); a
  miss = `ack_timeout` → the shell closes the channel → normal reconnect. This
  catches a half-open socket (laptop slept) on the first command, which is the
  `pod-attach-resilience` symptom.
- **Outbox rules** (`survives(entry, view)` — pure, decided *after* the
  session is recovered, from the reducer view):
  | command | never sent (link was down) | sent, ack lost, **same** session | sent, ack lost, session **recreated** |
  |---|---|---|---|
  | `prompt{turnId}` | send | re-send same `turnId` (daemon dedupes; Q3 returns its outcome) | do **not** re-run: `turn_lost` (tools may have run on the dead daemon) |
  | `enqueue{id}` | send if a turn runs, else reject (TUI reconciles, `remote-session.ts:42-47`) | re-send same `id` (key checked before `running`) | reject |
  | `resolve_permission{requestId}` | send if still in `view.pending` | same | drop (request gone; dialog aborted) |
  | `cancel{turnId}` | send if `view.turn?.turnId` matches | same | drop |
  | `compact` | send | resolve if `history_replaced` seen, else reject `LinkLost` (Q9) | reject |
  | `open`, `snapshot` | re-issued by the machine, never queued | | |

**3. `turn-adapter` (pure, in `mapping.ts`) — reducer output → what a
frontend consumes.** `RemoteSession.send(prompt, signal)` keeps its shape for
the TUI but yields `SessionEvent = AgentEvent | {type: "history_reset";
messages}`: `reset` → `history_reset`; `update` → `updateToEvent`
(`client/src/mapping.ts:78`, unchanged); the generator ends on its own
`turnId`'s `turn_end`, on a snapshot whose `turn` is not its `turnId` (it
ended while away — stop reason from the re-sent `prompt{turnId}` ack, Q3), or
on `turn_lost` (as an error, so `failTurn` shows it, `tui/src/state.ts:143`).
A mobile app consumes `SessionView` + outputs directly; it never sees
`AgentEvent`.

**4. The shell — `RemoteClient` (imperative).**
- New option `channelFactory?: () => Promise<DuplexChannel>` (rejects with
  `ChannelError{kind: "unauthorized"|"unreachable"|"rejected"}`), plus
  injected `clock` (`now`, `setTimeout`, `clearTimeout`) and `random` for
  tests. The existing constructor `(channel, permissions, modelProvider,
  options)` stays: the given channel is generation 0; **without a factory a
  drop is terminal exactly as today** (worker path, every current caller) —
  8a is inert until 8b passes factories.
- Per generation: wrap the channel (`setOnClose` decorator, Experiment 3),
  build a new `RpcPeer` with the same handlers, `initialize`, then for every
  open session `open{sessionId, since: view.applied}` (registered *before*
  sending, LBA), then `flush_outbox`. Callbacks capture `gen`; a stale gen is
  ignored.
- Session ids are **always client-generated** (`crypto.randomUUID()` when the
  frontend gives none, today `connect.ts:28` gives none): the handler must
  exist before `open` is sent.
- `UnknownSession` on `open{since}` → `open{sessionId, messages:
  view.committed}` → reducer `recreated`. Two devices racing the recreate:
  the registry makes the second an attach.
- `fetch_snapshot` effect → page `snapshot{cursor}` until no cursor (guard 1000
  pages), fold, feed one `snapshot` input. A `CursorExpired`/compaction during
  paging → restart the fetch (counts toward the reopen guard).
- `committed` effect → `options.onCommitted?.(sessionId, messages)`. This is
  the single snapshot used both for persistence and for recreate (today
  `persistingController` takes its own snapshot after each `send`,
  `local-runtime.ts:65-94`; **[8b]** switches it to `onCommitted`, so disk is
  aligned after every `turn_end` *and* every resync).
- Permissions: a `permission_request` output calls
  `permissions.request({…, signal})` once per `requestId` (a replay of a known
  id does not re-prompt — the original broker promise is still pending because
  the client object survived); the answer goes to the outbox as
  `resolve_permission`. `permission_resolved`, `turn_end`, `reset` and
  `recreated` abort the signal of every request no longer in `view.pending`.
  `permission_resolved` is display-only (pod-trust, `permission-events`): it
  closes a dialog, it never records a decision.
- `onLinkStatus(listener)` for frontends; `onError` unchanged (never a raw
  terminal write).

**5. WebSocket factory.** `webSocketChannelFactory(url, {token})` in
`ws-channel.ts` wraps `connectWebSocket` and classifies failures: close code
1006 → `unreachable`; 1002 → one `fetch` probe of the http(s) URL with the
same `Authorization` → 401 `unauthorized`, else `rejected` (Q8). The
`URL.searchParams`/headers construction (`ws-channel.ts:66-77`) is untouched;
a React Native/Swift client brings its own factory.

**6. TUI (8a, minimal):** `SessionController.send` returns
`AsyncIterable<AgentEvent | HistoryReset>` (`tui/src/App.tsx:45-51`); pure
`resetHistory(state, items)` in `state.ts` replaces `items` with
`messagesToItems(messages)` and keeps `running`; the `for await` at
`App.tsx:350` dispatches `history_reset` to it. **[8b]:** `TuiOptions.link`
→ `StatusBar` shows "reconnecting (attempt n, retry in Xs)" / "disconnected:
<reason>" (Q7); `connect.ts` passes `webSocketChannelFactory`; `pod-runtime.ts`
passes `() => kube.openExec(<same target>)` for `run` and `attach` (404 pod →
terminal); `local-runtime.ts` persists from `onCommitted`, seeds recreate from
the store record on a fresh process. The worker passes no factory.

Known limits (stated, not fixed here): a turn started from another device
while the TUI is idle is tracked by the reducer but not rendered (no `send`
generator is running) — follow-up TUI task; pod `run`/`attach` lose the turn in
flight on a drop (model-proxy rule + new stdio daemon), surfaced as
`turn_lost`, never silently re-run.

### Files

Dependency order. 8a unless marked.

1. `packages/client/src/session-reducer.ts` — new, pure (§Design 1).
2. `packages/client/src/link-machine.ts` — new, pure (§Design 2, incl.
   `survives`).
3. `packages/client/src/mapping.ts` — add the turn adapter + `HistoryReset`
   type; `updateToEvent` unchanged.
4. `packages/client/src/ws-channel.ts` — `ChannelError`,
   `webSocketChannelFactory` (+ close-code classification, 401 probe).
5. `packages/client/src/remote-client.ts` — generations, factory, outbox,
   effects executor, permission dedupe/abort, `onLinkStatus`, `onCommitted`.
6. `packages/client/src/remote-session.ts` — reducer-backed view; `send`
   over the adapter; client-generated id.
7. `packages/client/src/index.ts` — exports.
8. `packages/client/test/vectors/reattach/*.json` + `packages/client/scripts/gen-reattach-vectors.ts`
   (+ root `package.json` script `vectors:reattach`).
9. `packages/client/test/{session-reducer,link-machine,reattach.e2e}.test.ts`,
   `packages/client/test/support/{link-cutter,transcript}.ts`.
10. `packages/tui/src/App.tsx` (type + one dispatch branch),
    `packages/tui/src/state.ts` (`resetHistory`), `packages/tui/test/state.test.ts`
    (or the existing state test file) — one case.
11. **[8b]** `packages/cli/src/local-runtime.ts`, `connect.ts`,
    `pod-runtime.ts`, `main.ts` (pass `link` to `startTui`),
    `packages/tui/src/run.tsx`, `components/StatusBar.tsx`, their tests.
12. *(only if Q5 is not delivered by `permission-events`)*
    `packages/core/src/permission.ts`, `packages/tui/src/permission-ui.ts`.

No protocol, daemon or transport file changes in this child (all wire needs
are Q1–Q4 on the siblings).

### Failure modes

| Case | How state converges |
|---|---|
| Drop with a command in flight, same daemon | outbox re-sends with the same key; dedupe gives one effect (Experiment 2b `k=5` is the test) |
| Drop before the command left (link known down) | queued, sent after recovery if still meaningful (outbox table) |
| Half-open socket (laptop slept) | first command's ack deadline → channel closed → reconnect |
| Live update overtakes `open` response | buffered by seq in `opening` (LBA, Experiment 1) |
| Replay overlaps what was applied | `seq ≤ applied` dropped |
| Gap (daemon bug, hostile pod) | forced resync; > 3/min → `fatal`, visible |
| Ring evicted `since` / fresh client / phone after hours | `resync`: snapshot + buffered tail; partial round discarded and replayed in full |
| `compact` (own or another device's) during replay or live | `history_replaced` → resync; never applied over stale history |
| Daemon restarted / new stdio daemon (attach, run) | `UnknownSession` → recreate from `committed`; in-flight turn → `turn_lost`, prompt not re-run |
| Turn ended while away (resync) | snapshot `turn` ≠ mine → generator ends; outcome from re-sent `prompt{turnId}` ack (Q3) |
| Pending approval, phone dead for hours | turn stays suspended daemon-side (no timeout); on resume the request is in the replay (or rebuilt after a restart) → one dialog, Approve/Deny work |
| Answered on another device meanwhile | `permission_resolved` → dialog aborted; local answer, if queued, dropped (not in `pending`) |
| Late answer after recovery | daemon `PermissionNotPending` → dialog closed with "answered elsewhere"; never silent |
| Unknown display event | applied as a no-op (seq counted) — requires Q1 |
| Unknown mandatory event | `fatal`, "update this client"; reconnect stops for that session |
| Bad token | `unauthorized` → stopped, reason shown; no retry storm |
| Version skew | `VersionMismatch` at `initialize` → stopped |
| Endless flapping | exponential backoff to 30 s; attempt counter resets only after 10 s up |
| `dispose()` during backoff/dial | timers cleared, late dial result closed and ignored (generation) |
| Late frame on an old generation | ignored by the generation guard (`peer.ts:260`, `ws-channel.ts:20-23` deliver it) |
| Snapshot paging races a compaction | cursor rejected → refetch, bounded by the reopen guard |

### Tests

Red before green (§9): every test below fails on `main` + children 3/4/7
(no reconnect, no reducer). Fakes only: `createChannelPair`, the cutter,
injected clock/random, `ScriptedProvider`/gated provider, `SpyBroker`-style
broker, a spy `ExecutionEnvironment` counting tool runs. No sockets except the
existing loopback smoke test.

**A. The parent property, end to end (`reattach.e2e.test.ts`).** Real
`SessionHost` (registry) + `Connection` per channel + `Agent` with a gated
scripted model; script S1 = turn 1: 3 text chunks, a `shell` tool call that
needs permission, approved, 2 more chunks; turn 2: 2 chunks. Script S2 =
turn, `compact`, turn. `LinkCutter` (`test/support/link-cutter.ts`, the
Experiment 2b decorator) counts frames in **both** directions with one counter
and cuts after frame *k*; the client's `channelFactory` returns a new pair
bound to a new `Connection` on the **same** `SessionHost`.
1. Run uninterrupted once → `N` frames and the reference: an observer reducer
   fed every update, sampled at each daemon seq `s` → `ref(s)`.
2. For every `k ∈ 1..N` and every path — (a) re-attach (same `RemoteClient`,
   own `since`), (b) fresh client (a new `RemoteClient`, no state, opens the id
   right after the drop, mid-round), (c) forced resync (same client, `since`
   omitted, i.e. the `reopen` effect) — hold the model gate, recover, then
   assert **at the observation point** `transcript(view) == transcript(ref(s))`
   where `s` = the daemon's last emitted seq, **and** the applied seq log
   after the last `reset` is exactly `cut+1, cut+2, …` (no gap, no
   duplicate). Release the gate, run to the end, assert the same at the final
   seq, model calls = uninterrupted count, tool runs = 1.
   `transcript` (`test/support/transcript.ts`) folds `committed` messages and
   the `tail` into one canonical list (user / assistant text / tool call +
   result), so a cut anywhere gives the same list. A bridge test pins
   `transcript(messages at round end) == transcript(events of that round)` for
   S1, so the comparison itself is not vacuous.
3. Outbox: for `k` at the `prompt` request frame and at its ack frame →
   exactly one turn ran (model calls), the caller's `send` completes.
4. **Acceptance (the phone scenario):** S1, drop while the permission is
   pending; advance the injected clock 6 h (no timers fire daemon-side — no
   timeout); (a) same client: the broker was prompted **once**, approving after
   recovery runs the tool once and the turn ends; (b) fresh client with a new
   broker (app killed): prompted once on open, Approve works; (c) Deny works
   and the turn continues as denied; (d) a second attached client answers
   first → the first client's dialog is aborted and its late answer is not
   sent.

**B. Reducer table (`session-reducer.test.ts`)** — runs every JSON vector:
dedupe, gap → reopen, update-before-open-result buffered, resync discards
partial round, `history_replaced` barrier, unknown display no-op, unknown
mandatory fatal, `recreated` → `turn_lost`, reopen guard.

**C. Link machine (`link-machine.test.ts`)** — backoff sequence with
`random = () => 1`, 30 s cap, no reset before 10 s up, `unauthorized` and
`VersionMismatch` terminal, `dispose` mid-backoff, ack-timeout → down, the
outbox table row by row.

**D. Shell unit tests (`remote.test.ts`, extended)** — generation guard (a
fake channel that delivers after close: the update is ignored), single broker
across reconnect (a broker spy sees one instance and one prompt), no factory →
a drop stays terminal (today's behaviour, pins the inert default),
`webSocketChannelFactory` classification against a `Bun.serve` returning 401 /
426 / closed port (the Experiment 5 setup).

**E. TUI (8a)** — `resetHistory` replaces items and keeps `running`; an
`App` frame test (ink-testing-library, `tui/test/app.test.tsx` pattern): a
session yielding `text "abc"`, `history_reset{[user hi, assistant ab]}`,
`text "c"` renders `ab` + `c` once, never `abc` twice.

**Mutations that must turn A or B red** (§9 non-vacuity; revert after):
disable seq dedupe; skip the resync snapshot (rebuild from tail only); ignore
`history_replaced` (S2 drop around `compact`); keep the local partial round on
resync; route updates only after the `open` result (drops the overtaking
update of the LBA); re-send `prompt` with a fresh `turnId`; do not re-send
un-acked commands; re-prompt on a replayed `requestId` (acceptance (a) sees two
prompts); build a second broker on reconnect (single-broker spy). The daemon-
side mutations of the parent (`since` = raw counter, ring reset at turn
start) are owned by `session-event-stream` but the same harness catches them:
run it once against each mutant and record the result in Execution.

**JSON test-vector format** (`packages/client/test/vectors/reattach/<name>.json`,
one case per file, generated — never hand-edited):

```json
{
  "format": "tentacle/client-reattach-vector",
  "formatVersion": 1,
  "protocolVersion": 2,
  "name": "s1-k07-fresh",
  "scenario": "s1-text-tool-permission",
  "path": "reattach | fresh | forced_resync",
  "dropAfterFrame": 7,
  "initial": { "sessionId": "s-1", "committed": [], "cut": 0, "applied": 0 },
  "steps": [
    { "in": { "kind": "open_sent", "since": null } },
    { "in": { "kind": "update", "params": { "sessionId": "s-1", "seq": 1, "class": "mandatory",
              "update": { "type": "turn_start", "turnId": "t-1", "prompt": [{ "type": "text", "text": "hi" }] } } } },
    { "in": { "kind": "open_result", "mode": "resync" },
      "expectEffects": [{ "kind": "fetch_snapshot" }] },
    { "in": { "kind": "snapshot", "messages": [], "since": 0, "turn": { "turnId": "t-1", "state": "running" } },
      "expectOut": [{ "kind": "reset", "messages": [{ "role": "user", "content": "hi" }] }, { "kind": "update", "seq": 1 }] }
  ],
  "expect": {
    "phase": "live", "cut": 0, "applied": 1,
    "committed": [], "tail": [{ "seq": 1, "update": { "type": "turn_start", "turnId": "t-1" } }],
    "turn": { "turnId": "t-1", "state": "running" }, "pending": [],
    "transcript": [{ "role": "user", "text": "hi" }]
  }
}
```

- `in` objects are exactly the reducer `Input`s; `update.params`, the
  `snapshot` fields and `open_result.mode` are **wire payloads** and are
  validated in the test with the zod `NotificationSchemas` /
  `RequestSchemas` (the source of the exported JSON Schema; the
  `protocol-schema-export` drift gate keeps them equal). A Swift/Kotlin
  harness validates the same payloads with the exported
  `packages/protocol/schema/protocol.json`.
- `expectOut`/`expectEffects` are optional per step (exact, ordered);
  `expect` is the final `SessionView` (maps as sorted arrays) plus the
  canonical `transcript`.
- Nonces are normalised by the generator (`s-1`, `t-1`, `r-1`, by first
  appearance) so files are stable. The generator records reducer inputs from
  the A-harness runs (all `k`, all paths, S1 and S2) plus the hand-picked
  B-rows expressed as scenarios; a drift test regenerates in memory and
  compares with the committed files ("run `bun run vectors:reattach`").

### Why, item by item

(Decisions not already argued in the Review.)

- **Why buffer from before `open` is sent.** Experiment 1: a live update can
  beat the response; routing only after the result loses it — silently, with
  no gap visible until the next event. Registering first and ordering by seq
  makes arrival order irrelevant.
- **Why replay as notifications, not inline in the `open` result (Q4).**
  Inline replay still races live notifications (same experiment), so the
  client would need two merge paths; one stream of seq-stamped updates needs
  one.
- **Why contiguity is checked, not just dedupe.** Dedupe hides duplicates;
  only contiguity exposes a *loss*. A silent gap is the "missing chunk"
  transcript the parent property was revised to catch.
- **Why a gap triggers a resync instead of an error.** The client cannot
  repair a hole from events; the snapshot can. Bounded by the reopen guard so
  a broken daemon becomes a visible error, not a loop.
- **Why the reducer emits effects instead of calling the network.** Keeps it
  pure and table-testable, and lets Swift/Kotlin run the same vectors and
  check they issue the same commands (`expectEffects`), not only the same
  state.
- **Why a separate pure link machine.** Backoff, flap guard, terminal
  classification and outbox survival are branching logic (AGENTS §7: logic in
  pure modules); in the shell they would only be testable with real timers.
- **Why outbox survival is decided from the recovered view.** Whether a
  re-send is right depends on what happened while away (the request already
  resolved, the turn already ended, the session recreated). The view after
  recovery is the only place that knows; deciding at drop time would guess.
- **Why never re-run a prompt on a recreated session.** The dead daemon may
  have run its tools; the new one does not know. Re-running could do "deploy"
  twice. `turn_lost` is honest; the user re-sends deliberately.
- **Why an ack deadline instead of a client ping.** Commands already ack at
  once in v2, so a missing ack *is* a liveness signal, with no protocol
  addition and no battery cost while idle. Idle keepalive is a transport
  concern (WS ping, Q12; server `sendPings`, `session-ttl-limits`).
- **Why client-generated session ids always.** The handler must exist before
  `open` is sent (LBA); a daemon-assigned id is only known after the
  response, too late.
- **Why `RemoteSession.send` keeps the `AgentEvent` shape plus one reset
  event.** The TUI's `applyEvent` reducer stays the single display path
  (`tui/src/state.ts:183`); a resync is a reset plus normal events, not a
  second rendering path. A mobile app skips the adapter and reads the view.
- **Why the factory is optional and the default stays terminal.** 8a can land
  without changing any runtime's behaviour (worker, current
  `connect`/`attach`); the risky part — turning reconnect on per transport —
  is reviewable on its own in 8b.
- **Why the 401 probe instead of a daemon change.** The daemon already answers
  a plain GET with 401 vs 426 (`ws-server.ts:166-173`); a client-side probe
  classifies precisely without weakening "reject before the socket opens".
- **Why the property test drives real daemon objects, not a fake daemon.**
  The cut, the ring and the barrier are daemon semantics; a fake would encode
  this doc's assumptions and pass by construction. The pure vectors cover the
  client alone; the e2e run covers the contract.

### Experiments

All in `.tentacle/tmp/client-reattach-impl/`, 2026-10-19, bun 1.4.3, `main` @
`4914e9b`. Run from that directory with `bun <file>`.

**1 — a live update overtakes the response of the request that attached the
sink** (`order.ts`):

```ts
import { RpcPeer, createChannelPair } from "@tentacle/transport";
const [d, c] = createChannelPair();
const frames: string[] = [];
let sink: ((seq: number) => void) | null = null;
let seq = 10;
const daemon: RpcPeer = new RpcPeer(d, {
  onRequest: async (method) => {
    // synchronous attach: compute replay + add sink in one tick
    const replay = [8, 9, 10];
    sink = (s) => daemon.notify("session/update", { sessionId: "s", seq: s, update: { type: "agent_message_chunk", content: { type: "text", text: `c${s}` } } });
    queueMicrotask(() => sink?.(++seq)); // the agent loop emits right after attach
    void replay; return { messages: [] };
  },
});
const client = new RpcPeer(c, {
  onNotification: (_m, p) => frames.push(`notification seq=${(p as { seq: number }).seq}`),
});
const r = await client.request("session/snapshot", { sessionId: "s" }).then(
  (x) => `response ${JSON.stringify(x)}`, (e) => `error ${e.message}`);
frames.push(r);
await new Promise((res) => setTimeout(res, 20));
console.log(frames.join("\n"));
```
```
notification seq=11
response {"messages":[]}
```

**2 — cut the link after exactly frame k (daemon→client), real daemon**
(`drop-at-k.ts`; model = 6 text chunks, no timers):

```ts
function cutAfter(inner: DuplexChannel, k: number): DuplexChannel & { sent: number } {
  const ch = {
    sent: 0,
    send(data: string) {
      if (ch.sent >= k) return; // link already cut: frame lost, as on a dead socket
      ch.sent += 1;
      inner.send(data);
      if (ch.sent === k) queueMicrotask(() => inner.close()); // delivered first, then drop
    },
    close: () => inner.close(),
    setOnMessage: (h: (d: string) => void) => inner.setOnMessage(h),
    setOnClose: (h: () => void) => inner.setOnClose(h),
  };
  return ch;
}
// per k: new Connection(cutAfter(d, k), new SessionHost(...)); client RpcPeer on c;
// initialize → session/new → session/prompt; log what the client saw.
```
```
k= 1 daemonSent=1 client saw [r:init] -> rejected: connection closed
k= 2 daemonSent=2 client saw [r:init r:new] -> rejected: connection closed
k= 3 daemonSent=3 client saw [r:init r:new u1] -> rejected: connection closed
k= 4 daemonSent=4 client saw [r:init r:new u1 u2] -> rejected: connection closed
k= 5 daemonSent=5 client saw [r:init r:new u1 u2 u3] -> rejected: connection closed
k= 6 daemonSent=6 client saw [r:init r:new u1 u2 u3 u4] -> rejected: connection closed
k= 7 daemonSent=7 client saw [r:init r:new u1 u2 u3 u4 u5] -> rejected: connection closed
k= 8 daemonSent=8 client saw [r:init r:new u1 u2 u3 u4 u5 u6] -> rejected: connection closed
k= 9 daemonSent=9 client saw [r:init r:new u1 u2 u3 u4 u5 u6 r:prompt {"stopReason":"end_turn"}] -> completed
k=10 daemonSent=9 ... -> completed
k=11 daemonSent=9 ... -> completed
```

**2b — one global counter over both directions** (`drop-both.ts`, same
decorator applied to both ends, logging each frame; model = 3 chunks, counts
calls):

```
k=5: 1:c2d:initialize | 2:d2c:response | 3:c2d:session/new | 4:d2c:response | 5:c2d:session/prompt | LOST d2c -> rejected: connection closed; model calls=1
k=6: 1:c2d:initialize | 2:d2c:response | 3:c2d:session/new | 4:d2c:response | 5:c2d:session/prompt | 6:d2c:session/update | LOST d2c -> rejected: connection closed; model calls=1
```
`k=5` is the ambiguous ack: the daemon ran the turn, the client saw only a
close.

**3 — a channel decorator sees the drop before the caller sees the
rejection** (`close-hook.ts`):

```ts
import { type DuplexChannel, RpcPeer, createChannelPair } from "@tentacle/transport";
const log: string[] = [];
let generationDropped = false;
function watched(inner: DuplexChannel, onDrop: () => void): DuplexChannel {
  return { ...inner, send: (d) => inner.send(d), close: () => inner.close(),
    setOnMessage: (h) => inner.setOnMessage(h),
    setOnClose: (h) => inner.setOnClose(() => { onDrop(); h(); }) };
}
const [d, c] = createChannelPair();
new RpcPeer(d, { onRequest: () => new Promise(() => {}) }); // daemon never answers
const peer = new RpcPeer(watched(c, () => { generationDropped = true; log.push("onDrop"); }));
const p = peer.request("session/snapshot", { sessionId: "s" }).catch((e) => log.push(`rejected (${e.message}); dropped flag=${generationDropped}`));
queueMicrotask(() => d.close());
await p;
console.log(log.join("\n"));
```
```
onDrop
rejected (connection closed); dropped flag=true
```

**4 — Bun's client WebSocket has `ping()`** (`wsping.ts`; contradicts
`pod-attach-resilience` Layer 1):

```ts
let pings = 0;
const server = Bun.serve({ port: 0, fetch(req, s) { return s.upgrade(req) ? undefined : new Response("x"); },
  websocket: { message() {}, ping() { pings++; } } });
const ws = new WebSocket(`ws://localhost:${server.port}`);
await new Promise((r) => ws.addEventListener("open", r));
console.log(`bun ${Bun.version}: typeof ws.ping = ${typeof (ws as unknown as { ping?: unknown }).ping}`);
(ws as unknown as { ping?: () => void }).ping?.();
await Bun.sleep(100);
console.log(`server saw pings: ${pings}`);
ws.close(); server.stop(true);
```
```
bun 1.4.3: typeof ws.ping = function
server saw pings: 1
```

**5 — a 401 is indistinguishable from other upgrade rejections on the
socket** (`ws401.ts`):

```ts
const server = Bun.serve({ port: 0, fetch() { return new Response("unauthorized", { status: 401 }); }, websocket: { message() {} } });
for (const url of [`ws://localhost:${server.port}`, "ws://localhost:1"]) {
  const ws = new WebSocket(url);
  const seen: string[] = [];
  await new Promise<void>((r) => {
    ws.addEventListener("error", (e) => seen.push(`error(${(e as ErrorEvent).message ?? ""})`));
    ws.addEventListener("close", (e) => { seen.push(`close(code=${e.code}, reason=${JSON.stringify(e.reason)})`); r(); });
  });
  console.log(`${url.includes(":1") ? "refused" : "401    "} -> ${seen.join(" ")}`);
}
server.stop(true);
```
```
401     -> error(WebSocket connection to 'ws://localhost:49595/' failed: Expected 101 status code) close(code=1002, reason="Expected 101 status code")
refused -> error(WebSocket connection to 'ws://localhost:1/' failed: Failed to connect) close(code=1006, reason="Failed to connect")
```

**6 — an unknown update type is dropped by peer validation, seq and all**
(`unknown-update.ts`):

```ts
import { RpcPeer, createChannelPair } from "@tentacle/transport";
const [d, c] = createChannelPair();
const daemon = new RpcPeer(d);
const seen: string[] = [];
new RpcPeer(c, { onNotification: (_m, p) => seen.push(`delivered seq=${(p as { seq: number }).seq}`), onError: (e) => seen.push(`onError: ${e.message}`) });
daemon.notify("session/update", { sessionId: "s", seq: 1, update: { type: "agent_message_chunk", content: { type: "text", text: "a" } } });
daemon.notify("session/update", { sessionId: "s", seq: 2, update: { type: "progress_bar", percent: 40 } });
daemon.notify("session/update", { sessionId: "s", seq: 3, update: { type: "agent_message_chunk", content: { type: "text", text: "b" } } });
await new Promise((r) => setTimeout(r, 10));
console.log(seen.join("\n"));
```
```
delivered seq=1
onError: invalid params for notification session/update
delivered seq=3
```

### Validation (for Execution)

Narrow per slice: `bun test packages/client/test/session-reducer.test.ts`,
`…/link-machine.test.ts`, `…/reattach.e2e.test.ts`. Before done: `bun run
check` (typecheck → lint → full suite, baseline: all pass except the opt-in
live-k8s skip; lint clean). Record each §Tests mutation and its red result in
Execution. Manual (8b): `tentacle serve` + `connect`, kill the network
mid-turn and mid-approval, confirm the StatusBar state and the dialog after
recovery.

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `session-event-stream`, `session-registry` and
`permission-events`.** A suspended turn (parent point 8) must render as
"waiting for your approval" with working Approve / Deny after any resync. Scope:
- A **pure, React-free reducer** (AGENTS §7 "logic lives in pure modules"):
  `(state, event | openResult | snapshotPage) → state`; applies `seq > since`,
  drops `seq ≤ since`, rebuilds on resync (discarding the partial round),
  applies `history_replaced`, ignores unknown *display* events, fails loudly on
  an unknown *mandatory* one.
- `RemoteClient`: reconnect with backoff via an injected channel factory;
  `open{sessionId, since}`; on resync, paged `snapshot` → reducer → replay;
  re-send un-acked commands with their idempotency keys.
- Persistence unchanged: the main thread persists from `snapshot` after
  `turn_end` and after every resync.
- TUI: a "reconnecting…" status via the single `StatusLine` path — never raw
  terminal writes (AGENTS §7).
- Test vectors (frame sequence + drop point + expected reducer output) written
  as **JSON fixtures**, validated against the exported schema
  (`docs/feat/protocol-schema-export.md`), so a Swift/Kotlin client can run the
  same cases.

**Why, item by item.**

- **Why in `RemoteClient`, not in each frontend.** If the TUI, the React Native
  app and an ACP adapter each implemented reconnect, they would diverge, and the
  subtle parts (the cut, seq dedupe, the compaction barrier) would be
  re-implemented wrong at least once. One session path (AGENTS §7); React
  Native imports the same TypeScript module.
- **Why a pure reducer.** The logic is a state machine with many edge cases
  (gap, duplicate, resync mid-round, barrier, unknown event). Pure and
  React-free, it can be tested exhaustively as a table, without sockets or
  rendering (AGENTS §7: logic in pure modules; the TUI harness strips SGR, so
  render-time logic is untestable).
- **Why drop `seq ≤ since` instead of trusting the daemon not to resend.**
  Re-sent events are normal: the ack-ambiguity retry, a replay overlapping
  frames that were in flight. Idempotent application is what makes recovery
  safe to repeat.
- **Why discard the partial round on resync.** The snapshot's cut sits *before*
  the round in flight (F1), so replay re-sends that round in full; keeping the
  local partial would show its first part twice.
- **Why fail loudly on an unknown mandatory event.** Ignoring it means a hang:
  a spinner forever, or an approval nobody can see. A loud "please update" is
  recoverable; a silent hang is not.
- **Why an injected channel factory.** Every reconnect needs a fresh socket.
  Injection also allows `FakeWS`-driven tests and lets React Native or Swift
  bring their own transport (the `URL.searchParams` / header issue in
  `ws-channel.ts:69-77`).
- **Why re-send un-acked commands with the same keys.** It is the ambiguous-ack
  case: without the keys a re-send duplicates the command; without the re-send
  the command is lost.
- **Why persist after `turn_end` and after every resync.** Keeps the AGENTS §7
  rule that the client persists from `snapshot`. After a resync the local state
  was rebuilt from the daemon, so persisting then keeps disk aligned with what
  the user sees.
- **Why the status goes through `StatusLine`.** "Reconnecting…" is exactly the
  kind of message someone would `console.log` mid-session, corrupting Ink's
  render (AGENTS §7: never write raw while Ink owns the terminal).
- **Why a backoff cap and stop-on-401.** Unbounded fast retries drain a phone
  battery and hammer the server; a rejected token is not transient, retrying it
  only hides the real problem from the user.
- **Why JSON test vectors.** The property is the contract, not the TypeScript
  code; a Swift or Kotlin client must pass the same cases. Writing them as data
  costs nothing now and avoids a translation later.
- **Why the suspended-turn rendering is called out.** The owner's scenario —
  phone dies on a pending approval, comes back hours later, finds the turn
  waiting with working Approve / Deny — is the acceptance test of the whole
  redesign. If it does not work end to end, the rest does not matter.

Failure modes: reconnect while a command is in flight (re-send with same key);
daemon restarted (`UnknownSession` → recreate with persisted `messages`); token
rejected (stop retrying, surface it); endless flapping (backoff cap +
user-visible state). Mobile note (owned by the mobile eval): a frozen iOS app
reconnects on foreground; this module just has to make that a normal resume.

Tests: the parent's revised property end to end (client + daemon, in-memory
channel pair): every drop point *k*, both re-attach and fresh/forced-resync
mid-round, ordered reducer output (incl. the partial message) + seq contiguity.
Mutations that must fail it: disable seq dedupe; skip the resync snapshot;
ignore `history_replaced`.
