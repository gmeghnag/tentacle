/**
 * The workflow driver bound into a hosted session (docs/feat/agent-workflows.md
 * Slice 4, review round 1 #2): `session/workflow` reaches it, the rows reach the
 * snapshot, the end note rides the exits queue (it wakes), run ids are seeded
 * from the history (#1), and a session without a driver (tunnelled) refuses.
 */
import { describe, expect, test } from "bun:test";
import {
  Agent,
  Session,
  WorkflowDriver,
  type WorkflowDriverDeps,
  type WorkflowSource,
} from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  NOTE_KIND,
  PermissionBroker,
  type PermissionRequest,
  type StreamEvent,
  type Tool,
  type ToolContext,
  autoApproves,
  workflowYaml,
} from "@tentacle/core";
import type { KnownLogEntry, KnownSessionUpdateParams, LogCursor } from "@tentacle/protocol";
import { ToolRegistry, createWorkflowTool } from "@tentacle/tools";
import { z } from "zod";
import { HostedSession } from "../src/hosted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const YAML =
  "schemaVersion: 1\nname: task\nversion: 1\nsteps:\n  - id: plan\n    agent: { prompt_text: plan it }\n";

/** An `approve` step: the one step kind that asks the USER directly (D3). */
const APPROVE_YAML =
  'schemaVersion: 1\nname: task\nversion: 1\nsteps:\n  - id: merge\n    approve: { title: "Merge it" }\n';

/** A file that does not validate: the catalogue's `ok:false` row. */
const BROKEN = "schemaVersion: 1\nname: task\nversion: 0\nsteps: []\n";

function hosted(messages: ChatMessage[] = []): HostedSession {
  const agent = new Agent({
    model: {
      id: "one",
      async *stream() {
        yield { type: "done" };
      },
    },
    tools: new ToolRegistry(),
    env: noopEnv,
  });
  const session = new Session(agent);
  session.messages.push(...messages);
  return new HostedSession("s1", session, new PermissionBroker());
}

function driver(): WorkflowDriver {
  const deps: WorkflowDriverDeps = {
    load: async () => ({ path: ".tentacle/workflows/task.yaml", text: YAML, prompts: {} }),
    context: () => ({ models: [], agentTypes: ["general"] }),
    approvals: { has: async () => true, add: async () => {} },
    request: async () => ({ allowed: false }),
    runnerFor: () => async (_opts, controls) => {
      const verdict = controls?.extraTools?.find((t) => t.name === "step_verdict");
      await verdict?.execute({ verdict: "pass", reason: "planned" }, {} as ToolContext);
      return { report: "ok", toolUses: 1, stopReason: "end_turn" };
    },
  };
  return new WorkflowDriver(deps);
}

/**
 * A driver whose project folder holds one valid workflow and one broken file —
 * what a catalogue reads (slice 5a). `list` is the walk; `load` the one-name read.
 */
function listingDriver(extra: readonly WorkflowSource[] = []): WorkflowDriver {
  const task: WorkflowSource = {
    path: ".tentacle/workflows/task.yaml",
    text: YAML,
    prompts: {},
  };
  const deps: WorkflowDriverDeps = {
    load: async () => task,
    list: async () => ({
      dir: "/proj/.tentacle/workflows",
      truncated: false,
      rows: [
        { kind: "source", name: "task", source: task },
        {
          kind: "source",
          name: "broken",
          source: { path: ".tentacle/workflows/broken.yaml", text: BROKEN, prompts: {} },
        },
        ...extra.map((source) => ({
          kind: "source" as const,
          name: source.path.replace(/^.*\/|\.yaml$/g, ""),
          source,
        })),
      ],
    }),
    context: () => ({ models: [], agentTypes: ["general"] }),
    approvals: { has: async () => true, add: async () => {} },
    request: async () => ({ allowed: false }),
    runnerFor: () => async (_opts, controls) => {
      const verdict = controls?.extraTools?.find((t) => t.name === "step_verdict");
      await verdict?.execute({ verdict: "pass", reason: "planned" }, {} as ToolContext);
      return { report: "ok", toolUses: 1, stopReason: "end_turn" };
    },
  };
  return new WorkflowDriver(deps);
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};

