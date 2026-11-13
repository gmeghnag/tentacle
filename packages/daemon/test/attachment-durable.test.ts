/**
 * A `serve` session's image bytes survive a restart, an archive → reopen and a
 * `/clear` fork, and go with a delete (docs/feat/attachments-durable.md T4).
 *
 * Asserted where it matters — at the provider: the NEXT turn's
 * `ChatRequest.attachments.read(ref)` yields exactly the bytes of a ref the
 * restored history already carries (the repro's lines 1–3, on `serve`). Real
 * `SessionHost` + `SessionPersister` + `LogSessionStore` on a temp dir, driven
 * through a real `Connection`.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  type AttachmentRef,
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
} from "@tentacle/core";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import {
  Connection,
  LogSessionStore,
  SessionHost,
  SessionPersister,
} from "../src/index.ts";

const CWD = "/tmp/attachment-durable";
const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

const bytes = new TextEncoder().encode("a durable png");
const ref: AttachmentRef = {
  id: createHash("sha256").update(bytes).digest("hex"),
  mimeType: "image/png",
  size: bytes.length,
  name: "a.png",
};

class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<never> {
    this.requests.push(request);
    yield { type: "text", delta: "ok" } as never;
    yield { type: "done" } as never;
  }
}

function rigOn(dir: string) {
  const store = new LogSessionStore(dir);
  const errors: string[] = [];
  const persister = new SessionPersister({
    store,
    cwd: CWD,
    model: "m",
    onError: (e) => errors.push(e.message),
  });
  const model = new Recorder();
  const host = new SessionHost({
    defaultCwd: CWD,
    persister,
    images: { source: "store", maxBytes: 4 << 20 },
    createAgent: (_cwd, ctx) => ({
      agent: new Agent({
        model,
        tools: new ToolRegistry(),
        env: env as never,
        ...(ctx.attachments ? { attachments: ctx.attachments } : {}),
      }),
      permissions: ctx.reuse?.permissions ?? new PermissionBroker(),
      settingsReport: { carried: {}, overridden: {} },
    }),
  });
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const client = new RpcPeer(c, {
    onNotification: () => {},
    onRequest: async (method: string) => {
      if (method === Method.HooksTrust) return { trusted: false };
      throw new Error(`unexpected request ${method}`);
    },
  });
  const init = () =>
    client.request(Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
  const prompt = async (sessionId: string, turnId: string, content: unknown[]) => {
    await client.request(Method.Prompt, { sessionId, turnId, content });
    await new Promise((r) => setTimeout(r, 30));
  };
  /** What the provider's source yields for `ref` on the latest request. */
  const lastRead = async () => {
    const last = model.requests.at(-1);
    const got = await last?.attachments?.read(ref);
    return got ? Buffer.compare(got, bytes) === 0 : got;
  };
  return { store, persister, host, client, model, errors, init, prompt, lastRead };
}

