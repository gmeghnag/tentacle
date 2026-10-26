import { describe, expect, test } from "bun:test";
import type { McpServerView } from "../src/mcp-panel.ts";
import {
  type TreePanel as OpenPanel,
  applyPanel as apply,
  panelClick as click,
  mcpPanel,
  panelView,
} from "../src/panel.ts";
import {
  type TreeAction,
  panelHeight,
  treeKey as panelKey,
  panelMaxBody,
} from "../src/tree-panel.ts";

// The `/mcp` panel through the shared panel API (docs/feat/skills-panel.md
// generalised it; the rendered rows are unchanged).
const W = 80;
type McpPanel = OpenPanel;
const openPanel = (): OpenPanel => mcpPanel();
const loadPanel = (servers: readonly McpServerView[]): OpenPanel => mcpPanel(servers);
const applyPanel = (p: OpenPanel, action: TreeAction): OpenPanel => apply(p, action, W);
const panelClick = (p: OpenPanel, view: ReturnType<typeof panelView>, i: number): OpenPanel =>
  click(p, view, i, W);
const at = (servers: readonly McpServerView[], expanded: number[], cursor: number): OpenPanel => ({
  kind: "mcp",
  data: servers,
  tree: { expanded, cursor },
});

const github: McpServerView = {
  name: "github",
  state: "connected",
  tools: ["create_issue", "list_prs", "get_file"],
  moreTools: 0,
  latencyMs: 41,
};
const db: McpServerView = {
  name: "db",
  state: "failed",
  tools: [],
  moreTools: 0,
  error: "spawn ENOENT",
};
const fs: McpServerView = {
  name: "fs",
  state: "connected",
  tools: ["read"],
  moreTools: 0,
  latencyMs: 3,
};

const texts = (p: McpPanel, width = 80, maxBody = 20): string[] =>
  panelView(p, width, maxBody).rows.map((r) => r.text);

