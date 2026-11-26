/**
 * Sibling discovery, `serve` side (docs/feat/sibling-discovery.md, task 10).
 *
 * One driver per `serve` PROCESS (owned by `startDaemon`, like the reaper):
 *
 * - `buildDiscovery` — PURE: this daemon's own options plus every sibling's
 *   `<configDir>/daemons/<pid>.json` plus this machine's interfaces → the
 *   snapshot's daemons. Every address rule is `pairAddresses`' (9d), so the QR
 *   and the announcement cannot disagree;
 * - `nextMembership` — PURE hysteresis: a sibling that merely MISSED a poll is
 *   kept one more, so a stop never flickers on the phone;
 * - `startDiscovery` — the driver: a HEARTBEAT (always on: this daemon's own
 *   record stays fresh, so siblings can tell it alive from a pid-reuse phantom,
 *   F2) and a POLL (only while a client is subscribed — nothing is read or built
 *   when nobody is looking, F14).
 *
 * A pod daemon never builds one (AGENTS §7 "a pod is not trusted": a pod learns
 * nothing about the laptop's other daemons, and the laptop takes no address
 * from it).
 */
import {
  type DaemonRecord,
  processAlive,
  readDaemonRecords,
  sweepDeadDaemonRecords,
  touchDaemonRecord,
  writeDaemonRecord,
} from "@tentacle/daemon";
import {
  type DaemonDiscovery,
  type DiscoveredDaemon,
  MAX_DISCOVERED_DAEMONS,
  MAX_PAIRING_ADDRESSES,
} from "@tentacle/protocol";
import {
  type InterfaceEntry,
  machineInterfaces,
  pairAddresses,
  recordAddressList,
} from "./pair-addresses.ts";

/** The timers and clock the driver uses (injected: a test drives time by hand). */
export interface DiscoveryTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

const systemTimers: DiscoveryTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/** How often a subscribed daemon re-reads the sibling list (F6: an address change lands within this). */
export const DEFAULT_POLL_MS = 2000;
/** How often a `serve` refreshes its own record's mtime (owner Q5). */
export const DEFAULT_HEARTBEAT_MS = 10_000;
/** Older than this, a record's mtime no longer says "alive" (owner Q5; F2). */
export const DEFAULT_STALE_AFTER_MS = 30_000;
/** Consecutive polls a sibling may be missing before it leaves the snapshot. */
export const MISSES_BEFORE_DROP = 2;

/**
 * The addresses ONE record offers a phone: `pairAddresses`' derivation — a
 * loopback bind contributes no BIND-derived address, a wildcard expands to this
 * machine's reachable IPv4s, a specific host is itself, `ws`/`wss` from `tls`,
 * then the record's own `addresses` (`--address`: a tailnet name, a tunnel, and
 * the mobile relay's derived `/d/<id>/e2e` — docs/feat/mobile-relay.md R5a/R5b),
 * deduped keeping the FIRST occurrence and capped.
 *
 * ONE rule for both readers (the QR and this announcement), which is the whole
 * point of sharing it: the daemon's own order is the phone's dial order, and two
 * derivations would eventually disagree about it.
 */
function addressesOf(record: DaemonRecord, interfaces: readonly InterfaceEntry[]): string[] {
  // The SAME list `pair` builds (one order: the phone's), CAPPED here: a
  // snapshot line must always be produced, and the cap keeps the first — which
  // is where `pair` would have refused a human's `--address`.
  return recordAddressList(record, interfaces).slice(0, MAX_PAIRING_ADDRESSES);
}

/**
 * Build the snapshot's daemons. PURE: no clock, no filesystem — the driver
 * passes already-fresh records and this machine's interfaces.
 *
 * `self` FIRST and always present (F16), built from THIS process's options and
 * never from its file: a failed record write must not make a daemon invisible
 * to its own clients (F4). A record whose pid is this process is skipped, so a
 * daemon never lists itself twice. A sibling with no reachable address is still
 * listed with `addresses: []` (owner Q4: the app says "not reachable from the
 * phone" rather than hiding a project). Order: self, then the reader's.
 */
