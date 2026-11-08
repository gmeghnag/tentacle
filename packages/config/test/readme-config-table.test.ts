import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { leafPaths, renderConfigKeysTable } from "@tentacle/config";

const README = join(import.meta.dir, "..", "..", "..", "README.md");
const START = "<!-- config-keys:start -->";
const END = "<!-- config-keys:end -->";

/** The text between the two markers (exclusive), or `undefined` if a marker is missing. */
function committedBlock(): string | undefined {
  const text = readFileSync(README, "utf8");
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    return undefined;
  }
  return text.slice(start + START.length, end);
}

const normalize = (block: string): string => block.replace(/^\n+|\n+$/g, "").trimEnd();

describe("T4: the README's config table is the registry's", () => {
  test("both markers are present, once each, in order", () => {
    const text = readFileSync(README, "utf8");
    expect(text.split(START).length - 1).toBe(1);
    expect(text.split(END).length - 1).toBe(1);
    expect(text.indexOf(START)).toBeLessThan(text.indexOf(END));
  });

  test("the block equals the generated one (run `bun run docs:config`)", () => {
    const committed = committedBlock();
    expect(committed).toBeDefined();
    if (committed === undefined) return;
    const generated = renderConfigKeysTable();
    if (normalize(committed) !== normalize(generated)) {
      throw new Error(
        "README's config table is stale — run `bun run docs:config` and commit the diff",
      );
    }
  });

  test("every registry leaf is a row (a key without a row is a doc hole)", () => {
    const block = committedBlock() ?? "";
    const missing = leafPaths()
      .filter((path) => !path.startsWith("profiles.*."))
      .filter((path) => !block.includes(`\`${path}\``));
    expect(missing).toEqual([]);
  });

  test("every env name the registry holds appears in its row", () => {
    const block = committedBlock() ?? "";
    const missing = [
      "TENTACLE_PROVIDER",
      "TENTACLE_MODEL_BASE_URL",
      "TENTACLE_MODEL",
      "TENTACLE_MAX_ITERATIONS",
      "TENTACLE_SUBAGENT_MAX_PARALLEL",
      "TENTACLE_TOOL_EXECUTION",
      "TENTACLE_WRITABLE_DIRS",
      "TENTACLE_NO_SKILLS",
    ].filter((env) => !block.includes(env));
    expect(missing).toEqual([]);
  });

  test("an inverted env says so, rather than reading as its opposite", () => {
    const block = committedBlock() ?? "";
    expect(block).toContain("TENTACLE_NO_SKILLS");
    expect(block).toMatch(/TENTACLE_NO_SKILLS`? \(inverted\)/);
    expect(block).toMatch(/TENTACLE_NO_AGENTS_MD`? \(inverted\)/);
  });

  test("the generator is idempotent text (a second run cannot drift)", () => {
    expect(renderConfigKeysTable()).toBe(renderConfigKeysTable());
    expect(renderConfigKeysTable().startsWith("| ")).toBe(true);
  });

  test("the facts the old HAND table carried are still in the generated one (LOW 7)", () => {
    // Each row is a fact `git show main:README.md` had and the first generated
    // table dropped. They live in the registry now, so they cannot be lost
    // again without failing here.
    const block = committedBlock() ?? "";
    const lost: [string, string][] = [
      // The env format: `: separated, empty = []`.
      ["tools.writableDirs", "`:`-separated; empty = `[]`"],
      // The real default, not the literal `["/tmp"]`.
      ["tools.writableDirs", "the system temp dir (`$TMPDIR`) and `/tmp`"],
      // The array form of readOnlyTools, and its `hint` meaning.
      ["mcpServers.*.readOnlyTools", "`hint` (default: those it marks `readOnlyHint`)"],
      ["mcpServers.*.readOnlyTools", "or a list"],
      // maxTokens: unset is not one value.
      ["model.maxTokens", "`64000` for anthropic"],
      // baseURL: both providers' defaults.
      ["model.baseURL", "`https://api.anthropic.com/v1` (anthropic)"],
      // systemPromptFile's default name, and that the env is not a path.
      ["systemPromptFile", "`PROMPT.md` in the config dir"],
      ["systemPromptFile", "inline, not a path"],
      // The overlap semantics of tools.execution, kept in the summary.
      ["tools.execution", "writes and `shell` alone"],
      // Sub-agent overlap, the workspace-sharing fact.
      ["subagents.execution", "they share one workspace"],
      // engine: an unknown value is refused.
      ["engine", "unknown refused"],
      // contextReset: asked like any tool.
      ["contextReset.enabled", "asked like any other tool"],
      // tui.theme: never carried.
      ["tui.theme", "never carried to a pod"],
    ];
    const missing = lost
      .filter(([path, fact]) => {
        const row = block.split("\n").find((line) => line.startsWith(`| \`${path}\` |`));
        return row === undefined || !row.includes(fact);
      })
      .map(([path, fact]) => `${path}: ${fact}`);
    expect(missing).toEqual([]);
  });

  test('a runtime-state default is stated as TEXT, never as ["/tmp"] (LOW 5)', () => {
    const block = committedBlock() ?? "";
    expect(block).not.toContain('| ["/tmp"] |');
    expect(block).toContain("the system temp dir (`$TMPDIR`) and `/tmp`");
  });
});
