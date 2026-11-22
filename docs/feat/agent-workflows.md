# feat/agent-workflows — workflow agentici che il modello scrive e tentacle esegue, a step

> **Status:** feat — promoted from eval 2026-11-22 (owner GO); Implementation APPROVED 2026-11-22; Execution running
> **Branch:** `feat/agent-workflows`
> Type: feat · Size: L (9 slices, none XL) · Blast: load-bearing (slices 3–4) · Suited: strong model + fresh-context review for slices 3–4; standard review for the rest
> **Changelog:** none

## Context

*— claude-opus-5-5, 2026-11-22*

**Richiesta dell'owner (22/11 01:55, testuale):** «creare in tentacle la possibilità di far
comprendere al modello dei workflow di lavoro agentico che lui può creare, a step, con le
eccezioni, la sequenza ecc, pensa a tekton per agenti, anche n8n è un'idea di ispirazione; con
lui che fa da orchestratore ma soprattutto anche creatore, magari una build usa un agente su
docker, con ogni step il suo prompt ecc.. che ne pensi? mi farai un report con pro contro cosa
ha senso cosa no ecc». 01:58: «anche la visualizzazione in TUI e in app, deve essere magnifica
per livello di accuratezza ma semplicità di utilizzo».

**La domanda.** Ha senso un workflow agentico *dichiarato* (step, sequenza, eccezioni,
dove gira ogni step), scritto dal modello e approvato dall'utente? Se sì, quale forma minima
costruiamo per prima?

### 1. Che cosa sarebbe, in termini di tentacle

Un workflow è un **file nel repo** (es. `.tentacle/workflows/<nome>.yaml`). Lo scrive il modello,
l'utente lo approva. Ogni step ha: un prompt, un modello, un *dove* (locale / docker / pod),
input e output, e una regola in caso di errore. Il motore **non è un nuovo agent loop**: ogni
step è un sub-agente, cioè la stessa chiamata di `agent_task` (`packages/tools/src/task.ts:363`),
che già accetta `model` per step (`task.ts:339-349`) e `background` (`task.ts:350-358`). Uno step
"comando" (build, test) è uno shell; su docker/pod c'è già `workload_shell`
(`packages/tools/src/workload-shell.ts:65` `WorkloadTarget`, permesso in
`packages/agent/src/permission-gate.ts:70`). Il trigger a orario esiste già: `schedule_create`
(`packages/core/src/tool-groups.ts:22`, `docs/feat/cron-tool.md`). Ogni permesso passa dal
**solo** `PermissionBroker` (`packages/core/src/permission.ts:211`). Il modello resta sul laptop
(`ProxyModelProvider`, `packages/daemon/src/proxy-model.ts:179`). Lo stato del run vive nel log
della sessione, come già i marker dei sub-agenti (AGENTS §7, persistenza). Nuovo è solo **un formato file + un piccolo esecutore deterministico**.

**Prova concreta che serve: noi stessi.** In `.tentacle/tmp/orchestration/` ci sono **963
script zsh** scritti a mano. `night-task3.sh` (59 righe) è proprio un workflow: plan (Opus) →
exec (DeepSeek, con retry su `ECONNRESET`, riga 24) → review Opus → loop fix/review fino a 3
round (righe 44-49) → lock di merge (riga 54) → gate su `main`, e se rosso revert (riga 58).
`chain-cron-tool.sh` concatena 6 slice, alcune su Opus, e si ferma al primo non-PASS.
`chain-ios-build-pushcore.sh` crea worktree → plan → exec → merge. Il verdetto si legge con
`grep "PASS"` (`night-task3.sh:27`): fragile. Dal telefono non si vede niente.

### 2. Tre forme, dalla più piccola alla più grande

**A — "Piano vivo" senza file.** Il modello dichiara un piano (lista step) con un tool, e lo
esegue lui stesso con `agent_task`. tentacle mostra solo il piano e lo stato degli step.
*Vede:* una rail di step sopra la chat (TUI e iPhone). *Costo:* S–M. *Sblocca:* visibilità.
*Limite:* nessuna garanzia. Il modello può saltare step, inventare un PASS, non ripetere.

**B — Workflow file + esecutore deterministico (consigliato).** Il file sopra. Il modello lo
crea (è un file: diff, review, git). L'utente lo approva una volta *come testo*. Poi un
esecutore in codice (non il modello) segue la sequenza: step per step, verdetto da un output
strutturato (non da `grep`), retry con limite, ramo d'eccezione, budget token totale.
*Vede:* `/workflow run <nome>`, una vista run (rail + dettaglio step), approvazioni dove
servono. *Costo:* L → da spezzare in slice M. *Sblocca:* sostituire i nostri script zsh,
ripetibilità, run da telefono, run staccati (detached) che continuano senza TUI.

**C — Motore completo stile n8n.** Trigger (webhook, push git, cron), editor visuale,
connettori, run paralleli multipli. *Costo:* L×n, un sottosistema nuovo. *Sblocca:* uso
"prodotto" per terzi. *Rischio:* rifare GitHub Actions/n8n peggio.

## Implementation

*— claude-opus-5-5, 2026-11-22*

### Owner decisions (22/11)

Recorded verbatim (owner, 2026-11-22, final):

1. **Files live in `workflows/` in the repo** (versioned). A run is approved for the file's **content hash**; editing the file needs a new approval. Every run records workflow name + version + hash.
2. **The CODE executes the sequence** (deterministic executor): order, `retry`, `on_fail` goto with counters, token caps, stop rules. The model writes/edits the workflow and does the work INSIDE each step. Steps end with a typed verdict (`pass`/`fail` + reason), never `grep`.
3. **A permission asked by a step during an unattended run: wait + phone notification + configurable timeout → `stopped`.** **BUT if the run is in auto-accept (auto mode) it is approved automatically** — reuse tentacle's existing auto-accept semantics and limits (`--auto-accept`, `docs/feat/detached-runs.md`; in a pod: tool asks only, allow once, logged). Auto-accept NEVER covers the `approve: user` step kind (merge/push stay a human approval, MVP), and never creates a lasting grant for pod-supplied input (AGENTS §7).
4. **First `where`: `local` + `docker` for `run` steps; `agent` steps local** (agent-in-pod later, depends on `docs/eval/subagent-in-pod.md`).
5. **Views (mockups are the spec, copied under `docs/feat/agent-workflows/`):**
   - TUI: rail block in the chat (`view.html` "TUI 1") + two-column panel on a key ("TUI 2").
   - iPhone: ONE place listing all runs (reachable from the hub, badge when a step waits for the user) — `diagram.html` "1 · Elenco"; a run's MAIN view is the **modern vertical graph 2C** with a toggle to the cards view (2A); tapping a node **morphs into the detail** (the node pill flies and grows into the detail header — EVERY inner part grows with it, no snap) with a **skeleton** (the real layout with text hidden behind shimmering bars, so nothing moves when data lands) — `transition.html` variant A. No bottom sheets for this. Reduce Motion → crossfade, static skeleton. Running = blinking/pulsing; states readable by SHAPE + glyph + word, never hue alone (owner colour-blind).
   - Merge/approve is always an explicit step with buttons.

### Load-bearing assumptions (proved against the source)

**A1 — a workflow step can reuse the sub-agent runner as-is, called by code instead of by the model.**
The runner is a plain function built once per session in the wiring layer, `createSubagentRunner(deps)` →
`{ run, types, readOnlyType }` (`packages/agent/src/subagent.ts:349-362`), wired at
`packages/cli/src/wiring.ts:645-670` and handed to `agent_task` only as a closure
(`wiring.ts:684`, `createTaskTool((opts, controls) => run(opts, controls), …)`). Its inputs are
`{description, prompt, type, model?}` + controls `{signal, onEvent, toolCallId, agentId, …}`
(`packages/tools/src/task.ts:29-63`). It already: resolves a per-call model by `models` name
(`subagent.ts:368`, `wiring.ts:640-644`), routes every child ask through the ONE requester and the
session's shared `SessionGrants` (`wiring.ts:615`, `:650`, `subagent.ts:463-470`), caps tokens
(`subagent.ts:460`, stop reason `max_token_budget`, `task.ts:167`) and streams `subagent_usage`
events carrying the spend (`subagent.ts:552-558`). Two additive per-call knobs are missing and are
the only runner change: `maxTokens` (today only `deps.maxTokens`, `subagent.ts:460`) and
`extraTools` (today only per type, `subagent.ts:308`, `:387`) — needed to offer the step's
`step_verdict` tool. So: **no new agent loop**; the executor is a caller of `run`.

