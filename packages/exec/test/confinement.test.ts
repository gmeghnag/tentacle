import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostExecution, WorkspaceWriteError } from "../src/index.ts";

let root: string;
let outside: string;
let env: HostExecution;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "harness-confine-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  env = new HostExecution({ cwd: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("write confinement", () => {
  test("allows writes inside the workspace, including subfolders", async () => {
    await env.writeFile("note.txt", "hi");
    await env.writeFile("sub/deep/file.txt", "deep");
    expect(await env.readFile("note.txt")).toBe("hi");
    expect(await env.readFile("sub/deep/file.txt")).toBe("deep");
  });

  test("rejects a relative path that escapes with ..", async () => {
    await expect(env.writeFile("../escape.txt", "x")).rejects.toThrow(WorkspaceWriteError);
  });

  test("rejects an absolute path outside the workspace", async () => {
    await expect(env.writeFile(join(outside, "x.txt"), "x")).rejects.toThrow(WorkspaceWriteError);
  });

  test("rejects a write through a symlink that points outside", async () => {
    // A symlinked dir inside the workspace pointing out must not be a loophole.
    await symlink(outside, join(root, "link"));
    await expect(env.writeFile("link/pwned.txt", "x")).rejects.toThrow(WorkspaceWriteError);
  });

  test("reads are NOT confined (reads stay free)", async () => {
    await writeFile(join(outside, "secret.txt"), "readable");
    expect(await env.readFile(join(outside, "secret.txt"))).toBe("readable");
  });
});
