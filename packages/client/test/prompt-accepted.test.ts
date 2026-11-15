import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { JsonRpcErrorCode, Method, Notification, PROTOCOL_VERSION } from "@tentacle/protocol";
import { DomainErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";

// `RemoteSession.send(…, { onAccepted })`: the daemon's ack of `session/prompt`
// (docs/fix/mobile-chat-glitches.md, bug 2) — the moment it holds the turn's key.

/** A raw daemon whose `prompt` answer is whatever `onPrompt` returns (a held promise, a throw). */
function rawDaemon(onPrompt: (turnId: string) => Promise<unknown>) {
  const [daemonCh, clientCh] = createChannelPair();
  let seq = 0;
  let turnId = "";
  const notify = (update: unknown): void =>
    daemon.notify(Notification.SessionUpdate, {
      sessionId: "s1",
      seq: ++seq,
      mandatory: true,
      update,
    });
  const daemon: RpcPeer = new RpcPeer(daemonCh, {
    onRequest: async (method, params) => {
      if (method === Method.Initialize) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      }
      if (method === Method.Open) {
        return { sessionId: "s1", epoch: "e", created: true, resync: false };
      }
      if (method === Method.Prompt) {
        turnId = (params as { turnId: string }).turnId;
        return onPrompt(turnId);
      }
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, `unknown method: ${method}`);
    },
  });
  return { clientCh, notify, turnId: () => turnId };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

/** Drain `iter` into `into`; resolves "ended", the error it threw, or "hung". */
function drain(iter: AsyncIterable<SessionEvent>, into: SessionEvent[]): Promise<unknown> {
  return Promise.race([
    (async () => {
      for await (const e of iter) into.push(e);
      return "ended";
    })().catch((e: unknown) => e),
    new Promise((r) => setTimeout(() => r("hung"), 2000)),
  ]);
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("RemoteSession.send onAccepted — the daemon's ack, exposed", () => {
  test("not called before the prompt's answer; once after it, before any turn event", async () => {
    const ack = deferred<unknown>();
    const d = rawDaemon(() => ack.promise);
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    let accepted = 0;
    const events: SessionEvent[] = [];
    const done = drain(
      session.send("hi", undefined, {
        onAccepted: () => {
          accepted += 1;
        },
      }),
      events,
    );
    expect(await waitFor(() => d.turnId() !== "")).toBe(true);
    await tick();
    expect(accepted).toBe(0);

    ack.resolve({ turnId: d.turnId() });
    expect(await waitFor(() => accepted === 1)).toBe(true);
    expect(events).toEqual([]);

    d.notify({ type: "agent_message_chunk", content: { type: "text", text: "ok" } });
    d.notify({ type: "turn_end", turnId: d.turnId(), stopReason: "end_turn" });
    expect(await done).toBe("ended");
    expect(accepted).toBe(1);
    client.close();
  });

  test("never called when the daemon refuses the prompt", async () => {
    const d = rawDaemon(() =>
      Promise.reject(new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running")),
    );
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    let accepted = 0;
    const events: SessionEvent[] = [];
    const outcome = await drain(
      session.send("hi", undefined, {
        onAccepted: () => {
          accepted += 1;
        },
      }),
      events,
    );
    expect(outcome).toBeInstanceOf(RpcError);
    expect(accepted).toBe(0);
    client.close();
  });

  test("called for an `ended` retry ack (the daemon already ran that key)", async () => {
    const d = rawDaemon((turnId) => Promise.resolve({ turnId, ended: { stopReason: "end_turn" } }));
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    let accepted = 0;
    const events: SessionEvent[] = [];
    const outcome = await drain(
      session.send("hi", undefined, {
        onAccepted: () => {
          accepted += 1;
        },
      }),
      events,
    );
    expect(outcome).toBe("ended");
    expect(accepted).toBe(1);
    client.close();
  });
});
