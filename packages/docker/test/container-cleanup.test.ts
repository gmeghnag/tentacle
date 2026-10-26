import { describe, expect, test } from "bun:test";
import { DockerClient, OWNER_LABEL } from "../src/client.ts";
import {
  CONTAINER_DELETE_ID_ENV,
  CONTAINER_DELETE_TIMEOUT_MS,
  type ContainerDeleteSpawnOptions,
  DOCKER_ENDPOINT_ENV,
  containerDeleteCommand,
  deleteContainerFromEnv,
  spawnContainerDelete,
} from "../src/container-cleanup.ts";
import type { EngineEndpoint } from "../src/engine-endpoint.ts";
import { response, scriptedDialer, settle } from "./fake-duplex.ts";

const KEY = "-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----";
const tlsEndpoint: EngineEndpoint = {
  kind: "tcp",
  host: "engine.example",
  port: 2376,
  tls: { ca: "CA-PEM", cert: "CERT-PEM", key: KEY, dir: "/certs" },
  local: false,
  source: "DOCKER_HOST",
};

interface Spawned {
  readonly cmd: string[];
  readonly env: Record<string, string>;
  readonly options: ContainerDeleteSpawnOptions;
  unrefs: number;
}

function spySpawner() {
  const spawned: Spawned[] = [];
  const spawn = (
    cmd: string[],
    env: Record<string, string>,
    options: ContainerDeleteSpawnOptions,
  ) => {
    const s: Spawned = { cmd, env, options, unrefs: 0 };
    spawned.push(s);
    return {
      unref() {
        s.unrefs++;
      },
    };
  };
  return { spawned, spawn };
}

describe("spawnContainerDelete (the exit net)", () => {
  test("detached + stdio ignored + unref'd; id and endpoint (TLS key) in env only, never argv", () => {
    const { spawned, spawn } = spySpawner();
    spawnContainerDelete(tlsEndpoint, "tentacle-ab12", spawn, "/opt/tentacle");
    expect(spawned).toHaveLength(1);
    const s = spawned[0];
    if (!s) {
      throw new Error("no spawn");
    }
    expect(s.options).toEqual({ detached: true, stdio: ["ignore", "ignore", "ignore"] });
    expect(s.unrefs).toBe(1);
    expect(s.env[CONTAINER_DELETE_ID_ENV]).toBe("tentacle-ab12");
    expect(JSON.parse(s.env[DOCKER_ENDPOINT_ENV] ?? "")).toEqual(tlsEndpoint);
    // The parent env is carried (PATH for the child, SSH_AUTH_SOCK for ssh).
    expect(s.env.PATH).toBe(process.env.PATH as string);
    const argv = s.cmd.join(" ");
    expect(argv).not.toContain("SECRETKEYMATERIAL");
    expect(argv).not.toContain("CERT-PEM");
    expect(argv).not.toContain("tentacle-ab12");
    expect(argv).not.toContain("engine.example");
  });

  test("compiled binary → its own hidden __delete-container; from source → bun -e importing this module", () => {
    expect(containerDeleteCommand("/opt/tentacle")).toEqual([
      "/opt/tentacle",
      "__delete-container",
    ]);
    const source = containerDeleteCommand("/usr/local/bin/bun", "/repo/x/container-cleanup.ts");
    expect(source.slice(0, 2)).toEqual(["bun", "-e"]);
    expect(source[2]).toContain('await import("/repo/x/container-cleanup.ts")');
    expect(source[2]).toContain("deleteContainerFromEnv()");
    // The default module path is the real file (the child imports the real client).
    expect(containerDeleteCommand("bun")[2]).toContain("container-cleanup.ts");
  });

  test("a spawn failure is swallowed (the net must never break the exit)", () => {
    expect(() =>
      spawnContainerDelete(tlsEndpoint, "c", () => {
        throw new Error("ENOENT bun");
      }),
    ).not.toThrow();
  });
});

describe("deleteContainerFromEnv (the child's body)", () => {
  const env = (id: string, ep: EngineEndpoint | string = tlsEndpoint) => ({
    [CONTAINER_DELETE_ID_ENV]: id,
    [DOCKER_ENDPOINT_ENV]: typeof ep === "string" ? ep : JSON.stringify(ep),
  });

  test("parses the endpoint and removes the container, bounded", async () => {
    const seen: Array<{ ep: EngineEndpoint; id: string; timeoutMs?: number }> = [];
    await deleteContainerFromEnv(env("c1"), (ep) => ({
      removeContainer: async (id, options) => {
        seen.push({ ep, id, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
      },
    }));
    expect(seen).toEqual([{ ep: tlsEndpoint, id: "c1", timeoutMs: CONTAINER_DELETE_TIMEOUT_MS }]);
  });

  test("missing / malformed env → no client, no throw", async () => {
    let made = 0;
    const make = () => {
      made++;
      return { removeContainer: async () => {} };
    };
    await deleteContainerFromEnv({}, make);
    await deleteContainerFromEnv(env("c1", "{not json"), make);
    await deleteContainerFromEnv(env("c1", '{"kind":"ftp"}'), make);
    await deleteContainerFromEnv(env(""), make);
    expect(made).toBe(0);
  });

  test("a remove error (unreachable, refused, timed out) is swallowed", async () => {
    await expect(
      deleteContainerFromEnv(env("c1"), () => ({
        removeContainer: () => Promise.reject(new Error("unreachable")),
      })),
    ).resolves.toBeUndefined();
  });

  /** A real `DockerClient` over the scripted engine (API pinned: no _ping). */
  const realClient = () => {
    const engine = scriptedDialer();
    const client = new DockerClient({ dial: engine.dial, endpointLabel: "t", apiVersion: "1.52" });
    return { engine, make: () => client };
  };
  const inspect = (mine: boolean) =>
    response(
      200,
      JSON.stringify({ Id: "c1", Config: { Labels: mine ? { [OWNER_LABEL]: "true" } : {} } }),
    );

  test("with the real client: ownership inspect → SIGKILL → force delete", async () => {
    const { engine, make } = realClient();
    const done = deleteContainerFromEnv(env("c1"), make);
    const i = await engine.next();
    expect(i.req.method).toBe("GET");
    expect(i.req.path).toBe("/v1.52/containers/c1/json");
    i.duplex.receive(inspect(true));
    const k = await engine.next();
    expect(k.req.path).toBe("/v1.52/containers/c1/kill?signal=KILL");
    k.duplex.receive(response(204));
    const d = await engine.next();
    expect(d.req.method).toBe("DELETE");
    expect(d.req.path).toBe("/v1.52/containers/c1?force=true&v=true");
    d.duplex.receive(response(204));
    await done;
  });

  test("with the real client: a container WITHOUT the owner label is never killed or deleted", async () => {
    const { engine, make } = realClient();
    const done = deleteContainerFromEnv(env("users-db"), make);
    (await engine.next()).duplex.receive(inspect(false));
    await done; // the refusal is swallowed
    await settle();
    expect(engine.dials).toHaveLength(1);
  });
});
