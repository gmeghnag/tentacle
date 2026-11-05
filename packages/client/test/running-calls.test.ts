/**
 * `RemoteSession.runningCalls` (T-L2, docs/feat/parallel-tools.md): a call's
 * `running` signal is recorded AT RECEIPT, in `output`, before any consumer
 * pulls an event — the laptop's cut labels read it right after a read-back.
 */
import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@tentacle/protocol";
import type { RemoteClient } from "../src/remote-client.ts";
import { RemoteSession } from "../src/remote-session.ts";

const update = (u: SessionUpdate, turn: string | null = "T1") =>
  ({ kind: "update", seq: 1, update: u, turn }) as const;

describe("RemoteSession.runningCalls (T-L2)", () => {
  test("recorded at receipt with NO consumer: only `running`, never `queued` or tool_call", () => {
    const session = new RemoteSession({} as RemoteClient);
    session.output(update({ type: "turn_start", turnId: "T1", prompt: "" }, null));
    session.output(
      update({ type: "tool_call", toolCallId: "c1", title: "read", status: "pending" }),
    );
    session.output(update({ type: "tool_call_phase", toolCallId: "c1", phase: "queued" }));
    session.output(update({ type: "tool_call_phase", toolCallId: "c2", phase: "queued" }));
    expect([...session.runningCalls()]).toEqual([]);
    session.output(update({ type: "tool_call_phase", toolCallId: "c1", phase: "running" }));
    expect([...session.runningCalls()]).toEqual(["c1"]);
  });

  test("cleared at the next turn_start (ids repeat across turns); an unknown phase records nothing", () => {
    const session = new RemoteSession({} as RemoteClient);
    session.output(update({ type: "tool_call_phase", toolCallId: "c1", phase: "running" }));
    session.output(update({ type: "tool_call_phase", toolCallId: "c2", phase: "later" }));
    expect([...session.runningCalls()]).toEqual(["c1"]);
    session.output(update({ type: "turn_start", turnId: "T2", prompt: "" }, null));
    expect([...session.runningCalls()]).toEqual([]);
  });
});
