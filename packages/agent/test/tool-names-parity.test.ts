import { describe, expect, test } from "bun:test";
import { ALWAYS_ON_TOOLS, BUILTIN_TOOL_NAMES } from "@tentacle/config";
import * as tools from "@tentacle/tools";

// docs/feat/tool-toggles.md D1 parity pin: the name table in @tentacle/config
// equals the built-ins @tentacle/tools ships. A new built-in cannot ship
// without a table entry, and the table cannot name a tool that is gone. Here
// (not in packages/tools/test): @tentacle/agent is the package that depends on
// both, so it is the one that can import both.
describe("BUILTIN_TOOL_NAMES ≡ the shipped built-ins", () => {
  test("every exported *_TOOL_NAME, builtinTools, agent_task and search — nothing else", () => {
    const exported = Object.entries(tools)
      .filter(([key, value]) => key.endsWith("_TOOL_NAME") && typeof value === "string")
      .map(([, value]) => value as string);
    const shipped = new Set([
      ...exported,
      ...tools.builtinTools.map((t) => t.name),
      tools.searchTool.name,
      "agent_task",
    ]);
    expect([...BUILTIN_TOOL_NAMES].sort()).toEqual([...shipped].sort());
  });

  test("skill is the always-on tool, and it is a built-in", () => {
    expect(ALWAYS_ON_TOOLS).toEqual([tools.SKILL_TOOL_NAME]);
  });
});
