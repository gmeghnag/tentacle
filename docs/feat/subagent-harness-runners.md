# feat/subagent-harness-runners — sub-agents run by another agent harness (Claude Code first)

> **Status:** implementation — **plan NOT approved** (owner questions below)
> **Branch:** `feat/subagent-harness-runners`
> **Size:** L → split into 5 slices (S/M each) · **Blast:** load-bearing (sub-agent seam + trust + permissions) · **Suited:** Opus plans; slices 1, 2, 5 DeepSeek + Opus review; slices 3, 4 Opus + mandatory fresh-context review
> **Changelog:** `changelog.d/subagent-harness-runners.added.md` (written by the last slice that makes it user-visible, slice 3)

## Context

*— claude-opus-5-5, 2026-11-25*

**Owner, 2026-11-25 ~11:00** (TODO.md, «faremo sia A … che B»): tentacle runs a
sub-agent through ANOTHER agent harness — Claude Code first (`claude -p`
headless, on the laptop). Three uses named:

- **A — escalation**: a DeepSeek/Qwen session that is stuck or looping hands the
  task to Claude;
- **B — «fallo fare a Claude» from the phone**;
- **C — a workflow step «review with Opus»**.

**Generalisation requirement (owner):** a generalised runner interface from day
one — a **harness adapter** (spawn, stream events, result, cancel, cost/limits)
— so other harnesses (Codex CLI, Gemini CLI, …) plug in later. Claude Code is
the first adapter.

**Constraints (owner, TODO.md):**
1. laptop only — never requested by a pod (AGENTS §7, a pod is not trusted);
2. it spends the owner's Max quota — visible and capped;
3. a writing run gets its own worktree; a review run is read-only;
4. permissions go through the single broker;
5. reuse the sub-agent seam (`agent_task`, `subagent.ts`) and the workflow step
   kinds — no parallel session path.

**What exists today:** a sub-agent is always a tentacle `Agent` built by
`createSubagentRunner` (`packages/agent/src/subagent.ts:485`) on a tentacle
`ModelProvider`. There is no way to delegate to an external agent process.

**Repro (capability missing + what the harness gives an adapter)** — run
2026-11-25 in `.tentacle/tmp/subagent-harness-runners/`, `claude` 2.1.331,
`--model claude-haiku-5-5`. Scripts `host.py`, `host2.py`, `cancel.py` (stdin/
stdout stream-json drivers, ~30 lines each). Observed (trimmed to the shapes
the adapter reads):

