/**
 * Who may open a device connection, one instance per `serve` daemon
 * (docs/feat/device-pairing.md 9b) — the authority the `ws-server`'s `/e2e`
 * route asks, over the 9a store.
 *
 * Two jobs, deliberately separated:
 *
 * - `authorize(key)` is the Noise responder's gate: CHEAP and SIDE-EFFECT FREE
 *   (it runs on every message 1, replays included — P2). Before deciding it
 *   STATS the store and reloads on any change, so a revoke is honoured on the
 *   very next handshake, not at the next tick (F8). A known key is a device; an
 *   unknown key is a pairing-only connection, but only while a real pairing
 *   window is open (a fresh read: a phone that scans in the first second must
 *   not be refused, F1); anything else is denied.
 * - a POLL (default 1 s, injectable) that CLOSES sockets: the devices a revoke
 *   removed, and — after `devices reset` — every device, whose identities are
 *   gone anyway. `fs.watch` would be an accelerator only; it is not used,
 *   because it has no guarantee of delivery and the poll is what the contract
 *   promises ("within one tick").
 *
 * The verdict carries the reassembly cap (P1): a paired device gets the
 * responder's default, an admitted stranger a small one, because a pairing
 * connection should never be able to make the daemon buffer 32 MiB.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  ADOPTED_DIR,
  type DeviceIdentity,
  type DeviceProjectRef,
  type LiveClock,
  deviceIdOf,
  hasLivePairing,
  readAdoptions,
  readIdentity,
  readRegistry,
} from "./device-store.ts";

/** A pairing connection's reassembly cap: 64 KiB, far below a device's 32 MiB (P1). */
export const PAIRING_MAX_MESSAGE_BYTES = 64 * 1024;
/** A paired device gets the responder's own default (an ordinary client). */
export const DEVICE_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
/** How often the poll looks for a changed store. */
export const DEVICE_POLL_INTERVAL_MS = 1_000;

/** An ALLOW: the two roles a device-route connection can have. */
export type DeviceAllow =
  | {
      readonly kind: "device";
      readonly id: string;
      readonly allow: true;
      readonly maxMessageBytes: number;
      /**
       * A LEGACY entry no project has adopted yet (docs/feat/mobile-projects.md
       * §3): the route must `adoptLegacy` on the RESOLVE — and close the socket,
       * before any `Connection` exists, if another project won it.
       */
      readonly adopt?: true;
    }
  | { readonly kind: "pairing"; readonly allow: true; readonly maxMessageBytes: number };

/** What `authorize` decided. `false` is the deny the responder turns into message 2. */
export type DeviceVerdict = DeviceAllow | false;

/** A live connection the authority may close (the ws-server's per-device entry). */
export interface DeviceClose {
  close(): void;
}

export interface DeviceAuthorityTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemTimer: DeviceAuthorityTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // The poll is a housekeeping timer, never a reason to keep the process
    // alive: `serve`'s own listener decides that, and an un-unref'd interval
    // makes `bun test` (and a stopped daemon's caller) wait forever.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface DeviceAuthorityOptions {
  /** The computer's config dir (`<configDir>/devices/` is the store). */
  readonly configDir: string;
  /**
   * The project THIS serve is (docs/feat/mobile-projects.md §2): `key` =
   * `projectKey(cwd)`. Required — there is no computer-wide mode: a device opens
   * a serve only if its entry is of this project (or a legacy entry this project
   * adopted, §3), and a stranger pairs only on a window of this project.
   */
  readonly project: DeviceProjectRef;
  /** Injectable for tests; default the process timers. */
  readonly timers?: DeviceAuthorityTimer;
  readonly pollIntervalMs?: number;
  /** Injectable clock (expiries are read against it only: F24). */
  readonly now?: () => number;
  /** Injectable pid liveness (a window whose `pair` died is not usable, F2). */
  readonly alive?: (pid: number) => boolean;
  /** Operator lines: `device-revoked <id8> closed=<n>`, `device-store-unreadable …`. */
  readonly onAudit?: (line: string) => void;
}

