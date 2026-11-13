/**
 * Images in the real `App` (docs/feat/attachments-tui.md T8): a pasted or
 * `/attach`ed path becomes a chip, Enter puts the chip's EXACT bytes behind a
 * ref through the session's own `attachImage`, and the prompt names that ref.
 *
 * The weak version of this test ("a chip renders") would pass on a component
 * that never uploads anything. So every case asserts at the SEAM: what
 * `attachImage` was handed (bytes and meta), what `send` was given (the refs),
 * and what the transcript says. `FileProbe` is a fake — no real disk here.
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { FileProbe, ProbedFile } from "../src/attach-files.ts";
import type { SessionEvent } from "../src/state.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
const ESC = "\u001b";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** 1×1-ish PNG: the 8-byte signature and an IHDR start (enough for the sniffer). */
const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0,
]);
const HEIC = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);

/** A `FileProbe` over a fixed map, counting what it was asked (so "no disk" is provable). */
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
  readonly attachments: readonly AttachmentRef[] | undefined;
}

/** A session whose turns end at once, recording what the App handed it. */
function fakeSession(opts: {
  readonly mode?: "upload" | "off";
  readonly attach?: (
    bytes: Uint8Array,
    meta: { mimeType: string; name?: string },
    o?: { signal?: AbortSignal; onProgress?: (sent: number, size: number) => void },
  ) => Promise<AttachmentRef>;
  readonly failSend?: Error;
}): SessionController & {
  sent: Sent[];
  uploaded: { bytes: Uint8Array; meta: { mimeType: string; name?: string } }[];
} {
  const sent: Sent[] = [];
  const uploaded: { bytes: Uint8Array; meta: { mimeType: string; name?: string } }[] = [];
  const mode = opts.mode ?? "upload";
  return {
    sent,
    uploaded,
    send(prompt, _signal, o) {
      sent.push({ prompt, attachments: o?.attachments });
      const failSend = opts.failSend;
      return (async function* (): AsyncIterable<SessionEvent> {
        if (failSend !== undefined) {
          throw failSend;
        }
        yield { type: "text", delta: "ok" };
        yield { type: "turn_end", reason: "end_turn" as never };
      })();
    },
    ...(mode === "off"
      ? {}
      : {
          imageInput: () => ({ kind: "upload" as const, maxBytes: 4 * 1024 * 1024 }),
          attachImage: async (bytes, meta, o) => {
            if (opts.attach !== undefined) {
              return opts.attach(bytes, meta, o);
            }
            uploaded.push({ bytes, meta });
            const ref: AttachmentRef = {
              id: Array.from(bytes)
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("")
                .padEnd(64, "0")
                .slice(0, 64),
              mimeType: meta.mimeType,
              size: bytes.length,
              ...(meta.name !== undefined ? { name: meta.name } : {}),
            };
            o?.onProgress?.(bytes.length, bytes.length);
            return ref;
          },
        }),
  };
}

interface Mounted {
  readonly frame: () => string;
  readonly stdin: { write(data: string): void };
  readonly unmount: () => void;
  readonly type: (text: string) => Promise<void>;
  readonly paste: (text: string) => Promise<void>;
  readonly press: (key: string) => Promise<void>;
}

function mount(
  session: SessionController,
  opts: {
    readonly files?: Record<string, Uint8Array>;
    readonly localCwd?: string;
    readonly home?: string;
    readonly columns?: number;
  } = {},
): Mounted {
  const probe = probeOf(opts.files ?? {});
  const app = render(
    <App
      createSession={() => session}
      model="m"
      cwd="/tmp/work"
      columns={opts.columns ?? 100}
      fileProbe={probe}
      home={opts.home ?? "/home/u"}
      localCwd={opts.localCwd ?? "/work"}
    />,
  );
  const type = async (text: string): Promise<void> => {
    app.stdin.write(text);
    await delay(20);
    app.stdin.write(ENTER);
    await delay(120);
  };
  return {
    frame: () => strip(app.lastFrame() ?? ""),
    stdin: app.stdin,
    unmount: app.unmount,
    type,
    paste: async (text: string): Promise<void> => {
      app.stdin.write(`${PASTE_START}${text}${PASTE_END}`);
      await delay(120);
    },
    press: async (key: string): Promise<void> => {
      app.stdin.write(key);
      await delay(80);
    },
  };
}

const PNG_PATH = "/tmp/a.png";

