import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostExecution, type HostExecutionConfig, WorkspaceWriteError } from "../src/index.ts";

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
    // Fix round 1: the link's target must exist (a dangling link is refused, below).
    await writeFile(join(extra, "real.txt"), "");
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

/** The error a rejected write throws (or `undefined` when it wrote). */
async function refusal(p: Promise<void>): Promise<WorkspaceWriteError | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(WorkspaceWriteError);
    return e as WorkspaceWriteError;
  }
}

// Review round 1 of docs/feat/write-tmpdir.md: F1 (a dangling link's target was
// resolved lexically while the kernel resolves it physically) and F2 (TOCTOU, hard
// links). Every case runs in a writable dir AND in the project.
describe("dangling links, hard links and races (fix round 1)", () => {
  let extra: string;
  let arenas: { name: string; dir: string }[];

  beforeEach(async () => {
    extra = join(root, "..", "scratch");
    await mkdir(extra, { recursive: true });
    arenas = [
      { name: "writable dir", dir: extra },
      { name: "project", dir: root },
    ];
  });

  const mk = (over: Partial<HostExecutionConfig> = {}) =>
    new HostExecution({ cwd: root, writableDirs: [extra], ...over });

  test("F1: a dangling link whose target is `dir-link/../x` is refused (lexical vs physical ..)", async () => {
    await mkdir(join(outside, "sub"), { recursive: true });
    for (const { name, dir } of arenas) {
      await symlink(join(outside, "sub"), join(dir, "d"));
      await symlink("d/../created-outside", join(dir, "lexbad"));
      const err = await refusal(mk().writeFile(join(dir, "lexbad"), "pwned"));
      expect(err?.message, name).toContain("dangling symlink");
      expect(existsSync(join(outside, "created-outside")), name).toBe(false);
      await rm(join(dir, "d"));
      await rm(join(dir, "lexbad"));
    }
  });

  test("F1: a dangling `../x` link reached through a dir link is refused (the regression form)", async () => {
    await mkdir(join(outside, "sub"), { recursive: true });
    await symlink("../up-out", join(outside, "sub", "up"));
    for (const { name, dir } of arenas) {
      await symlink(join(outside, "sub"), join(dir, "d"));
      expect(await refusal(mk().writeFile(join(dir, "d", "up"), "pwned")), name).toBeDefined();
      expect(existsSync(join(outside, "up-out")), name).toBe(false);
      await rm(join(dir, "d"));
    }
  });

  test("F1: a dangling link is refused even when it points inside a root, with a clear error", async () => {
    for (const { name, dir } of arenas) {
      await symlink(join(dir, "not-yet.txt"), join(dir, "inside-dangling"));
      const err = await refusal(mk().writeFile(join(dir, "inside-dangling"), "x"));
      expect(err?.message, name).toContain("refused: dangling symlink");
      expect(existsSync(join(dir, "not-yet.txt")), name).toBe(false);
    }
  });

  test("F1: a writable dir that is a dangling link at start-up is dropped, not moved to its target", () => {
    const dangling = join(extra, "dang-root");
    symlinkSync(join(outside, "nowhere"), dangling);
    expect(mk({ writableDirs: [dangling] }).droppedWritableDirs).toEqual([dangling]);
  });

  test("F2: a hard link to a file outside every root is refused; the outside file is untouched", async () => {
    await writeFile(join(outside, "victim.txt"), "orig");
    for (const { name, dir } of arenas) {
      await link(join(outside, "victim.txt"), join(dir, "hl"));
      const err = await refusal(mk().writeFile(join(dir, "hl"), "pwned"));
      expect(err?.message, name).toContain("hard link");
      expect(readFileSync(join(outside, "victim.txt"), "utf8"), name).toBe("orig");
    }
  });

  test("F2: ordinary writes still work: create, overwrite (truncated), through an in-root link", async () => {
    for (const { name, dir } of arenas) {
      const e = mk();
      await e.writeFile(join(dir, "plain.txt"), "a long first content");
      await e.writeFile(join(dir, "plain.txt"), "x");
      expect(readFileSync(join(dir, "plain.txt"), "utf8"), name).toBe("x");
      await symlink(join(dir, "plain.txt"), join(dir, "plain-alias"));
      await e.writeFile(join(dir, "plain-alias"), "via");
      expect(readFileSync(join(dir, "plain.txt"), "utf8"), name).toBe("via");
    }
  });

  test("F2: a symlink swapped in at the final path after the check is refused by O_NOFOLLOW", async () => {
    await writeFile(join(outside, "race-target.txt"), "orig");
    for (const { name, dir } of arenas) {
      const target = join(dir, "race.txt");
      const e = mk({
        beforeOpen: (p) => {
          symlinkSync(join(outside, "race-target.txt"), p);
        },
      });
      const err = await refusal(e.writeFile(target, "pwned"));
      expect(err?.message, name).toContain("symlink at the final path");
      expect(readFileSync(join(outside, "race-target.txt"), "utf8"), name).toBe("orig");
      await rm(target);
    }
  });

  test("F2: a parent dir swapped for a link outward after the check is refused; the outside file keeps its bytes", async () => {
    await mkdir(join(outside, "swapped"), { recursive: true });
    await writeFile(join(outside, "swapped", "p.txt"), "orig");
    for (const { name, dir } of arenas) {
      await mkdir(join(dir, "sub"), { recursive: true });
      const e = mk({
        beforeOpen: () => {
          renameSync(join(dir, "sub"), join(dir, "sub-moved"));
          symlinkSync(join(outside, "swapped"), join(dir, "sub"));
        },
      });
      const err = await refusal(e.writeFile(join(dir, "sub", "p.txt"), "pwned"));
      expect(err?.message, name).toContain("moved during the write");
      expect(readFileSync(join(outside, "swapped", "p.txt"), "utf8"), name).toBe("orig");
      // A file that did not exist out there gets at most an empty file, never the bytes.
      const e2 = mk({
        beforeOpen: () => {
          rmSync(join(dir, "sub"));
          renameSync(join(dir, "sub-moved"), join(dir, "sub"));
          renameSync(join(dir, "sub"), join(dir, "sub-moved"));
          symlinkSync(join(outside, "swapped"), join(dir, "sub"));
        },
      });
      expect(await refusal(e2.writeFile(join(dir, "sub", "new.txt"), "pwned")), name).toBeDefined();
      const created = join(outside, "swapped", "new.txt");
      expect(existsSync(created) ? readFileSync(created, "utf8") : "", name).toBe("");
      rmSync(created, { force: true });
      rmSync(join(dir, "sub"));
      rmSync(join(dir, "sub-moved"), { recursive: true });
    }
  });

  test("F2: a FIFO at the path is refused at once (no hang waiting for a reader)", async () => {
    for (const { name, dir } of arenas) {
      const fifo = join(dir, "fifo");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode, name).toBe(0);
      expect(await refusal(mk().writeFile(fifo, "x")), name).toBeDefined();
    }
  }, 2000);
});
