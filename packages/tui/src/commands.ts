/**
 * Slash-command vocabulary and the pure helpers behind them (transcript export,
 * last-message lookup, help text). Side effects (clipboard, file writes, session
 * reset) live in the App; everything here is pure and testable.
 */
import type { DisplayItem } from "./state.ts";

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/help", description: "show this help" },
  { name: "/clear", description: "clear the transcript and start a fresh session" },
  { name: "/compact", description: "summarise the conversation to free up context" },
  { name: "/model", description: "show the active model" },
  { name: "/retry", description: "re-send the last prompt" },
  { name: "/copy", description: "copy the last assistant reply to the clipboard" },
  { name: "/save", description: "save the transcript to a Markdown file" },
  { name: "/tokens", description: "show token usage for the session" },
  { name: "/exit", description: "quit (also /quit)" },
];

// Commands that start a new turn or swap/mutate the session's history. Running
// one mid-turn is unsafe: `/retry` would start a *second* concurrent `send` on
// the same session (both mutate its messages/steering) and clobber the abort
// handle; `/clear` swaps the session under a live turn. The App rejects these
// while a turn is running. (`/compact` guards itself with a tailored message.)
const SESSION_MUTATING = new Set(["/retry", "/clear"]);

/** Whether `command` (the leading token, e.g. "/retry") must wait for an idle turn. */
export function isSessionMutating(command: string): boolean {
  return SESSION_MUTATING.has(command);
}

/**
 * What a quit request (`/exit`, `/quit`, Ctrl+C) does. Quitting mid-turn first
 * stops the turn and waits for it to settle — that is where the session is
 * saved — then exits; a second request while that stop is pending quits at once
 * (a turn that won't stop must not trap the user). Ctrl+C mid-turn only stops
 * the turn (it never quits on the first press).
 */
export function quitAction(
  source: "command" | "ctrl-c",
  running: boolean,
  exitPending: boolean,
): "exit" | "stop-then-exit" | "stop" {
  if (!running || exitPending) {
    return "exit";
  }
  return source === "command" ? "stop-then-exit" : "stop";
}

/**
 * Commands matching what the user is typing, for the autocomplete palette.
 * Active only while typing the command name itself: the input must start with
 * "/" and contain no space yet (once there's a space the name is complete and
 * the user is typing arguments). A bare "/" lists everything. Case-insensitive.
 */
export function matchCommands(input: string): readonly SlashCommand[] {
  if (!input.startsWith("/") || /\s/.test(input)) {
    return [];
  }
  const prefix = input.toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(prefix));
  // An exact, unambiguous match means the name is fully typed — nothing to
  // suggest, so the palette closes.
  if (matches.length === 1 && matches[0]?.name.toLowerCase() === prefix) {
    return [];
  }
  return matches;
}

/** Markdown help block listing the commands. */
export function helpText(): string {
  const rows = SLASH_COMMANDS.map((c) => `- \`${c.name}\` — ${c.description}`).join("\n");
  return `**Commands**\n${rows}\n\n**Keys**: Shift+Tab auto-accept tools · \\+Enter newline · Ctrl+C stop/quit`;
}

/** The text of the most recent assistant reply, or null. */
export function lastAssistantText(items: readonly DisplayItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "assistant") {
      return item.text;
    }
  }
  return null;
}

/** The text of the most recent user prompt, or null. */
export function lastUserText(items: readonly DisplayItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "user") {
      return item.text;
    }
  }
  return null;
}

/** Render the transcript as a plain Markdown document. */
export function transcriptToMarkdown(items: readonly DisplayItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      parts.push(`## User\n\n${item.text}`);
    } else if (item.kind === "assistant") {
      if (item.text.trim() !== "") {
        parts.push(`## Assistant\n\n${item.text}`);
      }
    } else if (item.kind === "notice") {
      parts.push(`> ${item.text}`);
    } else {
      const status = item.status === "ok" ? "✔" : item.status === "error" ? "✘" : "⟳";
      const lines = [`### Tool ${status} \`${item.name}\``, "", "```", item.args, "```"];
      if (item.detail?.kind === "diff") {
        lines.push("", "```diff", item.detail.patch.replace(/\n+$/, ""), "```");
      } else if (item.resultText && item.resultText.trim() !== "") {
        lines.push("", "```", item.resultText.replace(/\n+$/, ""), "```");
      }
      parts.push(lines.join("\n"));
    }
  }
  return `${parts.join("\n\n")}\n`;
}
