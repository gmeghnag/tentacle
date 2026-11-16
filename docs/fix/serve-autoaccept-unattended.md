# fix/serve-autoaccept-unattended — `serve` answers asks itself while auto-accept is on

> **Status:** implementation (approved)
> **Branch:** `fix/serve-autoaccept-unattended`
> **Size:** M · **Blast:** load-bearing (permission path, §7 single-broker / pod-not-trusted) · **Suited:** Opus plan, DeepSeek exec, one Opus fresh-context review
> **Changelog:** `changelog.d/serve-autoaccept-unattended.fixed.md`

## Context

**Problem (owner report, 2026-11-16, live).** A phone session on the Mac `serve`
(session `de3ef43f…`, auto-accept ON in its sidecar) was told "open ANSA then
CNN". ANSA opened; the next call `mcp__playwright__browser_tabs` raised a
permission ask at 15:38:52 and the turn has been stuck since: the sidecar shows
`turn.pending: [{ tool: "mcp__playwright__browser_tabs", resumable: true }]`
with `autoAccept: true`. The phone app had been closed; no TUI attached.

**Root cause (design, not a code slip).** `docs/feat/session-auto-accept.md` D1
(owner Q1 at the time): "The daemon *holds and broadcasts* the state; it never
*answers* an ask with it" — each attached client's requester answers. So with
no client attached, auto-accept does nothing and the turn waits forever. The
owner expected (and wants) the opposite: closing the app must not stop an
auto-accepted session.

