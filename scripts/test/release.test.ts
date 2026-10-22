import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReleaseError,
  bumpBunLock,
  bumpPackageJson,
  parseReleaseVersion,
  releaseChangelog,
} from "../release-plan.ts";
import { type ReleaseDeps, runRelease } from "../release.ts";

describe("parseReleaseVersion", () => {
  const ok = (v: string) => parseReleaseVersion(v, "0.1.0-beta.1", ["v0.1.0-beta.1"]);
  test("accepts a strict semver above current and ≥ 0.1.0", () => {
    expect(ok("0.1.0")).toEqual({ version: "0.1.0", tag: "v0.1.0" });
    expect(ok("0.2.0-rc.1")).toEqual({ version: "0.2.0-rc.1", tag: "v0.2.0-rc.1" });
    expect(ok("1.0.0+build.5")).toEqual({ version: "1.0.0+build.5", tag: "v1.0.0+build.5" });
  });
  for (const [input, message] of [
    ["v0.1.0", /without the "v"/],
    ["0.1", /not a semver/],
    ["01.2.3", /not a semver/],
    ["0.1.0-", /not a semver/],
    ["latest", /not a semver/],
    ["0.0.9", /0\.1\.0 or later/],
    ["0.1.0-beta.1", /0\.1\.0 or later/],
    ["0.1.0-alpha", /0\.1\.0 or later/],
  ] as const) {
    test(`refuses ${JSON.stringify(input)}`, () => {
      expect(() => ok(input)).toThrow(message);
      expect(() => ok(input)).toThrow(ReleaseError);
    });
  }
  test("refuses a version not above the current one", () => {
    expect(() => parseReleaseVersion("0.2.0", "0.2.0", [])).toThrow(
      /0\.2\.0 must be greater than the current 0\.2\.0/,
    );
    expect(() => parseReleaseVersion("0.2.0-rc.1", "0.2.0", [])).toThrow(/must be greater/);
  });

  test("refuses an existing tag", () => {
    expect(() => parseReleaseVersion("0.2.0", "0.1.0", ["v0.1.0", "v0.2.0"])).toThrow(
      /tag v0\.2\.0 already exists/,
    );
  });
});

describe("file rewrites", () => {
  test("bumpPackageJson changes only the top-level version value", () => {
    const text =
      '{\n  "name": "@x/a",\n  "version": "0.1.0-beta.1",\n  "dependencies": {\n    "y": "workspace:*",\n    "version": "1.0.0"\n  }\n}\n';
    expect(bumpPackageJson(text, "0.1.0")).toBe(text.replace('"0.1.0-beta.1"', '"0.1.0"'));
    expect(() => bumpPackageJson('{\n  "name": "x"\n}\n', "0.1.0")).toThrow(/no top-level/);
  });

  test("bumpBunLock bumps only workspace versions and checks the count", () => {
    const lock = `{
  "workspaces": {
    "": {
      "name": "root",
    },
    "packages/a": {
      "name": "@x/a",
      "version": "0.1.0-beta.1",
    },
    "packages/b": {
      "name": "@x/b",
      "version": "0.1.0-beta.1",
    },
  },
  "packages": {
    "dep": ["dep@1.0.0", "", { "version": "0.1.0-beta.1" }],
  }
}
`;
    const out = bumpBunLock(lock, "0.1.0-beta.1", "0.1.0", 2);
    expect(out.split('"version": "0.1.0",').length - 1).toBe(2);
    expect(out).toContain('{ "version": "0.1.0-beta.1" }'); // outside workspaces: untouched
    expect(() => bumpBunLock(lock, "0.1.0-beta.1", "0.1.0", 3)).toThrow(/expected 3/);
  });

  const changelog = (unreleased: string, links = "") =>
    `# Changelog\n\nIntro.\n\n## [Unreleased]\n${unreleased}\n## [0.1.0-beta.1] - 2026-10-21\n\nFirst.\n${links}`;

  test("releaseChangelog dates [Unreleased] and opens a fresh empty one", () => {
    const out = releaseChangelog(changelog("\n### Added\n\n- A thing.\n"), "0.1.0", "2026-10-22");
    expect(out).toBe(
      "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-22\n\n### Added\n\n- A thing.\n\n## [0.1.0-beta.1] - 2026-10-21\n\nFirst.\n",
    );
  });

  test("releaseChangelog refuses an empty or missing [Unreleased]", () => {
    expect(() => releaseChangelog(changelog("\n\n"), "0.1.0", "2026-10-22")).toThrow(
      /\[Unreleased\] is empty/,
    );
    expect(() => releaseChangelog("# Changelog\n\n## [0.1.0] - x\n", "0.2.0", "d")).toThrow(
      /no "## \[Unreleased\]"/,
    );
  });

  test("releaseChangelog rewrites GitHub compare links when present", () => {
    const links =
      "\n[Unreleased]: https://github.com/o/r/compare/v0.1.0-beta.1...HEAD\n[0.1.0-beta.1]: https://github.com/o/r/releases/tag/v0.1.0-beta.1\n";
    const out = releaseChangelog(changelog("\n- A thing.\n", links), "0.1.0", "2026-10-22");
    expect(out).toContain("[Unreleased]: https://github.com/o/r/compare/v0.1.0...HEAD\n");
    expect(out).toContain(
      "[0.1.0]: https://github.com/o/r/compare/v0.1.0-beta.1...v0.1.0\n[0.1.0-beta.1]:",
    );
  });
});

