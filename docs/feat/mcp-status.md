# feat/mcp-status — `/mcp`: list the MCP servers and whether each is reachable

> **Status:** done (Review round 2: APPROVE-WITH-NITS; merged 2026-10-21)
> **Branch:** `feat/mcp-status` (promoted from `docs/eval/mcp-status.md`, 2026-10-21)
> **Type:** feat · **Size:** M · **Blast:** load-bearing (a new wire method: protocol + daemon `Connection` + `RemoteClient`) · **Suited:** mandatory fresh-context Review.

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

*— claude-opus-5-5, 2026-10-21*

### Load-bearing assumption

An unknown request method makes an older peer reply with a clean
`MethodNotFound`. It does not crash the peer or end up as an internal error.
That is what lets the new method ship without a version bump.
`packages/transport/src/peer.ts:322` answers `JsonRpcErrorCode.MethodNotFound`
for any method that isn't in the `RequestSchemas` registry
(`packages/protocol/src/methods.ts:97`). On the daemon, `Connection.onRequest`
is reached only for registered methods (`packages/daemon/src/connection.ts:144-173`).

### Preconditions

- Requests are dispatched concurrently (AGENTS §7, `transport/peer.ts`), so a
  probe of up to 2 s doesn't block `session/enqueue` or
  `session/resolve_permission`.
- The **receiving** peer validates a response's `result` against the
  registry schema (`transport/peer.ts:436-444`). The sender does not: it
  replies as-is (`peer.ts:338-345`). The laptop client is the receiver, so a
  schema bound protects the TUI from a hostile pod daemon. *(Corrected after
  Review F2. This read "the peer validates `result` before replying", which
  was false.)*
- `McpClient` already learns when its transport closes (`client.ts:50,179`),
  and the stdio transport closes when the process exits
  (`transport.ts:120`).
- The worker connects MCP in the background (`worker.ts:69-85`), so at `/mcp`
  time a server may still be connecting. That state must be represented.

### Design

- **`@tentacle/mcp`**
  - `McpClient`:
    - JSON-RPC error responses reject with a new `McpServerError`.
    - A new `get isClosed()` getter.
    - `ping(timeoutMs)` sends MCP `ping`. It resolves on any response; an
      `McpServerError` (for example "method not found") still counts as
      reachable. It rejects on timeout or close.
  - `McpConnection` gains `isOpen()` and `ping(timeoutMs)`.
  - New `status.ts` with `McpStatusTracker(names)`:
    - `settle(result)` and `fail(error)` record the outcome of
      `connectMcpServers`.
    - `probe(timeoutMs = 2000)` returns one `McpServerStatus` per configured
      name, in config order:
      - `connecting`: not settled yet.
      - `failed`: connect error, with the error.
      - `closed`: the process is gone.
      - `connected`: the ping answered, with `latencyMs`.
      - `unresponsive`: the ping timed out or errored, with the error.
    - Each status also carries `tools` (the count). Error texts are cut to one
      line of at most 500 chars, without control characters. Pings run in
      parallel.
- **`@tentacle/protocol`**: new `mcp.ts` with:
  - `McpServerStatusSchema`: `name` ≤ 256 chars and `error` ≤ 1000 chars, both
    with no control characters; `state` is the enum; `tools` is an int ≥ 0;
    `latencyMs` is a number ≥ 0.
  - `McpStatusParamsSchema` (`{}`, strict) and `McpStatusResultSchema`
    (`{ servers }`, at most 256 entries).
  - `Method.McpStatus = "mcp/status"`, registered in `RequestSchemas`.
  - No `PROTOCOL_VERSION` bump: the method is additive.
- **`@tentacle/daemon`**:
  - `SessionHostOptions.mcpStatus?: () => Promise<readonly McpServerStatus[]>`.
  - `SessionHost.mcpStatus()` returns `[]` when that option is absent.
  - `Connection` adds `case Method.McpStatus`.
- **`@tentacle/client`**: `RemoteClient.mcpStatus()`. When the link is down
  (with a factory) it rejects with "not connected". Otherwise it makes a
  watched `call`.
