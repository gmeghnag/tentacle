# eval/mcp-client-tools — `runOn: "client"`: MCP servers on the laptop, usable by the pod daemon

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promote to `feat/mcp-client-tools` (L: consider splitting at promotion, see Review).
> **Type:** eval → feat · **Size:** L · **Blast:** load-bearing (protocol, daemon tool registry, the permission/trust boundary, a new §7 invariant) · **Suited:** a strong model executes; mandatory fresh-context Review by a different model.
> **Umbrella:** [`remote-execution-model.md`](./remote-execution-model.md) (piece 3 of 4).
> **Needs (hard):** [`pod-model-streaming.md`](./pod-model-streaming.md) — `$/cancelRequest` (a remote tool call must be cancellable) and `$/progress`.
> **Needs (soft):** [`rpc-flow-control.md`](./rpc-flow-control.md) — large results. Until it lands, a laptop-side result cap is the stopgap.
> **Needs (rule):** the §7 invariant proposed in the umbrella ("a pod is not trusted") — this eval's gate design follows from it.

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** in `run`/`attach` (and `connect`), can the MCP
servers configured on the laptop be used by the agent running in the pod? If
so: how the daemon learns about them, how a call is executed and cancelled,
where the permission gate sits, and what the model is told.

### Today (verified)

- **In pod mode, no MCP tools exist at all.**
  - The pod daemon is `tentacle serve --stdio --model-proxy`
    (`cli/src/pod-runtime.ts:263`, `:446`).
  - `startStdioDaemon` (`cli/src/serve.ts:53-110`) builds the agent with
    `buildAgent` and never calls `connectMcpServers`. The only callers are the
    local worker (`cli/src/worker.ts:62`) and `connectConfiguredMcp`
    (`cli/src/main.ts:501,549`).
  - The pod reads *its own* config (`main.ts:180`, `loadConfig` inside the
    container). The laptop config is never shipped, since exec carries argv
    only.
- **Tool definitions reach the model on every call** (`agent/src/agent.ts:206`,
  `tools: this.config.tools.definitions()`). An MCP tool is a thin `Tool`
  whose `execute` calls `client.callTool(...)` with the turn's `ctx.signal`
  (`mcp/src/tool-adapter.ts:44-62`).
- **The owner's MCP servers** (veil and playwright) add about 5.4k tokens of
  definitions per call and connect in 857 ms (umbrella, "Measured baseline").
- **The reverse-RPC pattern exists:** `model/stream`
  (`daemon/src/connection.ts:90`, `client/src/remote-client.ts:166`).
- **The schemas are strict:** `initialize`, `ClientCapabilities` and
  `session/new` are all `.strict()` (`protocol/src/session.ts:36-79`), so new
  fields on them break an old daemon. New *methods* are the clean extension
  point (§7).
- **`AgentFactory` receives only `cwd`** (`daemon/src/session-host.ts:12`).
- **Measured reverse RPC cost:** p50 47 ms, p99 ~155 ms (`rpc-flow-control.md`).
  That is negligible next to an MCP call or a model round.

### Why "client" first

The built-in tools (fs_*, shell, and through shell also git and linters) already
cover the workspace inside the pod. The MCP servers that add the most are
network/identity ones (GitHub, Jira, Slack, browser), and by the umbrella
principle those belong with the user's identity on the laptop.

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-17 (author; design brainstormed with the owner on 2026-10-17; a different model must review before promotion)*

**Verdict: PROMOTE after `pod-model-streaming` and the §7 invariant**, with this
design.

### 1. Config