**Owner decision (2026-11-16, supersedes D1/Q1 for `serve` only).** On a `serve`
daemon (trusted: the user's own host) a session with auto-accept ON is answered
BY THE DAEMON, so it keeps running with no client attached.

**Constraints (binding).**
- Only `serve` (`startDaemon`). Pod daemons (`serve --stdio`, `run`/`attach`),
  the relay and the in-process worker NEVER answer on their own: the trust bit is
  set the same fail-closed way as `daemonWakes` / the persister (AGENTS §7 "a pod
  is not trusted"; a daemon-side check is UX on a pod, so the pod path must not
  gain any auto-answer).
- Same scope as the clients' auto-accept today: whatever a client's auto-accept
  would NOT answer (e.g. `hooks_trust` asks, `hooks-trust.ts:8`) the daemon does
  not answer either. One shared predicate, not a second copy of the rule.
- Covers: an ask raised while ON; asks already pending when it is switched ON;
  a pending ask re-raised on reload (`docs/feat/suspended-turn-resume.md`) with
  the restored value ON; wake/cron turns (`docs/fix/autoaccept-wake-turns.md`).
- Attached clients stay coherent: an ask the daemon answered is resolved for
  every client (no stale prompt on the phone/TUI), and is NOT also answered by a
  client (no double resolve). Log/persist as today's client-side auto-accept does.
- Single-broker invariant (§7) holds for the laptop TUI paths that are not `serve`.

*— claude-opus-5-5 (orchestrator), 2026-11-16*

## Implementation

*— claude-opus-5-5, 2026-11-16* · **APPROVED** (owner delegation, see Orchestrator decisions)

### Load-bearing assumption

> **Every ask a `serve` session raises — a person's turn, a wake/cron turn, a
> turn resumed after a reload, a background child — goes through ONE daemon-side
> requester (`awaitDecision` / `awaitBackgroundDecision`), and ONE synchronous,
> first-wins resolution point (`resolvePermission` → `settle`) answers it and
> tells every attachment.** So the daemon can answer an auto-accepted ask by
> calling that same resolution point with `allow_once`: no second decision
> path, no new wire shape, and a client's late identical answer is a no-op.

Proof (this tree):
- The session's broker requester is `awaitDecision`, installed once:
  `packages/daemon/src/hosted-session.ts:961`. A background child's ask branches
  to `awaitBackgroundDecision` (`:1100-1102`, `:1248-1286`).
- Wake and cron turns are started by the daemon through `HostedSession.prompt`
  on the same agent (`docs/fix/autoaccept-wake-turns.md` A2), so their asks
  reach the same gate. A reloaded turn re-runs in the constructor through
  `session.resume` (`:1068-1077`), "asked again through the normal requester"
  (`:1066-1067`). The restored value is set before that, at `:897`.
- Resolution: `resolvePermission` (`:1370-1389`) records the answer in
  `answered` (`:1387`) and then calls `settle`. `settle` (`:1396-1416`) deletes
  the ask, emits `permission_resolved` to every attachment and the ring when it
  was shown, and wakes the gate. A repeat of the SAME answer is a no-op success
  (`:1373-1375`). A different one is `PermissionNotPending` (`:1376`), which
  clients already treat as a lost race (`session-auto-accept.md` P3).
- `allow_once` is always offered, with that id (`permission-map.ts:26`).
- The predicate clients use is shared in `@tentacle/core`: `autoApproves`
  (`core/src/permission.ts:294-296`, never `hooks_trust`, `session_hop` only
  with `hopAuto`) and `ownRequest` (`:307-315`, no turn id ⇒ not mine).
- What exists today: the daemon holds `autoAccept` (`hosted-session.ts:643`) but
  `setAutoAccept` (`:2743-2751`) only persists and emits. Nothing in the ask
  path reads it (`rg -n autoAccept packages/daemon/src/hosted-session.ts` shows
  only `:343-347`, `:641-643`, `:897`, `:1543`, `:2745-2750`). That is the bug.

**Repro** (`/Users/gmeghnag/tentacle/.tentacle/tmp/serve-autoaccept-unattended/repro.ts`).
It runs a real `SessionHost{sharedAutoAccept:true}` (what `serve.ts:760` sets)
and a `Connection`. A scripted model calls one `permission: "ask"` tool. The
client turns auto-accept ON, prompts, then `session/detach`es (the phone app
closes).

```ts
await client.request("session/set_auto_accept", { sessionId: "S", on: true });
void client.request("session/prompt", { sessionId: "S", turnId: "t1", content: [{ type: "text", text: "go" }] });
await sleep(50);
await client.request("session/detach", { sessionId: "S" });
await sleep(300);
console.log(`tool ran: ${ran} -> ${ran === 0 ? "STUCK: …" : "answered"}`);
```

**Not executed by the planner.** Every `bun` invocation needed an approval this
session did not grant (`bun --version` included). The executor's FIRST step is
`bun run repro.ts` from that folder. Expected on this tree: `set_auto_accept ->
{"on":true}`, `updates seen: permission_request`, `tool ran: 0 -> STUCK`. After
the fix: `permission_request,permission_resolved`, `tool ran: 1`. Paste the real
output into Execution. If it does not print STUCK on this tree, STOP: the
assumption is wrong.

### Preconditions (verified)

- **P1: one resolution point, first wins.** See above (`:1370-1416`). A JS turn
  runs one handler at a time, so a daemon answer and a client answer are ordered.
- **P2: trust bits are host options, set fail-closed.** `sharedAutoAccept` is set
  in `serve.ts:760` AND `worker.ts:114`. `wakeOnJobExit` is set only in
  `serve.ts:773`, and only that reaches `HostedSession` (`session-host.ts:1426`).
  `podSessionHost` (`serve.ts:1252`) and `startStdioDaemon` (`:1338`) set
  neither. So `sharedAutoAccept` cannot be the gate, because the worker has it.
  This fix needs a NEW bit set only by `startDaemon`.
- **P3: `hooks_trust` never reaches `awaitDecision`.** On a daemon it is a
  separate client-bound RPC (`daemon/src/connection.ts:999`, `askHooksTrust`).
  The laptop builds the `kind: "hooks_trust"` request (`cli/src/hooks-trust.ts:187`),
  and a daemon ask carries no `kind` (`permission-router.ts:76-86`). The daemon
  still runs every ask through `autoApproves`, so the exclusion is the SAME rule,
  not an assumption.
- **P4: "pending on disk ⇒ never started"** survives an early answer. An answer
  settles through `decided.then`, which clears the record and awaits the write
  before the tool runs (`:1166-1185`). The daemon's answer takes that same path.
- **P5: an ask is shown only after it is durable** (`:1150-1165`, `ask.shown`).
  A background ask is shown at once (`:1269-1278`).
- **P6: archived reopen drops the value** (`session-host.ts:898`). Reload
  restores it (`hosted-session.ts:897`, sidecar `daemon-state-file.ts:417`/`:517`).
- **P7: `blockingUnsupported`** refuses an ask at once when clients are attached
  and none declared `permission_request` (`:1311-1321`). With nobody attached it
  holds the ask.

### Design

**D1: the trust bit.** Add `SessionHostOptions.answersAutoAccept?: boolean`
(`session-host.ts`, next to `sharedAutoAccept` `:274-280`). Doc comment: "a TRUST
bit: the daemon itself answers an auto-accepted ask. Only `startDaemon` (the
user's own host). Fails closed. Never the worker, a pod daemon or the relay."
Add a getter like `sharedAutoAccept` (`:495-497`) so tests can pin it. Pass it to
`HostedSession` as a constructor input: add `answersAutoAccept?: boolean` to the
`TurnErrorPolicy`-shaped object at `session-host.ts:1407-1410` (rename nothing).
Store it in a `private readonly answersAutoAccept: boolean` (`=== true`). It must
be a constructor input, not a property set after `new`. Reason: the resumed turn
starts inside the constructor (`:1068`). Its ask is reached only after awaits,
but a constructor input removes the ordering question. Set it in `serve.ts`
`startDaemon` beside `:760`, with a comment citing this doc. Do NOT set it in
`worker.ts`, `podSessionHost`, `startStdioDaemon` or the relay.

**D2: the one decision helper** (`HostedSession`, private, pure over its inputs):

```ts
/** The daemon answers this ask itself (docs/fix/serve-autoaccept-unattended.md):
 *  trusted host, the session's auto-accept ON, and the SAME rule a client's
 *  auto-accept applies (every turn of the session is "own" on a trusted daemon,
 *  session-auto-accept Q2; no turn id ⇒ not answered). */
private autoAnswers(req: PermissionRequest, turnId: string | undefined): boolean {
  return this.answersAutoAccept && this.autoAccept
    && autoApproves(req, ownRequest(turnId, () => true));
}
```

`autoApproves` and `ownRequest` come from `@tentacle/core`. Do not copy them.
`PendingAsk` gets `readonly req: PermissionRequest` and `readonly turnId?: string`
so the toggle sweep (D4) re-applies the same helper. Store inputs, never a cached
boolean: the value is re-evaluated against `this.autoAccept` at answer time.

**D3: answer at raise.** Add `private autoAnswer(requestId)`: if
`this.asks.get(requestId)` exists, is `shown`, offers `allow_once`, and
`autoAnswers(ask.req, ask.turnId)` holds, call
`this.resolvePermission(requestId, "allow_once")`. Call it through
`resolvePermission`, never `settle` directly. That keeps `answered.remember`, so
a client's identical `allow_once` stays a no-op success.
- `awaitDecision`: call `this.autoAnswer(requestId)` right after `this.emit(update)`
  inside the `persisted().then` callback (`:1159-1164`). That is after the ask is
  durable and shown. The turn id is `this.activeTurnId` at raise.
- `awaitBackgroundDecision`: call it right after its `emit` (`:1274-1278`). The
  turn id is `spawnTurn` (`:1262`). Without one, no answer, as on a client.
- Every client sees `permission_request` and then `permission_resolved{selected,
  allow_once}`, in seq order and in the replay ring. That is exactly the pair a
  client's own auto-answer produces, so every open prompt is withdrawn
  (`permission-router.ts` `resolved()`) and a re-attach shows no stale ask
  (`state.pending` is built from `asks`, which no longer holds it).
- `blockingUnsupported` (P7): when `autoAnswers(req, turnId)` holds at raise,
  skip the refusal (OD5). An ask the daemon answers needs no client.

**D4: toggle ON with asks pending.** In `setAutoAccept`, after the existing
`persist()` + `emit(auto_accept)` and only when it changed to `on === true`,
sweep `for (const id of [...this.asks.keys()]) this.autoAnswer(id)`. Each client
sees `auto_accept` before the `permission_resolved`s (seq order). An ask not
yet `shown` is answered by its own D3 call when it is shown, since D3 reads the
live value.

**D5: reload / wake / cron.** No new code. The restored value is set at `:897`,
before the resumed turn re-asks (`:1069`) through D3. Wake and cron turns use
the same gate. An archived reopen starts OFF (P6), so it is not answered.

**D6: no protocol, client or app change.** Clients keep their own auto-answer.
With the daemon answering first in the same synchronous step as the emit, a
client's requester that also answers `allow_once` gets the no-op success. An
older client sees the same request/resolved pair as today. No `PROTOCOL_VERSION`
note.

**D7: superseded doc.** `docs/feat/session-auto-accept.md` D1 gets one line:
superseded for `serve` by this doc. Done in this planning commit.

### Files (dependency order)

1. `packages/daemon/src/session-host.ts`: `answersAutoAccept` option + getter.
   Pass it into the `HostedSession` constructor at `:1407-1410`.
2. `packages/daemon/src/hosted-session.ts`: constructor field;
   `PendingAsk.req/turnId` (`:259`), set in `registerAsk` callers; `autoAnswers`,
   `autoAnswer`; the calls in `awaitDecision` (`:1159-1164`) and
   `awaitBackgroundDecision` (`:1274-1278`); the `blockingUnsupported` skip
   (`:1118`, `:1257`); the sweep in `setAutoAccept` (`:2743-2751`). Import
   `autoApproves`, `ownRequest` from `@tentacle/core`.
3. `packages/cli/src/serve.ts`: `answersAutoAccept: true` in `startDaemon` (`:760`).
4. Tests (below). `changelog.d/serve-autoaccept-unattended.fixed.md`: `- **A
   \`serve\` session with auto-accept on keeps running with no app or terminal
   attached.** The computer answers its permission asks itself (allow once
   only), as a device would; pod sessions are unchanged.`
5. This doc's Execution.

### Failure modes

- **Pod / worker / relay never auto-answer.** The bit is set only in
  `startDaemon`. Every other host leaves it undefined → `false`. The laptop gate
  for pod effects is unchanged (§7: a daemon-side check is UX on a pod; this
  adds none there). Pinned by the getter tests and the worker-shape test (T2).
- **Double resolve with an attached client.** The daemon answers in the same
  synchronous step as the emit, so no client can answer first at raise. A
  client's `allow_once` → `isRepeat` no-op success. A client's `reject_once` or
  `allow_always` arriving after → `PermissionNotPending` (lost race, handled).
  During the toggle sweep a client may win first. Then `asks` no longer holds the
  ask, `autoAnswer` finds none and does nothing. First wins either way. Never two
  `permission_resolved`.
- **Toggle ON with pending asks:** D4. **Toggle OFF:** nothing to undo. Answers
  already given stay given, as on a client.
- **Reload with a pending ask:** D5. Restored ON → re-asked and answered, and the
  tool runs once (P4). Restored OFF or archived reopen → waits as today.
- **`hooks_trust` / `session_hop`:** excluded by `autoApproves` (D2), and never
  raised through this gate anyway (P3).
- **Ask cancelled before it is shown** (Esc between write and emit): `asks` has
  none → no answer. **Session closed:** `setAutoAccept` asserts known (`:2744`).
- **Hung disk:** the answer waits for `persisted()` like the emit itself. A
  cancel still interrupts (`:1185`).
- **Never a lasting approval:** only `allow_once`. No rule is written to the
  daemon's `PermissionRuleStore`.
- **Steering window / RPC concurrency:** no new await in a `Connection` handler.
  `setAutoAccept`'s sweep is synchronous.
- **Old client attached, no `permission_request` declared:** D3 skips the
  refusal and the daemon answers (OD5). It gets the request/resolved pair as
  display.
- **Single broker (§7):** the laptop paths (worker, `connect`, pod) are
  untouched. The single-broker regression test must stay green unchanged.

### Tests (red first; each names its mutation)

New `packages/daemon/test/serve-autoaccept-unattended.test.ts`. Use the
`SessionHost` + `Connection` harness of `session-auto-accept.test.ts:41-80`, a
`ScriptedProvider` like `history-validity-daemon.test.ts:28-37`, and an `askme`
tool with `permission: "ask"` that counts runs.

| # | Case | Red on today's code? | Mutation that must turn it red |
|---|---|---|---|
| U1 | bit on, ON, client detaches before the ask → tool ran once; ring has `permission_request` then `permission_resolved{allow_once}`; a re-attach's `state.pending` is empty | red (pending) | drop the `autoAnswer` call in `awaitDecision` |
| U2 | worker shape (`sharedAutoAccept:true`, no `answersAutoAccept`) → still pending after settle | green (guard) | default `answersAutoAccept` to `true`, or key it on `sharedAutoAccept` |
| U3 | bit on, OFF → pending | green (guard) | drop `this.autoAccept` from `autoAnswers` |
| U4 | bit on, OFF, ask pending, then `set_auto_accept on` → answered; `auto_accept` seq < `permission_resolved` seq | red | drop the D4 sweep |
| U5 | bit on, ON, client attached whose requester answers `allow_once` → `resolve_permission` resolves (no error), tool ran once; a second client's `reject_once` → `PermissionNotPending` | red (tool never ran: no client answers in this harness unless told) | call `settle` instead of `resolvePermission` in `autoAnswer` (then U5's `allow_once` gets `PermissionNotPending`) |
| U6 | a `kind:"hooks_trust"` request and a `session_hop` without `hopAuto`, pushed through the session's broker (`permissions.request(req,{turnId})` from the captured `createAgent`) → not answered | green (guard) | replace `autoApproves(req, own)` with `own` |
| U7 | background child ask with a spawn turn → answered; with none → pending | red (first half) | pass `undefined` as the turn id |
| U8 | reload: a persisted pending resumable ask + sidecar `autoAccept:true` → the reloaded session runs the tool exactly once; the same with `reopen` of an archived record → pending. Use the pattern of `session-auto-accept-persist.test.ts` + the suspended-turn reload tests | red (first half) | ignore `restored.autoAccept` at `:897` |
| U9 | wake turn with nobody attached (harness of `serve-autowake.test.ts:25-40`) asks → answered | red | drop the `autoAnswer` call (same as U1) |
| U10 | an old client attached (no `permission_request` declared), ON → answered, not refused | red (refused today) | remove the `blockingUnsupported` skip |

**Real serve RPC path:** new `packages/cli/test/serve-autoaccept-unattended.test.ts`.
`startDaemon` with an injected scripted model, following the seams of
`packages/cli/test/serve-push.test.ts` / `connect-resume-main.test.ts`. A real
WebSocket client opens, sets ON, prompts, closes its socket. Then poll: a second
client's `session/open` shows the turn ended and no pending ask, and the tool
ran once. Red today. **Mutation:** delete `answersAutoAccept: true` from
`serve.ts` → red. Plus getter pins in the same file: the `SessionHost` built by
`podSessionHost` and by the worker host factory (`worker.ts`) report
`answersAutoAccept === false`. **Mutation:** add it to `podSessionHost` → red.

U2, U3 and U6 are guards: green on today's code, because nothing auto-answers
at all. Their non-vacuity is shown by the named mutation AFTER the fix. Record
it as such in Execution (§9). Gate: `bun run check`, lint baseline 0/0.

#### Orchestrator decisions

*Owner delegated (2026-11-16): each open question takes the recommended option.*
- **OD1: serve only, not the worker.** A worker session lives inside its TUI's
  process and is never unattended. Answering there would add a second
  in-process decision point beside the TUI's requester (the single-broker
  concern) for no gain. New bit `answersAutoAccept`, not `sharedAutoAccept`.
