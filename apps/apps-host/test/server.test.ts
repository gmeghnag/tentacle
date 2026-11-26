import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppsErrorSchema, AppsLeaseResultSchema } from "@tentacle/protocol";
import { appResponseHeaders } from "../src/pages.ts";
import { controlRoute } from "../src/routes.ts";
import { fileReader } from "../src/server.ts";
import { createFsStore } from "../src/store.ts";
import { APP_NAV, DOMAIN, HTML, publisher, startHost, stopAll, until } from "./support/host.ts";
import { createPublisher } from "./support/publisher.ts";

const temporary: string[] = [];
afterEach(async () => {
  await stopAll();
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "apps-host-server-"));
  temporary.push(dir);
  return dir;
}

const errorOf = async (response: Response) => AppsErrorSchema.parse(await response.json());
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

describe("routes", () => {
  test("the control table: 404 for unknown paths, 405 for a wrong method", () => {
    const id = "abcdefghijklmnop";
    expect(controlRoute("POST", "/v1/apps")).toEqual({ kind: "create" });
    expect(controlRoute("PUT", `/v1/apps/${id}`)).toEqual({ kind: "update", id });
    expect(controlRoute("DELETE", `/v1/apps/${id}`)).toEqual({ kind: "delete", id });
    expect(controlRoute("POST", `/v1/apps/${id}/lease`)).toEqual({ kind: "renew", id });
    for (const [method, path] of [
      ["GET", "/v1/apps"],
      ["GET", `/v1/apps/${id}`],
      ["PUT", `/v1/apps/${id}/lease`],
      ["GET", "/v1/report"],
      ["POST", "/healthz"],
    ] as const) {
      expect(controlRoute(method, path).kind).toBe("method_not_allowed");
    }
    for (const path of ["/v1", "/v1/apps/", "/v1/apps/short", `/v1/apps/${id}/x`, "/admin"]) {
      expect(controlRoute("GET", path).kind).toBe("not_found");
    }
  });
});

