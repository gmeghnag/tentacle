/**
 * `/tools` (docs/feat/tool-toggles.md D7): the pure switch decisions in
 * `capability-toggles.ts` for the third kind, and the `tools-panel.ts`
 * view-model (rows, expansion, `~tokens`, the off count, what Space asks).
 */
import { describe, expect, test } from "bun:test";
import {
  type CapsPhase,
  type CapsView,
  capsDiff,
  capsMarker,
  groupSwitch,
  remoteChangeNotices,
  switchOp,
  toolSwitch,
  toolsPhase,
} from "../src/capability-toggles.ts";
import {
  applyPanel,
  panelNoSwitchNotice,
  panelSwitchOp,
  panelView,
  toolsPanel,
} from "../src/panel.ts";
import {
  type ToolEntryView,
  toolsGroups,
  toolsItems,
  toolsSwitchOp,
  toolsTitle,
} from "../src/tools-panel.ts";

const caps = (disabledTools?: string[]): CapsView => ({
  disabledMcp: [],
  disabledSkills: [],
  ...(disabledTools !== undefined ? { disabledTools } : {}),
});
const on = (c: CapsView): CapsPhase => ({ kind: "on", caps: c });
const NOT_OPEN: CapsPhase = { kind: "not-open" };

const TOOLS: ToolEntryView[] = [
  { name: "fs_read", tokens: 264 },
  { name: "shell", group: "shell", tokens: 288 },
  { name: "chart", group: "visuals", tokens: 1299 },
  { name: "shell_output", group: "shell", tokens: 96 },
  { name: "diagram", group: "visuals", tokens: 349 },
  { name: "skill", tokens: 40, locked: true },
];

describe("tool switches (capability-toggles.ts)", () => {
  test("toolsPhase: a report without disabledTools means no tool switches (F8)", () => {
    expect(toolsPhase(on(caps()))).toEqual({ kind: "unsupported" });
    expect(toolsPhase(on(caps([]))).kind).toBe("on");
    expect(toolsPhase(NOT_OPEN)).toBe(NOT_OPEN);
  });

  test("toolSwitch: on/off from the report, locked for skill, null without switches", () => {
    expect(toolSwitch(on(caps(["chart"])), { name: "chart" })).toBe("off");
    expect(toolSwitch(on(caps(["chart"])), { name: "diagram" })).toBe("on");
    expect(toolSwitch(on(caps(["skill"])), { name: "skill", locked: true })).toBe("locked");
    expect(toolSwitch(on(caps()), { name: "chart" })).toBeNull();
    expect(toolSwitch(NOT_OPEN, { name: "chart" })).toBeNull();
  });

  test("groupSwitch: on / off / partial from the registered members", () => {
    expect(groupSwitch(on(caps([])), ["chart", "diagram"])).toBe("on");
    expect(groupSwitch(on(caps(["chart", "diagram"])), ["chart", "diagram"])).toBe("off");
    expect(groupSwitch(on(caps(["chart"])), ["chart", "diagram"])).toBe("partial");
    expect(groupSwitch(on(caps([])), [])).toBeNull();
    expect(groupSwitch(on(caps()), ["chart"])).toBeNull();
  });

  test("Space on partial turns the group ON (Q7); on off → on; on on → off", () => {
    expect(switchOp("tool", "visuals", "partial")).toEqual({
      kind: "tool",
      name: "visuals",
      enabled: true,
    });
    expect(switchOp("tool", "visuals", "off")?.enabled).toBe(true);
    expect(switchOp("tool", "visuals", "on")?.enabled).toBe(false);
    expect(switchOp("tool", "skill", "locked")).toBeNull();
  });

  test("capsMarker counts tools off", () => {
    expect(capsMarker(caps(["chart", "diagram"]))).toBe("⊘ 2 tools off");
    expect(capsMarker({ disabledMcp: ["k8s"], disabledSkills: [], disabledTools: ["chart"] })).toBe(
      "⊘ 1 server · 1 tool off",
    );
    expect(capsMarker(caps([]))).toBeNull();
  });

  test("capsDiff and notices cover the third kind; a group op's own echo is no news", () => {
    expect(capsDiff(caps([]), caps(["chart"]))).toEqual([
      { kind: "tool", name: "chart", enabled: false },
    ]);
    // Another device switched a tool off.
    expect(remoteChangeNotices(caps([]), caps(["chart"]), "iPhone", [])).toEqual([
      "tool chart turned off on iPhone · applies to the next model call",
    ]);
    // My own GROUP op echoes one change per member: none of them is news.
    const mine = {
      kind: "tool" as const,
      name: "visuals",
      enabled: false,
      members: ["chart", "diagram"],
    };
    expect(remoteChangeNotices(caps([]), caps(["chart", "diagram"]), "this-mac", [mine])).toEqual(
      [],
    );
    // Without the members the echo would be mistaken for news.
    const bare = { kind: "tool" as const, name: "visuals", enabled: false };
    expect(
      remoteChangeNotices(caps([]), caps(["chart", "diagram"]), "this-mac", [bare]),
    ).toHaveLength(2);
  });
});

