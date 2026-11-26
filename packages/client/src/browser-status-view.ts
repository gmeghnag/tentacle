/**
 * What every UI says about the user's Chrome in a session
 * (docs/feat/browser-inspect.md B6): the link's words, a tab's subtitle,
 * whether the browser is on, and when a `browser/status` read is due. Pure and
 * shared — the TUI and the phone (which bundles this module) read ONE table.
 */
import { TOOL_GROUPS } from "@tentacle/core";
import type { BrowserStatusResult } from "@tentacle/protocol";

const MEMBERS: readonly string[] = TOOL_GROUPS.browser ?? [];

/**
 * The browser is on in this session: its host has it (`caps.browser` present)
 * and at least ONE browser tool is offered. Deliberately not the wire's
 * `browser.enabled` (false as soon as one tool is off): auto answers the tools
 * still on, so a sign hidden on a partly-off group would lie.
 */
export function browserOffered(
  caps: { readonly browser?: unknown; readonly disabledTools?: readonly string[] } | undefined,
): boolean {
  if (caps?.browser === undefined) {
    return false;
  }
  const off = caps.disabledTools ?? [];
  return MEMBERS.some((tool) => !off.includes(tool));
}

const LINK_WORDS: Readonly<Record<NonNullable<BrowserStatusResult["link"]>["state"], string>> = {
  connected: "◉ connected",
  not_running: "○ Chrome not running",
  extension_missing: "✕ extension missing",
  not_installed: "✕ not installed — run tentacle browser install",
};

/** The link in words; no read (an error, an older daemon) or no link: `unknown`. */
export function linkLabel(status: BrowserStatusResult | null | undefined): string {
  const link = status?.link;
  if (link === undefined) {
    return "unknown";
  }
  const word = LINK_WORDS[link.state];
  return link.managed ? `${word} · managed by your organization` : word;
}

/**
 * Who opened a tab of the session. While the browser acts alone (`auto`) a
 * handed-over tab no longer says that acting asks first: auto answers it (B5b).
 */
export function tabSubtitle(tab: { readonly handedOver: boolean }, auto = false): string {
  if (!tab.handedOver) {
    return "Opened by the agent";
  }
  return auto ? "Handed over by you" : "Handed over by you · acting asks first";
}

/** What may have changed the status: an open/attach, the switches, a tool's end. */
export type BrowserRefreshEvent =
  | { readonly kind: "open" }
  | { readonly kind: "capabilities" }
  | { readonly kind: "tool_done"; readonly name: string };

/** Whether `event` means the last `browser/status` read is out of date. */
export function statusRefreshDue(event: BrowserRefreshEvent): boolean {
  return event.kind !== "tool_done" || MEMBERS.includes(event.name);
}
