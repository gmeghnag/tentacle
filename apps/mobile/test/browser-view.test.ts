/**
 * The phone's browser view-model (docs/feat/browser-inspect.md B6b): every
 * mockup state from fixtures — the Session info row, the Browser page's bands,
 * the risk strip, the locks and the "a tool finished" counter.
 */
import { describe, expect, test } from "bun:test";
import { TOOL_GROUPS } from "@tentacle/core";
import type { BrowserStatusResult, SessionCapabilitiesWire } from "@tentacle/protocol";
import {
  BROWSER_TOOLS_OFF,
  type BrowserPageFacts,
  browserDoneKey,
  browserPageOf,
  browserPageView,
  browserRowValue,
  riskStripItems,
  switchDisabled,
} from "../src/browser-view.ts";
import { type InfoFacts, sessionInfoView } from "../src/session-info.ts";

const ALL_TOOLS: readonly string[] = TOOL_GROUPS.browser ?? [];

function caps(
  over: {
    readonly actions?: "ask" | "auto";
    readonly secrets?: "masked" | "clear";
    readonly off?: readonly string[];
    readonly browser?: false;
  } = {},
): SessionCapabilitiesWire {
  const off = [...(over.off ?? [])];
  return {
    disabledMcp: [],
    disabledSkills: [],
    disabledTools: off,
    ...(over.browser === false
      ? {}
      : {
          browser: {
            enabled: off.length === 0,
            actions: over.actions ?? "ask",
            secrets: over.secrets ?? "masked",
          },
        }),
  };
}

const connected: BrowserStatusResult = {
  available: true,
  link: { state: "connected", managed: false },
  tabs: [
    { id: 1, title: "CI run", where: "github.com/x", handedOver: false, traced: false },
    { id: 2, title: "Inbox", where: "mail.example.com", handedOver: true, traced: false },
  ],
};

const facts = (over: Partial<BrowserPageFacts> = {}): BrowserPageFacts => ({
  caps: caps(),
  phase: "on",
  status: connected,
  title: "Fix CI",
  computerName: "e2e-mac",
  error: null,
  ...over,
});

const band = (view: ReturnType<typeof browserPageView>, id: string) =>
  view.bands.find((b) => b.id === id);

const switches = (view: ReturnType<typeof browserPageView>) =>
  (band(view, "switches")?.rows ?? []).map((row) => ({
    title: row.title,
    on: row.switch?.on,
    interactive: row.switch?.interactive,
    kind: row.switch?.kind,
    name: row.switch?.name,
    locked: row.locked === true,
  }));

describe("browserRowValue", () => {
  test("no browser on the host: no row", () => {
    expect(browserRowValue(undefined)).toBeNull();
    expect(browserRowValue(caps({ browser: false }))).toBeNull();
  });

  test("the mockup's default words", () => {
    expect(browserRowValue(caps())).toBe("◉ On · asks · masked");
  });

  test("auto and clear are words with a glyph, never a hue", () => {
    expect(browserRowValue(caps({ actions: "auto" }))).toBe("◉ On · ▲ AUTO · masked");
    expect(browserRowValue(caps({ secrets: "clear" }))).toBe("◉ On · asks · ▲ CLEAR");
  });

  test("every tool off: Off, whatever the stored modes say", () => {
    expect(browserRowValue(caps({ off: ALL_TOOLS, actions: "auto" }))).toBe("○ Off");
  });

  test("one tool off is still on (auto answers the others)", () => {
    expect(browserRowValue(caps({ off: ["browser_click"], actions: "auto" }))).toContain("▲ AUTO");
  });
});

describe("riskStripItems", () => {
  test("null for the defaults, without a browser, and with the tools off", () => {
    expect(riskStripItems(undefined)).toBeNull();
    expect(riskStripItems(caps())).toBeNull();
    expect(riskStripItems(caps({ browser: false }))).toBeNull();
    expect(riskStripItems(caps({ off: ALL_TOOLS, actions: "auto", secrets: "clear" }))).toBeNull();
  });

  test("each mode alone, and both in the mockup's order", () => {
    expect(riskStripItems(caps({ actions: "auto" }))).toEqual(["Browser acts alone"]);
    expect(riskStripItems(caps({ secrets: "clear" }))).toEqual(["Secrets visible"]);
    expect(riskStripItems(caps({ actions: "auto", secrets: "clear" }))).toEqual([
      "Secrets visible",
      "Browser acts alone",
    ]);
  });

  test("a partly-off group still warns", () => {
    expect(riskStripItems(caps({ off: ["browser_net"], actions: "auto" }))).not.toBeNull();
  });
});

