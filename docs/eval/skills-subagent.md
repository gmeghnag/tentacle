# eval/skills-subagent — launch a sub-agent with a skill already loaded

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted). Owner decisions Q1–Q8 below are open.
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval → feat · **Size:** S–M · **Blast:** load-bearing (a model-facing tool schema: `agent_task`; the sub-agent runner) · **Suited:** strong model executes; mandatory fresh-context Review; mandatory weak-model gate (as for the `agent_task` rename)

Sub-task 4 of 4 of `docs/eval/agent-skills.md`, which stays the umbrella
record. Its owner decision Q7 is the spec: *"a sub-agent can be launched
carrying a skill"*. The split item 4 sketched the shape: *"an optional `skill`
parameter on `agent_task` (an enum of the same names). The sub-agent starts
with that skill already activated. This changes a model-facing schema, so it
gets the same weak-model check as the `agent_task` rename."* This eval makes
that sketch concrete against the code as it is after `feat/skills-slash`, and
lists what is still for the owner to decide.

## Context

*— claude-opus-5-5, 2026-10-21*

### The question being decided

When the main agent delegates with `agent_task`, how does the sub-agent get a
skill's instructions, and who chooses which skill?

The short answer proposed here: **the parent passes only the skill's name**
(a structured `skill` argument on `agent_task`). **The sub-agent reads
`SKILL.md` itself** before its first model call, and the content goes into the
sub-agent's history as an already-completed `skill` round, as if it had called
the tool itself. The parent never copies the body into its prompt.

### State today (verified against `main` @ 33126b0)

| Fact | Evidence |
|---|---|
| `agent_task` takes `description`, `prompt`, `subagent_type`; nothing else survives parsing | `tools/src/task.ts:39-47`; repro below |
| The runner's contract carries no skill | `TaskRunner` opts `{ description, prompt, type }`, `tools/src/task.ts:23-26`; `SubagentRunOptions`, `agent/src/subagent.ts` |
| The child is a fresh `Agent` whose system prompt is its type's body, and it gets no skill activator | `agent/src/subagent.ts:162-170` (no `skills` field passed) |
| The child runs `child.run(id, [user prompt], signal)` | `agent/src/subagent.ts:175-179`; `Agent.run` takes no `RunOptions`, `agent/src/agent.ts:304-312` |
| **The seam already exists (from `feat/skills-slash`)**: `AgentConfig.skills` (the activator, the one path every activation takes) and `RunOptions.skill`, which writes a `skill` round (call + result) after the user message and **before** the first model round | `agent/src/agent.ts:86` (`RunOptions.skill`), `:365-369` (call site, before the loop), `:646` (`runUserSkill`) |
| The round sits outside the iteration loop, so it does not use up one of the child's `maxIterations` | `agent/src/agent.ts:365-369` is before the `for` loop |
| The wiring builds the activator **before** the sub-agent runner, in the same function | `cli/src/wiring.ts:156` (activator), `:166-188` (runner + `agent_task`) |
| The child gets the parent's result transforms, where `skill` is exempt from spill/summary (redaction kept), so a skill body reaches the child verbatim | `cli/src/wiring.ts:186` (`resultTransforms` passed to the runner); the exemption is `exemptTools([SKILL_TOOL_NAME], …)` in the same file |
| A child of a type with `tools: "all"` already gets the `skill` **tool** (the enum), but **not** the catalog: its system prompt is its own | `agent/src/subagent.ts:151-158`; `docs/feat/skills-core.md` Review, "Known limits" |
| Child progress (`subagent_start`/`subagent_tool`/`subagent_end`) is **not** sent over RPC: remote clients, and so the TUI (always over RPC, §7), see `agent_task` as one opaque tool call with the final report | `daemon/src/mapping.ts:173-183` (mapped to `null`) |
| User-defined sub-agent types are Markdown + frontmatter; the line-based parser already reads inline lists (`tools: [a, b]`) | `agent/src/agent-defs.ts:33-60,63-70` |
| Related open item: sub-agents do not receive AGENTS.md (same "what does a child's context start with" question) | `TODO.md:897-904` |

