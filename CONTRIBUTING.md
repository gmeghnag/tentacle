# Contributing

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
