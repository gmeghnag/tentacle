/**
 * `artifact/list` + `artifact/read` on the wire (docs/feat/model-artifacts.md
 * T1, D1).
 *
 * The property this file pins: the artifact META is the shared truth both ends
 * bind to — a hostile or buggy daemon (a pod is not trusted, AGENTS §7) can
 * never hand a client a meta the client's own schema accepts as something else,
 * and the two new methods plus one error code are purely ADDITIVE: an older
 * peer fails none of them at `initialize`, and an older client's `tool_call_
 * update` still parses the new frame with the free `artifact` field stripped.
 *
 * Namespace access on purpose (`session-archive.test.ts`'s style): on a tree
 * without the artifact module every case fails on its ASSERTION, not on a
 * missing import.
 */
import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import * as P from "../src/index.ts";

type AnySchema = z.ZodTypeAny;
const parses = (schema: AnySchema | undefined, value: unknown): boolean | undefined =>
  schema?.safeParse(value).success;
const row = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const MetaSchema = P.ArtifactMetaSchema;
const ListParamsSchema = P.ArtifactListParamsSchema;
const ListResultSchema = P.ArtifactListResultSchema;
const ReadParamsSchema = P.ArtifactReadParamsSchema;
const ReadResultSchema = P.ArtifactReadResultSchema;
const methods = P.Method as Record<string, string>;
const codes = P.DomainErrorCode as Record<string, number>;
const requests = P.RequestSchemas as Record<string, { params: AnySchema; result: AnySchema }>;
const constants = row(P);
const kinds = constants.ARTIFACT_KINDS as readonly string[] | undefined;
const maxBytes = constants.MAX_ARTIFACT_BYTES as number | undefined;
const artifactKindOf = constants.artifactKindOf as ((meta: { kind: string }) => string) | undefined;

const SHA = "a".repeat(64);
const meta = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  artifactId: "report",
  version: 1,
  sha256: SHA,
  size: 1024,
  mimeType: "text/html",
  kind: "html",
  title: "report.html",
  callId: "call-1",
  createdAt: 1_700_000_000_000,
  ...over,
});

describe("ArtifactMetaSchema (T1.1)", () => {
  test("accepts a well-formed meta", () => {
    expect(parses(MetaSchema, meta())).toBe(true);
    expect(parses(MetaSchema, meta({ version: 2, source: "docs/a.html", width: 1280 }))).toBe(true);
  });

  test("`artifactId` is a model slug: no path, no traversal, no uppercase", () => {
    for (const artifactId of ["../x", "", "A1", "-a", "a/../b", "a".repeat(65), "a b"]) {
      expect(parses(MetaSchema, meta({ artifactId }))).toBe(false);
    }
    expect(parses(MetaSchema, meta({ artifactId: "a1" }))).toBe(true);
    expect(parses(MetaSchema, meta({ artifactId: "a".repeat(64) }))).toBe(true);
  });

  test("`title` carries no control character (it is a display line, nothing more)", () => {
    for (const title of ["", "a\nb", "a\tb", "x\u001b[2J", "a".repeat(121)]) {
      expect(parses(MetaSchema, meta({ title }))).toBe(false);
    }
    expect(parses(MetaSchema, meta({ title: "a".repeat(120) }))).toBe(true);
  });

  test("`source` is display-only too: no control character, at most 512 chars", () => {
    for (const source of ["a\nb", "a\tb", "x\u001b[2J", "a".repeat(513)]) {
      expect(parses(MetaSchema, meta({ source }))).toBe(false);
    }
    expect(parses(MetaSchema, meta({ source: "docs/a.html" }))).toBe(true);
  });

  test("`size` is positive and capped at MAX_ARTIFACT_BYTES (20 MiB)", () => {
    expect(maxBytes).toBe(20 * 1024 * 1024);
    for (const size of [0, -1, 1.5, (maxBytes ?? 0) + 1]) {
      expect(parses(MetaSchema, meta({ size }))).toBe(false);
    }
    expect(parses(MetaSchema, meta({ size: maxBytes }))).toBe(true);
  });

  test("`sha256` is a lowercase hex sha256 and `version` is a positive integer", () => {
    for (const sha256 of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
      expect(parses(MetaSchema, meta({ sha256 }))).toBe(false);
    }
    for (const version of [0, -1, 1.5]) {
      expect(parses(MetaSchema, meta({ version }))).toBe(false);
    }
  });

  test("`kind` and `mimeType` are FREE strings: a newer daemon's kind never refuses a frame", () => {
    // The `AttachmentRefSchema` rule: an enum would make a newer build's kind
    // malformed and the whole frame unreadable. Clients map it (`artifactKindOf`).
    expect(parses(MetaSchema, meta({ kind: "hologram" }))).toBe(true);
    expect(parses(MetaSchema, meta({ mimeType: "application/x-future+zip" }))).toBe(true);
    expect(parses(MetaSchema, meta({ kind: "" }))).toBe(false);
    expect(parses(MetaSchema, meta({ mimeType: "not-a-mime" }))).toBe(false);
  });

  test("image dimensions are bounded when present", () => {
    for (const width of [0, -1, 70000]) {
      expect(parses(MetaSchema, meta({ width }))).toBe(false);
    }
    expect(parses(MetaSchema, meta({ height: 65535 }))).toBe(true);
  });

  test("unknown fields are stripped, never refused (the forward-compat rule)", () => {
    const parsed = MetaSchema?.safeParse(meta({ evicted: true }));
    expect(parsed?.success && Object.hasOwn(row(parsed.data), "evicted")).toBe(false);
  });
});

