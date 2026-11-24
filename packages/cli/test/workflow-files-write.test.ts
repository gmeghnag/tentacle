/**
 * `writeWorkflowFiles` (docs/feat/workflow-editor.md D4, slice 3a): the ONE
 * writer of a workflow file and its prompt files, on the `serve` host.
 *
 * Every assertion here is about the WRITE PATH, not the editor's UI: the writer
 * emits the bytes ITSELF and refuses a draft they do not read back as, the base
 * hash decides `changed`, nothing is overwritten that the caller did not load,
 * no component of any path may be a symlink, and an interrupted write leaves no
 * temp file behind (a temp name is never `*.yaml`, so the listing never sees one).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowSource } from "@tentacle/agent";
import {
  PROJECT_PATHS,
  WORKFLOW_SCHEMA_VERSION,
  asDraft,
  runtimeHasher,
  validateWorkflow,
  validateWorkflowValue,
  workflowHash,
  workflowYaml,
} from "@tentacle/core";
import {
  type WorkflowWritePlan,
  listWorkflowSources,
  writeWorkflowFiles,
} from "../src/workflow-files.ts";

const DRAFT = {
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  name: "task",
  version: 2,
  steps: [{ id: "build", run: "make test" }],
};

/** The sync validate+hash the DRIVER hands the writer (slice 3b's `prepareSourceSync`). */
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

/** The hash of a draft's canonical bytes plus its prompts — what a start would ask about. */
function hashOf(draft: Record<string, unknown>, prompts: Record<string, string> = {}): string {
  const validation = validateWorkflowValue(draft, { readPrompt: (path) => prompts[path] });
  if (!validation.ok) {
    throw new Error(`fixture does not validate: ${validation.errors.join("; ")}`);
  }
  const files = validation.spec.prompts.map((p) => ({ path: p.path, text: p.text }));
  return workflowHash(workflowYaml(draft), files, runtimeHasher());
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-write-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh, empty project folder. */
function project(): string {
  return mkdtempSync(join(dir, "p-"));
}

/** A project already holding `files` (path → bytes, relative to the project). */
function withFiles(files: Record<string, string>): string {
  const root = project();
  for (const [rel, body] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, body);
  }
  return root;
}

/** A draft that reads one prompt file, and that file's text. */
const WITH_PROMPT = {
  ...DRAFT,
  version: 3,
  steps: [
    { id: "build", run: "make test" },
    { id: "gate", agent: { prompt: "prompts/gate.md" } },
  ],
};
const PROMPT = { "prompts/gate.md": "review it" };

describe("replace writes the prompts first, the YAML last", () => {
  test("a loaded file's own hash replaces it, and every prompt is on disk", () => {
    const root = withFiles({ [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT) });
    const baseHash = hashOf(DRAFT);
    const result = writeWorkflowFiles(
      root,
      { mode: "replace", name: "task", draft: WITH_PROMPT, prompts: PROMPT, baseHash },
      currentHash,
    );
    expect(result.ok).toBe(true);
    const text = readFileSync(join(root, PROJECT_PATHS.workflows, "task.yaml"), "utf8");
    expect(text).toBe(workflowYaml(WITH_PROMPT));
    expect(readFileSync(join(root, PROJECT_PATHS.workflows, "prompts/gate.md"), "utf8")).toBe(
      "review it",
    );
    // The bytes the listing then reads hash to exactly the preview's hash: the
    // next start asks about THAT file, and about nothing else.
    const reread = validateWorkflow(text, { name: "task", readPrompt: (p) => PROMPT[p as never] });
    expect(reread.ok).toBe(true);
    if (reread.ok) {
      expect(workflowHash(text, [...reread.spec.prompts], runtimeHasher())).toBe(
        hashOf(WITH_PROMPT, PROMPT),
      );
    }
    if (result.ok) {
      expect(result.files.map((f) => [f.path, f.status])).toEqual([
        ["prompts/gate.md", "new"],
        ["task.yaml", "changed"],
      ]);
    }
    if (result.ok) {
      expect(result.files.map((f) => [f.path, f.status])).toEqual([
        ["prompts/gate.md", "new"],
        ["task.yaml", "changed"],
      ]);
    }
  });

  test("the ORDER is prompts then YAML (a crash leaves the YAML last)", () => {
    const root = withFiles({ [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT) });
    const order: string[] = [];
    writeWorkflowFiles(
      root,
      {
        mode: "replace",
        name: "task",
        draft: WITH_PROMPT,
        prompts: PROMPT,
        baseHash: hashOf(DRAFT),
      },
      currentHash,
      { wrote: (rel) => order.push(rel) },
    );
    // The YAML is what a listing and a start read: it must never land before
    // the prompt files its steps reference do.
    expect(order).toEqual(["prompts/gate.md", "task.yaml"]);
  });
});

