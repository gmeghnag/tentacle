/**
 * A PLAIN `message`/`replace` entry may not carry image refs (review M2).
 *
 * Before this, the media rule held only by convention: `LogMessageEntrySchema`
 * used the general `ChatMessageSchema`, which now has an optional
 * `attachments`. A pod is not trusted (AGENTS §7, F4), so a pod that answered
 * `session/log` with `{type:"message", message:{…, attachments:[ref]}}` had that
 * entry VALIDATED and re-serialized to the laptop's `<uid>.jsonl` — and an older
 * laptop build then loads that line and strips the refs: a half-load of data
 * this build "validated". The reviewer's repro A, exactly.
 *
 * The rule: refs belong on `media_message`/`media_replace`; a plain entry that
 * carries them is a MALFORMED entry, refused loudly, never written as-is.
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef } from "../src/index.ts";
import {
  KnownLogEntrySchema,
  LOG_ENTRY_CRITICAL,
  LogMessageEntrySchema,
  LogReplaceEntrySchema,
  appendEntryBody,
  replaceEntryBody,
} from "../src/index.ts";

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 1234,
  name: "cat.png",
  ...over,
});

/** A pod's forged entry: the envelope of a real one, the message carrying refs. */
const forged = (): Record<string, unknown> => ({
  type: "message",
  critical: true,
  seq: 3,
  id: "pod/3",
  ts: 1,
  message: { role: "user", content: "hi", attachments: [ref()] },
});

describe("M2 — a plain `message` entry refuses refs", () => {
  test("the reviewer's repro shape is MALFORMED (it parsed before this fix)", () => {
    const parsed = KnownLogEntrySchema.safeParse(forged());
    expect(parsed.success).toBe(false);
  });

  test("the error names the offending field, so the cause is obvious", () => {
    const parsed = LogMessageEntrySchema.safeParse(forged());
    if (parsed.success) throw new Error("expected a refusal");
    const paths = parsed.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("message.attachments");
  });

  test("`replace` refuses refs the same way", () => {
    const entry = { ...forged(), type: "replace", index: 0 };
    expect(KnownLogEntrySchema.safeParse(entry).success).toBe(false);
    expect(LogReplaceEntrySchema.safeParse(entry).success).toBe(false);
  });

  test("`attachments: undefined` is still absent (a JSON round trip drops it)", () => {
    // The distinction that matters: a message with NO refs is valid; the KEY
    // with a value is what is refused. `JSON.stringify` drops `undefined`, so a
    // re-serialized plain message stays acceptable.
    const plain = { ...forged(), message: { role: "user", content: "hi", attachments: undefined } };
    const roundTripped = JSON.parse(JSON.stringify(plain)) as unknown;
    expect(KnownLogEntrySchema.safeParse(roundTripped).success).toBe(true);
  });

  test("the media types still take refs (the rule is not 'no refs anywhere')", () => {
    for (const type of ["media_message", "media_replace"] as const) {
      const entry = {
        ...forged(),
        type,
        ...(type === "media_replace" ? { index: 0 } : {}),
      };
      expect(LOG_ENTRY_CRITICAL[type]).toBe(true);
      expect(KnownLogEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  test("the emitter's two helpers keep the invariant: no refs on a plain body", () => {
    // The other half of the rule — nothing in this build can WRITE a plain
    // entry with refs, so the two ends agree.
    const withRefs = appendEntryBody({
      role: "user",
      content: "hi",
      attachments: [ref()],
    } as never);
    expect(withRefs.type).toBe("media_message");
    expect(KnownLogEntrySchema.safeParse({ ...forged(), ...withRefs }).success).toBe(true);

    const plainBody = appendEntryBody({ role: "user", content: "hi" } as never);
    expect(plainBody.type).toBe("message");
    expect("attachments" in (plainBody as { message: object }).message).toBe(false);
    const replaced = replaceEntryBody(0, { role: "user", content: "hi" } as never);
    expect(replaced.type).toBe("replace");
    expect("attachments" in (replaced as { message: object }).message).toBe(false);
  });
});
