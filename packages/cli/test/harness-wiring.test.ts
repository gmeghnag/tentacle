/**
 * The `claude` harness type's wiring (docs/feat/subagent-harness-runners.md D5):
 * offered only where the caller opts in (worker / `serve`), only when enabled
 * and on PATH, and NEVER over a `modelOverride` (a pod).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessProc, Spawner } from "@tentacle/agent";
import type { ModelProvider, ToolContext } from "@tentacle/core";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { buildAgent } from "../src/wiring.ts";

let dir: string;
let config: TentacleConfig;
let saved: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-wiring-"));
  saved = process.env.TENTACLE_CONFIG_DIR;
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  config = { ...(await loadConfig({ cwd: dir })), subagentsEnabled: true };
});

afterAll(async () => {
  if (saved === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
  } else {
    process.env.TENTACLE_CONFIG_DIR = saved;
  }
  await rm(dir, { recursive: true, force: true });
});

const ON_PATH = { which: () => "/fake/bin/claude" };

function taskDef(wired: ReturnType<typeof buildAgent>) {
  const def = wired.tools.definitions().find((d) => d.name === "agent_task");
  return {
    description: def?.description ?? "",
    model: (def?.parameters as { properties?: Record<string, { description?: string }> }).properties
      ?.model?.description,
  };
}

const offersClaude = (wired: ReturnType<typeof buildAgent>): boolean =>
  taskDef(wired).description.includes("\n- claude: ");

describe("harness wiring (D5)", () => {
  test("opted in, enabled, on PATH: the `claude` type with a free `model`", () => {
    const wired = buildAgent(config, { harnesses: ON_PATH });
    expect(offersClaude(wired)).toBe(true);
    expect(taskDef(wired).model).toContain("`opus`, `sonnet`, `haiku`");
  });

  test("not opted in (one-shot / pod builds): no `claude` type", () => {
    expect(offersClaude(buildAgent(config))).toBe(false);
  });

  test("not on PATH, or disabled: no `claude` type", () => {
    expect(offersClaude(buildAgent(config, { harnesses: { which: () => null } }))).toBe(false);
    const off: TentacleConfig = {
      ...config,
      harnesses: { "claude-code": { ...config.harnesses["claude-code"], enabled: false } },
    } as TentacleConfig;
    expect(offersClaude(buildAgent(off, { harnesses: ON_PATH }))).toBe(false);
  });

  test("tunnelled (a pod): never, even opted in and on PATH; a written key gets a notice", () => {
    const notices: string[] = [];
    const configured = {
      ...config,
      harnesses: { "claude-code": { ...config.harnesses["claude-code"], configured: true } },
    } as TentacleConfig;
    const wired = buildAgent(configured, {
      harnesses: ON_PATH,
      modelOverride: {} as ModelProvider,
      notice: (line) => notices.push(line),
    });
    expect(offersClaude(wired)).toBe(false);
    expect(taskDef(wired).model).toBeUndefined();
    expect(notices.some((n) => n.startsWith("harnesses: ignored in a pod"))).toBe(true);
  });

  test("an agent_task call for `claude` reaches the harness: a non-git cwd refuses, nothing runs", async () => {
    const spawned: string[][] = [];
    const spawner: Spawner = (cmd) => {
      spawned.push([...cmd]);
      const enc = new TextEncoder();
      const isVersion = cmd[1] === "--version";
      const proc: HarnessProc = {
        pid: 999_999,
        write: () => {},
        endInput: () => {},
        stdout: new ReadableStream({
          start: (c) => {
            if (isVersion) c.enqueue(enc.encode("2.1.331 (Claude Code)\n"));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
      return proc;
    };
    const wired = buildAgent(config, {
      harnesses: { ...ON_PATH, spawner, groups: { track() {}, untrack() {}, kill: () => false } },
    });
    const ctx = { sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;
    const result = await wired.tools.execute(
      "agent_task",
      JSON.stringify({ description: "d", prompt: "p", subagent_type: "claude", model: "haiku" }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a git repository");
    // Probed (the version), never started.
    expect(spawned).toEqual([["/fake/bin/claude", "--version"]]);
  });
});
