# fix/workflow-model-start-turn — A model-started workflow run asks for every step in auto-accept

> **Status:** review
> **Branch:** `fix/workflow-model-start-turn`
> **Size:** S · **Blast:** cross-module (permission path: auto-accept) · **Suited:** Sonnet executes, Opus fresh-context Review
> **Changelog:** `changelog.d/workflow-model-start-turn.fixed.md`

## Context

*— claude-sonnet-5-5, 2026-11-25*

Owner, 2026-11-25: with auto-accept ON during workflows "mi richiedeva l'approve per ogni comando". Repro (`.tentacle/tmp/wf-automode/`, a real `HostedSession` + `WorkflowDriver`):

```
serve(trusted) rpc-start:   asks shown=2 auto-resolved=2 turnIds=["t-1","t-1"]
serve(trusted) model-start: asks shown=1 auto-resolved=0 turnIds=[null]
serve(trusted) scheduled:   asks shown=2 auto-resolved=2 turnIds=["wake-1","wake-1"]
worker model-start:         asks shown=1 auto-resolved=0 turnIds=[null]
client ownRequest(t-1)=true ownRequest(undefined)=false
```

Only the model's `workflow` tool starts a run with no `turnId` (`packages/tools/src/workflow.ts` `driver.start({…, by:"model"})`). `run.turnId` is then undefined → `host.attribute` sets no `spawnTurns` entry → `awaitBackgroundDecision` calls `autoAnswers(req, undefined)` → `ownRequest(undefined, …)` is false (a request with no turn is never known to be the session's), on the daemon and on the client (`autoAcceptTest`, mobile `permission-sheet.ts`).

## Implementation

*— claude-sonnet-5-5, 2026-11-25*

### Load-bearing assumption

For a model-started run the turn that called the tool is the daemon's `activeTurnId` at the moment `start` runs: the tool executes inside the turn loop that `HostedSession.prompt` opened (`hosted-session.ts` sets `this.activeTurnId = turnId` before the loop). Proven by the new tests: the ask's `turnId` is `t-1`, the id the client minted for the prompt.

### Design

