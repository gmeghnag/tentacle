# feat/subagent-harness-runners — sub-agents run by another agent harness (Claude Code first)

> **Status:** implementation — **APPROVED (owner answers 2026-11-25)**
> **Branch:** `feat/subagent-harness-runners`
> **Size:** L → split into 6 slices (S/M each) · **Blast:** load-bearing (sub-agent seam + trust + permissions) · **Suited:** owner routing 2026-11-25 — Sonnet where a mistake is cheap to iterate on, Opus where a slice touches §7; final review fresh-context Opus (table in *Slices*)
> **Changelog:** `changelog.d/subagent-harness-runners.added.md` (written by `shr-5-permissions`, the slice that makes it usable)

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

**Owner addendum, 2026-11-25 ~11:20** (TODO.md `feat/a2a`): the interface must
ALSO fit a **remote A2A agent** as a sub-agent (A2A spec 1.0.0,
https://a2a-protocol.org/latest/specification/; JS SDK `@a2a-js/sdk`). The A2A
adapter is NOT built here — only the interface must be able to host it: a
remote, untrusted, network agent with long-lived tasks, `INPUT_REQUIRED`
mid-run, auth, reconnect/resubscribe, and no local worktree. See D10 and the
mapping table.

**Constraints (owner, TODO.md):**
1. laptop only — never requested by a pod (AGENTS §7, a pod is not trusted);
2. it spends the owner's Max quota — visible and capped;
3. a writing run gets its own worktree; a review run is read-only (after Owner A3 a review is a `claude` run too: its worktree is a snapshot, so the user's own tree is never touched — D8);
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
login. (The A2A fit is NOT load-bearing here — no A2A code ships — it is pinned by S3's fake remote adapter test, D10.) Version-bound: `claude` 2.1.331 — slice 2 re-checks it at run time
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
Transport-agnostic, so ONE interface hosts a local CLI process (Claude Code,
later Codex/Gemini) AND a remote network agent (A2A, later — D10). The
sub-agent seam (D3) talks only to this; it never sees argv, stdin or HTTP.

```ts
interface HarnessAdapter {
  readonly id: string;                         // instance name: "claude-code", "a2a:acme-reviewer"
  readonly kind: "local-process" | "remote";   // trust class (D5, D10)
  readonly caps: HarnessCaps;
  probe(signal): Promise<HarnessProbe>;        // installed+version | Agent Card fetched+checked
  start(spec: HarnessRunSpec, signal): Promise<HarnessRun>;
  reattach?(handle: HarnessHandle, signal): Promise<HarnessRun>;  // remote only (D10)
}
interface HarnessCaps {
  readonly permissionAsks: boolean;  // can ask US before acting (Claude: yes; A2A: no — it acts remotely)
  readonly inputRequired: boolean;   // can pause for an answer mid-run (A2A INPUT_REQUIRED)
  readonly steer: boolean;           // accepts more text while running
  readonly usage: boolean;           // reports tokens   (A2A: no)
  readonly cost: boolean;            // reports $        (A2A: no)
  readonly quota: boolean;           // reports a plan window (Claude Max: yes)
  readonly structuredResult: boolean;// enforces a JSON schema (Claude --json-schema; A2A: data part, unenforced)
  readonly workspace: "local" | "none"; // may run in our cwd/worktree (A2A: none)
}
interface HarnessRun {
  readonly events: AsyncIterable<HarnessEvent>; // ends after exactly one `end`, or throws
  answer(askId: string, decision: HarnessDecision): Promise<void>; // permission | input reply
  send(text: string): Promise<void>;            // steer (caps.steer)
  cancel(): Promise<"confirmed" | "unconfirmed">; // best effort: A2A cancel is not guaranteed
}
type HarnessRunSpec = { prompt; mode: "write" | "remote"; cwd?; tools?: readonly string[];
                        model?; jsonSchema?; runId: string };
type HarnessEvent =
  | { kind: "started"; handle: HarnessHandle; detail: { tools?; permissionMode?; version? } }
  | { kind: "progress"; label: string }               // a tool call / a status text → subagent_tool
  | { kind: "usage"; promptTokens; completionTokens } // already deduped by the adapter
  | { kind: "quota"; window; utilization; resetsAt; allowed: boolean }
  | { kind: "ask"; askId; ask:
        | { type: "permission"; tool; input: unknown }   // → D4, the broker
        | { type: "input"; question: string }            // → D10 (parent / user)
        | { type: "auth"; explanation: string } }        // → fail in v1 (D10)
  | { kind: "output"; text?: string; data?: unknown; file?: { name?; mediaType?; bytes? } } // partial results
  | { kind: "disconnected"; reason }                   // the runner may `reattach` (caps-gated)
  | { kind: "end"; status: "completed" | "failed" | "cancelled" | "rejected" | "budget";
      text?; structured?: unknown; costUsd?; error? };
type HarnessHandle = { adapter: string; id: string; extra?: Record<string, string> };
  // Claude: id = claude session_id. A2A: id = taskId, extra = { contextId, cardUrl }.
```

**D2 — Local CLI harnesses: a pure codec + ONE process transport.**
`packages/agent/src/harness/process.ts` (new) implements `HarnessAdapter` for
any CLI from a PURE `CliCodec` — `argv(spec)`, `parse(line) → HarnessEvent[]`,
`answer(askId, decision) → stdin line`, `interrupt() → stdin line | undefined`,
`userMessage(text) → stdin line`, `versionFloor`. Claude Code is a codec
(`claude-code.ts`); Codex/Gemini later add only a codec. The transport takes an
injected `Spawner` (the fake in tests): spawns detached in its own process
group and `trackGroup`s it; reads stdout as lines (cap per line); keeps a 4 KiB
stderr tail; ends the event stream with `end` or throws a `HarnessFailure`
(no `end`, non-zero exit). `cancel()` ladder: `interrupt()` line → wait ≤ 5 s
for `end` → close stdin → `SIGTERM` group → 2 s (`KILL_GRACE_MS`) → `SIGKILL`
group; interrupt first because SIGTERM loses the `result` and its cost
(Repro 8). A remote adapter (D10) implements `HarnessAdapter` directly over
HTTP; it shares nothing with this file.

Limits are NOT the adapter's: the runner (D3) owns them for every adapter —
the hang guard (no event for `idleMinutes`, paused while an `ask` is pending)
and a workflow step's own `tokens` (if `caps.usage`). No spending cap (Owner
A4). A remote task may be legitimately long, so its idle default is per harness
instance.

**D3 — Mapping onto the existing sub-agent seam (no parallel path).**
`AgentType` gains an optional `harness: { adapter: string; mode: "write" |
"remote" }` (`remote` is the only mode a `kind: "remote"` adapter accepts, and
a local adapter refuses it — checked when the types are built, D10). **One
built-in type, `claude`** (Owner A1/A3: a type is a ROLE; no `claude-review`
for now), registered from config by the wiring — no `agents/*.md` frontmatter
in this task.

**The model is a free parameter of the call, never a list in code (Owner A1).**
`agent_task`'s `model` argument (today offered only with
`subagents.selectableModels` and checked against those names,
`packages/tools/src/task.ts:325-346`, `:381-388`) is also offered when a harness
type exists; for a harness type it is NOT checked against `models` but passed
to the adapter verbatim, shape-checked only (1–64 chars of `[A-Za-z0-9._:\-\[\]]`,
not starting with `-`; one argv element, no shell). The description says:
«for `claude`: an alias — `opus`, `sonnet`, `haiku` (Claude Code resolves each
to the latest) — or a full model id; omit it for the default
(`harnesses.claude-code.model`, default `opus`)». So the delegating agent may
pick a lighter model per call, and a new Anthropic model needs no tentacle
release. A wrong id fails fast as Claude's own `is_error` result →
`SubagentFailure` the parent reads. The row shows it: `subagent_start{model}`
carries the string as given (display only, laptop-side; no wire change). `createSubagentRunner` gets an optional dep
`harness?: HarnessDeps` (adapters by id, spawner, quota store, worktree maker,
gate factory). In `run` (`subagent.ts:379`), **after** `subagent_start` is
emitted and **before** the child `Agent` is built, a type with `harness` goes
to `runHarnessChild(type, opts, controls, deps)` and returns the same
`SubagentResult` / throws the same `SubagentFailure`:

| `HarnessEvent` | existing seam |
|---|---|
| (before `start`) | `subagent_start{agentType, description}` (already emitted) |
| `started` | handle kept for the footer / reattach; Claude: `detail.tools` + `permissionMode` checked (Failure modes, version skew) |
| `progress` | `subagent_tool{label}` — the Claude codec maps names to the labels `childToolLabel` makes (`Bash`→`$ cmd`/its description, `Read`→`Read p`, `Edit`/`Write`→`Edit p`/`Write p`, `Grep`/`Glob`→`Search …`); A2A: the status message text |
| `usage` (Claude: deduped per message id; prompt = input + cache_creation + cache_read) | `subagent_usage` → the row, the workflow step's `tokens`, `controls.maxTokens` (exceeded → `cancel` → `max_token_budget`) |
| `quota` | the footer's 5 h / 7 d figures (D6); a non-`allowed` status → failure |
| `ask` | `permission` → D4 · `input` → D10 · `auth` → failure (D10) |
| `output` | appended to the report (text; `data` as capped JSON; a `file` is LISTED, never written — D10) |
| `disconnected` | `reattach` if the adapter has it (bounded), else failure |
| `end completed` | `report` = `text` (+ footer D6), `stopReason "end_turn"` |
| `end budget` | `stopReason "max_token_budget"` (workflow → `budget_hit`, existing path) |
| `end cancelled` / our signal | `stopReason "cancelled"` |
| `end failed` / `rejected` / `HarnessFailure` | `throw SubagentFailure(msg, {partialReport, toolUses})` |
| (after) | `subagent_end{toolUses, stopReason}` (same place as today) |

So `agent_task`, background (`sa-N`), `agent_control status/kill`, the panel,
the tail view, the ledger, the session log and the phone see an ordinary
child whose `agentType` is `claude`. `readOnlyType` answers `true`
for `mode: "remote"` (changes nothing on this machine, may run in parallel,
`task.ts:376`), `false` for `write` (`claude`). **No protocol change, no new log entry type, no new RPC method.**

**D4 — Permissions: the harness asks us, through the one broker; auto mode
decides (Owner A2).**
Spawned with `--permission-prompt-tool stdio` (never `dontAsk`, `acceptEdits`,
`auto` or `bypassPermissions`: no Claude-side mode ever replaces our answer).
Each `ask{permission}` is mapped to a TENTACLE tool identity and authorised by
`new PermissionGate(childRequester, hooks, grants).authorize(tool, input,
{toolCallId, signal})`, where `childRequester` is
`subagentRequester(deps.requestPermission, …)` — so the session's grants, rules
and hooks apply, the ask is attributed to the `agent_task` call / `sa-N`, and it
reaches the ONE broker (TUI or phone). Mapping: `Bash{command}` →
`shell{command}`; `Write{file_path,content}` → `fs_write`; `Edit` → `fs_edit`;
anything else → a generic ask `{tool: "claude:<Name>", title: "Claude wants
<Name>", detail: JSON}` with **no** session-scope option. An allow answers
`updatedInput` = the input the gate APPROVED (a hook rewrite reaches Claude,
like `wiring.ts:894-906`); a deny answers its `message`; a dismissed ask (TUI
gone) answers deny. Claude's `permission_suggestions` (e.g. `setMode
acceptEdits`, Repro 3) are IGNORED: we never answer with permission updates,
so no lasting approval is created on Claude's side.

**Owner A2 — «segue l'auto mode»:**
- **auto mode ON** → everything inside the run passes, Bash too. Nothing new
  implements it: every ask above is an ordinary `kind: "tool"` request, and the
  broker's own auto-accept answers it (`autoApproves`,
  `packages/core/src/permission.ts:310-318`). Harness code never reads the
  auto-mode bit — the broker stays the one place that decides.
- **auto mode OFF** → `Edit`/`Write` whose path is INSIDE the run's worktree
  pass without a prompt; `Bash` and anything outside are asked. Implemented as a
  RUN-scoped rule in the bridge, evaluated AFTER the gate's hook stage (a
  `tool_call` hook still blocks or rewrites) and only for a `write`-mode run with
  a worktree: path canonicalised (`realpath` of the parent dir, no `..`, no
  symlink escape) and inside the worktree root; never stored as a grant, gone
  with the run. `--restricted` (file tools confined to cwd, Repro 9) is a second
  fence under it.
What Claude decides alone: reads inside its working directory (Repro 3b) — the
same class tentacle runs without asking (`fs_read`/`search` are `permission:
"none"`, `packages/tools/src/builtins.ts:136`, `search-tool.ts:156`); with the
worktree as cwd that is the snapshot of the user's own tree (D8).

**D5 — Trust: laptop only, enforced on the laptop.**
(a) Harness types are added to `agentTypes` and `harness` deps are given to the
runner **only when `!tunnelled`** (`wiring.ts:763`), the same gate as
workflows; a pod config that names a harness type/`harnesses` gets a notice
and is ignored (as `wiring.ts:765-772` does for models). (b) The harness is
NOT a `ModelProvider` / `models` entry — otherwise `publishedModels` would let
a pod pick it through the model tunnel. (c) The laptop's inbound list
(`remote-client.ts:3357-3378`) gets no new method; a test pins that a pod
asking for anything else is `MethodNotFound`. A `serve` on another host the
user owns runs `claude` THERE with that host's login (Owner A8).

**D6 — Usage visible, no cap (Owner A4, A7).** Enabled by default
(`harnesses.claude-code.enabled`, default `true`; the type is offered only when
`claude` probes OK). No per-run `--max-budget-usd`, no quota-based refusal.
Visible: every report ends with one footer line — `— claude · <model> · $0.42
(list) · 5h 34% · 7d 12% · session <uuid> (claude --resume <uuid>)` — and
`agent_control status` shows the same (Max-plan note, Repro 1: `total_cost_usd`
is a list-price ESTIMATE, `costBasis:"list"`; the real limit is the 5 h / 7 d
window from `rate_limit_event`). A quota HIT is still a failure (Failure modes)
— that is Anthropic refusing, not our cap. What remains bounded is not a
spending cap: a workflow step's own `tokens` (the author's choice, existing
semantics) and the hang guard (idle timer, paused while an ask is pending). An
adapter without usage (A2A) shows «cost: not reported».

**D7 — Persistence.** Nothing new: the foreground report is the `agent_task`
result; a background one is `subagent_end{report}` (capped by its emitter, as
today). Claude keeps its own transcript (`~/.claude/projects`, not
`--no-session-persistence`) so the footer's `claude --resume <uuid>` lets the
user open it in a terminal. Events are not persisted beyond what a tentacle
child persists (labels on the live row only).

**D8 — Every `claude` run gets a worktree that is a snapshot of the user's
tree (Owner A3, A5).** With one role (`claude`, `mode: "write"`), a REVIEW is a
`claude` run too — so the worktree must show Claude what the user sees, or a
review of uncommitted work would read stale HEAD. `shr-3-worktree` creates
`git worktree add --detach <repo>/.tentacle/worktrees/harness-<id> HEAD`
(gitignored dir), then applies the session tree's uncommitted state: `git diff
--binary HEAD` (staged + unstaged) applied with `git apply --index`, plus
untracked non-ignored files copied (`git ls-files --others --exclude-standard`),
then a baseline commit on branch `harness/<id>`. Claude runs there with
`--restricted --tools Read,Grep,Glob,Edit,Write,Bash`. At the end: `git diff
--stat` against the baseline — **no change → worktree and branch removed; a
change → both kept**, the report ends with the branch, path and diffstat;
**never merged by us** (Owner A5). A non-git cwd: the run refuses with a clear
error (no worktree, no fallback to the real tree). A snapshot that fails to
apply (binary/conflict) → refuse with the git error, nothing left behind.

**D9 — Workflow verdict.** A harness child cannot call `step_verdict` (our
tool). For a workflow step (`controls.extraTools` contains `step_verdict`),
the run is given `--json-schema {verdict: pass|fail, reason, report}`; the
`structured` result is fed to the SAME `verdict.tool` the driver created
(calling its `execute` once), so `workflow-driver.ts:1714` reads it unchanged.
No new step kind: a step names the type and model (`type: claude`, `model: opus` — the step's `model` is passed through like `agent_task`'s for a harness type, and `workflow-spec.ts` accepts a free model string for a harness type instead of a `models` name).

**D10 — How a remote A2A agent fits (interface only; the adapter is
`feat/a2a`, not built here).** A remote agent is untrusted like a pod (AGENTS
§7) and has no access to this machine: it runs its own tools on its own side.
So, against the same seam:
- **Trust & consent.** `kind: "remote"`: only `mode: "remote"`, no `cwd`, no
  worktree, `caps.permissionAsks: false` (there is nothing local to approve).
  What crosses the trust line is the DATA the prompt carries off the laptop, so
  `start` of a remote run is one ordinary `kind: "tool"` broker ask («send this
  task to <name> at <origin>?», "always for this session" per agent) —
  **following auto mode (Owner A10)**: ON → the broker's auto-accept answers it
  (`permission.ts:310`), OFF → the person is asked. Its report,
  status texts and `input` questions are remote-supplied text: they reach the
  parent as a tool result (as today for any tool), never trigger a laptop
  effect by themselves, and every effect the parent then takes still goes
  through the broker. A `file` part is listed in the report (name, type, size)
  and never written to disk automatically.
- **Same gate as Claude.** Only `!tunnelled` wiring builds remote adapters
  (D5): a pod can neither name nor reach one.
- **Credentials.** Per harness instance in the laptop config
  (`harnesses.<name>: {adapter: a2a, card: <url>, auth: …}`), sent only to the
  card's own origin; an interface URL on another origin is refused unless
  configured (Agent Card `supportedInterfaces[].url`, spec §4.4.6).
- **Long-lived + reconnect.** The runner holds the `HarnessHandle` (`taskId`,
  `contextId`, card URL). On `disconnected` it calls `reattach` (A2A
  `SubscribeToTask`, valid only on a non-terminal task and starting with the
  current `Task`; no replay of missed events — spec §3.1.6, §3.5.2), bounded
  retries with backoff; a task found terminal on reattach is read once
  (`GetTask`) for its artifacts. A long task belongs in the background (`sa-N`),
  which already outlives the launching turn. Surviving a tentacle RESTART is
  out of scope (a background child is closed honestly on reload today); the
  handle in the footer keeps it recoverable later.
- **`INPUT_REQUIRED` mid-run** (spec §3.4.3: the client replies with a new
  message carrying the same `taskId` + `contextId`) → `ask{type:"input"}`.
  **Configurable per remote agent (Owner A9)**, `harnesses.<name>.inputFrom:
  parent | user | both`:
  `parent` → the existing two-way channel (`deps.notify` → an
  `agent_notify`-style note; the reply returns through the child's `inbox` via
  `agent_control message`, `subagent.ts:178-182`, `:356`); `user` → a broker
  question; `both` → both at once, **the first answer wins** and the other is
  withdrawn (the broker ask by its `withdraw` signal; a late inbox text is
  reported unread, the existing path, `subagent.ts:636-645`). `answer(askId,
  {text})` sends the winner. With no route available (parent chosen but no
  two-way / foreground), the child ENDS with the question + handle as its
  report, so nothing waits forever. Requirements this puts on `feat/a2a`: the
  user question is a NEW request kind that auto-accept never answers (added to
  the `autoApproves` exclusions next to `hooks_trust` / `workflow_approve`,
  `permission.ts:313-316` — a question needs a human's text, not an "allow"),
  that never offers session scope, and whose remote-supplied text is shown
  bounded like a pod's: **never a lasting approval from a remote** (Owner A9,
  AGENTS §7).
- **`AUTH_REQUIRED`** (spec §7.6) → `ask{type:"auth"}` → v1 fails the run with
  the agent's explanation + «configure credentials for <name>»; no interactive
  auth flow mid-run.
- **No usage/cost in A2A** (spec §4.1/§4.2 carry none): `caps.usage/cost/quota
  = false`; the runner's caps fall back to wall clock + idle + a per-session run
  count; the footer says «cost: not reported».
- **Cancel is best effort** (`CancelTask`, "success is not guaranteed",
  `TaskNotCancelableError` on a terminal task — spec §3.1.5): `cancel()`
  returns `"unconfirmed"` after a grace; the child ends `cancelled` locally and
  the report says the remote may still be running.

**Mapping: adapter method ↔ Claude Code headless (verified, Repro) ↔ A2A 1.0
(spec, not built)**

| `HarnessAdapter` / event | Claude Code `claude -p` (local process) | A2A remote agent |
|---|---|---|
| `kind` / `caps.workspace` | `local-process` / `local` (cwd or worktree, `--restricted`) | `remote` / `none` |
| `probe` | `claude --version` ≥ floor | `GET https://<host>/.well-known/agent-card.json` (§8.2); needs a `supportedInterfaces[]` with `protocolBinding` `JSONRPC` or `HTTP+JSON` and `protocolVersion` 1.0, `capabilities.streaming` (§4.4.1, §4.4.3, §4.4.6) |
| `start` | spawn `--input-format/--output-format stream-json --permission-prompt-tool stdio`, write the user line | `SendStreamingMessage` (SSE `text/event-stream`, §9.4.2 / §11.7); no streaming → `SendMessage` + `GetTask` polling |
| `events` | stdout JSONL: `system/init`, `assistant`, `user`, `rate_limit_event`, `control_request`, `result` | SSE `StreamResponse` = one of `task` / `message` / `statusUpdate` / `artifactUpdate` (§3.2.3, §4.2) |
| `started.handle` | `session_id` (→ `claude --resume <id>`) | `taskId` + `contextId` + card URL |
| `progress` | `assistant` `tool_use` blocks | `statusUpdate.status.message` text (no tool granularity) |
| `usage` / `cost` / `quota` | `assistant.message.usage`; `result.total_cost_usd` (list price); `rate_limit_event` 5 h / 7 d | none in the protocol |
| `ask permission` → `answer` | `control_request can_use_tool` → `control_response allow{updatedInput}` / `deny{message}` | n/a (the agent acts remotely; consent is asked once at `start`) |
| `ask input` → `answer` | n/a in `-p` | task `INPUT_REQUIRED` → `SendMessage` with same `taskId` + `contextId` (§3.4.3) |
| `ask auth` | `result{is_error, "Not logged in"}` → failure | task `AUTH_REQUIRED` (§7.6) / HTTP 401 → failure in v1 |
| `send` (steer) | another stdin user line | `SendMessage` on the same `taskId` |
| `output` | (final text only) | `artifactUpdate` parts `text` / `data` / `url` / `raw` (§4.1.6-7; results SHOULD be artifacts, §3.7) |
| `end` | `result` (`is_error`, `subtype`, `terminal_reason`, `structured_output`) | stream closes at a terminal (`COMPLETED`/`FAILED`/`CANCELED`/`REJECTED`) or interrupted state — no `final` flag (§3.1.2, §4.1.3) |
| `cancel` | `control_request interrupt` → `result aborted_streaming`; then stdin close → TERM → KILL group | `CancelTask` — not guaranteed; `TaskNotCancelableError` if terminal (§3.1.5) |
| `reattach` | none (a dead process is a crash; `--resume` is a NEW turn) | `SubscribeToTask` (non-terminal only, first event = current `Task`, no replay) else `GetTask{historyLength}` (§3.1.3, §3.1.6) |
| structured verdict (D9) | `--json-schema` → `structured_output` (enforced) | a `data` part, validated by us (unenforced remote-side) |

What the interface carries ONLY because of A2A, and costs Claude nothing:
`kind`, `caps`, `reattach`, `ask.input` / `ask.auth`, `output`,
`disconnected`, `cancel → unconfirmed`. Slice 3's tests drive a fake REMOTE
adapter through the runner so these paths exist and are pinned before any A2A
code is written.

### Files

Dependency order. Slice in brackets.

1. [shr-1] `packages/agent/src/harness/types.ts` (new) — D1 types (`HarnessAdapter`, `HarnessCaps`, `HarnessRun`, `HarnessEvent`, `HarnessHandle`) + `CliCodec`.
2. [shr-1] `packages/agent/src/harness/claude-code.ts` (new) — the Claude Code `CliCodec`: argv, `parse`, `answer`, `interrupt`, `userMessage`, version floor; pure.
3. [shr-2] `packages/agent/src/harness/process.ts` (new) — D2 process transport (`HarnessAdapter` from a codec + injected `Spawner`); uses `packages/exec/src/process-group.ts` (`trackGroup`, `killGroup`, `untrackGroup`).
4. [shr-3] `packages/agent/src/harness/worktree.ts` (new) — D8 snapshot worktree / diffstat / remove-if-clean via an injected git runner.
5. [shr-4] `packages/agent/src/subagent.ts` — `AgentType.harness`, `SubagentDeps.harness`, dispatch in `run`, `readOnlyType`.
6. [shr-4] `packages/agent/src/harness/child.ts` (new) — `runHarnessChild`: events → progress, D6 footer, hang guard, D10 input/auth/disconnect/reattach paths (fake remote adapter). Every permission ask is DENIED in this slice (safe default until shr-5).
7. [shr-4] `packages/tools/src/task.ts` — the `model` argument for harness types (free, shape-checked; D3).
8. [shr-4] `packages/config/src/schema.ts` (+ `defaults.ts`, `key-docs.ts`) — `harnesses.<name>.{adapter, enabled, command, model, idleMinutes}` keyed by INSTANCE name (so `feat/a2a` adds `adapter: a2a` instances with `card` / `auth` / `inputFrom`); only `claude-code` accepted here.
9. [shr-4] `packages/cli/src/wiring.ts` — harness deps + the `claude` type only `!tunnelled`; pod notice.
10. [shr-5] `packages/agent/src/harness/permissions.ts` (new) + `child.ts` — D4 bridge (gate → `subagentRequester` → broker), the auto-mode-OFF worktree rule, ignored suggestions; `changelog.d/subagent-harness-runners.added.md`.
11. [shr-6] `child.ts` + `packages/core/src/workflow-spec.ts` — D9 `--json-schema` verdict; free `model` on a harness step.

No A2A code, dependency or `@a2a-js/sdk` in this task (`feat/a2a`). No change to `packages/protocol` (no `protocol.d/` note), `client`, `daemon`, `tui`, `apps/mobile`.

### Failure modes

| case | how it converges |
|---|---|
| `claude` not on PATH | `probe` fails → the harness types are still listed but a call returns a tool error "Claude Code not installed (`command` …)"; no spawn. Probed lazily at first use, cached per process. |
| not logged in | `result{is_error:true}` despite `subtype:"success"` (Repro 7) → `SubagentFailure("Claude Code: Not logged in — run `claude /login` on this machine")`. The adapter keys on `is_error`, never on `subtype`. |
| quota hit (5 h window) | `rate_limit_event.status ≠ "allowed"` or an `is_error` result with a rate-limit error → failure with the reset time in the message (no refusal of later runs: Owner A4). *Unverified live (cannot trigger cheaply) — covered by a fake-harness test.* |
| unknown / mistyped model | Claude's own `is_error` result → `SubagentFailure` with its text; the parent picks another. A value starting with `-` or outside the shape never reaches argv. |
| uncommitted tree cannot be snapshotted | refuse before spawn with the git error; temp worktree removed. |
| hang (no events) | idle timer (`idleMinutes`, default 15; paused while an ask is pending) → cancel ladder → failure "no output for N min" with stderr tail. |
| cancel mid-run (Esc, `agent_control kill`, workflow stop) | signal → `interrupt` line → `result{error_during_execution}` (cost kept) → `stopReason "cancelled"`; if no result in 5 s → TERM/KILL the group. A pending ask is withdrawn (its `signal`). |
| tentacle exits / worker dies | the group is tracked → SIGKILLed by the exit net (`process-group.ts:2-28`); stdin EOF also ends Claude after its turn. |
| crash (non-zero exit, no `result`) | `SubagentFailure` with exit code + stderr tail + the text seen so far as partial report. |
| huge output | per-line cap (8 MiB): an over-long line is dropped and counted, never buffered whole; tool results are not forwarded (only labels); the report goes through the existing result transforms / `subagent_end` cap. |
| garbled / unknown event | unknown `type` ignored (forward-compatible); unparsable line counted; a run that ends without a parsable `result` is a failure. |
| version skew of the CLI | version floor checked at probe; `init` must echo the requested `tools` and a non-bypass `permissionMode`, else the run is killed before any tool executes (defends D4's assumption against a future flag change). |
| ask answered after the run ended | answer written only while the process is alive; late answers dropped (the ask was withdrawn by the run's signal). |
| two runs at once | each its own `harness-<id>` worktree/branch (writers run sequentially per `subagents.execution`, `task.ts:376`). |
| auto mode flips mid-run | each ask is decided by the broker when it is asked — the live value, nothing cached in the harness. |
| pod asks for a harness | impossible by construction (D5): no type, no dep, no method; pinned by tests. |
| empty report | the existing fallback text (`subagent.ts:659-663`) applies to the mapped result. |
| *Remote (A2A) — paths the interface must carry; exercised by a fake remote adapter in S3, implemented in `feat/a2a`:* | |
| Agent Card unreachable / no usable binding / wrong `protocolVersion` | `probe` fails → tool error naming the card URL and what is missing; no task sent. |
| stream drops mid-task | `disconnected` → `reattach` with backoff, bounded (e.g. 3); terminal on reattach → read once for artifacts; still failing → `SubagentFailure` whose report carries the handle (`taskId`) so nothing is silently lost. Missed events are NOT replayed (spec §3.5.2): the report says progress may be incomplete. |
| `INPUT_REQUIRED` | `ask input` → parent via two-way inbox; no two-way / foreground → child ends with the question + handle as its report (never blocks forever); idle timer paused while it waits, wall clock still runs. |
| `AUTH_REQUIRED` / HTTP 401 | failure with the agent's explanation and the instance name to configure. |
| `REJECTED` | `SubagentFailure("rejected by <name>: …")`. |
| cancel not honoured | `cancel()` → `"unconfirmed"` after grace → child ends `cancelled` locally; report: «the remote task may still be running (taskId …)». |
| remote text tries to steer the parent (prompt injection) | it is tool-result text like any other; no laptop effect without the broker; never an "always" from remote-supplied input (AGENTS §7). |
| remote `file` / huge artifact | listed, never written; text/data capped like any report. |
| remote run with no usage | footer «cost: not reported»; the hang guard still applies. |

### Tests

All with a **FakeHarness**: an injected `Spawner` returning an in-memory
process (scripted stdout lines, captured stdin lines, controllable exit and
signals) — the "fake spawner" pattern (§9). Fixtures are the Repro shapes
above. No real `claude` in any test.

- shr-1 `claude-code.test.ts`: argv always `--restricted`, `--permission-prompt-tool stdio`, never `dontAsk`/`acceptEdits`/`auto`/`bypass`; `--model` one element; `parse` of each Repro fixture; usage dedupe by message id; `is_error` + `subtype:"success"` → failed; `answer` allow carries `updatedInput` and NO permission updates, deny carries `message`.
- shr-2 `process.test.ts`: cancel ladder order (interrupt before TERM; TERM only if no `end` in grace — mutation: swap order → red); group tracked and released; over-long line dropped not buffered; no-`end` exit → failure with stderr tail.
- shr-3 `worktree.test.ts` (real temp git repo, no network): the worktree contains staged, unstaged and untracked-not-ignored changes of the source tree (mutation: drop the untracked copy → red); clean run removes worktree + branch; changed run keeps both and reports diffstat against the baseline; non-git cwd refuses; a failing apply leaves nothing behind.
- shr-4 `subagent-harness.test.ts`: a `claude` child emits start/tool/usage/end exactly like a tentacle child; free `model` reaches argv, a bad shape is refused before spawn; `readOnlyType("claude")` false; wiring with `modelOverride` registers no harness type (mutation: drop `!tunnelled` → red); `RemoteClient` answers `MethodNotFound` to an unknown pod request; every permission ask denied in this slice. `harness-remote-fit.test.ts` (**FakeRemoteAdapter**, in-memory, `kind: "remote"`, no usage): `disconnected` → `reattach` → completes; reattach exhausted → failure carrying the handle; `input` routed per `parent`/`user`/`both` with first-answer-wins and the loser withdrawn; no route → child ends with the question; `auth` → failure; `cancel` `unconfirmed` → `cancelled` + note; `mode: write` on a remote type refused.
- shr-5 `harness-permissions.test.ts` (**SpyBroker**): an ask reaches the broker through `subagentRequester` with the parent call id / `sa-N` (mutation: bypass the gate → red); with auto-accept ON a `Bash` ask is answered by the broker's `autoApproves`, never by harness code (mutation: harness answers allow itself → the spy sees no request → red); auto OFF: `Write` inside the worktree passes without a broker request, `Write` to `../x` and through a symlink out of the worktree are asked, `Bash` is asked; a `tool_call` hook blocking an in-worktree `Write` wins; a session grant `shell git status` answers `Bash git status`; unknown Claude tool never offers session scope; `permission_suggestions` never echoed.
- shr-6: workflow step `type: claude, model: opus` → `structured_output` becomes the step verdict (pass and fail); a step `tokens` budget hit → `budget_hit`.
- Gate: `bun run check` per slice.

### Slices

Owner routing (2026-11-25): Sonnet where a mistake is cheap to iterate on,
Opus where the slice touches an AGENTS §7 invariant; one final fresh-context
Opus review over the whole branch (not listed as a slice).

| order | SLICE id | what | size · blast | executor | estimate |
|---|---|---|---|---|---|
| 1 | `shr-1-codec` | D1 interface + Claude Code codec (pure) | S · contained | sonnet | ~350 lines incl. tests · ~1 h |
| 2 | `shr-2-process` | D2 process transport (spawn, groups, cancel ladder, line caps) | M · cross-module | sonnet | ~400 lines · ~1.5 h |
| 3 | `shr-3-worktree` | D8 snapshot worktree, diffstat, keep/remove | M · cross-module | sonnet | ~300 lines · ~1.5 h |
| 4 | `shr-4-seam` | D3/D5/D6/D10: sub-agent dispatch, `claude` type, free `model`, config, `!tunnelled` gate, footer, hang guard, remote-fit fake; asks denied | M · load-bearing (sub-agent seam, pod trust) | opus | ~600 lines · ~3 h |
| 5 | `shr-5-permissions` | D4: bridge to the one broker, auto-mode rule, worktree-write rule; changelog | M · load-bearing (single broker) | opus | ~400 lines · ~2 h |
| 6 | `shr-6-workflow` | D9: json-schema verdict, free model on a harness step | S · cross-module | sonnet | ~200 lines · ~1 h |

After this task (not in it): a read-only review role, background steering (`agent_message` → a stdin
user message), quota badge on TUI/phone (mockups first), a phone hub entry,
Codex/Gemini codecs, the A2A adapter (`feat/a2a`, client side).

### Owner questions

All answered 2026-11-25 (below). No new owner-visible choice arose from the
revision: the worktree snapshot of uncommitted changes (D8) is what makes A3
(«solo modelli precisi», no review role) correct for a review, and the
remote-input request kind (D10) is a consequence of A9 + §7.

1. Built-in types / model choice. 2. Asks in a write run. 3. Review role.
4. Caps and opt-in. 5. Worktree after a write run. 6. «Fallo fare a Claude»
from the phone. 7. Usage visibility. 8. Where it runs. 9. Remote
`INPUT_REQUIRED`. 10. Sending work to a remote agent.

### Owner answers

*Recorded verbatim, 2026-11-25 ~13:10.*

- Q1 types: «Non esiste modo dinamico per scegliere quale? Senza hardcodare tutti i modelli anthropic disponibili?» → the agent TYPE is a role and the MODEL is a free parameter of the call (no list in code): Claude Code accepts aliases opus/sonnet/haiku (it resolves them to the latest) or a full id; a config default (e.g. opus); the delegating agent may pick a lighter model.
- Q2 asks in a write run: «Segue l'auto mode» — the session's auto mode decides (auto mode ON → everything inside the run passes, Bash too; OFF → Edit/Write inside its worktree pass, Bash and anything outside asked through the broker).
- Q3 review type: «Senza claude-review per ora, solo modelli precisi» — NO claude-review role for now; ONE type 'claude' with the model chosen per call.
- Q4 caps: «Acceso, nessun tetto» — enabled by default, no per-run cap and no quota-based refusal (keep the usage visible, Q7).
- Q5 worktree: keep branch+worktree if it changed something, remove if clean, never auto-merge (as recommended).
- Q6 phone: through the chat for now (as recommended). Q7 usage: a line in the report + agent_control status (as recommended). Q8 where: laptop + any serve the user owns, never a pod (as recommended).
- Q9 remote INPUT_REQUIRED: «Configurabile» — per remote agent: the parent, the user via broker, or both (first answer wins); never a lasting approval from a remote.
- Q10 sending work to a remote agent: «Segue l'auto mode» — auto mode ON → starts without asking; OFF → one broker ask with 'always for this session' per agent.

### §7 re-check after the answers

*— claude-opus-5-5, 2026-11-25*

- **Single broker — holds.** Every ask the answers introduce (Claude
  permission, remote start A10, remote question A9) is a request to the ONE
  `permissions.request` (`wiring.ts:783`) via `subagentRequester`. Auto mode
  (A2, A10) is applied by the broker's `autoApproves`
  (`core/permission.ts:310-318`) and by nothing else; harness code never reads
  the bit. The only decision taken outside the broker is A2-OFF's in-worktree
  edit rule: run-scoped, after hooks, never a grant — the same footing as a
  confinement check, not a second approver.
- **A pod never — holds.** Unchanged `!tunnelled` gate (`wiring.ts:763`);
  and a pod cannot turn auto mode ON (the trusted-client bit,
  `client/src/remote-client.ts:586-595`), so A2/A10's "auto ON → pass" cannot
  be reached from a pod either.
- **Auto mode never answers `workflow_approve` / `hooks_trust` — holds.**
  Harness asks are `kind: "tool"`; a workflow using `claude` steps still has its
  hash approval and `approve` steps as `workflow_approve`, excluded at
  `permission.ts:316`. A9's user question must join those exclusions (a new
  kind, built in `feat/a2a`).
- **No lasting approval from untrusted input — holds.** Claude's
  `permission_suggestions` are never applied; a remote's answer/question never
  creates a grant (A9); the remote-start "always" is per agent, not per input.
- **A4 (no cap)** touches no invariant; usage stays visible (A7).
- **Persistence / protocol** — unchanged: no new log type, no wire change, no
  `protocol.d/` note.

## Execution

*— claude-sonnet-5-5, 2026-11-25 — slice shr-1-codec only*

- **Load-bearing check:** NOT re-run live — this sandbox denies spawning `claude` (approval required, non-interactive). Verified instead against the same-day recorded transcripts in `.tentacle/tmp/subagent-harness-runners/` (`run1/2/7.jsonl`: init shape, duplicate message ids, `permission_denied` for `--restricted`, rate_limit_event, result). Nothing contradicted the plan. The live re-run stays for slice 2 (`init.tools`/`permissionMode` check at run time).
- Added `packages/agent/src/harness/types.ts` (D1 types + `CliCodec`) and `packages/agent/src/harness/claude-code.ts` (`createClaudeCodeCodec()`, `versionAtLeast`, `isModelShape`, `claudeToolLabel`, `CLAUDE_CODE_VERSION_FLOOR = 2.1.331`).
- Tests: `packages/agent/test/harness-claude-code.test.ts` (23 tests, green).
- **Drift (small, deliberate):** (1) `CliCodec.parse` returns `HarnessEvent[] | null` (`null` = unparsable line, so the transport can count it) instead of a bare array; (2) a codec instance is ONE run (`createClaudeCodeCodec()` factory) because usage dedupe is stateful — "pure" here means no I/O; (3) the `usage` event is an INCREMENT per message id (a repeated id with a larger `output_tokens` reports only the delta); (4) the prompt is not in argv: with `--input-format stream-json` it is sent as `userMessage(prompt)` on stdin; (5) `argv` throws for `mode: "remote"`, a bad model shape, or a tool name outside `[A-Za-z][A-Za-z0-9_]*`; (6) `rate_limit_event` yields one `quota` per unified window; (7) the codec is not exported from `packages/agent/src/index.ts` yet (no consumer until shr-2).
- **Mutations (each → red, then reverted):** usage dedupe off → "usage is deduped" fails; key `result` on `subtype` instead of `is_error` → 2 fails; `allow` without `updatedInput` → "allow carries updatedInput" fails; drop `--restricted` → argv test fails; skip model shape check → "bad shape never reaches argv" fails.
- Lint: `biome check` on the 3 new files clean. Full gate: left to the orchestrator. No protocol/schema change (no `protocol.json`, no `protocol.d/` note).
- Changelog fragment `changelog.d/subagent-harness-runners.added.md` written (reword at shr-5 when the feature is reachable).

*— claude-sonnet-5-5, 2026-11-25 — slice shr-2-process only*

- **Load-bearing check:** NOT re-run live (this sandbox denies spawning `claude`, as in shr-1). The run-time defence the plan names (`init.tools` / `init.permissionMode` / version floor) is implemented in the transport and pinned by fake tests; the live re-run stays for the orchestrator.
- Added `packages/agent/src/harness/process.ts` (`createProcessAdapter`, `HarnessProc`, `Spawner`, `DEFAULT_SPAWNER`, `ProcessGroups`, `HarnessFailure`) and `packages/agent/test/harness-process.test.ts` (13 tests green; 36 with shr-1's file).
- Behaviour: spawn detached via the injected `Spawner`; `groups.track` after spawn, `untrack` on exit; prompt sent as `codec.userMessage`; stdout → capped lines (8 MiB; an over-long line is dropped + counted, never held whole); 4 KiB stderr tail; the event stream closes at `end` (process reaped separately: stdin EOF → TERM → KILL after 2 s graces); no `end` → `HarnessFailure{exitCode, stderrTail, partial, droppedLines, unparsableLines}`; cancelled with no `end` → synthesized `end{cancelled}`. Cancel ladder: interrupt line → wait ≤ 5 s for `end` → stdin EOF → SIGTERM group → 2 s → SIGKILL group. Init check: a bypass `permissionMode`, a tool in `init.tools` outside the allowed set, or a version below the floor SIGKILLs the group before any event is delivered. `probe` runs `<command> --version` (not installed / too old / unreadable → `ok:false`).
- **Drift:** (1) NO new `@tentacle/exec` dependency in `@tentacle/agent`: the sandbox could not link the workspace package; `trackGroup`/`untrackGroup`/`killGroup` are injected as `ProcessGroups`, and the shr-4 wiring (cli already depends on exec) supplies them. (2) `process.ts` imports `versionAtLeast` from `claude-code.ts`. (3) Optional `defaultTools` dep so the init tool check also covers the no-`spec.tools` case. (4) Not exported from `packages/agent/src/index.ts` (no consumer until shr-4). (5) No second changelog fragment: shr-1's `changelog.d/subagent-harness-runners.added.md` covers the task.
- **Mutations (each → red, then reverted):** SIGTERM before the interrupt → 3 ladder tests fail; line cap removed (per-line and partial-buffer guard) → over-long-line test fails; `track` removed → group-lifecycle test fails; init check disabled → 2 init tests fail.
- Lint: `biome check` on the 2 files clean; `tsc --noEmit` whole repo clean. Full gate left to the orchestrator. No protocol/schema change.
- Unverified: `DEFAULT_SPAWNER` against a real `claude` (only a real `sleep`: pgid = pid); stdout drain with a real lingering grandchild.

*— claude-sonnet-5-5, 2026-11-25 — slice shr-3-worktree only*

- **Load-bearing check:** re-run with real git in a temp repo (the tests): `git worktree add --detach` + `git apply --index --binary` of `git diff --binary HEAD` + copy of `ls-files --others --exclude-standard` + baseline commit reproduces staged, unstaged and untracked-not-ignored state. Holds.
- Added `packages/agent/src/harness/worktree.ts` (`createSnapshotWorktree`, `finishWorktree`, `removeWorktree`, `GitRunner`/`DEFAULT_GIT`, `WorktreeError`) and `packages/agent/test/harness-worktree.test.ts` (7 tests green).
- Behaviour: path `<repoRoot>/.tentacle/worktrees/harness-<id>`, branch `harness/<id>`; id shape-checked; non-git cwd / no commits / failed apply → `WorktreeError`, worktree+branch removed. `finishWorktree`: `add -A` then `diff --cached --stat <baseline>`; empty → remove both; otherwise keep and return `{branch, path, diffstat}`; an unreadable diffstat keeps everything (never loses work). Untracked symlinks are copied as symlinks; a path escaping the tree is refused.
- **Drift:** (1) not exported from `packages/agent/src/index.ts` (no consumer until shr-4). (2) The "non-git cwd" test uses a fake runner (exit 128 on `rev-parse`): the mandated scratch dir lives inside the main repo, so a real non-git dir is unreachable there. (3) The report text (branch/path/diffstat appended) is left to the shr-4 runner; this module returns the data. (4) No new changelog fragment: `changelog.d/subagent-harness-runners.added.md` covers the task.
- **Mutations (each → red, reverted):** untracked copy dropped → "contains staged, unstaged and untracked" fails; no cleanup on failed snapshot → "failing apply leaves nothing behind" fails; clean run not removed → "clean run removes worktree and branch" fails.
- Lint: `biome check` on both files clean; `tsc --noEmit -p packages/agent` clean. No protocol/schema change. Full gate left to the orchestrator.
- Unverified: a snapshot containing submodules or a tracked-file-deleted-and-untracked-replacement case (not tested).

## Review

*— pending*
