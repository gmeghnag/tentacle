/**
 * docs/feat/workflows-ui.md slice 1b (D2) — the CLIENT data path for a
 * session's workflow runs: the `workflows` display update (full state, not
 * turn-scoped), the two read methods (`session/workflow_step`, `workflow/list`)
 * and the one write (`session/workflow`).
 *
 * Three rules, all pinned here:
 * 1. **The trust bit gates the feed.** A `workflows` frame — live or from a
 *    resync's snapshot — is read only by a client whose daemon is trusted to run
 *    workflows of its own (`daemonWakes`: the worker, `connect`; NEVER a pod,
 *    AGENTS §7): a pod's list would be a pod-supplied claim about the laptop's
 *    runs, and a run's `approve` step would be a pod-originated prompt.
 * 2. **The client is the gate for the labels.** `reason`/`live`/`model`/`where`
 *    are free text on their way to a terminal, cut here — one line, control
 *    characters gone, bounded — never in a component.
 * 3. **A start mints its turn id HERE, and remembers it.** The run's asks are
 *    attributed to that turn (`workflow-driver.ts:983`), and auto-accept answers
 *    only turns the session OWNS: a client that forgets `mint` silently stops
 *    auto-accepting a run it started (the mutation below).
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import {
  JsonRpcErrorCode,
  Method,
  Notification,
  PROTOCOL_VERSION,
  type WorkflowRow,
  type WorkflowStepRow,
} from "@tentacle/protocol";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";
import {
  MAX_WORKFLOW_RUNS,
  WORKFLOW_OLD_DAEMON,
  WORKFLOW_UNTRUSTED_DAEMON,
  askForStep,
  boundWorkflows,
  workflowsFromSnapshot,
} from "../src/workflows.ts";
import { until } from "./support/fakes.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const FORMAT = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

const stepRow = (id: string, extra: Partial<WorkflowStepRow> = {}): WorkflowStepRow => ({
  id,
  kind: "agent",
  where: "local",
  state: "pending",
  attempt: 0,
  round: 0,
  ...extra,
});

const run = (n: number, extra: Partial<WorkflowRow> = {}): WorkflowRow => ({
  runId: `wf-${n}`,
  name: "task",
  version: 1,
  hash: "a".repeat(64),
  state: "running",
  tokens: n,
  startedAt: n,
  steps: [stepRow("merge")],
  ...extra,
});

/** A fake daemon: the handshake, `session/open`, and nothing else unless told. */
function fakeDaemon(
  handlers: Record<string, (params: unknown) => unknown> = {},
  snapshot: (params: unknown) => unknown = () => ({ messages: [] }),
  resync = false,
) {
  const [daemonCh, clientCh] = createChannelPair();
  const sent: { method: string; params: unknown }[] = [];
  let seq = 0;
  const peer = new RpcPeer(daemonCh, {
    onRequest: async (method: string, params: unknown) => {
      sent.push({ method, params });
      if (method === Method.Initialize) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      }
      if (method === Method.Open) {
        return {
          sessionId: "s1",
          epoch: "e",
          created: !resync,
          resync,
          ...(resync ? { since: { epoch: "e", seq: 0 } } : {}),
        };
      }
      if (method === Method.Snapshot) {
        const snap = snapshot(params) as Record<string, unknown>;
        return resync ? { since: { epoch: "e", seq: 0 }, ...snap } : snap;
      }
      const handler = handlers[method];
      if (handler) {
        return handler(params);
      }
      // An older daemon knows nothing else.
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
    },
  });
  const notify = (update: unknown): void => {
    peer.notify(Notification.SessionUpdate, { sessionId: "s1", seq: ++seq, update });
  };
  return { peer, sent, notify, clientCh };
}

async function attach(d: ReturnType<typeof fakeDaemon>, opts: { daemonWakes?: boolean } = {}) {
  const client = new RemoteClient(d.clientCh, new PermissionBroker(), undefined, {
    channelFactory: async () => {
      throw new Error("unused");
    },
    random: () => 0,
    ...(opts.daemonWakes === undefined ? {} : { daemonWakes: opts.daemonWakes }),
  });
  await client.initialize();
  // Attached and LIVE: an unopened session drops every frame by design.
  const session = client.newSession(undefined, "s1", undefined, { attach: {} });
  await session.open();
  return { client, session };
}

