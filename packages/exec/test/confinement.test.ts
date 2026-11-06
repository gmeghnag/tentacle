import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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

  test("rejects a write through a DANGLING symlink that points outside (nothing is created)", async () => {
    // `existsSync` follows links: a dangling one looked absent, so its parent was
    // judged instead and Bun.write then followed the link out.
    await symlink(join(outside, "planted.txt"), join(root, "dangling"));
    await expect(env.writeFile("dangling", "x")).rejects.toThrow(WorkspaceWriteError);
    expect(existsSync(join(outside, "planted.txt"))).toBe(false);
  });
});

describe("writable dirs (docs/feat/write-tmpdir.md)", () => {
  let extra: string;
  let base: string;

  beforeEach(async () => {
    base = join(root, "..");
    extra = join(base, "scratch");
    await mkdir(extra, { recursive: true });
  });

  test("writes into a writable dir and its subfolders", async () => {
    const e = new HostExecution({ cwd: root, writableDirs: [extra] });
    await e.writeFile(join(extra, "a.json"), "{}");
    await e.writeFile(join(extra, "sub", "deep", "b.txt"), "b");
    expect(readFileSync(join(extra, "a.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(extra, "sub", "deep", "b.txt"), "utf8")).toBe("b");
    // The project stays writable, and the default (no list) stays project-only.
    await e.writeFile("in-project.txt", "p");
    await expect(env.writeFile(join(extra, "c.txt"), "x")).rejects.toThrow(WorkspaceWriteError);
  });

  test("a prefix sibling of a writable dir is refused", async () => {
    await mkdir(`${extra}-evil`, { recursive: true });
    const e = new HostExecution({ cwd: root, writableDirs: [extra] });
    await expect(e.writeFile(`${extra}-evil/x.txt`, "x")).rejects.toThrow(WorkspaceWriteError);
    expect(existsSync(`${extra}-evil/x.txt`)).toBe(false);
  });

  test("a symlink inside a writable dir pointing outside every root is refused", async () => {
    await symlink(outside, join(extra, "out"));
    await symlink(join(outside, "planted.txt"), join(extra, "dangling"));
    const e = new HostExecution({ cwd: root, writableDirs: [extra] });
    await expect(e.writeFile(join(extra, "out", "pwned.txt"), "x")).rejects.toThrow(
      WorkspaceWriteError,
    );
    await expect(e.writeFile(join(extra, "dangling"), "x")).rejects.toThrow(WorkspaceWriteError);
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
    expect(existsSync(join(outside, "planted.txt"))).toBe(false);
  });

  test("a symlink loop inside a writable dir is refused, not followed forever", async () => {
    await symlink(join(extra, "loop-b"), join(extra, "loop-a"));
    await symlink(join(extra, "loop-a"), join(extra, "loop-b"));
    const e = new HostExecution({ cwd: root, writableDirs: [extra] });
    await expect(e.writeFile(join(extra, "loop-a"), "x")).rejects.toThrow(WorkspaceWriteError);
  });

  test("a symlink inside a writable dir pointing into the project or itself is fine", async () => {
    await symlink(root, join(extra, "to-project"));
    await symlink(join(extra, "real.txt"), join(extra, "alias.txt"));
    const e = new HostExecution({ cwd: root, writableDirs: [extra] });
    await e.writeFile(join(extra, "to-project", "via-link.txt"), "v");
    await e.writeFile(join(extra, "alias.txt"), "a");
    expect(readFileSync(join(root, "via-link.txt"), "utf8")).toBe("v");
    expect(readFileSync(join(extra, "real.txt"), "utf8")).toBe("a");
  });

  test("a writable dir given through a symlinked alias matches by realpath (macOS /var vs /private/var)", async () => {
    const alias = join(base, "alias-of-scratch");
    await symlink(extra, alias);
    const e = new HostExecution({ cwd: root, writableDirs: [alias] });
    await e.writeFile(join(extra, "real-path.txt"), "r");
    await e.writeFile(join(alias, "alias-path.txt"), "a");
    expect(readFileSync(join(extra, "alias-path.txt"), "utf8")).toBe("a");
  });

  test(".. from the project into a writable dir is allowed; .. to a sibling is refused", async () => {
    const e = new HostExecution({ cwd: root, writableDirs: [extra] });
    await e.writeFile("../scratch/up.txt", "u");
    expect(readFileSync(join(extra, "up.txt"), "utf8")).toBe("u");
    await expect(e.writeFile("../outside/x.txt", "x")).rejects.toThrow(WorkspaceWriteError);
    await expect(e.writeFile(join(extra, "..", "outside", "y.txt"), "x")).rejects.toThrow(
      WorkspaceWriteError,
    );
  });

  test('"/" , a relative and a "~" entry are dropped (and reported): outside stays refused', async () => {
    const e = new HostExecution({
      cwd: root,
      writableDirs: ["/", "relative/dir", "~/scratch", extra],
    });
    expect(e.droppedWritableDirs).toEqual(["/", "relative/dir", "~/scratch"]);
    await expect(e.writeFile(join(outside, "x.txt"), "x")).rejects.toThrow(WorkspaceWriteError);
    await e.writeFile(join(extra, "ok.txt"), "ok");
    expect(new HostExecution({ cwd: root, writableDirs: [extra] }).droppedWritableDirs).toEqual([]);
  });

  test("a writable dir that does not exist yet is created by the first write", async () => {
    const missing = join(base, "not-yet", "tmp");
    const e = new HostExecution({ cwd: root, writableDirs: [missing] });
    await e.writeFile(join(missing, "first.txt"), "f");
    expect(readFileSync(join(missing, "first.txt"), "utf8")).toBe("f");
  });

  test("a case variant is allowed only where the filesystem says it IS the writable dir", async () => {
    const e = new HostExecution({ cwd: root, writableDirs: [extra] });
    const variant = join(base, "SCRATCH");
    if (existsSync(variant)) {
      // Case-insensitive (APFS default): realpath canonicalises → the same dir.
      await e.writeFile(join(variant, "case.txt"), "c");
      expect(readFileSync(join(extra, "case.txt"), "utf8")).toBe("c");
    } else {
      // Case-sensitive: a different, outside path.
      await expect(e.writeFile(join(variant, "case.txt"), "c")).rejects.toThrow(
        WorkspaceWriteError,
      );
    }
  });

  test("the refusal names the project and the writable dirs", async () => {
    const e = new HostExecution({ cwd: root, writableDirs: [extra] });
    const err = await e.writeFile(join(outside, "x.txt"), "x").catch((x: unknown) => x);
    expect(err).toBeInstanceOf(WorkspaceWriteError);
    expect(String((err as Error).message)).toContain(realpathSync(extra));
  });
});
