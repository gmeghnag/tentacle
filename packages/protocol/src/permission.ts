/**
 * `session/request_permission` (agent → client request).
 *
 * When a tool call requires approval, the agent asks the connected client to
 * choose one of the offered options. The `*_always` kinds let a client persist
 * the decision so future equivalent calls are auto-approved/denied by the
 * permission engine (F4).
 */
import { z } from "zod";
import { SessionIdSchema } from "./session.ts";

export const PermissionOptionKindSchema = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);
export type PermissionOptionKind = z.infer<typeof PermissionOptionKindSchema>;

export const PermissionOptionSchema = z.object({
  optionId: z.string().min(1),
  name: z.string(),
  kind: PermissionOptionKindSchema,
});
export type PermissionOption = z.infer<typeof PermissionOptionSchema>;

export const RequestPermissionParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    toolCallId: z.string().min(1),
    title: z.string(),
    explanation: z.string().optional(),
    options: z.array(PermissionOptionSchema).min(1),
  })
  .strict();
export type RequestPermissionParams = z.infer<typeof RequestPermissionParamsSchema>;

/** The client either selects an option or the request is cancelled (e.g. turn aborted). */
export const PermissionOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("selected"), optionId: z.string().min(1) }),
  z.object({ outcome: z.literal("cancelled") }),
]);
export type PermissionOutcome = z.infer<typeof PermissionOutcomeSchema>;

export const RequestPermissionResultSchema = z
  .object({
    outcome: PermissionOutcomeSchema,
  })
  .strict();
export type RequestPermissionResult = z.infer<typeof RequestPermissionResultSchema>;
