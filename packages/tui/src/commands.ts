/**
 * Slash-command vocabulary and the pure helpers behind them (transcript export,
 * last-message lookup, help text). Side effects (clipboard, file writes, session
 * reset) live in the App; everything here is pure and testable.
 *
 * The built-ins' NAMES and DESCRIPTIONS are not listed here any more: they live
 * in each command's own `commands/<name>.ts` and are derived back into
 * `SLASH_COMMANDS` by `commands/registry.ts` (docs/feat/app-decomposition.md
 * S2), so the words the palette shows and the code that runs them cannot
 * disagree. This module stays the vocabulary's PUBLIC surface: everything that
 * imports `SLASH_COMMANDS` keeps importing it from here.
 *
 * Skills join the vocabulary as `/name` (docs/feat/skills-slash.md): the
 * daemon's catalog arrives over RPC, and `resolveSlash` is the ONE place that
 * decides whether typed text activates a skill — by an exact match of its
 * first token, never by parsing the rest.
 */
import { BUILT_IN_NAMES, SLASH_COMMANDS } from "./commands/registry.ts";
import type { DisplayItem } from "./state.ts";

/** The vocabulary, derived from the registry (`commands/registry.ts`). */
export { SLASH_COMMANDS };

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

/**
 * Names the built-ins own (`/quit` is `/exit`'s alias): a skill can never take
 * one. Asked through `builtinNames()` rather than copied into a const at load
 * time: `commands.ts` and `commands/registry.ts` import each other, and reading
 * a registry const during THIS module's initialization is a TDZ error whenever
 * the registry happens to load first (proven in S2's Execution). Lazy, either
 * order works and the answer is the same.
 */
let builtinNames: ReadonlySet<string> | null = null;
function builtins(): ReadonlySet<string> {
  builtinNames ??= BUILT_IN_NAMES;
  return builtinNames;
}

/**
 * One display line: control characters and runs of whitespace become one
 * space; bidi overrides/isolates and zero-width characters (which can make a
 * pod-supplied description display differently from what it says) are dropped.
 */
