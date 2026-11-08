/**
 * `buildAgent` and the `models` map (docs/feat/models-map.md A8/B2): a type's
 * configured entry, and a selectable one, really run the child; over the pod
 * tunnel (`modelOverride`) nothing of `models` is used. Scratch config dir and a
 * spy provider factory only: no network, never the user's config.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import type { CreateModelProviderOptions } from "@tentacle/providers";
import { type TentacleConfig, loadConfig, resolveModelEntry } from "../src/config.ts";
import { buildAgent } from "../src/wiring.ts";

let dir: string;
let base: TentacleConfig;
const saved = process.env.TENTACLE_CONFIG_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "models-wiring-"));
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  base = await loadConfig({ cwd: dir });
});

afterAll(async () => {
  if (saved === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
  } else {
    process.env.TENTACLE_CONFIG_DIR = saved;
  }
  await rm(dir, { recursive: true, force: true });
});

const spawn = (args: Record<string, string>): StreamEvent => ({
  type: "tool_call",
  toolCall: {
    id: "c1",
    name: "agent_task",
    arguments: JSON.stringify({ description: "d", prompt: "CHILD", ...args }),
  },
});

/** The parent spawns once, then ends; a child (prompt `CHILD`) says who it is. */
class Parent implements ModelProvider {
  readonly id = "parent";
  readonly requests: ChatRequest[] = [];
  constructor(private readonly call: StreamEvent) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const isChild = request.messages.some((m) => m.role === "user" && m.content.includes("CHILD"));
    if (isChild) {
      yield { type: "text", delta: "from parent model" };
      yield { type: "done" };
      return;
    }
    this.requests.push(request);
    const answered = request.messages.some((m) => m.role === "tool");
    for (const event of answered
      ? [{ type: "done" } as StreamEvent]
      : [this.call, { type: "done" } as StreamEvent]) {
      yield event;
    }
  }
}

class Child implements ModelProvider {
  readonly id: string;
  calls = 0;
  constructor(readonly name: string) {
    this.id = name;
  }
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls++;
    yield { type: "text", delta: `from ${this.name}` };
    yield { type: "done" };
  }
}

function withModels(over: Partial<TentacleConfig> = {}): TentacleConfig {
  const main = {
    provider: base.provider,
    baseURL: base.baseURL,
    model: base.model,
    contextWindow: base.contextWindow,
  };
  return {
    ...base,
    subagentExecution: "sequential",
    models: {
      fast: resolveModelEntry(main, { model: "fast-id", description: "Quick." }),
      claude: {
        ...resolveModelEntry(main, { provider: "anthropic", model: "sonnet" }),
        apiKey: "s3cret-entry",
      },
    },
    subagentModels: { explore: "fast" },
    selectableModels: [],
    ...over,
  };
}

function factory(parent: Parent) {
  const made: CreateModelProviderOptions[] = [];
  const children = new Map<string, Child>();
  const create = (options: CreateModelProviderOptions): ModelProvider => {
    made.push(options);
    if (options.model === base.model) {
      return parent;
    }
    const child = new Child(options.model);
    children.set(options.model, child);
    return child;
  };
  return { made, children, create };
}

async function run(agent: ReturnType<typeof buildAgent>["agent"]): Promise<string[]> {
  const results: string[] = [];
  for await (const event of agent.run("s", [{ role: "user", content: "go" }])) {
    if (event.type === "tool_result") {
      results.push(event.result.content);
    }
  }
  return results;
}

const descriptionOf = (parent: Parent): string | undefined =>
  parent.requests[0]?.tools?.find((t) => t.name === "agent_task")?.description;

describe("buildAgent routes a sub-agent to its models entry", () => {
  test("subagents.types.explore.model = fast: the explore child runs on fast", async () => {
    const parent = new Parent(spawn({ subagent_type: "explore" }));
    const f = factory(parent);
    const { agent } = buildAgent(withModels(), { createProvider: f.create });
    expect(await run(agent)).toEqual(["from fast-id"]);
    expect(f.made.find((m) => m.model === "fast-id")?.baseURL).toBe(base.baseURL);
  });

  test("an unconfigured type stays on the main model", async () => {
    const parent = new Parent(spawn({ subagent_type: "general" }));
    const f = factory(parent);
    const { agent } = buildAgent(withModels(), { createProvider: f.create });
    expect(await run(agent)).toEqual(["from parent model"]);
    expect(f.children.size).toBe(0);
  });

  test("selectable: the description lists them and the call's model runs the child", async () => {
    const parent = new Parent(spawn({ subagent_type: "explore", model: "claude" }));
    const f = factory(parent);
    const { agent } = buildAgent(withModels({ selectableModels: ["fast", "claude"] }), {
      createProvider: f.create,
    });
    expect(await run(agent)).toEqual(["from sonnet"]);
    expect(descriptionOf(parent)).toContain(
      "Available models (optional `model` argument; omit it to use the sub-agent type's own model):\n- fast: Quick.\n- claude",
    );
    const claude = f.made.find((m) => m.model === "sonnet");
    expect([claude?.provider, claude?.apiKey]).toEqual(["anthropic", "s3cret-entry"]);
  });
});

describe("over the model tunnel (a pod): models is not used", () => {
  test("every child is the tunnel; no models provider, no list; one daemon-log notice", async () => {
    // Mutation: give the pod path `modelFor` → the explore child runs on fast → red.
    const tunnel = new Parent(spawn({ subagent_type: "explore", model: "claude" }));
    const f = factory(tunnel);
    const lines: string[] = [];
    const { agent } = buildAgent(withModels({ selectableModels: ["claude"] }), {
      modelOverride: tunnel,
      createProvider: f.create,
      notice: (l) => lines.push(l),
    });
    expect(await run(agent)).toEqual(["from parent model"]);
    expect(f.made).toEqual([]);
    expect(descriptionOf(tunnel)).not.toContain("Available models");
    expect(lines).toEqual([
      "models: per-type and selectable sub-agent models are ignored over the model tunnel; sub-agents use the laptop's main model",
    ]);
  });
});
