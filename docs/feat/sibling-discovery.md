# feat/sibling-discovery — a paired phone learns the computer's other daemons and their current addresses (mobile task 10)

> **Status:** implementation (plan written, **not approved**)
> **Branch:** `feat/sibling-discovery`
> **Size:** M · **Blast:** load-bearing (protocol: a new method + notification; `serve` lifecycle: a heartbeat + a poller; touches the `Connection` dispatch that §7 forbids serializing) · **Suited:** a strong executor + mandatory fresh-context Review that red-teams "a pod is not trusted", "don't serialize the RPC peer" and "one shared truth" (§7)
> **Changelog:** `changelog.d/sibling-discovery.added.md` — draft: `- **\`serve --address\` and sibling discovery.** A \`serve\` daemon tells a paired client which other \`serve\` daemons run on the same computer and the addresses it can reach each one on, live; \`--address <url>\` (repeatable) adds a URL the host's interfaces cannot show (a tailnet name, a tunnel), also put in \`tentacle pair\`'s QR.` (if owner Q3 = no, drop the `--address` half)

## Context

*— claude-opus-5-5, 2026-11-13*

Mobile task 10 (`docs/eval/mobile-app.md` decision 21, row 10: M · load-bearing).
The owner decisions it serves:

- **Decision 7 (discovery):** "every running daemon announces its running
  siblings on the same computer, inside the encrypted channel (so it works on
  every path). The app shows 'MacBook' → its live projects; a new `tentacle
  serve` appears on the phone within seconds." A project whose daemon is down is
  greyed out (app side, task 11).
- **Decision 3 (addresses):** "Addresses may change after pairing: the daemon
  sends its current list on connect, no re-pairing."
- **Decision 2 (robustness):** the app keeps several addresses per daemon,
  direct first (LAN / Tailscale), relay last.
- **Decision 9:** the app hard-codes no domain; it learns addresses from pairing
  and from the daemon's announcement on every connect.
- **Decision 6:** one daemon per project; a host's projects = its live `serve`
  daemons.

Task 9 (`docs/feat/device-pairing.md`) designed the seam for this:
`<configDir>/daemons/<pid>.json` (`device-pairing.md:260`,
`{ v: 1, pid, host, port, tls, cwd, startedAt }`, "readers: `pair`
(addresses); task 10 (siblings)"; owner Q6 = yes). As built on `main` (9a,
`072ca27`): `DaemonRecord` / `writeDaemonRecord` / `removeDaemonRecord` /
`readDaemonRecords` (`packages/daemon/src/device-store.ts:1017-1106`) — the
store only. **Not on `main` yet:** 9b (`serve` writes/removes the record,
`device-pairing.md:421`; the `/e2e` device route the phone dials) and 9d
(`packages/cli/src/pair-addresses.ts`, the pure "records + interfaces +
`--address` → URLs" derivation, `device-pairing.md:359-364,441`). Both run on
their own worktrees now (`feat/device-pairing-9b`, `feat/device-pairing-9d`).
This plan builds on their *planned* seams and names exactly where (owner Q2).

**What is missing today (evidence):**

- No daemon-level announcement exists: the only notifications are
  `session/update`, `session/cancel`, `$/progress`, `$/cancelRequest`
  (`packages/protocol/src/methods.ts:117-122`).
- Nothing reads `daemons/` outside 9a's tests (`rg readDaemonRecords` → only
  `device-store.ts` and `daemon/test/device-store.test.ts`).
- The record's liveness is "pid answers `kill(pid, 0)`, EPERM counts as alive"
  (`device-store.ts:426-433`), so a crashed `serve` whose pid is reused by any
  process is reported as a live sibling (Repro step 3).

**Repro** (2026-11-13, `bun .tentacle/tmp/sibling-discovery/repro.ts`, Bun
1.4.3, `main` = `78ffb02`):

```ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { readDaemonRecords, writeDaemonRecord } from "@tentacle/daemon";
import { SessionUpdateParamsSchema } from "@tentacle/protocol";
import { RpcPeer, createChannelPair } from "@tentacle/transport";

const scratch = mkdtempSync(join(import.meta.dir, "cfg-"));
// 1. An UNSOLICITED new notification reaches an older client's onError.
const [a, b] = createChannelPair();
const errors: string[] = [];
const daemonSide = new RpcPeer(a, {});
new RpcPeer(b, { onError: (e) => errors.push(e.message) });
daemonSide.notify("daemon/discovery" as never, { daemons: [] } as never);
await Bun.sleep(10);
console.log("1. old client onError on unsolicited notification:", JSON.stringify(errors));
// 2. session/update needs a session.
const r = SessionUpdateParamsSchema.safeParse({ seq: 0, update: { type: "x" } });
console.log("2. session/update without sessionId parses:", r.success);
// 3. Two projects' records; one is a crashed serve whose pid was reused (pid 1 = launchd).
writeDaemonRecord(scratch, { pid: process.pid, host: "0.0.0.0", port: 4001, tls: false, cwd: "/p/a", startedAt: 1 });
writeDaemonRecord(scratch, { pid: 1, host: "0.0.0.0", port: 4002, tls: false, cwd: "/p/b", startedAt: 2 });
console.log("3. live records:", readDaemonRecords(scratch).map((x) => `${x.pid}:${x.cwd}`).join(" "));
```

```
1. old client onError on unsolicited notification: ["unknown notification: daemon/discovery"]
2. session/update without sessionId parses: false
3. live records: 78517:/p/a 1:/p/b
```

(1) is why the announcement must go only to a client that asked for it; (2) is
why it cannot be a `session/update` kind (owner Q1); (3) is the stale-record
bug this task must design out.

## Implementation

*— claude-opus-5-5, 2026-11-13*

### Load-bearing assumption

**Every `serve` of one user sees the same `<configDir>` whatever its `cwd`, so
one `daemons/` directory lists all of them and one `devices/identity.json`
authenticates all of them** — which is what makes "a sibling" both findable
and dialable with the key the phone already pinned.

