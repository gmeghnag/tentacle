/**
 * The voice feature's native seams, pinned from the SOURCE (docs/feat/mobile-voice.md
 * F1, F3, F6): Swift and `.tsx` cannot run under Bun, so — like
 * `icon-glass-wiring.test.ts` — the load-bearing lines are asserted as text.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const MOD = join(APP, "modules", "tentacle-speech");
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const code = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("F1: the Swift recognizer is on-device only", () => {
  const swift = code(read(MOD, "ios", "RecognizerEngine.swift"));

  test("every request requires on-device recognition", () => {
    expect(swift).toContain("request.requiresOnDeviceRecognition = true");
    expect(swift).not.toMatch(/requiresOnDeviceRecognition\s*=\s*false/);
  });

  test("it refuses to start without on-device support, with the code TS maps", () => {
    expect(swift).toMatch(/guard r\.supportsOnDeviceRecognition else \{[\s\S]*?"not-on-device"/);
  });
});

/**
 * Review round 1, finding 1 (Swift half): a cancel during a pending start never
 * leaves the mic open. Static guards (the module only builds in a dev client);
 * the behaviour itself is device-only.
 */
describe("start/cancel race: the Swift side", () => {
  const core = code(read(MOD, "ios", "SpeechCore.swift"));
  const analyzer = code(read(MOD, "ios", "AnalyzerEngine.swift"));
  const recognizer = code(read(MOD, "ios", "RecognizerEngine.swift"));
  const glue = code(read(MOD, "ios", "TentacleSpeechModule.swift"));

  test("the analyzer re-checks `finished` in the same main hop that opens the mic", () => {
    expect(analyzer).toMatch(
      /MainActor\.run \{\s*guard !self\.finished else \{ throw SpeechCore\.cancelledStart \}\s*try self\.startAudio\(/,
    );
    expect(analyzer).toMatch(
      /MainActor\.run \{\s*guard !self\.finished else \{ throw SpeechCore\.cancelledStart \}\s*self\.analyzer = analyzer/,
    );
  });

  test("the recognizer refuses to begin once finished", () => {
    expect(recognizer).toMatch(
      /private func begin\(\) throws \{\s*guard !finished else \{ throw SpeechCore\.cancelledStart \}/,
    );
  });

  test("the core refuses a cancelled attempt, and cancels an engine whose start lost the race", () => {
    expect(core).toContain("guard attempt > cancelledThrough, attempt > newestStart else");
    expect(core).toMatch(
      /try await next\.start\(\)[\s\S]*?if attempt <= cancelledThrough \|\| engine !== next \{\s*next\.cancel\(\)/,
    );
    expect(core).toMatch(
      /func cancelDictation\(attempt: Int\) \{\s*cancelledThrough = max\(cancelledThrough, attempt\)/,
    );
  });

  test("the glue passes the attempt both ways", () => {
    expect(glue).toContain(
      "self.core.startDictation(engine: engine, locale: locale, attempt: attempt)",
    );
    expect(glue).toContain("self.core.cancelDictation(attempt: attempt)");
    expect(glue).toContain('"attempt": attempt');
  });
});

describe("one native seam", () => {
  test("only `speech-native-expo.ts` names the native module", () => {
    const hits = sources(join(APP, "src")).filter((p) =>
      code(read(p)).includes('"TentacleSpeech"'),
    );
    expect(hits.map((p) => p.slice(APP.length + 1))).toEqual(["src/speech-native-expo.ts"]);
  });

  test("the Swift module, its config and the JS name agree", () => {
    const config = JSON.parse(read(MOD, "expo-module.config.json")) as {
      apple?: { modules?: string[] };
    };
    expect(config.apple?.modules).toEqual(["TentacleSpeechModule"]);
    const glue = read(MOD, "ios", "TentacleSpeechModule.swift");
    expect(glue).toContain("public class TentacleSpeechModule: Module");
    expect(glue).toContain('Name("TentacleSpeech")');
  });
});

describe("F6: no background audio", () => {
  test("app.json declares no UIBackgroundModes", () => {
    expect(read(APP, "app.json")).not.toContain("UIBackgroundModes");
  });
});

describe("the composer routes through dictation (F8)", () => {
  const screen = code(read(APP, "src", "screens", "SessionScreen.tsx"));

  test("a typed change reaches dictation before the compose seam", () => {
    expect(screen).toMatch(/voice\?\.userEdit\(text\);\s*controller\.setDraft\(text\);/);
  });

  test("Return and Send go to dictation first", () => {
    expect(screen).toMatch(
      /voice\?\.send\(via\) !== true\) \{\s*if \(via === "return"\) \{\s*controller\.pressReturn\(\);\s*\} else \{\s*controller\.press\(\);/,
    );
    const pane = code(read(APP, "src", "screens", "session", "ComposerPane.tsx"));
    expect(pane).toMatch(/onReturn=\{\(\) => \{[\s\S]{0,160}actions\.current\.send\("return"\)/);
    expect(pane).toMatch(/onPress=\{\(\) => \{[\s\S]{0,160}actions\.current\.send\("press"\)/);
  });
});

/**
 * docs/feat/mobile-voice-hidden.md: the Beta switches are read LIVE. Settings is a
 * different screen on top of this one, so a screen that only read
 * `VOICE_SETTINGS.current()` at mount would keep showing the mic (or the speaker)
 * after the person switched them off.
 */
describe("the Beta switches reach this screen without a remount", () => {
  const screen = code(read(APP, "src", "screens", "SessionScreen.tsx"));

  test("it SUBSCRIBES to the voice settings (mutation: drop the subscribe → red)", () => {
    expect(screen).toContain("VOICE_SETTINGS.subscribe(setVoiceSettings)");
  });

  test("both surfaces are gated from that live copy, never from a render-time read", () => {
    // The two call sites that decide whether voice shows at all.
    // The composer's view is `ComposerPane`'s, from the shell's live copy.
    const pane = code(read(APP, "src", "screens", "session", "ComposerPane.tsx"));
    expect(pane).toMatch(
      /voiceComposerView\(\s*voiceState,\s*dictationLocale\(voiceSettings\.language/,
    );
    expect(screen).toContain("voiceSettings={voiceSettings}");
    expect(pane).not.toContain("VOICE_SETTINGS.current()");
    expect(screen).toMatch(/speakButtonOf\([\s\S]{0,240}?voiceSettings,\s*\)/);
    // No render-time read survives the switch: that is the bug this task fixes.
    expect(screen).not.toContain("VOICE_SETTINGS.current().language");
  });

  test("a switch going OFF is passed to the controller, so nothing keeps running hidden", () => {
    expect(screen).toContain("voice?.settingsChanged(previous, voiceSettings)");
  });
});

/**
 * fix/mobile-mic-send: the mic tap's haptic is played by TS at the tap, but the
 * STOP tap lands while the session records — and iOS mutes haptics during a
 * recording unless the session allows them. Both mic haptics are light (owner).
 * Static (Swift only builds in a dev client); the feel itself is device-only.
 */
describe("mic haptics: the Swift side", () => {
  const core = code(read(MOD, "ios", "SpeechCore.swift"));

  test("the recording session allows haptics, set before it goes active", () => {
    expect(core).toMatch(
      /setCategory\(\s*\.playAndRecord[\s\S]*?setAllowHapticsAndSystemSoundsDuringRecording\(true\)\s*try session\.setActive\(true\)/,
    );
  });

  test("start and stop are both a LIGHT impact", () => {
    expect(core).toContain(
      'case "start": UIImpactFeedbackGenerator(style: .light).impactOccurred()',
    );
    expect(core).toContain(
      'case "stop": UIImpactFeedbackGenerator(style: .light).impactOccurred()',
    );
  });
});
