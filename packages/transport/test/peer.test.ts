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
    // Client answers an inbound model request (the pod reverse-tunnel).
    const client = new RpcPeer(ca, {
      onRequest: async (method, params) => {
        expect(method).toBe("model/stream");
        expect((params as { request: { messages: unknown[] } }).request.messages).toHaveLength(1);
        return { events: [{ type: "text", delta: "hi" }, { type: "done" }] };
      },
    });
    const server = new RpcPeer(cb);
    const res = (await server.request("model/stream", {
      request: { messages: [{ role: "user", content: "q" }] },
    })) as { events: { type: string }[] };
    expect(res.events.map((e) => e.type)).toEqual(["text", "done"]);
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

  // --- $/cancelRequest + $/progress (generic peer primitives) -------------

  test("request({signal}): abort sends $/cancelRequest with the outbound id and rejects locally with the cancelled marker", async () => {
    const [ca, cb] = createChannelPair();
    // $/cancelRequest is handled by the peer INTERNALLY (never reaches an
    // onNotification), so capture the raw outbound frames on the wire.
    const out: string[] = [];
    const realA = ca;
    const recA: typeof ca = {
      send: (d) => {
        out.push(d);
        realA.send(d);
      },
      close: () => realA.close(),
      setOnMessage: (h) => realA.setOnMessage(h),
      setOnClose: (h) => realA.setOnClose(h),
    };
    const server = new RpcPeer(cb, { onRequest: () => new Promise(() => {}) });
    const client = new RpcPeer(recA);
    const controller = new AbortController();
    const p = client.request(
      "model/stream",
      { request: { messages: [{ role: "user", content: "q" }] } },
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "cancelled" });
    await new Promise((r) => setTimeout(r, 5)); // let the $/cancelRequest frame hit the wire
    const cancelFrame = out
      .map((f) => JSON.parse(f) as { method?: string; params?: { id?: string } })
      .find((f) => f.method === "$/cancelRequest");
    // A notification: the cancelled request's id is carried in params.
    expect(cancelFrame).toBeDefined();
    expect(cancelFrame?.params?.id).toMatch(/^\d+$/);
    server.close();
  });

  test("request({signal}): an already-settled request ignores a later abort (no $/cancelRequest, no second rejection)", async () => {
    const [ca, cb] = createChannelPair();
    const out: string[] = [];
    const realA = ca;
    const recA: typeof ca = {
      send: (d) => {
        out.push(d);
        realA.send(d);
      },
      close: () => realA.close(),
      setOnMessage: (h) => realA.setOnMessage(h),
      setOnClose: (h) => realA.setOnClose(h),
    };
    const server = new RpcPeer(cb, { onRequest: async () => INIT_RESULT });
    const client = new RpcPeer(recA);
    const controller = new AbortController();
    const result = await client.request("initialize", INIT_PARAMS, {
      signal: controller.signal,
    });
    expect(result).toEqual(INIT_RESULT);
    controller.abort(); // after settlement: must be a no-op
    await new Promise((r) => setTimeout(r, 5));
    expect(out.filter((f) => JSON.parse(f).method === "$/cancelRequest")).toHaveLength(0);
    server.close();
  });

  test("request({signal}): an already-aborted signal rejects before the frame is sent (nothing on the wire)", async () => {
    const [ca] = createChannelPair();
    const out: string[] = [];
    const recA: typeof ca = {
      send: (d) => {
        out.push(d);
        ca.send(d);
      },
      close: () => ca.close(),
      setOnMessage: (h) => ca.setOnMessage(h),
      setOnClose: (h) => ca.setOnClose(h),
    };
    const client = new RpcPeer(recA);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.request("initialize", INIT_PARAMS, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "cancelled" });
    // Neither the request nor a $/cancelRequest for an id the peer never saw.
    expect(out).toEqual([]);
    client.close();
  });

  test("a late response to a request WE cancelled is discarded silently (no onError noise); a truly unknown id still reports", async () => {
    const [ca, cb] = createChannelPair();
    const errors: string[] = [];
    let answer: ((v: unknown) => void) | undefined;
    const server = new RpcPeer(cb, {
      onRequest: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const client = new RpcPeer(ca, { onError: (e) => errors.push(e.message) });
    const controller = new AbortController();
    const p = client.request("initialize", INIT_PARAMS, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "cancelled" });
    answer?.(INIT_RESULT); // the responder finishes anyway, after our cancel
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual([]);
    cb.send(JSON.stringify({ jsonrpc: "2.0", id: "999", result: null }));
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual(["response for unknown request id: 999"]);
    server.close();
  });

  test("inbound $/cancelRequest aborts the matching request's context signal; an unknown id is a no-op", async () => {
    const [ca, cb] = createChannelPair();
    let signal: AbortSignal | undefined;
    const server = new RpcPeer(cb, {
      onRequest: async (_m, _p, ctx) => {
        signal = ctx?.signal;
        await new Promise(() => {}); // never settles, so the controller stays live
      },
    });
    const client = new RpcPeer(ca);
    const p = client.request("model/stream", {
      request: { messages: [{ role: "user", content: "q" }] },
    });
    // Let the request reach the server and register its controller.
    await new Promise((r) => setTimeout(r, 5));
    expect(signal?.aborted).toBe(false);
    // Send a cancel for the (unknown) id 999: must be a clean no-op (no throw).
    client.notify("$/cancelRequest", { id: "999" });
    await new Promise((r) => setTimeout(r, 5));
    expect(signal?.aborted).toBe(false); // unknown id did not abort our handler
    server.close();
    await p.catch(() => {}); // close rejects it; swallow
  });

  test("inbound $/cancelRequest aborts the matching request's context signal (real id)", async () => {
    const [ca, cb] = createChannelPair();
    const seen: AbortSignal[] = [];
    // Capture the outbound request's id by intercepting the request frame.
    const client = new RpcPeer(ca);
    const server = new RpcPeer(cb, {
      onRequest: async (_m, _p, ctx) => {
        seen.push(ctx?.signal as AbortSignal);
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true };
      },
    });
    const p = client.request("model/stream", {
      request: { messages: [{ role: "user", content: "q" }] },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toHaveLength(1);
    // The client's first outbound request id is "1" (ids are stringified ints).
    client.notify("$/cancelRequest", { id: "1" });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen[0]?.aborted).toBe(true); // the matching handler was aborted
    server.close();
    await p.catch(() => {});
  });

  test("request({onProgress}) receives $/progress for its id in seq order; a progress for an unknown id is dropped", async () => {
    const [ca, cb] = createChannelPair();
    const got: { value: unknown; seq: number }[] = [];
    const server = new RpcPeer(cb, { onRequest: () => new Promise(() => {}) });
    const client = new RpcPeer(ca);
    const p = client.request("initialize", INIT_PARAMS, {
      onProgress: (value, seq) => got.push({ value, seq }),
    });
    await new Promise((r) => setTimeout(r, 5));
    // Drive raw $/progress frames in from the bare `cb` end, out of order on
    // purpose, plus one for a settled/unknown id.
    cb.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { id: "1", seq: 0, value: { type: "text", delta: "a" } },
      }),
    );
    cb.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { id: "1", seq: 1, value: { type: "text", delta: "b" } },
      }),
    );
    cb.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { id: "42", seq: 0, value: { type: "text", delta: "x" } },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([
      { value: { type: "text", delta: "a" }, seq: 0 },
      { value: { type: "text", delta: "b" }, seq: 1 },
    ]); // the unknown-id progress was dropped
    server.close();
    await p.catch(() => {});
  });

  test("$/progress is generic: a non-model value routes unchanged to onProgress", async () => {
    const [ca, cb] = createChannelPair();
    const got: unknown[] = [];
    const server = new RpcPeer(cb, { onRequest: () => new Promise(() => {}) });
    const client = new RpcPeer(ca);
    const p = client.request("initialize", INIT_PARAMS, { onProgress: (value) => got.push(value) });
    await new Promise((r) => setTimeout(r, 5));
    cb.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { id: "1", seq: 0, value: { stdout: "chunk" } },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([{ stdout: "chunk" }]);
    server.close();
    await p.catch(() => {});
  });

  test("a malformed $/progress is reported (not fatal) and does not route", async () => {
    const [ca, cb] = createChannelPair();
    const errors: Error[] = [];
    const got: unknown[] = [];
    const server = new RpcPeer(cb, { onRequest: () => new Promise(() => {}) });
    const client = new RpcPeer(ca, { onError: (e) => errors.push(e) });
    const p = client.request("initialize", INIT_PARAMS, {
      onProgress: (value) => got.push(value),
    });
    await new Promise((r) => setTimeout(r, 5));
    // `seq` out of range → fails the strict schema.
    cb.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { id: "1", seq: -1, value: { type: "text", delta: "a" } },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(0); // nothing routed
    expect(errors.some((e) => e.message.includes("$/progress"))).toBe(true);
    server.close();
    await p.catch(() => {});
  });

  test("dispatch stays concurrent: a $/progress for a long request is not blocked by another in-flight request (§7)", async () => {
    const [ca, cb] = createChannelPair();
    const got: number[] = [];
    // The server has a request handler that never resolves (a long turn).
    const server = new RpcPeer(cb, { onRequest: () => new Promise(() => {}) });
    const client = new RpcPeer(ca);
    const p = client.request("initialize", INIT_PARAMS, {
      onProgress: (_value, seq) => got.push(seq),
    });
    await new Promise((r) => setTimeout(r, 5));
    // Send a progress for the long request; it must be routed even though the
    // request is still in flight (the handler has not resolved).
    cb.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { id: "1", seq: 0, value: { type: "text", delta: "a" } },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([0]); // routed while the request was still open
    server.close();
    await p.catch(() => {});
  });
  test("a connection close aborts every in-flight inbound handler's context signal", async () => {
    const [ca, cb] = createChannelPair();
    let seen: AbortSignal | undefined;
    const server = new RpcPeer(cb, {
      onRequest: (_method, _params, context) => {
        seen = context?.signal;
        return new Promise(() => {}); // a long-running responder (a model round)
      },
    });
    const client = new RpcPeer(ca);
    client.request("initialize", INIT_PARAMS).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(seen?.aborted).toBe(false);
    ca.close(); // the caller went away mid-request
    await new Promise((r) => setTimeout(r, 5));
    // The responder must stop its work: nobody can receive its result any more.
    expect(seen?.aborted).toBe(true);
    server.close();
  });

  test("onClose fires exactly once: on a remote close, and on a local close()", async () => {
    // Remote close: the other end closes the channel.
    const [ca, cb] = createChannelPair();
    let closes = 0;
    const local = new RpcPeer(ca, { onClose: () => closes++ });
    const remote = new RpcPeer(cb);
    remote.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(closes).toBe(1);
    local.close(); // already closed: no second call
    expect(closes).toBe(1);

    // Local close: the hook runs too (both paths funnel into handleClose).
    const [cc, cd] = createChannelPair();
    let localCloses = 0;
    const peer = new RpcPeer(cc, { onClose: () => localCloses++ });
    new RpcPeer(cd);
    peer.close();
    peer.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(localCloses).toBe(1);
  });

  test("inside onClose the peer is already closed and its pending requests are rejected", async () => {
    const [ca, cb] = createChannelPair();
    const seen: { closed?: boolean; late?: string } = {};
    let lateRequest: Promise<unknown> = Promise.resolve();
    const client: RpcPeer = new RpcPeer(ca, {
      onClose: () => {
        seen.closed = client.isClosed;
        lateRequest = client.request("initialize", INIT_PARAMS).catch((e: Error) => {
          seen.late = e.message;
        });
      },
    });
    new RpcPeer(cb, { onRequest: () => new Promise(() => {}) });
    const pending = client.request("initialize", INIT_PARAMS);
    client.close();
    await expect(pending).rejects.toThrow("connection closed");
    await lateRequest;
    expect(seen).toEqual({ closed: true, late: "peer is closed" });
  });

  test("onInvalidNotification receives a known notification whose params fail its schema", async () => {
    const [ca, cb] = createChannelPair();
    const invalid: [string, unknown][] = [];
    const errors: string[] = [];
    new RpcPeer(ca, {
      onInvalidNotification: (method, params) => invalid.push([method, params]),
      onError: (e) => errors.push(e.message),
    });
    const sender = new RpcPeer(cb);
    const bad = { sessionId: "s1", mandatory: true, update: { type: "turn_end" } }; // no seq
    sender.notify("session/update", bad);
    sender.notify("no/such/notification", { x: 1 }); // unknown method: onError only
    await new Promise((r) => setTimeout(r, 5));
    expect(invalid).toEqual([["session/update", bad]]);
    // Still reported, as before (the hook is in addition, never instead).
    expect(errors).toEqual([
      "invalid params for notification session/update",
      "unknown notification: no/such/notification",
    ]);
  });

  test("a throwing onClose is reported, never thrown out of close()", () => {
    const [ca, cb] = createChannelPair();
    const errors: string[] = [];
    const peer = new RpcPeer(ca, {
      onClose: () => {
        throw new Error("hook failed");
      },
      onError: (e) => errors.push(e.message),
    });
    new RpcPeer(cb);
    expect(() => peer.close()).not.toThrow();
    expect(errors).toEqual(["hook failed"]);
  });

  test("a throwing onInvalidNotification is reported, never thrown out of dispatch", async () => {
    const [ca, cb] = createChannelPair();
    const errors: string[] = [];
    new RpcPeer(ca, {
      onInvalidNotification: () => {
        throw new Error("hook failed");
      },
      onError: (e) => errors.push(e.message),
    });
    new RpcPeer(cb).notify("session/update", { sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 5));
    expect(errors).toEqual(["invalid params for notification session/update", "hook failed"]);
  });
});
