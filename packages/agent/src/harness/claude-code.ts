/**
 * The Claude Code `CliCodec` (docs/feat/subagent-harness-runners.md D2, D4).
 * Pure: argv, stream-json line parsing, the stdin lines we write. Fixtures are
 * the 2026-11-25 Repro shapes of `claude` 2.1.331.
 */

import type {
  CliCodec,
  HarnessCaps,
  HarnessDecision,
  HarnessEvent,
  HarnessRunSpec,
} from "./types.ts";

export const CLAUDE_CODE_ID = "claude-code";
/** Oldest `claude` whose flags/events the Repro verified. */
export const CLAUDE_CODE_VERSION_FLOOR = "2.1.331";

export const CLAUDE_CODE_CAPS: HarnessCaps = {
  permissionAsks: true,
  inputRequired: false,
  steer: true,
  usage: true,
  cost: true,
  quota: true,
  structuredResult: true,
  workspace: "local",
};

/** What a write run may use unless the caller narrows it (D8). */
export const CLAUDE_DEFAULT_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "Bash",
];

/** The `claude` sub-agent type's description (D3: a ROLE; the model is per call). */
export const CLAUDE_TYPE_DESCRIPTION =
  "Claude Code, another agent harness, on this machine: works on a snapshot of the current tree (uncommitted changes included) in its own git worktree, and may edit files and run commands there. Its changes stay on a branch it reports — never merged. Use it when the user asks for Claude or Claude Code.";

/** How the `model` argument works for the `claude` type (D3, Owner A1). */
export function claudeModelNote(defaultModel: string | undefined): string {
  return `for \`claude\`: an alias — \`opus\`, \`sonnet\`, \`haiku\` (Claude Code resolves each to the latest) — or a full model id; omit it for the default (\`harnesses.claude-code.model\`, now ${defaultModel ?? "Claude Code's own"})`;
}

/** 1–64 chars, no leading `-`: one argv element, never a flag (D3). */
const MODEL_SHAPE = /^[A-Za-z0-9._:[\]][A-Za-z0-9._:[\]-]{0,63}$/;
const TOOL_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function isModelShape(model: string): boolean {
  return MODEL_SHAPE.test(model);
}

/** `a.b.c` ≥ `x.y.z`; a version we cannot read is NOT at least anything. */
export function versionAtLeast(version: string, floor: string): boolean {
  const parse = (v: string): number[] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  };
  const a = parse(version);
  const b = parse(floor);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}
