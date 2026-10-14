/**
 * Permission gate: turns a tool call into an authorization decision.
 *
 * `"none"` tools run freely, `"deny"` tools never run, and `"ask"` tools are
 * routed to the `PermissionRequester`. A `session`-scoped approval is remembered
 * as a *rule* so the user is not asked again — but narrowly: for shell the rule
 * is a command *prefix* (e.g. `git commit`), so only matching future commands
 * auto-run; for other tools it is the whole tool. The gate checks its rules
 * before prompting, so an approved-prefix command runs without a round-trip.
 */
import type { PermissionRequest, PermissionRequester, Tool } from "@agent-harness/core";
import { commandCoveredByPrefixes, suggestShellPrefix } from "./shell-prefix.ts";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function commandOf(input: unknown): string | undefined {
  const value = asRecord(input).command;
  return typeof value === "string" ? value : undefined;
}

/** Build the prompt request for a tool call (title, subject, suggested rule). */
export function describeToolCall(tool: Tool, input: unknown): PermissionRequest {
  const obj = asRecord(input);
  const str = (key: string): string | undefined =>
    typeof obj[key] === "string" ? (obj[key] as string) : undefined;

  const base = { tool: tool.name, level: tool.permission, input } as const;
  switch (tool.name) {
    case "shell": {
      const command = str("command") ?? "";
      const prefix = suggestShellPrefix(command);
      return {
        ...base,
        title: "Run a shell command",
        ...(command ? { detail: command } : {}),
        ...(prefix ? { suggestion: { prefix } } : {}),
      };
    }
    case "fs_write":
      return { ...base, title: "Write a file", ...detail(str("path")) };
    case "fs_edit":
      return { ...base, title: "Edit a file", ...detail(str("path")) };
    default:
      return { ...base, title: `Run ${tool.name}` };
  }
}

function detail(value: string | undefined): { detail?: string } {
  return value !== undefined ? { detail: value } : {};
}

export class PermissionGate {
  /** Non-shell tools approved for the whole session. */
  private readonly grantedTools = new Set<string>();
  /** Approved shell command prefixes (e.g. `git commit`). */
  private readonly shellPrefixes: string[] = [];

  constructor(private readonly requester: PermissionRequester) {}

  /** `true` to run the tool, `false` to refuse it. */
  async authorize(tool: Tool, input: unknown): Promise<boolean> {
    if (tool.permission === "none") {
      return true;
    }
    if (tool.permission === "deny") {
      return false;
    }
    if (this.isRemembered(tool, input)) {
      return true;
    }
    const request = describeToolCall(tool, input);
    const response = await this.requester(request);
    if (response.allowed && response.scope === "session") {
      this.remember(tool, request);
    }
    return response.allowed;
  }

  /** Whether an existing session rule already covers this call. */
  private isRemembered(tool: Tool, input: unknown): boolean {
    if (tool.name === "shell") {
      const command = commandOf(input);
      return command !== undefined && commandCoveredByPrefixes(command, this.shellPrefixes);
    }
    return this.grantedTools.has(tool.name);
  }

  /** Persist a session-scoped approval as the narrowest applicable rule. */
  private remember(tool: Tool, request: PermissionRequest): void {
    if (tool.name === "shell" && request.suggestion) {
      if (!this.shellPrefixes.includes(request.suggestion.prefix)) {
        this.shellPrefixes.push(request.suggestion.prefix);
      }
      return;
    }
    this.grantedTools.add(tool.name);
  }
}