/** Upload `bytes` into `sessionId` (one chunk), then send them in a prompt. */
async function uploadAndAsk(rig: ReturnType<typeof rigOn>, sessionId: string): Promise<void> {
  const ack = await rig.client.request(Method.AttachmentPut, {
    sessionId,
    id: ref.id,
    size: ref.size,
    offset: 0,
    data: Buffer.from(bytes).toString("base64"),
  });
  expect(ack).toEqual({ have: ref.size, complete: true });
  await rig.prompt(sessionId, "t1", [
    { type: "text", text: "what is this?" },
    { type: "attachment", ref },
  ]);
  expect(await rig.lastRead()).toBe(true);
}

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "attachment-durable-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("serve: image bytes are durable with the session (T4)", () => {
  test("the blob is on disk when the ack arrives, and the daemon memory budget is given back", async () => {
    await withDir(async (dir) => {
      const rig = rigOn(dir);
      await rig.init();
      await rig.client.request(Method.Open, { sessionId: "S", create: true });
      await uploadAndAsk(rig, "S");
      expect(await readdir(join(dir, "S.attachments"))).toEqual([ref.id]);
      expect(rig.host.uploadBytesUsed).toBe(0);
      await rig.persister.stop();
    });
  });

  test("restart: a new daemon on the same store resolves the ref of the reloaded history", async () => {
    await withDir(async (dir) => {
      const first = rigOn(dir);
      await first.init();
      await first.client.request(Method.Open, { sessionId: "S", create: true });
      await uploadAndAsk(first, "S");
      await first.host.get("S")?.persisted();
      await first.persister.stop();

      const second = rigOn(dir);
      await second.init();
      const loaded = await second.persister.load("S");
      if (!loaded.ok) throw new Error(loaded.reason);
      expect(JSON.stringify(loaded.record.messages)).toContain(ref.id);
      second.host.restore(loaded.record);
      await second.client.request(Method.Open, { sessionId: "S" });
      await second.prompt("S", "t2", [{ type: "text", text: "again" }]);
      const last = second.model.requests.at(-1);
      expect(JSON.stringify(last?.messages)).toContain(ref.id);
      expect(await second.lastRead()).toBe(true);
      // Never sent a byte to this daemon.
      expect(second.host.uploadBytesUsed).toBe(0);
      await second.persister.stop();
    });
  });

  test("archive → reopen: the archived session's blobs stay and resolve on reopen", async () => {
    await withDir(async (dir) => {
      const rig = rigOn(dir);
      await rig.init();
      await rig.client.request(Method.Open, { sessionId: "S", create: true });
      await uploadAndAsk(rig, "S");
      expect(rig.host.close("S")).toBe(true);
      await rig.persister.flush("S");
      await rig.store.drain();
      expect(rig.host.get("S")).toBeUndefined();
      expect(await readdir(join(dir, "S.attachments"))).toEqual([ref.id]);
      await rig.client.request(Method.Open, { sessionId: "S", reopen: true });
      await rig.prompt("S", "t2", [{ type: "text", text: "again" }]);
      expect(await rig.lastRead()).toBe(true);
      await rig.persister.stop();
    });
  });

  test("/clear fork: the archived fork reopens with its images, and keeps them when the source is deleted", async () => {
    await withDir(async (dir) => {
      const rig = rigOn(dir);
      await rig.init();
      await rig.client.request(Method.Open, { sessionId: "S", create: true });
      await uploadAndAsk(rig, "S");
      const hosted = rig.host.get("S");
      if (!hosted) throw new Error("no session");
      await hosted.persisted();
      hosted.clear();
      await hosted.persisted();
      await rig.persister.flush("S");
      await rig.store.drain();
      const forkId = rig.host.list({}).sessions.find((s) => s.sessionId !== "S")?.sessionId ?? "";
      expect(forkId).not.toBe("");
      expect(await readdir(join(dir, `${forkId}.attachments`))).toEqual([ref.id]);
      await rig.client.request(Method.SessionDelete, { sessionId: "S" });
      await rig.store.drain();
      expect(await readdir(dir)).not.toContain("S.attachments");
      await rig.client.request(Method.Open, { sessionId: forkId, reopen: true });
      await rig.prompt(forkId, "t2", [{ type: "text", text: "again" }]);
      expect(JSON.stringify(rig.model.requests.at(-1)?.messages)).toContain(ref.id);
      expect(await rig.lastRead()).toBe(true);
      await rig.persister.stop();
    });
  });

  test("session/delete removes the session's blob dir with its log", async () => {
    await withDir(async (dir) => {
      const rig = rigOn(dir);
      await rig.init();
      await rig.client.request(Method.Open, { sessionId: "S", create: true });
      await uploadAndAsk(rig, "S");
      await rig.host.get("S")?.persisted();
      expect(await readdir(dir)).toContain("S.attachments");
      await rig.client.request(Method.SessionDelete, { sessionId: "S" });
      await rig.store.drain();
      const left = await readdir(dir);
      expect(left.filter((f) => f.startsWith("S."))).toEqual([]);
      await rig.persister.stop();
    });
  });
});
