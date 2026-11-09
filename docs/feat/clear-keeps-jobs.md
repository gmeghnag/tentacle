# feat/clear-keeps-jobs — `/clear` hands the running background work to the new session

> **Status:** implementation (plan written, awaiting owner answers Q1–Q9 and approval)
> **Branch:** Part 1 `feat/clear-keeps-jobs` (this worktree, off `main` `ac2da32`); Part 2 `feat/clear-keeps-jobs-ui`, opened off `main` only after Part 1 merges (AGENTS §10: one code branch at a time)
> **Type:** feat · **Size:** Part 1 **L**, Part 2 **M** (split: one branch would hold ~26 files and two kinds of risk) · **Blast:** Part 1 **load-bearing** (one session path, the broker/requester, persistence of both logs, protocol), Part 2 **load-bearing** (the session-open path in `RemoteClient`, the laptop's saves) · **Suited:** owner assigned `deepseek-v4.1-flash` to execute (AGENTS §10 would put a strong model on load-bearing work — owner's call, recorded); **mandatory fresh-context Opus review of each part**, red-teaming §7 "one session path", "single broker" (the daemon-side requester swap), "Persistence", "Protocol"

Vocabulary: **job** = a background shell job (`bg-N`, `JobController`); **child** = a background sub-agent (`sa-N`, `AgentJobs` + the `AgentJobLedger`); **background work** = both, plus their exits not yet delivered and a child's unanswered ask.

## Context

*— claude-opus-5-5, 2026-11-09*

**Owner requirement (2026-11-09, binding).** `/clear` must NOT kill the session's running background shell jobs or background sub-agents. They are HANDED to the new session: listed there (jobs as today — `session/list`'s `jobs` count, the relay; children in the 6a-2 count/list), and their exit notice lands in the NEW chat, self-contained (command / description: the new chat has no history of the launch). This reverses decision D3 / QN1's "the old session ends with its jobs".

**Today.** `/clear` is `sessionRef.current?.close?.(); swapSession(makeSession())` (`packages/tui/src/App.tsx:1857-1862`). The close reaches `HostedSession.close` (`packages/daemon/src/hosted-session.ts:2462-2510`), which disposes both registries: `this.jobs?.dispose()` (`:2504`, kills every job) and `this.agentRuntime?.dispose()` (`:2509`, aborts every child, no `end`, no exit). The new session is a fresh `RemoteSession` that is not even created daemon-side until its first send (`packages/client/src/remote-session.ts:286-293`, `open()` is a no-op for a fresh session). So today there is no new session to receive anything at `/clear` time, and the old one destroys everything.

**Why it is not a one-liner** (each verified below):
1. The new session must EXIST daemon-side at `/clear` time and must be BUILT on the old session's registries (`JobController`, `AgentJobs`) and broker — merging into an already-built session would clash ids (two `BackgroundJobs` both mint `bg-1`).
2. The old agent holds exits no turn has flushed (`packages/agent/src/agent.ts:517,549-550`); they must move (the settings-sync seam `retire()`/`adoptExits()` already does this, `agent.ts:558-564,591-593`, used at `hosted-session.ts:1909`).
3. A child blocked on an ask at `/clear` has its ask registered in the OLD session's `asks` map with an abort listener bound to the old session (`hosted-session.ts:808-838,849-885`). The probe below shows it stays there after the requester is swapped: it must be re-homed or the child hangs.
4. The old session's log has `subagent_background` without an `end`; every load turns that into "was lost: the session restarted" (`packages/core/src/agent-job-ledger.ts:308-314,341-347`). The owner: the old log must NOT claim it lost. It needs a durable fact, and the laptop's copy of the old log needs one more read AFTER the hand-over (it persists only from `session/log` reads, `packages/cli/src/local-runtime.ts:314-351`).
5. `connect` closes the old session for every device (QN1, `App.tsx:1858-1860`); a detached run's TUI closes with `ifLast` (only detaches while the relay or another TUI is on it, `packages/daemon/src/connection.ts:483-495`). Moving jobs out of a session that stays alive elsewhere would leave it incoherent.

**Repro (capability gap, this tree, 2026-11-09).**

```
$ rg -n 'close\?\.\(\);' packages/tui/src/App.tsx
1861:          sessionRef.current?.close?.();
1867:          sessionRef.current?.close?.();
$ rg -n 'jobs\?\.dispose\(\)|agentRuntime\?\.dispose\(\)' packages/daemon/src/hosted-session.ts
2504:    this.jobs?.dispose();
2509:    this.agentRuntime?.dispose();
$ rg -n 'handOverFrom|subagent_handed' packages/      → no matches
$ rg -n 'handOver\(\)' packages/ --glob '!**/test/**'
packages/core/src/agent-job-ledger.ts:291:  handOver(): AgentJob[] {          (no caller: the task-5 seam, unused)
```

## Implementation

*— claude-opus-5-5, 2026-11-09*

### Load-bearing assumption

**A hand-over done in ONE synchronous stretch on the daemon — rebind `AgentJobs`' host, swap the job/child exit listeners, `setRequester` on the SAME broker — routes every later child end, child ask, child exit and job exit to the NEW owner only, and nothing can fall between the two owners; an ask already pending at the old requester stays with the old one (so it must be re-homed explicitly).**

Why it should hold (code): `AgentJobs.drive` reads `this.host` at the END of the child's run, in the same synchronous segment as `running.delete` (`packages/core/src/agent-jobs.ts:311-332`); `bind` just replaces it (`:113-115`). `BackgroundJobs` fires its listeners from `handle.exited.then(...)` (`packages/exec/src/background.ts:102,178`) — a promise callback, which cannot run inside a synchronous stretch. `PermissionBroker.request` reads `this.requester` per call (`packages/core/src/permission.ts:189-192`). `SessionHost.open` is synchronous from look-up to attach (`packages/daemon/src/session-host.ts:445-515`, "no `await` anywhere"), and `build` is synchronous (`:911-960`, `createAgent` is a plain call).

**Proven by probe** (`.tentacle/tmp/clear-keeps-jobs/probe.ts`, run 2026-11-09 on this tree): real `AgentJobs`, real `BackgroundJobs` + `HostExecution`, real `PermissionBroker`, real `AgentJobLedger`. Child 1 asks BEFORE the hand-over and ends after it; child 2 asks and ends AFTER it; a real `sleep 0.2; exit 3` job exits after it. The hand-over is one synchronous block: `oldLedger.handOver()`, unsubscribe the OLD exit listeners, `newLedger.adopt()`, `agents.bind(NEW)`, subscribe NEW listeners, `broker.setRequester(NEW)`.

```ts
// (abridged — full script is the file above; gitignored, so the essentials are here)
agents.start({ callId: "c1", ... "early asker" }, async ({ signal }) => {
  void broker.request(req("early"), { signal }); await firstGate; return {...};
});
agents.start({ callId: "c2", ... "late asker" }, async ({ signal }) => {
  await secondGate; const a = await broker.request(req("late"), { signal }); return {...};
});
const shell = jobs.start("sleep 0.2; exit 3");
await sleep(20);                                   // child 1's ask reaches OLD
// --- ONE synchronous stretch ---
const carried = oldLedger.handOver(); offOldJob(); offOldAgent();
newLedger.adopt(carried); agents.bind(NEW); jobs.onExit(NEW); agents.onExit(NEW);
broker.setRequester(NEW);
// --- end ---
releaseSecond(); releaseFirst(); await sleep(400);
```

