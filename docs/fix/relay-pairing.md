# fix/relay-pairing — Pairing never reaches the relay when a direct address hangs

> **Status:** implementation
> **Branch:** `fix/relay-pairing`
> **Type:** fix · **Size:** M · **Blast:** cross-module · **Suited:** any executor (owner assigns); standard Review, red-teaming the race's cancel/terminal/deadline paths (no §7 invariant, protocol, persistence or terminal path is touched)
> **Changelog:** `changelog.d/relay-pairing.fixed.md` — `- **Pairing from a phone off the computer's network works.** The app races the pairing QR's addresses like it already races a paired computer's, so a dead LAN or Tailscale address no longer leaves pairing on "Connecting…" before the relay is ever tried.`

## Context

*— claude-opus-5-5, 2026-11-15*

**Live report (2026-11-15, first real phone over the production relay).** Pairing an
iPhone on 4G with `tentacle serve --host 0.0.0.0 --port 4000 --relay
wss://relay.tentacle.so` (main b44766f8) never completed. The QR carried
`[ws://192.168.1.6:4000/e2e, ws://100.91.157.243:4000/e2e, wss://relay.tentacle.so/d/XQXwAcyZ…/e2e]`
— "direct first, relay last" (`packages/cli/src/pair-addresses.ts:27`). On 4G only
the relay answers. The phone sat on **"Connecting…"** (the `connecting` stage,
i.e. *before* the compare code: `apps/mobile/src/pair-copy.ts:19,41-42`) on every
attempt. Relay journal: attempt 1 `dial-open` + `accept` (daemon: `relay-open`,
`pairing-open`), then nothing; later attempts `dial-open` → `accept-refused unknown`
within ~1 s (daemon: `relay-open` + `e2e-violation closed`).

**Root cause (proved below).** `pairDevice` dials the payload's addresses
**strictly in sequence** and the per-address dial has **no deadline**
(`packages/client/src/pairing.ts:129-130` → `pairAt` → `secureChannelFactory`
→ the app's `phoneDial` = `webSocketChannelFactory`, `apps/mobile/App.tsx:725-727`,
whose promise settles only on the socket's `open`/`close`,
`packages/client/src/ws-channel.ts:216-233`). On cellular a private LAN / Tailscale
address hangs in TCP connect, so the relay — last in the list — is reached only
after the OS gives up on each dead address (if the user is still waiting), or
never. R6 (`docs/feat/mobile-relay.md:160-166`, "Gap found while verifying") found
exactly this and fixed it with the staggered race `firstAnswering`
(`apps/mobile/src/address-dial.ts:135`) — but only for a **paired** computer's dial
(`apps/mobile/src/connection.ts:316`). The **pairing** dial was never moved onto
it, and R6's Maestro flow paired with a relay-**only** QR
(`docs/feat/mobile-relay.md:442-445`), so no test ever paired with a dead direct
address ahead of the relay.

