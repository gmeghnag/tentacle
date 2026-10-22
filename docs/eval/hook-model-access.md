# eval/hook-model-access — hooks call a model through tentacle (the LLM-judge seam)

> **Status:** eval (context + drafted implementation; owner decisions M1–M8 open)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promotion → `feat/hook-model-access`
> **Type:** eval → feat · **Size:** L (split proposed: see *Files*) · **Blast:** load-bearing (§7 pod trust model / "model stays on the laptop", protocol, the hook process seam) · **Suited:** fresh-context Review mandatory (§10)

## Decisions for the owner

| # | Question | Options | Recommendation |
|---|---|---|---|
| M1 | Transport hook → tentacle | (a) HTTP over a **unix socket** owned by the hook's daemon + per-invocation bearer token in env · (b) loopback TCP HTTP + token · (c) stdio / extra fd request-response | **(a)** — `curl --unix-socket` works from bash; no TCP port; token dies with the hook process |
| M2 | API surface | (a) **one non-streaming completion**: text messages in, text out, no tools, hard size caps · (b) full streaming `model/stream` shape (tools, events) | **(a)** — a judge needs one short answer; tools would reopen recursion and the attack surface |
| M3 | Judge model selection | (a) one `hookModel` config key · (b) **named map `hookModels` on the laptop + a per-hook `model` field naming one entry** · (c) reuse `profiles.<name>.model` | **(b)** — names are the laptop-published allowlist; the hook spec binds the token to one name; the reserved name `"session"` means the session model |
| M4 | Abuse and cost | caps per session / per call / concurrency, separate accounting, TUI visibility | **Laptop-enforced caps** (defaults: 200 calls/session, 1 in flight/session, 64 KiB input, `maxTokens` ≤ 1024, 120 s/call), usage kept **separate** from the session meter, a TUI notice on first use and on cap hit |
| M5 | Which hooks get access | user · package · project (after trust / extra opt-in) | User and package hooks with a `model` field; **project hooks after trust**, and in a pod only if the laptop entry sets `pods: true` (default `false`) |
| M6 | Protocol | reuse `model/stream` + a selector field · **new daemon→client `model/complete`** · plus `model` in the `hooks/trust` hook item | **New method (additive) + `model` in the strict `hooks/trust` item (breaking) → bump 9 → 10** — wire field + v10 done early (2026-10-22, `feat/protocol-v10-forward-compat`, `model: line(64)`); rest pending |
| M7 | Recursion | — | Structural: the completion path never enters `Agent.run`, so no `model_request`/turn/tool hook can fire; `model` field rejected on `model_request` hooks; nested-tentacle guard left as debt |
| M8 | Where a call is served | (a) **the laptop main thread** for the worker and pod runtimes (both built by `createLocalRuntime`), the daemon's own config for `serve` / in-process / `--plain` · (b) always where the session provider object lives (worker serves itself) | **(a)** — one laptop-side service for worker + pod, the same seam `hooks/trust` uses; caps and TUI notices live where `notify` exists |

## Context

*— claude-opus-5-5, 2026-10-22*

### The question

Should tentacle give hooks a way to call a model **through tentacle**, and if
so, with which transport, API surface, model-selection and gating rules, so
that an **LLM judge** (a `tool_call` hook that asks a model whether to
`allow` / `deny` / `ask` / rewrite a tool call) can be written as an
extension, with these hard constraints:

1. **Credentials stay on the laptop**, locally and in a pod (`run`/`attach`).
2. The judge may use a **different model and a different provider/key** from
   the session (session on Opus, judge on a cheap model of another provider).
3. The judge stays a **hook script**; tentacle provides only the seam.

### Why: what a hook can do today

- A hook is `/bin/sh -c <command>` with the payload on stdin
  (`agent/src/hooks.ts:749-772`). Its env is `process.env` **minus every
  secret-looking name** (`core/src/env.ts:10-11`, `scrubSensitiveEnv`
  `:28-39`, applied in `exec/src/host-execution.ts:205-208`) plus
  `TENTACLE_HOOK_EVENT`, `TENTACLE_PROJECT_DIR`, `TENTACLE_PACKAGE_DIR`
  (`hooks.ts:761-765`). The caller's explicit `options.env` is overlaid
  **unscrubbed** (`host-execution.ts:199-208`). So a hook gets no model key; a
  judge must bring and store its own key. In a pod the hook runs **in the
  pod** (`docs/extensions.md` §1 "Where hooks run"), so a judge there needs a
  key **in the pod** — exactly what §7 "Model stays on the laptop" forbids.
