import { describe, expect, test } from "bun:test";
import {
  type PodDeleteOptions,
  type PodDeleteSpawnOptions,
  buildPodDeleteScript,
  deletePodFromEnv,
  podDeleteCommand,
  spawnPodDelete,
} from "../src/pod-cleanup.ts";

interface SpawnCall {
  cmd: string[];
  env: Record<string, string>;
  options: PodDeleteSpawnOptions;
}

/** A fake spawner that records the call and returns a fake child. */
function fakeSpawner() {
  const calls: SpawnCall[] = [];
  const unrefs: number[] = [];
  const spawner = (
    cmd: string[],
    env: Record<string, string>,
    options: PodDeleteSpawnOptions,
  ): { unref(): void } => {
    calls.push({ cmd, env, options });
    return {
      unref: () => {
        unrefs.push(1);
      },
    };
  };
  return { calls, unrefs, spawner };
}

describe("buildPodDeleteScript", () => {
  test("issues a DELETE with a timeout and never throws", () => {
    const script = buildPodDeleteScript();
    expect(script).toContain('method: "DELETE"');
    expect(script).toContain("AbortSignal.timeout(5000)");
    expect(script).toContain("TENTACLE_POD_DELETE_URL");
    expect(script).toContain("TENTACLE_POD_DELETE_TOKEN");
    expect(script).toContain("TENTACLE_POD_TLS_CA");
    expect(script).toContain(".catch(() => {})");
    expect(script).toContain("process.exit(0)");
    // No secrets are inlined in the script (they come from env): the only
    // "Bearer" occurrence is the static prefix `"Bearer " + token`, never a
    // literal token value.
    expect(script).not.toMatch(/Bearer [A-Za-z0-9]/);
  });
});

describe("spawnPodDelete", () => {
  test("spawns a detached bun -e child with the pod URL in env", () => {
    const { calls, unrefs, spawner } = fakeSpawner();
    spawnPodDelete(
      { server: "https://api.cluster:6443", namespace: "dev", podName: "p-1" },
      spawner,
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) {
      throw new Error("no spawn call");
    }
    expect(call.cmd[0]).toBe("bun");
    expect(call.cmd[1]).toBe("-e");
    expect(call.cmd[2]).toBe(buildPodDeleteScript());
    expect(call.options.detached).toBe(true);
    expect(call.options.stdio).toEqual(["ignore", "ignore", "ignore"]);
    expect(unrefs).toHaveLength(1); // the child is unref'd (never blocks exit)
    expect(call.env.TENTACLE_POD_DELETE_URL).toBe(
      "https://api.cluster:6443/api/v1/namespaces/dev/pods/p-1",
    );
  });

  test("passes the bearer token and TLS material via env", () => {
    const { calls, spawner } = fakeSpawner();
    const options: PodDeleteOptions = {
      server: "https://api.cluster:6443/",
      namespace: "ns/x",
      podName: "pod y",
      token: "secret-token",
      tls: { ca: "CA-PEM", cert: "CERT-PEM", key: "KEY-PEM", rejectUnauthorized: false },
    };
    spawnPodDelete(options, spawner);
    const call = calls[0];
    if (!call) {
      throw new Error("no spawn call");
    }
    // Names are URL-encoded; the trailing slash is stripped.
    expect(call.env.TENTACLE_POD_DELETE_URL).toBe(
      "https://api.cluster:6443/api/v1/namespaces/ns%2Fx/pods/pod%20y",
    );
    expect(call.env.TENTACLE_POD_DELETE_TOKEN).toBe("secret-token");
    expect(call.env.TENTACLE_POD_TLS_CA).toBe("CA-PEM");
    expect(call.env.TENTACLE_POD_TLS_CERT).toBe("CERT-PEM");
    expect(call.env.TENTACLE_POD_TLS_KEY).toBe("KEY-PEM");
    expect(call.env.TENTACLE_POD_TLS_INSECURE).toBe("1");
  });

  test("omits token/TLS env when absent", () => {
    const { calls, spawner } = fakeSpawner();
    spawnPodDelete({ server: "http://localhost:8080", namespace: "ns", podName: "p" }, spawner);
    const call = calls[0];
    if (!call) {
      throw new Error("no spawn call");
    }
    expect(call.env.TENTACLE_POD_DELETE_TOKEN).toBeUndefined();
    expect(call.env.TENTACLE_POD_TLS_CA).toBeUndefined();
    expect(call.env.TENTACLE_POD_TLS_INSECURE).toBeUndefined();
    // The parent's PATH is carried over (the child needs to find `bun`).
    expect(call.env.PATH).toBeDefined();
  });

  test("a spawn failure is swallowed (best-effort, must not break the exit)", () => {
    const throwing = (): { unref(): void } => {
      throw new Error("spawn failed");
    };
    expect(() =>
      spawnPodDelete({ server: "http://x", namespace: "n", podName: "p" }, throwing),
    ).not.toThrow();
  });
});

