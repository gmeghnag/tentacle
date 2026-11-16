/**
 * An attached PDF, end to end in the TUI (docs/feat/pdf-read.md D5/D6, slice P5).
 *
 * The weak version of this test ("a chip renders") would pass on a component
 * that never sends the right block. So every case asserts at the SEAM: what
 * `attachDocument` was handed (bytes and name), what `send` was given (the wire
 * block), and what the transcript says. `FileProbe` is a fake and the session is
 * a fake controller — no disk, no daemon, no extractor here.
 *
 * The property the mode table turns on: in `upload` mode the block names a
 * `ref` (the daemon extracts); in `laptop` mode it carries `text` (a pod — no
 * PDF bytes into it, AGENTS §7). A session that takes neither refuses with a
 * sentence and sends NOTHING.
 */
import { describe, expect, test } from "bun:test";
import type { DocumentContent } from "@tentacle/protocol";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { FileProbe, ProbedFile } from "../src/attach-files.ts";
import type { DocumentMode } from "../src/pdf-attach.ts";
import { messagesToItems } from "../src/resume.ts";
import type { SessionEvent } from "../src/state.ts";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Two pages of a real PDF header (the bytes decide; the parser never runs here). */
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");

function probeOf(files: Record<string, Uint8Array>): FileProbe & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(path: string): Promise<ProbedFile | null> {
      reads.push(path);
      const bytes = files[path];
      if (bytes === undefined) {
        return null;
      }
      return { kind: "file", size: bytes.length, bytes };
    },
  };
}

interface Sent {
  readonly prompt: string;
  readonly documents: readonly DocumentContent[] | undefined;
}

interface Documented {
  readonly bytes: Uint8Array;
  readonly name: string;
}

/**
 * A session that takes PDFs in ONE mode (the `inline` fake: `documentsInput`
 * answers what the test says, and `attachDocument` records what it was handed).
 * `inertSession()`'s own answer is OFF — a test that forgets to script the mode
 * gets a refusal, never a silent success.
 */
function fakeSession(opts: {
  readonly mode?: DocumentMode;
  readonly block?: DocumentContent;
}): SessionController & { sent: Sent[]; documents: Documented[] } {
  const sent: Sent[] = [];
  const documents: Documented[] = [];
  const mode = opts.mode ?? { kind: "upload", maxBytes: 4 * 1024 * 1024 };
  return {
    ...inertSession(),
    sent,
    documents,
    documentsInput: () => mode,
    attachDocument: async (bytes, meta) => {
      documents.push({ bytes, name: meta.name });
      return (
        opts.block ?? {
          type: "document",
          kind: "pdf",
          name: meta.name,
          source: { type: "ref", id: "a".repeat(64), size: bytes.length },
        }
      );
    },
    send(prompt, _signal, o) {
      sent.push({ prompt, documents: o?.documents });
      return (async function* (): AsyncIterable<SessionEvent> {
        yield { type: "text", delta: "ok" };
        yield { type: "turn_end", reason: "end_turn" as never };
      })();
    },
  };
}

interface Mounted {
  readonly frame: () => string;
  readonly unmount: () => void;
  readonly type: (text: string) => Promise<void>;
  readonly paste: (text: string) => Promise<void>;
}

function mount(
  session: SessionController,
  opts: { readonly files?: Record<string, Uint8Array>; readonly columns?: number } = {},
): Mounted {
  const probe = probeOf(opts.files ?? {});
  const app = render(
    <App
      createSession={() => session}
      model="m"
      cwd="/tmp/work"
      columns={opts.columns ?? 100}
      fileProbe={probe}
      home="/home/u"
      localCwd="/work"
    />,
  );
  const type = async (text: string): Promise<void> => {
    app.stdin.write(text);
    await delay(20);
    app.stdin.write(ENTER);
    await delay(150);
  };
  return {
    frame: () => strip(app.lastFrame() ?? ""),
    unmount: app.unmount,
    type,
    paste: async (text: string): Promise<void> => {
      app.stdin.write(`${PASTE_START}${text}${PASTE_END}`);
      await delay(150);
    },
  };
}

const PDF_PATH = "/tmp/report.pdf";