- There is no hook→tentacle channel of any kind: stdout is one JSON object
  read after exit (`extensions.md` §3.3), stdin is the payload then EOF
  (`core/src/execution.ts:20-21`).

### Evidence: the pieces that exist

**The pod reverse-tunnel.** `serve --stdio --model-proxy` builds every
agent with `modelOverride: new ProxyModelProvider(...)`
(`cli/src/serve.ts:247-266`) whose senders are
`connection.requestModelStream` / `requestModelStreamChunked`
(`serve.ts:282-285`, `daemon/src/connection.ts:122-145`).
`ProxyModelProvider.stream` (`daemon/src/proxy-model.ts:154-190`) sends the
whole `WireChatRequest` (`protocol/src/model.ts:32-37`: messages, tools,
temperature, maxTokens — **no model selector**) to the laptop, chunked first,
latched to batch on `MethodNotFound`. The laptop serves it in `RemoteClient`
(`client/src/remote-client.ts:587-597` dispatch, `:1266-1275` batch,
`:1290-1376` chunked) from **one** `this.modelProvider`
(`remote-client.ts:242,254-259`), which pod runtimes set to
`configuredModelProvider(config)` (`cli/src/pod-runtime.ts:336,524`). A
provider error crosses to the pod as an opaque internal error
(`remote-client.ts:1366-1373`). If the model-serving connection drops, the
daemon cancels its sessions' turns (`connection.ts:63-67,104-115`).

Consequence: **today a pod can already make arbitrary calls (any messages,
any tools, any `maxTokens`) to the session model through the laptop, with
no cap.** A hook model call on the session model adds no capability a pod
lacks; a call on a *different* model/key does.

**Provider configuration.** One model per config: `ModelConfigSchema`
(`config/src/schema.ts:10-37`: `provider` ∈ `openai|anthropic`, `baseURL`,
`model`, `apiKey`, `apiKeyCommand`, `maxTokens`) under the single top-level
key `model` (`schema.ts:143`). Profiles are whole alternative settings, at
most **one applied per launch** (`schema.ts:226-249`,
`config/src/profile.ts:47-61`). Key precedence: `TENTACLE_MODEL_API_KEY` >
`apiKey` > `apiKeyCommand` (`config/src/resolve.ts:275-288`), the command run
at load (`config/src/load.ts:319-320`). The only multi-model feature is the
sub-agent per-type model id **on the same endpoint and key**
(`cli/src/model-provider.ts:13-29`, `wiring.ts:270`), and over the tunnel even
that is ignored (`wiring.ts:149-153,270`). **So two providers/keys cannot
coexist in a config today**; a judge on another provider needs a new config
shape.

**`model_request` and `modelOverride`.** `model_request` is a notification
fired only from `Agent.run` before each model call (`agent/src/agent.ts:473,
642`, `:697-708` → `hooks.ts:685-723`), never awaited, and enabled only when
there is no `modelOverride` (`wiring.ts:212`): in a pod it runs nowhere. Other
model calls bypass it: compaction (`agent/src/compact.ts:77,115`) and the
large-output summary (`wiring.ts:181-187`) call `model.stream` directly.
`modelOverride` also gates project-hook `allow` (`wiring.ts:220`, D6) and the
trust store (`cli/src/local-runtime.ts:216`: a runtime with a `modelProvider`
is a pod, never stored).

**Laptop-side gating pattern.** `hooks/trust` is a daemon→client request
(`protocol/src/methods.ts:54`, schema `protocol/src/hooks.ts:22-40`, served
`remote-client.ts:595-597`), decided through the single broker by
`createHooksTrustResolver` (`local-runtime.ts:211-218`); the in-process path
calls the same resolver directly after the same schema check
(`wiring.ts:310-328`). That is the template: a laptop-side resolver, one
RPC method, an in-process twin. §7 adds: the laptop accepts from a pod only
"an allowlist of what the laptop itself published".

**Protocol version:** `PROTOCOL_VERSION = 9` (`protocol/src/version.ts:7`).

## Implementation

*— claude-opus-5-5, 2026-10-22*

Drafted per the **recommended** options (M1a, M2a, M3b, M4, M5, M6, M7, M8a).
A different owner choice changes the matching sub-section only.

### Load-bearing assumption

**A model call made by a hook while the turn is blocked on that hook can be
served without deadlock, in every runtime.** The turn awaits the hook
(`hooks.ts:543`, `await this.run(...)` inside `toolCall`, itself awaited by
the gate `agent/src/permission-gate.ts:112`); meanwhile the hook's request
must be (1) accepted by the daemon process and (2) when routed to the
laptop, served while the laptop's own `session/prompt` is still outstanding.

