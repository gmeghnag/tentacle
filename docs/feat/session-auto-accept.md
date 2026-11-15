# feat/session-auto-accept — Auto-accept is the session's, shared by every client

> **Status:** executed (six slices, all gates green — awaiting Review)
> **Branch:** `feat/session-auto-accept`
> **Size:** L as a whole → six slices, each S or M (table in Design) · **Blast:** load-bearing (it changes what the single broker's requester auto-answers, adds a session field to the trusted `serve` sidecar, and adds a protocol method + update; AGENTS §7 "single broker", "a pod is not trusted", persistence, protocol) · **Suited:** slices 1, 6 may go to any executor with standard Review; slices 2–5 a strong executor, and **mandatory fresh-context Review** of the whole branch red-teaming §7 (single broker, pod not trusted, persistence). The owner assigns executors.
> **Changelog:** `changelog.d/session-auto-accept.changed.md` — `- **Auto-accept is per session, on every device.** Shift+Tab in a terminal or the switch on the phone's approval sheet turns auto-accept on or off for the whole session; every terminal and phone attached to it follows at once, and a \`serve\` session keeps it across a daemon restart. Approvals it gives are one-time only; a pod session (\`run\`/\`attach\`) keeps it on the laptop as before.`

## Context

*— claude-opus-5-5, 2026-11-15*

**The owner's decision (2026-11-15).** Auto-accept becomes a SESSION-level
state, held by the daemon and shared by every client of the session — TUIs on
the laptop (worker, `connect`, `attach`) and the iPhone app — so toggling it
anywhere (TUI Shift+Tab, the app's permission-sheet switch) changes it
everywhere, with a live update to all attached clients.

**Why the task exists.** `feat/mobile-ui-polish` owner decision 3 asked for an
"Auto-accept" switch on the phone's approval sheet wired to "the session's
EXISTING shared auto-accept". The executor stopped: there is none
(`docs/feat/mobile-ui-polish.md:571`). Verified again on this tree:

- Auto-accept is each TUI's own React state: `usePermissionBroker`
  (`packages/tui/src/permission-ui.ts:322-330` state + ref, `:412-425` toggle,
  `:447-449` the auto branch `if (autoApproveRef.current && autoApproves(req,
  own)) return { allowed: true, scope: "once" }`). The rule is `autoApproves`
  (`permission-ui.ts:59-61`): own turn, never `hooks_trust`, never
  `session_hop`.
- The only cross-terminal sharing is a detached run's: a laptop file
  `<runDir>/auto-accept/<sessionId>` (`packages/cli/src/run-state.ts:221-233`),
  polled every 250 ms (`packages/cli/src/shared-auto-accept.ts:19`), deliberately
  "never the pod, never the daemon: no frame, wire field or activity reaches it"
  (`shared-auto-accept.ts:4-6`). A plain TUI gets an in-memory feed nobody else
  sees (`packages/cli/src/run-ui.ts:1-8`, `main.ts:1631`).
- No protocol method, field or update carries it, and the app has no notion of it
  (repro below).
- The "Also asked on <computer>" note has no data either: a `permission_request`
  carries no list of the clients it was raised to, and `ClientInfo` is only
  `{ name, version }` (`packages/protocol/src/session.ts:186-189`).

**Constraints.** AGENTS §7: ONE `PermissionBroker` per process, and the
auto-accept decision stays in its requester; a pod is not trusted, so a value a
pod daemon holds must never decide a laptop prompt; the trusted `serve` daemon
persists (sidecar), pod daemons and the worker never do; protocol changes are
additive where possible (update classes; a `protocol.d/` note only for a break).
`feat/session-hop-ux` (branch, executed, in review — not merged on this tree:
`packages/tui/src/useHop.ts:166` still clears auto-accept per D9) makes
auto-accept survive a hop (its OD5) and lets it answer moves except toward local
from a workload (its OD4). This plan assumes that branch merges first.

**Repro** (2026-11-15, this worktree; ripgrep via the Grep tool):

```
$ rg -n -i "autoaccept|auto_accept|permission_mode" packages/protocol/src
packages/protocol/src/version.ts:18:// (docs/fix/autoaccept-wake-turns.md): `session/prompt` and `session/send_now`
packages/protocol/src/updates.ts:394:   * `userRead >= n` says this one was read (docs/fix/autoaccept-wake-turns.md).
packages/protocol/src/session.ts:295: * (docs/fix/autoaccept-wake-turns.md). No client may mint one: `session/prompt`
packages/protocol/src/session.ts:567:   * (docs/fix/autoaccept-wake-turns.md, part B). Absent from an older daemon:
$ rg -n -i "autoaccept|auto_accept|auto-accept" apps/mobile/src
(no matches)
```

Only doc references to the wake-turn fix: no method, field or update, and nothing
in the app. The executor re-runs both on `main` before the first edit.

## Implementation

*— claude-opus-5-5, 2026-11-15*

### Load-bearing assumption

**Every auto-accept decision is taken by the requester a client installs on its
ONE broker, and a client can tell — from facts it holds itself, not from
anything the daemon says — whether the daemon behind a session is trusted.** The
plan moves only the *state* to the daemon. The *decision* stays in each client's
requester, and only a client that knows its daemon is trusted reads that state.

Proof:
- The decision point is the requester: TUI `permission-ui.ts:440-449`; detached
  relay `packages/cli/src/relay-policy.ts:62-72`; phone
  `apps/mobile/src/permission-sheet.ts` (its header: "the phone's
  `PermissionRequester`"), installed on ONE `holdUntilSet` broker per link
  (`apps/mobile/src/connection.ts:191-192`).
- A daemon's ask never carries `kind` or any laptop-internal field:
  `toPermissionRequest` rebuilds it from an allowlist
  (`packages/client/src/permission-router.ts:76-86`, cited by
  `feat/session-hop-ux` and unchanged here), so a daemon cannot make an ask look
  like something auto-accept may answer.
- Trust is already a laptop-side, fail-closed construction bit:
  `RemoteClientOptions.daemonWakes` "is a TRUST bit … fails closed — never keyed
  on `daemonKind` … Set only by `connect`; the worker, pod `run`/`attach` and
  the relay never say it" (`packages/client/src/remote-client.ts:402-410`; set
  at `packages/cli/src/connect.ts:188`). The call sites that build a client are
  few and each knows its daemon: worker `local-runtime.ts:1381` (in-process,
  laptop code), pod `run`/`attach` `engine-runtime.ts:661` / `:1078`, `connect`
  `connect.ts:178`, phone `apps/mobile/src/connection.ts:312` (the phone reaches
  only `serve`: "Only a `serve` on the user's host has a device route",
  `docs/feat/mobile-relay.md:133`).

So a new bit of the same kind (`sharedAutoAccept`) can gate the feature per
client, and a pod — which never gets the bit — can never turn auto-accept on.

### Preconditions

- **P1 — the session-settings seam is the pattern.** `session/update_settings`
  (`packages/protocol/src/methods.ts:100-101`, `:194-196`;
  `packages/protocol/src/session.ts:920-949`) applies a client's change to a live
  session; the daemon broadcasts `session_settings`
  (`packages/daemon/src/hosted-session.ts:2377`), classed `display`
  (`packages/protocol/src/updates.ts:489`), and the client handles it outside any
  turn (`remote-client.ts:3230-3232`). Dispatch: `connection.ts:338-340`.
- **P2 — one emit, every attachment, in order.** `HostedSession.emit`
  (`hosted-session.ts:1967-1982`) numbers each update (`++this.seq`), puts it in
  the replay ring, and sends it to every attachment synchronously. JS runs one
  handler at a time, so two `set` calls are applied and emitted in one total
  order; one connection delivers frames in order.
- **P3 — two identical auto answers collide harmlessly.** `resolvePermission`
  treats "the SAME answer as the one that settled it" as a success with no effect
  (`hosted-session.ts:1120-1135`); a different losing answer is
  `PermissionNotPending`, which the client already handles as a lost race
  (`remote-client.ts:3665`, `:3752`; `client/src/permission-map.ts:36`). Two
  clients both auto-answering `allow_once` is therefore safe.
- **P4 — the sidecar is hand-parsed, versioned on its own.**
  `daemon-state-file.ts:58-66` (`DAEMON_STATE_VERSION` 2/1), `DaemonSidecar`
  `:69-92`, built by `sidecarOf` `:103-126`, written after the log by the
  persister (`hosted-session.ts:1178-1182`, `persist()` → `persister.schedule`).
  An older build parses only the fields it knows, so an unknown `autoAccept`
  field is ignored — the session reloads OFF there (safe direction, not a
  half-load of the conversation; no version bump, see Design D2).
- **P5 — pod daemons and the worker never persist** (AGENTS §7; only
  `startDaemon` gives `SessionHost` a persister — `hosted-session.ts:657`
  `persistence?.persister ?? null`).
- **P6 — the TUI already re-binds a feed.** `usePermissionBroker`'s effect
  subscribes to `feed.onChange` and re-applies `feed.current()` when the feed
  object changes (`permission-ui.ts:427-435`); a detached run's feed already
  switches per session with `use(sessionId)` (`shared-auto-accept.ts:136-140`,
  called from `attach-run.ts:515`).
- **P7 — forward compat.** Payloads are strip schemas; an unknown method is
  `MethodNotFound`; a `display` update unknown to an older client is shown as
  `unsupported` once per kind (AGENTS §7, `updates.ts:440-443`). `ClientInfo`
  that does not validate is dropped, never an error (`session.ts:192-198`).
- **P8 — the phone drops its socket in the background** (iOS suspends JS:
  `apps/mobile/src/connection.ts:103`). Relevant to owner Q2.

### Design

**D1 — Where the truth lives (by runtime).**

| Runtime | Truth | Who decides an ask | Daemon value read? |
|---|---|---|---|
| worker (in-process) | the worker's `HostedSession` (laptop code) | the laptop TUI's requester | yes (`sharedAutoAccept`) |
| `connect` → `serve` | the `serve` session, persisted in its sidecar | each attached client's requester (TUIs, phones) | yes |
| phone → `serve` | same session | the phone's sheet requester | yes |
| pod `run` / `attach` | the laptop (in-memory feed, as today) | the laptop TUI's requester | **never** — not sent, not read |
| detached run (pod) | the laptop file `run-state` (unchanged) | relay policy / its TUIs | **never** (unchanged) |

The daemon *holds and broadcasts* the state; it never *answers* an ask with it
(owner Q1). Pod sessions keep today's laptop-side feed: the pod daemon runs the
same code and would accept the method, but no laptop client ever calls it or
reads its answer, so whatever a compromised pod claims changes nothing.

**D2 — Protocol (additive; no `PROTOCOL_VERSION` bump, no `protocol.d/` note).**
- `session/set_auto_accept` — params `{ sessionId, on: boolean }`, result
  `{ on: boolean }` (the session's value after applying). Unknown to an older
  daemon → `MethodNotFound`.
- `OpenResult.autoAccept?: boolean` — the snapshot on every open/attach/
  re-attach. **Present ⇔ the daemon shares auto-accept**; absent (older daemon)
  → the client keeps a local feed for that session.
- `OpenParams.autoAccept?: boolean` — the initial value, used ONLY when the open
  CREATES the session (ignored on attach, exactly like `settings`,
  `session.ts:888-889`). This is how a new session, a `/clear` fork and a hop
  target carry the current value.
- Update `{ type: "auto_accept", on: boolean, by?: string }`, class **display**:
  an older client misses it and keeps deciding with its own local state and own
  turns only — the safe direction. `by` is the setter's label (D7's `host` when
  present, else its `clientInfo.name`), filled by the daemon from the setter's
  `initialize`, never client-chosen per call; display only, untrusted text.
  Reverse mapping in `client/mapping.ts` (mirror `session_settings`, `:352`).
- No "turn the session's auto-accept on" ever travels as a permission rule:
  the daemon's `PermissionRuleStore`/"always" rules are untouched.

**D3 — Daemon.** `HostedSession` gets `autoAccept: boolean` (default from
`OpenParams.autoAccept` on create, else `false`) and `setAutoAccept(on, by)`:
apply, `emit({ type: "auto_accept", on, by })` only if it changed, `persist()`,
return `{ on }`. A set to the current value returns without an emit (idempotent:
a re-sent set after a drop is harmless). `serve` persists it in the sidecar as
`autoAccept: true` (written only when on; parse: exactly `true` → on, anything
else → off — a damaged file never yields ON, the same rule as
`shared-auto-accept.ts:8-11`). Reload restores it; `session/open{reopen}` of an
ARCHIVED session starts it OFF (owner Q3). Pod daemons and the worker hold it in
memory only (P5).

**D4 — Client.** `RemoteClientOptions.sharedAutoAccept?: boolean`, a TRUST bit
like `daemonWakes`: default off, fails closed, set only by the worker call site
(`local-runtime.ts:1381`, through a new `LocalRuntimeDeps.sharedAutoAccept`),
`connect.ts:178` and the phone's `APP_CLIENT_OPTIONS`; never by
`engine-runtime.ts:661/1078` or the relay. With the bit off the client never
sends the method, ignores `OpenResult.autoAccept` and drops `auto_accept`
updates. With it on, `RemoteSession` exposes `autoAccept: AutoAcceptLink`
(`current()`, `set(on)`, `onChange(l)`, `shared(): boolean`). The rules live in a
pure module `packages/client/src/auto-accept-link.ts`:
- `set(on)` applies locally at once (OFF must bite immediately; ON grants the
  prompt on screen, as Shift+Tab does today), then sends the method.
- Every `auto_accept` update is applied in arrival order, own echoes included —
  so all clients converge on the daemon's last emitted value (P2).
- A set not yet acknowledged when the link drops is kept as `pendingSet` and
  re-sent after re-attach; the re-attach snapshot is adopted only when there is
  no `pendingSet` (a person's OFF made offline is never undone by the daemon's
  older ON). Without a drop, the daemon's copy wins (AGENTS §7 re-attach rule).
- `OpenResult` without `autoAccept`, or `MethodNotFound` → `shared()` false:
  local-only for this session, one notice (D6).

`autoApproves` and `ownRequest` move from `@tentacle/tui` to `@tentacle/core`
(`permission.ts`), re-exported by `@tentacle/tui` so existing imports (incl.
`relay-policy.ts:19`) keep working: the phone needs the SAME rule and cannot
import the TUI (React 18 vs 19, AGENTS §6).

Which turns the shared state answers (owner Q2, recommended "every turn of the
session" on a trusted daemon): `RemoteSession.autoAcceptsTurn` returns true for
any turn id of the session when `autoAccept.shared()`; otherwise today's rule
(`remote-session.ts:297-316`). `ownsTurn` is untouched, so `relay-policy.ts`
(which reads only `ownsTurn`, `:9-15`) is unaffected. A request with no turn id
stays "not mine" (`permission-ui.ts:73-83`).

**D5 — CLI + TUI.** The TUI keeps ONE `AutoAcceptFeed` prop. A new
`packages/cli/src/session-auto-accept.ts` builds a *routing* feed (logic in a
pure core, like `shared-auto-accept.ts`): it holds the laptop's last known value
and `use(session)` re-binds it — to the session's `AutoAcceptLink` when
`shared()` (adopting the daemon's value on an attach; a created session was
already seeded through `OpenParams.autoAccept`), else to its own memory carrying
the value over (pod session, older daemon). `main.ts` passes it instead of
`localAutoAccept` for the worker and `connect`, and calls `use` wherever a
session is created or switched (the `/clear` fork, `/sessions`, the hop's new
runtime — the same places `attach-run.ts:515` calls `autoAccept.use(id)`).
Detached runs keep `openSharedAutoAccept` unchanged. Hop: a move carries the
current value (session-hop-ux OD5): worker → pod lands in memory; pod → worker
seeds the new worker session via `OpenParams.autoAccept`. A move toward local
from a workload still always asks — that rule lives in `autoApproves`
(session-hop-ux OD4) and does not change.

What the TUI shows: the status bar is unchanged (`⏵⏵ auto-accept on`,
`components/StatusBar.tsx:110`) — it now reflects the session. A flip from another client
adds one transcript notice: `_auto-accept turned on from <by>_` / `…off…`
(`by` through `untrustedText`). Local-only fallback: one notice per session,
`_auto-accept applies to this terminal only: the daemon does not share it
(update tentacle)_`. The help line becomes `Shift+Tab auto-accept tools (whole
session)` (`commands.ts:448`).

**D6 — App.** `permission-sheet.ts` (pure) gets the session's link and the
`autoAcceptsTurn` test: an ask that `autoApproves(req, eligible)` while ON is
answered `allow_once` without becoming `asking`, and the sheet records a short
`auto-accepted · <tool>` line (display; logged by class only, never the command
text — the app log's P4 rule). Turning ON while an eligible ask is on screen
answers it (same as `applyAuto`, `permission-ui.ts:389-408`); the age guard
(`ARM_MS`) does not apply to an automatic answer. `PermissionSheet.tsx` renders a
`Switch` "Auto-accept · this session, every device" (styled by
`feat/mobile-ui-polish`'s sheet), disabled with "not shared by this computer —
update tentacle" when `shared()` is false. The session header shows a small
`auto` badge while ON, so the state is visible without an ask.

**D7 — "Also asked on <computer>" (slice 6).** `ClientInfo.host?: string`
(≤ 64 printable chars, strip-safe): the laptop sends `os.hostname()` ONLY when
`sharedAutoAccept` is on (never to a pod); the phone sends its device name. The
daemon stamps each `permission_request` with `askedOn: string[]` — the `host`
labels of the attachments that declared `permission_request` at raise time — the
same array for every recipient (it rides the replay ring unchanged, P2). The
phone drops ONE occurrence of its own label and, if anything is left, shows
"Also asked on <first>(+N) · the first answer wins" (through `untrustedText`).
Display only: nothing decides on it.

**Security rules (all clients).** Auto-accept answers `allow_once` only — never
`allow_always`, never stored. Never `hooks_trust` (laptop-internal kind, never on
the wire). `session_hop`: per session-hop-ux OD4 (a move toward local from a
workload always asks). Every automatic answer is visible (TUI: today's row;
phone: the `auto-accepted` line). A phone turning it on grants nothing new: a
paired phone can already answer any ask of that `serve` session, including
`allow_always`. A pod can neither set nor read it (D1, D4).

**Slices** (dependency order; one branch, each slice green on its own):

| # | Slice | Size | Blast |
|---|---|---|---|
| 1 | Protocol: method, open fields, `auto_accept` update (+ class), schema export | S | cross-module |
| 2 | Daemon: state, set, emit, open snapshot/seed, sidecar persist/reload, reopen → off | M | load-bearing (persistence) |
| 3 | Client: trust bit, `AutoAcceptLink` (pure), mapping, `autoAcceptsTurn` (Q2), move `autoApproves`/`ownRequest` to core | M | load-bearing (decision input) |
| 4 | CLI + TUI: routing feed, worker/connect wiring, `use` on every session switch and hop, notices | M | load-bearing (single broker) |
| 5 | App: link in the sheet requester, switch, badge | M | cross-module |
| 6 | "Also asked on": `ClientInfo.host`, `askedOn`, the sheet note | S | cross-module |

### Files

1. `packages/protocol/src/session.ts` (`SetAutoAcceptParams/Result`,
   `OpenParams.autoAccept`, `OpenResult.autoAccept`, slice 6 `ClientInfo.host`),
   `methods.ts` (`Method.SetAutoAccept` + table row), `updates.ts`
   (`auto_accept` member, `UPDATE_CLASS` → `display`; slice 6
   `permission_request.askedOn`), `index.ts` exports;
   `packages/protocol/schema/protocol.json` via `bun run schema:export` (never
   by hand) so `json-schema.test.ts` stays green on the branch.
2. `packages/daemon/src/hosted-session.ts` (state, `setAutoAccept`, open
   snapshot, `askedOn` in slice 6), `connection.ts` (dispatch, beside `:338`),
   the session host's open/reopen path, `persisted-session.ts`
   (`DaemonSessionRecord.autoAccept`), `daemon-state-file.ts` (sidecar field +
   parse), `permission-map.ts` (slice 6 `askedOn`).
3. `packages/core/src/permission.ts` (+ `autoApproves`, `ownRequest`);
   `packages/client/src/auto-accept-link.ts` (new, pure),
   `remote-client.ts` (option, method, update, snapshot), `remote-session.ts`
   (`autoAccept`, `autoAcceptsTurn`), `mapping.ts`, `permission-router.ts`
   (slice 6: `askedOn` into the request options).
4. `packages/tui/src/permission-ui.ts` (re-export from core),
   `index.ts`, `App.tsx` (remote-flip notice), `commands.ts` (help line);
   `packages/cli/src/session-auto-accept.ts` (new), `local-runtime.ts`
   (`sharedAutoAccept` dep → client), `connect.ts`, `main.ts` (wiring, `use`).
5. `apps/mobile/src/connection.ts` (`APP_CLIENT_OPTIONS.sharedAutoAccept`,
   slice 6 `host`), `permission-sheet.ts`, `screens/PermissionSheet.tsx`,
   `session-screen-controller.ts`, the session header.
6. `changelog.d/session-auto-accept.changed.md`.

### Failure modes

- **Two toggles race** (TUI ON, phone OFF at once): the daemon applies them in
  one order and emits each change (P2); every client applies every update in
  order, own echoes included → all converge on the last value. Momentary local
  divergence lasts one round trip; OFF is applied locally first, so a person's
  OFF bites at once on the device where it was pressed.
- **Disconnect** (phone backgrounded, laptop sleeps): the local value stays;
  an unacknowledged set is re-sent after re-attach, else the snapshot wins. While
  detached, nothing on that client answers anything (its asks are withdrawn).
- **Older daemon** (no field in `OpenResult`, or `MethodNotFound`): local-only
  for that session, one notice; the phone's switch is disabled with a reason.
- **Older client on a new daemon**: sees `auto_accept` as `unsupported` once and
  keeps its own local auto-accept, own turns only — it never answers more than
  before. Documented divergence, not a silent widening.
- **A pod sends `auto_accept {on:true}` or `OpenResult.autoAccept: true`**:
  ignored (bit off). Pinned by a test and a mutation (T3).
- **Detached run**: unchanged (laptop file + `relay-policy` own-turn rule); its
  daemon is a pod.
- **`serve` restart**: reloaded from the sidecar (owner Q3); a damaged or
  unknown value → OFF. A sidecar write that fails leaves the value live in memory
  (the persister's existing error path), lost only by a restart → OFF.
- **Archived session reopened**: OFF (owner Q3).
- **`/clear` fork / new session**: seeded through `OpenParams.autoAccept` with
  the current value; on `serve` the fork is created by the client's open, so it
  gets the value at creation.
- **Hop**: the routing feed carries the value (session-hop-ux OD5); a hop toward
  local from a workload still asks (OD4).
- **Both clients auto-answer one ask** (Q2 "every turn"): identical
  `allow_once` → the second is a no-op success (P3).
- **Session closed**: the link stops; the routing feed keeps the last value for
  the next session it binds.
- **Empty / malformed**: `on` is a boolean in the schema; anything else is
  `InvalidParams`; `by` absent → "another device".

### Tests

Red first on the current code, then green; each with the mutation that must
turn it red (AGENTS §9). Use the existing fakes (fake daemon / `Connection`
pairs from `packages/client/test`, `SpyBroker`, ink-testing-library harness in
`packages/tui/test/app.test.tsx`, the sheet's pure tests).

- **T1 protocol** (`packages/protocol/test`): params/result/update parse;
  `UPDATE_CLASS.auto_accept === "display"`; `OpenResult` without `autoAccept`
  still parses; an unknown extra field is stripped.
- **T2 daemon**: two attachments, one sets ON → both receive `auto_accept`
  and the result is `{ on: true }`; a third attaching sees `autoAccept: true` in
  `OpenResult`; interleaved sets → last value wins and emits are in order; set to
  the same value → no emit; `OpenParams.autoAccept` honoured only on create;
  sidecar round-trip on, `"yes"`/`1` → off; reopen of an archived session → off.
  Mutation: drop the `emit` → the two-attachment test fails; drop `persist()` →
  the reload test fails.
- **T3 client**: bit off → a daemon's `auto_accept {on:true}` and
  `OpenResult.autoAccept: true` leave `current()` false and no method is ever
  sent (mutation: default the bit to on → fails). `MethodNotFound` / missing
  field → `shared()` false. Offline OFF + daemon ON on re-attach → stays OFF and
  the set is re-sent (mutation: drop `pendingSet` → fails). Own echo applied in
  order converges in the race scenario. `autoAcceptsTurn` widening only when
  `shared()` (mutation: widen unconditionally → the pod test fails).
- **T4 TUI/CLI** (two `App`s on one fake `serve` daemon): Shift+Tab in A → B's
  status bar says on and B's own ask is answered `allow_once` with no dialog; the
  answer is never `allow_always`; a `hooks_trust` request still prompts; a pod
  runtime receiving `auto_accept on` keeps prompting (§7 red-team); the
  single-broker regression test is unchanged and green; the routing feed carries
  the value worker → pod → worker (the second worker's `session/open` carries
  `autoAccept: true`); a remote flip shows the `from <by>` notice.
- **T5 app** (`permission-sheet.test.ts`): ON + eligible ask → answered
  `allow_once`, never `asking`; turning ON with an ask shown → answered; OFF →
  shown and arm-guarded as today; switch calls `set`; `shared()` false → switch
  disabled. Mutation: ignore the link in the requester → fails.
- **T6 "also asked"**: `askedOn` lists the attachments that declared
  `permission_request`; the phone drops one copy of its own label; a pod-side
  client never sends `host` (assert the `initialize` params of a
  `engine-runtime` client).

Gate before "done": `bun run check` (typecheck → lint → test), lint baseline
clean (AGENTS §6).

### Owner questions

1. **Who answers when the session's auto-accept is on — each device, or the
   `serve` daemon itself?** Each device (the app or terminal attached) answers its
   asks automatically; if no device is attached, asks wait as today. The
   alternative, the trusted `serve` answering by itself, would keep working with
   every screen closed (e.g. overnight wake-ups), but it is a second decision
   point outside the single broker. **Recommendation: each device** (D1).
2. **Which turns does it answer — only the device's own, or every turn of the
   session?** Today a terminal's auto-accept never answers another device's turn
   (`docs/feat/tui-foreign-turns.md` C5). Kept as is, a turn started from the
   phone stops at its first ask as soon as the phone is put away (iOS drops the
   connection, P8), even with auto-accept on and the laptop attached. **Recommendation:
   every turn of the session, but only on a trusted daemon (worker, `serve`)** —
   the switch is now explicitly the session's and visible everywhere, so C5's
   reason ("my toggle must not approve someone else's work") no longer holds;
   pod runs and detached runs keep own-turn only.
3. **After a `serve` restart or reopening an archived session: keep the value
   or start OFF?** **Recommendation: a restart keeps it** (same live session;
   with Q1 nothing is answered until a device attaches), **an archived session
   reopens OFF** (an old switch should not silently come back on).
4. **"Also asked on <computer>": build it in this task (slice 6) or defer?** It
   needs a new optional device name in the handshake (the laptop's hostname, sent
   only to your own `serve`, never to a pod) and a list on each ask.
   **Recommendation: build it here as the last slice** — small, display-only,
   and it completes the sheet that `feat/mobile-ui-polish` left open.

## Execution

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-15* (Review round 1,
finding 5: this section was first signed `claude-sonnet-4-5`, which did not
execute it. Corrected in Fix round 1 to `deepseek` — the family, not an id —
and to the real id in Fix round 2. The evidence is the orchestrator's own run
log, `~/.tentacle/tmp/orchestration/runs/night-session-auto-accept.log`, whose
`04:43 deepseek done:` line is the record of the `ds()` path taking this step;
the commit subject `exec (deepseek)` is NOT evidence, being a hard-coded string
in `night-task.sh`. The id is this repo's deepseek profile in
`~/.config/tentacle/config.jsonc`, the same id `device-pairing.md` and
`app-decomposition.md` sign that executor with.)

**Load-bearing check (re-run first, per the brief): HOLDS.** Every cited site was
read on this branch before the first edit: the decision point is the requester
(`permission-ui.ts:59-61` `autoApproves`, `:447-449`; `relay-policy.ts:62-72`;
`apps/mobile/src/permission-sheet.ts` + `connection.ts:191-192` `holdUntilSet`),
`toPermissionRequest` still rebuilds an ask from an allowlist
(`permission-router.ts:76-86`), and trust is a laptop-side fail-closed
construction bit — `daemonWakes` (`remote-client.ts:402-410`, set only at
`connect.ts:188`). The call sites that build a client are the four the plan
names. So a bit of the same kind is a sound gate.

**Repro (before any edit).** `rg -n -i "autoaccept|auto_accept|permission_mode"
packages/protocol/src` → only the five `docs/fix/autoaccept-wake-turns.md`
comments; `rg -n -i "autoaccept|auto_accept|auto-accept" apps/mobile/src` → no
matches (exit 1). The capability is genuinely absent, as the Context says.

### As built, by slice

1. **Protocol** (`session.ts`, `methods.ts`, `updates.ts`, `permission.ts`):
   `session/set_auto_accept` (`{sessionId,on}` → `{on}`), `OpenParams.autoAccept`,
   `OpenResult.autoAccept`, the `auto_accept` update (`{on, by?}`) classed
   `display`, `ClientInfo.host`, `permission_request.askedOn`.
   `protocol.json` regenerated with `bun run schema:export` (never by hand).
   `packages/protocol/test/auto-accept.test.ts`; fixtures added to
   `json-schema.test.ts` (its "every method has a fixture" test is a hard gate).
2. **Daemon** (`hosted-session.ts`, `session-host.ts`, `connection.ts`,
   `persisted-session.ts`, `daemon-state-file.ts`, `session-persister.ts`):
   `HostedSession.autoAccept` + `setAutoAccept(on, by)` (emit only on a change,
   then persist); `SessionHostOptions.sharedAutoAccept` gates the `OpenResult`
   field; `OpenParams.autoAccept` seeds a CREATED session only; the sidecar
   carries `autoAccept: true` only when on (exactly `true` parses back, anything
   else is off); `restore` keeps it, a `reopen` of an archived session drops it.
   `worker.ts` and `serve.ts` declare `sharedAutoAccept: true`.
   Tests: `session-auto-accept.test.ts` (T2), `session-auto-accept-persist.test.ts`
   (sidecar round-trip, damaged value, reopen→off, no-persister host),
   `session-auto-accept-asked-on.test.ts` (T6, daemon half).
3. **Client** (`core/permission.ts`, `client/auto-accept-link.ts` new,
   `remote-client.ts`, `remote-session.ts`, `mapping.ts`, `permission-router.ts`):
   `RemoteClientOptions.sharedAutoAccept` (TRUST bit, default off, never keyed on
   `daemonKind`); the pure `AutoAcceptHandle` (`auto-accept-link.ts` — local-first
   `set`, in-order `receive`, `pendingSet` across a drop, `sync` adopts the
   snapshot only when nothing of ours is pending); `RemoteSession.autoAccept` and
   `autoAcceptsTurn` widening to every turn of the session **only** when
   `shared()`; `autoApproves`/`ownRequest` MOVED to `@tentacle/core` and
   re-exported by `@tentacle/tui`, so the phone and a terminal share one rule.
   Tests: `client/test/session-auto-accept.test.ts` (T3),
   `client/test/auto-accept-link.test.ts` (the pure rules).
4. **CLI + TUI**: new `packages/cli/src/session-auto-accept.ts` (the ROUTING feed
   — binds to a session's link when it shares, else keeps this laptop's value;
   `autoAcceptOf`/`seedAutoAcceptOf` are the structural seams); wired for the
   worker/hop path (`main.ts`) and `connect` (`connect.ts`), with `use` on every
   session create/switch and `seedAutoAcceptOnCreate` carrying the value into a
   `/clear` fork. TUI: `AutoAcceptSharedFeed.remote()`, one transit notice
   naming the device, the help line says `(whole session)`.
   Tests: `cli/test/session-auto-accept.test.ts`, `tui/test/session-auto-accept.test.tsx` (T4).
5. **App**: `permission-sheet.ts` owns the decision (`eligible` → `autoApproves`
   over the session's link, answered `allow_once`, never `asking`), a pure
   `alsoAsked`, `PermissionSheet.tsx` renders the switch and the
   `auto-accepted · <tool>` line; `APP_CLIENT_OPTIONS.sharedAutoAccept: true`.
   Tests: `apps/mobile/test/permission-sheet-auto-accept.test.ts` (T5),
   `apps/mobile/test/permission-also-asked.test.ts` (T6, phone half).
6. **`changelog.d/session-auto-accept.changed.md`** — one `changed` bullet.

### Drift from the Implementation (and why)

- **D7's "askedOn drops the phone's own label" moved to `@tentacle/core`**
  (`otherDevicesAsked`), not into `permission-sheet.ts`: the same rule is what a
  terminal would need, and it is a pure function with its own test. The sheet
  passes `deps.ownHost()`.
- **ClientInfo.host is added in `RemoteClient.wireClientInfo`**, at the
  handshake, not threaded through every `CLIENT_INFO` constant — one gate
  (`sharedAutoAccept`) in one place, so a pod client structurally cannot send it.
- **`askedOn` skips attachments that did not declare `permission_request`**: a
  client too old to show an ask takes the v10 fallback and is never asked, so
  naming it as a sibling would be a lie. This is stricter than the plan's
  wording and is pinned by a test.
- **The TUI's transit notice lives inside the existing host-notices effect**,
  not in a new one: `App.tsx`'s effect count is pinned by six structural tests
  (`use-dock`, `app-quit-clear-structure`, the `S5`–`S14` family). Folding it in
  keeps the count at 22 and the notice still fires. `AutoAcceptSharedFeed.remote()`
  was added for the same reason correctness needed it (below).
- **One real bug the plan did not foresee, found by the repo's own real stack**
  (`connect-functest-a`): (a) a TUI's OWN Shift+Tab came back through the feed
  and was announced as "from another device" — now gated by `remote()`; (b) a
  flip pressed BEFORE the session's first open answered was overwritten by that
  open's snapshot (the TUI went on deciding OFF, so a shell ask parked the turn).
  Both fixed in `auto-accept-link.ts` (`pendingSet` when unconfirmed) and the
  TUI, each with a regression test shown red on the buggy code.
- **The accessor naming**: `RemoteSession.autoAccept` is the LINK (what a view
  reads); the handle is `autoAcceptHandle` (client-only). `local-runtime.ts`
  re-exposes the link on `PersistingController`, so the routing feed binds to the
  controller it already receives.

### Mutation checks (each run, then restored)

| # | Mutation | Result |
|---|---|---|
| M1 | drop the `emit` in `setAutoAccept` | 4/7 of T2 red |
| M2 | drop the `persist()` | 2/5 persist tests red |
| M3 | pass `record.autoAccept` through at the reopen site | P4 (reopen → off) red |
| M4 | drop `unbind()` in the routing feed's `use` | "switching sessions re-binds" red |
| M5 | widen `autoAcceptsTurn` unconditionally | T3 pod-widening red |
| M6 | default the client's trust bit to on | T3 bit-off + widening red |
| M7 | drop `pendingSet` in `sync` | "offline OFF never undone" red |
| M8 | drop the transit notice's `appendNotice` | 2 T4 tests red |
| M9 | let `autoApproves` answer every kind | T4 `hooks_trust` red |
| M10 | ignore the link in the sheet's requester | 3 T5 tests red |
| M11 | drop `ownHost` from `otherDevicesAsked` | 2 T6 (phone) red |
| M12 | drop the `clientSupportsUpdate` guard in `askedOn` | T6 "older client" red |
| M13 | drop `remote()` from the notice gate | the own-Shift+Tab regression test red |
| M14 | drop `pendingSet` when unconfirmed | the pre-confirmation regression test red |

(The sheet's arm window made two T5 cases hang until the clock was advanced a
full `ARM_MS` — a test bug, fixed, not a code change.)

### Gate

`bunx tsc --noEmit`, `bunx tsc -p apps/mobile`, `bunx tsc -p apps/relay` and
`bun run lint` are all clean (0 errors, 0 warnings — the §6 baseline).
`bun run schema:export` regenerated `protocol.json`; `json-schema.test.ts` is
green. Full `bun test` is green except the three opt-in skips (k8s, docker, the
real-socket keepalive), as §6's baseline describes.

**Unverified:** the phone's `Switch` and the `perm-also-asked` note are rendered
by React Native components, so only their pure module (`permission-sheet.ts`) is
covered here — no simulator run. To verify: `apps/mobile` flows 08 (`perm-sheet`
screen) against a `serve` on the same session as a TUI.

## Review

*— claude-opus-5-5, 2026-11-15* (fresh context; same model as the planner — shared blind spots possible)

**Verdict: REQUEST-CHANGES.**

**Gate (re-run):** the 13 touched test files: 150 pass / 0 fail. `bun run typecheck` clean, `bun run lint` clean (1443 files). The full `bun test` was not re-run in this pass.

**Findings (HIGH/MEDIUM only):**

1. **HIGH: switching to an existing session that is OFF leaves this TUI auto-accepting.** `packages/cli/src/session-auto-accept.ts:353-366` adopts a session's value only if `shared()` is already true when `use` runs. A `/sessions` attach is still unconfirmed at that point. When its open answers, `sync(false)` → `apply(false)` (`packages/client/src/auto-accept-link.ts:557`) is a no-op, because the link's initial value is already `false`. So no listener fires, and the feed keeps the laptop's ON. Repro `.tentacle/tmp/session-auto-accept/switch-off.ts`: `on B: feed true | B link false shared true | other device false`. The TUI auto-answers its own turns (`permission-ui.ts:440` reads the feed) and its status bar says ON, while the daemon and every other device say OFF. This breaks D4's "the daemon's copy wins on re-attach", in the unsafe direction. No test covers `/sessions` → an OFF session.
2. **HIGH (code-proven, not bundled): the phone app no longer bundles.** `packages/client/src/remote-client.ts:20` adds `import { hostname } from "node:os"`. It is the first runtime Node built-in in the phone's import graph (protocol/transport/core/client — the only other is the `json-schema.ts` script, which nothing imports). On native platforms, Expo 58's resolver returns `null` for a Node built-in ("native throws an error on node.js internals": `@expo/cli/.../withMetroMultiPlatform.js:415-417`). `tsc -p apps/mobile` does not catch this. Related: the phone never sends a `host`, and `ownHost` is never wired (`apps/mobile/src/session-screen-controller.ts:215`), so D7's phone half is not built. The doc's Execution does not say so.
3. **MEDIUM: the §7 pod gate has no test that fails without it.** I removed both trust-bit checks (`remote-client.ts:2979` and `:3351`): 21/21 tests in client T3, the TUI test and the link test stayed green. The "bit OFF" test (`client/test/session-auto-accept.test.ts:124`) never has the daemon claim ON. Under that mutation, `pod-claim.ts` shows a pod-side client's routing feed turning ON (`routing feed current: true`), because the feed subscribes to and adopts changes from a link that does not share (`session-auto-accept.ts:357-366`). On the real code it stays `false`. So production is safe today, but the T3 "pinned by a test and a mutation" claim is false, and the protection is a single layer.
4. **MEDIUM: the phone auto-answers asks the TUI never does.** `apps/mobile/src/permission-sheet.ts:402` calls `ownRequest(options?.turnId, undefined)`, which is always `true`, so an ask with no turn id is auto-answered on the phone. The TUI calls `ownRequest(turnId, autoAcceptsTurn)`, which is `false` for no turn id. That contradicts D4 ("a request with no turn id stays not mine") and core's stated purpose of one rule on every device.
5. **MEDIUM (process, AGENTS §10): the executor signature does not match the commit.** Execution is signed `claude-sonnet-4-5`, but commit `e078e7a0` says `exec (deepseek)`. The signature must name the model that actually executed.

**Mutations:** M-A (drop the client trust gates) survived (finding 3). Reverted; `git status` is clean.

**Attacks that found nothing:** daemon `setAutoAccept` is idempotent, persists before it emits, and refuses a closed session. The sidecar writes and reads exactly `true`, and a reopen of an archived session drops it (`session-host.ts:652`). A pod daemon omits `OpenResult.autoAccept` without `sharedAutoAccept`. `host` goes on the wire only with the trust bit (`wireClientInfo`). `askedOn` is sanitized on the client. The protocol change is additive (display class, optional fields), so no version bump is needed.

**Executor behaviour:** thorough on the daemon and protocol, and it found and fixed two real bugs. But the client-side trust test is vacuous, the phone runtime (Metro) was never exercised, and the signature is wrong.

#### Orchestrator decisions (owner night delegation 2026-11-15)

Every owner question: the recommendation.
*— claude-opus-5-5 (orchestrator), 2026-11-15*

### Fix round 1

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-15* (Review round 2,
finding 1: this section was signed `claude-opus-5-5, 2026-11-16` — the reviewer's
id and the wrong date. Corrected to the executor actually recorded taking this
step: `night-session-auto-accept.log` has `07:02 deepseek done:`, the `ds()` path
of `night-task.sh` (`~/bin/tentacle --profile deepseek`, model
`rits/deepseek-ai/DeepSeek-V4.1-Flash-1017` in `~/.config/tentacle/config.jsonc`).
The commit subject `review round 1 (deepseek)` is not independent evidence: it is
a hard-coded string in `night-task.sh`. The date was the round's own commit
`347bf2d3`, 2026-11-15 07:02 +0100.)

Review round 1 found 2 HIGH + 3 MEDIUM. Every one is addressed below; each fix
was shown RED on the branch as it stood before the fix, then green, then
mutation-checked (AGENTS §9). Repros run in
`.tentacle/tmp/session-auto-accept/` (`switch-off.ts`, `pod-claim.ts`).

**F1 (HIGH) — an attach to an OFF session left the TUI auto-accepting.** Root
cause: the link reported only *changes*, and an OFF session's snapshot equals the
link's initial `false`, so a consumer bound at an unconfirmed attach (the routing
feed, `/sessions`) never heard the confirmation. Fix, two layers: the link emits
the FIRST snapshot as an event of its own (`apply`'s `force`, a new
`AutoAcceptSource` = `"update" | "snapshot"`, so a re-attach that moves nothing
stays silent), and the routing feed treats that source as neither a remote flip
nor an own echo (`ownFlip = echo || source === "snapshot" || value === on`).
`switch-off.ts` before: `on B: feed true | B link false shared true`; after:
`on B: feed false | B link false shared true | daemon/other device false`.

- `packages/client/src/auto-accept-link.ts` — `AutoAcceptSource`,
  `onChange(listener)` gains the source, `apply(on, source, label?, force?)`,
  `sync` forces on the confirmation only.
- `packages/cli/src/session-auto-accept.ts` — the `onChange` callback takes the
  source; a snapshot is never `remote()`.
- Tests: `client/test/auto-accept-link.test.ts` "confirming a session this link
  already agrees on STILL tells its consumers" (new) + "a RE-attach is silent";
  `cli/test/session-auto-accept.test.ts` "a session that CONFIRMS sharing at an
  attach the feed was already bound on" and "a snapshot is not news" (both new).

**F2 (HIGH) — the phone app no longer bundled, and D7's phone half was unbuilt.**
Root cause: `remote-client.ts` imported `node:os`, which Metro answers `null` for
on a native platform; it is the first Node built-in in the phone's import graph.

- The label is now a SEAM: `RemoteClientOptions.hostLabel?: () => string |
  undefined` (`remote-client.ts`, `hostName()` reads it). `node:os` is imported
  by the callers that have it: `local-runtime.ts` and `connect.ts`
  (`hostLabel: osHostname`), the phone `connection.ts` (`() =>
  computer.thisDeviceName`). No `node:` specifier is left in
  protocol/transport/core/client.
- D7's phone half is built: pairing records the phone's own label
  (`PairedComputer.thisDeviceName`, written by `pairing-flow.ts` and persisted by
  `computer-store.ts` — including `add`, which had silently dropped it), the link
  sends a `clientInfo` so `wireClientInfo` has something to extend, and the screen
  hands the sheet `ownHost: () => deps.phoneName?.()` from `App.tsx`.
- Tests: `apps/mobile/test/node-builtins-guard.test.ts` (new) — a source scan of
  the phone's real dependency graph plus three wiring guards, each naming the
  deletion that reddens it; `apps/mobile/test/computer-store.test.ts` "a record an
  older build wrote still loads, and sends no label" (new, and it caught the
  `add` gap); `client/test/session-auto-accept.test.ts` "`hostLabel` reaches the
  wire ONLY with the trust bit".

**F3 (MEDIUM) — the §7 pod gate had no test that failed without it.** New test
`client/test/session-auto-accept.test.ts` "a daemon that CLAIMS ON never reaches a
pod-side client (bit OFF, both halves)": the daemon really shares, another client
turns it ON, and the pod attaches *after* it (so `noteAutoAccept` sees a genuine
`autoAccept: true`) and then receives genuine `auto_accept` updates. Both halves
are separately pinned — M-B1 and M-B2 below each redden it alone.

**F4 (MEDIUM) — the phone auto-answered asks the TUI never does.** Root cause:
`permission-sheet.ts` passed `undefined` as the own-turn test, so `ownRequest`
returned `true` for a missing turn id. The sheet now takes the session's widest
test (`PermissionSheetDeps.autoAcceptsTurn`, supplied live from
`RemoteSession.autoAcceptsTurn` via `autoAcceptsTurnOf`) and, with none wired,
falls back to `() => true` — which makes `ownRequest` say *not mine* for an ask
with no turn id, exactly as a terminal decides. Three existing T5 tests that had
encoded the buggy rule (no turn id → auto-answered) now name a turn.

**F5 (MEDIUM, process) — the signature named the wrong model.** Fixed: this
section and the Execution one above are signed by the model that actually did the
work. The previous rounds' signatures are left as they were written (they are that
model's record), with this round's correcting the record.

#### Mutation checks (each run, then restored by hand — no `git`)

| # | Mutation | Result |
|---|---|---|
| M-A1 | `sync` does not force on the confirmation | link "confirming … still tells" red |
| M-A2 | `ownChange` ignores the `snapshot` source (feed) | feed "a snapshot is not news" red |
| M-B1 | drop `!this.sharedAutoAccept` in `noteAutoAccept` | pod-claim test red |
| M-B2 | drop the bit in the `auto_accept` branch of `output()` | pod-claim test red |
| M-C | drop the bit in `wireClientInfo` | "`hostLabel` … ONLY with the trust bit" red |
| M-D | restore `import { hostname } from "node:os"` in the client | node-builtins guard red, naming `remote-client.ts:20` |
| M-E | require `thisDeviceName` when reading a stored record | store round-trip + 4 more red |
| M-F | delete `hostLabel:` from `openComputer` | wiring guard red |
| M-G | delete `ownHost:` from the screen | wiring guard red |

Gate (`bunx tsc --noEmit`; `bunx tsc -p apps/mobile`; `bunx tsc -p apps/relay`;
`bun run lint`; `bun test`):

```
tsc --noEmit               clean
tsc -p apps/mobile         clean
tsc -p apps/relay          clean
biome check .              1444 files, 0 errors, 0 warnings
bun test                   10404 pass, 4 skip, 0 fail (751 files)
```

The 4 skips are the opt-ins §6 names (live-k8s, live-docker ×2, the slow
real-socket keepalive); none is new.

**Unverified:** still no simulator/Metro run — the bundle fix is proven by the
source guard (the exact class of failure: a `node:` specifier in the phone's
import graph), not by `expo export`. To verify for real: `cd apps/mobile && bunx
expo export --platform ios` (needs the native toolchain), which is what the guard
stands in for in CI.

### Round 2

*— claude-opus-5-5, 2026-11-15* (fresh context; reviewed `git diff HEAD~1`, commit `347bf2d3`)

**Verdict: REQUEST-CHANGES (doc only — every code finding is fixed).**

**Gate:** `bun run typecheck` clean; `bun run lint` clean (1444 files); the 9 touched test files: 104 pass / 0 fail. I did not re-run the full `bun test`.

**Round-1 findings, each verified by mutation (then reverted; `git status` clean):**

| # | Re-check | Result |
|---|---|---|
| F1 HIGH | `switch-off.ts` re-run: `on B: feed false \| B link false`. Mutation: `sync` without `force` | 3 red (link + 2 feed tests) — **fixed** |
| F2 HIGH | Mutation: put `node:os` back in `remote-client.ts` | `node-builtins-guard` red — **fixed** (proven by a source scan, not by an `expo export`) |
| F3 MEDIUM | Mutation: drop the `auto_accept` gate; then, separately, the `noteAutoAccept` gate | the pod-claim test fails on each — **fixed** |
| F4 MEDIUM | Mutation: own-turn test back to `undefined` in `permission-sheet.ts` | "an ask with NO turn id always reaches a person" red — **fixed** |
| F5 MEDIUM | see 1 below | **not fixed** |

**Findings:**

1. **MEDIUM (process, AGENTS §10): the signature still does not match the commit.** "Fix round 1" is signed `claude-opus-5-5, 2026-11-16`, but its commit `347bf2d3` says `review round 1 (deepseek)`. The same section claims F5 is fixed ("signed by the model that actually did the work"). One of the two records is wrong. Fix: sign the section with the model that executed it.

**Regressions checked on the diff, none found:** forcing the first snapshot fires once, a re-attach that changes nothing stays silent, and a snapshot is never announced as another device's flip. `hostLabel` reaches the wire only with the trust bit (the test fails without that check). The phone's `clientInfo` matches the schema regex. An older paired-computer record without `thisDeviceName` still loads. Nit, below MEDIUM: the phone's `clientInfo.version: "0"` would show as `tentacle-app 0` in a version-mismatch message (`daemon/src/version-mismatch.ts:73`).

### Fix round 2

*— claude-opus-5-5, 2026-11-15*

Scope: Round 2's one open HIGH/MEDIUM (finding 1, the signature record) plus the
root cause it exposed. Round 2 re-verified F1–F4 by mutation and found them
fixed, so no code changed this round.

**F1-of-round-2 (MEDIUM, AGENTS §10) — the signature did not name the model that
wrote the section. FIXED, with the cause removed.**

*Root cause, and why it survived two rounds:* §10 asks the signature to name the
model so the different-model check is readable, and there were **two** defects,
not one. `### Fix round 1` was signed `claude-opus-5-5, 2026-11-16` — the
*reviewer's* id and a date one day after the round ran (commit `347bf2d3`,
2026-11-15 07:02 +0100). And `## Execution`, corrected in Fix round 1, was signed
`deepseek` — the model FAMILY, not an id. Round 1 fixed the string that was
pointed at and left both the family name and the mechanism that produced the
wrong string, so the same class came back.

*Which record is the truth.* Not the commit subject: `night-task.sh`'s fix loop
calls `commit "fix($SLUG): review round N (deepseek)"` for **every** fix round —
the string is hard-coded, so it can never disagree with itself and is no evidence
either way (the same finding `docs/feat/app-decomposition.md:1149` records). The
orchestrator's own run log is the record of which executor path took the step:

```
$ grep -n "deepseek done\|opus .* done" ~/.tentacle/tmp/orchestration/runs/night-session-auto-accept.log
04:43 deepseek done: …        ← exec
06:18 opus new on personal …  ← review round 1
07:02 deepseek done: …        ← FIX ROUND 1
07:04 opus resume on personal ← review round 2
```

So fix round 1 was the `ds()` path (`~/bin/tentacle --profile deepseek`), whose
model is `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`
(`~/.config/tentacle/config.jsonc`, the id `device-pairing.md` and
`app-decomposition.md` sign that executor with); the reviews were opus. Both
sections are now signed with the real id and the real date, and the correction
note states which artefact it rests on and that the commit subject is not one.

*This round's own signature is honest about the same trap:* fix round 2 was
executed by `claude-opus-5-5` (this section), while its commit subject will read
`(deepseek)` — the two disagree, and the doc says so rather than restating the
subject.

*Red first (§9).* `.tentacle/tmp/session-auto-accept/sig-check.ts` reads the doc,
the run log and the commit, and exits 1 on the property:

```
BEFORE: run log: fix round 1 went through the deepseek executor: true
        Fix round 1  : "claude-opus-5-5" 2026-11-16
        Execution    : "deepseek" 2026-11-15
        RED: - Fix round 1 (line 585) is signed "claude-opus-5-5" — the executor was
               deepseek (rits/deepseek-ai/DeepSeek-V4.1-Flash-1017)
             - Fix round 1 (line 585) is dated 2026-11-16 — that round ran on 2026-11-15
             - Execution (line 425) is signed "deepseek" — a model FAMILY is not an id
AFTER:  Fix round 1  : "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017" 2026-11-15
        Execution    : "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017" 2026-11-15
        GREEN: both sections name the model that wrote them
```

*A permanent guard, so the class cannot come back a third time:*
`scripts/test/session-auto-accept-signatures.test.ts` (new) is the doc-local
version of `scripts/test/task-doc-signatures.test.ts` — the repo-wide check is
not widened because 162 exec+review pairs across `docs/feat` + `docs/fix` name
one model (measured; that class needs its own `fix/` task, and `main` would go
red). It asserts every executed section names its author's real id and date, that
no signature stops at a family name, and that the two models are still told apart
(so a future round cannot make the record unreadable by re-signing everything to
one id). Its expectations are the ids, **not** the commit subjects, for the
reason above.

*Red first, on the pre-fix doc* (`git show HEAD:… > doc-prefix.md`, the guard
pointed at that copy — 2 pass / 2 fail):

```
- "line 425 "Execution": "deepseek", want rits/deepseek-ai/DeepSeek-V4.1-Flash-1017",
- "line 585 "Fix round 1": "claude-opus-5-5", want rits/deepseek-ai/DeepSeek-V4.1-Flash-1017",
- "line 585 "Fix round 1": dated 2026-11-16, ran 2026-11-15",
(fail) … each names its author's real id — never another model's, never a family name
(fail) … no signature stops at a model family (an id is a slug, not a vendor name)
 2 pass / 2 fail        [after the fix: 4 pass / 0 fail]
```

*Mutation (run, then restored by hand — no `git`; doc md5 `2cc1bc52…` before and
after every one):* **M-1**, re-sign `### Fix round 1` back to `claude-opus-5-5` →
1 fail, naming `line 592 "Fix round 1": "claude-opus-5-5"`. **M-2**, re-sign
`## Execution` back to `deepseek` → 3 fail (the family-name test, the id test,
and "the two models are told apart"). **M-3**, sign `### Fix round 2` `deepseek`
instead of the id that executed it → 2 fail, naming `line 731 "Fix round 2":
"deepseek"`. **M-4**, re-sign all three to `claude-opus-5-5` → 2 fail, including
"the two models are told apart" (`ids.size` 1 ≠ 2), which is §10's
different-model check itself.

| # | Mutation | Result |
|---|---|---|
| M-1 | `### Fix round 1` → `claude-opus-5-5` | 1 fail: id test, names line 592 |
| M-2 | `## Execution` → `deepseek` | 3 fail: family-name + id + told-apart |
| M-3 | `### Fix round 2` → `deepseek` | 2 fail: id test, names line 731 |
| M-4 | all three → `claude-opus-5-5` | 2 fail: id test + told-apart (`ids.size` 1) |

Gate (`bunx tsc --noEmit`; `bun run lint`; `bun test`):

```
bunx tsc --noEmit     clean
bun run typecheck     clean (also apps/mobile + apps/relay)
bun run lint          1445 files, 0 errors, 0 warnings
bun test              10408 pass, 4 skip, 0 fail (752 files)
```

The 4 skips are the opt-ins §6 names (live-k8s, live-docker ×2, the slow
real-socket keepalive); none is new. The suite grew by exactly this round's 4
tests, and lint by exactly its one new file.

**Not fixed this round, and why:** everything Round 2 listed as a sub-MEDIUM nit
(the phone's `clientInfo.version: "0"` showing as `tentacle-app 0` in a
version-mismatch message) is left open — it is below the severity this round was
scoped to, and it belongs with the phone handshake. The `expo export` verification
of F2 in round 1 remains unrun (it needs the native toolchain; the source guard
stands in for it in CI).
