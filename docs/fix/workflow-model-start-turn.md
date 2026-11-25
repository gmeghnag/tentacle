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

*— (pending: fresh-context Opus review)*