Proof: `resolveConfigDir(override, env, home)` (`packages/config/src/load.ts:497-508`)
derives it from `--config-dir` / `TENTACLE_CONFIG_DIR` / `XDG_CONFIG_HOME` /
`HOME` — never from `cwd`. The identity is created once per config dir with
`tmp + link` and every later reader gets the winner's key (9a load-bearing
check, `device-pairing.md:584-597`: 32 concurrent creators → 1 winner). 9b's
`DeviceAuthority` reads the same `registry.json` in every daemon
(`device-pairing.md:293-310`). Consequence (by design, not a bug): two `serve`
processes started with different `TENTACLE_CONFIG_DIR`s are two *computers* to
the phone (two identities), and they do not list each other.

The second assumption the *wire shape* stands on — proved by Repro step 1 and
`packages/transport/src/peer.ts:386-389`: an inbound notification whose method
the client does not know is reported to `onError` (non-fatal). So a new
notification is additive **only if it is never sent unsolicited**: the daemon
sends `daemon/discovery` only to a connection that called `daemon/discover`.

### Preconditions

- **P1 — daemon-wide methods have a pattern.** `daemon/session_ttl`: a
  `SessionHostOptions` seam injected by the cli (`session-host.ts:200`), absent →
  `MethodNotFound` (`session-host.ts:409-416`), dispatched in `Connection`
  without attaching anything (`connection.ts:323-325`). Pod daemons
  (`serve.ts:550` `podSessionHost`, `serve.ts:628` `startStdioDaemon`) and the
  in-process worker do not get the seam. `daemon/discover` copies this exactly.
- **P2 — `Connection` dispatch is concurrent, handlers hold no lock** (§7,
  `connection.ts:232-326`). The new handler is synchronous (subscribe + read a
  cached snapshot): it awaits nothing.
- **P3 — `Connection.close()` is the one teardown** (`connection.ts:147-153`):
  the unsubscribe goes there.
- **P4 — `RpcPeer.notify` on a closed peer is a no-op** (`peer.ts:227-230`): a
  change racing a disconnect cannot throw.
- **P5 — the client routes only `session/update`** today
  (`remote-client.ts:2210-2213`); daemon-wide reads follow
  `sessionTtl` / `sessionList` (`remote-client.ts:898-921`: reject when not
  connected, `MethodNotFound` from an older daemon).
- **P6 — the JSON-Schema export walks `RequestSchemas` and
  `NotificationSchemas`** (`json-schema.ts:46-53`): registering both entries is
  enough; `protocol/test/json-schema.test.ts` fails on drift until
  `bun run schema:export` is run on the branch.
- **P7 — bounded display strings** have one helper: `line(max)`
  (`protocol/src/text-line.ts:11`, no control chars). Address validity has one
  predicate: `isPairingAddress` (`protocol/src/pairing.ts:122`, a `ws(s)` URL
  ending in `/e2e`), cap `MAX_PAIRING_ADDRESSES = 8` (`pairing.ts:45`).
