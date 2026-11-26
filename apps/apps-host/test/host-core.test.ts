import { describe, expect, test } from "bun:test";
import { FREE, recordOf, setup, sha } from "./support/core.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("lease life cycle", () => {
  test("create → live with a lease; renew extends it", () => {
    const { core, clock, create, advance, limits } = setup();
    const id = create();
    expect(core.view(id)).toEqual({ kind: "app", id, sha256: sha(1), bytes: 100 });
    expect(core.leaseOf(id)).toBe(clock.at + limits.leaseMs);
    advance(4 * MIN);
    expect(core.renew({ key: "k1", id })).toEqual({
      ok: true,
      lease: {
        id,
        leaseExpiresAt: clock.at + limits.leaseMs,
        leaseMs: limits.leaseMs,
        renewAfterMs: limits.renewAfterMs,
      },
    });
    advance(4 * MIN);
    expect(core.view(id).kind).toBe("app");
  });

  test("10 000 renewals across a year stay live: there is no maximum", () => {
    // 10 000 steps of 53 minutes ≈ 368 days, inside an hour-long lease.
    const { core, advance, create, clock } = setup({ leaseMs: HOUR });
    const id = create();
    const createdAt = clock.at;
    for (let i = 0; i < 10_000; i++) {
      advance(53 * MIN);
      core.sweep();
      expect(core.renew({ key: "k1", id }).ok).toBe(true);
    }
    expect(clock.at - createdAt).toBeGreaterThan(365 * DAY);
    expect(core.view(id).kind).toBe("app");
  });

  test("a lapsed lease is offline before the sweep, then expired and removed", () => {
    const { core, advance, create, limits, clock } = setup();
    const id = create();
    advance(limits.leaseMs);
    expect(core.view(id).kind).toBe("app");
    advance(1);
    expect(core.view(id)).toEqual({ kind: "offline" });
    expect(core.renew({ key: "k1", id })).toMatchObject({ ok: false, error: "expired" });
    const swept = core.sweep();
    expect(swept.expired).toEqual([id]);
    const record = recordOf(core, id);
    expect(record.state).toBe("expired");
    expect(record.tombstoneUntil).toBe(clock.at + limits.tombstoneMs);
    expect(swept.effects).toEqual([
      { type: "removeContent", id, sha256: sha(1) },
      { type: "writeRecord", id, record },
    ]);
    expect(core.renew({ key: "k1", id })).toMatchObject({ ok: false, error: "expired" });
    expect(core.view(id)).toEqual({ kind: "offline" });
    expect(core.sweep().effects).toEqual([]);
  });

  test("the owner's PUT revives the same id", () => {
    const { core, advance, create, update } = setup();
    const id = create();
    advance(HOUR);
    core.sweep();
    const reserved = update(id);
    if (!reserved.ok) {
      throw new Error(reserved.error);
    }
    expect(reserved.reservation.record.id).toBe(id);
    expect(core.commit(reserved.reservation)).toMatchObject({ ok: true, lease: { id } });
    expect(core.view(id)).toMatchObject({ kind: "app", sha256: sha(2) });
    expect(core.record(id)?.tombstoneUntil).toBeUndefined();
  });

  test("an update removes the previous content only when it differs", () => {
    const { core, create, update } = setup();
    const id = create();
    const next = update(id, { sha256: sha(2) });
    expect(next.ok && core.commit(next.reservation)).toMatchObject({
      ok: true,
      effects: [{ type: "removeContent", id, sha256: sha(1) }],
    });
    const same = update(id, { sha256: sha(2) });
    expect(same.ok && core.commit(same.reservation)).toMatchObject({ ok: true, effects: [] });
  });

  test("another key may not update, renew or delete; an unknown id is not found", () => {
    const { core, create, update } = setup();
    const id = create();
    const forbidden = { ok: false, error: "forbidden" };
    expect(update(id, { key: "k2" })).toMatchObject(forbidden);
    expect(core.renew({ key: "k2", id })).toMatchObject(forbidden);
    expect(core.delete({ key: "k2", id })).toMatchObject(forbidden);
    const missing = { ok: false, error: "not_found" };
    expect(update("aaaaaaaaaaaaaaaa")).toMatchObject(missing);
    expect(core.renew({ key: "k1", id: "aaaaaaaaaaaaaaaa" })).toMatchObject(missing);
    expect(core.delete({ key: "k1", id: "aaaaaaaaaaaaaaaa" })).toMatchObject(missing);
  });

  test("delete → tombstone, 410 view, idempotent; no update or renew after it", () => {
    const { core, create, update } = setup();
    const id = create();
    const deleted = core.delete({ key: "k1", id });
    expect(deleted).toMatchObject({ ok: true });
    expect(deleted.ok && deleted.effects.map((e) => e.type)).toEqual([
      "removeContent",
      "writeRecord",
    ]);
    expect(core.view(id)).toEqual({ kind: "deleted" });
    expect(core.delete({ key: "k1", id }).ok).toBe(true);
    expect(core.renew({ key: "k1", id })).toMatchObject({ error: "deleted" });
    expect(update(id)).toMatchObject({ error: "deleted" });
  });

  test("an expired tombstone is removed and the id becomes unknown", () => {
    const { core, advance, create, limits } = setup();
    const id = create();
    core.delete({ key: "k1", id });
    advance(limits.tombstoneMs);
    expect(core.sweep().forgotten).toEqual([]);
    advance(1);
    const swept = core.sweep();
    expect(swept.forgotten).toEqual([id]);
    expect(swept.effects).toContainEqual({ type: "removeRecord", id });
    expect(core.view(id)).toEqual({ kind: "unknown" });
    expect(core.view("not-an-id")).toEqual({ kind: "unknown" });
  });
});

