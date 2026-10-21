/**
 * `toSkillList` (docs/feat/skills-panel.md): whatever discovery produced, the
 * `skills/list` result is schema-valid — so one odd `SKILL.md` can never fail
 * the whole listing.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_SKILL_LIST,
  MAX_SKILL_PROBLEMS,
  type SkillListEntry,
  SkillsListResultSchema,
} from "@tentacle/protocol";
import { toSkillList } from "../src/mapping.ts";

const entry = (over: Partial<SkillListEntry> = {}): SkillListEntry => ({
  name: "review",
  description: "review a diff",
  scope: "project",
  user: true,
  model: true,
  location: "/w/.agents/skills/review/SKILL.md",
  ...over,
});

describe("toSkillList (always schema-valid, whatever discovery said)", () => {
  test("a clean listing passes through unchanged", () => {
    const out = toSkillList({ skills: [entry()], problems: ["p"] });
    expect(out).toEqual({ skills: [entry()], problems: ["p"], moreProblems: 0 });
    expect(SkillsListResultSchema.safeParse(out).success).toBe(true);
  });

  test("strings become one line, cut to the caps; an entry left empty is dropped", () => {
    const out = toSkillList({
      skills: [
        entry({
          name: "a\u001b[2Jb",
          description: `line1\n\tline2${"x".repeat(2000)}`,
          location: `/p/${"d".repeat(5000)}`,
        }),
        entry({ name: "\u0007\n" }),
        entry({ description: " \n " }),
      ],
      problems: ["bad\u0000problem", "\n", "y".repeat(2000)],
    });
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0]?.name).toBe("a [2Jb");
    expect(out.skills[0]?.description.startsWith("line1 line2x")).toBe(true);
    expect(out.skills[0]?.description.length).toBe(1024);
    expect(out.skills[0]?.location.length).toBe(4096);
    expect(out.problems).toEqual(["bad problem", "y".repeat(1000)]);
    expect(SkillsListResultSchema.safeParse(out).success).toBe(true);
  });

  test("past the skill cap, one problem line says how many were left out", () => {
    const many = Array.from({ length: MAX_SKILL_LIST + 3 }, (_, i) => entry({ name: `s${i}` }));
    const out = toSkillList({ skills: many, problems: [] });
    expect(out.skills).toHaveLength(MAX_SKILL_LIST);
    expect(out.problems).toEqual([`3 more skills not listed (at most ${MAX_SKILL_LIST})`]);
    expect(SkillsListResultSchema.safeParse(out).success).toBe(true);
  });

  test("past the problem cap, the rest are counted", () => {
    const problems = Array.from({ length: MAX_SKILL_PROBLEMS + 7 }, (_, i) => `p${i}`);
    const out = toSkillList({ skills: [], problems });
    expect(out.problems).toHaveLength(MAX_SKILL_PROBLEMS);
    expect(out.moreProblems).toBe(7);
    expect(SkillsListResultSchema.safeParse(out).success).toBe(true);
  });
});
