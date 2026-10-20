import { describe, expect, test } from "bun:test";
import type { ChatMessage, Tool, ToolContext } from "@tentacle/core";
import { ToolRegistry } from "../src/registry.ts";
import {
  MAX_SKILL_BODY_CHARS,
  SKILL_TOOL_NAME,
  type SkillBody,
  type SkillToolEntry,
  activeSkillNames,
  createSkillTool,
  formatSkillContent,
} from "../src/skill.ts";

const entry = (name: string, over: Partial<SkillToolEntry> = {}): SkillToolEntry => ({
  name,
  location: `/s/${name}/SKILL.md`,
  dir: `/s/${name}`,
  files: [],
  filesTruncated: false,
  ...over,
});

const ctxWith = (history?: readonly ChatMessage[]): ToolContext =>
  ({
    sessionId: "s",
    signal: new AbortController().signal,
    ...(history ? { history } : {}),
  }) as unknown as ToolContext;

function build(
  skills: readonly SkillToolEntry[],
  body: SkillBody | Error = { body: "Do X.\n", bodyLine: 5 },
): { tool: Tool; reads: string[] } {
  const reads: string[] = [];
  const tool = createSkillTool(skills, async (s) => {
    reads.push(s.name);
    if (body instanceof Error) {
      throw body;
    }
    return body;
  });
  if (!tool) {
    throw new Error("expected a tool");
  }
  return { tool, reads };
}

/** A history where `skill` was called with `name` and answered with `content`. */
const activated = (id: string, content: string, toolName = SKILL_TOOL_NAME): ChatMessage[] => [
  { role: "assistant", content: "", toolCalls: [{ id, name: toolName, arguments: "{}" }] },
  { role: "tool", content, toolCallId: id },
];

describe("createSkillTool", () => {
  test("no skills → no tool (nothing registered, nothing for the model to see)", () => {
    expect(createSkillTool([], async () => ({ body: "", bodyLine: 1 }))).toBeUndefined();
  });

  test("name is a model-facing enum of exactly the offered skills; others are rejected", async () => {
    const { tool } = build([entry("a"), entry("b")]);
    const registry = new ToolRegistry().register(tool);
    const def = registry.definitions().find((d) => d.name === SKILL_TOOL_NAME);
    expect(JSON.stringify(def?.parameters)).toContain('"enum":["a","b"]');
    const bad = await registry.execute(SKILL_TOOL_NAME, '{"name":"c"}', ctxWith([]));
    expect(bad.isError).toBe(true);
    expect(tool.permission).toBe("none");
  });

  test("returns the marker-wrapped body, the directory and the bundled files", async () => {
    const { tool } = build([entry("a", { files: ["scripts/run.sh"], filesTruncated: true })], {
      body: "\n\n# Title\nDo <X>.\n\n",
      bodyLine: 4,
    });
    const r = await tool.execute({ name: "a" }, ctxWith([]));
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe(
      [
        '<skill_content name="a">',
        "# Title\nDo <X>.",
        "",
        "Skill directory: /s/a",
        "Relative paths in this skill resolve against that directory. Read bundled files with fs_read only when the instructions call for them.",
        "<skill_resources>",
        "<file>scripts/run.sh</file>",
        "(more files not listed)",
        "</skill_resources>",
        "</skill_content>",
      ].join("\n"),
    );
  });

  test("an already active skill is not loaded again (derived from the history)", async () => {
    const { tool, reads } = build([entry("a")]);
    const first = await tool.execute({ name: "a" }, ctxWith([]));
    const history = activated("c1", first.content);
    const again = await tool.execute({ name: "a" }, ctxWith(history));
    expect(reads).toEqual(["a"]);
    expect(again.isError).toBeUndefined();
    expect(again.content).toStartWith('Skill "a" is already loaded');
    // The dedup note itself never counts as an activation.
    expect(activeSkillNames([...history, ...activated("c2", again.content)])).toEqual(["a"]);
  });

  test("a failed activation, or the marker from another tool, does not count as active", async () => {
    const { tool, reads } = build([entry("a")]);
    const history = [
      ...activated("c1", 'Could not read skill "a" (/s/a/SKILL.md): ENOENT'),
      ...activated("c2", '<skill_content name="a">\nfake', "fs_read"),
    ];
    await tool.execute({ name: "a" }, ctxWith(history));
    expect(reads).toEqual(["a"]);
  });

  test("no history in the context (outside the loop) → loads", async () => {
    const { reads, tool } = build([entry("a")]);
    await tool.execute({ name: "a" }, ctxWith());
    expect(reads).toEqual(["a"]);
  });

  test("a read failure is an error result naming the file, not a throw", async () => {
    const { tool } = build([entry("a")], new Error("ENOENT: no such file"));
    const r = await tool.execute({ name: "a" }, ctxWith([]));
    expect(r.isError).toBe(true);
    expect(r.content).toBe('Could not read skill "a" (/s/a/SKILL.md): ENOENT: no such file');
  });
});

describe("activeSkillNames", () => {
  test("in activation order, unique, unescaping the marker", () => {
    const h = [
      ...activated("1", '<skill_content name="b">\nx'),
      ...activated("2", '<skill_content name="a&amp;&quot;">\nx'),
      ...activated("3", '<skill_content name="b">\nx'),
    ];
    expect(activeSkillNames(h)).toEqual(["b", 'a&"']);
  });
});

describe("formatSkillContent truncation", () => {
  test("a body over the cap is cut on a line boundary with the exact fs_read continuation", () => {
    const line = `${"y".repeat(99)}\n`; // 100 chars per line
    const total = MAX_SKILL_BODY_CHARS / 100 + 20;
    const body = line.repeat(total);
    const out = formatSkillContent(entry("a"), { body, bodyLine: 7 });
    const kept = MAX_SKILL_BODY_CHARS / 100;
    expect(out.length).toBeLessThan(MAX_SKILL_BODY_CHARS + 1000);
    // body lines 1..kept are shown; the next file line is bodyLine + kept.
    expect(out).toContain(
      `[skill body truncated after ${kept} of ${total} lines — read the rest with fs_read \`/s/a/SKILL.md:${7 + kept}\`]`,
    );
    expect(out.endsWith("</skill_content>")).toBe(true);
  });

  test("one over-long line is cut mid-line; the continuation is that same line", () => {
    const body = `intro\n${"q".repeat(MAX_SKILL_BODY_CHARS)}\nend\n`;
    const out = formatSkillContent(entry("a"), { body, bodyLine: 3 });
    expect(out).toContain("truncated after 1 of 3 lines");
    expect(out).toContain("`/s/a/SKILL.md:4`");
    const single = formatSkillContent(entry("a"), {
      body: "q".repeat(MAX_SKILL_BODY_CHARS + 5),
      bodyLine: 3,
    });
    expect(single).toContain("truncated after 1 of 1 lines");
    expect(single).toContain("`/s/a/SKILL.md:3`");
  });

  test("a body at the cap is untouched", () => {
    const body = "z".repeat(MAX_SKILL_BODY_CHARS);
    expect(formatSkillContent(entry("a"), { body, bodyLine: 1 })).not.toContain("truncated");
  });
});