describe("session/workflow on a hosted session", () => {
  test("no driver (a tunnelled session): refused, nothing runs", async () => {
    const result = await hosted().workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      turnId: "t-1",
    });
    expect(result).toEqual({
      ok: false,
      reason: "workflows run only on a laptop or serve session",
    });
  });

  test("a run started over RPC reaches the snapshot and queues its end note (it wakes)", async () => {
    const session = hosted();
    session.attachWorkflows(driver());
    const result = await session.workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      turnId: "t-1",
    });
    expect(result).toEqual({ ok: true, runId: "wf-1" });
    await settle();
    const rows = session.snapshotPage().workflows ?? [];
    expect(rows.map((r) => [r.runId, r.state])).toEqual([["wf-1", "ok"]]);
    expect(session.unflushedExits).toBeGreaterThan(0);
    expect(session.workflowListRows()[0]).toMatchObject({ runId: "wf-1", needsUser: false });
  });

  test("ids are seeded from the history: a restart never re-mints one it names", async () => {
    const session = hosted([
      {
        role: "user",
        content: "[workflow wf-4 task: ok · 1/1 · 0 tok] planned",
        note: { kind: NOTE_KIND.workflowEnd, id: "wf-4" },
      },
    ]);
    session.attachWorkflows(driver());
    const result = await session.workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      turnId: "t-1",
    });
    expect(result).toEqual({ ok: true, runId: "wf-5" });
  });

  // Review R2-3 (Slice 3 obligation): a compaction while a run is live starts a
  // new log segment; that segment must carry the run's `workflow_start` again,
  // or a crash after it leaves the run with nothing to close at the next load.
  test("a new log segment mid-run re-logs the live run's workflow_start", async () => {
    const session = hosted();
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const d = new WorkflowDriver({
      load: async () => ({ path: ".tentacle/workflows/task.yaml", text: YAML, prompts: {} }),
      context: () => ({ models: [], agentTypes: ["general"] }),
      approvals: { has: async () => true, add: async () => {} },
      request: async () => ({ allowed: false }),
      runnerFor: () => async () => {
        await blocked;
        return { report: "ok", toolUses: 0, stopReason: "end_turn" };
      },
    });
    session.attachWorkflows(d);
    const started = await session.workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      turnId: "t-1",
    });
    expect(started).toEqual({ ok: true, runId: "wf-1" });
    await settle();
    (session as unknown as { historyReplaced(r: "compact"): void }).historyReplaced("compact");
    const all: KnownLogEntry[] = [];
    let after: LogCursor | undefined;
    for (;;) {
      const page = session.logRead(after);
      all.push(...(page.entries as KnownLogEntry[]));
      const last = page.entries.at(-1);
      if (!page.more || !last) break;
      after = { seq: last.seq, id: last.id };
    }
    // The read is the CURRENT segment: it opens at the compaction's base.
    const lastBase = all.map((e) => e.type).lastIndexOf("base");
    expect(lastBase).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(all[lastBase])).toContain('"compact"');
    const segment = all.slice(lastBase).map((e) => e.type);
    expect(segment).toContain("workflow_start");
    release();
    await settle();
  });

  test("a run WAITING on the user flips `needsUser` on the hub signal (slice 9)", async () => {
    // docs/feat/agent-workflows.md slice 9: "`workflow/list` `needsUser`". The
    // hub's badge reads THIS flag, so a run that opens an ask must move it from
    // false to true and back — otherwise the phone never lights up.
    // Mutation: derive `needsUser` from the run's state alone and forget that an
    // ask also shows as `waiting`/`needs-approval` on a STEP → the row stays
    // false while the run is parked on a human.
    const session = hosted();
    let answer = (): void => {};
    const asked = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let released = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      released = resolve;
    });
    const d = new WorkflowDriver({
      load: async () => ({
        path: ".tentacle/workflows/task.yaml",
        text: APPROVE_YAML,
        prompts: {},
      }),
      context: () => ({ models: [], agentTypes: ["general"] }),
      approvals: { has: async () => true, add: async () => {} },
      request: async () => {
        answer();
        await blocked;
        return { allowed: true };
      },
      runnerFor: () => async (_opts, controls) => {
        const verdict = controls?.extraTools?.find((t) => t.name === "step_verdict");
        await verdict?.execute({ verdict: "pass", reason: "ok" }, {} as ToolContext);
        return { report: "ok", toolUses: 0, stopReason: "end_turn" };
      },
    });
    session.attachWorkflows(d);
    const started = await session.workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      turnId: "t-1",
    });
    expect(started).toEqual({ ok: true, runId: "wf-1" });
    await asked;
    // Parked on an ask: the hub must say so.
    expect(session.workflowListRows()[0]).toMatchObject({ runId: "wf-1", needsUser: true });
    released();
    await settle();
    // Answered and finished: it no longer does.
    expect(session.workflowListRows()[0]?.needsUser).toBe(false);
  });

  test("a wake turn id cannot start a run", async () => {
    const session = hosted();
    session.attachWorkflows(driver());
    const result = await session.workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      turnId: "wake-1",
    });
    expect(result.ok).toBe(false);
  });
});

