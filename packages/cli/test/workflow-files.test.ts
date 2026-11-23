/**
 * `cli/src/workflow-files.ts` (docs/feat/workflows-ui.md D7 v5): the project's
 * workflows live under `.tentacle/workflows/` — the module's name, never a
 * hand-written `workflows/` — and every component of the path is checked for a
 * symlink, not just the folder and the file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_PATHS } from "@tentacle/core";
import { loadWorkflowSource } from "../src/workflow-files.ts";

const YAML = "schemaVersion: 1\nname: task\nversion: 1\nsteps:\n  - id: one\n    run: make test\n";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-files-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh project folder with a file at `rel` (no symlinks). */
function project(rel: string, body: string): string {
  const root = mkdtempSync(join(dir, "p-"));
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
  return root;
}

describe("loadWorkflowSource reads .tentacle/workflows", () => {
  test("a workflow under <cwd>/.tentacle/workflows loads, recorded with that path", () => {
    const root = project(`${PROJECT_PATHS.workflows}/task.yaml`, YAML);
    const source = loadWorkflowSource(root, "task");
    expect(source.path).toBe(".tentacle/workflows/task.yaml");
    expect(source.text).toBe(YAML);
    expect(Object.keys(source.prompts)).toEqual(["task.yaml"]);
  });

  test("the OLD `workflows/` at the project root is not read", () => {
    const root = project("workflows/task.yaml", YAML);
    expect(() => loadWorkflowSource(root, "task")).toThrow(
      `no workflow task: ${join(root, PROJECT_PATHS.workflows, "task.yaml")} does not exist`,
    );
  });

  test("a missing file's error names the ABSOLUTE folder tentacle reads", () => {
    const root = mkdtempSync(join(dir, "empty-"));
    expect(() => loadWorkflowSource(root, "nope")).toThrow(
      `no workflow nope: ${join(root, PROJECT_PATHS.workflows, "nope.yaml")} does not exist`,
    );
  });

  test("prompts beside the workflow are collected, still keyed relative to the folder", () => {
    const root = project(`${PROJECT_PATHS.workflows}/task.yaml`, YAML);
    writeFileSync(join(root, PROJECT_PATHS.workflows, "prompts.md"), "the prompt");
    const source = loadWorkflowSource(root, "task");
    expect(source.prompts.prompts).toBeUndefined();
    expect(source.prompts["prompts.md"]).toBe("the prompt");
  });

  test("a symlinked .tentacle is refused (a link could point outside the project)", () => {
    const real = project(`${PROJECT_PATHS.workflows}/task.yaml`, YAML);
    const root = mkdtempSync(join(dir, "linked-"));
    symlinkSync(real, join(root, ".tentacle"));
    expect(() => loadWorkflowSource(root, "task")).toThrow("symbolic link");
  });

  test("a symlinked workflows folder is refused", () => {
    const real = mkdtempSync(join(dir, "wf-"));
    writeFileSync(join(real, "task.yaml"), YAML);
    const root = mkdtempSync(join(dir, "linked-child-"));
    mkdirSync(join(root, ".tentacle"));
    symlinkSync(real, join(root, PROJECT_PATHS.workflows));
    expect(() => loadWorkflowSource(root, "task")).toThrow("symbolic link");
  });

  test("a symlinked workflow file is refused", () => {
    const real = mkdtempSync(join(dir, "file-"));
    writeFileSync(join(real, "task.yaml"), YAML);
    const root = project(`${PROJECT_PATHS.workflows}/other.yaml`, YAML);
    symlinkSync(join(real, "task.yaml"), join(root, PROJECT_PATHS.workflows, "task.yaml"));
    expect(() => loadWorkflowSource(root, "task")).toThrow("symbolic link");
  });

  test("a bad name is refused before any read", () => {
    const root = mkdtempSync(join(dir, "name-"));
    expect(() => loadWorkflowSource(root, "../etc/passwd")).toThrow(
      '"../etc/passwd" is not a workflow name',
    );
  });

  test("a parent's workflow is NOT loadable from the child (the hint never feeds a run)", () => {
    // The "cannot change behaviour" property of `workflowsAbove`: it may SAY a
    // parent has workflows, but the loader takes the cwd and nothing else — so
    // starting `task` in the child fails and names the CHILD's folder.
    const root = project(`${PROJECT_PATHS.workflows}/task.yaml`, YAML);
    const child = join(root, "apps", "mobile");
    mkdirSync(child, { recursive: true });
    expect(() => loadWorkflowSource(child, "task")).toThrow(
      `no workflow task: ${join(child, PROJECT_PATHS.workflows, "task.yaml")} does not exist`,
    );
  });
});