- **`@tentacle/cli`**:
  - `worker.ts` builds the tracker, settles it from `connectMcpServers`, and
    passes `mcpStatus: () => tracker.probe()` to the `SessionHost`.
  - `LocalRuntime` gains `mcpStatus: () => client.mcpStatus()`.
  - `main.ts` passes it to `startTui` on every RPC runtime.
  - The in-process fallback passes a local tracker that is already settled
    with its `mcp` result.
  - `serve` and the pod daemons pass nothing, so they answer `[]`.
- **`@tentacle/tui`**:
  - The `/mcp` entry goes in `SLASH_COMMANDS`.
  - A pure `mcpStatusText(servers)` in `commands.ts` renders a Markdown list.
    It puts every name and error through `oneLine`, has an empty-list message,
    and gives a one-line count summary.
  - `mcpStatusError(error)` maps `MethodNotFound` to "this daemon doesn't
    support /mcp".
  - `StartTuiOptions`/`AppProps` gain `mcpStatus?: () => Promise<readonly McpServerStatus[]>`.
    The `/mcp` handler in `App.tsx` only calls it and pushes the notice. It is
    not session-mutating, so it is allowed mid-turn.

### Files

1. `packages/mcp/src/client.ts`, `connect.ts`, new `status.ts`, `index.ts`
2. `packages/protocol/src/mcp.ts` (new), `methods.ts`, `index.ts`
3. `packages/daemon/src/session-host.ts`, `connection.ts`
4. `packages/client/src/remote-client.ts`
5. `packages/cli/src/worker.ts`, `local-runtime.ts`, `main.ts`
6. `packages/tui/src/commands.ts`, `App.tsx`, `run.tsx`

### Failure modes

| Case | Converges to |
|---|---|
| `/mcp` before the background connect settles | `connecting` rows. A later `/mcp` shows the outcome |
| The whole connect throws | every configured server shows `failed` with that error |
| Server process died after startup | `closed`. No ping is sent |
| Process alive but wedged | ping timeout ⇒ `unresponsive` after ≤ 2 s |
| Server lacks `ping` | it answers `-32601` ⇒ `connected` (it responded) |
| No servers configured / `serve` / pod | `servers: []` ⇒ "No MCP servers on this daemon." |
| Old daemon (no `mcp/status`) | `MethodNotFound` ⇒ "this daemon doesn't support /mcp" |
| Link down | the client rejects fast ⇒ "MCP status unavailable: not connected" |
| Hostile pod: escapes / huge list | schema rejects control characters and over-long input ⇒ error notice. The TUI also sanitises bidi/zero-width characters |
| Probe during a running turn | concurrent handler. No lock, so the turn is unaffected |

### Tests

- `packages/mcp/test/status.test.ts`: each state (connecting, failed, closed,
  connected, unresponsive, ping method-not-found ⇒ connected), config order,
  error sanitising. Uses `McpConnection` fakes. *(Corrected after Review F6.
  "ping method-not-found ⇒ connected" is pinned at the `McpClient` level in
  `client.test.ts`.)*
- `packages/mcp/test/client.test.ts`: `ping` resolves on an error response
  and rejects on timeout.
- `packages/client/test/mcp-status.test.ts`: real `Connection`/`SessionHost`
  over `createChannelPair`:
  - the round trip;
  - `[]` when the host has no provider;
  - `MethodNotFound` from a peer without the method;
  - a hostile result (control characters) rejected by the client.
- `packages/tui/test/commands.test.ts`: `mcpStatusText` (empty list, every
  state, sanitising) and `/mcp` in the catalog.
- `packages/tui/test/app.test.tsx`: typing `/mcp` renders the provider's
  answer, and renders the fallback text when no provider is wired.

Added in round 2 (Review F1–F5):
- `state.test.ts`: a notice is never extended by model text, both mid-turn
  and idle-then-prompt.
- `app.test.tsx`: `/mcp`, then a prompt, with the probe landing mid-reply.
  This test is timing-based; the `state.test.ts` cases pin the same property
  without timing.
- `status.test.ts`: odd config names are made wire-safe.
- `mcp-status.test.ts`: link down rejects with nothing sent, and a hostile
  `error` field is rejected.
- `commands.test.ts`: `/copy` (`lastAssistantText`) skips notices.

Red first: each test is run against the code before its slice lands.

## Execution

*— claude-opus-5-5, 2026-10-21*

The work followed the plan's order: mcp → protocol → daemon/client → tui → cli.
Every slice was shown red before it went green:

- **mcp**: `ping` and `status` tests were red (missing API) before the code
  went in.
