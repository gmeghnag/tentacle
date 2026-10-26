# feat/skills-core — Agent Skills: discovery, catalog, `skill` tool

> **Status:** done — merged to `main` 2026-10-20 (owner OK)
> **Branch:** `feat/skills-core`
> **Type:** feat · **Size:** M · **Blast:** cross-module (config, tools, agent result pipeline + one additive `ToolContext` field, cli wiring; no protocol / persistence change) · **Suited:** strong model; owner waived the fresh-context Review for this sub-task (token budget, 2026-10-20) → in-context adversarial Review

Sub-task 1 of 4 of `docs/eval/agent-skills.md` (the eval stays the umbrella
decision record for all four; its owner decisions are the spec here).

## Context

*— claude-opus-5-5, 2026-10-20*

tentacle ignores Agent Skills (`SKILL.md`, <https://agentskills.io/specification>):
the user already has `~/.agents/skills/hf-cli` installed and it is never seen.
This task delivers the first usable slice, per the eval's owner decisions:

- discovery in three scopes, first hit wins, a shadowed skill reported
  (Q1): project `.agents/skills/` walking up from the **launch cwd** to the
  `.git` root (decision 4), user `<configDir>/skills/`, user `~/.agents/skills/`.
  No `.claude/skills/`;
- lenient parse with `Bun.YAML` (Q8), the catalog (name + description) in the
  system prompt under `# Skills` after AGENTS.md (Q2), byte-identical prompt when
  there are none;
- a dedicated `skill` tool, `name` an enum (Q2), returning
  `<skill_content name=…>` + the skill directory + the bundled-file list,
  deduplicating an already active skill;
- `disable-model-invocation: true` hides a skill from catalog and enum
  (decision 5); `allowed-tools` ignored with a warning (Q5);
- off switch `loadSkills: false` / `TENTACLE_NO_SKILLS` (Q8); the catalog is
  built at start, a new skill needs a restart (decision 3) — or, for the model,
  a context reset (`docs/feat/context-reset.md`); pods and `connect`
  see the daemon host's skills (Q4, decision 2) — this falls out of discovery
  running inside `loadConfig` of the process that builds the agent.

Out of scope (sub-tasks 2–4): compaction re-injection, `/skill-name`, `agent_task`
carrying a skill.

**Repro (2026-10-20, `main` @ dbf424d, from the repo root):**

```
$ cat .tentacle/tmp/skills-core/repro.ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@tentacle/config";
import { buildAgent } from "../../../packages/cli/src/wiring.ts";

const home = await mkdtemp(join(tmpdir(), "skills-repro-"));
const repo = join(home, "repo");
await mkdir(join(repo, ".git"), { recursive: true });
await mkdir(join(repo, ".agents/skills/deploy-app"), { recursive: true });
await writeFile(
  join(repo, ".agents/skills/deploy-app/SKILL.md"),
  "---\nname: deploy-app\ndescription: >-\n  Deploy the app\n  to staging.\nmetadata:\n  author: x\n---\nRun ./deploy.sh\n",
);
const cfg = await loadConfig({ env: { HOME: home }, configDir: join(home, "cfg"), cwd: repo });
console.log("prompt mentions deploy-app:", cfg.systemPrompt.includes("deploy-app"));
const { tools } = buildAgent({ ...cfg, subagentsEnabled: false });
console.log("tools:", tools.definitions().map((d: { name: string }) => d.name).join(","));

$ bun .tentacle/tmp/skills-core/repro.ts
prompt mentions deploy-app: false
tools: fs_read,fs_write,fs_edit,fs_multi_edit,shell,shell_output,shell_kill
```

## Implementation

*— claude-opus-5-5, 2026-10-20*

### Load-bearing assumption

**A skill body returned by the `skill` tool reaches the model verbatim.** It does
NOT today: every tool result goes through the configured transforms
(`agent/src/agent.ts:499,540-562`), which collapse repeated lines, tabulate JSON,
and spill anything over `maxInlineOutputChars` (default 16000,
`config/src/defaults.ts:27`) to a file — or replace it with an LLM summary
(`cli/src/wiring.ts:97-108`). `hf-cli`'s body is ~32 KB: it would arrive as a
head/tail preview, i.e. the skill silently would not load. So the design must
exempt the `skill` result from the size-shaping transforms (keeping redaction,
a safety layer) and bound the body itself.

### Preconditions

- The system prompt is composed once, purely, in `resolveConfig`
  (`config/src/resolve.ts:208-215`); I/O lives in `load.ts` (`:218-237`). The
  AGENTS.md walk (`load.ts:97-115`) is the precedent for the project walk.
- `TentacleConfig` is structured-cloned to the worker (`cli/src/local-runtime.ts`
  `worker.postMessage(config)`), so skill records must be plain data.
- Every runtime builds its agent through `buildAgent` (`cli/src/wiring.ts:77`);
  the pod daemon loads its own config in the pod (`cli/src/main.ts:228`, scaffold
  off), and the laptop's `systemPrompt` is never sent to a pod (no use in
  `pod-runtime.ts`) — so pods see only pod skills (Q4) with no extra code.
