/**
 * docs/feat/a2a.md slice S5: the protocol-neutral ask policy of an external
 * caller (`external/asks.ts`). Pure. Each test names its mutation (§9).
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequestUpdate } from "@tentacle/protocol";
import {
  type PendingAsk,
  askIsOwn,
  askOf,
  callerMayAnswer,
  resolveCallerAnswer,
} from "../src/external/asks.ts";

const OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Always", kind: "allow_always" },
  { optionId: "reject_once", name: "Deny", kind: "reject_once" },
] as const;

const update = (over: Partial<PermissionRequestUpdate> = {}): PermissionRequestUpdate => ({
  type: "permission_request",
  requestId: "r1",
  toolCallId: "c1",
  tool: "run",
  title: "Run it",
  options: [...OPTIONS],
  reply: { maxChars: 10 },
  ...over,
});

const ask = (over: Partial<PendingAsk> = {}): PendingAsk => ({
  requestId: "r1",
  title: "Run it",
  kind: "tool",
  options: [...OPTIONS],
  ...over,
});

describe("external asks", () => {
  // Mutation: `askIsOwn` → true always → a background ask of a run the OWNER
  // started (agent.id, no turnId) becomes the caller's → red.
  test("own: only the task's turn's asks (no marker, or its turnId)", () => {
    expect(askIsOwn(update(), "t1")).toBe(true);
    expect(askIsOwn(update({ agent: { type: "general", description: "fg" } }), "t1")).toBe(true);
    expect(
      askIsOwn(update({ agent: { type: "workflow", description: "w/s", id: "wf-1.s" } }), "t1"),
    ).toBe(false);
    expect(
      askIsOwn(update({ turnId: "t1", agent: { type: "x", description: "bg", id: "sa-1" } }), "t1"),
    ).toBe(true);
    expect(askIsOwn(update({ turnId: "t2" }), "t1")).toBe(false);
  });

  // Mutation: map every wire ask to `tool` → the workflow approval becomes answerable → red.
  test("kind: the client's reverse mapping; not own → no kind (owner-only)", () => {
    expect(askOf(update(), true).kind).toBe("tool");
    expect(askOf(update({ tool: "workflow_approve" }), true).kind).toBe("workflow_approve");
    expect(askOf(update(), false).kind).toBeUndefined();
    expect(askOf(update(), true).replyMax).toBe(10);
    expect(askOf(update({ reply: undefined }), true).replyMax).toBeUndefined();
  });

  // Mutation: drop the `browser_action` branch of `askOf` (→ kind `tool`), or
  // mark it `once` in core's table → the caller approves a click in the
  // owner's Chrome → red (docs/feat/browser-inspect.md, Review B5 finding 1).
  test("a browser action ask is the owner's only, in every mode", () => {
    const own = askOf(update({ tool: "browser_action" }), true);
    expect(own.kind).toBe("browser_action");
    expect(callerMayAnswer(own, "both")).toBe(false);
    expect(callerMayAnswer(own, "owner")).toBe(false);
  });

  // Mutation: drop the `app_publish` branch of `askOf` (→ kind `tool`) → an
  // external caller publishes a public page → red (session apps D3).
  test("a publish ask is the owner's only, in every mode", () => {
    const own = askOf(update({ tool: "app_publish" }), true);
    expect(own.kind).toBe("app_publish");
    expect(callerMayAnswer(own, "both")).toBe(false);
    expect(callerMayAnswer(own, "owner")).toBe(false);
  });

  // Mutation (the plan's): route by requestId without the kind check → the
  // owner-only and the unattributed asks resolve → red.
  test("resolve: only a caller-answerable pending ask, only its *_once option", () => {
    const pending = [
      ask(),
      ask({ requestId: "wf", kind: "workflow_approve" }),
      ask({ requestId: "bg", kind: undefined }),
    ];
    expect(resolveCallerAnswer({ requestId: "r1", decision: "allow" }, pending, "both")).toEqual({
      requestId: "r1",
      optionId: "allow_once",
    });
    expect(resolveCallerAnswer({ requestId: "r1", decision: "deny" }, pending, "both")).toEqual({
      requestId: "r1",
      optionId: "reject_once",
    });
    for (const requestId of ["wf", "bg", "gone"]) {
      expect(resolveCallerAnswer({ requestId, decision: "allow" }, pending, "both")).toBeNull();
    }
    expect(
      resolveCallerAnswer({ requestId: "r1", decision: "allow" }, pending, "owner"),
    ).toBeNull();
    const noOnce = [ask({ options: [OPTIONS[1]] })];
    expect(resolveCallerAnswer({ requestId: "r1", decision: "allow" }, noOnce, "both")).toBeNull();
  });

  // Mutation: carry the message on an allow, or unclamped → red.
  test("reply: only with a deny, only when the ask takes one; cleaned and clamped", () => {
    const pending = [ask({ replyMax: 10 }), ask({ requestId: "r2" })];
    expect(
      resolveCallerAnswer(
        { requestId: "r1", decision: "deny", message: " no\u0007 way, use x " },
        pending,
        "both",
      ),
    ).toEqual({ requestId: "r1", optionId: "reject_once", message: "no way, us" });
    expect(
      resolveCallerAnswer({ requestId: "r1", decision: "allow", message: "fine" }, pending, "both"),
    ).toEqual({ requestId: "r1", optionId: "allow_once" });
    expect(
      resolveCallerAnswer({ requestId: "r1", decision: "deny", message: "  \n " }, pending, "both"),
    ).toEqual({ requestId: "r1", optionId: "reject_once" });
    expect(
      resolveCallerAnswer({ requestId: "r2", decision: "deny", message: "no" }, pending, "both"),
    ).toEqual({ requestId: "r2", optionId: "reject_once" });
  });
});
