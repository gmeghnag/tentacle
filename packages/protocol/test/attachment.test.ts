/**
 * Image refs on a message survive both message schemas
 * (docs/feat/attachments-core.md, D1; repro r2/r3).
 *
 * `ChatMessageSchema` and `WireChatMessageSchema` are STRIP schemas (AGENTS §7),
 * so a field they do not name is silently dropped: before this change an
 * `attachments` array vanished without an error at the session seed, on
 * `session/log` and on the pod tunnel's `model/stream`. The proofs below are the
 * exact parses of repro *r2* and *r3* — RED on the base, both said
 * `attachments kept=false`.
 */
import { describe, expect, test } from "bun:test";
import {
  type AttachmentRef,
  AttachmentsSchema,
  ChatMessageSchema,
  IMAGE_MIME_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  WireChatMessageSchema,
} from "../src/index.ts";

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 1234,
  ...over,
});

const userWith = (attachments: unknown): Record<string, unknown> => ({
  role: "user",
  content: "what is in this picture?",
  attachments,
});

describe("the two message schemas keep attachments (r2, r3)", () => {
  test("ChatMessageSchema keeps refs deep-equal", () => {
    const parsed = ChatMessageSchema.parse(userWith([ref({ name: "cat.png" })]));
    expect(parsed.attachments).toEqual([ref({ name: "cat.png" })]);
  });

  test("WireChatMessageSchema keeps refs deep-equal", () => {
    const parsed = WireChatMessageSchema.parse(userWith([ref()]));
    expect(parsed.attachments).toEqual([ref()]);
  });

  test("a message without refs has no key (never an empty array)", () => {
    expect(ChatMessageSchema.parse({ role: "user", content: "hi" })).not.toHaveProperty(
      "attachments",
    );
  });

  test("the caps are the owner's: 15 MB per image, 5 per message", () => {
    expect(MAX_IMAGE_BYTES).toBe(15 * 1024 * 1024);
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(5);
    expect([...IMAGE_MIME_TYPES]).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  });
});

describe("a malformed ref is refused, never repaired", () => {
  const bad: Record<string, unknown> = {
    "an id that is not a lowercase sha256": ref({ id: "A".repeat(64) as never }),
    "an id that is short": ref({ id: "abc" }),
    "size 0": ref({ size: 0 }),
    "a negative size": ref({ size: -1 }),
    "a non-integer size": ref({ size: 1.5 }),
    "a MIME type that is not image/*": ref({ mimeType: "text/plain" }),
    "an empty MIME type": ref({ mimeType: "" }),
    "a control character in the name": ref({ name: "cat\n.png" }),
    "an empty name": ref({ name: "" }),
  };

  for (const [why, value] of Object.entries(bad)) {
    test(why, () => {
      expect(ChatMessageSchema.safeParse(userWith([value])).success).toBe(false);
    });
  }

  test("an empty array is not a valid attachment list", () => {
    expect(AttachmentsSchema.safeParse([]).success).toBe(false);
    expect(ChatMessageSchema.safeParse(userWith([])).success).toBe(false);
  });

  test(`${MAX_ATTACHMENTS_PER_MESSAGE + 1} refs are refused`, () => {
    const six = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, k) =>
      ref({ id: k.toString(16).padStart(64, "0") }),
    );
    expect(AttachmentsSchema.safeParse(six).success).toBe(false);
  });

  test("a type outside the four is ACCEPTED: the field is a free string", () => {
    // A ref rides CRITICAL log entries; an enum would make a newer build's
    // `image/heic` malformed and refuse the whole log (the MessageNote rule).
    expect(AttachmentsSchema.safeParse([ref({ mimeType: "image/heic" })]).success).toBe(true);
  });
});