describe("switchDisabled", () => {
  test("auto and clear are locked only while no browser tool is offered", () => {
    expect(switchDisabled(caps())).toBe(false);
    expect(switchDisabled(caps({ off: ["browser_net"] }))).toBe(false);
    expect(switchDisabled(caps({ off: ALL_TOOLS }))).toBe(true);
  });
});

describe("browserPageView", () => {
  test("connected, default: the three bands in the mockup's order", () => {
    const view = browserPageView(facts());
    expect(view.bands.map((b) => b.title)).toEqual([
      "Chrome",
      "This session",
      "Tabs · tentacle · Fix CI",
    ]);
    expect(band(view, "chrome")?.rows).toEqual([
      { id: "link", title: "Link", value: "◉ connected" },
    ]);
    expect(switches(view)).toEqual([
      {
        title: "Browser tools",
        on: true,
        interactive: true,
        kind: "tool",
        name: "browser",
        locked: false,
      },
      {
        title: "Act without asking",
        on: false,
        interactive: true,
        kind: "browser",
        name: "auto",
        locked: false,
      },
      {
        title: "Show secrets",
        on: false,
        interactive: true,
        kind: "browser",
        name: "clear",
        locked: false,
      },
    ]);
    expect(band(view, "tabs")?.rows.map((r) => [r.title, r.subtitle])).toEqual([
      ["CI run", "Opened by the agent"],
      ["Inbox", "Handed over by you · acting asks first"],
    ]);
  });

  test("auto + clear: both on, and a handed-over tab no longer claims it asks first", () => {
    const view = browserPageView(facts({ caps: caps({ actions: "auto", secrets: "clear" }) }));
    expect(switches(view).map((s) => s.on)).toEqual([true, true, true]);
    expect(band(view, "tabs")?.rows[1]?.subtitle).toBe("Handed over by you");
  });

  test("tools off: auto/clear dimmed, locked, labelled, their stored value kept", () => {
    const view = browserPageView(facts({ caps: caps({ off: ALL_TOOLS, actions: "auto" }) }));
    expect(switches(view).map((s) => [s.on, s.interactive, s.locked])).toEqual([
      [false, true, false],
      [true, false, true],
      [false, false, true],
    ]);
    const rows = band(view, "switches")?.rows ?? [];
    expect(rows.slice(1).map((r) => [r.subtitle, r.dim])).toEqual([
      [BROWSER_TOOLS_OFF, true],
      [BROWSER_TOOLS_OFF, true],
    ]);
  });

  test("Chrome not running, extension missing, managed, not installed", () => {
    const link = (state: "not_running" | "extension_missing" | "not_installed", managed = false) =>
      band(
        browserPageView(facts({ status: { available: true, link: { state, managed }, tabs: [] } })),
        "chrome",
      )?.rows[0]?.value;
    expect(link("not_running")).toBe("○ Chrome not running");
    expect(link("extension_missing")).toBe("✕ extension missing");
    expect(link("extension_missing", true)).toBe(
      "✕ extension missing · managed by your organization",
    );
    expect(link("not_installed")).toBe("✕ not installed — run tentacle browser install");
  });

  test("no read (an error, an older daemon): link unknown, tabs unknown, never 'No tabs'", () => {
    const view = browserPageView(facts({ status: null }));
    expect(band(view, "chrome")?.rows[0]?.value).toBe("unknown");
    expect(band(view, "tabs")?.rows.map((r) => r.title)).toEqual(["Tabs unknown"]);
    // The switches still work from `capabilities`.
    expect(switches(view).every((s) => s.interactive)).toBe(true);
  });

  test("an empty group, and a browser held elsewhere", () => {
    const titles = (status: BrowserStatusResult) =>
      band(browserPageView(facts({ status })), "tabs")?.rows.map((r) => r.title);
    expect(titles({ ...connected, tabs: [] })).toEqual(["No tabs"]);
    expect(titles({ ...connected, tabs: [], heldElsewhere: true })).toEqual([
      "Another tentacle process holds the browser",
    ]);
  });

  test("page text is one clean line; an empty title falls back to the address", () => {
    const view = browserPageView(
      facts({
        title: "a\nb\u001b[31m",
        status: {
          ...connected,
          tabs: [
            { id: 1, title: "evil\n‮title", where: "x.com", handedOver: false, traced: false },
            { id: 2, title: "", where: "y.com/p", handedOver: false, traced: false },
          ],
        },
      }),
    );
    for (const b of view.bands) {
      for (const text of [b.title, ...b.rows.map((r) => r.title)]) {
        expect(text).not.toMatch(/\p{Cc}|‮/u);
      }
    }
    expect(band(view, "tabs")?.rows[1]?.title).toBe("y.com/p");
  });

  test("offline / not open: the switches are shown but cannot send", () => {
    for (const phase of ["offline", "not-open"] as const) {
      const view = browserPageView(facts({ phase }));
      expect(switches(view).map((s) => s.interactive)).toEqual([false, false, false]);
      expect(switches(view).map((s) => s.locked)).toEqual([false, false, false]);
    }
    expect(band(browserPageView(facts({ phase: "not-open" })), "switches")?.note).toBe(
      "Open the session to use the browser",
    );
  });

  test("a refused set is said under the switches", () => {
    const view = browserPageView(facts({ error: "this session has no browser" }));
    expect(band(view, "switches")?.note).toBe("Couldn't switch: this session has no browser");
  });

  test("no browser on the host: no switches at all", () => {
    for (const value of [undefined, caps({ browser: false })]) {
      const view = browserPageView(facts({ caps: value }));
      expect(view.bands).toEqual([]);
      expect(view.empty).toBe("No browser in this session");
    }
  });
});