- **OD2: answer AFTER the ask is durable and shown,** not silently before. Every
  device sees the request/resolved pair: the same visibility as a client's
  auto-answer, and the same disk discipline (P4).
- **OD3: background-child asks are answered when they carry a spawn turn.** This
  mirrors the client rule exactly (`ownRequest`). Without a turn they wait.
- **OD4: no wire change** (no `auto` marker on `permission_resolved`). Clients
  keep their own auto-answer, and a repeat is a no-op (P1). An "answered by the
  computer" label can be a later display-only follow-up.
- **OD5: an ask the daemon will answer is not refused by `blockingUnsupported`.**
  It needs no client.

*— claude-opus-5-5 (planner, on owner delegation), 2026-11-16*

## Execution

*— claude-opus-5-5, 2026-11-16*

### Load-bearing check (re-run first, as instructed)

`bun run repro.ts` from `.tentacle/tmp/serve-autoaccept-unattended/` on this tree **before any
edit** (a real `SessionHost{sharedAutoAccept:true}` + a `Connection`; the client sets ON, prompts,
`session/detach`es — the phone app closing):

```
set_auto_accept -> {"on":true}
updates seen: permission_request
tool ran: 0 -> STUCK: nobody answers the ask
```

Exactly the plan's expected output → the assumption holds: one requester, one resolution point.
After the fix (same script, `answersAutoAccept: true` added to the host):

