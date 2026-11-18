import { describe, expect, test } from "bun:test";
/**
 * `present` → the session's store → `artifact/list` / `artifact/read` through a
 * real `SessionHost` + `Connection` (docs/feat/model-artifacts.md D4, T3.7).
 *
 * The load-bearing property (the plan's assumption): a chunked read of a 3 MiB
 * version over the Noise channel pair reassembles to the announced sha256,
 * while a `session/enqueue` sent between chunk 3 and 4 is answered before the
 * last chunk — the daemon is not serialized behind a bulk read (AGENTS §7) — and
 * no RPC frame comes near the transport caps. Also: the live
 * `tool_call_update` carries the meta, the store is the SESSION's (P8: another
 * connection cannot read it), and a close returns every byte to the budget.
 */
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import {
  type ArtifactSink,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import {
  ATTACHMENT_CHUNK_BYTES,
  type ArtifactMeta,
  DomainErrorCode,
  Method,
  Notification,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ToolRegistry, presentTool } from "@tentacle/tools";
import { type DuplexChannel, RpcPeer, createChannelPair } from "@tentacle/transport";
import { noiseInitiator, noiseResponder, publicKeyOf } from "@tentacle/transport/noise";
import { ArtifactStore, Connection, SessionHost } from "../src/index.ts";

const CHUNK = ATTACHMENT_CHUNK_BYTES;
const SIZE = 3 * 1024 * 1024;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function blob(size: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = 11;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

const BYTES = blob(SIZE);

/** A workspace with ONE binary file, read through the confined-read seam. */
const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
  readConfinedBytes: async (path: string) => {
    if (path !== "out/data.bin") throw new Error(`no such file: ${path}`);
    return { bytes: BYTES, realPath: "/ws/out/data.bin" };
  },
} as unknown as ExecutionEnvironment;

/** Turn 1 presents the file, then ends; every later turn just ends. */
class Presenter implements ModelProvider {
  readonly id = "presenter";
  private turn = 0;
  async *stream(): AsyncIterable<StreamEvent> {
    const t = this.turn++;
    if (t === 0) {
      yield {
        type: "tool_call",
        toolCall: {
          id: "call-1",
          name: "present",
          arguments: JSON.stringify({ title: "Data", path: "out/data.bin", id: "data" }),
        },
      };
    }
    yield { type: "done" };
  }
}

function host(sinks: (ArtifactSink | undefined)[] = []): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/artifact-connection",
    createAgent: (_cwd, ctx) => {
      sinks.push(ctx.artifacts);
      return {
        agent: new Agent({
          model: new Presenter(),
          tools: new ToolRegistry().register(presentTool),
          env,
          ...(ctx.artifacts ? { artifacts: ctx.artifacts } : {}),
        }),
        permissions: ctx.reuse?.permissions ?? new PermissionBroker(),
        ...(ctx.reuse?.grants ? { grants: ctx.reuse.grants } : {}),
        settingsReport: { carried: {}, overridden: {} },
      };
    },
  });
}

interface Client {
  peer: RpcPeer;
  updates: { type: string; [k: string]: unknown }[];
  /** Longest RPC frame text the daemon sent, and longest raw (Noise) frame. */
  max: { rpc: number; raw: number };
}

const key = (n: number): Uint8Array => new Uint8Array(32).fill(n);
let seed = 1;
const rng = (n: number): Uint8Array => new Uint8Array(n).fill(seed++ & 0xff);

function measure(ch: DuplexChannel, onSend: (len: number) => void): DuplexChannel {
  return {
    send: (t) => {
      onSend(t.length);
      ch.send(t);
    },
    close: () => ch.close(),
    setOnMessage: (h) => ch.setOnMessage(h),
    setOnClose: (h) => ch.setOnClose(h),
  };
}

