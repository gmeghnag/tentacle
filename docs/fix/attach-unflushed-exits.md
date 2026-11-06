# fix/attach-unflushed-exits — an attaching TUI wakes for the background-job exits no turn has flushed

> **Status:** executed (awaiting Review) — owner answers Q1 = A, Q2 = A applied
> **Branch:** `fix/attach-unflushed-exits` — off `main` @ `47b0a51` (plan written on `7259b4b`)
> **Type:** fix · **Size:** M · **Blast:** cross-module (an additive wire field and a shared `RemoteClient` listener; no §7 invariant changed) · **Suited:** Sonnet may execute; fresh-context Opus Review that red-teams the pod-trust point and the relay's subscription

Planned on `main` @ `7259b4b` (detached), read-only. Nothing was edited.

## Context

*— claude-sonnet-5-5, 2026-11-06*

**Problem.** `fix/detached-autowake` made the relay wake a detached run and hand a pending wake to a TUI that attaches through the relay (`wakePending` in the `commit` ack; `docs/fix/detached-autowake.md`, Design §4). It left holes (its Notes/debt and Execution "Unverified"; owner Q6 2026-11-05; `TODO.md:433`):

1. **A TUI misses job exits that reach its client before its `onExit` subscription exists.** The TUI subscribes in a `useEffect` (`packages/tui/src/App.tsx:660-684`, `jobs.onExit`), after the runtime opened the session (`local-runtime.ts:706`, `attachTo`) and after the first render. `RemoteClient` fires `exitListeners` straight from its update loop; with none registered the update is **dropped** (`packages/client/src/remote-client.ts:1758-1765`). Two sources fall in that window: the **replay** an open sends (`hosted-session.ts:938-957`: everything after the cut, in the same synchronous step as the attach, before the open reply) and any **live** exit between the open reply and the mount.
2. **Exits before the attach that are not in its replay are invisible to it.** The replay starts at the snapshot cut (`hosted-session.ts:945-950`); the cut moves at commit points (header comment `:23-37`), so an exit that landed *during* a turn (after that turn's start flushed, before its commit) sits before the cut, and one that fell out of the byte-bounded ring (`ring.ts`) is gone. The agent still holds it in `pendingExits` (`agent/src/agent.ts:507`), unflushed, and nobody wakes for it. This is the common `serve` / `connect` / `--resume` case with the user away.

The third item of the TODO entry, **"a TUI whose continuation loses the slot drops its wake" (the `lostSlot` branch in `App.tsx`, ~`:1206-1215`)**, is already partly fixed: `fix/detached-autowake` re-pends a *handed-over* wake once (`handedWakeRef`, `App.tsx:613`). The ordinary two-TUI case stays withdrawn on purpose (that doc: "Two TUIs after hand-over … pre-existing, unchanged"). Not touched here — Owner question 1.

**Already covered by `fix/detached-autowake` (not redone).** The relay's own wake, the shared pure module `@tentacle/core` `auto-wake.ts` (`wakeStep`, `wakeDue`), the `prepare`/`commit` hand-over (`turnId`, `wakePending`), the TUI's `wakePending` prop and mount effect (`run.tsx:35,101`, `App.tsx:329,428,610`), the `handedWakeRef` retry. This task reuses that prop and that module and adds no wake logic.

**Constraints.** AGENTS §7: *protocol — fields are free* (strip schemas, no bump; `PROTOCOL_VERSION = 16` stays, `protocol/src/version.ts:7`); *the pod is not trusted* (a count it reports can only make the laptop start one empty continuation — see Failure modes); *one session path* (no new RPC, no second wake code); *logic in pure modules* (the decision is already `wakeDue`; this only feeds it).

**Repro.** Not run live; the executor's red tests are the repro. On current `main`, from the code: `session/open` returns `{sessionId, epoch, created, resync[, settings]}` and nothing about pending exits (`connection.ts:433-440`), and a client with no listener drops a replayed `background_exit` (`remote-client.ts:1762`, empty loop). Test R-U1 makes the first visible as a red run.

## Implementation

*— claude-sonnet-5-5, 2026-11-06*

### Load-bearing assumption

**The agent's own `pendingExits` is exactly the set of exits no turn has flushed — what a continuation would drain — and `HostedSession` can read its length inside `open`'s synchronous segment, so the number in the open reply is consistent with the replay that precedes it.**

Proof:
- Filled: the agent subscribes to its `JobController` at construction and pushes every exit (`agent/src/agent.ts:535`; list at `:507`).
- Drained: only by `flushBackgroundExits`, which `splice(0)`s it (`agent.ts:1821-1826`); its single caller is the top of a turn's run, before `turn_start` hooks (`agent.ts:795`). So length > 0 ⇔ "an exit a turn has not seen" — the condition `fix/detached-autowake` built `wakeDue` around.
- Reachable: `HostedSession` holds `session: Session` (`hosted-session.ts:280`); `Session` holds the agent privately (`agent/src/session.ts:61`). One getter on each exposes the length.
- Consistent with the replay: `Connection.open` runs `host.open` in a synchronous body (comment `connection.ts:407-413`; replay then reply). Reading the length in that same segment means any exit the replay carries is already counted.
- Same jobs object: the daemon's `JobController` feeds both the `Agent` and `HostedSession` (`hosted-session.ts:451`, `jobs?.onExit`); the relay rig does this with one `FakeJobs`. **R-U1 proves it end to end** over the real `SessionHost` + `Connection`; it is the first thing the executor writes.

### Preconditions

- **P1 — `OpenResultSchema` is a strip schema** (`protocol/src/session.ts:508-519`, no `.strict()`): a new optional field is dropped by an older client and omitted by an older daemon. No `PROTOCOL_VERSION` bump (AGENTS §7).
- **P2 — the TUI already accepts a seed wake.** `startTui({wakePending})` → `run.tsx:35,101` → `App.tsx:329,428`: `wakeRef` starts pending (`:610`) and a mount effect calls `wakeIfPending`. The TUI decides by its own `autoWake` (`autoWakeOnJobExit`, `App.tsx:427`). A running turn defers the wake to its end. → **no TUI change**.
- **P3 — every engine/connect TUI start goes through ONE `startTui` call, `runEngineTui` (`main.ts:~851`), with the runtime in hand and the session already open:** `main.ts:~1573` (`runtime.attachTo(sessions.resume.id, …)`, `--resume`/connect → `runEngineTui` `:~1585`) and `attach-run.ts` (`run`/`attach` → `:~1462`). *(Corrected at execution: the plan also listed `main.ts:1625`, the local worker-thread path. It owns a fresh in-process daemon with no earlier session and no exits to owe, so it is NOT touched, like the in-process path.)*
- **P4 — every open result passes `RemoteClient.applyOpenResult`** (`remote-client.ts:1525-1536`; callers `:693-696`, `:1500-1522`, `:1576-1609`): the one place to record a count.
- **P5 — a TUI subscribes once but may re-subscribe** (effect deps `[jobs, flushNow, autoWakeOnJobExit]`, `App.tsx:684`). A backlog drained at the first subscribe is emptied once; what the TUI got stays in its state.
- **P6 — the relay's `RemoteClient` also uses `onBackgroundExit`** (`local-runtime.ts:159-179`), so a backlog changes what it receives at its first subscribe. Checked by R-U4.

### Design

Two small, independent seams; together they close both holes.

**A. Daemon → client: `unflushedExits` in the open result (hole 2, and the replay part of hole 1).**
1. `protocol/src/session.ts` `OpenResultSchema`: `unflushedExits: z.number().int().nonnegative().optional()` — "background-job exits no turn has flushed into the history yet. Absent: an older daemon." (`SessionListEntrySchema` gets no such field: no reader — Notes.)
2. `agent/src/agent.ts`: `get pendingExitCount(): number`; `agent/src/session.ts`: forwarding getter.
3. `daemon/src/hosted-session.ts`: `get unflushedExits()`; `daemon/src/connection.ts:433-440`: add it to the result right after `host.open`, **omitted when 0** (keeps every existing `toEqual` on the result green).
4. `client/src/remote-client.ts` `applyOpenResult`: keep `result.unflushedExits ?? 0` on the `SessionEntry` (replaced at each open); public `unflushedExits(): number` = sum over open entries.

**B. Client: a backlog for exits nobody was listening to (hole 1, live part).**
`remote-client.ts:1758-1765`: when `exitListeners.size === 0`, push the notice on `exitBacklog` (dedupe by `jobId`, cap 64, oldest dropped — the count in A still says "something is owed"). `onBackgroundExit` (`:1050`) delivers the backlog synchronously to the new listener, empties it, then registers. The TUI sees the notices it would have had; `appendBackgroundExit` dedupes by `jobId` against the turn's own event as today.

**C. Runtime → main → TUI: reuse the existing prop.**
`cli/src/local-runtime.ts`: `LocalRuntime.unflushedExits(): number` → `client.unflushedExits()`. `main.ts:851`: `wakePending: true` when `run?.wakePending || runtime.unflushedExits() > 0`; `main.ts:1625`: when `runtime.unflushedExits() > 0`. The relay's flag and the count OR together (one boolean: never two wakes). If the relay already woke the exit, that turn flushed it: count 0.

**Why not elsewhere.** A daemon-side wake: the pod is not trusted and `autoWake` stays laptop-side (as in the autowake doc). A TUI poll of `session/list`: new traffic for a one-shot fact. Synthetic `background_exit` replays for counted exits: the daemon has no job details after a ring eviction, and a fabricated notice would be pod text on the screen.

### Files

Dependency order (protocol → agent → daemon → client → cli), smallest diff:

1. `packages/protocol/src/session.ts` — one field.
2. `packages/agent/src/agent.ts`, `packages/agent/src/session.ts` — getters.
3. `packages/daemon/src/hosted-session.ts`, `packages/daemon/src/connection.ts`.
4. `packages/client/src/remote-client.ts` — entry field, `unflushedExits()`, `exitBacklog`, drain.
5. `packages/cli/src/local-runtime.ts`, `packages/cli/src/main.ts` (**shared file**: check open branches first).
6. Docs: `docs/fix/detached-autowake.md` Notes/debt one line ("closed by fix/attach-unflushed-exits"); `docs/attach-detach-behaviour.md` one row; `CHANGELOG.md` `### Fixed`; `TODO.md` at merge.

Unchanged: `App.tsx`, `run.tsx`, `relay*.ts`, `attach-run.ts`, `@tentacle/core`, `PROTOCOL_VERSION`.

### Failure modes

| Case | Outcome | Convergence |
|---|---|---|
| **The bug:** exit during a turn, nobody woke, a TUI attaches later | open reply `unflushedExits: n>0` → `wakePending` → one continuation at mount (or at the running turn's end) | the turn start flushes all `n` (`agent.ts:795`); count back to 0 |
| **Replayed exit during open, no listener yet** | counted in the reply (same sync segment) and queued in the backlog → notice once (jobId dedupe), one wake | boolean pending: no double |
| **Live exit between the open reply and the TUI's subscribe** | backlog → first subscriber → notice + wake through the TUI's own `onExit` | |
| **Exit after the TUI subscribed** | unchanged live path | |
| **Old daemon (no field)** | `?? 0`, backlog only; hole 2 stays open for that daemon | additive, no negotiation (§7 pre-public) |
| **Old client on a new daemon** | strips the field; today's behaviour | no bump |
| **`autoWake: false`** | prop passed, TUI ignores it (`enabled: false`); backlog notices still show | exits flush at the next user prompt, as today |
| **Session mid-turn at attach** | not idle → stays pending → fires at that turn's end. The count already excludes exits that turn's start flushed | exact, not a guess |
| **Pod lies** (`unflushedExits` huge, or 1 with no job) | at most one empty continuation per attach, only with `autoWake`, through the laptop's model key — the same exposure as a forged `background_exit` (autowake doc, "Hostile pod spams"); no lasting approval, no pod text shown | accepted; only `> 0` is read |
| **Redial during open** | `openOn` retries; the count is re-read from the winning reply; the backlog lives on the client | |
| **Reconnect replays an already-counted exit** | notice deduped by jobId; wake already pending | |
| **Backlog overflow (>64 with no listener)** | oldest notices dropped; the count still wakes | the turn's flush note lists them all |
| **Drained to a listener that unsubscribes at once (P5)** | notice already in TUI state, wake already pended on its ref | nothing re-delivered, nothing lost |
| **Relay's first subscribe receives a backlog (P6)** | one `job_exit`, one wake if idle | desirable (an exit during attach was lost before); R-U4 |
| **Archived / reopened session** | agent rebuilt: `pendingExits` empty, count 0 | jobs do not survive a reload either |

### Tests

Red first on `main` (§9); narrow files, existing fakes only; each test has one mutation.

- **R-U1 (end to end, red on `main`)** — `packages/cli/test/relay.test.ts` rig (real `SessionHost` + `Connection`, daemon-side `FakeJobs`): a turn ends with a job started, the job exits with no client attached, then `attachTo` and `runtime.unflushedExits()` → `1`. Red: method and field absent. *Mutation:* `Connection.open` omits the field → fails.
- **D-1** — `packages/daemon/test/` (the `permission-events.test.ts` pattern, a raw `session/open`): after an exit with no turn since, the result has `unflushedExits: 1`; after a continuation prompt it is absent; two exits → `2`; a second client's open sees the same. *Mutation:* report `jobs.list().length` instead → the "after a turn" leg fails.
- **A-1** — `packages/agent/test/`: `pendingExitCount` rises per exit and returns to 0 after one run (fake `JobController`). *Mutation:* `flushBackgroundExits` stops splicing → the "back to 0" leg fails.
- **P-1** — `packages/protocol/test/`: `OpenResultSchema` parses with and without the field, drops an unknown sibling, rejects negative and non-integer.
- **C-1** — `packages/client/test/` (existing fake peer): (a) exit before any listener, then `onBackgroundExit` → delivered once, a second subscriber gets nothing; (b) same `jobId` twice → one delivery; (c) 70 distinct → 64; (d) with a listener present the backlog is untouched. `unflushedExits()` follows the last open and resets on a re-open without the field. *Mutations:* no drain → (a); no dedupe → (b); no cap → (c).
- **L-1** — `packages/cli/test/local-runtime.test.ts`: 0 before `attachTo`, the daemon's count after, 0 after the continuation. *Mutation:* return 0 → fails.
- **M-1** — `packages/cli/test/main.test.ts` (`io.startTui` capture): count 1 → `wakePending: true`; count 0 and no run flag → key absent; run flag only → true. *Mutation:* drop the count term → first leg fails.
- **R-U4** — `relay.test.ts`: an exit reaching the relay's client before its subscribe → exactly one wake with `autoWake`, none without. Guards P6.
- No new TUI test: seeding is pinned by T-TUI-3/4 of `fix/detached-autowake`.

Gate before done: `bun test` (baseline: all pass except the three opt-in skips), `bun run typecheck`, `bun run lint` (clean). Live, optional (`serve` + `connect`): background `sleep 5`, detach mid-turn, reattach after 10 s → a continuation starts untyped; with `autoWake: false` → it does not.

### Notes / debt

- `session/list` `unflushedExits` left out (no reader); if a "waiting jobs" badge in `/sessions` is wanted later it is one more optional field from the same getter.
- Multi-session (`/sessions` switch inside one TUI): the count is read once, for the sessions open when `startTui` starts. A session opened later in the same TUI relies on the live listener and the backlog; a per-session seed on switch is a follow-up.
- The two-TUI lost-slot withdrawal stays (Q1).
- CHANGELOG line worth writing: attaching to a session with unflushed exits, `autoWake` on, now starts a turn without a user prompt.

## Execution

*— claude-sonnet-5-5, 2026-11-06*

As built, in plan order (red first on each slice, then green):

1. **Protocol** — `OpenResultSchema.unflushedExits` (`protocol/src/session.ts`, optional int ≥ 0). **Protocol schema touched: the orchestrator must run `bun run schema:export`** (the only gate failure now is the `schema/protocol.json` drift test). No `PROTOCOL_VERSION` bump. Test P-1.
2. **Agent** — `Agent.pendingExitCount`, `Session.pendingExitCount` forwarding getter. Test A-1 (red: property undefined).
3. **Daemon** — `HostedSession.unflushedExits`; `connection.ts` adds it to the open result, omitted when 0, read in the same synchronous segment as the replay. Test D-1 (`daemon/test/unflushed-exits.test.ts`).
4. **Client** — `SessionEntry.unflushedExits` set in `applyOpenResult` (`?? 0`), `RemoteClient.unflushedExits()`, `exitBacklog` (dedupe by jobId, cap 64 = `EXIT_BACKLOG_MAX`, pushed only with no listener) drained to the first `onBackgroundExit` subscriber. Tests C-1a–e (`client/test/unflushed-exits.test.ts`).
5. **CLI** — `LocalRuntime.unflushedExits()`; `runEngineTui` passes `wakePending` when `run?.wakePending || runtime.unflushedExits() > 0` (one boolean). Tests M-1 (`main.test.ts`), R-U1/L-1 merged into one end-to-end test in `local-runtime.test.ts` (real SessionHost + Connection). Test fakes in `main.test.ts` gained `unflushedExits`.
6. Docs: CHANGELOG `[Unreleased] ### Fixed`, `docs/attach-detach-behaviour.md` row, `detached-autowake.md` Notes line.

**Mutations (each backed up, restored, shasum identical):** Connection omits the field → D-1 red; no drain / no dedupe / no cap / push with a listener present / ignore the open's count → C-1a/b/c/d/e red respectively; drop the count term in `main.ts` → M-1 red; `LocalRuntime.unflushedExits` returns 0 → R-U1/L-1 red; flush stops splicing → A-1 red.

**Drift from the plan (and why):**
- Citations moved (merges of autowake-unbounded, run-rm-flag, session-settings-apply); design held, P3 corrected above. Only `runEngineTui` is wired: the local worker path (`main.ts` ~1625) has no earlier session, so `wakePending` is not seeded there.
- R-U1 lives in `local-runtime.test.ts` (not `relay.test.ts`) and folds in L-1.
- **R-U4 dropped:** the relay subscribes (`relay.ts:423`) before its first `drive` opens the session, so it never meets a backlog; the wake with/without `autoWake` stays pinned by R-W1/R-W4. P6 is therefore unreachable for the relay.
- Q1 = A (no lost-slot retry) and Q2 = A (attach wake under the laptop `autoWake`) applied; nothing for them in code.

**Gate:** `bunx tsc --noEmit` clean; `bunx biome check .` clean; `bun test packages`: 5095 pass, 3 skip (opt-in), 1 fail = `schema/protocol.json` drift (expected until `schema:export`).

**Unverified (live):** no real `serve`/pod run. Owner checklist:
1. `run --detach` whose job ends while no one is attached and the relay is gone → `attach` starts the wake turn on its own.
2. `TENTACLE_AUTO_WAKE=0` (or `autoWake: false`) → no turn on attach; the notice still shows.
3. A job that ends in the first second of an attach (between the open and the mount) is not lost: its notice shows and the wake fires.

## Review

*— claude-sonnet-5-5, 2026-11-06*

(empty until Execution)

## Owner questions

1. **Lost-slot wake (the TODO's second half).** Generalise the once-only re-pend (`handedWakeRef`) to every TUI continuation that loses the slot? *Recommendation: no.* A refused continuation usually lost to a turn that started after the exit, but a blanket retry costs an extra empty model call whenever the winner did flush, and two TUIs would chase each other. This fix also covers the exit the next time anyone attaches. Leave it and drop that half from the TODO entry.
2. **Autonomous turn on attach.** With `autoWake` on, attaching to a session with unflushed exits now starts a turn by itself. *Recommendation: yes, same switch (`autoWake`), no new setting* — it is what "wake on a job exit" already means; the notice and the model's `[background]` note make it visible.

### Owner answers (2026-11-06)

1. Lost-slot wake: **A — no retry** (recommendation). Drop that half from the TODO entry.
2. Autonomous turn on attach: **A — yes, same `autoWake` switch** (recommendation). Owner asked why the agent does not wake while he is away: today only the TUI and the `run --detach` relay wake; a `serve` daemon has the model but no wake logic, and a pod with no relay cannot (the model is on the laptop). The attach-time wake covers those; a daemon-side wake for `serve` is a separate task (proposed to the owner).
