# eval/binary-frames — bytes as bytes on every `DuplexChannel` (and whether live media needs a non-TCP path)

> **Status:** owner verdict 2026-11-20 (all recs, Q2 = clean break) — slices BF2…BF5 queued
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Each slice below opens its own `feat/`/`fix/` branch when promoted.
> **Type:** eval · **Size:** — (umbrella; slices sized in §Slices) · **Blast:** load-bearing (transport seam, protocol, relay) · **Suited:** Opus (plan); per-slice in §Slices
> **Changelog:** none (an eval ships no code; each slice names its own fragment)
> **Answers:** `TODO.md` `eval/binary-frames`. Sizes and **revises** the `B1`/`B2` rows of `docs/eval/realtime-media.md:511-512` (see §C7). Consistent with `docs/eval/attachments-audio-video.md` §8 and `docs/eval/mobile-polar.md` (see §C7).

## Context

*— claude-opus-5-5, 2026-11-20*

### C1. The question

Owner, 2026-11-13: *"ogni efficientamento è da perseguire"*. Owner, 2026-11-20:
does realtime voice/audio/video (and sensor streams) need a **non-TCP** path?

This eval decides:

- **Q1 — Carrier.** How does each `DuplexChannel` carry an opaque binary frame
  next to the JSON-RPC text frames, without a second session path and without
  serializing the RPC peer?
- **Q2 — Payload.** How does a request reference its bytes (`blob/*`), and what
  replaces base64 in `attachment/put` and `artifact/read`?
- **Q3 — Safety.** How are frame size, memory and buffering bounded when the far
  end is a pod (not trusted) or a hostile relay?
- **Q4 — Order and value.** Which slices, in which order, each with its measured
  gain.
- **Q5 — Transport class.** Stay on TCP (WebSocket, unix socket, k8s exec) for
  live media, or add a UDP/QUIC/WebRTC path?

### C2. Today, verified against the code (`main` @ 95b18f14)

