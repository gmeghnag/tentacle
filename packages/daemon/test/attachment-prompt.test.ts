/**
 * An image ref in `session/prompt` (docs/feat/attachments-prompt.md T4).
 *
 * The property proved here is NOT "the schema accepts an attachment block": it
 * is that a ref named by a prompt reaches the provider TOGETHER WITH a source
 * that yields exactly its bytes (`hosted.uploads`), that the history and the
 * log carry the ref, and that every way it can be wrong is refused — with a
 * structured reason — BEFORE anything is recorded (no turn, no log entry), the
 * same `turnId` still usable afterwards.
 *
 * Driven through a real `Connection`, like `attachment-put.test.ts`: the wire,
 * the daemon's parse and the host are all in the path.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import {
  type AttachmentRef,
  type AttachmentSource,
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
} from "@tentacle/core";
import { DomainErrorCode, Method, Notification, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection, type ImagePolicy, SessionHost } from "../src/index.ts";

const CHUNK = 256 * 1024;

const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const bytesFor = (text: string): Uint8Array => new TextEncoder().encode(text);
const refFor = (text: string, over: Partial<AttachmentRef> = {}): AttachmentRef => {
  const bytes = bytesFor(text);
  return { id: sha(bytes), mimeType: "image/png", size: bytes.length, ...over };
};

/** A provider that records every request it is handed and answers at once. */
class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<never> {
    this.requests.push(request);
    yield { type: "text", delta: "ok" } as never;
    yield { type: "done" } as never;
  }
}

/** Every ref whose bytes the provider could have read, in order. */
type Seen = { request: ChatRequest; source: AttachmentSource | undefined };

interface Harness {
  readonly host: SessionHost;
  readonly client: RpcPeer;
  readonly model: Recorder;
  /** What the factory was given as `AgentContext.attachments`, per build. */
  readonly sources: (AttachmentSource | undefined)[];
  readonly frames: { method?: string; params?: Record<string, unknown> }[];
  /** Every `session/update` payload the daemon sent, in order. */
  readonly updates: { type: string; [k: string]: unknown }[];
}

function harness(policy?: ImagePolicy): Harness {
  const model = new Recorder();
  const sources: (AttachmentSource | undefined)[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/attachment-prompt",
    ...(policy ? { images: policy } : {}),
    createAgent: (_cwd, ctx) => {
      sources.push(ctx.attachments);
      // A settings sync hands the session's broker, jobs and approvals back:
      // reusing them is what makes the swap legal.
      return {
        agent: new Agent({
          model,
          tools: new ToolRegistry(),
          env: env as never,
          ...(ctx.attachments ? { attachments: ctx.attachments } : {}),
        }),
        permissions: ctx.reuse?.permissions ?? new PermissionBroker(),
        ...(ctx.reuse?.jobs ? { jobs: ctx.reuse.jobs } : {}),
        ...(ctx.reuse?.grants ? { grants: ctx.reuse.grants } : {}),
        // A settings sync must report, or `updateSettings` retires it.
        settingsReport: { carried: {}, overridden: {} },
      };
    },
  });
  const [d, c] = createChannelPair();
  new Connection(d, host);
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
  const updates: { type: string; [k: string]: unknown }[] = [];
  const client = new RpcPeer(tap, {
    onNotification: (method, params) => {
      if (method === Notification.SessionUpdate) {
        const u = (params as { update: { type: string } }).update;
        updates.push(u as never);
      }
    },
    onRequest: async (method: string) => {
      if (method === Method.HooksTrust) return { trusted: false };
      throw new Error(`unexpected request ${method}`);
    },
  });
  return { host, client, model, sources, frames, updates };
}

async function ready(h: Harness, sessionId = "S"): Promise<void> {
  await h.client.request(Method.Initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  await h.client.request(Method.Open, { sessionId, create: true });
}

/** Upload `bytes` in chunks through `attachment/put`, the way a client does. */
async function put(h: Harness, bytes: Uint8Array, sessionId = "S"): Promise<void> {
  const id = sha(bytes);
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    await h.client.request(Method.AttachmentPut, {
      sessionId,
      id,
      size: bytes.length,
      offset,
      data: b64(bytes.subarray(offset, offset + CHUNK)),
    });
  }
}

