import { describe, expect, test } from "bun:test";
import {
  ChatMessageSchema,
  OpenParamsSchema,
  PROTOCOL_VERSION,
  SessionUpdateSchema,
  SnapshotResultSchema,
  ToolCallUpdateSchema,
  UPDATE_CLASS,
} from "../src/index.ts";

// docs/fix/tool-duration.md: a measured tool result carries its daemon-side
// duration (display only), on the live update and on the history message.
const update = (d: unknown) => ({
  type: "tool_call_update",
  toolCallId: "c1",
  status: "completed",
  content: [{ type: "text", text: "ok" }],
  durationMs: d,
});
const message = (d: unknown) => ({ role: "tool", content: "ok", toolCallId: "c1", durationMs: d });

describe("tool durationMs on the wire", () => {
  test("is kept on tool_call_update, a ChatMessage, a snapshot page and an open seed", () => {
    // Mutation (red, verified): drop the field from ChatMessageSchema → the snapshot case fails.
    const u = SessionUpdateSchema.safeParse(update(1234));
    expect(u.success && u.data.type === "tool_call_update" ? u.data.durationMs : undefined).toBe(
      1234,
    );
    const m = ChatMessageSchema.safeParse(message(0));
    expect(m.success ? m.data.durationMs : undefined).toBe(0);
    const snap = SnapshotResultSchema.safeParse({ messages: [message(1234)] });
    expect(snap.success ? snap.data.messages[0]?.durationMs : undefined).toBe(1234);
    const open = OpenParamsSchema.safeParse({ messages: [message(1234)] });
    expect(open.success ? open.data.messages?.[0]?.durationMs : undefined).toBe(1234);
  });

  test("is optional: an unmeasured result parses with none", () => {
    const { durationMs: _d, ...plain } = message(1);
    const m = ChatMessageSchema.safeParse(plain);
    expect(m.success && !("durationMs" in m.data)).toBe(true);
  });

  test("a malformed value makes the frame invalid (no silent coercion)", () => {
    for (const d of [-1, 1.5, "2", null, Number.NaN]) {
      expect(SessionUpdateSchema.safeParse(update(d)).success).toBe(false);
      expect(ChatMessageSchema.safeParse(message(d)).success).toBe(false);
    }
  });

  test("additive and display-only: an older peer drops it, so no PROTOCOL_VERSION bump", () => {
    // An older build's schema (the same shape without the field) still parses
    // the new frame and strips the field: forward compat, not a break.
    const older = ToolCallUpdateSchema.omit({ durationMs: true });
    const parsed = older.safeParse(update(1234));
    expect(parsed.success && !("durationMs" in parsed.data)).toBe(true);
    const olderMessage = ChatMessageSchema.omit({ durationMs: true });
    const m = olderMessage.safeParse(message(1234));
    expect(m.success && !("durationMs" in m.data)).toBe(true);
    // No new update kind and the carrier stays `display`.
    expect(UPDATE_CLASS.tool_call_update).toBe("display");
    expect(PROTOCOL_VERSION).toBe(11);
  });
});
