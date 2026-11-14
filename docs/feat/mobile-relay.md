# feat/mobile-relay — relay service (`relay.tentacle.so`, configurable), daemon dial-out, deploy (mobile task 15)

> **Status:** implementation (plan written, **not approved** — see Owner questions)
> **Branch:** `feat/mobile-relay` (this doc). Slices R0–R7 run **in order on this branch**, one commit per slice on the owner's OK, each gated by its narrow tests (AGENTS §4); the full gate before Review.
> **Size:** L as a whole → split into S/M slices (table below) · **Blast:** load-bearing (device authentication path, a new network dial-out from every `serve`, a new persisted file) · **Suited:** per AGENTS §10 — R3, R4, R5a are `load-bearing` (strong executor + mandatory fresh-context Review red-teaming "a pod is not trusted", "one session path", "single broker"); R0, R1, R2, R5b, R6, R7 are `contained`/`cross-module` S–M. The owner assigns executors.
> **Changelog:** `changelog.d/mobile-relay.added.md` (R5a) — `- **Phones reach \`serve\` through a relay, end-to-end encrypted.** A \`serve\` with paired devices dials out to \`relay.tentacle.so\` (or \`relay.url\` / \`serve --relay\`; \`--no-relay\` to opt out), so a phone reaches it from anywhere with no open port; the relay sees only ciphertext. The relay is a small self-hostable service in \`apps/relay\`.`

## Context

*— claude-opus-5-5, 2026-11-14*

Mobile task 15 of `docs/eval/mobile-app.md` (decision 21, Phase 5). Today a
phone reaches a `serve` only over a direct path (LAN, Tailscale, an own domain
via `serve --address`). Away from those — cellular, a hotel Wi-Fi — the phone
cannot reach the computer at all. The relay is the default, zero-configuration
path that fixes that.

Binding decisions (linked, not copied):
- **Decision 2** — four paths, one security model; the relay is "a small
  open-source Bun service in the repo, self-hostable"; "the daemon dials OUT to
  the relay and registers; the relay assigns `wss://<relay>/d/<daemon-id>` and
  splices phone ↔ daemon bytes"; "the link addresses, it never authorises";
  E2E (Noise) on every path; the app tries direct first, relay as fallback; the
  same service later carries APNs push (task 16).
- **Decision 9** — hosted on the site's box (142.132.169.22) behind Caddy as
  `relay.tentacle.so`; the default URL is **ONE value**, overridable in the
  daemon's config; **the app hard-codes no domain** (it learns addresses from
  pairing and the daemon's announcement); dev and tests run the relay locally.
- **Decision 18** — same repo, same licence; no secret in the repo.
- **Decision 20** — logic in pure modules under `bun test`; Maestro E2E against
  a local relay is mandatory before merge.
- Task 8 (`docs/feat/e2e-channel.md`): Noise IK, `rs` pinned, confirm flight
  (a replayed message 1 builds nothing), strict counters, frames `t1:` + base64,
  inbound text > `3 + 87 380` chars refused.
- Task 9 (`docs/feat/device-pairing.md`): `/e2e` device route, per-device key,
  revoke closes live sockets, `pair` QR addresses "a relay URL fits later,
  task 15" (`:357`), owner Q5 "laptop `connect` over device keys — revisit with
  the relay".
- Task 10 (`docs/feat/sibling-discovery.md`): the daemon announces its
  addresses on every connect; F7 names the relay as the answer to "every
  address changed while the phone was away".

**Trust.** The relay is **not trusted**, in the spirit of AGENTS §7 "a pod is
not trusted": it may read, drop, delay, reorder, replay, inject or forge
anything it carries, and may lie on its control channel. It must never be able
to read or drive a session, impersonate a computer to a phone, or make the
daemon record false state. What it can always do — refuse service, observe
metadata (which daemon id, phone IP, sizes, timing) — is accepted by decision 2,
and mitigated by the direct paths staying available.

**Deploy is NOT part of execution.** R7 writes the runbook and deploy files in
the repo; running them on the owner's server is a separate, owner-approved step
(**D**, below), never done by an executor.

**Repro (2026-11-14): the capability is missing; the app already accepts a relay address.**
From `.tentacle/tmp/mobile-relay/` (`probe.ts`, run from the worktree):

```ts
import { isPairingAddress } from "../../worktrees/mobile-relay/packages/protocol/src/index.ts";
for (const a of [
  "wss://relay.tentacle.so/d/AbCdEfGhIjKlMnOpQrStUv/e2e",
  "ws://127.0.0.1:4100/d/x/e2e",
  "wss://relay.tentacle.so/d/x",
]) {
  console.log(a, isPairingAddress(a));
}
```

