/**
 * What a tool row SAYS (B3): the call's primary target — the TUI's `toolTitle`
 * subtitle rule (`packages/tui/src/render-lines.ts`), so `shell` reads
 * `bun test …`, never `{"command":"bun test …"}` — and its output with terminal
 * escapes stripped (the phone never interprets them).
 *
 * Pure and React-free (AGENTS §7): `TranscriptRow.tsx` only draws it. The app
 * bundle never imports `@tentacle/tui` (plan P8); the rule is mirrored here and
 * pinned to the TUI's by `test/tool-summary.test.ts`'s parity cases.
 */
import { stripAnsi } from "./ansi.ts";
import type { SubProgress, ToolRow } from "./transcript-rows.ts";

export interface ToolSummary {
  /** The display label (`toolLabel`, already on the row). */
  readonly label: string;
  /** The call's target (a command, a path, `pattern in path`, …); "" when none. */
  readonly subtitle: string;
  /** The result text, escapes stripped; "" when there is none yet. */
  readonly output: string;
}

function argsOf(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON args fall through to the raw string (as the TUI does).
  }
  return {};
}

/**
 * The ONE list of tool names `subtitleOf` summarises — the TUI's `toolSubtitle`
 * cases (`packages/tui/src/render-lines.ts`), mirrored here (the app bundle
 * never imports `@tentacle/tui`, plan P8). A name NOT in it is MCP / unknown and
 * gets the phone's own `mcpRowArgs` flattening, never the raw JSON.
 *
 * The two halves must not drift: `test/tool-summary.test.ts` scans the TUI's
 * `toolSubtitle` source and fails when a case is missing here (or the reverse).
 * Main added `chart` to the TUI's switch and this list lagged behind it — hence
 * the guard. Add a case to BOTH.
 */
export const SUMMARISED_TOOLS: readonly string[] = [
  "fs_read",
  "fs_write",
  "fs_edit",
  "fs_multi_edit",
  "shell",
  "search",
  "shell_output",
  "shell_kill",
  "agent_task",
  "agent_control",
  "agent_kill",
  "agent_message",
  "agent_status",
  "skill",
  // A chart's row names the chart, never its spec — and a chart the phone does
  // not draw as a chart (an error, a spec it cannot re-validate; `chart-row.ts`)
  // falls back to this generic row, where the title is the honest line.
  "chart",
  // A diagram's row likewise names the diagram, never its Mermaid source
  // (docs/feat/model-diagrams.md D2) — the TUI's case, name for name.
  "diagram",
  // The model looks at a kept picture: its ref, never the raw args
  // (docs/feat/image-view.md D10).
  "image_view",
];

/** The TUI's `toolSubtitle`, case for case. */
function subtitleOf(name: string, raw: string): string {
  const args = argsOf(raw);
  const str = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === "string" ? value : undefined;
  };
  switch (name) {
    case "fs_read":
    case "fs_write":
    case "fs_edit":
      return str("path") ?? "";
    case "fs_multi_edit": {
      const path = str("path") ?? "";
      if (!Array.isArray(args.edits)) {
        return path;
      }
      const n = args.edits.length;
      return `${path} · ${n} ${n === 1 ? "edit" : "edits"}`;
    }
    case "shell":
      return str("command") ?? "";
    case "search": {
      const target = str("pattern") ?? str("glob") ?? "";
      return `${target} in ${str("path") ?? "."}`;
    }
    case "shell_output":
    case "shell_kill":
      return str("job_id") ?? "";
    case "agent_task":
      return str("description") ?? str("subagent_type") ?? "";
    case "agent_control": {
      const action = str("action") ?? "";
      const agentId = str("agent_id");
      return agentId === undefined ? action : `${action} ${agentId}`;
    }
    case "agent_kill":
    case "agent_message":
    case "agent_status":
      return str("agent_id") ?? "";
    case "skill":
      return str("name") ?? "";
    // A chart's row names the chart, not its JSON (docs/feat/model-charts.md
    // D3). A missing title falls back to the raw args, exactly as the TUI's case
    // does — a forged spec still shows something rather than an empty row.
    case "chart":
    // A diagram's row likewise names it, not its Mermaid source
    // (docs/feat/model-diagrams.md D2) — the TUI's case, mirrored.
    case "diagram":
      return str("title") ?? raw;
    // `Image <ref>`, plus ` · high` for the costly detail
    // (docs/feat/image-view.md D10) — the TUI's case, mirrored.
    case "image_view": {
      const ref = str("ref") ?? "";
      return str("detail") === "high" ? `${ref} · high` : ref;
    }
    default:
      return raw;
  }
}

