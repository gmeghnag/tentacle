import { describe, expect, test } from "bun:test";
/**
 * `RemoteClient.upload()` over a real daemon `Connection`
 * (docs/feat/attachments-upload.md T5).
 *
 * The property: a blob reaches the daemon store complete and byte-identical in
 * a bounded number of frames, at most 2 puts at a time; a drop
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
import {
  AttachmentsUnsupportedError,
  type Clock,
  RemoteClient,
  UploadAbortedError,
} from "../src/index.ts";
import { UploadLinkLostError, UploadProtocolError } from "../src/upload-window.ts";

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

/** Timers a test fires by hand, so a bounded wait is provable without real time. */
function manualClock(): { clock: Clock; advance: (ms: number) => void } {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number): void => {
    now += ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].fn();
    }
  };
  return { clock, advance };
}

/**
 * A circuit breaker for a client that would otherwise retry with no I/O at all
 * (review finding 1: a synchronous microtask spin). Past `limit`
 * `attachment/put` attempts it trips — `upload()` re-reads the caller's signal
 * synchronously at the top of each iteration, so a spinning loop ENDS and the
 * test fails on its assertion instead of hanging the runner. (Bun's per-test
 * timeout cannot fire while microtasks never yield: measured, it does not.)
 */
function breaker(limit: number, trip: () => void): { restore: () => void; count: () => number } {
  const proto = RpcPeer.prototype;
  const real = proto.request;
  let attempts = 0;
  proto.request = function (this: RpcPeer, ...args: Parameters<typeof real>) {
    if (args[0] === Method.AttachmentPut) {
      attempts += 1;
      if (attempts > limit) trip();
    }
    return real.apply(this, args);
  };
  return {
    restore: () => {
      proto.request = real;
    },
    count: () => attempts,
  };
}

/**
 * A daemon that answers `initialize` / `open` / `put` with no session
 * bookkeeping, so a client can upload to a session id it never opened (the
 * link-loss paths below).
 */
function fakeUploadDaemon(link: DuplexChannel, onDataPut?: (n: number) => void): void {
  let dataPuts = 0;
  new RpcPeer(link, {
    onRequest: async (method, params) => {
      if (method === Method.Initialize) {
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, daemonKind: "serve" };
      }
      if (method === Method.Open) {
        return {
          sessionId: "S",
          epoch: "e0",
          created: true,
          resync: false,
          messages: [],
          title: { source: "auto" },
        };
      }
      if (method === Method.AttachmentPut) {
        const chunk = params as { offset: number; data: string; size: number };
        if (chunk.data === "") return { have: 0, complete: false };
        dataPuts += 1;
        onDataPut?.(dataPuts);
        const end = chunk.offset + Buffer.from(chunk.data, "base64").length;
        return { have: end, complete: end === chunk.size };
      }
      return {};
    },
  });
}

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
    // The real concurrency, measured on the wire: at most TWO puts written and
    // unanswered at any moment, and never more than one per chunk (nothing was
    // resent). The literal 2 is deliberate — comparing against the imported
    // `UPLOAD_WINDOW` moved with the code under test (review finding 2: it
    // stayed green with the window set to 4).
    expect(dial.peak.value).toBeLessThanOrEqual(2);
    // …and the window is really TWO, not one: 5 chunks would still be 1-deep
    // serial. A vacuous `<= 2` would also pass on a window of 1.
    expect(dial.peak.value).toBe(2);
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

