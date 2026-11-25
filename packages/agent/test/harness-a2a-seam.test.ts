/**
 * docs/feat/a2a-client.md slice a2c-3 (C3/C4/C6/C7): the seam a remote agent
 * runs through. Consent (Owner A10) reaches the ONE broker, attributed, BEFORE
 * anything starts; what leaves is redacted and hook-approved; a reply passes the
 * same gate; the `parent` route sends the RAW reply; a stop never waits a
 * reconnect backoff. The remote is a scripted adapter (a2c-2's `fake-a2a.ts`
 * does not exist yet — see the task doc's Execution).
 */
import { describe, expect, test } from "bun:test";
import {
  AgentInbox,
  type ExecutionEnvironment,
  type ModelProvider,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionRequester,
  type PermissionResponse,
  SubagentFailure,
  autoApproves,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import type { HarnessDeps } from "../src/harness/child.ts";
import type {
  HarnessAdapter,
  HarnessDecision,
  HarnessEvent,
  HarnessRun,
  HarnessRunSpec,
} from "../src/harness/types.ts";
import { HookRunner } from "../src/hooks.ts";
import { SessionGrants } from "../src/session-grants.ts";
import { type AgentType, createSubagentRunner } from "../src/subagent.ts";

interface Ask {
  readonly req: PermissionRequest;
  readonly options: PermissionRequestOptions | undefined;
  answer(r: PermissionResponse): void;
}

/** The session's ONE requester: records every ask; `auto` answers like auto-accept ON. */
class SpyBroker {
  readonly asks: Ask[] = [];
  constructor(private readonly auto = false) {}
  readonly request: PermissionRequester = (req, options) =>
    new Promise<PermissionResponse>((resolve) => {
      this.asks.push({ req, options, answer: resolve });
      if (this.auto && autoApproves(req)) {
        resolve({ allowed: true, auto: true });
        return;
      }
      options?.signal?.addEventListener(
        "abort",
        () => resolve({ allowed: false, dismissed: true }),
        { once: true },
      );
    });
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 2));
  }
}

const CAPS = {
  permissionAsks: false,
  inputRequired: true,
  steer: false,
  usage: false,
  cost: false,
  quota: false,
  structuredResult: false,
  workspace: "none",
} as const;

/** A run that plays `script`, then waits; records answers. */
class ScriptRun implements HarnessRun {
  readonly answers: { askId: string; decision: HarnessDecision }[] = [];
  private queue: HarnessEvent[];
  private waiter: ((r: IteratorResult<HarnessEvent>) => void) | undefined;
  constructor(script: HarnessEvent[]) {
    this.queue = [...script];
  }
  push(e: HarnessEvent): void {
    const w = this.waiter;
    this.waiter = undefined;
    if (w) w({ done: false, value: e });
    else this.queue.push(e);
  }
  readonly events: AsyncIterable<HarnessEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<HarnessEvent>> => {
        const e = this.queue.shift();
        if (e) return Promise.resolve({ done: false, value: e });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    }),
  };
  async answer(askId: string, decision: HarnessDecision): Promise<void> {
    this.answers.push({ askId, decision });
    if (decision.allow) {
      this.push({ kind: "end", status: "completed", text: `got ${String(decision.input)}` });
    }
  }
  async send(): Promise<void> {}
  async cancel(): Promise<"confirmed" | "unconfirmed"> {
    return "unconfirmed";
  }
}

const DONE: HarnessEvent[] = [{ kind: "end", status: "completed", text: "done" }];

function remote(
  id: string,
  script: () => HarnessEvent[] = () => DONE,
  reattach?: () => Promise<HarnessRun>,
): HarnessAdapter & { specs: HarnessRunSpec[]; runs: ScriptRun[] } {
  const a = {
    id,
    kind: "remote" as const,
    caps: CAPS,
    specs: [] as HarnessRunSpec[],
    runs: [] as ScriptRun[],
    probe: async () => ({ ok: true }),
    start: async (spec: HarnessRunSpec) => {
      a.specs.push(spec);
      const run = new ScriptRun(script());
      a.runs.push(run);
      return run;
    },
    ...(reattach ? { reattach } : {}),
  };
  return a;
}

