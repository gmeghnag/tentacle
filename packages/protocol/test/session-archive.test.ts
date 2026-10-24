import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import * as P from "../src/index.ts";

// Namespace access: on a tree without `session/delete` every case fails on its
// assertion (an absent schema parses nothing), not on a missing import.
const parses = (schema: z.ZodTypeAny | undefined, value: unknown): boolean | undefined =>
  schema?.safeParse(value).success;
const methods = P.Method as Record<string, string>;
const codes = P.DomainErrorCode as Record<string, number>;
const requests = P.RequestSchemas as Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;

describe("session archive (docs/feat/session-archive.md)", () => {
  test("P1 session/delete is registered: params { sessionId }, result {}", () => {
    expect(methods.SessionDelete).toBe("session/delete");
    const schemas = requests["session/delete"];
    expect(parses(schemas?.params, { sessionId: "s" })).toBe(true);
    expect(parses(schemas?.params, {})).toBe(false);
    expect(parses(schemas?.params, { sessionId: "" })).toBe(false);
    expect(parses(schemas?.result, {})).toBe(true);
  });

  test("P1 session_closed says why: closed or deleted", () => {
    const closed = (reason: string) =>
      parses(P.SessionUpdateSchema, { type: "session_closed", reason });
    expect(closed("closed")).toBe(true);
    expect(closed("deleted")).toBe(true);
    expect(closed("archived")).toBe(false);
  });

  test("P1 session/open takes an explicit reopen; an archived open has its own code", () => {
    expect(parses(P.OpenParamsSchema, { sessionId: "s", reopen: true })).toBe(true);
    expect(parses(P.OpenParamsSchema, { sessionId: "s", reopen: "yes" })).toBe(false);
    const shape = (P.OpenParamsSchema as unknown as z.AnyZodObject).shape as Record<
      string,
      unknown
    >;
    expect("reopen" in shape).toBe(true);
    expect(codes.SessionArchived).toBe(-32014);
  });

  test("F1 a deleted id has its own additive code (no version bump: an older client just fails the open)", () => {
    expect(codes.SessionDeleted).toBe(-32015);
    expect(new Set(Object.values(codes)).size).toBe(Object.values(codes).length);
  });

  test("P1 close / open change meaning: PROTOCOL_VERSION is 11", () => {
    expect(P.PROTOCOL_VERSION as number).toBe(11);
  });

  test("P1 initialize params stay readable by every daemon (version-mismatch-notice)", () => {
    // What a v10 daemon parses: every field optional or of an unchanged type.
    // A v11 client's frame with extras must still parse.
    expect(
      parses(P.InitializeParamsSchema, {
        protocolVersion: 11,
        clientCapabilities: {},
        clientInfo: { name: "tentacle", version: "0.2.0" },
      }),
    ).toBe(true);
  });
});
