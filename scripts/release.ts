/**
 * `bun run release <version> [--dry-run]` (docs/RELEASING.md,
 * docs/feat/release-script.md, D7): bump every package.json (+ bun.lock),
 * assemble `CHANGELOG.md`'s new section from `changelog.d/` and delete the
 * fragments, commit `chore(release): v<version>` and create the annotated tag
 * `v<version>`. It NEVER pushes: it prints the two push commands. The rules are
 * in `changelog.ts` + `release-plan.ts`; this is the shell around them (git, the
 * gate, the writes).
 *
 * Order: arguments → clean tree on `main` → fetch, not behind origin → the
 * version (incl. tags on origin) → every new file text computed (and the
 * fragments validated, so no release starts with a bad fragment) → the gate
 * (`bun run check`) → writes + fragment deletion → commit → tag. Anything
 * refused before the writes leaves the repo exactly as it was.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FRAGMENT_DIR, type Fragment, assemble, parseFragments } from "./changelog.ts";
import {
  ReleaseError,
  bumpBunLock,
  bumpPackageJson,
  parseReleaseVersion,
  refuseUnreleasedEntries,
} from "./release-plan.ts";

const USAGE = "usage: bun run release <version> [--dry-run]   (e.g. bun run release 0.1.0)";

export interface ReleaseDeps {
  /** The repo root. */
  readonly root: string;
  /** The full gate (`bun run check`); resolves `true` when green. Injected in tests. */
  readonly gate: () => Promise<boolean>;
  /** Today's date as `YYYY-MM-DD` (the CHANGELOG heading). */
  readonly today: () => string;
  readonly write: (text: string) => void;
}

function git(root: string, ...args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: proc.stdout.toString().trim(), err: proc.stderr.toString() };
}

function gitOk(root: string, ...args: string[]): string {
  const r = git(root, ...args);
  if (r.code !== 0) {
    throw new ReleaseError(`git ${args.join(" ")} failed: ${r.err.trim()}`);
  }
  return r.out;
}

const versionOf = (text: string): string | undefined =>
  /^ {2}"version": "([^"]*)"/m.exec(text)?.[1];