- A transform sees `ctx.toolName` (`agent/src/result-pipeline.ts:16-27`) — the
  seam for a per-tool exemption, no core change.
- `ToolContext` carries no history (`core/src/tool.ts:45-53`); the loop has the
  live `messages` at hand when it builds it (`agent/src/agent.ts:228-233`).
  Dedup must be derived from the history (the eval's sub-task 2 rule: which
  skills are active is derived, not stored), so an additive optional
  `history` field is needed.
- `fs_read` is permission-free and unconfined (`tools/src/builtins.ts:72-76`),
  so the model can read bundled files the tool lists.
- `Bun.YAML.parse` parses real frontmatter; `parseFrontmatter` does not (eval repro).

### Design

1. **Pure module `config/src/skills.ts`** (no I/O): `splitFrontmatter`,
   `parseSkillManifest(text, dirName)` (lenient: a name problem warns and
   loads — a missing name falls back to the directory name; no/empty
   description, missing or unparseable YAML → skipped with a reason),
   `mergeSkills(candidates)` (precedence order in, first hit wins, shadowing
   reported), `renderSkillsCatalog(skills)` (model-invocable only; `""` when
   none; capped at `MAX_CATALOG_SKILLS` = 100 with a diagnostic; text escaped
   for the XML-ish tags).
2. **I/O `config/src/skills-scan.ts`**: `skillRoots(launchCwd, home, configDir)`
   (project walk: collect every `<dir>/.agents/skills` from the cwd up, stop
   after the `.git` dir, at the fs root, or *before* `home` — `~/.agents/skills`
   is the user scope, never a "project" one; then `<configDir>/skills`,
   `~/.agents/skills`; duplicate roots dropped by real path) and
   `scanSkills(roots)`: one level of `<root>/<name>/SKILL.md` (symlinked dirs
   followed), ≤ 200 dirs per root, bundled-file list ≤ 50 entries, depth ≤ 4,
   skipping dot-entries and `node_modules`. Unreadable → diagnostic, never a crash.
3. **Config**: schema `loadSkills?: boolean` (profiles inherit it); pure
   `skillsEnabled(fileConfig, env)` (`TENTACLE_NO_SKILLS` truthy wins, like
   `TENTACLE_NO_AGENTS_MD`); `load.ts` scans only when enabled; `resolveConfig`
   appends the catalog after AGENTS.md. `TentacleConfig` gains
   `skills: SkillInfo[]` (all, incl. hidden ones — sub-task 3 needs them) and
   `skillDiagnostics: string[]`.
4. **`tools/src/skill.ts`**: `createSkillTool(skills, readBody)` → `Tool | undefined`
   (undefined when no model-invocable skill). Input `{ name: enum }`. The body
   is read **at activation** through the injected `readBody` (wiring:
   `ctx.env.readFile(location)` + `splitFrontmatter`), so an edited body is
   picked up without a restart; the file list is from discovery. Output:
   `<skill_content name="x">` body, `Skill directory: …`, `<skill_resources>`
   list, `</skill_content>`. Body capped at `MAX_SKILL_BODY_CHARS` = 50 000,
   cut on a line boundary, with a note naming the exact `fs_read path:line`
   to continue from. `activeSkillNames(history)` (exported, reused by sub-task 2):
   a skill is active iff a `skill` tool call's result in the history starts with
   its `<skill_content name="…">` marker. Already active → a short note, not
   the body again. Read failure → `isError` result.
5. **Exemption**: `exemptTools(names, transform)` in `result-pipeline.ts`; wiring
   wraps dedup, tabulate and the large-output transform with
   `exemptTools([SKILL_TOOL_NAME], …)`. Redaction still applies.
6. **History in `ToolContext`**: `history?: readonly ChatMessage[]`, set by the
   loop to the live `messages`.
