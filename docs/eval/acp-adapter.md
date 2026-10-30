# eval/acp-adapter — Make tentacle usable from ACP editors (Zed) via a `tentacle acp` adapter

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** M (v1, upper end) · **Blast:** load-bearing (the permission path and the single broker, stdout-is-the-channel, a new runtime dependency) · **Suited:** strong model executes; mandatory fresh-context Review.

## Context

*— claude-opus-5-5, 2026-10-30 (refresh)*

Every `file:line` below was re-read at commit `a4ddda0` (protocol 14). ACP facts
come from the schema shipped in `@agentclientprotocol/sdk@2.1.0`
(`schema/v1/schema.json`, ACP v1), not from memory. The public web was not
reachable from this session (WebSearch/WebFetch not granted), and nothing here
was run against a real Zed: see *Review — refresh*.

**The question being decided:** should tentacle speak the Agent Client
Protocol (ACP) so editors like Zed can drive it as an external agent, and if
yes, *how*: change the internal wire to ACP, or add an ACP adapter in front of
the existing runtime? What does it cost, and where can it break?

### Why

Zed launches an external agent as a subprocess and talks JSON-RPC 2.0 over
stdio, newline-delimited. Today the only way to use tentacle with Zed is the TUI
in Zed's integrated terminal: no agent panel, no follow-along, no native
permission prompts, no diff review.

### What changed since 2026-10-19

| 19/10 claim | Today | Effect |
|---|---|---|
| Risk 2: `toolCallId` lost on the client | **Still lost, later in the path.** The wire carries it (`protocol/src/permission.ts:57`, set at `daemon/src/hosted-session.ts:509-512`). `core/src/permission.ts:79` is the daemon-side gate → requester field. The client drops it: `toPermissionRequest` (`client/src/permission-router.ts:62-71`), the `prompt` action (`:218-233`) and the broker call (`client/src/remote-client.ts:1869-1874`) pass only `signal`, `turnId`, `agent` | Not solved. Small fix, and it needs `sessionId` too (risk 2) |
| Wire schemas are `.strict()`, ACP fields rejected | False since v10: strip schemas | Pointing Zed at `serve --stdio` now fails on the version check (`daemon/src/connection.ts:321`: ACP `1` vs `14`) |
| `session/new {cwd?, messages?, sessionId?}` | Replaced by `session/open` (`protocol/src/session.ts:425`) | Sessions belong to the daemon |
| `session/request_permission` is reshaped 1:1 | Permissions are session events: `permission_request` + `session/resolve_permission`, first answer wins, no timeout (`protocol/src/permission.ts:54,87`; ADR-004, `ARCHITECTURE.md:70-74`) | The adapter is a broker requester; it never sees the wire |
| §7 "additive; version stays 1" as a reason against Option A | Pre-public: breaking is allowed with a bump | Option A's rejection needs a different reason |
| `@agentclientprotocol/sdk`: `AgentSideConnection` | **Removed** in SDK 2.x (0 hits in `dist/v1`): `agent()` + `onRequest(methods…)` + `connect(stream)` | Spike A uses the new API. Pin exact |
| SDK cost unknown | Peer `zod ^3.25.76 \|\| ^4`, imports `zod/v4`. The repo pins `3.23.8` in 9 packages | **New blocker for the naive install** (Spike A) |
| Worker stderr "must be routed, not inherited onto stdout" | The worker is a thread (`cli/src/local-runtime.ts:438`), not a child process | Replaced by the real stdout list (risk 3) |
| First-run scaffold can pollute stdout | File writes only (`config/src/load.ts:417-425`) | Struck |
| Diffs need new wire fields | A unified patch and path already ride `tool_call_update` (`daemon/src/mapping.ts:182-188`) | v2 is adapter-only for after-the-fact diffs (risk 5) |
| Images are "an additive `ContentBlock[]` overload" | The daemon refuses non-text (`daemon/src/mapping.ts:128`); `ChatMessage.content` is a string (`protocol/src/session.ts:34`) | Blocked on `docs/eval/attachments.md`, not an adapter task |

### Evidence: tentacle is ACP-*shaped*, not ACP-*compatible*

ADR-004 (`ARCHITECTURE.md:65-74`) modelled the semantics on ACP, with one
deliberate departure: a permission is session state. There is no `acp`
subcommand: `tentacle acp` today is a **one-shot prompt with the word "acp"**
(`cli/src/flags.ts:522-546`).

