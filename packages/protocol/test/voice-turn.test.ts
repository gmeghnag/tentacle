/**
 * C3 (docs/feat/voice-conversation.md §4, T7·wire): a voice turn's two optional
 * fields are ON the schemas, and an ordinary turn still parses without them.
 *
 * These are STRIP schemas (AGENTS §7: an unknown field is dropped on inbound
 * parse), so a field the schema does not name never reaches the daemon — the
 * profile would be silently ignored on the pod path exactly as the stop reason
 * once was (docs/fix/truncated-reply-silent.md).
 *
 * No `PROTOCOL_VERSION` bump and no `protocol.d/` note: both fields are
 * optional additions to strip payloads (AGENTS §7 forward compat).
 */
import { describe, expect, test } from "bun:test";
import { EnqueueParamsSchema, PromptParamsSchema, WireChatRequestSchema } from "../src/index.ts";

const prompt = (voice?: unknown): Record<string, unknown> => ({
  sessionId: "s1",
  turnId: "t1",
  content: [{ type: "text", text: "go" }],
  ...(voice === undefined ? {} : { voice }),
});

const enqueue = (voice?: unknown): Record<string, unknown> => ({
  sessionId: "s1",
  id: "e1",
  turnId: "t1",
  text: "and then",
  ...(voice === undefined ? {} : { voice }),
});

describe("a voice turn is on the wire (prompt + enqueue)", () => {
  test("both carry `voice.reasoning`, and both values survive the parse", () => {
    for (const reasoning of ["off", "keep"] as const) {
      expect(PromptParamsSchema.parse(prompt({ reasoning })).voice).toEqual({ reasoning });
      expect(EnqueueParamsSchema.parse(enqueue({ reasoning })).voice).toEqual({ reasoning });
    }
  });

  test("it stays OPTIONAL: an ordinary turn parses, and no voice is invented", () => {
    expect(PromptParamsSchema.parse(prompt()).voice).toBeUndefined();
    expect(EnqueueParamsSchema.parse(enqueue()).voice).toBeUndefined();
  });

  test("an unknown reasoning value is refused, never coerced to a default", () => {
    // The daemon turns it into a model-call switch: a typo must not silently
    // become "reason as configured" on a turn the person asked to be spoken.
    expect(PromptParamsSchema.safeParse(prompt({ reasoning: "sometimes" })).success).toBe(false);
    expect(EnqueueParamsSchema.safeParse(enqueue({ reasoning: "" })).success).toBe(false);
  });

  test("the tunnelled request carries `reasoning` (pods: the model call is the laptop's)", () => {
    const base = { messages: [{ role: "user", content: "hi" }] };
    expect(WireChatRequestSchema.parse({ ...base, reasoning: "off" }).reasoning).toBe("off");
    // Absent stays absent: an older daemon's request is not a voice turn.
    expect(WireChatRequestSchema.parse(base).reasoning).toBeUndefined();
    // Any other value is refused (a strip schema would otherwise drop it and
    // lose the switch without a word).
    expect(WireChatRequestSchema.safeParse({ ...base, reasoning: "minimal" }).success).toBe(false);
  });
});
