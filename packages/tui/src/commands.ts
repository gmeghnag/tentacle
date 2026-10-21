/**
 * Slash-command vocabulary and the pure helpers behind them (transcript export,
 * last-message lookup, help text). Side effects (clipboard, file writes, session
 * reset) live in the App; everything here is pure and testable.
 *
 * Skills join the vocabulary as `/name` (docs/feat/skills-slash.md): the
 * daemon's catalog arrives over RPC, and `resolveSlash` is the ONE place that
 * decides whether typed text activates a skill — by an exact match of its
 * first token, never by parsing the rest.
 */
import type { DisplayItem } from "./state.ts";

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  /** True for a skill's `/name` entry (vs a built-in command). */
  readonly skill?: boolean;
}

/** A skill the user can activate, as the daemon's catalog lists it. */
export interface SlashSkill {
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
  { name: "/mcp", description: "list the MCP servers and whether each is reachable" },
  { name: "/exit", description: "quit (also /quit)" },
];

/** Names the built-ins own (`/quit` is `/exit`'s alias): a skill can never take one. */
const BUILTIN_NAMES: ReadonlySet<string> = new Set([...SLASH_COMMANDS.map((c) => c.name), "/quit"]);

/**
 * One display line: control characters and runs of whitespace become one
 * space; bidi overrides/isolates and zero-width characters (which can make a
 * pod-supplied description display differently from what it says) are dropped.
 */
function oneLine(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ")
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
      .trim()
  );
}

export interface SlashCatalog {
  /** The built-ins, then one `/name` entry per skill, in catalog order. */
  readonly commands: readonly SlashCommand[];
  /** The skill names that may be activated (`/name`). */
  readonly skillNames: ReadonlySet<string>;
  /** Skills whose `/name` is a built-in's: the built-in wins; named in `/help`. */
  readonly shadowed: readonly string[];
}

/** Merge the built-ins with the daemon's skills. */
export function slashCatalog(skills: readonly SlashSkill[]): SlashCatalog {
  const commands: SlashCommand[] = [...SLASH_COMMANDS];
  const skillNames = new Set<string>();
  const shadowed: string[] = [];
  for (const skill of skills) {
    const command = `/${skill.name}`;
    if (BUILTIN_NAMES.has(command)) {
      shadowed.push(skill.name);
    } else if (!skillNames.has(skill.name)) {
      skillNames.add(skill.name);
      commands.push({ name: command, description: oneLine(skill.description), skill: true });
    }
  }
  return { commands, skillNames, shadowed };
}

/** What typed `/…` text is. */
export type SlashResolution =
  | { readonly kind: "builtin"; readonly command: string }
  /** `text` is what the user typed, sent verbatim as the prompt with the activation. */
  | { readonly kind: "skill"; readonly name: string; readonly text: string }
  | { readonly kind: "unknown"; readonly command: string };

/**
 * Resolve text that starts with `/`. Its first token (up to the first
 * whitespace) must be a built-in, or `/` + EXACTLY a catalog skill name; the
 * rest is the user's words and is never parsed. `/tmp/x`, `/deploy-app/x`
 * or `/Deploy-App` select nothing (`unknown`).
 */
export function resolveSlash(text: string, skills: readonly SlashSkill[]): SlashResolution {
  const command = text.split(/\s/, 1)[0] ?? text;
  if (BUILTIN_NAMES.has(command)) {
    return { kind: "builtin", command };
  }
  const name = command.slice(1);
  if (command.startsWith("/") && slashCatalog(skills).skillNames.has(name)) {
    return { kind: "skill", name, text };
  }
  return { kind: "unknown", command };
}

/** What `/retry` re-sends: the last prompt, or the last skill activation again. */
export type RetryPlan =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "skill"; readonly name: string; readonly text: string }
  /** The last prompt activated a skill the daemon no longer offers. */
  | { readonly kind: "gone"; readonly command: string };

/**
 * Plan a `/retry` of `last` (the last user prompt). A prompt starting with
 * `/` can only have been a skill activation (any other `/…` is a command,
 * never sent), so it is resolved again — a retried activation stays one.
 */
export function retryPlan(last: string, skills: readonly SlashSkill[]): RetryPlan {
  if (!last.startsWith("/")) {
    return { kind: "prompt", text: last };
  }
  const resolved = resolveSlash(last, skills);
  return resolved.kind === "skill" ? resolved : { kind: "gone", command: resolved.command };
}

/** At most this many palette rows are shown (a window that follows the selection). */
export const PALETTE_MAX_ROWS = 8;

/**
 * The slice `[start, end)` of `count` palette rows to show so that `selected`
 * is visible, at most `maxRows` long. Stateless: the first `maxRows` rows
 * while the selection is among them, else the window ending at the selection.
 */
