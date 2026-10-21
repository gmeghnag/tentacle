# feat/mcp-remote-transport — Streamable HTTP transport for MCP servers

> **Status:** implementation (promoted from `docs/eval/` on 2026-10-21, owner's OK)
> **Branch:** `feat/mcp-remote-transport`
> **Size:** M · **Blast:** cross-module (a new `McpTransport` impl behind the existing client seam + an additive config-schema variant; no change to the agent loop, `@tentacle/protocol`, or any §7 invariant) · **Suited:** standard model + standard Review

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

## Review

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