// ---- runRelease against a real temp git repo (bare origin, fake gate) ----

const PKG = (name: string, version: string) =>
  `{\n  "name": "${name}",\n  "version": "${version}",\n  "private": true,\n  "license": "MIT"\n}\n`;
const LOCK = (version: string) =>
  `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "root",\n    },\n    "packages/a": {\n      "name": "@x/a",\n      "version": "${version}",\n    },\n    "packages/cli": {\n      "name": "@x/cli",\n      "version": "${version}",\n    },\n  },\n  "packages": {}\n}\n`;
const CHANGELOG =
  "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Everything.\n\n## [0.1.0-beta.1] - 2026-10-21\n\nFirst.\n";

let base: string;
let repo: string;
let out: string[];
let gateRuns: number;

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "tentacle-release-"));
  const origin = join(base, "origin.git");
  repo = join(base, "repo");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "init", "-q", "-b", "main", repo);
  for (const [k, v] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ]) {
    git(repo, "config", k as string, v as string);
  }
  mkdirSync(join(repo, "packages/a"), { recursive: true });
  mkdirSync(join(repo, "packages/cli"), { recursive: true });
  mkdirSync(join(repo, "stubs/s"), { recursive: true });
  writeFileSync(join(repo, "package.json"), PKG("root", "0.1.0-beta.1"));
  writeFileSync(join(repo, "packages/a/package.json"), PKG("@x/a", "0.1.0-beta.1"));
  writeFileSync(join(repo, "packages/cli/package.json"), PKG("@x/cli", "0.1.0-beta.1"));
  writeFileSync(join(repo, "stubs/s/package.json"), PKG("stub", "0.0.0"));
  writeFileSync(join(repo, "bun.lock"), LOCK("0.1.0-beta.1"));
  writeFileSync(join(repo, "CHANGELOG.md"), CHANGELOG);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "tag", "-a", "v0.1.0-beta.1", "-m", "beta");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main", "--tags");
  out = [];
  gateRuns = 0;
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const deps = (extra: Partial<ReleaseDeps> = {}): ReleaseDeps => ({
  root: repo,
  gate: async () => {
    gateRuns += 1;
    return true;
  },
  today: () => "2026-10-22",
  write: (t) => out.push(t),
  ...extra,
});
const read = (p: string) => readFileSync(join(repo, p), "utf8");
const snapshot = () =>
  [
    "package.json",
    "packages/a/package.json",
    "packages/cli/package.json",
    "bun.lock",
    "CHANGELOG.md",
  ]
    .map(read)
    .join("\0");
const head = () => git(repo, "rev-parse", "HEAD");

