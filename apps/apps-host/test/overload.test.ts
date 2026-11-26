/**
 * The public surface under load (docs/feat/session-apps-host.md, Review round 1):
 * the request bodies held at once are bounded, and a full rate map or nonce cache
 * never stops a live app's owner renewing it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AppsErrorSchema } from "@tentacle/protocol";
import { DOMAIN, HTML, publisher, startHost, stopAll, until } from "./support/host.ts";
import { memoryStore } from "./support/memory-store.ts";
import { createPublisher } from "./support/publisher.ts";
import { closeUploads, openUpload } from "./support/upload.ts";

afterEach(async () => {
  closeUploads();
  await stopAll();
});

type Host = Awaited<ReturnType<typeof startHost>>;

const errorOf = async (response: Response) => AppsErrorSchema.parse(await response.json()).error;

/** Headers of a well-formed but unverifiable signed request. */
const bogus = (host: Host) =>
  publisher.headers({
    method: "POST",
    path: "/v1/apps",
    domain: "elsewhere.example.so",
    date: host.clock.at,
  });

/** An upload that declares `declared` bytes and sends only the first of them. */
async function hold(host: Host, declared: number | "chunked", ip?: string) {
  return openUpload(host.server.port, {
    path: "/v1/apps",
    headers: {
      host: DOMAIN,
      "content-type": "text/html",
      ...(ip === undefined ? {} : { "x-forwarded-for": ip }),
      ...(await bogus(host)),
    },
    declared,
    first: "<p>",
  });
}

/** Poll until a request answers `status` (throws after two seconds). */
async function untilStatus(status: number, send: () => Promise<Response>): Promise<Response> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const response = await send();
    if (response.status === status) {
      return response;
    }
    if (Date.now() > deadline) {
      throw new Error(`still ${response.status}, never ${status}`);
    }
    await response.arrayBuffer();
    await Bun.sleep(5);
  }
}

/** Polling must meet the body budget, never a rate limit. */
const unlimited = {
  apiPerMinutePerIp: 1_000_000,
  signedPerMinutePerKey: 1_000_000,
  publishesPerHourPerKey: 1_000_000,
  createsPerHourPerIp: 1_000_000,
  reportsPerHourPerIp: 1_000_000,
  maxLiveAppsPerKey: 1_000,
};
const small = {
  ...unlimited,
  maxAppBytes: 1000,
  maxInFlightBodyBytes: 1500,
  maxUploadsPerIp: 10,
};
const page = "x".repeat(600);

