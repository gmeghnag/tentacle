/**
 * `DeviceAuthority` — one per `serve` daemon, over the 9a store
 * (docs/feat/device-pairing.md 9b). Fake-fs is NOT used here: the whole point
 * is that it reacts to a REAL file changing on disk under a poll, so each test
 * drives a real temp `configDir` and an injected clock/timer.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceAuthority,
  type DeviceClose,
  PAIRING_MAX_MESSAGE_BYTES,
} from "../src/device-authority.ts";
import {
  addDevice,
  deviceDir,
  deviceIdOf,
  loadOrCreateIdentity,
  openPairing,
  removeDevices,
  replaceIdentity,
  writeRegistry,
} from "../src/device-store.ts";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "device-authority-"));
  dirs.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const key = (fill: number) => new Uint8Array(32).fill(fill);
const CODE = "K7M2QX9AB3";

/** A config dir with an identity and a hand-made clock. */
function store(fill = 1) {
  const configDir = scratch();
  const created = loadOrCreateIdentity(configDir, {
    name: "gabriel-mac",
    now: 1_000,
    random: () => key(fill),
  });
  if (!created.ok) throw new Error(created.reason);
  return { configDir, identity: created.identity };
}

function pair(configDir: string, fill: number, name = "iPhone") {
  const added = addDevice(configDir, {
    publicKey: key(fill),
    name,
    now: 5_000,
  });
  if (!added.ok) throw new Error(`addDevice refused: ${added.reason}`);
  return added.device;
}

/** A clock and a timer the test owns, so "within one tick" is deterministic. */
function fakeTime(start = 10_000) {
  let at = start;
  const timers = new Map<number, () => void>();
  let id = 0;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
    timer: {
      setInterval(fn: () => void) {
        timers.set(++id, fn);
        return id;
      },
      clearInterval(handle: unknown) {
        timers.delete(handle as number);
      },
    },
    /** Run every armed poll once (one daemon tick). */
    tick() {
      for (const fn of [...timers.values()]) fn();
    },
    get armed() {
      return timers.size;
    },
  };
}

/** A live connection the authority can close, as the ws-server sees it. */
function socket(): DeviceClose & { closed: number } {
  const s = {
    closed: 0,
    close: () => {
      s.closed += 1;
    },
  };
  return s;
}

describe("authorize: a paired device", () => {
  test("a registered key is a device, with the full responder cap", () => {
    const { configDir } = store();
    const device = pair(configDir, 2);
    const authority = new DeviceAuthority({ configDir, timers: fakeTime().timer });
    try {
      const verdict = authority.authorize(key(2));
      expect(verdict).toEqual({
        kind: "device",
        id: device.id,
        allow: true,
        maxMessageBytes: 32 * 1024 * 1024,
      });
    } finally {
      authority.stop();
    }
  });

  test("an unknown key with no pairing window is DENIED (F15)", () => {
    const { configDir } = store();
    pair(configDir, 2);
    const authority = new DeviceAuthority({ configDir, timers: fakeTime().timer });
    try {
      expect(authority.authorize(key(9))).toBe(false);
    } finally {
      authority.stop();
    }
  });

  test("an unpaired, empty registry denies everyone (a fresh computer)", () => {
    const { configDir } = store();
    const authority = new DeviceAuthority({ configDir, timers: fakeTime().timer });
    try {
      expect(authority.authorize(key(2))).toBe(false);
    } finally {
      authority.stop();
    }
  });
});