**A2 — a run can live between turns, daemon-side, with its asks attributed to the turn that
started it, exactly like a background sub-agent.** `HostedSession` binds the background runtime
and records the spawning turn: `launched` → `spawnTurns.set(agentId, activeTurnId)`
(`packages/daemon/src/hosted-session.ts:1128-1143`); a background child's ask is never on disk
and is re-offered at every attach (`hosted-session.ts:300-310`); it reaches the client with
`turnId` = the spawning turn (`packages/protocol/src/permission.ts:81-87`, PROTOCOL 20 note in
`packages/protocol/src/version.ts`), and the client's auto-accept answers it when
`autoAcceptsTurn(turnId)` (`packages/client/src/remote-session.ts:747-755`) and
`autoApproves(req)` (`packages/core/src/permission.ts:294-296`). A child's exit becomes a
`background_exit` update + a wake (`hosted-session.ts:1144-1156`). A run copies this shape; it
adds no second session path (AGENTS §7 "TUI always over RPC").

**A3 — the durable facts of a between-turns job already have a replay rule we can mirror.**
`subagent_background`/`subagent_end` are NON-critical log entries
(`packages/protocol/src/session-log.ts:252-273`, table `:368-384`), emitted by the daemon log
(`packages/daemon/src/session-log.ts:204-210`), and ONE pure derivation, `subagentLoadNotes`
(`packages/core/src/agent-job-ledger.ts:382-407`), closes what a crash left open as a note, used
by both loads (`packages/daemon/src/session-log-store.ts:1177`,
`packages/daemon/src/daemon-state-file.ts:505`). Runs get the same: three non-critical entry types
+ `workflowLoadNotes` in the same two places (owner question Q1).

Every slice below stands on A1–A3; Slice 4 (driver) re-proves A1/A2 with a test before wiring
(red: a step's child ask arrives at a `SpyBroker` with the run's start turn id).

### Preconditions (verified)

- **Single broker.** Exactly one `PermissionBroker` (`packages/core/src/permission.ts:211`) per
  session tree; child asks and `run`-step asks go through the session's `permissions.request`
  (`wiring.ts:650`), never a new broker. The approve step and the hash approval are broker asks too.
- **Model on the laptop.** MVP runs only where the daemon is trusted: the in-process worker and a
  `serve` daemon. When the session is tunnelled (pod `run`/`attach`, `options.modelOverride`,
  `wiring.ts:631`) the `workflow` tool is NOT registered and `session/workflow` answers
  `"workflows run only on a laptop or serve session"`. Owner decision 4: no agent step in a pod.
- **Pod not trusted.** No pod ever executes or stores a run in MVP; `run` steps in docker are
  exec'd FROM the laptop-side daemon into a container (`WorkloadTarget`,
  `packages/tools/src/workload-shell.ts:65-70`): the container's output is data (a step's
  reason/report), never a branch decision other than through the validated verdict.
- **Persistence.** Runs persist only as `session/log` entries the client validates and
  re-serializes (AGENTS §7); the laptop and `serve` stores write them like every entry; pod daemons
  never persist. A run cut by a crash is closed when LOADED, never resumed silently.
- **Protocol.** New methods/fields/display updates are free (`UPDATE_CLASS`,
  `packages/protocol/src/updates.ts:535-583`). One change of MEANING needs a `protocol.d/` note
  (Slice 3): a permission ask that auto-accept must never answer — an older client would
  auto-approve it (same reasoning as PROTOCOL 20/22 in `version.ts`). Number edited only at merge.
- **Grants.** Prefix "always" rules for `shell`/`workload_shell` are the session's `SessionGrants`
  (`packages/agent/src/session-grants.ts:54`), keyed per workload (`workloadTargetKey`, `:36`);
  `run` steps reuse them untouched (a pre-approved prefix passes unattended, as the eval said).
- **YAML.** `Bun.YAML.parse` on the required Bun ≥ 1.4.3, typed view as in
  `packages/config/src/skills.ts:91-95`; no new dependency.

### Design

#### D1 — File format `workflows/<name>.yaml` (on-disk record, versioned)

```yaml
schemaVersion: 1                 # unknown → refused, file untouched (like log headers)
name: task                       # = file stem, [a-z0-9-], ≤ 64
version: 3                       # user integer, bumped by hand; display + recorded
description: plan → exec → review loop → gate → merge
inputs:                          # strings only in v1
  slug: { required: true }
  doc:  { default: "" }
budget: { tokens: 3000000, wait: 12h, max_step_runs: 50 }
steps:
  - id: plan
    agent: { prompt: prompts/plan.md, model: opus, type: general, tokens: 400000 }
  - id: exec
    agent: { prompt: prompts/exec.md, model: deepseek }
    retry: 1
  - id: review
    agent: { prompt: prompts/review.md, model: opus }
    on_fail: { goto: fix, max: 3 }
    next: gate                     # pass leaves the fix/review loop (see D1.1)
  - id: fix
    agent: { prompt: prompts/fix.md, model: deepseek }
    next: review
  - id: gate
    run: bun run check
    where: { docker: tentacle-ci }   # local (default) | { docker: <container> [, container: <c>] }
    timeout: 20m
  - id: merge
    approve: { title: "Merge {{inputs.slug}} into main" }
  - id: ios
    run: bun run e2e
```

Rules (one zod schema, strip, in `packages/core/src/workflow-spec.ts`; a pure
`validateWorkflow(text, ctx) → {ok, spec} | {ok:false, errors[]}`; every error names the
YAML path, e.g. `steps[3].on_fail.goto: no step "fx" (did you mean "fix"?)`):
- A step has exactly ONE of `agent` | `run` | `approve`; `id` unique, `[a-z0-9-]`.
- `where`: `local` | `{docker}`; `agent` steps `local` only (decision 4). Engine `docker` only in v1.
- `retry: 0..5` (default 0) re-runs the same step after `fail`. `on_fail`: `stop` (default) |
  `{goto: <id>, max: 1..10}`. `next: <id>` replaces the fall-through after `pass`.
- **Termination (validated, not hoped):** the graph of *pass* edges (fall-through + `next`) must be
  acyclic; every cycle must contain a counted `on_fail.goto` edge. Belt: `budget.max_step_runs`
  (default 50) step executions per run → `stopped: budget`.
- Prompts: `prompt:` is a path relative to `workflows/`, resolved and refused if it leaves the
  repo; or `prompt_text:` inline. Substitution only — `{{inputs.<k>}}`,
  `{{steps.<id>.reason}}`, `{{steps.<id>.report}}` (latest attempt); no expressions. Unknown
  reference → validation error.
- `model` must be a `models` name of this session (checked at start against the same list the
  runner resolves, `wiring.ts:640-644`); `type` an agent type (`types`, `wiring.ts:645`).
- Durations `30s|20m|12h`; `tokens` integers. `approve` takes `title` (≤ 200) and optional
  `detail` (≤ 2000), both templated.

**Hash** (`workflowHash`, same module): sha256 over `"tentacle-workflow-v1\0"` + the YAML bytes +
for each referenced prompt file, sorted by path: `path\0bytes\0`. The hash covers the prompts
because they ARE the workflow.

#### D2 — Approval for the hash (decision 1)

