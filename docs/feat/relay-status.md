# feat/relay-status — loopback-only `/__status` on relay and apps-host

> **Status:** implementation — **APPROVED** (owner delegated the details, 2026-11-26)
> **Branch:** `feat/relay-status`
> **Size:** S–M · **Blast:** contained (`apps/relay`, `apps/apps-host`) · **Suited:** Sonnet exec + standard review
> **Changelog:** `changelog.d/relay-status.added.md`

## Context

*— claude-sonnet-5-5, 2026-11-26*

Neither hosted service can be monitored: `/healthz` carries no counters, by design
(`apps/relay/src/server.ts:362-366`, `apps/apps-host/src/server.ts:561-563`). TODO
**feat/relay-status** is step 1 of monitoring: each service answers `GET /__status`,
local to the host only, with aggregate numbers (no ids, IPs, keys or names) and a
per-minute 24 h history held in memory. Merge tonight; **no deploy** (27/11 demo
freeze). Journal summary line and `ops:status` over SSH are later steps.

**Repro** (`.tentacle/tmp/relay-status/repro.ts`, run 2026-11-26 22:49):

```ts
import { networkInterfaces } from "node:os";
import { startRelay } from "../../worktrees/relay-status/apps/relay/src/server.ts";

const relay = startRelay({ port: 0, trustProxy: true });
const res = await fetch(`http://127.0.0.1:${relay.port}/__status`);
console.log("relay /__status today:", res.status, await res.text());
relay.stop();

const probe = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: (req, srv) => Response.json({ peer: srv.requestIP(req)?.address,
    xff: req.headers.get("x-forwarded-for"), host: req.headers.get("host") }),
});
const proxied = await fetch(`http://127.0.0.1:${probe.port}/`, {
  headers: { "X-Forwarded-For": "203.0.113.7" } });
console.log("proxied-shaped:", await proxied.text());

const lan = Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
if (lan === undefined) console.log("no LAN address");
else try {
  await fetch(`http://${lan}:${probe.port}/`, { signal: AbortSignal.timeout(2000) });
  console.log("LAN dial: REACHED");
} catch (error) { console.log("LAN dial: refused", (error as { code?: string }).code); }

