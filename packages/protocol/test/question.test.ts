/**
 * docs/feat/a2a-client.md C6 (a2c-4): a remote agent's question on the wire.
 * Mutations: class `question_request` as `display` → the blocking test is red;
 * drop the method from `METHOD_SCHEMAS` → the method test is red.
 */
import { describe, expect, test } from "bun:test";
import {
  AnswerQuestionParamsSchema,
  BLOCKING_UPDATE_TYPES,
  KNOWN_UPDATE_TYPES,
  MAX_QUESTION_ANSWER_CHARS,
  Method,
  PushAskSchema,
  QuestionRequestUpdateSchema,
  RequestSchemas,
  SessionUpdateSchema,
  UPDATE_CLASS,
  WatchStateSchema,
  watchCategoriesOf,
} from "../src/index.ts";

const question = {
  type: "question_request" as const,
  requestId: "r-1",
  toolCallId: "call-1",
  title: "acme asks",
  question: "Which branch?",
  agent: { type: "a2a:acme", description: "review", id: "sa-1" },
  maxChars: 4000,
};

describe("question_request", () => {
  test("is a blocking update every build declares", () => {
    expect(UPDATE_CLASS.question_request).toBe("blocking");
    expect(BLOCKING_UPDATE_TYPES.has("question_request")).toBe(true);
    expect(KNOWN_UPDATE_TYPES).toContain("question_request");
  });

  test("parses as a session update; an unknown field is dropped (strip schema)", () => {
    const parsed = SessionUpdateSchema.parse({ ...question, extra: 1 });
    expect(parsed).toEqual(question);
    expect(QuestionRequestUpdateSchema.safeParse({ ...question, maxChars: 0 }).success).toBe(false);
  });

  test("an over-long remote question still parses (blocking: never unparseable)", () => {
    expect(
      QuestionRequestUpdateSchema.safeParse({ ...question, question: "q".repeat(100_000) }).success,
    ).toBe(true);
  });

  test("is an `ask` for logs/watch, and a pending one rides the watch state", () => {
    expect(watchCategoriesOf(question)).toEqual(["ask"]);
    expect(WatchStateSchema.parse({ running: false, pending: [question] }).pending).toEqual([
      question,
    ]);
  });
});

// docs/fix/a2a-question-workflow-label.md: the step's origin rides the question.
// Mutations: make `workflow` required → the "without it" case is red; add
// `.int()`/`.max()` to `AskWorkflowSchema` → the hostile-numbers case is red.
describe("question_request.workflow", () => {
  const wf = { name: "rassegna", runId: "wf-1", stepId: "generate", index: 1, count: 5 };

  test("round-trips the five fields, and is absent on an older daemon's update", () => {
    const parsed = SessionUpdateSchema.parse({ ...question, workflow: wf });
    expect(parsed).toEqual({ ...question, workflow: wf });
    // An older daemon sends none: still a valid question (nothing becomes blocking).
    expect(QuestionRequestUpdateSchema.parse(question)).toEqual(question);
  });

  test("a bad value never makes the blocking update unparseable", () => {
    const hostile = { name: "n".repeat(10_000), runId: "r", stepId: "s", index: -1, count: 1e9 };
    const parsed = QuestionRequestUpdateSchema.safeParse({ ...question, workflow: hostile });
    expect(parsed.success).toBe(true);
    expect(
      QuestionRequestUpdateSchema.safeParse({
        ...question,
        workflow: { ...wf, index: 1.5, count: 1e9 },
      }).success,
    ).toBe(true);
    // The one thing the schema does insist on: `name` is a string (`AskWorkflowSchema`).
    expect(
      QuestionRequestUpdateSchema.safeParse({ ...question, workflow: { name: 3 } }).success,
    ).toBe(false);
  });
});

describe("session/answer_question", () => {
  test("is a known method", () => {
    expect(Method.AnswerQuestion).toBe("session/answer_question");
    expect(RequestSchemas[Method.AnswerQuestion]).toBeDefined();
  });

  test("an answer is 1..MAX chars, no controls but \\n/\\t, not blank; absent = skip", () => {
    const base = { sessionId: "s-1", requestId: "r-1" };
    expect(AnswerQuestionParamsSchema.safeParse(base).success).toBe(true);
    expect(
      AnswerQuestionParamsSchema.safeParse({ ...base, answer: "main\n\tplease" }).success,
    ).toBe(true);
    expect(AnswerQuestionParamsSchema.safeParse({ ...base, answer: "" }).success).toBe(false);
    expect(AnswerQuestionParamsSchema.safeParse({ ...base, answer: "   " }).success).toBe(false);
    expect(AnswerQuestionParamsSchema.safeParse({ ...base, answer: "a\u001bb" }).success).toBe(
      false,
    );
    expect(
      AnswerQuestionParamsSchema.safeParse({
        ...base,
        answer: "x".repeat(MAX_QUESTION_ANSWER_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});

describe("PushAsk.question", () => {
  test("a question push carries its answer bound", () => {
    const ask = PushAskSchema.parse({
      requestId: "r-1",
      tool: "a2a:acme",
      title: "acme asks",
      preview: "Which branch?",
      options: [{ optionId: "skip", kind: "reject_once", name: "Skip" }],
      question: { maxChars: 4000 },
    });
    expect(ask.question).toEqual({ maxChars: 4000 });
  });
});
