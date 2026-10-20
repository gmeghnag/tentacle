import { describe, expect, test } from "bun:test";
import {
  MAX_CATALOG_SKILLS,
  SKILLS_PROMPT_HEADER,
  type SkillInfo,
  catalogCapDiagnostic,
  mergeSkills,
  offeredSkills,
  parseSkillManifest,
  renderSkillsCatalog,
  splitFrontmatter,
} from "../src/skills.ts";

const skill = (over: Partial<SkillInfo> & { name: string }): SkillInfo => ({
  description: `does ${over.name}`,
  location: `/s/${over.name}/SKILL.md`,
  dir: `/s/${over.name}`,
  scope: "user",
  files: [],
  filesTruncated: false,
  modelInvocable: true,
  ...over,
});

describe("splitFrontmatter", () => {
  test("splits yaml and body, reporting the body's first file line", () => {
    const s = splitFrontmatter("---\nname: a\ndescription: d\n---\n# Body\nline\n");
    expect(s.yaml).toBe("name: a\ndescription: d");
    expect(s.body).toBe("# Body\nline\n");
    expect(s.bodyLine).toBe(5);
  });

  test("no opening fence, or no closing fence → no frontmatter, whole text is body", () => {
    expect(splitFrontmatter("# just markdown\n")).toEqual({
      yaml: null,
      body: "# just markdown\n",
      bodyLine: 1,
    });
    expect(splitFrontmatter("---\nname: a\n").yaml).toBeNull();
  });

  test("tolerates a BOM and CRLF fences", () => {
    const s = splitFrontmatter("﻿---\r\nname: a\r\n---\r\nbody");
    expect(s.yaml).toBe("name: a\r");
    expect(s.body).toBe("body");
  });
});

describe("parseSkillManifest (lenient, per the agentskills.io client guide)", () => {
  test("reads a folded description and a nested metadata map without leaking keys", () => {
    const p = parseSkillManifest(
      "---\nname: a\ndescription: >-\n  multi\n  line\nmetadata:\n  author: x\n---\nbody",
      "a",
    );
    expect(p).toEqual({
      ok: true,
      name: "a",
      description: "multi line",
      modelInvocable: true,
      warnings: [],
    });
  });

  test("a quoted description with colons parses (the real hf-cli shape)", () => {
    const p = parseSkillManifest('---\nname: hf\ndescription: "Use when: x; y"\n---\n', "hf");
    expect(p.ok && p.description).toBe("Use when: x; y");
  });

  test("missing name → falls back to the directory name, with a warning", () => {
    const p = parseSkillManifest("---\ndescription: d\n---\n", "my-skill");
    expect(p.ok && p.name).toBe("my-skill");
    expect(p.ok && p.warnings).toEqual(['no name; using the directory name "my-skill"']);
  });

  test("name/directory mismatch and a non-spec name warn but still load", () => {
    const p = parseSkillManifest("---\nname: My_Skill\ndescription: d\n---\n", "dir");
    expect(p.ok).toBe(true);
    expect(p.ok && p.name).toBe("My_Skill");
    expect(p.ok && p.warnings.length).toBe(2);
  });

  test("skipped: no frontmatter, unparseable YAML, no/empty description, non-map", () => {
    expect(parseSkillManifest("# no fm", "a")).toEqual({
      ok: false,
      reason: "no YAML frontmatter",
    });
    const bad = parseSkillManifest("---\nname: [unclosed\ndescription: d\n---\n", "a");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toStartWith("unparseable frontmatter");
    expect(parseSkillManifest("---\nname: a\n---\n", "a")).toEqual({
      ok: false,
      reason: "no description",
    });
    expect(parseSkillManifest('---\nname: a\ndescription: "  "\n---\n', "a").ok).toBe(false);
    expect(parseSkillManifest("---\n- a\n- b\n---\n", "a")).toEqual({
      ok: false,
      reason: "frontmatter is not a key/value map",
    });
  });

  test("disable-model-invocation (bool or string) hides it from the model", () => {
    for (const v of ["true", '"true"', "True"]) {
      const p = parseSkillManifest(
        `---\ndescription: d\ndisable-model-invocation: ${v}\n---\n`,
        "a",
      );
      expect(p.ok && p.modelInvocable).toBe(false);
    }
    const off = parseSkillManifest(
      "---\ndescription: d\ndisable-model-invocation: false\n---\n",
      "a",
    );
    expect(off.ok && off.modelInvocable).toBe(true);
  });

  test("allowed-tools is reported as ignored", () => {
    const p = parseSkillManifest(
      "---\nname: a\ndescription: d\nallowed-tools: Bash(git:*)\n---\n",
      "a",
    );
    expect(p.ok && p.warnings.join()).toContain("`allowed-tools` is ignored");
  });

  test("an over-long description warns and is truncated to the spec limit", () => {
    const p = parseSkillManifest(`---\nname: a\ndescription: ${"x".repeat(1100)}\n---\n`, "a");
    expect(p.ok && p.description.length).toBe(1024);
    expect(p.ok && p.warnings.join()).toContain("longer than 1024");
  });
});

describe("mergeSkills", () => {
  test("first hit (highest precedence) wins; each loser is reported, never silent", () => {
    const project = skill({
      name: "x",
      location: "/repo/.agents/skills/x/SKILL.md",
      scope: "project",
    });
    const user = skill({ name: "x", location: "/home/.agents/skills/x/SKILL.md" });
    const other = skill({ name: "y" });
    const { skills, diagnostics } = mergeSkills([project, other, user]);
    expect(skills).toEqual([project, other]);
    expect(diagnostics).toEqual([
      'skill "x" at /home/.agents/skills/x/SKILL.md is shadowed by /repo/.agents/skills/x/SKILL.md',
    ]);
  });
});

describe("renderSkillsCatalog / offeredSkills", () => {
  test("no offered skill → empty string (the prompt stays byte-identical)", () => {
    expect(renderSkillsCatalog([])).toBe("");
    expect(renderSkillsCatalog([skill({ name: "h", modelInvocable: false })])).toBe("");
  });

  test("lists name + description of model-invocable skills only, escaped", () => {
    const text = renderSkillsCatalog([
      skill({ name: "a", description: "use <when> a & b" }),
      skill({ name: "hidden", modelInvocable: false }),
    ]);
    expect(text.startsWith(`${SKILLS_PROMPT_HEADER}\n`)).toBe(true);
    expect(text).toContain("<name>a</name>\n<description>use &lt;when&gt; a &amp; b</description>");
    expect(text).not.toContain("hidden");
    expect(text).toContain("`skill` tool");
  });

  test("the catalog and the tool's offer share one cap; overflow is reported", () => {
    const many = Array.from({ length: MAX_CATALOG_SKILLS + 3 }, (_, i) => skill({ name: `s${i}` }));
    expect(offeredSkills(many).length).toBe(MAX_CATALOG_SKILLS);
    expect(renderSkillsCatalog(many)).not.toContain(`<name>s${MAX_CATALOG_SKILLS}</name>`);
    expect(catalogCapDiagnostic(many)).toContain(`${MAX_CATALOG_SKILLS + 3} skills found`);
    expect(catalogCapDiagnostic(many.slice(0, 3))).toBeUndefined();
  });
});
