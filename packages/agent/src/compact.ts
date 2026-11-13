/**
 * Context compaction: summarise a conversation so the model keeps the thread
 * while shedding token weight. A one-off, tool-free model call turns the
 * transcript into a dense brief; the caller then rebuilds the history as the
 * system prompt + that brief + the skills that were active, each as a `skill`
 * round (docs/feat/skills-compaction.md). Pure w.r.t. the provider (injected).
 */
import type {
  ChatMessage,
  ChatRequest,
  ModelProvider,
  ModelStopReason,
  ToolCall,
} from "@tentacle/core";
import { attachmentLabel } from "@tentacle/core";

const COMPACT_SYSTEM =
  "You compress a coding-assistant conversation into a dense briefing for the " +
  "assistant to continue from. Preserve: the user's goals and constraints, " +
  "decisions made, key facts, file paths and identifiers, what was done, and " +
  "open tasks / next steps. Drop pleasantries and redundant detail. Write it as " +
  "notes, not prose. Do not add anything that was not in the conversation.";

const COMPACT_INSTRUCTION = "Summarise the following conversation as a briefing to continue from:";

/**
 * Render one message as a line of the transcript fed to the summariser. A
 * carried-over skill's result (`kept`: its name, matched by the message's
 * position — call ids may repeat across rounds) is not summarised: the rebuilt
 * history has it in full.
 */
function renderMessage(message: ChatMessage, kept: string | undefined): string {
  if (kept !== undefined) {
    return `TOOL: [skill "${kept}" — its instructions are re-loaded after compaction]`;
  }
  const role = message.role.toUpperCase();
  const calls =
    message.toolCalls && message.toolCalls.length > 0
      ? ` [called: ${message.toolCalls.map((c) => c.name).join(", ")}]`
      : "";
  // Images do NOT survive compaction (owner Q6): the summary learns that one
  // existed, by name, so it can say so — and never claims to have seen it.
  const images = (message.attachments ?? []).map((ref) => ` [image: ${attachmentLabel(ref)}]`);
  return `${role}: ${message.content}${calls}${images.join("")}`;
}

/**
 * Thrown when compaction cannot produce a usable summary. An empty summary
 * would irreversibly wipe the conversation (the history is replaced by the
 * system prompt + summary), so it is a hard failure that leaves the history
 * untouched instead.
 */
export class CompactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactError";
  }
}

/**
 * Read a summariser's stream to its end, keeping the text and the provider's
 * stop reason. One reader for both kinds of summary, so they judge a cut reply
 * identically (docs/fix/reask-budget-and-compact-length.md).
 */
async function collectSummary(
  model: ModelProvider,
  request: ChatRequest,
): Promise<{ text: string; stopReason: ModelStopReason | undefined }> {
  let text = "";
  let stopReason: ModelStopReason | undefined;
  for await (const event of model.stream(request)) {
    if (event.type === "text") {
      text += event.delta;
    } else if (event.type === "done") {
      stopReason = event.stopReason;
    }
  }
  return { text: text.trim(), stopReason };
}

/**
 * Why a summary is not usable, or `undefined` when it is. `length` is a reply
 * CUT at the model's output limit and `other` a stream that ended with no stop
 * reason at all — both incomplete data, not a short briefing (the same reading
 * the agent loop takes of a cut reply). `undefined` (a provider that does not
 * say) is accepted: failing every summary on such a provider would be worse
 * than the false negative.
 */
function cutReason(stopReason: ModelStopReason | undefined): "length" | "other" | undefined {
  return stopReason === "length" || stopReason === "other" ? stopReason : undefined;
}

/** What was cut, in the words the user reads. */
function cutCause(reason: "length" | "other"): string {
  return reason === "length" ? "the output limit" : "the stream ended without a stop reason";
}

/** What a cut-off compaction summary means, in the words the user sees. */
function cutMessage(reason: "length" | "other"): string {
  return `model's summary was cut off (${cutCause(reason)}) — conversation left intact — retry /compact, or raise the model's output limit`;
}

/**
 * Produce a compact summary of a conversation using the model (no tools).
 * `keep` lists the skills the rebuilt history carries over (`resultIndex`
 * into `messages`): their bodies are left out of the transcript.
 */