| ACP v1 (SDK 2.1.0 schema) | tentacle today | Gap for the adapter |
|---|---|---|
| `initialize {protocolVersion, clientCapabilities?, clientInfo?}` → `{protocolVersion, agentCapabilities?, authMethods?, agentInfo?}` | Same names, different content (`session.ts:53-103,152`); version 14 | The adapter answers itself |
| `session/new {cwd, mcpServers}` (both required) → `{sessionId}` | `session/open`; a client `cwd` is **not honoured** (`daemon/src/session-host.ts:5-7,771`) | Risk 8 |
| `session/prompt {sessionId, prompt: ContentBlock[]}` → `{stopReason}` **at turn end** | Acks at once; the end is `turn_end` (`session.ts:168,218`) | `RemoteSession.send` already hides this: the generator ends with the turn (`client/src/remote-session.ts:1206-1224`) |
| stopReason `end_turn \| max_tokens \| max_turn_requests \| refusal \| cancelled` | `… max_iterations \| error` (`session.ts:182`) | `error` is a rejected generator → JSON-RPC error. `max_tokens` is unreachable: the client folds it to `end_turn` (`client/src/mapping.ts:71-82`). Harmless |
| `session/update {sessionId, update:{sessionUpdate}}`; `tool_call {toolCallId, title, kind?, status?, content?, locations?, rawInput?}` | `type` discriminant (`updates.ts:213`), `tool_call` is `title,status,rawInput` (`updates.ts:40`). The adapter consumes `SessionEvent`s (`client/src/mapping.ts:29`), not wire updates | `kind`/`locations` derived from tool name + arguments |
| `plan` (entries need `priority`) | `PlanSchema` exists; the daemon never emits it (`eventToUpdate`, `daemon/src/mapping.ts:209`) | Dropped from v1 |
| `session/request_permission {sessionId, toolCall, options}` → `{outcome: cancelled \| selected}` | Broker requester with no `sessionId`, no `toolCallId`, no options | Risk 2 |
| `session/cancel` | Same, optional `turnId` (`session.ts:226`) | `AbortSignal` on `send` (`remote-session.ts:745-749`) |
| `available_commands_update`, `session_info_update`, `usage_update`, `notice`, `compaction_update` | Skills (`session/skills`), `session_title`, `agent_usage`, notices, `history_replaced` | **New helpers.** All stable in ACP v1. `/name` maps to `send(…, {skill})` (`remote-session.ts:517`) |
| `session/load`, `session/list`, `session/resume`, `session/close`, `session/delete` (capabilities) | `session/list`, `session/open{since,reopen}`, `session/snapshot`, `session/close`, `session/delete` (`session.ts:425,466,508,667`) | **New helpers** for v2 (see phasing) |
| `$/cancel_request` (SDK `cancellationSignal`) | Router `abort` (`permission-router.ts:116-118`) | Withdraws an open dialog, if Zed honours it |

### Option A: make the internal wire ACP (rejected)

Breaking is allowed now, so the reason changed. ACP has no answer for
`model/stream`, snapshots, multi-client attach or `seq` replay. And ACP's
permission is a request bound to one connection, which is exactly what
permission events replaced to survive detach and restart (ADR-004). Adopting ACP
would undo that design, or leave ACP plus extensions after a full migration.

### Option B: an ACP adapter as a new frontend (recommended)

`tentacle acp` is a **frontend**, a peer of the TUI. It is an ACP agent on
stdin/stdout on one side and an ordinary `RemoteClient` on the other, through
`createLocalRuntime` (`cli/src/local-runtime.ts:293`). No daemon or protocol
change, so no `PROTOCOL_VERSION` bump.

```
Zed ──ACP/stdio──▶ tentacle acp ── acp-map (pure) ──▶ RemoteClient ──RPC──▶ worker daemon (agent loop, tools)
                      ▲                                    │
                      └──── single PermissionBroker ◀──────┘
```

- **One session path.** Agent loop and tools stay daemon-side; `SessionController.send`
  is reused, not copied.
- **Logic in pure modules.** Translation lives in one React-free, table-driven
  `acp-map.ts`; the `cli` file only wires.
- **Persistence on main.** `persistingController` (`local-runtime.ts:136`) saves
  after each turn into the same JSON store.
