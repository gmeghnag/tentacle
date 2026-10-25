import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { WorkerBootstrap } from "../src/worker-bootstrap.ts";

// `worker.ts` is a SECOND compile entrypoint (pod-binary-build.ts), so anything
// it reaches that reads the `__TENTACLE_VERSION_MARKER__` define (version.ts)
// inlines a second marker into the binary, and scripts/build.ts rejects it
// ("exactly one marker"). The worker gets its version from the main thread.

const SRC = resolve(import.meta.dir, "../src");

/** Every cli/src file statically reachable from `entry` by relative imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const visit = (file: string): void => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    for (const imp of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (imp.path.startsWith(".")) {
        const target = resolve(dirname(file), imp.path);
        if (existsSync(target)) {
          visit(target);
        }
      }
    }
  };
  visit(entry);
  return seen;
}

describe("worker.ts and the version marker", () => {
  test("worker.ts never reaches version.ts (its marker would be inlined twice)", () => {
    const files = [...reachable(join(SRC, "worker.ts"))].map((f) => f.slice(SRC.length + 1));
    expect(files).toContain("worker.ts"); // the walk actually ran
    expect(files).not.toContain("version.ts");
  });

  test("the worker reports the version the main thread gave it", async () => {
    const config = await loadConfig({ cwd: process.cwd() });
    const worker = new Worker(new URL("../src/worker.ts", import.meta.url).href, {
      type: "module",
    });
    try {
      const reply = new Promise<string>((res) => {
        worker.addEventListener("message", (event: MessageEvent) => {
          if (typeof event.data === "string") {
            res(event.data);
          }
        });
      });
      worker.postMessage({ config, version: "9.8.7" } satisfies WorkerBootstrap);
      // A protocol-version skew makes the daemon name itself in the error data.
      worker.postMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: -1, clientCapabilities: {} },
        }),
      );
      const frame = JSON.parse(await reply) as {
        error?: { data?: { daemon?: { identity?: { tentacle?: string; kind?: string } } } };
      };
      expect(JSON.stringify(frame.error?.data)).toContain('"tentacle":"9.8.7"');
    } finally {
      worker.terminate();
    }
  });
});