- **daemon/client**: the code landed before its test. Non-vacuity was then
  shown by mutation. Removing `case Method.McpStatus` failed the round-trip and
  empty-list tests. Dropping the schema's control-character regex and
  `.max(256)` failed both hostile-daemon tests. Code restored: 6/6 pass.
- **tui**: the `commands.test.ts` additions were red on import. In
  `app.test.tsx`, the 3 `/mcp` tests fail with the handler renamed and pass
  with it restored.
- **cli**: the new `worker.test.ts` case runs a real worker with a real stdio
  MCP server fixture (`test/fixtures/mcp-stdio-server.ts`) plus a missing
  binary. It was red (`runtime.mcpStatus` undefined) before the wiring.

**Drift from Implementation:**

- `packages/cli/src/connect.ts` (`tentacle connect`) also passes
  `mcpStatus: () => client.mcpStatus()`. The Files list missed it: `connect`
  starts the TUI on its own `RemoteClient`, not through `LocalRuntime`.
- The protocol has a committed JSON Schema with a drift gate and a
  per-method fixture gate (`packages/protocol/test/json-schema.test.ts`). I
  regenerated `schema/protocol.json` with `bun run schema:export` and added
  `mcp/status` fixtures. The plan hadn't listed this.
- The tracker reports a configured name that is in neither `connections` nor
  `errors` as `failed: not started`. This is defensive: `connectMcpServers`
  always puts every name in one of the two.

**Gate** (`bun run check`, 2026-10-21): typecheck clean · lint clean (338 files) ·
1471 pass, 2 skip (the opt-in live-k8s and slow-keepalive tests), 0 fail.

### Round 2 — fixing the first Review's findings

*— claude-opus-5-5, 2026-10-21*

- **F1 (required): a command notice merged with the model's streaming text.**
  - Root cause: `pushNotice` appended a plain `assistant` item, and the
    `applyEvent` text case extends the last `assistant` item, whoever wrote it.
  - Fix: `AssistantItem.notice?: true`. `pushNoticeItem` in `state.ts`, which
    is pure and now used by `App.pushNotice`, sets it. `applyEvent` never
    appends to an item that has it, so the next chunk opens a new item.
  - Rendering is unchanged: the item is still Markdown-rendered. The existing
    `notice` kind is plain text, which is why it wasn't reused.
  - This also fixes the pre-existing mid-turn `/model` → `Model: mTAIL` case.
  - Red first: the new `app.test.tsx` case (`/mcp`, then a prompt, with the
    probe landing mid-reply) failed with exactly
    `github — ● connected · 1 tool · 3 msTAIL`. The 2 new `state.test.ts`
    cases failed on the missing export.
  - Mutation check: with the `!last.notice` guard removed, all 3 fail.
- **F3: one odd config name failed the whole result.** The tracker now
  reports names as one line of at most 200 characters, with `(unnamed)` for an
  empty name. A test was added; with the mapping removed it fails.
- **F4: the "not connected" guard was untested.** Added a test where the link
  drops, the redial never lands, and the call rejects at once with nothing
  sent. With the guard removed it fails.
- **F5: no test covered a hostile `error` field.** Added a test that a control
  character in `error` is rejected client-side.
- **F2 and F6 (doc):** the Preconditions and Tests text is corrected above.
- **Left as is (F6 remarks):**
  - The tool count includes tools skipped for a name clash. It is the
    server's own count, so the number is honest about the server.
  - There is no "probing…" placeholder during the ≤2 s probe.
  - Both noted as debt.
- **Gate:** see the Review round 2.
- **After Review round 2:**
  - `lastAssistantText` skips notices, so `/copy` never copies a command's
    output. Shown red first.
  - The remaining round-2 nits are in `TODO.md` under "`/mcp` follow-ups":
    the split reply in `/save` and the live view, a late answer after
    `/clear`, the probing placeholder, the tool-count nuance, and the
    `methods.ts` header.

## Review

*— claude-opus-5-5, 2026-10-21 (fresh context; **same model family as the
executor**, so blind spots we share survive both passes. A load-bearing task
should get a different model for its next Review, AGENTS §10)*

**Verdict: REQUEST-CHANGES.** One finding, F1, is required. F2–F6 are nits or
debt. The wire, daemon, client and security work is sound: every §7 invariant I
attacked holds (see "What holds").

