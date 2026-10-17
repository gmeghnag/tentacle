# eval/remote-execution-model — the umbrella: what runs where in `run`/`attach`, and in which order we build it

> **Status:** eval (Context + Review; an index over four sub-evals, no code of its own)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** n/a (umbrella) · **Blast:** load-bearing (proposes a new §7 invariant) · **Suited:** owner decides; each sub-eval carries its own sizing.

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** in pod mode (`run`/`attach`), the daemon runs
in the pod and the model is reached through the laptop. What else should run
where (MCP servers, tool results, user input), and in which order should we
build it, so that pod mode is as fluid as the local TUI and stays safe?

This doc holds the shared principle, the dependency map, the cross-cutting
measurements and the order. Each piece of work has its own eval.

### The principle (proposed as a new AGENTS §7 invariant)

> **Compute stays next to the code; identity stays with the user.** The pod is
> the *workspace*: code, shell, builds, and MCP servers that act on the
> workspace run there. The laptop is the *identity*: the model key, account
> tokens (GitHub/Jira/…), permission decisions and session history stay there.
> **A pod is not trusted:** every effect on the laptop that the pod asks for
> passes a laptop-side gate.

Existing invariants that are special cases of it:
- "Model stays on the laptop (pod reverse-tunnel)";
- "Persistence lives on the laptop/main thread".

Corollary: **the laptop is already a hard dependency** of pod mode, because
the model is reached through it. Laptop-side tools therefore add no new point
of failure; if the laptop sleeps, the agent stops anyway.

The trust boundary also has to be stated plainly. The daemon *runs in the pod*,
so whoever controls the pod controls the daemon and can write raw JSON-RPC
frames to the laptop. A daemon-side gate is UX, not security.

### Measured baseline

*2026-10-17, OCP cluster, ns `tentacle`, pod `ubi9-sleep` (UBI9). Scripts and
raw output are in the sub-evals. They ran in
`.tentacle/tmp/remote-execution-spike/` (AGENTS §6).*

| What | Value | Detail in |
|---|---|---|
| Pod mode: time until the TUI sees the first token (a ~400-word answer, Qwen3 27B on llama.cpp) | **47.3 s of silence**, then 6,480 events in ~0.8 s. Local first token: 0.33 s | `pod-model-streaming.md` |
| Reverse-RPC round trip, small frame (×100) | p50 47 ms · p95 ~100–117 ms · p99 ~150–167 ms | `rpc-flow-control.md` |
| A 1 MB / 5 MB single frame | blocks **every** other message for 1.3 s / 3.7–4.1 s | `rpc-flow-control.md` |
| Best fix for the above | end-to-end credit window (2 × 256 KB in flight): a control message waits 196–444 ms | `rpc-flow-control.md` |
| `tools` block sent on every model call | built-ins ~1.4k tokens + the owner's MCP (veil ~0.9k, playwright ~4.5k) ≈ **6.8k tokens** | below |

Tool-definition size, measured with this script:

```ts
// tool-defs.ts — the `tools` block sent on EVERY model call (agent.ts:206)
import { loadConfig } from "@tentacle/config";
import { buildAgent } from "../../../packages/cli/src/wiring.ts";
const config = await loadConfig({ cwd: process.cwd(), scaffold: false });
const { tools } = buildAgent(config);
const defs = tools.definitions();
const json = JSON.stringify(defs);
console.log(`builtin tools: ${defs.length} · ${json.length} chars ≈ ${Math.round(json.length / 4)} tokens (chars/4 estimate)`);
for (const d of defs) console.log(`  ${d.name.padEnd(22)} ${JSON.stringify(d).length} chars`);
console.log(`configured mcpServers: ${Object.keys(config.mcpServers).join(", ") || "(none)"}`);
```
```
builtin tools: 8 · 5689 chars ≈ 1422 tokens (chars/4 estimate)
  fs_read 780 · fs_write 372 · fs_edit 646 · fs_multi_edit 1063 · shell 1151
  shell_output 384 · shell_kill 301 · agent_task 983   (chars)
configured mcpServers: veil, playwright
```
```ts
// mcp-defs.ts — size of the configured MCP servers' tool definitions
import { loadConfig } from "@tentacle/config";
import { connectMcpServers } from "@tentacle/mcp";
const config = await loadConfig({ cwd: process.cwd(), scaffold: false });
const t0 = performance.now();
const res = await connectMcpServers(config.mcpServers);
console.log(`connect time: ${(performance.now() - t0).toFixed(0)}ms · errors: ${JSON.stringify(res.errors)}`);
const byServer = new Map<string, { n: number; chars: number }>();
for (const t of res.tools) {
  const server = t.name.split("__")[1] ?? "?";
  const chars = JSON.stringify({ name: t.name, description: t.description, parameters: t.jsonSchema }).length;
  const e = byServer.get(server) ?? { n: 0, chars: 0 };
  byServer.set(server, { n: e.n + 1, chars: e.chars + chars });
}
let total = 0;
for (const [s, { n, chars }] of byServer) { total += chars; console.log(`  ${s}: ${n} tools · ${chars} chars ≈ ${Math.round(chars / 4)} tokens`); }
console.log(`MCP total ≈ ${Math.round(total / 4)} tokens per model call`);
res.dispose();
process.exit(0);
```
```
connect time: 857ms · errors: {}
  veil: 4 tools · 3504 chars ≈ 876 tokens
  playwright: 25 tools · 17965 chars ≈ 4491 tokens
MCP total ≈ 5367 tokens per model call
```

