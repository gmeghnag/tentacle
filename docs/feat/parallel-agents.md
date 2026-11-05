# feat/parallel-agents — Run a round's `agent_task` calls concurrently

> **Status:** execution done (S1–S5, on `main` @ `b8b714b`); fresh-context Review pending
> **Branch:** `feat/parallel-agents`
> **Size:** L · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review that red-teams the §7 *Persistence* invariant ("pending on disk ⇒ never started"), the single-broker path, the replay cut, and "a pod is not trusted"

Type: feat · Size: L · Blast: load-bearing · Suited: strong model + fresh-context Review

## Context

*— claude-opus-5-5, 2026-11-05*

Task 7, the last of [`docs/eval/parallel-execution-plan.md`](../eval/parallel-execution-plan.md)
(split table `:576`, Part 2 `:429-552`). Tasks 1–6 are merged.

**Rebase (2026-11-05).** *— claude-opus-5-5, 2026-11-05.* This plan now stands on
`main` @ `3a149c7` **plus `feat/config-carry` as committed at `1b93bfe`** (its fix round 2
assumed landed: the drift/override notices in a one-line JSON format, and the inline
`agentTaskDescription` check skipped under `podDaemon`). **Every `file:line` below is at
`1b93bfe`.** That is exact for `main` too: since the merge base `1e99987`, `main` changed
only `packages/cli/src/main.ts`, which this plan no longer touches. Config-carry's owner
answer Q4 = B added the `subagents.*` keys and carries them in `session/open.settings`
(protocol v16), so **the former slice S6 (argv flags), Design 10's config work and
Design 11 are gone**; this task only reads the merged config (config-carry doc, "How task 7
consumes this"). Since the first pass (`50791f1`), `main` also gained `model/countTokens`
(`docs/feat/tui-target-badge.md`), the exact precedent for this plan's `model/slots`.

**The eval sized this M; the count is about 26 source files in 10 packages, so
it is L.** That is not XL: the slices below stay one legible branch, and none of
them is useful to users before S5.

**Today a round runs `agent_task` calls one at a time.** The tool has no
`concurrency` (`packages/tools/src/task.ts:50-76`), so it is `exclusive`
(`packages/agent/src/round-plan.ts:27-29`) and always a group of one
(`round-plan.ts:88-95`, pinned by `tools/test/concurrency.test.ts:49`). Sub-agents
are the one workload where a call lasts minutes, so this is where concurrency pays.

### Owner decisions (2026-11-05)

1. **`subagents.execution` default = `parallel`**; `read-only` and `sequential` stay selectable.
2. **The `agent_task` description is neutral and customisable:**
   `subagents.agentTaskDescription` (inline) or `subagents.agentTaskDescriptionFile`
   (relative to the config dir, or absolute: the `systemPromptFile` convention). Both set =
   a clear config error. Neither = the neutral default text.
3. **On `run`/`attach`, `subagents.execution`, `subagents.maxParallel` and
   `agentTaskDescription*` come from the LAPTOP**: the active profile's value if the
   profile sets it, else the global config, carried into the pod like `--context-window`.
   The pod's config does not decide them. The llama.cpp slot cap stays laptop-side. A wider
   config layering (container > repo > global) is a separate future eval, not designed here.
4. **Sub-agents' own rounds inherit `tools.execution` / `tools.maxParallel`.**

*Rebase note:* decisions 2 and 3 are now implemented by `feat/config-carry` (its owner
answer Q4 = B): the keys, their validation and their carriage (as the P class of
`session/open.settings`, which replaced `--context-window`). This task implements the
rest of 2 (the neutral text and its use) and reads the carried values.

### Earlier owner decisions

**This task also implements:**
- **PE-Q3:** shared workspace for writer sub-agents (`PathLocks` + prompt guidance).
- **PE-Q4:** one "Yes, always" covers the session tree; requests it does not cover
  are still asked one by one.
- **PE-Q6:** `subagents.maxParallel` default 4, automatically capped at a llama.cpp
  endpoint's slots (`/props`); the config value stays the ceiling.
- **PE-Q2:** R2 (`inFlight`, exact reload labels), already on disk since task 5.
- **Task 6 decision 7:** sub-agents' own rounds stay sequential "until task 7".
- **Task 4, 2026-10-26:** the sub-agent label in the dialog is this task's, as
  bounded, sanitised text (`permission-call-attribution.md:565`, `:640`).

**Commitments earlier tasks left to this one (all answered in the Design):**
- Task 4 known limit: "a sibling's commit would move the cut past a still-pending
  ask" (`permission-call-attribution.md:329-333`). See the load-bearing assumption.
- Task 4: the grant race (`permission-call-attribution.md:66-68`). See Design 3.
- Task 6 Review finding 1: no test pins what a child gets as `toolExecution`
  (`parallel-tools.md:707-710`). See T-C1.
- Config-carry Review LOW 1 (the pod's inline description killing a pod daemon's load)
  was suggested for this task; config-carry's round 2 fixes it, so nothing is left here.

**Where this plan departs from the eval, and why:**
- **`agent_task` gets no resource keys** (eval §2.1: `read:workspace`, `write:agents`).
  A key cannot express what the eval wants: under `tools.execution: read-only`,
  a read-class `agent_task` would group with `fs_read`, under the tools' cap and
  mode, so the two settings would not be independent. A separate lane does it
  (Design 1). The cost is that an `explore` and an `fs_read` in one round do not overlap.
- **No "the dialog jumps to that agent's tree"** (eval §2.2). The label says which
  agent asks. The laptop requester gets no call id (`remote-client.ts:2163-2166`), so
  jumping needs more wire for little gain. Left out, listed in the debt.
- **The 429 task is done** (`feat/model-retry-429`): only one small fan-out gap
  remains (Design 8).

**Repro** (for a feat: the capability is missing). Run on `main` @ `b8b714b` before any edit,
2026-11-06, through `bun test <file>` (a plain `bun <script>` needs an approval this session
did not have; the code runs at the file's top level, so the runner reports 0 tests). It became T-E1.

```ts
// Two agent_task calls in one message; each child's model waits on a 200 ms timer.
const root = "<worktree>/packages";
const { Agent, createSubagentRunner } = await import(`${root}/agent/src/index.ts`);
const { ToolRegistry, createTaskTool } = await import(`${root}/tools/src/index.ts`);
const call = (id, description) => ({
  type: "tool_call",
  toolCall: { id, name: "agent_task", arguments: JSON.stringify({ description, prompt: "go", subagent_type: "explore" }) },
});
let turn = 0;
const model = {
  id: "scripted",
  async *stream(request) {
    if (request.messages[0]?.content.includes("read-only investigator")) {
      await new Promise((r) => setTimeout(r, 200));
      yield { type: "text", delta: "report" };
      yield { type: "done" };
      return;
    }
    if (turn++ === 0) { yield call("c1", "one"); yield call("c2", "two"); }
    else { yield { type: "text", delta: "done" }; }
    yield { type: "done" };
  },
};
const env = { id: "noop", exec() { throw new Error("unused"); }, readFile() { throw new Error("unused"); }, writeFile() { throw new Error("unused"); } };
const tools = new ToolRegistry();
const { run, types } = createSubagentRunner({ model, env, tools });
tools.register(createTaskTool((o, c) => run(o, c), types));
const agent = new Agent({ model, tools, env, systemPrompt: "parent" });
const t0 = performance.now();
for await (const e of agent.runMessages([{ role: "user", content: "go" }], "s", new AbortController().signal)) {
  if (e.type === "subagent_start" || e.type === "subagent_end") {
    console.log(`${e.type} ${e.id} @${Math.round(performance.now() - t0)}ms`);
  }
}
console.log(`total ${Math.round(performance.now() - t0)}ms`);
```

Observed, one at a time:

```
subagent_start c1 @3ms
subagent_end c1 @206ms
subagent_start c2 @207ms
subagent_end c2 @409ms
total 410ms
```

## Implementation

*— claude-opus-5-5, 2026-11-05* (rebased on config-carry `1b93bfe`: *— claude-opus-5-5, 2026-11-05*)

### Load-bearing assumption

Task 6 stood on "no call that can ask while it runs ever shares a group"
(`parallel-tools.md:102-107`; the comment at `agent.ts:1263-1266`). **This task
deliberately breaks that.** The replacement:

> **A sub-agent's ask raised while its `agent_task` runs in phase 2 cannot break
> what the disk and the replay stand on, because (a) a sub-agent's ask is never
> resumable and the group's `inFlight` is durable before any child starts, so a
> reload never re-runs the group; and (b) the parent's stream commits only after
> every child of the group has settled, so the cut cannot pass a live ask.**

Proof on `1b93bfe` (re-checked on the rebase: `subagent.ts`, `round-plan.ts`,
`permission-gate.ts` and `persisted-session.ts` are unchanged since the first pass;
`agent.ts` and `hosted-session.ts` only moved). **Holds**, by reading; T-D1…D4 prove it by execution.
- **(a)** A child's requester always sets `origin: "subagent"`
  (`subagent.ts:107-112`). `classifyPending` requires `origin === "call"`
  (`daemon/src/persisted-session.ts:422-426`), so the entry has `resumable: false`.
  `resumableTurn` refuses any record with `inFlight` (`:599`) and any non-resumable
  entry (`:604-609`). `beforeRun` is awaited before any start (`agent.ts:1336-1339`).
- **(a) when the write fails.** `landed === false` runs 2b, one child at a time
  (`agent.ts:1351-1376`). An ask there is still `resumable: false`: the turn is closed,
  never resumed. The label is the sub-agent note (`persisted-session.ts:671-675`).
- **(b)** Phase 2a's loop leaves only at `running === 0` (`agent.ts:1418-1420`), and
  the group's one commit follows (`:1444`). A child's own `history_commit` never
  reaches the parent: `run` forwards only text, `tool_start`, `usage`, `turn_end`
  (`subagent.ts:239-253`). The cut moves on the parent's stream only
  (`daemon/src/hosted-session.ts:1409-1421`), so a live ask stays past it and every
  replay re-offers it (`hosted-session.ts:20-24`). **So task 4's known limit never
  occurs**: there are no sibling commits inside a group, and no replay of `asks` is needed.
- **(b) on 2b.** A commit follows each child (`agent.ts:1368-1372`), and the next
  child starts after it: no ask is live at a commit.
- **Other cut moves.** A compaction refuses a running turn's asks (`compacting`,
  `hosted-session.ts:518`). `context_reset` is alone in its round
  (`agent.ts:1179-1190`) and is taken away from children (`subagent.ts:191`).

### Preconditions

- **P1. Several live asks are already handled.** `asks` is a map by `requestId`
  (`hosted-session.ts:343`), the turn's abort settles each (`:559`), first answer wins
  (`:693-713`), and `recheckAsks` walks all (`:645-653`). A settle clears `carried`
  (`:607`), which is only set on a resumed round's phase 1.
- **P2. The record already holds several entries.** `pendingList` (`:732-735`), v8 list
  (`persisted-session.ts:216-224`), labels per call (`:666-676`). No record change.
- **P3. One agent per session.** `SessionHost.build` calls `createAgent` for each
  hosted session (`daemon/src/session-host.ts:830`); a `session/context` probe builds a
  throwaway one (`:263`). `buildAgent` makes the main `Agent` and the sub-agent runner
  together (`cli/src/wiring.ts:380-394`, `:420-438`). So a store made in `buildAgent` is
  exactly one session tree.
- **P4. Grants today.** Each `Agent` has its own gate (`agent.ts:483`). The gate
  checks its rules, awaits the requester, then writes (`permission-gate.ts:162-175`).
  Grants are in memory, never persisted. Laptop routers keep no grants
  (`client/src/permission-router.ts:14`).
- **P5. Workspace locks are shared.** `ctx.pathLocks ?? pathLocksFor(ctx.env)`
  (`tools/src/builtins.ts:35`), one per env (`core/src/path-locks.ts:84-90`), and the
  children share the parent's env (`subagent.ts:208`). Shell has no shared cwd
  (eval §2.1); children get no `jobs` (`subagent.ts:205-229`).
- **P6. Progress is keyed per call.** `emitProgress` of a group's call goes through the
  group's queue with its own id (`agent.ts:1315-1320`, `:1425-1427`). The TUI reducer
  updates by id (`tui/src/state.ts:365-404`), so trees cannot mix
  (`subagent-progress-wire.md:254`). Text is sanitized client-side
  (`client/src/mapping.ts:90-95`).
- **P7. Children cannot reach `beforeRun`.** `child.run` passes no options
  (`subagent.ts:234-238`), so `landed` stays `true` (`agent.ts:1333-1340`). A child's
  `tool_phase` is dropped by construction (`subagent.ts:239-253`).
- **P8. The tunnel is concurrent, and has a lazy-probe precedent.** `model/streamChunked`
  requests have independent handlers and the peer dispatches concurrently (eval §2.3,
  AGENTS §7). `model/countTokens` is a daemon → client method with no pod input beyond the
  request: `ModelLink` = `Pick<…> & Partial<Pick<Connection, "requestModelCountTokens">>`
  (`daemon/src/connection.ts:92-93`), `Connection.requestModelCountTokens` (`:190-196`),
  `ProxyModelProvider`'s optional third sender and `MethodNotFound → undefined`
  (`daemon/src/proxy-model.ts:48-55`, `:168-193`), the tunnel built in `tunnelledAgent`
  (`cli/src/serve.ts:390-403`), the laptop's dispatch (`client/src/remote-client.ts:1105-1121`),
  handler (`:1915-1919`) and provider `servingModel` (`:2005-2019`), the methods table
  (`protocol/src/methods.ts:71-74`, `:124-126`), schemas (`protocol/src/model.ts:116-123`),
  and `RetryingModelProvider` forwarding without retry (`providers/src/retry.ts:177-180`).
  `model/slots` copies it.
- **P9. Retry today.** 429/529/500/502/503 retried pre-stream, 3 attempts, at most
  30 s of `retry-after` (`providers/src/retry.ts:112-123`, `:202-211`). Jitter applies
  only without `retry-after`: `max(backoff, retryAfter)` (`:220-228`).
- **P10. The dialog.** `permission-ui.ts:283` gets `options` and reads no `agent`;
  `PermissionPrompt` draws title, details, cwd, options (`components/PermissionPrompt.tsx:39-104`);
  its height is `permissionPromptRows` (`:20-29`, called `App.tsx:803-808`). The router
  passes `agent` unsanitized (`client/src/permission-router.ts:254-261`).
- **P11. The `subagents.*` values exist, resolved and carried (config-carry).**
  `TentacleConfig.subagentsEnabled`, `subagentMaxIterations`, `subagentExecution`
  (`ToolExecutionMode`), `subagentMaxParallel`, `agentTaskDescription?`
  (`config/src/resolve.ts:86-94`), resolved by `pick` with env
  `TENTACLE_SUBAGENT_EXECUTION` / `TENTACLE_SUBAGENT_MAX_PARALLEL` (`:373-382`), defaults
  `parallel` / 4 (`config/src/defaults.ts:20`, `:22`). The description: one layer with both
  keys is a schema error (`config/src/schema.ts:240-248`), the profile drops the base's
  other key (`config/src/profile.ts:82-95`), the text is read once, trimmed and capped at
  4096 bytes at load (`config/src/load.ts:430-455`, `:534-538`); a pod daemon never reads
  the file (`:538`) and, after round 2, never checks the inline text. In a pod, all five
  are P keys: the laptop's value replaces the pod's file and env
  (`cli/src/carried-settings.ts:54-90`, `applyCarried` `:218`), and a carried session with
  no description gets none, never the pod's (`:89`). `tools.execution` /
  `tools.maxParallel` are W: the laptop's value unless the pod's own file or env sets one
  (`:175-188`). `tunnelledAgent` builds from the merged config (`serve.ts:382`, `:404`);
  `podSessionHost` passes `settings` (`:457-465`); `session/context` passes them to its
  probe (`session-host.ts:257-265`). **Readers today:** `subagentsEnabled`
  (`wiring.ts:375`) and `subagentMaxIterations` (`:388`) only; the other three have none
  ("not read yet": `schema.ts:225-233`, the template `defaults.ts:131-132`, `README.md:283-285`,
  `CHANGELOG.md:45-49`).
- **P12. Versions.** `PROTOCOL_VERSION` is 16 after config-carry (`protocol/src/version.ts:7`)
  and stays 16: the carried keys are already in v16's `SessionSettingsSchema`, a new
  method is free (§7), `MethodNotFound` is handled, and `agent?` is already on the wire.
  (Config-carry's failure-mode row "Task 7 bumps for this reason" predates its Q4 = B;
  its "How task 7 consumes this" says no bump, and that holds.) The record stays v8.

**Not verified (the web search was refused and no endpoint was probed at planning time):** the shape of llama.cpp's
`/props`. The eval states `total_slots` without measuring it (`:507`). **First step of
S4:** `curl <base>/props` against the owner's real endpoint, and time N=1 vs N=3
concurrent requests (`:507-509`), paste both here. If the field differs, fix the parser
and carry on; the design does not depend on the name. Rejecting `/slots` also rests on
memory (it can be disabled and returns per-slot detail): one integer is all this needs,
and PE-Q6 names `/props`.

### Design

**1. A separate lane for spawns (`core`, `tools`, `agent/round-plan.ts`).**

`agent_task` keeps no `concurrency` (still `exclusive`, the T-K pin stays). New optional,
total field:
```ts
type SpawnKind = "read-only" | "writer";
interface Tool { readonly spawnKind?: (input: unknown) => SpawnKind } // absent = not a spawn
```
- `createTaskTool(run, types, options?: { readOnlyType?(name): boolean; … })` resolves
  the type as `execute` does (`task.ts:57-58`). Bad input or a throw → not groupable.
- **Read-only type** (pure, `subagent.ts`, returned by `createSubagentRunner`, consulted
  live because MCP tools register late, `cli/src/worker.ts:119-122`): `type.tools !== "all"`
  and every listed tool the registry has is read-class under
  `classOf(tool, { path: "_" })`. The probe gives `fs_read` its read key, a read-only MCP
  tool ignores it, `shell` is `exclusive`, a write tool is a write key. `explore` is
  read-only; `general-purpose` is not.
- **`subagents.execution`** (owner decision 1, default `parallel`): `sequential` |
  `read-only` | `parallel`, the same words as `tools.execution`.
- **Pure `planRound(classes, kinds, tools: {mode, maxParallel}, agents: {mode, cap})`** →
  `{ indexes, lane: "tools" | "agents" }[]`, contiguous, in call order, covering every
  call once: maximal runs of consecutive admissible spawns (`parallel`: any;
  `read-only`: read-only kind; `sequential` or `cap <= 1`: none) are an `agents` group;
  everything else is exactly `planGroups` (unchanged, `round-plan.ts:75-98`). So
  `[a, a, read, a]` → `[a,a] [read] [a]`.
- **Pure `spawnDependencies(kinds, mode)`** on the EFFECTIVE input after phase 1 (a hook
  may rewrite `subagent_type`): no dependency among admissible spawns; a kind no longer
  admissible, or undefined, waits for every earlier call and every later one waits for it.
  Same rule as `dependencies` (`round-plan.ts:116-128`). `nextRunnable` is reused as is.

**2. The executor (`agent.ts`), the smallest change.** `AgentConfig` gains
`subagentExecution?: { mode, maxParallel, slots?(signal): Promise<number | undefined> }`;
absent = sequential. `runToolCalls` uses `planRound` (`:1169`) and `runGroup` takes the
lane: the cap (`agents.cap` or `tools.maxParallel`) and the dependency function. Phases 1,
BETWEEN, 2a, 2b are unchanged: `beforeResumedCall`, `beforeRun`, `queued`, `running`, one
commit, call-order push. The cap is awaited only when the round has an admissible run of
at least two spawns, **before** planning, abort-aware and bounded (Design 6), so every other
round has no extra await. The comment at `:1263-1266` is rewritten to the new assumption.

**3. One grant store and one ask at a time for the tree (`agent`).** New pure class
`SessionGrants` (`agent/src/session-grants.ts`): the rules moved out of the gate
(`permission-gate.ts:105-108`, `:192-209`), plus an ask lane:
```ts
covers(tool, input); remember(tool, request);
serial<T>(signal, fn: () => Promise<T>): Promise<T | typeof ABORTED>; // FIFO, abort-aware, released in finally
```
`PermissionGate(requester, hooks, grants = new SessionGrants())`. `authorize` becomes:
```
force !== "ask" && grants.covers → run                     // as today, no lane
serial(signal, async () => {
  if (force !== "ask" && grants.covers) return COVERED      // re-check inside: the race
  response = await requester(...); if always → remember; return response
})
ABORTED → { allowed: false, input, by: "user" }             // as the gate's cancel, :146-148
```
- **Why a lane at the gate.** Without it, five children asking `bun test` raise five
  requests before anyone answers, and "Yes, always" on the first leaves four dialogs. This
  is exactly PE-Q4's "requests not covered are still asked one by one". A waiting child has
  no record entry and has shown nothing. It costs nothing visible: the laptop already shows
  one dialog at a time (`permission-router.ts:8`).
- **Not the serialization §7 forbids.** It sits in the agent, before the requester; no
  `Connection` handler waits on it. `session/resolve_permission` is untouched. There is
  still ONE broker: the lane calls the same requester.
- **Wiring:** one `new SessionGrants()` per `buildAgent` (P3), to the main `Agent`
  (`AgentConfig.grants?`) and through `SubagentDeps.grants` to each child. An `Agent` built
  without it keeps a private store, so tests are unchanged. A `session/context` probe's
  agent (P3) gets its own, never used.
- **Sequential behaviour changes on purpose:** "always" in a child now covers the parent
  and later children (the reason task 4 left it out, `permission-call-attribution.md:61-65`).
- **Pods:** the store lives in the pod's daemon, which §7 already treats as UX, not security
  (`permission-call-attribution.md:338-340`). The laptop keeps no grant (P4). No lasting
  laptop approval is created.

**4. The label in the dialog (`client`, `tui`).** A pod can forge `agent`, so it is
sanitized at the laptop's boundary: the router (`permission-router.ts:254-261`) applies the
same strip-and-cap as `progressText`, exported from `client/src/mapping.ts:90`. Pure
`permissionAgentLine(agent, columns)` in `tui/src/permission-ui.ts` →
`explore · "find callers"`, truncated to the width. The controller keeps the pending
agent with the pending request (`:283`). `PermissionPrompt` draws one dim row under the
title; `permissionPromptRows` gains the row and `App.tsx:803-808` passes it, so the viewport
stays exact. Nothing decides on it. A call's own ask has no row.

**5. Children (`subagent.ts`).**
- **Rounds inherit `tools.execution` and `tools.maxParallel`** (owner decision 4; safe by
  P7: asks stay in the child's phase 1, `groupStart` is stripped at `subagent.ts:106`,
  a child's `beforeRun` is absent, the parent's `inFlight` already covers it). Worst
  case is `4 × 8` `fs_read`s or hinted MCP reads at once. `SubagentDeps.toolExecution`,
  passed in `wiring.ts:380` from `config.toolExecution`; the comment at `:436` goes. *Rebased:*
  on a pod that value is now the merged one, so it is the laptop's unless the pod's own file
  or env sets `tools.*` (W class, P11), in which case the pod's wins for parent and children
  alike and config-carry's override notice names the key. Nothing to add here.
- **Spill paths no longer collide.** The path is `<tool>-<call id>`
  (`agent.ts:1774`), the id comes from the server (`openai-provider.ts:98-99`, `:114`),
  and a server may reuse ids (`tools/src/skill.ts:77-78`). Two children with one id
  would silently read each other's output. `AgentConfig.spillScope?: string`; the path
  becomes `<scope>-<tool>-<id>` when set; a child's is a fresh short id. Main agent unchanged.
  **Overlap:** the open `fix/tool-output-location` (`TODO.md:428`, owner 2026-11-05) moves this
  path to `…/<session>/<tool>-<id>.txt`. If it merges first and a child's `<session>` is its
  own `run` id (`subagent.ts:235`), drop `spillScope` and keep T-C2. If this lands first, that
  fix replaces the scope.
- **`subagent_end` on failure.** A model error throws out of the `for await`
  (`subagent.ts:234-253`; `agent.ts:852`), so the end event never goes out and the tree
  keeps its `└─ …` row (`tui/src/render-lines.ts:280-282`) beside the error. Wrap it:
  emit `subagent_end { toolUses, stopReason: "error" }` (a free string,
  `core/src/tool.ts:87`), rethrow. `registry.execute` keeps turning it into that call's
  `isError`.

**6. Slot cap: one provider seam, lazy, beside `countTokens` (`protocol` → `core` →
`providers` → `daemon` → `client` → `cli`).** `ModelProvider.slots?(signal): Promise<number | undefined>`,
next to `countTokens?` (`core/src/model.ts:94-101`).
- `OpenAIProvider`: `GET <root>/props`, `root` computed as `countTokens` does
  (`openai-provider.ts:148`), the same bearer (`:144-147`), `redirect: "error"`, 1.5 s
  timeout; a positive integer ≤ 1024 from `total_slots`, else `undefined`. An answer or a 404
  is memoized on the instance; a timeout or a 5xx is not (a server still loading).
  `AnthropicProvider`: no method. `RetryingModelProvider`: forwards, never retries, as its
  `countTokens` (`retry.ts:177-180`).
- `ProxyModelProvider` gets a fourth optional sender, shaped like `ModelCountTokensSender`
  (`proxy-model.ts:48-55`): new daemon → client RPC `model/slots`, no params, reply
  `{ slots: number | null }`. `ModelLink` adds `requestModelSlots` to its `Partial<Pick<…>>`
  (`connection.ts:92-93`); `tunnelledAgent`'s `tunnelFor` passes it like the count sender
  (`serve.ts:396-402`). The laptop's handler (dispatch beside `:1118-1121`) calls
  `servingModel(Method.ModelSlots, undefined).slots`, and answers `null` on any failure (no
  endpoint or error text reaches the pod). The pod validates a positive integer.
  `MethodNotFound`, no sender or no link → `undefined`.
- **Why not a carried setting.** `session/open.settings` now exists, but carrying `slots`
  would probe before every session open (a delay on a dead host even when no fan-out ever
  happens), freeze a value a server restart with another `-np` changes, and still leave the
  in-process worker and `serve` needing the seam. The seam gives every runtime one code path
  (§7), nobody probes unless a fan-out happens, and `model/countTokens` already set the shape.
- **Pod not trusted:** the request carries no pod input, hits one fixed laptop URL, memoized,
  and returns one integer. A hostile pod could lie to itself only.
- **Effective cap** = `min(config.subagentMaxParallel, slots ?? subagentMaxParallel)`. Parent
  parked during a group, so children are the only main-model load. `slots = 1` → every call
  alone, no `beforeRun`, today's path. The first time slots lower the cap, one log line
  (`options.log`, the daemon log, never the terminal, §7; not a settings notice).
  In the TUI, the waiting rows read `· queued`.

**7. The description (`tools/task.ts`, owner decision 2).** `createTaskTool` gets
`description?: string`. Pure `taskToolDescription(custom, mode, typeList)`: the custom text, or
else the neutral default; **the list of types is always appended**, because `subagent_type` is
unusable without it (`:52`). The neutral default is today's text plus, by mode:
- `parallel`: "Several agent_task calls in one message may run at the same time. They share
  one workspace: give each its own files, and do not have two of them commit, or run builds
  or tests that could overlap."
- `read-only`: "Read-only sub-agents in one message may run at the same time."
- `sequential`: nothing added.

It states facts and never asks for fan-out. A custom text is used as is, in every mode. It
arrives already read, trimmed and capped (P11): this task never resolves or reads it again.

**8. 429 under fan-out (`retry.ts`).** N children hit by one limit get one `retry-after` and
wake together. `delayMs` becomes `retryAfter + backoff` when a `retry-after` is present (still
"at least", `:220-228`). No shared limiter across children: its gain is not measured, and a
child out of attempts is a visible `isError` the parent can re-delegate.

**9. Wiring: read the merged config (`cli/wiring.ts`).** *Rebased: replaces the former
Design 9–11.* In `buildAgent`, which in a pod receives the config already merged by
`applyCarried` (`serve.ts:382`, `:404`) and elsewhere the process's own:
- `new Agent({ …, subagentExecution: { mode: config.subagentExecution, maxParallel:
  config.subagentMaxParallel, slots: model.slots ? (s) => model.slots(s) : undefined },
  grants })` at `wiring.ts:420-438`. `model` is `wiring.ts:280`: in a pod the tunnel
  (`options.modelOverride`), so `slots` goes through `model/slots`.
- `createTaskTool(…, types, { description: config.agentTaskDescription, mode:
  config.subagentExecution, readOnlyType })` at `wiring.ts:394`.
- `createSubagentRunner({ …, toolExecution: config.toolExecution, grants })` at
  `wiring.ts:380-393`. `subagentsEnabled` (`:375`) and `subagentMaxIterations` (`:388`) are
  already read there and already carried: unchanged.
- Drop "not read yet" / "Reserved for parallel sub-agents" from `schema.ts:225-233`, the
  template `defaults.ts:131-132` (move the keys into the line at `:130`), `README.md:283-285`,
  and turn `CHANGELOG.md:45-49` into this task's entry (P11; config-carry's step 3).
