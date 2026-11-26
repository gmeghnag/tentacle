/**
 * `workflow-run-controller.ts` (docs/feat/workflows-ui.md D4, slice 3): one run,
 * graph ⇄ cards — the attach (and what an ended session gives), the run picked
 * from the session's own feed, the ask ↔ step pairing, the answer through the
 * sheet's ONE path with that ask's `requestId`, and stop/resume/rerun as notices.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
              if (optionId === "reply") {
                return "typing"; // opens the sheet's field; settles nothing
              }
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
    h.controller.setMode("list");
    expect(h.controller.state().mode).toBe("list");
    expect(h.mode).toBe("list");
  });

  test("the two views are graph ⇄ list — `cards` is not a mode any more (S7/D5)", async () => {
    // `RunMode` names what the screen DRAWS: the 2A cards went with the slice that
    // replaced them, and a mode still called `cards` would outlive its screen.
    const src = readFileSync(
      join(import.meta.dir, "..", "src", "workflow-run-controller.ts"),
      "utf8",
    );
    expect(src).toContain('export type RunMode = "graph" | "list"');
    expect(src).not.toContain('"cards"');
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

describe("S8 — pairing by the structured origin, and the slim bar", () => {
  const wf = (runId: string | null, stepId: string | null) => ({
    kind: "workflow" as const,
    name: "wf",
    runId,
    stepId,
    position: null,
  });
  const ask = (requestId: string, origin?: CardAsk["origin"], agentId?: string): CardAsk => ({
    requestId,
    title: "Approve",
    detail: "x",
    ...(origin === undefined ? {} : { origin }),
    ...(agentId === undefined ? {} : { agent: { id: agentId } }),
  });

  test("an ask pairs with its step by origin.runId/stepId, not by the agent id", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    // The agent id is MISLEADING on purpose: only the origin may decide.
    h.ask(ask("a1", wf("wf-1", "merge"), "wf-9.build"));
    expect(h.controller.state().steps.find((s) => s.step.id === "merge")?.ask?.requestId).toBe(
      "a1",
    );
    expect(h.controller.state().steps.find((s) => s.step.id === "build")?.ask).toBeNull();
  });

  test("another run's origin never pairs, even when the agent id says it is ours", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(ask("a2", wf("wf-2", "merge"), "wf-1.merge"));
    expect(h.controller.state().steps.every((s) => s.ask === null)).toBe(true);
    expect(h.controller.state().runAsk).toBeNull();
  });

  test("the run's own approval is origin {runId, stepId: null}", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(ask("a3", wf("wf-1", null)));
    expect(h.controller.state().runAsk?.requestId).toBe("a3");
  });

  test("an origin with no run id falls back to the agent id (older daemon)", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(ask("a4", wf(null, "merge"), "wf-1.merge"));
    expect(h.controller.state().steps.find((s) => s.step.id === "merge")?.ask?.requestId).toBe(
      "a4",
    );
  });

  test("a foreign ask (main agent, another run) is a slim `foreign` bar, never answerable here", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(ask("a5", { kind: "main" }));
    const bar = h.controller.state().askBar;
    expect(bar?.kind).toBe("foreign");
    h.controller.answer(null, "allow_once");
    h.controller.answer("merge", "allow_once");
    expect(h.answered).toEqual([]);
  });

  test("askSourceFromSheet carries the origin and the sheet's unpark (the slim row's tap)", () => {
    let unparked = 0;
    const origin = wf("wf-1", "merge");
    const src = askSourceFromSheet({
      view: () =>
        ({
          kind: "asking",
          requestId: "r1",
          request: { title: "T", detail: "D" },
          agentId: null,
          origin,
        }) as unknown as SheetState,
      answerFor: () => "ignored",
      subscribe: () => () => {},
      unpark: () => {
        unparked += 1;
      },
    });
    expect(src.current()?.origin).toEqual(origin);
    src.unpark?.();
    expect(unparked).toBe(1);
  });

  test("canAnswer=false: the bar sends to the session (`open-session`)", async () => {
    const h = harness({ asks: false });
    h.controller.start();
    await h.flush();
    h.push([run()]);
    expect(h.controller.state().askBar?.kind).toBe("open-session");
  });
});

// docs/fix/a2a-question-workflow-label.md D4/D5: a remote QUESTION of a step
// pairs like any other ask — and its bar takes text, not a grant.
describe("a remote question's bar says `Answer`", () => {
  const wf = (runId: string | null, stepId: string | null) => ({
    kind: "workflow" as const,
    name: "wf",
    runId,
    stepId,
    position: null,
  });
  const question = (requestId: string, origin?: CardAsk["origin"]): CardAsk => ({
    requestId,
    title: "acme asks",
    detail: "Which branch?",
    question: true,
    ...(origin === undefined ? {} : { origin }),
  });

  test("the question pairs with its step and the bar's action is `answer`", async () => {
    // Mutation: hard-code `action: "review"` in `askBarFor` → red.
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(question("q1", wf("wf-1", "merge")));
    expect(h.controller.state().steps.find((s) => s.step.id === "merge")?.ask?.requestId).toBe(
      "q1",
    );
    const bar = h.controller.state().askBar;
    expect(bar?.kind === "ask" && bar.action).toBe("answer");
  });

  test("an approval's bar is still `review`", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask({ requestId: "a1", title: "Approve", detail: "x", origin: wf("wf-1", "merge") });
    const bar = h.controller.state().askBar;
    expect(bar?.kind === "ask" && bar.action).toBe("review");
  });

  test("its tap opens the field BY ID and sends no allow/reject", async () => {
    // Mutation: route the tap through `allow_once` → red (a grant sent for a question).
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(question("q2", wf("wf-1", "merge")));
    h.controller.openAnswer();
    expect(h.answered).toEqual([{ requestId: "q2", optionId: "reply" }]);
    // Opening the field settles nothing: the ask is still the bar's.
    expect(h.controller.state().askBar?.kind).toBe("ask");
    expect(h.controller.state().notice).toBeNull();
  });

  test("a question of ANOTHER run stays foreign (`Open the session`), never answerable here", async () => {
    // Mutation: drop the `runId` test in `askForRunStep` → it pairs with our step → red.
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(question("q3", wf("wf-2", "merge")));
    expect(h.controller.state().askBar?.kind).toBe("foreign");
    h.controller.openAnswer();
    expect(h.answered).toEqual([]);
  });

  test("an ask settled meanwhile: the tap sends nothing, and a notice says so", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([run()]);
    h.ask(question("q4", wf("wf-1", "merge")));
    h.ask(null); // answered on another device, or withdrawn
    h.controller.openAnswer();
    expect(h.answered).toEqual([]);
    expect(h.controller.state().notice).toBe(RUN_ASK_GONE);
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

  test("`banner()` is offered only with `queued`: the landing's banner, counted", () => {
    const base = { answerFor: () => "sent" as const, subscribe: () => () => {} };
    const view = () => asking({ parked: false, reviewed: false });
    // The run screen passes no `queued`: it is unchanged (no banner method).
    expect(askSourceFromSheet({ view, ...base }).banner).toBeUndefined();
    const src = askSourceFromSheet({ view, queued: () => 1, ...base });
    expect(src.banner?.()).toEqual({ title: "Approve merge", originShort: "Main agent", more: 1 });
    // A local ask (no daemon id) shows too; a sheet that is up does not.
    const local = askSourceFromSheet({
      view: () => asking({ requestId: null, parked: false, reviewed: false }),
      queued: () => 0,
      ...base,
    });
    expect(local.banner?.()?.title).toBe("Approve merge");
    const up = askSourceFromSheet({
      view: () => asking({ parked: false, reviewed: true }),
      queued: () => 0,
      ...base,
    });
    expect(up.banner?.()).toBeNull();
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
