/**
 * `RemoteClient.attachImage` and a prompt that names a ref
 * (docs/feat/attachments-prompt.md D5/D6, T7).
 *
 * The property: the entry point picks the ONE correct path from the daemon's
 * advertised capability — upload the bytes when the daemon runs the model, keep
 * them here when this laptop does — and a prompt's content is exactly the text
 * plus one attachment block per ref, so an image-only prompt is legal and a
 * keyed re-send (a drop after the turn started) carries the same refs under the
 * same `turnId`.
 *
 * Real `RemoteClient` ↔ real `Connection`, with a frame spy: "zero frames"
 * (a refusal) is proved, not assumed.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import type { AttachmentRef, ExecutionEnvironment, ModelProvider } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, type ImagePolicy, SessionHost } from "@tentacle/daemon";
import { MAX_IMAGE_BYTES } from "@tentacle/protocol";
import { type DuplexChannel, RpcPeer, createChannelPair } from "@tentacle/transport";
import { ImagesUnavailableError, RemoteClient } from "../src/index.ts";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

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

/** A daemon host with a policy (`undefined` = images off). */
function host(policy?: ImagePolicy): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/attach-image",
    ...(policy ? { images: policy } : {}),
    createAgent: () => ({
      agent: new Agent({ model: new Idle(), tools: {} as never, env }),
      permissions: new PermissionBroker(),
    }),
  });
}

interface Frame {
  method?: string;
  params?: Record<string, unknown>;
}

/** A model provider that never streams: only the `client` mode needs one present. */
class Quiet implements ModelProvider {
  readonly id = "quiet";
  // biome-ignore lint/correctness/useYield: never streams here
  async *stream(): AsyncIterable<never> {
    throw new Error("must not generate");
  }
}

/** A laptop on a fresh daemon link, with every outbound frame recorded. */
async function link(
  policy?: ImagePolicy,
  opts: { readonly servesModel?: boolean } = {},
): Promise<{ laptop: RemoteClient; frames: Frame[]; host: SessionHost }> {
  const h = host(policy);
  const [d, c] = createChannelPair();
  new Connection(d, h);
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
  const laptop = new RemoteClient(
    tap,
    new PermissionBroker(),
    // A laptop that serves the model only when the test needs one: `client`
    // mode is off without it (D5's table).
    opts.servesModel ? new Quiet() : undefined,
    { localImages: { vision: true, maxBytes: 4 * 1024 * 1024 } },
  );
  await laptop.initialize();
  return { laptop, frames, host: h };
}

const putFrames = (frames: Frame[]): Frame[] => frames.filter((f) => f.method === "attachment/put");

describe("upload mode: the daemon runs the model", () => {
  test("the ref is built from the LAPTOP's bytes and the store holds them", async () => {
    const { laptop, frames, host: h } = await link({ source: "store", maxBytes: 4 * 1024 * 1024 });
    const sessionId = await laptop.openSession("/tmp/attach-image");
    const bytes = bytesOf("a png");
    const ref = await laptop.attachImage(sessionId, bytes, { mimeType: "image/png" });

    expect(ref.id).toBe(sha(bytes));
    expect(ref.size).toBe(bytes.length);
    expect(ref.mimeType).toBe("image/png");
    expect(putFrames(frames).length).toBeGreaterThan(0);
    expect(h.get(sessionId)?.uploads.holds(ref)).toBe(true);
    laptop.close();
  });

  test("a name is carried through, and absent when not given", async () => {
    const { laptop } = await link({ source: "store", maxBytes: 1024 });
    const sessionId = await laptop.openSession("/tmp/attach-image");
    const named = await laptop.attachImage(sessionId, bytesOf("x"), {
      mimeType: "image/png",
      name: "shot.png",
    });
    expect(named.name).toBe("shot.png");
    const anon = await laptop.attachImage(sessionId, bytesOf("y"), { mimeType: "image/png" });
    expect(anon.name).toBeUndefined();
    laptop.close();
  });

  test("progress reports the whole size once the bytes are in", async () => {
    const { laptop } = await link({ source: "store", maxBytes: 1024 });
    const sessionId = await laptop.openSession("/tmp/attach-image");
    const seen: [number, number][] = [];
    const bytes = bytesOf("p");
    await laptop.attachImage(
      sessionId,
      bytes,
      { mimeType: "image/png" },
      { onProgress: (sent, size) => seen.push([sent, size]) },
    );
    expect(seen.at(-1)).toEqual([bytes.length, bytes.length]);
    laptop.close();
  });
});

