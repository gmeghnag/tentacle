import { describe, expect, test } from "bun:test";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import { createChannelPair } from "../src/channel.ts";
import { DomainErrorCode, RpcError } from "../src/errors.ts";
import { RpcPeer } from "../src/peer.ts";

const INIT_PARAMS = { protocolVersion: 1, clientCapabilities: { streaming: true } };
const INIT_RESULT = { protocolVersion: 1, agentCapabilities: { tools: true, permissions: true } };

describe("RpcPeer", () => {
  test("correlates a request with its validated response", async () => {
    const [ca, cb] = createChannelPair();
    const server = new RpcPeer(cb, {
      onRequest: async (method) => {
        expect(method).toBe("initialize");
        return INIT_RESULT;
      },
    });
    const client = new RpcPeer(ca);
    const result = await client.request("initialize", INIT_PARAMS);
    expect(result).toEqual(INIT_RESULT);
    server.close();
  });

  test("is bidirectional: the server can request the client mid-flight", async () => {
    const [ca, cb] = createChannelPair();
    // Client answers an inbound permission request.
    const client = new RpcPeer(ca, {
      onRequest: async (method, params) => {
        expect(method).toBe("session/request_permission");
        expect((params as { sessionId: string }).sessionId).toBe("s1");
        return { outcome: { outcome: "selected", optionId: "allow_once" } };
      },
    });
    const server = new RpcPeer(cb);
    const res = (await server.request("session/request_permission", {
      sessionId: "s1",
      toolCallId: "t1",
      title: "Run a shell command",
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
    })) as { outcome: { outcome: string } };
    expect(res.outcome.outcome).toBe("selected");
    client.close();
  });

  test("delivers notifications to the other end", async () => {
    const [ca, cb] = createChannelPair();
    let got: unknown;
    const server = new RpcPeer(cb, {
      onNotification: (method, params) => {
        expect(method).toBe("session/cancel");
        got = params;
      },
    });
    const client = new RpcPeer(ca);
    client.notify("session/cancel", { sessionId: "s9" });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual({ sessionId: "s9" });
    server.close();
  });

  test("rejects an outbound request with invalid params for a known method", async () => {
    const [ca] = createChannelPair();
    const client = new RpcPeer(ca);
    await expect(client.request("initialize", {})).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  test("an unknown method yields MethodNotFound", async () => {
    const [ca, cb] = createChannelPair();
    const server = new RpcPeer(cb, { onRequest: async () => ({}) });
    const client = new RpcPeer(ca);
    await expect(client.request("bogus/method")).rejects.toMatchObject({
      code: JsonRpcErrorCode.MethodNotFound,
    });
    server.close();
  });

  test("a handler throwing RpcError maps to a specific error response", async () => {
    const [ca, cb] = createChannelPair();
    const server = new RpcPeer(cb, {
      onRequest: async () => {
        throw new RpcError(DomainErrorCode.VersionMismatch, "nope");
      },
    });
    const client = new RpcPeer(ca);
    await expect(client.request("initialize", INIT_PARAMS)).rejects.toMatchObject({
      code: DomainErrorCode.VersionMismatch,
      message: "nope",
    });
    server.close();
  });

  test("a non-RpcError handler failure is a generic internal error (no leak)", async () => {
    const [ca, cb] = createChannelPair();
    const errors: Error[] = [];
    const server = new RpcPeer(cb, {
      onRequest: async () => {
        throw new Error("secret stack detail");
      },
      onError: (e) => errors.push(e),
    });
    const client = new RpcPeer(ca);
    await expect(client.request("initialize", INIT_PARAMS)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: "internal error",
    });
    expect(errors[0]?.message).toBe("secret stack detail"); // logged locally only
    server.close();
  });

  test("exposeInternalErrors surfaces the real message + stack to the client (trusted/local peer)", async () => {
    const [ca, cb] = createChannelPair();
    const errors: Error[] = [];
    const server = new RpcPeer(cb, {
      onRequest: async () => {
        throw new Error("the real crash");
      },
      onError: (e) => errors.push(e),
      exposeInternalErrors: true,
    });
    const client = new RpcPeer(ca);
    // No longer reduced to "internal error": the client sees the actual cause,
    // with the stack along in `data` for reporting.
    await expect(client.request("initialize", INIT_PARAMS)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: "the real crash",
      data: { stack: expect.any(String) },
    });
    expect(errors[0]?.message).toBe("the real crash"); // still reported locally too
    server.close();
  });

  test("an invalid result from the handler rejects the caller", async () => {
    const [ca, cb] = createChannelPair();
    const server = new RpcPeer(cb, { onRequest: async () => ({ wrong: true }) });
    const client = new RpcPeer(ca);
    await expect(client.request("initialize", INIT_PARAMS)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
    });
    server.close();
  });

  test("closing rejects in-flight requests", async () => {
    const [ca, cb] = createChannelPair();
    const server = new RpcPeer(cb, { onRequest: () => new Promise(() => {}) }); // never resolves
    const client = new RpcPeer(ca);
    const p = client.request("initialize", INIT_PARAMS);
    client.close();
    await expect(p).rejects.toMatchObject({ code: JsonRpcErrorCode.InternalError });
    server.close();
  });

  test("an outbound request times out when configured", async () => {
    const [ca, cb] = createChannelPair();
    const server = new RpcPeer(cb, { onRequest: () => new Promise(() => {}) });
    const client = new RpcPeer(ca, { requestTimeoutMs: 20 });
    await expect(client.request("initialize", INIT_PARAMS)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
    });
    server.close();
  });

  test("rejects an inbound frame larger than maxFrameBytes before parsing", async () => {
    const [ca, cb] = createChannelPair();
    let handlerCalls = 0;
    // Peer on `ca` caps frames; we drive raw frames in from the bare `cb` end.
    new RpcPeer(ca, {
      maxFrameBytes: 100,
      onRequest: async () => {
        handlerCalls++;
        return {};
      },
    });
    const back: string[] = [];
    cb.setOnMessage((d) => back.push(d));
    cb.send("x".repeat(500)); // oversized, and not even valid JSON
    await new Promise((r) => setTimeout(r, 10));
    expect(handlerCalls).toBe(0); // never parsed, never dispatched
    expect(back).toHaveLength(1);
    const err = JSON.parse(back[0] ?? "{}");
    expect(err.id).toBeNull();
    expect(err.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(err.error.message).toBe("frame too large");
  });
});
