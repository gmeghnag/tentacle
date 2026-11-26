/**
 * `container_preview` is the SESSION's tool, never a child's
 * (docs/feat/container-apps-devices.md OD2): an exposure is asked for by the
 * conversation the owner watches. Mutation: drop the name from either of
 * `subagent.ts`'s filters → red.
 */
import { describe, expect, test } from "bun:test";
import {
  CONTAINER_PREVIEW_TOOL,
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
const preview: Tool<unknown> = {
  name: CONTAINER_PREVIEW_TOOL,
  description: CONTAINER_PREVIEW_TOOL,
  inputSchema: z.unknown(),
  permission: "none",
  concurrency: () => [{ mode: "write", resource: "previews" }],
  execute: async () => ({ content: "done" }),
};

const parentRegistry = (): ToolRegistry =>
  new ToolRegistry().register(fsReadTool).register(preview);

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

describe("a child agent is never offered container_preview", () => {
  test('a `general` child (tools: "all") does not get it', async () => {
    const offered: string[][] = [];
    const { run } = createSubagentRunner({
      model: recorder(offered),
      env,
      tools: parentRegistry(),
      types: BUILTIN_AGENT_TYPES,
    });
    await run({ description: "d", prompt: "go", type: "general" });
    expect(offered[0]).not.toContain(CONTAINER_PREVIEW_TOOL);
    expect(offered[0]).toContain("fs_read");
  });

  test("a type naming it does not get it, and stays read-only", async () => {
    const offered: string[][] = [];
    const { run, readOnlyType } = createSubagentRunner({
      model: recorder(offered),
      env,
      tools: parentRegistry(),
      types: [
        {
          name: "names-it",
          description: "an agents/*.md that lists the tool",
          prompt: "p",
          tools: ["fs_read", CONTAINER_PREVIEW_TOOL],
        },
      ],
    });
    await run({ description: "d", prompt: "go", type: "names-it" });
    expect(offered[0]).toEqual(["fs_read"]);
    expect(readOnlyType("names-it")).toBe(true);
  });
});