### Findings

1. **(required) An async `/mcp` reply gets spliced into the model's
   streaming reply.** `App.tsx:534-537` pushes the notice whenever the probe
   resolves, which can be up to 2 s later. `pushNotice` (`App.tsx:381-389`)
   adds it as an `{kind:"assistant"}` item. `applyEvent` (`state.ts:191-196`)
   then appends every later `text` delta to the last assistant item, which is
   now the notice. The reply's text gets glued onto the end of the MCP list.
   Reproduced in `.tentacle/tmp/mcp-status-review/`:
   - `/mcp` mid-turn (`midturn.ts`) gives
     `* github — ● connected · 1 tool · 3 msTAIL-OF-REPLY`.
   - Worse, and new to this task: `/mcp` typed while **idle**, then a prompt
     sent before the probe returns (`idle-then-prompt.ts`, probe 120 ms), gives
     the same splice. The notice lands mid-reply.

   The synchronous notices (`/model`, `/tokens`) already have the mid-turn
   variant (`/model` mid-turn gives `Model: mTAIL-OF-REPLY`), so the root bug
   is older than this task. `/mcp` is the first notice that is async, so it can
   hit even when the user did nothing mid-turn. The plan's failure-mode row
   "Probe during a running turn → the turn is unaffected" is true for the
   daemon but false for the display, which the plan didn't consider. Display
   only: persisted history comes from `snapshot`, so it is unaffected.

   Fix: either (a) the root fix, where a notice is a separate item kind (or
   ends the text-merge run), so `applyEvent` never appends to it, with a
   red→green App test covering both the mid-turn and the idle-then-prompt
   triggers; or (b) the narrow fix of rejecting/deferring `/mcp` while a turn
   runs, plus a TODO entry for the root bug. (b) doesn't fully close the
   idle-then-prompt race, so (a) is preferred.
2. **(nit, false premise) "The peer validates `result` … before replying" is
   false.** `peer.ts:338-345` sends the handler's `result` without checking
   it. Only the *receiving* end validates (`peer.ts:436-444`). The
   `methods.ts:1-6` header comment says the same wrong thing, but that comment
   predates this task. The security claim still holds, because the laptop
   client validates whatever a pod sends. The consequence is F3.
3. **(nit) One badly named local server hides every server.** MCP server names
   are not validated (`config/src/schema.ts:105`, open item `TODO.md:253`).
   The tracker passes names through raw (`status.ts:75-90`). A trusted local
   config key that is empty, longer than 256 chars, or contains a tab therefore
   makes the client reject the *whole* result. `/mcp` then shows only
   `MCP status unavailable: invalid result for mcp/status`
   (`badname.ts`: all three cases give `-32603`). It fails loud, which is
   acceptable, but the cause is opaque. Sanitise or bound names daemon-side
   the way `error` already is, or fold this into TODO:253.
4. **(nit, test gap) The "link down → not connected" guard is untested.**
   Deleting `remote-client.ts:279-281` leaves all 150 client tests green
   (mutation M7). The failure-mode table claims this row.
5. **(nit, test gap) No behavioural test for a hostile `error` field.** Dropping
   `.regex(NO_CONTROL)` from `error` (`protocol/src/mcp.ts:35`) is caught only
   by the JSON-Schema drift gate (M2). That gate would be regenerated along
   with any real change. `mcp-status.test.ts` attacks only `name`. Defence in
   depth still holds, because the TUI `oneLine` sanitises errors too.
6. **(nit, doc drift not recorded in Execution)** The plan's Tests section says
   `status.test.ts` "uses in-memory transports as in `connect.test.ts`" and
   covers "ping method-not-found ⇒ connected". Neither is true:
   - The tracker tests use `fakeConnection` doubles.
   - Its "real `connectMcpServers`" test passes `{}`.
   - Method-not-found ⇒ reachable is pinned only at the `McpClient` level
     (`client.test.ts`).

   The `connectServer` wiring of `isOpen`/`ping` is covered end to end only by
   the worker test (connected/failed), not for closed/unresponsive. My e2e
   trace below covers those.

   Also minor: `tools` counts what the server listed, not what was registered
   (`worker.ts:60-67` skips name clashes). There is no "probing…" feedback
   during the up-to-2 s wait.

### Gate (`bun run check`, re-run by me)

