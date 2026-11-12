/**
 * The laptop's reader accepts media entries (docs/feat/attachments-core.md, D8, T5).
 *
 * This is the fold an OLD build gets wrong in the dangerous way, and a *new* one
 * gets wrong in a boring way: `session-log-reader.ts` had `base owes N messages,
 * got media_message` hard-coded, so a page with an image would be refused
 * outright. Both appends and replaces must project, with NO drift flagged
 * against a checkpoint the daemon wrote over the same history.
 *
 * Pages come from the daemon's real `SessionLog` — not a hand-written one.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AttachmentRef, ChatMessage } from "@tentacle/core";
import { SessionLog } from "@tentacle/daemon";
import type { LogCursor, LogResult } from "@tentacle/protocol";
import { type LogApplied, applyLogRead } from "../src/session-log-reader.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const m = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 1234,
  name: "cat.png",
  ...over,
});

const image = (content: string): ChatMessage => ({
  role: "user",
  content,
  attachments: [ref()],
});

function pages(log: SessionLog, after?: LogCursor, maxChars = 1 << 20): LogResult[] {
  const out: LogResult[] = [];
  let cursor = after;
  for (;;) {
    const page = log.read(cursor, maxChars, sha256);
    out.push(page);
    const last = page.entries.at(-1);
    if (!page.more || !last) return out;
    cursor = { seq: last.seq, id: last.id };
  }
}

function ok(result: LogApplied | { error: string }): LogApplied {
  if ("error" in result) throw new Error(`refused: ${result.error}`);
  return result;
}

function cold(log: SessionLog): LogApplied {
  return ok(applyLogRead(null, pages(log), sha256));
}

let t = 500;
const newLog = (): SessionLog => new SessionLog("inc-1", () => t++);

describe("T5 — a page with a media entry is applied, not refused", () => {
  test("base(count 1) + media_message + checkpoint: refs project, NO drift", () => {
    const log = newLog();
    log.start([m("system", "S"), image("what is this?")], "create");
    log.checkpoint();
    const applied = cold(log);
    expect(applied.state.messages).toHaveLength(2);
    expect(applied.state.messages[1]?.attachments).toEqual([ref()]);
    // A drift means the checkpoint's digest disagreed with the fold: it must not.
    expect(applied.drift).toBeUndefined();
  });

  test("a media_message arriving as an APPEND after a full seed is accepted", () => {
    const log = newLog();
    log.start([m("system", "S")], "create");
    const before = cold(log).state;
    const more = [m("system", "S"), image("later")];
    log.commit(more, 2);
    const applied = ok(
      applyLogRead(before, pages(log, { seq: before.head.seq, id: before.head.id }), sha256),
    );
    expect(applied.state.messages).toHaveLength(2);
    expect(applied.state.messages[1]?.attachments).toEqual([ref()]);
  });

  test("a media_replace (an edit to an image message) projects by index", () => {
    const log = newLog();
    const messages = [m("system", "S"), image("v1"), m("assistant", "a cat")];
    log.start(messages, "create");
    const before = cold(log).state;
    // The SAME array with one message replaced by another carrying refs.
    messages[1] = { role: "user", content: "v2", attachments: [ref({ id: "b".repeat(64) })] };
    log.commit(messages, 3);
    const applied = ok(
      applyLogRead(before, pages(log, { seq: before.head.seq, id: before.head.id }), sha256),
    );
    expect(applied.state.messages[1]?.content).toBe("v2");
    expect(applied.state.messages[1]?.attachments).toEqual([ref({ id: "b".repeat(64) })]);
  });

  test("an image message's digest is stable across a re-read (no phantom drift)", () => {
    const log = newLog();
    log.start([m("system", "S"), image("x")], "create");
    log.checkpoint();
    const first = cold(log);
    const second = cold(log);
    expect(second.state.digests).toEqual(first.state.digests);
    expect(second.drift).toBeUndefined();
  });

  // Review M2: a pod is not trusted. The reader is the gate between what a pod
  // says and what the laptop WRITES, so a plain `message` carrying refs must be
  // refused here — before it can reach `<uid>.jsonl` and be half-loaded later.
  test("a forge: a PLAIN message entry carrying refs is refused, not projected", () => {
    const log = newLog();
    log.start([m("system", "S")], "create");
    const forged = pages(log);
    const last = forged.at(-1);
    if (last === undefined) throw new Error("no page");
    const entries = last.entries.map((entry) =>
      entry.type === "message"
        ? { ...entry, message: { role: "user", content: "hi", attachments: [ref()] } }
        : entry,
    );
    const applied = applyLogRead(null, [{ ...last, entries }], sha256);
    // An error, not a projection: `applyLogRead`'s failure shape.
    expect("error" in applied ? applied.error : "applied").toContain("malformed message entry");
  });
});