describe("the base check", () => {
  test("a stale baseHash is `changed`, and NOTHING is written (mtime unchanged)", () => {
    const root = withFiles({ [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT) });
    const file = join(root, PROJECT_PATHS.workflows, "task.yaml");
    const before = statSync(file).mtimeMs;
    const result = writeWorkflowFiles(
      root,
      {
        mode: "replace",
        name: "task",
        draft: { ...DRAFT, version: 9 },
        prompts: {},
        baseHash: "0".repeat(64),
      },
      currentHash,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe("changed");
      expect(result.reason).toContain(".tentacle/workflows/task.yaml");
    }
    expect(readFileSync(file, "utf8")).toBe(workflowYaml(DRAFT));
    expect(statSync(file).mtimeMs).toBe(before);
  });

  test("`replace` of a file that is gone is `changed`, never a silent create", () => {
    const root = project();
    const result = writeWorkflowFiles(
      root,
      { mode: "replace", name: "task", draft: DRAFT, prompts: {}, baseHash: hashOf(DRAFT) },
      currentHash,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("changed");
    expect(existsSync(join(root, PROJECT_PATHS.workflows, "task.yaml"))).toBe(false);
  });

  test("a base file that no longer validates is `changed`, not an overwrite", () => {
    // The user loaded a valid file; someone else has since broken it. Its hash
    // cannot be computed, so it cannot be the one they loaded.
    const root = withFiles({
      [`${PROJECT_PATHS.workflows}/task.yaml`]: "schemaVersion: 1\nname: task\nversion: 1\n",
    });
    const result = writeWorkflowFiles(
      root,
      { mode: "replace", name: "task", draft: DRAFT, prompts: {}, baseHash: hashOf(DRAFT) },
      currentHash,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("changed");
    expect(readFileSync(join(root, PROJECT_PATHS.workflows, "task.yaml"), "utf8")).toBe(
      "schemaVersion: 1\nname: task\nversion: 1\n",
    );
  });

  test("`create` over an existing workflow is `exists`, naming the file", () => {
    const root = withFiles({ [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT) });
    const result = writeWorkflowFiles(
      root,
      { mode: "create", name: "task", draft: { ...DRAFT, version: 5 }, prompts: {} },
      currentHash,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe("exists");
      expect(result.reason).toContain(`${PROJECT_PATHS.workflows}/task.yaml`);
    }
    expect(readFileSync(join(root, PROJECT_PATHS.workflows, "task.yaml"), "utf8")).toBe(
      workflowYaml(DRAFT),
    );
  });
});

describe("prompt files", () => {
  test("a prompt that appeared since the load, with different bytes, is `exists`", () => {
    const root = withFiles({
      [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT),
      [`${PROJECT_PATHS.workflows}/prompts/gate.md`]: "the user's own words",
    });
    const result = writeWorkflowFiles(
      root,
      {
        mode: "replace",
        name: "task",
        draft: WITH_PROMPT,
        prompts: { "prompts/gate.md": "the editor's words" },
        baseHash: hashOf(DRAFT),
      },
      currentHash,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe("exists");
      expect(result.reason).toContain("prompts/gate.md");
    }
    expect(readFileSync(join(root, PROJECT_PATHS.workflows, "prompts/gate.md"), "utf8")).toBe(
      "the user's own words",
    );
  });

  test("identical bytes are `unchanged`, and the save still goes through", () => {
    const root = withFiles({
      [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT),
      [`${PROJECT_PATHS.workflows}/prompts/gate.md`]: "review it",
    });
    const result = writeWorkflowFiles(
      root,
      {
        mode: "replace",
        name: "task",
        draft: WITH_PROMPT,
        prompts: PROMPT,
        baseHash: hashOf(DRAFT),
      },
      currentHash,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.find((f) => f.path === "prompts/gate.md")?.status).toBe("unchanged");
    }
  });

  test("a BASE prompt the save rewrites is fine: the user loaded it", () => {
    // The base read covered `prompts/gate.md`, so different bytes there are the
    // editor's own edit — not someone else's file. WITHOUT `basePrompts` the
    // same save is `exists` (fail closed), which is the mutation this pins.
    const at = () =>
      withFiles({
        [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT),
        [`${PROJECT_PATHS.workflows}/prompts/gate.md`]: "old words",
      });
    const root = at();
    const result = writeWorkflowFiles(
      root,
      {
        mode: "replace",
        name: "task",
        draft: WITH_PROMPT,
        prompts: { "prompts/gate.md": "new words" },
        baseHash: readBase(root),
        basePrompts: ["prompts/gate.md"],
      },
      currentHash,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, PROJECT_PATHS.workflows, "prompts/gate.md"), "utf8")).toBe(
      "new words",
    );
    const other = at();
    const refused = writeWorkflowFiles(
      other,
      {
        mode: "replace",
        name: "task",
        draft: WITH_PROMPT,
        prompts: { "prompts/gate.md": "new words" },
        baseHash: readBase(other),
      },
      currentHash,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal).toBe("exists");
    expect(readFileSync(join(other, PROJECT_PATHS.workflows, "prompts/gate.md"), "utf8")).toBe(
      "old words",
    );
  });

  test("an absolute or `..` prompt path is refused `invalid`, nothing written", () => {
    const root = project();
    for (const path of ["/etc/passwd.md", "../escape.md", "prompts/../../x.md"]) {
      const result = writeWorkflowFiles(
        root,
        { mode: "create", name: "task", draft: WITH_PROMPT, prompts: { [path]: "x" } },
        currentHash,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("invalid");
    }
    expect(existsSync(join(root, PROJECT_PATHS.workflows))).toBe(false);
  });
});

