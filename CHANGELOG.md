# Changelog

All notable user-visible changes to tentacle are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). Internal and test-only
changes are left out; the git history and the task docs under `docs/` have
those.

## [Unreleased]

### Changed

- **Esc / Ctrl+C in the `--resume` session picker now exits silently**, with no
  `[resume] cancelled` line (local and `connect --resume`). The exit code is
  unchanged.
- **Notices are soft blue, their hint grey.** Every notice line in the TUI
  (`Session settings: …`, `Container config: …`, `auto-accept on`, …) now has
  one colour instead of dim grey, and its hint (`(/clear to reset)`,
  `(Shift+Tab to turn it off)`) stays grey beside it. Separator rules are
  unchanged; `relay.log` still prints each notice as one plain line.
- **"Yes, always" now covers the whole session,** the main agent and all its
  sub-agents; before, it held only for the agent that asked. A request it does not
  cover is still asked, one at a time.
- **A sub-agent's rounds now follow `tools.execution` and `tools.maxParallel`,** so its
  reads overlap as the main agent's do.
- **A rate-limited request waits a little longer than `retry-after`,** with some random
  extra, so sub-agents limited together do not all retry on the same tick.

- **Your config now reaches a pod or container.** `run` and `attach` carry your
  `maxIterations`, `tools.*`, `contextAwareness`, `contextReset`, `loadAgentsMd`
  and `loadSkills` (your environment, active profile and global file, resolved on
  your laptop) as the lowest layer. The container's own environment and config
  file still win, and you are shown the values that win. Pods no longer run on
  plain defaults, so a limit such as `maxIterations` now follows you.
- **Sub-agent settings, `model.contextWindow` and `model.autoTitle` are always
  your laptop's** in a pod or container; its own config cannot change them.
- **`attach --profile <name>` now applies to the new sessions it opens.** A
  session already running keeps the settings it was created with, and shows those
  that differ from yours as soon as you attach, as one line:
  `Session settings: { "maxIterations": 3 } (/clear to reset)`. The container's
  winning values read `Container config: { "maxIterations": 7 }`, and only those
  that differ from yours.
- The protocol is now version 16. A daemon left running by an older tentacle is
  refused at connect; attach again to replace it, or `tentacle rm <name>` if a
  detached run still uses it.

### Removed

- `tentacle serve --context-window` and `--auto-title`: the laptop now sends those
  values per session.

### Fixed

- A model HTTP error on a pod run (`run`, `attach`, `run --detach`) now names its
  cause (`the model endpoint answered 401 (unauthorized)`) in the TUI, `relay.log`
  and `tentacle ps`, instead of `internal error`. Only the status reaches the pod,
  never the provider's message; the full error stays in the run's `daemon.log`.
- A `model.apiKeyCommand` in a container's own config no longer runs there, and
  can no longer stop the daemon from starting. The container never uses that key.
- `tentacle attach` no longer reuses an older tentacle binary in a pod or
  container just because it reports the same version: it compares build ids and
  re-copies this laptop's binary on a mismatch (instead of failing with
  `connection closed`). A binary with a live detached run is never replaced:
  attach says `<name> runs an older tentacle build than this one · tentacle rm
  <name>, then run again`.
### Added

- **Sub-agents run in parallel.** Several `agent_task` calls in one message now run at
  the same time, in a shared workspace. `subagents.execution` chooses: `parallel` (the
  default), `read-only` (only sub-agents that cannot write) or `sequential`.
  `subagents.maxParallel` (default 4; env `TENTACLE_SUBAGENT_EXECUTION`,
  `TENTACLE_SUBAGENT_MAX_PARALLEL`) is the ceiling, and a llama.cpp server with fewer
  slots lowers it on its own. In a pod or container these are your laptop's values.
- **`subagents.agentTaskDescription` or `agentTaskDescriptionFile`** (at most 4096 bytes;
  setting both is a config error) replaces the `agent_task` description; the list of
  sub-agent types is still appended.
- **The permission dialog names the sub-agent that asks**, for example
  `explore · "find callers"`.
- **The status bar names where the agent runs.** In a container or pod the
  left of the bar shows a badge: `docker:<name>`, `podman:<name>`,
  `kubernetes:<pod>/<container>` (the container is always shown); the prefix
  is grey and the name keeps the accent colour. A local session shows nothing.
  The bar stays one row: on a narrow terminal the path shrinks first, then
  `kubernetes:` becomes `k8s:`, then the badge name is cut in the middle. The
  scroll hint and `expanded` never cut the name (they are left out instead),
  and the `ctx` meter always keeps its max.
