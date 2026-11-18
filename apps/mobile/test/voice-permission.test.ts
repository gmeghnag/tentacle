/**
 * `voice-permission.ts` — every (mic × speech) combination → the mic's view
 * (docs/feat/mobile-voice.md Design §2, F1/F2).
 */
import { describe, expect, test } from "bun:test";
import type { MicPermission, SpeechPermission } from "../src/speech-native.ts";
import {
  MIC_DENIED_MESSAGE,
  SPEECH_DENIED_MESSAGE,
  VOICE_RESTRICTED_MESSAGE,
  micViewFor,
  unavailableMessage,
} from "../src/voice-permission.ts";

const MICS: MicPermission[] = ["granted", "denied", "undetermined", "restricted"];
const SPEECHES: SpeechPermission[] = ["authorized", "denied", "notDetermined", "restricted"];

/** The expected card for a pair, by the documented precedence. */
function expected(mic: MicPermission, speech: SpeechPermission) {
  if (mic === "restricted" || speech === "restricted") return "restricted";
  if (mic === "denied") return "denied-mic";
  if (speech === "denied") return "denied-speech";
  if (mic === "undetermined" || speech === "notDetermined") return "ask";
  return "start";
}

describe("every (mic × speech) combination", () => {
  for (const mic of MICS) {
    for (const speech of SPEECHES) {
      test(`${mic} × ${speech}`, () => {
        const want = expected(mic, speech);
        const before = micViewFor({ permissions: { mic, speech }, tapped: false });
        const after = micViewFor({ permissions: { mic, speech }, tapped: true });
        if (want === "ask" || want === "start") {
          expect(before).toEqual({
            action: want,
            card: undefined,
            settings: false,
            message: undefined,
          });
          expect(after).toEqual(before);
        } else {
          // Nothing is explained before a tap (camera decision 10).
          expect(before).toEqual({
            action: "explain",
            card: undefined,
            settings: false,
            message: undefined,
          });
          expect(after.action).toBe("none");
          expect(after.card).toBe(want);
          expect(after.settings).toBe(want !== "restricted");
        }
      });
    }
  }
});

describe("cards", () => {
  test("restricted has no Settings button", () => {
    const v = micViewFor({
      permissions: { mic: "restricted", speech: "authorized" },
      tapped: true,
    });
    expect(v).toEqual({
      action: "none",
      card: "restricted",
      settings: false,
      message: VOICE_RESTRICTED_MESSAGE,
    });
  });

  test("denied mic / speech carry Open Settings and their sentence", () => {
    expect(
      micViewFor({ permissions: { mic: "denied", speech: "authorized" }, tapped: true }).message,
    ).toBe(MIC_DENIED_MESSAGE);
    expect(
      micViewFor({ permissions: { mic: "granted", speech: "denied" }, tapped: true }).message,
    ).toBe(SPEECH_DENIED_MESSAGE);
  });

  test("unavailable (F1) → its own sentence, no button, even when granted", () => {
    const v = micViewFor({
      permissions: { mic: "granted", speech: "authorized" },
      tapped: true,
      unavailable: { reason: "no-on-device-model", locale: "it-IT" },
    });
    expect(v.action).toBe("none");
    expect(v.card).toBe("unavailable");
    expect(v.settings).toBe(false);
    expect(v.message).toContain("Turn on Dictation for Italiano");
  });

  test("one sentence per reason", () => {
    const all = (["no-on-device-model", "locale-unsupported", "hardware"] as const).map((r) =>
      unavailableMessage(r, "en-US"),
    );
    expect(new Set(all).size).toBe(3);
    expect(all[0]).toContain("English");
  });
});