/** A client on `h`; `noise` wraps both ends in the E2E channel (the phone's path). */
async function connect(h: SessionHost, noise = false): Promise<Client> {
  const max = { rpc: 0, raw: 0 };
  const [rawD, rawC] = createChannelPair();
  let d: DuplexChannel = rawD;
  let c: DuplexChannel = rawC;
  if (noise) {
    [c, d] = await Promise.all([
      noiseInitiator(rawC, { staticKey: key(2), remoteStatic: publicKeyOf(key(1)), random: rng }),
      noiseResponder(
        measure(rawD, (n) => {
          max.raw = Math.max(max.raw, n);
        }),
        { staticKey: key(1), authorize: () => true, random: rng },
      ),
    ]);
  }
  new Connection(
    measure(d, (n) => {
      max.rpc = Math.max(max.rpc, n);
    }),
    h,
  );
  const updates: Client["updates"] = [];
  const peer = new RpcPeer(c, {
    onNotification: (method, params) => {
      if (method === Notification.SessionUpdate) {
        updates.push((params as { update: Client["updates"][number] }).update);
      }
    },
    onRequest: async (method) => {
      if (method === Method.HooksTrust) return { trusted: false };
      throw new Error(`unexpected request ${method}`);
    },
  });
  await peer.request(Method.Initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  return { peer, updates, max };
}

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function presentOnce(c: Client): Promise<ArtifactMeta> {
  await c.peer.request(Method.Open, { sessionId: "S", create: true });
  await c.peer.request(Method.Prompt, {
    sessionId: "S",
    turnId: "t1",
    content: [{ type: "text", text: "show me" }],
  });
  await settle();
  const { artifacts } = (await c.peer.request(Method.ArtifactList, { sessionId: "S" })) as {
    artifacts: ArtifactMeta[];
  };
  expect(artifacts.length).toBe(1);
  const meta = artifacts[0];
  if (!meta) throw new Error("no artifact listed");
  return meta;
}

async function errorOf(p: Promise<unknown>): Promise<{ code?: number; data?: unknown }> {
  try {
    await p;
  } catch (error) {
    return error as { code?: number; data?: unknown };
  }
  throw new Error("expected a rejection");
}

describe("present → artifact/list → artifact/read (T3.7, the load-bearing round trip)", () => {
  test("over the Noise pair: 12 chunks reassemble to the sha256; an enqueue sent behind in-flight reads is answered first", async () => {
    const h = host();
    const c = await connect(h, true);
    const meta = await presentOnce(c);
    expect(meta).toMatchObject({
      artifactId: "data",
      version: 1,
      size: SIZE,
      sha256: sha(BYTES),
      callId: "call-1",
      title: "Data",
      source: "out/data.bin",
      kind: "other",
    });

    // The exact property: a read still IN FLIGHT does not hold back a later
    // request. Every read from chunk 3 on waits until the enqueue (sent after
    // chunk 3) is answered — a daemon that serialized its requests would
    // deadlock here, whatever order the fast in-memory reads finish in.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realRead = ArtifactStore.prototype.read;
    ArtifactStore.prototype.read = async function (this: ArtifactStore, sha256, offset) {
      if (offset >= 3 * CHUNK) await gate;
      return realRead.call(this, sha256, offset);
    };
    const order: string[] = [];
    const out = new Uint8Array(SIZE);
    const pending: Promise<void>[] = [];
    const chunks = SIZE / CHUNK;
    try {
      for (let i = 0; i < chunks; i++) {
        if (i === 4) {
          // Answered or refused (no turn is running), either is an ANSWER.
          const answered = (): void => {
            order.push("enqueue");
            release();
          };
          pending.push(
            c.peer
              .request(Method.Enqueue, { sessionId: "S", id: "q1", turnId: "t2", text: "steer" })
              .then(answered, answered),
          );
        }
        pending.push(
          (
            c.peer.request(Method.ArtifactRead, {
              sessionId: "S",
              sha256: meta.sha256,
              offset: i * CHUNK,
            }) as Promise<{ data: string; size: number }>
          ).then((r) => {
            expect(r.size).toBe(SIZE);
            out.set(Buffer.from(r.data, "base64"), i * CHUNK);
            order.push(`chunk${i}`);
          }),
        );
      }
      const stalled = new Promise<"stalled">((resolve) =>
        setTimeout(() => resolve("stalled"), 2000),
      );
      expect(await Promise.race([Promise.all(pending).then(() => "done" as const), stalled])).toBe(
        "done",
      );
    } finally {
      ArtifactStore.prototype.read = realRead;
      release();
    }
    expect(order.indexOf("enqueue")).toBeLessThan(order.indexOf("chunk3"));
    expect(chunks).toBe(12);
    expect(sha(out)).toBe(meta.sha256);
    expect(order.indexOf("enqueue")).toBeLessThan(order.indexOf(`chunk${chunks - 1}`));
    expect(c.max.rpc).toBeLessThan(8 * 1024 * 1024);
    // The relay's per-frame cap (96 Ki chars) never sees an RPC frame whole.
    expect(c.max.raw).toBeLessThan(96 * 1024);
  });

  test("the live tool_call_update carries the meta (nested detail → the free `artifact` field)", async () => {
    const h = host();
    const c = await connect(h);
    const meta = await presentOnce(c);
    const update = c.updates.find(
      (u) => u.type === "tool_call_update" && u.toolCallId === "call-1",
    );
    expect(update?.status).toBe("completed");
    expect(update?.artifact).toEqual(meta);
  });
});

describe("the store is the session's (P8) and ends with it", () => {
  test("another connection that did not open the session cannot list or read it", async () => {
    const h = host();
    const owner = await connect(h);
    const meta = await presentOnce(owner);
    const other = await connect(h);
    expect((await errorOf(other.peer.request(Method.ArtifactList, { sessionId: "S" }))).code).toBe(
      DomainErrorCode.UnknownSession,
    );
    expect(
      (
        await errorOf(
          other.peer.request(Method.ArtifactRead, {
            sessionId: "S",
            sha256: meta.sha256,
            offset: 0,
          }),
        )
      ).code,
    ).toBe(DomainErrorCode.UnknownSession);
  });

  test("a sha this session never presented → ArtifactUnavailable{unknown}", async () => {
    const h = host();
    const c = await connect(h);
    await presentOnce(c);
    const err = await errorOf(
      c.peer.request(Method.ArtifactRead, { sessionId: "S", sha256: "f".repeat(64), offset: 0 }),
    );
    expect(err.code).toBe(DomainErrorCode.ArtifactUnavailable);
    expect(err.data).toEqual({ reason: "unknown" });
  });

  test("close returns every byte to the daemon's budget", async () => {
    const h = host();
    const c = await connect(h);
    await presentOnce(c);
    expect(h.artifactBytesUsed).toBe(SIZE);
    await c.peer.request(Method.Close, { sessionId: "S" });
    expect(h.artifactBytesUsed).toBe(0);
  });

  test("a settings sync rebuilds the agent on the SAME store", async () => {
    const sinks: (ArtifactSink | undefined)[] = [];
    const h = host(sinks);
    const c = await connect(h);
    await c.peer.request(Method.Open, { sessionId: "S", create: true });
    await c.peer.request(Method.UpdateSettings, { sessionId: "S", id: "u1", settings: {} });
    expect(sinks.length).toBe(2);
    expect(sinks[0]).toBeDefined();
    expect(sinks[1] === sinks[0]).toBe(true);
  });
});
