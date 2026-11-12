import { describe, expect, test } from "bun:test";
import {
  attachmentCandidateText,
  decodePathToken,
  parseAttachCommand,
  tokenizePaths,
} from "../src/attach-candidates.ts";

const HOME = "/Users/me";

describe("tokenizePaths", () => {
  test("splits on newlines and spaces", () => {
    expect(tokenizePaths("/a.png /b.png")).toEqual({
      tokens: ["/a.png", "/b.png"],
      wellFormed: true,
    });
    expect(tokenizePaths("/a.png\n/b.png\n")).toEqual({
      tokens: ["/a.png", "/b.png"],
      wellFormed: true,
    });
  });

  test("backslash-escaped spaces stay one token", () => {
    expect(tokenizePaths("/a/Shot\\ 1.png")).toEqual({
      tokens: ["/a/Shot 1.png"],
      wellFormed: true,
    });
  });

  test("single and double quotes group, and are removed", () => {
    expect(tokenizePaths("'/a/My Shot.png'")).toEqual({
      tokens: ["/a/My Shot.png"],
      wellFormed: true,
    });
    expect(tokenizePaths('"/a/My Shot.png"')).toEqual({
      tokens: ["/a/My Shot.png"],
      wellFormed: true,
    });
  });

  test("a single quote is literal inside double quotes, and vice versa", () => {
    expect(tokenizePaths('"/a/it\'s.png"')).toEqual({ tokens: ["/a/it's.png"], wellFormed: true });
    expect(tokenizePaths("'/a/say \"hi\".png'")).toEqual({
      tokens: ['/a/say "hi".png'],
      wellFormed: true,
    });
  });

  test("unterminated quote or a trailing backslash is not well formed", () => {
    expect(tokenizePaths("'/a/b.png")).toEqual({ tokens: [], wellFormed: false });
    expect(tokenizePaths("/a/b.png\\").wellFormed).toBe(false);
  });

  test('inside double quotes a Windows separator survives (only " and \\ escape)', () => {
    expect(tokenizePaths('"C:\\Users\\me\\x.png"')).toEqual({
      tokens: ["C:\\Users\\me\\x.png"],
      wellFormed: true,
    });
    expect(tokenizePaths('"a \\"b\\".png"')).toEqual({ tokens: ['a "b".png'], wellFormed: true });
  });

  test("after a closing quote, trailing characters keep one token", () => {
    expect(tokenizePaths("'/a/x'.png")).toEqual({ tokens: ["/a/x.png"], wellFormed: true });
  });
});

describe("decodePathToken", () => {
  test("an absolute path is itself", () => {
    expect(decodePathToken("/a/b.png")).toBe("/a/b.png");
  });

  test("~ expands against the injected home", () => {
    expect(decodePathToken("~/Pictures/x.png", HOME)).toBe("/Users/me/Pictures/x.png");
    expect(decodePathToken("~", HOME)).toBe(HOME);
  });

  test("with no home, ~ is left as written (never silently wrong)", () => {
    expect(decodePathToken("~/Pictures/x.png")).toBe("~/Pictures/x.png");
  });

  test("a file:// URL is percent-decoded", () => {
    expect(decodePathToken("file:///a/My%20Shot.png")).toBe("/a/My Shot.png");
    expect(decodePathToken("file://localhost/a/x%20y.png")).toBe("/a/x y.png");
  });

  test("a file:// URL on ANOTHER host is not a local path", () => {
    expect(decodePathToken("file://otherhost/a/x.png")).toBeNull();
  });

  test("percent-decoding happens once: a literal %2520 becomes %20", () => {
    expect(decodePathToken("file:///a/100%2520done.png")).toBe("/a/100%20done.png");
  });

  test("a literal % that is not an escape survives", () => {
    expect(decodePathToken("file:///a/100% done.png")).toBe("/a/100% done.png");
  });

  test("unicode survives both forms", () => {
    expect(decodePathToken("/a/Bildschirmfoto 2026-11-12 Ünïcode.png")).toBe(
      "/a/Bildschirmfoto 2026-11-12 Ünïcode.png",
    );
    expect(decodePathToken("file:///a/%C3%9Cber.png")).toBe("/a/Über.png");
  });

  test("explicit relative paths and Windows drives are paths", () => {
    expect(decodePathToken("./rel/x.png")).toBe("./rel/x.png");
    expect(decodePathToken("../rel/x.png")).toBe("../rel/x.png");
    expect(decodePathToken("C:\\Users\\me\\x.png")).toBe("C:\\Users\\me\\x.png");
  });

  test("an ordinary word or a bare file name is NOT a path candidate", () => {
    expect(decodePathToken("hello")).toBeNull();
    expect(decodePathToken("Shot.png")).toBeNull();
    expect(decodePathToken("")).toBeNull();
    expect(decodePathToken("https://example.com/x.png")).toBeNull();
  });
});

