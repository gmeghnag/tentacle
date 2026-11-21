# feat/noise-binary-carrier — the Noise E2E channel rides binary WebSocket frames only (E2E v2)

> **Status:** execution done (claude-opus-5-5, 2026-11-21) — awaiting fresh-context Review
> **Branch:** `feat/noise-binary-carrier`
> **Type:** feat · **Size:** L · **Blast:** load-bearing · **Suited:** Opus executes; **mandatory fresh-context Review** (red-team the E2E handshake, the relay H1 caps, version skew)
> **Changelog:** `changelog.d/noise-binary-carrier.changed.md` — `- **Phone ↔ computer traffic is ~25 % smaller.** The end-to-end channel now sends raw binary frames instead of base64 text; the app and tentacle must be updated together (a mismatch says which one to update).`
> **Answers:** slice BF2 of [`docs/eval/binary-frames.md`](../eval/binary-frames.md), under its owner verdict (2026-11-20, Q2 = clean break).

## Context

*— claude-opus-5-5, 2026-11-21*

**Problem.** Every frame between the phone and `serve` (on direct `/e2e` and through
the relay) is a Noise transport message that goes on the wire as **text**:
`t1:` + base64 (`packages/transport/src/noise-frame.ts:11, 100-113`). The text
carrier is there only because `DuplexChannel` moves strings
(`packages/transport/src/channel.ts:9-18`). It costs **1.779×** on the wire for an
upload, and 1.33× for every session frame. Removing the outer base64 gives 1.335×
(eval C3: 15 MiB goes from 28.0 MB to 21.0 MB, and from 44.8 s to 33.6 s on a
5 Mbit/s uplink). On Bun, encode+seal drops from 206 ms to 75 ms per 15 MiB.

**Decision this serves.** Eval `binary-frames`, owner verdict (binding):

- **Q2 = CLEAN BREAK.** The app is unpublished. So: no `t1:` text carrier kept, no
  dual-carrier switch, no capability negotiation (AGENTS §7 pre-public rule).
- **E2E channel version moves to 2.** The real name is `E2E_CHANNEL_VERSION`
  (`packages/transport/src/noise-channel.ts:33`). It is bound in the prologue
  `tentacle-e2e/<v>` (`:34`).
- **A version mismatch should read as "update the app / update tentacle", not as a
  revoked key**, if that is cheap. It is cheap; Design §3 says how, and where it
  cannot reach.
- **Q7: the relay half is deployed first.** It is now required: a binary-only daemon
  needs a relay that forwards binary.
- BF3 (`sendBytes`, type `0x03`) is **not** in this slice. BF1 is merged
  (`00b967dc`).

**Repro (that the capability is missing, and that the target path works).**
`.tentacle/tmp/noise-binary-carrier/carrier.ts` and `fragment.ts`, run with `bun <file>`
from that folder on 2026-11-21 against `main` @ `63d76f3e`:

```ts
// carrier.ts — feat/noise-binary-carrier: does a raw Noise message survive a binary WS frame through
// a relay-shaped Bun server (opaque splice, maxPayloadLength 96 KiB), in order with text frames?
// And what does the phone's JS pay per Noise message: our t1: encoder vs RN's base64-js?
import { encodeBase64, decodeBase64, MAX_CHUNK } from "../../../packages/transport/src/noise-frame.ts";
import { MAX_NOISE_MESSAGE } from "../../../packages/transport/src/noise.ts";
import { RELAY_CONTROL_LIMITS } from "../../../packages/protocol/src/relay.ts";
import b64js from "../../../node_modules/.bun/base64-js@1.5.1/node_modules/base64-js/index.js";

const legs: any[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 426 }); },
  websocket: {
    maxPayloadLength: RELAY_CONTROL_LIMITS.maxFrameChars, perMessageDeflate: false,
    open(ws) { legs.push(ws); },
    message(ws, m) { const other = legs.find((l) => l !== ws); other?.send(m); },
    close(ws, code) { console.log(`server: leg closed code=${code}`); for (const l of legs) if (l !== ws) l.close(1009); },
  },
});
const url = `ws://localhost:${server.port}`;
const open = (u: string, setType: boolean) => new Promise<WebSocket>((res) => { const w = new WebSocket(u); if (setType) w.binaryType = "arraybuffer"; w.onopen = () => res(w); });
const a = await open(url, false), b = await open(url, true);
console.log(`Bun client default binaryType: ${a.binaryType}`);
const got: unknown[] = [];
b.onmessage = (e) => got.push(e.data);
const max = new Uint8Array(MAX_NOISE_MESSAGE).map((_, i) => (i * 131) & 255);
a.send("t1:AAAA"); a.send(max); a.send(Uint8Array.of(2)); a.send("tail");
await Bun.sleep(100);
const kinds = got.map((d) => (typeof d === "string" ? `text(${d.length})` : d instanceof ArrayBuffer ? `ab(${d.byteLength})` : typeof d));
console.log(`order through splice: ${kinds.join(" , ")}`);
const back = new Uint8Array(got[1] as ArrayBuffer);
console.log(`65535-B message byte-exact: ${back.length === max.length && back.every((v, i) => v === max[i])}`);
let closed = "";
b.onclose = (e) => { closed += `b:${e.code} `; };
a.onclose = (e) => { closed += `a:${e.code} `; };
a.send(new Uint8Array(RELAY_CONTROL_LIMITS.maxFrameChars + 1));
await Bun.sleep(200);
console.log(`binary frame of ${RELAY_CONTROL_LIMITS.maxFrameChars + 1} B → closes: ${closed || "none"}; extra frames delivered: ${got.length - 4}`);
server.stop(true);

