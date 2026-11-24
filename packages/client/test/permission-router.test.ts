import { describe, expect, test } from "bun:test";
import { DISMISSED } from "@tentacle/core";
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

// docs/feat/session-hop-ux: the load-bearing wire property. `kind` and `hopAuto`
// are LAPTOP-INTERNAL — a daemon cannot forge either, and `auto` never travels
// back — which is what lets auto-accept answer a move from facts only the laptop
// holds (AGENTS §7, single broker + "a pod is not trusted").
describe("the hop's laptop-internal fields never cross the wire", () => {
  test("toPermissionRequest yields no `kind` and no `hopAuto`, whatever the update says", () => {
    const r = new PermissionRouter();
    // A hostile update that TRIES to carry them (an unknown field is stripped).
    const [action] = r.request(
      "S",
      req("r1", { kind: "session_hop", hopAuto: true } as Partial<PermissionRequestUpdate>),
    );
    const request = action?.kind === "prompt" ? action.request : undefined;
    expect(request).toBeDefined();
    expect(request?.kind).toBeUndefined();
    expect(request?.hopAuto).toBeUndefined();
  });

  test("an answer's `send` carries only optionId and message — `auto` never leaves", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    const sent = r
      .answered("S", "r1", { allowed: true, scope: "once", auto: true })
      .filter((a) => a.kind === "send");
    expect(sent).toHaveLength(1);
    const action = sent[0];
    if (action?.kind !== "send") {
      throw new Error("expected a send");
    }
    // The WHOLE shape: a new field here would be a wire (and protocol) change.
    expect(Object.keys(action).sort()).toEqual(["kind", "optionId", "requestId", "sessionId"]);
  });
});

describe("a background child's ask names its spawning turn (T34)", () => {
  test("the update's turnId wins over the stream's; the agent id rides through", () => {
    const r = new PermissionRouter();
    const [action] = r.request(
      "S",
      req("r1", { turnId: "T-spawn", agent: { type: "general", description: "d", id: "sa-1" } }),
      "T-stream",
    );
    expect(action?.kind === "prompt" ? action.turnId : undefined).toBe("T-spawn");
    expect(action?.kind === "prompt" ? action.agent : undefined).toEqual({
      type: "general",
      description: "d",
      id: "sa-1",
    });
    // Without it, the stream's turn as before.
    const r2 = new PermissionRouter();
    const [plain] = r2.request("S", req("r2"), "T-stream");
    expect(plain?.kind === "prompt" ? plain.turnId : undefined).toBe("T-stream");
  });
});

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
  test("retainOnly (resync): keeps what the replay re-offers, withdraws the rest; kept ids are not prompted twice", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1")); // on screen
    r.request("S", req("r2")); // queued
    r.request("T", req("t1")); // another session: untouched
    // The resync replay re-offers only r2 (r1 was answered while away).
    expect(show(r.retainOnly("S", ["r2"]))).toEqual(["abort S/r1", "prompt S/r2"]);
    // The replay then re-offers r2: deduped (it is on screen), never a second dialog.
    expect(show(r.request("S", req("r2")))).toEqual([]);
    // T's queued request is still there, after S/r2.
    expect(show(r.answered("S", "r2", { allowed: false }))).toEqual([
      "send S/r2 reject_once",
      "prompt T/t1",
    ]);
  });

  test("retainOnly keeps the dialog when the replay re-offers it (a drop with no change)", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    expect(show(r.retainOnly("S", ["r1"]))).toEqual([]);
    expect(show(r.request("S", req("r1")))).toEqual([]);
    // Withdrawing everything (a serve restart re-asks under a fresh id).
    expect(show(r.retainOnly("S", []))).toEqual(["abort S/r1"]);
    expect(show(r.request("S", req("r1b")))).toEqual(["prompt S/r1b"]);
  });
  test("an answered request re-offered by a replay before its permission_resolved is not prompted again", () => {
    // The answer is in flight (or held while the link is down); a resync replay
    // re-offers the request. Mutation: drop the `answeredIds` check → a second dialog.
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    expect(show(r.answered("S", "r1", { allowed: true, scope: "once" }))).toEqual([
      "send S/r1 allow_once",
    ]);
    expect(show(r.retainOnly("S", ["r1"]))).toEqual([]);
    expect(show(r.request("S", req("r1")))).toEqual([]);
    expect(show(r.resolved("S", "r1"))).toEqual([]);
    // An answer that failed to deliver is offered again by a later replay.
    r.request("S", req("r2"));
    r.answered("S", "r2", { allowed: false });
    r.answerFailed("S", "r2");
    expect(show(r.request("S", req("r2")))).toEqual(["prompt S/r2"]);
    // A dismissed prompt (no decision) was never "answered": re-offered → prompted.
    r.answered("S", "r2", DISMISSED);
    expect(show(r.request("S", req("r2")))).toEqual(["prompt S/r2"]);
  });
});