- **Dispatch before config.** `acp` branches next to `connect`/`update`
  (`cli/src/main.ts:331,374`), before `loadConfig` (`:402`), because `cwd` is only
  known at `session/new` (risk 8), and a config error must become a JSON-RPC
  error, not stdout text and exit 1 (`:408`).

**Editor-facing side.** Recommendation: the official SDK, pinned exact, stable
entrypoint only, on the two-zod layout (decision D1). Spike A proved it works in a
Bun-compiled binary. In-house remains viable: ACP v1 stable is small, `RpcPeer`
plus `streamChannel` (`transport/src/stream-channel.ts:28`) already frame it, and
it avoids zod entirely; but we would own schema drift across ~180 definitions.

### Spike A — the SDK in a compiled binary: PASS, with a zod condition

Bun 1.4.3, macOS, `@agentclientprotocol/sdk@2.1.0` (exact), in
`.tentacle/tmp/acp-adapter/`. A raw-JSON driver (no SDK on its side) drove each
**compiled binary** over stdio, with an unknown capability field, a cancel with
no turn, and an unknown method.

| Layout | Build | Handshake | Binary |
|---|---|---|---|
| empty baseline | ok | — | 70 862 450 B |
| SDK + zod 4.6.7 (`spike/`) | ok, 108 modules | **ok** | 71 143 154 B (+0.27 MiB) |
| SDK + **zod 3.23.8, the repo's pin** (`spike-zod323/`) | **FAIL**: `Could not resolve: "zod/v4"` | — | — |
| SDK + zod 3.25.76, the SDK's minimum (`spike-zod323/`) | ok, 77 modules | **ok** | 71 060 594 B |
| Workspace: `proto` on zod 3.23.8, `cli` on SDK + zod 4.6.7, both used (`spike-ws/`) | ok, 110 modules | **ok** | not measured |

Output for the zod 4.6.7 binary (the other two differ only in ids, timing and this spike's stderr line):

```
-> {"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true,"zedFuture":1},"clientInfo":{"name":"spike-driver","version":"0"}}}
<- {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false},"authMethods":[]}}
-> {"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"…/main-docs","mcpServers":[]}}
<- {"jsonrpc":"2.0","id":1,"result":{"sessionId":"3b2d72c5-…"}}
-> {"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"3b2d72c5-…","prompt":[{"type":"text","text":"hello from the driver"}]}}
<- {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"3b2d72c5-…","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"echo: hello from the driver"}}}}
<- {"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}
-> {"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"3b2d72c5-…"}}
-> {"jsonrpc":"2.0","id":3,"method":"session/nope","params":{}}
<- {"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"\"Method not found\": session/nope","data":{"method":"session/nope"}}}
{"ok":true,"exit":0,"initMs":784,"stderr":"[spike-agent] up, bun 1.4.3"}
```

`initMs` was 769–821 on a binary's first launch and 50 on the one repeated run.

Limits: the spike is not the real `tentacle` binary (no worker thread, no Ink, no
`scripts/build.ts`), and `cli`'s zod-free source is taken from a grep (0
`from "zod"` in `packages/cli`). The workspace layout is a simulation of ours.

### The risks (where it can break)

1. **Single-broker invariant (§7, load-bearing).** The requester goes on the one
   broker given to `createLocalRuntime`. Built with `holdUntilSet`
   (`core/src/permission.ts:124-127`), a wiring mistake now **hangs** instead of
   auto-approving; the daemon-side broker is always replaced
   (`daemon/src/hosted-session.ts:425`). The silent-approve hazard moved to the
   **worker fallback**: `startWorkerRuntime` returns null on failure
   (`local-runtime.ts:418-422`), and the in-process path uses a default `allowAll`
   broker (`cli/src/wiring.ts:461`). `acp` must fail loudly and never fall back.
   It still needs the separate-daemon-side-spy test (`cli/test/engine-runtime.test.ts:214`).