describe("boundWorkflows: the rows are the client's (≤ 8 runs, ≤ 64 steps, one line)", () => {
  test("at most MAX_WORKFLOW_RUNS, the daemon's order kept (its live run last)", () => {
    const many = Array.from({ length: 20 }, (_, i) => run(i + 1, { state: "ok", endedAt: 9 }));
    const bounded = boundWorkflows(many);
    expect(bounded).toHaveLength(MAX_WORKFLOW_RUNS);
    // The NEWEST are the ones kept: the daemon appends the live run, so the
    // tail is what a rail paints and the old head is what it never shows.
    expect(bounded.at(-1)?.runId).toBe("wf-20");
    expect(bounded[0]?.runId).toBe(`wf-${20 - MAX_WORKFLOW_RUNS + 1}`);
    // A hostile list costs a slice, not 10 000 mappings.
    expect(boundWorkflows(Array.from({ length: 10_000 }, (_, i) => run(i + 1)))).toHaveLength(
      MAX_WORKFLOW_RUNS,
    );
  });

  test("every label is one line and escape-free; the numbers as sent", () => {
    const [clean] = boundWorkflows([
      run(7, {
        name: "task\nname",
        state: "running\u009b2J",
        stopReason: "budget\u0007",
        reason: `boom\u001b[31m${"z".repeat(9_000)}`,
        steps: [
          stepRow("merge", {
            model: `m\u202e${"x".repeat(400)}`,
            // A pod's `where` is a daemon's string on its way to a terminal: the
            // row's label takes the same treatment as every other one.
            where: "docker:box\u001b[2J\u0007",
            live: "a\nb",
          }),
        ],
      }),
    ]);
    expect(clean?.name).toBe("task name");
    for (const label of [
      clean?.state ?? "",
      clean?.stopReason ?? "",
      clean?.reason ?? "",
      clean?.steps[0]?.where ?? "",
      clean?.steps[0]?.model ?? "",
      clean?.steps[0]?.live ?? "",
    ]) {
      expect(CONTROL.test(label)).toBe(false);
      expect(FORMAT.test(label)).toBe(false);
    }
    // The reason keeps prose (a failed `run` step's output lines), flattened and
    // bounded — the wire's own 2 KiB, never a second number.
    expect((clean?.reason ?? "").length).toBeLessThanOrEqual(2_000);
    expect(clean?.tokens).toBe(7);
    expect(clean?.startedAt).toBe(7);
    expect(clean?.name).not.toContain("\n");
  });

  test("a step list is sliced at the schema's 64 — a slice, not 10 000 mappings", () => {
    // The wire already refuses more (`.max(64)`, `session.ts:833`), so this is
    // the defensive edge: a caller handing this module an unbounded list costs a
    // slice. The FIRST steps are kept — a run's own order.
    const [clean] = boundWorkflows([
      run(1, { steps: Array.from({ length: 10_000 }, (_, i) => stepRow(`s${i}`)) }),
    ]);
    expect(clean?.steps).toHaveLength(64);
    expect(clean?.steps[0]?.id).toBe("s0");
    expect(clean?.steps.at(-1)?.id).toBe("s63");
  });

  test("an unknown state is kept as sent, never coerced", () => {
    // A newer daemon's state is painted as its own word with a neutral glyph
    // (the `stateLook` rule, workflow-list.ts:79); the client must not map it to
    // one it knows, which would claim a step is pending when it is not.
    const [clean] = boundWorkflows([
      run(1, { state: "paused", steps: [stepRow("merge", { state: "invented" })] }),
    ]);
    expect(clean?.state).toBe("paused");
    expect(clean?.steps[0]?.state).toBe("invented");
  });

  test("a snapshot's list goes through the same bounding; absent stays absent", () => {
    expect(workflowsFromSnapshot(Array.from({ length: 20 }, (_, i) => run(i + 1)))).toHaveLength(
      MAX_WORKFLOW_RUNS,
    );
    expect(workflowsFromSnapshot(undefined)).toBeUndefined();
    expect(workflowsFromSnapshot([])).toEqual([]);
  });
});

