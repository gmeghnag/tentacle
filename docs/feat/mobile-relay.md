# feat/mobile-relay — relay service (`relay.tentacle.so`, configurable), daemon dial-out, deploy (mobile task 15)

> **Status:** implementation APPROVED by the owner (2026-11-14)
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
  supported:[1]}` then closes. Those three are the codes THIS build knows
  (`RELAY_ERROR_CODES`); a `code` is a bounded string, not an enum, so a newer
  relay's new code is still a clean refusal rather than a "malformed frame"
  (Review R1 finding 1), and only `version` earns the 1 h backoff. The daemon
  checks `ready.id === relayIdOf(secret)`
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
| F7 | **Relay hostile: lies on control** (wrong `ready.id`, bogus `open`, `open` floods, huge frames) | Wrong id → link dropped + notice. Bogus stream → accept fails → slot freed. Floods → `HandshakeLimiter` per `relay:<ip>` + `maxConcurrent` 32 shared with the direct route (a direct phone can still be starved by a flood — DoS is within the relay's power anyway, F4). Huge frames → the memory bound is **OPEN**: R0(b) showed Bun materialises the frame before any handler runs, and a client constructor ignores `maxPayloadLength` (probed 1.4.3), so `isInboundFrameTooLarge` bounds the DECODE cost (JSON/zod, the channel copy) only, never the allocation. R4's fallback: accept it and back off after an oversize close, so a hostile relay cannot reconnect-loop us into the same allocation. |
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
  extra fields stripped; unknown `t` rejected. **Forward compat (Review R1
  finding 1):** a `ready` with a feature name this build does not know parses,
  and `knownRelayFeatures` drops it (mutation: enum restored → fails); an
  `error` with an unknown `code` parses as a refusal (mutation: enum restored →
  fails).
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

#### Owner decisions (2026-11-14)

All eight questions: the recommendation (owner: "Tutte come raccomandato").
**Amendment from task 16 (owner-approved, docs/feat/mobile-push.md Q6):** R1's
control `ready` frame carries a `features` field from the start (so a later
`push` frame never hits "unknown frame closes the control socket"), and R2/R7's
"the relay holds no secret" becomes "no secret except the APNs `.p8`, given to
the service via systemd credentials" (installed by the owner, task 16 D2).
Execution order: R0+R1 → R2 → R3 → R4 → R5a+R5b → R6 → R7, one review and a
merge per step. *— claude-opus-5-5 (orchestrator), 2026-11-14*

## Execution

### R0 + R1 (as built) — *— deepseek-v4 (deepseek-chat), 2026-11-14*

**Load-bearing check: PASSED, before any edit.** Re-ran the Context Repro
(`.tentacle/tmp/mobile-relay/probe.ts`) and the plan's cited seams:

```
$ bun .tentacle/tmp/mobile-relay/probe.ts
wss://relay.tentacle.so/d/AbCdEfGhIjKlMnOpQrStUv/e2e true
ws://127.0.0.1:4100/d/x/e2e true
wss://relay.tentacle.so/d/x false
$ rg -il relay packages/protocol/src packages/daemon/src/ws-server.ts packages/transport/src apps/mobile/src
packages/protocol/src/pairing.ts        # only the :15 comment — unchanged
$ ls apps
mobile                                   # no apps/relay yet
```

`packages/transport/src/channel.ts:9-18` is still four methods only, and
`openDevice` (`ws-server.ts:408`) still takes the channel for everything that
authenticates — so "a relay stream enters the existing device path unchanged"
holds, and the slice does not touch it. The one unproved piece (R0) is probed
below.

#### R0 — the three blocking probes (scratch only)

Scripts: `.tentacle/tmp/mobile-relay/{r0a-splice.ts,r0b.ts,r0c.ts}`.

**(a) Bun splice, frames 1:1, close cascades.** Two `/a` `/b` legs on one
`Bun.serve`, a Bun WebSocket client on each, the server relaying `text` 1:1:

```
$ bun r0a-splice.ts
received lengths: [ "5", "89088" ]
87KiB intact: true
frames 1:1: true
b closed: true within ms: 0 | cascade latency ms: 0
events: open /b | open /a | msg /a 5 | msg /a 89088 | close /a | close /b
```

Frames arrive whole and in order, an 89 088-char (87 KiB) frame included, and
closing one leg closes the other in ~0 ms — far inside the 100 ms budget. **No
drift**: step 3's splice needs no framing layer, as designed.

**(b) A hostile server's 64 MiB frame to a Bun WebSocket CLIENT.**

```
$ bun r0b.ts
received length: 67108864 expected: 67108864
close/error: (none — socket still open)
rss MiB before: 5 after: 135
external MiB before: 0 after: 32
```

**The client caps NOTHING**: a 64 MiB frame is accepted and materialised as a JS
string (+130 MiB RSS), and the socket stays open. So R4's accept leg and the
daemon's control socket each need their own inbound guard. R1 therefore ships
the guard's shared definition — `RELAY_CONTROL_LIMITS.maxInboundChars`
(176 Ki chars = 2× the Noise cap, so a legitimate worst-case frame still passes)
and the pure `isInboundFrameTooLarge(data)` — and R2/R4 call it before decoding.
This is the plan's own "if Bun's client buffers unboundedly, R4 adds a cap", moved
one slice earlier so the number and the predicate exist once, in the shared
module, instead of being re-derived on both ends.

**Correction after Review R1 finding 2 (what this guard is NOT).** The paragraph
above, and the original comments, implied the guard stops R0(b)'s attack. It does
not, and cannot: Bun has already built the string when a handler first sees it, so
the 130 MiB is spent either way. What `isInboundFrameTooLarge` bounds is the cost
of everything after the socket — the JSON/zod parse and the channel's copy — which
is real but smaller. It is a **decode** guard, not a memory bound, and the
comments, the test names, F7 and this section now say so. The memory gap is not
fixed by any client option: probed on Bun 1.4.3
(`.tentacle/tmp/mobile-relay/r0d-client-cap.ts`), a `WebSocket` client built as
`new WebSocket(url, [], {maxPayloadLength: 1024})` still received a 4096-byte
message — the constructor takes one argument and ignores the option
(`maxPayloadLength` exists on the SERVER's `websocket` handler only,
`bun-types` `bun.d.ts:2332`). It therefore stays an **open R4 item**: R4's fallback
is to accept the allocation and back off after an oversize close, so a hostile
relay cannot reconnect-loop the daemon into the same allocation repeatedly.

**(c) A dead-but-open control socket — does the client notice?** A raw
`Bun.listen` server completes the WS handshake with the right
`Sec-WebSocket-Accept`, then never answers again while the TCP connection stays
up:

```
$ bun r0c.ts
client has .ping(): true
+10s state=open … +70s state=open
VERDICT: client noticed a dead-but-open TCP path: false | state: open
         | bytes the server received from the client: 233
