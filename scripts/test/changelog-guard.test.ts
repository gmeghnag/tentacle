import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAGMENT_DIR, parseFragments, readFragmentDir } from "../changelog.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

/** The text an `[Unreleased]` heading holds, up to the next top-level heading. */
function unreleasedBody(text: string): string {
  const heading = /^## \[Unreleased\][ \t]*$/m.exec(text);
  if (!heading) {
    throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  }
  const rest = text.slice(heading.index + heading[0].length);
  const end = rest.search(/^(## |\[[^\]]+\]: )/m);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("I1: [Unreleased] is empty in the tree", () => {
  test("no task writes into [Unreleased]; the release builds the section from changelog.d/", () => {
    const body = unreleasedBody(readFileSync(CHANGELOG, "utf8"));
    expect(body.trim()).toBe("");
  });

  test("the assertion is not vacuous: a fixture with an entry under [Unreleased] is not empty", () => {
    // The same reader, over text that DOES hold an entry (what a hand edit looks
    // like), so the check above cannot pass merely because the file is short.
    const handEdited = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- **A task's bullet.**\n";
    expect(unreleasedBody(handEdited).trim()).toBe("### Added\n\n- **A task's bullet.**");
  });
});

describe("I2: every entry in changelog.d/ is a well-formed fragment", () => {
  test("the directory on disk parses (vacuously, after a release)", () => {
    expect(() => parseFragments(readFragmentDir(ROOT))).not.toThrow();
  });

  test("the same check over a bad file is red (non-vacuity of the scan above)", () => {
    expect(() =>
      parseFragments([{ path: `${FRAGMENT_DIR}/Task_x.md`, text: "not a bullet\n" }]),
    ).toThrow();
  });

  // F1: the scan is the only way a name reaches the parser, so it must list every
  // entry — a `*.md` filter made a misnamed fragment invisible and green.
  test("the scan lists every entry: no extension, a subdirectory, a dotfile", () => {
    const dir = mkdtempSync(join(tmpdir(), "tentacle-fragments-"));
    try {
      mkdirSync(join(dir, FRAGMENT_DIR, "sub"), { recursive: true });
      for (const rel of ["ok.added.md", "lost-task.added", ".DS_Store"]) {
        writeFileSync(join(dir, FRAGMENT_DIR, rel), "- A thing.\n");
      }
      expect(readFragmentDir(dir).map((f) => f.path)).toEqual([
        `${FRAGMENT_DIR}/.DS_Store`,
        `${FRAGMENT_DIR}/lost-task.added`,
        `${FRAGMENT_DIR}/ok.added.md`,
        `${FRAGMENT_DIR}/sub`,
      ]);
      // …and the scan+parse pair refuses each bad shape, so listing them is
      // enough to go red in `bun run test`.
      expect(() => parseFragments(readFragmentDir(dir))).toThrow(
        /changelog\.d\/\.DS_Store: a fragment is named <slug>\.<category>\.md/,
      );
      for (const [path, text] of [
        [`${FRAGMENT_DIR}/lost-task.added`, "- A thing.\n"],
        [`${FRAGMENT_DIR}/.DS_Store`, "- A thing.\n"],
      ] as const) {
        expect(() => parseFragments([{ path, text }])).toThrow(/named <slug>\.<category>\.md/);
      }
      expect(() =>
        parseFragments([{ path: `${FRAGMENT_DIR}/sub`, text: "", directory: true }]),
      ).toThrow(/no subdirectories/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
