import { describe, expect, test } from "bun:test";
import {
  MAX_SKILL_LIST,
  MAX_SKILL_PROBLEMS,
  Method,
  PROTOCOL_VERSION,
  RequestSchemas,
  SessionSkillsParamsSchema,
  SessionSkillsResultSchema,
  isMethodName,
} from "../src/index.ts";

const skill = {
  name: "review",
  description: "review a diff",
  scope: "user",
  user: true,
  model: false,
  location: "/home/u/.agents/skills/review/SKILL.md",
};
const ok = { slash: [], skills: [skill], problems: ["p"], moreProblems: 0 };
const parse = (v: unknown) => SessionSkillsResultSchema.safeParse(v).success;

describe("session/skills (docs/feat/skills-hot-reload.md)", () => {
  test("is registered with its schemas; skills/list is gone; protocol 13", () => {
    expect(Method.SessionSkills).toBe("session/skills");
    expect(RequestSchemas[Method.SessionSkills].params).toBe(SessionSkillsParamsSchema);
    expect(RequestSchemas[Method.SessionSkills].result).toBe(SessionSkillsResultSchema);
    expect(isMethodName("skills/list")).toBe(false);
    expect(PROTOCOL_VERSION).toBe(13);
  });

  test("params: a session id, or none (a session not created yet)", () => {
    expect(SessionSkillsParamsSchema.safeParse({ sessionId: "s" }).success).toBe(true);
    expect(SessionSkillsParamsSchema.safeParse({}).success).toBe(true);
    expect(SessionSkillsParamsSchema.safeParse({ sessionId: "" }).success).toBe(false);
  });

  test("accepts a listing; a non-spec name is fine (it loads, it just isn't a /name)", () => {
    expect(parse(ok)).toBe(true);
    expect(parse({ ...ok, skills: [{ ...skill, name: "My Skill" }] })).toBe(true);
  });

  test("modelAfterReset is an optional boolean", () => {
    expect(parse({ ...ok, skills: [{ ...skill, modelAfterReset: true }] })).toBe(true);
    expect(parse({ ...ok, skills: [{ ...skill, modelAfterReset: "yes" }] })).toBe(false);
    const parsed = SessionSkillsResultSchema.parse({
      ...ok,
      skills: [{ ...skill, modelAfterReset: true }],
    });
    expect(parsed.skills[0]?.modelAfterReset).toBe(true);
  });

  test("rejects control characters in every daemon string", () => {
    const evil = "x\u001b]52;c;AAAA\u0007";
    for (const key of ["name", "description", "location"] as const) {
      expect(parse({ ...ok, skills: [{ ...skill, [key]: evil }] })).toBe(false);
    }
    expect(parse({ ...ok, problems: [evil] })).toBe(false);
  });

  test("rejects empty or overlong strings, an unknown scope; strips extra keys", () => {
    expect(parse({ ...ok, skills: [{ ...skill, name: "" }] })).toBe(false);
    expect(parse({ ...ok, skills: [{ ...skill, description: "d".repeat(1025) }] })).toBe(false);
    expect(parse({ ...ok, skills: [{ ...skill, scope: "system" }] })).toBe(false);
    expect(parse({ ...ok, skills: [{ ...skill, extra: 1 }] })).toBe(true); // stripped
    expect(parse({ ...ok, problems: ["p".repeat(1001)] })).toBe(false);
  });

  test("caps the lists", () => {
    const many = (n: number) => Array.from({ length: n }, () => skill);
    expect(parse({ ...ok, skills: many(MAX_SKILL_LIST) })).toBe(true);
    expect(parse({ ...ok, skills: many(MAX_SKILL_LIST + 1) })).toBe(false);
    const probs = (n: number) => Array.from({ length: n }, () => "p");
    expect(parse({ ...ok, problems: probs(MAX_SKILL_PROBLEMS) })).toBe(true);
    expect(parse({ ...ok, problems: probs(MAX_SKILL_PROBLEMS + 1) })).toBe(false);
    expect(parse({ ...ok, moreProblems: -1 })).toBe(false);
  });
});