```

**The client never notices** (70 s, `open` the whole time, nothing sent
spontaneously: the 233 bytes are the handshake itself). **The app-level ping
stays** — `{t:"ping"}`/`{t:"pong"}` on the control socket, the daemon
reconnecting on a missed deadline, exactly as Design §2 kept provisionally. The
decision is now evidence, not a guess.

#### R1 — the relay wire + the relay id

Red first (both files failed on the absent module, not on an assertion):

```
$ bun test packages/protocol/test/relay.test.ts packages/transport/test/relay-id.test.ts
error: Cannot find module '../src/relay.ts' …
SyntaxError: Export named 'RELAY_ID_LENGTH' not found in module '…/protocol/src/index.ts'
 0 pass  2 fail  2 errors
```

Green after (`packages/protocol/src/relay.ts`, `packages/transport/src/relay-id.ts`):

```
$ bun test packages/protocol/test/relay.test.ts packages/transport/test/relay-id.test.ts
 23 pass  0 fail
```

**What landed.** `packages/protocol/src/relay.ts` (new, exported from `index.ts`):
`RELAY_PROTOCOL_VERSION = 1` (its own wire, not `PROTOCOL_VERSION`),
`DEFAULT_RELAY_URL = "wss://relay.tentacle.so"` (the one place the domain appears
in code, decision 9), the frame schemas (`RelayDaemonFrameSchema` hello/accept/
ping, `RelayToDaemonFrameSchema` ready/error/open/replaced/pong,
`RelayControlFrameSchema` both) as zod discriminated unions of STRIP objects,
`RELAY_CONTROL_LIMITS` (one source for both ends' numbers),
`RELAY_STREAM_HOLD_MS`/`RELAY_STREAM_EXPIRY_MS`/`RELAY_CLOSE_UNREGISTERED`,
`relayAddress(url, id)`, `isRelayUrl`, `isRelayId`, `isRelaySecret`,
`isInboundFrameTooLarge`. `packages/transport/src/relay-id.ts` (new, on its own
`./relay-id` export in `packages/transport/package.json`): `relayIdOf(secret)` =
`b64url(SHA-256("tentacle-relay-id/1" ‖ secret))[0..22]`, on `@noble/hashes`
beside `pairingSas` and for the same reason (crypto only for a runtime that holds
a secret — not on the `@tentacle/transport` root, which every RPC client loads).

**`ready.features` is there from the start** (task 16's owner-approved
amendment), defaulted to `[]`, with `push` the one name this build knows. The
list is NOT a closed enum (Review R1 finding 1): the frame accepts any bounded
name and `knownRelayFeatures(list)` filters it, because a closed enum would make
a relay announcing a second feature fail the whole `ready` parse — the daemon
then drops the link and retries forever, with no version error and no notice.
`error.code` was freed for the same reason: it is a bounded string, name-checked
with `isRelayErrorCode`; its known set (`RELAY_ERROR_CODES`) is a named constant.

`packages/protocol/schema/protocol.json` regenerated (`bun run schema:export`,
+241 lines: 14 new `$defs`). `PROTOCOL_VERSION` untouched — no RPC method or
update changed, and the relay wire is versioned by `RELAY_PROTOCOL_VERSION`
(R1's Preconditions) — so no `protocol.d/` note. `x-protocol-version` in the
schema is unchanged, confirming it.

**Drift from the Implementation, and why.**

1. **R1 gained `isInboundFrameTooLarge` + `RELAY_CONTROL_LIMITS.maxInboundChars`
   and the extra constants above.** Not scope creep: R0(b) is a *new* measured
   fact (a Bun client has no inbound cap) that the plan text assigns to R4. Since
   R4 runs on this same branch and the plan itself says the guard's presence
   depends on R0(b), R1 is where the shared number and predicated belong — one
   definition, both ends (step 2's rule: "every frame validated on both ends").
   R4 only calls it.
2. **`relayIdOf` lives in `packages/transport`, not `packages/protocol`.** The
   plan's file list (R1 row) says exactly this; the Tests section's phrasing
   ("R1 `relayIdOf`") is just the slice, not a location. Kept as the file list
   says.
3. **`packages/protocol/test/json-schema.test.ts:646` union count 7 → 10.** The
   export test counts every exported tagged union; three relay unions are
   exported `*Schema` values, so the pin moved with a comment naming them. This is
   the test that makes an unjustified schema addition visible, so it is meant to
   be edited by a schema change — not a sign the union shape is wrong.
4. **`isRelayUrl` refuses a query/fragment and userinfo.** The plan says
   `wss://`, or `ws://` loopback only. A `?`/`#` would break `relayAddress`
   (which appends path segments) and userinfo would put a credential in an access
   log, so both are refused rather than built on. The test pins the address it
   builds is one `isPairingAddress` accepts, which is the property that matters
   ("an installed app dials it, no update").
5. **`relayIdOf` THROWS on a wrong-size secret** (as `pairingSas` does on a
   wrong-size key). Silently hashing a truncated secret would map two secrets to
   one id — the aliasing a self-certifying id must not have.

**Mutation checks (each reverted; all re-run green afterwards).**

| # | Target the Tests section names | Mutation | Result |
|---|---|---|---|
| 1 | `relayIdOf` vector | `"tentacle-relay-id/1"` → `…/2` | RED: `matches an independently computed vector` fails |
| 2 | id input size | the `secret.length !== RELAY_SECRET_BYTES` guard deleted | RED: `refuses a wrong-size secret instead of aliasing…` fails |
| 3 | `isRelayUrl` loopback rule | `return url` (any host over `ws://`) | RED: `refuses ws to anything that is not loopback` fails |
| 4 | `relayAddress` shape | append `?x` (not a pairing address any more) | RED: 3 `relayAddress` tests fail, incl. `the address it builds is one the app already accepts` |
| 5 | `ready.features` default | `.default([])` removed | RED: `` `ready` carries `features` from the start `` fails |
| 6 | strip schemas (AGENTS §7) | `pongFrame` made `.strict()` | RED: `an unknown FIELD is dropped` fails |
| 7 | the decode guard's bound | `maxInboundChars` set to the 96 Ki splice cap | RED: `the decode guard is ABOVE the Noise cap…` fails |