export async function summarizeConversation(
  model: ModelProvider,
  messages: readonly ChatMessage[],
  signal?: AbortSignal,
  keep: readonly CarriedSkill[] = [],
): Promise<string> {
  const keepAt = new Map(keep.map((k) => [k.resultIndex, k.name] as const));
  const transcript = messages
    .flatMap((m, i) => (m.role === "system" ? [] : [renderMessage(m, keepAt.get(i))]))
    .join("\n\n");
  const request: ChatRequest = {
    messages: [
      { role: "system", content: COMPACT_SYSTEM },
      {
        role: "user",
        content: `${COMPACT_INSTRUCTION}\n\n<transcript>\n${transcript}\n</transcript>`,
      },
    ],
    tools: [],
    ...(signal ? { signal } : {}),
  };
  const { text: summary, stopReason } = await collectSummary(model, request);
  // Checked BEFORE the empty test: a cut-and-empty reply is a cut summary, and
  // naming the real cause is what tells the user to raise the output limit
  // rather than hunt for a model that "returned nothing".
  const cut = cutReason(stopReason);
  if (cut !== undefined) {
    throw new CompactError(cutMessage(cut));
  }
  if (summary.length === 0) {
    // A thinking model may emit only `reasoning` events, or the server may
    // have errored in-band — either way there is no visible text. An empty
    // summary would replace the whole history with a blank brief, so fail
    // loudly before any state is mutated (see `Session.compact`).
    throw new CompactError(
      "model returned an empty summary — conversation left intact — retry /compact, or check the model emitted no visible text (a thinking model may have spent its budget on reasoning)",
    );
  }
  return summary;
}

const SUMMARIZE_TEXT_SYSTEM =
  "You condense a tool's output for a coding assistant. Keep the facts that matter " +
  "(results, errors, names, paths, numbers, structure) and drop noise and repetition. " +
  "Be terse; the full output remains available on disk. Do not invent anything.";

/** Summarise a block of tool output using the model (no tools). */
export async function summarizeText(
  model: ModelProvider,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const request: ChatRequest = {
    messages: [
      { role: "system", content: SUMMARIZE_TEXT_SYSTEM },
      { role: "user", content: `Summarise this output:\n\n<output>\n${text}\n</output>` },
    ],
    tools: [],
    ...(signal ? { signal } : {}),
  };
  const { text: summary, stopReason } = await collectSummary(model, request);
  // A cut summary is not the output condensed, it is the output's beginning
  // with the rest missing. Throw: the pipeline's own catch renders the honest
  // "summary failed" pointer, and the full output is already spilled to disk.
  const cut = cutReason(stopReason);
  if (cut !== undefined) {
    throw new Error(`model's summary was cut off (${cutCause(cut)})`);
  }
  return summary;
}

export interface CompactResult {
  readonly summary: string;
  readonly before: number;
  readonly after: number;
}

/**
 * The most skill content (chars) a compaction carries over. Two bodies at the
 * `skill` tool's cap, or about 20 typical skills: past this, compaction would
 * free too little context.
 */
export const MAX_KEPT_SKILL_CHARS = 100_000;

/**
 * Where a carried-over skill's content comes from: `fresh` — `SKILL.md` read
 * again; otherwise the copy from the history, because the read failed
 * (`unreadable`) or the skill is no longer offered — removed, hidden, or
 * skills disabled (`unavailable`, nothing was read).
 */
export type CarriedSkillSource = "fresh" | "unreadable" | "unavailable";

/** An active skill, with the content compaction would carry over. */
export interface CarriedSkill {
  readonly name: string;
  /** The original activation call, reused as is. */
  readonly call: ToolCall;
  readonly content: string;
  readonly source: CarriedSkillSource;
  /** Index of the activation's result message in the compacted history. */
  readonly resultIndex: number;
}

/** What a compaction carries over of the active skills. */
export interface SkillCarryOver {
  /** Re-loaded after the summary, in activation order. */
  readonly kept: readonly CarriedSkill[];
  /** Over the budget: named in the summary, not re-loaded (so loadable again). */
  readonly dropped: readonly string[];
}

