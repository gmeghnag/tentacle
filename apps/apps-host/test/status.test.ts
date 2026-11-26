// `/__status` on the apps host (docs/feat/relay-status.md): the separate
// loopback listener, its counters and gauges, and what it must never say.
import { afterEach, describe, expect, test } from "bun:test";
import type { RunningAppsHost } from "../src/server.ts";
import { DOMAIN, HTML, publisher, startHost, stopAll } from "./support/host.ts";

afterEach(stopAll);

const BYTES = new TextEncoder().encode(HTML).length;

interface StatusBody {
  service: string;
  uptimeSeconds: number;
  memory: { rssBytes: number; heapUsedBytes: number };
  now: { liveApps: number; storeBytes: number; killSwitch: string };
  totals: Record<string, number>;
  lastMinute: Record<string, number>;
  history: Record<string, number>[];
}

function statusUrl(server: RunningAppsHost): string {
  if (server.statusPort === undefined) {
    throw new Error("the status listener is not up");
  }
  return `http://127.0.0.1:${server.statusPort}/__status`;
}

async function status(server: RunningAppsHost): Promise<StatusBody> {
  const response = await fetch(statusUrl(server));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as StatusBody;
}

const report = (app: string, reason: string) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ app, reason }).toString(),
});

/** Every leaf of a JSON value, with its dotted path. */
function leaves(value: unknown, path = ""): [string, unknown][] {
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      leaves(child, path === "" ? key : `${path}.${key}`),
    );
  }
  return [[path, value]];
}

describe("the apps host's /__status", () => {
  test("off by default for the library", async () => {
    const host = await startHost();
    expect(host.server.statusPort).toBeUndefined();
  });

  test("live apps and their content bytes, after a publish and after a delete", async () => {
    const host = await startHost({ statusPort: 0 });
    const empty = await status(host.server);
    expect(empty.service).toBe("apps-host");
    expect(empty.now).toEqual({ liveApps: 0, storeBytes: 0, killSwitch: "off" });
    expect(empty.memory.rssBytes).toBeGreaterThan(0);
    const first = await host.publish(publisher);
    await host.publish(publisher);
    expect((await status(host.server)).now).toMatchObject({ liveApps: 2, storeBytes: 2 * BYTES });
    const deleted = await host.signed(publisher, "DELETE", `/v1/apps/${first}`);
    expect(deleted.status).toBe(204);
    expect((await status(host.server)).now).toMatchObject({ liveApps: 1, storeBytes: BYTES });
  });

  test("requests counts every public request on any host, never a status read", async () => {
    const host = await startHost({ statusPort: 0 });
    await host.call("/healthz");
    await host.call("/", { host: `aaaaaaaaaaaaaaaa.${DOMAIN}` });
    await host.call("/", { host: "elsewhere.example" });
    await status(host.server);
    expect((await status(host.server)).totals.requests).toBe(3);
  });

  test("reports counts only a STORED report", async () => {
    const host = await startHost({ statusPort: 0 });
    const id = await host.publish(publisher);
    expect((await host.call("/v1/report", report(id, "boring"))).status).toBe(400);
    host.memory.fail("appendReport");
    expect((await host.call("/v1/report", report(id, "other"))).status).toBe(503);
    host.memory.heal();
    expect((await status(host.server)).totals.reports).toBe(0);
    expect((await host.call("/v1/report", report(id, "other"))).status).toBe(303);
    expect((await status(host.server)).totals.reports).toBe(1);
  });

  test("the kill switch is reflected", async () => {
    const host = await startHost({ statusPort: 0 });
    for (const word of ["publish", "all"]) {
      host.files["kill-switch"] = { kind: "text", text: `${word}\n` };
      host.advance(2_000);
      expect((await status(host.server)).now.killSwitch).toBe(word);
    }
  });

  test("the sweep samples the gauges into the history without anyone asking", async () => {
    const host = await startHost({ statusPort: 0, limits: { sweepMs: 3_600_000 } });
    // A minute boundary first, so the publish and the sweep share one minute.
    host.advance(60_000 - (host.clock.at % 60_000));
    await host.publish(publisher);
    await host.server.sweep();
    host.advance(60_000);
    const body = await status(host.server);
    expect(body.history).toContainEqual(
      expect.objectContaining({ liveApps: 1, storeBytes: BYTES }),
    );
    expect(body.lastMinute).toEqual({ requests: 1, reports: 0 });
  });

  test("numbers only (bar `service` and `killSwitch`): no app id, key or address", async () => {
    const host = await startHost({ statusPort: 0 });
    const id = await host.publish(publisher);
    await host.visit(id);
    await host.call("/v1/report", report(id, "other"));
    const body = await status(host.server);
    for (const [path, value] of leaves(body)) {
      if (path !== "service" && path !== "now.killSwitch") {
        expect({ path, type: typeof value }).toEqual({ path, type: "number" });
      }
    }
    const text = await (await fetch(statusUrl(host.server))).text();
    for (const secret of [id, publisher.key, publisher.key.slice(0, 8), "127.0.0.1", DOMAIN]) {
      expect(text).not.toContain(secret);
    }
  });

  test("the PUBLIC port 404s /__status on the apex, an app host and an unknown host", async () => {
    const host = await startHost({ statusPort: 0, trustProxy: true });
    const id = await host.publish(publisher);
    const variants: Record<string, string>[] = [{}, { "x-forwarded-for": "127.0.0.1" }];
    for (const name of [DOMAIN, `${id}.${DOMAIN}`, "127.0.0.1", "localhost"]) {
      for (const headers of variants) {
        const response = await host.call("/__status", { host: name, headers });
        const text = await response.text();
        expect({ name, status: response.status }).toEqual({ name, status: 404 });
        expect(text).not.toContain("uptimeSeconds");
      }
    }
  });

  test("a proxied-shaped request on the status port is a 404", async () => {
    const host = await startHost({ statusPort: 0 });
    const forwarded = await fetch(statusUrl(host.server), {
      headers: { "X-Forwarded-For": "203.0.113.7" },
    });
    expect(forwarded.status).toBe(404);
    const named = await fetch(statusUrl(host.server), { headers: { Host: DOMAIN } });
    expect(named.status).toBe(404);
  });

  test("a busy status port: the host serves without it, and says so", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try {
      const host = await startHost({ statusPort: holder.port });
      expect(host.server.statusPort).toBeUndefined();
      expect(host.lines).toContain("status-off EADDRINUSE");
      expect((await host.call("/healthz")).status).toBe(200);
    } finally {
      holder.stop(true);
    }
  });

  test("stop() closes it: the port can be bound again", async () => {
    // A port to be REBOUND is picked outside the ephemeral range (AGENTS §9).
    let server: RunningAppsHost | undefined;
    let port = 0;
    for (let attempt = 0; attempt < 50 && server?.statusPort === undefined; attempt += 1) {
      port = 20_000 + Math.floor(Math.random() * 10_000);
      server = (await startHost({ statusPort: port })).server;
    }
    expect(server?.statusPort).toBe(port);
    await server?.stop();
    const again = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    again.stop(true);
  });
});