**Not verified by this slice.** Everything that needs R2–R5 to exist: an
end-to-end phone session through a real relay, the relay's own limits, `serve`'s
`relay.json`, the app's race. R0(a) proved the splice *mechanism* only on a
loopback `Bun.serve` with no relay in between; the R2 `server.test.ts` (frames
1:1 through the real service, 87 KiB and 97 KiB) is where it becomes a claim
about the relay. Nothing outside `bun test` was run — no relay exists to dial.

**Gate (R0+R1): green** — `bunx tsc --noEmit` clean; `bun run lint` clean
(0 errors, 0 warnings, 1 296 files); `bun test` 9 343 pass / 3 skip / 0 fail
across 9 346 tests in 672 files (the three skips are AGENTS §6's opt-ins). Run
twice, same result. Changelog: `changelog.d/mobile-relay.added.md` (one bullet).
`TODO.md` untouched.

### Fix round 1 — *— claude-opus-5-5, 2026-11-14*

Fixing Review R1's two findings (1 HIGH, 1 MEDIUM). Scope: `packages/protocol/src/relay.ts`,
`packages/protocol/test/relay.test.ts`, the regenerated
`packages/protocol/schema/protocol.json`, this doc, and one stale comment in
`packages/transport/src/relay-id.ts`.

**Evidence first (both findings reproduced on the unfixed code).** The reviewer
gave a probe for finding 1; I ran it as the first step, before any edit
(`.tentacle/tmp/mobile-relay/fix1-evidence.ts`):

```
$ bun .tentacle/tmp/mobile-relay/fix1-evidence.ts
F1a ready with an unknown feature parses: false
F1b error with an unknown code parses: false
F2 guard type is string|Uint8Array (input already materialised): string | refused: true
```

Both halves of finding 1 confirmed: a single unknown feature name, or a single
unknown error code, fails the WHOLE frame parse.

#### Finding 1 (HIGH) — a closed enum on `ready.features` / `error.code`

**Fix (as built).** Both fields became bounded free strings and the known-name
check moved into pure typed predicates:

- `featuresField` = `z.array(z.string().min(1).max(64)).max(16).default([])`
  (`relay.ts:175`), plus `isRelayFeature` and `knownRelayFeatures` (`relay.ts:137-164`)
  — the filter a reader of `ready` calls, which drops unknown names and
  duplicates.
- `error.code` = `z.string().min(1).max(32)` (`relay.ts:230`), with the known set
  kept as the named `RELAY_ERROR_CODES` (+ `RelayErrorCode` type) and
  `isRelayErrorCode` (`relay.ts:206-226`). Only `version` earns the 1 h notice
  (F13), so an unknown code is an ordinary refusal — exactly what the reviewer
  asked for ("a new code becomes 'malformed' instead of a refusal" is fixed).

**Deliberate deviation from the reviewer's suggested shape:** the reviewer wrote
"filter to the known names after the parse", which reads like a `.transform()`.
I did **not** use `.transform()`: the JSON-schema exporter rejects `ZodEffects`
by construction (`json-schema.ts:760` pins that, `SUPPORTED_KINDS` has no
`ZodEffects`, `attachment.ts:68` states the rule), so a `.transform()` would have
broken `bun run schema:export` and the drift gate — i.e. the wire contract would
stop being exportable for a codegen consumer. The filter is therefore an exported
pure function (`knownRelayFeatures`) that a consumer calls, which is also the
AGENTS §7 shape: the schema states what is on the wire, the decision is in a
tested module. The observable behaviour the reviewer required (unknown name
parses; the unknown name is dropped by the reader) is what the new test asserts.

**Red before green.** Both new tests were written first and failed on the
property assertion, not on an import:

```
$ bun test packages/protocol/test/relay.test.ts    # before the fix
(fail) control frames > `ready.features` accepts a name this build does not know…
(fail) control frames > `error.code` accepts a code this build does not know…
 22 pass  2 fail
$ bun test packages/protocol/test/relay.test.ts    # after the fix
 24 pass  0 fail
```

The stale `every frame validates its own fields` case that asserted
`code:"nonsense"` is MALFORMED was corrected in place (it was asserting exactly
the broken behaviour): it now asserts a missing `supported` and a `supported`
value of `0` are still refused, and the unknown-name case moved to its own test.

**Mutation checks (each reverted; suite re-run green afterwards).**

| # | Target | Mutation | Result |
|---|---|---|---|
| M1 | `ready.features` forward compat | `z.array(z.string()…).max(16)` → `z.array(z.enum(RELAY_FEATURES))` | RED: `` `ready.features` accepts a name this build does not know, and the known filter DROPS it `` fails |
| M2 | `error.code` forward compat | `z.string().min(1).max(32)` → `z.enum(["version","invalid","busy"])` | RED: `` `error.code` accepts a code this build does not know `` fails |
| M3 | the filter's behaviour | `knownRelayFeatures` body → `return features as RelayFeature[]` | RED: same `ready.features` test fails (the unknown name survives the filter) |
| M4 | the known-code check | `isRelayErrorCode` body → `return value.length > 0` | RED: same `error.code` test fails (`"overloaded"` reported known) |

**`packages/protocol/schema/protocol.json` regenerated** (`bun run schema:export`)
— the drift gate failed first, as it should: `protocol.json is stale`. Diff is
exactly the two fields (`enum` → `minLength`/`maxLength` on `RelayControlFrameError.code`
and `RelayControlFrameReady.features.items`), 4 lines.

#### Finding 2 (MEDIUM) — the guard was described as stopping R0(b)'s attack

**Fix (as built).** A documentation-and-naming fix, as the reviewer asked, not a
behaviour change: the predicate is correct, its *claim* was not.

- `RELAY_CONTROL_LIMITS`'s doc comment (`relay.ts:78-95`) now says DECODE guard,
  states that the string/`Uint8Array` exists before any handler runs, and that a
  check here cannot undo the allocation.
- `isInboundFrameTooLarge`'s doc comment (`relay.ts:358-363`) drops "too large to
  even decode … before handing a frame to a channel" for the same reason.
- Test names: `(R0(b)'s guard)` → `(the decode cost guard)`; `the inbound guard
  is ABOVE…` → `the decode guard is ABOVE…`; both bodies' comments now name what
  is bounded (JSON/zod + the channel copy).
- Doc: F7 rewritten to record the memory bound as **OPEN**, Execution R0(b) got a
  "Correction after Review R1 finding 2" paragraph, and the earlier mutation-table
  row 7 + Tests row for the guard were re-worded to "decode guard".

**The reviewer's open question answered with a measurement.** R4 may adopt "a
client-side max-payload option" or "accept it and back off after an oversize
close". I probed the first (`.tentacle/tmp/mobile-relay/r0d-client-cap.ts`: a
`Bun.serve` that sends 4096 bytes, a client built with
`{maxPayloadLength: 1024}`):

