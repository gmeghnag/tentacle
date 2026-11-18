/**
 * The outbox's file (docs/feat/mobile-compose.md 13b, D4/P10, F21): versioned,
 * atomic, never half-loaded. A fake fs proves the crash windows without a
 * simulator (AGENTS §9: injectable seams, not real I/O).
 *
 * Each test names its mutation.
 */
import { describe, expect, test } from "bun:test";
import type { DocumentContent } from "@tentacle/protocol";
import type { Draft } from "../src/drafts.ts";
import {
  OUTBOX_SCHEMA_VERSION,
  OUTBOX_SCHEMA_VERSION_DOCUMENTS,
  type OutboxFs,
  createOutboxStore,
  outboxPaths,
  serializeOutbox,
} from "../src/outbox-store.ts";
import type { OutboxItem } from "../src/outbox.ts";

/** A memory fs, with the two failures a real one has: a write that throws, and a killed rename. */
interface FakeFs extends OutboxFs {
  readonly files: Map<string, string>;
  /** The next `write` throws (a full disk). */
  failWrite: boolean;
  /** The next `rename` throws: the crash window between tmp and rename. */
  failRename: boolean;
  /** The next `read` throws (an I/O error, not "absent"). */
  failRead: boolean;
  /** Files left behind by a killed write, for the assertion that they are harmless. */
  tmpFiles(): readonly string[];
}

function memoryFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(initial));
  const fs: FakeFs = {
    files,
    failWrite: false,
    failRename: false,
    failRead: false,
    async read(path) {
      if (fs.failRead) {
        throw new Error("EIO");
      }
      return files.get(path) ?? null;
    },
    async write(path, text) {
      if (fs.failWrite) {
        throw new Error("ENOSPC");
      }
      files.set(path, text);
    },
    async rename(from, to) {
      if (fs.failRename) {
        throw new Error("killed");
      }
      const text = files.get(from);
      if (text === undefined) {
        throw new Error(`ENOENT: ${from}`);
      }
      files.delete(from);
      files.set(to, text);
    },
    async remove(path) {
      files.delete(path);
    },
    async list(dir) {
      return [...files.keys()].filter((path) => path.startsWith(`${dir}/`));
    },
    tmpFiles() {
      return [...files.keys()].filter((path) => path.endsWith(".tmp"));
    },
  };
  return fs;
}

const item = (itemId: string): OutboxItem => ({
  itemId,
  computerId: "c1",
  sessionId: "s1",
  kind: "prompt",
  text: `text-${itemId}`,
  photos: [{ file: `/copy/${itemId}/0.png`, mimeType: "image/png", name: "0.png" }],
  turnId: `turn-${itemId}`,
  enqueueId: `enq-${itemId}`,
  steerTurnId: null,
  basis: { historyLength: 2, runningTurnId: null },
  state: "waiting",
});

const draft = (text: string): Draft => ({
  computerId: "c1",
  sessionId: "s1",
  text,
  photos: [],
  savedAt: 3,
});

const paths = outboxPaths("/root", "c1");

describe("round trip", () => {
  test("what was written is what loads, on a fresh store over the same fs", async () => {
    const fs = memoryFs();
    const first = createOutboxStore(fs, paths);
    expect(await first.load()).toEqual({
      kind: "absent",
      data: { items: [], drafts: [], ownIds: [] },
    });
    expect(await first.setItems([item("a"), item("b")])).toBe(true);
    expect(await first.setDrafts([draft("hi")])).toBe(true);
    expect(await first.setOwnIds(["id-1"])).toBe(true);

    // A relaunch: a NEW store reads the same bytes.
    const again = createOutboxStore(fs, paths);
    const loaded = await again.load();
    expect(loaded.kind).toBe("loaded");
    if (loaded.kind !== "loaded") return;
    expect(loaded.data.items.map((entry) => entry.itemId)).toEqual(["a", "b"]);
    expect(loaded.data.items[0]?.turnId).toBe("turn-a"); // keys survive a kill
    expect(loaded.data.drafts.map((entry) => entry.text)).toEqual(["hi"]);
    expect(loaded.data.ownIds).toEqual(["id-1"]);
  });

  test("two computers write two files, and neither sees the other's items", async () => {
    const fs = memoryFs();
    const one = createOutboxStore(fs, outboxPaths("/root", "c1"));
    const two = createOutboxStore(fs, outboxPaths("/root", "c2"));
    await one.load();
    await two.load();
    await one.setItems([item("a")]);
    await two.setItems([]);
    expect(outboxPaths("/root", "c1").state).not.toBe(outboxPaths("/root", "c2").state);
    const other = createOutboxStore(fs, outboxPaths("/root", "c2"));
    const loaded = await other.load();
    expect(loaded.kind === "loaded" ? loaded.data.items : null).toEqual([]);
  });

  test("a computer id can never escape the root (it is a path segment)", () => {
    expect(outboxPaths("/root", "../../etc").state).toBe("/root/outbox-.._.._etc.json");
    expect(outboxPaths("/root", "c1").copies("../x")).toBe("/root/outbox/.._x");
  });
});