describe("P5a: a dragged PDF becomes a chip, and Enter sends ONE document block", () => {
  test("the chip renders `report.pdf · reading…`, attachDocument gets the bytes, send the block", async () => {
    const session = fakeSession({});
    const m = mount(session, { files: { [PDF_PATH]: PDF } });
    await delay(30);
    await m.paste(PDF_PATH);
    // The composer's chip: the glyph, the name, and the honest "no page count yet"
    // (the page count is the daemon's fact in upload mode).
    const chipped = m.frame();
    expect(chipped).toContain("report.pdf");
    expect(chipped).toContain("reading…");
    // A paste never sends.
    expect(session.sent).toEqual([]);

    await m.type("summarise it");
    // The seam got the file's EXACT bytes and its name — not an image ref.
    expect(session.documents).toEqual([{ bytes: PDF, name: "report.pdf" }]);
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.prompt).toBe("summarise it");
    expect(session.sent[0]?.documents).toEqual([
      {
        type: "document",
        kind: "pdf",
        name: "report.pdf",
        source: { type: "ref", id: "a".repeat(64), size: PDF.length },
      },
    ]);
    // The transcript: the text row, then the PDF's row (never the block's text).
    const frame = m.frame();
    expect(frame).toContain("summarise it");
    expect(frame).toContain("[pdf: report.pdf]");
    expect(frame).not.toContain("<file");
    m.unmount();
  });

  test("a PDF entered as a bare path becomes a chip and sends nothing (the drop rule)", async () => {
    const session = fakeSession({});
    const m = mount(session, { files: { [PDF_PATH]: PDF } });
    await delay(30);
    await m.type(PDF_PATH);
    expect(session.sent).toEqual([]);
    expect(m.frame()).toContain("report.pdf");
    m.unmount();
  });
});

describe("P5b: a pod (laptop-extract) gets TEXT, and nothing is uploaded", () => {
  test("the block is document{text}, carrying the pages the laptop extracted", async () => {
    const block: DocumentContent = {
      type: "document",
      kind: "pdf",
      name: "report.pdf",
      source: { type: "text", text: "--- page 1 / 2 ---\nHello", pages: 2 },
    };
    const session = fakeSession({ mode: { kind: "laptop", maxBytes: 4 * 1024 * 1024 }, block });
    const m = mount(session, { files: { [PDF_PATH]: PDF } });
    await delay(30);
    await m.paste(PDF_PATH);
    await m.type("what is this?");
    expect(session.sent).toHaveLength(1);
    const sent = session.sent[0]?.documents?.[0];
    // The mode's own answer: TEXT, never a ref (no PDF bytes into a pod).
    expect(sent?.source.type).toBe("text");
    // …and the TUI never uploaded: the only seam it calls is `attachDocument`.
    expect(session.documents).toHaveLength(1);
    m.unmount();
  });
});

describe("P5c: a session that takes no PDFs refuses, with a sentence, and sends nothing", () => {
  test("no documents capability: the chip is refused and the reason is on screen", async () => {
    const session = fakeSession({
      mode: { kind: "off", reason: "this session's daemon cannot read PDFs (update it)" },
    });
    const m = mount(session, { files: { [PDF_PATH]: PDF } });
    await delay(30);
    await m.paste(PDF_PATH);
    const frame = m.frame();
    expect(frame).toContain("PDFs are off");
    expect(frame).toContain("cannot read PDFs");
    // Not a chip: nothing to send, and nothing was.
    expect(frame).not.toContain("reading…");
    await m.type("hello");
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.documents).toBeUndefined();
    expect(session.documents).toEqual([]);
    m.unmount();
  });
});

describe("P5d: the transcript hides the block and shows the chip (a resumed message)", () => {
  test("`media` present: the `<file>` block is stripped, one [pdf: …] row", () => {
    const block =
      '<file name="report.pdf" kind="pdf" pages="2">\n--- page 1 / 2 ---\nsecret body\n</file>';
    const items = messagesToItems([
      {
        role: "user",
        content: `summarise this\n${block}`,
        media: [{ kind: "pdf", name: "report.pdf", pages: 2, chars: 20 }],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "user",
      text: "summarise this",
      documents: ["[pdf: report.pdf · 2 pp]"],
    });
    // The FILE's text is nowhere on the row: the model has it, the user has the file.
    expect(JSON.stringify(items)).not.toContain("secret body");
  });

  test("no `media` (an older log): the content is shown RAW — honest degradation", () => {
    const raw = '<file name="report.pdf" kind="pdf" pages="2">\nbody\n</file>';
    const items = messagesToItems([{ role: "user", content: raw }]);
    expect(items[0]).toEqual({ kind: "user", text: raw });
  });

  test("a PDF-only prompt with media: no text row, the [pdf: …] row alone", () => {
    const items = messagesToItems([
      {
        role: "user",
        content: '<file name="r.pdf" kind="pdf" pages="1">\nx\n</file>',
        media: [{ kind: "pdf", name: "r.pdf", pages: 1 }],
      },
    ]);
    expect(items[0]).toEqual({ kind: "user", text: "", documents: ["[pdf: r.pdf · 1 pp]"] });
  });
});