describe("reservations", () => {
  test("a reservation counts against the caps until it is released", () => {
    const { core, reserve, create } = setup({ maxLiveAppsPerKey: 1 });
    const first = reserve();
    if (!first.ok) {
      throw new Error(first.error);
    }
    const id = first.reservation.record.id;
    expect(core.view(id)).toEqual({ kind: "unknown" });
    expect(reserve()).toMatchObject({ ok: false, error: "cap_reached" });
    expect(core.release(first.reservation)).toEqual([
      { type: "removeContent", id, sha256: sha(1) },
      { type: "removeRecord", id },
    ]);
    expect(core.view(id)).toEqual({ kind: "unknown" });
    expect(() => create()).not.toThrow();
  });

  test("one write per id: a second update or a delete is a conflict", () => {
    const { core, create, update } = setup();
    const id = create();
    const first = update(id);
    expect(first.ok).toBe(true);
    expect(update(id)).toMatchObject({ ok: false, error: "conflict" });
    expect(core.delete({ key: "k1", id })).toMatchObject({ ok: false, error: "conflict" });
    expect(core.renew({ key: "k1", id }).ok).toBe(true);
    if (first.ok) {
      core.release(first.reservation);
    }
    expect(update(id).ok).toBe(true);
  });

  test("a released update keeps the old version and removes only the new content", () => {
    const { core, create, update } = setup();
    const id = create();
    const next = update(id, { sha256: sha(2) });
    expect(next.ok && core.release(next.reservation)).toEqual([
      { type: "removeContent", id, sha256: sha(2) },
    ]);
    expect(core.view(id)).toMatchObject({ kind: "app", sha256: sha(1) });
    const same = update(id, { sha256: sha(1) });
    // The same bytes: the live content must survive the release.
    expect(same.ok && core.release(same.reservation)).toEqual([]);
  });

  test("the sweep leaves an app with a write in flight alone", () => {
    const { core, advance, create, update } = setup();
    const id = create();
    const next = update(id);
    advance(HOUR);
    expect(core.sweep().effects).toEqual([]);
    expect(next.ok && core.commit(next.reservation).ok).toBe(true);
    expect(core.view(id).kind).toBe("app");
  });
});