describe("session/workflow_catalogue on a hosted session (slice 5a)", () => {
  test("a tunnelled session (no driver) says unavailable, never an empty folder", async () => {
    const answer = await hosted().workflowCatalogue();
    expect(answer.workflows).toEqual([]);
    expect(answer.unavailable).toBe("workflows run only on a laptop or serve session");
  });

  test("a session with a driver answers every row, with its hash and approval", async () => {
    const session = hosted();
    session.attachWorkflows(listingDriver());
    const answer = await session.workflowCatalogue();
    expect(answer.unavailable).toBeUndefined();
    expect(answer.dir).toBe("/proj/.tentacle/workflows");
    expect(answer.workflows.map((w) => [w.name, w.ok])).toEqual([
      ["task", true],
      ["broken", false],
    ]);
    const task = answer.workflows[0];
    expect(task?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(task?.approved).toBe(true);
    // An invalid row carries its error and nothing that could start it.
    const broken = answer.workflows[1];
    expect(broken?.errors?.some((e) => e.startsWith("steps"))).toBe(true);
    expect(broken?.hash).toBeUndefined();
  });

  test("start{hash} reaches the driver: a stale hash is refused `changed`, nothing runs", async () => {
    // The wire half of the property the phone's Start depends on: a hash the
    // user saw is carried through `session/workflow`, and a mismatch is a
    // REFUSAL the client can branch on — not a run of the edited file.
    // Mutation: drop `hash` from the daemon's `driver.start(...)` → red.
    const session = hosted();
    session.attachWorkflows(listingDriver());
    const answer = await session.workflowCatalogue();
    const current = answer.workflows[0]?.hash;
    if (current === undefined) throw new Error("no hash");
    const stale = await session.workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      hash: "0".repeat(64),
      turnId: "t-1",
    });
    expect(stale).toMatchObject({ ok: false, refusal: "changed" });
    expect(session.snapshotPage().workflows ?? []).toEqual([]);
    // And the hash the catalogue gave DOES start it (already approved here).
    const started = await session.workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      hash: current,
      turnId: "t-2",
    });
    expect(started).toEqual({ ok: true, runId: "wf-1" });
    await settle();
  });

  test("a VALID workflow the wire cannot carry is ONE ok:false row naming its step — the rest stay", async () => {
    // Review round 1 #1: a 5005-char `run:` validates, but the wire caps a
    // step's command at 4096 — the whole answer used to fail and the daemon
    // said `unavailable`, hiding every other workflow.
    const big = `schemaVersion: 1\nname: big\nversion: 1\nsteps:\n  - id: build\n    run: "${"x".repeat(5005)}"\n`;
    const session = hosted();
    session.attachWorkflows(
      listingDriver([{ path: ".tentacle/workflows/big.yaml", text: big, prompts: {} }]),
    );
    const answer = await session.workflowCatalogue();
    expect(answer.unavailable).toBeUndefined();
    expect(answer.workflows.map((w) => [w.name, w.ok])).toEqual([
      ["task", true],
      ["broken", false],
      ["big", false],
    ]);
    const row = answer.workflows[2];
    expect(row?.path).toBe(".tentacle/workflows/big.yaml");
    expect(row?.hash).toBeUndefined();
    expect(row?.steps).toBeUndefined();
    expect(row?.errors?.join("\n")).toContain('step "build"');
    expect(row?.errors?.join("\n")).toContain("command");
  });

  test("every validation error is its own line; over 20 → `+k more`; an over-long one ends in …", async () => {
    // Review round 1 #2: the errors were joined with "; " into ONE string and
    // cut at 300 chars with no marker — the rest disappeared silently.
    const steps = Array.from({ length: 25 }, (_, i) => `  - id: s${i}\n`).join("");
    const many = `schemaVersion: 1\nname: many\nversion: 1\nsteps:\n${steps}`;
    const long = `schemaVersion: 1\nname: long\nversion: 1\nsteps:\n  - id: a\n    run: make\n    next: ${"z".repeat(400)}\n`;
    const session = hosted();
    session.attachWorkflows(
      listingDriver([
        { path: ".tentacle/workflows/many.yaml", text: many, prompts: {} },
        { path: ".tentacle/workflows/long.yaml", text: long, prompts: {} },
      ]),
    );
    const answer = await session.workflowCatalogue();
    expect(answer.unavailable).toBeUndefined();
    const errors = answer.workflows[2]?.errors ?? [];
    expect(errors).toHaveLength(20);
    expect(errors[0]).toStartWith("steps[0]");
    expect(errors[1]).toStartWith("steps[1]");
    expect(errors[19]).toBe("+6 more");
    const longErrors = answer.workflows[3]?.errors ?? [];
    const cut = longErrors.find((e) => e.includes("zzz"));
    expect(cut).toBeDefined();
    expect(cut?.length).toBe(300);
    expect(cut?.endsWith("…")).toBe(true);
  });
});

/**
 * A driver over an in-memory folder WITH the writer (docs/feat/workflow-editor.md
 * slice 3b): `load` reads it, `save` writes it (no dry-run write), the store is
 * a spy whose `add` must never run.
 */