```
set_auto_accept -> {"on":true}
updates seen: permission_request,permission_resolved
tool ran: 1 -> answered
```

### As built, in dependency order

1. **`packages/daemon/src/hosted-session.ts`**
   - `TurnErrorPolicy` (`:524-533`) gains `answersAutoAccept?: boolean`, with the doc comment
     saying why it rides this bag: it must be known at CONSTRUCTION (a reload's resumed turn
     re-asks inside the constructor) and this is the constructor input every host already passes.
     Stored as `private readonly answersAutoAccept: boolean` (`:729-734`), set `=== true`
     (`:924`).
   - `PendingAsk` (`:261-272`) gains `readonly req: PermissionRequest` and `readonly turnId?`,
     set by `registerAsk` (which takes both as new parameters, `:1248-1267`); its two callers pass
     the live ask's inputs: `awaitDecision` → `(req, this.activeTurnId ?? undefined)`,
     `awaitBackgroundDecision` → `(req, spawnTurn)`.
   - `autoAnswers(req, turnId)` (`:1423`): `answersAutoAccept && autoAccept &&
     autoApproves(req, ownRequest(turnId, () => true))` — `autoApproves`/`ownRequest` imported
     from `@tentacle/core`, never copied.
   - `autoAnswer(requestId)` (`:1444`): only an ask that exists, is `shown` and offers
     `allow_once`, and only when `autoAnswers` holds; answers through `resolvePermission`, never
     `settle`.
   - Called right after the emit in `awaitDecision`'s `persisted().then` (`:1207`) and in
     `awaitBackgroundDecision` (`:1328`).
   - The `blockingUnsupported` refusal is skipped when `autoAnswers` holds, in BOTH gates
     (`:1151`, `:1304`) — and `recheckAsks` (`:1400-1410`) skips such an ask too, so a detach/attach
     in the window before the emit cannot refuse one the daemon was going to answer.
   - `setAutoAccept` (`:2846-2860`): on a change to `true`, after `persist()` + `emit(auto_accept)`,
     sweeps `[...this.asks.keys()]` through `autoAnswer`.
