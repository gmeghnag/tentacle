import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import * as P from "../src/index.ts";
import { buildProtocolJsonSchema } from "../src/json-schema.ts";

// Namespace access: on a tree without the queue every case fails on its
// assertion (an absent schema parses nothing), not on a missing import.
const parsed = (schema: z.ZodTypeAny | undefined, value: unknown): unknown => {
  const result = schema?.safeParse(value);
  return result?.success ? result.data : undefined;
};
const methods = P.Method as Record<string, string>;
const requests = P.RequestSchemas as Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;
const classes = P.UPDATE_CLASS as Record<string, string>;
const update = (u: unknown) => parsed(P.SessionUpdateSchema, u);

describe("the session's queue on the wire (docs/feat/queued-broadcast.md)", () => {
  test("QP1 queued is a DISPLAY update, declared by this build, never blocking", () => {
    expect(classes.queued).toBe("display");
    expect(P.KNOWN_UPDATE_TYPES as readonly string[]).toContain("queued");
    expect(P.BLOCKING_UPDATE_TYPES.has("queued" as never)).toBe(false);
    const member = (buildProtocolJsonSchema().$defs as Record<string, Record<string, unknown>>)
      .QueuedUpdate;
    expect(member?.["x-event-class"]).toBe("display");
  });

  test("QP2 queued parses with and without returned rows; ids are bounded; causes are known", () => {
    const full = {
      type: "queued",
      entries: [{ id: "a", text: "A" }],
      returned: [{ id: "b", text: "B", cause: "ended" }],
    };
    expect(update(full)).toEqual(full);
    expect(update({ type: "queued", entries: [], returned: [] })).toEqual({
      type: "queued",
      entries: [],
      returned: [],
    });
    expect(update({ ...full, entries: [{ id: "", text: "A" }] })).toBeUndefined();
    expect(update({ ...full, entries: [{ id: "x".repeat(129), text: "A" }] })).toBeUndefined();
    expect(update({ ...full, returned: [{ id: "b", text: "B", cause: "lost" }] })).toBeUndefined();
    // Full state: both lists are required (never a delta).
    expect(update({ type: "queued", entries: [] })).toBeUndefined();
  });

  test("QP3 the snapshot's first page may carry the queue", () => {
    const queued = { entries: [{ id: "a", text: "A" }], returned: [] };
    expect(parsed(P.SnapshotResultSchema, { messages: [], queued })).toEqual({
      messages: [],
      queued,
    });
  });

  test("QP4 session/reclaim is registered: at least one bounded id, an empty result", () => {
    expect(methods.Reclaim).toBe("session/reclaim");
    const schemas = requests["session/reclaim"];
    expect(parsed(schemas?.params, { sessionId: "s", ids: ["a"] })).toEqual({
      sessionId: "s",
      ids: ["a"],
    });
    expect(parsed(schemas?.params, { sessionId: "s", ids: [] })).toBeUndefined();
    expect(parsed(schemas?.params, { sessionId: "s", ids: [""] })).toBeUndefined();
    expect(parsed(schemas?.result, {})).toEqual({});
  });

  test("QP5 additive: no PROTOCOL_VERSION bump (11 when it landed)", () => {
    expect(P.PROTOCOL_VERSION).toBeGreaterThanOrEqual(11);
  });
});