describe("caps", () => {
  test("app size: at the limit, one past it", () => {
    const { reserve } = setup({ maxAppBytes: 100 });
    expect(reserve({ bytes: 100 }).ok).toBe(true);
    expect(reserve({ bytes: 101 })).toMatchObject({ ok: false, error: "too_large" });
  });

  test("live apps per key; an expired or deleted app frees its slot", () => {
    const { core, create, reserve, advance } = setup({ maxLiveAppsPerKey: 2 });
    const a = create();
    create();
    expect(reserve()).toMatchObject({ ok: false, error: "cap_reached" });
    expect(reserve({ key: "k2" }).ok).toBe(true);
    core.delete({ key: "k1", id: a });
    create();
    advance(HOUR);
    core.sweep();
    expect(reserve().ok).toBe(true);
  });

  test("live apps overall", () => {
    const { create, reserve } = setup({ maxLiveApps: 2 });
    create({ key: "a" });
    create({ key: "b" });
    expect(reserve({ key: "c" })).toMatchObject({ ok: false, error: "cap_reached" });
  });

  test("a revive re-checks the live caps", () => {
    const { core, advance, create, update } = setup({ maxLiveAppsPerKey: 1 });
    const old = create();
    advance(HOUR);
    core.sweep();
    create();
    expect(update(old)).toMatchObject({ ok: false, error: "cap_reached" });
  });

  test("store bytes: at the budget, one past it; an update counts the difference", () => {
    const { reserve, create, update } = setup({ maxStoreBytes: 300 });
    const id = create({ bytes: 200 });
    expect(reserve({ bytes: 101 })).toMatchObject({ ok: false, error: "storage_full" });
    expect(update(id, { bytes: 301 })).toMatchObject({ ok: false, error: "storage_full" });
    const grow = update(id, { bytes: 300 });
    expect(grow.ok).toBe(true);
    // The growth is reserved: nothing else fits meanwhile.
    expect(reserve({ bytes: 1 })).toMatchObject({ ok: false, error: "storage_full" });
  });

  test("a reservation's bytes count", () => {
    const { reserve } = setup({ maxStoreBytes: 150 });
    expect(reserve({ bytes: 100 }).ok).toBe(true);
    expect(reserve({ bytes: 51 })).toMatchObject({ ok: false, error: "storage_full" });
    expect(reserve({ bytes: 50 }).ok).toBe(true);
  });

  test("free disk space below the floor refuses", () => {
    const { reserve, create, update } = setup({ minFreeDiskBytes: 1000 });
    expect(reserve({ freeBytes: 999 })).toMatchObject({ ok: false, error: "storage_full" });
    const id = create({ freeBytes: 1000 });
    expect(update(id, { freeBytes: 999 })).toMatchObject({ error: "storage_full" });
    expect(reserve({ freeBytes: FREE }).ok).toBe(true);
  });

  test("publishes per hour per key (creates and updates)", () => {
    const { create, reserve, update, advance } = setup({
      publishesPerHourPerKey: 2,
      leaseMs: 100 * HOUR,
    });
    const id = create();
    expect(update(id).ok).toBe(true);
    expect(reserve()).toMatchObject({ ok: false, error: "rate_limited", retryAfterMs: HOUR });
    expect(reserve({ key: "k2" }).ok).toBe(true);
    advance(HOUR);
    expect(reserve().ok).toBe(true);
  });

  test("creates per hour per address", () => {
    const { reserve, advance } = setup({ createsPerHourPerIp: 2 });
    expect(reserve({ key: "a" }).ok).toBe(true);
    expect(reserve({ key: "b" }).ok).toBe(true);
    expect(reserve({ key: "c" })).toMatchObject({ ok: false, error: "rate_limited" });
    expect(reserve({ key: "c", ip: "2.2.2.2" }).ok).toBe(true);
    advance(HOUR);
    expect(reserve({ key: "c" }).ok).toBe(true);
  });

  test("distinct keys creating from one address per day", () => {
    const { reserve, advance } = setup({ newKeysPerDayPerIp: 2 });
    expect(reserve({ key: "a" }).ok).toBe(true);
    expect(reserve({ key: "b" }).ok).toBe(true);
    expect(reserve({ key: "c" })).toMatchObject({ ok: false, error: "rate_limited" });
    expect(reserve({ key: "a" }).ok).toBe(true);
    advance(DAY);
    expect(reserve({ key: "c" }).ok).toBe(true);
  });

  test("signed requests per minute per key and API requests per minute per address", () => {
    const { core, advance } = setup({ signedPerMinutePerKey: 2, apiPerMinutePerIp: 3 });
    expect(core.admitSigned("a").ok).toBe(true);
    expect(core.admitSigned("a").ok).toBe(true);
    expect(core.admitSigned("a")).toMatchObject({ error: "rate_limited", retryAfterMs: MIN });
    expect(core.admitSigned("b").ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(core.admitApi("ip").ok).toBe(true);
    }
    expect(core.admitApi("ip")).toMatchObject({ error: "rate_limited" });
    advance(MIN);
    expect(core.admitApi("ip").ok).toBe(true);
    expect(core.admitSigned("a").ok).toBe(true);
  });

  test("a full tracking map refuses the newcomer and forgets nobody", () => {
    const { core, advance } = setup({
      maxTrackedIps: 2,
      maxTrackedKeys: 1,
      apiPerMinutePerIp: 1,
    });
    expect(core.admitApi("a").ok).toBe(true);
    expect(core.admitApi("b").ok).toBe(true);
    expect(core.admitApi("c")).toMatchObject({ ok: false, error: "busy" });
    expect(core.admitApi("a")).toMatchObject({ error: "rate_limited" });
    expect(core.admitSigned("k").ok).toBe(true);
    expect(core.admitSigned("l")).toMatchObject({ error: "busy" });
    advance(MIN);
    expect(core.admitApi("c").ok).toBe(true);
    expect(core.admitSigned("l").ok).toBe(true);
  });

  test("reports: per address per hour, overall per day, and a known app only", () => {
    const { core, create, advance } = setup({ reportsPerHourPerIp: 2, reportsPerDay: 3 });
    const id = create();
    expect(core.admitReport("a", "aaaaaaaaaaaaaaaa")).toMatchObject({ error: "not_found" });
    expect(core.admitReport("a", id).ok).toBe(true);
    expect(core.admitReport("a", id)).toMatchObject({ error: "rate_limited" });
    expect(core.admitReport("b", id).ok).toBe(true);
    expect(core.admitReport("b", id).ok).toBe(true);
    expect(core.admitReport("c", id)).toMatchObject({ error: "busy" });
    advance(DAY);
    expect(core.admitReport("c", id).ok).toBe(true);
    // A report never changes what visitors get.
    expect(core.record(id)?.state).toBe("live");
  });

  test("daily bytes per app: 503 past the limit, reset at the next UTC day", () => {
    const { core, create, advance } = setup({ appBytesPerDay: 250, leaseMs: 100 * DAY });
    const id = create();
    core.countServed(id, 100);
    expect(core.view(id).kind).toBe("app");
    core.countServed(id, 50);
    // 150 + 100 = 250: exactly the limit is still served.
    expect(core.view(id).kind).toBe("app");
    core.countServed(id, 1);
    expect(core.view(id)).toEqual({ kind: "over_limit" });
    advance(12 * HOUR - 1);
    expect(core.view(id)).toEqual({ kind: "over_limit" });
    advance(1);
    expect(core.view(id).kind).toBe("app");
  });
});

