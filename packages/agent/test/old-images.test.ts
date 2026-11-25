/**
 * T1 of docs/feat/image-old-on-demand.md: the pure projection that ages old
 * user images out of the REQUEST (never out of the stored history).
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef, ChatMessage } from "@tentacle/core";
import { attachmentLabel, formatBytes } from "@tentacle/core";
import { OLD_IMAGE_TURNS, oldImagePlaceholder, projectOldImages } from "../src/old-images.ts";
import { PRUNE_MARKER } from "../src/prune.ts";

const png: AttachmentRef = { id: "a".repeat(64), mimeType: "image/png", size: 10 };
const jpg: AttachmentRef = {
  id: "b".repeat(64),
  mimeType: "image/jpeg",
  size: 4096,
  name: "x.jpg",
};

const user = (content: string, refs?: readonly AttachmentRef[]): ChatMessage => ({
  role: "user",
  content,
  ...(refs === undefined ? {} : { attachments: [...refs] }),
});
const answer = (content = "ok"): ChatMessage => ({ role: "assistant", content });

/** The stored history of a session that attached `refs` in turn 1 and had `n` completed turns after. */
function historyOf(refs: readonly AttachmentRef[], answersAfter: number): ChatMessage[] {
  const out: ChatMessage[] = [user("look at this", refs)];
  for (let i = 0; i < answersAfter; i++) {
    out.push(answer(`a${i}`), user(`t${i}`));
  }
  return out;
}

describe("an image stays always-sent for OLD_IMAGE_TURNS answered turns", () => {
  test("the constant is 2 (owner answer 2)", () => {
    expect(OLD_IMAGE_TURNS).toBe(2);
  });

  test("the current turn: kept (its own answer does not count)", () => {
    const history = historyOf([png], 0);
    expect(projectOldImages(history, history.length)).toBe(history);
  });

  test("one answer after it: still kept", () => {
    const history = historyOf([png], 1);
    const out = projectOldImages(history, history.length);
    expect(out).toBe(history);
    expect(out[0]?.attachments).toEqual([png]);
  });

  test("two answers after it: aged — the placeholder, and NO attachments key", () => {
    const history = historyOf([png], 2);
    const out = projectOldImages(history, history.length);
    expect(out).not.toBe(history);
    const aged = out[0];
    expect(aged?.role).toBe("user");
    // The key is gone, not merely undefined: the provider switches on presence.
    expect(Object.hasOwn(aged ?? {}, "attachments")).toBe(false);
    expect(aged?.content).toBe(`${oldImagePlaceholder(png)}\nlook at this`);
    // Every other message keeps its identity (anchors and prune indices hold).
    for (let i = 1; i < history.length; i++) {
      expect(out[i] === history[i]).toBe(true);
    }
    // The stored history is untouched.
    expect(history[0]?.attachments).toEqual([png]);
    expect(history[0]?.content).toBe("look at this");
  });

  test("a cancelled turn (no answer) does not count, so the image stays one turn longer", () => {
    // turn 1 (image) → answer, turn 2 cancelled (no answer), turn 3 running.
    const history: ChatMessage[] = [user("look", [png]), answer(), user("cancelled, no reply")];
    const out = projectOldImages(history, history.length);
    expect(out).toBe(history);
  });

  test("a turn with TWO answers ages one turn early (documented, pinned)", () => {
    // turn 1: image; its turn produced a late-steer second answer.
    const history: ChatMessage[] = [user("look", [png]), answer("a"), user("steer")]; // turn 2 running
    history.splice(2, 0, answer("a2")); // the first turn answered twice
    const out = projectOldImages(history, history.length);
    expect(Object.hasOwn(out[0] ?? {}, "attachments")).toBe(false);
  });

  test("several refs → one line each, in ref order, then the content (images first)", () => {
    const history = historyOf([png, jpg], 2);
    const aged = projectOldImages(history, history.length)[0];
    expect(aged?.content).toBe(
      `${oldImagePlaceholder(png)}\n${oldImagePlaceholder(jpg)}\nlook at this`,
    );
  });

  test("an empty content gets the lines only (no leading newline)", () => {
    const history: ChatMessage[] = [user("", [png]), answer(), answer(), user("now")];
    const aged = projectOldImages(history, history.length)[0];
    expect(aged?.content).toBe(oldImagePlaceholder(png));
  });

  test("non-image messages keep their identity; an all-kept history returns the SAME array", () => {
    const history: ChatMessage[] = [user("hi"), answer(), user("there")];
    expect(projectOldImages(history, history.length)).toBe(history);
    // A tool message with attachments (an image_view result) is never aged.
    const withTool: ChatMessage[] = [
      user("hi"),
      answer(),
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: "{}" }] },
      { role: "tool", content: "r", toolCallId: "c", attachments: [png] },
      answer(),
      answer(),
    ];
    const out = projectOldImages(withTool, withTool.length);
    expect(out[3] === withTool[3]).toBe(true);
  });

  test("turnFrom beyond the length clamps; a negative one clamps to 0 (nothing old)", () => {
    const history = historyOf([png], 2);
    expect(projectOldImages(history, history.length + 99)).toEqual(
      projectOldImages(history, history.length),
    );
    expect(projectOldImages(history, -1)).toBe(history);
    expect(projectOldImages(history, 0)).toBe(history);
  });

  test("only messages before turnFrom are read: a fresh turn's opener is never aged mid-turn", () => {
    const history = historyOf([png], 2);
    const opener = user("now", [jpg]);
    const live = [...history, opener];
    // Mid-turn, `turnFrom` is where the opener began: the opener itself is kept.
    const out = projectOldImages(live, history.length);
    expect(out.at(-1)).toBe(opener);
  });

  test("the placeholder is a pure function of the ref: byte-identical regardless of age", () => {
    const first = oldImagePlaceholder(png);
    const line = (answersAfter: number): string | undefined =>
      projectOldImages(historyOf([png], answersAfter), 99)[0]?.content.split("\n")[0];
    const again = line(2);
    const later = line(7);
    expect(again).toBe(first);
    expect(later).toBe(first);
    // …and it says what it needs to: the label, the size, and the 12-hex ref.
    expect(first).toStartWith(`${PRUNE_MARKER}: image ${attachmentLabel(png)}`);
    expect(first).toContain(`${formatBytes(png.size)} attached by the user earlier, not resent`);
    expect(first).toContain(`image_view ${png.id.slice(0, 12)}`);
  });
});
