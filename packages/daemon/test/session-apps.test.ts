/**
 * One session's apps (docs/feat/session-apps-publish.md): the checks before the
 * ask, the upload of exactly what was approved, the lease, and every way an app
 * ends (F3, F4, F7, F8, F12–F14).
 */
import { describe, expect, test } from "bun:test";
import type { AppRefusal, PreparedPublish } from "@tentacle/core";
import type { AppRow, ArtifactMeta } from "@tentacle/protocol";
import { ArtifactBudget, ArtifactStore } from "../src/artifact-store.ts";
import { AppsService, type SessionApps } from "../src/session-apps.ts";
import { Clock, DOMAIN, FakeApi, appId, gate, leased, refused, settle } from "./support/apps.ts";

const PAGE = "<!doctype html><p>one</p>";
const bytes = (text: string) => new TextEncoder().encode(text);

function rig(over: { api?: FakeApi; clock?: Clock; maxBytes?: number } = {}) {
  const api = over.api ?? new FakeApi();
  const clock = over.clock ?? new Clock();
  const created: boolean[] = [];
  const logs: string[] = [];
  const service = new AppsService({
    configDir: "/nonexistent",
    domain: DOMAIN,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    jitter: () => 0.5,
    log: (line) => logs.push(line),
    api: async (create) => {
      created.push(create);
      return { ok: true, api };
    },
  });
  const budget = new ArtifactBudget(over.maxBytes);
  const store = new ArtifactStore(budget);
  const changes: (readonly AppRow[])[] = [];
  const apps = service.session("s1", { artifacts: store, onChange: (r) => changes.push(r) });
  const present = (text: string | Uint8Array, id = "page", mimeType = "text/html") =>
    store.present({
      id,
      bytes: typeof text === "string" ? bytes(text) : text,
      mimeType,
      kind: "html",
      title: "Demo",
      callId: "c1",
    });
  return { api, clock, service, store, apps, changes, present, created, logs };
}

async function prepared(apps: SessionApps, artifact = "page"): Promise<PreparedPublish> {
  const result = await apps.prepare({ artifact });
  if (!result.ok) throw new Error(result.reason);
  return result;
}

async function published(apps: SessionApps, artifact = "page"): Promise<AppRow> {
  const result = await apps.publish(await prepared(apps, artifact));
  if (!result.ok) throw new Error(result.reason);
  return result.row;
}

const reasonOf = (result: PreparedPublish | AppRefusal): string =>
  result.ok ? "(accepted)" : result.reason;

describe("prepare: refused before anything is asked", () => {
  test("unknown artifact, unknown version, not HTML, not UTF-8", async () => {
    const { apps, present, api } = rig();
    expect(reasonOf(await apps.prepare({ artifact: "nope" }))).toContain("present");
    await present(PAGE);
    expect(reasonOf(await apps.prepare({ artifact: "page", version: 7 }))).toContain(
      "no version 7",
    );
    await present("# md", "notes", "text/markdown");
    expect(reasonOf(await apps.prepare({ artifact: "notes" }))).toContain("only an HTML page");
    await present(new Uint8Array([0x3c, 0xff, 0xfe]), "bad");
    expect(reasonOf(await apps.prepare({ artifact: "bad" }))).toContain("UTF-8");
    expect(api.calls).toEqual([]);
  });

  test("over 10 MiB", async () => {
    const { apps, present } = rig();
    await present(new Uint8Array(10 * 1024 * 1024 + 1).fill(97));
    expect(reasonOf(await apps.prepare({ artifact: "page" }))).toContain("larger than 10 MiB");
  });

  test("evicted bytes: present it again", async () => {
    const { apps, present } = rig({ maxBytes: 40 });
    await present(PAGE);
    await present("<!doctype html><p>another</p>", "other");
    expect(reasonOf(await apps.prepare({ artifact: "page" }))).toContain("present it again");
  });

  test("the same bytes already live", async () => {
    const { apps, present } = rig();
    await present(PAGE);
    const row = await published(apps);
    expect(reasonOf(await apps.prepare({ artifact: "page" }))).toBe(`already live at ${row.url}`);
  });

  test("a create: the meta, the bytes, the findings; never the key", async () => {
    const { apps, present, created } = rig();
    const meta = await present(`${PAGE}\ntoken = "abcdefghij"`);
    const p = await prepared(apps);
    expect(p.kind).toBe("create");
    expect(p.app).toBeUndefined();
    expect(p.domain).toBe(DOMAIN);
    expect(p.meta).toEqual(meta as ArtifactMeta);
    expect(p.findings).toEqual([{ rule: "assignment", line: 2 }]);
    // Nothing was published, so no key was loaded or made.
    expect(created).toEqual([]);
  });
});