2. **The requester lacks what ACP requires.** `sessionId` and `toolCall.toolCallId`
   are required by ACP, and neither reaches the broker. Fix: carry both from
   `RouterAction` into `PermissionRequestOptions` (about 6 lines in `client`, a
   comment in `core`, no wire change). Also:
   - The options are dropped too: the adapter offers the fixed set and maps the
     answer through `PermissionResponse`. `permissionOptions` lives in the daemon
     (`daemon/src/permission-map.ts:20`); reuse it, don't copy the labels.
   - `toolCallId` is the literal `"pending"` when absent (`hosted-session.ts:512`),
     and for a sub-agent it is the **parent** `agent_task` call. Zed's handling of
     both is unverified (Spike B: `orphan`, `parent`).
   - The router shows one prompt at a time across sessions
     (`permission-router.ts:8`): a second Zed thread's ask waits for the first.
   - ACP outcome `cancelled` → return `DISMISSED`, which sends nothing
     (`permission-router.ts:131`). A request has no timeout (`protocol/src/permission.ts:8`),
     so if Zed answers `cancelled` without `session/cancel`, the adapter must also
     abort the turn, or it stays suspended forever.
   - The prompt's `input` is `{}` on the client (`permission-router.ts:68`): the ACP
     prompt relies on the announced `tool_call` for arguments.
3. **stdout is the protocol channel.** What really writes there on the `acp` path:
   `main.ts:282` (bad `--profile`), `:324` (bad flags), `:408` (config error), and
   `startWorkerRuntime`'s `log`, which the TUI passes as `write` (`:953`) and which
   carries MCP failures (`local-runtime.ts:458`). Dispatching before config removes
   `:408`; the others need `writeErr`. Clean, verified: no `console.log` outside
   the schema exporter, hooks log to a file (`worker.ts:114`), shell children get
   `stdin: "ignore"` (`exec/src/host-execution.ts:162`), so they cannot eat frames
   from the ACP stdin. `apiKeyCommand` is piped (`config/src/load.ts:382`).
4. **Prompt content.** `RemoteClient.prompt` takes a string (`remote-client.ts:804-814`).
   v1 flattens text, embedded `resource` and `resource_link` (as a path reference).
   Advertise `promptCapabilities {image: false, audio: false, embeddedContext: true}`;
   a block that cannot be flattened is an error, never dropped, matching
   `assertTextOnly`'s rule.
5. **Diffs.** After the run, a unified patch + path is available. ACP wants
   `{path (absolute), oldText?, newText}`, so the adapter must rebuild the two
   sides from the patch's hunks (partial text; Zed's rendering of that is
   unverified, `diff`). Before the run, at the permission prompt, nothing exists:
   showing the diff *in the prompt* would need the tool to compute it first, a
   daemon change. v1 ships without diffs.
6. **Unsaved editor buffers.** Unchanged: tools use the host filesystem, not ACP
   `fs/*`. Routing through `fs/*` is a daemon→client effect
   (`docs/eval/remote-execution-model.md`), out of scope.
7. **Concurrency.** Our peer dispatches concurrently (`transport/src/peer.ts:322`).
   The adapter adds no lock. A prompt during a turn is refused by the daemon
   (`TurnInProgress`, `hosted-session.ts:999`). Whether Zed sends one (cancel-then-prompt,
   or queueing) is unverified (`slow`). Steering is not offered in v1.
8. **`cwd` (new, the most likely silent bug).** `loadConfig` uses `process.cwd()`
   and the host ignores any client `cwd`. If Zed launches the agent elsewhere than
   `session/new.cwd`, tentacle works **in the wrong folder without saying so**.
   v1: load config and start the worker lazily at the first `session/new`, from its
   `cwd`; a later session with another `cwd` is a loud JSON-RPC error (decision D3).
   `initialize` must answer before that.
9. **Project hooks (new).** `hooks/trust` goes through the broker with
   `kind: "hooks_trust"`, no session and no tool call, and needs "never" semantics
   (`cli/src/hooks-trust.ts:49-63,185-195`). `interactive: true` is hard-coded for
   the TUI (`local-runtime.ts:300`). v1: make it a dep and pass `false`, so a repo's
   hooks run in Zed only if already trusted in the TUI (decision D2).
10. **Dependency churn (new).** The API the 19/10 eval named no longer exists.
    Pin exact, import the stable entrypoint only, keep the SDK behind one file.

### Proposed phasing (re-assessed)

