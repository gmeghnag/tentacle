# fix/relay-hardening — Secure the live mobile relay

> **Status:** implementation APPROVED (orchestrator, night delegation) · **executed** — Execution signed by the executor, fresh-context Review pending
> **Branch:** `fix/relay-hardening`
> **Size:** M · **Blast:** cross-module (relay code + deploy artefacts + runbook + a live public host; no wire/protocol change) · **Suited:** strong model executes; fresh-context Review mandatory (internet-facing service)
> **Changelog:** `changelog.d/relay-hardening.security.md`

## Context

*— claude-opus-5-5, 2026-11-15*

The mobile relay (`apps/relay`, `docs/feat/mobile-relay.md`, runbook
`docs/ops/relay-deploy.md`) is LIVE since 2026-11-15 02:05 at
`https://relay.tentacle.so`. Caddy 2.8.4 runs in a podman container (host
network, `/etc/caddy` bind-mounted; reload =
`podman exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`)
in front of `apps/relay/deploy/relay.service` on Rocky Linux 9 x86_64. Push is
off (no `.p8`). Owner: "mettiamo in sicurezza il relay".

### Security review (step 1)

Threat model: an internet attacker (floods, slowloris, oversized frames, id
squatting/guessing, replay, resource exhaustion, log injection, path probing), a
hostile phone, a hostile daemon, and the relay itself as an untrusted party.

#### The "relay is not trusted" claim holds, end to end

- **The relay holds no key.** Its only crypto is hashing the presented secret
  into an id (`apps/relay/src/relay-core.ts:326-338`) and minting a 128-bit
  random stream token (`relay-core.ts:268`).
- **Ids certify themselves.** `hello` carries the secret in the frame, never in
  the URL (`packages/protocol/src/relay.ts:112-113`), and the relay registers
  only `relayIdOf(secret)` (`relay-core.ts:338`). A claimed id is never read.
  The daemon checks `ready.id === relayIdOf(own secret)`
  (`packages/daemon/src/relay-link.ts:308-309`) and ignores `open` until it has
  seen that `ready` (`relay-link.ts:348-353`).
- **Every stream is authenticated by Noise, daemon-side.** The accept leg is
  handed to `acceptDevice`, the same device path as the direct `/e2e` route
  (`relay-link.ts:476-486`). That is the Noise responder against the computer key
  plus the device registry's `authorize` (`packages/daemon/src/device-accept.ts:87,137-138`).
  The phone is the IK initiator, pinned to the computer key from the QR code
  (`packages/client/src/pairing.ts:155`, `packages/transport/src/noise-channel.ts:76-77,415,434`,
  `packages/transport/src/noise.ts:227-233`). An unknown phone key is refused
  by `authorize` (`noise-channel.ts:463-467`).
- **What a hostile relay CAN still do:** refuse or drop service; observe
  metadata (id, address, sizes, timing — stated in `apps/relay/src/main.ts:80-82`);
  replay a captured IK message 1, which gives a handshake it cannot finish without
  the initiator's ephemeral key; lie in `open.ip`, which the daemon treats as an
  untrusted rate-limit key only (`packages/daemon/src/relay-link-policy.ts:36-41`,
  `relay-link.ts:419-425`); send the daemon a huge frame. The daemon bounds the
  parse but not the allocation; that is the known open R4 gap
  (`packages/protocol/src/relay.ts:90-94`) and out of scope here.
- **Hostile daemon:** it can register only its own id. It cannot take another
  daemon's stream without that stream's single-use, 10 s, 128-bit token
  (`relay-core.ts:438-461`). It can push only once registered
  (`relay-core.ts:508-513`).
- **Hostile phone:** it gets a socket, then fails `authorize`. Daemon-side, the
  `HandshakeLimiter` bounds it by `open.ip` (`relay-link.ts:419-425`).

**Conclusion:** confidentiality and integrity hold. Every finding below is about
**availability** (DoS) and **metadata hygiene**.

#### Findings

| # | Sev | Finding | Evidence |
|---|---|---|---|
| H1 | High | **No `maxPayloadLength`.** `relaySocketOptions` (`server.ts:130-142`) leaves Bun's default in place (16 MiB per frame). Every size check (`server.ts:362, 397, 496, 504`) runs AFTER Bun has built the string. About 32 parallel 16 MiB frames from anyone reach `MemoryMax=512M` (`relay.service:91`), which OOM-kills the relay and drops every daemon and stream. No auth is needed: `/v1/daemon` and `/v1/accept` take a frame before any admission. | Repro P3: a 4 MiB frame reached JS (`frame-oversize` logged by the app, close 4404 from the app, not from Bun). |
| H2 | High | **Pre-auth sockets have no limit and never expire.** `fetch` upgrades every `/v1/daemon` and `/v1/accept` request unconditionally (`server.ts:303-317`). The core first sees such a socket at `hello` / `accept` (`relay-core.ts:304`, `438`). With `sendPings: true` (`server.ts:140`), a client that only answers pings is never idle, so a silent socket lives forever. Each one holds an fd and up to 16 MiB of backpressure buffer (`protocol/src/relay.ts:104`). | Repro P1: 100 silent pre-auth sockets were still open after 5 s, with a 2 s idle timeout. |
| H3 | High | **Every per-IP limit is one global bucket.** The limiter keys on Bun's `requestIP` (`server.ts:305`). Behind Caddy that is always 127.0.0.1. With the fleet sizes in `relay.service:50-51`, one client can take all 2000 phone sockets, or burn the 600 `hello`/min. A `hello` flood with random secrets is refused `busy` per bucket (`relay-core.ts:317-325`), so it locks out the re-registration of **every** daemon. | Repro P2: `open.ip` is `127.0.0.1` even when `X-Forwarded-For: 203.0.113.7` is sent. |
| M1 | Med | **Pings have no rate limit and are allowed before `hello`.** `ping` → `pong` is unconditional (`server.ts:410-412`). A client that never reads piles pongs into its 16 MiB buffer, and H2 multiplies that. The daemon only pings after `ready` (`relay-link.ts:327, 378-401`). | code |
| M2 | Med | **The registry can be filled.** `registeredIds` is a global 10 000 (`relay-core.ts:52, 355`). Per IP there is only a rate (10/min), no cap. Once IPs are real (H3 fixed), one IP fills it in about 17 h, and a few hundred IPs in minutes. After that every new daemon gets `busy`. | code |
| M3 | Med (latent) | **IPv6: one address is one bucket** (`relay-core.ts:695-715`), so a /64 is 2^64 buckets. Today DNS has only an `A` record (runbook §4), so this is latent. | code |
| M4 | Med | **Logs have no rate limit.** Every refusal writes a line (`server.ts:329, 350, 365, 400, 406, 421, 432, 465, 511, 517`). A flood fills the journal, and journald's own rate limit then drops lines without choosing, `ready` lines included. | code |
| L1 | Low | **Log hygiene.** No IP is ever logged (verified: no log call takes `ip`), and ids and tokens appear as 8-char prefixes only (`server.ts:145-147`). But stream-token prefixes (`server.ts:339, 517, 530`) correlate nothing once the 10 s expiry has passed, and `accept-refused` echoes a prefix the attacker chose. Apple's `reason` is logged at any length (`server.ts:479-481` ← `apns-client.ts:268-269`). | code |
| L2 | Low | **Caddy proxies every path to Bun** (`Caddyfile.relay:18`). The relay 404s unknown paths itself (`server.ts:300-302`), so nothing is exposed, but probes reach the process. There is no HSTS, and the response carries `Server: Caddy`. | code |
| L3 | Low | **The runbook does not match the host.** §3/§4/§7 say `systemctl reload caddy` / `caddy validate`, but Caddy runs in podman on this host. | runbook vs brief |
| I1 | Info | **Header size and slowloris on headers: no gap.** The relay binds loopback only (`relay.service:50`, `server.ts:43`). Caddy in front bounds header reads (default `read_header` 1m; `max_header_size` default per Caddy docs). Verify on the host (Deploy step D2); no change planned. `perMessageDeflate` is off by Bun's default; it will be pinned explicitly so it cannot become a zip-bomb vector. | Caddy docs (`caddyfile/options`) |
| I2 | Info (debt) | **Linear scans.** `idOfControl` scans all ids on every `hello`/`push` (`relay-core.ts:289-296`); `countForId` and `phoneClosed` scan all streams (`664-677`, `587-592`). Rate limits bound them. Not fixed here. | code |
| I3 | Info (debt) | **Per-IP eviction is in insertion order, not LRU** (`relay-core.ts:706-712`). An IP with open sockets can be evicted, which resets its `open` count. Exploiting that needs more than 4096 distinct IPs. Not fixed here. | code |

