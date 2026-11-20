# feat/tool-toggles — switch built-in tools off by group or by name

> **Status:** execution — Implementation approved 2026-11-20; S1, S2, S3 done — awaiting fresh-context Review
> **Branch:** `feat/tool-toggles`
> **Size:** L (3 slices on this branch: S1 M · S2 M · S3 M **UI**) · **Blast:** load-bearing (the tool list the agent loop sends every round, the session's capability state on the wire and in the session log) · **Suited:** Opus plan; S1 and S3 a weaker model is fine, S2 a strong model; Review mandatory, in a fresh context, red-teaming §7 (one session path, a pod is not trusted, protocol forward compatibility, persistence)
> **Changelog:** `changelog.d/tool-toggles.added.md`: "**Switch built-in tools off.** `tools.enabled` in the config (or a profile) turns built-in tools off by group (`subagents`, `shell`, `schedule`, `visuals`, …) or by name, and the new `/tools` panel shows what each definition costs the context and switches them for the session. `skill` is always on."

Type: feat · Size: L · Blast: load-bearing · Suited: Opus plan + strong-model S2 + fresh-context review

(The TODO row sized it M. It is L here: it touches protocol, config, agent, daemon, client, cli and tui, and adds one method and one panel. It does not need an XL split, because every slice reuses an existing seam.)

## Context

*— claude-opus-5-5, 2026-11-20*

**Problem.** On a small local model (qwen3.8), the built-in tool definitions take a large share of the context, on every request. Today the only way to drop a tool is a per-feature switch, and only some tools have one:

| tool(s) | switch today |
|---|---|
| `agent_task`, `agent_control` | `subagents.enabled` |
| `context_reset` | `contextReset.enabled` |
| `move_session` | `sessionHop.tool` (off by default) |
| `workload_shell` | `workloadShell.tool` (off by default) |
| `present`, `schedule_*` | only where the host has the seam (artifact store, schedule link) |
| `fs_read`, `fs_write`, `fs_edit`, `fs_multi_edit`, `shell`, `shell_output`, `shell_kill`, `chart`, `diagram` | **none: always offered** |

**Owner intent** (TODO.md row `feat/tool-toggles`, names approved 20/11):

- Switch built-in tools off by **group**, or by a **single tool name**. Tool names stay as they are. The shape is `"tools": { "enabled": { "subagents": false, "fs_multi_edit": false } }`, the same shape as `packages`.
- It must be usable in a **profile**, e.g. a lean qwen profile selected with `--profile`.
- Groups:
  - `subagents`: agent_task, agent_status, agent_control, agent_message, agent_kill, agent_notify
  - `shell`: shell, shell_output, shell_kill
  - `schedule`: schedule_create, schedule_control
  - `visuals`: chart, diagram, present
  - `context_reset`, `move_session`, `workload_shell`
- `skill` can never be switched off. Single skills stay switchable, as today.
- A TUI `/tools` panel lists each tool and group with the token cost of its definition, and toggles them for the session. It must behave like `/skills` and `/mcp` (`packages/tui/src/capability-toggles.ts` and its set call).
- Invariants:
  - A disabled tool never reaches the model, in pods too.
  - A sub-agent never re-enables a tool its parent has off.
  - Phone parity.

**Constraint from the next task.** `feat/caps-before-first-message` (TODO.md:50) will add "switch before the first message" to `/skills`, `/mcp` **and** `/tools`, with one mechanism. So the `/tools` set path here must be the same call and the same client phase (`capsPhase`) as the other two. This task does **not** build that.

**Repro** (2026-11-20, on `feat/tool-toggles` = `main` @ `5e99a6c9`; `.tentacle/tmp/tool-toggles/repro.ts`). It does two things:
1. Loads a config with `tools.enabled`.
2. Prints what each definition of a fully-featured `buildAgent` registry costs, using the heuristic counter the context line uses. There are no skills in the temp HOME, so the `skill` tool is not in the list.

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@tentacle/config";
import { HeuristicTokenCounter } from "@tentacle/core";
import { buildAgent } from "../../../packages/cli/src/wiring.ts";

const dir = mkdtempSync(join(tmpdir(), "tt-cfg-"));
writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ tools: { enabled: { subagents: false } } }));
try {
  await loadConfig({ configDir: dir, cwd: process.cwd(), scaffold: false, env: { HOME: dir } });
  console.log("tools.enabled: accepted (unexpected)");
} catch (e) {
  console.log(`tools.enabled: refused — ${String(e).split("\n")[0]}`);
}
const dir2 = mkdtempSync(join(tmpdir(), "tt-cfg-"));
writeFileSync(join(dir2, "config.jsonc"), JSON.stringify({ sessionHop: { tool: true }, workloadShell: { tool: true } }));
const config = await loadConfig({ configDir: dir2, cwd: process.cwd(), scaffold: false, env: { HOME: dir2 } });
const wired = buildAgent(config, {
  moveSession: true,
  artifacts: { put: async () => { throw new Error("x"); } } as never,
  schedules: () => null,
  workloadShell: { backend: {} as never },
});
const counter = new HeuristicTokenCounter();
let total = 0;
for (const def of wired.tools.definitions()) {
  const t = counter.countText(JSON.stringify(def));
  total += t;
  console.log(`${def.name.padEnd(18)} ~${t}`);
}
console.log(`TOTAL (${wired.tools.list().length} tools) ~${total}`);
```

```
tools.enabled: refused — ConfigError: Invalid …/config.jsonc: Unrecognized key(s) in object: 'enabled'
fs_read            ~264
fs_write           ~93
fs_edit            ~162
fs_multi_edit      ~266
shell              ~288
shell_output       ~96
shell_kill         ~76
agent_task         ~439
agent_control      ~212
context_reset      ~290
chart              ~1299
diagram            ~349
move_session       ~356
present            ~367
workload_shell     ~590
schedule_create    ~185
schedule_control   ~116
TOTAL (17 tools) ~5448
```

What the output shows:
- The setting does not exist.
- With the defaults, about 4.5k tokens of definitions go out on every request (`move_session` and `workload_shell` are off by default).
- `visuals` alone is about 2k of them (chart ~1.3k).
- On a 32k-context local model, `visuals` + `subagents` + `context_reset` is about 2.9k tokens, or ~9% of the window. A lean profile gets that back.

## Implementation

*— claude-opus-5-5, 2026-11-20*

### Load-bearing assumption

**Every model request of every runtime gets its tool list from ONE projection, `Agent.projectedTools(caps)`. That projection already filters by the session's capability state. A sub-agent reads its parent's state live. So adding a `disabledTools` set to that state hides a tool everywhere, with no second filter.**

Proof:

1. **The one assembly point.** `packages/agent/src/agent.ts:1502-1503`:
   - `const caps = this.capabilities(); const tools = this.projectedTools(caps);` builds each round's request. `request.tools = tools` is at `:1513`.
   - `projectedTools` (`:994-996`) is `projectTools(this.config.tools.definitions(), this.serverOf, caps)`, the pure filter in `packages/agent/src/capabilities.ts:149-176`.
   - The context meter (`contextUsage`, `agent.ts:2007-2008`), pruning (`maybePrune`, `:1506`) and the context line (`noteContextUsage`, `:1507`) use the same `tools`. So the TUI's context figure shows the reduction too.
   - The step-limit final request sends no tools at all (session-capabilities.md F3 note). Nothing to filter there.
2. **The one execution guard.** `authorizeCall` (`agent.ts:3020`) refuses a call that `hiddenCallRefusal(call, caps)` (`:1093-1104`) flags, *before* the permission gate, and never runs it.
   - Every call path passes the round's snapshot: the normal round (`:1789`), resumed calls (`:2176`) and grouped calls (`:2312`).
   - So a call to a tool that is off is answered `"<name> is turned off for this session"` and never executed.
3. **Every runtime builds its agent through `buildAgent`** (`packages/cli/src/wiring.ts:476`), which is the one place the registry is filled (`:495` built-ins, `:565` skill, `:609-696` sub-agents, `:718` context_reset, `:725/:729` chart/diagram, `:735` move_session, `:741` present, `:751` workload_shell, `:762` schedules). The call sites:
   - the in-process worker: `cli/src/worker.ts:85`
   - `serve` (which also serves the phone and `connect`): `cli/src/serve.ts:218`
   - a pod daemon (`serve --stdio`, model over the tunnel, i.e. `run`/`attach`): `cli/src/serve.ts:1224`
   - a pod daemon with its own model: `serve.ts:1311`
   - plain REPL: `main.ts:2156`
   - one-shot: `main.ts:2325`
4. **Sub-agents follow the parent's state live.**
   - `wiring.ts:661`: `capabilities: () => agent.capabilities()` is handed to the runner.
   - `subagent.ts:458` passes it to each child's `Agent`. That `Agent` projects and guards with the same two functions, once per child round.
   - The child's own extra tools (`search` for `explore`, `subagent.ts:387`) and its own `agent_notify` sit in the child's registry. They go through the same projection, so a name in the parent's disabled set hides them too.
   - A child can never *widen* the set, because it holds no setter: it only reads `deps.capabilities`.

What the executor must re-verify first (S1, before any edit): grep that no other `ChatRequest` with a non-empty `tools` is built outside `agent.ts`. The candidates are compaction, title and `summarizeText`, which send no tools. If one exists, STOP and bring it to the plan.

### Preconditions

- **The capability seam exists and is the pattern** (docs/feat/session-capabilities.md, merged):
  - The state is a DISABLED set. It is a projection, never a registry mutation (`capabilities.ts:1-13`).
  - It is a delta op, idempotent by identity (`applyCapabilityOp`, `:68-85`).
  - A round snapshot applies (`agent.ts:1498-1502`, F1/F2).
  - The daemon holds the truth (`hosted-session.ts:690`). It re-applies the truth to a rebuilt agent (`:2944`), logs it in the session log (`:3025`/`:3058`), and broadcasts a `capabilities` update (`:3060`, `UPDATE_CLASS` `display`, `protocol/updates.ts:581`).
  - It is seeded on a create from `session/open{capabilities}` (`session-host.ts:1027-1028`, `protocol/session.ts:1159-1165`).
  - It is snapshotted on every open (`OpenResult.capabilities`, `session.ts:1193-1198`).
  - The client carries it into a resume, a `/clear` fork or a hop (`remote-client.ts:1828-1845`).
- **Payload schemas strip unknown fields** (AGENTS §7 forward compat). An optional field added to `SessionCapabilitiesSchema` is dropped by an older peer, and its absence is readable by a newer one.
- **The `capabilities` log entry is NON-critical** (`protocol/session-log.ts:39-41`, `:198-211`). An older build that skips it shows the model everything. That is fail-open on visibility; permissions still gate every call.
- **Profile merge**: `tools` merges per key, ONE level (`config/src/profile.ts:186-188`, `config.tools = { ...base.tools, ...tools }`). A nested `tools.enabled` map would therefore be REPLACED whole by a profile today. `packages` is replaced whole on purpose (`schema.ts:608-612`).
- **`config` depends only on zod and jsonc-parser** (`packages/config/package.json`). `agent` depends on `config` + `tools`, and `daemon` uses `agent`. So a name table in `@tentacle/config` is reachable from config validation, the agent, the daemon and the TUI (which already imports config). A table in `@tentacle/tools` would not be reachable from config validation.
- **The system prompt names no tool** (`config/src/defaults.ts:136-144`). Hiding a tool leaves no dangling instruction in the prompt. Tool *descriptions* may name a sibling (for example `shell` names `shell_output`); groups keep those pairs together.

### Design

**One rule, two layers.** A built-in tool is **offered** to the model iff:
- it is **registered**: its feature switch is on AND this host has its seam (today's code, unchanged), AND
- it is **not disabled** in the session's capability state.

Notes on the two layers:
- `tools.enabled` and `/tools` act ONLY on the second layer. They hide and unhide; they never register.
- The per-feature switches stay what they are today: whether the feature *exists* on this host (`subagents.enabled` also builds the runner and the job cap; `contextReset.enabled` the refresh; `workloadShell.tool` the laptop-credential shell; `sessionHop.tool` the proposal).
- So nobody, not the phone and not a pod, can switch ON a tool through `/tools` that the host's owner left unregistered. That matters for `workload_shell`, which is opt-in because it uses the laptop's credentials.
- There are no two truths: "is it offered now?" is answered only by `projectTools`, and the disabled set has exactly one writer path (seed + `set_capability`).

**D1 — The name table and the resolution: a pure module, `packages/config/src/tool-groups.ts`.**

```ts
export const ALWAYS_ON_TOOLS = ["skill"] as const;
export const TOOL_GROUPS = {
  subagents: ["agent_task", "agent_status", "agent_control", "agent_message", "agent_kill", "agent_notify"],
  shell: ["shell", "shell_output", "shell_kill"],
  schedule: ["schedule_create", "schedule_control"],
  visuals: ["chart", "diagram", "present"],
  context_reset: ["context_reset"],
  move_session: ["move_session"],
  workload_shell: ["workload_shell"],
} as const;
/** Every built-in a session may offer (grouped or not), `skill` included. */
export const BUILTIN_TOOL_NAMES: readonly string[];  // + fs_read, fs_write, fs_edit, fs_multi_edit, search, skill
export function expandToolName(name: string): readonly string[] | undefined; // group → members, tool → [tool], unknown/skill → undefined
export function groupOfTool(tool: string): string | undefined;
/** `tools.enabled` → sorted disabled tool names; a single tool's entry beats its group's (Q2). */
export function disabledToolsOf(enabled: Readonly<Record<string, boolean>>): string[];
/** Unknown names and `skill` → one message each (D3 turns them into a ConfigError). */
export function toolToggleIssues(enabled: Readonly<Record<string, boolean>>): string[];
/** `true` on a tool whose feature switch leaves it unregistered → a notice (never an error). */
export function toolToggleNotices(enabled, features: { subagents: boolean; contextReset: boolean; sessionHop: boolean; workloadShell: boolean }): string[];
```

- It is pure data plus functions. React-free and I/O-free (§7 "logic in pure modules").
- The single-name group names (`context_reset`, …) are the tool names themselves, so either reading gives the same result.
- `agent_status`, `agent_message`, `agent_kill` are no longer registered (merged into `agent_control`, `subagent.ts:392-397`). They stay in the group because the owner named them, and an old session's replay may still carry them. Hiding a name that is not registered is harmless.
- **Parity pin**: a test in `packages/tools/test/` asserts that `BUILTIN_TOOL_NAMES` equals the set of every exported `*_TOOL_NAME`, the `builtinTools` names, `agent_task` and `search`. A new built-in then cannot ship without a table entry, and the table cannot name a tool that no longer exists.

**D2 — The state gains `disabledTools`. The agent projects and guards with it** (`packages/agent/src/capabilities.ts`).

- `SessionCapabilities` → `{ disabledMcp, disabledSkills, disabledTools }`. `CapabilityKind` → `"mcp" | "skill" | "tool"`.
- `applyCapabilityOp` for `kind: "tool"`:
  - `op.name` is expanded with `expandToolName` (a group is ONE op: atomic, one log entry, one broadcast).
  - `enabled: false` adds every member; `enabled: true` removes every member.
  - The function stays idempotent by identity.
  - An unknown name or `skill` is NOT applied: the pure function returns a typed refusal, and the daemon maps it to `InvalidParams` (F1, F2). This differs from MCP/skill names, which are stored even when unknown (session-capabilities F10). Built-in names are static per build, so an unknown one is a typo or version skew, never "appears later".
- `isToolDisabled(name, state)`: `state.disabledTools.includes(name) && name !== "skill"`. The second check is defence in depth: a `skill` that slipped into the set (a hostile seed, a hand-edited log) still never hides the `skill` tool.
- `projectTools`: a def is also dropped when `isToolDisabled(def.name)`. The rest is unchanged (same array back when nothing is hidden, so the prompt cache holds).
- `hiddenCallRefusal`: also refuses `isToolDisabled(call.name)` with the same text, `"<name> is turned off for this session"`.

**D3 — Config: `tools.enabled`** (`packages/config/src/schema.ts`, `resolve.ts`, `profile.ts`, `key-docs.ts`, `defaults.ts` template).

- Schema: `tools.enabled: z.record(z.boolean()).optional()`, inside the existing strict `tools` object.
- `FileConfigSchema.superRefine` (next to `modelRefIssues`, `schema.ts:680-685`) adds `toolToggleIssues` for the base and for each profile's *merged* view. So `loadConfig` and `config set` refuse an unknown name or `skill` with a `ConfigError` that names it and lists the valid groups and tools (F1).
- Resolved: `ResolvedConfig.disabledTools: readonly string[]` = `disabledToolsOf(tools.enabled ?? {})`.
- Profile: `tools.enabled` merges **per key** (Q3): `config.tools = { ...base.tools, ...tools, ...(either has enabled ? { enabled: { ...base.tools?.enabled, ...tools.enabled } } : {}) }`. A lean profile then adds its switches to the base's, and `"shell": true` in a profile can turn a base-off group back on. Update the header comment of `profile.ts`.
- Notices: `buildAgent` emits `toolToggleNotices` through the existing `options.notice` (daemon-side, never the terminal while Ink owns it, §7). For example: `tools.enabled: workload_shell has no effect — workloadShell.tool is off`.

**D4 — The config seeds the state in ONE place: `buildAgent`. The host's state starts from it.**

- `wiring.ts` `new Agent({ …, capabilities: { ...NO_CAPABILITIES, disabledTools: config.disabledTools } })`. This covers all six `buildAgent` call sites, including plain and one-shot, which have no `SessionHost` at all.
- `hosted-session.ts:690`: `this.caps` starts from `normalizeCapabilities(session.currentAgent().capabilities())` instead of `NO_CAPABILITIES`. When that is non-empty, it is logged in the first segment like a seed, so the daemon's truth includes the host config's set.
- `seedCapabilities` becomes a **union** with the current state. For MCP and skills that equals today's replace, because their part of the state is empty at seed time.
- `swapAgent` (`:2944`) keeps re-applying `this.caps`, so a settings sync cannot wipe the set. The rebuilt agent's initial config set is overwritten by the truth, which already contains it.
- A reload from disk (`:961`) keeps the record's state. A restart *continues* a session; it does not create one (Q4).
- `normalizeCapabilities` / `hasDisabled` / `toWireCapabilities` (`hosted-session.ts:545-553`, `daemon/src/mapping.ts:132`) carry the third set.

**D5 — Pods: the laptop's set travels as a SEED, never as a setting.** The laptop resolves its own `config.disabledTools` and unions it into every `session/open{create}` it sends: a new session, a resume from its copy, a `/clear` fork, a hop.
- The change is one new `RemoteClientOptions.baseDisabledTools`, unioned in `openSession` (`remote-client.ts:1834-1845`), and set by the cli runtimes (worker, `run`, `attach`, `connect`) from the loaded config.
- The pod daemon unions the seed with its OWN config's set (D4). **Off wins**: neither the pod's file nor anything else in the seed path can re-enable what the laptop turned off.
- It is deliberately **not** a `SessionSettings` key. There, the pod's own file *wins* (`session.ts:1090-1108`), which would let the pod re-enable.
- A pod is still not trusted (§7). A hostile pod daemon could ignore the set and offer its model more tools. That **wastes context only**, the same as the accepted session-capabilities F14:
  - The tools a pod holds act inside the pod, which the pod controls anyway.
  - The tools whose effect is on the laptop (`workload_shell`, `move_session`) are never registered in a pod (`wiring.ts:731-753`).
  - Every pod call still asks through the single laptop broker.
  - Owner Q6 asks whether to add a laptop-side strip anyway.

**D6 — Wire (additive, no `PROTOCOL_VERSION` bump, no `protocol.d/` note).**

- `SessionCapabilitiesSchema` (`session.ts:1120-1123`) + `disabledTools: z.array(CapabilityNameSchema).max(MAX_DISABLED_CAPABILITIES).optional()`.
  - A new daemon always sends it, even `[]`.
  - **Absent ⇒ the daemon has no tool switches.** The client then shows `/tools` switches as unsupported (F8).
  - An older client strips it, and its MCP/skill toggles keep working.
  - Older on-disk `capabilities` entries parse with it absent, read as `[]`.
- `SetCapabilityParamsSchema.kind` (`session.ts:1267`) → `z.enum(["mcp", "skill", "tool"])`, with `name` a tool **or group** name.
  - An older daemon answers `InvalidParams`.
  - The client never sends `"tool"` there anyway, because that daemon's snapshot had no `disabledTools`.
- **New method `session/tools`** (`Method.SessionTools`, schemas in a new `packages/protocol/src/tools.ts`, mirroring `session/skills`, `skills.ts:68-80`):
  - Params: `{ sessionId?, settings? }`. Without a session it answers for the session a create would build now. That is the hook `caps-before-first-message` needs, and it costs nothing here.
  - Result `{ tools: ToolListEntry[] }`, each entry `{ name: line(128), group?: line(64), tokens: int ≥ 0, disabled?: true, locked?: true }`, at most 128 entries.
    - `locked` = `skill`.
    - `tokens` is the heuristic count of the tool's definition (`HeuristicTokenCounter.countText(JSON.stringify(def))`, as in the repro), shown as `~N`.
  - The daemon reports the **group** per tool from its own table. The TUI needs no table, and a version skew cannot make the two disagree.
  - Only REGISTERED built-ins are listed (MCP tools have `/mcp`; tools tagged `mcpServer` are excluded).
  - An added method: an older daemon answers `MethodNotFound`, and the panel says "needs a newer tentacle".
  - From a pod, every string is bounded and control-free (`line()`), and the numbers are display only.
- The `capabilities` update and its client mapping (`client/mapping.ts:388`) are unchanged in kind. They carry the third array.
- The log entry stays non-critical. **The sidecar is untouched**: it holds no caps (verify with `rg capabilities packages/daemon/src/daemon-state-file.ts` in S2).

**D7 — TUI `/tools`** (S3). It follows the S4 pattern of session-capabilities (T1: a switch column per row, quiet grammar).

- **Pure parts** (§7):
  - `capability-toggles.ts`: `CapsView` gains `disabledTools?`, `CapKind` gains `"tool"`, `isOff`, a new `toolSwitch(phase, entry)` (`locked` for `skill`, `null` when the daemon has no tool switches), `groupSwitch(phase, members)` (on / off / partial `[~]`; Space on partial turns the group **on**, Q7), and `capsMarker` adds `· N tools off`. The rest (`capsDiff`, `remoteChangeNotices`, `settled`) is extended to the third kind.
  - A new `tools-panel.ts` view-model: rows = groups (expandable with Enter to their registered members, like `/mcp` servers) plus ungrouped tools, each with `~tokens`. The title note says `~<total> tokens · <n> off · this session · applies to the next model call`.
- **Component**: `panels/ToolsPanel.tsx` renders the view-model (glyphs and colours only).
- **App**: the existing `switchCapability` path (`App.tsx:2017-2038`) is reused unchanged. A group row sends `setCapability("tool", <group>, enabled)`, a member row sends `setCapability("tool", <tool>, enabled)`. The row flips on the daemon's echo, never optimistically. Before the first message the phase is `not-open`, exactly like the other two panels. That is the seam `caps-before-first-message` generalises.
- A palette entry `/tools` with no arguments (owner Q6 of session-capabilities: panel only, no typed `/tools off x`).

**D8 — Phone (parity).**
- A `serve` session gets exactly the same switches: the serve daemon's own `tools.enabled` seeds every session it creates, the phone's included (D4). The `capabilities` updates carry the set to every client.
- **v1 mobile shows nothing new.** It keeps rendering MCP and skill switches, and strips `disabledTools`.
- A phone "Tools" section (P1 pattern: an iOS switch per group, `session/tools` + `set_capability{kind:"tool"}`) is a follow-up TODO row (`feat/mobile-tool-toggles`, Q8). Its mockups go in the approved mobile-chrome look first, as with session-capabilities S5.

### Files

In dependency order. One line each; the slices are marked.

**S1 — names, config, agent projection (M, contained to config + agent + a tools pin):**
1. `packages/config/src/tool-groups.ts` (new): D1. Export it from `packages/config/src/index.ts`.
2. `packages/config/src/schema.ts`: `tools.enabled`, plus `toolToggleIssues` in `superRefine` (base + each merged profile).
3. `packages/config/src/profile.ts`: the per-key `tools.enabled` merge, plus the header comment.
4. `packages/config/src/resolve.ts`: `disabledTools` in `ResolvedConfig`.
5. `packages/config/src/key-docs.ts` + the `DEFAULT_CONFIG_JSONC` template (`defaults.ts`): document the key, the groups, "skill is always on", "true never turns on a feature that is off".
6. `packages/agent/src/capabilities.ts`: D2.
7. `packages/cli/src/wiring.ts`: D4 seed of `new Agent({capabilities})` + `toolToggleNotices`.

**S2 — wire, daemon, client (M, load-bearing):**

8. `packages/protocol/src/session.ts`: `disabledTools?` on `SessionCapabilitiesSchema`, `"tool"` in `SetCapabilityParamsSchema.kind`.
9. `packages/protocol/src/tools.ts` (new) + `methods.ts` (`SessionTools`) + the index export: D6 `session/tools`.
10. `packages/daemon/src/hosted-session.ts`: initial `caps` from the agent, union seed, the third set in normalize/hasDisabled, the `InvalidParams` mapping of the D2 refusal, and a `toolsList()` for the method.
11. `packages/daemon/src/mapping.ts`: `toWireCapabilities` + a wire→state helper that defaults `disabledTools ?? []`.
12. `packages/daemon/src/connection.ts`: pass `kind: "tool"` (`:410`) and handle `session/tools` (a no-session form builds through the same factory as `session/skills`' no-session form).
13. `packages/core` session-log fold of `capabilities` entries (wherever `record.capabilities` is folded, `session-host.ts:1377`): default the third set.
14. `packages/client/src/remote-client.ts` + `remote-session.ts`: `baseDisabledTools` union on create (D5), `setCapability` kind type, `sessionTools()`.
15. `packages/cli/src/*` runtime builders (worker, run/attach, connect): pass `baseDisabledTools: config.disabledTools`.

**S3 — TUI (M, UI):**

16. `packages/tui/src/capability-toggles.ts`: D7 pure parts.
17. `packages/tui/src/tools-panel.ts` (new): the view-model.
18. `packages/tui/src/panels/ToolsPanel.tsx` (new) + panel registration (`panel.ts` / `usePanels.ts`) + the `/tools` palette entry (`commands.ts`) + `app-types.ts` (`setCapability` kind, `sessionTools?`).
19. `changelog.d/tool-toggles.added.md`.
20. `TODO.md`: the `feat/mobile-tool-toggles` row (Q8). It rides the branch because it is bundled with code.

### Failure modes

| # | Case | Convergence |
|---|---|---|
| F1 | Unknown group/tool name in `tools.enabled` (base or profile) | `ConfigError` at load and at `config set`. It names the bad key and lists the valid groups and tools. Never a silent no-op. |
| F2 | `skill` in `tools.enabled`, or `set_capability{kind:"tool", name:"skill"}` | Config: `ConfigError` "skill is always on". Wire: `InvalidParams`. A `skill` already in the state (a hostile seed, an edited log) is ignored by `isToolDisabled`, so it never hides the `skill` tool. |
| F3 | `true` on a tool whose feature switch is off (`workload_shell` with `workloadShell.tool:false`) | One notice. The tool stays unregistered: `true` never registers. |
| F4 | `set_capability{kind:"tool"}` with a name the daemon does not know (a newer client, an older pod daemon) | `InvalidParams`, so the TUI shows `switchFailedNotice`. Never stored, never a silent no-op. A newer laptop's **seed** naming a tool an older pod lacks is stored harmlessly: it hides nothing that exists. |
| F5 | Switch off mid-turn while a call to that tool is streaming or running | The round's snapshot rule (session-capabilities F1/F2, `agent.ts:1498-1502`). The running call completes and its result goes into history. Later rounds don't offer the tool and refuse it. Nothing is aborted. |
| F6 | A call of the same round queued behind a permission prompt when the switch flips | Judged against the round's snapshot, where the tool was visible, so it proceeds through the gate (the user can deny). The next round refuses it. Same as MCP today. A suspended turn reloaded on `serve` re-runs its round with **no** capability guard (`agent.ts:1341-1344` passes no `capabilities`; `RoundHooks.capabilities` doc, `:722-727`: "a resumed round: its calls were issued when they were visible"), so the call is re-asked through the gate and the user can deny it; the next round is projected with the reload's state. *(Corrected at Execution, 2026-11-20: the plan said the resumed path passes a snapshot at `:2176`; it passes `hooks.capabilities`, which the resumed round leaves undefined. Behaviour unchanged from MCP/skills; no new test — the existing session-capabilities design pins it.)* |
| F7 | The model calls a disabled tool (from older history, or hallucinated) | `hiddenCallRefusal`: an error result, `"<name> is turned off for this session"`, before the gate. No prompt, never run. Past `tool_use` blocks stay in history. Both providers accept history calls to a tool absent from `tools` (session-capabilities S2 F3 evidence; live acceptance was not verified there either). |
| F8 | Older daemon (no `disabledTools` in the snapshot), or `session/tools` → `MethodNotFound` | `/tools` shows the list as "needs a newer tentacle" with no switches. `/mcp` and `/skills` are unaffected. |
| F9 | Older client against a new daemon | It strips `disabledTools`. The model still gets the reduced list, decided daemon-side. An older TUI just doesn't show it. |
| F10 | Older build loads a log whose `capabilities` entry has `disabledTools` | The field is stripped, so the session loads with all tools visible. Fail-open on visibility only (non-critical, owner Q2 of session-capabilities). |
| F11 | Sub-agent | It reads the parent's state live (`wiring.ts:661`) and has no setter, so it can never re-enable anything. A switch flipped while a child runs applies from the child's next round. |
| F12 | `subagents` off while a background child runs | The child keeps running. Its `agent_notify` disappears from its next round, and its report still arrives as a note. The parent model loses `agent_control`. The user's `/agents` panel can still stop it (`session/agent_kill`, a user path, not a model tool). |
| F13 | `shell` off while a background shell job runs | The job keeps running, and its exit still surfaces as a note (auto-wake unchanged). The model cannot read its output (`shell_output` hidden). The user's jobs panel still reads and kills it (`session/job_output` / `job_kill`). |
| F14 | Profile merge | `tools.enabled` merges per key over the base (Q3). The other `tools.*` keys keep today's per-key merge. Pinned by a profile test, including a profile `true` re-enabling a base `false` group. |
| F15 | Compaction / `context_reset` / resume of a session whose history used a now-disabled tool | The history is never rewritten; the projection is per request. Compaction's summary call sends no tools. `context_reset` re-logs the state after the new `base` (session-capabilities F12), so the third set rides along. A resume from the laptop's copy carries the record's state, unioned with the launch config's set (D5, Q4). |
| F16 | Prompt-cache impact of a mid-session switch | The tool list sits at the head of the prompt (the Anthropic `tools` block; for llama.cpp/qwen, rendered into the template prefix). So one switch invalidates the cached prefix ONCE: the next request re-prefills the whole context, and later requests cache again. Toggling back and forth costs one re-prefill each time. This is the same as the accepted MCP behaviour (session-capabilities owner Q1). The panel title already says "applies to the next model call". With nothing off, `projectTools` returns the same array, so the bytes are identical and nothing changes for users who don't use the feature. |
| F17 | Two clients toggle the same group / different items | Synchronous delta apply in the daemon, in one total order, with no peer lock (§7). Every client converges on the last echo (session-capabilities F4). A group op is one apply, so it is never half-applied. |
| F18 | Disconnect / reconnect | `OpenResult.capabilities` re-snapshots, now including `disabledTools`. |
| F19 | Everything switchable turned off | The model keeps `skill` (if any skills are offered) and any MCP tools. An empty `tools` array is a valid request (the step-limit final request already sends none). |
| F20 | A flood (`disabledTools` > 256) | `InvalidParams`, like the other two sets (`hosted-session.ts:3045-3051`). |

### Tests

Red before green: every test below is first shown failing on `main`'s code, or on the slice's code with the one line under test reverted (§9).

**Unit, S1:**
- `packages/config/test/tool-groups.test.ts`:
  - group expansion
  - a single name beats its group, both directions
  - an unknown name → an issue
  - `skill` → an issue
  - `disabledToolsOf` is sorted and de-duplicated
  - `toolToggleNotices` for each feature switch
- `packages/tools/test/tool-names-parity.test.ts`: `BUILTIN_TOOL_NAMES` ≡ the exported names (D1 pin).
- `packages/config/test/profile.test.ts` (extend):
  - a profile `tools.enabled` merges per key over the base
  - a profile `true` re-enables a base-off group
  - other `tools.*` keys are unchanged
- `packages/config/test/load.test.ts` (extend):
  - `tools.enabled.fs_mult_edit` → a `ConfigError` naming it
  - `tools.enabled.skill` → a `ConfigError`
  - a bad name inside a profile is refused too
- `packages/agent/test/capabilities.test.ts` (extend):
  - `applyCapabilityOp` with a group is atomic and idempotent by identity
  - an unknown name or `skill` → a refusal, state unchanged
  - `projectTools` drops disabled built-ins and never `skill`, even with `skill` in the set
  - the same array comes back when nothing is hidden

**Agent/daemon, S1–S2** (fake model recorder, the existing session-capabilities harness):
- `packages/agent/test/agent-capabilities.test.ts` (extend):
  - **the model request carries no disabled tool**: config-seeded, and set mid-session; the assertion is on the recorded `ChatRequest.tools`
  - **a call to a disabled tool is refused, not executed**: a spy tool's `execute` count stays 0, the result text is the refusal, and no permission request is made
  - a sub-agent's request carries no tool the parent disabled, including `search` for `explore`, and a child cannot clear it
  - **Mutation (§9)**: remove the `isToolDisabled` drop in `projectTools`, so the request test goes red; remove it in `hiddenCallRefusal`, so the refusal test goes red; revert both. This proves the filter is the thing keeping the tool out.
- `packages/cli/test/wiring.test.ts` (extend): `buildAgent` with `tools.enabled: { visuals: false }` → `agent.capabilities().disabledTools` holds `chart`, `diagram`, `present`. A one-shot/plain-path request carries none of them.
- `packages/daemon/test/session-capabilities.test.ts` (extend):
  - a host built from a config with tools off snapshots them in `OpenResult.capabilities` and logs them in the first segment
  - `set_capability{kind:"tool", name:"shell"}` → one broadcast, three names; repeating it → no emit
  - `skill` or an unknown name → `InvalidParams`
  - a seed **unions** with the host config's set; a seed cannot remove a host-config name (a pod cannot re-enable)
  - a settings sync (`swapAgent`) keeps the set
  - a `serve` reload keeps the record's set
  - `session/tools` lists registered built-ins with group, `tokens > 0`, `locked` on `skill`, `disabled` on the off ones, and no MCP tool
- `packages/client/test/remote-client.test.ts` (extend):
  - `baseDisabledTools` is unioned into every create (new, resume, fork, hop)
  - the snapshot without `disabledTools` reads as "no tool switches"
- `packages/protocol/test/*`:
  - an old-shape `SessionCapabilities` (no `disabledTools`) parses
  - `kind:"tool"` parses
  - the `session/tools` result bounds hold
  - `json-schema.test.ts` regenerated with `bun run protocol:bump` at merge (no note: additive)

**TUI, S3** (`ink-testing-library`, the pattern in `packages/tui/test/app.test.tsx` and the existing `/mcp` / `/skills` switch tests):
- `capability-toggles.test.ts`:
  - `toolSwitch` / `groupSwitch` states, including partial → Space turns it on
  - `capsMarker` with tools off
  - `capsDiff` / notices for the third kind
- `tools-panel.test.ts`: the view-model rows, expansion, the `~tokens` total and the off count.
- `app.test.tsx`:
  - `/tools` opens the panel with `~N` per row
  - Space on a group calls `setCapability("tool", "visuals", false)` once, and the row flips only on the echoed `capabilities` update
  - an old daemon (snapshot without `disabledTools`) shows no switches and an honest line
  - before the first message the phase is `not-open`, the same text as `/mcp`

**Gate:** the full `bun run check` (typecheck → lint → test) before "done", compared against the §6 baselines.

### Owner questions

1. **Composition with the per-feature switches.** Keep `subagents.enabled`, `contextReset.enabled`, `sessionHop.tool`, `workloadShell.tool` as the "exists on this host" layer, with `tools.enabled` only hiding (D1 rule: offered = registered ∧ ¬disabled)? Or fold them into `tools.enabled` and deprecate them? **Rec: keep both layers, documented as one rule.** The feature switches do more than register a tool (runner, refresh, credentials). And `/tools` must never be able to *switch on* `workload_shell`, which is opt-in because it uses the laptop's credentials, from a phone or a pod. Folding them would turn a hide-only switch into a register switch.
2. **A single tool name vs its group:** with `{ "subagents": false, "agent_task": true }`, does the single name win? **Rec yes, the more specific entry wins** (both directions). Otherwise `true` would have no use in a map that defaults to on.
3. **Profile merge of `tools.enabled`:** per key over the base (unlike `packages`, which a profile replaces whole)? **Rec per key.** A lean profile adds its switches to the base's, and a profile can say `"shell": true` to undo one base switch. Replacing whole would silently drop the base's switches whenever a profile names one tool.
4. **When does the config apply?** **Rec: to every session CREATED under it.** That covers a new session, a resume from the laptop's copy, a `/clear` fork and a hop. The config's off set is unioned with the session's carried switches, so `--profile lean --resume X` really is lean. A live re-attach and a `serve` restart continue the session as it is: the record wins, and `/tools` can switch a config-off tool back on for that session.
5. **Errors vs warnings for unknown names:** a hard `ConfigError` at load (D3/F1), or a notice? **Rec hard error.** It is what the TODO asks ("honest error, never a silent no-op"). The built-in names are static per build, and a typo in a lean profile would otherwise silently leave the context full.
6. **Laptop-side strip for pods:** also filter `request.tools` by the laptop's own disabled set in `RemoteClient.laptopRequest` (`remote-client.ts:2465`) when serving a pod's `model/stream`? **Rec no, not in v1.** It is not a security boundary: the tools a pod holds act inside the pod, the laptop-effect tools are never registered there, and every call still asks the laptop broker. It would also need per-session tool state on a per-connection path. A hostile pod ignoring the set wastes context only, as accepted for MCP (session-capabilities F14). Revisit if someone reports a pod that "re-enabled" a tool.
7. **Space on a partially-off group** (some members off one by one): turn the whole group on, or off? **Rec on.** It is the safe, reversible reading ("show me everything in it"); a second Space turns it all off.
8. **Phone in v1:** config parity only (a `serve` session gets the serve config's switches; the phone shows nothing new), with a follow-up `feat/mobile-tool-toggles` (P1 switches in Session info, mockups first)? **Rec yes.** The owner's motivation is the qwen context on the Mac. The wire (`session/tools`, `kind:"tool"`) is built here, so the phone task is UI only.
9. **Token figure:** the heuristic estimate (`~N`, free, instant, identical on every runtime), or an exact provider count per tool (N extra count calls, and over a pod they go through the laptop)? **Rec the heuristic `~N`.** It is for ranking what to switch off. The context meter already shows the exact total after a switch.

**Owner answers (2026-11-20):** Owner questions 1–9 all as recommended. Implementation APPROVED. Follow-up row to add: feat/mobile-tool-toggles (Q8).

## Execution

*— claude-opus-5-5, 2026-11-20*

**Load-bearing assumption re-verified first.** `rg` for `ChatRequest`s built outside `agent.ts`: compaction (`compact.ts:126/165`) and the title (`session-title.ts:96`) send `tools: []`; `proxy-model.ts:87` only forwards `request.tools`. So `projectTools` is the one tool list of every model request.

### S1 — names, config, agent projection

- `packages/config/src/tool-groups.ts` (new, exported): `ALWAYS_ON_TOOLS`, `TOOL_GROUPS`, `BUILTIN_TOOL_NAMES`, `expandToolName`, `groupOfTool`, `disabledToolsOf` (groups first, then single names: the single name wins both ways), `toolToggleIssues`, `toolEnabledIssues` (base + each merged profile, like `modelRefIssues`), `toolToggleNotices`.
- `schema.ts`: `tools.enabled: z.record(z.boolean())` + `toolEnabledIssues` in `FileConfigSchema.superRefine`. `profile.ts`: `tools.enabled` merges per key. `resolve.ts` + `load.ts`: `disabledTools` (and the raw `toolsEnabled`, for the notices) on `ResolvedConfig` and `TentacleConfig`. `key-docs.ts` (`tools.enabled`, `tools.enabled.*`), the `DEFAULT_CONFIG_JSONC` template, README config table regenerated (`bun run docs:config`).
- `packages/agent/src/capabilities.ts`: `disabledTools` in the state, `kind: "tool"`, a group = one op, `CapabilityRefusal` (thrown) for an unknown name or `skill`, `isToolDisabled` (never `skill`), `projectTools` drops disabled built-ins; `agent.ts` `hiddenCallRefusal` refuses them.
- `packages/cli/src/wiring.ts`: `new Agent({ capabilities: { ...NO_CAPABILITIES, disabledTools: config.disabledTools } })` and the `toolToggleNotices` through `options.notice ?? options.log`.

**Drift (S1):**
1. *Type ripple pulled forward from S2.* Making `disabledTools` required on the agent's `SessionCapabilities` does not compile without the wire field, so S1 also carries: `disabledTools?` on `SessionCapabilitiesSchema` (protocol), `toWireCapabilities` + a new `fromWireCapabilities` (`daemon/mapping.ts`, `?? []`), the third set in `normalizeCapabilities`/`hasDisabled` (`hosted-session.ts`), in the log entry (`session-log.ts`), in `lastCapabilities` (`session-log-file.ts`, now returns the agent state via `fromWireCapabilities`), `DaemonSessionRecord.capabilities` typed as the agent state, the seed in `session-host.ts` via `fromWireCapabilities`, `cli/session-capabilities.ts` `wireCapabilities`. Existing capability tests that pinned the exact two-set shape now expect `disabledTools: []` (the new daemon always sends it). `protocol.json` regenerated with `bun run schema:export` (the drift test runs in `bun run check`; the merge's `protocol:bump` regenerates it again, no note: additive).
2. *Parity pin location.* `packages/agent/test/tool-names-parity.test.ts`, not `packages/tools/test/`: `@tentacle/tools` does not depend on `@tentacle/config` (no hoisted workspace link), and `@tentacle/agent` depends on both.
3. *Refusal is a thrown `CapabilityRefusal`*, not a returned value: `applyCapabilityOp` keeps its return type (the state) and its identity contract; the daemon maps the throw to `InvalidParams` (S2).
4. *`shell` is both a group and a tool name.* With the owner's names, `"shell": false` means the group (shell, shell_output, shell_kill); the `shell` tool alone cannot be switched separately. Accepted as the owner's naming; noted for Review.

**Evidence (S1).** New tests: `config/test/tool-groups.test.ts`, `config/test/profile.test.ts` (+3), `config/test/load.test.ts` (+6), `agent/test/capabilities.test.ts` (+7), `agent/test/agent-capabilities.test.ts` (+6, recorded `ChatRequest.tools`, spy `execute` + permission spy), `agent/test/tool-names-parity.test.ts`, `cli/test/wiring.test.ts` (+3). Red: on `main` none of these compile (symbols absent); the property-level red is the mutation run (`.tentacle/tmp/tool-toggles/mutate.sh`: apply one mutation, run the named files, restore):

```
== M1 projectTools without isToolDisabled
(fail) built-in tool switches (disabledTools) > a config-seeded set keeps those tools out of EVERY model request; skill stays
(fail) built-in tool switches (disabledTools) > set mid-session: the next request drops the tool, and switching it back restores it
(fail) tools.enabled seeds the agent (docs/feat/tool-toggles.md D4) > buildAgent seeds disabledTools; a plain/one-shot request carries none of them
 61 pass / 3 fail
== M2 hiddenCallRefusal without isToolDisabled
(fail) built-in tool switches (disabledTools) > a call to a disabled tool is refused, never executed, and asks no permission
(fail) built-in tool switches (disabledTools) > a child (explore) never gets a tool the parent disabled — its own `search` included — and its call is refused
 17 pass / 2 fail
== M3 isToolDisabled without the skill guard
(fail) … projectTools drops a disabled built-in; never skill, even with skill in the set
(fail) … isToolDisabled reads the set; skill never
(fail) … skill in the set (a hostile seed) never hides the skill tool nor refuses its call
 43 pass / 3 fail
== M4 wiring seed removed
(fail) tools.enabled seeds the agent … buildAgent seeds disabledTools; a plain/one-shot request carries none of them
 44 pass / 1 fail
== M5 profile merge whole-replace
(fail) tools.enabled in a profile … merges per key over the base's; a profile true undoes a base false
(fail) tools.enabled in a profile … a profile without enabled keeps the base's map; other tools keys merge as before
(fail) tools.enabled … a selected profile's switches merge over the base's
 50 pass / 3 fail
== M6 schema superRefine dropped
(fail) tools.enabled … an unknown name is a ConfigError naming it
(fail) tools.enabled … skill is a ConfigError: always on
(fail) tools.enabled … a bad name inside a profile is refused too, even when the profile is not selected
 35 pass / 3 fail
== M7 single name does not beat group (one pass)
(fail) disabledToolsOf > groups expand; the result is sorted and de-duplicated
(fail) disabledToolsOf > a single tool beats its group, in both directions (Q2), whatever the key order
 9 pass / 2 fail
```

Green: `bun test packages/agent packages/config packages/protocol packages/daemon packages/cli/test/wiring.test.ts packages/cli/test/session-capabilities-resume.test.ts` → 3142 pass, 1 skip (opt-in), 0 fail; `tsc --noEmit` clean; `biome check .` clean.

### S2 — wire, daemon, client

- Protocol: `"tool"` in `SetCapabilityParamsSchema.kind`; new `packages/protocol/src/tools.ts` (`ToolListEntrySchema`, `SessionToolsParams/ResultSchema`, `MAX_TOOL_LIST = 128`), `Method.SessionTools` + `RequestSchemas`, index export; `protocol.json` regenerated (`bun run schema:export`). No `UPDATE_CLASS` change (the `capabilities` update keeps its kind and class; it carries the third array). Additive only → no `protocol.d/` note.
- Daemon: `hosted-session.ts` — a new session's `caps` start from `normalizeCapabilities(agent.capabilities())` (the host config's set, D4; logged in the first segment by the existing `logSegmentFacts`), a restart keeps the record's (Q4); `seedCapabilities` is a UNION (off wins); `setCapability` maps a `CapabilityRefusal` to `InvalidParams` and caps each set at `MAX_DISABLED_CAPABILITIES` (`disabledTools` included); `tools()` for `session/tools`. `session-host.ts` `newSessionTools` (a throwaway agent from the same `createAgent` factory as `newSessionContext`). `connection.ts` routes `session/tools` (no lock). `mapping.ts` `toSessionTools`. The pure list is `builtinToolList` in `agent/capabilities.ts` (+ `Agent.builtinTools()`): registered, non-MCP defs, group from the config table, `HeuristicTokenCounter.countText(JSON.stringify(def))`, `disabled`, `locked` on `skill`.
- Client: `RemoteClientOptions.baseDisabledTools`, unioned into every `openSession` create (`withBaseTools`); `seedCapabilitiesOnCreate` keeps `disabledTools`; `setSessionCapability`/`RemoteSession.setCapability` take `"tool"`; `RemoteClient.sessionTools()` + `RemoteSession.tools()`.
- CLI: `LocalRuntimeDeps.baseDisabledTools` → the client; set from `config.disabledTools` by the in-process worker (`local-runtime.ts`) and by `run`/`attach` (`engine-runtime.ts`, both `createLocalRuntime` sites).
- Sidecar: untouched (`daemon-state-file.ts` folds `capabilities` from the log via `lastCapabilities`; no field of its own).

**Drift (S2):**
1. *F6 corrected in the plan* (see the F6 row): a resumed round runs with no capability guard by design (`agent.ts:1341-1344`), so no "resumed path reads the current caps" test was written.
2. *`connect` does not pass `baseDisabledTools`.* `connect` loads no model/profile config (`connect.ts` reads the file only for palette/voice, and a broken file must never block it); the `serve` daemon's own `tools.enabled` seeds every session it creates (D4), which is also exactly what the phone gets. Adding a laptop seed there would need a profile-aware config load in `connect`. Left for Review/owner.
3. A `recreate` (a daemon that lost the session) carries the session's last snapshot as before, not unioned with the base: it is a continuation of the session, not a create (Q4).

**Evidence (S2).** New tests: `protocol/test/tools.test.ts` (6), `json-schema.test.ts` fixtures for `session/tools`, `daemon/test/tool-toggles.test.ts` (8, real `Connection` + `SessionHost`, recorded `ChatRequest.tools`), `client/test/session-capabilities.test.ts` (+3). The old protocol test that pinned `kind: "tool"` as INVALID went red on the schema change (`params: a delta of one name; bad kinds …`) and now uses `"plugin"`. Mutations (each red, then restored):

```
== N1 daemon caps start from NO_CAPABILITIES (host config ignored)
(fail) the host config seeds the daemon's truth (D4) > a created session snapshots the config's set, logs it in the first segment, and the model never gets it
(fail) the host config seeds the daemon's truth (D4) > a seed UNIONS with the host's set: it adds, it can never remove (a pod cannot re-enable)
(fail) session/tools (D6) > lists registered built-ins with group, tokens, locked skill, disabled flags — and no MCP tool
 5 pass / 3 fail
== N2 seed replaces instead of union
(fail) the host config seeds the daemon's truth (D4) > a seed UNIONS with the host's set: it adds, it can never remove (a pod cannot re-enable)
 7 pass / 1 fail
== N3 CapabilityRefusal not mapped to InvalidParams
(fail) session/set_capability{kind: tool} > skill or an unknown name is InvalidParams and changes nothing
 7 pass / 1 fail
== N4 client: base not unioned
(fail) baseDisabledTools rides every create > a new session, a resume from the laptop's copy and a /clear fork all start with it
 8 pass / 1 fail
== N5 session/tools lists MCP tools too
(fail) session/tools (D6) > lists registered built-ins with group, tokens, locked skill, disabled flags — and no MCP tool
 7 pass / 1 fail
== N6 session/tools never flags disabled
(fail) session/tools (D6) > lists registered built-ins … ; (fail) … with no session: the built-ins a session created now would have
 6 pass / 2 fail
```

Green: `bun test packages/agent packages/config packages/protocol packages/daemon packages/client packages/cli` → 6639 pass, 3 skip (the opt-in ones), 0 fail; `tsc --noEmit` clean; `biome check .` clean.

### S3 — TUI `/tools`

- `packages/tui/src/capability-toggles.ts`: `CapsView.disabledTools?` (absent = the daemon has no tool switches), `CapKind` `"tool"`, `SwitchState` `"partial"` (`[~]`), `toolsPhase` (an `on` report without `disabledTools` ⇒ `unsupported`, F8), `toolSwitch`, `groupSwitch`, `switchOp` turns a partial group ON (Q7), `capsMarker` adds `N tools off`, `capsDiff` covers the third kind, `remoteChangeNotices` matches a group op's per-member echo through `CapOp.members` (so the person's own group switch is not reported as another device's change).
- `packages/tui/src/tools-panel.ts` (new, pure): items (a group where its first member is; ungrouped tools alone), `TreeGroup` rows with switch + `~tokens` (+ `N tools`, `always on` for `skill`), the title `Tools · ~<offered> tokens · <n> off · <phase note>`, `toolsSwitchOp` (group head → group op with its members; member / single tool → that tool; `skill` → none), `toolsNoSwitchNotice`.
- Panel: `panels/tools.ts` descriptor + ONE line in `PANEL_KINDS`; `TreePanel` gains `kind: "tools"` + `toolsPanel()`; the `PanelKind` descriptor gains an optional `noSwitchNotice`, reached by a new facade `panelNoSwitchNotice` that `App.switchCapability` now calls (the only `App.tsx` change; the set path itself is unchanged and the row still flips only on the echo).
- Command `commands/tools.ts` (+ registry line, `toolsListError`: an older daemon's `MethodNotFound` says "This daemon doesn't support /tools (it predates it)"); `SessionController.tools?()` in `app-types.ts`, wired in `cli/local-runtime.ts` to `RemoteSession.tools()`.
- `changelog.d/tool-toggles.added.md`; `TODO.md` row `feat/mobile-tool-toggles` (Q8).

**Drift (S3):**
1. *No `panels/ToolsPanel.tsx`.* `/mcp` and `/skills` have no component of their own either: every tree panel renders through the generic `components/ListPanel.tsx` from a `PanelView`. `/tools` follows that pattern (a descriptor + a pure projection), so there is no new component and no `usePanels.ts` edit.
2. *Group-echo matching via `CapOp.members`* instead of a table in the TUI: the TUI has no `@tentacle/config` dependency (the plan assumed it had), and the panel's own list already knows a group's registered members.
3. Existing structure pins updated: `app-panels-structure.test.tsx` (six kinds, five `kindOf(panel)` facade calls), `app-commands.test.tsx` (`/tools` in `SLASH_COMMANDS`, its "not available" line).

**Evidence (S3).** New tests: `tui/test/tools-panel.test.ts` (12, pure: `toolsPhase`, `toolSwitch`, `groupSwitch`, Q7, marker, diff/notices, items, rows, title, Space ops, the facade), `tui/test/tools-panel-app.test.tsx` (5, ink-testing-library frames: `~N` rows, ONE `setCapability("tool", "visuals", false)` and the flip only on the echo, partial → on, locked `skill` sends nothing, an older daemon shows no switch + an honest line, `not-open` before the first message with `/mcp`'s words). Red: the four structure pins (`app-commands`, `commands-registry`, `panels-registry`, `app-panels-structure`) went red when `/tools` was registered and were updated deliberately. Mutations (`bash .tentacle/tmp/tool-toggles/mutate.sh …`, each red, then restored):

```
== T1 partial group turns OFF
(fail) tool switches … Space on partial turns the group ON (Q7) …
(fail) /tools in the App … a partially-off group shows [~] and Space turns it ON (Q7)
 15 pass / 2 fail
== T2 no toolsPhase (old daemon treated as having tool switches)
(fail) … toolsPhase …; (fail) … toolSwitch …; (fail) … groupSwitch …; (fail) … the title …; (fail) … through the panel facade …
(fail) /tools in the App … an older daemon (no disabledTools) shows no switch and an honest line; Space says so
 11 pass / 6 fail
== T3 group echo not matched by members
(fail) … a group op's own echo is no news
(fail) /tools in the App … rows carry ~N; Space on a group sends ONE group set; the row flips only on the echo
 15 pass / 2 fail
== T4 panel facade ignores the kind's notice
(fail) … through the panel facade …; (fail) /tools in the App … an older daemon …
 15 pass / 2 fail
== T5 group head sends nothing
(fail) … Space: a group head → the group …; (fail) /tools in the App … ONE group set …; (fail) … partially-off group …
 14 pass / 3 fail
```

Green (narrow): `bun test packages/tui` → 2869 pass, 0 fail after the structure pins were updated.

### Gate

`bun run check` (typecheck → lint → test), on the S3 commit + the guard fix below:

```
$ tsc --noEmit && tsc -p apps/mobile --noEmit && tsc -p apps/relay --noEmit
$ biome check .
Checked 2139 files in 617ms. No fixes applied.
 15803 pass
 5 skip
 0 fail
Ran 15808 tests across 1123 files. [490.43s]
EXIT=0
```

The 5 skips are the opt-in ones (live k8s ×2, live docker ×2, the slow keepalive), none from this task. Before that: run 1 failed one more structure guard (`cli/test/subagent-panel-controller.test.ts`, the exact list of forwarded `SessionController` members: `tools` added, uncommitted at hand-off); run 2 failed `engine-runtime.test.ts` "startPodRuntime > creates + readies a pod…" once (a 20 ms wait under full-suite load; green in run 1, run 3 and 5/5 alone) — a pre-existing timing flake, not this change.

### Unverified / for Review

- No live run against a real pod or a real `serve` + phone: the pod path (laptop seed ∪ pod config, off wins) is proven with the in-process `SessionHost` + `Connection` (daemon tests) and the client tests, not end to end over `run`/`attach`.
- The heuristic `~N` is `ceil(len(JSON.stringify(def))/4)`, not a provider count (Q9); the context meter remains the exact figure.
- `connect` sends no laptop seed (S2 drift 2); `shell` names both the group and the tool (S1 drift 4).