function editableDriver(adds: { count: number }) {
  const disk = new Map<string, string>([["task.yaml", YAML]]);
  const read = (name: string): WorkflowSource | undefined => {
    const text = disk.get(`${name}.yaml`);
    return text === undefined
      ? undefined
      : { path: `.tentacle/workflows/${name}.yaml`, text, prompts: Object.fromEntries(disk) };
  };
  const deps: WorkflowDriverDeps = {
    load: async (name) => {
      const source = read(name);
      if (source === undefined) throw new Error(`no workflow ${name}`);
      return source;
    },
    save: (plan, currentHash) => {
      const base = read(plan.name);
      if (plan.mode === "replace" && (base === undefined || currentHash(base) !== plan.baseHash)) {
        return { ok: false, refusal: "changed", reason: "changed", files: [] };
      }
      const text = workflowYaml(plan.draft);
      if (!plan.dryRun) disk.set(`${plan.name}.yaml`, text);
      return {
        ok: true,
        files: [
          {
            path: `${plan.name}.yaml`,
            status: "changed",
            patch: "p".repeat(70_000),
            added: 1,
            removed: 1,
          },
        ],
      };
    },
    context: () => ({ models: ["opus"], agentTypes: ["general"] }),
    approvals: {
      has: async () => true,
      add: async () => {
        adds.count += 1;
      },
    },
    request: async () => ({ allowed: false }),
    runnerFor: () => async () => ({ report: "ok", toolUses: 1, stopReason: "end_turn" }),
  };
  return { driver: new WorkflowDriver(deps), disk };
}

/** A hosted session that can schedule (its own timer seam, never the globals). */
function schedulingHosted(): HostedSession {
  const agent = new Agent({
    model: {
      id: "one",
      async *stream() {
        yield { type: "done" };
      },
    },
    tools: new ToolRegistry(),
    env: noopEnv,
  });
  return new HostedSession(
    "s1",
    new Session(agent),
    new PermissionBroker(),
    undefined,
    {},
    undefined,
    Date.now,
    undefined,
    {},
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    { setTimeout: () => ({}), clearTimeout: () => {} },
  );
}

const EDITED = {
  schemaVersion: 1,
  name: "task",
  version: 2,
  steps: [{ id: "plan", agent: { prompt_text: "plan it better" } }],
};

