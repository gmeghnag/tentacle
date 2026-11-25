/**
 * `workflowsGitIgnored` (docs/feat/workflows-ui.md D7 v5): the catalogue's "not
 * versioned" notice, from `git check-ignore` over the project's workflow folder.
 * Exit 0 → ignored, exit 1 → not, anything else → `undefined`: unknown is never
 * claimed as either (no git installed, not a repo, a hang).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowsGitIgnored } from "../src/workflow-files.ts";

let dir: string;

/** A real git repo at a fresh temp dir, with `gitignore` as its .gitignore. */
function repo(gitignore: string): string {
  const root = mkdtempSync(join(dir, "repo-"));
  const init = Bun.spawnSync(["git", "init", "-q", "."], {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  if (init.exitCode !== 0) {
    throw new Error("git init failed — this test needs git");
  }
  writeFileSync(join(root, ".gitignore"), gitignore);
  mkdirSync(join(root, ".tentacle", "workflows"), { recursive: true });
  return root;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-gitignored-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("workflowsGitIgnored", () => {
  test("an ignored workflow folder is `true` (the old `.tentacle/` line)", async () => {
    expect(await workflowsGitIgnored(repo(".tentacle/\n"))).toBe(true);
  });

  test("the `.tentacle/*` + `!.tentacle/workflows/` exception is `false` (versioned)", async () => {
    expect(await workflowsGitIgnored(repo(".tentacle/*\n!.tentacle/workflows/\n"))).toBe(false);
  });

  test("no .gitignore at all is `false` (nothing is ignored)", async () => {
    expect(await workflowsGitIgnored(repo(""))).toBe(false);
  });

  test("not a git repository is `undefined` — unknown is never claimed", async () => {
    const outside = mkdtempSync(join(dir, "plain-"));
    mkdirSync(join(outside, ".tentacle", "workflows"), { recursive: true });
    expect(await workflowsGitIgnored(outside)).toBeUndefined();
  });
});
