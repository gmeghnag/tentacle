import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@tentacle/core";
import { type TaskRunResult, createTaskTool } from "../src/task.ts";

const ctx = { sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;
const OFF: TaskRunResult = { report: "", toolUses: 0, stopReason: "end_turn" };
const TYPES = [
  { name: "general", description: "all tools" },
  { name: "explore", description: "read-only" },
];

function runnerReturning(result: TaskRunResult) {
  const calls: { description: string; prompt: string; type: string }[] = [];
  const run = async (opts: { description: string; prompt: string; type: string }) => {
    calls.push(opts);
    return result;
  };
  return { run, calls };
}

describe("createTaskTool", () => {
  test("returns the sub-agent's report as the tool result", async () => {
    const { run } = runnerReturning({ report: "all done", toolUses: 2, stopReason: "end_turn" });
    const tool = createTaskTool(run, TYPES);
    const result = await tool.execute(
      { description: "d", prompt: "do it", subagent_type: "explore" },
      ctx,
    );
    expect(result.content).toBe("all done");
    expect(result.isError).toBeUndefined();
  });

  test("hands the calling session's id to the runner (the child's spill is filed under it)", async () => {
    // Mutation: drop `sessionId` from the controls → undefined.
    const seen: (string | undefined)[] = [];
    const tool = createTaskTool(async (_opts, controls) => {
      seen.push(controls?.sessionId);
      return { report: "x", toolUses: 0, stopReason: "end_turn" };
    }, TYPES);
    await tool.execute({ description: "d", prompt: "p" }, ctx);
    expect(seen).toEqual(["s"]);
  });

  test("defaults the type to the first and corrects an invalid one", async () => {
    const { run, calls } = runnerReturning({ report: "x", toolUses: 0, stopReason: "end_turn" });
    const tool = createTaskTool(run, TYPES);
    await tool.execute({ description: "d", prompt: "p" }, ctx); // no type
    await tool.execute({ description: "d", prompt: "p", subagent_type: "bogus" }, ctx);
    expect(calls.map((c) => c.type)).toEqual(["general", "general"]);
  });

  test('an old history\'s "general-purpose" falls back to the default type (no alias)', async () => {
    // feat/subagent-general-rename, eval C2: the type was renamed, and a session
    // log written before that still holds `subagent_type: "general-purpose"`.
    // No alias exists (pre-public, AGENTS §7): the unknown name takes the same
    // path any unknown name takes — the default type.
    const { run, calls } = runnerReturning({ report: "x", toolUses: 0, stopReason: "end_turn" });
    const tool = createTaskTool(run, TYPES);
    const result = await tool.execute(
      { description: "d", prompt: "p", subagent_type: "general-purpose" },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => c.type)).toEqual(["general"]);
  });

  test("with no types at all, the fallback names the built-in type `general`", async () => {
    // task.ts:80 — the literal. Unreachable from the real wiring (the built-ins
    // always exist), but it must name the same type as the built-in.
    const { run, calls } = runnerReturning({ report: "x", toolUses: 0, stopReason: "end_turn" });
    const tool = createTaskTool(run, []);
    await tool.execute({ description: "d", prompt: "p" }, ctx);
    expect(calls.map((c) => c.type)).toEqual(["general"]);
    expect(tool.description).not.toContain("general-purpose");
  });

  test("annotates a cancelled or capped run", async () => {
    const cancelled = createTaskTool(
      runnerReturning({ report: "partial", toolUses: 1, stopReason: "cancelled" }).run,
      TYPES,
    );
    expect((await cancelled.execute({ description: "d", prompt: "p" }, ctx)).content).toContain(
      "cancelled",
    );
    const capped = createTaskTool(
      runnerReturning({ report: "partial", toolUses: 9, stopReason: "max_iterations" }).run,
      TYPES,
    );
    expect((await capped.execute({ description: "d", prompt: "p" }, ctx)).content).toContain(
      "iteration cap",
    );
  });

  test("the tool itself needs no permission and lists the types", () => {
    const tool = createTaskTool(
      runnerReturning({ report: "", toolUses: 0, stopReason: "end_turn" }).run,
      TYPES,
    );
    expect(tool.permission).toBe("none");
    expect(tool.description).toContain("general");
    expect(tool.description).toContain("explore");
    expect(tool.description).not.toContain("general-purpose");
  });
});

// fix/agent-task-scope (1) and (2): the neutral text teaches the parent HOW to
// write the prompt and WHAT this tool is for. The owner's own framing: an
// empty folder + "create two agents" used to shell out to `codex`/`claude -p`,
// and two open-ended "adversarial review" children ran with no scope and no
// stop criterion.
describe("the neutral description tells the parent how to use it", () => {
  const text = createTaskTool(() => Promise.resolve(OFF), TYPES).description;

  test("(1) it asks for a scope and a stop criterion in the prompt it writes", () => {
    expect(text).toContain("Scope each prompt");
    expect(text).toContain("the files, diff or questions it owns");
    expect(text).toContain("a stop criterion — what counts as done");
  });

  test("(2) it says this is THE way to create agents, with a DEFAULT not a ban", () => {
    expect(text).toContain("To create agents, use this tool.");
    expect(text).toContain(
      "To create agents, use this tool. Start another agent CLI (claude, codex, tentacle, …) through the shell only when the user explicitly asks for it.",
    );
  });

  test("(2) it names the two patterns: turn-based, and long-lived", () => {
    expect(text).toContain("Turn-based: one foreground sub-agent at a time");
    expect(text).toContain("Long-lived: `background: true`, then `agent_message`");
  });

  test("a custom text replaces the neutral one whole (no scope, no patterns)", () => {
    const custom = createTaskTool(() => Promise.resolve(OFF), TYPES, {
      description: "Use me well.",
    });
    expect(custom.description.startsWith("Use me well.\n\nAvailable sub-agent types:\n- ")).toBe(
      true,
    );
    expect(custom.description).not.toContain("Scope each prompt");
  });

  test("off (absent or false): no two-way line, exactly as before the flag", () => {
    for (const options of [undefined, { twoWay: false }]) {
      const tool = createTaskTool(() => Promise.resolve(OFF), TYPES, options);
      expect(tool.description).not.toContain("agent_notify");
      expect(tool.description).not.toContain("may wake you");
    }
    const absent = createTaskTool(() => Promise.resolve(OFF), TYPES).description;
    const explicit = createTaskTool(() => Promise.resolve(OFF), TYPES, {
      twoWay: false,
    }).description;
    expect(explicit).toBe(absent);
  });

  test("on: says a background child may reply with agent_notify, and still lists the types", () => {
    const tool = createTaskTool(() => Promise.resolve(OFF), TYPES, { twoWay: true });
    expect(tool.description).toContain(
      "A background sub-agent may reply with `agent_notify`: it arrives as a `[sub-agent sa-N → you]` note and may wake you.",
    );
    expect(tool.description).toContain("\n\nAvailable sub-agent types:\n- general: all tools");
  });

  test("on never rewords a CUSTOM text: it is used as is, the types still follow", () => {
    const custom = createTaskTool(() => Promise.resolve(OFF), TYPES, {
      description: "Use me well.",
      twoWay: true,
    });
    expect(custom.description.startsWith("Use me well.\n\nAvailable sub-agent types:\n- ")).toBe(
      true,
    );
    expect(custom.description).not.toContain("agent_notify");
  });
});
