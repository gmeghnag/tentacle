/**
 * The skills that ship inside tentacle (docs/feat/builtin-skills.md): every
 * session starts with them OFF unless `skills.builtin` names them (the seed in
 * `buildAgent`); the shipped text matches the code (T8) and the build embeds
 * every file (T9).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { redactText } from "@tentacle/agent";
import {
  BUILTIN_SKILL_FILES,
  builtinSkillEntries,
  loadConfig,
  parseSkillManifest,
} from "@tentacle/config";
import { BUILTIN_SKILL_NAMES, validateWorkflow } from "@tentacle/core";
import {
  SKILLS_DIR,
  generatedBlocks,
  skillMarkdownFiles,
  withGeneratedBlocks,
} from "../../../scripts/builtin-skills-gen.ts";
import { createServeAgent } from "../src/serve.ts";
import { createSkillScan } from "../src/wiring.ts";
import { workerAgentFactory } from "../src/worker.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "builtin-wiring-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function configIn(over: Record<string, unknown> = {}) {
  const config = await loadConfig({
    configDir: join(dir, "config"),
    cwd: dir,
    scaffold: false,
    env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
  });
  return { ...config, ...over };
}

interface Built {
  capabilities(): { disabledSkills: readonly string[] };
  skillListing(): { skills: readonly { name: string; builtin?: true; scope: string }[] };
}
const built = (agent: unknown): Built => agent as Built;

describe("the seed: built-in skills start off", () => {
  test("worker: all three off, listed as built-in", async () => {
    const agent = built(workerAgentFactory(await configIn(), {}).agent);
    expect(agent.capabilities().disabledSkills).toEqual([...BUILTIN_SKILL_NAMES]);
    expect(agent.skillListing().skills.map((s) => [s.name, s.scope, s.builtin])).toEqual(
      BUILTIN_SKILL_NAMES.map((name) => [name, "user", true]),
    );
  });

  test("serve: the same", async () => {
    const config = await configIn();
    const wired = createServeAgent(config, {}, createSkillScan(config), { cwd: dir });
    expect(built(wired.agent).capabilities().disabledSkills).toEqual([...BUILTIN_SKILL_NAMES]);
  });

  test("skills.builtin turns one on from the start", async () => {
    const config = await configIn({ builtinSkillsEnabled: { tentacle: true } });
    expect(built(workerAgentFactory(config, {}).agent).capabilities().disabledSkills).toEqual([
      "tentacle-a2a",
      "tentacle-workflows",
    ]);
  });
});

describe("T8: the shipped skills match the code", () => {
  const files = skillMarkdownFiles();
  const manifests = files.filter((file) => file.endsWith("/SKILL.md"));

  test("every generated block is current (run `bun run skills:gen`)", () => {
    const blocks = generatedBlocks();
    const used = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/<!-- generated:([a-z0-9-]+) -->/g)) {
        used.add(match[1] ?? "");
      }
      if (withGeneratedBlocks(text, blocks) !== text) {
        throw new Error(
          `${relative(SKILLS_DIR, file)} is stale — run \`bun run skills:gen\` and commit the diff`,
        );
      }
    }
    // Every block the generator makes is shipped somewhere.
    expect([...used].sort()).toEqual(Object.keys(blocks).sort());
  });

  test("a stale block and a bad marker are caught", () => {
    const blocks = { x: "new" };
    expect(withGeneratedBlocks("<!-- generated:x -->\nold\n<!-- /generated:x -->", blocks)).toBe(
      "<!-- generated:x -->\nnew\n<!-- /generated:x -->",
    );
    expect(() => withGeneratedBlocks("<!-- generated:x -->\nno end", blocks)).toThrow("marker");
    expect(() => withGeneratedBlocks("<!-- generated:y --><!-- /generated:y -->", blocks)).toThrow(
      'no generated block named "y"',
    );
  });

  test("the generated lists hold what they are generated from", () => {
    const blocks = generatedBlocks();
    expect(blocks["cli-commands"]).toContain("- `tentacle ps ");
    expect(blocks["slash-commands"]).toContain("- `/skills`: ");
    expect(blocks["config-sections"]).toContain("- `skills`: ");
    expect(blocks["a2a-config"]).toContain("- `harnesses.*.tokenCommand`: ");
    expect(blocks["a2a-serve-flags"]).toContain("- `--a2a-token-command`");
    expect(blocks["workflow-limits"]).toContain("`on_fail`");
    expect(blocks["workflow-limits"]).toContain("`budget.max_step_runs`");
  });

  test("every SKILL.md: no warnings, name = dir, ≤ 12 000 chars, a trigger description", () => {
    expect(manifests.map((file) => relative(SKILLS_DIR, file).split("/")[0]).sort()).toEqual([
      ...BUILTIN_SKILL_NAMES,
    ]);
    for (const file of manifests) {
      const name = relative(SKILLS_DIR, file).split("/")[0] ?? "";
      const text = readFileSync(file, "utf8");
      const parsed = parseSkillManifest(text, name);
      if (!parsed.ok) {
        throw new Error(`${name}: ${parsed.reason}`);
      }
      expect(parsed.warnings).toEqual([]);
      expect(parsed.name).toBe(name);
      expect(parsed.modelInvocable).toBe(true);
      expect(parsed.description).toStartWith("Use when ");
      expect(parsed.description.length).toBeLessThanOrEqual(300);
      expect(text.length).toBeLessThanOrEqual(12_000);
    }
  });

  test("the workflow skill's example file is a valid workflow", () => {
    const text = readFileSync(join(SKILLS_DIR, "tentacle-workflows", "SKILL.md"), "utf8");
    const yaml = /```yaml\n([\s\S]*?)```/.exec(text)?.[1] ?? "";
    const result = validateWorkflow(yaml, {
      name: "review-fix",
      readPrompt: () => "review",
    });
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  test("secret redaction leaves every shipped file as it is", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(redactText(text)).toBe(text);
    }
  });
});

describe("T9: the build embeds every shipped file", () => {
  test("`BUILTIN_SKILL_FILES` is the folder, byte for byte", () => {
    const onDisk = readdirSync(SKILLS_DIR, { recursive: true, encoding: "utf8" })
      .filter((path) => statSync(join(SKILLS_DIR, path)).isFile())
      .sort();
    expect(builtinSkillEntries().map(([path]) => path)).toEqual(onDisk);
    for (const [path, text] of builtinSkillEntries()) {
      expect(Buffer.from(text).toString("hex")).toBe(
        readFileSync(join(SKILLS_DIR, path)).toString("hex"),
      );
    }
    expect(Object.keys(BUILTIN_SKILL_FILES).sort()).toEqual([...BUILTIN_SKILL_NAMES]);
  });
});