export function paletteWindow(
  count: number,
  selected: number,
  maxRows: number = PALETTE_MAX_ROWS,
): { readonly start: number; readonly end: number } {
  const rows = Math.max(0, Math.min(count, maxRows));
  if (rows === 0) {
    return { start: 0, end: 0 };
  }
  const sel = Math.min(Math.max(0, selected), count - 1);
  const start = Math.min(Math.max(0, sel - rows + 1), count - rows);
  return { start, end: start + rows };
}

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
export function matchCommands(
  input: string,
  skills: readonly SlashSkill[] = [],
): readonly SlashCommand[] {
  if (!input.startsWith("/") || /\s/.test(input)) {
    return [];
  }
  const prefix = input.toLowerCase();
  const matches = slashCatalog(skills).commands.filter((c) =>
    c.name.toLowerCase().startsWith(prefix),
  );
  // An exact, unambiguous match means the name is fully typed — nothing to
  // suggest, so the palette closes.
  if (matches.length === 1 && matches[0]?.name.toLowerCase() === prefix) {
    return [];
  }
  // An exact match that is also a prefix of others (`/deploy` vs
  // `/deploy-prod`, a skill `/c` vs `/clear`) goes first: the default
  // selection, so Enter and Tab act on what was typed, not on catalog order.
  const exact = matches.findIndex((c) => c.name.toLowerCase() === prefix);
  if (exact > 0) {
    const [hit] = matches.splice(exact, 1);
    if (hit) {
      matches.unshift(hit);
    }
  }
  return matches;
}

/** Markdown help block listing the commands, then the skills (and any shadowed one). */
export function helpText(skills: readonly SlashSkill[] = []): string {
  const rows = SLASH_COMMANDS.map((c) => `- \`${c.name}\` — ${c.description}`).join("\n");
  const catalog = slashCatalog(skills);
  const skillRows = catalog.commands
    .filter((c) => c.skill)
    .map((c) => `- \`${c.name} [what to do]\` — ${c.description}`);
  const shadowed = catalog.shadowed.map(
    (name) => `- skill \`${name}\` is hidden by the built-in \`/${name}\``,
  );
  const skillBlock =
    skillRows.length + shadowed.length > 0
      ? `\n\n**Skills** (load the skill, then do the task)\n${[...skillRows, ...shadowed].join("\n")}`
      : "";
  return `**Commands**\n${rows}${skillBlock}\n\n**Keys**: Shift+Tab auto-accept tools · \\+Enter newline · Ctrl+C stop/quit`;
}

/** One MCP server as `mcp/status` reports it (docs/feat/mcp-status.md). */
export interface McpServerView {
  readonly name: string;
  readonly state: "connecting" | "connected" | "unresponsive" | "closed" | "failed";
  readonly tools: number;
  readonly latencyMs?: number;
  readonly error?: string;
}

const MCP_GLYPH: Readonly<Record<McpServerView["state"], string>> = {
  connected: "●",
  connecting: "…",
  unresponsive: "!",
  closed: "○",
  failed: "✗",
};

/** A daemon-supplied string, safe inside a Markdown code span or after a colon. */
const mcpSafe = (text: string): string => oneLine(text).replace(/`/g, "");

const toolCount = (n: number): string => `${n} tool${n === 1 ? "" : "s"}`;

/** The `/mcp` notice: one row per server, in the daemon's order. */
export function mcpStatusText(servers: readonly McpServerView[]): string {
  if (servers.length === 0) {
    return "_No MCP servers on this daemon._";
  }
  const reachable = servers.filter((s) => s.state === "connected").length;
  const rows = servers.map((s) => {
    const head = `- \`${mcpSafe(s.name)}\` — ${MCP_GLYPH[s.state]} ${s.state}`;
    switch (s.state) {
      case "connected":
        return `${head} · ${toolCount(s.tools)} · ${s.latencyMs ?? 0} ms`;
      case "connecting":
        return head;
      case "failed":
        return `${head}: ${mcpSafe(s.error ?? "unknown error")}`;
      default:
        return `${head} · ${toolCount(s.tools)}: ${mcpSafe(s.error ?? "no reply")}`;
    }
  });
  return [`**MCP servers** — ${reachable} of ${servers.length} reachable`, ...rows].join("\n");
}

/** The `/mcp` notice when the status request itself failed. */
export function mcpStatusError(error: unknown): string {
  // JSON-RPC MethodNotFound: a daemon from before `mcp/status`.
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === -32601
  ) {
    return "_This daemon doesn't support /mcp (it predates it)._";
  }
  const message = error instanceof Error ? error.message : String(error);
  return `_MCP status unavailable: ${mcpSafe(message)}_`;
}

/** The text of the most recent assistant reply (never a command's notice), or null. */
export function lastAssistantText(items: readonly DisplayItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "assistant" && !item.notice) {
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