describe("askForStep: the ONE pairing of an approve step with its ask", () => {
  const ask = (requestId: string, id?: string) => ({
    requestId,
    ...(id === undefined ? {} : { agent: { id } }),
  });

  test("a step's id is `<runId>.<stepId>`; the run's own approval is `<runId>`", () => {
    const pending = [
      ask("r0"),
      ask("r1", "wf-1.merge"),
      ask("r2", "wf-1"),
      ask("r3", "wf-2.merge"),
    ];
    expect(askForStep(pending, "wf-1", "merge")?.requestId).toBe("r1");
    expect(askForStep(pending, "wf-1", null)?.requestId).toBe("r2");
    expect(askForStep(pending, "wf-2", "build")).toBeUndefined();
  });

  test("`wf-1` never matches `wf-11`'s ask (an exact id, not a prefix)", () => {
    // Mutation: `startsWith(runId)` instead of an exact match → both the wrong
    // ask and the wrong RUN are paired, and the phone answers one run's step
    // with another's approval.
    const pending = [ask("r1", "wf-11.merge"), ask("r2", "wf-11")];
    expect(askForStep(pending, "wf-1", "merge")).toBeUndefined();
    expect(askForStep(pending, "wf-1", null)).toBeUndefined();
  });

  test("an ask with no agent id (a main-agent call) is never paired", () => {
    expect(askForStep([ask("r1"), ask("r2", "")], "wf-1", "merge")).toBeUndefined();
    expect(askForStep([], "wf-1", null)).toBeUndefined();
  });
});

describe("the trust bit gates the feed (AGENTS §7)", () => {
  test("with daemonWakes ON a `workflows` frame reaches both listeners, in order", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d, { daemonWakes: true });
    const viaClient: string[][] = [];
    client.onSessionWorkflows((n) => viaClient.push(n.rows.map((r) => r.runId)));
    const viaSession: string[][] = [];
    session.onWorkflows((rows) => viaSession.push(rows.map((r) => r.runId)));
    expect(session.workflows).toBeUndefined();

    d.notify({ type: "workflows", runs: [run(1)] });
    await until(() => viaSession.length === 1);
    d.notify({ type: "workflows", runs: [run(1, { state: "ok", endedAt: 5 }), run(2)] });
    await until(() => viaSession.length === 2);

    expect(viaClient).toEqual([["wf-1"], ["wf-1", "wf-2"]]);
    expect(viaSession).toEqual([["wf-1"], ["wf-1", "wf-2"]]);
    // The full state, in seq order: the second frame REPLACES the first, it is
    // never merged with it (the update's own contract, updates.ts:486).
    expect(session.workflows?.map((r) => r.state)).toEqual(["ok", "running"]);
    client.close();
  });

  test("with the bit OFF (a pod, run/attach) the frame is DROPPED: no rows, no listener", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d);
    let notices = 0;
    session.onWorkflows(() => {
      notices += 1;
    });
    client.onSessionWorkflows(() => {
      notices += 1;
    });
    d.notify({ type: "workflows", runs: [run(1)] });
    await tick();
    expect(session.workflows).toBeUndefined();
    expect(notices).toBe(0);
    // A pod can neither show nor drive a run on the laptop's behalf: the refusal
    // is a RESULT (a notice), and nothing reaches the wire.
    expect(await session.workflow({ action: "stop", runId: "wf-1" })).toEqual({
      ok: false,
      reason: WORKFLOW_UNTRUSTED_DAEMON,
    });
    expect(d.sent.some((s) => s.method === Method.Workflow)).toBe(false);
    client.close();
  });

  test("a resync snapshot repaints the list — a lost update converges", async () => {
    const snap = (): unknown => ({
      messages: [],
      workflows: [run(1, { state: "ok", endedAt: 5 }), run(2)],
    });
    const on = fakeDaemon({}, snap, true);
    const a = await attach(on, { daemonWakes: true });
    await tick(40);
    expect(a.session.workflows?.map((r) => r.runId)).toEqual(["wf-1", "wf-2"]);
    a.client.close();

    // The same snapshot from an untrusted daemon states nothing at all.
    const off = fakeDaemon({}, snap, true);
    const b = await attach(off);
    await tick(40);
    expect(b.session.workflows).toBeUndefined();
    b.client.close();
  });
});