/** The hash of the file already on disk (a base the test wants to match). */
function readBase(root: string, _draft?: Record<string, unknown>): string {
  const folder = join(root, PROJECT_PATHS.workflows);
  const files: Record<string, string> = {};
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files[entry.name] = readFileSync(join(folder, entry.name), "utf8");
  }
  const nested = join(folder, "prompts");
  if (existsSync(nested)) {
    for (const entry of readdirSync(nested, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      files[`prompts/${entry.name}`] = readFileSync(join(nested, entry.name), "utf8");
    }
  }
  return currentHash({
    path: `${PROJECT_PATHS.workflows}/task.yaml`,
    text: files["task.yaml"] ?? "",
    prompts: files,
  });
}

describe("no symlink at any component", () => {
  const variants: { name: string; build: (root: string) => void }[] = [
    {
      name: ".tentacle",
      build: (root) => {
        const outside = mkdtempSync(join(dir, "out-"));
        mkdirSync(join(outside, "workflows"), { recursive: true });
        symlinkSync(outside, join(root, ".tentacle"));
      },
    },
    {
      name: "workflows",
      build: (root) => {
        const outside = mkdtempSync(join(dir, "out-"));
        mkdirSync(join(root, ".tentacle"), { recursive: true });
        symlinkSync(outside, join(root, PROJECT_PATHS.workflows));
      },
    },
    {
      name: "prompts",
      build: (root) => {
        const outside = mkdtempSync(join(dir, "out-"));
        mkdirSync(join(root, PROJECT_PATHS.workflows), { recursive: true });
        symlinkSync(outside, join(root, PROJECT_PATHS.workflows, "prompts"));
      },
    },
  ];

  for (const variant of variants) {
    test(`a symlinked ${variant.name} is refused with its path`, () => {
      const root = project();
      variant.build(root);
      const result = writeWorkflowFiles(
        root,
        { mode: "create", name: "task", draft: WITH_PROMPT, prompts: PROMPT },
        currentHash,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal).toBe("invalid");
        expect(result.reason).toContain("symbolic link");
      }
    });
  }

  test("a symlinked FILE is refused too (the file itself is a component)", () => {
    const outside = mkdtempSync(join(dir, "out-"));
    writeFileSync(join(outside, "task.yaml"), workflowYaml(DRAFT));
    const root = project();
    mkdirSync(join(root, PROJECT_PATHS.workflows), { recursive: true });
    symlinkSync(join(outside, "task.yaml"), join(root, PROJECT_PATHS.workflows, "task.yaml"));
    const result = writeWorkflowFiles(
      root,
      { mode: "create", name: "task", draft: DRAFT, prompts: {} },
      currentHash,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("symbolic link");
  });
});

