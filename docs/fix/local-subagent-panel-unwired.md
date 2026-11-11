# fix/local-subagent-panel-unwired — the persisting controller drops the sub-agent panel's members

> **Status:** execution
> **Branch:** `fix/local-subagent-panel-unwired`
> **Size:** S · **Blast:** cross-module · **Suited:** DeepSeek exec

## Context

*— deepseek (tentacle --profile deepseek), 2026-11-11*

The owner, on a live session in another repo with plain `tentacle`, could not
drive the background sub-agent panel at all. Writing to a running child always
showed:

```
this session cannot message background sub-agents (older daemon or local mode)
```

and stopping one hit its twin guard, `this session cannot stop background
sub-agents: no agent kill here`. Both appear on EVERY message and EVERY stop in
plain `tentacle` (the worker runtime) and in `run`/`attach`; `tentacle connect`
works, which is why the `.17` functests passed.

**Root cause (confirmed, cited).** Plain `tentacle` does not hand the TUI a
`RemoteSession`: `startWorkerRuntime` (`packages/cli/src/local-runtime.ts:1062`)
builds one through `createLocalRuntime` (`:730`), whose `createSession`
(`:868`) returns a `persistingController` wrapper (`:311`). That wrapper
re-declares in its type (`PersistingController`, `:211`) and forwards
(`~:585-620`) the panel members `onSubagents` / `onJobs` / `jobOutput` /
`killJob` / `onSubagentNotify` — but **not** `messageSubagent`,
`killSubagent` or `onSubagentMessage`, all three of which the bare
`RemoteSession` has (`packages/client/src/remote-session.ts:549-585`).

Because the App tests the member's PRESENCE before calling it
(`App.tsx:1516` for a message, `App.tsx:1427` for a stop), a missing forward is
not a type error — it is a permanent runtime refusal with a misleading notice.
`connect` builds its sessions from a bare `RemoteSession`
(`packages/cli/src/connect.ts`), so it never had the bug.

**The notice misdiagnoses it twice.** `App.tsx:1519` blames "an older daemon or
local mode": an older daemon would be a typed refusal from `messageSubagent`
itself (`RemoteClient`, `packages/client/src/remote-client.ts:123`), never a
missing member — the only thing a missing member means is that THIS runtime's
session has no sub-agent panel (e.g. the `--in-process` fallback, whose
`inProcessSessions` controller offers none: `packages/cli/src/session-jobs.ts:152`).

**Repro.** The regression test is the repro (there is no smaller one that keeps
the property: the bug only exists in the wrapper the real runtime returns). Run
on the unfixed code:

```
$ bun test packages/cli/test/subagent-panel-controller.test.ts
error: the runtime's controller has no onSubagentMessage: the sub-agent panel refuses every call here
(fail) the runtime's controller messages the running child, and the notice reaches onSubagentMessage
error: the runtime's controller has no killSubagent: the sub-agent panel refuses every call here
(fail) the runtime's controller stops the running child
(fail) GUARD: every `SessionController` member a `RemoteSession` has is on the runtime's controller
 0 pass · 3 fail
```

## Implementation

*— deepseek (tentacle --profile deepseek), 2026-11-11*

### Load-bearing assumption

The panel's three members exist on `RemoteSession` and work end to end; only the
wrapper's forward is missing. Verified:
`RemoteSession.messageSubagent` / `killSubagent` / `onSubagentMessage` /
`onSubagentNotify` at `packages/client/src/remote-session.ts:549-585`, the
daemon halves at `packages/daemon/src/hosted-session.ts:1744` (`messageSubagent`,
emitting the `subagent_message` update) and `:1780` (`killSubagent`), and the
client half already green in `packages/client/test/subagent-panel.test.ts:145-167`.

### Preconditions

- TUI always over RPC, one session path (AGENTS §7): the fix is a FORWARD on the
  existing seam, not a second code path. The three members are already on the
  one `RemoteSession`; nothing is re-implemented.
- The one path a plain `tentacle` session takes: `main.ts:1828`
  `startWorkerRuntime` → `local-runtime.ts:1109` `createLocalRuntime` →
  `createSession` (`:868`) → `build` (`:804`) → `persistingController` (`:311`).
- A missing panel member is a RUNTIME refusal, never a type error, because the
  App guards on presence and every member is optional on `SessionController`
  (`App.tsx:376,378,406`). This is why the forwarding type
  (`local-runtime.ts:211`, `PersistingController extends SessionController`)
  cannot catch it — hence the structural guard test below.