Without prompt caching, that is paid in full on every round. There is no
`cache_control` in `packages/providers/src/anthropic-provider.ts`. Caching is a
follow-up, not part of this umbrella.

### The pieces and how they depend on each other

```
pod-model-streaming ──(introduces $/cancelRequest + $/progress in the peer)──┐
        │                                                                     │
        ▼                                                                     ▼
rpc-flow-control ──(credit window + control priority over $/progress)──► mcp-client-tools
                                                                              │
                                              (shared `runOn` config field)   ▼
                                                                    mcp-daemon-servers
```

| # | Eval | What | Needs | Size · Blast |
|---|---|---|---|---|
| 1 | [`pod-model-streaming.md`](./pod-model-streaming.md) | model tokens stream through the tunnel; Esc cancels the remote model | — | M · load-bearing |
| 2 | [`rpc-flow-control.md`](./rpc-flow-control.md) | large payloads in windowed chunks; control messages never wait behind bulk data | **1** (builds on `$/progress`) | M–L · load-bearing |
| 3 | [`mcp-client-tools.md`](./mcp-client-tools.md) | `runOn: "client"`: MCP servers on the laptop, exposed to the pod daemon | **1** hard (cancel). **2** soft: a laptop-side result cap is a stopgap until 2 lands | L · load-bearing |
| 4 | [`mcp-daemon-servers.md`](./mcp-daemon-servers.md) | `runOn: "daemon"`: MCP servers started in the pod, with no secrets shipped | the `runOn` field (from 3, or introduced here if 4 goes first) | M · load-bearing |

**Related, and not in this umbrella:**
- `docs/fix/steering-over-rpc.md`: mid-turn "Queue a task…" is silently dropped
  in pod mode.
  - **Not** the cause of the silence: the measured first event lands 0.28 s
    after the local stream ends, which is exactly the batch.
  - It compounds it: the user sees nothing for 47 s, types a correction, and
    that is dropped too.
  - **Do it after 1:** `session/enqueue` is a short control request, and
    `steer` is one more update in the mapping that 1 touches.
- `docs/eval/proxy-model-cancel.md`: 1 closes the model half. The agent-loop
  half (re-check `aborted` before running tools) stays in that eval.
- `docs/eval/oversize-frame-hang.md`: 2 turns its defensive cap into a real
  transport rule.
- `docs/feat/pod-attach-resilience.md`: keepalive and reconnect. A keepalive is
  a control message, so it needs 2's priority lane to stay timely while bulk
  data flows.

### Mixed configuration (pieces 3 + 4 together)

*Added 2026-10-18.* The two MCP evals each describe one side. This is the
combined target in `run`/`attach`: **one session uses laptop-side and pod-side
MCP servers at the same time**, chosen per server by `runOn`.

```jsonc
"mcpServers": {
  "github":     { "command": "npx", "args": ["@mcp/github"] },                     // runOn: "client" (default) → laptop
  "playwright": { "command": "npx", "args": ["@playwright/mcp"] },                 // client → laptop
  "eslint":     { "command": "npx", "args": ["@mcp/eslint"], "runOn": "daemon" },  // → pod, sees the workspace files
  "pg":         { "command": "pg-mcp", "env": { "PGPASSWORD": "${PGPASSWORD}" }, "runOn": "daemon" } // placeholder, expanded pod-side
}
```

