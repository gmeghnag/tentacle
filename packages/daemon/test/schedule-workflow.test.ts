/**
 * docs/feat/agent-workflows.md slice 10 — a schedule whose target is a
 * workflow, daemon side: the fire starts the run through the driver (no turn),
 * under a daemon-minted `wake-` id, so a `serve` session in auto-accept answers
 * its step's TOOL ask with nobody attached, while an `approve` step still waits
 * for a human. Real `SessionHost`, a fake driver deps set, an injected clock and
 * timer. Each test names the mutation that turns it red (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import { Agent, WorkflowDriver } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionResponse,
  type StreamEvent,
  type ToolContext,
} from "@tentacle/core";
import type { WorkflowRow } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import {
  DAEMON_STATE_VERSIONS,
  DAEMON_STATE_VERSION_WORKFLOW_SCHEDULES,
  parseSidecar,
} from "../src/daemon-state-file.ts";
import type { Attachment, HostedSession } from "../src/hosted-session.ts";
import type { DaemonSessionState } from "../src/persisted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { SessionPersister, type StateBuild } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 16, 9, 0);
const YAML =
  "schemaVersion: 1\nname: nightly\nversion: 1\nbudget: { wait: 10m }\nsteps:\n" +
  "  - id: plan\n    agent: { prompt_text: plan it }\n" +
  "  - id: merge\n    approve: { title: Merge it }\n";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

class Quiet implements ModelProvider {
  readonly id = "quiet";
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "done" };
  }
}

class FakeTimers {
  readonly set = (_fn: () => void, _ms: number): unknown => ({});
  readonly clear = (_handle: unknown): void => {};
}

class CapturingPersister extends SessionPersister {
  readonly captures: DaemonSessionState[] = [];
  override schedule(id: string, build: StateBuild): void {
    this.captures.push(build());
    super.schedule(id, build);
  }
}

interface RigOptions {
  readonly answers?: boolean;
  readonly driver?: boolean;
  readonly persister?: SessionPersister;
  readonly approved?: boolean;
}

function rig(opts: RigOptions = {}) {
  const clock = { now: T0 };
  const audit: string[] = [];
  const files = { text: YAML };
  const approvals = new Set<string>();
  /** What the plan step's tool ask was answered (undefined = still pending). */
  const toolAnswers: PermissionResponse[] = [];
  let driver: WorkflowDriver | undefined;
  const startedWith: string[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/schedule-workflow",
    now: () => clock.now,
    sharedAutoAccept: true,
    ...(opts.answers !== false ? { answersAutoAccept: true } : {}),
    ...(opts.persister ? { persister: opts.persister } : {}),
    schedules: {
      onAudit: (line: string) => audit.push(line),
      setTimeout: new FakeTimers().set,
      clearTimeout: new FakeTimers().clear,
    },
    createAgent: (_cwd, context) => {
      const permissions = context.reuse?.permissions ?? new PermissionBroker();
      const agent = new Agent({
        model: new Quiet(),
        tools: new ToolRegistry(),
        env: {} as ExecutionEnvironment,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      if (opts.driver === false) return { agent, permissions };
      driver ??= new WorkflowDriver({
        load: async () => ({ path: ".tentacle/workflows/nightly.yaml", text: files.text, prompts: {} }),
        context: () => ({ models: [], agentTypes: ["general"] }),
        approvals: {
          has: async (path, hash) => opts.approved !== false || approvals.has(`${path}#${hash}`),
          add: async (path, hash) => void approvals.add(`${path}#${hash}`),
        },
        // The session's ONE broker (single-broker invariant).
        request: (req, options) => permissions.request(req, options),
        runnerFor: (requester) => async (_o, controls) => {
          toolAnswers.push(
            await requester({ tool: "shell", level: "ask", title: "Run make", input: {} }),
          );
          const verdict = controls?.extraTools?.find((t) => t.name === "step_verdict");
          await verdict?.execute({ verdict: "pass", reason: "ok" }, {} as ToolContext);
          return { report: "ok", toolUses: 1, stopReason: "end_turn" };
        },
      });
      const real = driver.startScheduled.bind(driver);
      driver.startScheduled = (request) => {
        startedWith.push(request.turnId);
        return real(request);
      };
      return { agent, permissions, workflows: driver };
    },
  });
  const frames: unknown[] = [];
  const attachment: Attachment = { send: (u) => frames.push(u) };
  const { hosted } = host.open({ create: true, sessionId: "S" }, attachment);
  const session = (): HostedSession => hosted;
  const rows = (): WorkflowRow[] => session().snapshotPage().workflows ?? [];
  const fire = async (ms: number) => {
    clock.now += ms;
    session().checkSchedules();
    await settle();
  };
  return {
    clock,
    audit,
    files,
    approvals,
    toolAnswers,
    startedWith,
    session,
    rows,
    fire,
    host,
    attachment,
  };
}