At start the driver computes the hash and looks it up in the laptop store
`<configDir>/workflow-approvals.json` (`{project: projectKey(cwd), path, hash, approvedAt}[]`;
`projectKey` at `packages/agent/src/session-store.ts:151`; atomic write). Missing → a broker ask
of the new kind **`workflow_approve`** (`title: "Run workflow task v3 (hash 3f2a…)"`, `detail`: the
step list one line each, incl. every `run` command and `where`). Allowed → the entry is written,
then the run starts. Edited file → new hash → asked again. The store is written only by a
laptop-side process (worker or `serve` on the user's host); a pod never reads or writes it.

#### D3 — Executor: a pure state machine + a thin driver

- **Pure** `packages/core/src/workflow-machine.ts` (no I/O, no clock): `start(spec, inputs)` →
  state; `next(state, event) → {state, action}` where events are `step_result{verdict, reason,
  tokens, report?}`, `budget_hit`, `timeout`, `cancel`, `interrupted`; actions are
  `run_step{id, attempt, round}`, `end{state, reason}`. It owns order, `retry`, `goto` counters
  (per edge), `max_step_runs`, run token sum vs `budget.tokens`. Fully unit-tested.
- **Step states:** `pending ○`, `running ▸` (blinks), `waiting ⧗ "attende permesso"` (a child/run
  ask is open), `needs-approval ? "attende te"`, `ok ✓`, `error ✗`, `stopped ‖`; retry shows
  `↻ n/m`. **Run states:** `running`, `waiting`, `needs-approval`, `ok`, `error`,
  `stopped{budget|timeout|cancelled|interrupted|changed}`. Glyph + word always (decision 5).
- **Driver** `packages/agent/src/workflow-driver.ts` (one per session, like `AgentJobs`):
  - `agent` step → `run({description: "<wf>/<step>", prompt, type, model}, {signal, onEvent,
    toolCallId: runId, agentId: "<runId>.<step>", maxTokens, extraTools: [stepVerdictTool]})`.
    Takes one slot of the ONE sub-agent cap (`packages/core/src/agent-jobs.ts:286`, refused when
    full — header `:9-10`): the driver then waits for a free slot (`onExit`), shown as
    `waiting · slot`, never errors.
  - **Typed verdict:** `step_verdict{verdict: "pass"|"fail", reason ≤ 2000}` (zod-validated
    daemon-side; first valid call wins, the child is told to stop). Child ends without one →
    `fail: "no verdict"`; `max_token_budget` → `stopped: budget`; thrown → `error` with the
    partial report (`SubagentFailure`, `agent-jobs.ts:55`).
  - `run` step → the existing `shell` tool (local) or the workload exec seam
    (`workload-shell.ts:122-137`) through `PermissionGate.authorize`
    (`packages/agent/src/permission-gate.ts:158-169`) with the session's grants and requester:
    exit 0 → `pass`; else `fail: "exit N"` + last 20 lines; `timeout` → kill → `fail: "timeout"`.
  - `approve` step → broker ask `workflow_approve` (allow-once / deny only). Allow → `pass`;
    deny → `fail: "denied"` (+ the reply text, `permission.ts:64-68`); never auto-accepted.
  - **Wait timeout (decision 3):** every ask a step raises gets `signal = any(runSignal,
    timeout(budget.wait))` (`PermissionRequestOptions.signal`, `permission.ts:129`); expiry →
    step `stopped`, run `stopped: timeout`.
  - **Auto-accept (decision 3):** nothing new on the daemon. Asks carry `turnId` = the run's
    start turn (A2), so a client with auto-accept on answers tool asks allow-once (logged, as
    today); `autoApproves` gains `req.kind !== "workflow_approve"` (`permission.ts:294`), and
    `toPermissionRequest` (`packages/client/src/permission-router.ts:102`) maps wire tool
    `workflow_approve` → `kind: "workflow_approve"`. The driver offers no `allow_always` on it.
  - One run per session at a time (a second start is refused with the running one named).
  - Start paths: the model's `workflow` tool (`validate | run | status | stop`; `run` inside a turn
    → start turn = active turn) and the user's `session/workflow` RPC (`start | stop | resume |
    rerun_step`, client-minted `turnId` as `session/prompt`, `session.ts:479`; `wake-` refused as
    today, `connection.ts:1163-1175`).
  - End → a note in the conversation (`[workflow wf-3 task: ok · 7/7 · 1.4M tok]`) +
    `background_exit`-style notice + wake, as `hosted-session.ts:1144-1156`.
  - **Snapshot at start:** the parsed spec + prompt texts are held in memory for the whole run; a
    mid-run edit of the file does not affect it. `resume`/`rerun_step` recompute the hash and
    refuse on mismatch (`stopped: changed` → "start a new run").

#### D4 — Storage and replay (session log)

Three NEW **non-critical** types (owner Q1), `packages/protocol/src/session-log.ts`:
- `workflow_start {runId "wf-N", name, version, hash(64 hex), path, inputs (≤ 4 KiB), by:
  "user"|"model", turnId?}`
- `workflow_step {runId, stepId, attempt, round, state: ok|error|stopped, verdict?, reason ≤ 2 KiB,
  model?, where, tokens, durationMs, prompt ≤ 16 KiB (resolved), report ≤ SUBAGENT_REPORT_MAX_CHARS}`
- `workflow_end {runId, state, reason}`

Only TERMINAL facts are durable; `running`/`waiting` live in memory and on the wire. Pure
`workflowLoadNotes(entries, messages)` (new, next to `subagentLoadNotes`) closes a `start` without
`end` as `stopped: interrupted` with a note carrying `id` (idempotent, as
`agent-job-ledger.ts:375-381`), wired in the same two loads. Resume after a crash is explicit
(`session/workflow{resume}` from the step that was cut, re-run from scratch, attempt +1; owner Q4).

#### D5 — Wire (how TUI and phone see runs)

- Display update **`workflows`** (full state of the session's runs: current + last 5 ended), like
  `subagents` (`updates.ts:425-428`, class `display`), + optional snapshot field `workflows`
  (beside `subagents`, `packages/protocol/src/session.ts:973`) + reverse mapping in
  `packages/client/src/mapping.ts`. Row: `{runId, name, version, hash, state, reason?,
  tokens, budget, startedAt, endedAt?, steps: [{id, kind, model?, where, state, attempt, round,
  maxRound?, reason?, live? (last action, ≤ 200), durationMs?}]}`; all strings `line()`-bounded.
- Method **`session/workflow`** (above) and daemon-level **`workflow/list`** (serve only): rows
  `{sessionId, title, runId, name, state, step, done/total, needsUser: bool, startedAt, endedAt?}`
  for live sessions — the phone's "Elenco". Detail (`prompt`, `report`) is read on demand from
  `session/log` (no new method).
- **Push (decision 3):** a step's ask is a `permission_request` → the existing `ask` push
  (`packages/daemon/src/push-notifier.ts:455`) already fires on `serve`. Run end: owner Q5.
- `protocol.d/agent-workflows.md`: "a `permission_request` with tool `workflow_approve` must never
  be auto-accepted; an older client would auto-approve a merge step".

#### D6 — Views (spec = mockups)

- **TUI** (§7: logic in pure modules): `packages/tui/src/workflow-view.ts` projects a row to the
  rail lines of `view.html` TUI 1 (header `workflow task · <input> · 4/7 · 1.2M/3M tok`, one line
  per step, live tail under the running step, as `subagent-view.ts` with `SUBAGENT_TAIL_ROWS`,
  `subagent-view.ts:17`); `WorkflowBlock.tsx` renders it. The two-column panel (TUI 2) is a panel
  kind `panels/workflow.ts` + one registry line (`packages/tui/src/panels/registry.ts:26-31`), its
  key picked free against the `keys/` contract tests; `[r]` rerun step, `[o]` full output, `[a]/[d]`
  on an approve step.
- **iPhone:** pure modules `workflow-list.ts` (Elenco rows, `needsUser`), `workflow-graph.ts`
  (2C geometry, reusing `step-rail.ts` constants), `workflow-morph.ts` (frame interpolation of
  pill → header: position, size, radius, glyph, label, font size, all from one progress value),
  `workflow-skeleton.ts` (the detail layout with bar widths); screens `WorkflowRuns.tsx`,
  `WorkflowRun.tsx` (graph ⇄ cards toggle), `WorkflowStep.tsx` (detail, no sheet). Running =
  `runningDotLook(reduceMotion)` (`apps/mobile/src/step-blink.ts:30`); Reduce Motion → crossfade +
  static skeleton. Hub entry `runs` in `hub-actions.ts:12`; its "badge" uses the CURRENT hub idiom
  — rim arc + one-shot glow/haptic, no dot (`docs/feat/mobile-hub-badges.md` Q1 C/Q2 C).

### Slices (dependency order; no XL)

| # | Slice | Size · Blast · Suited | Files |
|---|-------|----------------------|-------|
| 1 | Format + validation + hash | M · contained · standard review | `core/src/workflow-spec.ts` (new), `core/src/index.ts` |
| 2 | Pure executor machine | M · contained · standard review | `core/src/workflow-machine.ts` (new) |
| 3 | Log types + load notes + wire (update, snapshot, methods, mapping, `protocol.d`) | M · **load-bearing** (persistence, protocol) · fresh-context review | `protocol/src/session-log.ts`, `updates.ts`, `session.ts`, `methods.ts`, `core/src/workflow-ledger.ts` (new), `daemon/src/session-log.ts`, `session-log-store.ts`, `daemon-state-file.ts`, `client/src/mapping.ts`, `protocol.d/agent-workflows.md` |
| 4 | Driver + wiring (local agent/run/approve steps, hash approval, auto-accept exclusion, timeout, `workflow` tool, `session/workflow`) | L · **load-bearing** (broker, agent runner, auto-accept) · fresh-context review | `agent/src/subagent.ts` (2 knobs), `agent/src/workflow-driver.ts` (new), `tools/src/workflow.ts` (new), `core/src/permission.ts`, `client/src/permission-router.ts`, `daemon/src/hosted-session.ts`, `daemon/src/connection.ts`, `cli/src/wiring.ts`, `cli/src/workflow-approvals.ts` (new) |
| 5 | `run` steps in docker | M · cross-module · standard review | `agent/src/workflow-driver.ts`, `tools/src/workload-shell.ts` (exec seam reuse only) |
| 6 | TUI rail + panel + `/workflow` slash | M · contained · standard review | `tui/src/workflow-view.ts`, `WorkflowBlock.tsx`, `panels/workflow.ts`, `panels/registry.ts`, slash registry |
| 7 | iPhone Elenco + graph 2C ⇄ cards 2A + approve buttons | M · contained · standard review | `apps/mobile/src/workflow-list.ts`, `workflow-graph.ts`, screens, `routes.ts`, `hub-actions.ts` |
| 8 | iPhone morph + skeleton | M · contained · standard review | `workflow-morph.ts`, `workflow-skeleton.ts`, `WorkflowStep.tsx` |
| 9 | Notifications + hub signal (`workflow/list` `needsUser`, run-end push per Q5) | M · cross-module (push plaintext is versioned) · standard review | `protocol/src/push.ts`, `daemon/src/push-notifier.ts`, `push-rules.ts`, app extension mapping |

Load-bearing: 3 and 4 (strong executor, mandatory fresh-context review red-teaming the single
broker, the auto-accept exclusion, and the persistence rules). A changelog fragment
`changelog.d/agent-workflows.added.md` lands with Slice 6 (first user-visible surface).

### Failure modes (how each converges)

| Slice | Failure | Converges to |
|---|---|---|
| 1 | bad YAML, unknown `schemaVersion`, pass-edge cycle, missing prompt, path escape, unknown model | refused before any ask; every error with its YAML path; nothing runs |
| 2 | `goto` max reached / retry exhausted / `max_step_runs` / token sum ≥ budget | `error` (counter) or `stopped: budget`; never another step |
| 3 | crash between `workflow_start` and `workflow_end` | load appends `stopped: interrupted` note (idempotent); never shown as running |
| 3 | older build reads the log | skips the three non-critical types; conversation intact (Q1) |
| 3 | older client / daemon | `workflows` → `unsupported` once; `session/workflow` → MethodNotFound "update tentacle"; approve-kind skew → `VersionMismatch` at `initialize` (protocol.d) |
| 4 | daemon crash mid-step | step closed `interrupted`; `resume` re-runs that step from scratch (attempt +1) — never mid-step |
| 4 | client disconnect (`serve`) | run continues; open asks re-offered on re-attach (`hosted-session.ts:300-310`) |
| 4 | plain TUI quit (in-process worker) | worker dies with the run; next load closes it honestly (unattended needs `connect` to `serve`) |
| 4 | ask unanswered past `budget.wait` | step `stopped`, run `stopped: timeout`, ask withdrawn |
| 4 | auto-accept on | tool asks allow-once; `workflow_approve` (hash and approve step) still waits for a human |
| 4 | file edited mid-run | running run unaffected (snapshot); `resume`/`rerun_step` → `stopped: changed` |
| 4 | child without verdict / verdict tool misuse | `fail: no verdict`; invalid input → tool error to the child, it may retry within its budget |
| 4 | sub-agent cap full | `waiting · slot` until an exit; never an error |
| 5 | container missing/stopped, no `/bin/sh` | `fail` with the seam's own explanation (`workload-shell.ts:137`, `:175`) |
| 6–8 | update lost / reconnect | full-state `workflows` + snapshot field repaint; nothing stale |
| 7–8 | detail data late | skeleton holds the final layout; no reflow |
| 9 | push not delivered | the ask is still re-offered on attach; push is a nudge, never the only path |

### Tests (red first; the property that kills each failure)

- **S1** `core/test/workflow-spec.test.ts`: each invalid fixture → the exact error path; a
  pass-edge cycle is refused while the `review→fix→review` (goto max 3) example is accepted;
  hash changes when ONE byte of the YAML or of ONE prompt file changes, and is identical for identical bytes.
- **S2** `core/test/workflow-machine.test.ts`: scripted event lists → exact action sequences:
  retry 1 then fail → `on_fail`; goto counter stops at `max` (mutation: off-by-one fails it);
  `max_step_runs` stops a long loop; budget event stops before the next step.
- **S3** log round-trip of the three types through the strip schemas; `workflowLoadNotes` closes an
  open run once and returns `[]` on the second load; an older-reader simulation (types removed from
  the known set) still loads the conversation; mapping test for `workflows`; `version.test.ts`
  untouched (number moves at merge).
- **S4** (driver, fakes only: fake runner, `SpyBroker`, fake clock):
  - a child's ask reaches the ONE broker with `turnId` = start turn (A2); mutation: a private
    broker → test fails (the single-broker pattern).
  - `autoApproves({kind:"workflow_approve"})` is false; a client with auto-accept on answers a
    step's tool ask and does NOT answer the approve step (red on current `permission.ts:294`).
  - unapproved hash → ask before any step runs; approved hash → no ask; one edited byte → ask again.
  - `budget.wait` expiry → `stopped: timeout` and the ask is withdrawn.
  - tunnelled session → no `workflow` tool; `session/workflow` refused.
  - mid-run file edit: the run uses the snapshot; `resume` refuses with `changed`.
- **S5** fake engine exec: exit 0 → pass, exit 2 → fail with tail; timeout kills; the ask names
  the container (grant scoped per workload, `session-grants.ts:36`).
- **S6** `ink-testing-library` frames (pattern of `packages/tui/test/app.test.tsx`): rail lines
  match `view.html` TUI 1 text; every state has glyph + word (frame text, SGR stripped).
- **S7–S8** pure-module tests: list rows / `needsUser`; graph geometry; morph frames are monotone
  and every inner part interpolates (no property jumps between two consecutive frames); skeleton
  bar boxes equal the loaded layout boxes; reduce-motion picks crossfade.
- **S9** push rules: a run waiting on the user produces exactly one push; resolved → `ask_resolved`.

### Owner questions (≤ 5, each with a recommendation)

1. **Log criticality.** `workflow_start` / `workflow_step` / `workflow_end` all **non-critical**?
   *Recommend: yes.* They project nothing into the conversation (the end note is an ordinary
   message), so an older build skips them losslessly and the log `PROTOCOL_VERSION` need not move
   for them (`session-log.ts:12-22`).
2. **Hash approval under auto-accept, and where it is remembered.** *Recommend:* the hash approval
   is a `workflow_approve` ask, **never** auto-accepted (it authorises a whole sequence, i.e. a
   lasting grant), remembered per project + path + hash in the laptop store
   `<configDir>/workflow-approvals.json` across sessions.
3. **`where: docker`** = an EXISTING named container (exec into it) in v1? *Recommend: yes*; a
   fresh container per step from an `image:` needs the `EngineHost` create/delete lifecycle
   (AGENTS §7 pod/container lifecycle) — a follow-up task.
4. **After a crash:** explicit `resume` (user/phone button) or automatic re-run of the cut step on
   reload? *Recommend: explicit* — a reload never starts work by itself (same rule as a cut turn).
5. **Defaults + run-end push.** `budget.wait` default **12h**, and two new push kinds
   `run_done` / `run_stopped` (the app shows its placeholder for them until updated, push.ts v1
   rule)? *Recommend: yes to both.*

### Owner decisions (2) — answers to the questions above (22/11 ~20:00)

*— claude-opus-5-5 (orchestrator), 2026-11-22 — owner answered «ok» to all five recommendations*

1. `workflow_start` / `workflow_step` / `workflow_end` are **non-critical**.
2. The hash approval is a `workflow_approve` ask, **never** auto-accepted, remembered per
   project + path + hash in `<configDir>/workflow-approvals.json` across sessions.
3. `where: docker` in v1 = exec into an **existing** named container; a container per step from
   `image:` is a follow-up task.
4. After a crash: **explicit** `resume` only; a reload never re-runs a step by itself.
5. `budget.wait` default **12h**; new push kinds `run_done` / `run_stopped`.

**Implementation APPROVED** (owner, 22/11). Execution routing (owner): Claude models run on the
**condo** account; slices 3–4 (load-bearing) executed by Opus, the others by DeepSeek; fresh-context
Opus review per group (1–4, then 5–9); merge after the owner's OK.

## Execution

*— deepseek-v4-pro (executor), 2026-11-22 — slices 1 and 2 only*

### Load-bearing check re-run (before any edit)

`.tentacle/tmp/agent-workflows/repro-missing.ts` on the branch tip (`00b5c059`):

```
core exports: 249
workflow exports: []
Bun.YAML.parse: function
sha256: 2d711642
```

A1's premise holds but is **not** what slices 1–2 consume: they never touch
`createSubagentRunner` (that is Slice 4's). What they do stand on is proved here:
`Bun.YAML.parse` exists on the pinned runtime (Bun 1.4.3) and sha-256 is available
with no new dependency. Capability missing, as expected for a feat.

### Drift from the Implementation (2 items, both reconciled in this doc)

1. **D1's termination rule contradicted D1's own example.** The rule says "the graph
   of *pass* edges must be acyclic", but the example's `review` had `on_fail: {goto:
   fix, max: 3}` and no `next:`, so after `pass` it fell through into `fix`, whose
   `next: review` closed a pass-only cycle. Proved with a script
   (`.tentacle/tmp/agent-workflows/cycle-check.ts` → `pass-edge cycle: plan → exec →
   review → fix → review`), and by the validator itself refusing the fixture.
   **Fixed the example, not the rule** (the rule is what makes the machine
   terminate): added `next: gate` to `review`. This is the one edit to the
   Implementation text; nothing else in it changed.
2. **`WorkflowContext.readPrompt` / `prompts` instead of the doc's "a pure
   `validateWorkflow(text, ctx)`" reading files itself.** The module stays I/O-free
   (it is in the phone's bundle, where `node:` does not exist), so the caller reads
   prompt files and `ctx.readPrompt` only *checks* a path. `spec.prompts` (path +
   bytes, sorted) is what `workflowHash` covers — same property, D2's "the hash
   covers the prompts because they ARE the workflow".

### As built, in order

**Slice 1 — `packages/core/src/workflow-spec.ts` (new, 876 lines) + `core/src/index.ts`**

- One zod schema (`.strict()` on every object, so an unknown key is a refusal) for
  structure, then hand-written readers for the polymorphic parts (`where`,
  `on_fail`, which of `agent`/`run`/`approve`) because a zod union reports
  `invalid_union`, which names neither the fix nor the YAML path. Every error is
  `steps[3].on_fail.goto: no step "fx" (did you mean "fix"?)`; all errors are
  returned at once (`errorsOf(broken).length === 3` is a test).
- Rules implemented exactly as D1: `schemaVersion` refused first (unknown → one
  message, file untouched), `[a-z0-9-]` ids and name, name == file stem, exactly one
  kind per step, `retry 0..5`, `on_fail stop|{goto,max 1..10}`, `next` overrides
  fall-through, agent steps `local` only, `where: local|{docker[,container]}`,
  durations `30s|20m|12h`, `approve.title ≤ 200` / `detail ≤ 2000`, template
  references (`{{inputs.k}}`, `{{steps.id.reason|report}}`) validated against the
  declared inputs and step ids.
- **Termination** (`cycleProblem`): DFS over the PASS graph only — a back edge there
  is an uncounted loop and is refused; a cycle through an `on_fail.goto` edge is
  allowed (it has a `max`) and `budget.max_step_runs` backs it. The first
  implementation walked goto edges too and thereby *laundered* pass-only cycles that
  shared a goto's endpoints — a real defect the uncounted-cycle test caught; it now
  walks pass edges alone.
- `workflowHash(text, prompts, hasher)`: sha-256 over `"tentacle-workflow-v1\0"` +
  YAML (BOM stripped)+ for each prompt sorted by path `path\0bytes\0`. **No
  `node:crypto`**: the hasher comes from `Bun.CryptoHasher` via `runtimeHasher()`,
  and with none it THROWS rather than return a weaker digest (`core` is imported by
  `apps/mobile`, which has neither `Bun` nor a read-only global to stub — proved:
  `Object.getOwnPropertyDescriptor(globalThis,"Bun")` → `writable:false`).
- Also exported: `renderTemplate`/`resolveInputs`-style helpers the machine and the
  driver both need, `parseWorkflowDuration`, `promptPathProblem`, `capWorkflowText`,
  `shortHash`.

**Slice 2 — `packages/core/src/workflow-machine.ts` (new, 445 lines)**

- `start(spec, inputs)` → state + first `run_step`; `next(state, event)` → state +
  action. Events: `step_result{verdict,reason?,tokens?,report?}`, `budget_hit`,
  `timeout`, `cancel`, `interrupted`, `changed`. Actions: `run_step{id,attempt,
  round,maxRound?,text}` (text already templated) and `end{status,reason}`.
- Owns: fall-through/`next` order, `retry` (same step, `attempt+1`), per-EDGE goto
  counters (`from->to`, so two loops never share one), `max_step_runs`, the token
  sum, and the two guards checked **before** a step starts (never after).
- `rerunAt(state,id)` = owner Q4's explicit resume: re-enters from scratch with
  `attempt+1`, keeps the execution counters, so a resume cannot loop past the cap.
- Terminal states are FINAL (`next` returns the identical end) and carry their own
  `detail` sentence, so the action's reason and `endReason` can never disagree —
  found by a test: a derived sentence had silently dropped the
  `on_fail.goto fix already ran 2/2 times` detail.
- One more caught defect: `cancel` mapped to stopReason `cancel`, which is not a
  `WorkflowStopReason` (`cancelled` is); fixed in `next`.

### Tests (red first, then mutation-checked)

`packages/core/test/workflow-spec.test.ts` (45 tests) and
`packages/core/test/workflow-machine.test.ts` (21 tests). For NEW modules "red
first" is the refused/accepted fixture pairs plus the mutation run below (§9).

Every failure mode in the plan's table that belongs to slice 1–2 has a test: bad
YAML, unknown `schemaVersion`, missing prompt, path escape, unknown model/type,
uncounted cycle vs the counted loop, and (slice 2) goto max reached, retry
exhausted, `max_step_runs`, token sum ≥ budget, budget_hit, timeout/cancel/
interrupted/changed, a late event on a terminal run, per-edge counters, resume.

```
bun test packages/core/test/workflow-spec.test.ts packages/core/test/workflow-machine.test.ts
 66 pass, 0 fail, 182 expect() calls
