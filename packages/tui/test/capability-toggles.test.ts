/**
 * The `/mcp` and `/skills` on/off switches (docs/feat/session-capabilities.md
 * S4): the pure view-model and key routing. The App only executes what these
 * decide; the frame test in `capability-toggles-app.test.tsx` pins the wiring.
 */
import { describe, expect, test } from "bun:test";
import {
  CAPS_HINT,
  type CapsPhase,
  type CapsView,
  capsMarker,
  capsPhase,
  remoteChangeNotices,
  sessionCapsPhase,
  settled,
} from "../src/capability-toggles.ts";
import type { KeySnapshot } from "../src/keys/snapshot.ts";
import type { McpServerView } from "../src/mcp-panel.ts";
import {
  type TreePanel,
  applyPanel,
  mcpPanel,
  panelSwitchOp,
  panelView,
  skillsPanel,
} from "../src/panel.ts";
import { treeStep } from "../src/panels/tree.ts";
import type { SkillView, SkillsListView } from "../src/skills-panel.ts";

const caps = (disabledMcp: string[] = [], disabledSkills: string[] = []): CapsView => ({
  disabledMcp,
  disabledSkills,
});
const on = (c: CapsView): CapsPhase => ({ kind: "on", caps: c });
const NOT_OPEN: CapsPhase = { kind: "not-open" };
const UNSUPPORTED: CapsPhase = { kind: "unsupported" };

const server = (name: string, over: Partial<McpServerView> = {}): McpServerView => ({
  name,
  state: "connected",
  tools: ["a", "b"],
  moreTools: 0,
  latencyMs: 5,
  ...over,
});
const skill = (name: string, over: Partial<SkillView> = {}): SkillView => ({
  name,
  description: `${name} it`,
  scope: "project",
  user: true,
  model: true,
  location: `/w/${name}/SKILL.md`,
  ...over,
});
const list = (skills: SkillView[], problems: string[] = []): SkillsListView => ({
  skills,
  problems,
  moreProblems: 0,
});

const view = (p: TreePanel, phase?: CapsPhase, width = 80) => panelView(p, width, 30, null, phase);
const texts = (p: TreePanel, phase?: CapsPhase, width = 80): string[] =>
  view(p, phase, width).rows.map((r) => r.text);

describe("the phase: what the panels can do with the switches now", () => {
  test("reported → on; none and not open → not-open; none and open → unsupported", () => {
    expect(capsPhase(caps(), true, true)).toEqual({ kind: "on", caps: caps() });
    expect(capsPhase(undefined, false, true)).toEqual(NOT_OPEN);
    expect(capsPhase(undefined, true, true)).toEqual(UNSUPPORTED);
    // A controller that cannot send a switch never shows one.
    expect(capsPhase(caps(), true, false)).toEqual(UNSUPPORTED);
  });

  test("of a controller: no `setCapability` → unsupported; no `opened` → taken as open", () => {
    const set = async () => ({});
    expect(sessionCapsPhase(null, caps())).toEqual(UNSUPPORTED);
    expect(sessionCapsPhase({}, caps())).toEqual(UNSUPPORTED);
    expect(sessionCapsPhase({ setCapability: set }, undefined)).toEqual(UNSUPPORTED);
    expect(sessionCapsPhase({ setCapability: set, opened: () => false }, undefined)).toEqual(
      NOT_OPEN,
    );
    expect(sessionCapsPhase({ setCapability: set, opened: () => true }, caps(["k8s"]))).toEqual(
      on(caps(["k8s"])),
    );
  });
});