const N = 200;
const t = (f: () => void) => { const s = performance.now(); for (let i = 0; i < N; i++) f(); return ((performance.now() - s) / N).toFixed(3); };
for (let i = 0; i < 20; i++) { encodeBase64(max); b64js.fromByteArray(max); }
const s = encodeBase64(max);
console.log(`per 65535-B message on Bun (ms): ours enc ${t(() => encodeBase64(max))} dec ${t(() => decodeBase64(s))} · base64-js enc ${t(() => b64js.fromByteArray(max))} dec ${t(() => b64js.toByteArray(s))}`);
console.log(`bridge string per message: today ${3 + s.length} chars (t1:+b64) · after ${b64js.fromByteArray(max).length} chars (RN base64) · wire today ${3 + s.length} B → after ${max.length} B`);
console.log(`Bun ${Bun.version} ${process.arch}; MAX_CHUNK=${MAX_CHUNK}`);
```

```
Bun client default binaryType: nodebuffer
order through splice: text(7) , ab(65535) , ab(1) , text(4)
65535-B message byte-exact: true
server: leg closed code=1006
server: leg closed code=1009
binary frame of 98305 B → closes: a:1006 b:1009 ; extra frames delivered: 0
per 65535-B message on Bun (ms): ours enc 0.477 dec 0.097 · base64-js enc 0.387 dec 0.064
bridge string per message: today 87383 chars (t1:+b64) · after 87380 chars (RN base64) · wire today 87383 B → after 65535 B
Bun 1.4.3 arm64; MAX_CHUNK=65518
```

`fragment.ts` is a raw TCP client that hand-writes masked WS frames. It sends one
binary message as two fragments (opcode 2 without FIN, then a continuation with FIN)
to a server with the relay's `maxPayloadLength`:

```
fragments 40000+40000 = 80000 B → delivered=80000 closeFrame=none eof=false
server close code=1006
server close code=1006
fragments 60000+60000 = 120000 B → delivered=-1 closeFrame=none eof=true
```

What this shows:

1. A raw Noise message (65 535 B at most) crosses a relay-shaped splice
   byte-exact as **one** binary frame.
2. Text and binary frames keep their send order on one socket.
3. Bun's `maxPayloadLength` refuses an over-cap binary message **before** the
   handler runs, whole or fragmented. Nothing is delivered and the connection is
   dropped. This proves eval P6.
4. Bun's client defaults to `binaryType = "nodebuffer"`, so the adapters must set
   it explicitly.

Today's relay instead closes both legs `1003` on any binary frame
(`apps/relay/src/server.ts:427-432`; pinned by `apps/relay/test/server.test.ts:396`).

## Implementation

*— claude-opus-5-5, 2026-11-21*

### Load-bearing assumption

> **The Noise channel can take a raw *byte* carrier under it on every path that
> runs it: direct `/e2e`, the relay data legs, the phone's RN WebSocket, and the
> test pairs. That carrier delivers each binary WS message whole and in order, and
> still delivers a stray text frame to the Noise layer, so the layer can diagnose
> it. No `DuplexChannel` change is needed (BF3 stays separate).**

Proof, per hop:

| Hop | Binary in / out | Whole + ordered | Source |
|---|---|---|---|
| `serve` `/e2e` (Bun server) | `message` is `string` or `Buffer` (a `Uint8Array`). Today it is stringified with `message.toString()`. `ws.send` takes a `Uint8Array`. | One WS message per `message` call (uWS reassembles fragments, repro `fragment.ts`). One TCP stream. | `packages/daemon/src/ws-server.ts:390-392` |
| Relay (Bun server, both legs) | Same API. Today it closes `1003` on binary. | Same; the splice is 1:1 (repro: `text, ab, ab, text`). | `apps/relay/src/server.ts:424-449` |
| Daemon relay leg (Bun **client**) | `event.data` is a `Buffer` by default (`nodebuffer`, repro), and `ArrayBuffer` with `binaryType = "arraybuffer"`. Today it is stringified with `String(event.data)`. | Same | `packages/daemon/src/relay-link.ts:954-956` |
| `connect`/app dial (`WebSocketChannel`, Bun or RN) | Today `String(data)`. | Same | `packages/client/src/ws-channel.ts:21-24` |
| RN 0.88 `WebSocket` | `send(ArrayBuffer \| view)` goes to `sendBinary(base64)`. Inbound `type: 'binary'` becomes `base64.toByteArray(...).buffer`, an **ArrayBuffer**, unless a blob handler was registered, which happens only for `binaryType = 'blob'`. | Native socket, one `websocketMessage` event per message | `apps/mobile/node_modules/react-native/Libraries/WebSocket/WebSocket.js:160-175, 187-207, 240-254` (RN 0.88.0) |
| Noise | A transport message is already `Uint8Array` before `encodeFrame`; the receiver is `decryptWithAd(EMPTY, Uint8Array)`. Base64 is only an outer wrapper. | Strictly sequential nonces: a reorder fails decryption (as today). | `noise-channel.ts:187-192, 238` |

Every hop's API already carries binary. The text-only behaviour sits in five
adapter lines that stringify (`ws-server.ts:391`, `relay-link.ts:955`,
`ws-channel.ts:23`, the relay's `1003` branch, and `encodeFrame`/`decodeFrame`).
**Verdict: holds.** The repro checks it on Bun. On RN it is checked by reading the
source; the device check is in Tests → "Unverified".

### Preconditions

- **P1. Noise owns its channel's framing.** Nothing above `SecureChannel` sees the
  carrier: `RpcPeer`/`Connection`/`RemoteClient` get a `DuplexChannel` of strings
  (`noise-channel.ts:104-106, 179-184`). So changing the carrier changes no session
  path (§7 one session path).
- **P2. The E2E version is the channel's own, not `PROTOCOL_VERSION`.**
  `noise-channel.ts:32` says so, and the JSON-RPC carried inside is byte-identical.
  So **no `protocol.d/` note**: `@tentacle/protocol`'s wire schemas and
  `protocol.json` do not change. The pairing QR has its own version for the same
  reason (`packages/protocol/src/pairing.ts:9-11, 28`).
- **P3. Handshake flights are tiny and fixed.** Message 1 (IK, empty payload) is
  96 B, message 2 is 49 B, the confirm is 17 B (`noise-channel.ts:418, 481-487,
  439`). The relay's pre-accept buffer (64 KiB, `relay.ts:102`) is far above them.
- **P4. Relay caps hold for binary.** `maxPayloadLength = 96 KiB`
  (`server.ts:161-167`) applies to binary messages, fragmented or not (repro). A raw
  Noise message is at most 65 535 B (`noise.ts`, `MAX_NOISE_MESSAGE`). The per-leg
  backpressure close at 16 MiB is unchanged (`server.ts:157-158`).
- **P5. Only `unauthorized` is terminal** on a dial (`link-machine.ts:84-90`;
  `secure-channel.ts:19-30`). A version answer can be forged by an on-path party, so
  it must stay transient.
- **P6. The app already has "update" sentences.** Pairing has `version` and
  `payload-version` (`apps/mobile/src/pairing-flow.ts:151-164`). The link row
  diagnosis is a pure reducer (`apps/mobile/src/link-diagnosis.ts:56-139`). Both are
  pure modules, so the new rule is unit-tested there (§7 logic in pure modules).
- **P7. No laptop-side production code runs the initiator.** `rg noiseInitiator`
  finds only `packages/client/src/secure-channel.ts:44`, which the app and the
  shared `pairing.ts` use, plus tests. `tentacle pair` (`packages/cli/src/pair.ts:45`)
  only formats the SAS. `connect` uses no Noise. So the "laptop client" end is the
  shared `@tentacle/client` code plus the test helpers.
- **P8. `encodeBase64`/`decodeBase64` stay.** `packages/client/src/read-window.ts:18`
  (artifact read) and the attachment upload use them until BF4/BF5.

### Design

**1. A byte carrier under Noise (`@tentacle/transport/src/channel.ts`).**

```ts
/** A binary frame as bytes; a TEXT frame as the string it was (never valid here — kept so the layer above can diagnose it). */
export type CarrierFrame = Uint8Array | string;
/** The raw channel a Noise endpoint runs on: one binary WS message per frame. */
export interface ByteCarrier {
  send(data: Uint8Array): void;          // a no-op once closed
  close(): void;
  setOnMessage(handler: (frame: CarrierFrame) => void): void;
  setOnClose(handler: () => void): void;
}
export function createByteCarrierPair(): [ByteCarrier, ByteCarrier]; // microtask delivery, like createChannelPair
```

- Adapters stay dumb. They hand over exactly what the socket gave:
  - `ArrayBuffer` becomes `new Uint8Array(buf)`;
  - a view becomes a `Uint8Array` over the same bytes (`byteOffset`/`byteLength`
    respected, so a Bun pooled `Buffer` is not over-read);
  - a string is passed through as a string.
- **Every decision about what a frame means lives in the pure Noise module.**
- `DuplexChannel` is untouched. BF3 later adds bytes to it. A WS adapter can then
  serve both halves, and `ByteCarrier` stays Noise's input (Notes/debt).

**2. The Noise wire, v2 (`noise-frame.ts`, `noise-channel.ts`).**

- `E2E_CHANNEL_VERSION = 2` and `PROLOGUE = "tentacle-e2e/2"`.
- **Handshake flights 1 and 2** = `[version u8] ‖ noise message`, as one binary
  frame. The byte is cleartext: it lets each side *name* a skew before any crypto.
  The prologue still binds the version, so a tampered byte only causes a failed
  handshake.
- **The confirm and every transport message** = the raw Noise message, as one
  binary frame, with no header. Plaintext layout (type byte + ≤ 65 518 B) and
  chunking are unchanged (`noise-frame.ts:115-163`).
- **A version refusal** = a binary frame of exactly **1 byte**, `[sender's
  version]`. Message 2 is ≥ 49 B, so a 1-byte frame is unambiguous.
- Removed: `FRAME_TAG`, `MAX_FRAME_TEXT`, `encodeFrame`, `decodeFrame`. The base64
  codec stays (P8). Fix the stale "Hermes has no `btoa`" comment (`:30`).
- Receiver checks, in order, **before** any decrypt:
  - **Text frame:**
    - during the handshake, if it starts with `t1:`: `version-mismatch`,
      `remoteVersion: 1`;
    - otherwise during the handshake: `bad-frame` "text frame on the e2e channel";
    - after open: `bad-frame` (a violation: close, deliver nothing).
  - **Binary frame:**
    - longer than `MAX_NOISE_MESSAGE` (+1 in the handshake): `bad-frame` "frame too
      long";
    - empty: `bad-frame`.
  - **Responder, `await-msg1`:**
    - `frame[0] !== 2`: send the refusal `[2]`, then phase `refused` (the deny
      pattern: the initiator closes on reading it, and the timer covers one that
      never does, `noise-channel.ts:481-484`);
    - then fail with `version-mismatch` (`remoteVersion: frame[0]`).
    - `authorize` is **never called** and nothing is built.
  - **Initiator, `await-msg2`:**
    - a 1-byte frame `[v]` with `v !== 2`: `version-mismatch` (`remoteVersion: v`);
    - `[2]` alone: `bad-frame`;
    - `frame[0] !== 2`: `version-mismatch`;
    - else `readMessage2(frame.subarray(1))`.
- `NoiseErrorKind` gains `"version-mismatch"`. `NoiseError` gains an optional
  `remoteVersion?: number` (`noise.ts:24-33`). The message names both versions, plus
  the side to update when that is known ("the app/tentacle on the computer is
  older").

**3. Making a mismatch read as "update" (the verdict's ask: cheap, here is how far it reaches).**

| Pair | What happens | What the person reads |
|---|---|---|
| new app ↔ new daemon (future v3 vs v2) | The version byte, plus the 1-byte refusal | App: "update the app" or "update tentacle", by which side is newer. Daemon audit: `e2e-version-mismatch remote=<n>`. |
| **old app (v1) → new daemon** | The daemon sees a `t1:` text message 1: `version-mismatch remote=1`. It closes. It cannot answer in v1. | Daemon audit `e2e-version-mismatch remote=1 (update the app)`. The old app cannot be changed: it shows its existing "closed during handshake" (then `maybe-reset` after 3). This is acceptable because the app is unpublished. |
| **new app → old daemon (v1)** | The old daemon stringifies our binary message 1, fails `decodeFrame` (no `t1:`), and closes. **No reply is possible from old code.** | App: a plain `closed`. So the **`maybe-reset` sentence is extended**: "… may have been reset — or tentacle on it is older than this app (update it)" (`link-diagnosis.ts:129-130`). |
| **pairing, either skew** | **`PAIRING_PAYLOAD_VERSION` 1 → 2** (`pairing.ts:28`). An old app refuses a v2 QR, and a new app refuses a v1 QR, at scan time and before any dial. Each side already shows "This code is from a different tentacle version — update the app, or tentacle on the computer" (`pairing-flow.ts:151-154`). | Exact, in both directions, with zero new copy. The QR's `v` says how to *use* the payload, and the e2e version is part of that. |
| new phone/daemon ↔ **old relay** | The first binary frame: the old relay closes both legs `1003` (`server.ts:427-432`). | `closed` (no hang). Avoided by the deploy order (§Deploy). |

Client and app wiring:

- `channelErrorFromNoise` maps `version-mismatch` to `ChannelError("rejected", …)`.
  It is **non-terminal** (P5: a forged byte must not stop the link for good) and
  carries `remoteE2eVersion` (a new optional field on `ChannelError`,
  `link-machine.ts:34-46`, next to `closeCode`).
- `link-diagnosis.ts`:
  - an observed error with `remoteE2eVersion` gives `"update-app"` (remote > local)
    or `"update-computer"` (remote < local);
  - it does **not** feed the `maybe-reset` streak (it says nothing about keys);
  - two sentences are added.
- `describePairingError` maps it to the existing `version` failure.

**4. The relay forwards binary opaquely (`apps/relay/src/server.ts`).**

- **Phone leg, and accept leg after its token:** forward text **and** binary,
  unchanged, to the peer leg. The `forward` / `Buffered` types widen to
  `string | Uint8Array`. The size used for the pre-accept count and the oversize
  check is `typeof f === "string" ? f.length : f.byteLength`.
  - Both kinds are forwarded **permanently**, not "during the switch". The relay is
    a dumb pipe and never interprets a data frame (AGENTS §7 "the relay is not
    trusted"; its own header comment, `server.ts:15-17`). Keeping text costs
    nothing, keeps today's v1 pairs working until they update, and means the relay
    never has to be redeployed for a channel change again.
- **Control socket, and an accept leg before its token:** binary still closes
  (`1003`): those carry JSON control frames only. The branch moves below the role
  split.
- `maxPayloadLength` stays 96 KiB (P4). Its comment is updated: "a raw Noise
  message ≤ 65 535 B; a legacy `t1:` text frame ≤ ~87.4 Ki chars".
- **`RELAY_PROTOCOL_VERSION` stays 1** (verdict Q7). Control frames are unchanged.
  No `binary` registration field is needed: there is no negotiation.

**5. Daemon (`packages/daemon`).**

- `ws-server.ts`:
  - the device route builds a `WsByteCarrier`. It delivers `string | Uint8Array`
    as received and sends with `ws.send(Uint8Array)`;
  - the plain route keeps `WsChannel` (text, as today: BF3's business);
  - `message` dispatches on `ws.data.route`.
- `relay-link.ts`:
  - `RelaySocket.send` takes `string | Uint8Array`, and `RelaySocketHost` delivers
    `CarrierFrame`;
  - `bunRelayDialer` sets `ws.binaryType = "arraybuffer"` and normalizes as in §1;
  - the control socket's `parseFrame` gets a string or closes (a binary control
    frame is malformed);
  - the data leg's `channel` becomes a `ByteCarrier`. The `accept` handshake frame
    stays text (`:760`);
  - `isInboundFrameTooLarge` already takes `string | Uint8Array`
    (`relay.ts:548`).
- `device-accept.ts`:
  - takes a `ByteCarrier`;
  - `onViolation` already audits `e2e-violation <kind>` (`:156`). For
    `version-mismatch` it audits `e2e-version-mismatch remote=<n> local=2` plus the
    hint, so the operator learns "update the app".

**6. Client (`packages/client`).**

- `ws-channel.ts`: add `WebSocketCarrier implements ByteCarrier`, which sets
  `binaryType = "arraybuffer"` in the constructor. Also add
  `webSocketCarrierFactory(url, options, deps)`, sharing `socketTarget` /
  `openSocket` / `classifyUpgradeFailure` with `webSocketChannelFactory`: one
  private `dialWith(wrap)`. The existing text factory is unchanged for `connect`.
- `secure-channel.ts`: `dial: () => Promise<ByteCarrier>`, plus the `KIND` row
  and `remoteE2eVersion`.
- `pairing.ts`: `dial` / `pairOn` take `ByteCarrier` (`:66, 188`).

**7. Phone (`apps/mobile`).**

- `connection.ts`:
  - `steps.open` dials `webSocketCarrierFactory` (`:303-310`);
  - `abandon` and `confirm` take a `ByteCarrier`, and `addressOf` is keyed by
    carrier;
  - `foreground-gate.ts` wraps the **secure** channel factory (a `DuplexChannel`,
    `:353-363`), so it is **unchanged**.
- `pairing-flow.ts`: the `tracked` wrapper (`:574-585`) and `opened` set become
  `ByteCarrier`. Its `dial` option type changes (`:417`).
- `link-diagnosis.ts`: the two diagnoses (§3).
- **RN bridge cost, honestly.** RN moves binary across the bridge as base64
  (`WebSocket.js:207, 248`).
  - Today the JS thread runs **our** `encodeBase64`/`decodeBase64` over each Noise
    message, and the bridge carries the 87 383-char `t1:` string.
  - After BF2, the JS thread runs RN's `base64-js` over the same bytes, and the
    bridge carries an 87 380-char base64 string. Native decodes it into the
    socket's binary frame.
  - So the phone's JS work and bridge payload stay **about the same**: on Bun,
    base64-js is 0.39/0.06 ms per message (encode/decode) against ours at
    0.48/0.10 (repro). The **wire** drops 25 % (87 383 → 65 535 B per message).
  - Hermes timings are **not** measured (no JIT; the ratio is assumed similar
    because both are pure-JS table loops). This is BF0-E2 on the owner's phone and
    does not gate this slice: the eval's F12 says the 1.78× wire is never kept for
    CPU parity.
  - A native binary WebSocket (JSI) would remove the bridge base64. It is a
    separate eval.

**8. Docs.** `docs/feat/e2e-channel.md` Framing (`:356`) and the
plaintext-peer row (`:517`), plus `docs/feat/mobile-relay.md:33`: replace the `t1:`
text with "v2: binary frames; flights 1–2 carry a version byte". Add a `TODO.md`
line on merge (orchestrator).

### Files

In dependency order (protocol → transport → relay → daemon → client → mobile).
Tests sit next to each.

1. `packages/protocol/src/pairing.ts`: `PAIRING_PAYLOAD_VERSION = 2` and the doc
   example. `packages/protocol/src/relay.ts`: comments on `maxFrameChars` /
   `preAcceptBytes` (bytes or chars).
2. `packages/transport/src/channel.ts`: `ByteCarrier`, `CarrierFrame`,
   `createByteCarrierPair`. `index.ts` exports them.
3. `packages/transport/src/noise.ts`: `version-mismatch` and `remoteVersion`.
4. `packages/transport/src/noise-frame.ts`: drop the text frame codec; add
   `withVersion` / `readVersioned` helpers for flights 1–2 and the refusal. Pure.
5. `packages/transport/src/noise-channel.ts`: `ByteCarrier` in, binary out,
   version checks, version 2.
6. `apps/relay/src/server.ts`: forward binary on data legs; byte-length counting.
7. `packages/daemon/src/ws-server.ts`, `relay-link.ts`, `device-accept.ts`.
8. `packages/client/src/link-machine.ts` (`remoteE2eVersion`), `ws-channel.ts`,
   `secure-channel.ts`, `pairing.ts`.
9. `apps/mobile/src/connection.ts`, `pairing-flow.ts`, `link-diagnosis.ts`.
10. Docs: `docs/feat/e2e-channel.md`, `docs/feat/mobile-relay.md`;
    `changelog.d/noise-binary-carrier.changed.md`.

Tests that use the `t1:` text API and must be ported (mechanical; `tsc` lists them
once the types change):

- `packages/transport/test/noise-channel.test.ts`, `noise-frame.test.ts`;
- `packages/client/test/secure-channel.test.ts`, `pairing.test.ts`;
- `packages/daemon/test/relay-link*.test.ts`, `device-accept.test.ts`,
  `ws-device-route.test.ts`, `project-pairing.test.ts`,
  `artifact-connection.test.ts`;
- `packages/cli/test/serve-push.test.ts`, `serve-hooks-trust.test.ts`,
  `serve-devices.test.ts`;
- `apps/relay/test/server.test.ts`; `packages/protocol/test/pairing-payload.test.ts`;
- `apps/mobile/test/connection.test.ts`, `pairing-flow*.test.ts`,
  `link-diagnosis.test.ts`.

Not touched: `RpcPeer`, `Connection`, `RemoteClient`, `foreground-gate.ts`, the plain
`WsChannel` / `WebSocketChannel` text path, `@tentacle/protocol` wire schemas, and
`PROTOCOL_VERSION`.

**Size L, honestly.** About 16 production files across 6 packages/apps (the
transport seam under every phone path, the hosted relay, the app), plus about 18
test files ported. Each change is small and the compiler finds every carrier site.
The slice cannot be split without a broken intermediate state: the carrier is
binary-only on both ends at once.

### Failure modes

| # | Failure | How it converges |
|---|---|---|
| F1 | **Old app (v1) ↔ new daemon** | Text `t1:` message 1 → `version-mismatch remote=1` and an immediate close (no hang). Daemon audit names "update the app". The old app shows `closed` (old code). |
| F2 | **New app ↔ old daemon (v1)**, direct or via the new relay | The old daemon stringifies the binary, fails `decodeFrame`, and closes at once. The new app gets `closed`, and the extended `maybe-reset` sentence names "update tentacle". No hang: the close is synchronous on the first frame. |
| F3 | **Future skew (v2 ↔ v3)** | The version byte, plus the 1-byte refusal. Exact "update X" on both ends. Non-terminal, so the link keeps backing off (it heals when the other side updates). |
| F4 | **Old relay, new endpoints** | The first binary frame → `1003` on both legs → `closed` on both ends, no hang. Prevented by deploying the relay first (§Deploy). After the deploy the next redial works without user action. |
| F5 | **Relay restart (deploy or crash)** | All legs drop (as today). The daemon's control socket reconnects through `relay-link-policy`'s backoff. The phone redials. Each redial is a fresh carrier + fresh handshake, so no carrier state survives or needs to. |
| F6 | **Frame over the cap** | Relay: Bun refuses a binary message > 96 KiB before the handler, whole or fragmented (repro). Endpoint: a binary frame > `MAX_NOISE_MESSAGE` (+1 in the handshake) → `bad-frame` before decrypt, and the channel closes. Reassembly caps are unchanged (`noise-channel.ts:39-41`). |
| F7 | **Text frame after the switch** | Handshake: `t1:` → `version-mismatch remote=1`, anything else → `bad-frame`. After open: `bad-frame` violation → close, nothing delivered. Same policy as any malformed frame (`noise-channel.ts:15-17`). |
| F8 | **Partial / fragmented WS frames** | Not visible to us: Bun (uWS) and RN deliver one whole message per event (RFC 6455 reassembly; repro `fragment.ts` 40 000 + 40 000 → one 80 000-B delivery). A Noise message is never split across WS messages, so there is no partial state to carry. |
| F9 | **Reconnect mid-message** | A Noise reassembler is per `Secured` instance (`noise-channel.ts:166, 249`), so a redial starts empty. The replay ring resyncs the session (unchanged). |
| F10 | **Forged version byte or refusal** (hostile relay / on-path) | At worst the person reads "update …" instead of "can't reach". The handshake fails either way. It is **never terminal** (P5), so the link keeps retrying. It is the same power the path already has (dropping frames). The prologue still binds the version. |
| F11 | **Empty binary frame** | `bad-frame` (a Noise message has a tag; a refusal is exactly 1 byte). |
| F12 | **Bun `Buffer` view over a pooled slab** | The adapter uses `byteOffset`/`byteLength` and never reads `.buffer` whole. A unit test feeds a view at offset > 0. |
| F13 | **RN `binaryType` unset** | RN delivers `ArrayBuffer` by default (no blob handler), but the carrier sets `"arraybuffer"` explicitly anyway. A `Blob`, or anything not string/ArrayBuffer/view, becomes a `bad-frame` (logged), never `String(x)`. |
| F14 | **Pre-accept buffering on the relay** | A binary message 1 (97 B) counts by `byteLength` against `preAcceptBytes` (64 KiB). Over that → close `4404` (as today for text). |
| F15 | **Merge before the relay deploy** | See §Deploy: the relay path breaks for new⇄new pairs (F4); direct `/e2e` works. |

### Tests

Red first: each test below is written first and fails on `main` for the stated
reason. Mutation targets confirm non-vacuity (§9). All of them are deterministic and
use the existing fakes (`createChannelPair` → `createByteCarrierPair`, the fake relay
`RelayDialer`, the client `fetch`/`WebSocket` injection) or loopback `Bun.serve` as
the relay tests already do.

- **T-N1 binary carrier (transport/noise-channel.test.ts).**
  - A spy carrier records every raw `send`. Assert:
    - each is a `Uint8Array` of ≤ 65 535 B (+1 for flights 1–2);
    - flights 1 and 2 start with `0x02`;
    - the confirm and transport messages carry no header.
  - Round-trip payloads of 0, 65 518, 65 519 and 200 KB (multi-byte UTF-8 split at
    the boundary).
  - Red on `main`: sends are strings. Mutation: emit through base64 → fails.
- **T-N2 pinned versions.** `E2E_CHANNEL_VERSION === 2`, prologue `tentacle-e2e/2`
  (flips `noise-channel.test.ts:208-209`).
- **T-V1 version skew, responder.**
  - Message 1 with header `0x01` or `0x03` → rejects `version-mismatch`
    (`remoteVersion` 1/3). Exactly one frame `[0x02]` is sent, `authorize` is called
    0 times, nothing resolves.
  - A text `t1:…` message 1 → `remoteVersion: 1`, nothing sent.
  - A text `{"jsonrpc"…}` → `bad-frame`.
  - Mutation: drop the version check → `authorize` runs → fails.
- **T-V2 version skew, initiator.** It receives `[0x03]` → `version-mismatch 3`;
  `[0x02]` alone → `bad-frame`; `t1:` text → `version-mismatch 1`; a message 2 with
  header `0x01` → `version-mismatch 1`.
- **T-N3 text after open** → `bad-frame` violation, carrier closed, `onMessage`
  never called.
- **T-N4 over-cap binary** (65 536 B after open) → `bad-frame` "too long". A spy
  `CipherState` shows decrypt was **not** called.
- **Ported:** replay, gap, tamper, deny, timeout, reassembly cap and pre-handler
  queue tests keep their assertions, on the byte carrier.
- **T-R1 relay forwards binary (apps/relay/test/server.test.ts).**
  - Flips `:396`. A 65 535-B binary is forwarded byte-exact phone→daemon and
    daemon→phone, interleaved with text in order.
  - Binary on the control socket → `1003`. Binary on an accept leg before its token
    → `1003`.
  - Mutation: restore the `1003` branch for data legs → fails.
- **T-R2 relay cap.** A 96 KiB + 1 binary message on a phone leg → no delivery, leg
  closed (real loopback `Bun.serve`, as in the repro).
- **T-R3 pre-accept by bytes.** Binary frames totalling > 64 KiB before `accept` →
  phone closed `4404`. Mutation: count binary as 0 → fails.
- **T-D1 serve `/e2e` (daemon/test/ws-device-route.test.ts).**
  - A real binary handshake + `initialize` over a real socket.
  - A v1 client sending a `t1:` text message 1 → closed, audit line
    `e2e-version-mismatch remote=1`, no `Connection`, limiter slot released.
- **T-D2 relay leg (daemon/test/relay-link.test.ts).**
  - The fake leg delivers `Uint8Array` → the handshake confirms.
  - The `accept` frame is still JSON text.
  - A binary frame on the control socket → close, never a parse.
- **T-C1 WebSocketCarrier (client test).**
  - With a fake socket: `binaryType` is `"arraybuffer"` before the first message.
  - `ArrayBuffer`, `Uint8Array` view at offset 3 and a string are each delivered as
    received (bytes equal).
  - A `Blob`-like object → `bad-frame` close.
  - Mutation: `String(data)` → fails.
- **T-C2 secure-channel.** `version-mismatch` → `ChannelError` `rejected`,
  `terminalReason` null, `remoteE2eVersion` set. Mutation: map to `unauthorized` →
  fails.
- **T-M1 link-diagnosis.**
  - `remoteE2eVersion` 3 → `update-app`; 1 → `update-computer`. The `maybe-reset`
    streak is unchanged.
  - The `maybe-reset` sentence names "older than this app".
- **T-M2 pairing-flow.** A version-mismatch `ChannelError` → failure `version`.
- **T-P1 pairing payload.** `PAIRING_PAYLOAD_VERSION === 2`; a `v=1` QR is refused
  with reason `version` (flips `pairing-payload.test.ts:72`).
- **Gate:** `bun run check` green (typecheck incl. `apps/mobile` + `apps/relay`, lint
  clean, full test, with only the three opt-in skips).
- **Unverified (state it in Execution):** the RN device path (Hermes base64-js cost,
  and that the native module delivers `type:'binary'` on iOS) is read from source,
  not run. Verify with one real-phone session over the relay after deploy (§Deploy
  step 4) and with BF0-E2.

### Deploy

The relay is the hosted `relay.tentacle.so` (`docs/ops/relay-deploy.md`). **Its
deploy needs the owner's OK.**

1. **Relay first, from the reviewed branch tip, before merge.** The new relay is
   **backward compatible**: it forwards text exactly as before, so today's v1
   daemons and apps keep working on it. Binary is forwarded in addition.
   - Build: `bun apps/relay/deploy/build.ts`. Install and restart per the runbook
     §1–§3.
   - The restart drops every leg once (F5). Daemons reconnect by backoff; phones
     redial.
   - Smoke test per runbook §5 with the **current** (v1) daemon and app: the text
     path still works.
2. **Merge** BF2 (`protocol:bump` is a no-op: no `protocol.d/` note), and run the
   full `check`.
3. **Update both ends together:** `tentacle` on the laptop (restart `serve`) and the
   app dev build. Re-pair is **not** needed (keys unchanged). A QR printed by an old
   `tentacle pair` is refused by the new app ("different version"), so re-run
   `tentacle pair` if a pairing is in progress.
4. **Smoke test the v2 path:** one phone session over the relay and one direct
   (LAN/Tailscale): a message, an image upload, a reconnect. This is also the RN
   device check marked unverified above.

**What breaks between merge and relay deploy** (if step 1 is skipped or comes after
step 2):

- a new phone with a new daemon **through the relay** fails at message 1 (old relay
  `1003`, F4), shown as `closed` → `maybe-reset` after 3;
- **direct `/e2e` works**;
- mixed v1/v2 pairs fail on any path (the clean break, F1/F2) whatever the relay
  does.

**Rollback:**

- Rolling the relay back **after** laptops updated breaks the relay path again (F4).
  Roll back the laptop and app first, or not at all.
- Rolling the laptop/app back is safe on the new relay, which still forwards text.

### Owner questions

None — the verdict covers this slice.

Covered decisions, for the record:

- clean break and E2E v2 (Q2);
- relay first (Q7, executed as "from the branch tip before merge" so there is no
  broken window);
- `RELAY_PROTOCOL_VERSION` stays 1 (Q7).

The mismatch UX uses only cheap means (a version byte, a 1-byte refusal, the QR
version bump, two diagnosis sentences), as the verdict allowed.

### Notes / debt

- **BF3 seam.** `ByteCarrier` is Noise's raw input. When BF3 adds
  `sendBytes`/`setOnBytes` to `DuplexChannel`, the WS adapters can implement both,
  and Noise's type `0x03` rides the same carrier. Nothing here has to be undone.
- **`serve`'s Bun `maxPayloadLength` is still unset** (Bun default 16 MiB) on the
  shared server. A pre-auth `/e2e` stranger can make Bun allocate up to that per
  frame, within the handshake limiter's concurrency (pre-existing, eval C2 row
  `ws-server`). A per-route cap needs a second `Bun.serve` or uWS per-route
  options: out of scope, worth a `fix/` later.
- The old app's own copy for F1 cannot be improved (old code). Acceptable only
  because the app is unpublished. From v2 on, every future skew is diagnosed
  exactly (F3).

## Execution

*— claude-opus-5-5, 2026-11-21*

**Load-bearing check, re-run first** (both repros from `.tentacle/tmp/noise-binary-carrier/`,
Bun 1.4.3 arm64, before any edit): `order through splice: text(7) , ab(65535) , ab(1) , text(4)`,
`65535-B message byte-exact: true`, `binary frame of 98305 B → closes: a:1006 b:1009 ; extra frames
delivered: 0`, `Bun client default binaryType: nodebuffer`; `fragment.ts`: `40000+40000 = 80000 B →
delivered=80000`, `60000+60000 = 120000 B → delivered=-1 … eof=true`. Identical to Context. **Holds.**

**As built, in the plan's order.**

1. *Protocol.* `PAIRING_PAYLOAD_VERSION = 2` with its reason (`packages/protocol/src/pairing.ts:28-34`);
   `maxFrameChars`/`preAcceptBytes` comments say chars-or-bytes (`relay.ts:77-81, 99-104`). No wire
   schema changed: `json-schema.test.ts` green with no regeneration, no `protocol.d/` note.
2. *Transport.* `channel.ts`: `CarrierFrame`, `ByteCarrier`, `carrierFrameOf` (the one normalizer every
   adapter uses: `ArrayBuffer`/view → `Uint8Array` over exactly `byteOffset`/`byteLength`, string →
   string, else `null`), `createByteCarrierPair`; `createChannelPair` and it share one private
   `linkedPair`. `noise.ts`: kind `version-mismatch`, optional `remoteVersion`. `noise-frame.ts`: text
   codec removed (`FRAME_TAG`, `MAX_FRAME_TEXT`, `encodeFrame`, `decodeFrame`), base64 kept (P8), Hermes
   comment fixed; new pure `binaryFrame` (text/empty/over-cap → `bad-frame`), `withVersion`,
   `readVersioned` (the receiver checks of Design §2, in that order), `LEGACY_TEXT_TAG`.
   `noise-channel.ts`: `E2E_CHANNEL_VERSION = 2`, `ByteCarrier` in, flights 1–2 versioned, raw
   confirm/transport; responder phase `refused` (refusal `[2]` sent, violation reported at once,
   rejection on the close or the timer — the deny pattern); a `t1:` text message 1 fails at once with
   nothing sent.
3. *Relay.* `apps/relay/src/server.ts`: `DataFrame = string | Uint8Array`, `sizeOf`; data legs forward
   both kinds (binary as a view, no copy); the `1003` branch moved to the control socket and to an
   accept leg before its token; pre-accept and oversize counts by `sizeOf`.
4. *Daemon.* `ws-server.ts`: one generic `WsEnd<In, Out>` (plain route = `WsEnd<string,string>`, device
   route = `WsEnd<CarrierFrame,Uint8Array>` in `ws.data.carrier`); `message` dispatches on which one
   exists. `relay-link.ts`: `RelaySocket.send(string | Uint8Array)`, host delivers `CarrierFrame`,
   `bunRelayDialer` pins `binaryType = "arraybuffer"` and uses `carrierFrameOf`; a binary control frame
   is malformed (never parsed); the data leg is a `ByteCarrier`, its `accept` frame stays JSON text.
   `device-accept.ts`: takes a `ByteCarrier`; pure `violationAudit` → `e2e-version-mismatch remote=<n>
   local=2 (update the app|update tentacle)`.
5. *Client.* `link-machine.ts`: `ChannelError.remoteE2eVersion`. `secure-channel.ts`: dials a
   `ByteCarrier`, `version-mismatch → rejected` (transient) carrying the version. `ws-channel.ts`:
   `WebSocketCarrier` + `webSocketCarrierFactory`, sharing the dial/classification with the text
   factory through one private `dialWith(wrap)`. `pairing.ts`: `dial`/`pairOn` take `ByteCarrier`.
6. *Mobile.* `connection.ts` dials `webSocketCarrierFactory`, `abandon`/`confirm`/`addressOf` on
   `ByteCarrier`; `foreground-gate.ts` untouched. `pairing-flow.ts`: `ByteCarrier` dial/tracked/opened;
   `describePairingError` maps a `ChannelError` with `remoteE2eVersion` to `version`.
   `link-diagnosis.ts`: `update-app` / `update-computer` (streak untouched), extended `maybe-reset`
   sentence.
7. *Docs/changelog.* `e2e-channel.md` Framing + plaintext-peer row, `mobile-relay.md:33`;
   `changelog.d/noise-binary-carrier.changed.md` (the plan's bullet). Test ports as listed, plus the new
   `packages/client/test/ws-carrier.test.ts` (T-C1).

**Drift from Implementation (and why).**

- **D1 — `apps/mobile/App.tsx` changed** (not in Files): `phoneDial` (the pairing screen's dial) built
  the text factory; it now uses `webSocketCarrierFactory` (`App.tsx:978-981`). `tsc -p apps/mobile`
  found it; without it pairing would hand Noise a text channel.
- **D2 — the two new diagnoses reach three more pure modules** (not in Files): `computer-rows.ts`
  (`ComputerRowState` + the two states, no row action), `computer-status.ts` (`SHORT` words; tone
  `attention` but `pairAgain` false — the fix is an update, not a pairing), `project-rows.ts`
  (`ProjectState` + words + detail; `failedState` passes them through instead of folding them into
  `unreachable`/`stopped`). Forced by the exhaustive `Record`s; kept presentation-minimal.
- **D3 — F13/T-C1 "a `Blob` → `bad-frame` close"** is built as: the adapter closes the carrier at once
  (socket closed + `onClose` fired, nothing delivered, never `String(x)`); the Noise layer then sees a
  `closed`, not a `bad-frame`. A carrier has no error channel, and inventing a fake frame to trigger
  `bad-frame` would be a hack. Same observable for the person (a failed dial).
- **D4 — tests first, red by mutation.** The source was edited before the new tests were written, so
  "red on `main`" is shown by mutating each target back (below) rather than by running the new tests
  on `main`'s code. Each mutation reverts exactly the property the test names.
- **D5 — extra tests beyond the list:** F11 empty frame after open, F12 view-at-offset + F13 non-frame
  (`channel.test.ts`), a refusing responder closed by its own timer, T-M2 for both skew directions,
  pure `readVersioned`/`binaryFrame` vectors in `noise-frame.test.ts`.
- Fixture updates forced by the QR bump: `cli/test/pair.test.ts:322`, `mobile/test/deep-link.test.ts:20`,
  `mobile/test/pairing-flow.test.ts` (built from `PAIRING_PAYLOAD_VERSION`; the "future version" case
  is now `v=3`).

**Mutation checks (each run on the narrow file, then reverted; reverted file re-run green).**

| Mutation | Result |
|---|---|
| `readVersioned` ignores the version byte | 5 fail: T-V1 ×3 (0x01, 0x03, timer), T-V2 refusal [3], T-V2 header 0x01 |
| `Secured.emit` sends `encodeBase64(message)` (text) | T-N1, T-N3, T-N4, F11 + the round-trip tests fail (8+ fail) |
| `E2E_CHANNEL_VERSION = 1` | T-N2 (round-trip test), T-N1, T-V1 ×2, T-V2 lone [2] fail |
| `binaryFrame` drops the length check | T-N4 (decrypt was called) + "oversized handshake frame" fail |
| relay: `1003` back on data legs | T-R1 byte-exact + T-R3 fail |
| relay: `sizeOf` counts binary as 0 | T-R3 fails (no `4404`) |
| `ws-server` stringifies device frames | 16/22 `ws-device-route` fail |
| `violationAudit` always `e2e-violation <kind>` | T-D1 fails |
| `relay-link` decodes + parses a binary control frame | T-D2 control fails |
| `WebSocketCarrier` uses `String(event.data)` | T-C1 ×2 fail |
| `version-mismatch → unauthorized` | T-C2 ×2 + table row fail |
| diagnoser skew branch disabled | T-M1 fails |
| `describePairingError` skew branch disabled | T-M2 fails |
| `PAIRING_PAYLOAD_VERSION = 1` | T-P1 (round trip + version refusals) fails |

**Verification (narrow, per the token budget).** All 30 touched test files in one run: `508 pass,
0 fail`. Per-package `tsc --noEmit` clean for `transport`, `daemon`, `apps/relay`, `apps/mobile`;
`client`/`cli` show only pre-existing errors unrelated to this change (`tui` jsx config under `-p
packages/client`; `RoutingAutoAccept`/`attach-run` under `-p packages/cli`) and none in a touched file.
`bunx biome check` on every changed file: clean after `--write` (formatting only). The full `bun run
check` is the orchestrator's gate (not run here, by instruction).

**Unverified:** the RN device path — Hermes `base64-js` cost and that iOS's native module delivers
`type:'binary'` as an `ArrayBuffer` — is read from RN 0.88 source, not run. Verify with one real-phone
session over the relay after the relay deploy (§Deploy step 4) and BF0-E2.

## Review
