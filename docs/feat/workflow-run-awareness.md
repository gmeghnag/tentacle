# feat/workflow-run-awareness — the agent knows a workflow run is live

> **Status:** implementation — **APPROVED (owner answers 2026-11-25)**
> **Branch:** `feat/workflow-run-awareness`
> **Size:** M · **Blast:** load-bearing (the agent loop's request builder, its exits queue, the daemon wake) · **Suited:** per-slice executor in the Slices table (Sonnet where a mistake is cheap to iterate on, Opus where it touches the agent loop / §7); final review fresh-context Opus (§10)
> **Changelog:** `changelog.d/workflow-run-awareness.added.md` — `- **The agent knows a workflow is running.** Each request carries one short status line for the session's live run (step, waiting for you, retry/round, tokens); a run's end reaches a running turn at its next step; a step left waiting for you on an unattended \`serve\` session wakes the agent once.`

## Context

*— claude-opus-5-5, 2026-11-25*

**Owner (TODO.md, 2026-11-24, promoted 2026-11-25 «promuovila già ora»).** While a workflow
runs, the agent is not blocked (the driver runs in the background), but it learns of the run
only at its END or by calling `workflow status`. Nothing tells it a run is in progress at turn
start; no note arrives when a step fails or waits on the user. Evaluate: (a) a one-line «active
runs» status in the context each turn, (b) a short note when a step fails / needs approval,
(c) cost in tokens and noise; the model never approves (unchanged).

**What the code does today (verified):**

- The driver tells the host of a run in exactly two ways (`WorkflowHost`,
  `packages/agent/src/workflow-driver.ts:264-276`): `publish(rows)` — the full `workflows`
  state for the TUI/phone — and `ended(runId, note)`, called ONCE from `finish()`
  (`workflow-driver.ts:1530-1574`) with
  `[workflow <id> <name>: <state> · k/n · <tok> tok] <reason>`.
- `ended` → `HostedSession`: `session.noteWorkflowEnd` + `kickWake()`
  (`packages/daemon/src/hosted-session.ts:2560-2564`) → the agent's `pendingExits` queue
  (`packages/agent/src/agent.ts:1021-1024`) → flushed at the NEXT turn's start only
  (`agent.ts:2992-2999`, a persisted `role:user` message with `note.kind = workflowEnd`); the
  mid-turn drain does NOT take it (`flushMidTurn`, `agent.ts:2890-2900`: agent messages and
  sub-agent exits only). The wake is `maybeWake` → a daemon-minted `wake-<uuid>` turn
  (`hosted-session.ts:4029-4066`).
- Step start/end, retries, gotos, an ask (`needs-approval` / `waiting`,
  `workflow-driver.ts:1596-1601`) and a full sub-agent cap (`waiting · slot`,
  `workflow-driver.ts:1790-1791`) only `publish()`.
- A session runs ONE workflow at a time (`workflow-driver.ts:635-638`, refusal `:699`).
- A step's FAILURE before a retry is logged (`logStep`, `workflow-driver.ts:1496-1512`) but
  never published: `setStep(error)` is overwritten by the next attempt's `setStep(running)`
  before the next `publish()` (`:1469-1478`, `:1513-1518`) — the phone/TUI never show it
  either (repro §1: 2 failures logged, 0 published rows with `error`).

**Repro** (`.tentacle/tmp/workflow-run-awareness/repro.ts`, run from the worktree root with
`bun .tentacle/tmp/workflow-run-awareness/repro.ts`, 2026-11-25, branch at `6e3f0cec`). A real
`WorkflowDriver` with fakes (runner that passes, a `run` step that fails twice then passes with
`retry: 2`, an `approve` step), a real `Session`/`Agent` with a recording provider, the loop's
own `HeuristicTokenCounter`:

```ts
// (abridged — the full script is 150 lines; sections as printed below)
// 1. driver.start(demo-note) with write(agent) → test(run, retry 2, fails x2) → review(agent) → merge(approve)
//    count host.publish / host.ended / logStep(state=error); rows() while the approve ask waits
// 2. session.send("hi", …, { voice }) → is VOICE_SPOKEN_LINE in the request? in session.messages?
// 3. counter.countText(line) / countMessages([{role:"user",content:line}]) for candidate lines
// 4. autoApproves({ kind: "workflow_approve", … }, own = true)
```

```
start: {"ok":true,"runId":"wf-1"}
== 1. one run: write ok, test fails x2 then ok, review ok, merge = approve ask
while the approve step waits — rows(): needs-approval write:ok/a0 test:ok/a2 review:ok/a0 merge:needs-approval/a0
ask kind: workflow_approve | host.ended calls so far: 0 | publish calls: 9 | step entries: 5
step failures logged: 2 | published rows ever showing state=error: 0 | notes to the model before the end: 0
after the answer — ended notes: ["[workflow wf-1 demo-note: ok · 4/4 · 0 tok] done · 6 steps · 0 tok"]

== 2. request-only seam (voice line): in request: true | in history: false

== 3. tokens per candidate line (HeuristicTokenCounter.countText / as a message)
 21  25 [workflow wf-3 demo-note: running · step 2/4 test (attempt 2/3) · 1 ok · 4.1k tok]
 23  27 [workflow wf-3 demo-note: waits for the user · step 4/4 merge (approve) · 3 ok · 9.8k tok]
 22  26 [workflow wf-3 demo-note: waiting · step 3/4 review (sub-agent slot) · 2 ok · 6k tok]
 18  22 [workflow wf-3 demo-note: step 2/4 test failed (attempt 1/3), retrying]

== 4. autoApproves(workflow_approve, own=true): false
```

So: during the whole run (2 failures, 1 ask waiting for the user) the model is told **nothing**
until the end (§1); a request-only line already exists as a seam and stays out of the history
(§2); a status line costs **~25 tokens** per request (§3); the workflow ask is never
auto-approved (§4).

## Implementation

*— claude-opus-5-5, 2026-11-25*

### Load-bearing assumption

**Every model request of the MAIN session is built per round from `messages` by a pure
projection in one place per path, so a request-only line can be added there without ever
entering `messages` (hence never persisted, never compacted, never in the log), and that place
is reached only through `RunOptions` that `Session` passes — never by a sub-agent.**

- The loop's request: `modelView(this.requestHistory(…))` → `voiceRequest(view.messages)` →
  `ChatRequest` (`agent.ts:1622-1631`); the forced final report is the ONE other builder
  (`agent.ts:1950-1960`). `messages` is not touched by either.
- Precedent, proven by running: the voice spoken line is added to the request only
  (`core/src/voice/turn-profile.ts:69-76`) — repro §2: `in request: true | in history: false`.
- `Session.send` / `Session.resume` are the only main-session callers of `runMessages`
  (`agent/src/session.ts:226-234`, `:305-312`); a sub-agent is a SEPARATE `Agent`
  (`agent/src/subagent.ts:485`) driving its own `child.runMessages(…)` with its own options
  (`subagent.ts:567`), so an option `Session` passes never reaches a workflow step's child.

### Preconditions

- **One live run per session** (`workflow-driver.ts:635-638`, `:699`): the line is about ≤ 1
  run; the pure function still handles N defensively.
- **The rows the line reads are the rows the phone/TUI read.** `HostedSession.publishWorkflows`
  keeps the schema-parsed list in `this.lastWorkflows` and emits the same list
  (`hosted-session.ts:2578-2596`); the line is a projection of `lastWorkflows`, so the model,
  the TUI and the phone cannot disagree (AGENTS §7 "one shared truth").
- **Where a run lives.** A driver is bound only on a laptop/in-process or `serve` session
  (`hosted-session.ts:2526-2534`, refusal `:2606`); pod daemons have none → no line there.
- **Close/restart.** `close` disposes the driver (`hosted-session.ts:4946`); a restart does not
  resume runs — the load closes each open run with a `stopped: interrupted` note
  (`core/src/workflow-ledger.ts:276-286`). So after either there is no live row.
- **A `system` line would break the prompt cache.** The Anthropic builder hoists EVERY
  `system` message into the request's `system` block (`providers/src/anthropic-provider.ts:488-492`):
  a changing system line changes the very first bytes of every request. The line must be a
  `user`-role message at the TAIL. A `user` message right after tool results is already on the
  wire today (the mid-turn note drain, `agent.ts:2908-2911`).
- **The model cannot answer a workflow ask (the gate, unchanged):**
  (1) `autoApproves` refuses `workflow_approve` even on an own turn (`core/src/permission.ts:310-319`;
  repro §4 `false`); (2) the model's only workflow tool has `run | status | stop`
  (`tools/src/workflow.ts:46`), and no tool in `packages/tools/src` resolves a permission
  (`rg resolve_permission packages/tools/src` → nothing) — an answer comes only from a client's
  `session/resolve_permission`; (3) the new line carries no workflow-file text (no ask title,
  no command, no reason), so it cannot carry an instruction (design below).

### Design

**(a) The status line — request-only, every round, live runs only.**

1. **Pure projection** `workflowStatusLine(rows: readonly WorkflowRow[]): string | undefined`
   (new `packages/agent/src/workflow-status-line.ts`, React-free, no I/O). Only rows whose
   `state` is live (`pending | running | waiting | needs-approval`); none → `undefined`. One
   line per live run (max 2, then `+N more`), ≤ 200 chars each. Grammar (owner Q3):

   | row state | line |
   |---|---|
   | `needs-approval`, no step live (hash) | `[workflow wf-3 demo-note: waits for the user to approve the run]` |
   | a step `running` | `[workflow wf-3 demo-note: step 2/4 test running · 1/4 ok · 4.1k tok]` |
   | … attempt > 0 / round > 0 | `… step 2/4 test running (retry 2) …` / `… (round 2/3) …` |
   | a step `needs-approval` or `waiting` on an ask | `[workflow wf-3 demo-note: step 4/4 merge waits for the user · 3/4 ok · 9.8k tok]` |
   | a step `waiting` with `live: "slot"` | `[workflow wf-3 demo-note: step 3/4 review waits for a sub-agent slot · 2/4 ok · 6k tok]` |
   | a live run with no live step, not `needs-approval` (between two steps; added in S1) | `[workflow wf-3 demo-note: running · 2/4 ok · 4.1k tok]` |

   Lines are joined by `\n`; `+N more` is a line of its own. A line over 200 chars cuts the
   name and the step id to 32 chars (with `…`), so the state and the numbers stay whole.

   Fields used: `runId`, `name`, `steps[].id/state/attempt/round/maxRound/live`, `tokens` —
   validated identifiers and numbers only. NEVER `reason`, `live` text other than the `slot`
   marker, an ask's title, or a command: those carry workflow-file or sub-agent text (a prompt
   injection path, and noise). `k/n` = the step's index in `steps` (spec order, `pendingRow`,
   `workflow-driver.ts:1346-1356`).

