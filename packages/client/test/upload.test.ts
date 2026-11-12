import { describe, expect, test } from "bun:test";
/**
 * `RemoteClient.upload()` over a real daemon `Connection`
 * (docs/feat/attachments-upload.md T5).
 *
 * The property: a blob reaches the daemon store complete and byte-identical in
 * a bounded number of frames, at most `UPLOAD_WINDOW` puts at a time; a drop
 * mid-upload resumes from what the store kept; and a daemon that lies or
 * refuses cannot make the laptop send forever, read a file, or report success.
 */
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import { type ExecutionEnvironment, type ModelProvider, PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost, type SessionHost as SessionHostType } from "@tentacle/daemon";
import {
  ATTACHMENT_CHUNK_BYTES,
  DomainErrorCode,
  JsonRpcErrorCode,
  MAX_IMAGE_BYTES,
  Method,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { type DuplexChannel, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { AttachmentsUnsupportedError, RemoteClient, UploadAbortedError } from "../src/index.ts";
import { UPLOAD_WINDOW, UploadProtocolError } from "../src/upload-window.ts";

const CHUNK = ATTACHMENT_CHUNK_BYTES;

const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
} as unknown as ExecutionEnvironment;

class Idle implements ModelProvider {
  readonly id = "idle";
  // biome-ignore lint/correctness/useYield: never streams here
  async *stream(): AsyncIterable<never> {
    throw new Error("must not generate");
  }
}

function host(): SessionHostType {
  return new SessionHost({
    defaultCwd: "/tmp/upload",
    createAgent: () => ({
      agent: new Agent({ model: new Idle(), tools: {} as never, env }),
      permissions: new PermissionBroker(),
    }),
  });
}

function blob(size: number, seed = 5): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xffff;
  }
  return out;
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The bytes a store holds for `id`, hex, or null. */
async function storedHex(
  h: SessionHostType,
  sessionId: string,
  id: string,
  size: number,
): Promise<string | null> {
  const read = await (h.get(sessionId)?.uploads.read({ id, mimeType: "image/png", size }) ?? null);
  return read === null ? null : Buffer.from(read).toString("hex");
}

