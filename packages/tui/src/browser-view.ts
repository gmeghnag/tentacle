/**
 * The TUI's `/browser` decisions (docs/feat/browser-inspect.md B6a), React-free
 * and pure (AGENTS §7): the panel's rows and what Space asks on each, the
 * status-bar sign, the `/browser <word>` shortcuts, and when the status is
 * re-read. The switches come from the daemon's last report (`capabilities`), the
 * link and the tabs from one `browser/status` read; nothing is guessed locally.
 * Tab titles and addresses are page text: every one passes through `oneLine`.
 */
import { browserOffered, linkLabel, statusRefreshDue, tabSubtitle } from "@tentacle/client";
import { TOOL_GROUPS } from "@tentacle/core";
import type { BrowserStatusResult } from "@tentacle/protocol";
import {
  type CapOp,
  type CapsPhase,
  type CapsView,
  type SwitchState,
  capsTitleNote,
  groupSwitch,
  switchGlyph,
  switchOp,
} from "./capability-toggles.ts";
import { oneLine } from "./commands.ts";

const MEMBERS: readonly string[] = TOOL_GROUPS.browser ?? [];

export const NO_BROWSER_NOTICE = "_No browser in this session._";
const NOT_OPEN_NOTICE =
  "_The browser applies to a started session: send a first message, then try again._";
const TOOLS_OFF_NOTICE = "_Turn the browser tools on first: `/browser on`._";
const USAGE_NOTICE = "_Usage: `/browser [on|off|auto|ask|clear|masked]`_";

/** One panel row: its text, whether it is drawn dim, and what Space asks (null: nothing). */
export interface BrowserRow {
  readonly head: string;
  readonly off?: boolean;
  readonly op: CapOp | null;
}

/** The whole group, as ONE op (its echo is one change per member). */
const groupOp = (enabled: boolean): CapOp => ({
  kind: "tool",
  name: "browser",
  enabled,
  members: MEMBERS,
});

/** `auto` / `clear`: locked while the tools are off (the stored value is not shown). */
function modeRow(label: string, name: "auto" | "clear", on: boolean, offered: boolean): BrowserRow {
  const state: SwitchState = !offered ? "locked" : on ? "on" : "off";
  return {
    head: `${switchGlyph(state)} ${label}${offered ? "" : "  browser tools off"}`,
    ...(offered ? {} : { off: true }),
    op: switchOp("browser", name, state),
  };
}

const note = (head: string): BrowserRow => ({ head, op: null });

function tabRows(status: BrowserStatusResult | null): BrowserRow[] {
  if (status === null) {
    return [note("Tabs unknown")];
  }
  if (status.heldElsewhere === true) {
    return [note("Another tentacle process holds the browser · tabs not listed")];
  }
  if (status.tabs.length === 0) {
    return [note("No tabs")];
  }
  return [
    note(`Tabs · ${status.tabs.length}`),
    ...status.tabs.map((tab) =>
      note(`#${tab.id} ${oneLine(tab.title)} — ${oneLine(tab.where)} · ${tabSubtitle(tab)}`),
    ),
  ];
}

/**
 * The panel at `caps` and `status` (null: not read, or the read failed). The ROW
 * COUNT depends on `status` alone, so the cursor walks without the switches.
 */
export function browserPanelRows(
  caps: CapsView | undefined,
  status: BrowserStatusResult | null,
): { readonly title: string; readonly rows: readonly BrowserRow[] } {
  const phase: CapsPhase = caps === undefined ? { kind: "unsupported" } : { kind: "on", caps };
  const tools = groupSwitch(phase, MEMBERS);
  const offered = browserOffered(caps);
  const toolsOp = switchOp("tool", "browser", tools);
  const rows: BrowserRow[] = [
    {
      head: `${tools === null ? "" : `${switchGlyph(tools)} `}Browser tools`,
      ...(offered ? {} : { off: true }),
      op: toolsOp === null ? null : groupOp(toolsOp.enabled),
    },
    modeRow("Act without asking", "auto", caps?.browser?.actions === "auto", offered),
    modeRow("Show secrets", "clear", caps?.browser?.secrets === "clear", offered),
    ...tabRows(status),
  ];
  return {
    title: `Browser · ${linkLabel(status)} · ${capsTitleNote(phase)}`,
    rows,
  };
}

