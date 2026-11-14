import type { SlashCommand } from "../commands.ts";
/**
 * The ONE list of built-in slash commands (docs/feat/app-decomposition.md S2):
 * a new command is a new `commands/<name>.ts` plus one line here. `SLASH_COMMANDS`
 * (the palette/`/help` vocabulary, still exported from `commands.ts`) is DERIVED
 * from this list, so the words a user reads and the code that runs them can
 * never disagree.
 *
 * Dispatch order is this order only for `/help`; the command actually run is
 * always the one the user typed (`dispatchCommand` looks it up by name).
 */
import { command as agents } from "./agents.ts";
import { command as attach } from "./attach.ts";
import { command as clear } from "./clear.ts";
import { command as close } from "./close.ts";
import { command as compact } from "./compact.ts";
import type { CommandContext } from "./context.ts";
import { command as copy } from "./copy.ts";
import { command as exit } from "./exit.ts";
import { command as help } from "./help.ts";
import { command as mcp } from "./mcp.ts";
import { command as model } from "./model.ts";
import { command as move } from "./move.ts";
import { command as rename } from "./rename.ts";
import { command as retry } from "./retry.ts";
import { command as save } from "./save.ts";
import { command as sessions } from "./sessions.ts";
import { command as settings } from "./settings.ts";
import { command as skills } from "./skills.ts";
import { command as tokens } from "./tokens.ts";

/** One built-in: the words the palette shows, and the executor that runs it. */
export interface Command {
  readonly name: string;
  readonly description: string;
  /**
   * `raw` is the whole typed line (only the commands with arguments read it).
   * Each command's own `run` declares the `Pick<>` of the context it uses; a
   * function taking less is assignable here, and receives the whole context.
   */
  readonly run: (ctx: CommandContext, raw: string) => void;
}

/**
 * Every built-in, in the order `/help` and the palette list them. `/quit` is
 * `/exit`'s alias (not a row of its own: see `ALIASES`).
 */
export const BUILT_INS: readonly Command[] = [
  help,
  clear,
  compact,
  rename,
  sessions,
  close,
  model,
  move,
  retry,
  attach,
  copy,
  save,
  tokens,
  mcp,
  skills,
  agents,
  settings,
  exit,
];

/** Names the built-ins own, spelled as the user types them (`/quit` is `/exit`). */
export const ALIASES: Readonly<Record<string, string>> = { "/quit": "/exit" };

/** `name` resolved through the aliases (what a lookup should find). */
export function canonicalName(name: string): string {
  return ALIASES[name] ?? name;
}

/** The command `name` (an alias resolved), or undefined for an unknown one. */
export function findCommand(name: string): Command | undefined {
  const canonical = canonicalName(name);
  return BUILT_INS.find((c) => c.name === canonical);
}

/** The vocabulary the palette and `/help` show: derived, so it cannot drift. */
export const SLASH_COMMANDS: readonly SlashCommand[] = BUILT_INS.map(({ name, description }) => ({
  name,
  description,
}));

/** Names no skill may take: every built-in, plus the aliases. */
export const BUILT_IN_NAMES: ReadonlySet<string> = new Set([
  ...SLASH_COMMANDS.map((c) => c.name),
  ...Object.keys(ALIASES),
]);
