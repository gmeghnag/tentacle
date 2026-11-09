import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  PermissionRequestUpdateSchema,
  SessionUpdateSchema,
} from "../src/index.ts";

const request = {
  type: "permission_request",
  requestId: "r1",
  toolCallId: "t1",
  tool: "shell",
  title: "Run",
  options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
};

describe("6a-1 protocol (docs/feat/subagent-background.md)", () => {
  test("the protocol version is at least 20", () => {
    expect(PROTOCOL_VERSION as number).toBeGreaterThanOrEqual(20);
  });

  test("background_exit parses with and without the sub-agent member", () => {
    const base = {
      type: "background_exit",
      jobId: "sa-1",
      command: "map",
      status: "exited",
      exitCode: null,
    };
    expect(SessionUpdateSchema.safeParse(base).success).toBe(true);
    const withAgent = SessionUpdateSchema.safeParse({
      ...base,
      agent: { stopReason: "end_turn", toolUses: 3 },
    });
    expect(withAgent.success).toBe(true);
    if (withAgent.success && withAgent.data.type === "background_exit") {
      expect(withAgent.data.agent).toEqual({ stopReason: "end_turn", toolUses: 3 });
    }
    expect(
      SessionUpdateSchema.safeParse({ ...base, agent: { stopReason: "x", toolUses: -1 } }).success,
    ).toBe(false);
  });

  test("permission_request carries agent.id and a spawning turnId; neither is bounded", () => {
    const long = "t".repeat(100_000);
    const parsed = PermissionRequestUpdateSchema.safeParse({
      ...request,
      agent: { type: "general", description: "d", id: long },
      turnId: long,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.turnId).toBe(long);
      expect(parsed.data.agent?.id).toBe(long);
    }
    // Both stay optional: an agent without `id` still parses.
    expect(
      PermissionRequestUpdateSchema.safeParse({
        ...request,
        agent: { type: "g", description: "d" },
      }).success,
    ).toBe(true);
  });
});
