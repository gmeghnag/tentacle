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

### Round 1 (fix)

*— deepseek (tentacle --profile deepseek), 2026-11-11 — review round 1*

Both review findings were in `packages/cli/test/subagent-panel-controller.test.ts`
only. **No product change:** `packages/cli/src/local-runtime.ts`,
`packages/client/src/remote-session.ts` and `packages/tui/src/App.tsx` are
byte-identical to the pre-review tree (`git diff --stat` names the test file
alone). Two reasons:

**1 (MEDIUM) — the guard's scope.** The selector is now
`declared.filter((name) => name in session && …)` off a real
`new RemoteSession({} as unknown as RemoteClient)` **instance** (`:339`), never
`RemoteSession.prototype`, and the `> 20` floor is replaced by the **exact**
24-member set (`expect(forwarded).toEqual([…])`, `:358-384`). The `autoAcceptsTurn`
exclusion's comment now gives both reasons, names the only safe wiring shape
(`ownsTurn(t) || inner.autoAcceptsTurn(t)`), and points at the new test.

Mutation (non-vacuity, AGENTS §9), in `.tentacle/tmp/subagent-panel-unwired/`.
First the hole, measured in-process (`guard-scope.ts`: the real class's
prototype stripped, its three panel members re-declared as constructor-bound
**arrow properties** on a scratch subclass — the `clear-connect-unbound` refactor
shape — and the wrapper's `messageSubagent` forward deleted):

```
baseline            — prototype: 24 | instance: 24
3 moved off proto   — prototype: 21 | instance: 24
  messageSubagent    prototype-scope? false  instance-scope? true
  killSubagent       prototype-scope? false  instance-scope? true
  onSubagentMessage  prototype-scope? false  instance-scope? true
  OLD guard, floor `> 20` on the shrunk set → still PASSES? true
  NEW guard, exact set pinned             → scope kept?   true
wrapper forward `messageSubagent` dropped:
  prototype-selected → missing: [] → guard result: GREEN (bug slips)
  instance-selected  → missing: ["messageSubagent"] → guard result: RED (bug caught)
```

Then the same refactor in the real tree (`remote-session.ts`'s
`messageSubagent` turned into an arrow property, the wrapper's forward deleted),
running each guard version against it:

```
=== OLD guard (prototype + >20 floor), tree MUTATED (arrow prop + forward dropped) ===
 1 pass            ← the original bug, green (the finding, reproduced)
=== NEW guard on the same MUTATED tree ===
+   "messageSubagent",
(fail) GUARD: every `SessionController` member a `RemoteSession` has is on the runtime's controller
 0 pass · 1 fail   ← caught
```

Both source edits reverted (`git diff` shows no product file); on the restored
tree `killSubagent` dropped alone still reddens the guard naming exactly it —
`+ "killSubagent"`, `1 pass · 2 fail` — as the original Execution recorded.

**2 (MEDIUM) — the `autoAcceptsTurn` exemption.** Its test comment now states
both halves (`:235-247`): the inner test is WIDER under `daemonWakes`
(`connect.ts:188`) and NARROWER than the wrapper's `ownsTurn` under `adoptTurn`
(`local-runtime.ts:594-595`, `attach-run.ts:368`), so the only safe wiring shape
is `ownsTurn(t) || inner.autoAcceptsTurn(t)`. A new test
(`:248-276`) runs `autoAcceptTest` (`@tentacle/tui`, `permission-ui.ts:97` — the
same call the App makes at `App.tsx:695`) against the **real**
`persistingController` built with `adoptTurn`, over an inner session that
answers `autoAcceptsTurn` like the real one (`ownsTurn || wake-…`) and says the
run turn is foreign:

```
    expect(ctl.ownsTurn(runTurn)).toBe(true);
    expect(inner.autoAcceptsTurn(runTurn)).toBe(false);
    expect(test(runTurn)).toBe(true);
    expect(ownRequest(runTurn, test)).toBe(true);
    expect(test("88888888-…")).toBe(false); // a foreign turn stays foreign
```

Mutation — the naive forward the finding names, added to the real wrapper
(`autoAcceptsTurn(turnId) { return inner.autoAcceptsTurn(turnId); }` beside
`ownsTurn`), then reverted:

```
272 |   expect(test(runTurn)).toBe(true);
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) auto-accept answers the adopted run turn's asks through the REAL wrapper (a plain `autoAcceptsTurn` forward would not) [0.22ms]
 3 pass · 1 fail
```

So the guard's own invitation is now red when taken naively. Restored → `4 pass
· 0 fail`.

Gate (this tree, after both fixes):
`bunx tsc --noEmit` exit 0 · `bun run lint` "Checked 881 files. No fixes
applied." (one Biome formatting pass applied to the edited test) · `bun test
packages/cli` **2452 pass · 0 fail**. A full `bun test` run during this round hit
the known load-sensitive flake `packages/client/test/reattach.test.ts` "a replay
past the client's buffer bound converges" (`3002.73ms`); standalone it is 54/54,
same file and signature the review already recorded, and this diff touches no
product code.

## Review

*— deepseek (tentacle --profile deepseek), 2026-11-11, fresh-context review*

**Same model family as the executor** (only the context is fresh): shared blind
spots survive both passes, so the two findings below are exactly the kind a
different model should confirm before merge. This task is `cross-module`, not
`load-bearing`, so fresh-context-in-family is the routing AGENTS §10 allows.

### Verdict

**REQUEST-CHANGES.** The product fix is right, minimal, and proven end to end;
both findings are in the **structural guard** — the deliverable whose stated job
is "the next panel member cannot be forgotten silently". It can be, and its own
comment invites a change that silently breaks `attach` auto-accept. Neither
finding is a nit: each has a concrete path to a silent wrong state.

### Findings

**1 (MEDIUM) — the guard's coverage silently shrinks if a member moves off the
prototype, and its floor does not notice.**
`packages/cli/test/subagent-panel-controller.test.ts:271-278` selects what to
check with `name in RemoteSession.prototype`, then floors the count with
`expect(forwarded.length).toBeGreaterThan(20)` (`:278`). `RemoteSession`
implemented as a constructor-bound **arrow property** is absent from the
prototype, so it leaves the guard's list *and* the pass/fail check with no
signal. Measured (scratch probe, `.tentacle/tmp/review-lsp/guard-hole.ts`,
removing the three members from the prototype only):

```
baseline forwarded: 24 | has messageSubagent? true
after 3 members moved off the prototype: 21 | has messageSubagent? false
guard's floor is >20 → still PASSES? true
```

Failure scenario: someone applies this repo's own fix for the unbound-`this`
bug class (`docs/fix/clear-connect-unbound.md`; the App today has to
`session.clear.bind(session)` at `App.tsx:2662` and bind `jobOutput` at
`:1612`) by turning `messageSubagent`/`killSubagent`/`onSubagentMessage` — or
any panel member — into bound arrow properties. The guard drops them from
scope, stays green (21 > 20, four members of slack), and the next removal of
the wrapper's forward is now undetected: the original bug returns with a green
guard. Cheap fixes: test presence on an **instance**
(`new RemoteSession(...)`, works today — the probe built one) instead of the
prototype, and/or pin the exact set rather than a `> 20` floor.

**2 (MEDIUM) — the `autoAcceptsTurn` exemption is correct today, its stated
reason is incomplete, and wiring it the obvious way silently breaks `attach`
auto-accept — unpinned.**
The test excludes it (`:274`) and `:268-273` justifies that only via
`daemonWakes` (`connect.ts:188`), closing with "Adding one of them here without
wiring it is the only way this list may change" — i.e. it invites wiring. But
`RemoteSession.autoAcceptsTurn` is `ownsTurn || (daemonWakes && wake-…)`
(`remote-session.ts:293-295`) and knows nothing of the **adopted run turn**,
which exists only on the wrapper:
`ownsTurn(turnId) { return turnId === adoptedTurn || inner.ownsTurn(turnId) }`
(`local-runtime.ts:594-595`), set from `attach-run.ts:368` →
`local-runtime.ts:947`. And `autoAcceptTest` **prefers** `autoAcceptsTurn` when
present (`permission-ui.ts:97`), which is what the App feeds the broker
(`App.tsx:695`).

Failure scenario: to satisfy the guard, a future change forwards
`autoAcceptsTurn: inner.autoAcceptsTurn` (mirroring `ownsTurn`'s forward one
line above). In `tentacle attach <name>` of a `run --detach --auto-accept`
run, `autoAcceptTest` now uses the inner test, which says the run's turn is
**not** own → every permission ask of the run's own turn is held for a human
who typed nothing: the attached TUI stalls mid-run. Nothing catches it: the
guarded `ownsTurn` is pinned (`cli/test/local-runtime.test.ts:1620` D21) but no
test runs `autoAcceptTest` against the real wrapper with an adopted turn —
`cli/test/attach-run.test.ts:660,693,723` uses a fake `LocalRuntime` whose
controller has no `autoAcceptsTurn`, and `serve-autowake.test.ts:352` drives a
bare `connect` session. Cheap fix: say *both* reasons in the test comment (the
inner test is NARROWER than the wrapper's `ownsTurn` under `adoptTurn`, not
just wider under `daemonWakes`), and name the only safe wiring shape
(`ownsTurn(t) || inner.autoAcceptsTurn(t)`) with a small test.

### Gate (re-run by this review, same tree)

- `bunx tsc --noEmit` — clean (exit 0).
- `bun run lint` — `Checked 881 files. No fixes applied.` (AGENTS §6 baseline).
- `bun run typecheck` — its second half, `tsc -p apps/mobile`, fails on
  `apps/mobile/App.tsx` (`Cannot find module 'react-native'`):
  `apps/mobile/node_modules` is absent in this worktree. Environment, not this
  diff; same cause as the one `bun test` fail the executor reported.
- `bun test` — **6822 pass · 3 skip · 1 fail · 1 error**, and the fail/error is
  `apps/mobile/test/rn-websocket.test.ts` (`Cannot find module
  '@tentacle/client'`). Executor's counts match exactly; the 3 skips are the
  AGENTS §6 opt-ins.
- One pre-existing load flake seen in this review and cleared:
  `packages/client/test/reattach.test.ts` "a replay past the client's buffer
  bound converges" timed out once (`3001 ms`) in a full run, then 54/54 twice
  standalone. A different file from the executor's `serve-log-store` flake,
  same signature — the suite has load-sensitive timing tests, this diff touches
  none of them.
- The new file alone: `3 pass · 0 fail`, **8 consecutive runs**, no flakes.

### Mutation non-vacuity (AGENTS §9)

Forbidden from editing, so run in-process against the real controller
(`.tentacle/tmp/review-lsp/guard-mutation.ts`, same `declared`/`connectOnly`
logic as the test, each forward set to `undefined` on the live wrapper one at a
time): **every one of the 24 forwarded members is named individually when
dropped** (`send`, `compact`, `clear`, `openForReset`, `enqueue`, `sendNow`,
`close`, `skills`, `context`, `rename`, `onReturned`, `watch`, `open`,
`ownsTurn`, `onQueued`, `onSubagents`, `onSubagentNotify`, `messageSubagent`,
`killSubagent`, `onJobs`, `jobOutput`, `killJob`, `onSubagentMessage`), and
`baseline missing: []`. So the guard is non-vacuous member-by-member, and the
`required()` helper throws on the exact missing member (its message is what the
executor's red output shows). Finding 1 is about *scope* drift, not about the
comparison being fake.

### Premises (each row opened; `main:` = the pre-fix line the Context cites)

| Premise | Line | Verdict |
|---|---|---|
| `startWorkerRuntime` is plain `tentacle`'s path | `main.ts:1828`; `local-runtime.ts:1079` (main: `:1062`) | TRUE |
| → `createLocalRuntime` | `local-runtime.ts:747` (main: `:730`) | TRUE |
| → `createSession` → `build` → `persistingController` | `:885`, `:816` (main `:799`), `:837` (main `:804`-region) | TRUE |
| Wrapper type `PersistingController extends SessionController` | `local-runtime.ts:211` | TRUE |
| Only three panel members were missing | my live-controller probe: 24/24 now present; `main:` had 21 (the red guard named 7, 4 of them wrong tests — see Execution) | TRUE |
| `App` guards on presence before calling | `App.tsx:1516` (`messageSubagent`), `:1427` (`killSubagent`) | TRUE |
| `connect` drives a bare `RemoteSession` | `connect.ts:232-234` | TRUE |
| An older daemon is a typed refusal, never a missing member | `remote-client.ts:121-123` | TRUE |
| `subagent_message` is a display update (no version bump) | `protocol/updates.ts:440` | TRUE |
| `sessions` (the `/sessions` directory) is passed only by `connect` | `connect.ts:253`; `main.ts:1040-1070` and `attach-run.ts:725` pass only `TuiSessions` | TRUE |
| `daemonWakes` set only at `connect` | `connect.ts:188` | TRUE |
| Old notice text pinned by no test/doc | `grep -rI` across the tree: only `CHANGELOG.md:13` (new), `TODO.md:482` (the backlog quote), this doc | TRUE |

### Attacks tried (≥3, incl. those that found nothing)

1. **Any other `SessionController` member a `RemoteSession` implements still
   missing?** No. `App.tsx` declares 29; minus `settings`/`updateSettings` (not
   on the session) and the 3 named exclusions = **24, all present** on the live
   wrapper. The two findings are about the guard's durability, not a 4th gap.
2. **Is the `connectOnly` set right for the laptop worker *and* `run`/`attach`?**
   Yes, and stronger than the doc argues: `detach`/`stayingRows` are reachable
   only through `switchTo` (`App.tsx:3130-3143`), which returns early without
   the `sessions` prop; `autoAcceptsTurn` must NOT be forwarded — `autoAcceptTest`'s
   preference would swap the wrapper's wider (`adoptTurn`) test for the inner
   narrower one (finding 2). Result: correct today, fragile in its reasoning.
3. **Does the new test drive the real runtime controller?** Yes — a real
   `Connection` + `SessionHost` + `createLocalRuntime`, controller from
   `runtime.createSession()` (the wrapper), no fake session. It stops short of
   `startWorkerRuntime`/a real `Worker` as `TODO.md:482` asked, which the doc
   states; the wrapper is the same object on that path, so the residual risk is
   the transport only.
4. **One end-to-end trace through the REAL App** (`.tentacle/tmp/review-lsp/e2e-app.ts`:
   real runtime controller + `ink-testing-library`): pill `· 1 agent ↓` → DOWN →
   ENTER → drawer `→ sa-1` open → type → ENTER →
   `notice row present: true`, `blamed an older daemon / local mode: false`,
   `refusal line: (none)`, and after releasing the child,
   `child's later request carries it: true` (`[message from the user] skip the
   tests folder`). The user-visible property holds on the fixed code.
5. **`n` (the `✓ read` key) survives the new forward?** Yes:
   `RemoteClient.subagentMessaged → {"…","n":1}` and the session listener gets
   `n: 1`. The test's listener narrows to `{agentId, text}` (`:189`) so it does
   not pin `n`; the client/daemon tests do, so not a finding.
6. **Unbound-`this` hazard** (the `connect` class-instance trap,
   `docs/fix/clear-connect-unbound.md`): none — the wrapper's three forwards are
   closures over `inner`, and the App calls them as methods. Holds.
7. **Is the notice change safe?** Yes (attachment table row 12): no test or doc
   pinned the old string; the new text is reached only for a member-less
   session (`--in-process`), and an older daemon still gets its own typed
   refusal. The sibling guards (`:1428`, `:1456`) keep their old wording — a
   cosmetic inconsistency, not reported.

### What holds

The root cause is exactly as cited; the fix is three forwards + three
type members on the existing seam (no second code path, AGENTS §7); no save or
`watch` behaviour is touched; the red-first evidence matches what the code
predicts; the gate counts are reproducible in this worktree. The guard is
non-vacuous per member and does pin the "next member" for today's
implementation style.

### How the executor behaved

Well: it reported the drift honestly (the first guard run named 7 members, and
it separated the 3 real gaps from `sessionId` (a string, mis-tested) and from
its own test-ordering bug), pinned each forward by mutation, and its gate
numbers reproduce exactly — including the mobile-module fail. The miss is
narrow and in the same direction both times: the guard's *justifications* were
verified for today's code and not stress-tested against the refactors and
future edits they invite — which is what findings 1 and 2 are.