describe("the crash windows", () => {
  test("a kill between tmp and rename leaves the OLD file intact (mutation: write in place → red)", async () => {
    const fs = memoryFs();
    const store = createOutboxStore(fs, paths);
    await store.load();
    await store.setItems([item("a")]);
    const before = fs.files.get(paths.state) ?? "";

    // The next write lands its tmp, then the process dies before the rename.
    fs.failRename = true;
    expect(await store.setItems([item("a"), item("b")])).toBe(false);
    expect(fs.files.get(paths.state)).toBe(before); // untouched: still one item
    expect(before).not.toBe("");
    expect(fs.tmpFiles()).toHaveLength(1); // the orphan, harmless

    // And the memory state kept the newer list: the banner told the person it
    // is not saved, and the next successful write persists both.
    expect(store.data.items.map((entry) => entry.itemId)).toEqual(["a", "b"]);
    fs.failRename = false;
    expect(await store.setItems(store.data.items)).toBe(true);
    const reloaded = createOutboxStore(fs, paths);
    const loaded = await reloaded.load();
    expect(loaded.kind === "loaded" ? loaded.data.items.map((e) => e.itemId) : []).toEqual([
      "a",
      "b",
    ]);
  });

  test("a full disk answers false and keeps the state in memory (the not-saved banner, F21)", async () => {
    const fs = memoryFs();
    const store = createOutboxStore(fs, paths);
    await store.load();
    fs.failWrite = true;
    expect(await store.setItems([item("a")])).toBe(false);
    expect(store.data.items).toHaveLength(1);
    // Nothing reached the disk: a relaunch finds an empty outbox.
    const fresh = createOutboxStore(fs, paths);
    expect((await fresh.load()).kind).toBe("absent");
  });
});

