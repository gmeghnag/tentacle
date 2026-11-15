import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionBroker } from "@tentacle/core";
import { LogSessionStore } from "@tentacle/daemon";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { daemonErrorLogPath } from "../src/daemon-log.ts";
import {
  WorkerStartError,
  startWorkerRuntime,
  workerStartFailureText,
} from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

// End-to-end over the REAL worker boundary: spawn the worker daemon, handshake,
// open a session, and drive one scripted turn through a fake OpenAI-compatible
// server. This is the path `tentacle -i` now uses by default, so it must
// actually boot (a silent fallback to in-process would hide a broken worker).

function sse(events: unknown[]): string {
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
}

const TURN = sse([
  { choices: [{ delta: { content: "hi from the worker" } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
]);

let server: ReturnType<typeof Bun.serve>;
let dir: string;
let config: TentacleConfig;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-worker-"));
  server = Bun.serve({
    port: 0,
    fetch: () => new Response(TURN, { headers: { "content-type": "text/event-stream" } }),
  });
  for (const key of ["TENTACLE_CONFIG_DIR", "TENTACLE_MODEL_BASE_URL", "TENTACLE_MODEL"]) {
    saved[key] = process.env[key];
  }
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
  process.env.TENTACLE_MODEL_BASE_URL = `http://localhost:${server.port}/v1`;
  process.env.TENTACLE_MODEL = "test";
  config = await loadConfig({ cwd: dir });
});

afterAll(async () => {
  server.stop(true);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(dir, { recursive: true, force: true });
});

describe("startWorkerRuntime (real worker spawn)", () => {
  test("boots, handshakes, and runs a scripted turn over the worker boundary", async () => {
    const runtime = await startWorkerRuntime(
      config,
      {
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, "sessions")), () => {}),
        resume: null,
      },
      () => {},
    );
    expect(runtime).not.toBeNull();
    if (!runtime) {
      return;
    }
    try {
      let text = "";
      for await (const event of runtime.createSession().send("hello")) {
        if (event.type === "text") {
          text += event.delta;
        }
      }
      expect(text).toContain("hi from the worker");
    } finally {
      runtime.dispose();
    }
  });

  // Fix round 1, finding 1 (docs/feat/images-off-reason.md): the worker runs
  // THIS laptop's model from THIS laptop's config, and reports no model of its
  // own — so the "images are off" reason must name our model and point at our
  // config. Mutation: drop `modelScope: "laptop"` at the worker's
  // `createLocalRuntime` call → red.
  test("images off: the reason names THIS laptop's model and config (the worker is ours)", async () => {
    const runtime = await startWorkerRuntime(
      // A model whose provider default has no vision (`images` unset): the
      // daemon then advertises no image input at all (`daemonImagePolicy`).
      { ...config, provider: "openai", images: false },
      {
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, "sessions-images")), () => {}),
        resume: null,
      },
      () => {},
    );
    expect(runtime).not.toBeNull();
    if (!runtime) {
      return;
    }
    try {
      const mode = runtime.createSession().imageInput();
      expect(mode.kind).toBe("off");
      if (mode.kind !== "off") {
        return;
      }
      expect(mode.reason).toContain("your config");
      expect(mode.reason).not.toContain("the daemon's config");
      // The model is the laptop's own (`config.model`), named through the
      // display-only option rather than an `agentInfo` the worker never sends.
      expect(mode.reason).toContain(config.model);
    } finally {
      await runtime.dispose();
    }
  });

  test("/mcp: the worker reports each configured MCP server's live state", async () => {
    const server = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
    const runtime = await startWorkerRuntime(
      {
        ...config,
        mcpServers: {
          echo: { type: "stdio", command: process.execPath, args: [server] },
          missing: { type: "stdio", command: join(dir, "no-such-mcp-server") },
        },
      },
      {
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, "sessions-mcp")), () => {}),
        resume: null,
      },
      () => {},
    );
    expect(runtime).not.toBeNull();
    if (!runtime) {
      return;
    }
    try {
      // The connect runs in the background: poll until it has settled.
      let servers = await runtime.mcpStatus();
      for (let i = 0; i < 100 && servers.some((s) => s.state === "connecting"); i++) {
        await Bun.sleep(50);
        servers = await runtime.mcpStatus();
      }
      // The real server's bare tool names come through end to end (`/mcp` lists them).
      expect(servers.map((s) => [s.name, s.state, s.tools, s.moreTools])).toEqual([
        ["echo", "connected", ["echo"], 0],
        ["missing", "failed", [], 0],
      ]);
      expect(servers[1]?.error).toBeTruthy();
    } finally {
      await runtime.dispose();
    }
  });
});

/**
 * A fake worker endpoint: enough of `Worker` for `startWorkerRuntime` (a
 * message port, an `error` event it can fire, and a `terminate` spy). It never
 * answers the handshake unless the test says so.
 */
