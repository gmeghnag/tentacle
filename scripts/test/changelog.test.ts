import { describe, expect, test } from "bun:test";
import { assemble, parseFragments } from "../changelog.ts";
import { ReleaseError } from "../release-plan.ts";

/** A changelog whose `[Unreleased]` is empty: the only shape `assemble` accepts. */
const BASE =
  "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [0.1.0-beta.1] - 2026-10-21\n\nFirst.\n";

const frag = (slug: string, category: string, body = "- A thing.\n") => ({
  path: `changelog.d/${slug}.${category}.md`,
  text: body,
});

describe("parseFragments", () => {
  test("reads every category, sorted by (category order, slug)", () => {
    const out = parseFragments([
      frag("zeta", "fixed"),
      frag("beta", "added"),
      frag("alpha", "added"),
      frag("gamma", "changed"),
    ]);
    expect(out.map((f) => `${f.category}/${f.slug}`)).toEqual([
      "added/alpha",
      "added/beta",
      "changed/gamma",
      "fixed/zeta",
    ]);
    expect(out[0]?.body).toBe("- A thing.");
  });

  test("keeps a bullet's prose intact (only the outer whitespace goes)", () => {
    const out = parseFragments([frag("task-x", "added", "\n- **The headline.** The prose.\n\n")]);
    expect(out[0]?.body).toBe("- **The headline.** The prose.");
  });

  /** Each refusal, with the message the release script prints too. */
  const refuse = (path: string, text: string, message: RegExp) => {
    expect(() => parseFragments([{ path, text }])).toThrow(message);
    expect(() => parseFragments([{ path, text }])).toThrow(ReleaseError);
  };

  test("refuses a name that is not <slug>.<category>.md", () => {
    refuse("changelog.d/task-x.md", "- A thing.\n", /named <slug>\.<category>\.md/);
    refuse("changelog.d/task-x.added.txt", "- A thing.\n", /named <slug>\.<category>\.md/);
  });

  test("refuses a missing extension, and a subdirectory, by name", () => {
    // F1: these are what a `*.md` scan silently skipped.
    refuse("changelog.d/task-x.added", "- A thing.\n", /named <slug>\.<category>\.md/);
    refuse("changelog.d/sub/nested.added.md", "- A.\n", /no subdirectories/);
    // A directory entry, as `readFragmentDir` reports it (the file read would throw).
    expect(() => parseFragments([{ path: "changelog.d/sub", text: "", directory: true }])).toThrow(
      /no subdirectories/,
    );
  });

  test("refuses a category that is not one of the six", () => {
    refuse("changelog.d/task-x.misc.md", "- A thing.\n", /category must be one of added, changed/);
    refuse("changelog.d/task-x.Added.md", "- A thing.\n", /category must be one of/);
  });

  test("refuses a slug that is not lowercase letters, digits and dashes", () => {
    refuse("changelog.d/Task-x.added.md", "- A thing.\n", /slug must be lowercase/);
    refuse("changelog.d/task_x.added.md", "- A thing.\n", /slug must be lowercase/);
    refuse("changelog.d/-task.added.md", "- A thing.\n", /slug must be lowercase/);
  });

  test("refuses an empty body", () => {
    refuse("changelog.d/task-x.added.md", "", /fragment is empty/);
    refuse("changelog.d/task-x.added.md", "\n  \n", /fragment is empty/);
  });

  test("refuses a body that is not a '- ' bullet", () => {
    refuse("changelog.d/task-x.added.md", "A thing.\n", /must start with "- "/);
  });

  test("refuses a heading: the filename, not a '### line', names the category", () => {
    refuse("changelog.d/task-x.added.md", "- A.\n\n### Fixed\n\n- B.\n", /has a heading/);
  });

  test("refuses a second bullet: one entry per file", () => {
    refuse("changelog.d/task-x.added.md", "- A.\n- B.\n", /one bullet per file/);
  });
});

describe("assemble", () => {
  const fragments = parseFragments([
    frag("task-b", "fixed", "- **B is fixed.**\n"),
    frag("task-a", "added", "- **A lands.**\n"),
    frag("task-c", "added", "- **C lands.**\n"),
  ]);

  test("one new version section, categories in Keep a Changelog order, slugs alphabetical", () => {
    expect(assemble(BASE, "0.2.0", "2026-11-13", fragments)).toBe(
      "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-13\n\n### Added\n\n- **A lands.**\n- **C lands.**\n\n### Fixed\n\n- **B is fixed.**\n\n## [0.1.0-beta.1] - 2026-10-21\n\nFirst.\n",
    );
  });

  test("[Unreleased] stays empty, and the released sections are untouched", () => {
    const base = `${BASE}\n## [0.0.9] - 2026-10-01\n\n### Fixed\n\n- Old.\n`;
    const out = assemble(base, "0.2.0", "2026-11-13", fragments);
    expect(out.slice(out.indexOf("## [Unreleased]"), out.indexOf("## [0.2.0]"))).toBe(
      "## [Unreleased]\n\n",
    );
    expect(out).toContain("\n## [0.0.9] - 2026-10-01\n\n### Fixed\n\n- Old.\n");
  });

  test("same input ⇒ same bytes (a re-run of a release produces no diff)", () => {
    const once = assemble(BASE, "0.2.0", "2026-11-13", fragments);
    const shuffled = [...fragments].reverse();
    expect(assemble(BASE, "0.2.0", "2026-11-13", shuffled)).toBe(once);
    expect(assemble(BASE, "0.2.0", "2026-11-13", fragments)).toBe(once);
  });

  test("refuses a non-empty [Unreleased]: entries belong in changelog.d/", () => {
    const dirty = BASE.replace(
      "## [Unreleased]\n\n",
      "## [Unreleased]\n\n### Added\n\n- **A hand-written bullet.**\n\n",
    );
    expect(() => assemble(dirty, "0.2.0", "2026-11-13", fragments)).toThrow(
      /\[Unreleased\] has entries; they belong in changelog\.d\/<slug>\.<category>\.md/,
    );
  });

  test("refuses a changelog with no [Unreleased] section", () => {
    expect(() =>
      assemble("# Changelog\n\n## [0.1.0] - x\n", "0.2.0", "2026-11-13", fragments),
    ).toThrow(/no "## \[Unreleased\]"/);
  });

  test("rewrites GitHub compare links when present", () => {
    const links =
      "\n[Unreleased]: https://github.com/o/r/compare/v0.1.0-beta.1...HEAD\n[0.1.0-beta.1]: https://github.com/o/r/releases/tag/v0.1.0-beta.1\n";
    const out = assemble(`${BASE}${links}`, "0.2.0", "2026-11-13", fragments);
    expect(out).toContain("[Unreleased]: https://github.com/o/r/compare/v0.2.0...HEAD\n");
    expect(out).toContain(
      "[0.2.0]: https://github.com/o/r/compare/v0.1.0-beta.1...v0.2.0\n[0.1.0-beta.1]:",
    );
  });
});
