/**
 * What the `/mcp` panel says (docs/feat/mcp-tools-panel.md): one group per
 * server — its switch, name, a state glyph and its tool count as the head
 * (the quiet grammar, docs/feat/session-capabilities.md S4), then (expanded)
 * its state word with the latency or the error, and its tool names. The panel
 * mechanics live in `tree-panel.ts`; the switch's decisions in
 * `capability-toggles.ts`.
 *
 * Every daemon string passes through `oneLine` (bidi/zero-width dropped)
 * before it is shown: the schema only rejects control characters, and the
 * daemon may be a pod.
 */
import { type CapsPhase, capsTitleNote, mcpSwitch, switchGlyph } from "./capability-toggles.ts";
import { oneLine } from "./commands.ts";
import type { TreeGroup } from "./tree-panel.ts";

/** One MCP server as `mcp/status` reports it. */
export interface McpServerView {
  readonly name: string;
  readonly state: "connecting" | "connected" | "unresponsive" | "closed" | "failed";
  /** Bare tool names, the first ≤128; `moreTools` counts the rest. */
  readonly tools: readonly string[];
  readonly moreTools: number;
  readonly latencyMs?: number;
  readonly error?: string;
}

const GLYPH: Readonly<Record<McpServerView["state"], string>> = {
  connected: "●",
  connecting: "…",
  unresponsive: "!",
  closed: "○",
  failed: "✗",
};

/** Server names are padded to align the state column, up to this width. */
const NAME_COLUMN_MAX = 24;

/** No switch column: the phase shows none (`capsPhase`). */
const NO_CAPS: CapsPhase = { kind: "unsupported" };

const toolCount = (n: number): string => `${n} tool${n === 1 ? "" : "s"}`;

/**
 * `[✓] name  ● 14 tools`. A failed server keeps `✗ failed` (a state to act on);
 * a connecting one shows its glyph alone (no count is known yet).
 */
function head(s: McpServerView, nameWidth: number, phase: CapsPhase): string {
  const sw = mcpSwitch(phase, s.name);
  const lead = sw === null ? "" : `${switchGlyph(sw)} `;
  const name = `${lead}${oneLine(s.name).padEnd(nameWidth)}  ${GLYPH[s.state]}`;
  if (s.state === "connecting") {
    return name;
  }
  return `${name} ${s.state === "failed" ? "failed" : toolCount(s.tools.length + s.moreTools)}`;
}

/** The first child: the state word (and the latency, or the error). */
function stateRow(s: McpServerView): string {
  const error = oneLine(s.error ?? "");
  switch (s.state) {
    case "connected":
      return `connected · ${s.latencyMs ?? 0} ms`;
    case "connecting":
      return "still connecting";
    case "failed":
      return error || "failed";
    default:
      return error ? `${s.state} · ${error}` : s.state;
  }
}

function children(s: McpServerView): string[] {
  const rows = [stateRow(s), ...s.tools.map(oneLine)];
  if (s.moreTools > 0) {
    rows.push(`… ${s.moreTools} more`);
  }
  if (s.state === "connected" && s.tools.length + s.moreTools === 0) {
    rows.push("no tools");
  }
  return rows;
}

/** `phase`: the session's switches (`capability-toggles.ts`); none by default. */
export function mcpGroups(
  servers: readonly McpServerView[],
  phase: CapsPhase = NO_CAPS,
): TreeGroup[] {
  const nameWidth = Math.min(
    NAME_COLUMN_MAX,
    servers.reduce((w, s) => Math.max(w, oneLine(s.name).length), 0),
  );
  return servers.map((s) => ({
    head: head(s, nameWidth, phase),
    children: children(s),
    ...(mcpSwitch(phase, s.name) === "off" ? { off: true } : {}),
  }));
}

/** `phase` given: the title also says what the switches do now. */
export function mcpTitle(servers: readonly McpServerView[], phase?: CapsPhase): string {
  const reachable = servers.filter((s) => s.state === "connected").length;
  const base = `MCP servers · ${reachable} of ${servers.length} reachable`;
  return phase === undefined ? base : `${base} · ${capsTitleNote(phase)}`;
}
