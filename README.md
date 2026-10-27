<p align="left">
  <img src="art/tentacle-lockup.svg" alt="tentacle" height="220">
</p>

A coding agent that runs next to your code and keeps your identity on your machine.

- **Private by design:** the model key, your permission decisions and your session history stay on your laptop, even when the agent runs in a container or pod
- **Any engine:** local · Docker · Podman · Kubernetes · a remote daemon (`serve` / `connect`), with the same commands and the same session
- **Any model:** local models (any OpenAI-compatible endpoint) are first-class; the Anthropic Messages API works too
- **Safe by default:** writes confined to the workspace; shell commands go through a permission prompt

## Why tentacle

**Privacy first: execution elsewhere, identity on your laptop.**
The model API key, your permission decisions and your session history stay on
the laptop. A pod or container reaches the model through the laptop (a reverse
tunnel), so the key never enters it. The remote side is not trusted: what it
asks of your machine (a tool permission, project hooks, a model call) is decided
on the laptop. Local models work the same way as cloud ones.

**One agent, any engine.**
Run it locally, in Docker (also on a remote host over `ssh://`), in Podman, in
Kubernetes, or as a remote daemon you reach with `connect`. The commands and the
session are the same. In a container, your folder is mounted with secrets hidden
(`~/.ssh`, tentacle's config, and anything in `.tentacle/hide`).
`tentacle ps` and `tentacle rm` manage the workloads you kept.

**The TUI is decoupled from execution.**
The agent loop and the tools run in a daemon; the TUI is an RPC client on the
same protocol for every runtime. You can quit and come back, attach several
clients to one session, and reopen archived sessions.

## Install

On macOS or Linux (x64 and arm64):

```sh
curl -fsSL tentacle.so/install | sh
```

It installs the CLI in `~/.local/bin` (no sudo), checks it against the
release's `SHA256SUMS`, then runs `tentacle update` to fetch the pod binaries.
Options, as environment variables: `TENTACLE_VERSION=v0.1.0` (pin a release;
0.1.0 is the oldest), `TENTACLE_INSTALL_DIR`, and `TENTACLE_NO_POD_BINARIES=1`
(skip the pod binaries). The script is
[`scripts/install.sh`](scripts/install.sh); read it before piping it to `sh`.

## Getting started

The first run creates `~/.config/tentacle/` with a commented `config.jsonc` and
a `PROMPT.md`. Point it at your model:

```jsonc
// ~/.config/tentacle/config.jsonc
{
  "model": {
    "baseURL": "http://localhost:8080/v1",
    "model": "my-model",
    "apiKey": "your-api-key"
  }
}
```

## Ways to run

**Standalone:** the agent runs on your machine, in the current folder.

```sh
tentacle                                          # interactive TUI
tentacle "summarise src/ and suggest a refactor"  # one-shot
tentacle --plain                                  # line REPL (pipes / no TTY)
tentacle --resume                                 # resume a saved session of this folder
```

**`run`: in a new Kubernetes pod or Docker/Podman container.** tentacle
creates it, copies itself in (the pod binaries from [Install](#install)), and
by default leaves it up on exit (also on Ctrl+C), printing the `tentacle attach …`
to come back. `--keep=false` (or `keep: false` in the config or a profile)
deletes it on exit instead; flag > profile > user config > true. The model key and the approvals
stay on your machine; sessions are saved locally, so `--resume` works.

```sh
tentacle run --image <ref> [-n <namespace>] [--keep=false] [<name>]           # Kubernetes (default)
tentacle run --engine docker --image <ref> [--context <ctx>] [<name>]     # Docker
tentacle run --engine podman --image <ref> [<name>]                       # Podman
```

**Your folder, in the container (Docker/Podman).** On a local engine `run`
bind-mounts the current folder read-write at the same path, and the agent works
in it: your real files, with the container's own processes, packages and
network. `--no-mount` opts out. Only the cwd is mounted (never a parent or the
git root). Secrets inside the folder are hidden behind an empty read-only
overlay (checked after start): by default `~/.ssh`, `~/.aws`, `~/.kube`,
`~/.config/gcloud`, `~/.docker/config.json`, `~/.netrc` — `"mount": {"hide": […]}`
in `config.jsonc` (or a profile) replaces that list, `"hideExtra"` adds to it;
tentacle's config dir and the `apiKeyCommand` key file (`cat <file>`, also
`cat "$HOME/…"`) are always hidden; for any other command the file cannot be
named, and the run warns that it is NOT hidden. On a case-insensitive disk
(macOS, exFAT/NTFS, ext4 casefold — checked on the disk, not by OS) a hidden
FILE is still readable under another spelling (`KEY` for `Key`), so the run
refuses: hide the folder that contains it (a directory mask holds), or move
the file. `--confirm-mount` overrides this for your own entries (and warns,
naming them) — never for the key file. A project can add its own with `.tentacle/hide` in the folder
(gitignore-style: `#` comments, globs and `**`, a trailing `/` for directories;
`!` only un-hides what that same file hid — never the lists above). It only
ADDS, and the patterns are resolved to the paths that exist when the container
starts: a file created later is NOT hidden. More than 200 matches stops the run
(narrow the patterns); a pattern or symlink pointing outside the folder is
ignored with a warning. A `.tentacle/hide` that is unreadable, not a regular
file (a FIFO…), a link out of the folder or over 64 KiB stops the run. The startup line says `Hidden from the container: N
paths from .tentacle/hide, M defaults`. Mounting `/`, `/usr`, `/usr/local[/bin]`, `~/.ssh` or the config
dir (or a folder inside them) is refused. Your home, its parents, a system dir
or a folder on the hide list asks first (y/N); without a terminal it is
refused unless `--confirm-mount`. A remote engine
(`tcp://`, `ssh://`) mounts nothing and says so. On rootful Docker on Linux the
agent runs as your uid:gid (files stay yours); Docker Desktop and rootless
Podman need nothing; SELinux hosts get `label=disable` for the container. The
image's code can write your folder (`.git/hooks`, `package.json` scripts…):
run only images you trust there, or use `--no-mount`. A kept container keeps its
mount; `attach` from another folder warns.

**`attach`: in a pod or container that already exists.** Same as `run`, but
tentacle never creates, starts or deletes it: closing the TUI detaches and it
stays up.

```sh
tentacle attach <pod> [-n <namespace>] [-c <container>]
tentacle attach --engine docker|podman <container>
```

**Kept pods and containers: `ps` → `attach <name>` → `rm`.** Every kept `run`
is recorded on your machine (`<configDir>/kept/`, where it was created — no
credentials). `tentacle ps` lists them, checked against their engine (NAME
ENGINE WHERE MOUNT MODEL AGE STATUS; one removed outside tentacle shows `gone`;
an engine that does not answer within 3 s is a dim `not reachable (skipped)`
line, never an error); `--engine` filters, `-q` prints names, `-v` details.
`tentacle attach <name>` needs no `--engine`: the engine and location are looked
up (an explicit `--engine`/`-n`/`--context`/`-c` skips the lookup).
`tentacle rm <name>` removes it — only a workload that still carries tentacle's
managed and kept labels, re-checked right before the delete; a running one asks
`[y/N]` (`-f` skips; without a terminal, `-f` is required). A name that now
belongs to something else is left alone and its stale entry dropped.

```sh
tentacle ps [--engine <e>] [-q|-v]
tentacle rm [--engine <e>] [-f] <name>
```

**Engines.** `--engine kubernetes|docker|podman` picks where it runs; the
default is `kubernetes`, or set `"engine"` in `config.jsonc` (or a profile), or
`TENTACLE_ENGINE` (precedence: flag › env › profile › config file). Kubernetes
uses your kubeconfig (current context, or `$KUBECONFIG`); no `kubectl` needed.
Docker uses the engine the docker CLI would (`--context` › `DOCKER_HOST` ›
`DOCKER_CONTEXT` › current context; unix socket, `tcp://` with TLS, or
`ssh://`); no `docker` CLI needed. A plaintext `tcp://` engine is refused
unless `--insecure-docker-tcp`. Podman's socket is found automatically
(`podman machine` on macOS, rootless/rootful on Linux; `CONTAINER_HOST`
overrides it) — no `DOCKER_HOST` needed. `-n`/`-c` are Kubernetes-only;
`--context`/`--insecure-docker-tcp` are Docker/Podman-only. Read-only root
filesystem? Add `--bin-dir /tmp`. Details:
[`docs/architecture/F4-pod-execution.md`](./docs/architecture/F4-pod-execution.md),
[`docs/feat/docker-engine-cli.md`](./docs/feat/docker-engine-cli.md).

**`serve` + `connect`: on a remote host.** Run the agent as a daemon on one
machine and drive it from another machine's TUI:

```sh
tentacle serve --host 127.0.0.1 --port 4000 [--token T | --token-command CMD]
tentacle connect ws://host:4000 [--token T] [--resume [id] | --continue]
```

Quitting `connect` detaches: the session, a running turn and its background
jobs keep going on the daemon, and the exit line says how to come back
(`--resume <id>`). `--resume` picks one of the daemon's sessions (or names
one; an ended session is reopened), `--continue` takes the newest. In the TUI,
`/sessions` lists the daemon's sessions to switch to or delete (`x` twice),
`/close` ends the session for every device and quits, `/clear` ends it and
starts a fresh one. `connect` keeps no laptop copy: the daemon's record is
the truth.

A non-loopback `--host` requires a token. TLS: `--tls-cert`/`--tls-key` on
`serve`; `--ca-cert FILE` on `connect` for a private CA. Details:
[`docs/architecture/F3-remote-control.md`](./docs/architecture/F3-remote-control.md).

`tentacle --help` lists every flag.

## Configuration

Precedence: **environment variables › `config.jsonc` › built-in defaults**.

| Config key (`config.jsonc`) | Env override | Meaning |
| --- | --- | --- |
| `model.provider` | `TENTACLE_PROVIDER` | `openai` (default) or `anthropic` |
| `model.baseURL` | `TENTACLE_MODEL_BASE_URL` | Base URL incl. version. Default: `http://localhost:8080/v1` (openai) or `https://api.anthropic.com/v1` (anthropic) |
| `model.model` | `TENTACLE_MODEL` | Model id sent to the endpoint |
| `model.apiKey` | `TENTACLE_MODEL_API_KEY` | API key, **stored in plaintext** (discouraged) |
| `model.apiKeyCommand` | — | Shell command whose stdout is the key; never written to disk |
| `model.contextWindow` | — | Token budget for the TUI context meter |
| `model.maxTokens` | `TENTACLE_MAX_TOKENS` | Max output tokens per response. Unset: omitted for openai, `64000` for anthropic |
| `systemPromptFile` | `TENTACLE_SYSTEM_PROMPT` (inline) | System prompt file (default `PROMPT.md`) |
| `maxIterations` | `TENTACLE_MAX_ITERATIONS` | Max model/tool rounds per turn |
| `subagents.enabled` | `TENTACLE_SUBAGENTS` | The `agent_task` sub-agent tool (default on) |
| `contextReset.enabled` | `TENTACLE_CONTEXT_RESET` | The model's `context_reset` tool: it renews its own context from a restart prompt it writes, asked like any tool (default on) |
| `contextReset.maxPerMessage` | `TENTACLE_CONTEXT_RESET_MAX` | Context resets per user message (default `-1` = unlimited) |
| `loadSkills` | `TENTACLE_NO_SKILLS` (truthy disables) | Agent Skills discovery (default on) |
| `engine` | `TENTACLE_ENGINE` | Default engine of `run`/`attach`: `kubernetes` (default), `docker` or `podman`; `--engine` wins. An unknown value is an error |

Key precedence: `TENTACLE_MODEL_API_KEY` › file `apiKey` › file `apiKeyCommand`.
`TENTACLE_CONFIG_DIR` (or `XDG_CONFIG_HOME`) moves the config directory.

### Hooks

Full reference and worked examples: [docs/extensions.md](docs/extensions.md#3-hook-reference).

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
  the model also gets.
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

### Packages

Full reference and a complete example package: [docs/extensions.md](docs/extensions.md#5-packages).

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

## Features

- **Tools:** `fs_read`, `fs_write`, `fs_edit` (with diffs), `shell`, background jobs.
- **Permissions:** shell commands need approval; "always" approvals are scoped to a command prefix.
- **MCP servers**, **sub-agents** (`agent_task`, custom types in `<configDir>/agents/*.md`) and **Agent Skills** (`SKILL.md` in `.agents/skills/`, `<configDir>/skills/` or `~/.agents/skills/`; `/skill-name` in the TUI). See [`docs/architecture/skills.md`](./docs/architecture/skills.md).
- **TUI:** diffs, mouse scroll and selection, slash commands, `/compact`, saved sessions; `/help` lists the rest.

## Development

```sh
bun install
bun run check        # typecheck + lint + test (the CI gate — must pass)
```

Building the binaries yourself: [`docs/BUILD.md`](./docs/BUILD.md). Cutting a
release: [`docs/RELEASING.md`](./docs/RELEASING.md). Design and
decision records: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

| Package | Purpose |
| --- | --- |
| `protocol` | Wire protocol: JSON-RPC 2.0 + session/tool/permission schemas (Zod) |
| `core` | Core contracts: `ModelProvider`, `Tool`, `ExecutionEnvironment`, `PermissionBroker`… |
| `config` | Config loader (`config.jsonc` + env + defaults), scaffolding |
| `providers` | OpenAI-compatible and Anthropic providers, SSE streaming |
| `exec` | Host execution, workspace confinement, background jobs |
| `tools` | Tool registry and built-in tools |
| `mcp` | MCP client: servers' tools exposed to the agent |
| `agent` | Agent loop, sessions, sub-agents, compaction, permission gate |
| `transport` | JSON-RPC peer over a duplex channel |
| `daemon` | Session host: `serve`, pod daemons, the in-process worker |
| `client` | Remote client the TUI drives |
| `k8s` | Kubernetes client: pods, exec, kubeconfig auth |
| `cli` | Entry point and runtimes (`run`, `attach`, `serve`, `connect`) |
| `tui` | Ink/React terminal UI |