const typeFor = (id: string): AgentType => ({
  name: id,
  description: "a remote agent",
  prompt: "",
  tools: [],
  harness: { adapter: id, mode: "remote" },
});

function hookRunner(stdout: unknown): HookRunner {
  const env = {
    exec: async () => ({ stdout: JSON.stringify(stdout), stderr: "", exitCode: 0 }),
  } as unknown as ExecutionEnvironment;
  return new HookRunner({ specs: [{ event: "tool_call", command: "guard" }], env, cwd: "/w" });
}

function runner(
  adapters: HarnessAdapter[],
  broker: SpyBroker | undefined,
  extra: Partial<HarnessDeps> & {
    inputFrom?: "parent" | "user" | "both";
    hooks?: HookRunner;
    grants?: SessionGrants;
    backoffMs?: number;
  } = {},
) {
  const harness: HarnessDeps = {
    instances: new Map(
      adapters.map((adapter) => [
        adapter.id,
        {
          adapter,
          idleMinutes: 1,
          origin: "https://agents.acme.dev",
          ...(extra.inputFrom ? { inputFrom: extra.inputFrom } : {}),
        },
      ]),
    ),
    cwd: "/nowhere",
    reattach: { attempts: 3, backoffMs: extra.backoffMs ?? 0 },
    ...(extra.notify ? { notify: extra.notify } : {}),
  };
  const hooks = extra.hooks;
  return createSubagentRunner({
    model: {} as ModelProvider,
    env: {} as never,
    tools: new ToolRegistry(),
    types: adapters.map((a) => typeFor(a.id)),
    harness,
    ...(broker ? { requestPermission: broker.request } : {}),
    ...(hooks ? { hooks: { forAgent: () => hooks } as never } : {}),
    ...(extra.grants ? { grants: extra.grants } : {}),
  });
}

const opts = (type: string, prompt = "review PR 12") => ({
  description: "remote review",
  prompt,
  type,
});

async function failureOf(p: Promise<unknown>): Promise<SubagentFailure> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SubagentFailure) return err;
    throw err;
  }
  throw new Error("expected a SubagentFailure");
}

describe("C3 consent: the ONE broker, before anything leaves (Owner A10)", () => {
  test("the ask reaches the broker attributed to the call, and nothing starts until it is answered", async () => {
    const broker = new SpyBroker();
    const acme = remote("a2a:acme");
    const p = runner([acme], broker).run(opts("a2a:acme"), { toolCallId: "call-9" });
    await until(() => broker.asks.length === 1);
    const ask = broker.asks[0];
    // Nothing on the network while the person decides.
    expect(acme.specs).toHaveLength(0);
    expect(ask?.req.tool).toBe("a2a:acme");
    expect(ask?.req.title).toBe("Send a task to acme");
    expect(ask?.req.detail).toBe("https://agents.acme.dev · review PR 12");
    expect(ask?.options?.toolCallId).toBe("call-9");
    expect(ask?.options?.origin).toBe("subagent");
    expect(ask?.options?.agent?.type).toBe("a2a:acme");
    ask?.answer({ allowed: true });
    const result = await p;
    expect(acme.specs.map((s) => s.prompt)).toEqual(["review PR 12"]);
    expect(result.report).toContain("done");
  });

  test("auto mode ON: the broker's own auto-accept answers it (an ordinary tool ask)", async () => {
    const broker = new SpyBroker(true);
    const acme = remote("a2a:acme");
    await runner([acme], broker).run(opts("a2a:acme"));
    expect(broker.asks).toHaveLength(1);
    expect(autoApproves(broker.asks[0]?.req as PermissionRequest)).toBe(true);
    expect(acme.specs).toHaveLength(1);
  });

  test("'always for this session' covers the same agent again, never another one", async () => {
    const broker = new SpyBroker();
    const grants = new SessionGrants();
    const acme = remote("a2a:acme");
    const other = remote("a2a:other");
    const r = runner([acme, other], broker, { grants });
    const first = r.run(opts("a2a:acme"));
    await until(() => broker.asks.length === 1);
    broker.asks[0]?.answer({ allowed: true, scope: "session" });
    await first;
    await r.run(opts("a2a:acme", "second task"));
    expect(broker.asks).toHaveLength(1);
    expect(acme.specs).toHaveLength(2);
    const third = r.run(opts("a2a:other"));
    await until(() => broker.asks.length === 2);
    expect(broker.asks[1]?.req.tool).toBe("a2a:other");
    broker.asks[1]?.answer({ allowed: false });
    await failureOf(third);
    expect(other.specs).toHaveLength(0);
  });

  test("refused → «not sent», nothing started", async () => {
    const broker = new SpyBroker();
    const acme = remote("a2a:acme");
    const p = runner([acme], broker).run(opts("a2a:acme"));
    await until(() => broker.asks.length === 1);
    broker.asks[0]?.answer({ allowed: false });
    const err = await failureOf(p);
    expect(err.message).toContain("a2a:acme: not sent");
    expect(acme.specs).toHaveLength(0);
  });

  test("no broker at all (denyAll) → nothing sent", async () => {
    const acme = remote("a2a:acme");
    const err = await failureOf(runner([acme], undefined).run(opts("a2a:acme")));
    expect(err.message).toContain("not sent");
    expect(acme.specs).toHaveLength(0);
  });
});

