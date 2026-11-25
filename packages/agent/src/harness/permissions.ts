/**
 * D4 (docs/feat/subagent-harness-runners.md): a harness child's permission ask
 * goes through the session's `PermissionGate` — its hooks, its tree's grants,
 * and the requester the runner built with `subagentRequester`, i.e. the ONE
 * broker, attributed to the `agent_task` call / `sa-N`. Nothing here reads the
 * auto-mode bit: an ask is an ordinary `kind: "tool"` request, so the broker's
 * own auto-accept answers it (Owner A2).
 *
 * The one decision taken here is the run-scoped in-worktree rule: an `Edit` /
 * `Write` whose path (after the gate's hooks) is inside the run's worktree
 * passes without a prompt. It is never stored as a grant and dies with the run.
 */

import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type PermissionLevel, type PermissionRequester, type Tool, denyAll } from "@tentacle/core";
import { z } from "zod";
import { type SessionCapabilities, isToolDisabled } from "../capabilities.ts";
import type { HookRunner } from "../hooks.ts";
import { PermissionGate } from "../permission-gate.ts";
import { redactText } from "../redact.ts";
import type { SessionGrants } from "../session-grants.ts";
import type { HarnessAsk, HarnessDecision } from "./types.ts";

/** What the runner hands a harness child so its asks reach the one broker. */
export interface HarnessPermissions {
  /** The parent's requester wrapped by `subagentRequester` (attributed). */
  readonly requester: PermissionRequester;
  readonly hooks?: HookRunner;
  /** The session tree's grants and ask lane (shared with every child). */
  readonly grants: SessionGrants;
  readonly sessionId: string;
  /** The session's own tool, by name: its configured level wins over the default `ask`. */
  readonly tool?: (name: string) => Tool | undefined;
  /**
   * The parent session's capability switches, read LIVE per ask: a built-in
   * turned off (`shell`, `fs_write`, `fs_edit`) refuses the ask it maps to,
   * before any rule, grant or broker — as a tentacle child's call is refused.
   */
  readonly capabilities?: () => SessionCapabilities;
}

/** A refusal with no reason of its own. */
export const HARNESS_ASK_DENIED = "denied by tentacle's permission broker";

