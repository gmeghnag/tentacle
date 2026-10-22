import { describe, expect, test } from "bun:test";
import type { SessionUpdate, SessionUpdateParams } from "@tentacle/protocol";
import { classifyUpdate, stopReasonFromProtocol, updateToEvent } from "../src/mapping.ts";

describe("stopReasonFromProtocol", () => {
  test("keeps cancelled/max_iterations and collapses the rest to end_turn", () => {
    expect(stopReasonFromProtocol("cancelled")).toBe("cancelled");
    expect(stopReasonFromProtocol("max_iterations")).toBe("max_iterations");
    expect(stopReasonFromProtocol("end_turn")).toBe("end_turn");
    expect(stopReasonFromProtocol("error")).toBe("end_turn");
    expect(stopReasonFromProtocol("max_tokens")).toBe("end_turn");
  });
});

describe("updateToEvent", () => {
  const names = new Map<string, string>();

  test("agent_message_chunk → text", () => {
    expect(
      updateToEvent({ type: "agent_message_chunk", content: { type: "text", text: "hi" } }, names),
    ).toEqual({ type: "text", delta: "hi" });
  });

  test("tool_call records the name and reappears on the matching update", () => {
    const start = updateToEvent(
      {
        type: "tool_call",
        toolCallId: "c1",
        title: "shell",
        status: "in_progress",
        rawInput: { command: "ls" },
      },
      names,
    );
    expect(start).toEqual({
      type: "tool_start",
      id: "c1",
      name: "shell",
      arguments: '{"command":"ls"}',
    });
    const done = updateToEvent(
      {
        type: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "text", text: "ok" }],
      },
      names,
    );
    expect(done).toMatchObject({ type: "tool_result", id: "c1", name: "shell" });
    if (done?.type === "tool_result") {
      expect(done.result.content).toBe("ok");
      expect(done.result.isError).toBeUndefined();
    }
  });

  test("a diff resource is rebuilt with recomputed add/remove counts", () => {
    const update: SessionUpdate = {
      type: "tool_call_update",
      toolCallId: "c2",
      status: "completed",
      content: [
        { type: "text", text: "edited" },
        {
          type: "resource",
          uri: "diff://a.txt",
          mimeType: "text/x-diff",
          text: "@@ -1,2 +1,2 @@\n context\n-old\n+new\n",
        },
      ],
    };
    const event = updateToEvent(update, names);
    if (event?.type === "tool_result") {
      expect(event.result.details).toEqual({
        kind: "diff",
        path: "a.txt",
        patch: "@@ -1,2 +1,2 @@\n context\n-old\n+new\n",
        added: 1,
        removed: 1,
      });
    } else {
      throw new Error("expected a tool_result");
    }
  });

  test("a failed status surfaces isError", () => {
    const event = updateToEvent(
      {
        type: "tool_call_update",
        toolCallId: "c3",
        status: "failed",
        content: [{ type: "text", text: "boom" }],
      },
      names,
    );
    if (event?.type === "tool_result") {
      expect(event.result.isError).toBe(true);
    }
  });

  test("agent_usage → usage; plan is ignored", () => {
    expect(
      updateToEvent({ type: "agent_usage", promptTokens: 4, completionTokens: 1 }, names),
    ).toEqual({
      type: "usage",
      usage: { promptTokens: 4, completionTokens: 1 },
    });
    expect(updateToEvent({ type: "plan", entries: [] }, names)).toBeNull();
  });

  test("background_exit → background_exit event", () => {
    expect(
      updateToEvent(
        { type: "background_exit", jobId: "j1", command: "sleep 1", status: "exited", exitCode: 0 },
        names,
      ),
    ).toEqual({
      type: "background_exit",
      jobId: "j1",
      command: "sleep 1",
      status: "exited",
      exitCode: 0,
    });
  });
});

describe("classifyUpdate (event classes: unknown display is 'unsupported', fail loudly otherwise)", () => {
  const frame = (update: unknown, mandatory?: true): SessionUpdateParams =>
    ({
      sessionId: "s1",
      seq: 3,
      ...(mandatory ? { mandatory } : {}),
      update,
    }) as SessionUpdateParams;

  test("a valid known update is handled", () => {
    const update: SessionUpdate = { type: "steer", text: "x" };
    expect(classifyUpdate(frame(update))).toEqual({ kind: "update", update });
  });

  test("an unknown display update is 'unsupported' (never thrown, never silent)", () => {
    expect(classifyUpdate(frame({ type: "progress", pct: 3 }))).toEqual({
      kind: "unsupported",
      type: "progress",
    });
  });

  test("an unknown mandatory update is an error that says to update the client", () => {
    const r = classifyUpdate(frame({ type: "future_mandatory" }, true));
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error.message).toMatch(/future_mandatory.*newer/);
  });

  test("a known type that fails its member is an error, even without the mandatory flag", () => {
    const r = classifyUpdate(frame({ type: "agent_message_chunk" }));
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error.message).toMatch(/malformed agent_message_chunk/);
  });

  test("an Object.prototype key is unknown, not known ('unsupported', not 'malformed')", () => {
    expect(classifyUpdate(frame({ type: "toString" }))).toEqual({
      kind: "unsupported",
      type: "toString",
    });
  });
});

describe("hook resource blocks (H1)", () => {
  const result = (content: unknown[]) => {
    const event = updateToEvent(
      { type: "tool_call_update", toolCallId: "h1", status: "failed", content } as SessionUpdate,
      new Map([["h1", "shell"]]),
    );
    return event?.type === "tool_result" ? event.result : undefined;
  };

  test("a hook:// block becomes result.hook; the reason comes from its text", () => {
    expect(
      result([
        { type: "text", text: "Blocked by a hook: `shell` was not run. Reason: no rm" },
        {
          type: "resource",
          uri: "hook://blocked/no-rm",
          mimeType: "application/x-tentacle-hook",
          text: "no rm",
        },
      ])?.hook,
    ).toEqual({ action: "blocked", name: "no-rm", reason: "no rm" });
  });

  test("a name containing / is split on the first / only; no text → no reason", () => {
    expect(result([{ type: "resource", uri: "hook://modified/team/fmt" }])?.hook).toEqual({
      action: "modified",
      name: "team/fmt",
    });
  });

  test("content without a hook block (an older daemon) yields no hook", () => {
    expect(result([{ type: "text", text: "ok" }])).not.toHaveProperty("hook");
  });

  test("a malformed hook uri is ignored", () => {
    expect(result([{ type: "resource", uri: "hook://exploded/x" }])).not.toHaveProperty("hook");
  });
});