describe("session/workflow_source + workflow_save on a hosted session (slice 3b)", () => {
  test("a tunnelled session (no driver): both answer `unavailable`, nothing else", async () => {
    const session = hosted();
    const source = await session.workflowSource({ sessionId: "s1", name: "task" });
    expect(source.ok).toBe(false);
    expect(source.unavailable).toBe("workflows can be edited only on a laptop or serve session");
    const saved = await session.workflowSave({
      sessionId: "s1",
      name: "task",
      mode: "replace",
      draft: JSON.stringify(EDITED),
      prompts: [],
      dryRun: false,
    });
    expect(saved).toEqual({
      ok: false,
      refusal: "unavailable",
      reason: "workflows can be edited only on a laptop or serve session",
    });
  });

  test("a driver session answers both, on the wire's shapes; a save never approves", async () => {
    const adds = { count: 0 };
    const { driver, disk } = editableDriver(adds);
    const session = hosted();
    session.attachWorkflows(driver);
    const source = await session.workflowSource({ sessionId: "s1", name: "task" });
    expect(source.ok).toBe(true);
    expect(source.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(source.draft ?? "null")).toMatchObject({ name: "task", version: 1 });
    expect(source.prompts).toEqual([]);
    expect(source.context).toEqual({ models: ["opus"], agentTypes: ["general"] });
    const saved = await session.workflowSave({
      sessionId: "s1",
      name: "task",
      mode: "replace",
      draft: JSON.stringify(EDITED),
      prompts: [],
      ...(source.hash !== undefined ? { baseHash: source.hash } : {}),
      dryRun: false,
    });
    expect(saved.ok).toBe(true);
    expect(saved.hash).not.toBe(source.hash);
    expect(disk.get("task.yaml")).toBe(workflowYaml(EDITED));
    // The writer's 70 000-char patch is cut to the wire's cap, never a failed answer.
    expect(saved.files?.[0]?.path).toBe(".tentacle/workflows/task.yaml");
    expect(saved.files?.[0]?.patch?.length).toBe(64 * 1024);
    expect(adds.count).toBe(0);
    // The catalogue then reports exactly the hash the save returned.
  });

  test("a draft that is not JSON, or a prompt given twice, is `invalid` before the driver", async () => {
    const { driver, disk } = editableDriver({ count: 0 });
    const session = hosted();
    session.attachWorkflows(driver);
    const notJson = await session.workflowSave({
      sessionId: "s1",
      name: "task",
      mode: "create",
      draft: "{nope",
      prompts: [],
      dryRun: false,
    });
    expect(notJson.refusal).toBe("invalid");
    // Each guard is named, so neither test passes on the other's cause.
    expect(notJson.reason).toContain("the draft is not JSON");
    const twice = await session.workflowSave({
      sessionId: "s1",
      name: "task",
      mode: "create",
      draft: JSON.stringify(EDITED),
      prompts: [
        { path: "prompts/a.md", text: "1" },
        { path: "prompts/a.md", text: "2" },
      ],
      dryRun: false,
    });
    expect(twice.refusal).toBe("invalid");
    expect(twice.reason).toContain("prompts/a.md");
    expect(twice.reason).toContain("given twice");
    expect(disk.get("task.yaml")).toBe(YAML);
  });

  test("60 validator errors: both answer them capped (20 lines, `+k more`), never `unavailable`", async () => {
    // Review of 3a+3b #1: the validator does not bound its list; the wire does.
    const steps = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, run: "" }));
    const broken = { schemaVersion: 1, name: "task", version: 1, steps };
    const { driver, disk } = editableDriver({ count: 0 });
    const session = hosted();
    session.attachWorkflows(driver);
    const saved = await session.workflowSave({
      sessionId: "s1",
      name: "task",
      mode: "replace",
      draft: JSON.stringify(broken),
      prompts: [],
      dryRun: true,
    });
    expect(saved.ok).toBe(false);
    expect(saved.refusal).toBe("invalid");
    expect(saved.errors).toHaveLength(20);
    expect(saved.errors?.[19]).toBe("+41 more");
    expect(saved.reason?.length ?? 0).toBeLessThanOrEqual(2000);
    expect(saved.reason).toContain("steps[0].run");
    expect(saved.reason?.endsWith("…")).toBe(true);
    // The same file hand-written on disk: it OPENS, with its errors.
    disk.set(
      "task.yaml",
      `schemaVersion: 1\nname: task\nversion: 1\nsteps:\n${steps.map((s) => `  - id: ${s.id}\n    run: ""\n`).join("")}`,
    );
    const source = await session.workflowSource({ sessionId: "s1", name: "task" });
    expect(source.unavailable).toBeUndefined();
    expect(source.ok).toBe(true);
    expect(source.hash).toBeUndefined();
    expect(source.errors).toHaveLength(20);
    expect(source.errors?.[19]).toBe("+41 more");
    expect(JSON.parse(source.draft ?? "null")).toMatchObject({ name: "task" });
  });

  test("a source the wire cannot carry is `unreadable` by its path, never `unavailable`", async () => {
    const { driver } = editableDriver({ count: 0 });
    const session = hosted();
    session.attachWorkflows(driver);
    driver.source = async () => ({
      ok: true,
      path: ".tentacle/workflows/task.yaml",
      text: "x".repeat(256 * 1024 + 1),
    });
    const source = await session.workflowSource({ sessionId: "s1", name: "task" });
    expect(source.unavailable).toBeUndefined();
    expect(source.ok).toBe(false);
    expect(source.path).toBe(".tentacle/workflows/task.yaml");
    expect(source.unreadable).toContain("could not be reported");
  });

  test("a write that LANDED is never reported `unavailable`: the hash survives an unreportable rest", async () => {
    const { driver } = editableDriver({ count: 0 });
    const session = hosted();
    session.attachWorkflows(driver);
    const hash = "a".repeat(64);
    const row = { status: "changed" as const, added: 1, removed: 0 };
    // 70 other workflows read the rewritten prompt (wire: ≤ 64), and 40 file rows (wire: ≤ 33).
    driver.save = async () => ({
      ok: true,
      hash,
      version: 2,
      path: ".tentacle/workflows/task.yaml",
      files: Array.from({ length: 40 }, (_, i) => ({ ...row, path: `p${i}.md` })),
      approved: false,
      alsoChanges: Array.from({ length: 70 }, (_, i) => `w${i}`),
    });
    const saved = await session.workflowSave({
      sessionId: "s1",
      name: "task",
      mode: "create",
      draft: JSON.stringify(EDITED),
      prompts: [],
      dryRun: false,
    });
    expect(saved.ok).toBe(true);
    expect(saved.refusal).toBeUndefined();
    expect(saved.hash).toBe(hash);
    expect(saved.version).toBe(2);
    expect(saved.approved).toBe(false);
    expect(saved.reason).toContain("could not be reported");
    // Only alsoChanges over: it is cut to the wire's 64, and the reason says how many.
    driver.save = async () => ({
      ok: true,
      hash,
      version: 2,
      path: ".tentacle/workflows/task.yaml",
      files: [{ ...row, path: "task.yaml" }],
      approved: false,
      alsoChanges: Array.from({ length: 70 }, (_, i) => `w${i}`),
    });
    const cut = await session.workflowSave({
      sessionId: "s1",
      name: "task",
      mode: "create",
      draft: JSON.stringify(EDITED),
      prompts: [],
      dryRun: false,
    });
    expect(cut.ok).toBe(true);
    expect(cut.alsoChanges).toHaveLength(64);
    expect(cut.files).toHaveLength(1);
    expect(cut.reason).toContain("70");
  });

  test("`schedules` lists a job pinned to the OLD hash (the preview already says it)", async () => {
    const { driver } = editableDriver({ count: 0 });
    const session = schedulingHosted();
    session.attachWorkflows(driver);
    const source = await session.workflowSource({ sessionId: "s1", name: "task" });
    const created = await session.scheduleCreateRpc({
      sessionId: "s1",
      turnId: "t-user",
      workflow: { name: "task", inputs: [] },
      every: "2h",
    });
    expect(created).toEqual({ ok: true, scheduleId: "sc-1" });
    const request = {
      sessionId: "s1",
      name: "task",
      mode: "replace" as const,
      draft: JSON.stringify(EDITED),
      prompts: [],
      ...(source.hash !== undefined ? { baseHash: source.hash } : {}),
    };
    const preview = await session.workflowSave({ ...request, dryRun: true });
    expect(preview.schedules).toEqual(["sc-1"]);
    const saved = await session.workflowSave({ ...request, dryRun: false });
    expect(saved.schedules).toEqual(["sc-1"]);
    // An unchanged re-save (same bytes, same hash) breaks no schedule.
    const fresh = await session.workflowSource({ sessionId: "s1", name: "task" });
    const again = await session.workflowSave({
      ...request,
      ...(fresh.hash !== undefined ? { baseHash: fresh.hash } : {}),
      dryRun: true,
    });
    expect(again.schedules).toBeUndefined();
  });

  /**
   * The other half of `schedules` (mutation-checked): a job is reported by the
   * save that BREAKS it, once. A job still pinned to an ever older hash was
   * already reported then — reporting it again would nag on every later save
   * forever, so it is not this save's news.
   */
  test("`schedules` is the job THIS save breaks: an older pin is not re-reported", async () => {
    const { driver } = editableDriver({ count: 0 });
    const session = schedulingHosted();
    session.attachWorkflows(driver);
    const created = await session.scheduleCreateRpc({
      sessionId: "s1",
      turnId: "t-user",
      workflow: { name: "task", inputs: [] },
      every: "2h",
    });
    expect(created).toEqual({ ok: true, scheduleId: "sc-1" });
    const source = await session.workflowSource({ sessionId: "s1", name: "task" });
    // Save #1 breaks the pin: reported.
    const first = await session.workflowSave({
      sessionId: "s1",
      name: "task",
      mode: "replace",
      draft: JSON.stringify(EDITED),
      prompts: [],
      ...(source.hash !== undefined ? { baseHash: source.hash } : {}),
      dryRun: false,
    });
    expect(first.ok).toBe(true);
    expect(first.schedules).toEqual(["sc-1"]);
    // Save #2 replaces those bytes again; the job is still pinned to the ORIGINAL
    // hash, which save #2 did not invalidate — nothing new to report.
    const second = await session.workflowSave({
      sessionId: "s1",
      name: "task",
      mode: "replace",
      draft: JSON.stringify({ ...EDITED, version: 3 }),
      prompts: [],
      ...(first.hash !== undefined ? { baseHash: first.hash } : {}),
      dryRun: true,
    });
    expect(second.ok).toBe(true);
    expect(second.schedules).toBeUndefined();
  });

  /**
   * The third case (mutation-checked): a job pinned to EXACTLY the hash being
   * rewritten with identical bytes is not broken — the file still holds what it
   * fires. Re-saving a file unchanged must never nag about it.
   */
  test("`schedules` spares a job pinned to the very hash being re-written unchanged", async () => {
    const { driver } = editableDriver({ count: 0 });
    const session = schedulingHosted();
    session.attachWorkflows(driver);
    const opened = await session.workflowSource({ sessionId: "s1", name: "task" });
    // Save ONCE so the file holds the emitter's own bytes: from here a re-save of
    // the same draft reproduces the same bytes, and so the same hash.
    const written = await session.workflowSave({
      sessionId: "s1",
      name: "task",
      mode: "replace",
      draft: opened.draft ?? "{}",
      prompts: [],
      ...(opened.hash !== undefined ? { baseHash: opened.hash } : {}),
      dryRun: false,
    });
    expect(written.ok).toBe(true);
    const created = await session.scheduleCreateRpc({
      sessionId: "s1",
      turnId: "t-user",
      workflow: { name: "task", inputs: [] },
      every: "2h",
    });
    expect(created).toEqual({ ok: true, scheduleId: "sc-1" });
    // The job is now pinned to exactly the hash this re-save writes: not broken.
    const again = await session.workflowSave({
      sessionId: "s1",
      name: "task",
      mode: "replace",
      draft: opened.draft ?? "{}",
      prompts: [],
      ...(written.hash !== undefined ? { baseHash: written.hash } : {}),
      dryRun: true,
    });
    expect(again.ok).toBe(true);
    expect(written.hash).toBeDefined();
    if (written.hash === undefined) return;
    expect(again.hash).toBe(written.hash);
    expect(again.schedules).toBeUndefined();
  });
});

