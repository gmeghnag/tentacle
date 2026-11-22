import { describe, expect, test } from "bun:test";
import {
  type WorkflowAction,
  type WorkflowEvent,
  type WorkflowRunState,
  type WorkflowSpec,
  endReason,
  isTerminal,
  missingInputs,
  next,
  rerunAt,
  resolveInputs,
  start,
  validateWorkflow,
} from "../src/index.ts";

/** A spec built through the real validator — the machine never sees hand-made data. */
function spec(yaml: string): WorkflowSpec {
  const result = validateWorkflow(`schemaVersion: 1\nname: t\nversion: 1\n${yaml}`, {
    readPrompt: () => "the prompt",
  });
  if (!result.ok) {
    throw new Error(`fixture refused: ${result.errors.join(" | ")}`);
  }
  return result.spec;
}

/** A plain step that can pass or fail; `extra` adds retry/on_fail/next. */
function step(id: string, extra = ""): string {
  const indented =
    extra === ""
      ? ""
      : `\n${extra
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")}`;
  return `  - id: ${id}\n    agent: { prompt_text: "${id}" }${indented}`;
}

const pass = (tokens = 0): WorkflowEvent => ({ kind: "step_result", verdict: "pass", tokens });
const fail = (reason = "broke", tokens = 0): WorkflowEvent => ({
  kind: "step_result",
  verdict: "fail",
  reason,
  tokens,
});

/** Drive a scripted event list and record every action, in order. */
function drive(
  initial: { state: WorkflowRunState; action: WorkflowAction },
  events: readonly WorkflowEvent[],
): { actions: WorkflowAction[]; state: WorkflowRunState } {
  const actions: WorkflowAction[] = [initial.action];
  let state = initial.state;
  for (const event of events) {
    const step2 = next(state, event);
    state = step2.state;
    actions.push(step2.action);
  }
  return { actions, state };
}

/** The `run_step` ids of an action list, for the order assertion. */
function ids(actions: readonly WorkflowAction[]): string[] {
  return actions.map((a) => (a.kind === "run_step" ? a.id : `end:${a.status}`));
}

describe("start — the run begins on the first step", () => {
  test("the first step's action carries its templated text", () => {
    const s = spec(
      `inputs: { slug: { required: true } }\nsteps:\n  - id: plan\n    agent: { prompt_text: "plan {{inputs.slug}}" }\n  - id: exec\n    agent: { prompt_text: "exec" }\n`,
    );
    const begun = start(s, { slug: "agent-workflows" });
    expect(begun.action).toEqual({
      kind: "run_step",
      id: "plan",
      attempt: 0,
      round: 0,
      text: "plan agent-workflows",
    });
    expect(begun.state.tokens).toBe(0);
    expect(begun.state.executions).toBe(1);
  });

  test("inputs resolve to the given value, else the default, else empty", () => {
    const s = spec(
      `inputs: { slug: { required: true }, doc: { default: "docs/x.md" }, opt: {} }\nsteps:\n${step("only")}\n`,
    );
    expect(resolveInputs(s, { slug: "a" })).toEqual({ slug: "a", doc: "docs/x.md", opt: "" });
    expect(missingInputs(s, {})).toEqual(["slug"]);
    expect(missingInputs(s, { slug: "a" })).toEqual([]);
  });
});

