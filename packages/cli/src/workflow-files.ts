/**
 * Read `workflows/<name>.yaml` and the prompt files beside it
 * (docs/feat/agent-workflows.md D1) for `WorkflowDriverDeps.load`. Prompt
 * paths are relative to `workflows/`; the validator refuses `..` and absolute
 * ones, and this reader never follows a symlink (a link could point outside the
 * repo), so a run reads only regular files under `<cwd>/workflows/`.
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { WorkflowSource } from "@tentacle/agent";

/** Caps: a prompt set that big is a mistake, not a workflow. */
export const WORKFLOW_FILES_MAX = 200;
export const WORKFLOW_FILE_MAX_BYTES = 256 * 1024;

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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

/** The workflow `name` of the repo at `cwd`; throws a one-line reason when it cannot be read. */
export function loadWorkflowSource(cwd: string, name: string): WorkflowSource {
  if (!NAME.test(name)) {
    throw new Error(`"${name}" is not a workflow name (lowercase words joined by "-")`);
  }
  const root = join(cwd, "workflows");
  const file = join(root, `${name}.yaml`);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch {
    throw new Error(`no workflow ${name}: workflows/${name}.yaml does not exist`);
  }
  if (!stat.isFile() || lstatSync(root).isSymbolicLink()) {
    throw new Error(`workflows/${name}.yaml is not a regular file under the repo`);
  }
  const prompts: Record<string, string> = {};
  collect(root, root, prompts);
  const text = prompts[`${name}.yaml`] ?? readFileSync(file, "utf8");
  return { path: `workflows/${name}.yaml`, text, prompts };
}
