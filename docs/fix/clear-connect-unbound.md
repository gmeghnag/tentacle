# fix/clear-connect-unbound — `/clear` on a `connect` session called `RemoteSession.clear` unbound

> **Status:** execution
> **Branch:** `fix/clear-connect-unbound`
> **Type: fix · Size: S · Blast: contained · Suited: DeepSeek exec**

## Context

*— deepseek (tentacle --profile deepseek), 2026-11-10*

**The report (owner, live).** On `tentacle connect` to a `serve` daemon, `/clear`
answers `⏺ /clear failed: undefined is not an object (evaluating
'this.openForReset') — still in this session`. The conversation is not reset.

**One-line root cause.** `App.runClear` took the method OFF the session object —
`const { clear } = session;` then `clear()`
(`packages/tui/src/App.tsx:2611,2624` at `93a9737`) — so it ran with
`this === undefined`. Locally that is invisible: the session is the
`persistingController` object LITERAL (`packages/cli/src/local-runtime.ts:481+`),
whose methods are closures over `inner` and never read `this`. Under `connect`
the TUI is handed the `RemoteSession` CLASS instance itself
(`packages/cli/src/connect.ts:222-230` `createSession`, over
`client.newSession`), and `RemoteSession.clear` starts with
`await this.openForReset()` (`packages/client/src/remote-session.ts:780-781`).
Introduced by `be77706` (fix/clear-silent-noop round 1), whose tests only ever
faked the local literal shape.

**Second site, same shape (found while scanning).**
`packages/tui/src/App.tsx:1583` and `:1643` did `const read = session?.jobOutput;`
— `RemoteSession.jobOutput` reads `this.id`/`this.client`
(`packages/client/src/remote-session.ts:561-568`), so a job's drawer read threw
the same way under `connect` (React then unmounts the tree).

**Repro** (`.tentacle/tmp/clear-connect-unbound/repro.ts`, the REAL `App` with a
class-shaped session, `bun repro.ts`, 2026-11-10 — the paste is verbatim):

```
--- frame (tail) ---
⏺ /clear failed: undefined is not an object (evaluating 'this.openForReset') — still in this
session
--- bookkeeping ---
{ opens: 1, clears: 0 }
failed: true
```

