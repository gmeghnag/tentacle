import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@tentacle/core";
import type { Key } from "ink";
import {
  type DialogContext,
  MENU,
  type ReplyMode,
  stepPermissionKey,
} from "../src/permission-reply.ts";
import { buildPermissionChoices } from "../src/permission-ui.ts";

// docs/feat/a2a-client.md C10 / a2c-5: a remote agent's question and a
// model-proposed agent each get their own menu; the answer is TEXT, never a grant.

const key = (over: Partial<Key> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  ...over,
});

const question: PermissionRequest = {
  kind: "question",
  tool: "a2a:x",
  level: "ask",
  title: "x asks",
  detail: "Remote question (x): which env?",
  input: {},
  reply: { maxChars: 4000 },
};
const addAgent: PermissionRequest = {
  kind: "agent_add",
  tool: "a2a_add_agent",
  level: "ask",
  title: "Add agent",
  input: {},
  reply: { maxChars: 2000 },
};
const ctx = (req: PermissionRequest, selected = 0): DialogContext => ({
  choices: buildPermissionChoices(req),
  selected,
  maxChars: 4000,
  armed: true,
});
const step = (state: ReplyMode, char: string, k: Partial<Key>, c: DialogContext) =>
  stepPermissionKey(state, char, key(k), c);
const type = (state: ReplyMode, text: string, c: DialogContext): ReplyMode =>
  [...text].reduce((s, ch) => step(s, ch, {}, c).state, state);

describe("question choices", () => {
  test("Answer… (opens the field) and Skip", () => {
    const choices = buildPermissionChoices(question);
    expect(choices.map((c) => c.label)).toEqual(["Answer…", "Skip"]);
    expect(choices[0]?.reply).toBe(true);
    expect(choices[1]?.response).toEqual({ allowed: false });
  });
  test("a question that takes no reply offers only Skip", () => {
    const { reply: _r, ...bare } = question;
    expect(buildPermissionChoices(bare).map((c) => c.label)).toEqual(["Skip"]);
  });
  test("Enter on Answer… opens the field; typing + Enter sends allowed:true + message", () => {
    const c = ctx(question);
    const opened = step(MENU, "", { return: true }, c);
    expect(opened.action).toEqual({ kind: "none" });
    expect(opened.state.mode).toBe("reply");
    const typed = type(opened.state, "prod", c);
    expect(step(typed, "", { return: true }, c).action).toEqual({
      kind: "answer",
      response: { allowed: true, message: "prod" },
    });
  });
  test("a blank field is a Skip, never an empty answer", () => {
    const c = ctx(question);
    const opened = step(MENU, "", { return: true }, c).state;
    expect(step(opened, "", { return: true }, c).action).toEqual({
      kind: "answer",
      response: { allowed: false },
    });
    const spaces = type(opened, "   ", c);
    expect(step(spaces, "", { return: true }, c).action).toEqual({
      kind: "answer",
      response: { allowed: false },
    });
  });
  test("Esc in the field returns to the menu with the draft", () => {
    const c = ctx(question);
    const typed = type(step(MENU, "", { return: true }, c).state, "pr", c);
    const back = step(typed, "", { escape: true }, c);
    expect(back.state.mode).toBe("menu");
    expect(back.action).toEqual({ kind: "none" });
  });
  test("Skip (Enter on it, n, Esc) answers {allowed:false}", () => {
    const c = ctx(question, 1);
    expect(step(MENU, "", { return: true }, c).action).toEqual({
      kind: "answer",
      response: { allowed: false },
    });
    expect(step(MENU, "n", {}, c).action).toEqual({
      kind: "answer",
      response: { allowed: false },
    });
  });
  test("y never sends an empty answer: it opens the field; a does nothing", () => {
    const c = ctx(question);
    const y = step(MENU, "y", {}, c);
    expect(y.action).toEqual({ kind: "none" });
    expect(y.state.mode).toBe("reply");
    expect(step(MENU, "a", {}, c)).toEqual({ state: MENU, action: { kind: "none" } });
  });
});

describe("agent_add choices", () => {
  test("once-only: session yes / no, no «always»", () => {
    const choices = buildPermissionChoices(addAgent);
    expect(choices.map((c) => c.label)).toEqual([
      "Yes, for this session",
      "No",
      "No, let's talk about it",
    ]);
    expect(choices[0]?.response).toEqual({ allowed: true, scope: "once" });
    expect(choices.some((c) => c.response.scope === "session")).toBe(false);
  });
  test("a refusal reply stays a refusal (allowed:false + message)", () => {
    const c = ctx(addAgent, 2);
    const opened = step(MENU, "", { return: true }, c).state;
    const typed = type(opened, "no", c);
    expect(step(typed, "", { return: true }, c).action).toEqual({
      kind: "answer",
      response: { allowed: false, message: "no" },
    });
  });
});