try {
  Bun.serve({ hostname: "127.0.0.1", port: probe.port, fetch: () => new Response() }).stop(true);
  console.log("second bind: SUCCEEDED");
} catch (error) { console.log("second bind: threw", (error as { code?: string }).code); }
probe.stop(true);
```

```
relay /__status today: 404 not found
proxied-shaped: {"peer":"127.0.0.1","xff":"203.0.113.7","host":"127.0.0.1:52045"}
LAN dial: refused ECONNREFUSED
second bind: threw EADDRINUSE
```

## Implementation

*— claude-sonnet-5-5, 2026-11-26* · **APPROVED**

### Orchestrator decisions

| # | Question | Decision |
|---|---|---|
| D1 | How to keep Caddy's traffic out | **A separate listener**, hostname hard-coded `127.0.0.1` (never `--host`), relay port **4101**, apps-host **4201**. The public listeners get no new route. Plus a request gate (below) as a second lock. Rejected: a route on the public port guarded by headers only, since one proxy edit would publish it. |
| D2 | On or off | On by default in both binaries (no unit change needed at the next deploy). `--status-port <port\|off>`, env `TENTACLE_RELAY_STATUS_PORT` / `TENTACLE_APPS_STATUS_PORT`. Library default (`startRelay` / `startAppsHost` without `statusPort`): off. |
| D3 | Status port busy | **Fail soft**: log `status-off <code>`, the service starts without it. Monitoring never takes the relay down. |
| D4 | Status port = main port | Refused at argument parse, in both binaries. |
| D5 | Local users on the box | Any local process may read it: aggregate numbers only, no token. |
| D6 | History shape | Counters summed per minute; gauges keep the last sample of the minute. Sparse (a minute with nothing recorded is absent and means "no data"; an absent field in a present entry means 0). 1440 minutes, reset on restart. |

No AGENTS §7 trust rule is weakened (no owner question): the relay learns and
carries nothing new, and nothing new is reachable through the proxy.

### Load-bearing assumption

"The peer is loopback" does **not** separate local callers from Caddy's: Caddy dials
`127.0.0.1` (`Caddyfile.relay:37`, `Caddyfile.apps:31`), and the repro shows a
proxied-shaped request with peer `127.0.0.1`. What does separate them is the
**port**: Caddy forwards only to 4100 / 4200, so a second listener bound to
`127.0.0.1` is reached by neither Caddy (as configured) nor the network (repro:
LAN dial `ECONNREFUSED`).

### Preconditions

- Relay public routes are a closed table; `/__status` is already `notfound`
  (`apps/relay/src/server.ts:123-140,367-369`), and Caddy 404s it before the process
  (`Caddyfile.relay:34-35`).
- Apps Caddy forwards **every** path to 4200 (`Caddyfile.apps:31-35`); the process
  404s `/__status` on the apex (`routes.ts:34-45`), on app hosts
  (`server.ts:590-592`) and on unknown hosts (`server.ts:650-653`).
- Caddy overwrites `X-Forwarded-For` (`Caddyfile.relay:42`, `Caddyfile.apps:33`).
- `isLoopback` exists (`apps/relay/src/client-ip.ts:52-62`); apps-host already imports
  relay modules through package exports (`apps-host/src/server.ts:15-16`,
  `apps/relay/package.json:7-12`).
- Every relay event passes one `log` closure **before** the flood limiter
  (`relay/src/server.ts:248-252`), so counting there is not capped at 20 lines / 10 s.
- Relay gauges: `registeredCount`, `heldCount`, `streamCount`
  (`relay-core.ts:402-414`; a phone leg is a hold or a stream); `peers` is symmetric,
  so pairs = `peers.size / 2` (`server.ts:301-314,477-481`).
- APNs sends never throw (`apns-client.ts:57-60`).
- Apps host: live bytes are summed from records with `state === "live"`
  (`host-core.ts:636-642`); kill mode is `operator.current().kill`
  (`operator-files.ts:16`, `server.ts:191`); sweep every 10 s (`limits.ts:52`).

### Design

**Shared, pure** — `apps/relay/src/status.ts`:

- `createMinuteStats({ now, counters })`: `add(name, n = 1)`, `set(gauge, value)`,
  `snapshot()` → `{ uptimeSeconds, totals, lastMinute, history }`. A 1440-slot ring
  indexed by `minute % 1440`, each slot tagged with its minute (a stale slot is reset
  on write and ignored on read; so are slots from the "future" after a clock step
  back). `lastMinute` = the previous **complete** minute, every counter, zero-filled.
  `history` = oldest first, `{ at: <minute start, epoch ms>, ...fields }`.
- `statusResponse({ method, pathname, peer, headers }, body: () => object)`: 200 JSON
  (`Cache-Control: no-store`) only if ALL hold: `GET`; path exactly `/__status`;
  `isLoopback(peer)`; none of `forwarded`, `x-forwarded-for`, `x-forwarded-host`,
  `x-forwarded-proto`, `x-real-ip`, `via`; `Host` name (port stripped) is
  `127.0.0.1`, `localhost` or `[::1]`. Anything else: `404 not found`, and `body` is
  not called.

**Shared, I/O** — `apps/relay/src/status-listener.ts`:
`startStatusListener({ port, body, log })` → `{ port, stop() } | undefined`.
`Bun.serve` on the constant `"127.0.0.1"`, `development: false`, peer from
`requestIP` (absent → `""` → 404); a bind error logs `status-off <code>` and returns
`undefined`; an `error` handler answers a bare 500.

**Relay** — pure `apps/relay/src/relay-counters.ts` maps a log line to a counter:

| Line kind (`server.ts`) | Counter |
|---|---|
| `dial-open`, `dial-held` | `dials` (admitted) |
| `ready` | `registrations` |
| `dial-refused rate` / `… concurrency` | `refusedRate` / `refusedConcurrency` |
| `pending-refused` / `hello-refused` / `accept-refused` | `refusedPending` / `refusedHello` / `refusedAccept` |
| `phone-oversize-drop`, `frame-oversize`, `control-oversize`, `accept-oversize` | `refusedOversize` |
| `push-refused`, `liveactivity-refused`: 3rd word `throttled` / otherwise | `refusedThrottled` / `pushesRejected` |
| `push-rejected`, `liveactivity-rejected` | `pushesRejected` |
| `push`, `liveactivity`: 3rd word `sent` / otherwise | `pushesSent` / `pushesFailed` |
| anything else (incl. `log-suppressed`) | none |

`server.ts` changes, no policy: count in `log` before `admit`; `bytesRelayed` where a
frame is handed to the other leg (`forward` to a peer, and the `join` flush; text
measured with `Buffer.byteLength`); `refusedPing` when `core.ping` returns a close;
gauges sampled in the timer tick and `sweep()`, and again when the body is built.
`RelayServerOptions.statusPort?`, `RunningRelay.statusPort`; `stop()` stops it.

Body:

```
{ service: "relay", uptimeSeconds, memory: { rssBytes, heapUsedBytes },
  now: { registeredDaemons, deviceLegs, splicedPairs },
  totals: {…counters}, lastMinute: {…counters}, history: [ … ] }