describe("publish and visit", () => {
  test("a signed create answers 201 with the lease and the url", async () => {
    const host = await startHost();
    const response = await host.signed(publisher, "POST", "/v1/apps", HTML);
    expect(response.status).toBe(201);
    const result = AppsLeaseResultSchema.parse(await response.json());
    expect(result).toEqual({
      id: result.id,
      url: `https://${result.id}.${DOMAIN}/`,
      leaseExpiresAt: host.clock.at + 300_000,
      leaseMs: 300_000,
      renewAfterMs: 60_000,
    });
    expect(host.lines).toContain(
      `publish ${result.id} key ${publisher.key.slice(0, 8)} ip 127.0.0.1 bytes ${Buffer.byteLength(HTML)}`,
    );
  });

  test("a forged Host header or query never changes the QR's encoded url", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    const nav = { ...APP_NAV, "sec-fetch-site": "none" };
    const plain = await (await host.visit(id, nav)).text();
    const forged = await host.call("/?host=evil.example&u=https://evil.example/", {
      host: `${id}.${DOMAIN}`,
      headers: { ...nav, "x-forwarded-host": "evil.example" },
    });
    const body = await forged.text();
    expect(body).toContain(`<p class="qr-url">https://${id}.${DOMAIN}/</p>`);
    expect(body).not.toContain("evil.example");
    expect(body).toBe(plain);
  });

  test("a link gets the warning; the same-origin navigation the exact bytes", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    const warning = await host.visit(id, { ...APP_NAV, "sec-fetch-site": "none" });
    expect(warning.status).toBe(200);
    const page = await warning.text();
    expect(page).toContain("published by a tentacle user");
    expect(page).not.toContain("héllo");

    const app = await host.visit(id);
    expect(app.status).toBe(200);
    expect(Array.from(new Uint8Array(await app.arrayBuffer()))).toEqual(
      Array.from(new TextEncoder().encode(HTML)),
    );
    for (const [name, value] of Object.entries(appResponseHeaders())) {
      expect([name, app.headers.get(name)]).toEqual([name, value]);
    }
    const head = await host.call("/?x=1", {
      method: "HEAD",
      host: `${id.toUpperCase()}.${DOMAIN}:443`,
      headers: APP_NAV,
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(await head.text()).toBe("");
  });

  test("the framed app: only as this origin's iframe, never top level, never skipping the warning", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    const frame = { ...APP_NAV, "sec-fetch-dest": "iframe" };
    const call = (headers: Record<string, string>) =>
      host.call("/_frame", { host: `${id}.${DOMAIN}`, headers });
    // The wrapper without an ack names no address, and carries the sandboxed frame.
    const wrapper = await host.visit(id, { ...APP_NAV, "sec-fetch-site": "none" });
    const page = await wrapper.text();
    expect(page).toContain('sandbox="allow-scripts"');
    expect(wrapper.headers.get("content-security-policy")).toContain("frame-src 'self'");

    const ok = await call(frame);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(HTML);
    expect(ok.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(ok.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(ok.headers.get("content-security-policy")).toContain("sandbox allow-scripts");

    // Top level (typed or linked), another origin's or site's frame, no Fetch Metadata.
    for (const headers of [
      APP_NAV,
      { ...APP_NAV, "sec-fetch-site": "none" },
      { ...frame, "sec-fetch-site": "cross-site" },
      { ...frame, "sec-fetch-site": "same-site" },
      {},
    ]) {
      const refused = await call(headers);
      expect(refused.status).toBe(404);
      expect(await refused.text()).not.toContain("héllo");
    }
    // The real path still answers a top-level visit with the warning, not the app.
    const link = await host.visit(id, { ...frame, "sec-fetch-site": "cross-site" });
    expect(await link.text()).toContain("published by a tentacle user");
  });

  test("the app is served from the real fs store and survives a restart", async () => {
    const dir = tempDir();
    const first = await startHost({ store: createFsStore(dir) });
    const id = await first.publish(publisher);
    await first.server.stop();
    const second = await startHost({ store: createFsStore(dir) });
    const app = await second.visit(id);
    expect(app.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await app.text()).toBe(HTML);
  });

  test("a host outage longer than the lease does not delete a live app", async () => {
    const dir = tempDir();
    const first = await startHost({ store: createFsStore(dir) });
    const id = await first.publish(publisher);
    await first.server.stop();
    const later = first.clock.at + 600_000;
    const second = await startHost({ store: createFsStore(dir), now: () => later });
    expect(await (await second.visit(id)).text()).toBe(HTML);
  });

  test("renew, update and delete over HTTP", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    host.advance(60_000);
    const renewed = await host.signed(publisher, "POST", `/v1/apps/${id}/lease`);
    expect(renewed.status).toBe(200);
    expect(AppsLeaseResultSchema.parse(await renewed.json()).leaseExpiresAt).toBe(
      host.clock.at + 300_000,
    );
    const updated = await host.signed(publisher, "PUT", `/v1/apps/${id}`, "<p>two</p>");
    expect(updated.status).toBe(200);
    expect(await (await host.visit(id)).text()).toBe("<p>two</p>");
    expect(host.memory.contents.size).toBe(1);
    const stranger = await createPublisher();
    const forbidden = await host.signed(stranger, "DELETE", `/v1/apps/${id}`);
    expect(forbidden.status).toBe(403);
    const deleted = await host.signed(publisher, "DELETE", `/v1/apps/${id}`);
    expect(deleted.status).toBe(204);
    expect(host.memory.contents.size).toBe(0);
    expect(host.memory.records.get(id)?.state).toBe("deleted");
    expect((await host.visit(id)).status).toBe(410);
    expect(host.lines).toContain(`delete ${id}`);
  });

  test("a lapsed lease: offline, swept, then revived at the same URL", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    host.advance(300_001);
    expect((await host.visit(id)).status).toBe(503);
    await host.server.sweep();
    expect(host.memory.contents.size).toBe(0);
    expect(host.lines).toContain(`expire ${id}`);
    const renew = await host.signed(publisher, "POST", `/v1/apps/${id}/lease`);
    expect(renew.status).toBe(410);
    expect((await errorOf(renew)).error).toBe("expired");
    const revived = await host.signed(publisher, "PUT", `/v1/apps/${id}`, HTML);
    expect(revived.status).toBe(200);
    expect(await (await host.visit(id)).text()).toBe(HTML);
    expect(host.lines.some((line) => line.startsWith(`revive ${id} `))).toBe(true);
  });
});

