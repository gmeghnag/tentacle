/**
 * `move_session`'s REGISTRATION (docs/feat/session-hop.md D9, slice H5, review
 * M5): the tool is offered only where a hop can actually be asked about, and the
 * `sessionHop.tool` setting can turn it off. The rule lives at ONE site
 * (`wiring.ts`, the `contextReset` registration site) because that site is shared
 * by every kind of build, and `BuildAgentOptions` has no daemon kind — so the flag
 * itself is the contract, and this file pins it by building the real agents.
 *
 * The failure it prevents is silent and asymmetric: a `serve`/in-process build that
 * offered the tool would let the MODEL propose a move nobody ever asks about (its
 * `tool_result` claims a proposal the owner never sees), and a worker build that
 * did not offer it would make the feature disappear with no error at all.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { buildAgent } from "../src/wiring.ts";

let dir: string;
let config: TentacleConfig;
const saved: Record<string, string | undefined> = {};
const HOP_ENV = "TENTACLE_SESSION_HOP_TOOL";

/** A computed delete (AGENTS §6: `noDelete` is hand-fixed, not disabled). */
const unsetEnv = (key: string): void => {
  const env = process.env as Record<string, string | undefined>;
  delete env[key];
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-move-session-"));
  for (const key of ["TENTACLE_CONFIG_DIR", "TENTACLE_SESSION_HOP_TOOL"])
    saved[key] = process.env[key];
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  unsetEnv(HOP_ENV);
  config = await loadConfig({ cwd: dir });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

/** The names the model is OFFERED for this build (the definitions, not the registry). */
const offered = (tools: { definitions(): readonly { name: string }[] }): string[] =>
  tools.definitions().map((definition) => definition.name);

describe("H5/M5: `move_session` is registered only where a hop can be asked about", () => {
  test("a build that sets `moveSession` offers it, with its schema", () => {
    const wired = buildAgent(config, { moveSession: true });
    expect(offered(wired.tools)).toContain("move_session");
    const definition = wired.tools.definitions().find((d) => d.name === "move_session");
    // The model needs the arguments to fill in, or the tool is unusable.
    expect(JSON.stringify(definition)).toContain("target");
    expect(JSON.stringify(definition)).toContain("workload");
  });

  test("a build that does not set it NEVER offers it — `serve`, one-shot, a child", () => {
    // Mutation: register it unconditionally → this row fails for all three.
    expect(offered(buildAgent(config).tools)).not.toContain("move_session");
  });

  test("`sessionHop.tool` off turns it off even where the flag is set (decision 6)", async () => {
    process.env.TENTACLE_SESSION_HOP_TOOL = "false";
    try {
      const off = await loadConfig({ cwd: dir });
      expect(off.sessionHop.tool).toBe(false);
      expect(offered(buildAgent(off, { moveSession: true }).tools)).not.toContain("move_session");
    } finally {
      unsetEnv(HOP_ENV);
    }
  });

  test("a child agent is never offered it, even from a parent that has it", () => {
    // A child's tools are the parent's, filtered to its type's allow-list plus the
    // "never a child" list (`subagent.ts`). The parent registry really holds
    // `move_session` here, which is what makes the filter's job non-vacuous; the
    // child-side rows (`packages/agent/test/subagent-move-session.test.ts`) prove
    // the filter drops it for a `general` child.
    const wired = buildAgent(config, { moveSession: true });
    expect(wired.tools.get("move_session")).toBeDefined();
  });
});