/** The status bar's sign: the quiet part, and a `▲` warning per risky switch that is on. */
export interface BrowserSign {
  readonly text: string;
  readonly warnings: readonly string[];
}

/** Null while the browser is off or absent. No tab count unless a list was read. */
export function browserStatusSign(
  caps: CapsView | undefined,
  status: BrowserStatusResult | null,
): BrowserSign | null {
  if (!browserOffered(caps)) {
    return null;
  }
  const n =
    status === null || !status.available || status.heldElsewhere === true
      ? null
      : status.tabs.length;
  return {
    text: n === null ? "◉ chrome" : `◉ chrome ${n} tab${n === 1 ? "" : "s"}`,
    warnings: [
      ...(caps?.browser?.actions === "auto" ? ["▲ AUTO"] : []),
      ...(caps?.browser?.secrets === "clear" ? ["▲ SECRETS VISIBLE"] : []),
    ],
  };
}

export type BrowserSubcommand =
  | { readonly kind: "panel" }
  | { readonly kind: "op"; readonly op: CapOp }
  | { readonly kind: "usage" };

const mode = (name: "auto" | "clear", enabled: boolean): BrowserSubcommand => ({
  kind: "op",
  op: { kind: "browser", name, enabled },
});

const SUBCOMMANDS: ReadonlyMap<string, BrowserSubcommand> = new Map([
  ["", { kind: "panel" }],
  ["on", { kind: "op", op: groupOp(true) }],
  ["off", { kind: "op", op: groupOp(false) }],
  ["auto", mode("auto", true)],
  ["ask", mode("auto", false)],
  ["clear", mode("clear", true)],
  ["masked", mode("clear", false)],
]);

/** What `/browser <arg>` means. */
export function browserSubcommand(arg: string): BrowserSubcommand {
  return SUBCOMMANDS.get(arg) ?? { kind: "usage" };
}

/** What typing `raw` does in a session whose switches are at `phase`. */
export function browserCommandStep(
  raw: string,
  phase: CapsPhase,
):
  | { readonly kind: "panel" }
  | { readonly kind: "op"; readonly op: CapOp }
  | { readonly kind: "notice"; readonly text: string } {
  const say = (text: string) => ({ kind: "notice", text }) as const;
  // Before the open nothing says whether the host has the browser (the preview
  // carries no `browser`): never claim it has none.
  if (phase.kind === "not-open" || (phase.kind === "on" && phase.firstMessage === true)) {
    return say(NOT_OPEN_NOTICE);
  }
  if (phase.kind !== "on" || phase.caps.browser === undefined) {
    return say(NO_BROWSER_NOTICE);
  }
  const sub = browserSubcommand(
    raw
      .trim()
      .replace(/^\/browser\b/, "")
      .trim(),
  );
  if (sub.kind === "usage") {
    return say(USAGE_NOTICE);
  }
  // A risky switch is locked while the tools are off (turning one OFF is safe).
  if (sub.kind === "op" && sub.op.kind === "browser" && sub.op.enabled) {
    if (!browserOffered(phase.caps)) {
      return say(TOOLS_OFF_NOTICE);
    }
  }
  return sub;
}

/**
 * How many tool rows that change the browser have finished: a new value means
 * the status is due again. A count, so any completion order moves it.
 */
export function browserDoneKey(
  items: readonly { readonly kind: string; readonly name?: string; readonly status?: string }[],
): number {
  let n = 0;
  for (const item of items) {
    if (
      item.kind === "tool" &&
      item.status !== "running" &&
      item.name !== undefined &&
      statusRefreshDue({ kind: "tool_done", name: item.name })
    ) {
      n += 1;
    }
  }
  return n;
}
