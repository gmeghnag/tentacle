import { describe, expect, test } from "bun:test";
import { classifyArtifact, imageDimensions } from "../src/artifact-kind.ts";

const enc = new TextEncoder();
const u8 = (...values: number[]) => new Uint8Array(values);
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function png(w: number, h: number): Uint8Array {
  return u8(
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...ascii("IHDR"),
    ...be32(w),
    ...be32(h),
    8,
    6,
    0,
    0,
    0,
  );
}
function jpeg(w: number, h: number): Uint8Array {
  // SOI, an APP0 segment (len 16), then SOF0 with height/width.
  return u8(
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...be16(16),
    ...ascii("JFIF"),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(h),
    ...be16(w),
    3,
  );
}
function gif(w: number, h: number): Uint8Array {
  return u8(...ascii("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0);
}
function webpX(w: number, h: number): Uint8Array {
  return u8(
    ...ascii("RIFF"),
    0,
    0,
    0,
    0,
    ...ascii("WEBPVP8X"),
    ...be32(0),
    0,
    0,
    0,
    0,
    ...le24(w - 1),
    ...le24(h - 1),
  );
}
function webpLossy(w: number, h: number): Uint8Array {
  return u8(
    ...ascii("RIFF"),
    0,
    0,
    0,
    0,
    ...ascii("WEBPVP8 "),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    ...le16(w),
    ...le16(h),
  );
}
function webpLossless(w: number, h: number): Uint8Array {
  const bits = (w - 1) | ((h - 1) << 14);
  return u8(
    ...ascii("RIFF"),
    0,
    0,
    0,
    0,
    ...ascii("WEBPVP8L"),
    0,
    0,
    0,
    0,
    0x2f,
    bits & 0xff,
    (bits >> 8) & 0xff,
    (bits >> 16) & 0xff,
    (bits >>> 24) & 0xff,
  );
}

describe("classifyArtifact — magic bytes first (D2)", () => {
  test("PNG / JPEG / GIF / WebP → image with dimensions", () => {
    expect(classifyArtifact(png(1280, 720), {})).toEqual({
      kind: "image",
      mimeType: "image/png",
      width: 1280,
      height: 720,
    });
    expect(classifyArtifact(jpeg(640, 480), {})).toEqual({
      kind: "image",
      mimeType: "image/jpeg",
      width: 640,
      height: 480,
    });
    expect(classifyArtifact(gif(32, 16), {})).toEqual({
      kind: "image",
      mimeType: "image/gif",
      width: 32,
      height: 16,
    });
    expect(classifyArtifact(webpX(300, 200), {})).toEqual({
      kind: "image",
      mimeType: "image/webp",
      width: 300,
      height: 200,
    });
    expect(classifyArtifact(webpLossy(100, 50), {})).toEqual({
      kind: "image",
      mimeType: "image/webp",
      width: 100,
      height: 50,
    });
    expect(classifyArtifact(webpLossless(7, 9), {})).toEqual({
      kind: "image",
      mimeType: "image/webp",
      width: 7,
      height: 9,
    });
  });

  test("an image whose header is truncated or out of range has no dimensions, never a guess", () => {
    expect(classifyArtifact(png(1, 1).slice(0, 12), {})).toEqual({
      kind: "image",
      mimeType: "image/png",
    });
    expect(imageDimensions(png(0, 5), "image/png")).toBeUndefined();
    expect(imageDimensions(png(70_000, 5), "image/png")).toBeUndefined();
    expect(imageDimensions(webpX(70_000, 5), "image/webp")).toBeUndefined();
    expect(imageDimensions(u8(0xff, 0xd8, 0xff, 0xe0, 0, 2), "image/jpeg")).toBeUndefined();
  });

  test("%PDF- → pdf", () => {
    expect(classifyArtifact(enc.encode("%PDF-1.7\n…"), { path: "x.txt" })).toEqual({
      kind: "pdf",
      mimeType: "application/pdf",
    });
  });

  test("SVG, HTML by content; .md / .html / .svg by extension", () => {
    expect(classifyArtifact(enc.encode('<?xml version="1.0"?>\n<svg xmlns="x"/>'), {}).kind).toBe(
      "svg",
    );
    expect(classifyArtifact(enc.encode("  <svg viewBox='0 0 1 1'></svg>"), {}).mimeType).toBe(
      "image/svg+xml",
    );
    expect(classifyArtifact(enc.encode("﻿<!DOCTYPE html><p>x"), {})).toEqual({
      kind: "html",
      mimeType: "text/html",
    });
    expect(classifyArtifact(enc.encode("<html><body>x"), {}).kind).toBe("html");
    expect(classifyArtifact(enc.encode("<div>x</div>"), { path: "out/page.HTM" }).kind).toBe(
      "html",
    );
    expect(classifyArtifact(enc.encode("# Title"), { path: "notes.md" })).toEqual({
      kind: "markdown",
      mimeType: "text/markdown",
    });
    expect(classifyArtifact(enc.encode("# Title"), {}).kind).toBe("text");
  });

  test("valid UTF-8 → text; NUL or invalid UTF-8 → other", () => {
    expect(classifyArtifact(enc.encode("hello ✓"), {})).toEqual({
      kind: "text",
      mimeType: "text/plain",
    });
    expect(classifyArtifact(u8(0x68, 0x00, 0x69), {}).kind).toBe("other");
    expect(classifyArtifact(u8(0xc3, 0x28, 0xa0, 0xa1), {})).toEqual({
      kind: "other",
      mimeType: "application/octet-stream",
    });
  });

  test("zip / gzip keep kind other with a precise mime", () => {
    expect(classifyArtifact(u8(0x50, 0x4b, 0x03, 0x04, 0, 0), { path: "a.html" })).toEqual({
      kind: "other",
      mimeType: "application/zip",
    });
    expect(classifyArtifact(u8(0x1f, 0x8b, 0x08, 0), {})).toEqual({
      kind: "other",
      mimeType: "application/gzip",
    });
  });

  test("a kind hint picks among TEXT kinds only; it never turns binary into a viewable kind", () => {
    expect(classifyArtifact(enc.encode("<!doctype html><p>x"), { kind: "text" }).kind).toBe("text");
    expect(classifyArtifact(enc.encode("a,b"), { kind: "html" }).kind).toBe("html");
    expect(classifyArtifact(enc.encode("x"), { kind: "svg" }).mimeType).toBe("image/svg+xml");
    expect(classifyArtifact(enc.encode("x"), { kind: "markdown" }).kind).toBe("markdown");
    expect(classifyArtifact(png(2, 2), { kind: "html" }).kind).toBe("image");
    expect(classifyArtifact(u8(0x50, 0x4b, 0x03, 0x04), { kind: "html" }).kind).toBe("other");
    expect(classifyArtifact(u8(0xc3, 0x28), { kind: "html" }).kind).toBe("other");
  });

  test("an empty input is text (the tool refuses empty content before it gets here)", () => {
    expect(classifyArtifact(new Uint8Array(0), {}).kind).toBe("text");
  });
});
