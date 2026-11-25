# fix/serve-mcp-polish — identify the rejected `/mcp` caller, a usable startup hint, an idempotent `session_start`

> **Status:** implementation (approved — plan only; no code written yet)
> **Branch:** `fix/serve-mcp-polish` (worktree `.tentacle/worktrees/serve-mcp-polish`, off `main` @ `6fe306bc`)
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** DeepSeek (standard in-context Review: contained, no §7 invariant and no persisted/wire format of ours changes)
> **Changelog:** `changelog.d/serve-mcp-polish.fixed.md` — the serve log lines and the startup hint are operator-visible.

## Context

*— claude-opus-5-5, 2026-11-25*

Three small defects in the `serve` MCP surface (`docs/feat/serve-mcp-server.md`, slices M2/M3/M4), all found by using it (TODO.md:7):

1. **The rejected `/mcp` caller is anonymous.** The log carries `mcp-auth-failure` (packages/daemon/src/mcp/http.ts:84) and, on a serve without an MCP token, the generic `auth-failure /mcp` (packages/daemon/src/ws-server.ts:393) — neither names the peer. Something has been probing `/mcp` with bad credentials since 2026-11-22, *before* the MCP server existed (TODO.md:7), and we cannot tell what it was. Neither line may ever print the presented token.
2. **The startup hint prints an unusable URL.** `RunningServer.url` is built verbatim from the bind (`${scheme}://${options.host}:${server.port}`, packages/daemon/src/ws-server.ts:493-495), so `serve --host 0.0.0.0` makes main.ts:1263-1264 suggest `claude mcp add … http://0.0.0.0:4001/mcp` — a URL no MCP client can dial. A wildcard bind *does* serve loopback, so the hint should say so. (A2A has the same shape at main.ts:1258-1262; `serve.ts:967-974` already treats a wildcard bind as "no usable absolute URL" for the Agent Card, the same insight applied differently.)
3. **A retried `session_start` creates a second session.** `start` mints a fresh session and a fresh turn unconditionally (`crypto.randomUUID()` at tools.ts:353, `turnId = ${s}.${crypto.randomUUID()}` at :363) — there is no key, no replay window, nothing: `session_start`'s schema is `{prompt, title}` only (tools.ts:133-143, proven by Repro 3) while the sibling `session_send` already has the retry key (`key`, tools.ts:161, `MCP_KEY_MAX` = 64 at :47). The plan *documented* this hole and deferred it: "Retried `session_start` | A second session (documented, visible in `session_list`); B5 if it bites" (docs/feat/serve-mcp-server.md:443), backlog item B5 (`:557`), plus the known concurrency hole "N concurrent `session_start` calls all pass" (`:992`). It bit on 2026-11-25 ~21:05: ONE `session_start` from Claude Code (wrapped as an MCP task) produced TWO sessions «MCP: Prova MCP 2» three seconds apart — `mcp-default-d547c6b9…` (answered) and `mcp-default-a09deaee…` (a duplicate) (TODO.md:7).

**Repro.** Point 2 and point 3's schema gap, run on `main` @ `6fe306bc`, 2026-11-25 (from the worktree root; pure, no server):

```
$ bun -e 'import { mcpAddHint } from "./packages/cli/src/serve-mcp-server.ts";
  const serverUrl = "ws://0.0.0.0:4001";
  const httpUrl = serverUrl.replace(/^ws/, "http").replace(/\/+$/, "");   // main.ts:1263
  console.log("MCP on " + httpUrl + "/mcp"); console.log("  " + mcpAddHint(httpUrl));'
MCP on http://0.0.0.0:4001/mcp
  claude mcp add --transport http tentacle http://0.0.0.0:4001/mcp --header "Authorization: Bearer <token>"

$ bun -e 'import { MCP_TOOLS } from "./packages/daemon/src/mcp/tools.ts";
  console.log(JSON.stringify(MCP_TOOLS[0].inputSchema)); console.log(JSON.stringify(MCP_TOOLS[1].inputSchema));'
{"type":"object","properties":{"prompt":{"type":"string","minLength":1,"description":"The task (≤ 64 KiB)."},"title":{"type":"string","maxLength":60}},"required":["prompt"]}
{"type":"object","properties":{"sessionId":{"type":"string"},"text":{"type":"string","minLength":1},"key":{"type":"string","minLength":1,"maxLength":64}},"required":["sessionId","text"]}
```

