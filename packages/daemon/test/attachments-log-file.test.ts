/**
 * Image refs in the ON-DISK log (docs/feat/attachments-core.md, D2/D7, T4).
 *
 * The silent-failure this task exists to prevent (repro *r4*): the log entry
 * type was known and CRITICAL, so an older build parsed a message entry and
 * stripped the refs — a silent half-load, forbidden by AGENTS §7. The fix is a
 * type an older build does NOT know, which makes it refuse the whole file
 * loudly. Both halves are proved here: the refs survive a save → load, and a
 * file whose media entry an older build cannot know is REFUSED, untouched.
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef, ChatMessage } from "@tentacle/core";
import { type KnownLogEntry, LOG_ENTRY_CRITICAL } from "@tentacle/protocol";
import {
  entryLines,
  foldThrough,
  headerLine,
  parseLogFile,
  segmentFromMessages,
} from "../src/session-log-file.ts";
import { FakeLog, META, user } from "./support/log-fixture.ts";

const ID = "s1";
const header = headerLine({ id: ID, ...META });

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 1234,
  name: "cat.png",
  ...over,
});

const imageMessage = (content = "what is this?", refs: AttachmentRef[] = [ref()]): ChatMessage => ({
  role: "user",
  content,
  attachments: refs,
});

function parsed(text: string) {
  const result = parseLogFile(text, ID);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe("T4 — a saved message with refs loads with them", () => {
  test("base(count 2) + media_message + message loads with refs deep-equal", () => {
    const entries = new FakeLog("D1").base([user("hi"), imageMessage("look")]);
    const loaded = parsed(`${header}${entryLines(entries)}`);
    const segment = loaded.segments.at(-1);
    expect(segment?.messages[1]?.attachments).toEqual([ref()]);
    // And the media entry really is what carries it (not a plain `message`).
    expect(entries.some((e) => e.type === "media_message")).toBe(true);
  });

  test("an OLDER build refusing a media_message is why the type is critical", () => {
    // What an older build does: it knows no `media_message`. The file parse
    // refuses the whole thing rather than folding a message without its refs.
    expect(LOG_ENTRY_CRITICAL.media_message).toBe(true);
    // An unknown-critical type is refused by the file parser (its own check).
    const entry = new FakeLog("D3").msg(imageMessage());
    const renamed = { ...entry, type: "media_from_the_future" } as unknown as KnownLogEntry;
    const text = `${header}${entryLines([...new FakeLog("D4").base([user("hi")]), renamed])}`;
    const result = parseLogFile(text, ID);
    expect(result.ok).toBe(false);
  });

  test("segmentFromMessages uses the media type for a message with refs", () => {
    const entries = segmentFromMessages([imageMessage(), user("plain")], undefined, "F1", 5);
    const types = entries.map((e) => e.type);
    expect(types).toEqual(["base", "media_message", "message"]);
    const media = entries.find((e) => e.type === "media_message");
    expect((media as { message: ChatMessage }).message.attachments).toEqual([ref()]);
    // The segment round-trips through the parser, refs and all.
    const loaded = parsed(`${header}${entryLines(entries)}`);
    expect(loaded.segments.at(-1)?.messages[0]?.attachments).toEqual([ref()]);
    // And the fold keeps them (the same `projectEntry` the reader uses).
    const last = loaded.segments.at(-1)?.entries.at(-1);
    expect(last).toBeDefined();
    const folded = foldThrough(loaded, { seq: last?.seq ?? 0, id: last?.id ?? "" });
    expect(folded?.[0]?.attachments).toEqual([ref()]);
  });

  test("a replace with refs rides media_replace and still folds by index", () => {
    const log = new FakeLog("F2");
    const entries: KnownLogEntry[] = [
      ...log.base([user("hi")]),
      log.replace(0, imageMessage("edited")),
    ];
    // A replace with refs rides the media type, with its refs.
    expect(entries.at(-1)?.type).toBe("media_replace");
    expect(entries.at(-1)).toMatchObject({ critical: true, index: 0 });
    expect((entries.at(-1) as { message: ChatMessage }).message.attachments).toEqual([ref()]);
    // The shared fold (the reader's) applies it by index, refs and all.
    const loaded = parsed(`${header}${entryLines(entries)}`);
    expect(loaded.segments.at(-1)?.messages).toEqual([imageMessage("edited")]);
  });

  test("a media entry whose refs are malformed is refused, never repaired", () => {
    const log = new FakeLog("F3");
    const bad = log.msg(imageMessage());
    const broken = {
      ...bad,
      message: { ...imageMessage(), attachments: [{ id: "nope", mimeType: "x", size: 1 }] },
    } as unknown as KnownLogEntry;
    const text = `${header}${entryLines([...new FakeLog("F4").base([user("hi")]), broken])}`;
    expect(parseLogFile(text, ID).ok).toBe(false);
  });
});
