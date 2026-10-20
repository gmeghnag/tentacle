import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { inProcessAgents } from "../src/wiring.ts";

let dir: string;
let config: TentacleConfig;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-wiring-"));
  for (const key of ["TENTACLE_CONFIG_DIR", "TENTACLE_CWD"]) saved[key] = process.env[key];
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  process.env.TENTACLE_CWD = dir;
  config = await loadConfig({ cwd: dir });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("inProcessAgents (single-broker invariant, AGENTS §7)", () => {
  test("every per-session agent — before and after /clear — asks the ONE broker the TUI prompts on", async () => {
    // Mutation: `build: () => buildAgent(config)` (a broker per agent, which
    // auto-approves by default) → the TUI's requester is never reached.
    const { permissions, build } = inProcessAgents(config);
    const asked: string[] = [];
    permissions.setRequester(async (req) => {
      asked.push(req.title);
      return { allowed: false };
    });
    const first = build();
    const second = build(); // the session after /clear
    expect(first.permissions).toBe(permissions);
    expect(second.permissions).toBe(permissions);
    expect(first.jobs).not.toBe(second.jobs); // one BackgroundJobs per session (D3)
    for (const wired of [first, second]) {
      const answer = await wired.permissions.request({
        tool: "shell",
        level: "ask",
        title: "run ls",
        input: {},
      });
      expect(answer.allowed).toBe(false);
    }
    expect(asked).toEqual(["run ls", "run ls"]);
  });
});
