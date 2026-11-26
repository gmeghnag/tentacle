/**
 * `bun run badges` — measure line coverage and the passing-test count, and
 * rewrite the README's two badges (docs/feat/coverage-badges.md). `bun run
 * release` calls the same measurement, so the badges are refreshed with every
 * release and the numbers never come from a hand edit.
 *
 * The coverage is the HONEST one: bun's lcov lists only the files some test
 * imported, so a source file no test loads (today: the React Native screens,
 * covered by the simulator e2e instead) would silently drop out of the
 * denominator. Here every tracked source file counts; one with no lcov record
 * counts its code lines (neither blank nor comment) as uncovered.
 *
 * The rules are pure functions (tested in scripts/test/coverage-badges.test.ts);
 * {@link measureRepo} is the shell around them (git, the test run).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const BADGES_START = "<!-- quality-badges:start -->";
export const BADGES_END = "<!-- quality-badges:end -->";

/** One file's lcov line counts. */
export interface LineCounts {
  readonly found: number;
  readonly hit: number;
}

/**
 * Parse an lcov file into per-file line counts. A file reported more than once
 * (one record per test worker) keeps the record with the most lines hit.
 */
export function parseLcov(text: string): Map<string, LineCounts> {
  const files = new Map<string, LineCounts>();
  let file: string | undefined;
  let found = 0;
  let hit = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      file = line.slice(3);
      found = 0;
      hit = 0;
    } else if (line.startsWith("LF:")) {
      found = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      hit = Number(line.slice(3));
    } else if (line === "end_of_record" && file !== undefined) {
      const prev = files.get(file);
      if (prev === undefined || hit > prev.hit) {
        files.set(file, { found, hit });
      }
      file = undefined;
    }
  }
  return files;
}

/** Lines that are neither blank nor a comment: the denominator of a file no test loads. */
export function codeLines(text: string): number {
  return text.split("\n").filter((raw) => {
    const line = raw.trim();
    return !(
      line === "" ||
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("*") ||
      line.startsWith("*/")
    );
  }).length;
}

/** The measured coverage of the source files. */
export interface Coverage {
  readonly covered: number;
  readonly total: number;
  /** Rounded DOWN: a badge never claims more than was measured. */
  readonly percent: number;
}

/** Coverage of exactly `sources`: lcov's counts where it has them, else every code line uncovered. */
export function measureCoverage(
  lcov: ReadonlyMap<string, LineCounts>,
  sources: readonly { readonly path: string; readonly text: string }[],
): Coverage {
  let covered = 0;
  let total = 0;
  for (const { path, text } of sources) {
    const counts = lcov.get(path);
    if (counts === undefined) {
      total += codeLines(text);
    } else {
      covered += counts.hit;
      total += counts.found;
    }
  }
  if (total === 0) {
    throw new Error("no source lines to measure");
  }
  return { covered, total, percent: Math.floor((100 * covered) / total) };
}

/** The passing-test count from bun's summary; a run with a failure is refused. */
export function parseTestCount(output: string): number {
  const pass = /^\s*(\d+) pass$/m.exec(output);
  if (pass === null) {
    throw new Error("no test summary in the output of the test run");
  }
  const fail = Number(/^\s*(\d+) fail$/m.exec(output)?.[1] ?? "0");
  if (fail > 0) {
    throw new Error(`${fail} test${fail === 1 ? "" : "s"} failed: fix the suite first`);
  }
  return Number(pass[1]);
}

const shield = (label: string, message: string, color: string) =>
  `https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(message)}-${color}`;

/** The two README badges. The number is in the text: the colour never says it alone. */
export function renderBadges({ percent, tests }: { percent: number; tests: number }): string {
  const color = percent >= 90 ? "brightgreen" : percent >= 80 ? "green" : "yellow";
  const count = tests.toLocaleString("en-US");
  return [
    `  <img alt="coverage ${percent}%" src="${shield("coverage", `${percent}%`, color)}">`,
    `  <img alt="tests: ${count} passing" src="${shield("tests", `${count} passing`, "brightgreen")}">`,
  ].join("\n");
}

/** `readme` with the block between the markers replaced by `block`. */
export function withBadges(readme: string, block: string): string {
  const start = readme.indexOf(BADGES_START);
  const end = readme.indexOf(BADGES_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      `README.md needs ${BADGES_START} then ${BADGES_END} (a missing or misordered marker)`,
    );
  }
  return `${readme.slice(0, start + BADGES_START.length)}\n${block}\n${readme.slice(end)}`;
}

/** Tracked source files: `packages/*\/src` and `apps/*\/src`, TypeScript, no `.d.ts`. */
function sourceFiles(root: string): string[] {
  const proc = Bun.spawnSync(["git", "ls-files", "--", "packages/*/src/**", "apps/*/src/**"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout
    .toString()
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"));
}

/**
 * Run the whole suite once with coverage (the same parallel runner as `bun run
 * test`) and return the badge block. Throws on a failed run.
 */
export async function measureRepo(root: string): Promise<{ block: string; summary: string }> {
  const dir = mkdtempSync(join(tmpdir(), "tentacle-coverage-"));
  try {
    const proc = Bun.spawn(
      [
        "bun",
        "test",
        "--parallel",
        "--coverage",
        "--coverage-reporter=lcov",
        // Coverage instrumentation slows the subprocess-heavy CLI tests past
        // bun's 5 s default on a loaded machine; a timeout is not a failure here.
        "--timeout=30000",
        `--coverage-dir=${dir}`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const all = `${out}\n${err}`;
    let tests: number;
    try {
      tests = parseTestCount(all);
    } catch (error) {
      // Name the failures: "1 test failed" alone sends you to rerun the suite.
      const failed = all.split("\n").filter((l) => l.startsWith("(fail)") || l.includes("✗ "));
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${failed.length > 0 ? `\n${failed.join("\n")}` : ""}`,
      );
    }
    if (code !== 0) {
      throw new Error(`the coverage run exited ${code}`);
    }
    const lcov = parseLcov(readFileSync(join(dir, "lcov.info"), "utf8"));
    const sources = sourceFiles(root).map((path) => ({
      path,
      text: readFileSync(join(root, path), "utf8"),
    }));
    const coverage = measureCoverage(lcov, sources);
    return {
      block: renderBadges({ percent: coverage.percent, tests }),
      summary: `coverage ${coverage.percent}% (${coverage.covered}/${coverage.total} lines), ${tests} tests passing`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  try {
    process.stdout.write("badges: running the suite with coverage…\n");
    const { block, summary } = await measureRepo(root);
    const path = join(root, "README.md");
    const before = readFileSync(path, "utf8");
    const after = withBadges(before, block);
    if (after !== before) {
      writeFileSync(path, after);
    }
    process.stdout.write(
      `badges: ${summary}${after === before ? " (README unchanged)" : " → README.md"}\n`,
    );
  } catch (error) {
    process.stderr.write(`badges: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
