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
import type { SessionActivity } from "../src/remote-session.ts";

// docs/fix/clear-silent-noop.md — the OTHER shape of the same silence: a session
// built to ATTACH (`connect`, `attach`, docs/feat/detached-handover.md) whose
// eager dial has not answered yet has no id either. `/clear` typed in that
// window must wait for the attach and clear THAT session, never answer a hollow
// `{0, 0}` and leave the chat alone. Mutation: `openForClear` without the
// `attach` branch → `{0, 0}` and no activity.

const env = {} as ExecutionEnvironment;

class Quiet implements ModelProvider {
  readonly id = "q";
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "reply" };
    yield { type: "done" };
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("/clear waits for a still-in-flight attach and clears THAT session", async () => {
  const host = new SessionHost({
    defaultCwd: "/tmp/clear-attach",
    createAgent: () => ({
      agent: new Agent({ model: new Quiet(), tools: new ToolRegistry(), env, systemPrompt: "sys" }),
      permissions: new PermissionBroker(),
    }),
  });
  const dial = async (slowOpen: boolean) => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    // The attach's own request is delayed: `/clear` lands while the dial is out.
    const slowed: DuplexChannel = slowOpen
      ? {
          send: (data) => {
            if ((JSON.parse(data) as { method?: string }).method === "session/open") {
              setTimeout(() => c.send(data), 80);
            } else {
              c.send(data);
            }
          },
          close: () => c.close(),
          setOnMessage: (h) => c.setOnMessage(h),
          setOnClose: (h) => c.setOnClose(h),
        }
      : c;
    const client = new RemoteClient(slowed, new PermissionBroker());
    await client.initialize();
    return client;
  };

  // Another device opens the session and puts a chat in it.
  const writer = await dial(false);
  const sid = crypto.randomUUID();
  const w = writer.newSession(undefined, sid);
  for await (const _ of w.send("the OLD chat")) {
    // drain
  }

  const reader = await dial(true);
  const viewer = reader.newSession(undefined, sid, undefined, { attach: {} });
  const seen: SessionActivity[] = [];
  viewer.watch((a) => seen.push(a));
  void viewer.open(); // the eager attach goes out and is held 80 ms

  const result = await viewer.clear();
  expect(result).toEqual({ before: 3, after: 1 });
  await delay(60);
  expect(seen.map((a) => (a.kind === "history" ? a.reason : a.kind))).toContain("clear");

  // The chat really went: the writer's next read is the reset one.
  const back = await w.readBack();
  expect(back?.messages.some((m) => m.content === "the OLD chat")).toBe(false);
  reader.close();
  writer.close();
});
