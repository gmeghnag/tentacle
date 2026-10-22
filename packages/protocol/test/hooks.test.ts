import { describe, expect, test } from "bun:test";
import { HooksTrustParamsSchema, PROTOCOL_VERSION } from "../src/index.ts";

const base = {
  sessionId: "s1",
  folder: "/repo",
  hash: "h1",
  files: [".agents/hooks.json"],
  hooks: [{ event: "tool_call", matcher: "shell", command: "./judge.sh" }],
  canAllow: false,
};
const withHook = (extra: Record<string, unknown>) => ({
  ...base,
  hooks: [{ ...base.hooks[0], ...extra }],
});

describe("hooks/trust hook item `model` (docs/feat/protocol-v10-forward-compat.md)", () => {
  test("a valid model name is accepted; absent stays valid", () => {
    expect(HooksTrustParamsSchema.safeParse(withHook({ model: "judge" })).success).toBe(true);
    expect(HooksTrustParamsSchema.safeParse(base).success).toBe(true);
  });

  test("an oversize, empty, control or bidi model is rejected", () => {
    for (const model of ["x".repeat(65), "", "judge\u001b[2J", "judge‮", 7]) {
      expect(HooksTrustParamsSchema.safeParse(withHook({ model })).success).toBe(false);
    }
    expect(HooksTrustParamsSchema.safeParse(withHook({ model: "x".repeat(64) })).success).toBe(
      true,
    );
  });

  test("an unknown key in the item is stripped, never used (v10 forward compat)", () => {
    const parsed = HooksTrustParamsSchema.safeParse(withHook({ other: "x" }));
    expect(parsed.success ? parsed.data.hooks : null).toEqual(base.hooks);
  });

  test("the breaking item change bumps the version to 10", () => {
    expect(PROTOCOL_VERSION).toBe(10);
  });
});
