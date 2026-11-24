/**
 * The project's `.tentacle/` folder and its children — the ONE place these
 * names are spelled (docs/feat/workflows-ui.md D7 v5).
 *
 * The project root IS the directory tentacle runs in (`cwd`, owner 23/11
 * ~11:25): there is no upward walk, so callers pass the cwd they already have.
 * What lives here is therefore (a) the names, (b) ONE symlink check over every
 * component of a path inside a base, and (c) a bounded, read-only, DISPLAY-ONLY
 * hint that says where workflows were found higher up.
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

/** The reads this module needs, injected (the real one is `cli/src/project-fs.ts`). */
export interface ProjectFs {
  /** `lstat`: `undefined` when there is nothing there (ENOENT/ENOTDIR). */
  lstat(path: string): ProjectEntryKind | undefined;
  /** The entries of `dir`; `undefined` when it cannot be read. */
  list(
    dir: string,
  ): readonly { readonly name: string; readonly kind: ProjectEntryKind }[] | undefined;
}

/** `resolveInside`: the path (absolute), or why it is not usable. */
export type InsidePath =
  | { readonly path: string }
  | { readonly absent: true }
  | { readonly problem: string };

/** How many ancestors `workflowsAbove` looks at (parent … great-great-grandparent). */
export const WORKFLOWS_ABOVE_DEPTH = 4;
/** More workflows than this in one folder are counted as this many (a hint, not an inventory). */
export const WORKFLOWS_ABOVE_MAX_COUNT = 200;

/** The ancestors of `WorkflowsAbove`'s display-only hint. */
export interface WorkflowsAboveHint {
  /** The absolute `.tentacle/workflows` folder found — for DISPLAY only. */
  readonly dir: string;
  /** How many `*.yaml` workflow files it holds (capped). */
  readonly count: number;
}

const SEPARATORS = /[\\/]+/;

/** `a/b` from `a`, `a/b/`; `undefined` at the root (nothing above it). */
function parentOf(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed === "") {
    return undefined;
  }
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) {
    return undefined;
  }
  const head = trimmed.slice(0, cut);
  return /^[A-Za-z]:$/.test(head) || head === "" ? `${head}/` : head;
}

/** `base` + `rel`, with exactly one separator between them. */
function joinPath(base: string, rel: string): string {
  return /[\\/]$/.test(base) ? `${base}${rel}` : `${base}/${rel}`;
}

/** The same path without trailing separators, for comparing two spellings. */
function normalize(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed === "" ? "/" : trimmed;
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

/** A `*.yaml` in a workflows folder: a regular file whose stem is a workflow name. */
function isWorkflowFile(entry: { name: string; kind: ProjectEntryKind }): boolean {
  if (entry.kind !== "file" || !entry.name.endsWith(".yaml")) {
    return false;
  }
  return WORKFLOW_NAME_RE.test(entry.name.slice(0, -".yaml".length));
}

/**
 * The DISPLAY-ONLY "workflows higher up" hint: the nearest of the 4 ancestors of
 * `cwd` that holds a real `.tentacle/workflows` with at least one workflow file.
 *
 * It never contributes a file to a run: `loadWorkflowSource`, the catalogue and
 * the driver take the cwd, and nothing here can be asked for. No file is opened,
 * no YAML parsed, no hash computed, nothing written — at most 8 `lstat` and one
 * listing per ancestor tried. `$HOME` and `/` are never looked at (a dotfiles
 * `~/.tentacle` would otherwise claim every folder), and a symlinked `.tentacle`
 * or `workflows` is skipped, never followed.
 */
export function workflowsAbove(
  cwd: string,
  fs: ProjectFs,
  options: { readonly home?: string } = {},
): WorkflowsAboveHint | undefined {
  const home = options.home === undefined ? undefined : normalize(options.home);
  let at = parentOf(cwd);
  for (let depth = 0; depth < WORKFLOWS_ABOVE_DEPTH && at !== undefined; depth++) {
    const folder = normalize(at);
    if (folder === "/" || (home !== undefined && folder === home)) {
      return undefined;
    }
    const dir = `${folder}/${PROJECT_PATHS.workflows}`;
    if (fs.lstat(`${folder}/${TENTACLE_DIR}`) === "dir" && fs.lstat(dir) === "dir") {
      const entries = fs.list(dir);
      if (entries !== undefined) {
        const count = entries.filter(isWorkflowFile).length;
        if (count > 0) {
          return { dir, count: Math.min(count, WORKFLOWS_ABOVE_MAX_COUNT) };
        }
      }
    }
    at = parentOf(folder);
  }
  return undefined;
}
