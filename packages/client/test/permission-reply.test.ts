import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionResponse } from "@tentacle/core";
import {
  JsonRpcErrorCode,
  Method,
  Notification,
  PROTOCOL_VERSION,
  type PermissionRequestUpdate,
} from "@tentacle/protocol";
import { DomainErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { updateToEvent } from "../src/mapping.ts";
import { answerLostCause, normalizePermissionReply } from "../src/permission-map.ts";
import { PermissionRouter, type RouterAction } from "../src/permission-router.ts";
import { RemoteClient } from "../src/remote-client.ts";
import { SessionLostError } from "../src/session-lost.ts";

// docs/feat/permission-reply.md: "No, let's talk about it" at the client — a
// reply is sent only when the daemon offered one, and the person's words are
// never lost silently.

const OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject_once", name: "Deny", kind: "reject_once" },
] as const;

const req = (requestId: string, reply = true): PermissionRequestUpdate => ({
  type: "permission_request",
  requestId,
  toolCallId: "c1",
  tool: "shell",
  title: "Run a shell command",
  explanation: `cmd-${requestId}`,
  options: [...OPTIONS],
  ...(reply ? { reply: { maxChars: 2000 } } : {}),
});

const sends = (actions: readonly RouterAction[]) => actions.filter((a) => a.kind === "send");

describe("normalizePermissionReply (pure)", () => {
  test("CRLF/CR → LF, controls dropped but \\n \\t, trimmed, clamped; empty → null", () => {
    expect(normalizePermissionReply("a\r\nb\rc", 2000)).toBe("a\nb\nc");
    expect(normalizePermissionReply("a\u001b[2Jb\u0085c\u007fd\te", 2000)).toBe("a[2Jbcd\te");
    expect(normalizePermissionReply("  \n hi \n ", 2000)).toBe("hi");
    expect(normalizePermissionReply("abcdef", 3)).toBe("abc");
    // A pod may advertise anything: never above the wire's bound.
    expect(normalizePermissionReply("x".repeat(5000), 10 ** 9)).toBe("x".repeat(2000));
    expect(normalizePermissionReply(" \n\t ", 2000)).toBeNull();
    expect(normalizePermissionReply("\u001b", 2000)).toBeNull();
    // Trimmed, then clamped, then the clamp's own trailing blanks trimmed.
    expect(normalizePermissionReply("  a   b", 3)).toBe("a");
  });
});

describe("answerLostCause (pure, fix round 1 F2)", () => {
  test("each failed send names its true cause", () => {
    expect(answerLostCause(new RpcError(DomainErrorCode.PermissionNotPending, "not pending"))).toBe(
      "settled",
    );
    expect(answerLostCause(new SessionLostError())).toBe("session-lost");
    expect(answerLostCause(new RpcError(JsonRpcErrorCode.InternalError, "boom"))).toBe("failed");
    expect(answerLostCause(new Error("connection dropped"))).toBe("failed");
  });
});

describe("PermissionRouter with a reply", () => {
  test("the prompt's request carries the daemon's reply report", () => {
    const r = new PermissionRouter();
    const [prompt] = r.request("S", req("r1"));
    expect(prompt?.kind === "prompt" ? prompt.request.reply : "no prompt").toEqual({
      maxChars: 2000,
    });
    const r2 = new PermissionRouter();
    const [plain] = r2.request("S", req("r1", false));
    expect(plain?.kind === "prompt" && "reply" in plain.request).toBe(false);
  });

  test("a refusal with a message is sent with it (normalized)", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    expect(sends(r.answered("S", "r1", { allowed: false, message: " try\r\nbun " }))).toEqual([
      {
        kind: "send",
        sessionId: "S",
        requestId: "r1",
        optionId: "reject_once",
        message: "try\nbun",
      },
    ]);
  });

  test("a blank message is a plain No; a message on an approval is never sent", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    r.request("S", req("r2"));
    expect(sends(r.answered("S", "r1", { allowed: false, message: "  " }))).toEqual([
      { kind: "send", sessionId: "S", requestId: "r1", optionId: "reject_once" },
    ]);
    expect(sends(r.answered("S", "r2", { allowed: true, scope: "once", message: "x" }))).toEqual([
      { kind: "send", sessionId: "S", requestId: "r2", optionId: "allow_once" },
    ]);
  });

  test("a message for a request that did not offer a reply: NOT sent (no bare No behind the user's back)", () => {
    // Mutation (c): strip the message and send a plain reject → red.
    const r = new PermissionRouter();
    r.request("S", req("r1", false));
    const actions = r.answered("S", "r1", { allowed: false, message: "why?" });
    expect(sends(actions)).toEqual([]);
    expect(actions.filter((a) => a.kind === "unreplyable")).toEqual([
      { kind: "unreplyable", sessionId: "S", requestId: "r1" },
    ]);
  });
});