describe("next — order, retry, goto counters, budgets", () => {
  test("a passing run walks the fall-through order and ends ok", () => {
    const s = spec(`steps:\n${step("a")}\n${step("b")}\n${step("c")}\n`);
    const { actions, state } = drive(start(s), [pass(), pass(), pass()]);
    expect(ids(actions)).toEqual(["a", "b", "c", "end:ok"]);
    expect(state.status).toBe("ok");
    expect(isTerminal(state)).toBe(true);
  });

  test("`next` replaces the fall-through after pass", () => {
    const s = spec(`steps:\n${step("a", "next: c")}\n${step("b")}\n${step("c")}\n`);
    const { actions } = drive(start(s), [pass(), pass()]);
    expect(ids(actions)).toEqual(["a", "c", "end:ok"]);
  });

  test("retry 1 re-runs the SAME step once before on_fail", () => {
    const s = spec(
      `steps:\n  - id: a\n    agent: { prompt_text: "a" }\n    retry: 1\n  - id: b\n    agent: { prompt_text: "b" }\n`,
    );
    const { actions } = drive(start(s), [fail(), pass(), pass()]);
    expect(ids(actions)).toEqual(["a", "a", "b", "end:ok"]);
    const retry = actions[1];
    expect(retry?.kind === "run_step" && retry.attempt).toBe(1);
  });

  test("retry exhausted then fail with no on_fail ends error, naming the reason", () => {
    const s = spec(
      `steps:\n  - id: a\n    agent: { prompt_text: "a" }\n    retry: 1\n  - id: b\n    agent: { prompt_text: "b" }\n`,
    );
    const { actions, state } = drive(start(s), [fail("boom"), fail("boom again")]);
    expect(ids(actions)).toEqual(["a", "a", "end:error"]);
    expect(state.status).toBe("error");
    expect(actions[2]?.kind === "end" && actions[2].reason).toContain("a failed — boom again");
  });

  test("on_fail goto jumps, and the counter stops it at max", () => {
    // review --fail--> fix (max 2), fix --pass--> review; review --pass--> gate
    const s = spec(
      `steps:\n  - id: review\n    agent: { prompt_text: "r" }\n    on_fail: { goto: fix, max: 2 }\n    next: gate\n  - id: fix\n    agent: { prompt_text: "f" }\n    next: review\n  - id: gate\n    agent: { prompt_text: "g" }\n`,
    );
    const { actions, state } = drive(start(s), [
      fail("r1"),
      pass(),
      fail("r2"),
      pass(),
      fail("r3"),
    ]);
    expect(ids(actions)).toEqual(["review", "fix", "review", "fix", "review", "end:error"]);
    const rounds = actions
      .filter((a) => a.kind === "run_step" && a.id === "fix")
      .map((a) => a.kind === "run_step" && a.round);
    expect(rounds).toEqual([1, 2]);
    expect(state.stopReason).toBeUndefined();
    expect(endReason(state)).toContain("on_fail.goto fix already ran 2/2 times");
  });

  test("a goto loop that eventually passes ends ok, and the round carries its max", () => {
    const s = spec(
      `steps:\n  - id: review\n    agent: { prompt_text: "r" }\n    on_fail: { goto: fix, max: 3 }\n    next: gate\n  - id: fix\n    agent: { prompt_text: "f" }\n    next: review\n  - id: gate\n    agent: { prompt_text: "g" }\n`,
    );
    const { actions, state } = drive(start(s), [fail(), pass(), pass(), pass()]);
    expect(ids(actions)).toEqual(["review", "fix", "review", "gate", "end:ok"]);
    expect(actions[1]).toEqual({
      kind: "run_step",
      id: "fix",
      attempt: 0,
      round: 1,
      maxRound: 3,
      text: "f",
    });
    expect(state.status).toBe("ok");
    expect(endReason(state)).toBe("done · 4 steps · 0 tok");
  });

  test("counters are per EDGE, so two loops never share one", () => {
    const s = spec(
      `steps:\n  - id: a\n    agent: { prompt_text: "a" }\n    on_fail: { goto: b, max: 1 }\n  - id: b\n    agent: { prompt_text: "b" }\n    on_fail: { goto: a, max: 1 }\n`,
    );
    // a --fail--> b, b --fail--> a: two edges, one counter each. With a single
    // shared counter the second goto would be refused on its first use.
    const { actions, state } = drive(start(s), [fail(), fail(), fail("a again")]);
    expect(ids(actions)).toEqual(["a", "b", "a", "end:error"]);
    expect(state.counters).toEqual({ "a->b": 1, "b->a": 1 });
    expect(endReason(state)).toContain("on_fail.goto b already ran 1/1 times");
  });

  test("max_step_runs stops a long loop before the next step starts", () => {
    // A loop made only of counted goto edges: nothing else bounds it.
    const s = spec(
      `budget: { max_step_runs: 4 }\nsteps:\n  - id: a\n    agent: { prompt_text: "a" }\n    on_fail: { goto: b, max: 10 }\n  - id: b\n    agent: { prompt_text: "b" }\n    on_fail: { goto: a, max: 10 }\n`,
    );
    const { actions, state } = drive(start(s), [fail(), fail(), fail(), fail()]);
    expect(state.status).toBe("stopped");
    expect(state.stopReason).toBe("budget");
    expect(state.executions).toBe(4);
    expect(ids(actions)).toEqual(["a", "b", "a", "b", "end:stopped"]);
    const last = actions.at(-1);
    expect(last?.kind === "end" ? last.reason : "not an end").toBe("budget spent (0 tok, 4 steps)");
  });

  test("the token sum stops the run BEFORE the next step, not after it", () => {
    const s = spec(`budget: { tokens: 100 }\nsteps:\n${step("a")}\n${step("b")}\n${step("c")}\n`);
    const { actions, state } = drive(start(s), [pass(60), pass(40)]);
    // 60 passes step a → b still starts; 40 more reaches 100 → c never starts.
    expect(ids(actions)).toEqual(["a", "b", "end:stopped"]);
    expect(state.stopReason).toBe("budget");
    expect(state.tokens).toBe(100);
    expect(actions[2]?.kind === "end" && actions[2].reason).toBe("budget spent (100 tok, 2 steps)");
  });

  test("a budget_hit event stops a run whose step had PASSED", () => {
    const s = spec(`steps:\n${step("a")}\n${step("b")}\n`);
    const { actions, state } = drive(start(s), [
      { kind: "budget_hit", reason: "the model said stop" },
    ]);
    expect(ids(actions)).toEqual(["a", "end:stopped"]);
    expect(state.stopReason).toBe("budget");
    expect(actions[1]?.kind === "end" && actions[1].reason).toBe("the model said stop");
  });

  test("timeout, cancel and interrupted each stop with their own reason", () => {
    const s = spec(`steps:\n${step("a")}\n${step("b")}\n`);
    for (const [kind, reason] of [
      ["timeout", "timeout"],
      ["cancel", "cancelled"],
      ["interrupted", "interrupted"],
      ["changed", "changed"],
    ] as const) {
      const { state, actions } = drive(start(s), [{ kind }]);
      expect(state.status).toBe("stopped");
      expect(state.stopReason).toBe(reason);
      expect(actions[1]?.kind).toBe("end");
    }
  });

  test("a terminal state is FINAL: a late event cannot resurrect the run", () => {
    const s = spec(`steps:\n${step("a")}\n${step("b")}\n`);
    const done = drive(start(s), [fail("final")]);
    expect(done.state.status).toBe("error");
    const after = next(done.state, pass());
    expect(after.state).toBe(done.state);
    expect(after.action).toEqual(done.actions.at(-1) as WorkflowAction);
  });

  test("a fail's reason is capped, and the outcome is kept for templating", () => {
    const s = spec(`steps:\n${step("a")}\n${step("b")}\n`);
    const long = "x".repeat(5000);
    const { state } = drive(start(s), [fail(long)]);
    const outcome = state.outcomes.a;
    expect(outcome?.reason?.length).toBe(2001);
    expect(outcome?.reason?.endsWith("…")).toBe(true);
    expect(outcome?.verdict).toBe("fail");
    expect(outcome?.tokens).toBe(0);
  });

  test("{{steps.<id>.report}} renders the LATEST attempt's report", () => {
    const s = spec(
      `steps:\n  - id: exec\n    agent: { prompt_text: "do it" }\n    retry: 1\n  - id: review\n    agent: { prompt_text: "review: {{steps.exec.report}}" }\n`,
    );
    const { actions } = drive(start(s), [
      { kind: "step_result", verdict: "fail", reason: "no", report: "first try" },
      { kind: "step_result", verdict: "pass", report: "second try" },
    ]);
    expect(actions[2]?.kind === "run_step" && actions[2].text).toBe("review: second try");
  });
});