interface Snapshot {
  /**
   * The ids valid HERE: entries of this project, and legacy entries this project
   * adopted. What `knows` and the revoke poll count (`wantsReachability`
   * counts these AND `adoptable`).
   */
  readonly devices: ReadonlySet<string>;
  /**
   * Legacy entries NO project has adopted yet: admitted as `device` with
   * `adopt: true` (the route binds them on the resolve). Counted by
   * `wantsReachability` (every serve dials the relay until one adopts it —
   * else a relay-only phone is never adopted, review round 1 F1), NOT by
   * `knows`.
   */
  readonly adoptable: ReadonlySet<string>;
  readonly identity: DeviceIdentity | undefined;
  /** The computer key's id: a change means every phone's pin is now wrong (F11). */
  readonly identityId: string | undefined;
  /** The store could not be read: everyone is denied until it can be (F14). */
  readonly broken: boolean;
}

/** A public key's device id (an identity is addressable the same way a device is). */
function idOf(identity: DeviceIdentity | undefined): string | undefined {
  return identity === undefined ? undefined : deviceIdOf(identity.publicKey);
}

const EMPTY: Snapshot = {
  devices: new Set(),
  adoptable: new Set(),
  identity: undefined,
  identityId: undefined,
  broken: false,
};

export class DeviceAuthority {
  private readonly store: string;
  /** This serve's project (§2): the scope of every verdict. */
  readonly project: DeviceProjectRef;
  private readonly timer: DeviceAuthorityTimer;
  private readonly now: () => number;
  /** `hasLivePairing`'s injected half: pid liveness (the clock is read per call). */
  private readonly clock: Omit<LiveClock, "now">;
  private readonly onAudit: ((line: string) => void) | undefined;
  private readonly pollHandle: unknown;
  /** Every live connection, by device id (a device may hold several). */
  private readonly live = new Map<string, Set<DeviceClose>>();
  private stopped = false;
  /** What the last successful read said — the poll's "did anything change" base. */
  private snapshot: Snapshot = EMPTY;
  /** A read failure is worth ONE line per fault, not one per handshake (F14). */
  private readonly reported = new Set<"registry" | "identity">();

  constructor(options: DeviceAuthorityOptions) {
    this.store = options.configDir;
    this.project = { key: options.project.key, cwd: options.project.cwd };
    this.timer = options.timers ?? systemTimer;
    this.now = options.now ?? Date.now;
    this.clock = options.alive ? { alive: options.alive } : {};
    this.onAudit = options.onAudit;
    // Read once at construction: the static key must exist before any handshake,
    // and a broken store is reported before the first client rather than after.
    const initial = this.read();
    if (initial !== undefined) {
      this.snapshot = initial;
    }
    const period = options.pollIntervalMs ?? DEVICE_POLL_INTERVAL_MS;
    this.pollHandle = this.timer.setInterval(() => this.poll(), period);
  }

  /** The static KEY new handshakes get, or `undefined` when the store cannot say. */
  staticKey(): Uint8Array | undefined {
    return this.snapshot.identity?.privateKey;
  }

  /** The identity itself (`name` is what `device/pair`'s result reports). */
  identity(): DeviceIdentity | undefined {
    return this.snapshot.identity;
  }

  /**
   * The Noise responder's verdict for `remoteStatic`. Side-effect free: it
   * reads the store, decides, and writes nothing (P2) — no `seen/`, no sweep,
   * no audit of a SUCCESS (the route does that on the resolve, where a
   * handshake really completed).
   */
  authorize(remoteStatic: Uint8Array): DeviceVerdict {
    if (this.stopped) {
      return false;
    }
    this.refreshIfChanged();
    const snapshot = this.snapshot;
    if (snapshot.broken || snapshot.identity === undefined) {
      return false;
    }
    const id = deviceIdOf(remoteStatic);
    if (snapshot.devices.has(id)) {
      return { kind: "device", id, allow: true, maxMessageBytes: DEVICE_MAX_MESSAGE_BYTES };
    }
    if (snapshot.adoptable.has(id)) {
      // A legacy key no project holds yet (§3). Nothing is WRITTEN here (P1):
      // the route adopts on the resolve, where a handshake really completed.
      return {
        kind: "device",
        id,
        allow: true,
        maxMessageBytes: DEVICE_MAX_MESSAGE_BYTES,
        adopt: true,
      };
    }
    // An entry of ANOTHER project falls through: to this serve it is an
    // unknown key (pairing-only while a window of this project is open).
    // Registering a device is a SINGLE-use code plus the human's `y` (9c); until
    // then an unknown key may do exactly one thing: pair.
    if (this.hasWindow()) {
      return { kind: "pairing", allow: true, maxMessageBytes: PAIRING_MAX_MESSAGE_BYTES };
    }
    return false;
  }

