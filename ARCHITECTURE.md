# Architecture

> Living design document. Every locked decision is recorded here as an ADR
> (Architecture Decision Record) with its rationale, so future changes are
> deliberate and traceable. Keep this file in sync with the code.

## 1. Goal & scope

A **SOTA agent harness**: the software layer that turns an LLM into an
autonomous/semi-autonomous agent. It is a *platform*, not a tool. Target
subsystems:

1. **Agent loop** — orchestration: prompt → model → parse tool-calls → execute → feedback → repeat.
2. **Model/provider layer** — provider-agnostic: a `ModelProvider` contract with two native wire formats (OpenAI-compatible `/v1/chat/completions`, Anthropic Messages `/v1/messages`).
3. **Tool system** — extensible registry with schemas, permissions; MCP for third-party tools.
4. **Context engineering** — token budget, compaction/summarization, caching, file-state tracking.
5. **Execution environment** — where tools run (host now; container later), behind one interface.
6. **Permission & safety** — approval gates, allow/deny policy for destructive actions.
7. **Session/state** — persistence, resume, checkpoints, transcripts.
8. **Reasoning scaffolding** — plan mode, sub-agents, test-feedback loops.
9. **Remote control** — drive & observe a headless agent from a light client.
10. **Observability** — structured logs, traces, token/cost accounting.

Built in **vertical slices** (F0…F6); each slice is production-grade and fully
tested — never a demo.

## 2. Topology

```
Client (CLI/TUI, later web)
   │  WS + JSON-RPC 2.0 (ACP-shaped vocabulary)
   ▼
Agent Daemon (headless)
   ├─ Model layer      → any OpenAI-compatible endpoint, or the Anthropic Messages API
   ├─ Tool executor    → ExecutionEnvironment (host impl now; container later)
   ├─ Context manager  → token budget, compaction, cache
   ├─ Permission engine
   └─ Session store     → SQLite (bun:sqlite)
```

## 3. Decision records (ADRs)

### ADR-001 — Runtime: **Bun**
Native TypeScript execution (no build step in dev), built-in test runner, bundler,
and `bun:sqlite`/native WebSocket reduce the dependency surface. Trade-off: Node
compatibility is strong but not 100% — any native-addon or socket-path integration
is smoke-tested before adoption.

### ADR-002 — Language & repo: **TypeScript (strict) monorepo, Bun workspaces**
One language across core, daemon and clients. Monorepo with `packages/*` keeps the
protocol as a single shared source of truth. `tsc --noEmit` type-checks the whole
tree; Bun runs the sources directly. Lint+format via **Biome** (single fast tool).

### ADR-003 — Model interface: **`ModelProvider` contract, multiple native wire formats**
`/v1/chat/completions` is the de-facto universal format (local and cloud), so the
first and default provider targets it with a configurable `baseURL`. The contract,
however, is wire-format-agnostic: `providers/` ships a **second, native Anthropic
Messages API** provider (`/v1/messages` — top-level `system`, `tool_use`/`tool_result`
content blocks, `content_block_delta` streaming) selected by `model.provider`.
Each provider **normalizes tool-calling differences and capability-detects** per
endpoint (e.g. llama.cpp `reasoning_content`, partial tool-call streaming) — fidelity
is NOT uniform across servers. A new wire format adds a provider + decoder; the agent
loop, protocol, and session path never change.

### ADR-004 — Remote control: **WS + JSON-RPC 2.0, ACP-shaped vocabulary**
Transport/framing is ours (WebSocket, remote-native, multi-client, mid-run inject) —
ACP's stdio/local, single-client assumptions do not fit a networked daemon. But the
*semantics* (session lifecycle, turn, `session/update` streaming, `request_permission`)
are modelled 1:1 on ACP, so an ACP adapter (editors) and an AG-UI adapter (web UI)
are cheap to add later. One internal event/command model; interop protocols are
optional projections.

### ADR-005 — Execution environment: **host now, container later, one interface**
Tools execute on the OS where the harness runs. `ExecutionEnvironment` abstracts this;
a `HostExecution` implementation ships first, a container (podman) implementation later,
without touching callers. Podman/dockerode are explicitly out of the current critical path.

### ADR-006 — Token accounting: **pluggable counter + heuristic fallback**
Local models do not share OpenAI's tokenizer. A `TokenCounter` interface allows
per-model strategies, with a heuristic fallback and optional delegation to a server
`/tokenize` endpoint when available.

## 4. Testing philosophy (anti-regression)

- **Schemas first, validated both ways**: every protocol/tool schema has tests for
  accepted *and* rejected payloads.
- **Contracts before implementations**: core interfaces are defined and exercised via
  fakes before concrete impls exist.
- **No slice merges red**: `bun run check` (typecheck + lint + test) must pass.
- Pure logic is unit-tested; I/O boundaries are isolated behind interfaces so they can
  be faked deterministically.

## 5. Build phases

- **F0 (current)** — monorepo skeleton, `protocol/` (ACP-shaped schemas), `core/` contracts, tests, ADRs.
- **F1** — model layer (streaming + tool-calls) + agent loop + host tools (fs, shell) + in-process CLI → end-to-end agent.
- **F2** — container execution environment.
- **F3** — daemon + remote control (WS) + remote client.
- **F4** — context compaction + session persistence/resume + permission engine.
- **F5** — MCP client + sub-agents + TUI (Ink).
- **F6** — observability, cost routing, hardening.
