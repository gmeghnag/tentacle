# feat/e2e-channel — end-to-end encrypted channel (Noise `DuplexChannel` wrapper)

> **Status:** implementation — approved 2026-11-01 (owner decisions under Open questions)
> **Branch:** `feat/e2e-channel`
> Type: feat · Size: M · Blast: load-bearing · Suited: Opus executes, mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-11-01*

Mobile app task 8 (`docs/eval/mobile-app.md`, table in decision 21). The phone
reaches a daemon through paths that end TLS at a third party (the relay,
cloudflared), so TLS alone would let them read and drive a session. Decision 2
requires a secure channel inside the tunnel on every path, implemented as "one
more transport: a `DuplexChannel` wrapping another".

Binding decisions (linked, not copied): decision 2 (connectivity: E2E on every
path; the link addresses, it never authorises), decision 3 and 7 (pairing, the
per-computer identity and device keys: task 9), decision 20 (crypto is tested
against published vectors, with mutation tests), and "Owner decisions after the
eval was committed": the **approved Task 8 plan**
(`Noise_IK_25519_ChaChaPoly_SHA256` on `@noble/*`, snow / cacophony vectors as a
blocking first step) and the Origin note (device-key connections exempt, decided
in task 9).

**Scope.** Task 8 ships the wrapper, its client-side factory decorator, and
tests that drive the real `RemoteClient` ↔ `Connection`. **No production caller
yet:** `serve` and `connect` behave exactly as today. Keys, the device registry,
the `ws-server` route and the Origin policy are task 9.

**Parallel constraint.** `fix/detach-live` is being executed at the same time.
This plan touches none of its files; the Files section lists each path, and the
wiring that would need one of them does not exist in this scope.

**Repro (2026-11-01).** The capability is missing: `rg noble bun.lock` finds
nothing, there is no `@noble` directory under any `node_modules`, and no file
under `packages/transport/src` mentions Noise. Bun's `node:crypto` cannot stand
in for it: `createCipheriv("chacha20-poly1305", …)` throws
`ERR_CRYPTO_UNKNOWN_CIPHER` on Bun 1.4.3.

The probe below is the evidence for the load-bearing assumption. It wraps the
channel in a sealing decorator with strict counter nonces, fragmentation, base64
text frames and one async exchange before ready. AES-256-GCM stands in for
ChaChaPoly (the property does not depend on the cipher). The handshake is a stub:
this proves the seam, not the crypto. Run with
`bun test ./.tentacle/tmp/e2e-channel/decorator-probe.test.ts`.

```ts
import { createCipheriv, createDecipheriv } from "node:crypto";
import { Agent } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../../../packages/client/src/remote-client.ts";

const KEY = Buffer.alloc(32, 7);
const CHUNK = 65_518;
const stats = { chunks: 0, maxInbound: 0, handshakes: 0, aeadFailures: 0 };

function nonce(n: number): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(n >>> 0, 4);
  return b;
}
function seal(n: number, pt: Buffer): string {
  const c = createCipheriv("aes-256-gcm", KEY, nonce(n));
  const body = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  return body.toString("base64");
}
function open(n: number, text: string): Buffer {
  const b = Buffer.from(text, "base64");
  const d = createDecipheriv("aes-256-gcm", KEY, nonce(n));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]);
}

/** After the two-frame exchange, a ready channel; queue=false shows the race. */
function secure(raw: DuplexChannel, role: "i" | "r", queue = true): Promise<DuplexChannel> {
  let tx = 0;
  let rx = 0;
  let parts: Buffer[] = [];
  let onMessage: ((d: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  const pending: string[] = [];
  let closedEarly = false;
  const flush = (): void =>
    queueMicrotask(() => {
      for (const m of pending.splice(0)) onMessage?.(m);
      if (closedEarly) onClose?.();
    });
  const channel: DuplexChannel = {
    send(data) {
      const all = Buffer.from(data, "utf8");
      let off = 0;
      do {
        const part = all.subarray(off, off + CHUNK);
        off += part.length;
        const flag = off >= all.length ? 1 : 0;
        raw.send(seal(tx++, Buffer.concat([Buffer.from([flag]), part])));
        stats.chunks++;
      } while (off < all.length);
    },
    close: () => raw.close(),
    setOnMessage(h) {
      onMessage = h;
      if (queue) flush();
    },
    setOnClose(h) {
      onClose = h;
    },
  };
  return new Promise((resolve, reject) => {
    raw.setOnClose(() => {
      if (onClose) onClose();
      else closedEarly = true;
      reject(new Error("closed in handshake"));
    });
    let ready = false;
    raw.setOnMessage((text) => {
      stats.maxInbound = Math.max(stats.maxInbound, text.length);
      if (!ready) {
        ready = true;
        stats.handshakes++;
        if (role === "r") raw.send("ack");
        setTimeout(() => resolve(channel), 1); // a macrotask gap before the handler exists
        return;
      }
      let pt: Buffer;
      try {
        pt = open(rx++, text);
      } catch {
        stats.aeadFailures++;
        raw.close();
        return;
      }
      parts.push(pt.subarray(1));
      if (pt[0] === 1) {
        const whole = Buffer.concat(parts).toString("utf8");
        parts = [];
        if (onMessage) onMessage(whole);
        else if (queue) pending.push(whole);
      }
    });
    if (role === "i") raw.send("hello");
  });
}

const big = "x".repeat(300_000);
const model: ModelProvider = {
  id: "m",
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: big };
    yield { type: "done" };
  },
};
const host = new SessionHost({
  defaultCwd: "/tmp/decorator-probe",
  createAgent: () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      env: {
        id: "x",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        readFile: async () => "",
        writeFile: async () => {},
      },
      requestPermission: (req, options) => permissions.request(req, options),
    });
    return { agent, permissions };
  },
});

let lastDaemonRaw: DuplexChannel | null = null;
async function dial(): Promise<DuplexChannel> {
  const [d, c] = createChannelPair();
  lastDaemonRaw = d;
  // Connection only AFTER the handshake: nothing pre-auth reaches RpcPeer.
  void secure(d, "r").then((s) => new Connection(s, host));
  return secure(c, "i");
}

const client = new RemoteClient(await dial(), new PermissionBroker(), undefined, {
  channelFactory: dial,
  random: () => 0,
});
await client.initialize();
const session = client.newSession();
const events: string[] = [];
let text = 0;
for await (const e of session.send("hi") as AsyncIterable<{ type?: string; kind?: string; delta?: string }>) {
  events.push(String(e.kind ?? e.type));
  if (typeof e.delta === "string") text += e.delta.length;
}
console.log("turn 1", { text, kinds: [...new Set(events)], ...stats });

// Lose the link: a redial must run a fresh handshake, same RemoteClient.
const before = stats.handshakes;
(lastDaemonRaw as DuplexChannel | null)?.close();
await new Promise((r) => setTimeout(r, 1500));
console.log("after drop", { newHandshakes: stats.handshakes - before, aeadFailures: stats.aeadFailures });

// Negative control: first frame arrives before setOnMessage, without a queue.
{
  const [a, b] = createChannelPair();
  const got: string[] = [];
  const left = secure(a, "i", false);
  const right = await Promise.all([secure(b, "r", false), left]);
  right[1].send("early");
  await new Promise((r) => setTimeout(r, 5));
  right[0].setOnMessage((m) => got.push(m));
  await new Promise((r) => setTimeout(r, 5));
  console.log("no queue: delivered", got.length, "(the early frame is lost)");
}
process.exit(0);
```

Output:

```
turn 1 {
  text: 300000,
  kinds: [ "text", "turn_end" ],
  chunks: 13,
  maxInbound: 87380,
  handshakes: 2,
  aeadFailures: 0,
}
after drop {
  newHandshakes: 2,
  aeadFailures: 0,
}
no queue: delivered 0 (the early frame is lost)
```

## Implementation

*— claude-opus-5-5, 2026-11-01*

### Load-bearing assumption

**A `DuplexChannel` decorator that completes an async handshake before it
resolves is fully transparent to `RpcPeer`, `Connection` and `RemoteClient`, so
none of them changes.** This requires the channel contract to be: one text frame
in, one text frame out, in order and without loss on one connection, with a
synchronous `send`. Implicit Noise nonces need exactly that, and a fresh dial
must be a fresh channel.

**Proven.** The Repro drives the real `RemoteClient` ↔ `Connection` through such
a decorator with no change to either:

