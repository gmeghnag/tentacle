import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { buildAgent, inProcessAgents } from "../src/wiring.ts";

let dir: string;
let config: TentacleConfig;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-wiring-"));
  for (const key of ["TENTACLE_CONFIG_DIR"]) saved[key] = process.env[key];
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
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

/** A model whose turns are scripted; records every request it receives. */
class ScriptedModel implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    for (const event of this.script[this.turn++] ?? [{ type: "done" }]) {
      yield event;
    }
  }
}

describe("buildAgent skills (docs/feat/skills-core.md)", () => {
  // ~32 KB like the real hf-cli: over the 16000-char spill threshold, with a
  // run of identical lines the dedup transform would collapse.
  const BODY = `# Big skill\n${"same line\n".repeat(50)}${Array.from({ length: 1100 }, (_, i) => `step ${i}: do the thing carefully\n`).join("")}END-OF-SKILL\n`;

  async function skillConfig(overrides: Partial<TentacleConfig> = {}): Promise<TentacleConfig> {
    const home = join(dir, `home-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(home, ".agents", "skills", "big"), { recursive: true });
    await writeFile(
      join(home, ".agents", "skills", "big", "SKILL.md"),
      `---\nname: big\ndescription: a big skill\n---\n${BODY}`,
    );
    const cfg = await loadConfig({ env: { HOME: home }, configDir: join(home, "cfg"), cwd: home });
    return { ...cfg, subagentsEnabled: false, ...overrides };
  }

  async function activate(cfg: TentacleConfig): Promise<{ content: string; model: ScriptedModel }> {
    const model = new ScriptedModel([
      [
        { type: "tool_call", toolCall: { id: "k1", name: "skill", arguments: '{"name":"big"}' } },
        { type: "done" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const { agent } = buildAgent(cfg, { modelOverride: model });
    let content = "";
    for await (const event of agent.run("s", [{ role: "user", content: "go" }])) {
      if (event.type === "tool_result") {
        content = event.result.content;
      }
    }
    return { content, model };
  }

  test("the skill body reaches the model verbatim — never spilled, deduped or summarised", async () => {
    // Mutation (red, verified): drop the `exemptTools` wrapping in wiring.ts →
    // the body comes back as a spill preview and END-OF-SKILL is missing.
    expect(BODY.length).toBeGreaterThan(30_000);
    for (const cfg of [
      await skillConfig(),
      await skillConfig({ summarizeLargeOutput: true, dedupOutput: true }),
    ]) {
      const { content, model } = await activate(cfg);
      expect(content).toStartWith('<skill_content name="big">\n# Big skill\n');
      expect(content).toContain(BODY.trimEnd());
      expect(model.requests.length).toBe(2); // no summarisation call
      const sent = model.requests[1]?.messages.find((m) => m.role === "tool");
      expect(sent?.content).toBe(content);
    }
  });

  test("another tool's large output is still spilled (the exemption is per tool)", async () => {
    const cfg = await skillConfig();
    const model = new ScriptedModel([
      [
        {
          type: "tool_call",
          toolCall: {
            id: "r1",
            name: "fs_read",
            arguments: JSON.stringify({ path: cfg.skills[0]?.location }),
          },
        },
        { type: "done" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const { agent } = buildAgent({ ...cfg, cwd: dir }, { modelOverride: model });
    let content = "";
    for await (const event of agent.run("s", [{ role: "user", content: "go" }])) {
      if (event.type === "tool_result") {
        content = event.result.content;
      }
    }
    expect(content).toContain("saved to .tentacle/tool-output/fs_read-r1.txt");
    expect(content).not.toContain("step 500:");
  });

  test("the tool is registered only when a skill is offered; the catalog is in the prompt", async () => {
    const cfg = await skillConfig();
    expect(cfg.systemPrompt).toContain("<name>big</name>");
    const names = (c: TentacleConfig) =>
      buildAgent(c)
        .tools.definitions()
        .map((d) => d.name);
    expect(names(cfg)).toContain("skill");
    expect(names({ ...cfg, skills: [] })).not.toContain("skill");
    expect(
      names({ ...cfg, skills: cfg.skills.map((s) => ({ ...s, modelInvocable: false })) }),
    ).not.toContain("skill");
  });
});
