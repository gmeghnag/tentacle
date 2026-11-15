/**
 * `workload_shell`'s REGISTRATION (docs/feat/workload-shell.md D3, eval risk 6).
 *
 * The tool reaches a workload through the LAPTOP's own credentials (kubeconfig,
 * docker/podman endpoint), so it may be offered only where the daemon runs on
 * the user's host — the local worker and `serve`. A POD daemon must never offer
 * it: its plain `shell` already IS in its workload, and reaching other workloads
 * from a pod would need cluster credentials inside the pod, which AGENTS §7
 * forbids. That omission is silent if nobody pins it, which is what this file is
 * for: it builds the real agents and reads what the model is OFFERED.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkloadShellBackend } from "@tentacle/tools";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { buildAgent } from "../src/wiring.ts";

let dir: string;
let config: TentacleConfig;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-workload-shell-"));
  saved.TENTACLE_CONFIG_DIR = process.env.TENTACLE_CONFIG_DIR;
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  config = await loadConfig({ cwd: dir });
});

afterAll(async () => {
  // A computed delete (AGENTS §6: `noDelete` is hand-fixed). Assigning
  // `undefined` would set the STRING "undefined", which is how a stray
  // `./undefined/` config dir got created once.
  const env = process.env as Record<string, string | undefined>;
  if (saved.TENTACLE_CONFIG_DIR === undefined) {
    const key = "TENTACLE_CONFIG_DIR";
    delete env[key];
  } else {
    env.TENTACLE_CONFIG_DIR = saved.TENTACLE_CONFIG_DIR;
  }
  await rm(dir, { recursive: true, force: true });
});

/** The names the model is OFFERED for this build (the definitions). */
const offered = (tools: { definitions(): readonly { name: string }[] }): string[] =>
  tools.definitions().map((definition) => definition.name);

/** A backend that is never dialled: registration is what is under test. */
const backend: WorkloadShellBackend = {
  open() {
    throw new Error("not dialled in this test");
  },
  oneShot() {
    throw new Error("not dialled in this test");
  },
  async explain(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  },
};

describe("D3/eval risk 6: `workload_shell` is offered only on the user's own host", () => {
  test("a build that passes a backend offers it, with a usable schema", () => {
    const wired = buildAgent(config, { workloadShell: { backend } });
    expect(offered(wired.tools)).toContain("workload_shell");
    const definition = wired.tools.definitions().find((d) => d.name === "workload_shell");
    const schema = JSON.stringify(definition);
    // The model must see the arguments it has to fill in.
    expect(schema).toContain("target");
    expect(schema).toContain("command");
    // ...and the description must steer it away from the wrong tool.
    expect(definition?.description).toContain("move_session");
  });

  test("a build with NO backend never offers it — which is every pod daemon", () => {
    // Mutation: register it unconditionally → this row fails.
    expect(offered(buildAgent(config).tools)).not.toContain("workload_shell");
  });

  test("the registry travels with the build, so the session can dispose it", () => {
    const wired = buildAgent(config, { workloadShell: { backend } });
    expect(wired.workloadShells).toBeDefined();
    expect(typeof wired.workloadShells?.dispose).toBe("function");
    // And a build without the tool has nothing to dispose.
    expect(buildAgent(config).workloadShells).toBeUndefined();
  });

  test("offering it does not disturb the tools every build already had", () => {
    const withTool = offered(buildAgent(config, { workloadShell: { backend } }).tools);
    const without = offered(buildAgent(config).tools);
    expect(withTool.length).toBe(without.length + 1);
    expect(new Set(without).size).toBe(without.length);
  });
});