**Holds.**
(1) `HookRunner.run` awaits an async `env.exec` (`hooks.ts:757-768`), so the
daemon's event loop is free to accept a socket connection.
(2) `RpcPeer` dispatches every inbound request with `void this.handleRequest`
(`transport/src/peer.ts:310`), no per-connection lock (§7 "Don't serialize the
RPC peer"), on both ends. The exact same mid-turn daemon→client pattern
already ships twice: `model/streamChunked` (every pod model call happens
inside `session/prompt`) and `hooks/trust` (asked from inside a turn,
`hooks.ts:455-485`). A new daemon→client method inherits that property; the
design must not add an await that serializes `Connection` handlers.

### Preconditions

- P1 Explicit `ExecOptions.env` reaches the child unscrubbed
  (`host-execution.ts:199-208`) → a per-invocation token can be passed to one
  hook only; the model's `shell` tool children never see it (separate exec).
- P2 A name matching `TOKEN` is scrubbed from any env tentacle *inherits*
  (`env.ts:10-11`) → a nested tentacle / MCP server never forwards a leaked
  token; per-child keys are dropped via `PER_CHILD_KEYS` (`env.ts:24`).
- P3 Daemon→client requests can carry an `AbortSignal` that cancels the
  laptop side (`connection.ts:134-145`, `remote-client.ts:1300,1350-1353`).
- P4 Provider errors must reach a pod opaque (`remote-client.ts:1366-1373`).
- P5 `createLocalRuntime` is the one constructor of the laptop `RemoteClient`
  for worker and pod runtimes (`local-runtime.ts:208-223`), and the worker
  hosts a daemon `Connection` to the main thread (`cli/src/worker.ts:103-120`)
  → one laptop-side service serves both (M8a).
- P6 Single broker (§7): nothing here prompts per call; the only prompt
  touching this feature is the existing `hooks/trust`, unchanged in
  mechanics.

### Design

**Config (laptop, `packages/config`).** New top-level setting (a profile
replaces it, like `hooks`):

```jsonc
"hookModels": {
  "judge": {
    "provider": "openai", "baseURL": "https://api.cheap.example/v1",
    "model": "small-1", "apiKeyCommand": "security find-generic-password -s judge -w",
    "maxTokens": 512,
    "limits": { "callsPerSession": 200, "inputChars": 65536, "timeoutS": 120 },
    "pods": false
  }
}
```

Entry = `ModelConfigSchema` fields minus `contextWindow` (strict), plus
`limits` (all optional, defaults in M4) and `pods` (default `false`). Name:
`^[a-z][a-z0-9_-]{0,31}$`; `"session"` is **reserved** (= the session's own
provider, no entry needed; `pods` irrelevant: a pod already has it). Each
entry's key is resolved at load like the main key (`load.ts:319`), its own
`apiKey`/`apiKeyCommand` only (no env override). `HookSpecSchema`
(`schema.ts:99-125`) gains optional `model: <name>`; it is a config error on
`event: "model_request"` (M7). A `model` naming an unknown entry is a
config error for user hooks and a skipped hook (logged) for package/project
hooks — in a pod the pod cannot know the laptop's names, so there the
check is the laptop's at call time.

**Laptop-side service (pure + thin I/O), `HookModelService`.** Input: the
resolved `hookModels`, the session provider, a provider factory, `notify`.
`complete({ sessionId, hook, model, origin, request, signal })`:
1. resolve `model` → entry (`"session"` → the session provider); unknown →
   `not_found`; `origin: "pod"` and a non-`session` entry without
   `pods: true` → `forbidden`; `origin: "pod-project"` likewise (M5);
2. caps (M4): calls this session ≥ `callsPerSession` → `rate_limited`; one
   in flight per session → `busy`; input > `inputChars` → `too_large`;
   `maxTokens` = min(request, entry, 1024);
3. call `provider.stream` with `{messages, maxTokens, signal}` and **no
   tools**, collect `text` deltas, stop on `done`; ignore `reasoning`; a
   `tool_call` event is impossible (no tools) and is dropped;
4. account `usage` per session per entry, separately from the session
   usage; `notify` once per session per entry on first use
   (`hook <hook> is using model <name>`) and once on a cap hit.
The decision logic (resolve, gate, caps, accounting) is a pure module with
unit tests (§7 "logic lives in pure modules"); providers are created lazily
per entry and cached.

**Protocol (`packages/protocol`).** New daemon→client method
`model/complete`:
- params (strict): `sessionId`, `hook` (≤ 40 chars), `model` (name regex),
  `project: boolean`, `messages: [{role: "system"|"user"|"assistant",
  content: string}]` (1–64 items, total ≤ 256 KiB on the wire; the service
  applies the tighter entry cap), `maxTokens?` (1–4096), `temperature?`;
- result (strict): `{ text: string, usage?: WireUsage }`;
- errors: `MethodNotFound` (old laptop / no service), domain codes for
  `not_found`, `forbidden`, `rate_limited`, `busy`, `too_large`, `timeout`,
  `provider_error` (opaque message, P4), cancel via `$/cancelRequest`.
And `hooks/trust` hook item (`protocol/src/hooks.ts:30-34`) gains
`model: line(32).optional()` so the trust prompt shows it. That item is
`.strict()`: an old laptop rejects a new pod's trust request with
`InvalidParams` → **breaking → `PROTOCOL_VERSION` 9 → 10** (a mixed pair fails
cleanly at `initialize`). Register in `RequestSchemas` (`methods.ts:73-92`).

**Daemon side (where `HookRunner` runs).** A `HookModelBackend` seam:
`complete(call, signal) → Promise<{text, usage?}>` with two implementations:
- `rpcBackend(connection)` → `connection.requestModelComplete(params,
  {signal})` (new, mirrors `connection.ts:122-145`);
- `localBackend(service)` → `service.complete(...)` in-process.
`buildAgent` (`wiring.ts:148-170`) takes `hookModel?: HookModelBackend`;
wired per M8a: worker → rpc (to main); `serve --model-proxy` (pod) → rpc
(to laptop); `serve` without proxy, `--in-process`, `--plain`, one-shot →
local service built from that process's config. `origin` is decided **by the
serving side**, never trusted from params: a `RemoteClient` built with a
`modelProvider` (pod, `local-runtime.ts:216` convention) stamps `pod` /
`pod-project`; the worker's stamps `local`.

**Hook access (M1a).** A `HookModelGateway` per daemon process: one
`Bun.serve({ unix })` listener in a fresh `0700` dir
(`mkdtemp` under `os.tmpdir()`; path ≤ 100 bytes, macOS limit 104), started
lazily on the first hook that has a `model`, closed on process exit. For a
hook run whose spec has `model`, `HookRunner.run` mints a 32-byte random
token bound to `{sessionId, hook name, model, project, AbortController}`,
passes `TENTACLE_HOOK_MODEL_SOCKET` and `TENTACLE_HOOK_MODEL_TOKEN` in
`ExecOptions.env`, and **revokes the token in `finally`** (process exit,
timeout kill, cancel) and aborts its controller, which aborts any in-flight
call. Hooks without `model` get neither variable;
`TENTACLE_HOOK_MODEL_SOCKET` joins `PER_CHILD_KEYS` (`env.ts:24`) so a stale
inherited value never leaks, the token is scrubbed by name (P2).
HTTP: `POST /v1/complete`, `Authorization: Bearer <token>`, body
`{messages, max_tokens?, temperature?}` (no `model`: the token is bound to
the spec's model — the hook cannot pick another), response
`200 {text, usage}` or `{error: {code, message}}` with 400/401/403/404/408/
413/429/499/502/503. Only one in-flight request per token; body read capped
before parse. A judge in bash:

```sh
curl -s --unix-socket "$TENTACLE_HOOK_MODEL_SOCKET" \
  -H "Authorization: Bearer $TENTACLE_HOOK_MODEL_TOKEN" \
  -d "$(jq -n --arg c "$(cat)" '{messages:[{role:"system",content:"Answer ALLOW, DENY or ASK."},{role:"user",content:$c}],max_tokens:8}')" \
  http://hook/v1/complete
```

Other workspace processes: they never receive the token; the socket dir is
`0700`; a same-uid process able to read the hook's environment
(`/proc/<pid>/environ`, `ps eww`) could replay it **only while the hook
runs**, bounded by the per-session caps, and in local mode such a process
can already read the user's config/key files — documented, not designed out.

**Recursion (M7).** The service calls `provider.stream` directly: no
`Agent.run`, so `notifyModelRequest` (`agent.ts:473,642`) never fires, no
tools are offered so no `tool_call`, no turn events. `model_request` hooks
cannot hold `model`. Residual: a hook that launches `tentacle "prompt"`
starts a full agent with hooks — debt (a `TENTACLE_HOOK_EVENT`-aware guard).

### Files

Dependency order. Split for promotion: **(A) local seam** = 1–6, 8 (local
and in-process wiring), 9; **(B) pod + protocol** = 7 and the RPC parts of 3,
5, 6, 8.

1. `packages/protocol/src/model.ts`, `methods.ts`, `hooks.ts`, `version.ts`
   — `model/complete` schemas + registry; `model` in the trust item;
   `PROTOCOL_VERSION = 10`.
2. `packages/config/src/schema.ts`, `resolve.ts`, `load.ts`, `profile.ts`
   — `hookModels`, `HookSpec.model`, per-entry key resolution, profile
   replace rule.
3. `packages/core/src/env.ts` — `TENTACLE_HOOK_MODEL_SOCKET` in
   `PER_CHILD_KEYS`; `HookModelBackend` type (core, shared by agent/daemon).
4. `packages/agent/src/hook-model-service.ts` (new, pure: resolve/gate/caps/
   accounting) + test.
5. `packages/agent/src/hooks.ts` — token mint/revoke around `run`, env vars,
   `model` on spec; `packages/exec/src/hook-model-gateway.ts` (new: unix
   socket HTTP listener, token table).
6. `packages/daemon/src/connection.ts` — `requestModelComplete`.
7. `packages/client/src/remote-client.ts` — serve `model/complete` via the
   injected service, stamp `origin`, opaque errors to a pod.
8. `packages/cli/src/wiring.ts`, `worker.ts`, `serve.ts`,
   `local-runtime.ts`, `pod-runtime.ts`, `main.ts` — build the service from
   laptop config, pass backends per M8a; `notify` sink.
9. `docs/extensions.md` (§3.1 `model`, §3.3 env, new §3.11, §7, §9),
   `ARCHITECTURE.md` (the new daemon→client method).

### Failure modes

| Case | What the judge sees | How state converges |
|---|---|---|
| Laptop disconnects mid-call (pod) | 503 `unavailable` | Pending RPC rejects on peer close; token revoked when the hook exits. The model-serving connection's close already cancels the turn (`connection.ts:104-115`), which kills the hook. Nothing persisted |
| Hook's own timeout fires first | (killed) | `finally` revokes the token and aborts the call → `$/cancelRequest` → laptop aborts the provider stream; the call still counts toward the cap |
| Call timeout (`timeoutS`) before hook timeout | 408 `timeout` | Service aborts the provider call; hook decides (no-opinion / `ask` recommended in docs) |
| User cancels the turn | (killed) / 499 | Turn signal kills the hook (`extensions.md` §3.10) → same as above; cancel is not a failure |
| Provider errors | 502 `provider_error`, message opaque in a pod, real locally | Real error to the laptop `onPeerError` sink (pod) / daemon log; counter incremented |
| Unknown model / not allowed in pod | 404 / 403 | No provider call; logged once per session |
| Cap reached / concurrent call | 429 / 409 `busy` | One notice; resets with a new session |
| Old laptop (no `model/complete`) | 503 `unsupported` | Cannot occur across versions after the bump (initialize fails); kept for a laptop with no service |
| `--plain` / one-shot | normal results | Local service; notices go to stderr (no Ink) |
| In-process TUI fallback | normal results | Local service on the same thread; notices through the in-process notify path, never raw writes (§7) |
| Worker crash | (hook dies with worker) | Gateway closes with the process; tokens are memory-only |
| Token replayed after hook exit | 401 | Revoked in `finally` |

### Tests

- Pure service: resolve / `forbidden` for pod on `pods:false` / reserved
  `session` / each cap boundary / separate accounting / notice once —
  `agent/test/hook-model-service.test.ts`.
- `HookRunner`: a spec with `model` gets both env vars, one without gets
  neither; token rejected after the hook exits (401); a hook killed by
  timeout aborts the in-flight backend call (fake backend observes
  `signal.aborted`). Use the existing `HostExecution` hook tests' pattern.
- Gateway: bad/absent token 401, oversize 413, second concurrent request 409,
  body has no `model` honoured.
- RPC: `RemoteClient` serves `model/complete` from the service; a pod-origin
  request for a `pods:false` entry is `forbidden` **even when params claim
  otherwise** (mutation check: stamp origin from params → test must fail);
  provider error is opaque to the pod (mirror the existing streamChunked
  opacity test); cancel propagates.
- Deadlock: a `tool_call` hook doing a judge call during `session/prompt`
  over a real `RpcPeer` pair completes (the load-bearing assumption, red if
  the handler is serialized).
- Recursion: a judge call with a `model_request` hook configured fires no
  `model_request` notification.
- Protocol: `hooks/trust` with `model` validates; version 10 mismatch fails
  at `initialize`.

## Execution

## Review
