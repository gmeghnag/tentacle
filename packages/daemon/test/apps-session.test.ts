/**
 * Session apps on a hosted session (docs/feat/session-apps-publish.md D8/D9):
 * the update, the snapshot, every end of a session, `/clear`, and the sidecar
 * (v5, only while there is an app) through a restart.
 */
import { describe, expect, test } from "bun:test";
import {
  DAEMON_STATE_VERSIONS,
  DAEMON_STATE_VERSION_APPS,
  parseSidecar,
} from "../src/daemon-state-file.ts";
import { appsRig } from "./support/apps-host.ts";
import { appId, refused, settle } from "./support/apps.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

const sidecar = (store: SpyDaemonStore, id = "S") =>
  JSON.parse(store.files.get(id)?.state ?? "{}") as {
    schemaVersion: number;
    apps?: { app: string }[];
  };

describe("publishing on a hosted session", () => {
  test("a publish emits the full list, persists, and the snapshot carries it", async () => {
    const store = new SpyDaemonStore();
    const r = appsRig({ store });
    const client = await r.connect();
    await client.open();
    await client.prompt("t1");
    await settle();
    expect((await client.snapshot()).apps).toEqual([]);
    const row = await r.publish();
    expect(client.apps().at(-1)?.apps).toEqual([row]);
    expect((await client.snapshot()).apps).toEqual([row]);
    await r.persister?.flush("S");
    expect(sidecar(store).apps?.map((a) => a.app)).toEqual([row.app]);
    await r.persister?.stop();
  });

  test("a host that publishes nothing hands no link and reports no list", async () => {
    const r = appsRig({ apps: false });
    const client = await r.connect();
    await client.open();
    expect(r.contexts[0]?.apps).toBeUndefined();
    expect((await client.snapshot()).apps).toBeUndefined();
  });

  test("a lease that lapses while idle reaches the client and the next snapshot", async () => {
    const r = appsRig();
    const client = await r.connect();
    await client.open();
    await r.publish();
    r.api.onRenew = () => refused("taken_down", "phishing");
    await r.clock.advance(60_000);
    expect(client.apps().at(-1)?.apps[0]?.state).toBe("removed");
    expect((await client.snapshot()).apps?.[0]?.reason).toContain("phishing");
  });
});

describe("every end of a session takes its apps down", () => {
  for (const [name, end] of [
    ["close", (r: ReturnType<typeof appsRig>) => r.host.close("S")],
    ["archive (the reaper's end)", (r: ReturnType<typeof appsRig>) => r.host.archive("S")],
    ["delete", (r: ReturnType<typeof appsRig>) => r.host.delete("S")],
  ] as const) {
    test(`${name}: one DELETE, the link gone, no timer left`, async () => {
      const store = new SpyDaemonStore();
      const r = appsRig({ store });
      const client = await r.connect();
      await client.open();
      await client.prompt("t1");
      await settle();
      const row = await r.publish();
      end(r);
      await settle();
      await r.persister?.flush("S");
      expect(r.api.calls).toEqual(["create", `remove ${row.app}`]);
      expect(r.contexts[0]?.apps?.()).toBeNull();
      await r.clock.advance(600_000);
      expect(r.api.calls).toHaveLength(2);
      // The archived record has none (v1 again); a deleted one has no file.
      if (name !== "delete") {
        expect(sidecar(store).apps).toBeUndefined();
        expect(sidecar(store).schemaVersion).toBe(1);
      }
      await r.persister?.stop();
    });
  }

  test("the detached cap's eviction too", async () => {
    const store = new SpyDaemonStore();
    const r = appsRig({ store, maxDetachedSessions: 1 });
    const a = await r.connect();
    await a.open();
    await a.prompt("t1");
    await settle();
    const row = await r.publish();
    await a.request("session/detach");
    const b = await r.connect("T");
    await b.open();
    await settle();
    expect(r.host.get("S")).toBeUndefined();
    expect(r.api.calls).toContain(`remove ${row.app}`);
    await r.persister?.stop();
  });

  test("/clear: the source keeps its apps, the fork has none", async () => {
    const store = new SpyDaemonStore();
    const r = appsRig({ store });
    const client = await r.connect();
    await client.open();
    await client.prompt("t1");
    await settle();
    const row = await r.publish();
    await client.request("session/clear");
    await settle();
    await r.persister?.flush("S");
    expect((await client.snapshot()).apps?.map((a) => a.app)).toEqual([row.app]);
    expect(sidecar(store).apps).toHaveLength(1);
    const forks = [...store.files.keys()].filter((id) => id !== "S");
    expect(forks).toHaveLength(1);
    expect(sidecar(store, forks[0]).apps).toBeUndefined();
    expect(r.api.calls).toEqual(["create"]);
    await r.persister?.stop();
  });
});

