/**
 * The TUI's `/browser` decisions (docs/feat/browser-inspect.md B6a), as a table
 * over every mockup state: the panel's rows and switches, the status-bar sign,
 * the `/browser <word>` shortcuts, and the `⊘ N tools off` marker.
 */
import { describe, expect, test } from "bun:test";
import { TOOL_GROUPS } from "@tentacle/core";
import type { BrowserStatusResult } from "@tentacle/protocol";
import {
  browserCommandStep,
  browserDoneKey,
  browserPanelRows,
  browserStatusSign,
  browserSubcommand,
} from "../src/browser-view.ts";
import { type CapsPhase, type CapsView, capsMarker } from "../src/capability-toggles.ts";
import { statusLayout } from "../src/status-line.ts";
import { contextMeterView } from "../src/status-line.ts";

const MEMBERS = TOOL_GROUPS.browser ?? [];

const caps = (
  over: {
    secrets?: "masked" | "clear";
    actions?: "ask" | "auto";
    off?: readonly string[];
    noBrowser?: boolean;
  } = {},
): CapsView => {
  const off = over.off ?? [];
  return {
    disabledMcp: [],
    disabledSkills: [],
    disabledTools: off,
    ...(over.noBrowser === true
      ? {}
      : {
          browser: {
            enabled: !MEMBERS.some((m) => off.includes(m)),
            secrets: over.secrets ?? "masked",
            actions: over.actions ?? "ask",
          },
        }),
  };
};

const tab = (id: number, handedOver = false) => ({
  id,
  title: `Page ${id}`,
  where: `example.com/p${id}`,
  handedOver,
  traced: false,
});

const connected: BrowserStatusResult = {
  available: true,
  link: { state: "connected", managed: false },
  tabs: [tab(1), tab(2, true)],
};

const heads = (c: CapsView | undefined, s: BrowserStatusResult | null) =>
  browserPanelRows(c, s).rows.map((r) => r.head);

describe("browserPanelRows", () => {
  test("connected, defaults: title with the link, tools on, auto and clear off, the tabs", () => {
    const view = browserPanelRows(caps(), connected);
    expect(view.title).toBe(
      "Browser · ◉ connected · this session · applies to the next model call",
    );
    expect(view.rows.map((r) => r.head)).toEqual([
      "[✓] Browser tools",
      "[ ] Act without asking",
      "[ ] Show secrets",
      "Tabs · 2",
      "#1 Page 1 — example.com/p1 · Opened by the agent",
      "#2 Page 2 — example.com/p2 · Handed over by you · acting asks first",
    ]);
    expect(view.rows.map((r) => r.op)).toEqual([
      { kind: "tool", name: "browser", enabled: false, members: MEMBERS },
      { kind: "browser", name: "auto", enabled: true },
      { kind: "browser", name: "clear", enabled: true },
      null,
      null,
      null,
    ]);
  });

  test("auto + clear on: both checked, Space turns each back off", () => {
    const view = browserPanelRows(caps({ actions: "auto", secrets: "clear" }), connected);
    expect(view.rows.slice(1, 3).map((r) => r.head)).toEqual([
      "[✓] Act without asking",
      "[✓] Show secrets",
    ]);
    expect(view.rows.slice(1, 3).map((r) => r.op)).toEqual([
      { kind: "browser", name: "auto", enabled: false },
      { kind: "browser", name: "clear", enabled: false },
    ]);
  });

  test("tools off: auto and clear are locked (stored values kept, not shown), nothing to flip", () => {
    const view = browserPanelRows(
      caps({ actions: "auto", secrets: "clear", off: MEMBERS }),
      connected,
    );
    expect(view.rows.slice(0, 3).map((r) => r.head)).toEqual([
      "[ ] Browser tools",
      "[–] Act without asking  browser tools off",
      "[–] Show secrets  browser tools off",
    ]);
    expect(view.rows.slice(0, 3).map((r) => r.op)).toEqual([
      { kind: "tool", name: "browser", enabled: true, members: MEMBERS },
      null,
      null,
    ]);
    expect(view.rows.slice(1, 3).map((r) => r.off)).toEqual([true, true]);
  });

  test("a partly-off group: [~], and auto stays reachable (it still answers the rest)", () => {
    const view = browserPanelRows(caps({ actions: "auto", off: ["browser_net"] }), connected);
    expect(view.rows[0]?.head).toBe("[~] Browser tools");
    expect(view.rows[1]?.head).toBe("[✓] Act without asking");
    expect(view.rows[1]?.op).toEqual({ kind: "browser", name: "auto", enabled: false });
  });

  test("not running / extension missing / not installed / managed: the title says it", () => {
    const at = (state: "not_running" | "extension_missing" | "not_installed", managed = false) =>
      browserPanelRows(caps(), { available: true, link: { state, managed }, tabs: [] }).title;
    expect(at("not_running")).toContain("○ Chrome not running");
    expect(at("extension_missing")).toContain("✕ extension missing");
    expect(at("not_installed")).toContain("✕ not installed — run tentacle browser install");
    expect(at("extension_missing", true)).toContain("managed by your organization");
  });

  test("no tabs, an unread status and a held browser are three different rows", () => {
    expect(heads(caps(), { ...connected, tabs: [] }).slice(3)).toEqual(["No tabs"]);
    expect(heads(caps(), null).slice(3)).toEqual(["Tabs unknown"]);
    expect(heads(caps(), { ...connected, heldElsewhere: true, tabs: [] }).slice(3)).toEqual([
      "Another tentacle process holds the browser · tabs not listed",
    ]);
    expect(browserPanelRows(caps(), null).title).toContain("Browser · unknown");
  });

  test("tab text from the page is one clean line", () => {
    const row = heads(caps(), {
      ...connected,
      tabs: [{ ...tab(1), title: "a\nb‮ c\u001b[31m", where: "x.test/\r\ny" }],
    })[4];
    expect(row).toBe("#1 a b c [31m — x.test/ y · Opened by the agent");
  });

  test("the row COUNT does not depend on the switches (the cursor walks the data alone)", () => {
    for (const c of [caps(), caps({ off: MEMBERS }), undefined]) {
      expect(browserPanelRows(c, connected).rows).toHaveLength(6);
    }
  });
});

