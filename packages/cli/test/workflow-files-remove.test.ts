/**
 * `removeWorkflowFile` (docs/feat/mobile-workflows-landing.md D3): the ONE
 * remover of a workflow file. It removes the YAML the caller SAW (a hash, or
 * "still broken"), never a prompt file, and never anything a link points at.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowSource } from "@tentacle/agent";
import {
  PROJECT_PATHS,
  WORKFLOW_FILE_MAX_BYTES,
  runtimeHasher,
  validateWorkflow,
  workflowHash,
} from "@tentacle/core";
import { loadWorkflowSource, removeWorkflowFile } from "../src/workflow-files.ts";

const YAML = [
  "schemaVersion: 1",
  "name: task",
  "version: 2",
  "steps:",
  "  - id: build",
  "    agent: { prompt: prompts/build.md }",
  "",
].join("\n");
const REL = `${PROJECT_PATHS.workflows}/task.yaml`;

function currentHash(source: WorkflowSource): string {
  const validation = validateWorkflow(source.text, {
    readPrompt: (path) => source.prompts[path],
  });
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
  const files = validation.spec.prompts.map((p) => ({ path: p.path, text: p.text }));
  return workflowHash(source.text, files, runtimeHasher());
}

let dir: string;
let folder: string;
let yaml: string;
let prompt: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-remove-"));
  folder = join(dir, PROJECT_PATHS.workflows);
  mkdirSync(join(folder, "prompts"), { recursive: true });
  yaml = join(folder, "task.yaml");
  prompt = join(folder, "prompts", "build.md");
  writeFileSync(yaml, YAML);
  writeFileSync(prompt, "build it\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const seen = (): string => currentHash(loadWorkflowSource(dir, "task"));
const remove = (expected: Parameters<typeof removeWorkflowFile>[2], name = "task") =>
  removeWorkflowFile(dir, name, expected, currentHash);

describe("removeWorkflowFile", () => {
  test("the hash seen removes only the YAML; the prompt file stays", () => {
    expect(remove({ hash: seen() })).toEqual({ ok: true, path: REL });
    expect(existsSync(yaml)).toBe(false);
    expect(readFileSync(prompt, "utf8")).toBe("build it\n");
  });

  test("a YAML or a prompt edited since is `changed`: the file is intact", () => {
    const hash = seen();
    writeFileSync(prompt, "build it differently\n");
    expect(remove({ hash })).toMatchObject({ ok: false, refusal: "changed" });
    expect(readFileSync(yaml, "utf8")).toBe(YAML);
  });

  test("a file that no longer validates is `changed` for a hash", () => {
    const hash = seen();
    writeFileSync(yaml, "not: [a workflow");
    expect(remove({ hash })).toMatchObject({ ok: false, refusal: "changed" });
    expect(existsSync(yaml)).toBe(true);
  });

  test("still broken is removed", () => {
    writeFileSync(yaml, "not: [a workflow");
    expect(remove({ broken: true })).toEqual({ ok: true, path: REL });
    expect(existsSync(yaml)).toBe(false);
    expect(existsSync(prompt)).toBe(true);
  });

  test("a file over the byte cap counts as broken, as the listing shows it", () => {
    writeFileSync(yaml, `${YAML}# ${"x".repeat(WORKFLOW_FILE_MAX_BYTES)}\n`);
    expect(remove({ broken: true })).toEqual({ ok: true, path: REL });
  });

  test("broken when listed, valid now → `changed`, intact", () => {
    expect(remove({ broken: true })).toMatchObject({ ok: false, refusal: "changed" });
    expect(readFileSync(yaml, "utf8")).toBe(YAML);
  });

  test("an absent file (or folder) is `gone`", () => {
    rmSync(yaml);
    expect(remove({ broken: true })).toMatchObject({ ok: false, refusal: "gone" });
    rmSync(join(dir, ".tentacle"), { recursive: true, force: true });
    expect(remove({ broken: true })).toMatchObject({ ok: false, refusal: "gone" });
  });

  test("a symlinked file is refused; the target stays", () => {
    const outside = join(dir, "outside.yaml");
    writeFileSync(outside, "keep me");
    rmSync(yaml);
    symlinkSync(outside, yaml);
    expect(remove({ broken: true })).toMatchObject({ ok: false, refusal: "invalid" });
    expect(readFileSync(outside, "utf8")).toBe("keep me");
    expect(existsSync(yaml)).toBe(true);
  });

  test("a symlinked folder is refused; nothing outside is removed", () => {
    const outside = mkdtempSync(join(tmpdir(), "wf-remove-out-"));
    try {
      writeFileSync(join(outside, "task.yaml"), "keep me");
      rmSync(folder, { recursive: true, force: true });
      symlinkSync(outside, folder);
      expect(remove({ broken: true })).toMatchObject({ ok: false, refusal: "invalid" });
      expect(readFileSync(join(outside, "task.yaml"), "utf8")).toBe("keep me");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a directory named like the file, or a bad name, is `invalid`", () => {
    rmSync(yaml);
    mkdirSync(yaml);
    expect(remove({ broken: true })).toMatchObject({ ok: false, refusal: "invalid" });
    expect(existsSync(yaml)).toBe(true);
    writeFileSync(join(dir, "x.yaml"), "keep me");
    expect(remove({ broken: true }, "../../x")).toMatchObject({ ok: false, refusal: "invalid" });
    expect(existsSync(join(dir, "x.yaml"))).toBe(true);
  });
});
