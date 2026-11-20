/**
 * `voice-view.ts` — the session screen's voice view-model
 * (docs/feat/mobile-voice.md Design §5).
 */
import { describe, expect, test } from "bun:test";
import { DICTATION_IDLE } from "../src/dictation.ts";
import { READ_ALOUD_IDLE } from "../src/read-aloud.ts";
import type { VoiceState } from "../src/voice-controller.ts";
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from "../src/voice-settings-store.ts";
import { endedTurn, speakButtonOf, voiceComposerView } from "../src/voice-view.ts";

/** The Beta switches ON: every surface as it looked before they existed. */
const BETA: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, dictation: true, readAloudButton: true };

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
    expect(voiceComposerView(null, "en-US", BETA, 0).mic).toBe("hidden");
  });

  test("idle: mic offered, no placeholder override, level 0", () => {
    expect(voiceComposerView(idle, "en-US", BETA, 0)).toEqual({
      mic: "idle",
      level: 0,
      placeholder: undefined,
      card: undefined,
      notice: undefined,
      caption: undefined,
    });
  });

  test("listening: localized placeholder and the live level", () => {
    expect(voiceComposerView(listening, "it-IT", BETA, 0)).toMatchObject({
      mic: "listening",
      level: 0.7,
      placeholder: "Sto ascoltando…",
    });
    expect(voiceComposerView(listening, "en-US", BETA, 0).placeholder).toBe("Listening…");
  });

  test("recording: the caption is the elapsed time m:ss, tabular, from the start", () => {
    // docs/feat/mobile-composer-buttons.md: recording = ■ + halo + TIMER (never hue alone).
    const at = (ms: number) => voiceComposerView(listening, "en-US", BETA, ms).caption;
    expect(at(0)).toBe("0:00");
    expect(at(7_400)).toBe("0:07");
    expect(at(65_000)).toBe("1:05");
    expect(at(600_000)).toBe("10:00");
    // A clock that reads before the start (skew) never shows a negative time.
    expect(at(-5_000)).toBe("0:00");
  });

  test("transcribing: mic 'finalizing', caption '…', the placeholder stays, level 0", () => {
    const finalizing: VoiceState = {
      ...idle,
      dictation: {
        kind: "finalizing",
        attempt: 1,
        base: "",
        finals: "",
        volatile: "",
        after: "idle",
        since: 0,
      },
    };
    expect(voiceComposerView(finalizing, "en-US", BETA, 9_000)).toEqual({
      mic: "finalizing",
      level: 0,
      placeholder: "Listening…",
      card: undefined,
      notice: undefined,
      caption: "…",
    });
  });

  test("idle and preparing carry no caption", () => {
    expect(voiceComposerView(idle, "en-US", BETA, 9_000).caption).toBeUndefined();
  });

  test("an idle notice is shown", () => {
    const s = { ...idle, dictation: { kind: "idle", notice: "stopped" } as const };
    expect(voiceComposerView(s, "en-US", BETA, 0).notice).toBe("stopped");
  });
});

/**
 * docs/feat/mobile-voice-hidden.md: the voice features are OFF unless the person
 * turns them on in Settings → Beta. With them off NOTHING voice-related shows.
 */
describe("Beta off: no surface at all", () => {
  const off = DEFAULT_VOICE_SETTINGS; // both switches off

  test("the mic is hidden even with a live dictation state", () => {
    // Not just the idle mic: a state that WOULD show listening/level/card/notice.
    expect(voiceComposerView(listening, "en-US", off, 0)).toEqual({
      mic: "hidden",
      level: 0,
      placeholder: undefined,
      card: undefined,
      notice: undefined,
      caption: undefined,
    });
    const failed = {
      ...idle,
      dictation: {
        kind: "failed",
        view: { action: "none", card: "denied-mic", settings: true, message: "no mic" },
      } as const,
    };
    expect(voiceComposerView(failed, "en-US", off, 0).card).toBeUndefined();
    expect(voiceComposerView(failed, "en-US", off, 0).mic).toBe("hidden");
  });

  test("the speaker button is never offered, and a speaking row shows nothing", () => {
    const answer = { kind: "assistant", key: "a", text: "answer" };
    const speaking: VoiceState = {
      ...idle,
      readAloud: { kind: "speaking", nextId: 2, id: 1, rowKey: "a", index: 0, total: 1 },
    };
    expect(speakButtonOf(idle, answer, [answer], false, off)).toBeUndefined();
    // The stop button would render too: it is a speaker surface as much as the offer.
    expect(speakButtonOf(speaking, answer, [answer], false, off)).toBeUndefined();
  });

  test("the switches are independent: each one alone gates only its own surface", () => {
    const answer = { kind: "assistant", key: "a", text: "answer" };
    const dictationOnly: VoiceSettings = { ...off, dictation: true };
    const readAloudOnly: VoiceSettings = { ...off, readAloudButton: true };
    expect(voiceComposerView(idle, "en-US", dictationOnly, 0).mic).toBe("idle");
    expect(speakButtonOf(idle, answer, [answer], false, dictationOnly)).toBeUndefined();
    expect(voiceComposerView(idle, "en-US", readAloudOnly, 0).mic).toBe("hidden");
    expect(speakButtonOf(idle, answer, [answer], false, readAloudOnly)).toBe("offered");
  });
});

describe("speaker button", () => {
  const user = { kind: "user", key: "u", text: "q" };
  const answer = { kind: "assistant", key: "a", text: "answer" };
  const rows = [user, answer];

  test("offered on a finished assistant row only", () => {
    expect(speakButtonOf(idle, answer, rows, false, BETA)).toBe("offered");
    expect(speakButtonOf(idle, user, rows, false, BETA)).toBeUndefined();
    expect(speakButtonOf(idle, answer, rows, true, BETA)).toBeUndefined();
    expect(speakButtonOf(null, answer, rows, false, BETA)).toBeUndefined();
  });

  test("the speaking row shows stop", () => {
    const s: VoiceState = {
      ...idle,
      readAloud: { kind: "speaking", nextId: 2, id: 1, rowKey: "a", index: 0, total: 1 },
    };
    expect(speakButtonOf(s, answer, rows, false, BETA)).toBe("speaking");
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
