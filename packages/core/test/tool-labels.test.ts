import { describe, expect, test } from "bun:test";
import { toolLabel } from "../src/tool-labels.ts";

describe("toolLabel", () => {
  test("maps every built-in tool name to its display label", () => {
    expect(toolLabel("shell")).toBe("Bash");
    expect(toolLabel("shell_output")).toBe("BashOutput");
    expect(toolLabel("shell_kill")).toBe("BashKill");
    expect(toolLabel("fs_read")).toBe("Read");
    expect(toolLabel("fs_write")).toBe("Write");
    expect(toolLabel("fs_edit")).toBe("Edit");
    expect(toolLabel("fs_multi_edit")).toBe("MultiEdit");
    expect(toolLabel("agent_task")).toBe("Agent");
    expect(toolLabel("skill")).toBe("Skill");
  });

  test("an unknown name (MCP, future tool) displays as itself", () => {
    expect(toolLabel("mcp__x__y")).toBe("mcp__x__y");
  });

  test("an Object.prototype key is not a hit", () => {
    expect(toolLabel("toString")).toBe("toString");
    expect(toolLabel("constructor")).toBe("constructor");
  });
});
