import { describe, expect, test } from "bun:test";
import { ContentBlockSchema, text } from "../src/index.ts";

describe("content blocks", () => {
  test("text() helper builds a text block", () => {
    expect(text("hi")).toEqual({ type: "text", text: "hi" });
  });

  test("accepts text / image / resource blocks", () => {
    expect(ContentBlockSchema.safeParse({ type: "text", text: "a" }).success).toBe(true);
    expect(
      ContentBlockSchema.safeParse({ type: "image", mimeType: "image/png", data: "AAAA" }).success,
    ).toBe(true);
    expect(ContentBlockSchema.safeParse({ type: "resource", uri: "file:///x" }).success).toBe(true);
  });

  test("rejects an unknown block type", () => {
    expect(ContentBlockSchema.safeParse({ type: "video", url: "x" }).success).toBe(false);
  });

  test("image requires mimeType and data", () => {
    expect(ContentBlockSchema.safeParse({ type: "image", data: "AAAA" }).success).toBe(false);
    expect(
      ContentBlockSchema.safeParse({ type: "image", mimeType: "", data: "AAAA" }).success,
    ).toBe(false);
  });
});