- a whole turn passes, including a 300 000-character event split into 13 chunks;
- every chunk is at most 87 380 text characters (base64 of the 65 535-byte Noise
  maximum);
- zero AEAD failures, so frames arrive in strict counter order;
- a dropped link makes the same `RemoteClient` redial, with a new exchange on
  both ends.

The negative control proves that the decorator **must** queue: a frame arriving
before `setOnMessage` is lost otherwise.

Seam citations: the contract (`transport/src/channel.ts:9-18`), the only use of a
channel by the peer (`transport/src/peer.ts:131-132,243,273`), the async factory
(`client/src/remote-client.ts:177`), a fresh channel per generation
(`remote-client.ts:1245-1256`).

**Not proven by the probe:** the Noise implementation itself (Step 0 + vectors)
and `@noble/*` on Hermes (Step 0c).

### Preconditions

- `send` is synchronous on every channel (`channel.ts:11`), and the RPC peer calls
  it synchronously (`peer.ts:272-274`). `@noble/*` is synchronous, so a nonce is
  taken and a frame emitted with no interleaving. WebCrypto, being async, would
  not allow this; Bun's `node:crypto` has no ChaChaPoly (Repro); and Hermes has no
  WebCrypto (`apps/mobile/polyfills.ts` provides only `randomUUID`).
- Nothing in `DuplexChannel` carries binary or a close reason (`channel.ts:9-18`).
  Both `WsChannel.deliver` and `WebSocketChannel` force strings
  (`daemon/src/ws-server.ts:230`, `client/src/ws-channel.ts:22-23`).
- The dial deadline already wraps a factory: 15 s (`client/src/link-machine.ts:25`,
  `remote-client.ts:1151-1158`), and a late channel is closed (`:1168-1170`). A
  factory error flows to `redial` (`:1246-1248`). `connectTui`'s first dial sits
  outside that deadline (`cli/src/connect.ts:113`), so the wrapper needs its own
  timeout.
- `unauthorized` and `gone` are terminal, the other kinds retry
  (`link-machine.ts:85-91`).
- `createChannelPair` drops a frame queued just before a close, because `close()`
  sets `other.closed` synchronously and delivery re-checks it (`channel.ts:40-44,52-54`).
  A real socket does not. The design must not depend on "send, then close".
- The peer's size check counts UTF-16 units and answers an error instead of
  closing (`peer.ts:281-285`). The daemon limit is 8 MiB (`ws-server.ts:54,224`);
  the client sets none (`remote-client.ts:1020`, no `maxFrameBytes`).
- `Connection` only needs a channel at construction (`daemon/src/connection.ts:106-121`).
- `@tentacle/transport` and `@tentacle/client` export only `"."`
  (their `package.json`), and the CLI, pod binary and app all import them. A
  subpath keeps crypto out of every existing import path.

### Design

**Keys in task 8.** Keys are parameters: 32-byte `Uint8Array`s. Tests use fixed
test keys. `generateStaticKeypair(random)` is exported because tests and task 9
need it. Nothing is stored and nothing reads the config directory. Where the
daemon identity lives, the registry, QR and Keychain are all task 9.

**Three pure modules + one decorator, all in `packages/transport/src/`**, reached
only through a new subpath `@tentacle/transport/noise`:

- `noise.ts` — pure Noise, spec revision 34: `CipherState`, `SymmetricState`, and
  the IK handshake as two explicit roles. The ephemeral key is injected, which is
  what makes vectors possible. `@noble/*` only here.
- `noise-frame.ts` — pure framing: the text codec, chunking, reassembly.
- `noise-channel.ts` — `noiseInitiator(raw, opts)` and `noiseResponder(raw, opts)`,
  each `Promise<SecureChannel>`, where
  `SecureChannel = DuplexChannel & { readonly remoteStatic: Uint8Array }`.

**Handshake, three flights.**

1. → IK message 1 (`e, es, s, ss`) with an **empty payload**. IK's first payload
   has no forward secrecy and can be replayed, so it never carries anything.
2. ← IK message 2 (`e, ee, se`), payload one status byte: `0x00` allow, `0x01`
   deny. The responder calls `authorize(remoteStatic)` (sync or async) between
   the two. A throw or rejection fails closed: it closes, no message 2.
3. → **confirm**: the first transport message, type `0x02`.

The responder resolves only after the confirm decrypts. **This is needed:** a
replayed message 1 passes `authorize` and gets a message 2, because the responder
cannot tell it from a live one. Without the confirm, a relay replaying a captured
message 1 would make the daemon build a `Connection` and record "last seen" for a
device that is not there. It still could not read or send anything, but the
state would be false. The confirm costs no round trip, since `initialize` follows
at once on the same flight.

A deny is carried in message 2 because that signal is **authenticated**: only the
holder of the daemon's static key can produce it, so the client may stop retrying
without an on-path party being able to fake it. After a deny the responder does
not close; the initiator closes on reading it, and the handshake timer covers one
that never does. This also avoids the send-then-close loss in the Preconditions.

Nothing reaches `RpcPeer` before the confirm: the daemon constructs its
`Connection` on the resolved channel, as the probe does.

**Prologue and versions.** Prologue = ASCII `tentacle-e2e/1`
(`E2E_CHANNEL_VERSION = 1`, a constant of this channel).

- `PROTOCOL_VERSION` is deliberately **not** bound. Binding it would turn a version
  skew into an opaque handshake failure, where §7 requires a clean `VersionMismatch`
  at `initialize`, which still runs inside the channel.
- Role is not bound either: IK's roles are asymmetric, and Noise's `Split()` gives
  each direction its own key, so a reflected frame fails to decrypt (tested).
- The address is not bound (decision 2: the link addresses, it never authorises).
  A relay cannot redirect the client elsewhere, because `rs` is pinned.

**Framing.** A wire frame is the text `t1:` + canonical base64 of one Noise
message. The tag lets a peer not speaking this channel (or another version) fail
with a clear error before any decrypt, and is covered by the prologue version.

- A Noise message is at most 65 535 bytes (spec), and RPC frames reach megabytes,
  so a frame is split. The plaintext of each transport message is one type byte +
  up to 65 518 bytes.
- Types: `0x00` continuation, `0x01` final, `0x02` confirm (handshake only). Any
  other value is a violation. The type byte is inside the AEAD, so truncation or
  re-marking cannot pass unnoticed.
- Bytes are concatenated before UTF-8 decoding, so a multi-byte character split
  across chunks survives. An empty string is one `final` message with no content.
  Inputs are `JSON.stringify` output, so lone surrogates do not occur.
- Associated data is empty. The transcript and the strict counter already bind
  position.

**Sizes.** Inbound text longer than `3 + 87 380` characters fails before decoding.
Reassembly is capped by `maxMessageBytes`:

- responder default 32 MiB, above the 24 MiB that the worst-case 8 MiB-unit frame
  needs in UTF-8, so the peer's own "frame too large" answer keeps working;
- initiator default 256 MiB: the client has no frame limit today and snapshots are
  not bounded, and the daemon is pinned. Over the cap the channel closes loudly.

Task 9 should set a lower responder cap on any connection from an unknown key.

**Nonces, rekey.** Implicit counters, one per direction, 64-bit per the spec,
kept as a `number` and stopped at `Number.MAX_SAFE_INTEGER`, closing loudly.
Incremented **before** the raw send, so an exception cannot reuse a nonce.

**No rekey.** Keys live for one connection, 2^53 messages is unreachable, and each
redial brings fresh ephemerals, hence forward secrecy per connection. Adding it
later needs an `E2E_CHANNEL_VERSION` bump, which is cheap pre-public.

**Any failure closes, never drops.** AEAD failure, replay, reorder, gap, malformed
frame, unknown type or over-cap all do the same: close `raw`, discard partial
reassembly, deliver nothing unauthenticated, report through
`onViolation(error: NoiseError)`, then upper layers see `onClose`. After close,
`send` is a no-op, per the contract. A cut connection needs no authenticated close
message: frames are delivered whole, and the RPC layer already resyncs after a drop.

**Delivery before handlers.** Decrypted frames and a close received before
`setOnMessage` are queued and flushed on a microtask, so `RpcPeer` has set both
handlers (`peer.ts:131-132`). Queue order is frames, then close. The queue is
bounded by `maxMessageBytes`.

**Randomness.** `random: (n) => Uint8Array` is a required option, with no silent
fallback; output of the wrong length fails the handshake. `systemRandom` (WebCrypto)
is exported for Bun. The app passes `expo-crypto` in task 11.

