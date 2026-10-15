import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KubeApiError, KubeClient } from "../src/client.ts";
import { type Pod, podIsReady } from "../src/types.ts";

// A mock API server that models the `/api/v1/namespaces/<ns>/pods` subset the
// client uses. Pods are kept in a map; a pod can be scripted to flip to Ready
// after N reads, so `waitForReady` polling is exercised for real.

interface MockPod {
  pod: Pod;
  /** Reads remaining before the pod reports Running+Ready (0 = already ready). */
  readsUntilReady: number;
  reads: number;
}

const NS = "dev";
const pods = new Map<string, MockPod>();
let lastAuth: string | null = null;
let server: ReturnType<typeof Bun.serve>;

function podKey(name: string): string {
  return `${NS}/${name}`;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      lastAuth = req.headers.get("authorization");
      const url = new URL(req.url);
      const prefix = `/api/v1/namespaces/${NS}/pods`;
      // Collection: POST creates.
      if (url.pathname === prefix && req.method === "POST") {
        const body = (await req.json()) as Pod;
        const name = body.metadata?.name ?? "unnamed";
        const scripted = (body.metadata?.annotations?.["test/readsUntilReady"] ?? "0") as string;
        const created: Pod = {
          ...body,
          metadata: { ...body.metadata, uid: "uid-123" },
          status: { phase: "Pending" },
        };
        pods.set(podKey(name), {
          pod: created,
          readsUntilReady: Number(scripted),
          reads: 0,
        });
        return Response.json(created, { status: 201 });
      }
      // Item: GET / DELETE on /pods/<name>.
      if (url.pathname.startsWith(`${prefix}/`)) {
        const name = decodeURIComponent(url.pathname.slice(prefix.length + 1));
        const entry = pods.get(podKey(name));
        if (req.method === "GET") {
          if (!entry) {
            return Response.json({ kind: "Status", code: 404 }, { status: 404 });
          }
          entry.reads += 1;
          const ready = entry.reads > entry.readsUntilReady;
          entry.pod = {
            ...entry.pod,
            status: ready
              ? { phase: "Running", conditions: [{ type: "Ready", status: "True" }] }
              : { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] },
          };
          return Response.json(entry.pod, { status: 200 });
        }
        if (req.method === "DELETE") {
          if (!entry) {
            return Response.json({ kind: "Status", code: 404 }, { status: 404 });
          }
          pods.delete(podKey(name));
          return Response.json({ kind: "Status", status: "Success" }, { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => server.stop(true));

function client(token?: string): KubeClient {
  return new KubeClient({
    server: `http://localhost:${server.port}`,
    namespace: NS,
    ...(token ? { token } : {}),
  });
}

describe("KubeClient", () => {
  test("creates a pod and sends the bearer token", async () => {
    const created = await client("secret-token").createPod({
      metadata: { name: "p1", namespace: NS },
      spec: {},
    });
    expect(created.metadata?.uid).toBe("uid-123");
    expect(created.status?.phase).toBe("Pending");
    expect(lastAuth).toBe("Bearer secret-token");
  });

  test("getPod returns the current state; a missing pod is a KubeApiError(404)", async () => {
    const c = client();
    await c.createPod({
      metadata: { name: "p2", annotations: { "test/readsUntilReady": "1" } },
      spec: {},
    });
    const got = await c.getPod("p2");
    expect(got.metadata?.name).toBe("p2");
    expect(podIsReady(got)).toBe(false); // first read: not ready yet

    await expect(c.getPod("does-not-exist")).rejects.toBeInstanceOf(KubeApiError);
  });

  test("waitForReady polls until the pod reports Running+Ready", async () => {
    const c = client();
    // Becomes ready on the 3rd read.
    await c.createPod({
      metadata: { name: "p3", annotations: { "test/readsUntilReady": "2" } },
      spec: {},
    });
    const ready = await c.waitForReady("p3", { intervalMs: 5, timeoutMs: 1000 });
    expect(podIsReady(ready)).toBe(true);
    expect(ready.status?.phase).toBe("Running");
  });

  test("waitForReady rejects when the deadline passes without readiness", async () => {
    const c = client();
    // Never becomes ready within the budget.
    await c.createPod({
      metadata: { name: "p4", annotations: { "test/readsUntilReady": "9999" } },
      spec: {},
    });
    await expect(c.waitForReady("p4", { intervalMs: 5, timeoutMs: 30 })).rejects.toThrow(
      /did not become ready/,
    );
  });

  test("deletePod removes the pod and is idempotent on a 404", async () => {
    const c = client();
    await c.createPod({ metadata: { name: "p5" }, spec: {} });
    await c.deletePod("p5");
    await expect(c.getPod("p5")).rejects.toBeInstanceOf(KubeApiError);
    // Deleting again (already gone) does not throw.
    await c.deletePod("p5");
  });

  test("runExec builds the exec URL + subprotocols and resolves on command exit", async () => {
    // A minimal in-memory exec socket: records the URL/protocols it was built
    // with, then (after `open`) reports a Success status so `runExec` resolves.
    let seenUrl = "";
    let seenProtocols: string[] = [];
    const listeners = new Map<string, Array<(ev: { data: unknown }) => void>>();
    const emit = (type: string, ev: { data: unknown }): void => {
      for (const h of listeners.get(type) ?? []) {
        h(ev);
      }
    };
    const fakeWs = {
      binaryType: "",
      readyState: 0,
      sent: [] as Uint8Array[],
      send(data: Uint8Array) {
        this.sent.push(data);
      },
      close() {},
      addEventListener(type: string, handler: (ev: { data: unknown }) => void) {
        const arr = listeners.get(type) ?? [];
        arr.push(handler);
        listeners.set(type, arr);
      },
      open() {
        this.readyState = 1;
        emit("open", { data: null });
      },
      /** Deliver a channel-framed inbound message. */
      receive(channel: number, text: string) {
        const body = new TextEncoder().encode(text);
        const out = new Uint8Array(body.length + 1);
        out[0] = channel;
        out.set(body, 1);
        emit("message", { data: out });
      },
    };
    const c = new KubeClient({
      server: `http://localhost:${server.port}`,
      namespace: NS,
      token: "secret-token",
      makeWebSocket: (url, protocols) => {
        seenUrl = url;
        seenProtocols = protocols;
        return fakeWs;
      },
    });

    const promise = c.runExec({ pod: "p6", command: ["uname", "-m"] });
    expect(
      seenUrl.startsWith(`ws://localhost:${server.port}/api/v1/namespaces/${NS}/pods/p6/exec?`),
    ).toBe(true);
    expect(seenUrl).toContain("command=uname");
    expect(seenUrl).toContain("command=-m");
    expect(seenProtocols[0]).toBe("v4.channel.k8s.io");
    expect(seenProtocols[1]).toMatch(/^base64url\.bearer\.authorization\.k8s\.io\./);

    fakeWs.open();
    fakeWs.receive(1, "x86_64\n");
    fakeWs.receive(3, '{"status":"Success"}');
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("x86_64\n");
  });
});
