/**
 * `RemoteSession.attachImage` / `imageInput`, and image refs on the events a
 * prompt produces (docs/feat/attachments-tui.md D3, T6).
 *
 * The property: the TUI hands the SESSION the bytes, not the client — the
 * session opens itself first (a fresh one is LAZY, and the daemon's
 * `attachment/put` only knows a session open on this connection: the plan's
 * *r2*), and a prompt that follows reuses that ONE open. Plus: another device's
 * image prompt reaches this client as `user_message{attachments}`, after a
 * resync's re-delivery too.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import {
  type AttachmentRef,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
} from "@tentacle/core";
import { Connection, type ImagePolicy, SessionHost } from "@tentacle/daemon";
import { Notification } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, RpcPeer, createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";
import type { RemoteSession } from "../src/remote-session.ts";

const CWD = "/tmp/remote-session-attach";
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
} as unknown as ExecutionEnvironment;

/** Echoes the prompt's text; records what it was handed. */
class Echo implements ModelProvider {
  readonly id = "echo";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<never> {
    this.requests.push(request);
    yield { type: "text", delta: "ok" } as never;
    yield { type: "done" } as never;
  }
}

/** Streams nothing until `open()`: the turn stays running while a test drives frames. */
class GatedEcho implements ModelProvider {
  readonly id = "gated-echo";
  private release: (() => void) | null = null;
  open(): void {
    this.release?.();
  }
  async *stream(): AsyncIterable<never> {
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    yield { type: "done" } as never;
  }
}

interface Frame {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

interface Link {
  readonly client: RemoteClient;
  readonly frames: Frame[];
  readonly model: Echo;
  readonly host: SessionHost;
  /** A SECOND client on the same daemon (another device). */
  dial(): Link;
}

/** One in-process daemon holding image bytes in session stores (or taking none). */
function daemon(policy: ImagePolicy | "off" = { source: "store", maxBytes: 4 * 1024 * 1024 }): {
  dial: () => Link;
} {
  const model = new Echo();
  const host = new SessionHost({
    defaultCwd: CWD,
    ...(policy === "off" ? {} : { images: policy }),
    createAgent: () => ({
      agent: new Agent({ model, tools: new ToolRegistry(), env }),
      permissions: new PermissionBroker(),
    }),
  });
  const dial = (): Link => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const frames: Frame[] = [];
    const tap: DuplexChannel = {
      send: (data: string) => {
        frames.push(JSON.parse(data) as Frame);
        c.send(data);
      },
      close: () => c.close(),
      setOnMessage: (handler: (d: string) => void) => c.setOnMessage(handler),
      setOnClose: (handler: () => void) => c.setOnClose(handler),
    };
    const client = new RemoteClient(tap, new PermissionBroker());
    return { client, frames, model, host, dial };
  };
  return { dial };
}

/** Resolves "ended", the error it threw, or "hung". */
function drain(
  events: AsyncIterable<SessionEvent>,
  into: SessionEvent[],
  ms = 3000,
): Promise<unknown> {
  return Promise.race([
    (async () => {
      for await (const e of events) into.push(e);
      return "ended";
    })().catch((e: unknown) => e),
    new Promise((r) => setTimeout(() => r("hung"), ms)),
  ]);
}

const opens = (frames: readonly Frame[]): Frame[] =>
  frames.filter((f) => f.method === "session/open");