Already sound, left as is: the phone route is matched exactly (`server.ts:105-122`);
binary frames are refused (`server.ts:347-353`); the pre-accept buffer is capped
at 64 KiB (`server.ts:263-272`); held dials expire at 5 s and unaccepted streams
at 10 s (`relay-core.ts:612-629`); stream tokens are single-use
(`relay-core.ts:446-448`); `/healthz` exposes no counters (`server.ts:296-298`);
the systemd sandbox is complete (`relay.service:60-92`); and log lines cannot be
injected, because every logged value is schema-validated or comes from the core.

**Repro** (2026-11-15, Bun 1.4.3, worktree at `c8b4dc3c`; run from the repo root
as `bun .tentacle/tmp/relay-hardening/probe.ts`):

```ts
import { encodeBase64Url } from "../../worktrees/relay-hardening/packages/protocol/src/index.ts";
import { relayIdOf } from "../../worktrees/relay-hardening/packages/transport/src/relay-id.ts";
import { startRelay } from "../../worktrees/relay-hardening/apps/relay/src/server.ts";

const lines: string[] = [];
const relay = startRelay({ host: "127.0.0.1", port: 0, idleTimeoutSec: 2, onLog: (l) => lines.push(l) });
const base = relay.url;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const openWs = (url: string, headers?: Record<string, string>) =>
  new Promise<{ ws: WebSocket; msgs: string[]; close: Promise<number> }>((res, rej) => {
    const ws = new WebSocket(url, headers ? ({ headers } as never) : undefined);
    const msgs: string[] = [];
    let onClose: (c: number) => void = () => {};
    const close = new Promise<number>((r) => (onClose = r));
    ws.onmessage = (e) => msgs.push(String(e.data));
    ws.onclose = (e) => onClose(e.code);
    ws.onopen = () => res({ ws, msgs, close });
    ws.onerror = rej;
  });

// P1: pre-hello control sockets — no cap, and pings keep them alive past idleTimeout.
const idle = await Promise.all(Array.from({ length: 50 }, () => openWs(`${base}/v1/daemon`)));
const idleAccept = await Promise.all(Array.from({ length: 50 }, () => openWs(`${base}/v1/accept`)));
await wait(5000);
const stillOpen = [...idle, ...idleAccept].filter((s) => s.ws.readyState === WebSocket.OPEN).length;
console.log(`P1 silent pre-auth sockets still open after 5s (idleTimeout=2s): ${stillOpen}/100`);

// P2: XFF is ignored — open.ip is the direct peer.
const secret = new Uint8Array(32).fill(9);
const id = relayIdOf(secret);
const daemon = await openWs(`${base}/v1/daemon`);
daemon.ws.send(JSON.stringify({ t: "hello", v: 1, secret: encodeBase64Url(secret) }));
await wait(100);
const phone = await openWs(`${base}/d/${id}/e2e`, { "X-Forwarded-For": "203.0.113.7" });
await wait(100);
console.log(`P2 daemon frames: ${daemon.msgs.join(" | ")}`);

// P3: a 4 MiB text frame on the phone leg reaches JS (closed by the app check, not Bun's payload cap).
phone.ws.send("x".repeat(4 * 1024 * 1024));
console.log(`P3 phone close code after 4 MiB frame: ${await phone.close}`);
console.log(`log: ${lines.filter((l) => !l.startsWith("dial") && !l.startsWith("ready")).join(" | ")}`);
relay.stop();
process.exit(0);
```

Output:

```
P1 silent pre-auth sockets still open after 5s (idleTimeout=2s): 100/100
P2 daemon frames: {"t":"ready","v":1,"id":"gzu4Za9r6qkfZRZgx2LNpx","features":[]} | {"t":"open","stream":"ZRLpLUHBz1QYi0MDS2fnGw","ip":"127.0.0.1"}
P3 phone close code after 4 MiB frame: 4404
log: frame-oversize s102
```

## Implementation

*— claude-opus-5-5, 2026-11-15*

### Load-bearing assumption

**Behind this deployment, the only peer that can reach the relay socket is
loopback, and Caddy always sends a correct `X-Forwarded-For` for that peer.**
Then "honour XFF only from a loopback peer when `--trust-proxy` is set, taking
the right-most untrusted hop" yields the real client and cannot be spoofed from
outside.

