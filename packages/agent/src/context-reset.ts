/**
 * The model's context reset (docs/feat/context-reset.md) — pure.
 *
 * The restart message is the first user message of a reset history: this
 * header, then the model's restart prompt in a `<restart_prompt>` block, then
 * whatever tentacle appends (running jobs, the skills note, a usage line).
 * `restartPromptOf` reads it back for DISPLAY only (a separator and a
 * "restart prompt" row, on every path: live, a resync, `--resume`); no
 * decision is ever taken from it — those stay structural.
 */

import type { ChatMessage, ToolDefinition } from "@tentacle/core";
import { SKILL_TOOL_NAME } from "@tentacle/tools";
import { type SkillCarryOver, skillsNote } from "./compact.ts";

export const CONTEXT_RESET_HEADER =
  "[context reset] You renewed your own context with context_reset.\nEverything before it was discarded. Your restart prompt:";

const OPEN = "\n<restart_prompt>\n";
const CLOSE = "\n</restart_prompt>";

/** The restart message's head: the header and the prompt's block (callers append the rest). */
export function restartMessage(prompt: string): string {
  return `${CONTEXT_RESET_HEADER}${OPEN}${prompt}${CLOSE}`;
}

/**
 * The restart prompt a `restartMessage` carries, or null for any other
 * content. The LAST closing tag ends the block: a prompt may quote the tag,
 * what tentacle appends never does.
 */
export function restartPromptOf(content: string): string | null {
  const head = `${CONTEXT_RESET_HEADER}${OPEN}`;
  if (!content.startsWith(head)) {
    return null;
  }
  const end = content.lastIndexOf(CLOSE);
  return end < head.length ? null : content.slice(head.length, end);
}

/** A background job still running at the reset, named in the restart message. */
export interface RunningJob {
  readonly id: string;
  readonly command: string;
}

/**
 * The history a context reset installs: the system prompt rebuilt fresh, ONE
 * user message — `restartMessage(prompt)`, the jobs still running, the skills
 * note — then one `skill` round per carried skill (compaction's shape, so the
 * skill reads as active). Everything before, the reset's own call included,
 * is gone: no orphan call.
 */
export function contextResetHistory(input: {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly jobs: readonly RunningJob[];
  readonly skills: SkillCarryOver;
}): ChatMessage[] {
  const parts = [restartMessage(input.prompt)];
  if (input.jobs.length > 0) {
    parts.push(
      `Background jobs still running (shell_output / shell_kill):\n${input.jobs
        .map((j) => `- ${j.id}: \`${j.command}\``)
        .join("\n")}`,
    );
  }
  const note = skillsNote(input.skills, "the context reset");
  if (note !== "") {
    parts.push(note);
  }
  const next: ChatMessage[] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: parts.join("\n\n") },
  ];
  for (const skill of input.skills.kept) {
    next.push({ role: "assistant", content: "", toolCalls: [skill.call] });
    next.push({ role: "tool", content: skill.content, toolCallId: skill.call.id });
  }
  return next;
}

/** The restart prompt of a call's input: a non-blank `prompt` string, else null. */
export function resetPromptOf(input: unknown): string | null {
  const prompt =
    typeof input === "object" && input !== null
      ? (input as { prompt?: unknown }).prompt
      : undefined;
  return typeof prompt === "string" && prompt.trim() !== "" ? prompt : null;
}

/**
 * Why a `context_reset` call is refused (a tool error the model reads), or
 * null when it may go on to the approval. Checked BEFORE the gate: nothing is
 * asked for a call that cannot run. `calls`: the tool calls of its assistant
 * message; `maxPerMessage` -1 = unlimited.
 */
export function resetRefusal(input: {
  readonly calls: number;
  readonly prompt: unknown;
  readonly otherCallSinceReset: boolean;
  readonly resetsThisMessage: number;
  readonly maxPerMessage: number;
}): string | null {
  if (input.calls !== 1) {
    return "context_reset refused: it must be the only tool call of its message (the other results would be discarded with the context). Call it alone.";
  }
  if (resetPromptOf({ prompt: input.prompt }) === null) {
    return "context_reset refused: the restart prompt is empty. Write the self-sufficient text you continue from.";
  }
  if (!input.otherCallSinceReset) {
    return "context_reset refused: no other tool call since your previous context reset. Work on the task first.";
  }
  if (input.maxPerMessage !== -1 && input.resetsThisMessage >= input.maxPerMessage) {
    return `context_reset refused: the limit of ${input.maxPerMessage} context reset(s) per user message is reached. Continue in this context.`;
  }
  return null;
}

/** The names a `skill` tool definition offers (its `name` enum); none → []. */
export function offeredSkillNames(definitions: readonly ToolDefinition[]): string[] {
  const skill = definitions.find((d) => d.name === SKILL_TOOL_NAME);
  const names = (skill?.parameters as { properties?: { name?: { enum?: unknown } } } | undefined)
    ?.properties?.name?.enum;
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
}

/** The skill-set change a reset made, for its result row: "skills: + a, − b", or "". */
export function skillSetDelta(before: readonly string[], after: readonly string[]): string {
  const added = after.filter((n) => !before.includes(n));
  const removed = before.filter((n) => !after.includes(n));
  const parts = [
    ...(added.length > 0 ? [`+ ${added.join(", ")}`] : []),
    ...(removed.length > 0 ? [`− ${removed.join(", ")}`] : []),
  ];
  return parts.length > 0 ? `skills: ${parts.join(", ")}` : "";
}
