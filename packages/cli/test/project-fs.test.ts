/**
 * The node `ProjectFs` (docs/feat/workflows-ui.md D7 v5): `lstat`/`list` over a
 * real temp dir, so `@tentacle/core`'s pure path logic has a real reader.
 * ENOENT/ENOTDIR mean "nothing there"; a symlink is reported as `link`, never
 * followed — the whole point of the check it feeds.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeProjectFs } from "../src/project-fs.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "project-fs-"));
  mkdirSync(join(dir, "folder"));
  writeFileSync(join(dir, "file.txt"), "x");
  symlinkSync(join(dir, "file.txt"), join(dir, "link"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("nodeProjectFs", () => {
  test("reports dir, file and link", () => {
    const fs = nodeProjectFs();
    expect(fs.lstat(join(dir, "folder"))).toBe("dir");
    expect(fs.lstat(join(dir, "file.txt"))).toBe("file");
    expect(fs.lstat(join(dir, "link"))).toBe("link");
  });

  test("ENOENT and ENOTDIR are `undefined`, not a throw", () => {
    const fs = nodeProjectFs();
    expect(fs.lstat(join(dir, "nope"))).toBeUndefined();
    // A component that is a file: ENOTDIR, the same "nothing there".
    expect(fs.lstat(join(dir, "file.txt", "deeper"))).toBeUndefined();
  });
});
