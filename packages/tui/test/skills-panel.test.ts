import { describe, expect, test } from "bun:test";
import { applyPanel, panelClick, panelView, skillsPanel } from "../src/panel.ts";
import type { SkillView, SkillsListView } from "../src/skills-panel.ts";
import { wrapText } from "../src/tree-panel.ts";

const skill = (over: Partial<SkillView>): SkillView => ({
  name: "review",
  description: "review a diff",
  scope: "project",
  user: true,
  model: true,
  location: "/w/.agents/skills/review/SKILL.md",
  ...over,
});
const list = (skills: SkillView[], problems: string[] = [], moreProblems = 0): SkillsListView => ({
  skills,
  problems,
  moreProblems,
});
const texts = (p: ReturnType<typeof skillsPanel>, width = 80, maxBody = 30): string[] =>
  panelView(p, width, maxBody).rows.map((r) => r.text);

describe("/skills panel (docs/feat/skills-panel.md)", () => {
  test("loading, then empty", () => {
    expect(panelView(skillsPanel(), 80, 10).title).toBe("Skills · loading…");
    const empty = panelView(skillsPanel(list([])), 80, 10);
    expect(empty.title).toBe("Skills");
    expect(empty.rows.map((r) => r.text)).toEqual(["  No skills on this daemon."]);
  });

  test("one aligned row per skill: name, who may invoke it, description", () => {
    const p = skillsPanel(
      list([
        skill({}),
        skill({ name: "deploy", description: "ship it", model: false }),
        skill({ name: "lint-fix", description: "fix lint", user: false }),
        skill({ name: "ghost", description: "nobody", user: false, model: false }),
      ]),
    );
    expect(panelView(p, 80, 10).title).toBe("Skills · 4 found");
    expect(texts(p)).toEqual([
      "❯ ▸ review    you + model  review a diff",
      "  ▸ deploy    you only     ship it",
      "  ▸ lint-fix  model only   fix lint",
      "  ▸ ghost     hidden       nobody",
    ]);
  });

  test("expanded: the description wrapped to the width, how it is invoked, where it lives", () => {
    const long = "word ".repeat(30).trim();
    let p = skillsPanel(list([skill({ description: long, model: false, scope: "user" })]));
    p = applyPanel(p, "toggle", 60);
    const rows = texts(p, 60);
    expect(rows[0]?.startsWith("❯ ▾ review  you only")).toBe(true);
    const body = rows.slice(1);
    for (const r of body) {
      expect(r.length).toBeLessThanOrEqual(60);
    }
    // The description, wrapped: every word is there (no row cut it).
    const described = body.slice(0, -2).map((r) => r.trim());
    expect(described.join(" ")).toBe(long);
    expect(body.at(-2)).toBe("        /review · not offered to the model");
    expect(body.at(-1)).toBe("        user · /w/.agents/skills/review/SKILL.md");
  });

  test("not a /command: says so", () => {
    let p = skillsPanel(list([skill({ user: false })]));
    p = applyPanel(p, "toggle", 80);
    expect(texts(p)).toContain("        no /command · offered to the model");
  });

  test("discovery problems: counted in the title, one group listing them (and how many more)", () => {
    const p = skillsPanel(list([skill({})], ["skipped skill at /x/SKILL.md: no description"], 4));
    expect(panelView(p, 80, 10).title).toBe("Skills · 1 found · 5 problems");
    let open = applyPanel(p, "down", 80);
    open = applyPanel(open, "toggle", 80);
    expect(texts(open)).toEqual([
      "  ▸ review  you + model  review a diff",
      "❯ ▾ ! 5 discovery problems",
      "        skipped skill at /x/SKILL.md: no description",
      "        … 4 more",
    ]);
  });

  test("problems only (every skill skipped): still a panel, not 'no skills'", () => {
    const p = skillsPanel(list([], ["skipped skill at /x/SKILL.md: no description"]));
    expect(texts(p)).toEqual(["❯ ▸ ! 1 discovery problem"]);
  });

  test("daemon strings are display-safe: bidi and zero-width characters dropped", () => {
    let p = skillsPanel(list([skill({ name: "a‮b", description: "d​e", location: "/p⁦q" })], ["x‮y"]));
    p = applyPanel(p, "toggle", 80);
    p = applyPanel(
      applyPanel(applyPanel(applyPanel(p, "down", 80), "down", 80), "down", 80),
      "down",
      80,
    );
    p = applyPanel(p, "toggle", 80);
    const all = texts(p).join("\n");
    for (const ok of ["ab", "de", "/pq", "xy"]) {
      expect(all).toContain(ok);
    }
    expect(all).not.toMatch(/[​-‏‪-‮⁠-⁩]/);
  });

  test("a click on a skill expands it", () => {
    const p = skillsPanel(list([skill({}), skill({ name: "deploy" })]));
    const clicked = panelClick(p, panelView(p, 80, 10), 1, 80);
    expect(clicked.tree).toEqual({ expanded: [1], cursor: 1 });
  });
});

describe("wrapText", () => {
  test("greedy by words, never past the width", () => {
    expect(wrapText("aa bb cc dd ee", 10, 5)).toEqual(["aa bb cc", "dd ee"]);
  });

  test("a word longer than the width is split", () => {
    expect(wrapText("x".repeat(25), 10, 5)).toEqual([
      "x".repeat(10),
      "x".repeat(10),
      "x".repeat(5),
    ]);
  });

  test("past maxLines the last line ends in …", () => {
    const lines = wrapText("aaaa bbbb cccc dddd eeee ffff", 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith("…")).toBe(true);
    expect(lines[1]?.length).toBeLessThanOrEqual(10);
  });

  test("empty text → no lines", () => {
    expect(wrapText("", 10, 3)).toEqual([]);
  });
});
