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
import {
  DAEMON_STATE_VERSION,
  DAEMON_STATE_VERSIONS,
  DAEMON_STATE_VERSION_NO_MEDIA,
  type DaemonSidecar,
  encodeSidecar,
  parseSidecar,
  sidecarOf,
} from "../src/daemon-state-file.ts";
import type { DaemonSessionRecord } from "../src/persisted-session.ts";
import { entryLines, headerLine } from "../src/session-log-file.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { type SessionFiles, decodeFiles } from "./support/daemon-store-spy.ts";
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

describe("M1 — the state file is versioned for image refs (never half-loaded)", () => {
  // The `serve` sidecar's `tail` is a prompt accepted but not yet committed. An
  // OLDER build parses it with a `ChatMessageSchema` that strips `attachments`,
  // then appends it as a plain `message`: a silent half-load. So the version
  // number — not a schema — is what protects it, exactly as the critical media
  // log entry type protects the log.
  const recordWith = (messages: readonly ChatMessage[]): DaemonSessionRecord => ({
    id: "s",
    cwd: "/w",
    model: "m",
    createdAt: 1,
    updatedAt: 2,
    title: "t",
    messages,
    lastActiveAt: 3,
    turns: [],
    enqueueIds: [],
    returned: [],
    // Nothing shared with the log: the whole history is the overlay.
    logged: [],
    logHead: { seq: 1, id: "d/1" },
    paired: true,
    loadNotes: [],
  });

  test("a tail with refs is written schemaVersion 2; without refs, 1", () => {
    expect(sidecarOf(recordWith([user("hi")])).schemaVersion).toBe(DAEMON_STATE_VERSION_NO_MEDIA);
    expect(sidecarOf(recordWith([user("hi"), imageMessage()])).schemaVersion).toBe(
      DAEMON_STATE_VERSION,
    );
    // The refs themselves survive: the bump is not instead of carrying them.
    expect(sidecarOf(recordWith([imageMessage()])).tail[0]?.attachments).toEqual([ref()]);
  });

  test("the reader accepts BOTH versions, and a v2 file keeps its refs", () => {
    // v1: no refs anywhere (every build can read it).
    const plain = encodeSidecar(sidecarOf(recordWith([user("hi")])));
    expect(JSON.parse(plain).schemaVersion).toBe(DAEMON_STATE_VERSION_NO_MEDIA);
    const plainParsed = parseSidecar(plain, "s");
    if (!plainParsed.ok) throw new Error(`v1 refused: ${plainParsed.reason}`);
    expect(plainParsed.value.tail).toEqual([user("hi")]);

    // v2: the tail carries refs, and they survive the round trip.
    const media = encodeSidecar(sidecarOf(recordWith([user("hi"), imageMessage()])));
    expect(JSON.parse(media).schemaVersion).toBe(DAEMON_STATE_VERSION);
    const mediaParsed = parseSidecar(media, "s");
    if (!mediaParsed.ok) throw new Error(`v2 refused: ${mediaParsed.reason}`);
    expect(mediaParsed.value.tail[1]?.attachments).toEqual([ref()]);
    // A v2 file WITHOUT refs is read too: a build may bump without adding one.
    const v2NoRefs = encodeSidecar({
      ...sidecarOf(recordWith([user("hi")])),
      schemaVersion: DAEMON_STATE_VERSION,
    });
    expect(parseSidecar(v2NoRefs, "s").ok).toBe(true);
  });

  test("an OLDER daemon (v1-only) refuses v2 loudly and leaves the files untouched", () => {
    // The older build, modelled exactly: it accepts ONLY version 1, and its
    // message schema strips `attachments` (that is why v2 exists).
    const olderAccepts = (text: string): "ok" | string => {
      const value = JSON.parse(text) as { schemaVersion?: unknown };
      return value.schemaVersion === 1
        ? "ok"
        : `state file schemaVersion ${JSON.stringify(value.schemaVersion)} is not 1 (written by another tentacle version): update tentacle`;
    };
    const text = encodeSidecar(sidecarOf(recordWith([imageMessage()])));
    expect(olderAccepts(text)).toContain("is not 1");

    // And the reload path really carries the refs: a paired sidecar (its
    // `logHead` the log's last entry, `k` its projection's length) rebuilds
    // the record with the overlay's refs intact.
    const logEntries = new FakeLog("D1").base([user("hi")]);
    const head = logEntries.at(-1);
    if (head === undefined) throw new Error("no log entries");
    const paired = encodeSidecar({
      ...sidecarOf(recordWith([imageMessage()])),
      k: 1,
      logHead: { seq: head.seq, id: head.id },
    });
    const files: SessionFiles = {
      log: `${headerLine({ id: "s", ...META })}${entryLines(logEntries)}`,
      state: paired,
    };
    expect(decodeFiles("s", files).messages.at(-1)?.attachments).toEqual([ref()]);
    // An older build's refusal is the version check, and it fires before any
    // message parse: the reason names the version, never a stripped tail.
    expect(olderAccepts(paired)).toContain("is not 1");
  });

  test("a v1 file that DOES carry refs is refused (it must be 2), never loaded", () => {
    const text = encodeSidecar({
      ...sidecarOf(recordWith([imageMessage()])),
      schemaVersion: DAEMON_STATE_VERSION_NO_MEDIA,
    });
    const parsed = parseSidecar(text, "s");
    expect(parsed.ok ? "ok" : parsed.reason).toContain("carries image refs");
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
