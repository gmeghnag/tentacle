# eval/hooks-core — hook runner, `stdin` in core, `tool_call` → `PermissionGate`, `tool_result` → result pipeline

> **Status:** eval. Owner decisions D1–D9 in the umbrella; sub-decisions H1–H4 **decided 2026-10-21**. Implementation drafted below, approved at promotion.
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promote to `feat/hooks-core`.
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing (the agent loop's tool path, `PermissionGate`, core `ExecOptions`) · **Suited:** §10: a **strong model executes**; mandatory fresh-context Review
> **Umbrella:** [`extensibility.md`](./extensibility.md) (child 2 of 5) · **Needs:** `tool-naming` merged (the H1 line uses `toolLabel`) · **Note:** matchers use tool **names** (`shell`, `fs_edit`, …), never the CamelCase display labels of [`tool-naming.md`](../feat/tool-naming.md)

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

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-21*

Self-review. Both seams are single call sites, so the change adds one step to
each existing path and no parallel path (§7 "one session path"). The risky
part is the gate's ordering: `modify` before the prompt, `allow` never
remembered, `deny` level before hooks. Each has a dedicated red-first test
and one mutation check.

Open for the fresh-context Review: whether `authorize`'s new return type
leaks into anything beyond `runTool` (today it does not:
`git grep "\.authorize("` → one hit).
