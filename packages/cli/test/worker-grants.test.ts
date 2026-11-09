import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { buildAgent, workerSessionBuild } from "../src/wiring.ts";

// docs/feat/clear-keeps-jobs.md, review H1: the in-process worker's agent factory
// rebuilt the factory result field by field and dropped `grants`, so `/clear`
// (HostedSession.clear → grants.clear()) silently kept the approvals on the
// default local runtime. The mapping is now ONE exported function, used by the
// worker and pinned here.

let dir: string;
let config: TentacleConfig;
const saved = process.env.TENTACLE_CONFIG_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-worker-grants-"));
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  config = await loadConfig({ cwd: dir });
});

afterAll(async () => {
  if (saved === undefined) {
    // biome-ignore lint/performance/noDelete: restoring an absent env var
    delete process.env.TENTACLE_CONFIG_DIR;
  } else {
    process.env.TENTACLE_CONFIG_DIR = saved;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("the worker's session build carries the approvals store (H1)", () => {
  test("`grants` is the SAME store the wired agent tree uses", () => {
    // Mutation: drop `grants` from `workerSessionBuild` (the original bug).
    const wired = buildAgent(config);
    const build = workerSessionBuild(wired);
    expect(build.grants).toBeDefined();
    expect(build.grants).toBe(wired.grants);
    expect(build.agent).toBe(wired.agent);
    expect(build.permissions).toBe(wired.permissions);
    expect(build.jobs).toBe(wired.jobs);
    expect(build.agentJobs).toBe(wired.agentJobs);
  });

  test("worker.ts builds every session through that function (no field-by-field copy)", async () => {
    const source = await readFile(join(import.meta.dir, "../src/worker.ts"), "utf8");
    expect(source).toContain("workerSessionBuild(wired)");
  });
});
