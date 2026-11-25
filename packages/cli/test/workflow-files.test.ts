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
import {
  WORKFLOW_SOURCES_MAX,
  listWorkflowSources,
  loadWorkflowSource,
  workflowListing,
} from "../src/workflow-files.ts";

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

describe("listWorkflowSources: ONE walk of the folder (slice 5a)", () => {
  test("every *.yaml of the folder is a row, with the ABSOLUTE folder read", async () => {
    const root = project(`${PROJECT_PATHS.workflows}/task.yaml`, YAML);
    writeFileSync(join(root, PROJECT_PATHS.workflows, "beta.yaml"), YAML);
    // Not a workflow: not a `*.yaml`, so not a row at all.
    writeFileSync(join(root, PROJECT_PATHS.workflows, "notes.md"), "hi");
    const listing = await listWorkflowSources(root);
    expect(listing.dir).toBe(join(root, PROJECT_PATHS.workflows));
    expect(listing.rows.map((r) => r.name)).toEqual(["beta", "task"]);
    expect(listing.truncated).toBe(false);
    const task = listing.rows.find((r) => r.name === "task");
    // The row's source is what `loadWorkflowSource` returns for the same name:
    // the same path and the same bytes, so the hash a listing shows is the hash
    // a start compares against.
    const loaded = loadWorkflowSource(root, "task");
    if (task?.kind !== "source") throw new Error("no task row");
    expect(task.source.path).toBe(loaded.path);
    expect(task.source.text).toBe(loaded.text);
  });

  test("a row's prompts include files in sub-folders, exactly as loadWorkflowSource's (e2e fix round 3)", async () => {
    const root = project(`${PROJECT_PATHS.workflows}/task.yaml`, YAML);
    mkdirSync(join(root, PROJECT_PATHS.workflows, "prompts"), { recursive: true });
    writeFileSync(join(root, PROJECT_PATHS.workflows, "prompts", "plan.md"), "the plan");
    const listing = await listWorkflowSources(root);
    const task = listing.rows.find((r) => r.name === "task");
    if (task?.kind !== "source") throw new Error("no task row");
    expect(task.source.prompts["prompts/plan.md"]).toBe("the plan");
    expect(task.source.prompts).toEqual(loadWorkflowSource(root, "task").prompts);
  });

  test("a missing folder is [], never a throw (nothing to list)", async () => {
    const root = mkdtempSync(join(dir, "none-"));
    expect(await listWorkflowSources(root)).toEqual({
      dir: join(root, PROJECT_PATHS.workflows),
      rows: [],
      truncated: false,
    });
  });

  test("a symlinked file is an invalid row: a link could point outside the project", async () => {
    const real = mkdtempSync(join(dir, "target-"));
    writeFileSync(join(real, "task.yaml"), YAML);
    const root = project(`${PROJECT_PATHS.workflows}/other.yaml`, YAML);
    symlinkSync(join(real, "task.yaml"), join(root, PROJECT_PATHS.workflows, "task.yaml"));
    const listing = await listWorkflowSources(root);
    const task = listing.rows.find((r) => r.name === "task");
    expect(task?.kind).toBe("invalid");
    if (task?.kind !== "invalid") throw new Error("not invalid");
    expect(task.problem).toContain("symbolic link");
  });

  test("a symlinked workflows folder is refused with its path", async () => {
    const real = mkdtempSync(join(dir, "wfdir-"));
    writeFileSync(join(real, "task.yaml"), YAML);
    const root = mkdtempSync(join(dir, "linked-folder-"));
    mkdirSync(join(root, ".tentacle"));
    symlinkSync(real, join(root, PROJECT_PATHS.workflows));
    const listing = await listWorkflowSources(root);
    expect(listing.rows.map((r) => r.kind)).toEqual(["invalid"]);
    expect(listing.rows[0]?.kind === "invalid" ? listing.rows[0].problem : "").toContain(
      "symbolic link",
    );
  });

  test("a stem that is not a workflow name is a row with its reason, never a silent skip", async () => {
    const root = project(`${PROJECT_PATHS.workflows}/Bad Name.yaml`, YAML);
    const listing = await listWorkflowSources(root);
    expect(listing.rows).toEqual([
      {
        kind: "invalid",
        name: "Bad Name",
        path: ".tentacle/workflows/Bad Name.yaml",
        problem: 'not a workflow name (lowercase words joined by "-")',
      },
    ]);
  });

  test("more than WORKFLOW_SOURCES_MAX files: the first ones are kept, `truncated` says so", async () => {
    // Mutation: drop the flag → a user sees 64 of 70 and believes that is all.
    const root = mkdtempSync(join(dir, "many-"));
    mkdirSync(join(root, PROJECT_PATHS.workflows), { recursive: true });
    for (let i = 0; i < WORKFLOW_SOURCES_MAX + 3; i++) {
      writeFileSync(
        join(root, PROJECT_PATHS.workflows, `w${String(i).padStart(3, "0")}.yaml`),
        YAML,
      );
    }
    const listing = await listWorkflowSources(root);
    expect(listing.rows).toHaveLength(WORKFLOW_SOURCES_MAX);
    expect(listing.truncated).toBe(true);
  });
});

describe("workflowListing: the display-only facts (slice 5a / D7 v5)", () => {
  test("a project with workflows is not `gitIgnored` when .gitignore does not name it", async () => {
    const root = project(`${PROJECT_PATHS.workflows}/task.yaml`, YAML);
    const listing = await workflowListing(root);
    expect(listing.rows).toHaveLength(1);
    // Not a git repo at all: unknown is never claimed as either.
    expect(listing.gitIgnored).toBeUndefined();
    expect(listing.elsewhere).toBeUndefined();
  });

  test("an EMPTY folder gets the hint; a folder WITH a workflow does not", async () => {
    // Mutation: look for the hint unconditionally → the second case gains an
    // `elsewhere` and a user is told to go somewhere they need not.
    const parent = project(`${PROJECT_PATHS.workflows}/task.yaml`, YAML);
    const child = join(parent, "apps", "mobile");
    mkdirSync(join(child, PROJECT_PATHS.workflows), { recursive: true });
    const empty = await workflowListing(child);
    expect(empty.elsewhere).toEqual({ dir: join(parent, PROJECT_PATHS.workflows), count: 1 });
    writeFileSync(join(child, PROJECT_PATHS.workflows, "mine.yaml"), YAML);
    expect((await workflowListing(child)).elsewhere).toBeUndefined();
  });
});
