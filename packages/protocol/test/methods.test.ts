import { describe, expect, test } from "bun:test";
import {
  CancelRequestParamsSchema,
  Method,
  ModelStreamProgressValueSchema,
  Notification,
  NotificationSchemas,
  ProgressParamsSchema,
  RequestSchemas,
  isMethodName,
  isNotificationName,
} from "../src/index.ts";
import { EnqueueParamsSchema, InitializeParamsSchema } from "../src/session.ts";

describe("method registry", () => {
  test("every request method has params+result schemas", () => {
    for (const name of Object.values(Method)) {
      expect(RequestSchemas[name]).toBeDefined();
      expect(RequestSchemas[name].params).toBeDefined();
      expect(RequestSchemas[name].result).toBeDefined();
    }
  });

  test("every notification method has a params schema", () => {
    for (const name of Object.values(Notification)) {
      expect(NotificationSchemas[name]).toBeDefined();
    }
  });

  test("type guards", () => {
    expect(isMethodName("initialize")).toBe(true);
    expect(isMethodName("session/update")).toBe(false);
    expect(isNotificationName("session/update")).toBe(true);
    expect(isNotificationName("initialize")).toBe(false);
  });

  test("registry schema validates a real payload", () => {
    const schema = RequestSchemas[Method.Initialize].params;
    expect(schema.safeParse({ protocolVersion: 1, clientCapabilities: {} }).success).toBe(true);
    expect(schema.safeParse({ protocolVersion: 1 }).success).toBe(false);
  });

  test("model/streamChunked is a registered method with strict params/result", () => {
    expect(isMethodName("model/streamChunked")).toBe(true);
    const params = RequestSchemas[Method.ModelStreamChunked].params;
    expect(
      params.safeParse({
        request: { messages: [{ role: "user", content: "hi" }] },
      }).success,
    ).toBe(true);
    // strict: an unknown field is rejected (additive, not a loosened schema).
    expect(params.safeParse({ request: { messages: [] }, bogus: 1 }).success).toBe(false);
    const result = RequestSchemas[Method.ModelStreamChunked].result;
    expect(result.safeParse({ chunks: 3 }).success).toBe(true);
    // No `usage`: it already rides the in-stream `done` event; a redundant field
    // on a strict result would be permanent once shipped (an old laptop sending
    // it would be rejected by a daemon that dropped it).
    expect(
      result.safeParse({ chunks: 3, usage: { promptTokens: 1, completionTokens: 2 } }).success,
    ).toBe(false);
    expect(result.safeParse({ events: [] }).success).toBe(false); // not the batch result
  });

  test("session/enqueue is a registered method with strict params and an empty result", () => {
    expect(isMethodName("session/enqueue")).toBe(true);
    const entry = RequestSchemas[Method.Enqueue];
    // Registered with both a params and a result schema (a request, not a notification).
    expect(entry.params).toBeDefined();
    expect(entry.result).toBeDefined();
    // Validates a real payload.
    const ok = { sessionId: "s1", id: "e1", turnId: "t1", text: "also do X" };
    expect(EnqueueParamsSchema.safeParse(ok).success).toBe(true);
    // Rejects a missing or empty `text` (the thing being injected).
    expect(EnqueueParamsSchema.safeParse({ ...ok, text: undefined }).success).toBe(false);
    expect(EnqueueParamsSchema.safeParse({ ...ok, text: "" }).success).toBe(false);
    // The idempotency key and the turn binding are required, 1..128 chars.
    for (const key of ["id", "turnId"] as const) {
      expect(EnqueueParamsSchema.safeParse({ ...ok, [key]: undefined }).success).toBe(false);
      expect(EnqueueParamsSchema.safeParse({ ...ok, [key]: "" }).success).toBe(false);
      expect(EnqueueParamsSchema.safeParse({ ...ok, [key]: "x".repeat(129) }).success).toBe(false);
    }
    // Rejects an empty session id and unknown fields (strict, additive).
    expect(EnqueueParamsSchema.safeParse({ ...ok, sessionId: "" }).success).toBe(false);
    expect(EnqueueParamsSchema.safeParse({ ...ok, bogus: 1 }).success).toBe(false);
    // The result is an empty object (the daemon accepts; the model sees it later).
    expect(entry.result.safeParse({}).success).toBe(true);
    expect(entry.result.safeParse({ ok: true }).success).toBe(false); // strict, no extra fields
  });

  test("$/progress and $/cancelRequest are registered notifications with strict params", () => {
    expect(isNotificationName("$/progress")).toBe(true);
    expect(isNotificationName("$/cancelRequest")).toBe(true);
    const progress = ProgressParamsSchema;
    expect(
      progress.safeParse({
        id: "1",
        seq: 0,
        value: { type: "text", delta: "a" },
      }).success,
    ).toBe(true);
    // strict + ordered: a bad seq or unknown field is rejected.
    expect(
      progress.safeParse({ id: "1", seq: -1, value: { type: "text", delta: "a" } }).success,
    ).toBe(false);
    expect(
      progress.safeParse({ id: "1", seq: 0, value: { type: "text", delta: "a" }, x: 1 }).success,
    ).toBe(false);
    const cancel = CancelRequestParamsSchema;
    expect(cancel.safeParse({ id: "1" }).success).toBe(true);
    expect(cancel.safeParse({}).success).toBe(false);
    // They are also in the notification registry (so the peer can route them).
    expect(NotificationSchemas[Notification.Progress]).toBeDefined();
    expect(NotificationSchemas[Notification.CancelRequest]).toBeDefined();
  });

  test("$/progress is GENERIC: any value routes; model/streamChunked validates its own batch shape", () => {
    // The peer primitive must not be tied to one method's payload (tool output,
    // remote tool calls build on it): it checks only id + seq.
    expect(
      ProgressParamsSchema.safeParse({ id: "1", seq: 0, value: { bytes: "xyz" } }).success,
    ).toBe(true);
    // model/streamChunked's value is a non-empty batch of wire events.
    expect(
      ModelStreamProgressValueSchema.safeParse([{ type: "text", delta: "a" }, { type: "done" }])
        .success,
    ).toBe(true);
    expect(ModelStreamProgressValueSchema.safeParse([]).success).toBe(false);
    expect(ModelStreamProgressValueSchema.safeParse({ type: "text", delta: "a" }).success).toBe(
      false,
    );
  });

  test("initialize carries NO capability field (old daemon must accept a new laptop's handshake)", () => {
    // Regression for the rejected `chunkedModel` capability: `ClientCapabilitiesSchema`
    // is .strict() and validated INBOUND by the daemon, so adding a field there would
    // make an old daemon reject a new laptop's `initialize` with InvalidParams.
    expect(
      InitializeParamsSchema.safeParse({
        protocolVersion: 1,
        clientCapabilities: { streaming: true },
      }).success,
    ).toBe(true);
    expect(
      InitializeParamsSchema.safeParse({
        protocolVersion: 1,
        clientCapabilities: { streaming: true, chunkedModel: true },
      }).success,
    ).toBe(false);
    // And a new client's real payload (no chunkedModel) still parses.
    expect(
      InitializeParamsSchema.safeParse({ protocolVersion: 1, clientCapabilities: {} }).success,
    ).toBe(true);
  });
});
