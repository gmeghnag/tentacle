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
import { CancelParamsSchema, EnqueueParamsSchema, InitializeParamsSchema } from "../src/session.ts";

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

  test("model/streamChunked is a registered method; unknown fields are stripped", () => {
    expect(isMethodName("model/streamChunked")).toBe(true);
    const params = RequestSchemas[Method.ModelStreamChunked].params;
    expect(
      params.safeParse({
        request: { messages: [{ role: "user", content: "hi" }] },
      }).success,
    ).toBe(true);
    // (v10 forward compat: an unknown field is stripped, never used)
    const extra = params.safeParse({ request: { messages: [] }, bogus: 1 });
    expect(extra.success && "bogus" in extra.data).toBe(false);
    const result = RequestSchemas[Method.ModelStreamChunked].result;
    expect(result.safeParse({ chunks: 3 }).success).toBe(true);
    // No `usage`: it already rides the in-stream `done` event; a sent one is stripped.
    const withUsage = result.safeParse({
      chunks: 3,
      usage: { promptTokens: 1, completionTokens: 2 },
    });
    expect(withUsage.success && withUsage.data).toEqual({ chunks: 3 });
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
    // Rejects an empty session id; an unknown field is stripped (v10 forward compat: an unknown field is stripped, never used).
    expect(EnqueueParamsSchema.safeParse({ ...ok, sessionId: "" }).success).toBe(false);
    const extra = EnqueueParamsSchema.safeParse({ ...ok, bogus: 1 });
    expect(extra.success && "bogus" in extra.data).toBe(false);
    // The result is an empty object (the daemon accepts; the model sees it later).
    expect(entry.result.safeParse({}).success).toBe(true);
    expect(entry.result.safeParse({ ok: true }).data).toEqual({}); // stripped
  });

  test("$/progress and $/cancelRequest are registered notifications (bad known fields rejected)", () => {
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
    // Ordered: a bad seq is rejected; an unknown field is stripped.
    expect(
      progress.safeParse({ id: "1", seq: -1, value: { type: "text", delta: "a" } }).success,
    ).toBe(false);
    const extra = progress.safeParse({
      id: "1",
      seq: 0,
      value: { type: "text", delta: "a" },
      x: 1,
    });
    expect(extra.success && "x" in extra.data).toBe(false);
    const cancel = CancelRequestParamsSchema;
    expect(cancel.safeParse({ id: "1" }).success).toBe(true);
    expect(cancel.safeParse({}).success).toBe(false);
    // They are also in the notification registry (so the peer can route them).
    expect(NotificationSchemas[Notification.Progress]).toBeDefined();
    expect(NotificationSchemas[Notification.CancelRequest]).toBeDefined();
  });

  test("session/cancel: an optional turnId (additive, no bump); an older build drops it", () => {
    const schema = NotificationSchemas[Notification.Cancel];
    expect(schema.safeParse({ sessionId: "s1" }).data).toEqual({ sessionId: "s1" });
    expect(schema.safeParse({ sessionId: "s1", turnId: "t1" }).data).toEqual({
      sessionId: "s1",
      turnId: "t1",
    });
    expect(schema.safeParse({ sessionId: "s1", turnId: "" }).success).toBe(false);
    // An older protocol-11 build's schema (no `turnId`) parses the new frame
    // and strips the field: it cancels whatever runs, as before.
    const older = CancelParamsSchema.omit({ turnId: true });
    expect(older.safeParse({ sessionId: "s1", turnId: "t1" }).data).toEqual({ sessionId: "s1" });
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

  test("initialize: an unknown capability is stripped (a newer laptop's handshake still parses)", () => {
    // Was the regression for the rejected `chunkedModel` capability while
    // capabilities were strict; since v10 an unknown capability is stripped.
    expect(
      InitializeParamsSchema.safeParse({
        protocolVersion: 1,
        clientCapabilities: { streaming: true },
      }).success,
    ).toBe(true);
    const extra = InitializeParamsSchema.safeParse({
      protocolVersion: 1,
      clientCapabilities: { streaming: true, chunkedModel: true },
    });
    expect(extra.success && "chunkedModel" in extra.data.clientCapabilities).toBe(false);
    // And a new client's real payload (no chunkedModel) still parses.
    expect(
      InitializeParamsSchema.safeParse({ protocolVersion: 1, clientCapabilities: {} }).success,
    ).toBe(true);
  });
});