| Phase | Scope | Size · Blast |
|---|---|---|
| **v1** | `tentacle acp` on the local worker. Pure `acp-map` (initialize, new, prompt with flattening, `SessionEvent` → updates incl. `kind`/`locations`, `tool_progress` as title updates, `session_info_update`, `available_commands_update`, stop reasons, permission reshape); lazy start from `cwd`; no fallback; stderr-only diagnostics; `sessionId`/`toolCallId` plumbing; `interactive` dep | **M (upper) · load-bearing** |
| v2a | `session/list` + `session/load` from the laptop store (replay `ChatMessage`s as updates). Needs `createSession` to take a record per call: today `seed` is one-shot (`local-runtime.ts:329-333`) | S–M · cross-module |
| v2b | After-the-fact diffs from the patch | S · contained |
| v2c | `mcpServers` from the editor. Harder than 19/10 assumed: MCP connects once per worker at bootstrap (`cli/src/worker.ts:75`), but ACP gives servers per session | M · cross-module |
| v2d | `tentacle acp --connect ws://…` to a `serve` daemon. **The best new fit:** sessions outlive Zed, `session/list` → ACP list, `session/open{since}` + snapshot → load/resume, permissions answerable from another device (`$/cancel_request` withdraws the dialog). `connect.ts` has its own runtime, not `createLocalRuntime`, so the adapter must target `SessionController`, not `LocalRuntime` | M · load-bearing |
| v3 | `tentacle acp` over a pod. **Was S; now M.** `attach` benefits from detach S1 (the resident daemon survives Zed closing), but the setup is written for a terminal: confirmations need a TTY (`main.ts:758`), and pod text shown in Zed must pass `untrustedText` (§7 "a pod is not trusted") | M · load-bearing |
| blocked | Images: depends on `docs/eval/attachments.md` | — |

v1 estimate: 600–800 lines plus tests (19/10 said 400–600). `packages/cli` holds
most of it, with a few lines in `client`, `core` and `flags.ts`, plus
`package.json` and `bun.lock`. Still nothing in the agent loop, the daemon or
`@tentacle/protocol`. An estimate, not a measurement.

Note the adapter must be written against `SessionController`, so v2d stays cheap.
`dispose` closes sessions (`local-runtime.ts:376-383`): on the worker, closing Zed
ends the run, as quitting the TUI does. A save in progress gets up to 3 s
(`FLUSH_ON_EXIT_TIMEOUT_MS`).

### Tests v1 would need (sketch, for Implementation when promoted)

- Table tests per direction, against fixtures from the Spike B capture, including
  unknown ACP fields.
- End-to-end over a fake stdio pair: initialize → new → prompt streaming → tool
  call → permission round-trip → `end_turn`; cancel mid-turn → `cancelled`;
  `cancelled` outcome with no `session/cancel` → the turn ends; a turn error →
  JSON-RPC error.
- Permission: two sessions, each ask carries its own `sessionId` and announced
  `toolCallId`; a sub-agent ask; an absent id.
- Single-broker regression with a separate daemon-side spy, mutation-checked.
- Worker start failure → loud error and **no** in-process fallback (mutation-checked).
- `cwd`: the session runs in `session/new.cwd`, not `process.cwd()`; a second `cwd`
  is refused.
- "stdout carries only valid ACP frames" across startup, bad flags, a bad config
  and an MCP failure.
- The compiled binary handshakes (the real `scripts/build.ts` output, not the spike).

### To run with the owner (Spike B — real Zed exchange)

Prepared, **not run**: no Zed config was edited and Zed was not launched. The agent
was smoke-tested without Zed (`smoke-capture.ts`: all scenarios end as expected,
frames recorded; `withdraw` was added afterwards and only parse-checked).

Files, under `.tentacle/tmp/acp-adapter/` (gitignored, so paste what matters here):
`capture-agent.ts`, a dependency-free ACP agent that logs every frame with
timestamps, plus argv and launch `cwd`, to `zed-capture.jsonl`.

1. Paste into Zed's `settings.json` (also in `zed-settings-snippet.jsonc`):
   ```jsonc
   "agent_servers": {
     "Tentacle capture": {
       "type": "custom",
       "command": "/Users/gmeghnag/.bun/bin/bun",
       "args": ["run", "/Users/gmeghnag/tentacle/.tentacle/tmp/acp-adapter/capture-agent.ts"],
       "env": {}
     }
   }
   ```
   `"type": "custom"` is from memory of Zed's docs (web unavailable here). If Zed
   rejects it, remove that line. `command` is absolute because Zed's `PATH` may not
   include `~/.bun/bin`.
2. Open a project that is **not** the tentacle repo. In the agent panel start a
   thread with "Tentacle capture".
