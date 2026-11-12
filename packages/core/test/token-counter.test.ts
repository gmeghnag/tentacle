import { describe, expect, test } from "bun:test";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_BYTES } from "@tentacle/protocol";
import {
  type AttachmentRef,
  HeuristicTokenCounter,
  IMAGE_TOKEN_ESTIMATE,
  InvalidAttachmentError,
  attachmentLabel,
  checkAttachmentRefs,
  formatBytes,
} from "../src/index.ts";
import type { ChatMessage } from "../src/index.ts";

describe("HeuristicTokenCounter", () => {
  const counter = new HeuristicTokenCounter();

  test("empty text counts as zero", () => {
    expect(counter.countText("")).toBe(0);
  });

  test("rounds up at ~4 chars per token", () => {
    expect(counter.countText("abcd")).toBe(1); // 4/4
    expect(counter.countText("abcde")).toBe(2); // ceil(5/4)
  });

  test("honours a custom charsPerToken", () => {
    const c = new HeuristicTokenCounter({ charsPerToken: 2 });
    expect(c.countText("abcd")).toBe(2);
  });

  test("rejects a non-positive charsPerToken", () => {
    expect(() => new HeuristicTokenCounter({ charsPerToken: 0 })).toThrow(RangeError);
  });

  test("counts a message with per-message overhead", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "abcd" }];
    // overhead(4) + content(1)
    expect(counter.countMessages(messages)).toBe(5);
  });

  test("includes tool calls in the message count", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "run", arguments: "{}" }],
      },
    ];
    // overhead(4) + content(0) + name "run"(1) + args "{}"(1)
    expect(counter.countMessages(messages)).toBe(6);
  });

  test("an inline image costs IMAGE_TOKEN_ESTIMATE (docs/feat/attachments-core.md, D4)", () => {
    const ref = { id: "a".repeat(64), mimeType: "image/png", size: 10 };
    const text: ChatMessage[] = [{ role: "user", content: "abcd" }];
    const withOne: ChatMessage[] = [{ role: "user", content: "abcd", attachments: [ref] }];
    expect(counter.countMessages(withOne)).toBe(counter.countMessages(text) + 1600);
    expect(IMAGE_TOKEN_ESTIMATE).toBe(1600);
    const twoRefs: ChatMessage[] = [
      {
        role: "user",
        content: "abcd",
        attachments: [ref, { ...ref, id: "b".repeat(64) }],
      },
    ];
    expect(counter.countMessages(twoRefs)).toBe(counter.countMessages(text) + 2 * 1600);
  });
});

describe("image refs at an entry point (docs/feat/attachments-core.md, D4)", () => {
  const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
    id: "a".repeat(64),
    mimeType: "image/png",
    size: 1234,
    ...over,
  });

  test("a sendable ref passes", () => {
    expect(() => checkAttachmentRefs([ref({ name: "cat.png" })])).not.toThrow();
    expect(() => checkAttachmentRefs([ref({ size: MAX_IMAGE_BYTES })])).not.toThrow();
  });

  test("an oversize image names the image and both numbers", () => {
    expect(() =>
      checkAttachmentRefs([ref({ size: MAX_IMAGE_BYTES + 1, name: "big.png" })]),
    ).toThrow(/big\.png sha256:aaaaaaaaaaaa: 15 MB is over the 15 MB limit/);
  });

  test("a type no provider takes is refused, naming it", () => {
    expect(() => checkAttachmentRefs([ref({ mimeType: "image/heic" })])).toThrow(
      InvalidAttachmentError,
    );
    expect(() => checkAttachmentRefs([ref({ mimeType: "image/heic" })])).toThrow(/image\/heic/);
  });

  test("the same image twice is refused", () => {
    expect(() => checkAttachmentRefs([ref(), ref()])).toThrow(/attached twice/);
  });

  test("six refs, a bad id and an empty list are refused by the schema's bounds", () => {
    const six = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, k) =>
      ref({ id: k.toString(16).padStart(64, "0") }),
    );
    expect(() => checkAttachmentRefs(six)).toThrow(InvalidAttachmentError);
    expect(() => checkAttachmentRefs([ref({ id: "nope" })])).toThrow(InvalidAttachmentError);
    expect(() => checkAttachmentRefs([])).toThrow(InvalidAttachmentError);
  });

  test("a label is the name (or the type), then the short hash", () => {
    expect(attachmentLabel(ref({ name: "cat.png" }))).toBe("cat.png sha256:aaaaaaaaaaaa");
    expect(attachmentLabel(ref({ mimeType: "image/gif" }))).toBe("image/gif sha256:aaaaaaaaaaaa");
    expect(attachmentLabel(ref({ name: "x".repeat(100) }))).toBe(
      `${"x".repeat(80)}… sha256:aaaaaaaaaaaa`,
    );
  });

  test("bytes read as a person says them", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 * 590)).toBe("590 KB");
    expect(formatBytes(MAX_IMAGE_BYTES)).toBe("15 MB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
