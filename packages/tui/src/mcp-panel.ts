/**
 * What the `/mcp` panel says (docs/feat/mcp-tools-panel.md): one group per
 * server — its state as the head, then (expanded) its error and tool names.
 * The panel mechanics live in `tree-panel.ts`.
 *
 * Every daemon string passes through `oneLine` (bidi/zero-width dropped)
 * before it is shown: the schema only rejects control characters, and the
 * daemon may be a pod.
 */
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

const toolCount = (n: number): string => `${n} tool${n === 1 ? "" : "s"}`;

function head(s: McpServerView, nameWidth: number): string {
  const base = `${oneLine(s.name).padEnd(nameWidth)}  ${GLYPH[s.state]} ${s.state}`;
  const total = s.tools.length + s.moreTools;
  switch (s.state) {
    case "connected":
      return `${base} · ${toolCount(total)} · ${s.latencyMs ?? 0} ms`;
    case "closed":
    case "unresponsive":
      return `${base} · ${toolCount(total)}`;
    default:
      return base;
  }
}

function children(s: McpServerView): string[] {
  const rows: string[] = [];
  if (s.state === "connecting") {
    rows.push("still connecting");
  } else if (s.state !== "connected") {
    rows.push(oneLine(s.error ?? "") || s.state);
  }
  rows.push(...s.tools.map(oneLine));
  if (s.moreTools > 0) {
    rows.push(`… ${s.moreTools} more`);
  }
  if (s.state === "connected" && s.tools.length + s.moreTools === 0) {
    rows.push("no tools");
  }
  return rows;
}

export function mcpGroups(servers: readonly McpServerView[]): TreeGroup[] {
  const nameWidth = Math.min(
    NAME_COLUMN_MAX,
    servers.reduce((w, s) => Math.max(w, oneLine(s.name).length), 0),
  );
  return servers.map((s) => ({ head: head(s, nameWidth), children: children(s) }));
}

export function mcpTitle(servers: readonly McpServerView[]): string {
  const reachable = servers.filter((s) => s.state === "connected").length;
  return `MCP servers · ${reachable} of ${servers.length} reachable`;
}