- **Context at open.** `ctx` is shown with its max from the start, before any
  turn: the exact count where the provider can count without generating
  (Anthropic `count_tokens`; llama.cpp `/apply-template` + `/tokenize`), else
  an estimate marked `~` (`ctx █░░░░░░░░░ ~7% (~9k/128k)`). It covers the real
  history on `attach` and `--resume`, refreshes after `/compact`, and the first
  turn replaces it with the measured figure. `↑ ↓` token totals are hidden until
  measured. The count is capped at 2 s and falls back to the estimate silently;
  in a pod run it is made by your laptop, so the model key never leaves it.

### Changed

- The model name moved from the status bar to the top border of the input
  field, right-aligned (cut on the left with `…` when too long).
- `⏵⏵ auto-accept on` in the status bar is now golden yellow (`#fec20a`)
  instead of cyan; `off` stays grey.
- A line break in the link-status text no longer gives the status bar a second
  row, and a cut no longer shows a doubled `…`.

- A model endpoint answering HTTP 500, 502 or 503 before any output is now
  retried like a rate limit (up to 3 attempts, honouring `retry-after`). A 504
  and other errors still surface at once.

## [0.2.0] - 2026-10-27

This release adds Docker and Podman as places to run, and moves the protocol
from 10 to 13. **Upgrade the CLI and every daemon or pod together:** a CLI and
an older pod or daemon refuse each other at connect with a version error.
`tentacle update` fetches the matching pod binaries.

### Added

- **Docker and Podman engines.** `tentacle run` and `attach` take
  `--engine kubernetes|docker|podman`; `engine:` in the config sets the
  default (Kubernetes if unset). Podman's socket is found automatically.
- **Remote Docker over `ssh://`.** `DOCKER_HOST=ssh://user@host` works with no
  local `docker` binary.
- **Workspace mount.** With a local Docker or Podman engine, `run` mounts your
  current folder read-write at the same path; `--no-mount` opts out. A remote
  engine never gets the mount.
- **Hidden secrets in the mount.** `~/.ssh`, tentacle's config and common
  credential files are masked inside the container. Add your own paths in
  `.tentacle/hide`, or set `mount.hide` / `mount.hideExtra` in the config.
- **Risky mounts ask first.** Mounting your home folder or a hidden path asks
  for confirmation (`--confirm-mount` without a terminal); `/`, `/usr`,
  `/usr/local`, `~/.ssh` and tentacle's config are refused. On a
  case-insensitive disk (macOS) a hidden *file* inside the mount refuses the
  run: hide its folder instead.
- **`tentacle ps` and `tentacle rm <name>`.** List the pods and containers you
  kept, and remove one. `attach <name>` finds the engine and location itself.
- **`--keep`.** Choose whether `run` keeps its pod or container (`keep:` in the
  config); a kept one prints its re-attach command.
- **Context.** The model sees how full its context is, and can renew it with
  the `context_reset` tool (asks for approval like other tools). A reset
  re-reads `AGENTS.md` and the skills from disk.
- **Skills hot-reload.** A skill you add or edit is picked up without a
  restart.
- **Send now.** `Ctrl+X Ctrl+S` cancels the running turn (or a `/compact`) and
  sends your queued messages at once.
- **Sessions on `connect`.** A `/sessions` panel to list, switch, resume and
  delete a daemon's sessions; `--resume` works on `connect`.
- **Archived sessions.** A session that ends is archived, not lost; reopen it
  explicitly, or delete it for good.
- **Session titles.** Automatic titles (model-written ones are opt-in) and
  `/rename`.
- **Daemon sessions.** `serve --session-ttl never`, and the TTL of a running
  daemon can be changed.
- **Several clients on one session.** Queued messages show on every attached
  client, and each client renders turns started by another.
- **Syntax colours** in file reads, chosen by file extension.
- **Version mismatch notice** says which side is older and what to do.
- **Sub-agents.** Their progress is shown over the wire, and a permission
  prompt says which call it is for.

### Changed

- **`--keep` defaults to true.** `run` keeps its pod or container; use
  `--keep=false` (or `keep: false`) for the old create-and-delete behaviour.
- **Breaking: protocol 13.** Clients and daemons from 0.1.0 (protocol 10) must
  be upgraded together with the CLI.
- **License:** Apache-2.0 (was MIT).
- Sent messages sit on a full-width background; queued ones look sent, in
  grey, above the thinking line.
- A large tool result shows a short note instead of the model's banner.

### Fixed

- **`tentacle ps`:** no footer, a 3-space column gap, and `--keep true|false`
  is accepted with a space.
- A model rate limit (HTTP 429 or 529) is retried, honouring `retry-after`.
- Two edits to one file at the same time no longer lose an update.
- Images on musl, loader-less or unsupported-architecture bases are detected
  before the transfer, with a clear error.
- Tool rows show the real duration, never a fake `0.0s`.
- Ctrl+O expand is instant on long sessions; a tab no longer breaks diff bars;
  the input cursor follows soft-wrapped text.