describe("refusals", () => {
  test("unsigned, forged, replayed and skewed requests touch nothing", async () => {
    const host = await startHost();
    const unsigned = await host.call("/v1/apps", { method: "POST", body: HTML });
    expect(unsigned.status).toBe(400);
    expect((await errorOf(unsigned)).error).toBe("bad_request");

    const headers = await publisher.headers({
      method: "POST",
      path: "/v1/apps",
      domain: "apps.other.so",
      date: host.clock.at,
      body: new TextEncoder().encode(HTML),
    });
    const forged = await host.call("/v1/apps", {
      method: "POST",
      headers: { ...headers, "content-type": "text/html" },
      body: HTML,
    });
    expect(forged.status).toBe(401);
    expect((await errorOf(forged)).error).toBe("bad_signature");
    expect(host.memory.contents.size).toBe(0);

    const good = await publisher.headers({
      method: "POST",
      path: "/v1/apps",
      domain: DOMAIN,
      date: host.clock.at,
      body: new TextEncoder().encode(HTML),
    });
    const send = () =>
      host.call("/v1/apps", {
        method: "POST",
        headers: { ...good, "content-type": "text/html" },
        body: HTML,
      });
    expect((await send()).status).toBe(201);
    const again = await send();
    expect(again.status).toBe(409);
    expect((await errorOf(again)).error).toBe("replay");
    expect(host.memory.records.size).toBe(1);

    host.advance(301_000);
    const skewed = await send();
    expect(skewed.status).toBe(401);
    expect(await errorOf(skewed)).toMatchObject({
      error: "clock_skew",
      serverTime: host.clock.at,
    });
    expect(host.lines).toContain("refused bad_signature ip 127.0.0.1");
  });

  test("413, 415, 400: nothing is stored", async () => {
    const host = await startHost({ limits: { maxAppBytes: 1000 } });
    const big = await host.signed(publisher, "POST", "/v1/apps", "x".repeat(5000));
    expect(big.status).toBe(413);
    const chunked = await host.call("/v1/apps", {
      method: "POST",
      headers: await publisher.headers({
        method: "POST",
        path: "/v1/apps",
        domain: DOMAIN,
        date: host.clock.at,
      }),
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 5; i++) {
            controller.enqueue(new Uint8Array(1000));
          }
          controller.close();
        },
      }),
    });
    expect(chunked.status).toBe(413);
    expect((await host.signed(publisher, "POST", "/v1/apps", "x".repeat(1000))).status).toBe(201);
    host.memory.contents.clear();
    host.memory.records.clear();

    const typed = await host.signed(publisher, "POST", "/v1/apps", HTML, {
      "content-type": "text/plain",
    });
    expect(typed.status).toBe(415);
    const charset = await host.signed(publisher, "POST", "/v1/apps", HTML, {
      "content-type": "text/html; charset=latin1",
    });
    expect(charset.status).toBe(415);
    for (const body of [new Uint8Array([0xff, 0xfe, 0x41]), new Uint8Array()]) {
      const response = await host.signed(publisher, "POST", "/v1/apps", body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).error).toBe("malformed");
    }
    const query = await host.signed(publisher, "POST", "/v1/apps?x=1", HTML);
    expect(query.status).toBe(400);
    expect(host.memory.records.size).toBe(0);
  });

  test("renew and delete take no body", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    const response = await host.signed(publisher, "POST", `/v1/apps/${id}/lease`, "x");
    expect(response.status).toBe(400);
  });

  test("404 and 405 on the app and control hosts; unknown hosts are 404", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    const appHost = `${id}.${DOMAIN}`;
    expect((await host.call("/x", { host: appHost })).status).toBe(404);
    expect((await host.call("/", { host: appHost, method: "POST" })).status).toBe(405);
    expect((await host.call("/v1/apps", { host: appHost, method: "POST" })).status).toBe(404);
    expect((await host.visit("aaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await host.visit("nope")).status).toBe(404);
    expect((await host.call("/nope")).status).toBe(404);
    expect((await host.call("/v1/apps")).status).toBe(405);
    expect((await host.call("/", { host: "evil.example" })).status).toBe(404);
    const robots = await host.call("/robots.txt", { host: appHost });
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  test("/healthz has no counters", async () => {
    const host = await startHost();
    await host.publish(publisher);
    expect(await (await host.call("/healthz")).json()).toEqual({ ok: true, v: 1 });
  });

  test("the per-address limit keys on X-Forwarded-For only when trusted", async () => {
    const from = (ip: string) => ({ "x-forwarded-for": `9.9.9.9, ${ip}` });
    const send = (host: Awaited<ReturnType<typeof startHost>>, ip: string) =>
      host.call("/v1/apps", { method: "POST", headers: from(ip), body: "x" });
    const trusting = await startHost({ trustProxy: true, limits: { apiPerMinutePerIp: 1 } });
    expect((await send(trusting, "1.1.1.1")).status).toBe(400);
    const limited = await send(trusting, "1.1.1.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await send(trusting, "2.2.2.2")).status).toBe(400);
    expect(trusting.lines).toContain("refused rate_limited ip 1.1.1.1");

    const plain = await startHost({ limits: { apiPerMinutePerIp: 1 } });
    expect((await send(plain, "1.1.1.1")).status).toBe(400);
    expect((await send(plain, "2.2.2.2")).status).toBe(429);
  });
});

describe("store failures and races", () => {
  test("ENOSPC on update → 507 and the old version is still served", async () => {
    for (const op of ["writeContent", "writeRecord"] as const) {
      const host = await startHost();
      const id = await host.publish(publisher);
      host.memory.fail(op);
      const response = await host.signed(publisher, "PUT", `/v1/apps/${id}`, "<p>two</p>");
      expect(response.status).toBe(507);
      expect((await errorOf(response)).error).toBe("storage_full");
      host.memory.heal();
      expect(await (await host.visit(id)).text()).toBe(HTML);
      expect(host.memory.contents.size).toBe(1);
      expect(host.lines.some((l) => /^store-error \S+ ENOSPC$/.test(l))).toBe(true);
      // The reservation is gone: the next write goes through.
      expect((await host.signed(publisher, "PUT", `/v1/apps/${id}`, "<p>3</p>")).status).toBe(200);
    }
  });

  test("EIO on create → 500, nothing left; low free space → 507 before writing", async () => {
    const host = await startHost();
    host.memory.fail("writeRecord", "EIO");
    const failed = await host.signed(publisher, "POST", "/v1/apps", HTML);
    expect(failed.status).toBe(500);
    expect(host.memory.contents.size).toBe(0);
    host.memory.heal();
    host.memory.disk.free = 10;
    expect((await host.signed(publisher, "POST", "/v1/apps", HTML)).status).toBe(507);
    host.memory.fail("freeBytes", "EIO");
    expect((await host.signed(publisher, "POST", "/v1/apps", HTML)).status).toBe(507);
    expect(host.memory.contents.size).toBe(0);
  });

  test("a failed snapshot write is logged and serving continues", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    host.memory.fail("writeSnapshot");
    host.advance(30_000);
    await host.server.sweep();
    expect(host.lines).toContain("snapshot-failed ENOSPC");
    expect((await host.visit(id)).status).toBe(200);
  });

  test("the snapshot is written every snapshotMs and once more on stop", async () => {
    const host = await startHost();
    const atStart = host.memory.snapshots.length;
    const id = await host.publish(publisher);
    host.advance(29_999);
    await host.server.sweep();
    expect(host.memory.snapshots.length).toBe(atStart);
    host.advance(1);
    await host.server.sweep();
    expect(host.memory.snapshots.length).toBe(atStart + 1);
    await host.server.stop();
    expect(host.memory.snapshots.length).toBe(atStart + 2);
    expect(Object.keys(host.memory.snapshots.at(-1)?.leases ?? {})).toEqual([id]);
  });

  test("an update writes content, then the record, then drops the old content", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    host.memory.ops.length = 0;
    await host.signed(publisher, "PUT", `/v1/apps/${id}`, "<p>two</p>");
    expect(host.memory.ops).toEqual(["freeBytes", "writeContent", "writeRecord", "removeContent"]);
  });

  test("the timer sweeps by itself, with the report retention", async () => {
    const host = await startHost({ limits: { sweepMs: 5 } });
    await host.publish(publisher);
    host.advance(300_001);
    await until(() => host.memory.contents.size === 0 && host.memory.pruned.length > 0);
    await until(() => host.memory.pruned.at(-1) === host.clock.at - 30 * 24 * 3_600_000);
  });

  test("the start-up scan removes content no record names", async () => {
    const dir = tempDir();
    const first = await startHost({ store: createFsStore(dir) });
    const id = await first.publish(publisher);
    await first.server.stop();
    const orphan = join(dir, "apps", `${id}-${"0".repeat(16)}.html`);
    writeFileSync(orphan, "left behind");
    const second = await startHost({ store: createFsStore(dir) });
    expect(existsSync(orphan)).toBe(false);
    expect(await (await second.visit(id)).text()).toBe(HTML);
  });

  test("a second write while one is in flight → 409 conflict", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    const release = host.memory.hold("writeContent");
    const first = host.signed(publisher, "PUT", `/v1/apps/${id}`, "<p>two</p>");
    await until(() => host.memory.waiting.length === 1);
    const second = await host.signed(publisher, "PUT", `/v1/apps/${id}`, "<p>three</p>");
    expect(second.status).toBe(409);
    expect((await errorOf(second)).error).toBe("conflict");
    release();
    expect((await first).status).toBe(200);
  });

  test("a takedown racing an in-flight update discards the write", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    const release = host.memory.hold("writeRecord");
    const update = host.signed(publisher, "PUT", `/v1/apps/${id}`, "<p>two</p>");
    await until(() => host.memory.waiting.length === 1);
    host.files.takedowns = { kind: "text", text: `app ${id} malware` };
    host.advance(1000);
    await host.server.sweep();
    release();
    const response = await update;
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ error: "taken_down", reason: "malware" });
    expect(host.memory.contents.size).toBe(0);
    expect(host.memory.records.get(id)?.state).toBe("taken_down");
  });

  test("a revive waits for the expiry's cleanup of the same id", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    host.advance(300_001);
    const release = host.memory.hold("removeContent");
    const sweep = host.server.sweep();
    await until(() => host.memory.waiting.length === 1);
    // The same bytes: the same content file the sweep is about to remove.
    const revive = host.signed(publisher, "PUT", `/v1/apps/${id}`, HTML);
    await until(() => host.server.core.record(id)?.state === "expired");
    await Bun.sleep(20);
    release();
    await sweep;
    expect((await revive).status).toBe(200);
    expect(host.memory.records.get(id)?.state).toBe("live");
    expect(await (await host.visit(id)).text()).toBe(HTML);
  });
});

