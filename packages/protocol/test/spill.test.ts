import { describe, expect, test } from "bun:test";
import {
  ChatMessageSchema,
  OpenParamsSchema,
  SessionUpdateSchema,
  SnapshotResultSchema,
} from "../src/index.ts";

// docs/feat/tui-spill-note.md: a spilled tool result carries its spill as data,
// on the live update and on the history message (snapshot / open seed).
const spill = {
  chars: 40800,
  path: ".tentacle/tool-output/fs_read-c1.txt",
  head: "h",
  tail: "t",
  omitted: 39600,
};
const update = (s: unknown) => ({
  type: "tool_call_update",
  toolCallId: "c1",
  status: "completed",
  content: [{ type: "text", text: "banner" }],
  spill: s,
});
const message = (s: unknown) => ({ role: "tool", content: "banner", toolCallId: "c1", spill: s });

describe("ToolResultSpill on the wire", () => {
  test("a valid spill is kept on tool_call_update and on a ChatMessage", () => {
    const u = SessionUpdateSchema.safeParse(update(spill));
    expect(u.success && u.data.type === "tool_call_update" ? u.data.spill : undefined).toEqual(
      spill,
    );
    const m = ChatMessageSchema.safeParse(message(spill));
    expect(m.success ? m.data.spill : undefined).toEqual(spill);
    // It rides the history paths: a snapshot page and an open seed.
    const snap = SnapshotResultSchema.safeParse({ messages: [message(spill)] });
    expect(snap.success ? snap.data.messages[0]?.spill : undefined).toEqual(spill);
    const open = OpenParamsSchema.safeParse({ messages: [message(spill)] });
    expect(open.success ? open.data.messages?.[0]?.spill : undefined).toEqual(spill);
  });

  test("no path (the spill file could not be written) is valid", () => {
    const { path: _path, ...noPath } = spill;
    const m = ChatMessageSchema.safeParse(message(noPath));
    expect(m.success ? m.data.spill : undefined).toEqual(noPath);
  });

  test("a malformed spill makes the frame invalid (known fields keep full validation)", () => {
    const bad = [
      { ...spill, chars: -1 },
      { ...spill, chars: 1.5 },
      { ...spill, omitted: -1 },
      { ...spill, path: "" },
      { ...spill, path: "p".repeat(4097) },
      { ...spill, head: 1 },
      { chars: 1, head: "h", omitted: 0 },
      "not an object",
    ];
    for (const s of bad) {
      expect(SessionUpdateSchema.safeParse(update(s)).success).toBe(false);
      expect(ChatMessageSchema.safeParse(message(s)).success).toBe(false);
    }
    expect(ChatMessageSchema.safeParse(message({ ...spill, path: "p".repeat(4096) })).success).toBe(
      true,
    );
  });

  test("forward compat: an unknown field inside spill is stripped, the frame still parses", () => {
    const u = SessionUpdateSchema.safeParse(update({ ...spill, future: true }));
    expect(u.success && u.data.type === "tool_call_update" ? u.data.spill : undefined).toEqual(
      spill,
    );
  });
});