- **No change** to `serve.ts`'s settings path, `carried-settings.ts`, `resolve.ts`, `load.ts`,
  `profile.ts`, `flags.ts`, `engine-runtime.ts`, `pod-resident.ts` or `main.ts`. Only
  `serve.ts:390-403` changes, for Design 6's sender.

**Carriage, for the record (done by config-carry, not this task).** On `run`/`attach` the
laptop sends `subagentExecution`, `subagentMaxParallel`, `subagentsEnabled`,
`subagentMaxIterations` and, when set, `agentTaskDescription` in `session/open.settings`,
per session; the pod's file and env do not decide them (owner decision 3). `connect` and the
in-process worker send none (`serve` decides by its own config; the worker already has the
laptop's). A live session re-attached with another profile keeps its values, and the drift
notice names the keys.

**TUI and phone.** Nothing to change for several trees (P6): each `agent_task` row has its
own tree, and a queued one reads `◌ … · queued` (`tui/src/tool-phase-view.ts`). A long tree
can be long (`SUB_ACTIVITY_CAP` 50, `state.ts:162`), but rows scroll as they do today. The
phone is a spike that denies every ask (`apps/mobile/src/spike.ts:61`): it gets the same
frames, no work here.

### Files

*Rebased: `flags.ts`, `engine-runtime.ts`, `pod-resident.ts`, `main.ts`, `resolve.ts`,
`load.ts` and `profile.ts` are out; `config` keeps two comment edits.* Dependency order,
about 26 source files.
1. `packages/protocol/src/methods.ts`, `model.ts`, `schema/protocol.json` (regenerated, `bun run schema:export`) — `model/slots`.
2. `packages/core/src/tool.ts`, `model.ts` — `spawnKind`, `slots`.
3. `packages/providers/src/openai-provider.ts`, `retry.ts`.
4. `packages/tools/src/task.ts`.
5. `packages/agent/src/session-grants.ts` (new), `permission-gate.ts`, `round-plan.ts`, `subagent.ts`, `agent.ts`, `index.ts`.
6. `packages/daemon/src/proxy-model.ts`, `connection.ts`.
7. `packages/client/src/remote-client.ts`, `permission-router.ts`, `mapping.ts`.
8. `packages/config/src/schema.ts`, `defaults.ts` — comments and template only.
9. `packages/cli/src/wiring.ts`, `serve.ts` (the `model/slots` sender only).
10. `packages/tui/src/permission-ui.ts`, `components/PermissionPrompt.tsx`, `App.tsx`.
11. Docs: `README.md` (config table `:283-285`; hooks `:356`, which says `tool_call` hooks run
    one at a time: true within an agent, no longer across children), `CHANGELOG.md` (`:45-49`),
    one line each in `docs/feat/parallel-tools.md` and `permission-call-attribution.md`,
    `TODO.md` at merge.

**Slices (one branch, this order, narrow tests per slice):**
- **S1 grants + label.** Design 3, 4. Sequential; useful alone.
- **S2 children.** Design 5, 8, still only one child at a time at the parent's level.
- **S3 lane.** Design 1, 2. Only via an explicit `subagentExecution` in tests. Most T-D here.
- **S4 slots.** The `curl` first (Preconditions). Design 6.
- **S5 wiring + description.** Design 7, 9. The `parallel` default reaches the real CLI here,
  locally and, through config-carry's carriage, in a pod. The branch merges after S5.

### Failure modes

- **Crash with a child's ask pending:** `pending=[{c2, resumable:false}]` + `inFlight=[c1,c2,c3]`.
  Closed, never resumed: c2 sub-agent note, c1, c3 "Interrupted" (P2). Nothing re-run.
- **Crash with a child waiting in the lane:** no entry for it, "Interrupted". Honest.
- **Crash, a call queued over the cap:** in `inFlight`, reads "Interrupted" on a reload,
  conservative and decided (`parallel-tools.md:409-411`). A laptop cut says "Not run", exact.
- **`beforeRun → false`:** 2b, one child at a time, a commit each; never parallel without a durable record.
- **Crash during the slot await:** before any `tool_start`, nothing started. First unanswered "Interrupted", the rest "Not run": conservative.
- **Esc with several asks and lane waiters:** the shared signal settles every live ask
  (P1) and releases every waiter (`ABORTED`), none prompts; children end by their abort
  branches, are awaited (a running call is never abandoned), every id answered once.
- **Esc in the dialog:** unchanged, it denies that one ask (`tui/src/permission-reply.ts:135-136`), so the next child's dialog can follow; the turn-wide cancel above applies when no dialog is open. Stopping one sub-agent is not offered (debt).
- **"No" to one child:** only that child's call is refused; siblings go on. Its next ask goes through.
- **"Always" while others wait:** waiters re-check and run without a prompt if covered. Not covered: asked next, one by one.
- **Requester throws in the lane:** released in `finally`; that child fails alone.
- **A client leaves, none can answer:** `recheckAsks` settles the one live ask with the reason;
  the next waiter's ask is refused at once by `blockingUnsupported` (`hosted-session.ts:529-532`). Converges.
- **Nobody attached:** the ask holds, the others wait; same class as today (a cancel ends it).
- **One child fails** (a model error, a tool, a throw): that call's `isError` with its tree closed; siblings
  go on (`agent.ts:1482-1520`). Its partial work is lost and its files may be changed; the parent reports.
- **All children fail on one 401, or a lost tunnel:** N `isError`s and the parent decides.
  `feat/resume-after-model-loss` is not built; when it is, it must cover child streams too.
- **429 with fan-out:** Design 8. A `retry-after` above 30 s surfaces at once (P9), as that child's `isError`.
- **Same file:** `fs_edit` RMW is atomic and a clash is a visible `old_string not found`. Same-file
  `fs_write`s: last write wins, atomic but a semantic loss. `sed -i` and `git` in shell bypass the
  lock (accepted by PE-Q3 and owner decision 1; the neutral text covers it).
- **Probe:** a dead host costs 1.5 s once per fan-out at most, config cap used. A proxy answering
  a wrong `total_slots`: only the cap changes, and the ceiling stays the config's. A non-llama server: 404, no cap, memoized.
- **`slots` greater than config:** config wins. **`maxParallel: 1`:** every call alone.
- **Local server context split:** `-np N` splits the window unless unified, so a child can
  overflow while `contextWindow` says otherwise. Exists today for any slot; not addressed, stated in the debt.
- **A hook rewrites `subagent_type`:** Design 1's effective kind. **Repeated id in one message:** the executor
  uses indexes (`parallel-tools.md:285-286`), but the rows and the pending entry share the id. Model misbehaviour; display only, no loss.
- **Late progress after a settle:** none; a child's events end before `run` returns.
- **Replay ring:** a group holds the cut (`parallel-tools.md:516-517`); progress frames are small; N trees multiply it, bounded by the group.
- **Forged label:** bounded, stripped, display only (Design 4). **A pod ignoring the carried `subagentExecution` / `subagentMaxParallel`:** it can already spam the tunnel; no laptop effect beyond today's (§7: a pin is UX).

*Rebased (config-carry). Removed: the argv-flag rows (resident with stale flags, an older pod
binary refusing the flags, a corrupt encoded description, a pod's bad `…File`). Added or changed:*
- **Version skew, a laptop with `model/slots` vs one without** (both v16): `MethodNotFound` → no
  cap, the config's `subagentMaxParallel` applies. No bump (P12).
- **Version skew, a laptop with this task vs a v16 pod daemon without it** (a kept resident of an
  older build, or `TENTACLE_POD_BIN`): the pod accepts the carried keys (they are in its v16 schema)
  and has no reader, so its sub-agents stay sequential with the old description. Silent but
  harmless; converges when the resident is replaced. The reverse (an older v16 laptop, a newer pod):
  the laptop already carries the keys (config-carry), so the pod runs parallel, with no slot cap.
- **Re-attach to a live session with another profile:** the session keeps the `subagents.*` it was
  created with; config-carry's drift notice names the keys. A new session uses the new profile's.
- **Carried settings with no description, pod config with its own text:** the neutral default
  (config-carry T21); the pod's text never applies on `run`/`attach`.
- **Bare `session/open` on a proxy daemon** (a third-party client, no `settings`): the pod's own
  values, and only its inline description (its file is not read under `podDaemon`).
- **`connect`:** sends nothing; `serve`'s own `subagents.*` and description decide, as its own
  model and grants do.
- **`session/context` before the open:** the probe is built with the same settings (P11), so the
  meter counts the same `agent_task` description as the first prompt.
- **A pod's own invalid `subagents.*`** (inline text over 4096 B): after config-carry round 2 it
  no longer fails the pod daemon's load; any other invalid key in the pod's file still does (strict schema, unchanged).
- **Empty or single-call rounds:** as today, with no probe and no lane contention.

### Tests

Red before green; non-vacuity by mutation (§9). Fakes: scripted `ModelProvider`, deferred
promises (no sleeps), `SpyBroker`, the daemon persistence harness (`persistence.test.ts`, "round
groups on disk"), `NoInFlightStore` (T-F3b), injected `fetch`, ink-testing-library, and the
channel-pair pod harness of `cli/test/model-proxy.test.ts` (config-carry's end-to-end tests).

- **T-G (S1, `session-grants.test.ts`, gate):** an "always" in child A covers child B and the parent (red on `main`); two concurrent asks of one command → ONE requester call (the race, mutation: no re-check → 2); two uncovered → two calls, one at a time, FIFO; `force: "ask"` still asks; abort releases waiters without a requester call; a throwing requester releases the lane.
- **T-L (S1):** router sanitizes control chars and bounds `agent`; `permissionAgentLine`; dialog frame shows `explore · "find callers"` and `permissionPromptRows` is one more; a call's own ask has no row.
- **T-C1 (S2, Task 6 finding 1):** a child gets exactly `tools.execution`; the child's reads overlap; `sequential` → they do not. Mutation: drop it → red.
- **T-C2 (S2):** two children with one server call id spill to different files. Red on `main`.
- **T-C3 (S2):** a child's model throw → `subagent_end` `error`, then the call's `isError`.
- **T-R (S2):** a 429 with `retry-after` waits `≥ retry-after` and two random values give two delays.
- **T-P (S3):** `planRound` by mode (`[a,a,read,a]`, writers under `read-only`, `cap=1`, `sequential`); tools' grouping byte-identical with no spawn; `spawnDependencies`, including a kind rewritten by a hook; read-only type (`explore`, `"all"`, a list with `shell`, a hinted MCP tool, a late-registered tool).
- **T-E1 (S3, red = repro):** two `agent_task` overlap.
- **T-E2:** results pushed in call order on reversed completion; ONE commit; `beforeRun` with all ids, awaited before any child starts.
- **T-E3:** cap 2, 3 agents → never 3 running; the third is `queued`, then `running`.
- **T-E4:** independence: `tools: sequential` + `agents: parallel` and the reverse; `tools: read-only` never puts an `explore` with an `fs_read`.
- **T-E5:** one child fails, siblings finish; Esc mid-group with an ask live: every id answered once, no start after abort.
- **T-D1 (S3, real daemon + persister):** during a child's ask, the record has `inFlight` + `pending` `resumable:false`; a reload closes with sub-agent note / "Interrupted" and re-runs nothing. Two guards keep the entry non-resumable: the origin, and the asked tool's name (a child's ask names the child's tool, never `agent_task`). Mutation: `origin: "call"` + `classifyPending` without the name check → red (`origin: "call"` alone survives here).
- **T-D2:** `NoInFlightStore`: children one at a time, a commit each. Mutation: ignore the boolean → red.
- **T-D3 (task 4's limit):** an ask live while a sibling finished: the cut has not moved; a fresh attach re-offers it; a second client's answer works. Mutation: commit per call in 2a → red.
- **T-D4:** the ask's attribution: each wire `toolCallId` is its own `agent_task`; a single daemon-side broker, by the existing separate-broker spy (`wiring.test.ts`).
- **T-S (S4):** `/props` parse (valid, 0, garbage, 404, 5xx, timeout), the URL without `/v1` (same root as `countTokens`), bearer sent, memo rules; `RetryingModelProvider` forwards; `model/slots` both ends, `null` on failure with no text, `MethodNotFound` → `undefined`, a link without `requestModelSlots` → `undefined`; effective cap; the probe is called only on a fan-out (mutation: always → red).
- **T-W (S5, rebased: wiring only; the keys' schema, env, defaults and profile rules are config-carry's T20):** `buildAgent` with `subagentExecution: "parallel"`, `subagentMaxParallel: 2` builds an agent whose two `agent_task` overlap and a third queues; `"sequential"` → no overlap (mutation: hard-code the mode → red); `slots` is wired from the model.
- **T-DESC (S5, rebased: use only; resolution is config-carry's):** neither → the neutral text per mode (`sequential` adds nothing); `config.agentTaskDescription` set → used as is, still ending with the type list, and present in the model's tool definition (mutation: ignore the option → red).
- **T-CARRY (S5, replaces T-POD; over the channel pair in `model-proxy.test.ts`):** a pod whose own file says `subagents.execution: "sequential"` and `maxParallel: 9`, with the laptop's settings `parallel` / 2 and a custom description: two `agent_task` overlap in the pod, never 3 at once, and the laptop's model sees the laptop's description (mutation: `buildAgent` reads the pod's config instead of the merged one → red); settings with no description over a pod text → the neutral text; a bare open → the pod's values; `model/slots` from the pod reaches the laptop's provider and lowers the cap (laptop `slots` = 1 → no overlap).
- **Gate:** `bun run check` against the clean lint baseline. In a worktree without Expo, run the root steps separately (`docs/fix/resumed-call-pending.md:208-214`).
- **Live, before the Review:** a real model with two `explore` and two writers on the real TUI, once with a one-slot `llama-server`, once with a pod (`run`, a laptop profile setting `subagents.execution`, a pod config saying otherwise: the laptop's wins).

**Notes / debt (deliberately left):** no per-agent stop; no worktree per agent (PE-Q3 "later");
no jump to the asking tree; no shared rate limiter; a child's partial report is lost on failure;
no slot-aware context window; `summarizeLargeOutput` and title calls are not under the cap (the
server queues them); phone rendering waits for the app's tool rendering; a v16 pod daemon
without this task runs sequentially without saying so (Failure modes).

### Owner questions

*— claude-opus-5-5, 2026-11-05.* None new. The rebase changes no owner decision: decisions 2
and 3 are now config-carry's code, the slot cap stays a lazy `model/slots` (the
`model/countTokens` shape), and no protocol bump is needed (P12).

## Execution

*— claude-opus-5-5, 2026-11-06*

**Load-bearing assumption, re-verified first, on `b8b714b`.** By reading: (a) `subagent.ts:110`
sets `origin: "subagent"`; `classifyPending` needs `origin === "call"` and the asked tool's name on
the asking call (`persisted-session.ts:422-426`); `resumableTurn` refuses `inFlight` and any
non-resumable entry (`:599`, `:604-609`). (b) Phase 2 leaves only at `running === 0`, and the one
commit follows; `subagent.ts` forwards no child `history_commit`; the cut moves only at
`hosted-session.ts:1409-1418`. By execution, against a real `SessionHost` + `SessionPersister`:
T-D1 (`inFlight` + `pending resumable:false` on disk, a second daemon restores it, runs and asks
nothing) and T-D3 (a sibling finished with an ask live: no answer on disk, `inFlight` intact, a
fresh attach is re-offered the ask and its answer works). **Holds.**

**`file:line` check.** Unchanged for every reference this work used. Moved: `README.md:283-285` is
now `:293-296`, `CHANGELOG.md:45-49` is now `:48-53`. `git diff 1b93bfe b8b714b -- packages` touches
only `carried-settings.ts`, `main.ts`, `load.ts` and `protocol/src/session.ts` among sources, none cited for a
behaviour here.

**As built:**

- **S1 grants + label.** `agent/src/session-grants.ts` (new): `covers`, `remember`, FIFO abort-aware
  `serial`. `PermissionGate` takes the store; `AgentConfig.grants`, `SubagentDeps.grants`. Router
  sanitizes `agent` with the exported `progressText`. `permissionAgentLine`, `pendingAgent`, one dim
  row in `PermissionPrompt`, `permissionPromptRows(..., agentRow)`, `App.tsx`.
- **S2 children.** `SubagentDeps.toolExecution`, `AgentConfig.spillScope` (a fresh 8-char id per
  child), `subagent_end { stopReason: "error" }` then rethrow; `retry-after + backoff`.
- **S3 lane.** `Tool.spawnKind`, `SpawnKind`; `createTaskTool(run, types, options)`; `readOnlyType`
  from the runner; pure `spawnKindOf`, `planRound`, `hasSpawnFanOut`, `spawnDependencies`,
  `effectiveAgentCap`; `AgentConfig.subagentExecution`; `runGroup` takes a `GroupRule` (cap +
  dependency rule). The comment on the old assumption is rewritten.
- **S4 slots.** `model/slots` both ends, `ModelProvider.slots?`, `OpenAIProvider.slots`,
  `RetryingModelProvider.slots`, `ProxyModelProvider`'s fourth sender, `Connection.requestModelSlots`,
  `RemoteClient.onModelSlots`, `tunnelledAgent`'s sender, `slotsBounded` in `core/context.ts`.
- **S5 wiring + description.** `buildAgent` reads the merged config; `taskToolDescription`; the
  "not read yet" wording gone from `schema.ts`, `defaults.ts`, `README.md`, `CHANGELOG.md`.

**Protocol:** `PROTOCOL_VERSION` stays 16, as P12 says: one new method, `MethodNotFound` handled.
Record stays v8.

**Drift from the plan:**

1. **`model/slots` answers `{ slots?: number }`, not `{ slots: number | null }`.**
   *Orchestrator decision (owner delegation 2026-11-06): omit the field. Why: `model/countTokens`,
   the plan's stated precedent, says "an optional field is omitted, never null"; reversible, the
   method is new.*
2. **`/props` was not probed, and N=1 vs N=3 was not timed.** `curl` to the endpoint needs an approval
   this unattended session did not have, and going around it through another tool was not an option.
   *Orchestrator decision (owner delegation 2026-11-06): keep the plan's `total_slots` parser, unverified. Why:
   the design does not depend on the name, and a wrong field degrades safely to the config's cap.*
   First item of the live checklist below.
3. **`schema/protocol.json` was edited by hand**, not by `bun run schema:export` (same approval).
   `json-schema.test.ts` compares it with the generator by value, and passes.
4. **A bound at the agent too:** `slotsBounded` (2 s), beside the provider's 1.5 s. A hung tunnel has no
   provider timeout on the pod's side, and the plan asks for "abort-aware and bounded".
5. **A runner built with no `grants` shares one store among its children** (the plan left it unsaid),
   so the lane holds in any wiring.
6. **`createSubagentRunner` skips the spawn tool and `context_reset` in `readOnlyType`**, since a child
   never gets them. A listed tool that is not registered yet counts as read-only until it registers:
   between the plan and the child's start it could be misjudged, only under `read-only`, only in that gap.
7. **Tests live in new files** (`agent/test/session-grants.test.ts`, `parallel-agents.test.ts`,
   `subagent-children.test.ts`, `daemon/test/parallel-agents.test.ts`, `cli/test/parallel-agents.test.ts`,
   `providers/test/slots.test.ts`, `tui/test/permission-agent-line.test.tsx`), not in `persistence.test.ts`.
8. Three pinned delays in `retry.test.ts` change on purpose (`3000→3250`, `2000→2250`, `250→260`).

**Red first, honestly.** Shown failing before their code: T-G, T-C1/2/3, T-S's provider tests,
T-E1 (the repro). T-L's router test, T-P, the rest of T-E, T-D, T-W, T-DESC and T-CARRY were written
just after their slice's code, so were not red on their own; the mutations below stand in.

**Mutations, each seen failing the named tests, then restored; `shasum` identical to the backup,
except as noted:** lane re-check off (T-G race) · agent not passed to the dialog (T-L) · router
sanitizing off (T-L) · child `toolExecution` dropped (T-C1) · `spillScope` dropped (T-C2) · failure
`subagent_end` dropped (T-C3) · a private store per child (T-G, T-D) · `landed` ignored (T-D2) · a commit
per call in phase 2 (T-D3) · cap ignored (T-E3) · probe on every round (T-S) · effective kind ignored
(hook test) · parent's store not passed (T-G) · retry-after not added (T-R) · `classifyPending`
reading every ask as resumable (T-D1) · wiring: mode hard-coded, description dropped, child tools
dropped, parent's store dropped (T-W, T-DESC, T-CARRY) · the tunnel's slots sender off, the laptop's
dispatch off (T-CARRY) · `tunnelledAgent` on the pod's own config (T-CARRY) · 5xx memoized (T-S) ·
custom text ignored (T-DESC). 24 in all, plus the survivor below.

**Two things the mutations found:**

- **The plan's named mutation for T-D1, `origin: "call"` in the wrapper, survives.** The asked tool's
  name is a second guard: `classifyPending` also wants the asking call named as asked, and a child's
  ask names the child's tool, never `agent_task`. So that one line alone cannot make an entry resumable.
  T-D1 was shown non-vacuous with the stronger mutation above.
- **Hard-coding the mode first passed the `sequential` tests**: children with no gate finished before
  overlapping. Those tests now hold the first child open and check the second did not start
  (`expectOneAtATime`), and the rerun is red.

**One restore was not from a backup.** The `classifyPending` mutation ran after its `cp` had been
refused with the rest of a compound command. It was reversed by hand, and `git diff --stat` on that file
is empty.

**Gate (foreground, end of work):**

- `bunx tsc --noEmit` clean.
- `bun run typecheck`: **fails only in `apps/mobile`** (33 errors, all there, no `expo`/`react-native`
  in this worktree; not touched here). To verify: install with mobile, then `bun run typecheck`.
- `bunx biome check .` clean (663 files).
- `bun test packages`: 4842 pass, 3 skip (the opt-in ones), 0 fail. No reaper flake this run.

**Unverified, none of it ran on a real engine or model.** Headless checklist, with
`subagents.execution` unset (default `parallel`), on the local llama-server:

1. **`/props`:** `curl http://<host>:8080/props`: is `total_slots` the field, and does it match `-np`?
   Time N=1 vs N=3 concurrent `/v1/chat/completions`, and paste both into this doc.
2. **Docker, detached:** `tentacle run --detach --name pa-test …` with a prompt asking for two
   `explore` agents, then `tentacle attach pa-test`: both trees grow at once; each row keeps its own
   tree; total time well under the sum.
3. **Slots:** with `llama-server -np 1`: the same prompt runs them one at a time, with no `· queued`
   rows, and the daemon log has `sub-agents capped at 1 at once`. With `-np 2` and three agents: the third
   reads `· queued`, then runs.
4. **Sequential:** `subagents.execution: "sequential"` on the laptop, none in the container: one at a
   time. A container config saying `parallel` changes nothing (the laptop's wins).
5. **Permission flow:** two `general-purpose` agents each asked to run a different shell command: one
   dialog at a time, each with its `general-purpose · "…"` row; "No" refuses only that call; "Yes, and
   don't ask again" on a shared prefix means no second dialog, and the parent is covered too.
6. **Crash:** kill a `serve` daemon during a child's dialog (`connect` path): on restart the turn is closed with the sub-agent note and "Interrupted", nothing re-runs.
7. **Esc** during a group with a dialog open denies that ask; again with no dialog cancels the turn:
   every row settles, and no agent starts afterwards.

### Round 2

Findings 2 and 4 of the Review (orchestrator decision Q2); 1, 3, 5 go to `TODO.md`.

- **Finding 2:** `openai-provider.ts` `slots()` now memoizes only a 2xx answer (a number, or a
  well-formed one without `total_slots`) and a 404. Any other non-2xx (401/403/408/429, 5xx) and network
  errors return `undefined` unmemoized, so the next fan-out asks again (still bounded by the timeouts).
  Test in `providers/test/slots.test.ts`: 401/403/408/429, then 200 → second call reads 2. Red before
  the fix (4 fail), green after. Mutation (memoize every non-5xx again): 5 red; reverted.
- **Finding 4:** the T-D1 comment (`daemon/test/parallel-agents.test.ts`) and the plan's T-D1 row now name
  the real guards (origin + the asked tool's name) and the mutation that does fail it.
- **Gate:** `bunx tsc --noEmit`, `bunx biome check .`, `bun test packages`: see the final report.

*— claude-sonnet-5-5, 2026-11-06*

## Review

*— claude-opus-5-5, 2026-11-06*

**Verdict: PASS (APPROVE-WITH-NITS).** No CRITICAL, HIGH or MEDIUM finding; 4 LOW and 1 NIT. All
of them can wait for a follow-up. The reviewer is the same model as the executor, only in a
fresh context, so shared blind spots can survive both passes. The real model, engine and TUI
were not exercised (Open, below).

### Findings

1. **LOW: a wide label makes the dialog one row taller than planned.** `tui/src/permission-ui.ts:81`
   truncates by UTF-16 length, not by cells. A description of CJK text, written by the model
   or forged by a pod, wraps. Measured at 100 columns: the frame has 9 rows,
   `permissionPromptRows` says 8; the same case in ASCII has 8. The viewport is then off by one
   while that dialog is open. Display only: nothing decides on the label. The neighbouring
   `truncate` (`PermissionPrompt.tsx:11-13`) has the same flaw for details, so this is an
   existing class with a new input.
2. **LOW: a transient refusal disables the cap for the provider's lifetime.**
   `providers/src/openai-provider.ts:187` memoizes every status below 500, while the plan says "an
   answer or a 404". A 429, 401 or 408 on the first fan-out leaves `{ value: undefined }`, so the
   server's slots are not read again until the process restarts: a `-np 1` server then gets
   4 concurrent requests, which it should queue (not measured, Open). Likewise a remembered
   number outlives a server restart with another `-np`, the very freeze Design 6 holds against
   a carried setting. Not reported as drift. The ceiling stays the config's, and no
   permission or data is affected.
3. **LOW: the slot-cap line is mislabelled outside the TUI.** `cli/src/wiring.ts:294` writes through
   `options.log`, which `cli/src/main.ts:1585` and `:1693` prefix with `[hook]`. A one-shot run on a
   one-slot server prints `[hook] sub-agents capped at 1 at once…` to stderr, though no hook is
   involved. Ink is not mounted there, so §7 holds. Found by reading, not run.
4. **LOW: T-D1's comment names a mutation that does not fail it.** `daemon/test/parallel-agents.test.ts:218`
   says `origin: "call"` makes the entry resumable; it does not (below). The plan's T-D1 row says
   the same. The executor reported the survivor but left the comment.
5. **NIT: the "Repeated id" failure mode says "no loss", which looks wrong for a large report.** By
   reading, not run: a parent has no `spillScope` (`agent/src/agent.ts:1852-1853`), so two
   `agent_task` calls with one id in one message would spill to one file and the first report would
   be overwritten. It needs a misbehaving server, and sequential calls already had it. The open
   `fix/tool-output-location` is the natural place.

Also noted, not a finding: `readOnlyType` counts an unregistered tool as read-only
(`agent/src/subagent.ts:309`). The plan asks for it and drift 6 reports it. It only affects overlap
under `read-only`, between planning and the child's start; it bypasses no permission.

### The surviving mutation (T-D1 `origin: "call"`)

**The second guard is real, and no test is missing.** Results, each on otherwise restored source:

| Mutation | Result |
|---|---|
| `origin: "call"` alone, `daemon/test/parallel-agents.test.ts` + `persistence.test.ts` | green: the mutation survives there |
| `origin: "call"` alone, `agent/test/subagent.test.ts` + `cli/test/wiring.test.ts` | 5 red (4 + 1): the wrapper's `origin` is pinned directly |
| `origin: "call"` + `classifyPending` without the name check | T-D1 and 2 more red: the entry reads `resumable: true` |

`classifyPending` wants the asking call named as the asked tool. A child's call is `agent_task`, and a
child can never ask for `agent_task` (`subagent.ts:212`), so the name check holds alone in production.
`persistence.test.ts:1386` pins the classifier's `origin` check when the name does match. A third guard
stands behind both: `resumableTurn` refuses any `inFlight` (`persisted-session.ts:599`).

### Gate (once, foreground, on 265075c)

`bunx tsc --noEmit` clean · `bunx biome check .` clean (663 files) · `bun test packages`: **4842 pass, 3
skip (opt-in), 0 fail**, 59022 assertions, 4845 tests in 325 files. No reaper flake this run.
`bun run check` and the `apps/mobile` typecheck were not run, as instructed.

### Mutations (backups in `.tentacle/tmp/parallel-agents/`)

| Mutation | Origin | Red |
|---|---|---|
| Lane re-check off (`permission-gate.ts`) | executor | T-G race (ONE requester call) |
| A commit per call in phase 2 (`agent.ts`) | executor | T-D3 |
| `beforeRun`'s answer ignored (`agent.ts`) | executor | T-D2 |
| An aborted waiter stays in the queue (`session-grants.ts`) | reviewer | "an abort releases the waiters" |

`shasum` of all five touched files is identical to before; `git status` is clean. `persisted-session.ts`
is the fifth, for the name-check row above.

### Red-team

| Attack | Result |
|---|---|
| **(1)** Each ask reaches the right child, through one broker | Holds. `subagentRequester` wins over the child's fields (`subagent.ts:106-114`); T-D4 shows each `toolCallId` and label; every gate calls the same `permissions.request` (`wiring.ts:413`, `:463`). T-D4's `brokers.length === 1` proves little in its own rig; `wiring.test.ts` carries the invariant |
| **(1)** Auto-approval leak | None found. The lane calls the same requester; a `force: "ask"` skips both `covers` checks; a waiter re-checks with the same rule (T-G) |
| **(1)** Lasting approval on the laptop from a pod | None. `permission-router.ts:11-14` keeps no grant; `SessionGrants` lives in the daemon, one per `buildAgent` (`session-host.ts:830`); the label is stripped, capped and display only |
| **(2)** Crash with a child's ask live: reviewer's script, real `SessionHost` + `SessionPersister` | `resume` undefined; the finished sibling reads "Interrupted", the asker gets the sub-agent note; nothing re-runs. Conservative and honest: a finished sibling's report is lost, its effects stay |
| **(2)** Crash during phase 1 of an `agents` group (a `tool_call` hook's forced ask, stood in by `permission: "ask"`) | `pending=[c2, resumable, groupStart c1]`, no `inFlight`, no child started. The restart re-asks from c1, then c2; both overlap, each starts once, `inFlight` is durable, results land in call order |
| **(3)** A cancel with a live ask and a lane waiter, then a new turn | Lane free: the next turn's child is asked and runs. Every id answered once (existing test) |
| **(3)** Result order | Pushed in call order whatever the completion order, one commit (`agent.ts:1514-1522`, T-E2) |
| **(4)** `slots`, cap and version | Fan-out-only probe, `slots = 1` runs alone, a garbage answer falls back to the config (T-S). Bounds: 1.5 s provider, 2 s agent, 2 s laptop. **No bump needed, per §7:** a new request method is free, `MethodNotFound` is handled (`proxy-model.ts`), and `slots` is omitted when unknown, as `model/countTokens` does |
| **(4)** Carried `subagents.*` consumed in the pod | Holds (T-CARRY, over the channel pair); executor's mutation on the merged config is on record, not re-run here |
| **(5)** Dialog names the child; nothing raw under Ink | Holds: one row, counted in the viewport (except finding 1). The worker logs to a file (`worker.ts:118`), a pod to its daemon log; stderr only in `plain`/one-shot, with Ink absent |
| Other callers of `model/countTokens` that `model/slots` could miss | None: all 7 sites match, including the relay (it is a `RemoteClient`). `RetryingModelProvider` forwards; `select-provider.ts` has no other wrapper |
| Hand-over with N streams | No starvation: new calls go to the new link and the old one drains, at most 5 min (`relay.ts:96`). By reading |
| Shared state across concurrent children | No problem found in tools or `HookRunner` (a fresh runner per child; project trust is the one shared decision). A reused call id no longer collides (T-C2) |

**Premises.** The Repro is TRUE on the main checkout (no `spawnKind` there): `c2` starts at 206 ms, total
409 ms. On this branch with `parallel`: both start at 5 ms, total 207 ms. The load-bearing assumption
(a) and (b) holds, by reading and by execution. P1, P3, P4, P5, P7, P10, P12 and the rows of P8 and P9
above were opened and are TRUE. P2, P6 and P11 were not re-opened line by line: they rest on T-D1, T-E
and T-CARRY.

### Open

**Unverified: nothing ran on a real model, engine or TUI.** The Execution checklist items 2–7 and the
plan's "Live, before the Review" did not run. `/props` is verified (orchestrator note); the N=1 vs N=3
timing is not. Since `total_slots` is 1 on the owner's endpoint, **the default config there never fans
out**: a live test needs `-np 2` or more.

**Executor's behaviour.** Honest and useful: it reported which tests were not red first, the survivor,
the restore not done from a backup, and its 8 drifts. Each drift claim checked here held, except that
the memo in finding 2 went unreported. The planned live test was skipped and said so.

**Questions (owner unreachable; the orchestrator decides):**

- **Q1. Merge before the live checklist?** Recommendation: yes. Track the checklist in `TODO.md`, run
  with `-np 2`, permission flow and Esc first. The gate, the daemon traces and a one-slot default
  on the owner's endpoint limit the exposure there; another endpoint gets the fan-out by default.
- **Q2. Fix the LOWs before merging?** Recommendation: findings 2 and 4 now (a one-line condition and
  a comment), findings 1, 3 and 5 as `TODO.md` entries. Finding 1 is best fixed with the existing
  `truncate`, as one width-aware helper.
- **Q3. Should an unregistered tool count as a writer?** Recommendation: leave it. The plan chose it, and
  failing closed would make a type naming a stale tool run alone for good.

*Orchestrator note, 2026-11-06:* drift 2 verified live — `GET http://192.168.1.17:8080/props` (with the configured key) answers `"total_slots":1`, `"n_ctx":174080`: the parser's field name is right, and on the owner's local endpoint the effective cap is 1 (children run one at a time). `bun run schema:export` re-run by the orchestrator: no diff with the hand-edited `protocol.json`.

*Orchestrator decisions (owner delegation 2026-11-06):* Q1 — merge only after the orchestrator's own live smoke run on the owner's endpoint (one slot: sequential children, real model, docker); the `-np 2` fan-out + permission-flow checklist goes to `TODO.md`. Q2 — fix findings 2 and 4 now (round 2); findings 1, 3, 5 → `TODO.md`. Q3 — leave it (plan's choice).