- A per-server `runOn: "client" | "daemon"` (owner's choice of name).
- The default is `"client"`.
- In the local TUI the two coincide, so the field is ignored.
- `"daemon"` is [`mcp-daemon-servers.md`](./mcp-daemon-servers.md).

### 2. Discovery: push (decided with the owner: B over pull)

- The laptop sends **`tools/register { tools: [{name, description,
  jsonSchema}] }`** (a new method) after `initialize`, and again whenever its
  set changes (a late server, `tools/list_changed`, a crash or restart).
- An old daemon answers `MethodNotFound`. The laptop then shows "the pod
  daemon is too old for laptop tools" and continues without them.
- **The tools are scoped to the connection, not the session:** `Connection`
  holds the set, and `AgentFactory(cwd, { remoteTools })` wires it into each
  session's registry.
- **Two rules recover the stability of a pull design:**
  - **Apply at turn boundaries.** A register arriving mid-turn takes effect
    for the next turn. This keeps the set stable within a turn (the model is
    not confused, prompt caching stays valid) and keeps transcripts
    reproducible. Accepted cost: in a very long turn (`maxIterations: -1`) a
    late tool waits; the TUI says "github ready — available next turn".
  - **First register awaited before the first prompt.** The laptop awaits it
    with a short timeout (proposal: 3 s). Meanwhile the status line shows
    "[mcp] 2/3 ready". Servers that miss the timeout arrive by a later
    register. Because dispatch is concurrent (§7), the *client* guarantees
    the ordering by awaiting the register response before
    `session/prompt`.

### 3. Execution

- The daemon calls **`tool/call { name, input }`** (a new method,
  daemon → laptop) with `{ signal }` from the turn, through `$/cancelRequest`.
- The laptop runs it through its local MCP client and threads that signal into
  `callTool` (`tool-adapter.ts:55`).
- The result is `{ content, isError }`, the same as `mcpToolToTool`.
- A laptop disconnect fails a pending call with an explicit tool error
  ("client disconnected"), never a hang.

### 4. Security: the gate is laptop-side

The umbrella states the reason: the daemon is pod-controlled.
- **Laptop allowlist:** a `tool/call` for a name that the laptop did not itself
  publish is refused and audit-logged.
- **The laptop gate** runs in `RemoteClient`'s `tool/call` handler with the
  **same** `PermissionBroker` instance as the TUI (single-broker invariant, §7).
  The default is `ask`. **It is never auto-approved by a daemon-side
  `allowAll`**, and "allow always" is stored on the laptop only.
- On the daemon side, remote tools are marked `allow`, to avoid a double
  prompt. That daemon-side decision is UX, not security.
- **The model is told where the tool runs.** The tool description gets the
  suffix "(runs on the user's machine, not in the workspace)". Otherwise a
  laptop filesystem MCP would be used as if it touched the pod's files: a
  silent wrong-target error.

### 5. Results

- **Laptop-side hard cap** before replying: the stopgap until
  `rpc-flow-control` (proposal: 256 KB). The result is truncated with an
  explicit marker: "truncated to N KB on the client".
- **Daemon-side:** the normal built-in result pipeline (truncation for the
  model, spill to `.tentacle/tool-output/` in the pod).
- Non-text MCP content stays flattened (`tool-adapter.ts:33-36`) for now.

### 6. Name collisions

The same `mcp__<server>__<tool>` name could come from the client and from a
pod-side server. The rule is first wins, with a warning, the same as
`connectConfiguredMcp` (`cli/src/wiring.ts:157-162`). With a single
`mcpServers` map, a client/daemon clash on one server name cannot happen.

### Failure modes the Implementation must cover

- a register racing a running turn: atomic swap at the boundary;
- a register during the first-prompt wait;
- a late server; a server crash: the laptop re-registers without it, and a
  call in flight gets an error;
- an unpublished name: refused and logged;
- cancel mid-call;
- a disconnect mid-call;
- an old daemon or an old laptop (`MethodNotFound` both ways);
- a huge result;
- reconnect (`pod-attach-resilience`): the laptop re-registers on the new
  connection.

### Tests

- **The deciding test:** a pod-side agent sees a laptop tool, and calling it
  runs on the laptop's MCP client.
- The gate is on the laptop: the same broker, and a daemon-side `allowAll`
  does not bypass it.
- **Non-vacuity mutation:** move the gate to the daemon side; a test with a
  "malicious daemon" fake that sends a raw `tool/call` must turn red.
- Allowlist refusal.
- The boundary swap: the set does not change within a turn.
- First-register wait with timeout.
- Cancel through `$/cancelRequest` (the server-side signal aborts).
- Disconnect.
- The cap and its marker.
- The location suffix is present in the description sent to the model.

### Size

L. Split it at promotion if the branch grows:
- (a) protocol + `tools/register`/`tool/call` + the laptop gate;
- (b) the TUI status line and the first-register UX.
