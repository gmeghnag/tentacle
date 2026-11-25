/**
 * The project's `.tentacle/` folder and its children — the ONE place these
 * names are spelled (docs/feat/workflows-ui.md D7 v5).
 *
 * The project root IS the directory tentacle runs in (`cwd`, owner 23/11
 * ~11:25): there is no upward walk, so callers pass the cwd they already have.
 * What lives here is therefore (a) the names and (b) ONE symlink check over
 * every component of a path inside a base. The bounded "workflows higher up"
 * hint that used to live here was removed end to end (docs/fix/workflows-ux.md
 * S8c, owner Q2): nothing looks above the cwd, so there is no seam for a listing
 * either.
 *
 * Pure: no `node:fs`, no clock, no process — the I/O is injected (`ProjectFs`),
 * the one no-links check. The `.tentacle/hide` reader keeps its own FIFO-safe
 * fd-level check (`cli/src/workspace-mount.ts`): a container-secrets path, and
 * a pure module cannot express an `O_NOFOLLOW` open (Notes/debt in the plan).
 */

/** The folder tentacle keeps its per-project state in. */
export const TENTACLE_DIR = ".tentacle";

/**
 * The children of `TENTACLE_DIR` that tentacle reads today, relative to the
 * project root (the cwd), POSIX-style. NOT a discovery mechanism: nothing here
 * is resolved by walking up.
 */
export const PROJECT_PATHS = {
  /** The project's workflow files: `<cwd>/.tentacle/workflows/<name>.yaml`. */
  workflows: `${TENTACLE_DIR}/workflows`,
  /** The per-project hide file: `<cwd>/.tentacle/hide`. */
  hide: `${TENTACLE_DIR}/hide`,
  /** The library fallback's spilled tool output: `<cwd>/.tentacle/tool-output/…`. */
  toolOutput: `${TENTACLE_DIR}/tool-output`,
} as const;

/** A workflow name — the file stem, lowercase words joined by `-`. */
export const WORKFLOW_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type ProjectEntryKind = "dir" | "file" | "link" | "other";

/** The read this module needs, injected (the real one is `cli/src/project-fs.ts`). */
export interface ProjectFs {
  /** `lstat`: `undefined` when there is nothing there (ENOENT/ENOTDIR). */
  lstat(path: string): ProjectEntryKind | undefined;
}

/** `resolveInside`: the path (absolute), or why it is not usable. */
export type InsidePath =
  | { readonly path: string }
  | { readonly absent: true }
  | { readonly problem: string };

const SEPARATORS = /[\\/]+/;

/** `base` + `rel`, with exactly one separator between them. */
function joinPath(base: string, rel: string): string {
  return /[\\/]$/.test(base) ? `${base}${rel}` : `${base}/${rel}`;
}

/**
 * Resolve `rel` under `base` with NO symlink at any component (`.tentacle`, its
 * child, the file itself): a link could point outside the project, and these
 * files are read and hashed for an approval. `absent` = something in the chain
 * does not exist; `problem` = a link (or a `..`/absolute escape) — the caller
 * refuses loudly, never a silent skip. The file/dir kind of the last component
 * is the caller's check: this function is only about where the path leads.
 */
export function resolveInside(base: string, rel: string, fs: ProjectFs): InsidePath {
  if (rel.trim() === "") {
    return { problem: "is empty" };
  }
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) {
    return { problem: `${rel} is an absolute path` };
  }
  const parts = rel.split(SEPARATORS).filter((part) => part !== "");
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    return { problem: `${rel} leaves the folder it is read from` };
  }
  let current = base;
  for (const part of parts) {
    current = joinPath(current, part);
    const kind = fs.lstat(current);
    if (kind === undefined) {
      return { absent: true };
    }
    if (kind === "link") {
      return { problem: `${current} is a symbolic link` };
    }
  }
  return { path: current };
}
