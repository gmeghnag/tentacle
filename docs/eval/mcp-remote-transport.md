# eval/mcp-remote-transport — which MCP transport beyond stdio (SSE vs Streamable HTTP)?

> **Status:** eval (Context + Review; direct-to-`main`, no branch; Implementation empty until promoted)
> **Prospective work (if promoted):** Type: `feat` · Size: M · Blast: cross-module (a new `McpTransport` impl behind the existing client seam; no change to the agent loop or protocol) · Suited: standard model + standard Review — additive behind a tested seam.

## Context

*— claude-opus-4-8, 2026-10-17*

**The question being decided:** which remote MCP transport should tentacle's
client gain next — the legacy HTTP+SSE transport, the current **Streamable HTTP**
transport, or both — and does this task also pull in MCP **resources & prompts**,
or stay transport-only?

**Evidence (verified).** MCP today is **stdio-only**:
- The client is built over a generic `McpTransport` interface
  (`packages/mcp/src/client.ts:44`), and the only implementation is
  `createStdioTransport` (`packages/mcp/src/transport.ts:24`), which spawns the
  server as a subprocess. The seam is already abstracted — **a new transport is
  additive** (a second `McpTransport`), no change to `McpClient`, the agent loop,
  or `@tentacle/protocol`.
- `TODO.md:654` defers "MCP: SSE/HTTP transport; resources & prompts; MCP in the
  `serve` daemon" as one line.

**The SSE-vs-HTTP decision matters (do not just implement "SSE").** In the MCP
spec, the original **HTTP+SSE** transport (2024-11) was **superseded by
Streamable HTTP** in the 2025-03 revision; "SSE" as originally planned is the
*legacy* path. Building the deprecated transport now would be a pezza, not a
solid base. (Confirm the current spec revision at implementation time — this
area moves.)

## Implementation

*(empty — an eval is not built until promoted to a `feat`.)*

## Execution

*(empty.)*

## Review

*— claude-opus-4-8, 2026-10-17 (recommendation; owner decides)*

**Recommendation: implement Streamable HTTP, not legacy HTTP+SSE; transport-only
first, resources/prompts as a separate task.**

- **Streamable HTTP over SSE.** It is the current spec transport and subsumes the
  SSE streaming case; the legacy HTTP+SSE transport is deprecated and would be
  built-dead. Honour the antifragile directive: build the base that is current,
  not the one already on its way out. (If a must-support server is SSE-only,
  revisit — but default to the current transport.)
- **Scope: transport only.** Resources & prompts and "MCP in the `serve` daemon"
  are separable concerns bundled on the same TODO line; keep this task to the new
  `McpTransport` + its wiring/config (a remote server spec needs a URL + auth
  header, vs the stdio spec's command/args). Split the rest into their own tasks
  so each stays one legible branch (§10).
- **Shape (additive, §7/§8).** New `createStreamableHttpTransport(spec)`
  implementing `McpTransport`; extend the server-spec schema with a remote
  variant (`config/schema.ts`); route by spec kind in `connect.ts`. `McpClient`
  is untouched — that is the proof the seam was right.
- **Failure modes to design out (for the plan):** connection loss / reconnect
  and resumability (Streamable HTTP's session-id + event-id replay), auth header
  handling (reuse the `scrubSensitiveEnv` discipline — never log the token),
  server-initiated requests over the stream (the client already replies `-32601`
  to unknown inbound requests — `client.ts`), and timeout/abort (the per-call
  timeout + `notifications/cancelled` path already exists from Block 7).

**Promotion trigger:** on the owner's OK, `git mv` this doc to
`docs/feat/mcp-remote-transport.md` and open that branch.

**What would change the recommendation:** a concrete target server that only
speaks legacy HTTP+SSE (then scope that transport explicitly, as compatibility,
not as the default).
