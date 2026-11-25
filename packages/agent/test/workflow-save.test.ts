/**
 * The driver's `source` / `save` (docs/feat/workflow-editor.md D4, slice 3b),
 * fakes only: an in-memory workflow folder (load / list / save), a SPY approval
 * store and the session's ONE requester as a spy broker.
 *
 * The load-bearing pair: a save writes bytes and NOTHING else — the store sees
 * zero `add`, the broker zero asks — and the next start asks exactly ONE
 * `workflow_approve` through the ONE requester. So no client can approve its own
 * input by saving it.
 */
import { describe, expect, test } from "bun:test";
import {
  PROJECT_PATHS,
  type PermissionRequest,
  type PermissionRequester,
  type PermissionResponse,
  type ToolContext,
  WORKFLOW_FILE_MAX_BYTES,
  WORKFLOW_SCHEMA_VERSION,
  workflowYaml,
} from "@tentacle/core";
import type { SubagentResult, SubagentRunner } from "../src/subagent.ts";
import {
  WorkflowDriver,
  type WorkflowDriverDeps,
  type WorkflowListing,
  type WorkflowSaveWritePlan,
  type WorkflowSaveWriteResult,
  type WorkflowSource,
  checkedWorkflowBytes,
} from "../src/workflow-driver.ts";

const DIR = PROJECT_PATHS.workflows;

const DRAFT = {
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  name: "task",
  version: 3,
  steps: [
    { id: "plan", agent: { prompt_text: "plan it" } },
    { id: "exec", agent: { prompt_text: "do it" } },
  ],
};

