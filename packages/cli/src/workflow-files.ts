/**
 * Read `<cwd>/.tentacle/workflows/<name>.yaml` and the prompt files beside it
 * (docs/feat/agent-workflows.md D1; the folder is `PROJECT_PATHS.workflows`,
 * docs/feat/workflows-ui.md D7 v5) for `WorkflowDriverDeps.load`. Prompt paths
 * are relative to that folder; the validator refuses `..` and absolute ones,
 * and NO component of the path may be a symlink (a link could point outside the
 * project), so a run reads only regular files under
 * `<cwd>/.tentacle/workflows/`.
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { WorkflowSource, WorkflowSourceRow } from "@tentacle/agent";
import {
  PROJECT_PATHS,
  WORKFLOW_NAME_RE,
  type WorkflowsAboveHint,
  resolveInside,
  workflowsAbove,
} from "@tentacle/core";
import { nodeProjectFs } from "./project-fs.ts";

/** A `git check-ignore` call behind the "not versioned" notice answers in this or not at all. */
const GIT_CHECK_TIMEOUT_MS = 2000;

/** Caps: a prompt set that big is a mistake, not a workflow. */
export const WORKFLOW_FILES_MAX = 200;
export const WORKFLOW_FILE_MAX_BYTES = 256 * 1024;

function collect(root: string, dir: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir)) {
    if (Object.keys(out).length >= WORKFLOW_FILES_MAX) {
      return;
    }
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      collect(root, path, out);
    } else if (stat.isFile() && stat.size <= WORKFLOW_FILE_MAX_BYTES) {
      out[relative(root, path).split("\\").join("/")] = readFileSync(path, "utf8");
    }
  }
}

/**
 * The workflow `name` of the project at `cwd`; throws a one-line reason when it
 * cannot be read. The error names the ABSOLUTE folder searched, so a file
 * written in the wrong place says where tentacle looks.
 */
export function loadWorkflowSource(cwd: string, name: string): WorkflowSource {
  if (!WORKFLOW_NAME_RE.test(name)) {
    throw new Error(`"${name}" is not a workflow name (lowercase words joined by "-")`);
  }
  const fs = nodeProjectFs();
  const rel = `${PROJECT_PATHS.workflows}/${name}.yaml`;
  const resolved = resolveInside(cwd, rel, fs);
  if ("problem" in resolved) {
    throw new Error(`${rel} cannot be read: ${resolved.problem}`);
  }
  if ("absent" in resolved) {
    throw new Error(`no workflow ${name}: ${join(cwd, rel)} does not exist`);
  }
  if (fs.lstat(resolved.path) !== "file") {
    throw new Error(`${rel} is not a regular file under the project`);
  }
  const root = join(cwd, PROJECT_PATHS.workflows);
  const prompts: Record<string, string> = {};
  collect(root, root, prompts);
  const text = prompts[`${name}.yaml`] ?? readFileSync(resolved.path, "utf8");
  return { path: rel, text, prompts };
}

/**
 * Every workflow FILE of the project at `cwd` (docs/feat/workflows-ui.md D6 /
 * slice 5a): ONE walk of `<cwd>/.tentacle/workflows`, top level only, every
 * `<stem>.yaml` — through `resolveInside`, so a symlinked `.tentacle`, a
 * symlinked `workflows` or a symlinked file is refused with its path, never
 * followed. A missing folder is `[]` (nothing to list), never a throw.
 *
 * A `*.yaml` whose stem is not a workflow name becomes an `ok:false` row
 * carrying the reason instead of the file's text: a silent skip would hide a
 * file the user can see in the folder. A file over the loader's byte cap is
 * likewise an `ok:false` row (`too-large`), never a partial read.
 *
 * Async (`node:fs/promises`) on purpose: this runs inside `serve`, on the event
 * loop the concurrent peer shares (§7), so a big folder must not block it.
 */
export const WORKFLOW_SOURCES_MAX = 64;

/**
 * One walk's answer: the ABSOLUTE folder read (the catalogue's `dir`), every
 * row, and whether more `*.yaml` files existed than were kept (`truncated`).
 */
export interface WorkflowListing {
  readonly dir: string;
  readonly rows: readonly WorkflowSourceRow[];
  readonly truncated: boolean;
  /**
   * Whether `.gitignore` covers the folder, when that can be known:
   * `undefined` = not a git repo / `git` unusable (never claimed as either).
   * Only `workflowListing` asks this; `listWorkflowSources` never runs git.
   */
  readonly gitIgnored?: boolean;
  /**
   * The display-only "workflows higher up" hint (D7 v5), present ONLY when this
   * folder lists no workflow at all. It is never loadable: `loadWorkflowSource`
   * takes `cwd` and nothing else.
   */
  readonly elsewhere?: WorkflowsAboveHint;
}

/** The absolute folder the catalogue reads for the project at `cwd`. */
export function workflowsDir(cwd: string): string {
  return join(cwd, PROJECT_PATHS.workflows);
}

