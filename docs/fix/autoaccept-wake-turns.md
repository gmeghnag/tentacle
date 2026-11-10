# fix/autoaccept-wake-turns — Auto-accept answers the session's own wake turns; the drawer shows a message's read state

> **Status:** implementation
> **Branch:** `fix/autoaccept-wake-turns`
> **Type:** fix · **Size:** S–M · **Blast:** load-bearing (permission gate) · **Suited:** DeepSeek exec, one fresh Opus review

This branch fixes two `TODO.md` items: `fix/autoaccept-wake-turns` (part A, load-bearing)
and `fix/subagent-message-read-state` (part B, contained).

## Context

*— claude-opus-5-5, 2026-11-10*

**A. Auto-accept ignores wake turns (owner, live, `connect` to a `serve` daemon).**
After a background sub-agent finished, the agent's wake turn kept showing
permission prompts (`Run a shell command … Yes / Yes, and don't ask again …`),
even though the TUI showed `⏵⏵ auto-accept on`.

Cause, verified in code and by the repro below:
- On `serve`, the daemon is the only waker. It starts the continuation turn with
  its own id, `wake-${crypto.randomUUID()}` (`daemon/src/hosted-session.ts:2360`).
- Auto-accept answers only asks whose turn this TUI minted:
  `autoApproves(req, own)` (`tui/src/permission-ui.ts:53-55`), with `own` from
  `ownRequest(turnId, ownsTurn)` (`:62-70`, `:329`).
- `RemoteSession.ownsTurn` only knows minted ids (`client/src/remote-session.ts:263-269`).
- So every ask of a wake turn is treated as another device's, and so is every
  ask of a background child that the wake turn spawned (`hosted-session.ts:667`, `:929-932`).

The foreign-turn rule (`docs/feat/tui-foreign-turns.md` C5, owner Q3) guards
against another device's turn. It was never meant to cover the session's own
wake.

**B. The drawer never shows that a message was read (owner, live).** The open
sub-agent drawer keeps `you → sa-1 che stai facendo? · read before its next step`
after the child has read the message, even when `agent_control status` already
says `0 unread`. The user cannot tell "not delivered" from "delivered and
ignored". The suffix is a constant (`tui/src/background-list.ts:575`, `:583`).
No read state reaches the client: `SubagentRow` has no such field
(`protocol/src/session.ts:428-453`), and `subagent_message` carries only
`{agentId, text}` (`protocol/src/updates.ts`, `SubagentMessageUpdateSchema`).

**Constraints:** AGENTS §7: one broker; a pod is not trusted, so the gate sits
on the laptop and a daemon-side check is UX only; a pod-originated prompt never
creates a lasting approval; the protocol is shared truth, versioned honestly.

**Repro** (2026-11-10, `/Users/gmeghnag/tentacle/.tentacle/tmp/autoaccept-wake/`).
The scripts import `../../../packages/…`, which is the main checkout: this
worktree has no `node_modules`. Main was this branch's base, `8a77ffe`. Run with
`bun run repro.ts` and `bun run forge.ts` from that folder.

`repro.ts` runs a real `startDaemon` (serve, `autoWake` default on) and the real
`connectTui`, with a fake `startTui`. Its requester decides exactly as
`usePermissionBroker` does with auto-accept ON. The fake model answers: 1 = a
background `sleep 0.3`, 2 = "started", 3 (the wake) = `echo woke`, 4 = "done".

```ts
opts.permissions.setRequester((req, o) => {
  const own = ownRequest(o?.turnId, (t) => session.ownsTurn(t));
  const auto = autoApproves(req, own);
  log.push(`ask turnId=${o?.turnId} tool=${req.tool} own=${own} auto-accepted=${auto}`);
  return auto ? Promise.resolve({ allowed: true, scope: "once" }) : new Promise(() => {});
});
for await (const _ of session.send("start the job")) {}
```
Output:
```
ask turnId=c3eed5d4-0f20-48bd-89d0-cfb09522fddd tool=shell own=true auto-accepted=true
ask turnId=wake-7a202134-1ef8-48e0-8271-18fb79bdafd8 tool=shell own=false auto-accepted=false
RESULT: model requests=3; the wake turn's ask was NOT auto-accepted (held for a human)
```

`forge.ts` is a raw WebSocket client to the same `serve`. It sends
`session/prompt{turnId: "wake-forged-by-a-client"}`:
```
prompt reply: {"jsonrpc":"2.0","id":3,"result":{"turnId":"wake-forged-by-a-client"}}
turn_start ids: [ "wake-forged-by-a-client" ]
```
So today **any client can start a turn whose id looks like a wake**
(`TurnIdSchema` = any string of 1–128 characters, `protocol/src/session.ts:198`).
Part A must close that, or a recognised `wake-` prefix would let another
device's turn ride this TUI's auto-accept, which defeats C5.

## Implementation

*— claude-opus-5-5, 2026-11-10*

### Load-bearing assumption

> On a `serve` daemon, every ask raised in a daemon wake turn reaches the
> laptop's requester with `options.turnId` = the daemon-minted `wake-<uuid>`.
> That covers the turn's own calls and the calls of a background child it
> spawned. After this fix, no client can mint a `wake-` id on such a daemon.
> So `isWakeTurnId(turnId)` identifies exactly the session's own wakes, on a
> client that knows its daemon is a trusted `serve` host.

Part 1 is **proved**:
- The id is minted at `hosted-session.ts:2360`.
- Own calls: the router is called with `out.turn` (`client/src/remote-client.ts:2470`),
  and `update.turnId` wins if present (`client/src/permission-router.ts:121`).
- A background child is stamped with the spawning turn (`hosted-session.ts:667`
  `spawnTurns.set(agentId, this.activeTurnId)`, then `:929-932`).
- The id is handed to the broker as `turnId` (`remote-client.ts:3000-3003`).
- The repro printed `ask turnId=wake-7a20…`.

Part 2 is **false today** (`forge.ts`). This fix makes it true by reserving the
prefix daemon-side. On `serve` that check is security, not UX, because AGENTS §7
says the `serve` daemon is trusted.

### Preconditions