/** An ask mapped onto a tentacle tool identity, and back. */
export interface MappedAsk {
  readonly tool: Tool;
  readonly input: unknown;
  /** The tentacle input the gate approved → the input the harness runs. */
  readonly back: (approved: unknown) => unknown;
  /** No "always" for this one: a session answer is honoured once (no grant). */
  readonly onceOnly: boolean;
  /** The prompt's title for a generic ask (`Claude wants <Name>`). */
  readonly title?: string;
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function stub(name: string, permission: PermissionLevel, description: string): Tool {
  return {
    name,
    description,
    inputSchema: z.unknown(),
    permission,
    execute: async () => ({ content: "not executable: a harness ask identity", isError: true }),
  };
}

/**
 * Claude Code's tool → the tentacle tool it is decided as: `Bash` → `shell`,
 * `Write` → `fs_write`, `Edit` → `fs_edit`; anything else a generic
 * `claude:<Name>` ask with no session scope.
 */
export function mapClaudeAsk(
  name: string,
  input: unknown,
  tool: (name: string) => Tool | undefined = () => undefined,
): MappedAsk {
  const raw = rec(input);
  const own = (n: string, d: string): Tool => tool(n) ?? stub(n, "ask", d);
  switch (name) {
    case "Bash":
      return {
        tool: own("shell", "Run a shell command"),
        input: { command: typeof raw.command === "string" ? raw.command : "" },
        back: (a) => ({ ...raw, command: rec(a).command }),
        onceOnly: false,
      };
    case "Write":
      return {
        tool: own("fs_write", "Write a file"),
        input: { path: raw.file_path, content: raw.content },
        back: (a) => {
          const r = rec(a);
          return { ...raw, file_path: r.path, content: r.content };
        },
        onceOnly: false,
      };
    case "Edit":
      return {
        tool: own("fs_edit", "Edit a file"),
        input: {
          path: raw.file_path,
          old_string: raw.old_string,
          new_string: raw.new_string,
          ...(raw.replace_all !== undefined ? { replace_all: raw.replace_all } : {}),
        },
        back: (a) => {
          const r = rec(a);
          return {
            ...raw,
            file_path: r.path,
            old_string: r.old_string,
            new_string: r.new_string,
            ...(r.replace_all !== undefined ? { replace_all: r.replace_all } : {}),
          };
        },
        onceOnly: false,
      };
    default:
      return {
        tool: stub(`claude:${name}`, "ask", `Claude wants ${name}`),
        input,
        back: (a) => a,
        onceOnly: true,
        title: `Claude wants ${name}`,
      };
  }
}

/**
 * Whether `path` (absolute, or relative to `root`) is a file inside `root`
 * once canonicalised: no `..` segment, the nearest existing ancestor's
 * `realpath` inside the root's, the file itself not a symlink leading out, and
 * nothing under `.git` (it would redirect the worktree's own git). Any doubt →
 * `false` (the person is asked).
 */
export async function insideWorktree(root: string, path: string): Promise<boolean> {
  if (path === "" || path.split(/[\\/]/).includes("..")) return false;
  try {
    const realRoot = await realpath(root);
    const abs = isAbsolute(path) ? path : join(root, path);
    // The nearest existing ancestor of the file, canonicalised.
    let dir = dirname(abs);
    const rest: string[] = [basename(abs)];
    for (;;) {
      try {
        dir = await realpath(dir);
        break;
      } catch {
        const up = dirname(dir);
        if (up === dir) return false;
        rest.unshift(basename(dir));
        dir = up;
      }
    }
    let target = resolve(dir, ...rest);
    const st = await lstat(target).catch(() => undefined);
    if (st?.isSymbolicLink()) target = await realpath(target);
    const rel = relative(realRoot, target);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return false;
    return rel.split(sep)[0] !== ".git";
  } catch {
    return false;
  }
}

const DETAIL_CAP = 2000;

/** A generic ask's subject: its input as JSON, capped. */
function detailOf(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? String(input);
  } catch {
    text = String(input);
  }
  return text.length > DETAIL_CAP ? `${text.slice(0, DETAIL_CAP)}…` : text;
}

function pathOf(input: unknown): string | undefined {
  const p = rec(input).path;
  return typeof p === "string" ? p : undefined;
}

/** The consent ask's detail: the outbound text shown, at most this many chars. */
export const REMOTE_SEND_DETAIL_CAP = 2000;

/**
 * Consent before anything leaves for a REMOTE harness (docs/feat/a2a-client.md
 * C3/C4, Owner A10): the outbound text is `redactText`-ed ALWAYS, then decided
 * by the session's gate as the stub tool `<adapter.id>` (`a2a:<name>`) — its
 * hooks may block or rewrite `prompt`, a session answer is a whole-tool grant
 * on THAT agent (the gate remembers it), and the requester is the child's
 * (`subagentRequester` → the ONE broker). An ordinary `kind: "tool"` ask: auto
 * mode answers it at the broker; nothing here reads the bit. Absent `perms` →
 * `denyAll`: nothing is sent.
 */
export async function authorizeRemoteSend(
  perms: HarnessPermissions | undefined,
  send: {
    /** `a2a:<name>`: the tool identity a grant is kept on. */
    readonly agent: string;
    /** The pinned origin, shown first in the detail. */
    readonly origin?: string;
    readonly text: string;
    readonly askId: string;
    readonly signal: AbortSignal;
  },
): Promise<
  | { readonly allow: true; readonly text: string }
  | { readonly allow: false; readonly message: string }