```
$ bun .tentacle/tmp/mobile-relay/probe.ts
wss://relay.tentacle.so/d/AbCdEfGhIjKlMnOpQrStUv/e2e true
ws://127.0.0.1:4100/d/x/e2e true
wss://relay.tentacle.so/d/x false
$ rg -il relay packages/protocol/src packages/daemon/src/ws-server.ts packages/transport/src apps/mobile/src
packages/protocol/src/pairing.ts      # only the comment at :15 ("a later task can add one (a relay address")
$ ls apps
mobile
```

No relay service, no dial-out, no relay schema exist. An address of the shape
`<relay>/d/<id>/e2e` already passes the QR/announcement validator, so an
installed app (11b+) can dial a relay address with **no app update**.

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

**A phone stream carried by the relay can enter the daemon's EXISTING device
path unchanged — the Noise responder and `Connection` need only a closable
`DuplexChannel` — and the app dials a relay address exactly like any other.**
If this holds, the relay is "one more transport" (AGENTS §7 one session path):
no second auth path, no second session path, no protocol change.

Proof, daemon side:
- `DuplexChannel` is four methods and nothing else (`packages/transport/src/channel.ts:9-18`).
- `openDevice(ws, channel, route)` (`packages/daemon/src/ws-server.ts:408`) uses
  the Bun socket `ws` **only as an identity key / slot**: `pending.set(ws, …)`
  (`:437`), `connections.set(ws, connection)` (`:486`), `ws.data.release = …`
  (`:526`). Everything that authenticates or builds state takes the channel:
  `noiseResponder(channel, …)` (`:444`), `new Connection(secure, …)` (`:482`),
  `authority.register(verdict.id, handle)` with a handle that closes the
  channel (`:497`), and the F22 race check `channel.isClosed()` (`:520`).
  So extracting the body into `acceptDevice(channel, …)` that returns its
  teardown is a refactor, not a redesign — and the existing ws-server tests
  are its proof (they must pass unchanged).
- The rate limiter is keyed by a string (`limiter.begin(address)`, `:340`), so a
  relay stream can be charged under its own key.

Proof, app side:
- `isPairingAddress` accepts any `ws(s)` URL with a host whose path ends in
  `/e2e` (`packages/protocol/src/pairing.ts:122-131`) — the Repro above shows
  `wss://relay.tentacle.so/d/<id>/e2e` passes, so it rides the QR (`:228`) and
  the announcement (`packages/protocol/src/daemon.ts:92`).
- `openComputer` dials `computer.addresses` in order through `firstAnswering`
  then the Noise initiator pinned to the stored computer key
  (`apps/mobile/src/connection.ts:277`, `:253-266`). A relay URL is just
  another entry; `rs` pinning means a relay that routes elsewhere fails the
  handshake.

The ONE piece of the assumption that is NOT yet proved by execution — that the
splice preserves frames 1:1 and closes both ends together under Bun — is R0's
first probe, blocking.

### Preconditions

- **One daemon per project store, under a lock**: `acquireStoreLock(dir)`
  (`packages/cli/src/serve.ts:202`) before `listen` (`:235`), `dir =
  daemonStoreDir(config)` = `<configDir>/daemon/<projectKey(cwd)>` (`:149`).
  So a per-project file in that dir has one writer — the relay secret lives
  there.
- **Only a `serve` on the user's host has a device route**: `startWsServer`'s
  `devices` is absent for a pod daemon and the in-process worker
  (`ws-server.ts:54-68`); discovery and the daemon record are created only when
  `devices` is present (`serve.ts:470`, `:495`). The relay link is wired at the
  same point, so a pod **never** dials a relay (AGENTS §7: pod daemons store
  nothing durable, and a pod-held relay identity would be pod-supplied).
- **Revoke closes a device's live sockets** via the handle registered at
  `ws-server.ts:497`; the authority polls the store every second
  (`packages/daemon/src/device-authority.ts:41`, `:142`). A relay stream gets the
  same handle → same revoke.
- **The Noise channel bounds inbound frames** (inbound text > `3 + 87 380`
  chars refused before decoding, `docs/feat/e2e-channel.md` Design "Sizes"),
  tolerates no injected/reordered/replayed frame (AEAD + strict counter; M12
  killed), and the responder resolves only after the confirm (replay of
  message 1 builds no `Connection`, device-pairing F4).
- **Addresses: the record already carries extra URLs** (`DaemonRecord.addresses`,
  `packages/daemon/src/device-store.ts:1054`), and discovery merges them AFTER
  the bind-derived ones (`packages/cli/src/discovery.ts:66-73`), so a relay
  address appended there is announced last = tried last.
