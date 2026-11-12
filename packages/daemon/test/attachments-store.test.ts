/**
 * Image refs through the laptop's on-disk store (docs/feat/attachments-core.md,
 * D2/D7, T4 second half).
 *
 * Two things only the real store can prove: a save → load round trip keeps the
 * refs (append path AND the rewrite path), and a file an older build cannot read
 * is left BYTE-IDENTICAL — refused, never rewritten into something lossy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentRef, ChatMessage } from "@tentacle/core";
import { type KnownLogEntry, appendEntryBody } from "@tentacle/protocol";
import { headerLine } from "../src/session-log-file.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { FakeLog, FakeReader, META, asst, user } from "./support/log-fixture.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-attach-store-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
let n = 0;
const fresh = (): string => join(dir, `d${++n}`);

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 1234,
  name: "cat.png",
  ...over,
});

const imageMessage = (content = "what is this?"): ChatMessage => ({
  role: "user",
  content,
  attachments: [ref()],
});

describe("T4 — save → load keeps the refs", () => {
  test("a cold write and a LATER APPEND round-trip with refs deep-equal", async () => {
    const store = new LogSessionStore(fresh());
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base([user("go")]), "cold"));
    // An appended round that carries an image (the append path, not a rewrite).
    await store.write(reader.read([log.msg(imageMessage("look"))]));
    const result = await store.load("s");
    if (result.status !== "ok") throw new Error(`load failed: ${result.status}`);
    const loaded = result.record.messages;
    expect(loaded).toHaveLength(2);
    expect(loaded[1]?.attachments).toEqual([ref()]);
    // The file really holds the media type, not a plain `message`.
    expect(await readFile(store.file("s"), "utf8")).toContain('"type":"media_message"');
  });

  test("a REWRITE path (a write that cannot append) keeps them too", async () => {
    const store = new LogSessionStore(fresh());
    const reader = new FakeReader("s");
    const log = new FakeLog("D1");
    await store.write(reader.read(log.base([imageMessage("first"), asst("ok")]), "cold"));
    // A second writer holding a DIFFERENT history forces a replace-from-segment.
    const other = new FakeLog("D2");
    const otherReader = new FakeReader("s");
    await store.write(
      otherReader.read(other.base([imageMessage("seed"), user("later")], "seed"), "cold"),
    );
    const result = await store.load("s");
    if (result.status !== "ok") throw new Error(`load failed: ${result.status}`);
    expect(result.record.messages[0]?.attachments).toEqual([ref()]);
  });
});

describe("T4 — a file an older build cannot read is refused, untouched", () => {
  test("an unknown CRITICAL entry leaves the bytes exactly as they were", async () => {
    const where = fresh();
    const store = new LogSessionStore(where);
    const log = new FakeLog("D1");
    const entries: KnownLogEntry[] = [...log.base([user("hi")])];
    // What a NEWER build would write and this one cannot project.
    entries.push({
      type: "media_message_from_the_future",
      critical: true,
      seq: 99,
      id: "D1/99",
      ts: 1,
      message: imageMessage(),
    } as unknown as KnownLogEntry);
    const text = `${headerLine({ id: "s", ...META })}${entries
      .map((e) => `${JSON.stringify(e)}\n`)
      .join("")}`;
    await mkdir(where, { recursive: true });
    await writeFile(store.file("s"), text, { mode: 0o600 });

    const result = await store.load("s");
    expect(result.status).not.toBe("ok");
    // Refused loudly AND left byte-identical (never rewritten into a lossy copy).
    expect(await readFile(store.file("s"), "utf8")).toBe(text);
  });

  test("a media_message whose refs are malformed is refused the same way", async () => {
    const where = fresh();
    const store = new LogSessionStore(where);
    const log = new FakeLog("D1");
    const entries = [
      ...log.base([user("hi")]),
      {
        ...(appendEntryBody(imageMessage() as never) as object),
        seq: 99,
        id: "D1/99",
        ts: 1,
        message: { ...imageMessage(), attachments: [{ id: "bad", mimeType: "x", size: 0 }] },
      },
    ];
    const text = `${headerLine({ id: "s", ...META })}${entries
      .map((e) => `${JSON.stringify(e)}\n`)
      .join("")}`;
    await mkdir(where, { recursive: true });
    await writeFile(store.file("s"), text, { mode: 0o600 });
    const result = await store.load("s");
    expect(result.status).not.toBe("ok");
    expect(await readFile(store.file("s"), "utf8")).toBe(text);
  });
});