function fakeWorker(fire: "never" | "error" = "never") {
  const target = new EventTarget();
  const state = { terminated: false, posted: [] as unknown[] };
  const worker = {
    postMessage: (data: unknown) => {
      state.posted.push(data);
    },
    addEventListener: (type: string, handler: (event: unknown) => void) =>
      target.addEventListener(type, handler),
    removeEventListener: (type: string, handler: (event: unknown) => void) =>
      target.removeEventListener(type, handler),
    terminate: () => {
      state.terminated = true;
    },
  };
  if (fire === "error") {
    // A load failure (the compiled-binary `ModuleNotFound` class): Bun reports it
    // as an `error` event on the Worker, never as a spawn throw.
    queueMicrotask(() => {
      const event = new Event("error");
      Object.defineProperty(event, "message", {
        value: "ModuleNotFound resolving /$bunfs/root/worker.ts",
      });
      target.dispatchEvent(event);
    });
  }
  return { worker: worker as unknown as Worker, state };
}

function failureDeps() {
  return {
    permissions: new PermissionBroker(),
    saver: new SessionSaver(new LogSessionStore(join(dir, "sessions-failure")), () => {}),
    resume: null,
  };
}

describe("startWorkerRuntime: a worker that cannot start is an ERROR, never a null fallback", () => {
  // Mutation (AGENTS §9 non-vacuity): make `startWorkerRuntime` return `null`
  // instead of throwing (the old `try { … } catch { return null }` shape) → T1,
  // T2 and T3 all fail, because each asserts a rejection.
  test("T1 a spawn failure rejects with WorkerStartError{spawn}, never resolves null", async () => {
    const attempt = startWorkerRuntime(config, failureDeps(), () => {}, {
      spawn: () => {
        throw new Error("no worker here");
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(WorkerStartError);
    const error = await attempt.catch((e: unknown) => e);
    if (!(error instanceof WorkerStartError)) {
      throw new Error("expected a WorkerStartError");
    }
    expect(error.phase).toBe("spawn");
    expect(error.reason).toContain("no worker here");
  });

  test("T2 a worker that fails to LOAD rejects at once with its own message", async () => {
    const fake = fakeWorker("error");
    const started = Date.now();
    const attempt = startWorkerRuntime(config, failureDeps(), () => {}, {
      spawn: () => fake.worker,
      handshakeMs: 5000,
    });
    const error = await attempt.catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    if (!(error instanceof WorkerStartError)) {
      throw new Error(`expected a WorkerStartError, got ${String(error)}`);
    }
    expect(error.phase).toBe("handshake");
    expect(error.reason).toContain("ModuleNotFound resolving /$bunfs/root/worker.ts");
    // The point of the early rejection: far sooner than the handshake timeout.
    expect(elapsed).toBeLessThan(1000);
    expect(fake.state.terminated).toBe(true);
  });

  test("T3 a worker that never answers times out as WorkerStartError{handshake}", async () => {
    const fake = fakeWorker("never");
    const error = await startWorkerRuntime(config, failureDeps(), () => {}, {
      spawn: () => fake.worker,
      handshakeMs: 50,
    }).catch((e: unknown) => e);
    if (!(error instanceof WorkerStartError)) {
      throw new Error(`expected a WorkerStartError, got ${String(error)}`);
    }
    expect(error.phase).toBe("handshake");
    expect(error.reason).toContain("worker handshake timed out after 50ms");
    expect(fake.state.terminated).toBe(true);
  });

  test("T4 the text says what failed, what to do, and where the details are — for each phase", () => {
    const logPath = daemonErrorLogPath(config.configDir);
    const spawn = workerStartFailureText(
      new WorkerStartError("spawn", "no Worker global"),
      logPath,
    );
    expect(spawn).toContain("worker spawn: no Worker global");
    expect(spawn).toContain("Bun >= 1.4.3");
    expect(spawn).toContain("tentacle update");
    expect(spawn).toContain(logPath);
    const handshake = workerStartFailureText(
      new WorkerStartError("handshake", "version mismatch"),
      logPath,
    );
    expect(handshake).toContain("worker handshake: version mismatch");
    // Nothing offers the removed path, not even to explain it.
    expect(spawn).not.toContain("in-process");
    expect(handshake).not.toContain("in-process");
    // A hostile reason cannot paint on the terminal: escapes and line breaks are
    // gone from it (`oneLine`; the `[2J` survives as inert literal text).
    const hostile = workerStartFailureText(
      new WorkerStartError("handshake", "a\x1b[2Jb\nc"),
      logPath,
    );
    const reasonLine = hostile.split("\n")[0] ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence is the point
    expect(reasonLine).not.toMatch(/[\u001b\r]/);
    expect(reasonLine).toContain("a [2Jb c");
  });
});