(the point: no `key` on `start`, one on `send`; `title`'s cap is `MCP_TITLE_MAX` = 60, tools.ts:46/:141.)

Point 1, to run against a live serve (not run by the planner — needs a serve with `--mcp-token`); it shows the anonymous line:

```
$ curl -s -o /dev/null -H "Authorization: Bearer nope" -X POST http://127.0.0.1:4001/mcp
$ # serve's stderr shows ONLY:  [daemon] mcp-auth-failure          <- no address, no user-agent
```

Point 3's production evidence is the two session ids in TODO.md:7 (`session_list` / the store at `~/.config/tentacle/daemon/…`); it is not reproducible on demand because it needs Claude Code's own retry. Its red test (T5) is the local reproduction.

## Implementation

*— claude-opus-5-5, 2026-11-25* — **APPROVED** (owner delegated the decisions; see #### Orchestrator decisions)

### Load-bearing assumption

**The MCP HTTP route is handed Bun's `Server`, so the peer address is reachable from inside it — and it is not reachable from the `Request`.** `startWsServer`'s `fetch(req, srv)` calls `route?.handle(req, srv)` (packages/daemon/src/ws-server.ts:376-381), and that `srv` already yields the peer address: `requestIP(req)?.address ?? ""` at ws-server.ts:356 (typed `PeerAddressable`, ws-server.ts:135-143). The `ExternalRoute` seam types `srv` as `TimeoutServer`, which today carries only `timeout` (packages/daemon/src/external/route.ts:16-18) — so the address is one interface field away, and no new plumbing through `Bun.serve` is needed. If this were false, point 1 would need a signature change through the whole external entry.

### Preconditions

- `/mcp` is owned by the MCP route *before* the plain route's authorize: ws-server.ts:376-381, route built only with a token (`createMcpRoute` throws without a caller, mcp/http.ts:64-67; `mcp?: ExternalRoute` optional, ws-server.ts:84). Hence `auth-failure /mcp` means "a serve with no MCP token" — an outside prober, not a mis-authenticated MCP client.
- `authenticateCaller` reads the token from `Authorization: Bearer` only, never from the URL (external/route.ts:36-37, :45-49) and returns just the caller name (:38-61) — nothing in the auth path needs the peer; the audit is a separate concern.
- `external/route.ts:7` already imports `tokensMatch` from `../ws-server.ts`. So **ws-server.ts must not import `external/route.ts`** (import cycle): the peer/sanitizer helper goes in a new leaf module both may import.
- The MCP tool `inputSchema` is client-side introspection, not our wire protocol: adding a field needs no `protocol.d/` note and no `PROTOCOL_VERSION` bump (AGENTS §7 "fields are free" applies to `@tentacle/protocol`; MCP is an external spec surface, and an older client simply never sends the new field). Additive only: no existing field of `session_start` changes shape or meaning.
- `McpTools` has no audit sink today (`McpToolsOptions`, tools.ts:70-89 — only `onError`); `BuildMcpInput` already receives one (packages/cli/src/serve-mcp-server.ts:37) and passes it to `createMcpRoute` only (:80).
- `taskId` **is** the turn id (docs/feat/serve-mcp-server.md:328 "taskId = turnId"; derived back at tools.ts:563-570), so a replayed start that returns the same `turnId` returns the same task id — no second task id can exist.
- `start` reserves nothing before awaiting: `admit` (:358) then `attach` (:366) — the single-flight must therefore *precede* the map lookup, not follow it (also what `:992` records).
- Existing assertions the change touches, both deliberate: `mcp-tools.test.ts:519` compares the audit line with **exact equality** (`l === "mcp-auth-failure"`) ⇒ that is the RED for point 1; `project-pairing.test.ts:466` uses `startsWith("auth-failure")` ⇒ kept by putting the peer *after* the path.

### Design

**P1 — name the rejected peer, never the token.**

New leaf module `packages/daemon/src/external/peer.ts` (pure, no imports — avoids the cycle noted above):

```ts
export const PEER_UA_MAX = 120;
/** The UA header as ONE printable ASCII line: control chars dropped, `"` → `'`, capped. "-" when absent. */
export function sanitizeUserAgent(raw: string | null): string
/** `at <address> ua "<ua>"`; `at unknown` when the server cannot say (a fake/test `srv`). */
export function describePeer(req: Request, srv: TimeoutServer): string
```

`TimeoutServer` (external/route.ts:16-18) gains the **optional** member `requestIP?: (req: Request) => { readonly address: string } | null` — optional so any existing/hand-rolled `srv` still typechecks and a missing one degrades to `at unknown` instead of throwing.

Audit lines become (prefix kept so existing greps and `startsWith` assertions hold; the peer is appended):
- mcp/http.ts:84 → `mcp-auth-failure ${describePeer(req, srv)}`
- mcp/http.ts:80 → `mcp-origin-refused ${describePeer(req, srv)}` (a page-driven probe is exactly the mystery caller class)
- ws-server.ts:393 → `auth-failure ${pathname} ${describePeer(req, srv)}`

**Never logged:** the `Authorization` value, any prefix/suffix/length of it, the query string, or a hash of the token. The audit path only reads `user-agent` and `srv.requestIP`. `mcp/http.ts:84`'s 401 body and `www-authenticate` header stay unchanged.

**P2 — a hint a client can dial.**

New pure `hintUrl(serverUrl: string): string` beside `mcpAddHint` in packages/cli/src/serve-mcp-server.ts (:57-60): parse with `URL`, and rewrite **only** a wildcard authority —
`0.0.0.0` → `127.0.0.1`; `::` / `[::]` → `[::1]` (a wildcard IPv6 socket always answers `::1`; `127.0.0.1` is *not* implied when `bindv6only=1`, so `[::1]` is the honest loopback for that bind); every other host is kept verbatim ("else the bound host"); scheme and port are kept. Returns `${protocol}//${host}` (no path, no trailing slash, so `main.ts:1264`'s `${httpUrl}/mcp` and `mcpAddHint` compose exactly as today). On a `URL` parse failure (never in practice) it returns the input unchanged.

main.ts:1263 becomes `const httpUrl = hintUrl(server.url.replace(/^ws/, "http").replace(/\/+$/, ""));` — the MCP line only. A2A's line (:1258-1262) is left alone (see decisions).

**P3 — an idempotent `session_start`.**

Additive schema: `session_start.inputSchema.properties.key` = `{type: "string", minLength: 1, maxLength: MCP_KEY_MAX}` (the same bound and wording as `session_send`'s, tools.ts:161), described as "makes a retried start return the same session"; **not** required.

In `McpTools`:

```ts
const STARTS_MAX = 256;                 // cap, oldest evicted first (the ACCEPTED_MAX shape, tools.ts:95)
const START_KEY_TTL_MS = 10 * 60_000;   // an explicit `key` a caller chose
const START_REPLAY_TTL_MS = 15_000;     // no key: the implicit replay window (the observed retry was 3 s)
interface StartMemo { readonly sessionId: string; readonly turnId: string;
                      readonly prompt: string; readonly title?: string;
                      readonly kind: "explicit" | "implicit"; readonly at: number;
                      readonly answer: Promise<void>; }   // settles when the turn was accepted
```

`start(caller, args, task)`:
1. parse `prompt`, `title`, `key = optStr(args, "key", MCP_KEY_MAX)` (optStr, tools.ts:238).
2. `memoKey` = `k\0${caller}\0${key}` when a `key` was given, else `r\0${caller}\0${sha256(prompt + "\0" + (title ?? ""))}` (the two namespaces are ours, so a caller cannot collide one with the other). Caller is in the key: no caller can replay or hijack another's start.
3. sweep: drop memos older than their own TTL (explicit vs implicit), then keep at most `STARTS_MAX`, oldest first (the same housekeeping as `ACCEPTED_MAX`, tools.ts:505-510 and `admitting`, :735).
4. **hit** → if `prompt`/`title` differ from the memo's, `throw new InvalidToolParams("key reused with different arguments")` (→ `-32602` via `invalid()`, mcp/http.ts:265-269) and open nothing; else `audit("mcp-start-replayed " + memo.sessionId)`, `await memo.answer` (this is the single-flight: a concurrent identical call waits on the first) and answer **exactly as the first did** — non-task: `toolResult({sessionId, turnId})`; task: `taskCreated(a, turnId)` when that turn is still live, else the plain `{sessionId, turnId}` (never invent a task for a finished turn).
5. **miss** → create the memo (with its `answer` promise) *before* the first `await`, then run today's body unchanged (`admit` :358 → `attach` :366 → `prompt` :367, `turnId = ${s}.${crypto.randomUUID()}` :363): the promise resolves on acceptance, rejects on refusal. The `finally` deletes the memo when `answer` rejected (a refusal is not a replay: a retry must be able to try again).

Wiring: `McpToolsOptions` gains `readonly onAudit?: (line: string) => void` (additive), `buildMcp` passes `input.onAudit` to both `McpTools` and `createMcpRoute` (serve-mcp-server.ts:69-81).

Key lifetime: in memory, per `McpTools` (one per serve) — a replay is a seconds-scale event in the same process. The key never reaches the session log, the session id or the turn id (ids stay `mcp-<caller>-<uuid>` / `<uuid>.<uuid>`, so nothing durable changes and no caller can choose a session id).

#### Orchestrator decisions

The owner delegated the open questions; each is the recommended option, one line of why.

- **D1 — Key: an optional `key` argument *plus* a short implicit replay window** (not the key alone): the 2026-11-25 duplicate came from a client that will never send a `key` it does not know, so a key-only fix leaves the reported bug standing.
- **D2 — The implicit key is a hash of `(caller, prompt, title)`**, not the JSON-RPC request id: `r.id` is chosen by the caller and may legitimately repeat across *different* calls, so keying on it would silently answer one start with another's session.
- **D3 — Lifetimes: 10 min for an explicit `key`, 15 s for the implicit window**, capped at 256 memos: a retry is seconds away, while 15 s is short enough that an intended re-run of the same prompt is not swallowed (and distinct explicit `key`s are the documented escape hatch).
- **D4 — Same `key`, different arguments → `-32602`**, not "return the old session": silently running the wrong prompt is worse than one explicit error.
- **D5 — In-memory memo, not key-derived session ids**: it keeps every durable id and the session-log format untouched (no new persisted/derived identity), and derived ids would still not fix a caller that sends no key.
- **D6 — `0.0.0.0` → `127.0.0.1`, `::`/`[::]` → `[::1]`; no other host rewritten**: the wildcard binds loopback for v4, and `[::1]` is the only loopback a v6-only stack is guaranteed to answer.
- **D7 — Log the *address + user-agent* only, sanitized and capped**: the UA is attacker-controlled text going to an operator's terminal (log forging / ANSI), and the token is never an acceptable diagnostic.
- **D8 — Scope covers the generic `auth-failure` line too; A2A's audit lines are left for a follow-up**: `auth-failure /mcp` is the line the *no-MCP* serves produce, which is half the reported evidence; A2A's lines are pinned by exact-equality tests of their own (a2a-http.test.ts:132) and were not reported.

### Files

In dependency order (nothing protocol-side: `@tentacle/protocol` is untouched).

1. `packages/daemon/src/external/peer.ts` — **new**, pure: `sanitizeUserAgent`, `describePeer`, `PEER_UA_MAX`.
2. `packages/daemon/src/external/route.ts:16-18` — `TimeoutServer.requestIP?` (optional).
3. `packages/daemon/src/mcp/http.ts:80,84` — append `describePeer(req, srv)` to both audit lines.
4. `packages/daemon/src/ws-server.ts:393` — append `describePeer(req, srv)` to `auth-failure`.
5. `packages/daemon/src/mcp/tools.ts` — `McpToolsOptions.onAudit` (:70-89); `session_start` schema `key` (:137-143); the memo map + constants + `start` replay/single-flight (:346-374); `sha256` helper (Bun's `crypto.subtle` or a `Bun.hash` text digest — one call, no dependency).
6. `packages/cli/src/serve-mcp-server.ts:69-81` — pass `onAudit`; `:57-60` — add `hintUrl`.
7. `packages/cli/src/main.ts:1263-1264` — use `hintUrl`.
8. `changelog.d/serve-mcp-polish.fixed.md` — **new**, one bullet (`fixed`): the serve log names a rejected `/mcp` caller (address + user-agent, never the token), the startup hint no longer suggests `0.0.0.0`, and a retried `session_start` returns the same session.

Tests live in existing suites (below), no new suite needed except the pure peer test.

### Failure modes

| Case | Outcome |
|---|---|
| Retry, identical `(prompt,title)`, no key, ≤ 15 s | Same `sessionId`+`turnId`, one `mcp-start-replayed` audit line, no second session/turn. |
| Retry after the serve restarted (memo gone) | A second session — **residual, documented** (D5); retries are seconds apart and a restart is not one. |
| Same prompt intentionally twice within 15 s | Collapsed into one; distinct explicit `key`s keep them separate (D3). Surfaced by the audit line, never silent. |
| Same `key`, different args | `-32602 key reused with different arguments`; nothing opened, memo untouched. |
| Two identical calls concurrently | Single-flight: both await one memo, one session; both answers carry the same ids (and, for a task request, the same taskId). |
| Two *different* starts concurrently | Unchanged — still both admitted (the `:992` hole in the general case); named as follow-up, not fixed here. |
| Replay of a task start after its turn ended | Same ids, plain `{sessionId, turnId}` result (never an invented task); `session_status` reads the finished turn. |
| First attempt refused (`isError`) | Memo deleted on rejection, so a retry genuinely retries; the client sees the same error class as today. |
| `key` longer than 64 / not a string | `optStr` → `-32602` (as `session_send` already behaves). |
| UA absent / empty | `ua "-"`. |
| UA with CR, LF, TAB, ESC or non-ASCII | Dropped by the sanitizer; the line stays one printable line ≤ 120 chars. |
| `srv.requestIP` missing or null | `at unknown` — no throw, no missing field. |
| Token presented wrongly | 401 unchanged; the token appears nowhere in the log (nor its length). |
| Bind `0.0.0.0` / `::` / `[::]` | Hint `127.0.0.1` / `[::1]` / `[::1]`, scheme and port kept. |
| Bind a real host (`192.168.1.5`, `localhost`, a name) | Kept verbatim — the hint stays reachable from another machine. |
| TLS serve | `https://…`, unchanged by `hintUrl`. |
| `port: 0`/wildcard for A2A | Untouched (A2A line keeps today's behaviour; D8). |

### Tests

Red first (§9), each named by the property it pins.

- **T1 (red today: mcp-tools.test.ts:519 fails on exact equality)** — `packages/daemon/test/mcp-tools.test.ts`, the rig's real `startWsServer` on loopback `port: 0` (:460-468): after the three 401s, every line starting `mcp-auth-failure` matches `/ at (127\.0\.0\.1|::1|::ffff:127\.0\.0\.1) ua "/`, and the collected audit contains **none** of `"nope"`, `WS_TOKEN`, `MCP_TOKEN`, `"Bearer"` (non-vacuity: the tokens *were* presented, so a "never logged" assertion that passes on an unwired sink is checked by also asserting the address is there).
- **T2 (pure, new `packages/daemon/test/external-peer.test.ts`)** — `sanitizeUserAgent`: `"a\r\nb\x1b[2Jc"` → one line, no CR/LF/ESC; 400 ASCII chars → ≤ 120; `null`/`""` → `-`; a `"` → `'`. `describePeer`: a fake `srv` with `requestIP: () => null` or none → `at unknown ua "…"`.
- **T3** — `packages/daemon/test/mcp-tools.test.ts` (a rig WITHOUT the MCP route): an unauthorized `POST /mcp` logs a line that starts `auth-failure /mcp` **and** names the peer — the property `project-pairing.test.ts:466`'s `startsWith` relies on is asserted in the same test.
- **T4** — `packages/cli/test/serve-mcp-e2e.test.ts` (extends :143-147, imports `mcpAddHint` at :20): `hintUrl("http://0.0.0.0:4001")` → `http://127.0.0.1:4001`; `http://[::]:4001` → `http://[::1]:4001`; `https://0.0.0.0:443` → `https://127.0.0.1:443`; `http://192.168.1.5:4001` and `http://127.0.0.1:4001` unchanged; and `mcpAddHint(hintUrl("http://0.0.0.0:4001"))` contains no `0.0.0.0`.
- **T5 (red: a second session today)** — `packages/daemon/test/mcp-tools.test.ts`: the same `tools/call session_start` posted twice (no `key`) → identical `sessionId` and `turnId`, `attachedSessionIds()` length 1, `session_list` shows one «MCP: …» session, one `mcp-start-replayed` audit line.
- **T6 (non-vacuity of T5)** — same suite: two *different* prompts back to back → two sessions with different ids (proves the fix is not a global dedupe).
- **T7** — same suite, modern era + `io.modelcontextprotocol/tasks` declared: two identical keyed calls → one session **and** the same `taskId`; `tasks/get` on it answers one task.
- **T8** — same suite: same `key`, different `prompt` → `-32602 "key reused with different arguments"`, one session only.
- **T9** — same suite: two identical calls awaited together (`Promise.all`) → one session (single-flight; this is the `:992` case for identical args).

Then the full gate: `bun run check` (typecheck → lint → test), compared with the §6 baseline (all pass except the three opt-in skips), plus the changelog fragment.

## Execution

*— to be written by the executor (DeepSeek), after the plan above is executed.*

## Review

*— to be written by the reviewer (fresh context, standard in-context level for contained/S–M).*
