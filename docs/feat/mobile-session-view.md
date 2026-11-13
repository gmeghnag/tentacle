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
| F2 | **Ask while the screen is gone / app backgrounded** | screen left → `detach` withdraws prompts (P5); background → link suspended → daemon detach; the ask waits (P2) | the laptop may answer it; else re-offered on the next attach/resume and shown then |
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