const create = (r: ReturnType<typeof rig>, turnId = "t-user") =>
  r.session().scheduleCreateRpc({
    sessionId: "S",
    turnId,
    workflow: { name: "nightly", inputs: [] },
    every: "2h",
  });

describe("a scheduled workflow fire (slice 10)", () => {
  test("serve + auto-accept ON + nobody attached: the step's tool ask is answered daemon-side, the approve step waits", async () => {
    // Mutation M-h: drop the minted `wake-` turn id → the tool ask has no turn,
    // is not the session's own, and stays pending.
    const r = rig();
    expect(await create(r)).toEqual({ ok: true, scheduleId: "sc-1" });
    r.session().setAutoAccept(true);
    r.session().detach(r.attachment);
    await r.fire(2 * 60 * MIN);
    expect(r.startedWith).toHaveLength(1);
    expect(r.startedWith[0]?.startsWith("wake-")).toBe(true);
    expect(r.toolAnswers.map((a) => a.allowed)).toEqual([true]);
    const run = r.rows().at(-1);
    expect(run?.steps.map((s) => s.state)).toEqual(["ok", "needs-approval"]);
    expect(r.session().scheduleLink()?.list()[0]?.last).toMatchObject({
      outcome: "started",
      runId: "wf-1",
    });
    expect(r.audit).toContain("schedule: sc-1 started wf-1 S");
  });

  test("auto-accept OFF: the tool ask stays pending (waits for a human)", async () => {
    const r = rig();
    await create(r);
    await r.fire(2 * 60 * MIN);
    expect(r.toolAnswers).toEqual([]);
    expect(r.rows().at(-1)?.steps[0]?.state).toBe("waiting");
  });

  test("the advance is captured BEFORE the driver is called (at-most-once)", async () => {
    // Mutation M-i: persist after `startScheduled` → the capture at call time has fires 0.
    const persister = new CapturingPersister({
      store: new SpyDaemonStore(),
      cwd: "/tmp/schedule-workflow",
      model: "m",
      onError: () => {},
    });
    const r = rig({ persister });
    await create(r);
    let seenFires: number | undefined;
    const hosted = r.session() as unknown as { workflows: WorkflowDriver };
    const real = hosted.workflows.startScheduled.bind(hosted.workflows);
    hosted.workflows.startScheduled = (request) => {
      seenFires = persister.captures.at(-1)?.schedules?.[0]?.fires;
      return real(request);
    };
    await r.fire(2 * 60 * MIN);
    expect(seenFires).toBe(1);
    await persister.stop();
  });

  test("an edited file is recorded `changed` on the row; no run is made", async () => {
    const r = rig();
    await create(r);
    r.files.text = r.files.text.replace("plan it", "plan it again");
    await r.fire(2 * 60 * MIN);
    expect(r.rows()).toEqual([]);
    expect(r.session().scheduleLink()?.list()[0]?.last?.outcome).toBe("changed");
    expect(r.audit).toContain("schedule: sc-1 not started · changed S");
  });

  test("published frames never pair a fire's count with an earlier fire's outcome (push key = id#fires)", async () => {
    // Review round 1 MEDIUM. Mutation: keep the previous `last` on the advanced
    // row → a `fires=2` frame carries fire 1's `changed` (a false "not started"
    // push for a run that DID start), and the `· schedule removed` frame arrives
    // with a key an older outcome already consumed.
    type Row = {
      id: string;
      fires: number;
      last?: { at: number; outcome: string; reason?: string };
    };
    const watch = async () => {
      const r = rig();
      const seen: Row[] = [];
      r.session().attach({
        send: (u) => {
          const update = (u as { update?: { type?: string; schedules?: Row[] } }).update;
          if (update?.type === "schedules") {
            for (const row of update.schedules ?? []) if (row.id === "sc-1") seen.push(row);
          }
        },
      });
      await create(r);
      return { r, seen, original: r.files.text, edited: r.files.text.replace("plan it", "x") };
    };
    // The FIRST frame that offers an outcome for a fire count is what the push keys on.
    const firstOutcome = (seen: Row[], fires: number) =>
      seen.find((row) => row.fires === fires && row.last !== undefined)?.last;
    // A: fire 1 `changed`, the file is restored, fire 2 starts.
    const a = await watch();
    a.r.files.text = a.edited;
    await a.r.fire(2 * 60 * MIN);
    a.r.files.text = a.original;
    await a.r.fire(2 * 60 * MIN);
    expect(firstOutcome(a.seen, 2)?.outcome).toBe("started");
    // B: three `changed` in a row → the failure stop names itself on fire 3's key.
    const b = await watch();
    b.r.files.text = b.edited;
    for (let i = 0; i < 3; i++) await b.r.fire(2 * 60 * MIN);
    expect(firstOutcome(b.seen, 3)?.reason).toContain("schedule removed");
    expect(b.r.session().scheduleLink()?.list()).toEqual([]);
  });

  test("an unapproved hash at create: the job is created AND the approval is asked now", async () => {
    const r = rig({ approved: false });
    const frames: { type?: string; update?: { type?: string; tool?: string } }[] = [];
    r.session().attach({ send: (u) => frames.push(u as never) });
    expect((await create(r)).ok).toBe(true);
    await settle();
    expect(r.session().scheduleLink()?.list()).toHaveLength(1);
    const asked = frames.filter((f) => f.update?.type === "permission_request");
    expect(asked.length).toBeGreaterThan(0);
  });

  test("a running user turn does not delay the fire", async () => {
    const r = rig();
    await create(r);
    (r.session() as unknown as { controller: unknown }).controller = new AbortController();
    expect(r.session().running).toBe(true);
    await r.fire(2 * 60 * MIN);
    expect(r.startedWith).toHaveLength(1);
  });
});

