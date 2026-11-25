/** `harnesses` (docs/feat/subagent-harness-runners.md D3/D6): defaults, refusals. */
import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

const resolve = (fileConfig: object) =>
  resolveConfig({ fileConfig: FileConfigSchema.parse(fileConfig), env: {}, defaultCwd: "/w" });

describe("harnesses", () => {
  test("claude-code is there by default: on, `claude`, `opus`, 15 min, not configured", () => {
    expect(resolve({}).harnesses).toEqual({
      "claude-code": {
        adapter: "claude-code",
        enabled: true,
        command: "claude",
        model: "opus",
        idleMinutes: 15,
        configured: false,
      },
    });
  });

  test("a written entry overrides field by field and is marked configured", () => {
    expect(
      resolve({ harnesses: { "claude-code": { enabled: false, model: "sonnet" } } }).harnesses[
        "claude-code"
      ],
    ).toEqual({
      adapter: "claude-code",
      enabled: false,
      command: "claude",
      model: "sonnet",
      idleMinutes: 15,
      configured: true,
    });
  });

  test("an unknown instance, a flag-shaped model and an unknown field are refused", () => {
    for (const bad of [
      { harnesses: { codex: {} } },
      { harnesses: { "claude-code": { model: "--yolo" } } },
      { harnesses: { "claude-code": { maxBudgetUsd: 1 } } },
    ]) {
      expect(FileConfigSchema.safeParse(bad).success).toBe(false);
    }
  });
});
