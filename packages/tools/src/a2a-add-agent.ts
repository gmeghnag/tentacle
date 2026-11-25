import {
  A2A_ADD_AGENT_TOOL,
  type PermissionRequester,
  type Tool,
  type ToolResult,
} from "@tentacle/core";
/**
 * `a2a_add_agent` (docs/feat/a2a-client.md C11): the model PROPOSES a remote
 * A2A agent by its card URL; the owner approves it once, for THIS session.
 * Offered only where remote agents may run (the laptop / a `serve` the user
 * owns, never a pod — the wiring's `!tunnelled`). The checks, the card read and
 * the registry are injected (they live with the adapter, `@tentacle/agent`).
 */
import { z } from "zod";

/** A card that passed the checks: its origin and its text, marked remote. */
export interface A2AAddAgentChecked {
  readonly ok: true;
  readonly origin: string;
  readonly summary: string;
}

export interface A2AAddAgentDeps<T extends A2AAddAgentChecked> {
  /** C11 steps 1–2: URL rules, card read, card checks, no-credentials rule. */
  inspect(
    cardUrl: string,
    signal: AbortSignal,
  ): Promise<T | { readonly ok: false; readonly reason: string }>;
  /** The agent already added this session for `origin`: no new ask. */
  existing(origin: string): { readonly type: string; readonly summary: string } | undefined;
  /** C11 step 4, after the owner's yes: register it; its `a2a:<name>` type. */
  register(checked: T): {
    readonly type: string;
    readonly summary: string;
  };
  /** The session's ONE broker (AGENTS §7). */
  ask: PermissionRequester;
}

const inputSchema = z.object({
  card_url: z.string().min(1).max(2048).describe("The agent card's https URL"),
  reason: z
    .string()
    .min(1)
    .max(1000)
    .describe("Why this agent, in one sentence (shown to the user)"),
});
type Input = z.infer<typeof inputSchema>;

/** One line, no control/format characters: the model's text in the ask. */
function line(text: string, cap: number): string {
  const flat = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

function added(type: string, summary: string, again: boolean): ToolResult {
  return {
    content: `${again ? "Already added in this session" : "Added for this session"}: call it with agent_task subagent_type "${type}". Every task sent to it still needs the user's OK; it lasts until /clear. ${summary}`,
  };
}

export function createA2AAddAgentTool<T extends A2AAddAgentChecked>(
  deps: A2AAddAgentDeps<T>,
): Tool<Input> {
  return {
    name: A2A_ADD_AGENT_TOOL,
    description:
      "Propose a remote A2A agent nobody configured, by its agent card URL (https). The user is asked; if they approve, it can be used with agent_task for this session only. An agent that needs credentials must be configured by the user instead.",
    inputSchema,
    // It raises its OWN ask (`agent_add`): never a generic tool ask auto-accept could answer.
    permission: "none",
    async execute(input, ctx): Promise<ToolResult> {
      const cardUrl = input.card_url.trim();
      const origin = URL.canParse(cardUrl) ? new URL(cardUrl).origin : undefined;
      const known = origin !== undefined ? deps.existing(origin) : undefined;
      if (known !== undefined) return added(known.type, known.summary, true);
      const checked = await deps.inspect(cardUrl, ctx.signal);
      if (!checked.ok) {
        return { content: `not added: ${line(checked.reason, 400)}`, isError: true };
      }
      const answer = await deps.ask(
        {
          kind: "agent_add",
          tool: A2A_ADD_AGENT_TOOL,
          level: "ask",
          title: "Use a new remote agent?",
          detail: [
            `URL: ${line(cardUrl, 2048)}`,
            `Origin: ${checked.origin} · public address`,
            `Model's reason: ${line(input.reason, 1000)}`,
            `Remote card text: ${checked.summary}`,
            "For this session only; every task sent to it is asked again.",
          ].join("\n"),
          input: { card_url: cardUrl, origin: checked.origin },
        },
        {
          ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
          origin: "call",
          signal: ctx.signal,
        },
      );
      if (!answer.allowed) {
        if (answer.reason !== undefined) {
          return { content: `not added: no one could be asked (${answer.reason})`, isError: true };
        }
        return {
          content: `not added: the user declined ${checked.origin}${answer.message ? ` — they said: ${line(answer.message, 1000)}` : ""}`,
          isError: true,
        };
      }
      // Two proposals of one origin asked at once: the first yes registers it.
      const raced = deps.existing(checked.origin);
      if (raced !== undefined) return added(raced.type, raced.summary, true);
      const reg = deps.register(checked);
      return added(reg.type, reg.summary, false);
    },
  };
}
