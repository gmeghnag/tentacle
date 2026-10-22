import { describe, expect, test } from "bun:test";
import {
  BLOCKING_UPDATE_TYPES,
  HooksTrustParamsSchema,
  InitializeParamsSchema,
  KNOWN_UPDATE_TYPES,
  OpenParamsSchema,
  PROTOCOL_VERSION,
  PromptParamsSchema,
  SessionUpdateParamsSchema,
  clientSupportsUpdate,
} from "../src/index.ts";

describe("forward compatibility (docs/feat/protocol-v10-forward-compat.md)", () => {
  test("an unknown field is STRIPPED on inbound parse (request params, update frames, nested items)", () => {
    const open = OpenParamsSchema.safeParse({ create: true, futureField: 1 });
    expect(open.success && "futureField" in open.data).toBe(false);
    expect(open.success).toBe(true);
    const prompt = PromptParamsSchema.safeParse({
      sessionId: "s1",
      turnId: "t1",
      content: [{ type: "text", text: "hi", future: true }],
      future: { x: 1 },
    });
    expect(prompt.success).toBe(true);
    expect(prompt.success && prompt.data).toEqual({
      sessionId: "s1",
      turnId: "t1",
      content: [{ type: "text", text: "hi" }],
    });
    const frame = SessionUpdateParamsSchema.safeParse({
      sessionId: "s1",
      seq: 1,
      future: 1,
      update: { type: "agent_message_chunk", content: { type: "text", text: "x" }, future: 2 },
    });
    expect(frame.success && frame.data).toEqual({
      sessionId: "s1",
      seq: 1,
      update: { type: "agent_message_chunk", content: { type: "text", text: "x" } },
    });
    const trust = HooksTrustParamsSchema.safeParse({
      sessionId: "s1",
      folder: "/repo",
      hash: "h",
      files: [],
      hooks: [{ event: "turn_start", command: "./a.sh", future: "x" }],
      canAllow: false,
      future: true,
    });
    expect(trust.success && trust.data.hooks[0]).toEqual({
      event: "turn_start",
      command: "./a.sh",
    });
    expect(trust.success && "future" in trust.data).toBe(false);
  });

  test("a bad KNOWN field is still rejected", () => {
    expect(OpenParamsSchema.safeParse({ create: "yes" }).success).toBe(false);
    expect(
      PromptParamsSchema.safeParse({
        sessionId: "",
        turnId: "t1",
        content: [{ type: "text", text: "x" }],
      }).success,
    ).toBe(false);
  });

  test("initialize declares the update kinds the client understands (round-trip, bounded)", () => {
    const params = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true, updates: [...KNOWN_UPDATE_TYPES] },
    };
    const parsed = InitializeParamsSchema.safeParse(params);
    expect(parsed.success && parsed.data.clientCapabilities.updates).toEqual([
      ...KNOWN_UPDATE_TYPES,
    ]);
    const bad = { ...params, clientCapabilities: { updates: ["turn_end\u001b[2J"] } };
    expect(InitializeParamsSchema.safeParse(bad).success).toBe(false);
  });

  test("the blocking set lives in ONE place: permission_request is its only member", () => {
    expect([...BLOCKING_UPDATE_TYPES]).toEqual(["permission_request"]);
  });

  test("clientSupportsUpdate: a declared list decides; no list = the v10 base set", () => {
    expect(clientSupportsUpdate(["turn_end"], "permission_request")).toBe(false);
    expect(clientSupportsUpdate(["permission_request"], "permission_request")).toBe(true);
    expect(clientSupportsUpdate(undefined, "permission_request")).toBe(true);
    expect(clientSupportsUpdate(undefined, "some_future_kind")).toBe(false);
  });
});
