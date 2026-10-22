/**
 * The pure rules of `bun run release <version>` (docs/feat/release-script.md,
 * D7): which versions are allowed and how each released file is rewritten.
 * No I/O; `release.ts` runs git, the gate and the writes around it.
 *
 * Every rewrite is a targeted text edit (never a JSON re-serialize), so the
 * files keep their exact formatting and Biome stays clean.
 */
import { compareVersions } from "../packages/cli/src/update-plan.ts";

/** A refusal: the script prints it and exits 1. */
export class ReleaseError extends Error {
  override readonly name = "ReleaseError";
}

/** The first version a release may have (pre-0.1.0 builds carry no version marker). */
export const MIN_RELEASE_VERSION = "0.1.0";

/** semver.org's official 2.0.0 regex (no leading zeros, non-empty identifiers). */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Validate the requested version: strict semver given WITHOUT the `v` (the
 * script adds it to the tag), ≥ 0.1.0, > `current`, and `v<version>` not
 * already in `tags`.
 */
export function parseReleaseVersion(
  input: string,
  current: string,
  tags: readonly string[],
): { version: string; tag: string } {
  if (/^v\d/.test(input)) {
    throw new ReleaseError(
      `give the version without the "v" (${input.slice(1)}): the tag gets the "v" itself`,
    );
  }
  if (!SEMVER.test(input)) {
    throw new ReleaseError(`${JSON.stringify(input)} is not a semver version (e.g. 0.1.0)`);
  }
  if (compareVersions(input, MIN_RELEASE_VERSION) < 0) {
    throw new ReleaseError(`a release must be ${MIN_RELEASE_VERSION} or later (got ${input})`);
  }
  if (compareVersions(input, current) <= 0) {
    throw new ReleaseError(`${input} must be greater than the current ${current}`);
  }
  const tag = `v${input}`;
  if (tags.includes(tag)) {
    throw new ReleaseError(`tag ${tag} already exists`);
  }
  return { version: input, tag };
}

/** Replace the top-level (2-space indented) `"version"` value, exactly once. */
export function bumpPackageJson(text: string, to: string): string {
  const line = /^ {2}"version": "[^"]*"(,?)$/gm;
  const hits = text.match(line)?.length ?? 0;
  if (hits !== 1) {
    throw new ReleaseError(`no top-level "version" line to bump (found ${hits})`);
  }
  return text.replace(line, (_m, comma: string) => `  "version": "${to}"${comma}`);
}

/**
 * Bump the workspace versions in `bun.lock`. `bun install --frozen-lockfile`
 * passes without it, but a plain `bun install` rewrites these entries, which
 * would dirty the tree right after the release; so the lock moves with the
 * package.json files in the release commit.
 * Only the `"workspaces"` block is touched, and it must hold exactly
 * `expected` entries at `from`.
 */
export function bumpBunLock(text: string, from: string, to: string, expected: number): string {
  const split = text.indexOf('\n  "packages": {');
  const head = split < 0 ? text : text.slice(0, split);
  const tail = split < 0 ? "" : text.slice(split);
  let count = 0;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bumped = head.replace(new RegExp(`^( {6}"version": )"${escaped}",$`, "gm"), (_m, key) => {
    count += 1;
    return `${key}"${to}",`;
  });
  if (count !== expected) {
    throw new ReleaseError(
      `bun.lock: found ${count} workspace versions at ${from}, expected ${expected}`,
    );
  }
  return bumped + tail;
}

/**
 * `## [Unreleased]` → a fresh empty `## [Unreleased]` above
 * `## [<version>] - <date>`, which keeps the old body. Refuses a missing or
 * empty `[Unreleased]`. GitHub compare links (`[Unreleased]: …/compare/X...HEAD`),
 * when the file has them, are moved on to the new version.
 */
export function releaseChangelog(text: string, version: string, date: string): string {
  const heading = /^## \[Unreleased\][ \t]*$/m;
  const match = heading.exec(text);
  if (!match) {
    throw new ReleaseError('CHANGELOG.md has no "## [Unreleased]" section');
  }
  const bodyStart = match.index + match[0].length;
  const rest = text.slice(bodyStart);
  const end = rest.search(/^(## |\[[^\]]+\]: )/m);
  const body = end < 0 ? rest : rest.slice(0, end);
  if (body.trim() === "") {
    throw new ReleaseError("CHANGELOG.md: [Unreleased] is empty; write the release notes first");
  }
  let out = `${text.slice(0, match.index)}## [Unreleased]\n\n## [${version}] - ${date}${rest}`;
  out = out.replace(
    /^\[Unreleased\]: (https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\/compare\/(\S+)\.\.\.HEAD$/m,
    (_m, base: string, previous: string) =>
      `[Unreleased]: ${base}/compare/v${version}...HEAD\n[${version}]: ${base}/compare/${previous}...v${version}`,
  );
  return out;
}