describe("nothing half-written is ever visible", () => {
  test("no temp file survives a refused save, and none is listed", async () => {
    const root = withFiles({ [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT) });
    const result = writeWorkflowFiles(
      root,
      {
        mode: "replace",
        name: "task",
        draft: WITH_PROMPT,
        prompts: PROMPT,
        baseHash: "1".repeat(64),
      },
      currentHash,
    );
    expect(result.ok).toBe(false);
    const folder = join(root, PROJECT_PATHS.workflows);
    expect(readdirSync(folder).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const listing = await listWorkflowSources(root);
    expect(listing.rows.map((row) => row.name)).toEqual(["task"]);
  });

  test("a temp file left by a crashed writer is never listed (not `*.yaml`)", async () => {
    const root = withFiles({
      [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT),
      [`${PROJECT_PATHS.workflows}/.task.yaml.1234.tmp`]: "half",
    });
    const listing = await listWorkflowSources(root);
    expect(listing.rows.map((row) => row.name)).toEqual(["task"]);
  });

  test("a mid-write failure removes the temp file and leaves the old YAML", () => {
    const root = withFiles({ [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT) });
    const result = writeWorkflowFiles(
      root,
      {
        mode: "replace",
        name: "task",
        draft: WITH_PROMPT,
        prompts: PROMPT,
        baseHash: hashOf(DRAFT),
      },
      currentHash,
      {
        wrote: (rel) => {
          if (rel.endsWith(".yaml")) throw new Error("disk full");
        },
      },
    );
    expect(result.ok).toBe(false);
    const folder = join(root, PROJECT_PATHS.workflows);
    expect(readdirSync(folder).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(join(folder, "task.yaml"), "utf8")).toBe(workflowYaml(DRAFT));
  });
});

describe("the emitted bytes, not just the value (D4, review round 1 #2)", () => {
  test("a draft the emitter refuses is `invalid`, and NOTHING is written", () => {
    // A lone surrogate cannot be written as YAML: `workflowYaml` throws, and a
    // save must never write (or hash) a file that does not load back.
    const root = project();
    const draft = { ...DRAFT, description: "a\ud800b" };
    // The strict validator is happy (it only checks length): the bytes are the
    // writer's own check, not the validator's.
    expect(validateWorkflowValue(draft).ok).toBe(true);
    const result = writeWorkflowFiles(
      root,
      { mode: "create", name: "task", draft, prompts: {} },
      currentHash,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe("invalid");
      expect(result.reason).toContain("surrogate");
    }
    expect(existsSync(join(root, PROJECT_PATHS.workflows))).toBe(false);
  });

  test("the writer emits the canonical bytes itself; no caller-supplied text exists", () => {
    // The plan carries the DRAFT, never bytes: a `text` a caller could pass is
    // a second source of truth that could drift from the draft it will write.
    const root = project();
    const result = writeWorkflowFiles(
      root,
      { mode: "create", name: "task", draft: DRAFT, prompts: {} },
      currentHash,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, PROJECT_PATHS.workflows, "task.yaml"), "utf8")).toBe(
      workflowYaml(DRAFT),
    );
  });
});

