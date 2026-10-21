# eval/mcp-full-compat — full MCP compatibility across both protocol eras

> **Status:** eval (Context + Review; Implementation/Execution empty until each sub-task is promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Each sub-task below is promoted on its own.
> **Type:** eval → several feats · **Size:** XL as a whole ⇒ **split** into the S/M/L tasks below (AGENTS §10: no XL) · **Blast:** up to load-bearing (per task) · **Suited:** per task.
> **Builds on:** [`feat/mcp-remote-transport`](../feat/mcp-remote-transport.md) (Streamable HTTP + the dual-era 2026-07-28 client, part 2 still on its branch).

## Context

*— claude-opus-5-5, 2026-10-21*

**The question.** The owner wants tentacle's MCP client to be *fully*
compatible with both protocol eras — modern (`2026-07-28`: stateless,
per-request `_meta`, `server/discover`) and legacy (`2025-11-25` and earlier:
`initialize` handshake) — with no half-working features and no workarounds.
What does "fully compatible" mean, what is missing, and in what order should
it be built?

**What "fully compatible" means (owner-approved, 2026-10-21).** The spec
separates *protocol mechanics* (negotiation, transports, cancellation,
pagination, change notifications, errors), which a complete client must
handle in both eras, from *optional client features* gated by declared
capabilities (elicitation, sampling, roots, logging). A client that does not
declare a capability is fully conformant without it. `2026-07-28` marks
**Sampling, Roots, Logging and the HTTP+SSE transport (`2024-11-05`) as
Deprecated**: "new implementations should not add support"
(`/specification/2026-07-28/changelog` › Deprecated). Therefore:

- **In scope:** complete mechanics in both eras, plus the only non-deprecated
  optional feature real servers need, **elicitation**, plus **OAuth**
  authorization (remote servers in practice require it).
- **Out of scope by decision (not debt):** Sampling, Roots, Logging, HTTP+SSE.
  Revisit only if the spec un-deprecates them.

**Decision on re-issuing (owner-approved, 2026-10-21).** A broken modern
response stream loses the in-flight request, and it can only be re-issued as
a new request with a new id (changelog major 9). Re-issuing a side-effecting
`tools/call` on our own could run it twice (a payment, a commit) under a
permission the user granted once. Policy: **re-issue automatically only
side-effect-free methods** (`server/discover`, `tools/list`). A `tools/call`
fails with "response stream lost — the call's outcome is unknown", and the
model decides.

**Gap inventory (verified against the code on `feat/mcp-remote-transport` and
the 2026-07-28 spec, 2026-10-21):**

| # | Gap | Era | Evidence |
|---|---|---|---|
| G1 | `tools/list` pagination ignored: tools past page 1 are invisible | both | `listTools` reads only `result.tools` (`packages/mcp/src/client.ts`); `/server/tools` › Listing Tools (`cursor`/`nextCursor`) |
| G2 | Tool-set changes never seen: list read once at connect | both | legacy `notifications/tools/list_changed` (stdio inline / HTTP GET stream, not opened); modern `subscriptions/listen` (`/basic/patterns/subscriptions`) |
| G3 | No reconnect: a dead stdio process stays dead (spec SHOULD restart); legacy HTTP 404 session expiry closes (spec MUST start a new session); one broken modern stream closes the connection | both | `/basic/transports/stdio` › Unexpected Termination; part-2 Review finding 4 |
| G4 | Result content: only `text` reaches the model; `resource_link`, embedded resources, `structuredContent` (+ `outputSchema` validation, SHOULD) are dropped | both | `flattenMcpResult` (`packages/mcp/src/tool-adapter.ts`); `/server/tools` › Tool Result |
| G5 | No warning channel (dropped `x-mcp-header` tool: SHOULD log), negotiated version/era not shown in `/mcp` | both | `@tentacle/mcp` has no log sink; `McpServerStatus` has no version field |
| G6 | No OAuth: only static headers; real remote servers require the spec's authorization (protected-resource discovery, Client ID Metadata Documents, PKCE, `iss` validation, refresh) | both | `/basic/authorization` |
| G7 | No elicitation: legacy `elicitation/create` server requests get `-32601`; modern MRTR `input_required` fails the call | both | `client.ts` `handleMessage`; `/basic/patterns/mrtr` |

## Implementation

*(empty — each sub-task gets its own doc when promoted.)*

## Execution

*(empty.)*

## Review

*— claude-opus-5-5, 2026-10-21 (recommendation; owner approved the split and order)*

**Verdict: build it as six tasks after closing the current branch.** Each task
is one branch, one doc, one review. The order puts what makes the feature
*honest* first:

| # | Task | Gaps | Size | Blast | Notes |
|---|---|---|---|---|---|
| 0 | Close `feat/mcp-remote-transport`: part-2 review fixes + G1 | G1 | M | cross-module | on the existing branch |
| 1 | Reconnect & re-issue policy | G3 | M | cross-module | one `McpConnection` layer: recreate transport + client and re-negotiate, with backoff; safe-method re-issue per the decision above |
| 2 | Tool-set change notifications | G2 | L | load-bearing | legacy `list_changed` + modern `subscriptions/listen`; the agent's tool registry must update mid-session (a `cli` seam, designed explicitly) |
| 3 | Result content | G4 | M | cross-module | first verify what `ToolResult` + providers can carry (images/audio) before promising them |
| 4 | Warnings + version in `/mcp` | G5 | S | cross-module | `@tentacle/protocol` field ⇒ `PROTOCOL_VERSION` bump (AGENTS §7) |
| 5 | Elicitation | G7 | L | load-bearing | one handler, two inputs (legacy server request / modern MRTR retry with `inputResponses` + `requestState`); the prompt goes through the single `PermissionBroker` (§7); declare the capability only once it exists |
| 6 | OAuth | G6 | L | load-bearing | tokens live on the laptop (§7 identity); secrets never in config |

**Release gate:** remote MCP is not advertised as supported until 0, 1, 3 and
6 are merged. Without 1 it works until it drops; without 6 only
static-token servers work.

**What would change this:** the spec un-deprecating a feature, or a target
server requiring one of the excluded features.