describe("off: this client may not send an image at all", () => {
  test("a daemon with no policy rejects with ImagesUnavailableError and ZERO frames", async () => {
    const { laptop, frames } = await link();
    const sessionId = await laptop.openSession("/tmp/attach-image");
    const before = frames.length;
    let caught: unknown;
    try {
      await laptop.attachImage(sessionId, bytesOf("nope"), { mimeType: "image/png" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImagesUnavailableError);
    // Nothing went to the daemon: not an upload, not even a probe.
    expect(frames.slice(before)).toEqual([]);
    laptop.close();
  });

  test("images off is explained, not just refused", async () => {
    const { laptop } = await link();
    const sessionId = await laptop.openSession("/tmp/attach-image");
    const got = laptop.imageInput();
    expect(got.kind).toBe("off");
    if (got.kind === "off") expect(got.reason.length).toBeGreaterThan(0);
    void sessionId;
    laptop.close();
  });
});

describe("local limits, checked before any frame", () => {
  test("an image over the advertised maxBytes is rejected, naming size and limit", async () => {
    const { laptop, frames } = await link({ source: "store", maxBytes: 4 });
    const sessionId = await laptop.openSession("/tmp/attach-image");
    const before = frames.length;
    let message = "";
    try {
      await laptop.attachImage(sessionId, bytesOf("12345"), { mimeType: "image/png" });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("4 B");
    expect(frames.slice(before)).toEqual([]);
    laptop.close();
  });

  test("an unsupported mime type is rejected before any frame", async () => {
    const { laptop, frames } = await link({ source: "store", maxBytes: 1024 });
    const sessionId = await laptop.openSession("/tmp/attach-image");
    const before = frames.length;
    let caught: unknown;
    try {
      await laptop.attachImage(sessionId, bytesOf("h"), { mimeType: "image/heic" });
    } catch (error) {
      caught = error;
    }
    expect(String((caught as Error).message)).toContain("heic");
    expect(frames.slice(before)).toEqual([]);
    laptop.close();
  });

  test("an image at MAX_IMAGE_BYTES+1 is rejected even when the daemon advertises more", async () => {
    const { laptop, frames } = await link({ source: "store", maxBytes: 99 * 1024 * 1024 });
    const sessionId = await laptop.openSession("/tmp/attach-image");
    const before = frames.length;
    await expect(
      laptop.attachImage(sessionId, new Uint8Array(MAX_IMAGE_BYTES + 1), { mimeType: "image/png" }),
    ).rejects.toThrow();
    expect(frames.slice(before)).toEqual([]);
    laptop.close();
  });
});

describe("laptop mode: this client runs the model", () => {
  test("no frame at all, and the bytes are held here", async () => {
    const { laptop, frames } = await link({ source: "client" }, { servesModel: true });
    const before = frames.length;
    const bytes = bytesOf("held here");
    const ref = await laptop.attachImage("S", bytes, { mimeType: "image/png" });
    expect(frames.slice(before)).toEqual([]);
    expect(laptop.images.holds(ref.id, ref.size)).toBe(true);
    expect(await laptop.images.read(ref)).toEqual(bytes);
    laptop.close();
  });
});

describe("a prompt's content names the refs", () => {
  /** The last `session/prompt` frame's `content`, as the daemon would parse it. */
  const sentContent = (frames: Frame[]): unknown =>
    frames.filter((f) => f.method === "session/prompt").at(-1)?.params?.content;

  test("text + refs becomes [text, attachment…]", async () => {
    const { laptop, frames } = await link({ source: "store", maxBytes: 1024 });
    const sessionId = await laptop.openSession("/tmp/attach-image");
    const ref: AttachmentRef = await laptop.attachImage(sessionId, bytesOf("q"), {
      mimeType: "image/png",
    });
    await laptop.prompt(sessionId, "t1", "what is this?", undefined, undefined, [ref]);
    expect(sentContent(frames)).toEqual([
      { type: "text", text: "what is this?" },
      { type: "attachment", ref },
    ]);
    laptop.close();
  });

  test("an image-only prompt is the attachment blocks alone (never an empty text block)", async () => {
    const { laptop, frames } = await link({ source: "store", maxBytes: 1024 });
    const sessionId = await laptop.openSession("/tmp/attach-image");
    const ref = await laptop.attachImage(sessionId, bytesOf("only"), { mimeType: "image/png" });
    await laptop.prompt(sessionId, "t1", "", undefined, undefined, [ref]);
    expect(sentContent(frames)).toEqual([{ type: "attachment", ref }]);
    laptop.close();
  });

  test("a prompt with no refs is unchanged (one text block)", async () => {
    const { laptop, frames } = await link({ source: "store", maxBytes: 1024 });
    const sessionId = await laptop.openSession("/tmp/attach-image");
    await laptop.prompt(sessionId, "t1", "plain");
    expect(sentContent(frames)).toEqual([{ type: "text", text: "plain" }]);
    laptop.close();
  });
});

describe("a keyed re-send keeps the refs", () => {
  test("after a drop the re-sent prompt has the same content under the same turnId", async () => {
    // The first link answers everything EXCEPT a prompt's own ack is delayed
    // past the drop, so the client re-sends the keyed prompt on the next link.
    // Its refs must ride along: a retried turn without them is a different turn.
    const h = host({ source: "store", maxBytes: 1024 });
    const generations: Frame[][] = [];
    let gen = 0;
    let dropNow: (() => void) | null = null;
    const dial = (): DuplexChannel => {
      const [d, c] = createChannelPair();
      new Connection(d, h);
      const log: Frame[] = [];
      generations.push(log);
      const mine = gen;
      const tapped: DuplexChannel = {
        send: (data: string) => {
          const frame = JSON.parse(data) as Frame;
          log.push(frame);
          if (frame.method === "session/prompt" && mine === 0) {
            // Dropped instead of answered: the client must re-send it.
            dropNow?.();
            return;
          }
          c.send(data);
        },
        close: () => c.close(),
        setOnMessage: (handler) => c.setOnMessage(handler),
        setOnClose: (handler) => c.setOnClose(handler),
      };
      return tapped;
    };
    const first = dial();
    gen = 0;
    const laptop = new RemoteClient(first, new PermissionBroker(), undefined, {
      channelFactory: async () => {
        gen += 1;
        return dial();
      },
      random: () => 0,
    });
    await laptop.initialize();
    const sessionId = await laptop.openSession("/tmp/attach-image");
    const ref = await laptop.attachImage(sessionId, bytesOf("retry"), { mimeType: "image/png" });

    const session = laptop.newSession(undefined, sessionId);
    const dropping = new Promise<void>((resolve) => {
      dropNow = () => {
        first.close();
        resolve();
      };
    });
    const sending = (async (): Promise<void> => {
      try {
        for await (const _ of session.send("what?", undefined, {
          turnId: "t1",
          attachments: [ref],
        })) {
          // drain: the turn's own outcome is not what this test proves
        }
      } catch {
        // The host's model is `Idle`, so the turn itself errors; the FRAMES are
        // the property here (the retried prompt carries its refs).
      }
    })();
    await dropping;
    await sending;
    await new Promise((r) => setTimeout(r, 50));

    const prompts = generations
      .flat()
      .filter((f) => f.method === "session/prompt")
      .map((f) => ({ turnId: f.params?.turnId, content: f.params?.content }));
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    // Every attempt: the same key, and the same content down to the ref.
    expect(prompts[0]).toEqual({
      turnId: "t1",
      content: [
        { type: "text", text: "what?" },
        { type: "attachment", ref },
      ],
    });
    expect(prompts.at(-1)).toEqual(prompts[0] as (typeof prompts)[number]);
    laptop.close();
  });
});