const prompt = (h: Harness, turnId: string, content: unknown[], skill?: string): Promise<unknown> =>
  h.client.request(Method.Prompt, {
    sessionId: "S",
    turnId,
    content,
    ...(skill !== undefined ? { skill } : {}),
  });

/** The structured refusal a prompt threw: its code and `data.reason`. */
async function refusalOf(
  p: Promise<unknown>,
): Promise<{ code: number; reason: string | undefined }> {
  try {
    await p;
  } catch (error) {
    const e = error as { code?: number; data?: { reason?: string } };
    return { code: e.code ?? -1, reason: e.data?.reason };
  }
  throw new Error("expected a refusal");
}

/** Let a turn run out: its update frames arrive asynchronously. */
const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const storePolicy = (maxBytes = 4 * 1024 * 1024): ImagePolicy => ({ source: "store", maxBytes });

describe("store policy: the daemon holds the bytes", () => {
  test("a ref reaches the provider with hosted.uploads yielding exactly its bytes", async () => {
    const h = harness(storePolicy());
    await ready(h);
    const text = "a png";
    const bytes = bytesFor(text);
    const ref = refFor(text);
    await put(h, bytes);

    await prompt(h, "t1", [
      { type: "text", text: "what is this?" },
      { type: "attachment", ref },
    ]);
    await settle();

    const hosted = h.host.get("S");
    if (!hosted) throw new Error("no hosted session");
    expect(h.sources).toEqual([hosted.uploads]);
    expect(h.model.requests).toHaveLength(1);
    const seen = h.model.requests[0];
    if (!seen) throw new Error("no request");
    expect(seen.attachments).toBe(hosted.uploads);
    expect(await seen.attachments?.read(ref)).toEqual(bytes);
    // The message itself carries the ref (the provider resolves it, not the wire).
    expect(seen.messages.at(-1)).toEqual({
      role: "user",
      content: "what is this?",
      attachments: [ref],
    });
  });

  test("an image-only prompt runs a turn (text stays empty)", async () => {
    const h = harness(storePolicy());
    await ready(h);
    const bytes = bytesFor("only");
    await put(h, bytes);
    await prompt(h, "t1", [{ type: "attachment", ref: refFor("only") }]);
    await settle();
    expect(h.model.requests).toHaveLength(1);
    expect(h.model.requests[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: "",
      attachments: [refFor("only")],
    });
  });

  test("a skill with an image-only prompt is an unknown skill, as before", async () => {
    const h = harness(storePolicy());
    await ready(h);
    await put(h, bytesFor("s"));
    const failed = prompt(h, "t1", [{ type: "attachment", ref: refFor("s") }], "no-such-skill");
    expect(await refusalOf(failed)).toEqual({ code: -32602, reason: undefined });
  });

  test("the history and the log carry the ref as a media_message", async () => {
    const h = harness(storePolicy());
    await ready(h);
    const bytes = bytesFor("logged");
    const ref = refFor("logged");
    await put(h, bytes);
    await prompt(h, "t1", [
      { type: "text", text: "hi" },
      { type: "attachment", ref },
    ]);
    await settle(60);
    const log = (await h.client.request(Method.Log, { sessionId: "S" })) as {
      entries: { type: string }[];
    };
    expect(log.entries.map((e) => e.type)).toContain("media_message");
  });
});

