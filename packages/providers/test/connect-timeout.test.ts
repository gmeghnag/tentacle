import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  ModelUnreachableError,
  type TcpProbe,
  createModelProvider,
  withConnectTimeout,
} from "../src/index.ts";

// A fetch that answers after `answerAfterMs` (never, when undefined) and, like
// Bun's, rejects at once with an AbortError when its signal aborts.
function fakeFetch(answerAfterMs?: number): {
  readonly fetch: typeof fetch;
  readonly calls: () => number;
} {
  let calls = 0;
  const fn = (_input: unknown, init?: RequestInit): Promise<Response> => {
    calls++;
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const abort = (): void => {
        clearTimeout(timer);
        reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
      };
      const timer =
        answerAfterMs === undefined
          ? undefined
          : setTimeout(() => {
              signal?.removeEventListener("abort", abort);
              resolve(new Response("data: [DONE]\n\n"));
            }, answerAfterMs);
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  };
  return { fetch: fn as unknown as typeof fetch, calls: () => calls };
}

interface ProbeSpy {
  readonly probe: TcpProbe;
  readonly seen: { host: string; port: number; signal: AbortSignal }[];
}

/** A probe that connects after `ms`, never (`"silent"`) or is refused (`"refused"`). */
function probeThat(behaviour: number | "silent" | "refused"): ProbeSpy {
  const seen: ProbeSpy["seen"] = [];
  const probe: TcpProbe = (host, port, signal) => {
    seen.push({ host, port, signal });
    if (behaviour === "refused") {
      return Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    }
    return new Promise<void>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (behaviour !== "silent") {
        setTimeout(resolve, behaviour);
      }
    });
  };
  return { probe, seen };
}

const NO_PROXY_ENV = {};
const URL_ = "http://192.168.1.17:8080/v1/chat/completions";

/** The outcome, or `{ error: "hung" }` after 2 s — so a missing timeout fails on an assertion. */
async function settle(p: Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<{ error: unknown }>((resolve) => {
    timer = setTimeout(() => resolve({ error: "hung" }), 2000);
  });
  try {
    return await Promise.race([p.then((value) => ({ value })), hung]);
  } catch (error) {
    return { error };
  } finally {
    clearTimeout(timer);
  }
}

describe("withConnectTimeout", () => {
  test("a host that never answers the connect fails after the timeout, naming host:port", async () => {
    const f = fakeFetch(undefined);
    const p = probeThat("silent");
    const wrapped = withConnectTimeout(f.fetch, {
      timeoutMs: 30,
      probe: p.probe,
      env: NO_PROXY_ENV,
    });
    const started = performance.now();
    const { error } = await settle(wrapped(URL_, { method: "POST" }));
    const elapsed = performance.now() - started;
    expect(error).toBeInstanceOf(ModelUnreachableError);
    expect((error as Error).message).toBe(
      "model unreachable: 192.168.1.17:8080 did not answer in 0.03s",
    );
    expect((error as { code?: unknown }).code).toBe("ECONNTIMEOUT");
    expect(elapsed).toBeLessThan(1000);
    expect(p.seen[0]?.signal.aborted).toBe(true);
  });

  test("once connected, a slow answer (headers after the timeout) is never cut", async () => {
    const f = fakeFetch(120);
    const p = probeThat(5);
    const wrapped = withConnectTimeout(f.fetch, {
      timeoutMs: 30,
      probe: p.probe,
      env: NO_PROXY_ENV,
    });
    const { value, error } = await settle(wrapped(URL_, { method: "POST" }));
    expect(error).toBeUndefined();
    expect(value).toBeInstanceOf(Response);
  });

  test("a refused probe leaves the fetch's own outcome alone (no timeout afterwards)", async () => {
    const f = fakeFetch(80);
    const p = probeThat("refused");
    const wrapped = withConnectTimeout(f.fetch, {
      timeoutMs: 30,
      probe: p.probe,
      env: NO_PROXY_ENV,
    });
    const { value, error } = await settle(wrapped(URL_, { method: "POST" }));
    expect(error).toBeUndefined();
    expect(value).toBeInstanceOf(Response);
  });

  test("a cancel during the connect wait aborts at once, as a cancel", async () => {
    const f = fakeFetch(undefined);
    const p = probeThat("silent");
    const wrapped = withConnectTimeout(f.fetch, {
      timeoutMs: 5000,
      probe: p.probe,
      env: NO_PROXY_ENV,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const started = performance.now();
    const { error } = await settle(wrapped(URL_, { method: "POST", signal: controller.signal }));
    expect(performance.now() - started).toBeLessThan(1000);
    expect((error as Error).name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(ModelUnreachableError);
    expect(p.seen[0]?.signal.aborted).toBe(true);
  });

  test("with a proxy configured there is no probe and no timeout", async () => {
    for (const key of ["HTTPS_PROXY", "http_proxy", "ALL_PROXY"]) {
      const f = fakeFetch(80);
      const p = probeThat("silent");
      const wrapped = withConnectTimeout(f.fetch, {
        timeoutMs: 30,
        probe: p.probe,
        env: { [key]: "http://proxy:3128" },
      });
      const { error } = await settle(wrapped(URL_, { method: "POST" }));
      expect(error).toBeUndefined();
      expect(p.seen).toEqual([]);
    }
  });

  test("the probe dials the URL's host and port (https default 443, IPv6 unbracketed)", async () => {
    const p = probeThat(0);
    const wrapped = withConnectTimeout(fakeFetch(0).fetch, {
      timeoutMs: 1000,
      probe: p.probe,
      env: NO_PROXY_ENV,
    });
    await wrapped("https://api.example.com/v1/messages", { method: "POST" });
    await wrapped("http://[::1]:8080/v1/chat/completions", { method: "POST" });
    await wrapped("http://localhost/v1/chat/completions", { method: "POST" });
    expect(p.seen.map((s) => `${s.host}|${s.port}`)).toEqual([
      "api.example.com|443",
      "::1|8080",
      "localhost|80",
    ]);
  });
});

describe("withConnectTimeout — real fetch and probe on loopback", () => {
  test("a server that accepts but holds its headers past the timeout is not cut", async () => {
    const srv = createServer((socket) => {
      socket.once("data", () => {
        setTimeout(
          () => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"),
          300,
        );
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const address = srv.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const wrapped = withConnectTimeout(fetch, { timeoutMs: 50, env: NO_PROXY_ENV });
      const { value, error } = await settle(
        wrapped(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: "{}" }),
      );
      expect(error).toBeUndefined();
      expect(await (value as Response).text()).toBe("ok");
    } finally {
      srv.close();
    }
  });
});

describe("createModelProvider — connect timeout", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    test(`${provider}: an unreachable endpoint fails once with the cause, not retried`, async () => {
      const f = fakeFetch(undefined);
      const p = probeThat("silent");
      const model = createModelProvider({
        provider,
        baseURL: "http://192.168.1.17:8080/v1",
        model: "m",
        fetch: f.fetch,
        connectProbe: p.probe,
        connectTimeoutMs: 20,
      });
      const { error: failure } = await settle(
        (async () => {
          for await (const _ of model.stream({ messages: [{ role: "user", content: "ciao" }] })) {
            // drain
          }
        })(),
      );
      expect(failure).toBeInstanceOf(ModelUnreachableError);
      expect((failure as Error).message).toContain("192.168.1.17:8080 did not answer");
      expect(f.calls()).toBe(1);
    });
  }
});
