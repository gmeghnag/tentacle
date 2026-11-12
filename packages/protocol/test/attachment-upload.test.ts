/**
 * `attachment/put` on the wire (docs/feat/attachments-upload.md T1).
 *
 * The property: params are validated BEFORE any handler (P2, AGENTS §7), so a
 * malformed chunk, an oversize `data`, a wrong-shaped id, an empty blob or an
 * out-of-range size never reaches the store — and the method/result/error
 * shapes are the shared truth both ends bind to.
 */
import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_CHUNK_B64_MAX,
  ATTACHMENT_CHUNK_BYTES,
  AttachmentPutParamsSchema,
  AttachmentPutResultSchema,
  DomainErrorCode,
  MAX_IMAGE_BYTES,
  Method,
  RequestSchemas,
} from "../src/index.ts";

const ID = "a".repeat(64);
const params = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: "s1",
  id: ID,
  size: 4,
  offset: 0,
  data: Buffer.from("abcd").toString("base64"),
  ...over,
});

describe("AttachmentPutParamsSchema", () => {
  test("accepts a well-formed chunk", () => {
    expect(AttachmentPutParamsSchema.safeParse(params()).success).toBe(true);
  });

  test('a probe (`data: ""`) is valid, at any offset', () => {
    expect(AttachmentPutParamsSchema.safeParse(params({ data: "" })).success).toBe(true);
    expect(AttachmentPutParamsSchema.safeParse(params({ data: "", offset: 4 })).success).toBe(true);
  });

  test("the id must be a lowercase hex sha256", () => {
    for (const id of ["", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
      expect(AttachmentPutParamsSchema.safeParse(params({ id })).success).toBe(false);
    }
  });

  test("size is a positive integer within MAX_IMAGE_BYTES", () => {
    for (const size of [0, -1, 1.5, MAX_IMAGE_BYTES + 1]) {
      expect(AttachmentPutParamsSchema.safeParse(params({ size })).success).toBe(false);
    }
    expect(AttachmentPutParamsSchema.safeParse(params({ size: MAX_IMAGE_BYTES })).success).toBe(
      true,
    );
  });

  test("offset is a non-negative integer", () => {
    for (const offset of [-1, 0.5]) {
      expect(AttachmentPutParamsSchema.safeParse(params({ offset })).success).toBe(false);
    }
  });

  test("data is base64, capped at one chunk", () => {
    expect(AttachmentPutParamsSchema.safeParse(params({ data: "not base64!" })).success).toBe(
      false,
    );
    expect(
      AttachmentPutParamsSchema.safeParse(
        params({ data: "a".repeat(ATTACHMENT_CHUNK_B64_MAX + 1) }),
      ).success,
    ).toBe(false);
    // Exactly one chunk of raw bytes encodes to exactly the cap.
    const oneChunk = Buffer.alloc(ATTACHMENT_CHUNK_BYTES).toString("base64");
    expect(oneChunk.length).toBe(ATTACHMENT_CHUNK_B64_MAX);
    expect(AttachmentPutParamsSchema.safeParse(params({ data: oneChunk })).success).toBe(true);
  });

  test("`sessionId` is required", () => {
    const { sessionId: _drop, ...rest } = params();
    expect(AttachmentPutParamsSchema.safeParse(rest).success).toBe(false);
  });

  test("unknown fields are stripped, never refused (the forward-compat rule)", () => {
    const parsed = AttachmentPutParamsSchema.parse(params({ mimeType: "image/png" }));
    expect(Object.hasOwn(parsed, "mimeType")).toBe(false);
  });
});

describe("AttachmentPutResultSchema", () => {
  test("is `{have, complete}` and nothing else", () => {
    expect(AttachmentPutResultSchema.parse({ have: 4, complete: true, extra: 1 })).toEqual({
      have: 4,
      complete: true,
    });
    expect(AttachmentPutResultSchema.safeParse({ have: -1, complete: false }).success).toBe(false);
    expect(AttachmentPutResultSchema.safeParse({ have: 1 }).success).toBe(false);
  });
});

describe("the method registry", () => {
  test("`attachment/put` is a request method with its schemas", () => {
    expect(Method.AttachmentPut).toBe("attachment/put");
    expect(RequestSchemas[Method.AttachmentPut].params).toBe(AttachmentPutParamsSchema);
    expect(RequestSchemas[Method.AttachmentPut].result).toBe(AttachmentPutResultSchema);
  });

  test("its refusal code is additive and outside JSON-RPC's reserved range", () => {
    expect(DomainErrorCode.AttachmentRefused).toBe(-32016);
  });
});