const until = async (ready: () => boolean, ms = 2000): Promise<void> => {
  const at = Date.now();
  while (!ready()) {
    if (Date.now() - at > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("RemoteSession.attachImage opens the session itself", () => {
  test("a LAZY session: attach before any send lands, and the send reuses that ONE open", async () => {
    const d = daemon();
    const a = d.dial();
    await a.client.initialize();
    const session = a.client.newSession(undefined, crypto.randomUUID());
    const bytes = bytesOf("a png");

    // No send yet: nothing has been opened on this connection (the plan's *r2*:
    // a put against an unopened session is refused).
    expect(opens(a.frames)).toHaveLength(0);
    const ref = await session.attachImage(bytes, { mimeType: "image/png", name: "a.png" });
    expect(ref.id).toBe(sha(bytes));
    expect(a.host.get(session.sessionId ?? "")?.uploads.holds(ref)).toBe(true);

    // The prompt that follows finds it open: ONE session/open in total.
    const events: SessionEvent[] = [];
    expect(await drain(session.send("what?", undefined, { attachments: [ref] }), events)).toBe(
      "ended",
    );
    expect(opens(a.frames)).toHaveLength(1);
    const prompt = a.frames.find((f) => f.method === "session/prompt");
    expect(prompt?.params?.content).toEqual([
      { type: "text", text: "what?" },
      { type: "attachment", ref },
    ]);
    a.client.close();
  });

  test("an image-only prompt: empty text, one ref, the turn runs", async () => {
    const d = daemon();
    const a = d.dial();
    await a.client.initialize();
    const session = a.client.newSession(undefined, crypto.randomUUID());
    const ref = await session.attachImage(bytesOf("only"), { mimeType: "image/png" });
    const events: SessionEvent[] = [];
    expect(await drain(session.send("", undefined, { attachments: [ref] }), events)).toBe("ended");
    expect(a.model.requests).toHaveLength(1);
    expect(a.model.requests[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: "",
      attachments: [ref],
    });
    a.client.close();
  });

  test("an ATTACH-only session awaits its eager open first", async () => {
    const d = daemon();
    const a = d.dial();
    await a.client.initialize();
    const sid = crypto.randomUUID();
    const seed = a.client.newSession(undefined, sid);
    expect(await drain(seed.send("seed"), [])).toBe("ended");

    // Attached from another client, whose own open() is still in flight.
    const b = d.dial();
    await b.client.initialize();
    const attached = b.client.newSession(undefined, sid, undefined, { attach: {} });
    const bytes = bytesOf("att");
    // No `open()` awaited by the caller: `attachImage` must do it.
    const ref = await attached.attachImage(bytes, { mimeType: "image/png" });
    expect(b.host.get(sid)?.uploads.holds(ref)).toBe(true);
    a.client.close();
    b.client.close();
  });

  test("images off: the reason comes from the session's own imageInput, and nothing is uploaded", async () => {
    const d = daemon("off"); // no `images` layer at all
    const a = d.dial();
    await a.client.initialize();
    const session = a.client.newSession(undefined, crypto.randomUUID());
    const mode = session.imageInput();
    expect(mode.kind).toBe("off");
    const before = a.frames.length;
    let caught: unknown;
    try {
      await session.attachImage(bytesOf("nope"), { mimeType: "image/png" });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe("ImagesUnavailableError");
    // Nothing went out: not even the open.
    expect(a.frames.slice(before)).toEqual([]);
    a.client.close();
  });
});

describe("another device's image prompt", () => {
  test("reaches this client as user_message with its refs", async () => {
    const d = daemon();
    const a = d.dial();
    const b = d.dial();
    await a.client.initialize();
    await b.client.initialize();
    const sid = crypto.randomUUID();
    const sa = a.client.newSession(undefined, sid);
    expect(await drain(sa.send("warm"), [])).toBe("ended");

    // B attaches to the session (its history an activity), then watches it:
    // A's image prompt is B's foreign turn.
    const sb = b.client.newSession(undefined, sid, undefined, { attach: {} });
    const turns: { events: AsyncIterable<SessionEvent> }[] = [];
    sb.watch((activity) => {
      if (activity.kind === "turn") turns.push(activity);
    });
    await sb.open();

    const ref: AttachmentRef = await sa.attachImage(bytesOf("shown"), {
      mimeType: "image/png",
      name: "shot.png",
    });
    expect(await drain(sa.send("what is this?", undefined, { attachments: [ref] }), [])).toBe(
      "ended",
    );
    await until(() => turns.length === 1);
    const foreign = turns[0];
    if (foreign === undefined) throw new Error("no foreign turn");
    const events: SessionEvent[] = [];
    expect(await drain(foreign.events, events)).toBe("ended");
    expect(events[0]).toEqual({ type: "user_message", text: "what is this?", attachments: [ref] });
    a.client.close();
    b.client.close();
  });

  test("an image-only foreign prompt still pushes a user_message", async () => {
    const d = daemon();
    const a = d.dial();
    const b = d.dial();
    await a.client.initialize();
    await b.client.initialize();
    const sid = crypto.randomUUID();
    const sa = a.client.newSession(undefined, sid);
    expect(await drain(sa.send("warm"), [])).toBe("ended");
    const sb = b.client.newSession(undefined, sid, undefined, { attach: {} });
    const turns: { events: AsyncIterable<SessionEvent> }[] = [];
    sb.watch((activity) => {
      if (activity.kind === "turn") turns.push(activity);
    });
    await sb.open();
    await until(() => turns.length === 0);

    const ref = await sa.attachImage(bytesOf("only"), { mimeType: "image/png", name: "a.png" });
    expect(await drain(sa.send("", undefined, { attachments: [ref] }), [])).toBe("ended");
    await until(() => turns.length === 1);
    const events: SessionEvent[] = [];
    const foreign = turns[0];
    if (foreign === undefined) throw new Error("no foreign turn");
    expect(await drain(foreign.events, events)).toBe("ended");
    // Text is "" — the refs alone say what was asked.
    expect(events[0]).toEqual({ type: "user_message", text: "", attachments: [ref] });
    a.client.close();
    b.client.close();
  });
});

/**
 * The reset re-delivery (`onUpdate`, D3): after a resync cut, an own turn's
 * `turn_start` re-delivers its prompt, so the screen shows it again. With refs
 * it must re-deliver those too — otherwise an image prompt that survived a
 * reset comes back as a bare question. Driven through the session's own
 * listener (`output`), which is the production path the reducer feeds.
 */
describe("an own turn re-delivered after a reset", () => {
  test("its user_message carries the prompt's refs", async () => {
    const model = new GatedEcho();
    const host = new SessionHost({
      defaultCwd: CWD,
      images: { source: "store", maxBytes: 4 * 1024 * 1024 },
      createAgent: () => ({
        agent: new Agent({ model, tools: new ToolRegistry(), env }),
        permissions: new PermissionBroker(),
      }),
    });
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const frames: Frame[] = [];
    const tap: DuplexChannel = {
      send: (data: string) => {
        frames.push(JSON.parse(data) as Frame);
        c.send(data);
      },
      close: () => c.close(),
      setOnMessage: (handler: (data: string) => void) => c.setOnMessage(handler),
      setOnClose: (handler: () => void) => c.setOnClose(handler),
    };
    const client = new RemoteClient(tap, new PermissionBroker());
    await client.initialize();
    const session: RemoteSession = client.newSession(undefined, crypto.randomUUID());
    const ref = await session.attachImage(bytesOf("again"), {
      mimeType: "image/png",
      name: "a.png",
    });
    const events: SessionEvent[] = [];
    const run = drain(session.send("what?", undefined, { attachments: [ref] }), events);
    await until(() => frames.some((f) => f.method === "session/prompt"));
    const turnId = frames.find((f) => f.method === "session/prompt")?.params?.turnId as string;

    // The resync: a barrier, then a snapshot naming this own turn (its prompt
    // is on screen already, so the ack never pushed a user_message).
    session.output({
      kind: "update",
      seq: 1,
      update: { type: "history_replaced", reason: "clear" },
      turn: null,
    });
    session.output({ kind: "reset", messages: [], turn: turnId, keepRequests: [] });
    session.output({
      kind: "update",
      seq: 2,
      update: { type: "turn_start", turnId, prompt: "what?", attachments: [ref] },
      turn: turnId,
    });
    await until(() => events.some((e) => e.type === "user_message"));
    const again = events.find((e) => e.type === "user_message");
    expect(again).toEqual({ type: "user_message", text: "what?", attachments: [ref] });

    model.open();
    await run;
    client.close();
  });
});