describe("operator controls", () => {
  test("the kill switch file flips within the staleness bound", async () => {
    const dir = tempDir();
    const host = await startHost({ readOperatorFile: fileReader(dir) });
    const id = await host.publish(publisher);
    writeFileSync(join(dir, "kill-switch"), "all\n");
    host.advance(999);
    expect((await host.visit(id)).status).toBe(200);
    host.advance(1);
    expect((await host.visit(id)).status).toBe(503);
    const refused = await host.signed(publisher, "POST", "/v1/apps", HTML);
    expect(refused.status).toBe(503);
    expect((await errorOf(refused)).error).toBe("killed");
    expect((await host.signed(publisher, "POST", `/v1/apps/${id}/lease`)).status).toBe(200);
    rmSync(join(dir, "kill-switch"));
    host.advance(1000);
    expect((await host.visit(id)).status).toBe(200);
    expect(host.lines).toContain("kill all");
    expect(host.lines).toContain("kill off");
  });

  test("an unreadable operator file is an error, not absent", () => {
    const dir = tempDir();
    expect(fileReader(dir)("kill-switch")).toEqual({ kind: "absent" });
    // A directory in the file's place cannot be read.
    expect(fileReader(join(dir, ".."))(dir.slice(dir.lastIndexOf("/") + 1) as "takedowns")).toEqual(
      { kind: "error" },
    );
  });

  test("a takedown: 410 at once, content removed by the sweep, reason to the publisher", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    host.files.takedowns = { kind: "text", text: `app ${id} phishing page` };
    host.advance(1000);
    const gone = await host.visit(id);
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain("phishing page");
    await host.server.sweep();
    expect(host.memory.contents.size).toBe(0);
    expect(host.lines).toContain(`takedown ${id} phishing page`);
    const renew = await host.signed(publisher, "POST", `/v1/apps/${id}/lease`);
    expect(await errorOf(renew)).toMatchObject({ error: "taken_down", reason: "phishing page" });
  });

  test("a blocked key is refused with the reason", async () => {
    const host = await startHost();
    host.files.takedowns = { kind: "text", text: `key ${publisher.key} abuse` };
    const response = await host.signed(publisher, "POST", "/v1/apps", HTML);
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ error: "blocked", reason: "abuse" });
    expect(host.lines).toContain(`blocked-key ${publisher.key.slice(0, 8)}`);
  });
});

