# feat/hooks-core — hook runner, `stdin` in core, `tool_call` → `PermissionGate`, `tool_result` → result pipeline

> **Status:** feat — promoted 2026-10-22. Owner decisions D1–D9 in the umbrella; H1–H4 decided 2026-10-21. Implementation approved.
> **Branch:** `feat/hooks-core`
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing (the agent loop's tool path, `PermissionGate`, core `ExecOptions`) · **Review:** mandatory fresh-context
> **Umbrella:** [`extensibility.md`](../eval/extensibility.md) (child 2 of 5) · **Needs:** `tool-naming` merged ✓ (the H1 line uses `toolLabel`) · **Note:** matchers use tool **names** (`shell`, `fs_edit`, …), never the CamelCase display labels of [`tool-naming.md`](../feat/tool-naming.md)

## Context

*— claude-opus-5-5, 2026-10-21*

### The question

The first slice of user hooks: **user-scope** hooks (the global
`config.jsonc`) on the two tool events, `tool_call` and `tool_result`. It also
builds the shared pieces the later children reuse: the config key, the
`stdin` support in core, and the `HookRunner`.

### State today (verified against `main` @ 399ea0b)

| Fact | Evidence |
|---|---|
| No hook mechanism exists in `packages/*/src` (the only `hooks` hits are React hooks) | `git grep -n hooks main -- 'packages/*/src'` → `tui/src/App.tsx:25`, `tui/src/components/Thinking.tsx:3` |
| The config schema is `.strict()`, so a `hooks` key is a load **error** today | `config/src/schema.ts:4` (comment), `:154` (`FileConfigSchema`) |
| A config setting threads through 4 places (example: `autoWake`): `schema.ts` `settingsShape` → `resolve.ts` `ResolvedConfig` + `resolveConfig` → `load.ts` `TentacleConfig` + its return → `defaults.ts` template | `config/src/schema.ts:103`, `resolve.ts:66,90,271,306,327`, `load.ts:67,299`, `defaults.ts:105` |
| A profile's top-level setting replaces the base one (only `model`/`subagents`/`tools`/`mcpServers` merge) | `config/src/profile.ts:6-10,61` |
| `config` does not depend on `core` | `config/package.json` (deps: `jsonc-parser`, `zod`) |
| `ExecOptions` = `{ cwd, env, timeoutMs, signal }`: **no stdin** | `core/src/execution.ts:15-20` |
| The only real `ExecutionEnvironment` is `HostExecution`. It spawns `/bin/sh -c` with `stdin: "ignore"` in its own process group; abort/timeout kill the group | `exec/src/host-execution.ts:74,89-127,154-170` (stdin at `:158`) |
| `HostExecution` scrubs secret-looking env vars from the child env and overlays `options.env` | `exec/src/host-execution.ts:194-200` |
| The gate decides from the tool's static level only: `"none"` → run, `"deny"` → refuse, `"ask"` → remembered rule or the requester | `agent/src/permission-gate.ts:63-79` |
| "Allow always" rules live in the gate (shell prefix / whole tool) | `agent/src/permission-gate.ts:55-58,90-99` |
| The gate is built privately in `Agent`; `authorize` has exactly **one** call site | `agent/src/agent.ts:222,228,754` |
| `runTool`: parse args (malformed → `{}`) → `authorize` → abort check → refusal text → `tools.execute(call.name, call.arguments, ctx)`, i.e. it executes the **raw** argument string | `agent/src/agent.ts:745-770` |
| The registry validates parsed args against the tool's zod schema; every failure is an error `ToolResult` | `tools/src/registry.ts:52-75` |
| One call's sequence: `tool_start` → `runTool` → `transformResult` → `tool_result` → push → `history_commit` | `agent/src/agent.ts:594-640` |
| `ResultTransformContext` = `{ toolName, toolCallId, signal?, writeSpill }` (no tool input) | `agent/src/result-pipeline.ts:16-27` |
| `transformResult` builds that context and runs the list in order | `agent/src/agent.ts:718-743` |
| Pipeline order in wiring: `redactSecrets` first, then dedup / tabulate / spill-or-summary (`skill` exempt from shaping) | `cli/src/wiring.ts:111-129` |
| Sub-agents: a child `Agent` gets the parent's `requestPermission` and `resultTransforms` (so a **new** `PermissionGate` of its own) | `agent/src/subagent.ts:160-168`; wiring `cli/src/wiring.ts:167,170` |
| MCP tool names: `mcp__<server>__<tool>` | `mcp/src/tool-adapter.ts:40-42` |
| Test pattern for the loop: `ScriptedProvider` + a fake `ExecutionEnvironment` + `collect(agent.run(...))` | `agent/test/permission.test.ts:13-58` |

**Repro (2026-10-21, `main` @ 399ea0b):** no seam exists, and the strict
schema has no slot.

```
$ git grep -n hooks main -- 'packages/*/src'
main:packages/tui/src/App.tsx:25:import { useLineEditor, useLinkIndicator, usePaintScheduler } from "./hooks.ts";
main:packages/tui/src/components/Thinking.tsx:3:import { useElapsed } from "../hooks.ts";
$ git show main:packages/core/src/execution.ts | sed -n 15,20p
export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
```

### Sub-decisions (all DECIDED by the owner, 2026-10-21)

- **H1: the user sees hook interventions in the TUI**, as a sub-line under
  the tool call:

  ```
  ⏺ Bash rm -rf build
    ⎿ hook no-rm blocked Bash
      rm -rf not allowed in this repo
  ```

  `blocked` when a hook denied the call, `modified` when a hook rewrote its
  input (`⎿ hook <name> modified Bash input`). Format (owner, 2026-10-21):
  `hook` in lowercase, because the line is an annotation under the tool
  title, not a second title. The hook name is unquoted and may be coloured
  (accent). On `blocked`, the body below shows **only the hook's reason**
  (subtle), never the model-facing text `Blocked by a hook: … Reason: …`,
  which would repeat the line. The model still gets that full text. `<name>` is the hook's `name`
  (a new optional config field), defaulting to the basename of the first
  word of `command`. `Bash` is the display label (`toolLabel`, from
  [`tool-naming.md`](../feat/tool-naming.md)). No protocol bump: the information
  rides as an extra `resource` block in the existing `tool_call_update`
  content, like the diff does (design §7). Hook *failures* (crash/timeout
  with `onFailure: "ignore"`) go to the daemon log only.
- **H2: hooks run for sub-agent tool calls**, with
  `agent: { type, description }` in the input so a hook can tell.
- **H3: a hook `allow` cannot override a `"deny"`-level tool**; `"deny"`
  stays absolute.
- **H4: the model is told when its input was rewritten**: the result content
  gets a first line, `[hook] input modified by hook <name>; ran with: <json,
  max 500 chars>`. The history keeps the model's original arguments, so
  without the note the model would see a result that does not match its own
  call.

## Implementation

*— claude-opus-5-5, 2026-10-21 (draft; approved at promotion)*

### Load-bearing assumption

Every tool call passes through **one** `authorize` call
(`agent/src/agent.ts:754`), and every result that enters the context passes
through **one** method, `transformResult` (defined `agent/src/agent.ts:718`).
That method has three callers:
- `:628`, a model tool call;
- `:668`, the user's `/skill` round;
- `:289`, the `/compact` skill re-read.

So `tool_call` hooks attach in exactly one place and `tool_result` hooks in
exactly one place. That covers MCP tools, `skill` and `agent_task`, and
sub-agents too, since each child is an `Agent` with the same code path.

Note: the user's `/skill` round and the compaction re-read do **not** go
through `authorize`, so they get `tool_result` hooks but no `tool_call`
hooks. That is intended: no tool *call* was made.

Verify first: `git grep -n "authorize(\|transformResult(" packages/agent/src`
must show exactly these call sites.

### Preconditions

- The RPC peer dispatches requests concurrently (AGENTS §7), so a hook
  awaited inside a turn does not block `session/enqueue`, `session/cancel` or
  `session/resolve_permission`.
- The abort is re-checked after `authorize` (`agent/src/agent.ts:755-761`):
  a hook running when the user cancels cannot start the tool.
- Bun's `Bun.spawn` accepts a `Blob` as `stdin`. **Prove it with the first
  red test** (`exec("cat", { stdin: "x" })` → stdout `"x"`) before building on
  it.

### Design

#### 1. Config (`hooks` key)

`config.jsonc`:

```jsonc
"hooks": [
  { "event": "tool_call", "matcher": "shell", "command": "~/.config/tentacle/hooks/no-rm.sh" },
  { "event": "tool_result", "matcher": "mcp__.*", "command": "python3 ~/hooks/redact.py", "timeout": 30, "onFailure": "block" }
]
```

Zod (in `config/src/schema.ts`, added to `settingsShape`):

```ts
const HookEventSchema = z.enum(["tool_call", "tool_result", "turn_start", "turn_end", "model_request"]);
export const HookSpecSchema = z
  .object({
    event: HookEventSchema,
    /** Shown in the TUI ("hook <name> blocked Bash") and in logs. Default: basename of the first word of `command`. */
    name: z.string().min(1).max(40).optional(),
    /** Tool events only: a name, `a|b` alternatives, or a JS regex (unanchored). Absent / "*" = all. */
    matcher: z.string().min(1).optional(),
    /** Run with /bin/sh -c in the session's working folder; JSON input on stdin. */
    command: z.string().min(1),
    /** Seconds; default 600. */
    timeout: z.number().int().positive().optional(),
    /** A failed hook (crash, timeout, bad output): "ignore" (default) or "block". */
    onFailure: z.enum(["ignore", "block"]).optional(),
  })
  .strict()
  .refine((h) => h.matcher === undefined || h.event === "tool_call" || h.event === "tool_result", {
    message: "matcher is only valid on tool_call / tool_result",
  });
// in settingsShape:
hooks: z.array(HookSpecSchema).optional(),
```

All five event names are accepted now: children 3 and 4 add their behaviour,
and an unknown event is a load error (strict), not a silent no-op. Until
child 3 lands, a `turn_start` / `turn_end` / `model_request` hook is loaded
but never run: say so in the defaults template comment.

A matcher that looks like a regex is compiled at load; an invalid regex is a
`ConfigError` naming the hook. Profiles: `hooks` is a top-level setting, so a
profile's `hooks` **replaces** the base list (`profile.ts:61`), consistent
with the existing rule. Write that in the template comment.

Thread it like `autoWake`: `ResolvedConfig.hooks: readonly HookSpec[]`
(default `[]`), `TentacleConfig.hooks`, template line in `defaults.ts`. No env
override.

#### 2. Core types and `stdin`

`core/src/hooks.ts` (new; `core` is what `agent`, `cli` and `tui` share, and
`config`'s zod-inferred type is structurally identical):

```ts
export type HookEvent = "tool_call" | "tool_result" | "turn_start" | "turn_end" | "model_request";
export interface HookSpec {
  readonly event: HookEvent;
  readonly name?: string;
  readonly matcher?: string;
  readonly command: string;
  readonly timeout?: number;
  readonly onFailure?: "ignore" | "block";
}
```

`core/src/execution.ts`: `ExecOptions` gains

```ts
/** Written to the child's stdin, then closed. Absent → stdin is ignored. `spawnBackground` ignores it. */
readonly stdin?: string;
```

`exec/src/host-execution.ts` `spawnShell`:
`stdin: options?.stdin !== undefined ? new Blob([options.stdin]) : "ignore"`.
Adjust the `Subprocess<"ignore", "pipe", "pipe">` return type to whatever
Bun's typings require (e.g. `Subprocess<"ignore" | Blob, "pipe", "pipe">`, or
widen the stdin parameter). Fake envs in tests need no change (the field is
optional).

#### 3. The runner: pure core + thin exec (AGENTS §7)

`agent/src/hooks.ts` (new). The **pure** functions are unit-tested without
processes:

```ts
/** Does `spec` apply to this tool? No matcher or "*" → yes; `a|b` names → exact; else RegExp. */
export function hookMatches(spec: HookSpec, toolName: string): boolean;

/** Turn one hook process outcome into a decision. */
export function parseToolCallOutcome(r: ExecResult | "timeout" | "error", onFailure): ToolCallVote;
export function parseToolResultOutcome(r: ExecResult | "timeout" | "error", onFailure): ResultVote;

/** Fold the votes of every matching hook, in config order. */
export function combineToolCallVotes(votes: readonly ToolCallVote[]): ToolCallVerdict;
```

Votes and verdicts:

```ts
type ToolCallVote =
  | { kind: "none" }                       // exit 0, no/empty decision
  | { kind: "allow" }
  | { kind: "ask" }
  | { kind: "deny"; reason: string }
  | { kind: "modify"; input: unknown; decision?: "allow" | "ask" }; // exit 0 with `input`
type ToolCallVerdict =
  | { kind: "deny"; reason: string; hook: string }
  | { kind: "gate"; input: unknown; modified: boolean; force: "allow" | "ask" | null };
```

Process outcome → vote:

| Outcome | `tool_call` | `tool_result` |
|---|---|---|
| exit 0, stdout empty | none | pass |
| exit 0, stdout a JSON object | `decision` ∈ allow/ask/deny (+`reason`), `input` (object) → modify | `content` (string) → replace, with optional `is_error` (boolean) |
| exit 0, stdout not a JSON object, or > 1 MiB | failure | failure |
| exit 2 | deny, reason = stderr (trimmed, max 2000 chars; empty → "blocked by hook") | replace with `{ content: stderr, isError: true }` |
| other exit code, timeout (`exitCode` 124 after our kill), spawn error | failure | failure |
| **failure** with `onFailure: "ignore"` (default) | none, plus a log line | pass, plus a log line |
| **failure** with `onFailure: "block"` | deny, reason = "hook failed: …" | replace with `{ content: "hook failed: …", isError: true }` |

Combination (`tool_call`, hooks run **sequentially** in config order, each
seeing the input as rewritten by the previous ones):

- the first `deny` stops the chain → verdict `deny`;
- `modify` chains the input;
- if any vote is `ask` → `force: "ask"`;
- else if at least one hook matched and **every** matching hook voted
  `allow` (a `modify` with `decision: "allow"` counts as allow) →
  `force: "allow"`;
- else `force: null` (normal gate).

The runner (thin, does I/O):

```ts
export interface HookRunnerOptions {
  readonly specs: readonly HookSpec[];
  readonly env: ExecutionEnvironment;
  readonly cwd: string;
  readonly log?: (line: string) => void;
  /** Set for a sub-agent's runner (H2). */
  readonly agent?: { readonly type: string; readonly description: string };
}
export class HookRunner {
  constructor(opts: HookRunnerOptions);
  /** A runner for a sub-agent: same specs/env, `agent` set (H2). */
  forAgent(agent: { type: string; description: string }): HookRunner;
  hasAny(event: HookEvent): boolean;
  toolCall(i: { sessionId: string; toolName: string; toolCallId: string; input: unknown; signal: AbortSignal }): Promise<ToolCallVerdict>;
  toolResult(i: { sessionId: string; toolName: string; toolCallId: string; input: unknown; result: ToolResult; signal?: AbortSignal }): Promise<ToolResult>;
}
```

Each hook runs as
`env.exec(spec.command, { stdin: JSON.stringify(input), signal, timeoutMs: (spec.timeout ?? 600) * 1000, cwd, env: { TENTACLE_HOOK_EVENT: event, TENTACLE_PROJECT_DIR: cwd } })`.

The stdin JSON (snake_case, stable; it is the user-facing contract):

```jsonc
// common
{ "event": "tool_call", "session_id": "…", "cwd": "/abs/path", "agent": null /* or {"type","description"} */,
// tool_call
  "tool_name": "shell", "tool_call_id": "c1", "tool_input": { "command": "rm -rf build" } }
// tool_result adds: "tool_result": { "content": "…", "is_error": false }
```

#### 4. `tool_call` inside `PermissionGate`

`PermissionGate` gets an optional runner, and `authorize` returns an outcome
instead of a boolean:

```ts
export type GateOutcome =
  | { readonly allowed: true; readonly input: unknown; readonly modified: boolean }
  | { readonly allowed: false; readonly input: unknown; readonly by: "user" | "hook"; readonly reason?: string };

constructor(requester: PermissionRequester, hooks?: HookRunner)
async authorize(tool: Tool, input: unknown, call: { sessionId: string; toolCallId: string; signal: AbortSignal }): Promise<GateOutcome>
```

Order inside `authorize`:
1. `tool.permission === "deny"` → `{ allowed: false, by: "user" }`. **Before
   hooks** (H3); the message stays today's.
2. `hooks?.hasAny("tool_call")` → `verdict = await hooks.toolCall(...)`.
   - `deny` → `{ allowed: false, by: "hook", reason }`;
   - otherwise continue with `verdict.input` (**modify runs before** the
     level check and the prompt, so the user approves, and remembered rules
     match, the input that will actually run).
3. `force === "allow"` → `{ allowed: true }`, **never `remember()`ed**.
4. `tool.permission === "none"` and `force !== "ask"` → allowed.
5. `force !== "ask"` and `isRemembered(tool, input)` → allowed.
6. Prompt as today, `describeToolCall(tool, input)` built from the
   **effective** input; `remember()` only on a human `session` answer.

`runTool` (`agent/src/agent.ts:745-770`) changes to:
- pass `{ sessionId, toolCallId: call.id, signal: ctx.signal }` (add
  `sessionId` to `ToolContext` users: `toolContext.sessionId` already exists,
  `agent.ts:350-356`);
- keep the abort check exactly where it is, **before** looking at `allowed`;
- refusal text: `by: "user"` → today's
  ``Permission denied by the user: `${call.name}` was not run.``;
  `by: "hook"` → ``Blocked by a hook: `${call.name}` was not run. Reason: ${reason}``;
- execute `modified ? JSON.stringify(outcome.input) : call.arguments` (the
  raw string is kept when nothing changed, so behaviour is byte-identical
  without hooks);
- H4: when `modified`, prefix the returned content with the `[hook] input
  modified by hook <name>…` line;
- H1: set `result.hook = { action: "blocked", name, reason }` on a hook
  refusal (`reason` = the hook's own reason; omitted when it gave none) and
  `{ action: "modified", name }` when the input was rewritten (`name` = the
  last hook that modified it). `GateOutcome` therefore carries
  `hookName?: string` on both branches, and `ToolCallVerdict` records the
  deciding / last-modifying hook's name;
- return `{ result, input: outcome.input }`, so `runToolCalls` can hand the
  effective input to `transformResult`.

`Agent` constructor: `new PermissionGate(config.requestPermission ?? allowAll, config.hooks)`.
`AgentConfig` gains `readonly hooks?: HookRunner`.

#### 5. `tool_result` as a pipeline stage

- `ResultTransformContext` gains `readonly input?: unknown`,
  `readonly hooks?: HookRunner` and `readonly sessionId?: string`.
- `transformResult(call, result, signal)` (`agent.ts:718-743`) gains a 4th
  parameter `extra: { sessionId: string; input?: unknown }` and fills the
  context from it. `hooks` is `this.config.hooks`. When `input` is absent, it
  is `JSON.parse(call.arguments)`, or `{}` on a parse error (the skill rounds
  carry `{"name": …}`).
- Update all three callers:
  - `:628` passes `{ sessionId, input }` with the effective input returned
    by `runTool`;
  - `:668` passes `{ sessionId: toolContext.sessionId }`;
  - `:289` passes `{ sessionId }`.
- New exported stage in `agent/src/hooks.ts`:
  `export const runResultHooks: ResultTransform = (result, ctx) => ctx.hooks?.hasAny("tool_result") ? ctx.hooks.toolResult({...}) : result;`
  It reads the runner **from the context**, so the one shared transform list
  (`wiring.ts:124-129`, also given to sub-agents) automatically uses each
  agent's own runner, sub-agent identity included.
- Wiring inserts it **right after** `redactSecrets` and **before** the
  shaping stages. It is not wrapped in `shaping(...)`: `skill` results reach
  hooks too, and a hook never sees what redaction removed.

#### 6. Wiring and sub-agents

`cli/src/wiring.ts` `buildAgent`:
- `const hooks = config.hooks.length > 0 ? new HookRunner({ specs: config.hooks, env, cwd: config.cwd, log: options.log }) : undefined;`
- `BuildAgentOptions` gains `readonly log?: (line: string) => void`. Pass it
  from the worker (`cli/src/worker.ts`, its existing daemon-error logger) and
  from `serve` (`cli/src/serve.ts`, the `log` it already has). Verify the
  exact logger names at promotion; never write to the terminal while Ink
  owns it (AGENTS §7).
- `new Agent({ …, hooks })`; `createSubagentRunner({ …, hooks })`.

`agent/src/subagent.ts`: `SubagentDeps.hooks?: HookRunner`. The child gets
`hooks: deps.hooks?.forAgent({ type: type.name, description: opts.description })`.

#### 7. H1: the `⎿ hook <name> blocked <Tool>` line

How the information travels, with no new update type and no protocol bump:

1. **core**: `ToolResult` (`core/src/tool.ts:30-34`) gains
   `readonly hook?: { readonly action: "blocked" | "modified"; readonly name: string; readonly reason?: string }`
   (`reason`: the hook's own reason, set on `blocked` only; absent if the
   hook gave none). It is a separate field, not a new `ToolResultDetail`
   kind, because a modified `fs_edit` also carries a diff in `details`.
2. **daemon**: `toolResultContent` (`daemon/src/mapping.ts:113-130`) appends,
   when `result.hook` is set, a block
   `{ type: "resource", uri: "hook://<action>/<name>", mimeType: "application/x-tentacle-hook", text: <reason, if any> }`.
   This follows exactly the diff pattern (`diff://<path>`, same function).
3. **client**: `toolResultFromContent` (`client/src/mapping.ts:95-120`)
   recognises `uri.startsWith("hook://")`, parses `<action>/<name>` (the name
   may contain `/`: split on the **first** `/` only), takes `reason` from the
   block's `text`, and sets `hook`.
   **Compatibility:** an older client skips unknown resource blocks (the
   `else if` chain only takes `diff://`, `client/src/mapping.ts:103-113`), so
   this is additive.
4. **TUI**:
   - `tui/src/state.ts` copies `result.hook` onto the tool item, exactly
     where it copies `result.details` (`tui/src/state.ts:242`);
   - `render-lines.ts` `toolBody` (`:250-282`) puts as the **first** body
     line `theme.subtle("⎿ hook ") + theme.accent(name) + theme.subtle(rest)`,
     where `rest` is ` blocked ${toolLabel(tool.name)}` or
     ` modified ${toolLabel(tool.name)} input`. Then:
     - `blocked`: the body is the ⎿ line plus, if `reason` is set, `reason`
       split into lines and indented under it (`theme.subtle`). `resultText`
       is **not** rendered;
     - `modified`: the rest of the body (result text, diff) follows
       unchanged.

     The pure choice "which lines" belongs in a small function next to
     `toolBody` (`hookLines(tool): string[] | null`), so it can be unit-tested
     without SGR (§7).
5. **plain renderer** (`cli/src/render.ts`): the same text, and on `blocked`
   the reason, each on its own line after the tool line.

UI text is in English, like every other TUI string.

### Files (dependency order)

1. `packages/core/src/hooks.ts` (new), `packages/core/src/execution.ts`, `packages/core/src/tool.ts` (`ToolResult.hook`), `packages/core/src/index.ts`
2. `packages/exec/src/host-execution.ts` (+ `packages/exec/test/host-execution.test.ts`)
3. `packages/config/src/schema.ts`, `resolve.ts`, `load.ts`, `defaults.ts` (+ `config/test/resolve.test.ts`, `load.test.ts`, `profile.test.ts`)
4. `packages/agent/src/hooks.ts` (new), `permission-gate.ts`, `result-pipeline.ts`, `agent.ts`, `subagent.ts`, `index.ts` (export `./hooks.ts`)
5. `packages/daemon/src/mapping.ts`, `packages/client/src/mapping.ts` (H1 resource block)
6. `packages/cli/src/wiring.ts`, `worker.ts`, `serve.ts`, `render.ts`
7. `packages/tui/src/state.ts`, `render-lines.ts`
8. tests: `packages/agent/test/hooks.test.ts` (new), `permission.test.ts`, `result-pipeline.test.ts`, `subagent.test.ts`; `packages/cli/test/wiring.test.ts`; daemon/client mapping tests; `packages/tui/test/render-lines.test.ts`
9. docs: a user-facing section (README or `docs/`) with the input/output contract and the name ↔ label table

No protocol schema change and no `PROTOCOL_VERSION` bump: the H1 information
is an extra `resource` block, which the schema already allows
(`protocol/src/content.ts:20-26`).

### Failure modes

| Case | Convergence |
|---|---|
| Hook crashes / times out / prints invalid JSON | `onFailure` decides: "ignore" (default) = as if the hook were absent + a log line; "block" = deny / error result |
| `modify` produces input that fails the tool schema | the registry's validation (`registry.ts:68-74`) → `invalid arguments for <tool>` error result; the model can retry |
| `modify` on a tool the user pre-approved with a prefix rule | the rule is matched against the **modified** input (step 5), so a hook cannot smuggle a command past an approval |
| Cancel while a hook runs | `signal` kills the hook's process group (`host-execution.ts:100-107`); the post-`authorize` abort check returns "Cancelled by the user before this tool ran." |
| Large `tool_result` | goes through stdin, so there is no env/argv size limit; never argv (§7: `ps`-visible) |
| Hook stdout floods | > 1 MiB → treated as failure (`onFailure`) |
| Hook needs a secret from the env | `HostExecution` scrubs secret-looking vars (`host-execution.ts:194-200`); documented. Hooks read their own secrets |
| Suspended turn resumed (`docs/feat/suspended-turn-resume.md`) | the resumed call goes through `authorize` again, so hooks run again. Consistent: a hook is policy, not a recorded answer |
| No hooks configured | `hooks` is `undefined`; every path is byte-identical to today (raw arguments, same messages). Pinned by the existing suites staying green |
| Sub-agent tool call | same gate + pipeline; the input carries `agent` (H2) |
| `deny`-level tool + hook `allow` | still refused (H3; step 1 runs before hooks) |
| Pod (`run`/`attach`) | hooks come from the pod's own config and run in the pod: UX, never security (§7). Nothing new crosses to the laptop |

### Tests (red before green, §9; fakes, no real processes except in `exec`)

`agent/test/hooks.test.ts` (pure parts):
- `hookMatches`: no matcher, `*`, `shell`, `fs_edit|fs_multi_edit`,
  `mcp__.*`, a non-matching name.
- `parseToolCallOutcome`: every row of the outcome table, both `onFailure`
  values.
- `combineToolCallVotes`: deny short-circuits; modify chains; any ask →
  force ask; all-allow → force allow; one allow + one none → `force: null`.

`agent/test/permission.test.ts` (loop level, `ScriptedProvider` + a fake env
whose `exec` answers **hook commands** from a table keyed by command and
records `options.stdin`):
- hook `deny` → the tool never runs (`execCalls` has no tool command), the
  result text is "Blocked by a hook…" and **not** "Permission denied by the
  user".
- hook `modify` → the requester sees the modified input in
  `PermissionRequest.input`, and the tool runs with it.
- hook `allow` on an `"ask"` tool → no prompt; a second identical call
  **prompts** (proves `allow` is not remembered).
- hook `allow` on a `"deny"` tool → refused (H3).
- the hook's stdin JSON has `event`, `session_id`, `tool_name`,
  `tool_call_id`, `tool_input`.
- **Non-vacuity by mutation:** temporarily move the hook step after the
  prompt; the "requester sees the modified input" test must fail.

`agent/test/result-pipeline.test.ts`: `runResultHooks` with a stub runner in
the context replaces content; without `hooks` in the context it is the
identity.

`agent/test/subagent.test.ts`: a child's hook input has
`agent: { type, description }`.

`exec/test/host-execution.test.ts` (real process): `exec("cat", { stdin: "hello" })`
→ stdout `hello`. **Red first:** fails today, because stdin is ignored.

`config/test/*`: `hooks` parses; a matcher on `turn_start` is rejected; an
invalid regex matcher is a `ConfigError`; a profile's `hooks` replaces the
base list.

H1 (red first: today none of this exists):
- daemon `toolResultContent` with `hook` → a `hook://blocked/no-rm`
  resource block;
- client `toolResultFromContent` round-trips it, including a name containing
  `/`; a content array **without** it yields no `hook` (old-daemon
  compatibility);
- `tui/test/render-lines.test.ts`:
  - a blocked `shell` item with reason `rm -rf not allowed in this repo`
    renders exactly two body lines, `⎿ hook no-rm blocked Bash` and the
    reason. The model-facing `Blocked by a hook…` text must **not** appear;
  - blocked without a reason → only the ⎿ line;
  - a modified `fs_edit` renders `⎿ hook fmt modified Edit input` **and**
    still its diff;
- the daemon/client round-trip carries `reason` in the resource `text`;
- loop level (`permission.test.ts`): a hook deny yields a `tool_result`
  whose `result.hook` is `{ action: "blocked", name }`; the default name is
  the basename of the command's first word.

Gate: `bun run check` green; lint baseline clean.

## Execution

*— claude-opus-5-5, 2026-10-22*

**Verified first:** `git grep -n "authorize(\|transformResult(" packages/agent/src`
→ exactly `agent.ts:289,628,668` (transformResult) and `:754` (authorize), as
the load-bearing assumption states.

**Repro (feat/hooks-core @ 8f3b7eb, before any edit)**, `.tentacle/tmp/hooks-core/repro.ts`:

```ts
import { HostExecution } from "@tentacle/exec";
import { FileConfigSchema } from "../../../packages/config/src/schema.ts";
const r = await new HostExecution().exec("cat", { stdin: "hello" } as never);
console.log("exec cat stdin:", JSON.stringify(r.stdout));
const p = FileConfigSchema.safeParse({ hooks: [{ event: "tool_call", command: "x" }] });
console.log("hooks key parses:", p.success, p.success ? "" : p.error.issues[0]?.message);
```
```
exec cat stdin: ""
hooks key parses: false Unrecognized key(s) in object: 'hooks'
```

**As built, in the plan's order:**
1. core: `hooks.ts` (`HookEvent`, `HookSpec`), `ExecOptions.stdin`, `ToolResult.hook`, export.
2. exec: `spawnShell` writes `stdin` and closes it; `spawnBackground` strips it. Red first: `exec("cat", { stdin: "hello" })` → `Received: ""`.
3. config: `HookSpecSchema` in `settingsShape`, threaded `resolve` → `load` → template. Tests red on the old `src` (3 fails), green after.
4. agent: `hooks.ts` (pure `hookName` / `hookMatches` / `parse*Outcome` / `combineToolCallVotes`, `HookRunner`, `runResultHooks`); `PermissionGate.authorize` → `GateOutcome` in the plan's order; `runTool` returns `{ result, input }`; `transformResult` takes `{ sessionId, input? }` at all three callers; `AgentConfig.hooks`; `SubagentDeps.hooks` → `forAgent`.
5. daemon/client: the `hook://<action>/<name>` resource block (`HOOK_MIME`), parsed back on the first `/`. Client tests red on the old `src` (2 fails).
6. cli: `buildAgent` builds the runner and inserts `runResultHooks` right after `redactSecrets`; `BuildAgentOptions.log` comes from the worker (`logDaemonError`), from `startDaemon` (`options.onError`) and from the pod `serve --stdio` (`log`); `render.ts` prints the H1 lines.
7. tui: `state.ts` copies `hook`; `render-lines.ts` `hookLines` + `toolBody`. Render tests red on the old `src` (3 fails).
8. README "Hooks" section: the contract and the name ↔ label table.

**Non-vacuity by mutation** (each one reverted afterwards):
- prompt built from the original input → the modify test fails;
- `force: "allow"` ignored → the allow test fails;
- `ask` not overriding a remembered rule → the ask test fails;
- no abort check after the hooks → the cancel test fails;
- the child not given `forAgent` → the H2 sub-agent test fails;
- `runResultHooks` placed before `redactSecrets` → the wiring test fails.

The pure `hooks.test.ts` was written after `agent/src/hooks.ts`, so it was
never red on its assertions. The gate and loop properties are pinned by the
mutations above.

**Drift from Implementation:**
- `stdin` is a `Uint8Array` (`TextEncoder`), not a `Blob`. Bun's `Writable` typing rejects the DOM `Blob` type. Return type: `Subprocess<"ignore" | Uint8Array, "pipe", "pipe">`.
- `combineToolCallVotes(input, votes: NamedVote[])`: it takes the model's input and `{ hook, vote }` pairs, so the verdict can name the deciding or last-modifying hook. The runner still runs the hooks sequentially and stops at the first deny.
- The `none` / `pass` votes carry an optional `failure` string, so the runner can log an ignored failure while the parse functions stay pure.
- `hookLines(tool)` returns a plain view-model, `{ name, rest, reason[], replacesBody } | null`, not `string[]`. The SGR stays in `toolBody` (§7 split).
- Added, not in the plan: after the hooks, `authorize` returns a refusal when the signal is aborted, so the user is never prompted after a cancel. `runTool`'s abort check then reports it as cancelled.
- A `deny`-level tool returns before the hooks, so its hooks never run (test asserts no hook stdin).
- `tool_result` replace keeps `details` and `hook`. `is_error` falls back to the original result's value when the hook omits it.
- The invalid-regex check is a zod `superRefine`, so it surfaces as `ConfigError("Invalid <path>: hook \"<name>\": invalid matcher regex …")`. The plain-name pattern is duplicated in `config` and `agent`, because `config` does not depend on `core`.
- No `log` in the headless/plain `main.ts` paths (`buildAgent(config)`). There, an ignored hook failure is silent.

**Observation:** a `tool_result` hook's `tool_input` is the model's own
arguments, which are not redacted. Only the result is. The wiring test shows
the secret the model typed in `tool_input`.

**Gate:** `bun run check`: typecheck clean, lint clean (0/0), `1683 pass / 2 skip / 0 fail` (the two opt-in skips).

**Post-review fixes** (*— claude-opus-5-5, 2026-10-22*). Each new test was shown RED under the stated mutation, then the mutation was reverted:
- The gate matches remembered rules against the **rewritten** input. New test: a remembered `git status` rewritten by a hook to `rm -rf x` prompts with `rm -rf x`. Mutation: `isRemembered(tool, input)`.
- A hook `ask` prompts on a `"none"`-level tool. Mutation: drop `&& force !== "ask"`.
- `HookRunner`: a hook killed by the user's cancel now casts no vote and logs nothing, on both `tool_call` and `tool_result`. Before, it read as "exited 124", and with `onFailure: "block"` it denied the call or turned the result into an error. Tests for both events; mutation: drop the post-`run` abort check.
- New tests: timeout classification (mutation: drop `"timeout"`), an exec that throws → "could not be started" (mutation: drop the `catch`), and a non-boolean `is_error` (mutation: drop the type check).
- `cli/src/main.ts` plain REPL and one-shot paths: `buildAgent(config, { log })` writes `[hook] …` to stderr (no Ink mounted there).
- README: added the pod-scope bullet (the pod's own config, `main.ts` loads it before `startStdioDaemon`; a pod-side gate is UX only, §7), the unredacted `tool_input` note, and the note that `tool_result` hooks see the `[hook] input modified…` prefix.

## Review

*— claude-opus-5-5, 2026-10-22. Fresh-context adversarial review. The executor is the **same model** (claude-opus-5-5) in a different context, so blind spots they share can survive both passes. A load-bearing task should ideally get a second review from a different model (AGENTS §10).*

**Verdict: REQUEST-CHANGES.** The design is sound and the code does what the plan says. Every gate-ordering property I traced end to end holds. Two properties the plan relies on for security have **no test that kills their mutation**, and one documented behaviour (failures "logged") is false on two entry points. All fixes are small.

### Must-fix

1. **The "a hook cannot smuggle a command past an approval" property is unpinned.** `agent/src/permission-gate.ts:149` matches the remembered rule against `effective`. That is correct, but if I mutate it to `isRemembered(tool, input)` (the model's original input), all 41 tests in hooks/permission/subagent still pass. The plan's failure-mode row "`modify` on a pre-approved prefix" depends on this. **Required:** add a loop test in `permission.test.ts`. First approve the prefix `git status` for the session. Then a hook rewrites `git status` → `rm -rf x`. Assert that the requester **is** prompted with `rm -rf x`. Show the test red under the mutation.
2. **A hook `ask` on a `"none"`-level tool is unpinned.** If I mutate `permission-gate.ts:146` to drop `&& force !== "ask"`, all tests pass. **Required:** add a test where `fs_read` (or a `none` fake tool) gets a hook `{"decision":"ask"}` and the requester is called.
3. **Executor risk (a): the README says ignored failures are "logged", but the headless paths log nothing.** `cli/src/main.ts:504` (`plain`) and `:609` (one-shot) call `buildAgent(config)` with no `log`. Ink is not mounted on either path, so stderr is safe. **Required:** pass `{ log: (l) => process.stderr.write(`[hook] ${l}\n`) }` (or the path's `write`) at both sites.
4. **Pod trust: in `run`/`attach`, the laptop's hooks do not run. This is undocumented.** `serve --stdio` loads the **pod's** config (`cli/src/main.ts:266` → `startStdioDaemon(config, …)`). So a laptop `no-rm` deny hook gives no protection in a pod, and nothing tells the user. A pod-side config can also `allow` calls without a prompt. This is acceptable under §7: pod tool calls run in the pod, and the gate there is already daemon-side UX. It must still be stated. **Required:** add one bullet to README `### Hooks` (`README.md:138-176`). It should say that in `run`/`attach`, the hooks come from the pod's own config and run in the pod; that laptop hooks do not apply; and that they are UX, not a security boundary.

### Nits (non-blocking)

5. `agent/src/hooks.ts:183`: dropping the `is_error` type check survives the tests (M6). Add one case.
6. `agent/src/hooks.ts:353` / `:355`: dropping timeout classification (M14) or the `exec`-throws → `"error"` catch (M15) survives the tests. Add a fake-env case for each. There is also a related bug. A hook killed by a **cancel** is reported as `exited 124`, so it is logged as "failed, ignored". With `onFailure: "block"` on `tool_result`, it turns the result into `hook failed: exited 124`. Return early when `signal.aborted`, without voting.
7. Executor risk (b): `tool_input` in a `tool_result` hook is the model's unredacted arguments, and so is a `tool_call` hook's input. The model wrote them and the hook is the user's own command, so this is not a leak. The README should still say it ("`tool_input` is not redacted").
8. The H4 `[hook] input modified…` prefix is part of the content that `tool_result` hooks see. This is harmless, but it is not stated in the README.

### Rulings on executor drift and risks

- **`Uint8Array` stdin instead of `Blob`:** OK. Proven by the exec test and by e2e (3 MB payload to a hook that never reads stdin: no hang, 252 ms).
- **`combineToolCallVotes(input, NamedVote[])`:** OK. It is the cleaner shape.
- **`hookLines` returns a view-model:** OK. It follows §7 better than `string[]`.
- **`authorize` refuses after a cancel during a hook:** OK and correct. The e2e cancel (a 5 s hook, aborted at 300 ms with `onFailure: "block"`) gives no prompt and `Cancelled by the user before this tool ran.` in 303 ms.
- **Hooks of a deny-level tool never run:** OK. This is H3.
- **(a)** Must-fix 3.
- **(b)** Nit 7.
- **(c) Stdin is untested on a pod daemon:** low risk. The pod daemon runs the same `HostExecution` under the same compiled Bun, and `HostExecution` is the only `ExecutionEnvironment` (`grep implements ExecutionEnvironment`). It is still unverified. To verify, do a `run` smoke with a `cat >/tmp/x` hook in the pod config.
- **(d)** I mutation-checked `hooks.test.ts` (below). It kills 11 of 12 pure mutations.

### Gate

`bun run check`: typecheck clean, lint clean ("Checked 362 files", no fixes), **1683 pass / 2 skip / 0 fail** (1685 tests, 148 files). The two skips are the opt-in ones. This matches Execution.

### Premise table (Implementation citations, on `main`)

| Premise | Result |
|---|---|
| Repro: no hooks seam; `stdin: "ignore"` (`exec/src/host-execution.ts:158`) | TRUE (`git show main:…` line 158) |
| `authorize` has one call site (`agent.ts:754`); `transformResult` callers are `:289,:628,:668` | TRUE (`git grep` on main) |
| A profile's `hooks` replaces the base list (`config/src/profile.ts:61`, `{...base, ...scalars}`) | TRUE |
| The registry turns a schema failure into an error result (`tools/src/registry.ts:68-74`) | TRUE |
| MCP names are `mcp__<server>__<tool>` (`mcp/src/tool-adapter.ts:40-42`) | TRUE |
| The resource block already allows `uri`/`mimeType`/`text`, so there is no protocol bump (`protocol/src/content.ts:20-26`) | TRUE |
| The peer dispatches concurrently, so a hook awaited in a turn does not block `cancel`/`resolve_permission` | TRUE. No change to `transport/`. The e2e cancel during a hook ends in 303 ms |
| Pod: "hooks come from the pod's own config" | TRUE (`main.ts:266`), but missing from the user docs (must-fix 4) |

### Mutation results (each reverted; tree byte-identical, checked with `git status`/`git diff`/`shasum` against a pre-review snapshot)

- **`hooks.test.ts` alone, killed:**
  - modify-without-decision counted as allow
  - exit 2 not special
  - no 1 MiB cap
  - plain matcher treated as a regex
  - no basename in `hookName`
  - deny does not short-circuit
  - the `tool_result` chain reads the original result
  - an ignored failure is not logged
  - a deny loses its reason
  - non-object `input` accepted
  - unknown `decision` accepted
- **`hooks.test.ts` alone, survived:** `is_error` type unchecked (nit 5).
- **hooks + permission + subagent suites, killed:**
  - `content` type unchecked
  - the deny-level check moved after the hooks (H3)
  - a hook `allow` gets remembered
  - no H4 note
  - the tool runs the raw arguments after a modify
  - `transformResult` gets the model's input instead of the effective one
- **hooks + permission + subagent suites, survived:**
  - remembered rule matched on the original input (**must-fix 1**)
  - `ask` does not override the `none` level (**must-fix 2**)
  - no timeout classification (nit 6)
  - an `exec` throw not caught (nit 6)

### Attacks tried

1. **A modify rewrites what the user approves.** E2E (`.tentacle/tmp/hooks-core/e2e.ts`): real `HostExecution`, `Agent`, `HookRunner` and `redactSecrets` + `runResultHooks`. The hook rewrites `rm -rf build` → `echo safe` with `ask`. **Holds:** the prompt input is `{"command":"echo safe"}`, the tool ran `echo safe`, the result has the H4 line and `hook:{action:"modified",name:"fix"}`, and the hook's stdin carried `event, session_id, cwd, agent:null, tool_name, tool_call_id, tool_input` (the original input).
2. **Exit-2 deny through a real script.** **Holds:** no prompt, `Blocked by a hook… Reason: rm not allowed`, `hook.name = "no-rm.sh"` (basename default).
3. **A 3 MB result piped to a hook that ignores stdin.** **Holds:** no hang and no EPIPE crash (252 ms).
4. **Hook timeout** (`sleep 5`, `timeout: 1`). **Holds:** it stops at about 1 s, logs `failed, ignored: timed out`, and the gate continues to the prompt.
5. **Cancel during a `block` hook.** **Holds** (see the rulings). The variant where a cancel happens during a `tool_result` hook mislabels the outcome (nit 6).
6. **Single broker:** `buildAgent` still threads one `permissions.request` into `Agent`, and sub-agents still get `deps.requestPermission`. The hook runner adds no requester. **Holds.**
7. **No raw terminal writes:** the worker logs to the file `daemon-errors.log` (`logDaemonError`). The pod `--stdio` logs to stderr, which the laptop buffers. `serve` uses `onError`. **Holds.** The headless gap is must-fix 3.
8. **Pod trust:** see must-fix 4. No laptop-side effect is added: hooks run where the daemon runs. Nothing new crosses the tunnel except an additive `hook://` resource block, which only renders text.

### What holds

- One seam each for `tool_call` (the gate) and `tool_result` (the pipeline). There is no parallel path.
- H3 runs the deny level before the hooks.
- A hook `allow` is never remembered.
- A modify is applied before the prompt.
- The abort is re-checked after the hooks.
- With no hooks configured, behaviour is byte-identical: raw arguments, and `hooks` is undefined.
- The protocol change is additive. Old clients skip unknown resource URIs.

### How the executor behaved

The executor followed the plan's order and reported drift honestly, including the risks it was unsure of. It proved stdin red-first and recorded its mutations. It overstated coverage in two places:
- It claimed the gate properties were "pinned by the mutations above", but two plan-listed gate properties were never mutated, and both survive.
- The README promises logging that the headless paths do not do.

### Re-review

*— claude-opus-5-5, 2026-10-22. Same model as the executor, in a fresh context.*

**Verdict: APPROVE.** All 8 findings are fixed.

**Mutations.** Each was rerun by the reviewer and reverted afterwards; the tree was then checked against a snapshot and is byte-identical. All are now killed:
- Must-fix 1 (remembered rule matched on the original input): 1 fail.
- Must-fix 2 (`ask` does not override the `none` level): 1 fail.
- Nit 5 (`is_error` type unchecked): 1 fail.
- Nit 6:
  - no timeout classification: 1 fail;
  - an `exec` throw not caught: 1 fail;
  - the cancel check removed in `toolCall`: 1 fail;
  - the cancel check removed in `toolResult`: 1 fail.

**The cancel fix is not over-broad.** Both new checks are gated only on `signal.aborted` (`agent/src/hooks.ts:281` and `:310`). I made each check always break, so votes are dropped even without a cancel. That fails 8 tests (`toolCall`) and 5 tests (`toolResult`). The e2e trace still shows a real 1 s timeout voting and logging (`failed, ignored: timed out`). A cancel during a hook ends in 307 ms with no prompt and no log line.

**Other fixes, checked by reading:**
- The `main.ts` plain and one-shot paths log to stderr. Ink is not mounted on either path, so this is safe. As the executor noted, it has no test.
- README (`:166`, `:174-184`) now covers pod scope, unredacted `tool_input`, the H4 prefix, and where failures are logged.

**Gate:** `bun run check` passes. Typecheck clean, lint clean (362 files), **1690 pass / 2 skip / 0 fail** (1692 tests, 148 files).
