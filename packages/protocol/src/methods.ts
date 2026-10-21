/**
 * Method registry — the single catalogue binding each wire method name to its
 * param/result schemas. A dispatcher validates `params` with the entry here
 * before handling, and validates `result` before replying. Keeping this in one
 * place keeps client and daemon provably in sync.
 */
import type { z } from "zod";
import { McpStatusParamsSchema, McpStatusResultSchema } from "./mcp.ts";
import {
  CancelRequestParamsSchema,
  ModelStreamChunkedParamsSchema,
  ModelStreamChunkedResultSchema,
  ModelStreamParamsSchema,
  ModelStreamResultSchema,
  ProgressParamsSchema,
} from "./model.ts";
import { ResolvePermissionParamsSchema, ResolvePermissionResultSchema } from "./permission.ts";
import {
  CancelParamsSchema,
  CloseParamsSchema,
  CloseResultSchema,
  CompactParamsSchema,
  CompactResultSchema,
  EnqueueParamsSchema,
  EnqueueResultSchema,
  InitializeParamsSchema,
  InitializeResultSchema,
  OpenParamsSchema,
  OpenResultSchema,
  PromptParamsSchema,
  PromptResultSchema,
  SnapshotParamsSchema,
  SnapshotResultSchema,
} from "./session.ts";
import { SkillsListParamsSchema, SkillsListResultSchema } from "./skills.ts";
import { SessionUpdateParamsSchema } from "./updates.ts";

/** Request methods (expect a response). */
export const Method = {
  Initialize: "initialize",
  Open: "session/open",
  Close: "session/close",
  Prompt: "session/prompt",
  Compact: "session/compact",
  Snapshot: "session/snapshot",
  Enqueue: "session/enqueue",
  ResolvePermission: "session/resolve_permission",
  ModelStream: "model/stream",
  ModelStreamChunked: "model/streamChunked",
  McpStatus: "mcp/status",
  SkillsList: "skills/list",
} as const;
export type MethodName = (typeof Method)[keyof typeof Method];

/** Notification methods (no response). */
export const Notification = {
  SessionUpdate: "session/update",
  Cancel: "session/cancel",
  Progress: "$/progress",
  CancelRequest: "$/cancelRequest",
} as const;
export type NotificationName = (typeof Notification)[keyof typeof Notification];

interface RequestSchema {
  readonly params: z.ZodTypeAny;
  readonly result: z.ZodTypeAny;
}

/** params/result schema for every request method. */
export const RequestSchemas: Readonly<Record<MethodName, RequestSchema>> = {
  [Method.Initialize]: { params: InitializeParamsSchema, result: InitializeResultSchema },
  [Method.Open]: { params: OpenParamsSchema, result: OpenResultSchema },
  [Method.Close]: { params: CloseParamsSchema, result: CloseResultSchema },
  [Method.Prompt]: { params: PromptParamsSchema, result: PromptResultSchema },
  [Method.Compact]: { params: CompactParamsSchema, result: CompactResultSchema },
  [Method.Snapshot]: { params: SnapshotParamsSchema, result: SnapshotResultSchema },
  [Method.Enqueue]: { params: EnqueueParamsSchema, result: EnqueueResultSchema },
  [Method.ResolvePermission]: {
    params: ResolvePermissionParamsSchema,
    result: ResolvePermissionResultSchema,
  },
  [Method.ModelStream]: { params: ModelStreamParamsSchema, result: ModelStreamResultSchema },
  [Method.ModelStreamChunked]: {
    params: ModelStreamChunkedParamsSchema,
    result: ModelStreamChunkedResultSchema,
  },
  [Method.McpStatus]: { params: McpStatusParamsSchema, result: McpStatusResultSchema },
  [Method.SkillsList]: { params: SkillsListParamsSchema, result: SkillsListResultSchema },
};

/** params schema for every notification method. */
export const NotificationSchemas: Readonly<Record<NotificationName, z.ZodTypeAny>> = {
  [Notification.SessionUpdate]: SessionUpdateParamsSchema,
  [Notification.Cancel]: CancelParamsSchema,
  [Notification.Progress]: ProgressParamsSchema,
  [Notification.CancelRequest]: CancelRequestParamsSchema,
};

export function isMethodName(value: string): value is MethodName {
  return value in RequestSchemas;
}

export function isNotificationName(value: string): value is NotificationName {
  return value in NotificationSchemas;
}