describe("mapping: denialReply rides the result", () => {
  test("from the update's field, never from the content", () => {
    const update = (extra: object) => ({
      type: "tool_call_update" as const,
      toolCallId: "c1",
      status: "failed" as const,
      content: [{ type: "text" as const, text: "Permission denied … The user replied:\nwhy?\n…" }],
      ...extra,
    });
    const names = new Map([["c1", "shell"]]);
    const ev = updateToEvent(update({ denialReply: "why?" }), names);
    expect(ev?.type === "tool_result" ? ev.result.denialReply : undefined).toBe("why?");
    const older = updateToEvent(update({}), names);
    expect(older?.type === "tool_result" && "denialReply" in older.result).toBe(false);
  });
});

describe("RemoteClient: the reply goes out, or comes back", () => {
  const settle = () => new Promise((r) => setTimeout(r, 10));

  async function rig(
    answer: (req: { reply?: unknown }) => Promise<PermissionResponse>,
    resolveWith: (params: unknown) => unknown = () => ({}),
  ) {
    const [daemonCh, clientCh] = createChannelPair();
    const resolves: unknown[] = [];
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
        if (method === Method.ResolvePermission) {
          resolves.push(params);
          return resolveWith(params);
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
    });
    const errors: Error[] = [];
    const client = new RemoteClient(clientCh, new PermissionBroker(answer), undefined, {
      onError: (e) => errors.push(e),
    });
    await client.initialize();
    await client.openSession(undefined, undefined, "s1");
    const send = (update: Record<string, unknown>) =>
      daemon.notify(Notification.SessionUpdate, {
        sessionId: "s1",
        seq: ++seq,
        mandatory: true,
        update,
      });
    return { client, resolves, errors, send };
  }

  test("the message rides session/resolve_permission when the request offered a reply", async () => {
    // Mutation (a): drop `message` from the send params → red.
    const lost: string[] = [];
    const r = await rig(async () => ({
      allowed: false,
      message: "try bun run build",
      onAnswerLost: (cause) => lost.push(cause),
    }));
    r.send(req("r1"));
    await settle();
    expect(r.resolves).toEqual([
      { sessionId: "s1", requestId: "r1", optionId: "reject_once", message: "try bun run build" },
    ]);
    expect(lost).toHaveLength(0);
    expect(r.errors).toEqual([]);
    r.client.close();
  });

  test("lost to another answer (PermissionNotPending): onAnswerLost once, still no error", async () => {
    // Mutation (g): skip `onAnswerLost` on PermissionNotPending → red.
    const lost: string[] = [];
    const r = await rig(
      async () => ({ allowed: false, message: "why?", onAnswerLost: (cause) => lost.push(cause) }),
      () => {
        throw new RpcError(DomainErrorCode.PermissionNotPending, "permission request not pending");
      },
    );
    r.send(req("r1"));
    await settle();
    expect(lost).toEqual(["settled"]);
    expect(r.errors).toEqual([]);
    r.client.close();
  });

  test("a real failure: onAnswerLost and onError (the request may be offered again)", async () => {
    const lost: string[] = [];
    const r = await rig(
      async () => ({ allowed: false, message: "why?", onAnswerLost: (cause) => lost.push(cause) }),
      () => {
        throw new RpcError(JsonRpcErrorCode.InternalError, "boom");
      },
    );
    r.send(req("r1"));
    await settle();
    expect(lost).toEqual(["failed"]);
    expect(r.errors.map((e) => e.message)).toEqual(["boom"]);
    r.client.close();
  });

  test("a plain answer that loses never calls onAnswerLost", async () => {
    const lost: string[] = [];
    const r = await rig(
      async () => ({ allowed: false, onAnswerLost: (cause) => lost.push(cause) }),
      () => {
        throw new RpcError(DomainErrorCode.PermissionNotPending, "permission request not pending");
      },
    );
    r.send(req("r1"));
    await settle();
    expect(lost).toHaveLength(0);
    r.client.close();
  });

  test("an older daemon (no reply offered): nothing sent, the words handed back, reported", async () => {
    const lost: string[] = [];
    const r = await rig(async () => ({
      allowed: false,
      message: "why?",
      onAnswerLost: (cause) => lost.push(cause),
    }));
    r.send(req("r1", false));
    await settle();
    expect(r.resolves).toEqual([]);
    expect(lost).toEqual(["unreplyable"]);
    expect(r.errors).toHaveLength(1);
    r.client.close();
  });

  test("withdrawn while the answer was on its way: not sent, the words handed back", async () => {
    let answer: (r: PermissionResponse) => void = () => {};
    const lost: string[] = [];
    const r = await rig(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    r.send(req("r1"));
    await settle();
    // Another device won; the withdrawal is routed BEFORE this answer lands
    // (the requester returned after its signal aborted).
    r.send({
      type: "permission_resolved",
      requestId: "r1",
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    await settle();
    answer({ allowed: false, message: "why?", onAnswerLost: (cause) => lost.push(cause) });
    await settle();
    expect(r.resolves).toEqual([]);
    expect(lost).toEqual(["settled"]);
    r.client.close();
  });
});