describe("tools-panel.ts view-model", () => {
  test("items: a group where its first member is, members in order; ungrouped tools alone", () => {
    expect(
      toolsItems(TOOLS).map((i) =>
        i.kind === "group" ? `${i.name}:${i.members.map((m) => m.name).join("+")}` : i.tool.name,
      ),
    ).toEqual(["fs_read", "shell:shell+shell_output", "visuals:chart+diagram", "skill"]);
  });

  test("rows: switch, name, ~tokens; a group sums its members and counts them; members on expand", () => {
    const groups = toolsGroups(TOOLS, on(caps(["chart"])));
    expect(groups.map((g) => g.head)).toEqual([
      "[✓] fs_read  ~264",
      "[✓] shell    ~384  2 tools",
      "[~] visuals  ~1648  2 tools",
      "[–] skill    ~40  always on",
    ]);
    expect(groups[2]?.children).toEqual(["[ ] chart  ~1299", "[✓] diagram  ~349"]);
    expect(groups[2]?.off).toBeUndefined(); // partial: not dimmed
    const allOff = toolsGroups(TOOLS, on(caps(["chart", "diagram"])));
    expect(allOff[2]?.off).toBe(true);
  });

  test("the title: the cost still offered, the off count, what a switch does", () => {
    expect(toolsTitle(TOOLS, on(caps(["chart"])))).toBe(
      "Tools · ~1037 tokens · 1 off · this session · applies to the next model call",
    );
    // Before the session opens: the list's own flags (the would-be session's set).
    const listed = TOOLS.map((t) => (t.name === "diagram" ? { ...t, disabled: true as const } : t));
    expect(toolsTitle(listed, NOT_OPEN)).toBe(
      "Tools · ~1987 tokens · 1 off · on/off after the first message",
    );
    expect(toolsTitle(TOOLS, on(caps()))).toContain("on/off needs a newer tentacle");
  });

  test("Space: a group head → the group (with its members); a member → that tool; skill → nothing", () => {
    const phase = on(caps([]));
    expect(toolsSwitchOp(TOOLS, phase, 2, null)).toEqual({
      kind: "tool",
      name: "visuals",
      enabled: false,
      members: ["chart", "diagram"],
    });
    expect(toolsSwitchOp(TOOLS, phase, 2, 1)).toEqual({
      kind: "tool",
      name: "diagram",
      enabled: false,
    });
    expect(toolsSwitchOp(TOOLS, phase, 0, null)).toEqual({
      kind: "tool",
      name: "fs_read",
      enabled: false,
    });
    expect(toolsSwitchOp(TOOLS, phase, 3, null)).toBeNull();
    expect(toolsSwitchOp(TOOLS, NOT_OPEN, 0, null)).toBeNull();
  });

  test("through the panel facade: expand a group, Space on a member; notices by phase", () => {
    let panel = toolsPanel(TOOLS);
    const phase = on(caps([]));
    panel = applyPanel(panel, "down", 80); // shell
    panel = applyPanel(panel, "down", 80); // visuals
    panel = applyPanel(panel, "toggle", 80); // expand
    panel = applyPanel(panel, "down", 80); // chart
    expect(panelSwitchOp(panel, 80, phase)).toEqual({
      kind: "tool",
      name: "chart",
      enabled: false,
    });
    const view = panelView(panel, 80, 20, null, phase);
    expect(view.rows.map((r) => r.text)).toContain("❯       [✓] chart  ~1299");
    expect(panelNoSwitchNotice(panel, NOT_OPEN)).toContain("send a first message");
    expect(panelNoSwitchNotice(panel, on(caps()))).toBe(
      "_Tool on/off needs a newer tentacle on this computer._",
    );
    expect(panelNoSwitchNotice(panel, phase)).toBeNull();
  });

  test("loading and empty say so", () => {
    expect(panelView(toolsPanel(), 80, 10).title).toBe("Tools · loading…");
    expect(panelView(toolsPanel([]), 80, 10).rows[0]?.text).toContain("No built-in tools");
  });
});
