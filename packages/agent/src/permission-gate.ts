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
import { CONTEXT_RESET_TOOL_NAME } from "@tentacle/tools";
import type { HookRunner } from "./hooks.ts";
import { ABORTED, SessionGrants } from "./session-grants.ts";
import { suggestShellPrefix } from "./shell-prefix.ts";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
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
    // Several edits, one file: the same act as `fs_edit`, so the same title — and
    // its subject says HOW MANY, the one thing that differs (the transcript row
    // words it the same way, tui/src/render-lines.ts). Without a readable
    // `edits` the file's path alone still beats the `—` fallback.
    case "fs_multi_edit":
      return { ...base, title: "Edit a file", ...detail(multiEditSubject(obj, str)) };
    // The user sees what the model keeps: everything else is discarded.
    case CONTEXT_RESET_TOOL_NAME:
      return {
        ...base,
        title: "Reset the context (the model restarts from its prompt)",
        ...detail(str("prompt")),
      };
    default:
      return { ...base, title: `Run ${toolLabel(tool.name)}` };
  }
}

function detail(value: string | undefined): { detail?: string } {
  return value !== undefined ? { detail: value } : {};
}

/**
 * A `fs_multi_edit` call's subject for the permission prompt: the path, and
 * ` · N edit(s)` when the input's `edits` really is a non-empty array. A hook
 * may rewrite the input to a shape this cannot read: then it is the path alone,
 * or no detail at all (never a throw, and never a count taken from a guess).
 */
function multiEditSubject(
  obj: Record<string, unknown>,
  str: (key: string) => string | undefined,
): string | undefined {
  const path = str("path");
  const edits = obj.edits;
  const count = Array.isArray(edits) ? edits.length : 0;
  const how = count === 0 ? "" : `${count} ${count === 1 ? "edit" : "edits"}`;
  if (path === undefined) {
    return how === "" ? undefined : how;
  }
  return how === "" ? path : `${path} · ${how}`;
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
      /** The person's reply with the refusal (`by: "user"`, docs/feat/permission-reply.md). */
      readonly message?: string;
    };

export interface GateCall {
  readonly sessionId: string;
  readonly toolCallId: string;
  /** The first call of this call's group (`PermissionRequestOptions.groupStart`). */
  readonly groupStart?: string;
  readonly signal: AbortSignal;
}

/** The lane's answer when a rule granted meanwhile covers the call. */
const COVERED: unique symbol = Symbol("covered");

export class PermissionGate {
  /**
   * `grants`: the session tree's rules and ask lane (docs/feat/parallel-agents.md,
   * Design 3). Absent → a private store, as an agent alone has.
   */
  constructor(
    private readonly requester: PermissionRequester,
    private readonly hooks?: HookRunner,
    private readonly grants: SessionGrants = new SessionGrants(),
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
    if (force !== "ask" && this.grants.covers(tool, effective)) {
      return run;
    }
    const request = describeToolCall(tool, effective);
    // One ask at a time for the tree; a waiter re-checks once admitted, so an
    // "always" answered ahead of it covers it without a second dialog.
    const response = await this.grants.serial(call.signal, async () => {
      if (force !== "ask" && this.grants.covers(tool, effective)) {
        return COVERED;
      }
      // Explicit attribution: the daemon must not guess the call from its stream
      // (docs/feat/permission-call-attribution.md).
      const answer = await this.requester(request, {
        toolCallId: call.toolCallId,
        origin: "call",
        ...(call.groupStart !== undefined ? { groupStart: call.groupStart } : {}),
      });
      if (answer.allowed && answer.scope === "session") {
        this.grants.remember(tool, request);
      }
      return answer;
    });
    if (response === ABORTED) {
      // Cancelled in the lane: never prompted; the caller reports the cancel.
      return { allowed: false, input: effective, by: "user" };
    }
    if (response === COVERED) {
      return run;
    }
    if (response.allowed) {
      return run;
    }
    if (response.reason !== undefined) {
      return { allowed: false, input: effective, by: "unavailable", reason: response.reason };
    }
    // A refusal never creates a rule; its reply (if any) only goes to the model.
    return {
      allowed: false,
      input: effective,
      by: "user",
      ...(response.message !== undefined ? { message: response.message } : {}),
    };
  }
}
