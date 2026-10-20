# fix/cancel-hung-disk — a hung disk blocks `cancel` of a turn waiting on a permission

> **Status:** execution done · Review **waived by the owner** (token budget, 2026-10-20) — see Review
> **Branch:** `fix/cancel-hung-disk`
> **Type:** fix · **Size:** S · **Blast:** load-bearing (the permission gate + the persistence "pending ⇒ never started" invariant, AGENTS §7) · **Suited:** strong model executes; fresh-context Review mandatory by §10 — waived here by explicit owner decision

## Context

*— claude-opus-5-5, 2026-10-20*

Found by the `feat/suspended-turn-resume` (7b) Review, finding 6; pre-existing
on `main`. On a `serve` daemon (the only runtime with a persister), the gate
(`HostedSession.awaitDecision`) clears the durable `pending` record once an
ask settles and **awaits that write** before returning — the clear-before-run
wait (D-a, P6 of 7b). That wait was unconditional: on a store whose write never
settles (hung NFS, a stuck FUSE mount, a dead disk), a `cancel` aborted the
controller, `settle` resolved the ask as `cancelled`, and then the gate
parked forever on `await this.persisted()`. The agent never got its answer,
so no `turn_end` was ever streamed and the busy slot was never freed: only
`close` (which calls `finishTurn` synchronously) ended the turn. The same
happens after an approval or a denial if the disk hangs during the clear, and —
since 7b — before the ask is even shown (it is streamed only once durable).

Characterization: *trigger* = `cancel` while the gate waits on the disk;
*magnitude* = forever (no timer anywhere on this path); *collateral* = the
session stays busy (new prompts rejected), clients see no `turn_end`.

**Repro** (`.tentacle/tmp/cancel-hung-disk/repro.ts`, run `bun
.tentacle/tmp/cancel-hung-disk/repro.ts`; a store whose `save` never settles
from a chosen point, then `cancel`, then 200 ms):

```ts
import { Agent } from "@tentacle/agent";
import { type ExecutionEnvironment, type ModelProvider, PermissionBroker, type StreamEvent } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "../../../packages/agent/node_modules/zod/lib/index.js";
import { SessionHost } from "../../../packages/daemon/src/session-host.ts";
import { SessionPersister, type RecordStore } from "../../../packages/daemon/src/session-persister.ts";

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
// A disk that answers until `hung`, then never settles a write again.
class Store implements RecordStore {
  hung = false;
  save() { return this.hung ? new Promise<void>(() => {}) : Promise.resolve(); }
  async remove() {}
  async drain() {}
}
async function scenario(name: string, hangAt: "beforeAsk" | "afterShown" | "afterAllow") {
  const store = new Store();
  const runs: string[] = [];
  let calls = 0;
  const model: ModelProvider = { id: "m", async *stream() {
    calls++;
    const s: StreamEvent[] = calls === 1
      ? [{ type: "tool_call", toolCall: { id: "c1", name: "run", arguments: "{}" } }, { type: "done" }]
      : [{ type: "text", delta: "ok" }, { type: "done" }];
    yield* s;
  } };
  const persister = new SessionPersister({ store, cwd: "/tmp/x", model: "m", onError: () => {} });
  const host = new SessionHost({ defaultCwd: "/tmp/x", persister, createAgent: () => {
    const permissions = new PermissionBroker();
    const registry = new ToolRegistry();
    registry.register({ name: "run", description: "run", inputSchema: z.object({}).passthrough(), permission: "ask",
      async execute() { runs.push("run"); return { content: "ok" }; } });
    return { agent: new Agent({ model, tools: registry, env: {} as ExecutionEnvironment, requestPermission: (r) => permissions.request(r) }), permissions };
  } });
  const updates: any[] = [];
  const { hosted } = host.open({ create: true }, { send: (u) => updates.push(u.update) });
  await hosted.persisted();
  if (hangAt === "beforeAsk") store.hung = true;
  hosted.prompt("T1", [{ type: "text", text: "go" }]);
  await tick(20);
  const ask = updates.find((u) => u.type === "permission_request");
  if (hangAt === "afterShown") store.hung = true;
  if (hangAt === "afterAllow") { store.hung = true; hosted.resolvePermission(ask.requestId, "allow_once"); await tick(10); }
  hosted.cancel();
  await tick(200);
  const end = updates.find((u) => u.type === "turn_end");
  console.log(`${name}: askShown=${!!ask} turn_end=${end ? end.stopReason : "NONE (stuck)"} runs=${JSON.stringify(runs)} types=${updates.map((u) => u.type).join(",")}`);
}
await scenario("S1 hang before ask, cancel     ", "beforeAsk");
await scenario("S2 ask shown, hang, cancel     ", "afterShown");
await scenario("S3 ask shown, hang, allow, cancel", "afterAllow");
process.exit(0);
```

Output on `main` (`e9bbf06`), 2026-10-20:

```
S1 hang before ask, cancel     : askShown=false turn_end=NONE (stuck) runs=[] types=turn_start,tool_call
S2 ask shown, hang, cancel     : askShown=true turn_end=NONE (stuck) runs=[] types=turn_start,tool_call,permission_request,permission_resolved
S3 ask shown, hang, allow, cancel: askShown=true turn_end=NONE (stuck) runs=[] types=turn_start,tool_call,permission_request,permission_resolved
```

Output on the fix branch:

```
S1 hang before ask, cancel     : askShown=false turn_end=cancelled runs=[] types=turn_start,tool_call,tool_call_update,turn_end
S2 ask shown, hang, cancel     : askShown=true turn_end=cancelled runs=[] types=turn_start,tool_call,permission_request,permission_resolved,tool_call_update,turn_end
S3 ask shown, hang, allow, cancel: askShown=true turn_end=cancelled runs=[] types=turn_start,tool_call,permission_request,permission_resolved,tool_call_update,turn_end
```

