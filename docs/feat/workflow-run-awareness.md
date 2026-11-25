# feat/workflow-run-awareness — the agent knows a workflow run is live

> **Status:** implementation — **NOT approved** (owner questions below)
> **Branch:** `feat/workflow-run-awareness`
> **Size:** M · **Blast:** load-bearing (the agent loop's request builder) · **Suited:** Opus plans + executes S2/S4 (agent loop), DeepSeek executes S1/S3 (contained / small wiring); mandatory fresh-context Opus review of the group (§10)
> **Changelog:** `changelog.d/workflow-run-awareness.added.md` — `- **The agent knows a workflow is running.** Each request carries one short status line for the session's live run (step, waiting for you, retry/round, tokens); the run's end note is unchanged.`

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

**(b) Failure / waiting-for-the-user — annotate, do not wake (recommended, owner Q1).**

- A **mid-run failure** (a retry or an `on_fail.goto` follows) and a step **waiting for the
  user** change the line (above). **No wake, no persisted note.** Why:
  - waiting for the user: the ask already reaches the user through the single broker (TUI
    dialog, phone); the model cannot answer it (gate above). A wake would only make the model
    restate the ask — at the cost of one full request (the whole context, e.g. 30–60k prompt
    tokens) for ~0 value.
  - a failure that is retried: the run handles it; a terminal failure ends the run and the END
    note wakes, unchanged. Bound check: a run may execute up to `max_step_runs` steps
    (default 50, ≤ 1000; `core/src/workflow-spec.ts:39`, `:303`) with `retry ≤ 5` (`:36`) —
    a per-failure wake would be up to 50 wakes per run; a line costs nothing per failure.
- **The END note at a round boundary (owner Q4, recommended):** add `workflow_end` to the
  mid-turn drain (`flushMidTurn`, `agent.ts:2890-2900`), exactly like a sub-agent exit
  (docs/fix/subagent-error-report.md). A run that ends while the agent is in a long turn is
  then told in THAT turn, and the line disappears at the same round (no gap where the run is
  neither live nor reported). The follow-up `kickWake` sees `pendingExitCount === 0` and starts
  nothing; `notesFlushedMidTurn` is set as for other mid-turn notes (the stale-wake guard,
  `agent.ts:1468-1502`).
- **If the owner wants a wake anyway (Q1 option B, not recommended):** only for "waits for the
  user", only when no client is attached, at most ONE wake per run per 10 min (a per-run
  timestamp in `HostedSession`, pure gate `workflowWakeDue(lastAt, now, attached)`), its note a
  single coalesced line, never during a running turn (the line covers that). Slice S5 below.

**(c) Noise.** One line, only while a run is live, no new history entries, no new wakes. A
looping workflow changes the line's numbers, never its size; nothing accumulates.

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
- **T7 (S5, only if Q1 = B)** — fake clock: 10 asks in 5 min → 1 wake; none while a client is
  attached; none while a turn runs.

### Slices

| slice | what | size · blast | executes · review |
|---|---|---|---|
| S1 | pure `workflowStatusLine` + T1 | S · contained | DeepSeek · in-context |
| S2 | `RunOptions.statusLine` + `withStatusLine` + `Session.setStatusLine` + T2/T3 | S · load-bearing (agent loop) | Opus · fresh-context review |
| S3 | daemon wiring + doc pointer + changelog + T4/T5 | S · cross-module | DeepSeek · grouped with S2's review |
| S4 | `workflow_end` in the mid-turn drain + T6 (if Q4 = yes) | S · load-bearing | Opus · same review round |
| S5 | debounced wake (only if Q1 = B) + T7 | S · cross-module | Opus · same review round |

### Owner questions

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

### Notes / debt

- Pre-existing, out of scope: a failed attempt is never published (the next attempt's `running`
  overwrites it before `publish`, `workflow-driver.ts:1513-1518` → `:1469-1478`), so the phone
  and TUI show `retry 2` but never the failure reason. A separate `fix` if wanted (a wire field,
  e.g. `lastError` on the step row).
- The TODO cites `workflow-driver.ts:1155` for the end note; it is now `:1570`.

## Execution

*— (empty until the Implementation is approved)*

## Review

*— (empty)*