describe("C4: what leaves is redacted, and a hook's rewrite is what leaves", () => {
  const secret = "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX0123";

  test("a secret in the prompt is masked in the ask AND in what the remote receives", async () => {
    const broker = new SpyBroker(true);
    const acme = remote("a2a:acme");
    await runner([acme], broker).run(opts("a2a:acme", `use ${secret} to review`));
    expect(broker.asks[0]?.req.detail).not.toContain(secret);
    expect(acme.specs[0]?.prompt).not.toContain(secret);
    expect(acme.specs[0]?.prompt).toContain("[REDACTED");
  });

  test("a tool_call hook rewriting `prompt` changes what the remote receives", async () => {
    const broker = new SpyBroker(true);
    const acme = remote("a2a:acme");
    const hooks = hookRunner({ input: { prompt: "rewritten by the owner's hook" } });
    await runner([acme], broker, { hooks }).run(opts("a2a:acme"));
    expect(acme.specs[0]?.prompt).toBe("rewritten by the owner's hook");
  });

  test("a hook that blocks → not sent", async () => {
    const broker = new SpyBroker(true);
    const acme = remote("a2a:acme");
    const hooks = hookRunner({ decision: "deny", reason: "no outbound today" });
    const err = await failureOf(runner([acme], broker, { hooks }).run(opts("a2a:acme")));
    expect(err.message).toContain("no outbound today");
    expect(acme.specs).toHaveLength(0);
  });

  test("a long text: the ask shows the first 2000 chars and how many more", async () => {
    const broker = new SpyBroker(true);
    const acme = remote("a2a:acme");
    await runner([acme], broker).run(opts("a2a:acme", "x".repeat(2500)));
    expect(broker.asks[0]?.req.detail).toEndWith("(+500 chars)");
    expect(acme.specs[0]?.prompt).toHaveLength(2500);
  });
});

