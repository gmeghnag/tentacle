import { describe, expect, test } from "bun:test";
import { IDENTITY_REDACTOR, createRedactor, linkState, maskEntry } from "../src/index.ts";

// docs/feat/browser-inspect.md B5b: the link's one word, and the clear mode's redactor.

describe("linkState", () => {
  test.each([
    [{ hubAnswers: true, manifestOk: false, chromeRunning: false }, "connected"],
    [{ hubAnswers: false, manifestOk: false, chromeRunning: true }, "not_installed"],
    [{ hubAnswers: false, manifestOk: true, chromeRunning: true }, "extension_missing"],
    [{ hubAnswers: false, manifestOk: true, chromeRunning: false }, "not_running"],
    [{ hubAnswers: false, manifestOk: true, chromeRunning: undefined }, "not_running"],
  ] as const)("%o → %s", (facts, want) => {
    expect(linkState(facts)).toBe(want);
  });
});

describe("IDENTITY_REDACTOR", () => {
  const entry = {
    request: {
      url: "https://a.test/cb?code=SECRET1",
      headers: { Authorization: "Bearer SECRET2", Cookie: "sid=SECRET3" },
    },
    token: "SECRET4",
  };

  test("passes every value through, where the session's redactor masks it", () => {
    const masked = JSON.stringify(maskEntry(entry, createRedactor()));
    const clear = JSON.stringify(maskEntry(entry, IDENTITY_REDACTOR));
    for (const s of ["SECRET1", "SECRET2", "SECRET3", "SECRET4"]) {
      expect(masked).not.toContain(s);
      expect(clear).toContain(s);
    }
  });
});
