import { describe, expect, test } from "bun:test";
import { folderLabel } from "../src/folder-label.ts";

describe("folderLabel (the session's working folder, small mono)", () => {
  test("a home directory reads as ~", () => {
    expect(folderLabel("/Users/me/tentacle")).toBe("~/tentacle");
    expect(folderLabel("/home/dev/repo/")).toBe("~/repo");
    expect(folderLabel("/root/proj")).toBe("~/proj");
    expect(folderLabel("/Users/me")).toBe("~");
  });

  test("other paths are kept as they are", () => {
    expect(folderLabel("/srv/app")).toBe("/srv/app");
    expect(folderLabel("/")).toBe("/");
    expect(folderLabel("/workspace")).toBe("/workspace");
    // `/Users` alone, `/home` alone: no user, so no home to fold.
    expect(folderLabel("/home")).toBe("/home");
  });

  test("a long path middle-truncates and keeps the last component whole", () => {
    expect(folderLabel("/Users/me/tentacle/.tentacle/worktrees/hop-live/proj")).toBe(
      "~/tentacle/…/hop-live/proj",
    );
    const pod = folderLabel("/workspace/some/deeply/nested/checkout/of/the-project-name");
    expect(pod).toBe("/workspace/some/…/of/the-project-name");
  });

  test("a short multi-level path is not cut", () => {
    expect(folderLabel("/Users/me/a/b/c")).toBe("~/a/b/c");
    expect(folderLabel("/a/b/c/d")).toBe("/a/b/c/d");
  });

  test("empty means no folder", () => {
    expect(folderLabel("")).toBe("");
    expect(folderLabel("   ")).toBe("");
  });
});
