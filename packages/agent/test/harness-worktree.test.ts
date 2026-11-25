import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_GIT,
  type GitRunner,
  createSnapshotWorktree,
  finishWorktree,
} from "../src/harness/worktree.ts";

const ROOT = "/Users/gmeghnag/tentacle/.tentacle/tmp/subagent-harness-runners";
let repo = "";

async function g(args: string[], cwd = repo): Promise<string> {
  const r = await DEFAULT_GIT(args, { cwd });
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout;
}

beforeEach(async () => {
  await mkdir(ROOT, { recursive: true });
  repo = await mkdtemp(join(ROOT, "wt-"));
  await g(["init", "-q"]);
  await g(["config", "user.email", "t@t"]);
  await g(["config", "user.name", "t"]);
  await writeFile(join(repo, ".gitignore"), ".tentacle/\nignored.txt\n");
  await writeFile(join(repo, "a.txt"), "one\n");
  await writeFile(join(repo, "b.txt"), "two\n");
  await g(["add", "-A"]);
  await g(["commit", "-q", "-m", "init"]);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function dirty() {
  await writeFile(join(repo, "a.txt"), "one\nstaged\n");
  await g(["add", "a.txt"]);
  await writeFile(join(repo, "b.txt"), "two\nunstaged\n");
  await writeFile(join(repo, "new.txt"), "untracked\n");
  await writeFile(join(repo, "ignored.txt"), "secret\n");
}

describe("snapshot worktree (D8)", () => {
  test("contains staged, unstaged and untracked-not-ignored changes", async () => {
    await dirty();
    const wt = await createSnapshotWorktree({ cwd: repo, id: "r1" });
    expect(wt.path.endsWith(join(".tentacle", "worktrees", "harness-r1"))).toBe(true);
    expect(await readFile(join(wt.path, "a.txt"), "utf8")).toBe("one\nstaged\n");
    expect(await readFile(join(wt.path, "b.txt"), "utf8")).toBe("two\nunstaged\n");
    expect(await readFile(join(wt.path, "new.txt"), "utf8")).toBe("untracked\n");
    expect(existsSync(join(wt.path, "ignored.txt"))).toBe(false);
    expect((await g(["branch", "--list", "harness/r1"])).trim()).toContain("harness/r1");
    // the user's own tree is untouched
    expect((await g(["status", "--porcelain"])).includes("new.txt")).toBe(true);
  });

  test("clean run removes worktree and branch", async () => {
    await dirty();
    const wt = await createSnapshotWorktree({ cwd: repo, id: "r2" });
    const out = await finishWorktree(wt);
    expect(out).toEqual({ changed: false });
    expect(existsSync(wt.path)).toBe(false);
    expect((await g(["branch", "--list", "harness/r2"])).trim()).toBe("");
  });

  test("changed run keeps both and reports the diffstat vs the baseline", async () => {
    await dirty();
    const wt = await createSnapshotWorktree({ cwd: repo, id: "r3" });
    await writeFile(join(wt.path, "made.txt"), "x\n");
    const out = await finishWorktree(wt);
    expect(out.changed).toBe(true);
    if (out.changed) {
      expect(out.diffstat).toContain("made.txt");
      // the snapshot's own changes are NOT counted as the run's
      expect(out.diffstat).not.toContain("new.txt");
      expect(out.branch).toBe("harness/r3");
    }
    expect(existsSync(wt.path)).toBe(true);
    expect((await g(["branch", "--list", "harness/r3"])).trim()).toContain("harness/r3");
  });

  test("the kept BRANCH holds the run's changes, as one commit over the baseline", async () => {
    await dirty();
    const wt = await createSnapshotWorktree({ cwd: repo, id: "r7" });
    await writeFile(join(wt.path, "made.txt"), "x\n");
    await writeFile(join(wt.path, "a.txt"), "edited by the run\n");
    const out = await finishWorktree(wt);
    expect(out).toMatchObject({ changed: true, committed: true, branch: "harness/r7" });
    // What the report invites the user to do (`git diff` / `merge harness/r7`) sees the work.
    expect(await g(["show", "harness/r7:made.txt"])).toBe("x\n");
    expect(await g(["show", "harness/r7:a.txt"])).toBe("edited by the run\n");
    expect((await g(["rev-parse", "harness/r7^"])).trim()).toBe(wt.baseline);
    expect(
      (await g(["diff", "--name-only", wt.baseline, "harness/r7"])).trim().split("\n"),
    ).toEqual(["a.txt", "made.txt"]);
  });

  test("a commit that fails keeps the worktree and says the branch does not hold the work", async () => {
    await dirty();
    const failing: GitRunner = (args, opts) =>
      args.includes("commit")
        ? Promise.resolve({ code: 1, stdout: "", stderr: "error: cannot commit" })
        : DEFAULT_GIT(args, opts);
    const wt = await createSnapshotWorktree({ cwd: repo, id: "r8" });
    await writeFile(join(wt.path, "made.txt"), "x\n");
    const out = await finishWorktree(wt, { git: failing });
    expect(out).toMatchObject({ changed: true, committed: false, path: wt.path });
    expect(existsSync(join(wt.path, "made.txt"))).toBe(true);
    expect((await g(["rev-parse", "harness/r8"])).trim()).toBe(wt.baseline);
  });

  test("non-git cwd refuses", async () => {
    // scratch lives inside the main repo, so a real non-git dir is not
    // reachable here: the runner reports what git says outside a repo.
    const calls: string[] = [];
    const notGit: GitRunner = (args) => {
      calls.push(args[0] ?? "");
      return Promise.resolve({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
    };
    await expect(createSnapshotWorktree({ cwd: repo, id: "r4" }, { git: notGit })).rejects.toThrow(
      /not a git/,
    );
    expect(calls).toEqual(["rev-parse"]);
  });

  test("a failing apply leaves nothing behind", async () => {
    await dirty();
    const failing: GitRunner = (args, opts) =>
      args[0] === "apply"
        ? Promise.resolve({ code: 1, stdout: "", stderr: "error: patch failed" })
        : DEFAULT_GIT(args, opts);
    await expect(createSnapshotWorktree({ cwd: repo, id: "r5" }, { git: failing })).rejects.toThrow(
      /patch failed/,
    );
    expect(existsSync(join(repo, ".tentacle", "worktrees", "harness-r5"))).toBe(false);
    expect((await g(["branch", "--list", "harness/r5"])).trim()).toBe("");
    expect((await g(["worktree", "list"])).trim().split("\n").length).toBe(1);
  });

  test("bad id never reaches git", async () => {
    await expect(createSnapshotWorktree({ cwd: repo, id: "../x" })).rejects.toThrow(
      /bad worktree id/,
    );
  });

  test("a repo without commits refuses", async () => {
    const empty = await mkdtemp(join(ROOT, "empty-"));
    try {
      await g(["init", "-q"], empty);
      await expect(createSnapshotWorktree({ cwd: empty, id: "r6" })).rejects.toThrow(/no commits/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
