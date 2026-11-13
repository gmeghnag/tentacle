# feat/device-pairing — `tentacle pair`, per-computer device registry, `devices` / `revoke` (mobile task 9)

> **Status:** implementation (plan written, **not approved**; 9a, 9b and 9c built, 9d outstanding)
> **Branch:** umbrella `feat/device-pairing` (this doc). Each sub-task runs on its own branch + doc, carved from its section below (the `attachments` precedent): `feat/device-registry` (9a), `feat/device-route` (9b), `feat/device-pair-exchange` (9c), `feat/device-cli` (9d).
> **Size:** L as a whole → split: 9a M · 9b M · 9c M · 9d M · **Blast:** 9a cross-module · 9b **load-bearing** · 9c **load-bearing** · 9d cross-module · **Suited:** 9b/9c a strong executor + mandatory fresh-context Review that red-teams the "pod not trusted" and "single session path" invariants; 9a/9d any executor + fresh-context Review (security-relevant files).
> **Changelog:** one fragment per sub-task, written on that sub-task's branch (texts drafted under *Changelog fragments*): `changelog.d/device-registry.added.md`, `changelog.d/device-route.added.md`, `changelog.d/device-pair-exchange.added.md`, `changelog.d/device-cli.added.md`.

## Context

*— claude-opus-5-5, 2026-11-13*

Mobile task 9 (`docs/eval/mobile-app.md` decision 21, row 9: L · load-bearing).
It turns the merged Noise channel (task 8, `docs/feat/e2e-channel.md`, which
deliberately wired nothing in production — owner Q1 = (a)) into a working
authentication path for the phone. The owner decisions it serves:

- **Decision 2:** the link addresses, it never authorises. Access is a
  per-device key created at pairing and revocable on the daemon; E2E on every
  path.
- **Decision 3:** `tentacle pair` prints a QR (+ a pasteable text) carrying the
  daemon's id and public key, the known addresses and a one-time pairing code
  (5 min, single use); never the master token. The app generates its own device
  key (Keychain, this-device-only) and sends it with a device name. **The daemon
  host confirms:** "Add 'iPhone di Gabriel'? [y/N]". `tentacle devices` lists
  devices (+ last seen); `tentacle devices revoke <name>` removes the key and
  closes that device's live connections at once. One app, many computers.
- **Decision 7:** the identity and the device keys live in a registry shared by
  every daemon of the computer (the config dir): one `pair` authorises the phone
  on every daemon of that computer, present and future; `revoke` revokes on all.
- **Post-eval note (task 0):** `serve` rejects any `Origin`
  (`daemon/src/ws-server.ts:116-121`) and iOS's WebSocket always sends one. The
  policy is decided here; recommendation recorded then: a device-key connection
  is exempt, since a web page cannot hold that key.
- **Mockups (2026-11-01):** the pairing screen shows the QR **and a compare
  code** on both ends.
- **Task 8 hand-offs** (`e2e-channel.md:473-477`, Review finding 5 `:840-848`):
  the ws-server route and Origin policy, the `Connection` built on the resolved
  channel, key storage, an audit line from `onViolation`, a handshake rate
  limit, a lower responder cap for unknown keys, and "last seen" recorded on the
  **resolve**, never inside `authorize` (a replayed message 1 reaches
  `authorize`).

**What is missing today (evidence):**

- `tentacle pair` / `tentacle devices` do not exist: `cliMode`
  (`cli/src/flags.ts:695-720`) treats an unknown first word as a one-shot
  **prompt**, so `tentacle pair` today would send the word "pair" to the model.
- The only listener is `startWsServer` (`daemon/src/ws-server.ts:177`, called
  once from `cli/src/serve.ts:358`). Its `authorize` (`:184-198`) knows a bearer
  token and the Origin rule only; nothing resolves a device key.
- `daemon/session_ttl` documents the gap: "one token = one principal,
  per-device auth is a later task" (`protocol/src/daemon.ts:1-13`).

**Repro** (2026-11-13, `bun .tentacle/tmp/device-pairing/route.ts`, run from the
worktree; Bun 1.4.3). It proves today's refusal **and** the load-bearing seam
(see Implementation). A loopback `Bun.serve` with two routes: `/` = today's rule
(`originAllowed` from `@tentacle/daemon`), `/e2e/1` = the real
`noiseResponder` over a raw socket adapter, building an **unchanged**
`Connection` on the resolved `SecureChannel`; the client is the real
`secureChannelFactory` over a Bun `WebSocket` that sends
`Origin: http://192.168.1.8:4001` as iOS does.

```
server: plain route, Origin=http://192.168.1.8:4001 -> 401
client: plain route + Origin: closed 1002
server: authorize 3cdd5629 -> true
server: Connection built for 3cdd5629
client: initialize over e2e with Origin sent -> protocolVersion=24
client: after revoke, request -> connection closed
server: authorize 3cdd5629 -> false
client: redial after revoke -> ChannelError kind=unauthorized
server: responder rejected: denied
server: authorize a3d74e56 -> false
client: unknown key -> ChannelError kind=unauthorized
server: responder rejected: denied
```

<details><summary>route.ts (the scratch file is gitignored; pasted in full)</summary>

```ts
const W = "/Users/gmeghnag/tentacle/.tentacle/worktrees/device-pairing/packages";
const { Agent } = await import(`${W}/agent/src/index.ts`);
const { secureChannelFactory } = await import(`${W}/client/src/secure-channel.ts`);
const { PermissionBroker } = await import(`${W}/core/src/index.ts`);
const { Connection, SessionHost, originAllowed } = await import(`${W}/daemon/src/index.ts`);
const { Method, PROTOCOL_VERSION } = await import(`${W}/protocol/src/index.ts`);
const { ToolRegistry } = await import(`${W}/tools/src/index.ts`);
const { RpcPeer } = await import(`${W}/transport/src/index.ts`);
const { generateStaticKeypair, noiseResponder, systemRandom } = await import(
  `${W}/transport/src/noise-channel.ts`
);
type DuplexChannel = {
  send(d: string): void;
  close(): void;
  setOnMessage(h: (d: string) => void): void;
  setOnClose(h: () => void): void;
};
const hex = (k: Uint8Array) => Buffer.from(k).toString("hex");
const daemon = generateStaticKeypair(systemRandom);
const phone = generateStaticKeypair(systemRandom);
const stranger = generateStaticKeypair(systemRandom);
const registry = new Set([hex(phone.publicKey)]);
const host = new SessionHost({
  defaultCwd: "/nonexistent",
  createAgent: () => ({
    agent: new Agent({ model: { id: "x", async *stream() {} } as never, tools: new ToolRegistry(), env: {} as never }),
    permissions: new PermissionBroker(),
  }),
});
class Raw implements DuplexChannel {
  m?: (d: string) => void; c?: () => void; closed = false;
  constructor(readonly ws: { send(d: string): number; close(): void }) {}
  send(d: string) { if (!this.closed) this.ws.send(d); }
  close() { if (!this.closed) this.ws.close(); }
  setOnMessage(h: (d: string) => void) { this.m = h; }
  setOnClose(h: () => void) { this.c = h; }
  fire() { if (!this.closed) { this.closed = true; this.c?.(); } }
}
const live = new Map<string, { close(): void }>();
const server = Bun.serve<{ raw: Raw | null }>({
  hostname: "127.0.0.1", port: 0,
  fetch(req, srv) {
    const path = new URL(req.url).pathname;
    const origin = req.headers.get("origin");
    if (path === "/e2e/1") return srv.upgrade(req, { data: { raw: null } }) ? undefined : new Response("x", { status: 426 });
    if (!originAllowed(origin)) { console.log(`server: plain route, Origin=${origin} -> 401`); return new Response("unauthorized", { status: 401 }); }
    return srv.upgrade(req, { data: { raw: null } }) ? undefined : new Response("x", { status: 426 });
  },
  websocket: {
    open(ws) {
      const raw = new Raw(ws); ws.data.raw = raw;
      noiseResponder(raw, { staticKey: daemon.privateKey, random: systemRandom,
        authorize: (k) => { const ok = registry.has(hex(k)); console.log(`server: authorize ${hex(k).slice(0, 8)} -> ${ok}`); return ok; },
      }).then(
        (sec) => { new Connection(sec, host); live.set(hex(sec.remoteStatic), ws); console.log(`server: Connection built for ${hex(sec.remoteStatic).slice(0, 8)}`); },
        (e) => console.log(`server: responder rejected: ${e.kind}`),
      );
    },
    message(ws, msg) { ws.data.raw?.m?.(String(msg)); },
    close(ws) { ws.data.raw?.fire(); },
  },
});
const url = `ws://127.0.0.1:${server.port}`;
const dial = (path: string) => () => new Promise<DuplexChannel>((res, rej) => {
  const ws = new WebSocket(url + path, { headers: { Origin: "http://192.168.1.8:4001" } } as never);
  let m: ((d: string) => void) | undefined; let c: (() => void) | undefined;
  ws.addEventListener("message", (e) => m?.(String(e.data)));
  ws.addEventListener("close", (e) => { c?.(); rej(new Error(`closed ${e.code}`)); });
  ws.addEventListener("open", () => res({ send: (d) => ws.send(d), close: () => ws.close(),
    setOnMessage: (h) => { m = h; }, setOnClose: (h) => { c = h; } }));
});
try { await dial("/")(); } catch (e) { console.log(`client: plain route + Origin: ${(e as Error).message}`); }
const f = secureChannelFactory(dial("/e2e/1"), { staticKey: phone.privateKey, remoteStatic: daemon.publicKey, random: systemRandom });
const ch = await f();
const peer = new RpcPeer(ch, { onRequest: async () => null, onNotification: () => {} });
const init = (await peer.request(Method.Initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
  clientInfo: { name: "repro", version: "0" } })) as { protocolVersion: number };