describe("podDeleteCommand", () => {
  test("from `bun` (source) → `bun -e <script>`", () => {
    expect(podDeleteCommand("/opt/homebrew/bin/bun")).toEqual([
      "bun",
      "-e",
      buildPodDeleteScript(),
    ]);
    // A versioned/debug bun basename still counts as bun.
    expect(podDeleteCommand("/usr/local/bin/bun-debug")[0]).toBe("bun");
  });

  test("from a compiled binary → re-exec THE SAME binary with `__delete-pod` (no external bun)", () => {
    const exe = "/Users/me/tentacle/dist/tentacle";
    expect(podDeleteCommand(exe)).toEqual([exe, "__delete-pod"]);
    // Crucially the deleter is the binary itself — not a hardcoded `bun`.
    expect(podDeleteCommand(exe)[0]).not.toBe("bun");
  });
});

describe("deletePodFromEnv", () => {
  const KEYS = [
    "TENTACLE_POD_DELETE_URL",
    "TENTACLE_POD_DELETE_TOKEN",
    "TENTACLE_POD_TLS_CA",
    "TENTACLE_POD_TLS_CERT",
    "TENTACLE_POD_TLS_KEY",
    "TENTACLE_POD_TLS_INSECURE",
  ];
  const withEnv = async (
    env: Record<string, string>,
    fn: (
      fetchCalls: Array<{ url: string; init: RequestInit & { tls?: unknown } }>,
    ) => Promise<void>,
  ): Promise<void> => {
    const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) {
      delete process.env[k];
    }
    Object.assign(process.env, env);
    const fetchCalls: Array<{ url: string; init: RequestInit & { tls?: unknown } }> = [];
    const fakeFetch = (async (url: unknown, init: unknown) => {
      fetchCalls.push({ url: String(url), init: (init ?? {}) as RequestInit & { tls?: unknown } });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await deletePodFromEnv(fakeFetch);
      await fn(fetchCalls);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  };

  test("issues a DELETE to the URL with bearer + TLS from the env", async () => {
    await withEnv(
      {
        TENTACLE_POD_DELETE_URL: "https://api:6443/api/v1/namespaces/dev/pods/p-1",
        TENTACLE_POD_DELETE_TOKEN: "tok",
        TENTACLE_POD_TLS_CA: "CA",
        TENTACLE_POD_TLS_CERT: "CERT",
        TENTACLE_POD_TLS_KEY: "KEY",
        TENTACLE_POD_TLS_INSECURE: "1",
      },
      async (calls) => {
        expect(calls).toHaveLength(1);
        const { url, init } = calls[0] as (typeof calls)[number];
        expect(url).toBe("https://api:6443/api/v1/namespaces/dev/pods/p-1");
        expect(init.method).toBe("DELETE");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
        expect(init.tls).toEqual({ ca: "CA", cert: "CERT", key: "KEY", rejectUnauthorized: false });
      },
    );
  });

  test("no URL → no fetch at all (nothing to delete)", async () => {
    await withEnv({}, async (calls) => {
      expect(calls).toHaveLength(0);
    });
  });

  test("a fetch error is swallowed (best-effort, never throws)", async () => {
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const key = "TENTACLE_POD_DELETE_URL";
    const saved = process.env[key];
    process.env[key] = "https://api/pods/p";
    try {
      await expect(deletePodFromEnv(boom)).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
  });
});