- **P8 — one `serve` per project:** the daemon store is locked per
  `<configDir>/daemon/<projectKey(cwd)>/` (AGENTS §7 persistence bullet, "one
  daemon per store: a lock"), so `cwd` is a unique key among live siblings.
- **P9 — `configDir` is hidden from a mounted workspace**
  (`workspace-mount.ts:709`, verified by 9a), so a sandboxed tool cannot plant
  a record. An un-sandboxed same-uid process can — that is already inside the
  trust boundary (it can read `identity.json`).
- **P10 — records are written atomically** (`writeAtomic`, tmp + rename,
  `device-store.ts:1040`); a reader never sees half a file.
- **Dependency (owner Q2):** 9b writes the record at listen / removes it at stop
  (`serve.ts` `startDaemon`); 9d exports the pure address derivation from
  `pair-addresses.ts`. This task **consumes** both and changes neither's
  contract except as listed in *Files* (an optional record field + a freshness
  option + a heartbeat touch).

### Design

**Wire (protocol).** Daemon-scoped, never session-scoped (owner Q1):

- Request **`daemon/discover`** — params `{}`. Result = a `DaemonDiscovery`
  snapshot. Side effect: subscribes *this connection* to changes (idempotent:
  a second call replaces, never doubles, the subscription).
- Notification **`daemon/discovery`** (daemon → client) — params = a
  `DaemonDiscovery`, sent only to subscribed connections, only when the
  snapshot changed.
- `DaemonDiscovery = { rev, daemons: DiscoveredDaemon[] }`:
  - `rev`: integer, monotonic per daemon process, +1 on every change. A client
    keeps the highest `rev` it has seen and drops a lower one (a notification
    may overtake the result of the request that subscribed it).
  - `DiscoveredDaemon = { cwd, addresses, startedAt, self? }`: `cwd` =
    `z.string().min(1).max(4096)` with the `line` no-control regex (the
    project's key on the phone, P8); `addresses` = up to `MAX_PAIRING_ADDRESSES`
    strings, each ≤ 512 and matching the same `ws(s)://…/e2e` shape as
    `isPairingAddress` (a test pins that both agree on a sample set);
    `startedAt` = the record's stamp (the phone can tell "restarted");
    `self: true` on the answering daemon only.
  - ≤ 32 daemons (`MAX_DISCOVERED_DAEMONS`). Order: `self` first, then oldest
    `startedAt` (as `readDaemonRecords` sorts).
  - Strip schemas (never `.strict()`), per the v10 forward-compat rule.
- **No `PROTOCOL_VERSION` bump, no `protocol.d/` note:** a new method (an older
  daemon answers `MethodNotFound`; the client treats that as "no discovery") and
  a notification sent only to a client that asked for it (an older client never
  asks). If Review finds a non-additive change, it gets a `protocol.d/` note and
  the merge-time `bun run protocol:bump` applies it — the number is never edited
  on this branch. `protocol.json` is regenerated on the branch with
  `bun run schema:export` (drift test) and again by `protocol:bump` at merge;
  never hand-merged.

**Daemon (`packages/daemon`).** `SessionHostOptions.discovery?: DiscoverySource`,
`interface DiscoverySource { current(): DaemonDiscovery; subscribe(listener:
(d: DaemonDiscovery) => void): () => void }`. `Connection` case
`Method.DaemonDiscover`: if the host has no source → `MethodNotFound` (P1);
else **subscribe first, then return `current()`** (no change can fall between
the two), keep the unsubscribe on the connection, and call it from `close()`
(P3). The listener is `(d) => this.peer.notify(Notification.DaemonDiscovery, d)`.
Synchronous; nothing awaited (P2). A pairing principal (9b) is refused by 9b's
gate (only `initialize` / `device/pair` pass) — no new gate here.

**Source (`packages/cli/src/discovery.ts`, new).** Owned by `startDaemon`, one
per process, like the reaper:

- `buildDiscovery(input)` — **pure**: `{ self, records, interfaces, now,
  freshWithinMs }` → `DiscoveredDaemon[]`. Per record, addresses come from 9d's
  derivation (loopback bind → none; `0.0.0.0`/`::` → each non-internal IPv4;
  specific host → itself; `ws`/`wss` from `tls`) **plus the record's own
  `addresses`** (owner Q3), deduped, filtered by `isPairingAddress`, capped.
  `self` is built from the process's own options, never from its file (a failed
  record write must not make a daemon invisible to its own clients). A record
  equal to self's pid is skipped (no duplicate). A sibling with no reachable
  address is still listed with `addresses: []` (owner Q4).
- `nextMembership(prev, seen, deadPids)` — **pure** hysteresis: a sibling whose
  pid is dead is dropped at once; one merely missing/stale is dropped only after
  two consecutive polls without it (a slow heartbeat or a reader waking first
  after sleep is not a flicker on the phone).
- `startDiscovery({ configDir, self, pollMs = 2000, heartbeatMs = 10_000,
  staleAfterMs = 30_000, timers, now, interfaces = os.networkInterfaces,
  readRecords, touch, log })` — the driver:
  - **heartbeat**, always on: `touchDaemonRecord(configDir, pid)` every
    `heartbeatMs` (mtime = alive; owner Q5). A failed touch is one log line, not
    fatal.
  - **poll**, only while ≥ 1 subscriber: read records (fresh within
    `staleAfterMs`; if the poller's own gap since its last poll exceeds
    `staleAfterMs` — the host slept — freshness is not applied for that poll),
    re-read interfaces, build, apply hysteresis, compare with the last snapshot
    (deep-equal over the canonical order); on change `rev++` and notify every
    listener. Stops when the last subscriber leaves. An exception (EACCES on
    the dir) keeps the last snapshot and logs once per distinct message.
  - first subscriber: one synchronous build before returning, so
    `current()` is never empty of `self`.
  - `fs.watch` on `daemons/` as an accelerator only (a new `serve` within
    ~100 ms instead of ≤ 2 s); the poll is the truth (9b's authority uses the
    same rule, `device-pairing.md:303-307`).
- **Sweep:** each poll removes `daemons/<pid>.json` files whose pid is dead
  (the only definitive signal; a live-but-stale pid is ignored, never deleted —
  it may be a slow sibling).

**`serve` (`packages/cli/src/serve.ts`, `flags.ts`).** `startDaemon` builds the
source after the listener is up (it needs the bound port) and passes it to the
`SessionHost` as `discovery`; `stop()` stops it (heartbeat + poll) before 9b's
`removeDaemonRecord`. New flag **`--address <url>`** (repeatable, validated
with `isPairingAddress` at parse; owner Q3) → `ServeOptions.addresses` →
written into the record (9b's write gains the field) and into `self`. `pair`
(9d) reads the field from records (one line in its derivation input).

**Client (`packages/client`).**
- `RemoteClient.discover(listener): Promise<DaemonDiscovery | undefined>` —
  calls `daemon/discover`; `MethodNotFound` → resolves `undefined` (an older or
  pod daemon: no discovery, keep what pairing gave). Routes
  `daemon/discovery` notifications (one more branch at
  `remote-client.ts:2211`) to the listener through `foldDiscovery` (drop
  `rev ≤ last`). **Re-subscribes after every reconnect** (the subscription is
  per connection; the post-reconnect step that re-attaches sessions,
  docs/feat/client-reattach.md, re-issues `daemon/discover` when a listener is
  set) — otherwise a Wi-Fi blip silently ends discovery.
- `packages/client/src/discovery.ts` (new, **pure**): `foldDiscovery(state,
  incoming)` (rev guard) and `mergeAddresses(known, discovery, now)` — the
  retention policy the app (task 11) uses: per project, announced addresses
  first in announced order, then previously known ones not announced now
  (pairing-time or learned), kept as fallbacks until `lastSeenAt + 30 days`
  (owner Q6); an invalid address (fails `isPairingAddress`) is dropped; an
  empty announcement never erases a known address; caps 8 per project, 32
  projects. A project missing from the latest snapshot is returned as
  `live: false` (the app greys it out, decision 7), never deleted here.

**What the laptop does with it:** nothing. The TUI never calls `discover`, so
it never receives `daemon/discovery` (Repro 1 is why that matters).

### Files

In dependency order (protocol → daemon → client → cli):

| File | Change |
|---|---|
| `packages/protocol/src/daemon.ts` | `DaemonDiscoverParamsSchema`, `DiscoveredDaemonSchema`, `DaemonDiscoverySchema`, `MAX_DISCOVERED_DAEMONS`; types |
| `packages/protocol/src/methods.ts` | `Method.DaemonDiscover = "daemon/discover"`, `Notification.DaemonDiscovery = "daemon/discovery"`, both registry entries |
| `packages/protocol/schema/protocol.json` | regenerated (`bun run schema:export`) — never hand-edited |
| `packages/daemon/src/device-store.ts` | `DaemonRecord.addresses?: readonly string[]` (optional, validated by `isPairingAddress`, capped; `v` stays 1: an older reader builds from known fields only, `:1093-1100`); `touchDaemonRecord(configDir, pid)`; `readDaemonRecords` gains `freshWithinMs?` + `now?` (absent = today's behaviour) and returns nothing older; `sweepDeadDaemonRecords(configDir, { alive? })` |
| `packages/daemon/src/session-host.ts` | `discovery?: DiscoverySource` option; `discoverySource()` accessor (`MethodNotFound` when absent, as `:409-416`) |
| `packages/daemon/src/connection.ts` | `case Method.DaemonDiscover` (subscribe-then-snapshot, one subscription per connection); unsubscribe in `close()` |
| `packages/client/src/discovery.ts` (new, pure) + `index.ts` | `foldDiscovery`, `mergeAddresses` |
| `packages/client/src/remote-client.ts` | `discover(listener)`, the notification branch, re-subscribe after reconnect |
| `packages/cli/src/discovery.ts` (new) | `buildDiscovery`, `nextMembership` (pure), `startDiscovery` (driver) |
| `packages/cli/src/serve.ts` | build/start/stop the source in `startDaemon`; pass `discovery`; `addresses` into the record + self |
| `packages/cli/src/flags.ts`, `main.ts` (help) | `serve --address <url>` (repeatable) |
| `packages/cli/src/pair-addresses.ts` (9d) | read `record.addresses` into the derivation (one input field) |
| `changelog.d/sibling-discovery.added.md` | the fragment above |
| tests | below |

Not touched: `UPDATE_CLASS` / `SessionUpdateSchema` / `client/src/mapping.ts`
(not a session update — owner Q1), `ws-server.ts` (route-agnostic: the method
works on whichever route the connection came from), TUI.

### Failure modes

| # | Case | Convergence |
|---|---|---|
| F1 | **Stale record, dead pid** (SIGKILL, crash, power loss) | skipped by `readDaemonRecords` (dead pid); removed by the next poll's sweep; dropped from the snapshot at once (dead = definitive). |
| F2 | **Stale record, pid reused** (Repro 3) | the heartbeat stops with the process → mtime older than `staleAfterMs` (30 s) → ignored; dropped after two such polls. Never deleted (cannot prove dead). |
| F3 | **Host sleep / wake** | the reader detects its own poll gap > `staleAfterMs` and skips freshness for that poll; hysteresis covers a sibling whose timer fires a beat later. No flicker. |
| F4 | **Record write failed** (disk full, EACCES) | `self` is built from options, so this daemon's own clients still see it; siblings do not see it — one log line at start (9b's write). |
| F5 | **Unknown record `v`** (a newer build's sibling) | ignored by the reader (`:1085`) — invisible to the older daemon, never rewritten. The optional `addresses` field does not need a `v` bump. |
| F6 | **Address change** (DHCP, Wi-Fi switch, Tailscale up/down, a sibling restarted on a new port) | interfaces + records re-read every poll → new snapshot → `rev++` → notification to every subscriber within ≤ `pollMs`. |
| F7 | **Phone offline during the change** | on reconnect it re-subscribes and gets the current snapshot (`rev` restarts with the process; a new process = a new `startedAt` for `self`, so the client resets its guard when `self.startedAt` changes). If **every** address it knows changed meanwhile and none is reachable, the phone cannot learn the new ones — honest limit: relay (task 15) or re-pair. Stated in the app's "unreachable" text (task 11). |
| F8 | **Hostile / buggy peer announcing addresses** | only an authenticated peer can send it: on the phone's path the channel is Noise IK against the computer key pinned at pairing (an impostor cannot complete the handshake). Every announced address is a **hint**: each dial re-authenticates against that same key, so a wrong address fails closed and sends nothing readable. Bounds: ≤ 32 daemons, ≤ 8 addresses, ≤ 512 chars, `cwd` ≤ 4096 no control chars; non-`isPairingAddress` addresses dropped client-side. A discovery is attributed to the computer the connection authenticated — it can never add a computer, change a pinned key, or erase pairing addresses (Q6). Residual: a key holder can make the phone dial ≤ 256 URLs (reveals the phone's IP to that host) — accepted, a key holder *is* the computer. `cwd` is rendered as plain text on the phone (task 11 note). |
| F9 | **A pod daemon** (`run`/`attach`) | gets no source → `MethodNotFound`; the laptop never calls `discover` anyway (§7: a pod is not trusted; it learns nothing about the laptop's other daemons, and the laptop takes no addresses from it). |
| F10 | **Forged local record** (same uid, un-sandboxed) | inside the trust boundary (P9); its addresses are still hints the phone authenticates (F8). |
| F11 | **Disconnect while subscribed** | `close()` unsubscribes; `notify` on a closed peer is a no-op (P4); the poller stops at zero subscribers. No leak (test counts listeners). |
| F12 | **Notification overtakes the subscribing response** | `rev` guard: the client keeps the highest. |
| F13 | **Two `discover` calls on one connection** | the second replaces the first subscription (no double notifications). |
| F14 | **Many subscribers** | one poller per process, shared; cost per poll = one `readdir` + N small reads + `networkInterfaces()`; zero when nobody is subscribed. |
| F15 | **Poll error** (dir unreadable) | keep the last snapshot (siblings do not vanish on a transient error); log once per distinct message. |
| F16 | **No `daemons/` dir / empty** | snapshot = `[self]`. |
| F17 | **Revoked device** | 9b closes its socket → F11. |
| F18 | **Pairing-only connection** | refused by 9b's principal gate (`Unauthorized`) — a test here once 9b is merged. |

### Tests

Red-before-green per §9 (the red for each is the property missing on `main`,
or a named mutation). Fakes: `createChannelPair`, injected timers/clock/`interfaces`/`alive`, temp `configDir` (HOME is a temp dir under `bun test`).

- **protocol** (`protocol/test/daemon-discovery.test.ts`): both names registered;
  bounds (33 daemons, 9 addresses, 513-char URL, control char in `cwd` → refused;
  unknown extra field → stripped); the address regex and `isPairingAddress`
  agree on a fixed sample set; JSON-schema export lists both (drift test).
- **device-store** (`daemon/test/device-store.test.ts` +): Repro 3 as a test —
  with `freshWithinMs`, a live pid with an old mtime is excluded (red on `main`:
  no option; mutation: ignore mtime → fails); `touchDaemonRecord` refreshes;
  `sweepDeadDaemonRecords` deletes dead, keeps live-but-stale; `addresses`
  round-trips and invalid ones are refused; a record without `addresses` still
  reads (older writer).
- **connection** (`daemon/test/daemon-discover.test.ts`): no source →
  `MethodNotFound`; result = snapshot; a change → one `daemon/discovery` frame
  to the subscriber; **a connection that never called `discover` gets zero
  frames** (the additivity property — mutation: broadcast to all connections →
  fails); subscribe-before-snapshot (a fake source that changes inside
  `subscribe` → the change is not lost); second call does not double; `close()`
  leaves zero listeners; a pending `session/prompt` on the same connection does
  not delay the `discover` result (§7, concurrent dispatch).
- **cli/discovery** (`cli/test/discovery.test.ts`, pure): loopback → `[]`;
  `0.0.0.0` → fake interfaces; `tls` → `wss`; `--address` appended, deduped,
  capped; `self` first and present even with an empty dir; own pid's record not
  duplicated; hysteresis (missing once kept, twice dropped; dead pid dropped at
  once); wake rule (gap > `staleAfterMs` → freshness skipped); `rev` increments
  only on change. Driver with fake timers: poller starts at first subscriber,
  stops at last; heartbeat runs without subscribers; poll error keeps snapshot.
- **client** (`client/test/discovery.test.ts`): `foldDiscovery` drops lower `rev`,
  resets on a new `self.startedAt`; `mergeAddresses` (empty announcement erases
  nothing; invalid dropped; expiry at 30 days; announced first). `RemoteClient`
  with a fake daemon: `discover` result + notification; `MethodNotFound` →
  `undefined`; **after a forced reconnect a later change still reaches the
  listener** (mutation: no re-subscribe → fails).
- **e2e** (`cli/test/sibling-discovery-e2e.test.ts`): two real `startDaemon`
  on loopback, different temp `cwd`s, one temp `configDir`, `--address` so
  each has an address, small `pollMs`; a `RemoteClient` on A subscribes → A
  (`self`) + B; stop B → a notification without B; start C → C appears; pod
  host (`podSessionHost`) → `MethodNotFound`. If 9b is merged by then: one case
  over the `/e2e` route with a registered device key (9b's harness) and one with
  a pairing-only key → `Unauthorized`.

### Owner questions

1. **Wire shape:** a daemon-scoped request `daemon/discover` + a notification
   `daemon/discovery` sent only to subscribers — **not** a `session/update`
   display kind (that needs a `sessionId` and a per-session `seq`/ring, Repro 2;
   the phone's computer screen has no session open). Both are additive → no
   `PROTOCOL_VERSION` bump. **Rec: yes.**
2. **Order:** execute after 9b (record written by `serve`, `/e2e` route) and 9d
   (`pair-addresses.ts`) are merged; this plan does not go stale meanwhile.
   **Rec: yes** — the alternative (this task writes the record itself) collides
   with 9b on `serve.ts`.
3. **`serve --address <url>`** (repeatable): the daemon's own public URLs
   (tailnet DNS name, cloudflared, own domain) go into its record, so they are
   announced and also put in `pair`'s QR. **Rec: yes** — without it the phone
   only ever learns interface IPs.
4. **A loopback-only sibling** (`serve --host 127.0.0.1`, no `--address`):
   listed with no address (the app shows it as "not reachable from the phone",
   with the `--host 0.0.0.0` / `--address` hint) rather than hidden. **Rec: list
   it.**
5. **Liveness heartbeat:** each `serve` refreshes its record's mtime every 10 s;
   a record older than 30 s is ignored (fixes the pid-reuse phantom, Repro 3);
   dead-pid records are deleted by any daemon. **Rec: yes.**
6. **Phone keeps old addresses as fallbacks:** announced first, then
   previously known ones (pairing-time or learned) for 30 days after last seen;
   an announcement never erases one. **Rec: yes, 30 days.**

## Execution

*— claude-opus-5-5, 2026-11-14*

### Load-bearing check (re-run first, as instructed)

PASSES. `.tentacle/tmp/sibling-discovery/load-bearing.ts` (in the worktree) imported the
branch's `configDirFromEnv` and printed:

```
default: /Users/gmeghnag/.config/tentacle (stable: true)
override: /explicit/dir (stable: true)
xdg: /xdg/tentacle (stable: true)
mentions cwd/process.cwd inside resolveConfigDir: false
```

`resolveConfigDir` (`packages/config/src/load.ts:497-508`) never reads `cwd`, and the
derivation is stable across calls — so one `daemons/` and one identity per computer, which
is what makes a sibling both findable and dialable. The second assumption (Repro 1:
an unknown inbound notification reaches an older client's `onError`) was re-proved
structurally at `peer.ts:386-389` and is pinned by the "a connection that never asked gets
ZERO frames" test.

### As built, in the plan's order

**1. Protocol** (`daemon.ts`, `methods.ts`, `schema/protocol.json`, + its tests).
`DaemonDiscoverParamsSchema` (`{}`), `DiscoveredDaemonSchema`, `DaemonDiscoverySchema`,
`MAX_DISCOVERED_DAEMONS = 32`; `Method.DaemonDiscover` / `Notification.DaemonDiscovery` and
both registry entries. `cwd` is `line(4096)` (no control chars); each address `.max(512)` and
a plain regex — NOT `isPairingAddress` itself: the JSON-Schema export does not map a
`.refine()`, so the wire uses a regex and a fixed-sample agreement test pins the two together
(11 protocol tests, incl. bounds, strip-not-strict, rev/stamp shapes, empty `addresses`
allowed for a loopback sibling). `protocol.json` regenerated with `bun run schema:export`
(*not* hand-merged) and fixtures added to the drift test.

**2. `device-store`.** `DaemonRecord.addresses?` (validated, deduped, capped on WRITE and on
READ — an invalid one is dropped singly, so a hand-edited record cannot hide its daemon);
`readDaemonRecords` gains `freshWithinMs`/`now` (the heartbeat signal; absent = the old
pid-only behaviour, which `pair` keeps); `touchDaemonRecord` (utimes, never creates — a
heartbeat racing the stop must not resurrect a record); `sweepDeadDaemonRecords` (dead pid
only); `processAlive` exported.

**3. `session-host` + `connection`.** `SessionHostOptions.discovery?`, `discoverySource()`
(`MethodNotFound` when absent, the `sessionTtl` shape) and `setDiscoverySource` — the last
one is **drift** from the plan's `SessionHostOptions.discovery`-at-construction: `listen`
only learns its own record (the bound port) *after* the host exists, so the seam is attached
there. `opts.discovery` is therefore mutable. `Connection` case `Method.DaemonDiscover`:
`subscribe` first, then `current()` (F12), one subscription per connection (F13), unsubscribe
in `close()` (F11), synchronous — nothing awaited, so a pending `session/prompt` does not delay
it (proved by a gated-prompt test).

**4. Client.** `client/src/discovery.ts` (pure): `foldDiscovery` (returns `changed` so the
caller stays silent on a stale/duplicate frame; resets the guard on a new `self.startedAt`) and
`mergeAddresses` (announced first, known kept as fallbacks on ONE per-project `lastSeenAt`
clock for 30 days, empty announcement erases nothing, invalid dropped, 8/32 caps, a missing
project is `live: false`). `RemoteClient.discover(listener)`, the `daemon/discovery` branch in
`makePeer`, `resubscribeDiscovery()` on every `linkUp`, `MethodNotFound → undefined`.

**5. `cli/src/discovery.ts`.** `buildDiscovery` (pure, `self` first from the process's own
options, per-project dedupe, `pairAddresses` + the record's `--address`, re-filtered by
`isPairingAddress`), `nextMembership` (pure two-strike hysteresis keyed by `cwd`, dead pid
drops at once), `startDiscovery` (heartbeat always on, poll only while ≥1 subscriber, one
synchronous build at the first subscribe, sweep each poll, `fs`-free except via the injected
reader, wake-gap freshness skip, F15 keep-last-snapshot + log once).

**6. `serve` / `flags` / `main`.** `ServeOptions.addresses|discovery|pollMs|heartbeatMs`;
`listen` writes `addresses` into the record (omitted entirely when empty), starts the driver
and stops it in `stop()` BEFORE `removeDaemonRecord`; `ServeHandle.discovery` exposes it.
`serve --address` is a `repeated` flag validated at parse time (`isPairingAddress`, cap 8), so
`serve` fails before binding; help text updated.

### Mutations (all caught, then reverted; suite green after each revert)

| Mutation | Result |
|---|---|
| `discover()` snapshots FIRST, then subscribes (F12) | 1 fail (the raced-subscribe test: result was the pre-change rev) |
| notify unsolicited / broadcast (additivity) | 4 fail (bystander gets frames; F13 doubling) |
| `MISSES_BEFORE_DROP = 1` (no hysteresis) | 3 fail |
| heartbeat armed only at the first subscriber | 2 fail ("the poller runs only while subscribed…"; the F4 log test) |
| always apply freshness (ignore the wake gap) | 1 fail (the suspend test) |
| drop `resubscribeDiscovery()` on `linkUp` | 1 fail (reconnect test) |

### Red-before-green

Every slice was red first on the property, not on an import: protocol
(`Export named 'DaemonDiscoverParamsSchema' not found`), device-store
(`sweepDeadDaemonRecords not found`), connection (`RpcError: unexpected method:
daemon/discover` — the dispatch, not a compile error), client
(`Cannot find module '../src/discovery.ts'`), cli discovery (same), e2e (the client got a
one-daemon snapshot). Reconnects/notifications were then forced to pass by the real code.

### Drift from the Implementation, and why

1. **`setDiscoverySource` instead of construction-time `discovery`** (above): the plan's own
   ordering requirement ("builds the source after the listener is up … and passes it to the
   `SessionHost`") is only satisfiable this way, since the host must exist before `listen`.
2. **`cli/test/.../sibling-discovery-e2e.test.ts` is `serve-discovery.test.ts`** and a
   "sibling" there is a real child process plus the record a `serve` in it would have written,
   not a second `startDaemon`: the record's filename IS the pid, so two `startDaemon` calls in
   one process collide (and one process can only be one daemon in production either). The
   record half, the over-the-wire half and the stop-announcement are all real.
3. **`daemon/discover`'s result is `DaemonDiscovery[]`-shaped by the builder, `{rev,daemons}`
   on the wire**: `rev` is the driver's, so `buildDiscovery` stays clock-free/pure and the
   driver owns monotonicity.
4. **`nextMembership` keys by `cwd`**, not pid (the plan said "per sibling"; the phone's rows
   are projects, and P8 makes `cwd` the project key) — a restart under a new pid keeps the row
   and moves `startedAt`.
5. **`fs.watch` on `daemons/` was NOT added** (the plan listed it as an accelerator only, "the
   poll is the truth"). Deliberate: it is unobservable behaviour that would need its own
   timing test on three platforms, and the poll already meets decision 7's "within seconds".
   Recorded as debt, not silently skipped.
6. **The F18 pairing-principal test is a unit test on `Connection`** (the plan said "once 9b is
   merged"; it is merged, but `ws-device-route.test.ts` already covers the route-level gate, so
   duplicating the harness here would test 9b, not this task).
7. `serve`'s driver logs through `options.onError`, not a new sink (reuses the existing
   `[daemon] error:` line the cli already prints).

### Not verified here

- **F3 on a genuinely suspended host**: the wake rule is driven with fake timers
  (`jump` + rebased intervals, as Node does not replay missed ticks). A real
  `SIGSTOP`/resume of the daemon process is not exercised.
- **The phone side** (task 11): `mergeAddresses` is tested pure, but no app consumes it yet.
- **`fs.watch` accelerator**: not implemented (see drift 5) — the ≤ `pollMs` latency is
  verified, the ~100 ms one is not, because it does not exist.
- **Full-suite flakiness (pre-existing, NOT this task)**: of five full `bun test` runs,
  three were fully green and two each had ONE unrelated timing failure —
  `worker-path exit net > a job spawned in the worker dies with tentacle` and
  `serve (D2): every line is a log, on stderr > listening, audit, notice and error lines`.
  Both are untouched by this branch (`git status` names neither) and pass 5/5 and 6/6 in
  isolation; they fail only under full-suite load. The `serve` one injects a FAKE
  `startDaemon` and asserts only on stdout/stderr routing, so it cannot be affected by the
  discovery code. Last recorded full run: **8348 pass, 3 skip (the opt-ins), 0 fail**.

### Disk note (environment, not the task)

The gate first failed with `ENOSPC` (117 MiB free). I reclaimed 415 MiB by removing Bun's
cross-platform binary cache (`~/.bun/install/cache/bun-linux-*`, regenerable by `bun install`).
No repository content was deleted.

### Fix round 1

*— claude-opus-5-5, 2026-11-14*

Review round 1 raised 2 HIGH + 2 MEDIUM; all four are fixed here, each **red first**
on the assertion of the property (the repro table below is the red run), each
**mutation-checked** (mutation applied → the new test fails → reverted → green), and
one review nit taken with them.

**1 (HIGH, no addresses announced in production) — FIXED.** `cli/src/discovery.ts:212`
defaulted `interfaces` to `() => []`, and `serve` passes none, so a
`serve --host 0.0.0.0` announced `addresses: []` for itself and every sibling while
`pair`'s QR listed them (decision 3, F6 dead). The default is now `machineInterfaces`
(the same helper `pair` uses), re-read on **every** poll, so the two can no longer
disagree and a DHCP/Wi-Fi change is announced within `pollMs`. The helper moved to
`cli/src/pair-addresses.ts:55`, beside the rule that consumes it (`pair.ts` imports it
from there): importing `pair.ts` from the daemon path would have made `serve.ts`'s module
graph pull in the QR renderer and the pairing window. `serve` stays unpassed-`interfaces`
on purpose: the machine's table is the production default, and only a test injects one.

**2 (HIGH, F7: a change made while offline was swallowed) — FIXED.**
`client/src/remote-client.ts:986` folded the post-reconnect `daemon/discover` result
without calling the listener; the folded `rev` then became the guard, so no later frame
re-delivered it either. `resubscribeDiscovery` now delivers when `foldDiscovery` says
`changed` (and stays silent when it does not, so a reconnect causes no redraw), using a
captured `listener` for the async callback.

**3 (MEDIUM, Repro 3 returned on a cold subscribe) — FIXED.**
`lastPollAt` was advanced only by polls, and the poller runs only while a client is
subscribed, so the first subscriber after >`staleAfterMs` idle got a poll with freshness
off — a pid-reuse phantom in the snapshot for ~2 polls. Two changes, one per cause:
- the wake gap is now **reset when the poller arms** (`lastPollAt = now()` at the first
  subscribe), because a gap across an unsubscribed spell is idleness, not a sleep;
- the sleep signal a daemon with no subscriber actually has is the **heartbeat**: a beat
  later than `staleAfterMs` sets `slept`, and the next poll skips freshness for it
  (F3). That keeps a genuine suspend covered without re-introducing the phantom.

**4 (MEDIUM, Q6 drift: one clock per project) — FIXED.** `KnownProject`/`MergedProject`
gain `addressSeenAt` (address → when it was last ANNOUNCED); `mergeAddresses` stamps
every announced address `now`, keeps a fallback only while **its own** stamp is inside
`DISCOVERY_RETENTION_MS`, and carries the kept stamps forward. A store written before
this field falls back to the project's `lastSeenAt`, so the shape stays additive. The
owner's Q6 wording ("30 days after it was last seen") is now what the code does, so no
owner question is needed.

**Nit — FIXED.** `daemon/src/session-host.ts:448`'s doubled `/**`.

**Red before green** (`.tentacle/tmp/sibling-discovery/review.test.ts` on the unfixed
tree: `A self addresses: []`, `B first snapshot: ["/p/a","/p/phantom"]`,
`C reconnected: true listener saw: []`). The four new tests, run on the pre-fix sources:

| Test (new) | Red run |
|---|---|
| `the DEFAULT interfaces are this machine's…` (cli) | `Expected: > 0 · Received: 0` |
| `the first subscriber after an idle spell still applies freshness` (cli) | got `["/work/self","/work/phantom"]` |
| `a daemon that SLEPT with no subscriber still skips freshness` (cli) | sibling absent, wanted present |
| `a change made WHILE THE LINK WAS DOWN reaches the listener` (client) | `seen` = `[]`, wanted `[2]` |
| `a RESYNC that changes nothing does not wake the listener` (client) | (guards the fix's other side) |
| `a fallback expires 30 days after IT was last seen…` (client) | address kept, wanted dropped |

**Mutations (each applied → one fail → reverted → green; `git diff` back to the fixed tree
after each).**

| Mutation | Result |
|---|---|
| `interfaces` default back to `() => []` (fix 1) | fail: the cli DEFAULT test **and** the `serve`-level `0.0.0.0` test (`serve-discovery.test.ts`) |
| drop `lastPollAt = now()` at the first subscribe (fix 3a) | fail: the idle-spell test (`/work/phantom` back) |
| `afterSleep = gap > staleAfterMs` (drop the heartbeat signal, fix 3b) | fail: the SLEPT-with-no-subscriber test — **it survived the first version of my test**, which only proved 3a; the suspend case is what pins 3b |
| `resyncDiscovery`: never call the listener (fix 2) | fail: the offline-change test |
| `resyncDiscovery`: ALWAYS call the listener (fix 2's other side) | fail: the resync-changed-nothing test |
| `seenAt = prior.lastSeenAt` (fold the per-address stamp back, fix 4) | fail: the 30-day chain test — **also survived my first one-shot version**, which could not tell the two clocks apart; the test is now a real fold CHAIN (day 10/20/40/50) |

The two mutations marked "survived the first version" are the reason those two tests were
rewritten: the first drafts were vacuous, and the mutation is what showed it (§9).

**Gate** (worktree `feat/sibling-discovery`): `bunx tsc --noEmit` clean, `bun run lint`
clean (1072 files, 0 fixes), `bun test` **8355 pass, 3 skip (the opt-ins), 0 fail**
(601 files, 344 s).

**One drift inside this round:** `machineInterfaces` moved from `cli/src/pair.ts` to
`cli/src/pair-addresses.ts` (with `pair.ts` importing it). The direct import would have
put `pair.ts` — the QR renderer, the pairing window, `uqr` — into `serve.ts`'s module
graph, which `discovery.ts` now shares. `pair.ts` keeps its behaviour, so no test moved;
`pair-addresses.ts` is where the interface RULE lives anyway.

**Not verified here:** the phone side (task 11) still consumes nothing, so
`addressSeenAt` is exercised only by the pure tests; and a real `SIGSTOP`/resume is still
not driven (the sleep is simulated with the rebased fake timers).

## Review

#### Owner answers (2026-11-13)

All questions answered as recommended. Implementation APPROVED.

#### Adversarial review (fresh context)

*— claude-opus-5-5, 2026-11-14*

**Verdict: REQUEST-CHANGES.** Scope `git diff main...HEAD`. Touched tests 122 pass / 0 fail (8 files); `bun run lint` clean; `bun run typecheck` clean. The full `bun run check` was not re-run here.

**Findings** (each one reproduced with `.tentacle/tmp/sibling-discovery/review.test.ts`, which imports the worktree's sources):

1. **HIGH: production never announces an interface address.** `cli/src/discovery.ts:212` defaults `interfaces` to `() => []` (the plan says `os.networkInterfaces`), and `serve.ts:496` passes none. A `serve --host 0.0.0.0` with no `--address` therefore announces `addresses: []` for itself and every sibling (repro A: `[]`), while `pair`'s QR (`pair.ts:195`, `machineInterfaces()`) does list them. This breaks decision 3 and F6 (a DHCP or Wi-Fi change is never announced), and it contradicts the module's own comment that "the QR and the announcement cannot disagree". The e2e binds loopback only, so no test sees it. Fix: default to `machineInterfaces()` (re-read every poll), plus a `0.0.0.0` driver test.
2. **HIGH: F7 is not met.** `remote-client.ts:986-1000` `resubscribeDiscovery` folds the post-reconnect snapshot but never calls the listener. A change made while the phone was offline, or a daemon restart, is swallowed until the next change. It also becomes the `rev` guard, so it is never re-delivered (repro C: listener saw `[]` after the reconnect). The reconnect test only pushes a change after the reconnect, so it is green on this bug. Fix: deliver when `changed`, and add a test that changes the snapshot while the link is down.
3. **MEDIUM: Repro 3 (the pid-reuse phantom) comes back on every cold subscribe.** `lastPollAt` (`cli/src/discovery.ts:235`) is only advanced by polls, and polls run only while a client is subscribed. So the first subscriber after more than 30 s with none, which is the normal phone case, gets a poll with freshness switched off. The stale pid-reuse record goes into the `daemon/discover` result (repro B: `["/p/a","/p/phantom"]`) and then flickers out about 2 polls later. Fix: measure the wake gap with the heartbeat, which always runs, or reset `lastPollAt` when the poller starts.
4. **MEDIUM: drift from owner Q6 that Execution does not list.** `client/src/discovery.ts:167` refreshes ONE clock per project. While a project stays announced, its unannounced fallback addresses are therefore kept forever, not "30 days after last seen" for each address. Either keep a timestamp per address or have the owner accept the change.

**Mutations** (each one reverted; the tree was byte-identical, `git status` clean): `nextMembership` ignoring `deadCwds` → 1 fail. `readDaemonRecords` ignoring `freshWithinMs` → 2 fail. Both properties are pinned.

**What holds:**
- Additivity: the notification is sent only to subscribers, and the daemon-side test exists.
- Subscribe happens before the snapshot.
- Unsubscribe runs in `close()`, and the handler awaits nothing (§7 "don't serialize").
- A pairing principal is refused before the dispatch (`connection.ts:283`).
- Pod and worker daemons get no source, so they answer `MethodNotFound` ("a pod is not trusted").
- Strip schemas. `protocol.json` was regenerated, not hand-edited.
- The heartbeat never creates a record (`touchDaemonRecord` uses utimes).

**Nit:** `session-host.ts:447` has a doubled `/**`.

**Executor:** Execution is signed `claude-opus-5-5`, but commit `4864cdc` says "exec (deepseek)". One of the two is wrong, and AGENTS §10 requires an honest signature. If the executor was really Opus, this review comes from the same model family (a fresh context only).

### Round 2

*— claude-opus-5-5, 2026-11-14* (fresh context; the same model family as the round-1 reviewer, while the executor is DeepSeek per the commit trailers)

**Verdict: REQUEST-CHANGES** (one MEDIUM).

Scope: `git diff HEAD~1` (`59f89b3`). `bun run typecheck` and `bun run lint` are clean. 116 touched tests pass, 0 fail (cli discovery and serve-discovery, client discovery, pair*, daemon-discover). Re-running round 1's repros: A now announces the LAN and tailnet IPs, B has no phantom, and C delivers rev 2 after the reconnect.

**Round-1 findings: each one is fixed, and each has a test that fails under mutation (all reverted, `git status` clean):**

| # | Fix | Mutation → result |
|---|---|---|
| 1 | `interfaces` defaults to `machineInterfaces` (moved to `pair-addresses.ts`, shared with `pair`) | default `[]` → 2 fail (driver and the `0.0.0.0` serve e2e) |
| 2 | `resubscribeDiscovery` delivers the snapshot when `changed` | delivery removed → 1 fail ("change made WHILE THE LINK WAS DOWN") |
| 3 | `lastPollAt` is reset when the poller arms; the heartbeat detects a sleep (`slept`) | no reset → 1 fail; `slept` never set → 1 fail (F3 with no subscriber) |
| 4 | a per-address `addressSeenAt` | per-project clock → 1 fail (expiry while the project stays LIVE) |
| nit | the doubled `/**` is gone | n/a |

**New finding:**

5. **MEDIUM: `slept` never expires** (`cli/src/discovery.ts:247,277,333`). One late beat sets it, and only a poll clears it. With no subscriber, nothing polls, so the flag stays set. Repro D (`.tentacle/tmp/sibling-discovery/r2.test.ts`) is the normal laptop case: the lid is closed overnight with no client, the laptop is then awake for an hour with on-time beats, and only then does a phone subscribe. The first snapshot is `["/p/a","/p/phantom"]`, so the round-1 #3 / Repro-3 phantom comes back. The skip only has to cover the window before the siblings' next beat. Fix: record when the late beat happened, and treat `slept` as expired once `now - sleptAt > staleAfterMs`. Add Repro D as the regression test.

**What holds:**
- Moving `machineInterfaces` is a pure move: `pair` behaves the same, and typecheck is clean.
- `addressSeenAt` is optional on `KnownProject`; a store written before it falls back to `lastSeenAt`.
- A resync that changed nothing stays silent (`changed`).