describe("session/schedule_create (slice 10)", () => {
  test("a wake- turn id is refused (the daemon's own identity)", async () => {
    // Mutation M-k: drop the wake- check → the create succeeds.
    const r = rig();
    const result = await create(r, "wake-1");
    expect(result).toEqual({ ok: false, reason: "a wake turn id cannot create a schedule" });
    expect(r.session().scheduleLink()?.list()).toEqual([]);
  });

  test("no driver (a tunnelled session) → refused", async () => {
    const r = rig({ driver: false });
    expect(await create(r)).toEqual({
      ok: false,
      reason: "workflows run only on a laptop or serve session",
    });
  });

  test("a missing input is refused with the driver's reason", async () => {
    const r = rig();
    r.files.text = r.files.text.replace("steps:", "inputs:\n  slug: { required: true }\nsteps:");
    const result = await create(r);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("slug");
  });
});

describe("the state file's v4 (slice 10)", () => {
  test("a workflow job round-trips target/daily/last; a v3-only build refuses the file", async () => {
    // Mutation M-j: stamp v3 for a workflow job → `schemaVersion` is 3 and a v3 build loads it.
    const store = new SpyDaemonStore();
    const persister = new CapturingPersister({
      store,
      cwd: "/tmp/schedule-workflow",
      model: "m",
      onError: () => {},
    });
    const r = rig({ persister });
    await r.session().scheduleCreateRpc({
      sessionId: "S",
      turnId: "t-1",
      workflow: { name: "nightly", inputs: [] },
      daily: "03:00",
    });
    r.files.text = r.files.text.replace("plan it", "edited");
    const slot = r.session().scheduleLink()?.list()[0]?.nextAt ?? 0;
    await r.fire(slot - r.clock.now);
    await persister.stop();
    const text = store.files.get("S")?.state ?? "{}";
    const file = JSON.parse(text) as Record<string, unknown>;
    expect(file.schemaVersion).toBe(DAEMON_STATE_VERSION_WORKFLOW_SCHEDULES);
    const v3Build = DAEMON_STATE_VERSIONS.filter(
      (v) => v < DAEMON_STATE_VERSION_WORKFLOW_SCHEDULES,
    );
    expect(v3Build.includes(file.schemaVersion as number)).toBe(false);
    const parsed = parseSidecar(text, "S");
    expect(parsed.ok).toBe(true);
    const job = parsed.ok ? parsed.value.schedules?.[0] : undefined;
    expect(job?.kind).toBe("daily");
    expect(job?.daily).toBe("03:00");
    expect(job?.target?.workflow.name).toBe("nightly");
    expect(job?.last?.outcome).toBe("changed");
    // a v3-stamped copy carrying a target is refused (never half-loaded)
    const forged = parseSidecar(JSON.stringify({ ...file, schemaVersion: 3 }), "S");
    expect(forged.ok).toBe(false);
  });
});