describe("/mcp rows with switches (T1, quiet grammar)", () => {
  const servers = [server("github"), server("k8s"), server("db", { state: "failed", tools: [] })];

  test("a leading [✓]/[ ] per server; an off row is dim; the title and hint say what Space does", () => {
    const v = view(mcpPanel(servers), on(caps(["k8s"])));
    expect(v.rows.map((r) => r.text)).toEqual([
      "❯ ▸ [✓] github  ● 2 tools",
      "  ▸ [ ] k8s     ● 2 tools",
      "  ▸ [✓] db      ✗ failed",
    ]);
    expect(v.rows.map((r) => r.dim === true)).toEqual([false, true, false]);
    expect(v.title).toBe(
      "MCP servers · 2 of 3 reachable · this session · applies to the next model call",
    );
    expect(v.hint).toBe(CAPS_HINT);
  });

  test("no switch column before the session opens, nor with a daemon that has none — the title says why", () => {
    for (const [phase, note] of [
      [NOT_OPEN, "on/off after the first message"],
      [UNSUPPORTED, "on/off not supported by this computer"],
    ] as const) {
      const v = view(mcpPanel(servers), phase);
      expect(v.rows[0]?.text).toBe("❯ ▸ github  ● 2 tools");
      expect(v.title.endsWith(note)).toBe(true);
      expect(v.hint).toBe("↑↓ select · enter expand · esc close");
    }
  });

  test("Space asks to flip the server the cursor is on — from its head or any of its rows", () => {
    const phase = on(caps(["k8s"]));
    const p = mcpPanel(servers);
    expect(panelSwitchOp(p, 80, phase)).toEqual({ kind: "mcp", name: "github", enabled: false });
    const k8s = applyPanel(p, "down", 80);
    expect(panelSwitchOp(k8s, 80, phase)).toEqual({ kind: "mcp", name: "k8s", enabled: true });
    // Expanded, on one of its tool rows: still that server.
    const tool = applyPanel(applyPanel(applyPanel(k8s, "toggle", 80), "down", 80), "down", 80);
    expect(texts(tool, phase)[3]).toBe("❯       a");
    expect(panelSwitchOp(tool, 80, phase)).toEqual({ kind: "mcp", name: "k8s", enabled: true });
  });

  test("Space asks nothing while loading, or when the phase shows no switch", () => {
    expect(panelSwitchOp(mcpPanel(), 80, on(caps()))).toBeNull();
    expect(panelSwitchOp(mcpPanel(servers), 80, NOT_OPEN)).toBeNull();
    expect(panelSwitchOp(mcpPanel(servers), 80, UNSUPPORTED)).toBeNull();
  });

  test("the switch key moves nothing: the panel stays the same object", () => {
    const p = mcpPanel(servers);
    expect(applyPanel(p, "switch", 80)).toBe(p);
  });
});

describe("/skills rows with switches (T1, quiet grammar)", () => {
  const skills = list(
    [
      skill("k8s-debug"),
      skill("dama"),
      skill("commit-msg", { model: false }),
      skill("fresh", { model: false, modelAfterReset: true }),
    ],
    ["skipped skill at /x/SKILL.md: no description"],
  );
  const phase = on(caps([], ["k8s-debug"]));

  test("[ ] off · [✓] on · [–] locked (never the model's); off and locked rows are dim", () => {
    const v = view(skillsPanel(skills), phase);
    expect(v.rows.map((r) => r.text)).toEqual([
      "❯ ▸ [ ] k8s-debug   k8s-debug it",
      "  ▸ [✓] dama        dama it",
      "  ▸ [–] commit-msg  commit-msg it",
      "  ▸ [✓] fresh       fresh it",
      "  ▸ ! 1 discovery problem",
    ]);
    expect(v.rows.map((r) => r.dim === true)).toEqual([true, false, true, false, false]);
    expect(v.title).toBe(
      "Skills · 4 found · 1 problem · this session · applies to the next model call",
    );
  });

  test("expanded: an off skill says the model does not see it, and that the user still can run it", () => {
    const rows = texts(applyPanel(skillsPanel(skills), "toggle", 80), phase);
    expect(rows).toContain(
      "        /k8s-debug · off for the model in this session — you can still run it",
    );
  });

  test("Space: off → on, on → off; nothing on a locked skill or the problems group", () => {
    let p = skillsPanel(skills);
    expect(panelSwitchOp(p, 80, phase)).toEqual({
      kind: "skill",
      name: "k8s-debug",
      enabled: true,
    });
    p = applyPanel(p, "down", 80);
    expect(panelSwitchOp(p, 80, phase)).toEqual({ kind: "skill", name: "dama", enabled: false });
    p = applyPanel(p, "down", 80);
    expect(panelSwitchOp(p, 80, phase)).toBeNull(); // [–] commit-msg
    p = applyPanel(p, "down", 80);
    expect(panelSwitchOp(p, 80, phase)).toEqual({ kind: "skill", name: "fresh", enabled: false });
    p = applyPanel(p, "down", 80);
    expect(panelSwitchOp(p, 80, phase)).toBeNull(); // the problems group
  });

  test("the cursor's group follows the wrapped rows at the panel's width", () => {
    const long = list([skill("a", { description: "word ".repeat(40).trim() }), skill("b")]);
    // Expand `a` at a narrow width: its description wraps to many rows; the
    // last row before `b` still belongs to `a`, and `b`'s head is `b`.
    let p = applyPanel(skillsPanel(long), "toggle", 30);
    const rows = texts(p, phase, 30);
    const bAt = rows.findIndex((r) => r.includes("[✓] b"));
    for (let i = 0; i < bAt - 1; i++) p = applyPanel(p, "down", 30);
    expect(panelSwitchOp(p, 30, on(caps()))).toEqual({ kind: "skill", name: "a", enabled: false });
    p = applyPanel(p, "down", 30);
    expect(panelSwitchOp(p, 30, on(caps()))).toEqual({ kind: "skill", name: "b", enabled: false });
  });
});

