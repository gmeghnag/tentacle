import { describe, expect, test } from "bun:test";
/**
 * `RemoteClient.listArtifacts` / `readArtifact` (docs/feat/model-artifacts.md
 * D6, T5) over a real daemon `Connection`, and over fake daemons that lie.
 *
 * The property: the client returns an artifact's bytes ONLY when they are the
 * ones the meta announced (every chunk's length, the daemon's `size`, the whole
 * sha256) — a pod is not trusted (AGENTS §7); a drop resumes at the first
 * missing chunk without re-reading held ones; an abort stops issuing reads;
 * an older daemon is a typed `ArtifactsUnsupportedError`.
 */
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import { type ExecutionEnvironment, type ModelProvider, PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost, type SessionHost as SessionHostType } from "@tentacle/daemon";
import {
  ATTACHMENT_CHUNK_BYTES,
  type ArtifactMeta,
  DomainErrorCode,
  JsonRpcErrorCode,
  MAX_ARTIFACT_BYTES,
  Method,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import {
  type DuplexChannel,
  RpcError,
  RpcPeer,
  createChannelPair,
  encodeBase64,
} from "@tentacle/transport";
import {
  ArtifactCorruptError,
  ArtifactReadAbortedError,
  ArtifactsUnsupportedError,
  RemoteClient,
} from "../src/index.ts";

const CHUNK = ATTACHMENT_CHUNK_BYTES;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

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
    defaultCwd: "/tmp/artifacts",
    createAgent: () => ({
      agent: new Agent({ model: new Idle(), tools: {} as never, env }),
      permissions: new PermissionBroker(),
    }),
  });
}

function blob(size: number, seed = 3): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

/** Present `bytes` into session `sessionId`'s store, daemon-side. */
async function present(h: SessionHostType, sessionId: string, bytes: Uint8Array) {
  const store = h.get(sessionId)?.artifacts;
  if (!store) throw new Error("no session");
  return store.present({
    title: "data.bin",
    bytes,
    mimeType: "application/octet-stream",
    kind: "other",
    callId: "call-1",
  });
}