- The relay binds `127.0.0.1` (`relay.service:50`, `server.ts:43`). Runbook §8
  checks this with `ss -lntp | grep 4100`.
- Caddy (host network) is the internet-facing hop, and DNS points directly at the
  host (runbook §4: `A relay.tentacle.so → 142.132.169.22`, no CDN).
- Caddy sets `X-Forwarded-For` by default and drops incoming values from untrusted
  clients (Caddy docs, `reverse_proxy` "Defaults"). The plan does not rely on the
  default: the site block states `header_up X-Forwarded-For {remote_host}`. Even
  if Caddy appended instead, taking the right-most hop gives the same answer.
- **Residual:** any process on the host, including a host-network container,
  can dial `127.0.0.1:4100` and forge XFF. That only bypasses the per-IP limits
  for local processes, which can already DoS loopback. Accepted and documented.

### Preconditions

- The limiter key is whatever string `server.ts` passes as `ip` to
  `core.dial` / `core.hello` (`server.ts:305, 327, 427`). The core's only other
  use of it is `open.ip` (`relay-core.ts:428, 654`), whose schema is
  `z.string().min(1).max(64)` (`protocol/src/relay.ts:274`). The daemon uses it
  only as a limiter key and never parses it (`relay-link.ts:421`). So passing a
  /64 bucket string such as `2001:db8:1:2::/64` is wire-compatible: **no
  `PROTOCOL_VERSION` or `RELAY_PROTOCOL_VERSION` change and no `protocol.d/` note.**
- The daemon sends `hello` on open (`relay-link.ts:285`), sends `accept` on the
  accept leg's open (`relay-link.ts:470`), and starts pinging only after `ready`
  (`relay-link.ts:327`) at most once every 25 s (`relay-link-policy.ts:43`). So
  "first frame within 10 s", "nothing but `hello` before `ready`" and "≤ 30 pings
  per minute" never trip a correct daemon.
- The largest legitimate frame is a Noise frame of about 87.4 Ki **ASCII**
  characters (`protocol/src/relay.ts:76-78`; the 87 KiB splice test is
  `server.test.ts:312`). A push payload is ≤ 4096 B. So `maxPayloadLength = 96 KiB`
  in bytes never cuts a legitimate frame: for ASCII, bytes = chars.
- The phone app ignores relay close codes: there is no `4404`/`4429`/`1009`
  branch in `apps/mobile/src`. Any close means "redial", so a Bun-chosen close
  code on an oversized frame changes nothing for a client.
- Bun's `ServerWebSocket` handler config is one config for every route
  (`server.ts:319-320`), so `maxPayloadLength` applies to all legs. That is fine:
  every leg is below 96 KiB.

### Design

**(a) Real client IP.** Add a new pure module, `apps/relay/src/client-ip.ts`:

```ts
export function isLoopback(addr: string): boolean;        // 127.0.0.0/8, ::1, ::ffff:127.x.x.x
export function clientIpOf(input: {
  peer: string; forwardedFor: string | null; trustProxy: boolean;
}): string;
export function limiterKeyOf(ip: string): string;         // v4 → as is; v6 → "<first 4 hextets>::/64"
```

`clientIpOf` works like this:

- If `!trustProxy` or `!isLoopback(peer)`, it returns `normalize(peer)`. A
  non-loopback peer's XFF is never read.
- Otherwise it splits XFF on `,` (at most 16 entries), trims each entry, and walks
  from the RIGHT, skipping loopback entries (trusted hops).
- The first entry that is not loopback is returned if `net.isIP(normalize(e))` is
  true. If that entry is malformed, the function does **not** keep walking left
  (entries further left are attacker-supplied) and returns `normalize(peer)`.
- If XFF is absent, it returns `normalize(peer)`. Only host-local tools get there,
  and they share one bucket.
- `normalize` lowercases the address, strips IPv6 brackets, and maps
  `::ffff:a.b.c.d` to `a.b.c.d`.

`server.ts` `fetch` computes
`ip = limiterKeyOf(clientIpOf({ peer: requestIP(req)?.address ?? "", forwardedFor: req.headers.get("x-forwarded-for"), trustProxy }))`
and uses it exactly where `ip` is used today. Supporting changes:

- New option `RelayServerOptions.trustProxy?: boolean`.
- `main.ts`: a boolean `--trust-proxy` flag and env `TENTACLE_RELAY_TRUST_PROXY`.
  The env var accepts `1`/`true`/`0`/`false`; anything else is refused, like
  every other value. Add it to `--help` too.
- `relay.service` ExecStart becomes
  `--host 127.0.0.1 --port 4100 --trust-proxy`. The three fleet flags are
  dropped, so the `relay-core.ts` defaults (30 / 16 / 10) apply per client.
  Rewrite the comment block at `relay.service:27-49`.

**(b) Caddyfile.relay.**

```caddy
relay.tentacle.so {
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
	# Only the relay's four routes; must match `relayRoute` (`server.ts`), pinned by deploy.test.ts.
	@unknown not path_regexp ^/(healthz|v1/daemon|v1/accept|d/[A-Za-z0-9_-]{22}/e2e)$
	respond @unknown 404
	reverse_proxy 127.0.0.1:4100 {
		header_up X-Forwarded-For {remote_host}
		stream_close_delay 5m
	}
}
```

- `respond` runs before `reverse_proxy` in Caddy's directive order, and `header`
  runs before both, so a 404 carries HSTS too.
- Removing a header with `-` is deferred automatically, so the upstream cannot
  re-add `Server` (Caddy docs, `header`).
- HSTS covers this name only: no `includeSubDomains`, no `preload`.
- The relay's own exact match (`server.ts:105-122`) stays as the second layer.
- Rewrite the comment at `Caddyfile.relay:37-45`, which says XFF is not read.

**(c) Frame, handshake and idle limits.**

1. `relaySocketOptions` gains `maxPayloadLength: RELAY_CONTROL_LIMITS.maxFrameChars`
   (98 304 B) and `perMessageDeflate: false`. Bun then refuses an oversized frame
   before it allocates it (H1). The app-level checks at `server.ts:362, 397, 496,
   504` stay as defence in depth.