```
$ bun .tentacle/tmp/mobile-relay/r0d-client-cap.ts
client ctor arity: 1 | message chars received with maxPayloadLength:1024 -> 4096 (option IGNORED: no client-side cap)
```

So there is **no** client-side option to adopt on Bun 1.4.3 (`maxPayloadLength`
exists on the SERVER's `websocket` handler only, `bun-types` `bun.d.ts:2332`;
`WebSocket.length === 1`). That is written into the source comment and F7 as the
reason R4's fallback must be the back-off one — a fact R4 would otherwise have
gone looking for.

**Regression test for finding 2?** There is none, and none is possible for the
claim itself: the change is comments, test names and doc text — no behaviour
changed, so a red-before-green test would be theatre. What I did instead is pin
the one factual boundary the new wording implies and the old wording hid: a
`Uint8Array` of exactly `maxInboundChars` passes and `+1` is refused (bytes are
not code units). That case was added to the existing guard test; it is green on
both sides of the wording change by design (it asserts the predicate, which did
not move). The finding is closed by the wording, per the reviewer's instruction
("rewrite the comments, the test name and Execution R0(b) to say what the guard
really does").

#### Small drift fixed in passing

`packages/transport/src/relay-id.ts:13` said the function lives on the
`/noise` subpath; it is exported as `./relay-id`. The reviewer's premise table
flagged it as "small doc drift"; it is now correct. (Markdown prose and comments
only — no code path.)

#### Gate (fix round 1): green

`bunx tsc --noEmit` clean. `bun run lint` clean (0 errors, 0 warnings,
1 296 files — BIOME reformatted two long `expect(...)` lines I introduced; fixed
with `--write`, re-run clean). `bun test`: **9 345 pass / 3 skip / 0 fail** across
9 348 tests in 672 files — the three skips are AGENTS §6's opt-ins. Count moved
9 343 → 9 345 for the two new tests. **Honest flake note:** five full runs total;
one (the second) reported `1 fail` and I did not capture its name — it did not
reproduce in the three logged runs after it (runs 3–5: `9345 pass / 0 fail`,
logs in `.tentacle/tmp/mobile-relay/run{3,4,5}.log`), and this round touched only
pure zod schemas and pure helpers (no timing, I/O, sockets or rendering), so I
cannot attribute it to this change and cannot name it. To verify: re-run
`bun test` and, on a fail, read the `(fail)` line — if it is
`packages/exec/test/confinement.test.ts` R2-4 that is the known sandbox
hard-link flake (`docs/feat/agent-message.md:457`).
No changelog fragment change (the existing
`changelog.d/mobile-relay.added.md` bullet still covers it; a forward-compat fix
in a not-yet-shipped wire is not a separate user-visible entry). `PROTOCOL_VERSION`
untouched, no `protocol.d/` note: the relay wire is versioned by
`RELAY_PROTOCOL_VERSION`, and loosening a field is not a break.

## Review

### R0 + R1 — *— claude-opus-5-5, 2026-11-14*

**Verdict: REQUEST-CHANGES** (1 HIGH, 1 MEDIUM). Scope: `git diff main...HEAD`, slices R0+R1 only.

**Gate (re-run here):** `bun test` on relay.test.ts + relay-id.test.ts + json-schema.test.ts → 48 pass / 0 fail; `bun run lint` clean (1296 files); `bun run typecheck` clean. I did not re-run the full suite.

**Findings**

1. **HIGH — `ready.features` is a closed enum, so it breaks forward compatibility.**
   `packages/protocol/src/relay.ts:133` (`z.array(z.enum(RELAY_FEATURES))`). A
   relay that announces a feature this build does not know fails the whole
   `ready` parse. Probe:
   `RelayToDaemonFrameSchema.safeParse({t:"ready",v:1,id,features:["push","future"]}).success === false`.
   The plan says "a malformed frame is a close", so that daemon drops the link
   and retries forever. Failure scenario: the hosted relay is deployed with a
   second feature name, and every `serve` already installed loses relay
   reachability at once, with no version error and no notice. This defeats the
   point of the task-16 amendment (announce features without breaking old
   daemons) and AGENTS §7 forward-compat ("fields are free"). Fix: accept
   `z.array(z.string().max(…)).max(16)` and filter to the known names after the
   parse. The test must show a `ready` with an unknown feature parsing and the
   unknown name dropped. The same reasoning applies, less severely, to
   `error.code` (`:167`): a new code becomes "malformed" instead of a refusal.
2. **MEDIUM — `isInboundFrameTooLarge` is described as stopping R0(b)'s attack,
   and it cannot.** The comments at `relay.ts:79-84` and `:296-300`, and the test
   at `relay.test.ts:243` ("before it becomes a JS string"), say this. But R0(b)
   showed the Bun client has already turned the 64 MiB frame into a JS string
   (+130 MiB RSS) before any handler runs. A length check in the handler only
   saves the JSON/zod cost. It does not bound memory. Failure scenario: R4
   relies on this "guard", F7 is recorded as closed, and a hostile relay can
   still force allocations as large as Bun allows on every reconnect. Fix:
   rewrite the comments, the test name and Execution R0(b) to say what the guard
   really does. Leave F7's memory bound as an open R4 item (look for a
   client-side max-payload option, or accept it and back off after an
   oversize close).