- **Only `serve` wakes daemon-side.** `wakeOnJobExit` is set only by `cli/src/serve.ts:206`
  (`session-host.ts:201-207`, `hosted-session.ts:314-325`). Pod daemons and the
  worker never pass it.
- **Pods and the relay mint their own wake turns.** The relay uses `relay.ts:205`, `:464`
  (`randomUUID`), and a TUI wakes through `send` (`remote-session.ts:900-902`
  mints). Those turns are already `own`, so wakes on pods/relay already work.
- **One broker (§7).** `connect` builds one `PermissionBroker` (`cli/src/connect.ts:150`)
  and passes it to both `RemoteClient` (`:176`) and `startTui`. This fix adds no
  broker and no requester.
- **First answer wins daemon-side.** Each ask is looked up, deleted, and
  `permission_resolved` is emitted before the gate wakes (`hosted-session.ts:1005`,
  `:1038-1055`). In every other client, `permission_resolved` withdraws the dialog
  (`permission-router.ts` `resolved()`). Also `docs/feat/tui-foreign-turns.md:638`.
- **Auto-accept is scope `once`.** `permission-ui.ts:331-332` and `:297`,
  `relay-policy.ts:62`. Nothing lasting is created; "always" rules live daemon-side.
- **An RPC ask is always a tool ask.** `toPermissionRequest` sets no `kind`
  (`permission-router.ts:76-86`). A hooks-trust question uses the separate
  `hooks/trust` resolver, which carries no `turnId`, so `autoApproves`'s
  `hooks_trust` exclusion and the "no turn ⇒ asked" rule (`permission-ui.ts:62-70`) stand.
- **`ownsTurn` is read only for permissions.** Callers: `App.tsx:670-671`,
  `local-runtime.ts:580-581`, `relay.ts:386`. It is left unchanged anyway, because
  "minted by me" is its documented meaning (`remote-session.ts:262`), and a
  wake turn stays foreign for everything else.
- **The read state already exists, with one source of truth.** `AgentInbox.pending`
  (`core/src/agent-inbox.ts:59-61`) feeds `AgentJobs.pending` (`core/src/agent-jobs.ts:500-502`),
  which is what `agent_control status` reports as unread. A text is "read" when it
  leaves the inbox through `drain()` (`:80-85`, used at `agent/src/subagent.ts:448-450`).
- **A message changes no row today** (`agent-jobs.ts:461`), and a drain fires no
  `changed()` (`:602`). So no `subagents` frame follows a read. `sameRows`
  (`daemon/src/subagents-view.ts:73-95`) also drops a frame whose only change is a
  member it does not compare.
- **An ended child's drawer keeps its last row** (`App.tsx:890-904`, `frozenAgent`).

### Design

**A1. Name the wake id once (protocol, the shared truth).** In `protocol/src/session.ts`,
next to `TurnIdSchema`, export:
- `WAKE_TURN_PREFIX = "wake-"`
- `isWakeTurnId(id: string): boolean`

The daemon mints with the constant (`hosted-session.ts:2360`). There is no
schema `.refine`: request schemas export to JSON Schema, and a refine there is a
risk for no gain.

**A2. Reserve the prefix daemon-side.** In `daemon/src/connection.ts`, `prompt`
(`:563`) and `sendNow` (`:574`) throw an `RpcError` `InvalidParams` when
`isWakeTurnId(params.turnId)`:
`"turnId: the \"wake-\" prefix is reserved for the daemon's own wake turns"`.

These are the only client methods that mint a turn. `enqueue` and `cancel` name
an existing turn, and steering or stopping a wake turn stays allowed.
`HostedSession.prompt` stays unguarded, because the daemon's own wake calls it
directly (`:2371`).

The check runs on every daemon (pods included). No client ever mints `wake-`:
every mint site is `randomUUID` (`remote-session.ts:900`, `:963`, `relay.ts:205`,
`:464`). So no real peer changes behaviour.

**A3. The laptop says which daemons wake on their own.** Add a `RemoteClientOptions`
field, `daemonWakes?: boolean` (`client/src/remote-client.ts:312-356`). It means:
"the daemon is a `serve` host, trusted (AGENTS §7), that starts its own wake
turns; their asks are this session's". The default is **off**. Do not key this on
`daemonKind`: it defaults to `"serve"` (`remote-client.ts:335`), and a trust bit
must fail closed.

Set it only in `connect.ts:176`. `local-runtime.ts:733` (the worker, pod
`run`/`attach`, and the relay through it) never sets it. Pass it down to every
`RemoteSession` that the client builds.

**A4. The session's own test.** Add to `RemoteSession`:
```ts
/** Auto-accept may answer an ask of this turn: one I minted, or (daemonWakes) the session's own wake. */
autoAcceptsTurn(turnId: string): boolean {
  return this.ownsTurn(turnId) || (this.daemonWakes && isWakeTurnId(turnId));
}
```
The test is stateless on the prefix, so a child that a long-ended wake spawned
is still answered. The bounded `mintedTurns` (`:271-287`) does not apply.

**A5. The TUI picks the widest test the session offers, and nothing else.** Add
to `App.tsx`'s session interface (next to `:345`):
`autoAcceptsTurn?(turnId: string): boolean`.

Move the lambda at `App.tsx:668-672` into a pure, exported helper in
`permission-ui.ts`:
```ts
export function autoAcceptTest(session: { ownsTurn?(t: string): boolean; autoAcceptsTurn?(t: string): boolean } | null | undefined)
  : ((turnId: string) => boolean) | undefined
// autoAcceptsTurn if present, else ownsTurn, else undefined (no session decides).
```
`App.tsx` calls `autoAcceptTest(sessionRef.current)`.

`usePermissionBroker` is unchanged in logic. Update its doc comments:
`autoApproves` (`:47-52`) and the `ownsTurn` param (`:205-211`) now say "own turn
or the session's own wake (trusted `serve` only)". The Shift+Tab path
(`applyAuto`, `:290-298`) reads `pendingOwnRef`, which `own` now sets, so turning
auto-accept on with a wake prompt already on screen grants it.