```
# 1. claude -p … --output-format stream-json --verbose --permission-mode dontAsk --allowedTools Read --session-id <uuid>
system/init  {session_id, cwd, tools:[…], permissionMode:"dontAsk", model, claude_code_version:"2.1.331", apiKeySource:"none", mcp_servers}
assistant    {message:{id:"msg_011…", content:[{type:"tool_use", name:"Bash", input:{command:"cat note.txt", description:…}}], usage:{…}}}
assistant    {message:{id:"msg_011…"  ← SAME id again (one event per content block; usage repeated)
rate_limit_event {rate_limit_info:{status:"allowed", rateLimitType:"five_hour", resetsAt, unifiedWindows:{five_hour:{utilization:0.06,…}, seven_day:{utilization:0.12,…}}}}
user         {message:{content:[{type:"tool_result", tool_use_id, content:"hello harness", is_error:false}]}}
result       {subtype:"success", is_error:false, result:"HELLO HARNESS", stop_reason:"end_turn", terminal_reason:"completed",
              session_id, num_turns:3, total_cost_usd:0.00683, usage:{input_tokens:4, cache_creation_input_tokens:31292,
              cache_read_input_tokens:47737, output_tokens:197}, modelUsage:{…costBasis:"list"}, permission_denials:[]}
   → NOTE: --allowedTools Read did NOT stop Bash: `cat` (read-only, in cwd) is auto-allowed by Claude itself.

# 2. dontAsk + "create out.txt": Bash and Write both refused, listed in result.permission_denials[] (tool_name, tool_use_id, tool_input); exit 0.

# 3. --input-format stream-json --permission-prompt-tool stdio (host answers):
control_request {request_id, request:{subtype:"can_use_tool", tool_name:"Write", input:{file_path, content}, tool_use_id, permission_suggestions:[…]}}
  host → {"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow","updatedInput":{…}}}}  → file written
  host → {… "response":{"behavior":"deny","message":"denied by tentacle broker"}}  → tool_result is_error, model told the message
# 3b. + --restricted --tools Bash, deny everything: `cat note.txt` (in cwd) ran WITHOUT asking; `cat ../outside.txt` → control_request → denied.

# 4. --resume <session-id>   → continues the same claude session (knows note.txt content).
# 5. --json-schema '{verdict:enum[pass,fail], reason}' → result.structured_output = {verdict:"pass", reason:"…"}.
# 6. --max-budget-usd 0.0001 → subtype "error_max_budget_usd", is_error:true, total_cost_usd 0.0045 (SOFT cap: checked after a call).
# 7. CLAUDE_CONFIG_DIR=<empty>  → result {subtype:"success" (!), is_error:true, result:"Not logged in · Please run /login"}, exit 1.
# 8. cancel after 5 s:
#    SIGTERM                              → exit 143, NO result event (cost lost).
#    control_request {subtype:"interrupt"} → control_response {still_queued:[]}, then
#                                           result {subtype:"error_during_execution", is_error:true, terminal_reason:"aborted_streaming", total_cost_usd}, exit 1.
# 9. --restricted --tools Read --permission-mode dontAsk (OAuth/Max login works, apiKeySource "none"):
#    init.tools == ["Read"], mcp_servers == []; Read ../outside.txt → "is outside …/ws; --restricted confines the file tools…"; Read note.txt ok.
```

## Implementation

*— claude-opus-5-5, 2026-11-25*

### Load-bearing assumption

**Claude Code, run headless with `--restricted --tools <list>
--input-format stream-json --permission-prompt-tool stdio`, sends every
permission decision it does not take itself to the HOST over stdio
(`control_request can_use_tool`, answered with allow/deny), and the only
decisions it takes itself are reads inside its working directories.**

If this holds, the harness child can be put behind the single broker exactly
like a tentacle child: we answer each `can_use_tool` through the session's
`PermissionGate` → `subagentRequester` → the ONE broker. If it did not hold, a
harness child could act on the laptop with nobody asked — the plan would have
to fall back to a fixed allowlist with no Bash.

Proved by execution (Repro 3, 3b, 9): a `Write` and an out-of-cwd `cat` each
produced a `control_request` and obeyed our deny; an in-cwd `cat` ran without
asking; `--restricted` confined file tools to cwd, dropped every tool not in
`--tools`, loaded no MCP server and no user/project settings (so no settings
`allow` rule can pre-approve anything), and still authenticated on the Max
login. Version-bound: `claude` 2.1.331 — slice 2 re-checks it at run time
(`init.tools`, `init.permissionMode`, version floor), see Failure modes.

### Preconditions

- **One runner, two call sites.** `agent_task` (`packages/cli/src/wiring.ts:807`,
  `:818`) and a workflow `agent` step (`wiring.ts:868-869`, `runnerFor` →
  `createSubagentRunner({ ...runnerDeps, requestPermission: requester })`) both
  build their runner from the SAME `runnerDeps` (`wiring.ts:778-806`). A
  dispatch added inside `createSubagentRunner` reaches both, with no second path.
- **The child contract is narrow.** A runner is
  `(opts, controls) => Promise<SubagentResult>` (`subagent.ts:255-258`);
  everything the TUI/phone/ledger show comes from four `ToolProgressEvent`s —
  `subagent_start` / `subagent_tool` / `subagent_usage` / `subagent_end`
  (`packages/core/src/tool.ts:130-166`), consumed by the jobs runtime
  (`packages/core/src/agent-jobs.ts:259-267`) and the workflow step
  (`packages/agent/src/workflow-driver.ts:1703-1710`). A failure is a
  `SubagentFailure` with a partial report (`subagent.ts:630-634`), which the
  workflow already maps to a `fail` verdict (`workflow-driver.ts:1749-1760`).
