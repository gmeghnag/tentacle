/**
 * Tool-result images on the wire (docs/feat/pdf-images.md D7, slice S1).
 *
 * The property: a TOOL message's refs reach the request the model sees as
 * images, only from bytes the provider verified (sha256 + size), within a
 * per-request tool budget SEPARATE from the user's K, and every ref that is not
 * inlined leaves a visible reason line — never a silent drop. Proved on the
 * captured HTTP body (injected `fetch`), per provider.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AttachmentRef, AttachmentSource, ChatMessage, ChatRequest } from "@tentacle/core";
import { AnthropicProvider, OpenAIProvider } from "../src/index.ts";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const b64 = (text: string): string => Buffer.from(bytesOf(text)).toString("base64");

function refFor(text: string, over: Partial<AttachmentRef> = {}): AttachmentRef {
  const bytes = bytesOf(text);
  return {
    id: createHash("sha256").update(bytes).digest("hex"),
    mimeType: "image/png",
    size: bytes.length,
    name: `${text}.png`,
    ...over,
  };
}

/** A source answering `answers[text]` (default: the matching bytes), counting reads. */
function sourceOf(
  texts: readonly string[],
  answers: Record<string, string> = {},
): AttachmentSource & { reads: number } {
  const byId = new Map(texts.map((t) => [refFor(t).id, answers[t] ?? t]));
  const source = {
    reads: 0,
    async read(ref: AttachmentRef): Promise<Uint8Array | null> {
      source.reads += 1;
      const text = byId.get(ref.id);
      return text === undefined ? null : bytesOf(text);
    },
  };
  return source;
}

const call = (id: string): ChatMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "fs_read", arguments: "{}" }],
});
const tool = (id: string, content: string, attachments?: AttachmentRef[]): ChatMessage =>
  attachments === undefined
    ? { role: "tool", content, toolCallId: id }
    : { role: "tool", content, toolCallId: id, attachments };

type Body = { messages: Record<string, unknown>[] };

function capture(sse: string): { fetch: typeof fetch; body: () => Body } {
  let last: Body | undefined;
  const f = (async (_url: string, init: RequestInit) => {
    last = JSON.parse(String(init.body)) as Body;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return {
    fetch: f,
    body: () => {
      if (last === undefined) {
        throw new Error("the provider sent no request");
      }
      return last;
    },
  };
}

const ANTHROPIC_SSE = [
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]
  .map((e) => `data: ${JSON.stringify(e)}\n\n`)
  .join("");
const OPENAI_SSE = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

async function anthropicBody(
  request: ChatRequest,
  config: { images?: boolean; maxToolImages?: number } = {},
): Promise<Body> {
  const cap = capture(ANTHROPIC_SSE);
  const provider = new AnthropicProvider({
    baseURL: "http://x/v1",
    model: "m",
    fetch: cap.fetch,
    ...config,
  });
  for await (const _ of provider.stream(request)) {
    // drain
  }
  return cap.body();
}

async function openaiBody(request: ChatRequest, config: { images?: boolean } = {}): Promise<Body> {
  const cap = capture(OPENAI_SSE);
  const provider = new OpenAIProvider({
    baseURL: "http://x/v1",
    model: "m",
    fetch: cap.fetch,
    ...config,
  });
  for await (const _ of provider.stream(request)) {
    // drain
  }
  return cap.body();
}

/** The `tool_result` blocks of an Anthropic body, in order. */
function toolResults(body: Body): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of body.messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as Record<string, unknown>[]) {
        if (b.type === "tool_result") {
          out.push(b);
        }
      }
    }
  }
  return out;
}

const blocksOf = (result: Record<string, unknown> | undefined): Record<string, unknown>[] =>
  Array.isArray(result?.content) ? (result.content as Record<string, unknown>[]) : [];
const imageData = (blocks: Record<string, unknown>[]): string[] =>
  blocks
    .filter((b) => b.type === "image")
    .map((b) => String((b.source as Record<string, unknown>).data));
