import { describe, expect, test } from "bun:test";
import {
  MAX_SKILL_LIST,
  MAX_SKILL_PROBLEMS,
  Method,
  RequestSchemas,
  SkillsListResultSchema,
} from "../src/index.ts";

const skill = {
  name: "review",
  description: "review a diff",
  scope: "user",
  user: true,
  model: false,
  location: "/home/u/.agents/skills/review/SKILL.md",
};
const ok = { skills: [skill], problems: ["p"], moreProblems: 0 };
const parse = (v: unknown) => SkillsListResultSchema.safeParse(v).success;

describe("skills/list (docs/feat/skills-panel.md)", () => {
  test("is registered with its schemas", () => {
    expect(Method.SkillsList).toBe("skills/list");
    expect(RequestSchemas[Method.SkillsList].result).toBe(SkillsListResultSchema);
  });

  test("accepts a listing; a non-spec name is fine (it loads, it just isn't a /name)", () => {
    expect(parse(ok)).toBe(true);
    expect(parse({ ...ok, skills: [{ ...skill, name: "My Skill" }] })).toBe(true);
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
