/**
 * The MCP tasks methods (docs/feat/serve-mcp-server.md, Design §5–§6; slice
 * M4): `tasks/get` · `tasks/update` · `tasks/cancel` of the ext-tasks
 * extension (2026-07-28). Only for a request that declared the extension
 * (else `-32021`, `wire.requireTasks`). A task is the PROJECTION of its turn's
 * work unit (`task-projection.ts`): nothing is stored here. An unknown,
 * foreign, malformed or evicted taskId is one answer, `-32602 unknown task`.
 */
import { projectTask } from "./task-projection.ts";
import type { McpTools } from "./tools.ts";
import {
  ErrorCode,
  type ParsedRequest,
  type WireReply,
  requireTasks,
  rpcError,
  rpcResult,
  taskResult,
} from "./wire.ts";

export const UNKNOWN_TASK = "unknown task";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One `tasks/*` request → its reply. `audit` gets `mcp-answer-refused` per refused key. */
export async function tasksMethod(
  tools: McpTools,
  r: ParsedRequest,
  caller: string,
  audit?: (line: string) => void,
): Promise<WireReply> {
  const undeclared = requireTasks(r);
  if (undeclared !== undefined) return undeclared;
  const taskId = r.params.taskId;
  if (typeof taskId !== "string") {
    return rpcError(r.id, ErrorCode.InvalidParams, "taskId: a string");
  }
  const unknown = () => rpcError(r.id, ErrorCode.InvalidParams, UNKNOWN_TASK);
  switch (r.method) {
    case "tasks/get": {
      const t = await tools.task(caller, taskId);
      if (t === undefined) return unknown();
      const view = projectTask({
        unit: t.unit,
        asks: t.asks,
        mode: t.mode,
        elicitationForm: r.caps.elicitationForm,
        ...(t.acceptedAt !== undefined ? { acceptedAt: t.acceptedAt } : {}),
        now: Date.now(),
      });
      return rpcResult(r.id, taskResult(view));
    }
    case "tasks/update": {
      const responses = r.params.inputResponses;
      if (!isRecord(responses)) {
        return rpcError(r.id, ErrorCode.InvalidParams, "inputResponses: an object");
      }
      const { found, refused } = await tools.answerTask(caller, taskId, responses);
      if (!found) return unknown();
      for (let i = 0; i < refused; i++) audit?.("mcp-answer-refused");
      return rpcResult(r.id, {});
    }
    case "tasks/cancel":
      return (await tools.cancelTask(caller, taskId)) ? rpcResult(r.id, {}) : unknown();
    default:
      return rpcError(r.id, ErrorCode.MethodNotFound, `unknown method ${r.method}`);
  }
}