const textOf = (result: Record<string, unknown> | undefined): string =>
  typeof result?.content === "string"
    ? result.content
    : blocksOf(result)
        .filter((b) => b.type === "text")
        .map((b) => String(b.text))
        .join("\n");

describe("Anthropic: a tool result carries its images", () => {
  test("a verified ref becomes an image block INSIDE the tool_result, after the text", async () => {
    const a = refFor("pic-a");
    const body = await anthropicBody({
      messages: [{ role: "user", content: "read" }, call("c1"), tool("c1", "Q1 [image p.1]", [a])],
      attachments: sourceOf(["pic-a"]),
    });
    const [result] = toolResults(body);
    const blocks = blocksOf(result);
    expect(blocks[0]).toEqual({ type: "text", text: "Q1 [image p.1]" });
    expect(imageData(blocks)).toEqual([b64("pic-a")]);
    expect(result?.tool_use_id).toBe("c1");
  });

  test("wrong bytes (sha mismatch) → no image, a visible reason line instead of a silent drop", async () => {
    const a = refFor("pic-a");
    const body = await anthropicBody({
      messages: [{ role: "user", content: "read" }, call("c1"), tool("c1", "Q1", [a])],
      attachments: sourceOf(["pic-a"], { "pic-a": "pic-X" }),
    });
    const [result] = toolResults(body);
    expect(imageData(blocksOf(result))).toEqual([]);
    expect(textOf(result)).toContain("Q1");
    expect(textOf(result)).toContain("[image unavailable — pic-a.png");
  });

  test("25 tool images → the newest 20 inlined, 5 reason lines; the user's K=5 is untouched", async () => {
    const userTexts = Array.from({ length: 6 }, (_, i) => `user-${i}`);
    const toolTexts = Array.from({ length: 25 }, (_, i) => `tool-${i}`);
    const body = await anthropicBody({
      messages: [
        { role: "user", content: "look", attachments: userTexts.map((t) => refFor(t)) },
        call("c1"),
        tool(
          "c1",
          "pages 1-100",
          toolTexts.slice(0, 10).map((t) => refFor(t)),
        ),
        call("c2"),
        tool(
          "c2",
          "pages 101-200",
          toolTexts.slice(10).map((t) => refFor(t)),
        ),
      ],
      attachments: sourceOf([...userTexts, ...toolTexts]),
    });
    const userBlocks = body.messages[0]?.content as Record<string, unknown>[];
    expect(imageData(userBlocks)).toEqual(userTexts.slice(1).map(b64));
    const [older, newer] = toolResults(body);
    expect(imageData(blocksOf(newer))).toEqual(toolTexts.slice(10).map(b64));
    expect(imageData(blocksOf(older))).toEqual(toolTexts.slice(5, 10).map(b64));
    const lines = textOf(older)
      .split("\n")
      .filter((l) => l.includes("only the newest 20 tool-result images are sent"));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("tool-0.png");
  });

  test("maxToolImages bounds the tool budget", async () => {
    const texts = ["t-0", "t-1", "t-2"];
    const body = await anthropicBody(
      {
        messages: [
          call("c1"),
          tool(
            "c1",
            "r",
            texts.map((t) => refFor(t)),
          ),
        ],
        attachments: sourceOf(texts),
      },
      { maxToolImages: 2 },
    );
    const [result] = toolResults(body);
    expect(imageData(blocksOf(result))).toEqual(["t-1", "t-2"].map(b64));
    expect(textOf(result)).toContain("only the newest 2 tool-result images are sent");
  });

  test("the same picture in two results is sent ONCE (in the newer), the older says so", async () => {
    const a = refFor("same");
    const body = await anthropicBody({
      messages: [call("c1"), tool("c1", "p.30", [a]), call("c2"), tool("c2", "p.31", [a])],
      attachments: sourceOf(["same"]),
    });
    const [older, newer] = toolResults(body);
    expect(imageData(blocksOf(newer))).toEqual([b64("same")]);
    expect(imageData(blocksOf(older))).toEqual([]);
    expect(textOf(older)).toContain("the same image is in a newer tool result — same.png");
  });

  test("no vision → ONE line for the result, no image, no byte read", async () => {
    const texts = ["n-0", "n-1", "n-2"];
    const source = sourceOf(texts);
    const body = await anthropicBody(
      {
        messages: [
          call("c1"),
          tool(
            "c1",
            "Q",
            texts.map((t) => refFor(t)),
          ),
        ],
        attachments: source,
      },
      { images: false },
    );
    const [result] = toolResults(body);
    expect(result?.content).toBe(
      "Q\n[3 images in this result not sent: this model does not take images]",
    );
    expect(source.reads).toBe(0);
  });

  test("parallel tool results still collapse into ONE user turn; a ref-less result stays a string", async () => {
    const a = refFor("par");
    const body = await anthropicBody({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "fs_read", arguments: "{}" },
            { id: "c2", name: "fs_read", arguments: "{}" },
          ],
        },
        tool("c1", "plain"),
        tool("c2", "with image", [a]),
      ],
      attachments: sourceOf(["par"]),
    });
    const turns = body.messages.filter((m) => m.role === "user");
    expect(turns).toHaveLength(1);
    const results = toolResults(body);
    expect(results.map((r) => r.tool_use_id)).toEqual(["c1", "c2"]);
    expect(results[0]?.content).toBe("plain");
    expect(imageData(blocksOf(results[1]))).toEqual([b64("par")]);
  });
});

