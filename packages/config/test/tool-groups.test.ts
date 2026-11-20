import { describe, expect, test } from "bun:test";
import {
  BUILTIN_TOOL_NAMES,
  TOOL_GROUPS,
  disabledToolsOf,
  expandToolName,
  groupOfTool,
  toolToggleIssues,
  toolToggleNotices,
} from "../src/tool-groups.ts";

// Built-in tool switches (docs/feat/tool-toggles.md D1): the name table and
// the `tools.enabled` resolution.

const ALL_ON = { subagents: true, contextReset: true, sessionHop: true, workloadShell: true };

describe("tool groups", () => {
  test("a group expands to its members, a tool to itself, skill and unknown to undefined", () => {
    expect(expandToolName("visuals")).toEqual(["chart", "diagram", "present"]);
    expect(expandToolName("shell")).toEqual(["shell", "shell_output", "shell_kill"]);
    expect(expandToolName("fs_multi_edit")).toEqual(["fs_multi_edit"]);
    expect(expandToolName("context_reset")).toEqual(["context_reset"]);
    expect(expandToolName("skill")).toBeUndefined();
    expect(expandToolName("fs_mult_edit")).toBeUndefined();
    expect(expandToolName("toString")).toBeUndefined();
  });

  test("groupOfTool reads the table; an ungrouped tool has none", () => {
    expect(groupOfTool("agent_notify")).toBe("subagents");
    expect(groupOfTool("present")).toBe("visuals");
    expect(groupOfTool("fs_read")).toBeUndefined();
    expect(groupOfTool("skill")).toBeUndefined();
  });

  test("BUILTIN_TOOL_NAMES holds every group member and skill, sorted", () => {
    for (const members of Object.values(TOOL_GROUPS)) {
      for (const m of members) expect(BUILTIN_TOOL_NAMES).toContain(m);
    }
    expect(BUILTIN_TOOL_NAMES).toContain("skill");
    expect([...BUILTIN_TOOL_NAMES]).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });
});

describe("disabledToolsOf", () => {
  test("groups expand; the result is sorted and de-duplicated", () => {
    expect(disabledToolsOf({ visuals: false, chart: false, fs_multi_edit: false })).toEqual([
      "chart",
      "diagram",
      "fs_multi_edit",
      "present",
    ]);
  });

  test("a single tool beats its group, in both directions (Q2), whatever the key order", () => {
    expect(disabledToolsOf({ agent_task: true, subagents: false })).toEqual([
      "agent_control",
      "agent_kill",
      "agent_message",
      "agent_notify",
      "agent_status",
    ]);
    expect(disabledToolsOf({ subagents: true, agent_task: false })).toEqual(["agent_task"]);
  });

  test("true alone disables nothing; skill and unknown names are ignored", () => {
    expect(disabledToolsOf({ visuals: true })).toEqual([]);
    expect(disabledToolsOf({ skill: false, nope: false })).toEqual([]);
  });
});

describe("toolToggleIssues", () => {
  test("an unknown name is an issue naming it and the valid names", () => {
    const [issue] = toolToggleIssues({ fs_mult_edit: false });
    expect(issue).toContain("tools.enabled.fs_mult_edit");
    expect(issue).toContain("visuals");
    expect(issue).toContain("fs_multi_edit");
  });

  test("skill is an issue: it is always on", () => {
    expect(toolToggleIssues({ skill: false })).toEqual([
      "tools.enabled.skill: skill is always on and cannot be switched",
    ]);
  });

  test("known names are fine", () => {
    expect(toolToggleIssues({ visuals: false, fs_read: true, agent_notify: false })).toEqual([]);
  });
});

describe("toolToggleNotices", () => {
  test("true on a tool whose feature switch is off → one notice per switch", () => {
    const enabled = {
      subagents: true,
      context_reset: true,
      move_session: true,
      workload_shell: true,
    };
    expect(
      toolToggleNotices(enabled, {
        subagents: false,
        contextReset: false,
        sessionHop: false,
        workloadShell: false,
      }),
    ).toEqual([
      "tools.enabled: subagents has no effect — subagents.enabled is off",
      "tools.enabled: context_reset has no effect — contextReset.enabled is off",
      "tools.enabled: move_session has no effect — sessionHop.tool is off",
      "tools.enabled: workload_shell has no effect — workloadShell.tool is off",
    ]);
    expect(toolToggleNotices(enabled, ALL_ON)).toEqual([]);
  });

  test("a member name reads its group's switch; false never notices", () => {
    expect(
      toolToggleNotices(
        { agent_task: true, workload_shell: false },
        { ...ALL_ON, subagents: false, workloadShell: false },
      ),
    ).toEqual(["tools.enabled: agent_task has no effect — subagents.enabled is off"]);
  });
});
