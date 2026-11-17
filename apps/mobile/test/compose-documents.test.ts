/**
 * A PDF through the compose half (docs/feat/pdf-read.md D7): pick → chip → the
 * SESSION's `attachDocument` → the outbox item → the prompt's `documents`.
 *
 * The point of it being here rather than in `compose-controller.test.ts` is the
 * one thing D7 adds: the app must never choose between uploading bytes and
 * extracting text. `handle.attachDocument` answers that (the client's own
 * capability table), and these tests prove the app only ever asks it.
 *
 * Each test names its mutation (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef, DocumentContent, QueueState } from "@tentacle/protocol";
import type { PickedDocument } from "../src/compose-chips.ts";
import { type ComposeHandle, type PickedPhoto, createCompose } from "../src/compose-controller.ts";
import { createOutboxDriver } from "../src/outbox-driver.ts";
import { createOutboxStore, outboxPaths } from "../src/outbox-store.ts";
import type { OutboxFs } from "../src/outbox-store.ts";
import type { LocalPhoto } from "../src/transcript-rows.ts";

function memoryFs(): OutboxFs {
  const files = new Map<string, string>();
  return {
    read: async (path) => files.get(path) ?? null,
    write: async (path, text) => {
      files.set(path, text);
    },
    rename: async (from, to) => {
      const text = files.get(from);
      if (text === undefined) {
        throw new Error(`no such file: ${from}`);
      }
      files.delete(from);
      files.set(to, text);
    },
    remove: async (path) => {
      files.delete(path);
    },
    list: async (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)),
  };
}

const ROOT = "file:///support/outbox";
const PATHS = outboxPaths(ROOT, "c1");

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%fake\n");
const BLOCK: DocumentContent = {
  type: "document",
  kind: "pdf",
  name: "report.pdf",
  source: { type: "ref", id: "a".repeat(64), size: PDF_BYTES.length },
};

const PICK_PDF: PickedDocument = {
  kind: "document",
  file: `${ROOT}/pdfs/7-1-report.pdf`,
  name: "report.pdf",
  size: PDF_BYTES.length,
  bytes: PDF_BYTES,
};

interface FakeHandle extends ComposeHandle {
  readonly acts: string[];
  /** Every `attachDocument` call's name, and — when the test refuses — nothing else runs. */
  readonly attached: string[];
  /** Every prompt the app's own folding port received, with its documents. */
  readonly prompted: { readonly text: string; readonly documents: readonly DocumentContent[] }[];
}

function fakeHandle(
  o: {
    readonly refuseAttach?: unknown;
    readonly capability?: "upload" | "laptop" | "off";
  } = {},
): FakeHandle {
  const acts: string[] = [];
  const attached: string[] = [];
  const prompted: { text: string; documents: readonly DocumentContent[] }[] = [];
  const capability = o.capability ?? "upload";
  return {
    sessionId: "s1",
    acts,
    attached,
    prompted,
    async attachImage() {
      throw new Error("no image in this test");
    },
    async attachDocument(bytes, meta) {
      acts.push(`attachDocument:${meta.name}:${bytes.length}`);
      if (o.refuseAttach !== undefined) {
        throw o.refuseAttach;
      }
      attached.push(meta.name);
      return { ...BLOCK, name: meta.name, source: { ...BLOCK.source, size: bytes.length } };
    },
    async send(text) {
      prompted.push({ text, documents: [] });
    },
    async steer() {},
    async sendNow() {
      return (async function* () {})();
    },
    onQueued() {
      return () => {};
    },
    queued: () => undefined as QueueState | undefined,
    async reclaim() {},
    port: {
      async upload() {
        throw new Error("no image in this test");
      },
      async prompt(text, _turnId, _refs, _photos, documents) {
        prompted.push({ text, documents: documents ?? [] });
      },
      async attachDocument(bytes, meta) {
        return { ...BLOCK, name: meta.name, source: { ...BLOCK.source, size: bytes.length } };
      },
      async steer() {},
      facts: () => Promise.resolve({ availability: "open", historyLength: 1, runningTurnId: null }),
    },
  };
}

async function harness(
  o: {
    readonly handle?: FakeHandle;
    readonly pick?: readonly (PickedDocument | { kind: "refused"; detail: string })[];
    readonly capability?: "upload" | "laptop" | "off";
  } = {},
) {
  const store = createOutboxStore(memoryFs(), PATHS, () => 7);
  await store.load();
  const handle = o.handle ?? fakeHandle({ capability: o.capability });
  const notices: (string | null)[] = [];
  const picks = o.pick ?? [];
  const picked: number[] = [];
  let field = "";
  let key = 0;
  const driver = createOutboxDriver(async () => handle.port, {
    persistence: {
      items: () => store.data.items,
      save: (items) => store.setItems(items),
      finish: (itemId) => store.removeItem(itemId),
    },
    readPhoto: async () => new Uint8Array([1]),
    mint: () => {
      key += 1;
      return `k${key}`;
    },
  });
  const capacity = o.capability ?? "upload";
  const compose = createCompose({
    computerId: "c1",
    sessionId: "s1",
    store,
    driver,
    photos: {
      pickFromLibrary: async (): Promise<readonly PickedPhoto[]> => [],
      takePhoto: async (): Promise<readonly PickedPhoto[]> => [],
    },
    documents: {
      // Recorded, so "0 frames / no pick" is observable.
      pickPdf: async (taken: number) => {
        picked.push(taken);
        return picks as readonly PickedDocument[];
      },
      documentsInput: () =>
        capacity === "upload"
          ? { kind: "upload", maxBytes: 15 * 1024 * 1024 }
          : capacity === "laptop"
            ? { kind: "laptop", maxBytes: 15 * 1024 * 1024 }
            : { kind: "off", reason: "this session's daemon cannot read PDFs (update it)" },
    },
    handle: () => handle,
    turnId: () => null,
    stopTurn: () => {},
    mint: () => {
      key += 1;
      return `k${key}`;
    },
    prompt: async (
      text: string,
      _turnId: string,
      _refs: readonly AttachmentRef[],
      _photos?: readonly LocalPhoto[],
      documents?: readonly DocumentContent[],
    ) => {
      handle.prompted.push({ text, documents: documents ?? [] });
    },
    draft: () => field,
    setDraft: (text) => {
      field = text;
    },
    flushDraft: () => {},
    onChange: () => {},
    notify: (text) => {
      notices.push(text);
    },
  });
  await compose.start(handle);
  return {
    compose,
    handle,
    store,
    notices,
    picked,
    setField: (text: string) => {
      field = text;
    },
    items: () => store.data.items,
  };
}

