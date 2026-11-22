import { describe, expect, test } from "bun:test";
import type {
  PermissionRequest,
  PermissionRequestOptions,
  PermissionRequester,
  PermissionResponse,
  ToolContext,
} from "@tentacle/core";
import type {
  SubagentResult,
  SubagentRunControls,
  SubagentRunOptions,
  SubagentRunner,
} from "../src/subagent.ts";
import {
  type WorkflowClock,
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
      return { path: "workflows/task.yaml", text: files.text, prompts: files.prompts };
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
  test("a child ending without step_verdict fails `no verdict`", async () => {
    const { driver, host } = setup({
      approved: true,
      children: {
        plan: async () => ({ report: "I think it works", toolUses: 0, stopReason: "end_turn" }),
      },
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(last(host.rows)?.steps[0]?.reason).toBe("no verdict");
    expect(last(host.rows)?.state).toBe("error");
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

  test("rerun of an ended run from a step: same run id, attempt +1, the file unchanged", async () => {
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
    expect(await driver.rerun("wf-1", "exec", "t-2")).toEqual({ ok: true, runId: "wf-1" });
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
          return r.allowed ? { allowed: true } : { allowed: false, reason: "denied" };
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

  test("a docker `where` is refused honestly in this build (Slice 5)", async () => {
    const { driver, host } = setup({
      approved: true,
      text: YAML("  - id: gate\n    run: make\n    where: { docker: ci }\n"),
    });
    void driver.start({ name: "task", by: "user" });
    await flush();
    expect(last(host.rows)?.steps[0]?.reason).toContain("not available yet");
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