The `local-runtime.ts:580` wrapper exposes no `autoAcceptsTurn`, so pods fall
back to `ownsTurn`, exactly as today.

**A6. Several TUIs: every TUI with auto-accept ON answers, and the first answer wins.**
No new code: each attached `connect` TUI gets the `permission_request`. One with
auto-accept on answers `allow_once` at once; the daemon keeps the first answer
and withdraws the dialog everywhere else.

This is the recommendation because:
- it needs no daemon state or wire field;
- it matches how foreign-turn prompts already resolve;
- a wake belongs to the session, not to a terminal.

A TUI with auto-accept OFF may show the dialog briefly, until another TUI's
auto-answer withdraws it. That is the same UX as today's foreign turns.
Alternatives are in Owner questions.

**A7. A pod forging `wake-`.** A pod daemon controls its own tool execution:
approving a pod-side call "once" gives it nothing it could not do anyway.
Auto-accept never creates a lasting approval, and an RPC ask never has a laptop
effect (Preconditions). The laptop gate still fails closed: a pod client never
has `daemonWakes`, so a pod's `wake-` id is foreign there, exactly as today.

On `serve`, the trusted daemon refuses client-minted `wake-` ids (A2), so
another device cannot borrow this TUI's auto-accept. **No extra gate is needed.**

**A8. Relay parity (`cli/src/relay-policy.ts:56-57`).** There is no change in
behaviour. The relay exists only for detached pod runs, where no daemon wake
exists: the relay mints its own wake turns, which are `own`. The relay must not
trust a pod's `wake-` id, and it doesn't: it binds `session.ownsTurn`
(`relay.ts:386`), not `autoAcceptsTurn`. Add one sentence to the module comment
and a pin test (Tests T5).

**A9. Protocol: no `PROTOCOL_VERSION` bump.** Nothing on the wire changes shape:
- The client learns "wake" from the id the daemon already sends.
- A2 narrows the accepted input, but no existing peer produces that input.

Residual skew: a new `connect` with an old `serve` (no A2) would auto-accept a
hand-crafted `wake-` turn from another client of the same `serve`. That needs a
custom client against the user's own daemon, and gives one `once` approval in
that session. Accepted, as Owner question Q2.

**B1. Count reads in the inbox, per sender (`core/src/agent-inbox.ts`).**
- Items become `{text, from}` (the class stays synchronous).
- `push(text, from)` returns `{ok: true, index}`, where `index` is that sender's
  1-based cumulative count of accepted pushes.
- `drain()` and `closeIfEmpty()` add the user items they hand out to
  `read(from)`, a cumulative count. Both take items out of the inbox, which is
  the same "read" that `pending` and `agent_control status` use.
- `close()` does not count: those texts were never read, and the report says so
  (`subagent.ts:520-523`).
- A constructor option `onRead?: () => void` fires after a `drain`/`closeIfEmpty`
  that handed out at least one item.

**B2. `AgentJobs` (`core/src/agent-jobs.ts`).**
- The three `new AgentInbox()` sites (`:375`, `:408`, `:653`) pass
  `onRead: () => this.changed()`.
- `message()` (`:478-481`) passes `from` and returns `{ok: true, index}`.
  Widen `AgentMessageResult`, `:62-64`.
- `rows()` (`:286-300`) adds `userRead: entry.inbox.read("user")`. Add it to
  `AgentJobRow`, `:145`.

**B3. Wire (display-only, optional, no bump).**
- `SubagentRowSchema` gains `userRead: z.number().int().nonnegative().optional()`.
- `SubagentMessageUpdateSchema` gains `n: z.number().int().positive().optional()`:
  the message's index among the user's messages to that child.
- Daemon: `subagentRows` (`subagents-view.ts:33-52`) maps `userRead`, and
  **`sameRows` compares it**. Without that, a frame whose only change is a read
  is dropped.
- `messageSubagent` (`hosted-session.ts:~1661-1686`) emits `n: result.index`.
- Client: `boundRow` (`client/src/subagents.ts:19-38`) keeps `userRead` if it is a
  nonnegative safe integer. `boundSubagentMessage` (`:103-111`) keeps `n`
  likewise. A pod is not trusted, so these are numbers only, display only.

**B4. TUI (pure first).**
- `noteSent` (`tui/src/background-focus.ts:443-450`) stores `{text, n?}`; widen
  `DockState.sent`.
- `BackgroundAgentRow` (`background-view.ts:15-34`) gains `userRead?`. Map it
  wherever `SubagentRow` becomes a `BackgroundAgentRow` (find by grep).
- A pure `sentState(n, userRead, ended)` returns one of:
  - `"read"` when `n !== undefined && userRead !== undefined && n <= userRead`;
  - `"unknown"` when `n` or `userRead` is absent (an older daemon);
  - `"unread_ended"` when the drawer's outcome is set;
  - `"unread"` otherwise.
