/**
 * Method registry — the single catalogue binding each wire method name to its
 * param/result schemas. A dispatcher validates `params` with the entry here
 * before handling, and validates `result` before replying. Keeping this in one
 * place keeps client and daemon provably in sync.
 */
import type { z } from "zod";
import {
  CancelRequestParamsSchema,
  ModelStreamChunkedParamsSchema,
  ModelStreamChunkedResultSchema,
  ModelStreamParamsSchema,
  ModelStreamResultSchema,
  ProgressParamsSchema,
} from "./model.ts";
import { RequestPermissionParamsSchema, RequestPermissionResultSchema } from "./permission.ts";
import {
  CancelParamsSchema,
  CompactParamsSchema,
  CompactResultSchema,
  InitializeParamsSchema,
  InitializeResultSchema,
  NewSessionParamsSchema,
  NewSessionResultSchema,
  PromptParamsSchema,
  PromptResultSchema,
  SnapshotParamsSchema,
  SnapshotResultSchema,
} from "./session.ts";
import { SessionUpdateParamsSchema } from "./updates.ts";

/** Request methods (expect a response). */
export const Method = {
  Initialize: "initialize",
  NewSession: "session/new",
  Prompt: "session/prompt",
  Compact: "session/compact",
  Snapshot: "session/snapshot",
  RequestPermission: "session/request_permission",
  ModelStream: "model/stream",
  ModelStreamChunked: "model/streamChunked",
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
  [Method.NewSession]: { params: NewSessionParamsSchema, result: NewSessionResultSchema },
  [Method.Prompt]: { params: PromptParamsSchema, result: PromptResultSchema },
  [Method.Compact]: { params: CompactParamsSchema, result: CompactResultSchema },
  [Method.Snapshot]: { params: SnapshotParamsSchema, result: SnapshotResultSchema },
  [Method.RequestPermission]: {
    params: RequestPermissionParamsSchema,
    result: RequestPermissionResultSchema,
  },
  [Method.ModelStream]: { params: ModelStreamParamsSchema, result: ModelStreamResultSchema },
  [Method.ModelStreamChunked]: {
    params: ModelStreamChunkedParamsSchema,
    result: ModelStreamChunkedResultSchema,
  },
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