describe("app ids", () => {
  const scripted = (fills: number[]) => {
    let i = 0;
    return (n: number) => new Uint8Array(n).fill(fills[Math.min(i++, fills.length - 1)] ?? 0);
  };

  test("a mint that hits a known id (live, reserved or tombstoned) retries", () => {
    const { core, create, reserve } = setup({}, scripted([0, 0, 0xff, 0, 0xff, 1]));
    const first = create();
    expect(first).toBe("aaaaaaaaaaaaaaaa");
    core.delete({ key: "k1", id: first });
    const second = reserve();
    expect(second.ok && second.reservation.record.id).toBe("7777777777777777");
    const third = reserve();
    expect(third.ok && third.reservation.record.id).not.toBe("7777777777777777");
    expect(third.ok).toBe(true);
  });

  test("three retries, then internal", () => {
    const { create, reserve } = setup({}, scripted([0]));
    create();
    expect(reserve()).toMatchObject({ ok: false, error: "internal" });
  });

  test("a fourth draw that is new is taken", () => {
    const { create, reserve } = setup({}, scripted([0, 0, 0, 0, 0xff]));
    create();
    expect(reserve().ok).toBe(true);
  });
});

describe("kill switch", () => {
  test("publish refuses create and update; renew, delete and views are unaffected", () => {
    const { core, create, reserve, update, operator } = setup();
    const id = create();
    const other = create();
    operator.kill = "publish";
    expect(reserve()).toMatchObject({ ok: false, error: "killed" });
    expect(update(id)).toMatchObject({ ok: false, error: "killed" });
    expect(core.refusalIfKilled()).toMatchObject({ error: "killed" });
    expect(core.view(id).kind).toBe("app");
    expect(core.renew({ key: "k1", id }).ok).toBe(true);
    expect(core.delete({ key: "k1", id: other }).ok).toBe(true);
  });

  test("all serves maintenance for every app; leases still renew and it lifts", () => {
    const { core, create, reserve, operator, advance } = setup();
    const id = create();
    operator.kill = "all";
    expect(reserve()).toMatchObject({ error: "killed" });
    expect(core.view(id)).toEqual({ kind: "maintenance" });
    expect(core.view("nope")).toEqual({ kind: "maintenance" });
    advance(4 * MIN);
    expect(core.renew({ key: "k1", id }).ok).toBe(true);
    advance(4 * MIN);
    operator.kill = "off";
    expect(core.refusalIfKilled()).toBeUndefined();
    expect(core.view(id).kind).toBe("app");
  });
});

