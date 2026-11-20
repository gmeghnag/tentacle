import { describe, expect, test } from "bun:test";
import {
  MAX_TOOL_LIST,
  Method,
  RequestSchemas,
  SessionCapabilitiesSchema,
  SessionToolsParamsSchema,
  SessionToolsResultSchema,
  SetCapabilityParamsSchema,
} from "../src/index.ts";

// docs/feat/tool-toggles.md D6: the wire is additive.

describe("tool switches on the wire", () => {
  test("an old-shape SessionCapabilities (no disabledTools) still parses; absent stays absent", () => {
    const parsed = SessionCapabilitiesSchema.parse({ disabledMcp: [], disabledSkills: ["k"] });
    expect(parsed.disabledTools).toBeUndefined();
    expect(
      SessionCapabilitiesSchema.parse({
        disabledMcp: [],
        disabledSkills: [],
        disabledTools: ["chart"],
      }).disabledTools,
    ).toEqual(["chart"]);
  });

  test("disabledTools is bounded like the other two sets", () => {
    const flood = Array.from({ length: 257 }, (_, i) => `t${i}`);
    expect(
      SessionCapabilitiesSchema.safeParse({
        disabledMcp: [],
        disabledSkills: [],
        disabledTools: flood,
      }).success,
    ).toBe(false);
  });

  test("set_capability takes kind tool (a tool or a group name)", () => {
    expect(
      SetCapabilityParamsSchema.parse({
        sessionId: "S",
        kind: "tool",
        name: "visuals",
        enabled: false,
      }).kind,
    ).toBe("tool");
    expect(
      SetCapabilityParamsSchema.safeParse({
        sessionId: "S",
        kind: "nope",
        name: "x",
        enabled: false,
      }).success,
    ).toBe(false);
  });
});

describe("session/tools", () => {
  test("is registered with its schemas", () => {
    expect(Method.SessionTools).toBe("session/tools");
    expect(RequestSchemas[Method.SessionTools].params).toBe(SessionToolsParamsSchema);
    expect(RequestSchemas[Method.SessionTools].result).toBe(SessionToolsResultSchema);
  });

  test("params: a session, or none (with settings)", () => {
    expect(SessionToolsParamsSchema.parse({}).sessionId).toBeUndefined();
    expect(SessionToolsParamsSchema.parse({ sessionId: "S" }).sessionId).toBe("S");
  });

  test("result bounds: names line-bounded and control-free, tokens a non-negative int, at most MAX_TOOL_LIST", () => {
    const ok = { name: "chart", group: "visuals", tokens: 1299, disabled: true };
    expect(
      SessionToolsResultSchema.safeParse({
        tools: [ok, { name: "skill", tokens: 3, locked: true }],
      }).success,
    ).toBe(true);
    expect(SessionToolsResultSchema.safeParse({ tools: [{ ...ok, tokens: -1 }] }).success).toBe(
      false,
    );
    expect(SessionToolsResultSchema.safeParse({ tools: [{ ...ok, tokens: 1.5 }] }).success).toBe(
      false,
    );
    expect(
      SessionToolsResultSchema.safeParse({ tools: [{ ...ok, name: "x".repeat(129) }] }).success,
    ).toBe(false);
    expect(
      SessionToolsResultSchema.safeParse({ tools: [{ ...ok, disabled: false }] }).success,
    ).toBe(false);
    const many = Array.from({ length: MAX_TOOL_LIST + 1 }, (_, i) => ({
      name: `t${i}`,
      tokens: 1,
    }));
    expect(SessionToolsResultSchema.safeParse({ tools: many }).success).toBe(false);
    // Control characters never reach the UI.
    const parsed = SessionToolsResultSchema.safeParse({
      tools: [{ name: "a\u001b[2Jb", tokens: 1 }],
    });
    expect(parsed.success ? parsed.data.tools[0]?.name : "refused").not.toContain("\u001b");
  });
});