/** The same workflow, its second step reading a prompt FILE. */
const WITH_PROMPT = {
  ...DRAFT,
  version: 4,
  steps: [
    { id: "plan", agent: { prompt_text: "plan it" } },
    { id: "exec", agent: { prompt: "prompts/exec.md" } },
  ],
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

/** The session's ONE requester: records every ask; `auto` answers some. */
class SpyBroker {
  readonly asks: PermissionRequest[] = [];
  auto: ((req: PermissionRequest) => PermissionResponse | undefined) | undefined;
  readonly request: PermissionRequester = (req) =>
    new Promise<PermissionResponse>((resolve) => {
      this.asks.push(req);
      const preset = this.auto?.(req);
      if (preset !== undefined) resolve(preset);
    });
}

/**
 * A workflow folder in memory, keyed `.tentacle/workflows/`-relative. `save`
 * keeps the writer's contract (base check, `exists`, dry run writes nothing);
 * the real writer's own tests are `cli/test/workflow-files-write.test.ts`.
 */
function setup(files: Record<string, string> = {}) {
  const disk = new Map<string, string>(Object.entries(files));
  const broker = new SpyBroker();
  const store = { has: 0, add: 0, keys: new Set<string>() };
  const saves: WorkflowSaveWritePlan[] = [];
  const load = async (name: string): Promise<WorkflowSource> => {
    const text = disk.get(`${name}.yaml`);
    if (text === undefined) throw new Error(`no workflow ${name}`);
    return { path: `${DIR}/${name}.yaml`, text, prompts: Object.fromEntries(disk) };
  };
  const loadSync = (name: string): WorkflowSource | undefined => {
    const text = disk.get(`${name}.yaml`);
    return text === undefined
      ? undefined
      : { path: `${DIR}/${name}.yaml`, text, prompts: Object.fromEntries(disk) };
  };
  const save = (
    plan: WorkflowSaveWritePlan,
    currentHash: (source: WorkflowSource) => string,
  ): WorkflowSaveWriteResult => {
    saves.push(plan);
    const yamlRel = `${plan.name}.yaml`;
    const base = loadSync(plan.name);
    if (plan.mode === "replace") {
      let actual: string | undefined;
      try {
        actual = base === undefined ? undefined : currentHash(base);
      } catch {
        actual = undefined;
      }
      if (actual !== plan.baseHash) {
        return { ok: false, refusal: "changed", reason: `${yamlRel} changed`, files: [] };
      }
    } else if (base !== undefined) {
      return { ok: false, refusal: "exists", reason: `${yamlRel} already exists`, files: [] };
    }
    const targets: [string, string][] = [
      ...Object.entries(plan.prompts),
      [yamlRel, workflowYaml(plan.draft)],
    ];
    const rows = targets.map(([rel, text]) => {
      const before = disk.get(rel);
      const status =
        before === undefined ? "new" : before === text ? "unchanged" : ("changed" as const);
      return { path: rel, status, added: 0, removed: 0 } as const;
    });
    if (!plan.dryRun) {
      for (const [rel, text] of targets) disk.set(rel, text);
    }
    return { ok: true, files: rows };
  };
  const list = async (): Promise<WorkflowListing> => ({
    dir: `/project/${DIR}`,
    truncated: false,
    rows: [...disk.keys()]
      .filter((rel) => rel.endsWith(".yaml"))
      .map((rel) => {
        const name = rel.slice(0, -".yaml".length);
        const source = loadSync(name);
        return source === undefined
          ? { kind: "invalid" as const, name, path: `${DIR}/${rel}`, problem: "gone" }
          : { kind: "source" as const, name, source };
      }),
  });
  /** A child whose run is held until `release()`: a run "in flight". */
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runnerFor =
    (): SubagentRunner =>
    async (_opts, controls): Promise<SubagentResult> => {
      await held;
      const tool = controls?.extraTools?.find((t) => t.name === "step_verdict");
      await tool?.execute({ verdict: "pass", reason: "ok" }, {} as ToolContext);
      return { report: "done", toolUses: 1, stopReason: "end_turn" };
    };
  const deps: WorkflowDriverDeps = {
    load,
    list,
    save,
    context: () => ({ models: ["opus", "deepseek"], agentTypes: ["general"] }),
    approvals: {
      has: async (path, hash) => {
        store.has += 1;
        return store.keys.has(`${path}#${hash}`);
      },
      add: async (path, hash) => {
        store.add += 1;
        store.keys.add(`${path}#${hash}`);
      },
    },
    request: broker.request,
    runnerFor,
  };
  const driver = new WorkflowDriver(deps);
  driver.bind({
    logStart: () => {},
    logStep: () => {},
    logEnd: () => {},
    attribute: () => {},
    release: () => {},
    publish: () => {},
    ended: () => {},
  });
  return { driver, broker, store, disk, saves, deps, release: () => release() };
}

const json = (draft: unknown): unknown => JSON.parse(JSON.stringify(draft));

describe("the load-bearing pair: a save never approves (D4)", () => {
  test("(a) a written save: ZERO `approvals.add`, ZERO asks — and the bytes are on disk", async () => {
    const { driver, broker, store, disk } = setup({ "task.yaml": workflowYaml(DRAFT) });
    const opened = await driver.source("task");
    const saved = await driver.save({
      name: "task",
      mode: "replace",
      draft: json(WITH_PROMPT),
      prompts: { "prompts/exec.md": "do it from a file" },
      ...(opened.hash !== undefined ? { baseHash: opened.hash } : {}),
      dryRun: false,
    });
    expect(saved.ok).toBe(true);
    expect(disk.get("task.yaml")).toBe(workflowYaml(WITH_PROMPT));
    expect(store.add).toBe(0);
    expect(broker.asks).toEqual([]);
    expect(saved.approved).toBe(false);
  });

  test("(b) the next start asks EXACTLY ONE `workflow_approve` through the ONE requester", async () => {
    const { driver, broker, store } = setup({ "task.yaml": workflowYaml(DRAFT) });
    const opened = await driver.source("task");
    await driver.save({
      name: "task",
      mode: "replace",
      draft: json(WITH_PROMPT),
      prompts: { "prompts/exec.md": "do it from a file" },
      ...(opened.hash !== undefined ? { baseHash: opened.hash } : {}),
      dryRun: false,
    });
    const started = await driver.start({ name: "task", by: "user" });
    expect(started.ok).toBe(true);
    await flush();
    expect(broker.asks.map((a) => a.kind)).toEqual(["workflow_approve"]);
    expect(store.add).toBe(0);
  });
});

describe("one validator, one hash", () => {
  test("the preview hash IS the hash the next catalogue row reports, and the source's after", async () => {
    const { driver, disk } = setup({ "task.yaml": workflowYaml(DRAFT) });
    const opened = await driver.source("task");
    const request = {
      name: "task",
      mode: "replace" as const,
      draft: json(WITH_PROMPT),
      prompts: { "prompts/exec.md": "do it from a file" },
      ...(opened.hash !== undefined ? { baseHash: opened.hash } : {}),
    };
    const preview = await driver.save({ ...request, dryRun: true });
    expect(preview.ok).toBe(true);
    expect(preview.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.hash).not.toBe(opened.hash);
    // A dry run wrote nothing.
    expect(disk.get("task.yaml")).toBe(workflowYaml(DRAFT));
    expect(disk.has("prompts/exec.md")).toBe(false);
    const written = await driver.save({ ...request, dryRun: false });
    expect(written.hash).toBeDefined();
    expect(preview.hash).toBeDefined();
    if (written.hash === undefined || preview.hash === undefined) return;
    expect(written.hash).toBe(preview.hash);
    const row = (await driver.catalogue()).workflows.find((w) => w.name === "task");
    expect(row?.hash).toBe(written.hash);
    expect((await driver.source("task")).hash).toBe(written.hash);
  });

  test("`dryRun` reaches the writer as a dry run (the real writer's no-write is pinned in cli)", async () => {
    const { driver, saves, disk } = setup({});
    const preview = await driver.save({
      name: "task",
      mode: "create",
      draft: json(DRAFT),
      prompts: {},
      dryRun: true,
    });
    expect(preview.ok).toBe(true);
    expect(saves.map((s) => s.dryRun)).toEqual([true]);
    expect(disk.size).toBe(0);
    expect(preview.files?.map((f) => [f.path, f.status])).toEqual([[`${DIR}/task.yaml`, "new"]]);
    expect(preview.path).toBe(`${DIR}/task.yaml`);
  });
});

describe("what a save refuses, writing nothing", () => {
  test("a prompt no step reads is `invalid`: nothing written can sit outside the hash", async () => {
    const { driver, saves } = setup({});
    const result = await driver.save({
      name: "task",
      mode: "create",
      draft: json(DRAFT),
      prompts: { "prompts/stray.md": "nobody reads me" },
      dryRun: false,
    });
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("invalid");
    expect(result.reason).toContain("prompts/stray.md is not used by any step");
    expect(saves).toEqual([]);
  });

  test("an unknown draft field is `invalid` naming it — never dropped from the saved file", async () => {
    const { driver, saves } = setup({});
    const result = await driver.save({
      name: "task",
      mode: "create",
      draft: { ...(json(DRAFT) as object), colour: "blue" },
      prompts: {},
      dryRun: false,
    });
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("colour");
    expect(saves).toEqual([]);
  });

  test("a draft whose bytes cannot be written (a lone surrogate) is `invalid`, nothing written", async () => {
    const { driver, saves } = setup({});
    const result = await driver.save({
      name: "task",
      mode: "create",
      draft: { ...DRAFT, description: "a\ud800b" },
      prompts: {},
      dryRun: false,
    });
    expect(result.refusal).toBe("invalid");
    expect(result.reason).toContain("surrogate");
    expect(saves).toEqual([]);
  });

  test("YAML over the loader's file cap is `invalid`, nothing written (it would never load back)", async () => {
    const { driver, saves } = setup({});
    // Valid, and under the wire's 512 KiB draft cap — but its YAML is ~300 KB.
    const big = {
      ...DRAFT,
      steps: [{ id: "plan", agent: { prompt_text: "word ".repeat(60_000) } }],
    };
    expect(Buffer.byteLength(workflowYaml(big))).toBeGreaterThan(WORKFLOW_FILE_MAX_BYTES);
    for (const dryRun of [true, false]) {
      const result = await driver.save({
        name: "task",
        mode: "create",
        draft: big,
        prompts: {},
        dryRun,
      });
      expect(result.refusal).toBe("invalid");
      expect(result.hash).toBeUndefined();
      expect(result.reason).toContain(`${WORKFLOW_FILE_MAX_BYTES}`);
    }
    expect(saves).toEqual([]);
    // The bound is the loader's `size <= max`, in UTF-8 BYTES (not UTF-16 units).
    const back = () => DRAFT;
    const at = checkedWorkflowBytes(DRAFT, () => "x".repeat(WORKFLOW_FILE_MAX_BYTES), back);
    expect("text" in at).toBe(true);
    const over = checkedWorkflowBytes(DRAFT, () => "x".repeat(WORKFLOW_FILE_MAX_BYTES + 1), back);
    expect("reason" in over).toBe(true);
    const wide = checkedWorkflowBytes(
      DRAFT,
      () => "é".repeat(WORKFLOW_FILE_MAX_BYTES / 2 + 1),
      back,
    );
    expect("reason" in wide).toBe(true);
  });

  test("bytes that do not read back as the draft are `invalid` (a stubbed emitter)", () => {
    const checked = checkedWorkflowBytes(DRAFT, () => workflowYaml({ ...DRAFT, version: 9 }));
    expect("reason" in checked ? checked.reason : "wrote").toContain("does not read back");
    const fine = checkedWorkflowBytes(DRAFT);
    expect("text" in fine ? fine.text : "").toBe(workflowYaml(DRAFT));
  });

  test("the writer's own refusal is carried as is (`changed`)", async () => {
    const { driver } = setup({ "task.yaml": workflowYaml(DRAFT) });
    const result = await driver.save({
      name: "task",
      mode: "replace",
      draft: json(WITH_PROMPT),
      prompts: { "prompts/exec.md": "x" },
      baseHash: "0".repeat(64),
      dryRun: false,
    });
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("changed");
  });

  test("no writer wired: `unavailable`, never a silent success", async () => {
    const { deps } = setup({});
    const { save: _save, ...rest } = deps;
    const driver = new WorkflowDriver(rest);
    const result = await driver.save({
      name: "task",
      mode: "create",
      draft: json(DRAFT),
      prompts: {},
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("unavailable");
    expect((await driver.source("task")).unavailable).toBeDefined();
  });
});

describe("what Review learns about the rest of the project", () => {
  test("a run in flight is named, and it keeps its own hash after the save", async () => {
    const { driver, broker } = setup({ "task.yaml": workflowYaml(DRAFT) });
    broker.auto = (req) => (req.kind === "workflow_approve" ? { allowed: true } : undefined);
    const started = await driver.start({ name: "task", by: "user" });
    await flush();
    const runId = started.ok ? started.runId : "";
    const before = driver.rows().find((r) => r.runId === runId)?.hash;
    const opened = await driver.source("task");
    const saved = await driver.save({
      name: "task",
      mode: "replace",
      draft: json({ ...DRAFT, version: 5 }),
      prompts: {},
      ...(opened.hash !== undefined ? { baseHash: opened.hash } : {}),
      dryRun: false,
    });
    expect(saved.ok).toBe(true);
    expect(saved.running).toBe(runId);
    expect(before).toBeDefined();
    if (before === undefined) return;
    expect(driver.rows().find((r) => r.runId === runId)?.hash).toBe(before);
    expect(before).not.toBe(saved.hash);
  });

  test("a prompt another workflow also reads: `alsoChanges` names it", async () => {
    const other = { ...WITH_PROMPT, name: "other" };
    const { driver } = setup({
      "task.yaml": workflowYaml({ ...WITH_PROMPT }),
      "other.yaml": workflowYaml(other),
      "solo.yaml": workflowYaml({ ...DRAFT, name: "solo" }),
      "prompts/exec.md": "v1",
    });
    const opened = await driver.source("task");
    const saved = await driver.save({
      name: "task",
      mode: "replace",
      draft: json(WITH_PROMPT),
      prompts: { "prompts/exec.md": "v2" },
      ...(opened.hash !== undefined ? { baseHash: opened.hash } : {}),
      dryRun: true,
    });
    expect(saved.ok).toBe(true);
    expect(saved.alsoChanges).toEqual(["other"]);
  });
});

describe("source: what an editor opens", () => {
  test("a valid file: its draft, ONLY its referenced prompts, its hash, canonical, the context", async () => {
    const { driver } = setup({
      "task.yaml": workflowYaml(WITH_PROMPT),
      "prompts/exec.md": "v1",
      "prompts/unrelated.md": "not this workflow's",
      "other.yaml": workflowYaml({ ...DRAFT, name: "other" }),
    });
    const opened = await driver.source("task");
    expect(opened.ok).toBe(true);
    expect(opened.path).toBe(`${DIR}/task.yaml`);
    expect(opened.draft).toEqual(WITH_PROMPT);
    expect(opened.prompts).toEqual({ "prompts/exec.md": "v1" });
    expect(opened.canonical).toBe(true);
    expect(opened.version).toBe(4);
    expect(opened.errors).toBeUndefined();
    expect(opened.context).toEqual({ models: ["opus", "deepseek"], agentTypes: ["general"] });
    const row = (await driver.catalogue()).workflows.find((w) => w.name === "task");
    expect(opened.hash).toBeDefined();
    if (opened.hash === undefined) return;
    expect(row?.hash).toBe(opened.hash);
  });

  test("a dangling `next` still OPENS: a draft, the errors, no hash", async () => {
    const text = workflowYaml({ ...DRAFT, steps: [{ id: "plan", run: "make", next: "nowhere" }] });
    const { driver } = setup({ "task.yaml": text });
    const opened = await driver.source("task");
    expect(opened.draft).toBeDefined();
    expect(opened.hash).toBeUndefined();
    expect((opened.errors ?? []).join("\n")).toContain("nowhere");
  });

  test("a commented file is not canonical; a non-mapping is unreadable; a missing one says so", async () => {
    const { driver } = setup({
      "task.yaml": `# mine\n${workflowYaml(DRAFT)}`,
      "list.yaml": "- just\n- a list\n",
    });
    expect((await driver.source("task")).canonical).toBe(false);
    const list = await driver.source("list");
    expect(list.draft).toBeUndefined();
    expect(list.unreadable).toBeDefined();
    const gone = await driver.source("gone");
    expect(gone.ok).toBe(false);
    expect(gone.unreadable).toContain("no workflow gone");
  });

  test("source never asks and never touches the store's writes", async () => {
    const { driver, broker, store } = setup({ "task.yaml": workflowYaml(DRAFT) });
    await driver.source("task");
    expect(broker.asks).toEqual([]);
    expect(store.add).toBe(0);
  });
});