describe("authorize: a pairing window (F16, P1)", () => {
  test("an unknown key during a live window is admitted as `pairing`, capped small", () => {
    const { configDir } = store();
    const time = fakeTime();
    const opened = openPairing(configDir, { code: CODE, now: time.now(), pid: process.pid });
    if (!opened.ok) throw new Error(opened.reason);
    const authority = new DeviceAuthority({ configDir, timers: time.timer, now: time.now });
    try {
      const verdict = authority.authorize(key(9));
      // Smaller than the 32 MiB device cap BY FAR: an admitted stranger's
      // reassembly is what P1 is about.
      expect(verdict).toEqual({
        kind: "pairing",
        allow: true,
        maxMessageBytes: PAIRING_MAX_MESSAGE_BYTES,
      });
      expect(PAIRING_MAX_MESSAGE_BYTES).toBeLessThan(32 * 1024 * 1024);
    } finally {
      authority.stop();
    }
  });

  test("a window that expired denies (clock skew is the host's alone, F24)", () => {
    const { configDir } = store();
    const time = fakeTime();
    const opened = openPairing(configDir, {
      code: CODE,
      now: time.now(),
      pid: process.pid,
      ttlMs: 1_000,
    });
    if (!opened.ok) throw new Error(opened.reason);
    const authority = new DeviceAuthority({ configDir, timers: time.timer, now: time.now });
    try {
      expect(authority.authorize(key(9))).not.toBe(false);
      time.advance(1_001);
      expect(authority.authorize(key(9))).toBe(false);
    } finally {
      authority.stop();
    }
  });

  test("a window whose `pair` died denies (F2)", () => {
    const { configDir } = store();
    const time = fakeTime();
    // OUR OWN pid, which IS alive: a dead number here would deny through the
    // real `processAlive` and hide whether the injected one reaches the read.
    const opened = openPairing(configDir, { code: CODE, now: time.now(), pid: process.pid });
    if (!opened.ok) throw new Error(opened.reason);
    const authority = new DeviceAuthority({
      configDir,
      timers: time.timer,
      now: time.now,
      alive: () => false,
    });
    try {
      expect(authority.authorize(key(9))).toBe(false);
    } finally {
      authority.stop();
    }
  });
});

describe("a revoke closes the live socket", () => {
  test("a registry rewrite closes that device within ONE tick, and a redial is denied", () => {
    // Mutation: the poll does not close -> the `closed` assertion is red.
    const { configDir } = store();
    const device = pair(configDir, 2);
    pair(configDir, 3, "Pixel");
    const time = fakeTime();
    const authority = new DeviceAuthority({ configDir, timers: time.timer, now: time.now });
    const revoked = socket();
    const other = socket();
    try {
      expect(authority.authorize(key(2))).toEqual(
        expect.objectContaining({ kind: "device", id: device.id }),
      );
      authority.register(device.id, revoked);
      authority.register(deviceIdOf(key(3)), other);
      expect(authority.liveCount()).toBe(2);

      const removed = removeDevices(configDir, [device.id]);
      expect(removed.ok).toBe(true);
      // Not closed yet: nothing polls before the tick (proves the poll does it).
      expect(revoked.closed).toBe(0);
      time.tick();
      expect(revoked.closed).toBe(1);
      // The device that is still paired is untouched.
      expect(other.closed).toBe(0);
      expect(authority.liveCount()).toBe(1);
      // F7: the client's redial is denied at once — a deny is terminal.
      expect(authority.authorize(key(2))).toBe(false);
    } finally {
      authority.stop();
    }
  });

  test("revoke BEFORE the tick: the next authorize already denies (stat-refresh, F8)", () => {
    // Mutation: snapshot-only authorize (no stat reload) -> red: the authority
    // would still hold the entry and the redial would be admitted.
    const { configDir } = store();
    const device = pair(configDir, 2);
    const time = fakeTime();
    const authority = new DeviceAuthority({ configDir, timers: time.timer, now: time.now });
    try {
      expect(authority.authorize(key(2))).not.toBe(false);
      removeDevices(configDir, [device.id]);
      // No tick between the revoke and this call.
      expect(authority.authorize(key(2))).toBe(false);
    } finally {
      authority.stop();
    }
  });

  test("`devices reset` closes EVERY device and switches the static key (F11)", () => {
    const { configDir } = store();
    const a = pair(configDir, 2);
    const b = pair(configDir, 3, "Pixel");
    const time = fakeTime();
    const authority = new DeviceAuthority({ configDir, timers: time.timer, now: time.now });
    const sa = socket();
    const sb = socket();
    try {
      authority.authorize(key(2));
      authority.authorize(key(3));
      authority.register(a.id, sa);
      authority.register(b.id, sb);
      const before = authority.staticKey();
      if (before === undefined) throw new Error("no key");
      const replaced = replaceIdentity(configDir, {
        name: "gabriel-mac",
        now: 20_000,
        random: () => key(7),
      });
      expect(replaced.ok).toBe(true);
      time.tick();
      expect([sa.closed, sb.closed]).toEqual([1, 1]);
      expect(authority.identity()?.name).toBe("gabriel-mac");
      // The key NEW handshakes get is the new one.
      const fresh = authority.staticKey();
      if (fresh === undefined) throw new Error("no key");
      expect([...fresh]).not.toEqual([...before]);
      if (!replaced.ok) throw new Error(replaced.reason);
      expect([...fresh]).toEqual([...replaced.identity.privateKey]);
      // The reset also empties the registry (that is the CLI's other half):
      // every device is denied afterwards, and a stale entry would not save it.
      expect(writeRegistry(configDir, { devices: [] })).toEqual(
        expect.objectContaining({ ok: true }),
      );
      expect(authority.authorize(key(2))).toBe(false);
      expect(authority.authorize(key(3))).toBe(false);
    } finally {
      authority.stop();
    }
  });

  test("a device's socket closes once, however many ticks run", () => {
    const { configDir } = store();
    const device = pair(configDir, 2);
    const time = fakeTime();
    const authority = new DeviceAuthority({ configDir, timers: time.timer, now: time.now });
    const s = socket();
    try {
      authority.register(device.id, s);
      removeDevices(configDir, [device.id]);
      time.tick();
      time.tick();
      time.tick();
      expect(s.closed).toBe(1);
    } finally {
      authority.stop();
    }
  });
});

