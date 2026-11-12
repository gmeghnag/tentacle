/**
 * Images and compaction (docs/feat/attachments-core.md, D5/D6, T12; owner Q6).
 *
 * The decision is that images do NOT survive compaction: the rebuilt history is
 * text only. What must NOT happen is that the summariser is never told an image
 * existed — it would then write a briefing about a conversation it believes was
 * words only. So the transcript carries `[image: name sha256:…]` in the ref's
 * slot, and the rebuilt history carries no `attachments` at all.
 */
import { describe, expect, test } from "bun:test";
import type {
  AttachmentRef,
  ChatMessage,
  ChatRequest,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { compactedHistory, summarizeConversation } from "../src/compact.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "text", delta: "the summary" };
    yield { type: "done" };
  }
}

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "abc123".padEnd(64, "0"),
  mimeType: "image/png",
  size: 99,
  name: "cat.png",
  ...over,
});

const transcriptOf = (model: ScriptedProvider): string =>
  String(model.requests[0]?.messages[1]?.content ?? "");

describe("the summariser is told an image existed", () => {
  test("its line carries the name and the short hash, in the message's own line", async () => {
    const model = new ScriptedProvider();
    const messages: ChatMessage[] = [
      { role: "user", content: "what is this?", attachments: [ref()] },
      { role: "assistant", content: "a cat" },
    ];
    await summarizeConversation(model, messages);
    const transcript = transcriptOf(model);
    expect(transcript).toContain("USER: what is this? [image: cat.png sha256:abc123000000]");
  });

  test("two images on one message give two lines; an unnamed one shows its type", async () => {
    const model = new ScriptedProvider();
    await summarizeConversation(model, [
      {
        role: "user",
        content: "",
        attachments: [ref(), ref({ id: "d".repeat(64), name: undefined, mimeType: "image/gif" })],
      },
      { role: "assistant", content: "ok" },
    ]);
    const transcript = transcriptOf(model);
    expect(transcript).toContain("[image: cat.png sha256:abc123000000]");
    expect(transcript).toContain(`[image: image/gif sha256:${"d".repeat(12)}]`);
  });

  test("a message without refs is untouched (no stray `[image:` line)", async () => {
    const model = new ScriptedProvider();
    await summarizeConversation(model, [
      { role: "user", content: "plain" },
      { role: "assistant", content: "ok" },
    ]);
    expect(transcriptOf(model)).not.toContain("[image:");
  });
});

describe("images do NOT survive the rebuilt history (owner Q6)", () => {
  test("compactedHistory keeps no refs, and the carried system prompt keeps none either", () => {
    const withRefs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "what is this?", attachments: [ref()] },
      { role: "assistant", content: "a cat" },
    ];
    const history = compactedHistory(withRefs, "a briefing");
    for (const message of history) {
      expect(message).not.toHaveProperty("attachments");
    }
    expect(history.map((m) => m.role)).toEqual(["system", "user"]);
  });
});
