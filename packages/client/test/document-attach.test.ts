/**
 * Attached PDFs from the client side (docs/feat/pdf-read.md D6, slice P5).
 *
 * The property this file exists for: the ONE thing AGENTS §7 forbids — PDF
 * bytes going into a pod — is decided here, by the client, and PROVED by frames
 * ("nothing was uploaded" is a frame count, not a promise). Two modes:
 * - `upload` (a daemon that runs the model): the bytes go by `attachment/put`
 *   and the prompt names a `document{ref}`;
 * - `laptop` (a pod): the injected extractor reads them HERE and the prompt
 *   names a `document{text}` — and the frame log shows no upload at all.
 * Plus the seam every caller depends on: `RemoteSession.send` carries the
 * documents to `prompt` (a keyed re-send included), and an absent capability is
 * a sentence, refused before a frame.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import type { ExecutionEnvironment, ModelProvider } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, type DocumentPolicy, type ImagePolicy, SessionHost } from "@tentacle/daemon";
import type { DocumentContent } from "@tentacle/protocol";
import { extractPdf } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { makeEncryptedPdf, makePdf } from "../../tools/test/pdf-fixture.ts";
import type { ExtractDocumentHere } from "../src/document-input.ts";
import {
  DocumentExtractError,
  DocumentsUnavailableError,
  OLD_DAEMON_DOCUMENTS,
  RemoteClient,
} from "../src/index.ts";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
} as unknown as ExecutionEnvironment;

class Idle implements ModelProvider {
  readonly id = "idle";
  // biome-ignore lint/correctness/useYield: never streams here
  async *stream(): AsyncIterable<never> {
    throw new Error("must not generate");
  }
}

/** An `ImagePolicy` that says "no images", so this file only exercises documents. */
const NO_IMAGES: ImagePolicy = { source: "client" };

function host(documents?: DocumentPolicy, images: ImagePolicy = NO_IMAGES): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/pdf-client",
    images,
    ...(documents ? { documents } : {}),
    createAgent: () => ({
      agent: new Agent({ model: new Idle(), tools: {} as never, env }),
      permissions: new PermissionBroker(),
    }),
  });
}

interface Frame {
  method?: string;
  params?: Record<string, unknown>;
}

const STORE: DocumentPolicy = {
  source: "store",
  maxBytes: 4 * 1024 * 1024,
  extract: extractPdf as DocumentPolicy extends { extract: infer E } ? E : never,
};

/** A laptop on a fresh link, every outbound frame recorded. */
async function link(
  documents?: DocumentPolicy,
  opts: { readonly servesModel?: boolean; readonly extract?: ExtractDocumentHere } = {},
): Promise<{ laptop: RemoteClient; frames: Frame[]; host: SessionHost }> {
  const h = host(documents);
  const [d, c] = createChannelPair();
  new Connection(d, h);
  const frames: Frame[] = [];
  const tap: DuplexChannel = {
    send: (data: string) => {
      frames.push(JSON.parse(data) as Frame);
      c.send(data);
    },
    close: () => c.close(),
    setOnMessage: (handler) => c.setOnMessage(handler),
    setOnClose: (handler) => c.setOnClose(handler),
  };
  const laptop = new RemoteClient(
    tap,
    new PermissionBroker(),
    opts.servesModel === true ? new Idle() : undefined,
    {
      ...(opts.extract !== undefined ? { extractDocument: opts.extract } : {}),
      // A laptop that serves the model only when the test needs one: `client`
      // mode is off without it (D6's table).
      ...(opts.servesModel === true ? { localImages: { vision: true, maxBytes: 1024 } } : {}),
    },
  );
  await laptop.initialize();
  return { laptop, frames, host: h };
}

const putFrames = (frames: Frame[]): Frame[] => frames.filter((f) => f.method === "attachment/put");

const PDF = makePdf([["Page one text"], ["Page two text"]]);

/** The `content` of the LAST `session/prompt` frame (the one a send writes). */
function promptContent(frames: Frame[]): unknown[] {
  const prompts = frames.filter((f) => f.method === "session/prompt");
  const last = prompts.at(-1);
  return (last?.params?.content as unknown[]) ?? [];
}

