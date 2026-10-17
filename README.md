# tentacle

A SOTA agent harness — the platform that turns any LLM into an autonomous,
remotely-controllable coding agent with a rich terminal UI.

- **Runtime:** Bun · **Language:** TypeScript (strict) · **Repo:** Bun-workspaces monorepo
- **Models:** any OpenAI-compatible endpoint (local or cloud), or the native Anthropic Messages API
- **Interfaces:** rich Ink TUI · plain REPL · one-shot · remote control (WebSocket + JSON-RPC 2.0)
- **Safe by default:** tool writes confined to the workspace; shell commands gated by a permission engine

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design and decision records.

## Quickstart

```sh
bun install
bun run packages/cli/src/main.ts      # start the interactive TUI
```

On first run the harness scaffolds `~/.config/tentacle/` with a
self-documenting `config.jsonc` and a `PROMPT.md`. Point it at your model by
editing the config (see below) — then no environment variables are needed:

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

Other ways to run:

```sh
bun run packages/cli/src/main.ts "summarise src/ and suggest a refactor"   # one-shot
bun run packages/cli/src/main.ts --plain                                   # line REPL (pipes / no TTY)
bun run packages/cli/src/main.ts --help
```

## Configuration

Resolved with precedence **environment variables › `config.jsonc` › built-in defaults**.

| Config key (`config.jsonc`) | Env override | Meaning |
| --- | --- | --- |
| `model.provider` | `TENTACLE_PROVIDER` | Provider kind: `openai` (default) or `anthropic` |
| `model.baseURL` | `TENTACLE_MODEL_BASE_URL` | Base URL incl. version. Default: `http://localhost:8080/v1` (openai) or `https://api.anthropic.com/v1` (anthropic) |
| `model.model` | `TENTACLE_MODEL` | Model id sent to the endpoint |
| `model.apiKey` | `TENTACLE_MODEL_API_KEY` | API key, **stored in plaintext** (discouraged) |
| `model.apiKeyCommand` | — | Shell command whose stdout is the key; resolved at startup, never written to disk |
| `model.contextWindow` | — | Token budget for the TUI context-fill meter |
| `model.maxTokens` | `TENTACLE_MAX_TOKENS` | Max output tokens per response. Unset: omitted for openai, `64000` for anthropic |
| `systemPromptFile` | `TENTACLE_SYSTEM_PROMPT` (inline) | System prompt file (default `PROMPT.md`) |
| `cwd` | `TENTACLE_CWD` | Workspace directory for tools (default: launch dir); writes are confined here |
| `maxIterations` | `TENTACLE_MAX_ITERATIONS` | Max model/tool rounds per turn |
| `subagents.enabled` | `TENTACLE_SUBAGENTS` | Enable the `agent_task` sub-agent tool (default on) |

Key precedence: `TENTACLE_MODEL_API_KEY` › file `apiKey` › file `apiKeyCommand`.
`TENTACLE_CONFIG_DIR` (or `XDG_CONFIG_HOME`) relocates the config directory.

## Standalone binary

```sh
bun run compile                          # → dist/tentacle (self-contained)
TARGET=bun-linux-x64 bun run compile     # cross-compile (see `bun build --help`)
./dist/tentacle                     # runs the TUI; reads the same config.jsonc
```

Details and the Ink/yoga bundling notes are in [`docs/BUILD.md`](./docs/BUILD.md).

## Remote control

Run the agent as a headless daemon and drive it from another machine's TUI:

```sh
tentacle serve --host 127.0.0.1 --port 4000 [--token T | --token-command CMD]
tentacle connect ws://host:4000 [--token T]
```

A non-loopback `--host` requires a token (remote code-execution risk); TLS via
`--tls-cert`/`--tls-key`. Confinement and permissions are enforced server-side.
See [`docs/architecture/F3-remote-control.md`](./docs/architecture/F3-remote-control.md).

## Features

- **Agent loop** over any OpenAI-compatible model or the native Anthropic Messages API; multi-turn `Session`; streaming events.
- **Built-in tools:** `fs_read`, `fs_write`, `fs_edit` (with unified diffs), `shell`.
- **Background jobs:** `shell` with `run_in_background` plus `shell_output` / `shell_kill`; a finished job is surfaced live and fed back to the model (exit trigger).
- **Workspace confinement:** writes confined to `cwd` via realpath (symlink escapes refused); reads unconfined.
- **Permission engine:** shell commands gated with command-prefix-scoped "always" approvals; never auto-approves command substitution.
- **Sub-agents:** the `agent_task` tool delegates to isolated child agents; built-in + user-defined types (`<configDir>/agents/*.md`); toggleable.
- **Rich TUI:** Claude-Code-style rendering (full-width diff bars, word-level highlighting, `⏺`/`⎿` glyphs), mouse-wheel scroll + text selection, slash-command palette, `/compact` context compaction, `/help` for the rest.
- **Remote control:** WebSocket + JSON-RPC 2.0 daemon/client, bearer-token auth, loopback-safe bind.

## Packages

| Package | Purpose |
| --- | --- |
| `@tentacle/protocol` | Wire protocol: JSON-RPC 2.0 envelopes + ACP-shaped session/tool/permission schemas (Zod). |
| `@tentacle/core` | Core contracts: `ModelProvider`, `Tool`, `ExecutionEnvironment`, `JobController`, `PermissionBroker`, `TokenCounter`. |
| `@tentacle/config` | Layered config loader (`config.jsonc` + env + defaults); scaffolding; lazy `apiKeyCommand`. |
| `@tentacle/providers` | Model providers behind one contract: OpenAI-compatible (`/v1/chat/completions`) + native Anthropic (`/v1/messages`), fetch + SSE streaming, tool-call normalisation, and the `createModelProvider` selector. |
| `@tentacle/exec` | Host execution environment (`Bun.spawn`), workspace write-confinement, background jobs. |
| `@tentacle/tools` | Tool registry + built-in tools (fs + shell + background + `agent_task`). |
| `@tentacle/agent` | The agent loop, `Session`, sub-agents, context compaction, permission gate. |
| `@tentacle/transport` | Symmetric JSON-RPC `RpcPeer` over a duplex channel (in-memory testable). |
| `@tentacle/daemon` | Remote-control server: hosts sessions, maps events to the wire, WS adapter + auth. |
| `@tentacle/client` | Remote-control client: `RemoteSession` the TUI drives like a local one. |
| `@tentacle/cli` | Entry point: TUI / plain REPL / one-shot / `serve` / `connect`; config wiring. |
| `@tentacle/tui` | Ink/React terminal UI: virtualized scroll buffer, diffs, status/context meter, palette. |

## Development

```sh
bun run typecheck    # tsc --noEmit over the whole monorepo
bun run lint         # Biome lint + format check
bun test             # run the test suite
bun run check        # typecheck + lint + test (the CI gate — must pass)
```

## Status

In active development, built in vertical slices (F0–F6). Foundations, host tools,
multi-turn sessions, the TUI, workspace confinement, the permission engine,
remote control, sub-agents, background jobs, and context compaction are in and
tested. Next up: MCP support, then skills. Container-based execution (F2) is
planned behind the existing `ExecutionEnvironment` contract.