describe("runRelease", () => {
  test("happy path: every package.json + bun.lock + CHANGELOG, one commit, an annotated tag; never pushes", async () => {
    const before = head();
    expect(await runRelease(["0.1.0"], deps())).toBe(0);
    for (const [p, name] of [
      ["package.json", "root"],
      ["packages/a/package.json", "@x/a"],
      ["packages/cli/package.json", "@x/cli"],
    ] as const) {
      expect(read(p)).toBe(PKG(name, "0.1.0")); // formatting intact
    }
    expect(read("stubs/s/package.json")).toBe(PKG("stub", "0.0.0"));
    expect(read("bun.lock")).toBe(LOCK("0.1.0"));
    expect(read("CHANGELOG.md")).toBe(
      "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-22\n\n### Added\n\n- Everything.\n\n## [0.1.0-beta.1] - 2026-10-21\n\nFirst.\n",
    );
    expect(git(repo, "rev-list", "--count", `${before}..HEAD`)).toBe("1");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("chore(release): v0.1.0");
    expect(git(repo, "log", "-1", "--format=%B")).toBe("chore(release): v0.1.0"); // no trailer
    expect(git(repo, "cat-file", "-t", "v0.1.0")).toBe("tag"); // annotated
    expect(git(repo, "rev-parse", "v0.1.0^{commit}")).toBe(head());
    expect(git(repo, "status", "--porcelain")).toBe("");
    // Not pushed: origin has neither the commit nor the tag.
    expect(git(repo, "ls-remote", "--tags", "origin", "v0.1.0")).toBe("");
    expect(git(repo, "rev-parse", "origin/main")).toBe(before);
    expect(out.join("")).toContain("git push origin main && git push origin v0.1.0");
    expect(gateRuns).toBe(1);
  });

  const refused = async (argv: string[], message: RegExp, extra: Partial<ReleaseDeps> = {}) => {
    const before = snapshot();
    const commit = head();
    expect(await runRelease(argv, deps(extra))).toBe(1);
    expect(out.join("")).toMatch(message);
    expect(snapshot()).toBe(before);
    expect(head()).toBe(commit);
    expect(git(repo, "tag", "-l", "v0.*")).toBe("v0.1.0-beta.1");
  };

  for (const [v, message] of [
    ["0.1", /not a semver/],
    ["v0.1.0", /without the "v"/],
    ["0.0.9", /0\.1\.0 or later/],
    ["0.1.0-beta.1", /0\.1\.0 or later/],
  ] as const) {
    test(`a bad version (${v}) is refused before the gate, nothing written`, async () => {
      await refused([v], message);
      expect(gateRuns).toBe(0);
    });
  }

  test("an existing tag is refused", async () => {
    git(repo, "tag", "-a", "v0.2.0", "-m", "x");
    git(repo, "push", "-q", "origin", "v0.2.0");
    git(repo, "tag", "-d", "v0.2.0"); // only on origin: the fetch must see it
    const before = snapshot();
    expect(await runRelease(["0.2.0"], deps())).toBe(1);
    expect(out.join("")).toMatch(/tag v0\.2\.0 already exists/);
    expect(snapshot()).toBe(before);
  });

  test("a dirty tree is refused", async () => {
    writeFileSync(join(repo, "untracked.txt"), "x");
    await refused(["0.1.0"], /working tree is not clean/);
  });

  test("a branch other than main is refused", async () => {
    git(repo, "checkout", "-q", "-b", "feat/x");
    await refused(["0.1.0"], /on branch feat\/x, not main/);
  });

  test("main behind origin/main is refused (after a fetch)", async () => {
    const other = join(base, "other");
    git(base, "clone", "-q", join(base, "origin.git"), other);
    git(other, "config", "user.name", "T");
    git(other, "config", "user.email", "t@example.com");
    git(other, "config", "commit.gpgsign", "false");
    writeFileSync(join(other, "x.txt"), "x");
    git(other, "add", "x.txt");
    git(other, "commit", "-q", "-m", "ahead");
    git(other, "push", "-q", "origin", "main");
    await refused(["0.1.0"], /main is behind origin\/main by 1 commit/);
    expect(out.join("")).toContain("fetching origin");
  });

  test("an empty [Unreleased] is refused before the gate", async () => {
    writeFileSync(
      join(repo, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n## [0.1.0-beta.1] - 2026-10-21\n\nFirst.\n",
    );
    git(repo, "commit", "-q", "-am", "empty unreleased");
    git(repo, "push", "-q", "origin", "main");
    await refused(["0.1.0"], /\[Unreleased\] is empty/);
    expect(gateRuns).toBe(0);
  });

  test("a red gate aborts with nothing written", async () => {
    await refused(["0.1.0"], /gate failed/, {
      gate: async () => {
        gateRuns += 1;
        return false;
      },
    });
    expect(gateRuns).toBe(1);
  });

  test("--dry-run runs every check (gate included) and writes nothing", async () => {
    const before = snapshot();
    const commit = head();
    expect(await runRelease(["0.1.0", "--dry-run"], deps())).toBe(0);
    expect(gateRuns).toBe(1);
    expect(snapshot()).toBe(before);
    expect(head()).toBe(commit);
    expect(git(repo, "tag", "-l", "v0.1.0")).toBe("");
    const text = out.join("");
    expect(text).toContain("dry run");
    expect(text).toContain("packages/cli/package.json: 0.1.0-beta.1 → 0.1.0");
    expect(text).toContain("CHANGELOG.md: [Unreleased] → [0.1.0] - 2026-10-22");
    expect(text).toContain("chore(release): v0.1.0");
  });

  test("a failing commit restores every file and creates no tag", async () => {
    const hook = join(repo, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await refused(["0.1.0"], /commit failed/);
    expect(existsSync(hook)).toBe(true);
  });

  test("a tree changed by the gate is refused before anything is written", async () => {
    await refused(["0.1.0"], /the working tree changed while the gate ran/, {
      gate: async () => {
        writeFileSync(join(repo, "gate-artifact.txt"), "x");
        return true;
      },
    });
  });

  test("a tag that fails after the commit says how to finish or undo", async () => {
    // A stale ref lock makes `git tag` fail; the commit itself succeeds.
    mkdirSync(join(repo, ".git/refs/tags"), { recursive: true });
    writeFileSync(join(repo, ".git/refs/tags/v0.1.0.lock"), "");
    const before = head();
    expect(await runRelease(["0.1.0"], deps())).toBe(1);
    const sha = head();
    expect(sha).not.toBe(before); // committed
    expect(git(repo, "tag", "-l", "v0.1.0")).toBe("");
    expect(out.join("")).toContain(
      `committed ${sha}, tag failed: run git tag -a v0.1.0 -m 'tentacle v0.1.0' — or undo with git reset --hard HEAD~1`,
    );
  });

  test("usage errors", async () => {
    expect(await runRelease([], deps())).toBe(1);
    expect(await runRelease(["0.1.0", "--push"], deps())).toBe(1);
    expect(out.join("")).toContain("usage: bun run release <version> [--dry-run]");
  });
});