describe("store policy: refusals record nothing and leave the turnId free", () => {
  /** A refusal must leave the session exactly as it was: no turn, no log entry. */
  async function refused(
    h: Harness,
    content: unknown[],
    expected: { code: number; reason: string },
    label: string,
  ): Promise<void> {
    const before = h.host.get("S");
    if (!before) throw new Error("no session");
    const logBefore = (await h.client.request(Method.Log, { sessionId: "S" })) as {
      entries: unknown[];
    };
    const got = await refusalOf(prompt(h, "refused-turn", content));
    expect({ label, ...got }).toEqual({ label, ...expected });
    expect(h.model.requests).toHaveLength(0);
    const logAfter = (await h.client.request(Method.Log, { sessionId: "S" })) as {
      entries: unknown[];
    };
    expect(logAfter.entries.length).toBe(logBefore.entries.length);
  }

  test("a ref never uploaded is `not_uploaded`", async () => {
    const h = harness(storePolicy());
    await ready(h);
    await refused(
      h,
      [{ type: "attachment", ref: refFor("nope") }],
      {
        code: DomainErrorCode.AttachmentRefused,
        reason: "not_uploaded",
      },
      "never uploaded",
    );
  });

  test("a partial upload is `not_uploaded`", async () => {
    const h = harness(storePolicy());
    await ready(h);
    const bytes = bytesFor("partial");
    const id = sha(bytes);
    // Only the first half: a probe plus one chunk.
    await h.client.request(Method.AttachmentPut, {
      sessionId: "S",
      id,
      size: bytes.length,
      offset: 0,
      data: b64(bytes.subarray(0, 3)),
    });
    await refused(
      h,
      [{ type: "attachment", ref: refFor("partial") }],
      {
        code: DomainErrorCode.AttachmentRefused,
        reason: "not_uploaded",
      },
      "partial upload",
    );
  });

  test("a ref over the advertised maxBytes is `invalid_ref`, naming size and limit", async () => {
    const h = harness(storePolicy(4));
    await ready(h);
    const bytes = bytesFor("too big for 4 bytes");
    await put(h, bytes);
    let message = "";
    try {
      await prompt(h, "refused-turn", [{ type: "attachment", ref: refFor("too big for 4 bytes") }]);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("4 B");
    expect(message).toContain("limit");
    await refused(
      h,
      [{ type: "attachment", ref: refFor("too big for 4 bytes") }],
      {
        code: DomainErrorCode.AttachmentRefused,
        reason: "invalid_ref",
      },
      "over maxBytes",
    );
  });

  test("an unsupported type and a repeated id are `invalid_ref`", async () => {
    const h = harness(storePolicy());
    await ready(h);
    const heic = refFor("heic", { mimeType: "image/heic" });
    await refused(
      h,
      [{ type: "attachment", ref: heic }],
      {
        code: DomainErrorCode.AttachmentRefused,
        reason: "invalid_ref",
      },
      "heic",
    );
    const bytes = bytesFor("dup");
    await put(h, bytes);
    const ref = refFor("dup");
    await refused(
      h,
      [
        { type: "attachment", ref },
        { type: "attachment", ref },
      ],
      {
        code: DomainErrorCode.AttachmentRefused,
        reason: "invalid_ref",
      },
      "duplicate id",
    );
  });

  test("after a refusal the SAME turnId is accepted once the image is uploaded", async () => {
    const h = harness(storePolicy());
    await ready(h);
    const bytes = bytesFor("later");
    const ref = refFor("later");
    await refusalOf(prompt(h, "t1", [{ type: "attachment", ref }]));
    await put(h, bytes);
    await prompt(h, "t1", [
      { type: "text", text: "now" },
      { type: "attachment", ref },
    ]);
    await settle();
    expect(h.model.requests).toHaveLength(1);
  });
});

describe("no policy: images are off", () => {
  test("a prompt naming a ref is `images_off` and records nothing", async () => {
    const h = harness();
    await ready(h);
    expect(await refusalOf(prompt(h, "t1", [{ type: "attachment", ref: refFor("x") }]))).toEqual({
      code: DomainErrorCode.AttachmentRefused,
      reason: "images_off",
    });
    expect(h.model.requests).toHaveLength(0);
    // Text still works, and the factory was handed no source.
    await prompt(h, "t2", [{ type: "text", text: "hello" }]);
    await settle();
    expect(h.model.requests).toHaveLength(1);
    expect(h.sources).toEqual([undefined]);
  });
});

describe("client policy: the laptop holds the bytes", () => {
  test("a ref is accepted with nothing uploaded and no source at the daemon", async () => {
    const h = harness({ source: "client" });
    await ready(h);
    const ref = refFor("on the laptop");
    await prompt(h, "t1", [
      { type: "text", text: "look" },
      { type: "attachment", ref },
    ]);
    await settle();
    expect(h.model.requests).toHaveLength(1);
    // The daemon has no bytes, and says so by not giving the provider a source.
    expect(h.sources).toEqual([undefined]);
    expect(h.model.requests[0]?.attachments).toBeUndefined();
    expect(h.model.requests[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: "look",
      attachments: [ref],
    });
  });

  test("a malformed ref is still refused `invalid_ref` (the daemon validates what it can)", async () => {
    const h = harness({ source: "client" });
    await ready(h);
    expect(
      await refusalOf(
        prompt(h, "t1", [{ type: "attachment", ref: refFor("a", { mimeType: "image/heic" }) }]),
      ),
    ).toEqual({ code: DomainErrorCode.AttachmentRefused, reason: "invalid_ref" });
  });
});

describe("initialize advertises the policy", () => {
  test("store → upload + the cap; client → client; none → no images", async () => {
    const store = harness(storePolicy(3932160));
    const asStore = (await store.client.request(Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    })) as { agentCapabilities: unknown };
    expect(asStore.agentCapabilities).toEqual({
      tools: true,
      permissions: true,
      images: { input: "upload", maxBytes: 3932160 },
    });

    const client = harness({ source: "client" });
    const asClient = (await client.client.request(Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    })) as { agentCapabilities: unknown };
    expect(asClient.agentCapabilities).toEqual({
      tools: true,
      permissions: true,
      images: { input: "client" },
    });

    const none = harness();
    const asNone = (await none.client.request(Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    })) as { agentCapabilities: unknown };
    expect(asNone.agentCapabilities).toEqual({ tools: true, permissions: true });
  });
});