/** The row's status icon: ok (green check), error (red), running (spinner), pending. */
export type ToolTone = "ok" | "error" | "running" | "pending";

export interface ToolMeta {
  readonly tone: ToolTone;
  /**
   * The row's right-hand text: a diff's `+n −m`, else `denied`, else the
   * duration; "" when the row knows none of them. Never an exit code here: a
   * `ToolResult` carries none — shell's outcome adds one (`shellOutcome`, in
   * `stepRowView`), read from its own `exit=N` line, never invented.
   */
  readonly trailing: string;
}

const TONE: Readonly<Record<ToolRow["status"], ToolTone>> = {
  ok: "ok",
  error: "error",
  denied: "error",
  running: "running",
  queued: "pending",
};

/** A duration as a phone row reads it: `42 ms`, `1.3 s`, `2 min 5 s`. */
function elapsed(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function toolMeta(row: Pick<ToolRow, "status" | "durationMs" | "diff" | "sub">): ToolMeta {
  // A sub-agent that finished stops the spinner, even before its call's own
  // result lands (item 10).
  const tone = row.status === "running" && row.sub?.done === true ? "ok" : TONE[row.status];
  if (row.diff !== undefined) {
    return { tone, trailing: `+${row.diff.added} −${row.diff.removed}` };
  }
  if (row.status === "denied") {
    return { tone, trailing: "denied" };
  }
  return { tone, trailing: row.durationMs === undefined ? "" : elapsed(row.durationMs) };
}

/**
 * The Agent card's progress line (docs/fix/mobile-chat-glitches.md item 10,
 * Owner Q2 — the TUI's head, tokens left out on the phone):
 * running `<last activity> · <N> tool uses`, done `Done · <N> tool uses`,
 * moved `Moved to background · sa-N`. `null`: no sub-agent on this row.
 */
export function subAgentLine(sub: SubProgress | undefined): string | null {
  if (sub === undefined) {
    return null;
  }
  if (sub.done && sub.stopReason === "background") {
    return sub.movedTo === undefined
      ? "Moved to background"
      : `Moved to background · ${sub.movedTo}`;
  }
  const uses = `${sub.toolUses} tool ${sub.toolUses === 1 ? "use" : "uses"}`;
  if (sub.done) {
    return `Done · ${uses}`;
  }
  const last = sub.activities.at(-1);
  return last === undefined ? uses : `${last} · ${uses}`;
}

export function toolSummary(row: Pick<ToolRow, "name" | "label" | "args" | "output">): ToolSummary {
  return {
    label: row.label,
    subtitle: stripAnsi(subtitleOf(row.name, row.args)),
    output: stripAnsi(row.output ?? ""),
  };
}

// ── What one STEP says (docs/feat/mobile-tool-rows.md, Design 1) ──────────
// NEW phone logic, not a TUI port: the TUI leaves `mcp__x__y` and raw MCP args
// as they are (`render-lines.ts` `default`), so `subtitleOf` above stays the
// parity rule and becomes the FULL command in a step's open body.

/** The tools `subtitleOf` summarises, from the one shared list above. */
const SUMMARISED: ReadonlySet<string> = new Set(SUMMARISED_TOOLS);

/** Tools whose row already says everything (a job or agent id, a skill name). */
const ROW_SAYS_ALL: ReadonlySet<string> = new Set([
  "shell_output",
  "shell_kill",
  "agent_control",
  "agent_kill",
  "agent_message",
  "agent_status",
  "skill",
]);

export interface ToolNameParts {
  /** An MCP server, drawn `sec` before ` · `; absent for every other tool. */
  readonly server?: string;
  readonly tool: string;
}

const MCP_PREFIX = "mcp__";

/**
 * A step's name: `mcp__<server>__<tool>` (packages/mcp `tool-adapter.ts`) split
 * on the first `__` after the prefix, the tool part shown as is (Owner Q5);
 * every other tool keeps its label. An unparseable MCP name (an empty part) is
 * the raw label: never an empty name.
 */
export function toolName(name: string, label: string): ToolNameParts {
  if (!name.startsWith(MCP_PREFIX)) {
    return { tool: label };
  }
  const rest = name.slice(MCP_PREFIX.length);
  const cut = rest.indexOf("__");
  const server = cut < 0 ? "" : rest.slice(0, cut);
  const tool = cut < 0 ? "" : rest.slice(cut + 2);
  return server === "" || tool === "" ? { tool: label } : { server, tool };
}

/** A JSON object (not an array, not a scalar), or null. */
function objectOf(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON: the caller shows the raw text.
  }
  return null;
}

