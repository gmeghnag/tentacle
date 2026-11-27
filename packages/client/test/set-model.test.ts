/**
 * `/model` on the client (docs/feat/model-switch.md T4): only a trusted daemon
 * is ever asked (`daemonWakes`: the worker, `connect` — a pod session sends
 * NOTHING), a switch before the first message opens the session first, and an
 * older daemon's `MethodNotFound` says to update it.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { DomainErrorCode, JsonRpcErrorCode, Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

const CATALOGUE = {
  start: { model: "start-id", contextWindow: 1000 },
  entries: [{ name: "haiku", model: "haiku-id", contextWindow: 200 }],
  active: null,
};
const SWITCHED = { active: "haiku", model: "haiku-id", contextWindow: 200 };

/** A fake daemon: the handshake, `session/open`, and `handlers`; the rest is unknown. */
function fakeDaemon(handlers: Record<string, () => unknown>) {
  const [daemonCh, clientCh] = createChannelPair();
  const sent: { method: string; params: unknown }[] = [];
  new RpcPeer(daemonCh, {
    onRequest: async (method: string, params: unknown) => {
      if (method === Method.Initialize) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      }
      sent.push({ method, params });
      if (method === Method.Open) {
        const { sessionId } = params as { sessionId?: string };
        return { sessionId: sessionId ?? "s1", epoch: "e", created: true, resync: false };
      }
      const handler = handlers[method];
      if (handler) {
        return handler();
      }
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
    },
  });
  return { sent, clientCh };
}

const HANDLERS = {
  [Method.Models]: () => CATALOGUE,
  [Method.SetModel]: () => SWITCHED,
};

async function connect(handlers: Record<string, () => unknown> = HANDLERS, daemonWakes = true) {
  const daemon = fakeDaemon(handlers);
  const client = new RemoteClient(daemon.clientCh, new PermissionBroker(), undefined, {
    channelFactory: async () => {
      throw new Error("unused");
    },
    random: () => 0,
    ...(daemonWakes ? { daemonWakes: true } : {}),
  });
  await client.initialize();
  return { ...daemon, client };
}

const methods = (sent: readonly { method: string }[]) => sent.map((s) => s.method);

const message = async (request: Promise<unknown>): Promise<string> => {
  try {
    await request;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a rejection");
};

describe("a daemon the client does not trust (a pod)", () => {
  test("rejects locally and sends nothing, not even an open", async () => {
    const { client, sent } = await connect(HANDLERS, false);
    const session = client.newSession();
    for (const request of [() => session.setModel("haiku"), () => session.models()]) {
      expect(await message(request())).toBe(
        "model switching is not available in a container session",
      );
    }
    expect(methods(sent)).toEqual([]);
  });
});

describe("before the first message", () => {
  test("the list is a sessionless call: nothing is opened", async () => {
    const { client, sent } = await connect();
    expect(await client.newSession().models()).toEqual(CATALOGUE);
    expect(sent).toEqual([{ method: Method.Models, params: {} }]);
  });

  test("a switch opens the session first, then selects on it", async () => {
    const { client, sent } = await connect();
    const session = client.newSession();
    expect(await session.setModel("haiku")).toEqual(SWITCHED);
    expect(methods(sent)).toEqual([Method.Open, Method.SetModel]);
    const id = session.sessionId;
    expect(id).not.toBeNull();
    expect(sent[1]?.params).toEqual({ sessionId: id, name: "haiku" });
  });
});

describe("an open session", () => {
  test("lists with its id, and null goes on the wire as the start model", async () => {
    const { client, sent } = await connect();
    const session = client.newSession();
    await session.setModel("haiku");
    await session.models();
    await session.setModel(null);
    const id = session.sessionId;
    expect(sent.slice(2)).toEqual([
      { method: Method.Models, params: { sessionId: id } },
      { method: Method.SetModel, params: { sessionId: id, name: null } },
    ]);
  });

  test("a refusal keeps its code and words", async () => {
    const { client } = await connect({
      ...HANDLERS,
      [Method.SetModel]: () => {
        throw new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
      },
    });
    let code: number | undefined;
    try {
      await client.newSession().setModel("haiku");
    } catch (error) {
      code = (error as RpcError).code;
    }
    expect(code).toBe(DomainErrorCode.TurnInProgress);
  });
});

describe("an older daemon", () => {
  test("MethodNotFound says to update it, for the list and the switch", async () => {
    const { client } = await connect({});
    const session = client.newSession();
    const wanted = "this daemon's tentacle predates /model switching — update it";
    expect(await message(session.models())).toBe(wanted);
    expect(await message(session.setModel("haiku"))).toBe(wanted);
    // Open now: the same words with a session id.
    expect(await message(session.models())).toBe(wanted);
  });
});