**Repro (2026-10-21, `main` @ 33126b0, from the repo root):**

```
$ cat .tentacle/tmp/skills-subagent/repro.ts
import { createTaskTool } from "@tentacle/tools";

const tool = createTaskTool(async () => ({ report: "", toolUses: 0, stopReason: "end_turn" }), [
  { name: "general-purpose", description: "g" },
]);
const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
console.log("agent_task params:", Object.keys(shape).join(","));
const parsed = tool.inputSchema.parse({ description: "d", prompt: "p", skill: "deploy-app" });
console.log("a `skill` argument survives parsing:", "skill" in (parsed as object));

$ bun .tentacle/tmp/skills-subagent/repro.ts
agent_task params: description,prompt,subagent_type
a `skill` argument survives parsing: false
```

So today a parent that wants a sub-agent to follow a skill can only paste the
body into `prompt`: tokens spent twice, the body rewritten by the parent model
(a weak model may summarise or cut it), and nothing in the child recognises it
as a skill.

### Proposed shape

**Flow, step by step:**

1. The parent model calls
   `agent_task({ description, prompt, subagent_type?, skill: "deploy-app" })`.
   `skill` is an enum: a model cannot invent a name.
2. The `agent_task` tool passes `skill` to the runner, next to `type`.
3. The runner builds the child `Agent` **with the parent's activator**
   (`AgentConfig.skills`) and starts it with `RunOptions.skill`.
4. Before the child's first model call, its own loop writes the `skill` round:
   the activator reads `SKILL.md` through the child's execution environment
   (the parent's env: on a pod, the pod's filesystem), formats it
   (`<skill_content name=…>` + directory + bundled-file list, ≤ 50 000 chars),
   runs it through the result transforms (redacted, never spilled), and pushes
   the call and the result.
5. The child's first request is:
   `[system: type prompt] [user: the parent's prompt] [assistant: skill call] [tool: skill content]`.
   It then works as usual and returns its report. The parent sees only the
   report, as today.

**Code, in dependency order (smallest diff):**

- `tools/src/task.ts` — `createTaskTool(run, types, skills?: readonly string[])`:
  when `skills` is non-empty, the schema gains
  `skill: z.enum(skills).optional().describe(…)` and the description gains one
  sentence. When empty, the schema and the description stay **byte-identical**
  to today (no skills → nothing changes for the model). `TaskRunner` opts gain
  `skill?: string`.
- `agent/src/subagent.ts` — `SubagentDeps.skills?: SkillActivator`;
  `SubagentRunOptions.skill?`; the child gets `skills: deps.skills` and runs
  with `{ skill }`. `childToolLabel` gains `skill` → `Skill <name>` (only
  visible where child progress is rendered: today not over RPC, see the table).
- `agent/src/agent.ts` — `Agent.run(…, opts?: RunOptions)` passes `opts` on.
  `runUserSkill` is renamed (e.g. `runPreloadedSkill`), since the user and the
  parent model both use it now. Who may ask for what stays outside the loop:
  `canActivateForUser` for `/name`, the `agent_task` enum for the model.
