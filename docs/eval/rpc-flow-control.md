# eval/rpc-flow-control — large payloads block every other message on the pod channel

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promote to `feat/rpc-flow-control`.
> **Type:** eval → feat · **Size:** M–L · **Blast:** load-bearing (`transport/peer.ts` send path, every runtime's channel) · **Suited:** a strong model executes; mandatory fresh-context Review by a different model.
> **Umbrella:** [`remote-execution-model.md`](./remote-execution-model.md) (piece 2 of 4).
> **Needs:** [`pod-model-streaming.md`](./pod-model-streaming.md) — this builds on its `$/progress` and `$/cancelRequest` peer primitives.
> **Needed by:** [`mcp-client-tools.md`](./mcp-client-tools.md) for large tool results (soft: a laptop-side cap is a stopgap); [`../feat/pod-attach-resilience.md`](../feat/pod-attach-resilience.md) (a keepalive must not wait behind bulk data).

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** how should the RPC layer carry a large payload
(a tool result of several MB, a big snapshot) so that it does not freeze
everything else on the same channel: streaming updates, permission prompts,
cancel, keepalive? Which flow-control mechanism actually works on the k8s exec
path?

### Why it matters

Every runtime multiplexes all RPC traffic over **one ordered TCP stream**:
- the worker's MessagePort;
- the WebSocket for `serve`/`connect`;
- the k8s exec WebSocket for `run`/`attach`.

A frame is sent whole (`peer.sendFrame` → `channel.send`). A large frame
therefore delays every frame queued after it: head-of-line blocking. The peer
has a defensive `maxFrameBytes` (TODO Block 4, 2026-10-14), but no way to send
something big *without* blocking. Today this hits tool results and snapshots.
With laptop-side MCP tools (`mcp-client-tools.md`), multi-MB results such as
playwright snapshots or page dumps will cross this channel routinely.

### Repro (measured)

*2026-10-17, OCP cluster, ns `tentacle`, pod `ubi9-sleep` (UBI9), from
`.tentacle/tmp/remote-execution-spike/`.* The echo server is `cat` in the pod,
over the **same** stack tentacle uses (`KubeClient.openExec`, `execChannel`,
`v4.channel.k8s.io`). The round trip is the cost of any reverse RPC; direction
does not matter for latency. The numbers come from 3–4 runs; the
"clean" column is the run with no other tentacle sharing the link.

```ts
// rtt.ts — small-frame RTT, and a ping queued right behind a big single frame
import { KubeClient, loadKubeClientOptions } from "@tentacle/k8s";
const pod = process.env.SPIKE_POD;
if (!pod) throw new Error("set SPIKE_POD");
const ns = process.env.SPIKE_NS;
const container = process.env.SPIKE_CONTAINER;
const kube = new KubeClient(loadKubeClientOptions(ns ? { namespace: ns } : {}));
const ch = kube.openExec(
  { pod, ...(container ? { container } : {}), command: ["cat"] },
  { onStderr: (t) => process.stderr.write(`[pod stderr] ${t}`), onStatus: (t) => process.stderr.write(`[status] ${t}\n`) },
);
const waiters = new Map<string, (t: number) => void>();
ch.setOnMessage((line) => {
  const id = line.slice(0, line.indexOf(" ") >>> 0 || line.length);
  waiters.get(id)?.(performance.now());
});
ch.setOnClose(() => console.log("[channel closed]"));
const echo = (id: string, payload = ""): Promise<number> =>
  new Promise((resolve) => {
    const t0 = performance.now();
    waiters.set(id, (t1) => { waiters.delete(id); resolve(t1 - t0); });
    ch.send(payload ? `${id} ${payload}` : id);
  });
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? NaN;
const fmt = (n: number) => `${n.toFixed(1)}ms`;
const tOpen = performance.now();
await echo("warm");
console.log(`open + first echo: ${fmt(performance.now() - tOpen)}`);
const rtts: number[] = [];
for (let i = 0; i < 100; i++) rtts.push(await echo(`p${i}`, '{"jsonrpc":"2.0","id":1,"method":"tool/call","params":{}}'));
console.log(`small RTT x100: p50 ${fmt(pct(rtts, 50))} · p95 ${fmt(pct(rtts, 95))} · p99 ${fmt(pct(rtts, 99))} · max ${fmt(Math.max(...rtts))}`);
for (const mb of [1, 5]) {
  const big = "x".repeat(mb * 1024 * 1024);
  const bigP = echo(`big${mb}`, big);
  const pingP = echo(`hol${mb}`, "{}");
  const [bigMs, pingMs] = await Promise.all([bigP, pingP]);
  console.log(`${mb} MB frame echo: ${fmt(bigMs)} (≈${((2 * mb * 8) / (bigMs / 1000)).toFixed(1)} Mbit/s round-trip) · ping queued behind it: ${fmt(pingMs)}`);
}
ch.close();
process.exit(0);
```
```ts
// chunked.ts — does CHUNKING alone fix head-of-line, or does it need PACING?
// A) 5 MB as 20×256 KB chunks sent at once, ping after chunk 1.
// B) same chunks, at most W in flight (wait for each echo = end-to-end ack).
import { KubeClient, loadKubeClientOptions } from "@tentacle/k8s";
const kube = new KubeClient(loadKubeClientOptions({ namespace: process.env.SPIKE_NS ?? "tentacle" }));
const ch = kube.openExec({ pod: process.env.SPIKE_POD ?? "ubi9-sleep", command: ["cat"] });
const waiters = new Map<string, () => void>();
ch.setOnMessage((line) => { const sp = line.indexOf(" "); waiters.get(sp < 0 ? line : line.slice(0, sp))?.(); });
const echo = (id: string, payload = ""): Promise<number> => new Promise((res) => {
  const t0 = performance.now(); waiters.set(id, () => { waiters.delete(id); res(performance.now() - t0); });
  ch.send(payload ? `${id} ${payload}` : id);
});
await echo("warm");
const CHUNK = "x".repeat(256 * 1024), N = 20;
{
  const t0 = performance.now(); const all: Promise<number>[] = [];
  all.push(echo("a0", CHUNK)); const ping = echo("pingA", "{}");
  for (let i = 1; i < N; i++) all.push(echo(`a${i}`, CHUNK));
  const p = await ping; await Promise.all(all);
  console.log(`A burst  : ping ${p.toFixed(0)}ms · 5 MB total ${(performance.now() - t0).toFixed(0)}ms`);
}
for (const W of [1, 2, 4]) {
  const t0 = performance.now(); let pingMs = 0; let next = 0; let pingSent = false;
  const inflight = new Set<Promise<number>>();
  while (next < N || inflight.size > 0) {
    while (next < N && inflight.size < W) {
      const p = echo(`b${W}_${next++}`, CHUNK); inflight.add(p); p.then(() => inflight.delete(p));
      if (!pingSent) { pingSent = true; echo(`pingB${W}`, "{}").then((ms) => { pingMs = ms; }); }
    }
    await Promise.race(inflight);
  }
  await new Promise((r) => setTimeout(r, 50));
  console.log(`B paced W=${W}: ping ${pingMs.toFixed(0)}ms · 5 MB total ${(performance.now() - t0).toFixed(0)}ms`);
}
ch.close(); process.exit(0);
```
```ts
// backpressure.ts — is LOCAL socket backpressure (ws.bufferedAmount, as
// exec-run.ts uses) enough, or do we need an end-to-end (protocol) ack window?
import { KubeClient, type WebSocketLike, loadKubeClientOptions } from "@tentacle/k8s";
let sock: WebSocketLike | undefined;
const base = loadKubeClientOptions({ namespace: process.env.SPIKE_NS ?? "tentacle" });
const inner = base.makeWebSocket;
if (!inner) throw new Error("no makeWebSocket in kube options");
const kube = new KubeClient({ ...base, makeWebSocket: (url, protocols) => (sock = inner(url, protocols)) });
setTimeout(() => { console.log("[timeout 120s]"); process.exit(2); }, 120_000);
const ch = kube.openExec({ pod: process.env.SPIKE_POD ?? "ubi9-sleep", command: ["cat"] });
const waiters = new Map<string, () => void>();
ch.setOnMessage((line) => { const sp = line.indexOf(" "); waiters.get(sp < 0 ? line : line.slice(0, sp))?.(); });
const echo = (id: string, payload = ""): Promise<number> => new Promise((res) => {
  const t0 = performance.now(); waiters.set(id, () => { waiters.delete(id); res(performance.now() - t0); });
  ch.send(payload ? `${id} ${payload}` : id);
});
await echo("warm");
const CHUNK = "x".repeat(256 * 1024), N = 20;
for (const HW of [256 * 1024, 1024 * 1024]) {
  const t0 = performance.now(); const all: Promise<number>[] = []; let ping: Promise<number> | undefined;
  for (let i = 0; i < N; i++) {
    while ((sock?.bufferedAmount ?? 0) >= HW) await new Promise((r) => setTimeout(r, 5));
    all.push(echo(`c${HW}_${i}`, CHUNK));
    if (i === 0) ping = echo(`pingC${HW}`, "{}");
  }
  const p = await ping; await Promise.all(all);
  console.log(`C bufferedAmount<${HW / 1024}KB: ping ${p?.toFixed(0)}ms · 5 MB total ${(performance.now() - t0).toFixed(0)}ms · bufferedAmount reported: ${sock?.bufferedAmount !== undefined}`);
}
ch.close(); process.exit(0);
```

Clean run (no other tentacle on the link):
```
open + first echo: 277.9ms
small RTT x100: p50 47.5ms · p95 113.9ms · p99 154.5ms · max 154.5ms
1 MB frame echo: 1336.5ms (≈12.0 Mbit/s round-trip) · ping queued behind it: 1335.8ms
5 MB frame echo: 3717.1ms (≈21.5 Mbit/s round-trip) · ping queued behind it: 3713.0ms
A burst  : ping 1260ms · 5 MB total 5495ms
B paced W=1: ping 262ms · 5 MB total 5446ms
B paced W=2: ping 240ms · 5 MB total 4944ms
B paced W=4: ping 422ms · 5 MB total 3914ms
C bufferedAmount<256KB: ping 1329ms · 5 MB total 5207ms · bufferedAmount reported: true
C bufferedAmount<1024KB: ping 612ms · 5 MB total 4450ms · bufferedAmount reported: true
```

Ping delay behind 5 MB, ranges across all runs:

| Strategy | Ping waits | 5 MB total |
|---|---|---|
| one frame | 3.7–4.1 s | 3.7–4.1 s |
| A. 256 KB chunks, burst | 0.70–1.27 s | 4.0–8.4 s |
| **B. end-to-end window W=1** | 0.26–0.44 s | 4.5–6.1 s |
| **B. end-to-end window W=2** | **0.20–0.34 s** | 2.9–8.7 s |
| B. end-to-end window W=4 | 0.28–0.43 s | 2.6–14.8 s |
| C. local `bufferedAmount` < 256 KB | 1.25–1.68 s | 5.2–6.7 s |
| C. local `bufferedAmount` < 1 MB | 0.55–0.76 s | 3.2–5.4 s |

*(One aborted run is excluded: my script replaced the kube TLS
`makeWebSocket` (`loadKubeClientOptions` returns one) with a plain
`WebSocket`, so the connection never opened. It was fixed and re-run.)*

### What the numbers say

1. **A reverse RPC is cheap:** p50 ≈ 47 ms, p99 ≈ 155 ms. That is not the
   problem.
2. **Head-of-line blocking is linear in payload size,** about 0.8–1.3 s per MB
   on this path. A 5 MB result freezes streaming, permission prompts, cancel
   and keepalive for about 4 s.
3. **Chunking alone is not enough (A),** and **local backpressure is not
   enough (C).** The bytes buffer *between* the endpoints (apiserver, kubelet,
   routers), where `bufferedAmount` cannot see them. Only an **end-to-end**
   window (B) bounds the wait.
4. **W=2 × 256 KB is the sweet spot:** control messages wait about 0.2–0.35 s
   with throughput comparable to a burst. W=4 is faster for bulk transfers but
   worse for control messages.
5. **Throughput varies 2–3× between runs** on a shared link. The design must
   adapt; an ack-driven window does, by construction.

### Code facts

- `transport/src/peer.ts:79-108`: `request` sends one frame.
  `handleRequest` (`:194-233`) sends the whole `result` as one frame.
- `k8s/src/exec-run.ts:16-35,209-217`: the one-shot binary transfer already
  gates on `bufferedAmount`. That is fine for a single bulk transfer with
  nothing else in flight, but the measurement shows it does not protect a
  concurrent control message.
- `DuplexChannel` (`transport/src/channel.ts:9-18`) has no notion of priority
  or backpressure.

### Prior art

- `docs/eval/oversize-frame-hang.md`: an oversized frame hangs instead of
  failing. This eval turns the defensive cap into a real transport rule.
- `docs/feat/pod-attach-resilience.md`: a keepalive is a control message, so
  it needs the priority lane below.

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-17 (author; a different model must review before promotion)*

**Verdict: PROMOTE → `feat/rpc-flow-control`, after
`fix/pod-model-streaming`.** Recommended design:

1. **Chunked results over `$/progress`** (the primitive from
   `pod-model-streaming`).
   - A responder whose result serialises above a threshold (proposal: 256 KB)
     sends it as `$/progress { id, seq, value: <slice> }` chunks, followed by a
     small final result `{ chunked: { count, bytes, sha256? } }`.
   - The requester reassembles the chunks and verifies count and bytes. A
     mismatch is a loud error.
   - This needs a negotiation, because an old peer cannot reassemble:
     - per-method opt-in, i.e. only new methods (`tool/call`) are ever chunked;
       or
     - a `$/capabilities` probe (a new method, `MethodNotFound` on old peers).
     - The proposal is per-method opt-in: simpler, and nothing old ever sees a
       chunked result.
2. **An end-to-end credit window.**
   - The sender keeps at most **W=2** chunks un-acked.
   - The receiver acks with `$/ack { id, seq }`, at most one notification per
     chunk.
   - The window is ack-driven, so it adapts to the link (finding 5).
3. **A control-priority lane in the peer's send path.**
   - Bulk chunks wait in a peer-side queue gated by the window, and are never
     pushed straight to `channel.send`.
   - Control frames (requests/responses without chunking, `session/update`,
     `$/cancelRequest`, `$/ack`, keepalive) bypass that queue.
   - The worst-case wait for a control frame is therefore about W × 256 KB of
     transfer time (the measured 0.2–0.35 s), not the whole payload.
   - This must not serialize *dispatch* (§7). It only orders *outbound bytes*.
4. **Cancel mid-transfer:** `$/cancelRequest` stops the sender's queue for that
   id, and the receiver drops the partial buffer.

**Failure modes:**
- lost or duplicate ack;
- the receiver closes mid-transfer;
- cancel mid-transfer;
- two large transfers at once: round-robin between ids so neither starves;
- an ack flood. Acks are tiny, but they are control frames;
- the in-process MessagePort runtime, where none of this is needed: the
  threshold can be per-channel, effectively off for `messagePortChannel`.

**Tests:**
- head-of-line bound: with a fake channel at a fixed byte rate, a control frame
  sent during a 5 MB result arrives within W × chunk time;
- reassembly integrity;
- window adherence: never more than W chunks un-acked;
- cancel;
- fairness between two transfers;
- a mutation that removes the window: the head-of-line test goes red;
- end-to-end: re-run the spike scripts through the real peer instead of raw
  `cat`.

**Not verified:**
- the cost of the ack round trips on a high-latency link, beyond this one;
- whether W should adapt dynamically. The proposal is fixed W=2 first, and to
  measure before adding any adaptivity.