## Implementation

*— claude-opus-5-5, 2026-10-20*

### Load-bearing assumption

**An aborted turn never runs the tool, whatever the gate answers.** Proven:
`packages/agent/src/agent.ts:575-583` — `runTool` awaits
`gate.authorize`, then checks `ctx.signal.aborted` *before* `allowed` and
returns the "Cancelled" note. So the clear-before-run wait may be cut short by
the abort without breaking "pending on disk ⇒ never started": nothing starts.
Mutation-confirmed (M4 below): drop that check → H3 runs the tool.

### Preconditions

- The gate's `signal` is the turn's controller signal, captured at ask time
  (`hosted-session.ts:305`); `cancel`/`close`/model-proxy detach all abort
  that controller (`cancel()`, `close()`).
- `persisted()` → `SessionPersister.flush` (`session-persister.ts:103`)
  never rejects (writes are `.catch`-reported).
- Nothing else on the cancel path awaits the disk: the turn's end goes through
  `persist()` → `schedule` (synchronous, never awaited); the only other
  awaits on `persisted()` are the pre-show emit (`void`, not on the gate's
  path) and `enqueue`'s ack (a different request).

### Design

One change, one code path for every outcome (keeps 7b's "every outcome waits"
choice): the gate's clear-before-run wait becomes
`await untilAborted(this.persisted(), signal)` — it ends at the first of the
write settling or the turn aborting (at once if already aborted, which is the
`cancelled`-outcome case). `untilAborted` is a small exported helper next to
the class; it never rejects and removes its abort listener when it settles.
The answer returned is unchanged (`outcomeToResponse(outcome)`): the agent's
abort-first check turns it into "Cancelled". Deliberately **not** done: a
bounded (timer) wait — showing an ask, or running a tool, before its record is
durable would break D4 / D-a; and a cancel-overrides-the-answer mapping in the
daemon — redundant with the agent check and it would change when an
`allow_always` records its session rule.

### Files

1. `packages/daemon/src/hosted-session.ts` — `untilAborted`; the gate's wait.
2. `packages/daemon/test/persistence.test.ts` — H1–H4 + `untilAborted` unit tests.
3. Docs: this file, `TODO.md`, the 7b doc's failure-mode row.

### Failure modes

| Case | Outcome / convergence |
|---|---|
| Disk hangs before the ask is shown, cancel (H1) | Ask never shown, nothing resolved, `turn_end{cancelled}`, tool not run. |
| Ask shown, disk hangs, cancel (H2) | `permission_resolved{cancelled}`, `turn_end{cancelled}`. |
| Approved, the clear never lands, cancel (H3) | `turn_end{cancelled}`, tool **never** runs (even once the disk returns), one `turn_end`, history says "Cancelled". |
| Denied, the clear never lands, cancel (H4) | `turn_end{cancelled}`. |
| Approved on a slow but working disk, no cancel | Unchanged: the tool waits for the clear (A6, B4 still pin it). |
| Crash while the disk is hung, after the cancel | The cancel never became durable: the record still says suspended → the reload re-asks (nothing ran). Same as any not-yet-durable state; honest. |
| Disk returns after the cancel | The queued writes land latest-wins (clear, then turn end); nothing re-runs (H3). |
| Abort listeners | Removed when the wait settles, either way (unit test; mutation M5). |
| Hung disk, no cancel | Unchanged by design: the ask is not shown until durable (D4) — the user's way out is now `cancel`, not only `close`. |

### Tests

Red first, each run on the buggy code: H1–H4 all timed out on `turn_end`
(H3/H4 also proved the gate was parked: no `turn_end` before the cancel).

## Execution

*— claude-opus-5-5, 2026-10-20*

1. Repro on `main` (above): all three scenarios stuck.
2. Branch `fix/cancel-hung-disk`; H1–H4 added → **4 fail** (timeouts) on the
   unfixed code.
3. Fix applied (`hosted-session.ts` `untilAborted` + the gate's wait) → 37/37.
   Drift: a first version also mapped "aborted" to a `cancelled` answer in the
   daemon; removed as redundant (agent check) and behaviour-changing for
   `allow_always`.
4. `untilAborted` unit tests (listener removed on both paths; a rejected write
   never throws).
5. Mutations (each reverted): **M1** original `await this.persisted()` →
   H1–H4 red · **M2** no abort listener in `untilAborted` → H3, H4 red ·
   **M3** no clear wait at all → H3, H4, A6, B4 red · **M4** drop the
   post-`authorize` abort check in `agent.ts` → H3 (+B5) red · **M5** no
   `removeEventListener` → both unit tests red.
6. Gate: `bun run check` → tsc clean, Biome clean (one formatting fix in the
   test via `biome check --write`), **1208 pass, 2 skip (opt-in), 0 fail**.

## Review

*— claude-opus-5-5, 2026-10-20*

**Fresh-context Review waived by the owner** (explicit instruction: short on
tokens; AGENTS §10 makes it mandatory for a load-bearing change — this is a
recorded exception, not a pass). In-context self-check only: the gate re-run is
green; non-vacuity is shown by M1–M5; the invariant at stake ("pending on disk
⇒ never started") rests on the agent's abort-first check, pinned by H3 under
M4. Not covered, and why acceptable: a re-asked request on a permanently hung
disk is still never shown (by design, D4) — `cancel` now ends it; an
`enqueue` ack still waits on the disk (a separate request, not a trapped
turn). Suggested if budget allows later: a fresh-context Review of this diff.
