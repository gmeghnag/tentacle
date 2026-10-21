/**
 * Agent Skills discovery — the I/O half (the pure half is `skills.ts`). Finds
 * `<root>/<name>/SKILL.md` in the scope roots, parses each leniently and lists
 * its bundled files. Every walk is bounded and nothing here throws: a broken
 * skill becomes a diagnostic, never a failed startup. Design:
 * docs/feat/skills-core.md.
 */
import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { SKILL_FILENAME, type SkillInfo, type SkillScope, parseSkillManifest } from "./skills.ts";

/** A directory holding skill directories, and the scope its skills get. */
export interface SkillRoot {
  readonly path: string;
  readonly scope: SkillScope;
}

/** Bounds: skill dirs per root, files listed per skill, entries visited, depth. */
const MAX_SKILL_DIRS_PER_ROOT = 200;
const MAX_LISTED_FILES = 50;
const MAX_VISITED_ENTRIES = 1000;
const MAX_FILE_DEPTH = 4;
const MAX_WALK_STEPS = 40;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * The scope roots in precedence order: every `.agents/skills` from the launch
 * cwd up (nearest first) — stopping after the repo root (`.git`), at the
 * filesystem root, or BEFORE `home` (`~/.agents/skills` is the user scope,
 * never a project one) — then `<configDir>/skills`, then `~/.agents/skills`.
 * A root reached twice (same real path) is kept once, at its first position.
 */
export async function skillRoots(
  launchCwd: string,
  home: string,
  configDir: string,
): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [];
  const homeDir = resolvePath(home);
  let dir = resolvePath(launchCwd);
  for (let i = 0; i < MAX_WALK_STEPS && dir !== homeDir; i++) {
    roots.push({ path: join(dir, ".agents", "skills"), scope: "project" });
    if (await exists(join(dir, ".git"))) {
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  roots.push({ path: join(configDir, "skills"), scope: "user" });
  roots.push({ path: join(homeDir, ".agents", "skills"), scope: "user" });

  const seen = new Set<string>();
  const unique: SkillRoot[] = [];
  for (const root of roots) {
    let key = root.path;
    try {
      key = await realpath(root.path);
    } catch {
      // Missing root: keyed by its path; the scan skips it.
    }
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(root);
    }
  }
  return unique;
}

/** List a skill's bundled files (relative paths), bounded and loop-safe. */
async function listBundledFiles(
  skillDir: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let visited = 0;
  let truncated = false;
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(join(skillDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      if (rel === "" && entry.name === SKILL_FILENAME) {
        continue;
      }
      if (++visited > MAX_VISITED_ENTRIES || files.length >= MAX_LISTED_FILES) {
        truncated = true;
        return;
      }
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      // A Dirent does not follow symlinks: a symlinked dir is listed as an
      // entry, never recursed into — so a link cycle cannot loop the walk.
      if (entry.isDirectory()) {
        if (depth >= MAX_FILE_DEPTH) {
          truncated = true;
          continue;
        }
        await walk(path, depth + 1);
        if (truncated && files.length >= MAX_LISTED_FILES) {
          return;
        }
      } else {
        files.push(path);
      }
    }
  };
  await walk("", 1);
  return { files, truncated };
}

/**
 * Scan the roots (in precedence order) for skills. Returns every parsed skill
 * in that order — precedence is applied by `mergeSkills` — plus diagnostics
 * for skipped skills, warnings and hit bounds. A missing root is normal and
 * silent.
 */
export async function scanSkills(
  roots: readonly SkillRoot[],
): Promise<{ candidates: SkillInfo[]; diagnostics: string[] }> {
  const candidates: SkillInfo[] = [];
  const diagnostics: string[] = [];
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await readdir(root.path, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        diagnostics.push(`cannot read skills directory ${root.path}: ${String(error)}`);
      }
      continue;
    }
    const names = entries
      .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
      .map((e) => e.name)
      .sort();
    if (names.length > MAX_SKILL_DIRS_PER_ROOT) {
      diagnostics.push(
        `${root.path}: ${names.length} entries; only the first ${MAX_SKILL_DIRS_PER_ROOT} are scanned`,
      );
    }
    for (const name of names.slice(0, MAX_SKILL_DIRS_PER_ROOT)) {
      const dir = join(root.path, name);
      const location = join(dir, SKILL_FILENAME);
      let text: string;
      try {
        if (!(await stat(dir)).isDirectory()) {
          continue; // a symlink to a file
        }
        text = await readFile(location, "utf8");
      } catch (error) {
        const code = errorCode(error);
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          diagnostics.push(`skipped skill at ${location}: ${String(error)}`);
        }
        continue; // not a skill directory
      }
      const parsed = parseSkillManifest(text, name);
      if (!parsed.ok) {
        diagnostics.push(`skipped skill at ${location}: ${parsed.reason}`);
        continue;
      }
      for (const warning of parsed.warnings) {
        diagnostics.push(`skill "${parsed.name}" (${location}): ${warning}`);
      }
      const { files, truncated } = await listBundledFiles(dir);
      candidates.push({
        name: parsed.name,
        description: parsed.description,
        location,
        dir,
        scope: root.scope,
        files,
        filesTruncated: truncated,
        modelInvocable: parsed.modelInvocable,
        userInvocable: parsed.userInvocable,
      });
    }
  }
  return { candidates, diagnostics };
}
