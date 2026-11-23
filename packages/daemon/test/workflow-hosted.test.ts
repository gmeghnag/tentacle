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
  type ExecutionEnvironment,
  NOTE_KIND,
  PermissionBroker,
  type ToolContext,
} from "@tentacle/core";
import type { KnownLogEntry, LogCursor } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { HostedSession } from "../src/hosted-session.ts";

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