/** A dial target: fresh in-memory links to ONE host, and every outbound client frame. */
class Dialer {
  readonly frames: { method?: string; params?: Record<string, unknown> }[][] = [];
  last: DuplexChannel | null = null;
  calls = 0;
  /** Called after the n-th DATA chunk (`data !== ""`) is written, before it is answered. */
  onDataPut: ((n: number) => void) | null = null;
  /** Peak `attachment/put` frames written and not yet answered (the real concurrency). */
  readonly peak: { value: number } = { value: 0 };
  private dataPuts = 0;
  private outstanding = 0;
  private readonly putIds = new Set<string>();
  constructor(readonly host: SessionHostType) {}
  connect(): DuplexChannel {
    const [d, c] = createChannelPair();
    new Connection(d, this.host);
    const log: { method?: string; params?: Record<string, unknown> }[] = [];
    this.frames.push(log);
    const tapped: DuplexChannel = {
      send: (data) => {
        const frame = JSON.parse(data) as {
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        };
        log.push(frame);
        if (frame.method === Method.AttachmentPut) {
          this.outstanding += 1;
          this.peak.value = Math.max(this.peak.value, this.outstanding);
          if (frame.id !== undefined) this.putIds.add(frame.id);
          c.send(data);
          if (frame.params?.data !== "") {
            this.dataPuts += 1;
            this.onDataPut?.(this.dataPuts);
          }
          return;
        }
        c.send(data);
      },
      close: () => c.close(),
      setOnMessage: (handler) =>
        c.setOnMessage((data) => {
          // Count an answer to a put as it comes back (a failed generation's
          // answers never arrive: the link is gone).
          const frame = JSON.parse(data) as { id?: string; error?: unknown };
          if (frame.id !== undefined && frame.error === undefined && this.putIds.delete(frame.id)) {
            this.outstanding = Math.max(0, this.outstanding - 1);
          }
          handler(data);
        }),
      setOnClose: (handler) => c.setOnClose(handler),
    };
    this.last = tapped;
    return tapped;
  }
  factory = async (): Promise<DuplexChannel> => {
    this.calls += 1;
    return this.connect();
  };
  /** Every outbound `attachment/put` across all generations. */
  puts(): { offset: number; data: string }[] {
    return this.frames.flatMap((log) =>
      log.flatMap((f) =>
        f.method === Method.AttachmentPut
          ? [{ offset: Number(f.params?.offset), data: String(f.params?.data) }]
          : [],
      ),
    );
  }
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A client on a plain (non-factory) link, handshaken, with a session open. */
async function connected(h: SessionHostType): Promise<{
  client: RemoteClient;
  sessionId: string;
}> {
  const [d, c] = createChannelPair();
  new Connection(d, h);
  const client = new RemoteClient(c, new PermissionBroker());
  await client.initialize();
  const sessionId = await client.openSession(undefined, undefined, "S");
  return { client, sessionId };
}

describe("a blob reaches the daemon store", () => {
  test("1 MiB + 1 byte: `{id: sha256, size}`, and the store holds the same bytes", async () => {
    const h = host();
    const { client, sessionId } = await connected(h);
    const bytes = blob(1024 * 1024 + 1);
    const result = await client.upload(sessionId, bytes);
    expect(result).toEqual({ id: sha(bytes), size: bytes.length });
    expect(await storedHex(h, sessionId, sha(bytes), bytes.length)).toBe(
      Buffer.from(bytes).toString("hex"),
    );
    client.close();
  });

  test("the id is the laptop's own digest, whatever the daemon says about `have`", async () => {
    const h = host();
    const { client, sessionId } = await connected(h);
    const bytes = blob(10);
    const result = await client.upload(sessionId, bytes);
    expect(result.id).toBe(createHash("sha256").update(bytes).digest("hex"));
    client.close();
  });

  test("`onProgress` counts up to the whole blob", async () => {
    const h = host();
    const { client, sessionId } = await connected(h);
    const bytes = blob(3 * CHUNK);
    const seen: number[] = [];
    await client.upload(sessionId, bytes, { onProgress: (have) => seen.push(have) });
    expect(seen.at(-1)).toBe(bytes.length);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
    client.close();
  });
});

describe("the window bounds what is on the wire", () => {
  test("never more than 2 puts in flight, and one put per chunk (plus the probe)", async () => {
    const h = host();
    const dial = new Dialer(h);
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const bytes = blob(5 * CHUNK);
    await client.upload(sessionId, bytes);

    // 5 data chunks + 1 probe: the dedupe probe comes first, always.
    const puts = dial.puts();
    expect(puts.filter((p) => p.data === "").length).toBe(1);
    expect(puts.filter((p) => p.data !== "").length).toBe(5);
    // The real concurrency, measured on the wire: at most UPLOAD_WINDOW puts
    // written and unanswered at any moment, and never more than one per chunk
    // (nothing was resent).
    expect(dial.peak.value).toBeLessThanOrEqual(UPLOAD_WINDOW);
    // Never more than one put per chunk: the five data offsets are distinct
    // (nothing was resent), plus the single probe at 0.
    const data = puts.filter((p) => p.data !== "");
    expect(new Set(data.map((p) => p.offset)).size).toBe(5);
    expect(data.map((p) => p.offset).sort((a, b) => a - b)).toEqual([
      0,
      CHUNK,
      2 * CHUNK,
      3 * CHUNK,
      4 * CHUNK,
    ]);
    client.close();
  });

  test("a re-attached image (already stored) sends only the probe", async () => {
    const h = host();
    const dial = new Dialer(h);
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const bytes = blob(3 * CHUNK);
    await client.upload(sessionId, bytes);
    const before = dial.puts().length;
    expect(await client.upload(sessionId, bytes)).toEqual({ id: sha(bytes), size: bytes.length });
    // Exactly ONE more frame: the probe.
    expect(dial.puts().length - before).toBe(1);
    client.close();
  });
});

describe("reconnect mid-upload resumes", () => {
  test("a channel dropped after the first chunk re-probes and sends only the rest", async () => {
    const h = host();
    const dial = new Dialer(h);
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
      random: () => 0,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const bytes = blob(6 * CHUNK);

    // Drop the link as soon as the FIRST data chunk has gone out.
    const before = dial.puts().length;
    dial.onDataPut = (n) => {
      if (n === 1) dial.last?.close();
    };
    const result = await client.upload(sessionId, bytes);
    dial.onDataPut = null;

    expect(result).toEqual({ id: sha(bytes), size: bytes.length });
    expect(dial.calls).toBeGreaterThan(0); // it really reconnected
    expect(await storedHex(h, sessionId, sha(bytes), bytes.length)).toBe(
      Buffer.from(bytes).toString("hex"),
    );
    // Bounded: the blob's own size plus a couple of chunks of slack.
    const dataBytes = dial
      .puts()
      .filter((p) => p.data !== "")
      .reduce((n, p) => n + Buffer.from(p.data, "base64").length, 0);
    expect(dataBytes).toBeLessThan(bytes.length + 3 * CHUNK);
    // The first put after the drop is a probe.
    const gen1 = dial.frames[1] ?? [];
    const firstPut = gen1.find((f) => f.method === Method.AttachmentPut);
    expect(firstPut?.params?.data).toBe("");
    expect(dial.puts().length).toBeGreaterThan(before);
    client.close();
  });
});

describe("refusals and hostile daemons", () => {
  test("an older daemon (`MethodNotFound`) → `AttachmentsUnsupportedError`", async () => {
    const [a, b] = createChannelPair();
    // A daemon that knows no `attachment/put`: it answers MethodNotFound for it.
    new RpcPeer(b, {
      onRequest: async (method) => {
        if (method === Method.Initialize) {
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, daemonKind: "serve" };
        }
        if (method === Method.Open) {
          return { sessionId: "S", messages: [], title: { source: "auto" } };
        }
        if (method === Method.AttachmentPut) {
          throw new RpcError(JsonRpcErrorCode.MethodNotFound, `unknown method: ${method}`);
        }
        return {};
      },
    });
    const client = new RemoteClient(a, new PermissionBroker());
    await client.initialize();
    await expect(client.upload("S", blob(4))).rejects.toBeInstanceOf(AttachmentsUnsupportedError);
    client.close();
  });

  test("a daemon that answers `have: 0` forever → `UploadProtocolError`, in bounded frames", async () => {
    const [a, b] = createChannelPair();
    let puts = 0;
    // A BOUND the test can enforce itself: past it, the fake daemon fails the
    // call with its own error. Belt and braces — without it an unbounded window
    // spins in a microtask loop and starves even the test's own timer, and a
    // hang is not a red test (AGENTS §9).
    const LIMIT = 3 * 4 + 4;
    new RpcPeer(b, {
      onRequest: async (method) => {
        if (method === Method.Initialize) {
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, daemonKind: "serve" };
        }
        if (method === Method.Open) {
          return { sessionId: "S", messages: [], title: { source: "auto" } };
        }
        if (method === Method.AttachmentPut) {
          puts += 1;
          if (puts > LIMIT) throw new Error(`the client sent ${puts} puts for one 2-chunk image`);
          return { have: 0, complete: false };
        }
        return {};
      },
    });
    const client = new RemoteClient(a, new PermissionBroker());
    await client.initialize();
    const bytes = blob(2 * CHUNK);
    const outcome = await client.upload("S", bytes).then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(UploadProtocolError);
    // 3 passes over the blob + a little slack, never unbounded.
    expect(puts).toBeLessThanOrEqual(LIMIT);
    client.close();
  });

