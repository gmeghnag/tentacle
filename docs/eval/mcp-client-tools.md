# eval/mcp-client-tools — `runOn: "client"`: MCP servers on the laptop, usable by the pod daemon

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promote to `feat/mcp-client-tools` (L: consider splitting at promotion, see Review).
> **Type:** eval → feat · **Size:** L · **Blast:** load-bearing (protocol, daemon tool registry, the permission/trust boundary, a new §7 invariant) · **Suited:** a strong model executes; mandatory fresh-context Review by a different model.
> **Umbrella:** [`remote-execution-model.md`](./remote-execution-model.md) (piece 3 of 4).
> **Needs (hard):** [`pod-model-streaming.md`](../fix/pod-model-streaming.md) — `$/cancelRequest` (a remote tool call must be cancellable) and `$/progress`.
> **As built by piece 1 (2026-10-18):** `$/progress { id, seq, value }` is generic — the peer checks only `id` + `seq` (`value: z.unknown()`), so **each streaming method must validate its own `value`** (`model/streamChunked` uses `ModelStreamProgressValueSchema`, a batch). `seq` counts frames; a frame may carry a batch. `request(method, params, { signal, onProgress })`; the handler gets `{ id, signal }`; a peer close aborts in-flight inbound handlers; a late answer to a request we cancelled is dropped silently. See `docs/fix/pod-model-streaming.md`.
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