2. **Pre-auth admission and deadline (H2).** The core gains a `pending` map:
   - `admitPending({ socket, ip })` is called from `open` for the `control` and
     `accept` roles. It is refused (close `4429`, the `RELAY_CLOSE_REFUSED` used
     today) past `pendingPerIp`.
   - The entry is settled on a successful `hello` or `accept`, and dropped on
     close.
   - `sweep()` closes every pending socket older than `RELAY_PREAUTH_MS = 10_000`
     with code `1008`.
   - Defaults: `pendingPerIp: 128`, at least 2× `streamsPerId` (64). A daemon
     that re-registers can release 64 held phones at once (`relay-core.ts:646-657`),
     which opens 64 accept legs from one IP in one burst, and none of them may be
     refused.
   - Both values are core limits, injectable in tests. They are **not** new
     flags, to keep the diff small.
3. **Pre-`ready` frames and ping rate (M1).** On a control socket that has no
   registered id, any frame other than `hello` gets close `1008` (today a
   pre-hello `ping` is answered). After `ready`, pings go through a new
   `core.ping(socket)`, which returns `[send pong]`, or `[close 1008]` past
   `pingsPerMinute: 30` in a fixed window per socket (the existing
   `chargeWindow`).
4. **Registered ids per IP (M2).** New limit `registeredPerIp: 32`, also exposed as
   flag `--max-ids-per-ip` / `TENTACLE_RELAY_MAX_IDS_PER_IP`, because the owner
   may need to raise it for a large NAT.
   - It is checked in `hello` for a NEW id only. An existing id may always come
     back, as F15 requires (`relay-core.ts:354-365`).
   - The count lives on `IpState.registered`. `Daemon` gains an `ip` field.
   - The count goes down in `controlClosed`, and in `hello`'s newest-wins branch
     for the REPLACED daemon. The replaced socket's later `controlClosed` then
     finds nothing (`relay-core.ts:570-577`) and must not decrement a second time.
5. **Idle timeout.** It stays at 60 s with pings. A registered socket legitimately
   lives forever, and NAT keepalive needs it.
6. **Header size and HTTP handshake.** No relay change (I1). Deploy step D2 only
   verifies Caddy's effective values.

**(d) Logs.** Add a new pure module, `apps/relay/src/log-limit.ts`:

- `createLogLimiter({ now, perWindow: 20, windowMs: 10_000 })` provides
  `admit(kind) → boolean` and `flush() → string[]`.
- The kind is a line's first word.
- `flush()` returns `log-suppressed <kind> <n>` for each window that has ended
  with suppressed lines.
- `server.ts` wraps `onLog` with it, and the existing sweep tick
  (`server.ts:534-536`) calls `flush()`. The first 20 lines of each kind in every
  10 s window always get through.

Content changes:

- Remove the stream-token prefixes from `dial-open`, `accept` and
  `accept-refused`; id prefixes stay (subject to Owner Q3).
- Bound Apple's `reason` to `^[A-Za-z]{1,64}$`, otherwise log it as `other`.
- IPs are never logged; this is pinned by a test.

**(e) Deploy.** See the "Deploy" section below.

**(f) Live smoke.** This is an owner/orchestrator step: Deploy step D5.

### Files

1. `apps/relay/src/client-ip.ts` (new, pure)
2. `apps/relay/src/log-limit.ts` (new, pure)
3. `apps/relay/src/relay-core.ts`:
   - limits `pendingPerIp`, `registeredPerIp`, `pingsPerMinute`
   - `RELAY_PREAUTH_MS`
   - `admitPending` / settle / drop
   - `ping()`
   - `Daemon.ip` and `IpState.registered`
   - `sweep` closing stale pending sockets
4. `apps/relay/src/server.ts`:
   - `trustProxy` and the client IP
   - `maxPayloadLength` and `perMessageDeflate` in `relaySocketOptions`
   - `admitPending` on open
   - the pre-`ready` guard and `core.ping`
   - the log limiter, the log-content changes, and the `RELAY_LIMIT_FLAGS` +
     `limitsFromFlags` entry for `max-ids-per-ip`
5. `apps/relay/src/main.ts`: `--trust-proxy`, `--max-ids-per-ip`, the env vars,
   and `USAGE`.
6. `apps/relay/deploy/relay.service`: the ExecStart and its comment.
7. `apps/relay/deploy/Caddyfile.relay`.
8. Tests: `apps/relay/test/{client-ip,log-limit}.test.ts` (new) and
   `{relay-core,server,main,deploy}.test.ts`.
9. `docs/ops/relay-deploy.md`:
   - §3/§4/§7: the podman commands
   - §5: the log-line list
   - §8: rows for the new log lines and for `4429` behind a NAT
   - §9: Known limitations rewritten — per-IP limits are now per client; the
     local-forger residual; the CGNAT note
10. `changelog.d/relay-hardening.security.md`

### Failure modes

| Failure | Convergence |
|---|---|
| **New unit, old binary**: the old binary exits 1 with `unknown argument: --trust-proxy`, and the crash loop parks the unit (start limit). | Deploy installs and checks the binary (`--help` lists `--trust-proxy`) BEFORE the unit. Rollback restores binary + unit + Caddyfile **together**. |
| `--trust-proxy` set while the relay is bound off-loopback by mistake | XFF is honoured only from a loopback peer, so an outside client cannot spoof it. Its limits stay keyed on its real address. |
| Caddy appends instead of replacing XFF / a client sends its own XFF | Right-most untrusted hop + explicit `header_up X-Forwarded-For {remote_host}`. A test covers `"spoofed, real"` → real. |
| Malformed right-most XFF entry | Falls back to the peer (one loopback bucket) and never walks into attacker-controlled entries. |
| **Carrier CGNAT / campus NAT**: many unrelated phones share one public IP, and 16 sockets / 30 dials per min may refuse them (`4429`) | The phone app redials, then falls back to direct paths. Refusals show as (rate-limited) `dial-refused` lines; the per-IP flags still exist to raise. Owner Q1. |
| Pre-auth deadline vs a slow daemon | The first frame is sent on open (`relay-link.ts:285, 470`), within one RTT, and 10 s is generous. A daemon that does get closed reconnects with backoff. |
| Release burst of 64 accept legs from one IP | `pendingPerIp` 128 ≥ 2×64. A core test pins that a full burst is admitted. |
| A legitimate 87 KiB frame vs `maxPayloadLength` | It is under 96 KiB. The existing `server.test.ts:312` test stays green. |
| An oversized frame is now closed by Bun (code chosen by Bun, not `4404`) | The `close` handler still closes the peer leg (`server.ts:379-384`). The app ignores close codes. The `server.test.ts:339` assertions change accordingly (Execution must record this). |
| Log limiter hides a first-ever error | The first 20 lines of each kind in every window always pass. A summary line counts the rest. |
| Caddy regex drifts from `relayRoute` | A `deploy.test.ts` table asserts regex ⇔ `relayRoute` (routable and non-routable paths). D3 also curls every route on the host. |
| `caddy reload` with a syntax error takes every site on the host down | D3 runs `caddy validate` inside the container before `reload`. |
| The restart and reload drop every relayed session | The 5 min `stream_close_delay` staggers it; phones resync (F1/F2) and daemons re-register with jitter (F3). Schedule it: Owner Q4. |
| A replaced daemon double-decrements `registered` | Core test: A → A′ (replace) → A′ closes → B from the same IP is admitted at `registeredPerIp: 1`, and so is the reverse order. |
| IpState eviction resets counters | A fairness reset that needs > 4096 IPs (I3 debt). It never crashes, and `releaseIp` on a missing entry does nothing (`relay-core.ts:679-684`). |