describe("publish", () => {
  test("a create uploads the approved bytes, may make the key, and renews", async () => {
    const { apps, present, api, clock, changes, created } = rig();
    await present(PAGE);
    const row = await published(apps);
    expect(created).toEqual([true]);
    expect(new TextDecoder().decode(api.uploads[0])).toBe(PAGE);
    expect(row).toMatchObject({
      app: appId(0),
      url: `https://${appId(0)}.${DOMAIN}/`,
      artifactId: "page",
      version: 1,
      title: "Demo",
      state: "up",
    });
    expect(changes.at(-1)).toEqual([row]);
    await clock.advance(60_000);
    await clock.advance(60_000);
    expect(api.calls).toEqual(["create", `renew ${appId(0)}`, `renew ${appId(0)}`]);
    // A renew never makes a key.
    expect(created.slice(1)).toEqual([false, false]);
  });

  test("tampered bytes are refused and nothing is sent", async () => {
    const { apps, present, api } = rig();
    await present(PAGE);
    const p = await prepared(apps);
    const tampered = bytes("<!doctype html><p>two</p>");
    const result = await apps.publish({ ...p, bytes: tampered });
    expect(result).toMatchObject({ ok: false });
    expect(reasonOf(result as AppRefusal)).toContain("changed since it was approved");
    expect(api.calls).toEqual([]);
    expect(apps.list()).toEqual([]);
  });

  test("a new version of the artifact updates the same URL", async () => {
    const { apps, present, api } = rig();
    await present(PAGE);
    const first = await published(apps);
    await present("<!doctype html><p>two</p>");
    const p = await prepared(apps);
    expect(p).toMatchObject({ kind: "update", app: first.app, url: first.url });
    const result = await apps.publish(p);
    expect(result).toMatchObject({ ok: true, row: { url: first.url, version: 2 } });
    expect(api.calls).toEqual(["create", `update ${first.app}`]);
    expect(apps.list()).toHaveLength(1);
    expect(apps.records()[0]?.sha256).toBe(p.meta.sha256);
  });

  test("a lost create is not retried and says where the orphan goes", async () => {
    const { apps, present, api, clock } = rig();
    api.onCreate = () => refused("timeout");
    await present(PAGE);
    const result = await apps.publish(await prepared(apps));
    expect(reasonOf(result as AppRefusal)).toContain("goes offline within 5 minutes");
    await clock.advance(600_000);
    expect(api.calls).toEqual(["create"]);
    expect(apps.list()).toEqual([]);
  });

  test("host refusals are mapped", async () => {
    const { apps, present, api } = rig();
    await present(PAGE);
    for (const [code, words] of [
      ["cap_reached", "/apps"],
      ["killed", "paused by the operator"],
      ["storage_full", "full"],
      ["too_large", "larger"],
      ["blocked", "spam"],
    ] as const) {
      api.onCreate = () => refused(code, code === "blocked" ? "spam" : undefined);
      const result = await apps.publish(await prepared(apps));
      expect(reasonOf(result as AppRefusal)).toContain(words);
    }
  });

  test("an unusable key refuses with its reason", async () => {
    const service = new AppsService({
      configDir: "/nonexistent",
      domain: DOMAIN,
      api: async () => ({ ok: false, reason: "/k is not a usable publisher key" }),
    });
    const store = new ArtifactStore(new ArtifactBudget());
    await store.present({
      id: "page",
      bytes: bytes(PAGE),
      mimeType: "text/html",
      kind: "html",
      title: "Demo",
      callId: "c",
    });
    const apps = service.session("s", { artifacts: store, onChange: () => {} });
    const result = await apps.publish(await prepared(apps));
    expect(result).toEqual({ ok: false, reason: "/k is not a usable publisher key" });
  });
});