describe("what it refuses", () => {
  test("an unknown schemaVersion is refused and the file is NOT touched (mutation: overwrite → red)", async () => {
    const unknown = OUTBOX_SCHEMA_VERSION_DOCUMENTS + 1;
    const newer = JSON.stringify({
      schemaVersion: unknown,
      items: [],
      drafts: [],
      ownIds: [],
    });
    const fs = memoryFs({ [paths.state]: newer });
    const store = createOutboxStore(fs, paths);
    expect(await store.load()).toEqual({ kind: "refused", version: unknown });
    // A write is refused too: a newer build's unsent text is not ours to destroy.
    expect(await store.setItems([item("a")])).toBe(false);
    expect(await store.removeItem("a")).toBe(false);
    expect(fs.files.get(paths.state)).toBe(newer);
  });

  test("an unparsable file is SET ASIDE, never deleted, and the store then works again (mutations: delete it → red; stay read-only for the process → red)", async () => {
    const fs = memoryFs({ [paths.state]: "{ this is not json" });
    let stamp = 1_700_000_000_000;
    const store = createOutboxStore(fs, paths, () => stamp);
    const result = await store.load();
    expect(result).toEqual({ kind: "corrupt", asideTo: `${paths.state}.corrupt-${stamp}` });
    expect(fs.files.get(`${paths.state}.corrupt-${stamp}`)).toBe("{ this is not json");
    // And the store starts empty rather than half-loading the broken file.
    expect(store.data).toEqual({ items: [], drafts: [], ownIds: [] });
    // Its bytes are safe under `asideTo`, so there is nothing left to protect:
    // a store that stayed read-only would make every compose until relaunch
    // memory-only (`not-saved` for text with nowhere to go but RAM).
    stamp += 1;
    expect(await store.setItems([item("a")])).toBe(true);
    const reloaded = createOutboxStore(fs, paths, () => stamp);
    const loaded = await reloaded.load();
    expect(loaded.kind === "loaded" ? loaded.data.items.map((e) => e.itemId) : []).toEqual(["a"]);
  });

  test("a corrupt file that could NOT be moved aside leaves the store read-only (its bytes are still the only copy)", async () => {
    const fs = memoryFs({ [paths.state]: "{ this is not json" });
    fs.failRename = true;
    const store = createOutboxStore(fs, paths, () => 7);
    expect(await store.load()).toEqual({ kind: "corrupt", asideTo: `${paths.state}.corrupt-7` });
    // Never written over: the unread file is the person's only copy.
    expect(await store.setItems([item("a")])).toBe(false);
    expect(fs.files.get(paths.state)).toBe("{ this is not json");
    expect(store.data.items).toHaveLength(1); // memory only
  });

  test("a well-formed file with one bad item is corrupt as a whole (never half-loaded)", async () => {
    const text = JSON.stringify({
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      items: [{ ...item("a") }, { itemId: 7 }],
      drafts: [],
      ownIds: [],
    });
    const fs = memoryFs({ [paths.state]: text });
    const store = createOutboxStore(fs, paths, () => 5);
    const result = await store.load();
    expect(result.kind).toBe("corrupt");
    expect(store.data.items).toEqual([]); // not even the good one
  });

  test("an item of an unknown STATE is refused as corrupt (a newer build's state is not guessed)", async () => {
    const text = JSON.stringify({
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      items: [{ ...item("a"), state: "teleported" }],
      drafts: [],
      ownIds: [],
    });
    const fs = memoryFs({ [paths.state]: text });
    const store = createOutboxStore(fs, paths, () => 6);
    expect((await store.load()).kind).toBe("corrupt");
  });

  test("a file with a DOCUMENT is written as v2, so an older build refuses it instead of dropping the PDF (mutation: always `OUTBOX_SCHEMA_VERSION` → red)", () => {
    // The whole point of the bump: P6 review item 2. An older build's `isItem`
    // does not know `documents`, so a v1 file naming one would load and send
    // the item as text plus photos — the PDF gone, and a PDF-only item going
    // out as an EMPTY prompt. Saying `2` makes it refuse the file untouched.
    const withPdf = serializeOutbox({
      items: [{ ...item("a"), documents: [{ file: "/c/a.pdf", name: "a.pdf" }] }],
      drafts: [],
      ownIds: [],
    });
    expect(JSON.parse(withPdf).schemaVersion).toBe(OUTBOX_SCHEMA_VERSION_DOCUMENTS);
    // A file with no PDF stays v1: a downgrade keeps working for everyone it
    // CAN work for, instead of refusing an outbox it reads perfectly.
    const plain = serializeOutbox({ items: [item("a")], drafts: [], ownIds: [] });
    expect(JSON.parse(plain).schemaVersion).toBe(OUTBOX_SCHEMA_VERSION);
  });

  test("a v2 file loads whole, its blocks intact (mutation: accept v1 only → red)", async () => {
    const BLOCK: DocumentContent = {
      type: "document",
      kind: "pdf",
      name: "report.pdf",
      source: { type: "text", text: "page one", pages: 1 },
    };
    const items = [
      { ...item("a"), documents: [{ file: "/c/a.pdf", name: "a.pdf", block: BLOCK }] },
    ];
    const fs = memoryFs({ [paths.state]: serializeOutbox({ items, drafts: [], ownIds: [] }) });
    const loaded = await createOutboxStore(fs, paths).load();
    expect(loaded.kind).toBe("loaded");
    if (loaded.kind !== "loaded") return;
    // The block is what a resume must NOT redo (it names an `attachment/put`
    // already paid for, or text a pod's daemon awaits): losing it re-uploads.
    expect(loaded.data.items[0]?.documents).toEqual([
      { file: "/c/a.pdf", name: "a.pdf", block: BLOCK },
    ]);
  });

  test("a v2 file whose stored block is not the wire's shape is corrupt (mutation: `isDocument` → accept anything → red)", async () => {
    // The block is handed straight to `session/prompt`, so a garbage one would
    // be refused by the daemon only AFTER the whole prompt was sent.
    const text = JSON.stringify({
      schemaVersion: OUTBOX_SCHEMA_VERSION_DOCUMENTS,
      items: [
        {
          ...item("a"),
          documents: [{ file: "/c/a.pdf", name: "a.pdf", block: { type: "document" } }],
        },
      ],
      drafts: [],
      ownIds: [],
    });
    const fs = memoryFs({ [paths.state]: text });
    const store = createOutboxStore(fs, paths, () => 8);
    expect((await store.load()).kind).toBe("corrupt");
    expect(store.data.items).toEqual([]);
  });
});