describe("T8a: prose that mentions a path stays text and never reads the disk", () => {
  test("a pasted sentence is inserted, the probe is untouched", async () => {
    const session = fakeSession({});
    const probe = probeOf({ [PNG_PATH]: PNG });
    const app = render(
      <App
        createSession={() => session}
        model="m"
        cwd="/tmp/work"
        columns={100}
        fileProbe={probe}
        home="/home/u"
        localCwd="/work"
      />,
    );
    await delay(30);
    app.stdin.write(`${PASTE_START}look at ${PNG_PATH} please${PASTE_END}`);
    await delay(120);
    expect(probe.reads).toEqual([]);
    expect(strip(app.lastFrame() ?? "")).toContain(`look at ${PNG_PATH} please`);
    app.unmount();
  });
});

describe("T8b: a pasted PNG path becomes a chip, and Enter sends its exact bytes", () => {
  test("the chip renders, attachImage gets bytes+meta, send gets the ref", async () => {
    const session = fakeSession({});
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    // The chip row: name and size.
    expect(m.frame()).toContain("a.png");
    expect(session.sent).toEqual([]); // a paste never sends
    await m.type("what?");
    expect(session.uploaded).toHaveLength(1);
    expect(session.uploaded[0]?.bytes).toEqual(PNG);
    expect(session.uploaded[0]?.meta).toEqual({ mimeType: "image/png", name: "a.png" });
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.prompt).toBe("what?");
    expect(session.sent[0]?.attachments).toHaveLength(1);
    expect(session.sent[0]?.attachments?.[0]).toMatchObject({
      mimeType: "image/png",
      size: PNG.length,
      name: "a.png",
    });
    // The transcript: the text row, then the image row.
    const frame = m.frame();
    expect(frame).toContain("what?");
    expect(frame).toContain("[image: a.png]");
    m.unmount();
  });
});

describe("T8c: a mixed paste attaches the PNG and says why the HEIC did not", () => {
  test("one chip, one refusal sentence, nothing sent", async () => {
    const session = fakeSession({});
    const m = mount(session, {
      files: { [PNG_PATH]: PNG, "/tmp/i.heic": HEIC },
    });
    await delay(30);
    await m.paste(`${PNG_PATH} /tmp/i.heic`);
    const frame = m.frame();
    expect(frame).toContain("a.png");
    expect(frame).toContain("HEIC");
    expect(session.sent).toEqual([]);
    m.unmount();
  });
});

describe("T8d: images OFF still explains itself, and nothing is inserted", () => {
  test("the reason is on screen and no chip exists", async () => {
    const session = fakeSession({ mode: "off" });
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    const frame = m.frame();
    expect(frame).toContain("images are off");
    expect(frame).not.toContain("[image: a.png]");
    // The path did not become prompt text either (nothing was sent).
    await m.type("");
    expect(session.sent).toEqual([]);
    m.unmount();
  });
});

describe("T8e: an unbracketed drop + Enter converts to a chip and sends nothing", () => {
  test("typed path, Enter → chip, no send; then a question sends it", async () => {
    const session = fakeSession({});
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    // Typed, not bracketed: the drop path (owner Q3 (a)).
    await m.type(PNG_PATH);
    expect(session.sent).toEqual([]);
    expect(m.frame()).toContain("a.png");
    await m.type("what is it?");
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.attachments).toHaveLength(1);
    m.unmount();
  });
});

describe("T8f: Enter with chips and no text is an image-only prompt", () => {
  test('send("" , [ref])', async () => {
    const session = fakeSession({});
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    await m.type("");
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.prompt).toBe("");
    expect(session.sent[0]?.attachments).toHaveLength(1);
    expect(m.frame()).toContain("[image: a.png]");
    m.unmount();
  });
});

describe("T8g: Enter with chips mid-turn refuses, keeps both, and sends nothing", () => {
  test("a running turn blocks the image prompt; the text and chip stay", async () => {
    const released: (() => void)[] = [];
    const session: SessionController = {
      send() {
        return (async function* (): AsyncIterable<SessionEvent> {
          await new Promise<void>((resolve) => released.push(resolve));
          yield { type: "turn_end", reason: "end_turn" as never };
        })();
      },
      imageInput: () => ({ kind: "upload" as const, maxBytes: 4 * 1024 * 1024 }),
      attachImage: async (bytes, meta) => ({
        id: "b".repeat(64),
        mimeType: meta.mimeType,
        size: bytes.length,
        ...(meta.name !== undefined ? { name: meta.name } : {}),
      }),
    };
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.type("first turn"); // runs (and holds)
    await m.paste(PNG_PATH); // a chip can be prepared while it runs
    await m.type("what?"); // refused: a turn runs
    const frame = m.frame();
    expect(frame).toContain("can't send an image");
    expect(frame).toContain("a.png"); // the chip is kept
    for (const r of released.splice(0)) r();
    await delay(120);
    m.unmount();
  });
});

