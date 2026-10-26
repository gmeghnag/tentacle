/**
 * Parse a user-defined sub-agent definition: a Markdown file with optional
 * YAML-ish frontmatter (`name`, `description`, `tools`, `model`,
 * `contextWindow`) whose body is the agent's system prompt. `contextWindow` is
 * the window (tokens) of the type's `model`, for the child's context line
 * (docs/feat/context-awareness.md); absent → the parent's `model.contextWindow`.
 * Pure — directory loading lives in the wiring layer.
 *
 * Example:
 *   ---
 *   name: reviewer
 *   description: Review a diff for bugs. Use after writing code.
 *   tools: [fs_read, shell]
 *   model: my-big-model
 *   contextWindow: 200000
 *   ---
 *   You are a meticulous reviewer. Report only real bugs…
 */
import type { AgentType } from "./subagent.ts";

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export interface Frontmatter {
  readonly data: Record<string, string | string[]>;
  readonly body: string;
}

/** Split leading `---`-delimited frontmatter from the body (lenient). */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) {
    return { data: {}, body: text.trim() };
  }
  const data: Record<string, string | string[]> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      data[key] = raw
        .slice(1, -1)
        .split(",")
        .map((part) => unquote(part.trim()))
        .filter((part) => part.length > 0);
    } else {
      data[key] = unquote(raw);
    }
  }
  return { data, body: (match[2] ?? "").trim() };
}

/**
 * A frontmatter value as the user wrote it, for a warning message: an array
 * back to `[a, b]` (its items' quotes were stripped by `parseFrontmatter`), a
 * scalar in quotes. (A warned value is present, so never `undefined`.)
 */
function rawValue(value: string | string[]): string {
  return Array.isArray(value) ? `[${value.join(", ")}]` : JSON.stringify(value);
}

/**
 * Parse one agent definition; `fallbackName` is used when no `name` is given.
 * A present-but-invalid `model` (non-string / empty) or `contextWindow` (not a
 * positive whole number of tokens) is still IGNORED (the agent loads as if the
 * field were absent) but names the field + raw value in `warnings`, which the
 * wiring layer prefixes with the file path and reports (fix/agent-defs-warn).
 */
export function parseAgentDefinition(
  markdown: string,
  fallbackName: string,
): { type: AgentType; warnings: string[] } {
  const { data, body } = parseFrontmatter(markdown);
  const name = typeof data.name === "string" && data.name.length > 0 ? data.name : fallbackName;
  const description = typeof data.description === "string" ? data.description : "";
  const tools = Array.isArray(data.tools) ? data.tools : "all";
  const warnings: string[] = [];
  const modelValue = data.model;
  const model = typeof modelValue === "string" && modelValue.length > 0 ? modelValue : undefined;
  // Present-but-invalid (an empty string, or a non-string) → warn; absent → silent.
  if (model === undefined && modelValue !== undefined) {
    warnings.push(`model ${rawValue(modelValue)} ignored — expected a non-empty string`);
  }
  // A positive whole number of tokens (≤ 9 digits); anything else is ignored,
  // like a bad `model`.
  const window = data.contextWindow;
  const contextWindow =
    typeof window === "string" && /^[0-9]{1,9}$/.test(window) && Number(window) > 0
      ? Number(window)
      : undefined;
  // Present-but-invalid → warn; absent → silent. A 10+ digit value IS a positive
  // whole number, so name the 9-digit cap rather than "whole number" (Review nit 2).
  if (contextWindow === undefined && window !== undefined) {
    const overCap = typeof window === "string" && /^[0-9]{10,}$/.test(window);
    warnings.push(
      overCap
        ? `contextWindow ${rawValue(window)} ignored — exceeds the 9-digit cap (max 999999999 tokens)`
        : `contextWindow ${rawValue(window)} ignored — expected a positive whole number of tokens`,
    );
  }
  const prompt = body.length > 0 ? body : `You are the "${name}" sub-agent.`;
  return {
    type: {
      name,
      description,
      prompt,
      tools,
      ...(model ? { model } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    },
    warnings,
  };
}

/**
 * Merge user agent types over built-ins (same `name` → the user's wins),
 * preserving built-in order then appending new user types.
 */
export function mergeAgentTypes(
  builtins: readonly AgentType[],
  user: readonly AgentType[],
): AgentType[] {
  const byName = new Map<string, AgentType>();
  for (const type of builtins) {
    byName.set(type.name, type);
  }
  const order = builtins.map((t) => t.name);
  for (const type of user) {
    if (!byName.has(type.name)) {
      order.push(type.name);
    }
    byName.set(type.name, type);
  }
  return order.map((name) => byName.get(name)).filter((t): t is AgentType => t !== undefined);
}