**Options.** `{ staticKey, remoteStatic | authorize, random, handshakeTimeoutMs?,
maxMessageBytes?, onViolation? }`, plus an injectable timer. The timeout defaults to
10 s, below the 15 s dial deadline, so the error stays specific; it also bounds an
unauthenticated socket, which WebSocket pings would otherwise keep open
(`ws-server.ts:75-78`).

**The client.** `packages/client/src/secure-channel.ts` exports
`secureChannelFactory(dial, opts): () => Promise<SecureChannel>`, which decorates
any factory (`webSocketChannelFactory`, the app's `rn-websocket`), plus the error
mapping, needed here because `ChannelError` lives in the client:

| `NoiseError` | `ChannelError` kind | Why |
|---|---|---|
| `denied` | `unauthorized` (terminal) | authenticated by message 2 |
| `timeout`, `closed` | `unreachable` | a network failure looks identical |
| `handshake-failed`, `bad-frame` | `rejected` (transient) | unauthenticated: if terminal, an on-path party could stop the client for good |

A `closed` during the handshake is also what a wrong pinned daemon key looks like,
so its message says so.

**Exposed as subpaths** `@tentacle/transport/noise` and
`@tentacle/client/secure-channel`, not from `index.ts`, so existing importers load
no crypto. If noble failed on Hermes, the app's existing path is unaffected.

**Relative to token and Origin.** Noise sits inside the socket, after the HTTP
upgrade. Task 8 changes neither: `authorize` in `ws-server.ts:184-198` is untouched.
Task 9 decides the route. A phone has no master token and iOS always sends `Origin`
(`ws-server.ts:116-121`), so it needs an upgrade that lets a device-key connection
through, with authentication being `authorize(remoteStatic)`. Unknown keys for
pairing go through `authorize` too: the pairing code goes **inside** the confirmed
channel, never in message 1 (replayable).

**Dependencies (executor's first step; not installed now).** In
`packages/transport/package.json`, exact pins, repo style: `@noble/ciphers`,
`@noble/curves`, `@noble/hashes`. All pure JS, MIT, no native code.

**Unverified:** the network was refused in this session, so `npm view` could not
run. From memory, the current line is 2.x (ESM-only; imports need the `.js`
subpaths, e.g. `@noble/curves/ed25519.js`), about `2.0.1`. Step 0a picks the
versions; the audit status below is also from memory.

### Files

All paths are disjoint from the `fix/detach-live` list. In dependency order:

| # | File | Change |
|---|---|---|
| 1 | `packages/transport/package.json` | three `@noble/*` deps; `exports["./noise"]` |
| 2 | `bun.lock` | regenerated by the install |
| 3 | `packages/transport/test/vectors/noise-ik-25519-chachapoly-sha256.json` | new, filtered vendored vectors |
| 4 | `packages/transport/test/vectors/README.md` | new: source, commit, licence, filter |
| 5 | `packages/transport/src/noise.ts` | new |
| 6 | `packages/transport/src/noise-frame.ts` | new |
| 7 | `packages/transport/src/noise-channel.ts` | new (the subpath's entry, re-exporting what callers need) |
| 8 | `packages/transport/test/noise-vectors.test.ts`, `noise-frame.test.ts`, `noise-channel.test.ts` | new |
| 9 | `packages/client/package.json` | `exports["./secure-channel"]` only |
| 10 | `packages/client/src/secure-channel.ts` | new |
| 11 | `packages/client/test/secure-channel.test.ts` | new |
| 12 | `NOTICE` | only if a vendored licence requires it |
| 13 | `docs/feat/e2e-channel.md` | this doc |

**Not touched, by design:** `transport/src/{channel,peer,index}.ts`,
`client/src/{index,ws-channel}.ts`, `daemon/src/ws-server.ts`, `@tentacle/protocol`,
`apps/mobile`. No `PROTOCOL_VERSION` bump: the RPC inside is unchanged.
`apps/mobile/package.json` needs no dependency unless Step 0c shows Metro requires
one; that would be recorded as drift.

**Follow-ups, task 9:** the `ws-server` route and Origin policy, the `Connection`
built on the resolved channel, the `connect`/app dial wiring, key storage, an
audit line from `onViolation`, a handshake rate limit, and rechecking
`backpressureLimit`. **Task 11:** `random` from `expo-crypto`, Hermes throughput on
a real session. **Not required by this task:** `AGENTS.md` (no fact in §6 changes,
and it belongs to the other branch now).

### Execution order

**Step 0 is blocking: stop and fix this plan if any part fails.**

- **0a. Dependencies.** Network required. Check `npm view` for the three packages;
  pin the latest stable of one major line, with `@noble/hashes` equal to what
  `@noble/curves` depends on (no duplicate). Read each README's audit section and
  record in Execution which audited version the pin sits on. Install from the root.
- **0b. Vectors.** Fetch snow's `tests/vectors/snow.txt` and `cacophony.txt` at a
  **pinned commit**. Check both licences (from memory: snow Apache-2.0/MIT,
  cacophony public domain; unverified). Keep only entries named exactly
  `Noise_IK_25519_ChaChaPoly_SHA256`, without PSK. Filtering keeps the file under
  Biome's size limit (Biome lints JSON: run `biome check --write` on it). If
  **either** source has none, stop. Field names here must come from the real file;
  this plan could not read it.
- **0c. Hermes.** In a throwaway copy under `.tentacle/tmp/e2e-channel/`, as the
  spike did: confirm `expo export --platform ios` bundles a file importing the three
  noble subpaths, then run on the simulator one X25519 + one ChaChaPoly round + a
  `TextDecoder` use, and log timings for 1 MiB. Failure stops the task: the approved
  plan assumes these work.
- **1.** Vector test red (no implementation) → `noise.ts` → green. **Nothing else
  starts before this is green.**
- **2.** `noise-frame.ts` red → green. **3.** `noise-channel.ts` red → green.
  **4.** `secure-channel.ts` red → green. **5.** Mutations, gate, Execution.

### Failure modes

| Case | Behaviour | Convergence |
|---|---|---|
| Wrong pinned daemon key | Responder cannot decrypt message 1, closes; `onViolation` | client: `closed` → `unreachable`, retries, message names the key |
| Unknown or revoked device | `authorize` false → message 2 deny | client: `unauthorized`, terminal, no retry loop |
| `authorize` throws or rejects | Fail closed: close, no message 2 | as a transient failure; reported to the operator |
| Socket closes during `authorize` | Result ignored, nothing built | promise rejects `closed` |
| Replayed message 1 | Message 2 sent, confirm never comes | handshake timeout; no `Connection`, no "seen" |
| Garbled or forged message 2 | Decrypt fails → close | `rejected`, transient, never terminal |
| Status byte unknown | Violation → close | as above |
| Low-order `e` or `s` (zero DH) | DH must throw → handshake fails | closed; verified by test, not assumed of noble |
| Plaintext peer (old daemon answers JSON) | Missing `t1:` → `bad-frame` | clear error, no decrypt attempted |
| Another `E2E_CHANNEL_VERSION` | Tag mismatch → close | clear on the responder; generic `closed` on the initiator |
| Silent peer | Timer closes raw | `timeout`; both ends |
| Oversized handshake frame | Rejected before decoding | closed |
| Tampered, duplicate, reordered, dropped transport frame (incl. Bun dropping past backpressure) | AEAD fails on the counter | close + `onViolation`; client redials and resyncs |
| Reflected frame | Wrong direction key, fails | as above |
| Frame replayed on a new connection | New keys, fails | as above |
| Connection cut mid-fragment | Partial discarded, nothing delivered | normal redial |
| Over `maxMessageBytes` | Close before buffering more | responder: closes where plain answers an error (documented drift, above the 24 MiB worst case). Initiator: a repeating frame redials with backoff, visible in link status |
| Nonce limit | Close before reuse | redial |
| Raw `send` throws | Nonce already consumed; close | redial |
| Frame or close before handlers are set | Queued, flushed in order | delivered |
| Client gives up during the dial | Late channel closed (`remote-client.ts:1168-1170`); wrapper timer closes raw if it was still handshaking | no orphan |
| `close()` during handshake | Raw closed, promise rejects | no orphan |
| RPC version skew | Passes the channel, `initialize` answers | clean `VersionMismatch`, terminal |
| RNG missing or wrong length | Handshake fails before any send | loud; no weak key |
| Noble blocks the loop on a big frame | Synchronous by necessity | unmeasured on Hermes; Step 0c and task 11 |

### §7 invariants

- **TUI always over RPC / one session path:** a transport decorator only; no second
  send or stream path.
- **Logic in pure modules:** `noise.ts`, `noise-frame.ts` are pure and React-free;
  `noise-channel.ts` only sequences them.
- **Don't serialize the RPC peer:** no await or lock on the data path. `send` and
  decrypt are synchronous; the only async part ends before the peer exists. A test
  pins that a long `session/prompt` does not block a `session/enqueue` over the channel.
- **Protocol:** no schema change, no version bump; `PROTOCOL_VERSION` stays outside
  the prologue so `VersionMismatch` stays clean. `E2E_CHANNEL_VERSION` is a separate
  truth, like `DAEMON_RECORD_VERSION`.
- **Single broker, persistence, model on the laptop:** untouched. `model/stream`
  would pass as ordinary frames. Task 8 stores nothing.
- **Pod not trusted:** no pod path uses this. Task 9 must keep device keys off pods.
- **Never write raw to the terminal:** the module does not write; errors go through
  `onViolation`.
- **Pod lifecycle, Bun TLS:** untouched.

### Tests

All with `createChannelPair`, injected timers and fixed keys; no real I/O except one
loopback. In order, each shown red first:

1. **`noise-vectors.test.ts` — the first red test.** For every vendored vector,
   drive initiator and responder with the vector's keys, ephemerals and prologue:
   every ciphertext byte-equal, both directions, the handshake hash equal, and the
   transport messages after it. **Asserts a non-zero count per source**, so an empty
   filter cannot pass.
2. **`noise-frame.test.ts`.** Base64 against RFC 4648 and `Buffer`; non-canonical
   input refused. Chunks at 0, 1, 65 517, 65 518, 65 519 and 200 000 bytes; a
   multi-byte character across a boundary; unknown type; cap exceeded by one.
3. **`noise-channel.test.ts`.** One test for each row of Failure modes that concerns
   the channel. In particular: a replayed message 1 never resolves the responder and
   never yields a frame; deny reaches the initiator on `createChannelPair`; each of
   tamper, duplicate, reorder, drop and reflect closes and calls `onViolation` and
   delivers nothing; a low-order key fails; nonce limit, via a `CipherState` started
   near it; early frames are not lost (the probe's negative control, inverted).
   One real loopback `Bun.serve` WebSocket carries a 1 MiB frame in maximum-size
   chunks, the only proof against real text frames.
4. **`secure-channel.test.ts`.** The real `RemoteClient` ↔ real `Connection` over
   Noise: a whole turn with a frame over 64 KiB; a drop redials with a fresh handshake
   and the session resumes; `denied` stops the link (`stopped`, no further dial);
   `closed` retries; concurrent `session/prompt` + `session/enqueue`; an
   `initialize` with a wrong version gives a clean `VersionMismatch`; the mapping table.

**Mutation targets (§9), each must turn a test red, then be reverted:**

- `InitializeSymmetric`: hash the protocol name instead of the spec's rule. The name
  is **exactly 32 bytes**, the boundary of that rule (vectors).
- Swap the `Split()` keys. Big-endian nonce. Skip mixing the prologue. Skip `MixHash`
  of `e`.
- Break key verification: ignore `remoteStatic` from message 1, or accept a tag
  failure (decision 20).
- Resolve the responder on message 1 instead of the confirm (replay test).
- Nonce incremented after the send. Do not increment on one path.
- Drop the frame on AEAD failure instead of closing (the silent-drop bug).
- Remove the queue. Make the type byte unauthenticated. Fragment before UTF-8 encoding.
- Map `handshake-failed` to `unauthorized` (an on-path party could stop the client).
- Fail open when `authorize` throws.

### Open questions for the owner

- **Production wiring in task 8?** (a) none, task 9 wires it; (b) a dormant
  `ws-server` option. **Recommendation: (a)** — the route decides who skips the token,
  which belongs with the registry and the Origin decision.
- **Frame encoding?** (a) base64 in today's text channel, +33%; (b) binary, changing
  `DuplexChannel`, `WsChannel` and `WebSocketChannel`. **Recommendation: (a)** — no seam
  change; revisit if task 11 measures a real cost.
- **Laptop `connect` over Noise too?** (a) token/TLS as today, phone only; (b) later
  migration. **Recommendation: (a)** — decision 2's threat is third-party terminators,
  and a `connect` user has a token; revisit in task 9.

**Owner decisions (2026-11-01), binding:** Q1 = **(a)** no production wiring in task 8 (task 9 wires it); Q2 = **(a)** base64 frames on today's text channel; Q3 = **(a)** laptop `connect` stays token/TLS, Noise for the phone only (revisit in task 9). Plan APPROVED. *— orchestrator (claude-opus-5-5), 2026-11-01*

**Owner note (2026-11-01, later):** Q2 stays (a) base64 for now, but binary frames are WANTED before the app ships, to avoid redoing it: additive binary send/receive on the two WebSocket ends only (`client/src/ws-channel.ts`, `daemon/src/ws-server.ts`), `DuplexChannel` unchanged. Decide together with attachments sub-task 2 whether JSON-RPC also gets binary frames (file bytes would otherwise stay base64 inside JSON). Tracked as debt; not in this branch. *— orchestrator (claude-opus-5-5), 2026-11-01*

## Execution

*— claude-opus-5-5, 2026-11-01*

Worktree off `main` 982c3c0. Baseline before any code: `bun test packages`
**3884 pass, 3 skip (the opt-in ones), 0 fail**, 3887 tests in 269 files.

**Capability missing (Repro).** I did not re-run the probe. The capability was
missing because `bun.lock` had no `@noble/*` entries before the install (the
diff only adds them) and none of the new `transport/src/noise*.ts` files
existed.

### Step 0

- **0a. Dependencies: done.** `npm view`: `@noble/ciphers`, `@noble/curves` and
  `@noble/hashes` are all at latest `2.4.0` (ciphers 2.4.0 published
  2026-08-27). `@noble/curves@2.4.0` depends on exactly `@noble/hashes@2.4.0`,
  so there is no duplicate. All three are MIT and have no other dependency.
  They are pinned exactly in `packages/transport/package.json` and installed
  from the root (`bun install --filter '!@tentacle/mobile'`). The `bun.lock`
  diff is +9 lines: the three packages and the workspace entry, nothing else.
  Audit status, from each README's Security section:
  - curves: audited **at 2.3.0** (Aug 2026, Trail of Bits, scope "everything").
    The pin is one minor release past that audit.
  - ciphers: audited at 1.0.0 (Sep 2024, Cure53, everything).
  - hashes: audited at 1.0.0 (Jan 2022, Cure53, everything except blake3,
    sha3-addons, sha1 and argon2; we use sha256 and hmac).
  - All three note "AI-assisted self-audits since Apr 2026". The 2.x lines of
    ciphers and hashes are therefore past their last third-party audit.
- **0b. Vectors: done, with drift in how they were fetched.** `curl`, `gh api`
  and `git ls-remote` were all denied by the session's permissions. I read the
  files through the WebFetch tool at the pinned snow commit
  `8ac60f51cfe3e010c84f0a454cc575ad9204fa12` (2026-03-25). Each source has
  exactly one `Noise_IK_25519_ChaChaPoly_SHA256` entry: snow at 4 messages,
  cacophony at 6.
  - **The plan's format assumption was partly wrong:** snow entries have **no
    `handshake_hash`**, and cacophony entries have no `*_psks` fields. The test
    compares the hash only when the entry has one.
  - Copying by a model is not byte-exact. This is safe because an independent
    implementation must reproduce every ciphertext, so a copying error fails the
    test and cannot make it pass. One field, cacophony's message 2 ciphertext,
    came back ambiguous. The reading with the right length (126 hex: 32 e +
    15 payload + 16 tag) is the one vendored. The matching handshake hash, which
    covers that ciphertext, confirms it.
  - Licences: snow is Apache-2.0 OR MIT, used under MIT, and its notice is
    reproduced in `vectors/README.md`. I took the MIT body to be the standard
    text: the fetch reported only the title and copyright line. cacophony is
    Unlicense / public domain (cacophony commit `8ee9d41e`). No `NOTICE` change.
  - **Open item:** run the `curl | jq` diff in `vectors/README.md` once, to
    confirm the vendored JSON byte for byte against upstream.
- **0c. Hermes: BLOCKED, so it is an open item for the owner.** No simulator
  was booted (`xcrun simctl list devices booted` showed none). This worktree
  has no `apps/mobile` dependencies. The old spike copy under
  `.tentacle/tmp/mobile-spike/` has no Expo install either. An `expo export` or
  a simulator run would need the full mobile install, which is outside this
  task's dependency scope. Nothing was run on Hermes. The code avoids
  `Buffer`/`btoa` (its base64 is in-house) and calls `TextEncoder` and a
  non-fatal `TextDecoder` only. Hermes support for noble's BigInt and for
  `TextDecoder` is still unverified.

### As built (plan order, each test red first)

1. `noise-vectors.test.ts`, then `noise.ts`. Red against a stub returning empty
   bytes (`Expected: "6d21fec9…" Received: ""`, 2 fail). Green: 2 pass, 29
   expects.
2. `noise-frame.test.ts`, then `noise-frame.ts`. Red: 12/12 fail on
   assertions. Green: 12 pass.
3. `noise-channel.test.ts`, then `noise-channel.ts`. Red: 39 fail. The 2 that
   passed are the `CipherState` nonce tests, which `noise.ts` already served.
   - First green run had 1 fail: the "replayed on a new connection" test reused
     the same deterministic ephemerals, so both connections had the same keys.
     I fixed the test (a new seed). The code was right.
   - Then a real bug, found by reading the code: the responder kept a local
     copy of the phase. A socket closed during `authorize` could therefore
     still build a `Secured` and overwrite the outer `failed`. I made the phase
     one source of truth and tightened the test to count attempted raw sends
     (mutant M16 below).
4. `secure-channel.test.ts`, then `client/src/secure-channel.ts`. Red: 10 fail.
   The 2 that passed were the two `rejected` rows, which the stub returned by
   coincidence. Green: 12 pass.

Lint (`biome check --write`) changed only formatting and import order.

### Drift from Implementation

- Vector fetch method and format, as described under 0b.
- **`NoiseErrorKind` stays the plan's five.**
  - A post-handshake violation reports `bad-frame`.
  - The nonce limit and a throwing raw `send` report `closed` through
    `onViolation`.
  - `onViolation` fires for `handshake-failed`, `bad-frame` and `timeout`. It
    does not fire for `denied` or a plain `closed`.
- **After a deny, the responder rejects `denied` only once the initiator
  closes, or on its timer.** It does not reject at once, so no caller closes
  raw and drops message 2 before it is delivered.
- **Extra exports:** `PROLOGUE`, `HandshakeTimer`, `StaticKeypair`, `Random`,
  `DEFAULT_HANDSHAKE_TIMEOUT_MS`, `RESPONDER_/INITIATOR_MAX_MESSAGE_BYTES`, and
  `channelErrorFromNoise` (exported so the table can be tested).
- **The pre-handler queue cap counts UTF-16 units, not bytes.** It can admit up
  to about 3× `maxMessageBytes` in bytes for BMP-heavy text. This is minor
  debt.
- **"Nonce incremented after the send" cannot be expressed as a mutant.** The
  increment happens inside `CipherState.nextNonce`, before the ciphertext
  exists. I mutated the nearest real risk instead (a throwing send keeps going)
  and "no increment on one path".
- A low-order `s` inside message 1 is not tested on its own. A low-order `rs`
  (initiator) and a low-order `e` (responder) are.

### Mutations (§9)

Method: `cp` each source to `.tentacle/tmp/e2e-channel/`, record its sha256,
apply one mutant, run the narrow test, `cp` it back. After each restore the
sha256 matched the original. At the end:

- `noise.ts` `66251253…`
- `noise-frame.ts` `810378e2…`
- `noise-channel.ts` `b5aa32af…`
- `secure-channel.ts` `87865ef4…`

| # | Mutant | Result |
|---|---|---|
| M1 | `InitializeSymmetric`: 32-byte name hashed (`<=` → `<`) | killed: both vectors |
| M2 | swap `Split()` keys | killed: both vectors |
| M3 | big-endian nonce | killed by **cacophony only**: snow never reaches nonce 1 |
| M4 | skip mixing the prologue | killed: both vectors |
| M5 | skip `MixHash(e)` | killed: both vectors |
| M6 | `authorize` gets the responder's own key, not `rs` | killed: 16 tests |
| M7 | accept a tag failure | killed. **At first by 1 test only**: the garbage tripped the type check instead. Tests strengthened (assert "decryption failed", plus a direct per-byte AEAD test); now 10 tests |
| M8 | resolve the responder on message 1, before the confirm | killed: replay test |
| M9 | decrypt never advances its counter | killed: 7 tests and cacophony |
| — | a throwing raw send keeps going (stand-in for "increment after send") | killed |
| M10 | drop the frame on AEAD failure instead of closing | killed: 9 tests |
| M11 | remove the queue | killed: delivery-before-handlers |
| M12 | type byte sent outside the AEAD | killed: the relay re-marked a frame and the peer got `"firstsecond"` |
| M13 | fragment before UTF-8 encoding | killed: byte bound per chunk |
| M14 | `handshake-failed` → `unauthorized` | killed: mapping table |
| M15 | fail open when `authorize` throws | killed |
| M16 | drop the closed-during-authorize guard | killed |
| M17 | drop our own all-zero DH check | **survives**: an equivalent mutant, because noble already rejects low-order points by default. Our check is defense in depth |
| M18 | accept a payload in message 1 | killed |
| M20 | reassembly cap off by one | killed |
| M21 | drop the canonical-base64 check | killed |

### Gate

This worktree has no `apps/mobile` dependencies, so I ran the three checks
directly instead of `bun run check`:

- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: clean (590 files, 0 errors, 0 warnings).
- `bun test packages`: **3952 pass, 3 skip (the same opt-in ones), 0 fail**,
  3955 tests in 273 files. Against the baseline (3884 / 3 / 0, 3887 tests in
  269 files) that is +68 tests in +4 files (2 vector, 12 frame, 42 channel,
  12 client), with no new failure or skip. No load flake showed up.

Changed files, all in the Files list:

- `bun.lock`
- `packages/transport/package.json`
- `packages/client/package.json`
- the three `transport/src/noise*.ts`
- `client/src/secure-channel.ts`
- the four new test files
- `test/vectors/*`
- this doc

There are no stray `apps/mobile/*.js` files, and nothing outside the list was
touched.

### Unverified

- Hermes (0c).
- The vendored vectors against the raw upstream bytes (one `curl | jq` diff).
- The MIT notice body.
- Throughput on a real phone (task 11).

## Review

*— claude-opus-5-5, 2026-11-02*

**Verdict: APPROVE-WITH-NITS (ready to merge).** No finding blocks the merge.
Step 0c (Hermes) is still **not verified**, and it is an owner item: the
reviewer was blocked too (see below). Hermes is not a merge gate for this
branch, because nothing in it is wired to the app (Q1 a) and the code is
reachable only through new subpaths. It **must** pass before task 9 or 11
imports `@tentacle/transport/noise` in `apps/mobile`.

The reviewer is the same model as the executor (claude-opus-5-5); only the
context is fresh. Shared blind spots can survive both passes. A cross-model
pass on `noise.ts` alone (334 lines) would be cheap insurance.

The 2026-11-01 partial review was a stub with no claims, so nothing was
carried over. Every claim below was re-checked on 2026-11-02.

### Findings

1. **Low: frames are delivered after the upper layer's own `close()`.**
   `packages/transport/src/noise-channel.ts:222-227`. `flush()` keeps
   delivering queued frames after `Secured.close()` (`:152`) has run.
   - Repro: 3 frames are queued before the handlers exist. The handler calls
     `ds.close()` on the first one, and all three are still delivered
     (`["a","b","c"]`).
   - `createChannelPair` never delivers to a closed end (`channel.ts:41`).
   - The frames are authenticated, so this is a contract divergence and not a
     security hole.
   - Fix: stop the loop on a *local* close, while still flushing frames
     received before a *remote* close (the existing "frames, then close" test
     must stay green).
2. **Low: a leading U+FEFF is stripped, so the channel is not byte-transparent.**
   `packages/transport/src/noise-frame.ts:27`. The `TextDecoder` default
   (`ignoreBOM: false`) silently drops a leading BOM: `send("﻿abc")`
   arrives as `"abc"`.
   - It cannot be reached through `RpcPeer`, because `JSON.stringify` output
     starts with `{` or `[`. It is still a silent change in a channel that
     claims to be transparent.
   - Fix: `new TextDecoder("utf-8", { ignoreBOM: true })`. `fatal: true` would
     also suit the fail-loud rule, if Hermes supports it (check in 0c).
3. **Nit: the high-word nonce test proves too little.**
   `packages/transport/test/noise-channel.test.ts:821-827` asserts only that
   nonce 2^32+5 ≠ nonce 5. A big-endian high word, or one written at the wrong
   offset, would also pass, and no vector goes past nonce 1. This is
   unreachable in practice (2^32 messages on one connection), but the test name
   claims "little-endian". Fix: compare against a nonce built by hand
   (`00000000 05000000 01000000`).
4. **Nit: a bad confirm reports the wrong kind.** On the responder, a confirm
   that fails to decrypt reports `bad-frame` instead of `handshake-failed`
   (`noise-channel.ts:171`; `asNoise` keeps the inner kind). This affects the
   audit line only; the client mapping is not involved.
5. **Info for task 9:**
   - `authorize` runs on every replayed message 1, by design.
   - The Design's "no false last seen" holds only if task 9 records
     "seen" and success audits on the **resolve** and never inside `authorize`.
     A replay also costs the daemon 2 DH plus one `authorize` call, so the rate
     limit already listed as a follow-up is needed.
   - A raw dial of *t* seconds plus the 10 s handshake can exceed the 15 s
     `LIVENESS_MS`. The error then becomes the generic `unreachable`, which
     still converges.

### Gate (re-run by the reviewer)

The worktree has no `apps/mobile` deps, so I ran the three checks directly, as
the executor did:

- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: 590 files, no fixes.
- `bun test packages`: **3952 pass, 3 skip, 0 fail**, 3955 tests in 273
  files. This is identical to Execution.

### Crypto against Noise rev 34 (read line by line against the spec)

| Property | Where | Verdict |
|---|---|---|
| `InitializeSymmetric`: name ≤ HASHLEN padded, else hashed; `ck = h` | `noise.ts:153-163` | correct (the 32-byte name is the boundary; M1 kills it) |
| Pre-message `<- s`: `MixHash(prologue)`, then `MixHash(rs)` on both sides | `:234-235`, `:286-287` | correct |
| msg 1 `e, es, s, ss` + `EncryptAndHash(payload)` (an empty payload still yields a 16-byte tag) | `:238-245`, `:296-310` | correct; the minimum length of 96 is right |
| msg 2 `e, ee, se` (initiator `DH(s, re)`, responder `DH(e, rs)`) | `:247-257`, `:312-321` | correct |
| `HKDF` with 2 outputs, HMAC-SHA256 | `:80-85` | correct |
| `Split`: initiator sends with c1, responder sends with c2 | `:259-263`, `:323-327` | correct (R1 kills a swap) |
| Nonce: 4 zero bytes, then the 64-bit counter little-endian | `:115-126` | correct up to 2^53; it stops at `MAX_SAFE_INTEGER`, well below the reserved 2^64-1 |
| A decrypt failure does not advance n | `:134-144` | correct (spec §5.1); the channel closes anyway |
| Low-order / zero DH | `:66-77` + noble | see "M17" below |
| Prologue binds `tentacle-e2e/1` only (not `PROTOCOL_VERSION`, not the role) | `noise-channel.ts:27` | sound: the roles are asymmetric, and reflection fails (tested) |
| Secrets in logs or errors | every `NoiseError` message | none: messages are fixed strings, plus the `authorize` error text, which is the caller's |
| Ephemeral fresh per handshake, RNG length checked, no fallback | `noise-channel.ts:88-97,357,397` | correct |

**The vector test consumes every field.** It uses the prologue of both roles,
both statics, both ephemerals, `init_remote_static`, every handshake
ciphertext in both directions, and the responder's learned `rs` (checked
against `x25519(init_static)`). It also uses every transport message after
`Split`, in alternating directions (snow 2, cacophony 4, so cacophony reaches
nonce 1), and `handshake_hash` when present (cacophony). It checks
`length > 0` per source. The `*_psks` fields are empty and unused, which is
right for non-PSK IK. The orchestrator confirmed the vendored JSON is identical
to upstream at `8ac60f5`, which closes Execution's "Unverified" vectors item.

**M17 (zero-DH check, "equivalent mutant") is proven equivalent.** In
`@noble/curves@2.4.0`, `abstract/montgomery.js:195-221` rejects the full
low-order set {0, 1, p-1, and the two order-8 u}. It does so *before* the
ladder, and after `decodeU` reduces mod p, so non-canonical encodings fold in.
A scratch test fed 12 encodings: each canonical value, each value + p where it
fits in 255 bits, and each value with bit 255 set. noble accepted **0** of
them. A low-order **initiator static inside message 1**, the case the executor
left untested, also fails the responder with `handshake-failed` for all 12
encodings. Our check therefore stays as defense in depth against a future
noble regression. Nothing tests it in isolation, and nothing can until noble
stops rejecting first.

### Framing and channel attacks tried

- **Bit-flip on the relay** (scratch E2E through a relay of two
  `createChannelPair`s): the daemon got `["ok"]` and never the tampered frame.
  `onViolation` reported `bad-frame: decryption failed`, and the upper
  `onClose` fired **once** on each end. **Holds.**
- **A plaintext JSON-RPC frame injected after the handshake:** refused with
  "no t1: tag", the channel closes, nothing is delivered, and there is no
  plaintext fallback. **Holds.**
- **Size before allocation:** `decodeFrame` checks
  `text.length > 87 383` before any decode (`noise-frame.ts:105`), and the
  reassembler checks the cap before it pushes (`:146`). The raw text itself was
  already allocated by the socket layer: the ws-server's 8 MiB limit, task 9.
  **Holds.**
- **Strict base64:** wrong length, padding in the middle, a non-ASCII
  character, non-zero pad bits and `====` are all refused (`:66-97`).
  **Holds.**
- **A frame during `authorize`, after a deny, after a failure, or after
  close:** each is a violation, `denied`, or ignored. None reaches a handler
  (`noise-channel.ts:292-303,453-457`). **Holds.**
- **Late `authorize` after close (the bug the executor fixed):** the phase is
  one closure variable in `handshake()`. Both verdict paths check
  `phase() !== "authorizing"` (`:420,439`), and M16 kills dropping that guard.
  **Holds.**
- **Delivery after a local close:** **Finding 1.**
- **BOM / lone surrogate transparency:** the BOM is **Finding 2**. A lone
  surrogate becomes U+FFFD, which the Design documents as unreachable
  (well-formed `JSON.stringify` escapes it).

### Seams and §7

- **Production wiring:** none. `git status` shows only
  `{transport,client}/package.json` and `bun.lock` changed among tracked files,
  and nothing outside the new files imports `transport/noise` or
  `secure-channel` (rg). `serve`, `connect` and `ws-server` are untouched, so
  Q1 (a) and Q3 (a) hold.
- **Don't serialize the peer:** `send` and `receive` are synchronous, and the
  async part ends before the resolve. The concurrent prompt + enqueue test runs
  over the real `RemoteClient` ↔ `Connection`.
- **Supply chain:** exactly `@noble/{ciphers,curves,hashes}@2.4.0`, pinned
  exactly. There is one `@noble/hashes` in `bun.lock` (curves depends on exactly
  2.4.0), and the lock diff adds 9 lines. The packages are MIT, with no
  `preinstall`, `install`, `postinstall` or `prepare` scripts (each
  `package.json` read). The audit note in Execution is honest: the 2.x lines of
  ciphers and hashes are past their last third-party audit. That is an
  owner-accepted risk to record in `TODO.md`.

### Premise table

| Cited premise | Verdict |
|---|---|
| Context symptom: no `@noble` before the change | TRUE: the `bun.lock` diff only adds the noble entries |
| `transport/src/channel.ts:9-18`, contract; `:40-54`, pair drops after close | TRUE |
| `peer.ts:131-132` handlers, `:273` synchronous `send` | TRUE |
| `remote-client.ts:1150-1170` dial deadline + late close; `:1240-1256` a fresh channel per generation | TRUE |
| `link-machine.ts:25` `LIVENESS_MS = 15 000`; `:85-91` `unauthorized`/`gone` terminal | TRUE |
| `ws-server.ts` line citations (`:54,116-121,184-198,224,230`) | not re-opened: no change touches that file |

### Mutation non-vacuity

Sources were backed up with `cp`. After the run every file's sha256 matched
the original, and the prefixes equal the ones in Execution: `66251253…`,
`b5aa32af…`, `810378e2…`, `87865ef4…`.

| # | Mutant | Result |
|---|---|---|
| R1 (= M2) | swap the initiator's `Split` | killed: both vectors |
| R2 (own) | drop the nonce high word (`setUint32(8, …)`) | killed by **1** test (see Finding 3 for its weakness) |
| R3 (= M8) | responder `open()` right after sending message 2 | killed: 15 tests |
| R4 (= M10) | silently drop on a decrypt or frame failure | killed: 9 tests ("duplicate" then delivered `second`, a real silent-drop bug) |
| R5 (own) | initiator treats any non-deny status as allow (`\|\|` → `&&`) | killed: the status tests |

### Step 0c Hermes: BLOCKED (owner item, not passed)

- Simulators do exist: `xcrun simctl list devices available` lists iOS 26.5
  devices, all *Shutdown*. The main checkout has `apps/mobile/node_modules`
  and `ios/Pods`, but **no built `.app`**. `ios/Pods/hermes-engine` ships
  `hermesc` but no Hermes VM binary.
- Throwaway project at `.tentacle/tmp/e2e-channel/review/hermes/` (probe:
  X25519, ChaChaPoly 1 MiB, `TextDecoder`, then the real `noiseInitiator` and
  `noiseResponder` with a 1 MiB frame, timings logged).
- Blocked: in this session these commands needed an approval that could not be
  given: `ln -s` (node_modules link), `expo export --platform ios <dir>`, and
  the fallback `bun build` (to feed `hermesc` a compile-only check). After two
  strikes I stopped. **Nothing ran on Hermes or hermesc.**
- Owner, to unblock: in an interactive session, run
  `expo export --platform ios` on that dir (bundling plus a Hermes bytecode
  compile), then build a dev client or Release `.app` (`expo run:ios`, a
  multi-minute Xcode build) and read the `E2E-PROBE` lines from
  `xcrun simctl spawn booted log stream`. Also check `TextDecoder` with
  `fatal`/`ignoreBOM` while there (Finding 2).

### What holds

- The Noise IK implementation matches the spec and both independent vector
  sets byte for byte.
- Every violation closes loudly, on both ends, with no plaintext fallback.
- Nothing reaches `RpcPeer` before the confirm, and a replay never resolves.
- The seam is a pure decorator, with no production wiring.
- The dependencies are minimal and pinned.

### How the executing model behaved

**Grade: A.**

What went well:
- Every step was red first, with the red output recorded.
- The executor found and fixed a real race (`authorize` after close) on its
  own, and pinned it with a mutant.
- Weak tests were strengthened when M7 survived on a side effect.
- Honest drift notes: the vector format, model-copied vectors, and the
  equivalent mutant M17 (now proven).
- An honest audit-status note.
- No scope creep.

Deductions:
- 0c was recorded as "no simulator booted". A *shutdown* simulator was
  available, so the blocker was really the build or the permissions, not the
  hardware.
- Findings 1 and 2 (delivery after a local close, BOM) were missed. Both are
  small.

## Execution — fix round 1

*— claude-opus-5-5, 2026-11-02*

Review findings 1–4 fixed, each red first. Finding 5 (task 9 info) and the
Hermes check (0c) are untouched, as instructed.

| # | Fix | Test (`noise-channel.test.ts`) | Red on the old code |
|---|---|---|---|
| 1 | `Secured.close()` empties the pre-handler queue (`noise-channel.ts:157-158`). The close itself is still delivered once, via `rawClosed`, as with `createChannelPair`. A *remote* close still flushes the queued frames first: the "frames, then close" test stays green. | `:802` "a local close stops delivery…": 3 queued frames, the handler closes on the first | got `["a","b","c","close"]`, expected `["a","close"]` |
| 2 | `new TextDecoder("utf-8", { ignoreBOM: true })` (`noise-frame.ts:28`). `fatal: true` is not added, because it waits on the Hermes check (0c). | `:824` "a leading U+FEFF survives the channel": `"﻿abc"` and a lone `"﻿"` | got `["abc",""]` |
| 3 | Test only. It now compares `CipherState(k, 0x0102·2^32 + 0x05060708)` against `chacha20poly1305` with a nonce built by hand, `00000000 08070605 02010000`. The two high-word bytes differ, so a big-endian or misplaced high word cannot pass. | `:861` | green on correct code, as expected; its red is the mutant below |
| 4 | `readConfirm` maps a decrypt failure to `handshake-failed` "handshake confirmation failed to decrypt" (`noise-channel.ts:174-180`), like a handshake message that fails to decrypt (`noise.ts:190`). A frame that does not decode stays `bad-frame`, which is accurate. No wire or protocol change: `NoiseErrorKind` already has the kind. | `:401` forged confirm: now asserts the rejection kind and `onViolation` are `handshake-failed` | got `bad-frame` |

**Mutations** (sources backed up with `cp` to `.tentacle/tmp/e2e-channel/fix1/`;
all four were applied at once, each touching a separate property):

| Mutant | Killed by |
|---|---|
| drop the queue clear in `close()` | `:802` only |
| `ignoreBOM: false` | `:824` only |
| high nonce word big-endian (`setUint32(8, …, false)`, `noise.ts:124`). The old `≠ nonce 5` assertion would have passed it. | `:861` only |
| drop the `try/catch` in `readConfirm` | `:401` only |

40 pass and 4 fail under the mutants. After restoring, the sha256 of each
file matched its value before the mutation: `noise-channel.ts 1071537f…`,
`noise-frame.ts 82540f55…`, `noise.ts 66251253…` (the last is unchanged from
the review).

**Gate:**
- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: 590 files, no fixes.
- `bun test packages`: **3954 pass, 3 skip, 0 fail**, 3957 tests in 273 files.
  That is 2 new tests over the review's 3952; the opt-in skips are unchanged.

No drift from the Review's suggested fixes.

## Review — fix round 1

*— claude-opus-5-5, 2026-11-02*

**Verdict: REQUEST-CHANGES (FIX).** Fixes 2, 3 and 4 are truthful and complete.
Fix 1 is incomplete: one path still delivers frames after the upper layer's
own `close()`. It is small and low severity (the frames are authenticated),
but it is the exact property finding 1 asked for.

The reviewer is the same model as the executor; only the context is fresh.
Hermes (0c) was not attempted: it is an owner item.

### Findings

1. **Low: a local `close()` after a remote close (or a violation) does not stop
   delivery.** `packages/transport/src/noise-channel.ts:153`.
   - Cause: `rawClosed()` (`:200`) and `violate()` (`:245`) set
     `this.closed = true`. A later `close()` from the upper layer then returns
     at `if (this.closed) return;`, before the queue clear at `:157-158`.
   - Repro (scratch `.tentacle/tmp/e2e-channel/review-fix1/residual.test.ts`,
     case A): queue `a`, `b`, `c`; the peer closes; then set handlers, and the
     handler calls `d.close()` on the first frame. Got
     `["a","b","c","close"]`, expected `["a","close"]`.
   - The new test at `noise-channel.test.ts:802` does not cover this, because
     the remote end is still open there.
   - Fix: clear the queue on every `close()` call, even when the channel is
     already closed. For example, clear it before the early return, or keep a
     separate `localClosed` flag that `flush()` checks. The "frames, then
     close" test (`:783`) must stay green. Add case A as the regression test,
     red first.

No other findings.

### Each fix checked against the code

| # | Claim | Verdict |
|---|---|---|
| 1 | Nothing is delivered after a local `close()` | **Partly.** It holds when the channel is still open: the queue is cleared at `:157-158`. Frames in flight on the raw pair are dropped by `receive()`'s `closed` guard (`:187`): scratch case C got `["close"]`. A frame mid-decrypt cannot be cut, because `receive` is synchronous and its single `deliver` checks nothing after `closed`. It does **not** hold after a remote close or a violation (finding 1). |
| 2 | BOM byte-transparent | **TRUE.** There is one shared decoder (`noise-frame.ts:28`), used by both directions; `TextEncoder` never strips. The test covers initiator → responder only. Scratch case B (responder → initiator, `"﻿x"`, `"﻿﻿"`) arrived intact. The reassembler decodes the whole message (`:161`), so a chunk boundary cannot create a "leading" BOM. The test file holds a real U+FEFF (rg `\x{FEFF}` matches `:826-829`). |
| 3 | The nonce test proves little-endian | **TRUE.** High word `0x0102`, low word `0x05060708`, all bytes distinct, and the nonce is built by hand (`00000000 08070605 02010000`). A big-endian high word, a big-endian low word, a misplaced offset or a truncated high word all change bytes 4–11. |
| 4 | The reason is accurate, and the wire is unchanged | **TRUE.** A decrypt failure is `handshake-failed` (`:179`); an undecodable frame stays `bad-frame` (`:174`). This is responder-only: the throw at `:458` reaches `fail`, and no kind-dependent byte is sent. `NoiseErrorKind` is unchanged (`noise.ts:24`). On the client, both kinds map to `rejected` (`secure-channel.ts:28-29`), and the confirm is never read there. |

### Mutations (own variants, applied together, one per fix)

The sources were backed up with `cp` to `.tentacle/tmp/e2e-channel/review-fix1/`.

| Mutant | Result |
|---|---|
| drop `this.queue.length = 0` in `close()` | killed by `:802` only |
| `new TextDecoder("utf-8")` (no options) | killed by `:824` only |
| high nonce word truncated to its low byte (`& 0xff`, `noise.ts:124`). The old `≠ nonce 5` assertion would have passed it. | killed by `:861` only |
| confirm decrypt failure reports `bad-frame` (`:179`) | killed by `:401` only |

There were 40 pass and 4 fail under the mutants. After the restore, the sha256
of each file is identical to its value before the mutation, and these values
equal Execution's: `noise-channel.ts 1071537f…`, `noise-frame.ts 82540f55…`,
`noise.ts 66251253…`.

### Gate (re-run)

- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: 590 files, no fixes.
- `bun test packages`: **3954 pass, 3 skip, 0 fail**, 3957 tests in 273
  files. This matches Execution, and there is no regression.

### Attacks tried

- Remote close, then a local close inside the handler: **found finding 1**.
- A local close with frames in flight on the raw pair: holds (case C).
- BOM in the reverse direction, and a double BOM: holds (case B).
- Each mutant can only be killed by its own test, with no collateral: holds.

### How the executing model behaved

**Grade: A−.**

What went well:
- Every fix was red first, with the red recorded.
- The fixes were minimal. Execution's hashes are true.
- The rewritten nonce test is genuinely discriminating.
- The `bad-frame` vs `handshake-failed` split is careful.
- `fatal: true` was rightly deferred to 0c.

Deductions:
- Fix 1 was tested only on the path the Review named (an open remote end). The
  sibling state that sets the same `closed` flag (`rawClosed`, `violate`) was
  not checked, so the claim "nothing more is delivered" (`:156`) overstates
  what was proven.

## Execution — fix round 2

*— claude-sonnet-5-5, 2026-11-02*

**Fix (finding 1).** `noise-channel.ts` `close()` (`:152-160`): the queue clear
(`queue.length = 0`, `queuedUnits = 0`) now runs BEFORE the `if (this.closed) return;`
guard, so a local `close()` stops queued delivery even when the peer
(`rawClosed`) or a violation closed first. Wire unchanged.

**Test (red first).** `noise-channel.test.ts`, "delivery before handlers":
"a local close inside the handler stops queued frames even when the peer closed
first" (queue `a,b,c`, peer closes, handler closes on the first frame).
- RED on the old code: got `["a","b","c","close"]`, expected `["a","close"]`.
  (A first draft that closed the peer before the frames were delivered gave
  `["close"]`; I added a `ticks()` between the sends and the peer close, as in
  the reviewer's repro.)
- GREEN after the fix; the "frames, then close" test stays green.

**Mutation.** Backup via `cp` (`.tentacle/tmp/e2e-channel/noise-channel.r2.bak`),
sha `6f37a4b4…`. Mutant: guard moved back before the clear → the new test fails
(`a,b,c,close`), the other 44 pass. Restored; sha identical (`6f37a4b4…`).

**Gate.** `bunx tsc --noEmit` clean · `bunx biome check .` 590 files, no fixes ·
`bun test packages` **3955 pass, 3 skip, 0 fail** (baseline 3954 + 1 new test).

No drift.

## Review — fix round 2

*— claude-opus-5-5, 2026-11-02* (the fix-round-1 reviewer, resumed: this is
not a fresh context, but it is a different model from the round-2 executor,
claude-sonnet-5-5)

**Verdict: APPROVE (READY-TO-MERGE).** Finding 1 of fix round 1 is closed. No
new findings. Hermes (0c) is still an owner item; it is not a merge gate
(Review, above).

### The fix against the code

`close()` (`noise-channel.ts:152-161`) now clears the queue and `queuedUnits`
*before* the `closed` guard. Every way frames can reach the handler after a
local `close()` is now closed off:

- **Queued frames.** A local close empties the queue, so `flush()`'s loop
  (`:233`) stops. This holds whether `closed` was set first by `close()`,
  `rawClosed()` (`:201`) or `violate()` (`:246`).
- **Frames in flight on the raw link.** `receive()` returns on `closed`
  (`:188`).
- **A frame mid-decrypt.** `receive` is synchronous, so a decrypt cannot be
  interrupted.
- **A queue refilled after the close.** `deliver` is only reached from
  `receive`, which `closed` already blocks.

The close itself is still delivered once: `closePending` and
`closeDelivered` (`:238`) are untouched. The "frames, then close" test
(`:783`) stays green.

**Wire unchanged.** Among tracked files, `git diff --stat` still shows only
`bun.lock` and the two `package.json` files. `send`, `emit`, the framing and
`noise.ts` were not touched: the sha256 of `noise.ts` is still `66251253…` and
that of `noise-frame.ts` is still `82540f55…`.

### Repro (scratch `.tentacle/tmp/e2e-channel/review-fix1/residual.test.ts`)

5 pass, 0 fail.

| Case | Order of events | Result |
|---|---|---|
| A (round-1 repro) | Frames queued, then the peer closes, then the handler closes on the first frame | `["a","close"]` (was `["a","b","c","close"]`) |
| D | Frames queued, then a local close, then the peer closes | `["close"]` |
| E | A frame in flight, then the peer closes, then a local close | `["close"]` |
| C | Frames in flight, then a local close | `["close"]` |
| B | BOM, responder → initiator | intact |

### Mutation

The source was backed up with `cp`. The mutant is my own variant: the clear of
`queuedUnits` stays before the guard, and only `queue.length = 0` moves back
after it.

- Result: killed, only by the new test ("…even when the peer closed first"),
  which got `["a","b","c","close"]`. The other 44 tests passed.
- After the restore, the sha256 is identical: `97418971…`.
- The executor's `6f37a4b4…` is the **SHA-1** of the same file (`shasum`'s
  default). I checked it: it is consistent, but Execution does not name the
  algorithm. Their backup `noise-channel.r2.bak` is byte-identical to the
  current file.

### Gate (re-run)

- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: 590 files, no fixes.
- `bun test packages`: **3955 pass, 3 skip, 0 fail**, 3958 tests in 273
  files. This matches Execution.

### How the executing model behaved

**Grade: A.**

What went well:
- The fix is minimal and right at the root cause.
- It was red first, with the red recorded. The executor honestly reported its
  own first test draft, which was not reproducing the bug, and corrected it.
- The mutation is sound, and there is no scope creep.

Deduction (minor):
- The hash is reported without its algorithm. It was SHA-1, while earlier
  rounds used sha256, which briefly looked like a mismatch.

### Step 0c Hermes: PASSED (run interactively, 2026-11-02)

Probe `.tentacle/tmp/e2e-channel/review/hermes/` (the worktree's real `noise.ts` /
`noise-frame.ts`). `expo export --platform ios` compiled to Hermes bytecode (`.hbc`,
1.8 MB). Release build (`expo run:ios --configuration Release`) on the iOS 26.5
simulator logged:

```
E2E-PROBE engine hermes=true bigint=function
E2E-PROBE x25519 agree=true ms=113.7
E2E-PROBE chachapoly 1MiB roundtrip ok=true ms=629.7
E2E-PROBE TextDecoder ok=true
E2E-PROBE noise handshake ms=99.0
E2E-PROBE noise 1MiB frame ok=true ms=797.3
E2E-PROBE DONE
```

Everything works on Hermes. A 1 MiB frame blocks the JS thread for ~0.8 s on the
simulator: acceptable now. Throughput stays a task 11 item (chunking or a native
cipher); measure on the iPhone 12 Pro there.

*— claude-opus-5-5, 2026-11-02*
