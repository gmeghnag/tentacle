/**
 * `workflow-run-controller.ts` (docs/feat/workflows-ui.md D4, slice 3): one run,
 * graph ⇄ cards — the attach (and what an ended session gives), the run picked
 * from the session's own feed, the ask ↔ step pairing, the answer through the
 * sheet's ONE path with that ask's `requestId`, and stop/resume/rerun as notices.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowAction } from "@tentacle/client";
import type { WorkflowResult, WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";
import type { SheetState } from "../src/permission-sheet.ts";
import {
  type CardAsk,
  RUN_ASK_GONE,
  type RunMode,
  SESSION_ENDED,
  askSourceFromSheet,
  createWorkflowRunController,
} from "../src/workflow-run-controller.ts";

const step = (id: string, state: string, over: Partial<WorkflowStepRow> = {}): WorkflowStepRow => ({
  id,
  kind: "agent",
  where: "local",
  state,
  attempt: 0,
  round: 0,
  next: null,
  onFail: null,
  retry: 0,
  ...over,
});

const run = (over: Partial<WorkflowRow> = {}): WorkflowRow => ({
  runId: "wf-1",
  name: "task",
  version: 1,
  hash: "a".repeat(64),
  state: "needs-approval",
  tokens: 0,
  startedAt: 1_000,
  history: [],
  historyDropped: 0,
  steps: [step("build", "ok"), step("merge", "needs-approval", { kind: "approve" })],
  ...over,
});

function harness(
  opts: {
    open?: "ok" | "archived" | "gone" | "deleted" | "link";
    borrowed?: boolean;
    asks?: boolean;
    reply?: WorkflowResult | { ok: false; reason: string };
  } = {},
) {
  const feed = new Set<(rows: readonly WorkflowRow[]) => void>();
  let current: CardAsk | null = null;
  const askListeners = new Set<() => void>();
  const answered: { requestId: string; optionId: string }[] = [];
  const sent: WorkflowAction[] = [];
  const openCalls: unknown[][] = [];
  let leaves = 0;
  let mode: RunMode = "graph";
  const session = {
    onWorkflows(fn: (rows: readonly WorkflowRow[]) => void) {
      feed.add(fn);
      return () => feed.delete(fn);
    },
    async workflow(action: WorkflowAction) {
      sent.push(action);
      return opts.reply ?? { ok: true };
    },
  };
  const controller = createWorkflowRunController({
    runId: "wf-1",
    sessionId: "s1",
    borrowed: opts.borrowed ?? false,
    open: async (...args: unknown[]) => {
      openCalls.push(args);
      const o = opts.open ?? "ok";
      return o === "ok" ? { ok: true as const, session } : { ok: false as const, reason: o };
    },
    leave: () => {
      leaves += 1;
    },
    asks:
      opts.asks === false
        ? null
        : {
            current: () => current,
            answerFor: (requestId, optionId) => {
              if (current?.requestId !== requestId) {
                return "ignored";
              }
              answered.push({ requestId, optionId });
              current = null;
              for (const fn of askListeners) fn();
              return "sent";
            },
            subscribe: (fn) => {
              askListeners.add(fn);
              return () => askListeners.delete(fn);
            },
          },
    mode: {
      get: () => mode,
      set: (m) => {
        mode = m;
      },
    },
  });
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  return {
    controller,
    flush,
    push: (rows: readonly WorkflowRow[]) => {
      for (const fn of feed) fn(rows);
    },
    ask: (a: CardAsk | null) => {
      current = a;
      for (const fn of askListeners) fn();
    },
    feed,
    answered,
    sent,
    openCalls,
    get leaves() {
      return leaves;
    },
    get mode() {
      return mode;
    },
  };
}

const MERGE_ASK: CardAsk = {
  requestId: "ask-9",
  agent: { id: "wf-1.merge" },
  title: "Approve merge",
  detail: "git merge --no-ff feature",
};

describe("the attach", () => {
  test("opens the session WITHOUT reopen (an archived session is never revived, §7)", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    expect(h.openCalls).toEqual([["s1"]]);
  });

  test("a session that ended between list and tap → `This session has ended`, nothing else sent", async () => {
    for (const reason of ["archived", "gone", "deleted"] as const) {
      const h = harness({ open: reason });
      h.controller.start();
      await h.flush();
      expect(h.controller.state()).toMatchObject({ phase: "ended", notice: SESSION_ENDED });
      expect(h.openCalls).toHaveLength(1);
    }
    expect(SESSION_ENDED).toBe("This session has ended");
  });

  test("a link failure is its own state, not `ended`", async () => {
    const h = harness({ open: "link" });
    h.controller.start();
    await h.flush();
    expect(h.controller.state().phase).toBe("failed");
  });

  test("leaving detaches a session this screen opened — never one another screen follows", async () => {
    const own = harness();
    own.controller.start();
    await own.flush();
    own.controller.dispose();
    expect(own.leaves).toBe(1);
    expect(own.feed.size).toBe(0);

    const borrowed = harness({ borrowed: true });
    borrowed.controller.start();
    await borrowed.flush();
    borrowed.controller.dispose();
    expect(borrowed.leaves).toBe(0);
  });
});

describe("the run, from the session's own feed", () => {
  test("the run is picked by runId; until the feed has it, run is null", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    expect(h.controller.state()).toMatchObject({ phase: "ready", run: null });
    h.push([run({ runId: "wf-2", name: "other" }), run()]);
    expect(h.controller.state().run?.runId).toBe("wf-1");
    expect(h.controller.state().steps.map((s) => s.step.id)).toEqual(["build", "merge"]);
  });

  test("an unknown state from a newer daemon is shown as its own word, never coerced", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run({ steps: [step("x", "teleporting")] })]);
    expect(h.controller.state().steps[0]?.look).toMatchObject({ tone: null, word: "teleporting" });
  });

  test("the view mode toggles and is remembered through the injected store", async () => {
    const h = harness();
    expect(h.controller.state().mode).toBe("graph");
    h.controller.setMode("cards");
    expect(h.controller.state().mode).toBe("cards");
    expect(h.mode).toBe("cards");
  });
});

describe("ask ↔ step pairing and the answer", () => {
  test("the pending ask is paired with ITS step (exact `<runId>.<stepId>`), verbatim", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(MERGE_ASK);
    const merge = h.controller.state().steps.find((s) => s.step.id === "merge");
    expect(merge?.ask).toEqual(MERGE_ASK);
    expect(h.controller.state().steps.find((s) => s.step.id === "build")?.ask).toBeNull();
    // `wf-11`'s ask is not `wf-1`'s.
    h.ask({ ...MERGE_ASK, agent: { id: "wf-11.merge" } });
    expect(h.controller.state().steps.find((s) => s.step.id === "merge")?.ask).toBeNull();
  });

  test("the run's own hash approval (`<runId>`) is the run's ask, not a step's", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask({ ...MERGE_ASK, agent: { id: "wf-1" } });
    expect(h.controller.state().runAsk?.requestId).toBe("ask-9");
    expect(h.controller.state().steps.every((s) => s.ask === null)).toBe(true);
  });

  test("Allow once goes through the sheet's path with THAT requestId", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(MERGE_ASK);
    h.controller.answer("merge", "allow_once");
    expect(h.answered).toEqual([{ requestId: "ask-9", optionId: "allow_once" }]);
    // Settled: the buttons are gone, the card falls back to the step's state.
    expect(h.controller.state().steps.find((s) => s.step.id === "merge")?.ask).toBeNull();
  });

  test("answered elsewhere first: the ask leaves, the buttons go, and a late tap sends nothing", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(MERGE_ASK);
    h.ask(null); // `permission_resolved` from another device
    expect(h.controller.state().steps.find((s) => s.step.id === "merge")?.ask).toBeNull();
    h.controller.answer("merge", "reject_once");
    expect(h.answered).toEqual([]);
    expect(h.controller.state().notice).toBe(RUN_ASK_GONE);
  });

  test("the sheet moved to an UNRELATED ask: a card's tap answers nothing (never that ask)", async () => {
    // review round 2, #2: the controller must pass the id of ITS step's ask, never
    // whatever is on the sheet — another step, the run's hash, a plain shell ask.
    const others: CardAsk[] = [
      { ...MERGE_ASK, requestId: "ask-other-step", agent: { id: "wf-1.build" } },
      { ...MERGE_ASK, requestId: "ask-hash", agent: { id: "wf-1" } },
      { ...MERGE_ASK, requestId: "ask-shell", agent: { id: "wf-11.merge" } },
      { requestId: "ask-plain", title: "Run command", detail: "rm -rf build" },
    ];
    for (const other of others) {
      const h = harness();
      h.controller.start();
      await h.flush();
      h.push([run()]);
      h.ask(MERGE_ASK);
      h.ask(other); // the card was drawn for merge's ask; the sheet moved on
      h.controller.answer("merge", "allow_once");
      expect(h.answered).toEqual([]);
      expect(h.controller.state().notice).toBe(RUN_ASK_GONE);
    }
    // And the run's own buttons never answer a step's ask.
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(MERGE_ASK);
    h.controller.answer(null, "allow_once");
    expect(h.answered).toEqual([]);
    expect(h.controller.state().notice).toBe(RUN_ASK_GONE);
  });

  test("no ask source (the session's screen is not up): no buttons, ever", async () => {
    const h = harness({ asks: false });
    h.controller.start();
    await h.flush();
    h.push([run()]);
    expect(h.controller.state().steps.every((s) => s.ask === null)).toBe(true);
    expect(h.controller.state().canAnswer).toBe(false);
  });
});

describe("askSourceFromSheet: the session's ONE sheet as a card's ask source", () => {
  const asking = (over: Record<string, unknown> = {}) =>
    ({
      kind: "asking",
      seq: 1,
      requestId: "ask-9",
      request: {
        tool: "workflow",
        level: "ask",
        kind: "workflow_approve",
        title: "Approve merge",
        detail: "git merge --no-ff feature\nline two",
        input: {},
      },
      options: [],
      replyText: "",
      replyOpen: false,
      armed: true,
      armedInMs: 0,
      agent: null,
      agentId: "wf-1.merge",
      alsoAsked: [],
      ...over,
    }) as unknown as SheetState;

  test("the ask on the sheet, title and detail VERBATIM (multi-line kept)", () => {
    const src = askSourceFromSheet({
      view: () => asking(),
      answerFor: () => "sent",
      subscribe: () => () => {},
    });
    expect(src.current()).toEqual({
      requestId: "ask-9",
      agent: { id: "wf-1.merge" },
      title: "Approve merge",
      detail: "git merge --no-ff feature\nline two",
    });
  });

  test("idle, a returned reply, or an ask with no daemon id → no card ask", () => {
    for (const view of [
      { kind: "idle" } as SheetState,
      asking({ requestId: null }),
      { kind: "returned", text: "", cause: "settled", notice: "" } as unknown as SheetState,
    ]) {
      const src = askSourceFromSheet({
        view: () => view,
        answerFor: () => "sent",
        subscribe: () => () => {},
      });
      expect(src.current()).toBeNull();
    }
  });

  test("an ask with no agent id carries no pairing id (never a step's ask)", () => {
    const src = askSourceFromSheet({
      view: () => asking({ agentId: null }),
      answerFor: () => "sent",
      subscribe: () => () => {},
    });
    expect(src.current()?.agent).toBeUndefined();
  });
});

describe("stop / resume / rerun step", () => {
  test("each is sent as the session's `workflow` action for this run", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    await h.controller.stop();
    await h.controller.resume();
    await h.controller.rerun("build");
    expect(h.sent).toEqual([
      { action: "stop", runId: "wf-1" },
      { action: "resume", runId: "wf-1" },
      { action: "rerun_step", runId: "wf-1", stepId: "build" },
    ]);
  });

  test("a refusal is a notice with the daemon's reason (never a throw)", async () => {
    const h = harness({ reply: { ok: false, reason: "a run is already running" } });
    h.controller.start();
    await h.flush();
    await h.controller.resume();
    expect(h.controller.state().notice).toBe("a run is already running");
  });

  test("before the attach nothing is sent", async () => {
    const h = harness({ open: "gone" });
    h.controller.start();
    await h.flush();
    await h.controller.stop();
    expect(h.sent).toEqual([]);
  });
});