- `subagent_message` is a display update (`protocol/updates.ts`), so no version
  bump: the daemon already emits it, and the wire is untouched by this fix.

### Design

Additive, three lines of type + three forwards:

1. `PersistingController` declares the three as optional members typed off
   `RemoteSession[...]`, matching how `onSubagents`/`onJobs`/`killJob`/
   `onSubagentNotify` are already declared (`local-runtime.ts:255-262`).
2. The wrapper forwards each to `inner` (`local-runtime.ts:~615`), exactly like
   its neighbours. No other behaviour change: the persisting wrapper's job is to
   wrap `send`/`watch` for saves, not to filter the panel.
3. `App.tsx:1519`: the notice says what a missing member actually means. kept
   short: `_this session's runtime cannot write to sub-agents_`. A comment
   records why "older daemon" is the wrong reading, so the text is not "fixed"
   back.

The shared source of truth is `RemoteSession`'s own signatures: the type is
`RemoteSession["messageSubagent"]`, not a hand-copied signature, so a change on
the session side follows here.

### Files

1. `packages/cli/src/local-runtime.ts` — the 3 type members + the 3 forwards.
2. `packages/tui/src/App.tsx` — the notice text (and the comment saying why).
3. `packages/cli/test/subagent-panel-controller.test.ts` — new: 2 end-to-end
   cases + the structural guard.
4. `CHANGELOG.md` — `Fixed`.

### Failure modes

- **A future member is forgotten.** The bug class, not just this instance: the
  guard test reads the `SessionController` DECLARATION from `App.tsx` and
  requires every member that also exists on `RemoteSession` to be present on the
  real runtime's controller. The next panel member cannot be forgotten silently.
  Three members are excluded, each because it is `connect`-only by construction,
  not because it is inconvenient: `detach` and `stayingRows` (reached through
  the `/sessions` directory, which only `connect` passes to the TUI —
  `connect.ts:253`, `App.tsx:3135,3141`) and `autoAcceptsTurn` (wider than
  `ownsTurn` only under `daemonWakes`, set at `connect.ts:188` alone). The
  exclusions are named in the test so adding one is a deliberate act.
- **An older daemon.** Unchanged and already handled: `messageSubagent` resolves
  `{ok: false, reason}` on `MethodNotFound` (`remote-client.ts:121-123`), the
  drawer shows that reason and keeps the draft. The notice is not that path.
- **A pod daemon (untrusted, §7).** The notice and the text are bounded and
  sanitized at the client (`boundSubagentMessage`), unchanged by this fix:
  forwarding a method cannot widen what a pod can make the laptop do.
- **`--in-process`.** Still has no panel; it now says so truthfully instead of
  blaming "an older daemon or local mode".
- **Empty/blank text, an unknown child, a full inbox.** All decided daemon-side
  and already pinned (`packages/daemon/test/subagent-panel.test.ts` T-D1/T-D2);
  the forward adds no decision of its own.

### Tests

Red before green (AGENTS §9). `packages/cli/test/subagent-panel-controller.test.ts`:

1. **Messages reach the child.** Through the REAL `createLocalRuntime`
   controller (a real `Connection` + `SessionHost`, the `agent-message.e2e`
   shape): launch a background child held mid-step, `messageSubagent` it, assert
   `{ok: true}`, that the notice arrives on `onSubagentMessage`, that the child's
   next request carries `[message from the user] …`, and that an unknown id is a
   typed `{ok: false}`. Pins the exact property: the TUI's controller can write
   to a child.
2. **A stop ends the child.** `killSubagent` → `{killed: true}`, the row leaves,
   a second call → `{killed: false}`.
3. **The structural guard** (above): RED on the buggy import, and RED by
   mutation when a single forward is dropped.

## Execution

*— deepseek (tentacle --profile deepseek), 2026-11-11*

### Red first (before any edit)

Three fails, each on the assertion of the property (a missing member), never on
an import or a compile error:

```
$ bun test packages/cli/test/subagent-panel-controller.test.ts
error: the runtime's controller has no onSubagentMessage: the sub-agent panel refuses every call here
(fail) the runtime's controller messages the running child, and the notice reaches onSubagentMessage [11.93ms]
error: the runtime's controller has no killSubagent: the sub-agent panel refuses every call here
(fail) the runtime's controller stops the running child [1.73ms]
error: expect(received).toEqual(expected)
- []
+ [ "autoAcceptsTurn", "messageSubagent", "killSubagent", "onSubagentMessage", "detach", "sessionId", "stayingRows" ]
(fail) GUARD: every `SessionController` member a `RemoteSession` has is on the runtime's controller [22.21ms]
 0 pass · 3 fail
```