```

**Apps host** — `HostCore.liveStats()` → `{ apps, bytes }` over live records.
Counters `requests` (every request reaching `fetch`, all hosts) and `reports` (only a
stored one, next to `log(\`report …\`)`, `server.ts:551`). Gauges `liveApps`,
`storeBytes`, sampled in `sweepOnce` and when the body is built.
`storeBytes` = live content bytes (not records, reports or filesystem overhead).
Body: `service: "apps-host"`, same envelope,
`now: { liveApps, storeBytes, killSwitch: "off" | "publish" | "all" }`.
`AppsHostOptions.statusPort?`, `RunningAppsHost.statusPort`; `stop()` stops it.

### Files

1. `apps/relay/src/status.ts`, `status-listener.ts` (new); `package.json` exports
   `./status`, `./status-listener`.
2. `apps/relay/src/relay-counters.ts` (new); `server.ts`; `main.ts`
   (`DEFAULT_RELAY_STATUS_PORT = 4101`, `--status-port`, env, D4, `--help`, pass-through,
   print `relay status on http://127.0.0.1:<port>/__status` when it is up).
3. `apps/apps-host/src/host-core.ts`, `server.ts`, `main.ts` (same, 4201).
4. `docs/ops/relay-deploy.md` §9 and `docs/ops/apps-host-deploy.md`: a few lines —
   `curl http://127.0.0.1:4101/__status` (4201), also through `ssh -L`; never proxy it.
5. `changelog.d/relay-status.added.md`:
   `- **Local status on the relay and the apps host.** Each answers \`GET /__status\` on a separate loopback-only port (4101 / 4201, \`--status-port\`) with aggregate counters and a 24 h per-minute history.`

No protocol change, no `protocol.d/` note, no unit or Caddyfile change.

### Failure modes

| Case | Outcome |
|---|---|
| Proxy later pointed at the status port | Caddy sends `X-Forwarded-*` and the public `Host` → 404 |
| Public `/__status` (any Host, forged headers) | unchanged 404; no new route there |
| Non-loopback peer | cannot connect (bind); the gate 404s it anyway |
| `--host 0.0.0.0` | status stays on `127.0.0.1` |
| Port taken / second instance | `status-off EADDRINUSE`, service runs |
| Refusal flood | counted before the log limiter; memory fixed (1440 slots) |
| Idle process, clock step, > 24 h gap | stale/future slots filtered by their minute tag |
| Restart | counters and history reset (documented) |
| Frame above Bun's `maxPayloadLength` | closed by Bun before any handler (`server.ts:161-169`): **not counted** in `refusedOversize` |

### Tests

Red first: the new modules/options do not exist, so write the tests, run them, paste
the failures, then implement.

- `apps/relay/test/status.test.ts` (injected clock): totals; minute rollover;
  `lastMinute` zero-filled and excluding the current minute; gauges keep the last
  sample; ring keeps exactly 1440 minutes; gap > 24 h; clock step back. Gate table:
  loopback forms → 200; **non-loopback peer (`203.0.113.7`, `""`) → 404**; each proxy
  header alone → 404; public `Host` → 404; `POST`, other path → 404; `body` never
  called on a 404.
- `apps/relay/test/relay-counters.test.ts`: the mapping table.
- `apps/relay/test/server-status.test.ts` (real sockets, poll conditions, no sleeps):
  status 200 on `statusPort: 0`; public port `/__status` 404, also with
  `trustProxy` + XFF + `Host: 127.0.0.1`; XFF on the status port → 404; register +
  dial + accept + frames both ways → gauges, `dials`, exact `bytesRelayed` (including
  one frame buffered before accept); more than 20 refused dials all counted; occupied
  status port → relay serves, `statusPort` undefined; `stop()` closes it. A fake APNs
  client gives `pushesSent` / `pushesFailed` (pattern: `server-push.test.ts`).
  **Privacy:** every leaf of the body is a number, except `service`; neither the relay
  id, the secret, a token nor a client IP appears in the text.
- `apps/apps-host/test/status.test.ts` (`test/support/host.ts` seams): 200 with
  `liveApps` / `storeBytes` after a publish; `requests`, `reports` (a refused report
  not counted); kill switch reflected; public `/__status` 404 on apex, app host and
  unknown host; leaves are numbers except `service` / `killSwitch`; no app id, key or IP.
- `main.test.ts` (both): default, flag, env, `off`, invalid, equal to `--port`.
  Existing full-object `toEqual` expectations gain `statusPort`.
