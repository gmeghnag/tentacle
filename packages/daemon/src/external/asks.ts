/**
 * Asks an EXTERNAL caller may answer — protocol-neutral, shared by every
 * external entry (A2A today, MCP next; owner decision 2026-11-25 in
 * docs/feat/a2a.md). PURE: no I/O, no session code.
 *
 * The rule (docs/feat/a2a.md "Asks answered by the caller", slice S5): per
 * caller, `owner` (default: only the owner's devices answer) or `both` (the
 * caller may answer too). Which asks a caller may EVER answer is decided by
 * kind, in core (`EXTERNAL_ANSWER`), fail-closed: only a `tool` ask that is
 * provably the task's own; the caller sends a decision, never an `optionId`,
 * and it is mapped to the ask's own `*_once` option. A remote is not trusted
 * (AGENTS §7): it never creates a lasting approval.
 */
import {
  A2A_ADD_AGENT_TOOL,
  BROWSER_ACTION_TOOL,
  type PermissionKind,
  WORKFLOW_APPROVE_TOOL,
  externalMayAnswer,
  isPermissionReplyText,
} from "@tentacle/core";
import {
  MAX_PERMISSION_REPLY_CHARS,
  type PermissionOption,
  type PermissionRequestUpdate,
} from "@tentacle/protocol";

export type AskMode = "owner" | "both";

/** An ask as the adapter knows it. */
export interface PendingAsk {
  readonly requestId: string;
  readonly title: string;
  /** Absent = not known to be the task's own, or not mappable = owner-only. */
  readonly kind?: PermissionKind;
  readonly options: readonly PermissionOption[];
  /** The asker takes a reply with a refusal, up to this many chars (the wire `reply`). */
  readonly replyMax?: number;
}

/** A caller's decision on one ask. */
export interface CallerAnswer {
  readonly requestId: string;
  readonly decision: "allow" | "deny";
  readonly message?: string;
}

/**
 * Is this ask provably raised by the task's own turn? A turn's own ask (and a
 * foreground sub-agent's) carries no `turnId` and no `agent.id`; a background
 * child's or a workflow step's carries `agent.id`, and `turnId` only when the
 * daemon knows the turn that started it. Only a `turnId` naming the task, or
 * neither marker, is the task's: an unattributed background ask (e.g. a step
 * of a run the OWNER started) is never the caller's to answer.
 */
export function askIsOwn(u: PermissionRequestUpdate, taskTurnId: string): boolean {
  return u.turnId !== undefined ? u.turnId === taskTurnId : u.agent?.id === undefined;
}

/**
 * The adapter's view of a wire ask. Its kind follows the client's own reverse
 * mapping (`toPermissionRequest`, client/permission-router.ts: the workflow
 * approval tool → `workflow_approve`, the browser action tool →
 * `browser_action`, else `tool`); an ask not the task's own
 * gets NO kind (owner-only). `hooks_trust` / `session_hop` never arrive as a
 * daemon ask: hooks trust is a `hooks/trust` request the adapter answers NO,
 * and a hop is the laptop's.
 */
export function askOf(u: PermissionRequestUpdate, own: boolean): PendingAsk {
  const kind: PermissionKind | undefined = !own
    ? undefined
    : u.tool === WORKFLOW_APPROVE_TOOL
      ? "workflow_approve"
      : u.tool === BROWSER_ACTION_TOOL
        ? "browser_action"
        : u.tool === A2A_ADD_AGENT_TOOL
          ? "agent_add"
          : "tool";
  return {
    requestId: u.requestId,
    title: u.title,
    ...(kind !== undefined ? { kind } : {}),
    options: u.options,
    ...(u.reply !== undefined ? { replyMax: u.reply.maxChars } : {}),
  };
}

/** May the CALLER ever answer this ask? Only in `both` mode, and only a kind core marks `once`. */
export function callerMayAnswer(ask: PendingAsk, mode: AskMode): boolean {
  return mode === "both" && externalMayAnswer(ask.kind);
}

/** The ask's own `*_once` option for a decision; null when it offers none (nothing is sent). */
export function onceOption(ask: PendingAsk, decision: "allow" | "deny"): PermissionOption | null {
  const kind = decision === "allow" ? "allow_once" : "reject_once";
  return ask.options.find((o) => o.kind === kind) ?? null;
}

/** The options a caller is shown: `*_once` only, never an `*_always`. */
export function callerOptions(ask: PendingAsk): PermissionOption[] {
  return ask.options.filter((o) => o.kind === "allow_once" || o.kind === "reject_once");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: dropping them is the point
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** A refusal reply as it may go on the wire, or nothing (the same cleaning the client applies). */
function replyText(text: string | undefined, max: number): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const limit = Math.max(0, Math.min(max, MAX_PERMISSION_REPLY_CHARS));
  const clean = text.replace(/\r\n?/g, "\n").replace(CONTROLS, "").trim().slice(0, limit).trimEnd();
  return isPermissionReplyText(clean) ? clean : undefined;
}

/** What the adapter sends for a caller's answer: `session/resolve_permission` params minus the session. */
export interface ResolvedAnswer {
  readonly requestId: string;
  readonly optionId: string;
  readonly message?: string;
}

/**
 * A caller's answer → the one `*_once` option of a caller-answerable pending
 * ask; null (refused, nothing sent) for an ask not pending, not answerable by
 * this caller (owner-only kind, not its own, `owner` mode), or offering no
 * such option. A refusal carries the caller's text only when the ask takes a
 * reply.
 */
export function resolveCallerAnswer(
  answer: CallerAnswer,
  pending: readonly PendingAsk[],
  mode: AskMode,
): ResolvedAnswer | null {
  const ask = pending.find((a) => a.requestId === answer.requestId);
  if (ask === undefined || !callerMayAnswer(ask, mode)) {
    return null;
  }
  const option = onceOption(ask, answer.decision);
  if (option === null) {
    return null;
  }
  const message =
    answer.decision === "deny" && ask.replyMax !== undefined
      ? replyText(answer.message, ask.replyMax)
      : undefined;
  return message === undefined
    ? { requestId: ask.requestId, optionId: option.optionId }
    : { requestId: ask.requestId, optionId: option.optionId, message };
}