describe("request bodies held at once", () => {
  test("beyond the budget → 503 busy; a finished upload gives its share back", async () => {
    const host = await startHost({ limits: small });
    const held = await hold(host, 1000);
    const refused = await untilStatus(503, () => host.signed(publisher, "POST", "/v1/apps", page));
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect(await errorOf(refused)).toBe("busy");
    expect(host.memory.contents.size).toBe(0);
    // The held one was admitted: it is read to its end and judged.
    expect(await held.finish("y".repeat(997))).toBe(401);
    expect((await host.signed(publisher, "POST", "/v1/apps", page)).status).toBe(201);
  });

  test("a body keeps its share while it is being stored", async () => {
    const memory = memoryStore();
    const writing: (() => void)[] = [];
    const host = await startHost({
      limits: small,
      store: {
        ...memory.store,
        writeContent: async (id, sha256, bytes) => {
          await new Promise<void>((resolve) => writing.push(resolve));
          await memory.store.writeContent(id, sha256, bytes);
        },
      },
    });
    const first = host.signed(publisher, "POST", "/v1/apps", "x".repeat(1000));
    await until(() => writing.length === 1);
    const second = await host.signed(publisher, "POST", "/v1/apps", page);
    expect(await errorOf(second)).toBe("busy");
    writing[0]?.();
    expect((await first).status).toBe(201);
  });

  test("a body of unknown length is charged the largest an app may be", async () => {
    const host = await startHost({ limits: small });
    await hold(host, "chunked");
    await untilStatus(503, () => host.signed(publisher, "POST", "/v1/apps", page));
    // What still fits beside it is admitted.
    expect((await host.signed(publisher, "POST", "/v1/apps", "x".repeat(400))).status).toBe(201);
  });

  test("one address holds only so many at once; another is not affected", async () => {
    const host = await startHost({
      trustProxy: true,
      limits: { ...small, maxInFlightBodyBytes: 1_000_000, maxUploadsPerIp: 2 },
    });
    await hold(host, 100, "203.0.113.1");
    await hold(host, 100, "203.0.113.1");
    const from = (ip: string) => () =>
      host.signed(publisher, "POST", "/v1/apps", page, { "x-forwarded-for": ip });
    const refused = await untilStatus(429, from("203.0.113.1"));
    expect(await errorOf(refused)).toBe("rate_limited");
    expect((await from("203.0.113.2")()).status).toBe(201);
  });

  test("renew and delete hold no body: a full budget does not stop them", async () => {
    const host = await startHost({ limits: small });
    const id = await host.publish(publisher);
    await hold(host, 1000);
    await untilStatus(503, () => host.signed(publisher, "POST", "/v1/apps", page));
    expect((await host.signed(publisher, "POST", `/v1/apps/${id}/lease`)).status).toBe(200);
    expect((await host.signed(publisher, "DELETE", `/v1/apps/${id}`)).status).toBe(204);
  });

  test("a renew that declares a body is refused before any of it arrives", async () => {
    const host = await startHost();
    const upload = await openUpload(host.server.port, {
      path: `/v1/apps/${"a".repeat(16)}/lease`,
      headers: { host: DOMAIN, ...(await bogus(host)) },
      declared: 5_000_000,
      first: "x",
    });
    expect(await upload.status()).toBe(400);
  });

  test("a stalled upload is given up after the deadline and its share freed", async () => {
    const host = await startHost({ limits: { ...small, uploadTimeoutMs: 500 } });
    const held = await hold(host, 1000);
    expect(await held.status()).toBe(503);
    expect((await host.signed(publisher, "POST", "/v1/apps", page)).status).toBe(201);
  });

  test("an abandoned upload frees its share", async () => {
    const host = await startHost({ limits: small });
    const held = await hold(host, 1000);
    const send = () => host.signed(publisher, "POST", "/v1/apps", page);
    await untilStatus(503, send);
    held.abort();
    await untilStatus(201, send);
  });

  test("report bodies come out of the same budget, and are capped before reading", async () => {
    const host = await startHost({ limits: small });
    const id = await host.publish(publisher);
    const report = () =>
      host.call("/v1/report", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `app=${id}&reason=other&details=${"d".repeat(600)}`,
      });
    const held = await hold(host, 1000);
    // `hold` resolves once the bytes are sent, not once the server has charged
    // them: wait, with a request that stores nothing, until the budget is held.
    await untilStatus(503, () => host.signed(publisher, "POST", "/v1/apps", page));
    expect((await report()).status).toBe(503);
    expect(host.memory.reports).toHaveLength(0);
    held.abort();
    await untilStatus(303, report);
  });

  test("a report longer than a report may be: 413, declared or not", async () => {
    // The default app cap, far above a report's: only the host refuses these.
    const host = await startHost();
    const input = {
      path: "/v1/report",
      headers: { host: DOMAIN, "content-type": "application/x-www-form-urlencoded" },
    };
    const declared = await openUpload(host.server.port, {
      ...input,
      declared: 5_000_000,
      first: "app=",
    });
    expect(await declared.status()).toBe(413);
    const chunked = await openUpload(host.server.port, {
      ...input,
      declared: "chunked",
      first: "d".repeat(70_000),
    });
    expect(await chunked.status()).toBe(413);
  });

  test("a body sent in pieces arrives whole", async () => {
    const host = await startHost();
    const body = new TextEncoder().encode(HTML);
    for (const declared of [body.length, "chunked" as const]) {
      const upload = await openUpload(host.server.port, {
        path: "/v1/apps",
        headers: {
          host: DOMAIN,
          "content-type": "text/html",
          ...(await publisher.headers({
            method: "POST",
            path: "/v1/apps",
            domain: DOMAIN,
            date: host.clock.at,
            body,
          })),
        },
        declared,
        first: HTML.slice(0, 10),
      });
      await Bun.sleep(1);
      expect(await upload.finish(HTML.slice(10))).toBe(201);
    }
    expect([...host.memory.contents.values()].map((c) => new TextDecoder().decode(c))).toEqual([
      HTML,
      HTML,
    ]);
  });
});

describe("renewals under a flood", () => {
  test("a full address map: the owner of a live app still renews; nobody new publishes", async () => {
    const host = await startHost({ trustProxy: true, limits: { maxTrackedIps: 2 } });
    const from = (ip: string) => ({ "x-forwarded-for": ip });
    const created = await host.signed(publisher, "POST", "/v1/apps", HTML, from("198.51.100.1"));
    const { id } = (await created.json()) as { id: string };
    await host.call("/v1/apps", { method: "POST", headers: from("198.51.100.2") });
    const renew = (who = publisher) =>
      host.signed(who, "POST", `/v1/apps/${id}/lease`, undefined, from("198.51.100.3"));
    expect((await renew()).status).toBe(200);
    expect(await errorOf(await renew(await createPublisher()))).toBe("busy");
    const create = await host.signed(publisher, "POST", "/v1/apps", HTML, from("198.51.100.3"));
    expect(await errorOf(create)).toBe("busy");
  });

  test("a full key map: the owner of a live app still renews", async () => {
    const host = await startHost({ limits: { maxTrackedKeys: 1 } });
    const id = await host.publish(publisher);
    // Past the window the owner's entry is swept, and a stranger takes the room.
    host.advance(60_001);
    await host.server.sweep();
    const stranger = await createPublisher();
    await host.signed(stranger, "DELETE", `/v1/apps/${"a".repeat(16)}`);
    expect((await host.signed(publisher, "POST", `/v1/apps/${id}/lease`)).status).toBe(200);
    const other = await createPublisher();
    const refused = await host.signed(other, "DELETE", `/v1/apps/${id}`);
    expect(await errorOf(refused)).toBe("busy");
  });

  test("a full nonce cache: the owner still renews, and a replay is still refused", async () => {
    const host = await startHost({ limits: { maxTrackedNonces: 1 } });
    const id = await host.publish(publisher);
    const path = `/v1/apps/${id}/lease`;
    const headers = await publisher.headers({
      method: "POST",
      path,
      domain: DOMAIN,
      date: host.clock.at,
    });
    const send = () => host.call(path, { method: "POST", headers });
    expect((await send()).status).toBe(200);
    expect(await errorOf(await send())).toBe("replay");
    const create = await host.signed(publisher, "POST", "/v1/apps", HTML);
    expect(await errorOf(create)).toBe("busy");
  });
});