typecheck clean · lint clean (`Checked 338 files`, 0 errors/warnings) ·
**1471 pass, 2 skip (opt-in live-k8s + slow keepalive), 0 fail**, 5528
expects, 137 files. Matches Execution.

### Mutations

The tree was byte-identical after every revert: `git diff` plus untracked-file
contents, `shasum 10064fe4…` before and after.

| # | Mutation | Result |
|---|---|---|
| M1 | `ping` rethrows `McpServerError` too | FAIL `client.test` "error response still proves reachable" ✔ |
| M2 | drop `NO_CONTROL` on `error` | only the drift gate fails (F5) |
| M3 | `mcpSafe` = identity | FAIL `commands.test` display-safe ✔ |
| M4 | skip the `isOpen()` check in the tracker | 2 FAIL `status.test` ✔ |
| M5 | worker never calls `tracker.settle` | FAIL `worker.test` /mcp (5 s timeout) ✔ |
| M7 | remove the "not connected" guard | **survives**, 150/150 pass (F4) |

The executor's own mutations (removing the `Connection` case, removing the name
regex and the `.max(256)`) I accept as reported. I did not repeat them.

### Premise table

| Premise | Verdict |
|---|---|
| Context symptom: no `/mcp`, no `mcp/status` on `main` (`git show main:` commands.ts:26-36, methods.ts:36-47) | TRUE |
| `connectMcpServers` connect.ts:84; worker.ts:69; main.ts:547 | TRUE |
| main.ts:593 one-shot | TRUE (through the wrapper `connectConfiguredMcp`) |
| serve.ts:115,231 build a `SessionHost` with no MCP | TRUE |
| local-runtime.ts:323-326 only logs MCP errors | TRUE |
| client.ts:179-188 `handleClose` | TRUE (±2 lines) |
| client.ts:50 hooks transport close | TRUE |
| transport.ts:120 stdio closes on process exit | TRUE (`proc.exited.then(emitClose)`, ~l.116) |
| tool-adapter.ts:59 "MCP call failed" | TRUE |
| peer.ts:322 unknown method → `MethodNotFound` (load-bearing) | TRUE (peer.ts:321-323, before any handler) |
| methods.ts:97 is the `RequestSchemas` registry | FALSE (cosmetic): l.97 is `isNotificationName`, and the registry is ~l.73-86 |
| "the peer validates `result` before replying" | **FALSE** (F2). The receiver-side half is TRUE |
| Requests are dispatched concurrently | TRUE (`peer.ts:309` `void this.handleRequest`) |
| The worker connects MCP in the background | TRUE |

### Attacks tried

1. **Serialising the peer.** I ran a 1 s `mcp/status` and a concurrent
   `session/snapshot` (`concurrent.ts`). The snapshot answered at 0 ms and the
   status at 1005 ms. Holds.
2. **End-to-end through the real path** (`e2e.ts`: real stdio servers →
   `connectMcpServers` → tracker → `SessionHost` → `Connection` →
   `RemoteClient`):
   - before settle: all `connecting`;
   - `ok`: connected, 1 ms;
   - server **without ping**: connected (correct per the MCP spec: any
     JSON-RPC response proves liveness, and an error reply is a reply);
   - wedged: `unresponsive` after 2006 ms total, pings run in parallel;
   - process exited: `closed`, no ping sent;
   - missing binary: `failed` with the `ENOENT` text.

   All as designed. The ping timer is armed before `send`
   (`client.ts` `request`), so a blocked write can't hang the probe. A
   timed-out ping sends `notifications/cancelled`, which the spec allows (only
   `initialize` must not be cancelled).
3. **Hostile pod strings.**
   - A C0/C1 escape in the name, and 257 servers, are rejected client-side
     (tests, M3 for the TUI layer).
   - Bidi and zero-width characters are stripped by the TUI `oneLine`.
   - Backticks are stripped, so a pod can't break out of the name code span.
   - Text after the colon can still carry Markdown emphasis. That is cosmetic
     only: the renderer emits no OSC-8 links (grep found none).

   Holds.
4. **Version skew.** An old daemon goes through `peer.ts:321` →
   `MethodNotFound` → "doesn't support /mcp" (tested with the raw-daemon
   double). An old client never sends the method. No discriminant was added.
   Additive with no bump is correct under the §7 protocol rule.