describe("the sidecar (v5)", () => {
  async function saved() {
    const store = new SpyDaemonStore();
    const r = appsRig({ store });
    const client = await r.connect();
    await client.open();
    await client.prompt("t1");
    await settle();
    await r.persister?.flush("S");
    const before = sidecar(store).schemaVersion;
    const row = await r.publish();
    await r.persister?.flush("S");
    return { store, r, row, before, state: store.files.get("S")?.state ?? "" };
  }

  test("`apps` is written only while non-empty, and the file is then v5", async () => {
    const { store, r, row, before } = await saved();
    expect(before).toBe(1);
    expect(sidecar(store).schemaVersion).toBe(DAEMON_STATE_VERSION_APPS);
    expect(DAEMON_STATE_VERSION_APPS).toBe(5);
    expect(DAEMON_STATE_VERSIONS).toContain(5);
    await r.link().unpublish(row.app);
    await r.persister?.flush("S");
    expect(sidecar(store).schemaVersion).toBe(1);
    expect(sidecar(store).apps).toBeUndefined();
    await r.persister?.stop();
  });

  test("an older version carrying `apps`, or a malformed `apps`, refuses the file", async () => {
    const { r, state } = await saved();
    expect(parseSidecar(state, "S").ok).toBe(true);
    const raw = JSON.parse(state) as Record<string, unknown>;
    for (const version of [1, 2, 3, 4]) {
      const parsed = parseSidecar(JSON.stringify({ ...raw, schemaVersion: version }), "S");
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toContain('carries "apps"');
    }
    const good = (raw.apps as Record<string, unknown>[])[0] ?? {};
    for (const apps of [
      {},
      [null],
      [{ ...good, app: "nope" }],
      [{ ...good, url: "https://evil.example/" }],
      [{ ...good, sha256: "x" }],
      [good, good],
    ]) {
      const parsed = parseSidecar(JSON.stringify({ ...raw, apps }), "S");
      expect(parsed).toEqual({ ok: false, reason: '"apps" is malformed' });
    }
    await r.persister?.stop();
  });

  test("a restart renews at once and keeps the same app; the daemon stop deleted nothing", async () => {
    const { store, r, row } = await saved();
    await r.persister?.stop();
    r.service.stop();
    expect(r.api.calls).toEqual(["create"]);
    const record = store.durable.get("S");
    if (!record) throw new Error("not saved");
    expect(record.apps?.map((a) => a.app)).toEqual([row.app]);
    const next = appsRig({ store, clock: r.clock });
    next.host.restore(record);
    const client = await next.connect();
    await client.open({});
    await next.clock.advance(0);
    expect(next.api.calls).toEqual([`renew ${row.app}`]);
    expect((await client.snapshot()).apps?.[0]).toMatchObject({ app: row.app, state: "up" });
    await next.persister?.stop();
  });

  test("longer than a lease away: the page is gone with the memory, «publish again»", async () => {
    const { store, r } = await saved();
    await r.persister?.stop();
    r.service.stop();
    const record = store.durable.get("S");
    if (!record) throw new Error("not saved");
    const next = appsRig({ store, clock: r.clock });
    next.api.onRenew = () => refused("expired");
    next.host.restore(record);
    await next.clock.advance(0);
    const hosted = next.host.get("S");
    expect(hosted?.appsLink()?.list()[0]).toMatchObject({ app: appId(0), state: "down" });
    expect(next.api.calls).toEqual([`renew ${appId(0)}`]);
    await next.persister?.stop();
  });
});