| Fact | Source |
|---|---|
| `DuplexChannel` moves **text frames only**: `send(data: string)`, `setOnMessage((data: string) => void)`. | `packages/transport/src/channel.ts:9-18` |
| `RpcPeer` writes every frame as `JSON.stringify(<object>)`, so every RPC frame starts with `{` (0x7B). It applies `maxFrameBytes` (if set), then `JSON.parse`, then dispatches requests **concurrently** (`void this.handleRequest`). | `packages/transport/src/peer.ts:272-273, 280-292, 322` |
| `attachment/put`: one base64 chunk per request, 256 KiB raw → 349 528 chars, schema-validated by regex. The client encodes with our pure-JS `encodeBase64`. The daemon decodes with `Buffer.from(…, "base64")`. | `packages/protocol/src/attachment-upload.ts:26-47`; `packages/client/src/remote-client.ts:2516`; `packages/daemon/src/attachment-store.ts:246` |
| Upload window W = 2 chunks in flight. This is the measured sweet spot for control-frame latency during an upload. | `packages/client/src/upload-window.ts:20`; `docs/eval/rpc-flow-control.md` (W=2: ping 0.20–0.34 s during a 5 MB upload; burst: 1.26 s) |
| `artifact/read` result: one base64 chunk (≤ 349 528 chars), offset aligned to 256 KiB; artifact cap 20 MiB. | `packages/protocol/src/artifact.ts:45, 134-159` |
| **Pod daemons hold artifacts** (memory host, pod-supplied). So bytes do **leave** a pod, pod → laptop, over the stdio/exec byte stream. | `packages/daemon/src/artifact-store.ts:11, 39-40, 56` |
| Pods receive **no** uploaded bytes: images/documents to a pod are `input: "client"` (refs only; the laptop holds the bytes). | `packages/protocol/src/session.ts:251-283`; `docs/feat/attachments-prompt.md:30-31` |
| **In-process worker:** `messagePortChannel`, string frames only; a non-string `data` is ignored. | `packages/transport/src/port-channel.ts:15-16, 31-35, 50-53` |
| **WebSocket, client** (`connect`, the phone, the relay legs): `WebSocketChannel` stringifies any non-string (`String(data)`). | `packages/client/src/ws-channel.ts:9-33` |
| **WebSocket, server** (`serve`): `WsChannel`; `message.toString()` on a binary frame. Peer `maxFrameBytes` = 8 MiB. Backpressure: close at 16 MiB. Bun `maxPayloadLength` is **not set** (Bun default). | `packages/daemon/src/ws-server.ts:107, 113-131, 204-249, 347, 355-356`; `packages/daemon/src/device-accept.ts:34` |
| **Byte streams** (`serve --stdio`, the pod resident's unix socket): `streamChannel`, newline-delimited, decoded into a JS **string** buffer. | `packages/transport/src/stream-channel.ts:28-55`; users `packages/cli/src/serve.ts:1363`, `packages/cli/src/pod-resident.ts:304, 552` |
| **k8s exec** (`v4.channel.k8s.io`): a binary WebSocket underneath (`binaryType = "arraybuffer"`). Stdin = `[0x00, …frame\n]`; stdout is reassembled on `\n` into a **string** buffer (`ExecDemux`). Blank stdin line every 15 s as keepalive. v4 cannot half-close stdin (AGENTS §7). | `packages/k8s/src/exec-channel.ts:84-93, 186-199`; `packages/k8s/src/exec-frame.ts:20-22, 43-66` |
| The k8s/docker exec **already carries raw bytes** elsewhere (`exec-raw`: NUL and split UTF-8 survive). | `packages/k8s/src/exec-raw.ts:7-17`; `packages/docker/src/exec-raw.ts:1-10` |
| **docker/podman exec**: stdin `${json}\n`; stdout via `StdDemux` (Docker's 8-byte stream header), then the same newline split into a **string**. | `packages/docker/src/exec-channel.ts:1-20, 52, 195-208, 270-281` |
| **The pod bridge is a dumb byte pipe** (stdin ⇄ unix socket ⇄ stdout, "no frame parsing"). | `packages/cli/src/pod-resident.ts:10-12` |
| **All three byte-stream readers are unbounded.** They append to a string until a `\n` arrives (`buffer += …`). The laptop-side peer sets **no** `maxFrameBytes` (only the `serve` WS server, the device path and the relay leg set one). A pod that writes one endless line grows laptop memory without limit. Each chunk also re-`slice`s the whole buffer, which is quadratic on large frames. | `stream-channel.ts:44-54`; `exec-frame.ts:56-63`; `docker/exec-channel.ts:198-208`; `rg maxFrameBytes` → only `ws-server.ts:347`, `device-accept.ts:187`, `relay-link.ts:776` |
| **Noise E2E channel** (phone): each Noise message (≤ 65 535 B) goes on the wire as text `t1:` + base64. The plaintext is one type byte (`0x00` continuation, `0x01` final, `0x02` confirm) + ≤ 65 518 B of the UTF-8 RPC frame. A whole RPC frame is chunked and emitted synchronously. Nonces are strictly sequential (needs an ordered carrier). | `packages/transport/src/noise-frame.ts:11-20, 100-129`; `packages/transport/src/noise-channel.ts:179-197, 234-244`; `packages/transport/src/noise.ts:16-18` |
| The `noise-frame.ts:30` comment ("Hermes has neither `Buffer`/`btoa` for certain") is stale for `btoa`: Hermes has had native `atob`/`btoa` since RN 0.74, and the app is on RN 0.88. | `docs/eval/realtime-media.md:44`; `apps/mobile/package.json:34` |
| **Relay** (`apps/relay`): text only. A binary frame closes both legs with `1003`. Text frames over 96 Ki chars close both legs. `maxPayloadLength` = 96 KiB is set so Bun cannot allocate a large frame before the handler runs (H1). It never decrypts. | `apps/relay/src/server.ts:148-171, 424-449`; `packages/protocol/src/relay.ts:40, 97-106` |
| Daemon side of a relay leg: a plain `DuplexChannel` over the leg socket, then the **same** `acceptDevice` as `/e2e`, with an inbound decode guard. | `packages/daemon/src/relay-link.ts:742-751, 766-789` |
| **React Native 0.88 `WebSocket`** supports binary: `send(ArrayBuffer \| view)` and `binaryType = "arraybuffer"`. Across the native bridge, though, it moves binary as **base64**: JS `base64-js.fromByteArray` on send and `toByteArray` on receive. So the *wire* is binary, but the phone's JS thread still pays a base64 pass. | `apps/mobile/node_modules/react-native/Libraries/WebSocket/WebSocket.js:187-207, 244-249`; `…/Utilities/binaryToBase64.js:12-28` |
| The phone already reads photo/PDF bytes as `Uint8Array` (`expo-file-system` `File.bytes()`), so no base64 comes from native today. | `apps/mobile/src/photo-source.ts:99, 204`; `apps/mobile/src/pdf-source.ts:103` |
| The phone dials through the shared `WebSocketChannel` + the Noise decorator. The app's wrappers (`foreground-gate`, the pairing `tracked` channel) re-implement `DuplexChannel` by hand. | `apps/mobile/src/connection.ts:282-306, 324-336`; `apps/mobile/src/foreground-gate.ts:72-117`; `apps/mobile/src/pairing-flow.ts:459-466` |
| Replay ring: 4 MiB per session, of `session/update` frames only. Blobs never enter it (they are requests/responses, not updates). | `packages/daemon/src/hosted-session.ts:309, 953` |
| `initialize` already carries capability objects. They are strip schemas, and unknown values are fail-soft. | `packages/protocol/src/session.ts:221-283` |
| `PROTOCOL_VERSION` = 24; `RELAY_PROTOCOL_VERSION` = 1; `E2E_CHANNEL_VERSION` = 1 (bound in the Noise prologue). | `packages/protocol/src/version.ts:32`; `relay.ts:40`; `noise-channel.ts:33-34` |

### C3. Measured: wire bytes and CPU per path (2026-11-20)

The spike runs the repo's own framing code (`encodeBase64`, `chunk`,
`encodeFrame`/`decodeFrame`, `Reassembler`, the `AttachmentPutParamsSchema`
zod parse) and `@noble` ChaCha20-Poly1305 with the same chunking. Bun 1.4.3,
arm64 (the owner's Mac). Random (incompressible) bytes. CPU is single-run wall
time, warm, and indicative only (±20 %).

**Repro** — `.tentacle/tmp/binary-frames/bench.ts` (run: `bun bench.ts` from that dir):

```ts
// eval/binary-frames — wire bytes + CPU per path, using the repo's own framing code.
import { chacha20poly1305 } from "../../../packages/transport/node_modules/@noble/ciphers/chacha.js";
import { chunk, encodeBase64, encodeFrame, decodeFrame, Reassembler, MAX_CHUNK } from "../../../packages/transport/src/noise-frame.ts";
import { AttachmentPutParamsSchema } from "../../../packages/protocol/src/attachment-upload.ts";

const CHUNK = 256 * 1024;
const key = new Uint8Array(32).fill(7);
let ctr = 0n;
const seal = (pt: Uint8Array) => { const n = new Uint8Array(12); new DataView(n.buffer).setBigUint64(4, ctr++, true); return chacha20poly1305(key, n).encrypt(pt); };
const open = (ct: Uint8Array, i: bigint) => { const n = new Uint8Array(12); new DataView(n.buffer).setBigUint64(4, i, true); return chacha20poly1305(key, n).decrypt(ct); };

function blob(n: number) { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; }
const ms = (t: number) => (performance.now() - t).toFixed(1);

function run(label: string, size: number) {
  const b = blob(size);
  const id = "a".repeat(64);
  // A: today's JSON-RPC text frames (WS text / stdio line): one attachment/put per 256 KiB.
  let t = performance.now(); let wsBytes = 0; const frames: string[] = [];
  for (let off = 0, i = 0; off < size; off += CHUNK, i++) {
    const f = JSON.stringify({ jsonrpc: "2.0", id: i, method: "attachment/put", params: { sessionId: "s_0123456789abcdef", id, size, offset: off, data: encodeBase64(b.subarray(off, off + CHUNK)) } });
    frames.push(f); wsBytes += f.length; // ASCII: chars == bytes
  }
  const encA = ms(t);
  t = performance.now();
  for (const f of frames) { const p = JSON.parse(f); AttachmentPutParamsSchema.parse(p.params); Buffer.from(p.params.data, "base64"); }
  const decA = ms(t);
  // B: today's phone path: same RPC frame → Noise chunks → seal → t1:+base64 text.
  t = performance.now(); let noiseBytes = 0; const nf: string[] = []; ctr = 0n;
  for (const f of frames) for (const pt of chunk(f)) { const s = encodeFrame(seal(pt)); nf.push(s); noiseBytes += s.length; }
  const encB = ms(t);
  t = performance.now(); { const r = new Reassembler(32 << 20); let i = 0n; for (const s of nf) r.push(open(decodeFrame(s), i++)); }
  const decB = ms(t);
  // C: outer base64 removed (Noise message as a WS binary frame): same plaintext, sealed bytes on the wire.
  let cBytes = 0; ctr = 0n; t = performance.now();
  for (const f of frames) for (const pt of chunk(f)) cBytes += seal(pt).length;
  const encC = ms(t);
  // D: binary blob frames: 16-byte header + raw chunk (WS binary), + one small JSON open/ack per blob.
  const HDR = 16; let dBytes = 300; t = performance.now();
  for (let off = 0; off < size; off += CHUNK) { const part = b.subarray(off, off + CHUNK); const fr = new Uint8Array(HDR + part.length); fr.set(part, HDR); dBytes += fr.length; }
  const encD = ms(t);
  // E: D inside Noise (binary blob frame sealed, WS binary): + 17 B per Noise message (tag+type).
  let eBytes = 300; ctr = 0n; t = performance.now();
  for (let off = 0; off < size; off += CHUNK) { const part = b.subarray(off, off + CHUNK); for (let p = 0; p < part.length; p += MAX_CHUNK) { const pt = new Uint8Array(1 + Math.min(MAX_CHUNK, part.length - p)); pt.set(part.subarray(p, p + MAX_CHUNK), 1); eBytes += seal(pt).length; } eBytes += HDR; }
  const encE = ms(t);
  const r = (n: number) => `${(n / size).toFixed(3)}×`;
  console.log(`\n## ${label}: ${size} B raw (${Math.ceil(size / CHUNK)} chunks)`);
  console.log(`A WS/stdio JSON+base64 text : ${wsBytes} B ${r(wsBytes)} · enc ${encA} ms · dec+zod+b64 ${decA} ms`);
  console.log(`B phone Noise t1:+base64     : ${noiseBytes} B ${r(noiseBytes)} · enc+seal ${encB} ms · open+dec ${decB} ms`);
  console.log(`C Noise outer b64 removed    : ${cBytes} B ${r(cBytes)} · enc+seal ${encC} ms`);
  console.log(`D WS binary blob frames      : ${dBytes} B ${r(dBytes)} · frame ${encD} ms`);
  console.log(`E Noise + binary blob frames : ${eBytes} B ${r(eBytes)} · seal ${encE} ms`);
}
run("warm-up", 512 * 1024);
run("2 MB photo", 2_000_000);
run("15 MiB audio memo / image cap", 15 * 1024 * 1024);
console.log(`\nBun ${Bun.version}, ${process.arch}`);
```

Output (2026-11-20; warm-up block omitted):

```
## 2 MB photo: 2000000 B raw (8 chunks)
A WS/stdio JSON+base64 text : 2668343 B 1.334× · enc 16.7 ms · dec+zod+b64 1.8 ms
B phone Noise t1:+base64     : 3558986 B 1.779× · enc+seal 25.3 ms · open+dec 12.5 ms
C Noise outer b64 removed    : 2669125 B 1.335× · enc+seal 9.0 ms
D WS binary blob frames      : 2000428 B 1.000× · frame 0.1 ms
E Noise + binary blob frames : 2001074 B 1.001× · seal 7.8 ms

## 15 MiB audio memo / image cap: 15728640 B raw (60 chunks)
A WS/stdio JSON+base64 text : 20984282 B 1.334× · enc 109.3 ms · dec+zod+b64 11.2 ms
B phone Noise t1:+base64     : 27988392 B 1.779× · enc+seal 205.7 ms · open+dec 98.4 ms
C Noise outer b64 removed    : 20990402 B 1.335× · enc+seal 75.4 ms
D WS binary blob frames      : 15729900 B 1.000× · frame 0.7 ms
E Noise + binary blob frames : 15735000 B 1.000× · seal 54.8 ms

Bun 1.4.3, arm64
```

**Sustained streams** — `.tentacle/tmp/binary-frames/stream.ts`. Wire bit rate
per framing for a `media/frame`-style notification. The bit rates count our
frame bytes only (WS header 2–14 B, TLS ≈ 29 B/record and TCP/IP are extra and
equal across columns):

```ts
// Sustained streams: bytes/s on the wire per framing (computed with the repo's framing code).
import { encodeBase64, encodeFrame, chunk } from "../../../packages/transport/src/noise-frame.ts";
const TAG = 16;
function rates(label: string, payloadBytes: number, perSec: number, jsonPayload?: string) {
  const b = new Uint8Array(payloadBytes).map((_, i) => (i * 37) & 255);
  const body = jsonPayload ?? JSON.stringify({ data: encodeBase64(b) });
  const rpc = JSON.stringify({ jsonrpc: "2.0", method: "media/frame", params: { stream: 3, seq: 123456, ...JSON.parse(body) } });
  const ws = rpc.length;
  const noiseText = chunk(rpc).reduce((n, pt) => n + encodeFrame(new Uint8Array(pt.length + TAG)).length, 0);
  const bin = 12 + payloadBytes; // binary frame header + payload
  const noiseBin = 1 + TAG + bin;
  const k = (n: number) => `${((n * perSec * 8) / 1000).toFixed(1)} kbit/s`;
  console.log(`${label.padEnd(34)} JSON text ${k(ws).padStart(12)} · Noise t1 ${k(noiseText).padStart(12)} · binary ${k(bin).padStart(12)} · Noise binary ${k(noiseBin).padStart(12)}  (payload ${k(payloadBytes)})`);
}
rates("Opus 32 kbit/s, 20 ms frames", 80, 50);
rates("PCM16 16 kHz mono, 20 ms frames", 640, 50);
rates("JPEG 1 fps 100 KB (look/push)", 100_000, 1);
const ecg = JSON.stringify({ samples: Array.from({ length: 130 }, (_, i) => -1200 + ((i * 97) % 2400)) });
rates("ECG 130 Hz, 1 s JSON batch", 130 * 3, 1, ecg);
rates("HR+RR 1 Hz JSON batch", 8, 1, JSON.stringify({ hr: 152, rr: [402, 398] }));
```

```
Opus 32 kbit/s, 20 ms frames       JSON text  77.2 kbit/s · Noise t1 113.2 kbit/s · binary  36.8 kbit/s · Noise binary  43.6 kbit/s  (payload 32.0 kbit/s)
PCM16 16 kHz mono, 20 ms frames    JSON text 376.4 kbit/s · Noise t1 513.2 kbit/s · binary 260.8 kbit/s · Noise binary 267.6 kbit/s  (payload 256.0 kbit/s)
JPEG 1 fps 100 KB (look/push)      JSON text 1067.4 kbit/s · Noise t1 1423.8 kbit/s · binary 800.1 kbit/s · Noise binary 800.2 kbit/s  (payload 800.0 kbit/s)
ECG 130 Hz, 1 s JSON batch         JSON text   5.5 kbit/s · Noise t1   7.6 kbit/s · binary   3.2 kbit/s · Noise binary   3.4 kbit/s  (payload 3.1 kbit/s)
HR+RR 1 Hz JSON batch              JSON text   0.8 kbit/s · Noise t1   1.3 kbit/s · binary   0.2 kbit/s · Noise binary   0.3 kbit/s  (payload 0.1 kbit/s)
```

**Reading the numbers.**

- **Bytes.** Base64 costs exactly 1.334× on every text hop and **1.779×** on the
  phone. Removing the outer base64 (C) gives 1.335×. Binary blob frames give
  1.000× on WS (D) and 1.000× inside Noise (E, +17 B per 64 KiB message).
- **Time on a 5 Mbit/s phone uplink** (bytes × 8 / 5e6, ignoring TCP slow-start):

| Payload | Today (B) | Outer base64 removed (C) | Blob frames (E) |
|---|---|---|---|
| 2 MB photo | 3.56 MB · **5.7 s** | 2.67 MB · 4.3 s | 2.00 MB · **3.2 s** |
| 15 MiB memo/image | 28.0 MB · **44.8 s** | 21.0 MB · 33.6 s | 15.7 MB · **25.2 s** |

  On `connect` (WS, no Noise) a 15 MiB blob goes from 21.0 MB to 15.7 MB.
- **CPU on Bun.** Encode+seal for 15 MiB on the phone path drops from 206 ms to
  55 ms (3.7×), and the receiver's open+decode from 98 ms to the AEAD only. The
  zod regex over a 349 528-char string, the `JSON.stringify` copy and the string
  round-trip all disappear with blob frames.
- **CPU on the phone is NOT measured here.** Hermes has no JIT; our estimate is
  10–30× Bun for pure-JS loops [E]. And RN's `WebSocket` base64-encodes binary
  frames across the bridge itself (C2). So on the phone, removing *our* outer
  base64 trades it for RN's `base64-js`: wire −25 %, JS CPU ≈ unchanged until a
  native binary WebSocket exists. Experiment E2 (§Tests) measures this.
- **Streams.** The non-media rates are tiny. ECG at 130 Hz is 7.6 kbit/s as JSON
  through Noise today, and 3.4 kbit/s as binary. Binary frames are irrelevant
  for sensors; batching already dominates. For voice audio, binary halves Opus
  (113 → 44 kbit/s) and cuts PCM16 by half as well (513 → 268 kbit/s). But in the
  approved architecture **no live audio crosses our wire** (§C6).
- **Head-of-line on one TCP connection.** One 256 KiB chunk occupies a 5 Mbit/s
  link for 0.75 s on the phone today (466 KB), 0.56 s as base64 WS text, and
  0.42 s as binary. W=2 pacing (`docs/eval/rpc-flow-control.md`) still bounds the
  wait of a control frame. Binary frames shorten that wait by 25–44 %; they do
  not remove it. **Only pacing/chunk size does.**

### C4. Constraints (AGENTS §7) every answer must keep

1. **One session path.** Binary is a capability of the channel under the one
   `RemoteClient` ↔ `Connection` stack. It is never a parallel loop or a media
   session code path.
2. **Don't serialize the peer.** Blob frames go to a `BlobMux` next to `RpcPeer`,
   never through request dispatch, and never behind a lock. A 15 MiB transfer
   must not delay a `session/enqueue` or `session/resolve_permission` by more
   than one chunk on the wire.
3. **Protocol honesty.** Strip schemas and capability objects at `initialize`.
   Pre-public breaking changes are allowed when cleaner, through a
   `protocol.d/<slug>.md` note (never an edit of `PROTOCOL_VERSION`).
4. **A pod is not trusted.** Every length is checked **before** allocation.
   Every buffer is bounded. A pod cannot make the laptop buffer without limit
   (which, today, it can: C2).
5. **The relay never sees plaintext,** and keeps its H1 memory bound
   (`maxPayloadLength`).
6. **The model stays on the laptop.** No bytes go **into** a pod (refs only);
   bytes come **out** of a pod (artifacts) under laptop-side caps.

### C5. Constraints from the other evals

- `realtime-media` (owner-approved order, Q9): voice first; blobs only on the
  hops that carry bytes; gated on E1/E2. Chunks shrink to 16–32 KiB while a live
  lane is open.
- `attachments-audio-video` (owner verdict 2026-11-15): v1 audio is
  **edge-transcribed**, so the original never leaves the device. So the "15 MiB
  audio memo" row of C3 is the *later* native-audio case (option C there), which
  is gated on B2.
- `mobile-polar`: `sensor/push` is batched JSON (≤ 1 batch/s/channel, ≤ 512 KB
  per call, the 8 MiB frame cap). C3 shows binary saves < 5 kbit/s there, so
  nothing changes.

### C6. Non-TCP for live media (owner's added question, 2026-11-20)

**What `realtime-media` already decided** (`docs/eval/realtime-media.md:184-192,
291-300, 447-472`, owner-approved):

- Candidate A (audio over the session pipe) is **rejected** for live audio,
  because of TCP head-of-line and the pod hairpin.
- Voice is an **edge cascade** (B/B+). Mic, VAD, STT, TTS and barge-in run on
  the device that has the mic. Only **text** (a transcript into
  `session/prompt`, deltas out of `session/update`) crosses our wire.
- Where UDP matters (option C, S2S), the **provider's** WebRTC edge is the far
  end. The SDP goes through the key holder (unified interface), and we host no
  UDP media plane.
- Live vision is **pull** (`look`: one frame as an image ref over the blob
  plane).

**What that means for TCP vs UDP.**

- On our wire, the realtime traffic is small text frames: a transcript of
  ~100 B, and deltas of ~15 chars/s coalesced every 30 ms.
- On a lossy mobile link, TCP turns a lost segment into a stall of ≈ 1 RTT with
  fast retransmit, or ≥ 1 RTO (≥ 200 ms) on a tail loss. That is 60–200 ms on
  the phone path.
- Against turn budgets of 0.55–3.3 s (realtime-media §5), and a client-side
  TTS that buffers a clause anyway, that stall is inaudible in B/B+.
- HOL **caused by our own blobs** is the real risk. It is fixed by pacing (W=2,
  smaller chunks during voice), not by UDP.

**What a non-TCP path would cost us** (each weighed for our stack):

| Axis | UDP/QUIC (WebTransport, datagrams) | WebRTC (SRTP + data channels) |
|---|---|---|
| Latency/jitter gain | Removes HOL across streams. Datagrams are unordered and unreliable, which is ideal for 20 ms audio frames. Gain: only on paths that carry live audio/video **between our endpoints**, and today there are none. | Same, plus a jitter buffer, Opus FEC/PLC and platform AEC built in. |
| Bun server | Experimental `http3` since 1.3.14, "do not deploy to production"; **no WebTransport** (realtime-media §4, [V] 2026-05). The IETF draft is still moving: `draft-ietf-webtrans-http3-17`, 2026-11. [?] Not re-checked on 1.4.3. | Bun has no WebRTC stack. Options: a pure-TS stack (`werift`, CPU-heavy for media) or a **native sidecar** (Pion/libdatachannel), i.e. a new binary to ship and sign, like the Swift voice helper. |
| iOS / React Native | **No WebTransport in RN** (realtime-media §4). Raw QUIC needs a native module (Network.framework). | `react-native-webrtc` works in a dev build (we are one: `expo-dev-client`). New-Architecture forks ship in 2026 (Cloudflare's needs RN ≥ 0.84). Experiment E8 already exists. |
| NAT traversal / relay | UDP to a laptop behind NAT needs ICE/STUN, and **TURN** when symmetric NAT or a corporate/cellular CGNAT blocks it. So the relay becomes a TURN server (coturn or Pion-turn), a new hosted service with UDP ports and its own abuse limits. Today it only forwards WS text. | Same (ICE + TURN). |
| E2E (relay never sees plaintext) | QUIC TLS terminates at whoever serves it. With a TURN-style relay it stays E2E only if the endpoint pair runs its own handshake over datagrams. | DTLS-SRTP is E2E between the peers, and TURN sees ciphertext. **But** the DTLS fingerprints must be bound to our Noise identity: exchange the SDP **over the existing Noise session RPC**, never via the relay in clear. Otherwise a relay could MITM the media. |
| AGENTS §7 fit | Fits only as a *transport*: a `MediaChannel` opened by an RPC (`media/open` over the session → SDP/params), carrying media frames only, never RPC, never a session. Control stays on the one `RpcPeer`. | Same seam. Signalling = RPC on the existing session; media = the side channel; the broker and permissions unchanged. |
| Complexity | Very high today (no server, no RN client). | High: a native sidecar + TURN + the fingerprint binding + E8. |

**Recommendation: stay on TCP + binary frames now. Add a separate media path
later, only when its trigger fires, and then WebRTC (not WebTransport) as a
`MediaChannel` beside the session.** The trigger that flips the decision is
**any** of:

1. **Live audio/video must flow between our own endpoints.** Examples: the phone
   cannot run STT/TTS on-device and `serve` does it; an S2S model is hosted at
   the key holder and must hear the phone (realtime-media Candidate A for
   audio); live camera push ≥ 5 fps to `serve`.
2. **E3/E7 show TCP is the bottleneck.** The p95 stall of a small frame on the
   phone path exceeds **300 ms** under 1 % loss, *with* blob pacing on.
3. **Option C goes ahead and the provider's WebRTC edge cannot be dialed
   directly** from the device (key/spend policy), so media must hairpin through
   the key holder.

Until then the provider's WebRTC edge (option C) is the only UDP in the system,
and it is the provider's. Sensor streams never trigger it: they are
≤ 8 kbit/s, batched and loss-intolerant (store-and-forward), which is exactly
TCP's job.

### C7. What this eval revises in the other evals

| Where | Was | Now | Why |
|---|---|---|---|
| realtime-media `:44` (table) | "The WS server caps a frame at 8 MiB (`ws-server.ts:54`)" | The **peer** cap is 8 MiB (`ws-server.ts:347` via `device-accept.ts:34`). Bun `maxPayloadLength` on `serve` is unset (Bun's default). | Line moved; the two caps are different layers. |
| realtime-media `:459-462` | "Not in scope: stdio/k8s/docker framing. No consumer: bytes never enter a pod." | **In scope** (slices BF1, BF3). Bytes do not enter a pod, but they **leave** one (`artifact/read` from pod daemons, `artifact-store.ts:11`). And the three byte-stream readers are unbounded today. | C2 rows 5 and 13. |
| realtime-media B1 (`:511`) | Noise outer base64 removed; "`protocol.d/` note". | Additive: each side accepts both carriers inbound, and the switch is announced by a capability. **No bump.** Plus a relay change (forward binary). Phone **CPU** gain is ≈ 0 (RN bridge base64); wire −25 %. | Design §BF2; C2 RN row. |
| realtime-media B2 (`:512`) | "images ≈ 1.0× on WS and Noise" | 1.0× on the phone only **with** B1. Blob frames inside the `t1:` carrier are 1.33×. Split into BF3 (channel bytes) + BF4 (uploads) + BF5 (downloads). | C3 E vs C. |
| attachments-audio-video §8 | C (native audio) wants B1, and B2 above 15 MiB. | Unchanged. | — |
| mobile-polar | JSON `sensor/push`. | Unchanged: binary saves < 5 kbit/s. | C3 streams. |

## Implementation

*— claude-opus-5-5, 2026-11-20*

An umbrella of slices. Each is promoted to its own `feat/`/`fix/` doc when the
owner approves it, and then re-verified against `main` (§8: "stop and fix the
plan" if a cited line moved).

### Load-bearing assumption

> **A byte frame can be told apart from a JSON-RPC text frame *below*
> `RpcPeer`, on every `DuplexChannel`, without parsing, and the channel keeps
> the order of the two kinds.**

If this holds, binary is a channel capability: `RpcPeer` stays untouched
(concurrent dispatch, §7), a `BlobMux` sits beside it, and no second path
exists. If it fails on one channel, that path needs base64 forever.

Proof, per channel:

| Channel | Discriminator | Order | Source |
|---|---|---|---|
| In-memory pair (tests) | JS type (`string` vs `Uint8Array`) | one microtask queue | `channel.ts:35-47` |
| Worker `MessagePort` | `typeof event.data === "string"` vs `ArrayBuffer` (sent as a **transferable**: zero copy) | per-port FIFO (HTML structured-clone messaging) | `port-channel.ts:31-35` |
| WebSocket (Bun client, Bun server, RN) | the WS **opcode** (text 0x1 vs binary 0x2). The Bun server already branches on `typeof message === "string"`; RN exposes `ArrayBuffer` with `binaryType = "arraybuffer"`. | one TCP stream, frames in send order (RFC 6455) | `ws-server.ts:355-356`; `ws-channel.ts:21-24`; RN `WebSocket.js:206-207, 244-249` |
| Noise (phone, `/e2e` + relay) | the **plaintext type byte**, inside the AEAD: `0x00/0x01` are RPC text, `0x02` confirm. A new `0x03` = byte frame. The relay cannot forge it. | strictly sequential nonces: an out-of-order message fails decryption | `noise-frame.ts:17-20`; `noise.ts` nonce rule |
| Byte streams (stdio, unix socket, k8s exec stdout, docker stdout) | the **first byte of a frame**: RPC is always `{` (0x7B, `peer.ts:272-273`); the keepalive is `\n` (`exec-channel.ts:84-85`, `docker/exec-channel.ts:52`). A reserved tag `0x00` (NUL starts no JSON and no text line) introduces `u32` big-endian length + body. Anything else stays in line mode, as today: a stray log line still reaches the peer as a `ParseError` (`peer.ts:288-292`). | one ordered byte stream. The pod bridge is a byte pipe (`pod-resident.ts:10-12`), and the exec carries NUL and arbitrary bytes (`k8s/exec-raw.ts:7-17`). | as cited |

What the proof does **not** cover:

- RN's bridge cost: it is CPU, not correctness (E2).
- Any process that writes to `serve --stdio`'s stdout other than the
  `streamChannel`. That is already forbidden (a stray write corrupts today's
  framing too). BF1's framer turns it from a silent parse error into a counted
  violation.

The cheap test that decides it is T-A1 in §Tests: a property test that every
frame `RpcPeer` emits starts with `{`, plus a framer fuzz.

### Preconditions

- P1. `RpcPeer` dispatch is concurrent (`peer.ts:322`); the `BlobMux` must not
  route through it.
- P2. Every channel is single and ordered (table above). A `blob/open` response
  therefore precedes the first chunk the client sends for it, with no extra
  sequencing.
- P3. Upload pacing exists and is pure: `upload-window.ts` (W=2, the
  `UPLOAD_MAX_SENT_FACTOR` and trust checks against a lying daemon). BF4 reuses
  it unchanged; only the transport of a chunk changes.
- P4. The daemon store reserves the declared size up front (bounded memory) and
  keys by sha256 with `have` resume (`attachment-upload.ts:31-55`;
  `attachment-store.ts`). The same holds for artifacts (`ARTIFACT_MEMORY_BYTES`).
- P5. `initialize` capability objects are strip schemas and fail-soft
  (`session.ts:221-283`).
- P6. The relay already bounds per-frame memory (`maxPayloadLength`) and
  per-leg backpressure (16 MiB, close on limit) (`server.ts:148-171`). Bun
  applies `maxPayloadLength` to binary frames as well as text [V, Bun WS docs;
  T-R2 pins it].
- P7. Replay ring = `session/update` only (`hosted-session.ts:953`). No blob is
  ever replayed. A drop costs at most one window of chunks, resumed via `have`.

### Design

**Layering (one seam each, bottom-up):**

```
 RemoteClient / Connection        ← unchanged session path
   ├─ RpcPeer  (text frames)      ← unchanged; concurrent dispatch
   └─ BlobMux  (byte frames)      ← NEW, beside the peer; streams, caps, have-acks
 DuplexChannel  send/setOnMessage + sendBytes/setOnBytes   ← extended (BF3)
   ├─ pair · MessagePort(transfer) · WS client · WS server · relay leg · app wrappers
   ├─ Noise: type 0x03 inside the AEAD; carrier t1:-text or binary (BF2)
   └─ byte streams: ByteFramer (line | NUL+u32 length), capped (BF1)
```

**1. `DuplexChannel` gains bytes (BF3), mandatory, not optional.**

```ts
interface DuplexChannel {
  send(data: string): void;
  sendBytes(data: Uint8Array): void;   // one opaque frame; a no-op once closed
  setOnMessage(h: (data: string) => void): void;
  setOnBytes(h: (data: Uint8Array) => void): void;
  close(): void; setOnClose(h: () => void): void;
}
```

Mandatory so `tsc` forces every hand-written wrapper (`foreground-gate`, the
pairing `tracked` channel, `relay-link`'s leg, `secure-channel`, test fakes) to
forward bytes. An optional method would let a wrapper silently swallow them,
and a silent drop is a bug (§8). Byte frames are bounded by
`MAX_BYTES_FRAME = 256 KiB + 16` at every receiver, checked before any copy.

**2. The blob frame (BF3; one codec in `@tentacle/protocol/src/blob.ts`, the
shared truth).**

```
 0      1      2-3        4-7           8-15            16…
 ver=1  kind   reserved   stream (u32)  offset (u64 BE)  payload (≤ 256 KiB)
 kind: 1 = chunk
```

Payload length = frame length − 16 (WS/port/Noise have boundaries; byte streams
carry it in their `u32` prefix). The **receiver allocates every stream id it
accepts**. So an inbound frame always names an id in the receiver's own table,
and an unknown id is a violation, never a lookup into the sender's namespace.

**3. Control stays JSON-RPC (BF4/BF5). Bytes never ride a request.**

- **Upload** (client → daemon; replaces `attachment/put`):
  - `blob/open {sessionId, id: sha256, size, purpose: "attachment"}` →
    `{stream, have, complete}` (daemon allocates `stream`; a probe = open +
    close).
  - The client then sends chunk frames from `have`, paced by `upload-window.ts`.
  - The daemon emits the notification `blob/have {stream, have, complete}`
    after each chunk it stores; the window acks from it.
  - `blob/close {stream}` frees the slot. The partial stays keyed by sha256, as
    today.
- **Download** (daemon → client; replaces the base64 in `artifact/read`):
  - `blob/read {sessionId, sha256, stream, offset}`. Here the **client**
    allocates `stream`, because it is the receiver.
  - The result is `{size}`, then chunk frames.
  - The client emits `blob/have` and the daemon paces at W=2 on it.
- **Limits per connection:**
  - ≤ 4 open streams per direction;
  - offset must equal `have` (a resend of an already-held range ≤ `have` is
    ignored, which is idempotent);
  - offset + len ≤ the declared `size` ≤ the purpose's cap (`MAX_IMAGE_BYTES`
    15 MiB, `MAX_ARTIFACT_BYTES` 20 MiB);
  - the store reserves up front (P4).
- **During a live voice lane** (realtime-media), the sender's chunk size drops
  to 32 KiB. The codec allows any payload ≤ 256 KiB, so this is a sender
  policy, not a wire change.

**4. Noise (BF2 carrier, BF3 bytes).**

- *Bytes (BF3):* `sendBytes` = chunk into plaintexts with type `0x03`
  (continuation `0x04`), sealed exactly like text. The `Reassembler` gets a
  per-kind buffer with the same cap, so the existing tests keep their meaning.
  This works on **either** carrier.
- *Carrier (BF2):* a transport message goes on the wire either as today's
  `t1:`+base64 text or as **one WS binary frame holding the raw Noise message**.
  - Receivers accept both always.
  - The handshake flights stay `t1:` text, so a version skew is still diagnosed
    exactly as today.
  - A sender switches to binary only after the far end has announced it
    (`initialize`: `agentCapabilities.transport.binary` /
    `clientCapabilities.transport.binary`, strip-schema booleans).
  - The daemon sets its flag only when **its leg** carries binary: always on
    direct `/e2e`; on a relay leg only if the relay's registration answer says
    `binary: true` (a new optional field).
  - So an old relay, an old app or an old daemon never sees a binary frame.
    All of it is additive, and there is **no `PROTOCOL_VERSION` bump**.
- *Relay (BF2):* forward binary frames opaquely between the paired legs.
  - The same 96 KiB `maxPayloadLength` (a raw Noise message is ≤ 65 535 B).
  - Same backpressure, never decrypted.
  - It is deployed **before** any daemon sets `binary`: the relay advertises,
    the daemon follows.

**5. Byte streams (BF1 framer, BF3 enables the tag).**

- One pure `ByteFramer` (`packages/transport/src/byte-framer.ts`) replaces the
  three string line readers (`stream-channel.ts`, k8s `ExecDemux` stdout,
  docker `StdDemux` stdout).
- It is byte-level, with no quadratic `slice`. A line longer than `maxLine` is
  a violation that closes the channel, checked **as bytes accumulate**, before
  a newline arrives. Default `maxLine`: 256 MiB laptop-side (the Noise
  initiator's cap, `noise-channel.ts:41`, because snapshots are unbounded) and
  32 MiB daemon-side (`RESPONDER_MAX_MESSAGE_BYTES`).
- A NUL starts a length frame. The `u32` length is checked against
  `MAX_BYTES_FRAME` **before** allocating. In BF1 the NUL tag is reserved (a
  violation); BF3 turns it on.
- The writer sends `[0x00][u32][body]`. On k8s that rides stdin channel 0
  unchanged. EOF semantics (`head -c N`, no half-close) are untouched, because
  a frame never relies on EOF.

**6. Capability vs bump: which is breaking.**

- BF1: no wire change.
- BF2: additive (capabilities + an optional relay field).
- BF3: an internal API change, no wire change until a caller uses it.
- BF4/BF5 **replace** `attachment/put` and `artifact/read`'s `data`. Pre-public,
  this is the cleanest shape: one way to move bytes, not two. So each writes a
  `protocol.d/` note, and a mixed pair fails at `initialize` with
  `VersionMismatch`.
- No base64 fallback is kept: every channel supports bytes after BF3, so there
  is no path left that needs one.

### Files

In dependency order (protocol → transport → daemon → client → cli → apps). Each
is listed under its slice in §Slices; the full set:

- `packages/protocol/src/blob.ts` (new: frame codec, `blob/*` schemas,
  `MAX_BYTES_FRAME`), `methods.ts`, `session.ts` (`transport.binary`
  capability), `relay.ts` (optional `binary` in the registration answer),
  `index.ts`; `protocol.d/blob-upload.md`, `protocol.d/blob-download.md`.
- `packages/transport/src/channel.ts`, `port-channel.ts`, `stream-channel.ts`,
  `byte-framer.ts` (new), `noise-frame.ts`, `noise-channel.ts`,
  `blob-mux.ts` (new, pure stream table + caps).
- `packages/k8s/src/exec-frame.ts`, `exec-channel.ts`;
  `packages/docker/src/exec-channel.ts`.
- `packages/daemon/src/ws-server.ts`, `relay-link.ts`, `connection.ts`,
  `attachment-store.ts`, `artifact-store.ts`.
- `packages/client/src/ws-channel.ts`, `secure-channel.ts`, `remote-client.ts`
  (upload/download over `BlobMux`), `upload-window.ts` (unchanged API).
- `packages/cli/src/local-runtime.ts`, `worker.ts` (transferable `postMessage`).
- `apps/relay/src/server.ts`; `apps/mobile/src/foreground-gate.ts`,
  `pairing-flow.ts`, `connection.ts`.

### Failure modes

| # | Failure | How it converges |
|---|---|---|
| F1 | **Peer without binary** (old app / old daemon / old relay) | BF2: nobody switches carrier without the far end's capability, and the daemon's flag needs the relay's `binary: true`. BF4/BF5: a mixed pair fails `initialize` with `VersionMismatch` (the `protocol.d/` bump), loud and specific. Never a mid-session parse error. |
| F2 | **Old relay gets a binary frame anyway** (bug) | It closes both legs `1003` (`server.ts:427-432`). The phone redials, the daemon's flag is re-derived from the relay's registration answer (absent → text), and the session resyncs. The test pins that the flag comes only from the relay's answer. |
| F3 | **A frame torn across a reconnect** | WS, port and Noise frames are atomic. Byte-stream framers and Noise reassemblers are per channel instance, so a new exec or socket starts empty. Blob stream ids are per connection and die with it: the client re-opens with `blob/open` → `have` and resumes (the partial is keyed by sha256). The resend cap is `UPLOAD_MAX_SENT_FACTOR`. |
| F4 | **Blob larger than the caps** | Refused at `blob/open` (`size` > the purpose cap, schema-level). A chunk past `size`, an offset ≠ `have`, a payload > 256 KiB, or a length prefix > `MAX_BYTES_FRAME` → protocol violation → close the channel (resync on redial). Checked before allocation. |
| F5 | **Pod sends hostile bytes** (pod → laptop: artifacts, or plain RPC) | The laptop allocates the stream ids; unknown id → close. The declared size is checked against `meta.size` and `MAX_ARTIFACT_BYTES`; offset == `have`. The byte framer caps lines and frames (BF1 closes **today's** unbounded-line gap). Nothing is ever buffered past one frame. |
| F6 | **Interleaving with a streaming turn** | `BlobMux` never awaits inside the peer; deltas keep flowing. HOL is bounded by W=2 × chunk on the wire (≈ 0.42 s per 256 KiB at 5 Mbit/s, binary), and by 32 KiB chunks while a voice lane is open (≈ 52 ms). E3 pins it. |
| F7 | **Back-pressure on a slow phone link** | Downloads to the phone are paced by the phone's own `blob/have`, so ≤ 2 chunks are queued, far under the 16 MiB close-on-backpressure of `serve` and the relay. Uploads are paced by the daemon's `blob/have`. A frozen phone is still closed at 16 MiB and resyncs (unchanged policy). |
| F8 | **Replay ring / resume after a drop** | Blobs never enter the ring (P7). On re-attach the ring replays `session/update`, and the client re-issues any unfinished `blob/open`/`blob/read` from `have`. The ring's 4 MiB budget is not consumed by bytes. |
| F9 | **Byte-stream framing error** (k8s/docker: a stray stdout write, a NUL inside a log line, a short read) | The framer treats a non-`{`/`\n`/NUL first byte as line mode (as today). A NUL with an over-cap length → violation → close. A short read just waits (bounded by the cap). A desync shows up as a violation, never as a silent mis-frame. Fuzz T-F1. |
| F10 | **k8s v4 stdin cannot half-close** | Unaffected: every frame is self-delimited; EOF is never a frame terminator. |
| F11 | **Noise mixed kinds** | Text and byte reassembly are independent per kind; each is capped; a kind switch mid-message (`0x00` followed by `0x03`) is a violation. The nonce order is unchanged. |
| F12 | **RN bridge base64 makes the phone slower than expected** | E2 decides. If the phone's base64-js per 256 KiB costs more than our current encoder, BF2 stays wire-only. A native binary WebSocket (JSI) becomes a separate eval. Never a reason to keep 1.78× on the wire. |
| F13 | **Empty input** | A zero-byte blob is refused at `open` (`size` positive, as today). A zero-payload chunk frame → violation. |
| F14 | **Worker transfer detaches the sender's buffer** | `sendBytes` copies when the caller's view is not a whole owned `ArrayBuffer`; the API contract says the channel may take ownership. T-P1 pins it. |

### Tests

All deterministic and AI-free: fake channels (`createChannelPair`, `FakeWS`,
the k8s/docker fakes), byte-level vectors and seeded fuzz. Red before green per
slice.

- **T-A1 (the assumption):** for 10 000 generated RPC frames (requests,
  notifications, responses, errors, unicode, embedded newlines), the first byte
  of `JSON.stringify` output is `{`. Plus: `RpcPeer` over a spy channel only
  ever calls `send` with such strings.
- **T-F1 (framer fuzz, BF1):**
  - Seeded random interleavings of lines, blank keepalives and NUL frames,
    split at **every** byte boundary and fed in random chunk sizes. The output
    equals the input sequence.
  - Over-cap line or length → exactly one violation, and nothing delivered
    after it.
  - Red: today's `streamChannel` with an endless line grows without bound (the
    test asserts a violation before N MiB is held).
- **T-F2:** the same vectors through `ExecDemux` (channel byte prefixes, stderr
  interleaved) and `StdDemux` (8-byte headers split across reads).
- **T-C1 (codec):** the blob header round-trips; every malformed header
  (ver ≠ 1, kind unknown, length < 16, payload > 256 KiB, offset beyond 2^53)
  is rejected with a typed reason.
- **T-N1 (Noise):** bytes and text interleaved across both carriers, with
  frames split at 65 518. Mixed-kind continuation → violation. Over-cap → close
  with no delivery. The existing noise tests stay green unchanged.
- **T-R1 (relay):** binary frames are forwarded byte-exact. A binary frame over
  96 KiB is refused by `maxPayloadLength` (T-R2 with a real `Bun.serve` on
  loopback, opt-in like the keepalive test if slow). Text behaviour is
  unchanged.
- **T-K1 (capability):**
  - The daemon advertises `transport.binary` only on direct `/e2e` or on a
    relay leg whose registration answer says `binary`.
  - The phone never sends a binary carrier frame before it reads the
    capability.
  - Mutation check: hard-wire the flag to `true` → T-K1 fails.
- **T-M1 (BlobMux):**
  - Unknown stream; offset ≠ `have`; past `size`; > 4 streams; a lying `have`
    from the daemon (reuses the `upload-window` trust tests).
  - Drop mid-blob → reopen → resume from `have`; the total sent is
    ≤ 3 × size.
- **T-H1 (interleaving, §7 "don't serialize the peer"):** over a
  `createChannelPair` with a paced fake link, a 15 MiB upload runs while
  `session/enqueue` and `session/resolve_permission` are issued. Each completes
  within one chunk time. Mutation: route chunks through `RpcPeer` dispatch with
  a lock → the test fails.
- **T-P1 (worker):** `MessagePort` bytes arrive as an `ArrayBuffer`; the
  sender-side buffer-ownership contract holds.
- **Experiments** (spikes in `.tentacle/tmp/binary-frames/`, not in the tree):
  - **E1:** done (C3), for Bun.
  - **E2** (phone, needed before BF2's phone half is judged): Hermes, per
    256 KiB:
    - our `encodeBase64` vs native `btoa` vs RN `base64-js`;
    - `@noble` ChaChaPoly MB/s;
    - a binary `WebSocket.send` round trip.
    Pass: the phone's JS ms per 256 KiB after BF2 ≤ before.
  - **E3** (Mac, `tc`/`dnctl` 5 Mbit/s · 50 ms · 1 % loss): p99 control-frame
    delay during a 15 MiB upload. Chunks of 256 vs 32 KiB × W=2, text vs
    binary. Pass: p99 < 500 ms at 256 KiB and < 100 ms at 32 KiB.

### Slices

Code tasks go one at a time (AGENTS §10). Each slice is useful alone and has
its own fragment.

| # | Slug | Delivers alone | Type · Size · Blast · Suited | Needs |
|---|---|---|---|---|
| BF0 | (spikes E2, E3; E1 done) | the phone CPU answer and the chunk policy | — · — · — · Opus + owner's phone | — |
| BF1 | `fix/byte-stream-frame-cap` | Closes the **unbounded pod → laptop line buffer** (a pod-not-trusted gap). One byte-level framer for stdio, unix socket, k8s and docker; no quadratic slicing; the NUL tag reserved. No wire change. | fix · **S–M** · cross-module (transport, k8s, docker) · strong or local exec, standard review + fuzz | — |
| BF2 | `feat/noise-binary-carrier` | Phone ↔ `serve`: **every** frame −25 % on the wire (1.78× → 1.33×), uploads and the session stream alike. On `serve` (Bun), encode+seal on the phone path drops 63 % (206 → 75 ms per 15 MiB, C3). The relay forwards binary. | feat · **M** · cross-module (relay, transport, daemon, app; additive capability, no bump) · strong exec, **fresh-context review** (relay H1 caps) | BF0-E2 for the phone CPU claim only |
| BF3 | `feat/channel-bytes` | `DuplexChannel.sendBytes`/`setOnBytes` on every channel (pair, port-transfer, WS ×2, relay leg, Noise `0x03`, byte streams via BF1's tag, app wrappers) + the blob codec + `BlobMux`. No caller yet: the owner decides whether it lands alone (Q5). | feat · **M** · **load-bearing** (the transport seam every path uses) · Opus exec or plan, **mandatory fresh-context review** | BF1 |
| BF4 | `feat/blob-upload` | Images/PDFs at **1.0×** on `connect` and the worker, and on the phone with BF2. 2 MB photo on a 5 Mbit/s phone uplink: 5.7 s → 3.2 s; 15 MiB: 44.8 s → 25.2 s. `attachment/put` removed (`protocol.d/` note). | feat · **M** · load-bearing (protocol break, §7 persistence store) · Opus plan, strong exec, fresh review | BF3 |
| BF5 | `feat/blob-download` | Artifacts (≤ 20 MiB) at 1.0× on every path **including pods** (stdout byte frames). `artifact/read`'s base64 removed (`protocol.d/` note). | feat · **S–M** · load-bearing (pod → laptop bytes, §7 pod not trusted) · strong exec, fresh review | BF3 (BF4 for the shared `BlobMux` client code) |
| later | `eval/media-channel` | Only when a §C6 trigger fires: a WebRTC `MediaChannel` (SDP over session RPC, DTLS fingerprints bound to Noise, a TURN relay, a native sidecar on the laptop). | eval | a §C6 trigger |

Recommended order: **BF1 → BF2 → (BF0-E2 result) → BF3 → BF4 → BF5.**
- BF1 is a security fix that is cheap, and it is the framer BF3 needs.
- BF2 is the largest win per line of code for the phone.
- In the voice-first order (realtime-media Q9), BF1 and BF2 are small enough to
  slot between voice tasks. BF3–BF5 come after the voice phases unless the
  owner raises them.

### Owner questions

1. **Go, and in this order?** BF1 → BF2 → BF3 → BF4 → BF5, with BF1/BF2 allowed
   to slot between voice tasks. *Recommendation: yes.* BF1 closes a real
   pod → laptop memory gap; BF2 cuts the phone's wire by 25 % on everything.
2. **BF2 carrier switch: additive capability (both carriers accepted, switch
   when announced, no bump) or a clean break (`E2E_CHANNEL_VERSION` 2, binary
   only)?** *Recommendation: additive.* A Noise prologue mismatch fails as
   "handshake failed", which the app's diagnosis cannot tell from a revoked
   key. The additive switch keeps the handshake readable and costs ~30 lines.
3. **Byte API on `DuplexChannel`: mandatory or optional?** *Recommendation:
   mandatory* (`sendBytes`/`setOnBytes`). The compiler then finds every wrapper
   that would otherwise drop bytes silently.
4. **BF4/BF5: replace `attachment/put` / `artifact/read` base64 (breaking, two
   `protocol.d/` notes), or add `blob/*` beside them?** *Recommendation:
   replace.* Pre-public, one way to move bytes; every channel supports bytes
   after BF3, so the base64 path would be dead code with its own tests.
5. **May BF3 land without a caller?** It is the shared seam BF4/BF5 use, and
   with a caller it would be an L. *Recommendation: yes, as its own branch,
   merged immediately before BF4*, with channel-level red/green tests. The
   alternative is one L branch BF3+BF4 (strong model, mandatory fresh review).
6. **Non-TCP media path (UDP/QUIC/WebRTC)?** *Recommendation: stay on TCP +
   binary frames now.* No live audio/video crosses our wire in the approved
   voice architecture, and the provider's WebRTC edge is the only UDP leg. Open
   `eval/media-channel` (WebRTC as a `MediaChannel` beside the session, never a
   session path) only when a §C6 trigger fires:
   - live media between our own endpoints;
   - a p95 stall > 300 ms in E3/E7 with pacing on;
   - option C needs a key-holder hairpin.
7. **Relay deploy order.** BF2 needs the hosted relay to forward binary before
   any daemon advertises it. *Recommendation: deploy the relay half of BF2
   first* (it is inert until a daemon sees `binary: true`), and keep
   `RELAY_PROTOCOL_VERSION` at 1 (the change is an optional field + forwarding).

**Owner verdict (2026-11-20): ALL recommendations accepted, except Q2 → CLEAN BREAK.** Owner: the mobile app is not published yet, so breaking backward compatibility is fine whenever it makes the design cleaner. Q1 go, order BF2 → BF3 → BF4 → BF5 (BF1 already merged `00b967dc`) · **Q2 binary-only carrier, `E2E_CHANNEL_VERSION` 2, no dual-carrier switch** (the plan must still make a version mismatch read as "update the app/daemon", not as a revoked key, if that is cheap) · Q3 `sendBytes`/`setOnBytes` mandatory · Q4 replace `attachment/put` / `artifact/read` base64 (`protocol.d/` notes) · Q5 BF3 lands alone, right before BF4 · Q6 stay on TCP + binary frames; `eval/media-channel` only on a §C6 trigger · Q7 relay half of BF2 deployed first (now required, not just safe: a binary-only daemon needs a relay that forwards binary).

## Execution

## Review
