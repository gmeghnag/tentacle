/**
 * docs/feat/a2a-client.md C6 (a2c-4): a remote agent's question rides the
 * daemon's ONE ask machine as its own blocking type, `question_request`.
 * Real `SessionHost` + `Connection` (the session-auto-accept-asked-on pattern);
 * the asking "child" is a tool that calls the session's broker with a
 * `kind: "question"` request, as `subagentRequester` → `awaitDecision` does.
 * Each test names its mutation.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionResponse,
  type StreamEvent,
} from "@tentacle/core";
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  KNOWN_UPDATE_TYPES,
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
  type QuestionRequestUpdate,
  QuestionRequestUpdateSchema,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import { askOf, callerMayAnswer } from "../src/external/asks.ts";
import { SessionHost } from "../src/session-host.ts";

class OneCall implements ModelProvider {
  readonly id = "one-call";
  private called = false;
  async *stream(): AsyncIterable<StreamEvent> {
    if (!this.called) {
      this.called = true;
      yield { type: "tool_call", toolCall: { id: "c1", name: "ask_remote", arguments: "{}" } };
    }
    yield { type: "done" };
  }
}

const env = {} as ExecutionEnvironment;
const QUESTION = {
  kind: "question" as const,
  tool: "a2a:acme",
  level: "ask" as const,
  title: "acme asks",
  detail: "Remote question (https://agents.acme.dev): Which branch?",
  input: {},
  reply: { maxChars: 4000 },
};

const WF = { name: "rassegna", runId: "wf-1", stepId: "generate", index: 1, count: 5 };

/** A daemon whose one tool raises a remote question through the session's broker. */
function daemon(
  opts: { background?: boolean; answersAutoAccept?: boolean; workflow?: boolean } = {},
) {
  const responses: PermissionResponse[] = [];
  const childSignal = new AbortController();
  /** The asker's own withdrawal (a `both` race lost): `options.withdraw`. */
  const askerWithdraw = new AbortController();
  const host = new SessionHost({
    defaultCwd: "/tmp/question-ask",
    sharedAutoAccept: true,
    ...(opts.answersAutoAccept ? { answersAutoAccept: true } : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const tool = {
        name: "ask_remote",
        description: "a child whose remote agent asks the person",
        inputSchema: z.object({}).passthrough(),
        permission: "none" as const,
        execute: async () => {
          const response = await permissions.request(QUESTION, {
            toolCallId: "c1",
            origin: "subagent",
            // The workflow driver's own origin (a step's ask); this fake tool is
            // the step's child, so it is the only way to raise one here.
            ...(opts.workflow ? { workflow: WF } : {}),
            agent: opts.background
              ? { type: "a2a:acme", description: "review", id: "sa-1" }
              : { type: "a2a:acme", description: "review" },
            ...(opts.background ? { signal: childSignal.signal } : {}),
            withdraw: askerWithdraw.signal,
          });
          responses.push(response);
          return { content: "ok" };
        },
      };
      const agent = new Agent({
        model: new OneCall(),
        tools: new ToolRegistry().register(tool),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const connect = async (updatesDeclared?: readonly string[]) => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const updates: KnownSessionUpdateParams[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        streaming: true,
        ...(updatesDeclared ? { updates: [...updatesDeclared] } : {}),
      },
    });
    const questions = () =>
      updates
        .map((u) => u.update)
        .filter((u): u is QuestionRequestUpdate => u.type === "question_request");
    const resolved = () =>
      updates.map((u) => u.update).filter((u) => u.type === "permission_resolved");
    return { client, updates, questions, resolved };
  };
  return { host, connect, responses, childSignal, askerWithdraw };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`until: timed out waiting for ${String(cond)}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const prompt = (client: RpcPeer) =>
  client.request("session/prompt", {
    sessionId: "S",
    turnId: "t1",
    content: [{ type: "text", text: "go" }],
  });

async function codeOf(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof RpcError ? err.code : -1;
  }
}

const WITHOUT_QUESTION = KNOWN_UPDATE_TYPES.filter((t) => t !== "question_request");

describe("question_request: raised, replayed, answered", () => {
  test("streamed as question_request (never permission_request), answered by answer_question", async () => {
    // Mutation: emit it as a permission_request (toAskUpdate ignores the kind) → red.
    const d = daemon();
    const a = await d.connect();
    await a.client.request("session/open", { sessionId: "S", create: true });
    const turn = prompt(a.client);
    await until(() => a.questions().length === 1);
    expect(a.updates.some((u) => u.update.type === "permission_request")).toBe(false);
    const [q] = a.questions();
    if (!q) throw new Error("no question");
    expect(q.title).toBe("acme asks");
    expect(q.question).toBe("Remote question (https://agents.acme.dev): Which branch?");
    expect(q.toolCallId).toBe("c1");
    expect(q.agent).toEqual({ type: "a2a:acme", description: "review" });
    expect(q.maxChars).toBe(4000);
    // A permission answer never settles a question (it stays pending).
    expect(
      await codeOf(
        a.client.request("session/resolve_permission", {
          sessionId: "S",
          requestId: q.requestId,
          optionId: "answer",
        }),
      ),
    ).toBe(JsonRpcErrorCode.InvalidParams);
    await a.client.request("session/answer_question", {
      sessionId: "S",
      requestId: q.requestId,
      answer: "release-1",
    });
    await turn;
    await until(() => d.responses.length === 1);
    expect(d.responses).toEqual([{ allowed: true, scope: "once", message: "release-1" }]);
    expect(a.resolved()).toEqual([
      {
        type: "permission_resolved",
        requestId: q.requestId,
        outcome: { outcome: "selected", optionId: "answer" },
      },
    ]);
    // First wins: a second, different answer is not pending, no effect.
    expect(
      await codeOf(
        a.client.request("session/answer_question", {
          sessionId: "S",
          requestId: q.requestId,
        }),
      ),
    ).toBe(DomainErrorCode.PermissionNotPending);
  });

  test("a workflow step's question keeps its run attribution on the wire", async () => {
    // Mutation: the daemon forwards `workflow` to the permission branch only
    // (docs/fix/a2a-question-workflow-label.md, repro line 1) → red.
    const d = daemon({ workflow: true });
    const a = await d.connect();
    await a.client.request("session/open", { sessionId: "S", create: true });
    const turn = prompt(a.client);
    await until(() => a.questions().length === 1);
    const q = a.questions()[0];
    if (!q) throw new Error("no question");
    expect(q.workflow).toEqual(WF);
    // And a client's own parse of that very update accepts it.
    expect(QuestionRequestUpdateSchema.safeParse(q).success).toBe(true);
    await a.client.request("session/answer_question", {
      sessionId: "S",
      requestId: q.requestId,
      answer: "release-1",
    });
    await turn;
    await until(() => d.responses.length === 1);
    expect(d.responses[0]?.message).toBe("release-1");
  });

  test("a skip (no answer) → allowed: false, no message", async () => {
    const d = daemon();
    const a = await d.connect();
    await a.client.request("session/open", { sessionId: "S", create: true });
    const turn = prompt(a.client);
    await until(() => a.questions().length === 1);
    const requestId = a.questions()[0]?.requestId ?? "";
    await a.client.request("session/answer_question", { sessionId: "S", requestId });
    await turn;
    await until(() => d.responses.length === 1);
    expect(d.responses).toEqual([{ allowed: false }]);
  });

  test("replayed to a client that attaches while it is pending", async () => {
    const d = daemon();
    const a = await d.connect();
    await a.client.request("session/open", { sessionId: "S", create: true });
    const turn = prompt(a.client);
    await until(() => a.questions().length === 1);
    const b = await d.connect();
    await b.client.request("session/open", { sessionId: "S" });
    await until(() => b.questions().length === 1);
    expect(b.questions()[0]?.requestId).toBe(a.questions()[0]?.requestId ?? "missing");
    await b.client.request("session/answer_question", {
      sessionId: "S",
      requestId: b.questions()[0]?.requestId ?? "",
      answer: "from b",
    });
    await turn;
    await until(() => d.responses.length === 1);
    expect(d.responses[0]?.message).toBe("from b");
  });

  test("a background child's question is held apart, and settled when the child ends", async () => {
    const d = daemon({ background: true });
    const a = await d.connect();
    await a.client.request("session/open", { sessionId: "S", create: true });
    const turn = prompt(a.client);
    await until(() => a.questions().length === 1);
    expect(a.questions()[0]?.agent?.id).toBe("sa-1");
    d.childSignal.abort();
    await turn;
    await until(() => d.responses.length === 1);
    expect(d.responses).toEqual([{ allowed: false }]);
    await until(() => a.resolved().length === 1);
  });

  test("a background question that lost a `both` race is withdrawn by the asker's own signal", async () => {
    // Mutation: the background path ignores `options.withdraw` → the question
    // stays pending on every device until the child ends → red (times out).
    const d = daemon({ background: true });
    const a = await d.connect();
    await a.client.request("session/open", { sessionId: "S", create: true });
    const turn = prompt(a.client);
    await until(() => a.questions().length === 1);
    d.askerWithdraw.abort();
    await turn;
    await until(() => d.responses.length === 1);
    // Nobody decided: dismissed, and every surface's prompt is closed.
    expect(d.responses).toEqual([{ allowed: false, dismissed: true }]);
    await until(() => a.resolved().length === 1);
    expect(d.childSignal.signal.aborted).toBe(false);
  });
});

describe("the blocking fallback: no client able to show a question", () => {
  test("at raise: an attached client that did not declare it → SKIPPED at once, with the reason", async () => {
    // Mutation: check `permission_request` (not the ask's own type) at raise →
    // the question is emitted to a client that cannot show it and hangs → red.
    const d = daemon();
    const a = await d.connect(WITHOUT_QUESTION);
    await a.client.request("session/open", { sessionId: "S", create: true });
    await prompt(a.client);
    await until(() => d.responses.length === 1);
    expect(d.responses).toEqual([
      { allowed: false, reason: "client does not support question_request; update tentacle" },
    ]);
    expect(a.questions()).toEqual([]);
  });

  test("on detach: the last client able to show it leaves → skipped with the reason", async () => {
    // Mutation: `recheckAsks` checks `permission_request` for every ask → hangs → red.
    const d = daemon();
    const a = await d.connect();
    const b = await d.connect(WITHOUT_QUESTION);
    await a.client.request("session/open", { sessionId: "S", create: true });
    await b.client.request("session/open", { sessionId: "S" });
    const turn = prompt(a.client);
    await until(() => a.questions().length === 1);
    await a.client.request("session/detach", { sessionId: "S" });
    await until(() => d.responses.length === 1);
    expect(d.responses[0]).toEqual({
      allowed: false,
      reason: "client does not support question_request; update tentacle",
    });
    await turn.catch(() => undefined);
  });

  test("nobody attached → it waits for a client (the push reaches the phone)", async () => {
    const d = daemon();
    const a = await d.connect();
    await a.client.request("session/open", { sessionId: "S", create: true });
    const turn = prompt(a.client);
    await until(() => a.questions().length === 1);
    // Nobody attached: no fallback. Proven below — had it been skipped on this
    // detach, the later answer would be `PermissionNotPending` (a throw).
    await a.client.request("session/detach", { sessionId: "S" });
    const b = await d.connect();
    await b.client.request("session/open", { sessionId: "S" });
    await until(() => b.questions().length >= 1);
    await b.client.request("session/answer_question", {
      sessionId: "S",
      requestId: b.questions()[0]?.requestId ?? "",
      answer: "later",
    });
    await turn.catch(() => undefined);
    await until(() => d.responses.length === 1);
    expect(d.responses[0]?.message).toBe("later");
  });
});

describe("never answered by the computer or a caller", () => {
  test("serve auto-accept ON never answers a question", async () => {
    // Mutation: let `autoApproves` answer `question` → the daemon answers it → red.
    const d = daemon({ answersAutoAccept: true });
    const a = await d.connect();
    await a.client.request("session/open", { sessionId: "S", create: true });
    await a.client.request("session/set_auto_accept", { sessionId: "S", on: true });
    const turn = prompt(a.client);
    await until(() => a.questions().length === 1);
    // Shown, then `autoAnswer` ran synchronously right after the emit: had the
    // computer answered, this human answer would be `PermissionNotPending`.
    expect(a.resolved()).toEqual([]);
    await a.client.request("session/answer_question", {
      sessionId: "S",
      requestId: a.questions()[0]?.requestId ?? "",
      answer: "human",
    });
    await turn;
    await until(() => d.responses.length === 1);
    expect(d.responses[0]?.message).toBe("human");
  });

  test("an external caller never answers an agent_add ask, in any mode", () => {
    // Mutation: drop the `a2a_add_agent` mapping in `askOf` → kind `tool` → answerable → red.
    const ask = askOf(
      {
        type: "permission_request",
        requestId: "p1",
        toolCallId: "c1",
        tool: "a2a_add_agent",
        title: "Use a new remote agent?",
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Deny", kind: "reject_once" },
        ],
      },
      true,
    );
    expect(ask.kind).toBe("agent_add");
    expect(callerMayAnswer(ask, "both")).toBe(false);
  });
});
