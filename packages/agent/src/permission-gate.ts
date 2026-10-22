/**
 * Permission gate: turns a tool call into an authorization decision.
 *
 * `"none"` tools run freely, `"deny"` tools never run, and `"ask"` tools are
 * routed to the `PermissionRequester`. A `session`-scoped approval is remembered
 * as a *rule* so the user is not asked again — but narrowly: for shell the rule
 * is a command *prefix* (e.g. `git commit`), so only matching future commands
 * auto-run; for other tools it is the whole tool. The gate checks its rules
 * before prompting, so an approved-prefix command runs without a round-trip.
 *
 * User `tool_call` hooks (docs/feat/hooks-core.md) are consulted here, after
 * the absolute `"deny"` level (H3) and BEFORE everything else: a hook may deny
 * the call, rewrite its input (so the prompt and the remembered rules see the
 * input that will actually run), or force an allow / a prompt. A hook `allow`
 * is never remembered.
 */
import {
  type PermissionRequest,
  type PermissionRequester,
  type Tool,
  toolLabel,
} from "@tentacle/core";
import type { HookRunner } from "./hooks.ts";
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
      return { ...base, title: `Run ${toolLabel(tool.name)}` };
  }
}

function detail(value: string | undefined): { detail?: string } {
  return value !== undefined ? { detail: value } : {};
}

/** The gate's answer: run (with the effective `input`) or refuse, and who decided. */
export type GateOutcome =
  | {
      readonly allowed: true;
      readonly input: unknown;
      readonly modified: boolean;
      /** The last hook that rewrote the input (set when `modified`). */
      readonly hookName?: string;
    }
  | {
      readonly allowed: false;
      readonly input: unknown;
      /** `unavailable`: nobody could be asked (`reason` says why). */
      readonly by: "user" | "hook" | "unavailable";
      /** The hook's own reason (`by: "hook"`), or why nobody could be asked (`unavailable`). */
      readonly reason?: string;
      /** The hook that refused (`by: "hook"`). */
      readonly hookName?: string;
    };

export interface GateCall {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
}

export class PermissionGate {
  /** Non-shell tools approved for the whole session. */
  private readonly grantedTools = new Set<string>();
  /** Approved shell command prefixes (e.g. `git commit`). */
  private readonly shellPrefixes: string[] = [];

  constructor(
    private readonly requester: PermissionRequester,
    private readonly hooks?: HookRunner,
  ) {}

  async authorize(tool: Tool, input: unknown, call: GateCall): Promise<GateOutcome> {
    // H3: a "deny"-level tool is refused before any hook can vote.
    if (tool.permission === "deny") {
      return { allowed: false, input, by: "user" };
    }
    let effective = input;
    let modified = false;
    let hookName: string | undefined;
    let force: "allow" | "ask" | null = null;
    if (this.hooks?.hasAny("tool_call")) {
      const verdict = await this.hooks.toolCall({
        sessionId: call.sessionId,
        toolName: tool.name,
        toolCallId: call.toolCallId,
        input,
        signal: call.signal,
      });
      if (verdict.kind === "deny") {
        return {
          allowed: false,
          input,
          by: "hook",
          reason: verdict.reason,
          hookName: verdict.hook,
        };
      }
      effective = verdict.input;
      modified = verdict.modified;
      hookName = verdict.hook;
      force = verdict.force;
      // Cancelled while a hook ran: never prompt; the caller reports the cancel.
      if (call.signal.aborted) {
        return { allowed: false, input: effective, by: "user" };
      }
    }
    const run: GateOutcome = {
      allowed: true,
      input: effective,
      modified,
      ...(hookName !== undefined ? { hookName } : {}),
    };
    if (force === "allow") {
      return run;
    }
    if (tool.permission === "none" && force !== "ask") {
      return run;
    }
    if (force !== "ask" && this.isRemembered(tool, effective)) {
      return run;
    }
    const request = describeToolCall(tool, effective);
    const response = await this.requester(request);
    if (response.allowed && response.scope === "session") {
      this.remember(tool, request);
    }
    if (response.allowed) {
      return run;
    }
    return response.reason !== undefined
      ? { allowed: false, input: effective, by: "unavailable", reason: response.reason }
      : { allowed: false, input: effective, by: "user" };
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
