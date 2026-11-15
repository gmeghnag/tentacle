import { describe, expect, test } from "bun:test";
import { hopMovedNotice, hopShownCwd, noticeText } from "../src/hop-status.ts";
import { renderMarkdown } from "../src/markdown.ts";

// docs/fix/session-hop-live.md D2: the hop's lines are markdown (`_…_`), and
// their text may be an engine's — it must render literally.

describe("noticeText", () => {
  test("is the identity on plain text", () => {
    expect(noticeText("not moved: the engine did not answer")).toBe(
      "not moved: the engine did not answer",
    );
  });

  test("escapes every markdown metacharacter", () => {
    expect(noticeText("a_b*c`d[e]f\\g")).toBe("a\\_b\\*c\\`d\\[e\\]f\\\\g");
  });

  test("an escaped line inside `_…_` renders its text literally", () => {
    const raw = "not moved: Docker API GET /_ping failed: *boom* [x]";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripping
    const shown = renderMarkdown(`_${noticeText(raw)}_`).replace(/\x1b\[[0-9;]*m/g, "");
    expect(shown).toContain(raw);
  });
});

describe("hopShownCwd (D4)", () => {
  const local = { place: { kind: "local" as const }, daemonInPod: false };
  test("the target's own cwd when it reports one, else the laptop's", () => {
    // Mutation: return `laptop` always → the first row fails.
    expect(hopShownCwd({ ...local, daemonInPod: true, cwd: "/" }, "/home/me/proj")).toBe("/");
    expect(hopShownCwd(local, "/home/me/proj")).toBe("/home/me/proj");
    expect(hopShownCwd(null, "/home/me/proj")).toBe("/home/me/proj");
  });
});

describe("hopMovedNotice", () => {
  test("no note: the moved line, and the mode it is in (OD5: it survives)", () => {
    // docs/feat/session-hop-ux OD5/OD6: the notice states the mode (it is NOT
    // turned off any more) and whether the session continues by itself.
    expect(hopMovedNotice("docker:box", false)).toBe(
      "_Moved to docker:box — send a message to continue (auto-accept off)._",
    );
    expect(hopMovedNotice("docker:box", true)).toBe(
      "_Moved to docker:box — send a message to continue (auto-accept on)._",
    );
  });

  test("a note rides the same line, escaped", () => {
    expect(hopMovedNotice("docker:box", true, "the old session did not close")).toBe(
      "_Moved to docker:box — the old session did not close — send a message to continue (auto-accept on)._",
    );
    expect(hopMovedNotice("local", false, "kept: tentacle rm my_box")).toContain("my\\_box");
  });

  test("a wake says `continuing`, and an auto-accepted move says so (OD4/OD6)", () => {
    expect(hopMovedNotice("docker:box", true, undefined, true)).toBe(
      "_Moved to docker:box — continuing (auto-accept on)._",
    );
    expect(hopMovedNotice("docker:box", false, undefined, false, true)).toBe(
      "_Moved to docker:box (auto-accepted) — send a message to continue (auto-accept off)._",
    );
  });
});