**Premise table.** relay.ts:1 = the doc's id formula: TRUE. The vector
`WSbKVXnUw63XiNj5KDcKsU` matches my own `node:crypto` computation: TRUE.
`isPairingAddress` (`pairing.ts:122`) accepts what `relayAddress` builds: TRUE.
There is one exception: a long base path exceeds `ADDRESS_MAX` and is refused
later by encode. That is a refusal, not silent, so it is not a finding.
`@noble/hashes` is already a transport dependency: TRUE. `PROTOCOL_VERSION`
untouched and no `protocol.d/` note: TRUE (no RPC change). Small doc drift:
`relay-id.ts:13` says the function lives on the `/noise` subpath, but it is
exported as `./relay-id`.

**Attacks tried.**
- (a) Loopback spoofing (`127.0.0.1.evil`, `localhost.evil`): refused.
  `ws://0x7f000001`, `ws://127.1` and `ws://[0:…:1]` are accepted, but the URL
  parser normalises them to real loopback, so this is OK.
- (b) Uppercase scheme or host (`WSS://Relay.Example`): accepted, and the app
  accepts the address it builds.
- (c) Unknown feature in `ready`: fails (finding 1).
- (d) Strip vs strict: unknown fields are dropped (test at `:176`).

**Mutation.** I did not mutate anything myself: the sandbox would not run my
scripted mutate-then-revert command without approval. Instead I checked the
executor's 7-row table against the test bodies. Each named test asserts the
exact property its mutation breaks, and the vector is independent of the code,
so I consider the tests non-vacuous. The tree is unchanged apart from this
section.

**Executor behaviour.** Honest and well evidenced: R0 probes pasted, red then
green shown, drift listed. Its one mistake is over-claiming what the R0(b)
guard protects (finding 2).
**Model note:** executor deepseek-v4, reviewer claude-opus-5-5. Different
model families.

### Round 2 — *— claude-opus-5-5, 2026-11-14*

**Verdict: PASS.** Scope: `git diff HEAD~1` (commit af849596).

**Finding 1 (HIGH): fixed.**
- `ready.features` now accepts any name of 1–64 characters, at most 16 names.
  `knownRelayFeatures` keeps only the names this build knows and drops
  duplicates. `error.code` is now any string of 1–32 characters, and
  `isRelayErrorCode` checks it against the known codes.
- Mutation A: I put both closed enums back. 2 tests went red (`ready.features
  accepts a name…` and `error.code accepts a code…`).
- Mutation B: I removed the duplicate check in `knownRelayFeatures`. 1 test went
  red.
- I reverted both mutations; `git status` is clean.
- No regression: limits are still enforced. A list of 17 names, a non-string
  code, an empty code and a 33-character code are all still refused, and these
  cases are tested. `protocol.json` was regenerated, and the drift test in
  `json-schema.test.ts` passes.

**Finding 2 (MEDIUM): fixed.** The comments at `relay.ts:79-93` and `:359-362`
and the test names now describe `isInboundFrameTooLarge` as a limit on parsing
cost, not on memory. F7's unbounded allocation is explicitly left open for R4:
the Bun client ignores `maxPayloadLength` (the executor's own probe; I did not
re-run it). The fallback is to back off after a close caused by an oversized
frame. This change is wording only, so there was nothing to mutate.

**Nit fixed:** the comment at `relay-id.ts:13` now names the right
`./relay-id` subpath.

**Gate:** touched tests (relay, relay-id, json-schema): 50 pass / 0 fail.
`bun run lint` is clean (1296 files). `bun run typecheck` is clean. I did not
run the full suite.

## Execution

### R2 — the relay service (as built) — *— claude-opus-5-5, 2026-11-14*

#### Load-bearing check: PASSED, before any edit

R2's premise is R0(a): that a Bun splice carries frames 1:1 and a close
cascades, so `server.ts` can be "one more transport" and nothing more. Re-ran it
from `.tentacle/tmp/mobile-relay/`:

```
$ bun r0a-splice.ts
received lengths: [ "5", "89088" ]
87KiB intact: true
frames 1:1: true
b closed: true within ms: 0 | cascade latency ms: 0
events: open /b | open /a | msg /a 5 | msg /a 89088 | close /a | close /b
```

R1's exports were re-checked to exist and to agree before a line of R2 was
written (`.tentacle/tmp/mobile-relay/r2-loadcheck.ts`):

```
$ bun r2-loadcheck.ts
{ RELAY_PROTOCOL_VERSION: 1, DEFAULT_RELAY_URL: "wss://relay.tentacle.so",
  id: "fgkrQr2vTa2JTEe75Kl66v",
  addr: "wss://relay.tentacle.so/d/fgkrQr2vTa2JTEe75Kl66v/e2e",
  isRelayUrlOK: true, hold: 5000, exp: 10000, close: 4404,
  limits: { maxFrameChars: 98304, maxInboundChars: 180224, preAcceptBytes: 65536,
            backpressureBytes: 16777216, phoneHoldMs: 5000 },
  isRelayId: true, tooLarge: true, ready: true, union: true }
```

Baseline before the slice: `bun test` **9 345 pass / 3 skip / 0 fail** across
9 348 tests in 672 files (the three skips are AGENTS §6's opt-ins).

#### What landed

**`apps/relay/src/relay-core.ts`** (new, pure — no sockets, no timers, no
logging; AGENTS §7). The whole state machine as one class with an injected clock
and token source: `hello` (register the id the secret derives, newest-wins,
release the holds) · `dial` (open / hold / refuse) · `accept` (single-use,
expiry) · `controlClosed` / `phoneClosed` / `streamClosed` · `sweep`.
Decisions are returned as **effects** (`{send, target, frame}` / `{close,
target, code}`) rather than applied to a callback, so a test asserts the exact
consequences in order instead of spying on a socket. `RELAY_LIMITS` holds the six
abuse limits; `RELAY_CLOSE_REFUSED = 4429` is the door-refusal code.

**`apps/relay/src/server.ts`** (new, thin). `Bun.serve` + the four routes
(`relayRoute`, pure and pinned) + the splice. It parses, asks the core, applies
the effects and forwards frames — it computes nothing. `relaySocketOptions` is
`serve`'s policy verbatim (`closeOnBackpressureLimit` at
`RELAY_CONTROL_LIMITS.backpressureBytes`, pings on, idle 60 s).
`limitsFromFlags` / `RELAY_LIMIT_FLAGS` map the five deploy flags.