describe("the lease", () => {
  test("lapsed and the bytes held: the SAME page is revived with no new publish", async () => {
    const { apps, present, api, clock } = rig();
    await present(PAGE);
    const row = await published(apps);
    // A newer version in the store is never what a revival uploads.
    await present("<!doctype html><p>two</p>");
    api.onRenew = () => refused("expired");
    await clock.advance(60_000);
    expect(api.calls).toEqual(["create", `renew ${row.app}`, `update ${row.app}`]);
    expect(new TextDecoder().decode(api.uploads[1])).toBe(PAGE);
    expect(apps.list()[0]?.state).toBe("up");
  });

  test("offline: renewing, then down exactly after one lease, then up again", async () => {
    const { apps, present, api, clock, changes } = rig();
    await present(PAGE);
    await published(apps);
    api.onRenew = () => refused("network");
    await clock.advance(60_000);
    expect(apps.list()[0]?.state).toBe("renewing");
    await clock.advance(240_000);
    expect(apps.list()[0]?.state).toBe("renewing");
    await clock.advance(1);
    expect(apps.list()[0]?.state).toBe("down");
    expect(changes.at(-1)?.[0]?.state).toBe("down");
    api.onRenew = (id) => leased(id);
    await clock.advance(60_000);
    expect(apps.list()[0]?.state).toBe("up");
  });

  test("a renew that never answers still turns the row down at the lapse", async () => {
    const { apps, present, api, clock } = rig();
    await present(PAGE);
    await published(apps);
    api.onRenew = () => new Promise(() => {});
    await clock.advance(300_001);
    expect(apps.list()[0]?.state).toBe("down");
    expect(api.calls.filter((c) => c.startsWith("renew"))).toHaveLength(1);
  });

  test("taken down: removed with the reason, no more renews", async () => {
    const { apps, present, api, clock } = rig();
    await present(PAGE);
    await published(apps);
    api.onRenew = () => refused("taken_down", "phishing");
    await clock.advance(60_000);
    expect(apps.list()[0]).toMatchObject({ state: "removed" });
    expect(apps.list()[0]?.reason).toContain("phishing");
    await clock.advance(600_000);
    expect(api.calls).toHaveLength(2);
    expect(clock.timers.size).toBe(0);
  });

  test("an app the host forgot is replaced by a new one on the next publish", async () => {
    const { apps, present, api, clock } = rig();
    await present(PAGE);
    await published(apps);
    api.onRenew = () => refused("not_found");
    await clock.advance(60_000);
    const p = await prepared(apps);
    expect(p.kind).toBe("create");
    await apps.publish(p);
    expect(apps.list().map((r) => r.app)).toEqual([appId(1)]);
  });
});