/** One line: tabs and newlines → spaces (the TUI's `fitSubtitle` flattening). */
function flatten(text: string): string {
  return text
    .replace(/\t/g, " ")
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  return parts.at(-1) ?? path;
}

/** The order a primary target is looked for in MCP / unknown args. */
const PRIMARY_KEYS = [
  "url",
  "path",
  "filename",
  "file",
  "query",
  "command",
  "selector",
  "text",
  "name",
  "element",
] as const;
const PATH_KEYS: ReadonlySet<string> = new Set(["path", "filename", "file"]);

/**
 * An MCP / unknown tool's args as ONE line (Owner Q6), never raw JSON:
 * 1. not a JSON object → the raw text flattened;
 * 2. numeric width + height → `W × H`;
 * 3. the first non-empty string under a primary key (a path as its basename);
 * 4. `key value` pairs joined by ` · ` (`true` → the key, `false`/`null`
 *    dropped, nested → `key …`); `{}` → "".
 */
export function mcpRowArgs(raw: string): string {
  const args = objectOf(raw);
  if (args === null) {
    return flatten(raw);
  }
  if (typeof args.width === "number" && typeof args.height === "number") {
    return `${args.width} × ${args.height}`;
  }
  for (const key of PRIMARY_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") {
      return flatten(PATH_KEYS.has(key) ? basename(value) : value);
    }
  }
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === true) {
      pairs.push(key);
    } else if (typeof value === "string" || typeof value === "number") {
      pairs.push(`${key} ${flatten(String(value))}`);
    } else if (value !== null && typeof value === "object") {
      pairs.push(`${key} …`);
    }
    // false / null (and anything else) say nothing.
  }
  return pairs.join(" · ");
}

/** A positive integer, or undefined. */
function lineNo(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * A read's range text (`A–B`, `A–`, `1–B`), from offset/limit or else a
 * `path:start[:end]` suffix — the two forms `fs_read` takes (builtins.ts
 * `parsePathRange`; offset is 1-based). "" for a whole-file read.
 */
function readRange(args: Record<string, unknown>, path: string): { path: string; range: string } {
  let offset = lineNo(args.offset);
  let limit = lineNo(args.limit);
  let file = path;
  if (offset === undefined && limit === undefined) {
    const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(path);
    if (match?.[1] && match[2] !== undefined) {
      file = match[1];
      offset = Number(match[2]);
      limit = match[3] === undefined ? undefined : Math.max(1, Number(match[3]) - offset + 1);
    }
  }
  if (offset === undefined && limit === undefined) {
    return { path: file, range: "" };
  }
  const start = offset ?? 1;
  return { path: file, range: limit === undefined ? `${start}–` : `${start}–${start + limit - 1}` };
}

/**
 * The ONE line on a step: a file tool's basename (+ ` · A–B`, + ` · N edits`,
 * Owner Q4), the TUI subtitle for the other summarised tools (the row cuts it
 * with `…`), and `mcpRowArgs` for MCP and any unknown tool.
 */
export function rowSubtitle(name: string, raw: string): string {
  if (!SUMMARISED.has(name)) {
    return stripAnsi(mcpRowArgs(raw));
  }
  const args = argsOf(raw);
  const path = typeof args.path === "string" ? args.path : "";
  switch (name) {
    case "fs_read": {
      const read = readRange(args, path);
      const file = basename(read.path);
      return stripAnsi(read.range === "" ? file : `${file} · ${read.range}`);
    }
    case "fs_write":
    case "fs_edit":
      return stripAnsi(basename(path));
    case "fs_multi_edit": {
      const sub = subtitleOf(name, raw);
      // `subtitleOf` is `<path>` or `<path> · N edits`: swap in the basename.
      return stripAnsi(path === "" ? sub : basename(path) + sub.slice(path.length));
    }
    default:
      return stripAnsi(subtitleOf(name, raw));
  }
}

const BODY_LEAF_CAP = 20;

/** `key  value` per leaf, nested keys dotted (`a.b`, `items[0]`). */
function leaves(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${path}  []`);
    }
    value.forEach((item, i) => leaves(item, `${path}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0 && path !== "") {
      out.push(`${path}  {}`);
    }
    for (const [key, item] of entries) {
      leaves(item, path === "" ? key : `${path}.${key}`, out);
    }
    return;
  }
  const text = typeof value === "string" ? flatten(value) : String(value);
  out.push(`${path}  ${text}`);
}