Its `jobOutput` counterpart (`.tentacle/tmp/clear-connect-unbound/job-read-error.ts`,
an error boundary around the `App`, DOWN/ENTER/ENTER to open a job's drawer):

```
reads: 0
error: undefined is not an object (evaluating 'this.reads')
The above error occurred in the <App> component
```

## Implementation

*— deepseek (tentacle --profile deepseek), 2026-11-10*

### Load-bearing assumption

The session object the App is given is sometimes a class instance whose methods
read `this`. Proven at `connect.ts:222-230` (the factory returns
`client.newSession(...)`, a `RemoteSession`) and `remote-session.ts:780-781`
(`async clear() { await this.openForReset(); … }`), `:561-568` (`jobOutput`).

### Preconditions

- `SessionController` (`App.tsx:245+`) is an interface, so both shapes satisfy it
  — nothing in the type system forbids calling a method off the object.
- The App reads the session from a ref (`sessionRef.current`), so it cannot
  simply call `sessionRef.current.clear()` at the settle site: the captured
  `session` is what the settle handlers compare against (`sessionRef.current !==
  session`). Binding keeps that identity check intact.
- AGENTS §7: no protocol/daemon/persistence change — this is a call-site bug in
  one component (contained).

### Design

Call each method ON its session: `session.clear.bind(session)` at
`App.runClear`, and for the drawer read bind only when present
(`session?.jobOutput === undefined ? undefined : session.jobOutput.bind(session)`),
so the "older daemon, no `jobOutput`" branch (F7) is unchanged. No non-null
assertions.

Every other session method in the App was already called on the object
(`session.compact?.()`, `session.openForReset?.()`, `session.send(...)`,
`session.rename(...)`, `session.killJob(...)`, `session.messageSubagent(...)`,
`session.updateSettings()`, `session.watch?.(…)`, the `on*` subscriptions,
`SkillsSync`'s `source.skills()` at `skills-sync.ts:91`) and so keeps `this`.
`hooks.ts:74`/`relay.ts` likewise. Only these three sites were detached.
### Files

- `packages/tui/src/App.tsx` — 3 lines: the `clear` bind and the two `read` binds.
- `packages/tui/test/clear-connect-unbound.test.tsx` — new regression tests.
- `CHANGELOG.md` — `[Unreleased]` → Fixed, one line.
- this doc.

### Failure modes

- A session with no `clear`/`jobOutput` (older daemon, in-process fallback): the
  presence guard runs before the bind, so the branch is untouched.
- A session swapped while the call is in flight: unchanged — the settle still
  compares `sessionRef.current !== session`.
- The class instance's identity for `===` checks: kept (binding does not change
  the object the App compares).

### Tests

`packages/tui/test/clear-connect-unbound.test.tsx`, the REAL `App` (through
`renderAt`, so the terminal is the test's) with a `ClassSession` whose methods
touch `this`:

1. `/clear` clears it — `ran.clears === 1`, `ran.opens ≥ 1`, no `/clear failed`
   in the frame, and the cleared history still replaces the transcript.
2. `/compact` on the same shape (a guard: the App already calls it on the
   object, so it is green before the fix too — it pins against a future refactor).
3. A job's drawer reads its output — `ran.reads ≥ 1` and `TAIL of the job` on the
   frame.

## Execution

*— deepseek (tentacle --profile deepseek), 2026-11-10*

Branch/worktree set up in `.tentacle/worktrees/clear-connect-unbound` (the
checkout this task owns); `bun install` there to give it its own `node_modules`.

1. **Reproduced on the unfixed code first**, in
   `.tentacle/tmp/clear-connect-unbound/`: `repro.ts` printed the owner's exact
   notice (above), and `job-read-error.ts` caught the drawer's
   `this.reads` TypeError at the boundary — so both unbound sites were real, not
   inferred.
2. **Wrote the regression tests** (`clear-connect-unbound.test.tsx`) and ran them
   on the unfixed `App.tsx`: **RED on the assertion of the property**, not on an
   import — `expected 1, received 0` for `ran.clears` (test 1) and
   `expected >= 1, received 0` for `ran.reads` (test 3), with React's
   "The above error occurred in the <App> component". Test 2 (compact) passed
   already, as designed (a guard).
3. **Fixed** `App.tsx`: `const clear = session.clear.bind(session);` (was
   `const { clear } = session;`), and the two drawer reads
   `session?.jobOutput === undefined ? undefined : session.jobOutput.bind(session)`.
   Tests 1–3 green.
4. **Mutation (§9):** re-broke exactly the three call sites back to the pre-fix
   shape (`const { clear } = session;`, `const read = session?.jobOutput;`,
   `const read = sessionRef.current?.jobOutput;`) → tests 1 and 3 red again;
   restored the fixed file → green. Non-vacuity confirmed.
5. **Scanned every other caller** for the same pattern (`const { m } = session`,
   and every `const x = <obj>.method;` whose `x` is then called) across
   `packages/{tui,cli,client,daemon}/src`: no other session-controller method is
   taken off the object. `SkillsSync`'s `const asked = source.skills()`
   (`packages/tui/src/skills-sync.ts:91`) is a CALL, not a detached reference —
   safe. (`this.sha256`-style fields held in a local in
   `client/remote-client.ts:1466` are values, not methods.)
6. Narrow suites green: `bun test packages/tui/test/clear-connect-unbound.test.tsx
   packages/tui/test/clear.test.tsx packages/tui/test/clear-resume.test.tsx
   packages/tui/test/shell-panel-frames.test.tsx packages/tui/test/job-drawer.test.ts`
   → 63 pass, 0 fail. `bun run typecheck` green (one test-only typing round-trip
   to name the session's `onJobs` as `SessionController["onJobs"]`).

**Drift from Implementation:** none in the code. Two notes: test 3 needed a
prompt before opening the drawer (an unopened `RemoteSession`-shaped session has
no id yet and its `jobOutput` honestly answers "not open" — the shape of the
real one), and typecheck forced the class's optional `onJobs` to be declared as
`SessionController["onJobs"]` rather than a hand-written signature.

**Gate.** `bun run check` (typecheck → lint → test) **green**, against the §6
baseline of a clean lint: `6642 pass / 3 skip / 0 fail` across 463 files; the 3
skips are the documented opt-in ones (live-k8s, live-docker, real-socket
keepalive). One lint round-trip only: `biome check --write` re-joined the two
`const read` lines the formatter wanted on one line.

## Review

*— deepseek (tentacle --profile deepseek), 2026-11-10*

Not yet reviewed in a fresh context (this is the implementation pass; the
orchestrator's Review follows). Left here as the place for it.

**FIXED** — `/clear` on a `connect` session now clears it; the two unbound
`jobOutput` drawer reads are fixed with it.
