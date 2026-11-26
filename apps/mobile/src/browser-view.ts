/**
 * The phone's browser decisions (docs/feat/browser-inspect.md B6b), pure and
 * React-free (AGENTS §7): Session info's row value, the Browser page's bands,
 * the strip above the composer, the locks, and when a finished tool makes the
 * status stale. The switches come from the daemon's last report
 * (`capabilities`), the link and the tabs from one `browser/status` read;
 * nothing is guessed locally. Meaning is carried by glyphs and words, never by
 * a colour. Tab and session titles are untrusted text: every one is one clean
 * line.
 */
import { browserOffered, linkLabel, statusRefreshDue, tabSubtitle } from "@tentacle/client";
import type { BrowserStatusResult, SessionCapabilitiesWire } from "@tentacle/protocol";
import { sanitizeDisplay } from "./display-text.ts";
import type { SwitchPhase, ToolsFacts } from "./session-info.ts";

/** The inline label of a switch locked by the tools being off. */
export const BROWSER_TOOLS_OFF = "Browser tools off";

export interface BrowserSwitchView {
  readonly kind: "tool" | "browser";
  readonly name: "browser" | "auto" | "clear";
  readonly on: boolean;
  /** A flip sends a set; false draws a ghost switch. */
  readonly interactive: boolean;
  readonly accessibilityLabel: string;
}

export interface BrowserPageRow {
  /** The row's key and testID suffix. */
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly value?: string;
  readonly dim?: boolean;
  /** A tap cannot switch it: it answers with a light haptic (the label says why). */
  readonly locked?: boolean;
  readonly switch?: BrowserSwitchView;
}

export interface BrowserPageBand {
  readonly id: "chrome" | "switches" | "tabs";
  readonly title: string;
  readonly rows: readonly BrowserPageRow[];
  readonly note?: string;
}

export interface BrowserPageView {
  readonly bands: readonly BrowserPageBand[];
  /** Said instead of the bands. */
  readonly empty?: string;
}

export interface BrowserPageFacts {
  readonly caps: SessionCapabilitiesWire | undefined;
  readonly phase: SwitchPhase;
  /** The last `browser/status` read; null: none, or it failed. */
  readonly status: BrowserStatusResult | null;
  /** The session's title, as the screen shows it. */
  readonly title: string;
  readonly computerName: string;
  /** A refused browser switch, until the next attempt. */
  readonly error: string | null;
}

/** Page text as one clean line: no breaks, bidi overrides or control characters. */
function oneLine(text: string): string {
  return sanitizeDisplay(text).replace(/\p{Cc}/gu, "");
}

/** Session info's row (`◉ On · asks · masked`); null: no browser, so no row. */
export function browserRowValue(caps: SessionCapabilitiesWire | undefined): string | null {
  const browser = caps?.browser;
  if (browser === undefined) {
    return null;
  }
  if (!browserOffered(caps)) {
    return "○ Off";
  }
  const acts = browser.actions === "auto" ? "▲ AUTO" : "asks";
  const secrets = browser.secrets === "clear" ? "▲ CLEAR" : "masked";
  return `◉ On · ${acts} · ${secrets}`;
}

/** The strip's words, only while the browser is on AND auto or clear is. */
export function riskStripItems(
  caps: SessionCapabilitiesWire | undefined,
): readonly string[] | null {
  if (!browserOffered(caps)) {
    return null;
  }
  const items = [
    ...(caps?.browser?.secrets === "clear" ? ["Secrets visible"] : []),
    ...(caps?.browser?.actions === "auto" ? ["Browser acts alone"] : []),
  ];
  return items.length === 0 ? null : items;
}

/** Whether auto and clear are locked: no browser tool is offered. */
export function switchDisabled(caps: SessionCapabilitiesWire | undefined): boolean {
  return !browserOffered(caps);
}

function switchRow(
  id: string,
  title: string,
  toggle: Omit<BrowserSwitchView, "accessibilityLabel">,
  locked: boolean,
): BrowserPageRow {
  return {
    id,
    title,
    ...(locked ? { subtitle: BROWSER_TOOLS_OFF, dim: true, locked: true } : {}),
    switch: { ...toggle, accessibilityLabel: `${title}, in this session` },
  };
}