describe("upload mode: the daemon extracts, the laptop only uploads", () => {
  test("attachDocument uploads the bytes and names a document{ref}", async () => {
    const { laptop, frames, host: h } = await link(STORE);
    const sessionId = await laptop.openSession("/tmp/pdf-client");
    const block = await laptop.attachDocument(sessionId, PDF, { name: "report.pdf" });
    expect(block).toEqual({
      type: "document",
      kind: "pdf",
      name: "report.pdf",
      source: { type: "ref", id: sha(PDF), size: PDF.length },
    });
    expect(putFrames(frames).length).toBeGreaterThan(0);
    // The ref names THIS laptop's bytes, and the daemon received exactly them.
    const put = putFrames(frames)[0]?.params ?? {};
    expect(put.id).toBe(sha(PDF));
    expect(put.size).toBe(PDF.length);
    laptop.close();
  });

  test("bytes that are not a PDF are refused with zero frames", async () => {
    const { laptop, frames } = await link(STORE);
    const sessionId = await laptop.openSession("/tmp/pdf-client");
    const before = frames.length;
    await expect(
      laptop.attachDocument(sessionId, new TextEncoder().encode("not a pdf"), { name: "x.pdf" }),
    ).rejects.toThrow(/not a PDF/);
    expect(frames.slice(before)).toEqual([]);
    laptop.close();
  });

  test("a file over the advertised cap is refused with zero frames, naming the size", async () => {
    const { laptop, frames } = await link({ ...STORE, maxBytes: 8 });
    const sessionId = await laptop.openSession("/tmp/pdf-client");
    const before = frames.length;
    let message = "";
    try {
      await laptop.attachDocument(sessionId, PDF, { name: "big.pdf" });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("8 B");
    expect(frames.slice(before)).toEqual([]);
    laptop.close();
  });
});

describe("laptop mode: a pod never gets PDF bytes", () => {
  test("document{text} is sent and NOTHING is uploaded (frames prove it)", async () => {
    const { laptop, frames } = await link(
      { source: "client" },
      { servesModel: true, extract: extractPdf },
    );
    const sessionId = await laptop.openSession("/tmp/pdf-client");
    const before = frames.length;
    const block = await laptop.attachDocument(sessionId, PDF, { name: "report.pdf" });
    const wire = block as DocumentContent & { source: { type: string; text?: string } };
    expect(wire.source.type).toBe("text");
    // The laptop's own extraction: the same markers the daemon would build.
    expect(wire.source.text).toContain("--- page 1 / 2 ---");
    expect(wire.source.text).toContain("Page one text");
    // THE property: not one byte left this machine.
    expect(putFrames(frames)).toEqual([]);
    expect(frames.slice(before).filter((f) => f.method === "attachment/put")).toEqual([]);
    laptop.close();
  });

  test("over the page limit, the attach retries with the first read's worth and names the cut", async () => {
    // Review P5 #1. A pod takes only text, so a >2000-page PDF cannot be given
    // a `pages` range by anything but THIS retry: without it the attach fails
    // with "too many pages" instead of sending the first 100 pages plus the
    // footer that names the cut. The daemon's copy has the same test
    // (`packages/daemon/test/prompt-documents.test.ts`): both ends are pinned,
    // so neither can silently lose the retry.
    const calls: { pages?: string }[] = [];
    const many: ExtractDocumentHere = async (_bytes, options) => {
      calls.push(options?.pages === undefined ? {} : { pages: options.pages });
      if (options?.pages === undefined) {
        return { ok: false, reason: "too-many-pages", message: "2500 pages: pass pages" };
      }
      const pages = Array.from({ length: 100 }, (_, i) => ({
        n: i + 1,
        text: `page ${i + 1} ${"words ".repeat(20)}`,
      }));
      return { ok: true, numPages: 2500, pages };
    };
    const { laptop, frames } = await link(
      { source: "client" },
      { servesModel: true, extract: many },
    );
    const sessionId = await laptop.openSession("/tmp/pdf-client");
    const before = frames.length;
    const block = await laptop.attachDocument(sessionId, PDF, { name: "big.pdf" });
    expect(calls).toEqual([{}, { pages: "1-100" }]);
    const text = block.source.type === "text" ? block.source.text : "";
    expect(text).toContain("page 100");
    expect(text).toContain("[pages 101-2500 not included]");
    // Still nothing over the wire but the prompt's text: no bytes to the pod.
    expect(frames.slice(before)).toEqual([]);
    laptop.close();
  });

  test("a client-mode daemon with no extractor here is OFF, not an upload", async () => {
    const { laptop, frames } = await link({ source: "client" }, { servesModel: true });
    const sessionId = await laptop.openSession("/tmp/pdf-client");
    const mode = laptop.documentsInput();
    expect(mode.kind).toBe("off");
    const before = frames.length;
    let caught: unknown;
    try {
      await laptop.attachDocument(sessionId, PDF, { name: "report.pdf" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocumentsUnavailableError);
    expect(frames.slice(before)).toEqual([]);
    laptop.close();
  });

  test("an encrypted PDF fails here, as the sentence a user reads, and sends nothing", async () => {
    const { laptop } = await link({ source: "client" }, { servesModel: true, extract: extractPdf });
    const sessionId = await laptop.openSession("/tmp/pdf-client");
    let caught: unknown;
    try {
      await laptop.attachDocument(sessionId, makeEncryptedPdf(), { name: "locked.pdf" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocumentExtractError);
    expect(String((caught as Error).message)).toContain("locked.pdf");
    laptop.close();
  });

  test("an upload asked for WHILE this client serves the model is refused (AGENTS §7)", async () => {
    // A pod daemon claiming `upload` is a claim on ITS OWN authority; believing
    // it would put PDF bytes inside the pod.
    const { laptop, frames } = await link(STORE, { servesModel: true, extract: extractPdf });
    const sessionId = await laptop.openSession("/tmp/pdf-client");
    const mode = laptop.documentsInput();
    expect(mode.kind).toBe("off");
    const before = frames.length;
    await expect(
      laptop.attachDocument(sessionId, PDF, { name: "report.pdf" }),
    ).rejects.toBeInstanceOf(DocumentsUnavailableError);
    expect(frames.slice(before)).toEqual([]);
    laptop.close();
  });
});

describe("no documents capability", () => {
  test("documentsInput is off with the ONE update sentence, and nothing is sent", async () => {
    const { laptop, frames } = await link(undefined);
    const sessionId = await laptop.openSession("/tmp/pdf-client");
    expect(laptop.documentsInput()).toEqual({ kind: "off", reason: OLD_DAEMON_DOCUMENTS });
    const before = frames.length;
    await expect(laptop.attachDocument(sessionId, PDF, { name: "report.pdf" })).rejects.toThrow(
      OLD_DAEMON_DOCUMENTS,
    );
    expect(frames.slice(before)).toEqual([]);
    laptop.close();
  });
});

describe("RemoteSession.send carries the documents to session/prompt", () => {
  test("a plain prompt: content = text block + the document block", async () => {
    const { laptop, frames } = await link(STORE);
    const sessionId = await laptop.openSession("/tmp/pdf-client");
    const session = laptop.newSession(undefined, sessionId);
    const block = await session.attachDocument(PDF, { name: "report.pdf" });
    // The daemon extracts from its own store; this turn only proves the WIRE.
    const sending = (async (): Promise<void> => {
      try {
        for await (const _ of session.send("summarise this", undefined, {
          turnId: "t1",
          documents: [block],
        })) {
          // drain: the model is `Idle`, so the turn itself errors
        }
      } catch {
        // The frames are the property here, not the turn's outcome.
      }
    })();
    await sending;
    expect(promptContent(frames)).toEqual([{ type: "text", text: "summarise this" }, block]);
    laptop.close();
  });

  test("a document-only prompt is the document block alone (never an empty text block)", async () => {
    const { laptop, frames } = await link(STORE);
    const sessionId = await laptop.openSession("/tmp/pdf-client");
    const session = laptop.newSession(undefined, sessionId);
    const block = await session.attachDocument(PDF, { name: "report.pdf" });
    try {
      for await (const _ of session.send("", undefined, { turnId: "t2", documents: [block] })) {
        // drain
      }
    } catch {
      // as above
    }
    expect(promptContent(frames)).toEqual([block]);
    laptop.close();
  });
});
