# eval/acp-adapter — Make tentacle usable from ACP editors (Zed) via a `tentacle acp` adapter

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** M (v1) · **Blast:** load-bearing (single-broker invariant, stdout-is-the-channel) · **Suited:** strong model executes; mandatory fresh-context Review.

## Context

*— claude-opus-5-5, 2026-10-19*

**The question being decided:** should tentacle speak the Agent Client
Protocol (ACP) so editors like Zed can drive it as an external agent, and if
yes, *how*: change the internal wire to ACP, or add an ACP adapter in front of
the existing runtime? What does it cost, and where can it break?

### Why

Zed (and other ACP clients) launch an external agent as a subprocess and talk
JSON-RPC 2.0 over stdio, newline-delimited. The user registers it in Zed's
`settings.json`:

```jsonc
"agent_servers": {
  "Tentacle": { "command": "tentacle", "args": ["acp"] }
}
```

Today the only way to use tentacle with Zed is to run the TUI in Zed's
integrated terminal. That works, but there is no editor integration: no agent
panel, no follow-along, no native permission prompts, no diff review.

### Evidence: tentacle is ACP-*shaped*, not ACP-*compatible*

ADR-004 (`ARCHITECTURE.md:65`) made the transport ours (WS, multi-client) and
modelled the *semantics* 1:1 on ACP "so an ACP adapter (editors) … [is] cheap to
add later". The adapter was never built: there is no `acp` subcommand (the
dispatch in `packages/cli/src/main.ts` handles `connect`:153, `serve`:187,
`run`:326 and `attach`:373). The schemas differ on the wire. If Zed is pointed
at `serve --stdio`, it fails during the handshake.

| ACP (what Zed sends/expects) | tentacle wire today | Gap |
|---|---|---|
| `initialize {protocolVersion:1, clientCapabilities:{fs,terminal}}` → `{protocolVersion, agentCapabilities:{loadSession, promptCapabilities, mcpCapabilities}, authMethods}` | `clientCapabilities:{streaming}` / `agentCapabilities:{tools,permissions}`, both `.strict()` (`protocol/src/session.ts`) | different shapes; strict schemas reject ACP's fields |
| `session/new {cwd, mcpServers}` | `{cwd?, messages?, sessionId?}` `.strict()` | `mcpServers` rejected |
| `session/prompt {sessionId, prompt: ContentBlock[]}` | `{sessionId, content: ContentBlock[]}` (`session.ts:94`) | field name; ACP also has `resource_link`, `audio` blocks and a nested `resource:{uri,text}` |
| stopReason `end_turn \| max_tokens \| max_turn_requests \| refusal \| cancelled` | `… max_iterations \| error` (`session.ts:99`) | `max_iterations`→`max_turn_requests`; `error` → JSON-RPC error |
| `session/update {sessionId, update:{sessionUpdate: …}}` | discriminant `type` (`protocol/src/updates.ts:79`) | rename. ACP `tool_call` has `kind`, `locations`, `content: ToolCallContent[]` (`{type:"content"\|"diff"\|"terminal"}`); ours is `title,status,rawInput` (`updates.ts:30`). ACP plan entries require `priority` |
| `session/request_permission {sessionId, toolCall:{toolCallId,…}, options}` | flat `{sessionId, toolCallId, title, explanation?, options}` (`protocol/src/permission.ts:30`) | reshape; option kinds identical |
| `session/cancel` | identical | none |
| — | `session/compact`, `session/snapshot`, `model/stream(Chunked)`, `agent_usage`, `background_exit`, `seq` | tentacle-only; ACP allows `_meta` / `_`-prefixed extensions |

### Option A: make the internal wire ACP (rejected)

Rename the discriminants and fields in `@tentacle/protocol` itself.

- Breaks every existing peer: the pod binary (`serve --stdio`), `connect`, the
  worker. This violates §7 "protocol changes are additive; version stays 1".
- It still would not be enough, because ACP has no answer for our extensions
  (`model/stream` for the pod reverse-tunnel, `snapshot` for laptop-side
  persistence, multi-client WS). We would end up with ACP plus extensions
  anyway, after paying for a breaking migration.

### Option B: an ACP adapter as a new frontend (recommended)

`tentacle acp` is a **frontend**, a peer of the TUI. It does not add a second
session path. On one side it is an ACP agent on stdin/stdout facing the editor.
On the other it is an ordinary `RemoteClient` driving the existing worker
daemon through `createLocalRuntime` (`packages/cli/src/local-runtime.ts:112`).

```
Zed ──ACP/stdio──▶ tentacle acp ── acp-map (pure) ──▶ RemoteClient ──RPC──▶ worker daemon (agent loop, tools)
                      ▲                                    │
                      └──── single PermissionBroker ◀──────┘
```

Why this satisfies §7 without bending it:
- **One session path.** The agent loop and tools stay daemon-side. The adapter
  only translates, so the send/stream logic is not copied.
- **Logic in pure modules.** All translation (both directions, plus stop
  reasons, tool `kind`/`locations` derivation and prompt flattening) lives in one
  React-free, table-driven module with unit tests. The `cli` file only does
  wiring.
- **Persistence on main.** `persistingController` (`local-runtime.ts:65`)
  already snapshots after each turn, so ACP sessions land in the same JSON store.
- **Pod mode later for free.** `run`/`attach` already hand `createLocalRuntime`
  a `DuplexChannel`, so `tentacle acp --pod …` is a transport choice and not a
  new path.

