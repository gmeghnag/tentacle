# feat/device-pairing — `tentacle pair`, per-computer device registry, `devices` / `revoke` (mobile task 9)

> **Status:** implementation (plan written, **not approved**)
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

## Review

#### Owner answers (2026-11-13)

All questions answered as recommended. Implementation APPROVED.
