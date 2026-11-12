import { describe, expect, test } from "bun:test";
import { AgentCapabilitiesSchema, ContentBlockSchema, PromptParamsSchema } from "../src/index.ts";

const ref = {
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 11,
};

describe("PromptContentBlockSchema", () => {
  test("accepts a text + attachment sequence and an attachment-only prompt", () => {
    const mixed = PromptParamsSchema.safeParse({
      sessionId: "S",
      turnId: "t1",
      content: [
        { type: "text", text: "what is this?" },
        { type: "attachment", ref },
      ],
    });
    expect(mixed.success).toBe(true);

    const only = PromptParamsSchema.safeParse({
      sessionId: "S",
      turnId: "t2",
      content: [{ type: "attachment", ref }],
    });
    expect(only.success).toBe(true);
  });

  test("rejects a malformed ref", () => {
    expect(
      PromptParamsSchema.safeParse({
        sessionId: "S",
        turnId: "t1",
        content: [{ type: "attachment", ref: { id: "not-hex", mimeType: "image/png", size: 1 } }],
      }).success,
    ).toBe(false);
    expect(
      PromptParamsSchema.safeParse({
        sessionId: "S",
        turnId: "t1",
        content: [
          { type: "attachment", ref: { id: "a".repeat(64), mimeType: "text/plain", size: 1 } },
        ],
      }).success,
    ).toBe(false);
  });

  test("the update-side ContentBlockSchema still rejects an attachment block", () => {
    expect(ContentBlockSchema.safeParse({ type: "attachment", ref }).success).toBe(false);
  });
});

describe("AgentCapabilitiesSchema.images", () => {
  test("parses upload with a max, an unknown input, and no images at all", () => {
    const upload = AgentCapabilitiesSchema.safeParse({
      images: { input: "upload", maxBytes: 3932160 },
    });
    expect(upload.success).toBe(true);
    if (upload.success) {
      expect(upload.data.images).toEqual({ input: "upload", maxBytes: 3932160 });
    }

    const client = AgentCapabilitiesSchema.safeParse({ images: { input: "client" } });
    expect(client.success).toBe(true);

    const unknown = AgentCapabilitiesSchema.safeParse({ images: { input: "some-future-mode" } });
    expect(unknown.success).toBe(true);

    const none = AgentCapabilitiesSchema.safeParse({});
    expect(none.success).toBe(true);
    if (none.success) expect(none.data.images).toBeUndefined();
  });

  test("rejects an empty input and a non-positive maxBytes", () => {
    expect(AgentCapabilitiesSchema.safeParse({ images: { input: "" } }).success).toBe(false);
    expect(
      AgentCapabilitiesSchema.safeParse({ images: { input: "upload", maxBytes: 0 } }).success,
    ).toBe(false);
  });
});