- `drawerView` (`background-list.ts:526-593`) maps it to the suffix:
  - `"read"`: `  ✓ read` (tone `success`);
  - `"unread"` and `"unknown"`: `  · read before its next step` (dim, today's text);
  - `"unread_ended"`: `  · not read` (dim).
- Reserve the widest suffix in the width math (`:572-576`).

A message is shown read only once a row that counts it has arrived, because
indexes are cumulative and the comparison is `n ≤ userRead`. The usual order
(`subagent_message` first, the row later, coalesced) therefore shows "unread"
until the read lands, which is the safe side. A TUI that attached late compares
the same absolute indexes, so it agrees.

**Out of scope:** the TODO's "consider a hint in the child's steer text about
`agent_notify`". It changes the child's prompt, not the read state (Q3).

### Files

Listed in dependency order.
1. `packages/protocol/src/session.ts`: `WAKE_TURN_PREFIX`, `isWakeTurnId`;
   `SubagentRowSchema.userRead?`. Also `packages/protocol/src/updates.ts`:
   `SubagentMessageUpdateSchema.n?`. Re-export from the package index if needed.
2. `packages/core/src/agent-inbox.ts`: sender-tagged items, `push(text, from)` →
   `index`, `read(from)`, `onRead`.
3. `packages/core/src/agent-jobs.ts`: `onRead → changed()`, `message` returns
   `index`, `rows().userRead`.
4. `packages/daemon/src/hosted-session.ts`: the `:2360` constant; `n` in
   `messageSubagent`. Widen the `agentRuntime.message` result type if it is an
   interface.
5. `packages/daemon/src/connection.ts`: the A2 refusal in `prompt` and `sendNow`.
6. `packages/daemon/src/subagents-view.ts`: map and compare `userRead`.
7. `packages/client/src/subagents.ts`: bound `userRead` and `n`.
8. `packages/client/src/remote-client.ts`: the `daemonWakes` option, passed to sessions.
9. `packages/client/src/remote-session.ts`: `autoAcceptsTurn`.
10. `packages/cli/src/connect.ts`: `daemonWakes: true`.
11. `packages/cli/src/relay-policy.ts`: comment only (A8).
12. `packages/tui/src/permission-ui.ts`: `autoAcceptTest`, comments.
13. `packages/tui/src/App.tsx`: the interface member; use `autoAcceptTest`.
14. `packages/tui/src/background-focus.ts`, `background-view.ts`,
    `background-list.ts`: `{text, n}`, `userRead`, `sentState`, suffixes.

Then the tests below, and the `TODO.md` lines for both items (on this branch).

### Failure modes

| Case | Convergence |
|---|---|
| Another client on `serve` sends `prompt`/`send_now` with `wake-…` | `InvalidParams`: nothing starts. Its turns keep random ids and stay foreign to this TUI (C5 holds). |
| A pod daemon emits a `wake-…` turn | The pod client has no `daemonWakes`, so the turn is foreign and asked, as today. Even if it were auto-accepted, the result is a `once` approval of a pod-side call the pod controls anyway (A7). |
| New `connect`, old `serve` (no A2) | Residual (A9, Q2): a forged `wake-` from another client of the same daemon could be auto-accepted once. |
| Wake ask raised with no TUI attached | It stays pending daemon-side. On attach, the replay stamps it with the wake id (`permission-router.ts:121`, or `out.turn`), and auto-accept answers at once if on. If the TUI mounts with auto-accept off and the user then presses Shift+Tab, `applyAuto` grants it (`pendingOwnRef`). |
| Background child spawned by a wake that has ended | The prefix test is stateless, so it is answered. No `mintedTurns` eviction applies. |
| Ask with no `turnId` / a hooks-trust question | Asked, unchanged (`ownRequest` → false; `kind` check). |
| Two TUIs with auto-accept on | Both answer `allow_once`; the daemon keeps the first, and the second's answer finds no pending ask (resolved). It is a no-op, the same path as a foreign prompt answered on two devices. |
| One TUI on, one off | The "off" TUI may flash the dialog; `permission_resolved` withdraws it. |
| User Ctrl+C / `/exit` during a wake | Unchanged: `ownsTurn` is untouched, so the wake is still a foreign turn for quit/cancel semantics. |
| `/clear` while a wake ask is pending | The router's `sessionClosed`/`retainOnly` paths are unchanged. The new session has the same `daemonWakes`. |
| (B) Row arrives after `subagent_message` | Shown unread until the row with a higher `userRead` lands (safe side). |
| (B) Drain fires no frame | Fixed by `onRead → changed()`, and `sameRows` comparing `userRead`. |
| (B) Late attach / two TUIs | Absolute indexes, so both show the same state. |
| (B) Older daemon (no `n`/`userRead`) | `"unknown"` shows today's text. Nothing regresses. |
| (B) Child ends with unread texts | `close()` does not count them. The frozen row keeps the last `userRead`, and the outcome is set, so the suffix is `· not read`, matching the report's "were not read". |
| (B) `closeIfEmpty` hand-back, then a cancel before the pass drains it | Counted as read, but the report lists it as missed. This is the same imprecision `agent_control status` has (one source of truth); see Notes in Review. |
| (B) Hostile daemon sends huge or negative numbers | Bounded client-side to nonnegative safe integers; display only. |

### Tests

Red before green (§9). Each test names its mutation.

- **T1, daemon: A2 reservation** (`packages/daemon/test/integration.test.ts`,
  which drives `session/prompt` over a real `Connection`). `prompt` and `send_now` with `turnId: "wake-x"`
  get `InvalidParams`, and no `turn_start` is sent. **RED today** (`forge.ts`).
  Also assert the daemon's own wake still starts: in
  `cli/test/serve-autowake.test.ts:161`, add `expect(starts[1].turnId).toStartWith(WAKE_TURN_PREFIX)`.
- **T2, client unit: `autoAcceptsTurn`.**
  - With `daemonWakes: true`: `wake-a` → true; an own minted id → true; a
    foreign uuid → false.
  - Without the option: `wake-a` → false.

  **RED:** the method is absent. Mutation: drop the `daemonWakes &&` guard, and
  the second case goes red.
- **T3, stack: real `serve` + `connectTui`** (new test, next to
  `cli/test/serve-autowake.test.ts`). It is `repro.ts` as a test:
  - real `startDaemon`, real `connectTui`, the fake model 1–4;
  - a fake `startTui` whose requester is
    `autoApproves(req, ownRequest(o?.turnId, autoAcceptTest(session)))`, i.e. the
    exported helpers the hook uses;
  - assert: a 4th model request happens; the wake's ask was answered with
    `own=true`; no ask fell through to a held prompt.
  - Second case: a raw second client prompts a foreign turn whose shell call
    asks. That ask is **held** (C5 still holds under the widened test).

  **RED today.** Mutation: drop `daemonWakes: true` from `connect.ts`, and the
  test goes red.
- **T4, TUI frame** (`packages/tui/test/foreign-turns.test.tsx` pattern,
  ink-testing-library). A session fake has `autoAcceptsTurn`; auto-accept is on.
  - A request with `turnId: "wake-1"` → no dialog in the frame; the requester
    resolves `allow_once`.
  - A request with a foreign id → the dialog is shown (T-C3b stays green).
  - Auto-accept off, a `wake-1` dialog on screen, Shift+Tab → granted and closed.

  **RED** on the first case today.
- **T5, relay pin** (`cli/test/relay-policy.test.ts`). `autoAccept: true`,
  `bindOwnsTurn(() => false)`, a request with `turnId: "wake-x"` → held, with an
  `ask_raised` event. This is a **pin, not red/green**: it holds on old and new
  code. It fails if someone later wires `autoAcceptsTurn` or a prefix check into
  the relay.
- **T6, core: `AgentInbox`.**
  - Two user pushes → `index` 1, 2; an agent push does not move the user index.
  - `drain()` → `read("user") === 2`; `closeIfEmpty` hand-back counts; `close()`
    leftovers do not count.
  - `onRead` fires on a non-empty drain and not on an empty one.

  **RED:** the API is absent.
- **T7, core: `AgentJobs`.** `message` returns the index. A drain (through the
  child's runner, or the inbox handle used by existing tests) fires `onChange`,
  and `rows()[0].userRead` moves. **RED.**
- **T8, daemon: `subagents-view`.** `subagentRows` carries `userRead`. `sameRows`
  is false when only `userRead` differs (mutation: delete the comparison → red).
  `messageSubagent` emits `n` (extend the existing `subagent_message` test).
- **T9, client: `subagents`.** `boundRow` keeps a valid `userRead` and drops `-1`
  or `1e300`. `boundSubagentMessage` keeps a valid `n`.
- **T10, TUI.**
  - Pure: `sentState` truth table, and `drawerView` suffixes for
    read / unread / unread_ended / unknown, including the width at 40 columns.
  - Frame (ink-testing-library): open the drawer, emit a `subagent_message{n: 1}`
    then a `subagents` row with `userRead: 1`. The frame goes from
    `read before its next step` to `✓ read`. **RED today.**

Iterate per file. Before done: `bun test`, `bun run typecheck`, `bun run lint`
(baseline: clean).

### Owner questions (the plan uses these recommended defaults)

- **Q1. With several TUIs attached, who answers a wake ask?**
  **Recommended: every TUI with auto-accept ON, and the first answer wins (A6).**
  It needs no code or wire change, and it matches how foreign prompts resolve.
  - Alternative (b): only the TUI that sent the session's last prompt. The daemon
    would track "last prompter" per session and stamp it on the wake's asks: a
    new wire field, more state, and a TUI that quit leaves nobody to answer.
  - Alternative (c): none, i.e. today's behaviour.
- **Q2. A `PROTOCOL_VERSION` bump for the `wake-` reservation?**
  **Recommended: no (A9).** No real client mints `wake-`. The residual is a
  hand-crafted client against an older `serve` of the same user, for one `once`
  approval. Bump instead if you want new-`connect`/old-`serve` pairs refused
  outright.
- **Q3. The `agent_notify` hint in the child's steer text** (the TODO's "consider").
  **Recommended: a separate small task.** It changes what the child's model
  reads, not the read state. Measure it with a local model first.
- **Q4. "✓ read" means the text entered the child's context, not that the child
  acted on it.** **Recommended: keep it**; it is what `agent_control status`
  counts. A child that ignores a read message shows `✓ read`, which is exactly
  "delivered and ignored", the case the owner wanted to tell apart.


**Answers (owner, 2026-11-10):** Q1 (a) every attached TUI with auto-accept on may answer a wake turn's ask, first answer wins · **Q2 (b) BUMP `PROTOCOL_VERSION` 21 → 22** for the `wake-` prefix reservation (closes the new-connect/old-serve edge; client and daemon must be updated together) · **Q3 (b) IN this task:** when `subagents.twoWay` is on, the text delivered to a background child with a user/agent message ends with a short hint that it may answer with `agent_notify` (keep it to one short line; off → byte-identical to today) · Q4 (a) `✓ read` = the message entered the child's context (same count as `agent_control status`'s unread).

## Execution

*— deepseek (tentacle --profile deepseek), 2026-11-10*

### Repro, on this branch's base (8a77ffe, run from `.tentacle/tmp/autoaccept-wake/`)

`repro.ts` (real `startDaemon` + real `connectTui`, requester = `autoApproves(req, ownRequest(t, session.ownsTurn))`):

```
ask turnId=a22596bb-… tool=shell own=true auto-accepted=true
ask turnId=wake-81aeeb56-… tool=shell own=false auto-accepted=false
RESULT: model requests=3; the wake turn's ask was NOT auto-accepted (held for a human)
```

`forge.ts` (raw WS, `session/prompt{turnId:"wake-forged-by-a-client"}`):

```
prompt reply: {"jsonrpc":"2.0","id":3,"result":{"turnId":"wake-forged-by-a-client"}}
turn_start ids: [ "wake-forged-by-a-client" ]
```

Both reproduce. After the fix, same two scripts with their imports pointed at this worktree:

```
ask turnId=1aa2d6b3-… tool=shell own=true auto-accepted=true
ask turnId=wake-715615bb-… tool=shell own=true auto-accepted=true
RESULT: model requests=4; the wake turn's ask was auto-accepted
```

```
prompt reply: {"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"turnId: the \"wake-\" prefix is reserved for the daemon's own wake turns"}}
turn_start ids: []
```

(Worktree copies: `repro-wt.ts` / `forge-wt.ts` / `repro-fixed.ts` in that folder. The
originals import `../../../packages/…`, i.e. the primary checkout, which good practice
says not to read from here. `bun install` was needed in the worktree first — it ships no
`node_modules`.)

### As built, in the plan's order

1. **Protocol** (`protocol/src/session.ts`, `updates.ts`, `version.ts`).
   `WAKE_TURN_PREFIX = "wake-"` + `isWakeTurnId()` next to `TurnIdSchema`; no schema
   `.refine` (as planned). `SubagentRowSchema.userRead?` and
   `SubagentMessageUpdateSchema.n?` added. **`PROTOCOL_VERSION` 21 → 22** with the
   owner's reason in the comment; `bun run schema:export` regenerated
   `protocol/schema/protocol.json` (the two new properties plus
   `x-protocol-version: 22`). Both tests pinning 21 moved to 22
   (`protocol/test/subagent-panel.test.ts`, `daemon/test/version-mismatch.test.ts`, the
   latter's literal `daemon 21`/`protocol: 21` messages too), and the version-mismatch
   test's name gained `then autoaccept-wake-turns'`.
2. **`core/src/agent-inbox.ts`** — items are `{text, from}`; `push(text, from = "agent")`
   answers `{ok:true, index}` (that sender's cumulative count, so a queued-but-unread
   text cannot collide with a later one); `read(from)`; `onRead`. `drain()` and
   `closeIfEmpty()` both count through one private `takeAll()`; `close()` does not count.
3. **`core/src/agent-jobs.ts`** — one `private inbox()` helper wires
   `onRead: () => this.changed()` for all three construction sites (the `drive`
   fallback too); `message()` returns `index`; `rows()` carries `userRead`. Added
   `setTwoWay()` + `this.twoWay` for Q3 (see drift 2).
4. **`daemon/src/hosted-session.ts`** — mints with `WAKE_TURN_PREFIX`;
   `messageSubagent` emits `n: result.index`.
5. **`daemon/src/connection.ts`** — `refuseWakeTurnId()` called first in `prompt` and
   `sendNow`, throwing `RpcError(InvalidParams, "turnId: the \"wake-\" prefix is reserved
   for the daemon's own wake turns")`. `HostedSession.prompt` left unguarded (the daemon's
   own wake calls it).
6. **`daemon/src/subagents-view.ts`** — maps `userRead` and compares it in `sameRows`.
7. **`client/src/subagents.ts`** — `boundCount`/`boundIndex` keep `userRead`/`n` only
   as nonnegative (resp. positive) safe integers; `remote-client.ts` and
   `remote-session.ts` thread them to the listeners.
8. **`client/src/remote-client.ts`** — `RemoteClientOptions.daemonWakes?: boolean`,
   default off, passed to every `RemoteSession` it builds.
9. **`client/src/remote-session.ts`** — `autoAcceptsTurn(turnId)` = `ownsTurn ||
   (daemonWakes && isWakeTurnId)`; `ownsTurn` untouched.
10. **`cli/src/connect.ts`** — the only `daemonWakes: true`.
11. **`cli/src/relay-policy.ts`** — module comment only (A8), naming why it must stay
    `ownsTurn`. `wiring.ts` also gained `agentJobs.setTwoWay(config.subagentsTwoWay)`.
12. **`tui/src/permission-ui.ts`** — pure, exported `autoAcceptTest(session)` (widest
    first, `undefined` when no session decides); `autoApproves`/`ownRequest`/
    `usePermissionBroker` doc comments updated. Exported from `@tentacle/tui`'s index
    (the CLI tests and their fakes import the same three helpers the hook uses).
13. **`tui/src/App.tsx`** — `autoAcceptsTurn?` on the session interface; the lambda is
    now `autoAcceptTest(sessionRef.current)`; `onSubagentMessage` passes `m.n`.
14. **TUI part B** — `background-view.ts`: `BackgroundAgentRow.userRead?` +
    `sameReads()`; `background-focus.ts`: `SentText {text, n?}` and
    `noteSent(…, n?)`; `background-list.ts`: pure `sentState(n, userRead, outcome)`
    and its four suffixes (`  ✓ read` success / today's dim text for `unread` and
    `unknown` / `  · not read` dim), the widest suffix reserved in the width math.
15. **`CHANGELOG.md`** — two `Fixed` entries (auto-accept's wake turns + the drawer's
    read state) and one `Changed` entry (the two-way hint), the first naming the
    protocol 22 bump and "client and daemon must be updated together".

Then the tests, each shown RED first (below).

### Tests, and the red/mutation evidence (§9)

New files: `client/test/autoaccept-wake.test.ts` (T2),
`tui/test/autoaccept-wake.test.tsx` (T4, T4b, T10 frame).

| Test | Where | RED / mutation shown |
|---|---|---|
| T1 `wake-` refused in `prompt` and `send_now`; a lookalike id still runs | `daemon/test/integration.test.ts` (3 tests) | RED on the unfixed code, then RED under the named mutation (the call removed): `2 pass 1 fail` |
| T1 (second half) the daemon's own wake id starts with the prefix | `cli/test/serve-autowake.test.ts` | assertion added to the existing live-wake test; mutation = mint another id |
| T2 `autoAcceptsTurn` | `client/test/autoaccept-wake.test.ts` | RED under `drop daemonWakes &&`: `1 fail` |
| T3 real `serve` + `connectTui`: the wake ask is auto-accepted, nothing held | `cli/test/serve-autowake.test.ts` | RED under `drop daemonWakes: true` from `connect.ts`: `1 fail` (both with the wake half only) |
| T3 (2nd case) C5 holds: a foreign id is still held | same file | passes on both code versions by design; a wildcard `autoAcceptsTurn` would break it |
| T4 TUI frame: wake ask answered with no dialog; foreign still asks; Shift+Tab grants a wake dialog; a pod session stays foreign | `tui/test/autoaccept-wake.test.tsx` | RED under "prefer `ownsTurn` in `autoAcceptTest`": `3 fail` |
| T4b `autoAcceptTest` picks the widest / falls back / none | same file | same mutation run |
| T5 relay PIN (a pod's `wake-` held) | `cli/test/relay-policy.test.ts` | a pin, as the plan says: green on both, red if the relay ever trusts the prefix |
| T6 `AgentInbox` read counts + `onRead` | `core/test/agent-inbox.test.ts` | RED before the API existed (`index`/`read` absent) |
| T7 `AgentJobs` rows/`onChange`/`setTwoWay` | `core/test/agent-jobs.test.ts` | RED under "inbox without `onRead`": `1 fail`; and under "hint regardless of `twoWay`": `3 fail` |
| T8 `subagents-view` `userRead` + `sameRows` | `daemon/test/subagent-progress.test.ts` | assertion pairs the two mutations the plan names (`userRead: row.userRead`, the `sameRows` comparison) |
| T8b `messageSubagent` emits `n` | `daemon/test/subagent-panel.test.ts` | RED if `n` is dropped from the emit |
| T9 client bounds `userRead` and `n` | `client/test/subagents.test.ts` | RED without `boundCount`/`boundIndex` |
| T10 pure: `sentState` truth table, all four suffixes, the 40-column width | `tui/test/background-list.test.ts` | RED if the `n <= userRead` or the ended branch is dropped |
| T10 frame: `read before its next step` → `✓ read` | `tui/test/autoaccept-wake.test.tsx` | RED under "keep only `sameIds` in `App.setAgents`" — which is how the missing TUI half was FOUND (see drift 3) |
| Q3 the hint, on and off (both senders), byte-identical when off | `core/test/agent-inbox.test.ts`, `core/test/agent-jobs.test.ts` | RED under "always/never append" |
| `noteSent` keeps the index | `tui/test/background-focus.test.ts` | RED if the `n` argument is dropped |

Fixtures touched only because the types grew: `agent-jobs-progress.test.ts`,
`tools/test/agent-status.test.ts` (`userRead: 0`), `tools/test/task-detach.test.ts`
(`{ok:true, index}`), `tui/test/background-list.test.ts` (`sent` is `SentText[]`),
`core/test/agent-inbox.test.ts`/`agent-jobs.test.ts` (`index` in the push/message
assertions).

### Drift from the Implementation (and why)

1. **`sameReads` in the TUI (not in the plan).** The plan fixed the daemon's `sameRows`
   but not the TUI's own `App.setAgents`, which gated `setSubagents` on `sameIds` — ids
   only. The T10 frame test caught it: the daemon's row arrived and the frame never
   repainted. Same class of drop, second place; fixed with a pure `sameReads()`
   (`background-view.ts`) OR-ed into that gate, plus its unit test. Without it the
   feature does not work, so it is not scope creep — it is the other half of B3.
2. **`AgentJobs.setTwoWay` (Q3 (b)).** The hint belongs in the text the child reads,
   and that text is built in `AgentJobs.message` (`inboxText`), not in the tools'
   result strings. Carrying `subagents.twoWay` as a live flag (set once in `wiring.ts`,
   like `setCap`) keeps it off every constructor and lets a settings sync flip it. Off
   is byte-identical, which the test pins exactly.
3. **The `InvalidParams` code came from `ErrorCode`, not `JsonRpcErrorCode`.** The alias
   is not imported in `connection.ts` (it is re-exported by `@tentacle/transport`), and
   the missing import surfaced as an `InternalError` — caught by T1 itself, not
   guessed at.
4. **`autoAcceptTest` also exported from `@tentacle/tui`.** The T3 stack test must
   decide "exactly as the TUI does"; importing the same three helpers is what makes
   that claim true. `relay-policy.ts` already imports from the package, so the pattern
   exists.
5. **No `TODO.md` edit.** The prompt forbids it; the plan's last step ("the `TODO.md`
   lines for both items") is therefore left for the owner.
6. **`serve-autowake.test.ts` hosts T3** (the plan's own "next to it" suggestion)
   rather than a new file: it already had the fake endpoint, the project helper and the
   WebSocket client to reuse.

### Known limits, unverified

- **The `wake-` refusal is checked on every daemon** (A2 says so), so a pod daemon also
  refuses it. Nothing breaks: the relay and every pod client mint `randomUUID`s, and no
  mint site anywhere produces the prefix (grepped: only `hosted-session.ts`).
- **T3's second case is a pin, not a red/green pair** — it asserts a property that was
  already true (C5). It fails only under a wildcard `autoAcceptsTurn`; I did not stage
  that mutation because the T4c case pins the same thing at the unit level.
- **Not re-verified: the owner's live `connect` session.** The stack test is the
  closest thing here (real `startDaemon`, real `connectTui`, a fake `startTui`); the
  Ink TUI path itself is covered by T4's frame tests, not by T3.
- `git status` shows no `TODO.md`, `docs/` or lockfile change, and no commit was made.

## Review

*— claude-opus-5-5, 2026-11-10* (fresh context; adversarial; HIGH/MEDIUM only, one round.
Same model family as the plan's author, different from the executor (DeepSeek).)

**Verdict: REQUEST-CHANGES** (one MEDIUM, in the Q3 hint; part A and the protocol bump hold).

### Findings

1. **MEDIUM — the two-way hint tells a MOVED child to use a tool it does not have.**
   `core/src/agent-jobs.ts:508` appends `TWO_WAY_REPLY_HINT` to every message whenever
   `this.twoWay` is on. But `agent_notify` is registered only when the runner gets an
   `agentId` (`agent/src/subagent.ts:368-369`). A foreground child that moved to the
   background (`adopt`, `agent-jobs.ts:464`) was started by `tools/src/task.ts:217-228`
   with no `agentId` in its controls, so it never got the tool. The move does not
   rebuild the child's tool registry.
   *Failure scenario:* with `subagents.twoWay` on, the user types while an `agent_task`
   runs. The child moves to the background as `sa-1`, then the user (or the parent's
   `agent_control{action:"message"}`) messages `sa-1`. The child reads "You may answer
   with agent_notify…" and calls a tool it does not have. That call fails as an unknown
   tool, and the step is wasted. A weak local model may retry it. Off is unaffected.
   *Fix:* store `notifiable: boolean` on the running entry: `true` in `start`
   (`:402`, the path that passes `agentId`), `false` in `adopt` (`:464`). At `:508`, use
   `inboxText(from, text, this.twoWay && entry.notifiable)`. Add a test in
   `core/test/agent-jobs.test.ts`: `setTwoWay(true)`, `acquire` → `adopt` → `message`,
   then the drained text does **not** end with `TWO_WAY_REPLY_HINT` (red today), while a
   `start`ed child's text still does. The `agent_control` "message" reply text
   (`tools/src/agent-control.ts:165`) already made the same claim for a moved child
   before this branch. It reaches the parent, not the child, so fixing it is optional
   here and could take the same flag.

No other HIGH/MEDIUM.

### Gate (run by the reviewer)

`bun run check`: typecheck clean · `biome check .` 852 files, no fixes · `bun test`
**6672 pass, 3 skip (the three opt-in), 0 fail** (6675 tests, 465 files).

### Mutation non-vacuity (done here; tree restored, `git status` clean after each)

| Mutation | Test | Result |
|---|---|---|
| `connect.ts` `daemonWakes: true` → `false` | `cli/test/serve-autowake.test.ts` | **2 fail**: T3 wake case red (the wake ask is held, the model stalls), and the C5 case red too (it asserts `held == ["F1"]`, and the wake id appears) |
| `subagents-view.ts` delete `row.userRead === other.userRead &&` | `daemon/test/subagent-progress.test.ts` | **1 fail** ("a read alone makes a frame necessary") |

### Attacks tried (§7 red-team)

- **Trust bit scope.** The only `new RemoteSession(` is `remote-client.ts:822`, and it
  passes `this.daemonWakes`. `daemonWakes` is set only at `connect.ts:186`. The default is
  `=== true` (fails closed), not keyed on `daemonKind`. `local-runtime` never sets it, and
  the relay binds `ownsTurn` (pinned by T5). **Holds.**
- **Forged `wake-` from a client.** `connection.ts` refuses it in `prompt` and `sendNow`
  before the lookup. The other turn-id carriers (`enqueue`, `cancel`,
  `resolve_permission`) name an existing turn and cannot start one. The daemon's own wake
  calls `HostedSession.prompt` directly (`hosted-session.ts:2376`), so it is unaffected.
  Another client can still *steer* a running wake (`enqueue`). Its texts then join the
  context of a turn this TUI auto-accepts. That is the same exposure as steering this
  TUI's own turns today, and the plan accepts it (Q1 a). **Holds.**
- **Pod forging `wake-`.** The pod client has no `daemonWakes`, so the id is foreign and
  the gate on the laptop does not widen. Auto-accept stays scope `once`
  (`permission-ui.ts`). No lasting approval is created. **Holds.**
- **Quit/cancel semantics.** `ownsTurn` is untouched. `autoAcceptsTurn` is used only by
  `autoAcceptTest`. **Holds.**
- **Bump 21 → 22.** `version.ts`, `schema/protocol.json` `x-protocol-version: 22`, both
  pins (`protocol/test/subagent-panel.test.ts`, `daemon/test/version-mismatch.test.ts`
  including the mismatch messages), and the CHANGELOG ("client and daemon must be updated
  together"). `apps/mobile` imports the constant and pins no number. **Holds.**
- **`✓ read` loops and over-claims.** `onRead` fires only on a non-empty `takeAll`, so
  there is one `changed()` per drain and none on an empty boundary. No listener drains,
  so there is no feedback loop. The non-structural publish is still coalesced
  (`hosted-session.ts:1262-1276`). `sameRows` and `sameReads` compare `userRead`. `n` is
  computed as `read + unread-of-sender` after the push, so it is unique and monotonic.
  `close()` leftovers do not count. The client bounds both numbers. The state shows
  `read` only once a row with `userRead ≥ n` arrives: never early. One residual (below
  MEDIUM): a child that reads a message and ends within one coalescing window freezes
  with the pre-read row, so it shows `· not read`. That needs a sub-250 ms final model
  step.
- **Q3 hint, off.** `inboxText(..., false)` returns `head`, byte-identical, and a test
  pins it. **On:** one line, appended for both senders. See finding 1 for the moved-child
  hole.

### Notes (below the bar, not blocking)

- T3's C5 case injects the foreign ask with `broker.request({turnId:"F1"})` on the
  laptop. The plan asked for a raw second client prompting over the wire. The
  wire-level refusal is covered by T1 instead. This drift is not listed in Execution.

### How the executor behaved

The executor followed the plan's order and implemented the owner's answers (bump 22,
Q3 b). It found and fixed a second dropped-frame site (`sameReads`) through its own frame
test, and reported every other drift. Its mutation claims for T3 and T8 reproduced here.
It missed the moved-child path when it wired the Q3 hint, which is the one finding.

## Execution — fix round 1

*— deepseek (tentacle --profile deepseek), 2026-11-11*

Review finding 1 (MEDIUM), the Q3 two-way hint on a MOVED child; plus its OPTIONAL
point, applied the same way (one line, one flag).

**Change.** `AgentJobs`'s running entry gained `readonly notifiable: boolean`:
`true` in `start` (`core/src/agent-jobs.ts:411-414`, the path that hands the runner
its `agentId`, so `agent/src/subagent.ts` registers `agent_notify`), `false` in
`adopt` (`:469-473`, a foreground child whose runner got no `agentId` — the move
rebuilds no tool registry). `message` now pushes
`inboxText(from, text, this.twoWay && entry.notifiable)` (`:521`).

The OPTIONAL point, same flag through one small public read: `notifiable(agentId)`
(`:546-553`, `false` for an id not running), read by
`agent_control{action:"message"}` (`tools/src/agent-control.ts:160-171`) — so the
parent is not told a moved child may answer with `agent_notify` either. The tool
DESCRIPTION still follows `subagents.twoWay` alone (it is per-session, not
per-child); that asymmetry is deliberate and unchanged.

**Tests (red first).**
- `core/test/agent-jobs.test.ts` — `acquire` → `adopt` → `message`: the drained text
  is `[message from the parent agent] after the move`, no hint; a `start`ed child's
  carries `TWO_WAY_REPLY_HINT`; `notifiable` is `false` for `sa-1`, `true` for
  `sa-2`. RED before the fix (received the 2-line hint), green after.
- `tools/test/agent-control.test.ts` — an adopted child with `twoWay` on gets
  "No reply comes back…", never `agent_notify`. Also red before.
- Non-vacuity by mutation, both reverted: `this.twoWay && entry.notifiable` →
  `this.twoWay` → 1 fail in the core test; `twoWay && jobs.notifiable(agentId)` →
  `twoWay` → 1 fail in the tools test.

**Gate.** `bun run check`: `tsc --noEmit` both projects clean · `biome check .` 852
files, no fixes (one formatting fix applied to the new test during the round) ·
`bun test` **6674 pass, 3 skip (the three opt-in), 0 fail** — 6672 + the 2 new tests.
