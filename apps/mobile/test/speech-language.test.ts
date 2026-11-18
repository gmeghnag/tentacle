/**
 * `speech-language.ts` — language detection and voice choice
 * (docs/feat/mobile-voice.md Design §3, Tests).
 */
import { describe, expect, test } from "bun:test";
import { type VoiceInfo, detectLanguage, pickVoice } from "../src/speech-language.ts";

describe("detectLanguage", () => {
  test("Italian text", () => {
    expect(detectLanguage("Ho finito: il file non è più nella cartella del progetto.", "en")).toBe(
      "it",
    );
  });

  test("English text", () => {
    expect(detectLanguage("The tests pass and the file is in the right folder.", "it")).toBe("en");
  });

  test("below the margin → the fallback", () => {
    // one hit each side ("il" / "the"): no margin.
    expect(detectLanguage("il the bun typecheck", "it")).toBe("it");
    expect(detectLanguage("il the bun typecheck", "en")).toBe("en");
    // a single hit is below the margin of 2.
    expect(detectLanguage("the build", "it")).toBe("it");
  });

  test("empty text → the fallback", () => {
    expect(detectLanguage("", "en")).toBe("en");
    expect(detectLanguage("", "it")).toBe("it");
  });
});

const v = (
  id: string,
  language: string,
  quality: VoiceInfo["quality"] = "default",
  novelty = false,
  name = id,
): VoiceInfo => ({ id, language, name, quality, novelty });

describe("pickVoice", () => {
  test("premium beats enhanced beats default", () => {
    const voices = [v("d", "it-IT"), v("p", "it-IT", "premium"), v("e", "it-IT", "enhanced")];
    expect(pickVoice(voices, "it")).toBe("p");
    expect(
      pickVoice(
        voices.filter((x) => x.id !== "p"),
        "it",
      ),
    ).toBe("e");
  });

  test("novelty voices are never chosen", () => {
    expect(pickVoice([v("bells", "en-US", "premium", true), v("ok", "en-US")], "en")).toBe("ok");
    expect(pickVoice([v("bells", "en-US", "premium", true)], "en")).toBeUndefined();
  });

  test("the home region wins at equal quality", () => {
    const voices = [v("gb", "en-GB", "enhanced"), v("us", "en-US", "enhanced")];
    expect(pickVoice(voices, "en")).toBe("us");
    // ...but quality comes first.
    expect(pickVoice([v("gb", "en-GB", "premium"), v("us", "en-US", "enhanced")], "en")).toBe("gb");
  });

  test("deterministic: same inputs in any order → same voice", () => {
    const a = v("a", "it-IT", "default", false, "Alice");
    const b = v("b", "it-IT", "default", false, "Federica");
    expect(pickVoice([a, b], "it")).toBe("a");
    expect(pickVoice([b, a], "it")).toBe("a");
  });

  test("no voice for the language → undefined (system default)", () => {
    expect(pickVoice([v("x", "fr-FR", "premium")], "it")).toBeUndefined();
    expect(pickVoice([], "en")).toBeUndefined();
  });
});
