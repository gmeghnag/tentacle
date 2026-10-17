# eval/subagent-label-rename — relabel "Task" → "Agent" and rename the tool `task` → `agent_task`?

> **Status:** eval (Context + Review; direct-to-`main`, no branch; Implementation empty until promoted)
> **Prospective work (if promoted):** Type: `feat` · Size: S (mechanically — ~4 literals + the tool description + tests) · Blast: **load-bearing** (it changes the *model-facing* tool name/schema) · Suited: strong model executes + **mandatory fresh-context Review** per §10, and gated on an empirical weak-model check (below).

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

*(empty — an eval is not built until promoted to a `feat`.)*

## Execution

*(empty.)*

## Review

*— claude-opus-4-8, 2026-10-17 (recommendation; owner decides)*

**Recommendation: do it — label "Task" → "Agent" and tool `task` → `agent_task` —
but gate the tool rename on one cheap empirical check first.** `agent_task` is the
right name (keeps the prior, gains the clarity), and it removes the label↔name
"pezza" that a label-only change would leave. The only honest uncertainty is
weak-model invocation reliability, and that is testable.

- **Gate (run before promotion):** offer the local Qwen the tool renamed
  `agent_task` (same description) and have it perform a few real delegations.
  - **If it invokes `agent_task` as reliably as `task`** → promote and rename
    everything.
  - **If invocation degrades** → ship *label-only* ("Agent") and keep the tool
    `task`, documenting the mismatch as a deliberate weak-model-reliability
    choice (then it is a reasoned trade-off, not an un-owned pezza).
- **Scope of the rename (if the gate passes), in dependency order:** `task.ts:49`
  name + the description prose → `subagent.ts:139` `spawnToolName` default
  (`"task"` → `"agent_task"`) → `render-lines.ts:316` `case` + label "Agent" →
  update `render-lines.test.ts:129` (red-first: it fails on the new label before
  it is updated, proving the render path). Leave the internal `createTaskTool` /
  `TaskRunner` identifiers.
- **Failure modes to design out (for the plan):**
  1. **Nested-delegation regression** — the `spawnToolName` default must be
     renamed in lockstep, or children lose the no-nested-spawn guard. Add/confirm
     a test that a child's registry excludes the (renamed) spawn tool.
  2. **Label/case drift** — the `render-lines` `case` key must equal the new tool
     name or the friendly label silently falls through to the `default`
     (raw name). The existing render test guards this once updated.
- **Review level:** load-bearing (model-facing schema) → **mandatory
  fresh-context Review** per §10, which must include the weak-model invocation
  evidence, not just the gate being green.

**Promotion trigger:** on the owner's OK *and* a passing weak-model check, `git
mv` this doc to `docs/feat/subagent-label-rename.md` and open branch
`feat/subagent-label-rename`.

**What would change the recommendation:** the weak-model check showing a real
invocation drop → fall back to label-only (still ship "Agent" to the user, keep
`task` under the hood, documented).