- `cli/src/wiring.ts` — pass the activator to `createSubagentRunner`, and the
  offered names (`offeredSkills(config.skills)`, the same list as the `skill`
  tool's enum) to `createTaskTool`.
- Tests, `docs/architecture/skills.md` ("Where it runs" → Sub-agents),
  `README.md`.

**Unchanged:** the protocol (child progress does not cross the wire; the
parent's history only stores the `agent_task` call, with `skill` in its
arguments), the persisted format, compaction (a child is one-shot, its history
dies with it), the permission path (the child keeps the parent's requester; a
skill grants nothing, `allowed-tools` stays ignored).

### Alternatives considered

- **(A) The parent pastes the body into `prompt`.** Already possible, so no
  work. Rejected as *the* mechanism: double tokens, the body goes through the
  parent model (paraphrase, truncation), no marker, no exemption from the
  transforms. It stays possible.
- **(B) Give the child the catalog (and the `skill` tool) and let it decide.**
  This answers a different question: what a child's context starts with. It
  belongs with the open "Subagents don't receive AGENTS.md" TODO. It does not
  meet Q7 (the *parent* launches the child *carrying* a skill): the child of a
  weak model may never load it.
- **(C) A `skills:` list in a sub-agent type's frontmatter** (type-level: every
  run of that type starts with them). Claude Code has this: the `skills` field
  of a sub-agent definition preloads the full skill content at startup (its
  docs, "preload skills into subagents"; a June 2026 issue reports a case where
  it did not inject, so treat that client's behaviour as unverified). It fits
  "this reviewer type always follows our review skill". It is **complementary**,
  not a replacement: it uses the same runner path (a type's list + the call's
  `skill`). The parser already reads inline lists (`agent-defs.ts:49-54`).
  Proposed as a follow-up, see Q1.
- **(D) Automatically pass the parent's active skills.** Rejected as a default:
  it breaks the child's isolation (the point of `agent_task` is a clean
  context), it costs up to 100 000 chars per child, and the parent's skill is
  often not the child's job. Explicit beats implicit.

### Decisions needed (with a recommendation each)

**Q1 — Who chooses the skill?** (a) per call, the parent model (`skill` on
`agent_task`); (b) per type, `skills:` in the type's frontmatter; (c) both.
*Recommended: (a) now*, which is what Q7 asks. (b) as a small follow-up
(S, contained) if the owner wants typed reviewers/executors with fixed skills.

**Q2 — One skill or several?** (a) `skill: enum` (one); (b) `skills: enum[]`.
*Recommended: (a)*. One structured choice is what a weak model fills
reliably; the gate for the `agent_task` rename showed the value of keeping the
schema small. Several skills = several rounds; easy to widen later. Widening
is additive for the model-facing schema.

**Q3 — Which skills can the parent pass?** *Recommended: exactly the model's
offered list* (`offeredSkills`, the catalog and `skill` enum): a skill hidden
from the model (`disable-model-invocation`) stays reserved to the user's
`/name` (eval decision 5). The enum is the gate; the runner does not need a
second check (the activator answers an unknown name with an error result
anyway).

**Q4 — A type with restricted tools** (built-in `explore` has only
`fs_read`; a user type may list a few tools). A skill may ask for `shell`.
(a) allow it; (b) refuse at the tool level; (c) allow, and say in the `skill`
parameter's description that the child only has its type's tools.
*Recommended: (c)*. The harness cannot know which tools a skill needs
(`allowed-tools` is ignored on purpose, Q5 of the umbrella eval). Refusing
would block a read-only skill used by `explore`. The child reports what it
could not do.

**Q5 — `SKILL.md` unreadable when the child starts** (deleted since
discovery; on a future pod sub-agent, a different filesystem). The child's
round carries the error result and the child goes on. The risk is a **silent
drop**: the parent never sees the child's history, and the child's report may
not mention it. *Recommended:* the runner reads the round's result (it is the
first `tool_result` event of the child) and, when it is an error, **prefixes
the report** with one line: `(skill "x" could not be loaded: <reason>)`. The
parent model and the user then see it.

**Q6 — Parameter name and description.** *Recommended:* `skill`, described as
"Load this skill into the sub-agent before it starts (from the Skills list).
The sub-agent follows it with its own tools." Model-facing → the weak-model
gate decides; fall back to `preload_skill` only if the gate shows confusion
with the `skill` tool.

**Q7 — Should a child also get the catalog / `skill` tool?** Out of scope
here. Today an `all`-tools child gets the tool without the catalog (a known
limit from `skills-core`). Decide it with the AGENTS.md TODO (`TODO.md:897`),
since both are about what a child's context starts with.

**Q8 — What the user sees.** The TUI shows `agent_task` as one call with the
report (child progress does not cross RPC, `daemon/src/mapping.ts:173-183`).
*Recommended:* show the skill in the `Agent` row's subtitle (from the
`agent_task` arguments, `tui/src/render-lines.ts` `toolTitle`, e.g.
`Agent deploy staging · skill deploy-app`). That needs no protocol change,
since the arguments already travel with the tool call.