console.log(`client: initialize over e2e with Origin sent -> protocolVersion=${init.protocolVersion}`);
registry.delete(hex(phone.publicKey)); live.get(hex(phone.publicKey))?.close();   // "revoke"
try { await peer.request("session/list", {}); console.log("client: after revoke request succeeded (BAD)"); }
catch (e) { console.log(`client: after revoke, request -> ${(e as Error).message}`); }
try { await f(); console.log("client: redial after revoke OK (BAD)"); }
catch (e) { console.log(`client: redial after revoke -> ChannelError kind=${(e as { kind?: string }).kind}`); }
try { await secureChannelFactory(dial("/e2e/1"), { staticKey: stranger.privateKey, remoteStatic: daemon.publicKey, random: systemRandom })(); }
catch (e) { console.log(`client: unknown key -> ChannelError kind=${(e as { kind?: string }).kind}`); }
server.stop(true);
```

</details>

## Implementation

*— claude-opus-5-5, 2026-11-13*

### Load-bearing assumption

**Device authentication is a property of the SOCKET, decided once by the Noise
responder's `authorize(remoteStatic)` before any RPC frame exists — so a new
upgrade route + an unchanged `Connection` built on the resolved
`SecureChannel` gives a device-bound connection, revoke = closing that socket,
and nothing in `RpcPeer` / `Connection` / `RemoteClient` / `SessionHost`
learns a second session path.** Corollary: the Origin exemption is safe on that
route, because no frame reaches `Connection` from a peer that does not hold a
key `authorize` accepted.

**Proven** by the Repro above (all real modules, real sockets):

- a client sending an iOS-style `Origin` gets 401 on today's route
  (`ws-server.ts:116-121,194`) and a working `initialize` on the device route —
  `Connection` constructed after the resolve, unchanged (`connection.ts:117-136`);
- `authorize` sees the device's static key and decides
  (`transport/src/noise-channel.ts:416-441`);
- closing that device's socket from the server drops the client's in-flight
  request ("connection closed"), and the re-dial is **denied** →
  `ChannelError kind=unauthorized`, which is terminal for the client
  (`client/src/secure-channel.ts:24-30`, `link-machine.ts:85-91`);
- an unknown key is denied the same way.

Seams it relies on: the responder sets its raw handlers synchronously inside
`handshake()` (`noise-channel.ts:302-332`), so calling it from Bun's `open`
(`ws-server.ts:218`) loses no early frame; frames after the confirm are queued
until `RpcPeer` sets its handlers (`e2e-channel.md` Design "Delivery before
handlers"); `Connection` needs a channel only at construction
(`connection.ts:117-136`); the ws `close` handler already calls
`Connection.close()` → detach, never end (`ws-server.ts:232-236`,
`connection.ts:147-153`).

### Preconditions

- **P1 — the responder cap is fixed before `authorize`.** `maxMessageBytes` is
  read at `noise-channel.ts:403`, before the key is known (`:416`); a pairing
  connection from an unknown key would get the full 32 MiB reassembly. 9b adds a
  per-verdict cap (small, additive change to `noise-channel.ts:428-441`).
- **P2 — `authorize` may be async and runs on every message 1, replays
  included** (`noise-channel.ts:418-428`; `e2e-channel.md:840-845`). So
  `authorize` stays cheap and side-effect free; "seen" and success audits go on
  the resolve.
- **P3 — only `serve` has a WebSocket listener.** `startWsServer` has one
  production caller (`cli/src/serve.ts:358`, inside `listen`, reached only from
  `startDaemon` `:153-200`); pod daemons run over stdio
  (`serve.ts:628`, `startStdioDaemon`) or the resident socket; the worker is
  in-process. So the device route exists only on the user's own host (§7 "pod
  not trusted": device keys stay off pods).
- **P4 — a pod never sees the config dir.** `workspace-mount.ts:709` always
  hides `configDir` from a mounted workspace ("tentacle's config"), so
  `<configDir>/devices/` (identity private key, registry) cannot be read from
  inside a pod. The executor of 9a re-verifies this line before writing the
  store.
- **P5 — today's bind rule.** A non-loopback bind without a token throws
  (`ws-server.ts:178-182`); the token is resolved in `main.ts:871-873`.
- **P6 — peer dispatch is concurrent** (`transport/src/peer.ts`, §7): a
  `device/pair` request held open for minutes blocks nothing else.
- **P7 — protocol extension points.** Error codes end at `AttachmentRefused:
  -32016` (`protocol/src/jsonrpc.ts:29-58`); methods live in `Method` +
  `RequestSchemas` (`protocol/src/methods.ts:70+`; the peer validates outbound
  params against them, `peer.ts:150-156`); `PROTOCOL_VERSION = 24`
  (`protocol/src/version.ts`).
- **P8 — existing helpers to reuse:** `acquireStoreLock`'s exclusive-create
  pattern (`daemon/src/session-persister.ts:642-690`, `processAlive` `:626-633`)
  for the registry write lock and stale-pid detection; `untrustedText`
  (`cli/src/untrusted-text.ts:12`) for every peer-supplied string printed on
  the terminal; `generateStaticKeypair` / `systemRandom` / `publicKeyOf`
  (`noise-channel.ts:23,44,99`).
- **P9 — `HOME` is a temp dir under `bun test`** (`scripts/test-env-guard.ts`,
  AGENTS §6), so a default config dir in a test never touches the real one.

### Design

**On-disk layout — `<configDir>/devices/`** (dir 0700, files 0600; one truth
shared by every daemon of the computer, decision 7):

| File | Writer | Readers | Content |
|---|---|---|---|
| `identity.json` | first of `serve` / `pair` (exclusive create), `devices reset` | every `serve`, `pair` | `{ v: 1, publicKey, privateKey, name, createdAt }` — the computer's X25519 static key (b64url) and display name (default `os.hostname()`) |
| `registry.json` | **only the CLI** (`pair` accept, `revoke`, `reset`) under `registry.lock` | every `serve` (poll), `devices` | `{ v: 1, devices: [{ id, name, publicKey, pairedAt }] }` |
| `seen/<id>` | any `serve` (touch) | `devices` | empty; **mtime = last seen** (no read-modify-write between daemons) |
| `pairing/<sid>.json` | `pair` | `serve` | `{ v: 1, sid, codeHash, expiresAt, pid }` |
| `pairing/<sid>.claim.json` | `serve`, **exclusive create** (`wx`) | `pair` | `{ publicKey, name, sas, at }` — single use across all daemons |
| `pairing/<sid>.decision.json` | `pair` | `serve` | `{ accepted: boolean }` |
| `<configDir>/daemons/<pid>.json` | each `serve` at listen, removed at stop | `pair` (addresses); task 10 (siblings) | `{ v: 1, pid, host, port, tls, cwd, startedAt }` |

Each record carries its own version (`DEVICE_STORE_VERSION = 1`), separate from
the wire (§7 "on-disk records are versioned separately"): an unknown `v`, or an
unreadable file, is **refused and never written** — a daemon then denies every
device (fail closed, one audit line), `pair` / `revoke` stop with the file
named. Writes are tmp + `rename` (atomic); the identity is created with
tmp + `link` (EEXIST → read the winner's), so two daemons starting at once agree
on one key. A device `id` = the first 16 hex of SHA-256(device public key):
re-pairing the same key is idempotent.

**Route (9b).** `startWsServer` gains an optional `devices: DeviceAuthority`.
When set, a request to path **`/e2e`** is the device route:

- **no token, no Origin check** (the post-eval recommendation): the Noise
  handshake is the authentication; a web page cannot hold a registered key,
  and an unregistered key reaches at most a pairing-only connection;
- a per-IP token bucket and a cap on concurrent handshakes, at the upgrade
  (429 before any crypto);
- on `open`, `noiseResponder(raw, { staticKey: identity, authorize, random:
  systemRandom, onViolation → audit })`; on resolve, `new Connection(secure,
  host, onError, { maxFrameBytes, principal })`, registered under the device id
  for revocation, and `seen/<id>` touched; on close, touched again.

Every other path keeps today's `authorize` (`ws-server.ts:184-198`)
unchanged — `connect`, the plain route and its tests are untouched (task 8 Q3
stays: the laptop's `connect` is token/TLS, owner question 5).

**Bind rule.** `startWsServer` refuses a non-loopback bind without a token
**unless `devices` is set**; in that case the plain route answers 401 to
everyone (only paired devices get in). With a token, both routes work as today
(owner question 1).

**`DeviceAuthority` (9b, `daemon/src/device-authority.ts`)** — one per daemon
process, over the 9a store:

- `authorize(key)` → `{ kind: "device", id } | { kind: "pairing" } | deny`.
  Before deciding it **stats** `registry.json` / `identity.json` and reloads on
  any change (no stale-snapshot window after a revoke). A known key → device.
  An unknown key → `pairing` **only if** a fresh read of `pairing/` finds an
  unexpired session whose `pid` is alive; else deny. A fresh read, not the
  poll's snapshot: a deny is terminal for the client, so a phone that scans the
  QR in the first second must not be refused.
- a poll (1 s, injectable timer; `fs.watch` only as an accelerator, never the
  only signal) that, on a registry change, closes every live connection whose id
  is gone — "closes at once" = within one tick — and on an identity change
  (`devices reset`) closes **every** device connection and switches the static
  key for new handshakes;
- the verdict object carries the reassembly cap: device → the responder default
  (32 MiB), pairing → 64 KiB (P1).

**`Connection` (9b/9c, minimal).** `ConnectionOptions.principal?:
{ kind: "token" } | { kind: "device"; id } | { kind: "pairing"; pair:
PairHandler }` (absent = token, today's behaviour). The only behaviour change:
a **pairing** principal may call `initialize` and `device/pair`, anything else
→ `Unauthorized` (-32001); a device / token principal calling `device/pair` →
`PairingRefused{already_paired}`. A paired device has the same rights as a
token client (decision 5: every client is a view of the session; one user, many
devices). Revocation lives in the ws-server's per-device socket map, not in
`Connection`.

**Pairing exchange (9c).** The code goes **inside** the confirmed channel,
never in message 1 (replayable — `e2e-channel.md:434-436`):

1. `pair` (host) ensures the identity, writes `pairing/<sid>.json` (code =
   10 Crockford-base32 chars, 50 bits, from `systemRandom`; only its SHA-256 is
   stored), prints the QR + text, waits.
2. The phone dials an address with a **new** device key → `authorize` returns
   `pairing` → pairing-only `Connection`. The phone computes the compare code
   (SAS) from both public keys and shows it **now**, before sending anything.
3. Phone → `device/pair { code, name }`. The daemon hashes the code, finds the
   session (constant-time compare, unexpired, pid alive), then **creates
   `<sid>.claim.json` exclusively** with the key **taken from the channel's
   `remoteStatic` — never from params** (params have no key field). EEXIST →
   `used`. Five wrong codes on one connection → closed.
4. `pair` sees the claim and asks: `Add 'iPhone di Gabriel'? It must show
   123 456. [y/N]` (name through `untrustedText`).
5. `y` → `pair` writes the registry entry **first** (under the lock), then the
   decision. `N` / timeout / Ctrl+C → decision `declined` (or nothing; expiry).
6. The daemon answers when the decision appears, or when the registry already
   holds the key (a `pair` that exited before the daemon read the decision):
   `{ deviceId, computer: { id, name } }`; else `PairingRefused` with a reason.
   The phone closes and **re-dials as a device** (a connection's privilege is
   fixed at its handshake; never upgraded in place).

**Compare code (SAS).** 6 decimal digits =
`uint32(SHA-256("tentacle-pair-sas/1" ‖ computerPub ‖ devicePub)[0..4]) mod
10^6`, shown on both ends. It defeats the photographed-QR race: an attacker who
pairs first is shown on the terminal with a code the real phone does not show
(the attacker cannot grind a match: the real phone's key is unknown until its
handshake, by which time the single-use code is gone). A name alone is
spoofable — the peer chooses it.

**Pairing payload (QR + paste, 9a codec in `@tentacle/protocol`).**
`tentacle://pair?v=1&k=<b64url computer key>&n=<computer name>&c=<code>&a=<url>[&a=<url>…]`.
`v` is its own version (like `E2E_CHANNEL_VERSION`); unknown params are
ignored, a missing/invalid required one or an unknown `v` is refused. Addresses
are full URLs ending in `/e2e` (a relay URL fits later, task 15).

**Addresses (9d).** `pair` reads `<configDir>/daemons/*.json` (dead pids
ignored, P8), and per record: loopback bind → nothing (a phone cannot reach
it); `0.0.0.0` / `::` → each non-internal IPv4 of `os.networkInterfaces()`
(LAN, Tailscale `100.64/10`); a specific address → itself; `ws`/`wss` from
`tls`; plus every `--address <url>`. None at all → `pair` refuses with the hint
(`tentacle serve --host 0.0.0.0`, or `--address`). Pure, unit-tested.

**CLI (9d).** `tentacle pair [--address URL]… [--name NAME]`;
`tentacle devices` (name · paired · last seen · id prefix);
`tentacle devices revoke <name|id-prefix>`; `tentacle devices reset`
(new identity + empty registry, confirm `[y/N]`, owner question 3). `pair` and
`devices` are plain stdout programs (no Ink). Re-pairing a name that exists
adds a suffixed entry (`iPhone (2)`), never replaces (owner question 4).

**Client helper (9c, `@tentacle/client/pairing`, a crypto subpath like
`secure-channel`).** `pairDevice({ payload, deviceKey, name, dial, random,
onCompare })`: one dial per address in payload order, `secureChannelFactory`,
`RpcPeer`, `initialize`, `onCompare(sas)`, `device/pair`, close. A one-shot RPC,
not a session: it does not touch `RemoteClient` (no second session path). The
app's pairing screen (task 11b) calls it; 9c's tests drive it.

**Protocol and `PROTOCOL_VERSION`.** Additive only → **no bump**:

- new method `device/pair` (`DevicePairParams { code: string(10), name:
  string 1..64 }`, `DevicePairResult { deviceId, computer: { id, name } }`), a
  strip schema per §7 forward-compat;
- new error `PairingRefused: -32017`, `data.reason` ∈ `invalid_code | used |
  declined | timeout | too_many_attempts | already_paired` (an unknown reason
  shows as a generic refusal, forward-compatible);
- `Unauthorized` (existing) on non-pairing methods of a pairing connection —
  reachable only on the new route, which no older peer dials.

An older daemon has no `/e2e` route: the phone's dial lands on the plain route,
the Origin rule refuses it (401 before upgrade) → the app shows "update tentacle
on this computer" after a failed upgrade (task 11 carry-over). No mixed-version
mid-session failure exists, so the bump rule does not apply.

### Sub-tasks, file sets, order, parallel safety

Order: **9a → (9b → 9c) ∥ 9d**; 9d merges **after** 9c (its last test drives a
real daemon). Per the owner's 2-task rule, 9d may run beside 9b or 9c: file sets
below are disjoint (verified: 9b/9c never touch `main.ts`/`flags.ts`; 9d never
touches `serve.ts`, `ws-server.ts`, `connection.ts`, protocol).

**9a `device-registry` — M · cross-module.** The store + codecs, no wiring.

| File | Change |
|---|---|
| `packages/protocol/src/pairing.ts` (new) + `index.ts` export | payload codec `formatPairingPayload` / `parsePairingPayload` (zod), `PAIRING_PAYLOAD_VERSION = 1` |
| `packages/transport/src/pairing-sas.ts` (new), re-exported from `noise-channel.ts` (the `/noise` subpath) | `pairingSas(computerPub, devicePub)` (`@noble/hashes`, already a dep) |
| `packages/daemon/src/device-store.ts` (new) + `index.ts` export | identity load-or-create, registry read/write (lock, atomic, versioned), `touchSeen`, pairing sessions (`openPairing`, `findPairing`, `claim` exclusive, `decision`, sweep of dead/expired), daemon records (`writeDaemonRecord` / `readDaemonRecords`) |
| tests: `protocol/test/pairing-payload.test.ts`, `transport/test/pairing-sas.test.ts`, `daemon/test/device-store.test.ts` | new |

**9b `device-route` — M · load-bearing.** Route, authority, revoke, bind rule.

| File | Change |
|---|---|
| `packages/transport/src/noise-channel.ts` | `authorize` may return `boolean \| { allow: true; maxMessageBytes: number }`; the cap applies to the `Secured` built at `:441` |
| `packages/daemon/src/device-authority.ts` (new) | the authority above (stat-refresh, fresh pairing read, poll, close-on-revoke/reset) |
| `packages/daemon/src/handshake-limit.ts` (new, pure) | per-IP token bucket + concurrent-handshake cap, injectable clock |
| `packages/daemon/src/ws-server.ts` | `devices?` option, `/e2e` route, Origin/token exemption on it only, per-device socket map, audit lines (`device-open <id8>`, `device-denied <fp8>`, `pairing-open`, `device-revoked <id8> closed=<n>`, `e2e-violation <kind>`), bind rule |
| `packages/daemon/src/connection.ts` | `principal` option + the pairing method gate (`device/pair` itself lands in 9c) |
| `packages/cli/src/serve.ts` | `startDaemon`/`listen`: load-or-create identity, build `DeviceAuthority`, pass `devices`; write/remove `daemons/<pid>.json` |
| tests: `transport/test/noise-channel.test.ts` (+cases), `daemon/test/device-authority.test.ts`, `daemon/test/ws-device-route.test.ts` (real loopback, like the Repro), `cli/test/serve-devices.test.ts` | new / extended |

**9c `device-pair-exchange` — M · load-bearing.** The method, both ends.

| File | Change |
|---|---|
| `packages/protocol/src/device.ts` (new), `methods.ts`, `jsonrpc.ts`, `index.ts` | `device/pair` schemas + `Method.DevicePair` + `RequestSchemas` entry; `PairingRefused -32017`; JSON-schema export picks them up (`json-schema.ts:51`) |
| `packages/daemon/src/pairing-handler.ts` (new) | `PairHandler`: code lookup, exclusive claim with the channel key, wait for decision/registry, attempt cap |
| `packages/daemon/src/connection.ts` | dispatch `device/pair` to the principal's handler |
| `packages/daemon/src/ws-server.ts` | pass the handler on the pairing principal; close pairing connections at their session's expiry |
| `packages/client/package.json` (`exports["./pairing"]`), `packages/client/src/pairing.ts` (new) | `pairDevice` + `PairingRefused` mapping |
| tests: `daemon/test/pairing-handler.test.ts`, `daemon/test/ws-device-route.test.ts` (+pairing cases), `client/test/pairing.test.ts`, protocol schema test | new / extended |

**9d `device-cli` — M · cross-module.**

| File | Change |
|---|---|
| `packages/cli/src/flags.ts` | `pair`, `devices` in `cliMode` and the command set (`:528-537,700-713`) |
| `packages/cli/src/pair.ts` (new) | the `pair` program (injected io/clock/random) |
| `packages/cli/src/pair-addresses.ts` (new, pure) | addresses from daemon records + interfaces + `--address` |
| `packages/cli/src/devices-cmd.ts` (new) | `devices`, `revoke`, `reset` |
| `packages/cli/src/main.ts` | dispatch + help text (incl. the new `serve` bind rule) |
| `packages/cli/package.json`, `bun.lock` | a QR encoder, Step 0 below |
| tests: `cli/test/pair.test.ts`, `pair-addresses.test.ts`, `devices-cmd.test.ts`, `flags` dispatch test, `cli/test/pair-e2e.test.ts` | new |

**9d Step 0 (blocking):** pick the QR encoder — `npm view uqr` (MIT, zero deps,
`renderUnicodeCompact`; from memory, unverified) pinned exactly; if it is
unsuitable, vendor Nayuki's `qrcodegen` (MIT) as a pure module with its
licence in `NOTICE`. Record the choice in Execution.

### Failure modes

