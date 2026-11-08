<p align="left">
  <img src="art/tentacle-lockup.svg" alt="tentacle" height="220">
</p>

<p align="left">
  <a href="https://github.com/gmeghnag/tentacle/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/gmeghnag/tentacle?color=06b6d4"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="platforms" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%7C%20x64%20%C2%B7%20arm64-555">
  <img alt="engines" src="https://img.shields.io/badge/engines-Kubernetes%20%C2%B7%20Docker%20%C2%B7%20Podman-555">
</p>

A coding agent that runs next to your code and keeps your identity on your machine.

- **Private by design:** the model key, your permission decisions and your session history stay on your laptop, even when the agent runs in a container or pod
- **Any engine:** local · Docker · Podman · Kubernetes · a remote daemon (`serve` / `connect`), with the same commands and the same session
- **Any model:** local models (any OpenAI-compatible endpoint) are first-class; the Anthropic Messages API works too
- **Safe by default:** file writes confined to the workspace and the system temp dir (`tools.writableDirs`); shell commands go through a permission prompt

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
tentacle -- explain how config works              # one-shot starting with a subcommand word
tentacle --plain                                  # line REPL (pipes / no TTY)
tentacle --resume                                 # resume a saved session of this folder
```

A first word that names a subcommand (`run`, `explain`, `update`, …) **is** that
subcommand, so a one-shot prompt that starts with one needs `--` first:
`tentacle -- explain how config works` sends it to the model.

**`run`: in a new Kubernetes pod or Docker/Podman container.** tentacle
creates it, copies itself in (the pod binaries from [Install](#install)), and
by default leaves it up on exit (also on Ctrl+C), printing one line,
`[container] <name> still running · tentacle attach <name>` (`[pod]` on Kubernetes),
to come back — printed once the TUI opens, never before a setup failure.
Informational status lines are dim grey on a terminal (not with `NO_COLOR`).
The pod daemon's own stderr is never printed: it goes to `daemon.log` in the run's
state dir (`~/.config/tentacle/kept/runs/<id>/`, else `~/.config/tentacle/logs/<name>/`;
mode 0600; every run/attach APPENDS after a `--- <time> run|attach <name> ---` line, the
newest 64 KiB kept). A real failure (the daemon dies, the link ends or never comes back —
a reconnect that recovered is not one — or the TUI fails) prints ONE line,
`[container] <name>: daemon stopped unexpectedly · log: <path>`;
a failed startup prints `[container] failed: <short cause> · log: <path>` (plus
` · still up: tentacle rm <name>` when a kept workload was left running) and the log
holds the full text. A model or turn error is not a failure: the TUI already showed
it. The startup status line redraws in place (cut to the terminal width, never
padded). `--rm` (or `rm: true` in the config or a profile)
removes it when the run ends instead (`--rm=false` overrides the config); flag > profile > user config > default (kept). The model key and the approvals
stay on your machine; sessions are saved locally, so `--resume` works. Each session
is one append-only log, `~/.config/tentacle/sessions/<folder>/<uid>.jsonl`;
`sessions: { keepSuperseded: true }` also keeps the history a compaction or a
context reset replaced (default off).

```sh
tentacle run --image <ref> [-n <namespace>] [--rm] [--name <n>] ["<prompt>"]        # Kubernetes (default)
tentacle run --engine docker --image <ref> [--context <ctx>] [--name <n>] ["<prompt>"]  # Docker
tentacle run --engine podman --image <ref> [--name <n>] ["<prompt>"]                    # Podman
```

`--name <n>` names the workload (a random name when omitted). The optional
`"<prompt>"` (or `--prompt <text>`; not both) is the **first message**: the TUI
opens and sends it at once, as plain text (a leading `/` is not a command). It
cannot be combined with `--resume`/`--continue`. `--auto-accept[=true]` starts
the TUI with auto-accept already on (the state Shift+Tab toggles); `=false`
changes nothing.

**With no TUI.** `tentacle run -d|--detach "<prompt>" --image <ref> [--name <n>]`
(or `--prompt <text|->`; `--prompt -` reads the prompt from stdin, only with `--detach`)
creates the workload, then a background process on your machine runs the turn,
serves the model and saves the session, and leaves after 60 s of idle. A tool
that needs permission waits for you unless `--auto-accept` (pod tool asks only,
allow once, logged in `<configDir>/kept/runs/<id>/relay.log`). `tentacle attach
<name>`, from a terminal in the same folder, takes the run over at any moment,
mid-turn or at a held permission, and it opens the run's session after the
process left too. More terminals can attach: they share the session, an ask shows
on each and the first answer wins. An `--auto-accept` run stays auto-accept for
the terminals that attach; Shift+Tab flips it for every terminal on that session,
and a session turned off stays off. `/quit` closes the session for every terminal on it (asking `y/N`
first when others are attached): a running turn stops, the last save is taken,
and the others leave with `session closed by another terminal`. Ctrl+C at idle
leaves only that terminal. With `--rm` the quit that closes the session
removes the workload, if no other session in it is in use. A workload deleted
outside tentacle is said as such, naming the session uid.

A successful `run --detach` prints one dim line, `[container] <name> still running ·
tentacle attach <name>`, and nothing else; `attach` to a run prints no `resolved …` or
`[resume] …` line either (failures still say why).

With `--rm` (or `rm: true`) the workload is listed in `ps` while the
run lives and removed when it goes idle or is stopped, a held permission keeping
it alive. `kill <pid>` counts as a stop, and so does a laptop shutdown that sends
SIGTERM. Its files go with it, a mounted laptop folder excepted; the transcript
stays in `tentacle --resume <uid>`, and its `relay.log` is deleted with it. A run
that failed or was interrupted, or a workload another client is using, stays:
`tentacle rm <name>` clears it. So does a crash the exit net could not catch (a
`kill -9`, a power loss), shown as `relay lost`. On macOS the Mac stays awake
while a turn runs (`detach: { keepAwake: false }` turns it off); closing the lid
still sleeps it, and the run then ends `interrupted`.

**Your folder, in the container (Docker/Podman).** On a local engine `run`
bind-mounts the current folder read-write at the same path, and the agent works
in it: your real files, with the container's own processes, packages and
network. `--no-mount` opts out. Only the cwd is mounted (never a parent or the
git root). Secrets inside the folder are hidden behind an empty read-only
overlay (checked after start): by default `~/.ssh`, `~/.aws`, `~/.kube`,
`~/.config/gcloud`, `~/.docker` (the folder), `~/.netrc` — `"mount": {"hide": […]}`
in `config.jsonc` (or a profile) replaces that list, `"hideExtra"` adds to it;
tentacle's config dir and the `apiKeyCommand` key file (`cat <file>`, also
`cat "$HOME/…"`) are always hidden; for any other command the file cannot be
named, and the run warns that it is NOT hidden. On a case-insensitive disk
(macOS, exFAT/NTFS, ext4 casefold — checked on the disk, not by OS) a hidden
FILE is still readable under another spelling (`KEY` for `Key`), so the run
refuses, in two lines: `[container] won't mount <folder>: <file> would be readable
inside the container` and `  fix: add `<its folder>/` to .tentacle/hide` (a directory
mask holds for every spelling) or `move <file> out of the folder` when it sits in the
mount root. `--confirm-mount` overrides this for your own entries (and warns,
naming them) — never for the key file. A project can add its own with `.tentacle/hide` in the folder
(gitignore-style: `#` comments, globs and `**`, a trailing `/` for directories;
`!` only un-hides what that same file hid — never the lists above). It only
ADDS, and the patterns are resolved to the paths that exist when the container
starts: a file created later is NOT hidden. More than 200 matches stops the run
(narrow the patterns); a pattern or symlink pointing outside the folder is
ignored with a warning. A `.tentacle/hide` that is unreadable, not a regular
file (a FIFO…), a link out of the folder or over 64 KiB stops the run. Mounting `/`, `/usr`, `/usr/local[/bin]`, `~/.ssh` or the config
dir (or a folder inside them) is refused. Your home, its parents, a system dir
or a folder on the hide list asks first, in two lines — `⚠ mount ~ (your home) into
the container? hidden: .ssh .aws .kube .config/gcloud .docker .config/tentacle`, then
`Continue? [y/N]` (names relative to the folder; the paths from `.tentacle/hide` are
counted, `+12 from .tentacle/hide`). Without a terminal it is refused, in one line,
unless `--confirm-mount`. A remote engine
(`tcp://`, `ssh://`) mounts nothing and says so. On rootful Docker on Linux the
agent runs as your uid:gid (files stay yours); Docker Desktop and rootless
Podman need nothing; SELinux hosts get `label=disable` for the container. The
image's code can write your folder (`.git/hooks`, `package.json` scripts…):
run only images you trust there, or use `--no-mount`. A kept container keeps its
mount; `attach <name>` works from any folder, as if launched from the one it mounts (the laptop's kept index records it; a run started with no mount: the folder it was launched from, also recorded; that folder may have been deleted or renamed, the attach still works).

**`attach`: in a pod or container that already exists.** Same as `run`, but
tentacle never creates, starts or deletes it: closing the TUI detaches and it
stays up.

**What of your config reaches a pod or container (`run`, `attach`).** Each new
session takes your resolved settings. `subagents.*`, `model.contextWindow` and
`model.autoTitle` are always yours. `maxIterations`, `tools.*`, `contextAwareness`,
`contextReset`, `loadAgentsMd` and `loadSkills` are yours unless the container's own
environment or config file sets them, and tentacle shows you the values that win. A
session already running keeps the settings it was created with, and shows you those
that differ from yours:

```
Session settings: { "maxIterations": 3, "tools.dedupOutput": false } (/settings sync to use this terminal's values, or /clear)
```

The values that win from the container's own config are shown the same way:

```
Container config: { "maxIterations": 7 }
```

`/settings` shows all the session's settings and how this terminal differs:

```
Session settings:
{
  "maxIterations": 7, // (container) this terminal: 3
  "tools": {
    "dedupOutput": false, // this terminal: true
    "execution": "parallel"
  }
}
1 differs from this terminal (/settings sync to use this terminal's values)
```

`/settings sync` applies this terminal's settings (as they were when it started) to
the running session, between turns. The conversation, background jobs, your approvals
and other attached terminals stay; those terminals are told what changed. Values the
container's own config sets still win.

```sh
tentacle attach <pod> [-n <namespace>] [-c <container>]
tentacle attach --engine docker|podman <container>
```

**Kept pods and containers: `ps` → `attach <name>` → `rm`.** Every kept `run`
is recorded on your machine (`<configDir>/kept/`, where it was created — no
credentials). `tentacle ps` lists them, checked against their engine (NAME
ENGINE WHERE MOUNT MODEL AGE STATUS; one removed outside tentacle is `gone` and
hidden unless `-a` — or while a detached run or terminal still acts on it — and
`tentacle rm <name>` drops its entry; an engine that does not answer within 3 s is a dim `not reachable (skipped)`
line, never an error); `--engine` filters, `-q` prints names, `-v` details. A
detached run shows its state: `detached · running 3m`, `detached · waiting:
permission (shell)`, ` · auto` with `--auto-accept`, `attached (2)` with two
terminals on it (`-v` lists their pids), `tui lost` when the last one died without
quitting, `running · relay lost` if its
process died; `-v` adds its pid, session and log.
`tentacle attach <name>` needs no `--engine`: the engine and location are looked
up (an explicit `--engine`/`-n`/`--context`/`-c` skips the lookup).
`tentacle rm <name>` removes it — only a workload that still carries tentacle's
managed and kept labels, re-checked right before the delete; a running one asks
`[y/N]` (`-f` skips; without a terminal, `-f` is required). A live detached run
is named in that question and stopped first (turn cancelled and saved). A name
that now belongs to something else is left alone and its stale entry dropped.
Several names are removed one by one, each as above; a failure does not stop the
others (exit 1 if any failed).

```sh
tentacle ps [--engine <e>] [-a] [-q|-v]
tentacle rm [--engine <e>] [-f] <name>...
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

`tentacle explain` reads this table's source: no argument lists the top-level
keys, `tentacle explain <section>` its sub-keys, `tentacle explain <key>` the
full card (meaning, type, allowed values, default, env, flag, whether a pod
gets it, scope, example), `--all` every leaf, `--json` for scripts. The table
below is generated from that registry (`bun run docs:config`), so a row and a
card cannot disagree; the long notes a row cannot hold are on the card.

<!-- config-keys:start -->
| Config key (`config.jsonc`) | Env override | Default | Meaning |
| --- | --- | --- | --- |
| `$schema` | — | — | A JSON-schema pointer for editor completion; accepted and ignored. |
| `autoWake` | `TENTACLE_AUTO_WAKE` | true | Start a continuation turn when a background job exits while idle. |
| `contextAwareness.enabled` | — | true | Whether the model is told how full its context is. |
| `contextAwareness.stepPercent` | — | 1 | A line per this many percent of the window (1–100). |
| `contextReset.enabled` | `TENTACLE_CONTEXT_RESET` | true | The model's `context_reset` tool renews its own context, asked like any other tool. |
| `contextReset.maxPerMessage` | `TENTACLE_CONTEXT_RESET_MAX` | -1 | Resets allowed per user message (-1 = unlimited). |
| `detach.keepAwake` | — | true | Hold a macOS sleep assertion while a turn of a detached run runs. |
| `engine` | `TENTACLE_ENGINE` | "kubernetes" | Default engine of `run`/`attach`: kubernetes, docker or podman; `--engine` wins, unknown refused. |
| `hooks` | — | — | Shell commands run on agent events, with a JSON input on stdin. |
| `loadAgentsMd` | `TENTACLE_NO_AGENTS_MD` (inverted) | true | Auto-load a per-repo `AGENTS.md` into the system prompt. |
| `loadSkills` | `TENTACLE_NO_SKILLS` (inverted) | true | Discover Agent Skills and offer the `skill` tool. |
| `maxIterations` | `TENTACLE_MAX_ITERATIONS` | 16 | Max model/tool iterations per turn. |
| `mcpServers.*.args` | — | — | Arguments passed to `command`. |
| `mcpServers.*.command` | — | — | The executable to spawn (a stdio server). |
| `mcpServers.*.cwd` | — | — | Working directory for the server process. |
| `mcpServers.*.env.*` | — | — | One variable of the server's environment. |
| `mcpServers.*.headers.*` | — | — | One header sent with the server's requests. |
| `mcpServers.*.readOnlyTools` | — | — | Which of its tools count as reads: `hint` (default: those it marks `readOnlyHint`), `none`, or a list. |
| `mcpServers.*.type` | — | — | How the server is reached: `stdio` (spawned) or `http` (Streamable HTTP). |
| `mcpServers.*.url` | — | — | The server's MCP endpoint (an http server). |
| `model.apiKey` | `TENTACLE_MODEL_API_KEY` | — | A literal API key — stored in plaintext (prefer `apiKeyCommand`). |
| `model.apiKeyCommand` | — | — | A shell command whose stdout is the key; never written to disk. |
| `model.autoTitle` | — | false | Ask a model to name each session after its first exchange. |
| `model.baseURL` | `TENTACLE_MODEL_BASE_URL` | `http://localhost:8080/v1` (openai) or `https://api.anthropic.com/v1` (anthropic) | The endpoint, including its API version. |
| `model.contextWindow` | `TENTACLE_CONTEXT_WINDOW` | 128000 | The context window in tokens: the fill meter and the model's context line. |
| `model.maxTokens` | `TENTACLE_MAX_TOKENS` | omitted for openai (the server decides); `64000` for anthropic | Max output tokens per response (`max_tokens` on the wire). |
| `model.model` | `TENTACLE_MODEL` | "default" | The model id sent to the endpoint (`--model <id>` beats it, for that command). |
| `model.provider` | `TENTACLE_PROVIDER` | "openai" | The API flavour: `openai` (chat/completions) or `anthropic` (Messages). |
| `model.titleModel` | — | — | The model id that writes those titles, e.g. a cheaper one. |
| `mount.hide` | — | — | The paths to hide — this list REPLACES the default one. |
| `mount.hideExtra` | — | — | Extra paths to hide, ADDED to the default list. |
| `packages.*` | — | — | Whether this installed package is enabled. |
| `rm` | — | false | Whether `run` removes its pod/container when the run ends. |
| `sessions.keepSuperseded` | — | — | Keep the history a compaction or a `context_reset` replaced in the session file. |
| `subagents.agentTaskDescription` | — | — | Replaces the `agent_task` description (max 4096 bytes; the sub-agent types are appended). |
| `subagents.agentTaskDescriptionFile` | — | — | The same description, read once at start from a file (config dir or absolute; not both). |
| `subagents.enabled` | `TENTACLE_SUBAGENTS` | true | Whether the `agent_task` sub-agent tool is offered. |
| `subagents.execution` | `TENTACLE_SUBAGENT_EXECUTION` | "parallel" | `agent_task` overlap: `parallel` (default; they share one workspace), `read-only`, `sequential`. |
| `subagents.maxIterations` | `TENTACLE_SUBAGENT_MAX_ITERATIONS` | 50 | Step limit for a sub-agent's own loop. |
| `subagents.maxParallel` | `TENTACLE_SUBAGENT_MAX_PARALLEL` | 4 | At most this many sub-agents at once; a llama.cpp server with fewer slots lowers it. |
| `systemPromptFile` | `TENTACLE_SYSTEM_PROMPT` (inline, not a path) | `PROMPT.md` in the config dir | The system prompt file: relative to the config dir, or absolute. |
| `tools.dedupOutput` | `TENTACLE_DEDUP_OUTPUT` | true | Collapse runs of identical consecutive output lines. |
| `tools.execution` | `TENTACLE_TOOL_EXECUTION` | "read-only" | Tool calls in a round: `read-only` (default; reads together, writes and `shell` alone), `sequential`, `parallel`. |
| `tools.maxInlineOutputChars` | `TENTACLE_MAX_OUTPUT_CHARS` | 16000 | Max characters of a tool result kept inline before it is spilled. |
| `tools.maxParallel` | `TENTACLE_TOOL_MAX_PARALLEL` | 8 | At most this many calls of a round at once (`1` = sequential). |
| `tools.outputRetentionDays` | `TENTACLE_TOOL_OUTPUT_RETENTION_DAYS` | 30 | Days a spilled tool output is kept (swept when the daemon starts). |
| `tools.redactSecrets` | `TENTACLE_REDACT_SECRETS` | false | Mask keys, tokens and credentials in tool output. |
| `tools.summarizeLargeOutput` | `TENTACLE_SUMMARIZE_OUTPUT` | false | Replace large output with a model-written summary (full text still spilled). |
| `tools.tabulateJson` | `TENTACLE_TABULATE_JSON` | false | Render a JSON array-of-objects result as a compact table. |
| `tools.writableDirs` | `TENTACLE_WRITABLE_DIRS` (`:`-separated; empty = `[]`) | the system temp dir (`$TMPDIR`) and `/tmp` | Where `fs_write`/`fs_edit`/`fs_multi_edit` may write besides the project. |
| `tui.theme` | — | "auto" | The palette: `auto` probes the terminal, `dark`/`light` force one; never carried to a pod. |
<!-- config-keys:end -->

**`--model <id>` and `--profile <name>`** are flags of the commands that start a
session, written **after** the command: `tentacle run --image x --model m`,
`tentacle attach box --model m`, `tentacle serve --model m`, and for the bare
local session right after `tentacle` (`tentacle --model m`, `tentacle -i
--profile p`, `tentacle --resume --model m`, `tentacle --plain …`, a one-shot
`tentacle --model m "prompt"`). `--model` is `TENTACLE_MODEL`'s twin: that model
id on the active profile's endpoint (the context window stays the profile's),
no config change; `--profile` beats `TENTACLE_PROFILE`. `attach` uses the run's
own model unless one is given. `serve --model` is the model its `connect`
clients use: `connect` itself, like `ps`, `rm`, `update`, `hooks` and
`package`, refuses both (`tentacle --model m run …`, before the command, is an
error naming the right form).

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