- **Gap found while verifying (fixed in R5b):** `pair`'s QR does **not** include
  a record's `addresses` — `pairAddresses` uses only bind-derived URLs plus
  `pair --address` (`packages/cli/src/pair-addresses.ts:153`; `pair.ts:166-185`),
  although `serve.ts:111-117` says `serve --address` values go "into the
  daemon's record (so `pair`'s QR and its siblings see them)". Discovery does,
  the QR does not. With a loopback `serve` (the default `--host 127.0.0.1`,
  `cli/src/main.ts:1096`) the QR would then have no address at all and `pair`
  refuses — exactly the zero-configuration case the relay exists for.
- **Gap found while verifying (fixed in R6):** the app dials addresses
  **sequentially** with no per-address timeout (`apps/mobile/src/address-dial.ts:59-74`),
  and redials sit under the client's 15 s deadline
  (`packages/client/src/link-machine.ts:25`, cited by e2e-channel). On cellular a
  LAN address (`ws://192.168.x.y:4000/e2e`) can hang on TCP connect; the relay,
  last in the list, may then never be tried before the deadline. The relay
  fallback is only real if the app stops waiting on dead direct addresses.
- **Name collision:** `packages/cli/src/relay.ts` is already "the relay of a
  detached run" (a laptop process, `docs/feat/detached-relay.md`). The mobile
  relay is unrelated; code and docs say **"mobile relay"** / `apps/relay`, and
  daemon-side symbols are `relayLink*`, never bare `relay*` in `cli/src`
  (Owner Q2).
- **Protocol:** no RPC method or update changes → `PROTOCOL_VERSION` untouched,
  no `protocol.d/` note. The daemon ↔ relay control wire is a separate wire with
  its own `RELAY_PROTOCOL_VERSION` (R1).

### Design

**Shape (Owner Q3): one control socket per daemon + one data socket per phone
stream ("reverse accept").** No multiplexing inside a socket: each phone stream
is its own WebSocket at both legs, so backpressure, close and size limits are
per stream and come from Bun, and the daemon side of a stream is a plain
WebSocket the existing `acceptDevice` takes as a `DuplexChannel`.

```
phone ──wss /d/<id>/e2e──► relay ◄──wss /v1/daemon (control)── daemon
                             │   ──{t:"open",stream,ip}──────►
                             │◄──wss /v1/accept {t:"accept",stream}── daemon
                             └── splice text frames 1:1 ──────► acceptDevice(channel) → Noise → Connection
```

**1. Relay identity: self-certifying id (Owner Q4).** Each daemon holds a
32-byte random `secret` in `<daemonStoreDir>/relay.json`
(`{ "v": 1, "secret": "<b64url>" }`, mode 0600, created with O_EXCL under the
store lock). `id = b64url(SHA-256("tentacle-relay-id/1" ‖ secret))[0..22]`
(22 chars, 132 bits). The relay registers an id only from a socket that
presents a secret hashing to it, so:
- the relay is **stateless** (no account, no database; a restart loses nothing);
- nobody can squat or hijack an id without the secret (the id itself is public:
  it is in QRs, logs, announcements);
- the address is **computed locally** — `relayAddress(url, id) =
  <url>/d/<id>/e2e` — so `pair` and the record know it before any connection
  (drift from decision 2's "the relay assigns": same URL shape, but the daemon
  derives it and the relay only confirms it in `ready`).
- The secret is an address credential, **not** an authority: it grants
  "receive phone streams for this id", and every stream still needs the Noise
  handshake against the computer key. A leaked secret = an attacker can steal
  the relay address (DoS), never a session.
