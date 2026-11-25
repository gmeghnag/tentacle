/**
 * A turn's `WorkUnit` as an MCP task (docs/feat/serve-mcp-server.md, Design §5;
 * slice M4). PURE: no I/O, no clock (`now` is passed in).
 *
 * The A2A rules (`a2a/mapping.ts` `projectStatus`) with MCP words. Which ask the
 * caller may answer is the SHARED `callerMayAnswer` (kind table in core), never
 * a copy. The spec keeps `failed` for JSON-RPC errors, so a turn that failed is
 * `completed` + `result.isError`. A task lives as long as its unit: no MCP store.
 */
import type { WorkUnit } from "@tentacle/core";
import { type AskMode, type PendingAsk, callerMayAnswer } from "../external/asks.ts";
import {
  type CallToolResult,
  type ElicitationRequest,
  type TaskFields,
  type TaskView,
  decisionElicitation,
} from "./wire.ts";

export const TASK_POLL_INTERVAL_MS = 2000;
/** A task lives as long as its unit (the ended-units bound and the archive), not a timer. */
export const TASK_TTL_MS = null;
export const RESULT_NOT_RETAINED = "result no longer retained";

export interface TaskInput {
  readonly unit: WorkUnit;
  /** The pending asks raised by THIS turn. */
  readonly asks: readonly PendingAsk[];
  readonly mode: AskMode;
  /** The request declared elicitation `form`. */
  readonly elicitationForm: boolean;
  /** When the call was accepted (a live unit carries no `startedAt`). */
  readonly acceptedAt?: number;
  readonly now: number;
}

/** The asks of a task the caller may answer (only in `both`, only a kind core marks `once`). */
export function answerableAsks(asks: readonly PendingAsk[], mode: AskMode): PendingAsk[] {
  return asks.filter((a) => callerMayAnswer(a, mode));
}

/** The elicitation message of one ask (the caller answers allow or deny, once). */
export function askPrompt(ask: PendingAsk): string {
  return `Allow once? ${ask.title}`;
}

/**
 * An `inputResponses` entry → a decision. Only `accept` with `decision: "allow"`
 * allows; `decline`, `cancel` and anything ambiguous deny (fail-closed).
 */
export function decisionOf(response: unknown): "allow" | "deny" {
  if (typeof response !== "object" || response === null) return "deny";
  const r = response as { action?: unknown; content?: unknown };
  if (r.action !== "accept" || typeof r.content !== "object" || r.content === null) return "deny";
  return (r.content as { decision?: unknown }).decision === "allow" ? "allow" : "deny";
}

const iso = (ms: number) => new Date(ms).toISOString();

function finalResult(unit: WorkUnit, isError: boolean): CallToolResult {
  const text =
    unit.resultDropped === true
      ? RESULT_NOT_RETAINED
      : isError
        ? (unit.reason ?? "the turn failed")
        : (unit.result ?? "");
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      turnId: unit.id,
      ...(isError
        ? { error: unit.reason ?? "the turn failed" }
        : unit.result !== undefined
          ? { result: unit.result }
          : {}),
      ...(unit.resultDropped === true ? { resultDropped: true } : {}),
    },
    ...(isError ? { isError: true } : {}),
  };
}

/** The task as `tasks/get` returns it (and, at creation, its fields). */
export function projectTask(input: TaskInput): TaskView {
  const { unit } = input;
  const created = unit.startedAt ?? input.acceptedAt ?? input.now;
  const fields: TaskFields = {
    taskId: unit.id,
    status: "working",
    createdAt: iso(created),
    lastUpdatedAt: iso(unit.endedAt ?? Math.max(created, input.now)),
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: TASK_POLL_INTERVAL_MS,
  };
  switch (unit.state) {
    case "working":
      return fields;
    case "waiting": {
      if (unit.waitingFor !== "permission") {
        return { ...fields, statusMessage: "waiting for the owner" };
      }
      const answerable = answerableAsks(input.asks, input.mode);
      if (answerable.length > 0 && input.elicitationForm) {
        const inputRequests: Record<string, ElicitationRequest> = {};
        for (const a of answerable) inputRequests[a.requestId] = decisionElicitation(askPrompt(a));
        return { ...fields, status: "input_required", inputRequests };
      }
      if (answerable.length > 0) {
        return {
          ...fields,
          statusMessage: `approval needed: ${answerable.map((a) => `${a.title} — session_answer requestId=${a.requestId}`).join("; ")}`,
        };
      }
      const title = input.asks[0]?.title;
      return {
        ...fields,
        statusMessage: `waiting for the owner's approval${title === undefined ? "" : `: ${title}`}`,
      };
    }
    case "completed":
      return {
        ...fields,
        status: "completed",
        ...(unit.reason !== undefined ? { statusMessage: unit.reason } : {}),
        result: finalResult(unit, false),
      };
    case "failed":
      return {
        ...fields,
        status: "completed",
        statusMessage: unit.reason ?? "the turn failed",
        result: finalResult(unit, true),
      };
    case "canceled":
      return { ...fields, status: "cancelled" };
  }
}
