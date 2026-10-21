# eval/mcp-status — `/mcp`: list the MCP servers and whether each is reachable

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promote to `feat/mcp-status`.
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing (a new wire method: protocol + daemon `Connection` + `RemoteClient`) · **Suited:** mandatory fresh-context Review.

## Context

*— claude-opus-5-5, 2026-10-21*

**Question.** Should Tentacle have a `/mcp` slash command that lists the
configured MCP servers and says, for each one, whether it is online/reachable
right now? If so, what shape should it take?

**Today (verified 2026-10-21):**

- No `/mcp` command. The built-ins are `/help /clear /compact /model /retry
  /copy /save /tokens /exit` (`packages/tui/src/commands.ts:26-36`).
- MCP servers are connected **once, at startup**, by `connectMcpServers`
  (`packages/mcp/src/connect.ts:84`). It runs from three call sites: the
  worker daemon (`packages/cli/src/worker.ts:69`), the in-process fallback TUI
  (`packages/cli/src/main.ts:547`), and the one-shot prompt
  (`packages/cli/src/main.ts:593`). `serve` and the pod daemons build a
  `SessionHost` with no MCP at all (`packages/cli/src/serve.ts:115,231`).
  Pod-side MCP is evals `mcp-client-tools` / `mcp-daemon-servers`.
- A connection failure is only **logged**:
  `[mcp] server "<name>" failed to connect: …`
  (`packages/cli/src/local-runtime.ts:323-326`). In the TUI that log goes to the
  buffered stderr sink, so the user sees it only after quitting (AGENTS §7,
  "never write raw to the terminal while Ink owns it").
- Nothing tracks a server after startup. If its process dies,
  `McpClient.handleClose` marks the client closed
  (`packages/mcp/src/client.ts:179-188`). The user finds out only when a tool
  call returns `MCP call failed: MCP client is closed`
  (`packages/mcp/src/tool-adapter.ts:59`).
- There is no wire method that reports daemon-side MCP state. The method list
  is in `packages/protocol/src/methods.ts:36-47`.

**Repro** (`.tentacle/tmp/mcp-status/repro.ts`, 2026-10-21, on `main` @ `3ce995c`):

```ts
import { SLASH_COMMANDS } from "../../../packages/tui/src/commands.ts";
import { Method } from "@tentacle/protocol";
console.log("/mcp in SLASH_COMMANDS:", SLASH_COMMANDS.some((c) => c.name === "/mcp"));
console.log("wire methods:", Object.values(Method).join(", "));
```

```
/mcp in SLASH_COMMANDS: false
wire methods: initialize, session/open, session/close, session/prompt, session/compact, session/snapshot, session/enqueue, session/resolve_permission, model/stream, model/streamChunked
```

**Options considered.**

1. *TUI-only*: show the startup errors that the main thread already receives
   (`mcp-errors`). Rejected. That data is a startup snapshot and only exists on
   the worker path. It can't show a server that died later, or a server that
   is alive but wedged, and it doesn't work over `connect`.
2. *A daemon-side status + live probe over a new request `mcp/status`*
   (**recommended**). The daemon is where the servers run (AGENTS §7: the TUI
   is always over RPC, logic is daemon-side). On each `/mcp` the daemon reports,
   per configured server: still connecting / connect failed (with the error) /
   process gone / alive. For a live one it sends a short MCP `ping` and reports
   the latency, or `unresponsive` on timeout. Per the MCP spec, any JSON-RPC
   response proves reachability, including an error such as "method not found"
   from a server that doesn't implement `ping`.
3. *A pushed `session/update` on every state change.* Rejected for now. A new
   update discriminant breaks mixed-version `connect` (AGENTS §7), and a
   pull-on-demand command needs no push.

**Constraints that shape option 2:**

- **Additive, no version bump.** It is a new request method, so an older daemon
  answers `MethodNotFound` (`packages/transport/src/peer.ts:322`). The TUI shows
  "this daemon doesn't support /mcp" instead of an error.
- **Untrusted strings.** Over `run`/`attach` the daemon is in the pod. Server
  names and error texts are pod-supplied, so the schema bounds them and the TUI
  renders them through the same one-line sanitiser the skill descriptions use
  (`commands.ts` `oneLine`).
- **Don't serialise the peer.** The probe takes up to its timeout. It runs as
  one concurrent request handler, like any other (AGENTS §7), and pings the
  servers in parallel.
- `serve`/pod daemons have no MCP today, so they answer `servers: []`. That is
  honest: they really have none.

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-21*

**Verdict: approve option 2.** On 2026-10-21 the owner asked for this to be
implemented ("scrivi la eval, poi implementa"), so the eval is promoted to
`feat/mcp-status` right away.