### Failure modes (for the Implementation to keep)

- **No offered skills** → no `skill` parameter; `agent_task` schema and
  description byte-identical to today (pinned by a test).
- **Unknown name** (a model sends a name off the enum) → zod rejects the call
  at the registry with the valid list, as for every enum; nothing runs.
- **`SKILL.md` unreadable** → the error result in the child's round, plus the
  report prefix (Q5). Never silent.
- **Cancel during the read** → the round answers `Cancelled…` (existing
  `runUserSkill` behaviour), the child ends `cancelled`, the parent gets the
  existing `(sub-agent cancelled)` note (`tools/src/task.ts:61-66`).
- **Big skill** → ≤ 50 000 chars in the child's context (the tool's cap). It
  counts against the child's context window, not the parent's. Not spilled
  (exempt), still redacted.
- **Restricted type** → allowed (Q4); the child says what it could not do.
- **Pod (`run`/`attach`)** → the enum is the pod's skills, the read is on the
  pod's filesystem; the laptop is not involved (umbrella Q4).
- **Daemon restart during a child run** → the parent's `agent_task` call is
  unanswered → closed honestly on reload, as any interrupted tool call
  (`daemon/src/persisted-session.ts` `trailingCalls`). The child is never
  resumed.
- **Interaction with `docs/eval/subagent-in-pod.md`** (if ever built): a child
  running in *another* pod would read `SKILL.md` on that pod, where the
  location from the parent's discovery may not exist → the Q5 path (loud).
  That eval must decide whether to ship the skill with the child.
- **Interaction with `docs/eval/parallel-subagents.md`**: none specific: each
  child reads its own copy; the activator is stateless.

### Tests (sketch, for the Implementation)

- `tools/test`: the schema has `skill` only when skills are offered, as an enum;
  the description is byte-identical without skills; the runner receives
  `skill`.
- `agent/test/subagent.test.ts`: the child's FIRST model request already holds
  `<skill_content name="x">` after the parent's prompt (capture a copy of
  the messages, not the live array); without `skill`, the request is unchanged;
  read failure → report prefixed (Q5); cancel during the read → `cancelled`;
  the round does not use up an iteration (`maxIterations: 1` still gets one
  model round).
- `cli/test/wiring.test.ts`: end to end with the real `buildAgent`, a temp
  skill tree and a scripted model: the parent calls `agent_task{skill}`, the
  child's request carries the body; a hidden skill is not in the enum.
- Mutations (§9): runner drops `skill` → the first-request test fails;
  `agent_task` drops the enum → the unknown-name test fails; no report prefix
  → the Q5 test fails.
- **Weak-model gate (mandatory):** local Qwen3.8-27B, the real `buildAgent`,
  prompts like "Delegate the staging deploy to a sub-agent" with a matching
  skill, an unrelated delegation, and a non-delegation task, 3 runs each.
  Pass = matching delegations set a valid `skill`; unrelated ones do not;
  no regression in `agent_task` invocation. (The `skills-slash` gate could not
  run: the endpoint was down. This one must, or the task waits.)

## Implementation

*(empty until promoted — AGENTS §10)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-21 (the author, in context; not an independent review)*

**Verdict: recommended for promotion as one feat** (`feat/skills-subagent`,
S–M, load-bearing because of the model-facing schema), once the owner answers
Q1–Q8. Recommended answers: Q1 (a), Q2 (a), Q3 offered list, Q4 (c), Q5
report prefix, Q6 `skill`, Q7 out of scope, Q8 subtitle.

Why it is small: every hard part already exists and is tested. The activator
and the pre-loop round (`feat/skills-slash`) handle reading, formatting,
redaction, the spill exemption, cancel and errors; the runner only has to hand
them to the child. The only new risk is the weak model's use of one more
optional argument, which is what the mandatory gate measures.

Not verified here: how a weak model fills the new argument (the gate), and
whether the TUI subtitle (Q8) fits the row width with long descriptions.