describe("browserStatusSign", () => {
  test("on, defaults: the tab count, no warning", () => {
    expect(browserStatusSign(caps(), connected)).toEqual({
      text: "◉ chrome 2 tabs",
      warnings: [],
    });
    expect(browserStatusSign(caps(), { ...connected, tabs: [tab(1)] })?.text).toBe(
      "◉ chrome 1 tab",
    );
    expect(browserStatusSign(caps(), { ...connected, tabs: [] })?.text).toBe("◉ chrome 0 tabs");
  });

  test("auto and clear appear ONLY when on, in glyph and upper case", () => {
    expect(browserStatusSign(caps({ actions: "auto" }), connected)?.warnings).toEqual(["▲ AUTO"]);
    expect(browserStatusSign(caps({ secrets: "clear" }), connected)?.warnings).toEqual([
      "▲ SECRETS VISIBLE",
    ]);
    expect(
      browserStatusSign(caps({ actions: "auto", secrets: "clear" }), connected)?.warnings,
    ).toEqual(["▲ AUTO", "▲ SECRETS VISIBLE"]);
  });

  test("a list that was not read shows no count (never «0 tabs»)", () => {
    expect(browserStatusSign(caps(), null)?.text).toBe("◉ chrome");
    expect(browserStatusSign(caps(), { ...connected, heldElsewhere: true, tabs: [] })?.text).toBe(
      "◉ chrome",
    );
  });

  test("a partly-off group keeps the AUTO warning", () => {
    expect(
      browserStatusSign(caps({ actions: "auto", off: ["browser_net"] }), connected)?.warnings,
    ).toEqual(["▲ AUTO"]);
  });

  test("off, unavailable or unreported: nothing", () => {
    expect(browserStatusSign(caps({ actions: "auto", off: MEMBERS }), connected)).toBeNull();
    expect(browserStatusSign(caps({ noBrowser: true }), connected)).toBeNull();
    expect(browserStatusSign(undefined, connected)).toBeNull();
  });
});

describe("browserSubcommand", () => {
  test("every word", () => {
    expect(browserSubcommand("")).toEqual({ kind: "panel" });
    expect(browserSubcommand("on")).toEqual({
      kind: "op",
      op: { kind: "tool", name: "browser", enabled: true, members: MEMBERS },
    });
    expect(browserSubcommand("off")).toEqual({
      kind: "op",
      op: { kind: "tool", name: "browser", enabled: false, members: MEMBERS },
    });
    const op = (name: string, enabled: boolean) => ({
      kind: "op" as const,
      op: { kind: "browser" as const, name, enabled },
    });
    expect(browserSubcommand("auto")).toEqual(op("auto", true));
    expect(browserSubcommand("ask")).toEqual(op("auto", false));
    expect(browserSubcommand("clear")).toEqual(op("clear", true));
    expect(browserSubcommand("masked")).toEqual(op("clear", false));
  });

  test("anything else is the usage", () => {
    for (const word of ["yes", "auto now", "ON"]) {
      expect(browserSubcommand(word)).toEqual({ kind: "usage" });
    }
  });
});

