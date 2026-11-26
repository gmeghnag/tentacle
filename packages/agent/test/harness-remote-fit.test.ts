/**
 * D10: the paths a REMOTE (A2A-like) agent needs, pinned through the runner with
 * an in-memory FakeRemoteAdapter before any A2A code exists
 * (docs/feat/subagent-harness-runners.md, slice shr-4).
 */
import { describe, expect, test } from "bun:test";
import { type StreamResponse, TaskState } from "@a2a-js/sdk";
import {
  AgentInbox,
  DISMISSED,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionRequester,
  type PermissionResponse,
  SubagentFailure,
  type ToolProgressEvent,
} from "@tentacle/core";
import type { ModelProvider } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { A2A_OUTPUT_MAX_CHARS, mapStreamResponse, newMapState } from "../src/harness/a2a-map.ts";
import { type HarnessDeps, harnessModeIssue } from "../src/harness/child.ts";
import type {
  HarnessAdapter,
  HarnessCaps,
  HarnessDecision,
  HarnessEvent,
  HarnessRun,
} from "../src/harness/types.ts";
import { type AgentType, createSubagentRunner, subagentRequester } from "../src/subagent.ts";

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

type Extra = Partial<HarnessDeps> & {
  instance?: Record<string, unknown>;
  /** The ONE broker's requester (default: yes to the consent, no answer to a question). */
  requestPermission?: PermissionRequester;
};
function runner(adapter: HarnessAdapter, extra: Extra = {}, type = REMOTE_TYPE) {
  const { requestPermission, ...rest } = extra;
  const harness: HarnessDeps = {
    instances: new Map([[adapter.id, { adapter, idleMinutes: 1, ...extra.instance }]]),
    cwd: "/nowhere",
    reattach: { attempts: 3, backoffMs: 0 },
    ...rest,
  };
  return createSubagentRunner({
    model: {} as ModelProvider,
    env: {} as never,
    tools: new ToolRegistry(),
    types: [type],
    harness,
    // The consent ask (a2c-3, C3) is answered yes: these tests pin the paths after it.
    requestPermission: requestPermission ?? (async () => ({ allowed: true })),
  });
}

/**
 * The broker as the user route sees it (a2c-4, C6): yes to every consent ask;
 * a `question` is recorded and answered by `answer` (its text, or `undefined` =
 * skip), or left open until withdrawn (`answer` returns a never-settling promise).
 */