describe("mcp panel (docs/feat/mcp-tools-panel.md)", () => {
  test("probing: a placeholder until the answer arrives", () => {
    const view = panelView(openPanel(), 80, 10);
    expect(view.title).toBe("MCP servers · probing…");
    expect(view.rows.map((r) => r.text)).toEqual(["  Asking the daemon…"]);
    expect(panelHeight(view)).toBe(3);
  });

  test("no servers: says so", () => {
    expect(texts(loadPanel([]))).toEqual(["  No MCP servers on this daemon."]);
  });

  test("collapsed: one aligned row per server, cursor on the first, reachable count in the title", () => {
    const view = panelView(loadPanel([github, db, fs]), 80, 10);
    expect(view.title).toBe("MCP servers · 2 of 3 reachable");
    expect(view.rows.map((r) => r.text)).toEqual([
      "❯ ▸ github  ● connected · 3 tools · 41 ms",
      "  ▸ db      ✗ failed",
      "  ▸ fs      ● connected · 1 tool · 3 ms",
    ]);
    expect(view.rows.map((r) => r.selected)).toEqual([true, false, false]);
  });

  test("enter on a server expands it to its tool names; again collapses", () => {
    const open = applyPanel(loadPanel([github, fs]), panelKey("", { return: true }));
    expect(texts(open)).toEqual([
      "❯ ▾ github  ● connected · 3 tools · 41 ms",
      "        create_issue",
      "        list_prs",
      "        get_file",
      "  ▸ fs      ● connected · 1 tool · 3 ms",
    ]);
    expect(texts(applyPanel(open, "toggle"))[0]).toBe("❯ ▸ github  ● connected · 3 tools · 41 ms");
  });

  test("the cursor walks tool rows; enter or ← on one collapses its server and returns to it", () => {
    let p = applyPanel(loadPanel([github, fs]), "toggle");
    p = applyPanel(applyPanel(p, "down"), "down"); // on list_prs
    expect(texts(p)[2]).toBe("❯       list_prs");
    for (const action of ["toggle", "collapse"] as const) {
      const back = applyPanel(p, action);
      expect(back.tree.expanded).toEqual([]);
      expect(texts(back)[0]?.startsWith("❯ ▸ github")).toBe(true);
    }
  });

  test("→ only expands, ← only collapses (no toggling by accident)", () => {
    const p = loadPanel([github]);
    const open = applyPanel(p, "expand");
    expect(applyPanel(open, "expand")).toEqual(open);
    expect(applyPanel(p, "collapse")).toEqual(p);
    expect(applyPanel(open, "collapse").tree.expanded).toEqual([]);
  });

  test("up/down wrap around", () => {
    const p = loadPanel([github, db, fs]);
    expect(applyPanel(p, "up").tree.cursor).toBe(2);
    expect(applyPanel(applyPanel(p, "up"), "down").tree.cursor).toBe(0);
  });

  test("a failed server expands to its error; a truncated list shows how many more", () => {
    const big: McpServerView = { ...github, name: "big", tools: ["a"], moreTools: 300 };
    let p = applyPanel(loadPanel([db, big]), "toggle");
    p = applyPanel(applyPanel(p, "down"), "down");
    p = applyPanel(p, "toggle");
    expect(texts(p)).toEqual([
      "  ▾ db   ✗ failed",
      "        spawn ENOENT",
      "❯ ▾ big  ● connected · 301 tools · 41 ms",
      "        a",
      "        … 300 more",
    ]);
  });

  test("unresponsive/closed show the error then their tools; connected with none says so; connecting says so", () => {
    const stuck: McpServerView = {
      name: "s",
      state: "unresponsive",
      tools: ["t"],
      moreTools: 0,
      error: "timed out",
    };
    const empty: McpServerView = {
      name: "e",
      state: "connected",
      tools: [],
      moreTools: 0,
      latencyMs: 1,
    };
    const wait: McpServerView = { name: "w", state: "connecting", tools: [], moreTools: 0 };
    const p = at([stuck, empty, wait], [0, 1, 2], 0);
    expect(texts(p)).toEqual([
      "❯ ▾ s  ! unresponsive · 1 tool",
      "        timed out",
      "        t",
      "  ▾ e  ● connected · 0 tools · 1 ms",
      "        no tools",
      "  ▾ w  … connecting",
      "        still connecting",
    ]);
  });

  test("daemon strings are display-safe: bidi and zero-width characters dropped", () => {
    const evil: McpServerView = {
      name: "a‮b​",
      state: "unresponsive",
      tools: ["x⁦y"],
      moreTools: 0,
      error: "e‮r",
    };
    const all = texts(at([evil], [0], 0)).join("\n");
    expect(all).toContain("ab");
    expect(all).toContain("xy");
    expect(all).toContain("er");
    expect(all).not.toMatch(/[​-‏‪-‮⁠-⁩]/);
  });

  test("every row fits the width (one terminal row each)", () => {
    const long: McpServerView = { ...github, tools: ["t".repeat(200)] };
    const rows = texts(at([long], [0], 0), 30);
    for (const r of rows) {
      expect(r.length).toBeLessThanOrEqual(30);
    }
    expect(rows[1]?.endsWith("…")).toBe(true);
  });

  test("a long list is windowed on the cursor, and the hint says where", () => {
    const many: McpServerView = { ...github, tools: Array.from({ length: 40 }, (_, i) => `t${i}`) };
    let p = at([many], [0], 0);
    let view = panelView(p, 80, 5);
    expect(view.rows.length).toBe(5);
    expect(view.start).toBe(0);
    expect(view.hint).toContain("1–5 of 41");
    p = at([many], [0], 30);
    view = panelView(p, 80, 5);
    expect(view.rows.length).toBe(5);
    expect(view.rows.find((r) => r.selected)?.text).toBe("❯       t29");
    expect(view.hint).toContain(`${view.start + 1}–${view.start + 5} of 41`);
  });

  test("the body never takes more than about half the terminal", () => {
    expect(panelMaxBody(24)).toBe(10);
    expect(panelMaxBody(8)).toBe(3);
  });

  test("a click selects a row; on a server it also toggles; outside the body nothing", () => {
    const p = loadPanel([github, fs]);
    const view = panelView(p, 80, 10);
    const clicked = panelClick(p, view, 1);
    expect(clicked.tree.cursor).toBe(1);
    expect(clicked.tree.expanded).toEqual([1]);
    expect(panelClick(p, view, -1)).toBe(p);
    expect(panelClick(p, view, 2)).toBe(p);
    // A tool row: selected, nothing toggles.
    const open = applyPanel(p, "toggle");
    const tool = panelClick(open, panelView(open, 80, 10), 2);
    expect(tool.tree.cursor).toBe(2);
    expect(tool.tree.expanded).toEqual([0]);
  });

  test("a click maps through the window (body row 0 is the window's first row)", () => {
    const many: McpServerView = { ...github, tools: Array.from({ length: 40 }, (_, i) => `t${i}`) };
    const p = at([many, fs], [0], 41);
    const view = panelView(p, 80, 5);
    const last = panelClick(p, view, 4); // the fs row, at the window's bottom
    expect(last.tree.cursor).toBe(41);
    expect(last.tree.expanded).toEqual([0, 1]);
  });

  test("clicks and keys on the probing placeholder do nothing", () => {
    const p = openPanel();
    expect(panelClick(p, panelView(p, 80, 10), 0)).toBe(p);
    expect(applyPanel(p, "toggle")).toBe(p);
  });

  test("keys: arrows, enter/space, esc/q; anything else is none", () => {
    expect(panelKey("", { upArrow: true })).toBe("up");
    expect(panelKey("", { downArrow: true })).toBe("down");
    expect(panelKey("", { return: true })).toBe("toggle");
    expect(panelKey(" ", {})).toBe("toggle");
    expect(panelKey("", { rightArrow: true })).toBe("expand");
    expect(panelKey("", { leftArrow: true })).toBe("collapse");
    expect(panelKey("", { escape: true })).toBe("close");
    expect(panelKey("q", {})).toBe("close");
    expect(panelKey("x", {})).toBe("none");
    expect(panelKey("[<0;10;5M", {})).toBe("none"); // a mouse report is not a key
  });
});
