import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { link, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  test("F2: a hard link to a file outside every root never changes the outside file", async () => {
    // Fix round 2 (owner A): no longer refused — the write REPLACES the in-root
    // name (temp + rename), so the link just loses that name; the outside inode
    // is never written.
    await writeFile(join(outside, "victim.txt"), "orig");
    for (const { name, dir } of arenas) {
      await link(join(outside, "victim.txt"), join(dir, "hl"));
      await mk().writeFile(join(dir, "hl"), "pwned");
      expect(readFileSync(join(outside, "victim.txt"), "utf8"), name).toBe("orig");
      expect(readFileSync(join(dir, "hl"), "utf8"), name).toBe("pwned");
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

/** `FileHandle.prototype`, to inject an attacker's steps around `fstat` (review R2-1). */
async function fileHandleProto(): Promise<{ stat: (...a: unknown[]) => Promise<unknown> }> {
  const fh = await open(join(root, ".."), "r");
  const proto = Object.getPrototypeOf(fh);
  await fh.close();
  return proto;
}

/** Temp files a write left in `dir` (it must leave none). */
const leftovers = (dir: string) => readdirSync(dir).filter((n) => n.includes("tentacle-tmp"));

// Review round 2 of docs/feat/write-tmpdir.md (owner answer A): atomic temp +
// rename (R2-1 hard links, R2-4), the directory ownership rule (R2-1 swaps, R2-3)
// and the loop message (R2-2). Every case in a writable dir AND in the project.
describe("atomic replace and the directory rule (fix round 2)", () => {
  let extra: string;
  let arenas: { name: string; dir: string }[];

  beforeEach(async () => {
    extra = join(root, "..", "scratch2");
    await mkdir(extra, { recursive: true });
    arenas = [
      { name: "writable dir", dir: extra },
      { name: "project", dir: root },
    ];
  });

  const mk = (over: Partial<HostExecutionConfig> = {}) =>
    new HostExecution({ cwd: root, writableDirs: [extra], ...over });

  test("R2-1 FLIP: a hard link removed around fstat and put back cannot get the outside file written", async () => {
    await writeFile(join(outside, "victim3"), "orig");
    const proto = await fileHandleProto();
    const realStat = proto.stat;
    for (const { name, dir } of arenas) {
      const flip = join(dir, "flip");
      linkSync(join(outside, "victim3"), flip);
      proto.stat = async function (this: unknown, ...a: unknown[]) {
        rmSync(flip, { force: true });
        const st = await realStat.apply(this, a);
        linkSync(join(outside, "victim3"), flip);
        return st;
      };
      try {
        await mk()
          .writeFile(flip, "PWNED")
          .catch(() => undefined);
      } finally {
        proto.stat = realStat;
      }
      expect(readFileSync(join(outside, "victim3"), "utf8"), name).toBe("orig");
      rmSync(flip, { force: true });
    }
  });

  test("R2-1 TWO-STEP: a parent swapped outward then back (holding a hard link) cannot get the outside file written", async () => {
    await mkdir(join(outside, "sub"), { recursive: true });
    await writeFile(join(outside, "sub", "victim2"), "orig");
    const proto = await fileHandleProto();
    const realStat = proto.stat;
    for (const { name, dir } of arenas) {
      const q = join(dir, "q");
      await mkdir(q, { recursive: true });
      const e = mk({
        beforeOpen: () => {
          renameSync(q, `${q}-real`);
          symlinkSync(join(outside, "sub"), q);
        },
      });
      proto.stat = async function (this: unknown, ...a: unknown[]) {
        const st = await realStat.apply(this, a);
        if (lstatSync(q).isSymbolicLink()) {
          rmSync(q);
          renameSync(`${q}-real`, q);
          linkSync(join(outside, "sub", "victim2"), join(q, "victim2"));
        }
        return st;
      };
      try {
        await e.writeFile(join(q, "victim2"), "PWNED").catch(() => undefined);
      } finally {
        proto.stat = realStat;
      }
      expect(readFileSync(join(outside, "sub", "victim2"), "utf8"), name).toBe("orig");
      expect(readdirSync(join(outside, "sub")).sort(), name).toEqual(["victim2"]);
      rmSync(q, { recursive: true, force: true });
      rmSync(`${q}-real`, { recursive: true, force: true });
    }
  });

  test("R2-3: a parent swapped outward after the check leaves NOTHING outside (no empty file, no temp)", async () => {
    await mkdir(join(outside, "swap3"), { recursive: true });
    for (const { name, dir } of arenas) {
      const sub = join(dir, "s3");
      await mkdir(sub, { recursive: true });
      const e = mk({
        beforeOpen: () => {
          renameSync(sub, `${sub}-moved`);
          symlinkSync(join(outside, "swap3"), sub);
        },
      });
      const err = await refusal(e.writeFile(join(sub, "new.txt"), "pwned"));
      expect(err?.message, name).toContain("moved during the write");
      expect(readdirSync(join(outside, "swap3")), name).toEqual([]);
      rmSync(sub);
      rmSync(`${sub}-moved`, { recursive: true });
    }
  });

  test("fix round 3: a group-writable (0775) subdirectory is writable, in the project and in a temp root", async () => {
    // umask 002 (user-private groups) and pod fsGroup make 0775 dirs normal.
    for (const { name, dir } of arenas) {
      await mkdir(join(dir, "gw"), { recursive: true });
      chmodSync(join(dir, "gw"), 0o775);
      await mk().writeFile(join(dir, "gw", "deep", "x.txt"), "x");
      expect(readFileSync(join(dir, "gw", "deep", "x.txt"), "utf8"), name).toBe("x");
    }
    // A world-writable sticky root (like /tmp) too.
    chmodSync(extra, 0o1777);
    await mk().writeFile(join(extra, "in-root.txt"), "ok");
    expect(readFileSync(join(extra, "in-root.txt"), "utf8")).toBe("ok");
    chmodSync(extra, 0o755);
  });

  test("R2-4: a hard-linked file INSIDE the root is writable again (the link loses this name)", async () => {
    for (const { name, dir } of arenas) {
      await writeFile(join(dir, "a.js"), "old");
      await link(join(dir, "a.js"), join(dir, "b.js"));
      await mk().writeFile(join(dir, "b.js"), "new");
      expect(readFileSync(join(dir, "b.js"), "utf8"), name).toBe("new");
      expect(readFileSync(join(dir, "a.js"), "utf8"), name).toBe("old");
    }
  });

  test("an existing file's mode bits are kept by the replace", async () => {
    for (const { name, dir } of arenas) {
      for (const mode of [0o640, 0o755, 0o600]) {
        const f = join(dir, `m${mode.toString(8)}`);
        await writeFile(f, "x");
        chmodSync(f, mode);
        await mk().writeFile(f, "y");
        expect(statSync(f).mode & 0o777, `${name} ${mode.toString(8)}`).toBe(mode);
      }
    }
  });

  test("a failing write leaves no temp file behind", async () => {
    for (const { name, dir } of arenas) {
      const e = mk({
        beforeRename: () => {
          throw new Error("boom");
        },
      });
      await expect(e.writeFile(join(dir, "fails.txt"), "x"), name).rejects.toThrow("boom");
      expect(leftovers(dir), name).toEqual([]);
      expect(existsSync(join(dir, "fails.txt")), name).toBe(false);
      // A refused write too (a directory at the path).
      await mkdir(join(dir, "adir"), { recursive: true });
      expect(await refusal(mk().writeFile(join(dir, "adir"), "x")), name).toBeDefined();
      expect(leftovers(dir), name).toEqual([]);
    }
  });

  test("R2-2: a symlink loop says so (not 'create it first')", async () => {
    for (const { name, dir } of arenas) {
      symlinkSync(join(dir, "l2"), join(dir, "l1"));
      symlinkSync(join(dir, "l1"), join(dir, "l2"));
      const err = await refusal(mk().writeFile(join(dir, "l1"), "x"));
      expect(err?.message, name).toContain("symlink loop");
      expect(err?.message, name).not.toContain("create it first");
    }
  });
});

/** Running as root defeats permission bits: the permission tests below need a normal user. */
const isRoot = process.getuid?.() === 0;

// Review round 3 of docs/feat/write-tmpdir.md: the atomic replace must keep the
// in-place write's file-permission semantics (F1 temp mode, F2 parity with
// `main`) and handle long names and failed renames (F3, F4).
describe("permission parity and temp hygiene (fix round 4)", () => {
  let extra: string;
  let arenas: { name: string; dir: string }[];

  beforeEach(async () => {
    extra = join(root, "..", "scratch4");
    await mkdir(extra, { recursive: true });
    arenas = [
      { name: "writable dir", dir: extra },
      { name: "project", dir: root },
    ];
  });

  const mk = (over: Partial<HostExecutionConfig> = {}) =>
    new HostExecution({ cwd: root, writableDirs: [extra], ...over });

  test("F1: the temp is 0600 while the content is written; fchmod to the final mode only after", async () => {
    const proto = (await fileHandleProto()) as unknown as {
      writeFile: (...a: unknown[]) => Promise<void>;
      stat: () => Promise<{ mode: number }>;
    };
    const realWrite = proto.writeFile;
    const seen: number[] = [];
    proto.writeFile = async function (this: typeof proto, ...a: unknown[]) {
      seen.push((await this.stat()).mode & 0o777);
      return realWrite.apply(this, a);
    };
    try {
      for (const { name, dir } of arenas) {
        for (const mode of [0o600, 0o644]) {
          const f = join(dir, `secret-${mode.toString(8)}.env`);
          await writeFile(f, "old");
          chmodSync(f, mode);
          seen.length = 0;
          let atRename = -1;
          await mk({
            beforeRename: () => {
              const temp = leftovers(dir)[0];
              atRename = temp === undefined ? -1 : statSync(join(dir, temp)).mode & 0o777;
            },
          }).writeFile(f, "TOP-SECRET");
          expect(seen, `${name} ${mode.toString(8)}`).toEqual([0o600]);
          expect(atRename, `${name} ${mode.toString(8)}`).toBe(mode);
          expect(statSync(f).mode & 0o777, `${name} ${mode.toString(8)}`).toBe(mode);
        }
      }
    } finally {
      proto.writeFile = realWrite;
    }
  });

  test("F1: a new file gets 0666 minus the umask (after the write), as before", async () => {
    for (const umask of [0o022, 0o002]) {
      const old = process.umask(umask);
      try {
        for (const { name, dir } of arenas) {
          const f = join(dir, `new-${umask.toString(8)}.txt`);
          await mk().writeFile(f, "n");
          expect(statSync(f).mode & 0o777, `${name} ${umask.toString(8)}`).toBe(0o666 & ~umask);
        }
      } finally {
        process.umask(old);
      }
    }
  });

  test.skipIf(isRoot)(
    "F2: a read-only (0444) file is refused with EACCES; its content is unchanged",
    async () => {
      for (const { name, dir } of arenas) {
        const f = join(dir, "ro.txt");
        await writeFile(f, "orig");
        chmodSync(f, 0o444);
        const err = await refusal(mk().writeFile(f, "new"));
        expect(err?.message, name).toContain("read-only");
        expect(err?.message, name).toContain("EACCES");
        expect((err as NodeJS.ErrnoException | undefined)?.code, name).toBe("EACCES");
        expect(readFileSync(f, "utf8"), name).toBe("orig");
        expect(leftovers(dir), name).toEqual([]);
        // The same file made writable is replaced.
        chmodSync(f, 0o644);
        await mk().writeFile(f, "new");
        expect(readFileSync(f, "utf8"), name).toBe("new");
      }
    },
  );

  test.skipIf(isRoot)(
    "F2: a file owned by another user that we cannot write is refused (a real root-owned file)",
    async () => {
      const hosts = realpathSync("/etc/hosts");
      const before = readFileSync(hosts, "utf8");
      const e = new HostExecution({ cwd: root, writableDirs: [dirname(hosts)] });
      const err = await refusal(e.writeFile(hosts, "pwned"));
      expect(err?.message).toContain("EACCES");
      expect(readFileSync(hosts, "utf8")).toBe(before);
    },
  );

  test.skipIf(isRoot)(
    "F2: a writable file in a directory we cannot write is refused clearly (no raw temp error)",
    async () => {
      for (const { name, dir } of arenas) {
        const ro = join(dir, "rodir");
        await mkdir(ro, { recursive: true });
        await writeFile(join(ro, "f.txt"), "orig");
        chmodSync(join(ro, "f.txt"), 0o666);
        chmodSync(ro, 0o555);
        try {
          const err = await refusal(mk().writeFile(join(ro, "f.txt"), "new"));
          expect(err?.message, name).toContain("not writable");
          expect(err?.message, name).toContain(realpathSync(ro));
          expect(err?.message, name).not.toContain("tentacle-tmp");
          expect(readFileSync(join(ro, "f.txt"), "utf8"), name).toBe("orig");
        } finally {
          chmodSync(ro, 0o755);
        }
      }
    },
  );

  test("F3: a 250-byte name is writable (the temp name does not grow with it)", async () => {
    for (const { name, dir } of arenas) {
      const f = join(dir, "n".repeat(250));
      await mk().writeFile(f, "long");
      expect(readFileSync(f, "utf8"), name).toBe("long");
      expect(leftovers(dir), name).toEqual([]);
    }
  });

  test("F4: a rename that fails (a non-empty dir appears at the target) unlinks the temp", async () => {
    for (const { name, dir } of arenas) {
      const f = join(dir, "becomes-dir");
      const e = mk({
        beforeRename: () => {
          mkdirSync(f);
          writeFileSync(join(f, "inside"), "x");
        },
      });
      await expect(e.writeFile(f, "x"), name).rejects.toThrow();
      expect(leftovers(dir), name).toEqual([]);
      expect(readdirSync(f), name).toEqual(["inside"]);
    }
  });

  test.skipIf(isRoot)(
    "F4: when the temp cannot be removed (parent made read-only), the error says where it was left",
    async () => {
      for (const { name, dir } of arenas) {
        const sub = join(dir, "lock");
        await mkdir(sub, { recursive: true });
        const e = mk({
          beforeRename: () => {
            chmodSync(sub, 0o555);
          },
        });
        try {
          const err = await refusal(e.writeFile(join(sub, "x.txt"), "x"));
          expect(err?.message, name).toContain("temp file left at");
          expect(err?.message, name).toContain(".tt-");
        } finally {
          chmodSync(sub, 0o755);
        }
      }
    },
  );
});