export function oneLine(text: string): string {
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
    if (builtins().has(command)) {
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
  if (builtins().has(command)) {
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

/**
 * The palette highlight after one Up (`-1`) or Down (`1`) over `n` rows: the
 * index is clamped into the list first (it may point past a list that shrank
 * since), then moved by one, wrapping at both ends. An empty list has no row
 * to move to: the index is 0, never `NaN` (`% 0`), so a later open starts at
 * the top instead of on a poisoned index.
 */
export function paletteStep(i: number, n: number, dir: -1 | 1): number {
  if (n <= 0) {
    return 0;
  }
  const at = Math.min(i, n - 1);
  return (at + dir + n) % n;
}

// Commands that start a new turn or swap/mutate the session's history. Running
// one mid-turn is unsafe: `/retry` would start a *second* concurrent `send` on
// the same session (both mutate its messages/steering) and clobber the abort
// handle; `/clear` swaps the session under a live turn. The App rejects these
// while a turn is running. (`/compact` guards itself with a tailored message.)
// `/close` ends the session for every device; `/sessions` only opens a panel
// (the switch itself is refused mid-turn by `sessionsChoose`).
const SESSION_MUTATING = new Set(["/retry", "/clear", "/close"]);

/** Whether `command` (the leading token, e.g. "/retry") must wait for an idle turn. */
export function isSessionMutating(command: string): boolean {
  return SESSION_MUTATING.has(command);
}

/**
 * `/rename <title>`: the rest of the line, trimmed, is the title — the daemon
 * makes it one line and says what it stored. Nothing after the command → the
 * usage notice. (`/rename` is not session-mutating: allowed mid-turn.)
 */
export function parseRename(raw: string): { readonly title: string } | { readonly usage: string } {
  const title = raw
    .trim()
    .replace(/^\/rename\b/, "")
    .trim();
  return title === "" ? { usage: "_Usage: `/rename <title>`_" } : { title };
}

/** The notice for a title the daemon stored (pod-supplied text: one display line). */
export function renamedNotice(text: string): string {
  return `_Renamed: ${oneLine(text)}_`;
}

/** The notice for a refused or failed rename. */
export function renameFailedNotice(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `_Rename failed: ${oneLine(message)}_`;
}

/**
 * What a quit request (`/exit`, `/quit`, Ctrl+C) does. Quitting mid-turn first
 * stops the turn and waits for it to settle — that is where the session is
 * saved — then exits; a second request while that stop is pending quits at once
 * (a turn that won't stop must not trap the user). Ctrl+C mid-turn only stops
 * the turn (it never quits on the first press) — whoever started it. `/exit`
 * during a `foreign` turn (another device's) exits at once: it is not ours to
 * stop on the way out, it goes on daemon-side (docs/feat/tui-foreign-turns.md C4).
 * On a runtime whose quit only detaches (`detaches`: `connect`) `/exit` exits at
 * once even mid-own-turn: the daemon keeps the turn running and saves it
 * (docs/feat/connect-sessions.md).
 */
export function quitAction(
  source: "command" | "ctrl-c",
  running: boolean,
  exitPending: boolean,
  foreign = false,
  detaches = false,
): "exit" | "stop-then-exit" | "stop" {
  if (!running || exitPending) {
    return "exit";
  }
  if (source === "command") {
    return foreign || detaches ? "exit" : "stop-then-exit";
  }
  return "stop";
}

export interface QuitCommandInput {
  readonly running: boolean;
  /** A quit was asked already and is waiting for the turn to stop. */
  readonly exitPending: boolean;
  /** The turn shown is another terminal's (or the run's). */
  readonly foreign: boolean;
  /** `connect`: a quit only detaches. */
  readonly detaches: boolean;
  /** A detached run's TUI: `/quit` closes the session for every TUI on it (D1). */
  readonly endsSession: boolean;
  /** Other TUIs on this same session (laptop presence). */
  readonly others: number;
  /** Background sub-agents running now: quitting would lose them. */
  readonly agents: number;
  /**
   * Background SHELL jobs running now (owner Q3 (a)): a quit that CLOSES the
   * session loses them too — a job dies with the registry. A `connect` quit only
   * detaches, so its caller passes 0 and the confirm never claims otherwise.
   */
  readonly jobs?: number;
  /**
   * The session's ARMED scheduled wakes (docs/feat/cron-tool.md S5, mockup M6):
   * a quit that CLOSES the session ends them with it. A `connect` quit only
   * detaches, so its caller passes 0 — the wakes live on with the daemon.
   */
  readonly schedules?: number;
  /** The user said `y` to `quitConfirmText`. */
  readonly confirmed: boolean;
}

/**
 * What `/quit` (`/exit`) does (docs/fix/detach-live.md A1, docs/feat/subagent-background-ui.md),
 * first match wins: a second request leaves at once (a turn that will not
 * stop never traps the user); with other terminals on the session, or with
 * background sub-agents running that a quit would lose, it asks first; a run
 * TUI's quit ends the session, so a running turn — a foreign one too — stops
 * first; anything else is `quitAction`.
 */
export function quitCommandStep(input: QuitCommandInput): "exit" | "stop-then-exit" | "confirm" {
  if (input.exitPending) {
    return "exit";
  }
  if (input.others > 0 && !input.confirmed) {
    return "confirm";
  }
  // A child does not survive its session: quitting kills it. `connect` only
  // DETACHES, so both the session and its children live on, and asking there
  // would be a lie (a foreign turn's own state is not mine to take a child for).
  if (input.agents > 0 && !input.detaches && !input.confirmed) {
    return "confirm";
  }
  // A running SHELL job is lost too when the session closes (owner Q3 (a)); a
  // `connect` quit detaches and the job runs on, so there is nothing to ask.
  if ((input.jobs ?? 0) > 0 && !input.detaches && !input.confirmed) {
    return "confirm";
  }
  // The same for an ARMED scheduled wake (cron-tool S5, M6): it is the session's
  // state, so a quit that ends the session ends it — and nobody would be left to
  // be woken. A `connect` quit leaves it armed daemon-side.
  if ((input.schedules ?? 0) > 0 && !input.detaches && !input.confirmed) {
    return "confirm";
  }
  if (input.endsSession) {
    return input.running ? "stop-then-exit" : "exit";
  }
  return quitAction("command", input.running, false, input.foreign, input.detaches) === "exit"
    ? "exit"
    : "stop-then-exit";
}

/** What the confirmation is about: who else, and which children/jobs would be lost. */
export interface QuitConfirmFacts {
  readonly others: number;
  readonly agents: number;
  /** The children's ids, in launch order (`sa-1`, `sa-2`). */
  readonly names: readonly string[];
  /** The SHELL jobs running now (owner Q3 (a)): counted apart from the children. */
  readonly jobs?: number;
  /**
   * The session's armed scheduled wakes (cron-tool S5, M6): a quit that ENDS the
   * session ends them, so their ids are named. Absent/empty: nothing to say
   * (and a `connect` quit never reaches here: it only detaches).
   */
  readonly scheduleIds?: readonly string[];
}

/** Ids the dialog names, and how much of each: one row at 80 columns (LOW-2). */
const QUIT_NAMES_SHOWN = 3;
const QUIT_NAME_MAX = 12;

/** Wakes the quit warning names, and the whole line's cell budget (`QUIT_CONFIRM_ROWS` = 1). */
const QUIT_WAKES_SHOWN = 3;
const QUIT_WAKE_ID_MAX = 12;
const QUIT_WAKES_COLS = 78;

/**
 * The quit warning for ARMED scheduled wakes a quit would destroy
 * (docs/feat/cron-tool.md S5, mockup M6), or null at none. One bounded row: the
 * dialog has exactly `QUIT_CONFIRM_ROWS`, and these are a daemon's (possibly a
 * pod's) ids — so the names yield to the sentence instead of being cut mid-word
 * by Ink's `truncate-end` (LOW-2's lesson, from the children's ids).
 */
export function scheduleQuitText(ids: readonly string[]): string | null {
  if (ids.length === 0) {
    return null;
  }
  const verb = ids.length === 1 ? "ends" : "end";
  const what = ids.length === 1 ? "1 scheduled wake" : `${ids.length} scheduled wakes`;
  const room = QUIT_WAKES_COLS - `${what} () ${verb} with this session — quit? (y/N)`.length;
  let shown = 0;
  let names = "";
  for (const id of ids.slice(0, QUIT_WAKES_SHOWN)) {
    const one = oneLine(id).slice(0, QUIT_WAKE_ID_MAX);
    const next = shown === 0 ? one : `${names}, ${one}`;
    const rest = ids.length - shown - 1;
    if (next.length + (rest > 0 ? ` +${rest}`.length : 0) > room) {
      break;
    }
    names = next;
    shown += 1;
  }
  const rest = ids.length - shown;
  const list = `${names}${rest > 0 ? `${names === "" ? "" : " "}+${rest}` : ""}`;
  return `${what} (${list}) ${verb} with this session — quit? (y/N)`;
}

/** The confirmation `/quit` asks with others on the session, or children to lose. */
export function quitConfirmText(facts: QuitConfirmFacts): string {
  const { others, agents, names } = facts;
  // A SHELL job is a different thing to lose, and is worded apart (owner Q3 (a)):
  // it keeps no report, so nothing of it reaches the conversation afterwards.
  const jobs = facts.jobs ?? 0;
  const wakes = facts.scheduleIds ?? [];
  const who = others === 1 ? "1 other terminal" : `${others} other terminals`;
  if (agents <= 0 && jobs <= 0 && wakes.length === 0) {
    return `${who} attached — close the session for all? (y/N)`;
  }
  if (agents <= 0 && jobs <= 0 && others <= 0) {
    // Wakes alone: their own sentence, naming the ids (M6).
    return scheduleQuitText(wakes) ?? `${who} attached — close the session for all? (y/N)`;
  }
  if (agents <= 0 && wakes.length === 0) {
    const shells = jobs === 1 ? "1 background shell job" : `${jobs} background shell jobs`;
    return others > 0
      ? `${who} attached · ${jobs === 1 ? "1 shell job running" : `${jobs} shell jobs running`} — close the session for all? (y/N)`
      : `${shells} will be lost — quit? (y/N)`;
  }
  // A hostile pod's ids pass the client's bound (32 rows, 200 chars), so the
  // dialog must bound its own line: it is one row (`QUIT_CONFIRM_ROWS`), and
  // joining them all rendered 98 rows in it. Three short ids, then a count.
  const shown = names
    .slice(0, QUIT_NAMES_SHOWN)
    .map((n) => n.slice(0, QUIT_NAME_MAX))
    .join(", ");
  const more = names.length > QUIT_NAMES_SHOWN ? ` +${names.length - QUIT_NAMES_SHOWN}` : "";
  const what =
    agents === 1
      ? `1 background sub-agent (${shown}${more})`
      : `${agents} background sub-agents (${shown}${more})`;
  // Both kinds running: the children by id, then the jobs as a count.
  const shells = jobs <= 0 ? "" : jobs === 1 ? " · 1 shell job" : ` · ${jobs} shell jobs`;
  const arms =
    wakes.length === 0
      ? ""
      : wakes.length === 1
        ? " · 1 scheduled wake"
        : ` · ${wakes.length} scheduled wakes`;
  if (others > 0) {
    const running = agents === 1 ? "1 sub-agent running" : `${agents} sub-agents running`;
    const runningJobs =
      jobs <= 0 ? "" : jobs === 1 ? " · 1 shell job running" : ` · ${jobs} shell jobs running`;
    return `${who} attached · ${running}${runningJobs}${arms} — close the session for all? (y/N)`;
  }
  return `${what}${shells}${arms} will be lost — quit? (y/N)`;
}

/** A key on that confirmation: only a plain `y`/`Y` closes; anything else (Enter, Ctrl+Y) is No. */
export function quitConfirmKey(char: string, modified = false): "yes" | "no" {
  return !modified && (char === "y" || char === "Y") ? "yes" : "no";
}

/** What a Ctrl+C does (docs/feat/subagent-background-ui.md): `quitAction`, plus the child dialog. */
export interface CtrlCQuitInput {
  readonly running: boolean;
  readonly exitPending: boolean;
  /** `connect`: a quit only detaches (the session and its children live on). */
  readonly detaches: boolean;
  /**
   * Other terminals on this same session. With one, a Ctrl+C only DETACHES (the
   * session and its children live on for them), so there is nothing to ask.
   */
  readonly others: number;
  /** Background sub-agents running now: quitting would lose them. */
  readonly agents: number;
  /** Background SHELL jobs running now (owner Q3 (a)): a closing quit loses them. */
  readonly jobs?: number;
  /** The user said `y` to `quitConfirmText`. */
  readonly confirmed?: boolean;
}

/**
 * Ctrl+C, decided in one place. Mid-turn it stops the turn (it never quits on
 * the first press — whoever started it). Idle it exits, EXCEPT with background
 * sub-agents running that the quit would lose AND nobody else on the session:
 * that asks first (a Ctrl+C is as easy to press by accident as `/quit`). A
 * second press, a `connect` runtime, another terminal, and an already-confirmed
 * quit leave at once.
 */
export function ctrlCQuitStep(input: CtrlCQuitInput): "exit" | "stop" | "confirm" {
  // A running SHELL job counts too (owner Q3 (a)): it dies with the session, and
  // a Ctrl+C is as easy to press by accident as `/quit`.
  if (
    (input.agents > 0 || (input.jobs ?? 0) > 0) &&
    input.others === 0 &&
    !input.detaches &&
    input.confirmed !== true &&
    !input.exitPending
  ) {
    // Mid-turn the stop wins: the turn's save happens first, as today.
    return input.running ? "stop" : "confirm";
  }
  return quitAction("ctrl-c", input.running, input.exitPending) === "exit" ? "exit" : "stop";
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
  return `**Commands**\n${rows}${skillBlock}\n\n**Keys**: Shift+Tab auto-accept tools (whole session) · \\+Enter newline · Ctrl+C stop/quit · Ctrl+X Ctrl+S send queued now · Option+Backspace/Ctrl+W delete previous word · Alt+D delete next word`;
}

/** A daemon-supplied string, safe inside a Markdown code span or after a colon. */
const mcpSafe = (text: string): string => oneLine(text).replace(/`/g, "");

/** The notice when a panel's request (`command`, showing `what`) failed. */
function requestError(command: string, what: string, error: unknown): string {
  // JSON-RPC MethodNotFound: a daemon from before the method.
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === -32601
  ) {
    return `_This daemon doesn't support ${command} (it predates it)._`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `_${what} unavailable: ${mcpSafe(message)}_`;
}

/** The `/mcp` notice when the status request itself failed. */
export const mcpStatusError = (error: unknown): string => requestError("/mcp", "MCP status", error);

/** The `/tools` notice when the list request failed (an older daemon: it predates it, F8). */
export const toolsListError = (error: unknown): string =>
  requestError("/tools", "Tool list", error);

/** The `/skills` notice when the list request failed. */
export const skillsListError = (error: unknown): string =>
  requestError("/skills", "Skill list", error);

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
      // The prompt's images, the rows `/save` shows (docs/feat/attachments-tui.md D7).
      const images = (item.images ?? []).map((row) => `\n\n${row}`).join("");
      parts.push(`## User\n\n${item.text}${images}`);
    } else if (item.kind === "assistant") {
      if (item.text.trim() !== "") {
        parts.push(`## Assistant\n\n${item.text}`);
      }
    } else if (item.kind === "notice") {
      parts.push(`> ${item.text}`);
    } else if (item.kind === "header") {
      // Display-only: the startup header is never part of the saved document
      // (docs/feat/tui-mascot.md D2).
    } else {
      const status =
        item.status === "ok"
          ? "✔"
          : item.status === "error"
            ? "✘"
            : item.status === "queued"
              ? "◌ queued"
              : "⟳";
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