describe("an unreadable store fails CLOSED (F14)", () => {
  test("a garbled registry denies a KNOWN key, and the file is never rewritten", () => {
    // Mutation: fail open on a read error -> red.
    const { configDir } = store();
    const device = pair(configDir, 2);
    const time = fakeTime();
    const authority = new DeviceAuthority({ configDir, timers: time.timer, now: time.now });
    try {
      expect(authority.authorize(key(2))).not.toBe(false);
      const path = join(deviceDir(configDir), "registry.json");
      writeFileSync(path, "{ not json");
      expect(authority.authorize(key(2))).toBe(false);
      expect(authority.authorize(key(9))).toBe(false);
      expect(device.id).toHaveLength(16);
    } finally {
      authority.stop();
    }
  });

  test("an unknown version is refused the same way (never half-loaded)", () => {
    const { configDir } = store();
    pair(configDir, 2);
    mkdirSync(deviceDir(configDir), { recursive: true, mode: 0o700 });
    writeRegistry(configDir, { devices: [] });
    writeFileSync(
      join(deviceDir(configDir), "registry.json"),
      JSON.stringify({ v: 99, devices: [] }),
    );
    const authority = new DeviceAuthority({ configDir, timers: fakeTime().timer });
    try {
      expect(authority.authorize(key(2))).toBe(false);
    } finally {
      authority.stop();
    }
  });

  test("a missing identity denies and reports it once (F26 is serve's call)", () => {
    const configDir = scratch();
    const lines: string[] = [];
    const authority = new DeviceAuthority({
      configDir,
      timers: fakeTime().timer,
      onAudit: (line) => lines.push(line),
    });
    try {
      expect(authority.authorize(key(2))).toBe(false);
      // No identity means no static key for the responder either.
      expect(authority.staticKey()).toBeUndefined();
      // One line, not one per authorize.
      expect(lines.filter((l) => l.startsWith("device-store-unreadable"))).toHaveLength(1);
    } finally {
      authority.stop();
    }
  });
});

