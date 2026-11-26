/**
 * docs/feat/system-prompt-cwd.md T3: with the real wiring (`loadConfig` +
 * `buildAgent`), the system prompt the model receives ends with the session's
 * working directory and platform — default and custom prompt alike — and
 * `systemPromptEnvironment: false` sends the composed prompt as it is.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { buildAgent } from "../src/wiring.ts";

class RecordingModel implements ModelProvider {
  readonly id = "recording";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "done" };
  }
}

/** Its first reply spawns one sub-agent; every later one just ends. */
class SpawningModel extends RecordingModel {
  override async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.requests.length === 0) {
      yield {
        type: "tool_call",
        toolCall: {
          id: "c1",
          name: "agent_task",
          arguments: JSON.stringify({ description: "d", prompt: "look", subagent_type: "general" }),
        },
      };
    } else {
      // A reply with text: an empty one is asked again.
      yield { type: "text", delta: "ok" };
    }
    yield* super.stream(request);
  }
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function load(file: Record<string, unknown>, profile?: string): Promise<TentacleConfig> {
  const dir = await mkdtemp(join(tmpdir(), "sysenv-"));
  dirs.push(dir);
  const configDir = join(dir, "config");
  const cwd = join(dir, "my-project");
  await mkdir(configDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(configDir, "custom.md"), "You are a custom agent.\n");
  await writeFile(join(configDir, "config.jsonc"), JSON.stringify(file));
  return loadConfig({ configDir, cwd, env: {}, ...(profile ? { profile } : {}) });
}

/** The system head of the first request of one turn. */
async function sentHead(config: TentacleConfig): Promise<string> {
  const model = new RecordingModel();
  const { agent } = buildAgent(config, { modelOverride: model });
  for await (const _event of agent.run("s", [{ role: "user", content: "go" }])) {
    // drained
  }
  const first = model.requests[0]?.messages[0];
  expect(first?.role).toBe("system");
  return String(first?.content);
}

const block = (cwd: string): string =>
  `<cwd>\n${cwd}\n</cwd>\n<platform>${process.platform}</platform>\n`;

describe("the working directory in the system prompt (real wiring)", () => {
  for (const [label, file] of [
    ["the default PROMPT.md", {}],
    ["a custom systemPromptFile", { systemPromptFile: "custom.md" }],
  ] as const) {
    test(`${label} ends with the environment block`, async () => {
      const config = await load(file);
      expect(config.cwd.endsWith("my-project")).toBe(true);
      expect(await sentHead(config)).toBe(
        `${config.systemPrompt.trimEnd()}\n\n${block(config.cwd)}`,
      );
    });
  }

  test("a native sub-agent's prompt ends with the same block", async () => {
    const config = await load({});
    const model = new SpawningModel();
    const { agent } = buildAgent(config, { modelOverride: model });
    for await (const _event of agent.run("s", [{ role: "user", content: "go" }])) {
      // drained
    }
    // The parent's round, the child's, the parent's again.
    expect(model.requests).toHaveLength(3);
    const child = String(model.requests[1]?.messages[0]?.content);
    expect(child).not.toStartWith(config.systemPrompt.trimEnd());
    expect(child).toEndWith(`\n\n${block(config.cwd)}`);
  });

  test("`systemPromptEnvironment: false` sends the composed prompt unchanged", async () => {
    const config = await load({
      systemPromptEnvironment: false,
      systemPromptFile: "custom.md",
    });
    const head = await sentHead(config);
    expect(head).not.toContain("<cwd>");
    expect(head).toBe(config.systemPrompt);
  });

  test("a profile can switch it off", async () => {
    const config = await load({ profiles: { bench: { systemPromptEnvironment: false } } }, "bench");
    expect(await sentHead(config)).toBe(config.systemPrompt);
  });
});