2. **Agent loop seam** (`agent.ts`): `RunOptions.statusLine?: () => string | undefined`, read
   SYNCHRONOUSLY once per request build (the loop round, `:1622`, and the final report,
   `:1950`), after `modelView` and the voice line. A pure helper `withStatusLine(messages, line)`
   (in `context-awareness.ts`, beside `renderForModel`) appends
   `{ role: "user", content: line }` at the tail **only when** `line !== undefined` AND the last
   message is `user` or `tool` (a request ending in an assistant message is never given a
   fabricated user prompt). `messages` (the history) is never touched.
3. **Session**: `Session.setStatusLine(fn | undefined)`; `send` and `resume` pass it in
   `RunOptions`. Held by the `Session`, not the `Agent`, so a settings sync's `replaceAgent`
   (`session.ts:153`) keeps it.
4. **Daemon**: `HostedSession.attachWorkflows` (`hosted-session.ts:2532`) adds
   `this.session.setStatusLine(() => this.closed ? undefined : workflowStatusLine(this.lastWorkflows))`.
   No other session gets it (no driver → no line).

*Cost & cache (measured):* ~25 tokens per request while a run is live (repro §3), 0 otherwise.
At the tail it never shifts the cached prefix: round N+1's request repeats round N's messages
byte-for-byte up to where N had the line. A 10-round turn during a run ≈ 250 uncached input
tokens. The context estimate (`estimateUsed`) does not count it (≤ 0.1% at 32k) — accepted.

*Compaction / `/clear` / resume:* nothing to carry — recomputed from live rows at every request,
so it reappears right after a compaction (whose summary may drop "I started wf-3") and after
`/clear`; a resumed suspended turn (`Session.resume`) gets it too; after a restart there is no
live row and the `interrupted` note speaks instead.

**(b) Failure / waiting-for-the-user (owner Q1 = B).**

- A **mid-run failure** (a retry or an `on_fail.goto` follows) only changes the line. **No
  wake, no persisted note.** A terminal failure ends the run and the END note wakes, unchanged.
  Bound check: a run may execute up to `max_step_runs` steps (default 50, ≤ 1000;
  `core/src/workflow-spec.ts:39`, `:303`) with `retry ≤ 5` (`:36`) — a per-failure wake would
  be up to 50 wakes per run.
- **The END note at a round boundary (owner Q4 = yes, S4):** add `workflow_end` to the mid-turn
  drain (`flushMidTurn`, `agent.ts:2890-2900`), exactly like a sub-agent exit
  (docs/fix/subagent-error-report.md). A run that ends while the agent is in a long turn is
  told in THAT turn, and the line disappears at the same round. The follow-up `kickWake` sees
  `pendingExitCount === 0` and starts nothing; `notesFlushedMidTurn` is set as for the other
  mid-turn notes (the stale-wake guard, `agent.ts:1468-1502`), so a client-armed continuation
  for the same note ends with no model request.
