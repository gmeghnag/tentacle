# feat/tool-naming — CamelCase display labels for every built-in tool (names in code unchanged)

> **Status:** feat — promoted 2026-10-22 (owner decided 2026-10-21: display-only labels). Implementation approved.
> **Branch:** `feat/tool-naming`
> **Type:** eval → feat · **Size:** S · **Blast:** contained (display only: no model-facing name, protocol, persistence or terminal-IO change) · **Suited:** any executor; standard Review
> **Umbrella:** [`extensibility.md`](../eval/extensibility.md) (child 1 of 5; goes **first**: `hooks-core`'s H1 line uses `toolLabel`)

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
| The built-in list (`agent_task` and `skill` are registered separately, in wiring) | `packages/tools/src/builtins.ts:303`; `packages/cli/src/wiring.ts:133` (builtins), `:166-168` (`skill`), `:199` (`agent_task`) |
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

*— claude-opus-5-5, 2026-10-22*

**Pre-check.** Load-bearing assumption held: `git grep -nE '"(Read|Write|Edit|Bash|Agent|Skill)"' packages/*/src`
matched only `tui/src/render-lines.ts:309-319` (subagent/permission-gate build
their strings with template literals, so they never compared a label either).

**Repro (before any edit, `.tentacle/tmp/tool-naming/repro.ts`, calls `toolTitle` + `describeToolCall`):**

```
{ label: "fs_multi_edit", subtitle: "{\"path\":\"a.ts\",\"edits\":[{},{}]}" }
{ label: "shell_output", subtitle: "{\"job_id\":\"j1\"}" }
Run fs_multi_edit
```

After: `{ label: "MultiEdit", subtitle: "a.ts · 2 edits" }`, `{ label: "BashOutput", subtitle: "j1" }`, `Run MultiEdit`.

**As-built, in plan order (each slice red → green on its narrow file):**

1. `core/src/tool-labels.ts` (new; `toolLabel` at :20) + `core/src/index.ts:16` export.
   Written first with only the 6 existing keys.
2. `core/test/tool-labels.test.ts` (new) and `tools/test/builtins.test.ts:370`
   (coverage over `builtinTools` + `agent_task`/`skill`). **Red:** coverage test
   reported `["fs_multi_edit","shell_output","shell_kill"]` unlabelled; core
   test `Expected "BashOutput" / Received "shell_output"`. Added the 3 keys → green.
3. `agent/test/permission.test.ts:189` — **red** `Expected "Run MultiEdit" /
   Received "Run fs_multi_edit"`; `agent/test/subagent.test.ts:223` — **red**
   `Expected "MultiEdit" / Received "fs_multi_edit"`. Then
   `agent/src/permission-gate.ts:51` and `agent/src/subagent.ts:114` → green.
4. `tui/test/render-lines.test.ts:370` — 3 of 4 tests **red** (the MCP-unchanged
   case passes on both, by design). Then `tui/src/render-lines.ts:307`: `toolTitle`
   returns `toolLabel(tool.name)` + a new private `toolSubtitle` (the per-tool
   `switch`) → green.

**Drift from Implementation:**

- Added a `childToolLabel` test in `agent/test/subagent.test.ts`. The plan said
  that file changes "only if a pinned string changes", but no test pinned
  `childToolLabel` at all, so the changed `default:` branch would have had no
  red/green proof (§9).
- `fs_multi_edit` subtitle uses the singular for one edit (`a.ts · 1 edit`);
  the plan wrote ` · N edits`. Malformed `edits` → `path` alone; non-JSON → `""`,
  as planned (both tested).
- Subtitle switch moved into a small helper `toolSubtitle` instead of staying
  inline in `toolTitle` (same behaviour; keeps `toolTitle` one line).
- `biome check --write` reformatted the `permission-gate.ts` import to multi-line.

**Gate:** `bun run check` green: typecheck clean, lint 0 errors / 0 warnings,
`1643 pass · 2 skip · 0 fail` (the 2 skips are the opt-in live-k8s and
slow-keepalive tests).

**Post-review fixes (2026-10-22):**

- `tui/test/render-lines.test.ts`: added the singular case (`edits:[{}]` → `a.ts · 1 edit`).
  Mutation check: forcing `edits` at `render-lines.ts:327` made it **red**
  (`Received "a.ts · 1 edits"`). Reverted → green.
- Context table: corrected the `wiring.ts` citation. The builtins
  `registerAll` is at `:133` on this tree (the review said `:132`), `skill` at
  `:166-168`, `agent_task` at `:199`.
- Links broken by the promotion: `docs/eval/extensibility.md:68,100,128` and
  `docs/eval/hooks-core.md:6,80` now point at `../feat/tool-naming.md`, and this
  doc's Umbrella line points at `../eval/extensibility.md`. A grep found no other
  broken `tool-naming.md` / `extensibility.md` links: the other eval children link
  `./extensibility.md` from within `docs/eval/`, which is valid.

## Review

*— claude-opus-5-5, 2026-10-22 (adversarial, fresh context; the executor was the same model in another fresh context, so blind spots we share survive both passes. That is acceptable for an S / contained task)*

**Verdict: APPROVE-WITH-NITS.** The code is correct and display-only. No model-facing name, protocol, persistence or terminal-IO path changed. Finding 1 is the only one that touches code, and it only adds a test.

**Findings**

1. **The singular "1 edit" drift is untested.** `packages/tui/src/render-lines.ts:327`. Execution says "(both tested)", but that covers only the malformed-args fallbacks. Mutating `n === 1 ? "edit" : "edits"` to `"edits"` left `render-lines.test.ts` at 25 pass / 0 fail. **Change:** in `render-lines.test.ts`, add `toolTitle(tool("fs_multi_edit", '{"path":"a.ts","edits":[{}]}'))` → `subtitle: "a.ts · 1 edit"`, and show it red under that mutation.
2. **A premise cites stale lines.** Context cites `cli/src/wiring.ts:131-135,172` for the registration of builtins, `agent_task` and `skill`. On this tree they are at `wiring.ts:132` (`registerAll(builtinTools)`), `:166-168` (`skill`) and `:199` (`agent_task`). The fact is true and the line numbers are wrong. **Change:** correct the citation.
3. **The relative links broke at promotion.** These links still point at `./tool-naming.md`, which no longer exists after the move to `docs/feat/`: `docs/eval/extensibility.md:68,100,128` and `docs/eval/hooks-core.md:6,80`. This doc's own Umbrella line links `./extensibility.md`, which lives in `docs/eval/`. This comes from commit db9746f, not from this diff. **Change:** use `../feat/tool-naming.md` and `../eval/extensibility.md`. This is a docs carve-out fix.
4. **Accepted, no change:** `tui/src/commands.ts:293`, the Markdown transcript export, still prints the raw `item.name`. The load-bearing grep searches for label literals, so it cannot find sites that *display* raw names. This site is a record, and the exact name is arguably the right thing there. Noted so that `hooks-core` does not assume every surface uses labels.

**Gate** (re-run myself): `bun run check` → tsc clean; biome "Checked 359 files … No fixes applied" (0/0); `1643 pass · 2 skip · 0 fail`, 5986 expects, 147 files. This matches Execution. The 2 skips are the opt-in tests.

**Premise table**

| Premise | Verdict |
|---|---|
| Symptom: the 3 tools render their raw name + JSON on `main` (`render-lines.ts:320-321`) | TRUE. `git show main:` shows the `default:` branch, and Execution's repro is consistent with it |
| `toolTitle` at `render-lines.ts:294` | TRUE |
| `childToolLabel` at `subagent.ts:93`, default = raw name | TRUE |
| `describeToolCall` at `permission-gate.ts:24`, default `Run ${tool.name}` | TRUE |
| `tui` and `agent` depend on `@tentacle/core`; `core` does not depend on `tools` | TRUE (package.json files) |
| `builtinTools` at `tools/src/builtins.ts:303` | TRUE |
| registration at `cli/src/wiring.ts:131-135,172` | FALSE on line numbers (finding 2) |
| `shell_output`/`shell_kill` take `job_id` (`background.ts:18-19`) | TRUE |
| Load-bearing: no code compares a label | TRUE. On this tree, `git grep` for every label literal in `packages/*/src` gives 0 hits; the map lives only in `core/src/tool-labels.ts` |

**Mutation non-vacuity** (each mutation reverted; afterwards `git diff` and the untracked-file hashes were byte-identical to before)
- `Object.hasOwn` → `name in TOOL_LABELS`: the core test fails ("an Object.prototype key is not a hit"). Holds.
- Removing the `fs_multi_edit` key fails 6 tests across all 5 test files (coverage, core, toolTitle ×2, childToolLabel, describeToolCall). Holds.
- `shell_output`/`shell_kill` subtitle → `tool.args`: the render-lines job-id test fails. Holds.
- Singular → always `"edits"`: **survives** (finding 1).

**Attacks tried**
1. *Prototype-key lookup* (`toString`, `constructor`): handled by `hasOwn`, and the mutation proves the test pins it. Nothing found.
2. *A display site the grep misses* (raw `item.name` / `tool.name` in `tui/src` and `client/src`): only the transcript export (finding 4). `client/remote-session.ts:318` keys `toolNames` on `update.title`, which is the daemon's tool title and not touched here. Nothing broken.
3. *Mixed-version or wire effect*: the permission `title` is built daemon-side and crosses RPC as an opaque string, so an older client just shows the new string. No schema change and no version bump needed. Nothing found.
4. *A new built-in added without a label*: the coverage test in `builtins.test.ts` goes red (mutation 2). The display degrades to the raw name, not to an empty string. Holds.
5. *Malformed `fs_multi_edit` args*: non-JSON gives `""`, and non-array `edits` gives the path alone. Both are tested, and neither can throw.

**End-to-end trace** (`.tentacle/tmp/tool-naming/review-e2e.ts`): the real `builtinTools` objects were run through `describeToolCall`, `childToolLabel` and `itemLines`:

```
fs_read        | Run Read         | Read a.ts    | ⏺ Read a.ts
fs_write       | Write a file     | Write a.ts   | ⏺ Write a.ts
fs_edit        | Edit a file      | Edit a.ts    | ⏺ Edit a.ts
fs_multi_edit  | Run MultiEdit    | MultiEdit    | ⏺ MultiEdit a.ts · 1 edit
shell          | Run a shell command | $ ls         | ⏺ Bash ls
shell_output   | Run BashOutput   | BashOutput   | ⏺ BashOutput bg-1
shell_kill     | Run BashKill     | BashKill     | ⏺ BashKill bg-1
```

Side effect, acceptable: `fs_read`'s generic permission title changes from "Run fs_read" to "Run Read".

**Judgement on the claimed drift**
- *Extra `childToolLabel` test*: **correct and required.** Without it the changed `default:` branch had no red/green proof (§9). It is non-vacuous (mutation 2).
- *"1 edit" singular*: **acceptable** as UX, but it is unpinned (finding 1).
- *`toolSubtitle` helper*: **acceptable.** It is a private pure function in the same module with identical behaviour, and every branch except the singular one is covered.
- *Biome reformatted the import*: **acceptable.** It is formatter-mandated (value and type imports mixed), with no semantic change. `subagent.ts` and `render-lines.ts` got the same treatment, which Execution did not mention. Harmless.

**What holds:** a single source of truth in `core`; names in code unchanged; `core` gains no dependency; MCP and unknown names fall back to themselves; red-first is documented per slice; the gate is green.

**How the executor behaved:** it followed the plan's order and recorded red output per slice. Its drift was small, reasoned and disclosed. One over-claim: "(both tested)" read as if the singular rule were covered, and it is not.

### Re-review

*— claude-opus-5-5, 2026-10-22 (same reviewer; the executor was the same model in a fresh context)*

**Verdict: APPROVE.** Findings 1–3 are resolved.

1. **Resolved.** The new test "fs_multi_edit with one edit uses the singular" is in `render-lines.test.ts`. Under the always-`"edits"` mutation it **fails** (25 pass / 1 fail). With the mutation reverted it passes, and the file is byte-identical (`cmp`).
2. **Resolved.** The executor's `wiring.ts:133` is the correct line for `registerAll(builtinTools)`. My `:132` in finding 2 was off by one. `:166-168` and `:199` are confirmed.
3. **Resolved.** `extensibility.md` and `hooks-core.md` now link `../feat/tool-naming.md`, and this doc's Umbrella line links `../eval/extensibility.md`. The remaining `./extensibility.md` in `hooks-core.md:6` is correct, because both files are in `docs/eval/`.

**Gate:** `bun run check`: tsc clean; biome 359 files, no fixes; **1644 pass · 2 skip · 0 fail** (+1 test is the new singular test).
