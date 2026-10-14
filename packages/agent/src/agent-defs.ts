/**
 * Parse a user-defined sub-agent definition: a Markdown file with optional
 * YAML-ish frontmatter (`name`, `description`, `tools`, `model`) whose body is
 * the agent's system prompt. Pure — directory loading lives in the wiring layer.
 *
 * Example:
 *   ---
 *   name: reviewer
 *   description: Review a diff for bugs. Use after writing code.
 *   tools: [fs_read, shell]
 *   model: my-big-model
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

/** Parse one agent definition; `fallbackName` is used when no `name` is given. */
export function parseAgentDefinition(markdown: string, fallbackName: string): AgentType {
  const { data, body } = parseFrontmatter(markdown);
  const name = typeof data.name === "string" && data.name.length > 0 ? data.name : fallbackName;
  const description = typeof data.description === "string" ? data.description : "";
  const tools = Array.isArray(data.tools) ? data.tools : "all";
  const model = typeof data.model === "string" && data.model.length > 0 ? data.model : undefined;
  const prompt = body.length > 0 ? body : `You are the "${name}" sub-agent.`;
  return { name, description, prompt, tools, ...(model ? { model } : {}) };
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