  test("a daemon that claims `complete` early → `UploadProtocolError`", async () => {
    const [a, b] = createChannelPair();
    new RpcPeer(b, {
      onRequest: async (method) => {
        if (method === Method.Initialize) {
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, daemonKind: "serve" };
        }
        if (method === Method.Open) {
          return { sessionId: "S", messages: [], title: { source: "auto" } };
        }
        if (method === Method.AttachmentPut) {
          return { have: 0, complete: true };
        }
        return {};
      },
    });
    const client = new RemoteClient(a, new PermissionBroker());
    await client.initialize();
    await expect(client.upload("S", blob(CHUNK + 1))).rejects.toBeInstanceOf(UploadProtocolError);
    client.close();
  });

  test("a `store_full` refusal reaches the caller as that error, not a retry", async () => {
    const h = new SessionHost({
      defaultCwd: "/tmp/upload",
      uploadBytes: 8,
      createAgent: () => ({
        agent: new Agent({ model: new Idle(), tools: {} as never, env }),
        permissions: new PermissionBroker(),
      }),
    });
    const { client, sessionId } = await connected(h);
    let code: number | undefined;
    try {
      await client.upload(sessionId, blob(4 * CHUNK));
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(DomainErrorCode.AttachmentRefused);
    client.close();
  });
});

describe("local refusals: no frame goes out", () => {
  test("an empty blob is a `RangeError`", async () => {
    const h = host();
    const dial = new Dialer(h);
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const before = dial.frames.flat().length;
    await expect(client.upload(sessionId, new Uint8Array(0))).rejects.toBeInstanceOf(RangeError);
    expect(dial.frames.flat().length).toBe(before);
    client.close();
  });

  test("MAX_IMAGE_BYTES + 1 is a `RangeError`, with zero frames", async () => {
    const h = host();
    const dial = new Dialer(h);
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const before = dial.puts().length;
    await expect(
      client.upload(sessionId, new Uint8Array(MAX_IMAGE_BYTES + 1)),
    ).rejects.toBeInstanceOf(RangeError);
    expect(dial.puts().length).toBe(before);
    client.close();
  });
});

describe("abort", () => {
  test("an abort mid-upload rejects; a later upload resumes from what the store kept", async () => {
    const h = host();
    const dial = new Dialer(h);
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const bytes = blob(6 * CHUNK);
    const controller = new AbortController();
    // Abort once a couple of data chunks have gone out.
    dial.onDataPut = (n) => {
      if (n === 2) controller.abort();
    };
    await expect(
      client.upload(sessionId, bytes, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(UploadAbortedError);
    dial.onDataPut = null;
    // The daemon's partial survived: the next upload resumes, never restarts.
    const resumed = dial.puts().length;
    await client.upload(sessionId, bytes);
    const after = dial.puts().slice(resumed);
    const firstDataOffset = after.find((p) => p.data !== "")?.offset;
    expect(firstDataOffset).toBeGreaterThan(0);
    expect(await storedHex(h, sessionId, sha(bytes), bytes.length)).toBe(
      Buffer.from(bytes).toString("hex"),
    );
    client.close();
  });

  test("an already-aborted signal sends nothing", async () => {
    const h = host();
    const dial = new Dialer(h);
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const controller = new AbortController();
    controller.abort();
    const before = dial.puts().length;
    await expect(
      client.upload(sessionId, blob(CHUNK), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(UploadAbortedError);
    expect(dial.puts().length).toBe(before);
    client.close();
  });
});
