/**
 * 6a-2 protocol half (docs/feat/subagent-background-ui.md, Design 1): the live
 * list of a session's background sub-agents rides its own `display` update and
 * the snapshot's first page. No version bump: an older client shows
 * `unsupported` once and carries on (nothing waits on it).
 */
import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  SessionUpdateSchema,
  SnapshotResultSchema,
  UPDATE_CLASS,
} from "../src/index.ts";

const row = {
  id: "sa-1",
  callId: "c1",
  agentType: "general",
  description: "map repo",
  state: "running",
  toolUses: 3,
  tokens: 1200,
  startedAt: 1_700_000_000_000,
  tail: ["read a.ts", "grep foo"],
};

describe("the subagents update (6a-2)", () => {
  test("the update is display-only (no bump of its own; 20 when it landed)", () => {
    expect(PROTOCOL_VERSION as number).toBeGreaterThanOrEqual(20);
    expect(UPDATE_CLASS.subagents).toBe("display");
  });

  test("a full-state frame parses, with an empty list too", () => {
    const parsed = SessionUpdateSchema.safeParse({ type: "subagents", agents: [row] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type === "subagents" && parsed.data.agents[0]).toEqual(row);
    }
    expect(SessionUpdateSchema.safeParse({ type: "subagents", agents: [] }).success).toBe(true);
  });

  test("a row is lenient by design: no length bound is checked here (the client bounds)", () => {
    // A pod's daemon is not trusted (§7): the schema must not fail a client's
    // stream over a long label — the client cuts rows and labels instead.
    const long = "x".repeat(100_000);
    const parsed = SessionUpdateSchema.safeParse({
      type: "subagents",
      agents: [{ ...row, description: long, state: long, tail: [long] }],
    });
    expect(parsed.success).toBe(true);
  });

  test("a row missing a numeric member is refused (a known type failing is a stream error)", () => {
    const { toolUses: _dropped, ...incomplete } = row;
    expect(SessionUpdateSchema.safeParse({ type: "subagents", agents: [incomplete] }).success).toBe(
      false,
    );
  });

  test("the snapshot carries the list on its first page, and it is optional", () => {
    const base = { messages: [] };
    expect(SnapshotResultSchema.safeParse(base).success).toBe(true);
    const parsed = SnapshotResultSchema.safeParse({ ...base, subagents: [row] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.subagents).toEqual([row]);
    }
  });

  test("`model` is an optional display field: a `models` NAME, absent when it is the main one", () => {
    // Absent = the same model as the main agent (the common case: nothing on the
    // wire). Present = the child's `models` name (docs/feat/subagent-panel.md).
    const withModel = SessionUpdateSchema.safeParse({
      type: "subagents",
      agents: [{ ...row, model: "qwen3-8" }],
    });
    expect(withModel.success).toBe(true);
    if (withModel.success && withModel.data.type === "subagents") {
      expect(withModel.data.agents[0]?.model).toBe("qwen3-8");
    }
    const without = SessionUpdateSchema.safeParse({ type: "subagents", agents: [row] });
    expect(without.success).toBe(true);
    if (without.success && without.data.type === "subagents") {
      expect(without.data.agents[0]).not.toHaveProperty("model");
    }
    // A whole update and the snapshot's page carry it the same way.
    expect(
      SnapshotResultSchema.safeParse({ messages: [], subagents: [{ ...row, model: "m2" }] })
        .success,
    ).toBe(true);
    // It is a `models` NAME: an id/URL with a slash is not one (the schema's rule).
    expect(
      SessionUpdateSchema.safeParse({
        type: "subagents",
        agents: [{ ...row, model: "rits/deepseek-ai/DeepSeek-V4.1" }],
      }).success,
    ).toBe(false);
  });

  test("an unknown member is dropped, not refused (strip schema)", () => {
    const parsed = SessionUpdateSchema.safeParse({
      type: "subagents",
      agents: [{ ...row, future: 1 }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "subagents") {
      expect(parsed.data.agents[0]).not.toHaveProperty("future");
    }
  });
});