- **«Waits for you» wakes the agent — once, unattended only (owner Q1 = B, S5 + S6).**
  1. *What is a wait.* A pure `workflowUserWait(rows): { runId, key, line } | undefined` (S5,
     beside `workflowStatusLine`) reads the SAME rows as the line: the live run whose row is
     `needs-approval` (hash: key `wf-3/approval`) or whose step is `needs-approval`, or
     `waiting` with `live !== "slot"` (an ask) — key `wf-3/<step>/<attempt>/<round>`. A slot
     wait is NOT a user wait. Rows-derived, so the driver is untouched (it is also being
     edited by fix/workflow-model-start-turn — fewer conflicts) and the trigger is the very
     fact the phone/TUI show.
  2. *Grace, not instant.* On every `publishWorkflows`, a key that is new arms ONE timer
     (`graceMs`, default **30 s**); a key that disappears disarms it. Why: an ask that is
     answered at once — a human at the screen, or a run step's tool ask auto-answered on a
     trusted `serve` (`autoApproves`; and since fix/workflow-model-start-turn a model-started
     run's asks carry the starting turn's id, so on `serve` they ARE auto-answered) — must never
     wake. Only an ask still pending after the grace is a wait.
  3. *The gate* — pure `workflowWaitWakeDue(s)` (S5), all must hold when the timer fires:
     the same key is still the current wait (re-derived from `lastWorkflows`, never the armed
     copy); `attachedCount === 0` (`hosted-session.ts:2202`, the attach set the daemon keeps
     `:2271`/`:2325`) — checked AT FIRE TIME, so a client that attached during the grace
     suppresses it; this key never woke before (an unanswered approve wakes exactly ONCE, never
     every 10 min); `now − lastWakeAt(runId) ≥ minGapMs` (default **10 min**, per run); and the
     existing daemon gate `daemonWakeGate` (`core/src/auto-wake.ts:56-62`): wake enabled (the
     host's `autoWake`), not busy, last turn not `error`/`cancelled`, not closed. Busy (a turn
     runs) → no wake, the key is NOT consumed and the timer re-arms for another `graceMs`
     (that turn's line already says it; if the ask is still pending after the turn and no
     client is attached, the next fire wakes). A gap not yet elapsed → re-arm at the gap's
     end. Any other failed condition → disarm (the key stays un-woken; a later publish that
     changes nothing does not re-arm it — one timer per key, armed only when the key APPEARS).
     **Order (fixed in S5):** disarm on «key gone or changed / attached / already woke / wake
     off / closed» → busy re-arms → `lastEndBad` disarms → gap. Busy MUST come before
     `lastEndBad`: that flag is written only when a turn ends (`hosted-session.ts:3962`), so
     during a turn it still describes the turn before, and disarming on it would drop a wake
     the running turn's good end allows.
  4. *The note.* Due → `session.noteWorkflowWait(runId, text)` → `pendingExits`
     `{ kind: "workflow_wait", runId, text }` (counts in `pendingExitCount`, like an end note)
     → `kickWake()` → `maybeWake` → a daemon-minted `wake-<uuid>` turn (`hosted-session.ts:4029-4066`).
     Flushed at that turn's start as a persisted `role:user` message
     `note: { kind: NOTE_KIND.workflowWait, id: runId }`, text =
     `[workflow wf-3 demo-note: step 4/4 merge waits for the user (since 12:04) · 3/4 ok · 9.8k tok] You cannot answer it; tell the user if useful.`
     `note.kind` is a free string on the wire and on disk (`core/src/model.ts:150-160`): an
     older build renders it as a generic notice — no format change. The load derivation filters
     end/interrupted notes BY KIND (`core/src/workflow-ledger.ts:312`), so a wait note naming
     `wf-3` can never be taken for the run's end; `workflowRunSeqFromHistory` reads any
     `wf-N` id (`:82-86`) — harmless, it only raises the floor to an id already used.
  5. *State and restart.* `lastWakeAt` per run and the woken-key set are daemon memory
     (`HostedSession`), dropped when the run ends. **Not persisted, on purpose:** a run never
     survives a restart (the load closes it `stopped: interrupted`,
     `core/src/workflow-ledger.ts:276-286`, and `reserveRunIds` never reuses its id,
     `workflow-driver.ts:607-616`), so after a restart no key can repeat. A queued wait note
     lost in a crash is replaced by the `interrupted` note.
  6. *Where it can fire.* Only a session with a driver AND `wake` enabled AND no client: in
     practice a `serve` session with the phone/TUI detached. The in-process worker always has
     its TUI attached (attachedCount > 0) → never. A pod daemon has no driver → never.

**(c) Noise.** One line, only while a run is live. History grows only by a wait note (≤ 1 per
user-wait, unattended only) — no entry per step, failure or retry. A looping workflow changes
the line's numbers, never its size. Worst case of wakes for one run: one per distinct
unanswered ask, ≥ 10 min apart; a run's asks are bounded by its step executions
(`max_step_runs`), and each one waits up to `budget.wait` before the run stops `timeout`.

**Alignment with fix/workflow-model-start-turn** (`docs/fix/workflow-model-start-turn.md`, on
its branch, may merge first): it adds `WorkflowHost.currentTurn?()` and binds it in the same
`attachWorkflows` block S3 edits; a model-started run then carries its starting `turnId`.
Effects here: (1) S3's one added line sits beside its binding — a textual merge, no semantic
conflict; whoever merges second rebases onto it. (2) A run's asks stay attributed to the
STARTING turn, never to a `wake-` turn this feature starts: the wake turn only tells the
model; it raises no ask and changes no `run.turnId`. (3) Its auto-answered tool asks are the
reason for the 30 s grace (above): pinned by T7's "auto-answered ask never wakes".

### Files

Dependency order (no protocol, no persistence change — the line never leaves the daemon):

1. `packages/agent/src/workflow-status-line.ts` (new) + export from `packages/agent/src/index.ts` — S1.
2. `packages/agent/src/context-awareness.ts` — `withStatusLine` (pure) — S2.
3. `packages/agent/src/agent.ts` — `RunOptions.statusLine`, applied at `:1622-1631` and
   `:1950-1960`; (S4) `flushMidTurn` takes `workflow_end` — S2/S4.
4. `packages/agent/src/session.ts` — `setStatusLine`, passed by `send`/`resume` — S2.
5. `packages/daemon/src/hosted-session.ts` — one call in `attachWorkflows` — S3.
6. `docs/feat/agent-workflows.md` — one line under D3 pointing here (the end note is no longer
   the ONLY thing the model hears) — S3.
7. `changelog.d/workflow-run-awareness.added.md` — S3.
8. `packages/agent/src/workflow-status-line.ts` — `workflowUserWait`, `workflowWaitWakeDue`
   (pure) — S5.
9. `packages/core/src/model.ts` — `NOTE_KIND.workflowWait = "workflow_wait"` — S6.
10. `packages/agent/src/agent.ts` + `session.ts` — `noteWorkflowWait` (pendingExits kind
    `workflow_wait`, flushed at a turn's START only, counted in `pendingExitCount`, carried by
    `retire`/`adoptExits`) — S6.
11. `packages/daemon/src/hosted-session.ts` — the wait timer (`graceMs`/`minGapMs` options,
    injectable `setTimeout`/`clearTimeout` like `SessionSchedules`, `this.now()`), armed from
    `publishWorkflows`, disarmed on close — S6.

### Failure modes