### Tests

Red first on the current code, then green. Real sockets on `127.0.0.1:0` use
the `relay()` / `open()` harness (`server.test.ts:26-80`), with injected `now`
plus `server.sweep()` for time. Each test names the property it pins and the
mutation that must turn it red.

- **T1 `client-ip.test.ts` (pure table).**
  - trust off → peer
  - trust on + peer `127.0.0.1` + `203.0.113.7` → `203.0.113.7`
  - `"1.1.1.1, 203.0.113.7"` → `203.0.113.7` (right-most)
  - `"203.0.113.7, 127.0.0.1"` → `203.0.113.7` (skips the trusted hop)
  - peer `198.51.100.1` with XFF → peer (spoof refused)
  - `"203.0.113.7, garbage"` → peer
  - empty or absent XFF → peer
  - `::ffff:203.0.113.7` → `203.0.113.7`
  - `limiterKeyOf("2001:db8:1:2:3:4:5:6")` → `2001:db8:1:2::/64`, also from the
    compressed `2001:db8:1:2::9`
  - Mutations that must go red: take the left-most entry; drop the loopback-peer
    check.
- **T2 server, real socket.** With `trustProxy: true`, a phone dial carrying
  `X-Forwarded-For: 203.0.113.7` produces `open.ip === "203.0.113.7"`. It is red
  today (P2). With `concurrentPerIp: 1`, two different XFF values are both
  admitted, and a second dial with the first value is refused `4429`. With
  `trustProxy` false, XFF is ignored and the result is `127.0.0.1`. Mutation:
  ignore `trustProxy` → the third case goes red.
- **T3 `maxPayloadLength`, real socket.** A 200 KiB frame on a spliced phone leg
  closes it and its accept leg, and `lines` has **no** `frame-oversize` line,
  because the frame never reached JS. The same holds for `/v1/daemon`, with no
  `control-oversize` line. Red today (P3). The 87 KiB test stays green. Update
  `server.test.ts:183-190` for the two new options. Mutation: remove
  `maxPayloadLength` → red.
- **T4 pre-auth deadline.**
  - A silent `/v1/daemon` socket and a silent `/v1/accept` socket are both closed
    `1008` after `now += 10_001` and `sweep()`.
  - A socket that sent `hello` is NOT closed.
  - Red today (P1).
  - Mutation: skip the pending sweep → red.
- **T5 pending cap.** With `pendingPerIp: 2`, a third pre-auth socket from the
  same IP closes `4429`. After one socket says `hello`, a new one is admitted. A
  core test admits a 64-accept burst at the default.
- **T6 ping.** A ping before `hello` closes `1008`; red today, since it gets a
  pong (`server.test.ts:271` must then ping after `hello`). With
  `pingsPerMinute: 2`, the third ping in the minute closes the socket; red today.
- **T7 `registeredPerIp` (core).**
  - A second NEW id from the same IP is refused `busy` and closed.
  - The same id re-registering is admitted (newest-wins).
  - The decrement on close and on replacement happens exactly once (both orders
    above).
  - Flag mapping in `server.test.ts:192`.
- **T8 logs.**
  - The pure limiter: 20 lines admitted, then suppressed, then one summary with
    the exact count after the window.
  - Server: 40 refused dials give ≤ 20 `dial-refused` lines plus
    `log-suppressed dial-refused <n>`.
  - With XFF `203.0.113.7`, no captured line contains that address or any full
    22-char id or token (extend `server.test.ts:514`).
  - Apple reason `"Bad\nToken"` is logged as `other`.
- **T9 `deploy.test.ts`.**
  - Replace the tests at `:145-176` and `:178-195`: ExecStart passes
    `--trust-proxy` and NONE of the three per-IP flags, so the defaults apply.
    Red today.
  - The Caddyfile has `Strict-Transport-Security`, `-Server`,
    `header_up X-Forwarded-For {remote_host}` and `stream_close_delay 5m`.
  - Extract the `path_regexp` from the Caddyfile and assert, for a table of paths
    (the 4 routes, `/`, `/d/<21 chars>/e2e`, `/d/<id>/e2e/x`, `/v1/daemon/`,
    `/healthz?x` path-only), that the regex matches ⇔
    `relayRoute(p).kind !== "notfound"`. Red today, because there is no regex.
  - The runbook §9 no longer says "ONE shared bucket" as current state, and §4
    contains the `podman exec caddy caddy reload` command.
  - Mutation: drop `healthz` from the regex → red.
- **T10 `main.test.ts`.**
  - `--trust-proxy` → `trustProxy: true`
  - env `TENTACLE_RELAY_TRUST_PROXY=1` → true; `=yes` → error; default false
  - `--max-ids-per-ip 5` parses
  - `relayUsage()` names both flags

Gate before done: `bun test`, `bun run typecheck` (it includes
`tsc -p apps/relay`), and `bun run lint` (baseline clean). If podman or docker is
available locally, also run
`docker run --rm -v "$PWD/apps/relay/deploy:/c:ro" caddy:2.8.4 caddy validate --config /c/Caddyfile.relay --adapter caddyfile`.
If not, say so; D3 validates it on the host anyway.

### Deploy (owner/orchestrator, after merge — never an executor)

All host commands run as root on `142.132.169.22`. Run in a window chosen per
Owner Q4. Every relayed session drops, staggered over at most 5 min.