```

**Mutation check** (`.tentacle/tmp/agent-workflows/mutations.sh`; each mutates the
real source, runs only the pinning file, restores). All 11 went red — none vacuous:

```
red OK: S1 hash ignores prompt bytes          red OK: S2 goto off-by-one
red OK: S1 hash is order-dependent            red OK: S2 retry ignored
red OK: S1 pass-edge cycle accepted           red OK: S2 token budget not enforced
red OK: S1 unknown reference accepted         red OK: S2 max_step_runs not enforced
red OK: S1 unknown schemaVersion accepted     red OK: S2 terminal state not final
                                              red OK: S2 shared goto counter
```

No neighbouring suite regressed: `bun test packages/core/test/schedule.test.ts
packages/core/test/agent-job-ledger.test.ts packages/config/test` → 545 pass,
0 fail.

### Gate / changelog / protocol

- `bunx biome check` on the five changed files: clean.
- `bunx tsc --noEmit`: no `workflow` error. `bunx tsc -p apps/mobile`: clean (the
  module is in the phone's bundle — the reason for the no-`node:` rule).
- **Full `bun run check` is the orchestrator's** (per the executor instruction).
- **No changelog fragment**: the plan puts `changelog.d/agent-workflows.added.md`
  with Slice 6, the first user-visible surface; slices 1–2 are internal modules
  (`docs/eval/changelog-discipline.md`).
- **No `protocol.d/` note, no `PROTOCOL_VERSION` edit, no schema regeneration**:
  slices 1–2 touch no wire, no log type, no persisted format. `packages/protocol/
  schema/protocol.json` is unchanged.

### Unverified / left to later slices

- `WorkflowSpec.budget.waitMs` and `step.timeoutMs` are parsed and carried but
  nothing enforces them yet — the driver (Slice 4) is what arms the timer.
- `rerunAt` has no test for the "file changed" refusal: the hash comparison is
  Slice 4's (`stopped: changed` needs the laptop store); the state/event exists and
  is tested, the comparison is not built.
- `promptText` is only populated from `prompt_text:` in the fixture path; a
  `prompt:` file's bytes reach the spec via `spec.prompts` and are joined by the
  driver, deliberately (the validator never holds two copies).

### Slice 3 — log types + load notes + wire

*— claude-opus-5-5 (executor), 2026-11-22 — slice 3 only*

**Load-bearing check re-run (A3), before any edit.** `subagent_background` /
`subagent_end` are non-critical (`protocol/src/session-log.ts:252-271`, table
`:368-384`), emitted by `daemon/src/session-log.ts:204-210`, and the ONE derivation
`subagentLoadNotes` (`core/src/agent-job-ledger.ts:382-407`) is called by both loads
(`daemon/src/session-log-store.ts:1177`, `daemon/src/daemon-state-file.ts:505`). The
readers' known set is derived from `LOG_ENTRY_CRITICAL`
(`client/src/session-log-reader.ts:77`, `daemon/src/session-log-file.ts:101`), so a
new type needs no reader edit. `MessageNote.kind` is a bounded free string
(`protocol/src/session.ts:46-53`), so a new note kind is not a wire change. **Holds.**

**As built, in dependency order**

1. `protocol/src/session-log.ts`: `LogWorkflowStartEntrySchema`, `…StepEntrySchema`,
   `…EndEntrySchema` in `KnownLogEntrySchema`; all three `false` in
   `LOG_ENTRY_CRITICAL`. Every state / verdict / `by` / `stopReason` is
   `WorkflowWordSchema`, a bounded free word, **never an enum**: a malformed KNOWN
   entry makes a reader refuse the whole file, so a newer build's new state must not
   poison an older one (the review-M4 lesson of `subagent_end.stopReason`). Bounds
   exported as constants (`WORKFLOW_*_MAX_CHARS`).
2. `protocol/src/session.ts`: `WorkflowStepRowSchema`, `WorkflowRowSchema`
   (labels `line()`), the snapshot field `workflows`, `WorkflowParamsSchema` (a
   discriminated union on `action`: `start{name, inputs?, turnId}` · `stop{runId}` ·
   `resume{runId, turnId}` · `rerun_step{runId, stepId, turnId}`),
   `WorkflowResultSchema {ok, runId?, reason?}`, `WorkflowList{Params,Row,Result}`.
3. `protocol/src/updates.ts`: `WorkflowsUpdateSchema {type:"workflows", runs}`,
   class `display`. `protocol/src/methods.ts`: `session/workflow`, `workflow/list`.
4. `core/src/workflow-ledger.ts` (new; exported from `core/src/index.ts`): the
   body builders `workflowStartBody` / `workflowStepBody` / `workflowEndBody` — the
   ONE place an entry is built: every text capped (head + tail), counts made
   non-negative integers, the result judged by the entry's own schema, and a body
   that still fails (a bad run id / hash / step id: a caller bug) **throws** before it
   can reach a log. `capWorkflowInputs` keeps the inputs ≤ 4 KiB of JSON and says
   how many it dropped. `workflowLoadNotes(entries, messages)`: replays the current
   segment, drops ended runs and runs a `workflow_end` / `workflow_interrupted` note
   already names, returns one `[workflow wf-N …: stopped · interrupted]` user note per
   open run (note `{kind:"workflow_interrupted", id: runId}`) — idempotent.
   `core/src/model.ts`: `NOTE_KIND.workflowEnd`, `NOTE_KIND.workflowInterrupted`.
5. `daemon/src/session-log.ts`: `workflowStart` / `workflowStep` / `workflowEnd`
   emitters (`critical: false`). `session-log-store.ts` and `daemon-state-file.ts`:
   `workflowLoadNotes` beside `subagentLoadNotes`, same entries, same messages.
6. `client/src/mapping.ts`: `workflows` → `null` (session-level, consumed by its own
   listeners like `subagents`; those listeners are Slice 6).
7. `protocol.d/agent-workflows.md` (the `workflow_approve` meaning change + the
   additive list); `packages/protocol/schema/protocol.json` regenerated
   (`bun run schema:export`).

**Drift from the Implementation (each reconciled here; no Design rule changed)**

1. **`inputs` is a list `[{name, value}]`, not a record**, in the log entry and in
   `session/workflow{start}`: the JSON-schema export refuses `z.record`
   (`protocol/src/json-schema.ts:198`, "unrepresentable zod type ZodRecord"). Shape
   only; D4's "≤ 4 KiB" holds (`capWorkflowInputs`).
2. **`workflow_end` carries an optional `stopReason`** (free word) beside `state` +
   `reason`, so a view does not parse the sentence; additive.
3. **Row `reason` / `live` are bounded plain strings, not `line()`**: a failed `run`
   step's reason carries its last output lines (newlines), which `line()` refuses —
   a refusal would turn the whole display update into an error. Labels (ids, name,
   state, where, model) are `line()`. The client flattens for display (Slice 6).
4. **`core/src/model.ts`** (not in the slice's file list): two `NOTE_KIND` constants
   — the one registry of note kinds this build writes.
5. **Methods registered without a daemon handler yet.** Until Slice 4 wires
   `connection.ts`, a call to `session/workflow` / `workflow/list` on this branch
   answers `unexpected method` (`daemon/src/connection.ts:599-600`), not a result.
   No client calls them yet. The branch must not merge before Slice 4.
6. **The `protocol.d` note describes Slice 4's change** (the auto-accept exclusion
   of `workflow_approve`, `core/src/permission.ts:294`), placed here because the
   slice table puts it here. It is only true once Slice 4 lands — same merge gate.
7. **Changelog**: the plan put the fragment with Slice 6; the executor instruction
   asked for one now, so `changelog.d/agent-workflows.added.md` exists (groundwork
   wording). Slice 6 should REWRITE that file, not add a second one.

**Tests (all new code; red shown by mutation, §9)**

- `core/test/workflow-ledger.test.ts` (12): round trip of the three types through the
  strip schemas; an unknown field stripped; a newer state word still loads; all three
  non-critical; huge reason/prompt/report capped and still valid; inputs ≤ 4 KiB with
  the drop row; bad run id / hash / step id throw; load notes: open → one note naming
  the last ended step, second load `[]`; ended → `[]`; a live `workflow_end` note
  closes; another note kind with the same id does not; orphan step/end ignored; start
  order; empty.
- `daemon/test/workflow-load.test.ts` (5): laptop store — open run → note at load,
  twice the same, file bytes unchanged; ended run and a run only in a superseded
  segment → no note; `serve` reload (`rebuild` + `reconcileOnReload`) → the note;
  **older-reader simulation**: the DAEMON emitter's entries with the three types
  renamed to unknown ones → `parseLogFile` skips them, the conversation is intact;
  the emitter writes `critical: false`.
- `protocol/test/workflow-wire.test.ts` (4): `workflows` known + `display`; snapshot
  field present/absent; both methods registered; params accept/refuse.
- `client/test/workflow-mapping.test.ts` (2): a valid `workflows` is a known update
  mapping to no turn event; a malformed one (bad hash, control char in a label) is an
  `error`, never `unsupported`.
- Updated pins: `protocol/test/session-log.test.ts` (critical table),
  `protocol/test/json-schema.test.ts` (fixtures for the 2 methods; union count 11 →
  12 for `WorkflowParams`). `version.test.ts` untouched (number moves at merge).
- Fixture: `daemon/test/support/log-fixture.ts` gains `workflowStart/Step/End`.

```
bun test packages/protocol/test packages/core/test/workflow-ledger.test.ts \
  packages/daemon/test/workflow-load.test.ts packages/daemon/test/serve-subagent-reload.test.ts \
  packages/daemon/test/session-log-store.test.ts packages/client/test/workflow-mapping.test.ts \
  packages/client/test/mapping.test.ts packages/client/test/session-log-reader.test.ts
 635 pass, 0 fail