describe("C3 + C6: a reply to a remote question passes the same gate", () => {
  const question: HarnessEvent = {
    kind: "ask",
    askId: "q1",
    ask: { type: "input", question: "Which branch?" },
  };

  test("parent route: the RAW reply, redacted, is answered after a second consent", async () => {
    const broker = new SpyBroker();
    const acme = remote("a2a:acme", () => [question]);
    const inbox = new AgentInbox();
    const notes: string[] = [];
    const p = runner([acme], broker, {
      inputFrom: "parent",
      notify: (_id, text) => {
        notes.push(text);
        return { ok: true, wakes: true };
      },
    }).run(opts("a2a:acme"), { agentId: "sa-1", inbox, signal: new AbortController().signal });
    await until(() => broker.asks.length === 1);
    broker.asks[0]?.answer({ allowed: true });
    await until(() => notes.length === 1);
    expect(notes[0]).toContain("Which branch?");
    expect(notes[0]).toContain("remote content");
    inbox.push("[message from the parent agent] main", "agent", "main");
    await until(() => broker.asks.length === 2);
    expect(broker.asks[1]?.req.detail).toBe("https://agents.acme.dev · main");
    expect(acme.runs[0]?.answers).toHaveLength(0);
    broker.asks[1]?.answer({ allowed: true });
    const result = await p;
    expect(acme.runs[0]?.answers).toEqual([
      { askId: "q1", decision: { allow: true, input: "main" } },
    ]);
    expect(result.report).toContain("got main");
  });

  // Review round 1 finding 1: a text the parent sent BEFORE the question is not
  // its reply — it must never leave as the answer (with auto mode or a session
  // grant on the agent it would leave unseen).
  test("parent route: a text queued before the question is not its answer", async () => {
    const broker = new SpyBroker();
    const acme = remote("a2a:acme", () => [question]);
    const inbox = new AgentInbox();
    inbox.push("[message from the parent agent] how is it going?", "agent", "how is it going?");
    const notes: string[] = [];
    const p = runner([acme], broker, {
      inputFrom: "parent",
      notify: (_id, text) => {
        notes.push(text);
        return { ok: true, wakes: true };
      },
    }).run(opts("a2a:acme"), { agentId: "sa-1", inbox, signal: new AbortController().signal });
    await until(() => broker.asks.length === 1);
    broker.asks[0]?.answer({ allowed: true });
    await until(() => notes.length === 1);
    inbox.push("[message from the parent agent] main", "agent", "main");
    await until(() => broker.asks.length === 2);
    expect(broker.asks[1]?.req.detail).toBe("https://agents.acme.dev · main");
    broker.asks[1]?.answer({ allowed: true });
    const result = await p;
    expect(acme.runs[0]?.answers).toEqual([
      { askId: "q1", decision: { allow: true, input: "main" } },
    ]);
    expect(broker.asks.map((a) => a.req.detail)).not.toContain(
      "https://agents.acme.dev · how is it going?",
    );
    // Never read, never lost: the run reports it.
    expect(result.report).toContain("1 message(s) sent to this sub-agent");
  });

  test("both route: the parent's late reply to Q1 (the person answered first) does not answer Q2", async () => {
    const broker = new SpyBroker();
    const q2: HarnessEvent = {
      kind: "ask",
      askId: "q2",
      ask: { type: "input", question: "Which file?" },
    };
    const acme = remote("a2a:acme", () => [question]);
    const inbox = new AgentInbox();
    const notes: string[] = [];
    const p = runner([acme], broker, {
      inputFrom: "both",
      notify: (_id, text) => {
        notes.push(text);
        return { ok: true, wakes: true };
      },
    }).run(opts("a2a:acme"), { agentId: "sa-1", inbox, signal: new AbortController().signal });
    await until(() => broker.asks.length === 1);
    broker.asks[0]?.answer({ allowed: true });
    // Q1: the person answers in the pop-up first.
    await until(() => broker.asks.length === 2);
    expect(broker.asks[1]?.req.kind).toBe("question");
    broker.asks[1]?.answer({ allowed: true, message: "main" });
    await until(() => broker.asks.length === 3);
    expect(broker.asks[2]?.req.detail).toBe("https://agents.acme.dev · main");
    // The parent, already told about Q1, replies late: the route was withdrawn.
    inbox.push("[message from the parent agent] develop", "agent", "develop");
    const run = acme.runs[0];
    if (!run) throw new Error("no run");
    run.answer = async (askId, decision) => {
      run.answers.push({ askId, decision });
      run.push(
        askId === "q1"
          ? q2
          : {
              kind: "end",
              status: "completed",
              text: `got ${decision.allow ? String(decision.input) : decision.message}`,
            },
      );
    };
    broker.asks[2]?.answer({ allowed: true });
    // Q2 is raised: the pop-up is asked (not withdrawn by the stale reply).
    await until(() => notes.length === 2);
    await until(() => broker.asks.length >= 4);
    const q2Ask = broker.asks[3];
    expect(q2Ask?.req.kind).toBe("question");
    q2Ask?.answer({ allowed: true, message: "README.md" });
    await until(() => broker.asks.length === 5);
    expect(broker.asks[4]?.req.detail).toBe("https://agents.acme.dev · README.md");
    broker.asks[4]?.answer({ allowed: true });
    const result = await p;
    expect(run.answers.map((a) => a.decision)).toEqual([
      { allow: true, input: "main" },
      { allow: true, input: "README.md" },
    ]);
    expect(broker.asks.map((a) => a.req.detail)).not.toContain("https://agents.acme.dev · develop");
    expect(result.report).toContain("1 message(s) sent to this sub-agent");
  });

  test("both route, the parent could not be told: a text pushed meanwhile is not swallowed by a wait nobody answers", async () => {
    const broker = new SpyBroker();
    const acme = remote("a2a:acme", () => [question]);
    const inbox = new AgentInbox();
    const p = runner([acme], broker, {
      inputFrom: "both",
      notify: () => ({ ok: false, reason: "limit" }),
    }).run(opts("a2a:acme"), { agentId: "sa-1", inbox, signal: new AbortController().signal });
    await until(() => broker.asks.length === 1);
    broker.asks[0]?.answer({ allowed: true });
    await until(() => broker.asks.length === 2);
    expect(broker.asks[1]?.req.kind).toBe("question");
    inbox.push("[message from the parent agent] unrelated", "agent", "unrelated");
    expect(inbox.pending).toBe(1);
    broker.asks[1]?.answer({ allowed: true, message: "main" });
    await until(() => broker.asks.length === 3);
    broker.asks[2]?.answer({ allowed: true });
    const result = await p;
    expect(result.report).toContain("1 message(s) sent to this sub-agent");
  });

  test("a skipped question is never answered", async () => {
    const broker = new SpyBroker();
    const acme = remote("a2a:acme", () => [question]);
    const p = runner([acme], broker, { inputFrom: "user" });
    const run = p.run(opts("a2a:acme"));
    await until(() => broker.asks.length === 1);
    broker.asks[0]?.answer({ allowed: true });
    // The user route (a2c-4): the question reaches the broker; a skip ends the
    // run with the question, nothing answered and no reply consent asked.
    await until(() => broker.asks.length === 2);
    expect(broker.asks[1]?.req.kind).toBe("question");
    broker.asks[1]?.answer({ allowed: false });
    const result = await run;
    expect(broker.asks).toHaveLength(2);
    expect(result.report).toContain("needs input to continue: Which branch?");
    expect(acme.runs[0]?.answers).toEqual([]);
  });

  test("user route: a refused reply → «reply not sent», the run never answered", async () => {
    const broker = new SpyBroker();
    const acme = remote("a2a:acme", () => [question]);
    const harnessRunner = createSubagentRunner({
      model: {} as ModelProvider,
      env: {} as never,
      tools: new ToolRegistry(),
      types: [typeFor("a2a:acme")],
      harness: {
        instances: new Map([[acme.id, { adapter: acme, idleMinutes: 1, inputFrom: "user" }]]),
        cwd: "/nowhere",
      },
      requestPermission: broker.request,
    });
    const p = harnessRunner.run(opts("a2a:acme"));
    await until(() => broker.asks.length === 1);
    broker.asks[0]?.answer({ allowed: true });
    // The question (a2c-4, C6) reaches the same broker; its answer is then the reply.
    await until(() => broker.asks.length === 2);
    expect(broker.asks[1]?.req.kind).toBe("question");
    broker.asks[1]?.answer({ allowed: true, message: "leak?" });
    await until(() => broker.asks.length === 3);
    broker.asks[2]?.answer({ allowed: false });
    const err = await failureOf(p);
    expect(err.message).toContain("reply not sent");
    expect(acme.runs[0]?.answers).toEqual([]);
  });
});

describe("C7: a stop never waits a reconnect backoff", () => {
  test("abort during the backoff → cancelled at once, «may still be running»", async () => {
    const broker = new SpyBroker(true);
    let reattaches = 0;
    const acme = remote(
      "a2a:acme",
      () => [
        { kind: "started", handle: { adapter: "a2a:acme", id: "task-5", extra: {} }, detail: {} },
        { kind: "disconnected", reason: "dropped" },
      ],
      async () => {
        reattaches += 1;
        throw new Error("down");
      },
    );
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runner([acme], broker, { backoffMs: 60_000 }).run(opts("a2a:acme"), {
      signal: ac.signal,
    });
    await until(() => acme.runs.length === 1);
    setTimeout(() => ac.abort(), 20);
    const result = await p;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(reattaches).toBe(0);
    expect(result.stopReason).toBe("cancelled");
    expect(result.report).toContain("may still be running (task task-5)");
  });
});