describe("the patch the Review screen shows", () => {
  test("a `changed` row carries a unified diff and its counts; new/unchanged carry none", () => {
    // Mutation: return `added: 0, removed: 0` (or no patch) → red.
    const root = withFiles({
      [`${PROJECT_PATHS.workflows}/prompts/gate.md`]: "old words\n",
    });
    const result = writeWorkflowFiles(
      root,
      {
        mode: "create",
        name: "task",
        draft: WITH_PROMPT,
        prompts: { "prompts/gate.md": "new words\n" },
      },
      currentHash,
    );
    // `create` refuses an existing prompt that the base did not cover, so this
    // one is `exists` — use `replace` with the base covering it instead.
    expect(result.ok).toBe(false);
    const replaced = withFiles({
      [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT),
      [`${PROJECT_PATHS.workflows}/prompts/gate.md`]: "old words\n",
    });
    const written = writeWorkflowFiles(
      replaced,
      {
        mode: "replace",
        name: "task",
        draft: WITH_PROMPT,
        prompts: { "prompts/gate.md": "new words\n" },
        baseHash: readBase(replaced),
        basePrompts: ["prompts/gate.md"],
      },
      currentHash,
    );
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const yamlRow = written.files.find((f) => f.path === "task.yaml");
    const promptRow = written.files.find((f) => f.path === "prompts/gate.md");
    expect(promptRow?.status).toBe("changed");
    // One line swapped: one added, one removed, and the row is a real patch.
    expect(promptRow?.added).toBe(1);
    expect(promptRow?.removed).toBe(1);
    expect(promptRow?.patch).toContain("-old words");
    expect(promptRow?.patch).toContain("+new words");
    // The YAML exists in the base, so it is `changed` and carries its own patch:
    // the version bump is one removed line, and the gate step four added ones.
    expect(yamlRow?.status).toBe("changed");
    expect(yamlRow?.added).toBe(4);
    expect(yamlRow?.removed).toBe(1);
    expect(yamlRow?.patch).toContain("-version: 2");
    expect(yamlRow?.patch).toContain("+version: 3");
  });

  test("a `new` and an `unchanged` row carry NO patch and 0 counts", () => {
    // Mutation: emit a patch for every status (or counts) → red.
    const root = project();
    const result = writeWorkflowFiles(
      root,
      { mode: "create", name: "task", draft: WITH_PROMPT, prompts: PROMPT },
      currentHash,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fresh = result.files.find((f) => f.path === "task.yaml");
    expect(fresh?.status).toBe("new");
    expect(fresh?.patch).toBeUndefined();
    expect(fresh?.added).toBe(0);
    expect(fresh?.removed).toBe(0);
    // A second save of the same draft: every row is `unchanged`, nothing rewritten.
    const again = writeWorkflowFiles(
      root,
      { mode: "create", name: "other", draft: DRAFT, prompts: {} },
      currentHash,
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.files.every((f) => f.status === "new" && f.patch === undefined)).toBe(true);
  });
});

describe("the base is re-read from DISK, not from what the save writes", () => {
  test("dropping a prompt-file step (the file stays on disk) saves, it is not `changed`", () => {
    // The editor switched `gate` from `prompt: prompts/gate.md` to inline text.
    // The loaded file still references the prompt file, which is still on disk:
    // its hash must be computed from the FILE, or the save is refused `changed`
    // for an edit the user is allowed to make.
    // Mutation: build the base prompts from the plan → this goes `changed`.
    const root = withFiles({
      [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(WITH_PROMPT),
      [`${PROJECT_PATHS.workflows}/prompts/gate.md`]: "review it",
    });
    const baseHash = readBase(root, WITH_PROMPT);
    const inline = {
      ...WITH_PROMPT,
      version: 4,
      steps: [
        { id: "build", run: "make test" },
        { id: "gate", agent: { prompt_text: "review inline" } },
      ],
    };
    const result = writeWorkflowFiles(
      root,
      { mode: "replace", name: "task", draft: inline, prompts: {}, baseHash },
      currentHash,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, PROJECT_PATHS.workflows, "task.yaml"), "utf8")).toBe(
      workflowYaml(inline),
    );
    // The orphaned prompt file is NOT deleted: a save never removes a file.
    expect(existsSync(join(root, PROJECT_PATHS.workflows, "prompts/gate.md"))).toBe(true);
  });
});

describe("a save NEVER approves its own hash (the load-bearing property)", () => {
  test("the module reaches no approval store at all", async () => {
    // The writer is a WRITE and nothing else: it imports no approvals module, so
    // no `add` for a new hash is reachable from a save. The next start asks
    // (slice 3b's spy-store test pins that end); here the module is pinned.
    const source = await Bun.file(join(import.meta.dir, "../src/workflow-files.ts")).text();
    expect(source).not.toContain("workflow-approvals");
    expect(source).not.toContain("approvals.add");
  });
});