describe("session/workflow: a start mints its own turn, and the session owns it", () => {
  const start = { action: "start", name: "task" } as const;

  test("a start sends a client-minted, non-wake turnId; ownsTurn says it is ours", async () => {
    const d = fakeDaemon({ [Method.Workflow]: () => ({ ok: true, runId: "wf-1" }) });
    const { client, session } = await attach(d, { daemonWakes: true });
    expect(await session.workflow(start)).toEqual({ ok: true, runId: "wf-1" });
    const sent = d.sent.at(-1);
    expect(sent?.method).toBe(Method.Workflow);
    const params = sent?.params as { sessionId: string; turnId: string; name: string };
    expect(params.sessionId).toBe("s1");
    expect(params.name).toBe("task");
    expect(typeof params.turnId).toBe("string");
    // A client may not mint a wake turn (`connection.ts` refuses one), and the
    // run's asks are attributed to this id.
    expect(params.turnId.startsWith("wake-")).toBe(false);
    expect(session.ownsTurn(params.turnId)).toBe(true);
    client.close();
  });

  test("resume and rerun_step mint one too; stop carries none", async () => {
    const d = fakeDaemon({ [Method.Workflow]: () => ({ ok: true }) });
    const { client, session } = await attach(d, { daemonWakes: true });
    await session.workflow({ action: "resume", runId: "wf-1" });
    const resumed = d.sent.at(-1)?.params as { turnId: string };
    expect(session.ownsTurn(resumed.turnId)).toBe(true);
    await session.workflow({ action: "rerun_step", runId: "wf-1", stepId: "merge" });
    const rerun = d.sent.at(-1)?.params as { turnId: string; stepId: string };
    expect(rerun.stepId).toBe("merge");
    expect(session.ownsTurn(rerun.turnId)).toBe(true);
    await session.workflow({ action: "stop", runId: "wf-1" });
    expect(d.sent.at(-1)?.params).toEqual({ sessionId: "s1", action: "stop", runId: "wf-1" });
    client.close();
  });

  test("a refusal is a VALUE with its reason, never a throw at a UI", async () => {
    const d = fakeDaemon({
      [Method.Workflow]: () => ({ ok: false, reason: "wf-1 is still running" }),
    });
    const { client, session } = await attach(d, { daemonWakes: true });
    expect(await session.workflow({ action: "start", name: "task" })).toEqual({
      ok: false,
      reason: "wf-1 is still running",
    });
    client.close();
  });

  test("an older daemon's MethodNotFound is the same typed refusal", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d, { daemonWakes: true });
    expect(await session.workflow(start)).toEqual({ ok: false, reason: WORKFLOW_OLD_DAEMON });
    client.close();
  });
});

describe("the two reads: a MethodNotFound is `{unsupported:true}`, never a throw", () => {
  test("workflowStep answers with the step's detail, or says the daemon is older", async () => {
    const detail = { attempt: 1, round: 0, live: false, prompt: "p", report: "r" };
    const d = fakeDaemon({ [Method.WorkflowStep]: () => ({ detail }) });
    const { client, session } = await attach(d, { daemonWakes: true });
    expect(await session.workflowStep("wf-1", "merge", 1)).toEqual({ detail });
    expect(d.sent.at(-1)?.params).toEqual({
      sessionId: "s1",
      runId: "wf-1",
      stepId: "merge",
      attempt: 1,
    });
    // No attempt asked: the newest execution (the daemon decides).
    await session.workflowStep("wf-1", "merge");
    expect(d.sent.at(-1)?.params).toEqual({ sessionId: "s1", runId: "wf-1", stepId: "merge" });
    client.close();

    const older = fakeDaemon();
    const b = await attach(older, { daemonWakes: true });
    expect(await b.session.workflowStep("wf-1", "merge")).toEqual({ unsupported: true });
    b.client.close();
  });

  test("workflowList reads the daemon's runs, or says it is older", async () => {
    const row = {
      sessionId: "s1",
      runId: "wf-1",
      name: "task",
      state: "needs-approval",
      step: "deploy",
      done: 1,
      total: 3,
      needsUser: true,
      startedAt: 5,
    };
    const d = fakeDaemon({ [Method.WorkflowList]: () => ({ runs: [row] }) });
    const { client } = await attach(d, { daemonWakes: true });
    const list = await client.workflowList();
    expect("unsupported" in list).toBe(false);
    expect("runs" in list ? list.runs.map((r) => r.runId) : []).toEqual(["wf-1"]);
    client.close();

    const older = fakeDaemon();
    const b = await attach(older, { daemonWakes: true });
    expect(await b.client.workflowList()).toEqual({ unsupported: true });
    b.client.close();
  });
});