| # | Case | Behaviour | Convergence |
|---|---|---|---|
| F1 | **QR lost / photographed** | Code: 5 min, single use, only its hash on disk; the claim is exclusive; the host confirms with name + SAS | An attacker who claims first shows a SAS the real phone does not; user answers N; the real phone gets `used` → run `pair` again |
| F2 | `pair` killed (Ctrl+C, crash) | exit handler deletes `pairing/<sid>*`; a crash leaves them, but `findPairing` requires the pid alive and unexpired | window closes at once; `pair` sweeps stale files at start |
| F3 | `pair` exits right after `y`, before the daemon reads the decision | registry is written before the decision; the daemon also accepts when the registry holds the key | phone gets success |
| F4 | **Replay** of Noise message 1 (relay) | `authorize` runs (cheap, no side effects), no confirm → no `Connection`, no `seen`, no audit success (P2) | handshake timeout |
| F5 | Replay / reuse of a pairing code | the claim already exists → `used` | — |
| F6 | Brute force of the code | 50 bits, 5 tries per connection, per-IP bucket, concurrent cap, 5 min | infeasible; logged |
| F7 | **Revoke while connected** | poll tick closes the device's sockets; in-flight requests fail "connection closed"; its sessions are **detached, not ended** (decision 4) | client redials → denied → `unauthorized`, terminal; app says "removed from this computer" |
| F8 | Revoke between two polls, device redials | `authorize` stat-refreshes the registry first | denied |
| F9 | Revoke while a turn it started runs | the turn continues (any device owns it, decision 5); a pending permission waits for another device | — |
| F10 | **Device key rotation** (app reinstalled, Keychain this-device-only) | the old entry stays (shows "last seen" long ago); the new key pairs as `iPhone (2)` | user revokes the stale one |
| F11 | **Computer key rotation** (`devices reset`) | new identity, empty registry; daemons close every device connection and use the new key | phones: wrong pinned key → `closed` → `unreachable` (transient by task 8's design); the app must say "this computer may have been reset — pair again" after repeated failures (task 11 carry-over) |
| F12 | Two daemons start together with no identity | tmp + `link` exclusive: one wins, the other reads it | one identity |
| F13 | Two `pair` accepts / a `revoke` at once | `registry.lock` (exclusive create, stale pid taken over) | serialised; both entries present |
| F14 | Registry/identity unreadable or unknown `v` | daemon denies every device + one audit line; CLI stops naming the file; never overwritten | user fixes or `devices reset` |
| F15 | **Hostile unknown peer, no pairing window** | deny in message 2 (2 DH + `authorize`), rate-limited at upgrade | — |
| F16 | Hostile unknown peer during a window | pairing-only connection: `initialize`, `device/pair` only; 64 KiB cap; 5 wrong codes → closed; closed at window expiry | nothing else reachable (test: `session/list` → `Unauthorized`) |
| F17 | Hostile name (ANSI, bidi, control, 10 KB) | schema caps 64 chars; terminal shows it through `untrustedText`; SAS is the identity check | — |
| F18 | Params smuggle a different key | params have no key; the registered key is the channel's `remoteStatic` | mutation test |
| F19 | A web page (DNS rebinding) dials `/e2e` | no registered key → deny; pairing needs the code + host `y` | — |
| F20 | Plain route with an Origin | unchanged: 401 | regression test |
| F21 | A pod / stdio / worker daemon | no `startWsServer`, no `devices` (P3); config dir hidden from mounts (P4) | test pins `startWsServer` without `devices` treats `/e2e` as the plain route |
| F22 | Socket closes between the confirm and `Connection` registration | the route checks the socket's closed flag after building and closes the `Connection` | no orphan attachment |
| F23 | Phone dials an old daemon | no `/e2e` route → 401 at upgrade | app: "update tentacle on this computer" (task 11) |
| F24 | Clock skew | all expiries use the host clock only | — |
| F25 | `seen/` write fails (disk full) | logged once, connection proceeds | "last seen" stale, not wrong |
| F26 | Non-loopback bind without token, no identity possible (unreadable) | `serve` refuses to start, names the file | no open plain route by accident |

### §7 invariants

- **One session path:** a route (transport) + a principal flag; `pairDevice` is
  a one-shot RPC, not a session.
- **Logic in pure modules:** code/SAS/payload/address/rate-limit are pure;
  `DeviceAuthority` and `PairHandler` are small, fake-fs-driven.
- **Don't serialise the peer:** `device/pair` waits inside its own handler; no
  lock on `Connection`.
- **Pod not trusted / identity with the user:** device keys and the identity
  exist only on the `serve` host (P3, P4).
- **Persistence:** new records versioned separately; unknown → refused, never
  written; one writer per file (CLI for the registry, daemons only for
  `seen/`, claims and their own daemon record).
- **Protocol:** additive, no bump (above). **Never write raw to the terminal:**
  `pair`/`devices` are not Ink programs; `serve` logs through its existing sink.

### Tests (red first; each names its mutation)

**9a.** Identity: two concurrent creators → one key (*mutation:* plain
`writeFile` → two keys); mode 0600; unknown `v` refused and file bytes
unchanged (*mutation:* accept any `v`). Registry: round trip; garbled →
error, file untouched (*mutation:* reset to empty on parse error); lock held by
a live pid → waits/fails, by a dead pid → taken over; name dedup. Pairing:
`claim` twice → second EEXIST (*mutation:* drop `wx`); expired or dead-pid
session not found; code compared by hash. Payload: round trip, unknown param
ignored, bad `v`/key length/non-ws URL refused. SAS: fixed vector; swapping the
keys changes it (*mutation:* hash only one key).

**9b.** Real loopback (Repro pattern): known key + iOS `Origin` → `initialize`
OK (**red today**: 401); plain route + `Origin` still 401. Unknown key, no
window → `unauthorized`; with window → `session/list` → `Unauthorized`
(*mutation:* skip the method gate). Revoke: rewrite `registry.json` → live
socket closed within one fake tick, redial denied (*mutation:* poll does not
close). Revoke before the tick → denied (*mutation:* snapshot-only
`authorize`). Replayed message 1 → `seen/` untouched (*mutation:* touch in
`authorize`). Pairing connection over 64 KiB closes (*mutation:* ignore the
verdict cap). 11th handshake from one IP in 1 s → 429. `devices reset` →
every device socket closed. Unreadable registry → known key denied
(*mutation:* fail open). Bind: non-loopback, no token, `devices` set → starts
and the plain route is 401 without Origin; without `devices` → still throws.
`serve` writes and removes its daemon record. `startWsServer` without
`devices` → `/e2e` is the plain route.

**9c.** Happy path through `pairDevice` with a fake host deciding via the 9a
API → `deviceId`; then a device dial works. Key from the channel
(*mutation:* add `publicKey` to params and use it — the test sends a foreign
key field and asserts the registered key is `remoteStatic`). Second phone,
same code → `used`. `N` → `declined`, registry unchanged. Expiry → `timeout`.
Five wrong codes → `too_many_attempts` + closed. `pair` pid dead →
`invalid_code`. Decision file missing, registry holds key → success.
Device/token principal → `already_paired`. `onCompare` fires before
`device/pair` is sent (*mutation:* call it after). Concurrent `device/pair`
waiting + another connection's `session/list` answered (not serialised).

**9d.** Addresses: `0.0.0.0` → fake interfaces, loopback → none, `tls` →
`wss`, `--address` appended, dedup. `pair` with injected stdin/clock: claim →
prints sanitized name + SAS; `y` → entry; `N` → none; exit removes session
files; no address → exit 1 with hint. Name with `\x1b[2J` printed escaped
(*mutation:* raw print). `devices` table incl. last seen; `revoke` by name and
id prefix, unknown → exit 1; `reset` needs `y`. `cliMode("pair")`,
`("devices")`. **E2E:** real `startDaemon` on loopback + `--address
ws://127.0.0.1:<port>/e2e` + `pairDevice` + in-process `pair` answering `y` →
paired; `revoke` → the phone's live connection closes.

### Changelog fragments (each written on its sub-task's branch)

- `device-registry.added.md` — `- **A per-computer identity and paired-device registry.** \`<configDir>/devices/\` holds this computer's key and the devices allowed to connect, shared by every \`serve\` on it; versioned, never overwritten when unreadable. Design: \`docs/feat/device-pairing.md\`.`
- `device-route.added.md` — `- **\`serve\` accepts paired devices on an end-to-end encrypted route.** \`/e2e\` authenticates by device key (Noise), so a phone needs no token and its \`Origin\` header is accepted there only; a revoked device is disconnected within a second. A non-loopback \`serve\` without \`--token\` now starts and admits paired devices only.`
- `device-pair-exchange.added.md` — `- **Pairing over the encrypted channel.** A new device proves a one-time code inside the channel and is added only after the computer's owner confirms, comparing a 6-digit code shown on both screens (\`device/pair\`, additive).`
- `device-cli.added.md` — `- **\`tentacle pair\`, \`tentacle devices\`, \`devices revoke\`, \`devices reset\`.** Pair a phone by QR (or pasted text) with a confirmation on the computer; list devices with last seen; revoke one everywhere at once; rotate this computer's identity.`

### Owner questions

1. **Bind rule:** `serve --host 0.0.0.0` without `--token` starts and serves
   only paired devices (plain route 401)? **Rec: yes** — the phone path needs no
   shared secret, and today's "token or refuse" stays for the plain route.
2. **Split:** four branches 9a → (9b → 9c) ∥ 9d, 9d merging after 9c?
   **Rec: yes** (L, two load-bearing halves; disjoint file sets allow the
   2-task rule).
3. **`tentacle devices reset`** (new computer identity, every device dropped)
   in v1? **Rec: yes** — the only recovery from a leaked identity key; small.
4. **Same name re-paired:** add `iPhone (2)`, never replace the old entry?
   **Rec: yes** — the name is peer-chosen, so auto-replace would let anyone with
   the code evict a device; stale entries show their last seen.
5. **Laptop `connect` over device keys** (task 8 Q3, "revisit in task 9")?
   **Rec: no, stays token/TLS** — out of the phone's scope; revisit with the
   relay (task 15).
6. **Running-daemon records** `<configDir>/daemons/<pid>.json` introduced
   here (the QR needs addresses; task 10 builds siblings on them)? **Rec: yes.**
7. **Compare code:** 6 digits on terminal and phone, the prompt asks to check
   it? **Rec: yes** — the mockup already has it, and it is what makes the host
   `y` meaningful against a photographed QR.

## Execution

### 9a `device-registry` — DONE

*— claude-opus-5-5, 2026-11-13*

Scope: slice 9a only (the store + codecs, no wiring). 9b/9c/9d untouched.

**Load-bearing check (re-run first, as asked).** `.tentacle/tmp/device-pairing/loadbearing.ts`:

```
1. capability missing: 3/3 (protocol/src/pairing.ts, transport/src/pairing-sas.ts, daemon/src/device-store.ts)
   exports today: parsePairingPayload=undefined loadOrCreateIdentity=undefined
2. P4 workspace-mount.ts:709 -> const always: HidePath = { label: "tentacle's config", path: input.configDir, file: false };
3. link race: 32 creators -> winners=1 EEXIST=31 file=key-0 agree=true
   mode=600
```

P4 holds (`configDir` is unconditionally the first always-on hide entry, so
`<configDir>/devices/` cannot be read from a mounted workspace) and the
mechanism the identity stands on (`tmp` + `link`, loser reads the winner) is
verified in-process. Both checks moved no code.

**As built, in dependency order.**

1. `packages/protocol/src/pairing.ts` (new, exported from `index.ts`) —
   `formatPairingPayload` / `parsePairingPayload` + `PairingPayload`,
   `PairingRefusal` (`prefix | version | key | name | code | address | no_address`),
   `PAIRING_PAYLOAD_VERSION = 1`, `PAIRING_CODE_ALPHABET` (Crockford),
   `PAIRING_CODE_LENGTH`, `MAX_PAIRING_ADDRESSES`, `PAIRING_ADDRESS_SUFFIX`,
   `isPairingAddress`, `normalizePairingCode`, `isPairingName`, and the
   base64url codec (`encodeBase64Url` / `decodeBase64Url`). Unknown params
   ignored, required-and-wrong refused with a reason. No `*Schema` is exported
   here on purpose, so the JSON-Schema export never lists a QR payload as
   protocol — `packages/protocol/schema/protocol.json` is unchanged (no regen
   needed; the drift test agrees).
2. `packages/transport/src/pairing-sas.ts` (new) — `pairingSas`,
   `formatPairingSas`, `PAIRING_SAS_PREFIX`, `PAIRING_SAS_DIGITS`; re-exported
   from `noise-channel.ts` (the `@tentacle/transport/noise` subpath).
3. `packages/daemon/src/device-store.ts` (new, exported from `index.ts`) —
   identity (`readIdentity`, `loadOrCreateIdentity` tmp+`link`,
   `replaceIdentity`), registry (`readRegistry`, `writeRegistry`, `addDevice`,
   `removeDevices`, `dedupeName`, modes 0600/0700), `acquireRegistryLock`
   (exclusive-create pid lock, dead-holder takeover, no wait), last seen
   (`touchSeen` mtime, `readSeen`), pairing windows (`openPairing`,
   `findPairing`, `claimPairing` `wx`, `readClaim`, `writePairingDecision`,
   `readPairingDecision`, `closePairing`, `sweepPairings`) and daemon records
   (`writeDaemonRecord`, `removeDaemonRecord`, `readDaemonRecords`).
4. Tests: `packages/protocol/test/pairing-payload.test.ts` (18),
   `packages/transport/test/pairing-sas.test.ts` (6),
   `packages/daemon/test/device-store.test.ts` (27) — 51 new, all green.
5. `changelog.d/device-pairing.added.md` — ONE fragment for the task, the
   9a text from the plan's *Changelog fragments* (the plan drafts one per
   sub-task; the executor instruction is one per task, so 9b/9c/9d add theirs
   on their own branches and this one stays the registry's).

**Drift from the Implementation (and why).**

- **`formatPairingSas` added** (not in the plan's 9a list): the `123 456`
  grouping the design's prompt shows is presentation, but it is the same
  string two screens must agree on, so it is defined once beside the SAS
  rather than re-derived in 9c and 9d.
- **`base64url` codec lives in `protocol/src/pairing.ts`**, not in the daemon:
  the plan's table says the store keeps keys as b64url and the payload too —
  two encoders for one 32-byte key is the bug class §9 warns about, so the
  store imports the payload's.
- **`decodeBase64Url` enforces canonicality** (rejects a padded or
  trailing-pad-bit form). Not in the plan; without it two strings decode to
  one key, which makes "is this key registered?" depend on spelling. Pinned by
  a test and a mutation.
- **`removeDevices` also removes `seen/<id>`.** The plan lists `seen/` as
  daemon-written; a revoked device leaving its "last seen" behind would list
  it as if still known. `devices` (9d) reads the registry, so this is
  cosmetic from its side, but it keeps the store honest.
- **`readDaemonRecords` sorts** (oldest `startedAt` first, ties by pid). The
  plan says nothing; `readdir` order is unspecified and 9d puts these addresses
  in a QR in order, so the order is part of the contract. Found by a flaky
  test of my own, fixed in the source rather than by loosening the test.
- **`DeviceStoreFailure.missing`** is a flag, not a message prefix: the first
  draft let `loadOrCreateIdentity` decide "may I create?" by
  `reason.startsWith("missing")`, which is exactly the kind of string coupling
  that rots. The flag is the design's "a missing file is not an error", made
  explicit.
- **`writeRegistry` validates every entry's id against its key** before
  writing (the plan only says it writes under the lock). A registry whose id
  and key disagree would authorise one device and revoke another; the reader
  already refuses it, so the writer must not be able to produce it.
- **Daemon records carry `DAEMON_RECORD_VERSION`**, a third version constant
  beside `DEVICE_STORE_VERSION`. The plan's table shows `{ v: 1, … }` for the
  daemons dir; keeping it separate means task 10 can version its own siblings.
- Nothing in the plan's table was dropped, and no plan step contradicted the
  code.

**Mutations run (each restored immediately; `git diff` empty afterwards —
`.tentacle/tmp/device-pairing/mutate.sh` copies the file aside and restores
it, no git command is used).**

| # | Mutation | Test that caught it |
|---|---|---|
| M1 | identity `link` → `rename` (plain replace) | `identity > concurrent creators converge on one key (separate processes)` |
| M2 | `tightenModes` no-op | `identity > a loose mode … is tightened when the identity is loaded` |
| M3 | identity `v` accepted unchecked | `identity > an unknown version is refused and the file is untouched` |
| M4 | JSON parse error reads as ABSENT | `registry > a garbled registry is refused and left byte-for-byte alone` |
| M5 | registry `v` accepted unchecked | `registry > an unknown version is refused` |
| M6 | claim written without `wx` | `pairing windows > a claim is exclusive: the second one sees used` |
| M7 | `findPairing` ignores the pid being dead | `pairing windows > a window whose pair died is not found` |
| M8 | `dedupeName` bypassed in `addDevice` | `registry > re-adding the same key is idempotent; a new key … suffixed` |
| M9 | lock does not take over a dead holder | `registry > the lock refuses a live holder and takes over a dead one` |
| M10 | SAS hashes only the computer key | `pairingSas > matches an independently computed vector` + `swapping the two keys changes the code` |
| M11 | payload `v` accepted unchecked | `refusals … > an unknown or missing version` |
| M12 | payload address validation dropped | `refusals … > an address that is not a ws(s) URL ending in /e2e` |
| M13 | base64url canonicality dropped | `base64url > refuses a non-canonical encoding (two strings, one key)` |

Two tests were caught being vacuous and rewritten around the real property:
the canonicality test (its first form only asserted `false === false` when the
forged string happened to be invalid) and the mode test (it only asserted the
read succeeded). M13 and M2 are red on the rewritten ones.

**Gate.** `bun run check` green: `tsc --noEmit && tsc -p apps/mobile` clean,
`biome check .` 968 files no fixes (lint baseline clean, §6), `bun test`
7665 pass / 3 skip (the opt-in live-k8s, live-docker and slow keepalive skips
of §6) / 0 fail, 7668 tests in 547 files. `packages/protocol/schema/protocol.json`
unchanged (nothing new is a wire schema).

**Not verified here (one line each).** The store is fake-fs-driven and real-fs
tested in a temp dir, so nothing 9a ships is unexercised; what 9a cannot show
is that a `serve` daemon actually authorises a device from this registry and
that a revoke closes a live socket — that is 9b's `DeviceAuthority` and its
loopback test, and no code in 9a is on that path yet.

### 9b `device-route` — DONE

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-13*

Scope: slice 9b only. 9a's store is used unchanged except for one added read
(nit N3); 9c (`device/pair`, `PairHandler`, the client helper) and 9d (`pair`,
`devices`, the QR) are untouched. `Connection` gets the principal flag the plan
assigns to 9b/9c, with the pairing method gate; `device/pair` itself does not
exist yet, so a pairing connection can currently call `initialize` and nothing
else — which is the fail-closed half of F16.

**Load-bearing check (re-run first, as asked) — PASSES.**
`.tentacle/tmp/device-pairing-9b/lb1.ts` + `lb2.ts` (scratch; pasted below).

```
1. RESPONDER_MAX_MESSAGE_BYTES=33554432 (fixed before authorize; verdict is boolean)
2. today: /e2e + iOS Origin -> 401; /e2e headerless -> 426
   originAllowed(iOS Origin)=false
   server: authorize 516cbdef -> true
   server: UNCHANGED Connection built for 516cbdef
3. known key + iOS Origin over /e2e -> initialize protocolVersion=24
4. after revoke, in-flight request -> connection closed
   server: authorize 516cbdef -> false
5. redial after revoke -> kind=unauthorized
   server: responder rejected: denied
   server: authorize d823b0f4 -> false
6. unknown key -> kind=unauthorized
```

The capability is missing on `main` (a phone's `Origin` is 401'd on the only
route, which is `e2e`'s whole blocker) and the seam holds: a route + an
`authorize` verdict yields a device-bound connection with `Connection`,
`RpcPeer`, `RemoteClient` and `SessionHost` unchanged. P1 is confirmed as the
plan states it: the responder's cap is read at `noise-channel.ts:410`, before
the key is known at `:427`, so a per-verdict cap is required.

**As built, in dependency order.**

1. `packages/transport/src/noise-channel.ts` — `authorize` may return
   `AuthorizeAllow { allow: true; maxMessageBytes }` (`AuthorizeVerdict =
   boolean | AuthorizeAllow`); `readVerdict` reads it and FAILS CLOSED on
   anything else (`null`, `{allow:false,…}`, a non-positive/non-integer cap →
   the deny path, no channel built). The cap goes to the `Secured` built in the
   responder only.
2. `packages/daemon/src/handshake-limit.ts` (new, pure, injectable clock) —
   `HandshakeLimiter`: per-address token bucket (`admit`), a GLOBAL
   concurrent-handshake cap (`begin`/`end`, `inFlight`), a bounded bucket map
   (`tracked`, `maxTrackedAddresses`), and one rule the plan does not state but
   F6/F15 need: a refusal by the CAP does not spend the address's token, so a
   burst of unrelated peers cannot starve a real device.
3. `packages/daemon/src/device-store.ts` — `hasLivePairing`, a side-effect-free
   "any usable window" read. This is 9a Review nit N3's requirement (9a's
   `findPairing` sweeps as it goes and throws on a malformed code, so it must
   not back `authorize`, which runs on replayed message 1s).
4. `packages/daemon/src/device-authority.ts` (new) — `DeviceAuthority`:
   `authorize` (stat-refresh + a fresh pairing read, returning
   `{kind:"device",id}` / `{kind:"pairing"}` / `false`), the 1 s poll that
   closes revoked devices and — on an identity change — every device, `register`
   / `unregister` / `liveCount`, `staticKey`, `identity`, `configDir`, `stop`;
   `PAIRING_MAX_MESSAGE_BYTES = 64 KiB`, `DEVICE_MAX_MESSAGE_BYTES = 32 MiB`.
   Fail-closed on an unreadable or unknown-version store, with one audit line
   per fault.
5. `packages/daemon/src/connection.ts` — `ConnectionPrincipal` (`token` |
   `device` | `pairing`, absent = token) and the pairing gate: a pairing
   connection calling anything but `initialize` gets `Unauthorized` (-32001).
6. `packages/daemon/src/ws-server.ts` — `devices?: DeviceRouteOptions`; the
   `/e2e` route (no token, no Origin check), the rate-limited upgrade (429
   before any crypto), `openDevice` (responder → resolve → unchanged
   `Connection` on the RESOLVED channel → register under the device id →
   `touchSeen` → `device-open` / `pairing-open`; `device-denied` /
   `e2e-violation` on the failure path), the F22 orphan check, and the bind
   rule (a non-loopback bind without a token is allowed when `devices` is set,
   and the plain route then answers 401 to everyone).
7. `packages/cli/src/serve.ts` — `deviceAuthority()` at start-up
   (`loadOrCreateIdentity`, fatal on an unusable one, naming the file),
   `ServeOptions.devices` (default on; `false` = today's listener),
   `devices` passed to `listen`, the authority stopped in `release`, and
   `<configDir>/daemons/<pid>.json` written at listen / removed at stop.
8. Tests — `daemon/test/handshake-limit.test.ts` (10), `daemon/test/device-authority.test.ts` (18),
   `daemon/test/ws-device-route.test.ts` (13, real loopback),
   `cli/test/serve-devices.test.ts` (7, real disk + real socket),
   `daemon/test/device-store.test.ts` (+2), `transport/test/noise-channel.test.ts` (+3).
9. `changelog.d/device-pairing-9b.added.md` — the plan's `device-route` text.
   `packages/protocol/schema/protocol.json` is UNCHANGED and needed no regen:
   9b adds no wire schema (only 9a's non-schema payload codec and 9c's
   `device/pair` are protocol surface).

**Drift from the Implementation (and why).**

- **`DeviceVerdict` carries `allow: true` + `maxMessageBytes` as extra fields
  on the SAME object**, rather than a separate return channel. The plan says
  "the verdict object carries the reassembly cap"; keeping one object means
  the role and the cap cannot be paired wrongly.
- **The plan's `DeviceRouteOptions` had a `configDir`**; I moved it onto
  `DeviceAuthority.configDir` and the route reads it from there. Two fields
  that must agree (the store the authority reads and the `seen/` dir the route
  writes) are now one value by construction.
- **The plain route's "answer 401 to everyone" is scoped to a NON-LOOPBACK
  bind.** The plan's sentence is unconditional; taken literally it also
  refuses a local CLI on a loopback `serve` with no token, which is today's
  normal local case and would have been a silent regression (it broke 14
  existing `serve-persistence` tests before I caught it — see the failure
  below). On loopback the plain route is unreachable from the network, so the
  exposure the rule protects does not exist there. This is the one place I
  narrowed the plan; flagging it for Review.
- **The route is chosen at the UPGRADE** (`SocketData.route`), never inferred
  in `open` from "is `devices` set". Also found by the same regression: with
  the branch on `devices`, every plain client on a device-route server was
  pushed into the Noise responder and hung. Pinned by a test and M27.
- **`hasLivePairing` is new in 9a's file** (nit N3), so 9a gained one exported
  pure read and two tests. 9a's own behaviour is unchanged.
- **A device's live connection is one `DeviceClose` handle per connection**
  (`{close()}` closing both the `Connection` and the socket), held by the
  authority and unregistered by the same identity on every teardown path — so
  a revoke's later `unregister` can never touch a different socket.
- **The audit line is emitted BEFORE the sockets are closed**: `close()` reaches
  the ws-server's teardown synchronously enough to unregister the very entry
  being iterated, so an ordering that logged afterwards could lose the line
  (it did, while I was building this).
- **`DeviceAuthority`'s poll is `unref`'d** where the runtime supports it. Not
  in the plan; an armed interval is otherwise a reason for a process to stay
  alive, which `serve`'s listener — not housekeeping — should decide.
- **`serve-limits.test.ts`'s sweep-timer test now passes `devices: false`.**
  That test counts 1 s timers as a proxy for "the reaper", and the device poll
  shares that period; leaving it on would make the test's own mutation
  (`arm` starting a reaper when the period is null) no longer detectable. The
  device poll's lifecycle is pinned instead in `serve-devices.test.ts`, so
  neither side is unchecked. This is the only test I changed outside my own
  files.
- Nothing in the plan's file set was dropped. No step contradicted the code.

**Mutations run (each restored immediately; no `git checkout`/`restore`/`stash`
— the file is copied aside to `.tentacle/tmp/device-pairing-9b/mut/` and copied
back).** Nine survived a first pass and the tests were rewritten or the code
fixed, as noted.

| # | Mutation | Caught by |
|---|---|---|
| M1 | responder ignores the verdict's cap (builds with `max`) | `authorize's verdict … > an allowed stranger is capped at the verdict's bytes` |
| M2 | an unreadable verdict is treated as allow | `… > a verdict it cannot read fails CLOSED` |
| M3 | the concurrent cap does not gate `begin` | `the concurrent-handshake cap > past the cap every address is refused…` |
| M4 | a cap refusal spends the address's token | `… > a capped-out begin does not spend the address's token` (**survived first**: burst 5 hid the spent token — test rewritten to burst 1) |
| M5 | the bucket map is unbounded | `the buckets are bounded … > more addresses than the cache holds…` |
| M6 | the injected clock ignored (`Date.now`) | `the per-IP token bucket > a burst is admitted…` + `a long absence refills…` |
| M7 | `hasLivePairing` sweeps dead windows | `hasLivePairing … > is SIDE-EFFECT FREE` (**survived first**: readdir order let a live window answer before the sweep — the test now has no live window) |
| M8 | `hasLivePairing` ignores expiry | `… > finds a live window without the code…` |
| M9 | `hasLivePairing` ignores a dead pid | `… > finds a live window…` + `is SIDE-EFFECT FREE` |
| M10 | the poll does not close | `a revoke closes the live socket > … within ONE tick` |
| M11 | `authorize` is snapshot-only (no stat refresh) | `… > revoke BEFORE the tick: the next authorize already denies` (F8) |
| M12 | a broken store fails OPEN (every key a device) | `an unreadable store fails CLOSED > a garbled registry denies a KNOWN key` |
| M13 | an unknown key with no window is admitted | `… > an unknown key with no pairing window is DENIED` (F15) |
| M14 | the pairing verdict gets the device cap | `a pairing window > … capped small` (P1) |
| M15 | an identity change does not close devices | `… > devices reset closes EVERY device` (F11) |
| M16 | the injected `alive` never reaches the pairing read | `… > a window whose pair died denies` (**survived first**: the test's pid was genuinely dead, so the real `processAlive` denied too — test now uses our own live pid) |
| M17 | expiry judged on a clock captured at construction | `… > a window that expired denies` (F24) |
| M18 | the pairing principal's method gate skipped | `a pairing connection is pairing-only > session/list … is Unauthorized` (F16) |
| M19 | the plain route refuses a loopback client too | `a plain client on the SAME server is untouched` |
| M20 | `touchSeen` called inside `authorize` | `a replayed Noise message 1 leaves seen/ untouched` (F4/P2) (**survived first**: the deny/resolve test could not see it — a real replay test replaced it) |
| M21 | `/e2e` taken even with no `devices` | `without devices, /e2e is the PLAIN route` (F21) |
| M22 | no rate limit at the upgrade | `past the burst … 429` (F6) |
| M23 | the verdict cap ignored end to end | `a frame over the pairing cap closes it` |
| M24 | `serve` creates no identity | 4 tests in `serve-devices` |
| M25 | an unusable identity is tolerated | `an unreadable identity REFUSES to start` (F26) |
| M26 | the daemon record is never removed | `is written at listen … and removed at stop` |
| M27 | `open` branches on `devices`, not the socket's route | `a plain client on the SAME server is untouched` (the real bug I hit) |
| M28 | the poll is never cleared at stop | `the device poll's timer is owned by the daemon …` (**survived first**: "some timer was cleared" — now asserts THAT handle) |

**Gate.** `bunx tsc --noEmit` clean, `bunx tsc -p apps/mobile --noEmit` clean,
`bun run lint` 1019 files clean (0 errors/0 warnings, §6 baseline),
`bun test` **7975 pass / 3 skip / 0 fail**, 7978 tests in 570 files — the 3
skips are §6's opt-ins (live-k8s, live-docker, the slow keepalive).
`packages/protocol/schema/protocol.json` unchanged.

**Not verified here (one line each).**
- The pairing EXCHANGE is absent by design (9c): `device/pair` does not exist,
  so a pairing connection currently cannot complete a pairing — the tests prove
  the gate and the cap, not a pairing.
- The rate limiter is exercised through a real upgrade, but its *default*
  (8 per 500 ms, 32 concurrent) is only unit-tested; nobody has driven a real
  phone's reconnect storm against it.
- `unref` is Bun-only trivia asserted by no test (a runtime property, not our
  contract): verify by starting `serve` and checking the process exits when the
  listener stops.
- The `0.0.0.0` bind is tested on loopback addresses; a real LAN/phone dial of
  `/e2e` is 9d's `pair-e2e` and the device itself.

### Fix round 1 (9b)

*— claude-opus-5-5, 2026-11-13*

Scope: 9b's two MEDIUM findings only. Two source files, two test files; no
other slice touched.

**F1 (MEDIUM) — the no-identity path leaked a handshake slot for good.**

Reproduced first, in `.tentacle/tmp/device-pairing-9b/leak2.ts` (an authority
with no identity, `maxConcurrent: 2`, 8 dials of `/e2e`), on the unfixed code:

```
audit: e2e-no-identity
audit: connection-close
0 open
audit: e2e-no-identity
audit: connection-close
1 open
audit: e2e-rate-limited 127.0.0.1
2 error
audit: e2e-rate-limited 127.0.0.1
3 error
… (dial 4-7: e2e-rate-limited)
```

Dials 0-1 were admitted and each kept its concurrent slot; from dial 2 on,
every device is 429'd — permanently, since nothing ever calls `limiter.end()`
for a socket that never reached `pending.set`.

Root cause, one sentence: `openDevice` closes a no-identity socket and returns
BEFORE registering `finish` in `pending`, so neither the responder's settle
paths nor the `close` handler ever ends the slot `begin` took at the upgrade.

Fix (`ws-server.ts:359-372`): call `limiter?.end()` directly on that path.

Test: `daemon/test/ws-device-route.test.ts` → *"a no-identity window gives every
handshake slot back, so the route recovers (F14)"*. Five dials with
`maxConcurrent: 2` must all be **admitted then closed** (never refused), then an
identity is written, the authority's poll picks it up, and a real paired key
completes `initialize` with no restart. RED before the fix, on the assertion:

```
- Expected  - 3      + Received  + 3
   "closed",
-  "closed",        +  "refused",
-  "closed",        +  "refused",
-  "closed",        +  "refused",
```

**F2 (MEDIUM) — F26 was applied to every bind, not only non-loopback ones.**

Reproduced: an unusable `identity.json` made a loopback `serve` reject at
start-up (`deviceAuthority` threw), for a user who never pairs. Fix scoped to
F26's own case (`serve.ts:235-266`): the throw stands for `!isLoopbackHost(host)
&& !token` (no other gate exists there); everywhere else the daemon starts
WITHOUT the device route and reports one line naming the file. Nothing
advertises a route it does not have: `daemons/<pid>.json` is written only when
an authority exists, so `pair` (9d) never dials a disabled `/e2e`.

Tests (`cli/test/serve-devices.test.ts`):
- *"an unreadable identity REFUSES a non-loopback token-less start …"* — the
  existing F26 test, narrowed to F26's own bind (`0.0.0.0`), still red on an
  unscoped throw.
- *"an unusable identity on a LOOPBACK bind starts WITHOUT the device route
  (F26 is scoped)"* — starts, `onError` contains `identity.json`, the file is
  byte-identical afterwards, and `readDaemonRecords` is empty. RED before the
  fix (`startDaemon` rejected at `serve.ts:245`).

This is now a recorded decision for the owner, not silent drift: a loopback
`serve` degrades (device route off, one error line) rather than refusing to
start. If the owner prefers the strict reading — refuse on every bind — the
change is one `&&` and the second test is deleted.

**Mutations (each applied, tested, restored from a copy in
`.tentacle/tmp/device-pairing-9b/`; no `git checkout`/`restore`/`stash`).**

| # | Mutation | Result |
|---|---|---|
| F1-M | drop the no-identity path's `limiter.end()` | RED: the route test's 3rd-5th dials come back `refused` (13 pass / 1 fail) |
| F2-M1 | `if (!isLoopbackHost(host) && !token)` → `if (true)` (throw on every bind, i.e. the pre-fix behaviour) | RED: the loopback test's `startDaemon` rejects (7 pass / 1 fail) |
| F2-M2 | drop the file name from the degraded-start error line | RED: `expect(errors.join()).toContain("identity.json")` (7 pass / 1 fail) |

One mutation attempt is reported honestly: my first F2-M2 edit produced a
syntax error (`void (…);` left a stray `)`), which `bun test` surfaced as a load
error (0 pass / 1 fail / 1 error) — that proves nothing, so I re-did it as a
valid mutation (F2-M2 above) and only that result is claimed.

**Gate.** `bunx tsc --noEmit` clean · `bun run lint` 1019 files, no fixes
applied (0 errors/0 warnings, §6 baseline) · `bun test` **7977 pass / 3 skip /
0 fail**, 7980 tests across 570 files, 337 s — the 3 skips are §6's opt-ins
(live-k8s, live-docker, the slow keepalive). That is +2 tests over the round's
start (7975 pass / 7978 tests): the new route test and the new scoped-F26 serve
test. `packages/protocol/schema/protocol.json` unchanged (no wire surface here).

**Not verified / left open.** None of the findings' own behaviour is unverified.
The F2 scope is a decision I took under the Review's "either/or"; the owner may
pick the strict reading instead (see above). F1's production value (32) is not
driven by a test — the test uses 2 to make the leak cheap to see; the arithmetic
is the same rule.

### 9c `device-pair-exchange` — DONE

*— claude-opus-5-5, 2026-11-13*

Scope: slice 9c only — `device/pair` and both its ends. 9a's store and 9b's
route/authority are used as they are (two additive touches to 9b's source files,
`connection.ts` and `ws-server.ts`, listed under drift); 9d (`pair`, `devices`,
the QR, `flags.ts`, `main.ts`) is untouched, so nothing here can run a pairing
from a terminal yet.

**Load-bearing check (re-run first, as asked) — PASSES.**
`.tentacle/tmp/device-pairing-9c/lb.ts` + `lb2.ts`.

```
1. Method.DevicePair=undefined PairingRefused=undefined
   protocol/src/device.ts exists=false  daemon/src/pairing-handler.ts exists=false  PairHandler export=undefined
   isMethodName("device/pair")=false PROTOCOL_VERSION=24
   client exports["./pairing"]=undefined
2. pairing connection: initialize OK, audit pairing-open=true
   device/pair today -> rejected code=-32601 unknown method: device/pair
   claim written? no
3. channel's authenticated key (client side): remoteStatic==deviceKey=false  (it is the PINNED daemon key — see lb2)
   peer dispatch concurrent (no lock): yes
   ws-server builds the pairing principal: yes
4. store API for the handler: findPairing=function claimPairing=function readClaim=function
   readPairingDecision=function readRegistry=function addDevice=function deviceIdOf=function dedupeName=function
   pairingSas over the wire module: function formatPairingSas=function
5. daemon-side SecureChannel.remoteStatic == publicKeyOf(phoneKey): true
   client-side SecureChannel.remoteStatic == daemonPub: true
   authorize saw the device key: true
   sas agreed: 049319 / 049319
```

The capability is missing exactly as the plan says (no method, no code, no
handler, no client subpath), and the seam the slice stands on holds: the
DAEMON-side `SecureChannel.remoteStatic` is the initiator's authenticated static
key, so the claim/registry can take the key from the channel and `device/pair`'s
params need none — which is what F18 depends on. Point 3's `false` is my first
probe being misaimed (on the client side `remoteStatic` is the pinned peer key);
`lb2.ts` measures the right side, in-process, and both ends agree on the SAS.
Point 2 also shows 9b's gate intact: a pairing connection gets `initialize` and
nothing else, so the only thing missing was the method itself.

**As built, in dependency order.**

1. `packages/protocol/src/device.ts` (new, exported from `index.ts`) —
   `DevicePairParamsSchema` (`code` exactly `PAIRING_CODE_LENGTH`, `name` a
   `line(64)` display line), `DevicePairResultSchema` (`deviceId` 16-hex,
   `computer { id, name }`), `PairingRefusedReason` + `PAIRING_REFUSED_REASONS`
   + `isPairingRefusedReason`, `PairingRefusedDataSchema`, `DEVICE_ID_RE`. Strip
   objects, no `.strict()` (§7): an unknown param — including a key a hostile
   peer tries to smuggle (F18) — is DROPPED.
2. `packages/protocol/src/jsonrpc.ts` — `PairingRefused: -32017`.
3. `packages/protocol/src/methods.ts` — `Method.DevicePair = "device/pair"` + its
   `RequestSchemas` entry, so the peer validates params/result at both ends.
4. `packages/protocol/schema/protocol.json` — regenerated
   (`bun run schema:export`, +70 lines: `DevicePairParams`,
   `DevicePairResult`, `DeviceComputer`, `PairingRefusedData`, the method and the
   error code). The drift test agrees; no hand edit.
5. `packages/daemon/src/pairing-handler.ts` (new, exported from `index.ts`) —
   `PairHandler` (per connection: `attemptCount`, the idempotent own-claim
   memory, `PAIRING_MAX_ATTEMPTS = 5`), `pairingRefusedError`,
   `PAIRING_POLL_MS`. Sequence: `findPairing` (throw-absorbed: 9a Review N3),
   `claimPairing` with the CHANNEL key, wait on the registry-then-decision, then
   the result or a reason; `signal` stops the wait when the peer hangs up.
6. `packages/daemon/src/connection.ts` — `ConnectionPrincipal`'s pairing variant
   carries its handler (`{ kind: "pairing"; pair: PairHandler }`); `Method.
   DevicePair` dispatches to `devicePair`, which refuses a token/device
   principal with `already_paired` and otherwise maps `PairOutcome` to the
   result or `PairingRefused`. The 9b method gate stays exactly as it was, with
   `device/pair` now the one allowed method.
7. `packages/daemon/src/ws-server.ts` — the pairing principal builds its
   `PairHandler` with `authority.configDir`, the identity the handshake was
   admitted against, and `secure.remoteStatic`; a pairing connection is closed
   when its window goes (`watchPairingWindow` → `hasLivePairing`, default 1 s,
   `pairingCheckMs` injectable), the watcher stopped on every teardown path.
8. `packages/client/src/pairing.ts` (new) + `exports["./pairing"]` —
   `pairDevice` (one dial per address, `secureChannelFactory`, `initialize`,
   `onCompare(sas)` BEFORE the code is sent, `device/pair`, close),
   `PairingRefused` + `pairingRefusedFrom`, `PAIRING_REFUSED_MESSAGES`. A
   one-shot RPC: no `RemoteClient`, no session.
9. Tests — `protocol/test/device-pair.test.ts` (13),
   `daemon/test/pairing-handler.test.ts` (21), `daemon/test/ws-device-route.test.ts`
   (+6, real loopback), `client/test/pairing.test.ts` (8, real loopback against a
   real daemon), `protocol/test/json-schema.test.ts` (+1 fixture pair).
10. `changelog.d/device-pairing-9c.added.md` — the plan's
    `device-pair-exchange` text, as the `added` fragment. The plan's drafted
    FILE NAME (`device-pair-exchange.added.md`) is not the one used: the task's
    own instruction is one fragment named `device-pairing-9c.<category>.md`, and
    9b already set that precedent (`device-pairing-9b.added.md`). The text is the
    plan's, unchanged.

**Drift from the Implementation (and why).**

- **The pairing principal carries its `PairHandler`** (`{ kind: "pairing"; pair:
  PairHandler }`) — the plan's own shape, replacing 9b's bare `{ kind: "pairing" }`.
  Recorded here because it is a 9b type that 9c had to extend, and because the
  handler's placement is a decision: per CONNECTION, not per daemon. A per-daemon
  handler would make the attempt cap global (one hostile peer could spend a real
  phone's five tries) and would have to look the channel key up per request;
  building it at the resolve gives both the key and the cap for free.
- **`code` is length-checked, not alphabet-checked, at the schema.** A wrong
  alphabet must read as `invalid_code` — the same answer as a stale code — or a
  mistyping human and a brute-forcer get different replies on an unauthenticated
  connection. The handler normalises via the 9a store, which throws on a bad
  alphabet (9a N3), so that throw is absorbed (`safely`) and counted as an
  attempt.
- **A registry ALONE decides success** (plan F3 says so): a decision file with no
  entry declines rather than admits. The plan's step 5 orders `pair` as
  registry-then-decision, so `accepted: true` is a hint, not an authority — never
  fail open. Pinned by a test and M-F14.
- **The attempt cap's close is deferred to a macrotask** (`setTimeout(…, 0)`),
  not called inline: `RpcPeer` writes the response frame in a microtask
  continuation, so an inline `close()` beats the `PairingRefused` frame to the
  wire and the peer sees only a dropped socket (the test asserts the reason
  ARRIVES, then that the socket closes). This is 9b's own audit-line ordering
  lesson, in the send path.
- **The pairing connection's window watcher is new in `ws-server.ts`** (the
  plan lists "close pairing connections at their session's expiry" as a 9c file
  change, and 9b left no mechanism): 1 s poll of `hasLivePairing`, injectable
  (`pairingCheckMs`), `unref`'d, stopped by `ws.data.release` on every teardown
  path including F22's orphan path.
- **`onCompare` receives `{ protocolVersion }`** as well as the SAS: the plan
  says `onCompare(sas)`; a pairing screen needs to say "update tentacle on this
  computer" for an old daemon (F23, task 11), and the handshake answer is the
  only place that fact exists. One extra field on a client-side callback (no
  wire change).
- **`random` is REQUIRED on `PairDeviceOptions`** (the plan implies an injectable
  default): `InitiatorOptions.random` has no fallback anywhere in the transport,
  and the app must pass `expo-crypto` (Hermes has no WebCrypto). A default would
  be a silent weak-key risk in a crypto path.
- **`channelErrorFromNoise` is NOT re-mapped in `pairing.ts`**: `secureChannel-
  Factory` already maps `denied` → `unauthorized` (9b/task 8), so a second
  mapping would drift. The wrong-pin test therefore asserts "a channel failure,
  never a `PairingRefused`" rather than one exact kind.
- **`closePairing` had to be imported in 9b's route test** (already exported by
  9a) — a test-only addition, no source change to 9a.
- Nothing in the plan's 9c file set was dropped; no plan step contradicted the
  code. `docs/feat/device-pairing.md`'s own file table needed no edit.

**Mutations run (each restored immediately from a copy in
`.tentacle/tmp/device-pairing-9c/mut/`; no `git checkout`/`restore`/`stash`; the
worktree's `git status` shows only 9c's real files afterwards).**

| # | Mutation | Test that caught it |
|---|---|---|
| M1 | params gain a `publicKey` field AND the handler registers it (the plan's F18 mutation) | `device-pair > an unknown field is DROPPED` + `pairing-handler > a foreign key in the params is ignored` |
| M2 | the claim keeps using `remoteKey` but the `claimed`-sid guard is removed (`&& false`) | 10 handler tests (the whole pairing path collapses) |
| M3 | the own-claim memory is bypassed (`\|\| true`: every retry re-claims) | `a retry of the same code on the SAME connection is idempotent` |
| M4 | an unreadable registry reads as "lists everybody" (`ok ? … : true`) | `an unreadable registry never admits (F14)` (**survived first** — no test covered it; this test was written for it) |
| M5 | `onCompare` moved AFTER `device/pair` (the plan's exact mutation) | `onCompare fires BEFORE device/pair is sent` — `Expected false, Received true` on "a claim exists at compare time" |
| M6 | `onCompare` never called | `a code, the human's y and the SAS` + the ordering test |
| M7 | the pairing window watcher is never started | `closing the window closes the pairing connection` |
| M8 | the cap's `close()` called inline instead of deferred | `five wrong codes … and then close` (the reason frame never arrives) |
| M9 | the cap threshold raised to 999 | the same two route/handler cap tests |
| M10 | the `findPairing` throw is not absorbed | `a code that is not the alphabet is invalid_code, never a throw` |
| M11 | the abort check is dropped | `a peer that hangs up mid-wait stops the wait` (times out) |
| M12 | `accepted: false` reads as success | `the human's N is declined, and the registry stays empty` |
| M13 | a token/device principal may call `device/pair` | `device/pair on a DEVICE connection is already_paired` |

**Gate.** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit` clean ·
`bun run lint` 1047 files, no fixes applied (0 errors/0 warnings, §6 baseline) ·
`bun test` **8144 pass / 3 skip / 0 fail**, 8147 tests across 583 files, 318–327 s
— the 3 skips are §6's opt-ins (live-k8s, live-docker, the slow keepalive). 9c
adds **48 tests** of its own (13 `device-pair`, 21 `pairing-handler`, 6
`ws-device-route`, 8 `client/pairing`) plus one fixture pair in the existing
schema-drift test; the rest of the rise over 9b's 7975 comes from branches merged
into `main` since. `packages/protocol/schema/protocol.json` regenerated (a wire
schema DID change — `device/pair` + `PairingRefused`).

One flake, reported rather than hidden: the FIRST full run had 1 failure —
`serve-log-store.test.ts` S11 ("200 kills"), a real-SIGKILL chain that
`docs/feat/mobile-session-view.md:1117` and `docs/fix/local-subagent-panel-
unwired.md:256` already record as LOAD-FLAKY. It passed 5/5 standalone
(`-t "200 kills"`), it touches nothing 9c changed (its fixture imports only the
agent/core/tools/store/persister), and the second full run was green — so it is
not attributable to this slice, but it is not "clean on the first try" either.
`packages/protocol/schema/protocol.json` regenerated (a wire schema DID
change).

**Not verified here (one line each).**
- No terminal can start a pairing yet: `tentacle pair` (the QR, the address
  choice, the human's `[y/N]` prompt, the exit handler that clears the window)
  is 9d, and the tests drive the human with a fake that writes the registry and
  the decision itself — so the ORDER those two writes take is 9d's to prove end
  to end (`cli/test/pair-e2e.test.ts`).
- The SAS is verified byte-identical between both ends in-process (`lb2.ts`) and
  against the store's claim in two tests, but no real phone has displayed it.
- `PAIRING_CHECK_MS` (1 s) and `PAIRING_POLL_MS` (100 ms) are only ever driven at
  test speeds; nobody has measured a real 5-minute window's polling cost (it is
  two `readdir`s and a stat per second per pairing connection).
### 9d `device-cli` — DONE (one assertion deferred to 9b/9c, named below)

*— claude-opus-4-5-20250929, 2026-11-14*

Scope: slice 9d only (the CLI: `pair`, `devices`, `revoke`, `reset`, the
address rule, dispatch, help). 9b/9c untouched — they are not merged on this
branch, which matters below.

**Load-bearing check (re-run first, as asked).**
`.tentacle/tmp/device-pairing-9d/capability.ts`:

```
1. cliMode("pair") = prompt  (want "prompt" = the word goes to the model)
   cliMode("devices","list") = prompt
   main.ts has a pair/devices branch: false
2. 9a store API: 16/16 present; missing=none
3. protocol payload codec missing=none
4. 9d files present=0/3
5. cli deps mentioning qr: none
6. bun.lock mentions uqr: false
```

The capability is missing exactly as the plan's Context says (both words go to
the MODEL as prompts today), and every seam 9d stands on **is** present: 9a's
`device-store` exports all 16 functions this slice calls (`readDaemonRecords`,
`openPairing`/`findPairing`/`claimPairing`/`readClaim`/`writePairingDecision`/
`closePairing`, `addDevice`/`removeDevices`/`readRegistry`, `readSeen`/
`touchSeen`, `loadOrCreateIdentity`/`replaceIdentity`, `writeDaemonRecord`,
`deviceIdOf`, `dedupeName`) plus `@tentacle/protocol`'s payload codec and
`@tentacle/transport/noise`'s `pairingSas`/`formatPairingSas`. The check moved
no code.

**Step 0 (blocking): the QR encoder — `uqr@0.1.3`, pinned exactly.**
`npm view uqr` confirms MIT; the tarball's own `package.json` has **no
`dependencies` field at all** (zero runtime deps), and its `dist/index.d.ts`
exports `renderUnicodeCompact(data, options)`, which is the two-modules-per-line
block form the plan wanted. So the plan's primary choice holds and Nayuki's
`qrcodegen` is not needed (no `NOTICE` entry, nothing vendored).
`packages/cli/package.json` gained `"uqr": "0.1.3"` (exact, no caret) and
`bun install` updated `bun.lock` (+3 lines).

**As built, in dependency order.**

1. `packages/cli/src/pair-addresses.ts` (new, pure) — `pairAddresses` +
   `isLoopbackHost`, `isCarrierGradeNat`, `InterfaceEntry`/`Interfaces` and
   `REACHABLE_HINT`. The rule as designed: loopback contributes nothing,
   `0.0.0.0`/`::` expand to each non-internal IPv4 (LAN and Tailscale
   `100.64/10`; IPv6 addresses of the machine are left out — a privacy-temporary
   or link-local v6 in a QR is noise, and `--address` covers the real need), an
   explicit bind is itself, `wss` follows `tls`, brackets around an IPv6 literal,
   `--address` appended then deduped **first-wins**. Invalid `--address` and
   "more than 8" are REFUSED (`invalid` / `too_many`), never dropped or
   truncated.
2. `packages/cli/src/pair.ts` (new) — `pairCommand` and the pure pieces around
   it: `newPairingCode` (10 Crockford chars from bytes' low 5 bits, so no modulo
   bias — 256 is a multiple of 32), `pairPrompt` (name through `untrustedText`,
   SAS through `formatPairingSas`), `pairAddressesOf`. Flow: identity
   (`loadOrCreateIdentity`, a refusal names the file) → addresses (none → exit 1
   with the hint, **before** a window opens) → `openPairing` → QR (only when
   stdout is a terminal) + the pasteable payload on STDOUT → poll `readClaim` →
   prompt → `addDevice` **then** `writePairingDecision` (F3) → close the window
   in a `finally`, plus an `exit`/SIGINT/SIGTERM hook so an interrupted `pair`
   takes its window with it (F2).
3. `packages/cli/src/devices-cmd.ts` (new) — `devicesCommand`,
   `revokeCommand`, `resetCommand`, and the pure `renderDevices` /
   `formatSeen` / `resolveDevice`. `resolveDevice` is exact-name first, then an
   id prefix, and an AMBIGUOUS word is refused with both candidates named.
   `reset` reads the registry **before** touching anything (an unreadable one is
   never wiped), replaces the identity, then empties the list through
   `removeDevices` — so the phone is dropped from the file *and* the key it
   pinned is gone.
4. `packages/cli/src/flags.ts` — `pair`/`devices` in `CliMode`, `SUBCOMMANDS`,
   `cliMode`, `USES_MODEL` (both `false`: a broken `apiKeyCommand` must not stop
   a revoke), `ARGS`, and `USAGE`; new `ArgSpec.repeated` +
   `ParsedFlags.repeats` so `--address` is a LIST (a repeatable flag is not in
   `flags`, so one value per name stays the only truth there). `kind()` treats a
   `repeated` name as a value flag — without that, `--address` was "unknown
   option" (found by its own test, see M18).
5. `packages/cli/src/main.ts` — import, `runDeviceCommands` (dispatch only),
   the branch that runs it **before** `loadConfig` (pairing must work on a
   broken `config.jsonc`, as `explain`/`config`/`update` already do), and the
   help text for all four verbs.
6. Tests: `packages/cli/test/pair-addresses.test.ts` (17),
   `pair.test.ts` (17), `devices-cmd.test.ts` (22), `pair-dispatch.test.ts` (14),
   `pair-e2e.test.ts` (3) — 73 new, all green.
7. `changelog.d/device-pairing-9d.added.md` — one fragment, the plan's
   `device-cli` text.

**Drift from the Implementation (and why).**

- **`ArgSpec.repeated` / `ParsedFlags.repeats` are new plumbing**, not in the
  plan's file list (`flags.ts` is). `parseArgs` is closed and one-value-per-name:
  `--address a --address b` was a "given more than once" error, so the plan's
  `[--address URL]…` could not be expressed at all. The alternative — a
  comma-separated single `--address` — would have silently changed the meaning of
  an address containing a comma. Additive: `flags`/`bools` are untouched.
- **The SAS is computed by the daemon (9a's `claimPairing`), and `pair` prints
  `claim.sas`.** The plan's Design has the phone compute it; `pair` showing
  `readClaim`'s value is what 9a built and what makes the two screens compare
  the same string (both derive it from the authenticated `remoteStatic`, so a
  peer cannot pick it). A test pins it against an independent `pairingSas`, so
  the two agree by construction. `pair` never recomputes it.
- **`--name` does not rename an existing identity**; it names a NEW one and is
  otherwise reported as ignored (one dim line, exit code unaffected). The plan
  says `[--name NAME]` without saying which, and silently renaming would change
  the computer name phones already pinned — `devices reset` is the deliberate
  way to change it (owner Q3).
- **`pair` prints the payload on STDOUT and everything else on STDERR**, per
  `docs/fix/cli-output-streams.md` (which the plan does not mention). The QR goes
  to STDERR with the instructions: it is human-facing, and a pipe must not fill
  with block characters.
- **A `pair` with no terminal declines a claim** (`no terminal to confirm it`,
  decision 2) rather than waiting for the 5 minutes to run out. Not in the plan's
  F-table; it is the same rule as "the host confirms", applied when there is no
  host.
- **`pair`'s window is closed on SIGINT/SIGTERM** through `exitHooks`, restoring
  the default signal action and re-raising so Ctrl+C still exits. The plan's F2
  says "exit handler deletes"; this is that handler, and the pid check plus the
  sweep remain the backstop for a crash.
- **`devices reset` empties the registry as well as replacing the key.** The
  plan's Design says "new identity + empty registry"; both halves are done, in
  that order (read → replace → empty), so a failure between them never leaves
  old devices authorised by a new key.
- **`REACHABLE_HINT` and `isCarrierGradeNat` are exported** for the refusal text
  and its test; the plan asks only for the rule.
- No plan step contradicted the code, and nothing in the plan's 9d list was
  dropped.

**One assertion the plan asks for CANNOT be built on this branch (STOP, not
skipped silently).** The plan's final 9d test is: *"real `startDaemon` on
loopback + `--address ws://127.0.0.1:<port>/e2e` + `pairDevice` + in-process
`pair` answering `y` → paired; `revoke` → the phone's live connection closes."*
It needs 9b's `/e2e` route + `DeviceAuthority` + `serve` writing
`daemons/<pid>.json`, and 9c's `device/pair` + `packages/client/src/pairing.ts`.
Verified absent in this tree: `grep -c devices packages/daemon/src/ws-server.ts`
→ `0`; no `device-authority.ts`/`handshake-limit.ts`; no `DevicePair`/
`PairingRefused` in `protocol/src`; no `./pairing` export in
`packages/client/package.json`. The plan itself says "9d merges **after** 9c
(its last test drives a real daemon)", so this is the documented order, not a
defect — the branch is simply ahead of its siblings. What ships instead
(`packages/cli/test/pair-e2e.test.ts`) drives every 9d-owned seam through the
real `main`: argv → dispatch → identity → window → claim → prompt → registry →
`devices` → `revoke` (and `seen/` cleanup), faking exactly two calls that
belong to the unmerged slices — the daemon record (written with 9a's
`writeDaemonRecord`, which is what 9b will call) and the phone's claim
(`claimPairing`, which is what 9c's handler calls). Its header says so. After 9c
merges, that test is upgraded in place and the missing assertion —
*revoke closes a LIVE connection* — is added; it is 9b's property and 9b's
`ws-device-route` test owns it.

**Mutations run (each restored immediately; no git command is used —
`.tentacle/tmp/device-pairing-9d/mutate.sh` copies the file aside and restores
it; `git status` afterwards shows only this slice's own files).**

| # | Mutation | Test that caught it |
|---|---|---|
| M1 | loopback records emitted (no loopback filter) | `loopback > a loopback daemon contributes no address` |
| M2 | `::` not expanded as a wildcard | `wildcard binds > :: is the same every-interface bind` |
| M3 | scheme always `ws` | `explicit binds > tls decides wss` |
| M4 | dedup last-wins (reversed) | `--address > dedup keeps the FIRST occurrence` |
| M5 | invalid `--address` dropped silently | `--address > an address a phone cannot dial is REFUSED` |
| M6 | prompt prints the raw name | `the prompt > a control character in the name cannot reach the terminal` |
| M7 | every claim accepted (`if (false)`) | `the human's answer > N writes NO entry` |
| M8b | window never closed (`close()` neutered) | `the window's files > are gone when pair returns` |
| M9 | no-terminal claim auto-accepted | `the human's answer > with no terminal the claim is DECLINED` |
| M10 | `addDevice` result ignored | `a 'yes' that cannot be recorded > pairs nobody …` |
| M11 | expiry never fires | **hangs** (the poll loop never ends — a hang, not an assertion; not claimed as a kill) |
| M12 | raw device name in the table | `the table > a control character in a device name cannot reach the terminal` |
| M13 | last seen never read | `devices > prints the table … with last seen` |
| M14 | first-match on an ambiguous prefix | `resolveDevice > a prefix matching two devices is AMBIGUOUS` |
| M15 | `reset` keeps the devices | `reset > y gives a NEW key and an EMPTY registry` |
| M16 | reset without confirmation | `reset > needs a y: 'n' changes nothing` |
| M17 | unreadable registry read as empty | `reset > an unreadable registry is NOT wiped by a reset` |
| M18 | `kind()` unaware of `repeated` | `--address is a list` (3 cases) |
| M19 | `pair`/`devices` omitted from `cliMode` | `cliMode > pair and devices are commands, not prompts` (5 cases) |
| M20 | prompt drops the SAS | `the human's answer > the prompt carries the CLAIM's name and the SAS` |
| M21 | SAS printed ungrouped | the same test |

**Gate.** `bun run check` equivalent, per §4 and this task's own gate line:
`bunx tsc --noEmit` clean (exit 0); `bun run lint` → `biome check .` **1021
files, no fixes, 0 errors/warnings** (baseline clean, §6); `bun test` →
**7995 pass / 3 skip / 0 fail**, 7998 tests across 571 files (the three skips
are §6's opt-in live-k8s, live-docker and slow keepalive).
`packages/protocol/schema/protocol.json` is **unchanged** and needed no
regeneration: 9d adds no wire type, method or schema (`git status
packages/protocol/` is empty). No `protocol.d/` note either — nothing on the
wire changed, so `PROTOCOL_VERSION` must not move.

**Not verified here (one line each).** (a) That a revoke closes a **live**
device connection — 9b's `DeviceAuthority` poll owns it and is unmerged (above).
(b) That a real `serve` writes `daemons/<pid>.json` at listen and removes it at
stop, so `pair` finds real addresses without `--address` — 9b's
`cli/test/serve-devices.test.ts`; the format and the reader are 9a's and are
tested. (c) That the phone's `device/pair` accepts the code `pair` printed
end-to-end — 9c's; 9d's half (the window, the hash lookup, the claim and the
decision files) is exercised here. All three close when 9b and 9c merge, which
the plan orders before 9d.

### Fix round 1

*— claude-opus-5-5, 2026-11-13*

Scope: 9c's three MEDIUM findings only. Three source files, three test files;
9a's store, 9b's route/authority and 9d are untouched.

**F1 (MEDIUM) — the attempt cap did not stop requests that arrive together.**
*FIXED.*

Root cause, one sentence: `pair()` never checked the cap when it STARTS, and the
cap's close is deferred to a macrotask while `RpcPeer` dispatches concurrently
(§7), so every request already in flight when the fifth wrong code was answered
still ran `findPairing` + `claimPairing`.

Fix (`packages/daemon/src/pairing-handler.ts:126-140`): refuse at entry once
`attempts >= PAIRING_MAX_ATTEMPTS`, before any lookup, spending nothing.

Tests (red on the pre-fix code, on the assertion):
- `daemon/test/pairing-handler.test.ts` → *"requests PIPELINED past the cap are
  refused too, and cannot spend the window"* — five wrong codes and then the
  RIGHT one, none awaited between them: RED as
  `expected length 0, received 1` on the registry (the fake human's `accept`
  writes the registry unconditionally, so the surviving assertion is the CLAIM,
  plus the six reasons).
- `daemon/test/pairing-handler.test.ts` → *"a spent connection spends nothing
  more: no claim, no lookup, no count"* — after the cap, the correct code is
  refused with no claim written and `attemptCount` unchanged; the window is
  still usable by a NEW connection. RED as a 5 s timeout (the right code
  claimed and waited for a human who never came).
- `daemon/test/ws-device-route.test.ts` → *"requests PIPELINED past the cap
  cannot spend the window (F6/F16)"* — the same over a REAL socket: 8 wrong
  codes then the right one in one burst; reasons `invalid_code ×4`,
  `too_many_attempts ×5`, no claim. RED: the 9th answer was `invalid_code`
  (the right code had been claimed and the window consumed).

**F2 (MEDIUM) — the window watcher broke F3.** *FIXED.*

Root cause, one sentence: `watchPairingWindow` closed on "no live window" without
asking whether this connection was mid-answer, and `pair` removes its window
right after writing the registry, so the winning exchange's last moment has no
live window.

Fix: the handler exposes `holdingClaim` (`pairing-handler.ts:103-116`), set
around its wait (`pairing-handler.ts:176-190`, `try/finally` so a throw cannot
leave it on), and the watcher skips such a connection (`ws-server.ts:236-283`,
the callback wired at `ws-server.ts:506-515`). That connection then ends its own
wait (registry first, then the decision, then the expiry) and the next tick
closes the socket normally.

Test: `daemon/test/ws-device-route.test.ts` → *"a window that goes away right
after the human's `y` still answers SUCCESS (F3)"* — real socket, the watcher at
`PAIRING_POLL_MS / 5` (20 ms) against the handler's 100 ms poll, the human
writing the registry and then `closePairing` exactly as `pair`'s exit handler
does. RED on the pre-fix code as
`expect(answer).not.toBeInstanceOf(Error)` → *"Received value: 249 | return"*
(i.e. `connection closed`), reproduced 3/3 with the watcher skip mutated out and
5/5 green with it in.

**F3 (MEDIUM) — the client's `device/pair` timed out at 30 s; the window is 5
min.** *FIXED (the first of the Review's two options: no per-request deadline on
`device/pair`).*

Root cause, one sentence: one peer-wide `requestTimeoutMs` covered both
`initialize` and `device/pair`, so a human slower than 30 s failed the phone
while the terminal kept asking — and a later `y` registered a device that had
already reported failure.

Fix (`packages/client/src/pairing.ts:160-196`): the peer has NO peer-wide
deadline; `initialize` keeps its own (`requestTimeoutMs`, default 30 s) through
an `AbortController` + `unref`'d timer, cleared on every exit. `device/pair`'s
deadline is the daemon's (expiry → `timeout`, `N` → `declined`), and a dead
channel still rejects the pending request (`RpcPeer` rejects on close), so it is
not an unbounded wait. The doc comment on `PairDeviceOptions.requestTimeoutMs`
now says this explicitly.

Tests (`client/test/pairing.test.ts`, a new `humanAfter` fake that thinks for
`delayMs` before answering):
- *"a human slower than the request timeout still pairs (the window is 5 min,
  F3)"* — `requestTimeoutMs: 50` against a human who answers after 400 ms:
  pairs. RED pre-fix (2 fails).
- *"`device/pair` is the only request without a deadline: a refusal still
  arrives"* — same slow human saying `N`: `PairingRefused{declined}`, not a
  timeout. RED pre-fix.
- *"a daemon that accepts the socket and never answers `initialize` still fails
  fast"* — the counter-property: a real Noise responder whose peer answers
  nothing still errors in ~60 ms (`name === "cancelled"`). GREEN before and
  after (it guards the deadline I kept); M-F3b below is what proves it bites.

**Mutations (each applied with a scripted string replace, tested, restored from
a copy in `.tentacle/tmp/device-pairing-9c/mut/`; no
`git checkout`/`restore`/`stash`; `git status` afterwards shows only the six real
files).**

| # | Mutation | Result |
|---|---|---|
| M-F1a | handler entry gate disabled (`if (false && …)`) | RED, 2 fails: `pairing-handler` pipelined test + spent-connection test (5 s timeout) |
| M-F1b | the same, against the REAL-socket route test | RED, 1 fail: the 9th answer is `invalid_code`, not `too_many_attempts` |
| M-F2 | watcher's `holdingClaim` skip disabled (`if (false && …)`) | RED 3/3: `expect(answer).not.toBeInstanceOf(Error)` sees `connection closed` |
| M-F3a | peer-wide `requestTimeoutMs` restored on the pairing peer | RED, 2 fails: the slow-human success + the slow-human `declined` |
| M-F3b | `initialize`'s abort never fired (`setTimeout(() => {}, …)`) | RED: the silent-daemon test times out (5 s) — the deadline still bites |

**Drift from the Implementation (and why).**

- The Review's F3 offered "no per-request timeout on `device/pair`" OR "at least
  `PAIRING_TTL_MS` plus slack". I took the first: it is the option that cannot
  drift out of sync with `PAIRING_TTL_MS` (a slack constant would have to be kept
  equal to a daemon value the client does not import), and the daemon already
  answers `timeout` at the window's expiry, so the client needs no second
  deadline. The cost is that a pair of pathological stalls (the daemon alive,
  the human gone, the window's file unreachable so its expiry never fires) is
  bounded only by the socket, not by a client timer — acceptable, because the
  app's pairing screen can abort (`RpcPeer.close()` via its own cancel).
- The Review's F2 said "do not close a pairing connection whose handler holds a
  claim". Implemented as a `holdingClaim` getter read by the watcher, not as a
  claim-file check in the route: the claim file cannot distinguish "this peer
  holds it" from "another peer does", and closing the other peer's connection is
  the watcher's correct job.
- 9b's route test helper (`ws-device-route.test.ts` `serve`) gained a
  `pairingCheckMs` override option (it already spread `rest`, so only the
  `devices` merge changed). Test-only, no source change to 9b.

**Gate.** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit` clean ·
`bun run lint` 1047 files, no fixes applied (0 errors/0 warnings, §6 baseline) ·
`bun test` **8151 pass / 3 skip / 0 fail**, 8154 tests across 583 files, 315 s
(the 3 skips are §6's opt-ins). That is +7 tests over 9c's 8144: 2
`pairing-handler`, 2 `ws-device-route` (one pipelined-cap, one F3), 3
`client/pairing`. `packages/protocol/schema/protocol.json` unchanged (no wire
surface touched). No changelog fragment: this round fixes unreleased code on the
same branch, and 9c's fragment already describes the user-visible capability.

Run count, honestly: the gate was run **4 times in full** (3 × `bun test`, plus
`bun run check` typecheck → lint → test). Three were green; **one** reported
`8150 pass / 1 fail` and I did not capture the failing test's name before the
log was overwritten, so I cannot attribute it. What I can state: the three
narrow files repeated **12 times** (6 × the three together, 3 × `client/pairing`,
3 more inside the green full runs) never failed, and the three green full runs
came after that one. It is either the load-flaky `serve-log-store` S11 chain that
9c's own record names, or something I have not seen — verify with
`bun test 2>&1 | grep '(fail)'` on a loaded machine.

**Not verified here (one line each).**
- The 1 s watcher vs 100 ms poll timing is driven at 20 ms vs 100 ms in the F3
  test; the production ratio (10:1 the other way) is not reproduced as a timing
  measurement — that is 9c's own open note, unchanged.
- No real phone has paired, so F3's "the phone reports success" is proven
  against the real route and a fake human, not on hardware (9d's e2e is the
  first end-to-end).
Scope: the 9d Review's 1 HIGH + 2 MEDIUM (`docs/feat/device-pairing.md`, section
`### 9d — Review`). The two LOW nits are left (below). No 9b/9c file touched, no
wire/protocol change.

**Reproduced first, on the branch as it stood.**
`.tentacle/tmp/device-pairing-9d/r1/repro.test.ts`, driven at the real `main`
and the real `pairCommand`:

```
F1 HIGH:  machine v4: [ "192.168.1.6", "100.91.157.243" ], a live 0.0.0.0:7777
          record → code 1, out "", err "[error] no daemon this phone can reach:
          start one with `tentacle serve --host 0.0.0.0`…"
F2 MEDIUM: ttlMs 300, the human answers `y` after 600 ms → code 0, devices 1
F2b:       the same claim with an unanswered prompt → still pending at 1500 ms
```

**Findings.**

1. **HIGH — `0.0.0.0` never yields an address in the real CLI. FIXED.**
   Root cause: `pairAddressesOf` defaulted `interfaces` to `[]` and nothing in
   `packages/cli/src` read `os.networkInterfaces()`, so the Design's main path
   (wildcard → each non-internal IPv4) was dead in production while the unit
   tests injected `LAN`.
   - `packages/cli/src/pair.ts`: new `machineInterfaces()` (flattens Node's map
     of lists, keeps only the rule's three fields) and the default is now
     `options.interfaces ?? machineInterfaces()`.
   - Tests: `pair.test.ts` "the addresses of THIS machine" drives `pairCommand`
     with **no** `interfaces` and reads the expected addresses straight from
     `os` (not through the helper `pair` uses);
     `pair-dispatch.test.ts` "a wildcard serve record yields the machine's own
     addresses" goes through the real `main`, claims the window (asserting the
     claim happened, so it cannot pass vacuously) and asserts each real IPv4 is
     in the payload.

2. **MEDIUM — a `y` typed after the window expired still paired. FIXED.** Root
   cause: `answerClaim` had no expiry check and the prompt had no bound, so the
   registry could gain a device the daemon had already told `timeout`.
   - `pair.ts`: `answerClaim` takes `expiresAt` and refuses (decision `false`,
     exit 1) when `now >= expiresAt` at answer time; the question is raced
     against a new `PairTimer` seam (`options.timer`, default a cancellable
     `setTimeout`) bounded by `expiresAt - now`, so a prompt nobody answers
     releases the terminal at the expiry instead of hanging.
   - New `expiredBeforeAnswer()` writes the DECLINE, so a daemon still waiting
     stops now rather than at expiry.
   - Tests: "the CLOCK alone refuses a late 'y', with a timer that never fires"
     (window 50 ms, answer at 250 ms, a timer that never fires ⇒ only the clock
     check can stop it) and "a prompt nobody answers does not hold pair past the
     window" (a claim, then an `ask` that never resolves).

3. **MEDIUM — the F3 ordering was not pinned and the coverage claim was false.
   FIXED.** Root cause: both writes are synchronous and the window is deleted on
   the way out, so nothing outside could observe their order.
   - `pair.ts`: new injected `PairWrites` seam (`options.writes`, default 9a's
     `addDevice`/`writePairingDecision` for this window); `answerClaim` goes
     through it.
   - `pair.test.ts` "the registry holds the key BEFORE the decision is written":
     the `decide` write reads the registry and asserts the accepted key is
     already in it (the property, not just the call order).
   - The false header claim (`pair.test.ts`) is corrected: it now says which
     test pins F3 and that the seam is why it can.

**One more defect, found by the full-suite gate (not in the Review). FIXED.**
My new dispatch test made the full suite exit **130** (SIGINT) with no test
output. Cause: `pair` installed its F2 `exit`/SIGINT/SIGTERM hooks and never
removed them, so a *finished* `pair` left them in the process; another test
(`output-streams.test.ts:206`) does `process.emit("SIGINT")`, which ran a
cleanup for a window that was long gone and then `removeAllListeners` +
`process.kill(process.pid, "SIGINT")` — killing the runner. The bug was latent:
no test had driven `main` past `openPairing` before.
- `pair.ts`: `exitHooks` may now return a disposer; `pair` calls it in the same
  `finally` that closes the window.
- `main.ts`: the hook returns a disposer that removes exactly the three
  handlers it added, and the signal handler removes only its OWN listener
  instead of `removeAllListeners(signal)` (the host may legitimately own
  others — a TUI's terminal restore, another task's exit net).
- Test: `pair-dispatch.test.ts` "a returned pair leaves NO signal listener
  behind" (and this is why the whole suite was passing before with no test
  covering it).
- Also moved the hook registration INSIDE `pair`'s `try`: a hook that throws now
  still closes the window it was given, instead of leaving a live window behind
  a thrown error.

**Drift from the Implementation (and why).** Additive, three new seams, all
optional and all defaulted to production behaviour: `options.timer`,
`options.writes`, and `exitHooks`'s return value. The Implementation's Design is
unchanged; the Review asked for the behaviours, not the mechanism. No plan step
contradicted the code. `pair-addresses.ts` needed no change: the rule was right,
only its input default was wrong — the bug was in the wiring, so it is fixed
there.

**Mutations** (each applied to `packages/cli/src/pair.ts` with a scratch script,
run against `pair.test.ts` + `pair-dispatch.test.ts`, restored immediately; no
git command used, and `git status` afterwards shows only this round's five
files):

| # | Mutation | Test that caught it |
|---|---|---|
| M1 | `interfaces` default back to `[]` (finding 1) | "a wildcard record expands to the real interfaces…" **and** "a wildcard serve record yields the machine's own addresses" → 2 fail |
| M2 | drop `io.now() >= expiresAt` at answer time (finding 2, the clock guard) | "the CLOCK alone refuses a late 'y', with a timer that never fires" → 1 fail |
| M3 | `await io.ask(...)` unbounded, no timer (finding 2, the hang) | "a prompt nobody answers does not hold pair past the window" → 1 fail (at its 5 s race) |
| M4 | write the decision BEFORE the registry (finding 3, the F3 swap) | "the registry holds the key BEFORE the decision is written" → 1 fail |
| M5 | drop `dispose?.()` (the listener leak) | "a returned pair leaves NO signal listener behind" → 1 fail |

Two intermediate mutations **survived** and were fixed rather than claimed:

- M3 first survived because my hang test never claimed the window, so it never
  reached the prompt (vacuous). The test now claims it and asserts `claimed`.
- M2 first survived because with the real timer the timer wins the race, so the
  clock check was unreachable in that test. That test also proves the *bound*,
  not the clock guard, so a second test pins the clock alone (M2's row above).
  The production code still keeps both: the clock check is what closes the
  window between the answer arriving and the registry write.

An unnecessary `options.clock` seam I added mid-round was removed once the two
guards were properly separated (a test-only seam with no production user is
ceremony).

**Gate.** `bunx tsc --noEmit` clean; `bun run lint` → `biome check .` 1021
files, **0 errors/warnings** (baseline clean, §6); `bun test` → see the gate
line at the end of this section. `packages/protocol/schema/protocol.json` is
untouched and needs no regeneration (no wire change; no `protocol.d/` note
either). No changelog fragment is added by this round: it fixes a feature that
is not on `main` yet, and `changelog.d/device-pairing-9d.added.md` already
describes the (now correct) user-visible behaviour — a "fixed" fragment would
announce a bug no released version ever had.

**LOW nits, deliberately left** (out of this round's HIGH/MEDIUM scope):
- The Review's 9a nit N1 (`writeRegistry`'s id/key guard has no test) is 9a's
  file, not on this slice's change set.
- 9d's nit: `devicesCommand` advises `devices reset` for an unreadable registry,
  but `resetCommand` refuses exactly that. Still open; it is a wording/behaviour
  mismatch in an error path, and the Review rated it LOW.

**Not verified here (one line).** Whether the new bounded prompt behaves well
on a real terminal — `askLine`'s `readline` keeps stdin open after `pair`
returns; the prompter is detached, not destroyed, so a keystroke typed after the
expiry is discarded by readline, not by us. The seam tests cover the logic; a
manual `tentacle pair` on a TTY is the check.

**Gate line:** `bunx tsc --noEmit` clean · `bun run lint` 1021 files, 0
errors/warnings · `bun test` **8002 pass / 3 skip / 0 fail**, 8005 tests across 571 files (the three §6
opt-in skips).

## Review

#### Owner answers (2026-11-13)

All questions answered as recommended. Implementation APPROVED.

### 9a `device-registry` — Review

*— claude-opus-5-5, 2026-11-13*

**Verdict: APPROVE-WITH-NITS (PASS: no HIGH/MEDIUM).** Scope: `git diff main...HEAD`, slice 9a only.

**Gate (re-run).** The 3 touched test files: 51 pass, 0 fail. `bun run lint`: 968 files, clean. `bun run typecheck`: clean. I did not re-run the full `bun test`.

**Premises.** P4 TRUE (`workspace-mount.ts:709` always hides `configDir`). The P8 lock pattern is TRUE: the code mirrors `session-persister.ts:642-690`.

**Mutations** (each applied with Edit, reverted, `git status` empty afterwards):
- `sameHash` always true → caught (`finds a live window by code and not by a wrong one`).
- `writeRegistry`'s id/key guard (`device-store.ts:513-517`) disabled → **survives**: no test covers it.

**Attacks tried:**
1. Concurrent `addDevice` from 8 processes × 20 rounds → no lost entry.
2. The same, starting from a stale dead-pid lock → no lost entry.
3. An unreadable identity or registry under create/write → refused, bytes unchanged. `link` EEXIST also protects the identity when the `missing` check is skipped.
4. The SAS byte order and domain prefix match the Design. The base64url decoder rejects non-canonical forms.

**Nits (LOW, not blocking):**
- N1: add a test for the `writeRegistry` id/key guard (the surviving mutation above).
- N2: `acquireRegistryLock` (`device-store.ts:452-474`) reads a just-created, still-empty lock as pid 0, which counts as stale. That is a theoretical double-holder (F13), not reproduced in 40 rounds. The same window exists in the prior-art store lock.
- N3 (constraint for 9b/9c): `findPairing` sweeps files (`:857`) and throws on a malformed code (`pairingCodeHash`, `:93`). So it must not back `authorize` (P2: no side effects). 9b needs a side-effect-free "any live window" read, which 9a does not export. 9c must catch the throw on peer input.

**Executor behaviour.** Drift is documented honestly, and the mutation table is accurate for the cases I checked. One discrepancy: commit `11dfe31` says "exec (deepseek)", but Execution is signed claude-opus-5-5. The owner should fix whichever one is wrong (§10 honest signing). This reviewer is claude-opus-5-5. If that signature is correct, this was the same model in a fresh context, so shared blind spots are possible.

### 9b `device-route` — Review

*— claude-opus-5-5, 2026-11-13*

**Verdict: REQUEST-CHANGES** (one MEDIUM finding; it has a repro).

**Findings**
1. **MEDIUM — the no-identity path leaks a handshake slot for good.** `ws-server.ts:361-367`: when `staticKey()` is `undefined`, `pending.get(ws)?.()` runs *before* `pending.set` (`:376`). So `finish` is never registered, and the `close` handler (`:338`) finds nothing to call either. Each such socket keeps `limiter.begin`'s concurrent slot forever. Repro (`.tentacle/tmp/device-pairing-9b/leak.ts`): an authority with no identity and `maxConcurrent: 2`, four dials → `open, open, close 1002, close 1002`. After `maxConcurrent` (32) dials during any F14 window (unreadable identity, or the gap in a `devices reset` rewrite), `/e2e` answers 429 to everyone until a restart, even once the store is fixed. That contradicts the authority-level "recovers, no sticky denial" property. Fix: call `limiter?.end()` directly on this path. Test: a route test with no identity dials past `maxConcurrent`, then writes an identity and gets a successful handshake (red today).
2. **MEDIUM — F26 is applied to every bind, not only to non-loopback ones (undocumented drift).** `serve.ts:173` + `deviceAuthority` (`:99-112`): `devices` is on by default. An unusable `identity.json` therefore makes a plain loopback `serve` refuse to start, even for a user who never pairs. The plan scopes F26 to "non-loopback bind without token". Execution's drift list does not mention this. Either scope the throw to F26's own case (on loopback, warn and start without the device route), or record the decision as drift and get the owner's OK.

**Gate.** Touched files: 149 pass / 0 fail (7 files). `bun run lint`: clean. `bun run typecheck`: clean. I did not re-run the full `bun test` here.

**Mutation (all reverted; `git status` clean afterwards).** I applied four mutations together: skip the pairing method gate, ignore the verdict cap (`readVerdict` → fallback), drop `authorize`'s stat-refresh, and the poll not closing. Result: 12 fails across the route, authority and noise tests. Each mutation is caught by its named test.

**Attacks tried.** (a) Limiter balance on every `openDevice` exit → finding 1. (b) A pairing principal reaching a session via notifications: `session/cancel` needs an attached session, which is unreachable → holds. (c) A revoke racing `authorize`'s refresh before the poll: the poll compares the live map with the current snapshot (not a diff), so it still closes → holds. (d) A `devices reset` refreshed by `authorize` before the tick: `reset` reads false, but the empty registry closes everything anyway → holds, as long as the CLI empties the registry (9d must keep that). (e) F21: without `devices`, `/e2e` is the plain route → holds (test). (f) Same session path: `Connection` is unchanged on the secure channel, and no second loop → holds.

**Executor behaviour.** The scope is tight, the tests are non-vacuous, and the drift notes are honest except for finding 2. The executor was DeepSeek and this reviewer is Opus, a different model family.
### 9d `device-cli` — Review

*— claude-opus-5-5, 2026-11-13*

**Verdict: REQUEST-CHANGES** (1 HIGH, 2 MEDIUM). Scope: `git diff main...HEAD`, slice 9d only.

**Gate (re-run).** The 5 touched test files: 73 pass, 0 fail. `bun run lint`: 1021 files, clean. `bun run typecheck`: clean. I did not re-run the full `bun test`.

**Findings.**
1. **HIGH: a `0.0.0.0` serve never yields an address in the real CLI.** `pair.ts:126` defaults `interfaces` to `[]`. `main.ts:174-197` (`runDeviceCommands`) never passes them, and nothing in `packages/cli/src` calls `os.networkInterfaces()`. So the Design's main path (wildcard → each non-internal IPv4) is dead in production.
   - Repro (`.tentacle/tmp/device-pairing-9d/review/wildcard.test.ts`, real `main`): a live `0.0.0.0:7777` daemon record on a machine with `192.168.1.6` and `100.91.157.243` gives exit 1 and `[error] no daemon this phone can reach: start one with \`tentacle serve --host 0.0.0.0\`…`. That hint is the very configuration that was already running.
   - The unit tests inject `LAN`, and `pair-e2e.test.ts:124-125` wrongly comments that the `0.0.0.0` record "contributes this machine's interfaces". The test passes only because of `--address`.
   - Fix: default to a flattened `os.networkInterfaces()` in `pairCommand`/`main`, and add a dispatch test that does not inject interfaces.
2. **MEDIUM: a `y` typed after the window expired still pairs the device.** `answerClaim` (`pair.ts:282-322`) has no expiry check, and `ask` has no timeout. The plan's F-table says "`N` / timeout / Ctrl+C → decision declined", and 9c's daemon answers the phone `timeout` at expiry.
   - Repro (`late-yes.test.ts`): `ttlMs: 300`, the claim lands, the human answers `y` after 600 ms. Result: exit 0, "Paired 'late'", and the registry holds 1 device the phone was told failed. A prompt left open also blocks `pair` forever.
   - Fix: refuse (decision `false`, exit 1) when `now >= expiresAt` at answer time, and bound the prompt by the window.
3. **MEDIUM: the F3 ordering is not pinned, though the test header says it is.** `pair.test.ts:15-16` claims "registry written BEFORE the decision (mutation: swap them)".
   - Mutation: write `writePairingDecision(sid, true)` before `addDevice` (`pair.ts:306`). `pair.test.ts` + `pair-e2e.test.ts` stay 20/20 green.
   - The ordering that `pair.ts:14-17` calls load-bearing has no test, and the coverage claim is false. Fix: a test whose decision write observes that the registry already holds the key (for example a failing `addDevice` must leave no `accepted: true`), then show it red under this mutation.

**Mutations** (each applied with Edit and reverted; `git status` empty afterwards):
- F3 swap: **survived** (finding 3).
- `renderDevices` raw name: caught (`the table > a control character …`).

**Attacks that found nothing:**
- `revoke` resolution: exact name first, an ambiguous match is refused, and a non-hex word never matches by prefix.
- `reset` order: read → replace identity → empty the registry. If the clear fails, the old devices stay listed but pinned a key that no longer exists.
- `--address` repeat parsing: the conflict and given-twice rules are intact for non-repeated flags.
- No wire/protocol change, and nothing writes to a terminal Ink owns. 9b/9c files are untouched.

**Nit (LOW):** `devicesCommand` (`devices-cmd.ts:148`) advises `devices reset` for an unreadable registry, but `resetCommand` (`:211-215`) refuses exactly that case. F14 lists reset as the way out. Align either the hint or the plan.

**Executor behaviour.**
- Execution's deferral of the live-connection assertion to 9b/9c is honest and justified.
- Its claim that every 9d seam is exercised end-to-end is not true: finding 1 hides behind `--address`.
- Signing: Execution is signed `claude-opus-4-5-20250929, 2026-11-14` (a future date), while commit `8efe2f2` says "exec (deepseek)". The owner should correct it (§10).
- This reviewer is claude-opus-5-5, in a fresh context.

### Round 2

*— claude-opus-5-5, 2026-11-13*

**Verdict: PASS.** Both round-1 findings are fixed. Diff checked: `c04bad1`.

- **Finding 1 (slot leak) — fixed.** `ws-server.ts:368` now calls `limiter?.end()` on the no-identity path. It cannot run twice for one socket: `pending` is not set yet, so the `close` handler finds nothing to end. Repro `leak.ts`: four dials now give `open ×4` (round 1: `open, open, close 1002, close 1002`). *Mutation:* removed `:368` → `a no-identity window gives every handshake slot back` turns red.
- **Finding 2 (F26 on every bind) — fixed.** `serve.ts:249` now throws only for a non-loopback bind without a token. In every other case `serve` starts without the device route, reports one `onError` line naming the file, and writes no daemon record. *Mutation:* changed the condition to `if (true)` → `an unusable identity on a LOOPBACK bind starts WITHOUT the device route` turns red. Both mutations reverted; `git status` clean.
- **Regressions.** Touched files: 112 pass / 0 fail. `bun run lint` clean; `bun run typecheck` clean. Case checked: token + non-loopback + broken identity → starts without `/e2e`, plain route still token-gated. Nothing widens access.

### 9c `device-pair-exchange` — Review

*— claude-opus-5-5, 2026-11-13* (fresh context; same model family as parts of the plan — shared blind spots possible)

**Verdict: REQUEST-CHANGES.** Gate: touched files 83 pass / 0 fail (5 files); `bun run lint` clean (1047 files); `bun run typecheck` clean. Full `bun test` was not re-run here. Mutation: `waitForDecision`'s accepted-without-registry branch forced to `ok` → 2 handler tests turn red. Reverted from a copy; `git status` clean. Repros: `.tentacle/tmp/device-pairing-9c/rev/{cap,f3}.ts`.

1. **MEDIUM — the attempt cap does not stop requests that arrive together** (`pairing-handler.ts:110-125`, `:233-246`). `pair()` never checks `attempts >= PAIRING_MAX_ATTEMPTS` when it starts. The close is deferred to a macrotask, and `RpcPeer` dispatches requests concurrently. So every request already queued before that close still runs `findPairing` + `claimPairing`. Repro `cap.ts`: 8 wrong codes then the right one, sent without awaiting → `attempts 8`, and **the window is claimed** by the 9th code. F6/F16 ("5 tries per connection") does not hold. Fix: refuse at entry once the cap is reached, with no lookup. Add a test that pipelines more than 5 requests.
2. **MEDIUM — the window watcher breaks F3** (`ws-server.ts:254-262`). The watcher closes the connection once no live window remains. It ignores a pending claim. `pair` writes registry → decision → removes the window on exit. If the 1 s watcher fires before the handler's 100 ms poll, the socket closes: the key IS registered, but `pairDevice` throws `connection closed`, not success. Repro `f3.ts` at the defaults (`pairingCheckMs` 1000): **2/40 and 1/20 trials registered-but-failed**. Fix: do not close a pairing connection whose handler holds a claim. The handler already ends its own wait on expiry or claim removal, after checking the registry first. Add a test for it.
3. **MEDIUM — the client's `device/pair` times out at 30 s; the window lasts 5 min** (`client/src/pairing.ts:73,158,177`; `PAIRING_TTL_MS` `device-store.ts:69`). A human who takes more than 30 s to answer `[y/N]` makes the phone fail with a timeout. The phone then closes the socket. The claim stays, so the terminal still asks, and a `y` registers a device whose phone reported failure. Fix: no per-request timeout on `device/pair` (let the daemon's expiry/`timeout` answer decide), or at least `PAIRING_TTL_MS` plus slack. Add a test.

**Holds:**
- The key comes from the channel (F18): params are strip objects with no key field.
- The 9b method gate is intact.
- `already_paired` is returned for token and device principals.
- A decision with no registry entry declines.
- `findPairing`'s throw is absorbed.
- The abort stops the wait.
- No lock on `Connection`: `device/pair` waits inside its own handler.
- Additive protocol (new method, new error code, strip schemas) → no bump, consistent with §7.

**Executor:** a thorough, honest record (a flake was reported, the drift was justified). The three findings are timing and limit interactions that the per-request tests drive at test speeds only.

### Round 2

*— claude-opus-5-5, 2026-11-14* (fresh context; diff checked: `d12af92`)

**Verdict: PASS.** All three round-1 findings are fixed. Each fix was checked by a mutation, and each mutation was reverted from a copy (`git status` clean).

- **Finding 1 (cap bypassed by pipelining) — fixed.** `pairing-handler.ts` now refuses at entry once `attempts >= PAIRING_MAX_ATTEMPTS`, with no lookup. *Mutation:* removed the entry check → 3 red (handler ×2, real socket ×1). The round-1 repro `cap.ts` now gives `attempts 5` and `claim exists: false`.
- **Finding 2 (watcher breaks F3) — fixed.** `watchPairingWindow` now skips a connection whose handler is waiting on a claim it holds (`holdingClaim`, set in a `try/finally` around the wait). *Mutation:* removed the skip → `a window that goes away right after the human's y still answers SUCCESS (F3)` turns red. The round-1 repro `f3.ts` at the 1 s default: **0/30** registered-but-failed (round 1: 2/40).
- **Finding 3 (30 s client deadline) — fixed.** The peer-wide timeout is gone. Only `initialize` keeps a deadline, through an `AbortSignal`. *Mutation:* put `requestTimeoutMs` back on the peer → 2 client tests turn red.
- **Regressions.** Touched files: 108 pass / 0 fail (6 files, incl. `device-authority`). `bun run lint` clean (1047 files). `bun run typecheck` clean. Full `bun test` not re-run.
- **Nits (not blocking).**
  - With a claim held, a SIGKILLed `pair` (window files left, pid dead) now keeps the pairing socket open until the window expires, at most 5 min. Before this fix the 1 s watcher closed it. The wait still ends, and the connection can reach nothing but `device/pair`.
  - `device/pair` has no client deadline. A daemon that never answers hangs the phone until the app cancels; the daemon's own expiry is the designed bound.
**Verdict: PASS (APPROVE-WITH-NITS).** Scope: `git diff HEAD~1` (`b493377`).

**Round-1 findings, each verified by mutation** (each applied with Edit and reverted; `git status` empty afterwards):

| # | Fix | Mutation | Caught by |
|---|---|---|---|
| 1 | `pairAddressesOf` defaults to `machineInterfaces()` (`pair.ts:195`) | back to `?? []` | `pair.test.ts` "a wildcard record expands to the real interfaces…" + `pair-dispatch.test.ts` "a wildcard serve record yields the machine's own addresses" (real `main`) |
| 2a | after the answer, `io.now() >= expiresAt` → declined | check removed | "the CLOCK alone refuses a late 'y'…" |
| 2b | the prompt races the window's timer | plain `await ask` | "a prompt nobody answers does not hold pair past the window" (hangs → fails at the timeout) |
| 3 | the `PairWrites` seam observes the order | `decide(true)` before `add` | "the registry holds the key BEFORE the decision is written" |

My round-1 repros now behave as fixed:
- `late-yes.test.ts` is green.
- `wildcard.test.ts` now publishes `192.168.1.6` / `100.91.157.243` and waits for a claim; before the fix it refused.

**Gate.**
- `bun run lint`: 1021 files, clean.
- `bun run typecheck`: clean.
- `bun test packages/cli/test/`: 2087 pass, 0 fail.
- I did not re-run the full suite.

**Regressions checked on the diff:**
- The exit-hook disposer drops only its own listeners, and `pairCommand`'s `finally` disposes them.
- A timer-won race leaves `askLine`'s readline open. That is harmless, because the bin calls `process.exit(await main(...))` (`main.ts:2085`).
- The default writes keep 9a's calls unchanged.

**Nit (LOW):** both finding-1 regression tests `return` early on a host with no non-internal IPv4 (`pair-dispatch.test.ts:194`, `pair.test.ts:431`). On such a CI runner they pass vacuously. A `test.skipIf` would make the skip visible.

The round-1 LOW nit (the `devices` hint vs. `reset` refusing an unreadable registry) is unaddressed. It is still LOW.
