/**
 * The shared view rules of the user's Chrome (docs/feat/browser-inspect.md B6):
 * the link's words, a tab's subtitle, whether the browser is on, and when a
 * `browser/status` read is due. The TUI and the phone read ONE table.
 */
import { describe, expect, test } from "bun:test";
import type { BrowserStatusResult } from "@tentacle/protocol";
import {
  browserOffered,
  linkLabel,
  statusRefreshDue,
  tabSubtitle,
} from "../src/browser-status-view.ts";

const status = (
  state: NonNullable<BrowserStatusResult["link"]>["state"],
  managed = false,
): BrowserStatusResult => ({ available: true, link: { state, managed }, tabs: [] });

const BROWSER = [
  "browser_tabs",
  "browser_open",
  "browser_read",
  "browser_shot",
  "browser_net",
  "browser_console",
  "browser_click",
  "browser_type",
  "browser_close",
];
const switches = { enabled: true, secrets: "masked", actions: "ask" } as const;

describe("linkLabel", () => {
  test("one word set per link state, glyph + word (never colour alone)", () => {
    expect(linkLabel(status("connected"))).toBe("◉ connected");
    expect(linkLabel(status("not_running"))).toBe("○ Chrome not running");
    expect(linkLabel(status("extension_missing"))).toBe("✕ extension missing");
    expect(linkLabel(status("not_installed"))).toBe(
      "✕ not installed — run tentacle browser install",
    );
  });

  test("a managed install says so", () => {
    expect(linkLabel(status("connected", true))).toBe("◉ connected · managed by your organization");
  });

  test("no read (an error, an older daemon), no link, or no browser: unknown", () => {
    expect(linkLabel(null)).toBe("unknown");
    expect(linkLabel(undefined)).toBe("unknown");
    expect(linkLabel({ available: true, tabs: [] })).toBe("unknown");
    expect(linkLabel({ available: false, tabs: [] })).toBe("unknown");
  });
});

describe("tabSubtitle", () => {
  test("who opened it", () => {
    expect(tabSubtitle({ handedOver: false })).toBe("Opened by the agent");
    expect(tabSubtitle({ handedOver: true })).toBe("Handed over by you · acting asks first");
  });
});

describe("browserOffered", () => {
  test("needs the host's browser and at least one browser tool on", () => {
    expect(browserOffered(undefined)).toBe(false);
    expect(browserOffered({ disabledTools: [] })).toBe(false); // a pod, an older daemon
    expect(browserOffered({ browser: switches, disabledTools: [] })).toBe(true);
    expect(browserOffered({ browser: switches, disabledTools: BROWSER })).toBe(false);
  });

  test("a PARTLY-off group is still on (auto answers the rest), whatever `enabled` says", () => {
    expect(
      browserOffered({
        browser: { ...switches, enabled: false },
        disabledTools: ["browser_net"],
      }),
    ).toBe(true);
  });
});

describe("statusRefreshDue", () => {
  test("open/attach, a capabilities update, and a finished browser tool", () => {
    expect(statusRefreshDue({ kind: "open" })).toBe(true);
    expect(statusRefreshDue({ kind: "capabilities" })).toBe(true);
    for (const name of BROWSER) {
      expect(statusRefreshDue({ kind: "tool_done", name })).toBe(true);
    }
  });

  test("another tool is not", () => {
    expect(statusRefreshDue({ kind: "tool_done", name: "shell" })).toBe(false);
    expect(statusRefreshDue({ kind: "tool_done", name: "browserless" })).toBe(false);
  });
});