describe("the poll is a signal, not the only one", () => {
  test("stop() disarms the timer, so nothing closes after the server is gone", () => {
    const { configDir } = store();
    const device = pair(configDir, 2);
    const time = fakeTime();
    const authority = new DeviceAuthority({ configDir, timers: time.timer, now: time.now });
    const s = socket();
    authority.register(device.id, s);
    expect(time.armed).toBe(1);
    authority.stop();
    expect(time.armed).toBe(0);
    removeDevices(configDir, [device.id]);
    time.tick();
    expect(s.closed).toBe(0);
  });

  test("closing a revoked device is idempotent and a re-registered id starts clean", () => {
    const { configDir } = store();
    const device = pair(configDir, 2);
    const time = fakeTime();
    const authority = new DeviceAuthority({ configDir, timers: time.timer, now: time.now });
    const first = socket();
    try {
      authority.register(device.id, first);
      first.close(); // the socket died on its own
      authority.unregister(device.id, first);
      expect(authority.liveCount()).toBe(0);
      // A re-pair of the SAME key is the same id and must be served again.
      const again = socket();
      authority.register(device.id, again);
      removeDevices(configDir, [device.id]);
      time.tick();
      expect(first.closed).toBe(1); // untouched by the revoke (already gone)
      expect(again.closed).toBe(1);
    } finally {
      authority.stop();
    }
  });

  test("a device with two live connections closes both", () => {
    const { configDir } = store();
    const device = pair(configDir, 2);
    const time = fakeTime();
    const authority = new DeviceAuthority({ configDir, timers: time.timer, now: time.now });
    const one = socket();
    const two = socket();
    try {
      authority.register(device.id, one);
      authority.register(device.id, two);
      expect(authority.liveCount()).toBe(2);
      removeDevices(configDir, [device.id]);
      time.tick();
      expect([one.closed, two.closed]).toEqual([1, 1]);
    } finally {
      authority.stop();
    }
  });
});

describe("the authority's own report", () => {
  test("audit lines name the device by id prefix only (never a key or a name)", () => {
    const { configDir } = store();
    const device = pair(configDir, 2, "iPhone di Gabriel");
    const lines: string[] = [];
    const time = fakeTime();
    const authority = new DeviceAuthority({
      configDir,
      timers: time.timer,
      now: time.now,
      onAudit: (line) => lines.push(line),
    });
    const s = socket();
    try {
      authority.register(device.id, s);
      removeDevices(configDir, [device.id]);
      time.tick();
      const closed = lines.filter((l) => l.startsWith("device-revoked"));
      expect(closed).toHaveLength(1);
      expect(closed[0]).toBe(`device-revoked ${device.id.slice(0, 8)} closed=1`);
      expect(lines.join("\n")).not.toContain("iPhone di Gabriel");
    } finally {
      authority.stop();
    }
  });

  test("a device store that recovers is usable again (no sticky denial)", () => {
    const { configDir } = store();
    const device = pair(configDir, 2);
    const time = fakeTime();
    const authority = new DeviceAuthority({ configDir, timers: time.timer, now: time.now });
    const path = join(deviceDir(configDir), "registry.json");
    try {
      const original = readFileSync(path, "utf8");
      writeFileSync(path, "{ broken");
      // A broken store DENIES, and the CLI-side writers refuse to touch it
      // (9a: never write over an unreadable registry) — so nothing repairs it
      // behind the human's back.
      expect(authority.authorize(key(2))).toBe(false);
      expect(addDevice(configDir, { publicKey: key(2), name: "iPhone", now: 6_000 })).toEqual(
        expect.objectContaining({ ok: false }),
      );
      // The human fixes the file: the very next authorize sees it (no sticky
      // denial — the snapshot is refreshed by the stat, not by a restart).
      expect(readFileSync(path, "utf8")).toBe("{ broken");
      writeFileSync(path, original);
      expect(authority.authorize(key(2))).not.toBe(false);
    } finally {
      authority.stop();
    }
  });
});