| case | how it converges |
|---|---|
| many parallel runs | one per session (`:699`); several sessions → each sees only its own rows; the pure fn caps at 2 lines + `+N more` |
| looping workflow (retry/goto, up to `max_step_runs`) | the line is STATE: same size every request, numbers change; no event → no wake → no storm |
| run of a closed / archived session | `close` disposes the driver (`hosted-session.ts:4946`); no turn runs; the provider also returns `undefined` when `closed` |
| resume after restart | no live run survives; `workflowLoadNotes` closes it `interrupted` → no line, the note speaks |
| compaction / `/clear` / settings sync | recomputed per request; `Session` holds the provider across `replaceAgent` |
| sub-agent steps | a step's child is its own `Agent` (`subagent.ts:485/567`) → never sees the line (it IS the step) |
| phone / TUI / model disagree | one source: `lastWorkflows`, the very list emitted to clients (`hosted-session.ts:2587-2589`) |
| a publish that fails its schema | `lastWorkflows` keeps the previous list (`:2582-2586`): the line is at worst one step stale, never invented |
| run ends mid-turn (S4 off) | line vanishes at the next round; end note waits for the turn's end + wake (today's behaviour) — S4 closes this gap |
| request ending with an assistant message | no line (never fabricate a user prompt) |
| prompt injection via the line | only ids, names, states, numbers — never reason/title/command text |
| the model tries to approve | impossible: no tool resolves an ask; `autoApproves` refuses `workflow_approve` (`permission.ts:316`) — unchanged and pinned by a test |
| a step's failure is invisible on phone/TUI between retries | pre-existing (repro §1), out of scope — Notes |
| ask auto-answered (trusted `serve`, model-started run since the turn fix) | answered inside the 30 s grace → key gone → timer disarmed, no wake |
| client attaches during the grace | checked at fire time → no wake (the user sees the ask) |
| client detaches while a step already waits | no new key → no wake; the line tells the next turn (accepted: the wake is for asks that START unattended) |
| one approve left unanswered for an hour | key woke once → never again; the run stops `timeout` at `budget.wait` → END note wakes |
| looping run whose every attempt asks | each attempt is a new key, but ≥ 10 min apart per run → ≤ 6 wakes/hour, each only after a 30 s unanswered wait |
| a turn runs when the grace ends | no wake, key kept, timer re-armed (the line covers the running turn) |
| last turn ended `error`/`cancelled`, or `autoWake` off | `daemonWakeGate` blocks, as for every other wake |
| wait note flushed after the ask was answered | the note carries `(since HH:MM)`; the same request's status line shows the CURRENT state, so the model reads both |
| restart during a wait | run closed `interrupted`, its note wakes as today; in-memory keys/timestamps gone with the run, ids never reused |
| session closed during the grace | `close` clears the timer; the gate also checks `closed` |

### Tests

Fakes only: the driver test's `setup()`/`SpyBroker`/`FakeClock`
(`packages/agent/test/workflow-driver.test.ts:38-176`), `RecordingProvider`
(`packages/agent/test/steering.test.ts:15-27`), the daemon's workflow host tests
(`packages/daemon/test/workflow-hosted.test.ts`). Red first for each (§9).

- **T1 (S1) pure line** — table: no rows / only ended rows → `undefined`; running; retry; goto
  round; hash `needs-approval`; step waiting on an ask; `waiting`+`slot`; 3 live rows → 2 lines
  + `+1 more`; a row whose `reason`/`live` contains `"ignore previous instructions"` → absent
  from the output; ≤ 200 chars with a 64-char name. Red: module missing.
- **T2 (S2) request-only** — `statusLine: () => "[workflow …]"`, a 2-round turn (one tool
  call): each request's LAST message is the line; `session.messages` never contains it;
  round 2's request equals round 1's request minus its last element, as a prefix (cache);
  returning `undefined` → no extra message; a history ending in `assistant` → no line; the
  forced final report carries it. Red: today no request has it. Mutation: put it in
  `messages` → the history assertion fails.
- **T3 (S2) scope** — `replaceAgent` keeps the provider; `resume` passes it; a sub-agent run
  from that session (fake `SubagentRunner` capturing the child's requests) never sees it.
- **T4 (S3) daemon end-to-end** — a hosted session with a driver whose `approve` step is
  pending: a prompt's model request ends with `… waits for the user …`; the user's answer → the
  run ends → the next turn's request has no line and has the end note; the persisted log
  (the test persister) never contains the string `[workflow wf-1 demo-note: step`.
- **T5 (S3) gate** — during that run, in auto-accept mode, the pending `workflow_approve` stays
  pending through a whole model turn (no tool answers it); `autoApproves` stays `false`.
- **T6 (S4) end note mid-turn** — a run that ends during round 1 of a 2-round turn: round 2's
  request contains the end note, `pendingExitCount === 0` after, no wake turn is started, and
  the note is not delivered twice. Red: today the note lands only at the next turn's start.
- **T7 (S5) pure wait + gate** — `workflowUserWait`: hash approval, approve step, an ask
  (`waiting`, no `slot`) → a key; `waiting`+`slot`, running, ended → `undefined`; key changes with
  attempt/round. `workflowWaitWakeDue`: each condition alone flips it (same key, attached 0,
  never woke, gap ≥ 10 min, enabled, idle, last end good, open); busy → `rearm`, gap short →
  `rearm at`. Red: module missing.
- **T8 (S6) daemon wake** — hosted session with the driver fakes, injected timers + `now`:
  (a) approve step pending, 0 clients, grace elapses → exactly ONE `wake-` turn whose request
  contains the wait note and the line; the note is persisted with `note.kind = workflow_wait`;
  (b) the same ask still pending 1 h later → no second wake; (c) an ask answered after 5 s →
  no wake (the auto-answer case); (d) a client attached at fire time → no wake;
  (e) a turn running at fire time → no wake, then the turn ends with the ask pending → one wake;
  (f) a looping run (each attempt asks, unanswered 31 s each) → wakes ≥ 10 min apart, never
  two inside the gap; (g) `autoWake` off → none; (h) closed during the grace → none, timer
  cleared. Red: no wake today. Mutation: drop the attach check → (d) fails; drop the woken-key
  set → (b) fails.
- **T9 (S6) load** — a log with a `workflow_wait` note for `wf-3` and no end: the load still
  closes `wf-3` `interrupted` (the wait note is not mistaken for an end).

### Slices

Execution order = table order. One branch, one final fresh-context **Opus** review of the
whole group (owner «fewer reviews»); each slice runs its narrow test file red → green.

| SLICE id | what | size · blast | executor | estimate |
|---|---|---|---|---|
| S1 | pure `workflowStatusLine` + T1 | S · contained | sonnet | ~40 min |
| S2 | `RunOptions.statusLine` + `withStatusLine` + `Session.setStatusLine` + T2/T3 | S · load-bearing (agent loop request builder) | opus | ~1.5 h |
| S3 | daemon wiring of the line + agent-workflows.md pointer + changelog + T4/T5 | S · cross-module (one line in `attachWorkflows`) | sonnet | ~45 min |
| S4 | `workflow_end` in the mid-turn drain + T6 | S · load-bearing (agent loop exits queue, stale-wake guard) | opus | ~1 h |
| S5 | pure `workflowUserWait` + `workflowWaitWakeDue` + T7 | S · contained | sonnet | ~45 min |
| S6 | `NOTE_KIND.workflowWait` + `noteWorkflowWait` + daemon wait timer/wake + T8/T9 | M · load-bearing (agent exits queue + daemon wake) | opus | ~2 h |

### Owner questions (answered — see Owner answers)

1. **Which events wake the agent?** A) only the run's END (unchanged); a mid-run failure and
   «waits for you» only update the line. B) also «waits for you», at most once per run per
   10 min, only when no client is attached. **Recommendation: A** — the ask already reaches you
   via the TUI/phone, the model cannot answer it, and a wake costs a full request (30–60k
   tokens) for nothing new.
