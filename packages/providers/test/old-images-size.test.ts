/**
 * T3 of docs/feat/image-old-on-demand.md: the WIRE consequence of the
 * projection — an aged user image is no image part at all, and the request
 * shrinks by (at least) the image's own base64.
 *
 * Not a provider change (D4): the projected message is an ordinary user message
 * whose `attachments` key is absent, and the provider already sends no image for
 * such a message (`readSelected`/`selectInlineIds`). What this pins is that the
 * property really holds end to end, so a later refactor cannot quietly re-inline
 * the bytes or leave a stub part behind.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { HeuristicTokenCounter } from "@tentacle/core";
import type { AttachmentRef, AttachmentSource, ChatMessage, ChatRequest } from "@tentacle/core";
import { projectOldImages } from "../../agent/src/old-images.ts";
import { AnthropicProvider, OpenAIProvider } from "../src/index.ts";

/** A 1 MiB "image": its base64 is what the body would carry. */
const size = 1024 * 1024;
const bytes = new Uint8Array(size);
for (let i = 0; i < size; i++) {
  bytes[i] = (i * 31 + 7) & 0xff;
}
// The provider verifies the bytes against the id, so the id must be the real sha256.
const ref: AttachmentRef = {
  id: createHash("sha256").update(bytes).digest("hex"),
  mimeType: "image/png",
  size,
  name: "big.png",
};
const src: AttachmentSource = { read: async () => bytes };

const ANTHROPIC_SSE = [
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]
  .map((e) => `data: ${JSON.stringify(e)}\n\n`)
  .join("");
const OPENAI_SSE = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

/** Captures the JSON body and its serialized length. */
function capture(sse: string) {
  const bodies: { body: string; parsed: { messages: Record<string, unknown>[] } }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const body = String(init.body);
    bodies.push({ body, parsed: JSON.parse(body) as { messages: Record<string, unknown>[] } });
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetch: f, bodies };
}

/** The stored history: the user's picture in turn 1, three answered turns after. */
const turn1: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "look at this", attachments: [ref] },
  { role: "assistant", content: "a1" },
  { role: "user", content: "t2" },
  { role: "assistant", content: "a2" },
  { role: "user", content: "t3" },
];

/** Turn 3's request: `turnFrom` is where its opener began. */
const request = (messages: readonly ChatMessage[]): ChatRequest => ({
  messages: [...messages],
  attachments: src,
});

async function bodyOf(which: "openai" | "anthropic", messages: readonly ChatMessage[]) {
  const cap = capture(which === "openai" ? OPENAI_SSE : ANTHROPIC_SSE);
  const provider =
    which === "openai"
      ? new OpenAIProvider({ baseURL: "http://x/v1", model: "m", images: true, fetch: cap.fetch })
      : new AnthropicProvider({ baseURL: "http://x/v1", model: "m", fetch: cap.fetch });
  for await (const _ of provider.stream(request(messages))) {
    // drain
  }
  const [one] = cap.bodies;
  if (one === undefined) {
    throw new Error("the provider sent no request");
  }
  return one;
}

/** Every image part in an OpenAI body. */
const openAiImages = (body: { messages: Record<string, unknown>[] }): number =>
  body.messages.reduce((n, m) => {
    const content = m.content;
    if (!Array.isArray(content)) {
      return n;
    }
    return n + content.filter((p) => (p as { type?: string }).type === "image_url").length;
  }, 0);

/** Every image block in an Anthropic body. */
const anthropicImages = (body: { messages: Record<string, unknown>[] }): number =>
  body.messages.reduce((n, m) => {
    const content = m.content;
    if (!Array.isArray(content)) {
      return n;
    }
    return n + content.filter((b) => (b as { type?: string }).type === "image").length;
  }, 0);

const projected = projectOldImages(turn1, turn1.length);

describe("an aged user image is not on the wire, per provider", () => {
  test("OpenAI: 0 image_url parts, and a body shorter by at least the image's base64", async () => {
    // The unprojected request sends the picture (the premise).
    const before = await bodyOf("openai", turn1);
    const after = await bodyOf("openai", projected);
    expect(openAiImages(before.parsed)).toBe(1);
    expect(openAiImages(after.parsed)).toBe(0);
    // The image's own base64 is what disappeared; the placeholder line and its
    // changed JSON framing cost a few dozen bytes of it back, so allow that
    // (a bounded slack, not the image's size: 512 B against ~1.4 MB of base64).
    const b64 = Buffer.from(bytes).toString("base64");
    expect(before.body.length - after.body.length).toBeGreaterThan(b64.length - 512);
  });

  test("Anthropic: 0 `type: image` blocks, and the same shrinkage", async () => {
    const before = await bodyOf("anthropic", turn1);
    const after = await bodyOf("anthropic", projected);
    expect(anthropicImages(before.parsed)).toBe(1);
    expect(anthropicImages(after.parsed)).toBe(0);
    const b64 = Buffer.from(bytes).toString("base64");
    expect(before.body.length - after.body.length).toBeGreaterThan(b64.length - 512);
  });

  test("the placeholder IS in the body: the bytes are replaced by the line, not dropped", async () => {
    const after = await bodyOf("anthropic", projected);
    expect(after.body).toContain("pruned by tentacle: image");
    expect(after.body).toContain(`image_view ${ref.id.slice(0, 12)}`);
    // One message in, one message out: the projection never shifts indices.
    expect(after.parsed.messages.length).toBe(
      (await bodyOf("anthropic", turn1)).parsed.messages.length,
    );
  });

  test("F11: the counter charges the placeholder's text, not the image", () => {
    // 3200 tokens per image (an override, so the difference is unmistakable).
    const counter = new HeuristicTokenCounter({ imageTokens: 3200 });
    const before = counter.countMessages(turn1);
    const after = counter.countMessages(projected);
    const line = (projected[1]?.content ?? "").length;
    // The saved image tokens MINUS the placeholder text that replaced them
    // (the user's own words are still there, and still charged).
    const savedText =
      counter.countText(projected[1]?.content ?? "") - counter.countText(turn1[1]?.content ?? "");
    expect(before - after).toBe(3200 - savedText);
    // Sanity: the placeholder's own text is cheap, not a second image.
    expect(counter.countText(projected[1]?.content ?? "")).toBeLessThan(200);
    expect(line).toBeGreaterThan(0);
  });
});
