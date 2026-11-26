/**
 * A remote agent's question to the person (docs/feat/a2a-client.md C6): a
 * sub-agent run by a remote A2A agent stopped on `INPUT_REQUIRED`, and the
 * question goes to the owner as a POP-UP — the same ask machinery as a
 * permission request, a different update and answer.
 *
 * - `question_request` is BLOCKING (`UPDATE_CLASS`): sent only to a session
 *   one of whose clients declared it; some client attached and none did → the
 *   daemon SKIPS the question at once (the child takes its other route, or
 *   ends with the question). Replayed on attach while pending, like an ask.
 * - It is settled by the SAME `permission_resolved` as a permission request
 *   (one "this ask is over" channel; `requestId` is a fresh nonce, so the two
 *   never collide). Its outcome names `answer` or `skip` (display only).
 * - `session/answer_question` answers it: a text, or no text = skip. First
 *   answer wins; not pending → `PermissionNotPending`, no effect.
 *
 * The question is remote content (data, not instructions): a surface bounds
 * and sanitises it when it shows it; no `.max()` here, as for
 * `permission_request.agent`, so an over-long value never makes this blocking
 * update unparseable.
 */
import { z } from "zod";
import { AskWorkflowSchema, PermissionRequestIdSchema } from "./permission.ts";
import { SessionIdSchema } from "./session.ts";

/** The longest answer to a remote question, in UTF-16 units (the daemon refuses longer). */
export const MAX_QUESTION_ANSWER_CHARS = 4000;

/** The internal option ids a question settles with (the `permission_resolved` outcome). */
export const QUESTION_ANSWER_OPTION = "answer";
export const QUESTION_SKIP_OPTION = "skip";

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const NO_CONTROL_BUT_NL_TAB = /^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/;

/** An answer's text: 1..`MAX_QUESTION_ANSWER_CHARS`, no control character but `\n`/`\t`, not blank. */
export const QuestionAnswerTextSchema = z
  .string()
  .min(1)
  .max(MAX_QUESTION_ANSWER_CHARS)
  .regex(NO_CONTROL_BUT_NL_TAB)
  .regex(/\S/, { message: "an answer is not whitespace-only" });

/** A remote agent asks the person; the asking child waits for the answer. */
export const QuestionRequestUpdateSchema = z.object({
  type: z.literal("question_request"),
  requestId: PermissionRequestIdSchema,
  /** The `agent_task` call whose child asked. */
  toolCallId: z.string().min(1),
  /** «`<name>` asks». */
  title: z.string(),
  /** The remote agent's question (remote text: bounded and sanitised where shown). */
  question: z.string(),
  /** The sub-agent that asked (display only, as `permission_request.agent`). */
  agent: z
    .object({ type: z.string(), description: z.string(), id: z.string().optional() })
    .optional(),
  /**
   * The workflow step this question belongs to, when a step's child raised it:
   * the SAME shape and rules as `permission_request.workflow` (display only;
   * absent on an older daemon, or when no workflow step asked).
   * (docs/fix/a2a-question-workflow-label.md)
   */
  workflow: AskWorkflowSchema.optional(),
  /** A BACKGROUND child's spawning turn (as `permission_request.turnId`). */
  turnId: z.string().optional(),
  /** The longest answer the daemon takes (a client clamps to `MAX_QUESTION_ANSWER_CHARS`). */
  maxChars: z.number().int().min(1),
  /** The device labels it was raised to (as `permission_request.askedOn`). */
  askedOn: z.array(z.string()).optional(),
});
export type QuestionRequestUpdate = z.infer<typeof QuestionRequestUpdateSchema>;

// --- session/answer_question ---------------------------------------------

export const AnswerQuestionParamsSchema = z.object({
  sessionId: SessionIdSchema,
  requestId: PermissionRequestIdSchema,
  /** The person's answer; absent = skip (the remote is not answered). */
  answer: QuestionAnswerTextSchema.optional(),
});
export type AnswerQuestionParams = z.infer<typeof AnswerQuestionParamsSchema>;

export const AnswerQuestionResultSchema = z.object({});
export type AnswerQuestionResult = z.infer<typeof AnswerQuestionResultSchema>;
