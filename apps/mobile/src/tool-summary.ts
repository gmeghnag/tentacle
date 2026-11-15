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
import type { ToolRow } from "./transcript-rows.ts";

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
   * duration; "" when the row knows none of them. Never an exit code: a
   * `ToolResult` carries none, so the row does not invent one.
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

export function toolMeta(row: Pick<ToolRow, "status" | "durationMs" | "diff">): ToolMeta {
  const tone = TONE[row.status];
  if (row.diff !== undefined) {
    return { tone, trailing: `+${row.diff.added} −${row.diff.removed}` };
  }
  if (row.status === "denied") {
    return { tone, trailing: "denied" };
  }
  return { tone, trailing: row.durationMs === undefined ? "" : elapsed(row.durationMs) };
}

export function toolSummary(row: Pick<ToolRow, "name" | "label" | "args" | "output">): ToolSummary {
  return {
    label: row.label,
    subtitle: stripAnsi(subtitleOf(row.name, row.args)),
    output: stripAnsi(row.output ?? ""),
  };
}
