/**
 * The workflow driver bound into a hosted session (docs/feat/agent-workflows.md
 * Slice 4, review round 1 #2): `session/workflow` reaches it, the rows reach the
 * snapshot, the end note rides the exits queue (it wakes), run ids are seeded
 * from the history (#1), and a session without a driver (tunnelled) refuses.
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session, WorkflowDriver, type WorkflowDriverDeps } from "@tentacle/agent";
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