**Drift from Implementation, and why.** The guard's first run named SEVEN
members, not three. Six of those are real observations and only three were the
bug:

- `messageSubagent` / `killSubagent` / `onSubagentMessage` — the bug. Forwarded.
- `sessionId` — already forwarded (`local-runtime.ts` `get sessionId()`), but a
  STRING, so my first guard's `typeof … === "function"` test called it missing.
  The guard was wrong; it now tests presence (`!== undefined`).
- `autoAcceptsTurn`, `detach`, `stayingRows` — genuinely absent from the wrapper,
  and correctly so: all three are only reachable on `connect`
  (`daemonWakes: true` at `connect.ts:188`; the `/sessions` directory that calls
  `detach`/`stayingRows` is passed only by `connect`, `connect.ts:253`, cf.
  `App.tsx:3135,3141`). Wiring them into a worker/`run`/`attach` controller
  would not be "no other behaviour change" — it would need proof that no code
  path there reaches them, which is what the cited lines already establish. They
  are excluded BY NAME in the test, with the reason, so the exclusion cannot
  quietly grow.

Also a test-order bug of mine, fixed in the test (not the product): I read the
child's rows before releasing its gate, so a killed child's stream never
observed the abort and the row never left. The daemon's own T-D3 resolves the
gate first; the test now does too.

### The fix

`packages/cli/src/local-runtime.ts` (+17): three optional members on
`PersistingController` typed off `RemoteSession`, and three forwards
(`messageSubagent`, `killSubagent`, `onSubagentMessage`) beside their
neighbours. `packages/tui/src/App.tsx`: the notice is now
`_this session's runtime cannot write to sub-agents_`, with a comment recording
that an older daemon is a typed refusal, not a missing member. No test pinned
the old text (`grep` found none).

### Mutation (non-vacuity, AGENTS §9)

Three forwards removed → all three tests red, the guard naming exactly them:

```
- forwards removed; running the final test file (RED expected) -
error: the runtime's controller has no onSubagentMessage: ...
(fail) the runtime's controller messages the running child, and the notice reaches onSubagentMessage [11.72ms]
error: the runtime's controller has no killSubagent: ...
(fail) the runtime's controller stops the running child [1.41ms]
+   "messageSubagent",
+   "killSubagent",
+   "onSubagentMessage",
(fail) GUARD: ... [23.44ms]
 0 pass · 3 fail
```

ONE forward dropped (`killSubagent`) → the guard names only it, and only its own
test fails — so the guard catches the NEXT forgotten member individually, not
just this batch:

```
--- only killSubagent dropped ---
error: the runtime's controller has no killSubagent: ...
(fail) the runtime's controller stops the running child [1.75ms]
+   "killSubagent",
(fail) GUARD: ... [23.06ms]
 1 pass · 2 fail
```

Restored → `3 pass · 0 fail`.

### Gate

- `bunx tsc --noEmit` — clean.
- `bun run lint` — clean (0 errors, 0 warnings; the AGENTS §6 baseline). One
  Biome formatting fix applied to the new test.
- `bun test` — 6822 pass, 3 skip (the three opt-in skips, AGENTS §6), 1 fail.
  The fail is `apps/mobile/test/rn-websocket.test.ts`: `Cannot find module
  '@tentacle/client'` — `apps/mobile/node_modules` is absent in this worktree,
  the stated "mobile deps may be absent" case. Environment, not code; bun counts
  its unhandled error as the run's one fail.
- **One flake seen and cleared**: the first full run also failed
  `packages/daemon/test/serve-log-store.test.ts` "S11 — a real SIGKILL at random
  points" (a `13658ms` timing test). It passes 6/6 alone and 4/4 in its own
  suite, and the first full suite showed it while the second (same tree, same
  command) had **no `(fail)` line at all** — 6822 pass, 3 skip, 1 fail (the
  mobile error). A load-sensitive pre-existing flake: this diff touches neither
  `packages/daemon/` nor anything that test imports.
- Not verified: the compiled-binary worker path (needs a built binary) — the
  same forward is on that path by construction (`startWorkerRuntime` →
  `createLocalRuntime`), but only a real binary run proves it end to end.

## Review

*— pending*