- `deploy.test.ts` (both): no Caddy directive names the status port.

The public-404 and Caddy pins are green on old code (regression guards). Non-vacuity
by mutation, then revert: drop the `isLoopback` check, then the header check → the
gate tests must fail.

Gate: the four test directories' files above, then `bun run check`.

### Notes / debt

- Journal summary line and `ops:status` over SSH: later steps.
- Counting from log lines couples counters to line kinds; the socket test and the
  mapping table pin it.
- 4101 / 4201 were not checked on the box (no deploy); D3 covers a clash, and the
  start log shows whether status is up.
- Bun-level oversize closes stay uncounted.

## Execution

*— claude-sonnet-5-5, 2026-11-26* · uncommitted (the orchestrator's script gates it)

### Load-bearing check (re-run before any edit): holds

```
relay /__status today: 404 not found
proxied-shaped: {"peer":"127.0.0.1","xff":"203.0.113.7","host":"127.0.0.1:52716"}
LAN dial: refused ECONNREFUSED
second bind: threw EADDRINUSE
```

Caddy proxies only to 4100 / 4200 (`Caddyfile.relay:37`, `Caddyfile.apps:31`).

### As built, in order

| Slice | State | What |
|---|---|---|
| 1 shared | DONE | `apps/relay/src/status.ts`, `status-listener.ts`, two `package.json` exports |
| 2 relay | DONE | `relay-counters.ts`, `server.ts`, `main.ts` (4101) |
| 3 apps host | DONE | `host-core.ts` `liveStats()`, `server.ts`, `main.ts` (4201) |
| 4 runbooks | DONE | `relay-deploy.md` §9, `apps-host-deploy.md` §3 |
| 5 changelog | DONE | `changelog.d/relay-status.added.md` |

No protocol change, no schema regeneration, no unit or Caddyfile change.

### Red first

- Relay pure + socket tests before the modules: `2 pass, 11 fail, 2 errors` (the
  two errors are the missing pure modules; the socket tests failed on "the status
  listener is not up").
- Relay `main` / `deploy` (constant exported, parser untouched): `56 pass, 8 fail`.
- Apps host `status` / `main` / `deploy` (constant only): `21 pass, 14 fail`.
- Green on old code, as planned: the public-404 and Caddy pins.

### Mutations (each applied, run, reverted)

| Mutation | Failed |
|---|---|
| `isLoopback` check dropped | `a non-loopback peer is a 404 and the body is never built` |
| proxy-header check dropped | `each proxy header ALONE…`; both `a proxied-shaped request on the status port…` |
| `Host` check dropped | `a public (or missing) Host is a 404`; both proxied-shaped tests |
| join flush not counted | exact bytes: expected 27, got 21 |
| count after the log limiter | `refusedRate` stuck at 20, expected 30 |
| future-slot filter dropped | `after a clock step back…` |
| listener bound to `0.0.0.0` | ``answers 200 on its own port, whatever `--host` binds``; the busy-port test |

### Checks

- `bun test apps/relay/test apps/apps-host/test`: **467 pass, 0 fail** (24 files).
- `scripts/test/changelog{,-guard}.test.ts`: 21 pass.
- `tsc -p apps/relay`, `tsc -p apps/apps-host`, `biome check apps/relay
  apps/apps-host`: clean. Full `bun run check` **not run here** (orchestrator).
- Both real entry points (`.tentacle/tmp/relay-status/smoke.ts`: spawn `main.ts`
  with `--port 24100/24200 --status-port 24101/24201`, fetch, SIGTERM) printed
  `relay status on …` / `apps-host status on …`, answered 200 with zeroed
  counters, and exited 0.

### Drift from Implementation

- `parseStatusPort` lives in `status.ts`, so both mains share it.
- `StatusRequest.headers` is typed as `{ has, get }`: a Bun server's `Headers`
  and the DOM one do not type-check against each other.
- `apps/apps-host/tsconfig.json` gained the two `@tentacle/relay/status*` paths
  (not in Files; needed to type-check).
- The relay's tick and `sweep()` are now one function (same steps, plus the
  gauge sample).
- The `--host` test also dials the LAN address (when there is one): answering on
  loopback alone did not prove the bind.

### Worth knowing

- By D4 + D2, `--port 4101` (relay) or `--port 4201` (apps host) with no
  `--status-port` is now refused at start. The shipped units use 4100 / 4200.
- Unverified: nothing deployed; 4101 / 4201 not checked on the box, and the busy
  port path not run on Linux (the start log shows `status on` or `status-off`).

## Review
