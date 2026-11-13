import { describe, expect, test } from "bun:test";
import type { AttachmentRef, ChatMessage } from "@tentacle/core";
import { MAX_INLINE_IMAGES, selectInlineIds } from "../../providers/src/images.ts";
import { RESTORE_IMAGES, imagesToRestore } from "../src/restore-images.ts";

// docs/feat/attachments-durable.md T11: the images restored after an open are
// exactly the ones a provider would inline — newest first, deduped, last 5.

const ref = (n: number, name = `i${n}.png`): AttachmentRef => ({
  id: n.toString(16).padStart(64, "0"),
  mimeType: "image/png",
  size: 10 + n,
  name,
});
const user = (refs: AttachmentRef[], content = "u"): ChatMessage => ({
  role: "user",
  content,
  attachments: refs,
});

describe("imagesToRestore", () => {
  test("empty history, or no refs → []", () => {
    expect(imagesToRestore([])).toEqual([]);
    expect(imagesToRestore([{ role: "user", content: "hi" }, { role: "assistant", content: "x" }])).toEqual(
      [],
    );
  });

  test("newest first; within a message, last ref first", () => {
    const h = [user([ref(1), ref(2)]), { role: "assistant", content: "a" } as ChatMessage, user([ref(3)])];
    expect(imagesToRestore(h).map((r) => r.id)).toEqual([ref(3).id, ref(2).id, ref(1).id]);
  });

  test("deduped by id, carrying the NEWEST ref's name", () => {
    const h = [user([ref(1, "old.png")]), user([ref(1, "new.png"), ref(2)])];
    const out = imagesToRestore(h);
    expect(out.map((r) => r.id)).toEqual([ref(2).id, ref(1).id]);
    expect(out[1]?.name).toBe("new.png");
  });

  test("only the last 5 distinct ids (6 images → 5)", () => {
    const h = [1, 2, 3, 4, 5, 6].map((n) => user([ref(n)]));
    expect(imagesToRestore(h).map((r) => r.id)).toEqual([6, 5, 4, 3, 2].map((n) => ref(n).id));
  });

  test("refs on non-user messages are ignored", () => {
    const h: ChatMessage[] = [
      { role: "assistant", content: "a", attachments: [ref(9)] } as ChatMessage,
      user([ref(1)]),
    ];
    expect(imagesToRestore(h).map((r) => r.id)).toEqual([ref(1).id]);
  });

  test("the same ids as the provider's selectInlineIds (and the same K)", () => {
    expect(RESTORE_IMAGES).toBe(MAX_INLINE_IMAGES);
    const h = [
      user([ref(1), ref(2)]),
      user([ref(3), ref(1)]),
      { role: "assistant", content: "a" } as ChatMessage,
      user([ref(4), ref(5), ref(6)]),
      user([ref(7)]),
    ];
    expect(new Set(imagesToRestore(h).map((r) => r.id))).toEqual(selectInlineIds(h));
  });
});
