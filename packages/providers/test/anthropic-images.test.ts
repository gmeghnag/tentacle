/**
 * Images on the Anthropic wire (docs/feat/attachments-core.md, D6, T8).
 *
 * The property proved here is NOT "the schema accepts the field": it is that the
 * verified bytes of every referenced image reach the request BODY, images before
 * text, that an image which cannot be sent reaches it as a VISIBLE placeholder
 * (never as nothing), and that no read happens when the model cannot see images.
 * The proof is the captured HTTP body via an injected `fetch`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AttachmentRef, AttachmentSource, ChatMessage, ChatRequest } from "@tentacle/core";
import { AnthropicProvider } from "../src/index.ts";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A ref whose id/size match `text`'s bytes exactly. */
function refFor(text: string, over: Partial<AttachmentRef> = {}): AttachmentRef {
  const bytes = bytesOf(text);
  return { id: sha(bytes), mimeType: "image/png", size: bytes.length, ...over };
}

/** A source holding `text` under the matching ref, counting its reads. */
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
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]
  .map((e) => `data: ${JSON.stringify(e)}\n\n`)
  .join("");

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      hits += 1;
      lastBody = (await req.json()) as Record<string, unknown>;
      if (String(req.url).includes("/count_tokens")) {
        return Response.json({ input_tokens: 42 });
      }
      return new Response(DONE_SSE, { headers: { "content-type": "text/event-stream" } });
    },
  });
  baseURL = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

/** Run a request and give back the body the provider POSTed. */
async function bodyFor(
  request: ChatRequest,
  config: { images?: boolean } = {},
): Promise<Record<string, unknown>> {
  lastBody = undefined;
  const provider = new AnthropicProvider({
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

describe("an image ref reaches the body as a base64 image block", () => {
  test("images come FIRST, then the text, with the source's exact bytes", async () => {
    const one = refFor("first-bytes", { name: "one.png" });
    const two = refFor("second-bytes", { name: "two.png" });
    const body = await bodyFor({
      messages: [user("what is in these?", [one, two])],
      attachments: sourceOf([
        { text: "first-bytes", ref: one },
        { text: "second-bytes", ref: two },
      ]),
    });
    expect(contentOf(body)).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64(bytesOf("first-bytes")) },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64(bytesOf("second-bytes")) },
      },
      { type: "text", text: "what is in these?" },
    ]);
  });

  test("an IMAGE-ONLY prompt keeps its message (empty text is not a reason to drop it)", async () => {
    const one = refFor("only-bytes");
    const body = await bodyFor({
      messages: [user("", [one])],
      attachments: sourceOf([{ text: "only-bytes", ref: one }]),
    });
    expect(body.messages).toHaveLength(1);
    expect(contentOf(body)).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64(bytesOf("only-bytes")) },
      },
    ]);
  });

  test("a message without refs is unchanged (a plain string, as before)", async () => {
    const body = await bodyFor({ messages: [user("hi")] });
    expect(contentOf(body)).toBe("hi");
  });

  test("each distinct id is read ONCE, and ids are read only for selected refs", async () => {
    const one = refFor("dup");
    const source = sourceOf([{ text: "dup", ref: one }]);
    await bodyFor({
      messages: [user("a", [one]), { role: "assistant", content: "b" }],
      attachments: source,
    });
    expect(source.reads).toEqual([one.id]);
  });
});