describe("OpenAI-compatible: tool images ride a wire-only user message", () => {
  const history = (a: AttachmentRef, b: AttachmentRef): ChatMessage[] => [
    { role: "user", content: "read" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "fs_read", arguments: "{}" },
        { id: "c2", name: "fs_read", arguments: "{}" },
      ],
    },
    tool("c1", "first", [a]),
    tool("c2", "second", [b]),
    { role: "assistant", content: "seen" },
  ];

  test("vision on: ONE user message right after the run's last tool message, images in order", async () => {
    const a = refFor("o-a");
    const b = refFor("o-b");
    const body = await openaiBody(
      { messages: history(a, b), attachments: sourceOf(["o-a", "o-b"]) },
      { images: true },
    );
    expect(body.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
      "assistant",
    ]);
    expect(body.messages[2]?.content).toBe("first");
    expect(body.messages[3]?.content).toBe("second");
    const parts = body.messages[4]?.content as Record<string, unknown>[];
    expect(parts[0]?.type).toBe("text");
    expect(String(parts[0]?.text)).toMatch(
      /^\[images from the tool results above — call c1: o-a\.png[^;]*; call c2: o-b\.png[^;]*\]$/,
    );
    expect(parts.slice(1).map((p) => (p.image_url as Record<string, unknown>).url)).toEqual([
      `data:image/png;base64,${b64("o-a")}`,
      `data:image/png;base64,${b64("o-b")}`,
    ]);
  });

  test("vision off (the default): no image part anywhere, one line per result, no read", async () => {
    const a = refFor("o-a");
    const b = refFor("o-b");
    const source = sourceOf(["o-a", "o-b"]);
    const body = await openaiBody({ messages: history(a, b), attachments: source });
    expect(JSON.stringify(body)).not.toContain("image_url");
    expect(body.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(body.messages[2]?.content).toBe(
      "first\n[1 image in this result not sent: this model does not take images]",
    );
    expect(source.reads).toBe(0);
  });

  test("vision on, wrong bytes: no follow-up message, the tool message names the ref", async () => {
    const a = refFor("o-a");
    const b = refFor("o-b");
    const body = await openaiBody(
      {
        messages: history(a, b),
        attachments: sourceOf(["o-a", "o-b"], { "o-a": "x", "o-b": "y" }),
      },
      { images: true },
    );
    expect(JSON.stringify(body)).not.toContain("image_url");
    expect(String(body.messages[2]?.content)).toContain("[image unavailable — o-a.png");
  });
});
