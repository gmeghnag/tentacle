/**
 * Method registry — the single catalogue binding each wire method name to its
 * param/result schemas. A dispatcher validates `params` with the entry here
 * before handling, and validates `result` before replying. Keeping this in one
 * place keeps client and daemon provably in sync.
 */
import type { z } from "zod";
import { SessionTtlParamsSchema, SessionTtlResultSchema } from "./daemon.ts";
import { HooksTrustParamsSchema, HooksTrustResultSchema } from "./hooks.ts";
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
  DeleteParamsSchema,
  DeleteResultSchema,
  DetachParamsSchema,
  DetachResultSchema,
  EnqueueParamsSchema,
  EnqueueResultSchema,
  InitializeParamsSchema,
  InitializeResultSchema,
  OpenParamsSchema,
  OpenResultSchema,
  PromptParamsSchema,
  PromptResultSchema,
  ReclaimParamsSchema,
  ReclaimResultSchema,
  RenameParamsSchema,
  RenameResultSchema,
  SendNowParamsSchema,
  SessionListParamsSchema,
  SessionListResultSchema,
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
  Detach: "session/detach",
  SessionDelete: "session/delete",
  Prompt: "session/prompt",
  Compact: "session/compact",
  Snapshot: "session/snapshot",
  Enqueue: "session/enqueue",
  SendNow: "session/send_now",
  SessionList: "session/list",
  Rename: "session/rename",
  Reclaim: "session/reclaim",
  ResolvePermission: "session/resolve_permission",
  ModelStream: "model/stream",
  ModelStreamChunked: "model/streamChunked",
  McpStatus: "mcp/status",
  SkillsList: "skills/list",
  SessionTtl: "daemon/session_ttl",
  /** Daemon → client: may this session run the project's hooks? */
  HooksTrust: "hooks/trust",
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
  [Method.Detach]: { params: DetachParamsSchema, result: DetachResultSchema },
  [Method.SessionDelete]: { params: DeleteParamsSchema, result: DeleteResultSchema },
  [Method.Prompt]: { params: PromptParamsSchema, result: PromptResultSchema },
  [Method.Compact]: { params: CompactParamsSchema, result: CompactResultSchema },
  [Method.Snapshot]: { params: SnapshotParamsSchema, result: SnapshotResultSchema },
  [Method.Enqueue]: { params: EnqueueParamsSchema, result: EnqueueResultSchema },
  [Method.SendNow]: { params: SendNowParamsSchema, result: PromptResultSchema },
  [Method.SessionList]: { params: SessionListParamsSchema, result: SessionListResultSchema },
  [Method.Rename]: { params: RenameParamsSchema, result: RenameResultSchema },
  [Method.Reclaim]: { params: ReclaimParamsSchema, result: ReclaimResultSchema },
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
  [Method.SessionTtl]: { params: SessionTtlParamsSchema, result: SessionTtlResultSchema },
  [Method.HooksTrust]: { params: HooksTrustParamsSchema, result: HooksTrustResultSchema },
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
