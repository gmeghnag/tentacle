import { describe, expect, test } from "bun:test";
import type { Dialer } from "../src/byte-duplex.ts";
import { DockerClient, OWNER_LABEL, negotiateApiVersion, splitImageRef } from "../src/client.ts";
import { DockerApiError, request } from "../src/http-conn.ts";
import { response, scriptedDialer } from "./fake-duplex.ts";

const ping = (api: string) => response(200, "", { "Api-Version": api, OSType: "linux" });

/** An inspect answer, with or without tentacle's ownership label. */
const owned = (id: string, mine: boolean) =>
  response(
    200,
    JSON.stringify({
      Id: id,
      Config: { Labels: mine ? { [OWNER_LABEL]: "true" } : { app: "db" } },
    }),
  );

function client(apiVersion?: string) {
  const engine = scriptedDialer();
  const docker = new DockerClient({
    dial: engine.dial,
    endpointLabel: "test-engine",
    ...(apiVersion ? { apiVersion } : {}),
  });
  return { engine, docker };
}

/** Answer the `_ping` negotiation with `api`. */
async function negotiate(engine: ReturnType<typeof scriptedDialer>, api = "1.52"): Promise<void> {
  const { duplex, req } = await engine.next();
  expect(req.path).toBe("/_ping");
  duplex.receive(ping(api));
}

describe("API version negotiation", () => {
  test("min(engine, 1.52), refused below 1.41", () => {
    expect(negotiateApiVersion("1.52", "e")).toBe("1.52");
    expect(negotiateApiVersion("1.41", "e")).toBe("1.41");
    expect(negotiateApiVersion("1.60", "e")).toBe("1.52");
    expect(() => negotiateApiVersion("1.40", "e")).toThrow(
      "Docker engine API 1.40 at e is older than tentacle supports (≥ 1.41) — upgrade the engine",
    );
    expect(() => negotiateApiVersion(undefined, "e")).toThrow(
      "did not report a usable API version",
    );
  });

  test("paths use the negotiated version; _ping happens once per client", async () => {
    const { engine, docker } = client();
    const first = docker.inspectContainer("c1");
    await negotiate(engine, "1.45");
    const a = await engine.next();
    expect(a.req.path).toBe("/v1.45/containers/c1/json");
    a.duplex.receive(response(200, '{"Id":"c1"}'));
    await first;
    const second = docker.inspectContainer("c2");
    const b = await engine.next();
    expect(b.req.path).toBe("/v1.45/containers/c2/json"); // no second _ping
    b.duplex.receive(response(200, '{"Id":"c2"}'));
    expect((await second).Id).toBe("c2");
    expect(engine.dials).toHaveLength(3);
  });

  test("an engine minimum above ours → 'needs a newer tentacle'", async () => {
    const { engine, docker } = client("1.52");
    const v = docker.version();
    const { duplex } = await engine.next();
    duplex.receive(
      response(
        400,
        '{"message":"client version 1.52 is too old. Minimum supported API version is 1.60"}',
      ),
    );
    await expect(v).rejects.toThrow("this engine needs a newer tentacle");
  });
});

