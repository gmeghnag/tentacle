# eval/tool-naming — CamelCase display labels for every built-in tool (names in code unchanged)

> **Status:** eval — **decided by the owner 2026-10-21** (display-only labels). Implementation drafted below, approved at promotion.
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promote to `feat/tool-labels`.
> **Type:** eval → feat · **Size:** S · **Blast:** contained (display only: no model-facing name, protocol, persistence or terminal-IO change) · **Suited:** a weaker model may execute (§10: contained, S); standard Review
> **Umbrella:** [`extensibility.md`](./extensibility.md) (child 1 of 5; goes **first**: `hooks-core`'s H1 line uses `toolLabel`)

## Context

*— claude-opus-5-5, 2026-10-21*

### The question, and the decision

Should built-in tools be renamed to CamelCase (`Bash`, `Read`, `Edit`, …)
in code as well (the model-facing name), or only in what the user sees?

**Decision (owner, 2026-10-21): display only.** The names in code, which are
also what the model sees and what hook matchers and agent-definition `tools:`
lists use, **stay exactly as they are**. Every built-in tool gets a speaking
CamelCase **label**, shown in the TUI, in permission prompts and in
sub-agent progress lines, from **one** shared map.

### Why not the full rename (record of the discussion)

- The full rename was first approved for "one name everywhere", then
  withdrawn by the owner. It changes the model-facing schema (load-bearing,
  weak-model gate, persisted sessions) and has two correctness couplings:
  the delegation filter `agent/src/subagent.ts:139` and the skill-history
  scan `tools/src/skill.ts:91`.
- Its supposed model benefit ("harnesses use `Read`/`Edit`/`Bash`, so models
  know those names") **did not hold up** when checked on 2026-10-21:
  - PascalCase is mainly Claude Code's convention;
  - OpenCode and pi use lowercase `read`/`write`/`edit`/`bash`;
  - Codex CLI uses `shell`/`apply_patch`;
  - Qwen Code, the official harness of the Qwen models in our mix, uses
    `read_file`/`write_file`/`edit`/`run_shell_command`.

  For our weak model the prior, if any, points elsewhere.
- A `tool_` prefix on the names in code was considered and rejected. It is a
  model-facing rename too, it adds tokens without information, and MCP tools
  (`mcp__…`) would not follow it. Readable logs are a log-format concern
  (`tool=fs_read`), not a name change.

### State today (verified against `main` @ 399ea0b)

| Fact | Evidence |
|---|---|
| The TUI maps names to labels in `toolTitle`: `fs_read`→Read, `fs_write`→Write, `fs_edit`→Edit, `shell`→Bash, `agent_task`→Agent, `skill`→Skill | `packages/tui/src/render-lines.ts:294-323` |
| `fs_multi_edit`, `shell_output`, `shell_kill` (and MCP tools) fall to `default:` → label = raw name, subtitle = the raw JSON args | `packages/tui/src/render-lines.ts:320-321` |
| A **second** label map exists for sub-agent progress lines (`childToolLabel`: `$ <cmd>`, `Read <path>`, `Write <path>`, `Edit <path>`, else the raw name) | `packages/agent/src/subagent.ts:93-115` |
| Permission prompts have dedicated titles for `shell` / `fs_write` / `fs_edit`; everything else is `Run ${tool.name}` (e.g. "Run fs_multi_edit") | `packages/agent/src/permission-gate.ts:24-48` |
| `tui` and `agent` both depend on `@tentacle/core`; `core` exports its modules from `core/src/index.ts` | `packages/tui/package.json`, `packages/agent/package.json`, `packages/core/src/index.ts:8-16` |
| The built-in list (`agent_task` and `skill` are registered separately, in wiring) | `packages/tools/src/builtins.ts:303`; `packages/cli/src/wiring.ts:131-135,172` |
| `shell_output` / `shell_kill` take `job_id` | `packages/tools/src/background.ts:18-19` |

**Repro (2026-10-21, `main` @ 399ea0b):** the three tools without a label
render with their raw name and raw JSON:

```
$ git show main:packages/tui/src/render-lines.ts | sed -n 307,322p
  switch (tool.name) {
    case "fs_read":
      return { label: "Read", subtitle: str("path") ?? "" };
    ...
    case "skill":
      return { label: "Skill", subtitle: str("name") ?? "" };
    default:
      return { label: tool.name, subtitle: tool.args };
```

## Implementation

*— claude-opus-5-5, 2026-10-21 (draft; approved at promotion)*

### Load-bearing assumption

Labels are **display only**: no code path *compares* a label. Only
`toolTitle`, `childToolLabel` and `describeToolCall` produce them, and all
three just return strings for display (`render-lines.ts:294`,
`subagent.ts:93`, `permission-gate.ts:24`). Verify before editing:
`git grep -nE '"(Read|Write|Edit|Bash|Agent|Skill)"' packages/*/src` must
show only those three files.

### Preconditions

- `core` has no dependency on `tools` (it must not gain one): the map is a
  plain `Record<string, string>` keyed by name literals.
- The TUI test harness strips SGR (AGENTS §7), so label tests compare plain
  text.

### Design

The single source of truth, `packages/core/src/tool-labels.ts`:

```ts
/**
 * Display labels for built-in tools (TUI, permission prompts, sub-agent
 * progress). DISPLAY ONLY: the tool's name — what the model calls, what hook
 * matchers and agent-def `tools:` lists use — is unchanged. Unknown names
 * (MCP tools, future tools) display as their name.
 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  shell: "Bash",
  shell_output: "BashOutput",
  shell_kill: "BashKill",
  fs_read: "Read",
  fs_write: "Write",
  fs_edit: "Edit",
  fs_multi_edit: "MultiEdit",
  agent_task: "Agent",
  skill: "Skill",
};

export function toolLabel(name: string): string {
  return Object.hasOwn(TOOL_LABELS, name) ? (TOOL_LABELS[name] as string) : name;
}
```

(`Object.hasOwn` so a name like `toString` is not a hit. `agent_task` keeps
its existing label "Agent".)

Consumers:

| Consumer | Change |
|---|---|
| `tui/src/render-lines.ts` `toolTitle` | `label` always `toolLabel(tool.name)`; the `switch` keeps only the **subtitle** per tool. New subtitles: `fs_multi_edit` → `path` + ` · N edits` (N = `edits.length` when it is an array); `shell_output` / `shell_kill` → `job_id`. `default:` stays `tool.args` |
| `agent/src/subagent.ts` `childToolLabel` | keep the exact existing strings for `shell` (`$ <cmd>`) and the three fs tools; `default:` becomes `toolLabel(name)` |
| `agent/src/permission-gate.ts` `describeToolCall` | `default:` title becomes `` `Run ${toolLabel(tool.name)}` ``; the three dedicated titles are unchanged |

Export: add `export * from "./tool-labels.ts";` to `core/src/index.ts`.

### Files (dependency order)

1. `packages/core/src/tool-labels.ts` (new) + `packages/core/src/index.ts`
2. `packages/core/test/tool-labels.test.ts` (new)
3. `packages/agent/src/permission-gate.ts`, `packages/agent/src/subagent.ts`
4. `packages/tui/src/render-lines.ts`
5. tests: `packages/tools/test/builtins.test.ts`, `packages/tui/test/render-lines.test.ts`, `packages/agent/test/subagent.test.ts` (only if a pinned string changes; it should not)

### Failure modes

| Case | Convergence |
|---|---|
| A new built-in tool is added without a label | displays its raw name (today's behaviour), never blank; the coverage test below fails, so it is caught in CI |
| A name that is an `Object.prototype` key (`toString`) | `Object.hasOwn` → raw name |
| MCP tools | no entry → raw `mcp__server__tool`, unchanged |
| `fs_multi_edit` with malformed args (not JSON, `edits` not an array) | subtitle falls back to `path` alone (or `""`); never throws (`toolTitle` already catches JSON errors, `render-lines.ts:296-303`) |
| A user writes a hook matcher with a label (`"Edit"`) | out of scope here; `hooks-core` documents that matchers use names |

### Tests (red before green, §9)

- `core/test/tool-labels.test.ts`: every key maps as in the table;
  `toolLabel("mcp__x__y") === "mcp__x__y"`; `toolLabel("toString") === "toString"`.
- `tools/test/builtins.test.ts`: for every `builtinTools` name, plus
  `"agent_task"` and `"skill"`, `toolLabel(name) !== name`. **Red first:**
  write it before adding the three new keys and see it fail on
  `fs_multi_edit` / `shell_output` / `shell_kill`.
- `tui/test/render-lines.test.ts`: a `fs_multi_edit` item renders `MultiEdit`
  + path + ` · 2 edits`; a `shell_output` item renders `BashOutput` + the job
  id. Red first: today they render the raw name and JSON.
- A `describeToolCall` test (add to `agent/test/permission.test.ts`): an
  `fs_multi_edit` tool's request title is `Run MultiEdit`. Red first.

Gate: `bun run check` green (typecheck → lint → test).

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-21*

Self-review. Small, display-only, contained. The one design choice is moving
the label map into `core`, so the TUI, permission prompts and sub-agent lines
agree instead of keeping three partial maps. Promotion-ready.
