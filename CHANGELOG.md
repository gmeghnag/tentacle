# Changelog

All notable user-visible changes to tentacle are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). Internal and test-only
changes are left out; the git history and the task docs under `docs/` have
those.

## [Unreleased]

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
