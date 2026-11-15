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
/** A config with `workloadShell.tool` ON: the opt-in (owner decision 1). */
let enabled: TentacleConfig;
const saved: Record<string, string | undefined> = {};
const ENV = "TENTACLE_WORKLOAD_SHELL_TOOL";

/** A computed delete (AGENTS §6: `noDelete` is hand-fixed, not disabled). */
const unsetEnv = (key: string): void => {
  const env = process.env as Record<string, string | undefined>;
  delete env[key];
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-workload-shell-"));
  for (const key of ["TENTACLE_CONFIG_DIR", ENV]) saved[key] = process.env[key];
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  unsetEnv(ENV); // the DEFAULT is what `config` holds
  config = await loadConfig({ cwd: dir });
  process.env[ENV] = "true";
  enabled = await loadConfig({ cwd: dir });
  unsetEnv(ENV);
});

afterAll(async () => {
  // Computed deletes (AGENTS §6: `noDelete` is hand-fixed). Assigning
  // `undefined` would set the STRING "undefined", which is how a stray
  // `./undefined/` config dir got created once.
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) unsetEnv(key);
    else process.env[key] = value;
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
  test("a build that passes a backend and enables the setting offers it, with a usable schema", () => {
    const wired = buildAgent(enabled, { workloadShell: { backend } });
    expect(offered(wired.tools)).toContain("workload_shell");
    const definition = wired.tools.definitions().find((d) => d.name === "workload_shell");
    const schema = JSON.stringify(definition);
    // The model must see the arguments it has to fill in.
    expect(schema).toContain("target");
    expect(schema).toContain("command");
    // ...and the description must steer it away from the wrong tool.
    expect(definition?.description).toContain("move_session");
  });

  test("`workloadShell.tool` is OFF by default, so a backend alone offers NOTHING", () => {
    // Owner decision 1. Mutation: register on the backend alone (the pre-fix
    // wiring) → this row fails, because the tool really is offered.
    expect(config.workloadShell.tool).toBe(false);
    const wired = buildAgent(config, { workloadShell: { backend } });
    expect(offered(wired.tools)).not.toContain("workload_shell");
    // Nothing to dispose either: the registry is built only when it is offered.
    expect(wired.workloadShells).toBeUndefined();
  });

  test("a build with NO backend never offers it — which is every pod daemon", () => {
    // Mutation: register it unconditionally → this row fails.
    expect(offered(buildAgent(enabled).tools)).not.toContain("workload_shell");
    expect(offered(buildAgent(config).tools)).not.toContain("workload_shell");
  });

  test("the registry travels with the build, so the session can dispose it", () => {
    const wired = buildAgent(enabled, { workloadShell: { backend } });
    expect(wired.workloadShells).toBeDefined();
    expect(typeof wired.workloadShells?.dispose).toBe("function");
    // And a build without the tool has nothing to dispose.
    expect(buildAgent(enabled).workloadShells).toBeUndefined();
    expect(buildAgent(config, { workloadShell: { backend } }).workloadShells).toBeUndefined();
  });

  test("offering it does not disturb the tools every build already had", () => {
    const withTool = offered(buildAgent(enabled, { workloadShell: { backend } }).tools);
    const without = offered(buildAgent(enabled).tools);
    expect(withTool.length).toBe(without.length + 1);
    expect(new Set(without).size).toBe(without.length);
  });
});
