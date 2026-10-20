# eval/pod-model-streaming — in pod mode the TUI sees nothing until the whole model round is done

> **Status:** done — merged to `main` 2026-10-18 (`4022288`) (promoted 2026-10-18; Context + Implementation + Execution in; Review #3 + #4 APPROVE-WITH-NITS; acceptance e2e passed on kind; Delta 2 Review #5 APPROVE; merged to main 2026-10-18)
> **Branch:** `fix/pod-model-streaming`
> **Type:** fix · **Size:** M · **Blast:** load-bearing (protocol + the §7 model-tunnel seam + `transport/peer.ts`) · **Suited:** a strong model executes; mandatory fresh-context Review, ideally by a different model family.
> **Umbrella:** [`remote-execution-model.md`](./remote-execution-model.md) (piece 1 of 4; no prerequisites; 2 and 3 build on it).

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** should the pod reverse-tunnel (`model/stream`)
stream the model's events as they are produced, and be cancellable, instead
of returning the whole round in one response? If so, with which wire shape,
given the version-skew rules of AGENTS §7?

### Symptom (measured end-to-end)

In `run`/`attach`, nothing appears in the TUI (no reasoning, no text) until the
model has finished the entire round. Then everything arrives at once. Esc does
not stop the model. A short prompt ("ciao") hides it, because the round lasts
under a second; the delay grows with how much the model thinks and writes.

**Repro** (2026-10-17, run from `.tentacle/tmp/remote-execution-spike/`). The
real attach stack: `tentacle serve --stdio --model-proxy` in pod `ubi9-sleep`
(ns `tentacle`, OCP) ↔ `RemoteClient`/`RemoteSession` on the laptop, with the
configured model (`Qwen3.8-27B-UD-Q6_K_XL`, llama.cpp,
`http://192.168.1.17:8080/v1`) served through the tunnel. One run records both
the moment the local model emits each event type and the moment the TUI side
receives it.

```ts
// e2e-attach.ts
import { RemoteClient, RemoteSession } from "@tentacle/client";
import { loadConfig } from "@tentacle/config";
import { PermissionBroker } from "@tentacle/core";
import type { ChatRequest, ModelProvider } from "@tentacle/core";
import { KubeClient, loadKubeClientOptions } from "@tentacle/k8s";
import { createModelProvider } from "@tentacle/providers";

setTimeout(() => { console.log("[timeout 300s]"); process.exit(2); }, 300_000);
const config = await loadConfig({ cwd: process.cwd(), scaffold: false });
const real = createModelProvider({
  provider: config.provider, baseURL: config.baseURL, model: config.model,
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
});
let t0 = 0; const marks: Record<string, number> = {};
const mark = (k: string) => { if (!(k in marks)) marks[k] = performance.now() - t0; };
const tapped: ModelProvider = {
  id: real.id,
  async *stream(req: ChatRequest, signal?: AbortSignal) {
    mark("laptop: model/stream request received");
    for await (const ev of real.stream(req, signal)) { mark(`laptop: local model first ${ev.type}`); yield ev; }
    mark("laptop: local model stream done");
  },
};
const kube = new KubeClient(loadKubeClientOptions({ namespace: "tentacle" }));
const channel = kube.openExec(
  { pod: "ubi9-sleep", command: ["tentacle", "serve", "--stdio", "--model-proxy"] },
  { onStderr: (t) => process.stderr.write(`[pod] ${t}`) },
);
const client = new RemoteClient(channel, new PermissionBroker(), tapped);
await client.initialize();
const session = new RemoteSession(client);
t0 = performance.now();
let n = 0;
for await (const ev of session.send(process.argv[2] ?? "Write a ~400-word explanation of JSON-RPC 2.0 request/response/notification semantics.")) {
  mark(`TUI side: first ${ev.type}`); n++;
}
mark("TUI side: turn done");
for (const [k, v] of Object.entries(marks).sort((a, b) => a[1] - b[1])) console.log(`${(v / 1000).toFixed(2).padStart(7)}s  ${k}`);
console.log(`TUI-side events: ${n}`);
client.close(); process.exit(0);
```
```
   0.14s  laptop: model/stream request received
   0.33s  laptop: local model first reasoning     ← a local TUI would show this
  43.23s  laptop: local model first text
  47.06s  laptop: local model first done
  47.06s  laptop: local model stream done
  47.34s  TUI side: first reasoning               ← pod mode shows the first event here
  48.08s  TUI side: first text
  48.12s  TUI side: first usage
  48.12s  TUI side: first turn_end
  48.12s  TUI side: turn done
TUI-side events: 6480
```

The same prompt without the tunnel (`ttft.ts`, provider called directly) gives
a first visible token at 110–330 ms. Totals: 0.6 s for "Reply with exactly:
ok", 7.7 s for ~150 words, 43.4 s for ~400 words. The reasoning model
produces ~7.6 reasoning characters per text character, which is exactly the
content the batch hides. This is **one** round: an agentic turn repeats the
silence for every model round between tool calls.

### Root cause (code)

- `packages/client/src/remote-client.ts:166-175`: `onModelStream` collects
  **all** events of the local provider into an array and returns them as the
  single JSON-RPC result (`return { events }`).
- `packages/daemon/src/proxy-model.ts:50-55`: `ProxyModelProvider.stream`
  awaits `this.send(...)` and only then yields the events one by one. The rest
  of the daemon already streams: each yielded event becomes a `session/update`
  to the TUI, which is why the 6,480 events burst out at once.
- **Cancel is lost on both sides:**
  - `ChatRequest.signal` (`core/src/model.ts:53`) is not carried by
    `toWireRequest` (`proxy-model.ts:15-42`), and `ProxyModelProvider` ignores it;
  - `RemoteClient.onModelStream` calls the local provider with no signal;
  - the peer has no request cancellation at all: `RpcPeer.request(method,
    params)` (`transport/src/peer.ts:79-108`) takes no signal, and there is no
    cancel message.
- This is known debt, recorded as "first cut":
  - `proxy-model.ts:1-8`;
  - `docs/architecture/F4-pod-execution.md:279` ("no token-by-token streaming
    over the tunnel");
  - `TODO.md` F4.d.2 ("token streaming over the tunnel + mid-call cancel").
- **Scope:** only the `--model-proxy` path (`run`/`attach`). The local worker
  and `serve`/`connect` run the model *inside* the daemon
  (`cli/src/serve.ts:27-31`) and already stream.

### Constraints that shape the wire design (verified)

- **Schemas are strict, and results are validated inbound:**
  - `ModelStreamParamsSchema` is `.strict()` (`protocol/src/model.ts:54`), so
    a `stream: true` flag would make an old laptop reject the call with
    InvalidParams;
  - the peer validates *results* against the method schema too
    (`peer.ts:276-286`), so adding a field to an existing result breaks an old
    peer as well.
- **A new method is the clean probe:** an unknown method gets `MethodNotFound`
  (`peer.ts:196`), which §7 requires us to handle. An unknown notification is
  only `reportError`ed (`peer.ts:239-241`) and is not fatal. The laptop's
  `RpcPeer` has no `onError` (`client/src/remote-client.ts:64`), so it is
  dropped silently and never written to the terminal Ink owns.
- **The version skew is real:** `attach` skips the binary transfer when the
  pod already has a `tentacle` that passes the `--version` preflight
  (`cli/src/pod-runtime.ts:400-417`). An old daemon with a new laptop is the
  expected case after an upgrade.
- **Dispatch is concurrent (§7, must not be serialized):**
  - inbound requests and notifications run as `void handleRequest(…)` and
    `void handleNotification(…)`;
  - responses are resolved synchronously in `handleResponse` (`peer.ts:184-191`);
  - a synchronous notification handler keeps its order today, but that is an
    implementation detail, so the design must not rely on it.
- **The volume is small:** the measured stream is ~20k chars in 47 s, about
  0.4 KB/s. Chunking for *size* and a credit window are therefore not needed
  for model tokens. They belong to `rpc-flow-control.md`, for tool results.

### Prior art

- `docs/fix/proxy-model-cancel.md` (CONFIRMED; promoted from `eval/`, merged c0b8c77): cancel does not stop the
  model, and the requested tool still runs. This eval closes the model half.
  The agent-loop half stays there.
- `TODO.md` F4.d.2, cited above.
- `docs/fix/steering-over-rpc.md`: a different defect that compounds this one
  (see the umbrella).

## Implementation

*— qwen3.8-27b, 2026-10-18*

> Every cite below was re-verified against the source at promotion (2026-10-18).
> The Context cites all hold (the two NITs flagged by Review #2 are already
> corrected in the Context body). Re-verification caught **three design errors
> in a first draft** that this section corrects — see *Design notes from
> re-verification* at the end of the Design.

### Load-bearing assumption (verified)

**All frames on one ordered channel resolve in arrival order, with responses
resolved synchronously and requests/notifications dispatched concurrently.**
`receive()` classifies each frame synchronously: request → `void
this.handleRequest(…)` (`packages/transport/src/peer.ts:184`), notification →
`void this.handleNotification(…)` (`:186`), response/error →
`this.handleResponse(…)` **synchronously** (`:188-190`; `handleResponse`
`:255-289` has no `await` before the resolve/reject). Consequence used
throughout the design: the laptop sends its `$/progress` frames **before** the
result frame, and the channel delivers frames in order, so on the daemon peer
every `$/progress` frame is **classified and routed to the pending request's
`onProgress` before** the later result frame's `handleResponse` runs. (The
`ProxyModelProvider` consumer awaits between yields, but the peer's routing is
synchronous per frame, so the queue already holds all `N` events by the time
the result resolves.) The count check ("done = result arrived AND all `N`
chunks in `seq` order") is kept as a belt-and-suspenders completeness proof
(Review #2 attack 1).

**Second load-bearing fact (the §7 "don't serialize the peer" invariant):**
inbound requests/notifications are dispatched as `void handleRequest` /
`void handleNotification` (`peer.ts:184,186`) with **no** per-connection mutex,
on purpose — a long `session/prompt` must not block a short
`session/request_permission` (AGENTS §7). The two new primitives must add
**no** await/lock to dispatch.

### Preconditions (verified invariants the change relies on)

1. **Strict schemas + inbound result validation.** `ModelStreamParamsSchema`
   is `.strict()` (`packages/protocol/src/model.ts:54`);
   `ModelStreamResultSchema` is `.strict()` (`:58-60`). The peer validates
   inbound **results** against the method schema (`peer.ts:276-286`) and
   inbound **params** of known methods too (`peer.ts:200-203`). ⇒ the fix must
   be purely additive: a **new** method + **new** notifications, and **no new
   field on any existing `.strict()` schema** (including
   `ClientCapabilitiesSchema`, `session.ts:36-40` — see Design note 1).
2. **A new method is the clean probe.** An unknown method → `MethodNotFound`
   (`peer.ts:195-196`), which §7 requires us to handle. An unknown
   **notification** is only `reportError`ed and is not fatal (`peer.ts:239-241`);
   the laptop's `RpcPeer` has **no** `onError` wired (`remote-client.ts:64-88`),
   so an unknown notification is dropped silently and never written to the
   terminal Ink owns. ⇒ `$/cancelRequest` sent to an old laptop is a safe
   no-op.
3. **The version skew is real.** `attach` skips the binary transfer when the
   pod already has a `tentacle` passing the `--version` preflight
   (`packages/cli/src/pod-runtime.ts:400-417`). An **old daemon + new laptop**
   and a **new daemon + old laptop** are both expected after an upgrade, so
   both directions must fall back.
4. **The model round must outlive the peer's request timeout.** The
   `Connection` sets a peer-wide `requestTimeoutMs` from
   `permissionTimeoutMs` (`packages/daemon/src/connection.ts:70-72`; default
   5 min, `packages/daemon/src/ws-server.ts:38,183`). On the ws-server path a
   model round longer than that deadline would be killed by the timeout even
   **today**. The pod stdio path — the only one that uses `--model-proxy`
   (`cli/src/main.ts:195` → `cli/src/serve.ts:53-107`) — passes **no** options
   to `new Connection(…)` (`serve.ts:84-88`), so `requestTimeoutMs` is unset and
   model requests never time out there. The new chunked request rides the same
   peer, so this stays true by construction. **Do not** add a model-specific
   timeout.
5. **No new `session/update` variant** is needed: tunnel events are *replayed
   as provider events* through the existing `ProxyModelProvider`, so the
   daemon's `session/update` stream and `packages/client/src/mapping.ts` are
   unchanged. The change stays off the `mapping.ts` union entirely.
6. **The Esc chain exists end to end** and only the tunnel drops the signal:
   TUI `App.tsx:651-652` aborts the turn controller on Escape while running →
   `App.tsx:350` passes `controller.signal` into `session.send(…)` →
   `RemoteSession.send` (`client/src/remote-session.ts:39-70`) maps abort →
   `client.cancel(id)` (daemon side) **and** holds the signal → daemon
   `HostedSession.prompt` (`daemon/src/hosted-session.ts:97`) creates the
   turn's `AbortController` and passes `controller.signal` into
   `session.send` → `Agent.runMessages` builds the `ChatRequest` with
   `signal` (`agent/src/agent.ts:204-210`) and maps a mid-stream abort to a
   clean `cancelled` turn end (`:234-241`). Today the signal dies in
   `ProxyModelProvider.stream` (it neither forwards it to the wire request nor
   watches it). This fix wires both.
7. **Compaction is a consumer too.** `compact.ts:60-63,98-101` calls
   `model.stream(request)` (with its own `signal` when present) through the
   *same* provider, so the async-queue redesign covers `/compact` in pod mode;
   the queue must terminate cleanly for a call with no signal (Review #2
   caution 2).

### Design

Five layers, in dependency order (protocol → transport → daemon → client →
cli). Everything additive: **two new notifications, one new method, no change
to any existing schema.**

**Layer 1 — protocol (additive).**
- `packages/protocol/src/model.ts`:
  - `ModelStreamChunkedParamsSchema =
    z.object({ request: WireChatRequestSchema }).strict()` — same shape as
    `model/stream`'s params (an old daemon's `isMethodName("model/streamChunked")`
    is false, so no param validation can break it).
  - `ModelStreamChunkedResultSchema =
    z.object({ chunks: z.number().int().nonnegative(), usage:
    WireUsageSchema.optional() }).strict()` — the laptop never re-sends events;
    they crossed as `$/progress`.
  - `WireProgressValueSchema = WireStreamEventSchema` (a chunk carries exactly
    one wire event; the existing union already covers
    `text|reasoning|tool_call|done`).
- `packages/protocol/src/methods.ts`: `Method.ModelStreamChunked =
  "model/streamChunked"` registered in `RequestSchemas` (the `:60` block);
  `Notification.Progress = "$/progress"` and `Notification.CancelRequest =
  "$/cancelRequest"` registered in `NotificationSchemas` with
  `ProgressParamsSchema = z.object({ id: z.string().min(1), seq:
  z.number().int().nonnegative(), value: WireProgressValueSchema }).strict()`
  and `CancelRequestParamsSchema = z.object({ id: z.string().min(1) })
  .strict()`. (Ids are strings on the wire — `peer.ts:92` — but the schema
  accepts `RequestIdSchema` to stay honest to the framing.)
- `packages/protocol/src/session.ts`: **no change.** `ClientCapabilitiesSchema`
  is `.strict()` and is validated *inbound* by the daemon (`peer.ts:200-203`),
  so adding a `chunkedModel` field here would make an **old daemon reject a new
  laptop's `initialize` with `InvalidParams`** — the exact new-laptop +
  old-daemon skew this fix must survive. Capability discovery is the
  `MethodNotFound` probe instead (Review #1 point 2; see Design note 1).

**Layer 2 — transport: two generic primitives
(`packages/transport/src/peer.ts`).**
Both additive; the existing dispatch path keeps its shape.

- **`request(method, params, options?)`** gains an optional third arg
  `options: { signal?: AbortSignal; onProgress?: (value: unknown, seq: number)
  => void }`. `Pending` gains `signal?`, `onProgress?`.
  - **Outbound abort → `$/cancelRequest`:** `request` attaches an `abort`
    listener on `options.signal`; on abort it (a) sends
    `notify("$ /cancelRequest", { id })` — the *outbound request's own id*,
    (b) rejects the pending entry with a **catchable cancelled marker** (an
    `RpcError` whose `name === "cancelled"`, code `InternalError`), (c) clears
    the timeout and deletes the pending entry. If the request already settled
    (response arrived first), the listener is removed on settlement and abort
    is a no-op. If `signal` arrives **already aborted**, the request rejects
    before the frame is sent (fail-fast, mirrors today's `closed` check).
  - **Inbound cancel → per-request signal:** the peer keeps a
    `Map<string, AbortController>` keyed by *inbound request id*. In
    `handleRequest`, before invoking the handler, it creates a controller,
    stores it, and passes a context object to the widened handler
    `RequestHandler = (method, params, ctx?: { signal: AbortSignal }) => …` —
    the `id` is available there (`peer.ts:194`), which the laptop needs to
    target its `$/progress` frames. In a `$/cancelRequest` notification the
    peer looks up the controller and calls `.abort()` (unknown id → no-op,
    idempotent). When `handleRequest` settles (result sent or error sent) it
    removes the controller from the map. **All of this is synchronous map
    work — no await, no lock (§7).**
  - **`$/progress` routing:** in `handleNotification`, a `$/progress` for an id
    in `pending` calls that entry's `onProgress(value, seq)`; for an
    unknown/settled id it is dropped (a malformed frame is `reportError`ed,
    which the daemon peer wires via `onError`, `connection.ts:75`). The
    router is a map lookup — synchronous (§7).
- **Why `onProgress` rides the request id:** the response correlates to the
  same id, so there is no second namespace and an old peer simply never sees
  the notification (it is not in its registry → `reportError`, non-fatal).

**Layer 3 — daemon: `ProxyModelProvider` becomes an async queue
(`packages/daemon/src/proxy-model.ts`).**
- The constructor argument `send` is widened to a capability object
  `ModelTunnel = { stream(request): Promise<ModelStreamResult>;
  streamChunked?(request, { signal, onProgress }):
  Promise<ModelStreamChunkedResult> }`. A single-function `send` still
  type-checks via a small adapter (keeps existing call sites/tests compiling).
  When `streamChunked` is absent the provider uses `stream` only — today's
  behaviour, byte-identical.
- `stream(request)`:
  - Builds the wire request (`toWireRequest`) and opens a **small internal
    async queue** (linked list + single waiter — the same 40-line shape as
    `packages/client/src/queue.ts`, which lives in `@tentacle/client`; the
    daemon may **not** import it, dependency direction is
    client→devDep→daemon, so the queue is implemented in
    `daemon/src/proxy-model.ts` itself, no new dependency).
  - Calls `streamChunked(wire, { signal: request.signal,
    onProgress: (value, seq) => queue.pushChecked(seq, value) })` **without
    awaiting** the promise to the exclusion of the consumer: the
    generator/queue consumer (`for await (const e of queue)`) runs
    concurrently, so events are yielded as they arrive — the whole point of
    the fix.
  - **Loud correctness (never a silent truncation):** `pushChecked` throws the
    queue into a failed state (surfaced to the consumer after already-queued
    events) on a `seq` gap, a duplicate `seq`, or a `value` that fails
    `WireStreamEventSchema`. When the `streamChunked` promise **resolves**:
    if `received === result.chunks` the queue closes; if `received <
    result.chunks` (result before the last chunk) it **fails** with a
    loud error; if `received > result.chunks` it also fails. When the promise
    **rejects** (error response, disconnect — `handleClose` rejects pending,
    `peer.ts:132-144`; cancel — the peer's cancelled marker): the queue
    **fails**, but only *after* the consumer has drained what is queued (the
    consumer sees the queued events, then the error — mirroring a local
    provider that throws mid-stream).
  - **The cancel path:** the provider also watches `request.signal`
    (`"abort"` listener): on abort it fails the queue with a marker the agent
    recognises as a cancellation. This is required for the agent's clean path:
    `agent.ts:234-241` only maps an error to `turn_end: cancelled` when
    `signal?.aborted` — a bare throw would surface as a failed turn. (The
    peer already rejects the outbound request on abort; the queue must end
    deterministically either way, and the signal listener makes it so even if
    the rejection arrives late.)
  - **No-signal calls (compaction, `compact.ts:63`):** no listener is attached;
    completion is driven purely by progress + result. The queue must not block
    on any cancel path (Review #2 caution 2).
  - **Fallback probe + per-connection latch:** the provider holds
    `chunked: "unknown" | "yes" | "no"`. First model call: try
    `streamChunked`. On a rejection **specifically** with code
    `JsonRpcErrorCode.MethodNotFound` (`-32601`) set the latch to `"no"` and
    immediately retry the *same* call via `stream` (today's batch path). Any
    other error propagates as a real failure — **no silent fallback on
    genuine errors**. Later calls use the latched mode for the rest of the
    connection (Review #1: "tries it once per connection").
- `request.signal` is `ChatRequest.signal` (`packages/core/src/model.ts:53`).
  Forwarding it to `peer.request(…, { signal })` closes the Esc chain
  (Precondition 6).

**Layer 4 — client: `RemoteClient` serves `model/streamChunked`
(`packages/client/src/remote-client.ts`).**
- The `onRequest` handler is widened to take the ctx (`{ signal }`) and gains a
  `Method.ModelStreamChunked` branch → `onModelStreamChunked(params, { signal })`.
- `onModelStreamChunked`:
  - Streams `this.modelProvider.stream(params.request as unknown as ChatRequest,
    { ...(signal ? { signal } : {}) })` — the laptop's local provider now
    receives the abort, so a mid-round Esc on the pod **stops the model**
    (closes the `proxy-model-cancel.md` model half).
  - Each event is forwarded to the daemon as
    `notify("$ /progress", { id, seq, value })` using the **inbound request
    id** from the ctx, with a fresh `seq` counter.
  - **Coalescing:** events are buffered and flushed every **~30–50 ms** (one
    `setTimeout` per window; the measured ~6,480 events → ~1,000 frames),
    **and flushed on stream end and on error before the result/error frame is
    sent** — this ordering is load-bearing (Precondition 1's ordering argument;
    Review #2 caution 3). `chunks` in the final result = the exact number of
    `$/progress` frames sent (i.e. the `seq` counter), so the daemon's count
    check is exact.
  - On normal completion: flush, then **return**
    `{ chunks, ...(usage ? { usage } : {}) }` where `usage` comes from the
    last `done` event (the wire `done` event carries `usage?`).
  - On provider error: flush pending, then **throw** an `RpcError`
    (`InternalError`, message from the error) — the daemon receives an error
    response, the queue fails after draining. On abort (signal): flush pending
    and throw an `RpcError` with `name === "cancelled"` so the daemon's queue
    sees a cancellation-consistent failure (the daemon has already rejected
    locally; the error frame is discarded as unknown-id, `peer.ts:260-262`).
  - The existing `model/stream` handler is **kept** unchanged for old daemons.
- `initialize()` is unchanged (`{ streaming: true }` — no capability field,
  Precondition 1).
- The laptop peer gains an `onError` that **logs to the existing daemon
  stderr sink / `log` callback** (in `serve --stdio --model-proxy` the
  `Connection` already receives a `log` fn, `serve.ts:84-88`; `RemoteClient`
  gets an optional `onError` option wired the same way) — never a raw
  `process.stdout.write` while Ink owns the terminal (§7). Unknown
  notifications (e.g. a `$/progress` racing a cancel) then surface as logs
  instead of vanishing (closes Review #2's one fail-silent surface).

**Layer 5 — cli wiring (`packages/cli/src/serve.ts`).**
- `startStdioDaemon` builds the tunnel with **both** capabilities:
  `stream = (request) => connection.requestModelStream(request)` (unchanged)
  and `streamChunked = (request, { signal, onProgress }) =>
  connection.requestModelStreamChunked(request, { signal, onProgress })`.
- `Connection` (`packages/daemon/src/connection.ts:90-94`) gains
  `requestModelStreamChunked(request, { signal, onProgress })` =
  `this.peer.request(Method.ModelStreamChunked, { request }, { signal,
  onProgress })` returning `ModelStreamChunkedResult`. (It inherits the
  stdio peer's *absence* of `requestTimeoutMs` — Precondition 4.)

### Design notes from re-verification (errors caught, and why)

1. **First-draft error — capability advertisement via
   `ClientCapabilitiesSchema.chunkedModel`:** rejected. That schema is
   `.strict()` (`session.ts:36-40`) and the daemon validates inbound params of
   known methods (`peer.ts:200-203`), so an **old daemon** would answer a new
   laptop's `initialize` with `InvalidParams` — breaking exactly the new-laptop
   + old-daemon case Precondition 3 requires to work. Discovery is instead the
   `MethodNotFound` probe (Review #1 point 2), which is fully additive.
2. **First-draft error — "bounded async queue":** the queue must be
   **unbounded**. Events are small deltas at ~0.4 KB/s and the consumer (the
   agent loop) reads concurrently as they arrive; a bounded queue that back-
   presses `onProgress` would stall the peer's notification routing (and,
   worse, the `$/progress` routing is synchronous — a blocking push would
   serialize dispatch, violating §7).
3. **First-draft imprecision — handler signature:** the laptop needs the
   **inbound request id** to target its `$/progress` frames, but
   `RequestHandler` is `(method, params) => …` (`peer.ts:25`). The fix widens
   it to `(method, params, ctx?: { signal: AbortSignal }) => …` (additive,
   optional third arg; existing two-arg handlers are untouched).
4. **Timeout interaction (new, found during verification):** see Precondition
   4. The ws-server path applies its 5-minute permission deadline to *all*
   outbound requests — including model calls, even today. That is out of scope
   (the pod stdio path sets no timeout), but the Review must confirm we do not
   add a model-specific timeout that would truncate long rounds.

### Files to change (exact, in dependency order)

1. `packages/protocol/src/model.ts` — the three new chunked/progress schemas
   (+ `WireProgressValueSchema`).
2. `packages/protocol/src/methods.ts` — register `ModelStreamChunked` in
   `Method`/`RequestSchemas`; register `Progress`/`CancelRequest` in
   `Notification`/`NotificationSchemas` (new param schemas live here or in
   `model.ts`).
3. `packages/protocol/src/index.ts` — **no change** (`export *`s the above);
   listed for completeness.
4. `packages/protocol/src/session.ts` — **no change** (see Design note 1).
5. `packages/transport/src/peer.ts` — the two generic primitives:
   `request(method, params, { signal, onProgress })`, cancelled-marker
   rejection, per-inbound-id `AbortController` map, `ctx.signal` to the
   widened `RequestHandler`, `$/cancelRequest` handling, `$/progress`
   routing. No await/lock added to `receive()`/dispatch.
6. `packages/daemon/src/proxy-model.ts` — internal async queue, `ModelTunnel`
   capability, `pushChecked` loud correctness, completion on
   (result ∧ count), cancel/drain semantics, `MethodNotFound` probe + latch,
   signal forwarding.
7. `packages/daemon/src/connection.ts` — `requestModelStreamChunked`.
8. `packages/client/src/remote-client.ts` — widened `onRequest` (ctx),
   `onModelStreamChunked` with ~30–50 ms coalescing + flush-on-end/error,
   optional `onError` logging, `model/stream` kept.
9. `packages/cli/src/serve.ts` — pass both capabilities to
   `ProxyModelProvider`; wire the laptop peer's `onError` to the existing
   `log` sink.
10. Tests (new + extended): see *Tests*.

### Failure modes (and how state converges)

- **Result before the last chunk** (reordering under concurrent dispatch):
  the laptop flushes before the result frame and the channel is ordered, so
  the queue holds all `N` events when the result resolves (load-bearing
  assumption); the `received === result.chunks` check still fails loudly if
  anything ever truncates.
- **`seq` gap or duplicate**: `pushChecked` fails the queue — the consumer
  drains queued events, then the stream **throws**. Never a silent truncation.
- **Cancel while chunks are in flight** (Esc in the TUI): Precondition 6's
  chain — the turn controller aborts → `HostedSession`'s `controller.signal`
  aborts → the agent's `ChatRequest.signal` aborts → the provider's signal
  listener fails the queue **and** the peer's outbound `request({ signal })`
  rejects with the cancelled marker, sending `$/cancelRequest { id }` to the
  laptop → the laptop's per-inbound-id controller aborts → its local
  `provider.stream` is aborted. `agent.ts:234-241` sees `signal?.aborted` and
  yields a clean `turn_end: cancelled`. The laptop's in-flight/late frames
  (result or `$/progress`) are discarded: pending is already removed on the
  daemon (`peer.ts:260-262` unknown-id discard, `reportError`, non-fatal).
- **Cancel after the result**: no-op — the pending entry is removed on
  settlement, so the abort listener is detached and `$/cancelRequest` targets
  an unknown id (no-op on the laptop).
- **The model throws mid-stream**: the laptop flushes pending, throws an
  `RpcError`; the daemon queue fails **after** draining queued events — the
  consumer yields the partial events, then throws (mirrors a local provider).
  `agent.ts:234-241` propagates it as a failed turn (no `signal?.aborted`).
- **Disconnect mid-stream**: `handleClose` rejects the pending request
  (`peer.ts:132-144`); the `streamChunked` promise rejects → queue fails
  after draining; `stream()` throws instead of hanging.
- **Old laptop** (new daemon, pod has the new binary, laptop binary is old —
  or `connect` to an old remote): `model/streamChunked` → `MethodNotFound`
  (`peer.ts:195-196`) → latch `"no"`, immediate retry via `model/stream`,
  byte-identical to today for the rest of the connection.
- **Old daemon** (new laptop): the daemon's `stream` path is unchanged; the
  laptop still serves `model/stream`. The daemon never sees `model/streamChunked`.
- **Coalescing holding back the last events**: the laptop **flushes** on
  stream end and on error *before* the result/error frame (load-bearing;
  Review #2 caution 3), and `chunks` equals the frames actually sent.
- **Compaction without a signal** (Review #2 caution 2): no signal listener
  attached; completion is progress + result only; the queue terminates on the
  result. `/compact` in pod mode works identically, now streaming.
- **Silent-drop surface** (Review #2 finding): the laptop wires `onError`
  (log), and the daemon already logs via `connection.ts:75`; a
  `$/cancelRequest` whose handler is missing would no-op — the "cancel
  reaches the laptop provider's signal" test pins it.
- **Long rounds vs peer timeout** (Design note 4): stdio pod path has no
  `requestTimeoutMs` (Precondition 4) — a 47 s round is safe. We add no
  model-specific timeout.

### Tests (red first; AGENTS §9)

New/extended, using the existing in-memory `createChannelPair()`
(`packages/transport/src/channel.ts:31`) and the `ScriptedProvider` pattern
from `packages/cli/test/model-proxy.test.ts:11-24`. No real I/O; a gated
provider (a promise/flag gate) drives determinism.

**Transport (`packages/transport/test/peer.test.ts` additions):**
- `request(…, { signal })`: aborting rejects the caller with the cancelled
  marker **and** the peer receives a `$/cancelRequest` carrying the outbound
  id.
- The receiver's handler sees `ctx.signal`; a `$/cancelRequest` for a known
  inbound id aborts it; for an unknown id it is a no-op (idempotent).
- `request(…, { onProgress })` receives `$/progress` values in `seq` order for
  the matching id; a `$/progress` for a settled/unknown id is dropped without
  rejecting anything.
- Dispatch stays concurrent (regression for §7): a long-running request
  handler does not delay an inbound `$/cancelRequest`/`$/progress` for another
  id. (Cheap to assert with the in-memory pair + a never-resolving handler.)

**Daemon (`packages/daemon/test/` new file, e.g. `proxy-model.test.ts`):**
1. **The deciding test (RED today):** a gated `streamChunked` sender emits one
   progress, then a gate holds; the first event is observed **out of
   `ProxyModelProvider.stream` before** the sender's promise resolves. On the
   current batch code this is impossible (the provider awaits the whole
   turn), so red today, green after. **Non-vacuity mutation (mandatory, §9):**
   restore the array-batch path (or wire `stream` instead of
   `streamChunked`) → this test must turn red.
2. **Fallback (old laptop):** the sender's `streamChunked` rejects with
   `RpcError(-32601, …)` once; the provider retries via `stream`, the turn
   completes with the right events, and the **second** call goes straight to
   `stream` (latch; assert `streamChunked` is not called twice).
   **Contrast:** a `streamChunked` rejection with a *non-`MethodNotFound`*
   code propagates (no silent fallback).
3. **Ordering and count:** events are yielded in `seq` order; a `seq` gap and
   a duplicate `seq` both make the stream **throw** (after draining queued
   events); a result with `chunks` ≠ received count fails the stream.
4. **Cancel reaches the laptop provider's signal:** full-stack in-memory —
   daemon `Connection` (with a `ProxyModelProvider`) ↔ `RemoteClient` with a
   recording local provider; drive `stream({ signal })`, abort, and assert the
   local provider's `ChatRequest.signal` became `aborted` **and** the daemon
   stream ended (the agent would map it to `cancelled`). This is the test that
   pins the laptop-side `$/cancelRequest` handler wiring (Review #2's
   fail-silent surface).
5. **Partial-then-throw:** the laptop yields two events then throws; the
   daemon yields exactly those two, **then** throws.
6. **Disconnect mid-stream:** close the channel mid-turn; `stream()` throws
   (does not hang).
7. **Coalescing flushes the tail:** with a non-zero coalescing window the
   final events are still delivered and `chunks` matches the frames sent
   (laptop-side test, `packages/client/test/remote.test.ts` additions).
8. **No-signal completion** (compaction shape): `stream(request)` with no
   `signal` completes purely on result + count (Review #2 caution 2).

**Client (`packages/client/test/remote.test.ts` additions):**
- `model/streamChunked` is served: the local provider runs, events are
  forwarded as `$/progress` (seq from 0), the result is `{ chunks, usage? }`,
  and the `done` event's `usage` is lifted into the result.
- The local provider receives the abort signal (with the `onRequest` ctx
  wired).
- The old-daemon direction is unchanged: `packages/cli/test/model-proxy.test.ts`
  (which drives `model/stream` end to end) still passes **unmodified**.

**Protocol (`packages/protocol/test/methods.test.ts` additions):**
- `model/streamChunked` is a registered method with strict params/result
  validation; `$/progress` and `$/cancelRequest` are registered notifications;
  **`InitializeParams` without `chunkedModel` still parses** (no capability
  field exists — guard against reintroducing Design note 1), and an
  `initialize` from a new client is still accepted by the schema.

**End-to-end validation (acceptance gate):** re-run `e2e-attach.ts` (Context's
Repro) on `ubi9-sleep`. Expect the TUI side's first reasoning at ~0.4 s
instead of ~47 s, and Esc to stop the model mid-round. (The single-slot local
LLM makes this a ~50 s run; it is the acceptance gate, not the unit gate.)

### §7 red-team points for the Review

- **"Don't serialize the RPC peer"**: the per-inbound-id `AbortController`
  map, the `$/cancelRequest` handler, and the `$/progress` router are
  synchronous map lookups + a `controller.abort()` / `onProgress()` call — no
  await, no lock, in `receive()`/`handleNotification`/`handleRequest`. The
  transport concurrency regression test pins it.
- **"Protocol changes are additive; version stays 1"**: two new notifications
  + one new method + (additive) optional `request` options; **no existing
  strict schema gains a field** — in particular `ClientCapabilitiesSchema`
  and `InitializeParamsSchema` are untouched (Design note 1).
  `PROTOCOL_VERSION` stays `1` (`packages/protocol/src/version.ts`).
- **"Model stays on the laptop (pod reverse-tunnel)"**: unchanged — the
  endpoint + API key still never leave the laptop; the laptop still serves the
  model, now progressively.
- **"Never write raw to the terminal while Ink owns it"**: the laptop peer's
  new `onError` logs through the existing `log`/stderr sink
  (`serve.ts:84-88`), never a `process.stdout.write`; the TUI renders only via
  the existing `session/update` stream.
- **"TUI always over RPC — one session path"**: no new session/agent loop; the
  tunnel events re-enter the daemon through the *existing*
  `ProxyModelProvider` → `session/update` pipeline.
## Execution

*— qwen3.8-27b (bulk of the code, 2026-10-18; session ran out of context before
writing this section) and claude-opus-5-5 (review of that code, the fixes below,
this section, 2026-10-18)*

**As built (qwen3.8-27b), in plan order:**
1. `protocol/src/model.ts` + `methods.ts`: `model/streamChunked`
   (`ModelStreamChunked{Params,Result}Schema`), `$/progress`
   (`ProgressParamsSchema`), `$/cancelRequest` (`CancelRequestParamsSchema`).
   No existing strict schema touched; `PROTOCOL_VERSION` stays 1.
2. `transport/src/peer.ts`: `request(method, params, { signal, onProgress })`;
   every completion path (response, error, timeout, abort, close) funnels
   through `settlePending`; per-inbound-id `AbortController` map; the handler
   gets `RequestContext { id, signal }`; `$/cancelRequest` / `$/progress` are
   handled inside `handleNotification` before its first `await` (synchronous
   routing, §7). Exported `cancelledError(id)` (`name === "cancelled"`).
3. `daemon/src/proxy-model.ts`: `EventQueue` (unbounded, single consumer);
   `streamChunked` with `seq`/schema/count checks; signal listener → clean
   cancel; `MethodNotFound` probe + latch → batch fallback.
4. `daemon/src/connection.ts`: `requestModelStreamChunked`.
5. `client/src/remote-client.ts`: `onModelStreamChunked` with a 30 ms
   coalescer flushed synchronously before the result/error; optional `onError`.
6. `cli/src/serve.ts`: both senders wired into `ProxyModelProvider`.

**Drift from Implementation (and why):**
- `ModelTunnel` capability object → two constructor args
  (`ProxyModelProvider(send, sendChunked?)`). Same behaviour, fewer types; an
  absent `sendChunked` is byte-identical to the batch path.
- `RequestContext` also carries the inbound `id` (the plan's ctx had only
  `signal`; the responder needs the id to frame `$/progress`, Design note 3).
- `onError` is a 4th `RemoteClient` constructor arg (`{ onError? }`).
- The `"yes"` latch state was never set → removed (`"unknown" | "no"`).

**Review of the qwen code and fixes (claude-opus-5-5).** Gate was green but two
defects were found, each reproduced, red-tested, then fixed:
1. **§7 leak (pod is not trusted):** on a local provider error
   `onModelStreamChunked` rethrew `RpcError(InternalError, error.message)`, so
   the provider's message (endpoint, possibly key material) reached the pod;
   `model/stream` answers opaque `"internal error"`. Repro:
   ```
   model/stream        error seen by pod: internal error
   model/streamChunked error seen by pod: 401 from http://10.0.0.5:8080/v1 key=sk-SECRET
   ```
   Fix: rethrow the original error (not an `RpcError`) so the peer reports it
   to the laptop's `onError` and answers opaque — `remote-client.ts`
   (`onModelStreamChunked` catch). The cancel path still answers a fixed
   `"model stream cancelled"`.
2. **Disconnect did not stop the laptop model:** `handleClose` cleared
   `inboundCancel` without aborting, so a pod dying mid-round left the
   (single-slot) local LLM generating to the end. Repro: `after disconnect,
   laptop signal aborted = false`. Fix: abort every inbound controller in
   `handleClose` (`peer.ts`).
3. **`onError` was never wired:** no caller passed it, so Review #2's
   fail-silent surface stayed open in production. Fix: `LocalRuntimeDeps.
   onPeerError` → `RemoteClient` (`local-runtime.ts`); `run` and `attach`
   route it into the buffered pod stderr sink (`pod-runtime.ts`, flushed after
   unmount — never a raw write while Ink owns the terminal). Not wired for
   `connect`/in-process worker (no model tunnel there; no sink).
4. Comment fix: the coalescer delays the first event by up to one window too.

**Tests added (red on the qwen code where they pin a bug):**
- `transport/test/peer.test.ts` — close aborts in-flight inbound handler
  signals (**red** before fix 2).
- `client/test/remote.test.ts` — provider error is opaque to the pod and
  logged to `onError` (**red** before fix 1); disconnect aborts the laptop
  model (**red** before fix 2); `$/progress` seq 0..N-1 all before the result,
  `chunks`/`usage`, coalescer tail (plan #7, coverage); partial-then-throw
  through the real client (plan #5); disconnect makes daemon `stream()` throw
  (plan #6).
- `cli/test/local-runtime.test.ts` — a stray daemon frame reaches
  `onPeerError` (mutation: removing the wiring → red).
- **Non-vacuity of the qwen tests:** forcing the batch path in
  `ProxyModelProvider` turns 12 tests red (the deciding test and both
  end-to-end tunnel tests included); reverted.

**Gate:** `bun run check` → typecheck clean, lint 0/0, **713 pass, 1 skip
(opt-in live k8s), 0 fail**.

**Not done:** the acceptance run of `e2e-attach.ts` on `ubi9-sleep` (needs the
cluster + the local LLM). Known nits left: pre-aborted `request({signal})`
still notifies `$/cancelRequest` for an id never sent (harmless no-op);
`cancelledError` exists in both `peer.ts` and `proxy-model.ts`; a `seq`/count
failure fails the daemon stream but does not cancel the laptop request.

### Delta after Review #3 — real coalescing (owner decision: option A)

*— claude-opus-5-5, 2026-10-18*

**Why.** Review #3 finding 1: the qwen coalescer sent **one frame per event**
(`sendBatch` looped `notify` per item), so it added up to 30 ms of latency and
saved nothing; the "~6,480 → ~1,000 frames" claim (Design layer 4, Review #1)
was false. Owner choice between (A) real batching and (B) dropping the
coalescer: **A**, judged for many users in varied contexts — per-frame cost
(kube-apiserver exec WebSocket, high-latency/WAN links, fast cloud models,
parse + validation CPU) grows with scale; the wire shape is permanent once
shipped (version skew); and pieces 2–3 (tool output, potentially MB/s) ride
`$/progress`.

**Supersedes the Implementation on these points:**
- `$/progress` is **generic**: `ProgressParamsSchema.value` is `z.unknown()`;
  the envelope checks only `id` + `seq`. `WireProgressValueSchema` is removed.
  Each streaming method validates its own value — for `model/streamChunked`,
  `ModelStreamProgressValueSchema = z.array(WireStreamEventSchema).min(1)`
  (`protocol/src/model.ts`), checked in `ProxyModelProvider`.
- `seq` and the result's `chunks` count **frames**, not events.
- Laptop coalescer (`client/src/remote-client.ts`, `onModelStreamChunked`) is a
  **leading-edge throttle**: after a quiet period an event is sent at once (no
  added first-token latency), events within the next
  `MODEL_STREAM_COALESCE_MS` (30 ms) ride one frame, and a batch is closed
  before its serialized size exceeds `MODEL_STREAM_BATCH_MAX_CHARS` (64 Ki
  UTF-16 units, far below the ws-server's 8 MiB `maxFrameBytes`); one oversize
  event travels alone. Final flush stays synchronous before the result/error.

**Tests (red before, green after):** protocol — `$/progress` accepts any
value, model batch schema rejects a bare event/empty array; peer — a non-model
value routes unchanged; daemon — a multi-event frame yields all events in
order with `chunks` = frames, a bare-event/empty batch fails loudly (existing
tests moved to batch values); client — a 51-event burst arrives in ≤ 3 frames
with the first event alone, nothing lost, all before the result; the size cap
holds; after a quiet pause each event arrives within half a window.
**Mutations:** sending every event immediately → burst test red; no size cap →
cap test red; no leading edge → burst + pause tests red (the pause test first
passed this mutation — it checked frame shape only — and was strengthened to
measure latency). All reverted (`cmp` identical).

**Gate:** `bun run check` → typecheck clean, lint 0/0, **719 pass, 1 skip
(opt-in live k8s), 0 fail**. Acceptance `e2e-attach.ts` still not run.

### Acceptance end-to-end (kind, 2026-10-18)

*— claude-opus-5-5, 2026-10-18*

Run on the local **kind** cluster (`kind-kind`, node arm64, ns
`test-tentacle`; the OCP `ubi9-sleep` of the Context was unreachable). Pod
`pms-e2e` (`ubi9/ubi-minimal`, `sleep`), binary built from this tree with
`buildBinary(…, "bun-linux-arm64")` and copied to `/tmp/tentacle`; real
`tentacle serve --stdio --model-proxy` over k8s exec ↔ `RemoteClient` /
`RemoteSession`, same model (`Qwen3.8-27B-UD-Q6_K_XL`, llama.cpp). Pod deleted
afterwards. Script (from `.tentacle/tmp/pod-model-streaming-e2e/`, derived
from the Context Repro; adds an Esc mode and a skew run):

```ts
// usage: bun e2e.ts <podBinPath> <stream|esc>
import { RemoteClient, RemoteSession } from "@tentacle/client";
import { loadConfig } from "@tentacle/config";
import { PermissionBroker } from "@tentacle/core";
import type { ChatRequest, ModelProvider } from "@tentacle/core";
import { KubeClient, loadKubeClientOptions } from "@tentacle/k8s";
import { createModelProvider } from "@tentacle/providers";

const [bin = "/tmp/tentacle", mode = "stream"] = process.argv.slice(2);
setTimeout(() => { console.log("[timeout 300s]"); process.exit(2); }, 300_000);
const config = await loadConfig({ cwd: process.cwd(), scaffold: false });
const real = createModelProvider({
  provider: config.provider, baseURL: config.baseURL, model: config.model,
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
});
let t0 = 0; const marks: Record<string, number> = {};
const mark = (k: string) => { if (!(k in marks)) marks[k] = performance.now() - t0; };
let laptopEvents = 0;
const tapped: ModelProvider = {
  id: real.id,
  async *stream(req: ChatRequest) {
    mark("laptop: model request received");
    req.signal?.addEventListener("abort", () => mark("laptop: local model signal ABORTED"));
    try {
      for await (const ev of real.stream(req)) { laptopEvents++; mark(`laptop: local model first ${ev.type}`); yield ev; }
      mark("laptop: local model stream done");
    } catch (e) { mark(`laptop: local model stream threw (${(e as Error).name})`); throw e; }
    finally { mark("laptop: local model stream ended"); }
  },
};
const kube = new KubeClient(loadKubeClientOptions({ context: "kind-kind", namespace: "test-tentacle" }));
const channel = kube.openExec(
  { pod: "pms-e2e", command: [bin, "serve", "--stdio", "--model-proxy"] },
  { onStderr: (t) => process.stderr.write(`[pod] ${t}`) },
);
const client = new RemoteClient(channel, new PermissionBroker(), tapped, { onError: (e) => console.error(`[laptop rpc] ${e.message}`) });
await client.initialize();
const session = new RemoteSession(client);
const controller = new AbortController();
t0 = performance.now();
let n = 0; let last = "";
const prompt = "Write a ~400-word explanation of JSON-RPC 2.0 request/response/notification semantics.";
for await (const ev of session.send(prompt, controller.signal)) {
  mark(`TUI side: first ${ev.type}`); n++;
  if (ev.type === "turn_end") last = (ev as { reason: string }).reason;
  if (mode === "esc" && ev.type === "reasoning" && !controller.signal.aborted && performance.now() - t0 > 3000) {
    mark("TUI side: Esc (abort)"); controller.abort();
  }
}
mark("TUI side: turn done");
await new Promise((r) => setTimeout(r, 1500)); // let the laptop stream settle
for (const [k, v] of Object.entries(marks).sort((a, b) => a[1] - b[1])) console.log(`${(v / 1000).toFixed(2).padStart(7)}s  ${k}`);
console.log(`TUI-side events: ${n} · laptop model events: ${laptopEvents} · turn_end: ${last}`);
client.close(); process.exit(0);
```

**1. Streaming (new pod binary):**
```
   0.84s  laptop: local model first reasoning
   0.85s  TUI side: first reasoning        ← was 47.34s (Context)
  23.70s  laptop: local model first text
  23.72s  TUI side: first text
  28.08s  TUI side: first turn_end
TUI-side events: 3416 · laptop model events: 3415 · turn_end: end_turn
```
**2. Esc (abort 3 s into the round):**
```
   3.01s  TUI side: Esc (abort)
   3.01s  laptop: local model signal ABORTED
   3.01s  laptop: local model stream threw (AbortError)
   3.01s  TUI side: first turn_end
TUI-side events: 315 · laptop model events: 314 · turn_end: cancelled
```
The model stops in the same millisecond; the turn ends `cancelled`. The pod
logs one `[daemon] error: response for unknown request id: 1` — the laptop's
late cancel answer arriving after the daemon already settled the request
locally (designed, non-fatal; noise in the buffered pod stderr after each Esc).

**3. Version skew — new laptop + OLD pod binary** (the 2026-10-16
`~/.config/tentacle/bin/tentacle-bun-linux-arm64`, only `model/stream`): works
via the kept batch handler, and reproduces the original symptom:
```
   0.82s  laptop: local model first reasoning
  95.23s  TUI side: first reasoning
TUI-side events: 13184 · laptop model events: 13183 · turn_end: end_turn
```
(new daemon + old laptop is pinned by the `MethodNotFound` fallback unit tests;
no old laptop build was run end to end.)

### Delta 2 — the carried nits, fixed before merge (owner decision)

*— claude-opus-5-5, 2026-10-18*

1. **`usage` dropped from the `model/streamChunked` result**
   (`protocol/src/model.ts`, `client/src/remote-client.ts`): it duplicated the
   in-stream `done` event and was never read; on a `.strict()` result a
   redundant field becomes permanent once shipped (an old laptop sending it
   would be rejected by a daemon that later dropped it). Result is `{ chunks }`.
2. **A corrupt stream cancels the laptop request** (`daemon/src/proxy-model.ts`
   `streamChunked`): the tunnel request now owns an `AbortController`; the
   caller's abort is forwarded into it, and a `seq` gap/dup or an invalid batch
   aborts it too (→ `$/cancelRequest`), so the user's local model stops. It is
   present even with no caller signal (compaction).
3. **Pre-aborted `request({signal})` sends nothing** (`transport/src/peer.ts`):
   no `$/cancelRequest` for an id the peer never saw.
4. **One `cancelledError`** (`transport/src/peer.ts`, `id` optional), imported
   by `proxy-model.ts`.
5. **No log noise after Esc** (`transport/src/peer.ts`): the peer remembers the
   outbound ids it cancelled (bounded at 1024, oldest dropped; cleared on close)
   and discards their late response silently; a truly unknown id still reports.
   This removes the `[daemon] error: response for unknown request id` line the
   kind e2e showed after every Esc.

**Tests (red before each fix):** protocol — result with `usage` rejected;
client — burst result is exactly `{ chunks }`; daemon — seq gap and invalid
batch both abort the sender's signal with no caller signal; peer — pre-aborted
request puts nothing on the wire; a late answer to our cancel is silent while
an unknown id still reports. **Mutations:** dropping `tunnel.abort()` in
`fail` → daemon test red; dropping `rememberCancelled` → peer test red;
reverted (`cmp` identical). **Gate:** `bun run check` → typecheck clean, lint
0/0, **721 pass, 1 skip (opt-in live k8s), 0 fail**.

**Kind e2e re-run** (fresh binary, same script): Esc → model aborted at 3.02 s,
`turn_end: cancelled`, **no pod stderr line**; streaming → first reasoning at
0.22 s (laptop 0.21 s), `end_turn`, 9,261 events. Pod deleted.

## Review

*— claude-opus-5-5, 2026-10-17 (author of the Context; a different model must review before promotion — load-bearing)*

**Verdict: PROMOTE → `fix/pod-model-streaming`.** The design below is
recommended. The Implementation must still re-verify every cite.

1. **Two generic peer primitives, not per-method ones.** Both are additive.
   They are the reusable base that `rpc-flow-control` and `mcp-client-tools`
   build on.
   - **`$/cancelRequest { id }`** (notification, LSP-style).
     - `request(method, params, { signal })`: on abort it sends the
       notification and rejects locally with a `cancelled` RpcError, and
       removes the pending entry.
     - The receiver keeps an `AbortController` per inbound request id and passes
       its `signal` to `onRequest(method, params, { signal })`.
     - An old peer only logs it.
   - **`$/progress { id, seq, value }`** (notification): a responder streams
     partial values tied to the **request id**, so no separate `streamId`
     namespace is needed. `request(…, { onProgress })` receives them.
2. **A new method, `model/streamChunked`.** The name was confirmed by the owner
   on 2026-10-18; it is permanent once shipped.
   - The laptop handler forwards each local provider event as `$/progress`,
     **coalesced every ~30–50 ms**, so ~6,480 events become ~1,000 frames.
   - The final result is `{ chunks: N, usage? }`.
   - A new daemon tries it once per connection. On `MethodNotFound` it falls
     back to today's `model/stream` for the rest of the connection.
   - A new laptop keeps serving `model/stream` for old daemons.
3. **`ProxyModelProvider` becomes an async queue.**
   - It yields events as `$/progress` arrives. It ends only when the result has
     arrived **and** all `N` chunks, in `seq` order, have been yielded.
   - A gap, a duplicate `seq`, or a result whose `N` does not match what was
     received is a **loud error**, never a silently truncated reply.
   - It passes `request.signal` to `peer.request(…, { signal })`, so Esc
     propagates to the laptop's provider (`provider.stream({ …, signal })`).
4. **Error semantics mirror a local provider.**
   - Events received before an error are yielded first; then the stream
     throws.
   - A disconnect rejects the pending request, so the stream throws instead of
     hanging.
   - A late `$/progress` after a cancel is dropped.

**Failure modes the Implementation must cover:**
- result before the last chunk (reordering under concurrent dispatch);
- a `seq` gap or duplicate;
- cancel while chunks are in flight;
- cancel after the result (no-op);
- the model throws mid-stream;
- a disconnect mid-stream;
- an old laptop (`MethodNotFound` → fallback, with byte-identical behaviour to
  today);
- an old daemon (the laptop still serves `model/stream`);
- coalescing must never hold back the *last* events: flush on stream end and
  on error.

**Tests (red first):**
- **The deciding test**, red today: with a fake controlled provider, the first
  event is observed out of `ProxyModelProvider` **before** the provider
  completes.
- Fallback.
- Ordering and count.
- Cancel reaches the laptop provider's signal.
- Partial-then-throw.
- Disconnect.
- **Non-vacuity mutation:** restore the array batch; the deciding test must
  turn red.
- **End-to-end validation:** re-run `e2e-attach.ts` on `ubi9-sleep`. Expect
  the TUI side's first reasoning at ~0.4 s instead of ~47 s.

**§7 red-team points for the Review:**
- "Don't serialize the RPC peer": the per-id `AbortController` map and the
  progress routing must not add an await or a lock to dispatch.
- "Protocol changes are additive": two new notifications and one new method;
  no existing schema changes.
- "Model stays on the laptop": unchanged.

### Review #2 — fresh-context, different model

*— claude-fable-5-1, 2026-10-17*

**Verdict: APPROVE-WITH-NITS → PROMOTE to `fix/pod-model-streaming`.** The root
cause is correct, the two-primitive design is sound, and the four central
attacks (reordering under concurrent dispatch, fallback against old peers,
silent-drop, other consumers) all pass. Findings are a wrong line number and two
implementation cautions the promoted fix must honour — none change the verdict.

**Premise table:**

| Premise | Cite | Verdict |
|---|---|---|
| `onModelStream` collects all events, returns `{ events }` | `client/src/remote-client.ts:166-175` | TRUE (method is 165-174) |
| `ProxyModelProvider.stream` awaits send, then yields | `daemon/src/proxy-model.ts:50-55` | TRUE |
| `toWireRequest` drops the signal | `daemon/src/proxy-model.ts:15-42` | TRUE (no signal field) |
| `ChatRequest.signal` exists | `core/src/model.ts:34` | **FALSE line**: signal is `model.ts:53`; `:34` is `ChatMessage.toolCallId`. Minor |
| `request` takes no signal; no cancel message | `transport/src/peer.ts:79-108` | TRUE |
| Laptop `RpcPeer` has no `onError` (unknown notif dropped silently) | `client/src/remote-client.ts:64` | TRUE (only `onNotification`+`onRequest` wired) |
| Unknown method → `MethodNotFound` | `transport/src/peer.ts:196` | TRUE |
| Unknown notification → `reportError`, non-fatal | `transport/src/peer.ts:239-241` | TRUE |
| Results validated inbound | `transport/src/peer.ts:276-286` | TRUE |
| `ModelStreamParamsSchema` is `.strict()` | `protocol/src/model.ts:54` | TRUE; `ModelStreamResultSchema` is also `.strict()` (`:58-60`), so the "a new field on the result breaks an old peer" claim is TRUE too |
| Responses resolve synchronously; requests/notifs are `void` | `transport/src/peer.ts:184-191` | TRUE |
| `attach` skips the binary when `--version` preflight passes | `cli/src/pod-runtime.ts:400-417` | TRUE |
| `serve`/`connect` run the model inside the daemon | `cli/src/serve.ts:27-31` (`startDaemon`, no proxy) | TRUE |

**Attacks tried:**
1. *Can the final result be processed before the last `$/progress` under the
   peer's concurrent dispatch, truncating the reply?* — **No.** All frames ride
   ONE ordered channel; `receive()` classifies them synchronously
   (`peer.ts:183-191`), so the `$/progress` frames (sent before the result on the
   laptop, which flushes on stream-end) dispatch before the response resolves.
   The design's count-based completion ("end only when the result arrived AND all
   `N` chunks yielded in `seq` order") is a correct belt-and-suspenders even if a
   handler yielded. PASSES.
2. *Does `MethodNotFound` fallback actually work against an old daemon / old
   laptop given strict schemas + inbound result validation?* — **Yes.** A new
   method `model/streamChunked` is absent from an old laptop's registry, so
   `isMethodName` is false → `MethodNotFound` (`peer.ts:195-196`); the daemon
   falls back to today's `model/stream`. Inbound result validation only fires for
   *known* methods, and no existing strict schema is touched. A new laptop keeps
   serving `model/stream` for old daemons. PASSES.
3. *Any silent drop or synthesized/truncated state?* — **No synthesis.** `seq`
   gap/dup and count mismatch are loud errors (fail-loud, good). The one
   fail-silent surface: `$/cancelRequest` is received by the laptop peer, which
   has no `onError`; if the Implementation forgets to wire its handler the cancel
   silently no-ops. The listed test "cancel reaches the laptop provider's signal"
   covers it. `$/progress` is consumed daemon-side, where `onError` *is* wired
   (`connection.ts:75`), so a bad progress frame is logged. PASSES.
4. *Does anything besides `ProxyModelProvider` consume `model/stream` (e.g.
   `/compact`)?* — grep: only `connection.requestModelStream` →
   `ProxyModelProvider`. Compaction (`agent/src/compact.ts:63`) calls
   `model.stream(...)` through the *same* provider, so the async-queue redesign
   covers it. One caution (below). PASSES.

**Findings:**
1. NIT: `ChatRequest.signal` cite `core/src/model.ts:34` is wrong — it is
   `:53`.
2. IMPLEMENTATION CAUTION: the summarize/compaction sub-call builds its own
   `ChatRequest` (`compact.ts`) and flows through the redesigned
   `ProxyModelProvider`. Confirm it still terminates cleanly through the queue
   (it has no `signal`, which is fine, but the queue must not block waiting for a
   cancel path that never arrives).
3. IMPLEMENTATION CAUTION: coalescing must flush the final events **before** the
   method's result frame is sent, so the channel's ordering guarantee (progress
   before result) holds; the count check then verifies completeness. The plan
   says this ("flush on stream end and on error") — keep it load-bearing.

**Simpler design considered:** reuse `model/stream` + `$/progress` without a new
method. Rejected for the same reason the author gives: the laptop cannot detect a
new vs old daemon, so it would either double-send (progress + full batch) or need
a field on the `.strict()` result. The new-method probe is the correct additive
choice, and the generic `$/progress`/`$/cancelRequest` primitives are rightly
reused by pieces 2 and 3.

**Not independently re-run:** `e2e-attach.ts` (47 s claim). The single-slot local
LLM makes it a ~50 s run, and the symptom is structurally entailed by
`onModelStream` collecting all events before replying — the code fully supports
the measured number, so I did not spend the budget on it.

### Review #3 — fresh-context, post-execution

*— claude-fable-5-1, 2026-10-18*

**Verdict: APPROVE-WITH-NITS.** The as-built code matches the Implementation,
the gate is green, the two opus-5-5 fixes (§7 error-leak, disconnect→abort) and
the `onPeerError` wiring are all real and pinned by non-vacuous tests. Every
load-bearing property I attacked holds. The four findings are low/trivial
inaccuracies and acknowledged debt — none change the verdict or need a code
change to merge.

**Gate (re-run by me, clean tree):** `bun run check` → typecheck clean, lint
0 errors / 0 warnings (256 files), `bun test` **713 pass · 1 skip · 0 fail**
(the skip is the opt-in live-k8s one; AGENTS §6 baseline). Touched-file subset
re-run after all mutations reverted: 54 pass / 0 fail.

**Premise table (key cites re-opened against source):**

| Premise | Cite | Verdict |
|---|---|---|
| Responses resolved synchronously; requests/notifs dispatched `void` (ordering + §7) | `transport/src/peer.ts:268-276` | TRUE |
| `$/progress` / `$/cancelRequest` routed synchronously, before any `await`, in `handleNotification` | `peer.ts:347-358` | TRUE (map lookup + `abort()`/`onProgress()`; no lock/await) |
| Inbound-id `AbortController` map is sync set/delete around the handler | `peer.ts:296-330` | TRUE |
| `close()` aborts every inbound controller (fix 2) | `peer.ts:224-228` | TRUE |
| New method only; no existing strict schema gains a field | `protocol/src/model.ts:77-112`, `methods.ts:41,49-50,71-82` | TRUE; `PROTOCOL_VERSION` stays 1 |
| `ClientCapabilitiesSchema` untouched (old daemon accepts new laptop) | `session.ts` + `methods.test.ts:88-107` | TRUE |
| stdio pod path passes no `requestTimeoutMs` (long rounds safe) | `cli/src/serve.ts:96-100` | TRUE (`new Connection` with no options) |
| `ChatRequest.signal` exists | `core/src/model.ts:53` | TRUE (Context's `:34` was a known NIT, fixed in Review #2) |
| Agent maps mid-stream abort → `turn_end: cancelled` only when `signal?.aborted` | `agent/src/agent.ts:233-241` | TRUE |
| Esc chain: hosted-session controller aborts the turn signal on cancel | `daemon/src/hosted-session.ts:97-100,131` | TRUE |
| Compaction consumes the same provider; builds its own request w/ optional signal | `agent/src/compact.ts:60-63,98-101` | TRUE (no-signal → queue ends on result+count) |
| Daemon error default is opaque; real message → `onError` (fix 1) | `peer.ts:304-324`, `remote-client.ts:270-282` | TRUE |

**Mutation non-vacuity (each reverted byte-identical; hashes + `git diff --stat`
re-checked clean after all four):**
1. `peer.ts` — delete the `handleClose` inbound-abort loop → **2 red**
   (`peer.test.ts` "close aborts in-flight inbound handler", `remote.test.ts`
   "disconnect mid-round aborts the laptop's local model"). Pins fix 2.
2. `remote-client.ts` — rethrow the provider error as `RpcError(msg)` instead of
   opaque → **1 red** (`remote.test.ts` §7 opaque-error test saw
   `sk-SECRET`). Pins fix 1.
3. `proxy-model.ts` — force the batch latch (`chunked = "no"`) → **14 red**
   (the deciding test, ordering/seq/count, and both end-to-end tunnel tests).
   Pins the whole chunked-streaming path.
4. `local-runtime.ts` — drop the `onPeerError` wiring → **1 red**
   (`local-runtime.test.ts` stray-frame test). Pins the production wiring that
   closed Review #2's fail-silent surface.

**Attacks tried (≥3):**
1. *Can a result resolve/truncate before all `$/progress` are routed under
   concurrent dispatch?* **No.** The laptop flushes synchronously
   (`remote-client.ts:242-248,283-285`) before returning the result, the single
   channel is FIFO, and the daemon routes each `$/progress` synchronously in its
   own `receive()` before the result frame's `handleResponse`. The count check
   (`proxy-model.ts:248-258`) is a loud belt-and-suspenders. `remote.test.ts`
   pins `seqs === [0..N-1]` with the result resolving after. HOLDS.
2. *What can a malicious pod do via the new primitives (§7 pod-not-trusted)?*
   (a) `$/cancelRequest` — the laptop's `inboundCancel` is keyed only by ids the
   pod itself sent, so it can cancel only its own model/permission requests;
   cancelling a permission request aborts a signal `onPermission` ignores →
   no-op. (b) `$/progress` to the laptop — routed to the laptop's *outbound*
   pending, none of which set `onProgress` → dropped. (c) Error leak — fix 1
   makes the pod see opaque `"internal error"` while the real message goes only
   to the laptop's local `onError` sink (mutation 2 confirms). (d) Flood — the
   unbounded queue is daemon-side (in the pod); the laptop has none, so the pod
   cannot grow laptop memory. No cross-request interference found. HOLDS.
3. *Does the `MethodNotFound` fallback ever double-produce or the non-MNF error
   silently fall back?* **No.** MNF is returned before any `$/progress`, so
   `stream()` yields nothing then retries batch once and latches
   (`proxy-model.ts:170-189`); any event-after-yield failure is a non-MNF error
   that rethrows (never a batch retry). Fallback + "non-MNF propagates" tests
   pin both. HOLDS.
4. *Does §7 "don't serialize the peer" survive the new routing?* The
   concurrency regression test (`peer.test.ts` "dispatch stays concurrent")
   routes a `$/progress` for a request whose handler never resolves — passes.
   The only added sync work on the dispatch path is a strict `safeParse` per
   event (CPU, no lock/await). HOLDS.
5. *Cancel end-to-end → clean `turn_end: cancelled`?* Traced through the real
   stack in `remote.test.ts` "Esc reaches the laptop local provider's signal":
   abort → `session/cancel` → hosted controller → agent `request.signal` →
   provider signal listener fails the queue with the `cancelled` marker **and**
   the peer sends `$/cancelRequest` → laptop inbound controller aborts the local
   provider; the turn ends `cancelled`, not errored. HOLDS.

**Findings (numbered; none blocking):**
1. **NIT (low) — the coalescer does not reduce frame count as claimed.**
   `remote-client.ts:235-241` (`sendBatch`) emits **one** `$/progress` frame per
   event (`value` is a single `WireStreamEvent`), so the wire still carries
   ~6,480 frames; the comment `remote-client.ts:49-56` and the design/Review
   text ("~6,480 events become ~1,000 frames") overstate it. The only runtime
   effect is up to one 30 ms window of added **first-event** latency (already
   acknowledged, Execution note 4). Harmless at ~0.4 KB/s; to actually coalesce,
   `$/progress.value` would have to carry an array. Cosmetic/rationale fix only.
2. **NIT (low) — a `seq`/count failure fails the daemon stream but does not
   cancel the laptop request** (`proxy-model.ts:227-239,247-258`): on a (should-
   never-happen) gap/dup/mismatch the queue throws, but the outbound
   `peer.request` is not aborted, so the laptop model keeps generating and the
   pending settles only when the laptop finally replies; with no
   `requestTimeoutMs` on the stdio path a *hung* laptop would leak that pending.
   Corruption-only path; already listed in Execution "Not done".
3. **NIT (trivial) — duplicated `cancelledError`** in `peer.ts:435` and
   `proxy-model.ts:153` (acknowledged), and **`ModelStreamChunkedResult.usage`
   is unused by the daemon** (`proxy-model.ts:248-258` ignores `result.usage`;
   usage reaches the agent via the in-stream `done` event). Dead but harmless
   additive field.
4. **NIT (trivial) — pre-aborted `request({signal})` still notifies
   `$/cancelRequest`** for an id never put on the wire (`peer.ts:157-162`);
   harmless no-op on the peer, acknowledged.

**What holds:** root cause, the two-primitive additive design, ordering, loud
correctness (gap/dup/count/invalid all throw after draining), the full cancel
chain, both version-skew directions, the §7 invariants (additive protocol, model
stays on the laptop, no peer serialization, opaque errors to the untrusted pod,
no raw terminal writes — `onPeerError` routes to the buffered stderr sink,
`pod-runtime.ts:291,477`), and compaction through the same queue.

**How the executors behaved:** qwen3.8-27b produced the bulk with two real
defects (the §7 error-leak and the disconnect-no-abort), both load-bearing —
exactly the high-blast × weak-model risk AGENTS §10 warns about. claude-opus-5-5
caught, reproduced, red-tested, and fixed all three (incl. the never-wired
`onError`), and the Execution section is honest about the drift and the
remaining nits. The tests are strong and genuinely non-vacuous (4/4 mutations
red). I am claude-fable-5-1 — a different family from the executors and from
Review #1's opus author, same family as Review #2 (fresh context); the
load-bearing §7 routing was re-attacked directly here.

**Not verified by me:** the `e2e-attach.ts` acceptance run on `ubi9-sleep`
(cluster + single-slot local LLM unavailable to this review) — the streaming and
cancel behaviour it would measure is, however, pinned by the in-memory
end-to-end tests in `remote.test.ts`.

### Review #4 — coalescing delta

*— claude-fable-5-1, 2026-10-18*

**Verdict: APPROVE-WITH-NITS.** The option-A delta resolves Review #3 finding 1:
coalescing is now real (a burst becomes one frame per window, `seq`/`chunks`
count frames), the leading-edge throttle removes the added first-token latency,
the size cap is correct and conservative, and fail-loud is preserved at the
model layer despite the generic `z.unknown()` envelope. No new load-bearing
defect. Two NITs, both non-blocking. Scope reviewed: only the delta (protocol
`$/progress`/`ModelStreamProgressValueSchema`, `ProxyModelProvider` batch
validation + frame counting, the `remote-client.ts` leading-edge coalescer);
`peer.ts` and `local-runtime.ts` are byte-unchanged from Review #3.

**Gate (re-run by me):** `bun run check` → typecheck clean, lint 0/0, `bun test`
**719 pass · 1 skip · 0 fail**. Delta-touched files after all mutations reverted:
56 pass / 0 fail.

**Mutation non-vacuity (each reverted byte-identical; hashes re-checked):**
1. `remote-client.ts` — drop the leading-edge immediate send (open the window
   only) → **2 red** (the burst test's "first frame = [e0] alone", and the
   quiet-pause latency test). Pins the leading edge.
2. `remote-client.ts` — remove the size-cap pre-flush → **1 red** (the size-cap
   test: a frame exceeded `MODEL_STREAM_BATCH_MAX_CHARS` and the oversize event
   did not travel alone). Pins the cap.
3. `proxy-model.ts` — count events instead of frames (`received +=
   parsed.data.length`) → **1 red** (the "one frame carrying a batch … chunks
   counts FRAMES" test, via the count-mismatch guard). Pins frame-accounting.
   No vacuous delta test found.

**Attacks tried (delta-specific):**
1. *Ordering / loss at window boundaries and at end/error/cancel; a stray timer
   or a `notify` after the result?* **No.** `flush()` (`remote-client.ts:274-280`)
   `clearTimeout`s the window and sends the final batch synchronously on **every**
   exit — normal (`:310`) and catch (`:296`) — with no `await` between the clear
   and the `return`/`throw`, so no timer survives the handler and no `$/progress`
   can follow the result frame. `onWindowEnd` (`:252-258`) nulls `window` before
   re-arming (so never two live timers) and re-arms only when the batch is
   non-empty; `sendBatch` (`:243-251`) early-returns on an empty batch, so no
   empty frame and no spurious `seq`/`chunks`. All frames ride the one ordered
   channel before the result (Review #3 ordering argument, unchanged). HOLDS.
2. *Size accounting — UTF-16 vs `maxFrameBytes`, envelope overhead, one oversize
   event.* Units are consistent: `JSON.stringify(event).length` and the peer's
   `maxFrameBytes` check (`peer.ts` `data.length`) are both UTF-16 code units,
   and `MODEL_STREAM_BATCH_MAX_CHARS` (64 Ki) ≪ the 8 Mi ws-server cap, so the
   un-counted ~100-char JSON-RPC envelope is swallowed by the >100× margin.
   `batchChars` counts the `value` array and over-counts by exactly one comma
   (a separator for the first element too, `:260`) — conservative, flushes
   marginally early, never late. A big-event split and a single oversize event
   travelling alone are both pinned (mutation 2 red). HOLDS.
3. *Does `value: z.unknown()` on the generic envelope open anything for a
   malicious pod or weaken fail-loud?* **No.** The envelope still strictly
   validates the routing key (`id` min-1 + `seq` int≥0, `.strict()`,
   `protocol/src/model.ts`); only `value` is opaque at the peer. Fail-loud for
   model data is kept by `ModelStreamProgressValueSchema =
   z.array(WireStreamEventSchema).min(1)` validated in `ProxyModelProvider`
   (`proxy-model.ts:236-240`): a bare event, an empty array, or an invalid event
   fails the stream loudly (daemon tests + the "count events" mutation confirm
   the backstop is load-bearing). A malicious pod's `$/progress` to the laptop
   routes to the laptop's outbound pendings, none of which set `onProgress`, so
   any value is dropped unread. HOLDS.
4. *Latency-test flakiness (`performance.now`, `< COALESCE_MS/2`).* Low. The
   quiet-pause test (`remote.test.ts:279-318`) separates the leading-edge path
   (sub-millisecond over the in-memory channel) from a windowed send (30 ms) with
   a 15 ms threshold; mutation 1 drives the removed-leading-edge case to ~30 ms
   and the test fails (182 ms run), so the margin discriminates correctly.
   Residual flake only on a pathologically loaded host; the 15 ms midpoint is a
   sensible choice. Acceptable.

**Findings (numbered; none blocking):**
1. **NIT (low) — the generic `$/progress` envelope no longer bounds `value`**
   (`protocol/src/model.ts`, `value: z.unknown()`). For `model/streamChunked`
   this is backstopped by `ModelStreamProgressValueSchema` in the daemon
   (fail-loud, verified). But the reusable primitive now relies on **every**
   future consumer (pieces 2–3: tool output, remote tool calls) validating its
   own `value` before trusting it — a consumer that routes `$/progress` without
   a per-method validator would accept arbitrary data. Deliberate tradeoff for a
   generic primitive; worth a one-line contract note where `ProgressParams` is
   defined so the next implementer does not miss it.
2. **NIT (trivial) — `batchChars` over-counts by one comma** (`remote-client.ts:260`,
   `+ 1` separator applied to the first element too). Harmless and in the safe
   direction (the real serialized size is always ≤ `batchChars`), so the cap is
   never exceeded; purely cosmetic.

**Carried from Review #3 (unchanged by the delta):** findings #2 (a `seq`/count
failure does not cancel the outbound laptop request), #3 (`cancelledError`
duplicated; `ModelStreamChunkedResult.usage` unused by the daemon), #4
(pre-aborted `request({signal})` still notifies `$/cancelRequest`) all still
stand as low/trivial debt.

**What holds:** real frame coalescing with no first-token latency penalty, the
size cap (split + oversize-alone), frame-accurate `seq`/`chunks`, loud
correctness on bad/empty/mis-counted batches, ordering (all progress before the
result; no post-result notify; no stray timer), the generic-but-validated
`$/progress` design, and every §7 invariant Review #3 confirmed (additive
protocol — `PROTOCOL_VERSION` still 1, no existing strict schema gains a field;
model stays on the laptop; no peer serialization; opaque errors to the untrusted
pod; no raw terminal writes).

**How the executor behaved:** claude-opus-5-5 implemented the owner's option A
cleanly, moved the existing daemon tests to batch values, added genuinely
non-vacuous burst/size/latency tests (and, per the Execution note, strengthened
the pause test after catching that its first form passed a no-leading-edge
mutation — honest and correct). The delta doc accurately states what it
supersedes. I am claude-fable-5-1 (same reviewer as Reviews #2/#3, fresh
context; a different family from the executor); the generic-envelope and
ordering/boundary risks were re-attacked directly here.

**Not verified by me:** the `e2e-attach.ts` acceptance run on `ubi9-sleep`
(cluster + local LLM unavailable) — unchanged from Review #3.

### Review #5 — nits delta

*— claude-fable-5-1, 2026-10-18*

**Verdict: APPROVE.** Delta 2 cleanly closes the Review #3/#4 carried nits. The
load-bearing attack — a corrupt stream being mis-reported to the agent as a
clean cancel (or vice-versa) — does not happen: the `cancelled` flag and the
settled-once queue keep the two outcomes distinct. The `cancelledIds` silencing
cannot be abused by the pod and cannot hide a genuine unknown-id or a live
response. `usage` removal is safe (all-unreleased, nothing sends it). No
remaining findings beyond the two long-standing low/trivial items, one of which
Delta 2 now fixes.

**Scope:** only Delta 2 — `peer.ts` (pre-abort sends nothing; single
`cancelledError(id?)`; `cancelledIds` Set + silent late-answer discard),
`proxy-model.ts` (`tunnel` AbortController; `fail()` aborts it),
`protocol/model.ts` + `remote-client.ts` (`usage` dropped from the chunked
result). `local-runtime.ts`, `connection.ts`, `serve.ts`, `pod-runtime.ts`
unchanged since Review #4.

**Gate (re-run):** typecheck clean · lint 0/0 · `bun test` **721 pass · 1 skip
(opt-in live-k8s) · 0 fail**. Touched-file subset after all mutations reverted:
62 pass / 0 fail.

**Mutation non-vacuity (4; each reverted byte-identical — hashes re-checked):**
1. `proxy-model.ts` — drop `tunnel.abort()` in `fail()` → **1 red** (daemon
   "a corrupt stream … also CANCELS the laptop request"). Pins the corrupt→cancel
   wiring.
2. `peer.ts` — drop `rememberCancelled(id)` in `onAbort` → **1 red** (peer
   "a late response to a request WE cancelled is discarded silently"; the stray
   unknown-id line reappeared). Pins the silencing.
3. `peer.ts` — make the pre-aborted branch send `$/cancelRequest` → **1 red**
   (peer "already-aborted signal … nothing on the wire" saw a frame). Pins
   fix 3.
4. `protocol/model.ts` — re-add `usage` to the strict chunked result → **1 red**
   (protocol "strict params/result"; the schema now accepted `usage`). Pins the
   removal. No vacuous delta test found.

**Attacks tried:**
1. *Corrupt-stream abort vs the `cancelled` flag and queue-settle ordering —
   could a gap/dup/invalid batch be mis-reported to the agent as a clean cancel,
   or a real cancel as a failure?* **No.** On a corrupt stream `onProgress`
   calls `fail(err)` = `finish("fail", err)` **then** `tunnel.abort()`
   (`proxy-model.ts:208-211,233-241`); `cancelled` stays **false**, so the queue
   settles once with the *gap/invalid* error (not `cancelledError`). The
   `tunnel.abort()` then rejects the outbound promise with the peer's
   `cancelledError`, but `promise.then`'s reject handler (`:265-272`) is a
   microtask and `queue.fail` is idempotent, so it is a no-op — the gap error
   survives. The agent's own signal is **not** aborted (the caller did not
   cancel), so `agent.ts:237` rethrows → a **loud failed turn**. Conversely a
   real cancel sets `cancelled = true` and fails with `cancelledError` while the
   caller signal **is** aborted → `turn_end: cancelled`. The two outcomes never
   cross. HOLDS.
2. *`cancelledIds` abuse / hiding a real error (pod-controlled ids, id reuse,
   late ERROR response).* **No.** `rememberCancelled` is called only from our own
   `onAbort` with our own outbound `id` (`peer.ts:164-166`), so a pod cannot make
   us record arbitrary ids; the Set is bounded at 1024 oldest-dropped and cleared
   on close (`:187-195,250`). `nextId` is monotonic, so a remembered id can never
   collide with a live pending, and `handleResponse` checks the **live pending
   first** (`:394`) before the silence set — a live response is never silenced. A
   late *error* response to a cancelled id is correctly silenced too (it answers a
   request we abandoned); a genuinely unknown id still reports (test + mutation 2).
   HOLDS.
3. *Listener leaks on the caller signal across many agentic rounds.* **No.** Each
   round adds one `abort` listener (`proxy-model.ts:219`) and `finish()` removes
   it on **every** termination path (close, count-fail, reject, gap/invalid), with
   `{ once: true }` as a backstop; only the current round's listener is ever
   attached. The pre-aborted branch adds no listener. HOLDS.
4. *Version skew of removing `usage`.* **Safe.** `model/streamChunked` is entirely
   unreleased, so no shipped peer sends `usage`; grep confirms no code/test sends
   it, and the laptop returns `{ chunks }` only (`remote-client.ts:307`). The
   `done` event's `usage` still reaches the agent in-stream (it is forwarded as a
   normal `$/progress` event, `remote-client.ts:287`), so nothing is lost. HOLDS.
5. *Pre-aborted request (compaction with an already-aborted signal) — wire
   behaviour.* The peer sends nothing (`peer.ts:168-173`, test asserts an empty
   wire); the daemon's `streamChunked` still calls the sender with an
   already-aborted `tunnel.signal`, which the peer rejects without a frame, and
   the queue (already failed with `cancelledError`) drains to a clean cancel.
   HOLDS.

**Findings (none blocking):**
1. **NIT (low) — carried Review #4 finding 1 stands:** the generic `$/progress`
   envelope is `value: z.unknown()` (`protocol/src/model.ts`), backstopped for the
   model path by `ModelStreamProgressValueSchema` in the daemon; future consumers
   (pieces 2–3) must each validate their own `value`. Unchanged by Delta 2;
   worth a one-line contract note at `ProgressParams`.
2. **Resolved — carried Review #3 finding #2** (a `seq`/count failure did not
   cancel the laptop request): Delta 2 fixes it via `fail()` → `tunnel.abort()`
   (pinned by mutation 1). Review #3 finding #3 (`ModelStreamChunkedResult.usage`
   unused) is also resolved by the field's removal; the duplicate `cancelledError`
   (#3) and the pre-abort `$/cancelRequest` (#4) are resolved by fixes 4 and 3.

**What holds:** corrupt→loud-failure vs cancel→clean-cancel separation, the
laptop model stops on a corrupt stream (no generating for nobody), no
`$/cancelRequest` for an id the peer never saw, bounded abuse-proof
`cancelledIds` with no live-response or unknown-id masking, no listener leak, and
every §7 invariant from Reviews #3/#4 (additive protocol — `PROTOCOL_VERSION`
still 1; model stays on the laptop; no peer serialization — the new
`cancelledIds`/`rememberCancelled` work is synchronous map/set work in
`handleResponse`/`request`, no await or lock; opaque errors to the pod).

**How the executor behaved:** claude-opus-5-5 implemented the five nit fixes
exactly as the owner specified, each with a red-first test and the two
self-reported mutations (both independently re-confirmed red here), and
correctly kept the `cancelled`-flag/idempotent-settle discipline that makes the
corrupt-vs-cancel distinction hold. The Delta 2 doc is accurate. I am
claude-fable-5-1 (same reviewer as Reviews #2/#3/#4, fresh context; a different
family from the executor); the corrupt-vs-cancel ordering and the `cancelledIds`
abuse surface were re-attacked directly.

**Not verified by me:** the kind/`ubi9-sleep` e2e runs the Execution reports
(Esc at 3.02 s with no pod stderr line; first reasoning at 0.22 s) — no cluster
access; the behaviour is pinned by the in-memory peer/daemon/client tests.
