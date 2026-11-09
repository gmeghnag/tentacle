import { expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

// docs/feat/clear-keeps-jobs.md, review H2 (the daemon-ordered half): `/clear`'s
// RPC answer comes BEFORE the client has read the barrier's snapshot. An own turn
// that starts in that window (a wake, a prompt) is after the barrier's seq: the
// client must hand it the snapshot IN-TURN (`history_reset`), not raise a
// separate `history{clear}` that the App would hold and replay after the turn,
// wiping the turn from the screen.
// Mutation: `compacted = replaced !== null` in `RemoteSession.onReset` (the
// pre-fix condition) → the snapshot becomes a late `history` activity.

const env = {} as ExecutionEnvironment;

class Slow implements ModelProvider {
  readonly id = "slow";
  async *stream(r: ChatRequest): AsyncIterable<StreamEvent> {
    const last = [...r.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    for (let i = 0; i < 12; i++) {
      await new Promise((res) => setTimeout(res, 5));
      yield { type: "text", delta: `${last.slice(0, 8)}${i} ` };
    }
    yield { type: "done" };
  }
}

test("an own turn that starts between the clear's answer and its snapshot takes the snapshot in-turn", async () => {
  const host = new SessionHost({
    defaultCwd: "/tmp/clear-race",
    createAgent: () => ({
      agent: new Agent({ model: new Slow(), tools: new ToolRegistry(), env }),
      permissions: new PermissionBroker(),
    }),
  });
  const [d, c] = createChannelPair();
  new Connection(d, host);
  // The client's snapshot READ is slow (the barrier's snapshot is a separate request).
  const slowed: DuplexChannel = {
    send: (data) => {
      const method = (JSON.parse(data) as { method?: string }).method;
      if (method === "session/snapshot") {
        setTimeout(() => c.send(data), 60);
      } else {
        c.send(data);
      }
    },
    close: () => c.close(),
    setOnMessage: (h) => c.setOnMessage(h),
    setOnClose: (h) => c.setOnClose(h),
  };
  const client = new RemoteClient(slowed, new PermissionBroker());
  await client.initialize();
  const session = client.newSession(undefined, "S");
  for await (const _ of session.send("warm")) {
    // drain
  }
  const activities: string[] = [];
  session.watch((a) => activities.push(a.kind === "history" ? `history(${a.reason})` : a.kind));

  await session.clear();
  const events: string[] = [];
  for await (const e of session.send("next")) {
    events.push(e.type === "history_reset" ? `history_reset(${e.messages.length})` : e.type);
  }
  await new Promise((r) => setTimeout(r, 150));

  // The snapshot went INTO the turn, and nothing replaces the screen afterwards.
  expect(events).toContain("history_reset(0)");
  expect(activities.filter((a) => a.startsWith("history"))).toEqual([]);
  expect(events.at(-1)).toBe("turn_end");
});
