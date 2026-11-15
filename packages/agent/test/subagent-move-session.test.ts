/**
 * `move_session` is the PARENT's tool, never a child's (docs/feat/session-hop.md
 * D9, slice H5): a proposal is answered by the laptop's own TUI, at the end of the
 * turn it watches. A child's turn is not that turn — `hopProposalStep` is given
 * `own: false` for what a child streams — so a child offered the tool could only
 * answer a `tool_result` claiming "Proposed" that nobody is ever asked about, and
 * the model would be misled. That is the class AGENTS §7 forbids.
 *
 * The filter is `subagent.ts`'s "never given to a child" list. This file pins the
 * tool BY NAME against a parent registry that really holds it, because `general`
 * is `tools: "all"`: every name the list forgets leaks straight through.
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry, fsReadTool, shellTool } from "@tentacle/tools";
import { z } from "zod";
import { BUILTIN_AGENT_TYPES, createSubagentRunner } from "../src/subagent.ts";

function recordingEnv(): ExecutionEnvironment {
  return {
    id: "rec",
    async exec() {
      return { stdout: "ran", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return "FILE CONTENTS";
    },
    async writeFile() {},
  };
}

/** A registry holding real built-ins AND a `move_session` the parent was given. */
function parentRegistry(): ToolRegistry {
  return new ToolRegistry().register(fsReadTool).register(shellTool).register(stubMoveSession());
}

const stubMoveSession = (): Tool => ({
  name: "move_session",
  description: "propose moving this session",
  inputSchema: z.object({ target: z.string() }),
  permission: "none",
  execute: async () => ({ content: "Proposed", isError: false }),
});

/** A model that records the tools each child was actually OFFERED. */
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

describe("H5: a child agent is never offered move_session", () => {
  test('a `general` child (tools: "all") is not offered it, from a parent that holds it', async () => {
    const offered: string[][] = [];
    const { run } = createSubagentRunner({
      model: recorder(offered),
      env: recordingEnv(),
      tools: parentRegistry(),
      // The real type list, so `general` (`tools: "all"`) is the one selected:
      // the case where only the "never a child" filter can drop the name.
      types: BUILTIN_AGENT_TYPES,
    });
    await run({ description: "d", prompt: "go", type: "general" });
    expect(offered[0]?.length).toBeGreaterThan(0);
    // The parent HAD it (`parentRegistry`), so its absence is the filter's doing.
    expect(offered[0]).not.toContain("move_session");
    // Non-vacuity: another parent tool IS offered to a `general` child.
    expect(offered[0]).toContain("fs_read");
  });

  test("an explicit type naming it is still not offered it, and stays read-only", async () => {
    const offered: string[][] = [];
    const { run, readOnlyType } = createSubagentRunner({
      model: recorder(offered),
      env: recordingEnv(),
      tools: parentRegistry(),
      types: [
        {
          name: "names-it",
          description: "an agents/*.md that lists the tool",
          prompt: "p",
          tools: ["fs_read", "move_session"],
        },
      ],
    });
    await run({ description: "d", prompt: "go", type: "names-it" });
    expect(offered[0]).not.toContain("move_session");
    expect(offered[0]).toContain("fs_read");
    // A type naming only tools a child never gets makes it no less read-only.
    expect(readOnlyType("names-it")).toBe(true);
  });
});