// docs/feat/tui-foreign-turns.md B4: the wire request has no turn id; the
// client attributes it to the turn it was raised in, kept until it is asked.
describe("PermissionRouter — the turn a request belongs to", () => {
  test("the prompt carries its turn; a request queued behind another keeps its own", () => {
    const r = new PermissionRouter();
    const first = r.request("S", req("r1"), "X");
    expect(first[0]?.kind === "prompt" && first[0].turnId).toBe("X");
    expect(r.request("S", req("r2"), "Y")).toEqual([]);
    const later = r.answered("S", "r1", { allowed: true });
    const prompt = later.find((a) => a.kind === "prompt");
    expect(prompt?.kind === "prompt" && prompt.requestId).toBe("r2");
    expect(prompt?.kind === "prompt" && prompt.turnId).toBe("Y");
  });

  test("no turn (null): the prompt carries none", () => {
    const r = new PermissionRouter();
    const [prompt] = r.request("S", req("r1"), null);
    expect(prompt?.kind === "prompt" && "turnId" in prompt).toBe(false);
  });
});

// docs/feat/permission-call-attribution.md T9: which sub-agent asked rides to
// the laptop requester (display only — no decision here reads it).
describe("PermissionRouter — the sub-agent a request comes from", () => {
  test("the prompt carries the update's agent; a request queued behind another keeps its own", () => {
    const r = new PermissionRouter();
    const agent = { type: "explore", description: "find callers" };
    const [first] = r.request("S", req("r1", { agent }), "X");
    expect(first?.kind === "prompt" && first.agent).toEqual(agent);
    r.request("S", req("r2"), "X");
    const prompt = r.answered("S", "r1", { allowed: true }).find((a) => a.kind === "prompt");
    expect(prompt?.kind === "prompt" && prompt.requestId).toBe("r2");
    expect(prompt?.kind === "prompt" && "agent" in prompt).toBe(false);
  });

  test("a pod's label is stripped of control characters and bounded (T-L)", () => {
    const r = new PermissionRouter();
    const agent = { type: "ex\u001b[2Jplore", description: `a\nb${"x".repeat(500)}` };
    const [prompt] = r.request("S", req("r1", { agent }), "X");
    const seen = prompt?.kind === "prompt" ? prompt.agent : undefined;
    expect(seen?.type).toBe("ex [2Jplore");
    expect(seen?.description.startsWith("a b")).toBe(true);
    expect(seen?.description.length).toBe(200);
    expect(seen?.description.endsWith("…")).toBe(true);
  });
});

// docs/fix/mobile-ask-surfaces.md D2: the workflow origin rides to the requester,
// bounded (a pod could forge it), display only.
describe("PermissionRouter — the workflow an ask belongs to", () => {
  test("the prompt carries the update's workflow, bounded and stripped", () => {
    const r = new PermissionRouter();
    const workflow = {
      name: `wf\u001b[2J${"x".repeat(500)}`,
      runId: "wf-1",
      stepId: "gen\nerate",
      index: 1,
      count: 5,
    };
    const [prompt] = r.request("S", req("r1", { workflow }), "X");
    const seen = prompt?.kind === "prompt" ? prompt.workflow : undefined;
    expect(seen?.name.startsWith("wf [2J")).toBe(true);
    expect(seen?.name.length).toBe(200);
    expect(seen?.runId).toBe("wf-1");
    expect(seen?.stepId).toBe("gen erate");
    expect(seen?.index).toBe(1);
    expect(seen?.count).toBe(5);
  });

  test("absent stays absent; a name-only workflow carries no step fields", () => {
    const r = new PermissionRouter();
    const [a] = r.request("S", req("r1"), "X");
    expect(a?.kind === "prompt" && "workflow" in a).toBe(false);
    r.answered("S", "r1", { allowed: true });
    const [b] = r.request("S", req("r2", { workflow: { name: "wf" } }), "X");
    expect(b?.kind === "prompt" && b.workflow).toEqual({ name: "wf" });
  });

  test("a non-finite index/count from a pod is dropped, not forwarded", () => {
    const r = new PermissionRouter();
    const [p] = r.request(
      "S",
      req("r1", { workflow: { name: "wf", index: Number.NaN, count: Number.POSITIVE_INFINITY } }),
      "X",
    );
    expect(p?.kind === "prompt" && p.workflow).toEqual({ name: "wf" });
  });
});