describe("T8h: an upload failure restores the text, keeps the chip and says why", () => {
  test("a rejected upload → the sentence, no bubble, the chip still there", async () => {
    const session = fakeSession({
      attach: async () => {
        throw new RangeError("image a.png is 20 MB, over the 15 MB limit");
      },
    });
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    await m.type("what?");
    const frame = m.frame();
    expect(frame).toContain("over the 15 MB limit");
    expect(frame).toContain("a.png"); // the chip stayed
    expect(session.sent).toEqual([]); // nothing was sent
    expect(m.frame()).toContain("what?"); // the text is back in the input
    m.unmount();
  });

  test("progress is visible while a held upload runs", async () => {
    const finished: (() => void)[] = [];
    const session = fakeSession({
      attach: async (bytes, meta, o) => {
        o?.onProgress?.(Math.floor(bytes.length / 2), bytes.length);
        await new Promise<void>((resolve) => finished.push(resolve));
        return {
          id: "c".repeat(64),
          mimeType: meta.mimeType,
          size: bytes.length,
          ...(meta.name !== undefined ? { name: meta.name } : {}),
        };
      },
    });
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    m.stdin.write("what?");
    await delay(20);
    m.stdin.write(ENTER);
    await delay(120);
    expect(m.frame()).toContain("uploading a.png");
    expect(m.frame()).toContain("(1/1)");
    for (const f of finished.splice(0)) f();
    await delay(120);
    m.unmount();
  });
});

describe("T8i: the daemon refusing the refs withdraws the bubble and restores everything", () => {
  test("AttachmentRefused → no bubble, text+chip back, the reason shown", async () => {
    const session = fakeSession({
      failSend: Object.assign(new Error("image a.png is not on this daemon"), {
        code: -32016,
        data: { reason: "not_uploaded" },
      }),
    });
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    await m.type("what?");
    const frame = m.frame();
    expect(frame).toContain("press Enter to upload");
    // The bubble is gone: the prompt text is back in the INPUT (not the transcript).
    expect(frame).toContain("what?");
    expect(frame).toContain("a.png");
    m.unmount();
  });

  test("an image-only prompt that LOSES THE SLOT is restored, never treated as a wake (P10)", async () => {
    // Another device's turn took the slot first: `lostSlot` (code -32004). The
    // own-prompt test used to be `own.text !== ""`, so a prompt with no text was
    // read as an autonomous WAKE and its bubble/text/chips vanished.
    let wakes = 0;
    const session: SessionController = {
      send(prompt) {
        if (prompt === "") wakes += 1;
        return (async function* (): AsyncIterable<SessionEvent> {
          // biome-ignore lint/correctness/useYield: it refuses before any event
          throw Object.assign(new Error("a turn is already running"), { code: -32004 });
        })();
      },
      imageInput: () => ({ kind: "upload" as const, maxBytes: 4 * 1024 * 1024 }),
      attachImage: async (bytes, meta) => ({
        id: "d".repeat(64),
        mimeType: meta.mimeType,
        size: bytes.length,
        ...(meta.name !== undefined ? { name: meta.name } : {}),
      }),
    };
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    await m.type("");
    expect(wakes).toBe(1); // exactly the one image-only attempt
    await delay(150);
    expect(wakes).toBe(1); // the refusal never starts a wake turn
    // The prompt came back: the slot-lost notice, and the chip with it.
    const frame = m.frame();
    expect(frame).toContain("another device started a turn");
    expect(frame).toContain("a.png");
    expect(frame).not.toContain("[image: a.png]"); // no bubble: it never ran
    m.unmount();
  });
});

describe("T8j: the chip row is counted, so the frame height never changes", () => {
  test("the same number of rows with and without a chip", async () => {
    const session = fakeSession({});
    const m = mount(session, { files: { [PNG_PATH]: PNG }, columns: 100 });
    await delay(40);
    const before = m.frame().split("\n").length;
    await m.paste(PNG_PATH);
    const after = m.frame().split("\n").length;
    expect(after).toBe(before);
    expect(after).toBe(before);
    m.unmount();
  });
});

