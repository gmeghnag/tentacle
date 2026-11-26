<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="art/banner-dark.svg">
    <img src="art/banner-light.svg" alt="tentacle: Polpetto, the tentacle mascot, next to the wordmark" width="100%">
  </picture>
</p>

<p align="center">
  A coding agent that runs next to your code and keeps your identity on your machine.
</p>

<p align="center">
  <a href="https://github.com/gmeghnag/tentacle/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/gmeghnag/tentacle?color=06b6d4"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="platforms" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%7C%20x64%20%C2%B7%20arm64-555">
  <img alt="engines" src="https://img.shields.io/badge/engines-Kubernetes%20%C2%B7%20Docker%20%C2%B7%20Podman-555">
<!-- quality-badges:start -->
  <img alt="coverage 86%" src="https://img.shields.io/badge/coverage-86%25-green">
  <img alt="tests: 20,911 passing" src="https://img.shields.io/badge/tests-20%2C911%20passing-brightgreen">
<!-- quality-badges:end -->
</p>

## Why tentacle

- **Private by design.** The model key, your permission decisions and your
  session history stay on your laptop, even when the agent runs in a container
  or a pod. The remote side is not trusted: what it asks of your machine is
  decided on your machine.
- **Any engine.** Your machine, Docker, Podman, Kubernetes or a remote daemon,
  with the same commands and the same session.
- **Any model.** Local models (any OpenAI-compatible endpoint) are first-class;
  the Anthropic Messages API works too.
- **Safe by default.** File writes stay in the workspace; shell commands ask
  first.
- **Sessions outlive the terminal.** The agent runs in a daemon: quit and come
  back, attach more than one client, reopen archived sessions.

## Install

On macOS or Linux (x64 and arm64):

```sh
curl -fsSL tentacle.so/install | sh
```

Options, and how to point tentacle at your model: [INSTALL.md](INSTALL.md).

## Quick start

```sh
tentacle                                   # interactive TUI in the current folder
tentacle "summarise src/"                  # one-shot
tentacle run --engine docker --image <ref> # the same agent, in a container
```

## Documentation

| Topic | Where |
| --- | --- |
| Install and first run | [INSTALL.md](INSTALL.md) |
| Ways to run: local, Docker, Podman, Kubernetes, kept workloads, logs | [docs/guide/running.md](docs/guide/running.md) |
| Remote: `serve` / `connect` | [docs/guide/remote.md](docs/guide/remote.md) |
| MCP: servers in tentacle, tentacle as an MCP server | [docs/guide/mcp.md](docs/guide/mcp.md) |
| A2A: other agents call tentacle, tentacle calls them | [docs/guide/a2a.md](docs/guide/a2a.md) |
| Relay: reach a `serve` with no open port, pair a phone or a laptop | [docs/guide/relay.md](docs/guide/relay.md) |
| Apps: pages the agent publishes | [docs/guide/apps.md](docs/guide/apps.md) |
| Configuration: every key, env overrides, `tentacle config` | [docs/guide/configuration.md](docs/guide/configuration.md) |
| Features: tools, permissions, MCP, sub-agents, skills, voice | [docs/guide/features.md](docs/guide/features.md) |
| Hooks and packages | [docs/guide/hooks-and-packages.md](docs/guide/hooks-and-packages.md) · reference: [docs/extensions.md](docs/extensions.md) |
| Architecture and design records | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Building, testing, releasing | [CONTRIBUTING.md](CONTRIBUTING.md) |
| What changed | [CHANGELOG.md](CHANGELOG.md) |

## License

[Apache-2.0](LICENSE).
