# feat/mcp-remote-transport — Streamable HTTP transport for MCP servers

> **Status:** review → ready to merge (promoted from `docs/eval/` on 2026-10-21, owner's OK)
> **Branch:** `feat/mcp-remote-transport`
> **Size:** L (part 2 grew it from M) · **Blast:** cross-module (`@tentacle/mcp` client + both transports + config schema; no change to the agent loop, `@tentacle/protocol`, or any §7 invariant) · **Suited:** strong model + mandatory fresh-context Review (L)

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

**Repro (2026-10-21, `main` @ 2a7a913)** — `.tentacle/tmp/mcp-remote-transport/repro.ts`:

```ts
import { FileConfigSchema } from "@tentacle/config";
const r = FileConfigSchema.safeParse({
  mcpServers: { remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } } },
});
console.log(r.success ? "accepted" : JSON.stringify(r.error.issues, null, 1));
```

Output: two issues — `mcpServers.remote.command` *Required* and
*Unrecognized key(s) in object: 'type', 'url', 'headers'*. A remote server
cannot even be configured.

## Implementation

*— claude-opus-5-5, 2026-10-21*

Scope, as the eval recommends: **Streamable HTTP only** (no legacy HTTP+SSE),
**transport only** (resources/prompts and MCP in the `serve` daemon stay on
their own `TODO.md` line). Spec revision this follows: Streamable HTTP as of
MCP 2025-03-26 and 2025-06-18 (one endpoint; POST per message; the reply comes
as JSON or as an SSE stream; `Mcp-Session-Id`; `MCP-Protocol-Version`).

### Load-bearing assumption

**MCP servers are connected only on the laptop, never in a pod daemon**, so a
remote server's URL and auth headers (account identity, §7 "identity with the
user") stay on the laptop the same way the model key does. Verified:
`connectMcpServers` has exactly three callers — the in-process path
(`packages/cli/src/main.ts:549`), the one-shot path via `connectConfiguredMcp`
(`packages/cli/src/wiring.ts:213`, called at `main.ts:598`), and the local
worker (`packages/cli/src/worker.ts:71`, spawned by `createLocalRuntime` at
`local-runtime.ts:310`). `serve.ts` (`startDaemon`/`startStdioDaemon`, the
`serve --stdio` pod daemon) does not import `@tentacle/mcp`; the daemon only
forwards an optional `mcpStatus` hook (`packages/daemon/src/session-host.ts:67`).
If "MCP in the `serve` daemon" lands later, that task must decide whether
header secrets may live on a `serve` host (trusted, user's own) — never in a pod.

### Preconditions

- The client is transport-agnostic: `McpClient` only uses
  `send`/`onMessage`/`onClose`/`close` (`packages/mcp/src/client.ts:47-53`,
  `types.ts:46`). A new transport needs no client logic change.
- Inbound server→client requests already get `-32601`
  (`client.ts:180-188`); notifications are ignored. So the transport only has
  to deliver every JSON-RPC message it reads, in order.
- A JSON-RPC `error` reply becomes `McpServerError`, and `ping` counts that as
  *reachable* (`client.ts:90-97`); a closed transport rejects every pending
  call with "MCP connection closed" (`client.ts:205-213`). These two outcomes
  are the only ways a transport can end a pending call. The HTTP failure
  mapping below picks between them on purpose.
- Config is parsed with `FileConfigSchema` and only the **first** issue's
  message is shown (`packages/config/src/load.ts:197-202`). So a plain
  `z.union` would turn today's clear "Unrecognized key(s) … 'comand'" into
  "Invalid input". The schema must discriminate before validating.
- `scrubSensitiveEnv` matters only for spawned processes (`transport.ts:30`).
  The HTTP transport spawns nothing, and its secrets are the configured headers.

### Design

**Config.** `type` on a server becomes a discriminator; omitting it means
stdio, so every existing config keeps working:

```jsonc
"mcpServers": {
  "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  "remote": { "type": "http", "url": "https://mcp.example.com/mcp",
              "headers": { "Authorization": "Bearer …" } }
}
```

`McpServerSchema` = `z.preprocess(fill type "stdio" when absent,
z.discriminatedUnion("type", [stdio.strict(), http.strict()]))`. Each branch
reports its own issues, so a stdio typo keeps its precise message. The type
mirrors this: `McpServerSpec = McpStdioServerSpec | McpHttpServerSpec`.

**Transport** (`packages/mcp/src/http-transport.ts`,
`createStreamableHttpTransport(spec, { fetch? })`):
- `send(msg)` POSTs one message to `spec.url` with `content-type:
  application/json`, `accept: application/json, text/event-stream`, the
  user's `headers`, plus `mcp-session-id` / `mcp-protocol-version` once known.
- Response: `application/json` → a message or a batch array. `text/event-stream`
  → each `message` event's `data` is one JSON-RPC message. `202`/empty → nothing
  to read (correct for notifications and responses).
- `mcp-session-id` is taken from any response header (the server assigns it on
  `initialize`). The protocol version comes from the `initialize` result
  (`result.protocolVersion`).
- `close()`: aborts every in-flight POST (one `AbortController`), emits close,
  and sends a best-effort `DELETE` with the session id so the server can free it.
- Injected `fetch` is the test seam (§9), as elsewhere in the repo.

**Failure mapping.** A pending request must always settle, and a reachable
server must never look unreachable (or the reverse):

| Event (for a POST that carries a request id) | Outcome | Why |
|---|---|---|
| `fetch` throws / the stream breaks before the reply | transport **closes** with the error as reason | the server is unreachable; same as a stdio server dying |
| HTTP 404 while we hold a session id | **close** ("session expired") | spec: the client must start a new session; reconnect is out of scope |
| other non-2xx (401, 500, …) | synthesized JSON-RPC error `HTTP <status> <text>` for that id | the server answered; `/mcp` shows it reachable, the call fails with the status |
| 2xx but the body ends without a reply for that id | synthesized error "ended the response without a result" | otherwise the call would hang until the 120 s timeout |

POSTs for notifications or responses (no id) that fail are dropped, because
nothing waits on them. The next request finds the problem.

**Close reason (small, additive).** `McpTransport.onClose` listeners receive an
optional `reason`. `McpClient` rejects pending calls with
`MCP connection closed: <reason>`, so a connect failure says *why* (e.g. the
connection was refused) rather than only "closed". `McpConnection` gains an
optional `closeReason()`, and `/mcp` shows it instead of the stdio-specific
"the server process exited" (kept as the fallback). Reason text comes from
`fetch` errors and status lines only, never from headers, so a token cannot leak.

### Files

1. `packages/mcp/src/types.ts` — `McpHttpServerSpec`, `McpServerSpec`;
   `McpServers` over the union; `onClose(listener: (reason?: string) => void)`.
2. `packages/mcp/src/http-transport.ts` (new) — transport + SSE parser.
3. `packages/mcp/src/client.ts` — carry the close reason into rejections; `closeReason`.
4. `packages/mcp/src/connect.ts` — route by `spec.type`; expose `closeReason`.
5. `packages/mcp/src/status.ts` — prefer `closeReason()` for `closed`.
6. `packages/mcp/src/index.ts` — export the transport.
7. `packages/config/src/schema.ts` — discriminated `McpServerSchema`.
8. `packages/config/src/defaults.ts` — document the `http` form in the scaffolded config.

No protocol, daemon, client-package or TUI change.

### Failure modes

- **Server unreachable at startup** → `initialize` rejects with the reason, and
  the server lands in `errors` like a stdio spawn failure (isolated, not fatal).
- **Unreachable mid-session** → the transport closes; in-flight and future calls
  fail fast with the reason; `/mcp` shows `closed` + reason. No reconnect
  (stdio has none either). Recorded as debt.
- **Auth failure (401/403)** → `initialize` fails with `HTTP 401 …`; the server
  is listed as failed.
- **Session expired (404)** → close, as above.
- **Stream torn mid-reply** → close. Resumption (`Last-Event-ID` GET) is out of scope.
- **Abort/timeout of one call** → the client already sends
  `notifications/cancelled` and rejects. The POST stream stays open until the
  server ends it, and `close()` aborts all of them.
- **Ordering**: `notifications/initialized` and `tools/list` are separate POSTs
  that may arrive out of order. Spec-compliant servers tolerate this, so we do
  not serialize (serializing would also block concurrent tool calls in JSON mode).
- **Malformed JSON in a body/event** → skipped, like non-JSON stdout noise in
  stdio. If the reply was that message, the "ended without a result" rule
  settles the call.
- **Secrets**: headers are sent only to `spec.url` and are never part of an error message.

### Tests

- `packages/mcp/test/http-transport.test.ts` (injected `fetch`): JSON reply;
  SSE reply incl. multi-line `data`, CRLF, chunk splits and a server request
  interleaved before the reply; 202 for notifications; session id captured and
  echoed, plus the protocol-version header after `initialize`; user headers
  sent; non-2xx → error reply for that id; 404 with session → close with
  reason; `fetch` rejects → close with reason; 2xx with no reply →
  synthesized error; `close()` aborts in-flight + sends DELETE.
- End-to-end: a localhost `Bun.serve` Streamable-HTTP MCP server (SSE replies)
  driven through the real `connectMcpServers` → tools listed and callable, `ping` ok.
- Config: `http` accepted; `type` omitted → stdio; stdio typo keeps its
  "Unrecognized key" message; `http` without `url` rejected.
- Status: a closed connection with a `closeReason` reports it.
- Red: the config test fails on `main` (the repro); the transport tests fail
  without the module. Non-vacuity: mutate the 404/no-reply rules and confirm
  the matching tests fail.

### Part 2 — MCP protocol revision 2026-07-28 (dual-era client)

*— claude-opus-5-5, 2026-10-21*

The owner asked for support of the newest MCP revision, on this same branch
(owner's choice over a separate task). Verified against the spec on 2026-10-21:
the **current** revision is `2026-07-28` (`/specification/versioning`). It is a
redesign, not a version-string bump. From the changelog:

- no `initialize` handshake: every request carries `_meta`
  `io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities`
  (and SHOULD carry `…/clientInfo`);
- the new `server/discover` is mandatory for servers;
- `UnsupportedProtocolVersionError` = `-32022` with `data.supported`;
- `ping` is removed;
- `Mcp-Session-Id`, the HTTP GET stream and DELETE, and `Last-Event-ID` are all removed;
- servers send no JSON-RPC requests; MRTR `InputRequiredResult` takes their place;
- results carry `resultType` (absent ⇒ `"complete"`);
- on HTTP, `Mcp-Method` / `Mcp-Name` headers are required, and clients MUST
  honour `x-mcp-header` → `Mcp-Param-*` headers (and drop tools whose
  annotation is invalid);
- on HTTP, closing the response stream *is* cancellation (no `notifications/cancelled`).

Servers in the wild are mostly still legacy (`2025-11-25` and earlier, with
the handshake), so the client must be **dual-era**
(`/specification/2026-07-28/basic/versioning#backward-compatibility…`).

#### Load-bearing assumption

**Era detection can be one transport-agnostic algorithm in `McpClient`.** The
spec's stdio rule is: probe `server/discover`; a `DiscoverResult` or a
recognized modern error ⇒ modern; any other error or a timeout ⇒ legacy
(`/basic/transports/stdio#backward-compatibility`). The HTTP rule is: inspect
a `400` body; a recognized modern JSON-RPC error ⇒ modern; empty or anything
else ⇒ legacy (`/basic/transports/streamable-http#backward-compatibility`).
The two collapse into one rule if the HTTP transport **delivers a non-2xx
body's JSON-RPC error as-is**, instead of synthesizing `HTTP <status>`. Then
`McpClient` sees the same three outcomes on both transports. The
"recognized modern errors" are the reserved codes `-32020` HeaderMismatch,
`-32021` MissingRequiredClientCapability and `-32022`
UnsupportedProtocolVersion (changelog minor change 12). The fallback is never
keyed to one specific legacy code (stdio MUST).

#### Design

- **`McpClient.initialize()` = negotiate the era.**
  1. Send `server/discover` with modern `_meta` (version `2026-07-28`),
     bounded by `probeTimeoutMs` (default 3 s).
  2. A `DiscoverResult` (`supportedVersions` is an array) that contains a
     version we speak ⇒ **modern**. If it lists only legacy versions (a
     dual-era server not offering ours) ⇒ legacy.
  3. `-32022` ⇒ intersect `data.supported` with ours; modern if one matches,
     legacy if only legacy versions are listed, else **fail** with both lists.
     Other modern errors ⇒ fail (a modern server refused us; falling back
     would be wrong).
  4. Any other error or a timeout ⇒ **legacy**: `initialize` advertising
     `2025-11-25` (newest legacy), then `notifications/initialized`. A
     returned `protocolVersion` outside our legacy list
     (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`) ⇒ close + fail.
  5. A transport close during the probe propagates (unreachable is not "legacy").
- **Modern requests**: `request()` merges `params._meta` with the three
  `io.modelcontextprotocol/*` keys. No `logLevel`, so servers must not send
  `notifications/message`.
- **`resultType: "input_required"`** ⇒ the call fails with a clear
  `McpServerError`. We declare no client capabilities, so a compliant server
  should not ask; MRTR support is debt.
- **`ping()`**: legacy ⇒ `ping`; modern ⇒ `server/discover` (mandatory, cheap).
  The existing reachability semantics are unchanged.
- **`McpClient.protocolVersion`** exposes the negotiated version (for tests;
  showing it in `/mcp` would be a wire change, so it is debt).
- **HTTP transport** (stays the place for all HTTP binding rules):
  - Headers per request: `MCP-Protocol-Version` from the body's `_meta`
    (single source of truth, so it cannot mismatch), else the legacy
    negotiated version. `Mcp-Method` on every request. `Mcp-Name` for
    `tools/call` / `prompts/get` (`params.name`) and `resources/read`
    (`params.uri`). Values outside the header-safe set, or matching the
    sentinel, use `=?base64?…?=`.
  - `x-mcp-header`: the transport remembers each tool's `inputSchema` from
    `tools/list` replies (it tracks `id → method` of its own requests). It
    **drops** tools whose annotations violate the spec constraints, and on
    `tools/call` mirrors the annotated argument values into `Mcp-Param-{name}`
    (string/integer/boolean; `null`/absent ⇒ omitted; same encoding). The
    validation and extraction live in a pure module (`http-headers.ts`), per
    §7 "logic in pure modules".
  - Non-2xx with a JSON (or SSE) body holding a JSON-RPC error **for this id
    or with no id** ⇒ deliver it as that id's error (a real server error,
    keeping its code). Otherwise keep the synthesized
    `HTTP <status>` + `data.httpStatus` (part 1).
  - Cancellation: an outgoing `notifications/cancelled` aborts that request's
    own fetch (closing its stream: the modern cancel signal). It is POSTed only
    when the request was legacy (no `_meta` version in the body). An aborted
    request never closes the transport.
  - Session id / DELETE: kept for legacy servers. A modern server never
    mints one, so modern does no DELETE.
- **Stdio transport**: unchanged. Cancellation stays `notifications/cancelled`
  in both eras.

#### Files

`packages/mcp/src/types.ts` (version constants, error codes) ·
`packages/mcp/src/http-headers.ts` (new, pure) · `packages/mcp/src/client.ts` ·
`packages/mcp/src/http-transport.ts` · tests (`client.test.ts`,
`http-headers.test.ts` new, `http-transport.test.ts`) · this doc.

#### Failure modes

- **Legacy server silent before `initialize`** ⇒ the probe times out (3 s), then legacy.
  Cost: up to 3 s at startup for that server only (servers connect in parallel).
- **Legacy server answers `server/discover` with a garbage result** (no
  `supportedVersions`) ⇒ legacy.
- **Modern server, no common version** ⇒ fail with "server supports X, client
  supports Y" in `errors` / `/mcp`.
- **Modern server rejects a header** (`-32020`) ⇒ surfaced as an error on
  that call, not a fallback.
- **Server sends `input_required`** ⇒ that call fails clearly, nothing hangs.
- **Cancel on modern HTTP** ⇒ the stream is aborted, the call rejects, and
  the transport stays open.
- **Invalid `x-mcp-header`** ⇒ the tool is dropped; the others stay usable.

#### Tests

- Client (scripted transports): modern discover ⇒ modern, with `_meta` on
  every request and no `initialize`; `-32022` with a common version ⇒ retry
  in modern; `-32022` with only legacy ⇒ legacy; an unrelated error ⇒
  legacy; silence ⇒ legacy after the probe timeout; a close during the probe
  ⇒ fail; an unsupported legacy `protocolVersion` ⇒ fail; modern `ping` ⇒
  discover; `input_required` ⇒ error.
- Pure headers module: encoding (plain, non-ASCII, padded, newline, sentinel);
  annotation validation (empty, bad token, duplicate case-insensitive,
  `number`, under `items`/`oneOf`/`$ref`); value extraction (nested, null,
  absent, boolean, integer).
- HTTP transport: modern request headers (`MCP-Protocol-Version` from
  `_meta`, `Mcp-Method`, `Mcp-Name` incl. base64); `Mcp-Param-*` from
  `tools/list`; an invalid tool dropped; a 400 with a modern error body
  delivered with its code; a 400 with an empty body ⇒ legacy fallback (e2e);
  modern cancellation aborts without POSTing; legacy cancellation POSTs.
- E2E (localhost): a modern-only server and a legacy-only server, both
  through `connectMcpServers`.

### Part 3 — close the branch: part-2 review fixes + pagination

*— claude-opus-5-5, 2026-10-21*

Task 0 of [`eval/mcp-full-compat`](../eval/mcp-full-compat.md), which the
owner approved together with its two decisions: deprecated features stay
out, and only side-effect-free methods are re-issued automatically. The
fixes, keyed to the part-2 Review findings:

1. **Blocker — a legacy stdio server that exits on the probe.** Old rmcp exits
   when its first message is not `initialize`.
   - `McpClient.initialize()` rejects with a distinct `McpProbeClosedError`
     when the transport closes during the probe.
   - `connectServer` then respawns that **stdio** server once and calls
     `initialize({ legacyOnly: true })`, which runs the handshake with no probe.
   - On HTTP a close during the probe means the server is unreachable, so it is
     not retried.
   - This matches the compatibility matrix: a dual-era client and a legacy
     server must work.
2. **Should-fix — a timed-out probe sends `notifications/cancelled` to an
   uninitialized server.** The probe's request opts out of the cancel
   notification and instead calls a new optional `McpTransport.abandon(id)`:
   "stop waiting, tell the server nothing". HTTP closes that request's stream;
   stdio has nothing to do.
3. **Should-fix — part 1's `ping` fix was undone.** A non-2xx body's JSON-RPC
   error is passed through as-is only for **400/404** (the statuses the spec
   gives a JSON-RPC body), and only when its id is ours or `null`. Every other
   status stays a synthesized error tagged `httpStatus`.
4. **Nit — one broken stream closed the whole connection.** Two cases are now
   distinguished:
   - `fetch` rejects with no response ⇒ the server is unreachable ⇒ close (as before);
   - the response started but its body broke ⇒ only that request fails, with
     "response stream lost — the call's outcome is unknown", tagged
     `streamLost` (`McpStreamLostError`, so it does not prove reachability).

   Re-issuing the safe methods is task 1.
5. **Nit — streams left open after the reply.** Once a request is answered,
   its stream is aborted.
6. **Nit — legacy `initialize` without `protocolVersion`.** It is rejected:
   the field is required in every legacy revision.
7. **Nit — 2026 HTTP rules applied to legacy.** The `Mcp-Method`, `Mcp-Name`
   and `Mcp-Param-*` headers and the `x-mcp-header` tool filtering now apply
   only to modern requests.
8. **G1 — pagination.** `listTools` follows `nextCursor`, with a cap of 100
   pages and repeated-cursor detection, so a server cannot loop us. Both eras.
9. The debt from the review now lives in `TODO.md` → `eval/mcp-full-compat`.

## Execution

*— claude-opus-5-5, 2026-10-21*

Built in the plan's order. All eight files listed, plus tests:

1. **Config** (`packages/config/src/schema.ts`). Red first: the new
   `packages/config/test/mcp-schema.test.ts` failed 3/6 on `main`'s schema.
   Then the `preprocess` + `discriminatedUnion` landed and the test went green.
   **Drift:** the parsed config now carries `type: "stdio"` on stdio servers
   (the preprocess fills it). One existing deep-equality assertion was updated
   for that (`packages/config/test/profile.test.ts:93`), and two hand-built
   configs in `packages/cli/test/worker.test.ts:91-92` gained `type: "stdio"`
   (the resolved type requires it).
2. **`mcp` types / client / connect / status / index**, as planned. `onClose`
   carries an optional reason; `McpClient.closeReason`; `McpConnection.closeReason?()`;
   `/mcp`'s `closed` row shows the reason, with "the server process exited"
   kept as the stdio fallback. Two existing tests in
   `packages/mcp/test/connect.test.ts` narrow the now-union spec (`"command" in spec`).
3. **Transport** (`packages/mcp/src/http-transport.ts`). **Drift from the
   first draft:** `emitClose` aborts every in-flight POST itself. Otherwise a
   transport that closed on its own (unreachable / session expired) and was
   then `close()`d by the client would have left other streams open, because
   `close()` returned early on `closed`. `DELETE` is sent at most once.
4. **Defaults** (`packages/config/src/defaults.ts`): the scaffolded config
   documents the `"type": "http"` form.
5. **Tests**: `packages/mcp/test/http-transport.test.ts`, 11 cases (fake
   `fetch` + two localhost `Bun.serve` end-to-end). One fake was wrong at first:
   it ignored the abort `signal`, unlike real `fetch`. It was fixed to error the
   body on abort, so the "close aborts in-flight" case tests the real contract.

6. **Non-vacuity by mutation** (§9), each rule broken alone and reverted:
   M1 (no 404 → close) → the 404 test fails; M2 (no synthesized "ended without
   a result" reply) → the 2xx-no-reply test fails; M3 (network failure → error
   reply instead of close) → the unreachable unit test and the e2e unreachable
   test fail. **Drift:** under M2 the test first *hung* instead of failing. It
   used `listTools()`, and `tools/list` has no per-call bound after the connect
   phase, which is exactly the hang the rule prevents. It now uses `callTool`
   with a 2 s `callTimeoutMs`, so the mutation fails cleanly on the timeout.

**Gate** (2026-10-21): `bun run typecheck` exit 0 · `bun run lint` clean
(354 files) · `bun test` 1550 pass, 2 skip (the two opt-in skips), 0 fail.
Caveat: the working tree also held another session's uncommitted
`skills-panel` work (protocol/daemon/client/cli/tui), so this gate ran over
both. The two tasks touch disjoint files.

**Post-review fixes** (the reviewer's three should-fix items, then committed
without a further review at the owner's request, 2026-10-21):

1. **`ping` vs HTTP error statuses.** A synthesized HTTP-status error now
   carries `data.httpStatus` (`packages/mcp/src/http-transport.ts`), and
   `McpClient` rejects it as `McpHttpStatusError` rather than `McpServerError`
   (`packages/mcp/src/client.ts`). So `ping` behind a proxy 503 or an expired
   token's 401 rejects, and `/mcp` shows `unresponsive: HTTP 503 …`. A real
   JSON-RPC error from the server still proves reachability (tested). Red first.
2. **`url` without `type`** (the Cursor / Claude Desktop shape) is inferred as
   `http`, not defaulted to stdio (`packages/config/src/schema.ts`). Red first.
3. **Status `closeReason` coverage.** New test in
   `packages/mcp/test/status.test.ts`. It passed on the code (the gap was
   coverage), and the mutation that drops `closeReason` in `status.ts` makes it
   fail, so it is non-vacuous.

Not done (left as the reviewer's nits, see Review): `http:`/`https:`-only
URLs; SSE bare-`\r` line endings and empty `event:`; case-insensitive
content-type; advertising a newer MCP protocol version.

**Gate after fixes:** typecheck exit 0 · lint clean (354 files) · `bun test`
1554 pass, 2 skip (opt-in), 0 fail.

**Part 2 — MCP 2026-07-28 dual-era** (*— claude-opus-5-5, 2026-10-21*).
Built as planned (Implementation › Part 2), in this order:

1. `packages/mcp/src/http-headers.ts` (new, pure) with
   `packages/mcp/test/http-headers.test.ts` (21 cases). The encoding test uses
   the spec's own example table.
2. `packages/mcp/src/types.ts`: `MCP_MODERN_VERSIONS` (`2026-07-28`),
   `MCP_LEGACY_VERSIONS` (`2025-11-25` … `2024-11-05`), the `_meta` keys and
   the reserved error codes. `MCP_PROTOCOL_VERSION` (`2024-11-05`) is gone.
3. `packages/mcp/src/client.ts`:
   - `initialize()` now negotiates the era: the `server/discover` probe first,
     then the legacy handshake;
   - `era` and `protocolVersion` getters;
   - `_meta` merged into every modern request;
   - `ping()` uses `server/discover` when modern;
   - `input_required` fails the call;
   - `McpServerError` carries `code`/`data`.
4. `packages/mcp/src/http-transport.ts`:
   - per-request tracking (`method`, its own `AbortController`, era);
   - headers per message (`MCP-Protocol-Version` from the body's `_meta`,
     `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`);
   - `tools/list` filtering by `x-mcp-header` validity;
   - a non-2xx JSON-RPC error body delivered with its code;
   - per-request cancellation (modern: abort only; legacy: abort + POST).
   **Drift:** a request's fetch uses only its own controller (no
   `AbortSignal.any`, which the TS lib does not type); `emitClose` aborts every
   tracked request explicitly instead.
5. Tests.
   - `client.test.ts` +13 negotiation cases.
   - `http-transport.test.ts`:
     - the legacy fake now rejects `server/discover` the way the TypeScript
       SDK does (400 + `-32000`), and the handshake test asserts the probe
       comes first;
     - +5 modern cases;
     - +1 localhost e2e against a strict modern-only server (header
       validation, 405 for non-POST).
   - The existing legacy e2e still passes: a legacy server's 404 to the probe
     falls back.

**Non-vacuity (§9):** nine mutations, each alone and restored (`cmp`). Every
one fails at least one test:
- C1 probe never modern → 7;
- C2 modern errors fall back → 1;
- C3 a close during the probe counts as legacy → 1;
- C4 no `_meta` → 5;
- T1 a non-2xx JSON-RPC error is not delivered → 2;
- T2 modern cancel POSTs → 1;
- T3 an invalid `x-mcp-header` tool is kept → 1;
- T4 no `Mcp-Param` → 1;
- H1 the sentinel is not encoded → 1.

**Gate** (2026-10-21, tree still shared with the `skills-panel` session):
typecheck exit 0 · lint clean (356 files) · `bun test` 1595 pass,
2 skip (opt-in), 0 fail.

**Not built (debt, on purpose):**
- MRTR input requests (we declare no client capabilities);
- `subscriptions/listen` (list-changed notifications);
- `resultType`-aware caching (`ttlMs`);
- showing the negotiated version in `/mcp` (a wire change);
- warning on a dropped `x-mcp-header` tool (no log channel in `@tentacle/mcp`);
- HTTP+SSE (2024-11-05) fallback (deprecated);
- re-issuing a request after a broken modern stream (the spec says MUST
  re-issue; we fail the call and close, as in part 1).

**Part 3 — review fixes + pagination** (*— claude-opus-5-5, 2026-10-21*).
Built as planned (Implementation › Part 3), with these specifics:

- **Blocker.**
  - `McpProbeClosedError` and `initialize({ legacyOnly })` in
    `packages/mcp/src/client.ts`.
  - `connectServer` (`packages/mcp/src/connect.ts`) now has an `open(legacyOnly)`
    helper and a single stdio respawn. HTTP is never retried.
  - The reviewer's repro server became the versioned fixture
    `packages/mcp/test/fixtures/strict-legacy-stdio-server.ts`, and two
    real-process tests run against it.
- **Probe cancel.**
  - New request option `notifyCancel: false` plus the optional
    `McpTransport.abandon(id)`.
  - HTTP `abandon` closes the request's stream; stdio has no per-request state.
  - **Drift:** `ConnectOptions.probeTimeoutMs` was added as a test seam, so
    the strict-server timeout test runs in 100 ms instead of 3 s.
- **`ping` regression.** A JSON-RPC body is passed through only on 400/404
  (`RPC_ERROR_STATUSES`), and only for our id or `null`.
- **Broken stream.** `post` now separates the fetch phase (no response ⇒
  close) from `readResponse` (body broke ⇒ that request fails, `streamLost` ⇒
  `McpStreamLostError`).
- **Answered stream** is aborted in `post`'s `finally`.
- **Legacy `protocolVersion`** is required. Three test fakes gained it.
- **2026 rules** are gated on the request carrying `_meta`, both for headers
  and for `tools/list` filtering.
- **Pagination**: `listTools` (100-page cap, repeated-cursor guard).
- `TODO.md` → `eval/mcp-full-compat`.

**Red before green, by mutation:** ten mutations undoing each fix, run alone
and restored, each failing its test(s):
- R1 no respawn → 2;
- R2 the probe notifies → 2;
- R3 a body passed through for any status → 1;
- R4 the error id ignored → 1;
- R5 a broken stream closes → 2;
- R6 the stream kept open → 1;
- R7/R8 2026 rules on legacy → 1 each;
- R9 a missing version accepted → 1;
- R10 the cursor ignored → 2.

**Gate** (2026-10-21, shared tree): typecheck exit 0 · lint clean
(357 files) · `bun test` 1612 pass, 2 skip (opt-in), 0 fail.

**Part 3b — the Part-3 review's findings** (*— claude-opus-5-5, 2026-10-21*).
The Part-3 Review approved with nits. The owner asked for no half measures,
so these were closed before merge:

- **N1 — respawn in the general case.** `McpProbeClosedError` became
  `McpHandshakeClosedError`. It is thrown when the transport dies before a
  *probing* handshake finishes: during the probe, or during the legacy
  `initialize` after it. A `legacyOnly` attempt never throws it, so there
  is at most one respawn.
  - New fixture mode `reply-then-exit` (answers the probe with an error, then
    exits): connects through the respawn.
- **Observation — a modern stdio server still booting when the 3 s probe gave
  up** (a cold `npx`). If the probe only *timed out* (new `McpTimeoutError`)
  and the legacy `initialize` then gets a JSON-RPC error, the server is alive.
  The client probes once more, bounded by the call timeout rather than the
  probe timeout, and goes modern on a `DiscoverResult`. Otherwise the
  `initialize` error stands.
- **N2 — a gateway's JSON error is not JSON-RPC.** A 400/404 body is passed
  through only if it carries `jsonrpc: "2.0"`. Otherwise it is an HTTP
  failure, and `ping` rejects.
- **Handed to task 1** (reconnect & re-issue, `eval/mcp-full-compat`):
  - **N3**: re-issue the probe after a lost stream or a 5xx, instead of
    concluding "legacy";
  - **N4**: a stdio server that crashes on startup is spawned twice, so its
    stderr and startup side effects show twice, and the error lacks the exit
    code. That is the cost of N1, and task 1's restart policy owns it.

**Mutations:** S1 (no handshake-closed signal after an answered probe) → 2 ·
S2 (no second probe) → 1 · S3 (no `jsonrpc` check) → 1. All restored.

**Gate** (2026-10-21, shared tree): typecheck exit 0 · lint clean
(357 files) · `bun test` 1619 pass, 2 skip (opt-in), 0 fail.

## Review

### Review — Part 3 (part-2 fixes + pagination)

*— claude-opus-5-5 (fresh-context reviewer, Part 3), 2026-10-21*

**Verdict: APPROVE-WITH-NITS.** All seven Part-2 findings are fixed, and
pagination works in both eras. Every mutation I tried was killed. One new
gap remains: the respawn trigger is narrower than the problem it fixes
(N1). The fix is cheap and recommended before merge. It does not block,
because the documented rmcp case is covered. The reviewer is the same model
as the executor (only the context is fresh), so blind spots the model shares
can survive both passes.

**Gate (re-run):** `bun run typecheck` exit 0 · `bun run lint` clean (357
files) · `bun test` **1612 pass, 2 skip (opt-in), 0 fail** (1614 tests, 146
files), which matches Execution · `bun test packages/mcp` 105 pass.

**Part-2 findings, re-checked against the code and the earlier repros**
(`.tentacle/tmp/mcp-2026-review/`):

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | blocker: a stdio server that exits on the probe | **fixed** | `e2e-stdio.ts` with `MODE=exit-on-unknown` gives `["mcp__s__echo"]` in 41 ms (it was "connection closed"). `connect.ts:112` respawns once, legacy-only. |
| 2 | timed-out probe sends `notifications/cancelled` | **fixed** | `MODE=strict-notify` connects (3005 ms, the probe timeout). `client.ts:353` calls `abandon`. On HTTP (my B4) nothing is POSTed after the probe and the transport stays open. |
| 3 | gateway JSON-RPC body made `ping` count as reachable | **fixed** | `e2e-http.ts` A1: `ping` rejects with `HTTP 503` and `HTTP 401`. Pass-through only on 400/404 (`http-transport.ts:161`), and only for our id, `null` or no id. |
| 4 | one broken stream closed the connection | **fixed** (re-issue is task 1) | A2: the call fails with "…outcome is unknown", `isClosed = false`, and the next `listTools` works. This matches the owner's decision in `eval/mcp-full-compat`. |
| 5 | stream left open after the reply | **fixed** | A3 reports 1 stream open right after `await`, but only because the abort runs in `post`'s `finally`, one microtask later. After one tick (my B1) 0 are open. Against a real `Bun.serve` that keeps its SSE stream open (B3), the server sees the abort, the result arrives whole, there is no unhandled rejection, and the transport stays open. |
| 6 | legacy `initialize` without `protocolVersion` accepted | **fixed** | `client.ts` closes and throws with a clear message. |
| 7 | 2026 HTTP rules applied to legacy | **fixed** | A4: legacy `initialize`/`tools/list` carry no `Mcp-Method`. The gate is the `_meta` **protocolVersion key**, not `_meta` alone, so a legacy request with `_meta.progressToken` stays legacy. |

**New findings**

- **N1 — should-fix (low-medium): the respawn only fires when the transport
  closes *during* the probe.** `client.ts:192` / `connect.ts:112`.
  - Scenario: a legacy stdio server answers the pre-`initialize`
    `server/discover` with a JSON-RPC error and *then* exits. Older Python SDK
    sessions raise "Received request before initialization was complete"
    and may die this way. I have not verified which SDK versions do.
  - The error reply arrives first, so the probe returns "legacy" and the
    client is not yet closed. `initialize` then hits the dead transport and
    fails with a plain `Error`, and no respawn happens.
  - Repro `.tentacle/tmp/mcp-part3-review/stdio.ts` (`MODE=reply-then-exit`):
    `errors: {s: "MCP connection closed"}`, spawns=1.
  - Fix: on stdio, respawn legacy-only whenever the first attempt failed
    because the transport closed before the handshake finished (the probe
    *or* the legacy `initialize`). For example, throw `McpProbeClosedError`
    (or a sibling type) from `initialize()` whenever `this.closed`. Add the
    fixture mode as a test.
- **N2 — nit: a non-JSON-RPC 404 body counts as a server answer.**
  `http-transport.ts:152`.
  - `jsonRpcError` accepts any `{error:{code:number}}` with no id and does not
    require `jsonrpc: "2.0"`.
  - A Google-style gateway 404 `{"error":{"code":404,"message":…,"status":"NOT_FOUND"}}`
    on a modern (session-less) server makes `ping` resolve, so `/mcp` shows
    it connected (repro B2).
  - Fix: also require `msg.jsonrpc === "2.0"`.
- **N3 — nit: a transient failure during the HTTP probe is read as
  "legacy".** `client.ts:210`.
  - A probe that ends with `McpStreamLostError` or `McpHttpStatusError`
    (5xx) falls through to legacy.
  - A modern-only server then fails `initialize`, so the failure is loud.
    A dual-era server is quietly downgraded to legacy for the whole session.
  - The spec's HTTP rule is "400 body ⇒ inspect", so treating stream-lost
    and 5xx as legacy goes further than the spec. Natural home: task 1
    (re-issue safe methods: re-issue `server/discover`).
- **N4 — nit: a server that crashes on startup is spawned twice.**
  - Its stderr is routed twice (repro `MODE=crash`: spawns=2, the stderr
    line twice), and any startup side effect (opening a browser, a
    migration) runs twice.
  - The final error is still a bare "MCP connection closed" with no exit
    code. That predates this part.
  - Acceptable. A note in the doc would do.
- **Observation, not from this part:** a modern-only stdio server that takes
  longer than 3 s to boot (an `npx` cold start) is misclassified as legacy
  and then fails `initialize`. The spec allows this ("reasonable timeout"),
  but the debt belongs in `eval/mcp-full-compat`.

**Attacks tried**
- **Settling of every pending request** (fetch phase vs body phase), traced
  through `post`/`readResponse`:
  - a fetch reject that the client cancelled → no close, and the client has
    already rejected;
  - a 404 with a session → close, and pending requests settle through
    `handleClose`;
  - a body error before the reply → `streamLost`;
  - after the reply → nothing;
  - a 2xx that ends without the reply → the synthesized error.

  **Holds.**
- **`abandon` vs `notifications/cancelled`:** the probe uses only `abandon`.
  Ordinary modern cancellation aborts and posts nothing. Legacy cancellation
  aborts and POSTs. A cancel for a request that already finished is a no-op.
  `settle` guards the race between a late reply and the timeout, and the
  stdio client ignores a late `server/discover` reply (`client.ts:422`).
  **Holds.**
- **Respawn:**
  - Leak: the first client is closed in `open`'s `catch`, which kills the
    process.
  - Timeouts: the connect timeout winning during the probe surfaces as a
    timeout, not `McpProbeClosedError`, so there is no respawn. Each attempt
    gets its own 10 s budget, so the worst case is about 2× before `tools/list`.
  - HTTP is never retried (M1).

  **Holds**, apart from N1/N4.
- **The backward-compat rule on HTTP:** a TS-SDK legacy 400/-32000 with
  `id:null` falls back (A4). A 405, 406 or 401 at the probe is synthesized,
  so the client falls back and `initialize` then fails loudly. A modern 400
  with -32022 is delivered with its code. **Holds.** Minor: an error body
  sent as SSE on a 400 is no longer inspected (Part 2's plan said "JSON (or
  SSE)"). The spec gives it as JSON, so this is acceptable.
- **The strict legacy `protocolVersion` check:** every legacy revision
  requires the field, and the four accepted versions cover all released
  legacy revisions. **Holds.**
- **Pagination (B5):** the modern `cursor` and `_meta` are merged on page 2.
  `x-mcp-header` maps from both pages are kept, so `Mcp-Param-Region` and
  `Mcp-Param-Zone` are both sent. The repeated-cursor guard and the 100-page
  cap both reject loudly. **Holds.**

**Mutations (mine; each alone, `bun test packages/mcp`, restored, all three
files confirmed byte-identical with `cmp`):**
- M1 HTTP retried on a probe close → 1 fail ("http: … no retry");
- M2 `legacyOnly` ignored → 3 fail;
- M3 a fetch reject does not close (it dispatches `streamLost`) → 2 fail;
- M4 the repeated-cursor guard removed → 1 fail.

All killed.

**How the executor behaved:**
- It fixed every finding the way the earlier review suggested, and turned
  the reviewer's repro into a versioned real-process fixture.
- It recorded its drift (`probeTimeoutMs` seam), kept the `skills-panel`
  work out of scope, and reported gate counts that match mine exactly.
- The one weakness is the narrow fix in N1. It fixed the exact repro, not
  the general class ("the transport died before the handshake completed").

### Review — Part 2 (MCP 2026-07-28 dual-era)

*— claude-opus-5-5 (fresh-context reviewer, Part 2), 2026-10-21*

**Verdict: REQUEST-CHANGES.** One blocker (1): the stdio probe breaks legacy
servers that worked on Part 1. Two should-fix items (2, 3). The rest is sound:
the era algorithm, the header binding and the tests hold, and every mutation I
tried was killed. Same model as the executor (only the context is fresh), so
blind spots shared by the model can survive both passes.

**Gate (re-run):** `bun run typecheck` exit 0 · `bun run lint` clean (356
files) · `bun test` **1595 pass, 2 skip (opt-in), 0 fail** (1597 tests, 146
files). This matches Execution. The tree also holds the unrelated `skills-panel` work.

**Spec checked directly** (2026-07-28: changelog, versioning, stdio,
streamable-http, cancellation). The premises are TRUE: the stdio probe has
three outcomes and the fallback MUST NOT be keyed to one code; the HTTP rule
inspects the 400 body; the reserved codes are -32020/-32021/-32022; `ping` is
removed; there are no sessions; closing the stream is the HTTP cancel; the
x-mcp-header constraints and encoding table match; a 404 with -32601 is a
modern unknown method. Changelog major change 9 does say a broken response
stream MUST be re-issued.

**Findings**

1. **blocker: the probe turns a legacy stdio server that exits on a pre-`initialize`
   request into a hard failure. This is a regression from Part 1.**
   `client.ts:159-162`: a close during the probe rethrows. The design states
   this on purpose ("unreachable is not legacy"), and for stdio it is wrong.
   rmcp (the official Rust SDK) up to at least v0.8.0 handles this in
   `serve_server_with_ct_inner`:
   `expect_request(...)` then `let ClientRequest::InitializeRequest(..) = &request else { return Err(ExpectedInitializeRequest) }`.
   In the stdio codec, an unknown method with an id becomes a codec error, so
   `receive()` returns `None`, which is `ConnectionClosed`. Either way the
   serve future fails and the usual `main` (`.serve(stdio()).await?`) exits.
   I read this in the v0.8.0 source and did not run it. rmcp `main` today is
   dual-era and answers `server/discover`, but servers pinned to older rmcp
   are common. Repro (`.tentacle/tmp/mcp-2026-review/e2e-stdio.ts` +
   `legacy-server.ts`, a legacy server that exits when its first message is
   not `initialize`): this branch gives
   `errors: {s: "MCP connection closed"}` in 25 ms. The same server through
   HEAD's (1e7932a) client (`e2e-head.ts`) gives `["echo"]`. The spec's
   compatibility matrix says "Dual-era | Legacy | Works". Fix: in
   `connectServer`, for stdio only, when the transport closes during the probe
   with no reply, respawn the process once and run the legacy `initialize`
   straight away with no probe (for example `McpClient.initialize({ era: "legacy" })`).
   Add a test with a scripted transport that closes on `server/discover`. HTTP
   keeps today's behaviour: a network failure there really means unreachable.
2. **should-fix: a timed-out probe sends `notifications/cancelled` to a server
   that has not been initialized.** `client.ts:300-308` (the probe uses the
   ordinary `request` timeout path). The stdio backward-compatibility text
   says "does not respond within a reasonable timeout: legacy. Fall back to
   `initialize`". It does not mention a cancel, and a legacy server's
   lifecycle allows nothing but `initialize`/`ping` before the handshake.
   rmcp's handshake rejects a notification as its first message
   (`ExpectedInitializeRequest` when the message is not a request, still on
   `main`). Repro (`MODE=strict-notify`: ignores unknown requests and exits on
   a pre-init notification): 3005 ms, then
   `MCP connection closed: exit on pre-init notification notifications/cancelled`.
   HEAD connects. Fix: give `request` a `cancelOnTimeout: false` option for
   the probe. On HTTP that option still needs the stream closed, so in the
   probe's case abort the transport request without sending the notification.
3. **should-fix: Part 1's fix #1 (`ping` must not count a gateway error as
   reachable) is undone for any non-2xx whose body is JSON-RPC-shaped.**
   `http-transport.ts:290-303` delivers the body's error for any status. A
   gateway 503 or 401 with
   `{"jsonrpc":"2.0","id":null,"error":{"code":-32603,…}}` becomes an
   `McpServerError`, so `ping` resolves and `/mcp` shows **connected**
   (`e2e-http.ts` A1, for both 503 and 401). HEAD synthesized
   `data.httpStatus` for every non-2xx. The spec gives JSON-RPC error bodies
   to `400` (version, capability and header errors) and to `404` (-32601)
   only. Fix: deliver the body's error as-is only for 400 and 404. For other
   statuses keep the synthesized error, or add `httpStatus` to the delivered
   error's `data`. The plan also says "for this id or with no id", but
   `jsonRpcError` ignores the id. Either check it or fix the comment.
4. **nit (acceptable debt, but untracked): a broken modern stream closes the
   whole transport.** `http-transport.ts:320-326`. One stream reset by a load
   balancer during a long `tools/call` marks the server closed for the rest
   of the session (`e2e-http.ts` A2: `isClosed = true`, and the next
   `listTools` fails with "client is closed"). The spec MUST re-issue. Not
   re-issuing a non-idempotent `tools/call` on its own is a defensible
   choice, and the failure is loud, so this is not a blocker. But modern is
   stateless, so failing just that request (keeping the transport open) is
   both cheap and closer to the spec. This debt, MRTR, `subscriptions/listen`,
   the `-32020` "re-list and retry" SHOULD and the dropped-tool warning are
   all missing from `TODO.md`. Add them.
5. **nit: a stream that stays open after the final response is never closed.**
   `http-transport.ts:307-312`. If a server keeps the SSE stream open after
   the reply (the spec only says it SHOULD close it), every call leaks an
   open fetch and a `requests` entry until `close()` (`e2e-http.ts` A3: 3
   streams still open after 3 resolved calls). Fix: abort the request's
   controller once `answered`, and do not count that abort as a failure.
6. **nit:** `client.ts:121`: a legacy `initialize` result with no
   `protocolVersion` is accepted and treated as `2025-11-25`. Failing would
   be stricter.
7. **nit:** `headersFor` / `filterTools` also apply the 2026 HTTP binding to
   legacy servers: `Mcp-Method`/`Mcp-Name`/`Mcp-Param-*` headers, and dropping
   tools with an invalid `x-mcp-header`. This is harmless today (legacy
   servers ignore the headers and do not use the annotation). Note it, or
   gate it on `request.modern`.

**Attacks tried**
- The HTTP probe against a TS-SDK-like legacy stateful server (400 + -32000,
  `id: null`, no session) falls back cleanly. Request sequence:
  `server/discover` (pv 2026-07-28), then `initialize` (no pv), then
  `notifications/initialized` and `tools/list` (pv 2025-06-18 plus the
  session). **Holds.**
- Python SDK legacy servers (≥1.9 answer an unvalidated request with -32602;
  HTTP stateful answers 400 -32600 "Missing session ID"), legacy TS SDK
  (-32601 or 400 -32000), servers that return an empty result to an unknown
  method (no `supportedVersions` array, so legacy), and a dual-era server
  that lists only legacy versions (legacy). These fall back by code reading
  and the existing tests. **Holds.**
- stdio legacy servers that exit, or that object to the cancel: **fails**
  (findings 1, 2).
- Gateway status bodies and `ping`: **fails** (finding 3).
- A broken or lingering modern stream: findings 4 and 5.
- `MCP-Protocol-Version` against the body `_meta`: taken from `_meta`, so it
  cannot mismatch. Mutation MB confirms it is pinned. `Mcp-Name` for
  `tools/call`/`prompts/get`/`resources/read`, the sentinel, and padded and
  non-ASCII values all follow the spec table. The safe-integer range is
  enforced. Annotations that are null or absent are omitted. **Holds.**
- `x-mcp-header` reachability: the `properties`-only chain, and invalidity
  under `items`/`oneOf`/`$defs`/root (MD). The duplicate check is
  case-insensitive. **Holds.** Minor: the draft-07 `dependencies` and
  `contentSchema` keywords are not walked, so an annotation there is ignored
  instead of invalidating the tool. This is a negligible edge.
- A failed `initialize` (no shared version, a modern -32020/-32021, a legacy
  version we do not speak): `connectServer` closes the client in its `catch`,
  and `initialize` itself closes on the version mismatch. **Holds.**

**Mutations (mine; none overlap the executor's nine).** Each was applied
alone, run with `bun test packages/mcp` (88 tests), and restored. `cmp`
confirmed all three source files byte-identical afterwards.
- MA (a dual-era server with only legacy versions throws) → 1 fail
- MB (no `MCP-Protocol-Version` from `_meta`) → 3 fail
- MC (`input_required` passed through) → 1 fail
- MD (no static-reachability check) → 4 fail
- ME (no legacy version check) → 1 fail
- MF (modern `ping` sends `ping`) → 2 fail
- MG (edge whitespace not encoded) → 1 fail
- MJ (`emitClose` leaves per-request controllers open) → 1 fail
- MK (a modern cancel does not abort the stream) → 1 fail

Every one was killed: the suite is non-vacuous on what it covers. The gaps are
the untested behaviours in findings 1-3 and 5.

**How the executor behaved.** It was disciplined and honest. The plan is
source-verified and mostly matches the spec. The drift is recorded
(`AbortSignal.any`). The debt is declared openly, including the spec MUST it
does not meet. The legacy fake was changed to the TS SDK's real 400 shape, and
nine mutations were shown. The miss is in *real-world* legacy behaviour: the
plan reasoned "close ⇒ unreachable" from the HTTP side and applied it to
stdio, where a process exit on an unknown pre-init method is a known legacy
reaction. It also did not re-check Part 1's `ping` fix against the new
body-delivery path.

*— claude-opus-5-5 (fresh-context reviewer), 2026-10-21*

**Verdict: APPROVE-WITH-NITS.** No blockers. Two should-fix items (1, 2) and one
planned test that is missing (3). Caveat: the executor is the same model
(claude-opus-5-5), so only the *context* is fresh and blind spots shared by the
model can survive both passes. The task is `cross-module`, not `load-bearing`,
so §10 does not require a different model.

**Gate (re-run by the reviewer):** `bun run typecheck` exit 0 · `bun run lint`
clean (354 files) · `bun test` **1550 pass, 2 skip, 0 fail** (1552 tests, 145
files). These match Execution. The tree also holds the unrelated `skills-panel`
work.

**Findings**

1. **should-fix: `ping` reports a gateway or auth failure as reachable.**
   `http-transport.ts:201-203` turns every non-2xx except "404 with a session"
   into a JSON-RPC error. `client.ts` `ping` counts any `McpServerError` as
   reachable. Repro (`ct.ts`): after the handshake, the server answers
   503 or 401. `listTools` then fails with `HTTP 503`, but `ping` resolves and
   `/mcp` shows **connected** with a latency. This happens when a reverse proxy
   returns 502/503/504 because the MCP backend is down, or when a bearer token
   expires mid-session: `/mcp` says connected while every call fails. Fix:
   mark the synthesized HTTP errors (for example `error.data.httpStatus`, or a
   reserved code) and have `ping` reject on them, so the row reads
   `unresponsive: HTTP 503`. Keep "ended without a result" as reachable.
2. **should-fix: a `url` without `type` gives a misleading config error.**
   `config/src/schema.ts:72-78`: `{ "url": "https://…/mcp" }` is the form
   Cursor and Claude Desktop accept. Here the preprocess fills `type: "stdio"`,
   and the first issue is `command: Required`. `load.ts:197-202` prints only
   `issue.message`, not the path, so the user sees `Invalid <config>: Required`
   with no hint about which key. Repro: `schema.ts` case `urlNoType`. Fix: in
   the preprocess, infer `"http"` when `url` is present and `command` is
   absent. Or prefix `issue.path.join(".")` in `load.ts`, which also helps
   every other config error.
3. **should-fix (test gap): the planned Status test is missing.** The plan's
   Tests list "Status: a closed connection with a `closeReason` reports it",
   but no test references `closeReason` in `status.ts`. Mutation M-c (remove
   `connection.closeReason?.() ??` at `status.ts:128`) leaves `bun test
   packages/mcp` at **44 pass / 0 fail**. Fix: add a `McpStatusTracker` case
   with a fake closed connection that returns a reason.
4. **nit: CR-only SSE line endings are not handled.** At
   `http-transport.ts:94`, `data: a\r\rdata: b\r\r` yields one garbage block,
   so the reply is lost and the call fails with "ended without a result". The
   SSE spec allows a bare `\r`. Fix: `.replace(/\r\n?/g, "\n")`, holding back a
   trailing `\r` across chunk boundaries.
5. **nit: an empty `event:` field drops the event.** At
   `http-transport.ts:79-80`, `event:` with an empty value sets
   `event = ""`, so the event is not treated as `message` and is dropped. The
   SSE spec dispatches an empty type as `message`. Fix: `event = value || "message"`.
6. **nit: content-type matching is case-sensitive.**
   `http-transport.ts:206-213` uses `includes("application/json")`, but media
   types are case-insensitive. With `Application/JSON` the reply is discarded
   and the call fails with "ended the response without a result" (`ct.ts`).
   Fix: `.toLowerCase()`.
7. **nit: the URL scheme is unrestricted.** `schema.ts:61`
   (`z.string().url()`) accepts `ftp:` and `javascript:` URLs, and plain
   `http://` to a remote host, which sends the `Authorization` header in
   cleartext. Fix: refine the scheme to `http:`/`https:`. Warning on non-local
   `http://` is optional.
8. **nit: the client's protocol version predates this transport.**
   `types.ts:67` `MCP_PROTOCOL_VERSION = "2024-11-05"` is older than Streamable
   HTTP (2025-03-26). The client also never checks the version the server
   returns, and the transport echoes whatever the server picked
   (`http-transport.ts:154-159`). This works with the SDK servers. If the server
   picks a version we do not implement, the spec says the client SHOULD
   disconnect. Fix: bump the version, or check it, in a follow-up.
9. **nit: false premise and an over-claiming test name.** The premise "today's
   clear 'Unrecognized key(s) … comand'" is false. On `main` the first issue for
   `{comand}` is already `Required` (`m.ts` against `git show main:…schema.ts`),
   so this is not a regression. The test "keeps its precise first-issue
   message" (`mcp-schema.test.ts`) only checks the joined messages. Rename it.
10. **nit:** `/mcp` falls back to "the server process exited" for an HTTP
    connection closed by `close()` with no reason (`status.ts:128`). This is
    reachable only after dispose. The plan's `main.ts:549`/`wiring.ts:213`
    citations drifted to `:558`/`:236-240` because of the other session's edits.

**Premise table**

| Premise | Verdict |
|---|---|
| Context repro: `type:"http"` rejected on `main` | TRUE (now accepted) |
| MCP connects only on the laptop: callers `main.ts` (in-process, one-shot via `wiring.ts:240`), `worker.ts:71`; `serve.ts`/`pod-runtime.ts` never import `@tentacle/mcp` | TRUE (grepped). The pod daemon is started with `serve --stdio --model-proxy` and loads its own config. Laptop `mcpServers` and headers never cross the wire. |
| `McpClient` uses only send/onMessage/onClose/close | TRUE |
| Inbound requests get `-32601`; error reply ⇒ `McpServerError`; ping counts it reachable | TRUE (and the cause of finding 1) |
| `load.ts:197-202` shows only the first issue | TRUE (and it omits the path, see finding 2) |
| "plain union would degrade today's clear unrecognized-key first message" | FALSE (finding 9), harmless |

**Mutations (reviewer's own; each file restored and verified with `cmp`)**
- M-a: `protocolVersion` never captured (`http-transport.ts:158`). The
  handshake test **fails**.
- M-b: `emitClose` does not abort (`http-transport.ts:144`). The
  "close() aborts in-flight" test **fails**.
- M-c: `status.ts` ignores `closeReason`. **No test fails** (finding 3).
- The executor's M1–M3 (404, no-reply, network→close) are plausible, and the
  tests read as pinning them. I did not re-run those three.

**Attacks tried**
- *Header/secret leakage.* Bun `fetch` errors for a refused connection, a DNS
  failure, a token in the query string, userinfo in the URL, or a bad header
  value contain no secret ("Header 'Authorization' has invalid value"). Close
  reasons come only from these and from status codes. **Holds.**
- *DELETE on exit.* `dispose()` followed by an immediate `process.exit` (the CLI
  path, `main.ts:634`): the server received 5/5 DELETEs (`del.ts`). **Holds.**
- *SSE parsing.* BOM is stripped by `TextDecoder`. `retry:`/`id:` are ignored.
  A CRLF split across chunks joins correctly. Comments are skipped. CR-only and
  empty `event:` fail (findings 4, 5).
- *Abort/close races.* `emitClose` is idempotent and aborts all POSTs. Aborted
  POSTs land in `catch` and do nothing. `deliver` after close is dropped, and
  pending calls were already rejected. **Holds.**
- *Pending request that could hang.* A 2xx with no reply settles. A torn stream
  closes. A never-ending SSE stream with no reply is bounded only by the
  per-call timeout: connect `timeoutMs`, `callTimeoutMs`, and the ping timeout.
  Every post-connect path has a bound. A cancelled call's stream stays open
  until the server ends it or `close()` runs (accepted, documented). **Holds.**
- *Config compatibility.* Existing stdio configs parse unchanged and now carry
  `type: "stdio"`. `null` in a profile still works (`nullable` wraps the
  preprocess). `mergeServers` replaces whole entries, so switching
  stdio↔http in a profile cannot field-merge headers onto a stdio spec.
  Unknown or upper-case `type` gives "Invalid discriminator value. Expected
  'stdio' | 'http'". **Holds**, apart from finding 2.
- *Batch / session.* JSON and SSE batch arrays are delivered element by element.
  The session id is echoed after initialize, and the protocol-version header is
  set before `notifications/initialized` goes out. Any later response may
  overwrite the session id, which is lax against the spec but harmless.

**What holds:** the transport sits behind the existing seam with no change to
the client's logic beyond the close reason. The failure mapping is coherent:
no pending call can hang without a bound, and secrets stay out of error text.
The §7 identity invariant holds, because MCP is laptop-only. The config change
is backwards-compatible.

**How the executor behaved:** disciplined. It did red-first on the config
test, fixed a fake `fetch` that ignored the abort signal, wrote honest drift
notes (including the M2 hang and the switch to `callTool`), and kept the scope
to this task's files. It missed the planned Status test, and it did not notice
that its "precise first message" premise was already false on `main`.

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
