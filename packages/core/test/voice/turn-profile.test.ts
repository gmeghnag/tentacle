/**
 * C3, the pure half of T6 (docs/feat/voice-conversation.md §4): what a voice
 * turn asks of one request, with no agent loop, no provider and no clock.
 *
 * Two rules, both deterministic:
 *  - the `reasoning` window: `"off"` only while the turn has NOT called a tool
 *    yet, whatever the edge's setting was (`"keep"` never emits the field);
 *  - the spoken-style line goes on the REQUEST's copy of the messages, right
 *    after a leading system prompt, and is never duplicated.
 *
 * Mutations that must turn these red: `voiceReasoning` returns `"off"` even when
 * `toolCalled` (the mutation §4 (a) forbids) → the window test red;
 * `withSpokenLine` appends at the TAIL instead of after the system head → the
 * placement test red; append twice → the idempotence test red.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../src/model.ts";
import { VOICE_SPOKEN_LINE, voiceReasoning, withSpokenLine } from "../../src/voice/turn-profile.ts";

const user = (content: string): ChatMessage => ({ role: "user", content });

describe("voiceReasoning: the 'answer fast' window (§4 (a))", () => {
  test("`off` reasons off until the turn's first tool call, then as configured", () => {
    expect(voiceReasoning({ reasoning: "off", toolCalled: false })).toBe("off");
    // The first tool call closed the window: no field, so the provider reasons
    // as configured (there is no "keep" value on the wire by design).
    expect(voiceReasoning({ reasoning: "off", toolCalled: true })).toBeUndefined();
  });

  test("`keep` never emits the field, before or after a tool call", () => {
    // Mutation: ignore `keep` → red (the person's switch would be overridden).
    expect(voiceReasoning({ reasoning: "keep", toolCalled: false })).toBeUndefined();
    expect(voiceReasoning({ reasoning: "keep", toolCalled: true })).toBeUndefined();
  });
});

describe("withSpokenLine: the transient line (§4 (b), F10)", () => {
  test("it goes right AFTER a leading system prompt, and first when there is none", () => {
    const withSystem: ChatMessage[] = [{ role: "system", content: "you are t." }, user("ciao")];
    expect(withSpokenLine(withSystem)).toEqual([
      { role: "system", content: "you are t." },
      { role: "system", content: VOICE_SPOKEN_LINE },
      user("ciao"),
    ]);
    expect(withSpokenLine([user("ciao")])).toEqual([
      { role: "system", content: VOICE_SPOKEN_LINE },
      user("ciao"),
    ]);
  });

  test("it is added ONCE, however many rounds ask (a stable prompt prefix)", () => {
    const once = withSpokenLine([user("ciao")]);
    expect(withSpokenLine(once)).toEqual(once);
    expect(once.filter((m) => m.content === VOICE_SPOKEN_LINE)).toHaveLength(1);
  });

  test("the history it is given is never mutated (F10's precondition)", () => {
    const history: ChatMessage[] = [user("ciao")];
    const snapshot = [...history];
    withSpokenLine(history);
    expect(history).toEqual(snapshot);
    expect(history.some((m) => m.content === VOICE_SPOKEN_LINE)).toBe(false);
  });
});
