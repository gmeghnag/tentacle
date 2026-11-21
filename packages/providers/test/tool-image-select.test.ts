/**
 * The tool-image selection (docs/feat/pdf-images.md D7): pure, newest-first,
 * distinct, a budget separate from the user's K — and one read per id.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AttachmentRef, ChatMessage } from "@tentacle/core";
import {
  MAX_TOOL_IMAGES,
  NO_IMAGES,
  resolveImages,
  selectInlineIds,
  selectToolImageIds,
  userParts,
} from "../src/index.ts";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
function refFor(text: string): AttachmentRef {
  const bytes = bytesOf(text);
  return {
    id: createHash("sha256").update(bytes).digest("hex"),
    mimeType: "image/png",
    size: bytes.length,
  };
}
const tool = (id: string, refs: AttachmentRef[]): ChatMessage => ({
  role: "tool",
  content: id,
  toolCallId: id,
  attachments: refs,
});

describe("selectToolImageIds", () => {
  test("newest-first, distinct, each id owned by the NEWEST tool message carrying it", () => {
    const [a, b, c] = [refFor("a"), refFor("b"), refFor("c")];
    const older = tool("c1", [a, b]);
    const newer = tool("c2", [b, c]);
    const chosen = selectToolImageIds([older, newer], 2);
    expect([...chosen.keys()]).toEqual([c.id, b.id]);
    expect(chosen.get(b.id)).toBe(newer);
    expect(selectToolImageIds([older, newer]).get(a.id)).toBe(older);
    expect(selectToolImageIds([older, newer], 0).size).toBe(0);
    expect(MAX_TOOL_IMAGES).toBe(20);
  });

  test("ignores user refs, and the user selection ignores tool refs", () => {
    const u = refFor("u");
    const t = refFor("t");
    const messages: ChatMessage[] = [
      { role: "user", content: "x", attachments: [u] },
      tool("c1", [t]),
    ];
    expect([...selectToolImageIds(messages).keys()]).toEqual([t.id]);
    expect([...selectInlineIds(messages)]).toEqual([u.id]);
  });
});

describe("resolveImages with a tool budget", () => {
  test("reads the union, each id ONCE; toolKeep 0 (the default) reads no tool ref", async () => {
    const u = refFor("u");
    const t = refFor("t");
    const messages: ChatMessage[] = [
      { role: "user", content: "x", attachments: [u, t] },
      tool("c1", [t]),
    ];
    const reads: string[] = [];
    const source = {
      async read(ref: AttachmentRef) {
        reads.push(ref.id);
        return ref.id === u.id ? bytesOf("u") : bytesOf("t");
      },
    };
    const both = await resolveImages({ messages, attachments: source }, 5, 1e7, 20);
    expect([...both.keys()].sort()).toEqual([u.id, t.id].sort());
    expect(reads.sort()).toEqual([u.id, t.id].sort());
    reads.length = 0;
    const userOnly = await resolveImages({ messages: [tool("c1", [t])], attachments: source });
    expect(userOnly.size).toBe(0);
    expect(reads).toEqual([]);
  });

  test("a user ref outside the user's K is NOT inlined just because the tool selection read it", () => {
    const t = refFor("t");
    const message: ChatMessage = { role: "user", content: "", attachments: [t] };
    const parts = userParts(message, {
      ...NO_IMAGES,
      images: new Map([[t.id, "AAAA"]]),
      inlined: new Set(),
    });
    expect(parts.some((p) => p.kind === "image")).toBe(false);
    expect(parts[0]?.kind).toBe("text");
  });
});
