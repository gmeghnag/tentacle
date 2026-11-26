/**
 * `app_publish` / `app_unpublish` are the SESSION's tools, never a child's
 * (docs/feat/session-apps-publish.md F1): a child's output is its report, and a
 * public page is asked for by the conversation the owner watches. Pinned against
 * a parent registry that really holds both names. Mutation: drop either name
 * from `subagent.ts`'s filters → red.
 */
import { describe, expect, test } from "bun:test";
import {
  APP_PUBLISH_TOOL,
  APP_UNPUBLISH_TOOL,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import { ToolRegistry, fsReadTool } from "@tentacle/tools";
import { z } from "zod";
import { BUILTIN_AGENT_TYPES, createSubagentRunner } from "../src/subagent.ts";

const env: ExecutionEnvironment = {
  id: "rec",
  exec: async () => ({ stdout: "ran", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

/** A tool of that name that would be dangerous in a child: not read-only. */
const named = (name: string): Tool<unknown> => ({
  name,
  description: name,
  inputSchema: z.unknown(),
  permission: "none",
  concurrency: () => [{ mode: "write", resource: "apps" }],
  execute: async () => ({ content: "done" }),
});

const parentRegistry = (): ToolRegistry =>
  new ToolRegistry()
    .register(fsReadTool)
    .register(named(APP_PUBLISH_TOOL))
    .register(named(APP_UNPUBLISH_TOOL));

function recorder(offered: string[][]): ModelProvider {
  return {
    id: "rec",
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      offered.push((request.tools ?? []).map((tool) => tool.name));
      yield { type: "text", delta: "report" };
      yield { type: "done" };
    },
  };
}

describe("a child agent is never offered the app tools", () => {
  test('a `general` child (tools: "all") gets neither', async () => {
    const offered: string[][] = [];
    const { run } = createSubagentRunner({
      model: recorder(offered),
      env,
      tools: parentRegistry(),
      types: BUILTIN_AGENT_TYPES,
    });
    await run({ description: "d", prompt: "go", type: "general" });
    expect(offered[0]).not.toContain(APP_PUBLISH_TOOL);
    expect(offered[0]).not.toContain(APP_UNPUBLISH_TOOL);
    expect(offered[0]).toContain("fs_read");
  });

  test("a type naming them does not get them, and stays read-only", async () => {
    const offered: string[][] = [];
    const { run, readOnlyType } = createSubagentRunner({
      model: recorder(offered),
      env,
      tools: parentRegistry(),
      types: [
        {
          name: "names-them",
          description: "an agents/*.md that lists the tools",
          prompt: "p",
          tools: ["fs_read", APP_PUBLISH_TOOL, APP_UNPUBLISH_TOOL],
        },
      ],
    });
    await run({ description: "d", prompt: "go", type: "names-them" });
    expect(offered[0]).toEqual(["fs_read"]);
    expect(readOnlyType("names-them")).toBe(true);
  });
});