export function buildDiscovery(input: {
  readonly self: DaemonRecord;
  readonly records: readonly DaemonRecord[];
  readonly interfaces: readonly InterfaceEntry[];
}): DiscoveredDaemon[] {
  const self: DiscoveredDaemon = {
    cwd: input.self.cwd,
    addresses: addressesOf(input.self, input.interfaces),
    startedAt: input.self.startedAt,
    self: true,
  };
  // One entry per project (P8: one live daemon per project, so this only bites
  // on a record the sweep has not removed yet).
  const seen = new Set<string>([self.cwd]);
  const others: DiscoveredDaemon[] = [];
  for (const record of input.records) {
    if (record.pid === input.self.pid || seen.has(record.cwd)) {
      continue;
    }
    seen.add(record.cwd);
    others.push({
      cwd: record.cwd,
      addresses: addressesOf(record, input.interfaces),
      startedAt: record.startedAt,
    });
  }
  return [self, ...others].slice(0, MAX_DISCOVERED_DAEMONS);
}

/** What `nextMembership` must remember between polls. */
export interface MembershipState {
  /** The siblings the last snapshot held (so a missing one is noticed at all). */
  readonly members: readonly DiscoveredDaemon[];
  /** For a sibling kept although its poll missed it: how many polls that has lasted. */
  readonly misses: ReadonlyMap<string, number>;
}

export interface Membership {
  readonly members: readonly DiscoveredDaemon[];
  readonly state: MembershipState;
}

/**
 * Hysteresis, PURE: which siblings the snapshot should hold after one poll.
 *
 * A sibling that is merely MISSING from this poll is kept until
 * `MISSES_BEFORE_DROP` consecutive polls have missed it, because a sibling's
 * heartbeat or a reader waking first after a sleep is not a project going away
 * (F2/F3). A DEAD pid's sibling is dropped at once: a dead pid is the one
 * definitive signal (F1). A sibling that comes back takes its fresh entry and
 * resets its count.
 *
 * Keyed by `cwd` (the project, P8): the phone's rows are projects, so a sibling
 * restarted under a new pid is the SAME row — and its new `startedAt` tells the
 * app it restarted.
 */
export function nextMembership(
  previous: MembershipState | undefined,
  seen: readonly DiscoveredDaemon[],
  deadCwds: ReadonlySet<string>,
): Membership {
  const known = new Set(seen.map((daemon) => daemon.cwd));
  const members: DiscoveredDaemon[] = [...seen];
  const misses = new Map<string, number>();
  for (const entry of previous?.members ?? []) {
    // Back (its fresh entry wins), or provably dead (F1): no count to keep.
    if (known.has(entry.cwd) || deadCwds.has(entry.cwd)) {
      continue;
    }
    const next = (previous?.misses.get(entry.cwd) ?? 0) + 1;
    if (next < MISSES_BEFORE_DROP) {
      misses.set(entry.cwd, next);
      members.push(entry);
    }
  }
  return { members, state: { members, misses } };
}

/** A running discovery driver: what `serve` starts after its listener is up. */
export interface DiscoveryDriver {
  /** The snapshot as of now (never empty of `self`). */
  current(): DaemonDiscovery;
  subscribe(listener: (discovery: DaemonDiscovery) => void): () => void;
  /** Polls run so far (a test's evidence that none run with nobody subscribed, F14). */
  polls(): number;
  /** Stop the heartbeat and the poller (idempotent). */
  stop(): void;
}

/**
 * Start the one driver of this process. `self` is built by the caller from ITS
 * options (the bound port is only known after the listener is up).
 *
 * Failure modes it designs out:
 * - **F1** a dead pid's record: the reader skips it (and `sweepDeadDaemonRecords`
 *   deletes it);
 * - **F2** a reused pid: the heartbeat stops with the process, so its record's
 *   mtime goes old and `freshWithinMs` ignores it (the sweep deletes it once the
 *   holder's start time proves it is a stranger);
 * - **F3** a suspended host: a poll whose own gap exceeded `staleAfterMs` does
 *   NOT apply freshness (every record looks ancient after a sleep). The
 *   heartbeat covers the same sleep when the poller was OFF during it, which is
 *   the normal phone case (a beat the process MISSED is a suspended process);
 * - **F2 again** the first poll after a long IDLE spell (no subscriber, no
 *   sleep): the poller's own gap is not a sleep signal there, so it is reset
 *   when the poller arms — otherwise that poll would switch freshness off and
 *   announce a pid-reuse phantom (Repro 3) until two polls later;
 * - **F15** a poll error: the last snapshot is kept, one log line per distinct
 *   message;
 * - **F14** many subscribers: ONE poller, and none at all with zero.
 */
