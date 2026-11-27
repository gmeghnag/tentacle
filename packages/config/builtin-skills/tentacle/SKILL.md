---
name: tentacle
description: Use when the user asks how to use tentacle - its commands (run, attach, serve, connect, pair, config), TUI slash commands, settings, resuming or detaching, remote access, or registering it in Claude Code over MCP.
---
# tentacle

tentacle is the agent harness you are running in. Answer from this file and from
the commands below; do not guess flags.

## Rules

- For settings use `tentacle config get <key>` and `tentacle explain <key>`.
  Never read or print `config.jsonc` (in the config dir): it holds credentials.
- Never read or print a credential key. Give tokens to tentacle through a
  command (`--token-command`, `tokenCommand`, `apiKeyCommand`), never as a
  literal in a file.
- A command that changes settings, removes a workload or revokes a device needs
  the user's OK first.
- `tentacle --help` lists every flag.

## Commands

<!-- generated:cli-commands -->
- `tentacle connect ws(s)://host:port [--token T|--token-command CMD] [--ca-cert PEM|--insecure-skip-tls-verify] [--resume [id]|--continue] | connect <name> [--resume [id]|--continue] | connect --pair <line|-> | connect --forget <name>`
- `tentacle serve [--host H] [--port P] [--token T|--token-command CMD] [--model <id>] [--profile <name>] [...] (see tentacle --help)`
- `tentacle run --image <ref> [--engine kubernetes|docker|podman] [--network <name|none>] [-n|--namespace <ns>] [--context <ctx>] [--insecure-docker-tcp] [--no-mount] [--confirm-mount] [--rm[=true|false]] [--bin-dir <dir>] [--resume [uid]|--continue] [--model <id>] [--profile <name>] [--name <n>] [-d|--detach] [--auto-accept[=true|false]] [--prompt <text|->] ["<prompt>"]`
- `tentacle attach <name> [--engine kubernetes|docker|podman] [-n|--namespace <ns>] [-c|--container <c>] [--context <ctx>] [--insecure-docker-tcp] [--bin-dir <dir>] [--resume [uid]|--continue] [--model <id>] [--profile <name>]`
- `tentacle ps [--engine kubernetes|docker|podman] [-a|--all] [-q|--quiet] [-v|--verbose]`
- `tentacle rm [--engine kubernetes|docker|podman] [-f|--force] <name>...`
- `tentacle --plain [--model <id>] [--profile <name>]`
- `tentacle hooks trust --list | --revoke <folder>`
- `tentacle package install <path|git-url>[#ref] | list | remove <name> | update [<name>]`
- `tentacle explain [key] [--all] [--json]`
- `tentacle config set <key> <value> | <key>=<value> | unset <key> | get <key> | list [--set] | path [--profile <name>] [--json] [--yes]`
- `tentacle update [--check] [--version vX.Y.Z]`
- `tentacle pair [--project <dir>] [--address ws(s)://host:port/e2e]... [--name <name>]`
- `tentacle devices | revoke <name|id-prefix> [--project <dir> | --all-projects] | reset [--yes]`
- `tentacle voice setup [--yes] | status`
- `tentacle browser install | status | uninstall`
- `tentacle logs [<uid>|<run-name>] [--tail N] [--only ask,error,tool] [--json] [--summary] [--usage] [-f|--follow] [--connect ws(s)://host:port [--token T] [--ca-cert FILE|--insecure-skip-tls-verify]]`
- `tentacle [-i] [--resume [uid]|--continue] [--model <id>] [--profile <name>]`
<!-- /generated:cli-commands -->

A first word that names a subcommand is that subcommand: send a one-shot prompt
that starts with one as `tentacle -- <prompt>`.

## TUI slash commands

<!-- generated:slash-commands -->
- `/help`: show this help
- `/clear`: clear the transcript and start a fresh session
- `/compact`: summarise the conversation to free up context
- `/rename`: rename this session (the title every device shows)
- `/sessions`: list this daemon's sessions and switch
- `/close`: end this session and quit
- `/model`: show the active model
- `/move`: move this session to a container, or back to local
- `/retry`: re-send the last prompt
- `/attach`: attach an image (or drag its file into the terminal)
- `/copy`: copy the last assistant reply to the clipboard
- `/save`: save the transcript to a Markdown file
- `/tokens`: show token usage for the session
- `/mcp`: MCP servers: reachability, tools — and on/off for this session
- `/skills`: every skill found: who can use it, problems — and on/off for this session
- `/tools`: built-in tools: what each costs the context — and on/off for this session
- `/browser`: your Chrome: tabs and switches (on|off|auto|ask|clear|masked)
- `/artifacts`: list the artifacts the model presented here
- `/schedule`: the wakes this session will be woken by — and delete one
- `/apps`: the web pages this session publishes — and stop one
- `/workflow`: the workflow run in this session — run, stop, resume, re-run a step
- `/agents`: background sub-agents and jobs: select, open, stop (ctrl+t)
- `/settings`: the session's settings vs this terminal's (/settings sync to use yours)
- `/exit`: quit (also /quit)
- `/quit`: same as `/exit`
- `/schedules`: same as `/schedule`
- `/workflows`: same as `/workflow`
<!-- /generated:slash-commands -->

A skill of the user can also be run as `/<skill-name>`.

## Settings

`tentacle explain` explains a key; `tentacle config list --set` lists what is
set; `tentacle config set <key> <value>` writes one; `tentacle config path`
shows the file. `--profile <name>` selects a named profile. The top-level keys:

<!-- generated:config-sections -->
- `model`: The model endpoint: provider, URL, model id, key and token budget.
- `models`: Named models for sub-agents: each has the keys of `model`; unset keys come from `model`.
- `hooks`: Shell commands run on agent events, with a JSON input on stdin.
- `systemPromptFile`: The system prompt file: relative to the config dir, or absolute.
- `systemPromptEnvironment`: State the working directory and platform at the end of the system prompt.
- `loadAgentsMd`: Auto-load a per-repo `AGENTS.md` into the system prompt.
- `loadSkills`: Discover Agent Skills and offer the `skill` tool.
- `skills`: Agent Skills settings.
- `maxIterations`: Max model/tool iterations per turn.
- `subagents`: The `agent_task` sub-agent tool: whether, how many, how far.
- `harnesses`: Other agent harnesses that can run a sub-agent, keyed by instance name.
- `contextAwareness`: Tell the model how full its context is, once per step of the window.
- `contextReset`: The model may renew its own context with the `context_reset` tool.
- `contextPrune`: Smart compaction: prune what later rounds superseded from the model's copy, before any summarising compaction.
- `sessionHop`: The agent may PROPOSE moving this session to another target.
- `workloadShell`: The agent may open a stateful `sh` on another workload (`workload_shell`).
- `previews`: Container previews: the agent shows a container's web port to your paired devices.
- `apps`: Session apps: the agent publishes a presented page as a public web page.
- `schedules`: This host's limits on the agent's scheduled wakes (`schedule_create`).
- `autoWake`: Start a continuation turn when a background job exits while idle.
- `engine`: Default engine of `run`/`attach`: kubernetes, docker or podman; `--engine` wins, unknown refused.
- `network`: Network of `run`'s container: a name, or `none` for air-gapped runs; `--network` wins.
- `rm`: Whether `run` removes its pod/container when the run ends.
- `detach`: `run --detach`: what the relay holding the run may do.
- `tui`: The TUI's own display settings.
- `beta`: Opt-in display features still being tried; off unless set.
- `sessions`: The laptop's session logs: what they keep of a history that was replaced.
- `voice`: Voice dictation in the local TUI on the Mac: speak instead of typing.
- `relay`: The mobile relay a `serve` with paired devices dials out to.
- `push`: Push notifications for the paired phones, through the mobile relay.
- `liveActivity`: Whether this `serve` shows a live activity for a running turn on a paired phone.
- `mount`: What a docker/podman run hides from the container's workspace mount.
- `mcpServers`: MCP servers to connect to, keyed by name; their tools join the agent.
- `packages`: Installed packages to switch off: `{ "<name>": false }`.
- `tools`: Tool-output handling: spilling, retention, redaction, overlap.
- `profiles`: Named profiles: the same settings, merged over the file when selected.
- `$schema`: A JSON-schema pointer for editor completion; accepted and ignored.
<!-- /generated:config-sections -->

Use `tentacle explain <key>` for the rest.

## How to

### Work in a pod or container, leave, come back

```sh
tentacle run --image <ref>                      # Kubernetes (default)
tentacle run --engine docker --image <ref>      # Docker (also: podman)
tentacle ps                                     # kept runs and their state
tentacle attach <name>                          # come back
tentacle rm <name>                              # remove it
```

`run` keeps the pod or container on exit and prints the `attach` line; `--rm`
removes it instead. With Docker or Podman the current folder is mounted into the
container (`--no-mount` opts out). `attach` also joins a workload tentacle did
not create: name its engine with `--engine` (default: Kubernetes).

### Resume a session

`tentacle --resume` picks a saved session of this folder, `--continue` takes the
newest, and `tentacle --resume <uid>` names one. `tentacle logs` prints a saved
session without the TUI.

### Run with no TUI (detach)

```sh
tentacle run -d "<prompt>" --image <ref> --name <name>
tentacle logs -f <name>                         # follow it
tentacle attach <name>                          # take it over, even mid-turn
```

A tool that needs permission waits for the user unless `--auto-accept` is set.

### Drive an agent on another machine

```sh
tentacle serve --host 127.0.0.1 --port 4000     # on the host
tentacle connect ws://<host>:4000               # from the other machine
```

A non-loopback `--host` needs a token (`--token-command <cmd>`). Quitting
`connect` detaches: the session keeps running on the host.

### Reach a serve with no open port (the mobile relay)

On the host run `tentacle pair`. On the other machine run
`tentacle connect --pair '<tentacle://pair?...>'` once, answer `y` on the host
after comparing the code, then `tentacle connect <name>`. A phone pairs with the
same `tentacle pair` line. `tentacle devices` lists paired devices and
`tentacle devices revoke <name>` removes one.

### Let Claude Code (or another MCP client) call tentacle

Start the daemon with its own MCP token, then register it:

```sh
tentacle serve --mcp-token-command <cmd>
claude mcp add --transport http tentacle http://127.0.0.1:4000/mcp --header "Authorization: Bearer <token>"
```

`serve` prints the registration line. The owner is asked first;
`--mcp-asks both` also lets the caller answer tool asks. For A2A use the
`tentacle-a2a` skill; for workflows use `tentacle-workflows` (if they are off,
the user turns one on with `/skills`, or for good with
`tentacle config set skills.builtin.<name> true`).

### Update

`tentacle update --check` says whether a newer version exists;
`tentacle update` installs it.