describe("the free `artifact` field on tool_call_update (T1.2, T1.3)", () => {
  const update = (artifact: unknown) => ({
    type: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    content: [{ type: "text", text: "Presented …" }],
    artifact,
  });

  test("a valid artifact rides the update and keeps its meta", () => {
    const parsed = P.SessionUpdateSchema.safeParse(update(meta()));
    expect(parsed.success).toBe(true);
    expect(
      parsed.success && parsed.data.type === "tool_call_update" ? parsed.data.artifact : null,
    ).toEqual(MetaSchema?.parse(meta()));
  });

  test("a meta the schema refuses makes the FRAME invalid (a 2 GiB announcement dies at parse)", () => {
    expect(
      P.SessionUpdateSchema.safeParse(update(meta({ size: (maxBytes ?? 0) + 1 }))).success,
    ).toBe(false);
    expect(P.SessionUpdateSchema.safeParse(update(meta({ title: "a\nb" }))).success).toBe(false);
    expect(P.SessionUpdateSchema.safeParse(update(meta({ artifactId: "../x" }))).success).toBe(
      false,
    );
  });

  test("an OLDER client parses the frame and strips the field (forward compat)", () => {
    // The pre-field shape, and the same shape built by omitting it: both must
    // parse a NEW frame (so an old build shows the tool's text, no error).
    const older = P.ToolCallUpdateSchema.omit({ artifact: true });
    const parsedOlder = older.safeParse(update(meta()));
    expect(parsedOlder.success && Object.hasOwn(row(parsedOlder.data), "artifact")).toBe(false);
    const parsedFull = P.ToolCallUpdateSchema.safeParse(update(meta()));
    expect(parsedFull.success && parsedFull.data.artifact?.artifactId).toBe("report");
  });

  test("it is optional: a tool update without one still parses", () => {
    const { artifact: _dropped, ...plain } = update(meta());
    const parsed = P.ToolCallUpdateSchema.safeParse(plain);
    expect(parsed.success && !Object.hasOwn(row(parsed.data), "artifact")).toBe(true);
  });
});

describe("artifactKindOf — ONE pure mapping over the closed kind set (T1.4)", () => {
  test("the closed set every client branches on", () => {
    expect(kinds).toEqual(["image", "svg", "html", "pdf", "markdown", "text", "other"]);
  });

  test("a known kind passes through; anything else is `other`", () => {
    for (const kind of kinds ?? []) {
      expect(artifactKindOf?.({ kind })).toBe(kind);
    }
    expect(artifactKindOf?.({ kind: "hologram" })).toBe("other");
    expect(artifactKindOf?.({ kind: "" })).toBe("other");
  });
});

