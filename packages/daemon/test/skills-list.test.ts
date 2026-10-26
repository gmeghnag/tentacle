/**
 * `toSkillList` / `toSessionSkills` (docs/feat/skills-panel.md,
 * skills-hot-reload.md): whatever discovery produced, the `session/skills`
 * result is schema-valid — so one odd `SKILL.md` can never fail the whole
 * listing.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_SKILL_LIST,
  MAX_SKILL_PROBLEMS,
  SessionSkillsResultSchema,
  type SkillListEntry,
} from "@tentacle/protocol";
import { toSessionSkills, toSkillList } from "../src/mapping.ts";

const valid = (out: ReturnType<typeof toSkillList>): boolean =>
  SessionSkillsResultSchema.safeParse({ slash: [], ...out }).success;

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
    expect(valid(out)).toBe(true);
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
    expect(valid(out)).toBe(true);
  });

  test("past the skill cap, one problem line says how many were left out", () => {
    const many = Array.from({ length: MAX_SKILL_LIST + 3 }, (_, i) => entry({ name: `s${i}` }));
    const out = toSkillList({ skills: many, problems: [] });
    expect(out.skills).toHaveLength(MAX_SKILL_LIST);
    expect(out.problems).toEqual([`3 more skills not listed (at most ${MAX_SKILL_LIST})`]);
    expect(valid(out)).toBe(true);
  });

  test("past the problem cap, the rest are counted", () => {
    const problems = Array.from({ length: MAX_SKILL_PROBLEMS + 7 }, (_, i) => `p${i}`);
    const out = toSkillList({ skills: [], problems });
    expect(out.problems).toHaveLength(MAX_SKILL_PROBLEMS);
    expect(out.moreProblems).toBe(7);
    expect(valid(out)).toBe(true);
  });
});

describe("toSessionSkills (one listing → the /name list and the panel's)", () => {
  test("slash = the user skills with a spec name; modelAfterReset rides the listing", () => {
    const out = toSessionSkills({
      skills: [
        entry({ name: "a", user: true, model: false, modelAfterReset: true }),
        entry({ name: "m", user: false, model: true }),
        entry({ name: "Not Spec", user: true }),
      ],
      problems: [],
    });
    expect(out.slash).toEqual([{ name: "a", description: "review a diff" }]);
    expect(out.skills.map((s) => [s.name, s.modelAfterReset])).toEqual([
      ["a", true],
      ["m", undefined],
      ["Not Spec", undefined],
    ]);
    expect(SessionSkillsResultSchema.safeParse(out).success).toBe(true);
  });
});