describe("takedowns", () => {
  test("an app line: 410 at once, removed by the sweep, reason on renew and update", () => {
    const { core, create, update, operator } = setup();
    const id = create();
    operator.apps.set(id, "phishing");
    expect(core.view(id)).toEqual({ kind: "taken_down", reason: "phishing" });
    const refusal = { ok: false, error: "taken_down", reason: "phishing" };
    expect(core.renew({ key: "k1", id })).toMatchObject(refusal);
    expect(update(id)).toMatchObject(refusal);
    const swept = core.sweep();
    expect(swept.takenDown).toEqual([{ id, reason: "phishing" }]);
    expect(swept.effects.map((e) => e.type)).toEqual(["removeContent", "writeRecord"]);
    expect(core.record(id)).toMatchObject({ state: "taken_down", reason: "phishing" });
    // Removing the line does not bring the app back.
    operator.apps.clear();
    expect(core.view(id)).toEqual({ kind: "taken_down", reason: "phishing" });
    expect(core.renew({ key: "k1", id })).toMatchObject(refusal);
    expect(core.delete({ key: "k1", id })).toMatchObject(refusal);
    expect(core.sweep().takenDown).toEqual([]);
  });

  test("a key line takes down all its apps, blocks it, and unblocks when removed", () => {
    const { core, create, operator, advance } = setup();
    const a = create();
    const b = create();
    const other = create({ key: "k2" });
    advance(HOUR);
    core.sweep();
    operator.keys.set("k1", "abuse");
    expect(core.admitSigned("k1")).toMatchObject({ ok: false, error: "blocked", reason: "abuse" });
    expect(core.view(a).kind).toBe("taken_down");
    expect(core.sweep().takenDown.map((t) => t.id)).toEqual([a, b]);
    expect(core.record(other)?.state).toBe("expired");
    operator.keys.clear();
    expect(core.admitSigned("k1").ok).toBe(true);
    expect(core.view(b).kind).toBe("taken_down");
    expect(() => create()).not.toThrow();
  });

  test("a takedown racing an in-flight update discards the write", () => {
    const { core, create, update, operator } = setup();
    const id = create();
    const next = update(id);
    operator.apps.set(id, "malware");
    expect(core.sweep().effects).toEqual([]);
    const done = next.ok ? core.commit(next.reservation) : undefined;
    expect(done).toMatchObject({ ok: false, error: "taken_down", reason: "malware" });
    expect(done?.effects).toEqual([
      { type: "removeContent", id, sha256: sha(1) },
      { type: "removeContent", id, sha256: sha(2) },
      { type: "writeRecord", id, record: recordOf(core, id) },
    ]);
    expect(core.record(id)?.state).toBe("taken_down");
  });

  test("a key blocked during an in-flight create publishes nothing", () => {
    const { core, reserve, operator } = setup();
    const reserved = reserve();
    operator.keys.set("k1", "abuse");
    const done = reserved.ok ? core.commit(reserved.reservation) : undefined;
    expect(done).toMatchObject({ ok: false, error: "blocked", reason: "abuse" });
    expect(done?.effects.map((e) => e.type)).toEqual(["removeContent", "removeRecord"]);
    const id = reserved.ok ? reserved.reservation.record.id : "";
    expect(core.view(id)).toEqual({ kind: "unknown" });
  });
});