- **Asks of a child already go through the one broker, attributed.**
  `subagentRequester` (`subagent.ts:212-253`) wraps the parent's requester,
  which is `permissions.request` (`wiring.ts:783`); a background child's ask
  carries `sa-N` and its own signal. A non-agent caller that must honour the
  session's grants/hooks/rules uses `new PermissionGate(requester, hooks,
  grants).authorize(tool, input, call)` — precedent: a workflow `run` step
  (`wiring.ts:853`, `:883`, `packages/agent/src/permission-gate.ts:169`).
- **The pod gate already exists.** `tunnelled = options.modelOverride !==
  undefined` (`wiring.ts:763`); the pod daemon always wires with
  `modelOverride: tunnelFor()` (`packages/cli/src/serve.ts:1199`, `:1262`);
  workflows are already `!tunnelled`-only (`wiring.ts:852`), and both laptop
  callers ask for them (`packages/cli/src/worker.ts:115`, `serve.ts:245`).
- **The laptop answers a pod only from a closed list.** `RemoteClient`'s
  `onRequest` serves `model/stream`, `model/stream_chunked`,
  `model/count_tokens`, `hooks/trust` and throws `MethodNotFound` for anything
  else (`packages/client/src/remote-client.ts:3357-3378`).
- **Process groups + exit net.** `killGroup` / `trackGroup`
  (`packages/exec/src/process-group.ts:96`, `:132`) reap a detached group when
  tentacle exits, from a Worker too (forwarded to the main thread, header
  `:2-28`).
- **Background lifecycle is already persisted** as `subagent_background` /
  `subagent_end{report}` (non-critical, `packages/protocol/src/session-log.ts:257-278`,
  `:545-546`); a foreground child's report is the `agent_task` tool result.
- **No worktree seam exists in `packages/*/src`** (grep `worktree`: none) — the
  worktree code is new (slice 4).

### Design

**D1 — The adapter interface (`packages/agent/src/harness/types.ts`, new).**
Harness-neutral; Claude Code is one implementation.

```ts
interface HarnessAdapter {
  readonly id: string;                       // "claude-code"
  probe(spawn: Spawner): Promise<HarnessProbe>;     // installed? version ≥ floor?
  argv(run: HarnessRunSpec): readonly string[];     // pure
  parse(line: string): HarnessEvent | undefined;    // pure; unknown → undefined
  answer(ask: HarnessAsk, decision: HarnessDecision): string;  // stdin line, pure
  interrupt(): string | undefined;                  // stdin line, else signal-only
  userMessage(text: string): string;                // first prompt (+ later steering)
}
type HarnessRunSpec = { prompt; cwd; mode: "review" | "write"; tools: readonly string[];
                        model?: string; sessionId: string; jsonSchema?: object; maxCostUsd?: number };
type HarnessEvent =
  | { kind: "init"; sessionId; tools: readonly string[]; permissionMode; version }
  | { kind: "tool"; name; input: unknown }                 // → subagent_tool label
  | { kind: "usage"; messageId; promptTokens; completionTokens }  // deduped by messageId
  | { kind: "ask"; requestId; tool; input: unknown }       // → broker
  | { kind: "quota"; window: "five_hour" | "seven_day"; utilization; resetsAt; status }
  | { kind: "result"; ok: boolean; text; structured?: unknown; stop: HarnessStop;
      costUsd?; error? };
type HarnessStop = "end_turn" | "cancelled" | "budget" | "error";
```

The adapter is PURE (argv, line parsing, answers). The process lifecycle is ONE
shared driver (D2) for every harness, so Codex/Gemini add only an adapter file.

**D2 — The driver (`packages/agent/src/harness/driver.ts`, new).**
`runHarness(adapter, spec, io)` with an injected `Spawner` (the fake in tests):
spawns detached in its own process group and `trackGroup`s it; reads stdout as
lines (cap per line, D7); feeds each `HarnessEvent` to callbacks; writes
answers/interrupt to stdin; keeps a 4 KiB stderr tail; resolves with the
`result` event or rejects with a `HarnessFailure` (missing result, non-zero
exit, timeout). Cancel ladder: `interrupt()` line → wait ≤ 5 s for `result` →
close stdin → `SIGTERM` group → 2 s (`KILL_GRACE_MS`) → `SIGKILL` group.
Interrupt first because SIGTERM loses the `result` (and its cost, Repro 8).
Idle timeout (no event for N min) and wall-clock cap, both PAUSED while an
`ask` is pending (a human may take long).

**D3 — Mapping onto the existing sub-agent seam (no parallel path).**
`AgentType` gains an optional `harness: { adapter: string; mode: "review" |
"write"; model?: string }` (built-ins + `agents/*.md` frontmatter `harness:`,
`mode:`, `model:`). `createSubagentRunner` gets an optional dep
`harness?: HarnessDeps` (adapters by id, spawner, quota store, worktree maker,
gate factory). In `run` (`subagent.ts:379`), **after** `subagent_start` is
emitted and **before** the child `Agent` is built, a type with `harness` goes
to `runHarnessChild(type, opts, controls, deps)` and returns the same
`SubagentResult` / throws the same `SubagentFailure`:

| harness event | existing seam |
|---|---|
| (before spawn) | `subagent_start{agentType, description}` (already emitted) |
| `tool` | `subagent_tool{label}` — Claude names mapped to the labels `childToolLabel` makes (`Bash`→`$ cmd`/its description, `Read`→`Read p`, `Edit`/`Write`→`Edit p`/`Write p`, `Grep`/`Glob`→`Search …`) |
| `usage` (deduped per message id; prompt = input + cache_creation + cache_read) | `subagent_usage` → the row, the workflow step's `tokens`, `controls.maxTokens` (exceeded → interrupt → `max_token_budget`) |
| `ask` | D4 |
| `result ok` | `report` = `text` (+ footer D6), `stopReason "end_turn"` |
| `result stop:"budget"` | `stopReason "max_token_budget"` (workflow → `budget_hit`, existing path) |
| `result stop:"cancelled"` / signal | `stopReason "cancelled"` |
| `result !ok` / driver failure | `throw SubagentFailure(msg, {partialReport, toolUses})` |
| (end) | `subagent_end{toolUses, stopReason}` (same place as today) |

So `agent_task`, background (`sa-N`), `agent_control status/kill`, the panel,
the tail view, the ledger, the session log and the phone see an ordinary
child whose `agentType` is e.g. `claude-review`. `readOnlyType` answers `true`
for `mode: "review"` (so a review may run in parallel, `task.ts:376`), `false`
for `write`. **No protocol change, no new log entry type, no new RPC method.**

**D4 — Permissions: the harness asks us, through the one broker.**
Spawned with `--permission-prompt-tool stdio` (never `dontAsk`,
`acceptEdits` or `bypassPermissions`). Each `ask` is mapped to a TENTACLE tool
identity and authorised by `new PermissionGate(childRequester, hooks,
grants).authorize(tool, input, {toolCallId, signal})`, where `childRequester`
is `subagentRequester(deps.requestPermission, …)` — so the session's grants,
rules and hooks apply, the ask is attributed to the `agent_task` call / `sa-N`,
and it reaches the ONE broker (TUI or phone). Mapping: `Bash{command}` →
`shell{command}`; `Write{file_path,content}` → `fs_write`; `Edit` → `fs_edit`;
anything else → a generic ask `{tool: "claude:<Name>", title: "Claude wants
<Name>", detail: JSON}` with **no** session-scope option (a pod is not in play,
but an unknown tool must never get an "always"). An allow answers
`updatedInput` = the input the gate APPROVED (a hook rewrite reaches Claude,
like `wiring.ts:894-906`); a deny answers its `message`. A dismissed ask (TUI
gone) answers deny.
What Claude decides alone, and why that is acceptable: reads inside its
working directories (Repro 3b) — the same class tentacle runs without asking
(`fs_read`/`search` are `permission: "none"`, `packages/tools/src/builtins.ts:136`, `search-tool.ts:156`). In a **write** run, edits inside
the worktree are auto-allowed only if Owner Q2 says so (then via the gate's
answer, not via a Claude mode, so it stays one decision point).

**D5 — Trust: laptop only, enforced on the laptop.**
(a) Harness types are added to `agentTypes` and `harness` deps are given to the
runner **only when `!tunnelled`** (`wiring.ts:763`), the same gate as
workflows; a pod config that names a harness type/`harnesses` gets a notice
and is ignored (as `wiring.ts:765-772` does for models). (b) The harness is
NOT a `ModelProvider` / `models` entry — otherwise `publishedModels` would let
a pod pick it through the model tunnel. (c) The laptop's inbound list
(`remote-client.ts:3357-3378`) gets no new method; a test pins that a pod
asking for anything else is `MethodNotFound`. A `serve` on another host the
user owns runs `claude` THERE with that host's login (Owner Q8).

**D6 — Cost and quota: visible and capped.**
Max-plan reality (Repro 1): `total_cost_usd` is a list-price ESTIMATE
(`costBasis:"list"`), the real limit is the 5 h / 7 d window utilization
(`rate_limit_event`). So: (1) a per-run `--max-budget-usd` (soft, Repro 6) from
config; (2) a laptop-wide `HarnessQuota` (in-memory, last `quota` event per
adapter) that REFUSES to start a run when the last-seen 5 h utilization ≥ the
configured stop (a refusal is a tool error the model reads, with the reset
time); (3) every report ends with one footer line: `— claude · opus · $0.42
(list) · 5h 34% · 7d 12% · session <uuid> (claude --resume <uuid>)`, and
`agent_control status` shows the same. A UI badge is later (Owner Q7).

**D7 — Persistence.** Nothing new: the foreground report is the `agent_task`
result; a background one is `subagent_end{report}` (capped by its emitter, as
today). Claude keeps its own transcript (`~/.claude/projects`, not
`--no-session-persistence`) so the footer's `claude --resume <uuid>` lets the
user open it in a terminal. Events are not persisted beyond what a tentacle
child persists (labels on the live row only).

**D8 — Worktree for write, read-only for review.**
`mode: "review"` → cwd = session cwd, `--restricted --tools Read,Grep,Glob`
(no Bash/Edit/Write: nothing can change; Owner Q3). `mode: "write"` → slice 4
creates `git worktree add <repo>/.tentacle/worktrees/harness-<id> -b
harness/<id>` (gitignored dir), runs Claude there with `--restricted --tools
Read,Grep,Glob,Edit,Write,Bash`; the report ends with the branch and `git diff
--stat`; worktree with no changes is removed, otherwise kept (Owner Q5). A
non-git cwd refuses a write run with a clear error. Nothing is merged by us.

**D9 — Workflow verdict.** A harness child cannot call `step_verdict` (our
tool). For a workflow step (`controls.extraTools` contains `step_verdict`),
the run is given `--json-schema {verdict: pass|fail, reason, report}`; the
`structured` result is fed to the SAME `verdict.tool` the driver created
(calling its `execute` once), so `workflow-driver.ts:1714` reads it unchanged.
No new step kind: a step names the type (`type: claude-review`).

### Files

Dependency order. Slice in brackets.

1. [S1] `packages/agent/src/harness/types.ts` (new) — D1 types.
2. [S1] `packages/agent/src/harness/claude-code.ts` (new) — argv, `parse`, `answer`, `interrupt`, version floor; pure.
3. [S2] `packages/agent/src/harness/driver.ts` (new) — D2; uses `packages/exec/src/process-group.ts` (`trackGroup`, `killGroup`, `untrackGroup`).
4. [S3] `packages/agent/src/subagent.ts` — `AgentType.harness`, `SubagentDeps.harness`, dispatch in `run`, `readOnlyType`.
5. [S3] `packages/agent/src/harness/child.ts` (new) — `runHarnessChild`: events → progress, D4 ask bridge, D6 quota/footer.
6. [S3] `packages/agent/src/agent-defs.ts` — frontmatter `harness`, `mode`.
7. [S3] `packages/config/src/schema.ts` (+ `defaults.ts`, `key-docs.ts`) — `harnesses.<id>.{enabled, command, maxCostUsd, stopAtQuota, idleMinutes}`.
8. [S3] `packages/cli/src/wiring.ts` — build harness deps only `!tunnelled`; built-in harness types; pod notice.
9. [S4] `packages/agent/src/harness/worktree.ts` (new) — create / diffstat / remove-if-clean via injected git runner.
10. [S5] `packages/agent/src/harness/child.ts` — D9 json-schema verdict; quota refusal.
11. [S3] `changelog.d/subagent-harness-runners.added.md`; `docs/feat/subagent-harness-runners.md` Execution.

No change to `packages/protocol` (no `protocol.d/` note), `client`, `daemon`, `tui`, `apps/mobile`.

### Failure modes

| case | how it converges |
|---|---|
| `claude` not on PATH | `probe` fails → the harness types are still listed but a call returns a tool error "Claude Code not installed (`command` …)"; no spawn. Probed lazily at first use, cached per process. |
| not logged in | `result{is_error:true}` despite `subtype:"success"` (Repro 7) → `SubagentFailure("Claude Code: Not logged in — run `claude /login` on this machine")`. The adapter keys on `is_error`, never on `subtype`. |
| quota hit (5 h window) | `rate_limit_event.status ≠ "allowed"` or an `is_error` result with a rate-limit error → failure with reset time; `HarnessQuota` records it, next runs refused until `resetsAt`. *Unverified live (cannot trigger cheaply) — covered by a fake-harness test.* |
| per-run cost cap | `error_max_budget_usd` → `stopReason "max_token_budget"` + report note (soft cap: overshoot ≤ one call, Repro 6). |
| hang (no events) | idle timer (paused while an ask is pending) → cancel ladder → failure "no output for N min" with stderr tail. |
| cancel mid-run (Esc, `agent_control kill`, workflow stop) | signal → `interrupt` line → `result{error_during_execution}` (cost kept) → `stopReason "cancelled"`; if no result in 5 s → TERM/KILL the group. A pending ask is withdrawn (its `signal`). |
| tentacle exits / worker dies | the group is tracked → SIGKILLed by the exit net (`process-group.ts:2-28`); stdin EOF also ends Claude after its turn. |
| crash (non-zero exit, no `result`) | `SubagentFailure` with exit code + stderr tail + the text seen so far as partial report. |
| huge output | per-line cap (8 MiB): an over-long line is dropped and counted, never buffered whole; tool results are not forwarded (only labels); the report goes through the existing result transforms / `subagent_end` cap. |
| garbled / unknown event | unknown `type` ignored (forward-compatible); unparsable line counted; a run that ends without a parsable `result` is a failure. |
| version skew of the CLI | version floor checked at probe; `init` must echo the requested `tools` and a non-bypass `permissionMode`, else the run is killed before any tool executes (defends D4's assumption against a future flag change). |
| ask answered after the run ended | answer written only while the process is alive; late answers dropped (the ask was withdrawn by the run's signal). |
| two write runs at once | each its own `harness-<id>` worktree/branch; review runs share cwd read-only. |
| pod asks for a harness | impossible by construction (D5): no type, no dep, no method; pinned by tests. |
| empty report | the existing fallback text (`subagent.ts:659-663`) applies to the mapped result. |

### Tests

All with a **FakeHarness**: an injected `Spawner` returning an in-memory
process (scripted stdout lines, captured stdin lines, controllable exit and
signals) — the "fake spawner" pattern (§9). Fixtures are the Repro shapes
above. No real `claude` in any test.

- S1 `claude-code.test.ts`: argv per mode (review never contains Bash/Edit/Write; always `--restricted`, `--permission-prompt-tool stdio`, never `dontAsk`/`bypass`); `parse` of each fixture; usage dedupe by message id; `is_error` + `subtype:"success"` → not ok; `answer` allow carries `updatedInput`, deny carries `message`.
- S2 `driver.test.ts`: cancel ladder order (interrupt before TERM; TERM only if no result in grace — mutation: swap order → red); idle timer paused while an ask is pending; group tracked and released; over-long line dropped not buffered; no-result exit → failure with stderr tail.
- S3 `subagent-harness.test.ts`: a harness type emits start/tool/usage/end exactly like a tentacle child; an `ask` reaches a **SpyBroker** through `subagentRequester` with the parent call id / `sa-N` (mutation: bypass the gate → red); a session grant for `shell git status` answers a Claude `Bash git status` without a prompt; a hook rewrite reaches Claude as `updatedInput`; unknown Claude tool never offers "session" scope; `readOnlyType` true/false by mode; `wiring` with `modelOverride` registers no harness type (mutation: drop the `!tunnelled` → red); `RemoteClient` answers `MethodNotFound` to an unknown pod request.
- S4 `worktree.test.ts` (fake git runner): write run cwd = new worktree; clean run removes it; dirty run keeps it and reports branch + diffstat; non-git cwd refuses.
- S5: workflow step with `type: claude-review` → `structured_output` becomes the step verdict (pass and fail); quota at/above stop → refusal before spawn; cost cap → `budget_hit`.
- Gate: `bun run check` per slice.

### Slices

| # | slice | size · blast | executor · review |
|---|---|---|---|
| 1 | adapter interface + Claude Code adapter (pure) | S · contained | DeepSeek · in-context |
| 2 | process driver (spawn, groups, cancel ladder, timeouts, caps) | M · cross-module | DeepSeek · Opus review |
| 3 | sub-agent seam wiring + permission bridge + trust gate + config + built-in `claude-review` | M · load-bearing | Opus · fresh-context review |
| 4 | write mode in a worktree | M · load-bearing | Opus · fresh-context review |
| 5 | workflow verdict via json-schema + quota refusal/footer | S · cross-module | DeepSeek · Opus review |

After this task (not in it): background steering (`agent_message` → a stdin
user message), quota badge on TUI/phone (mockups first), a phone hub entry,
Codex/Gemini adapters.

### Owner questions

1. **Built-in types.** Recommend two: `claude-review` (read-only, Opus) and `claude` (write in worktree, Opus); more via `agents/*.md` (`harness: claude-code`).
2. **Asks in a write run.** Recommend: Edit/Write inside its worktree auto-allowed (isolated branch), every Bash and anything outside asked through the broker. Alternative: ask everything.
3. **Review run tools.** Recommend Read/Grep/Glob only, no Bash (tests belong in a workflow `run` step).
4. **Caps and opt-in.** Recommend off until `harnesses.claude-code.enabled: true`; `maxCostUsd: 5` per run (list price); refuse new runs at 5 h utilization ≥ 80%.
5. **Worktree after a write run.** Recommend: keep branch + worktree if it changed something (report gives branch + diffstat), remove if clean, never auto-merge.
6. **«Fallo fare a Claude» from the phone.** Recommend for now through the chat (the main agent calls `agent_task type: claude`); a dedicated hub button later, with mockups.
7. **Quota visibility.** Recommend a text footer on the report + `agent_control status` now; a badge on TUI/phone later, with mockups.
8. **Where it runs.** Recommend: laptop worker AND a `serve` on any host the user owns (it uses that host's `claude` login); a pod never.

## Execution

*— pending (plan not approved)*

## Review

*— pending*
