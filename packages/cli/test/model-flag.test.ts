/**
 * `--model <entry>` on the CLI (docs/feat/model-switch.md D6, T6): the local
 * TUI starts on the entry; `run` / `attach` / `serve` refuse it, since their
 * records re-apply a model ID on the main endpoint. The real `main`, a scratch
 * config dir, a faked TUI and worker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.ts";

const unsubscribe = (): void => {};

/** Just enough `LocalRuntime` for the TUI's mount and teardown. */
const stubRuntime = {
  createSession: () => ({ sessionId: null }),
  jobs: { onStart: () => unsubscribe, onExit: () => unsubscribe, onUpdate: () => unsubscribe },
  link: { onLinkStatus: unsubscribe },
  mcpStatus: async () => [],
  dispose: async () => {},
  release: async () => {},
  attachTo: async () => false,
  unflushedExits: () => 0,
  announce: () => {},
};

const saved: Record<string, string | undefined> = {};
let dir = "";

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  if (dir !== "") {
    await rm(dir, { recursive: true, force: true });
  }
});

async function cli(args: readonly string[]) {
  dir = await mkdtemp(join(tmpdir(), "tentacle-model-flag-"));
  const home = join(dir, "home");
  const cfg = join(dir, "cfg");
  await mkdir(home, { recursive: true });
  await mkdir(cfg, { recursive: true });
  await writeFile(
    join(cfg, "config.jsonc"),
    JSON.stringify({
      model: { baseURL: "http://127.0.0.1:1/v1", model: "main-id", contextWindow: 111000 },
      models: { haiku: { model: "haiku-id", contextWindow: 22000 } },
    }),
  );
  for (const key of ["TENTACLE_CONFIG_DIR", "HOME"]) {
    saved[key] = process.env[key];
  }
  process.env.TENTACLE_CONFIG_DIR = cfg;
  process.env.HOME = home;
  const started: Record<string, unknown>[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["bun", "cli", ...args], {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    terminal: { stdin: true, stdout: true },
    startTui: (async (_agent: unknown, options: Record<string, unknown>) => {
      started.push(options);
    }) as never,
    startWorkerRuntime: (async () => stubRuntime as never) as never,
  });
  return { code, started, out: out.join(""), err: err.join("") };
}

describe("--model <entry>", () => {
  test("the local TUI starts on the entry's id and window", async () => {
    const result = await cli(["--model", "haiku"]);
    expect(result.code).toBe(0);
    expect(result.started.map((o) => [o.model, o.contextWindow])).toEqual([["haiku-id", 22000]]);
  });

  test("a model id still works as before", async () => {
    const result = await cli(["--model", "other-id"]);
    expect(result.started.map((o) => [o.model, o.contextWindow])).toEqual([["other-id", 111000]]);
  });

  for (const args of [
    ["run", "--image", "img", "--model", "haiku"],
    ["attach", "name", "--model", "haiku"],
    // Unreadable TLS files: were the refusal gone, `serve` would still not listen.
    ["serve", "--tls-cert", "/nonexistent", "--tls-key", "/nonexistent", "--model", "haiku"],
  ]) {
    test(`${args[0]} refuses an entry name: exit 2 and why`, async () => {
      const result = await cli(args);
      expect(result.err).toContain("--model haiku is a models entry");
      expect(result.err).toContain("pass a model id or --profile");
      expect(result.code).toBe(2);
    });
  }

  test("--help says an entry name works", async () => {
    const result = await cli(["--help"]);
    expect(result.out).toContain("--model <id|entry>");
    expect(/a `models` entry\s+name wins/.test(result.out)).toBe(true);
  });
});