```
$ bun run .tentacle/tmp/clear-keeps-jobs/probe.ts
OLD asked early
NEW asked late
NEW ended sa-1 end_turn
NEW agent exit sa-1 (early asker)
NEW ended sa-2 end_turn
NEW agent exit sa-2 (late asker)
NEW shell exit bg-1 3 (sleep 0.2; exit 3)
carried=sa-1:running,sa-2:running
new ledger running=0 next=sa-3
shell bg-1 status=exited
```

Every end/exit/new ask reached NEW only; nothing reached OLD after the stretch; the job's exit carries its command (self-contained); the new ledger's counter is past the adopted ids. **And** the ask raised before the stretch stayed at OLD (`OLD asked early`, never re-asked): that is why Design §3.6 re-homes pending background asks. Re-prove it with T7–T10 before anything else in Part 1.

### Preconditions (verified on this tree)

| Fact | Where |
|---|---|
| `/clear` = close the old controller, then a fresh lazy one | `packages/tui/src/App.tsx:1857-1862`; `makeSession` `:674-682`; `swapSession` `:1571-1606`; `watchSession` resets the sub-agent list (`setAgents(undefined)`) `:1515-1531` |
| `createSession` is the runtime's factory (no args) | `App.tsx:343`; `packages/tui/src/run.tsx:42,137`; `packages/cli/src/local-runtime.ts:64,735-746`; `packages/cli/src/connect.ts:216-220`; `packages/cli/src/attach-run.ts:254,510-523`; `packages/cli/src/main.ts:1046,1837` |
| The in-process fallback (worker unavailable) has its own factory with one `BackgroundJobs` per session | `packages/cli/src/session-jobs.ts:105-134`, `main.ts:1850-1863` |
| A fresh `RemoteSession` opens lazily; `openSeeded()` opens it now, memoized in `createOrAttach` | `packages/client/src/remote-session.ts:294-364` |
| `RemoteSession.close()`: fire-and-forget, follows a pending open, `ifLast` when built `closeIfLast` | `remote-session.ts:552-568` |
| `RemoteClient.openSession` / `openOn` / `applyOpenResult` | `packages/client/src/remote-client.ts:970-1005,1939-1978,1992-2006` |
| `PersistingController`: saves only from reads; `close()` = `flushed().then(inner.close)`; `saveNow`, `flushed`, `openSeeded` + `saveOnOpen` | `local-runtime.ts:286-500` (`close` `:489-495`, `saveOnOpen` `:372-375`) |
| `OpenParams` / `OpenResult` are strip schemas; `unflushedExits` is the precedent of an optional result field "omitted by an older daemon" | `packages/protocol/src/session.ts:583-627` |
| `Connection.open`: `prepareOpen`, then synchronous `host.open`, result built in the same segment | `packages/daemon/src/connection.ts:434-462`; `closeSession` `ifLast` rule (`attachedCount > own`) `:483-495` |
| `SessionHost.open` (create branch), `build`, and the `reuse` + `foreign` precedent of a settings sync | `packages/daemon/src/session-host.ts:456-515,911-960,972-1013`; `AgentReuse` `:89-95` |
| Factories: the pod model-proxy factory honours `reuse`; `serve`, the worker and the pod non-proxy branch ignore it | `packages/cli/src/serve.ts:466-473,523-536` (honours); `serve.ts:186-196`, `packages/cli/src/worker.ts:116-130`, `serve.ts:524-527` (ignore); `buildAgent` takes `permissions`/`jobs`/`agentJobs` options `packages/cli/src/wiring.ts:389-396` |
| `HostedSession` state: `jobs` / `agentRuntime` are `readonly`; `agentJobs` ledger; `spawnTurns` | `hosted-session.ts:445,451,456,507` |
| Constructor order: ledger seeded `:557`, cut `:566-573`, first segment `:578-594` (`logSegmentFacts` `:594`), `setRequester` `:606`, job exit subscription `:611-621`, `bind` `:625-640`, child exit `:641-654`, rows `:657`, first persist `:682` | `hosted-session.ts` |
| Background asks: `PendingAsk` `:183-209`; `registerAsk` (abort listener bound to `this`) `:808-838`; `awaitBackgroundDecision` (turnId from `spawnTurns`) `:849-885`; re-offered at every attach `:1318-1324` (`reofferBackgroundAsks` `:893`); `settle` `:975-995` | `hosted-session.ts` |
| Live list: `kickSubagents` `:1169-1199`, `publishSubagents` `:1207-1222`; `summary().jobs` counts `jobs` + `agentRuntime` `:1268-1283`; `liveness().busy` `:1286-1294` | `hosted-session.ts` |
| Wake: `kickWake` `:2110-2118`, `maybeWake` (on `session.pendingExitCount`) `:2127-2164`; `unflushedExits` `:1255-1260` | `hosted-session.ts` |
| `reusable()` `:1873-1885`; `swapAgent` does `next.adoptExits(previous.retire())` `:1895-1915` | `hosted-session.ts` |
| `Agent.retire()` / `adoptExits()` / `runningBackground()`; exit notes are self-contained (`job id + command + status`; child `id + description + report`) | `packages/agent/src/agent.ts:558-564,570-583,591-593,1877-1922` |
| `Session` proxies `pendingExitCount`, has `replaceAgent` | `packages/agent/src/session.ts:92-99,154-157` |
| `stillRunningNote(jobs, agents)` — the text compaction / context reset already give the model | `packages/agent/src/compact.ts:233-253` |
| Ledger: `handOver()` / `adopt()` (no caller), `noteSeen`, `fromHistory` closing kinds, `segmentFacts`, `loadNotes`, `subagentLoadNotes` | `packages/core/src/agent-job-ledger.ts:108-141,243-252,259-283,291-314,376-401` |
| `NOTE_KIND` | `packages/core/src/model.ts:83-90` |
| Log entry schemas, union, critical table (adding a NON-critical type is free; a critical one needs the owner + a bump) | `packages/protocol/src/session-log.ts:12-19,199-250`; `projectEntry` ignores unknown-to-projection types `:285-286` |
| `SessionLog.subagentBackground` / `subagentEnd` | `packages/daemon/src/session-log.ts:144-151` |
| Title = first user message (would pick a note) | `packages/agent/src/session-store.ts:74-81`; `packages/daemon/src/session-title.ts:52-67` |
| Relay counts `session/list` `jobs` for its own session and for "others" | `packages/cli/src/relay-state.ts:275-293,316-345` |
| `AgentJobs.dispose()` aborts every child; `kill(id)` | `core/src/agent-jobs.ts:184-193,250-260` |

### Design

**Shape.** One new optional field on the existing create path, `session/open{create, sessionId: NEW, handOverFrom: {sessionId: OLD, ifLast?}}`, answered by `handOver: {outcome, jobs, agents}` in the result. The daemon builds the new session ON the old session's broker and registries (the settings-sync `reuse` seam, `session-host.ts:972-1013`) and moves the rest in the same synchronous stretch. The client then takes ONE more read of the old session (the laptop's final save, so its copy carries the hand-over facts) and closes it as today. No new method, no new update, no new session code path (§7 "one session path": the new session is an ordinary created session; only its construction inputs differ).