**`apps/relay/src/main.ts`** (new). `parseRelayArgs` (pure: flags + env, a flag
wins, an invalid value is a REFUSAL not a silently ignored limit) and the
`import.meta.main` shell with SIGINT/SIGTERM shutdown.

**`apps/relay/{package.json,tsconfig.json}`**, root `package.json`
`typecheck` += `tsc -p apps/relay --noEmit`, `bun.lock` (the workspace entry —
see drift 1), and AGENTS §6's app count (drift 2).

#### Drift from the Implementation, and why

1. **`bun.lock` gained the `apps/relay` workspace entry — not in the plan's file
   list.** A new workspace package makes `bun install --frozen-lockfile`
   (CI's and the build workflow's own command) fail with "lockfile had changes,
   but lockfile is frozen". The entry is generated, not hand-written
   (`bun install --filter '!@tentacle/mobile'`, +10 lines), and the frozen
   install then passes. R2 cannot land without it.
2. **AGENTS §6's count line, as the slice table says** ("one line, rides this
   branch"): "**1 app**" → "**2 apps**", naming `apps/relay` and that it has its
   own `tsc -p apps/relay`; the `typecheck` bullet follows. Prose only.
3. **A `main.test.ts`, a third test file the slice row does not list.** The row
   names `{relay-core.test.ts,server.test.ts}`; the design puts `--host/--port`
   and five limit flags in `main.ts`, and AGENTS §9 wants the failure modes of a
   parser tested (a bad value, a bad env var, a flag winning over env, an unknown
   argument). Testing it through a real process would only let me assert a
   substring of stdout; the plan's own "logic in pure modules" rule puts
   `parseRelayArgs` on the pure side, so it is tested directly. Nothing else
   changed by it.
4. **The limit flags are FIVE, not the design's "flags override" in the
   abstract.** The design names six limits; `maxTrackedIps` is deliberately NOT a
   flag (it is a memory bound on the relay's own bookkeeping, not a policy an
   operator tunes — an operator raising it gains nothing and can only make the
   process bigger). The other five are flags and env vars.
5. **`relay-core.ts` re-uses `decodeBase64Url` from `@tentacle/protocol`
   rather than taking the secret as raw bytes.** The wire carries 43 chars, and a
   LENIENT decoder would map two different strings onto one secret — exactly the
   aliasing a self-certifying id must not have. So the relay decodes strictly,
   refuses `undefined` (non-canonical) and refuses a wrong length, before
   `relayIdOf` is ever called. Mutation 12b is the proof it matters.
6. **A refused dial does NOT call `core.phoneClosed`.** The core charges a slot
   only once a dial is admitted; returning one for a refused dial would free a
   slot another phone holds. The server closes the socket at its own layer
   (`RELAY_CLOSE_REFUSED`), which is why that constant lives in `relay-core.ts`
   (named by the module that decides) and is applied by the module that owns the
   socket.
