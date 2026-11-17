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
    expect(toolLabel("search")).toBe("Search");
    expect(toolLabel("agent_task")).toBe("Agent");
    expect(toolLabel("skill")).toBe("Skill");
    // `present` (docs/feat/model-artifacts.md S6a): the card's header reads
    // `Present`, so it has to be a label rather than the raw tool name.
    expect(toolLabel("present")).toBe("Present");
    expect(toolLabel("schedule_create")).toBe("Schedule");
    expect(toolLabel("schedule_control")).toBe("Schedules");
    // docs/feat/model-charts.md D3: the chart row reads `Chart`.
    expect(toolLabel("chart")).toBe("Chart");
    // docs/feat/model-diagrams.md D2: a diagram is shown, never acted on either.
    expect(toolLabel("diagram")).toBe("Diagram");
  });

  test("an unknown name (MCP, future tool) displays as itself", () => {
    expect(toolLabel("mcp__x__y")).toBe("mcp__x__y");
  });

  test("an Object.prototype key is not a hit", () => {
    expect(toolLabel("toString")).toBe("toString");
    expect(toolLabel("constructor")).toBe("constructor");
  });
});
