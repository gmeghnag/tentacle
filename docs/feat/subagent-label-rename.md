# feat/subagent-label-rename — relabel "Task" → "Agent" and rename the tool `task` → `agent_task`

> **Status:** done — merged to `main` (7344fbc) · status synced by audit 2026-10-19. Promoted eval → `feat` 2026-10-17 (branch `feat/subagent-label-rename`); **Gate PASSED** (weak-model check, evidence in Implementation §preconditions): no invocation degradation for `agent_task` → full rename (label + tool name).
> Type: `feat` · Size: S (mechanical — 3 name literals + 1 label + comments + 2 test fixtures) · Blast: **load-bearing** (it changes the *model-facing* tool name/schema; the `spawnToolName` default is a correctness coupling) · Suited: strong model executes + **mandatory fresh-context Review** per §10.

## Context

*— claude-opus-4-8, 2026-10-17*

**The question being decided:** should we (1) change the TUI tool-call label from
**"Task"** to **"Agent"**, and (2) rename the underlying tool from `task` to
**`agent_task`** (model-facing), so the display and the tool name both read as
"agent" — matching the surrounding "subagent" / `subagent_type` vocabulary?

**Evidence (verified) — the full surface of a rename.** The tool-name literal is
wired in a small, enumerable set of places:
- `packages/tools/src/task.ts:49` — `name: "task"`: the **single source** of the
  model-facing tool name (+ the tool's own `description` text, which says "task").
- `packages/tui/src/render-lines.ts:316` — `case "task":` → `label: "Task"`: the
  display switch; the `case` key must track the tool name, the label is the
  cosmetic part.
- `packages/agent/src/subagent.ts:139` — `const spawnToolName = deps.spawnToolName
  ?? "task"`, used at `:153` (`if (tool.name === spawnToolName)`) to **strip the
  spawn tool from a child's registry** (no nested delegation). If the tool is
  renamed and this default is not, the filter matches nothing → a subagent could
  spawn subagents. **Correctness coupling, not cosmetic.**
- Tests: `packages/tui/test/render-lines.test.ts:129` pins `"Task find bug"`.
  Internal code identifiers (`createTaskTool`, `TaskRunner`, `TaskRunResult`) are
  **not** model-facing — renaming them is churn with no benefit; leave them.

**Why `agent_task` and not plain `agent` (naming rationale).** The surrounding
surface already says *agent* (sub-agent types, `subagent_type`), so "Agent" reads
more consistently than "Task" to a user. Of the three shapes:
- *label-only* ("Agent" shown, tool stays `task`) leaves a label↔name mismatch — a
  small inconsistency;
- *rename to `agent`* loses the "task/delegation" semantics and strays furthest
  from the token models are primed on;
- *rename to `agent_task`* keeps the **`task`** token (hedging the model's prior
  for a delegation tool) **and** adds **`agent`** for clarity/label-consistency —
  the middle path.

**Correcting a prior error in this eval's earlier draft.** An earlier version
claimed renaming the tool risks `MethodNotFound`-style misfires. That was wrong:
the model calls from the **tool list offered each turn**, not from memory — if we
offer `agent_task`, it calls `agent_task`. The real risk is softer and empirical:
a weaker/local model (the Qwen in this repo's model-mix) leans on priors, so an
unfamiliar name *may* be invoked slightly less readily. That is **measurable**, so
the decision is gated on a measurement, not an opinion.

**Tracked as** `TODO.md` (roadmap, near the TUI items).

## Implementation

*— Qwen3.8-27B-Q6, 2026-10-17*

### Load-bearing assumption

The model-facing tool name has **exactly one source of truth and one
correctness coupling**: the name is defined once at `packages/tools/src/task.ts:49`
and the only other place the name is *compared* (not displayed) is
`packages/agent/src/subagent.ts:139` — `const spawnToolName = deps.spawnToolName ?? "task"`
— whose sole job (`:153`) is to strip the spawn tool from a child's registry (the
depth-1 no-nested-delegation guard). If the tool is renamed and this default is
not, the filter matches nothing and a subagent could spawn subagents. The
**code** surface — where the name is *compared* or displayed, not just mentioned —
is exhaustive, verified by `grep -rn '"task"'` over `packages/` (2026-10-17):
exactly `task.ts:49` + `subagent.ts:139` + `render-lines.ts:316-317`, plus the
two test fixtures `packages/tui/test/state.test.ts:33` (the subagent-progress
fold test keys its `tool_start` on the tool name) and
`packages/tui/test/render-lines.test.ts:114,129`. The **prose** surface
(backticked `` `task` `` in comments/docstrings, incl. the scaffolded config
template) is a *separate* sweep — the double-quoted grep cannot see backticks —
and was completed after the fresh-context Review (see Execution / Review); 8
backticked refs were renamed there, one of them user-facing (in
`DEFAULT_CONFIG_JSONC`).

### Preconditions (verified)

- **Gate (PASSED) — weak-model invocation check.** The local Qwen3.8-27B-Q6
  (`~/.config/tentacle/config.jsonc`) was offered the tool under both names with
  the **real** `createTaskTool` + `ToolRegistry.definitions()` (identical
  zod→JSON-Schema pipeline as production, `registry.ts:definitions()`) and the
  same payload shape as `openai-provider.ts:buildPayload()` (system prompt: the
  default verbatim apart from two minor phrasing words — immaterial to the
  name question). Three conditions,
  12 trials each arm (`.tentacle/staging/gate-agent-task.ts`, run 2026-10-17):
  1. *Neutral* (no delegation hint): **0/4 vs 0/4** — the model never chooses
     delegation on its own; identical for both names, so selection behaviour is
     name-independent (a floor, not a signal).
  2. *Explicit* ("delegate this"): 0/4 vs 0/4 with the same floor (it runs
     `shell` itself or answers in text) — also name-independent.
  3. *Forced* ("you must use the delegation tool", name not leaked): **6/6
     invoked with valid args for BOTH names, 0 wrong-name, 0 inline, 0
     text-only.** Crucially, in the `agent_task` arm the model never drifted to
     its prior-trained name `task` — zero name drift.
  
  ⇒ Renaming `task` → `agent_task` causes no measurable invocation degradation;
  the eval's fallback branch (label-only) is not needed.
- `builtinTools` (`packages/tools/src/builtins.ts:303`) does **not** include the
  task tool (it is registered separately in `cli/wiring.ts:123`), so the
  registry composition in the gate matches production exactly.
- `task.test.ts` asserts no tool *name* (only `permission` and `description`),
  and no test anywhere asserts `name === "task"` — so the name rename cannot
  break a hidden assertion; the two fixtures that hard-code `name: "task"` are
  the TUI tests above, which are the render-path pins.
- The `spawnToolName` default is the only code path that *reads* the name for
  control flow; `render-lines.ts` reads it for display; the TUI `state.ts` fold
  matches subagent progress by `id`, not name (verified — no `"task"` in
  `state.ts`), so no state-coupling exists beyond the two fixtures.

### Design

Rename in dependency order (protocol → tools → agent → tui → cli/docs); the
name is a leaf string so there is no protocol/schema change and no version
bump (§7 additive rule unaffected):

1. `packages/tools/src/task.ts:49` — `name: "task"` → `"agent_task"`; update
   the file-header JSDoc (`:2`) to name the new tool. Keep the description
   prose (it says "task" in the delegation sense, which is still accurate).
2. `packages/agent/src/subagent.ts:139` — `spawnToolName` default `"task"` →
   `"agent_task"` (the lockstep rename); update the JSDoc at `:127`
   (`default task`) and the prose refs at `:11`, `:27`.
3. `packages/tui/src/render-lines.ts:316-317` — `case "task":` → `case
   "agent_task":` (key must track the tool name) and `label: "Task"` →
   `"Agent"` (the cosmetic half of the rename).
4. Prose/comment follow-ups (no behaviour), **two distinct sweeps**:
   (a) the *double-quoted* name literal + its named comments, found by
   `grep -rn '"task"'`: `packages/cli/src/wiring.ts:100-102`,
   `packages/config/src/defaults.ts:8`, `README.md:58,93,106`; and
   (b) the *backticked* `` `task` `` prose refs a double-quoted grep cannot
   see (found post-Review): `packages/core/src/tool.ts:36`,
   `packages/config/src/schema.ts:74`, `packages/config/src/defaults.ts:89`
   (the scaffolded `config.jsonc` template — user-facing),
   `packages/tui/src/state.ts:34,54`, `packages/tui/src/render-lines.ts:232,254`,
   `packages/agent/src/agent.ts:61`, `packages/daemon/src/mapping.ts:96`.
5. Internal identifiers (`createTaskTool`, `TaskRunner`, `TaskRunResult`,
   `TaskAgentType`, `task.ts` filename) are **not** model-facing — left as-is
   per the Context's churn-avoidance decision.

### Files (exact, smallest diff)

| File | Change |
| --- | --- |
| `packages/tools/src/task.ts` | `:2` JSDoc, `:49` name |
| `packages/agent/src/subagent.ts` | `:11,:27,:127` prose, `:139` default |
| `packages/tui/src/render-lines.ts` | `:316` case key, `:317` label |
| `packages/tui/test/render-lines.test.ts` | `:114` fixture name, `:129` `"Task find bug"` → `"Agent find bug"` |
| `packages/tui/test/state.test.ts` | `:33` fixture name |
| `packages/agent/test/subagent.test.ts` | `:126` + `:139` spawn-tool fixture name → `agent_task` (regression pin for the lockstep coupling) |
| `packages/cli/src/wiring.ts` | `:100-102` comment |
| `packages/config/src/defaults.ts` | `:8` comment, `:89` scaffolded-config comment (user-facing) |
| `packages/core/src/tool.ts` | `:36` doc-comment |
| `packages/config/src/schema.ts` | `:74` doc-comment |
| `packages/tui/src/state.ts` | `:34,:54` doc-comments |
| `packages/tui/src/render-lines.ts` | `:232,:254` comments (in addition to `:316`/`:317`) |
| `packages/agent/src/agent.ts` | `:61` comment |
| `packages/daemon/src/mapping.ts` | `:96` comment |
| `README.md` | `:58,:93,:106` |

### Failure modes

- **Nested-delegation regression** (the load-bearing one): if `subagent.ts:139`
  is not renamed in lockstep, children keep the spawn tool. *Design out:*
  rename in the same commit as `task.ts:49`; *pin:* `subagent.test.ts:122`
  recursion test, updated to register/call `agent_task` and assert a
  `spawned[]` side-effect flag that only trips if the spawn tool is actually
  *executed* by the child — red if the default drifts (the child receives and
  runs the spawn tool). This is the red-first target. (The pre-existing test
  asserted the sentinel in `report`, which is vacuous — `report` holds only text
  deltas, never the tool result — so the flag is the non-vacuous pin.)
- **Label/case drift:** if `render-lines.ts:316` keeps `case "task"`, the new
  tool name falls through to `default` and the header silently shows the raw
  `agent_task` name instead of "Agent". *Pin:* `render-lines.test.ts:129`
  (red-first: updated to expect `"Agent find bug"` — fails before the case+label
  change, proving the render path).
- **Resumed pre-rename sessions:** a session persisted with `tool_start name:"task"`
  replays through `render-lines` and shows the raw `agent_task`-era… actually the
  *old* name `task` falls through to `default` → header shows `task <args>`.
  Acceptable degradation (one cosmetic line per resumed old session, no state
  corruption — `state.ts` matches by id). Not worth a backward-compat case in the
  switch (it would keep a dead literal alive); noted as accepted.
- **Gate-coverage hole:** the gate proved name+args reliability but not
  multi-turn *preference* for delegation (the floor shows the model rarely
  delegates unprompted under either name). Accepted: the rename does not change
  the model's delegation *selection* (both arms 0/4 neutral), only the label and
  the offered name it must hit once it decides to delegate — which it hits 6/6.

### Tests

- `packages/agent/test/subagent.test.ts:122` — **red-first + non-vacuity**: the
  pre-existing recursion test was **vacuous** (its `not.toContain` sentinel could
  never fire). First prove vacuity by mutation (disable the filter → old test
  still green), then rewrite it to a `spawned[]` side-effect flag + `agent_task`
  fixture; run it *before* changing `subagent.ts:139` to show **red** (the
  child executes the spawn tool → flag fills), then **green** after the lockstep
  rename. Mutation (revert the default) → red, confirming non-vacuity.
- `packages/tui/test/render-lines.test.ts` — **red-first**: update `:114`
  fixture to `agent_task` and `:129` to expect `"Agent find bug"`; run before the
  `render-lines.ts` change to show red (raw-name fallback / missing label), then
  green.
- `packages/tui/test/state.test.ts:33` — fixture name update (keeps the
  subagent-progress fold test exercising the real tool name).
- `packages/tools/test/task.test.ts` — unchanged (no name assertion); run to
  confirm no regression.

### Validation

- Narrow, per slice: `bun test packages/agent/test/subagent.test.ts`,
  `bun test packages/tui/test/render-lines.test.ts`,
  `bun test packages/tui/test/state.test.ts`, `bun test packages/tools/test/task.test.ts`
  (red → green for the two red-first files).
- Before done: `bun run check` (typecheck + lint + full test) green vs the §6
  baseline; lint stays clean (0/0).
- Fresh-context adversarial Review (mandatory, load-bearing) including the gate
  evidence above, per §10.

## Execution

*— Qwen3.8-27B-Q6, 2026-10-17*

**Gate (pre-promotion, PASSED).** Offered the local Qwen3.8-27B-Q6 the tool under
both names via the real `createTaskTool` + `ToolRegistry.definitions()`
(`.tentacle/staging/gate-agent-task.ts`). Neutral & explicit prompts → 0/4 both
names (floor; name-independent). Forced delegation → **6/6 invoked, valid args,
0 wrong-name drift** for both names. No degradation → full rename, fallback not
needed.

**Red-first (two non-vacuous reds captured):**

1. **Load-bearing coupling — `subagent.ts:139`.** First proved the *existing*
   recursion test was **vacuous**: its `expect(report).not.toContain("SPAWNED A
   CHILD")` could never fire, because `report` only accumulates the child's
   *text* deltas and the sentinel is the *tool result*. Confirmed by mutation —
   disabling the filter (`if (tool.name === "never-matches-mutation")`) left the
   test **passing**. Strengthened it to assert a side-effect flag (`spawned[]`)
   that only trips if the spawn tool is actually *executed* by the child. With
   the filter disabled the strengthened test went **red** (`spawned` captured the
   child's spawn), then **green** once the `agent_task` rename landed in lockstep
   with the `:139` default. This is the non-vacuity proof for the load-bearing
   coupling.
2. **Render path — `render-lines.ts:316-317`.** Updated the fixture to
   `agent_task` + expected `"Agent find bug"` first; before touching the source it
   went **red** with the header rendering the *raw* `agent_task` + raw JSON args
   (the `default` fall-through — the exact label/case-drift failure mode).
   Green after the `case`+label change.

**As-built (in plan order):**
- `packages/tools/src/task.ts` — `:2` + `:33` JSDoc → `agent_task`, `:49`
  `name: "agent_task"`. Description prose unchanged (still accurate).
- `packages/agent/src/subagent.ts` — `:11,:27,:127` JSDoc/prose → `agent_task`,
  `:139` default → `"agent_task"` (the lockstep).
- `packages/tui/src/render-lines.ts:316-317` — `case "agent_task"`,
  `label: "Agent"`.
- `packages/tui/test/render-lines.test.ts:114,129` — fixture + `"Agent find
  bug"`.
- `packages/tui/test/state.test.ts:33` — fixture name → `agent_task`.
- `packages/agent/test/subagent.test.ts:122` — recursion test rewritten (side
  effect flag, `agent_task` fixture) — now non-vacuous.
- `packages/cli/src/wiring.ts:100-102`, `packages/config/src/defaults.ts:8`,
  `README.md:58,93,106` — prose/comments.

**Post-Review prose sweep (after the fresh-context Review).** The Review found
the double-quoted grep could not see backticked `` `task` `` refs in
comments/docstrings, and the "exhaustive" claim was an overstatement. 8 backticked
refs were then renamed to `` `agent_task` ``: `packages/core/src/tool.ts:36`,
`packages/config/src/schema.ts:74`, `packages/config/src/defaults.ts:89` (the
scaffolded `config.jsonc` template — **user-facing**),
`packages/tui/src/state.ts:34,54`, `packages/tui/src/render-lines.ts:232,254`,
`packages/agent/src/agent.ts:61`, `packages/daemon/src/mapping.ts:96`. A final
`grep` for `` `task` `` / `"task"` over `packages/` (excluding the intentional
internal-identifier carve-out) returns nothing. These are comment-only; no
behaviour or test changes, so the red-first reds above are unaffected.

**Drift from Implementation:** the plan's *code* surface was followed exactly and
both red-first reds captured. The one addition beyond the plan was the
*strengthening* of the recursion test (the plan named it as the red-first target
but did not anticipate it being vacuous — discovered via mutation during execution
and fixed on the spot, per §9). The post-Review backticked-prose sweep is an
addition the plan's (double-quoted) grep did not enumerate; the Implementation
Design step 4 and Files table were updated to record it. Internal identifiers
(`createTaskTool`, `TaskRunner`, …) left as-is, as planned.

**Validation:** narrow red→green per slice; then `bun run check` — typecheck
clean, lint clean (0 errors/0 warnings), full test **650 pass / 1 opt-in
live-k8s skip / 0 fail**. Re-run after the post-Review prose sweep: same
**650 / 1 / 0**, lint 0/0, `tsc` clean.

## Review

*— fresh-context adversarial review (explore sub-agent) + Qwen3.8-27B-Q6, 2026-10-17*

Per §10 (load-bearing → mandatory fresh-context Review), a read-only explore
sub-agent independently red-teamed the change. **Initial verdict:
REQUEST-CHANGES**; after the fixes below, **APPROVE**.

**Confirmed holding (cited by the reviewer):**
- The lockstep rename is real and in sync: `task.ts:49` name =
  `subagent.ts:139` default = `agent_task`; the comparison at `:153` runs *before*
  the allow-list check, so no user-defined type or `"all"` type can re-admit the
  spawn tool.
- Every agent-building path (worker, pod, `serve`) funnels through the single
  `buildAgent` call site in `wiring.ts`; no divergent `spawnToolName` override
  exists. MCP tools are namespaced `mcp__<server>__<tool>` and cannot equal
  `agent_task`; no shadowing.
- The recursion test is now **non-vacuous**: the old `not.toContain("SPAWNED A
  CHILD")` could never fire (`report` holds only text deltas, not tool results);
  the new `spawned[]` side-effect flag fails when the filter is broken (reviewer
  reasoned the mutation path from source: `{command:"x"}` passes
  `shellTool.inputSchema`, so the spawn tool would actually execute and fill the
  flag).
- Label/case drift is pinned: if `case "agent_task"` regressed to `"task"`, the
  fixture falls to `default` (raw name + raw JSON) and `"Agent find bug"` is
  absent → the render test fails.
- No protocol/wire change: tool names travel as free-form `title`/`rawInput`; no
  `task` literal in the protocol package.

**Findings raised (and dispositioned):**
1. **[REQUEST-CHANGES → fixed] Missed backticked prose.** The Implementation's
   "exhaustive grep" used the double-quoted literal `'"task"'`, which cannot see
   backticked `` `task` `` in comments. 8 such refs remained — one **user-facing**
   (`DEFAULT_CONFIG_JSONC` scaffolded into a new user's `config.jsonc`), the rest
   internal doc-comments. All 8 renamed; final backtick+quote grep returns
   nothing (modulo the intentional internal-identifier carve-out).
2. **[fixed] Verification overclaim.** The "exhaustive / exactly [list]" wording
   was corrected in Implementation to separate the *code* surface (double-quoted,
   truly exhaustive) from the *prose* surface (backticked, swept post-Review).
3. **[accepted residual] Gate coverage.** The forced-delegation evidence (6/6 per
   name, n=6, ~8 tools, single-turn, max_tokens 512) rules out the *catastrophic*
   mode (name drift to the prior-trained `task`, or a hard invocation break) but
   cannot measure a *soft* multi-turn/long-context/15-tool *preference* shift,
   because the neutral arm floors at 0/4 for both names. Worst case is a marginally
   lower delegation selection rate, **not** a correctness break (the filter strips
   the tool regardless of name). Owner-accepted; noted here as the honest limit of
   the gate. A 5/6 would have been within noise — the clean 6/6 vs 6/6 with zero
   drift is the signal relied on.

**Gate numbers (re-run by the implementing model after fixes):** `bun run check`
→ `tsc --noEmit` clean · `biome check .` 251 files, **0 errors / 0 warnings** ·
full test **650 pass / 1 skip (opt-in live-k8s) / 0 fail**. (The first reviewer
was read-only and could not re-run the suite itself; the counts above are the
implementing model's re-run post-fix, consistent with the reviewer's static
analysis.)

**Re-run (2026-10-17, fresh-context, general-purpose sub-agent with shell):**
**APPROVE-WITH-NITS.** Independently re-ran `bun run check` (same 650/1/0,
251 files, lint 0/0) and *empirically* re-verified test non-vacuity with
temporary mutations (reverted byte-exact, tree confirmed identical afterwards):
- filter disabled in `subagent.ts:153` → recursion test **FAILS**
  (`spawned` = `["{\"command\":\"x\"}"]` — the child executed the spawn tool);
- `case "agent_task"` reverted to `"task"` in `render-lines.ts:316` → render
  test **FAILS** (raw-name fall-through).
Exhaustive surface re-sweep (`"task"`, `` `task` ``, `\bTask\b` over
`packages/` + docs/README/AGENTS): **zero** remaining in-scope stale refs. Gate
evidence judged real and sufficient for the failure mode that mattered (zero
drift, clean 6/6 vs 6/6); residual soft multi-turn selection-rate risk remains
accepted (above). Nits found: two stale line citations in this doc
(`subagent.test.ts` `:125/:135` → actual `:126/:139`; as-built `task.ts :34`
→ `:33`) — **fixed in this edit**; the gate script's system prompt is a
near-verbatim default (noted above).

**How the implementing model behaved:** honest and §9-compliant on the critical
path — it *caught the pre-existing recursion test was vacuous* via mutation,
*strengthened* it, and flagged that as the one drift. Its self-verification
overstated completeness (double-quoted grep only), which the fresh-context review
correctly caught; the gap was closed without touching the load-bearing coupling,
the tool name, or the tests.

**Verdict: APPROVE** (post-fix). Ready to merge.