describe("a dead link ends the upload — it never spins", () => {
  // Review finding 1. On a client with no `channelFactory` the link is gone for
  // good: `stop()` sets `up = false` permanently, so a retry can only re-run a
  // closed peer's `Promise.reject("peer is closed")` — a pure microtask loop
  // that starves timers and never settles. Each test below is bounded: the
  // breaker trips the caller's signal, which `upload()` reads synchronously, so
  // the WRONG behaviour fails an assertion here instead of hanging.
  test("no `channelFactory`: a link dropped mid-upload rejects, promptly", async () => {
    const [d, c] = createChannelPair();
    fakeUploadDaemon(d, (n) => {
      if (n === 1) c.close(); // drop before the 2nd data chunk leaves
    });
    const client = new RemoteClient(c, new PermissionBroker());
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const controller = new AbortController();
    const guard = breaker(200, () => controller.abort());
    const started = Date.now();
    let outcome: unknown;
    try {
      outcome = await client.upload(sessionId, blob(4 * CHUNK), { signal: controller.signal }).then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
    } finally {
      guard.restore();
    }
    // Assertions first, breaker second: on the buggy code the loop ends via the
    // trip, and the failure names the property.
    expect(guard.count()).toBeLessThan(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome).toBeInstanceOf(UploadLinkLostError);
    expect(String(outcome)).toMatch(/connection closed|link is gone|reconnect/);
    expect(controller.signal.aborted).toBe(false); // it settled on its own
    client.close();
  });

  test("no `channelFactory`, no session of ours either: rejects at once, zero puts", async () => {
    const [d, c] = createChannelPair();
    fakeUploadDaemon(d);
    const client = new RemoteClient(c, new PermissionBroker());
    await client.initialize();
    // A session id this client never opened: `entry` is undefined, so no
    // `session/open` could ever be replayed for it — there is nothing to wait
    // for, and the call must fail on the first closed-peer rejection.
    const controller = new AbortController();
    const guard = breaker(200, () => controller.abort());
    c.close();
    await tick(5); // let the close reach the client
    let outcome: unknown;
    try {
      outcome = await client
        .upload("never-opened", blob(CHUNK), {
          signal: controller.signal,
        })
        .then(
          () => "resolved" as const,
          (error: unknown) => error,
        );
    } finally {
      guard.restore();
    }
    // One attempt (the probe), not a retry loop: the link is gone for good.
    expect(guard.count()).toBe(1);
    expect(outcome).toBeInstanceOf(UploadLinkLostError);
    expect(controller.signal.aborted).toBe(false);
    client.close();
  });

  test("a factory that cannot reconnect at all: rejects, bounded, never spins", async () => {
    const h = host();
    const dial = new Dialer(h);
    const { clock, advance } = manualClock();
    let opens = 0;
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => {
        opens += 1;
        throw new Error("no route to the daemon");
      },
      clock,
      // A real backoff (not 0): the redial timer must not be able to fire in a
      // tight loop, or the test's own clock would never reach the deadline.
      random: () => 0.5,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const controller = new AbortController();
    // Two independent bounds, because a wrong implementation HANGS rather
    // than fails (a hang is not a red test, AGENTS §9): the breaker trips on
    // a spin, this real timer trips on a wait that never ends.
    const guard = breaker(500, () => controller.abort());
    const backstop = setTimeout(() => controller.abort(), 2_000);
    dial.onDataPut = (n) => {
      if (n === 1) dial.last?.close();
    };
    let outcome: unknown;
    try {
      const upload = client
        .upload(sessionId, blob(4 * CHUNK), {
          signal: controller.signal,
        })
        .then(
          (value) => value,
          (error: unknown) => error,
        );
      // Drive the injected clock past the bound, letting each failed redial run.
      for (let i = 0; i < 40; i++) {
        advance(2_000);
        await tick(0);
      }
      outcome = await upload;
    } finally {
      clearTimeout(backstop);
      dial.onDataPut = null;
      guard.restore();
    }
    expect(guard.count()).toBeLessThan(500);
    expect(controller.signal.aborted).toBe(false); // it settled on its own deadline
    expect(outcome).toBeInstanceOf(UploadLinkLostError);
    expect(String(outcome)).toMatch(/did not come back|30s/);
    expect(opens).toBeGreaterThan(0); // it really tried to reconnect
    client.close();
  }, 20_000);

  test("an abort while the link is down ends the upload at once", async () => {
    // The wait for a reconnect must not swallow the caller's abort: the user
    // cancels, so nothing more is sent and the partial stays for a later retry.
    const h = host();
    const dial = new Dialer(h);
    const { clock, advance } = manualClock();
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => {
        throw new Error("no route to the daemon");
      },
      clock,
      random: () => 0.5,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const controller = new AbortController();
    dial.onDataPut = (n) => {
      if (n === 1) dial.last?.close(); // the link drops mid-upload
    };
    const upload = client.upload(sessionId, blob(4 * CHUNK), { signal: controller.signal }).then(
      (value) => value,
      (error: unknown) => error,
    );
    // Let the drop and a failed redial land (the fake clock, so no real wait).
    for (let i = 0; i < 5; i++) {
      advance(600);
      await tick(0);
    }
    dial.onDataPut = null;
    // The link is down and the redial keeps failing: now the caller aborts.
    controller.abort();
    // A fake clock hides real time: give the abort a couple of turns to land.
    for (let i = 0; i < 5; i++) {
      advance(1);
      await tick(0);
    }
    const outcome = await Promise.race([upload, tick(1_000).then(() => "still waiting" as const)]);
    expect(outcome).toBeInstanceOf(UploadAbortedError);
    client.close();
  });

  test("a factory, but a session this client never opened: rejects, bounded", async () => {
    // Review finding 1's second half: with a factory but no `entry`, nothing can
    // replay a `session/open`, so `liveGeneration` returns the current
    // generation at once and a retry re-runs a closing peer — the same spin,
    // this time starving the redial timer so the link never comes back.
    const [d, c] = createChannelPair();
    let links = 0;
    const opens: string[] = [];
    const daemon = (link: DuplexChannel): void => {
      new RpcPeer(link, {
        onRequest: async (method, params) => {
          if (method === Method.Initialize) {
            return {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: {},
              daemonKind: "serve",
            };
          }
          if (method === Method.Open) {
            opens.push(String((params as { sessionId?: string }).sessionId));
            return {
              sessionId: String((params as { sessionId?: string }).sessionId),
              epoch: "e0",
              created: true,
              resync: false,
            };
          }
          if (method === Method.AttachmentPut) {
            const chunk = params as { offset: number; data: string; size: number };
            if (chunk.data === "") return { have: 0, complete: false };
            if (chunk.offset > 0) c.close(); // drop on the 2nd data chunk
            return { have: chunk.offset, complete: false };
          }
          return {};
        },
      });
    };
    daemon(d);
    const client = new RemoteClient(c, new PermissionBroker(), undefined, {
      channelFactory: async () => {
        links += 1;
        const [nd, nc] = createChannelPair();
        daemon(nd);
        return nc;
      },
      random: () => 0.5,
    });
    await client.initialize();
    // A session id this client holds no entry for (`entry === undefined`): it
    // never opened it, so nothing could replay an open for it on a new link.
    await client.openSession(undefined, undefined, "S");
    const controller = new AbortController();
    const guard = breaker(300, () => controller.abort());
    let outcome: unknown;
    try {
      outcome = await client
        .upload("other", blob(4 * CHUNK), {
          signal: controller.signal,
        })
        .then(
          () => "resolved" as const,
          (error: unknown) => error,
        );
    } finally {
      guard.restore();
    }
    // Bounded and never a loop: the probe + the first data chunk + the one that
    // found the link dead is the whole attempt (no retry — nothing to replay).
    expect(outcome).toBeInstanceOf(UploadLinkLostError);
    expect(guard.count()).toBe(3);
    expect(controller.signal.aborted).toBe(false);
    expect(links).toBe(0); // no redial was needed, let alone a spin
    client.close();
    void opens;
  });

  test("with a reconnect that works, a drop is resumed, not failed", async () => {
    // The complement: the fix must not turn a recoverable drop into a rejection.
    const h = host();
    const dial = new Dialer(h);
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
      random: () => 0,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const bytes = blob(4 * CHUNK);
    dial.onDataPut = (n) => {
      if (n === 1) dial.last?.close();
    };
    expect(await client.upload(sessionId, bytes)).toEqual({ id: sha(bytes), size: bytes.length });
    dial.onDataPut = null;
    expect(await storedHex(h, sessionId, sha(bytes), bytes.length)).toBe(
      Buffer.from(bytes).toString("hex"),
    );
    client.close();
  });
});
