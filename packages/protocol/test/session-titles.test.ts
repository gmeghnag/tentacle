import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import * as P from "../src/index.ts";
import { buildProtocolJsonSchema } from "../src/json-schema.ts";

// Namespace access: on a tree without titles every case fails on its
// assertion (an absent schema parses nothing), not on a missing import.
const parsed = (schema: z.ZodTypeAny | undefined, value: unknown): unknown => {
  const result = schema?.safeParse(value);
  return result?.success ? result.data : undefined;
};
const methods = P.Method as Record<string, string>;
const requests = P.RequestSchemas as Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;
const classes = P.UPDATE_CLASS as Record<string, string>;

describe("session titles (docs/feat/session-titles.md)", () => {
  test("P1 session_title is a DISPLAY update: an older client skips it, never fails its turn", () => {
    expect(classes.session_title).toBe("display");
    expect(P.KNOWN_UPDATE_TYPES as readonly string[]).toContain("session_title");
    expect(P.BLOCKING_UPDATE_TYPES.has("session_title" as never)).toBe(false);
  });

  test("P1 the schema export annotates session_title with x-event-class: display", () => {
    const doc = JSON.stringify(buildProtocolJsonSchema());
    const at = doc.indexOf('"const":"session_title"');
    expect(at).toBeGreaterThan(-1);
    const member = (buildProtocolJsonSchema().$defs as Record<string, Record<string, unknown>>)
      .SessionTitleUpdate;
    expect(member?.["x-event-class"]).toBe("display");
  });

  test("P1 session_title: one bounded control-free line, source model|user", () => {
    const update = (u: unknown) => parsed(P.SessionUpdateSchema, u);
    expect(update({ type: "session_title", title: "Fix login", source: "model" })).toEqual({
      type: "session_title",
      title: "Fix login",
      source: "model",
    });
    expect(update({ type: "session_title", title: "x", source: "auto" })).toBeUndefined();
    expect(update({ type: "session_title", title: "", source: "user" })).toBeUndefined();
    expect(update({ type: "session_title", title: "a\u001bb", source: "user" })).toBeUndefined();
    expect(
      update({ type: "session_title", title: "x".repeat(257), source: "user" }),
    ).toBeUndefined();
  });

  test("P1 session/rename is registered: raw bounded text in, the stored title out", () => {
    expect(methods.Rename).toBe("session/rename");
    const schemas = requests["session/rename"];
    expect(parsed(schemas?.params, { sessionId: "s", title: "  any\ttext " })).toEqual({
      sessionId: "s",
      title: "  any\ttext ",
    });
    expect(parsed(schemas?.params, { sessionId: "s", title: "" })).toBeUndefined();
    expect(parsed(schemas?.params, { sessionId: "s", title: "x".repeat(1025) })).toBeUndefined();
    expect(parsed(schemas?.result, { title: { text: "Fix login", source: "user" } })).toEqual({
      title: { text: "Fix login", source: "user" },
    });
  });

  test("P1 the snapshot's first page and the open seed carry a title", () => {
    expect(
      parsed(P.SnapshotResultSchema, { messages: [], title: { text: "go", source: "auto" } }),
    ).toEqual({ messages: [], title: { text: "go", source: "auto" } });
    expect(
      parsed(P.SnapshotResultSchema, { messages: [], title: { text: "a\nb", source: "auto" } }),
    ).toBeUndefined();
    expect(
      parsed(P.OpenParamsSchema, { sessionId: "s", title: { text: "Mine", source: "user" } }),
    ).toEqual({ sessionId: "s", title: { text: "Mine", source: "user" } });
    // A seed is a CHOSEN title: `auto` is derived by the daemon, never sent.
    expect(
      parsed(P.OpenParamsSchema, { sessionId: "s", title: { text: "x", source: "auto" } }),
    ).toBeUndefined();
  });

  test("P1 additive: no PROTOCOL_VERSION bump (still 11)", () => {
    expect(P.PROTOCOL_VERSION).toBe(11);
  });

  // Follow-up 1: the pod's title call is MARKED on the model tunnel, so the
  // laptop picks `model.titleModel` for it. The pod never names a model.
  test("P2 model/stream + model/streamChunked: an optional purpose 'title', nothing else", () => {
    const request = { messages: [{ role: "user", content: "q" }] };
    for (const name of [P.Method.ModelStream, P.Method.ModelStreamChunked]) {
      const params = requests[name]?.params;
      expect(parsed(params, { request, purpose: "title" })).toEqual({ request, purpose: "title" });
      // Absent → a normal turn (every existing caller).
      expect(parsed(params, { request })).toEqual({ request });
      // An unknown purpose is refused at parse (loud), never served as a turn.
      expect(parsed(params, { request, purpose: "summary" })).toBeUndefined();
      // No model id rides the request: an unknown `model` field is stripped.
      expect(parsed(params, { request, model: "x" })).toEqual({ request });
    }
  });

  test("P2 the JSON Schema export carries the purpose on both requests", () => {
    const defs = buildProtocolJsonSchema().$defs as Record<string, unknown>;
    for (const key of ["ModelStreamParams", "ModelStreamChunkedParams"]) {
      expect(JSON.stringify(defs[key])).toContain('"purpose"');
    }
  });
});
