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
import { join, relative } from "node:path";
import type { WorkflowSource } from "@tentacle/agent";
import { PROJECT_PATHS, WORKFLOW_NAME_RE, resolveInside } from "@tentacle/core";
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
