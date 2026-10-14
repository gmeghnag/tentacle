/**
 * Command-prefix helpers for scoped shell permissions.
 *
 * A session-scoped shell approval should not whitelist *every* command — only
 * ones that look like the approved one. We model that as a command *prefix*
 * (e.g. `git commit`, `npm run`, `ls`): a later command auto-runs only if every
 * one of its simple commands starts with an approved prefix.
 *
 * This is a pragmatic heuristic, not a shell parser. It errs toward asking: it
 * over-splits on operators (an extra prompt is safe) and refuses to auto-approve
 * anything containing command substitution (`$(…)`, backticks, process
 * substitution) — where a hidden command could ride along. Pure and tested.
 */

// Tools whose first argument is a meaningful sub-verb worth keeping in the
// prefix, so "git commit" and "git push" are distinct rules.
const MULTI_VERB_TOOLS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "docker",
  "kubectl",
  "go",
  "pip",
  "pip3",
  "brew",
  "apt",
  "apt-get",
  "systemctl",
  "make",
  "gh",
  "deno",
  "poetry",
  "terraform",
  "gcloud",
  "aws",
]);

// Leading `VAR=value` environment assignments, skipped before the program name.
const ENV_ASSIGN_RE = /^[A-Za-z_]\w*=/;

// Command substitution / process substitution: if present we never auto-approve.
const SUBSTITUTION_RE = /\$\(|`|<\(|>\(/;

/** Split a command line into its simple commands on shell operators. The single
 * `&` (background / command separator) is included — `&&` is alternated first so
 * it is not mis-split — so a command cannot ride behind an approved prefix via
 * `approvedcmd & rm -rf ~`. */
export function splitSimpleCommands(command: string): string[] {
  return command
    .split(/(?:&&|&|\|\||\||;|\n)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** The program + argument tokens of a simple command, minus env assignments / sudo. */
function programTokens(simpleCommand: string): string[] {
  const tokens = simpleCommand.split(/\s+/).filter((t) => t.length > 0 && !ENV_ASSIGN_RE.test(t));
  while (tokens[0] === "sudo") {
    tokens.shift();
  }
  return tokens;
}

/** Suggest a prefix rule for a command (program, plus a sub-verb for known tools). */
export function suggestShellPrefix(command: string): string {
  const first = splitSimpleCommands(command)[0] ?? "";
  const tokens = programTokens(first);
  const program = tokens[0];
  if (!program) {
    return "";
  }
  const sub = tokens[1];
  if (MULTI_VERB_TOOLS.has(program) && sub && !sub.startsWith("-")) {
    return `${program} ${sub}`;
  }
  return program;
}

/** Whether a simple command's leading tokens match a prefix rule exactly. */
export function simpleMatchesPrefix(simpleCommand: string, prefix: string): boolean {
  const cmd = programTokens(simpleCommand);
  const pre = prefix.split(/\s+/).filter((t) => t.length > 0);
  if (pre.length === 0 || cmd.length < pre.length) {
    return false;
  }
  return pre.every((token, i) => cmd[i] === token);
}

/**
 * Whether a full command is covered by the approved prefixes — i.e. safe to run
 * without asking. Refuses (returns false) when substitution could hide a command
 * or when any simple command is not covered.
 */
export function commandCoveredByPrefixes(command: string, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0 || SUBSTITUTION_RE.test(command)) {
    return false;
  }
  const simples = splitSimpleCommands(command);
  if (simples.length === 0) {
    return false;
  }
  return simples.every((simple) => prefixes.some((prefix) => simpleMatchesPrefix(simple, prefix)));
}