Transport: our `streamChannel` (`packages/transport/src/stream-channel.ts:28`)
is already newline-delimited JSON-RPC over stdio, which is ACP's framing. Two
ways to build the editor-facing side:
1. **The official SDK, `@agentclientprotocol/sdk`** (`AgentSideConnection` +
   `ndJsonStream`). It ships Zod-validated ACP types and tracks spec changes,
   at the cost of a new dependency (to be vetted: version, bundle into the
   compiled binary, Bun compatibility).
2. **In-house**: ACP Zod schemas in the adapter module plus our `RpcPeer`. No
   dependency, but we own spec drift.
   Recommendation: (1), unless it fails the Bun compiled-binary check.

### The risks (where it can break)

1. **Single-broker invariant (§7, load-bearing).** The adapter must install its
   ACP requester on the *one* `PermissionBroker` handed to `createLocalRuntime`.
   A second instance silently auto-approves everything (`allowAll`). This needs
   the same separate-daemon-side-spy regression test that `runPodTui` has.
2. **`toolCallId` is lost on the client side.** The daemon sends it
   (`daemon/src/permission-map.ts:28`), but `RemoteClient.onPermission`
   (`packages/client/src/remote-client.ts:310`) builds a core
   `PermissionRequest` (`core/src/permission.ts:15`) with no field for it.
   ACP's `request_permission.toolCall.toolCallId` must match the announced
   `tool_call` for Zed to attach the prompt to it. Fix: an optional
   `toolCallId?` on `PermissionRequest`, populated in `onPermission`. This is
   additive and does not change the wire.
3. **stdout is the protocol channel.** Any stray stdout write corrupts the ACP
   stream. Today `main.ts` writes config errors via `write` (stdout by default,
   `main.ts:127`), and config load scaffolds on first run (`main.ts:180`). In
   `acp` mode, every diagnostic must go to stderr, and the worker's stderr must be
   routed (not inherited onto stdout). Same rule as the existing `serve --stdio`
   (`packages/cli/src/serve.ts:51`).
4. **Prompt content.** `RemoteClient.prompt` accepts only a string
   (`remote-client.ts:159`). For v1 the adapter flattens text, embedded
   `resource` (Zed's @-mentioned files) and `resource_link` (as a path
   reference) into text. Images need an additive `ContentBlock[]` overload,
   which is v2.
5. **No diffs in tool calls.** Zed's review UI needs `{type:"diff", path,
   oldText, newText}`. The daemon emits only `title/status/rawInput` and text
   results (`daemon/src/mapping.ts:68`). Without diffs it still works: edits hit
   disk and Zed reloads the buffers, but nothing is shown inline. Adding diffs
   means new fields on `tool_call_update` (additive, §7 rule: wire both ends).
   That is v2.
6. **Unsaved editor buffers.** Our tools read and write the host filesystem
   directly, not Zed's buffers (ACP `fs/*` client methods). An edit on a file
   with unsaved changes in Zed can conflict. v1 accepts this (it is the same as
   the TUI today). Routing `fs_*` through `fs/*` would be daemon→client
   effects, which overlaps `docs/eval/remote-execution-model.md` and is out of
   scope here.
7. **Concurrency.** `session/cancel` and `request_permission` arrive while
   `session/prompt` is pending. Our peer dispatches concurrently
   (`transport/src/peer.ts:291`), and the SDK does too. The adapter must not add
   a per-connection lock (§7 "don't serialize the RPC peer").

### Proposed phasing

| Phase | Scope | Size · Blast |
|---|---|---|
| **v1** | `tentacle acp`: pure `acp-map` module (initialize, new, prompt with flattening, update mapping incl. `kind`/`locations` from `fs_read`/`fs_write`/`fs_edit`/`fs_multi_edit`/`shell`/`agent_task` + `rawInput`, stop reasons, permission reshape), stdio wiring, single broker, stderr-only diagnostics, `toolCallId` plumbing | **M · load-bearing** |
| v2 | diff content on edit tool calls; `session/load` from the JSON store (replay history as updates); `mcpServers` from the editor merged with config; image prompts | S–M each, additive |
| v3 | `tentacle acp` over a pod (`run`/`attach` transport) | S |

Order of magnitude for v1: about 400–600 lines plus tests, almost all in
`packages/cli` (with one optional field in `core` and a few lines in `client`).
No changes to the agent loop, the daemon or `@tentacle/protocol`.

### Tests v1 would need (sketch, for Implementation when promoted)
- Mapping table tests per direction, including unknown/extra ACP fields.
- End-to-end over a fake stdio pair: initialize → new → prompt streaming
  chunks → tool_call/update → permission round-trip → `end_turn`; cancel
  mid-turn → `cancelled`; permission cancelled → tool denied.
- Single-broker regression with a separate daemon-side spy (mutation-checked).
- "stdout carries only valid ACP frames" test across startup, including a
  first-run scaffold and a config error.

## Implementation

*(empty until promoted to `feat/acp-adapter`)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Verdict (proposed, owner decides):** go with **Option B**, v1 only, as a
`feat` once no other code task is open (§10 one-at-a-time). Reject Option A.

Not yet verified (and how to verify):
- Zed's current behaviour when `request_permission.toolCall.toolCallId` does
  not match an announced tool call. Check it with a throwaway repro under
  `.tentacle/tmp/acp-adapter/` before deciding whether risk 2 blocks v1.
- `@agentclientprotocol/sdk` working inside the Bun-compiled binary. Build a
  minimal agent with `bun build --compile` and handshake it from Zed.
- The ACP field details in the table come from the public spec, not from
  running Zed. The first Implementation step is to capture a real Zed
  `initialize`/`session/new`/`session/prompt` exchange and pin it as fixtures.

Self-review caveat: this is the author's own pass, not a fresh-context Review.
Run a fresh-context Review before promotion.
