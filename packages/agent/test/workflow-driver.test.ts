import { describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  NOTE_KIND,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionRequester,
  type PermissionResponse,
  type ToolContext,
  workflowLoadNotes,
  workflowRunSeqFromHistory,
} from "@tentacle/core";
import type {
  SubagentResult,
  SubagentRunControls,
  SubagentRunOptions,
  SubagentRunner,
} from "../src/subagent.ts";
import {
  type WorkflowClock,
  type WorkflowContainerTarget,
  WorkflowDriver,
  type WorkflowDriverDeps,
  type WorkflowHost,
  type WorkflowRow,
  type WorkflowSource,
} from "../src/workflow-driver.ts";

// docs/feat/agent-workflows.md Slice 4 — the driver, fakes only (fake runner,
// spy broker, fake clock). Each test names the failure mode it kills.

const YAML = (body: string): string =>
  `schemaVersion: 1\nname: task\nversion: 3\nbudget: { wait: 1m }\nsteps:\n${body}`;
const TWO_AGENTS = YAML(
  "  - id: plan\n    agent: { prompt_text: plan it }\n  - id: exec\n    agent: { prompt_text: do it }\n",
);

class FakeClock implements WorkflowClock {
  t = 1_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private seq = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.timers.set(this.seq, { at: this.t + ms, fn });
    return this.seq;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(ms: number): void {
    this.t += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.t) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }
}

interface Ask {
  readonly req: PermissionRequest;
  readonly options: PermissionRequestOptions | undefined;
  answer(response: PermissionResponse): void;
}

/** The session's ONE requester: records every ask, answered by the test. */
class SpyBroker {
  readonly asks: Ask[] = [];
  auto: ((req: PermissionRequest) => PermissionResponse | undefined) | undefined;
  readonly request: PermissionRequester = (req, options) =>
    new Promise<PermissionResponse>((resolve) => {
      const preset = this.auto?.(req);
      if (preset !== undefined) {
        this.asks.push({ req, options, answer: () => {} });
        resolve(preset);
        return;
      }
      options?.signal?.addEventListener(
        "abort",
        () => resolve({ allowed: false, dismissed: true }),
        {
          once: true,
        },
      );
      this.asks.push({ req, options, answer: resolve });
    });
}

type ChildScript = (
  opts: SubagentRunOptions,
  controls: SubagentRunControls | undefined,
  ask: PermissionRequester,
) => Promise<SubagentResult>;

/** A child that calls `step_verdict` with `verdict`. */
const says =
  (verdict: "pass" | "fail", reason = "done"): ChildScript =>
  async (_opts, controls) => {
    const tool = controls?.extraTools?.find((t) => t.name === "step_verdict");
    await tool?.execute({ verdict, reason }, {} as ToolContext);
    controls?.onEvent?.({ kind: "subagent_usage", promptTokens: 10, completionTokens: 5 });
    return { report: `report ${reason}`, toolUses: 1, stopReason: "end_turn" };
  };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

function setup(
  over: { text?: string; children?: Record<string, ChildScript>; approved?: boolean } = {},
) {
  const clock = new FakeClock();
  const broker = new SpyBroker();
  const files: { text: string; prompts: Record<string, string> } = {
    text: over.text ?? TWO_AGENTS,
    prompts: {},
  };
  const approvals = new Set<string>();
  const host = {
    entries: [] as { type: string; body: Record<string, unknown> }[],
    attributed: [] as [string, string | undefined][],
    rows: [] as WorkflowRow[][],
    notes: [] as string[],
  };
  const hostImpl: WorkflowHost = {
    logStart: (body) => host.entries.push({ type: "workflow_start", body }),
    logStep: (body) => host.entries.push({ type: "workflow_step", body }),
    logEnd: (body) => host.entries.push({ type: "workflow_end", body }),
    attribute: (agentId, turnId) => host.attributed.push([agentId, turnId]),
    release: () => {},
    publish: (rows) => host.rows.push([...rows]),
    ended: (_runId, note) => host.notes.push(note),
  };
  const children = over.children ?? {};
  const asked: PermissionRequester[] = [];
  const runnerFor = (requester: PermissionRequester): SubagentRunner => {
    asked.push(requester);
    return (opts, controls) => {
      const step = opts.description.split("/")[1] ?? "";
      const script = children[step] ?? says("pass");
      return script(opts, controls, requester);
    };
  };
  const deps: WorkflowDriverDeps = {
    load: async (name): Promise<WorkflowSource> => {
      if (name !== "task") {
        throw new Error(`no workflow ${name}`);
      }
      return { path: ".tentacle/workflows/task.yaml", text: files.text, prompts: files.prompts };
    },
    context: () => ({ models: ["opus", "deepseek"], agentTypes: ["general", "explore"] }),
    approvals: {
      has: async (path, hash) => approvals.has(`${path}#${hash}`),
      add: async (path, hash) => void approvals.add(`${path}#${hash}`),
    },
    request: broker.request,
    runnerFor,
    clock,
  };
  const driver = new WorkflowDriver(deps);
  driver.bind(hostImpl);
  const approveAll = (): void => {
    broker.auto = (req) =>
      req.kind === "workflow_approve" ? { allowed: true, scope: "once" } : undefined;
  };
  if (over.approved === true) {
    approveAll();
  }
  return { driver, broker, host, clock, files, approvals, deps, approveAll };
}

const last = (rows: WorkflowRow[][]): WorkflowRow | undefined => rows.at(-1)?.at(-1);

describe("hash approval (D2)", () => {
  test("an unapproved hash is asked BEFORE any step runs; nothing is logged before the answer", async () => {
    const ran: string[] = [];
    const { driver, broker, host } = setup({
      children: {
        plan: async (o, c, a) => {
          ran.push("plan");
          return says("pass")(o, c, a);
        },
      },
    });
    const started = await driver.start({ name: "task", by: "user", turnId: "t-1" });
    expect(started).toEqual({ ok: true, runId: "wf-1" });
    await flush();
    expect(broker.asks).toHaveLength(1);
    expect(broker.asks[0]?.req.kind).toBe("workflow_approve");
    expect(broker.asks[0]?.req.title).toContain("Run workflow task v3 (hash ");
    expect(ran).toEqual([]);
    expect(host.entries).toEqual([]);
    expect(last(host.rows)?.state).toBe("needs-approval");
    broker.asks[0]?.answer({ allowed: true, scope: "once" });
    await flush();
    expect(ran).toEqual(["plan"]);
    expect(host.entries.map((e) => e.type)).toEqual([
      "workflow_start",
      "workflow_step",
      "workflow_step",
      "workflow_end",
    ]);
  });

  test("an approved hash is not asked again; one edited byte asks again", async () => {
    const { driver, broker, files } = setup();
    void driver.start({ name: "task", by: "user" });
    await flush();
    broker.asks[0]?.answer({ allowed: true });
    await flush();
    expect(driver.current()).toBeUndefined();
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(broker.asks).toHaveLength(1);
    files.text = files.text.replace("do it", "do it!");
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(broker.asks).toHaveLength(2);
    expect(broker.asks[1]?.req.kind).toBe("workflow_approve");
  });

  test("a denied approval ends the run as an error with nothing logged", async () => {
    const { driver, broker, host } = setup();
    void driver.start({ name: "task", by: "user" });
    await flush();
    broker.asks[0]?.answer({ allowed: false, message: "not today" });
    await flush();
    expect(host.entries).toEqual([]);
    expect(last(host.rows)?.state).toBe("error");
    expect(last(host.rows)?.reason).toBe("not approved: not today");
  });
});