7. **cli**: register the tool in `buildAgent`; print `config.skillDiagnostics`
   right after `loadConfig` (before any Ink mount) for the modes that build an
   agent locally — TUI, plain, one-shot, `serve` (stderr for `serve --stdio`,
   whose stdout is the RPC channel). Not for `run`/`attach`/`connect`, whose
   laptop config does not build the agent.
8. **TUI label**: `skill` renders as `Skill <name>` (`tui/src/render-lines.ts:316`).

### Files

`config/src/{skills.ts,skills-scan.ts,schema.ts,resolve.ts,load.ts,index.ts}` →
`core/src/tool.ts` → `agent/src/{agent.ts,result-pipeline.ts}` →
`tools/src/{skill.ts,index.ts}` → `cli/src/{wiring.ts,main.ts}` →
`tui/src/render-lines.ts` → `README.md`.

### Failure modes

- **No skills / disabled** → no scan (disabled), no tool, prompt byte-identical.
- **Broken SKILL.md** (bad YAML, no description) → skipped + diagnostic; others load.
- **Name mismatch / bad chars / too long description** → warning, still loads.
- **Collision** → nearest project wins, then config dir, then `~/.agents`; the
  loser is named in a diagnostic.
- **Huge tree / symlink loop** → per-root dir cap, file-list cap + depth cap;
  the walk is bounded (40 steps).
- **Skill deleted/unreadable after start** → `isError` "could not read", the
  model is told; no crash.
- **Huge body** → capped with an exact continuation pointer; never spilled or
  summarised.
- **Repeated activation** → dedup note; after `/compact` (history rebuilt) the
  skill is no longer active, so re-activation works (until sub-task 2 re-injects).
- **Unknown name from a weak model** → zod enum rejects it at the registry
  with the valid list in the error.
- **Pod** → discovery runs in the pod; laptop skills never sent (Q4).

### Tests

- `config/test/skills.test.ts` (pure): parse leniency table (folded
  description, nested `metadata` not leaking, missing name, mismatch, bad YAML,
  no description, `disable-model-invocation`, `allowed-tools` warning),
  precedence/shadowing, catalog empty → `""`, escaping, cap.
- `config/test/load.test.ts`: temp tree with project (two levels) + config dir
  + `~/.agents` → precedence, home not scanned as project, off switch (file +
  env), prompt byte-identical with no skills, file listing bounds.
- `tools/test/skill.test.ts`: enum schema, output shape, dedup from history
  (and not after a non-marker error result), read error, truncation pointer.
- `agent/test/result-pipeline` exemption: the spill transform leaves an exempt
  tool's long result intact, still spills another tool's.
- `agent` loop: a tool sees `ctx.history` with the prior messages.
- `cli/test/wiring.test.ts`: skill tool registered only with skills; an exempt
  32 KB body survives the real wired transforms end-to-end (the load-bearing
  assumption) — red before the exemption is wired.
- Weak-model check (Qwen3.8-27B) on the tool's invocation.

## Execution

*— claude-opus-5-5, 2026-10-20*

Built in plan order; repro re-run green after (`prompt mentions deploy-app: true`,
`tools: …,skill`).

- `config/src/skills.ts` (pure) and `config/src/skills-scan.ts` (I/O);
  `schema.ts` `loadSkills`; `resolve.ts` `skillsEnabled` + catalog after
  AGENTS.md; `load.ts` scan → `mergeSkills` → `TentacleConfig.skills` /
  `skillDiagnostics`.
- `core/src/tool.ts` `ToolContext.history?`; `agent/src/agent.ts` sets it to the
  live `messages`; `agent/src/result-pipeline.ts` `exemptTools`.
- `tools/src/skill.ts` `createSkillTool` / `activeSkillNames` / `formatSkillContent`.
- `cli/src/wiring.ts`: dedup/tabulate/large-output wrapped with
  `exemptTools([SKILL_TOOL_NAME], …)`, redaction not; the tool registered from
  `offeredSkills(config.skills)`, body read via `ctx.env.readFile` +
  `splitFrontmatter`. `cli/src/main.ts`: `[skills] …` to `writeErr` (stderr)
  after `loadConfig`, skipped for `run`/`attach`. `tui/src/render-lines.ts`:
  `Skill <name>`. `README.md`: config row + feature line.

**Drift from Implementation (and why):**
- `offeredSkills` added to `skills.ts`: one rule for catalog AND enum, so a
  capped catalog can never disagree with the tool (found while writing the cap).
- `SkillInfo.filesTruncated: boolean` instead of an omitted-file count: an
  exact count would need an unbounded walk.
