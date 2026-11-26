/**
 * `bun run skills:gen` — rewrite the generated blocks of the skills that ship
 * inside tentacle (`packages/config/builtin-skills/`, docs/feat/builtin-skills.md
 * D7) from the code: the CLI usage lines, the slash-command registry, the config
 * key registry, the `serve` A2A flags and the workflow file's fields and limits.
 * Only the text between `<!-- generated:<id> -->` and `<!-- /generated:<id> -->`
 * is owned here; everything else is hand-written.
 * `packages/cli/test/builtin-skills.test.ts` fails when a committed block differs.
 *
 * Idempotent. An unknown block id or an unclosed marker is an ERROR.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ARGS, USAGE } from "../packages/cli/src/flags.ts";
import { KEY_DOCS, topLevelKeys } from "../packages/config/src/key-docs.ts";
import * as spec from "../packages/core/src/workflow-spec.ts";
import { ALIASES, SLASH_COMMANDS } from "../packages/tui/src/commands/registry.ts";

export const SKILLS_DIR = resolve(import.meta.dir, "..", "packages", "config", "builtin-skills");
const SPEC_PATH = resolve(import.meta.dir, "..", "packages", "core", "src", "workflow-spec.ts");

const keyLine = (path: string): string => `- \`${path}\`: ${KEY_DOCS[path]?.summary ?? ""}`;

/**
 * The key names of one `const <name> = z.object({…})` in the workflow spec's
 * source: the schemas are private, and the file is the one truth for them.
 */
function schemaFields(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = z`);
  // The object's OWN `.strict()` (a nested object's is indented further).
  const end = source.indexOf("\n  .strict()", start);
  const body = start < 0 || end < 0 ? "" : source.slice(start, end);
  // `.object({ a: z…, b: z… })` on one line, else one key per line, four deep.
  const inline = /\.object\(\{ (.*) \}\)/.exec(body.split("\n")[1] ?? "")?.[1];
  const keys = inline === undefined ? body.matchAll(/^ {4}(\w+):/gm) : inline.matchAll(/(\w+): z/g);
  const names = [...keys].map((m) => `\`${m[1]}\``);
  if (names.length === 0) {
    throw new Error(`cannot read the fields of ${name} in workflow-spec.ts`);
  }
  return names.join(", ");
}

const duration = (ms: number): string =>
  ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${ms / 60_000}m`;

function workflowLimits(): string {
  const source = readFileSync(SPEC_PATH, "utf8");
  return [
    `- Top-level fields: ${schemaFields(source, "zWorkflow")} (\`schemaVersion\` is ${spec.WORKFLOW_SCHEMA_VERSION}).`,
    `- Step fields: ${schemaFields(source, "zStep")}.`,
    `- \`agent\` fields: ${schemaFields(source, "zAgentFields")}. \`approve\` fields: ${schemaFields(source, "zApproveFields")}.`,
    `- \`name\` at most ${spec.WORKFLOW_NAME_MAX} characters; \`description\` at most ${spec.WORKFLOW_MAX_DESCRIPTION}; 1 to ${spec.WORKFLOW_MAX_STEPS} steps.`,
    `- \`retry\` 0 to ${spec.WORKFLOW_MAX_RETRY} (default 0); \`on_fail.max\` 1 to ${spec.WORKFLOW_MAX_GOTO}.`,
    `- \`budget.max_step_runs\` default ${spec.WORKFLOW_DEFAULT_MAX_STEP_RUNS}; \`budget.wait\` default ${duration(spec.WORKFLOW_DEFAULT_WAIT_MS)}, at most ${duration(spec.WORKFLOW_MAX_WAIT_MS)}.`,
    `- \`timeout\` (\`run\` steps, like \`30s\`, \`20m\`, \`12h\`) default ${duration(spec.WORKFLOW_DEFAULT_TIMEOUT_MS)}, at most ${duration(spec.WORKFLOW_MAX_TIMEOUT_MS)}.`,
    `- \`approve.title\` at most ${spec.WORKFLOW_MAX_APPROVE_TITLE} characters, \`approve.detail\` at most ${spec.WORKFLOW_MAX_APPROVE_DETAIL}; the step list an approval shows at most ${spec.WORKFLOW_MAX_APPROVE_SUMMARY}.`,
    `- A run's inputs at most ${spec.WORKFLOW_MAX_INPUTS_BYTES} bytes together.`,
  ].join("\n");
}

/** Every generated block by id. */
export function generatedBlocks(): Record<string, string> {
  return {
    "cli-commands": Object.values(USAGE)
      .map((usage) => `- \`${usage}\``)
      .join("\n"),
    "slash-commands": [
      ...SLASH_COMMANDS.map((c) => `- \`${c.name}\`: ${c.description}`),
      ...Object.entries(ALIASES).map(([alias, name]) => `- \`${alias}\`: same as \`${name}\``),
    ].join("\n"),
    "config-sections": topLevelKeys().map(keyLine).join("\n"),
    "a2a-config": Object.keys(KEY_DOCS)
      .filter((path) => path === "harnesses" || path.startsWith("harnesses."))
      .map(keyLine)
      .join("\n"),
    "a2a-serve-flags": [...Object.keys(ARGS.serve.values), ...Object.keys(ARGS.serve.bools)]
      .filter((flag) => flag.startsWith("a2a-"))
      .map((flag) => `- \`--${flag}\``)
      .join("\n"),
    "workflow-limits": workflowLimits(),
  };
}

/** `text` with every generated block refilled. Pure. Throws on a bad marker. */
export function withGeneratedBlocks(
  text: string,
  blocks: Readonly<Record<string, string>> = generatedBlocks(),
): string {
  const marker = /<!-- generated:([a-z0-9-]+) -->[\s\S]*?<!-- \/generated:\1 -->/g;
  let filled = 0;
  const out = text.replace(marker, (_whole, id: string) => {
    const block = blocks[id];
    if (block === undefined) {
      throw new Error(`no generated block named "${id}"`);
    }
    filled++;
    return `<!-- generated:${id} -->\n${block}\n<!-- /generated:${id} -->`;
  });
  if (filled !== (text.match(/<!-- generated:/g)?.length ?? 0)) {
    throw new Error("a <!-- generated:… --> marker has no matching end marker");
  }
  return out;
}

/** Every Markdown file of the shipped skills. */
export function skillMarkdownFiles(dir: string = SKILLS_DIR): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => join(dir, file));
}

if (import.meta.main) {
  const blocks = generatedBlocks();
  for (const file of skillMarkdownFiles()) {
    const current = readFileSync(file, "utf8");
    const next = withGeneratedBlocks(current, blocks);
    if (next !== current) {
      writeFileSync(file, next, "utf8");
      process.stdout.write(`wrote ${file}\n`);
    }
  }
}
