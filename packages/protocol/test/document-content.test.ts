/**
 * The attached-document wire (docs/feat/pdf-read.md D4, slice P4): the
 * prompt-only `document` block, the `documents` capability and the fail-soft
 * `ChatMessage.media` field.
 */
import { describe, expect, test } from "bun:test";
import {
  AgentCapabilitiesSchema,
  ChatMessageSchema,
  DocumentContentSchema,
  KnownLogEntrySchema,
  MAX_DOCUMENT_TEXT_CHARS,
  MAX_IMAGE_BYTES,
  PromptContentBlockSchema,
  PromptParamsSchema,
} from "../src/index.ts";

const ID = "a".repeat(64);

describe("document content block", () => {
  test("parses both sources and joins the prompt union", () => {
    const ref = {
      type: "document",
      kind: "pdf",
      name: "r.pdf",
      source: { type: "ref", id: ID, size: 9 },
    } as const;
    const text = {
      type: "document",
      kind: "pdf",
      name: "r.pdf",
      source: { type: "text", text: "hi", pages: 2 },
    } as const;
    expect(DocumentContentSchema.parse(ref)).toEqual(ref);
    expect(DocumentContentSchema.parse(text)).toEqual(text);
    expect(PromptContentBlockSchema.parse(ref)).toEqual(ref);
    expect(
      PromptParamsSchema.safeParse({ sessionId: "s", turnId: "t", content: [text] }).success,
    ).toBe(true);
  });

  test("ONE source by its tag: the other source's fields never ride along", () => {
    // A ref naming text too reads as a ref (strip rule), never as both.
    const both = DocumentContentSchema.parse({
      type: "document",
      kind: "pdf",
      name: "r.pdf",
      source: { type: "ref", id: ID, size: 9, text: "x", pages: 1 },
    });
    expect(both.source).toEqual({ type: "ref", id: ID, size: 9 });
  });

  test("refuses no source, an over-cap text, a bad name, an unknown kind, a bad ref", () => {
    const base = { type: "document", kind: "pdf", name: "r.pdf" };
    const ok = (value: unknown) => DocumentContentSchema.safeParse(value).success;
    const txt = (text: string) => ({ type: "text", text, pages: 1 });
    expect(ok({ ...base, source: {} })).toBe(false);
    expect(ok({ ...base, source: { text: "x", pages: 1 } })).toBe(false);
    expect(ok(base)).toBe(false);
    expect(ok({ ...base, source: txt("x".repeat(MAX_DOCUMENT_TEXT_CHARS + 1)) })).toBe(false);
    expect(ok({ ...base, source: txt("x".repeat(MAX_DOCUMENT_TEXT_CHARS)) })).toBe(true);
    expect(ok({ ...base, name: "a\u001bb", source: txt("x") })).toBe(false);
    expect(ok({ ...base, name: "a\u0085b", source: txt("x") })).toBe(false);
    expect(ok({ ...base, kind: "audio", source: txt("x") })).toBe(false);
    expect(ok({ ...base, source: { type: "ref", id: "nothex", size: 9 } })).toBe(false);
    expect(ok({ ...base, source: { type: "ref", id: ID, size: MAX_IMAGE_BYTES + 1 } })).toBe(false);
  });
});

describe("ChatMessage.media", () => {
  test("a valid entry round-trips; a free kind (audio) needs no schema change", () => {
    const media = [
      { kind: "pdf", name: "r.pdf", pages: 12, chars: 3000 },
      { kind: "audio", name: "memo.m4a" },
    ];
    expect(ChatMessageSchema.parse({ role: "user", content: "x", media }).media).toEqual(media);
  });

  test("a media value this build cannot read is DROPPED, never a refusal: the message loads", () => {
    // Mutation: drop `.catch(undefined)` from `media` in session.ts → each line refuses → red.
    const media = (value: unknown) =>
      ChatMessageSchema.parse({ role: "user", content: "x", media: value }).media;
    expect(media([{ kind: "", name: "r.pdf" }])).toBeUndefined();
    expect(media([{ kind: "pdf", name: "a\nb" }])).toBeUndefined();
    expect(
      media(Array.from({ length: 6 }, () => ({ kind: "pdf", name: "r.pdf" }))),
    ).toBeUndefined();
    expect(media("pdf")).toBeUndefined();
    expect(
      ChatMessageSchema.parse({ role: "user", content: "hello", media: [{ kind: 1 }] }),
    ).toEqual({ role: "user", content: "hello" });
  });

  test("a CRITICAL `message` log entry with an unreadable media value still loads", () => {
    // Mutation: drop `.catch(undefined)` from `media` → the entry is refused → red
    // (and a critical refused entry makes the whole log unloadable).
    const entry = {
      type: "message",
      seq: 1,
      id: "i/1",
      ts: 1,
      critical: true,
      message: { role: "user", content: "<file …>", media: [{ kind: "PDF!", name: "r.pdf" }] },
    };
    const parsed = KnownLogEntrySchema.parse(entry);
    expect(parsed.type === "message" ? parsed.message : null).toEqual({
      role: "user",
      content: "<file …>",
    });
  });
});

describe("documents capability", () => {
  test("free strings; an unreadable value is dropped, never a refused initialize", () => {
    const caps = (documents: unknown) =>
      AgentCapabilitiesSchema.parse({ tools: true, permissions: true, documents }).documents;
    expect(caps({ input: "upload", maxBytes: 5, kinds: ["pdf"] })).toEqual({
      input: "upload",
      maxBytes: 5,
      kinds: ["pdf"],
    });
    expect(caps({ input: "from-the-future", kinds: ["pdf", "epub"] })).toEqual({
      input: "from-the-future",
      kinds: ["pdf", "epub"],
    });
    expect(caps({ input: "", kinds: [] })).toBeUndefined();
    expect(caps(undefined)).toBeUndefined();
  });
});
