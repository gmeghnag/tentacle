import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonErrorLogPath } from "../src/daemon-log.ts";
import { configuredModelProvider } from "../src/model-provider.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-model-provider-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Resets the first connection before any response byte, then serves one SSE reply. */
async function resetOnce(): Promise<{ readonly baseURL: string; readonly close: () => void }> {
  let connections = 0;
  const sse =
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const srv = createServer((socket) => {
    connections += 1;
    const first = connections === 1;
    socket.once("data", () => {
      if (first) {
        socket.resetAndDestroy();
        return;
      }
      socket.end(
        `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: ${Buffer.byteLength(sse)}\r\nconnection: close\r\n\r\n${sse}`,
      );
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { baseURL: `http://127.0.0.1:${port}/v1`, close: () => srv.close() };
}

describe("configuredModelProvider (every CLI construction site goes through it)", () => {
  test("a recovered connection drop leaves its line in the daemon log", async () => {
    // Mutation: drop `onRetry` from the helper → the turn still recovers, but
    // silently, and this log assertion fails.
    const endpoint = await resetOnce();
    try {
      const configDir = join(dir, "recovered");
      const provider = configuredModelProvider({
        provider: "openai",
        baseURL: endpoint.baseURL,
        model: "qwen",
        configDir,
      });
      let text = "";
      for await (const event of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
        if (event.type === "text") {
          text += event.delta;
        }
      }
      expect(text).toBe("ok");
      const log = await readFile(daemonErrorLogPath(configDir), "utf8");
      expect(log).toContain(
        "model retry 1/2 after ECONNRESET (no event delivered yet, openai:qwen), waiting ",
      );
    } finally {
      endpoint.close();
    }
  });

  test("a per-type model id replaces the configured one", () => {
    const base = { provider: "anthropic" as const, baseURL: "http://h/v1", model: "main" };
    expect(configuredModelProvider({ ...base, configDir: dir }).id).toBe("anthropic:main");
    expect(configuredModelProvider({ ...base, configDir: dir }, "small").id).toBe(
      "anthropic:small",
    );
  });
});