/**
 * What a step's open body shows as the command. A summarised tool: its full
 * `subtitleOf` (the whole path or command, a multi-line command keeping its
 * lines). MCP / unknown: one `key  value` line per leaf, capped at 20 then
 * `… +N more` (non-JSON args: the raw lines, same cap). `[]` when the row
 * already says all of it.
 */
export function bodyCommand(name: string, raw: string): readonly string[] {
  if (SUMMARISED.has(name)) {
    if (ROW_SAYS_ALL.has(name)) {
      return [];
    }
    const full = stripAnsi(subtitleOf(name, raw));
    return full.trim() === "" ? [] : full.split(/\r?\n/);
  }
  const args = objectOf(raw);
  const lines: string[] = [];
  if (args === null) {
    const text = stripAnsi(raw).replace(/\s+$/, "");
    if (text !== "") {
      lines.push(...text.split(/\r?\n/));
    }
  } else {
    leaves(args, "", lines);
  }
  if (lines.length <= BODY_LEAF_CAP) {
    return lines.map(stripAnsi);
  }
  return [
    ...lines.slice(0, BODY_LEAF_CAP).map(stripAnsi),
    `… +${lines.length - BODY_LEAF_CAP} more`,
  ];
}

/** The TUI's cut (`render-lines.ts`): over 8 lines → the first 6 + `… +N more lines`. */
const CUT_OVER = 8;
const CUT_KEEP = 6;

export interface OutputView {
  readonly lines: readonly string[];
  /** Lines held back until "show all" (0 = nothing cut). */
  readonly hidden: number;
  /** Drawn red. */
  readonly error: boolean;
}

/** A result as a step's body shows it: escapes stripped, trailing newlines trimmed, cut. */
export function outputView(
  output: string,
  opts: { readonly full: boolean; readonly error: boolean },
): OutputView {
  const text = stripAnsi(output).replace(/(\r?\n)+$/, "");
  const lines = text === "" ? [] : text.split(/\r?\n/);
  if (opts.full || lines.length <= CUT_OVER) {
    return { lines, hidden: 0, error: opts.error };
  }
  return { lines: lines.slice(0, CUT_KEEP), hidden: lines.length - CUT_KEEP, error: opts.error };
}

function unit(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** `elapsed()` in words, for VoiceOver: `14 milliseconds`, `1.3 seconds`, `2 minutes 5 seconds`. */
export function spokenDuration(ms: number): string {
  if (ms < 1000) {
    return unit(Math.round(ms), "millisecond");
  }
  if (ms < 60_000) {
    const s = (ms / 1000).toFixed(1);
    return `${s} ${s === "1.0" ? "second" : "seconds"}`;
  }
  const seconds = Math.round(ms / 1000);
  const min = unit(Math.floor(seconds / 60), "minute");
  return seconds % 60 === 0 ? min : `${min} ${unit(seconds % 60, "second")}`;
}

/**
 * A clock that ticks once a second (a running step, the "Thinking…" footer):
 * "" under a second, then whole seconds `12 s`, then `2 min 5 s` — `elapsed()`'s
 * shape without its tenths, which would flicker on a 1 s tick.
 */
export function liveElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) {
    return "";
  }
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
