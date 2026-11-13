import { describe, expect, test } from "bun:test";
import {
  AgentCapabilitiesSchema,
  ContentBlockSchema,
  MAX_ATTACHMENTS_PER_MESSAGE,
  PromptParamsSchema,
  TurnStartSchema,
} from "../src/index.ts";

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

/**
 * `turn_start.attachments` (docs/feat/attachments-tui.md D1, T4): one additive
 * optional field, so another client's image prompt shows `[image: name]`. The
 * field is a STRIP schema member (an older client drops it, AGENTS §7), and a
 * malformed ref fails the frame exactly like any other bad `turn_start`.
 */
describe("turn_start.attachments", () => {
  const ref = { id: "a".repeat(64), mimeType: "image/png", size: 11, name: "shot.png" };

  test("a turn_start carries refs, and one without them still parses", () => {
    const withRefs = TurnStartSchema.safeParse({
      type: "turn_start",
      turnId: "t1",
      prompt: "what is this?",
      attachments: [ref],
    });
    expect(withRefs.success).toBe(true);
    if (withRefs.success) expect(withRefs.data.attachments).toEqual([ref]);

    // An image-only prompt: no text, one ref.
    const only = TurnStartSchema.safeParse({
      type: "turn_start",
      turnId: "t2",
      prompt: "",
      attachments: [ref],
    });
    expect(only.success).toBe(true);

    const plain = TurnStartSchema.safeParse({ type: "turn_start", turnId: "t3", prompt: "hi" });
    expect(plain.success).toBe(true);
    if (plain.success) expect(plain.data.attachments).toBeUndefined();
  });

  test("a malformed ref and one over the cap are rejected", () => {
    const bad = { ...ref, id: "not-hex" };
    expect(
      TurnStartSchema.safeParse({
        type: "turn_start",
        turnId: "t",
        prompt: "x",
        attachments: [bad],
      }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, k) => ({
      ...ref,
      id: String(k + 1).repeat(64),
    }));
    expect(
      TurnStartSchema.safeParse({
        type: "turn_start",
        turnId: "t",
        prompt: "x",
        attachments: tooMany,
      }).success,
    ).toBe(false);
  });
});
