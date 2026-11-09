/**
 * `buildAgent` and the `models` map (docs/feat/models-map.md A8/B2): a type's
 * configured entry, and a selectable one, really run the child; over the pod
 * tunnel (`modelOverride`) the pod's own `models` are not used. Scratch config dir and a
 * spy provider factory only: no network, never the user's config. Over the
 * tunnel only the laptop's published models apply (docs/feat/models-map-pod.md).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("over the model tunnel (a pod): the laptop's published models", () => {
  const published = {
    models: [
      { name: "claude", contextWindow: 200000, description: "Strong." },
      { name: "fast", contextWindow: 32768 },
    ],
    types: [{ type: "explore", model: "fast" }],
    selectable: ["claude"],
  };

  /** A pod with NO models of its own, unless `over` adds them. */
  function pod(call: StreamEvent, over: Partial<TentacleConfig> = {}) {
    const tunnel = new Parent(call);
    const f = factory(tunnel);
    const named: string[] = [];
    const lines: string[] = [];
    const { agent } = buildAgent(
      { ...withModels({ models: {}, subagentModels: {}, selectableModels: [] }), ...over },
      {
        modelOverride: tunnel,
        namedModelOverride: (name) => {
          named.push(name);
          return new Child(`tunnel:${name}`);
        },
        createProvider: f.create,
        notice: (l) => lines.push(l),
      },
    );
    return { agent, tunnel, f, named, lines };
  }

  test("a type's published model: the child rides the named tunnel, and no provider is built here", async () => {
    const p = pod(spawn({ subagent_type: "explore" }), { publishedModels: published });
    expect(await run(p.agent)).toEqual(["from tunnel:fast"]);
    expect(p.named).toEqual(["fast"]);
    expect(p.f.made).toEqual([]);
  });

  test("a call's selectable model beats the type's", async () => {
    const p = pod(spawn({ subagent_type: "explore", model: "claude" }), {
      publishedModels: published,
    });
    expect(await run(p.agent)).toEqual(["from tunnel:claude"]);
    expect(p.named).toEqual(["claude"]);
  });

  test("a type with no published model stays on the main tunnel, and no name is sent", async () => {
    const p = pod(spawn({ subagent_type: "general" }), { publishedModels: published });
    expect(await run(p.agent)).toEqual(["from parent model"]);
    expect(p.named).toEqual([]);
  });

  test("the agent_task description lists the published selectable models", async () => {
    const p = pod(spawn({ subagent_type: "general" }), { publishedModels: published });
    await run(p.agent);
    expect(descriptionOf(p.tunnel)).toContain(
      "Available models (optional `model` argument; omit it to use the sub-agent type's own model):\n- claude: Strong.",
    );
    expect(descriptionOf(p.tunnel)).not.toContain("- fast");
  });

  test("a model published for a type but not selectable is an error when the call names it", async () => {
    const p = pod(spawn({ subagent_type: "explore", model: "fast" }), {
      publishedModels: published,
    });
    const [result] = await run(p.agent);
    expect(result).toContain('unknown model "fast"');
    expect(p.named).toEqual([]);
  });

  test("nothing published: every child on the main tunnel, no list", async () => {
    const p = pod(spawn({ subagent_type: "explore", model: "claude" }));
    expect(await run(p.agent)).toEqual(["from parent model"]);
    expect(p.named).toEqual([]);
    expect(descriptionOf(p.tunnel)).not.toContain("Available models");
  });

  test("the pod's OWN models are ignored, with one daemon-log notice", async () => {
    // Mutation: give the pod path task 3's resolver → the explore child runs on fast-id → red.
    const own = withModels({ selectableModels: ["claude"] });
    const p = pod(spawn({ subagent_type: "explore", model: "claude" }), {
      models: own.models,
      subagentModels: own.subagentModels,
      selectableModels: own.selectableModels,
    });
    expect(await run(p.agent)).toEqual(["from parent model"]);
    expect(p.f.made).toEqual([]);
    expect(p.named).toEqual([]);
    expect(p.lines).toEqual([
      "models: this pod's own models, subagents.types and selectableModels are ignored; the laptop's published models apply",
    ]);
  });

  test("a pod's own agents/*.md `model` naming a published entry is IGNORED (owner Q3 b)", async () => {
    // Mutation: pass `frontmatterModel: type.model` in tunnelSubagentResolver → tunnel:fast → red.
    const agents = join(dir, "pod-agents");
    await mkdir(agents, { recursive: true });
    await writeFile(
      join(agents, "scout.md"),
      "---\nname: scout\ndescription: Scout.\nmodel: fast\ncontextWindow: 9000\n---\nScout.",
    );
    const p = pod(spawn({ subagent_type: "scout" }), {
      publishedModels: published,
      packageAgentDirs: [agents],
    });
    expect(await run(p.agent)).toEqual(["from parent model"]);
    expect(p.named).toEqual([]);
    expect(p.f.made).toEqual([]);
  });

  test("a published type the pod does not have is said in the daemon log", async () => {
    const p = pod(spawn({ subagent_type: "general" }), {
      publishedModels: { ...published, types: [{ type: "reviewr", model: "fast" }] },
    });
    await run(p.agent);
    expect(p.lines.join("\n")).toContain('subagents.types.reviewr: no sub-agent type "reviewr"');
  });
});
