/**
 * `voice-view.ts` — the session screen's voice view-model
 * (docs/feat/mobile-voice.md Design §5).
 */
import { describe, expect, test } from "bun:test";
import { DICTATION_IDLE } from "../src/dictation.ts";
import { READ_ALOUD_IDLE } from "../src/read-aloud.ts";
import type { VoiceState } from "../src/voice-controller.ts";
import { endedTurn, speakButtonOf, voiceComposerView } from "../src/voice-view.ts";

const idle: VoiceState = { dictation: DICTATION_IDLE, readAloud: READ_ALOUD_IDLE, level: 0.7 };
const listening: VoiceState = {
  ...idle,
  dictation: {
    kind: "listening",
    attempt: 1,
    base: "",
    finals: "",
    volatile: "",
    startedAt: 0,
    lastTextAt: 0,
  },
};

describe("composer", () => {
  test("no native module → the mic is hidden", () => {
    expect(voiceComposerView(null, "en-US").mic).toBe("hidden");
  });

  test("idle: mic offered, no placeholder override, level 0", () => {
    expect(voiceComposerView(idle, "en-US")).toEqual({
      mic: "idle",
      level: 0,
      placeholder: undefined,
      card: undefined,
      notice: undefined,
    });
  });

  test("listening: localized placeholder and the live level", () => {
    expect(voiceComposerView(listening, "it-IT")).toMatchObject({
      mic: "listening",
      level: 0.7,
      placeholder: "Sto ascoltando…",
    });
    expect(voiceComposerView(listening, "en-US").placeholder).toBe("Listening…");
  });

  test("an idle notice is shown", () => {
    const s = { ...idle, dictation: { kind: "idle", notice: "stopped" } as const };
    expect(voiceComposerView(s, "en-US").notice).toBe("stopped");
  });
});

describe("speaker button", () => {
  const user = { kind: "user", key: "u", text: "q" };
  const answer = { kind: "assistant", key: "a", text: "answer" };
  const rows = [user, answer];

  test("offered on a finished assistant row only", () => {
    expect(speakButtonOf(idle, answer, rows, false)).toBe("offered");
    expect(speakButtonOf(idle, user, rows, false)).toBeUndefined();
    expect(speakButtonOf(idle, answer, rows, true)).toBeUndefined();
    expect(speakButtonOf(null, answer, rows, false)).toBeUndefined();
  });

  test("the speaking row shows stop", () => {
    const s: VoiceState = {
      ...idle,
      readAloud: { kind: "speaking", nextId: 2, id: 1, rowKey: "a", index: 0, total: 1 },
    };
    expect(speakButtonOf(s, answer, rows, false)).toBe("speaking");
  });
});

describe("endedTurn", () => {
  test("running → idle reports whose turn it was", () => {
    expect(endedTurn({ turnId: "t", own: true }, null)).toEqual({ own: true });
    expect(endedTurn({ turnId: "t", own: false }, null)).toEqual({ own: false });
    expect(endedTurn({ turnId: "t", own: true }, { turnId: "t2" })).toEqual({ own: true });
  });

  test("no end → undefined", () => {
    expect(endedTurn(null, null)).toBeUndefined();
    expect(endedTurn(null, { turnId: "t" })).toBeUndefined();
    expect(endedTurn({ turnId: "t", own: true }, { turnId: "t" })).toBeUndefined();
  });
});