function userBroker(answer: () => Promise<string | undefined>) {
  const questions: { req: PermissionRequest; options: PermissionRequestOptions | undefined }[] = [];
  const requester: PermissionRequester = async (req, options) => {
    if (req.kind !== "question") return { allowed: true };
    questions.push({ req, options });
    const withdrawn = new Promise<PermissionResponse>((resolve) => {
      for (const s of [options?.signal, options?.withdraw]) {
        s?.addEventListener("abort", () => resolve(DISMISSED), { once: true });
      }
    });
    const answered = answer().then(
      (text): PermissionResponse =>
        text === undefined ? { allowed: false } : { allowed: true, message: text },
    );
    return Promise.race([answered, withdrawn]);
  };
  return { requester, questions };
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

  test("user (background): a `question` ask to the ONE broker, attributed to sa-N; never the parent", async () => {
    const run = new ScriptRun("confirmed", answering);
    run.push(ask);
    const route = parentRoute("WRONG");
    const broker = userBroker(async () => "dev");
    const result = await runner(remoteAdapter([run]), {
      instance: { inputFrom: "user", origin: "https://agents.acme.dev" },
      notify: route.notify,
      requestPermission: broker.requester,
    }).run(OPTS, { agentId: "sa-1", signal: new AbortController().signal, inbox: route.inbox });
    expect(route.notes).toEqual([]);
    expect(result.report).toContain("used dev");
    expect(broker.questions).toHaveLength(1);
    const q = broker.questions[0];
    expect(q?.req.kind).toBe("question");
    expect(q?.req.tool).toBe("a2a:acme");
    expect(q?.req.title).toBe("acme asks");
    expect(q?.req.detail).toBe("Remote question (https://agents.acme.dev): Which branch?");
    expect(q?.req.reply).toEqual({ maxChars: 4000 });
    expect(q?.options?.origin).toBe("subagent");
    expect(q?.options?.agent?.id).toBe("sa-1");
    // The asker's own withdrawal rides with the child's signal (background path).
    expect(q?.options?.withdraw).toBeDefined();
  });

  test("user (foreground): the same question, no sa-N; the answer is what the remote gets", async () => {
    const run = new ScriptRun("confirmed", answering);
    run.push(ask);
    const broker = userBroker(async () => "  release-1  ");
    const result = await runner(remoteAdapter([run]), {
      instance: { inputFrom: "user" },
      requestPermission: broker.requester,
    }).run(OPTS);
    expect(broker.questions[0]?.req.kind).toBe("question");
    expect(broker.questions[0]?.options?.agent?.id).toBeUndefined();
    expect(run.answers).toEqual([{ askId: "q1", decision: { allow: true, input: "release-1" } }]);
    expect(result.report).toContain("used release-1");
  });

  test("user: a skip → the child ends with the question (remote cancelled), never answers", async () => {
    const run = new ScriptRun();
    run.push({ kind: "started", handle: HANDLE, detail: {} }, ask);
    const broker = userBroker(async () => undefined);
    const result = await runner(remoteAdapter([run]), {
      instance: { inputFrom: "user" },
      requestPermission: broker.requester,
    }).run(OPTS);
    expect(broker.questions).toHaveLength(1);
    expect(result.report).toContain("needs input to continue: Which branch?");
    expect(run.answers).toEqual([]);
  });

  test("a question's remote text is sanitised (no ESC / bidi) and capped in the ask", async () => {
    const run = new ScriptRun();
    const long = `\u001b[2J‮Pick${"x".repeat(2100)}`;
    run.push({ kind: "ask", askId: "q2", ask: { type: "input", question: long } });
    const broker = userBroker(async () => undefined);
    await runner(remoteAdapter([run]), {
      instance: { inputFrom: "user" },
      requestPermission: broker.requester,
    }).run(OPTS);
    const detail = broker.questions[0]?.req.detail ?? "";
    expect(detail).not.toContain("\u001b");
    expect(detail).not.toContain("‮");
    expect(detail).toContain("Remote question: [2JPick");
    expect(detail).toContain("(+");
  });

  test("both: the user answers first → the loser (the inbox wait) is withdrawn", async () => {
    const run = new ScriptRun("confirmed", answering);
    run.push(ask);
    const route = parentRoute(undefined);
    const broker = userBroker(async () => "from-user");
    const result = await runner(remoteAdapter([run]), {
      instance: { inputFrom: "both" },
      notify: route.notify,
      requestPermission: broker.requester,
    }).run(OPTS, { agentId: "sa-2", signal: new AbortController().signal, inbox: route.inbox });
    expect(result.report).toContain("used from-user");
    expect(route.notes).toHaveLength(1);
    expect(run.answers).toHaveLength(1);
    // Withdrawn: a later text is queued (reported unread), not taken as an answer.
    route.inbox.push("late");
    expect(run.answers).toHaveLength(1);
  });

  test("both: the parent answers first → the user's question is withdrawn from the broker", async () => {
    const run = new ScriptRun("confirmed", answering);
    run.push(ask);
    const route = parentRoute("from-parent");
    const broker = userBroker(() => new Promise<string | undefined>(() => {}));
    const result = await runner(remoteAdapter([run]), {
      instance: { inputFrom: "both" },
      notify: route.notify,
      requestPermission: broker.requester,
    }).run(OPTS, { agentId: "sa-4", signal: new AbortController().signal, inbox: route.inbox });
    expect(result.report).toContain("used from-parent");
    expect(broker.questions).toHaveLength(1);
    // The question is withdrawn by the ASKER's own signal (`withdraw`), the
    // child's (`signal`) still live: what makes the daemon settle it at once.
    expect(broker.questions[0]?.options?.withdraw?.aborted).toBe(true);
    expect(broker.questions[0]?.options?.signal?.aborted).toBe(false);
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
      requestPermission: userBroker(
        () => new Promise<string | undefined>((r) => setTimeout(() => r("late"), 120)),
      ).requester,
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

/**
 * A2A `append:false` is a REPLACE of that artifact's text: the report must
 * carry the answer ONCE (the owner's e2e: "…OTTARINA-42…OTTARINA-42").
 * Driven through the REAL mapper into the REAL runner — the bug lived in the
 * seam between them (`child.ts` reported `ev.text` with no `replace` reader).
 */
describe("a2a: a replacing artifact stream reaches the report once", () => {
  const textPart = (text: string) => ({
    content: { $case: "text" as const, value: text },
    metadata: undefined,
    filename: "",
    mediaType: "",
  });
  /** One `artifactUpdate` frame; `append` absent = false, lastChunk as given. */
  const artFrame = (text: string, append: boolean, lastChunk = false): StreamResponse =>
    ({
      payload: {
        $case: "artifactUpdate",
        value: {
          taskId: "t1",
          contextId: "c1",
          artifact: {
            artifactId: "response",
            name: "response",
            description: "",
            parts: [textPart(text)],
            metadata: undefined,
            extensions: [],
          },
          append,
          lastChunk,
          metadata: undefined,
        },
      },
    }) as StreamResponse;
  const completed = (): StreamResponse =>
    ({
      payload: {
        $case: "statusUpdate",
        value: {
          taskId: "t1",
          contextId: "c1",
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            message: undefined,
            timestamp: undefined,
          },
          metadata: undefined,
        },
      },
    }) as StreamResponse;

  /** Map the wire frames, then feed the resulting events to the real runner. */
  async function reportOf(frames: StreamResponse[]): Promise<string> {
    const state = newMapState("a2a:acme", "https://agents.acme.dev/card");
    const run = new ScriptRun();
    const p = runner(remoteAdapter([run])).run(OPTS);
    run.push(...frames.flatMap((f) => mapStreamResponse(f, state)));
    run.close();
    return (await p).report;
  }
  const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

  test("chunk + whole-text lastChunk → the report has it once", async () => {
    // The wire shape of the report: one delta, then the whole text again as the
    // closing artifact (legal A2A, `append:false`) — the composed artifact is "CIAO".
    const report = await reportOf([
      artFrame("CIAO", false),
      artFrame("CIAO", false, true),
      completed(),
    ]);
    expect(count(report, "CIAO")).toBe(1);
    expect(report.startsWith("CIAO")).toBe(true);
  });

  test("append:true deltas still concatenate", async () => {
    // The anti-overreach pin: an appending stream is NOT a replacement.
    const report = await reportOf([
      artFrame("Ot", true),
      artFrame("tarina-42", true, true),
      completed(),
    ]);
    expect(report.startsWith("Ottarina-42")).toBe(true);
    expect(count(report, "Ottarina-42")).toBe(1);
  });

  test("an artifact replaced mid-stream keeps only the replacement", async () => {
    const report = await reportOf([
      artFrame("Ot", true),
      artFrame("tarina-42", true),
      artFrame("OTTARINA-42", false, true),
      completed(),
    ]);
    expect(report.startsWith("OTTARINA-42")).toBe(true);
    expect(report.includes("Ottarina-42")).toBe(false);
  });

  test("a 40 000-char answer under the cap is not cut by its own closing replace", async () => {
    // Review round 1, finding 1: the retracted deltas were billed AGAIN against
    // the 64 KiB cap, so the whole-text close truncated an answer that fits
    // (64K−N chars) with a note that lies about it.
    const half = "d".repeat(20_000);
    const report = await reportOf([
      artFrame(half, true),
      artFrame(half, true),
      artFrame(half + half, false, true),
      completed(),
    ]);
    expect(report.includes(half + half)).toBe(true);
    expect(report.includes("truncated")).toBe(false);
  });

  test("a 70 000-char answer over the cap keeps the cap's worth, not nothing", async () => {
    // Past 64 KiB the deltas set `truncated`, so the close's `takeText` returned
    // undefined and the replace had already emptied the segment: the report had
    // NONE of the answer. It must keep what the cap allows, and say so.
    const chunk = "d".repeat(35_000);
    const report = await reportOf([
      artFrame(chunk, true),
      artFrame(chunk, true),
      artFrame(chunk + chunk, false, true),
      completed(),
    ]);
    expect(report.includes(`${"d".repeat(A2A_OUTPUT_MAX_CHARS - 1)}…`)).toBe(true);
  });
});

describe("C6: the asker's own withdrawal survives subagentRequester", () => {
  test("a foreground child that can move: either the move or the asker withdraws the ask", async () => {
    // Mutation: let the move's `withdrawn` REPLACE the asker's `withdraw` → a
    // question that lost a `both` race stays on every surface → red.
    const seen: (PermissionRequestOptions | undefined)[] = [];
    const base: PermissionRequester = (_req, options) => {
      seen.push(options);
      return new Promise((resolve) =>
        options?.withdraw?.addEventListener("abort", () => resolve(DISMISSED), { once: true }),
      );
    };
    const moved = new AbortController();
    const wrapped = subagentRequester(
      base,
      "call-1",
      { type: "a2a:acme", description: "review" },
      { move: { withdrawn: moved.signal, background: () => undefined } },
    );
    const mine = new AbortController();
    const pending = wrapped(
      { kind: "question", tool: "a2a:acme", level: "ask", title: "acme asks", input: {} },
      { signal: mine.signal, withdraw: mine.signal },
    );
    mine.abort();
    expect(await pending).toEqual(DISMISSED);
    expect(seen[0]?.withdraw?.aborted).toBe(true);
    expect(moved.signal.aborted).toBe(false);
  });
});