describe("stopping", () => {
  test("unpublish removes the row and deletes; an unknown app says so", async () => {
    const { apps, present, api, changes, clock } = rig();
    await present(PAGE);
    const row = await published(apps);
    expect(await apps.unpublish(row.app)).toEqual({ ok: true });
    expect(apps.list()).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
    expect(api.calls).toEqual(["create", `remove ${row.app}`]);
    expect(clock.timers.size).toBe(0);
    expect((await apps.unpublish(row.app)).ok).toBe(false);
  });

  test("a DELETE the host never got says the lease takes the page down", async () => {
    const { apps, present, api } = rig();
    await present(PAGE);
    const row = await published(apps);
    api.onRemove = () => refused("network");
    const result = await apps.unpublish(row.app);
    expect(result.ok).toBe(true);
    expect(result.reason).toContain("within 5 minutes");
    expect(apps.list()).toEqual([]);
  });

  test("Stop aborts a running renew, and its late answer is ignored", async () => {
    const { apps, present, api, clock } = rig();
    await present(PAGE);
    const row = await published(apps);
    const slow = gate<ReturnType<typeof leased>>();
    api.onRenew = () => slow.promise;
    await clock.advance(60_000);
    const signal = api.signals.at(-1);
    expect(signal?.aborted).toBe(false);
    await apps.unpublish(row.app);
    expect(signal?.aborted).toBe(true);
    slow.resolve(leased(row.app));
    await settle();
    expect(apps.list()).toEqual([]);
    expect(clock.timers.size).toBe(0);
  });

  test("endAll: one DELETE per app, rows gone at once, nothing armed", async () => {
    const { apps, present, api, clock, changes } = rig();
    await present(PAGE);
    await present("<!doctype html><p>b</p>", "other");
    await published(apps);
    await published(apps, "other");
    const before = changes.length;
    const done = apps.endAll();
    expect(apps.list()).toEqual([]);
    expect(apps.records()).toEqual([]);
    await done;
    expect(api.calls.filter((c) => c.startsWith("remove"))).toEqual([
      `remove ${appId(0)}`,
      `remove ${appId(1)}`,
    ]);
    expect(clock.timers.size).toBe(0);
    expect(changes).toHaveLength(before);
    expect(apps.endAll()).toBe(done);
  });

  test("closed mid-create: DELETE after the create answers, no row, and endAll waits", async () => {
    const { apps, present, api, changes } = rig();
    await present(PAGE);
    const slow = gate<ReturnType<typeof leased>>();
    api.onCreate = () => slow.promise;
    const publishing = apps.publish(await prepared(apps));
    await settle();
    let drained = false;
    const done = apps.endAll().then(() => {
      drained = true;
    });
    await settle();
    expect(drained).toBe(false);
    expect(api.calls).toEqual(["create"]);
    slow.resolve(leased(appId(5)));
    expect(await publishing).toMatchObject({ ok: false });
    await done;
    expect(api.calls).toEqual(["create", `remove ${appId(5)}`]);
    expect(apps.list()).toEqual([]);
    expect(changes).toEqual([]);
  });

  test("the daemon stopping deletes nothing and keeps the records", async () => {
    const { apps, present, api, clock, service } = rig();
    await present(PAGE);
    await published(apps);
    service.stop();
    await clock.advance(600_000);
    expect(api.calls).toEqual(["create"]);
    expect(clock.timers.size).toBe(0);
    expect(apps.records()).toHaveLength(1);
  });
});

describe("restore", () => {
  const record = {
    app: appId(3),
    url: `https://${appId(3)}.${DOMAIN}/`,
    artifactId: "page",
    version: 1,
    sha256: "ab".repeat(32),
    title: "Demo",
    publishedAt: 1,
  };

  test("every record renews at once", async () => {
    const { apps, api, clock } = rig();
    apps.restore([record, { ...record, app: appId(4), url: `https://${appId(4)}.${DOMAIN}/` }]);
    expect(apps.list().map((r) => r.state)).toEqual(["renewing", "renewing"]);
    await clock.advance(0);
    expect(api.calls).toEqual([`renew ${appId(3)}`, `renew ${appId(4)}`]);
    expect(apps.list().map((r) => r.state)).toEqual(["up", "up"]);
  });

  test("lapsed while the daemon was away and no bytes: down, publish again", async () => {
    const { apps, api, clock } = rig();
    api.onRenew = () => refused("expired");
    apps.restore([record]);
    await clock.advance(0);
    expect(apps.list()[0]).toMatchObject({ state: "down" });
    expect(apps.list()[0]?.reason).toContain("publish again");
    expect(api.calls).toEqual([`renew ${appId(3)}`]);
    expect(clock.timers.size).toBe(0);
  });

  test("an id another session owns is dropped with a log line", async () => {
    const { apps, service, store, logs } = rig();
    apps.restore([record]);
    const second = service.session("s2", { artifacts: store, onChange: () => {} });
    second.restore([record]);
    expect(second.list()).toEqual([]);
    expect(apps.list()).toHaveLength(1);
    expect(logs.join("\n")).toContain(`s2: ${appId(3)} belongs to another`);
  });
});