- A single version marker in the compiled binary.
- A warning when a sub-agent's `model` or `contextWindow` is ignored.

### Security

- The pod stays untrusted: the laptop decides what is mounted, and model keys
  and credentials never enter the container.

## [0.1.0] - 2026-10-22

The first public release, 0.1.0. Everything below is new compared with no
release. Items marked *(since 0.1.0-beta.1)* changed after the beta.

### Added

- **Agent and TUI.** A coding agent for the terminal with a rich TUI: line
  editing (word jumps, selection, prompt history), mouse scroll, queued
  follow-up messages while a turn runs, `/compact`, `/retry`, and
  `--resume` (session picker) / `--continue` (newest session of this folder).
  Built-in tools are shown with CamelCase labels (`Bash`, `Edit`, …)
  *(since 0.1.0-beta.1)*.
- **Models.** Any OpenAI-compatible endpoint, or the native Anthropic Messages
  API. A model connection that drops before any output is retried
  automatically *(since 0.1.0-beta.1)*.
- **Where it runs.** Locally (the agent runs on a worker thread, off the
  render thread), in a Kubernetes pod (`tentacle run` creates and deletes a
  pod; `tentacle attach` uses an existing one), or as a remote daemon
  (`tentacle serve` / `tentacle connect`, with `--ca-cert` and
  `--insecure-skip-tls-verify` for a self-signed daemon). In a pod the model
  is reached through the laptop: API keys never leave your machine.
- **Sessions.** Sessions belong to the daemon: a client can detach and
  re-attach, `connect` / `attach` / `run` reconnect and resume after a dropped
  link, and a `serve` daemon persists sessions and reloads them after a
  restart. A permission prompt is a session event that any attached client
  can answer; a turn waiting on it stays suspended until you answer.
- **Configuration.** Named config profiles (`--profile <name>`), per-project
  sessions, and the repository's `AGENTS.md` loaded into the system prompt.
- **Agent Skills.** `SKILL.md` discovery, a `skill` tool the model can call,
  `/skill-name` to activate one yourself, active skills kept across
  `/compact`, and a `/skills` panel *(since 0.1.0-beta.1)*.
- **MCP.** stdio and Streamable HTTP servers, a client that speaks both the
  2026-07-28 and the earlier MCP protocol versions, and an `/mcp` panel with
  each server's reachability and tools *(since 0.1.0-beta.1)*.
- **Hooks** *(since 0.1.0-beta.1)*. Out-of-process commands on `tool_call`
  (allow, deny, ask, or rewrite the input), `tool_result`, `turn_start`
  (add context or stop the turn), `turn_end` (continue the turn, at most 3
  times) and `model_request` (a notification). Project hooks in
  `.agents/hooks.json` run only after you trust them, and are asked again
  when they change; `tentacle hooks trust --list | --revoke <folder>`.
  Hooks get `TENTACLE_PROJECT_DIR`, and package hooks also get
  `TENTACLE_PACKAGE_DIR`.
- **Packages** *(since 0.1.0-beta.1)*. Bundles of skills, agent types, MCP
  servers and hooks: `tentacle package install <path | git-url>[#ref]` (or
  `tentacle install …`), `list`, `update`, `remove`. Install and update print
  every hook and MCP command they will run.
- **One-line install:** `curl -fsSL tentacle.so/install | sh` (`scripts/install.sh`):
  verified download, no sudo, then `tentacle update` for the pod binaries.
- **Developer guide** for hooks and packages: `docs/extensions.md`
  *(since 0.1.0-beta.1)*.

### Changed

- **Protocol 10** *(since 0.1.0-beta.1)*. The wire between client and daemon
  is now forward-compatible: unknown fields are ignored, an update kind a
  client does not know is shown once as "update tentacle" instead of breaking
  the session, and a permission request is never sent to a client that
  cannot answer it. Clients and daemons from 0.1.0-beta.1 (protocol 7) are
  refused at connect with a clear version error: update both sides.
- The launch folder is the working folder; `TENTACLE_CWD` and the config
  `cwd` key were removed (a config that still has `cwd` is an error).

### Security

- Writes are confined to the workspace; shell commands go through a
  permission prompt.
- Secret-looking environment variables are removed from the environment of
  shell commands, hooks and MCP servers.
- Optional secret redaction of tool output (keys, tokens, private keys, URL
  credentials) before it reaches the model or disk: `"tools": { "redactSecrets": true }`.
  Off by default.
- Every background process runs in its own process group and is killed when
  tentacle exits.
- A package symlink that points outside the package is refused at install and
  at load *(since 0.1.0-beta.1)*.

## [0.1.0-beta.1] - 2026-10-21

The first pre-release, for testing.
