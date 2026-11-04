import { describe, expect, test } from "bun:test";
import { SETTLED_ANSWERS_KEPT, SettledAnswers } from "../src/settled-answers.ts";

describe("SettledAnswers (docs/feat/permission-reply.md, fix round 1 F1)", () => {
  test("a repeat is the same option AND the same text", () => {
    const s = new SettledAnswers();
    s.remember("r1", { optionId: "reject_once", message: "why?" });
    expect(s.isRepeat("r1", { optionId: "reject_once", message: "why?" })).toBe(true);
    expect(s.isRepeat("r1", { optionId: "reject_once", message: "why not?" })).toBe(false);
    expect(s.isRepeat("r1", { optionId: "reject_once" })).toBe(false);
    expect(s.isRepeat("r1", { optionId: "allow_once", message: "why?" })).toBe(false);
    expect(s.isRepeat("r2", { optionId: "reject_once", message: "why?" })).toBe(false);
  });

  test("a plain answer repeats only as a plain answer", () => {
    const s = new SettledAnswers();
    s.remember("r1", { optionId: "allow_once" });
    expect(s.isRepeat("r1", { optionId: "allow_once" })).toBe(true);
    expect(s.isRepeat("r1", { optionId: "allow_once", message: "x" })).toBe(false);
  });

  test("bounded: only the last `limit` answers are kept, oldest dropped first", () => {
    const s = new SettledAnswers(2);
    s.remember("r1", { optionId: "reject_once" });
    s.remember("r2", { optionId: "reject_once" });
    s.remember("r3", { optionId: "reject_once" });
    expect(s.isRepeat("r1", { optionId: "reject_once" })).toBe(false);
    expect(s.isRepeat("r2", { optionId: "reject_once" })).toBe(true);
    expect(s.isRepeat("r3", { optionId: "reject_once" })).toBe(true);
  });

  test("the default window is SETTLED_ANSWERS_KEPT", () => {
    const s = new SettledAnswers();
    for (let i = 0; i <= SETTLED_ANSWERS_KEPT; i++) {
      s.remember(`r${i}`, { optionId: "reject_once" });
    }
    expect(s.isRepeat("r0", { optionId: "reject_once" })).toBe(false);
    expect(s.isRepeat("r1", { optionId: "reject_once" })).toBe(true);
  });
});