describe("rerunAt — resume from a step, from scratch", () => {
  test("re-enters the cut step with attempt + 1 and keeps the counters", () => {
    const s = spec(`steps:\n${step("a")}\n${step("b")}\n${step("c")}\n`);
    const begun = start(s);
    const afterA = next(begun.state, pass());
    const interrupted = next(afterA.state, { kind: "interrupted" });
    expect(interrupted.state.status).toBe("stopped");
    const resumed = rerunAt(interrupted.state, "b");
    expect(resumed.action).toEqual({ kind: "run_step", id: "b", attempt: 1, round: 0, text: "b" });
    expect(resumed.state.status).toBe("running");
    expect(resumed.state.stopReason).toBeUndefined();
    // The execution counter is KEPT, so a resume cannot loop forever.
    expect(resumed.state.executions).toBe(afterA.state.executions + 1);
  });

  test("an unknown step id is refused, not started", () => {
    const s = spec(`steps:\n${step("a")}\n`);
    const { action } = rerunAt(start(s).state, "nope");
    expect(action.kind === "end" && action.status).toBe("error");
    expect(action.kind === "end" && action.reason).toContain("nope is not a step of t");
  });

  test("a resumed run still respects max_step_runs", () => {
    const s = spec(
      `budget: { max_step_runs: 2 }\nsteps:\n  - id: a\n    agent: { prompt_text: "a" }\n    retry: 5\n`,
    );
    const begun = start(s);
    const two = next(begun.state, fail());
    const resumed = rerunAt(next(two.state, { kind: "interrupted" }).state, "a");
    expect(resumed.action.kind === "end" && resumed.action.status).toBe("stopped");
  });
});

describe("endReason — one honest sentence per end", () => {
  test("names the step and the reason", () => {
    const s = spec(`steps:\n${step("gate")}\n`);
    const { state } = drive(start(s), [fail("exit 2")]);
    expect(endReason(state)).toBe("gate failed — exit 2");
  });

  test("a fail without a reason still explains itself", () => {
    const s = spec(`steps:\n${step("gate")}\n`);
    const { state } = drive(start(s), [{ kind: "step_result", verdict: "fail" }]);
    expect(endReason(state)).toBe("gate failed");
  });
});
