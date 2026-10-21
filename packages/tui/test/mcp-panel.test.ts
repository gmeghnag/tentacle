import { describe, expect, test } from "bun:test";
import {
  type McpPanel,
  type McpServerView,
  applyPanel,
  loadPanel,
  openPanel,
  panelClick,
  panelHeight,
  panelKey,
  panelMaxBody,
  panelRows,
  panelView,
} from "../src/mcp-panel.ts";

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
      expect(back.expanded).toEqual([]);
      expect(texts(back)[0]?.startsWith("❯ ▸ github")).toBe(true);
    }
  });

  test("→ only expands, ← only collapses (no toggling by accident)", () => {
    const p = loadPanel([github]);
    const open = applyPanel(p, "expand");
    expect(applyPanel(open, "expand")).toEqual(open);
    expect(applyPanel(p, "collapse")).toEqual(p);
    expect(applyPanel(open, "collapse").expanded).toEqual([]);
  });

  test("up/down wrap around", () => {
    const p = loadPanel([github, db, fs]);
    expect(applyPanel(p, "up").cursor).toBe(2);
    expect(applyPanel(applyPanel(p, "up"), "down").cursor).toBe(0);
  });

  test("a failed server expands to its error; a truncated list shows how many more", () => {
    const big: McpServerView = { ...github, name: "big", tools: ["a"], moreTools: 300 };
    let p = applyPanel(loadPanel([db, big]), "toggle");
    p = applyPanel(applyPanel(p, "down"), "down");
    p = applyPanel(p, "toggle");
    expect(panelRows(p)).toEqual([
      { kind: "server", server: 0 },
      { kind: "info", server: 0, text: "spawn ENOENT" },
      { kind: "server", server: 1 },
      { kind: "tool", server: 1, name: "a" },
      { kind: "more", server: 1, count: 300 },
    ]);
    expect(texts(p)).toContain("        … 300 more");
    expect(texts(p)[2]).toBe("❯ ▾ big  ● connected · 301 tools · 41 ms");
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
    const p: McpPanel = { servers: [stuck, empty, wait], expanded: [0, 1, 2], cursor: 0 };
    expect(panelRows(p).filter((r) => r.kind !== "server")).toEqual([
      { kind: "info", server: 0, text: "timed out" },
      { kind: "tool", server: 0, name: "t" },
      { kind: "info", server: 1, text: "no tools" },
      { kind: "info", server: 2, text: "still connecting" },
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
    const all = texts({ servers: [evil], expanded: [0], cursor: 0 }).join("\n");
    expect(all).toContain("ab");
    expect(all).toContain("xy");
    expect(all).toContain("er");
    expect(all).not.toMatch(/[​-‏‪-‮⁠-⁩]/);
  });

  test("every row fits the width (one terminal row each)", () => {
    const long: McpServerView = { ...github, tools: ["t".repeat(200)] };
    const rows = texts({ servers: [long], expanded: [0], cursor: 0 }, 30);
    for (const r of rows) {
      expect(r.length).toBeLessThanOrEqual(30);
    }
    expect(rows[1]?.endsWith("…")).toBe(true);
  });

  test("a long list is windowed on the cursor, and the hint says where", () => {
    const many: McpServerView = { ...github, tools: Array.from({ length: 40 }, (_, i) => `t${i}`) };
    let p: McpPanel = { servers: [many], expanded: [0], cursor: 0 };
    let view = panelView(p, 80, 5);
    expect(view.rows.length).toBe(5);
    expect(view.start).toBe(0);
    expect(view.hint).toContain("1–5 of 41");
    p = { ...p, cursor: 30 };
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
    expect(clicked.cursor).toBe(1);
    expect(clicked.expanded).toEqual([1]);
    expect(panelClick(p, view, -1)).toBe(p);
    expect(panelClick(p, view, 2)).toBe(p);
    // A tool row: selected, nothing toggles.
    const open = applyPanel(p, "toggle");
    const tool = panelClick(open, panelView(open, 80, 10), 2);
    expect(tool.cursor).toBe(2);
    expect(tool.expanded).toEqual([0]);
  });

  test("a click maps through the window (body row 0 is the window's first row)", () => {
    const many: McpServerView = { ...github, tools: Array.from({ length: 40 }, (_, i) => `t${i}`) };
    const p: McpPanel = { servers: [many, fs], expanded: [0], cursor: 41 };
    const view = panelView(p, 80, 5);
    const last = panelClick(p, view, 4); // the fs row, at the window's bottom
    expect(last.cursor).toBe(41);
    expect(last.expanded).toEqual([0, 1]);
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