5. **Liveness watcher on `connect`.** The `mcpStatus` call is watched
   (`remote-client.ts:601-614`), but `LIVENESS_MS` = 15 s (`link-machine.ts:25`)
   is longer than the 2 s probe, so a slow probe can't trigger a false
   reconnect. Holds.
6. **Raw writes while Ink owns the terminal.** No new `stdout`/`stderr` write
   was added. The in-process fallback's `[mcp] … failed` write was already
   there and runs before `startTui`. Holds.
7. **Display during a turn.** Broken (F1).
8. **Daemon-side name bounds.** Broken loud (F3).

### What holds

- One session path: `/mcp` goes over the RPC client on worker, `run`, `attach`
  and `connect` (`main.ts:385,534`, `connect.ts:125`).
- The in-process fallback probes locally. That matches the fallback that
  already exists; it adds no new session path.
- No lock on the handler. Additive versioning.
- Untrusted strings are bounded and validated on the laptop.
- `serve` and pod daemons honestly answer `[]`.
- `McpServerError` is a subclass of `Error` with the same message, so
  `tool-adapter`'s `String(error)` output is unchanged.
- The app logic is in pure functions (`mcpStatusText`, `mcpStatusError`). The
  component only dispatches.

### How the executor behaved

- Followed the plan's order and showed red/green on every slice.
- Recorded two real drifts honestly: `connect.ts`, and the JSON-Schema
  regeneration plus fixtures.
- Gate counts match my re-run exactly.
- Missed points: the display interaction of an async notice (F1), and the false
  "validates before replying" premise (F2).
- Overstated what the tracker tests use (F6).

No inflated claims about results.

### Review round 2

*— claude-opus-5-5, 2026-10-21 (fresh context; **same model family as the
executor and the first reviewer**, so shared blind spots survive all three
passes. This task touches the protocol and a pod-trust boundary, so a
different model for a later pass would still be worth it, AGENTS §10)*

**Verdict: APPROVE-WITH-NITS.** F1–F6 are resolved as claimed, and every new
test is non-vacuous under mutation. The notice split has some leftover rough
edges (R2-1, R2-2). They are display/export only, never persisted, and no
worse than `main`'s own `/model` mid-turn behaviour. Record them as debt; they
don't block the merge.

**F1–F6 verification**

| # | Claim | Verified |
|---|---|---|
| F1 | `notice?: true` (`state.ts:31`), `pushNoticeItem` (`state.ts:196-198`), guard `!last.notice` (`state.ts:205`), `App.pushNotice` uses it (`App.tsx:382-388`) | TRUE. Mutations Ma and Mb below |
| F2 | Preconditions corrected (doc l.105-110) | TRUE. The `methods.ts:1-6` header still has the wrong wording; it predates this task |
| F3 | `displayName` = `oneLine(name, 200) \|\| "(unnamed)"` (`status.ts:45,83`) | TRUE. Every value it returns passes `name: min(1).max(256).regex(NO_CONTROL)` (`protocol/src/mcp.ts:27`). The only loud case left is more than 256 configured servers |
| F4 | test for the guard at `remote-client.ts:279-281` | TRUE (Md) |
| F5 | behavioural test for a hostile `error` | TRUE (Me) |
| F6 | Tests section corrected (doc l.200-204) | TRUE. The tools-count and "probing…" remarks are "noted as debt" only in Execution prose, with no `TODO.md` entry (R2-4) |

**Findings**

1. **(nit/debt) The split reply is still wrong for anything that reads one
   reply as a whole.** Trace (`.tentacle/tmp/mcp-status-review2/split.ts`):
   the reply streams `Here:\n```ts\nconst a = 1;\n`, the notice lands, then
   `const b = 2;\n```\nDone.` arrives.
   - `/copy` (`lastAssistantText`, `commands.ts:291-299`) returns only the
     tail, `"const b = 2;\n```\nDone."`. The fence is broken and the first
     half is lost.
   - `/save` (`transcriptToMarkdown`, `commands.ts:313-336`) writes part 1
     with its fence still open. Any Markdown viewer then shows the notice's
     `## Assistant` heading inside the code block.
   - The live render shows the same inversion: `const b = 2;` renders as
     prose and `Done.` as code.

   This is not a regression. Before the fix the notice was glued into the
   reply, and on `main` a mid-turn `/model` already merges. It only happens
   when a notice lands while text is streaming, and nothing is persisted:
   display items never become `ChatMessage`s (`cli/src` doesn't touch
   `items`, and `resume.ts` only goes messages → items). Cleaner fix for
   later: have `lastAssistantText` skip `notice` items, or hold an async
   notice until the turn's text run ends, or insert it before the streaming
   item.