/** A dial target onto ONE host that logs every outbound `artifact/read` offset per link. */
class Dialer {
  readonly reads: number[][] = [];
  last: DuplexChannel | null = null;
  calls = 0;
  /** Called as the n-th `artifact/read` answer (all links) reaches the client, before it is handled. */
  onAnswer: ((n: number) => void) | null = null;
  /** Called right AFTER the n-th answer was handed to the client. */
  afterAnswer: ((n: number) => void) | null = null;
  private answers = 0;
  constructor(readonly host: SessionHostType) {}
  connect(): DuplexChannel {
    const [d, c] = createChannelPair();
    new Connection(d, this.host);
    const log: number[] = [];
    this.reads.push(log);
    const readIds = new Set<string>();
    const tapped: DuplexChannel = {
      send: (data) => {
        const frame = JSON.parse(data) as {
          id?: string;
          method?: string;
          params?: { offset?: number };
        };
        if (frame.method === Method.ArtifactRead) {
          log.push(Number(frame.params?.offset));
          if (frame.id !== undefined) readIds.add(frame.id);
        }
        c.send(data);
      },
      close: () => c.close(),
      setOnMessage: (handler) =>
        c.setOnMessage((data) => {
          const frame = JSON.parse(data) as { id?: string };
          const isRead = frame.id !== undefined && readIds.delete(frame.id);
          if (isRead) {
            this.answers += 1;
            this.onAnswer?.(this.answers);
          }
          handler(data);
          if (isRead) this.afterAnswer?.(this.answers);
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
  all(): number[] {
    return this.reads.flat();
  }
}

/** A client on a plain link to `h`, handshaken, with session "S" open. */
async function connected(h: SessionHostType): Promise<{ client: RemoteClient; sessionId: string }> {
  const [d, c] = createChannelPair();
  new Connection(d, h);
  const client = new RemoteClient(c, new PermissionBroker());
  await client.initialize();
  const sessionId = await client.openSession(undefined, undefined, "S");
  return { client, sessionId };
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("a real daemon's artifact reaches the client verified", () => {
  test("list → the meta; read → the exact bytes (3 chunks + 1 byte), progress to size", async () => {
    const h = host();
    const { client, sessionId } = await connected(h);
    const bytes = blob(3 * CHUNK + 1);
    const meta = await present(h, sessionId, bytes);
    const listed = await client.listArtifacts(sessionId);
    expect(listed.artifacts).toEqual([meta]);
    const seen: number[] = [];
    const got = await client.readArtifact(sessionId, meta, {
      onProgress: (have) => seen.push(have),
    });
    expect(sha(got)).toBe(sha(bytes));
    expect(got.length).toBe(bytes.length);
    expect(seen.at(-1)).toBe(bytes.length);
    client.close();
  });

  test("two reads of the same version at once both get it (content-addressed, idempotent)", async () => {
    const h = host();
    const { client, sessionId } = await connected(h);
    const meta = await present(h, sessionId, blob(2 * CHUNK + 5, 9));
    const [a, b] = await Promise.all([
      client.readArtifact(sessionId, meta),
      client.readArtifact(sessionId, meta),
    ]);
    expect(sha(a)).toBe(meta.sha256);
    expect(sha(b)).toBe(meta.sha256);
    client.close();
  });

  test("a version the store does not hold → the daemon's ArtifactUnavailable, as is", async () => {
    const h = host();
    const { client, sessionId } = await connected(h);
    const meta = await present(h, sessionId, blob(10));
    const ghost: ArtifactMeta = { ...meta, sha256: "0".repeat(64) };
    const error = await client.readArtifact(sessionId, ghost).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error instanceof RpcError ? error.code : 0).toBe(DomainErrorCode.ArtifactUnavailable);
    client.close();
  });
});

describe("a drop and an abort", () => {
  test("a link drop after chunk 2 resumes at chunk 3: chunks 0–2 are read exactly once", async () => {
    const h = host();
    const dial = new Dialer(h);
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
      random: () => 0,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const meta = await present(h, sessionId, blob(6 * CHUNK + 7));
    // The 3rd answer (chunk 2: at window 2 answers come in order) is handed
    // over, then the link dies with chunk 3 in flight.
    dial.afterAnswer = (n) => {
      if (n === 3) dial.last?.close();
    };
    const got = await client.readArtifact(sessionId, meta);
    dial.afterAnswer = null;
    expect(sha(got)).toBe(meta.sha256);
    expect(dial.calls).toBeGreaterThan(0); // it really reconnected
    const all = dial.all();
    for (const held of [0, CHUNK, 2 * CHUNK]) {
      expect(all.filter((o) => o === held).length).toBe(1);
    }
    // After the drop, the first read on the new link is chunk 3, never 0.
    const later = dial.reads.slice(1).flat();
    expect(later[0]).toBe(3 * CHUNK);
    expect(later).not.toContain(0);
    client.close();
  });

  test("an abort mid-read rejects and issues no further read", async () => {
    const h = host();
    const dial = new Dialer(h);
    const client = new RemoteClient(dial.connect(), new PermissionBroker(), undefined, {
      channelFactory: dial.factory,
    });
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const meta = await present(h, sessionId, blob(6 * CHUNK));
    const ac = new AbortController();
    let issuedAtAbort = -1;
    dial.onAnswer = (n) => {
      if (n === 1) {
        ac.abort();
        issuedAtAbort = dial.all().length;
      }
    };
    const error = await client
      .readArtifact(sessionId, meta, { signal: ac.signal })
      .catch((e: unknown) => e);
    await tick(20);
    expect(error).toBeInstanceOf(ArtifactReadAbortedError);
    expect(issuedAtAbort).toBe(2); // the window was full when it aborted
    expect(dial.all().length).toBe(issuedAtAbort);
    client.close();
  });

  test("an already-aborted signal sends nothing", async () => {
    const h = host();
    const dial = new Dialer(h);
    const client = new RemoteClient(dial.connect(), new PermissionBroker());
    await client.initialize();
    const sessionId = await client.openSession(undefined, undefined, "S");
    const meta = await present(h, sessionId, blob(CHUNK));
    const ac = new AbortController();
    ac.abort();
    const error = await client
      .readArtifact(sessionId, meta, { signal: ac.signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArtifactReadAbortedError);
    expect(dial.all().length).toBe(0);
    client.close();
  });
});

const BYTES = blob(2 * CHUNK + 3, 21);
const META: ArtifactMeta = {
  artifactId: "a1",
  version: 1,
  sha256: sha(BYTES),
  size: BYTES.length,
  mimeType: "application/octet-stream",
  kind: "other",
  title: "data.bin",
  callId: "call-1",
  createdAt: 0,
};

/** The honest answer for `offset` (a hostile daemon bends it). */
const honest = (offset: number) => ({
  data: encodeBase64(BYTES.subarray(offset, Math.min(offset + CHUNK, BYTES.length))),
  size: BYTES.length,
});

/** A daemon that answers the handshake and `artifact/*` through `read` / `list`. */
async function fakeClient(opts: {
  read?: (offset: number) => unknown;
  list?: () => unknown;
}): Promise<{ client: RemoteClient; reads: number[] }> {
  const [a, b] = createChannelPair();
  const reads: number[] = [];
  new RpcPeer(b, {
    onRequest: async (method, params) => {
      if (method === Method.Initialize) {
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, daemonKind: "serve" };
      }
      if (method === Method.ArtifactRead) {
        const offset = (params as { offset: number }).offset;
        reads.push(offset);
        return (opts.read ?? honest)(offset);
      }
      if (method === Method.ArtifactList) {
        return (opts.list ?? (() => ({ artifacts: [META] })))();
      }
      return {};
    },
  });
  const client = new RemoteClient(a, new PermissionBroker());
  await client.initialize();
  return { client, reads };
}

describe("a hostile daemon cannot hand over other bytes (a pod is not trusted)", () => {
  test("the honest fake is accepted (non-vacuity of the cases below)", async () => {
    const { client } = await fakeClient({});
    expect(sha(await client.readArtifact("S", META))).toBe(META.sha256);
    client.close();
  });

  test("a short chunk → ArtifactCorruptError, not retried", async () => {
    const { client, reads } = await fakeClient({
      read: (offset) => ({
        ...honest(offset),
        data: encodeBase64(BYTES.subarray(offset, offset + 10)),
      }),
    });
    await expect(client.readArtifact("S", META)).rejects.toBeInstanceOf(ArtifactCorruptError);
    await tick();
    expect(reads.length).toBeLessThanOrEqual(2);
    client.close();
  });

  test("right lengths, wrong bytes → ArtifactCorruptError", async () => {
    const { client } = await fakeClient({
      read: (offset) => {
        const chunk = BYTES.slice(offset, Math.min(offset + CHUNK, BYTES.length));
        chunk[0] = (chunk[0] ?? 0) ^ 0xff;
        return { data: encodeBase64(chunk), size: BYTES.length };
      },
    });
    await expect(client.readArtifact("S", META)).rejects.toBeInstanceOf(ArtifactCorruptError);
    client.close();
  });

  test("another `size` than the meta's → ArtifactCorruptError (even a smaller, 'valid' one)", async () => {
    const { client } = await fakeClient({ read: (offset) => ({ ...honest(offset), size: 5 }) });
    await expect(client.readArtifact("S", META)).rejects.toBeInstanceOf(ArtifactCorruptError);
    client.close();
  });

  test("a 2 GiB `size` in the reply fails the wire schema: rejected, nothing sized from it", async () => {
    const { client } = await fakeClient({
      read: (offset) => ({ ...honest(offset), size: 2 * 1024 * 1024 * 1024 }),
    });
    const error = await client.readArtifact("S", META).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    client.close();
  });

  test("a meta over MAX_ARTIFACT_BYTES (a caller's, unparsed) → RangeError, zero reads", async () => {
    const { client, reads } = await fakeClient({});
    const huge = { ...META, size: MAX_ARTIFACT_BYTES + 1 };
    await expect(client.readArtifact("S", huge)).rejects.toBeInstanceOf(RangeError);
    expect(reads.length).toBe(0);
    client.close();
  });
});

describe("an older daemon", () => {
  const notFound = (): never => {
    throw new RpcError(JsonRpcErrorCode.MethodNotFound, "unknown method");
  };

  test("`artifact/list` → MethodNotFound → ArtifactsUnsupportedError", async () => {
    const { client } = await fakeClient({ list: notFound });
    await expect(client.listArtifacts("S")).rejects.toBeInstanceOf(ArtifactsUnsupportedError);
    client.close();
  });

  test("`artifact/read` → MethodNotFound → ArtifactsUnsupportedError", async () => {
    const { client } = await fakeClient({ read: notFound });
    await expect(client.readArtifact("S", META)).rejects.toBeInstanceOf(ArtifactsUnsupportedError);
    client.close();
  });

  test("`truncated` is passed through, never dropped", async () => {
    const { client } = await fakeClient({ list: () => ({ artifacts: [META], truncated: true }) });
    expect(await client.listArtifacts("S")).toEqual({ artifacts: [META], truncated: true });
    client.close();
  });
});