describe("attachmentCandidateText — the owner's rule, Q3 (a)", () => {
  test("a paste of only paths is those paths", () => {
    expect(attachmentCandidateText("/a/one.png\n/a/two.png")).toEqual({
      kind: "paths",
      paths: ["/a/one.png", "/a/two.png"],
    });
  });

  test("several paths on one line, space-separated", () => {
    expect(attachmentCandidateText("/a/one.png /a/two.png")).toEqual({
      kind: "paths",
      paths: ["/a/one.png", "/a/two.png"],
    });
  });

  test("every terminal's drag form is one candidate", () => {
    expect(attachmentCandidateText("/a/My\\ Shot.png")).toEqual({
      kind: "paths",
      paths: ["/a/My Shot.png"],
    });
    expect(attachmentCandidateText("'/a/My Shot.png'")).toEqual({
      kind: "paths",
      paths: ["/a/My Shot.png"],
    });
    expect(attachmentCandidateText('"/a/My Shot.png"')).toEqual({
      kind: "paths",
      paths: ["/a/My Shot.png"],
    });
    expect(attachmentCandidateText("file:///a/My%20Shot.png")).toEqual({
      kind: "paths",
      paths: ["/a/My Shot.png"],
    });
    expect(attachmentCandidateText("~/Pictures/Shot.png", { home: HOME })).toEqual({
      kind: "paths",
      paths: ["/Users/me/Pictures/Shot.png"],
    });
  });

  test("a path inside a sentence stays TEXT", () => {
    expect(attachmentCandidateText("look at /a/one.png please")).toEqual({ kind: "text" });
    expect(attachmentCandidateText("why does /a/one.png look wrong?")).toEqual({ kind: "text" });
  });

  test("empty or whitespace-only input stays text", () => {
    expect(attachmentCandidateText("")).toEqual({ kind: "text" });
    expect(attachmentCandidateText("   \n\t\n")).toEqual({ kind: "text" });
  });

  test("prose with no path at all stays text", () => {
    expect(attachmentCandidateText("hello there")).toEqual({ kind: "text" });
  });

  test("an unterminated quote stays text (a hand-typed half-quote is prose)", () => {
    expect(attachmentCandidateText("'/a/one.png")).toEqual({ kind: "text" });
  });
});

describe("parseAttachCommand", () => {
  test("decodes quoted and escaped arguments", () => {
    expect(parseAttachCommand("/attach '/a/My Shot.png'")).toEqual({
      kind: "attach",
      paths: ["/a/My Shot.png"],
    });
    expect(parseAttachCommand("/attach /a/My\\ Shot.png")).toEqual({
      kind: "attach",
      paths: ["/a/My Shot.png"],
    });
  });

  test("a BARE relative name works here (the user said it is a file)", () => {
    expect(parseAttachCommand("/attach Shot.png")).toEqual({
      kind: "attach",
      paths: ["Shot.png"],
    });
  });

  test("a file:// URL and ~ decode the same way", () => {
    expect(parseAttachCommand("/attach file:///a/My%20Shot.png")).toEqual({
      kind: "attach",
      paths: ["/a/My Shot.png"],
    });
    expect(parseAttachCommand("/attach ~/x.png", { home: HOME })).toEqual({
      kind: "attach",
      paths: ["/Users/me/x.png"],
    });
  });

  test("several arguments become several paths", () => {
    expect(parseAttachCommand("/attach /a.png /b.png")).toEqual({
      kind: "attach",
      paths: ["/a.png", "/b.png"],
    });
  });

  test("no argument is not a command (the caller shows usage)", () => {
    expect(parseAttachCommand("/attach")).toBeNull();
    expect(parseAttachCommand("/attach   ")).toBeNull();
  });

  test("another word that merely starts with /attach is not the command", () => {
    expect(parseAttachCommand("/attachments x.png")).toBeNull();
    expect(parseAttachCommand("please /attach x.png")).toBeNull();
  });
});