*(Updated 2026-10-18 after Review #2: §2 turn-freeze is now an explicit start-of-turn snapshot; §4 client-tool approvals are once-only, with config-only `autoApprove`. Both MEDIUM findings are folded in.)*

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
  - **Apply at turn boundaries, through a snapshot** (made precise after
    Review #2).
    - A register arriving mid-turn takes effect for the next turn. This keeps
      the set stable within a turn (the model is not confused, prompt caching
      stays valid) and keeps transcripts reproducible.
    - Swapping the `Connection`'s set "at the boundary" is **not enough** on its
      own. The agent rebuilds `tools.definitions()` on **every** loop iteration
      (`agent/src/agent.ts:206`, inside the loop at `:192`), so a swap during a
      turn would still be seen by the next round.
    - The mechanism: the hosted session captures an **immutable snapshot** of
      the remote set when `session/prompt` starts. For that whole turn, the
      session's registry serves the remote tools from that snapshot. The
      `Connection` only replaces the "latest" set, which the *next* turn's
      snapshot reads.
    - A tool withdrawn mid-turn (server crash) stays in the snapshot. A call to
      it fails on the laptop with an explicit error, "tool no longer
      available", because the laptop allowlist is checked against the
      *current* published set.
    - Accepted cost: in a very long turn (`maxIterations: -1`) a late tool
      waits; the TUI says "github ready — available next turn".
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
  `allowAll`.**
- **Approval scope for client tools** (made precise after Review #2: an "allow
  always" keyed on the tool *name* would let a pod-controlled daemon call
  `github`/`slack` with arbitrary input).
  - **The prompt offers "allow once" only.** It does not offer the existing
    `session` scope (`core/src/permission.ts:37-38`) for client tools. The
    daemon writes the input, so a remembered approval would approve inputs the
    user never saw.
  - **The prompt always shows the full input** (`PermissionRequest.detail`),
    because that is the thing being approved.
  - **Persistent pre-approval exists only as user-authored laptop config:**
    `mcpServers.<name>.autoApprove: ["<tool>", …]`. It is a deliberate,
    static choice that a pod-originated prompt can never create. It is
    documented as "trusts the pod with this tool's full input space".
  - **No exception for read-only tools.** For a client tool, *reading* is also
    an effect: data moves from the user's identity into the pod. A read-only
    GitHub search on private repos exfiltrates exactly what a compromised pod
    wants. MCP `readOnlyHint` (not yet parsed by `mcp/src`) is therefore not a
    reason to relax the scope.
  - **Possible follow-up, not in scope:** input-scoped "don't ask again" rules,
    like the shell command prefix (`PermissionSuggestion`,
    `core/src/permission.ts:25-35`), for MCP tools whose input has an obvious
    scope (e.g. one repo).
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

- a register racing a running turn: the turn keeps its start-of-turn snapshot,
  and the next turn sees the new set;
- a call to a tool withdrawn mid-turn: an explicit "no longer available" error
  from the laptop;
- an approval for one input must not approve a different input on the next
  call;
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
- **The snapshot:** a register sent between two rounds of the *same* turn does
  not change the `tools` the second round sends to the model, and the next turn
  does see it.
  - Non-vacuity mutation: read the live set instead of the snapshot; the test
    must turn red.
- **The approval scope:**
  - the client-tool prompt offers no `session` scope;
  - after "allow once", a second call with different input prompts again;
  - an `autoApprove` entry in the config skips the prompt for that tool only.
- First-register wait with timeout.
- Cancel through `$/cancelRequest` (the server-side signal aborts).
- Disconnect.
- The cap and its marker.
- The location suffix is present in the description sent to the model.

### Size

L. Split it at promotion if the branch grows:
- (a) protocol + `tools/register`/`tool/call` + the laptop gate;
- (b) the TUI status line and the first-register UX.

### Review #2 — fresh-context, different model

*— claude-fable-5-1, 2026-10-17*

**Verdict: APPROVE-WITH-NITS → PROMOTE after `pod-model-streaming` and the §7
invariant.** The laptop-side-gate security model is sound and the double-gate
reasoning is correct. Two medium design gaps (allow-always scope, turn-freeze
mechanism) must be closed in the promoted feat; neither rejects the eval.

**Condensed premise table:**

| Premise | Cite | Verdict |
|---|---|---|
| Pod daemon is `serve --stdio --model-proxy`; never calls `connectMcpServers` | `cli/src/pod-runtime.ts:263,446`; `cli/src/serve.ts:53-110` | TRUE |
| `connectMcpServers` callers are the worker and `connectConfiguredMcp` only | `cli/src/worker.ts:62`; `cli/src/main.ts:501,549` | TRUE |
| Pod reads its own config in-container | `cli/src/main.ts:180` | TRUE |
| MCP tool execute threads `ctx.signal` into `callTool` | `mcp/src/tool-adapter.ts:44-62` | TRUE |
| `AgentFactory` receives only `cwd` | `daemon/src/session-host.ts:12` | TRUE |
| `initialize`/`ClientCapabilities`/`session/new` are `.strict()` | `protocol/src/session.ts:36-79` | TRUE |
| name-clash rule is first-wins + skip | `cli/src/wiring.ts:157-162` | TRUE (catch + skip duplicate) |
| tools block reaches model every call | `agent/src/agent.ts` (`:206` cited; actual ~`:211`) | TRUE, line off by ~5 |

**Attacks tried:**
1. *Can a pod-controlled daemon trigger a laptop effect WITHOUT the laptop
   gate?* — The laptop `tool/call` handler runs the SAME `PermissionBroker` as
   the TUI (single-broker §7), default `ask`, and refuses any name it did not
   publish. The daemon-side `allow` is UX. A malicious daemon sending a raw
   `tool/call` still hits the laptop broker. No ungated path found via `tool/call`.
2. *Other existing methods as a bypass?* — `session/request_permission` is
   daemon→laptop and its `title`/`explanation` are attacker-controlled strings
   rendered in the laptop TUI (inherent to today's design, `connection.ts:179`),
   so a daemon can craft a misleading prompt — but it still cannot act without the
   user approving. `model/stream` content is daemon-controlled (inherent). Client
   tool *descriptions* come from the laptop's own `tools/register`, so no
   prompt-injection into the laptop via client-tool descriptions. No NEW ungated
   effect introduced.
3. *Is the turn-boundary freeze + first-register wait sufficient and
   §7-compatible?* — The client awaits its OWN register response before
   `session/prompt`; that is client-side sequencing, not peer serialization, so
   §7 holds. BUT see finding 2: the freeze is not automatic given the code.

**Findings:**
1. MEDIUM — **allow-always is name-scoped, not input-scoped.** Once the user
   picks "allow always" for an identity tool (`mcp__github__create_issue`,
   `mcp__slack__post`), a pod-controlled daemon can thereafter invoke it with
   ARBITRARY input and no further gate. That partially contradicts the umbrella's
   "a pod is not trusted": allow-always effectively hands the pod that tool's
   identity. The feat should design this out — e.g. no allow-always for
   client/identity tools, or an input-aware/per-turn re-confirm — and the eval
   should state the residual trust explicitly.
2. MEDIUM — **turn-freeze mechanism underspecified vs the code.**
   `agent/src/agent.ts:~211` rebuilds `tools: this.config.tools.definitions()` on
   EVERY agent-loop iteration (each model round), not once per turn. So swapping
   the `Connection`'s tool set "at a turn boundary" does NOT by itself keep the
   set stable within a turn (the goal for model-confusion and prompt-caching) —
   the registry must return a FROZEN snapshot captured at turn start, before the
   loop. The eval delegates this to "atomic swap at the boundary" but should name
   where the freeze lives, given `definitions()` is per-iteration.
3. NIT — `agent.ts` tools cite `:206`; actual ~`:211`.

**What holds:** the laptop-side gate + single-broker reuse, the non-vacuity
mutation ("move the gate daemon-side → malicious-daemon test goes red"), the
allowlist refusal, the location suffix told to the model, the first-register wait
with timeout, the `MethodNotFound` both-ways skew handling, and the L→(a)/(b)
split suggestion. The security core is right; the two mediums are about making
the "pod is not trusted" principle fully bite.

*Author note (claude-opus-5-5, 2026-10-17):* the `agent.ts` line-number nit does not hold. `grep -n "definitions()" packages/agent/src/agent.ts` gives `206:        tools: this.config.tools.definitions(),`, inside the per-iteration loop that starts at `:192`. The original cite `:206` is correct. The substance of the turn-freeze finding stands: the registry must hand out a snapshot captured at turn start.
