# feat/mobile-session-view — the session screen: open, live transcript, prompt, permission asks (mobile task 12)

> **Status:** implementation (plan written, **not approved** — see Owner questions)
> **Branch:** umbrella `feat/mobile-session-view` (this doc). Each sub-task runs on its own branch, carved from its section below (the `device-pairing` precedent): `feat/mobile-session-link` (12a), `feat/mobile-transcript-model` (12b), `feat/mobile-session-screen` (12c).
> **Size:** L as a whole → split: 12a S–M · 12b M · 12c M · **Blast:** 12a **load-bearing** (single broker, session lifetime — app-side, but it is where the §7 invariants live for the phone) · 12b contained · 12c contained · **Suited:** 12a a strong executor + mandatory fresh-context Review that red-teams "single broker" and "leaving detaches, never closes"; 12b/12c any capable executor + fresh-context Opus Review (12c's Maestro run is part of the gate, decision 20)
> **Changelog:** `changelog.d/mobile-session-view.added.md`, written on 12c's branch (the first user-visible slice). 12a and 12b: none (no visible behaviour on their own).

## Context

*— claude-opus-5-5, 2026-11-13*

Mobile task 12 (`docs/eval/mobile-app.md`, decision 21 table: "Live transcript
(markdown, code, tools, diffs)", L · contained). The 11a shell
(`docs/feat/mobile-app-shell.md`, merged `83d5864`) left `Session` as a
placeholder that **never calls `session/open`**
(`apps/mobile/src/screens/SessionScreen.tsx:1-6`, shell Owner Q5 = a: "attaching
is task 12's"). This task makes the phone a real view of a session: open it,
see its full history then live updates (own and foreign turns), send a prompt,
and answer permission asks.

**Scope against the eval's 12/13 split.** The brief for this task joins task
12's transcript with the two parts of task 13 without which a transcript
screen is not usable on its own: a prompt while idle, and approvals. Left in
task 13: steer while a turn runs (`session/enqueue`, decision 15), "Send now",
queued rows, returned rows, offline outbox (decision 16). Owner question 1.

Owner decisions this task serves (eval):
- **4** leaving (closing the app, the screen, losing the network) **detaches,
  never closes**; ending is explicit.
- **5** every client is a view of the SESSION: full history at once, then live;
  a turn started anywhere renders like an own one; any device can stop it; a
  permission ask shows on every attached device, first answer wins, others close.
- **11** transcript: markdown, highlighted code blocks, tools collapsed with
  tap-to-expand, readable diffs; light/dark, accent `#0E7490` / `#06B6D4`.
- **13** native iOS UI; only the transcript and the input bar are custom.
- **15** Stop: the send button becomes ■ while a turn runs and the field is empty.
- **20** logic in pure TS modules under `bun test`; Maestro E2E on the iOS
  simulator, mandatory before merge.
- Mockups approved 2026-11-01 (eval "UI direction"): live transcript, diff,
  permission sheet (with "No, let's talk about it" — `permission-reply`, DONE
  `1ee6123`).

**Repro 1 (2026-11-13, this worktree) — the capability is missing.**

```
$ rg -n "session/open|attachSession|newSession|openSession" apps/mobile/src apps/mobile/App.tsx
(no matches)
```

**Repro 2 (2026-11-13) — the 11a link would silently DENY every ask once the
phone attaches.** 11a gives the client `new PermissionBroker(denyAll)`
(`apps/mobile/src/connection.ts:86`). `denyAll` returns `{allowed: false}`
(`packages/core/src/permission.ts:150`), not `DISMISSED`, so the router turns
it into a real refusal sent to the daemon (`client/src/permission-router.ts:143-171`,
`remote-client.ts:3467-3500`). Script
`.tentacle/tmp/mobile-session-view/deny-hazard.ts`: an in-process `SessionHost`
whose model calls an `ask` tool; a "laptop" client whose requester never
answers starts the session and a turn; a "phone" client attaches with
`newSession(undefined, sid, undefined, {attach: {}})` + `open()` (the eager
attach path), with the 11a broker (`denyAll`) or with
`new PermissionBroker(undefined, {holdUntilSet: true})` (`hold`):

```ts
// essentials (full script in .tentacle/tmp/mobile-session-view/deny-hazard.ts)
const laptop = dial(new PermissionBroker(() => { laptopAsked++; return new Promise(() => {}); }));
const phone = dial(mode === "hold"
  ? new PermissionBroker(undefined, { holdUntilSet: true })
  : new PermissionBroker(denyAll));
for await (const _ of ls.send("hi")) {}                       // laptop creates the session
const ps = phone.newSession(undefined, sid, undefined, { attach: {} });
await ps.open();                                               // phone attaches
for await (const e of ls.send("ask")) …                        // laptop's turn asks
```

```
$ bun .tentacle/tmp/mobile-session-view/deny-hazard.ts denyAll
mode=denyAll turn=ended laptopAsked=1
   {"type":"tool_result","id":"c1","name":"ask","result":{"content":"Permission denied by the user: `ask` was not run.","isError":true}}
   {"type":"text","delta":"tool said: Permission denied by the user: `ask` was not run."}
$ bun .tentacle/tmp/mobile-session-view/deny-hazard.ts hold
mode=hold turn=still waiting (ask pending)  laptopAsked=1
```

The laptop's own user was asked, but the phone answered first — with a "No"
nobody gave. This is the §7 silent-auto-answer failure in its deny form, and
the first thing 12a fixes (its regression test is this repro).

**Hazard 3 (by reading, proved by 12a's test) — the 11a link would ARCHIVE the
session on app exit.** `ComputerLink.close()` calls `client.closeSessions()`
(`apps/mobile/src/connection.ts:101`), i.e. `session/close{ifLast: true}` for
every session the client holds (`remote-client.ts:1478-1489`), and `App.tsx:252`
calls it on unmount. Harmless while 11a opens nothing; once the phone holds a
session, leaving the app as the last attached client would END it — against
decision 4. Task 7 fixed the same thing for `connect` ("quit = just close the
socket", `drain()` instead of `closeSessions()`, eval QR4).

## Implementation

*— claude-opus-5-5, 2026-11-13*

### Load-bearing assumption

**The phone's session screen is the TUI's attach path, unchanged: one
`RemoteClient` per computer, `newSession(…, {attach})` → `RemoteSession.open()`
/ `watch()` / `send()` / `detach()`, and ONE `PermissionBroker` on that client
whose requester is the phone's permission sheet — no protocol change, no
second session path, no mobile-only daemon logic (AGENTS §7 "one session path",
"single broker"; eval decision 15 "same daemon methods, no mobile-only logic").**

Proved:
- The client already exposes the attach path for exactly this consumer:
  `SessionStreamListener` is documented as "A session's consumer
  (`RemoteSession`, a mobile view)" (`packages/client/src/remote-client.ts:211-214`);
  `newSession(seed, id, title, {attach})` builds a `RemoteSession`
  (`remote-client.ts:954-969`); `open()` does `attachSession` — `session/open
  {sessionId, reopen?}`, never a create, full history as a `history` activity
  (or a foreign turn mid-turn), bounded by `ATTACH_TIMEOUT_MS` = 30 s
  (`remote-session.ts:337-360`, `remote-client.ts:983-1037`,
  `client/src/constants.ts:12`); `watch()` delivers `turn` / `history` /
  `closed` activities (`remote-session.ts:102-123,273-283`); `send()` mints a
  turn id and yields `SessionEvent`s (`remote-session.ts:985-1000`).
- Repro 2 ran that exact path (`newSession{attach}` + `open()`) against a real
  `SessionHost` through `Connection`, and showed a permission ask reaching the
  phone's broker: the ask path needs no new code, only a correct broker.
- `serve` runs the model itself; a phone client that serves no model
  (`RemoteClient(channel, broker, undefined, …)`, `connection.ts:87`) ran a
  full streamed turn on a real iPhone (eval "First run on a real iPhone:
  GREEN", `docs/eval/mobile-app.md:375-380`).

### Preconditions

- **P1 — the client declares every update type** at `initialize`
  (`clientCapabilities.updates: [...KNOWN_UPDATE_TYPES]`, `remote-client.ts:2273`),
  so the daemon sends `permission_request` (blocking) to the phone as mandatory
  (`protocol/src/updates.ts:475`, AGENTS §7 "blocking").
- **P2 — an ask with NO attached client waits** (the owner's exception; a
  cancel settles it), and is re-offered to a client that attaches
  (`daemon/src/hosted-session.ts:1051-1058` and `:1040-1048`). So a phone that
  drops its link while an ask is pending loses nothing, and finds the ask again
  on re-attach.
- **P3 — the router never prompts twice** for a replayed request and treats
  `permission_resolved` as display-only (`client/src/permission-router.ts:1-16`);
  an answer is keyed by `requestId` and re-sent after a drop, and a
  `PermissionNotPending` (answered elsewhere) is not an error
  (`remote-client.ts:3517-3541`).
- **P4 — `holdUntilSet`** queues requests while no requester is set and hands
  them, in order, to the next `setRequester` (`core/src/permission.ts:162-171,186-208`);
  `connect` already builds its broker this way (`cli/src/connect.ts:153`).
- **P5 — detach keeps the session running** for everyone and withdraws this
  client's open prompts (`remote-client.ts:1366-1376,1392-1396`;
  `RemoteSession.detach`, `remote-session.ts:798`); `RemoteSession.close()` is
  `session/close` (ends it; `remote-session.ts:752-764`) — never called by this
  task. `drain()` + `close()` is the exit path of a client whose sessions
  outlive it (`remote-client.ts:1437-1456`).
- **P6 — no client-side keepalive exists** (no ping in `packages/client/src`);
  `serve` pings and closes a silent socket after 60 s
  (`daemon/src/ws-server.ts:29-34,75-78`). A dropped channel is redialled by
  `channelFactory`, and a factory that awaits delays the redial without other
  effects — the pattern `foreign-turns.test.ts:145-203` (`hold`/`release`) uses.
- **P7 — diffs exist only live**: a tool result's `diff://` resource becomes
  `details: {kind: "diff", path, patch, added, removed}` (`client/src/mapping.ts:197-227`);
  a history `ChatMessage` has no diff field (`core/src/model.ts:31-79`), and the
  TUI's resume shows none either (`tui/src/resume.ts`, no `diff` reference).
- **P8 — the TUI's transcript fold is pure** (`tui/src/state.ts`: `applyEvent`,
  `resetHistory`, `applySessionEvent`, imports only `@tentacle/agent` /
  `@tentacle/core` / pure TUI siblings), but it is being reworked by
  `feat/app-decomposition` (`docs/feat/app-decomposition.md:339,352`), and it
  pulls `@tentacle/agent` at runtime (`resume.ts:6`, `restartPromptOf`) — not a
  dependency to put in the app bundle now (Owner question 5).
- **P9 — Maestro sees no text** on RN's new architecture: assertions are by
  `testID` only (`mobile-app-shell.md:470-477`); daemon-side truth is asserted
  through harness hooks (`apps/mobile/e2e/hooks.ts`, `runScript`). iOS 18 is not
  installable with Xcode 27.1: E2E runs on **iOS 26.5** only (shell Review,
  orchestrator decision).
- **P10 — a just-opened ask must not take a stray tap** — the TUI's open item
  (3) "Enter typed for `/quit` approves a permission ask that just opened — no
  age guard" (`TODO.md:489`). The phone's sheet gets an age guard from the start.
- **P11 — no protocol change is needed**: open/attach, prompt, cancel{turnId},
  resolve_permission (with reply), detach, list all exist (`remote-client.ts`
  methods above). No `protocol.d/` note, no `PROTOCOL_VERSION` change.

### Design

Shape (AGENTS §7 "logic lives in pure modules"): every decision in a
React-free module under `apps/mobile/src/` with `bun test` coverage; screens
map a view-model to elements and own only presentation.

#### 12a — the session link (S–M · load-bearing)

1. **One broker, interactive, held until the sheet is up.** `openComputer`
   builds `new PermissionBroker(undefined, {holdUntilSet: true})` (P4) — never
   `denyAll`, never the `allowAll` default. The `ComputerLink` exposes it as
   `permissions: PermissionBroker`; the session screen calls `setRequester`
   with the sheet's requester on mount and `reset()` on unmount. With no
   requester set, a request waits — it is never answered by the phone without
   a person.
2. **Leaving never ends a session.** `ComputerLink.close()` becomes `await
   client.drain(); client.close()` (task 7's shape) — no `closeSessions()`
   anywhere in the app. The screen leaves with `RemoteSession.detach()` (P5).
3. **`session-controller.ts` (pure, injected client).** Per computer:
   `open(sessionId, {reopen})` → builds the `RemoteSession` with `{attach}`,
   calls `open()`, subscribes `watch`; `leave(sessionId)` → `detach()`.
   Serialised **per session id**: an `open` issued while the same id's `detach`
   is in flight awaits it (back-then-forward fast must not race the client's
   session table, `remote-client.ts:1384-1391`). Errors mapped to a typed
   reason: `archived` (`SessionArchived`), `deleted` (`SessionDeleted`), `gone`
   (`UnknownSession`), `too-many` (`TooManySessions` on reopen), `timeout`
   (`AttachTimeoutError`), `link` (anything else) — by error class/code, never
   by message text.
4. **`foreground-gate.ts` (pure).** Wraps the link's `channelFactory`:
   `suspend()` closes the current channel and makes the next dial wait;
   `resume()` releases it. `App.tsx` calls `suspend` when `AppState` leaves
   `active` and `resume` on `active` (Owner question 3). The client then sees
   an ordinary drop + redial and re-attaches with `since` — its existing
   replay/resync path (`session-reducer.ts:1-20`), no new recovery code.
   Rationale: iOS suspends JS within seconds; without this the daemon keeps a
   ghost attachment up to 60 s (P6) and, on return, the app may sit on a dead
   socket with no close event (no client keepalive). Deterministic beats
   hoping for a close.

#### 12b — the transcript model (M · contained)

`transcript.ts` (pure): `State` + `apply(state, input)` where `input` is a
`history` (messages → rows), a `SessionEvent` of a turn (own or foreign, same
code path), `turn_started{turnId, own}`, `turn_ended{outcome}`, `closed`,
`link(status)`. Rows (stable keys for a virtualised list):
`user`, `assistant` (markdown source + a monotonically growing `version`),
`reasoning` (collapsed), `tool` (`id`, label, status
`queued|running|ok|error|denied`, collapsed output, optional `diff`),
`notice` (turn interrupted / lost / unsupported update once per kind / ended
on another device / history compacted), `turn` (running indicator).
Semantics follow the TUI's fold (`tui/src/state.ts`) and are pinned to it by a
**parity test** on shared fixtures (Owner question 5).
- `markdown.ts`: `marked` lexer → a small token tree (paragraph, heading,
  list, code{lang, text}, inline code, emphasis, link{href, text}, table as
  monospace text). Parse cached per row `version`; a row over a size bound is
  split into "show more" (no 1 MB parse on the JS thread).
- `highlight.ts`: `highlight.js/lib/core` with a fixed registered language
  set → `[{text, scope}]` spans; unknown language → plain monospace.
- `diff-view.ts`: a unified `patch` → hunks of `{kind: add|del|ctx, oldNo,
  newNo, text}` with counts that agree with `mapping.ts` `countDiff`; bounded
  lines with a truncation marker.
- `stream-batch.ts`: coalesces deltas to one state commit per frame window
  (~50 ms, injected clock) so a fast stream does not re-render per chunk.
- Strings from the daemon are data: no markdown link is auto-opened; a tap
  goes through a confirmation that shows the full URL (Owner question 7).

#### 12c — the screen (M · contained)

- **`session-view.ts` (pure):** joins controller state + transcript +
  link status into the screen's view-model: header (title, project, state),
  banner (`reconnecting` / `ended elsewhere` / `deleted` / `archived →
  Reopen` / `too old`), rows, composer.
- **`composer.ts` (pure):** `send` enabled iff link `up` ∧ no turn running ∧
  text not blank; the button is **■ Stop** iff a turn runs (own **or** foreign)
  ∧ the field is empty (decision 15; Stop = `cancel(turnId)` of THAT turn, as
  the TUI's Esc — `RemoteSession` turn `cancel()` for foreign,
  `AbortSignal` for own); text typed while a turn runs stays in the field
  (steer is task 13). A failed `send` before the daemon's ack puts the text
  back (never lost).
- **`permission-sheet.ts` (pure):** the requester given to the broker resolves
  from the sheet: FIFO, one at a time (the router already serialises,
  P3); **age guard** — taps within `ARM_MS` (400 ms, injected clock) of a
  request appearing or changing are ignored (P10); options exactly as offered
  (`allow once`, `allow for session` if offered, `deny`, and "No, let's talk
  about it" with a text field only when `reply` is offered); an `abort` signal
  (withdrawn / answered on another device / detached) closes the sheet without
  sending (`DISMISSED`); an answer whose words are lost (`onAnswerLost`) puts
  them back in a refusal field. Inside the unlocked app, approving needs no
  Face ID (decision 14).
- **Screens:** `SessionScreen.tsx` rewritten — `FlatList` of rows (dumb row
  components per kind), native-stack header, a bottom input bar
  (`KeyboardAvoidingView`), the sheet as a native `Modal` page sheet. Stable
  `testID`s: `session-view`, `row-<key>`, `tool-<callId>-<status>`,
  `diff-<callId>`, `turn-running`, `turn-idle`, `composer-input`,
  `composer-send`, `composer-stop`, `banner-<kind>`, `perm-sheet`,
  `perm-<optionId>`, `perm-reply-input`, `reopen`.
- **Archived sessions:** tapping one opens the screen with the `archived`
  banner and a **Reopen** button; only that button sends `open{reopen}`
  (Owner question 4) — browsing the list has no side effect.
- **E2E harness additions:** the mock model learns OpenAI tool-call SSE:
  a prompt `EDIT <name>` calls `fs_write` (an `ask` tool,
  `tools/src/builtins.ts:115-118`) on `project/<name>`; `HOLD` keeps its
  current meaning. New hooks: `laptop-prompt` (the seed client attaches and
  starts a turn on a session), `laptop-answer`, `session-state` (via
  `sessionList`: `attached`, `running`, `archived`), `history` (the
  daemon's last user/assistant text, by `snapshot`), `file-exists`,
  `release-hold`.

### Sub-tasks, files, order

Order **12a → 12b → 12c** (12c needs both). 12b's files are disjoint from
12a's (pure modules + their tests only); if the owner's 2-task rule applies,
12b may run beside 12a.

**12a `mobile-session-link` — S–M · load-bearing**

| File | Change |
|---|---|
| `apps/mobile/src/connection.ts` | `holdUntilSet` broker exposed on `ComputerLink`; `close()` = `drain()` + `close()`; the factory wrapped by the gate |
| `apps/mobile/src/foreground-gate.ts` (new) | `suspend` / `resume` over a `channelFactory` |
| `apps/mobile/src/session-controller.ts` (new) | open / leave / reopen, per-id serialisation, typed error reasons |
| `apps/mobile/App.tsx` | `AppState` → gate (wiring only) |
| `apps/mobile/test/connection.test.ts` | broker test inverted (hold, not deny) + close test |
| `apps/mobile/test/session-link.test.ts` (new) | in-process daemon, two clients (below) |
| `apps/mobile/test/foreground-gate.test.ts`, `session-controller.test.ts` (new) | pure |

**12b `mobile-transcript-model` — M · contained**

| File | Change |
|---|---|
| `apps/mobile/package.json`, `bun.lock` | `marked` (pin = the TUI's `12.0.2`), `highlight.js` (exact pin, Step 0) — `apps/mobile` entries only |
| `apps/mobile/src/transcript.ts`, `markdown.ts`, `highlight.ts`, `diff-view.ts`, `stream-batch.ts` (new) | pure |
| `apps/mobile/test/transcript.test.ts`, `transcript-parity.test.ts`, `markdown.test.ts`, `highlight.test.ts`, `diff-view.test.ts`, `stream-batch.test.ts` (new) | pure |
| `apps/mobile/test/fixtures/transcript/*.json` (new) | event fixtures shared by the parity test |

**12b Step 0 (blocking):** bundle `marked`'s lexer and `highlight.js/lib/core`
into the Release build and run them under Hermes on the 26.5 simulator (a
`testID` set by a one-off probe screen, Maestro asserts it) — the eval's
portability proof covered only the client packages. A failure → STOP and
report (two-strike rule); fallback candidates are named in Execution, not
picked silently.

**12c `mobile-session-screen` — M · contained**

| File | Change |
|---|---|
| `apps/mobile/src/session-view.ts`, `composer.ts`, `permission-sheet.ts` (new) | pure |
| `apps/mobile/src/screens/SessionScreen.tsx` (rewritten), `screens/transcript/*.tsx` (new row renderers), `screens/PermissionSheet.tsx` (new) | presentation only |
| `apps/mobile/src/routes.ts` | `SessionRoute` + `archived: boolean` |
| `apps/mobile/App.tsx` | Session route wiring (controller, broker requester) |
| `apps/mobile/src/screens/SessionsScreen.tsx` | pass `archived` on navigate |
| `apps/mobile/e2e/mock-model.ts`, `hooks.ts`, `run.ts`, `seed.ts` | tool-call SSE, new hooks |
| `apps/mobile/e2e/flows/04-session-placeholder.yaml` | **deleted** (superseded by 06) |
| `apps/mobile/e2e/flows/06…11-*.yaml` (+ `runScript` bodies) | below |
| `apps/mobile/test/session-view.test.ts`, `composer.test.ts`, `permission-sheet.test.ts` (new), `e2e-flows.test.ts` (extended) | pure |
| `changelog.d/mobile-session-view.added.md` | the fragment |

Not touched: `packages/**` (no protocol, daemon, client, TUI change — P11).

### Failure modes

| # | Case | Behaviour | Convergence |
|---|---|---|---|
| F1 | **Ask arrives before the sheet is mounted** (attach replay re-offers a pending ask) | `holdUntilSet` queues it (P4) | delivered to the sheet on `setRequester`, in order |
| F2 | **Ask while the screen is gone / app backgrounded** | screen left → `detach` withdraws prompts (P5); background → link suspended; the daemon's own `attached` count lags until its 60 s ping fails (iOS freezes JS on background — 12c Execution finding 4), so it may still count the phone for a while | the ask WAITS regardless (P2): the laptop may answer it; else it is re-offered on the next attach/resume and shown then |
| F3 | **Permission ask while the phone sleeps**, nobody else attached | daemon waits (P2); push is task 16 | on unlock + foreground: resume → re-attach → re-offer → sheet; a turn it blocked continues on the answer |
| F4 | Ask answered on another device while the sheet is open | `permission_resolved` → abort → sheet closes, nothing sent (P3) | — |
| F5 | Phone answers, link drops before the ack | keyed re-send on reconnect; `PermissionNotPending` = settled elsewhere, silent (P3) | executed once |
| F6 | Tap lands as the sheet appears / swaps to the next ask | age guard ignores it (P10) | the person taps again |
| F7 | Reply refusal on a request that offers none / words lost | not sent; words back in the field (`onAnswerLost`, `unreplyable`) | — |
| F8 | **Disconnect mid-turn** (own or foreign) | banner `reconnecting`; client redials, re-attaches with `since`; replay or resync (`history` activity → rows reset); own prompt keyed, run once | rows converge to the daemon's; a gap the ring cannot fill → resync |
| F9 | **App backgrounded mid-turn** | link suspended (gate); the turn runs on daemon-side (decision 4) | on foreground same as F8; a turn that ended meanwhile appears complete via replay/resync |
| F10 | **Foreign turn** (laptop/other phone) | `turn` activity → same fold as own; Stop cancels THAT turn id (decision 5) | — |
| F11 | Attached mid-turn | `open()` yields the in-flight turn as a foreign `turn` activity after history (`remote-session.ts:330-336`) | — |
| F12 | Send while link down | send disabled, text kept (outbox is task 13) | enabled on `up` |
| F13 | Send rejected before ack (turn started elsewhere, `TurnInProgress`) | text back in the field + notice | the foreign turn renders; user retries after |
| F14 | Session closed / deleted on another device / reaped | `closed` activity → banner, composer disabled; `deleted` → "deleted from another device" | back → list refresh shows the truth |
| F15 | Archived when tapped / archived while away | `archived` banner + Reopen; `TooManySessions` → message, record stays archived | explicit only |
| F16 | Attach never answers | `AttachTimeoutError` (30 s) → `timeout` + Retry; nothing created | — |
| F17 | Back then forward fast on the same session | controller awaits the pending detach before re-opening | one entry, one listener |
| F18 | App killed / screen unmounted | `drain()` + `close()`: socket closes = detach; **no `session/close`** (Hazard 3) | session stays live, then idle TTL archives it (decision 4) |
| F19 | Daemon restarts mid-turn (`serve` persisted) | the cut turn is closed honestly daemon-side; re-attach shows it as interrupted | notice row |
| F20 | Unknown display update (newer daemon) | `unsupported` notice once per kind | — |
| F21 | Huge message / tool output / diff | bounded parse and lines, "show more" / truncation marker | — |
| F22 | Daemon-supplied text with markup / links | rendered as data; link tap confirms the full URL first | — |
| F23 | Fast stream | batched per ~50 ms window | final state = unbatched fold (tested) |
| F24 | Old daemon (no attach / detach) | `MethodNotFound` → `too old` banner, nothing retried | — |

### §7 invariants this task leans on

- **One session path:** only `RemoteClient` / `RemoteSession` methods; no
  frame built by the app, no new transport (the gate wraps the factory, it
  does not replace the channel).
- **Single broker:** one `PermissionBroker` per `RemoteClient`, the same
  instance the sheet's requester is set on; never `allowAll`, never an
  auto-answer (Repro 2 is the regression test).
- **Persistence:** the phone stores nothing in this task (no cache, no outbox):
  `serve` is the truth (`connect` precedent).
- **Protocol:** untouched (P11).

### Tests (red first; each names its mutation)

**In the gate (`bun run check`):**

12a —
- `session-link.test.ts` (in-process `SessionHost` + `Connection`, two
  clients; the `foreign-turns.test.ts` / `connection.test.ts` pattern):
  - T1 laptop's turn asks while the phone is attached with the app's broker
    and no requester: the ask stays pending; the phone sends no
    `resolve_permission` (frame spy). **Mutation:** `denyAll` → red (Repro 2).
  - T2 the phone sets a requester that allows: the tool runs once; a second
    laptop answer gets `PermissionNotPending` silently.
  - T3 leaving the screen: `sessionList` shows the session `archived: false`,
    `attached` back to the laptop's count, turn still running.
    **Mutation:** `RemoteSession.close()` instead of `detach()` → red.
  - T4 `ComputerLink.close()` sends no `session/close` (frame spy) and the
    session stays live. **Mutation:** restore `closeSessions()` → red.
  - T5 suspend → daemon sees the detach; an ask raised meanwhile reaches the
    phone's requester exactly once after `resume`. **Mutation:** `resume`
    does not release → red (times out).
  - T6 an answer given just before `suspend` is delivered once after `resume`.
- `foreground-gate.test.ts`: dials wait while suspended, resume releases one,
  suspend twice is idempotent. `session-controller.test.ts`: per-id
  serialisation (**mutation:** drop the await → two opens overlap), error
  reasons by class/code (a message containing "archived" with another code is
  NOT `archived`).

12b —
- `transcript.test.ts`: history → rows; own vs foreign turn produce identical
  rows (**mutation:** branch on `own` in the fold → red); tool lifecycle incl.
  `denied`; diff attaches to its tool row; `history` replaces, compaction keeps
  + notice; `unsupported` once per kind; error / lost turn notices.
- `transcript-parity.test.ts`: the same fixtures through the TUI's
  `applySessionEvent` (`tui/src/state.ts`, test-only import) and the app's
  fold → same sequence of (kind, text, tool status). **Mutation:** drop a
  reasoning→assistant boundary in the app → red.
- `markdown.test.ts` (fenced code with/without lang, nested lists, links as
  data, size bound), `highlight.test.ts` (known/unknown lang), `diff-view.test.ts`
  (counts equal `countDiff` on the same patch; truncation), `stream-batch.test.ts`
  (batched final state == unbatched; injected clock).

12c —
- `composer.test.ts`: the send/stop truth table incl. foreign turn + empty
  field → Stop; link down → disabled; rejected send restores text.
- `permission-sheet.test.ts`: age guard (**mutation:** `ARM_MS = 0` → red);
  options exactly as offered; reply only when offered; abort closes without
  sending; lost words restored.
- `session-view.test.ts`: banners per state; archived → Reopen only.
- `e2e-flows.test.ts` (extended): every new flow ends with a daemon-truth
  assertion (`assertTrue` on a hook output) or a row id, never only a
  container (11a's finding 2 rule).

**Maestro (`bun run e2e:mobile --ios 26`, iOS 26.5; mandatory before merge
of 12c; 12b runs its Step 0 probe only):**
- `06-session-open` — tap Alpha → `session-view`, history rows; back →
  hook `session-state`: Alpha `attached: 0`, `archived: false` (detach, not close).
- `07-prompt` — type, send → `turn-running` → `turn-idle`; hook `history`
  returns the typed text as the last user message and the mock's reply.
- `08-permission` — send `EDIT a.txt` → `perm-sheet` → `perm-allow…` →
  `tool-<id>-ok`, `diff-<id>`; hook `file-exists a.txt` true. Variant
  deny → `tool-<id>-denied`, file absent. Variant reply → hook shows the
  reply reached the model.
- `09-foreign-turn` — hook `laptop-prompt HOLD` on the open session →
  `turn-running` streaming rows; tap `composer-stop` → hook: turn ended
  cancelled. Then hook `laptop-prompt EDIT b.txt` → phone `perm-sheet` →
  hook `laptop-answer allow` → sheet closes by itself (first answer wins).
- `10-background-ask` — open session, hook `laptop-prompt EDIT c.txt`
  detached from the laptop's side (no laptop requester), `pressKey: home` →
  hook `session-state`: phone not attached, ask pending → `launchApp`
  (no clearState) → `perm-sheet` → allow → hook `file-exists c.txt`.
- `11-disconnect-mid-turn` — HOLD turn running; hook `stop-serve` →
  `banner-reconnecting`; `start-serve` → banner gone, interrupted notice row,
  composer enabled; hook `history` agrees.

Red-before-green: flows 06–08 run against 11a's placeholder fail (no
`session-view`); the 12a tests T1/T3/T4 are red on 11a's `connection.ts`.

### Owner questions

1. **Scope:** task 12 = open/attach + transcript + prompt while idle + Stop +
   approvals (incl. "No, let's talk about it"); steer, Send now, queued and
   returned rows, offline outbox stay in task 13? **Rec: yes** — a transcript
   you cannot answer an ask from is not usable, and Stop is one call.
2. **Split** 12a (link, load-bearing) → 12b (transcript model) → 12c (screen +
   Maestro), each its own branch; 12b may run beside 12a under the 2-task rule?
   **Rec: yes.**
3. **Background:** the app drops its link as soon as it leaves the
   foreground and redials on return (app-only factory gate), instead of
   keeping the socket until iOS or the 60 s ping kills it? **Rec: yes** —
   deterministic re-attach, no ghost attachment, no dead socket on return.
4. **Archived session tapped:** show it with a **Reopen** button (only that
   reopens it), rather than reopening on tap? **Rec: yes** — browsing the list
   must not revive sessions or count against `--max-sessions`.
5. **Transcript fold:** the app owns its pure fold, pinned to the TUI's
   `state.ts` by a test-only parity test on shared fixtures, rather than
   extracting a shared package now? **Rec: yes** — `state.ts` is being
   reworked by `app-decomposition` and pulls `@tentacle/agent` at runtime;
   extract later when both settle.
6. **Libraries:** `marked` 12.0.2 lexer (the TUI's pin) + `highlight.js` core
   with a fixed language set, both pinned exactly, Hermes-checked in 12b
   Step 0; no WebView? **Rec: yes.**
7. **Links in the transcript:** tap → confirmation showing the full URL →
   Safari; never auto-opened? **Rec: yes** (text from the model is data).
8. **Diffs in history:** live only (as the TUI; history carries no diff), with
   diffs for past edits a separate later task (record + protocol change)?
   **Rec: yes, accept as debt.**

### Notes / debt

- Diffs of past edits (P7) — a later task.
- No offline cache of transcripts (decision 7's "readable from the phone's
  cache") — task 13/16 territory; this task stores nothing.
- iOS 18 Maestro leg unverified (P9), as in 11a.
- The `dev` computer source and the strip-origin proxy remain until task 9
  (11b); nothing here depends on them beyond the harness.

## Execution

#### 12b — the transcript model (M · contained)

*— claude-opus-5-5, 2026-11-13*

**Load-bearing check (re-run first).** 12b's own load-bearing items are the
plan's Step 0 (the two libraries must run under Hermes in a Release build on the
26.5 simulator) and P8 (`tui/src/state.ts` is pure enough to `import` test-only
from `apps/mobile/test/`). Both PASSED, and both changed a decision:

1. **P8 — the test-only TUI import works.** `bun test` resolves a relative
   `../../../packages/tui/src/state.ts` from `apps/mobile/test/` (a bare
   `@tentacle/tui` specifier does NOT: `apps/mobile` does not depend on it). So
   the parity test imports the TUI's fold by path, and the app's SOURCE never
   references `@tentacle/tui` or `@tentacle/agent` (grep-guarded below).

2. **Step 0 — PASSED on the iPhone 17 Pro simulator, iOS 26.5, Release.**
   `marked@12.0.2` + `highlight.js@11.12.0/lib/core` bundled into a Release
   build; a temporary probe screen set one testID per question and Maestro
   asserted them (testID-only, per P9):

   ```
   $ maestro --device 0FA4B51F… test probe.yaml
   Launch app "so.tentacle.app" with clear state... COMPLETED
   Assert that id: probe-marked-ok is visible... COMPLETED
   Assert that id: probe-hljs-ok is visible... COMPLETED
   Assert that id: probe-regex-ok is visible... COMPLETED
   Assert that id: probe-bound-ok is visible... COMPLETED
   ```

   The probe found a real API fact the plan did not state, and the design
   follows it: **`hljs.highlight()` THROWS on an unregistered language**
   (`Unknown language: "nosuch"`; the first probe run was RED on exactly that
   assertion). So `highlight.ts` gates on `languageOf` + `getLanguage` BEFORE
   any parse — not on a `try`/`catch` around a parse that cannot finish.

   Pins chosen: `marked` at the TUI's exact `12.0.2` (the plan's instruction);
   `highlight.js` at `11.12.0` (latest 11.x — the first line that ships
   `lib/core` with `exports` maps AND a `types/index.d.ts` covering it; the
   in-tree `10.7.3` that `cli-highlight` drags in is not a direct dependency and
   its `lib/core` has no typed surface). Both are `apps/mobile` entries; the
   lockfile also gained a `cli-highlight/highlight.js@10.7.3` entry, because the
   TUI's transitive pin is now nested rather than hoisted.

   The probe file (`apps/mobile/probe-step0.tsx`) and the `index.ts` switch that
   loaded it are **deleted / reverted**: no probe code is committed.

**As built, in the plan's order.**

- `apps/mobile/package.json` + `bun.lock` — `marked@12.0.2`,
  `highlight.js@11.12.0` (dependencies; Step 0 above).
- `apps/mobile/src/transcript-rows.ts` (new) — the row types and the two pure
  helpers, split out so the history mapper and the fold share ONE definition
  without an import cycle.
- `apps/mobile/src/transcript-history.ts` (new) — the daemon's `ChatMessage[]`
  → rows (the TUI's `messagesToItems` rules: system prompt hidden, a tentacle
  note a notice, a context reset's separator + restart row, a tool result onto
  its call's row, a refusal-with-a-reply `denied`).
  **It duplicates the context-reset header string** — the plan's P8 constraint
  (no `@tentacle/agent` in the app bundle) makes importing `restartPromptOf`
  impossible, so the copy is pinned to the real function by a parity-test case.
- `apps/mobile/src/transcript.ts` (new) — `State` + `apply`: `history` (replace /
  append on a `context_reset` / keep + notice on a compaction), the turn bracket
  (`turn_started`/`turn_ended` with `ended|cancelled|interrupted|lost|failed`),
  `closed`, `link`, and every `SessionEvent` the client yields. Notices reuse
  `@tentacle/core`'s own wording (`describeTruncation`/`describeEmptyTurn`/
  `describeRepairs`), so the phone and the TUI say the same thing.
- `apps/mobile/src/markdown.ts` (new) — `marked`'s **lexer** → an own token tree
  (no HTML at all); a link token carries its `href` as DATA; raw HTML is a
  `literal`; over `PARSE_MAX_CHARS` (20 000) nothing is parsed (a "chunked"
  result with the count held back); `createParseCache` keyed by row key +
  version.
- `apps/mobile/src/highlight.ts` (new) — `highlight.js/lib/core` + a fixed
  14-grammar set, → `{text, scope}` spans; unknown/absent/over-long → one plain
  span, gated by `getLanguage` (Step 0).
- `apps/mobile/src/diff-view.ts` (new) — a unified patch → hunks with both line
  numbers and `add|del|ctx`; `countDiff` is the client's rule, rule for rule,
  and the test proves it against the real `mapping.ts` on one patch; bounded at
  400 lines / 200 000 chars.
- `apps/mobile/src/stream-batch.ts` (new) — coalesces prose deltas into one
  commit per ~50 ms window on an INJECTED clock; anything non-prose flushes
  first; a reasoning→answer switch is a boundary, never a merge.
- `apps/mobile/src/thumbnails.ts` (new) — the owner's added requirement's
  DECISION half: only the rows a `FlatList` shows (plus `PREFETCH_ROWS` either
  side) want bytes, one request per id, `MAX_IN_FLIGHT` 4, LRU cache 60, a
  failure never retried. The transport is an injected `ThumbnailSource` port —
  see Drift 1.
- Tests (new, each named by the plan): `transcript.test.ts` (24),
  `transcript-parity.test.ts` (4), `markdown.test.ts` (17), `highlight.test.ts`
  (12), `diff-view.test.ts` (9), `stream-batch.test.ts` (10),
  `thumbnails.test.ts` (15) — **91 cases, and 2 fixture files** under
  `apps/mobile/test/fixtures/transcript/`.
- `changelog.d/mobile-session-view-12b.added.md` — one bullet (the plan said
  12a/12b add none, but the briefing requires a fragment and the transcript model
  is user-visible work even before its screen renders; the fragment says so).

**Drift from the Implementation (and why).**

1. **Thumbnails: the requirement's transport does not exist.** The owner's
   requirement says thumbnails are "fetched over the existing channel". They
   cannot be: the protocol's only attachment method is `attachment/put`
   (client → daemon), and `docs/feat/attachments-upload.md:174-177` states there
   is deliberately "No `attachment/get` / `status` method … nothing reads bytes
   back over the wire". A daemon also never emits an `image` content block
   (`packages/protocol/src/content.ts:30-36` is prompt-only), so the bytes of a
   `media_message` ref are not obtainable by ANY current client, web or phone.
   So 12b ships what is decidable and honest:
   - the refs ride the row (`UserRow.images`, `transcript.test.ts` proves it),
     labelled `[image: name]` — the TUI's own `imageRowText`, pinned by a test;
   - the visible-rows-only / no-duplicate / bounded-concurrency policy is
     implemented and fully tested (`thumbnails.ts`), behind an injected
     `ThumbnailSource` port.
   **The one step this contradicts was not forced**: I did not invent a
   read-back frame (that would break AGENTS §7 "one session path" and the
   protocol rule), and I did not fetch bytes some other way. Adding
   `attachment/get` is an ADDITIVE new method (no `PROTOCOL_VERSION` bump, §7
   "Fields and methods are free") — a small follow-up task, and 12c then draws
   the thumbnails by wiring the port. This needs an owner decision; recorded
   rather than silently dropped.
2. **`TurnRow` is not a row.** The plan lists `turn (running indicator)` among
   the rows. It is `State.turn` instead: a virtualised list that gains and loses
   an item at the end shifts every key's position twice per turn, and the
   indicator is one element under the list. Same information, no key churn.
3. **`version` is the text's length, not a counter.** The plan asks for "a
   monotonically growing `version`" for the markdown cache; a counter makes the
   batched and unbatched folds produce DIFFERENT rows (`version: 2` vs `1` for
   the same text), which breaks the plan's own F23 equality test. Text length is
   monotonic (deltas only append) and identical either way.
4. **`ToolStatus` has `denied` as well as the plan's four.** The plan's row list
   says `queued|running|ok|error|denied` and then names four; both are honoured —
   `denied` is the refusal-with-a-reply state (`ToolResult.denialReply`), which
   the TUI also distinguishes.
5. **Reasoning is a row here, a spinner flag in the TUI.** So row-for-row parity
   is impossible on that one kind; the parity test normalises it explicitly
   (reasoning rows are skipped, and two assistant rows split AT a reasoning row
   are joined) and still fails on any other divergence — proved by mutation M2.

**Mutations (each run, red, then reverted).**

| # | Target (the plan's own mutation) | Result |
|---|---|---|
| M1 | fold branches on `own` (`text` dropped for a foreign turn) | **RED** — `transcript.test.ts`: "an OWN and a FOREIGN turn produce identical rows" |
| M2 | drop the reasoning→assistant boundary in the app's fold | **RED** — `transcript-parity.test.ts` (both fixtures) + `transcript.test.ts` "a reasoning chunk ends it" (2 fail) |
| M3 | `PARSE_MAX_CHARS` = `Number.MAX_SAFE_INTEGER` (no size bound) | **RED** — `markdown.test.ts` size-bound block (3 fail) |
| M4 | no `getLanguage` gate (parse-and-catch, unknown alias treated as registered) | **RED** — `highlight.test.ts` "a language whose name collides with no grammar" |
| M5 | `countDiff` counts `+++`/`---` file headers as changes | **RED** — `diff-view.test.ts` counts block (2 fail, incl. the real `mapping.ts` case) |
| M6a | no coalescing (every delta its own commit) | **RED** — `stream-batch.test.ts` window block (2 fail) |
| M6b | merge across a reasoning→answer boundary | **RED** — `stream-batch.test.ts` equality + boundary (3 fail) |
| M7 | fetch every image in the whole history (not only visible rows) | **RED** — `thumbnails.test.ts` visible-window block (2 fail) |
| M8 | `drive` applies each outcome to the pre-`plan` state (a real bug the test caught) | **RED** — `thumbnails.test.ts` drive block (3 fail) |

M8 is worth naming: it was not a hypothetical mutation — the first
`thumbnails.test.ts` run found that two thumbnails landing in the same tick
overwrote each other, because `drive` closed over the state `plan` returned.
Fixed by settling each outcome onto the LATEST state, and the test that caught it
is kept ("two answers landing together both land").

**Gate.**

```
$ bunx tsc --noEmit                    # clean
$ bunx tsc -p apps/mobile              # clean
$ bun run lint                         # Checked 1030 files. No fixes applied.   (0 errors, 0 warnings — the §6 baseline)
$ bun test                             # 8013 pass · 3 skip · 0 fail · 13 snapshots (573 files)
$ bun test apps/mobile/test             # 187 pass, 0 fail (the 11a/12b files together;
                                        #   the 12b files alone: 91)
```

No schema changed, so `packages/protocol/schema/protocol.json` was NOT
regenerated (nothing in `packages/**` is touched — plan P11, re-verified: the
diff is `apps/mobile/**`, `bun.lock` and the changelog fragment only).

Gate honesty: one FULL run failed
`packages/daemon/test/serve-log-store.test.ts` "S11 — a real SIGKILL at random
points" (`loads` 0, expected > 100) — and it failed on TWO of the four full runs
I did, always under the parallel load of the whole suite. It is a
wall-clock/load-sensitive restart test, in a package this slice does not touch;
it passes alone (3/3 runs) and the full suite passed twice (8013 pass · 3 skip ·
0 fail). Not caused by, and not fixed by, 12b — but the reviewer should know it
is load-flaky rather than watertight.

**Unverified / left open.** The real thumbnail transport (Drift 1) — needs
`attachment/get` and an owner decision. 12c renders these rows on the simulator;
nothing in 12b is simulator-verified beyond Step 0's probe.
*— claude-opus-5-5 (executor of slice 12a), 2026-11-13*

**Slice 12a only.** 12b/12c untouched (no transcript model, no screen, no
`marked`/`highlight.js`, no e2e flow, no `changelog.d/mobile-session-view.added.md`
— 12c's). Nothing under `packages/**` changed: no protocol schema, no
`protocol.json` regeneration, no `protocol.d/` note (P11 held).

### Load-bearing check (re-run first, as required)

The plan's assumption is the TUI's attach path unchanged, with ONE broker.
Re-verified against this branch's code before any edit:

- `SessionStreamListener` is "a session's consumer (`RemoteSession`, a mobile
  view)" — `packages/client/src/remote-client.ts:211-214`; `newSession(…,
  {attach})` → `RemoteSession` (`:954-969`); the eager `open()` is
  `attachSession` = `session/open{sessionId, reopen?}`, never a create,
  bounded by `ATTACH_TIMEOUT_MS` (`:983-1037`, `packages/client/src/constants.ts:12`).
- `PermissionBroker` with `holdUntilSet` queues requests while no requester is
  set and hands them, in order, to the next `setRequester`
  (`packages/core/src/permission.ts:162-208`).
- `RemoteSession.detach()` is `session/detach` (`packages/client/src/remote-session.ts:798`);
  `RemoteSession.close()` is `session/close` (`:752-764`); `RemoteClient.drain()`
  (`remote-client.ts:1444`) and `closeSessions()` (`:1478`) are as the plan says.

Then re-ran the plan's own probe (`.tentacle/tmp/mobile-session-view-12a/`,
this branch's copy of `deny-hazard.ts`) and added the two properties 12a needs
that it does not cover:

```
$ bun deny-hazard.ts denyAll
mode=denyAll turn=ended laptopAsked=1
   {"type":"tool_result",… "Permission denied by the user: `ask` was not run." …}
$ bun deny-hazard.ts hold
mode=hold turn=still waiting (ask pending) laptopAsked=1
```

```
$ bun link-probe.ts          # hold broker + detach + closeSessions
phone attached: archived=false attached=2 running=false
ask with the hold broker: turn=pending
after phone detach(): archived=false attached=1 running=true
phone re-attached: archived=false attached=2 running=true
after closeSessions() (11a exit path): archived=false attached=1 running=true
```

The last line is why the harness had to change: `closeSessions` there was a
no-op because the LAPTOP was still attached. The hazard is the phone as the
LAST client, which `last-client.ts` isolates:

```
$ bun last-client.ts detach  # decision 4: detach
phone attached:                sessions=[["2238",false,2,false]]
laptop left; phone is last:    sessions=[["2238",false,1,false]]
after the phone's detach():    sessions=[["2238",false,0,false]]   ← kept, live
$ bun last-client.ts close   # 11a's exit path
phone attached:                sessions=[["611e",false,2,false]]
laptop left; phone is last:    sessions=[["611e",false,1,false]]
after closeSessions()+close(): sessions=[]                          ← GONE (Hazard 3)
```

So the load-bearing assumption HOLDS (the attach path needs no new code), and
both hazards are real. Check passed → implementation proceeded.

### As-built, in dependency order

1. **`apps/mobile/src/foreground-gate.ts` (new, pure).** `createForegroundGate(inner)`
   → `{dial, suspend, resume, isSuspended}`. `suspend()` arms the hold *before*
   closing the live channel (so a dial in flight waits instead of slipping
   through), `resume()` releases every dial waiting on that one hold, both are
   idempotent; a channel that arrives while suspended is closed and the dial
   waits again. It wraps the factory; it is not a second transport.
2. **`apps/mobile/src/session-controller.ts` (new, pure, injected).**
   `createSessionController<S extends SessionHandle>({newSession})` →
   `{open, leave, dispose, follows}`. `open` never creates (`{attach}`/
   `{reopen}`, supplied by the app's seam) and never throws: it answers
   `{ok:true, session}` or `{ok:false, reason}` with
   `openFailureReason` = `timeout` (`AttachTimeoutError`), `archived`/
   `deleted`/`gone`/`too-many` (`DomainErrorCode.SessionArchived/SessionDeleted/
   UnknownSession/TooManySessions`), else `link` — by class then code, never
   message text. `leave` is `detach()`, never `close()`. Both are serialised per
   session id (one tail promise per id), so a back-then-forward cannot overlap
   the client's id-keyed session table; a repeated `open` of an id already
   followed reuses the handle; `dispose()` unsubscribes and detaches an attach
   that lands afterwards.
3. **`apps/mobile/src/connection.ts`.** `createLinkBroker()` — `new
   PermissionBroker(undefined, {holdUntilSet: true})`, exported so the app's
   *actual* broker is what the tests drive; `leaveComputer(client)` —
   `drain()` + `close()`, the one exit path, exported for the same reason;
   `openComputer` now dials through the gate (`createForegroundGate(…)`, first
   dial included), passes `gate.dial` as the client's `channelFactory`, and its
   `ComputerLink` exposes `permissions`, `suspend()`, `resume()`, and a
   `close()` = `leaveComputer`. The failure path is `drain()` + `close()` too.
4. **`apps/mobile/App.tsx` (wiring only).** A `LIVE_LINKS` set; the registry's
   `open` suspends a link dialled while `AppState.currentState !== "active"` and
   registers it; one `AppState` `change` effect suspends on leaving `active` and
   resumes on `active`; `close` → `link.close()` (the link's own exit path).
   The `Session` route stays 11a's placeholder (12c).
5. **Tests** (`apps/mobile/test/`): `foreground-gate.test.ts` (new, 4),
   `session-controller.test.ts` (new, 9), `session-link.test.ts` (new, 7 =
   plan T1–T6 + the archived→reopen reason), `connection.test.ts` (broker test
   inverted to hold-and-deliver, plus the leave-as-last-client test over a real
   WebSocket). All 20 new tests, plus the 2 rewritten, were RED first: T1/T3/T4
   ran red against 11a's `connection.ts` (denyAll answers at once, `close()`
   sends `session/close`), and the pure modules' tests were red before their
   implementations existed.
6. **`changelog.d/mobile-session-view-12a.changed.md`** — one bullet (validated
   with `scripts/changelog.ts`'s own parser). No `TODO.md` edit, no
   `CHANGELOG.md` edit.

### Mutations (each applied, run, reverted — pasted results)

| Mutation | Red test(s) |
|---|---|
| `createLinkBroker` → `new PermissionBroker(denyAll)` | T1 (and `connection.test.ts`'s hold test) |
| `leaveComputer` → `closeSessions()` + `close()` | T4 **and** `connection.test.ts` "link.close() leaves without a session/close" |
| controller `leave` → `session.close()` | T3 + "leave calls detach, NEVER close" (and the serialisation test, which needs a real detach) |
| `resume()` does not `releaseHold()` | T5, T6 + 3 of the 4 gate tests |
| drop the per-id serialisation in the controller | "an open … AWAITS it" |

Verbatim, e.g. the exit path:

```
=== MUTATION 2: closeSessions() in link.close ===
(fail) openComputer over a real daemon > link.close() leaves without a session/close: … [107.47ms]
 11 pass  1 fail
=== MUTATION 4: resume() does not release ===
(fail) createForegroundGate > a dial while suspended WAITS … [2.88ms]
(fail) createForegroundGate > a channel that arrives while suspending is CLOSED … [3.92ms]
(fail) createForegroundGate > every dial waiting on one hold is released … [2.68ms]
(fail) the phone's session link over a real daemon > T5 suspend → the daemon sees the detach … [3156.21ms]
(fail) the phone's session link over a real daemon > T6 an answer given just before suspend … [5001.73ms]
 6 pass  5 fail
```

### Drift from the Implementation (and why)

- **Two exported seams instead of inline construction** — `createLinkBroker()`
  and `leaveComputer()`. Not cosmetic: with the broker built inline, mutation 1
  left T1 GREEN (the test held a look-alike), and with the exit path inline,
  mutation 2 only reddened the real-socket test. A mutation that does not
  redden the test named for it is a vacuous test (§9), so the app's decision now
  has exactly one implementation and the tests drive it.
- **`openComputer`'s first dial goes through the gate** (the plan says "the
  factory wrapped by the gate"). Same thing, taken literally: the initial
  channel is `gate.dial()` too, so `suspend()` also closes the *first* socket
  (otherwise a backgrounding between `openComputer` and the client's next dial
  left the original socket live).
- **`App.tsx` also suspends a link dialled while already backgrounded** — an
  addition the plan does not name (F2/F3's cousin): a dial that completes while
  iOS is not active would open the ghost attachment the gate exists to remove.
- **The test harness closes the in-memory server `Connection`** when its channel
  closes, mirroring `ws-server.ts:223-234`. Without it no test could observe a
  detach: `createChannelPair` has no server side, so a closed client stayed
  "attached". This is a harness fact, not a product one.
- No other drift. Files changed are exactly the plan's 12a table.

### Notes / unverified

- **iOS/Maestro not run**: 12a adds no UI, and the plan's flows are 12c's. The
  `AppState` wiring is exercised by the pure gate tests and by
  `bunx tsc -p apps/mobile`; its on-device behaviour (foreground → detach →
  re-attach) is unverified here and is flow `10-background-ask`'s job in 12c.
- The owner's image-attachments requirement is 12b (model) + 12c (screen); it
  has no 12a footprint and was not touched.

### Gate

```
$ bunx tsc --noEmit          → clean
$ bunx tsc -p apps/mobile    → clean
$ bun run lint               → 1018 files checked, no fixes applied, 0 errors/warnings
$ bun test                   → 7943 pass, 3 skip (the opt-in ones), 0 fail, 569 files, 341.84s
```

### Fix round 1

*— claude-opus-5-5, 2026-11-13* (fix round 1 executor; same model as round 0
and the Review — fresh context only, so shared blind spots remain possible)

**Reproduction first (both findings, on the round-0 code, in
`.tentacle/tmp/mobile-session-view-12a/fix1-repro.ts`):**

```
F1: dialled=["ch0","ch1","ch2","ch3","ch4"] closed-on-suspend=["ch0"]
F2: follows=true detaches=0
```

F1 = finding 1: three callers (one stale attempt + two redials) released
together made five inner dials, and `suspend()` closed `ch0` — not the socket a
caller holds. F2 = finding 2: `leave` during an attach left the session
followed (`follows=true`) with no detach.

**Finding 1 (HIGH) — `apps/mobile/src/foreground-gate.ts`.** Root cause: the
gate identified nothing, so every dial parked on the one hold was released
together, each called `inner()`, and `current` was whichever connected *last*;
the client's abandoned attempts (`dialChannel`'s `LIVENESS_MS` give-up,
`remote-client.ts:2351-2380`) were indistinguishable from the awaited one. Fix:
a generation counter (`generation`) claimed by each `dial()`; a dial whose
generation is no longer newest fails with `ChannelError("unreachable", …)`
*before* dialling, and a channel that arrives for it is closed and rejected —
so an abandoned attempt never opens a socket and never becomes `current`, and
`current` is only ever what the newest caller received (`foreground-gate.ts:36-43`
for the reason, `:73,86-110` for the guard). Rejecting (not silently returning)
is what makes the gate a faithful `channelFactory`: the client treats it as a
failed dial and backs off, which is exactly a give-up. Double `close()` of an
abandoned channel is safe — `DuplexChannel.close` is idempotent
(`packages/transport/src/channel.ts:12`).

```
$ bun test apps/mobile/test/foreground-gate.test.ts
  red (before the fix): 2 fail — Expected 1 / Received 2 (N dials on one
  resume), Expected "ChannelError" / Received "resolved" (stale becomes current)
  green (after):        5 pass, 0 fail
$ bun run fix1-repro.ts  (after)
F1a (2 redials, abandoned socket last): dialled=["ch0","ch1"]
    results=["rejected:ChannelError","ch1"] closed-on-suspend=["ch0","ch1"]
F1b (2 redials, live socket last):     dialled=["ch0","ch1"]
    results=["rejected:ChannelError","ch1"] closed-on-suspend=["ch0","ch1"]
```

Two dials for three callers (the abandoned one never dials), and the channel
closed on the second `suspend()` is the live one in both orderings.

**Finding 2 (MEDIUM) — `apps/mobile/src/session-controller.ts`.** Root cause:
`leave()` read `live` synchronously, before `serialise`, so an attach still in
flight was not in `live` yet: the queued leave found no entry, detached
nothing, and the open then registered the session + listener. Fix: a
`left: Set<string>` marks an id when `leave` finds no handle, and the open's
serialised run detaches instead of registering when the mark is set
(`session-controller.ts:100-120,155-172`); the mark is cleared by the leave's own
serialised run, which the per-id tail orders *after* that open, so it is
per-leave and cannot poison the next open. The open answers
`{ok:false, reason:"link"}`, the same answer the existing `dispose()`
mid-attach path gives (the screen is gone either way).

```
$ bun test apps/mobile/test/session-controller.test.ts
  red (before the fix): 1 fail — Expected {ok:false, reason:"link"} / Received ok:true
  green (after):        11 pass, 0 fail
$ bun run fix1-repro.ts  (after)
F2: open="link" follows=false detaches=1
```

**Mutations (each applied, run, restored; `git status` shows only the 4 intended
files after each):**

1. Gate — both `if (abandoned())` guards deleted →
   `2 fail`: `Expected: 1 / Received: 2` and `Expected: "ChannelError" /
   Received: "resolved"`.
2. Controller — `if (disposed || left.has(sessionId))` → `if (disposed)` →
   `1 fail`: `Expected {ok:false,reason:"link"} / Received ok:true`.
3. Controller — `left.delete(sessionId)` dropped (the mark is never cleared) →
   the new poisoning test `1 fail`: the second open of the same id does not
   attach. This is the risk the fix itself introduces, pinned shut.

**Gate (fix round 1):**

```
$ bunx tsc --noEmit          → clean
$ bunx tsc -p apps/mobile    → clean
$ bun run lint               → 1018 files checked, no fixes applied
$ bun test apps/mobile/test  → 119 pass, 0 fail
$ bun test                   → 7946 pass, 3 skip (the opt-in ones), 0 fail, 569 files, 344.55s
```

7943 → 7946: this round adds four tests (two gate, two controller) and removes
one (the old "every dial waiting on one hold is released by a single resume",
whose premise the fix makes unreachable — a second parked dial is now a
superseded one; its hold-arming half is covered by the first new gate test).
Verified in this worktree.

**Not re-touched, deliberately:** the Review's scope note (the plan header says
12a adds no changelog fragment while Execution added
`changelog.d/mobile-session-view-12a.changed.md`) is a docs bookkeeping point,
not a code finding; left for the 12c/orchestrator pass rather than editing the
plan's header here. **Unverified:** the gate's new behaviour is pinned by pure
tests only — the on-device variant (background > 15 s, foreground, background
again) is still flow `10-background-ask`'s job in 12c, as round 0 noted.

## Review

#### Owner answers (2026-11-13)

All questions answered as recommended. Implementation APPROVED. Added owner requirement: image attachments (media_message refs) are shown in the transcript (12b model + 12c screen; thumbnails fetched over the existing channel, never auto-downloaded beyond the visible rows).

#### 12b review

**Verdict: REQUEST-CHANGES** (two MEDIUM findings, both in `thumbnails.ts`, the module for the owner's image requirement).

1. **MEDIUM: `MAX_IN_FLIGHT` and "abort off-window" don't hold** (`apps/mobile/src/thumbnails.ts:115-127`, `:189-191`). Every request gets the same shared `controller` signal, so the ids `plan` puts in `abort` can't be cancelled one by one. They are only dropped from `inFlight`, and their fetches keep running. Trace (`.tentacle/tmp/mobile-session-view-12b/drive.ts`): four window changes with nothing settled leave **16 fetches open, while `state.inFlight` says 4**. This breaks the bound, and it breaks "never downloaded beyond the visible rows". A stale fetch that lands later is also cached (`i0` ends up in `loaded` after the user has scrolled away).
2. **MEDIUM: a stale `drive` overwrites newer state** (`thumbnails.ts:183-192`). The M8 fix only covers settles *within one* `drive` call. Each call has its own `current`, so a settle from an earlier window writes `loaded(current_old, …)` over everything later calls produced. Trace: window D's thumbnail `i142` loads, then a window-A fetch settles, and `loaded` becomes `["i0"]` (`i142` is lost) and `inFlight` becomes A's `["i1","i2","i3"]`. A visible thumbnail disappears and D's ids get requested again. No test calls `drive` twice with fetches still pending, which is why mutation M8 didn't catch this.
   Fix direction for both: one AbortController per request, and settle through a state getter or reducer instead of a captured `current`. Add red tests for both cases.

**Gate (re-run by the reviewer):** the seven 12b test files ran 91 pass / 0 fail; `bun run lint` clean (1030 files); `bun run typecheck` clean. I did not re-run the full `bun test`.

**Premises checked:** Drift 1 is true: the only attachment method is `attachment/put` (`packages/protocol/src/methods.ts:112`), and `attachments-upload.md:175-176` says nothing reads bytes back. The diff touches no `packages/**` file, so no protocol, persistence or broker invariant is involved (P11 holds).

**Attacks tried:**
- (a) Own mutation `denied`→`error` in `transcript.ts:409-410`: red (1 fail in `transcript.test.ts`), reverted, tree clean.
- (b) Thumbnail driver across several windows: found 1 and 2.
- (c) `stream-batch.ts`: order kept (non-prose flushes first) and prose kinds never merged across each other. Nothing found.
- (d) Owner image requirement: the refs ride `UserRow.images`. The missing transport is reported honestly as drift, not faked.

**Executor:** disciplined and honest. The drift is documented, and the flaky full-suite test is disclosed. The gap: the M8 fix was tested inside one `drive` call only.

*— claude-opus-5-5, 2026-11-13* (fresh context). The Execution section is signed claude-opus-5-5, but commit `b6de752` says "exec (deepseek)". The executor's real identity is unclear and should be corrected.

### Fix round 1

*— claude-opus-5-5, 2026-11-13 (executor of this round; branch
`feat/mobile-session-view-12b`, no checkout/restore/stash/commit)*

> Note on the review's identity remark: the id above is this session's real
> model id (read from `~/.claude/projects/…/<session>.jsonl`, every assistant
> record `"model":"claude-opus-5-5"`). Round 1's "exec (deepseek)" commit
> subject and the Execution signature above are left exactly as the executing
> round wrote them — this round does not overwrite another model's claim.

Both findings live in `apps/mobile/src/thumbnails.ts`, the owner's image
requirement's decision module. They share one root cause: the module was shaped
around a **one-shot `drive(state, …)` call** — one captured state, one shared
signal — when a screen has **many** window changes on **one** lifetime. The fix
is that shape, not two patches: a `createThumbnailDriver` object owns the state
and the per-request controllers for the mounted screen, and `drive` (the API the
review attacked) is gone.

**Finding 1 (MEDIUM) — `MAX_IN_FLIGHT` and "abort off-window" did not hold.
FIXED.**
`thumbnails.ts:64` (`Request.controller`), `:119` (`plan`), `:244`.
`plan` used to hand every request the caller's ONE shared `AbortSignal`, so the
ids it listed in `abort` were only dropped from `inFlight`: their fetches kept
running on a signal nobody aborted. Now `plan` creates **one `AbortController`
per request**, keeps them in a `Map<id, AbortController>` across steps
(`pending`), and the driver **actually aborts** each abandoned one
(`:244`). A late arrival from an abandoned request is dropped by the identity
check at `:253` (a settle only lands if its id still maps to *its own*
controller), so it can never reach the cache. The driver installs ONE listener on
the screen's unmount signal (`:235`), which reaches every request however the
window moved in between; `plan` also aborts a request created after that signal
already fired (`:152`).
The review's trace, re-run against the fixed code
(`.tentacle/tmp/mobile-session-view-12b/fix1-drive.ts`):

```
before: MAX_IN_FLIGHT 4 | fetches open: 16 | state.inFlight: 4
        after D loaded: [ "i142" ] | after stale A settles: [ "i0" ] | inFlight [ "i1","i2","i3" ]
after:  MAX_IN_FLIGHT 4 | fetches open: 4  | state.inFlight: 4
        after D loaded: [ "i142" ] | after the stale A settle: [ "i142" ] | inFlight 3
        after unmount, fetches open: 0
```

**Finding 2 (MEDIUM) — a stale `drive` overwrote newer state. FIXED.**
`thumbnails.ts:214` (`createThumbnailDriver`). Each `drive` call had its own
closed-over `current`, so a settle from an earlier window wrote that older state
over everything later windows produced. The driver keeps ONE `state` for the
mounted screen and every settle reads the **live** value at settle time
(`loaded(state, …)` inside the callback, `state` read then, not captured), so a
later window's `loaded`/`inFlight` survives an earlier window's settle, and the
`:253` identity check drops an abandoned request's outcome entirely. `drive`
was **removed** rather than kept as a thin per-window wrapper: leaving the
one-call API exported would leave the exact trap that produced this finding
reachable by the 12c screen. `drive`'s only callers were its own tests.

**Tests (red before green, §9).** New block `the driver: one state and one
controller table per screen` in `apps/mobile/test/thumbnails.test.ts` (`:269`,
`:293`, `:303`, `:323`, `:332`), driven through the real driver against a
deferred fake `ThumbnailSource` (the review's own scenario, not a toy):
- `:269` three window changes, nothing settled → **4** unaborted fetches, **8**
  aborted, `inFlight` 4, and the live ids are the LAST window's;
- `:293` an abandoned fetch that arrives late is not cached (`loaded` stays `[]`);
- `:303` window D's `i142` loads, then window A's `i0` settles → `loaded` is
  still `["file://142"]` and `inFlight` is unchanged (the review's exact trace);
- `:323` unmount aborts every request still running; `:332` a signal that had
  already fired leaves nothing running.
The three pre-existing `drive` tests were re-pointed at `mount()`/`driver.view`
(no assertion weakened), so M8's regression case is still covered.

**RED, on the buggy code.** Two forms, because this fix replaces the API the
review attacked:

1. *Against the pre-fix module* (`git show HEAD:apps/mobile/src/thumbnails.ts`),
   through its own per-window `drive(state, …)` API re-called across windows —
   exactly what the module invited and what the review's trace did
   (`.tentacle/tmp/mobile-session-view-12b/fix1-red.log`): the three cases failed
   **on their assertions**, not on a compile error:

```
(fail) drive > a window change ABANDONS the fetches it scrolled away from (one controller each)
(fail) drive > an abandoned fetch that arrives late is NOT cached
       - []  + [ { id: "…0", uri: "file://stale" } ]
(fail) drive > a settle from an EARLIER window never rolls back a later one
       - "file://142"  + "file://0"
 15 pass · 3 fail
```

2. *Against the fixed module*, the final driver-shaped cases cannot compile on
   the pre-fix source (`drive` is gone, `Request` carries a controller), so their
   red proof is the mutation form below: reintroducing each bug in the NEW driver
   (N1, N2) turns exactly those cases red. That is the §9 non-vacuity check for a
   redesign — the same property, proven twice: once on the code that had it
   broken, once by breaking it again.

**Mutations (each applied to `thumbnails.ts` alone, run on the file, reverted —
`git diff` re-checked after every revert).**

| # | Mutation | Result |
|---|---|---|
| N1 | abandoned ids are dropped, not aborted (`pending.get(id)?.abort()` → `void id`) | **RED** — "a window change ABANDONS…" (4 vs 12 live) |
| N2 | no identity guard on settle (`pending.get(id) !== request.controller` → `false`) | **RED** — "an abandoned fetch that arrives late is NOT cached" + "a settle from an EARLIER window never rolls back" |
| N3 | the unmount listener is never installed (`void close`) | **RED** — "unmount aborts every request still in flight" |
| N4 | `plan` ignores an already-aborted signal (drop the `signal.aborted` branch) | **RED** — "a signal that already fired leaves nothing running" |

N1/N2 are the two findings one-for-one; N3/N4 pin the unmount reach the design
claim rests on (non-vacuity: each mutation fails ONLY its own case, so no case is
riding on another's fix).

**Drift from the Implementation (and why).** None beyond finding 2's fix shape:
`drive` is deleted and `plan` gained a `pending` parameter (`thumbnails.ts:119`)
carrying the live controller table. Both are within the plan's "pure decision
module behind an injected port" — no `packages/**` file, no protocol, no wire
change (P11 still holds: `git diff --name-only` is `apps/mobile/src/thumbnails.ts`
and `apps/mobile/test/thumbnails.test.ts` only).

**Gate (re-run by me, after the fix).**

```
$ bunx tsc --noEmit                    # clean
$ bunx tsc --noEmit -p apps/mobile     # clean
$ bun run lint                         # Checked 1030 files. No fixes applied. (0 errors, 0 warnings — §6 baseline)
$ bun test apps/mobile/test            # 192 pass · 0 fail (19 files; the 12b files alone: 96)
$ bun test                             # 8018 pass · 3 skip · 0 fail · 13 snapshots (573 files, 346s)
```

The three skips are the §6 opt-ins. The full run was green on this round's first
attempt (`packages/daemon/test/serve-log-store.test.ts` S11, load-flaky on the
previous round, passed here) — but it remains load-sensitive, as round 1 wrote.

**Unverified / left open.** Unchanged from Execution: the thumbnail TRANSPORT
still does not exist (Drift 1 — no `attachment/get` in the protocol), so the
driver's port is exercised by a fake only. Nothing here is simulator-verified;
12c wires `createThumbnailDriver` into the screen.

### Round 2

**Verdict: APPROVE.** Commit `7e0a7a1` fixes both round-1 findings.

- **Finding 1 (in-flight limit and abort): fixed.** Each request now gets its own `AbortController` (`thumbnails.ts` `plan`), and `view()` aborts the ids that scrolled out. I re-ran my round-1 trace against the new driver (`.tentacle/tmp/mobile-session-view-12b/drive2.ts`, with a fake source that honours the abort signal). After 4 window changes, **4 fetches are open** (was 16), and `inFlight` holds only the current window's ids.
  - Mutation M-A (remove the per-id `abort()`): RED, "a window change ABANDONS the fetches…".
- **Finding 2 (stale settle overwrites newer state): fixed.** There is now one driver per screen, which holds one state, and a settle counts only if its controller is still the current one for that id. Trace: `i142` stays loaded after the stale `i0` settles. `i0` is neither cached nor marked failed, so scrolling back requests it again.
  - Mutation M-B (remove the guard): RED, 2 tests fail.
  - Mutation M-D (settle onto the initial state instead of the latest): RED, 2 tests fail.
- **Mutation hygiene:** each mutation was restored from a byte copy, and `git status` was clean afterwards.
- **Checks:** `bun test apps/mobile/test` 192 pass / 0 fail. `bun run lint` clean (1030 files). `bun run typecheck` clean. No callers of the removed `drive` are left. The diff touches only `thumbnails.ts`, its test and this doc.
- **Nit (not blocking):** an `initial` state passed in with `inFlight` ids but no controllers would hold those slots forever. Today `initial` defaults to empty, so nothing triggers it. 12c should not seed `initial` with in-flight ids.

*— claude-opus-5-5, 2026-11-13* (fresh context. The fix was executed by deepseek, per the commit message.)
### Review — slice 12a (fresh context)

*— claude-opus-5-5, 2026-11-13* (same model as the 12a executor: fresh context only, shared blind spots possible)

**Verdict: REQUEST-CHANGES.**

1. **HIGH — `apps/mobile/src/foreground-gate.ts:71-73`: the gate can lose track of the live socket, so `suspend()` closes a dead one and the real one stays up.** While suspended the client keeps redialling; each `dialChannel` gives up after `LIVENESS_MS` (15 s, `remote-client.ts:2351-2380`) but the gate's held `dial()` stays pending. All held dials share one hold, so `resume()` releases N concurrent `inner()` dials; the abandoned ones' channels are closed by `dialChannel` (`late`), but `current` is whichever one connects LAST. Repro (`.tentacle/tmp/mobile-session-view-12a/review-repro.ts`): two held dials, the stale one connects after the live one → `A: client holds ch1; closed on suspend=["ch0"] (live closed? false)`. Scenario: background > ~15 s, foreground, background again → the live socket is never closed: the ghost attachment the gate exists to avoid, and on return a socket nobody told the client was dead (F2/F3/F9 do not converge). Also an N-socket burst on every resume. Fix direction: a held dial that its caller abandoned must not dial at all (e.g. one pending dial at a time / generation counter), and `current` only ever the channel the latest caller received; add a test for that ordering.
2. **MEDIUM — `apps/mobile/src/session-controller.ts:155-168`: `leave()` during an in-flight `open()` is a no-op.** `leave` reads `live` synchronously before serialising; an attach still running (up to 30 s) is not in `live` yet, so the queued leave detaches nothing and the open then registers the session + listener. Repro: `B: after leave-during-open: follows=true detaches=0`. Scenario (F17 in reverse, the common one): tap a session, back before the attach answers → the phone stays attached with a listener into an unmounted screen; asks are re-offered to the phone's held broker. Fix: look up `live` inside the serialised run (or mark the id "left" so the pending open detaches). Test it.

**Gate (touched files):** `bun test` of the 4 touched test files: 25 pass, 0 fail. `bun run lint`: 1018 files, clean. `bun run typecheck`: clean. Full suite not re-run here (Execution reports 7943 pass / 3 opt-in skip).

**Mutations (applied, run, reverted; `git status` clean after):** `leaveComputer` → `closeSessions()`: connection.test + T4 red. Broker → a deny requester: connection.test + T1 red. Both tests are non-vacuous.

**Attacks tried:** (a) single broker — one `createLinkBroker()` per `RemoteClient`, exposed as `permissions`, no second instance in the diff: holds. (b) leaving never closes — no `closeSessions`/`session/close` left in `apps/mobile` (also the `openComputer` failure path now `drain()`s): holds. (c) gate vs client give-up — `dialFailed` never stops on a timeout (`link-machine.ts:129-146`), so a long suspend does not kill the link: holds; but see finding 1. (d) controller per-id serialisation open-after-leave: holds; leave-during-open: finding 2. (e) error reasons by class/code, not message: holds.

**Scope notes:** the image-attachments owner requirement has no 12a footprint (12b/12c), correctly untouched. The plan said 12a adds no changelog fragment; Execution added `changelog.d/mobile-session-view-12a.changed.md` — harmless, but the plan's header should be updated to match or the fragment folded into 12c's.

### Round 2

*— claude-opus-5-5, 2026-11-13* (fresh-context reviewer; same model family as round 1)

**Verdict: PASS** (round-1 findings 1 and 2 fixed; no new HIGH/MEDIUM).

- **Finding 1 (gate, HIGH) — fixed.** A generation counter supersedes every parked dial (`foreground-gate.ts` `dial`): an abandoned caller never dials and a late channel is closed and never becomes `current`. Round-1 repro now: `A: client holds ch0; closed on suspend=["ch0"] (live closed? true)`. Regression check: the superseded rejection is `ChannelError("unreachable")`, which `terminalReason` (`link-machine.ts:85-97`) does not treat as terminal, and `dialChannel` ignores a rejection that arrives after its deadline (`late`), so the client's link is never stopped by it.
- **Finding 2 (controller, MEDIUM) — fixed.** A `left` mark makes the still-attaching open detach instead of registering; the leave's serialised run clears it, so the next open of that id is not affected. Repro now: `follows=false detaches=1`.
- **Mutations (applied, run, reverted; `git status` clean):** supersession check disabled → both new gate tests red; `left.has` dropped from the open's post-attach check → both new controller tests red.
- **Gate:** `bun test apps/mobile/test` 120 pass / 0 fail; `bun run lint` clean (1018 files); `bun run typecheck` clean.
- **Nit (not blocking):** the detach of an abandoned open is fire-and-forget inside the serialised run (`session-controller.ts` post-attach branch), so an immediate re-open of the same id does not wait for it. The client's `endSession` only forgets its own entry, so the table stays consistent; awaiting it (as `leave` does) would make F17's "awaits the pending detach" hold literally.

## Execution — slice 12c (the screen)

*— claude-opus-5-5, 2026-11-14 (executor of slice 12c; branch
`feat/mobile-session-view-12c`, no checkout/restore/stash/commit)*

> Signature note: this section first read `deepseek-v4-pro`, a guess. The real id
> is `claude-opus-5-5` (read from this session's own transcript, every assistant
> record `"model":"claude-opus-5-5"`); 12b's Review caught exactly this class of
> error, so it is corrected here rather than left standing.

**Slice 12c only.** 12a and 12b are merged (`main` at `ba8c5a8`); this branch
carries the screen, its pure modules, the six flows and one changelog fragment.
Nothing under `packages/**` changed: no protocol schema, no `protocol.json`
regeneration, no `protocol.d/` note (P11 held — `git diff --name-only` is
`apps/mobile/**`, `docs/feat/mobile-session-view.md` and
`changelog.d/mobile-session-view-12c.added.md`).

### Load-bearing check (re-run first, as the brief requires)

The plan's assumption is 12a's: the phone's screen consumes the TUI's attach path
unchanged, with ONE broker. Re-proved on THIS branch's code, through the app's
own modules — `session-controller.ts`, `transcript.ts` applied to what a session
yields, and `connection.ts`'s `createLinkBroker`
(`.tentacle/tmp/mobile-session-view-12c/load-bearing.ts`: a real `SessionHost` +
`Connection`, a laptop client and the phone):

```
A open=true activities=["history"]
  rows=user(hello) | assistant(ok: hello)
B ask with NO requester: written=[] phoneSentResolve=false events=["user_message","tool_start"]
  foreignTurn=true brokerHeld=true
  sheet asked tool=fs_write title="Write a file" reply=yes
C after the sheet: asked=1 written=["…/project/a.txt"]
  events=["user_message","tool_start","tool_phase","tool_result","text","turn_end"]
  rows=user | assistant | user | tool:fs_write:ok:diff | assistant
D stop a foreign turn: opened=true cancelId=true same=true sentCancel=[true]
E leave: archived=false attached=2 sentClose=false
```

So: `attach` delivers `history` as rows; with **no requester set the ask WAITS
and the phone sends no `resolve_permission`** (the plan's Repro 2, on the screen's
own broker); the sheet's requester is what lets the tool run **once**; the
diff lands on the tool row; a foreign turn's `cancel()` reaches the wire with
that turn's id; leaving sends `session/detach` and never `session/close`. Check
PASSED (and it is exactly what `session-screen.test.ts` pins in the gate).

### As built, in dependency order

1. **`apps/mobile/src/composer.ts` (new, pure).** `composerAction` — the whole
   truth table: send iff link `up` ∧ no turn ∧ text not blank; **■ Stop** iff a
   turn runs (own or foreign) ∧ the field is empty ∧ the link is up (a `cancel`
   cannot travel a dead link, so offering Stop there would be a button that does
   nothing); a typed draft during a turn keeps the text (steer is task 13);
   `restoreAfterFailure` puts a refused send's words back **after** anything typed
   since.
2. **`apps/mobile/src/permission-sheet.ts` (new, pure).** The `PermissionRequester`
   the client's ONE broker gets: FIFO queue, the **age guard** (`ARM_MS` 400 ms)
   as a SCHEDULED state change (`schedule` injected — see finding 1), options
   derived from what the daemon offered (`allow_once`/`allow_always`/`reject_once`,
   plus `reply` exactly when the ask takes one), a withdrawn ask resolving
   `DISMISSED` (nothing sent), and `onAnswerLost` putting the person's words back
   with the TUI's own wording.
3. **`apps/mobile/src/session-view.ts` (new, pure).** The screen as a value:
   header state line, the eight banners, `retry`/`reopen` flags, the composer view.
   Every wording is the APP's (a pod chooses its error messages); the archived
   banner is the only one offering Reopen, and only when the reopen it is showing
   has not already failed as archived.
4. **`apps/mobile/src/session-feed.ts` (new, pure).** `SessionActivity`/`SessionEvent`
   → `TranscriptInput`, and the ONE place a turn's outcome is decided
   (`turnOutcome`): a stated `cancelled` → cancelled, any other stated end →
   ended, a stream that closed with no end → **interrupted**, a stream that threw
   → **lost**. Own and foreign turns open the SAME bracket, which is F10's point.
5. **`apps/mobile/src/links.ts` (new, pure).** A link tap confirms first
   (`http`/`https`/`mailto` only; the FULL url in the confirmation); the OS is
   only ever reached from the confirmation's own callback (F22, Owner Q7).
6. **`apps/mobile/src/session-runtimes.ts` (new, pure).** One `SessionController`
   per LIVE client, shared across screen mounts — a per-mount controller would
   lose the per-id queue F17's serialisation depends on — replaced (and disposed)
   when a Retry hands back a new client.
7. **`apps/mobile/src/session-screen-controller.ts` (new, pure, injected).** The
   wiring the screen calls: attach (first open NEVER passes `reopen`;
   `deps.archived` only decides the banner), the sheet's requester set on the
   client's own broker after the attach and `reset()` on leave, send (with the
   refused-send restore), Stop (own → the send's `AbortSignal`, foreign → the
   activity's `cancel()`), the link status, and the thumbnails window.
8. **Presentation (rewritten/new):** `screens/SessionScreen.tsx` (a `FlatList`
   of rows, the always-mounted `turn-running`/`turn-idle` indicator, the banners
   with Retry/Reopen, a `KeyboardAvoidingView` composer), `screens/transcript/`
   (`TranscriptRow.tsx`, `Markdown.tsx`, `DiffView.tsx`) and
   `screens/PermissionSheet.tsx` (a native page-sheet `Modal`). All testIDs the
   plan names exist.
9. **`App.tsx`, `routes.ts`, `SessionsScreen`:** the `Session` route builds the
   controller through the registry and the shared client; `SessionRoute` carries
   `archived`; the list passes it on navigate.
10. **The harness:** the mock model learns OpenAI tool-call SSE (`EDIT <name>` →
   a real streamed `fs_write` call) plus `SLOW` (a turn that streams and ENDS);
   12 new hooks (`laptop-prompt`, `laptop-answer`, `session-state`, `history`,
   `file-exists`, `model-prompts`, `model-replies`, `edit-calls`, …); one session
   per permission flow; flows `06`–`11` (+ `08b` deny and `08c` reply variants),
   each ending on daemon truth; `04-session-placeholder.yaml` **deleted**.
11. **Tests** (new): `composer.test.ts` (13), `permission-sheet.test.ts` (21),
    `session-view.test.ts` (16), `session-feed.test.ts` (11),
    `links.test.ts` (6), `session-runtimes.test.ts` (4), `session-screen.test.ts`
    (15), and `e2e-flows.test.ts` extended to 10 (the daemon-truth ending rule,
    the deleted placeholder, no flow ending on its container).
12. **`changelog.d/mobile-session-view-12c.added.md`** — one bullet, validated by
    `scripts/changelog.ts`'s own parser (`bun test scripts/test/changelog.test.ts`
    green). `TODO.md` untouched.

**RED before green.** Every pure module's tests were written before its
implementation and run red on the missing/incorrect code; §"Mutations" below is
the §9 non-vacuity proof (each mutation reddens the test named for it, and the
tree was re-checked after each revert).

### Mutations (each applied, run on the named file, reverted — pasted results)

Every one is a §9 non-vacuity check: the mutation is applied to the module, the
narrow test file is run, the failure is recorded, and the file is restored
(`.tentacle/tmp/mobile-session-view-12c/mutate.py`; `git status` re-checked after
each revert).

```
=== M1 age guard ARM_MS = 0 (the plan's own)          plan 12c
    (fail) a tap inside ARM_MS of the ask appearing is IGNORED, and the ask stays
    (fail) the window re-arms for the NEXT ask (a sheet that swaps is a new decision)
    (fail) view() reports `armed` by the clock, so the screen can dim the options
    (fail) a second ask waits; answering the first presents it, armed again
    14 pass 4 fail
=== M2 archived → Reopen always offered                Owner Q4
    (fail) a reopen that failed as archived again: no second Reopen button…
    (fail) deleted: its own banner, no Retry, no Reopen
    (fail) too many sessions: said plainly, no retry, Reopen stays off
    13 pass 3 fail
=== M3 a running turn no longer blocks send            decision 15
    (fail) own turn + empty field → Stop for THAT turn
    (fail) FOREIGN turn + empty field → Stop for that turn id
    (fail) a turn runs and something is typed → neither send nor stop
    (fail) a turn runs on a DEAD link → no Stop, and it says turn
    9 pass 4 fail
=== M4 a refused send does not restore the text        F13
    (fail) a send refused before the ack puts the text BACK with a notice
    14 pass 1 fail
=== M5 this phone's Stop does not abort its own turn    decision 15
    (fail) this phone's OWN turn stops through its own abort signal
    14 pass 1 fail
=== M6 a cut stream reported as `ended`                 F19
    (fail) a stream that closed with no end event → interrupted
    (fail) a foreign turn's cancel is handed out for Stop, and cleared once it ends
    9 pass 2 fail
=== M7 the sheet's requester never reaches the broker    AGENTS "single broker"
    (fail) it attaches, mounts the sheet's requester on the ONE broker, and goes Live
    (fail) the sheet's answer IS the answer the broker hands back
    (fail) leaving withdraws the ask and RELEASES the broker
    12 pass 3 fail
=== M8 leave() does not reset() the broker              F2 / single broker
    (fail) leaving withdraws the ask and RELEASES the broker (a detach sends nothing)
    14 pass 1 fail
=== M9 a link tap opens without confirming              F22 / Owner Q7
    (fail) nothing opens until the person confirms
    (fail) a cancelled prompt opens nothing
    4 pass 2 fail
=== M10 the route's `archived` flag passes reopen        Owner Q4
    (fail) a route flagged `archived` still attaches WITHOUT reopen
    (fail) an attach that failed as archived offers Reopen, and Reopen attaches
    13 pass 2 fail
=== M11 a new client does not replace the controller     F17
    (fail) a NEW client (a redial) replaces the controller, and the old one is disposed
    3 pass 1 fail
=== M12 every row wants thumbnail bytes, not the window  owner's image rule
    (fail) the visible window asks the thumbnail driver only for those rows
    14 pass 1 fail
=== M13 the age guard's release is never SCHEDULED      finding 1 (below)
    (fail) the release is EMITTED as a state change, so the screen never polls a clock
    (fail) a withdrawn ask CANCELS its scheduled release
    19 pass 2 fail
```

M8 is worth naming: the first version of its test proved only "*a later ask
waits*", which stayed green with `reset()` removed (the broker's own
`holdUntilSet` did the waiting) — a weaker property than the one the mutation
touches. It now also asserts that the departed screen's sheet sees **no new
ask**, which is what `reset()` actually buys, and the mutation reddens it.

### Drift from the Implementation (and why)

1. **`session-feed.ts` and `session-screen-controller.ts` are two modules, not
   zero.** The plan put the screen's wiring in the components and listed three
   pure modules (`session-view`, `composer`, `permission-sheet`). The turn BRACKET
   (`turn_started`/`turn_ended` with its five outcomes) and the sheet's
   requester/broker lifecycle are decisions AGENTS §7 says must be testable
   without a simulator — and they are exactly the ones the flows found bugs in.
   So they are pure, injected modules; the components map a value to elements.
2. **`links.ts` and `session-runtimes.ts` are new (not in the plan's file list).**
   `links.ts` because F22/Owner Q7 ("ask before opening") is a decision, and
   putting it in a `Pressable` would be untestable. `session-runtimes.ts` because
   `session-controller.ts`'s per-id queue is only worth anything if it survives a
   screen mount — a per-mount controller loses F17's serialisation on a fast
   back-then-forward.
3. **A plain refusal renders as `error`, not `denied`.** The plan's flow list said
   `tool-<callId>-denied` for the deny variant; 12b's own Drift 4 (already merged)
   reserves `denied` for a refusal WITH the person's words, which is what the TUI
   distinguishes. Flow `08b` asserts `tool-<id>-error` and flow `08c` (the reply
   variant) asserts `tool-<id>-denied`, so both states are covered and neither
   flow can pass by accident.
4. **`armedInMs` + an injected `schedule` in `permission-sheet.ts`.** Not in the
   plan, and it is a bug the simulator found (finding 1): `armed` was computed
   from the clock *at render time*, so nothing re-rendered when the window ended.
5. **The flow list gained `08b` and `08c`** (the plan's `08` had "variant deny" and
   "variant reply" as sub-cases). Two separate flows, because each has its own
   daemon-truth ending and a `clearState` of its own; and each permission flow got
   its OWN seeded session (finding 3).
6. **The transcript's images draw their label, not a thumbnail.** The thumbnail
   TRANSPORT still does not exist (12b's Drift 1 — no `attachment/get`), so
   `UserRowView` draws `[image: name]` (`imageRowText`) and draws a thumbnail only
   if the injected port ever yields one. The plan's owner requirement is met
   as far as this build can honestly go, exactly as 12b recorded it.
7. **`apps/mobile/e2e/seed.ts`: every harness client is `holdUntilSet` with no
   requester, and leaves by detach.** The 11a seeder dialled with `denyAll` and
   stayed attached: it silently answered every ask with a "No", so flow 08's sheet
   never appeared (finding 2). This is 12a's Repro 2 hazard, in the harness.

### Findings from the iOS 26 runs (each fixed, in order)

1. **The age guard's release was invisible to React.** `armed` was derived from
   the injected clock inside `view()`, so the sheet rendered once with
   `armed: false` and never again: the options stayed dimmed and `disabled` for
   ever, and every permission flow failed after the sheet appeared. A screen-side
   timer did not help (it re-rendered with the same stale prop). **Fixed by moving
   the release into the module**: `present()` schedules it and emits it through
   the same `onChange` every other change uses (`schedule` is injected, so the
   test drives it). Pinned by two new tests and mutation M13.
2. **The harness's `denyAll` broker stole every ask.** The seeder's client stayed
   attached with `denyAll`, so the daemon offered it the request and got an
   immediate "No": the phone's sheet never opened, and the transcript showed
   `Write · error`. **Fixed**: every harness client is `holdUntilSet` with no
   requester (an ask WAITS), and each helper detaches instead of closing.
3. **A pending ask leaked across flows.** An ask is daemon-side state that
   outlives a flow's `clearState`; flows 08/08b/08c/09/10 shared `Alpha`, so the
   request 08 left pending was re-offered to 08b's screen and covered it. **Fixed**:
   one seeded session per permission flow (`ASK1_ID`…`ASK5_ID`).
4. **The daemon does not see the detach when the app is backgrounded.** The plan's
   F2 said "background → link suspended → daemon detach". On iOS 26 the JS thread
   is frozen as the app goes to the background, so the gate's `suspend()` and its
   socket close do not reliably reach the wire before the process stops running;
   the daemon notices only when its own 60 s ping fails. The app still sheds the
   link as soon as JS runs again, and the ask still WAITS (P2 holds). The flow
   asserts what is true and load-bearing (nobody answered it, the turn is still
   suspended), and the plan's F2 row now says so instead of claiming an immediate
   detach.
5. **Maestro's `launchApp` relaunches the process; `openLink` raises an iOS system
   dialog.** A `launchApp` without `clearState` still restarts the app (it came
   back on `Computers`, navigation state gone), and `openLink: "so.tentacle.app://"`
   raises iOS's own "Open in tentacle?" sheet, which then covered the NEXT flow.
   Flow 10 therefore walks back in after the relaunch, and no flow uses `openLink`.
6. **A `display: none` element is invisible to XCUITest.** `turn-idle` was drawn
   as a hidden `Text`: Maestro could never assert it. It is now one always-mounted
   element whose `testID` flips between `turn-running` and `turn-idle`.
7. **The composer's button sits under the keyboard.** Every flow that types now
   runs `hideKeyboard` before tapping it.
8. **The mock model looped on its own tool result.** A follow-up round (last
   message `role: "tool"`) re-emitted the `EDIT` call for ever, so one prompt ran
   `fs_write` sixteen times. Fixed: a follow-up round answers in prose.
9. **`editTarget` never matched.** The daemon renders its own `[context: …]` line
   onto the user message every request, so the model sees the person's text
   followed by a line they never typed — `^EDIT …$` of the whole prompt missed it.
   Matched per LINE now.
10. **The reply-text extraction swallowed the agent's guidance sentence.** The
    tool message ends with `REPLY_GUIDANCE`; the hook now strips it by its own
    verbatim text.

### Notes / unverified

- **iOS 18 is not covered** (P9, unchanged from 11a): Xcode 27.1 cannot install
  that runtime, so `bun run e2e:mobile` reports it missing (exit 2) and this slice
  ran `--ios 26` only. Every flow above is iOS 26.5.
- **Thumbnails have no transport** (12b Drift 1): the driver's port is exercised
  by a fake here too. A `media_message` ref draws its label.
- **The daemon's `attached` count lags a background** (finding 4). The app's side
  is correct (the gate closes the socket when JS runs again); the daemon's count
  is what waits for its own ping timeout. Nothing in the phone's behaviour depends
  on it.
- **Backgrounding resumes by RELAUNCH in the harness** (finding 5). A person
  tapping the icon gets the same screen back; Maestro cannot express that without
  iOS's own "Open in…" dialog, so flow 10 re-navigates. The behaviour under test
  (the ask waits, and is re-offered on re-attach) is unchanged.
- **A long Maestro session degrades the simulator.** After many consecutive
  harness runs the XCUITest driver fails to start (`DeviceUnreachableException`,
  `iOS driver not ready in time`) or `simctl install` fails with
  `Mach error -308`, and every flow then fails identically — which is why some
  runs in this slice's history show all-red. Recovering needs a simulator
  shutdown + `simctl erase` + boot (a stale `expo run:ios` install can also hang
  and must be killed). Not a product or flow issue, but a CI leg should boot a
  fresh simulator per run.
- The full `bun test` suite (see Gate) contains one known load-sensitive test in a
  package this slice does not touch (`packages/daemon/test/serve-log-store.test.ts`
  S11), as 12b's Execution recorded.

### Gate

```
$ bunx tsc --noEmit                    # clean
$ bunx tsc --noEmit -p apps/mobile     # clean
$ bun run lint                         # Checked 1080 files. No fixes applied. (0 errors, 0 warnings — the §6 baseline)
$ bun test apps/mobile/test            # 308 pass · 0 fail (29 files)
$ bun test                             # 8210 pass · 3 skip · 0 fail · 13 snapshots (592 files, 333s)
```

The three skips are the §6 opt-ins (live-k8s, live-docker, the real-socket
keepalive test).

**Maestro, iOS 26.5 (`iPhone 17 Pro`, Release build), the run this slice merges on:**

```
$ JAVA_HOME=$(brew --prefix openjdk@17) PATH="$(brew --prefix openjdk@17)/bin:$PATH" \
    bun run e2e:mobile --ios 26
=== iOS 26 (0FA4B51F-A0E3-421B-BE66-CE29EF45213D) ===
✓ 01-shell (iOS 26)          ✓ 08-permission (iOS 26)
✓ 02-session-list (iOS 26)   ✓ 08b-permission-deny (iOS 26)
✓ 03-refresh (iOS 26)        ✓ 08c-permission-reply (iOS 26)
✓ 05-daemon-down (iOS 26)    ✓ 09-foreign-turn (iOS 26)
✓ 06-session-open (iOS 26)   ✓ 10-background-ask (iOS 26)
✓ 07-prompt (iOS 26)         ✓ 11-disconnect-mid-turn (iOS 26)

PASS — logs in .tentacle/tmp/e2e-mobile/1794620942358
```

Twelve of twelve, on the screen this slice builds. Each flow's last step is a
daemon-truth check (`e2e-flows.test.ts` enforces it), so a screen that merely
DREW the right ids cannot pass: 06 proves the phone left by DETACH
(`archived: false`, `attached` back to the laptop), 07 that the daemon's history
holds the typed prompt and the mock's answer, 08/08b/08c that the approval ran
the tool ONCE, the refusal ran it not at all, and the reply reached the MODEL,
09 that a foreign turn's Stop cancelled that turn id daemon-side and that the
LAPTOP's first answer closed the phone's sheet, 10 that the ask WAITED while the
phone was away and was answered after it returned, 11 that a killed and
restarted `serve` converges (rows kept, banner cleared, composer usable, history
intact).

No schema changed, so `packages/protocol/schema/protocol.json` was NOT
regenerated: nothing under `packages/**` is touched (P11 re-verified).