- **D0 Build** (laptop, merged `main`):
  ```sh
  bun apps/relay/deploy/build.ts
  shasum -a 256 dist/tentacle-relay
  scp dist/tentacle-relay root@142.132.169.22:/opt/tentacle-relay/tentacle-relay.new
  scp apps/relay/deploy/relay.service root@142.132.169.22:/root/relay.service.new
  scp apps/relay/deploy/Caddyfile.relay root@142.132.169.22:/root/Caddyfile.relay.new
  ```
- **D1 Back up** all three artefacts (rollback restores them together):
  ```sh
  cp -p /opt/tentacle-relay/tentacle-relay /opt/tentacle-relay/tentacle-relay.previous
  cp -p /etc/systemd/system/relay.service /root/relay.service.previous
  cp -p /etc/caddy/relay.tentacle.so.caddy /root/relay.tentacle.so.caddy.previous
  ```
- **D2 Binary first, then unit:**
  ```sh
  sha256sum /opt/tentacle-relay/tentacle-relay.new         # = D0
  chown root:root /opt/tentacle-relay/tentacle-relay.new && chmod 0755 /opt/tentacle-relay/tentacle-relay.new
  /opt/tentacle-relay/tentacle-relay.new --help | grep -- --trust-proxy   # MUST print, else stop
  mv -f /opt/tentacle-relay/tentacle-relay.new /opt/tentacle-relay/tentacle-relay
  install -o root -g root -m 0644 /root/relay.service.new /etc/systemd/system/relay.service
  systemd-analyze verify /etc/systemd/system/relay.service
  systemctl daemon-reload && systemctl restart relay.service
  systemctl status relay.service --no-pager                # active (running)
  curl -sS http://127.0.0.1:4100/healthz                   # {"ok":true,"v":1}
  systemctl show relay.service -p ExecStart                # --trust-proxy, no --max-* flags
  # I1 check: Caddy's effective header/timeout settings (empty = Caddy defaults)
  podman exec caddy caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile | grep -o '"timeouts\|max_header_bytes[^,]*' || true
  ```
- **D3 Caddy:**
  ```sh
  install -o root -g root -m 0644 /root/Caddyfile.relay.new /etc/caddy/relay.tentacle.so.caddy
  podman exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile   # MUST pass, else restore .previous
  podman exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  ```
  Then, from **outside** the host:
  ```sh
  curl -sSI https://relay.tentacle.so/healthz          # 200, Strict-Transport-Security present, no Server header
  curl -sS -o /dev/null -w '%{http_code}\n' https://relay.tentacle.so/          # 404
  curl -sS -o /dev/null -w '%{http_code}\n' https://relay.tentacle.so/.env      # 404
  curl -sS -o /dev/null -w '%{http_code}\n' https://relay.tentacle.so/v1/daemon # 426 (from the relay: route passes)
  curl -sS -o /dev/null -w '%{http_code}\n' https://relay.tentacle.so/d/AAAAAAAAAAAAAAAAAAAAAA/e2e  # 426
  ```
- **D4 Per-client buckets are real** (laptop): open 17 concurrent dials to
  `/d/AAAAAAAAAAAAAAAAAAAAAA/e2e` (a bun one-liner with `new WebSocket` ×17).
  The 17th must close `4429` while the first 16 are held, and later close `4404`.
  The journal shows `dial-refused concurrency`, rate-limited.
- **D5 Live smoke (owner):** run `tentacle serve --relay wss://relay.tentacle.so`
  on the laptop. The journal shows `ready <id8>`. During D4's held window, open
  the app on the iPhone **on cellular, Wi-Fi off**: it must connect, which proves
  the phone has its own bucket. Drive one message and expect a reply. The journal
  shows `dial-open` / `accept` with id prefixes only and no IP:
  `journalctl -u relay.service --since "15 min ago" | grep -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'`
  must be empty. Record the result in this doc's Execution, signed.
- **Rollback** (any step fails):
  ```sh
  install -o root -g root -m 0755 /opt/tentacle-relay/tentacle-relay.previous /opt/tentacle-relay/tentacle-relay
  install -o root -g root -m 0644 /root/relay.service.previous /etc/systemd/system/relay.service
  install -o root -g root -m 0644 /root/relay.tentacle.so.caddy.previous /etc/caddy/relay.tentacle.so.caddy
  systemctl daemon-reload && systemctl restart relay.service
  podman exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && \
    podman exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  curl -sS https://relay.tentacle.so/healthz
  ```
  Never restore the unit without the binary, or the binary without the unit. The
  old binary rejects `--trust-proxy`, and the new binary without the flag puts the
  whole world in one bucket at the per-client defaults (16 sockets for everyone).

### Owner questions

1. **Per-client limits vs shared mobile IPs.** With real IPs the defaults become
   per client: 16 open phone sockets, 30 dials/min and 10 registrations/min per
   public IP, plus (new) 32 computers registered per IP. Phone carriers sometimes
   put many unrelated phones behind one IP. **Recommendation:** keep the
   defaults, watch the journal for `dial-refused` in the first week, and raise
   them only if they show up (the flags stay).
2. **The computer learns the phone's public IP.** Today the computer always
   receives `127.0.0.1` as the phone's address. After this change it receives the
   phone's real public IP (IPv6 trimmed to /64), used only for its own anti-flood
   limiter and stored nowhere. **Recommendation:** yes. It is the user's own phone
   talking to the user's own computer, and it makes the computer's anti-flood
   protection work per phone.
3. **Logs.** Keep the 8-character computer-id prefix in the logs (needed to answer
   "is my computer connected?"), drop the stream-token prefixes, never log IPs,
   and cap each kind of line at 20 per 10 s. **Recommendation:** yes, as planned.
4. **When to roll it out.** Deploying restarts the relay and reloads Caddy. Every
   phone session that goes through the relay drops once (spread over up to
   5 minutes) and reconnects by itself. **Recommendation:** one evening window,
   with the iPhone smoke test (D5) right after, done by you.

## Execution

*— claude-sonnet-4-5, 2026-11-15*

**Load-bearing check (re-run first).** Both halves hold, verified, not assumed:

1. **Repro reproduced verbatim** (`.tentacle/tmp/relay-hardening/probe.ts`, repo
   root, Bun 1.4.3, worktree `e57a8f8e`):
   `P1 silent pre-auth sockets still open after 5s (idleTimeout=2s): 100/100` ·
   `P2 daemon frames: … | {"t":"open","stream":"wXpCed6Hx2xnmN_MUxamvg","ip":"127.0.0.1"}`
   with `X-Forwarded-For: 203.0.113.7` sent · `P3 phone close code after 4 MiB
   frame: 4404` + `log: frame-oversize s102` (an APP close, so the 4 MiB string
   was allocated). All three findings stand.
2. **The assumption itself** (`.tentacle/tmp/relay-hardening/lb-probe.ts`):
   `(a) ExecStart: … --host 127.0.0.1 --port 4100` and `DEFAULT_RELAY_HOST=127.0.0.1`
   (the socket's only reachable peer is loopback), and `(b) xff=203.0.113.7
   peer=127.0.0.1 | xff=1.1.1.1, 203.0.113.7 peer=127.0.0.1 | xff=null
   peer=127.0.0.1` — Bun's `fetch` DOES see a hop's `X-Forwarded-For`, so
   honouring it is implementable and cannot be spoofed from off-host. So
   "loopback-only peer + honest Caddy header" holds; proceeded.

**As built, in the plan's dependency order.** Each slice: test written and shown
red, then green; narrow file run per slice.

- **Slice 1 — `apps/relay/src/client-ip.ts` (new, pure) + `test/client-ip.test.ts`.**
  `isLoopback` / `normalizeAddress` / `clientIpOf` / `limiterKeyOf` exactly as
  Design (a), plus two decisions the design left open: a peer/ hop is normalised
  before comparison (so `::ffff:127.0.0.1` and `::FFFF:127.0.0.1` are loopback),
  and an IPv6 client is collapsed to its `/64` via a real 8-hextet expansion
  (not a string slice), so `2001:db8:1:2::9` and `2001:db8:1:2:3:4:5:6` share one
  key. Red: module absent. Green: 15 tests.
- **Slice 2 — `apps/relay/src/log-limit.ts` (new, pure) + `test/log-limit.test.ts`.**
  `createLogLimiter({now, perWindow: 20, windowMs: 10_000})` with `admit(line)` /
  `flush()`, kind = first word. **Drift from the design, deliberate:** the design
  said `flush()` reports "for each window that has ENDED", which a single
  `admit`-only roll-over cannot see (nothing runs between the last suppressed line
  and the flush). So a window keeps `admitted`/`suppressed`/`since`, and
  `flush()` calls the same `settle()` that `admit` does, then reads an `owed` map
  — owed counts survive further windows, so a burst separated in time still
  yields ONE summary with the summed count. This is the version that satisfies
  the plan's own test ("one summary with the exact count after the window").
  Red: module absent. Green: 8 tests.
- **Slice 3 — `apps/relay/src/relay-core.ts`.** `RELAY_LIMITS.pendingPerIp` (128),
  `registeredPerIp` (32), `pingsPerMinute` (30); `RELAY_PREAUTH_MS` (10 s);
  `admitPending` / `pendingClosed` / `pendingCount`; `ping()`; `Daemon.ip` and
  `IpState.registered` / `IpState.pending`; `sweep()` closes stale pre-auth
  sockets `1008`; `hello` enforces `registeredPerIp` for a NEW id only and
  settles the pending slot; `accept` settles it too; `controlClosed` releases
  `registered` and drops the ping window. The replaced-daemon decrement is done
  in `hello` (exactly once in either order, `releaseRegistered` never goes below
  0), which is what the plan's double-decrement failure mode asked for. Red:
  `RELAY_PREAUTH_MS` not exported. Green: 36 tests.
- **Slice 4 — `apps/relay/src/server.ts`.** `trustProxy` option; the `fetch`
  key is `limiterKeyOf(clientIpOf({peer, forwardedFor, trustProxy}))`;
  `relaySocketOptions` gains `maxPayloadLength: 96 KiB` + `perMessageDeflate:
  false`; `open` admits non-phone legs (`pending-refused` past the cap, close
  `4429`); `close` settles an untokened accept leg; a pre-`ready` `ping` is
  `control-unexpected` + `1008` while a registered one goes through `core.ping`;
  every line goes through the log limiter, whose `flush()` is drained on the
  sweep tick AND on the test-facing `sweep()`; `loggableApnsReason` bounds
  Apple's reason; `RELAY_LIMIT_FLAGS`/`limitsFromFlags` gain `max-ids-per-ip`.
  Log content: `dial-open <id>` (token prefix gone), `accept <id>` (token prefix
  gone), `accept-refused <reason>` (attacker-chosen prefix gone).
- **Slice 5 — `apps/relay/src/main.ts`.** `--trust-proxy` (no value),
  `TENTACLE_RELAY_TRUST_PROXY` strictly `1|true|0|false`, `--max-ids-per-ip` /
  `TENTACLE_RELAY_MAX_IDS_PER_IP`, both in `USAGE`, and `trustProxy` passed into
  `startRelay`.
- **Slice 6 — deploy artefacts.** `relay.service`: `ExecStart=… --host 127.0.0.1
  --port 4100 --trust-proxy`; the three fleet-sized flags are GONE (the comment
  block is rewritten to say why, and that the per-client defaults now apply).
  `Caddyfile.relay`: `header { Strict-Transport-Security … ; -Server }`, an
  `@unknown not path_regexp ^/(healthz|v1/daemon|v1/accept|d/[A-Za-z0-9_-]{22}/e2e)$
  → respond 404`, `header_up X-Forwarded-For {remote_host}`, `stream_close_delay
  5m` kept, and the false "the relay does not read X-Forwarded-For" comment
  replaced.
- **Slice 7 — `docs/ops/relay-deploy.md`.** §4/§7 Caddy commands are the podman
  ones (`podman exec caddy caddy validate|reload --config /etc/caddy/Caddyfile
  --adapter caddyfile`), §4 gains the outside-host 404 checks and the
  flag↔header pairing, §5 lists `pending-refused` / `log-suppressed` and drops
  `<stream>`, adds the "no IP in the journal" command, §8's table gains three
  rows (`4429` behind a NAT, `log-suppressed`, "every client looks like
  127.0.0.1 again") and the podman Caddy commands, §9's first bullet is
  rewritten (per-client limits + the local-forger residual + the CGNAT note; the
  fleet sizes are recorded as deliberately removed).
- **Slice 8 — changelog.** `changelog.d/relay-hardening.security.md`, one bullet;
  `CHANGELOG.md` untouched.

**Drift from the Implementation (and why).**

1. **`log-limit.ts` needs an `owed` map** — see slice 2. The design's
   `flush()`-only settlement cannot observe a window that ended without a new
   line; the summary would then never appear, i.e. the plan's own guarantee
   ("what was hidden is never silent") would be false. Implementation is
   strictly larger than the sketch, same interface.
2. **`loggableApnsReason` is `^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`, not
   `^[A-Za-z]{1,64}$`.** The plan's regex would log `push <tok> unavailable
   timeout` as `… other` and, worse, would turn the client's own bounded reasons
   (`timeout`, and the clipped `ExpiredProviderToken`-class words) into `other`.
   The property the finding needs is "no newline, no unbounded growth, no
   control chars", which the wider class gives while keeping real reasons
   readable. Pinned by a test on both classes and on the `Bad\nToken` case.
3. **`server.test.ts`'s 97 KiB splice test now asserts Bun's close code**, as the
   plan's failure-mode table predicted: `maxPayloadLength` refuses the frame
   before any handler, so the code is Bun's (observed `1006`; the assertion
   accepts `1006`/`1009`) and there is **no** `frame-oversize` line any more. The
   87 KiB test is unchanged and green.
4. **`open()` in `server.test.ts` grew a `headers` parameter** instead of adding
   a second, parallel socket helper: one harness, one set of semantics. (First
   draft added `openWithXff`; it duplicated 45 lines and was removed.)
5. **The `ExecStart` continuation reader test now uses a synthetic unit.** The
   live `ExecStart` is a single line, so binding that guard to the live text
   would have tested the unit rather than the reader. Its `--max-hellos-per-minute
   600` assertion (which existed only to prove the reader kept a continuation)
   went with it; the "exactly one live ExecStart line" assertion stayed.
6. **The Caddyfile assertions read the file with comments stripped**
   (`caddyDirectives`). The first draft asserted `not.toContain("includeSubDomains")`
   on the whole file, which the comment explaining *why not* tripped — a false
   red on a correct artefact.
7. **`RELAY_LIMITS.pingsPerMinute` is a core limit, not a flag** (design said so
   implicitly by listing only `max-ids-per-ip` as a flag); it is not in
   `RELAY_LIMIT_FLAGS`, so an operator cannot raise a ping flood limit.
8. **No `protocol.d/` note and no `PROTOCOL_VERSION` bump**: the limiter key
   reaches the daemon only as `open.ip`, whose schema is `z.string().min(1).max(64)`
   and which the daemon uses as an opaque limiter key (`relay-link.ts:421`). A
   `/64` string such as `2001:db8:1:2::/64` is wire-compatible. `git status
   packages/` is empty, so `packages/protocol/schema/protocol.json` needed no
   regeneration.

**Mutations (each run, output pasted, file restored byte-for-byte from
`.mutsave/`, then `bun test apps/relay` → 212 pass).**

| # | Mutation | Tests that went RED |
|---|---|---|
| M1 | `clientIpOf` walks hops from the LEFT | 3: "RIGHT-MOST hop wins", "malformed right-most falls back", "at most 16 hops" |
| M2 | drop the loopback-peer check | 1: "a NON-loopback peer's header is never read" |
| M3 | `server.ts` ignores `options.trustProxy` | 2: "the dial's XFF becomes open.ip", "two XFF values are two buckets" |
| M4 | `maxPayloadLength` removed | 2: "refused by BUN", "a 97 KiB frame closes BOTH legs" |
| M5 | `sweep()` skips pending sockets | 2: core "silent pre-auth socket closed 1008", server "silent /v1/daemon and /v1/accept closed" |
| M6 | `ping` rate limit = ∞ | 3: core ×2 ("third ping", "per socket"), server "past pingsPerMinute" |
| M7 | `registeredPerIp` check removed | 3: "a second NEW id refused", "decrements exactly ONCE", "reverse order" |
| M8 | replaced daemon: skip `releaseRegistered` | 1: "the count returns on close, and on replacement exactly ONCE" |
| M9 | log limiter keys on one `"all"` bucket | 5: "each kind has its own budget", "one summary…", "new window admits again", "survives several ended windows", "injectable" |
| M10 | summary line dropped | 4: the four `flush()`-count tests |
| M11 | Caddy regex without `healthz` | 1: "the Caddy route regex matches EXACTLY what `relayRoute` serves" |
| M12 | `--trust-proxy` parsed but not applied | 3: main "--trust-proxy off by default and on when passed", deploy "continued ExecStart", deploy "live ExecStart requests --trust-proxy" |
| M13 | log the whole stream token again | 2: "no captured line contains … a full token", "the captured log has no … stream token" |
| M14 | pre-auth cap removed | 3: core "closed pre-auth socket releases its slot", core "cap is per IP", server "past pendingPerIp refused 4429" |

M8 is the plan's double-decrement target specifically ("mutation-check the
plan's targets"): it fails exactly one test, in the direction the failure-mode
table predicted.

**Gate.** `bunx tsc --noEmit` clean, `bun run typecheck` clean (`tsc --noEmit &&
tsc -p apps/mobile && tsc -p apps/relay`), `bun run lint` clean (`biome check .`,
0 errors / 0 warnings — the baseline of AGENTS §6), `bun test` **10381 pass, 4
skip, 0 fail** (80444 expect() calls, 742 files). The 4 skips are all pre-existing
opt-ins: live-k8s, live-docker (two files: `packages/docker` and
`packages/cli/session-hop.docker`) and the real-socket keepalive; none in
`apps/relay`. `bun test apps/relay` alone: 212 pass, 0 fail.

**Not verified here (and how to verify).** The deploy steps D2/D3 are the
owner's, on the host: `caddy validate` inside the podman container, the
`--help | grep -- --trust-proxy` check, the outside-host 404s, and D4/D5 (17
concurrent dials → the 17th `4429`; the iPhone on cellular). No podman/docker was
run locally for the Caddyfile — the test pins the directives *and* the regex
against `relayRoute`, but only `caddy validate` on the host proves Caddy accepts
the file. D5's IPv6 assertion (`limiterKeyOf`) is covered by unit tests only,
because the deploy host has no `AAAA` record today.

## Review

*(empty)*

#### Orchestrator decisions (owner night delegation 2026-11-15)

Every owner question: the recommendation. Exception, Q4 (roll-out): merge only; the deploy to 142.132.169.22 waits for the owner (morning), following the plan's deploy section with rollback.
*— claude-opus-5-5 (orchestrator), 2026-11-15*
