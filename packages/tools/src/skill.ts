/**
 * The `skill` tool — the model activates an Agent Skill by name and gets its
 * full instructions (tier 2 of progressive disclosure). Discovery and the
 * catalog live in `@tentacle/config`; reading the body is injected (as the
 * `agent_task` runner is), so this package stays parser-free. Design:
 * docs/feat/skills-core.md.
 *
 * Whether a skill is already active is DERIVED from the history (its marker
 * in a `skill` result), never kept as separate state: it stays right across
 * resume and re-attach, and compaction carries an active skill over by
 * re-running its activation (docs/feat/skills-compaction.md).
 */
import type { ChatMessage, Tool, ToolCall, ToolContext, ToolResult } from "@tentacle/core";
import { z } from "zod";

export const SKILL_TOOL_NAME = "skill";

/**
 * A body longer than this is cut on a line boundary with a pointer to the
 * rest. The `skill` result is exempt from the spill/summary transforms (so a
 * skill is never silently reduced to a preview), so it bounds itself here.
 */
export const MAX_SKILL_BODY_CHARS = 50_000;

/** What the tool needs to know about a skill (a structural subset of the config's `SkillInfo`). */
export interface SkillToolEntry {
  readonly name: string;
  readonly location: string;
  readonly dir: string;
  readonly files: readonly string[];
  readonly filesTruncated: boolean;
}

/** A skill's Markdown body and the 1-based file line it starts on. */
export interface SkillBody {
  readonly body: string;
  readonly bodyLine: number;
}

/** Reads a skill's current body (at activation, so an edit needs no restart). */
export type SkillBodyReader = (skill: SkillToolEntry, ctx: ToolContext) => Promise<SkillBody>;

function escapeAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function unescapeAttr(s: string): string {
  return s
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

const MARKER = /^<skill_content name="([^"]*)">/;

/** The skill a `skill` result loaded (its opening marker), or undefined. */
export function skillContentName(content: string): string | undefined {
  const match = MARKER.exec(content);
  return match?.[1] !== undefined ? unescapeAttr(match[1]) : undefined;
}

/** One skill loaded in a history: the `skill` call and the content it returned. */
export interface SkillActivation {
  readonly name: string;
  readonly call: ToolCall;
  readonly content: string;
  /** Index in the history of the result message (ids alone may repeat across rounds). */
  readonly resultIndex: number;
}

/**
 * The skills loaded in `history`, in activation order: a `skill` call whose
 * result opens with the `<skill_content name="…">` marker; the first one per
 * name. An error result, a dedup note or another tool's output never counts.
 * A result is paired with a call of the assistant message before it (where
 * the loop always writes it), so a server that reuses call ids across rounds
 * cannot pair it with another round's call.
 */
export function skillActivations(history: readonly ChatMessage[]): SkillActivation[] {
  let skillCalls = new Map<string, ToolCall>();
  const activations: SkillActivation[] = [];
  for (const [index, message] of history.entries()) {
    if (message.role === "assistant") {
      skillCalls = new Map(
        (message.toolCalls ?? [])
          .filter((c) => c.name === SKILL_TOOL_NAME)
          .map((c) => [c.id, c] as const),
      );
      continue;
    }
    const call =
      message.role === "tool" && message.toolCallId !== undefined
        ? skillCalls.get(message.toolCallId)
        : undefined;
    if (!call) {
      continue;
    }
    const name = skillContentName(message.content);
    if (name !== undefined && !activations.some((a) => a.name === name)) {
      activations.push({ name, call, content: message.content, resultIndex: index });
    }
  }
  return activations;
}

/** Names of the skills whose content is in `history`, in activation order. */
export function activeSkillNames(history: readonly ChatMessage[]): string[] {
  return skillActivations(history).map((a) => a.name);
}

