/**
 * The pure rules of per-task changelog fragments (docs/feat/changelog-fragments.md):
 * what a fragment is, and how a release assembles `changelog.d/` into a new
 * version section. No I/O for the rules themselves; the one disk read is
 * `readFragmentDir`, shared by the release and the guard so they cannot diverge
 * on which entries count (F1: a filter in either one silently dropped a fragment).
 *
 * A fragment is one file, one bullet, named `<slug>.<category>.md` — the task
 * slug, so it rides that task's branch and dies with an abandoned one. Two tasks
 * never share a path, so two tasks never edit one shared line.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ReleaseError, refuseUnreleasedEntries } from "./release-plan.ts";

/** Keep a Changelog's sections, in the order they appear in a release. */
export const CATEGORY_ORDER = [
  "added",
  "changed",
  "deprecated",
  "removed",
  "fixed",
  "security",
] as const;

export type Category = (typeof CATEGORY_ORDER)[number];

/** The directory a fragment lives in (repo-relative). */
export const FRAGMENT_DIR = "changelog.d";

/** A task slug: lowercase letters, digits and dashes, not starting with a dash. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The heading that ends an `[Unreleased]` body (a release section, or a link block). */
const SECTION_END = /^(## |\[[^\]]+\]: )/m;

const UNRELEASED = /^## \[Unreleased\][ \t]*$/m;

/** One validated fragment: the file it came from, plus the bullet to insert. */
export interface Fragment {
  readonly path: string;
  readonly slug: string;
  readonly category: Category;
  readonly body: string;
}

/** A fragment file as read from disk (`path` is repo-relative). */
export interface FragmentFile {
  readonly path: string;
  readonly text: string;
  /** Set when the entry is a directory: refused by name (`readFragmentDir`). */
  readonly directory?: boolean;
}

/**
 * Read EVERY entry in `<root>/changelog.d/` — files and directories, dotfiles
 * included — as fragment candidates. The name check is `parseFragments`'s, not a
 * glob's: a `*.md` filter would never parse `lost-task.added` or
 * `sub/nested.md`, so both would be left out of the notes and never deleted, and
 * nothing would go red (F1). A directory is returned with empty text so the
 * parser refuses it by name, one message for one offence.
 *
 * A missing `changelog.d/` is the normal post-release state: no fragments.
 */
export function readFragmentDir(root: string): FragmentFile[] {
  const dir = join(root, FRAGMENT_DIR);
  const names = (() => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return []; // no changelog.d/: a release emptied it, or nothing is in flight
    }
  })();
  return names
    .map((entry) => ({ path: `${FRAGMENT_DIR}/${entry.name}`, full: join(dir, entry.name) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, full }) =>
      statSync(full).isDirectory()
        ? { path, text: "", directory: true }
        : { path, text: readFileSync(full, "utf8") },
    );
}

/** Validate one fragment file; throws `ReleaseError` naming the offence. */
function parseFragment({ path, text, directory }: FragmentFile): Fragment {
  const name = path.startsWith(`${FRAGMENT_DIR}/`) ? path.slice(FRAGMENT_DIR.length + 1) : "";
  if (directory === true || name.includes("/")) {
    throw new ReleaseError(
      `${path}: ${FRAGMENT_DIR}/ holds fragment files only, no subdirectories`,
    );
  }
  const stem = name.endsWith(".md") ? name.slice(0, -".md".length) : "";
  if (stem === "" || !stem.includes(".")) {
    throw new ReleaseError(
      `${path}: a fragment is named <slug>.<category>.md (e.g. my-task.added.md)`,
    );
  }
  const dot = stem.lastIndexOf(".");
  const slug = stem.slice(0, dot);
  const category = stem.slice(dot + 1);
  if (!(CATEGORY_ORDER as readonly string[]).includes(category)) {
    throw new ReleaseError(
      `${path}: category must be one of ${CATEGORY_ORDER.join(", ")} (got ${JSON.stringify(category)})`,
    );
  }
  if (!SLUG.test(slug)) {
    throw new ReleaseError(
      `${path}: slug must be lowercase letters, digits and dashes (got ${JSON.stringify(slug)})`,
    );
  }
  const body = text.trim();
  if (body === "") {
    throw new ReleaseError(`${path}: fragment is empty; it holds one "- " bullet`);
  }
  const lines = body.split("\n");
  if (!body.startsWith("- ")) {
    throw new ReleaseError(`${path}: a fragment's body must start with "- " (a bullet)`);
  }
  if (lines.some((line) => /^#{1,6}\s/.test(line))) {
    throw new ReleaseError(
      `${path}: a fragment has a heading; the filename names the category, not a "### " line`,
    );
  }
  if (lines.filter((line) => line.startsWith("- ")).length > 1) {
    throw new ReleaseError(`${path}: one bullet per file; split it into two fragments`);
  }
  return { path, slug, category: category as Category, body };
}

/**
 * Validate every fragment and sort them by (category order, slug), so the
 * assembled section is a pure function of the set: two runs produce the same
 * bytes, and a fragment's file order on disk cannot matter.
 */
/** Category order, then slug, then path: the one order a release section uses. */
const byCategoryThenSlug = (a: Fragment, b: Fragment): number =>
  CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
  (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0) ||
  (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function parseFragments(files: readonly FragmentFile[]): Fragment[] {
  return files.map(parseFragment).sort(byCategoryThenSlug);
}

/** `added` → `Added`: the section heading Keep a Changelog uses. */
const title = (category: Category): string => category[0]?.toUpperCase() + category.slice(1);

/**
 * Build the release text: a NEW `## [<version>] - <date>` section, grouped by
 * category in Keep a Changelog order, directly below an `[Unreleased]` that
 * stays empty. Released sections are never touched.
 *
 * A non-empty `[Unreleased]` is a refusal, not input: entries belong in
 * `changelog.d/`, and accepting them here would restore the shared append point
 * (and the silent mis-filing) this design removes.
 */
export function assemble(
  text: string,
  version: string,
  date: string,
  fragments: readonly Fragment[],
): string {
  // One rule, one message, one home (release-plan.ts): a non-empty [Unreleased]
  // is a refusal, not input, so this accepts an empty one and nothing else.
  refuseUnreleasedEntries(text);
  const match = UNRELEASED.exec(text);
  if (!match) {
    throw new ReleaseError('CHANGELOG.md has no "## [Unreleased]" section');
  }
  const bodyStart = match.index + match[0].length;
  const rest = text.slice(bodyStart);
  const end = rest.search(SECTION_END);
  // The body is blank (refused above), so only its whitespace is skipped.
  const after = (end < 0 ? "" : rest.slice(end)).replace(/^\n+/, "");

  const ordered = [...fragments].sort(byCategoryThenSlug);
  const sections = CATEGORY_ORDER.map((category) => {
    const bullets = ordered.filter((f) => f.category === category).map((f) => f.body);
    return bullets.length === 0 ? "" : `\n### ${title(category)}\n\n${bullets.join("\n")}\n`;
  }).join("");

  const tail = after === "" ? "" : `\n${after}`;
  let out = `${text.slice(0, match.index)}## [Unreleased]\n\n## [${version}] - ${date}\n${sections}${tail}`;
  out = out.replace(
    /^\[Unreleased\]: (https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\/compare\/(\S+)\.\.\.HEAD$/m,
    (_m, base: string, previous: string) =>
      `[Unreleased]: ${base}/compare/v${version}...HEAD\n[${version}]: ${base}/compare/${previous}...v${version}`,
  );
  return out;
}
