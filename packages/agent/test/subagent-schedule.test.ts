/**
 * `schedule_create` / `schedule_control` are the PARENT's tools, never a child's
 * (docs/feat/cron-tool.md P4): the table is the SESSION's, and a fired wake
 * starts a turn of the main agent. A child given them could arm wakes for a
 * conversation it is not, or delete the parent's. `general` is `tools: "all"`,
 * so only the "never a child" filter in `subagent.ts` can drop them — pinned
 * here BY NAME against a parent registry that really holds both (real tools,
 * over a link that is never reached).
 */
import { describe, expect, test } from "bun:test";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import {
  ToolRegistry,
  createScheduleControlTool,
  createScheduleCreateTool,
  fsReadTool,
} from "@tentacle/tools";
import { BUILTIN_AGENT_TYPES, createSubagentRunner } from "../src/subagent.ts";

const env: ExecutionEnvironment = {
  id: "rec",
  exec: async () => ({ stdout: "ran", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

function parentRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(fsReadTool)
    .register(createScheduleCreateTool(() => null))
    .register(createScheduleControlTool(() => null));
}

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

describe("cron-tool P4: a child agent is never offered the schedule tools", () => {
  test('a `general` child (tools: "all") gets neither, from a parent that holds both', async () => {
    const offered: string[][] = [];
    const { run } = createSubagentRunner({
      model: recorder(offered),
      env,
      tools: parentRegistry(),
      types: BUILTIN_AGENT_TYPES,
    });
    await run({ description: "d", prompt: "go", type: "general" });
    expect(offered[0]).not.toContain("schedule_create");
    expect(offered[0]).not.toContain("schedule_control");
    // Non-vacuity: another parent tool IS offered.
    expect(offered[0]).toContain("fs_read");
  });

  test("an explicit type naming them still does not get them", async () => {
    const offered: string[][] = [];
    const { run } = createSubagentRunner({
      model: recorder(offered),
      env,
      tools: parentRegistry(),
      types: [
        {
          name: "names-them",
          description: "an agents/*.md that lists the tools",
          prompt: "p",
          tools: ["fs_read", "schedule_create", "schedule_control"],
        },
      ],
    });
    await run({ description: "d", prompt: "go", type: "names-them" });
    expect(offered[0]).toEqual(["fs_read"]);
  });
});
