# eval/pod-model-streaming — in pod mode the TUI sees nothing until the whole model round is done

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promote to `fix/pod-model-streaming`.
> **Type:** eval → fix · **Size:** M · **Blast:** load-bearing (protocol + the §7 model-tunnel seam + `transport/peer.ts`) · **Suited:** a strong model executes; mandatory fresh-context Review, ideally by a different model family.
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

- `docs/eval/proxy-model-cancel.md` (CONFIRMED): cancel does not stop the
  model, and the requested tool still runs. This eval closes the model half.
  The agent-loop half stays there.
- `TODO.md` F4.d.2, cited above.
- `docs/fix/steering-over-rpc.md`: a different defect that compounds this one
  (see the umbrella).

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

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
