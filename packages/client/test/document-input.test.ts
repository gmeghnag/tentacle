/**
 * `documentsInput` — where a PDF's extraction happens, decided once
 * (docs/feat/pdf-read.md D6).
 *
 * The table's property, and the reason it is pure: the ONE case that must never
 * be guessed is a daemon asking for an UPLOAD while this client serves its model
 * (a pod) — believing it puts PDF bytes inside the pod (AGENTS §7). The rest is
 * the same shape as `imageInput`'s, one kind over.
 */
import { describe, expect, test } from "bun:test";
import { MAX_DOCUMENT_BYTES, OLD_DAEMON_DOCUMENTS, documentsInput } from "../src/document-input.ts";

const LAPTOP = { servesModel: true, extracts: true };
const DAEMON = { servesModel: false };

describe("no capability", () => {
  test("off, with the ONE update sentence every surface shares", () => {
    expect(documentsInput(undefined, DAEMON)).toEqual({
      kind: "off",
      reason: OLD_DAEMON_DOCUMENTS,
    });
    // The same answer whether or not this client serves the model: absent is
    // absent (there is no model config behind a missing PDF reader).
    expect(documentsInput(undefined, LAPTOP)).toEqual({
      kind: "off",
      reason: OLD_DAEMON_DOCUMENTS,
    });
  });
});

describe("upload: the daemon runs the model and extracts", () => {
  test("a daemon that names pdf uploads, capped by what it advertises", () => {
    expect(documentsInput({ input: "upload", maxBytes: 4000, kinds: ["pdf"] }, DAEMON)).toEqual({
      kind: "upload",
      maxBytes: 4000,
    });
  });

  test("no advertised cap means the wire's own default", () => {
    expect(documentsInput({ input: "upload", kinds: ["pdf"] }, DAEMON)).toEqual({
      kind: "upload",
      maxBytes: MAX_DOCUMENT_BYTES,
    });
  });

  test("a cap over the wire's is clamped (an upload the store would refuse)", () => {
    const got = documentsInput(
      { input: "upload", maxBytes: MAX_DOCUMENT_BYTES * 4, kinds: ["pdf"] },
      DAEMON,
    );
    expect(got.kind).toBe("upload");
    if (got.kind === "upload") expect(got.maxBytes).toBe(MAX_DOCUMENT_BYTES);
  });
});

describe("client: a pod, so the LAPTOP extracts", () => {
  test("a pod with an extractor here: `laptop`", () => {
    expect(documentsInput({ input: "client", kinds: ["pdf"] }, LAPTOP)).toEqual({
      kind: "laptop",
      maxBytes: MAX_DOCUMENT_BYTES,
    });
  });

  test("a pod and no extractor on this build: OFF, never an upload", () => {
    const got = documentsInput({ input: "client", kinds: ["pdf"] }, { servesModel: true });
    expect(got.kind).toBe("off");
  });

  test("a `client` daemon talking to a client that serves no model: off", () => {
    expect(documentsInput({ input: "client", kinds: ["pdf"] }, DAEMON).kind).toBe("off");
  });
});

describe("the AGENTS §7 gate: an upload asked for by a client that serves the model", () => {
  test("off, and the reason says nothing is uploaded", () => {
    const got = documentsInput({ input: "upload", kinds: ["pdf"] }, LAPTOP);
    expect(got.kind).toBe("off");
    if (got.kind === "off") {
      expect(got.reason).toContain("not trustworthy");
    }
  });
});

describe("kinds and unknown inputs", () => {
  test("a daemon that does not name pdf: off, never a guessed capability", () => {
    const got = documentsInput({ input: "upload", kinds: ["docx"] }, DAEMON);
    expect(got.kind).toBe("off");
    if (got.kind === "off") expect(got.reason).toContain("PDF");
    // …and a capability that names no kinds at all is the same answer.
    expect(documentsInput({ input: "upload", kinds: [] }, DAEMON).kind).toBe("off");
  });

  test("an input this build does not know: off, never a guess", () => {
    const got = documentsInput({ input: "telepathy", kinds: ["pdf"] }, DAEMON);
    expect(got.kind).toBe("off");
    if (got.kind === "off") expect(got.reason).toContain("telepathy");
  });
});