describe("restart", () => {
  test("live at the snapshot → a fresh TTL; lapsed → expired; deleted stays deleted", () => {
    const first = setup();
    const lapsed = first.create({ sha256: sha(3) });
    first.advance(HOUR);
    const alive = first.create({ sha256: sha(4) });
    const deleted = first.create({ sha256: sha(5) });
    first.core.delete({ key: "k1", id: deleted });
    first.advance(4 * MIN);
    first.core.renew({ key: "k1", id: alive });
    const snapshot = first.core.snapshot();
    const records = [lapsed, alive, deleted].map((id) => recordOf(first.core, id));

    const next = setup();
    next.clock.at = first.clock.at + 10 * MIN;
    const result = next.core.restore({
      records,
      skipped: ["bbbbbbbbbbbbbbbb"],
      contents: [
        { id: lapsed, tag: sha(3).slice(0, 16) },
        { id: alive, tag: sha(4).slice(0, 16) },
        { id: alive, tag: sha(9).slice(0, 16) },
        { id: "cccccccccccccccc", tag: sha(8).slice(0, 16) },
        { id: "bbbbbbbbbbbbbbbb", tag: sha(7).slice(0, 16) },
      ],
      snapshot,
    });
    expect(next.core.leaseOf(alive)).toBe(next.clock.at + next.limits.leaseMs);
    expect(next.core.view(alive).kind).toBe("app");
    expect(next.core.record(lapsed)?.state).toBe("expired");
    expect(next.core.record(deleted)?.state).toBe("deleted");
    expect(result.expired).toEqual([lapsed]);
    // Orphans: a file no live record names. A skipped record's files are kept.
    expect(result.orphans).toEqual([
      { id: lapsed, tag: sha(3).slice(0, 16) },
      { id: alive, tag: sha(9).slice(0, 16) },
      { id: "cccccccccccccccc", tag: sha(8).slice(0, 16) },
    ]);
    expect(result.effects).toContainEqual({
      type: "removeContent",
      id: "cccccccccccccccc",
      sha256: sha(8).slice(0, 16),
    });
  });

  test("published after the last snapshot → a fresh TTL", () => {
    const first = setup();
    const snapshot = first.core.snapshot();
    first.advance(10_000);
    const id = first.create();
    const next = setup();
    next.clock.at = first.clock.at + 10 * MIN;
    next.core.restore({
      records: [recordOf(first.core, id)],
      skipped: [],
      contents: [{ id, tag: sha(1).slice(0, 16) }],
      snapshot,
    });
    expect(next.core.view(id).kind).toBe("app");
  });

  test("no snapshot: only a recently written app gets a TTL", () => {
    const first = setup();
    const old = first.create();
    first.advance(HOUR);
    const recent = first.create();
    const next = setup();
    next.clock.at = first.clock.at + MIN;
    next.core.restore({
      records: [old, recent].map((id) => recordOf(first.core, id)),
      skipped: [],
      contents: [old, recent].map((id) => ({ id, tag: sha(1).slice(0, 16) })),
    });
    expect(next.core.record(old)?.state).toBe("expired");
    expect(next.core.view(recent).kind).toBe("app");
  });

  test("a live record whose content is gone is expired; skipped ids are never minted", () => {
    const first = setup();
    const id = first.create();
    const next = setup({}, () => new Uint8Array(10));
    next.core.restore({
      records: [recordOf(first.core, id)],
      skipped: ["aaaaaaaaaaaaaaaa"],
      contents: [],
      snapshot: first.core.snapshot(),
    });
    expect(next.core.record(id)?.state).toBe("expired");
    expect(next.reserve()).toMatchObject({ ok: false, error: "internal" });
  });
});