describe("a settings sync keeps the source", () => {
  test("after session/update_settings the new agent's requests still carry hosted.uploads", async () => {
    const h = harness(storePolicy());
    await ready(h);
    const bytes = bytesFor("synced");
    const ref = refFor("synced");
    await put(h, bytes);
    await h.client.request(Method.UpdateSettings, {
      sessionId: "S",
      id: "sync-1",
      settings: {},
    });
    await prompt(h, "t1", [
      { type: "text", text: "after sync" },
      { type: "attachment", ref },
    ]);
    await settle();
    // Two builds: the create and the settings swap. Both were given the store.
    const store = h.host.get("S")?.uploads;
    if (store === undefined) throw new Error("no session store");
    expect(h.sources).toEqual([store, store]);
    expect(h.model.requests.at(-1)?.attachments).toBe(store);
  });
});

/**
 * `turn_start.attachments` (docs/feat/attachments-tui.md D2, T5): another
 * client's image prompt shows `[image: name]`. The field carries the refs the
 * prompt named, and a text-only prompt carries none at all (never `[]`).
 */
describe("turn_start carries the prompt's refs", () => {
  test("a prompt with refs emits them, and a text prompt emits no field", async () => {
    const h = harness(storePolicy());
    await ready(h);
    const bytes = bytesFor("shown");
    const ref = refFor("shown", { name: "shot.png" });
    await put(h, bytes);
    await prompt(h, "t1", [
      { type: "text", text: "what is this?" },
      { type: "attachment", ref },
    ]);
    await settle();
    await prompt(h, "t2", [{ type: "text", text: "just words" }]);
    await settle();

    const starts = h.updates.filter((u) => u.type === "turn_start");
    expect(starts).toHaveLength(2);
    expect(starts[0]?.attachments).toEqual([ref]);
    expect(starts[1]?.attachments).toBeUndefined();
  });

  test("an image-only prompt carries its refs beside an empty prompt", async () => {
    const h = harness(storePolicy());
    await ready(h);
    const bytes = bytesFor("only");
    const ref = refFor("only", { name: "a.png" });
    await put(h, bytes);
    await prompt(h, "t1", [{ type: "attachment", ref }]);
    await settle();

    const start = h.updates.find((u) => u.type === "turn_start");
    expect(start?.prompt).toBe("");
    expect(start?.attachments).toEqual([ref]);
  });
});
