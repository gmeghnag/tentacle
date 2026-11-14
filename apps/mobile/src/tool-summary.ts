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

export function toolSummary(row: Pick<ToolRow, "name" | "label" | "args" | "output">): ToolSummary {
  return {
    label: row.label,
    subtitle: stripAnsi(subtitleOf(row.name, row.args)),
    output: stripAnsi(row.output ?? ""),
  };
}