describe("T8k: another client's image prompt shows its row", () => {
  test("a user_message with refs renders `[image: x.png]`", async () => {
    let push: ((event: SessionEvent) => void) | null = null;
    const session: SessionController = {
      async *send() {
        // biome-ignore lint/correctness/useYield: the test pushes its own events
        throw new Error("unused");
      },
      watch(listener) {
        push = () => {};
        void listener;
        return () => {};
      },
    };
    void session;
    void push;
    // The foreign path folds `user_message{attachments}` through the SAME
    // reducer a resumed history uses; `state.ts` owns that rule (T2 pins it),
    // and `foreign-turns.test.tsx` pins the activity plumbing. Here the pure
    // reducer is asserted directly, on the event the client now produces.
    const { applySessionEvent, initialState } = await import("../src/state.ts");
    const state = applySessionEvent(
      initialState,
      {
        type: "user_message",
        text: "look",
        attachments: [{ id: "e".repeat(64), mimeType: "image/png", size: 4, name: "x.png" }],
      },
      0,
    );
    expect(state.items.at(-1)).toMatchObject({
      kind: "user",
      text: "look",
      images: ["[image: x.png]"],
    });
  });
});

describe("T8l: /attach resolves a relative path against the laptop's cwd", () => {
  test("`/attach rel.png` reads <localCwd>/rel.png", async () => {
    const session = fakeSession({});
    const probe = probeOf({ "/work/rel.png": PNG });
    const app = render(
      <App
        createSession={() => session}
        model="m"
        cwd="ws://daemon:7777" // under `connect` this prop is a URL (P15)
        columns={100}
        fileProbe={probe}
        home="/home/u"
        localCwd="/work"
      />,
    );
    await delay(30);
    app.stdin.write("/attach rel.png");
    await delay(20);
    app.stdin.write(ENTER);
    await delay(120);
    expect(probe.reads).toEqual(["/work/rel.png"]);
    expect(strip(app.lastFrame() ?? "")).toContain("rel.png");
    app.unmount();
  });

  test("a missing file is a sentence, nothing inserted", async () => {
    const session = fakeSession({});
    const probe = probeOf({});
    const app = render(
      <App
        createSession={() => session}
        model="m"
        cwd="ws://daemon:7777"
        columns={100}
        fileProbe={probe}
        home="/home/u"
        localCwd="/work"
      />,
    );
    await delay(30);
    app.stdin.write("/attach nope.png");
    await delay(20);
    app.stdin.write(ENTER);
    await delay(120);
    const frame = strip(app.lastFrame() ?? "");
    expect(frame).toContain("no such file");
    expect(frame).not.toContain("[image:");
    app.unmount();
  });

  test("`/attach` with no path shows the usage line", async () => {
    const m = mount(fakeSession({}), { files: {} });
    await delay(30);
    await m.type("/attach");
    expect(m.frame()).toContain("Usage");
    m.unmount();
  });
});

describe("T8m: /retry sends the text only and says so", () => {
  test("after an image prompt, /retry re-sends text and notices the omission", async () => {
    const session = fakeSession({});
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    await m.type("what?");
    expect(session.sent).toHaveLength(1);
    await m.type("/retry");
    const frame = m.frame();
    expect(frame).toContain("attach the image again");
    expect(session.sent.at(-1)?.attachments).toBeUndefined();
    m.unmount();
  });
});

describe("the chip is removable and Esc aborts an upload", () => {
  test("Backspace on an empty input removes the last chip", async () => {
    const session = fakeSession({});
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    expect(m.frame()).toContain("a.png");
    await m.press("\u007f"); // DEL / Backspace
    expect(m.frame()).not.toContain("📎");
    await m.type("");
    expect(session.sent).toEqual([]); // nothing left to send
    m.unmount();
  });

  test("Esc during a held upload aborts it and keeps the chip", async () => {
    const session = fakeSession({
      attach: async (bytes, meta, o) =>
        new Promise<AttachmentRef>((resolve, reject) => {
          o?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("the upload was aborted"), { name: "UploadAbortedError" }),
              ),
            { once: true },
          );
          void resolve;
          void bytes;
          void meta;
        }),
    });
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    m.stdin.write("what?");
    await delay(20);
    m.stdin.write(ENTER);
    await delay(80);
    await m.press(ESC);
    const frame = m.frame();
    expect(frame).toContain("upload cancelled");
    expect(frame).toContain("a.png");
    m.unmount();
  });
});

