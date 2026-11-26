/**
 * docs/feat/a2a-client.md C6/C11 (a2c-4): a remote agent's question and a
 * model-proposed agent on the laptop, both directions.
 * - wire → broker: `question_request` → `PermissionRequest{kind:"question", reply}`
 *   into the ONE broker; `a2a_add_agent` → `kind: "agent_add"`. Neither is ever
 *   auto-accepted.
 * - broker → wire: an answer (`allowed` + text) → `session/answer_question
 *   {answer}`; anything else → the same method with no answer (skip); never
 *   `session/resolve_permission`.
 * Mutations: map `a2a_add_agent` to no kind → the agent_add test is red; send a
 * question's answer through `resolve_permission` → the RemoteClient tests are red.
 */
import { describe, expect, test } from "bun:test";
import {
  A2A_ADD_AGENT_TOOL,
  DISMISSED,
  PermissionBroker,
  type PermissionRequest,
  type PermissionResponse,
  autoApproves,
  onceOnlyAsk,
} from "@tentacle/core";
import {
  JsonRpcErrorCode,
  Method,
  Notification,
  PROTOCOL_VERSION,
  type PermissionRequestUpdate,
  type QuestionRequestUpdate,
} from "@tentacle/protocol";
import { DomainErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import {
  PermissionRouter,
  type RouterAction,
  toPermissionRequest,
} from "../src/permission-router.ts";
import { RemoteClient } from "../src/remote-client.ts";
import { until } from "./support/fakes.ts";

const question = (
  requestId = "q1",
  over: Partial<QuestionRequestUpdate> = {},
): QuestionRequestUpdate => ({
  type: "question_request",
  requestId,
  toolCallId: "c1",
  title: "acme asks",
  question: "Remote question (https://agents.acme.dev): Which branch?",
  agent: { type: "a2a:acme", description: "review the PR", id: "sa-1" },
  turnId: "t-spawn",
  maxChars: 4000,
  ...over,
});

const addAgent: PermissionRequestUpdate = {
  type: "permission_request",
  requestId: "p1",
  toolCallId: "c2",
  tool: A2A_ADD_AGENT_TOOL,
  title: "Use a new remote agent?",
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ],
};

describe("wire → broker", () => {
  test("a question becomes kind `question` with its reply bound; auto-accept never answers it", () => {
    const req = toPermissionRequest(question());
    expect(req).toEqual({
      kind: "question",
      tool: "a2a:acme",
      level: "ask",
      title: "acme asks",
      detail: "Remote question (https://agents.acme.dev): Which branch?",
      input: {},
      reply: { maxChars: 4000 },
    });
    expect(autoApproves(req, true)).toBe(false);
  });

  test("the router prompts it with its sub-agent and its spawning turn", () => {
    const r = new PermissionRouter();
    const [action] = r.request("s1", question(), "t-other");
    expect(action?.kind).toBe("prompt");
    if (action?.kind === "prompt") {
      expect(action.request.kind).toBe("question");
      expect(action.turnId).toBe("t-spawn");
      expect(action.agent).toEqual({ type: "a2a:acme", description: "review the PR", id: "sa-1" });
    }
  });

  test("a2a_add_agent becomes kind `agent_add`: never auto-accepted, once-only", () => {
    const req: PermissionRequest = toPermissionRequest(addAgent);
    expect(req.kind).toBe("agent_add");
    expect(autoApproves(req, true)).toBe(false);
    expect(onceOnlyAsk(req)).toBe(true);
  });
});

describe("broker → wire (router)", () => {
  const answer = (response: PermissionResponse) => {
    const r = new PermissionRouter();
    r.request("s1", question());
    return r.answered("s1", "q1", response);
  };

  test("an answer (allowed + text) → an `answer` send, normalized", () => {
    expect(answer({ allowed: true, message: "  main\r\n" })).toEqual([
      {
        kind: "send",
        sessionId: "s1",
        requestId: "q1",
        optionId: "answer",
        message: "main",
        question: true,
      },
    ]);
  });

  test("a refusal, or no text left → a skip (no message)", () => {
    const skip: RouterAction[] = [
      { kind: "send", sessionId: "s1", requestId: "q1", optionId: "skip", question: true },
    ];
    expect(answer({ allowed: false })).toEqual(skip);
    expect(answer({ allowed: true, message: " \u0007 " })).toEqual(skip);
    expect(answer({ allowed: true })).toEqual(skip);
  });

  test("a withdrawn prompt sends nothing (stays pending for another device)", () => {
    expect(answer(DISMISSED)).toEqual([]);
  });

  test("an over-long answer is clamped to the question's bound", () => {
    const r = new PermissionRouter();
    r.request("s1", question("q1", { maxChars: 5 }));
    const [send] = r.answered("s1", "q1", { allowed: true, message: "abcdefgh" });
    expect(send?.kind === "send" ? send.message : undefined).toBe("abcde");
  });
});

describe("RemoteClient: a question's answer rides session/answer_question", () => {
  async function rig(
    respond: (req: PermissionRequest) => Promise<PermissionResponse>,
    answerWith: () => unknown = () => ({}),
  ) {
    const [daemonCh, clientCh] = createChannelPair();
    const calls: { method: string; params: unknown }[] = [];
    let seq = 0;
    const daemon = new RpcPeer(daemonCh, {
      onRequest: async (method, params) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
          };
        }
        if (method === Method.Open) {
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        }
        if (method === Method.AnswerQuestion || method === Method.ResolvePermission) {
          calls.push({ method, params });
          return method === Method.AnswerQuestion ? answerWith() : {};
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
    });
    const errors: Error[] = [];
    const seen: PermissionRequest[] = [];
    const client = new RemoteClient(
      clientCh,
      new PermissionBroker((req) => {
        seen.push(req);
        return respond(req);
      }),
      undefined,
      { onError: (e) => errors.push(e) },
    );
    await client.initialize();
    await client.openSession(undefined, undefined, "s1");
    const send = (update: Record<string, unknown>) =>
      daemon.notify(Notification.SessionUpdate, {
        sessionId: "s1",
        seq: ++seq,
        mandatory: true,
        update,
      });
    return { client, calls, errors, seen, send };
  }

  test("answered → {answer}; the ONE broker saw a `question`", async () => {
    const r = await rig(async () => ({ allowed: true, message: "release-1" }));
    r.send(question());
    await until(() => r.calls.length === 1);
    expect(r.seen.map((q) => q.kind)).toEqual(["question"]);
    expect(r.calls).toEqual([
      {
        method: Method.AnswerQuestion,
        params: { sessionId: "s1", requestId: "q1", answer: "release-1" },
      },
    ]);
    expect(r.errors).toEqual([]);
    r.client.close();
  });

  test("skipped → no answer field", async () => {
    const r = await rig(async () => ({ allowed: false }));
    r.send(question());
    await until(() => r.calls.length === 1);
    expect(r.calls).toEqual([
      { method: Method.AnswerQuestion, params: { sessionId: "s1", requestId: "q1" } },
    ]);
    r.client.close();
  });

  test("answered elsewhere first (PermissionNotPending): the words are handed back, no error", async () => {
    const lost: string[] = [];
    const r = await rig(
      async () => ({ allowed: true, message: "main", onAnswerLost: (cause) => lost.push(cause) }),
      () => {
        throw new RpcError(DomainErrorCode.PermissionNotPending, "question not pending");
      },
    );
    r.send(question());
    await until(() => lost.length === 1);
    expect(lost).toEqual(["settled"]);
    expect(r.errors).toEqual([]);
    r.client.close();
  });
});