const NO_SKILLS: SkillCarryOver = { kept: [], dropped: [] };

/**
 * Split the active skills (activation order) into kept and dropped: keep the
 * most recent ones while their contents fit in `budget`; the first that does
 * not fit, and every older one, is dropped.
 */
export function carryOverSkills(
  skills: readonly CarriedSkill[],
  budget = MAX_KEPT_SKILL_CHARS,
): SkillCarryOver {
  let used = 0;
  let firstKept = skills.length;
  for (let i = skills.length - 1; i >= 0; i--) {
    const size = skills[i]?.content.length ?? 0;
    if (used + size > budget) {
      break;
    }
    used += size;
    firstKept = i;
  }
  return {
    kept: skills.slice(firstKept),
    dropped: skills.slice(0, firstKept).map((s) => s.name),
  };
}

/**
 * The note closing the summary (or a context reset's restart message) when
 * skills are carried over (or dropped); `before` names the replacement.
 */
export function skillsNote(
  { kept, dropped }: SkillCarryOver,
  before: "compaction" | "the context reset" = "compaction",
): string {
  const list = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(", ");
  const lines: string[] = [];
  if (kept.length > 0) {
    lines.push(
      `The skills active before ${before} are loaded again below; their instructions still apply: ${list(kept.map((k) => k.name))}.`,
    );
    const from = (source: CarriedSkillSource): string[] =>
      kept.filter((k) => k.source === source).map((k) => k.name);
    const unreadable = from("unreadable");
    if (unreadable.length > 0) {
      lines.push(
        `SKILL.md could not be read again for ${list(unreadable)}: the earlier copy is loaded instead.`,
      );
    }
    const unavailable = from("unavailable");
    if (unavailable.length > 0) {
      lines.push(
        `No longer in the Skills list: ${list(unavailable)}. The earlier copy is loaded instead.`,
      );
    }
  }
  if (dropped.length > 0) {
    lines.push(
      `Not loaded again (too much skill content to keep): ${list(dropped)}. Load one again with the skill tool if it is still needed.`,
    );
  }
  return lines.join("\n");
}

/**
 * Background work still running when the history is replaced (a compaction or a
 * context reset), told to the model so it does not forget or relaunch it: shell
 * jobs (read/kill with their tools) and sub-agents (each report arrives later
 * as a [background] note). `""` when nothing runs.
 */
export function stillRunningNote(
  jobs: readonly { readonly id: string; readonly command: string }[],
  agents: readonly { readonly agentId: string; readonly description: string }[],
): string {
  const parts: string[] = [];
  if (jobs.length > 0) {
    parts.push(
      `Background jobs still running (shell_output / shell_kill):\n${jobs
        .map((j) => `- ${j.id}: \`${j.command}\``)
        .join("\n")}`,
    );
  }
  if (agents.length > 0) {
    parts.push(
      `Background sub-agents still running (each report arrives later as a [background] note):\n${agents
        .map((a) => `- ${a.agentId}: ${a.description}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * Build the post-compaction history: keep the leading system message (if any),
 * then a single user message carrying the summary, then one `skill` round per
 * carried-over skill — the shape the `skill` tool's own activation leaves, so
 * the skill reads as active (dedup) and a later compaction finds it again.
 * With no skill to carry, the output is exactly system + summary.
 */
export function compactedHistory(
  messages: readonly ChatMessage[],
  summary: string,
  skills: SkillCarryOver = NO_SKILLS,
  /** `stillRunningNote(...)`: the background work running at the compaction. */
  running = "",
): ChatMessage[] {
  const next: ChatMessage[] = [];
  const system = messages.find((m) => m.role === "system");
  if (system) {
    next.push(system);
  }
  const note = skillsNote(skills);
  next.push({
    role: "user",
    content: `Summary of the earlier conversation (compacted to save context):\n\n${summary}${running === "" ? "" : `\n\n${running}`}${note === "" ? "" : `\n\n${note}`}`,
  });
  for (const skill of skills.kept) {
    next.push({ role: "assistant", content: "", toolCalls: [skill.call] });
    next.push({ role: "tool", content: skill.content, toolCallId: skill.call.id });
  }
  return next;
}