2. **(nit) A late `/mcp` reply lands in the transcript after `/clear`.** Repro:
   a temporary ink test with a 150 ms probe, then `/clear` 20 ms later. The
   final frame shows only the `MCP servers — 1 of 1 reachable` block. Its
   content is still accurate, because the servers belong to the daemon, not
   the session. Cosmetic only.
3. **(nit) The F1 App test depends on timing** (`app.test.tsx:1190-1222`:
   60 ms probe against a 120 ms model pause). It could flake on a loaded CI
   runner. The two deterministic `state.test.ts:208-229` cases pin the same
   property, so the guarantee doesn't rest on the App test alone.
4. **(nit, doc)** The Tests section doesn't list the round-2 tests (F1 ×3,
   F3, F4, F5). The F6 debt items aren't in `TODO.md`. R2-1 and R2-2 should
   join them there.

**Gate** (`bun run check`, re-run by me): typecheck clean · lint clean
(`Checked 338 files`) · **1477 pass, 2 skip (opt-in live-k8s + slow
keepalive), 0 fail**, 5537 expects, 1479 tests in 137 files. That is
1471 + 6 new tests, which matches the round-2 additions.

**Mutations.** The tree was byte-identical after every revert: `git diff`
plus the contents of untracked files hash to `shasum abedf4e3…` before and
after.

| # | Mutation | Result |
|---|---|---|
| Ma | drop `&& !last.notice` (`state.ts:205`) | 3 FAIL: both `state.test` F1 cases and the `app.test` mid-reply case ✔ |
| Mb | `App.pushNotice` appends a plain `{kind:"assistant"}` (guard kept) | FAIL `app.test` mid-reply ✔ (proves App is wired to `pushNoticeItem`) |
| Mc | `name: displayName(name)` → `name` (`status.ts:83`) | FAIL `status.test` F3 ✔ |
| Md | guard at `remote-client.ts:279` → `if (false)` (line 279 only; l.372 has the same text and was left alone) | FAIL `mcp-status.test` F4 ✔ |
| Me | drop `.regex(NO_CONTROL)` on `error` (`protocol/src/mcp.ts:34`) | FAIL `mcp-status.test` F5 ✔ |

**Attacks tried**

1. **Every reader of `assistant` items** (`rg '"assistant"'`):
   - `render-lines.ts:359` ignores the flag, so the notice still renders as
     Markdown. OK.
   - `lastAssistantText` and `transcriptToMarkdown`: R2-1.
   - `resume.ts:21` never sets the flag. OK.
   - `failTurn` (`state.ts:159`) and `WELCOME` (`App.tsx:203`) stay plain.
     They can't be merged into anyway, because a user item always comes
     before the next text.
   - The row cache (`render-lines.ts:422`) is keyed by item identity, and a
     notice is a fresh object. OK.
   - The existing `toEqual` assertions on plain items stay green, because
     `notice` is optional and absent on model text.
2. **Persistence.** Notices never reach a `ChatMessage`: the main thread
   persists from the daemon `snapshot`, not from `items`. Holds.
3. **Split reply inside a code fence**: broken for copy, save and render
   (R2-1).
4. **Late async notice after `/clear`**: R2-2.
5. **F3 bounds against the wire schema.** `oneLine` collapses C0, DEL, C1 and
   all `\s` and slices to 200 UTF-16 units. An empty name becomes
   `(unnamed)`. Every output satisfies the schema. Two names that differ only
   in whitespace now display identically, which is cosmetic, since the
   schema doesn't require unique names. Holds.

**Process note.** The `/clear` repro needed Ink's workspace resolution, so it
ran as a temporary file in `packages/tui/test/` instead of `.tentacle/tmp/`. I
deleted it right after the run and confirmed the tree hash was unchanged.

**How the executor behaved.** It fixed the root cause (option (a)), not the
narrower option (b). It showed red before green, and its mutation claims
reproduce exactly. It made no inflated claims. It understated one thing:
"noted as debt" has no `TODO.md` backing.
