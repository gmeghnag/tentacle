import { describe, expect, test } from "bun:test";
import {
  ChatMessageSchema,
  OpenParamsSchema,
  PROTOCOL_VERSION,
  SnapshotResultSchema,
} from "../src/index.ts";

// docs/feat/context-awareness.md: a user/tool message may carry the context
// fill the model was told about; it must survive a snapshot and an open seed,
// or the model's next prompt silently loses its lines (a cache miss).
const message = (u: unknown) => ({ role: "user", content: "go", contextUsage: u });

describe("contextUsage on the wire", () => {
  test("is kept on a ChatMessage, a snapshot page and an open seed", () => {
    const usage = { used: 82000, window: 128000 };
    const m = ChatMessageSchema.safeParse(message(usage));
    expect(m.success ? m.data.contextUsage : undefined).toEqual(usage);
    const snap = SnapshotResultSchema.safeParse({ messages: [message(usage)] });
    expect(snap.success ? snap.data.messages[0]?.contextUsage : undefined).toEqual(usage);
    const open = OpenParamsSchema.safeParse({ messages: [message(usage)] });
    expect(open.success ? open.data.messages?.[0]?.contextUsage : undefined).toEqual(usage);
  });

  test("an unknown inner field is stripped (forward compatible)", () => {
    const m = ChatMessageSchema.safeParse(message({ used: 1, window: 2, extra: true }));
    expect(m.success ? m.data.contextUsage : undefined).toEqual({ used: 1, window: 2 });
  });

  test("a malformed value makes the message invalid", () => {
    for (const bad of [
      { used: -1, window: 10 },
      { used: 1.5, window: 10 },
      { used: 1, window: 0 },
      { used: "1", window: 10 },
      { used: 1 },
      null,
    ]) {
      expect({ bad, ok: ChatMessageSchema.safeParse(message(bad)).success }).toEqual({
        bad,
        ok: false,
      });
    }
  });

  test("an additive optional field: no protocol bump", () => {
    expect(PROTOCOL_VERSION).toBe(11);
  });
});
