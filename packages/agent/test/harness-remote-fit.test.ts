/**
 * D10: the paths a REMOTE (A2A-like) agent needs, pinned through the runner with
 * an in-memory FakeRemoteAdapter before any A2A code exists
 * (docs/feat/subagent-harness-runners.md, slice shr-4).
 */
import { describe, expect, test } from "bun:test";
import { AgentInbox, SubagentFailure, type ToolProgressEvent } from "@tentacle/core";
import type { ModelProvider } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { type HarnessDeps, harnessModeIssue } from "../src/harness/child.ts";
import type {
  HarnessAdapter,
  HarnessCaps,
  HarnessDecision,
  HarnessEvent,
  HarnessRun,
} from "../src/harness/types.ts";
import { type AgentType, createSubagentRunner } from "../src/subagent.ts";

const REMOTE_CAPS: HarnessCaps = {
  permissionAsks: false,
  inputRequired: true,
  steer: true,
  usage: false,
  cost: false,
  quota: false,
  structuredResult: false,
  workspace: "none",
};

/** A run whose events the test pushes; records answers and cancels. */
class ScriptRun implements HarnessRun {
  readonly answers: { askId: string; decision: HarnessDecision }[] = [];
  cancels = 0;
  private queue: HarnessEvent[] = [];
  private waiter: ((r: IteratorResult<HarnessEvent>) => void) | undefined;
  private closed = false;
  constructor(
    private readonly cancelOutcome: "confirmed" | "unconfirmed" = "confirmed",
    private readonly onAnswer?: (run: ScriptRun, askId: string, d: HarnessDecision) => void,
  ) {}
  push(...events: HarnessEvent[]): void {
    for (const e of events) {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = undefined;
        w({ done: false, value: e });
      } else this.queue.push(e);
    }
  }
  close(): void {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }
  readonly events: AsyncIterable<HarnessEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<HarnessEvent>> => {
        const e = this.queue.shift();
        if (e) return Promise.resolve({ done: false, value: e });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    }),
  };
  async answer(askId: string, decision: HarnessDecision): Promise<void> {
    this.answers.push({ askId, decision });
    this.onAnswer?.(this, askId, decision);
  }
  async send(): Promise<void> {}
  async cancel(): Promise<"confirmed" | "unconfirmed"> {
    this.cancels += 1;
    if (this.cancelOutcome === "confirmed") {
      this.push({ kind: "end", status: "cancelled" });
    }
    return this.cancelOutcome;
  }
}

const HANDLE = { adapter: "a2a:acme", id: "task-77", extra: { contextId: "ctx-1" } };

function remoteAdapter(
  runs: ScriptRun[],
  opts: { reattach?: (n: number) => ScriptRun | undefined } = {},
): HarnessAdapter & { starts: number; reattaches: number } {
  const a = {
    id: "a2a:acme",
    kind: "remote" as const,
    caps: REMOTE_CAPS,
    starts: 0,
    reattaches: 0,
    probe: async () => ({ ok: true }),
    start: async () => {
      const run = runs[a.starts];
      a.starts += 1;
      if (!run) throw new Error("no scripted run");
      return run;
    },
    ...(opts.reattach
      ? {
          reattach: async () => {
            a.reattaches += 1;
            const next = opts.reattach?.(a.reattaches);
            if (!next) throw new Error("still down");
            return next;
          },
        }
      : {}),
  };
  return a;
}

const REMOTE_TYPE: AgentType = {
  name: "acme",
  description: "a remote agent",
  prompt: "",
  tools: [],
  harness: { adapter: "a2a:acme", mode: "remote" },
};

type Extra = Partial<HarnessDeps> & { instance?: Record<string, unknown> };
function runner(adapter: HarnessAdapter, extra: Extra = {}, type = REMOTE_TYPE) {
  const harness: HarnessDeps = {
    instances: new Map([[adapter.id, { adapter, idleMinutes: 1, ...extra.instance }]]),
    cwd: "/nowhere",
    reattach: { attempts: 3, backoffMs: 0 },
    ...extra,
  };
  return createSubagentRunner({
    model: {} as ModelProvider,
    env: {} as never,
    tools: new ToolRegistry(),
    types: [type],
    harness,
    // The consent ask (a2c-3, C3) is answered yes: these tests pin the paths after it.
    requestPermission: async () => ({ allowed: true }),
  });
}

