/**
 * The workflow driver's wiring (docs/feat/agent-workflows.md Slice 4): built,
 * with the model's `workflow` tool, only where the caller opts in (the worker
 * and `serve`) and NEVER on a tunnelled session (a pod's asks and approvals are
 * not the laptop's to keep, AGENTS §7); never offered to a child.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@tentacle/core";
import { WORKFLOW_TOOL_NAME } from "@tentacle/tools";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { buildAgent, workerSessionBuild } from "../src/wiring.ts";

let dir: string;
let config: TentacleConfig;
let saved: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-workflow-"));
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

const offers = (wired: ReturnType<typeof buildAgent>): boolean =>
  wired.tools.definitions().some((d) => d.name === WORKFLOW_TOOL_NAME);

describe("workflow wiring", () => {
  test("opted in (worker / serve): a driver, carried to the session host, and the tool", () => {
    const wired = buildAgent(config, { workflows: true });
    expect(wired.workflows).toBeDefined();
    expect(offers(wired)).toBe(true);
    expect(workerSessionBuild(wired).workflows).toBe(wired.workflows);
  });

  test("not opted in (one-shot, pod builds): no driver, no tool", () => {
    const wired = buildAgent(config);
    expect(wired.workflows).toBeUndefined();
    expect(offers(wired)).toBe(false);
  });

  test("a tunnelled session never gets one, even opted in", () => {
    const wired = buildAgent(config, {
      workflows: true,
      modelOverride: {} as ModelProvider,
    });
    expect(wired.workflows).toBeUndefined();
    expect(offers(wired)).toBe(false);
  });

  test("a missing workflow file is refused before any ask, naming the path", async () => {
    const wired = buildAgent(config, { workflows: true });
    const started = await wired.workflows?.start({ name: "nope", by: "user" });
    expect(started?.ok).toBe(false);
    expect(started?.ok === false ? started.reason : "").toContain("workflows/nope.yaml");
  });
});