3. Send these prompts, one at a time, and note what you see:

   | Prompt | Question it answers (UI, not in the log) |
   |---|---|
   | `hello` | Does a chunk render? |
   | `@`-mention a file + any text | Is it `resource` or `resource_link`? (in the log) |
   | `match` (Allow once, then again with Allow always) | Is the prompt attached to the tool call? Does Zed auto-answer the second time? |
   | `orphan` | Prompt for an unannounced id: shown, error, or lost? |
   | `parent` | Does the permission title overwrite the tool call's? |
   | `trust` | Does a synthetic call read acceptably? |
   | `withdraw` | Does the dialog close after 5 s? |
   | `diff` | How is the diff rendered? (`capture.txt` need not exist) |
   | `slow`, press stop | Are `session/cancel` and the end clean? |
   | `slow`, then send another prompt | Cancel-then-prompt, queued, or a concurrent prompt? |
   | `fail` | How is a turn error shown? |
   | type `/` | Is `capture-check` listed? |

4. Open a second thread, then a second window on another project, and send `hello`
   in each. Does Zed reuse one process? (`launch` lines and `cwd` vs `session/new.cwd`, risk 8.)
5. Close the thread, then restart Zed. Note what is sent (`eof`, anything else).
6. Remove the snippet. Hand back `zed-capture.jsonl` with your notes, and the Zed
   version. It holds whatever you typed and @-mentioned: use a throwaway project.

## Implementation

*(empty until promoted to `feat/acp-adapter`)*

## Execution

*(empty until promoted)*

## Review — refresh

*— claude-opus-5-5, 2026-10-30 (refresh)*

Fresh-context *style* only: the same agent wrote the refresh, so it is not an
independent Review. A real fresh-context Review stays mandatory before promotion
(§10, load-bearing).

**Verdict (proposed, owner decides): go-after-Spike-B.** Reject Option A. Option B
v1 is promoted once the capture is back and D1–D4 are decided, and no other code
task is open (§10). No-go if Spike B shows that Zed cannot tie permissions to tool
calls or needs an ACP feature outside the stable v1 surface.

**What holds:** the shape of Option B survived a heavy refactor, and protocol 14
helps it (a broker requester, session events hidden behind `SessionController`).
The SDK runs in a compiled binary. No daemon or wire change is needed for v1.

**What did not hold:** risk 2 is not solved (the premise of this refresh was wrong
end to end); the naive SDK install fails the build; v3 is not S; images are not an
adapter task; `session/new.cwd` was missed entirely in the first pass and is the
likeliest silent failure.

**Still unverified, and how:**
- All Zed behaviour: the Spike B table, plus the `agent_servers` format.
- That zod 4 beside 3.23.8 works in *our* workspace: `bun add` in the branch, then
  `bun run check` and the real compile. Only simulated so far.
- The SDK in the real binary with the worker thread and Ink: first Implementation
  step, a `tentacle acp` handshake from the compiled output.
- Whether the 2.1.0 schema matches what the owner's Zed speaks: the capture.
- Whether SDK releases keep churning: the changelog was not reachable. Pin exact.
- The v1 size: an estimate from reading, not a prototype.

### Owner decisions

- **D1 — how to take the SDK.** (a) SDK + zod 4 in `packages/cli` only, two zods in
  the binary (+~0.3 MiB; 9 packages untouched). (b) Bump all 9 packages to zod
  3.25.76: one copy, but it touches the protocol schemas and their exporter for a
  feature that does not need it. (c) In-house ACP on `RpcPeer`: no dependency, we
  own the drift. **Recommendation: (a)**; fall back to (c) if the workspace check
  fails.
- **D2 — project hooks in Zed.** (a) Non-interactive: run only if already trusted
  in the TUI, and say so. (b) Ask in Zed through a synthetic tool call: complete,
  but it needs "never" semantics and a session to attach to. **Recommendation: (a)**
  for v1. Safe by default and a few lines.
- **D3 — several projects per process.** (a) The first `session/new` fixes `cwd`;
  another is a loud error. (b) One worker per `cwd`. **Recommendation: (a)**, then
  revisit with the capture: if Zed starts one process per project, (a) is enough for
  good.
- **D4 — order.** (a) After the detach series, as the next code task. (b) Before it,
  interrupting. (c) Park it. **Recommendation: (a)**: §10 allows one code task, and
  v2d and v3 get better as detach lands. Spike B can run any time, as it touches no code.
- **D5 — v2d (`--connect`) priority.** It is the feature that makes Zed more than a
  panel (runs that outlive the editor). **Recommendation:** decide after v1 ships,
  but keep v1 on `SessionController` so nothing has to be redone.