describe("browserPageOf", () => {
  const of = (kind: "mcp" | "tool" | "browser") =>
    browserPageOf({
      view: { subtitle: "Fix CI" },
      tools: {
        computerName: "mac",
        capabilities: {
          phase: "on",
          state: caps(),
          changedBy: {},
          error: { kind, text: "no" },
        },
      },
      browserStatus: connected,
    });

  test("the controller's facts; only the browser's own refusals are said here", () => {
    expect(band(of("browser"), "tabs")?.title).toBe("Tabs · tentacle · Fix CI");
    expect(band(of("browser"), "switches")?.note).toBe("Couldn't switch: no");
    expect(band(of("tool"), "switches")?.note).toBe("Couldn't switch: no");
    expect(band(of("mcp"), "switches")?.note).toBeUndefined();
  });
});

describe("browserDoneKey", () => {
  test("counts only finished browser tool rows", () => {
    const row = (name: string, status: string) => ({ kind: "tool", name, status });
    expect(browserDoneKey([])).toBe(0);
    expect(browserDoneKey([row("browser_open", "running"), row("browser_read", "queued")])).toBe(0);
    expect(browserDoneKey([row("shell", "ok"), { kind: "user" }])).toBe(0);
    expect(
      browserDoneKey([
        row("browser_open", "ok"),
        row("browser_click", "error"),
        row("browser_type", "denied"),
        row("browser_net", "running"),
      ]),
    ).toBe(3);
  });
});

describe("Session info's Browser row", () => {
  const info = (over: Partial<InfoFacts>): InfoFacts => ({
    phase: "open",
    link: "up",
    title: "Fix CI",
    computerName: "e2e-mac",
    daemon: undefined,
    mcp: { state: "loading" },
    skills: { state: "loading" },
    context: { state: "loading" },
    entry: {
      state: "ready",
      value: {
        sessionId: "s1",
        title: "Fix CI",
        cwd: "/srv/app",
        createdAt: 0,
        updatedAt: 0,
        running: false,
        attached: 1,
        archived: false,
      },
    },
    autoAccept: true,
    now: 1,
    ...over,
  });
  const withCaps = (state: SessionCapabilitiesWire | undefined): Partial<InfoFacts> => ({
    capabilities: { phase: "on", state, changedBy: {}, error: null },
  });
  const session = (over: Partial<InfoFacts>) =>
    sessionInfoView(info(over)).sections.find((s) => s.id === "session");

  test("the Session band's last row, with the value and a way in", () => {
    expect(session(withCaps(caps()))?.rows.at(-1)).toMatchObject({
      title: "Browser",
      value: "◉ On · asks · masked",
      opens: "browser",
    });
  });

  test("absent without the host's browser", () => {
    for (const value of [undefined, caps({ browser: false })]) {
      expect(session(withCaps(value))?.rows.map((r) => r.title)).not.toContain("Browser");
    }
  });

  test("a session off the first page still has the way in", () => {
    const section = session({ ...withCaps(caps()), entry: { state: "ready", value: null } });
    expect(section?.phase).toBe("ready");
    expect(section?.rows.map((r) => r.title)).toEqual(["Browser"]);
    // Without the browser it stays the honest empty section.
    expect(session({ entry: { state: "ready", value: null } })?.phase).toBe("empty");
  });
});