```

**Mutation check** (each applied to the real source, only the pinning file run, then
restored; all red, none vacuous):

```
red OK  M1  load ignores closing notes              ledger    10 pass 2 fail
red OK  M2  workflow_end does not close a run        ledger    11 pass 1 fail
red OK  M3  step reason not capped                   ledger    11 pass 1 fail
red OK  M4  inputs total not capped                  ledger    11 pass 1 fail
red OK  M5  laptop load drops workflowLoadNotes      load       4 pass 1 fail
red OK  M6  serve reload drops workflowLoadNotes     load       4 pass 1 fail
red OK  M7  daemon emitter writes critical: true     load       3 pass 2 fail
red OK  M8  critical table: start critical           s-log+led 37 pass 2 fail
red OK  M9  state word is an enum                    ledger    11 pass 1 fail
red OK  M10 workflows update `mandatory`             wire       3 pass 1 fail
red OK  M11 row label not line()-bounded             mapping    1 pass 1 fail
```

**Gate (executor's part):** `bunx biome check` on the 19 changed files — clean.
`bunx tsc --noEmit -p packages/daemon` and `-p packages/client` — clean;
`-p packages/core` — clean; `-p packages/protocol` reports only `packages/tui/*`
errors that its own tsconfig pulls in (they are there without this change, none in a
file I touched). Full `bun run check` is the orchestrator's.

**Left to Slice 4 (obligations this slice creates)**

- The driver must build every entry with the core builders (never a hand-made body),
  write the live end note with `NOTE_KIND.workflowEnd` + `id: runId`, and **re-log
  `workflow_start` after every `base`** (compaction / `context_reset`) for a run still
  running — the entries never travel past a segment start, so without it a crash after
  a compaction leaves the run un-noted (same rule as the sub-agent `segmentFacts`).
- Wire `session/workflow` / `workflow/list` in `daemon/src/connection.ts`, the
  `workflows` update + snapshot field in `HostedSession`, and the client listeners.

## Review

*— claude-opus-5-5, 2026-11-22*

### 3. Pro, contro, rischi

**Pro.**
- Ripetibile: lo stesso workflow gira uguale stanotte e domani.
- Il modello giusto per ogni step (DeepSeek esegue, Opus rivede): già oggi facciamo così, a mano.
- Dove gira ogni step è esplicito: build in docker, review in locale.
- Visibile e controllabile da TUI e iPhone; sostituisce 963 script fragili.

**Contro.**
- Un altro formato da mantenere e versionare (come un on-disk record: `schemaVersion`).
- Il modello che scrive YAML sbaglia: serve una validazione rigida, con errori chiari.
- Per compiti piccoli è più lento che chiedere all'agente.

**Sicurezza (§7) — le regole non negoziabili.**
- **Un workflow scritto dal modello non si concede mai permessi.** Un campo tipo
  `allow: [shell]` nel file **non vale niente** finché l'utente non l'approva sul laptop,
  tramite il broker unico. L'approvazione è legata all'**hash del file**: se il modello lo
  modifica, si richiede di nuovo.
- **Step non presidiati vs domande di permesso.** Uno step che chiede un permesso in un run
  notturno **si ferma e aspetta** (stato `in attesa`, notifica sul telefono). Mai auto-approvare
  di notte. Solo prefissi di comando approvati in anticipo dall'utente (come le grant
  `workload_shell`, `packages/agent/src/session-grants.ts:15`) passano da soli.
- **Un pod non è fidato.** L'output di uno step in pod è *dato*, non istruzione: non può
  cambiare il workflow, né il ramo successivo se non tramite un verdetto tipizzato e validato
  sul laptop. La chiave del modello non va mai nel pod (step in pod = `ProxyModelProvider`).

**Costo token e loop infiniti.** Ogni step ha un tetto (esiste già il budget per sub-agente,
`docs/feat/subagent-token-budget.md`). Il workflow ha un tetto totale e un numero massimo di
retry (default 2) e di round di review (come i nostri 3). Niente cicli liberi: solo `retry` e
`on_fail: goto <step>` con contatore. Superato il tetto → stop, stato `fermato: budget`.

**Determinismo e debug.** Il *flusso* è deterministico (codice); il *contenuto* di ogni step no
(LLM). Per il debug: ogni step salva prompt, modello, dove, input, output, token, durata, nel
log della sessione. Si può rilanciare **un solo step** con gli stessi input.

**Fallimenti e retry: come converge.** Ogni step finisce in uno di 4 stati: `ok`, `errore`,
`fermato` (budget/annullato), `in attesa` (permesso). Il workflow va avanti solo su `ok`; su
`errore` segue la regola (`retry N` → `goto` → `stop`). Uno step interrotto (crash, laptop
chiuso) al reload è **chiuso onestamente** e rifatto da capo, come oggi un turno tagliato
(AGENTS §7: "any other turn cut short is closed honestly"). Mai "ripreso a metà" in silenzio.

**Differenza dal "chiedilo all'agente".** L'agente da solo può farlo, ma: dimentica uno step,
dichiara PASS senza prova, non è ripetibile, non è visibile come sequenza. Il workflow sposta
**la sequenza e le regole nel codice**, lascia al modello solo il lavoro dentro lo step.

**Sovrapposizioni.**
- *Già in tentacle:* `agent_task` (step singolo), `schedule_create` (trigger orario), detached
  run (girare senza TUI), skills (istruzioni riusabili — ma non eseguono una sequenza).
- *GitHub Actions:* rubare il formato YAML semplice (`steps`, `needs`, `if`). Non rubare: il
  runner remoto e i segreti nel cloud.
- *Tekton:* rubare "ogni step ha la sua immagine/workspace". Non: CRD e cluster obbligatorio.
- *n8n:* rubare la vista a nodi e il "vedi l'output di ogni nodo". Non: l'editor visuale.
- *Temporal:* rubare la storia degli eventi rigiocabile e i retry con politica. Non: il server.
- *LangGraph:* rubare stato tipizzato tra nodi e i checkpoint. Non: grafi con cicli liberi.

### 4. Ora / dopo / mai

- **Ora:** forma B, ridotta (MVP sotto).
- **Dopo:** step paralleli (`needs`), trigger su push git, workflow lanciato da `schedule_create`,
  libreria di workflow condivisi tra progetti.
- **Mai:** editor visuale drag-and-drop; connettori stile n8n (Slack, Gmail…: ci sono gli MCP);
  un workflow che si auto-approva o si auto-modifica durante il run.

**MVP (prima slice).** Un file `.tentacle/workflows/*.yaml`, solo **sequenziale**. Tipi di step:
`agent` (prompt + modello + dove) e `run` (comando shell, locale o `workload_shell`). Ogni step
`agent` termina con un verdetto tipizzato (`pass` / `fail` + motivo), non con `grep`. Regole
d'errore: `retry: N`, `on_fail: <step>`, `stop`. Tetto token totale. `/workflow run` in TUI,
vista run in TUI e iPhone. Approvazione per hash. Niente trigger, niente parallelismo.

**Esempio reale: il nostro `night-task3.sh` come workflow.**

```yaml
name: task
inputs: [slug, doc]
budget: { tokens: 3M }
steps:
  - id: plan    ; agent: { model: opus,     where: local,  prompt: plan.md }
  - id: exec    ; agent: { model: deepseek, where: local,  prompt: exec.md }; retry: 1
  - id: review  ; agent: { model: opus,     where: local,  prompt: review.md }
                  on_fail: { goto: fix, max: 3 }
  - id: fix     ; agent: { model: deepseek, where: local,  prompt: fix.md }; next: review
  - id: gate    ; run: "bun run check";      where: docker; on_fail: stop
  - id: merge   ; approve: user              # approvazione esplicita, sempre
  - id: ios     ; run: "bun run e2e";        where: local
```

(Sintassi indicativa; la forma esatta va decisa nella Implementation.)

### 4b. Visualizzazione

Principi: **lo stato non si dice mai solo col colore** (owner daltonico). Ogni stato ha un
glifo + una parola: `✓ ok`, `✗ errore`, `▸ in corso`, `○ in attesa`, `‖ fermato`, `? da
approvare`, `↻ 2/3` (retry). Il *dove* è un'etichetta testuale: `[local]` `[docker]` `[pod]`.

**TUI — idea 1: rail nella chat.** Il run è un blocco nella trascrizione, come oggi il blocco
del sub-agente (`packages/tui/src/subagent-view.ts`: testa + ultimi 5 step,
`SUBAGENT_TAIL_ROWS`). Una riga per step; lo step attivo mostra la coda live.

```
workflow task · cron-tool · 4/7 · 1.2M/3M tok
 ✓ plan    opus     [local]   2m  doc scritto
 ✓ exec    deepseek [local]  14m  ↻ 1/1 · 9 file
 ✗ review  opus     [local]   3m  REQUEST-CHANGES (2)
 ▸ fix     deepseek [local]   …   ↳ edit packages/x.ts
 ○ review  ↻ 2/3
 ○ gate    [docker]
 ? merge   attende te          ⏎ apri
```

**TUI — idea 2: pannello a due colonne** (si apre con un tasto, come il pannello sub-agenti).
A sinistra la rail; a destra il dettaglio dello step scelto: prompt, input, output, token, e
il ramo d'eccezione preso.

```
┌ steps ─────────┬ review (round 1) · opus · [local] ───────┐
│ ✓ plan         │ ✗ errore: REQUEST-CHANGES                │
│ ✓ exec         │ 1. task.ts:380 manca abort               │
│›✗ review       │ 2. test vacuo (mutation non fallisce)    │
│ ▸ fix  ↻1/3    │ → on_fail: goto fix (1 di 3)             │
│ ○ gate         │ in 41k · out 3k · 3m12s                  │
│ ? merge        │ [r] rilancia step  [o] output completo   │
└────────────────┴──────────────────────────────────────────┘
```

**iPhone — idea 1: rail verticale** (riusa `stepRail`/`stepNode` di `tools/mockup-kit/kit.js:153,180`,
stati `ok`/`error`/`running`/`pending`, `docs/feat/mobile-mockup-kit.md:337`). Tap su uno step
→ si apre il dettaglio. Lo step da approvare è un bottone grande in fondo.

```
 task · cron-tool        4/7
 │ ✓ plan     opus   local
 │ ✓ exec     ds     local  ↻1
 │ ✗ review   opus   local
 │   └ 2 problemi → fix
 │ ▸ fix      ds     local
 │ ○ gate            docker
 ┃ ? merge — attende te
 [  Approva merge  ] [ Ferma ]
```

**iPhone — idea 2: card riassunto + timeline.** In alto una card: nome, `4/7`, step attivo,
token, una sola azione richiesta. Sotto, la timeline compatta con solo gli step *cambiati*
(errori, retry, approvazioni). Pensata per il controllo veloce dal lock screen / notifica.

```
┌ task · cron-tool ─────────┐
│ ▸ fix (deepseek, local)   │
│ 4 di 7 · 1.2M tok · 23m   │
│ ? merge attende te        │
└───────────────────────────┘
 02:14 ✗ review → fix (1/3)
 02:01 ↻ exec ritentato
 01:47 ✓ plan
```

Consiglio: TUI 1 + pannello 2 al tasto; iPhone 1, con la card del 2 come notifica/hub.
Mockup HTML dopo la scelta (`docs/MOCKUP-BRIEF.md`).

### 5. Domande per l'owner

1. **Dove vive il file?** `.tentacle/workflows/` (gitignored, personale) o `workflows/` nel repo
   (condiviso)? *Consiglio:* nel repo, versionato; approvazione per hash sul laptop.
2. **Chi esegue la sequenza: codice o modello?** *Consiglio:* codice (forma B). Il modello crea
   e modifica il workflow, non decide il prossimo step a runtime.
3. **Primo `where` supportato?** *Consiglio:* `local` + `docker` per gli step `run`; step
   `agent` in pod dopo (dipende da `docs/eval/subagent-in-pod.md`, ancora aperta).
4. **Step con permesso in un run notturno:** aspettare o fallire? *Consiglio:* aspettare, con
   notifica al telefono e timeout configurabile → poi `fermato`.
5. **Il merge può essere automatico?** *Consiglio:* no nell'MVP: `approve: user` obbligatorio
   prima di ogni merge/push. Lo rilassiamo dopo, se i run si dimostrano affidabili.

### Verdetto

**GO — forma B ridotta:** workflow sequenziale da file, esecutore deterministico, approvazione
per hash, vista run TUI + iPhone. Primo banco di prova: sostituire `night-task3.sh`.
Size L complessiva → da spezzare in slice M (formato+validazione · esecutore · vista TUI · vista
iPhone). Blast: load-bearing (broker, persistenza, pod trust): modello forte + Review a contesto
fresco obbligatoria.