/** Run the release; returns the exit code. */
export async function runRelease(argv: readonly string[], deps: ReleaseDeps): Promise<number> {
  const write = deps.write;
  const dryRun = argv.includes("--dry-run");
  const positional = argv.filter((a) => a !== "--dry-run");
  if (positional.length !== 1 || positional[0]?.startsWith("-")) {
    write(`${USAGE}\n`);
    return 1;
  }
  const root = deps.root;
  try {
    // 1) A clean tree, on main, not behind origin/main.
    const dirty = gitOk(root, "status", "--porcelain");
    if (dirty !== "") {
      throw new ReleaseError(`the working tree is not clean:\n${dirty}`);
    }
    const branch = gitOk(root, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "main") {
      throw new ReleaseError(`on branch ${branch}, not main: releases are cut from main`);
    }
    write("fetching origin (branches and tags)…\n");
    gitOk(root, "fetch", "--quiet", "--tags", "origin");
    const behind = Number(gitOk(root, "rev-list", "--count", "main..origin/main"));
    if (behind > 0) {
      throw new ReleaseError(
        `main is behind origin/main by ${behind} commit${behind === 1 ? "" : "s"}: git pull first`,
      );
    }

    // 2) The version: every package.json agrees on the current one.
    const files = [
      "package.json",
      ...[...new Bun.Glob("packages/*/package.json").scanSync({ cwd: root })].sort(),
    ];
    const texts = new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));
    const current = versionOf(texts.get("packages/cli/package.json") ?? "");
    if (!current) {
      throw new ReleaseError("packages/cli/package.json has no version");
    }
    const stray = files.filter((f) => versionOf(texts.get(f) ?? "") !== current);
    if (stray.length > 0) {
      throw new ReleaseError(`versions out of sync with ${current}: ${stray.join(", ")}`);
    }
    const tags = gitOk(root, "tag", "-l").split("\n").filter(Boolean);
    const { version, tag } = parseReleaseVersion(positional[0] ?? "", current, tags);

    // 3) Every new file text, computed before anything is written.
    const date = deps.today();
    const planned = new Map<string, string>();
    for (const f of files) {
      planned.set(f, bumpPackageJson(texts.get(f) ?? "", version));
    }
    const lock = readFileSync(join(root, "bun.lock"), "utf8");
    planned.set("bun.lock", bumpBunLock(lock, current, version, files.length - 1));
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const fragmentFiles = [...new Bun.Glob(`${FRAGMENT_DIR}/*.md`).scanSync({ cwd: root })]
      .sort()
      .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
    if (fragmentFiles.length === 0) {
      throw new ReleaseError(
        `${FRAGMENT_DIR}/ has no fragments; a release needs at least one user-visible entry (AGENTS §10)`,
      );
    }
    const fragments = parseFragments(fragmentFiles);
    refuseUnreleasedEntries(changelog);
    planned.set("CHANGELOG.md", assemble(changelog, version, date, fragments));

    // 4) The gate.
    write("running the gate (bun run check)…\n");
    if (!(await deps.gate())) {
      throw new ReleaseError("the gate failed (bun run check): fix it, then release");
    }
    // The gate must not have changed the tree (a formatter, a generated file):
    // the release commit would silently miss or include it.
    const after = gitOk(root, "status", "--porcelain");
    if (after !== "") {
      throw new ReleaseError(`the working tree changed while the gate ran:\n${after}`);
    }

    const message = `chore(release): ${tag}\n`;
    const summary = [
      ...files.map((f) => `  ${f}: ${current} → ${version}`),
      `  bun.lock: ${files.length - 1} workspace versions ${current} → ${version}`,
      `  CHANGELOG.md: ${fragments.length} fragment${fragments.length === 1 ? "" : "s"} → [${version}] - ${date} ([Unreleased] stays empty)`,
      `  ${FRAGMENT_DIR}/: ${fragments.length} fragment${fragments.length === 1 ? "" : "s"} deleted`,
      `  commit: chore(release): ${tag}`,
      `  tag: ${tag} (annotated)`,
    ].join("\n");
    if (dryRun) {
      // The human preview that replaces reading [Unreleased] on main: the exact
      // section the release would add, built by the same pure function.
      const preview = assemble(changelog, version, date, fragments);
      const from = preview.indexOf(`## [${version}]`);
      const to = preview.slice(from).search(/\n## \[/);
      const section = to < 0 ? preview.slice(from) : preview.slice(from, from + to);
      write(
        `dry run: all checks passed; nothing written. Planned:\n${summary}\n\nThe section it would add:\n\n${section}\n`,
      );
      return 0;
    }

    // 5) Write, commit, tag. A failed commit restores the originals — including
    // the fragments, whose DELETION is not a write and so needs its own restore.
    const originals = new Map([...texts, ["bun.lock", lock], ["CHANGELOG.md", changelog]]);
    for (const [f, text] of planned) {
      writeFileSync(join(root, f), text);
    }
    const deleted = fragments.map((f) => f.path);
    for (const path of deleted) {
      rmSync(join(root, path), { force: true });
    }
    // The tag CI checks (build.yml) is `v` + packages/cli/package.json version.
    const written = versionOf(readFileSync(join(root, "packages/cli/package.json"), "utf8"));
    if (`v${written}` !== tag) {
      throw new ReleaseError(
        `internal: packages/cli/package.json reads ${written}, not ${version}`,
      );
    }
    /**
     * Stage the fragments' deletion (they are not in `planned`, which holds
     * writes only) and confirm the index really records each one — a `git add`
     * that silently staged nothing would leave the release commit adding an
     * entry it also wrote into CHANGELOG.md.
     */
    const stageDeletions = (): { code: number; out: string; err: string } => {
      const staged = git(root, "add", "-A", "--", FRAGMENT_DIR);
      if (staged.code !== 0) {
        return staged;
      }
      const index = git(root, "diff", "--cached", "--name-status", "--", FRAGMENT_DIR).out;
      const missing = deleted.filter((path) => !index.split("\n").includes(`D\t${path}`));
      return missing.length === 0
        ? staged
        : { code: 1, err: `the deletion of ${missing.join(", ")} was not staged`, out: "" };
    };
    const commit = (() => {
      const add = git(root, "add", "--", ...planned.keys());
      if (add.code !== 0) {
        return add;
      }
      // A fragment still staged (not committed away) would leave the release
      // commit adding an entry it also wrote into CHANGELOG.md: twice.
      const st = stageDeletions();
      return st.code === 0 ? git(root, "commit", "--quiet", "-m", message) : st;
    })();
    if (commit.code !== 0) {
      for (const [f, text] of originals) {
        writeFileSync(join(root, f), text);
      }
      for (const { path, text } of fragmentFiles) {
        writeFileSync(join(root, path), text);
      }
      git(root, "reset", "--quiet", "--", ...planned.keys(), FRAGMENT_DIR);
      throw new ReleaseError(`the commit failed, files restored: ${commit.err.trim()}`);
    }
    const tagged = git(root, "tag", "-a", tag, "-m", `tentacle ${tag}`);
    if (tagged.code !== 0) {
      const sha = gitOk(root, "rev-parse", "HEAD");
      throw new ReleaseError(
        `committed ${sha}, tag failed: run git tag -a ${tag} -m 'tentacle ${tag}' — or undo with git reset --hard HEAD~1\n${tagged.err.trim()}`,
      );
    }

    write(
      `released ${tag} locally:\n${summary}\n\nNothing was pushed. To publish:\n  git push origin main && git push origin ${tag}\n\nCI (.github/workflows/build.yml) then builds the four binaries, checks that ${tag} matches packages/cli/package.json, and publishes the GitHub release with SHA256SUMS${version.includes("-") ? " (as a pre-release: the version has a pre-release suffix)" : ' (it becomes "latest", which `tentacle update` installs)'}.\n`,
    );
    return 0;
  } catch (error) {
    write(`release: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const code = await runRelease(process.argv.slice(2), {
    root,
    gate: async () => {
      const proc = Bun.spawn(["bun", "run", "check"], {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
      });
      return (await proc.exited) === 0;
    },
    today: () => localDate(),
    write: (text) => process.stdout.write(text),
  });
  process.exit(code);
}