function switchesNote(facts: BrowserPageFacts): string | undefined {
  if (facts.error !== null) {
    return `Couldn't switch: ${oneLine(facts.error)}`;
  }
  switch (facts.phase) {
    case "unsupported":
      return `The tentacle on ${oneLine(facts.computerName)} can't switch the browser — update it.`;
    case "not-open":
      return "Open the session to use the browser";
    case "offline":
      return "Offline — the switches can't be changed until reconnected";
    case "on":
      return undefined;
  }
}

function tabRows(status: BrowserStatusResult | null, auto: boolean): BrowserPageRow[] {
  const note = (title: string): BrowserPageRow[] => [{ id: "tabs-note", title, dim: true }];
  if (status === null || !status.available) {
    return note("Tabs unknown");
  }
  if (status.heldElsewhere === true) {
    return note("Another tentacle process holds the browser");
  }
  if (status.tabs.length === 0) {
    return note("No tabs");
  }
  return status.tabs.map((tab) => ({
    id: `tab-${tab.id}`,
    title: oneLine(tab.title) || oneLine(tab.where),
    subtitle: tabSubtitle(tab, auto),
  }));
}

/** The Browser page at these facts: Chrome, This session, Tabs. */
export function browserPageView(facts: BrowserPageFacts): BrowserPageView {
  const browser = facts.caps?.browser;
  if (browser === undefined) {
    return { bands: [], empty: "No browser in this session" };
  }
  const usable = facts.phase === "on";
  const locked = switchDisabled(facts.caps);
  const auto = browser.actions === "auto";
  const note = switchesNote(facts);
  const mode = (name: "auto" | "clear", title: string, on: boolean): BrowserPageRow =>
    switchRow(name, title, { kind: "browser", name, on, interactive: usable && !locked }, locked);
  return {
    bands: [
      {
        id: "chrome",
        title: "Chrome",
        rows: [{ id: "link", title: "Link", value: linkLabel(facts.status) }],
      },
      {
        id: "switches",
        title: "This session",
        rows: [
          switchRow(
            "tools",
            "Browser tools",
            { kind: "tool", name: "browser", on: !locked, interactive: usable },
            false,
          ),
          mode("auto", "Act without asking", auto),
          mode("clear", "Show secrets", browser.secrets === "clear"),
        ],
        ...(note === undefined ? {} : { note }),
      },
      {
        id: "tabs",
        title: `Tabs · tentacle · ${oneLine(facts.title)}`,
        // The subtitle's claim follows what is really answered: auto is only
        // live while a browser tool is offered.
        rows: tabRows(facts.status, auto && !locked),
      },
    ],
  };
}

/** The page from what the Session info controller holds (its title is the sheet's subtitle). */
export function browserPageOf(info: {
  readonly view: { readonly subtitle: string };
  readonly tools: Pick<ToolsFacts, "capabilities" | "computerName">;
  readonly browserStatus: BrowserStatusResult | null;
}): BrowserPageView {
  const switches = info.tools.capabilities;
  const error = switches?.error ?? null;
  return browserPageView({
    caps: switches?.state,
    phase: switches?.phase ?? "unsupported",
    status: info.browserStatus,
    title: info.view.subtitle,
    computerName: info.tools.computerName,
    // A refused server/skill switch belongs to its own section, not here.
    error: error?.kind === "tool" || error?.kind === "browser" ? error.text : null,
  });
}

/**
 * How many tool rows that change the browser have finished: a new value means
 * the status is due again. A count, so any completion order moves it.
 */
export function browserDoneKey(
  rows: readonly { readonly kind: string; readonly name?: string; readonly status?: string }[],
): number {
  let n = 0;
  for (const row of rows) {
    if (
      row.kind === "tool" &&
      row.status !== "running" &&
      row.status !== "queued" &&
      row.name !== undefined &&
      statusRefreshDue({ kind: "tool_done", name: row.name })
    ) {
      n += 1;
    }
  }
  return n;
}
