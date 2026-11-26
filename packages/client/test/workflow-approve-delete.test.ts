/**
 * `session/workflow_approve` + `session/workflow_delete` on the client
 * (docs/feat/mobile-workflows-landing.md D5): an older daemon is
 * `{unsupported:true}`, a daemon that is not trusted to run workflows (a pod) is
 * refused locally and sent NOTHING (AGENTS §7), and an approve mints a turn id
 * the session owns.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { JsonRpcErrorCode, Method, PROTOCOL_VERSION, isWakeTurnId } from "@tentacle/protocol";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";
import { WORKFLOW_UNTRUSTED_DAEMON } from "../src/workflows.ts";

const HASH = "a".repeat(64);

/** A fake daemon: the handshake, `session/open`, and nothing else unless told. */
function fakeDaemon(handlers: Record<string, (params: unknown) => unknown> = {}) {
  const [daemonCh, clientCh] = createChannelPair();
  const sent: { method: string; params: unknown }[] = [];
  new RpcPeer(daemonCh, {
    onRequest: async (method: string, params: unknown) => {
      sent.push({ method, params });
      if (method === Method.Initialize) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      }
      if (method === Method.Open) {
        return { sessionId: "s1", epoch: "e", created: true, resync: false };
      }
      if (method === Method.Snapshot) {
        return { messages: [] };
      }
      const handler = handlers[method];
      if (handler) {
        return handler(params);
      }
      // An older daemon knows nothing else.
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
    },
  });
  return { sent, clientCh };
}

async function attach(
  d: ReturnType<typeof fakeDaemon>,
  opts: { daemonWakes?: boolean; unopened?: boolean } = {},
) {
  const client = new RemoteClient(d.clientCh, new PermissionBroker(), undefined, {
    channelFactory: async () => {
      throw new Error("unused");
    },
    random: () => 0,
    ...(opts.daemonWakes === undefined ? {} : { daemonWakes: opts.daemonWakes }),
  });
  await client.initialize();
  if (opts.unopened === true) {
    return { client, session: client.newSession() };
  }
  const session = client.newSession(undefined, "s1", undefined, { attach: {} });
  await session.open();
  return { client, session };
}

const handlers = {
  [Method.WorkflowApprove]: () => ({ ok: true, asked: true }),
  [Method.WorkflowDelete]: () => ({ ok: true, path: ".tentacle/workflows/task.yaml" }),
};
const ours = (sent: { method: string; params: unknown }[]) =>
  sent.filter((s) => s.method === Method.WorkflowApprove || s.method === Method.WorkflowDelete);

describe("RemoteSession.workflowApprove / workflowDelete", () => {
  test("approve sends the hash seen and a minted, owned, non-wake turn id", async () => {
    const d = fakeDaemon(handlers);
    const { client, session } = await attach(d, { daemonWakes: true });
    expect(await session.workflowApprove("task", HASH)).toEqual({ ok: true, asked: true });
    const params = ours(d.sent)[0] as { params: { turnId: string } } | undefined;
    const turnId = params?.params.turnId ?? "";
    expect(ours(d.sent)).toEqual([
      {
        method: Method.WorkflowApprove,
        params: { sessionId: "s1", name: "task", hash: HASH, turnId },
      } as { method: string; params: unknown },
    ]);
    expect(turnId).not.toBe("");
    expect(isWakeTurnId(turnId)).toBe(false);
    expect(session.ownsTurn(turnId)).toBe(true);
    client.close();
  });

  test("delete sends the hash seen, or none for a broken file", async () => {
    const d = fakeDaemon(handlers);
    const { client, session } = await attach(d, { daemonWakes: true });
    expect(await session.workflowDelete("task", HASH)).toEqual({
      ok: true,
      path: ".tentacle/workflows/task.yaml",
    });
    await session.workflowDelete("broken");
    expect(ours(d.sent).map((s) => s.params)).toEqual([
      { sessionId: "s1", name: "task", hash: HASH },
      { sessionId: "s1", name: "broken" },
    ]);
    client.close();
  });

  test("an OLDER daemon is `{unsupported:true}` for both, never a throw", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d, { daemonWakes: true });
    expect(await session.workflowApprove("task", HASH)).toEqual({ unsupported: true });
    expect(await session.workflowDelete("task", HASH)).toEqual({ unsupported: true });
    client.close();
  });

  test("an untrusted daemon (a pod) is refused locally: nothing sent, nothing opened", async () => {
    for (const unopened of [false, true]) {
      const d = fakeDaemon(handlers);
      const { client, session } = await attach(d, { unopened });
      const refused = { ok: false, refusal: "unavailable", reason: WORKFLOW_UNTRUSTED_DAEMON };
      expect(await session.workflowApprove("task", HASH)).toEqual(refused);
      expect(await session.workflowDelete("task", HASH)).toEqual(refused);
      expect(ours(d.sent)).toEqual([]);
      expect(d.sent.filter((s) => s.method === Method.Open)).toHaveLength(unopened ? 0 : 1);
      client.close();
    }
  });

  test("before the first message both OPEN the session first, then act (like a start)", async () => {
    for (const act of ["approve", "delete"] as const) {
      const d = fakeDaemon(handlers);
      const { client, session } = await attach(d, { daemonWakes: true, unopened: true });
      const answer =
        act === "approve"
          ? await session.workflowApprove("task", HASH)
          : await session.workflowDelete("task", HASH);
      expect("ok" in answer && answer.ok).toBe(true);
      const methods = d.sent.map((s) => s.method);
      expect(methods.indexOf(Method.Open)).toBeGreaterThan(-1);
      expect(methods.indexOf(Method.Open)).toBeLessThan(methods.length - 1);
      expect(ours(d.sent)).toHaveLength(1);
      client.close();
    }
  });
});
