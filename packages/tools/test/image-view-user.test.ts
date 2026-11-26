/**
 * T4 of docs/feat/image-old-on-demand.md: `image_view` resolves the
 * conversation's OWN user images — the ref an old-image placeholder names.
 *
 * D3: a user image is looked up in `ctx.history`'s user messages only AFTER
 * the tool index says "none"; it has no downscaled variant, so `detail` is
 * ignored with a note; a ref the conversation never carried stays unreachable.
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef, ChatMessage, ToolImageEntry, ToolImageStore } from "@tentacle/core";
import { attachmentLabel, formatBytes } from "@tentacle/core";
import { viewImage } from "../src/image-view.ts";

const user: AttachmentRef = {
  id: "b".repeat(64),
  mimeType: "image/png",
  size: 590 * 1024,
  name: "screenshot.png",
};
const other: AttachmentRef = {
  id: "c".repeat(64),
  mimeType: "image/jpeg",
  size: 2048,
  name: "photo.jpg",
};
/** Shares the first 12 hex with `user` — the ambiguity case. */
const twin: AttachmentRef = {
  id: `bbbbbbbbbbbb${"d".repeat(52)}`,
  mimeType: "image/png",
  size: 1024,
};

const entry: ToolImageEntry = {
  label: "doc.pdf p.3",
  high: {
    ref: { id: `a1b2c3d4e5f6${"1".repeat(52)}`, mimeType: "image/png", size: 4096 },
    width: 1568,
    height: 784,
  },
  low: {
    ref: { id: `a1b2c3d4e5f6${"2".repeat(52)}`, mimeType: "image/png", size: 1024 },
    width: 768,
    height: 384,
  },
};

/** A store whose `read` throws: no byte read is expected. */
function spy(found: ToolImageEntry | null, held = true): ToolImageStore {
  return {
    putTool: async () => ({ refused: "x" }),
    resolve: () => (found === null ? { kind: "none" } : { kind: "found", entry: found }),
    holds: () => held,
    read: async () => {
      throw new Error("no byte read expected");
    },
  };
}

const history = (...messages: ChatMessage[]): readonly ChatMessage[] => messages;

/** The stored history of a session where the user attached `refs` in turn 1. */
function withUserImages(refs: readonly AttachmentRef[]): readonly ChatMessage[] {
  return history(
    { role: "system", content: "sys" },
    { role: "user", content: "look", attachments: [...refs] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "later" },
  );
}

describe("image_view resolves the conversation's own user images", () => {
  test("a user ref in ctx.history resolves: the content line and the ref itself", () => {
    const r = viewImage(
      { ref: user.id.slice(0, 12) },
      { images: spy(null), history: withUserImages([user]) },
      "auto",
    );
    expect(r.isError).toBeUndefined();
    expect(r.image).toEqual(user);
    expect(r.content).toBe(
      `${attachmentLabel(user)} · ${formatBytes(user.size)} · attached by the user · sent as attached`,
    );
  });

  test("`sha256:` and upper case are accepted, as for a tool image", () => {
    const r = viewImage(
      { ref: `sha256:${user.id.slice(0, 12).toUpperCase()}` },
      { images: spy(null), history: withUserImages([user]) },
      "auto",
    );
    expect(r.image).toEqual(user);
  });

  test("not in the index and not in the history → `none`, naming BOTH regenerations", () => {
    const r = viewImage(
      { ref: "deadbeefdead" },
      { images: spy(null), history: withUserImages([user]) },
      "auto",
    );
    expect(r.isError).toBe(true);
    expect(r.image).toBeUndefined();
    expect(r.content).toContain("no image deadbeefdead in this session");
    expect(r.content).toContain("fs_read the file again, or ask the user to attach it again");
  });

  test("a prefix matching a tool entry AND a user ref → the TOOL entry wins (same bytes)", () => {
    // The id is on both sides: the store's own entry is the answer.
    const shared: AttachmentRef = { ...user, id: entry.high.ref.id };
    const r = viewImage(
      { ref: shared.id.slice(0, 12), detail: "high" },
      { images: spy(entry), history: withUserImages([shared]) },
      "auto",
    );
    expect(r.image).toEqual(entry.high.ref);
    expect(r.content).toContain("doc.pdf p.3");
  });

  test("a prefix matching TWO user refs → ambiguous, both labels, more hex asked", () => {
    const r = viewImage(
      { ref: "bbbbbbbbbbbb" },
      { images: spy(null), history: withUserImages([user, twin]) },
      "auto",
    );
    expect(r.isError).toBe(true);
    expect(r.image).toBeUndefined();
    expect(r.content).toContain("names 2 images");
    expect(r.content).toContain(attachmentLabel(user));
    expect(r.content).toContain(attachmentLabel(twin));
    expect(r.content).toContain("pass more hex characters");
    // The full id resolves the ambiguity.
    const exact = viewImage(
      { ref: twin.id },
      { images: spy(null), history: withUserImages([user, twin]) },
      "auto",
    );
    expect(exact.image).toEqual(twin);
  });

  test("a user ref the store no longer holds → `ask the user to attach it again`", () => {
    const r = viewImage(
      { ref: user.id.slice(0, 12) },
      { images: spy(null, false), history: withUserImages([user]) },
      "auto",
    );
    expect(r.isError).toBe(true);
    expect(r.image).toBeUndefined();
    expect(r.content).toContain("is no longer held");
    expect(r.content).toContain("ask the user to attach it again");
  });

  test('an EXPLICIT detail "low" → the no-low-variant note; "high" and the default do not', () => {
    const asked = viewImage(
      { ref: user.id.slice(0, 12), detail: "low" },
      { images: spy(null), history: withUserImages([user]) },
      "auto",
    );
    expect(asked.content).toContain("no low variant for a user image — sent as attached");
    // The default (no `detail`) is not a request for a variant: no note.
    const dflt = viewImage(
      { ref: user.id.slice(0, 12) },
      { images: spy(null), history: withUserImages([user]) },
      "auto",
    );
    expect(dflt.content).not.toContain("no low variant");
    const high = viewImage(
      { ref: user.id.slice(0, 12), detail: "high" },
      { images: spy(null), history: withUserImages([user]) },
      "auto",
    );
    expect(high.content).not.toContain("no low variant");
    expect(high.image).toEqual(user);
    // Forced low: the setting asks for a variant that never existed, said once.
    const forced = viewImage(
      { ref: user.id.slice(0, 12) },
      { images: spy(null), history: withUserImages([user]) },
      "low",
    );
    expect(forced.content).toContain("no low variant for a user image");
    expect(forced.image).toEqual(user);
  });

  test("a ref on a TOOL message and a ref in a store upload never resolve as user images", () => {
    // A tool result's image is the tool path's, not the user's.
    const toolOnly: readonly ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", content: "r", toolCallId: "c", attachments: [other] },
    ];
    const r = viewImage(
      { ref: other.id.slice(0, 12) },
      { images: spy(null), history: toolOnly },
      "auto",
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no image");
  });

  test("no history in the context (a caller outside the loop) → the tool index only", () => {
    const r = viewImage({ ref: user.id.slice(0, 12) }, { images: spy(null) }, "auto");
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no image");
    expect(r.content).toContain("or ask the user to attach it again");
  });
});
