/**
 * feat/subagent-panel (task 7) protocol half: the user writes to a background
 * child (`session/subagent_message`), stops one (`session/agent_kill`), and the
 * accepted text rides one `display` update so every attached TUI shows it.
 * No version bump: a new METHOD is free (an older peer answers `MethodNotFound`)
 * and a new `display` update is free (an older client shows `unsupported`).
 */
import { describe, expect, test } from "bun:test";
import {
  AgentKillParamsSchema,
  AgentKillResultSchema,
  Method,
  PROTOCOL_VERSION,
  RequestSchemas,
  SessionUpdateSchema,
  SubagentMessageParamsSchema,
  SubagentMessageResultSchema,
  UPDATE_CLASS,
} from "../src/index.ts";

describe("T-P1: the two new request methods", () => {
  test("session/subagent_message parses an accepted and a refused answer", () => {
    expect(
      SubagentMessageParamsSchema.safeParse({
        sessionId: "s1",
        agentId: "sa-1",
        text: "skip the tests folder",
      }).success,
    ).toBe(true);
    expect(SubagentMessageResultSchema.safeParse({ ok: true }).success).toBe(true);
    expect(
      SubagentMessageResultSchema.safeParse({ ok: false, reason: "sa-1 is not running" }).success,
    ).toBe(true);
  });

  test("text is bounded: empty and over 8000 characters are refused", () => {
    const base = { sessionId: "s1", agentId: "sa-1" };
    expect(SubagentMessageParamsSchema.safeParse({ ...base, text: "" }).success).toBe(false);
    expect(SubagentMessageParamsSchema.safeParse({ ...base, text: "x".repeat(8000) }).success).toBe(
      true,
    );
    expect(SubagentMessageParamsSchema.safeParse({ ...base, text: "x".repeat(8001) }).success).toBe(
      false,
    );
    // `agentId` is bounded too: a pod's daemon is not trusted (§7).
    expect(
      SubagentMessageParamsSchema.safeParse({ ...base, agentId: "x".repeat(65), text: "hi" })
        .success,
    ).toBe(false);
  });

  test("session/agent_kill takes a session and a child id, and answers `{killed}`", () => {
    expect(AgentKillParamsSchema.safeParse({ sessionId: "s1", agentId: "sa-1" }).success).toBe(
      true,
    );
    expect(AgentKillParamsSchema.safeParse({ sessionId: "s1" }).success).toBe(false);
    expect(AgentKillResultSchema.safeParse({ killed: true }).success).toBe(true);
    expect(AgentKillResultSchema.safeParse({ killed: false }).success).toBe(true);
    expect(AgentKillResultSchema.safeParse({ killed: "yes" }).success).toBe(false);
  });

  test("both are registered (a dispatcher validates before handling)", () => {
    expect(Method.SubagentMessage).toBe("session/subagent_message");
    expect(Method.AgentKill).toBe("session/agent_kill");
    expect(RequestSchemas[Method.SubagentMessage].params).toBe(SubagentMessageParamsSchema);
    expect(RequestSchemas[Method.AgentKill].result).toBe(AgentKillResultSchema);
  });

  test("no PROTOCOL_VERSION bump (a new method is free; an older daemon says MethodNotFound)", () => {
    // 24 is the sub-agent token-budget bump (docs/feat/subagent-token-budget.md),
    // not this method.
    expect(PROTOCOL_VERSION as number).toBe(24);
  });
});

describe("T-P2: the subagent_message update is display-only", () => {
  test("it parses and is in the union", () => {
    const parsed = SessionUpdateSchema.safeParse({
      type: "subagent_message",
      agentId: "sa-1",
      text: "skip the tests folder",
    });
    expect(parsed.success).toBe(true);
  });

  test("UPDATE_CLASS classifies it `display` (an older client shows it as unsupported once)", () => {
    expect(UPDATE_CLASS.subagent_message).toBe("display");
  });

  test("an unknown member is dropped, never refused (strip schema)", () => {
    const parsed = SessionUpdateSchema.safeParse({
      type: "subagent_message",
      agentId: "sa-1",
      text: "hi",
      future: 1,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("future");
    }
  });
});