// --- the live status line (docs/feat/workflow-run-awareness.md S3: T4, T5) ----

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

const WAITS_LINE = "[workflow wf-1 task: step 1/1 merge waits for the user · 0/1 ok · 0 tok]";

const toolCall = (id: string, name: string, args: unknown): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: JSON.stringify(args) },
});

/**
 * A `serve`-shaped host (the real `SessionHost.build` → `attachWorkflows` path)
 * with a real driver on an `approve` step, whose ask goes to the session's ONE
 * broker, a recording model and the persister over an in-memory store.
 */
function waitingRig(
  script: readonly (readonly StreamEvent[])[] = [],
  opts: { readonly wake?: boolean } = {},
) {
  const requests: ChatRequest["messages"][] = [];
  const asked: PermissionRequest[] = [];
  const runs: string[] = [];
  let round = 0;
  const model: ModelProvider = {
    id: "recording",
    async *stream(request: ChatRequest) {
      // The title request shares this model and offers no tool: not a loop round.
      if (!request.tools?.length) {
        yield { type: "done" } as const;
        return;
      }
      requests.push([...request.messages]);
      // A bare `done` is an empty reply, which the loop asks again: say something.
      yield* script[round++] ?? [
        { type: "text", delta: "noted" } as const,
        { type: "done" } as const,
      ];
    },
  };
  const store = new SpyDaemonStore();
  const host = new SessionHost({
    defaultCwd: "/tmp/workflow-status-line",
    persister: new SessionPersister({
      store,
      cwd: "/tmp/workflow-status-line",
      model: "m",
      onError: () => {},
    }),
    sharedAutoAccept: true,
    answersAutoAccept: true,
    ...(opts.wake === true ? { wakeOnJobExit: true } : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const workflows = new WorkflowDriver({
        load: async () => ({
          path: ".tentacle/workflows/task.yaml",
          text: APPROVE_YAML,
          prompts: {},
        }),
        context: () => ({ models: [], agentTypes: ["general"] }),
        approvals: { has: async () => true, add: async () => {} },
        request: (req, options) => {
          asked.push(req);
          return permissions.request(req, options);
        },
        runnerFor: () => async () => ({ report: "ok", toolUses: 0, stopReason: "end_turn" }),
      });
      const askme: Tool = {
        name: "askme",
        description: "askme",
        inputSchema: z.object({}).passthrough(),
        permission: "ask",
        async execute() {
          runs.push("askme");
          return { content: "askme ok" };
        },
      };
      // The USER answers the run's ask while this tool runs (S4): the run ends
      // inside the model's round, so its end note is queued mid-turn.
      const answer: Tool = {
        name: "answer",
        description: "answer",
        inputSchema: z.object({}).passthrough(),
        permission: "none",
        async execute() {
          const ask = pending()[0];
          if (!ask) throw new Error("no pending ask");
          session.resolvePermission(ask.requestId, "allow_once");
          // The LIVE frame, not `snapshotPage()` (its cut does not move while a
          // turn runs). `finish()` publishes, then calls `ended`, synchronously.
          await until(() => liveState() === "ok");
          await settle();
          return { content: "answered" };
        },
      };
      const agent = new Agent({
        model,
        tools: new ToolRegistry()
          .register(askme)
          .register(answer)
          .register(createWorkflowTool(workflows)),
        env: noopEnv,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions, workflows };
    },
  });
  const frames: KnownSessionUpdateParams[] = [];
  const { hosted: session } = host.open({ create: true }, { send: (u) => frames.push(u) });
  const updates = () => frames.map((f) => f.update);
  /** The asks nobody answered yet. */
  const pending = () => {
    const resolved = new Set(
      updates().flatMap((u) => (u.type === "permission_resolved" ? [u.requestId] : [])),
    );
    return updates().flatMap((u) =>
      u.type === "permission_request" && !resolved.has(u.requestId) ? [u] : [],
    );
  };
  const runState = (): string | undefined => session.snapshotPage().workflows?.[0]?.state;
  const liveState = (): string | undefined =>
    updates()
      .flatMap((u) => (u.type === "workflows" ? [u.runs[0]?.state] : []))
      .at(-1);
  const startAndWait = async (): Promise<void> => {
    const started = await session.workflow({
      sessionId: session.id,
      action: "start",
      name: "task",
      turnId: "t-start",
    });
    expect(started).toEqual({ ok: true, runId: "wf-1" });
    await until(() => pending().length === 1 && runState() === "needs-approval");
  };
  const turn = async (turnId: string, text: string): Promise<void> => {
    session.prompt(turnId, [{ type: "text", text }]);
    await until(() => !session.running);
  };
  return { session, store, frames, requests, asked, runs, pending, runState, startAndWait, turn };
}

describe("the live status line on a hosted session (workflow-run-awareness S3)", () => {
  test("T4 the request ends with the line while the run waits, has the end note and no line after, and the log never holds it", async () => {
    const rig = waitingRig();
    await rig.startAndWait();

    await rig.turn("t-1", "first prompt");
    expect(rig.requests).toHaveLength(1);
    expect(rig.requests[0]?.at(-1)).toEqual({ role: "user", content: WAITS_LINE });

    const ask = rig.pending()[0];
    if (!ask) throw new Error("no pending ask");
    rig.session.resolvePermission(ask.requestId, "allow_once");
    await until(() => rig.runState() === "ok");

    await rig.turn("t-2", "second prompt");
    expect(rig.requests).toHaveLength(2);
    const after = (rig.requests[1] ?? []).map((m) => String(m.content));
    expect(after.some((c) => c.startsWith("[workflow wf-1 task: ok · 1/1"))).toBe(true);
    expect(after.some((c) => c.startsWith("[workflow wf-1 task: step"))).toBe(false);
    // No line at the tail: the prompt (stamped), then the queued end note.
    expect(after.at(-2)).toEndWith("second prompt");
    expect(after.at(-1)).toStartWith("[workflow wf-1 task: ok · 1/1");

    // Non-vacuity: what landed really holds this conversation and the end note.
    await until(() => rig.store.files.get(rig.session.id)?.log?.includes("second prompt") === true);
    const files = rig.store.files.get(rig.session.id);
    expect(files?.log).toContain("first prompt");
    expect(files?.log).toContain("[workflow wf-1 task: ok · 1/1");
    expect(JSON.stringify([files, rig.store.units])).not.toContain("[workflow wf-1 task: step");
    expect(JSON.stringify(rig.session.snapshotPage())).not.toContain("[workflow wf-1 task: step");
  });

  test("T5 in auto-accept, a whole model turn leaves the workflow ask pending; the line grants nothing", async () => {
    const rig = waitingRig([
      [
        toolCall("c1", "workflow", { action: "status" }),
        toolCall("c2", "askme", {}),
        { type: "done" },
      ],
    ]);
    rig.session.setAutoAccept(true, "phone");
    await rig.startAndWait();

    await rig.turn("t-1", "go");

    // Auto-accept is live in this turn: the ordinary tool's ask was answered.
    expect(rig.runs).toEqual(["askme"]);
    expect(rig.requests).toHaveLength(2);
    for (const request of rig.requests) {
      expect(request.at(-1)).toEqual({ role: "user", content: WAITS_LINE });
    }
    // The run's own ask was not.
    expect(rig.runState()).toBe("needs-approval");
    expect(rig.pending()).toHaveLength(1);
    const approve = rig.asked[0];
    if (!approve) throw new Error("no workflow ask");
    expect(approve.kind).toBe("workflow_approve");
    expect(autoApproves(approve, true)).toBe(false);
    rig.session.close();
  });

  test("T6 a run that ends during round 1 is told at round 2 of the SAME turn: once, and no wake follows", async () => {
    // S4: `workflow_end` rides the mid-turn drain like a sub-agent exit. Today's
    // behaviour (start-only) puts the note in no request of this turn and wakes.
    const rig = waitingRig([[toolCall("c1", "answer", {}), { type: "done" }]], { wake: true });
    await rig.startAndWait();

    await rig.turn("t-1", "go");

    const endNote = (c: unknown): boolean => String(c).startsWith("[workflow wf-1 task: ok · 1/1");
    expect(rig.requests).toHaveLength(2);
    // Round 1: the run still waits (the line), no end note yet.
    expect(rig.requests[0]?.at(-1)).toEqual({ role: "user", content: WAITS_LINE });
    const round2 = rig.requests[1] ?? [];
    // Round 2: the end note right after the tool result, and no line any more.
    expect(round2.filter((m) => endNote(m.content))).toHaveLength(1);
    expect(round2.at(-1)?.content).toSatisfy(endNote);
    expect(round2.at(-2)?.role).toBe("tool");
    expect(round2.some((m) => String(m.content).startsWith("[workflow wf-1 task: step"))).toBe(
      false,
    );
    // Persisted as the end note (its kind + id), as the turn-start flush does.
    expect(round2.at(-1)).toMatchObject({ note: { kind: NOTE_KIND.workflowEnd, id: "wf-1" } });
    expect(rig.session.unflushedExits).toBe(0);

    // No wake turn: the follow-up check finds nothing pending.
    await settle();
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await settle();
    }
    expect(rig.session.running).toBe(false);
    expect(rig.requests).toHaveLength(2);
    expect(JSON.stringify(rig.frames)).not.toContain('"wake-');

    // Never told twice: the next turn's request holds the note exactly once.
    await rig.turn("t-2", "next");
    expect(rig.requests).toHaveLength(3);
    expect((rig.requests[2] ?? []).filter((m) => endNote(m.content))).toHaveLength(1);
    rig.session.close();
  });

  test("a closed session gives no line, though the last rows it published are still live", async () => {
    // Mutation: drop the `this.closed` guard in the provider → the line comes back.
    const rig = waitingRig();
    await rig.startAndWait();
    const inner = (rig.session as unknown as { session: { statusLine?: () => string | undefined } })
      .session;
    expect(inner.statusLine?.()).toBe(WAITS_LINE);
    rig.session.close();
    expect(inner.statusLine).toBeDefined();
    expect(inner.statusLine?.()).toBeUndefined();
  });
});
