# feat/session-auto-accept — Auto-accept is the session's, shared by every client

> **Status:** implementation (plan written, **not approved** — owner questions open)
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

*— (pending)*

## Review

*— (pending)*

#### Orchestrator decisions (owner night delegation 2026-11-15)

Every owner question: the recommendation.
*— claude-opus-5-5 (orchestrator), 2026-11-15*