export async function listWorkflowSources(cwd: string): Promise<WorkflowListing> {
  const dir = workflowsDir(cwd);
  const fs = nodeProjectFs();
  const resolved = resolveInside(cwd, PROJECT_PATHS.workflows, fs);
  if ("problem" in resolved) {
    // The FOLDER itself is a link or an escape: one invalid row, never a throw
    // (a listing must not fail the whole call for one bad entry).
    return {
      dir,
      rows: [
        {
          kind: "invalid",
          name: PROJECT_PATHS.workflows,
          path: PROJECT_PATHS.workflows,
          problem: resolved.problem,
        },
      ],
      truncated: false,
    };
  }
  if ("absent" in resolved) {
    return { dir, rows: [], truncated: false };
  }
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { dir, rows: [], truncated: false };
    }
    // Unreadable (permissions): say so — an empty list would claim "no workflows".
    return {
      dir,
      rows: [
        {
          kind: "invalid",
          name: PROJECT_PATHS.workflows,
          path: PROJECT_PATHS.workflows,
          problem: "cannot be read",
        },
      ],
      truncated: false,
    };
  }
  const yamlFiles = names.filter((name) => name.toLowerCase().endsWith(".yaml")).sort();
  const kept = yamlFiles.slice(0, WORKFLOW_SOURCES_MAX);
  // ONE walk: every regular, non-link, in-cap file of the folder is read once
  // and shared — the same prompt map `loadWorkflowSource` builds for one name.
  const files: Record<string, string> = {};
  for (const entry of names) {
    if (Object.keys(files).length >= WORKFLOW_FILES_MAX) {
      break;
    }
    try {
      const info = await lstat(join(dir, entry));
      if (info.isSymbolicLink() || !info.isFile() || info.size > WORKFLOW_FILE_MAX_BYTES) {
        continue;
      }
      files[entry] = await readFile(join(dir, entry), "utf8");
    } catch {}
  }
  const rows: WorkflowSourceRow[] = [];
  for (const file of kept) {
    const stem = file.slice(0, -".yaml".length);
    const rel = `${PROJECT_PATHS.workflows}/${file}`;
    if (!WORKFLOW_NAME_RE.test(stem)) {
      rows.push({
        kind: "invalid",
        name: stem,
        path: rel,
        problem: 'not a workflow name (lowercase words joined by "-")',
      });
      continue;
    }
    const inside = resolveInside(cwd, rel, fs);
    if ("problem" in inside) {
      rows.push({ kind: "invalid", name: stem, path: rel, problem: inside.problem });
      continue;
    }
    if ("absent" in inside) {
      continue;
    }
    if (fs.lstat(inside.path) !== "file") {
      rows.push({ kind: "invalid", name: stem, path: rel, problem: "is not a regular file" });
      continue;
    }
    // Absent from `files` = a symlink, or over the byte cap: never a partial read.
    const text = files[file];
    if (text === undefined) {
      rows.push({
        kind: "invalid",
        name: stem,
        path: rel,
        problem: "is too large to be a workflow, or is not a regular file",
      });
      continue;
    }
    rows.push({ kind: "source", name: stem, source: { path: rel, text, prompts: files } });
  }
  return { dir, rows, truncated: yamlFiles.length > kept.length };
}

/**
 * Whether git IGNORES the project's workflow folder (`workflowsGitIgnored`, for
 * the catalogue's "not versioned" notice, slice 5a): `git check-ignore -q --
 * <folder>` with `cwd` as the working directory. Exit 0 → `true` (ignored),
 * exit 1 → `false`, anything else (no git, not a repo, a timeout) → `undefined`
 * — unknown is never claimed as either. Argv only, never a shell string.
 */
export async function workflowsGitIgnored(cwd: string): Promise<boolean | undefined> {
  const git = Bun.spawn(["git", "check-ignore", "-q", "--", PROJECT_PATHS.workflows], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => git.kill(), GIT_CHECK_TIMEOUT_MS);
  try {
    const code = await git.exited;
    return code === 0 ? true : code === 1 ? false : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The `WorkflowDriverDeps.list` of the project at `cwd` (docs/feat/workflows-ui.md
 * slice 5a): ONE walk, plus the two DISPLAY-ONLY facts a user in the wrong
 * folder needs — whether git ignores the folder ("not versioned"), and, only
 * when the folder listed NO workflow, the bounded `workflowsAbove` hint of where
 * workflows were found higher up (D7 v5).
 *
 * The hint is looked for ONLY on an empty folder, so it never costs an lstat on
 * the ordinary path, and nothing it names can be loaded, hashed, approved or
 * started: `loadWorkflowSource` and the walk both take `cwd`, never an ancestor.
 * `git check-ignore` runs only when there is something to notice (at least one
 * readable workflow), so a project without the folder spawns no process.
 */
export async function workflowListing(cwd: string): Promise<WorkflowListing> {
  const listing = await listWorkflowSources(cwd);
  const elsewhere =
    listing.rows.length === 0
      ? workflowsAbove(cwd, nodeProjectFs(), {
          ...(process.env.HOME !== undefined ? { home: process.env.HOME } : {}),
        })
      : undefined;
  const gitIgnored = listing.rows.some((row) => row.kind === "source")
    ? await workflowsGitIgnored(cwd)
    : false;
  return {
    dir: listing.dir,
    rows: listing.rows,
    truncated: listing.truncated,
    ...(gitIgnored !== undefined ? { gitIgnored } : {}),
    ...(elsewhere !== undefined ? { elsewhere } : {}),
  };
}
