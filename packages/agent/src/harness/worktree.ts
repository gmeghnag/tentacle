/**
 * D8 (docs/feat/subagent-harness-runners.md): every harness run works in a
 * git worktree that is a SNAPSHOT of the user's tree — HEAD + staged/unstaged
 * changes (`git diff --binary HEAD`) + untracked non-ignored files — committed
 * as a baseline on `harness/<id>`. At the end a run that changed nothing has
 * its worktree and branch removed; one that changed something keeps both and
 * reports the diffstat. Never merged by us. Git is an injected runner.
 */

import { copyFile, lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `git <args>` in `cwd`; `input` goes to stdin. Never throws on a non-zero exit. */
export type GitRunner = (
  args: readonly string[],
  opts: { cwd: string; input?: string },
) => Promise<GitResult>;

export const DEFAULT_GIT: GitRunner = async (args, opts) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd: opts.cwd,
    stdin: opts.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    await proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export interface SnapshotWorktree {
  readonly id: string;
  /** Absolute path of the worktree (the run's cwd). */
  readonly path: string;
  readonly branch: string;
  /** The baseline commit the run's changes are measured against. */
  readonly baseline: string;
  readonly repoRoot: string;
}

export type WorktreeOutcome =
  | { readonly changed: false }
  | {
      readonly changed: true;
      readonly branch: string;
      readonly path: string;
      readonly diffstat: string;
    };

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const IDENTITY = ["-c", "user.name=tentacle", "-c", "user.email=tentacle@localhost"];

export interface SnapshotDeps {
  readonly git?: GitRunner;
}

async function must(git: GitRunner, args: string[], cwd: string, input?: string): Promise<string> {
  const r = await git(args, input === undefined ? { cwd } : { cwd, input });
  if (r.code !== 0) {
    throw new WorktreeError(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

/** Remove a worktree and its branch (best effort, never throws). */
export async function removeWorktree(
  wt: Pick<SnapshotWorktree, "path" | "branch" | "repoRoot">,
  deps: SnapshotDeps = {},
): Promise<void> {
  const git = deps.git ?? DEFAULT_GIT;
  await git(["worktree", "remove", "--force", wt.path], { cwd: wt.repoRoot }).catch(() => {});
  await git(["worktree", "prune"], { cwd: wt.repoRoot }).catch(() => {});
  await git(["branch", "-D", wt.branch], { cwd: wt.repoRoot }).catch(() => {});
}

/** Copy an untracked entry (file or symlink); refuses a path escaping the tree. */
async function copyUntracked(root: string, dest: string, rel: string): Promise<void> {
  if (isAbsolute(rel) || normalize(rel).startsWith("..")) {
    throw new WorktreeError(`untracked path escapes the tree: ${rel}`);
  }
  const from = join(root, rel);
  const to = join(dest, rel);
  const st = await lstat(from);
  await mkdir(dirname(to), { recursive: true });
  if (st.isSymbolicLink()) await symlink(await readlink(from), to);
  else if (st.isFile()) await copyFile(from, to);
}

/**
 * Create `<repo>/.tentacle/worktrees/harness-<id>` on branch `harness/<id>`
 * holding the snapshot. Refuses (nothing left behind) on a non-git cwd, a repo
 * without commits, or a snapshot that does not apply.
 */
export async function createSnapshotWorktree(
  opts: { cwd: string; id: string },
  deps: SnapshotDeps = {},
): Promise<SnapshotWorktree> {
  const git = deps.git ?? DEFAULT_GIT;
  if (!ID_SHAPE.test(opts.id)) throw new WorktreeError(`bad worktree id: ${opts.id}`);
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: opts.cwd });
  if (top.code !== 0) {
    throw new WorktreeError(
      `not a git repository (${opts.cwd}): a harness run needs one for its worktree`,
    );
  }
  const repoRoot = top.stdout.trim();
  const head = await git(["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  if (head.code !== 0) throw new WorktreeError("the repository has no commits yet");

  const patch = await must(git, ["diff", "--binary", "HEAD"], repoRoot);
  const untracked = (
    await must(git, ["ls-files", "--others", "--exclude-standard", "-z"], repoRoot)
  )
    .split("\0")
    .filter((p) => p !== "");

  const path = resolve(repoRoot, ".tentacle", "worktrees", `harness-${opts.id}`);
  const branch = `harness/${opts.id}`;
  const handle = { path, branch, repoRoot };
  try {
    await must(git, ["worktree", "add", "--detach", path, "HEAD"], repoRoot);
    await must(git, ["checkout", "-b", branch], path);
    if (patch !== "") await must(git, ["apply", "--index", "--binary"], path, patch);
    for (const rel of untracked) await copyUntracked(repoRoot, path, rel);
    await must(git, ["add", "-A"], path);
    await must(
      git,
      [
        ...IDENTITY,
        "commit",
        "--allow-empty",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "harness baseline",
      ],
      path,
    );
    const baseline = (await must(git, ["rev-parse", "HEAD"], path)).trim();
    return { id: opts.id, ...handle, baseline };
  } catch (e) {
    await removeWorktree(handle, deps);
    throw e instanceof WorktreeError
      ? e
      : new WorktreeError(`snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * End of a run: no change since the baseline → remove worktree + branch; a
 * change → keep both and return the diffstat (never merged by us).
 */
export async function finishWorktree(
  wt: SnapshotWorktree,
  deps: SnapshotDeps = {},
): Promise<WorktreeOutcome> {
  const git = deps.git ?? DEFAULT_GIT;
  try {
    await must(git, ["add", "-A"], wt.path);
    const stat = (await must(git, ["diff", "--cached", "--stat", wt.baseline], wt.path)).trim();
    if (stat === "") {
      await removeWorktree(wt, deps);
      return { changed: false };
    }
    return { changed: true, branch: wt.branch, path: wt.path, diffstat: stat };
  } catch {
    // Cannot tell: keep everything rather than lose the run's work.
    return { changed: true, branch: wt.branch, path: wt.path, diffstat: "(diffstat unavailable)" };
  }
}