describe("the method registry (T1.4)", () => {
  test("`artifact/list` and `artifact/read` are request methods with their schemas", () => {
    expect(methods.ArtifactList).toBe("artifact/list");
    expect(methods.ArtifactRead).toBe("artifact/read");
    expect(requests["artifact/list"]?.params).toBe(ListParamsSchema);
    expect(requests["artifact/list"]?.result).toBe(ListResultSchema);
    expect(requests["artifact/read"]?.params).toBe(ReadParamsSchema);
    expect(requests["artifact/read"]?.result).toBe(ReadResultSchema);
  });

  test("list params/result: a session id in, bounded metas oldest-first out", () => {
    expect(parses(ListParamsSchema, { sessionId: "s1" })).toBe(true);
    expect(parses(ListParamsSchema, {})).toBe(false);
    expect(parses(ListParamsSchema, { sessionId: "" })).toBe(false);
    expect(parses(ListResultSchema, { artifacts: [meta()], truncated: false })).toBe(true);
    expect(parses(ListResultSchema, { artifacts: [] })).toBe(true);
    expect(parses(ListResultSchema, { artifacts: [meta({ size: 0 })] })).toBe(false);
    const many = Array.from({ length: 501 }, () => meta());
    expect(parses(ListResultSchema, { artifacts: many })).toBe(false);
    expect(parses(ListResultSchema, { artifacts: many.slice(0, 500) })).toBe(true);
  });

  test("read params/result: one aligned chunk of at most one chunk of bytes", () => {
    const chunk = Buffer.alloc(P.ATTACHMENT_CHUNK_BYTES).toString("base64");
    expect(parses(ReadParamsSchema, { sessionId: "s1", sha256: SHA, offset: 0 })).toBe(true);
    for (const offset of [-1, 0.5]) {
      expect(parses(ReadParamsSchema, { sessionId: "s1", sha256: SHA, offset })).toBe(false);
    }
    for (const sha256 of ["", "../x", "A".repeat(64)]) {
      expect(parses(ReadParamsSchema, { sessionId: "s1", sha256, offset: 0 })).toBe(false);
    }
    expect(parses(ReadResultSchema, { data: chunk, size: 1024 })).toBe(true);
    expect(parses(ReadResultSchema, { data: "", size: 1024 })).toBe(true);
    // The per-chunk cap, on a string that is VALID base64: `chunk` is 262144
    // raw bytes, so it ends in `==` and an appended tail would be refused by
    // the padding regex instead of by the cap (a vacuous test). `"A".repeat(n)`
    // with n a multiple of 4 is valid, unpadded base64 — only `.max` can refuse it.
    const b64Max = P.ATTACHMENT_CHUNK_B64_MAX;
    expect(parses(ReadResultSchema, { data: "A".repeat(b64Max), size: 1024 })).toBe(true);
    expect(parses(ReadResultSchema, { data: "A".repeat(b64Max + 4), size: 1024 })).toBe(false);
    expect(parses(ReadResultSchema, { data: "not base64!", size: 4 })).toBe(false);
    // `size` is the version's announced total: bounded like a meta's, so a
    // hostile read reply cannot announce 2 GiB through the schema.
    for (const size of [0, -1, 1.5, maxBytes === undefined ? 0 : maxBytes + 1, 2_147_483_648]) {
      expect(parses(ReadResultSchema, { data: chunk, size })).toBe(false);
    }
    expect(parses(ReadResultSchema, { data: chunk, size: maxBytes })).toBe(true);
  });

  test("its unavailable code is additive, free and unique", () => {
    expect(codes.ArtifactUnavailable).toBe(-32020);
    const all = Object.values(codes);
    expect(new Set(all).size).toBe(all.length);
  });

  test("additive only: no update kind, no version bump for S1", () => {
    // Two methods, one error code, one free FIELD on an existing display-class
    // update (AGENTS §7): nothing a peer must be told at `initialize`.
    expect(P.UPDATE_CLASS.tool_call_update).toBe("display");
    expect(P.KNOWN_UPDATE_TYPES).not.toContain("artifact_presented");
  });
});