- Diagnostics go to a new `CliIO.writeErr` (stderr), not `write` (stdout): a
  one-shot's stdout is the answer and `serve --stdio`'s stdout is the RPC
  channel.
- `@types/bun` 1.1.14 does not declare `Bun.YAML` (runtime 1.4.3 has it): a
  narrow typed accessor in `skills.ts`, no types upgrade (out of scope).
- Truncation edge fixed during tests: total line count was off by one on a
  trailing newline, and a mid-line cut pointed past the cut line.

**Tests:** `config/test/skills.test.ts` (15), 8 discovery cases in
`config/test/load.test.ts`, `tools/test/skill.test.ts` (11), `exemptTools` in
`agent/test/result-pipeline.test.ts`, `ToolContext.history` in
`agent/test/agent.test.ts`, 3 end-to-end in `cli/test/wiring.test.ts`, the
diagnostics gate in `cli/test/main.test.ts`.

**Non-vacuity by mutation (§9), each red then reverted to green:**
- `wiring.ts` `shaping = (t) => t` (no exemption) → "the skill body reaches the
  model verbatim" FAILS (the 36 KB body comes back as a spill preview).
- `agent.ts` without `history: messages` → the `ToolContext.history` test FAILS.
- `main.ts` gate `if (true)` → the diagnostics test FAILS on `run`.

**Weak-model check** (`.tentacle/tmp/skills-core/gate.ts`: the real
`buildAgent` + `loadConfig`, catalog = project `deploy-app` + the user's real
`hf-cli`, stop at the first tool call), Qwen3.8-27B-UD-Q6_K_XL, 3 runs each:

```
match-explicit ("Deploy the app to staging.")          → skill {"name":"deploy-app"} ×3
match-indirect ("Ship the current version to prod…")   → skill {"name":"deploy-app"} ×3
match-hf ("Download … from the Hugging Face Hub …")    → skill {"name":"hf-cli"} ×3
neutral ("What is 17 * 23?")                           → (no tool) ×2, 1 ECONNRESET from the endpoint
```

9/9 matching tasks call `skill` first with a valid name; no spurious call.

**Gate:** `bun run check` → typecheck clean, lint clean (baseline 0/0),
`1347 pass · 2 skip (the opt-in live-k8s + slow keepalive) · 0 fail`.

## Review

*— claude-opus-5-5, 2026-10-20 (in-context: the owner waived the fresh-context review for this sub-task)*

Red-team of the failure modes:

- **Load-bearing assumption holds**, proved end-to-end by the real wiring
  (default transforms, and with summarise on: no extra model call, body
  verbatim), with the mutation above. Another tool's large output still spills.
- **Isolation of laptop and pod (§7):** discovery runs in the process that
  builds the agent; the laptop's `systemPrompt` never reaches a pod; a pod
  daemon reads only pod paths. Nothing new crosses the wire, and nothing is
  approved: `skill` is `permission: "none"` (as `fs_read`), `allowed-tools`
  ignored.
- **`ToolContext.history`** is read-only and stays in-process: the MCP adapter
  forwards only `signal` (`mcp/src/tool-adapter.ts:56`).
- **Dedup is derived** (marker in a `skill` result), so resume and re-attach
  are right, and after `/compact` (history rebuilt) the skill can load again.
  Error results and dedup notes never count (tested).
- **Bounds:** walk 40 steps, 200 dirs per root, 50 listed files, 1000 visits,
  depth 4, symlinked dirs inside a skill not recursed (no loop), catalog 100,
  body 50 000 chars with an exact `fs_read path:line` continuation.

Known limits (deliberate, not bugs):
- In the TUI, the `[skills]` lines are written before Ink takes the alt-screen,
  so they show again only after exit. A startup notice inside the TUI would need
  the diagnostics on the wire (with sub-task 3's catalog).
- Sub-agents whose type allows `all` tools get the `skill` tool (the enum
  names) but not the catalog: sub-task 4 decides the sub-agent shape.
- Tests that call `loadConfig` with the real `HOME` (`cli/test/wiring.test.ts`
  first case) now also scan `~/.agents/skills`; no assertion depends on it.
- A skill edit is read at activation (and, since `feat/skills-compaction`, again
  at `/compact`); a new or renamed skill needs a restart (decision 3), or a
  context reset for the model (`docs/feat/context-reset.md`).

Behaviour of the implementing model: found the spill/summary hazard while
verifying the plan (before any code) and designed it in. The test fixes in
Execution were test-fixture errors (an empty final model turn triggers the
loop's auto-nudge; a repetitive body was deduped under the spill threshold),
not code changes.