// docs/feat/mobile-notifications.md Design 5: an answer given OUTSIDE the prompt
// (an iPhone notification's Approve / Deny / Reply) settles a request BY ID.
// `answered` cannot serve it: it accepts only the request that is `current`, and
// the phone's notification path never shows a prompt at all.
describe("PermissionRouter.answerById (a notification's answer)", () => {
  const sends = (actions: readonly RouterAction[]) => actions.filter((a) => a.kind === "send");

  test("a QUEUED request is answered; the one on screen is untouched", () => {
    // Mutation: implement it as `answered` (only `current`) → red: no send.
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    r.request("S", req("r2"));
    expect(sends(r.answerById("S", "r2", { allowed: true, scope: "once" }))).toEqual([
      { kind: "send", sessionId: "S", requestId: "r2", optionId: "allow_once" },
    ]);
    // r1 is still the prompt, and answering it later still works.
    expect(sends(r.answered("S", "r1", { allowed: false }))).toEqual([
      { kind: "send", sessionId: "S", requestId: "r1", optionId: "reject_once" },
    ]);
  });

  test("the CURRENT request: the open prompt is withdrawn first, then the send", () => {
    // Mutation: drop the `abort` → the prompt stays on screen after the answer,
    // and its late DISMISSED would be the only thing left to act on.
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    expect(r.answerById("S", "r1", { allowed: true, scope: "once" })).toEqual([
      { kind: "abort", sessionId: "S", requestId: "r1" },
      { kind: "send", sessionId: "S", requestId: "r1", optionId: "allow_once" },
    ]);
    // The prompt's late DISMISSED lands AFTER the answer: nothing is sent.
    expect(r.answered("S", "r1", { dismissed: true, allowed: false })).toEqual([]);
  });

  test("an UNOFFERED option settles nothing: the request stays held (mutation: consume it → red)", () => {
    const r = new PermissionRouter();
    r.request(
      "S",
      req("r1", { options: [{ optionId: "allow_once", name: "A", kind: "allow_once" }] }),
    );
    expect(r.answerById("S", "r1", { allowed: false })).toEqual([
      { kind: "unoffered", sessionId: "S", requestId: "r1", optionId: "reject_once" },
    ]);
    // Still answerable in the app: a scope-less approval is offered.
    expect(sends(r.answerById("S", "r1", { allowed: true, scope: "once" }))).toEqual([
      { kind: "send", sessionId: "S", requestId: "r1", optionId: "allow_once" },
    ]);
  });

  test("a reply rides only where the daemon takes one", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1", { reply: { maxChars: 100 } }));
    expect(sends(r.answerById("S", "r1", { allowed: false, message: " use bun " }))).toEqual([
      {
        kind: "send",
        sessionId: "S",
        requestId: "r1",
        optionId: "reject_once",
        message: "use bun",
      },
    ]);
    const r2 = new PermissionRouter();
    r2.request("S", req("r1"));
    expect(r2.answerById("S", "r1", { allowed: false, message: "no" })).toEqual([
      { kind: "unreplyable", sessionId: "S", requestId: "r1" },
    ]);
    // …and it is still answerable (never a bare No behind the person's back).
    expect(sends(r2.answerById("S", "r1", { allowed: false }))).toEqual([
      { kind: "send", sessionId: "S", requestId: "r1", optionId: "reject_once" },
    ]);
  });

  test("unknown, resolved, or already answered here: nothing is sent", () => {
    // Mutation: drop the `answeredIds` check → a duplicate tap sends twice
    // (harmless daemon-side, but the phone would report a false failure).
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    expect(r.answerById("S", "nope", { allowed: true })).toEqual([]);
    r.request("S", req("r2"));
    r.resolved("S", "r2");
    expect(r.answerById("S", "r2", { allowed: true })).toEqual([]);
    r.answerById("S", "r1", { allowed: true, scope: "once" });
    expect(r.answerById("S", "r1", { allowed: true, scope: "once" })).toEqual([]);
  });
});

// docs/feat/mobile-notifications.md N1/N8: what the router HOLDS (read-only), so
// the notification path can name an ask it means to settle.
describe("PermissionRouter.heldIds", () => {
  test("the prompted ask first, then the queued ones, per session", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    r.request("S", req("r2"));
    r.request("T", req("t1"));
    expect(r.heldIds("S")).toEqual(["r1", "r2"]);
    expect(r.heldIds("T")).toEqual(["t1"]);
    expect(r.heldIds("X")).toEqual([]);
  });

  test("an answered or resolved ask leaves the list; a queued answer promotes the next", () => {
    const r = new PermissionRouter();
    r.request("S", req("r1"));
    r.request("S", req("r2"));
    r.answered("S", "r1", { allowed: true, scope: "once" });
    expect(r.heldIds("S")).toEqual(["r2"]);
    r.resolved("S", "r2");
    expect(r.heldIds("S")).toEqual([]);
  });
});