describe("finishing an item", () => {
  test("removing it drops it from the file but KEEPS its photo copies (Review round 2 R2-1: the transcript's own row draws them, and the row outlives the item — mutation: delete them again → red)", async () => {
    const fs = memoryFs();
    const store = createOutboxStore(fs, paths);
    await store.load();
    await store.setItems([item("a"), item("b")]);
    fs.files.set("/copy/a/0.png", "bytes");
    expect(await store.removeItem("a")).toBe(true);
    expect(store.data.items.map((entry) => entry.itemId)).toEqual(["b"]);
    // The person's row on screen still names this file (`localPhotosOf` →
    // `ImageRef.localUri`), and the daemon offers no read-back, so the copy is
    // the only pixels there are: it must still be readable after the ack.
    expect(fs.files.has("/copy/a/0.png")).toBe(true);
    // A relaunch agrees.
    const again = createOutboxStore(fs, paths);
    const loaded = await again.load();
    expect(loaded.kind === "loaded" ? loaded.data.items.map((e) => e.itemId) : []).toEqual(["b"]);
  });

  test("the removal never touches the photo folder at all (mutation: any `fs.remove` here → red)", async () => {
    const fs = memoryFs();
    const store = createOutboxStore(fs, paths);
    await store.load();
    await store.setItems([item("a")]);
    const removed: string[] = [];
    fs.remove = async (path) => {
      removed.push(path);
    };
    expect(await store.removeItem("a")).toBe(true);
    expect(store.data.items).toEqual([]);
    // Bounding the folder is `photo-copies.ts`'s decision, over a grace window
    // and the copies still in use — never a delete at the ack.
    expect(removed).toEqual([]);
  });
});

describe("two writers at once (one file per computer, one store)", () => {
  /**
   * An fs whose writes finish in the REVERSE of the order they started — a
   * real device's fs promises no order at all, so this is the ordinary case,
   * not an exotic one. Without a write queue the slower (older) write lands
   * last and the file regresses; with two writers sharing `<state>.tmp`, one
   * even renames the other's bytes.
   */
  const racingFs = (): FakeFs => {
    const fs = memoryFs();
    const started: { path: string; text: string }[] = [];
    let writes = 0;
    return Object.assign(fs, {
      async write(path: string, text: string) {
        const index = writes++;
        started.push({ path, text });
        await new Promise((resolve) => setTimeout(resolve, index === 0 ? 25 : 1));
        fs.files.set(path, text);
      },
    });
  };

  test("overlapping writes land in order: the NEWEST state is on disk (mutation: no write queue → the older one wins)", async () => {
    const fs = racingFs();
    const store = createOutboxStore(fs, paths);
    await store.load();
    const older = store.setOwnIds(["a"]);
    const newer = store.setOwnIds(["a", "b"]);
    expect(await Promise.all([older, newer])).toEqual([true, true]);
    expect(JSON.parse(fs.files.get(paths.state) ?? "{}").ownIds).toEqual(["a", "b"]);
    expect(store.data.ownIds).toEqual(["a", "b"]);
  });

  test("two writers that both change the file (items + own ids) do not overwrite each other (mutation: shared tmp path → one write's bytes are lost)", async () => {
    const fs = racingFs();
    const store = createOutboxStore(fs, paths);
    await store.load();
    const ids = store.setOwnIds(["i1"]);
    // The SECOND write starts while the first is still in its fs: its own tmp
    // name is what keeps the first write's bytes from being renamed away.
    const items = store.setItems([item("a")]);
    expect(await Promise.all([ids, items])).toEqual([true, true]);
    const onDisk = JSON.parse(fs.files.get(paths.state) ?? "{}");
    expect(onDisk.ownIds).toEqual(["i1"]);
    expect(onDisk.items.map((entry: OutboxItem) => entry.itemId)).toEqual(["a"]);
    // Both collections survive a relaunch: no lost update.
    const reloaded = createOutboxStore(fs, paths);
    const loaded = await reloaded.load();
    expect(loaded.kind === "loaded" ? loaded.data : null).toEqual({
      items: [item("a")],
      drafts: [],
      ownIds: ["i1"],
    });
  });

  test("a write that fails leaves the queue usable: the NEXT write still lands (mutation: a rejected tail poisons it → every later write fails)", async () => {
    const fs = memoryFs();
    const store = createOutboxStore(fs, paths);
    await store.load();
    fs.failWrite = true;
    expect(await store.setItems([item("a")])).toBe(false);
    fs.failWrite = false;
    expect(await store.setItems([item("a"), item("b")])).toBe(true);
    const reloaded = createOutboxStore(fs, paths);
    const loaded = await reloaded.load();
    expect(loaded.kind === "loaded" ? loaded.data.items.map((e) => e.itemId) : []).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("the file's shape", () => {
  test("it carries the version, and only the three collections", () => {
    const parsed = JSON.parse(
      serializeOutbox({ items: [item("a")], drafts: [draft("d")], ownIds: ["i"] }),
    );
    expect(parsed.schemaVersion).toBe(OUTBOX_SCHEMA_VERSION);
    expect(Object.keys(parsed).sort()).toEqual(["drafts", "items", "ownIds", "schemaVersion"]);
  });

  test("its text reloads to the same data (no lossy field)", async () => {
    const fs = memoryFs();
    const store = createOutboxStore(fs, paths);
    await store.load();
    const items = [item("a")];
    await store.setItems(items);
    const loaded = await createOutboxStore(fs, paths).load();
    expect(loaded.kind === "loaded" ? loaded.data.items : []).toEqual(items);
  });
});