describe("single broker + attribution (A1/A2)", () => {
  test("a child's ask reaches the session's ONE requester, tagged with the step id and the start turn", async () => {
    let seen: PermissionResponse | undefined;
    const { driver, broker, host } = setup({
      approved: true,
      children: {
        plan: async (o, c, ask) => {
          // The runner's own requester wrapper hands the step's requester
          // `agent.id` = controls.agentId and `signal` = the child's.
          seen = await ask(
            { tool: "shell", level: "ask", title: "Run", input: {} },
            {
              agent: { type: "general", description: o.description, id: c?.agentId ?? "" },
              ...(c?.signal ? { signal: c.signal } : {}),
            },
          );
          return says("pass")(o, c, ask);
        },
      },
    });
    void driver.start({ name: "task", by: "user", turnId: "t-start" });
    await flush();
    const toolAsk = broker.asks.find((a) => a.req.tool === "shell");
    expect(toolAsk?.options?.agent?.id).toBe("wf-1.plan");
    expect(host.attributed).toContainEqual(["wf-1.plan", "t-start"]);
    expect(last(host.rows)?.steps[0]?.state).toBe("waiting");
    toolAsk?.answer({ allowed: true, scope: "once" });
    await flush();
    expect(seen?.allowed).toBe(true);
    expect(last(host.rows)?.state).toBe("ok");
  });

  test("the approve step is a workflow_approve ask with no lasting answer, and a deny fails the step", async () => {
    const { driver, broker, host } = setup({
      text: YAML("  - id: merge\n    approve: { title: Merge it }\n"),
    });
    void driver.start({ name: "task", by: "user", turnId: "t-1" });
    await flush();
    broker.asks[0]?.answer({ allowed: true }); // the hash
    await flush();
    const merge = broker.asks[1];
    expect(merge?.req.kind).toBe("workflow_approve");
    expect(merge?.req.title).toBe("Merge it");
    expect(merge?.options?.agent?.id).toBe("wf-1.merge");
    // The approve step's ask is attributed to the run's start turn too (A2).
    expect(host.attributed).toContainEqual(["wf-1.merge", "t-1"]);
    expect(host.attributed).toContainEqual(["wf-1", "t-1"]);
    expect(last(host.rows)?.steps[0]?.state).toBe("needs-approval");
    merge?.answer({ allowed: false, message: "tests are red" });
    await flush();
    const row = last(host.rows);
    expect(row?.state).toBe("error");
    expect(row?.steps[0]?.reason).toBe("denied: tests are red");
  });
});