  /**
   * Does anything want this daemon REACHABLE right now — a paired device, or an
   * open pairing window? The mobile relay link dials out only while this is true
   * (docs/feat/mobile-relay.md R4, Owner Q1: a user who never pairs never
   * contacts the relay).
   *
   * READ-ONLY and side-effect free, like `authorize`: it re-reads the store
   * (a device paired a second ago counts immediately) and writes nothing — no
   * `seen/`, no audit. A broken store answers `false`: with nothing readable
   * there is nobody to be reachable for, and the link must not stay dialled out
   * on a guess.
   */
  wantsReachability(): boolean {
    if (this.stopped) {
      return false;
    }
    this.refreshIfChanged();
    if (this.snapshot.broken) {
      return false;
    }
    // An unadopted legacy entry counts too (review round 1 F1): today's phone
    // may reach its computer ONLY through the relay (cellular, or the old
    // direct port is gone), and adoption needs a completed handshake — so every
    // serve stays reachable for it until one project adopts it (Q3).
    return this.snapshot.devices.size > 0 || this.snapshot.adoptable.size > 0 || this.hasWindow();
  }

  /**
   * Does the authority's snapshot list this device right now? The push-time
   * check (docs/feat/mobile-push.md F14): a device a revoke removed is not
   * pushed to, even if a daemon re-wrote its registration in a race. Read-only
   * and side-effect free, like `authorize` (a fresh read, so a revoke counts
   * at once).
   */
  knows(id: string): boolean {
    if (this.stopped) {
      return false;
    }
    this.refreshIfChanged();
    return !this.snapshot.broken && this.snapshot.devices.has(id);
  }

  /** Track a live connection so a revoke can close it. Returns the inverse of `unregister`. */
  register(id: string, close: DeviceClose): void {
    const set = this.live.get(id);
    if (set) {
      set.add(close);
      return;
    }
    this.live.set(id, new Set([close]));
  }

  /** The connection is gone (closed by the peer, the server or a revoke). */
  unregister(id: string, close: DeviceClose): void {
    const set = this.live.get(id);
    if (!set) {
      return;
    }
    set.delete(close);
    if (set.size === 0) {
      this.live.delete(id);
    }
  }

  /** The config dir this authority reads (`<configDir>/devices/`), for the route's `seen/`. */
  get configDir(): string {
    return this.store;
  }

