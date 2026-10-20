import { describe, expect, test } from "bun:test";
import type { PermissionRequestUpdate } from "@tentacle/protocol";
import { PermissionRouter, type RouterAction } from "../src/permission-router.ts";

const req = (
  requestId: string,
  over: Partial<PermissionRequestUpdate> = {},
): PermissionRequestUpdate => ({
  type: "permission_request",
  requestId,
  toolCallId: "c1",
  tool: "shell",
  title: "Run a shell command",
  explanation: `cmd-${requestId}`,
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ],
  ...over,
});

/** Actions, compacted to what a test reads: `prompt S/r1`, `abort S/r1`, `send S/r1 allow_once`. */
const show = (actions: readonly RouterAction[]): string[] =>
  actions.map((a) =>
    a.kind === "send"
      ? `send ${a.sessionId}/${a.requestId} ${a.optionId}`
      : `${a.kind} ${a.sessionId}/${a.requestId}`,
  );

describe("PermissionRouter (pure)", () => {
  test("a request prompts; it rebuilds the gate's request (tool, detail, suggestion)", () => {
    const r = new PermissionRouter();
    const actions = r.request("S", req("r1", { suggestion: { prefix: "git status" } }));
    expect(show(actions)).toEqual(["prompt S/r1"]);
    const [prompt] = actions;
    expect(prompt?.kind === "prompt" && prompt.request).toEqual({
      tool: "shell",
      level: "ask",
      title: "Run a shell command",
      detail: "cmd-r1",
      input: {},
      suggestion: { prefix: "git status" },
    });
  });

  test("one dialog at a time: a second request queues (FIFO) and is prompted when the first is answered", () => {
    const r = new PermissionRouter();
    expect(show(r.request("S", req("r1")))).toEqual(["prompt S/r1"]);
    expect(show(r.request("S", req("r2")))).toEqual([]);
    expect(show(r.answered("S", "r1", { allowed: true, scope: "once" }))).toEqual([
      "send S/r1 allow_once",
      "prompt S/r2",
    ]);
  });

  test("a replayed request (current, queued or already resolved) is ignored", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    r.request("S", req("r2"));
    expect(show(r.request("S", req("r1")))).toEqual([]);
    expect(show(r.request("S", req("r2")))).toEqual([]);
    r.resolved("S", "r1");
    expect(show(r.request("S", req("r1")))).toEqual([]);
  });

  test("resolved elsewhere: the on-screen prompt is aborted and the next one shown; a queued one is dropped", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    r.request("S", req("r2"));
    r.request("S", req("r3"));
    expect(show(r.resolved("S", "r2"))).toEqual([]);
    expect(show(r.resolved("S", "r1"))).toEqual(["abort S/r1", "prompt S/r3"]);
  });

  test("the answer of an aborted prompt is not sent", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    r.resolved("S", "r1");
    expect(show(r.answered("S", "r1", { allowed: true, scope: "once" }))).toEqual([]);
  });

  test("answers map to the offered options; a dismissed prompt sends nothing and stays re-offerable", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    expect(show(r.answered("S", "r1", { allowed: true, scope: "session" }))).toEqual([
      "send S/r1 allow_always",
    ]);
    r.request("S", req("r2"));
    expect(show(r.answered("S", "r2", { allowed: false }))).toEqual(["send S/r2 reject_once"]);
    r.request("S", req("r3"));
    expect(show(r.answered("S", "r3", { allowed: false, dismissed: true }))).toEqual([]);
    // Still pending daemon-side: a replay of it prompts again.
    expect(show(r.request("S", req("r3")))).toEqual(["prompt S/r3"]);
  });

  test("an answer the request did not offer is not sent, and is reported (a daemon that offers less)", () => {
    const r = new PermissionRouter();
    r.request(
      "S",
      req("r1", { options: [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }] }),
    );
    expect(show(r.answered("S", "r1", { allowed: true, scope: "session" }))).toEqual([
      "unoffered S/r1",
    ]);
  });

  test("display-only (pod-trust): a resolved event never sends, never approves anything later", () => {
    // Mutation: cache an `allow_always` outcome and auto-answer later requests → red.
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    expect(show(r.resolved("S", "r1"))).toEqual(["abort S/r1"]);
    expect(show(r.resolved("S", "unknown"))).toEqual([]);
    expect(show(r.request("S", req("r2")))).toEqual(["prompt S/r2"]);
  });

  test("session closed / connection closed: abort what is on screen, drop what is queued", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    r.request("T", req("t1"));
    r.request("S", req("r2"));
    expect(show(r.sessionClosed("S"))).toEqual(["abort S/r1", "prompt T/t1"]);
    expect(show(r.connectionClosed())).toEqual(["abort T/t1"]);
    expect(show(r.answered("T", "t1", { allowed: true, scope: "once" }))).toEqual([]);
  });

  test("ids are per session: the same requestId in two sessions are two requests", () => {
    const r = new PermissionRouter();
    r.request("S", req("x"));
    expect(show(r.request("T", req("x")))).toEqual([]);
    expect(show(r.answered("S", "x", { allowed: false }))).toEqual([
      "send S/x reject_once",
      "prompt T/x",
    ]);
  });
});