describe("reports", () => {
  test("a report is stored, redirected to thanks, and changes nothing", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    expect(await (await host.call(`/report?app=${id}`)).text()).toContain(`value="${id}"`);
    const response = await host.call(
      "/v1/report",
      form({ app: id, reason: "phishing", details: "a\r\nb", contact: "me@x" }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/report/thanks");
    expect((await host.call("/report/thanks")).status).toBe(200);
    expect(host.memory.reports).toEqual([
      {
        at: host.clock.at,
        ip: "127.0.0.1",
        app: id,
        reason: "phishing",
        details: "a\nb",
        contact: "me@x",
      },
    ]);
    expect(host.lines).toContain(`report ${id} phishing ip 127.0.0.1`);
    expect(host.lines.join("\n")).not.toContain("me@x");
    expect((await host.visit(id)).status).toBe(200);
  });

  test("429 per address, 404 for an unknown app, 400 for bad fields, 503 on a full disk", async () => {
    const host = await startHost({ limits: { reportsPerHourPerIp: 4 } });
    const id = await host.publish(publisher);
    const send = (fields: Record<string, string>) =>
      host.call("/v1/report", form({ app: id, reason: "other", ...fields }));
    expect((await send({ app: "aaaaaaaaaaaaaaaa" })).status).toBe(404);
    expect((await send({ app: "nope" })).status).toBe(404);
    const invalid: Record<string, string>[] = [
      { reason: "boring" },
      { details: "x".repeat(2001) },
      { contact: "x".repeat(201) },
    ];
    for (const bad of invalid) {
      expect((await send(bad)).status).toBe(400);
    }
    const typed = await host.call("/v1/report", { method: "POST", body: "app=x" });
    expect(typed.status).toBe(415);
    host.memory.fail("appendReport");
    const full = await send({});
    expect(full.status).toBe(503);
    expect(await full.text()).toContain("abuse@example.so");
    host.memory.heal();
    expect((await send({})).status).toBe(303);
    expect((await send({})).status).toBe(303);
    expect((await send({})).status).toBe(429);
    expect(host.memory.reports).toHaveLength(2);
  });
});

describe("no cookies, no indexing, ever", () => {
  test("a sweep over every route and status", async () => {
    const host = await startHost({ limits: { reportsPerHourPerIp: 1, maxAppBytes: 100 } });
    const live = await host.publish(publisher, "<p>a</p>");
    const gone = await host.publish(publisher, "<p>b</p>");
    await host.signed(publisher, "DELETE", `/v1/apps/${gone}`);
    const at = (id: string) => `${id}.${DOMAIN}`;
    const responses: Response[] = [
      await host.call("/"),
      await host.call("/healthz"),
      await host.call("/report"),
      await host.call("/report/thanks"),
      await host.call("/robots.txt"),
      await host.call("/nope"),
      await host.call("/v1/apps"),
      await host.call("/", { host: "unknown.example" }),
      await host.call("/v1/apps", { method: "POST", body: "x" }),
      await host.signed(publisher, "POST", "/v1/apps", "<p>c</p>"),
      await host.signed(publisher, "POST", `/v1/apps/${live}/lease`),
      await host.signed(publisher, "PUT", `/v1/apps/${live}`, "<p>d</p>"),
      await host.signed(publisher, "DELETE", `/v1/apps/${gone}`),
      await host.visit(live),
      await host.visit(live, {}),
      await host.visit(gone),
      await host.visit("aaaaaaaaaaaaaaaa"),
      await host.call("/x", { host: at(live) }),
      await host.call("/", { host: at(live), method: "PUT" }),
      await host.call("/robots.txt", { host: at(live) }),
      await host.call("/v1/report", form({ app: live, reason: "other" })),
      await host.call("/v1/report", form({ app: live, reason: "other" })),
      // The live routes, and a live app's own host-made pages, set none either.
      await host.signed(publisher, "POST", "/v1/apps/live"),
      await host.signed(publisher, "GET", `/v1/apps/${live}/tunnel`),
    ];
    const created = [...host.memory.records.values()].find((r) => r.kind === "live");
    const liveHost = at(created?.id ?? "");
    responses.push(
      await host.call("/", { host: liveHost }),
      await host.call("/", { host: liveHost, headers: { "sec-fetch-site": "same-origin" } }),
    );
    const statuses = new Set(responses.map((r) => r.status));
    for (const status of [200, 201, 204, 303, 400, 404, 405, 410, 429]) {
      expect(statuses).toContain(status);
    }
    for (const response of responses) {
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
