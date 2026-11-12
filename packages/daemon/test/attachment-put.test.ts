import { describe, expect, test } from "bun:test";
/**
 * `attachment/put` through a real `Connection` (docs/feat/attachments-upload.md T3).
 *
 * The property: the authorization boundary is "open on THIS connection" (P3),
 * the store lives with the SESSION (so a detach + re-attach resumes), a close
 * or delete returns every reserved byte, and the daemon stays unserialized —
 * a `session/log` sent between two chunks is answered before the last chunk's
 * ack, never queued behind a bulk transfer.
 */
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import { type ModelProvider, PermissionBroker } from "@tentacle/core";
import { DomainErrorCode, Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection, SessionHost } from "../src/index.ts";

const CHUNK = 256 * 1024;

const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

class Idle implements ModelProvider {
  readonly id = "idle";
  // biome-ignore lint/correctness/useYield: never streams here
  async *stream(): AsyncIterable<never> {
    throw new Error("must not generate");
  }
}

/** A turn this test holds open, so a put can be timed against a RUNNING handler. */
class Gated implements ModelProvider {
  readonly id = "gated";
  private release: () => void = () => {};
  // Declared BEFORE `started`: a later field initializer would overwrite the
  // resolver this one's executor assigns.
  private markStarted: () => void = () => {};
  readonly started = new Promise<void>((started) => {
    this.markStarted = started;
  });
  async *stream(): AsyncIterable<never> {
    this.markStarted();
    await new Promise<void>((r) => {
      this.release = r;
    });
    yield* [];
  }
  letThrough(): void {
    this.release();
  }
}

function host(): SessionHost {
  return hostWith(new Idle());
}

function hostWith(model: ModelProvider): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/attachment-put",
    createAgent: () => ({
      agent: new Agent({ model, tools: new ToolRegistry(), env: env as never }),
      permissions: new PermissionBroker(),
    }),
  });
}