describe("the key: Space is the switch, Enter expands", () => {
  const snap = (char: string, key: Partial<KeySnapshot["key"]> = {}): KeySnapshot =>
    ({ char, key }) as unknown as KeySnapshot;

  test("Space → the switch effect (consumed); Enter → expand", () => {
    expect(treeStep(snap(" "))).toEqual({
      effects: [{ kind: "switchCapability" }],
      verdict: "consumed",
      carry: "",
    });
    expect(treeStep(snap("", { return: true })).effects).toEqual([
      { kind: "applyPanel", action: "toggle" },
    ]);
  });
});

describe("the status-line marker (owner Q2)", () => {
  test("only while something is off", () => {
    expect(capsMarker(undefined)).toBeNull();
    expect(capsMarker(caps())).toBeNull();
    expect(capsMarker(caps(["k8s"]))).toBe("⊘ 1 server off");
    expect(capsMarker(caps([], ["a", "b"]))).toBe("⊘ 2 skills off");
    expect(capsMarker(caps(["k8s", "db"], ["a"]))).toBe("⊘ 2 servers · 1 skill off");
  });
});

describe("which reported change is news (owner Q4)", () => {
  const before = caps();
  const after = caps(["veil"]);

  test("another device's change: one notice naming it (untrusted text made display-safe)", () => {
    expect(remoteChangeNotices(before, after, "iPhone‮", [])).toEqual([
      "MCP server veil turned off on iPhone · applies to the next model call",
    ]);
    expect(remoteChangeNotices(caps([], ["s"]), caps(), "mac", [])).toEqual([
      "skill s turned on on mac · applies to the next model call",
    ]);
  });

  test("a snapshot (no `by`) is never news, nor a daemon that has none", () => {
    expect(remoteChangeNotices(undefined, after, undefined, [])).toEqual([]);
    expect(remoteChangeNotices(before, after, undefined, [])).toEqual([]);
    expect(remoteChangeNotices(after, undefined, "iPhone", [])).toEqual([]);
  });

  test("my own set's echo says nothing; another item in the same report still does", () => {
    const mine = { kind: "mcp" as const, name: "veil", enabled: false };
    expect(remoteChangeNotices(before, after, "mac", [mine])).toEqual([]);
    expect(remoteChangeNotices(before, caps(["veil", "k8s"]), "mac", [mine])).toEqual([
      "MCP server k8s turned off on mac · applies to the next model call",
    ]);
    // The opposite op is not my echo.
    expect(remoteChangeNotices(before, after, "mac", [{ ...mine, enabled: true }])).toHaveLength(1);
  });

  test("an answered set leaves the pending list (one entry)", () => {
    const op = { kind: "skill" as const, name: "s", enabled: false };
    expect(settled([op, op], op)).toEqual([op]);
    expect(settled([op], { ...op, enabled: true })).toEqual([op]);
  });
});