- One file per project → stable across restarts; a different `cwd` (another
  project's daemon) gets its own id (decision 2: "one address per daemon").

**2. Control wire (`@tentacle/protocol` `relay.ts`, zod, strip schemas).**
Text JSON frames, `t` discriminator; every frame validated on both ends.
- daemon → relay on `/v1/daemon`: first frame `{t:"hello", v:1, secret}` (in the
  frame, never in the URL: URLs reach access logs). Relay answers
  `{t:"ready", v:1, id}` or `{t:"error", code:"version"|"invalid"|"busy",
  supported:[1]}` then closes. The daemon checks `ready.id === relayIdOf(secret)`
  and drops the link on a mismatch (a lying relay).
- **Newest wins:** a second `hello` for a registered id replaces the old socket,
  which gets `{t:"replaced"}` and is closed (a restarted daemon must not wait
  for its predecessor's dead socket to time out).
- relay → daemon `{t:"open", stream, ip}`: `stream` = 128-bit random,
  single-use, expires 10 s; `ip` = the phone's address as the relay saw it
  (untrusted; used only as a rate-limit key).
- daemon → relay on `/v1/accept`: first frame `{t:"accept", v:1, stream}`;
  after that the socket is a raw splice leg. Unknown/expired stream → close.
- Liveness both ways: the relay server pings (Bun `idleTimeout` + pings, as
  `socketOptions` does for `serve`, `ws-server.ts:112`); the daemon also sends
  `{t:"ping"}` every 25 s on control and expects `{t:"pong"}` within 10 s, else
  reconnects (a Bun client may not notice a dead TCP path; the probe in R0
  decides if this is needed, and the slice keeps it only if it is).

**3. The relay service (`apps/relay`, Owner Q2).** A Bun service, no
persistence, no secret, config by flags/env (`--host`, `--port`, limits).
- Routes: `/v1/daemon`, `/v1/accept`, `/d/<id>/e2e` (phones: any `Origin`
  accepted — the relay authorises nothing), `/healthz` (200 + version, no
  counts), anything else 404.
- Phone dial for an id not registered: held up to **5 s** waiting for a
  registration (covers a daemon reconnect blip and the pairing race below),
  then closed `4404`. Phone frames received before `accept` are buffered up to
  64 KiB (a Noise message 1 is ~100 bytes), more → close.
- Splice: frames forwarded 1:1, text only; a frame > 96 KiB (the Noise cap is
  ~87.4 Ki chars) closes both legs; either leg closing closes the other;
  `closeOnBackpressureLimit` at 16 MiB per leg (the `serve` policy, 
  `ws-server.ts:43-52`: closed, the phone detaches and resyncs).
- Abuse limits (defaults, flags override): per phone IP 30 dials/min and 16
  concurrent; per id 64 concurrent streams; 10 000 registered ids; per IP 10
  `hello`/min. Pure decisions in `relay-core.ts`, unit-tested.
- Logging: one line per event with id prefix (8 chars), never secrets, never
  payload, never full stream tokens.
- Built for deploy with `bun build --compile` (as `scripts/build.ts` does for the
  CLI); R7.

**4. Daemon dial-out (`packages/daemon/src/relay-link.ts` + pure
`relay-link-policy.ts`).** Started in `listen` beside discovery
(`serve.ts:495`), only when `devices` is present and the relay is enabled.
- **When to dial (Owner Q1):** while the device store has ≥ 1 device **or** a
  live pairing window (read through the existing `DeviceAuthority` poll, a new
  read-only `wantsReachability()`); otherwise the link is idle and closed. A
  user who never pairs never contacts the relay.
- Backoff: 1 s → 60 s cap, full jitter; `error:"version"` → 1 h and one notice;
  `replaced` → 5 min and a notice ("another daemon took over this relay id —
  copied config dir?"). Pure policy, unit-tested with an injected clock.
- On `open`: `limiter.begin("relay:" + ip)` (the existing `HandshakeLimiter`,
  shared with the direct route so its `maxConcurrent` 32 bounds both); dial
  `/v1/accept`, wrap the Bun WebSocket in a closable `DuplexChannel`, call
  `acceptDevice(channel, …)`. The Noise handshake, verdict, `Connection`,
  revoke handle, "last seen", pairing window watcher are the direct route's,
  byte for byte.
- Audit (`options.onAudit`): `relay-ready <id8>`, `relay-down <reason>`,
  `relay-open`, `relay-accept-failed`, `relay-replaced`; the rest is the device
  path's own lines.
- Stop: `listen`'s `stop` closes control + every accept socket before the
  record is removed.

**5. Config, CLI, record, QR.**
- ONE default: `DEFAULT_RELAY_URL = "wss://relay.tentacle.so"` in
  `@tentacle/protocol` `relay.ts` — the only place the domain appears in code
  (decision 9). Config keys `relay.enabled` (default `true`) and `relay.url`
  (default that constant), documented in `key-docs.ts`; flags `serve --relay
  <url>` / `serve --no-relay`. `relay.url` must be `wss://`, or `ws://` to a
  loopback host only (dev/tests: the secret must never cross a network in
  clear); anything else refuses to start with the reason.
- The relay address is appended **last** to the record's `addresses`
  (`serve.ts:478`) when the relay is enabled (whether or not it is connected
  yet: it is deterministic). Discovery then announces it last.
- R5b: `pair` includes each live record's `addresses` after its bind-derived
  ones (fixing the gap), so a loopback `serve` pairs with a QR holding only the
  relay address; order stays "direct first, relay last"; the 8-address cap stays
  a refusal, never a truncation.
- **Pairing race:** `pair` opens a window → within one authority poll (≤ 1 s)
  the daemon starts dialling → the relay holds the phone's dial up to 5 s for
  the registration. Enough on a normal network; on a slow one the phone's
  pairing attempt fails and the user taps Retry (the code is single-use only
  once claimed).
- **Rotation (Owner Q5):** `tentacle devices reset` (new computer identity)
  also deletes every `relay.json` under `<configDir>/daemon/*/`; running
  daemons pick a new id on their next start (the reset already says
  "restart serve"; R5b verifies the exact wording). Every phone must re-pair
  after a reset anyway, so a new address costs nothing extra.

**6. App (R6, `apps/mobile`).** No domain, no relay-specific code path.
- `firstAnswering` becomes a **staggered race to socket-open** (Owner Q6,
  "happy eyeballs", RFC 8305 style): start address *i*; if its socket has not
  opened after `STAGGER_MS = 750`, also start *i+1*, and so on; the first socket
  to OPEN proceeds to the Noise handshake; the others are closed before any
  handshake (so a losing relay leg leaves no daemon state: its stream closes
  pre-handshake and frees its limiter slot). A non-terminal handshake failure
  on the winner continues with the rest; `unauthorized` still stops everything;
  `lastGood` still picks the start. Pure, with an injected timer.
- `link-diagnosis.ts:99` text names the relay ("…same network, Tailscale, or
  the relay?").
- Background/kill: unchanged — the foreground gate closes the socket on
  background (`apps/mobile/src/foreground-gate.ts`), the relay closes the
  daemon leg, the `Connection` closes, the session detaches (decision 4); on
  resume the redial takes the race.

### Slices

| id | scope | files | Size | Blast | deps |
|---|---|---|---|---|---|
| **R0** | Step 0 probes (blocking, scratch only, results pasted into Execution): **(a)** Bun splice: two `Bun.serve` legs + a Bun WebSocket client per leg, frames 1:1 incl. an 87 KiB frame, close on one leg closes the other within 100 ms; **(b)** Bun WebSocket *client* receiving a 64 MiB frame from a hostile server — memory/behaviour (decides whether `relay-link` needs its own inbound guard); **(c)** dead control socket (server stops answering, TCP kept) — does the Bun client fire `close`, and when (decides the app-level ping) | `.tentacle/tmp/mobile-relay/*` only | S | contained | — |
| **R1** | Relay wire + id: `RELAY_PROTOCOL_VERSION`, `DEFAULT_RELAY_URL`, control frame schemas, `relayAddress(url,id)`, `isRelayUrl` (wss, or ws loopback); `relayIdOf(secret)` on `@noble/hashes` in transport's crypto subpath | `packages/protocol/src/relay.ts` (new), `packages/protocol/src/index.ts`, `packages/transport/src/relay-id.ts` (new), `packages/transport/src/noise-channel.ts` (re-export) or a new `./relay-id` export in `packages/transport/package.json`, tests `packages/protocol/test/relay.test.ts`, `packages/transport/test/relay-id.test.ts` | S | contained | R0 |
| **R2** | The relay service: pure `relay-core.ts` (registry, newest-wins, stream tokens + expiry, hold-for-registration, limits) + thin `server.ts` (Bun.serve, routes, splice) + `main.ts` (flags/env) | `apps/relay/{package.json,tsconfig.json}`, `apps/relay/src/{relay-core.ts,server.ts,main.ts}`, `apps/relay/test/{relay-core.test.ts,server.test.ts}`, root `package.json` (`typecheck` += `tsc -p apps/relay --noEmit`), AGENTS §6 package/app count (one line, rides this branch) | M | contained | R1 |
| **R3** | Extract the device path: `acceptDevice(channel, deps) → { release }` from `openDevice`; ws-server calls it; **no behaviour change** (every existing ws-server/device test passes untouched) + one new test driving `acceptDevice` on a `createChannelPair` channel | `packages/daemon/src/device-accept.ts` (new), `packages/daemon/src/ws-server.ts`, `packages/daemon/src/index.ts`, `packages/daemon/test/device-accept.test.ts` | M | **load-bearing** | — (may run after R0) |
| **R4** | Daemon dial-out: `relay-link-policy.ts` (pure: backoff, jitter, version/replaced holds, ping deadline) + `relay-link.ts` (control socket, hello/ready check, open → accept → `acceptDevice`, limiter key, audit, stop); `DeviceAuthority.wantsReachability()` | `packages/daemon/src/relay-link-policy.ts`, `packages/daemon/src/relay-link.ts`, `packages/daemon/src/device-authority.ts`, `packages/daemon/src/index.ts`, tests `packages/daemon/test/relay-link-policy.test.ts`, `packages/daemon/test/relay-link.test.ts` (against R2's real server on `127.0.0.1:0` + a fake hostile relay) | M | **load-bearing** | R1, R2, R3 |
| **R5a** | `serve` wiring: config keys `relay.enabled`/`relay.url` + docs, flags `--relay`/`--no-relay`, URL validation, `relay.json` (create O_EXCL 0600 / read / unknown `v` → relay off + notice, file untouched), relay address appended last to the record, start/stop the link in `listen`; changelog fragment | `packages/config/src/{schema.ts,defaults.ts,key-docs.ts,resolve.ts}`, `packages/cli/src/serve.ts`, `packages/cli/src/relay-secret.ts` (new; name keeps clear of `cli/src/relay.ts`), `packages/cli/src/main.ts` (flags + usage), tests `packages/cli/test/relay-secret.test.ts`, `packages/cli/test/serve-relay.test.ts`, `changelog.d/mobile-relay.added.md` | M | **load-bearing** | R4 |
| **R5b** | `pair` QR includes record `addresses` (direct first, relay last; cap = refusal); `devices reset` deletes `relay.json` files + its message | `packages/cli/src/pair.ts`, `packages/cli/src/pair-addresses.ts`, `packages/cli/src/devices-cmd.ts`, tests in `packages/cli/test/pair*.test.ts`, `packages/cli/test/devices-cmd.test.ts` | S | cross-module | R5a |
| **R6** | App: staggered race in `address-dial.ts` (+ its caller), diagnosis text; Maestro flow "relay only" (loopback `serve` + local relay ⇒ QR carries only the relay address) | `apps/mobile/src/address-dial.ts`, `apps/mobile/src/connection.ts`, `apps/mobile/src/link-diagnosis.ts`, `apps/mobile/test/address-dial.test.ts`, `apps/mobile/e2e/flows/relay-only.yaml` (new), `apps/mobile/e2e/run.ts` (start the local relay) | M | contained | R2, R5b |
| **R7** | Deploy artefacts + runbook, **not applied**: compile script, systemd unit, Caddy site block, runbook with rollback | `apps/relay/deploy/{relay.service,Caddyfile.relay,build.ts}`, `docs/ops/relay-deploy.md` (new) | S | contained | R2 |
| **D** | **Owner-approved deploy** (not an executor slice): run R7's runbook on 142.132.169.22 | none in repo | — | production | R0–R7 merged + owner OK |

R3 has no code dependency on R1/R2 and may run right after R0; the table order
is the recommended serial order: R0 → R1 → R2 → R3 → R4 → R5a → R5b → R6 → R7.

**R7 / D contents (planned, not done).** Build: `bun build --compile
apps/relay/src/main.ts --outfile tentacle-relay` (linux-x64). Host: a `relay`
system user, binary at `/opt/tentacle-relay/`, systemd unit listening on
`127.0.0.1:4100` (`Restart=always`, `NoNewPrivileges`, `ProtectSystem=strict`,
`MemoryMax=512M`). Caddy: `relay.tentacle.so { reverse_proxy 127.0.0.1:4100 {
stream_close_delay 5m } }` — without `stream_close_delay` every Caddy reload
cuts every relay socket. DNS: an `A` record `relay.tentacle.so →
142.132.169.22` (a later move = a DNS change, decision 9). Smoke test:
`curl https://relay.tentacle.so/healthz`, then a real `serve --relay
wss://relay.tentacle.so` + phone over cellular. Rollback: stop the unit — daemons
back off, direct paths unaffected. The owner performs or explicitly authorises
each step; no executor touches the server, DNS or Caddy.

### Failure modes

| # | Case | Behaviour → how state converges |
|---|---|---|
| F1 | **Phone loses network** mid-session | Phone leg drops → relay closes the daemon leg → `Connection` closes → session detaches (decision 4); a running turn continues. On return the app redials (race, F14) and re-attaches with the existing resync. |
| F2 | **Daemon loses network** | Control socket drops (or misses `pong`) → relay unregisters the id; established streams are independent sockets and die by their own pings. Daemon reconnects with backoff (1 s → 60 s, jitter); phones dialling meanwhile are held 5 s, then `4404` → the app tries other addresses / shows unreachable. |
| F3 | **Relay down / restarted** | Stateless: on restart every daemon re-registers (jittered — no thundering herd). Phones fall back to direct paths; with none, the diagnosis says unreachable. No state to lose or reconcile. |
| F4 | **Relay hostile: reads** | Sees only Noise ciphertext + metadata (id, IP, sizes, timing) — accepted (decision 2). |
| F5 | **Relay hostile: injects / modifies / reorders / replays frames** | AEAD with strict counters → the channel closes loudly (e2e M12). A replayed message 1 reaches `authorize` but no confirm → no `Connection`, no "last seen" (device-pairing F4). The phone redials. |
| F6 | **Relay hostile: routes the phone to another daemon / to itself** | `rs` pinned in the app → handshake fails → not `unauthorized` (an unauthenticated failure) → next address; never a session with the wrong peer. |
| F7 | **Relay hostile: lies on control** (wrong `ready.id`, bogus `open`, `open` floods, huge frames) | Wrong id → link dropped + notice. Bogus stream → accept fails → slot freed. Floods → `HandshakeLimiter` per `relay:<ip>` + `maxConcurrent` 32 shared with the direct route (a direct phone can still be starved by a flood — DoS is within the relay's power anyway, F4). Huge frames → bounded by R0(b)'s finding: if Bun's client buffers unboundedly, R4 adds a cap (closes the accept leg). |
| F8 | **Id squatting / hijack** by a third party | Needs a secret whose hash is the id — 132-bit preimage. Without it a `hello` for that id is impossible to craft. |
| F9 | **Relay secret leaked** (file read on the laptop) | Attacker can register the id (newest wins) → phones' relay dials reach the attacker → Noise fails (F6) → DoS of the relay path only; the real daemon gets `replaced`, notices, backs off 5 min. Recovery: `devices reset` (or delete `relay.json` + restart): new id, phones re-pair. |
| F10 | **Key rotation — computer identity** (`devices reset`) | Noise `denied`/fails for every phone → app says re-pair (existing 11b path); relay ids rotate too (Q5). |
| F11 | **Key rotation — device revoke** | The same handle closes the relay accept leg within the authority poll (≤ 1 s) → relay closes the phone leg. Next dial: `denied` → `unauthorized` → app stops retrying. |
| F12 | **Replay at the relay layer** (a captured `accept` or `hello`) | TLS protects both on the wire; a stream token is single-use and expires in 10 s; a replayed `hello` from a hostile relay is something the relay could do anyway (F4). |
| F13 | **Version skew** | Daemon ↔ relay: `hello.v`; unknown → `error:"version"` + `supported` → daemon notice once, retry in 1 h (no loop). Phone ↔ daemon: unchanged — Noise prologue `tentacle-e2e/1` + `initialize`'s clean `VersionMismatch` inside the channel. Old daemon + new app: no relay address, nothing changes. Old app (11b+) + relay address: dials it (Repro). The `/d/<id>/e2e` path is frozen across relay versions. Unknown `relay.json` `v` → relay off + notice, file untouched (AGENTS §7 on-disk rule). |
| F14 | **App killed / backgrounded** | Background → gate closes the socket → detach; kill → the OS closes it (or the relay's ping does, ≤ ~2 min) → detach; a pending approval stays pending on the daemon (decision 4). Mid-handshake kill → daemon `pending` → `finish` frees the limiter slot (`ws-server.ts:437`). On resume the race dials direct first, relay after 750 ms. |
| F15 | **Daemon restart** | Same `relay.json` → same id → same address; newest-wins replaces the dead process's stale socket at once. |
| F16 | **Two daemons with one secret** (config dir copied to another machine) | They take turns via `replaced`; each backs off 5 min with a notice naming the cause. Converges to "one wins for 5 min" — a loud flap, never silent. |
| F17 | **Pairing race** (window opened, daemon not yet registered) | Relay holds the phone 5 s; else the pairing attempt fails with "unreachable" and Retry works (the code is unclaimed). |
| F18 | **Backpressure** (frozen phone, 4 MiB replay burst) | `closeOnBackpressureLimit` 16 MiB per leg (same policy as `serve`) → closed → detach → resync on re-attach. |
| F19 | **Empty / invalid input** | Empty `relay.url` or non-loopback `ws://` → `serve` refuses with the reason; malformed control frame → schema rejects → close; empty phone frame → forwarded (Noise defines it). |
| F20 | **Pod / worker** | No device route → no relay link, no `relay.json` (Preconditions); pinned by a test. |

### §7 invariants touched

- **One session path:** the relay adds a transport (accept leg as a
  `DuplexChannel`) and nothing else; `acceptDevice` is the direct route's own
  code (R3 proves no behaviour change).
- **A pod / relay is not trusted:** every authenticating decision is on the
  laptop (Noise + device registry); the relay's control messages are input to
  validate, never authority.
- **Single broker:** unaffected (the device path builds the same `Connection`).
- **Don't serialize the RPC peer:** the link adds no lock around `Connection`.
- **Persistence:** `relay.json` is a new laptop-side file in the trusted
  `serve` store, versioned; never written by a pod.
- **Never write raw to the terminal while Ink owns it:** `serve` has no Ink;
  notices go through `options.onNotice`/`onError` as today.

### Tests

Red-first where a behaviour is new; each names its mutation (AGENTS §9).

Unit (`bun test`, in `bun run check`):
- **R1** `relayIdOf`: fixed vector (secret → id) pinned; domain separator
  changed → vector fails (mutation). `isRelayUrl`: wss ok, `ws://127.0.0.1` ok,
  `ws://relay.example` refused, http refused. Every control frame round-trips;
  extra fields stripped; unknown `t` rejected.
- **R2** `relay-core` (pure, injected clock/random): register; newest wins
  (old gets `replaced`); `hello` with a secret not matching → refused (mutation:
  skip the hash check → test fails); stream token single-use and expires at
  10 s; hold-for-registration releases on register and `4404`s at 5 s; each
  limit at its boundary (N ok, N+1 refused). `server.test.ts` on
  `127.0.0.1:0`: frames 1:1 both ways incl. an 87 KiB frame; a 97 KiB frame
  closes both legs; one leg closing closes the other; pre-accept buffer cap;
  `/healthz`; unknown route 404; logs contain no secret (grep the captured log
  for the secret).
- **R3** every existing `ws-server` / device / pairing test passes **unchanged**
  (that is the refactor's proof); new: `acceptDevice` on a `createChannelPair`
  channel admits a registered key, denies an unknown key, builds nothing on a
  replayed message 1 (mutation: build `Connection` before the confirm → fails),
  frees the limiter slot on close mid-handshake.
- **R4** policy: backoff sequence/caps with injected clock + random; version →
  1 h; replaced → 5 min; missed pong → reconnect. Link against R2's real server:
  a phone (`noiseInitiator` + `RemoteClient`) reaches a session THROUGH the
  relay and runs `session/list` (the end-to-end proof); revoke closes the relay
  stream within one poll; `ready` with a wrong id → link dropped (mutation:
  skip the check → fails); `wantsReachability() === false` → no socket opened.
  Fake hostile relay: flips a byte in a spliced frame → channel closes, no
  `Connection` survives; `open` flood → limiter refusals, daemon healthy.
- **R5a** `relay.json`: created 0600 once, reused on restart (same id), unknown
  `v` → relay off + notice + file bytes unchanged; `serve --no-relay` → no
  dial and no relay address in the record; `--relay ws://example.com` refused;
  the record's `addresses` ends with the relay address; a `serve` without
  devices (pod-like options) never dials (F20).
- **R5b** `pair` on a loopback record with a relay address → QR = [relay]
  (red on today's code: refused); direct before relay; 9 addresses → refusal;
  `devices reset` removes `relay.json` files.
- **R6** `address-dial` with an injected timer: a hanging first address does not
  block the second beyond 750 ms; losers are closed before any handshake;
  `unauthorized` still stops; `lastGood` honoured (mutation: start all at once
  → the "direct first" test fails).

Needs a real server or a real device (not in `bun test`; recorded in Execution
with dates):
- **Maestro (simulator, `bun run e2e:mobile`, mandatory before merge, R6):** pair
  and drive a session with a loopback `serve` + local relay on `ws://127.0.0.1`
  — the QR carries only the relay address, so the relay is the only path; plus
  "background → foreground re-attaches over the relay".
- **Real server (after D, owner-approved):** `wss://relay.tentacle.so` through
  Caddy with a public cert (ATS), phone `Origin` accepted, a Caddy reload does
  not cut live streams (`stream_close_delay`), an idle stream survives 30 min
  (NAT/proxy timeouts vs the 25 s ping).
- **Real iPhone (TestFlight checklist, decision 20):** on cellular with LAN
  addresses in the list — time-to-connect via the relay (target < 3 s; proves
  the race on the real network stack); Wi-Fi → cellular hand-off mid-session
  re-attaches; app killed with a pending approval, reopened hours later over
  the relay, Approve works.

### Owner questions

1. **Relay on by default, but dial only while ≥ 1 device is paired or a pairing
   window is open?** **Rec: yes** — decision 2's zero configuration, while a
   user who never pairs never contacts tentacle.so.
2. **The service lives in `apps/relay` (a deployable, like `apps/mobile`), and
   is always called "mobile relay" in code/docs** to keep clear of the
   detached-run relay (`cli/src/relay.ts`)? **Rec: yes.**
3. **Wire shape: one control socket per daemon + one data socket per phone
   stream (reverse accept), rather than multiplexing streams over one socket?**
   **Rec: yes** — per-stream backpressure/close/limits for free, no framing
   layer to get wrong; cost: one extra RTT per connect.
4. **Relay id = hash of a per-daemon secret (self-certifying, stateless relay,
   no accounts), address derived locally as `<relay>/d/<id>/e2e`?** **Rec:
   yes** — no database to run, nobody can squat an id; drift from "the relay
   assigns" in name only.
5. **`tentacle devices reset` also rotates the relay ids?** **Rec: yes** — one
   recovery verb for a leaked laptop, and phones must re-pair after a reset
   anyway.
6. **App dials with a staggered race (direct first, relay after 750 ms) instead
   of strictly in sequence?** **Rec: yes** — without it the relay fallback is
   not reached on cellular before the 15 s deadline (Preconditions gap).
7. **Laptop `connect` over the relay (device-pairing Q5's "revisit with the
   relay")?** **Rec: not in this task** — `connect` stays token/TLS; a later
   task if asked.
8. **Deploy (D): the owner runs R7's runbook (or explicitly authorises each
   step) after R0–R7 merge, before the first TestFlight build?** **Rec: yes** —
   no executor touches the server, DNS or Caddy.

## Execution

## Review
