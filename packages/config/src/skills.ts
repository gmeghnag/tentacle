/**
 * Agent Skills (`SKILL.md`, https://agentskills.io/specification) — the pure
 * half: frontmatter parsing, validation, scope precedence and the catalog text
 * folded into the system prompt. No I/O here; the scan lives in
 * `skills-scan.ts`. Design: docs/feat/skills-core.md.
 */

/** File name of a skill's manifest inside its directory. */
export const SKILL_FILENAME = "SKILL.md";

/** Header the catalog is appended under, after the identity and AGENTS.md. */
export const SKILLS_PROMPT_HEADER = "# Skills";

/** At most this many skills are listed in the catalog (the rest are reported). */
export const MAX_CATALOG_SKILLS = 100;

/** Spec limits (a breach warns; the skill still loads). */
const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1024;

/** Where a skill was found. `project` skills are repo-supplied (trust: as AGENTS.md). */
export type SkillScope = "project" | "user";

/** A discovered skill — plain data (it crosses the worker boundary). */
export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  /** Absolute path of its `SKILL.md`. */
  readonly location: string;
  /** Absolute path of the skill directory (bundled paths resolve against it). */
  readonly dir: string;
  readonly scope: SkillScope;
  /** Bundled files, relative to `dir` (bounded; see `filesTruncated`). */
  readonly files: readonly string[];
  /** True when a scan bound cut the `files` list short. */
  readonly filesTruncated: boolean;
  /** False for `disable-model-invocation: true`: hidden from the model. */
  readonly modelInvocable: boolean;
}

/** The frontmatter block and the Markdown body after it. */
export interface SplitSkill {
  /** The YAML between the `---` fences, or null when there is no frontmatter. */
  readonly yaml: string | null;
  readonly body: string;
  /** 1-based line of the file where `body` starts. */
  readonly bodyLine: number;
}

/**
 * Split `---\n<yaml>\n---\n<body>`. The opening fence must be the first line;
 * without a closing fence the whole text is the body (no frontmatter).
 */
export function splitFrontmatter(text: string): SplitSkill {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = src.split("\n");
  if (lines[0]?.trimEnd() !== "---") {
    return { yaml: null, body: src, bodyLine: 1 };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === "---") {
      return {
        yaml: lines.slice(1, i).join("\n"),
        body: lines.slice(i + 1).join("\n"),
        bodyLine: i + 2,
      };
    }
  }
  return { yaml: null, body: src, bodyLine: 1 };
}

export type ParsedManifest =
  | {
      readonly ok: true;
      readonly name: string;
      readonly description: string;
      readonly modelInvocable: boolean;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * `Bun.YAML` exists on the required runtime (Bun >= 1.4.3, `engines.bun`) but
 * not in the pinned `@types/bun` 1.1.14, hence the narrow typed view.
 */
const yaml = (Bun as unknown as { YAML: { parse(text: string): unknown } }).YAML;

/** A spec-valid name: lowercase alnum + single hyphens, no edge hyphen. */
function nameProblem(name: string): string | undefined {
  if (name.length > MAX_NAME_CHARS) {
    return `is longer than ${MAX_NAME_CHARS} characters`;
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return "should be lowercase letters, digits and single hyphens";
  }
  return undefined;
}

function isTrue(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
}

/**
 * Parse and validate a `SKILL.md`, leniently (the agentskills.io client guide):
 * a name problem warns and still loads — a missing name falls back to the
 * directory name; no frontmatter, unparseable YAML or no description skips it.
 */
export function parseSkillManifest(text: string, dirName: string): ParsedManifest {
  const { yaml: fm } = splitFrontmatter(text);
  if (fm === null) {
    return { ok: false, reason: "no YAML frontmatter" };
  }
  let data: unknown;
  try {
    data = yaml.parse(fm);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { ok: false, reason: `unparseable frontmatter (${detail})` };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "frontmatter is not a key/value map" };
  }
  const meta = data as Record<string, unknown>;
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (description === "") {
    return { ok: false, reason: "no description" };
  }

  const warnings: string[] = [];
  let name: string;
  if (typeof meta.name === "string" && meta.name.trim() !== "") {
    name = meta.name.trim();
    if (name !== dirName) {
      warnings.push(`name "${name}" does not match its directory "${dirName}"`);
    }
  } else {
    name = dirName;
    warnings.push(`no name; using the directory name "${dirName}"`);
  }
  const problem = nameProblem(name);
  if (problem) {
    warnings.push(`name "${name}" ${problem}`);
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    warnings.push(`description is longer than ${MAX_DESCRIPTION_CHARS} characters (truncated)`);
  }
  if (meta["allowed-tools"] !== undefined) {
    warnings.push("`allowed-tools` is ignored (tools keep their normal permission prompts)");
  }
  return {
    ok: true,
    name,
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    modelInvocable: !isTrue(meta["disable-model-invocation"]),
    warnings,
  };
}

/**
 * Apply precedence: `candidates` arrive in precedence order (nearest project
 * root first, then the config dir, then `~/.agents/skills`); the first skill
 * with a name wins and every later one is reported as shadowed — never silent.
 */
export function mergeSkills(candidates: readonly SkillInfo[]): {
  skills: SkillInfo[];
  diagnostics: string[];
} {
  const byName = new Map<string, SkillInfo>();
  const diagnostics: string[] = [];
  for (const skill of candidates) {
    const winner = byName.get(skill.name);
    if (winner) {
      diagnostics.push(
        `skill "${skill.name}" at ${skill.location} is shadowed by ${winner.location}`,
      );
      continue;
    }
    byName.set(skill.name, skill);
  }
  return { skills: [...byName.values()], diagnostics };
}

/** Escape text for the XML-ish tags of the catalog. */
export function escapeSkillText(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The skills offered to the model — the catalog AND the `skill` tool's enum
 * (one rule, so the two never disagree): model-invocable, at most
 * `MAX_CATALOG_SKILLS`, in precedence order.
 */
export function offeredSkills(skills: readonly SkillInfo[]): SkillInfo[] {
  return skills.filter((s) => s.modelInvocable).slice(0, MAX_CATALOG_SKILLS);
}

/**
 * The catalog for the system prompt: name + description of each
 * model-invocable skill, `""` when there is none (the prompt then stays
 * byte-identical). Lists at most `MAX_CATALOG_SKILLS`.
 */
export function renderSkillsCatalog(skills: readonly SkillInfo[]): string {
  const visible = offeredSkills(skills);
  if (visible.length === 0) {
    return "";
  }
  const entries = visible.map(
    (s) =>
      `<skill>\n<name>${escapeSkillText(s.name)}</name>\n<description>${escapeSkillText(s.description)}</description>\n</skill>`,
  );
  return [
    SKILLS_PROMPT_HEADER,
    "",
    "Skills are packaged instructions for specific tasks. When a task matches a skill's description, call the `skill` tool with its name to load the full instructions BEFORE doing the task, then follow them.",
    "",
    "<available_skills>",
    ...entries,
    "</available_skills>",
  ].join("\n");
}

/** Diagnostic when more skills exist than the catalog lists, else undefined. */
export function catalogCapDiagnostic(skills: readonly SkillInfo[]): string | undefined {
  const visible = skills.filter((s) => s.modelInvocable).length;
  return visible > MAX_CATALOG_SKILLS
    ? `${visible} skills found; only the first ${MAX_CATALOG_SKILLS} are offered to the model`
    : undefined;
}
