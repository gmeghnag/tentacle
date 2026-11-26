# Hooks and packages

## Hooks

Full reference and worked examples: [docs/extensions.md](../extensions.md#3-hook-reference).

`hooks` in `config.jsonc` runs your shell commands on tool and turn events
(user scope; a profile's `hooks` replaces the base list):

```jsonc
"hooks": [
  { "event": "tool_call", "matcher": "shell", "command": "~/.config/tentacle/hooks/no-rm.sh" },
  { "event": "tool_result", "matcher": "mcp__.*", "command": "python3 ~/hooks/redact.py", "timeout": 30, "onFailure": "block" }
]
```

- **Fields:** `event` (`tool_call`, `tool_result`, `turn_start`, `turn_end`,
  `model_request`), `command` (run with
  `/bin/sh -c` in the working folder), optional `name` (shown in the TUI;
  default: the basename of the command's first word), `matcher` (tool events
  only), `timeout` (seconds, default 600), `onFailure` (`ignore` default, or
  `block`).
- **Matcher:** a tool *name* (not its display label), `a|b` names, or a regex
  (`mcp__.*`); absent or `*` = every tool. Names ↔ labels: `shell` Bash,
  `shell_output` BashOutput, `shell_kill` BashKill, `fs_read` Read, `fs_write`
  Write, `fs_edit` Edit, `fs_multi_edit` MultiEdit, `agent_task` Agent, `skill`
  Skill; MCP tools are `mcp__<server>__<tool>`.
- **Input (stdin, JSON):** `event`, `session_id`, `cwd`, `agent` (`null`, or
  `{type, description}` in a sub-agent), `tool_name`, `tool_call_id`,
  `tool_input`; `tool_result` adds `tool_result: {content, is_error}`. Env:
  `TENTACLE_HOOK_EVENT`, `TENTACLE_PROJECT_DIR` (the repo root whenever
  inside a repository, else the folder of the nearest `.agents/hooks.json`,
  else the session folder), and `TENTACLE_PACKAGE_DIR` for a package's hooks
  and stdio MCP servers only (its own directory; an inherited value is
  dropped). Secret-looking env vars are
  scrubbed: a hook reads its own secrets. `tool_input` is the model's own
  arguments, **unredacted** (secret redaction, opt-in with `tools.redactSecrets: true`, applies to tool results only).
- **`tool_call` output:** exit 0 with empty stdout = no opinion; a JSON object
  with `decision` (`allow` skips the prompt for this call only, `ask` forces
  it, `deny` + `reason` refuses) and/or `input` (rewrites the call; the model
  is told). Exit 2 = deny, stderr is the reason. A `"deny"`-level tool stays
  refused whatever a hook says.
- **`tool_result` output:** `{"content": "…", "is_error": bool}` replaces the
  result (after secret redaction, when `tools.redactSecrets` is on); exit 2 = an error result
  with stderr. When a `tool_call` hook rewrote the input, the result it sees
  starts with the `[hook] input modified by hook <name>; ran with: …` line
  the model also gets. When a round's calls run in parallel (`tools.execution`),
  their `tool_result` hooks can run at the same time (`tool_call` hooks still
  run one at a time, in call order, within an agent; sub-agents running in
  parallel, `subagents.execution`, run theirs side by side): a hook that writes
  shared state (a log file, a counter) must tolerate concurrent runs.
- **`turn_start`** (once per turn, before the first model call; not on a
  resumed turn): input adds `prompt`. `{"context": "…"}` injects a note; exit 2
  stops the turn (stderr is the reason); a message you queued while it ran is
  kept in the history but not sent to the model (that turn does not run). `context` is clipped at 10,000 characters. Several
  hooks run in config order.
- **`turn_end`** when the model answered: input adds `reason: "end_turn"`,
  `last_assistant_message`, `continued` (0–2). `{"continue": true, "reason":
  "…"}` or exit 2 (stderr) injects the reason and runs another round — at most
  3 times per turn (a turn resumed after a restart starts a fresh count of 3). When the turn stops otherwise (`cancelled`,
  `max_iterations`) it is a notification: the output is ignored and the turn
  does not wait for it.
- **`model_request`** (a read-only notification before every model call,
  never awaited): input adds `iteration` (or `"final"`), `model`,
  `message_count`, `tool_names`, `new_messages` (`{role, content}` since the
  previous call). A call that arrives while the previous one still runs is
  dropped. Not run in a pod (the request is built there).
- **Notes:** every hook-injected message is a user-role note `[hook <event>]
  …`, kept in the history and shown dimmed in the TUI.
- **Failures** (other exit codes, timeout, invalid JSON, > 1 MiB stdout):
  ignored and logged by default (the daemon log, or stderr in `--plain` /
  one-shot mode); `onFailure: "block"` denies the call / turns the result into
  an error / stops the turn (`turn_start`) / continues it (`turn_end`). A hook killed by your cancel is not a failure.
- **Pods (`run` / `attach`):** hooks come from the **pod's** own config, loaded
  by the pod daemon. Your laptop's hooks do not run there, and a pod hook
  `allow` can skip the pod-side prompt. The pod-side gate is UX, never a
  security boundary (the pod is not trusted).
- **Project hooks:** a repository can bring hooks in `.agents/hooks.json`
  (`{ "hooks": [ … ] }`, same entries; found from the launch folder up to the
  repo root, nearest first). They run **only after you trust them**, asked
  once per session, after your own hooks for the same event. Locally you can
  trust them once or always (stored per folder with a hash of the
  definitions: a changed definition asks again; the scripts' contents are not
  tracked), decline, or say "never". In a pod you are asked every session,
  nothing is stored, and a project hook's `allow` never skips a prompt.
  Auto-accept never answers this question; a non-interactive run never loads
  them. `tentacle hooks trust --list` / `--revoke <folder>` manage the stored
  decisions.

## Packages

Full reference and a complete example package: [docs/extensions.md](../extensions.md#5-packages).

A package bundles skills, sub-agent types, MCP servers and hooks so you can
install and share them with one command:

```sh
tentacle package install ./my-pack              # a local directory (copied)
tentacle package install https://host/pack.git#v1   # git (shallow clone, optional #ref)
tentacle package list                           # name, version, enabled, source, counts
tentacle package update [<name>]                # git: pull --ff-only; a path: reinstall
tentacle package remove <name>
```

`tentacle install <path|git-url>[#ref]` is a shortcut for `tentacle package install`.

Each package lives in `<configDir>/packages/<name>/`:

```
tentacle-package.json   { "name": "<name>", "version": "1.0.0", "description": "…" }  (required)
skills/<skill>/SKILL.md agents/<type>.md                                             (optional)
mcp.json                { "<server>": { "command": "…", "args": [ … ] } }            (optional)
hooks.json              { "hooks": [ … ] }  (the same entries as `hooks`)            (optional)
```

- Names (package and server) match `^[a-z0-9][a-z0-9-]{0,31}$`. A server is
  named `<package>-<server>`, so its tools are `mcp__<package>-<server>__<tool>`.
- **Installing is trusting:** package hooks run as your own hooks, after
  yours (no project-trust prompt). `install` prints every hook command.
- Your own skills, agent types and MCP servers always win a name clash; a
  clash or a broken package is reported at startup, and the broken package is
  skipped whole. Agent types now resolve **first wins** everywhere: two files
  in `<configDir>/agents` defining the same type keep the first (by file
  name), with an `[agents]` notice. A package type replacing a built-in one is
  reported too.
- `update` trusts the **whole new version**, like installing: it prints every
  hook / MCP command that is new or changed, plus `git diff --stat` of the
  pulled range (a script a hook runs can change while its command does not).
  A `#tag` install is pinned: `update` leaves it.
- A symlink pointing outside the package (or dangling) rejects the package, at
  install and at every load; links inside it are kept as written. A package
  with more than 5000 files (`.git` excluded) is rejected.
- `"packages": { "<name>": false }` in the config (or a profile) disables one.
- Changes take effect at the next session start. Packages are **not**
  loaded in a pod session (`run` / `attach`): the pod uses its own config.

