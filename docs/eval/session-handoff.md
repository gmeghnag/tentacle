# eval/session-handoff — continue the same daemon session from another device

> **Status:** context — owner decision recorded (2026-10-20); open questions Q1–Q8 deliberately left open, to be resumed later (owner, 2026-10-20)
> **Update (2026-10-23):** Q1–Q8 answered in `docs/eval/mobile-app.md` (decisions 3–7, 21); the work is tasks 1, 2, 6, 7 of its decision 21.
> **Branch:** none (an `eval` is committed directly to `main`, AGENTS §10)
> **Type:** eval → feat (likely split, see Q8) · **Size:** L → split · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (protocol, session lifecycle, TUI-over-RPC, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-20*

**Owner decision (2026-10-20):** *"If I am on mobile and then want to resume
the same session from the TUI, I must be able to do it, and the TUI must update
automatically with everything already done in the app."* Session handoff
between devices on one `tentacle serve` daemon is a requirement of protocol v2,
both ways (mobile → TUI, TUI → mobile), and a TUI attached to a session must
show what another device does on it.

**Question being decided:** what a client needs — protocol, daemon lifecycle,
client, TUI — so that a session started on one device is listed, opened and
followed live on another.

Scope: `serve` + `connect` (and the future mobile app) only. Worker and pod
runtimes (`run`/`attach`) have exactly one client — the laptop — and no other
device can reach their daemon; they are out of scope.

### What already exists (v2, verified on `feat/client-reattach-frontends`)

- **The daemon allows multi-attach.** A `HostedSession` holds a set of
  attachments; `session/open{sessionId}` on a live session attaches
  (`daemon/src/session-host.ts:97-101`), replays from the cut or the client's
  `since`, and fans every update out to all attachments. Permission requests
  are events to every attachment; the first valid answer wins (8a test E3).
- **Sessions survive disconnects and `serve` restarts** (registry, TTL,
  daemon-side persistence: `docs/feat/session-registry.md`,
  `session-ttl-limits.md`, `daemon-side-persistence.md`).
- **The client re-attaches its own session by id** after a drop (8a/8b).

### Gaps (each verified in the code)

- **G1 — a session cannot be found.** No `session/list` method
  (`protocol/src/methods.ts:38-47`); `connect` always opens a NEW session with
  a random id (`cli/src/connect.ts`, `newSession(undefined, crypto.randomUUID())`)
  and has no `--session`/`--resume`. The id is the only key, and no client
  shows it.
- **G2 — quitting a client destroys the session.** `connect` calls
  `client.closeSessions()` on exit (`cli/src/connect.ts`, the `finally`);
  `session/close` ends the turn and background jobs and deletes the persisted
  record (`session-host.ts:125`, `persister.remove`). So "start on mobile, quit,
  continue on the TUI" (or the reverse) is impossible today regardless of G1.
- **G3 — the TUI shows nothing of a session it opens.** `RemoteSession` opens
  lazily on the first `send` (`client/src/remote-session.ts`, `runTurn`), and
  `output()` drops everything while no own turn runs (`:208-212`, "idle: a
  turn started elsewhere is not rendered (known limit)"). An open of an
  existing session resyncs (snapshot → `reset`) — dropped too.
- **G4 — turns started elsewhere are not rendered**, even after G3: the App
  only renders the generator of its own `send`; a foreign `turn_start` →
  chunks → `turn_end` has no consumer, and the App's busy/input state does not
  know a turn is running.
- **G5 — idle sessions are reaped after 24 h** (`DEFAULT_SESSION_TTL_MS`,
  `daemon/src/session-reaper.ts:16`): a handoff after a day finds nothing.
- **G6 — one token = every session.** Listing (G1) makes that explicit: any
  token holder sees and can drive every session of the daemon.

## Open questions (owner) — each with a recommendation

- **Q1 — Discovery.** *Recommend:* new `session/list` → `[{sessionId, title,
  cwd, createdAt, updatedAt, running, attached}]` (additive method; an old
  daemon answers `MethodNotFound`, which `connect` reports). `connect --resume
  [id]` mirroring the local `--resume` (no id → the most recent; `--resume` with
  no sessions → a new one, said so), plus a `/sessions` picker inside the TUI.
- **Q2 — What "quit" means.** *Recommend:* quitting a client **detaches**
  (the session, its turn and its background jobs keep running on the daemon,
  reaped by the TTL); ending a session is explicit (`/clear` = close + new,
  a new `/close`). Consequence to accept: a turn left running keeps spending
  tokens while nobody watches. Alternative: detach only when idle, ask when a
  turn runs.
- **Q3 — Opening an existing session in the TUI.** *Recommend:* open eagerly
  at mount when resuming; the snapshot becomes the initial transcript (same
  path as a local `--resume`, `messagesToItems`), then live updates.
- **Q4 — Foreign turns in the TUI.** *Recommend:* render them exactly like
  own turns (the prompt as a user bubble from `turn_start{prompt}`, streamed
  output, tools), and put the App in the busy state while ANY turn of the
  session runs: Esc cancels it, typing steers it (`enqueue` binds to the running
  `turnId` — already keyed). This makes the TUI a view of the SESSION, not of
  its own requests — the shape a mobile app needs too. Logic in a pure module
  (AGENTS §7: "logic lives in pure modules").
- **Q5 — Permission prompts for a turn started on another device.**
  *Recommend:* shown on every attached device, first answer wins (as built),
  and the dialog says which device asked if known. Alternative: only the device
  that started the turn is asked — but then a turn started on the phone that
  you continue on the TUI is stuck.
- **Q6 — Access control.** *Recommend:* keep "token = the daemon's owner"
  (single-user daemon) for now; per-device tokens + revocation are the mobile
  app's eval.
- **Q7 — TTL.** *Recommend:* keep 24 h idle as the default, already
  configurable on `serve`; say it in `--help` and in `/sessions` (time left).
- **Q8 — Split.** *Recommend:* (a) protocol + daemon: `session/list`,
  `title`/`updatedAt` in it — M, load-bearing (protocol); (b) client + TUI:
  eager open, session-view rendering of foreign turns (Q3/Q4) — L,
  load-bearing (TUI-over-RPC); (c) `connect`: detach-on-quit, `--resume`,
  `/sessions`, `/close` — M, cross-module. Order a → b → c; (c)'s
  detach-on-quit must not land before (b), or a resumed session would look
  empty.

## Implementation

## Execution

## Review
