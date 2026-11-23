import { describe, expect, test } from "bun:test";
import type { SessionUpdateParams } from "@tentacle/protocol";
import { classifyUpdate, updateToEvent } from "../src/mapping.ts";

// docs/feat/agent-workflows.md Slice 3 (D5): the `workflows` display update is
// KNOWN to this client (never `unsupported`), validated (a malformed one is an
// error, not a silent drop), and session-level (no turn `AgentEvent`; its own
// listeners consume it, like `subagents`).

const row = {
  runId: "wf-1",
  name: "task",
  version: 3,
  hash: "3f2a".repeat(16),
  state: "running",
  tokens: 1200,
  budget: 3_000_000,
  startedAt: 1,
  steps: [
    { id: "plan", kind: "agent", model: "opus", where: "local", state: "ok", attempt: 0, round: 0 },
    {
      id: "review",
      kind: "agent",
      where: "local",
      state: "running",
      attempt: 0,
      round: 2,
      maxRound: 3,
      live: "fs_read src/a.ts",
    },
  ],
};
const params = (update: unknown): SessionUpdateParams =>
  ({ sessionId: "s", update }) as unknown as SessionUpdateParams;

describe("workflows update on the client", () => {
  test("a valid one is a known update and maps to no turn event", () => {
    const classified = classifyUpdate(params({ type: "workflows", runs: [row] }));
    expect(classified.kind).toBe("update");
    if (classified.kind !== "update") return;
    expect(classified.update).toEqual({ type: "workflows", runs: [row] });
    expect(updateToEvent(classified.update, new Map())).toBeNull();
  });

  test("a malformed one is an error, never `unsupported` (the type is known)", () => {
    const bad = classifyUpdate(params({ type: "workflows", runs: [{ ...row, hash: "short" }] }));
    expect(bad.kind).toBe("error");
    const control = classifyUpdate(
      params({ type: "workflows", runs: [{ ...row, name: "evil\u001b[2J" }] }),
    );
    expect(control.kind).toBe("error");
  });
});