> {
  const name = send.agent.startsWith("a2a:") ? send.agent.slice(4) : send.agent;
  const tool = stub(send.agent, "ask", `Send a task to the remote agent ${name}`);
  const base = perms?.requester ?? denyAll;
  const requester: PermissionRequester = (req, options) => {
    const shown = redactText(String(rec(req.input).prompt ?? ""));
    const body =
      shown.length > REMOTE_SEND_DETAIL_CAP
        ? `${shown.slice(0, REMOTE_SEND_DETAIL_CAP)} (+${shown.length - REMOTE_SEND_DETAIL_CAP} chars)`
        : shown;
    return base(
      {
        ...req,
        title: `Send a task to ${name}`,
        detail: send.origin !== undefined ? `${send.origin} · ${body}` : body,
      },
      { ...options, signal: send.signal },
    );
  };
  const gate = new PermissionGate(requester, perms?.hooks, perms?.grants);
  const outcome = await gate.authorize(
    tool,
    { prompt: redactText(send.text) },
    { sessionId: perms?.sessionId ?? "", toolCallId: send.askId, signal: send.signal },
  );
  if (outcome.allowed) {
    // A hook's rewrite is what leaves — redacted again (C4: ALWAYS).
    return { allow: true, text: redactText(String(rec(outcome.input).prompt ?? "")) };
  }
  if (outcome.by === "hook") {
    return {
      allow: false,
      message: `blocked by a tentacle hook${outcome.hookName ? ` (${outcome.hookName})` : ""}${outcome.reason ? `: ${outcome.reason}` : ""}`,
    };
  }
  if (outcome.by === "unavailable") {
    return { allow: false, message: outcome.reason ?? "nobody to ask" };
  }
  return { allow: false, message: outcome.message ?? "refused" };
}

/**
 * Decide one harness ask. `worktreeRoot`: the run's worktree (a write run) —
 * the in-worktree rule applies only with one. `signal`: the run's; aborting it
 * withdraws the ask at the broker.
 */
export async function authorizeHarnessAsk(
  perms: HarnessPermissions | undefined,
  ask: Extract<HarnessAsk, { type: "permission" }>,
  call: { readonly askId: string; readonly signal: AbortSignal; readonly worktreeRoot?: string },
): Promise<HarnessDecision> {
  const mapped = mapClaudeAsk(ask.tool, ask.input, perms?.tool);
  const caps = perms?.capabilities?.();
  if (caps !== undefined && isToolDisabled(mapped.tool.name, caps)) {
    return {
      allow: false,
      message: `${HARNESS_ASK_DENIED}: \`${mapped.tool.name}\` is turned off for this session`,
    };
  }
  const base = perms?.requester ?? denyAll;
  const root = call.worktreeRoot;
  // Between the gate (after its hooks and grants) and the broker.
  const requester: PermissionRequester = async (req, options) => {
    if (root !== undefined && (req.tool === "fs_write" || req.tool === "fs_edit")) {
      const p = pathOf(req.input);
      if (p !== undefined && (await insideWorktree(root, p))) return { allowed: true };
    }
    const asked =
      mapped.title !== undefined
        ? { ...req, title: mapped.title, detail: detailOf(req.input) }
        : req;
    const answer = await base(asked, { ...options, signal: call.signal });
    return mapped.onceOnly && answer.scope === "session" ? { ...answer, scope: "once" } : answer;
  };
  const gate = new PermissionGate(requester, perms?.hooks, perms?.grants);
  const outcome = await gate.authorize(mapped.tool, mapped.input, {
    sessionId: perms?.sessionId ?? "",
    toolCallId: call.askId,
    signal: call.signal,
  });
  if (outcome.allowed) return { allow: true, input: mapped.back(outcome.input) };
  if (outcome.by === "hook") {
    return {
      allow: false,
      message: `blocked by a tentacle hook${outcome.hookName ? ` (${outcome.hookName})` : ""}${outcome.reason ? `: ${outcome.reason}` : ""}`,
    };
  }
  if (outcome.by === "unavailable") {
    return { allow: false, message: `${HARNESS_ASK_DENIED}: ${outcome.reason ?? "nobody to ask"}` };
  }
  return {
    allow: false,
    message: outcome.message ? `${HARNESS_ASK_DENIED}: ${outcome.message}` : HARNESS_ASK_DENIED,
  };
}
