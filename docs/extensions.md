# Extending tentacle

A reference for developers who build on top of tentacle with **hooks** and
**packages**. The short version is in the README
([Hooks](../README.md#hooks), [Packages](../README.md#packages)). This guide is
the deep reference: it is checked against the code and cites the module that
holds each rule.

## Contents

1. [Overview](#1-overview)
2. [Quick start: a first hook](#2-quick-start-a-first-hook)
3. [Hook reference](#3-hook-reference)
   - [Configuration](#31-configuration)
   - [Matchers, tool names and labels](#32-matchers-tool-names-and-labels)
   - [The hook process](#33-the-hook-process)
   - [Outcomes common to every event](#34-outcomes-common-to-every-event)
   - [`tool_call`](#35-tool_call)
   - [`tool_result`](#36-tool_result)
   - [`turn_start`](#37-turn_start)
   - [`turn_end`](#38-turn_end)
   - [`model_request`](#39-model_request)
   - [Cancel behaviour](#310-cancel-behaviour)
4. [Project hooks and trust](#4-project-hooks-and-trust)
5. [Packages](#5-packages)
6. [Worked examples](#6-worked-examples)
7. [Security model](#7-security-model)
8. [Debugging and troubleshooting](#8-debugging-and-troubleshooting)
9. [Known limitations](#9-known-limitations)

---

## 1. Overview

You can extend tentacle in two ways:

| Mechanism | What it is | Where it is defined |
|---|---|---|
| **Hooks** | Shell commands that tentacle runs on agent events. They get a JSON payload on stdin and can answer with JSON on stdout or with an exit code. They can block, rewrite or force a prompt for a tool call, rewrite a tool result, inject context at the start of a turn, continue a turn, or observe model requests. | `hooks` in `config.jsonc`, a repository's `.agents/hooks.json`, or a package's `hooks.json` |
| **Packages** | Declarative bundles of skills, sub-agent types, MCP servers and hooks. You install one with a single command. | `<configDir>/packages/<name>/` |

New **tools** and **slash commands** are not hooks. They already have their
own mechanisms: MCP servers (`mcpServers`) and skills (`SKILL.md`, invoked as
`/name`). A package bundles them.

### What is deliberately not offered

- **No in-process API.** tentacle does not load your JavaScript/TypeScript into
  its own process, and it has no plugin SDK. A hook is always a separate
  process that speaks JSON.
- **No compatibility layers.** Hooks use tentacle's own wire format and its
  own tool names. Scripts written for other agents (Claude Code, pi, …) do not
  run unchanged.

Why (`docs/eval/extensibility.md`, "Alternatives rejected"):

- An in-process API would turn `Agent`, `Tool`, the events and the session
  internals into a public contract, which is harder to change than the wire
  protocol.
- Such an extension would run with full access to your keys.
- An in-process module cannot fit the laptop/pod split, where one side is the
  workspace and the other is your identity (keys, approvals, history).

An external process works in any language. It runs wherever the agent loop
runs, and it sees only what the payload gives it.

### Where hooks run

A hook runs as a child process of whatever process runs the **agent loop**.
It uses that process's `ExecutionEnvironment` (`/bin/sh -c`, in the session's
working folder).

| How you run tentacle | Where the agent loop runs | Which hooks apply |
|---|---|---|
| `tentacle` (TUI, default) | A local worker thread on your machine (or the in-process fallback) | Your config + packages + trusted project hooks |
| `tentacle --plain`, one-shot `tentacle "prompt"` | The tentacle process itself | Your config + packages. **Project hooks never run** (nobody can be asked) |
| `tentacle serve` (+ `connect`) | The daemon host | The **daemon's** config + packages, and project hooks if the connecting client trusts them |
| `tentacle run` / `attach` (pod) | The daemon **inside the pod** | The **pod's own** config, plus the pod workspace's project hooks if you trust them. Your laptop's hooks and packages do **not** run there |

```
 laptop                                       pod (run / attach)
 ┌──────────────────────────────┐             ┌──────────────────────────────┐
 │ TUI ── RPC ── local worker   │             │ daemon (agent loop)          │
 │               ├ agent loop   │   RPC over  │  ├ hooks from the POD config │
 │               └ YOUR hooks   │◄──k8s exec─►│  └ pod project hooks (if     │
 │ trust prompt (single broker) │             │     you trust them, per      │
 │ model API key                │             │     session)                 │
 └──────────────────────────────┘             └──────────────────────────────┘
```

---

## 2. Quick start: a first hook

Goal: refuse any shell command that uses `sudo`. This needs `jq`.

1. Create the script `~/.config/tentacle/hooks/no-sudo.sh`:

   ```sh
   #!/bin/sh
   # Refuse any shell command that uses sudo.
   if jq -e '.tool_input.command | test("(^|[;&|[:space:]])sudo[[:space:]]")' >/dev/null; then
     echo "sudo is not allowed in this session" >&2
     exit 2
   fi
   ```

   ```sh
   chmod +x ~/.config/tentacle/hooks/no-sudo.sh
   ```

2. Add it to `~/.config/tentacle/config.jsonc`:

   ```jsonc
   {
     "hooks": [
       { "event": "tool_call", "matcher": "shell", "command": "~/.config/tentacle/hooks/no-sudo.sh" }
     ]
   }
   ```

3. Test it without tentacle. Every hook is a plain program that reads stdin:

   ```sh
   echo '{"event":"tool_call","tool_name":"shell","tool_input":{"command":"sudo ls"}}' \
     | ~/.config/tentacle/hooks/no-sudo.sh; echo "exit=$?"
   # sudo is not allowed in this session
   # exit=2
   ```

4. Start a **new** session. Hooks are read at session start. Ask the model to
   run `sudo ls`. In the TUI the call shows `⎿ hook no-sudo.sh blocked Bash`
   with the reason. The model gets
   ``Blocked by a hook: `shell` was not run. Reason: sudo is not allowed in this session``
   as an error result.

The config directory is `~/.config/tentacle` unless `TENTACLE_CONFIG_DIR` or
`XDG_CONFIG_HOME` moves it.

---

## 3. Hook reference

### 3.1 Configuration

Hooks come from three sources. In each event they run in this order:

1. **Your config:** `hooks` in `<configDir>/config.jsonc`. It is a top-level
   setting, so a profile's `hooks` **replaces** the base list.
2. **Packages:** each package's `hooks.json`, in package-name order. They run
   as your own hooks (section 5).
3. **Project hooks:** `.agents/hooks.json` in the repository. They run only
   after you trust them (section 4).

```jsonc
// <configDir>/config.jsonc
{
  "hooks": [
    { "event": "tool_call", "matcher": "shell", "command": "~/.config/tentacle/hooks/no-sudo.sh" },
    {
      "event": "tool_result",
      "name": "redact",
      "matcher": "shell|fs_read|mcp__.*",
      "command": "bun ~/.config/tentacle/hooks/redact.ts",
      "timeout": 30,
      "onFailure": "block"
    }
  ]
}
```

**Spec fields** (`HookSpecSchema`, `packages/config/src/schema.ts`; a strict
object, so an unknown key is an error):

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `event` | `"tool_call"` \| `"tool_result"` \| `"turn_start"` \| `"turn_end"` \| `"model_request"` | yes | — | When the hook runs |
| `command` | string (≥ 1 char) | yes | — | Run with `/bin/sh -c` in the session's working folder. Shell syntax works: `~`, `$HOME`, pipes, `VAR=x cmd` |
| `name` | string, 1–40 chars | no | Basename of the first word of `command` (`~/hooks/no-sudo.sh --x` → `no-sudo.sh`) | Shown in the TUI and the logs. A package hook is shown as `<package>:<name>` |
| `matcher` | string | no | every tool | **Tool events only.** Setting it on another event is a config error. See 3.2 |
| `timeout` | positive integer, **seconds** | no | `600` | The process is killed after this. A timeout counts as a failure |
| `onFailure` | `"ignore"` \| `"block"` | no | `"ignore"` | What a failed hook does (see 3.4) |

Validation:

- An invalid hook in `config.jsonc` (an unknown key, a `matcher` on a turn
  event, a regex that does not compile) is a **config error**, and tentacle
  does not start.
- An invalid `.agents/hooks.json` is skipped with a `[hooks]` startup line.
- An invalid package `hooks.json` skips the whole package with a
  `[packages]` line.

`.agents/hooks.json` and package `hooks.json` are **strict JSON** (no
comments). They have the shape `{ "hooks": [ <spec>, … ] }`, and no other
top-level key is allowed.

### 3.2 Matchers, tool names and labels

A matcher is tested against the tool's **name**, the identifier the model
calls. It is never tested against the CamelCase **label** the TUI shows
(`packages/core/src/tool-labels.ts`). Labels are display-only.

| Matcher | How it is tested |
|---|---|
| absent, or `"*"` | Matches every tool |
| Only `[A-Za-z0-9_-]` names joined by `\|` (`shell`, `fs_write\|fs_edit`) | **Exact** name match against each alternative |
| Anything else (`mcp__.*`, `^fs_`) | A JavaScript `RegExp`, **unanchored** (`test`). `shell.*` also matches `shell_output`. Use `^…$` for an exact match |

Built-in tools:

| Name (use in matchers) | Label (TUI only) | Default permission | `tool_input` fields |
|---|---|---|---|
| `shell` | Bash | ask | `command`, `cwd?`, `timeout?` (s), `run_in_background?` |
| `shell_output` | BashOutput | none | `job_id` |
| `shell_kill` | BashKill | none | `job_id` |
| `fs_read` | Read | none | `path`, `offset?`, `limit?` |
| `fs_write` | Write | ask | `path`, `content` |
| `fs_edit` | Edit | ask | `path`, `old_string`, `new_string`, `replace_all?` |
| `fs_multi_edit` | MultiEdit | ask | `path`, `edits: [{old_string, new_string, replace_all?}]` |
| `agent_task` | Agent | none | `description`, `prompt`, `subagent_type?` |
| `skill` | Skill | none | `name` |

MCP tools are named `mcp__<server>__<tool>`. Their default permission is
`ask`, and they show their name as the label. A package's server is
`<package>-<server>`, so its tools are `mcp__<package>-<server>__<tool>`.

> A matcher written with a label (`"Bash"`, `"Edit"`) is valid syntax but
> **matches nothing**, and nothing warns you.

### 3.3 The hook process

| Aspect | Behaviour |
|---|---|
| Shell | `/bin/sh -c "<command>"` |
| Working folder | The session's working folder (the `cwd` in the payload) |
| stdin | One JSON object (the payload), then EOF. A hook does not have to read it |
| Environment | The parent's environment **minus secret-looking variables** (names matching `API_KEY`, `ACCESS_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `CREDENTIAL(S)`, `PRIVATE_KEY`, `AUTH`, `TLS_KEY/CERT/CA`, case-insensitive; `packages/core/src/env.ts`), plus the variables below. A hook that needs a secret must read it from a file or a keychain itself |
| stdout | Empty, or **one JSON object**. More than 1 MiB is a failure |
| stderr | Read only on exit 2: it is the reason (trimmed, clipped at 2,000 chars). Otherwise it appears only in the failure log line (first 200 chars) |
| Timeout | `timeout` seconds (default 600). The process is killed |
| Runs | Hooks for the same event run **one after another**, in the order of 3.1 |

| Variable | Set for | Value |
|---|---|---|
| `TENTACLE_HOOK_EVENT` | every hook | the event |
| `TENTACLE_PROJECT_DIR` | every hook | the project root: the repo root (the `.git` holder, real path) whenever the launch folder is inside a repository, with or without project hooks; outside a repository, the folder holding the nearest `.agents/hooks.json`; else the session folder (`cwd`) |
| `TENTACLE_PACKAGE_DIR` | a package's hooks **and** its stdio MCP servers | that package's directory (`<configDir>/packages/<name>`); it overrides the same key in `mcp.json` `env`; an inherited value is dropped for every other hook and server |

In a pod these are the pod's own paths (the pod daemon runs the hooks; laptop
packages are not loaded there).

**Common payload fields**, present in every event:

| Field | Type | Meaning |
|---|---|---|
| `event` | string | The event name |
| `session_id` | string | The session. A sub-agent run has its **own** random id |
| `cwd` | string | The session's working folder |
| `agent` | `null` \| `{ "type": string, "description": string }` | `null` in the main agent. In a sub-agent (the `agent_task` tool), its type and the task description |

### 3.4 Outcomes common to every event

`packages/agent/src/hooks.ts` (`classify`) sorts each run into one of these:

| Process result | Classified as |
|---|---|
| exit 0, empty stdout | **No opinion** |
| exit 0, stdout is a JSON object | The event's answer (see each event) |
| exit **2** | The event's **"block"** action, with stderr as the reason. stdout is ignored |
| any other exit code | **Failure** (`exited N: <stderr>`) |
| timed out | **Failure** (`timed out`) |
| could not start | **Failure** (`could not be started`) |
| stdout > 1 MiB | **Failure** (`output exceeds 1 MiB`) |
| stdout not a JSON object (invalid JSON, an array, a string) | **Failure** (`output is not a JSON object`) |
| an unknown `decision`, or a wrong-typed `input`, `content`, `context` or `continue` | **Failure** (a non-string `reason`, and `is_error` without `content`, are ignored instead) |

Unknown fields in the JSON object are ignored. What a failure does depends on
`onFailure`:

| Event | `onFailure: "ignore"` (default) | `onFailure: "block"` |
|---|---|---|
| `tool_call` | No vote; logged | **Deny**, reason `hook failed: <why>` |
| `tool_result` | Result unchanged; logged | Result replaced by `hook failed: <why>`, `is_error: true` |
| `turn_start` | No context; logged | **Stop the turn**, reason `hook failed: <why>` |
| `turn_end` (`end_turn`) | No continue; logged | **Continue**, reason `hook failed: <why>` (counts toward the cap of 3) |
| `turn_end` (notification), `model_request` | Logged | Logged (`onFailure` has no effect: the output is ignored) |

Ignored failures are logged as `hook <name> (<event>) failed, ignored: <why>`.
Section 8 lists where that line goes.

### 3.5 `tool_call`

**When:** before a tool runs, inside the permission gate
(`packages/agent/src/permission-gate.ts`). It fires for every call of a
matching tool, also in sub-agents. Hooks of a `"deny"`-level tool **never run**:
that tool is refused first, whatever a hook would say.

**stdin:**

```json
{
  "event": "tool_call",
  "session_id": "7f0c…",
  "cwd": "/home/me/project",
  "agent": null,
  "tool_name": "fs_edit",
  "tool_call_id": "call_01",
  "tool_input": { "path": "src/a.ts", "old_string": "a", "new_string": "b" }
}
```

`tool_input` is the model's arguments, parsed, **unredacted** (`{}` if they
are not valid JSON). If an earlier hook rewrote the input, a later hook sees
the rewritten input.

**stdout** (exit 0):

| Field | Type | Effect |
|---|---|---|
| `decision` | `"allow"` \| `"ask"` \| `"deny"` | `allow`: run without a prompt, **for this call only** (never remembered). `ask`: force the permission prompt, even for a `none`-level tool or a command that a session rule already covers. `deny`: refuse |
| `reason` | string | With `deny`: the reason the model and the TUI see (clipped at 2,000 chars; default `blocked by hook`). Ignored otherwise |
| `input` | object | **Replaces the whole tool input** (not a merge: copy the fields you keep). It can be combined with `decision: "allow"` or `"ask"` |

**Exit 2:** deny, with stderr as the reason (default `blocked by hook`).

**Several hooks** (`combineToolCallVotes`) run in order, and each sees the
input as rewritten so far.

| Votes | Result |
|---|---|
| Any `deny` | Refused at once. Later hooks do not run |
| `input` given | The input is chained. The last hook that rewrote it is named |
| Any `ask` (also `input` + `ask`) | The prompt is forced |
| **Every** matching hook voted `allow` (or `input` + `allow`) | Runs without a prompt |
| Otherwise (one hook had no opinion, failed and was ignored, or rewrote without a decision) | Normal permission flow, on the rewritten input |

The normal flow: `none`-level tools run. An `ask` tool runs if a session rule
covers the **effective (rewritten) input**. Otherwise you are prompted, and
the prompt shows the rewritten input. A rewrite can therefore never slip a
different command past an approval you gave earlier.

> In `--plain` and one-shot mode there is no interactive prompt: the broker
> approves every `ask` itself. A hook `deny` still works there. A hook `ask`
> protects nothing.

**What the model sees:**

| Outcome | Tool result / history |
|---|---|
| Denied by a hook | ``Blocked by a hook: `<tool>` was not run. Reason: <reason>`` (`is_error`). The TUI shows `⎿ hook <name> blocked <Label>` with the reason |
| Input rewritten | The tool runs with the new input. The history keeps the model's **original** arguments, so the result starts with `[hook] input modified by hook <name>; ran with: <json, clipped at 500 chars>` and then a newline. The TUI shows `⎿ hook <name> modified <Label> input` |

If the rewritten input fails the tool's schema, the tool returns its usual
validation error.

### 3.6 `tool_result`

**When:** after a tool returns, as a stage of the result pipeline
(`packages/cli/src/wiring.ts`). The order is:

1. secret redaction (if `tools.redactSecrets` is on);
2. **hooks**;
3. deduplication and JSON tabulation (if on);
4. the large-output spill.

So a hook sees the **full** output (it is not spilled to a file yet), with the
secrets tentacle knows about already masked.

It also fires for:

- the results of calls that a hook or you refused (their content is the
  `Blocked by a hook…` / `Permission denied by the user…` text);
- `skill` results, including a skill you invoked as `/name`.

It does **not** fire for a call that was cancelled before it ran.

**stdin:**

```json
{
  "event": "tool_result",
  "session_id": "7f0c…",
  "cwd": "/home/me/project",
  "agent": { "type": "explore", "description": "find tests" },
  "tool_name": "fs_read",
  "tool_call_id": "call_02",
  "tool_input": { "path": "a.txt" },
  "tool_result": { "content": "hi", "is_error": false }
}
```

- `tool_input` is the input the tool **ran with** (after any `tool_call`
  rewrite), and it is unredacted. For a call a hook denied, it is the
  model's **original** input.
- When a `tool_call` hook rewrote the input, `tool_result.content` starts with
  the `[hook] input modified by hook …` line.

**stdout** (exit 0):

| Field | Type | Effect |
|---|---|---|
| `content` | string | Replaces the result text. Absent: the result is unchanged |
| `is_error` | boolean | Sets the error flag, **only together with `content`** (alone it is ignored). Absent: the flag is unchanged |

**Exit 2:** the result is replaced by stderr and marked as an error. Write a
message to stderr: with empty stderr the result becomes an **empty** error.

**Several hooks:** a chain. Each hook gets the content as the previous hook
left it.

### 3.7 `turn_start`

**When:** once per turn, before the first model call. Before it, in order:

1. the project-trust decision;
2. a `/skill` round;
3. background-job notes.

It does **not** fire on a turn that resumes after a restart (that turn
already started). It fires in sub-agent runs too: their `prompt` is the task
prompt.

**stdin:**

```json
{
  "event": "turn_start",
  "session_id": "7f0c…",
  "cwd": "/home/me/project",
  "agent": null,
  "prompt": "fix the bug"
}
```

`prompt` is the text of the last user message (`""` if there is none).

**stdout** (exit 0):

| Field | Type | Effect |
|---|---|---|
| `context` | string | Injected as a user-role note `[hook turn_start] <context>`. It is kept in the history and shown dimmed in the TUI. Clipped at **10,000** chars. Empty or whitespace only: nothing is injected |

**Exit 2:** **stop the turn** with stderr as the reason (default
`stopped by hook`). tentacle adds the note `[hook turn_start] turn stopped: <reason>`,
and the turn ends with no model call. A message you queued (steered) while
the hook ran stays in the history. It is not sent to the model: your next
message starts a turn that runs `turn_start` again.

**Several hooks:** they run in order. Each `context` is its own note. The
first stop ends the run: the contexts of the hooks before it are still
injected, and later hooks do not run.

### 3.8 `turn_end`

**When:** the model finished a round **with no tool calls** and was about to
end the turn (`reason: "end_turn"`). It does not fire on an empty, stalled
round (tentacle's own nudge handles that).

**stdin** (`end_turn`):

```json
{
  "event": "turn_end",
  "session_id": "7f0c…",
  "cwd": "/home/me/project",
  "agent": null,
  "reason": "end_turn",
  "last_assistant_message": "Done. All tests pass.",
  "continued": 0
}
```

`continued` counts the hook continues so far in this turn: 0, 1 or 2.

**stdout** (exit 0):

| Field | Type | Effect |
|---|---|---|
| `continue` | boolean | `true`: inject a note and run another model round. `false` or absent: the turn ends |
| `reason` | string | The note text (`[hook turn_end] <reason>`), clipped at 2,000 chars |

**Exit 2:** continue, with stderr as the reason.

**Several hooks:** **all** of them run, with no short-circuit. The turn
continues if **any** hook says so. The reasons are joined with newlines, and
if all of them are empty the note says `continue`.

**Cap:** at most **3** continues per turn (`MAX_HOOK_CONTINUES`,
`packages/agent/src/agent.ts`). After the third one, `turn_end` hooks are
**not called** again at the end of that turn. A turn resumed after a restart
starts a fresh count of 3.

**Notification variant:** when a turn ends otherwise, the hooks run with
`reason: "cancelled"` or `"max_iterations"` and only the common fields (no
`last_assistant_message`, no `continued`):

```json
{ "event": "turn_end", "session_id": "7f0c…", "cwd": "/home/me/project", "agent": null, "reason": "cancelled" }
```

This variant is not awaited: the output is ignored and failures are only
logged. A `turn_end` hook that was cancelled while it ran is followed by
this `cancelled` notification. Check `reason` before you do expensive work.

### 3.9 `model_request`

**When:** before every model call (each loop iteration, and the forced final
answer at the step limit). It is a **read-only notification**: the call is
not awaited, the output is ignored, and it cannot block or change the
request.

It runs only where this process calls the model provider itself. In a pod
session (`run`/`attach`) the request is built inside the pod, and
`model_request` hooks run **nowhere**.

**stdin:**

```json
{
  "event": "model_request",
  "session_id": "7f0c…",
  "cwd": "/home/me/project",
  "agent": null,
  "iteration": 0,
  "model": "claude-sonnet-4-5",
  "message_count": 2,
  "tool_names": ["fs_read", "shell"],
  "new_messages": [
    { "role": "system", "content": "…" },
    { "role": "user", "content": "hello" }
  ]
}
```

| Field | Meaning |
|---|---|
| `iteration` | The 0-based loop iteration, or `"final"` for the forced answer at the step limit |
| `model` | The configured model id. A sub-agent whose type sets `model` reports that one. `null` if it is unknown |
| `message_count` | The number of messages in the request |
| `tool_names` | The tools offered in this request |
| `new_messages` | `{role, content}` of the messages added since the previous `model_request` that this session **sent**. After a compaction (the history shrank), it holds all of them. Assistant tool calls are not included (`content` only) |

**Throttling:** at most one notification runs per session. A call that
arrives while one is still running is **dropped**. This is logged once per
burst: `hook model_request: previous notification still running, dropped`.
The next notification that is sent still includes the messages that were
skipped.

### 3.10 Cancel behaviour

The `tool_call`, `tool_result`, `turn_start` and `turn_end` (`end_turn`)
hooks run under the turn's abort signal. When you cancel the turn:

- the hook process is killed;
- it counts as **no vote** and is **not** a failure (nothing is logged, and
  `onFailure: "block"` does not apply);
- the remaining hooks for that event do not run;
- after a `tool_call` hook, you are never prompted and the tool does not run
  (`Cancelled by the user before this tool ran.`).

If you cancel while the project-trust question is open, that is no decision:
the hooks do not run this turn, and the next turn asks again.

Notifications (`turn_end` with `cancelled`/`max_iterations`, and
`model_request`) get no signal. They run until they exit or time out.

---

## 4. Project hooks and trust

A repository can bring hooks in **`.agents/hooks.json`**:

```json
{
  "hooks": [
    { "event": "turn_start", "command": "sh \"$TENTACLE_PROJECT_DIR/.agents/hooks/context.sh\"" }
  ]
}
```

**Discovery** (`packages/config/src/hooks-scan.ts`):

- tentacle reads every `<dir>/.agents/hooks.json` from the launch folder
  **up to the repository root** (the folder that holds `.git`), nearest first.
  It stops at the filesystem root or before `$HOME`, after at most 40 levels.
- The *project folder* is the real path of the repo root. With no `.git`, it
  is the launch folder.
- A file over **256 KiB**, invalid JSON or an invalid spec is skipped with a
  `[hooks] <file>: skipped (…)` startup line.
- The hooks would be offered for trust over the wire, and that request has
  limits: at most **100** hooks, a command of at most 4,096 chars, a matcher
  of at most 1,024 chars, and no control or bidi characters. Project hooks
  over these limits are reported at startup
  (`[hooks] project hooks of … cannot be offered for trust and will not run (…)`)
  and never run.

**Order:** project hooks run **after** your own hooks and the package hooks,
for the same event.

### The trust prompt

Before the first fresh turn of a session runs any hook or tool, tentacle asks
**once per session**: *Trust the hooks of this project?* The dialog shows:

- the folder;
- one line per hook (`event matcher → command`, the matcher only when set);
- the files they come from;
- if they could approve calls, "These hooks can approve tool calls without
  asking you.";
- "This trusts these commands, not the contents of the files they run."

| Choice (local TUI) | Effect | Stored |
|---|---|---|
| Trust for this session | Run them in this session | no |
| Always trust this project | Run them, and don't ask again while the definitions are unchanged | `trusted` + hash |
| Don't trust | Do not run them in this session | no |
| Never for this project | Do not run them, and stop asking, **even if the definitions change** | `never` |

- **Auto-accept (Shift+Tab) never answers this question.**
- Closing the dialog (or a dropped connection) counts as a decline.
- In a session that declined, project hooks do not run. Your own hooks run
  as usual.

**The stored decision** is in `<configDir>/hooks-trust.json` (mode 0600).
It is keyed by the project folder's real path and holds a **sha256 hash of
the definitions**. The hash covers each file's path (relative to the folder)
and its parsed hooks, with keys sorted, so formatting and key order do not
change it. Any change to a definition, or a new or removed file, **asks
again**. The **contents of the scripts** a command runs are **not** tracked.

```sh
tentacle hooks trust --list            # <decision>\t<hash prefix>\t<folder>, one per line
tentacle hooks trust --revoke .        # resolves the real path; "revoked: <folder>"
```

`--revoke` exits 1 with `no stored decision for <folder>` when there is
nothing to revoke. A bare `tentacle hooks` prints the usage and exits 1.

### Non-interactive runs

`--plain` and one-shot prompts have no one to ask. Project hooks **never run**
there, even for a project you marked "Always trust". The `[hook]` stderr line
says `project hooks of <folder> not run this session (no client to ask)`.

### Pods (`run` / `attach`) and `connect`

- In a pod, the project hooks come from the **pod's** workspace, and the pod
  daemon runs them. The question still goes to your laptop, through the same
  single permission broker. It is asked **every session** and **nothing is
  stored**: the menu offers only "Trust for this session" and "Don't trust".
- In a pod, a project hook's `allow` does not skip a prompt: its `allow`
  becomes no vote, and an `input` rewrite is kept without its forced
  `allow`. **This rule, and the trust answer itself, are enforced by the pod
  daemon** (its `HookRunner`), not by the laptop. An honest pod honours them;
  a compromised pod can ignore both. They are UX, not a security boundary.
- With `connect` to a `serve` daemon, the connecting client is asked each
  session, and nothing is stored either.

---

## 5. Packages

A package bundles skills, sub-agent types, MCP servers and hooks under one
name.

### 5.1 Layout

An installed package lives in `<configDir>/packages/<name>/`:

```
<name>/
├── tentacle-package.json      required: the manifest
├── skills/<skill>/SKILL.md    optional: Agent Skills, one dir per skill
├── agents/<type>.md           optional: sub-agent types
├── mcp.json                   optional: MCP servers
├── hooks.json                 optional: hooks, { "hooks": [ … ] }
└── …                          anything else (scripts, data) the above refer to
```

The contents are found by convention. The manifest lists no paths. Every
JSON file is **strict JSON** (no comments) and **strict schema** (an unknown
key rejects the package).

**`tentacle-package.json`** (`packages/config/src/packages.ts`):

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string matching `^[a-z0-9][a-z0-9-]{0,31}$` | yes | The package name. An installed package's directory must have this name |
| `version` | non-empty string | no | Shown by `install` and `list` (`-` when absent). It is free-form, and nothing compares it |
| `description` | string | no | Informational |

**`skills/<skill>/SKILL.md`:** the normal skill format. YAML frontmatter with
a `description` is required. `name` defaults to the directory name.

**`agents/<type>.md`:** the normal agent-type format. The frontmatter has
`name` (default: the file name), `description`, `tools` (a `[a, b]` list of
tool **names**; default all) and `model`. The body is the prompt.

**`mcp.json`:** `{ "<server>": <server def> }`. The server key matches the
same regex as the package name. A server def is one of:

| Kind | Fields |
|---|---|
| stdio (default when there is a `command`) | `type?: "stdio"`, `command`, `args?`, `env?`, `cwd?` |
| http (default when there is a `url` and no `command`) | `type?: "http"`, `url`, `headers?` |

**`hooks.json`:** `{ "hooks": [ <spec>, … ] }`, with the same specs as in
section 3.1.

### 5.2 How the contents are wired

| Content | Becomes | On a name clash |
|---|---|---|
| Skill | A user-scope skill, under its own name (not namespaced) | Precedence: project `.agents/skills` > `<configDir>/skills` > `~/.agents/skills` > packages (in name order). The first wins, and the others are reported as shadowed (`[skills]`) |
| Agent type | A sub-agent type for `agent_task`, under its own name | `<configDir>/agents` first, then packages in name order. The **first wins**, with an `[agents]` notice. A package type that replaces a built-in one gets an `[agents]` notice too |
| MCP server `<server>` | Server **`<package>-<server>`**, tools `mcp__<package>-<server>__<tool>` | Your own `mcpServers` and earlier packages win: `[packages] package <p>: MCP server "<key>" ignored (already defined by …)` |
| Hook | A **user-scope** hook, run after your own, in package-name order, named **`<package>:<name>`** | — (all of them run) |

Your own config always wins a clash.

A broken package (a bad manifest, `mcp.json` or `hooks.json`, an escaping
symlink, or a name that differs from its directory) is **skipped whole**,
with `[packages] package <name>: skipped (<why>)`.

**Paths inside a package:** hooks run in the **session's** working folder,
and an MCP server starts in the folder tentacle runs in (unless you set
`cwd`). Both get **`TENTACLE_PACKAGE_DIR`**, the package's own directory
(the env table in 3.3). To run a script shipped in the package:

- **Hook:** the command is shell: `"\"$TENTACLE_PACKAGE_DIR/bin/x.sh\""`.
- **MCP server:** `command` and `args` are not shell-expanded. Use a command
  on `PATH` (`npx`, `uvx`, `bunx`), or wrap it in `sh -c`:
  `{ "command": "sh", "args": ["-c", "exec \"$TENTACLE_PACKAGE_DIR/bin/server\""] }`.

### 5.3 Commands

```sh
tentacle package install <dir | git-url[#ref]>
tentacle package list
tentacle package update [<name>]
tentacle package remove <name>
```

`tentacle install <dir | git-url[#ref]>` is an alias of `tentacle package install`
(only as the first word; `--profile` still goes before it).

They run before any TUI, need no API key, and print plain text.

**`install`:**

- **Path source:** an existing directory. It is **copied**, and every `.git`
  is excluded.
- **Git source:** a URL matching `http(s)://`, `ssh://`, `git://`, `file://`
  or `user@host:path`, with an optional `#ref`. It runs
  `git clone --depth 1 [--branch <ref>] -- <url>`, without a shell and with
  `GIT_TERMINAL_PROMPT=0` (no credential prompt). **`git` is needed only for
  git sources.**
- A `ref` must match `^[A-Za-z0-9._/][A-Za-z0-9._/-]*$`. A ref or URL that
  could be read as a git option is rejected.
- The package is staged in `<configDir>/packages/.tmp-*`, validated, and
  then renamed into place. A failure leaves nothing half-installed.
- Installing a name that is already installed fails. The message points you
  to `update`.
- On success it prints, among other things, **every MCP command and every
  hook command** (the output below was captured from a real run):

```
installed demo 0.1.0 → /home/me/.config/tentacle/packages/demo
  skills: commit-message
  agent types: reviewer.md
  MCP servers: demo-memory
  runs as you, like your own config — installing trusts them:
    MCP demo-memory: npx -y @modelcontextprotocol/server-memory
    hook tool_call [shell]: "$TENTACLE_PACKAGE_DIR/bin/guard-rm.sh"
```

If the package is disabled in your config, `install` adds a note.

**`list`:** prints one tab-separated line per package (name, version or `-`,
`enabled`/`disabled`, source, counts), then any diagnostics:

```
demo	0.1.0	enabled	/path/to/demo-pack	1 skills, 1 agents, 1 MCP, 1 hooks
```

**`update [<name>]`** (all packages when no name is given):

| Source | What happens |
|---|---|
| path | Nothing. It prints `<name>: not installed from git — reinstall: tentacle package remove <name> && tentacle package install <path>` |
| git, installed with `#<tag>` (detached HEAD) | **Pinned:** `<name>: pinned to <tag>, unchanged (reinstall to change version)` |
| git, on a branch (no `#ref`, or `#<branch>`) | `git pull --ff-only`. With no new commit: `<name>: already up to date` |

After a pull that changed something, `update` prints `git diff --stat` of the
pulled range, plus every hook or MCP command that is new or changed.
**Updating trusts the whole new version.** A script a hook runs can change
while the hook's command line stays the same, which is why the file list is
shown:

```
updated demo (takes effect at the next session start)
  changed files:
   bin/guard-rm.sh | 1 +
   hooks.json      | 4 ++++
   2 files changed, 5 insertions(+)
  runs as you, like your own config — updating trusts them:
    hook turn_start: date
```

If the new version is invalid, `update` says so and exits 1. The package is
then skipped at session start.

**`remove <name>`:** deletes the directory and prints `removed <name>`.

**Disabling without removing:** `"packages": { "<name>": false }` in
`config.jsonc`. It is a top-level setting, so a profile's `packages`
replaces the base map.

### 5.4 Rules and limits

- **Symlinks:** a link that points outside the package, or a dangling link,
  **rejects the package**: at install, and at every load. Links inside the
  package are kept as written (a path install copies them verbatim).
  Symlinked directories are not followed.
- **Size:** at most **5,000** entries (files and directories; only the
  top-level `.git` is excluded from the count).
- **Names:** `^[a-z0-9][a-z0-9-]{0,31}$` for packages and their servers.
- **Tool-name length:** some providers reject tool names over 64 characters.
  tentacle warns about such MCP tools only in one-shot mode and in the
  `--in-process` / fallback TUI. `--plain` connects no MCP servers, so it
  never warns.
- **When changes apply:** at the next session start.
- **Not in pods (v1):** packages are **not** loaded in `run` / `attach`
  sessions. The pod uses its own config, and tentacle prints
  `[packages] N installed package(s) are not loaded in a pod session (the pod uses its own config)`.

---

## 6. Worked examples

Every script below was run against tentacle's real `HookRunner` with
`HostExecution` (the same code path the daemon uses), with the outputs shown.
The bash examples need `jq`. Save each script, `chmod +x` it, and reference
it by absolute path (or `~/…`).

### 6.1 Block `rm -rf` outside the workspace (bash, `tool_call`)

```bash
#!/usr/bin/env bash
# tool_call hook (matcher: shell): refuse `rm -r -f` on a path outside the workspace.
# A heuristic guard, not a sandbox: it reads the command text only.
set -euo pipefail
set -f                                           # no glob expansion of the args
input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
ws=$(jq -r '.cwd' <<<"$input")

# Only `rm` invocations with both -r/-R and -f (in any flag spelling).
grep -Eq '(^|[;&|[:space:]])rm[[:space:]]' <<<"$cmd" || exit 0
grep -Eq '[[:space:]]-[a-zA-Z]*[rR]' <<<"$cmd" && grep -Eq '[[:space:]]-[a-zA-Z]*f' <<<"$cmd" || exit 0

# Check every argument after `rm` that is not a flag.
for arg in $(sed -E 's/.*(^|[;&|[:space:]])rm[[:space:]]+//; s/[;&|].*//' <<<"$cmd"); do
  case "$arg" in
    -*) continue ;;
    "~"* | *'$'*) target="$arg" ;;              # home or a variable: treat as outside
    /*) target="$arg" ;;
    *) target="$ws/$arg" ;;
  esac
  # Normalise `..` without requiring the path to exist.
  norm=$(python3 -c 'import os,sys; print(os.path.normpath(sys.argv[1]))' "$target")
  case "$norm" in
    "$ws" | "$ws"/*) ;;                          # inside the workspace: fine
    *)
      echo "rm -rf outside the workspace is not allowed: $arg" >&2
      exit 2
      ;;
  esac
done
exit 0
```

```jsonc
{ "event": "tool_call", "matcher": "shell", "command": "~/.config/tentacle/hooks/guard-rm.sh" }
```

Results:

| `command` | Verdict |
|---|---|
| `rm -rf build dist` | no opinion (normal prompt) |
| `rm -rf /tmp/x` | deny: `rm -rf outside the workspace is not allowed: /tmp/x` |
| `cd x && rm -fr ../../etc` | deny (`../../etc`) |
| `rm -Rf ~/projects` | deny (`~/projects`) |
| `rm -r /tmp/x` | no opinion (no `-f`) |
| `rm -rf *` | no opinion (relative, inside) |

It checks only the last `rm` in a pipeline, and it does not understand
`cd` or `$(…)`. It is also bypassed by a quoted path (`rm -rf "/tmp/x"`)
and by the long flags (`rm --recursive --force /tmp/x`). Treat it as a guard
rail, not a boundary.

### 6.2 Rewrite the input (bash, `tool_call` with `input`)

This replaces `git push --force` / `-f` with `--force-with-lease`, and still
asks you before it runs:

```bash
#!/usr/bin/env bash
# tool_call hook (matcher: shell): rewrite `git push --force` / `-f` to
# `--force-with-lease`, and still ask the user before it runs.
set -euo pipefail
input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
case "$cmd" in
  *"git push"*) ;;
  *) exit 0 ;;
esac
new=$(sed -E 's/(^|[[:space:]])(--force|-f)([[:space:]]|$)/\1--force-with-lease\3/g' <<<"$cmd")
[ "$new" = "$cmd" ] && exit 0
# `input` replaces the WHOLE tool input: keep the other fields (cwd, timeout, …).
jq -c --arg c "$new" '{decision: "ask", input: (.tool_input + {command: $c})}' <<<"$input"
```

For `{"command":"git push --force origin main","timeout":60}` it prints
`{"decision":"ask","input":{"command":"git push --force-with-lease origin main","timeout":60}}`.
The prompt shows the new command, the result starts with
`[hook] input modified by hook force-with-lease.sh; ran with: {…}`, and the
TUI shows `⎿ hook force-with-lease.sh modified Bash input`.

Chaining: with this hook listed **before** the guard from 6.1, the guard gets
the rewritten command. `git push -f && rm -rf /` was denied by `guard-rm.sh`
after the rewrite.

### 6.3 Redact secrets in results (TypeScript/Bun, `tool_result`)

```ts
#!/usr/bin/env bun
// tool_result hook: mask secrets tentacle's own redaction does not know about.
// Prints nothing when there is nothing to change (= keep the result as is).
const PATTERNS: [RegExp, string][] = [
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED aws-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "[REDACTED github-token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED slack-token]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED private-key]"],
];

const payload = JSON.parse(await Bun.stdin.text());
const original: string = payload.tool_result.content;
let content = original;
for (const [re, label] of PATTERNS) content = content.replace(re, label);

if (content !== original) {
  // `is_error` omitted: the result keeps its error flag.
  process.stdout.write(JSON.stringify({ content }));
}
```

```jsonc
{ "event": "tool_result", "name": "redact", "matcher": "shell|fs_read|mcp__.*",
  "command": "bun ~/.config/tentacle/hooks/redact.ts", "timeout": 30, "onFailure": "block" }
```

Here `onFailure: "block"` makes the hook fail closed: if it crashes, the
model gets `hook failed: …` instead of the raw output.

Verified output: `AWS=AKIAABCDEFGHIJKLMNOP` became `AWS=[REDACTED aws-key]`,
and a GitHub token became `[REDACTED github-token]`. A clean result passed
through unchanged, with its error flag kept.

### 6.4 Inject git context (bash, `turn_start`)

```bash
#!/usr/bin/env bash
# turn_start hook: tell the model which branch it is on and what is uncommitted.
set -uo pipefail
cat >/dev/null                                   # the payload is not needed
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
branch=$(git branch --show-current 2>/dev/null)
status=$(git status --short 2>/dev/null | head -n 30)
jq -n --arg b "${branch:-(detached HEAD)}" --arg s "${status:-clean}" \
  '{context: ("git branch: " + $b + "\ngit status --short (first 30 lines):\n" + $s)}'
```

```jsonc
{ "event": "turn_start", "command": "~/.config/tentacle/hooks/git-context.sh", "timeout": 10 }
```

Injected note (verified):

```
[hook turn_start] git branch: main
git status --short (first 30 lines):
?? a.txt
```

### 6.5 Continue until the tests pass (bash, `turn_end`)

```bash
#!/usr/bin/env bash
# turn_end hook: when the model says it is done, run the tests; on failure,
# send it back with the tail of the output (tentacle allows at most 3 per turn).
set -uo pipefail
input=$(cat)
# A cancelled / max_iterations turn is only a notification: do nothing.
[ "$(jq -r '.reason' <<<"$input")" = "end_turn" ] || exit 0
# Skip turns that did not touch the code (cheap filter; adjust to taste).
git diff --quiet HEAD -- 2>/dev/null && exit 0

out=$(${TEST_CMD:-bun test} 2>&1) && exit 0
continued=$(jq -r '.continued' <<<"$input")
jq -n --arg o "$(tail -n 40 <<<"$out")" --arg n "$continued" \
  '{continue: true, reason: ("The tests fail (continue #" + $n + "). Fix them before finishing:\n" + $o)}'
```

```jsonc
{ "event": "turn_end", "command": "TEST_CMD='bun test' ~/.config/tentacle/hooks/tests-must-pass.sh", "timeout": 900 }
```

- When the tests fail it returns `{"continue":true,"reason":"The tests fail (continue #0). …"}`
  on the first end of the turn (`continued` starts at 0), then `#1` and `#2`.
- When they pass it prints nothing, and the turn ends.
- After 3 continues tentacle stops calling it for that turn, so the turn ends
  even if the tests still fail.
- The `timeout` must cover the whole test run. A timeout is an ignored
  failure (the turn ends) unless you set `onFailure: "block"`.

### 6.6 Log model requests (bash, `model_request`)

```bash
#!/usr/bin/env bash
# model_request hook: append one line per model call to a JSONL file.
# Read-only and never awaited: output is ignored, so it can only observe.
log="${TENTACLE_REQUEST_LOG:-$HOME/.local/state/tentacle/requests.jsonl}"
mkdir -p "$(dirname "$log")"
jq -c '{ts: (now | todate), session_id, agent: (.agent.type // null), iteration, model,
        message_count, tools: (.tool_names | length),
        new: [.new_messages[] | {role, chars: (.content | length)}]}' >>"$log"
```

```jsonc
{ "event": "model_request", "command": "~/.config/tentacle/hooks/log-requests.sh", "timeout": 5 }
```

A logged line (verified):

```json
{"ts":"2026-10-22T07:11:18Z","session_id":"s1","agent":null,"iteration":0,"model":"demo-model","message_count":2,"tools":2,"new":[{"role":"system","chars":3},{"role":"user","chars":5}]}
```

Keep this hook fast. While it runs, the next request's notification is
dropped (3.9).

### 6.7 A minimal complete package

```
demo-pack/
├── tentacle-package.json
├── skills/commit-message/SKILL.md
├── agents/reviewer.md
├── bin/guard-rm.sh          # the script from 6.1
├── hooks.json
└── mcp.json
```

`tentacle-package.json`:

```json
{
  "name": "demo",
  "version": "0.1.0",
  "description": "Commit-message skill, an rm guard and a memory MCP server"
}
```

`skills/commit-message/SKILL.md`:

```markdown
---
name: commit-message
description: Write a Conventional Commits message for the staged changes. Use when the user asks to commit or to write a commit message.
---

1. Run `git diff --cached` to read the staged changes.
2. Write a subject line `<type>(<scope>): <summary>`, at most 72 characters.
3. Add a body that says why, not what, wrapped at 72 columns.
```

`agents/reviewer.md`:

```markdown
---
name: reviewer
description: Read-only code reviewer for a diff
tools: [fs_read, shell]
---
You review the diff you are given. Report bugs first, then risky changes. Do not edit files.
```

`hooks.json`. The script is addressed through `$TENTACLE_PACKAGE_DIR` (the
package's own directory), because hooks run in the session's working folder
(5.2):

```json
{
  "hooks": [
    {
      "event": "tool_call",
      "name": "guard-rm",
      "matcher": "shell",
      "command": "\"$TENTACLE_PACKAGE_DIR/bin/guard-rm.sh\""
    }
  ]
}
```

`mcp.json`:

```json
{
  "memory": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"]
  }
}
```

Install it with `tentacle package install ./demo-pack`. The output is shown
in 5.3. Verified after install by loading the config:

- the hooks are `[<your hooks>…, "demo:guard-rm"]`;
- the skill `commit-message` is in the catalog;
- the server is `demo-memory`, so its tools are `mcp__demo-memory__<tool>`;
- `rm -rf /etc` was denied by the hook `demo:guard-rm`;
- with a `demo-memory` server already in your own `mcpServers`, the package's
  server was ignored, with a `[packages]` line.

To publish it, push the directory to a git repository and tag a release.
Users then run `tentacle package install https://host/you/demo-pack.git#v0.1.0`.

---

## 7. Security model

- **`--plain` and one-shot have no permission prompt.** Their broker
  approves everything (`allowAll`), so every `ask`-level tool (`shell`,
  `fs_write`, `fs_edit`, MCP tools, …) runs unprompted, and a hook `ask` or
  "no opinion" means *run*. There, only a hook `deny` (or exit 2) protects
  you.
- **A hook is code that runs as you.** It has your user's file access and
  network, and the environment of the agent process (minus the secret-looking
  variables). A `tool_call` hook that answers `allow` skips the permission
  prompt.
- **Installing or updating a package is a trust decision.** Package hooks
  and MCP servers are user-scope. There is no project-trust prompt for them.
  `install` and `update` print every command they trust, and `update` prints
  the changed files, because a script can change while its command line does
  not. Review a package as you would review a script you `curl | sh`.
- **Project hooks are code a cloned repository brings.** They run only after
  a human trusts them: auto-accept never answers, and non-interactive runs
  never load them. The stored trust is bound to the hash of the
  **definitions**, not to the scripts they call. A repository you trusted
  "always" can change a script without asking you again. Use
  `tentacle hooks trust --revoke <folder>` when in doubt.
- **What a hook sees:**
  - `tool_input` is the model's own arguments, **unredacted**. Secret
    redaction (`tools.redactSecrets`, **off by default**) applies to tool
    **results** only.
  - A `tool_result` hook sees the output **after** tentacle's redaction, when it is on.
  - When an input was rewritten, the content starts with the
    `[hook] input modified by hook <name>; ran with: …` line.
  - `model_request` hooks see the new messages of every request, including
    the system prompt on the first call. Treat their log files as sensitive.
- **The model learns about interventions.** A deny reason, a rewrite (the
  `ran with:` line), and every `turn_start` / `turn_end` note are text in the
  conversation. Do not put secrets in them.
- **Pods are not trusted.** In `run` / `attach`, hooks come from the
  **pod's own config** and run in the pod, and so does the permission gate
  there. A pod hook's `allow` skips the prompt **on your laptop**. That is
  UX, never a security boundary: whoever controls the pod controls its
  daemon. Your laptop's hooks do not protect a pod session.
  - The laptop asks the trust question for pod project hooks (every
    session, never stored). But the **pod** applies the answer, and the pod
    also applies the rule that a project hook cannot `allow` there.
    `canAllow` on the wire is display-only. An honest pod honours both; a
    compromised pod ignores both.

---

## 8. Debugging and troubleshooting

### Where things are reported

| What | Where |
|---|---|
| A hook blocked or rewrote a call | TUI: `⎿ hook <name> blocked <Label>` (+ reason) or `⎿ hook <name> modified <Label> input`, under the tool call. `--plain` / one-shot: `[hook] <name> blocked <Label>` |
| Injected notes (`turn_start`, `turn_end`, a stopped turn) | Dimmed `[hook <event>] …` lines in the TUI. They are kept in the history |
| A failure with `onFailure: "ignore"`, a dropped `model_request`, a declined project trust | Local TUI: `<configDir>/logs/daemon-errors.log` (never the screen). `--plain` / one-shot: stderr, `[hook] …`. `tentacle serve`: `[daemon] error: …` on its output. Pod: the pod daemon's stderr (`[daemon] …`), which tentacle buffers and prints after the TUI exits |
| Invalid `hooks` in `config.jsonc` | `[config error] Invalid …config.jsonc: hook "<name>": …`. tentacle does not start |
| Project hook files | `[hooks] <file>: skipped (…)`, `[hooks] project hooks of … cannot be offered for trust …` at startup |
| Packages | `[packages] package <name>: skipped (…)`, MCP clash lines, and the pod notice at startup |
| Agent types | `[agents] agent type "<t>" in <path> ignored (already defined by …)` / `… replaces the built-in one` |
| Skills | `[skills] …` (shadowed, invalid) |

Startup lines (`[hooks]`, `[packages]`, `[agents]`, `[skills]`) print before
the TUI opens. In `run` / `attach` only the `[packages]` pod notice prints,
because the pod reports its own config.

Watch the failure log during a session:

```sh
tail -f ~/.config/tentacle/logs/daemon-errors.log
```

### Test a hook outside tentacle

A hook is a program that reads one JSON object from stdin. Copy a payload
from section 3, change it, and pipe it in:

```sh
jq -n '{event:"tool_call",session_id:"t",cwd:env.PWD,agent:null,tool_name:"shell",
        tool_call_id:"c",tool_input:{command:"rm -rf /tmp/x"}}' \
  | ~/.config/tentacle/hooks/guard-rm.sh; echo "exit=$?"
```

To capture the real payloads, add a temporary hook:
`{ "event": "tool_call", "command": "cat >> /tmp/tentacle-payloads.jsonl; echo >> /tmp/tentacle-payloads.jsonl" }`.

### Common mistakes

| Symptom | Cause |
|---|---|
| The hook never runs | The matcher uses a **label** (`Bash`, `Edit`) instead of a name (`shell`, `fs_edit`). Or you edited the config during a session (hooks are read at session start). Or a profile replaced `hooks` |
| The hook "allows" but you are still prompted | Another matching hook had no opinion, failed, or rewrote without `decision`. `allow` needs **every** matching hook to allow. Or it is a project hook in a pod |
| `output is not a JSON object` in the log | The script prints debug text on stdout. Send logs to stderr, and print exactly one JSON object or nothing |
| The rewritten call lost its options | `input` replaces the whole input. Merge: `.tool_input + {command: $c}` |
| A tool result became empty and is marked as an error | The hook exited 2 with empty stderr |
| `exited 127` | The command was not found. `PATH` is the agent process's `PATH`, the hook runs in the session folder, and relative script paths resolve from there |
| The project hook script is not found from a subfolder | Hooks run in the session's folder, not the repo root. Use `"$TENTACLE_PROJECT_DIR/…"` |
| A `turn_end` hook runs the tests after a cancel | It received the `cancelled` notification. Check `reason == "end_turn"` |
| The hook needs a token but sees none | Secret-looking variables are scrubbed. Read the token from a file or a keychain |
| A project hook never runs in CI or scripts | `--plain` and one-shot never run project hooks |
| `matcher is only valid on tool_call / tool_result` | Remove `matcher` from turn and model events |

---

## 9. Known limitations

These are recorded as debt or out of scope in the task docs
(`docs/feat/{hooks-core,hooks-turn,hooks-project-trust,packages}.md`,
`docs/eval/extensibility.md`):

- **No laptop-side ("identity") hooks for pod sessions.** In `run` /
  `attach`, hooks run in the pod, and `model_request` runs nowhere. A deny-only
  laptop policy and a laptop `model_request` audit are a follow-up eval (D12).
- **`model_request` is notify-only.** It cannot block, modify or redact a
  request (D12).
- **Script contents are not part of project trust.** Only the definitions are
  hashed (D4, by design). The prompt says so.
- **After `/resume`, hook notes render as plain user messages** in the TUI,
  not as dimmed notes (`tui/src/resume.ts`). The nudge and `[background]`
  notes behave the same way.
- **Packages are not loaded in pods (v1).** Sources are a path or git only.
  npm is "later" (D11).
- **The 64-character tool-name warning** for MCP tools is shown only in
  one-shot mode and the `--in-process` / fallback TUI, not in the default
  (worker) TUI.
- **`--plain` and one-shot approve every prompt**, so a hook `ask` has no
  effect there. Project hooks never run there.
- **Unverified on a live cluster:** hook stdin and the project-trust flow in a
  real `run` / `attach` pod are covered by wiring tests, not by a live pod
  run (`hooks-core` review item (c), `hooks-project-trust` "Unverified").
- **Unverified against a remote git host:** `install` and `update` of a git
  source were tested with a fake git runner and with a local `file://`
  repository (for this guide), not against a networked remote.