| | `runOn: "client"` | `runOn: "daemon"` |
|---|---|---|
| Where the process runs | laptop | pod |
| How the daemon gets the tools | laptop pushes `tools/register` | the laptop sends `mcp/start` with the spec; the daemon starts the server and registers its tools locally |
| How a call executes | `tool/call`, daemon → laptop | in-process in the daemon, as a normal tool |
| Permission gate | **laptop-side**: once-only, config-only `autoApprove` (`mcp-client-tools.md` §4) | daemon-side; the prompt still reaches the laptop TUI via `request_permission` |
| Secrets | stay on the laptop | `${VAR}` placeholders only, expanded from the pod's env (`mcp-daemon-servers.md` §2) |
| Description suffix the model sees | "(runs on the user's machine, not in the workspace)" | "(runs in the workspace)" |
| Defined in | [`mcp-client-tools.md`](./mcp-client-tools.md) | [`mcp-daemon-servers.md`](./mcp-daemon-servers.md) |

Rules that hold only when both sides are live:
- **One registry, two origins.** The session's registry holds both groups.
  The start-of-turn snapshot (`mcp-client-tools.md` §2) covers only the
  client group; daemon-side tools are local and change only when `mcp/start`
  changes them, which also happens only at turn boundaries.
- **No cross-side name clash is possible:** there is one `mcpServers` map, so
  a server name exists on exactly one side. A clash with a built-in, or with a
  pod-local config's server (if that is ever loaded), follows first-wins with
  a warning.