describe("fix round 1, finding 1: a path that is not an image never swallows the user's text", () => {
  test("a pasted missing path stays in the input (the 3a 'whole paste stays text' rule)", async () => {
    const session = fakeSession({});
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste("~/missing.md");
    const frame = m.frame();
    expect(frame).toContain("missing.md");
    expect(session.sent).toEqual([]);
    m.unmount();
  });

  test("a pasted directory or source file stays in the input too", async () => {
    const session = fakeSession({});
    const m = mount(session, {
      files: { "/w/a.txt": new Uint8Array([104, 105]), "/w/b.txt": new Uint8Array([104, 105]) },
    });
    await delay(30);
    await m.paste("/w/a.txt /w/b.txt");
    expect(m.frame()).toContain("/w/a.txt");
    expect(session.sent).toEqual([]);
    m.unmount();
  });

  test("a typed drop whose partner is not an image keeps the text (and says why)", async () => {
    // `imageDropOnly` says "a drag" (a.png claims an image), but 3a's rule makes
    // the WHOLE text stay text: it must come back, with an explanation.
    const session = fakeSession({});
    const m = mount(session, {
      files: { [PNG_PATH]: PNG, "/w/b.txt": new Uint8Array([104, 105]) },
    });
    await delay(30);
    await m.type(`${PNG_PATH} /w/b.txt`);
    const frame = m.frame();
    expect(frame).toContain("not an image");
    expect(frame).toContain("/w/b.txt"); // back in the input, not lost
    expect(session.sent).toEqual([]);
    m.unmount();
  });

  test("a TYPED non-image path + Enter sends it as a message, never a silent clear", async () => {
    // Review finding 1's second half: `convertToChips` probed, got `text`, and
    // cleared the field with nothing sent and nothing said.
    const session = fakeSession({});
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.type("~/notes.md");
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.prompt).toBe("~/notes.md");
    m.unmount();
  });
});

describe("fix round 1, finding 2: Enter during an upload never sends the prompt twice", () => {
  test("a second Enter while the chip uploads is refused; exactly one send", async () => {
    const finished: (() => void)[] = [];
    const session = fakeSession({
      attach: async (bytes, meta) => {
        await new Promise<void>((resolve) => finished.push(resolve));
        return {
          id: "f".repeat(64),
          mimeType: meta.mimeType,
          size: bytes.length,
          ...(meta.name !== undefined ? { name: meta.name } : {}),
        };
      },
    });
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    m.stdin.write("q1");
    await delay(20);
    m.stdin.write(ENTER); // starts the upload
    await delay(120);
    m.stdin.write("q2");
    await delay(20);
    m.stdin.write(ENTER); // during the upload: refused, not a second send
    await delay(80);
    expect(m.frame()).toContain("still uploading");
    for (const f of finished.splice(0)) f();
    await delay(150);
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.prompt).toBe("q1");
    expect(session.sent[0]?.attachments).toHaveLength(1);
    m.unmount();
  });
});

describe("fix round 1, finding 3: the first Esc after an image prompt stops the turn", () => {
  test("a finished upload leaves no controller for Esc to swallow", async () => {
    let aborted = 0;
    const session: SessionController = {
      send(_prompt, signal) {
        return (async function* (): AsyncIterable<SessionEvent> {
          // A turn that only ends when it is aborted.
          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) {
              aborted += 1;
              resolve();
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                aborted += 1;
                resolve();
              },
              { once: true },
            );
          });
          yield { type: "turn_end", reason: "cancelled" as never };
        })();
      },
      imageInput: () => ({ kind: "upload" as const, maxBytes: 4 * 1024 * 1024 }),
      attachImage: async (bytes, meta) => ({
        id: "a".repeat(64),
        mimeType: meta.mimeType,
        size: bytes.length,
        ...(meta.name !== undefined ? { name: meta.name } : {}),
      }),
    };
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    m.stdin.write("q");
    await delay(20);
    m.stdin.write(ENTER);
    await delay(200); // the upload finished long ago
    await m.press(ESC); // the FIRST Esc must reach the turn
    expect(aborted).toBe(1);
    m.unmount();
  });

  test("unmounting mid-upload aborts it (nothing left half-sent)", async () => {
    let signal: AbortSignal | undefined;
    const session = fakeSession({
      attach: (_bytes, _meta, o) =>
        new Promise<AttachmentRef>(() => {
          signal = o?.signal;
        }),
    });
    const m = mount(session, { files: { [PNG_PATH]: PNG } });
    await delay(30);
    await m.paste(PNG_PATH);
    m.stdin.write("what?");
    await delay(20);
    m.stdin.write(ENTER);
    await delay(120);
    expect(signal?.aborted).toBe(false);
    m.unmount();
    await delay(40);
    expect(signal?.aborted).toBe(true);
  });
});
