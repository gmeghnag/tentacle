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
    expect(screen).toMatch(/voice\?\.send\("return"\) !== true\) \{\s*controller\.pressReturn\(\)/);
    expect(screen).toMatch(/voice\?\.send\("press"\) !== true\) \{\s*controller\.press\(\)/);
  });
});