describe("session/workflow_catalogue (slice 5a): the three answers are distinct", () => {
  const catalogue = {
    dir: "/proj/.tentacle/workflows",
    workflows: [
      {
        name: "task",
        path: ".tentacle/workflows/task.yaml",
        ok: true,
        version: 1,
        hash: "a".repeat(64),
        approved: false,
        inputs: [{ name: "slug", required: true }],
        steps: [{ id: "build", kind: "run", where: "local", command: "make test" }],
      },
    ],
  };

  test("a daemon that answers gives the rows, and the request is session-scoped", async () => {
    const d = fakeDaemon({ [Method.WorkflowCatalogue]: () => catalogue });
    const { client, session } = await attach(d, { daemonWakes: true });
    const answer = await session.workflowCatalogue();
    expect("unsupported" in answer).toBe(false);
    expect("workflows" in answer ? answer.workflows[0]?.name : "").toBe("task");
    expect("dir" in answer ? answer.dir : "").toBe("/proj/.tentacle/workflows");
    expect(d.sent.at(-1)).toEqual({
      method: Method.WorkflowCatalogue,
      params: { sessionId: "s1" },
    });
    client.close();
  });

  test('an OLDER daemon is `{unsupported:true}` — "update tentacle", not "no workflows"', async () => {
    // Mutation: map MethodNotFound to an empty catalogue → the phone offers no
    // Start and blames the folder, instead of telling the user to update.
    const d = fakeDaemon();
    const { client, session } = await attach(d, { daemonWakes: true });
    expect(await session.workflowCatalogue()).toEqual({ unsupported: true });
    client.close();
  });

  test("the trust bit off sends NOTHING and refuses locally", async () => {
    const d = fakeDaemon({ [Method.WorkflowCatalogue]: () => catalogue });
    const { client, session } = await attach(d);
    const answer = await session.workflowCatalogue();
    expect("unsupported" in answer).toBe(false);
    expect("unavailable" in answer ? answer.unavailable : undefined).toBe(
      WORKFLOW_UNTRUSTED_DAEMON,
    );
    expect(d.sent.some((s) => s.method === Method.WorkflowCatalogue)).toBe(false);
    client.close();
  });

  test("a start carries the hash the user saw, and still mints its turn", async () => {
    // Mutation: drop `hash` from the params → the daemon runs the CURRENT file,
    // an edit the user never reviewed.
    const d = fakeDaemon({ [Method.Workflow]: () => ({ ok: true, runId: "wf-1" }) });
    const { client, session } = await attach(d, { daemonWakes: true });
    const hash = "b".repeat(64);
    await session.workflow({
      action: "start",
      name: "task",
      hash,
      inputs: [{ name: "slug", value: "x" }],
    });
    const params = d.sent.at(-1)?.params as {
      hash: string;
      name: string;
      inputs: { name: string; value: string }[];
      turnId: string;
    };
    expect(params.hash).toBe(hash);
    expect(params.inputs).toEqual([{ name: "slug", value: "x" }]);
    expect(session.ownsTurn(params.turnId)).toBe(true);
    client.close();
  });
});

describe("the reverse mapping: `workflows` is a listener's fact, not a turn event", () => {
  test("the session's listener gives the state at once when one was reported", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d, { daemonWakes: true });
    d.notify({ type: "workflows", runs: [run(1)] });
    await until(() => session.workflows !== undefined);
    // Subscribed LATE (a panel opened after the frame): the state is given once,
    // like `onSubagents` (`remote-session.ts:1104`), never an empty first paint.
    const seen: string[][] = [];
    session.onWorkflows((rows) => seen.push(rows.map((r) => r.runId)));
    expect(seen).toEqual([["wf-1"]]);
    client.close();
  });
});
