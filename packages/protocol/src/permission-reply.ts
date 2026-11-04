/**
 * The person's reply with a refusal (docs/feat/permission-reply.md): "No,
 * let's talk about it". It rides `session/resolve_permission.message` (the
 * answer) and, as `denialReply`, the refused call's `tool_call_update` and
 * tool `ChatMessage` (display only: the row shows it instead of the model's
 * text). Its own module so `session.ts` and `permission.ts` share it without
 * an import cycle.
 */
import { z } from "zod";

/** The longest reply, in UTF-16 units (the daemon refuses longer; a client clamps first). */
export const MAX_PERMISSION_REPLY_CHARS = 2000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const NO_CONTROL_BUT_NL_TAB = /^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/;

/**
 * A reply's text: 1..`MAX_PERMISSION_REPLY_CHARS`, no control character but
 * `\n` and `\t`, not whitespace-only. Typed by a person on the laptop or the
 * phone; from a pod (`denialReply`) it is display-only and bounded the same way.
 */
export const PermissionReplyTextSchema = z
  .string()
  .min(1)
  .max(MAX_PERMISSION_REPLY_CHARS)
  .regex(NO_CONTROL_BUT_NL_TAB)
  // A pattern, not a refine: the JSON Schema export represents patterns only.
  .regex(/\S/, { message: "a reply is not whitespace-only" });