2. **When is the line sent?** A) every request (each round), ~25 tok uncached each. B) only the
   first request of a turn. **Recommendation: A** — mid-turn the model sees a step fail or
   start waiting; 10 rounds ≈ 250 tokens.
3. **Wording/format** (English, like every model-facing note):
   `[workflow wf-3 demo-note: step 4/4 merge waits for the user · 3/4 ok · 9.8k tok]` /
   `… step 2/4 test running (retry 2) · 1/4 ok · 4.1k tok]` /
   `… waits for the user to approve the run]`. No reason/command text in it.
   **Recommendation: yes, as written.**
4. **The END note at the next round boundary of a running turn** (like a sub-agent's exit),
   instead of waiting for the turn to end and then waking? **Recommendation: yes** (S4) — no gap
   where the run is neither live nor reported, and one wake fewer.

### Owner answers

*2026-11-25 ~12:05, as relayed by the orchestrator:*

1. Q1 = «B: anche aspetta te» — wake ALSO when a step waits for the user: at most one wake per
   run per 10 minutes, only when NO client is attached; attach check and debounce designed
   robustly, persisted across restart if needed. → Design (b) «Waits for you» (not persisted:
   proven unnecessary, point 5), slices S5/S6.
2. Q2 = A — the line on every request.
3. Q3 = the format as is.
4. Q4 = yes — the end note at the next round boundary inside the running turn (S4).

Plus: align with fix/workflow-model-start-turn (done: «Alignment» under Design) and routing
«ottimizziamo con sonnet quando possiamo» (the Slices table).

No new owner-visible choice appeared: the 30 s grace and «a key wakes once» only narrow
«at most one per run per 10 min» to asks that really wait (both are constants a later task
may tune).

### Notes / debt

- Pre-existing, out of scope: a failed attempt is never published (the next attempt's `running`
  overwrites it before `publish`, `workflow-driver.ts:1513-1518` → `:1469-1478`), so the phone
  and TUI show `retry 2` but never the failure reason. A separate `fix` if wanted (a wire field,
  e.g. `lastError` on the step row).
- The TODO cites `workflow-driver.ts:1155` for the end note; it is now `:1570`.

## Execution

### S1 — the pure status line — DONE

*— claude-sonnet-5-5, 2026-11-25 (branch at `e9931b12`, uncommitted)*

**Load-bearing check, re-run first: holds.** `bun .tentacle/tmp/workflow-run-awareness/repro.ts`:

```
step failures logged: 2 | published rows ever showing state=error: 0 | notes to the model before the end: 0
== 2. request-only seam (voice line): in request: true | in history: false
== 4. autoApproves(workflow_approve, own=true): false
```

By `rg`: the loop's two request builders are still in `agent.ts` (the round and the final
report; `compact.ts` builds its own summary requests), `session.ts:226`/`:305` are the
main-session `runMessages` callers (`agent.ts:1338` is the `Agent`'s own entry into it), and a
sub-agent calls `child.runMessages` (`subagent.ts:567`).

**As built:** new `packages/agent/src/workflow-status-line.ts` (`workflowStatusLine`), exported
from `packages/agent/src/index.ts`; T1 in `packages/agent/test/workflow-status-line.test.ts`.
Tokens use core's `formatTokens` (`4.1k`), not the context line's whole-k one. Nothing calls
the function yet (S2/S3).

**Red** (against a stub returning `undefined`): `2 pass, 15 fail`; the 2 passes are the
"no line" cases. **Green:** `17 pass, 0 fail`. `bunx biome check` on the 3 files: clean.

**Mutations** (`.tentacle/tmp/workflow-run-awareness/mutate-s1.ts`, source restored):

```
leak the run's reason: killed (5 pass, 12 fail)
show the live text on an ask: killed (14 pass, 3 fail)
drop the live-run filter: killed (15 pass, 2 fail)
ignore the slot marker: killed (15 pass, 2 fail)
never clip the labels: killed (16 pass, 1 fail)
no 2-line cap: killed (16 pass, 1 fail)
drop the hash-approval line: killed (16 pass, 1 fail)
restored: true
```

**Drift:**
- The grammar had no line for a live run with no live step; added to the table (Design (a)),
  with the line join and the clipping rule.
- T1's red is on assertions (stub), not «module missing», per the executor brief.
- The changelog fragment (listed under S3) was written now, as the orchestrator asked, with the
  header's text. It describes the whole branch: true only once S2–S6 are in.

**Note for S3/S5** (read, not run): `createRun` publishes the row as `needs-approval` before
the hash check (`workflow-driver.ts`, the `state: "needs-approval"` literal), so an
already-approved run can read «waits for the user to approve the run» for that instant. S5's
30 s grace covers the wake.

**Gate:** only T1 and lint on the changed files; full typecheck/lint/test left to the
orchestrator's script. No schema change, so `protocol.json` is untouched.

### S2 — the request-only seam (`RunOptions.statusLine`) — DONE

*— claude-opus-5-5, 2026-11-25 (branch at `ec2cccee`, uncommitted)*

**Load-bearing check, re-run first: holds.** The repro again prints
`request-only seam (voice line): in request: true | in history: false` and
`autoApproves(workflow_approve, own=true): false`. `rg`: the loop's request builders are the round
(`agent.ts`, `modelView` → `voiceRequest` → `ChatRequest`) and the forced final report; the
third `modelView` call (`contextUsage`, the open-time count) builds no model request — the line
is not counted there, as the Design accepts. Main-session `runMessages` callers are still only
`Session.send`/`resume`; a sub-agent calls `child.runMessages` (`subagent.ts:567`).

**As built:**
- `packages/agent/src/context-awareness.ts` — pure `withStatusLine(messages, line)`: appends
  `{ role: "user", content: line }` only when `line !== undefined` and the last message is
  `user`/`tool`; always returns a new array.
- `packages/agent/src/agent.ts` — `RunOptions.statusLine?: () => string | undefined`; the round's
  request is `withStatusLine(voiceTurn.messages, opts.statusLine?.())`; the final report applies
  it to the pre-nudge list, so the order is `… tool, line, nudge`.
- `packages/agent/src/session.ts` — private `statusLine`, `setStatusLine(fn | undefined)`; `send`
  and `resume` spread it into `RunOptions` when set.
- T2/T3: new `packages/agent/test/status-line-request.test.ts` (10 tests: pure helper ×2; every
  round ends with the line, read once per request, never in `messages`/`snapshot`, round 2
  extends round 1's prefix; `undefined` → identical requests to a session without a provider;
  `setStatusLine(undefined)` clears; assistant-tail history → no line; forced final report
  carries it before the nudge; `replaceAgent` keeps it; `resume` passes it; a sub-agent's
  requests never carry it while the parent's all do).

**Red** (with `setStatusLine` storing but not passing the provider): `5 pass, 5 fail`, every fail
on an assertion; the 5 passes are the "no line" guards. **Green:** `10 pass, 0 fail`.
Neighbours (`steering`, `resume`, `replace-agent`, `session`, `context-awareness`,
`context-awareness-loop`, `subagent`, `agent`): `142 pass, 0 fail`. `bunx biome check` on the 4
files: clean (after `--write` formatting the test). `tsc --noEmit -p packages/agent`: clean.

**Mutations** (`.tentacle/tmp/workflow-run-awareness/mutate-s2.ts`, source restored):

```
line pushed into the history: killed (5 pass, 5 fail)
line at the head (cache-breaking): killed (4 pass, 6 fail)
final report without the line: killed (9 pass, 1 fail)
line after an assistant tail too: killed (8 pass, 2 fail)
Session does not pass it (send+resume): killed (5 pass, 5 fail)
restored: true
```

**Drift:**
- The final report: the plan says only "carries it". Placed BEFORE the nudge (the nudge stays the
  last instruction); the assistant-tail rule still applies to the pre-nudge list. Two consecutive
  `user` messages (line, nudge) are already legal on the wire (the Anthropic API merges
  same-role turns, `anthropic-provider.ts` comment at the empty-assistant drop).
- T2's red is on assertions (a storing-only `setStatusLine` stub), not "today no request has it"
  by a missing method — same property, per the executor brief.
- No changelog fragment written: S1's `changelog.d/workflow-run-awareness.added.md` already
  covers the branch.

**Gate:** only the files above; full typecheck/lint/test left to the orchestrator's script. No
schema change, so `protocol.json` is untouched.

### S3 — the daemon wiring of the line — DONE

*— claude-sonnet-5-5, 2026-11-25 (branch at `256833a5`, uncommitted)*

**Load-bearing check, re-run first: holds.** The repro prints `request-only seam (voice line):
in request: true | in history: false` and `autoApproves(workflow_approve, own=true): false`.
`attachWorkflows` still has one caller (`session-host.ts`, in `build`).

**As built:**
- `packages/daemon/src/hosted-session.ts` — `attachWorkflows` calls
  `this.session.setStatusLine(() => this.closed ? undefined : workflowStatusLine(this.lastWorkflows))`
  after `driver.bind`.
- `docs/feat/agent-workflows.md` D3 — the pointer here.
- T4/T5 in `packages/daemon/test/workflow-hosted.test.ts`: the real `SessionHost` →
  `attachWorkflows` path with a real `WorkflowDriver` (`approve` step), the one
  `PermissionBroker`, `answersAutoAccept`, a recording model and a `SessionPersister` over
  `SpyDaemonStore`. T4: the request ends with the waits line; after the answer the next
  request has the end note and no line; no unit handed to the store, no file and no snapshot
  holds `[workflow wf-1 task: step`. T5: in auto-accept, one two-round turn (`workflow status`
  + an ordinary asking tool, which IS auto-answered) leaves the `workflow_approve` pending;
  `autoApproves` is `false`. A third test pins the `closed` guard (after `close` the published
  rows are still live, the provider gives nothing); it reads the provider through a private
  field, because no turn can run on a closed session.

**Red** (before the wiring): `20 pass, 3 fail`, each on an assertion (the request's tail is the
prompt; the provider gives `undefined`). **Green:** `23 pass, 0 fail`. Neighbours
(`workflow-load`, `workflow-step-detail`, `workflow-permission-map`, `schedule-workflow`,
`serve-autoaccept-unattended`, `agent/workflow-status-line`, `agent/status-line-request`,
the `cli` workflow tests): `137 pass, 0 fail`. `bunx biome check` on the 2 TS files: clean.
`tsc --noEmit -p packages/daemon`: clean.

**Mutations** (`.tentacle/tmp/workflow-run-awareness/mutate-s3.ts`, sources restored):

```
no wiring: killed (20 pass, 3 fail)
no closed guard: killed (22 pass, 1 fail)
rows frozen at attach (not the published list): killed (20 pass, 3 fail)
the line also pushed into the history: killed (22 pass, 1 fail)
auto-accept approves workflow asks: killed (22 pass, 1 fail)
```

**Drift:**
- T4: on the turn after the run, the request's tail is the end note, not the prompt: the exits
  queue is flushed after the new prompt (existing behaviour).
- The changelog fragment (item 7) already exists from S1; not rewritten. It also describes S4
  and S6, so it is true only once they are in.

**Gate:** only the files above; full typecheck/lint/test left to the orchestrator's script. No
schema change, so `protocol.json` is untouched.

### S4 — the end note at the next round boundary — DONE

*— claude-opus-5-5, 2026-11-25 (branch at `11f4bcc2`, uncommitted)*

**Load-bearing check, re-run first: holds** (by `rg` + read): the loop's request is still built
per round from `messages` (round + final report); the mid-turn drain is `flushMidTurn`, called at
the round boundary and in the late drain before a final answer (the synchronous steering
window); it took only `agent_message` and sub-agent exits. `ended` → `noteWorkflowEnd` +
`kickWake`; `maybeWake` is gated on `pendingExitCount > 0` and `busy`, and `kickWake` runs again
at every turn's end, so a note drained mid-turn leaves nothing to wake for.

**As built:**
- `packages/agent/src/agent.ts` — `flushMidTurn` also takes `workflow_end` (queue order kept),
  pushing the note and a `context_note` event exactly as the turn-start flush does; ONE renderer
  `workflowEndNote(job)` (role `user`, `note: { kind: workflowEnd, id: runId }`) now used by both
  drains. Doc comments of `PendingWorkflowEnd`, `noteWorkflowEnd` and `flushMidTurn` updated.
  `notesFlushedMidTurn` is set by the existing callers of `flushMidTurn` (stale-wake guard), no
  new code.
- T6 in `packages/daemon/test/workflow-hosted.test.ts` (real `SessionHost` → `attachWorkflows`,
  `wakeOnJobExit: true`): round 1 calls an `answer` tool that resolves the `approve` ask and waits
  for the run's `ok` frame. Asserted: round 1 ends with the waits line; round 2 holds the end note
  exactly once, as its last message, right after the tool result, with `note.kind = workflow_end`
  / `id = wf-1`, and no status line; `unflushedExits === 0`; after several macrotasks no turn
  runs, no 3rd request, no `wake-` id in any frame; the next turn's request holds the note once.
  `waitingRig` gained an opt-in `wake` and the `answer` tool (unused by T4/T5).

**Red** (before the agent change): `23 pass, 1 fail` — `round2 … endNote … toHaveLength(1)`,
received 0. **Green:** `24 pass, 0 fail`; T6 `--rerun-each 20`: `20 pass`. Neighbours
(`steering`, `subagent-background`, `status-line-request`, `agent`, `workflow-driver`,
`serve-autowake`, `workflow-load`, `workflow-hosted`): `146 pass, 0 fail`. `bunx biome check` on
the 2 files: clean. `tsc --noEmit -p packages/agent` and `-p packages/daemon`: clean.

**Mutations** (`.tentacle/tmp/workflow-run-awareness/mutate-s4.ts`, source restored):

```
end note not in the mid-turn drain: killed (23 pass, 1 fail) error: expect(received).toHaveLength(expected)
drained but also kept in the queue (told twice / wakes): killed (23 pass, 1 fail) error: expect(received).toHaveLength(expected)
mid-turn note without its note kind: killed (23 pass, 1 fail) error: expect(received).toMatchObject(expected)
restored: true
```

**Drift:**
- T6's `answer` tool waits on the LIVE `workflows` frame, not `snapshotPage()`: the snapshot's
  cut does not move while a turn runs (`publishWorkflows` records a cut only when idle), so a
  first version waiting on the snapshot timed out in 6 of 8 reruns. `finish()` publishes and then
  calls `ended` synchronously, so the `ok` frame implies the note is queued.
- No agent-level unit test added: T6 drives the real agent loop through the daemon, which is
  where "no wake follows" is observable.
- Not exercised by a test: the late drain (a run ending during the model's FINAL round, which then
  continues the turn for one more round, as a sub-agent exit does). Same code path
  (`flushMidTurn`); a test would need the run to end while the model streams.
- Changelog: S1's fragment already covers this (no new one).

**Gate:** only the files above; full typecheck/lint/test left to the orchestrator's script. No
schema change, so `protocol.json` is untouched.

### S5 — the pure user wait + wake gate — DONE

*— claude-sonnet-5-5, 2026-11-25 (branch at `8c73ca98`, uncommitted)*

**Load-bearing check, re-run first: holds.** The repro prints `request-only seam (voice line):
in request: true | in history: false` and `autoApproves(workflow_approve, own=true): false`.
S5's own premise, by `rg` + read: the driver publishes an ask as a `needs-approval` (hash,
approve step) or `waiting` step/run state (`stepRequester`), a slot wait as `waiting` +
`live: "slot"`; `daemonWakeGate` is the gate `maybeWake` uses.

**As built:**
- `packages/agent/src/workflow-status-line.ts` — `workflowUserWait(rows)` (first live run
  waiting for the user: `{ runId, key, line }`, `line` = that run's status line) and
  `workflowWaitWakeDue(state)` → `wake | disarm | rearm | rearm_at{at}`, built on core's
  `daemonWakeGate`. The line and the wait share one live-step choice and one slot predicate,
  so they cannot disagree. Already exported (S1's `export *`). Nothing calls them yet (S6).
- T7 in `packages/agent/test/workflow-status-line.test.ts`.

**Red** (stubs returning `undefined` / `disarm`): `37 pass, 13 fail`, the fails on assertions;
the new passes are the "no wait" / "disarm" cases. **Green:** `50 pass, 0 fail`; with
`status-line-request` and `workflow-hosted`: `84 pass, 0 fail`. `bunx biome check` on the 2
files: clean. `tsc --noEmit -p packages/agent`: clean.

**Mutations** (`.tentacle/tmp/workflow-run-awareness/mutate-s5.ts`, source restored). First run:
`unclipped wait line: SURVIVED` (the long-label case was under 200 chars, so it never clipped);
the test now uses a 32-char run id and asserts the `…`. Second run:

```
slot wait counted as a user wait: killed (49 pass, 1 fail)
running step counted as a user wait: killed (48 pass, 2 fail)
no hash-approval wait: killed (49 pass, 1 fail)
any live run with no live step waits: killed (48 pass, 2 fail)
key without the attempt: killed (45 pass, 5 fail)
key without the round: killed (45 pass, 5 fail)
ended rows can wait: killed (48 pass, 2 fail)
unclipped wait line: killed (49 pass, 1 fail)
no same-key check: killed (46 pass, 4 fail)
no attach check: killed (48 pass, 2 fail)
no woken-key check: killed (48 pass, 2 fail)
no enabled check: killed (48 pass, 2 fail)
no closed check: killed (49 pass, 1 fail)
busy ignored: killed (47 pass, 3 fail)
bad end ignored: killed (48 pass, 2 fail)
bad end checked before busy: killed (49 pass, 1 fail)
no gap: killed (49 pass, 1 fail)
gap boundary off by one: killed (49 pass, 1 fail)
rearm at now + gap: killed (49 pass, 1 fail)
restored: true
```

**Drift:**
- Design (b) point 3 did not order the conditions; the order is now written there. «Busy →
  re-arm» wins over a stale `lastEndBad` only; every other failed condition still disarms,
  busy or not.
- T7's red is on assertions (stubs), not «module missing»: the module exists since S1.
- Changelog: S1's fragment already covers this (no new one).

**Note for S6** (read, not run):
- `line` is the plain status line. Point 4's `(since HH:MM)` sits inside it, after «waits for
  the user» and, for the hash approval, before «to approve the run» or at the end: S6 has to
  pick and build that.
- The key names a step execution, not one ask: a second ask in the same attempt and round has
  the same key, so after a wake it never wakes again (point 3, «a key wakes once»).
- `woke` and `lastWakeAt` are inputs: the woken-key set and the per-run time are S6's state.

**Gate:** only the files above; full typecheck/lint/test left to the orchestrator's script. No
schema change, so `protocol.json` is untouched.

### S6 — the wait note and the daemon's wait wake — DONE

*— claude-opus-5-5, 2026-11-25 (branch at `a36ec2b8`, uncommitted)*

**Load-bearing check, re-run first: holds.** The repro prints `request-only seam (voice line):
in request: true | in history: false` and `autoApproves(workflow_approve, own=true): false`. S6's
own premises, by `rg` + read: `maybeWake` wakes on `pendingExitCount > 0` through
`daemonWakeGate`; `pendingExitCount` skips only user notes and non-waking child notes; the
stale-wake guard does not cut a turn whose START flushed a note (it emits a `context_note`);
`attachedCount` is the attach set; the load closes runs by note KIND.

**As built:**
- `packages/core/src/model.ts` — `NOTE_KIND.workflowWait = "workflow_wait"`.
- `packages/agent/src/agent.ts` — `PendingWorkflowWait` (`kind: "workflow_wait"`), `noteWorkflowWait`;
  flushed by the turn-START flush only (persisted `role:user`, `note: { kind: workflow_wait,
  id: runId }`, a `context_note` event); NOT in `flushMidTurn`; counted by `pendingExitCount`
  (no filter change); carried by `retire`/`adoptExits` (they move the whole queue).
  `packages/agent/src/session.ts` — `Session.noteWorkflowWait`.
- `packages/agent/src/workflow-status-line.ts` — pure `workflowWaitNote(wait, sinceAt, zone)`:
  the wait's line with `(since HH:MM)` after the LAST «waits for the user», then
  `You cannot answer it; tell the user if useful.` (`?` for an unrenderable zone/instant).
- `packages/daemon/src/hosted-session.ts` — `SessionWake.workflowWait?: WorkflowWaitTiming`
  (`graceMs`, `minGapMs`, injectable `setTimeout`/`clearTimeout`; defaults
  `WORKFLOW_WAIT_GRACE_MS = 30 s`, `WORKFLOW_WAIT_MIN_GAP_MS = 10 min`). `publishWorkflows` →
  `trackWorkflowWait`: only with `wake`; the wait key from `workflowUserWait(lastWorkflows)`;
  unchanged key → nothing; changed → disarm, and arm ONE timer if a key appeared (since = now).
  `fireWorkflowWait` → `workflowWaitWakeDue` on the rows/attach set/slot read at fire time:
  `rearm` → another grace, `rearm_at` → at the gap's end, `wake` → mark the key woken + the
  run's `at`, `session.noteWorkflowWait(…)` (zone: the last client's, else the host's), `kickWake()`.
  Per-run memory dropped in `ended`; `close` disarms the timer.
- `packages/daemon/src/session-host.ts` — `SessionHostOptions.workflowWait`, passed into
  `SessionWake` only with `wakeOnJobExit` (the tests' clock).
- Tests: T8a–h + T8b2 in `packages/daemon/test/workflow-hosted.test.ts` (the real
  `SessionHost` → `attachWorkflows` rig with a fake clock + timers, the rig's client detached;
  T8f/T8b2 drive rows through a stand-in driver's `publish`); `workflowWaitNote` ×3 in
  `packages/agent/test/workflow-status-line.test.ts`; T9 in `packages/core/test/workflow-ledger.test.ts`.

**Red:** the «no wait tracking» mutant below IS the pre-S6 daemon (no timer is ever armed):
`27 pass, 5 fail` (T8a/b, T8e, T8f, T8b2, T8h), each on an assertion. T9 and T8c/d/g pass on
pre-S6 code by design (they pin «no wake» and the load's kind filter); their non-vacuity is the
mutations. **Green:** `workflow-hosted` `32 pass, 0 fail`; the S6 tests `--rerun-each 15`:
`120 pass, 0 fail`. Neighbours (`steering`, `status-line-request`, `agent`, `replace-agent`,
`workflow-status-line`, `serve-autowake`, `workflow-load`, `workflow-hosted`,
`core/workflow-ledger`): `179 pass, 0 fail`. `tsc --noEmit -p` agent/daemon/core: clean.
`bunx biome check` on the 9 files: clean.

**Mutations** (`.tentacle/tmp/workflow-run-awareness/mutate-s6.ts`, sources restored):

```
RED: no wait tracking (pre-S6 daemon): killed (27 pass, 5 fail)
no attach check: killed (31 pass, 1 fail) T8d
no woken-key set: killed (31 pass, 1 fail) T8b2
no per-run gap: killed (31 pass, 1 fail) T8f
busy drops the wait (no re-arm): killed (31 pass, 1 fail) T8e
close keeps the timer: killed (31 pass, 1 fail) T8h
a vanished ask keeps its timer: killed (28 pass, 4 fail)
wake gate ignores autoWake: SURVIVED (32 pass, 0 fail)
no grace (fires at once): killed (30 pass, 2 fail) T8a/b, T8c
wait note under the end kind: killed (31 pass, 1 fail) T8a/b
wait note does not wake: killed (28 pass, 4 fail)
load takes a wait note for the end: killed (13 pass, 1 fail) T9
restored: true
```

The survivor is equivalent: without `wake` the timing option is never passed, so the arm uses a
real (unref'd) timer the test cannot see, and at its fire the gate's `enabled` check (S5,
mutation-killed there) disarms. No wake either way.

**Drift:**
- Plan T8 (b) says «drop the woken-key set → (b) fails». In this design a key is armed only when
  it APPEARS, so a continuously pending ask is never re-armed after its wake and (b) holds even
  without the set. The set matters when the SAME key comes back (a second ask in one attempt and
  round, S5's note): added T8b2 for it, which kills that mutant.
- `workflowWaitNote` (pure, in `workflow-status-line.ts`, item 8's file) builds the note's text;
  the plan only gave the text. `(since HH:MM)` sits after the last «waits for the user», so the
  hash approval reads `… waits for the user (since 12:04) to approve the run]`.
- `session-host.ts` (not in Files) gained the `workflowWait` option: the only way to inject the
  clock through the real `SessionHost.build` path. Production passes nothing (defaults).
- The timing lives on `SessionWake` (the plan said «options»): the wait wake exists only where the
  wake does.
- T8 (a)'s «persisted» is asserted on the `serve` daemon's own log (`SpyDaemonStore`) containing
  `workflow_wait`.
- Not exercised: a wait note queued while a turn runs is flushed at the NEXT turn's start, never
  mid-turn (by reading: `flushMidTurn`'s filter has no `workflow_wait`); the wake only queues it
  when idle, so this needs a turn starting inside the `kickWake` macrotask.
- Changelog: S1's fragment already describes this (no new one).

**Gate:** only the files above; full typecheck/lint/test left to the orchestrator's script. No
schema change (`note.kind` is a free string), so `protocol.json` is untouched and no
`protocol.d/` note.

## Review

*— claude-opus-5-5, 2026-11-25* (fresh context; same model family as the S2/S4/S6 executor —
shared blind spots possible)

**Verdict: APPROVE** — no HIGH/MEDIUM finding. Scope: `git diff main...HEAD`, S1–S6.

**Gate (re-run here):** `bun run typecheck` clean; `bun run lint` clean (2427 files, 0
fixes); touched files (`agent/workflow-status-line`, `agent/status-line-request`,
`daemon/workflow-hosted`, `core/workflow-ledger`): `109 pass, 0 fail`. Full `bun run test` not
re-run here (left to the merge gate, §10).

**Mutations (mine, reverted, `git status` clean after):**
- `flushMidTurn` without `isWorkflowEnd` → killed (T6 fails).
- `fireWorkflowWait` passes `attachedCount: 0` → killed (T8d fails).
The executor's S1–S6 mutation tables are consistent with the tests read; the one survivor
(«wake gate ignores autoWake») is equivalent as argued (no `wake` → no timer is armed:
`trackWorkflowWait` returns on `this.wake === undefined`).

**Attacks tried:**
1. *Prompt-injection via the line* — `name` and step ids go through `idProblem`
   (`core/src/workflow-spec.ts:385`, kebab-case) ; `reason`/`live`/titles never read
   (`live` only compared with `"slot"`). Holds.
2. *False «waits for the user»* — the driver's only `waiting` states are an ask
   (`workflow-driver.ts:1606`) and the slot (`:1800`); `setStep` keeps a prior sub-agent `live`
   label on an ask (≠ `"slot"`) and clears `live` on slot acquire (`:1796`). Holds (a sub-agent
   label of literally `slot` would misclassify — negligible).
3. *Cache breaking* — no `cache_control` anywhere in `packages/providers/src`; OpenAI-style
   prefix caching keeps the tail-only line cheap. Holds.
4. *Sub-agent sees the line / history leak* — only `Session.send/resume` pass `statusLine`;
   `withStatusLine` copies; T2/T3/T4 pin it. Holds.
5. *Double delivery / spurious wake after the mid-turn end note* — drained from the queue
   (`kept` compaction), `notesFlushedMidTurn` set by both callers (`agent.ts:1643`, `:1880`).
   Holds (T6).
6. *Model approves its own wait* — no tool path; `autoApproves` false (T5). Holds.
7. *Timer leaks* — `close` disarms; default timer is `unref`'d (`hosted-session.ts:528-532`).
   Holds.

**Accepted, not findings:** a client that attached at fire time and later detaches never gets
that ask's wake (Design failure table); the late-drain path (run ends during the final round)
is untested but shares `flushMidTurn`.

**Executor behaviour:** honest Execution notes, drift recorded (T8b2 added when the plan's
mutation premise proved wrong), red shown on assertions, mutation tables per slice.