describe("browserCommandStep", () => {
  const on = (c: CapsView, firstMessage = false): CapsPhase =>
    firstMessage ? { kind: "on", caps: c, firstMessage: true } : { kind: "on", caps: c };
  const notice = (raw: string, phase: CapsPhase): string => {
    const step = browserCommandStep(raw, phase);
    return step.kind === "notice" ? step.text : `(${step.kind})`;
  };

  test("no browser in the session: said, nothing sent", () => {
    for (const raw of ["/browser", "/browser auto"]) {
      expect(notice(raw, on(caps({ noBrowser: true })))).toBe("_No browser in this session._");
      expect(notice(raw, { kind: "unsupported" })).toBe("_No browser in this session._");
    }
  });

  test("not open yet: it applies to a started session (never «no browser»)", () => {
    expect(notice("/browser", { kind: "not-open" })).toContain("send a first message");
    expect(notice("/browser", on(caps({ noBrowser: true }), true))).toContain(
      "send a first message",
    );
  });

  test("the panel and the ops", () => {
    expect(browserCommandStep("/browser", on(caps()))).toEqual({ kind: "panel" });
    expect(browserCommandStep("/browser  auto ", on(caps()))).toEqual({
      kind: "op",
      op: { kind: "browser", name: "auto", enabled: true },
    });
    expect(notice("/browser nope", on(caps()))).toBe(
      "_Usage: `/browser [on|off|auto|ask|clear|masked]`_",
    );
  });

  test("tools off: auto/clear refused, ask/masked (the safe way) and on are sent", () => {
    const off = on(caps({ off: MEMBERS }));
    for (const raw of ["/browser auto", "/browser clear"]) {
      expect(notice(raw, off)).toBe("_Turn the browser tools on first: `/browser on`._");
    }
    for (const raw of ["/browser ask", "/browser masked", "/browser on"]) {
      expect(browserCommandStep(raw, off).kind).toBe("op");
    }
  });
});

describe("browserDoneKey", () => {
  const item = (name: string, status: string) => ({ kind: "tool", name, status });
  test("counts finished browser tools only — in any completion order", () => {
    expect(browserDoneKey([])).toBe(0);
    expect(browserDoneKey([item("browser_open", "running"), item("shell", "ok")])).toBe(0);
    expect(browserDoneKey([item("browser_open", "running"), item("browser_read", "ok")])).toBe(1);
    expect(browserDoneKey([item("browser_open", "error"), item("browser_read", "ok")])).toBe(2);
    expect(browserDoneKey([{ kind: "user" }])).toBe(0);
  });
});

describe("capsMarker does not count the browser group", () => {
  test("a default-off browser is not «9 tools off»", () => {
    expect(capsMarker(caps({ off: MEMBERS }))).toBeNull();
    expect(capsMarker(caps({ off: [...MEMBERS, "chart"] }))).toBe("⊘ 1 tool off");
  });
});

describe("the status row carries the sign", () => {
  const base = (columns: number, browser: ReturnType<typeof browserStatusSign>) =>
    statusLayout({
      columns,
      linkText: null,
      target: null,
      cwd: "/Users/x/a/rather/long/project/folder",
      home: "/Users/x",
      tokens: { prompt: 1200, completion: 340 },
      meter: contextMeterView(54_000, false, 128_000),
      hint: " ⏵⏵ auto-accept off (shift+tab) ",
      suffix: " · ⊘ 1 tool off",
      browser,
    });
  const risky = { text: "◉ chrome 2 tabs", warnings: ["▲ AUTO", "▲ SECRETS VISIBLE"] };

  test("wide: after the meter, before the suffix; one row", () => {
    const layout = base(160, risky);
    expect(layout.browser).toEqual({
      text: " · ◉ chrome 2 tabs",
      warn: " · ▲ AUTO ▲ SECRETS VISIBLE",
    });
    expect(layout.plain).toContain(
      "(54k/128k) · ◉ chrome 2 tabs · ▲ AUTO ▲ SECRETS VISIBLE · ⊘ 1 tool off",
    );
    expect(layout.plain.length).toBeLessThanOrEqual(160);
  });

  test("quiet sign: no warning part", () => {
    expect(base(160, { text: "◉ chrome", warnings: [] }).browser).toEqual({
      text: " · ◉ chrome",
      warn: "",
    });
  });

  test("short: the count goes first, the warnings stay (before path, hint, tokens, suffix)", () => {
    const layout = base(50, risky);
    expect(layout.browser).toEqual({ text: "", warn: " · ▲ AUTO ▲ SECRETS VISIBLE" });
    expect(layout.plain).toContain("54k/128k");
    expect(layout.plain.length).toBeLessThanOrEqual(50);
  });

  test("never wider than the row, at any width", () => {
    for (let columns = 20; columns <= 160; columns++) {
      const layout = base(columns, risky);
      if (layout.browser.warn !== "") {
        expect(layout.plain.length).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("no sign: the row is what it was", () => {
    const without = base(120, null);
    expect(without.browser).toEqual({ text: "", warn: "" });
    expect(without.plain).not.toContain("chrome");
  });
});
