import { describe, expect, test } from "bun:test";
import { MAX_MCP_TOOL_NAMES, McpServerStatusSchema, PROTOCOL_VERSION } from "../src/index.ts";

const ok = { name: "github", state: "connected", tools: ["a", "b"], moreTools: 0, latencyMs: 4 };

describe("McpServerStatusSchema (docs/feat/mcp-tools-panel.md)", () => {
  test("the version is bumped for the breaking change (a count became names)", () => {
    expect(PROTOCOL_VERSION).toBe(8);
  });

  test("accepts a server with its tool names", () => {
    expect(McpServerStatusSchema.safeParse(ok).success).toBe(true);
  });

  test("the old count-only shape is rejected (one shape, no compat)", () => {
    expect(McpServerStatusSchema.safeParse({ ...ok, tools: 2 }).success).toBe(false);
    const { moreTools: _omit, ...noMore } = ok;
    expect(McpServerStatusSchema.safeParse(noMore).success).toBe(false);
  });

  test("rejects a control character, an empty or an overlong name", () => {
    for (const bad of ["x\u001b[2J", "", "n".repeat(129)]) {
      expect(McpServerStatusSchema.safeParse({ ...ok, tools: [bad, "b"] }).success).toBe(false);
    }
  });

  test(`rejects more than ${MAX_MCP_TOOL_NAMES} names; the rest ride in moreTools`, () => {
    const names = Array.from({ length: MAX_MCP_TOOL_NAMES + 1 }, (_, i) => `t${i}`);
    const at = names.slice(0, MAX_MCP_TOOL_NAMES);
    expect(McpServerStatusSchema.safeParse({ ...ok, tools: at, moreTools: 900 }).success).toBe(
      true,
    );
    expect(McpServerStatusSchema.safeParse({ ...ok, tools: names }).success).toBe(false);
    expect(McpServerStatusSchema.safeParse({ ...ok, moreTools: -1 }).success).toBe(false);
  });
});
