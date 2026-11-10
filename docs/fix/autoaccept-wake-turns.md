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

## Execution

*— <model-id>, <YYYY-MM-DD>*

## Review

*— <model-id>, <YYYY-MM-DD>*
