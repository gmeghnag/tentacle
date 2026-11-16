/**
 * `voice-beta.ts` — the Beta switches (docs/feat/mobile-voice-hidden.md): which
 * surface each one allows, and what turning one OFF must stop. Pure, so the whole
 * policy is understood and tested here (AGENTS §7), never inside a `.tsx`.
 */
import { describe, expect, test } from "bun:test";
import {
  autoReadOn,
  dictationOn,
  readAloudButtonOn,
  voiceRows,
  voiceStops,
} from "../src/voice-beta.ts";
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from "../src/voice-settings-store.ts";

const OFF = DEFAULT_VOICE_SETTINGS;
const with_ = (patch: Partial<VoiceSettings>): VoiceSettings => ({ ...OFF, ...patch });

describe("each switch gates its own surface", () => {
  test("both start OFF — a fresh install has no voice feature at all", () => {
    expect(dictationOn(OFF)).toBe(false);
    expect(readAloudButtonOn(OFF)).toBe(false);
    expect(autoReadOn(OFF)).toBe(false);
  });

  test("Dictation alone does not offer the speaker, Read aloud alone does not show the mic", () => {
    expect(dictationOn(with_({ dictation: true }))).toBe(true);
    expect(readAloudButtonOn(with_({ dictation: true }))).toBe(false);
    expect(readAloudButtonOn(with_({ readAloudButton: true }))).toBe(true);
    expect(dictationOn(with_({ readAloudButton: true }))).toBe(false);
  });
});

describe("auto read-aloud needs BOTH switches", () => {
  test("the Beta switch and the 'Read replies aloud' row must both be on", () => {
    expect(autoReadOn(with_({ readAloud: true, readAloudButton: false }))).toBe(false);
    expect(autoReadOn(with_({ readAloud: false, readAloudButton: true }))).toBe(false);
    expect(autoReadOn(with_({ readAloud: true, readAloudButton: true }))).toBe(true);
  });
});

describe("which Settings rows the switches reveal (Settings → Beta)", () => {
  test("everything off: only the two Beta switches are shown", () => {
    expect(voiceRows(OFF)).toEqual({ language: false, autoRead: false, rate: false });
  });

  test("Language is shared: on when EITHER switch is on", () => {
    expect(voiceRows(with_({ dictation: true })).language).toBe(true);
    expect(voiceRows(with_({ readAloudButton: true })).language).toBe(true);
    expect(voiceRows(with_({ dictation: true })).autoRead).toBe(false);
    expect(voiceRows(with_({ dictation: true })).rate).toBe(false);
  });

  test("the auto-read row and the speaking rate belong to Read aloud only", () => {
    const rows = voiceRows(with_({ readAloudButton: true }));
    expect(rows).toEqual({ language: true, autoRead: true, rate: true });
  });
});

describe("voiceStops: what a switch going OFF must silence", () => {
  test("Dictation off ends a running dictation; nothing else", () => {
    const before = with_({ dictation: true, readAloud: true, readAloudButton: true });
    expect(voiceStops(before, { ...before, dictation: false })).toEqual({
      dictation: true,
      readAloud: false,
    });
  });

  test("the Beta Read-aloud switch off stops speech (it gates the whole surface)", () => {
    const before = with_({ readAloud: true, readAloudButton: true });
    expect(voiceStops(before, { ...before, readAloudButton: false })).toEqual({
      dictation: false,
      readAloud: true,
    });
  });

  test("the 'Read replies aloud' row off stops speech too: both are needed to speak", () => {
    const before = with_({ readAloud: true, readAloudButton: true });
    expect(voiceStops(before, { ...before, readAloud: false })).toEqual({
      dictation: false,
      readAloud: true,
    });
  });

  test("turning a switch ON, or a change that touches neither, stops nothing", () => {
    const off = OFF;
    expect(voiceStops(off, with_({ dictation: true, readAloudButton: true }))).toEqual({
      dictation: false,
      readAloud: false,
    });
    const on = with_({ dictation: true, readAloud: true, readAloudButton: true });
    expect(voiceStops(on, { ...on, rate: "fast", language: "it-IT" })).toEqual({
      dictation: false,
      readAloud: false,
    });
  });
});