export function startDiscovery(options: {
  readonly configDir: string;
  readonly self: DaemonRecord;
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
  readonly staleAfterMs?: number;
  readonly timers?: DiscoveryTimers;
  readonly now?: () => number;
  readonly interfaces?: () => readonly InterfaceEntry[];
  /** Overridden by a test (an unreadable dir); default `readDaemonRecords`. */
  readonly readRecords?: (configDir: string, freshWithinMs: number) => readonly DaemonRecord[];
  /** Pids the reader skipped, so a kept sibling whose daemon died can be dropped at once (F1). */
  readonly allRecords?: (configDir: string) => readonly DaemonRecord[];
  readonly alive?: (pid: number) => boolean;
  readonly touch?: (configDir: string, pid: number) => boolean;
  /** Writes `self` back when a beat finds it gone; default `writeDaemonRecord`. */
  readonly rewrite?: (configDir: string, self: DaemonRecord) => { readonly ok: boolean };
  readonly log?: (line: string) => void;
}): DiscoveryDriver {
  const timers = options.timers ?? systemTimers;
  const now = options.now ?? (() => timers.now());
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  // THIS machine's interfaces, re-read on every poll (a Wi-Fi or DHCP change is
  // what F6 announces). `serve` passes none, and `pair`'s QR uses the same
  // helper, so the QR and the announcement cannot disagree.
  const interfacesOf = options.interfaces ?? machineInterfaces;
  const touch = options.touch ?? touchDaemonRecord;
  const rewrite = options.rewrite ?? writeDaemonRecord;
  const read =
    options.readRecords ??
    ((configDir: string, freshWithinMs: number) =>
      // `alive` is injectable so a test can present a sibling the real pid
      // check would reject (and the production default stays `processAlive`).
      readDaemonRecords(configDir, { freshWithinMs, alive }));
  const alive = options.alive ?? processAlive;
  const allRecords =
    options.allRecords ?? ((configDir: string) => readDaemonRecords(configDir, { alive }));
  const log = options.log ?? (() => {});

  const listeners = new Set<(discovery: DaemonDiscovery) => void>();
  let snapshot: DaemonDiscovery = {
    rev: 0,
    daemons: buildDiscovery({
      self: options.self,
      records: [],
      interfaces: interfacesOf(),
    }),
  };
  let membership: MembershipState | undefined;
  let lastPollAt = now();
  let lastBeatAt = lastPollAt;
  /**
   * When the beat the process MISSED happened (the host slept), so the next
   * poll skips freshness (F3). A TIMESTAMP, not a flag: with no subscriber the
   * poller is off, so nothing would clear a flag. The skip only has to cover
   * the window before the siblings' own next beat (≤ `heartbeatMs`), so it
   * expires — a sleep an hour ago says nothing about a record now, and letting
   * it stand would re-admit the pid-reuse phantom (Repro 3).
   */
  let sleptAt: number | undefined;
  let polls = 0;
  /** The distinct log messages already emitted, so a repeating error says it once (F15). */
  const logged = new Set<string>();
  let pollTimer: unknown;
  let stopped = false;

  const say = (line: string): void => {
    if (logged.has(line)) {
      return;
    }
    logged.add(line);
    log(line);
  };

  /** One poll: read, sweep, build, apply hysteresis, notify only on a CHANGE. */
  const poll = (): void => {
    if (stopped) {
      return;
    }
    const at = now();
    // F3: the poll before this one may have been long ago (a suspended host).
    // Every record's mtime looks ancient right after a sleep, so freshness is
    // not applied for the one poll that notices the gap; the hysteresis covers
    // a sibling whose own timer then fires a beat later. A heartbeat that
    // missed its own period says the same for a sleep the POLLER did not see
    // (nobody was subscribed), which is why `sleptAt` is consulted too — but
    // only while the waking poll is still near the wake.
    const gap = at - lastPollAt;
    lastPollAt = at;
    const afterSleep =
      gap > staleAfterMs || (sleptAt !== undefined && at - sleptAt <= staleAfterMs);
    sleptAt = undefined;
    polls++;
    let records: readonly DaemonRecord[];
    try {
      records = read(options.configDir, afterSleep ? Number.MAX_SAFE_INTEGER : staleAfterMs);
    } catch (error) {
      // F15: a transient EACCES must not make the siblings vanish.
      say(`cannot read the sibling records: ${(error as Error).message}`);
      return;
    }
    try {
      // Dead pids every poll; the reused-pid proof not on the waking one, where
      // every mtime looks old (F3).
      sweepDeadDaemonRecords(options.configDir, {
        alive,
        now: at,
        ...(afterSleep ? {} : { freshWithinMs: staleAfterMs }),
      });
    } catch {
      // Housekeeping: a record it cannot remove stays, and the reader already
      // ignores a dead pid (F1). Never fatal.
    }
    let built: DiscoveredDaemon[];
    try {
      built = buildDiscovery({ self: options.self, records, interfaces: interfacesOf() });
    } catch (error) {
      say(`cannot build the sibling list: ${(error as Error).message}`);
      return;
    }
    // A KEPT sibling whose daemon has died drops at once (F1): the reader
    // cannot report it (it skips dead pids), so the pids come from a plain read.
    const deadCwds = new Set<string>();
    try {
      for (const record of allRecords(options.configDir)) {
        if (!alive(record.pid)) {
          deadCwds.add(record.cwd);
        }
      }
    } catch {
      // Unreadable is not dead: keep the hysteresis as it is.
    }
    const next = nextMembership(membership, built, deadCwds);
    membership = next.state;
    if (sameDaemons(snapshot.daemons, next.members)) {
      return;
    }
    snapshot = { rev: snapshot.rev + 1, daemons: [...next.members] };
    for (const listener of [...listeners]) {
      listener(snapshot);
    }
  };

  const heartbeat = (): void => {
    if (stopped) {
      return;
    }
    // A beat this late is a beat the process MISSED: the host was suspended
    // (nothing ran, not even this timer). Recorded for the next poll, which is
    // then the waking one and must not apply freshness (F3) — this is the only
    // sleep signal a daemon with no subscriber has.
    const beatAt = now();
    if (beatAt - lastBeatAt > staleAfterMs) {
      sleptAt = beatAt;
    }
    lastBeatAt = beatAt;
    // A record gone while we run (swept by mistake, removed by hand) is written
    // back (docs/fix/daemon-records-stale.md D4); `stop()` ends the beats before
    // the record is removed, so this cannot resurrect a stopping serve's.
    if (
      !touch(options.configDir, options.self.pid) &&
      !rewrite(options.configDir, options.self).ok
    ) {
      // F4: not fatal — this daemon works, its siblings just cannot see it now.
      say(`cannot refresh this daemon's record (its siblings may not list it until it restarts)`);
    }
  };

  const stopPoll = (): void => {
    if (pollTimer === undefined) {
      return;
    }
    timers.clearInterval(pollTimer);
    pollTimer = undefined;
  };

  // The heartbeat is ALWAYS on (owner Q5): without it a daemon with no client
  // would look dead to its siblings within `staleAfterMs`.
  const heartbeatTimer = timers.setInterval(heartbeat, heartbeatMs);

  return {
    current: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        // The first subscriber gets a build before returning, so `current()` is
        // never empty of `self` on a cold start. The poller was OFF until now,
        // so its own gap says nothing about a sleep (the heartbeat's does):
        // measuring it would switch freshness off for exactly the poll a phone
        // waking a long-idle daemon triggers (Repro 3).
        lastPollAt = now();
        poll();
        pollTimer = timers.setInterval(poll, pollMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopPoll();
        }
      };
    },
    polls: () => polls,
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      timers.clearInterval(heartbeatTimer);
      stopPoll();
      listeners.clear();
    },
  };
}

/** Deep equality over the canonical order (self first, then the reader's order). */
function sameDaemons(a: readonly DiscoveredDaemon[], b: readonly DiscoveredDaemon[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((daemon, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      daemon.cwd === other.cwd &&
      daemon.startedAt === other.startedAt &&
      (daemon.self === true) === (other.self === true) &&
      daemon.addresses.length === other.addresses.length &&
      daemon.addresses.every((address, j) => address === other.addresses[j])
    );
  });
}