**What moves** (only when there is something to move — else `/clear` is exactly today's, fresh registries and a clean slate):
- the `JobController` and the `AgentJobs` objects (so `bg-N` / `sa-N` keep counting, `shell_kill`/`shell_output`/`agent_kill` of a handed id work from the new session, the cap is shared);
- the daemon-side `PermissionBroker` (its requester is re-pointed by the new `HostedSession` constructor, `:606`), NOT the session approvals (`grants`, Q4);
- the old agent's unflushed exits (`retire()` → `adoptExits()`);
- the ledger entries of children that are running or whose exit is still pending (`handOver(ids)`), adopted by the new ledger BEFORE its first segment, so `logSegmentFacts()` re-emits their `subagent_background` (and `subagent_end`) markers in the NEW log;
- every pending background ask (same `requestId`, no `turnId`), re-offered by the new session.

**What stays with the old session:** its history; a `subagent_handed{agentId, sessionId}` log entry per moved child (durable: the old log never says "lost"); nothing else — its fields to the registries are cleared, so `summary()`/`liveness()`/`close()` no longer see them.

#### Part 1 — the daemon seam (branch `feat/clear-keeps-jobs`)

**1.1 Protocol** (`packages/protocol/src/session.ts`, `session-log.ts`, regenerated `schema/protocol.json`).
- `OpenParamsSchema` (`session.ts:583-609`) gains
  `handOverFrom: z.object({ sessionId: SessionIdSchema, ifLast: z.boolean().optional() }).optional()`,
  documented in the `session/open` comment block (`:445-491`): "honoured only by an open that CREATES; the named session must be open on THIS connection; with `ifLast` and another client attached to it, nothing moves (`kept`)".
- `OpenResultSchema` (`:612-627`) gains
  `handOver: z.object({ outcome: z.string().min(1).max(32), jobs: z.number().int().nonnegative(), agents: z.number().int().nonnegative() }).optional()` — present iff the open carried `handOverFrom` (absent = an older daemon). `outcome` is a bounded string, not an enum, so a later value never fails the whole open result's parse; the client maps unknown values to `"none"`. Values today: `"handed"`, `"kept"`, `"none"`.
- `session-log.ts`: `LogSubagentHandedEntrySchema = { ...envelopeShape(), ...skippable(), type: z.literal("subagent_handed"), agentId: z.string().min(1).max(64), sessionId: SessionIdSchema }`; add to `KnownLogEntrySchema` (`:221-233`) and `LOG_ENTRY_CRITICAL` (`:238-250`) as `false`; extend the module comment (`:12-19,30-34`): non-critical, an older build skips it (and then shows the old "lost" note — the honest degradation).
- No `PROTOCOL_VERSION` bump (Q5 recommendation): both fields are additive; `bun run schema:export`.

**1.2 Core** (`packages/core/src/model.ts`, `agent-job-ledger.ts`).
- `NOTE_KIND` (`model.ts:83-90`) gains `subagentHanded: "subagent_handed"` ("a child moved to the session `/clear` opened") and `carriedOver: "carried_over"` ("the new session's list of what it took over").
- `AgentJob.state` becomes `"running" | "ended" | "handed"` (`agent-job-ledger.ts:37`).
- `SubagentHandedBody` type, same pattern as `SubagentEndBody` (`:53-58`).
- `handOver(ids?: ReadonlySet<string>): AgentJob[]` (`:291-295`): without `ids`, today's behaviour; with `ids`, only those jobs. Every returned id is deleted from `jobs` and ADDED to `closed` (a late `end` in the old ledger is then `null`). Never returns a `"handed"` job.
- `handed(agentId: string): boolean` — REPLAY ONLY (the live path never has a handed job): a known job (running or ended) → `state: "handed"`, true; a closed id → false; an unknown id → an orphan `{agentId, callId: "", agentType: "", description: "", state: "handed"}` inserted (same rule as an orphan `end`, `:195-222`), true.
- `segmentFacts()` (`:259-283`): `if (job.state === "handed") continue;` first. `running()` unchanged (filters `"running"`).
- `noteSeen` (`:243-252`) and `fromHistory`'s closing set (`:132-136`): also close on `NOTE_KIND.subagentHanded`.
- `loadNotes()` (`:308-314`): `"handed"` → `subagentHandedNote(job)`.
- New exported builder `subagentHandedNote(job: AgentJob): ChatMessage`: `content: "[background] sub-agent ${subjectOf(job)} was moved to a new session by /clear; its result is reported there, not here."`, `note: { kind: NOTE_KIND.subagentHanded, id: job.agentId }`.
- `subagentLoadNotes` (`:376-401`): `else if (entry.type === "subagent_handed") { ledger.handed(entry.agentId); }`.

**1.3 Agent** (`packages/agent/src/session.ts`, `compact.ts`, `session-store.ts`).
- `Session.retireAgent(): PendingExit[]` → `return this.agent.retire();` (beside `pendingExitCount`, `session.ts:154-157`; import `type PendingExit` from `./agent.ts`).
- `compact.ts`, next to `stillRunningNote`: `export function carriedOverNote(jobs, agents): ChatMessage` = `{ role: "user", content: "[background] Carried over from the previous session by /clear (this conversation did not start them):\n" + stillRunningNote(jobs, agents), note: { kind: NOTE_KIND.carriedOver } }` (no `id`: it names several).
- `sessionTitle` (`session-store.ts:74-81`): `messages.find((m) => m.role === "user" && m.note === undefined)`. Same filter in `titleInput` (`packages/daemon/src/session-title.ts:53`: `findIndex((m) => m.role === "user" && m.note === undefined)`). Needed anyway: a first turn in the new session flushes handed exits BEFORE the prompt, so the first user message would be a note.

**1.4 Daemon `SessionLog`** (`packages/daemon/src/session-log.ts:144-151`): `subagentHanded(body: SubagentHandedBody): void { this.push({ type: "subagent_handed", critical: false, ...body }); }`.

**1.5 Daemon `HostedSession`** (`packages/daemon/src/hosted-session.ts`).
1. `jobs` and `agentRuntime` lose `readonly` (`:445,451`) — they are cleared by `handOff`.
2. `PendingAsk` (`:183-209`) gains `readonly signal: AbortSignal` and `readonly detach: () => void` (removes the abort listener). `registerAsk` (`:808-838`) fills both (`detach: () => signal.removeEventListener("abort", onAbort)`).
3. New exported types (top of file, beside `PendingAsk`):
   ```ts
   /** A background child's unanswered ask, moved to the session `/clear` opened. */
   export interface HandedAsk { readonly requestId: string; readonly update: PermissionRequestUpdate; // reoffer, WITHOUT turnId
     readonly offered: ReadonlySet<string>; readonly replyable: ReadonlySet<string>;
     readonly signal: AbortSignal; readonly settle: PendingAsk["settle"]; }
   /** What a hand-over moves (`handOff` → `SessionHost.build` → the new constructor). */
   export interface HandedWork { readonly permissions: PermissionBroker; readonly jobs?: JobController;
     readonly agentRuntime?: AgentJobs; readonly ledger: readonly AgentJob[];
     readonly exits: readonly PendingExit[]; readonly asks: readonly HandedAsk[];
     readonly running: { readonly jobs: readonly { id: string; command: string }[];
                         readonly agents: readonly { agentId: string; description: string }[] }; }
   ```
4. `hasBackgroundWork(): boolean` (public): `!this.closed && (runningJobs > 0 || (this.agentRuntime?.list().length ?? 0) > 0 || this.session.pendingExitCount > 0 || [...this.asks.values()].some((a) => a.reoffer !== undefined))`, where `runningJobs = this.jobs?.list().filter((j) => j.status === "running").length ?? 0`.
5. `handOff(toId: string): HandedWork` (public; the caller checked `hasBackgroundWork()` in the same synchronous stretch). In THIS order, no `await`:
   1. `this.controller?.abort();` — the old turn (if any) stops; the client closes this session right after.
   2. `this.unsubscribeExit?.(); this.unsubscribeAgentExit?.(); this.unsubscribeAgentRows?.();` and clear `subagentsKick` (as `close` does, `:2498-2501`).
   3. `const exits = this.session.retireAgent();`
   4. `running = { jobs: running shell jobs as {id, command}, agents: (this.agentRuntime?.list() ?? []).map(a => ({agentId: a.agentId, description: a.description})) }`.
   5. `ids = new Set([...running.agents.map(a => a.agentId), ...exits.filter((e) => "agentId" in e).map((e) => e.agentId)])`; `const ledger = this.agentJobs.handOver(ids);` then `for (const job of ledger) this.log.subagentHanded({ agentId: job.agentId, sessionId: toId });` and `this.verifyLog()`.
   6. `asks`: for each `[requestId, ask]` of `this.asks` with `ask.reoffer !== undefined`: `ask.detach(); this.asks.delete(requestId);` push `{ requestId, update: withoutTurnId(ask.reoffer), offered: ask.offered, replyable: ask.replyable, signal: ask.signal, settle: ask.settle }`; and, if `ask.shown`, `try { this.emit({ type: "permission_resolved", requestId, outcome: { outcome: "cancelled" } }) } catch (e) { this.reportTurnError(e) }` (the OLD session's clients drop the dialog; the answer comes from the new one). `withoutTurnId` = `const { turnId: _t, ...rest } = update; return rest`.
   7. `this.spawnTurns.clear();`
   8. `this.publishSubagents([]);` (old clients' list empties; never throws).
   9. Capture `const work = { permissions: this.permissions, ...(this.jobs ? { jobs: this.jobs } : {}), ...(this.agentRuntime ? { agentRuntime: this.agentRuntime } : {}), ledger, exits, asks, running }`, then `this.jobs = undefined; this.agentRuntime = undefined;` and return `work`. (Not persisted here: `SessionHost.build` calls `persistHandOff()` after the NEW session exists, FM 9.)
6. `persistHandOff(): void` (public) → `this.persist();`.
7. Constructor gains a 13th optional parameter `handed?: { readonly ledger: readonly AgentJob[]; readonly asks: readonly HandedAsk[] }` and:
   - right after `this.agentJobs = AgentJobLedger.fromHistory(...)` (`:557`): `if (handed) this.agentJobs.adopt(handed.ledger);` — BEFORE `logSegmentFacts()` (`:594`), so the new log's first segment carries the markers;
   - right after `this.unsubscribeAgentRows = …` (`:657`): `if (agentRuntime && handed) { this.lastSubagents = subagentRows(agentRuntime.rows()); this.cut = { ...this.cut, subagents: this.lastSubagents }; }` (the first attach's snapshot lists the handed children: quit-confirm counts are right at once);
   - right after `permissions.setRequester(...)` (`:606`): `if (handed) this.adoptBackgroundAsks(handed.asks);`.
8. `private adoptBackgroundAsks(asks: readonly HandedAsk[]): void` — for each: if `a.signal.aborted` → `a.settle({ outcome: "cancelled" })` and continue; else `const onAbort = () => this.settle(a.requestId, { outcome: "cancelled" });` `this.asks.set(a.requestId, { offered: a.offered, replyable: a.replyable, record: null, reoffer: a.update, shown: true, signal: a.signal, detach: () => a.signal.removeEventListener("abort", onAbort), settle: (o, r, m) => { a.signal.removeEventListener("abort", onAbort); a.settle(o, r, m); } });` `a.signal.addEventListener("abort", onAbort, { once: true });`. Nothing is emitted here: the attach that follows re-offers it (`:1324`). (The original promise chain in the OLD `awaitBackgroundDecision`, `:878-884`, is a pure mapping — it uses no `this` — so resolving it from the new session is correct.)
9. `close()` is unchanged: after a `handOff` its `this.jobs?.dispose()` / `this.agentRuntime?.dispose()` are no-ops (fields cleared).

**1.6 Daemon `SessionHost`** (`packages/daemon/src/session-host.ts`).
- `OpenOutcome` gains `handOver?: { outcome: "handed" | "kept" | "none"; jobs: number; agents: number }`.
- `open(params, attachment, prepared?, from?: HandOverSource)` — new 4th parameter, `type HandOverSource = { kind: "session"; hosted: HostedSession } | { kind: "kept" } | { kind: "none" }` (resolved by `Connection`). The live and archived branches ignore it (`handOver: none` when `from` was given). In the create branch (`:491-514`), pass `from.kind === "session" ? from.hosted : undefined` to `build` and return the outcome: `kept` → `{outcome:"kept", jobs:0, agents:0}`; `session` with work moved → `{outcome:"handed", jobs: work.running.jobs.length, agents: work.running.agents.length}`; otherwise `none`.
- `build(id, messages, restored?, seed?, settings?, log?, from?: HostedSession)` (`:911-960`), with `from` and `from.hasBackgroundWork()`:
  1. `const reuse = from.reusable();` (`:1873-1885`) and call `createAgent(defaultCwd, { modelLink, ...(settings ? { settings } : {}), reuse: { permissions: reuse.permissions, ...(reuse.jobs ? { jobs: reuse.jobs } : {}), ...(reuse.agentJobs ? { agentJobs: reuse.agentJobs } : {}) } })` — **no `grants`** (Q4).
  2. The `foreign` check, copied from `updateSettings` (`:984-1005`): if `permissions`/`jobs`/`agentJobs` differ from `reuse`'s → `agent.retire()`, dispose only the factory's OWN foreign registries, throw `RpcError(InternalError, "the agent factory did not reuse the session's broker and jobs")`. **Nothing has moved yet** (FM 11).
  3. `const work = from.handOff(id);` `agent.adoptExits(work.exits);`
  4. History: `running.jobs.length + running.agents.length > 0` → `messages = [...agent.startConversation(), carriedOverNote(work.running.jobs, work.running.agents)]` (log reason stays `"create"`: it is the daemon's, not the client's seed); else the usual.
  5. `new HostedSession(..., agentJobs, { ledger: work.ledger, asks: work.asks })`, then `from.persistHandOff()`.
  6. If `new HostedSession(...)` throws after `handOff` (not expected), `work.jobs?.dispose(); work.agentRuntime?.dispose();` and rethrow — never two owners, never none silently (FM 11).
  Without `from` (or nothing to hand): exactly today's code.

**1.7 Daemon `Connection.open`** (`packages/daemon/src/connection.ts:434-462`). Before `this.host.open(...)`, in the same synchronous segment: `const from = params.handOverFrom ? this.handOverSource(params.handOverFrom) : undefined;` with
```ts
/** The session a `/clear` hands over from: open on THIS connection, and — with `ifLast` — nobody else on it. */
private handOverSource(h: { sessionId: string; ifLast?: boolean }): HandOverSource {
  const entry = this.attached.get(h.sessionId);
  if (!entry || this.host.get(h.sessionId) !== entry.hosted) return { kind: "none" };
  if (h.ifLast === true && entry.hosted.attachedCount > 1) return { kind: "kept" };
  return { kind: "session", hosted: entry.hosted };
}
```
(`ifLast` mirrors `closeSession`, `:484-491`: the close that follows will only detach, so the work stays with the session that stays alive.) The result adds `...(outcome.handOver ? { handOver: outcome.handOver } : {})`.

**1.8 Factories honour `reuse`** (so every runtime can hand over; today only the pod model-proxy one does).
- `packages/cli/src/wiring.ts`: export `reuseOptions(reuse?: AgentReuse): Pick<BuildAgentOptions, "permissions" | "jobs" | "agentJobs" | "grants">` = the spread at `serve.ts:466-473`; `tunnelledAgent` uses it (no behaviour change).
- `serve.ts:186` (`startDaemon`): `createAgent: (cwd, { reuse }) => buildAgent({...config, cwd}, { ...existing, ...reuseOptions(reuse) })`.
- `serve.ts:524-527` (pod, non-proxy branch): same.
- `worker.ts:116`: `createAgent: (cwd, { reuse }) =>` and pass `...reuseOptions(reuse)` to `buildAgent`.
- These factories still report no `settingsReport`, so `updateSettings` keeps answering `applied: false` for them (`session-host.ts:988-999`): unchanged.

#### Part 2 — client, runtimes, TUI (branch `feat/clear-keeps-jobs-ui`, after Part 1 merges; this section moves to `docs/feat/clear-keeps-jobs-ui.md` then)

**2.1 Client `RemoteClient`** (`packages/client/src/remote-client.ts`).
- `openOn` (`:1939-1978`): params type gains `handOverFrom?: { sessionId: string; ifLast?: boolean }`; it now RETURNS `Promise<OpenResult | undefined>` (`result` after `applyOpenResult`; `undefined` on the drop/recreate returns). Existing callers ignore it.
- New method, beside `openSession`:
  ```ts
  /** `openSession` for a `/clear` that hands `from`'s background work to the new session
   * (docs/feat/clear-keeps-jobs.md). Sent ONCE: a re-open after a drop is an ordinary open.
   * Resolves `handOver` as the daemon answered, `null` when its answer had none (an older
   * daemon), `"lost"` when a drop ate the answer (the hand-over may or may not have happened). */
  async openHandingOver(sessionId: string, from: { sessionId: string; ifLast?: boolean },
    listener: SessionStreamListener, title?: SeedTitle): Promise<OpenResult["handOver"] | null | "lost">
  ```
  Body = `openSession`'s `sessionId !== undefined` branch (`:994-1004`) with `{ ...params, sessionId, handOverFrom: from }` passed to `openOn`; `result === undefined` → `"lost"`; else `result.handOver ?? null`.

**2.2 Client `RemoteSession`** (`packages/client/src/remote-session.ts`).
- `export type HandOverOutcome = { kind: "handed"; jobs: number; agents: number } | { kind: "kept" } | { kind: "none" } | { kind: "unsupported" } | { kind: "unknown" }` (in a new pure `packages/client/src/replace-session.ts`, re-exported by the package index).
- `whenOpened(): Promise<string | null>` — `this.id` if set; else `this.opening ? this.opening.then((id) => id, () => null) : null` (never rejects).
- `openHandingOver(from: RemoteSession): Promise<HandOverOutcome>` — only on a fresh session built without `attach`: `const fromId = await from.whenOpened(); if (fromId === null) return { kind: "none" }` (the old never reached the daemon: no work exists); else run `createOrAttach` with `{ sessionId: fromId, ...(from.closeIfLast ? { ifLast: true } : {}) }` (refactor `createOrAttach(handOverFrom?)` so the memoized `this.creating` is shared with a racing first send — `:338-364`), calling `client.openHandingOver(...)` instead of `openSession` when `handOverFrom` is given. Map: `"lost"` → `unknown`; `null` → `unsupported`; `outcome` `"handed"` → `handed` with counts; `"kept"` → `kept`; anything else → `none`. Rejects like `openSeeded` (the open failed).
- `closeIfLast` becomes readable (`readonly closeIfLast` or a getter).

**2.3 The ONE orchestration** (`packages/client/src/replace-session.ts`, pure async, no IO of its own, unit-tested with fakes):
```ts
export interface Replaceable<T> { openHandingOver(from: T): Promise<HandOverOutcome>; saveNow?(): void; close(): void; }
export type ReplaceOutcome = HandOverOutcome | { readonly kind: "failed"; readonly message: string };
/** `/clear`: open `next` taking `old`'s background work, then end `old`. NEVER rejects. */
export async function replaceSession<T extends Replaceable<T>>(old: T, next: T): Promise<ReplaceOutcome>
```
Rules (the decision table — Q6):

| `openHandingOver` → | old's final save (`saveNow`) | `old.close()` |
|---|---|---|
| `handed` | yes, BEFORE the close | yes |
| `kept` / `none` | no | yes (today's close; `kept` → its `ifLast` only detaches) |
| `unsupported` (older daemon) | no | yes — today's behaviour; jobs die (Q5) |
| `unknown` (answer lost) | no | **no** — the work may still be in the old one (Q6) |
| rejected → `failed` | no | **no** — nothing moved; the old keeps running its work (Q6) |

Every `await` is inside one `try`; the function returns a value on every path (Bun exits on an unhandled rejection).

**2.4 Runtimes** — the TUI gets a new optional factory `replaceSession(old, onReplaced) → SessionController`:
- `packages/cli/src/local-runtime.ts`: `LocalRuntime` (`:64`) gains `readonly replaceSession: (old: SessionController, onReplaced?: (o: ReplaceOutcome) => void) => PersistingController`. Implementation: `next = createSession()`; if `old` is one of `controllers` (`:747`) → `void replaceSession(old, next).then((o) => { onReplaced?.(o); })` (the `.then` callback wrapped in `try`); else `old.close?.()`. `PersistingController` gains `openHandingOver(from: PersistingController): Promise<HandOverOutcome>` = `confirmed = false; const o = await inner.openHandingOver(remoteOf(from)); await saveOnOpen(); return o;` — `remoteOf` reads a module-private `WeakMap<PersistingController, RemoteSession>` filled in `persistingController` (no public accessor). `saveNow` already exists (`:497-500`).
- `packages/cli/src/connect.ts:216`: `replaceSession: (old, onReplaced) => { const next = track(client.newSession(undefined, crypto.randomUUID())); if (old instanceof RemoteSession) void replaceSession(old, next).then(...); else old.close?.(); return next; }` (`connect` keeps no laptop copy; the `serve` daemon persists both).
- `packages/cli/src/attach-run.ts:510-523`: wrap `runtime.replaceSession` exactly like `createSession` (presence + `autoAccept.use` follow the new id).
- `packages/cli/src/main.ts:1046` → also `replaceSession: run?.replaceSession ?? runtime.replaceSession`; `:1837` → `replaceSession: runtime.replaceSession`. The in-process fallback (`main.ts:1863`) passes none: `/clear` there keeps today's behaviour (Notes).

**2.5 TUI.**
- `App.tsx:343` / `run.tsx:42,137`: `readonly replaceSession?: (old: SessionController, onReplaced?: (o: ReplaceOutcomeView) => void) => SessionController;` (`ReplaceOutcomeView` is a local structural copy — the TUI does not depend on `@tentacle/client`, the `send-now.ts` precedent).
- `/clear` (`App.tsx:1857-1862`):
  ```ts
  case "/clear": {
    const old = sessionRef.current;
    if (replaceSession && old) {
      const next = replaceSession(old, (o) => {
        const text = clearHandOverNotice(o);
        if (text !== null && sessionRef.current === next) pushNotice(text);
      });
      swapSession(next);
    } else { old?.close?.(); swapSession(makeSession()); }
    return;
  }
  ```
  (`next` is declared before the callback can run: the callback is always asynchronous.)
- New pure `packages/tui/src/clear-handover.ts`: `clearHandOverNotice(o): string | null` —
  `handed` with `jobs + agents > 0` → `_carried over from the previous session: 2 background jobs, 1 sub-agent — their exits will be reported here_`; `handed` 0/0, `none` → `null`; `kept` → `_the background jobs stay with the previous session: another terminal is on it_`; `unsupported` → `_this daemon is older: the previous session's background jobs were stopped — update tentacle there_`; `unknown` → `_could not confirm the hand-over: the previous session was left open with its background jobs (/sessions)_`; `failed` → `_could not move the background jobs (${message}): they keep running in the previous session (/sessions)_` (on runtimes without `/sessions` the old session ends at quit as today). Singular/plural by count.

### Decisions on the owner's open points (recommendations; final answers in Q1–Q9)

- **Wake (Q10 rules), Q8.** A handed job is the new session's job: an exit AFTER the hand-over streams `background_exit` from the new session (`hosted-session.ts:611-621`) and kicks its wake exactly like an own job (serve `autoWake`, the TUI's `wakeStep`). An exit pending at the hand-over arrives as the open result's `unflushedExits` (`connection.ts:459-460`), so the TUI's existing open-time rule applies; the daemon does NOT self-kick at construction (no extra wake path). The carried-over note is history, not a pending exit: it never wakes (Q10 holds).
- **`connect` multi-device, Q1.** QN1 stands: `/clear` closes the old session for every device, so its work moves with this device's new session. The other device gets `session_closed` (its "closed elsewhere" path) and finds the new session in `/sessions` (with its `jobs` count).
- **Persistence.** OLD: `subagent_handed` entries in its log (serve: written by `persistHandOff`, then archived by the close; laptop: the final save in `replaceSession` reads them before the close). Its load then says "moved to a new session" instead of "lost". NEW: its first segment carries the re-emitted `subagent_background` (+`end`) markers and the carried-over note (serve: the constructor's first persist `:682`; laptop: `openHandingOver`'s `saveOnOpen`). A restart of the daemon later kills the children; the NEW session's load then says "lost" — true.
- **Pod `run`/`attach` and the relay.** Pod daemons persist nothing; the laptop's two saves above cover them. A detached run's TUI is `closeIfLast` and the relay is attached to the run's session, so while the relay lives `/clear` gives `kept` (the work stays in the run's session, which the relay watches: `relay.ts:425-432`); after the hand-over to the TUIs (relay gone), it is `handed`, and the new session's `jobs` count keeps the workload in `quitPlan`/`exitPlan` ("others", `relay-state.ts:287-291`).
- **A handed child's ask.** Re-homed (Q3): same `requestId`, no `turnId` (`spawnTurns` is per session, D10), offered by the new session at attach; the old session emits `permission_resolved{cancelled}` for it. Later asks of that child go to the new session through the swapped requester (probe: `NEW asked late`).
- **Quit confirm counts after `/clear`.** The new session's first snapshot carries the handed children (`cut.subagents`, §1.5.7); the old emitted `subagents: []`; the TUI resets its list on swap (`App.tsx:1522`).
- **`agent_kill` / `shell_kill` of a handed id** from the new session: same `AgentJobs` / `JobController` objects → works. From the old session after the hand-over: it is closed right after; in the one-round-trip window its old agent still holds the registries (Notes).

### Files (dependency order)

Part 1 (`feat/clear-keeps-jobs`):
1. `packages/protocol/src/session.ts` — `handOverFrom`, `handOver`, comment block.
2. `packages/protocol/src/session-log.ts` — `subagent_handed` schema, union, critical table, module comment. Then `bun run schema:export` (`packages/protocol/schema/protocol.json`).
3. `packages/core/src/model.ts` — two `NOTE_KIND`s.
4. `packages/core/src/agent-job-ledger.ts` — `"handed"`, `handOver(ids?)`, `handed()`, `subagentHandedNote`, `noteSeen`/`fromHistory`/`segmentFacts`/`loadNotes`/`subagentLoadNotes`.
5. `packages/agent/src/session.ts` — `retireAgent()`.
6. `packages/agent/src/compact.ts` — `carriedOverNote`.
7. `packages/agent/src/session-store.ts` — `sessionTitle` skips noted messages.
8. `packages/daemon/src/session-title.ts` — `titleInput` skips noted messages.
9. `packages/daemon/src/session-log.ts` — `subagentHanded`.
10. `packages/daemon/src/hosted-session.ts` — §1.5.
11. `packages/daemon/src/session-host.ts` — §1.6.
12. `packages/daemon/src/connection.ts` — §1.7.
13. `packages/cli/src/wiring.ts`, `serve.ts`, `worker.ts` — §1.8.
14. Tests (below), this doc's Execution.

Part 2 (`feat/clear-keeps-jobs-ui`):
1. `packages/client/src/replace-session.ts` (new) + `packages/client/src/index.ts` export.
2. `packages/client/src/remote-client.ts` — `openOn` return, `openHandingOver`.
3. `packages/client/src/remote-session.ts` — `whenOpened`, `openHandingOver`, `createOrAttach(handOverFrom?)`, `closeIfLast` readable.
4. `packages/cli/src/local-runtime.ts` — `replaceSession`, `PersistingController.openHandingOver`.
5. `packages/cli/src/connect.ts`, `attach-run.ts`, `main.ts` — wiring.
6. `packages/tui/src/clear-handover.ts` (new), `App.tsx`, `run.tsx`.
7. `CHANGELOG.md` (the planned line below), `TODO.md` on merge.

### CHANGELOG (planned line, `### Changed`, with Part 2)

"**`/clear` keeps your background work running.** Background shell jobs and background sub-agents started in the old conversation are carried over to the new one instead of being stopped: they stay listed (the status line's sub-agent count, `/sessions`), their exit or report arrives in the new conversation with its command or description, and the agent there is told what it took over. The old conversation, if reopened, says where they went. If another terminal is on the session (a detached run's relay or TUI), they stay with it. `connect` to an older `serve` still stops them, and says so."

### Failure modes

| # | Case | Converges to |
|---|---|---|
| 1 | **A job/child ends DURING the hand-over** (inside the daemon's stretch) | Impossible: the stretch is synchronous and exits fire from promise callbacks (load-bearing assumption, probe). Before it → the OLD agent's pending exit → moved by `retire`/`adoptExits` → delivered at the new session's next turn (and reported as `unflushedExits`). After it → the NEW session's listeners (probe). |
| 2 | **An exit while the client's open is in flight** (after `/clear`, before the daemon handles it) | The TUI no longer watches the old stream, so no live notice; the exit is pending in the old agent → moved → `unflushedExits` ≥ 1 in the open result → the TUI's open-time wake rule / the next turn delivers it, self-contained. Never lost. |
| 3 | **`/clear` twice quickly** (A→B, B→C before B opened) | `C.openHandingOver(B)` awaits `B.whenOpened()`; B's open (with `handOverFrom: A`) lands first, then C's moves B's (adopted) work. A and B are closed by their own `replaceSession`. If B's open failed: `whenOpened` → null → C is `none` and the work stays in A (not closed: `failed`). |
| 4 | **`/clear` mid-turn** | `handOff` aborts the old turn (`controller.abort()`); the old turn unwinds `cancelled`; the client's close follows. A tool already running in that turn may still start a job before it sees the abort: that job lands in the shared registry, i.e. in the NEW session (listed and reported there, but not in the carried-over note). No kill, no loss. |
| 5 | **Old session never opened** (no send before `/clear`) | `whenOpened` → null → `none`; the new session stays lazy; nothing existed to move. |
| 6 | **Nothing to hand** (no running job/child, no pending exit, no background ask) | `hasBackgroundWork()` false → today's path exactly: fresh registries, old close disposes nothing of value. Outcome `none`, no notice. |
| 7 | **A second client on the old session — `connect`** | Close for all (QN1); the work moves; the other device follows "closed elsewhere" and can attach the new session from `/sessions`. |
| 8 | **A second client — detached run (`closeIfLast`)** | `kept`: nothing moves, the close only detaches, the work stays with the session that stays alive (relay / other TUI). Notice says so. |
| 9 | **Daemon (`serve`) restart after a hand-over** | Old (archived): its log has `bg` + `subagent_handed` → the reopen note "moved to a new session". New: `bg` re-emitted → "lost" note (the children died with the daemon); shell jobs die as on any restart. A crash in the instant between the old's and the new's persist (two independent per-id writes) can leave the old saying "moved" with the new not yet on disk: the children died anyway; the note's claim ("reported there") is then unmet — accepted, ms window, recorded. |
| 10 | **Laptop final save of the old session fails or times out** | The old laptop log lacks `subagent_handed` → a later `--resume` of the old session shows today's "lost" note for those children: the conservative claim ("check before redoing"), never a silent drop. The new session's file is saved at its open (`saveOnOpen`). |
| 11 | **Factory ignores `reuse` / constructor throws** | `foreign` → `InternalError` before `handOff`: nothing moved; the client gets `failed` and does NOT close the old (its work keeps running there). A constructor throw after `handOff` disposes the moved registries and rethrows: one honest end, never two owners. |
| 12 | **`TooManySessions` / link down at the open** | `admit()` throws before `build` → nothing moved → `failed` → old not closed. |
| 13 | **Answer lost to a drop** | `unknown` → old not closed (it may still hold the work). The re-open after the drop is an ordinary open (no `handOverFrom`: `openOn` callers on reconnect never pass it). |
| 14 | **Version skew: new client, older daemon** | The daemon strips `handOverFrom`, creates a fresh session, no `handOver` in the result → `unsupported` → old closed as today (jobs die) + notice. **Older client, newer daemon**: never sends the field → today's behaviour. **Older laptop build reading a log with `subagent_handed`**: non-critical → skipped → today's "lost" note. |
| 15 | **A handed child's ask is answered in the new session after its own signal aborted** | `adoptBackgroundAsks` settles an already-aborted one `cancelled` at once; a later abort settles through the new session's `onAbort`. |
| 16 | **The old session's other device answers the old dialog in the window** | `resolve_permission` on the OLD session: the ask is gone from its map → the existing "unknown request" path; the old session already emitted `permission_resolved{cancelled}` so its clients dropped the dialog. |
| 17 | **`handOverFrom` names a session open on another connection, or not live** | `none`: nothing moves. One token is one principal, so this is not a security boundary; the rule is "only what THIS connection opened", like `lookup` (`connection.ts:416-426`), so a stray id can never pull work out of a session someone else is driving. |
| 18 | **`handOverFrom` with an id that is live (a retried create)** | The live branch attaches; `handOver: none`. |
| 19 | **In-process fallback (worker unavailable)** | No `replaceSession` factory → today's `/clear` (jobs die). Recorded in Notes. |
| 20 | **A throw in `onReplaced` / the notice** | Inside the `.then` callback's `try`; the `replaceSession` promise never rejects. |

### Tests

Red before green for every row: write the test, show it failing on this tree (missing symbol or wrong behaviour), then implement. Then apply the mutation, see red, revert. Use the existing fakes: `FakeJobs` (`packages/daemon/test/unflushed-exits.test.ts:42`), the `AgentJobs` + fake-run pattern of `packages/daemon/test/subagent-background-host.test.ts`, `SpyBroker` where a broker is spied. No real processes in unit tests.

**Part 1**

| # | File · name | Property | Mutation that must turn it red |
|---|---|---|---|
| T1 | `core/test/agent-job-ledger.test.ts` · "handOver(ids) carries only the named jobs and closes them in the old ledger" | ids subset moved; others still `running()`; a later `end` of a moved id → `null` | ignore `ids` (move all) |
| T2 | same · "a `subagent_handed` after `bg` (running or ended) loads as the handed note, never lost/report" | `subagentLoadNotes` returns exactly `subagentHandedNote` for both | drop the `subagent_handed` branch in `subagentLoadNotes` |
| T3 | same · "a handed note closes its id: a second load returns []; fromHistory reserves and closes it" | idempotent load | `noteSeen` ignores `subagentHanded` |
| T4 | same · "an orphan `subagent_handed` (no bg) gives the note without description; segmentFacts never re-emits a handed job" | | remove the `handed` skip in `segmentFacts` |
| T5 | `protocol/test/session-log.test.ts` · "`subagent_handed` parses, is non-critical, leaves the projection" | `LOG_ENTRY_CRITICAL.subagent_handed === false`; `projectEntry` → `null`, list unchanged | set it `true` |
| T6 | `agent/test/session-store.test.ts` + `daemon/test/session-title.test.ts` · "the title skips noted user messages" | history `[system, note, user "fix the build", assistant]` → title from "fix the build" | remove the `note === undefined` filter |
| T7 | `daemon/test/clear-hand-over.test.ts` (new) · "a job exiting after a hand-over is streamed ONLY by the new session" | new attachment gets `background_exit` with the command; old gets none; new `summary().jobs` 1, old 0 | skip `unsubscribeExit` in `handOff` (old also streams) |
| T8 | same · "a child ending after a hand-over: the new log has bg (first segment) + end, the old log has bg + subagent_handed; the report note lands at the new session's next turn" | read both logs via `session/log` | skip `adopt` (new `end` → `null`, no marker) |
| T9 | same · "an exit pending in the old agent is delivered at the new session's first turn; the open result says `unflushedExits: 1`" | | skip `adoptExits` |
| T10 | same · "a child's ask pending at the hand-over is offered by the new session (same requestId, no turnId), answered there, and the child receives it; the old emitted `permission_resolved` cancelled" | | skip `adoptBackgroundAsks` (child never resolves: test times out at 1 s → red) |
| T11 | same · "a child's NEW ask after the hand-over is raised by the new session" | | build the new session WITHOUT `reuse.permissions` |
| T12 | same · "nothing to hand → fresh registries, `handOver.outcome: none`, old close disposes as today" | new `reusable().jobs !== old's` | always hand off |
| T13 | same · "ifLast with another client attached → `kept`, nothing moves, job still the old session's" | | drop the `attachedCount > 1` check |
| T14 | same · "`handOverFrom` not open on this connection → `none`" | second connection names the first's session | use `this.host.get` instead of `this.attached` |
| T15 | same · "a factory that ignores `reuse` → `InternalError`, and NOTHING moved (old still streams its job's exit)" | | call `handOff` before the `foreign` check |
| T16 | same · "closing the old session after a hand-over kills nothing" | `FakeJobs.disposed === false`, `AgentJobs` child still running | keep the old fields (don't clear) |
| T17 | same · "the new session's first snapshot lists the handed child; the old emitted `subagents: []`" | | drop the `cut.subagents` init |
| T18 | same · "a hand-over mid-turn aborts the old turn (`turn_end` cancelled) and the job is the new session's" | | drop `controller.abort()` |
| T19 | same · "the new history starts with the carried-over note listing `bg-1` and `sa-1`; it is not a pending exit (no wake)" | `pendingExitCount` unchanged by it; `maybeWake` does not start a turn for it | count the note as an exit / omit the note |
| T20 | `daemon/test/daemon-state-file.test.ts` (or the serve-store test that already round-trips `subagent_end`) · "`subagent_handed` round-trips the serve log and a reopen appends the handed note" | real decoders | drop the type from the union |
| T21 | `cli/test/wiring.test.ts` (or `serve` / `worker` factory tests) · "every factory honours `reuse` (serve, worker, pod both branches)" | `jobs`/`agentJobs`/`permissions` are the passed objects | drop `reuseOptions` from one factory |
| T22 | `daemon/test/connection-*.test.ts` · "the result carries `handOver` iff the params had `handOverFrom`" | | always omit it |

**Part 2**

| # | File · name | Property | Mutation |
|---|---|---|---|
| U1 | `client/test/replace-session.test.ts` (new, fakes) · the decision table | per outcome: `saveNow` called before `close` only for `handed`; `close` not called for `unknown`/`failed`; never rejects (a throwing fake) | close before save; close on `failed` |
| U2 | `client/test/remote.test.ts` · "`handOverFrom` rides only the first open; the reconnect's re-open omits it" | fake peer records params | keep it on the entry |
| U3 | same · "no `handOver` in the result → `unsupported`; a drop before the answer → `unknown`" | | map `null` to `none` |
| U4 | `client/test/remote-session.test.ts` · "/clear twice: C's open waits for B's and names B's id" | | read `from.id` without `whenOpened` |
| U5 | `cli/test/local-runtime.test.ts` · "replaceSession: the new session is saved at its open; the old file's last save holds `subagent_handed`" | real worker host in-process (existing harness) | drop `saveNow` |
| U6 | `cli/test/attach-run.test.ts` · "presence follows replaceSession's new id" | | wrap only `createSession` |
| U7 | `tui/test/clear-handover.test.ts` (new) · the notice per outcome, plural/singular, `null` for 0/0 and `none` | | |
| U8 | `tui/test/app.test.tsx` · "/clear with `replaceSession` calls it with the current session and never `close`; without it, `close` then a fresh session" | spy controllers | call `close` too |
| U9 | `client/test/clear-keeps-jobs.e2e.test.ts` (real `SessionHost` + `Connection`, `FakeJobs`) · "a job survives `/clear`: its exit lands in the new session, the old is closed" | | old path (close first) |

### Validation (both parts)

Narrow test files while iterating (§4); before "done": `bun test` (baseline: all pass except the three opt-in skips), `bun run typecheck`, `bun run lint` (baseline clean). Re-run the probe; paste its output in Execution.

### Notes / debt (deliberate)

- **In-process fallback** (`session-jobs.ts`, used only when the worker is unavailable) keeps today's `/clear` (jobs die): it has no daemon and no RPC; its own factory would need a parallel hand-over (§7 "one session path" says don't).
- **Shell jobs leave no fact in the old log**: a reopened old session's model sees `started bg-1` and no exit, as after any restart today (shell jobs were never persisted). Only children get the `subagent_handed` note.
- **One round-trip window** after the daemon's hand-over and before the client's close: the old agent still references the shared registries (its `shell_kill`/new launches would act on the new session's work). It is closed right after; `connect`'s other device would have to act inside that window.
- **The carried-over note lists running work only**: an ended-undelivered child or an exited job arrives as its own exit note at the new session's next turn.
- **Approvals do not carry** (Q4 a): the new chat asks again; a handed child keeps the approvals it was started with (its gate captured the old `SessionGrants`).

## Owner questions

*— claude-opus-5-5, 2026-11-09* — every question has a recommendation; the plan above is written for the recommended answers.

**Q1 — `connect`, another device on the old session at `/clear`.** (a) QN1 stands: the old session closes for every device and its work moves to this device's new session; the other device sees "closed elsewhere" and can attach the new one from `/sessions`. (b) With another device attached, `/clear` only detaches this device and the work stays with the old session (changes QN1 for `connect`). **Recommend (a)**: it is today's contract plus the hand-over, and "the work follows the person who typed `/clear`".

**Q2 — Tell the new chat's model what it took over?** (a) Yes: one carried-over note at the start of the new history ("Carried over from the previous session by /clear … Background jobs still running: bg-1 `npm run dev` …", the same text compaction uses). (b) No: the model learns of them only from their exit notes (it may start a second dev server on the same port). **Recommend (a).**

**Q3 — A handed child is waiting on a permission ask at `/clear`.** (a) Move the ask to the new session (same request, asked again there, no turn link). (b) Answer it "cancelled" at `/clear` (the child's tool call is refused, the child goes on). **Recommend (a)**: (b) silently refuses something the user never saw answered.

**Q4 — Session approvals ("Yes, always for this session").** (a) The new chat starts with none; a handed child keeps the approvals it was started with. (b) Carry them to the new chat. **Recommend (a)**: `/clear` is a fresh start; approvals were given to a conversation that is gone.

**Q5 — Version skew (a newer client on an older `serve`/pod daemon).** (a) No `PROTOCOL_VERSION` bump: the client sees no `handOver` in the open result, closes the old session as today (its jobs die) and says so in a notice. (b) Bump to 21, so the pair is refused at connect with "update". **Recommend (a)**: additive fields are the forward-compat path (`unflushedExits` precedent); a bump would refuse every older daemon for a feature only `/clear` uses.

**Q6 — The new session's open fails (too many sessions, link down) or its answer is lost.** (a) Leave the old session open with its work running (notice: "they keep running in the previous session — /sessions"); it ends at quit as today on runtimes without `/sessions`. (b) Close it anyway (its work dies, as today). **Recommend (a)**: the owner's rule is "never kill on `/clear`".

**Q7 — Reopening the OLD session.** (a) A note per moved sub-agent: "sa-2 (map the repo) was moved to a new session by /clear; its result is reported there, not here." (b) No note, the id is silently closed. **Recommend (a)**: otherwise the old chat's model waits for a report that never comes there.

**Q8 — Wake of the new session on a handed exit.** (a) Same rules as its own jobs (serve `autoWake`, the TUI's `autoWake`; an exit pending at `/clear` counts as `unflushedExits` at the open). (b) Never wake for handed work; deliver at the next user turn. **Recommend (a)**: one rule; a handed job IS the new session's job.

**Q9 — The split.** Part 1 (daemon seam, ~16 files, L, merged first, dormant until Part 2) on `feat/clear-keeps-jobs`; Part 2 (client + runtimes + TUI, ~10 files, M) on `feat/clear-keeps-jobs-ui`, each with its own mandatory fresh-context review. **Recommend: approve the split.** (One branch would be ~26 files across both kinds of risk.)
