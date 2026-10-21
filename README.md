<p align="left">
  <img src="art/tentacle-lockup.svg" alt="tentacle" height="220">
</p>

A coding agent for the terminal: plug in any LLM, run it locally, in a
Kubernetes pod, or on a remote host, and drive it from a rich TUI.

- **Models:** any OpenAI-compatible endpoint (local or cloud), or the Anthropic Messages API
- **Runs:** locally · in a Kubernetes pod (`run` / `attach`) · as a remote daemon (`serve` / `connect`)
- **Safe by default:** writes confined to the workspace; shell commands go through a permission prompt

## Install

Prebuilt binaries for macOS and Linux (x64 and arm64) are on the
[Releases](https://github.com/gmeghnag/tentacle/releases) page. While the repo
is private, download them with the GitHub CLI (after `gh auth login`):

```sh
gh release download v0.1.0-beta.1 -R gmeghnag/tentacle -D tentacle-dl
cd tentacle-dl
shasum -a 256 -c SHA256SUMS        # on Linux: sha256sum -c SHA256SUMS
```

**1. The CLI.** Take the file for your machine (`tentacle-bun-darwin-arm64`,
`tentacle-bun-darwin-x64`, `tentacle-bun-linux-x64` or `tentacle-bun-linux-arm64`)
and put it on your `PATH` as `tentacle`:

```sh
mkdir -p ~/.local/bin
install -m 755 tentacle-bun-darwin-arm64 ~/.local/bin/tentacle   # e.g. Apple Silicon
tentacle --version
```

**2. The pod binaries** (only for `tentacle run` / `tentacle attach`). tentacle
copies a Linux binary into the pod and looks for it in `~/.config/tentacle/bin/`,
under its release file name. Keep both, so pods of either architecture work:

```sh
mkdir -p ~/.config/tentacle/bin
install -m 755 tentacle-bun-linux-x64 tentacle-bun-linux-arm64 ~/.config/tentacle/bin/
```

Notes:

- If you set `TENTACLE_CONFIG_DIR` (or `XDG_CONFIG_HOME`), the pod binaries go
  in that directory's `bin/` instead.
- The pod image must be a Linux **glibc** image with `sh` and `head` (Debian,
  UBI, RHEL…). Alpine/busybox (musl) cannot run tentacle.
- Downloaded with a browser on macOS? Clear the quarantine flag, or the binary
  is blocked: `xattr -d com.apple.quarantine tentacle-bun-darwin-*`.
- **Updating:** download the new release and replace all three binaries
  together. `attach` reuses the tentacle already in a pod, so after an update,
  use a fresh pod.

## Getting started

The first run creates `~/.config/tentacle/` with a commented `config.jsonc` and
a `PROMPT.md`. Point it at your model:

```jsonc
// ~/.config/tentacle/config.jsonc
{
  "model": {
    "baseURL": "http://localhost:8080/v1",
    "model": "my-model",
    // Prefer apiKeyCommand so the secret is never written to disk:
    "apiKeyCommand": "cat ~/.cache/my-api-key"
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

**`run`: in a new Kubernetes pod.** tentacle creates the pod, copies itself in
(the pod binaries from [Install](#install)), and deletes the pod on exit. The
model key and the approvals stay on your machine; sessions are saved locally, so
`--resume` works.

```sh
tentacle run --image <ref> [-n <namespace>] [<pod-name>]
```

**`attach`: in a pod that already exists.** Same as `run`, but tentacle never
creates or deletes the pod: closing the TUI detaches and the pod stays up.

```sh
tentacle attach <pod> [-n <namespace>] [-c <container>]
```

Both use your kubeconfig (current context, or `$KUBECONFIG`); no `kubectl`
needed. Read-only root filesystem? Add `--bin-dir /tmp`. Details:
[`docs/architecture/F4-pod-execution.md`](./docs/architecture/F4-pod-execution.md).

**`serve` + `connect`: on a remote host.** Run the agent as a daemon on one
machine and drive it from another machine's TUI:

```sh
tentacle serve --host 127.0.0.1 --port 4000 [--token T | --token-command CMD]
tentacle connect ws://host:4000 [--token T]
```

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
| `loadSkills` | `TENTACLE_NO_SKILLS` (truthy disables) | Agent Skills discovery (default on) |

Key precedence: `TENTACLE_MODEL_API_KEY` › file `apiKey` › file `apiKeyCommand`.
`TENTACLE_CONFIG_DIR` (or `XDG_CONFIG_HOME`) moves the config directory.

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

Building the binaries yourself: [`docs/BUILD.md`](./docs/BUILD.md). Design and
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
