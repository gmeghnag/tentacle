import { describe, expect, test } from "bun:test";
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
import { createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

// docs/fix/detach-live.md R9, pinned by docs/fix/detach-live-followups.md round 3
// (finding 1 of the fresh review). `RemoteSession.onIdle` listeners run
// SYNCHRONOUSLY inside the update that ends the turn: `persistingController`'s
// listener starts the post-turn save there, so `saveConfirmed` can never read
// `true` for a turn the laptop has not saved. A listener deferred to a microtask
// leaves a window between "the turn ended" and "its save is pending".

class Says implements ModelProvider {
  readonly id = "says";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "hello" };
    yield { type: "done" };
  }
}

describe("RemoteSession.onIdle", () => {
  test("a listener has run by the time the turn_end update has been applied (not one microtask later)", async () => {
    // Mutation (remote-session.ts, the `streaming` setter): `listener()` →
    // `queueMicrotask(listener)` → `idleWhenEndApplied` is 0.
    const host = new SessionHost({
      defaultCwd: "/tmp/idle-sync",
      createAgent: () => {
        const permissions = new PermissionBroker();
        const agent = new Agent({
          model: new Says(),
          tools: new ToolRegistry(),
          env: {} as ExecutionEnvironment,
          requestPermission: (req, options) => permissions.request(req, options),
        });
        return { agent, permissions };
      },
    });
    const [daemonChannel, clientChannel] = createChannelPair();
    new Connection(daemonChannel, host);
    const client = new RemoteClient(clientChannel, new PermissionBroker());
    await client.initialize();
    const session = client.newSession(undefined, crypto.randomUUID());

    let idle = 0;
    session.onIdle(() => {
      idle += 1;
    });
    // The stream calls `listener.output(...)` per applied update: look at the
    // listener's count in the same tick the `turn_end` was applied.
    let idleWhenEndApplied = -1;
    const applied = session.output.bind(session);
    session.output = (out) => {
      applied(out);
      if (out.kind === "update" && out.update.type === "turn_end") {
        idleWhenEndApplied = idle;
      }
    };

    for await (const _event of session.send("hi")) {
      // drained
    }
    expect(idleWhenEndApplied).toBe(1);
    expect(idle).toBe(1);
  });
});
