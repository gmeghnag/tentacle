import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAGMENT_DIR, type Fragment, parseFragments, readFragmentDir } from "../changelog.ts";

/**
 * A fragment that retracts what a SIBLING of the same release only just added: a
 * non-`added` entry whose slug extends another entry's slug (`tui-mascot` vs
 * `tui-mascot-hidden`). Both land in one version, so the notes advertise a
 * feature and then say it is hidden — a change away from a state no release ever
 * had. The fix belongs in the `.added` bullet, which must describe what ships.
 */
function retractions(fragments: readonly Fragment[]): string[] {
  const slugs = new Set(fragments.map((f) => f.slug));
  const sibling = (f: Fragment): boolean =>
    [...slugs].some((s) => s !== f.slug && f.slug.startsWith(`${s}-`));
  return fragments.filter((f) => f.category !== "added" && sibling(f)).map((f) => f.path);
}

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

describe("I3: an unreleased fragment does not retract a sibling's addition", () => {
  // R1 (fix round 1): `tui-mascot-hidden.changed` said the header "no longer
  // draws the mascot" while `tui-mascot.added` — unreleased too — advertised it.
  // One release, both bullets: a feature nobody could have seen, then its removal.
  test("the tree has no such pair (a changed entry shadowing a sibling's added one)", () => {
    expect(retractions(parseFragments(readFragmentDir(ROOT)))).toEqual([]);
  });

  test("the same check over the offending pair is red (non-vacuity)", () => {
    const pair = parseFragments([
      {
        path: `${FRAGMENT_DIR}/tui-mascot.added.md`,
        text: "- **Polpetto in the startup header.** Beside it sits a pixel mascot.\n",
      },
      {
        path: `${FRAGMENT_DIR}/tui-mascot-hidden.changed.md`,
        text: "- **The startup header no longer draws the mascot.**\n",
      },
    ]);
    expect(retractions(pair)).toEqual([`${FRAGMENT_DIR}/tui-mascot-hidden.changed.md`]);
    // An unrelated slug is never a sibling, and an `added` bullet is never a retraction.
    expect(
      retractions(
        parseFragments([
          {
            path: `${FRAGMENT_DIR}/tui-mascot.added.md`,
            text: "- **Polpetto in the startup header.**\n",
          },
          { path: `${FRAGMENT_DIR}/other-task.added.md`, text: "- **Something else.**\n" },
          { path: `${FRAGMENT_DIR}/other-task.fixed.md`, text: "- **A regular fix.**\n" },
        ]),
      ),
    ).toEqual([]);
  });
});