/** A background child's inbox + the parent's `notify` (C6 `parent` route). */
function parentRoute(reply: string | undefined) {
  const inbox = new AgentInbox();
  const notes: string[] = [];
  return {
    inbox,
    notes,
    notify: (id: string, text: string) => {
      notes.push(`${id}:${text}`);
      if (reply !== undefined) {
        inbox.push(`[message from the parent agent] ${reply}`, "agent", reply);
      }
      return { ok: true as const, wakes: true };
    },
  };
}

async function failureOf(p: Promise<unknown>): Promise<SubagentFailure> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SubagentFailure) return err;
    throw err;
  }
  throw new Error("expected a SubagentFailure");
}

const OPTS = { description: "remote work", prompt: "do it", type: "acme" };

describe("remote fit: reconnect", () => {
  test("disconnected → reattach → completes on the new stream", async () => {
    const first = new ScriptRun();
    const second = new ScriptRun();
    const adapter = remoteAdapter([first], { reattach: () => second });
    first.push(
      { kind: "started", handle: HANDLE, detail: {} },
      { kind: "progress", label: "working" },
      { kind: "disconnected", reason: "stream dropped" },
    );
    second.push({ kind: "end", status: "completed", text: "all done" });
    const events: ToolProgressEvent[] = [];
    const result = await runner(adapter).run(OPTS, { onEvent: (e) => events.push(e) });
    expect(adapter.reattaches).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    expect(result.report).toContain("all done");
    expect(result.report).toContain("cost: not reported");
    expect(events.map((e) => e.kind)).toEqual(["subagent_start", "subagent_tool", "subagent_end"]);
  });

  test("reattach exhausted → failure whose report carries the handle", async () => {
    const first = new ScriptRun();
    const adapter = remoteAdapter([first], { reattach: () => undefined });
    first.push(
      { kind: "started", handle: HANDLE, detail: {} },
      { kind: "disconnected", reason: "gone" },
    );
    const err = await failureOf(runner(adapter).run(OPTS));
    expect(adapter.reattaches).toBe(3);
    expect(err.message).toContain("task-77");
    expect(err.partialReport).toContain("task task-77");
  });
});

describe("remote fit: INPUT_REQUIRED routing (Owner A9)", () => {
  const ask: HarnessEvent = {
    kind: "ask",
    askId: "q1",
    ask: { type: "input", question: "Which branch?" },
  };
  const answering = (run: ScriptRun, _id: string, d: HarnessDecision) => {
    if (d.allow) run.push({ kind: "end", status: "completed", text: `used ${String(d.input)}` });
  };

  test("parent: the background child's question reaches the parent; its RAW reply is answered", async () => {
    const run = new ScriptRun("confirmed", answering);
    run.push(ask);
    const route = parentRoute("main");
    const result = await runner(remoteAdapter([run]), {
      instance: { inputFrom: "parent" },
      notify: route.notify,
    }).run(OPTS, { agentId: "sa-3", signal: new AbortController().signal, inbox: route.inbox });
    expect(route.notes).toHaveLength(1);
    expect(route.notes[0]).toContain("sa-3:Remote question from a2a:acme");
    expect(route.notes[0]).toContain("Which branch?");
    // The sender's words, never the «[message from the parent agent] …» wrapping.
    expect(run.answers).toEqual([{ askId: "q1", decision: { allow: true, input: "main" } }]);
    expect(result.report).toContain("used main");
  });

  test("user: the question goes to askUser", async () => {
    const run = new ScriptRun("confirmed", answering);
    run.push(ask);
    const route = parentRoute("WRONG");
    const result = await runner(remoteAdapter([run]), {
      instance: { inputFrom: "user" },
      askUser: async () => "dev",
      notify: route.notify,
    }).run(OPTS, { agentId: "sa-1", inbox: route.inbox });
    expect(route.notes).toEqual([]);
    expect(result.report).toContain("used dev");
  });

  test("both: the first answer wins and the loser (the inbox wait) is withdrawn", async () => {
    const run = new ScriptRun("confirmed", answering);
    run.push(ask);
    const route = parentRoute(undefined);
    const result = await runner(remoteAdapter([run]), {
      instance: { inputFrom: "both" },
      askUser: async () => "from-user",
      notify: route.notify,
    }).run(OPTS, { agentId: "sa-2", inbox: route.inbox });
    expect(result.report).toContain("used from-user");
    expect(route.notes).toHaveLength(1);
    expect(run.answers).toHaveLength(1);
    // Withdrawn: a later text is queued (reported unread), not taken as an answer.
    route.inbox.push("late");
    expect(run.answers).toHaveLength(1);
  });

  test("no route (foreground, parent only) → the child ends with the question, never waits", async () => {
    const run = new ScriptRun();
    run.push({ kind: "started", handle: HANDLE, detail: {} }, ask);
    const route = parentRoute("never");
    const result = await runner(remoteAdapter([run]), {
      instance: { inputFrom: "parent" },
      notify: route.notify,
    }).run(OPTS);
    expect(result.report).toContain("needs input to continue: Which branch?");
    expect(result.report).toContain("task-77");
    expect(run.answers).toEqual([]);
  });

  test("an input ask pauses the hang guard", async () => {
    const run = new ScriptRun("confirmed", answering);
    run.push(ask);
    const result = await runner(remoteAdapter([run]), {
      instance: { inputFrom: "user", idleMinutes: 30 / 60_000 },
      askUser: () => new Promise<string>((r) => setTimeout(() => r("late"), 120)),
    }).run(OPTS);
    expect(result.report).toContain("used late");
  });
});

