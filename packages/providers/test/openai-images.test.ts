/**
 * Images on the OpenAI-compatible wire (docs/feat/attachments-core.md, D6, T9).
 *
 * Same property as `anthropic-images.test.ts`: the verified bytes reach the
 * request body as a `data:` URL, images before text, and an image that cannot be
 * sent arrives as a VISIBLE placeholder. The one deliberate difference is the
 * DEFAULT: this provider is usually a local llama.cpp/vLLM model, so `images`
 * is false unless configured — and then NOT ONE byte is read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AttachmentRef, AttachmentSource, ChatMessage, ChatRequest } from "@tentacle/core";
import { OpenAIProvider } from "../src/index.ts";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

function refFor(text: string, over: Partial<AttachmentRef> = {}): AttachmentRef {
  const bytes = bytesOf(text);
  return {
    id: createHash("sha256").update(bytes).digest("hex"),
    mimeType: "image/png",
    size: bytes.length,
    ...over,
  };
}

function sourceOf(
  entries: readonly { text: string; ref: AttachmentRef }[],
): AttachmentSource & { reads: string[] } {
  const reads: string[] = [];
  const byId = new Map(entries.map((e) => [e.ref.id, e.text]));
  return {
    reads,
    async read(ref: AttachmentRef): Promise<Uint8Array | null> {
      reads.push(ref.id);
      const text = byId.get(ref.id);
      return text === undefined ? null : bytesOf(text);
    },
  };
}

const user = (content: string, attachments?: AttachmentRef[]): ChatMessage =>
  attachments === undefined ? { role: "user", content } : { role: "user", content, attachments };

let server: ReturnType<typeof Bun.serve>;
let baseURL: string;
let lastBody: Record<string, unknown> | undefined;
let hits = 0;

const DONE_SSE = [
  { choices: [{ delta: { content: "ok" } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
]
  .map((e) => `data: ${JSON.stringify(e)}\n\n`)
  .join("");

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      hits += 1;
      lastBody = (await req.json()) as Record<string, unknown>;
      return new Response(DONE_SSE, { headers: { "content-type": "text/event-stream" } });
    },
  });
  baseURL = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

async function bodyFor(
  request: ChatRequest,
  config: { images?: boolean } = {},
): Promise<Record<string, unknown>> {
  lastBody = undefined;
  const provider = new OpenAIProvider({
    baseURL,
    model: "m",
    ...(config.images !== undefined ? { images: config.images } : {}),
  });
  for await (const _ of provider.stream(request)) {
    // drain
  }
  if (lastBody === undefined) {
    throw new Error("the provider sent no request");
  }
  return lastBody;
}

const contentOf = (body: Record<string, unknown>, at = 0): unknown =>
  (body.messages as Record<string, unknown>[])[at]?.content;

describe("with images: true, an image ref becomes a data URL, images first", () => {
  test("a data URL with the source's exact bytes, then the text", async () => {
    const one = refFor("pic-bytes", { name: "pic.jpg", mimeType: "image/jpeg" });
    const body = await bodyFor(
      {
        messages: [user("what is this?", [one])],
        attachments: sourceOf([{ text: "pic-bytes", ref: one }]),
      },
      { images: true },
    );
    expect(contentOf(body)).toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${b64(bytesOf("pic-bytes"))}` },
      },
      { type: "text", text: "what is this?" },
    ]);
  });

  test("an image-only prompt keeps its message", async () => {
    const one = refFor("only");
    const body = await bodyFor(
      { messages: [user("", [one])], attachments: sourceOf([{ text: "only", ref: one }]) },
      { images: true },
    );
    expect(body.messages).toHaveLength(1);
    expect(JSON.stringify(contentOf(body))).toContain("image_url");
  });

  test("a message without refs stays a plain string", async () => {
    const body = await bodyFor({ messages: [user("hi")] }, { images: true });
    expect(contentOf(body)).toBe("hi");
  });

  test("missing bytes → the unavailable placeholder", async () => {
    const one = refFor("x", { name: "cat.png" });
    const body = await bodyFor(
      { messages: [user("see?", [one])], attachments: sourceOf([]) },
      { images: true },
    );
    expect(JSON.stringify(contentOf(body))).toContain("[image unavailable — cat.png");
  });

  test("a sha256 mismatch → the unavailable placeholder, no image_url", async () => {
    const one = refFor("real");
    const body = await bodyFor(
      {
        messages: [user("", [one])],
        attachments: {
          async read(): Promise<Uint8Array | null> {
            return bytesOf("fake");
          },
        },
      },
      { images: true },
    );
    const parts = contentOf(body) as { type: string }[];
    expect(parts.some((p) => p.type === "image_url")).toBe(false);
    expect(JSON.stringify(parts)).toContain("[image unavailable");
  });
});

describe("the default is NO vision: not one byte is read", () => {
  test("no `images` option → no-vision placeholder, source never read", async () => {
    const one = refFor("x", { name: "cat.png" });
    const source = sourceOf([{ text: "x", ref: one }]);
    const body = await bodyFor({ messages: [user("see?", [one])], attachments: source });
    expect(source.reads).toEqual([]);
    expect(contentOf(body)).toEqual([
      {
        type: "text",
        text: expect.stringContaining("[image omitted: this model does not take images"),
      },
      { type: "text", text: "see?" },
    ]);
  });

  test("an explicit `images: false` behaves the same", async () => {
    const one = refFor("x");
    const source = sourceOf([{ text: "x", ref: one }]);
    const body = await bodyFor(
      { messages: [user("", [one])], attachments: source },
      { images: false },
    );
    expect(source.reads).toEqual([]);
    expect(JSON.stringify(contentOf(body))).toContain("does not take images");
  });

  test("an image over the OPENAI-COMPATIBLE default cap (5 MiB) is never read", async () => {
    // Review H1: the global 15 MiB entry-point bound is not the endpoint's. The
    // default here is deliberately conservative (the model behind the URL is
    // unknown); `model.maxImageBytes` raises it.
    const size = 6 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    const ref: AttachmentRef = {
      id: createHash("sha256").update(bytes).digest("hex"),
      mimeType: "image/png",
      size,
      name: "big.png",
    };
    let reads = 0;
    const source: AttachmentSource = {
      async read(): Promise<Uint8Array | null> {
        reads += 1;
        return bytes;
      },
    };
    const body = await bodyFor(
      { messages: [user("look", [ref])], attachments: source },
      {
        images: true,
      },
    );
    expect(reads).toBe(0);
    expect(JSON.stringify(contentOf(body))).not.toContain("image_url");
    const label = `big.png sha256:${ref.id.slice(0, 12)}`;
    expect(contentOf(body)).toEqual([
      { type: "text", text: `[image omitted: 6 MB is over this model's 5 MB limit — ${label}]` },
      { type: "text", text: "look" },
    ]);
  });

  test("an assistant message with refs gets a placeholder LINE either way", async () => {
    const one = refFor("x", { name: "cat.png" });
    const body = await bodyFor({
      messages: [user("hi"), { role: "assistant", content: "look", attachments: [one] }],
    });
    expect(contentOf(body, 1)).toContain("look\n[image omitted: this model does not take images");
  });
});

describe("failures happen before the provider is called", () => {
  test("a throwing source rejects the stream and sends nothing", async () => {
    const one = refFor("x");
    const before = hits;
    const provider = new OpenAIProvider({ baseURL, model: "m", images: true });
    const stream = provider.stream({
      messages: [user("", [one])],
      attachments: {
        async read(): Promise<Uint8Array | null> {
          throw new Error("store is down");
        },
      },
    });
    await expect(async () => {
      for await (const _ of stream) {
        // drain
      }
    }).toThrow(/store is down/);
    expect(hits).toBe(before);
  });
});