**What the relay logs mean (code-cited, not a second bug).** `accept-refused unknown`
(`apps/relay/src/server.ts:599-602`) is `core.accept` finding no stream for the
token (`apps/relay/src/relay-core.ts:557-559`). Within the 10 s expiry the only
thing that forgets a stream is the phone's socket closing
(`server.ts:456` → `relay-core.ts:723-735`). So those dials were phone sockets
that closed within the daemon's ~1 s accept round-trip (Mac → Caddy → relay); the
daemon starts its responder on the leg's open without waiting for a relay verdict
(`packages/daemon/src/relay-link.ts:679-700`), so the relay's close surfaces there
as `e2e-violation closed`. The relay, `--trust-proxy`, per-IP limits, tokens and
Noise-over-relay framing all behave: the repro below pairs over the real relay in
~25 ms when the relay is the only address. Hypotheses falsified by the repro:
token mismatch, accept first-frame timing, Noise framing over the relay, the
pairing-vs-paired route (a fresh key during a window gets `pairing-open` and an
`initialize` answer over the relay), "already paired" (the repro registers the
phone's old key first).

**Unverified (does not change the fix).** Which app path opened and closed those
~1 s relay sockets on attempts 2–3: `pairDevice` was still blocked on the LAN
address (repro run B), so they were not the pairing's. The likely source is the
Computers screen probing the *existing* record (`apps/mobile/App.tsx:501-509`,
`openComputer` with the old key) while iOS flips `AppState` to `inactive` during
the QR/deep-link hand-off, which `suspend()`s live links (`App.tsx:1195-1204`).
The same uncertainty covers attempt 1's `pairing-open` with no compare on the
phone (a fresh-key pairing would have shown the code; an old key the daemon's
store does not hold also gets `pairing-open` during a window). Verify with the
app log (`APP_LOG` socket lines) and `tentacle devices` on the Mac. Not in scope.

**Repro** (2026-11-15, worktree at main b44766f8;
`.tentacle/tmp/relay-pairing/repro.ts` + a `tsconfig.json` there that only
`extends` the worktree's). REAL relay (`startRelay`), REAL daemon relay link
(`startRelayLink` + `DeviceAuthority` + a live pairing window, the old phone key
already registered), the client's own `pairDevice` + `webSocketChannelFactory` as
the phone. A dead address is a TCP listener that never answers the upgrade — what
the phone sees for `192.168.1.6` on 4G, minus the SYN-timeout wait. Argv:
`<deadAddressesFirst> <stuckMs> [race]`.

```ts
// Repro: REAL relay (apps/relay) + REAL daemon relay link + the client's own
// pairDevice/webSocketChannelFactory, pairing over the relay address only.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { pairDevice } from "../../worktrees/relay-pairing/packages/client/src/pairing.ts";
import { webSocketChannelFactory } from "../../worktrees/relay-pairing/packages/client/src/ws-channel.ts";
import { encodeBase64Url } from "../../worktrees/relay-pairing/packages/protocol/src/index.ts";
import { generateStaticKeypair, publicKeyOf, systemRandom } from "../../worktrees/relay-pairing/packages/transport/src/noise-channel.ts";
import { startRelay } from "../../worktrees/relay-pairing/apps/relay/src/server.ts";
import { DeviceAuthority } from "../../worktrees/relay-pairing/packages/daemon/src/device-authority.ts";
import {
  addDevice,
  loadOrCreateIdentity,
  openPairing,
  readIdentity,
} from "../../worktrees/relay-pairing/packages/daemon/src/device-store.ts";
import { HandshakeLimiter } from "../../worktrees/relay-pairing/packages/daemon/src/handshake-limit.ts";
import { bunRelayDialer, startRelayLink } from "../../worktrees/relay-pairing/packages/daemon/src/relay-link.ts";
import { SessionHost } from "../../worktrees/relay-pairing/packages/daemon/src/session-host.ts";

const t0 = Date.now();
const log = (who: string, line: string) =>
  console.log(`${String(Date.now() - t0).padStart(5)}ms ${who.padEnd(6)} ${line}`);

const configDir = mkdtempSync(join(import.meta.dir, "store-"));
const made = loadOrCreateIdentity(configDir, { name: "gmeghnag-mac" });
if (!made.ok) throw new Error(made.reason);
const identity = readIdentity(configDir);
if (!identity.ok) throw new Error(identity.reason);
// The phone was ALREADY paired (direct path, the day before).
if (process.env.ALREADY_PAIRED !== "0") {
  const old = generateStaticKeypair(systemRandom);
  addDevice(configDir, { publicKey: publicKeyOf(old.privateKey), name: "iPhone" });
}
const CODE = "7Q4ZM9XK2B";
openPairing(configDir, { code: CODE, ttlMs: 600_000, pid: process.pid });

const relay = startRelay({ host: "127.0.0.1", port: 0, onLog: (l) => log("relay", l) });
const authority = new DeviceAuthority({ configDir, pollIntervalMs: 50 });
const host = new SessionHost({
  defaultCwd: configDir,
  createAgent: () => {
    throw new Error("unused");
  },
});
const secret = new Uint8Array(32).fill(7);
const link = startRelayLink({
  url: relay.url,
  secret,
  authority,
  sessionHost: host,
  limiter: new HandshakeLimiter({ burst: 100 }),
  dial: bunRelayDialer(),
  onAudit: (l) => log("daemon", l),
  onError: (e) => log("daemon", `error ${e.message}`),
});
while (!link.isConnected()) await Bun.sleep(5);

// A DEAD direct address as 4G sees 192.168.1.6 / 100.x: TCP that never answers
// the upgrade (a SYN blackhole behaves the same to the app, only slower to set up).
const dead = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: { data() {}, open() {} },
});
const DEAD = Number(process.argv[2] ?? "0");
const addresses = [
  ...Array.from({ length: DEAD }, (_v, i) => `ws://127.0.0.1:${dead.port}/e2e?dead=${i}`),
  link.address,
];
const STUCK_MS = Number(process.argv[3] ?? "5000");
const fresh = generateStaticKeypair(systemRandom);
const timeout = setTimeout(() => {
  log("phone", `STUCK: no pairing result after ${STUCK_MS}ms (the app's 'Connecting…')`);
  process.exit(1);
}, STUCK_MS);
const short = (a: string) => a.replace(/\/d\/.*/, "/d/…");
const pairOn = (list: readonly string[], dial: (a: string) => () => Promise<never>) =>
  pairDevice({
    payload: { key: identity.identity.publicKey, code: CODE, addresses: list } as never,
    deviceKey: fresh.privateKey,
    name: "iPhone",
    random: systemRandom,
    dial,
    onCompare: (sas) => log("phone", `compare ${sas} (initialize answered)`),
  });
try {
  let result: unknown;
  if (process.argv[4] === "race") {
    // FIX SHAPE: the app's own staggered race (R6) decides at socket-open; the
    // winner alone runs the unchanged exchange.
    const { firstAnswering } = await import(
      "../../worktrees/relay-pairing/apps/mobile/src/address-dial.ts"
    );
    result = await firstAnswering(
      addresses,
      {
        open: (a: string) => {
          log("phone", `open ${short(a)}`);
          return webSocketChannelFactory(a)();
        },
        abandon: (c: { close(): void }) => c.close(),
        confirm: (c: unknown) => pairOn(["winner"], () => async () => c as never),
      },
      { lastGood: undefined },
    );
  } else {
    result = await pairOn(addresses, (address) => {
      log("phone", `dial ${short(address)}`);
      return webSocketChannelFactory(address) as never;
    });
  }
  log("phone", `paired ${JSON.stringify(result).slice(0, 80)}`);
} catch (error) {
  log("phone", `FAILED ${(error as Error).constructor.name}: ${(error as Error).message}`);
}
clearTimeout(timeout);
void encodeBase64Url;
process.exit(0);
```

Output. `compare …` = `initialize` answered over the relay and the phone shows the
code; the closing `STUCK` line in A and C is `device/pair` waiting for a human `y`
(no `tentacle pair` in the repro) — expected, and AFTER the compare.

```
# A — relay is the only address (`bun repro.ts 0 5000`): the relay path works
   12ms relay  ready fgkrQr2v
   12ms daemon relay-no-push
   12ms daemon relay-ready fgkrQr2v
   16ms phone  dial ws://127.0.0.1:63188/d/…
   18ms relay  dial-open fgkrQr2v
   21ms daemon relay-open
   21ms relay  accept fgkrQr2v
   24ms daemon pairing-open
   25ms phone  compare 174932 (initialize answered)
 5017ms phone  STUCK: no pairing result after 5000ms (the app's 'Connecting…')

# B — the QR's real shape, 2 dead direct addresses then the relay (`bun repro.ts 2 60000`): THE BUG
   12ms relay  ready fgkrQr2v
   12ms daemon relay-no-push
   12ms daemon relay-ready fgkrQr2v
   16ms phone  dial ws://127.0.0.1:63615/e2e?dead=0
60017ms phone  STUCK: no pairing result after 60000ms (the app's 'Connecting…')
   (in 60 s the relay is never dialled: no `dial-open` at all)

# C — same addresses through the app's existing R6 race (`bun repro.ts 2 5000 race`): THE FIX SHAPE
   11ms relay  ready fgkrQr2v
   11ms daemon relay-no-push
   11ms daemon relay-ready fgkrQr2v
   18ms phone  open ws://127.0.0.1:63850/e2e?dead=0
  769ms phone  open ws://127.0.0.1:63850/e2e?dead=1
 1520ms phone  open ws://127.0.0.1:63848/d/…
 1522ms relay  dial-open fgkrQr2v
 1533ms daemon relay-open
 1534ms relay  accept fgkrQr2v
 1540ms daemon pairing-open
 1542ms phone  compare 600529 (initialize answered)
 5016ms phone  STUCK: no pairing result after 5000ms (the app's 'Connecting…')
```

## Implementation

*— claude-opus-5-5, 2026-11-15*

### Load-bearing assumption

**`pairDevice` does not dial address *i+1* while address *i*'s open is pending,
and nothing bounds that wait.** Proved: the loop `for (const address of
options.payload.addresses) { try { return await pairAt(address, options) } … }`
(`packages/client/src/pairing.ts:129-131`) awaits `pairAt`, whose first step is
`await factory()` (`pairing.ts:161`) → the dial; the app's dial is
`webSocketChannelFactory` (`apps/mobile/App.tsx:725-727`), a promise settled only
by the socket's `open` or `close` events (`packages/client/src/ws-channel.ts:216-233`),
with no timer. Repro run B: 60 s, the relay never dialled. Repro run C: the same
addresses through `firstAnswering` reach the relay at 1.5 s and show the compare
code. The fix stands on this and on nothing else.

### Preconditions

- `firstAnswering` is pure and React-free; its only import is `ChannelError`
  from `@tentacle/client` (`apps/mobile/src/address-dial.ts:40`), which lives in
  `packages/client/src/link-machine.ts`. So it can move into `@tentacle/client`
  with no new dependency, and the app already depends on `@tentacle/client`
  (`apps/mobile/src/connection.ts:25`).
- The race is decided at socket **open**; only the winner runs `confirm`; a loser
  is `abandon`ed BEFORE any handshake (`address-dial.ts:257-272`). On the relay a
  pre-handshake close forgets the stream and frees its per-IP slot
  (`relay-core.ts:723-735`); on a direct `/e2e` it ends the handshake-limiter slot
  (`relay-link.ts` / `ws-server.ts` close paths). So a raced pairing leaves no
  daemon-side pairing state on a losing path, and **cannot spend the one-time code
  twice**: the code is sent only in `device/pair`, after the handshake, on the
  winner alone (`pairing.ts:198-199`).
- A winner whose `confirm` fails falls through to the addresses after it
  (`address-dial.ts:164-168`); only `isTerminalDialError` (`unauthorized`) stops
  the loop (`address-dial.ts:104-106, 161-163`). Pairing needs `PairingRefused` to
  stop it as well (today's rule, `pairing.ts:133-138`: a refusal is per computer;
  `too_many_attempts` must not be spent again).
- `device/pair` has no deadline by design (`pairing.ts:81-94`, F3); `initialize`
  has 30 s (`pairing.ts:177-190`). Both stay unchanged — they run inside the
  winner's `confirm`, after the race is decided.
- No §7 invariant is touched: no protocol schema, no persisted format, no daemon or
  relay code, no terminal path. "One session path" is unaffected (pairing never
  builds a `RemoteClient`).

### Design

1. **Move the race into the client package.** `git mv
   apps/mobile/src/address-dial.ts packages/client/src/address-dial.ts`
   (import `ChannelError` from `./link-machine.ts`), export it from
   `packages/client/src/index.ts`. `apps/mobile/src/connection.ts` imports
   `firstAnswering` / `DialMemory` / `DialFailure` from `@tentacle/client`. Behaviour
   of `openComputer` is byte-for-byte unchanged.
2. **Two options on `FirstAnsweringOptions`**, both defaulting to today's behaviour
   so `openComputer` does not change:
   - `isTerminal?: (error: unknown) => boolean` (default `isTerminalDialError`) —
     replaces the hard-coded check at `address-dial.ts:161`.
   - `openDeadlineMs?: number` (default: none) — if no socket has OPENED within it
     since the round started, the round finishes `failed` with
     `ChannelError("unreachable", …)` and `at: undefined`; any socket that opens
     later is `abandon`ed on arrival (the existing `settled` branch,
     `address-dial.ts:258-261`). The timer goes through the injected `DialTimer`.
     (`openComputer` needs none: its redial already sits under the client's 15 s
     deadline, `link-machine.ts:25`.)
3. **`pairDevice` races** (`packages/client/src/pairing.ts:127-150`): replace the
   `for` loop with `firstAnswering(payload.addresses, steps, { lastGood: undefined },
   { isTerminal: (e) => e instanceof PairingRefused || isTerminalDialError(e),
   openDeadlineMs: PAIRING_OPEN_DEADLINE_MS, ...options.race })`, where
   - `open(address)` = `options.dial(address)()` (the raw channel);
   - `abandon(channel)` = `channel.close()`;
   - `confirm(channel)` = today's `pairAt` body run on that channel
     (`secureChannelFactory(async () => channel, …)` then `initialize`,
     `onCompare`, `device/pair`, the `finally { peer.close() }`), i.e. `pairAt`
     refactored to take the opened channel instead of an address.
   - `PAIRING_OPEN_DEADLINE_MS = 15_000` (exported; same scale as the link's dial
     deadline). `options.race?: FirstAnsweringOptions` is a test seam (timer,
     `staggerMs`), not used by the app.
   - The "nothing answered" error: `firstAnswering` already rethrows the last
     failure unchanged (`address-dial.ts:170`), which keeps `describePairingError`'s
     input shape (a `ChannelError` / `NoiseError`-mapped error). Keep the existing
     `ChannelError("unreachable", "no pairing address answered …")` wording only if
     a test pins it; otherwise the race's own last error is the more specific one.
4. **Cancel closes every channel the race handed out** (`apps/mobile/src/pairing-flow.ts:436-455`).
   Today `inFlight` holds the LAST opened channel; with a race the last opened can
   be an abandoned loser while the winner is mid-exchange, so Cancel would close the
   wrong socket. Track a `Set<DuplexChannel>` of opened channels (removed on their
   close), and `onAbort` closes all of them; a channel that opens after abort is
   closed at once (today's check, kept).

### Files (dependency order)

- `packages/client/src/address-dial.ts` (moved from `apps/mobile/src/`; + `isTerminal`, `openDeadlineMs`)
- `packages/client/src/index.ts` (export it)
- `packages/client/src/pairing.ts` (race; `pairAt` takes a channel; `PAIRING_OPEN_DEADLINE_MS`; `race` seam)
- `apps/mobile/src/connection.ts` (import path only)
- `apps/mobile/src/pairing-flow.ts` (Cancel closes every opened channel)
- `packages/client/test/address-dial.test.ts` (moved from `apps/mobile/test/`; + new cases)
- `packages/client/test/pairing.test.ts` (new cases)
- `packages/cli/test/serve-relay.test.ts` (one end-to-end case, below)
- `apps/mobile/test/pairing-flow.test.ts` (Cancel case)
- `changelog.d/relay-pairing.fixed.md`

### Failure modes

| Case | Today | After | Converges because |
|---|---|---|---|
| Direct addresses hang (4G), relay up | stuck "Connecting…" (run B) | relay opens at ~1.5 s, pairs | stagger starts every address; first open wins |
| Every address hangs (relay down too) | stuck forever | `unreachable` after 15 s → "Can't reach…" + Retry | `openDeadlineMs` |
| Every address refuses fast | last error after the sequence | same, after the race | `failed` with `at: undefined` |
| A direct address opens but its handshake fails (stale key / another host on that IP) | next address | next addresses (fall-through) | `address-dial.ts:164-168` |
| `PairingRefused` (`invalid_code`, `used`, `declined`, `timeout`, `too_many_attempts`) on the winner | stops | stops, rethrown as-is | `isTerminal` |
| `unauthorized` (Noise `denied`: no window / wrong pinned key) | thrown, next address tried | stops (same computer key on every address) | `isTerminalDialError` |
| A second path opens after the winner | n/a | closed pre-handshake: no daemon state, code not sent | `abandon`; code only in `device/pair` |
| Relay loser closed before the daemon's accept | n/a | relay logs `accept-refused unknown`, daemon `relay-open` + `e2e-violation closed` — log noise only, no slot leaked | `relay-core.ts:723-735`; limiter `endSlot` on leg close |
| Cancel mid-race / mid-exchange | closes last opened | closes every opened channel; `device/pair` rejects → `CANCELLED_MESSAGE` | Set of opened channels |
| Human slower than 30 s at the compare | pairs (F3) | pairs: `device/pair` runs in `confirm`, after the race, still no deadline | race already decided; deadline covers OPEN only |
| Relay holds the phone (daemon not registered yet, F17) | — | relay socket is OPEN while held, so it wins; the 10 s Noise timeout / 5 s hold behave as today | `relay-core.ts` `dial` → `held` |

### Tests (red first — each shown failing on current `main` before the change)

- `packages/client/test/pairing.test.ts`
  - **"a hanging first address does not keep pairing from the next one"**: payload
    `[hanging TCP listener, real daemon /e2e]`, `race: { staggerMs: 20 }`; assert
    `onCompare` fires and the device registers within 2 s. **Red today**: hangs
    (the test's own timeout), exactly run B.
  - **"every address hanging fails `unreachable` within the open deadline"**:
    `race: { openDeadlineMs: 100 }`, two hanging listeners → rejects with
    `ChannelError` kind `unreachable`. Red today: never settles.
  - **"a refusal on the winner is not retried on another address"**: two addresses
    to the same daemon with a wrong code → `PairingRefused{invalid_code}`, and the
    daemon saw exactly one `device/pair` (no second claim). Guards `isTerminal`.
  - **"a loser that opens after the winner is closed before any handshake"**:
    two real addresses, the second opens late → the daemon audits exactly one
    `pairing-open`.
  - Existing cases keep passing unchanged (F3 slow human, `initialize` deadline,
    wrong pinned key leaves the code unspent, pairing-only connection closed).
- `packages/client/test/address-dial.test.ts` (moved; existing cases unchanged)
  - `isTerminal` override stops the loop on a custom error; default still only `unauthorized`.
  - `openDeadlineMs` with the hand-driven timer: fires → `failed`; a socket opening
    after it is `abandon`ed. Mutation check: drop the deadline branch → red.
- `packages/cli/test/serve-relay.test.ts` — **the bug's real shape end to end**:
  real relay + `serve` with a pairing window; phone `pairDevice` with
  `[hanging listener, serve's relay address]` → compare code reached over the
  relay (`relay-open` + `pairing-open` in the audit). Red today (hangs).
- `apps/mobile/test/pairing-flow.test.ts` — **Cancel closes the winner, not a
  loser**: fake dials where address 1 opens first (winner, exchange pending) and
  address 2 opens late (abandoned); abort → the winner's channel is closed and the
  outcome is the cancelled failure. Red today (`inFlight` is the loser).
- Non-vacuity (§9): for the two "hang" tests, revert `pairDevice` to the `for` loop
  and confirm they fail; for Cancel, revert to single `inFlight`.

Validation: narrow files per slice, then `bun run check`; Maestro relay-only flow
unchanged. Real-phone check (owner): on 4G, scan a QR whose first addresses are
LAN/Tailscale → compare code within ~2 s, `y` on the Mac pairs.

### Notes / debt

- The ~1 s relay sockets of attempts 2–3 and attempt 1's silent `pairing-open`
  are unexplained by code alone (see Context, "Unverified"); likely the Computers
  probe of the old record + `suspend()` on `inactive`. Follow-up only if the app
  log shows it costs something (it leaks no slot).
- The daemon starts its Noise responder on the accept leg's open, before the relay
  confirms the token (`relay-link.ts:679-700`), so a refused leg reads as
  `e2e-violation closed`. Harmless; a clearer audit line (`relay-accept-refused`)
  would need a relay ack frame — not worth a relay protocol change here.
- Two direct addresses are dialled even when the relay is the only one that can
  answer: 1.5 s of stagger on 4G. Accepted (R6's Owner Q6 chose the stagger).

## Execution

*(empty — filled by the executor)*

## Review

*(empty — filled by the reviewer)*