describe("budget.wait (decision 3)", () => {
  test("an ask unanswered past budget.wait is withdrawn and the run stops `timeout`", async () => {
    let withdrawn = false;
    const { driver, broker, host, clock } = setup({
      approved: true,
      children: {
        plan: async (o, c, ask) => {
          const r = await ask(
            { tool: "shell", level: "ask", title: "Run", input: {} },
            { agent: { type: "general", description: "d", id: c?.agentId ?? "" } },
          );
          withdrawn = r.dismissed === true;
          return { report: "cut", toolUses: 0, stopReason: "cancelled" };
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(broker.asks.some((a) => a.req.tool === "shell")).toBe(true);
    clock.advance(59_000);
    await flush();
    expect(driver.current()).toBe("wf-1");
    clock.advance(1_000);
    await flush();
    expect(withdrawn).toBe(true);
    const row = last(host.rows);
    expect(row?.state).toBe("stopped");
    expect(row?.stopReason).toBe("timeout");
    expect(host.entries.at(-1)?.body.stopReason).toBe("timeout");
    expect(host.entries.find((e) => e.type === "workflow_step")?.body.state).toBe("stopped");
  });
});

describe("verdicts", () => {
  // docs/fix/workflow-no-verdict (a): ONE reminder turn, then the honest sentence.
  const SENTENCE = "no verdict — the step ended without calling step_verdict";

  test("a child ending without step_verdict is reminded ONCE, then fails `no verdict`", async () => {
    let runs = 0;
    const { driver, host } = setup({
      approved: true,
      children: {
        plan: async () => {
          runs += 1;
          return { report: "I think it works", toolUses: 0, stopReason: "end_turn" };
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    // A model that did the work and merely forgot the tool gets one more chance.
    expect(runs).toBe(2);
    expect(last(host.rows)?.steps[0]?.reason).toBe(SENTENCE);
    expect(last(host.rows)?.state).toBe("error");
  });

  test("the reminder's verdict ends the step; both runs' tokens land in ONE sum", async () => {
    let runs = 0;
    const prompts: string[] = [];
    const { driver, host } = setup({
      approved: true,
      text: YAML("  - id: plan\n    agent: { prompt_text: plan it }\n"),
      children: {
        plan: async (opts, controls) => {
          runs += 1;
          prompts.push(opts.prompt);
          if (runs === 2) {
            const tool = controls?.extraTools?.find((t) => t.name === "step_verdict");
            await tool?.execute({ verdict: "pass", reason: "late" }, {} as ToolContext);
          }
          controls?.onEvent?.({ kind: "subagent_usage", promptTokens: 10, completionTokens: 5 });
          return {
            report: runs === 1 ? "did the work" : "verdict recorded",
            toolUses: 0,
            stopReason: "end_turn",
          };
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(runs).toBe(2);
    // The reminder says what to do, in words (it shares no history with run 1).
    expect(prompts[1]).toContain("step_verdict");
    expect(last(host.rows)?.steps[0]?.state).toBe("ok");
    expect(last(host.rows)?.steps[0]?.reason).toBe("late");
    expect(last(host.rows)?.tokens).toBe(30);
    // The first run did the work: its report is the one the step keeps.
    expect(host.entries.find((e) => e.type === "workflow_step")?.body.report).toBe("did the work");
  });

  test("a child that hit its token budget is NOT reminded (its last report is tool-free)", async () => {
    let runs = 0;
    const { driver, host } = setup({
      approved: true,
      children: {
        plan: async () => {
          runs += 1;
          return { report: "r", toolUses: 0, stopReason: "max_token_budget" };
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(runs).toBe(1);
    expect(last(host.rows)?.state).toBe("stopped");
    expect(last(host.rows)?.stopReason).toBe("budget");
  });

  test("the reminder gets the step's REMAINING budget, never its full one again", async () => {
    const caps: (number | undefined)[] = [];
    const { driver } = setup({
      approved: true,
      text: YAML("  - id: plan\n    agent: { prompt_text: p, tokens: 100 }\n"),
      children: {
        plan: async (_o, controls) => {
          caps.push(controls?.maxTokens);
          if (caps.length === 1) {
            controls?.onEvent?.({ kind: "subagent_usage", promptTokens: 40, completionTokens: 20 });
            return { report: "nearly", toolUses: 0, stopReason: "end_turn" };
          }
          const tool = controls?.extraTools?.find((t) => t.name === "step_verdict");
          await tool?.execute({ verdict: "pass", reason: "now" }, {} as ToolContext);
          return { report: "done", toolUses: 0, stopReason: "end_turn" };
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(caps).toEqual([100, 40]);
  });

  test("a step whose budget is already spent is not reminded", async () => {
    let runs = 0;
    const { driver, host } = setup({
      approved: true,
      text: YAML("  - id: plan\n    agent: { prompt_text: p, tokens: 10 }\n"),
      children: {
        plan: async (_o, controls) => {
          runs += 1;
          controls?.onEvent?.({ kind: "subagent_usage", promptTokens: 10, completionTokens: 5 });
          return { report: "r", toolUses: 0, stopReason: "end_turn" };
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(runs).toBe(1);
    expect(last(host.rows)?.steps[0]?.state).toBe("error");
    expect(last(host.rows)?.steps[0]?.reason).toBe(SENTENCE);
  });

  // The reminder's cap is the REMAINDER, so its hitting it is an artefact of the
  // plan, not the step's budget: run 1 did NOT hit the cap, so the honest outcome
  // is the step's own `no verdict` (docs/fix/workflow-no-verdict, Review round 1).
  test("a reminder that runs out of the REMAINDER fails `no verdict`, never `budget`", async () => {
    let runs = 0;
    const { driver, host } = setup({
      approved: true,
      text: YAML("  - id: plan\n    agent: { prompt_text: p, tokens: 100 }\n"),
      children: {
        plan: async (_o, controls) => {
          runs += 1;
          controls?.onEvent?.({ kind: "subagent_usage", promptTokens: 40, completionTokens: 20 });
          // Run 1 answers in prose («PASS»); the reminder (cap 40) burns it all.
          return {
            report: runs === 1 ? "PASS" : "PASS again",
            toolUses: 0,
            stopReason: runs === 1 ? "end_turn" : "max_token_budget",
          };
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(runs).toBe(2);
    const row = last(host.rows);
    expect(row?.steps[0]?.state).toBe("error");
    expect(row?.steps[0]?.reason).toBe(SENTENCE);
    // NOT the run-level `budget` stop, which hides the cause and skips the edges.
    expect(row?.state).toBe("error");
    expect(row?.stopReason).toBeUndefined();
  });

  test("that `no verdict` still goes through `retry` (the run is not stopped `budget`)", async () => {
    let runs = 0;
    const { driver, host } = setup({
      approved: true,
      text: YAML("  - id: plan\n    agent: { prompt_text: p, tokens: 100 }\n    retry: 1\n"),
      children: {
        plan: async (_o, controls) => {
          runs += 1;
          controls?.onEvent?.({ kind: "subagent_usage", promptTokens: 40, completionTokens: 20 });
          return {
            report: "PASS",
            toolUses: 0,
            stopReason: runs % 2 === 1 ? "end_turn" : "max_token_budget",
          };
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    // Poll the condition the asserts read; a fixed number of ticks would be a wait.
    for (let i = 0; i < 400 && runs < 4; i++) {
      await flush();
    }
    // Two attempts (the first run + its capped reminder) = the step was retried.
    expect(runs).toBe(4);
    expect(last(host.rows)?.steps[0]?.reason).toBe(SENTENCE);
    expect(last(host.rows)?.steps[0]?.attempt).toBe(1);
  });

  test("a cancelled run is not reminded: its outcome is already decided", async () => {
    let runs = 0;
    let release: (() => void) | undefined;
    const { driver, host } = setup({
      approved: true,
      children: {
        plan: async () => {
          runs += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { report: "cut", toolUses: 0, stopReason: "cancelled" };
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    driver.stop("wf-1");
    release?.();
    await flush();
    expect(runs).toBe(1);
    expect(last(host.rows)?.stopReason).toBe("cancelled");
  });

  test("an invalid verdict is a tool error to the child; the first valid one wins", async () => {
    const results: string[] = [];
    const { driver, host } = setup({
      approved: true,
      children: {
        plan: async (_o, c) => {
          const tool = c?.extraTools?.[0];
          for (const input of [
            { verdict: "maybe", reason: "x" },
            { verdict: "fail", reason: "nope" },
            { verdict: "pass", reason: "yes" },
          ]) {
            const r = await tool?.execute(input, {} as ToolContext);
            results.push(`${r?.isError === true ? "err" : "ok"}`);
          }
          return { report: "r", toolUses: 3, stopReason: "end_turn" };
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(results).toEqual(["err", "ok", "ok"]);
    expect(last(host.rows)?.steps[0]?.state).toBe("error");
    expect(last(host.rows)?.steps[0]?.reason).toBe("nope");
  });

  test("a child that hits its token cap stops the run `budget`; the step's tokens reach the runner", async () => {
    let cap: number | undefined;
    const { driver, host } = setup({
      approved: true,
      text: YAML("  - id: plan\n    agent: { prompt_text: p, tokens: 500 }\n"),
      children: {
        plan: async (_o, c) => {
          cap = c?.maxTokens;
          return { report: "r", toolUses: 0, stopReason: "max_token_budget" };
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(cap).toBe(500);
    expect(last(host.rows)?.state).toBe("stopped");
    expect(last(host.rows)?.stopReason).toBe("budget");
  });
});

describe("lifecycle", () => {
  test("one run per session: a second start is refused naming the running one", async () => {
    const { driver } = setup();
    void driver.start({ name: "task", by: "user" });
    await flush();
    const second = await driver.start({ name: "task", by: "model" });
    expect(second.ok).toBe(false);
    expect(second.ok === false ? second.reason : "").toContain("wf-1");
  });

  test("bad file / unknown input / missing required input refuse before any ask", async () => {
    const { driver, broker, files } = setup();
    expect((await driver.start({ name: "nope", by: "user" })).ok).toBe(false);
    files.text = YAML("  - id: plan\n    agent: { prompt_text: p, model: gpt }\n");
    const bad = await driver.start({ name: "task", by: "user" });
    expect(bad.ok === false ? bad.reason : "").toContain('"gpt"');
    files.text = `schemaVersion: 1\nname: task\nversion: 1\ninputs:\n  slug: { required: true }\nsteps:\n  - id: a\n    agent: { prompt_text: "{{inputs.slug}}" }\n`;
    const missing = await driver.start({ name: "task", by: "user" });
    expect(missing.ok === false ? missing.reason : "").toContain("slug");
    const unknown = await driver.start({
      name: "task",
      by: "user",
      inputs: { slug: "x", other: "y" },
    });
    expect(unknown.ok === false ? unknown.reason : "").toContain("other");
    expect(broker.asks).toEqual([]);
  });

  test("stop cancels the step; the run ends `stopped: cancelled` and logs its end", async () => {
    let signal: AbortSignal | undefined;
    const { driver, host } = setup({
      approved: true,
      children: {
        plan: (_o, c) =>
          new Promise((resolve) => {
            signal = c?.signal;
            c?.signal?.addEventListener("abort", () =>
              resolve({ report: "cut", toolUses: 0, stopReason: "cancelled" }),
            );
          }),
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(driver.stop("wf-1")).toEqual({ ok: true, runId: "wf-1" });
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(last(host.rows)?.stopReason).toBe("cancelled");
    expect(host.entries.at(-1)?.type).toBe("workflow_end");
    expect(host.notes.at(-1)).toContain("[workflow wf-1 task: stopped · cancelled");
  });

  test("stop withdraws an open hash approval at once; the run ends `cancelled`", async () => {
    const { driver, broker, host, clock } = setup();
    void driver.start({ name: "task", by: "user" });
    await flush();
    const ask = broker.asks[0];
    expect(ask?.req.kind).toBe("workflow_approve");
    expect(driver.stop("wf-1")).toEqual({ ok: true, runId: "wf-1" });
    await flush();
    // Withdrawn by the stop itself — not by budget.wait, which never elapsed.
    expect(ask?.options?.signal?.aborted).toBe(true);
    expect(clock.t).toBe(1_000);
    const row = last(host.rows);
    expect(row?.state).toBe("stopped");
    expect(row?.stopReason).toBe("cancelled");
    expect(host.entries).toEqual([]);
  });

  test("stop withdraws an open approve-step ask at once; the run ends `cancelled`", async () => {
    const { driver, broker, host } = setup({
      text: YAML("  - id: merge\n    approve: { title: Merge it }\n"),
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    broker.asks[0]?.answer({ allowed: true, scope: "once" }); // the hash
    await flush();
    const merge = broker.asks.find((a) => a.options?.agent?.id === "wf-1.merge");
    expect(merge?.options?.signal?.aborted).toBe(false);
    driver.stop("wf-1");
    await flush();
    expect(merge?.options?.signal?.aborted).toBe(true);
    expect(last(host.rows)?.stopReason).toBe("cancelled");
    expect(host.entries.at(-1)?.type).toBe("workflow_end");
  });

  test("dispose closes a live run `interrupted`", async () => {
    const { driver, host } = setup({
      approved: true,
      children: {
        plan: (_o, c) =>
          new Promise((resolve) =>
            c?.signal?.addEventListener("abort", () =>
              resolve({ report: "", toolUses: 0, stopReason: "cancelled" }),
            ),
          ),
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    driver.dispose();
    await flush();
    expect(last(host.rows)?.stopReason).toBe("interrupted");
  });

  test("a mid-run edit does not affect the run (snapshot); rerun after it refuses `changed`", async () => {
    let gate: (() => void) | undefined;
    const prompts: string[] = [];
    const { driver, host, files } = setup({
      approved: true,
      children: {
        plan: async (o, c, a) => {
          await new Promise<void>((resolve) => {
            gate = resolve;
          });
          return says("fail", "broken")(o, c, a);
        },
        exec: async (o, c, a) => {
          prompts.push(o.prompt);
          return says("pass")(o, c, a);
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    files.text = files.text.replace("do it", "do something else");
    gate?.();
    await flush();
    expect(last(host.rows)?.state).toBe("error");
    const rerun = await driver.rerun("wf-1", "plan", "t-2");
    expect(rerun.ok).toBe(false);
    expect(rerun.ok === false ? rerun.reason : "").toContain("changed");
    expect(prompts).toEqual([]);
  });

  test("a restarted session never re-mints an id its history names: a crashed 2nd run still gets its note", async () => {
    // Process 1: wf-1 runs to its end; its live end note is in the conversation.
    const first = setup({ approved: true });
    void first.driver.start({ name: "task", by: "user" });
    await flush();
    const endNote = first.host.notes.at(-1) ?? "";
    expect(endNote).toContain("[workflow wf-1 ");
    const messages: ChatMessage[] = [
      { role: "user", content: endNote, note: { kind: NOTE_KIND.workflowEnd, id: "wf-1" } },
    ];
    // Process 2 of the SAME session: seeded from the history, then crashes mid-step.
    const second = setup({
      approved: true,
      children: { plan: () => new Promise<SubagentResult>(() => {}) },
    });
    second.driver.reserveRunIds(workflowRunSeqFromHistory(messages));
    const started = await second.driver.start({ name: "task", by: "user" });
    expect(started).toEqual({ ok: true, runId: "wf-2" });
    await flush();
    const entries = [...first.host.entries, ...second.host.entries].map((e, i) => ({
      ...e.body,
      type: e.type,
      critical: false,
      seq: i + 1,
      id: `D/${i + 1}`,
      ts: 1,
    })) as unknown as Parameters<typeof workflowLoadNotes>[0];
    const notes = workflowLoadNotes(entries, messages);
    expect(notes.map((n) => n.note?.id)).toEqual(["wf-2"]);
  });

  test("a rerun is its own run (new id, own start fact), so a crash during it is still noted", async () => {
    let fails = true;
    const { driver, host } = setup({
      approved: true,
      children: {
        exec: async (o, c, a) =>
          fails ? says("fail", "red")(o, c, a) : new Promise<SubagentResult>(() => {}),
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    fails = false;
    const rerun = await driver.rerun("wf-1", "exec", "t-2");
    expect(rerun).toEqual({ ok: true, runId: "wf-2" });
    await flush();
    expect(
      host.entries.filter((e) => e.type === "workflow_start").map((e) => e.body.runId),
    ).toEqual(["wf-1", "wf-2"]);
    // The crash during the rerun: wf-1's end note does not hide wf-2's open start.
    const entries = host.entries.map((e, i) => ({
      ...e.body,
      type: e.type,
      critical: false,
      seq: i + 1,
      id: `D/${i + 1}`,
      ts: 1,
    })) as unknown as Parameters<typeof workflowLoadNotes>[0];
    const messages: ChatMessage[] = host.notes.map((content) => ({
      role: "user",
      content,
      note: { kind: NOTE_KIND.workflowEnd, id: "wf-1" },
    }));
    expect(workflowLoadNotes(entries, messages).map((n) => n.note?.id)).toEqual(["wf-2"]);
  });

  test("a run a restart cut (unknown to this process) is refused with a clear reason", async () => {
    const { driver } = setup({ approved: true });
    const resumed = await driver.rerun("wf-7", undefined, "t-2");
    expect(resumed.ok).toBe(false);
    expect(resumed.ok === false ? resumed.reason : "").toContain("start a new run");
  });

  test("rerun of an ended run from a step: a new run, attempt +1, the file unchanged", async () => {
    let fails = true;
    const { driver, host } = setup({
      approved: true,
      children: {
        exec: async (o, c, a) => (fails ? says("fail", "red")(o, c, a) : says("pass")(o, c, a)),
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(last(host.rows)?.state).toBe("error");
    fails = false;
    expect(await driver.rerun("wf-1", "exec", "t-2")).toEqual({ ok: true, runId: "wf-2" });
    await flush();
    const row = last(host.rows);
    expect(row?.state).toBe("ok");
    expect(row?.steps[1]?.attempt).toBe(1);
  });
});

describe("run steps (local)", () => {
  test("exit 0 passes; exit 2 fails with the tail; the command is authorised through the step's requester", async () => {
    const authorised: string[] = [];
    const t = setup({
      approved: true,
      text: YAML("  - id: gate\n    run: bun run check\n    on_fail: stop\n"),
    });
    let exit = 2;
    const driver = new WorkflowDriver({
      ...t.deps,
      commands: {
        authorize: async (command, requester, call) => {
          authorised.push(`${command}@${call.toolCallId}`);
          const r = await requester({
            tool: "shell",
            level: "ask",
            title: command,
            input: { command },
          });
          return r.allowed ? { allowed: true, command } : { allowed: false, reason: "denied" };
        },
        exec: async () => ({ stdout: "line1\nline2", stderr: "boom", exitCode: exit }),
      },
    });
    const rows: WorkflowRow[][] = [];
    driver.bind({ ...noopHost(), publish: (r) => rows.push([...r]) });
    t.broker.auto = () => ({ allowed: true, scope: "once" });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(authorised).toEqual(["bun run check@wf-1"]);
    expect(t.broker.asks.find((a) => a.req.tool === "shell")?.options?.agent?.id).toBe("wf-1.gate");
    expect(last(rows)?.steps[0]?.reason).toBe("exit 2\nline1\nline2\nboom");
    exit = 0;
    await driver.rerun("wf-1", "gate");
    await flush();
    expect(last(rows)?.state).toBe("ok");
  });

  test("the APPROVED command runs, never the file's: a gate that rewrites the input is honoured", async () => {
    // `PermissionGate.authorize` lets a `tool_call` hook rewrite the input (and
    // forcefully allow it): the ask then shows the REWRITTEN form, and the agent
    // loop executes `outcome.input`. A run step must run what was approved, or a
    // hook that rewrites `rm -rf /work` into `echo blocked` shows the safe form
    // and runs the dangerous one.
    const ran: string[] = [];
    const t = setup({ approved: true, text: YAML("  - id: gate\n    run: rm -rf /work\n") });
    const driver = new WorkflowDriver({
      ...t.deps,
      commands: {
        authorize: async () => ({ allowed: true, command: "echo blocked" }),
        exec: async (command) => {
          ran.push(command);
          return { stdout: "blocked", stderr: "", exitCode: 0 };
        },
      },
    });
    const rows: WorkflowRow[][] = [];
    driver.bind({ ...noopHost(), publish: (r) => rows.push([...r]) });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(ran).toEqual(["echo blocked"]);
    expect(last(rows)?.steps[0]?.state).toBe("ok");
  });

  test("a docker step with no workload seam is refused, never run on the laptop", async () => {
    // The laptop must never stand in for a container: without `execOn` the step
    // fails saying what is missing (`commands.exec` is present and would succeed).
    const t = setup({
      approved: true,
      text: YAML("  - id: gate\n    run: make\n    where: { docker: ci }\n"),
    });
    const driver = new WorkflowDriver({
      ...t.deps,
      commands: {
        authorize: async (command) => ({ allowed: true, command }),
        exec: async () => ({ stdout: "laptop", stderr: "", exitCode: 0 }),
      },
    });
    const rows: WorkflowRow[][] = [];
    driver.bind({ ...noopHost(), publish: (r) => rows.push([...r]) });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(last(rows)?.steps[0]?.reason).toContain("no workload seam");
  });
});

describe("run steps in a container (Slice 5)", () => {
  /** A driver whose `execOn` records the target and answers with `outcome`. */
  function containerRun(text: string) {
    const calls: {
      target: { engine: string; name: string; container?: string };
      command: string;
      timeoutMs: number;
    }[] = [];
    const asks: string[] = [];
    const setupKey = setup({ approved: true, text });
    const driver = new WorkflowDriver({
      ...setupKey.deps,
      commands: {
        authorize: async (command, _requester, call) => {
          // The ask names WHERE as well as WHAT: the driver hands the seam the
          // step's own target, so the gate can key a rule per workload.
          asks.push(`${String(call.target?.engine)} ${String(call.target?.name)}: ${command}`);
          return {
            allowed: true,
            command,
            ...(call.target !== undefined ? { target: call.target } : {}),
          };
        },
        exec: async () => ({ stdout: "laptop", stderr: "", exitCode: 0 }),
        execOn: async (target, command, options) => {
          calls.push({ target, command, timeoutMs: options.timeoutMs });
          return outcome();
        },
      },
    });
    let outcome = (): { exitCode: number; output: string; notes?: readonly string[] } => ({
      exitCode: 0,
      output: "built",
    });
    const rows: WorkflowRow[][] = [];
    driver.bind({ ...noopHost(), publish: (r) => rows.push([...r]) });
    const set = (next: typeof outcome): void => {
      outcome = next;
    };
    return { driver, calls, asks, rows, set };
  }

  test("exit 0 passes; exit 2 fails with the tail; the ask names the container", async () => {
    const t = containerRun(
      YAML("  - id: gate\n    run: make test\n    where: { docker: devbox }\n"),
    );
    t.set(() => ({ exitCode: 0, output: "ok\n" }));
    void t.driver.start({ name: "task", by: "user" });
    await flush();
    expect(t.asks).toEqual(["docker devbox: make test"]);
    expect(t.calls[0]?.target).toEqual({ engine: "docker", name: "devbox" });
    // The step's own timeout is the one the seam gets (never a default).
    expect(t.calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(last(t.rows)?.steps[0]?.state).toBe("ok");
    expect(last(t.rows)?.steps[0]?.reason).toBe("exit 0");

    t.set(() => ({ exitCode: 2, output: "noise\ncompile error: x\n" }));
    const row = last(t.rows);
    expect(row?.runId).toBeDefined();
    await t.driver.rerun(String(row?.runId), "gate");
    await flush();
    expect(last(t.rows)?.steps[0]?.state).toBe("error");
    // The FAILING tail is what the person reads — not the exit code alone.
    expect(last(t.rows)?.steps[0]?.reason).toContain("exit 2");
    expect(last(t.rows)?.steps[0]?.reason).toContain("compile error: x");
    // ...and never the laptop's own answer for the same command.
    expect(last(t.rows)?.steps[0]?.reason).not.toContain("laptop");
  });

  test("a killed command (the seam's note) fails the step even on exit 0", async () => {
    // `WorkloadShells` reports a kill as a NOTE with the ladder's own exit code;
    // a notice means the command did not simply run, so a note can never pass.
    const t = containerRun(
      YAML("  - id: gate\n    run: sleep 900\n    where: { docker: devbox }\n    timeout: 1s\n"),
    );
    t.set(() => ({
      exitCode: 0,
      output: "partial",
      notes: [
        "[killed after 1s: the command's processes were stopped; the shell (cwd/env) survived]",
      ],
    }));
    void t.driver.start({ name: "task", by: "user" });
    await flush();
    expect(t.calls[0]?.timeoutMs).toBe(1_000);
    expect(last(t.rows)?.steps[0]?.state).toBe("error");
    expect(last(t.rows)?.steps[0]?.reason).toContain("killed after 1s");
  });

  test("the approved TARGET is where it runs: a rewrite retargets the workload", async () => {
    // The same hole as the command, on the other axis: the ask names the workload
    // the exec will go to, so the approved target must be the one dialled.
    const calls: { target: WorkflowContainerTarget; command: string }[] = [];
    const t = setup({
      approved: true,
      text: YAML("  - id: gate\n    run: make\n    where: { docker: devbox }\n"),
    });
    const driver = new WorkflowDriver({
      ...t.deps,
      commands: {
        authorize: async (command) => ({
          allowed: true,
          command,
          target: { engine: "docker", name: "other" },
        }),
        exec: async () => ({ stdout: "laptop", stderr: "", exitCode: 0 }),
        execOn: async (target, command) => {
          calls.push({ target, command });
          return { exitCode: 0, output: "ok" };
        },
      },
    });
    const rows: WorkflowRow[][] = [];
    driver.bind({ ...noopHost(), publish: (r) => rows.push([...r]) });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(calls[0]?.target).toEqual({ engine: "docker", name: "other" });
    expect(last(rows)?.steps[0]?.state).toBe("ok");
  });

  test("a seam that throws fails the step with its own sentence", async () => {
    const t = containerRun(YAML("  - id: gate\n    run: make\n    where: { docker: gone }\n"));
    t.set(() => {
      throw new Error("docker daemon unreachable");
    });
    void t.driver.start({ name: "task", by: "user" });
    await flush();
    expect(last(t.rows)?.steps[0]?.state).toBe("error");
    expect(last(t.rows)?.steps[0]?.reason).toContain("docker daemon unreachable");
  });
});

describe("the sub-agent cap", () => {
  test("a full cap waits (`waiting · slot`), never errors, and runs when a slot frees", async () => {
    const t = setup({ approved: true });
    let free = false;
    const driver = new WorkflowDriver({
      ...t.deps,
      slots: {
        acquire: () => (free ? { ok: true, release: () => {} } : { ok: false, reason: "full" }),
      },
      slotRetryMs: 1_000,
    });
    const rows: WorkflowRow[][] = [];
    driver.bind({ ...noopHost(), publish: (r) => rows.push([...r]) });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(last(rows)?.steps[0]?.state).toBe("waiting");
    expect(last(rows)?.steps[0]?.live).toBe("slot");
    free = true;
    t.clock.advance(1_000);
    await flush();
    expect(last(rows)?.state).toBe("ok");
  });
});

// Slice 10 — a scheduled start: deterministic, never asks, no run on refusal.
describe("startScheduled (slice 10)", () => {
  const WAKE = "wake-0b6e";
  async function pinned(t: ReturnType<typeof setup>): Promise<string> {
    const seen = await t.driver.inspect("task", {});
    if (!seen.ok) throw new Error(seen.reason);
    return seen.hash;
  }
  const sched = (hash: string, name = "task") => ({
    name,
    inputs: {},
    pinnedHash: hash,
    scheduleId: "sc-3",
    turnId: WAKE,
  });

  test("an approved, unchanged file starts a run: by schedule, scheduleId, asks on the wake- turn", async () => {
    const t = setup({
      children: {
        plan: async (o, c, ask) => {
          await ask(
            { tool: "shell", level: "ask", title: "Run", input: {} },
            { agent: { type: "general", description: o.description, id: c?.agentId ?? "" } },
          );
          return says("pass")(o, c, ask);
        },
      },
    });
    const hash = await pinned(t);
    t.approvals.add(`.tentacle/workflows/task.yaml#${hash}`);
    const started = await t.driver.startScheduled(sched(hash));
    expect(started).toEqual({ ok: true, runId: "wf-1" });
    await flush();
    expect(t.broker.asks.map((a) => a.req.kind ?? a.req.tool)).toEqual(["shell"]);
    expect(t.host.attributed).toContainEqual(["wf-1.plan", WAKE]);
    const start = t.host.entries.find((e) => e.type === "workflow_start");
    expect(start?.body.by).toBe("schedule");
    expect(start?.body.scheduleId).toBe("sc-3");
    expect(start?.body.turnId).toBe(WAKE);
  });

  test("unapproved → `unapproved`, NO ask, no run row", async () => {
    const t = setup();
    const hash = await pinned(t);
    const result = await t.driver.startScheduled(sched(hash));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome).toBe("unapproved");
    await flush();
    expect(t.broker.asks).toHaveLength(0);
    expect(t.host.rows).toEqual([]);
    expect(t.driver.current()).toBeUndefined();
  });

  test("the file changed since the pin → `changed` naming both hashes, no ask, no run row", async () => {
    const t = setup();
    const old = await pinned(t);
    t.approvals.add(`.tentacle/workflows/task.yaml#${old}`);
    t.files.text = t.files.text.replace("do it", "do it!");
    // the NEW content is approved too: the pin, not the store, is what decides
    const fresh = await pinned(t);
    t.approvals.add(`.tentacle/workflows/task.yaml#${fresh}`);
    const result = await t.driver.startScheduled(sched(old));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("changed");
      expect(result.reason).toContain("re-create the schedule");
    }
    await flush();
    expect(t.broker.asks).toHaveLength(0);
    expect(t.host.rows).toEqual([]);
  });

  test("a missing / invalid file or a missing input → `invalid`, no ask", async () => {
    const t = setup();
    const gone = await t.driver.startScheduled(sched("abc", "nope"));
    expect(gone.ok ? "" : gone.outcome).toBe("invalid");
    t.files.text = "schemaVersion: 1\nname: task\n";
    const broken = await t.driver.startScheduled(sched("abc"));
    expect(broken.ok ? "" : broken.outcome).toBe("invalid");
    t.files.text = YAML("  - id: a\n    agent: { prompt_text: hi }\n").replace(
      "steps:",
      "inputs:\n  slug: { required: true }\nsteps:",
    );
    const hash = await t.driver.inspect("task", { slug: "x" });
    const noInput = await t.driver.startScheduled(sched(hash.ok ? hash.hash : "abc"));
    expect(noInput.ok ? "" : noInput.outcome).toBe("invalid");
    if (!noInput.ok) expect(noInput.reason).toContain("slug");
    await flush();
    expect(t.broker.asks).toHaveLength(0);
  });

  test("a run in flight → `skipped`; the first run is untouched", async () => {
    const t = setup({ text: YAML("  - id: merge\n    approve: { title: Merge it }\n") });
    const hash = await pinned(t);
    t.approvals.add(`.tentacle/workflows/task.yaml#${hash}`);
    expect((await t.driver.startScheduled(sched(hash))).ok).toBe(true);
    await flush();
    const asksBefore = t.broker.asks.length;
    const second = await t.driver.startScheduled(sched(hash));
    expect(second.ok ? "" : second.outcome).toBe("skipped");
    if (!second.ok) expect(second.reason).toBe("wf-1 running");
    await flush();
    expect(t.driver.current()).toBe("wf-1");
    expect(t.broker.asks).toHaveLength(asksBefore);
    expect(last(t.host.rows)?.state).toBe("needs-approval"); // its approve step still waits
  });

  test("requestApproval asks once through the ONE requester and writes the store on allow", async () => {
    const t = setup();
    const pending = t.driver.requestApproval("task", "t-9");
    await flush();
    expect(t.broker.asks).toHaveLength(1);
    expect(t.broker.asks[0]?.req.kind).toBe("workflow_approve");
    expect(t.broker.asks[0]?.options?.agent?.id).toBe("approval:task");
    expect(t.host.attributed).toContainEqual(["approval:task", "t-9"]);
    t.broker.asks[0]?.answer({ allowed: true, scope: "once" });
    expect(await pending).toBe(true);
    const seen = await t.driver.inspect("task", {});
    expect(seen.ok && seen.approved).toBe(true);
    // already approved: no second ask
    expect(await t.driver.requestApproval("task")).toBe(true);
    expect(t.broker.asks).toHaveLength(1);
  });

  test("requestApproval is withdrawn after budget.wait and approves nothing", async () => {
    const t = setup();
    const pending = t.driver.requestApproval("task");
    await flush();
    t.clock.advance(60_000);
    expect(await pending).toBe(false);
    const seen = await t.driver.inspect("task", {});
    expect(seen.ok && seen.approved).toBe(false);
  });
});

describe("the approval shows every command, verbatim (docs/fix/workflow-approve-detail.md)", () => {
  /** `n` run steps, each command `len` chars, the last one carrying `LAST-COMMAND`. */
  const longWorkflow = (n: number, len: number, last = "echo LAST-COMMAND"): string =>
    YAML(
      Array.from({ length: n }, (_, i) => {
        const command = i === n - 1 ? last : `echo ${"x".repeat(len)}`;
        return `  - id: step-${i + 1}\n    run: ${command}\n`;
      }).join(""),
    );

  test("the hash ask carries the WHOLE list, past 2000 chars, with no trailing …", async () => {
    // Mutation: `detail: capWorkflowText(summary, 2000)` → the last command is gone.
    const { driver, broker } = setup({ text: longWorkflow(12, 200) });
    void driver.start({ name: "task", by: "user" });
    await flush();
    const detail = broker.asks[0]?.req.detail ?? "";
    expect(detail.length).toBeGreaterThan(2000);
    expect(detail).toContain("echo LAST-COMMAND");
    expect(detail.endsWith("…")).toBe(false);
  });

  test("requestApproval's ask carries the same whole list", async () => {
    // Mutation: the same cap on the schedule path → red here too.
    const { driver, broker } = setup({ text: longWorkflow(12, 200) });
    void driver.requestApproval("task");
    await flush();
    const detail = broker.asks[0]?.req.detail ?? "";
    expect(detail.length).toBeGreaterThan(2000);
    expect(detail).toContain("echo LAST-COMMAND");
    expect(detail.endsWith("…")).toBe(false);
  });

  test("an approve step's detail of exactly 2000 chars arrives byte-identical", async () => {
    // Mutation: `capWorkflowText(step.detail, 2000)` never fires on 2000 — the
    // property is that the ask carries the STEP's text, unmodified.
    const detail = `D${"y".repeat(1999)}`;
    const text = YAML(`  - id: gate\n    approve: { title: "Merge it", detail: "${detail}" }\n`);
    const { driver, broker } = setup({ text, approved: true });
    void driver.start({ name: "task", by: "user" });
    await flush();
    const ask = broker.asks.find((a) => a.req.title.includes("Merge it"));
    expect(ask?.req.detail).toBe(detail);
  });
});

// docs/fix/mobile-ask-surfaces.md S1b: the ask says WHERE it comes from, as
// structure (name, run, step, N of M) instead of leaving every surface to parse
// `agent.description`/`id`. Only the driver knows the step's position.
describe("the ask's structured workflow origin (S1b)", () => {
  const askShell = async (
    o: SubagentRunOptions,
    c: SubagentRunControls | undefined,
    ask: PermissionRequester,
  ): Promise<PermissionResponse> =>
    ask(
      { tool: "shell", level: "ask", title: "Run", input: {} },
      { agent: { type: "explore", description: o.description, id: c?.agentId ?? "" } },
    );

  test("an agent step's ask carries name, run, step, index and count — and keeps the child's own agent label", async () => {
    // Mutation: drop the `workflow` from `stepRequester`'s options → absent here.
    const { driver, broker } = setup({
      approved: true,
      children: {
        exec: async (o, c, ask) => {
          await askShell(o, c, ask);
          return says("pass")(o, c, ask);
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    const shell = broker.asks.find((a) => a.req.tool === "shell");
    expect(shell?.options?.workflow).toEqual({
      name: "task",
      runId: "wf-1",
      stepId: "exec",
      index: 1,
      count: 2,
    });
    // The transition's fallback: the child's `agent` survives beside the origin.
    expect(shell?.options?.agent).toEqual({
      type: "explore",
      description: "task/exec",
      id: "wf-1.exec",
    });
    shell?.answer({ allowed: true, scope: "once" });
    await flush();
  });

  test("the origin OVERRIDES a workflow the child tried to set: a step cannot claim another's", async () => {
    // Mutation: `workflow: options?.workflow ?? workflow` → the forged one wins.
    const { driver, broker } = setup({
      approved: true,
      children: {
        exec: async (o, c, ask) => {
          await ask(
            { tool: "shell", level: "ask", title: "Run", input: {} },
            {
              agent: { type: "general", description: "d", id: c?.agentId ?? "" },
              workflow: { name: "other", runId: "wf-9", stepId: "x", index: 0, count: 9 },
            },
          );
          return says("pass")(o, c, ask);
        },
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    const shell = broker.asks.find((a) => a.req.tool === "shell");
    expect(shell?.options?.workflow).toEqual({
      name: "task",
      runId: "wf-1",
      stepId: "exec",
      index: 1,
      count: 2,
    });
    shell?.answer({ allowed: true, scope: "once" });
    await flush();
  });

  test("a run step's ask says the same, and a later step says its own N", async () => {
    // Mutation: `index: 0` instead of the step's position → both asks say `1 of 2`.
    const t = setup({
      approved: true,
      text: YAML("  - id: gate\n    run: bun run lint\n  - id: after\n    run: bun run build\n"),
    });
    const driver = new WorkflowDriver({
      ...t.deps,
      commands: {
        authorize: async (command, requester) => {
          const r = await requester({ tool: "shell", level: "ask", title: command, input: {} });
          return r.allowed ? { allowed: true, command } : { allowed: false, reason: "denied" };
        },
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
    });
    driver.bind(noopHost());
    t.broker.auto = () => ({ allowed: true, scope: "once" });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(
      t.broker.asks.filter((a) => a.req.tool === "shell").map((a) => a.options?.workflow),
    ).toEqual([
      { name: "task", runId: "wf-1", stepId: "gate", index: 0, count: 2 },
      { name: "task", runId: "wf-1", stepId: "after", index: 1, count: 2 },
    ]);
  });

  test("an approve step's ask carries its own step and position", async () => {
    const { driver, broker } = setup({
      approved: true,
      text: YAML("  - id: merge\n    approve: { title: Merge it }\n"),
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    const merge = broker.asks.find(
      (a) => a.req.kind === "workflow_approve" && a.req.title === "Merge it",
    );
    expect(merge?.options?.workflow).toEqual({
      name: "task",
      runId: "wf-1",
      stepId: "merge",
      index: 0,
      count: 1,
    });
    merge?.answer({ allowed: true });
    await flush();
  });

  test("the run's HASH approval carries the run, no step and no position", async () => {
    // Mutation: give the hash approval a `stepId` (e.g. the first step) → red.
    const { driver, broker } = setup();
    void driver.start({ name: "task", by: "user" });
    await flush();
    const hash = broker.asks[0];
    expect(hash?.req.kind).toBe("workflow_approve");
    expect(hash?.options?.workflow).toEqual({ name: "task", runId: "wf-1" });
    hash?.answer({ allowed: true });
    await flush();
  });

  test("a SCHEDULE's approval carries the name only: it has no run", async () => {
    // Mutation: give it the run id of the last run → a label for a run that is not it.
    const t = setup();
    const pending = t.driver.requestApproval("task");
    await flush();
    expect(t.broker.asks[0]?.options?.workflow).toEqual({ name: "task" });
    t.broker.asks[0]?.answer({ allowed: true });
    expect(await pending).toBe(true);
  });
});

// docs/fix/workflows-ux.md S4 (D1): the run row carries its definition edges
// and a history, so a client never has to re-derive the graph from counters.
describe("rows carry the run's edges and history (S4)", () => {
  // The demo-note shape the plan names: a review that may fail into `fix`, and
  // `fix` jumping back to `review`. Run ① passes review first time.
  const DEMO = YAML(
    [
      "  - id: collect",
      "    agent: { prompt_text: collect it }",
      "  - id: draft",
      "    agent: { prompt_text: draft it }",
      "    retry: 1",
      "  - id: review",
      "    agent: { prompt_text: review it }",
      '    next: "confirm"',
      '    on_fail: { goto: "fix", max: 2 }',
      "  - id: fix",
      "    agent: { prompt_text: fix it }",
      '    next: "review"',
      "  - id: confirm",
      "    approve: { title: Confirm }",
      "",
    ].join("\n"),
  );
  const runRows = (text = DEMO) => {
    const t = setup({ approved: true, text });
    const rows: WorkflowRow[][] = [];
    t.driver.bind({ ...noopHost(), publish: (r) => rows.push([...r]) });
    return { ...t, rows };
  };
  // `flush()` is 20 microtask ticks — enough for a 2-step run; the demo shape is
  // longer, so settle by polling the very condition the asserts read (the last
  // row ended), and THROW if it never does (AGENTS §9: no fixed wait).
  const settle = async (rows: WorkflowRow[][]): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (last(rows)?.endedAt !== undefined) {
        return;
      }
      await flush();
    }
    throw new Error(`run never ended: ${JSON.stringify(last(rows)?.steps.map((s) => s.state))}`);
  };
  const stepOf = (row: WorkflowRow | undefined, id: string) => row?.steps.find((s) => s.id === id);

  test("every step carries its edges from the RUN's spec: `next`, `onFail`, `retry`", async () => {
    const t = runRows();
    void t.driver.start({ name: "task", by: "user" });
    await settle(t.rows);
    const row = last(t.rows);
    // `next` is the RESOLVED pass target: `next`, else the step after it.
    expect(stepOf(row, "collect")?.next).toBe("draft");
    expect(stepOf(row, "draft")?.next).toBe("review");
    expect(stepOf(row, "draft")?.retry).toBe(1);
    // `fix` declares `next: review`, so the spine goes back.
    expect(stepOf(row, "fix")?.next).toBe("review");
    // The last file step: the run ends after it.
    expect(stepOf(row, "confirm")?.next).toBeNull();
    expect(stepOf(row, "review")?.onFail).toEqual({ goto: "fix", max: 2, taken: 0 });
    expect(stepOf(row, "collect")?.onFail).toBeNull();
  });

  test("review passes first time: `taken` stays 0 and `fix` is never in the history", async () => {
    // Mutation: append the finished execution from the ACTION (the next step)
    // instead of the one that ended → `fix` appears, or `review` does not.
    const t = runRows();
    void t.driver.start({ name: "task", by: "user" });
    await settle(t.rows);
    const row = last(t.rows);
    expect(stepOf(row, "review")?.onFail).toEqual({ goto: "fix", max: 2, taken: 0 });
    expect(row?.history.map((h) => h.step)).toEqual(["collect", "draft", "review", "confirm"]);
    expect(row?.history.some((h) => h.step === "fix")).toBe(false);
    expect(row?.historyDropped).toBe(0);
    // A history entry records the state it ENDED in, and is not the live step.
    expect(row?.history.every((h) => h.state === "ok")).toBe(true);
    expect(row?.history[2]).toMatchObject({ step: "review", attempt: 0, round: 0, state: "ok" });
  });

  test("review fails once: `taken` becomes 1 and the history is review→fix→review", async () => {
    const fails = [true];
    const t = runRows();
    const driver = new WorkflowDriver({
      ...t.deps,
      runnerFor: (requester) => (opts, controls) => {
        const id = opts.description.split("/")[1] ?? "";
        if (id === "review" && fails.shift() === true) {
          return says("fail", "red")(opts, controls, requester);
        }
        return says("pass")(opts, controls, requester);
      },
    });
    const rows: WorkflowRow[][] = [];
    driver.bind({ ...noopHost(), publish: (r) => rows.push([...r]) });
    void driver.start({ name: "task", by: "user" });
    await settle(rows);
    const row = last(rows);
    expect(stepOf(row, "review")?.onFail).toEqual({ goto: "fix", max: 2, taken: 1 });
    // While `fix` runs, the row ALREADY says the goto was taken once: the counter
    // is read after `nextAction` moved it (the final row alone cannot tell,
    // review's second pass would refresh it anyway).
    const duringFix = rows.map((r) => r.at(-1)).find((r) => stepOf(r, "fix")?.state === "running");
    expect(stepOf(duringFix, "review")?.onFail?.taken).toBe(1);
    expect(duringFix?.history.map((h) => h.step)).toEqual(["collect", "draft", "review"]);
    // `round` is the machine's own: the goto TARGET's re-entry is round 1; the
    // `next` back into review is a pass edge (round 0).
    expect(row?.history.map((h) => `${h.step}:${h.state}:${h.round}`)).toEqual([
      "collect:ok:0",
      "draft:ok:0",
      "review:error:0",
      "fix:ok:1",
      "review:ok:0",
      "confirm:ok:0",
    ]);
    expect(row?.state).toBe("ok");
  });

  test("a retried step is one history entry per try, attempt 0 then 1", async () => {
    const tries = [true];
    const t = runRows();
    const driver = new WorkflowDriver({
      ...t.deps,
      runnerFor: (requester) => (opts, controls) => {
        const id = opts.description.split("/")[1] ?? "";
        if (id === "draft" && tries.shift() === true) {
          return says("fail", "red")(opts, controls, requester);
        }
        return says("pass")(opts, controls, requester);
      },
    });
    const rows: WorkflowRow[][] = [];
    driver.bind({ ...noopHost(), publish: (r) => rows.push([...r]) });
    void driver.start({ name: "task", by: "user" });
    await settle(rows);
    const draft = last(rows)?.history.filter((h) => h.step === "draft") ?? [];
    expect(draft.map((h) => `${h.attempt}:${h.state}`)).toEqual(["0:error", "1:ok"]);
    expect(last(rows)?.state).toBe("ok");
  });

  test("past 64 executions the history keeps the LATEST 64 and counts the dropped", async () => {
    // A file holds ≤ 64 steps, so executions pile up through retries: 12 steps
    // × 6 tries (`retry: 5`, the first 5 fail) = 72 executions. The
    // `max_step_runs` belt (default 50) is raised: the cap under test is the row's.
    const steps = 12;
    const total = steps * 6;
    const longText = `schemaVersion: 1\nname: task\nversion: 3\nbudget: { wait: 1m, max_step_runs: 100 }\nsteps:\n${Array.from(
      { length: steps },
      (_, i) => `  - id: s${i}\n    run: c${i}\n    retry: 5\n`,
    ).join("")}`;
    const t2 = setup({ approved: true, text: longText });
    const rows2: WorkflowRow[][] = [];
    const calls = new Map<string, number>();
    const driver2 = new WorkflowDriver({
      ...t2.deps,
      commands: {
        authorize: async (command) => ({ allowed: true, command }),
        exec: async (command: string) => {
          const n = (calls.get(command) ?? 0) + 1;
          calls.set(command, n);
          return { stdout: "", stderr: "", exitCode: n <= 5 ? 1 : 0 };
        },
      },
    });
    driver2.bind({ ...noopHost(), publish: (r) => rows2.push([...r]) });
    void driver2.start({ name: "task", by: "user" });
    await settle(rows2);
    const longRow = last(rows2);
    expect(longRow?.state).toBe("ok");
    expect(longRow?.history).toHaveLength(64);
    expect(longRow?.historyDropped).toBe(total - 64);
    // The LATEST 64 are kept: s0 and two tries of s1 fell off; the last is s11's pass.
    expect(longRow?.history.at(0)).toMatchObject({ step: "s1", attempt: 2 });
    expect(longRow?.history.at(-1)).toMatchObject({ step: "s11", attempt: 5, state: "ok" });
  });
});

function noopHost(): WorkflowHost {
  return {
    logStart: () => {},
    logStep: () => {},
    logEnd: () => {},
    attribute: () => {},
    release: () => {},
    publish: () => {},
    ended: () => {},
  };
}
