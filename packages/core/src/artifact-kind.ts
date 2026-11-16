/**
 * What a presented artifact IS, from its bytes (docs/feat/model-artifacts.md D2).
 *
 * The kind decides which viewer runs and whether an OS opener may ever be
 * handed the file, so it comes from the BYTES first (magic numbers), never from
 * a model-chosen name: a PNG is an image even when named `.html`, and a ZIP is
 * `other` (never opened, only saved/shared) even when the model says "html".
 * Only among TEXT kinds does a hint (`kind`) or an extension choose.
 *
 * Pure: no I/O. The wire's `kind` stays a free string; clients narrow it with
 * `artifactKindOf` (`@tentacle/protocol`, S1) — this module only PRODUCES kinds.
 */
import type { ArtifactKind } from "@tentacle/protocol";
import { sniffImageType } from "./image-sniff.ts";

/** The kinds a caller may ask for explicitly (generated `content`). */
export type ArtifactTextKind = "html" | "markdown" | "svg" | "text";

export interface ArtifactClassification {
  readonly kind: ArtifactKind;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
}

/** Largest image side the wire carries (`ArtifactMetaSchema` width/height). */
const MAX_SIDE = 65535;

const TEXT_MIME: Readonly<Record<ArtifactTextKind, string>> = {
  html: "text/html",
  markdown: "text/markdown",
  svg: "image/svg+xml",
  text: "text/plain",
};

/** How many leading characters the text sniff looks at. */
const TEXT_HEAD_CHARS = 1024;

function u16be(b: Uint8Array, i: number): number | undefined {
  const hi = b[i];
  const lo = b[i + 1];
  return hi === undefined || lo === undefined ? undefined : (hi << 8) | lo;
}

function u16le(b: Uint8Array, i: number): number | undefined {
  const lo = b[i];
  const hi = b[i + 1];
  return hi === undefined || lo === undefined ? undefined : (hi << 8) | lo;
}

function u24le(b: Uint8Array, i: number): number | undefined {
  const low = u16le(b, i);
  const hi = b[i + 2];
  return low === undefined || hi === undefined ? undefined : low | (hi << 16);
}

function u32be(b: Uint8Array, i: number): number | undefined {
  const hi = u16be(b, i);
  const lo = u16be(b, i + 2);
  return hi === undefined || lo === undefined ? undefined : hi * 0x10000 + lo;
}

function sides(width: number | undefined, height: number | undefined) {
  if (width === undefined || height === undefined) {
    return undefined;
  }
  const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_SIDE;
  return ok(width) && ok(height) ? { width, height } : undefined;
}

/** JPEG: walk the marker segments to the first SOFn (not DHT/JPG/DAC). */
function jpegSides(b: Uint8Array) {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) {
      return undefined;
    }
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers: no length
      continue;
    }
    const length = u16be(b, i + 2);
    if (length === undefined || length < 2) {
      return undefined;
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return sides(u16be(b, i + 7), u16be(b, i + 5));
    }
    i += 2 + length;
  }
  return undefined;
}

function webpSides(b: Uint8Array) {
  const chunk = String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0);
  if (chunk === "VP8X") {
    const w = u24le(b, 24);
    const h = u24le(b, 27);
    return sides(w === undefined ? undefined : w + 1, h === undefined ? undefined : h + 1);
  }
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
      return undefined;
    }
    const w = u16le(b, 26);
    const h = u16le(b, 28);
    return sides(
      w === undefined ? undefined : w & 0x3fff,
      h === undefined ? undefined : h & 0x3fff,
    );
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f || b.length < 25) {
      return undefined;
    }
    const bits =
      ((b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)) >>> 0;
    return sides((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return undefined;
}

/**
 * An image's pixel size from its header, or undefined when the header is
 * truncated, malformed or out of the wire's 1..65535 range — never a guess.
 */
export function imageDimensions(
  bytes: Uint8Array,
  mimeType: string,
): { readonly width: number; readonly height: number } | undefined {
  switch (mimeType) {
    case "image/png":
      return sides(u32be(bytes, 16), u32be(bytes, 20));
    case "image/gif":
      return sides(u16le(bytes, 6), u16le(bytes, 8));
    case "image/jpeg":
      return jpegSides(bytes);
    case "image/webp":
      return webpSides(bytes);
    default:
      return undefined;
  }
}

/** Binary signatures that are NOT viewable: kind `other`, with a precise mime. */
function otherMime(b: Uint8Array): string {
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    return "application/zip";
  }
  if (b[0] === 0x1f && b[1] === 0x8b) {
    return "application/gzip";
  }
  return "application/octet-stream";
}

/** The text of `bytes` if it is valid UTF-8 without NUL, else undefined. */
function utf8Text(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function extensionOf(path: string | undefined): string {
  const name = path?.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function textKind(text: string, path: string | undefined): ArtifactTextKind {
  const head = text.slice(0, TEXT_HEAD_CHARS).replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return "html";
  }
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "svg";
  }
  switch (extensionOf(path)) {
    case "html":
    case "htm":
      return "html";
    case "svg":
      return "svg";
    case "md":
    case "markdown":
      return "markdown";
    default:
      return "text";
  }
}

/**
 * Classify a version's bytes. Order: image / PDF magic → binary (`other`) →
 * the caller's text `kind` hint → text sniff (`<svg`, `<!doctype html`) →
 * extension (`.md`, `.html`, `.svg`) → `text`. HEIC is `other`: not every
 * viewer renders it.
 */
export function classifyArtifact(
  bytes: Uint8Array,
  hints: { readonly path?: string; readonly kind?: ArtifactTextKind },
): ArtifactClassification {
  const image = sniffImageType(bytes);
  if (image.kind === "image") {
    const dims = imageDimensions(bytes, image.mimeType);
    return { kind: "image", mimeType: image.mimeType, ...dims };
  }
  if (image.kind === "heic") {
    return { kind: "other", mimeType: "image/heic" };
  }
  if (String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") {
    return { kind: "pdf", mimeType: "application/pdf" };
  }
  // A known archive signature is binary even when its first bytes decode as
  // UTF-8 (`PK\x03\x04` does): checked before the text path.
  const binary = otherMime(bytes);
  const text = binary === "application/octet-stream" ? utf8Text(bytes) : undefined;
  if (text === undefined) {
    return { kind: "other", mimeType: binary };
  }
  const kind = hints.kind ?? textKind(text, hints.path);
  return { kind, mimeType: TEXT_MIME[kind] };
}