describe("remote fit: auth, cancel, rejected, outputs, mode", () => {
  test("AUTH_REQUIRED → failure naming the instance to configure", async () => {
    const run = new ScriptRun();
    run.push({ kind: "ask", askId: "a", ask: { type: "auth", explanation: "token expired" } });
    const err = await failureOf(runner(remoteAdapter([run])).run(OPTS));
    expect(err.message).toContain("token expired");
    expect(err.message).toContain("configure credentials for a2a:acme");
  });

  test("REJECTED → SubagentFailure 'rejected by <name>'", async () => {
    const run = new ScriptRun();
    run.push({ kind: "end", status: "rejected", error: "out of scope" });
    const err = await failureOf(runner(remoteAdapter([run])).run(OPTS));
    expect(err.message).toBe("rejected by a2a:acme: out of scope");
  });

  test("cancel unconfirmed → cancelled locally, with a may-still-run note", async () => {
    const run = new ScriptRun("unconfirmed");
    run.push({ kind: "started", handle: HANDLE, detail: {} }, { kind: "progress", label: "busy" });
    const ac = new AbortController();
    // Abort once the run is visibly under way (its first progress row).
    const result = await runner(remoteAdapter([run])).run(OPTS, {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.kind === "subagent_tool") ac.abort();
      },
    });
    expect(run.cancels).toBe(1);
    expect(result.stopReason).toBe("cancelled");
    expect(result.report).toContain("may still be running (task task-77)");
  });

  test("a file part is listed, never written; data is capped JSON", async () => {
    const run = new ScriptRun();
    run.push(
      { kind: "output", text: "summary." },
      { kind: "output", data: { big: "x".repeat(10_000) } },
      { kind: "output", file: { name: "a.bin", mediaType: "application/x", bytes: 9 } },
      { kind: "end", status: "completed" },
    );
    const result = await runner(remoteAdapter([run])).run(OPTS);
    expect(result.report).toContain("[file] a.bin (application/x, 9 bytes) — listed, not saved");
    expect(result.report).toContain("chars)");
    expect(result.report.length).toBeLessThan(6000);
  });

  test("mode write on a remote adapter is refused, at build and at run", async () => {
    const adapter = remoteAdapter([new ScriptRun()]);
    const bad: AgentType = { ...REMOTE_TYPE, harness: { adapter: "a2a:acme", mode: "write" } };
    expect(harnessModeIssue(bad, adapter)).toContain('accepts only mode "remote"');
    const err = await failureOf(runner(adapter, {}, bad).run(OPTS));
    expect(err.message).toContain('accepts only mode "remote"');
    expect(adapter.starts).toBe(0);
  });

  test("readOnlyType: a remote harness type is read-only", () => {
    expect(runner(remoteAdapter([])).readOnlyType("acme")).toBe(true);
  });
});