- **Partial availability is normal.** An old daemon refuses one or both new
  methods with `MethodNotFound`, a runtime is missing in the image, or a server
  is slow. The status line reports each side separately (e.g. "[mcp] client
  2/2 · daemon 1/2: eslint — `npx` not found in pod"), and the session runs
  with whatever is available.
- **In the local TUI, `runOn` is ignored.** Laptop and workspace are the same
  machine, so everything starts locally, as today.
- **Delivery staging:**
  - with only piece 3, every server runs on the client;
  - with only piece 4, `runOn` must be introduced there, and unmarked servers
    keep today's pod-mode behaviour (none);
  - the full mixed mode needs both.

**Planned end-to-end test** (owned by whichever of 3/4 lands second):
- **Setup:** a pod-mode session over the real `RemoteClient` ↔ `Connection`
  stack on an in-memory channel. One fake MCP server is `runOn: "client"`, one
  is `runOn: "daemon"` (the existing fake-spawner pattern). Each server
  records which process/side served each call.
- **Expect:**
  - the model's `tools` block contains both, with the correct location suffix
    on each;
  - calling the client tool executes on the laptop side and passes the laptop
    gate;
  - calling the daemon tool executes in the daemon and goes through the
    daemon-side gate;
  - neither call ever executes on the wrong side.
- **Non-vacuity mutation:** route the daemon tool through `tool/call` (or the
  client tool in-process). The "served by" assertion must turn red.
- **Failure leg:** the daemon side's `mcp/start` returns an error for its
  server. The session still works with the client tool, and the status line
  shows the daemon-side error.

## Implementation

*(none — umbrella; each sub-eval is promoted on its own)*

## Execution

*(none)*

## Review

*— claude-opus-5-5, 2026-10-17 (author; same model wrote the sub-evals — a different-model fresh-context pass is wanted before promoting 1)*

**Verdict: ADOPT the principle and the order 1 → 2 → 3 → 4**, with
`steering-over-rpc` right after 1.
- **Why 1 first:** it is the largest measured UX defect (47 s of silence),
  and its primitives (`$/cancelRequest`, `$/progress`) are what 2 and 3 build
  on.
- **The §7 invariant** ("compute next to the code, identity with the user; a
  pod is not trusted") changes the rules, so it is a `feat` on AGENTS.md. It
  should land **before** 3, because 3's gate design follows from it.
- **Owner decisions (2026-10-18):**
  - **§7 invariant: APPROVED** as worded. It lands as its own small `feat` on
    AGENTS.md, before piece 3. The owner's understanding, confirmed: the
    existing permission mechanism (`PermissionBroker` + the TUI prompt) is
    unchanged. What changes is *where it is enforced* for laptop-side tools.
    The laptop checks every pod-originated request itself, because the pod's
    daemon could skip the prompt.
  - **Method name: `model/streamChunked`, CONFIRMED.** It is permanent once
    shipped.
  - **Order: CONFIRMED.** Piece 1 (`pod-model-streaming`) first, then
    `fix/steering-over-rpc`, then 2 → 3 → 4.
- **Still open, owned by the owner:** the secret policy for `runOn: "daemon"`
  (placeholder-only vs an explicit `shipEnv` opt-in; see sub-eval 4). It is
  decided when piece 4 is promoted.
- **Not verified:**
  - a second cluster or network path (all numbers come from one OCP cluster
    and one laptop link);
  - a cloud model provider (the streaming numbers use a local llama.cpp; a
    cloud API's first token is slower, but the batch effect is the same, since
    it is structural).

### Review #2 — fresh-context, different model

*— claude-fable-5-1, 2026-10-17*

**Verdict: APPROVE-WITH-NITS the principle and the order 1 → 2 → 3 → 4** (with
`steering-over-rpc` after 1). The new §7 invariant is well-worded and does not
conflict with any existing invariant; the dependency map and order are correct.
Findings are refinements, none block adoption.

**Premise table (umbrella-level facts):**

| Claim | Where | Verdict |
|---|---|---|
| Laptop is already a hard dependency (model reached through it) | `cli/src/pod-runtime.ts` wires `ProxyModelProvider` as the *only* model path (`serve --stdio --model-proxy`) | TRUE — if the laptop dies the agent stops anyway |
| Daemon runs in the pod; a daemon-side gate is UX not security | `cli/src/serve.ts:53-110` (daemon hosted in pod over stdio) + single-broker §7 | TRUE |
| `tools` block sent every model call | `agent/src/agent.ts:211` (`tools: this.config.tools.definitions()`, per loop iteration) | TRUE (doc cites `:206`; off by ~5) |
| No `cache_control` in the anthropic provider | `packages/providers/src/anthropic-provider.ts` | Not re-verified; caching is explicitly deferred, so immaterial |
| All five cross-referenced docs exist | `proxy-model-cancel`, `oversize-frame-hang`, `pod-attach-resilience`, `fix/steering-over-rpc`, `mcp-remote-transport`, `pod-ephemeral-binary`, `architecture/F4` | TRUE (all present) |

**Attacks tried:**
1. *Does the new invariant contradict another §7 rule (esp. "Don't serialize the
   RPC peer")?* — No. It governs trust/placement, orthogonal to the peer's
   concurrency rule. No conflict found.
2. *Is "laptop already a hard dependency" actually true, or does it hide a new
   failure point?* — Verified in `pod-runtime.ts`: the reverse-tunnel provider is
   the sole model path in pod mode, so laptop-side tools add no new point of
   failure. Corollary holds.
3. *Is the order wrong — does piece 3 really need piece 1's cancel?* — A remote
   MCP call (e.g. playwright navigate) can run long; without `$/cancelRequest`
   Esc cannot abort it. The "3 needs 1 (hard)" edge is justified.
4. *Missing piece?* — Prompt caching (deferred, noted), keepalive (in
   `pod-attach-resilience`, needs 2's lane — noted). `connect` uses the same
   RemoteClient↔Connection stack, so the "untrusted remote daemon" argument
   extends to it; the umbrella could state the `connect` case explicitly but it
   is not load-bearing.

**Findings:**
1. NIT: `agent.ts` tool-block cite is `:206`; the actual `tools:
   this.config.tools.definitions()` is ~`:211` (inside the per-iteration request
   build — relevant to piece 3's turn-freeze, see that doc).
2. NIT: carry the "allow-always is name-scoped, not input-scoped" trust gap into
   piece 3 (recorded there) — it is the one place the "a pod is not trusted"
   principle is only partially enforced.

**What holds:** the principle, the dependency diagram, the 1→2→3→4 order, and the
"laptop-side gate is the security boundary" framing. The "Not verified" caveats
(single cluster, local llama.cpp) are honest and match my re-runs below (see
`rpc-flow-control` Review #2 — throughput varied ~2× from the doc's numbers while
every qualitative conclusion reproduced).

*Author note (claude-opus-5-5, 2026-10-17):* the `agent.ts` line-number nit does not hold. `grep -n "definitions()" packages/agent/src/agent.ts` gives `206:        tools: this.config.tools.definitions(),`, inside the per-iteration loop that starts at `:192`. The original cite `:206` is correct. The substance of the turn-freeze finding stands: the registry must hand out a snapshot captured at turn start.
