/**
 * Both ends, byte for byte (docs/feat/session-apps-publish.md): the daemon's
 * `AppsClient` with a real publisher key against the real host on a loopback
 * port — create → renew → update → lapse → `410` → revive → delete, and an
 * operator takedown.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative on purpose: the host does not depend on the daemon package.
import { AppsClient } from "../../../packages/daemon/src/apps-client.ts";
import { loadOrCreateAppsKey } from "../../../packages/daemon/src/apps-key.ts";
import { DOMAIN, startHost, stopAll } from "./support/host.ts";

const configDir = mkdtempSync(join(tmpdir(), "apps-compat-"));
afterAll(async () => {
  await stopAll();
  rmSync(configDir, { recursive: true, force: true });
});

const page = (text: string) => new TextEncoder().encode(`<!doctype html><p>${text}</p>`);

async function rig() {
  const host = await startHost();
  const key = await loadOrCreateAppsKey(configDir);
  if (!key.ok) throw new Error(key.reason);
  const client = new AppsClient({
    domain: DOMAIN,
    baseUrl: host.server.url,
    key: key.key,
    now: () => host.clock.at,
  });
  const served = async (id: string) => (await host.visit(id)).text();
  return { host, client, served, key: key.key };
}

describe("the publisher's client against the apps host", () => {
  test("create → renew → update → lapse → expired → revive → delete", async () => {
    const { host, client, served } = await rig();
    const created = await client.create(page("one-é"));
    if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
    const { id, url } = created.lease;
    expect(url).toBe(`https://${id}.${DOMAIN}/`);
    expect(await served(id)).toContain("one-é");

    host.advance(created.lease.renewAfterMs);
    expect(await client.renew(id)).toMatchObject({ ok: true, lease: { id, url } });

    expect(await client.update(id, page("two"))).toMatchObject({ ok: true, lease: { id, url } });
    expect(await served(id)).toContain("two");

    host.advance(created.lease.leaseMs + 1);
    await host.server.sweep();
    expect(await client.renew(id)).toMatchObject({ ok: false, code: "expired" });
    expect(await client.update(id, page("two"))).toMatchObject({ ok: true, lease: { id, url } });
    expect(await served(id)).toContain("two");

    expect(await client.remove(id)).toEqual({ ok: true });
    expect(await client.renew(id)).toMatchObject({
      ok: false,
      code: "deleted",
      transient: false,
    });
  });

  test("a takedown: renew answers taken_down with the operator's reason", async () => {
    const { host, client } = await rig();
    const created = await client.create(page("three"));
    if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
    const { id } = created.lease;
    host.files.takedowns = { kind: "text", text: `app ${id} phishing page` };
    host.advance(2000);
    await host.server.sweep();
    expect(await client.renew(id)).toMatchObject({
      ok: false,
      code: "taken_down",
      reason: "phishing page",
    });
  });

  test("a clock ten minutes behind is corrected by one re-sign", async () => {
    const { host, key } = await rig();
    const client = new AppsClient({
      domain: DOMAIN,
      baseUrl: host.server.url,
      key,
      now: () => host.clock.at - 600_000,
    });
    // The host's nonce memory starts at its own start: give the skewed date room.
    host.advance(600_000);
    expect(await client.create(page("skew"))).toMatchObject({ ok: true });
  });

  test("another key may not touch the app", async () => {
    const { host, client } = await rig();
    const created = await client.create(page("four"));
    if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
    const otherDir = join(configDir, "other");
    const other = await loadOrCreateAppsKey(otherDir);
    if (!other.ok) throw new Error(other.reason);
    const stranger = new AppsClient({
      domain: DOMAIN,
      baseUrl: host.server.url,
      key: other.key,
      now: () => host.clock.at,
    });
    expect(await stranger.renew(created.lease.id)).toMatchObject({ ok: false, code: "forbidden" });
  });
});
