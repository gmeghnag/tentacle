# feat/clear-keeps-jobs — `/clear` resets the conversation inside the session; background work stays

> **Status:** review round 2 2026-11-09 — **PASS** (round-1 findings fixed; one new LOW, L8; see Review)
> **Branch:** `feat/clear-keeps-jobs` (this worktree, off `main` `ac2da32`) — ONE branch
> **Type:** feat · **Size:** M (~16 files, mostly small edits; the reset reuses an existing, proven barrier) · **Blast:** load-bearing (a `PROTOCOL_VERSION` bump, the daemon's busy slot, a log segment) · **Suited:** Sonnet (`claude-sonnet-5-5`) executes (owner, 2026-11-09; no new state machine: one new daemon method that calls the compaction barrier); **mandatory fresh-context Opus review** red-teaming §7 "Protocol", "Persistence" and "Don't serialize the RPC peer"

Vocabulary: **job** = a background shell job (`bg-N`); **child** = a background sub-agent (`sa-N`); **background work** = both, plus their exits not yet delivered and a child's unanswered ask.

## Context

*— claude-opus-5-5, 2026-11-09 (rev. in-session reset)*

**Owner requirement (2026-11-09, binding).** `/clear` must not kill the session's running background shell jobs or background sub-agents. Their exit notices must land in the new chat, self-contained (command / description).

**Owner direction (2026-11-09, binding, replaces the hand-over plan).** `/clear` no longer switches session. It resets the conversation INSIDE the same session, like `context_reset`: a new log segment, an empty history. Jobs, children, their pending asks and exits simply stay. Nothing is handed over.

**Today.** `/clear` is `sessionRef.current?.close?.(); swapSession(makeSession())` (`packages/tui/src/App.tsx:1857-1862`). The close disposes both registries daemon-side: `this.jobs?.dispose()` (`packages/daemon/src/hosted-session.ts:2504`) and `this.agentRuntime?.dispose()` (`:2509`).

**Rejected: hand-over between sessions** (the plan at `d50bafb`). Modelling `/clear` as close + open forced a daemon-side broker/registry swap, a re-home of pending asks, two logs that must agree (an old-session note), a two-phase answer for a lost open, multi-device and `ifLast` cases, version skew, and two branches. All of it exists only because the work changes owner. With the reset in-session, the owner never changes. The probe below shows the existing barrier already keeps everything wired.

**Repro (capability gap, this tree, 2026-11-09).**

```
$ rg -n 'close\?\.\(\);' packages/tui/src/App.tsx
1861:          sessionRef.current?.close?.();      ← /clear
$ rg -n 'jobs\?\.dispose\(\)|agentRuntime\?\.dispose\(\)' packages/daemon/src/hosted-session.ts
2504:    this.jobs?.dispose();
2509:    this.agentRuntime?.dispose();
$ rg -n '"session/clear"|"clear"' packages/protocol/src   → no matches
```

## Implementation

*— claude-opus-5-5, 2026-11-09 (rev. in-session reset)*

### Load-bearing assumption

**If the history is replaced inside the same `HostedSession` through `historyReplaced` (the barrier that compaction and `context_reset` use), the background work stays wired.** After it, a running child's ask is still raised by the same session. Its end lands in the NEW log segment, which re-emits its `subagent_background` marker. Its exit and a job's exit still stream from the same session and stay pending for the next turn. The `subagents` list still names the child.

Why it should hold: the barrier touches only the history, the cut and the log. It sets a new epoch, puts `subagents: this.lastSubagents` in the cut and starts a new segment (`log.replaced`). It then re-emits the ledger's facts (`logSegmentFacts`) and offers the background asks again (`hosted-session.ts:2391-2428`). The registries, the broker's requester, the agent and its `pendingExits` are not touched at all. `Session.compact` replaces the array in place and calls the barrier synchronously (`packages/agent/src/session.ts:237-256`).

**Proven by probe** (`.tentacle/tmp/clear-keeps-jobs/probe-reset.ts`, run 2026-11-09 on this tree). It uses a real `SessionHost`, `HostedSession`, `Agent`, `AgentJobs` and `PermissionBroker`, plus a fake `JobController`. A child (`sa-1`) runs. The history is replaced by `hosted.compact()`, the existing caller of the barrier between turns. After that, the child asks through the broker and ends, and the job `bg-1` exits.

```
$ bun run .tentacle/tmp/clear-keeps-jobs/probe-reset.ts
subagents n=1
--- reset (compact) ---
history_replaced(compact)
compact before=3 after=2
permission_request turnId=-
background_exit bg-1
subagents n=0
background_exit sa-1
log from last base: base(compact) message message title subagent_background(sa-1) checkpoint subagent_end(sa-1)
pendingExits (next turn delivers): 2
summary jobs=0
history now: system:sys | user:Summary of the earlier conversation (compacted to save context):
```

Every point of the assumption holds:
- the ask after the reset is raised by the same session;
- both exits stream from it;
- the new segment carries `subagent_background(sa-1)` (re-emitted at the segment start) and then `subagent_end(sa-1)`;
- both exits are pending for the next turn, which delivers them as self-contained notes (`agent.ts:1877-1922`);
- the list went 1 → 0 only when the child ended.

`/clear` therefore needs no new wiring. It only needs a different replacement history and a different barrier `reason`. Re-prove it with T5–T8 before any other slice.

### Preconditions (verified on this tree)

| Fact | Where |
|---|---|
| `/clear` today; `/compact` is the template (a daemon RPC, refused mid-turn, a settle callback) | `packages/tui/src/App.tsx:1857-1862`, `:1883-1933` |
| The daemon's `compact()`: takes the slot (`assertIdle`), replaces through the barrier, then `persist()`, `log.checkpoint()`, `kickWake()` in `finally` | `hosted-session.ts:2339-2383` |
| The barrier: new epoch, cut keeps `subagents`, `log.replaced`, `logSegmentFacts`, `history_replaced`, `reofferBackgroundAsks` | `hosted-session.ts:2391-2428` |
| The head the session installed (`compactionSummary` = first user message) keeps `awaitsAnswer` false | `hosted-session.ts:1749-1751,2398` |
| `context_reset` runs the same barrier mid-turn | `hosted-session.ts:1972-1977` |
| `Session.compact`: in-place replace, `forgetModelRequestBaseline`, `onReplaced`, `persist` | `packages/agent/src/session.ts:237-256` |
| The still-running text compaction and context reset already give the model | `packages/agent/src/compact.ts:233-253`; `agent.ts:570-583` (`runningBackground`) |
| Wire: `history_replaced.reason` is `z.enum(["compact","context_reset"])`, class `mandatory` | `packages/protocol/src/updates.ts:191-194,320` |
| A new value in a `mandatory` update needs a `PROTOCOL_VERSION` bump (an older client fails the turn) | AGENTS §7 "Protocol"; `packages/protocol/src/version.ts:14` (`20`) |
| `session/compact` wiring: method, schemas, daemon dispatch, client call (`"once"`, never re-sent) | `protocol/src/methods.ts:66`; `protocol/src/session.ts:273-283`; `daemon/src/connection.ts:243-244,362`; `client/src/remote-client.ts:1405-1409`; `client/src/remote-session.ts:664` |
| The client turns a replacement into a `history` activity; only `context_reset` takes the in-turn path | `client/src/remote-session.ts:100,1170-1192,1245,1315-1318` |
| The TUI: an own compaction keeps the screen (`none`), a foreign one only gets a notice | `tui/src/turn-feed.ts:73-86`; `tui/src/App.tsx:1451-1466` |
| Log `base.reason` is a CRITICAL entry's enum `["create","seed","reload","compact","context_reset"]`; `compact` / `context_reset` are "superseding" for `keepSuperseded` | `protocol/src/session-log.ts:104,116-124`; `daemon/src/session-log-store.ts:552-556,700` |
| `keepSuperseded`: default off; the replaced history is not kept, and nothing can view a kept segment ("`--resume` shows the current context either way") | `config/src/key-docs.ts:743-750` |
| The laptop saves after a compaction (`compact(){ await inner.compact(); flush() }`) | `cli/src/local-runtime.ts:433-437` |
| Session approvals: ONE `SessionGrants` shared by the main gate AND the sub-agent runner, so running children use the same object and the same ask lane | `cli/src/wiring.ts:485,526`; `agent/src/agent.ts:545`; `agent/src/subagent.ts:233`; `agent/src/permission-gate.ts:111,161-179`; `agent/src/session-grants.ts:23-49` |
| Title: `auto` / `model` / `user`; `setTitle` logs, persists and emits; `session_title.source` is `["model","user"]` | `daemon/src/session-title.ts:125-152`; `hosted-session.ts:2268-2277`; `protocol/src/updates.ts:214-218` |
| Title derivation uses the first user message (a note would become the title) | `agent/src/session-store.ts:74-81`; `daemon/src/session-title.ts:52-67` |
| Wake: `lastEndBad` (a cancelled turn stops the chain), `maybeWake` on `pendingExitCount` | `hosted-session.ts:491,2065,2110-2164` |
| `NOTE_KIND`; an unknown note kind renders as a plain notice | `core/src/model.ts:83-90`; `tui/src/resume.ts:13-28` |

### Design

**Shape.** A new daemon method `session/clear{sessionId}` → `{before, after}`, a sibling of `session/compact`. It is synchronous and atomic: either it refuses before touching anything, or it replaces the history through the existing barrier with `reason: "clear"`. Every attached client follows it: the reducer resyncs on the barrier, the `history` activity carries `reason: "clear"`, and every TUI REPLACES its transcript. The session id, the registries, the broker, the agent and its pending exits are untouched. That is the whole "jobs stay" mechanism (probe).

**1. Protocol** (`packages/protocol/src/`).
- `methods.ts:66`: `Clear: "session/clear"`.
- `session.ts` (beside `CompactParams/Result`, `:273-283`): `ClearParamsSchema = z.object({ sessionId: SessionIdSchema })`; `ClearResultSchema = z.object({ before: z.number().int().nonnegative(), after: z.number().int().nonnegative() })`. Doc comment: "Reset the conversation in place (docs/feat/clear-keeps-jobs.md). Idle only: a running turn → `TurnInProgress`, a compaction → `CompactInProgress`, nothing changed. Background jobs, sub-agents, their asks and exits stay."
- `updates.ts:193`: `reason: z.enum(["compact", "context_reset", "clear"])`. Its doc says what `clear` is: a between-turn replacement that clients show as a new, empty chat.
- `version.ts:14`: `PROTOCOL_VERSION = 21` (a new value in a `mandatory` update; QA).
- Log: NO change. A `/clear` segment's `base.reason` is `"compact"`. `base` is critical and its reason is an enum (`session-log.ts:104,121`), so a new value would make an older build refuse the whole file (an on-disk version bump). `"compact"` already has the right meaning for the store (superseding, `session-log-store.ts:700`). The daemon passes `"compact"` to `log.replaced` for `clear`.
- `bun run schema:export`.

**2. Core** (`packages/core/src/model.ts:83-90`): `NOTE_KIND.stillRunning = "still_running"` ("what was still running when the chat was cleared").

**3. Agent** (`packages/agent/src/`).
- `session.ts`, after `compact`: `clearConversation(onReplaced?: () => void): { before: number; after: number }` — SYNCHRONOUS. (Plan fix, found at execution: it was `clear`, which collided structurally with the TUI's async `SessionController.clear?()`: the in-process `Session` would have been taken for a clear-capable controller. Renamed; see Execution.)
  ```
  const before = this.messages.length;
  const running = this.agent.runningBackground();
  const text = stillRunningNote(running.jobs, running.agents);
  const next = [...this.agent.startConversation(),
                ...(text !== "" ? [{ role: "user", content: text, note: { kind: NOTE_KIND.stillRunning } }] : [])];
  this.messages.length = 0; this.messages.push(...next);
  this.agent.forgetModelRequestBaseline(this.id);
  onReplaced?.(); this.persist();
  return { before, after: this.messages.length };
  ```
  Skills active in the old chat are NOT carried over: a cleared chat starts like a new session.
- `session-grants.ts:23`: `clear(): void` → `this.grantedTools.clear(); this.shellPrefixes.length = 0;` The ask lane (`busy`, `waiters`) is untouched, so a running ask is not disturbed (QB).
- `session-store.ts:75`: `messages.find((m) => m.role === "user" && m.note === undefined)`.

**4. Daemon** (`packages/daemon/src/`).
- `session-title.ts:53`: `findIndex((m) => m.role === "user" && m.note === undefined)`. Otherwise the still-running note would become the next generated title's input.
- `hosted-session.ts`:
  - `historyReplaced(reason: "compact" | "context_reset" | "clear")` (`:2391`): call `this.log.replaced(this.session.messages, reason === "clear" ? "compact" : reason, this.cut.turnId)` and emit `history_replaced{reason}` unchanged. Nothing else in the barrier changes.
  - New public method `clear(): { before: number; after: number }`, placed after `compact()` (`:2339-2383`). SYNCHRONOUS, in this order:
    1. `this.assertIdle();` — a turn or a compaction holds the slot → throws, nothing changed (atomic, Q6).
    2. `this.abortTitle();` and clear `titleKick` (as `close` does, `:2469-2472`).
    3. `const result = this.session.clearConversation(() => this.historyReplaced("clear"));`
    4. `this.grants?.clear();` (QB).
    5. Title: `if (this.title.source === "model") { this.title = { source: "auto" }; }`. A `user` rename stays: it names the session, which goes on. The segment's `title` entry is written by `logSegmentFacts` inside the barrier. It reflects the new state only if the title is reset BEFORE step 3, so **do step 5 before step 3**.
    6. `this.lastEndBad = false;` — a fresh chat: an earlier stop or failure no longer blocks the wake (Q8).
    7. `this.lastChangeAt = this.now(); this.lastActiveAt = this.now();`
    8. `this.persist(); this.log.checkpoint(); this.publishQueue(); this.kickWake();` (as `compact`'s `finally`, `:2374-2381`). `kickWake` re-checks pending exits: with `autoWake`, an exit that waited behind a stopped turn may wake now.
    9. `return result;`
- `connection.ts:243-244`: `case Method.Clear: return this.clear(params as ClearParams);` where `private clear(params): ClearResult { return this.lookup(params.sessionId).clear(); }`. Synchronous, no lock (AGENTS §7 "Don't serialize the RPC peer").

**5. Client** (`packages/client/src/`).
- `remote-client.ts`, beside `compact` (`:1405-1409`): `clear(sessionId): Promise<ClearResult>` via `sessionCall(sessionId, Method.Clear, { sessionId }, "once")`. It is not re-sent after a drop: a lost answer converges through the resync (FM 4).
- `remote-session.ts`:
  - `clear(): Promise<{ before: number; after: number }>` mirrors `compact()` (`:664`), after the session is open.
  - Activity type (`:100`): `reason: "compact" | "context_reset" | "clear" | null`.
  - `:1192`: `reason: compacted ? replaced.reason : null` (today it hard-codes `"compact"`). `replaced.reason` is `"compact"` or `"clear"` here, because `"context_reset"` returned at `:1173`.

**6. CLI** (`packages/cli/src/local-runtime.ts:433-437`): the persisting controller gains `async clear() { const r = await inner.clear(); flush(); return r; }`. That is the laptop's save of the new segment. With `keepSuperseded` off it rewrites the file to the new segment (`session-log-store.ts:552-556`).

**7. TUI** (`packages/tui/src/`).
- `SessionController` (`App.tsx` ~`:225-260`): `clear?(): Promise<{ before: number; after: number }>`.
- New pure `clear-command.ts`:
  ```ts
  export type ClearStep = "clear" | "stop_then_clear" | "busy" | "compacting" | "legacy";
  export function clearCommandStep(i: { canClear: boolean; running: boolean; ownTurn: boolean;
    compacting: boolean; clearing: boolean }): ClearStep
  ```
  Order: `!canClear` → `"legacy"` (a session without `clear`: the in-process fallback keeps today's close + new session); `clearing` → `"busy"`; `compacting` → `"compacting"`; `running && ownTurn` → `"stop_then_clear"`; `running` (another device's turn) → `"clear"`, and the daemon answers `TurnInProgress`, shown as the failure notice; else `"clear"`.
  Plus `clearFailedNotice(message: string): string` → `` `_/clear failed: ${message} — still in this session_` `` and `CLEARED_ELSEWHERE_NOTICE = "_the conversation was cleared on another device_"`.
- `turn-feed.ts:73-84` `historyAction`: `reason` gains `"clear"`, and `"clear"` → `"replace"` (own or foreign).
- `App.tsx` `/clear` (`:1857-1862`): run the step. (Plan fix: `/clear` is in `SESSION_MUTATING` (`commands.ts`), so the App refused it mid-turn before any step ran. The guard now exempts `/clear` only when the session can `clear`; the legacy path stays refused mid-turn.)
  - `"legacy"` → today's two lines.
  - `"busy"` / `"compacting"` → a notice.
  - `"stop_then_clear"` → stop the own turn the way Esc does. Set `clearAfterTurnRef = true`; the post-turn path (where `wakeIfPending` runs) sees it, clears it, and runs `"clear"`.
  - `"clear"` → `clearingRef = true; void session.clear().then(onOk, onErr)`.
    - `onOk`: `clearingRef = false`. The transcript is replaced by the `history{reason:"clear"}` activity, not here.
    - `onErr`: `clearingRef = false; pushNotice(clearFailedNotice(message))`. Both callbacks are wrapped so nothing escapes.
- `App.tsx:1451-1466` history branch: for `reason === "clear"` → `resetHistory` (as `replace`). If it is not own (`ownClearsRef`, counted like `ownCompactionsRef`), also push `CLEARED_ELSEWHERE_NOTICE`. Also `setExpandAll(false); setExpandedIds([])`. The wake state, the sub-agent list and queued rows are NOT reset: it is the same session.

### Owner's earlier answers, re-mapped

- **Q2 (a)** — the cleared chat starts with ONE note naming what still runs, built by `stillRunningNote` (the text compaction and context reset use). If nothing runs, there is no note and the history is just the system prompt. The note is user-role and is the installed head (`compactionSummary`), so it never makes `awaitsAnswer` true and it never wakes.
- **Q4 (a)** — conflicts with the code. See **QB**: the approvals store is ONE object shared by the main agent and every running child (`wiring.ts:485,526`).
- **Q6 (atomic)** — holds by construction. `clear()` either throws at `assertIdle` (nothing changed) or completes synchronously with no failure point after the replacement (the barrier "must not throw", `:2389`). The client keeps the screen until the daemon's `history` activity arrives. An error leaves everything as it was and shows the notice.
- **Q8 (a)** — same session, same agent, same `pendingExits`: wakes as for its own jobs (probe: `pendingExits 2`). `clear` also resets `lastEndBad`, so a stop-then-clear does not silence the wake.
- **Q1 (`connect`, another device on the session)** — it sees the cleared chat: its reducer resyncs on the barrier, its TUI replaces the transcript and says `_the conversation was cleared on another device_`. Not a decision: the session is shared, and so is its conversation.
- **Q3 (ask moves)** — moot: asks never move. A child's ask is re-offered after the barrier (`:2427`; probe `permission_request` after the reset). A turn's own ask cannot exist: `/clear` needs an idle slot, and stop-then-clear cancels it first.
- **Q5 (version skew)** — superseded by **QA**: one bump to 21, no shims.
- **Q7 (old-session note)** — moot: there is no old session. What the user loses is **QC**.
- **Hook trust** (project hooks trusted for this session): stays. It is keyed by the session id (`agent.ts:818-823`) and is about the project, not the conversation.
- **`/clear` mid-turn**: own turn → stop, then clear at its end. Another device's turn → `TurnInProgress` → failure notice; retry later.
- **`/clear` with a child's ask open**: the dialog stays; it is re-offered right after the barrier.
- **Pod `run`/`attach`, the relay**: the same RPC on the pod daemon. The laptop saves the new segment through `PersistingController.clear` → `flush`. The relay keeps its session (same id); its `jobs` count and keep-awake are unchanged. A detached run's other TUIs see the cleared chat.
- **Quit confirm counts** — unchanged: same session, same `subagents` list (the cut keeps it, `:2413`).

### Files (dependency order)

1. `packages/protocol/src/methods.ts`, `session.ts`, `updates.ts`, `version.ts`; `bun run schema:export` (`packages/protocol/schema/protocol.json`).
2. `packages/core/src/model.ts`.
3. `packages/agent/src/session.ts`, `session-grants.ts`, `session-store.ts`.
4. `packages/daemon/src/session-title.ts`, `hosted-session.ts`, `connection.ts`.
5. `packages/client/src/remote-client.ts`, `remote-session.ts`.
6. `packages/cli/src/local-runtime.ts`.
7. `packages/tui/src/clear-command.ts` (new), `turn-feed.ts`, `App.tsx`.
8. `CHANGELOG.md` (the line below), this doc's Execution; `TODO.md` on merge.

### CHANGELOG (planned line, `### Changed`)

"**`/clear` keeps your background work running.** `/clear` now empties the conversation inside the same session instead of starting a new one. Background shell jobs and background sub-agents keep running: they stay in the status line's count and in `/sessions`, and their exit or report arrives in the cleared conversation with its command or description. The agent there is told what is still running. The approvals you gave for this session are cleared. A cleared conversation is no longer kept as a separate session in `--resume` / `/sessions` (see QC). Another terminal on the same session sees it cleared too. The protocol version moved to 21: an older pod daemon or `serve` is refused at connect with "update"."

### Failure modes

| # | Case | Converges to |
|---|---|---|
| 1 | **A job/child ends during `/clear`** | Impossible inside it: `clear()` is synchronous, and exits fire from promise callbacks (probe of the first plan, `background.ts:102`, `agent-jobs.ts:311-332`). Before it: the exit is pending in the agent and survives (probe). After it: streamed by the same session and delivered at the next turn. |
| 2 | **A turn is running (own)** | Stop, then clear at the turn's end (TUI latch). If the clear then fails, the turn was still stopped: that was the user's intent. The failure notice says the chat was not cleared. |
| 3 | **A turn is running (another device's) / a compaction** | `TurnInProgress` / `CompactInProgress` before any change → `/clear failed: … — still in this session`. |
| 4 | **The answer is lost (link drop)** | No stranded state is possible: one session. The client's resync takes the daemon's truth. If the clear landed, the replay (`history_replaced{clear}`) or the snapshot (`history`, reason `null` → `replace`) shows the cleared chat; if not, nothing changed. The promise rejects → the failure notice, worded "no answer — the screen follows the daemon when the link is back" when the error is a link error. A retry clears an already-cleared chat: harmless. |
| 5 | **`/clear` twice quickly** | The second gets `"busy"` from the latch. If it is sent after the first settled, it clears an empty chat (idempotent in effect). |
| 6 | **Another device on the session** | It sees the cleared chat and a notice (Q1). |
| 7 | **The session is closed by another device meanwhile** | `UnknownSession` → failure notice; then the existing "closed elsewhere" path. |
| 8 | **Daemon (`serve`) restart after a clear** | The reload continues the log lineage from the new segment: the still-running note in the history, `subagent_background` re-emitted → the "lost" note for children that died with the process. Unchanged rules (task 5). |
| 9 | **Laptop save after the clear fails** | Today's save-failure path (`onFlushError`). The next save retries; the file keeps the previous segment until then, never a half-written one (atomic replace, `session-log-store.ts:9`). |
| 10 | **Pod link drops during `/clear`** | As 4; the pod daemon keeps the session (and the work), the laptop re-attaches. |
| 11 | **Version skew** | Refused at `initialize` (`VersionMismatch`, protocol 21), both directions. |
| 12 | **The in-process fallback (worker unavailable)** | Its `Session` has no `clear` → `"legacy"` → today's behaviour (jobs die). Recorded in Notes. |
| 13 | **A child's ask open at `/clear`** | Re-offered right after the barrier; answered as before. Its `turnId` (if any) names a turn no longer shown: display only. |
| 14 | **A throw in the TUI's settle** | Both callbacks are wrapped; the promise chain never rejects unhandled. |
| 15 | **Title** | A `model` title becomes `auto` (listed as the first non-note user message, then regenerated after the first exchange). A `user` rename stays. Clients keep showing the old model title until the new one arrives: `session_title` cannot say `auto` (Notes). |

### Tests

Red before green for each row. Then apply the mutation, see red, revert. Fakes: `FakeJobs` (`packages/daemon/test/unflushed-exits.test.ts:42`); the `AgentJobs` rig of `packages/daemon/test/subagent-background-host.test.ts`; the probe above is the template for T5–T8.

| # | File · name | Property | Mutation that must turn it red |
|---|---|---|---|
| T1 | `protocol/test/*` · "`history_replaced` accepts `clear`; `session/clear` schemas; version 21" | | drop `"clear"` from the enum |
| T2 | `agent/test/session.test.ts` · "`clear` leaves `[system, still-running note]` with jobs/children running, `[system]` without; it calls `onReplaced` once, synchronously" | | always append the note / call `onReplaced` after a microtask |
| T3 | `agent/test/session-grants.test.ts` · "`clear` empties tools and prefixes; a waiter in the lane is still admitted" | | reset the lane too |
| T4 | `agent/test/session-store.test.ts` + `daemon/test/session-title.test.ts` · "the title skips noted user messages" | | drop the `note === undefined` filter |
| T5 | `daemon/test/clear.test.ts` (new) · "after `clear`, a running child's ask is raised by the same session and its end lands in the new segment after its re-emitted `subagent_background`" | the log read from the last `base` | skip `logSegmentFacts` in the barrier |
| T6 | same · "a job's and a child's exit after `clear` stream from the same session and are pending for the next turn; that turn delivers both notes" | | dispose `jobs` in `clear` |
| T7 | same · "the `subagents` list survives `clear` (snapshot after it names the child)" | | `subagents: []` in the cut for `clear` |
| T8 | same · "`clear` emits `history_replaced{clear}` but logs `base.reason: compact`" | | log `"clear"` (a reader's `LogBaseReasonSchema` refuses it) |
| T9 | same · "`clear` refuses during a turn and during a compaction, and changes NOTHING (history, grants, title, log)" | compare before/after | do any step before `assertIdle` |
| T10 | same · "`clear` empties the session approvals" | `grants.covers(...)` false after | skip `grants.clear()` |
| T11 | same · "a model title becomes auto, a user title stays; the new segment's `title` entry says so" | | reset the title after the barrier |
| T12 | same · "after a stopped turn, `clear` re-enables the wake: a pending exit wakes (serve `autoWake`)" | | skip `lastEndBad = false` |
| T13 | same · "the still-running note is the installed head: a send-now after `clear` with nothing queued is `NoTurnRunning`" | | not `compactionSummary` (it is set by the barrier: mutate by appending the note after `onReplaced`) |
| T14 | `daemon/test/connection-*.test.ts` · "`session/clear` dispatches without a lock: a `session/clear` and a `session/resolve_permission` interleave" | | await anything before `clear()` |
| T15 | `client/test/remote.test.ts` · "a `history_replaced{clear}` raises a `history` activity with reason `clear`; `clear()` is not re-sent after a drop" | fake peer | hard-code `"compact"` at `:1192` |
| T16 | `cli/test/local-runtime.test.ts` · "`PersistingController.clear` saves the new segment (keepSuperseded off: the file holds only it)" | | drop `flush()` |
| T17 | `tui/test/clear-command.test.ts` (new) · the step table and the notices | | swap the `running`/`ownTurn` order |
| T18 | `tui/test/turn-feed.test.ts` · "`historyAction` of `clear` is `replace` for own and foreign" | | return `none` for own |
| T19 | `tui/test/app.test.tsx` · "/clear replaces the transcript with the still-running notice, keeps the sub-agent count, calls no `close`; on refusal the transcript is unchanged and the failure notice shows; a session without `clear` takes the legacy path" | frames | call `close` |
| T20 | `client/test/clear.e2e.test.ts` (real `SessionHost` + `Connection` + `RemoteClient`, `FakeJobs`) · "a job survives `/clear`: its exit lands in the same, cleared session; a second client sees the cleared chat" | | — |

### Validation

Narrow test files while iterating (§4). Before "done": `bun test` (baseline: all pass except the three opt-in skips), `bun run typecheck`, `bun run lint` (baseline clean). Re-run `probe-reset.ts` and paste its output in Execution.

### Notes / debt (deliberate)

- **In-process fallback** (`cli/src/session-jobs.ts`, used only when the worker is unavailable) keeps today's `/clear`: its `Session` has no daemon barrier.
- **Log `base.reason` stays `compact` for a clear**: adding `clear` would be an on-disk version bump for no reader. If a segment viewer ever exists, it can tell a clear by its head (the `still_running` note or none, never a summary).
- **`session_title` cannot say `auto`**: clients show the old model title until the next one arrives. Adding `auto` to `session_title.source` would ride the same bump; left out to stay narrow.
- **No skills carried over**: a cleared chat starts like a new session (the agent's system prompt rebuilt by `startConversation`).

## Owner questions

*— claude-opus-5-5, 2026-11-09 (rev. in-session reset)* — only real decisions; the plan above is written for the recommended answers.

**QA — Protocol bump.** (a) Add `clear` to `history_replaced.reason` and bump `PROTOCOL_VERSION` to 21. Every device then REPLACES its screen on a clear. (b) No bump: reuse `reason: "compact"` on the wire. Only the clearing TUI resets its screen; other devices keep the old chat on screen with "_compacted on another device_" until they re-attach, which contradicts Q1's "the other device sees the cleared chat". **Recommend (a)**: pre-public, a bump that makes the design honest is allowed; the method alone would be additive, but the barrier's new meaning is a `mandatory` change.

**Owner (2026-11-09): (a) — add `clear` to `history_replaced.reason` and bump `PROTOCOL_VERSION` to 21.**

**QB — Approvals vs running children (your Q4 (a) does not fit the code).** The "always for this session" approvals live in ONE `SessionGrants` object, shared by the main agent's gate and the sub-agent runner, with ONE ask lane (`cli/src/wiring.ts:485,526`, `agent/src/subagent.ts:233`). (a) `/clear` clears it for everyone: a running child asks again for anything not yet approved (more prompts, never fewer). (b) Keep the child's approvals: split the store per generation (a new object for the main agent and future children, the old one kept by running children), which also splits the ask lane, so two dialogs could race. **Recommend (a)**: the safe direction, one line of code, and the lane stays single.

**Owner (2026-11-09): (a) — `/clear` clears the session approvals for everyone (running children ask again).**

**QC — The old chat is no longer a separate session.** Today `/clear` leaves the old chat in `--resume` / `/sessions`. With the reset it is a superseded segment: dropped from the file when `keepSuperseded` is off (default), kept but unviewable when on (no viewer exists, `config/src/key-docs.ts:743-750`). (a) Accept the loss, like compaction today; the CHANGELOG says so. (b) `/clear` forks the old history into its own read-only session (a new id, the old messages), listed in `--resume` / `/sessions`: the laptop store writes it from its own copy (the `saveAside` machinery, `daemon/src/session-log-store.ts:367-388`, under a normal name), and `serve` writes it as an archived record. The live session keeps its id and its jobs. About +M, both stores. (c) Always keep the superseded segment for a clear, and build a viewer later. **Recommend (b) as its own follow-up task (`feat/clear-fork-history`), right after this one**, shipping this task with (a) meanwhile. The fork does not touch the background work, so it does not belong in this load-bearing branch, and (c) keeps bytes nobody can see.

**Owner (2026-11-09): (b), as a follow-up task `feat/clear-fork-history` right after this one; THIS task ships with (a) (the loss is stated in the CHANGELOG).**

## Execution

*— claude-sonnet-5-5, 2026-11-09*

**Status: PARTIAL** — everything in the plan is built and gated, but the items under "Not done / not verified" below are open, and the mandatory fresh-context Review has not run.

### Re-proof of the load-bearing assumption (first step)

`bun run .tentacle/tmp/clear-keeps-jobs/probe-reset.ts` re-run on this tree before any edit, and again after the last edit: identical output (ask by the same session, both exits streamed, `subagent_background(sa-1)` re-emitted at the segment start then `subagent_end(sa-1)`, `pendingExits 2`, `subagents` 1 → 0 only when the child ended). The daemon tests T5–T8 then pin it on the real `clear()` path.

### Done, in the plan's Files order

1. **Protocol** — `methods.ts` (`Method.Clear`, `RequestSchemas`), `session.ts` (`ClearParams/Result`), `updates.ts` (`reason` gains `clear`, doc), `version.ts` (`PROTOCOL_VERSION = 21` + comment), `schema:export` (`protocol.json`). T1 = `protocol/test/clear.test.ts`; `json-schema.test.ts` got the two `session/clear` fixtures.
2. **Core** — `NOTE_KIND.stillRunning = "still_running"` (`core/src/model.ts`).
3. **Agent** — `Session.clearConversation` (`session.ts:266`), `SessionGrants.clear` (`session-grants.ts`), `sessionTitle` skips noted user messages (`session-store.ts`).
4. **Daemon** — `titleInput` skips noted user messages (`session-title.ts`); `HostedSession.clear()` (`hosted-session.ts:2392`) in the plan's order with the title reset BEFORE the barrier; `historyReplaced` accepts `"clear"` and logs `base.reason: "compact"` for it; `Connection` case + `clear()` (`connection.ts:248,367`), synchronous, no lock.
5. **Client** — `RemoteClient.clear` (`"once"`, `remote-client.ts:1411`), `RemoteSession.clear` (`remote-session.ts:664`), the activity `reason` now carries `clear`, and `history` takes `replaced.reason` instead of the hard-coded `"compact"`.
6. **CLI** — `PersistingController.clear` = `inner.clear()` then `flush()` (`local-runtime.ts:440`).
7. **TUI** — new pure `clear-command.ts` (`clearCommandStep`, `clearFailedNotice`, `clearErrorNotice`, `CLEARED_ELSEWHERE_NOTICE`); `turn-feed.ts` (`historyAction`: `clear` → `replace`); `App.tsx`: `SessionController.clear?`, refs `clearingRef/ownClearsRef/clearAfterTurnRef/runClearRef`, `runClear` (`:1857`, both settle paths wrapped in try/catch, nothing escapes a void promise), the `/clear` case (`:1948`), the stop-then-clear latch consumed in the turn's settle block (`:1338,1353`), the `history{clear}` branch (resets `expandAll`/`expandedIds`; pushes the "cleared on another device" notice AFTER the replace, only when not own), and `swapSession` resets the three refs.
8. **Docs** — CHANGELOG `[Unreleased]` / Changed entry (says the old chat is no longer kept as a separate session); owner answers recorded under QA–QC; metadata `Suited:` set to Sonnet; this section. `TODO.md` untouched (as instructed).

### Drift from the Implementation (and why)

- **`Session.clear` → `Session.clearConversation`.** The plan's name made the in-process agent `Session` structurally satisfy the TUI's `SessionController.clear?(): Promise<…>` with a *synchronous* method; `tsc` caught it (`App.tsx:695`). Worse, the TUI would have taken the in-process fallback for clear-capable and called a sync reset with no daemon barrier. Renamed (agent, daemon call, agent test, doc).
- **Mid-turn `/clear` was refused before any step ran.** `/clear` is in `SESSION_MUTATING` (`commands.ts`), so the App's guard (`App.tsx:1934`) printed "Can't run /clear while a turn is running". The guard now exempts `/clear` only when the session can `clear`; the legacy close-and-replace stays refused mid-turn (test T19f). Found by T19e failing, not by reading.
- **Four exact-version pins moved with the bump**, not in the plan: `protocol/test/subagent-background.test.ts` and `subagents-update.test.ts` (`toBe(20)` → `>= 20`), `daemon/test/version-mismatch.test.ts` (`toBe(20)`, the worded message `daemon 20` and `protocol: 20` → 21; test title extended).
- **Extra `clearErrorNotice`** (plan FM 4 asked for the "no answer — the screen follows the daemon when the link is back" wording on a link error): pure, matches `/not retried/i` (the client's `DROPPED_NOT_RETRIED` text; the TUI cannot import the client). Not in the plan's file list.
- **Tests added beyond the table:** `T19f` (legacy refused mid-turn), the `clearErrorNotice` row in T17, a second T2 case (nothing running → just the system prompt), and `clear-connection.test.ts` for T14 (a new file, not an edit of `connection-*.test.ts`).
- The stale barrier comment ("except `/clear`'s new session") was corrected.

### Evidence per test (RED, then GREEN, then mutation → RED → restored)

RED = the failing run on the tree before that slice's implementation. Honest limit: for T1, T17 and T14 the RED was an import / missing-symbol error (the symbol did not exist yet); their *assertion* red is the mutation run.

| T | RED (before the slice) | GREEN | Mutation → result |
|---|---|---|---|
| T1 `protocol/test/clear.test.ts` | import error: `ClearParamsSchema` not exported | 3 pass | drop `"clear"` from the enum → "history_replaced accepts reason clear" fails (`Expected: true / Received: false`) |
| T2 `agent/test/session.test.ts` | 2 fail (`clearConversation` missing) | 2 pass | `if (true)` (always append the note) → the "nothing running" case fails |
| T3 `agent/test/session-grants.test.ts` | fail | pass | `waiters.length = 0` in `clear` → timed out 5000 ms (waiter lost) |
| T4 `agent/test/session-store.test.ts`, `daemon/test/session-title.test.ts` | 2 fail | pass | drop the `note === undefined` filters → both fail |
| T5–T13 `daemon/test/clear.test.ts` | 9 of 9 fail (`hosted.clear` missing) | 9 pass | T5: skip `logSegmentFacts` → T5 + T11 red · T6: `jobs.dispose()` in clear → T6 red · T7: `subagents: []` for clear → T7 red · T8: log `"clear"` as `base.reason` → T5 + T8 red · T9: grants+title reset before `assertIdle` → T9 red · T10: skip `grants.clear()` → T10 red · T11: title reset after the barrier → T11 red · T12: skip `lastEndBad = false` → T12 red · T13: `compactionSummary = undefined` → T13 red |
| T14 `daemon/test/clear-connection.test.ts` | the first run failed on my own test (a prompt answers at the turn's *start*): fixed by retrying until idle | pass | `await` a never-resolving promise before `clear()` → timed out 5000 ms |
| T15 `client/test/foreign-turns.test.ts`, `reattach.test.ts` | 2 fail (`session.clear` missing) | 85 pass | hard-code `"compact"` → foreign-turns T15 red · `"keyed"` instead of `"once"` → reattach T15 red |
| T16 `cli/test/local-runtime.test.ts` | fail (`ctl.clear` undefined) | 70 pass | drop `flush()` → T16 red |
| T17 `tui/test/clear-command.test.ts` | import error (module absent) | pass | swap the `running`/`ownTurn` branch → "own running turn" row red |
| T18 `tui/test/turn-feed.test.ts` | fail (`notice`/`none` returned) | pass | `none` for an own clear → red |
| T19a–f `tui/test/clear.test.tsx` | a, b, c, e fail (d is the unchanged legacy path: green on both, by design; f added after e's root cause) | 6 pass | legacy path always → a, b, e red · no stop-then-clear → e red · exempt `/clear` from the guard for every session → f red |

Every mutation was a `cp` backup → edit → run → `cp` restore; the `shasum` after restoring matched the pre-mutation hash for `hosted-session.ts` (`4b364a2b…`) and `App.tsx` (`199bcb9f…`); the other files were restored from backup and checked with `git diff` showing only the intended hunks.

### Gate (this tree, final)

- `bunx tsc --noEmit`: clean. `bunx tsc -p apps/mobile`: clean.
- `bunx biome check .`: clean (0 errors, 0 warnings; one `--write` pass fixed formatting/import order in 7 files).
- `bun test packages` (final run): **6114 pass, 3 skip (the opt-in ones), 1 fail** — `packages/exec/test/confinement.test.ts` "F2: a hard link to a file outside every root…". It is unrelated to this change (no file under `packages/exec` is touched) and it is **not stable**: across my three full runs the `exec` failures were 2, 0, then 1; `bun test packages/exec` alone is 92 pass / 0 fail. I did not run it on a pristine `main` (no git state changes allowed), so "pre-existing" is an inference, not a measurement. The one other failure I hit (`version-mismatch.test.ts`) was mine and is fixed.
- `bun test scripts` (reads `CHANGELOG.md`): 39 pass.

### Not done / not verified

1. **The `packages/exec` flake above** is not proven pre-existing on `main`.
2. **T20** (`client/test/clear.e2e.test.ts`, real `SessionHost` + `Connection` + `RemoteClient`, "a job survives `/clear` and a second client sees the cleared chat") **was not written.** The pieces are covered separately (daemon T5–T8 on the real `HostedSession`; client T15 over a real daemon with two devices for the `history{clear}` activity; connection T14), but no single test runs a job exit through the whole stack after a clear.
3. **T19 "keeps the sub-agent count"** (frames) is not asserted: the App does not touch the sub-agent list on a clear and no test raises one. By construction only.
4. **Failure modes 7 (session closed elsewhere during the clear), 8 (`serve` restart after a clear), 9 (laptop save fails after the clear), 10/11 (pod link drop, real version skew)** have no dedicated test. 9 is the existing `onFlushError` path; 11 is the existing `VersionMismatch` test (updated to 21); 8 follows the unchanged reload rules; 7 and 10 follow the `UnknownSession` / link-drop paths. None was exercised for `/clear` specifically.
5. **Not run in a real terminal / real pod / real `serve`.** Everything above is unit/integration with fakes (`FakeJobs`, in-memory channels, ink-testing-library). The in-place `/clear` has not been seen end to end by a person.
6. **Title (FM 15):** clients keep showing the old model title until the next one arrives (`session_title` cannot say `auto`) — as planned, unchanged.
7. **The fresh-context Opus Review (mandatory for this blast radius) has not been done.** This section is the implementer's own account.
8. `TODO.md` was not touched, per instruction; nothing was committed.

### Fix round 1

*— claude-sonnet-5-5, 2026-11-09*

Every finding of the Review is fixed. Each has a test that failed first; the RED/GREEN/mutation evidence is per finding. Where a test is red only by reverting the fix (the fix was already in when the test was written, e.g. the App's L6 bookkeeping), it is marked "RED by revert". All mutations: `cp` backup → edit → run → `cp` restore → `shasum` unchanged.

**H1 — the worker dropped `grants`.** `packages/cli/src/wiring.ts` (new `workerSessionBuild(wired)`, the ONE mapping that carries `agent, permissions, jobs, agentJobs, grants, titleModel`); `packages/cli/src/worker.ts` (the factory is `return workerSessionBuild(wired)`). `grants` stays OPTIONAL in `AgentBuild` (`session-host.ts`, now documented): making it required was tried and produced **90 tsc errors in test factories**, so the review's alternative was taken instead — `HostedSession.clear` (`hosted-session.ts:2406-2413`) no longer uses `?.`: a session without a store reports `"/clear: this session has no approvals store; its session approvals were kept"` through the turn-error sink, and still clears. I audited every production factory: `serve.ts:186` and `:523` spread `buildAgent`'s result whole (they carry `grants`); only the worker dropped it.
- RED: `packages/cli/test/worker-grants.test.ts` failed (`workerSessionBuild` missing); `daemon/test/clear.test.ts` "H1 a session built WITHOUT an approvals store reports it…" failed on `toEqual`. GREEN: 2 + 11 pass. Mutation: drop `grants:` from `workerSessionBuild` → "`grants` is the SAME store…" red (`1 pass / 1 fail`); also a guard test that `worker.ts` calls `workerSessionBuild(wired)`.
- Not done: no test drives the real worker thread end to end (the worker file runs side effects on `globalThis` at import); the mapping function and the source guard stand in for it.

**H2 — wake racing an in-flight clear.** Reproduced first: `T19g` in `tui/test/clear.test.tsx` models the REAL order (RPC answer first, `history{clear}` 25 ms later): RED `send#2` started with `historyArrived=false` (`Expected - 1 / Received + 1` on the events). The fix is in two layers, the second ordered on the daemon's sequence numbers, not by a client guard:
- *Client reducer, ordered by the barrier's seq* — `packages/client/src/remote-session.ts` (`onReset`: `compacted = replaced !== null && replaced.reason !== "clear"`, with the reason in the comment). A compaction holds the slot, so no own prompt can be in flight at its barrier; a `/clear` does not. An own turn that starts after the barrier (a wake or a prompt) now takes the barrier's snapshot IN-TURN (`history_reset`), never a separate `history{clear}` that the App holds and replays after the turn. New test `client/test/clear-race.test.ts` (real daemon, snapshot read delayed 60 ms): RED with the old condition (`Expected to contain "history_reset(0)"`), GREEN with the fix. The daemon-driven (`serve` autoWake) half is `clear.e2e.test.ts` T20b below: each device sees the cleared history first, then the wake turn.
- *TUI latch (the review's a–d)* — `App.tsx`: (a) both wake gates now use `blocked: clearingRef.current` (the job-exit effect too, not only `wakeIfPending`); (b) `runClear`'s `onOk` no longer releases or wakes (except a `{0,0}` no-op clear, L6b); (c) the `history` branch releases the latch on a `clear` or a snapshot (`reason: null`) and calls `wakeIfPending()` after the commit; (d) `onErr` releases and calls `wakeIfPending()`. Extra, found while designing the in-turn path: the stream loop also releases the latch on a `history_reset` event (otherwise a clear whose snapshot went in-turn would leave the latch up for ever) — test `T19l`.
- RED/GREEN/mutations: `T19g` GREEN. Mutation `blocked: false` in `wakeIfPending` → T19g red · no `wakeIfPending()` in `onErr` → `T19i` (a refused clear releases the stranded wake) red · drop the latch release in the `history` branch → T19g red · drop the `history_reset` release → `T19l` red.
- Verified end state: with a wake pending, the final frame has the wake reply AND the still-running note (the wake turn runs in the cleared chat and stays); or, if the clear is refused, the wake runs afterwards (T19i).
- Not verified: the stack was not driven by the real `App` over the real `RemoteSession` (the App tests use a fake controller in the real order; the client tests use the real stack without the App).

**M3 — latch dropped by a send-now.** `App.tsx` settle block, the send-now branch: `pushNotice("_/clear not run: a send-now started a new turn — run /clear again_")`. `T19h` (in `send-now-app.test.tsx`, a held turn + a slow send-now + `/clear`): RED (`Expected to contain "/clear not run"`, `clears` was 0 so the drop was silent) → GREEN; mutation (drop the notice) → red.

**M4a — T20 e2e.** `packages/client/test/clear.e2e.test.ts` (real `SessionHost` + `Connection` + 2 `RemoteClient`s, `FakeJobs`). T20a: B gets `history{reason: clear}` whose messages carry the `still_running` note; the job is not disposed; the exit reaches BOTH on the same session (`unflushedExits` 1); the next prompt's model call contains `user:background_exit` and no old user message; `unflushedExits` back to 0. T20b: with `wakeOnJobExit`, the daemon wakes by itself after the clear; B's activities are `history:clear` THEN `turn`; the wake's model call has the `still_running` and `background_exit` notes and no old prompt. Mutations: `jobs.dispose()` in `clear()` → T20a red · keep the old messages in `Session.clearConversation` → T20a + T20b red.

**M4b — `serve` reload after a clear (FM 8).** `packages/daemon/test/clear-reload.test.ts` (real `LogSessionStore` + `SessionPersister`; a running child; `clear()`; stop; reload). Asserts: the log file's last `base` is `reason: "compact"`, followed by `subagent_background`, and the segment holds no trace of the old chat; `record.paired === true` (the sidecar's entry is in that segment); the reloaded history is `[system, still_running note]`; the child becomes `subagent_lost:sa-1`; the restored session shows no old chat. Mutation: drop `this.persist()` in `clear()` → red (`Expected "compact", Received "seed"`: the file was never rewritten).

**L5 — in-flight title.** `daemon/test/clear.test.ts` "L5 …": a gated title model that ignores the abort signal, a first exchange, `clear()`, then release. Asserts no `session_title` after the clear and `source: "auto"`. Mutation (drop `abortTitle()` + the `titleKick` clear) → red (it SURVIVED before this test); restored (`hosted-session.ts` sha unchanged).

**L6 — `ownClearsRef` drift.** `App.tsx`: (a) a `/not retried/` error no longer decrements the count (the replayed history is still mine), and a `reason: null` history resets it to 0; (b) a `{0,0}` answer decrements and lets go. Tests `T19j` and `T19k`; RED by revert, each reverted line turned its test red, GREEN with the fix.
- Not verified: a link-drop clear that did NOT land leaves `ownClearsRef` +1 until the next snapshot, so a later foreign clear in that window shows no "on another device" notice. Accepted (cosmetic), not tested.

**L7 — CHANGELOG.** The second sentence now reads "it is no longer shown (with `sessions.keepSuperseded` on it stays on disk, like a compacted history)"; the approvals sentence is kept (true now that H1 is fixed).

**nit8** — `connection.ts`: `private clear` moved above `compact`'s doc comment, with its own "synchronous, lock-free" comment. **nit9** — kept both persists; a comment in `Session.clearConversation` says why.

**Gate (this tree).** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile` clean · `bunx biome check .` clean (801 files; one `--write` pass reformatted 2 new test files) · `bun test packages`: **6129 pass · 3 skip · 0 fail** (6132 tests, 425 files) — the `exec` confinement F2 flake did not fail this time, so there is no second run to report · `bun test scripts`: 39 pass.

**Not fixed / not verified in this round:** (1) `AgentBuild.grants` stays optional (see H1; the explicit report replaces the compile-time guarantee). (2) No test drives the real worker thread or the real `App` over the real `RemoteSession` (H1/H2 notes above). (3) The cosmetic L6a remainder above. (4) Optional FM 7/9/10 (existing paths) are still not tested for `/clear` specifically. (5) The fresh-context re-review of this round has not been done.

## Review

*— claude-opus-5-5, 2026-11-09* (fresh context; adversarial). **Model note:** the executor was Sonnet (a different model), but the **plan** was written by Opus, the same model as this reviewer, so the plan's blind spots may survive this pass. Both HIGH findings below are gaps the plan itself left.

### Verdict: **REQUEST-CHANGES**

The daemon core holds. `HostedSession.clear` is synchronous, it checks `assertIdle` first, and it reuses the proven barrier: the background work stays wired and the reset is atomic. Two defects block the merge. (1) The owner's QB decision ("approvals cleared for everyone") is silently a no-op on the **default local runtime**. (2) On stop-then-clear with a pending wake, the TUI runs a wake turn while the clear is in flight, and the late `history{clear}` then **wipes that turn from the screen** (confirmed by a probe).

### Gate (this review, this tree)

- `bunx tsc --noEmit`: clean · `bunx tsc -p apps/mobile`: clean · `bun run lint`: clean (797 files, 0 issues).
- `bun test packages`, run 1: **6115 pass · 3 skip · 0 fail** (6118 tests, 421 files, 184.9 s). Run 2: **6115 pass · 3 skip · 0 fail** (190.1 s). The 3 skips are the opt-in ones.

### Findings (ranked)

**H1 — QB is a no-op on the in-process worker (the default local runtime): approvals survive `/clear`.** `HostedSession.clear` calls `this.grants?.clear()` (`packages/daemon/src/hosted-session.ts:2406`). `hosted.grants` is set only from the factory's result (`packages/daemon/src/session-host.ts:922,958`). `buildAgent` returns `grants` (`packages/cli/src/wiring.ts:620-628`), and `serve` passes that object through whole (`cli/src/serve.ts:186,526,528`). The **worker** factory, however, rebuilds the object field by field and **drops `grants`** (`packages/cli/src/worker.ts:127-134`: `agent, permissions, jobs, agentJobs, titleModel`). So on plain `tentacle` (the worker path), `this.grants` is `undefined`, the `?.` hides it, and the "always allow" approvals of the main agent and of running children stay after `/clear`. That contradicts QB and the CHANGELOG line. T10 passes only because its rig injects `grants`.
- *Fix:* in `packages/cli/src/worker.ts:127-134`, add `grants: wired.grants,` to the returned object. Then make the field non-optional, so the compiler catches the next factory that forgets it: in `packages/daemon/src/session-host.ts:94`, change `readonly grants?: SessionGrants;` to `readonly grants: SessionGrants;`, and update the test factories that tsc then flags (give them `grants: new SessionGrants()`). If making it required is too wide, keep it optional, but in `HostedSession.clear` replace `this.grants?.clear()` with an explicit branch that reports a missing store (`this.onError?.(…)` / a log), never a silent `?.`.
- *Test (red first):* the tsc error from the required field is the red. In addition, add `packages/cli/test/worker-grants.test.ts`. Extract the worker's `createAgent` closure into an exported `workerAgentFactory(config, deps)` in `worker.ts`, then assert `factory(cwd).grants === <the SessionGrants the agent's gate uses>` (e.g. `remember` a tool on it, then check that `agent`'s gate `covers` it).

**H2 — stop-then-clear with a pending wake: a wake turn races the clear and its rows are wiped (CONFIRMED).** In the settle block (`packages/tui/src/App.tsx:1353-1356`), `runClearRef.current?.()` is followed at once by `wakeIfPending()`. `wakeIfPending` (`App.tsx:1092-1108`) gates on `idle` only (`blocked: false`), so its `setTimeout(0)` starts a continuation turn while `session/clear` is still in flight. The `history{clear}` activity then arrives during that turn. It is held (`nextStep` → `hold`, `App.tsx:1449-1454`) and replayed after the turn ends: `resetHistory` replaces the screen with `[note]`, and the wake turn's exchange disappears from screen, though the daemon still has it.
- *Probe:* `.tentacle/tmp/clear-keeps-jobs/review/wake-race.test.ts` (the real `App`, a fake controller, a fake `jobs` with `onExit`, `autoWakeOnJobExit: true`). Output on this tree: `send#1("first") · clear sent · send#2("") clearInFlight=true · clear answered`; the final frame shows only `Background jobs still running: none`, and `WAKE-REPLY-2` is gone. With `blocked: clearingRef.current` temporarily in the gate, the order was `clear sent · clear answered · send#2`, and the frame kept `WAKE-REPLY-2` (reverted; App.tsx hash restored `4d8bb4e0…`).
- *The real stack is worse than the probe.* The clear's RPC answer arrives **before** the history: the barrier makes the client send a separate `session/snapshot` (`client/src/session-reducer.ts:314-317`). So releasing `clearingRef` in `runClear`'s `onOk` (`App.tsx:1872`) and waking there is still early.
- *Fix (all four):* (a) `App.tsx:1101`: `blocked: clearingRef.current`. (b) `runClear` `onOk`: do NOT clear `clearingRef` and do not wake. (c) In the `history` branch (`App.tsx:1472+`): `if (clearingRef.current && (cleared || activity.reason === null)) clearingRef.current = false;`, and in its `commitHistory(...).then(...)` call `wakeIfPending()` after `drainHeld()`. A `null` reason covers a reconnect snapshot, so the latch cannot stick. (d) `runClear` `onErr`: after releasing, also call `wakeIfPending()`, otherwise the gate from (a) strands a pending wake until the next turn.
- *Test:* move the probe into `packages/tui/test/clear.test.tsx` as **T19g** with the REAL order: the fake `clear()` resolves first, then raises `history{clear}` ~15 ms later. Assert (1) no `send` starts while the clear is unresolved or before the history, and (2) the final frame contains the wake reply.

**M3 — the stop-then-clear latch is silently dropped when a send-now is pending.** `App.tsx:1338-1359`: `clearNow` is taken (and the latch reset) BEFORE the branch, but `runClear` runs only in the middle branch. If `pending && settleSendNow(pending)` holds, a new turn starts and the user's `/clear` vanishes with no notice: a silent drop.
- *Fix:* in the `else` branch (`App.tsx:1357-1359`), add `if (clearNow) { pushNotice("_/clear not run: a send-now started a new turn — run /clear again_"); }`.
- *Test:* T19h. Hold a turn, arm a send-now (as in the existing send-now App tests), type `/clear`, release. Assert `clears === 0` and that the notice is shown.

**M4 — required missing tests (load-bearing → before merge).**
- **T20 e2e** (the owner's core requirement, through the real `SessionHost` + `Connection` + `RemoteClient`, with `FakeJobs` from `daemon/test/unflushed-exits.test.ts:42`). Open a session, start `bg-1`, send `session/clear` from client A, then fire the job's exit. Assert (1) client B gets a `history` activity with `reason: "clear"`; (2) the exit streams to both on the SAME session id; (3) the next prompt delivers the `[background]` note. Mutation: `jobs.dispose()` in `clear()` → red.
- **FM 8 (`serve` reload after a clear)** — §7 Persistence. In the daemon persistence suite (the persister + reload rig of `daemon-side-persistence`), clear a session with a running child, let the persister land, reload a new host from the same store. Assert that the history is `[system, still_running note]`, that the log's last segment starts with `base.reason:"compact"` followed by `subagent_background`, that the sidecar's entry is in that segment, and that the child becomes the "lost" note. Mutation: skip `this.persist()` in `clear()` → the reload shows the old chat.
- Optional (existing paths, by construction): FM 7, FM 9, FM 10.

**L5 — mutation M5 SURVIVED: nothing pins the in-flight title abort.** Removing `abortTitle()` + the `titleKick` clear (`hosted-session.ts:2394-2398`) leaves all 16 tests of `clear.test.ts` + `session-title.test.ts` green. In that case a model title generated from the OLD chat lands after the clear.
- *Test:* in `daemon/test/clear.test.ts`, give a gated `titleModel`, end a first exchange (title generation starts), `clear()`, then release the gate. Assert `title.source === "auto"` and that no `session_title` was emitted after the clear.

**L6 — `ownClearsRef` bookkeeping drifts in two edge cases → wrong "on another device" notice.**
- (a) On a link drop (`/not retried/`), `onErr` decrements (`App.tsx:1883-1885`). If the clear did land and the resync is a replay of `history_replaced{clear}`, the TUI says "cleared on another device".
- (b) `RemoteSession.clear()` with no id yet returns `{0,0}` and raises no history (`client/src/remote-session.ts:664-669`), so `ownClearsRef` stays +1 forever and a later foreign clear shows no notice.
- *Fix:* (a) do not decrement when `/not retried/` matches; instead, reset `ownClearsRef` to 0 on any `history` activity with `reason: null` (a snapshot). (b) in `onOk`, `if (result.before === 0 && result.after === 0) ownClearsRef.current = Math.max(0, ownClearsRef.current - 1)`; or make `RemoteSession.clear` with no id reject "nothing to clear yet", like `rename`.

**L7 — CHANGELOG accuracy.** "The approvals … are cleared" is false on the worker until H1 is fixed. "It is gone, as after a compaction" ignores `sessions.keepSuperseded` (the segment is then kept, though nothing can show it). *Fix:* after H1, keep the approvals sentence; change the second to "it is no longer shown (with `sessions.keepSuperseded` on it is kept on disk, like a compacted history)".

**nit8 — misplaced comment.** `packages/daemon/src/connection.ts:365-370`: `private clear` was inserted between `compact`'s doc comment ("`signal` is the request's own…") and `compact`. Move `clear` above that comment.

**nit9 — double persist.** `Session.clearConversation` calls `this.persist()` and `HostedSession.clear` calls `this.persist()` again. Harmless (the second is the one after the title/grants changes); leave it, or drop the inner call with a comment.

### Mutation non-vacuity (each reverted; `shasum` restored: `hosted-session.ts ead5c496…`, `remote-session.ts 40c4c34d…`, `App.tsx 4d8bb4e0…`; `git status` clean)

| # | Mutation | Origin | Result |
|---|---|---|---|
| M1 | `this.jobs?.dispose()` in `clear()` | executor T6 | **KILLED** (T6) |
| M2 | log `reason` as-is (`"clear"` as `base.reason`) | executor T8 | **KILLED** (T5, T8) |
| M3 | drop `this.lastEndBad = false` | executor T12 | **KILLED** (T12) |
| M4 | drop `this.kickWake()` from `clear()` | reviewer | **KILLED** (T12) |
| M5 | drop `abortTitle()` + `titleKick` clear | reviewer | **SURVIVED** → L5 |
| M6 | `blocked: clearingRef.current` in `wakeIfPending` (fix probe, not a mutation of a test) | reviewer | flips the H2 probe red → green |

### Gate flake (`packages/exec` confinement F2): **not caused by this branch**

Two full runs on this branch gave 0 fails. `git diff main...HEAD -- packages/exec packages/tools` is empty. The branch's new tests touch no shared filesystem state: `daemon/test/clear.test.ts` uses `/tmp/clear-keeps-jobs` only as a string `cwd` with a no-op `writeFile` env, `clear-connection.test.ts` the same, and T16 is in-memory. F2 does real `link`/`writeFile` in its own arenas under the default 5 s timeout. The executor's 2/0/1 pattern fits a load-dependent timeout (parallel worktree suites), not a leak from this diff. I did not run `main`'s tree, since the exec code and test are byte-identical on both.

### Premise table (Implementation → code)

| Premise | Verdict |
|---|---|
| Today `/clear` = `close` + new session (`App.tsx` on `main`) | TRUE (diff hunk removed it) |
| The barrier keeps `subagents`, starts a new segment, re-emits ledger facts, re-offers asks | TRUE (`hosted-session.ts:2424-2470`; T5/T7, M2) |
| `assertIdle` is the only slot gate and is taken synchronously before `controller` is set | TRUE (`:1923-1929`; `:1637-1641`, `:2346-2348`) |
| `session-log-store` treats `compact` as superseding | TRUE (`session-log-store.ts:700`) |
| The client's onReset hands a clear to an own in-flight prompt only if not compacted | TRUE (`remote-session.ts:1196`, `compacted` is true for `clear`) |
| Other devices' laptops save the cleared segment | TRUE (`local-runtime.ts:471-473`: `history` → `flush()`) |
| ONE `SessionGrants` shared by the gate and children **reaches `HostedSession`** | **FALSE on the worker** → H1 |
| "The client keeps the screen until the daemon's history arrives; no wake interferes" (Q6/Q8) | **FALSE** for stop-then-clear → H2 |

### Attacks tried

1. **Atomicity, daemon:** `clear()` has no `await`. `assertIdle` comes first. A concurrent `session/prompt` cannot interleave (single-threaded sync handler). T9 + M1–M4 → holds.
2. **Atomicity, TUI stop→clear:** found H2 (wake race) and M3 (send-now drop). The plain idle path is fine; twice-quickly gets `busy` (`clearingRef`).
3. **During a compaction / another device's turn:** `CompactInProgress` / `TurnInProgress` before any change → failure notice. Holds.
4. **Link drop:** a "once" call, never re-sent (`remote-client.ts:1411`). The screen converges through the replay/snapshot. Only the notice attribution drifts (L6).
5. **§7 Persistence:** `base.reason:"compact"` is honest for an older reader (a known critical enum value), for `keepSuperseded` (superseding, same path as a compaction) and for the serve sidecar (`persist()` + `log.checkpoint()` after the barrier). Pods are unchanged (no persister). The reload has no test → M4.
6. **§7 Protocol:** `session/clear` is wired both ends (`methods.ts`, `RequestSchemas`, `connection.ts:248`, `remote-client.ts:1411`). `history_replaced` stays `mandatory` (`updates.ts:322`), so a new enum value needs a bump → 21 is justified. The schema is exported, with `json-schema.test.ts` fixtures. `client/mapping.ts` needs no change (reason passes through `remote-session.ts:1328`). `apps/mobile` uses only `PROTOCOL_VERSION`.
7. **Single broker:** no new broker or requester. `grants.clear()` leaves the ask lane intact (T3). The store reaches the session only where the factory passes it → H1.
8. **Peer not serialized:** `Connection.clear` is synchronous, no lock. T14 shows a `TurnInProgress` answer while a prompt is in flight. Holds.
9. **Structural-type trap:** grepped every `createSession` site (`connect.ts:216`, `session-jobs.ts:116`, `local-runtime.ts:742`). Only `RemoteSession`/`PersistingController` expose `clear()`, and the in-process `Session` has `clearConversation`. No accidental match.

### What holds

The load-bearing assumption (the barrier keeps the background work wired), protocol versioning, persistence through the existing compaction path, the peer rule, the pure `clear-command.ts` split (AGENTS §7 "logic in pure modules"), and an honest Execution that lists its own gaps.

### How the executor behaved

Disciplined and honest. It followed the plan's order, re-ran the probe before editing, caught the `Session.clear` structural collision via tsc and renamed it, found the `SESSION_MUTATING` guard through a red test rather than by reading, recorded every drift and every not-done item (T20, FM 7–11, the unproven flake), and restored mutated files with hash checks. Its three mutations I re-ran all reproduce. Its blind spots were integration seams outside the files the plan listed: the worker factory (H1) and the wake path next to the latch it added (H2/M3). Its T19 fakes raise the history before the RPC answer, which is the opposite of the real order. That is why H2 went unseen.

### Review round 2

*— claude-opus-5-5, 2026-11-09* (scope: `git diff ef5703d..HEAD`, fix round 1 by Sonnet). **Verdict: PASS** (one new LOW, not blocking).

**Gate:** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile` clean · `bunx biome check .` clean (801 files) · `bun test packages` **6129 pass · 3 skip (opt-in) · 0 fail** (6132 tests, 425 files, 197.0 s).

**Round-1 findings:**
- **H1 — holds.** `workerSessionBuild` (`cli/src/wiring.ts:265-282`) is the one mapping and carries `grants`; `worker.ts` returns it. `HostedSession.clear` reports a missing store instead of a silent `?.` (`hosted-session.ts:2406-2414`). Mutation (drop `grants` from `workerSessionBuild`) → `worker-grants.test.ts` **KILLED**.
- **H2 — holds.** Fix as specified: the wake gate is blocked by `clearingRef` (both sites); the latch is released by the `history` activity (or a `reason:null` snapshot, or an in-turn `history_reset`); `onErr` wakes. My round-1 probe now gives `clear sent · clear answered · send#2` with `WAKE-REPLY-2` on screen. A REAL-order variant (answer first, history 20 ms later; `.tentacle/tmp/clear-keeps-jobs/review/wake-race-real-order.test.ts`) gives `clear answered · history applied · send#2`, reply kept. Mutation (`blocked: false` in `wakeIfPending`) → T19g **KILLED**. The added client change (`remote-session.ts:1185-1191`: a clear's snapshot goes in-turn to an own prompt started after the barrier) is sound: the `compact` case's reason ("the slot is held") does not hold for a clear. It reuses the existing null-reason reset path and is pinned by `client/test/clear-race.test.ts`.
- **M3 — holds.** Notice in the send-now branch (`App.tsx:1369-1373`). Mutation (notice disabled) → T19h **KILLED**.
- **M4 — holds.** T20a/b (`client/test/clear.e2e.test.ts`, real `SessionHost` + `Connection` + `RemoteClient`) and FM 8 (`daemon/test/clear-reload.test.ts`, real `LogSessionStore`). Mutation (drop `this.persist()` in `clear()`) → FM 8 **KILLED**.
- **L5 — holds.** Test "L5 a title being generated from the OLD chat…" (`daemon/test/clear.test.ts`); declared mutation = my round-1 M5.
- **L6 — holds**, with the declared residue (below). a: no decrement on "not retried"; a snapshot zeroes the count (T19j). b: the `{0,0}` branch (T19k).
- **L7 — holds.** The CHANGELOG states `keepSuperseded`. The approvals sentence is now true.
- **nit8 / nit9 — hold.** Comment moved (`connection.ts:365-372`); the double persist is commented (`agent/src/session.ts:278`).

**Declared leftovers — judged:**
- **`grants` still optional in `AgentFactory`:** acceptable. Every production factory goes through `WiredAgent` (serve passes it whole; the worker goes through `workerSessionBuild`, pinned by a test). A future omission is reported, not silent.
- **No real worker-thread / real App+RemoteSession test:** acceptable. T20 runs the real daemon + client stack; the worker mapping is pinned; the App ordering is pinned by T19g with the real answer-before-history order.
- **A link-drop clear leaves `ownClearsRef` +1 until the next snapshot:** acceptable. The only effect is a missing "cleared on another device" notice, and it self-heals at the next `reason:null` history.
- **FM 7 / 9 / 10 untested:** acceptable, as in round 1 (existing `UnknownSession`, `onFlushError` and link-drop paths).

**New finding:**
- **L8 — a clear taken in-turn leaves `ownClearsRef` +1.** When the cleared snapshot reaches an own turn as `history_reset` (the new client path), the stream loop releases `clearingRef` (`App.tsx:1286-1291`), but the `history` activity that decrements `ownClearsRef` never comes. The next FOREIGN clear is then taken as own, so its "cleared on another device" notice is swallowed, until a snapshot zeroes the count. Also, `expandAll`/`expandedIds` are not reset on that path. Same class and same self-heal as the accepted L6 residue → LOW.
  - *Fix:* in that branch, `if (event.type === "history_reset" && clearingRef.current) { clearingRef.current = false; if (ownClearsRef.current > 0) { ownClearsRef.current -= 1; } setExpandAll(false); setExpandedIds([]); }`.
  - *Test:* extend T19l to raise a foreign `history{clear}` afterwards and assert the notice shows.

**Executor behaviour (round 2):** each fix was applied as specified, mostly with the exact tests I asked for, and each declared mutation I spot-checked reproduces. It went one step further on H2, correctly: the client-side in-turn routing covers a user prompt typed during the clear, which my gate-only fix did not. Its leftovers were declared honestly.