2. **`packages/daemon/src/session-host.ts`**: `SessionHostOptions.answersAutoAccept?` (`:283-290`),
   getter `answersAutoAccept` (`:513`, `=== true`), and the constructor wiring at the
   `HostedSession` `TurnErrorPolicy` object (`:1430`) — conditional spread, so an unset option adds
   nothing.
3. **`packages/cli/src/serve.ts`**: `answersAutoAccept: true` beside `sharedAutoAccept: true` in
   `startDaemon` (`:766`). Not in `worker.ts`, `podSessionHost`, `startStdioDaemon` or the relay.

**One small addition beyond the Implementation's site list**, in the same rule as OD5: `recheckAsks`
also skips an ask `autoAnswers` holds. Before the fix the question could not arise; now it can —
a detach/attach changing the attached set in the window between the ask's registration and its
emit would settle it `cancelled` with "client does not support permission_request", a refusal for an
ask nobody needed to answer. No test covers that window (it is a one-tick race); the change is a
guard for it, not a behaviour the tests pin.

Otherwise **no drift from the Implementation.** No protocol/schema change (D6/OD4 held), so
`packages/protocol/schema/protocol.json` is untouched and no `protocol.d/` note is needed. D7 was
already done in the planning commit.
`changelog.d/serve-autoaccept-unattended.fixed.md` added with the plan's bullet.