Chosen: the daemon-side seam, not `ToolContext.turnId`. One source of truth (the host's `activeTurnId`, which both the trusted `serve` and the local worker run — every runtime is a `HostedSession`, AGENTS §7), and no plumbing of a turn id through the agent loop, `ToolContext` and every tool/test fake. `WorkflowHost` gains an optional `currentTurn()`; `WorkflowDriver.start` uses `request.turnId ?? (by === "model" ? host.currentTurn?.() : undefined)`, captured AT START, so a run outliving its turn keeps the id. `HostedSession.attachWorkflows` binds it to `activeTurnId` (undefined while compacting). Everything after is existing: `run.turnId` → `attribute` → `spawnTurns` → `autoAnswers`; the client's own-turn test sees the same turn id on the wire.

### Files

`packages/agent/src/workflow-driver.ts` (host interface + `start`), `packages/daemon/src/hosted-session.ts` (bind), test `packages/daemon/test/workflow-model-start-turn.test.ts`, changelog fragment.

### Failure modes

- Turn ends before a step asks / run outlives its turn: the id is fixed at start; asks keep carrying it. On trusted serve every turn is "own", so they are answered; on a worker the client answers only while it still treats that turn as its own (same as RPC-started runs today) — otherwise it asks, never a silent allow.
- `workflow_approve` (hash approval, approve steps): `autoApproves` refuses the kind whatever the turn (`permission.ts`); the ask now carries the turn but stays manual — pinned by a test.
- No turn running (a `start` outside a turn, e.g. direct driver call): `currentTurn()` is undefined → no turn → asks as before (safe default).
- Another device's/foreign turn: the turn is the daemon's active one, i.e. the prompt that called the tool; a client that does not own it does not auto-answer (client rule unchanged). A user `by:"user"` start without turnId is untouched.
- No protocol change: `turnId` on `permission_request` already exists.

### Tests

`workflow-model-start-turn.test.ts` (model's `workflow` tool through a real turn): trusted serve → 2/2 asks auto-resolved with turnId `t-1`; worker → asks carry `t-1`, daemon resolves none; unapproved hash → `workflow_approve` shown with turn and NOT resolved; start with no active turn → ask without turn, not resolved.

## Execution

*— claude-sonnet-5-5, 2026-11-25*

RED on main source (fix stashed): 3 of 4 fail (serve auto-answer, worker turnId, approve ask carrying the turn); the 4th (no turn ⇒ manual) is a guard that holds on both. Green with the fix: 4/4. Mutation: removing `currentTurn` from `attachWorkflows` is exactly the red state above. Gate result: see the final report below.

Gate (2026-11-25): `bun run typecheck` clean, `bun run lint` clean (0 issues), `bun run test` 18324 pass / 5 skip / 0 fail. Not verified: a live TUI/phone frame (client side deduced from the unchanged pure `ownRequest`; the wire now carries the turn id, as for RPC starts). Not committed (awaiting the owner's OK).

## Review

### Review (Round 1)

*— claude-opus-5-5, 2026-11-25 (fresh context; different model family member than the executor, claude-sonnet-5-5 — same vendor family, so shared blind spots are possible)*

**Verdict: APPROVE-WITH-NITS (PASS).** No HIGH, no MEDIUM.

**Gate (re-run by me):** `bun run typecheck` clean · `bun run lint` 2424 files, 0 issues · `bun run test` **18324 pass / 5 skip / 0 fail** (18329 tests, 1270 files) — identical to Execution's numbers.

**Premise table**

| Premise | Where | Verdict |
|---|---|---|
| Model's tool starts with no `turnId` | `packages/tools/src/workflow.ts:67-71` | TRUE |
| `attribute` sets no `spawnTurns` entry for `undefined` | `hosted-session.ts:2551-2555` | TRUE |
| `awaitBackgroundDecision` → `autoAnswers(req, spawnTurns.get(id))` | `hosted-session.ts:1596-1597` | TRUE |
| `ownRequest(undefined, owns)` is false when a session decides | `core/src/permission.ts:330-338` | TRUE |
| `activeTurnId` is set before the loop; the tool runs inside it | `hosted-session.ts:3329`; running tools are awaited on abort (`agent.ts:2516-2518`), so the turn cannot end before `start` returns | TRUE |
| Only the main agent can call `workflow` (no child, no step child) | `agent/src/subagent.ts:441,688` | TRUE (load-bearing for "the active turn IS the caller's") |
| User (RPC) starts always carry a `turnId` | `hosted-session.ts:2621-2630` (`params.turnId` required) | TRUE |
| Context symptom "worker: turnIds=[null]" | see e2e below | TRUE only for asks raised AFTER the turn's stream ends — the client already attributes a turnless ask to the streaming turn (`client/src/permission-router.ts:155`, `update.turnId ?? turnId`). Real steps outlive the turn, so the bug is real; the Context just omits this fallback (nit 2). |

**Red on main / mutation (non-vacuity, in place with byte backups in `.tentacle/tmp/wf-model-start-review/`, restored; `git status` clean after):**
- M1 — drop `currentTurn` from `attachWorkflows`: tests 1-3 **FAIL**, 4 passes (guard).
- M2 — main's driver (`request.turnId` only, no fallback): tests 1-3 **FAIL**. This is exactly main's code path: red on main confirmed.
- M3 — drop the `by === "model"` filter (fallback for any start): **4/4 pass** — unpinned (nit 1), but unreachable today since every RPC start carries a turn.

**End-to-end trace (real SessionHost ↔ Connection ↔ `createLocalRuntime`/RemoteClient, `WORKER_TRUST`, model calls `workflow`, laptop broker applies the TUI's rule `autoApproves(req, ownRequest(turnId, autoAcceptTest(controller)))`, steps ask 80 ms after start so after the turn ends):**
```
== BRANCH
worker hash-approved:   ["shell:own-turn:AUTO","shell:own-turn:AUTO"]
worker hash-unapproved: ["workflow_approve:own-turn:ASKED"]
== MAIN
worker hash-approved:   ["shell:∅:ASKED"]          (denied → run stops)
worker hash-unapproved: ["workflow_approve:own-turn:ASKED"]
```
Trusted `serve` is covered by test 1 (real `HostedSession` turn, `answersAutoAccept`, 2/2 resolved, both `t-1`). Both paths read ONE source of truth: the daemon's `activeTurnId`, captured once at `start` into `run.turnId`, then the existing `attribute`→`spawnTurns`→wire path.

**Attacks tried**
1. *`workflow_approve` / `hooks_trust` auto-answered?* No: `autoApproves` refuses both kinds regardless of turn (`permission.ts:310-318`); test 3 pins `workflow_approve` with a turn + auto-accept ON (and e2e shows it ASKED on the client). `approvals.add` never called in the e2e. Holds.
2. *Foreign device's turn treated as own?* The run gets the turn that ran the tool call — the prompt's own turn (children cannot call `workflow`; running tools are awaited on cancel, so no next/foreign turn can become active mid-`start`). On trusted `serve` every turn is own by design (unchanged); on a client only `ownsTurn`/`autoAcceptsTurn` of that turn answers (device B's run is not auto-answered by A without shared auto-accept); the relay still uses `ownsTurn` only. A model start in a `wake-` turn gets the wake id — same treatment as that wake turn's own tool calls and as scheduled runs. Holds. Pods have no driver (`hosted-session.ts:2606`), so no pod-supplied attribution is added.
3. *Lasting approval?* `autoAnswer` resolves `allow_once` only (`hosted-session.ts:1735-1744`); no rule/hash is stored. Holds.
4. *Run outlives its turn?* `turnId` captured at start; on serve the answer re-reads the live `autoAccept`; on a worker it works while the minted turn is remembered (256-turn bound) and otherwise falls back to asking — never a silent allow. Holds (e2e exercises the post-turn ask).
5. *Single broker (§7)?* No broker created or rewired; the driver still requests through the session's one broker. Holds.
6. *Compaction / no turn?* `currentTurn` is undefined while compacting or idle; test 4 pins "no turn ⇒ manual". Holds.
7. *Protocol / persistence?* `permission_request.turnId` and `workflowStartBody.turnId` already exist (RPC starts use them); no version note needed. Holds.

**Findings**
- (nit 1) `packages/agent/src/workflow-driver.ts:739` — the `by === "model"` restriction is not pinned by any test (M3 survives). Cheap add: a `by:"user"` start without `turnId` during an active turn stays turnless. Not blocking (RPC requires `turnId`).
- (nit 2) Context/Execution: the "worker" symptom is stated as unconditional; on the real client path a turnless ask raised while the turn still streams is already attributed to it (`permission-router.ts:155`), so the bug bites for asks after the turn ends — i.e. any real step. The daemon test asserts the wire `turnId`, which is the right property; the doc's explanation should mention the fallback.
- (nit 3) `workflow-model-start-turn.test.ts:32-35` — `settle()` is a fixed-tick wait used as the sync point for the positive assertions (AGENTS §9 prefers polling with a throwing timeout). It mirrors `workflow-hosted.test.ts:116` and is in-process only, so low flake risk.

**What holds:** the fix is minimal (2 source lines + an optional host hook), single-sourced, additive, and both requested paths auto-answer step asks under auto-accept, verified red→green by mutation and by an e2e on the worker path.

**Executor behaviour:** accurate gate numbers, honest "not verified" line (live TUI frame), correct mutation claim. Execution says the RED run used a stash ("fix stashed") — AGENTS env asks for a WIP commit or a tagged stash; no harm seen (tree clean). Status line still says `review`.
