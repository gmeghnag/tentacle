/**
 * Permissions as session state (docs/feat/permission-events.md).
 *
 * When a tool call requires approval, the daemon SUSPENDS the turn and streams
 * a `permission_request` update to every attached client (replayed on attach
 * while it is pending). Any client that opened the session answers with
 * `session/resolve_permission`; the first valid answer wins and every client
 * gets `permission_resolved`, which closes its dialog. There is no timeout: a
 * request ends only by an answer or by its turn being cancelled/closed
 * (`cancelled`) — never by a socket or a clock.
 *
 * - `requestId` is a fresh nonce per ask (never derived from the tool call,
 *   the turn or a counter): a late answer to an old request can never bind to
 *   a new one. Clients treat it as opaque.
 * - `PermissionNotPending`: the session exists but the request is not pending
 *   (answered elsewhere, cancelled, never issued, or from before a restart).
 *   No side effect; the winning outcome arrives as `permission_resolved`. An
 *   option that was not offered is `InvalidParams`, and the request STAYS
 *   pending — a malformed answer is never a denial.
 * - `permission_resolved` is display-only for a client: it never answers,
 *   records or pre-approves anything (a pod daemon is not trusted).
 *
 * The `*_always` kinds ask the daemon to remember a session-scoped rule.
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

/** A permission request's nonce (see the module comment). */
export const PermissionRequestIdSchema = z.string().min(1).max(128);

/** A client selected an option, or the request's turn was cancelled/closed. */
export const PermissionOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("selected"), optionId: z.string().min(1) }),
  z.object({ outcome: z.literal("cancelled") }),
]);
export type PermissionOutcome = z.infer<typeof PermissionOutcomeSchema>;

/** The turn is suspended until this request is answered (or the turn ends). */
export const PermissionRequestUpdateSchema = z.object({
  type: z.literal("permission_request"),
  requestId: PermissionRequestIdSchema,
  toolCallId: z.string().min(1),
  /** The tool's name, so a client rebuilds the request the daemon's gate built. */
  tool: z.string(),
  title: z.string(),
  explanation: z.string().optional(),
  /** The narrower rule an `allow_always` creates (a shell command prefix). */
  suggestion: z.object({ prefix: z.string() }).optional(),
  options: z.array(PermissionOptionSchema).min(1),
  /**
   * The sub-agent that asked, inside call `toolCallId` (absent: the call asked
   * for itself). Display only, from a daemon that may be a pod: no `.max()`, so
   * an over-long value never makes this blocking update unparseable — the
   * laptop bounds it when it renders it.
   */
  agent: z.object({ type: z.string(), description: z.string() }).optional(),
});
export type PermissionRequestUpdate = z.infer<typeof PermissionRequestUpdateSchema>;

/** The request was settled — by the first answer, or by its turn's cancel. */
export const PermissionResolvedUpdateSchema = z.object({
  type: z.literal("permission_resolved"),
  requestId: PermissionRequestIdSchema,
  outcome: PermissionOutcomeSchema,
});
export type PermissionResolvedUpdate = z.infer<typeof PermissionResolvedUpdateSchema>;

// --- session/resolve_permission ------------------------------------------
// Answer a pending request with one of its offered options. Needs an `open`
// of the session on this connection, like every session command.

export const ResolvePermissionParamsSchema = z.object({
  sessionId: SessionIdSchema,
  requestId: PermissionRequestIdSchema,
  optionId: z.string().min(1),
});
export type ResolvePermissionParams = z.infer<typeof ResolvePermissionParamsSchema>;

export const ResolvePermissionResultSchema = z.object({});
export type ResolvePermissionResult = z.infer<typeof ResolvePermissionResultSchema>;