  /** Live connections across every device (tests and the audit line). */
  liveCount(): number {
    let total = 0;
    for (const set of this.live.values()) total += set.size;
    return total;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.timer.clearInterval(this.pollHandle);
    this.live.clear();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Re-read the store when its files changed since the last read. `authorize`
   * and the poll both go through this, so `authorize` alone honours a revoke
   * (F8) and the poll adds only the closing of live sockets.
   */
  private refreshIfChanged(): void {
    const next = this.read();
    if (next === undefined) {
      return; // unchanged
    }
    this.snapshot = next;
  }

  /** The current store, or `undefined` when nothing changed since the last read. */
  private read(): Snapshot | undefined {
    const stamp = this.storeStamp();
    if (stamp !== undefined && stamp === this.stamp) {
      return undefined;
    }
    this.stamp = stamp;
    const registry = readRegistry(this.store);
    const identity = this.identityOf();
    if (identity === undefined) {
      // Its own line, once: a fresh computer (nothing to do — `serve` creates
      // it) reads differently from a damaged file the human must fix (F26).
      this.reportOnce("identity", join(this.store, "devices"), "no usable identity");
    }
    if (!registry.ok) {
      this.reportOnce("registry", registry.path, registry.reason);
      // An unreadable or unknown-version registry is NEVER rewritten here: the
      // human fixes it or runs `devices reset` (F14).
      return {
        devices: new Set(),
        adoptable: new Set(),
        identity,
        identityId: idOf(identity),
        broken: true,
      };
    }
    // The scope (§2): mine, legacy adopted by me, legacy adoptable — and
    // nothing else. An unreadable adoption record counts as "bound elsewhere"
    // (F16): it can only deny.
    const mine = this.project.key;
    const adoptions = readAdoptions(this.store);
    const devices = new Set<string>();
    const adoptable = new Set<string>();
    for (const device of registry.registry.devices) {
      if (device.project !== undefined) {
        if (device.project.key === mine) devices.add(device.id);
        continue;
      }
      const adoption = adoptions.get(device.id);
      if (adoption === undefined) {
        adoptable.add(device.id);
      } else if (adoption.kind === "bound" && adoption.project.key === mine) {
        devices.add(device.id);
      }
    }
    return {
      devices,
      adoptable,
      identity,
      identityId: idOf(identity),
      broken: false,
    };
  }

  private identityOf(): DeviceIdentity | undefined {
    const identity = readIdentity(this.store);
    return identity.ok ? identity.identity : undefined;
  }

  /** A change stamp for the two files that decide access (cheap: two stats). */
  private stamp: string | undefined;

  private storeStamp(): string | undefined {
    // Deliberately filesystem stats, not contents: a revoke must be visible
    // before the next handshake, and reading+parsing the registry on every
    // authorize would be work a replayed message 1 could multiply.
    const parts: string[] = [];
    // The adoption DIRECTORY too (§3): its mtime moves when a record is created
    // or removed, so an adoption by another serve is seen on the next handshake.
    for (const name of ["registry.json", "identity.json", ADOPTED_DIR]) {
      try {
        const s = statSync(join(this.store, "devices", name));
        parts.push(`${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push("-");
      }
    }
    return parts.join("|");
  }

  private reportOnce(what: "registry" | "identity", path: string, reason: string): void {
    if (this.reported.has(what)) {
      return;
    }
    this.reported.add(what);
    this.onAudit?.(`device-store-unreadable ${path}: ${reason}`);
  }

  /** Is a pairing window open right now? A FRESH, side-effect-free read (P2). */
  private hasWindow(): boolean {
    return (
      // The time is read HERE, never captured: a window's expiry is judged
      // against the clock at this call (F24), and `alive` must reach the read.
      // Only a window OF THIS PROJECT (§2, F12): another folder's `pair` admits
      // nobody here.
      hasLivePairing(this.store, {
        ...this.clock,
        now: this.now(),
        project: this.project.key,
      }) !== undefined
    );
  }

  /**
   * One poll tick: re-read the store, then close what may no longer live. A
   * connection whose device is gone (a revoke) and — this falls out of the
   * same rule — every device connection after `devices reset`, whose registry
   * is empty. `closed=<n>` is what the operator's line reports.
   */
  private poll(): void {
    if (this.stopped) {
      return;
    }
    const previousIdentity = this.snapshot.identityId;
    this.refreshIfChanged();
    const { devices, adoptable, broken, identityId } = this.snapshot;
    // `devices reset`: the computer's key changed, so every phone's pinned key
    // is now wrong and every live connection is worthless — all of them go
    // (F11), whatever the registry still lists (this does not depend on the
    // CLI emptying it first).
    const reset = identityId !== previousIdentity;
    let closed = 0;
    for (const [id, set] of [...this.live]) {
      // A broken store keeps today's connections (F14 says deny, not kill):
      // the sockets already authenticated, and dropping them would end turns
      // over a file the human is about to fix.
      // `adoptable`: a legacy socket mid-adoption (its record is being written).
      // Once ANOTHER project adopts it, it is in neither set and closes here (F11).
      if (!reset && (broken || devices.has(id) || adoptable.has(id))) {
        continue;
      }
      const entries = [...set];
      this.live.delete(id);
      closed += entries.length;
      // The line goes out BEFORE the sockets are closed: `close()` runs the
      // ws-server's teardown synchronously enough to unregister this very
      // entry, and an audit line must not depend on that ordering.
      this.onAudit?.(
        reset
          ? `device-reset ${id.slice(0, 8)} closed=${entries.length}`
          : `device-revoked ${id.slice(0, 8)} closed=${entries.length}`,
      );
      for (const connection of entries) {
        connection.close();
      }
    }
    if (closed === 0) {
      return;
    }
  }
}