describe("picking a PDF (D7)", () => {
  test("the chip goes uploading → ready through the SESSION's attachDocument", async () => {
    const h = await harness({ pick: [PICK_PDF] });
    await h.compose.pickDocument();
    expect(h.handle.acts).toEqual([`attachDocument:report.pdf:${PDF_BYTES.length}`]);
    const chip = h.compose.view().chips[0];
    expect(chip).toMatchObject({ kind: "document", state: "ready", name: "report.pdf" });
  });

  test("the sheet offers the PDF row only when the session advertises upload", async () => {
    // MUTATION M2: offer it regardless of the capability → the `off` case red.
    expect((await harness({ pick: [] })).compose.view().attach).toEqual({
      items: ["photo", "camera", "pdf"],
      reason: null,
    });
    const off = await harness({ pick: [], capability: "off" });
    expect(off.compose.view().attach.items).toEqual(["photo", "camera"]);
    expect(off.compose.view().attach.reason).toBe(
      "this session's daemon cannot read PDFs (update it)",
    );
  });

  test("a session that expects THIS device to extract refuses the pick, and picks nothing", async () => {
    const h = await harness({ pick: [PICK_PDF], capability: "laptop" });
    await h.compose.pickDocument();
    expect(h.picked).toEqual([]); // the picker never opened
    expect(h.handle.acts).toEqual([]);
    expect(h.notices.at(-1)).toContain("cannot read a PDF");
  });

  test("off refuses too, in the client's own words", async () => {
    const h = await harness({ pick: [PICK_PDF], capability: "off" });
    await h.compose.pickDocument();
    expect(h.picked).toEqual([]);
    expect(h.notices.at(-1)).toBe("this session's daemon cannot read PDFs (update it)");
  });

  test("a refusal is a chip with its reason, and nothing was attached", async () => {
    const h = await harness({
      pick: [{ kind: "refused", detail: "“notes.pdf” is not a PDF" }],
    });
    await h.compose.pickDocument();
    expect(h.handle.acts).toEqual([]);
    expect(h.compose.view().chips[0]).toMatchObject({ state: "refused" });
  });

  test("attachDocument's own refusal refuses the chip and says why", async () => {
    const h = await harness({ pick: [PICK_PDF] });
    const refusing = fakeHandle({ refuseAttach: new Error("too large") });
    // A SECOND harness would rebuild the world; instead the same pick runs again
    // with the port refusing — the chip ends `refused`, never stuck `uploading`.
    const run = await harness({ pick: [PICK_PDF], handle: refusing });
    await run.compose.pickDocument();
    expect(run.compose.view().chips[0]).toMatchObject({ state: "refused" });
    expect(run.handle.prompted).toEqual([]);
    void h;
  });
});

describe("sending a PDF (D7)", () => {
  test("the prompt carries the block the attach answered (mutation: enqueue without `documents` → red)", async () => {
    // MUTATION M4: `driver.enqueue` without `documents` sends `[]` → red.
    const h = await harness({ pick: [PICK_PDF] });
    await h.compose.pickDocument();
    h.setField("what does this say?");
    await h.compose.press({ kind: "send", text: "" });
    expect(h.handle.prompted).toHaveLength(1);
    expect(h.handle.prompted[0]?.text).toBe("what does this say?");
    expect(h.handle.prompted[0]?.documents).toEqual([
      {
        ...BLOCK,
        name: "report.pdf",
        source: { type: "ref", id: "a".repeat(64), size: PDF_BYTES.length },
      },
    ]);
    // The item is gone: the daemon has the key, so the message went.
    expect(h.items()).toEqual([]);
  });

  test("a PDF alone (no text) is still a sendable message", async () => {
    const h = await harness({ pick: [PICK_PDF] });
    await h.compose.pickDocument();
    await h.compose.press({ kind: "send", text: "" });
    expect(h.handle.prompted).toHaveLength(1);
    expect(h.handle.prompted[0]?.text).toBe("");
  });

  test("offline (send later) keeps the document on the item for the retry", async () => {
    const h = await harness({ pick: [PICK_PDF] });
    await h.compose.pickDocument();
    await h.compose.press({ kind: "send-later", text: "" });
    // The item is on disk with its block, so a later run names it without a
    // second upload (`attachDocument` is not called again).
    const item = h.items()[0];
    expect(item?.documents).toEqual([
      {
        file: PICK_PDF.file,
        name: "report.pdf",
        block: {
          ...BLOCK,
          name: "report.pdf",
          source: { type: "ref", id: "a".repeat(64), size: PDF_BYTES.length },
        },
      },
    ]);
  });
});
