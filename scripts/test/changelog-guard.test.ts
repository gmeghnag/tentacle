import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FRAGMENT_DIR, parseFragments } from "../changelog.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const FRAGMENTS = join(ROOT, FRAGMENT_DIR);

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

describe("I2: every changelog.d/ file is a well-formed fragment", () => {
  /** Every fragment file on disk; a missing directory is the normal post-release state. */
  const files = (): { path: string; text: string }[] => {
    const names = (() => {
      try {
        return readdirSync(FRAGMENTS).filter((n) => n.endsWith(".md"));
      } catch {
        return []; // no changelog.d/: a release emptied it, or nothing is in flight
      }
    })();
    return names.map((n) => ({
      path: `${FRAGMENT_DIR}/${n}`,
      text: readFileSync(join(FRAGMENTS, n), "utf8"),
    }));
  };

  test("the directory on disk parses (vacuously, after a release)", () => {
    expect(() => parseFragments(files())).not.toThrow();
  });

  test("the same check over a bad file is red (non-vacuity of the scan above)", () => {
    expect(() =>
      parseFragments([{ path: `${FRAGMENT_DIR}/Task_x.md`, text: "not a bullet\n" }]),
    ).toThrow();
  });
});
