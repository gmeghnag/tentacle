/**
 * `agent_task`'s optional `model` (docs/feat/models-map.md part B): offered
 * only when `subagents.selectableModels` lists names; a listed name reaches the
 * runner, any other is an error result and no sub-agent starts. Off: the tool
 * is exactly what it was. Driven through the registry, as the agent calls it.
 */
import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@tentacle/core";
import { ToolRegistry } from "../src/registry.ts";
import { type TaskRunResult, createTaskTool } from "../src/task.ts";

const ctx = { sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;
const TYPES = [
  { name: "general", description: "all tools" },
  { name: "explore", description: "read-only" },
];
const NEUTRAL =
  "Delegate a self-contained task to a sub-agent that runs in its own isolated context and returns a final report. You do NOT see its intermediate steps, so it offloads read-heavy work without filling your own context. To create agents, use this tool. Start another agent CLI (claude, codex, tentacle, …) through the shell only when the user explicitly asks for it. Scope each prompt: the files, diff or questions it owns, and a stop criterion — what counts as done. Turn-based: one foreground sub-agent at a time, its report the call's result. Long-lived: `background: true`, then `agent_control` to steer it while it works.";
const TYPE_LIST = "\n\nAvailable sub-agent types:\n- general: all tools\n- explore: read-only";

function spy() {
  const calls: { type: string; model?: string }[] = [];
  const run = async (opts: {
    description: string;
    prompt: string;
    type: string;
    model?: string;
  }) => {
    calls.push({ type: opts.type, ...(opts.model !== undefined ? { model: opts.model } : {}) });
    return { report: "ok", toolUses: 0, stopReason: "end_turn" } satisfies TaskRunResult;
  };
  return { run, calls };
}

const call = (registry: ToolRegistry, args: unknown) =>
  registry.execute("agent_task", JSON.stringify(args), ctx);

const schemaKeys = (registry: ToolRegistry): string[] => {
  const def = registry.definitions().find((d) => d.name === "agent_task");
  return Object.keys((def?.parameters as { properties?: object } | undefined)?.properties ?? {});
};

describe("agent_task without selectable models", () => {
  test("description and schema are exactly today's", () => {
    for (const models of [undefined, []]) {
      const tool = createTaskTool(spy().run, TYPES, { ...(models ? { models } : {}) });
      expect(tool.description).toBe(`${NEUTRAL}${TYPE_LIST}`);
      expect(schemaKeys(new ToolRegistry().register(tool))).toEqual([
        "description",
        "prompt",
        "subagent_type",
      ]);
    }
  });

  test("a stray `model` is stripped like any unknown argument: the runner never sees it", async () => {
    const s = spy();
    const result = await call(new ToolRegistry().register(createTaskTool(s.run, TYPES)), {
      description: "d",
      prompt: "p",
      model: "gpt",
    });
    expect(result.isError).toBeUndefined();
    expect(s.calls).toEqual([{ type: "general" }]);
  });
});

describe("agent_task with selectable models", () => {
  const models = [
    { name: "fast", description: "Small and quick:\n  file   searches." },
    { name: "claude" },
  ];

  test("the description lists them, exact text", () => {
    const tool = createTaskTool(spy().run, TYPES, { models });
    expect(tool.description).toBe(
      `${NEUTRAL}${TYPE_LIST}\n\nAvailable models (optional \`model\` argument; omit it to use the sub-agent type's own model):\n- fast: Small and quick: file searches.\n- claude`,
    );
  });

  test("a custom description keeps both lists", () => {
    const tool = createTaskTool(spy().run, TYPES, { models, description: "Use me." });
    expect(tool.description.startsWith(`Use me.${TYPE_LIST}\n\nAvailable models`)).toBe(true);
  });

  test("the schema offers `model`", () => {
    const registry = new ToolRegistry().register(createTaskTool(spy().run, TYPES, { models }));
    expect(schemaKeys(registry)).toContain("model");
  });

  test("a listed name reaches the runner; none → no model", async () => {
    const s = spy();
    const registry = new ToolRegistry().register(createTaskTool(s.run, TYPES, { models }));
    await call(registry, {
      description: "d",
      prompt: "p",
      subagent_type: "explore",
      model: "fast",
    });
    await call(registry, { description: "d", prompt: "p" });
    expect(s.calls).toEqual([{ type: "explore", model: "fast" }, { type: "general" }]);
  });

  test("an unlisted name is an error result and no sub-agent starts", async () => {
    const s = spy();
    const registry = new ToolRegistry().register(createTaskTool(s.run, TYPES, { models }));
    const result = await call(registry, { description: "d", prompt: "p", model: "gpt-9" });
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      'unknown model "gpt-9" for agent_task — use one of: fast, claude, or omit model',
    );
    expect(s.calls).toEqual([]);
  });
});

describe("agent_task with a harness type (docs/feat/subagent-harness-runners.md D3)", () => {
  const HTYPES = [...TYPES, { name: "claude", description: "Claude Code" }];
  const harnessModels = {
    types: ["claude"],
    note: "for `claude`: an alias or a full id",
    isModel: (m: string) => /^[A-Za-z0-9._:[\]][A-Za-z0-9._:[\]-]{0,63}$/.test(m),
  };
  const registry = (s: ReturnType<typeof spy>, models?: { name: string }[]) =>
    new ToolRegistry().register(
      createTaskTool(s.run, HTYPES, { harnessModels, ...(models ? { models } : {}) }),
    );

  test("`model` is offered with no selectable models, and its text explains the harness's", () => {
    const def = registry(spy())
      .definitions()
      .find((d) => d.name === "agent_task");
    const props = (def?.parameters as { properties?: Record<string, { description?: string }> })
      .properties;
    expect(props?.model?.description).toBe("The model, for `claude`: an alias or a full id.");
  });

  test("a FREE model reaches the runner verbatim for the harness type (never checked against models)", async () => {
    const s = spy();
    const result = await call(registry(s, [{ name: "fast" }]), {
      description: "d",
      prompt: "p",
      subagent_type: "claude",
      model: "claude-sonnet-5-5",
    });
    expect(result.isError).toBeUndefined();
    expect(s.calls).toEqual([{ type: "claude", model: "claude-sonnet-5-5" }]);
  });

  test("a bad shape (a flag) is refused before any child starts", async () => {
    const s = spy();
    const result = await call(registry(s), {
      description: "d",
      prompt: "p",
      subagent_type: "claude",
      model: "--dangerously-skip-permissions",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid model");
    expect(s.calls).toEqual([]);
  });

  test("a model on a tentacle type with no selectable models is an error, not silently dropped", async () => {
    const s = spy();
    const result = await call(registry(s), { description: "d", prompt: "p", model: "opus" });
    expect(result.isError).toBe(true);
    expect(result.content).toBe("model is accepted only for claude — omit it for general");
    expect(s.calls).toEqual([]);
  });

  test("a harness type the runner does not offer gives no free model", () => {
    const tool = createTaskTool(spy().run, TYPES, { harnessModels });
    expect(schemaKeys(new ToolRegistry().register(tool))).toEqual([
      "description",
      "prompt",
      "subagent_type",
    ]);
  });
});