/** A client peer on a fresh connection to `h`, handshaken. */
async function connect(
  h: SessionHost,
): Promise<{ client: RpcPeer; frames: { method?: string; params?: Record<string, unknown> }[] }> {
  const [d, c] = createChannelPair();
  new Connection(d, h);
  const frames: { method?: string; params?: Record<string, unknown> }[] = [];
  const tap = {
    send: (data: string) => {
      frames.push(JSON.parse(data));
      c.send(data);
    },
    close: () => c.close(),
    setOnMessage: (handler: (d: string) => void) => c.setOnMessage(handler),
    setOnClose: (handler: () => void) => c.setOnClose(handler),
  };
  // The daemon asks about project hooks before a turn runs (`hooks/trust`):
  // this client declines, so the turn proceeds.
  const client = new RpcPeer(tap, {
    onRequest: async (method) => {
      if (method === Method.HooksTrust) return { trusted: false };
      throw new Error(`unexpected request ${method}`);
    },
  });
  await client.request(Method.Initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  return { client, frames };
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function blob(size: number, seed = 3): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

const b64 = (bytes: Uint8Array, at: number, len = Math.min(CHUNK, bytes.length - at)): string =>
  Buffer.from(bytes.subarray(at, at + len)).toString("base64");

type Ack = { have: number; complete: boolean };

const put = (client: RpcPeer, sessionId: string, params: Record<string, unknown>): Promise<Ack> =>
  client.request(Method.AttachmentPut, { sessionId, ...params }) as Promise<Ack>;

const probe = (client: RpcPeer, sessionId: string, id: string, size: number): Promise<Ack> =>
  put(client, sessionId, { id, size, offset: 0, data: "" });

const codeOf = async (p: Promise<unknown>): Promise<number | undefined> => {
  try {
    await p;
  } catch (error) {
    return (error as { code?: number }).code;
  }
  return undefined;
};

describe("the authorization boundary (P3)", () => {
  test("a put for a session not opened on this connection is `UnknownSession`", async () => {
    const h = host();
    const a = await connect(h);
    await a.client.request(Method.Open, { sessionId: "S", create: true });
    const b = await connect(h);
    expect(await codeOf(probe(b.client, "S", "a".repeat(64), 10))).toBe(
      DomainErrorCode.UnknownSession,
    );
    // The owner still can.
    expect(await probe(a.client, "S", "a".repeat(64), 10)).toEqual({ have: 0, complete: false });
  });

  test("after `session/close` and after `session/delete`: `UnknownSession`, budget back to 0", async () => {
    const h = host();
    const { client } = await connect(h);
    await client.request(Method.Open, { sessionId: "S", create: true });
    await probe(client, "S", "a".repeat(64), 4096);
    expect(h.uploadBytesUsed).toBe(4096);
    await client.request(Method.Close, { sessionId: "S" });
    expect(h.uploadBytesUsed).toBe(0);
    expect(await codeOf(probe(client, "S", "a".repeat(64), 4096))).toBe(
      DomainErrorCode.UnknownSession,
    );

    // A fresh session under the same id, then `session/delete`.
    await client.request(Method.Open, { sessionId: "T", create: true });
    await probe(client, "T", "b".repeat(64), 2048);
    expect(h.uploadBytesUsed).toBe(2048);
    await client.request(Method.SessionDelete, { sessionId: "T" });
    expect(h.uploadBytesUsed).toBe(0);
    expect(await codeOf(probe(client, "T", "b".repeat(64), 2048))).toBe(
      DomainErrorCode.UnknownSession,
    );
  });
});

describe("the store belongs to the session, not the connection", () => {
  test("detach, then a second connection reopens and the probe returns the earlier `have`", async () => {
    const h = host();
    const bytes = blob(2 * CHUNK);
    const id = sha(bytes);
    const first = await connect(h);
    await first.client.request(Method.Open, { sessionId: "S", create: true });
    const ack = await put(first.client, "S", {
      id,
      size: bytes.length,
      offset: 0,
      data: b64(bytes, 0),
    });
    expect(ack).toEqual({ have: CHUNK, complete: false });
    first.client.close();

    const second = await connect(h);
    await second.client.request(Method.Open, { sessionId: "S" });
    expect(await probe(second.client, "S", id, bytes.length)).toEqual({
      have: CHUNK,
      complete: false,
    });
    // And it finishes from there.
    expect(
      await put(second.client, "S", {
        id,
        size: bytes.length,
        offset: CHUNK,
        data: b64(bytes, CHUNK),
      }),
    ).toEqual({ have: bytes.length, complete: true });
  });

  test("two connections on one session, the same bytes: one `Complete`, both end complete", async () => {
    const h = host();
    const bytes = blob(2 * CHUNK);
    const id = sha(bytes);
    const a = await connect(h);
    await a.client.request(Method.Open, { sessionId: "S", create: true });
    const b = await connect(h);
    await b.client.request(Method.Open, { sessionId: "S" });

    // Interleaved: A's first chunk, then B's probe (it sees A's progress), then
    // both send chunk 1 — one of them is a duplicate (rule 7) and writes nothing.
    expect(
      await put(a.client, "S", { id, size: bytes.length, offset: 0, data: b64(bytes, 0) }),
    ).toEqual({ have: CHUNK, complete: false });
    expect(await probe(b.client, "S", id, bytes.length)).toEqual({ have: CHUNK, complete: false });
    const [a2, b2] = await Promise.all([
      put(a.client, "S", { id, size: bytes.length, offset: CHUNK, data: b64(bytes, CHUNK) }),
      put(b.client, "S", { id, size: bytes.length, offset: CHUNK, data: b64(bytes, CHUNK) }),
    ]);
    expect(a2).toEqual({ have: bytes.length, complete: true });
    expect(b2).toEqual({ have: bytes.length, complete: true });
    // ONE reservation for the blob, and the store holds exactly the right bytes.
    expect(h.uploadBytesUsed).toBe(bytes.length);
    const read = await (h
      .get("S")
      ?.uploads.read({ id, mimeType: "image/png", size: bytes.length }) ?? null);
    expect(read).not.toBeNull();
    expect(Buffer.from(read ?? new Uint8Array()).toString("hex")).toBe(
      Buffer.from(bytes).toString("hex"),
    );
    const again = await probe(a.client, "S", id, bytes.length);
    expect(again).toEqual({ have: bytes.length, complete: true });
  });
});

describe("the daemon is never serialized by a bulk transfer (AGENTS §7)", () => {
  test("a `session/log` sent between two chunks is answered in arrival order, before the last ack", async () => {
    const h = host();
    const bytes = blob(2 * CHUNK);
    const id = sha(bytes);
    const { client, frames } = await connect(h);
    await client.request(Method.Open, { sessionId: "S", create: true });
    const before = frames.length;

    // The SETTLE order: a short request written between two chunks is not held
    // back to the end of the upload.
    const order: string[] = [];
    const first = put(client, "S", { id, size: bytes.length, offset: 0, data: b64(bytes, 0) }).then(
      (r) => {
        order.push("put-0");
        return r;
      },
    );
    // Issued in the same tick: written to the channel AFTER chunk 1.
    const log = client.request(Method.Log, { sessionId: "S" }).then((r) => {
      order.push("log");
      return r;
    });
    const last = put(client, "S", {
      id,
      size: bytes.length,
      offset: CHUNK,
      data: b64(bytes, CHUNK),
    }).then((r) => {
      order.push("put-1");
      return r;
    });
    await first;
    await log;
    const ack = await last;
    expect(ack).toEqual({ have: bytes.length, complete: true });
    // The log read did NOT wait for the upload: it was answered before the
    // second chunk's ack (frames are ordered, so nothing else is possible).
    expect(order.indexOf("log")).toBeLessThan(order.indexOf("put-1"));

    const methods = frames.slice(before).map((f) => f.method ?? "response");
    expect(methods.filter((m) => m === Method.AttachmentPut).length).toBe(2);
    expect(methods).toContain(Method.Log);
  });

  test("a put is answered while a slow TURN is still in flight (no lock on the peer)", async () => {
    // The load-bearing property (docs/feat/attachments-upload.md §Load-bearing
    // assumption): a suspended `session/prompt` — the long handler every
    // upload shares the connection with — holds no lock. Mutation: any `await`
    // on a per-connection mutex before the `switch` (or a never-resolving one)
    // leaves this probe unanswered until the turn ends, and it times out.
    const model = new Gated();
    const h = hostWith(model);
    const { client } = await connect(h);
    await client.request(Method.Open, { sessionId: "S", create: true });
    // Start a turn that blocks the model forever: `session/prompt` acks at the
    // turn's start, and the stream then hangs on this gate.
    await client.request(Method.Prompt, {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await model.started;
    // The turn is RUNNING (its handler is suspended on the model): a put must
    // still be answered. A serialized peer would wait for the turn's end.
    const ack = await Promise.race([
      probe(client, "S", "a".repeat(64), 4096),
      new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 2000)),
    ]);
    expect(ack).toEqual({ have: 0, complete: false });
    model.letThrough();
  });
});