function num(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A row label for a Claude tool call, in the shape `childToolLabel` makes. */
export function claudeToolLabel(name: string, input: unknown): string {
  const o = rec(input);
  switch (name) {
    case "Bash": {
      const desc = str(o, "description")?.trim();
      return desc ? desc : `$ ${str(o, "command") ?? ""}`.trimEnd();
    }
    case "Read":
      return `Read ${str(o, "file_path") ?? ""}`.trimEnd();
    case "Write":
      return `Write ${str(o, "file_path") ?? ""}`.trimEnd();
    case "Edit":
      return `Edit ${str(o, "file_path") ?? ""}`.trimEnd();
    case "Grep":
    case "Glob":
      return `Search ${str(o, "pattern") ?? ""} in ${str(o, "path") ?? "."}`.trimEnd();
    default:
      return name;
  }
}

/** A fresh codec = ONE run (the parser keeps the usage-dedupe state). */
export function createClaudeCodeCodec(): CliCodec {
  // message id → the largest usage already reported for it.
  const seen = new Map<string, { p: number; c: number }>();

  const usageOf = (message: Record<string, unknown>): HarnessEvent[] => {
    const id = str(message, "id");
    const u = rec(message.usage);
    const p =
      (num(u, "input_tokens") ?? 0) +
      (num(u, "cache_creation_input_tokens") ?? 0) +
      (num(u, "cache_read_input_tokens") ?? 0);
    const c = num(u, "output_tokens") ?? 0;
    if (id === undefined || (p === 0 && c === 0)) return [];
    const prev = seen.get(id) ?? { p: 0, c: 0 };
    const dp = Math.max(0, p - prev.p);
    const dc = Math.max(0, c - prev.c);
    seen.set(id, { p: Math.max(p, prev.p), c: Math.max(c, prev.c) });
    return dp > 0 || dc > 0 ? [{ kind: "usage", promptTokens: dp, completionTokens: dc }] : [];
  };

  const parseResult = (o: Record<string, unknown>): HarnessEvent => {
    const text = str(o, "result");
    const costUsd = num(o, "total_cost_usd");
    const subtype = str(o, "subtype");
    const terminal = str(o, "terminal_reason");
    const base = { kind: "end" as const, ...(costUsd !== undefined ? { costUsd } : {}) };
    // Key on `is_error`, never on `subtype`: a failed login is subtype "success" (Repro 7).
    if (o.is_error !== true) {
      return {
        ...base,
        status: "completed",
        text: text ?? "",
        ...(o.structured_output !== undefined ? { structured: o.structured_output } : {}),
      };
    }
    if (subtype === "error_max_budget_usd")
      return {
        ...base,
        status: "budget",
        ...(text ? { text } : {}),
        error: text ?? "budget exceeded",
      };
    if (terminal === "aborted_streaming")
      return { ...base, status: "cancelled", ...(text ? { text } : {}) };
    const error =
      text && /not logged in/i.test(text)
        ? "Claude Code: Not logged in — run `claude /login` on this machine"
        : (text ?? subtype ?? "Claude Code failed");
    return { ...base, status: "failed", ...(text ? { text } : {}), error };
  };

  return {
    id: CLAUDE_CODE_ID,
    versionFloor: CLAUDE_CODE_VERSION_FLOOR,

    argv(spec: HarnessRunSpec): string[] {
      if (spec.mode !== "write") throw new Error('claude-code runs only in mode "write"');
      const tools = spec.tools ?? CLAUDE_DEFAULT_TOOLS;
      for (const t of tools)
        if (!TOOL_SHAPE.test(t)) throw new Error(`invalid tool name: ${JSON.stringify(t)}`);
      // Never a Claude-side permission mode (dontAsk/acceptEdits/auto/bypassPermissions): every
      // decision reaches us through `--permission-prompt-tool stdio` (D4). The prompt goes on stdin.
      const args = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--restricted",
        "--permission-prompt-tool",
        "stdio",
        "--tools",
        tools.join(","),
      ];
      if (spec.model !== undefined) {
        if (!isModelShape(spec.model))
          throw new Error(`invalid model: ${JSON.stringify(spec.model)}`);
        args.push("--model", spec.model);
      }
      if (spec.jsonSchema !== undefined)
        args.push("--json-schema", JSON.stringify(spec.jsonSchema));
      return args;
    },

    parse(line: string): HarnessEvent[] | null {
      let o: Record<string, unknown>;
      try {
        const v: unknown = JSON.parse(line);
        if (!v || typeof v !== "object" || Array.isArray(v)) return null;
        o = v as Record<string, unknown>;
      } catch {
        return null;
      }
      switch (o.type) {
        case "system": {
          if (o.subtype !== "init") return [];
          const sessionId = str(o, "session_id");
          if (!sessionId) return [];
          const tools = Array.isArray(o.tools)
            ? o.tools.filter((t): t is string => typeof t === "string")
            : undefined;
          const permissionMode = str(o, "permissionMode");
          const version = str(o, "claude_code_version");
          return [
            {
              kind: "started",
              handle: { adapter: CLAUDE_CODE_ID, id: sessionId },
              detail: {
                ...(tools ? { tools } : {}),
                ...(permissionMode ? { permissionMode } : {}),
                ...(version ? { version } : {}),
              },
            },
          ];
        }
        case "assistant": {
          const message = rec(o.message);
          const out: HarnessEvent[] = [];
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              const b = rec(block);
              if (b.type === "tool_use" && typeof b.name === "string")
                out.push({ kind: "progress", label: claudeToolLabel(b.name, b.input) });
            }
          }
          out.push(...usageOf(message));
          return out;
        }
        case "rate_limit_event": {
          const info = rec(o.rate_limit_info);
          const overall = str(info, "status") === "allowed";
          const windows = rec(info.unifiedWindows);
          const out: HarnessEvent[] = [];
          for (const [window, w] of Object.entries(windows)) {
            const r = rec(w);
            const utilization = num(r, "utilization");
            const resetsAt = num(r, "resetsAt");
            out.push({
              kind: "quota",
              window,
              ...(utilization !== undefined ? { utilization } : {}),
              ...(resetsAt !== undefined ? { resetsAt } : {}),
              allowed: overall && (str(r, "status") ?? "allowed") === "allowed",
            });
          }
          if (out.length === 0) {
            const resetsAt = num(info, "resetsAt");
            out.push({
              kind: "quota",
              window: str(info, "rateLimitType") ?? "unknown",
              ...(resetsAt !== undefined ? { resetsAt } : {}),
              allowed: overall,
            });
          }
          return out;
        }
        case "control_request": {
          const req = rec(o.request);
          const askId = str(o, "request_id");
          // Only `can_use_tool` is an ask; a `permission_suggestions` field is never read (D4).
          if (req.subtype !== "can_use_tool" || !askId || typeof req.tool_name !== "string")
            return [];
          return [
            {
              kind: "ask",
              askId,
              ask: { type: "permission", tool: req.tool_name, input: req.input },
            },
          ];
        }
        case "result":
          return [parseResult(o)];
        default:
          return [];
      }
    },

    answer(askId: string, decision: HarnessDecision): string {
      const response = decision.allow
        ? { behavior: "allow", updatedInput: decision.input }
        : { behavior: "deny", message: decision.message };
      return JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: askId, response },
      });
    },

    interrupt(): string {
      return JSON.stringify({
        type: "control_request",
        request_id: "int-1",
        request: { subtype: "interrupt" },
      });
    },

    userMessage(text: string): string {
      return JSON.stringify({ type: "user", message: { role: "user", content: text } });
    },
  };
}