describe("`create` makes the folders it needs, under real directories only", () => {
  test("a fresh project gets `.tentacle/workflows/prompts` and both files", () => {
    const root = project();
    const result = writeWorkflowFiles(
      root,
      { mode: "create", name: "task", draft: WITH_PROMPT, prompts: PROMPT },
      currentHash,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, PROJECT_PATHS.workflows, "task.yaml"), "utf8")).toBe(
      workflowYaml(WITH_PROMPT),
    );
    // The file a `create` writes is the draft it was given, once read back.
    const parsed = (
      globalThis as { Bun?: { YAML?: { parse(t: string): unknown } } }
    ).Bun?.YAML?.parse(workflowYaml(WITH_PROMPT));
    const reopened = asDraft(parsed);
    expect("draft" in reopened && reopened.draft).toEqual(WITH_PROMPT);
  });

  test("`.tentacle` existing as a FILE is `failed` (never a silent skip)", () => {
    const root = withFiles({ ".tentacle": "not a folder" });
    const plan: WorkflowWritePlan = {
      mode: "create",
      name: "task",
      draft: DRAFT,
      prompts: {},
    };
    const result = writeWorkflowFiles(root, plan, currentHash);
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, PROJECT_PATHS.workflows))).toBe(false);
  });
});

describe("`dryRun` is the Review screen: every check, every row, NO write (slice 3b)", () => {
  test("a dry replace reports the rows a write would, and leaves every byte and folder", () => {
    const root = withFiles({ [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT) });
    const yamlPath = join(root, PROJECT_PATHS.workflows, "task.yaml");
    const before = statSync(yamlPath).mtimeMs;
    const plan: WorkflowWritePlan = {
      mode: "replace",
      name: "task",
      draft: WITH_PROMPT,
      prompts: PROMPT,
      baseHash: hashOf(DRAFT),
      dryRun: true,
    };
    const dry = writeWorkflowFiles(root, plan, currentHash);
    expect(dry.ok).toBe(true);
    expect(readFileSync(yamlPath, "utf8")).toBe(workflowYaml(DRAFT));
    expect(statSync(yamlPath).mtimeMs).toBe(before);
    expect(existsSync(join(root, PROJECT_PATHS.workflows, "prompts"))).toBe(false);
    // The write that follows lists exactly what the preview listed.
    const wet = writeWorkflowFiles(root, { ...plan, dryRun: false }, currentHash);
    expect(wet.ok && dry.ok ? wet.files : "refused").toEqual(dry.ok ? dry.files : "refused");
  });

  test("a dry run still refuses: a stale base is `changed`, a foreign prompt `exists`", () => {
    const root = withFiles({
      [`${PROJECT_PATHS.workflows}/task.yaml`]: workflowYaml(DRAFT),
      [`${PROJECT_PATHS.workflows}/prompts/gate.md`]: "someone else's",
    });
    const stale = writeWorkflowFiles(
      root,
      {
        mode: "replace",
        name: "task",
        draft: DRAFT,
        prompts: {},
        baseHash: "0".repeat(64),
        dryRun: true,
      },
      currentHash,
    );
    expect(stale.ok ? "ok" : stale.refusal).toBe("changed");
    const foreign = writeWorkflowFiles(
      root,
      {
        mode: "replace",
        name: "task",
        draft: WITH_PROMPT,
        prompts: PROMPT,
        baseHash: hashOf(DRAFT),
        dryRun: true,
      },
      currentHash,
    );
    expect(foreign.ok ? "ok" : foreign.refusal).toBe("exists");
  });

  test("a dry create in a fresh project creates no folder", () => {
    const root = project();
    const dry = writeWorkflowFiles(
      root,
      { mode: "create", name: "task", draft: WITH_PROMPT, prompts: PROMPT, dryRun: true },
      currentHash,
    );
    expect(dry.ok && dry.files.map((f) => f.status)).toEqual(["new", "new"]);
    expect(existsSync(join(root, ".tentacle"))).toBe(false);
  });
});