describe("container verbs", () => {
  test("create: the tentacle ownership label is always set (merged with the caller's)", async () => {
    const { engine, docker } = client("1.52");
    const created = docker.createContainer("t", { Image: "busybox", Labels: { a: "b" } });
    const { duplex, req } = await engine.next();
    expect(JSON.parse(req.body).Labels).toEqual({ a: "b", [OWNER_LABEL]: "true" });
    duplex.receive(response(201, '{"Id":"t"}'));
    await created;
  });

  test("remove: refuses a container tentacle did not create (no kill, no delete)", async () => {
    const { engine, docker } = client("1.52");
    const theirs = docker.removeContainer("users-db");
    const inspect = await engine.next();
    expect(inspect.req.path).toBe("/v1.52/containers/users-db/json");
    inspect.duplex.receive(owned("users-db", false));
    await expect(theirs).rejects.toThrow(
      `refusing to remove container "users-db": it was not created by tentacle (no ${OWNER_LABEL}=true label)`,
    );
    expect(engine.dials).toHaveLength(1);
  });

  test("remove: SIGKILL first (no stop grace), then force + anonymous volumes", async () => {
    // Podman's force-remove stops with the container's stop timeout (10 s for a
    // PID 1 that ignores SIGTERM, like `sleep`); killing first makes the delete
    // immediate on both engines.
    const { engine, docker } = client("1.52");
    const done = docker.removeContainer("c");
    (await engine.next()).duplex.receive(owned("c", true));
    const kill = await engine.next();
    expect(kill.req.method).toBe("POST");
    expect(kill.req.path).toBe("/v1.52/containers/c/kill?signal=KILL");
    kill.duplex.receive(response(204));
    const del = await engine.next();
    expect(del.req.method).toBe("DELETE");
    expect(del.req.path).toBe("/v1.52/containers/c?force=true&v=true");
    del.duplex.receive(response(204));
    await done;
  });

  test("remove: a refused kill (already stopped: Docker 409 / Podman 500) still deletes; 404 is success", async () => {
    const { engine, docker } = client("1.52");
    const stopped = docker.removeContainer("s");
    (await engine.next()).duplex.receive(owned("s", true));
    (await engine.next()).duplex.receive(response(500, '{"message":"container state improper"}'));
    (await engine.next()).duplex.receive(response(204));
    await stopped;

    // Already gone: the ownership inspect's 404 ends it (idempotent), nothing else is sent.
    const before = engine.dials.length;
    const gone = docker.removeContainer("gone");
    (await engine.next()).duplex.receive(response(404, '{"message":"No such container: gone"}'));
    await gone;
    expect(engine.dials.length - before).toBe(1);
  });

  /** Reject within `ms`, or fail the test (a hang is a failure, not a wait). */
  async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`STILL PENDING after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, guard]);
    } finally {
      clearTimeout(timer);
    }
  }

  test("remove is bounded: an engine that never answers a request → rejects within timeoutMs", async () => {
    const { engine, docker } = client("1.52");
    const hung = docker.removeContainer("h", { timeoutMs: 30 });
    await engine.next(); // the ownership inspect: never answered
    await expect(settlesWithin(hung, 400)).rejects.toThrow(
      'removing container "h" timed out after 30ms',
    );
  });

  test("remove's budget covers the first _ping negotiation (Review F1)", async () => {
    const { engine, docker } = client(); // not negotiated yet
    const hung = docker.removeContainer("c", { timeoutMs: 50 });
    await engine.next(); // the _ping: never answered
    await expect(settlesWithin(hung, 400)).rejects.toThrow(
      'removing container "c" timed out after 50ms',
    );
  });

  test("remove's budget covers a connect that never completes (Review F1)", async () => {
    // A dialer that hangs until its signal aborts (a dead TCP peer / ssh handshake).
    let dials = 0;
    const docker = new DockerClient({
      dial: (signal) => {
        dials++;
        return new Promise((_, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            {
              once: true,
            },
          ),
        );
      },
      endpointLabel: "stalled",
      apiVersion: "1.52",
    });
    const hung = docker.removeContainer("c", { timeoutMs: 50 });
    await expect(settlesWithin(hung, 400)).rejects.toThrow(
      'removing container "c" timed out after 50ms',
    );
    expect(dials).toBe(1);
  });

  test("a request's own timeout covers its connect (http-conn `request`)", async () => {
    const stalled: Dialer = (signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        }),
      );
    const pending = request(stalled, { method: "GET", path: "/_ping" }, { timeoutMs: 30 });
    await expect(settlesWithin(pending, 400)).rejects.toThrow(
      "Docker API GET /_ping timed out after 30ms",
    );
  });

  test("start: 304 (already running) is ok; 500 carries the engine message", async () => {
    const { engine, docker } = client("1.52");
    const ok = docker.startContainer("c");
    (await engine.next()).duplex.receive(response(304));
    await ok;
    const bad = docker.startContainer("c");
    (await engine.next()).duplex.receive(
      response(500, '{"message":"cannot start: port is already allocated"}'),
    );
    const err = await bad.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DockerApiError);
    expect((err as DockerApiError).status).toBe(500);
    expect((err as DockerApiError).engineMessage).toBe("cannot start: port is already allocated");
  });

  test("create: name in the query, body passed through, id returned; unknown image → actionable", async () => {
    const { engine, docker } = client("1.52");
    const created = docker.createContainer("tentacle-x", { Image: "busybox", Labels: { a: "b" } });
    const { duplex, req } = await engine.next();
    expect(req.path).toBe("/v1.52/containers/create?name=tentacle-x");
    expect(JSON.parse(req.body)).toEqual({
      Image: "busybox",
      Labels: { a: "b", [OWNER_LABEL]: "true" },
    });
    duplex.receive(response(201, '{"Id":"abc","Warnings":[]}'));
    expect(await created).toEqual({ id: "abc", warnings: [] });

    const missing = docker.createContainer("y", { Image: "nope" });
    (await engine.next()).duplex.receive(response(404, '{"message":"No such image: nope:latest"}'));
    await expect(missing).rejects.toThrow(
      "No such image: nope:latest — pull the image or check its name",
    );
  });

  test("waitForRunning: running → resolves; exited → rejects with the code; timeout", async () => {
    const { engine, docker } = client("1.52");
    const running = docker.waitForRunning("c", { intervalMs: 1 });
    (await engine.next()).duplex.receive(
      response(200, '{"Id":"c","State":{"Status":"created","Running":false}}'),
    );
    (await engine.next()).duplex.receive(
      response(200, '{"Id":"c","State":{"Status":"running","Running":true}}'),
    );
    expect((await running).State?.Running).toBe(true);

    const exited = docker.waitForRunning("c", { intervalMs: 1 });
    (await engine.next()).duplex.receive(
      response(200, '{"Id":"c","State":{"Status":"exited","Running":false,"ExitCode":3}}'),
    );
    await expect(exited).rejects.toThrow("container c exited with code 3 before running");

    const slow = docker.waitForRunning("c", { intervalMs: 50, timeoutMs: 10 });
    (await engine.next()).duplex.receive(
      response(200, '{"Id":"c","State":{"Status":"created","Running":false}}'),
    );
    await expect(slow).rejects.toThrow("container c was not running within 10ms (state created)");
  });

  test("waitForRunning leaves no abort listener behind on a long-lived signal (Review F4)", async () => {
    const { engine, docker } = client("1.52");
    const ac = new AbortController();
    let live = 0;
    const add = ac.signal.addEventListener.bind(ac.signal);
    const remove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((type: string, fn: () => void, opts?: unknown) => {
      if (type === "abort") {
        live++;
      }
      add(type, fn, opts as AddEventListenerOptions);
    }) as typeof ac.signal.addEventListener;
    ac.signal.removeEventListener = ((type: string, fn: () => void) => {
      if (type === "abort") {
        live--;
      }
      remove(type, fn);
    }) as typeof ac.signal.removeEventListener;
    const running = docker.waitForRunning("c", { intervalMs: 1, signal: ac.signal });
    for (let i = 0; i < 3; i++) {
      (await engine.next()).duplex.receive(
        response(200, '{"Id":"c","State":{"Status":"created","Running":false}}'),
      );
    }
    (await engine.next()).duplex.receive(
      response(200, '{"Id":"c","State":{"Status":"running","Running":true}}'),
    );
    await running;
    expect(live).toBe(0);
  });

  test("pullImage: tag defaults to latest (never pull every tag); an error line rejects", async () => {
    expect(splitImageRef("busybox")).toEqual({ fromImage: "busybox", tag: "latest" });
    expect(splitImageRef("localhost:5000/a/b:1.2")).toEqual({
      fromImage: "localhost:5000/a/b",
      tag: "1.2",
    });
    expect(splitImageRef("localhost:5000/a/b")).toEqual({
      fromImage: "localhost:5000/a/b",
      tag: "latest",
    });
    expect(splitImageRef("busybox@sha256:abc")).toEqual({ fromImage: "busybox@sha256:abc" });

    const { engine, docker } = client("1.52");
    const ok = docker.pullImage("busybox");
    const a = await engine.next();
    expect(a.req.path).toBe("/v1.52/images/create?fromImage=busybox&tag=latest");
    a.duplex.receive(response(200, '{"status":"Pulling"}\n{"status":"Done"}\n'));
    await ok;

    const bad = docker.pullImage("nope/nope:1");
    (await engine.next()).duplex.receive(
      response(
        200,
        '{"status":"Pulling"}\n{"errorDetail":{"message":"denied"},"error":"pull access denied for nope/nope"}\n',
      ),
    );
    await expect(bad).rejects.toThrow("cannot pull nope/nope:1: pull access denied for nope/nope");
  });
});

describe("one code path for every transport", () => {
  /** The same client script, driven over a given dialer; returns every request's raw bytes. */
  async function script(label: string): Promise<string[]> {
    const engine = scriptedDialer();
    const docker = new DockerClient({ dial: engine.dial, endpointLabel: label });
    const flow = (async () => {
      await docker.createContainer("n", { Image: "busybox" });
      await docker.startContainer("n");
      await docker.inspectContainer("n");
      await docker.removeContainer("n");
    })();
    await negotiate(engine);
    const replies = [
      response(201, '{"Id":"n"}'),
      response(204),
      response(200, '{"Id":"n"}'),
      owned("n", true), // remove: ownership inspect
      response(204), // kill
      response(204), // delete
    ];
    for (const reply of replies) {
      (await engine.next()).duplex.receive(reply);
    }
    await flow;
    return engine.dials.map((d) => d.text());
  }

  test("a 'unix' dialer and an 'ssh-stdio' dialer get byte-identical requests", async () => {
    const unix = await script('context "desktop-linux" (unix:///x.sock)');
    const ssh = await script('context "remote" (ssh://u@h)');
    expect(unix).toHaveLength(7);
    expect(ssh).toEqual(unix);
  });
});