7. **`ready.features` is `[]` from this build.** R1 made the field present with a
   default; the relay announces none because this build sends no `push` (task
   16's). R7's deployed build is where a feature list would first be non-empty.
8. **The core asserts on a malformed minted token** (`throw`) instead of
   redrawing forever. The default source is `crypto.getRandomValues`, so this is
   unreachable in production; a test that injects a bad source gets a loud
   failure rather than a stream nobody could accept.

**Not a drift, but worth stating:** `apps/relay` imports
`@tentacle/transport/relay-id` in the core (the hash is a DECISION — which id a
secret has) and nothing from transport in the server. The relay therefore loads
no Noise code, only the one hash function it needs, which is what R1's subpath
split was for.

#### Red before green

The two runnable files were written against the TESTS:

```
$ bun test apps/relay/test/relay-core.test.ts          # first run, before the
 12 pass  11 fail  47 expect()                       # token format was fixed
  error: relay: the minted stream token is malformed or collides
```

Those 11 were **my test double's** fault (a token of the wrong length), not the
code's, so they are not the proof. The proof that the tests bite is the mutation
table below: each of the 20 mutations makes a named assertion go red. The
`server.test.ts` first run was red for the same class of reason (a recorder that
double-delivered frames), and its 25 tests went green once the recorder was
right — no production line changed to make them pass.

#### Mutation checks (each reverted; the tree was diffed back to identical)

Script: `.tentacle/tmp/mobile-relay/mutate.sh` (backup → `sed` → run the named
test → restore; no git, per the brief). Targets are the plan's Tests section for
R2. `RED=n` is the count of `(fail)` lines.

| # | Target | Mutation | Result |
|---|---|---|---|
| 1 | `hello` refuses a secret not matching | `relayIdOf(bytes)` → a constant | RED=1 `a hello with a secret not matching is refused` |
| 2 | newest wins (old gets `replaced`) | drop the old socket's `close` | RED=1 `newest wins: … and TELLS it` |
| 3 | stream token single-use | `if (stream.accepted)` → `if (false)` | RED=1 `accepts a minted stream once` |
| 4 | stream token expires at 10 s | expiry check → `if (false)` | RED=1 `a token expires at 10 s` |
| 5 | hold-for-registration `4404`s at 5 s | `at - hold.since >= HOLD` → `if (false)` | RED=1 `the hold sweep … closes 4404 at exactly 5 s` |
| 6 | hold released on register | drop `releaseHolds` | RED=1 `… HELD, and released on the registration` |
| 7 | per-ip dials/min | limit check → `if (false)` | RED=1 `dials per minute per ip` |
| 8 | per-ip concurrent | limit check → `if (false)` | RED=1 `concurrent phone sockets per ip` |
| 9 | per-id streams | limit check → `if (false)` | RED=1 `streams per id` |
| 10 | registered ids | limit check → `if (false)` | RED=1 `registered ids (a NEW id is refused…)` |
| 11 | per-ip hellos/min | limit check → `if (false)` | RED=1 `hellos per minute per ip` |
| 12b | secret decode is STRICT | `bytes === undefined \|\| …` → `bytes !== undefined && …` | RED=1 `a non-canonical secret encoding is refused` |
| 13 | version skew refused on hello | `input.v !== VERSION` → `if (false)` | RED=1 `an unknown protocol version is refused` |
| 14 | 97 KiB frame closes both legs | splice cap → `if (false)` | RED=1 `a 97 KiB frame closes BOTH legs` |
| 15 | pre-accept 64 KiB cap | cap check → `if (false)` | RED=1 `the pre-accept buffer is capped` |
| 16 | one leg closing closes the other | drop the cascade `closeSocket(peer)` | RED=1 `one leg closing closes the other` |
| 17 | `replaced` frame is SENT | drop the `replaced` effect | RED=1 `… replaces the first socket and TELLS it` |
| 18 | logs hold no secret | log the raw `hello` text | RED=1 `the captured log has no secret…` |
| 19 | early frames flushed on join | empty the flush loop | RED=1 `a held phone's early frames are delivered` |
| 20 | `/healthz` carries no counters | add `ids: registeredIds` | RED=1 `/healthz … and NO counters` |

Mutation 12's first form (removing only the `undefined` half of the condition)
stayed GREEN, because `undefined.length` still tripped the length check — a
vacuous mutation, replaced by 12b, which is the one that removes the property
(the strict decode) and does go red. Recorded rather than hidden: it is the
one case where my first attempt at a mutation proved nothing.

Tree restored after every row (`diff` against the pre-mutation copies: identical,
`TREE RESTORED`).

#### Acceptance checks the plan names

- `apps/relay` `server.test.ts` on `127.0.0.1:0` — frames 1:1 both ways incl.
  87 KiB ✔ (`frames cross 1:1 both ways, an 87 KiB frame included`); a 97 KiB
  frame closes both legs ✔; one leg closing closes the other ✔; pre-accept
  buffer cap ✔; `/healthz` ✔; unknown route 404 ✔; **the captured log grepped for
  the secret** ✔ (also asserted free of the stream token and of a frame payload,
  and asserted to still contain the id's 8-char prefix, so the test is not
  vacuously satisfied by an empty log).
- `relay-core` — register, newest-wins, mismatch refused, single-use token,
  10 s expiry, hold/release/`4404`, and **each limit at its boundary** (N ok,
  N+1 refused) ✔. Each limit's test also re-asserts the boundary by showing a
  freed slot admits again, so "refused" is not just "always refused".
- `PROTOCOL_VERSION` untouched; `packages/protocol/schema/protocol.json`
  unchanged (`git diff --stat` empty) — R2 adds no schema, so no regenerate and
  no `protocol.d/` note.
- Pod/worker (F20): nothing in R2 dials; no `relay.json`, no link. R4/R5a own
  that and it stays their test.

#### Gate (R2): green

`bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit` clean ·
`bunx tsc -p apps/relay --noEmit` clean · `bun run lint` clean (1 304 files, 0
errors, 0 warnings — the pre-existing baseline, so nothing new) · `bun test`
**9 401 pass / 3 skip / 0 fail** across 9 404 tests in 675 files (the three
skips are AGENTS §6's opt-ins; the count moved 9 345 → 9 401 for R2's 56 tests in
three new files). Log: `.tentacle/tmp/mobile-relay/gate-r2-final.log`. Run with
nothing else touching the tree — an earlier gate run overlapped a `bun install`
and was discarded rather than reported.

**Changelog:** none added by this slice, deliberately. The branch's single
fragment `changelog.d/mobile-relay.added.md` (R1) already carries the one
user-visible bullet, and it already names this deliverable ("The relay is a small
self-hostable service in `apps/relay`"). A second fragment with the same
slug+category is the same filename — the one collision the changelog rule
forbids — and a *service that is not yet deployed or wired up* is not a second
user-visible change. R5a is where `serve` starts using it; if the reviewer wants
R2's existence named separately, the correct edit is to extend that one bullet,
not to add a file. `CHANGELOG.md` untouched. `TODO.md` untouched.

**Not verified by this slice.** Everything that needs a peer: no daemon dials it,
no phone connects through it, so the end-to-end proof (a phone reaching a session
THROUGH the relay) is R4's test, which runs against this real server. Also
unverified: a real `wss://` deployment behind Caddy (R7 + owner decision D), the
`maxInboundChars` decode guard's effect on a hostile relay (R4's accept leg), and
the client-side unbounded-allocation gap R0(b) recorded — F7 is still OPEN, and
R2 does not close it (it bounds the relay's own inbound frames at 96 Ki chars,
which is a different leg from the daemon's).

## Review

### R2 — *— claude-opus-5-5, 2026-11-14*

**Verdict: REQUEST-CHANGES.** Same model family as the R2 executor signature
(fresh context only): shared blind spots may survive.

Gate (scoped): `bun test apps/relay` 56 pass / 0 fail; `bun run lint` clean;
`bun run typecheck` clean. Full `bun test` not re-run (scope: R2 files only).

Findings:
1. **MEDIUM — an expired unaccepted stream frees its slots but never closes
   the phone** (`apps/relay/src/relay-core.ts:413-417`, also `:355-357`).
   `sweep()` / `accept()`'s `expired` path call `forgetStream` (releases the
   per-ip slot, drops the per-id count) and emit no `close` for `stream.phone`.
   Scratch repro (`concurrentPerIp: 1`): dial p1 → t=11 s → `sweep()` returns
   `[]` → a second dial from the same ip is admitted while p1 is still open.
   Failure: a registered daemon that never accepts (crashed after `open`, or a
   hostile one) lets one IP accumulate unbounded open phone sockets (30/min,
   each pinned until Bun's idle timeout, which a ponging client never hits),
   bypassing `concurrentPerIp` and `streamsPerId`; and a legit phone gets an
   OPEN socket that never carries a handshake instead of a prompt close to try
   the next address (F2/F7 convergence broken). Fix: emit
   `{close, phone, RELAY_CLOSE_UNREGISTERED}` on both expiry paths + test.
2. **MEDIUM — a second `hello` with a different secret on ONE control socket
   registers a second id that is never unregistered**
   (`relay-core.ts:226-294`, `controlClosed` `:364-371` returns after the first
   match). Repro: two hellos on `c9` (secrets 2, 3) → `registeredCount` 3 →
   `controlClosed("c9")` → 2; a phone dial to id(3) is `opened` with `open`
   sent to the dead `c9` (dropped by `server.ts:185`) instead of held/4404.
   Failure: stale registrations leak until relay restart (fills `registeredIds`
   10 000 → new daemons refused `busy`), and phones for that id hang on a dead
   route. Fix: refuse a second `hello` on an already-registered socket (or
   delete every id of that socket) + test.
3. **MEDIUM (test non-vacuity) — the server's phone-close slot release is
   unpinned.** Mutation: comment out `core.phoneClosed(key)` in
   `server.ts:367` → 56/56 still pass. A leak there exhausts every IP's
   `concurrentPerIp` after 16 dials. Needs a socket-level test: dial/close
   N+1 times at `concurrentPerIp: N`, the last dial admitted.

Mutation outcomes: dropping the `replaced` send (`relay-core.ts:288`) → 2
tests fail (core + server) — non-vacuous; finding 3 above — vacuous. Both
reverted; `git status` clean afterwards.

Attacks tried: newest-wins + old socket's late `close` (no wrong unregister:
holds); double release of a phone slot via oversize-drop + `close` (idempotent:
holds); accept after phone close (stream already forgotten → `unknown`: holds);
log contents (key/8-char prefixes only, no secret: holds); expiry paths
(finding 1); multi-hello per socket (finding 2). Noted, not raised: the
`maxTrackedIps` eviction of an entry with `open > 0` resets its count, so the
"never a bypass" comment (`relay-core.ts:497`) is inaccurate (low: per-IP
limits are weak against IPv6 ranges anyway).

§7: R2 holds no key and authorises nothing (relay untrusted — holds); no
session path, broker, persistence or terminal I/O touched.

## Execution

### Fix round 1 — *— claude-opus-5-5, 2026-11-14*

All three R2 findings fixed, in the pure core where the decision lives, with the
server applying what it is told. Red before green per finding (each mutation
below was run against the fix in place, then reverted; §9 requires the failure to
be on the assertion, and it is — no import/compile error in any run).

**F1 (MEDIUM) — an expired unaccepted stream now closes its phone.**
`relay-core.ts:446-450` (`sweep`) pushes
`{close, stream.phone, 4404}` after `forgetStream`; `relay-core.ts:378-390`
(`accept`'s `expired` branch) does the same via a new
`AcceptDecision` variant (`relay-core.ts:116-122`) that carries `effects`, applied
at `server.ts:442-446`. The other three accept refusals keep their exact old shape
(`{ok:false, reason}`) on purpose, so no unrelated assertion moved.
Why: a daemon that registers but never accepts (crashed, or hostile) left one
phone socket open per dial until Bun's idle timeout — a ponging client never hits
it — so `concurrentPerIp` was bypassed and a legitimate phone hung on an OPEN
socket that could never carry a handshake (F2/F7 convergence). Both expiry paths
now close `4404`, which is exactly the "try my next address" signal a held dial
already gets.
Mutation A: drop the `effects.push` in `sweep` →
`bun test apps/relay/test/relay-core.test.ts` = **23 pass / 2 fail** (`an
unaccepted stream expiring in the sweep also CLOSES its phone`; `an unaccepted
stream stops counting against its id after the expiry`). Mutation B: empty
`effects` in `accept`'s `expired` branch → **24 pass / 1 fail** (`a token expires
at 10 s, and the expiry frees the slot`). Mutation C: drop
`apply(decision.effects)` at `server.ts` → **27 pass / 1 fail** (`an accept for an
expired stream closes the phone too`, timed out waiting for the close — red on
the property, not on a type error), which is why that socket-level test exists:
C survived every core-level test.

**F2 (MEDIUM) — one control socket registers one id.**
`relay-core.ts:269-283`: `hello` refuses (and closes 1000) a secret whose id
differs from the id already registered on the SAME socket, with `error
"invalid"`. A re-hello with the SAME secret on the same socket is untouched (the
existing `a re-hello on the SAME socket is not a replacement` test still passes),
and newest-wins across sockets is untouched.
Why: `controlClosed` unregisters only the FIRST id it finds on a socket, so a
second hello registered an id nothing ever removed — it leaked until relay
restart (filling `registeredIds`, then refusing new daemons `busy`) and phones for
it were `opened` onto a dead control socket, hanging instead of being held/4404.
Mutation: remove the guard → **58 pass / 2 fail** (core + socket-level
`a second hello on one control socket, with a different secret, is refused`).

**F3 (MEDIUM, test non-vacuity) — the server's phone-close slot release is
pinned.** New socket-level test (`server.test.ts`): 3 sequential dial+close at
`concurrentPerIp: 2`, each close awaited through `heldCount` back to 0; a leak
exhausts the cap on the third dial (refused `4429`).
Mutation (the review's exact one): comment out `core.phoneClosed(key)` at
`server.ts:367` → **26 pass / 1 fail** (`a closed phone gives its per-ip slot back
(N+1 sequential dials at cap N)`, "timed out waiting for the held dial to be
released"). Previously 56/56 passed under that mutation; it now fails.

**One existing test was corrected, not weakened**: `an unaccepted stream stops
counting against its id after the expiry` asserted `sweep() === []` — the buggy
behaviour itself — and now asserts the `4404` close it gets instead. Its original
property (the id's slot is free again) is still asserted, plus the dial that
proves it.

**Drift from Implementation:** none — R2's Design did not name the expiry
close-up, and this is the smallest change that satisfies its F2/F7 convergence
argument. The `AcceptDecision` split (only `expired` carries `effects`) is a
shape choice made to avoid touching the other refusals' assertions.

**Gate:** `bunx tsc --noEmit` clean · `bunx tsc -p apps/relay` clean · `bun run
lint` clean (1304 files, no fixes) · `bun test` **9406 pass / 3 skip / 0 fail**
(9409 tests, 675 files) — the 3 skips are the pre-existing opt-ins (live-k8s,
live-docker, real-socket keepalive), no new skip. `apps/relay` alone: 61 pass / 0
fail. No `changelog.d` fragment: this is a fix to unshipped R2 code on the same
branch, before any release, and `changelog.d/mobile-relay.added.md` already covers
the user-visible relay. No `protocol.d` note: the wire is unchanged (the review's
own `4404` close code already exists and is used by the held-dial path).

**Not verified:** the concurrent-socket behaviour of finding 1 under a real
hostile daemon (the tests drive the pure core and a local socket; a 30/min×N
saturation run against a deployed relay is R7's). The review's noted-but-not-
raised `maxTrackedIps` eviction of an entry with `open > 0` is untouched (low
severity, per-IP limits are weak against IPv6 ranges anyway).