describe("an image that cannot be sent is a VISIBLE placeholder, never nothing", () => {
  test("no source at all → `image unavailable` (the state until a source is wired)", async () => {
    const one = refFor("x", { name: "cat.png" });
    const body = await bodyFor({ messages: [user("see?", [one])] });
    expect(contentOf(body)).toEqual([
      { type: "text", text: `[image unavailable — cat.png sha256:${one.id.slice(0, 12)}]` },
      { type: "text", text: "see?" },
    ]);
  });

  test("a source without the bytes → unavailable", async () => {
    const one = refFor("x", { name: "cat.png" });
    const body = await bodyFor({
      messages: [user("see?", [one])],
      attachments: sourceOf([]),
    });
    expect(JSON.stringify(contentOf(body))).toContain("[image unavailable — cat.png");
  });

  test("bytes whose sha256 does not match the ref → unavailable (a source is never trusted)", async () => {
    const one = refFor("real");
    const body = await bodyFor({
      messages: [user("", [one])],
      // The right length, the wrong bytes.
      attachments: {
        async read(): Promise<Uint8Array | null> {
          return bytesOf("fake");
        },
      },
    });
    expect(JSON.stringify(contentOf(body))).toContain("[image unavailable");
    expect(JSON.stringify(contentOf(body))).not.toContain('image","source');
  });

  test("bytes of the wrong LENGTH → unavailable", async () => {
    const bytes = bytesOf("hello");
    const one: AttachmentRef = { id: sha(bytes), mimeType: "image/png", size: bytes.length + 1 };
    const body = await bodyFor({
      messages: [user("", [one])],
      attachments: {
        async read(): Promise<Uint8Array | null> {
          return bytes;
        },
      },
    });
    expect(JSON.stringify(contentOf(body))).toContain("[image unavailable");
  });

  test("a type no provider takes is never read and says so", async () => {
    const one = refFor("heic-bytes", { mimeType: "image/heic", name: "cat.heic" });
    const source = sourceOf([{ text: "heic-bytes", ref: one }]);
    const body = await bodyFor({ messages: [user("", [one])], attachments: source });
    expect(source.reads).toEqual([]);
    expect(contentOf(body)).toEqual([
      {
        type: "text",
        text: expect.stringContaining("[image omitted: unsupported type image/heic"),
      },
    ]);
  });

  test("`images: false` → the no-vision placeholder and NOT ONE READ", async () => {
    const one = refFor("x", { name: "cat.png" });
    const source = sourceOf([{ text: "x", ref: one }]);
    const body = await bodyFor(
      { messages: [user("see?", [one])], attachments: source },
      { images: false },
    );
    expect(source.reads).toEqual([]);
    expect(contentOf(body)).toEqual([
      {
        type: "text",
        text: `[image omitted: this model does not take images — cat.png sha256:${one.id.slice(0, 12)}]`,
      },
      { type: "text", text: "see?" },
    ]);
  });

  test("`images: true` is the anthropic DEFAULT (an image is inlined with no option)", async () => {
    const one = refFor("dflt");
    const body = await bodyFor({
      messages: [user("", [one])],
      attachments: sourceOf([{ text: "dflt", ref: one }]),
    });
    expect(JSON.stringify(contentOf(body))).toContain('"type":"image"');
  });

  test("beyond the last 5 images: the oldest says why it was not sent", async () => {
    const refs = Array.from({ length: 6 }, (_, k) => refFor(`img-${k}`));
    const source = sourceOf(refs.map((ref, k) => ({ text: `img-${k}`, ref })));
    const body = await bodyFor({ messages: [user("six", refs)], attachments: source });
    const parts = contentOf(body) as { type: string; text?: string }[];
    expect(parts.filter((p) => p.type === "image")).toHaveLength(5);
    expect(parts[0]?.type).toBe("text");
    expect(parts[0]?.text).toContain("[image omitted: only the last 5 images are sent —");
    // The oldest (img-0) is the one left out, and it is never read.
    expect(source.reads).not.toContain(refs[0]?.id as string);
  });

  test("an assistant message that carries refs (only a pod could) gets a placeholder LINE", async () => {
    const one = refFor("x", { name: "cat.png" });
    const body = await bodyFor({
      messages: [user("hi"), { role: "assistant", content: "look", attachments: [one] }],
    });
    expect(contentOf(body, 1)).toContain("look\n[image unavailable — cat.png");
  });
});

describe("the tool-result merge never swallows a multimodal user turn", () => {
  test("a tool message AFTER a user message with images starts its own turn", async () => {
    const one = refFor("x");
    const body = await bodyFor({
      messages: [
        user("look", [one]),
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run", arguments: "{}" }] },
        { role: "tool", content: "done", toolCallId: "c1" },
      ],
      attachments: sourceOf([{ text: "x", ref: one }]),
    });
    const messages = body.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(3);
    expect(messages[1]?.role).toBe("assistant");
    // Its own user turn of `tool_result` blocks, not pushed into the image turn.
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }],
    });
  });

  test("consecutive tool results still collapse into ONE turn", async () => {
    const body = await bodyFor({
      messages: [
        user("go"),
        { role: "assistant", content: "", toolCalls: [{ id: "a", name: "r", arguments: "{}" }] },
        { role: "tool", content: "1", toolCallId: "a" },
        { role: "tool", content: "2", toolCallId: "a" },
      ],
    });
    const messages = body.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(3);
    expect((messages[2]?.content as unknown[]).length).toBe(2);
  });
});

describe("failures are loud and happen BEFORE the provider is called", () => {
  test("a throwing source rejects the stream, and no HTTP request is made", async () => {
    const one = refFor("x");
    const before = hits;
    const provider = new AnthropicProvider({ baseURL, model: "m" });
    const request: ChatRequest = {
      messages: [user("", [one])],
      attachments: {
        async read(): Promise<Uint8Array | null> {
          throw new Error("store is down");
        },
      },
    };
    const stream = provider.stream(request);
    await expect(async () => {
      for await (const _ of stream) {
        // drain
      }
    }).toThrow(/store is down/);
    expect(hits).toBe(before);
  });

  test("countTokens carries the SAME image blocks (one builder, both paths)", async () => {
    const one = refFor("counted");
    lastBody = undefined;
    const provider = new AnthropicProvider({ baseURL, model: "m" });
    const tokens = await provider.countTokens({
      messages: [user("what is this?", [one])],
      attachments: sourceOf([{ text: "counted", ref: one }]),
    });
    expect(tokens).toBe(42);
    const body = lastBody as unknown as Record<string, unknown>;
    // The count request drops only generation-only fields; the images stay.
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: b64(bytesOf("counted")) },
          },
          { type: "text", text: "what is this?" },
        ],
      },
    ]);
  });
});
