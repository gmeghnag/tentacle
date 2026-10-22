/**
 * Project hooks discovery (docs/feat/hooks-project-trust.md): the
 * `.agents/hooks.json` files a repository brings. They are code execution
 * brought by a clone, so they only run after the user trusts them — keyed by
 * the project folder + `hash` of the definitions (a changed definition asks
 * again). Pure half: `parseProjectHooksFile`, `projectHooksHash`; I/O half:
 * `projectHooksFiles`, `discoverProjectHooks`. Nothing here throws: a broken
 * file is a diagnostic, never a failed startup.
 */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { type HookSpecConfig, HookSpecSchema } from "./schema.ts";

export const PROJECT_HOOKS_FILE = join(".agents", "hooks.json");
const MAX_WALK_STEPS = 40;
/** A hooks file above this is skipped (a diagnostic). */
const MAX_FILE_BYTES = 256 * 1024;

const ProjectHooksFileSchema = z.object({ hooks: z.array(HookSpecSchema) }).strict();

/** The project hooks the session may run once trusted. */
export interface ProjectHooks {
  /** Real path of the repo root (the `.git` holder), else of the launch folder. */
  readonly folder: string;
  /** sha256 hex over the valid files' definitions (see `projectHooksHash`). */
  readonly hash: string;
  /** Every valid file's hooks, nearest file first. */
  readonly hooks: readonly HookSpecConfig[];
  /** The valid files, relative to `folder`, nearest first. */
  readonly files: readonly string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse one `.agents/hooks.json`: its hooks, or why it is skipped. */
export function parseProjectHooksFile(
  text: string,
): { hooks: HookSpecConfig[] } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const parsed = ProjectHooksFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { error: `${where}${issue?.message ?? "invalid"}` };
  }
  return { hooks: parsed.data.hooks };
}

/** JSON with object keys sorted at every level, so formatting/key order never changes it. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The trust key's hash: sha256 hex over `[{file, hooks}]` in walk order, keys sorted. */
export function projectHooksHash(
  entries: readonly { readonly file: string; readonly hooks: readonly HookSpecConfig[] }[],
): string {
  return createHash("sha256")
    .update(canonical(entries.map((e) => ({ file: e.file, hooks: e.hooks }))))
    .digest("hex");
}

/**
 * Every existing `<dir>/.agents/hooks.json` from `launchCwd` up (nearest
 * first) — stopping after the repo root (`.git`), at the filesystem root, or
 * BEFORE `home` (the same walk as `skillRoots`) — and the project folder: the
 * repo root when one was found, else `launchCwd`.
 */
export async function projectHooksFiles(
  launchCwd: string,
  home: string,
): Promise<{ folder: string; files: string[] }> {
  const homeDir = resolvePath(home);
  const start = resolvePath(launchCwd);
  const files: string[] = [];
  let folder = start;
  let dir = start;
  for (let i = 0; i < MAX_WALK_STEPS && dir !== homeDir; i++) {
    const file = join(dir, PROJECT_HOOKS_FILE);
    if (await exists(file)) {
      files.push(file);
    }
    if (await exists(join(dir, ".git"))) {
      folder = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return { folder, files };
}

/** Discover and load the project hooks; `projectHooks` is absent when no valid hook exists. */
export async function discoverProjectHooks(
  launchCwd: string,
  home: string,
): Promise<{ projectHooks?: ProjectHooks; diagnostics: string[] }> {
  const { folder, files } = await projectHooksFiles(launchCwd, home);
  const diagnostics: string[] = [];
  if (files.length === 0) {
    return { diagnostics };
  }
  let realFolder = folder;
  try {
    realFolder = await realpath(folder);
  } catch {
    // Keep the resolved path.
  }
  const entries: { file: string; hooks: HookSpecConfig[] }[] = [];
  for (const file of files) {
    let text: string;
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) {
        diagnostics.push(`${file}: skipped (larger than ${MAX_FILE_BYTES} bytes)`);
        continue;
      }
      text = await readFile(file, "utf8");
    } catch (error) {
      diagnostics.push(`${file}: skipped (${error instanceof Error ? error.message : error})`);
      continue;
    }
    const parsed = parseProjectHooksFile(text);
    if ("error" in parsed) {
      diagnostics.push(`${file}: skipped (${parsed.error})`);
      continue;
    }
    if (parsed.hooks.length > 0) {
      entries.push({ file: relative(folder, file), hooks: parsed.hooks });
    }
  }
  if (entries.length === 0) {
    return { diagnostics };
  }
  return {
    projectHooks: {
      folder: realFolder,
      hash: projectHooksHash(entries),
      hooks: entries.flatMap((e) => e.hooks),
      files: entries.map((e) => e.file),
    },
    diagnostics,
  };
}
