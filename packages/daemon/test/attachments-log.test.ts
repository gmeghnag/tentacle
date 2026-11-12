/**
 * Image refs in the daemon's log and on the pod tunnel
 * (docs/feat/attachments-core.md, D7, T3/T4/T6).
 *
 * The property is the PERSISTED one, not "the schema has a field": a message
 * with refs must be written as a CRITICAL `media_message` (so an older build
 * refuses the session loudly instead of half-loading it, repro *r4*), must
 * round-trip through the pure emitter, the disk log AND the laptop's reader with
 * the refs deep-equal, and must cross `model/stream` as REFS ONLY.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AttachmentRef, ChatMessage, ChatRequest } from "@tentacle/core";
import type { KnownLogEntry } from "@tentacle/protocol";
import { ProxyModelProvider } from "../src/proxy-model.ts";
import { SessionLog, replayFromBase } from "../src/session-log.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 1234,
  name: "cat.png",
  ...over,
});

const m = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });
const withRefs = (content: string, refs: AttachmentRef[] = [ref()]): ChatMessage => ({
  role: "user",
  content,
  attachments: refs,
});

function pureLog() {
  let t = 1000;
  const log = new SessionLog("inc-1", () => t++);
  const entries = (): KnownLogEntry[] => {
    const out: KnownLogEntry[] = [];
    let after: { seq: number; id: string } | undefined;
    for (;;) {
      const page = log.read(after, 1 << 20, sha256);
      out.push(...(page.entries as KnownLogEntry[]));
      const tip = page.entries.at(-1);
      if (!page.more || tip === undefined) {
        break;
      }
      after = { seq: tip.seq, id: tip.id };
    }
    return out;
  };
  return { log, entries };
}

describe("T3 — the emitter picks the media entry type", () => {
  test("a message with refs is a CRITICAL media_message carrying them", () => {
    const { log, entries } = pureLog();
    log.start([m("system", "S")], "create");
    const h = [m("system", "S"), withRefs("what is this?")];
    log.commit(h, 2);
    const appended = entries().filter((e) => e.type === "media_message");
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ critical: true });
    expect((appended[0] as { message: ChatMessage }).message.attachments).toEqual([ref()]);
  });

  test("a text message is still a plain `message`", () => {
    const { log, entries } = pureLog();
    log.start([m("system", "S")], "create");
    log.commit([m("system", "S"), m("user", "hi")], 2);
    const types = entries().map((e) => e.type);
    expect(types).toContain("message");
    expect(types).not.toContain("media_message");
  });

  test("AN EDIT in place becomes media_replace (and back to `replace` when the refs go)", () => {
    const { log, entries } = pureLog();
    const h = [m("system", "S"), withRefs("v1")];
    log.start(h, "create");
    h[1] = withRefs("v2");
    log.commit(h, 2);
    const edited = entries().at(-1);
    expect(edited).toMatchObject({ type: "media_replace", critical: true, index: 1 });
    // The refs removed: a plain replace again (and it must NOT lose the change).
    h[1] = m("user", "v3");
    log.commit(h, 2);
    expect(entries().at(-1)).toMatchObject({ type: "replace", index: 1 });
  });

  test("a segment (start/replaced) uses the media type too, and replays refs back", () => {
    const { log, entries } = pureLog();
    const h = [m("system", "S"), withRefs("first")];
    log.start(h, "create");
    expect(replayFromBase(entries())).toEqual(h);
    // A compaction-style replacement carries a history WITH refs (a seed).
    const reseeded = [m("system", "S"), withRefs("second", [ref({ id: "b".repeat(64) })])];
    log.replaced(reseeded, "compact");
    // The new segment carries the media type as well (a cold read starts at its
    // base, so exactly one media_message is visible).
    expect(entries().filter((e) => e.type === "media_message")).toHaveLength(1);
    expect(replayFromBase(entries())).toEqual(reseeded);
  });
});

describe("T6 — the pod tunnel carries refs, never bytes", () => {
  const capture = async (request: ChatRequest): Promise<Record<string, unknown>> => {
    let seen: unknown = null;
    const proxy = new ProxyModelProvider(async (wire) => {
      seen = wire;
      return { events: [{ type: "done" }] };
    });
    for await (const _ of proxy.stream(request)) {
      // drain
    }
    if (seen === null) {
      throw new Error("the proxy sent nothing");
    }
    return seen as Record<string, unknown>;
  };

  test("the batch request's messages carry `attachments` deep-equal", async () => {
    const wire = await capture({ messages: [withRefs("look")] });
    const messages = wire.messages as Record<string, unknown>[];
    expect(messages[0]?.attachments).toEqual([ref()]);
    // Refs only: no base64, no bytes, no source.
    expect(JSON.stringify(messages[0])).not.toContain("base64");
    expect(wire).not.toHaveProperty("attachments");
  });

  test("a message without refs has no `attachments` key on the wire (unchanged)", async () => {
    const wire = await capture({ messages: [m("user", "hi")] });
    expect((wire.messages as Record<string, unknown>[])[0]).not.toHaveProperty("attachments");
  });

  test("an unnamed ref sends no `name` key (not `name: undefined`)", async () => {
    const wire = await capture({ messages: [withRefs("x", [ref({ name: undefined })])] });
    const attachments = (wire.messages as Record<string, unknown>[])[0]?.attachments;
    expect(attachments).toEqual([{ id: "a".repeat(64), mimeType: "image/png", size: 1234 }]);
    expect(Object.keys((attachments as object[])[0] ?? {})).not.toContain("name");
  });
});
