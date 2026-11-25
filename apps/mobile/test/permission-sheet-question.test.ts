/**
 * docs/feat/a2a-client.md C10 / a2c-6: the phone's native sheet for a remote
 * agent's `question` and a model-proposed `agent_add`. Each test names its
 * mutation (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest, PermissionResponse } from "@tentacle/core";
import { A2A_ADD_AGENT_TOOL } from "@tentacle/core";
import { createPermissionSheet, replyCopy, sheetOptions } from "../src/permission-sheet.ts";

const question = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  kind: "question",
  tool: "question",
  level: "ask",
  title: "reviewer asks",
  detail: "Remote question (https://a.example): which branch?",
  input: {},
  reply: { maxChars: 2000 },
  ...over,
});

const addAgent = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  kind: "agent_add",
  tool: A2A_ADD_AGENT_TOOL,
  level: "ask",
  title: "Add a remote agent",
  input: {},
  reply: { maxChars: 2000 },
  ...over,
});

function rig() {
  const sheet = createPermissionSheet({ now: () => 1000, armMs: 0 });
  const ask = (req: PermissionRequest): Promise<PermissionResponse> =>
    sheet.requester(req, { signal: new AbortController().signal });
  return { sheet, ask };
}

describe("question mode", () => {
  test("options: Answer… (reply) and Skip only — never an approval", () => {
    const opts = sheetOptions(question());
    expect(opts.map((o) => [o.optionId, o.label])).toEqual([
      ["reply", "Answer…"],
      ["reject_once", "Skip"],
    ]);
  });

  test("without a reply bound only Skip is offered", () => {
    const opts = sheetOptions(question({ reply: undefined }));
    expect(opts.map((o) => o.optionId)).toEqual(["reject_once"]);
  });

  test("an answer is allowed:true + message with NO scope", async () => {
    const { sheet, ask } = rig();
    const p = ask(question());
    expect(sheet.answer("reply")).toBe("typing");
    sheet.setReplyText("main");
    expect(sheet.sendReply()).toBe("sent");
    const response = await p;
    expect(response.allowed).toBe(true);
    expect(response.message).toBe("main");
    expect(response.scope).toBeUndefined();
  });

  test("Skip is allowed:false with no message", async () => {
    const { sheet, ask } = rig();
    const p = ask(question());
    expect(sheet.answer("reject_once")).toBe("sent");
    const response = await p;
    expect(response.allowed).toBe(false);
    expect(response.message).toBeUndefined();
  });

  test("a blank answer is never sent (not an empty answer, not a Skip)", () => {
    const { sheet, ask } = rig();
    void ask(question());
    sheet.answer("reply");
    sheet.setReplyText("   ");
    expect(sheet.sendReply()).toBe("ignored");
    expect(sheet.asking).toBe(true);
  });

  test("allow_once / allow_always are not offered, so a tap is ignored", () => {
    const { sheet, ask } = rig();
    void ask(question());
    expect(sheet.answer("allow_once")).toBe("ignored");
    expect(sheet.answer("allow_always")).toBe("ignored");
    expect(sheet.asking).toBe(true);
  });

  test("copy says answer, not refusal", () => {
    expect(replyCopy(question())).toEqual({ placeholder: "Your answer", send: "Send answer" });
    expect(replyCopy(addAgent()).send).toBe("Send reply");
  });
});

describe("agent_add", () => {
  test("once-only: Yes for this session, No, talk about it; no always", () => {
    const opts = sheetOptions(addAgent());
    expect(opts.map((o) => [o.optionId, o.label])).toEqual([
      ["allow_once", "Yes, for this session"],
      ["reject_once", "No"],
      ["reply", "No, let's talk about it"],
    ]);
  });

  test("allow_always is ignored", () => {
    const { sheet, ask } = rig();
    void ask(addAgent());
    expect(sheet.answer("allow_always")).toBe("ignored");
  });

  test("talk about it stays a refusal with words", async () => {
    const { sheet, ask } = rig();
    const p = ask(addAgent());
    sheet.answer("reply");
    sheet.setReplyText("use the other one");
    sheet.sendReply();
    expect(await p).toMatchObject({ allowed: false, message: "use the other one" });
  });
});