/** The activation result: marker, (bounded) body, directory, bundled files. */
export function formatSkillContent(skill: SkillToolEntry, { body, bodyLine }: SkillBody): string {
  let shown = body;
  let note = "";
  if (body.length > MAX_SKILL_BODY_CHARS) {
    const lineCount = (s: string): number => s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
    const newline = body.lastIndexOf("\n", MAX_SKILL_BODY_CHARS - 1);
    // Cut after a newline; a single over-long line is cut mid-line, and then
    // the continuation starts on that same line.
    const cut = newline >= 0 ? newline + 1 : MAX_SKILL_BODY_CHARS;
    shown = body.slice(0, cut);
    const keptLines = lineCount(shown);
    const totalLines = lineCount(body);
    const next = bodyLine + (newline >= 0 ? keptLines : keptLines - 1);
    note = `\n[skill body truncated after ${keptLines} of ${totalLines} lines — read the rest with fs_read \`${skill.location}:${next}\`]`;
  }
  const lines = [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    `${shown.replace(/^(\s*\n)+/, "").trimEnd()}${note}`,
    "",
    `Skill directory: ${skill.dir}`,
    "Relative paths in this skill resolve against that directory. Read bundled files with fs_read only when the instructions call for them.",
  ];
  if (skill.files.length > 0) {
    lines.push(
      "<skill_resources>",
      ...skill.files.map((f) => `<file>${escapeAttr(f)}</file>`),
      ...(skill.filesTruncated ? ["(more files not listed)"] : []),
      "</skill_resources>",
    );
  }
  lines.push("</skill_content>");
  return lines.join("\n");
}

/** A skill the activator can load, and whether the USER may (`/name`). */
export interface SkillActivatorEntry extends SkillToolEntry {
  readonly userInvocable: boolean;
}

/**
 * The one path that activates a skill — for the model (the `skill` tool), for
 * the user (`/name`, a `skill` round the agent writes before the model's first
 * round) and for `/compact` (the re-read). It knows every activatable skill,
 * including the ones hidden from the model (`disable-model-invocation`); the
 * tool's enum is the model's narrower gate. docs/feat/skills-slash.md.
 */
export interface SkillActivator {
  /** Whether `name` can be activated at all. */
  has(name: string): boolean;
  /** Whether the user may activate `name` with `/name`. */
  userInvocable(name: string): boolean;
  /**
   * Load `name`: its content; the "already loaded" note when `ctx.history`
   * has it; an `isError` result when it is unknown or cannot be read.
   * Never throws.
   */
  activate(name: string, ctx: ToolContext): Promise<ToolResult>;
}

export function createSkillActivator(
  entries: readonly SkillActivatorEntry[],
  readBody: SkillBodyReader,
): SkillActivator {
  const byName = new Map(entries.map((s) => [s.name, s] as const));
  return {
    has: (name) => byName.has(name),
    userInvocable: (name) => byName.get(name)?.userInvocable === true,
    async activate(name, ctx) {
      const skill = byName.get(name);
      if (!skill) {
        return { content: `Unknown skill "${name}".`, isError: true };
      }
      if (activeSkillNames(ctx.history ?? []).includes(name)) {
        return {
          content: `Skill "${name}" is already loaded: its instructions are earlier in this conversation (<skill_content name="${escapeAttr(name)}">). Follow them; there is no need to load it again.`,
        };
      }
      let body: SkillBody;
      try {
        body = await readBody(skill, ctx);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          content: `Could not read skill "${name}" (${skill.location}): ${detail}`,
          isError: true,
        };
      }
      return { content: formatSkillContent(skill, body) };
    },
  };
}

/** The `skill` call the loop writes when the USER activates `name` (`/name`). */
export function userSkillCall(name: string): ToolCall {
  return { id: crypto.randomUUID(), name: SKILL_TOOL_NAME, arguments: JSON.stringify({ name }) };
}

/**
 * Build the `skill` tool for the skills offered to the model (the same list
 * as the system-prompt catalog), or undefined when there is none — then the
 * tool is not registered at all. `name` is an enum, so a model cannot invent
 * a skill or a path. The activation itself is the activator's.
 */
export function createSkillTool(
  skills: readonly SkillToolEntry[],
  readBody: SkillBodyReader,
): Tool | undefined {
  const [first, ...rest] = skills.map((s) => s.name);
  if (first === undefined) {
    return undefined;
  }
  const activator = createSkillActivator(
    skills.map((s) => ({ ...s, userInvocable: false })),
    readBody,
  );
  const inputSchema = z.object({
    name: z.enum([first, ...rest]).describe("The skill to load, from the Skills list"),
  });

  return {
    name: SKILL_TOOL_NAME,
    description:
      'Load a skill: packaged instructions for a specific kind of task. When the task matches a skill listed under "# Skills" in the system prompt, call this FIRST with the skill\'s name, then follow the instructions it returns. A skill already loaded in this conversation does not need loading again.',
    inputSchema,
    permission: "none",
    execute(input, ctx): Promise<ToolResult> {
      const { name } = input as z.infer<typeof inputSchema>;
      return activator.activate(name, ctx);
    },
  };
}