### Tests (red first; each named mutation run and pasted)

`packages/daemon/test/serve-autoaccept-unattended.test.ts` (13 tests) and
`packages/cli/test/serve-autoaccept-unattended.test.ts` (2 tests, the real `startDaemon` WebSocket
path + the host-getter pins). Cases: U1, U2, U3, U4, U5, U6 (+ U6b, a real out-of-band ask through
the session's broker during a live turn), U7, U8 (+ U8b archived reopen), U9, U10, U11 (RPC), the
CLI end-to-end, and the pod/worker getters.

**Mutation results** (`sh .tentacle/tmp/serve-autoaccept-unattended/mutate.sh`, each mutation
applied to the real file, the named tests run, the file restored with `cp` — never git; final
`diff -q` reported `clean`):

| # | Mutation | Result |
|---|---|---|
| M1 | drop `autoAnswer` in `awaitDecision` | U1, U5, U8, U9, U10, U11 red (6 fail) |
| M2 | `answersAutoAccept !== false` (default on) | U2, U7, U10, U8, U8b red |
| M3 | drop `this.autoAccept` from `autoAnswers` | U3, U4 red |
| M4 | drop the D4 sweep in `setAutoAccept` | U4 red |
| M5 | `settle` instead of `resolvePermission` in `autoAnswer` | U5 red |
| M6 | `ownRequest` only, no `autoApproves` | U6 red — and, re-run after U6b, **both U6 and U6b** red |
| M7 | no turn id for a background ask | U7 red |
| M8 | ignore `restored.autoAccept` | U8 red |
| M9 | no `blockingUnsupported` skip | U10 red |
| M10 | delete `answersAutoAccept: true` from `startDaemon` | the CLI end-to-end test red |
| M11 | add `answersAutoAccept: true` to the pod host | the CLI pod/worker getter test red |

U2, U3, U6 are guards (green before the fix — nothing answered at all then); their non-vacuity is
exactly the M2 / M3 / M6 rows above, showing each red after the fix (§9).

**Red before green, on the property**: on the unmodified tree the same fixtures hang — the repro
above prints `STUCK`, and U1's `until(() => !hosted.running)` times out. The remaining red-first
evidence is the mutation table, taken after the fix, which is what §9 asks for a guard.

### Gate

`bunx tsc --noEmit` (+ `apps/mobile`, `apps/relay`) — clean · `bun run lint` — clean (0 errors,
0 warnings, the AGENTS §6 baseline) · `bun test` — **12752 pass, 5 skip, 0 fail** (12757 across 910
files; the 5 skips are the opt-in live/slow ones, §6 — none is in a file this task touches).
Narrow files during iteration: the two new ones plus `session-auto-accept`,
`session-auto-accept-persist`, `persistence`, `subagent-background`, `serve-autowake`,
`parallel-agents` — all green.

### Unverified, stated plainly

- The `recheckAsks` skip has no test (a one-tick detach/attach race); it is reasoned from
  `attach`/`detach` both calling `recheckAsks`, not measured. Verify by attaching an
  old client and detaching it inside the same tick as a raise.
- The `serve` end-to-end test uses the fake OpenAI endpoint's `shell` tool with `echo hello`; it
  exercises the real WebSocket daemon, not a real `mcp__playwright__` ask. The requester path is the
  same one (`permissionOptions` offers `allow_once` for every ask), so this is a fidelity note, not
  a gap in the property.

### Fix round 1

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-16*

**State found.** `## Review` was empty on this branch, and the three Review rounds
committed to the *dropped* 401 session (`a6a35eef`/`4809ec62`/`9c3c5c55`, not in
this branch's history) reviewed a tree with **no implementation at all**: their
single HIGH was "nothing is implemented". Execution (`8b18c342`) landed after
them, so that HIGH was closed by the code, not by a fix round. Both halves are
recorded below: the closure of that HIGH (F1) and the one real defect the
adversarial pass over the executed diff turned up (F2).

**F1 — HIGH "no implementation" (dropped rounds 1–3): FIXED, verified.** The
property holds on this tree: the repro (`repro.ts`) still prints `STUCK` on the
WORKER shape (correct fail-closed: `sharedAutoAccept` only), and with the serve
shape (`repro-serve.ts`, `answersAutoAccept: true` added) prints
`updates seen: permission_request,permission_resolved` / `tool ran: 1 ->
answered`. The 14 daemon tests and 2 CLI tests pass. I re-ran the mutation table
independently (`mut-fix1.sh`, cp-based, never git; worktree clean after):

```
M1  drop autoAnswer in awaitDecision      -> 7 red (U1,U5,U6b,U8,U9,U10,U11)
M2  trust bit defaults ON                 -> 5 red (U2,U7,U8,U8b,U10)
M3  drop this.autoAccept                  -> 2 red (U3,U4)
M4  drop the D4 sweep                     -> 1 red (U4)
M5  settle not resolvePermission          -> 1 red (U5)
M6  ownRequest only, no autoApproves      -> 2 red (U6,U6b)
M7  background ask without its turn       -> 1 red (U7)
M9  no OD5 skip                           -> 1 red (U10)
M10 serve bit off                         -> 1 red (CLI end-to-end)
M11 pod host answers too                  -> 1 red (CLI pod/worker getters)
```

Every row reproduces as the plan claims. One correction to the plan's table:
the doc's M7 line names the wrong site — the mutation that actually reddens U7 is
`registerAsk(..., req, undefined, ...)` in `awaitBackgroundDecision`
(`:1334`), not the update's `turnId` field. Noted, not a code defect.

**F2 — HIGH (found here): the OD5 skip was decided only at RAISE, so a toggle
mid-write could hang an ask forever. FIXED.**
- *Defect*: OD5 skips the `blockingUnsupported` refusal by reading `autoAnswers`
  at raise (`:1150`), while the answer reads it again, later, when the ask is
  shown (`autoAnswer`, `:1468`). `setAutoAccept(false)` landing in between (the
  `persisted()` write window) inverts the two: the ask is registered with the
  refusal skipped, then shown to a client that cannot display
  `permission_request` (an old client) and never answered, because this host no
  longer auto-accepts. Pre-fix such an ask was refused with a reason the model
  sees; after `8b18c342` it suspends forever — the exact stall
  `blockingUnsupported` exists to prevent (`docs/feat/protocol-v10-forward-compat.md`).
  Reachable on a `serve` with an older phone/TUI attached and auto-accept toggled
  from another device while an ask's write is in flight.
- *Repro* (`.tentacle/tmp/serve-autoaccept-unattended/probe-toggle-off.ts`,
  real `SessionHost`, `SpyDaemonStore{hold}`, one old client, ON → OFF inside the
  write window): before — `running: true  toolRan: 0` / `HANG: still waiting,
  nobody can be shown it`; after — the turn ends.
- *Fix*: re-decide the skip where the ask is actually shown, against the same
  live value the answer will use, and refuse with `blockingUnsupported`'s reason
  (`hosted-session.ts:1205-1214`); the raise-time skip stays as the cheap early
  exit, with its comment updated (`:1147-1156`).
- *Test*: R1 (`packages/daemon/test/serve-autoaccept-unattended.test.ts:570-619`),
  **red first on the property** (`error: timed out: () => !hosted.running`,
  a hang, not a compile/import error), green after.
- *Mutation of the fix* (MR1, revert only the show-time re-decision): `R1` red
  (`13 pass  1 fail`), everything else green — the fix is non-vacuous.
- *Checked, not changed*: `awaitBackgroundDecision` shows its ask synchronously
  (`:1334-1339`), so it has no such window. The reverse race (OFF at raise, ON in
  the window) still produces the pre-fix outcome (refused, tool never ran,
  `probe-toggle-on.ts`) — unchanged behaviour, no regression.

**Drift from Implementation:** one guarded site added, outside its file list:
the show-time re-decision above. It is the same OD5 rule the plan asked for, at
the second point the value can disagree. No protocol/schema change; no new trust
bit; nothing set on the worker, `podSessionHost`, `startStdioDaemon` or the relay.

**Gate.** `bunx tsc --noEmit` clean (+`apps/mobile`, `apps/relay`) · `bun run lint`
clean (0 errors, 0 warnings — the §6 baseline) · `bun test` **12753 pass, 5 skip,
0 fail** (12758 across 910 files; the 5 skips are the opt-in live/slow ones, §6).
That is the exec's 12752 + R1. Narrow files during the fix: the two new ones plus
`session-auto-accept`, `session-auto-accept-persist`, `serve-autowake`,
`persistence`, `push-notifier` — 164 pass, 0 fail.

## Review
