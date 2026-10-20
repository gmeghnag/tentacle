/**
 * Tiny CLI flag parser and token resolution for the remote-control commands.
 *
 * A token is resolved from (in order) `--token`, `--token-command` (a shell
 * command whose stdout is the token — so it is never stored in plaintext, like
 * `apiKeyCommand`), then `TENTACLE_REMOTE_TOKEN`.
 */
export interface ParsedFlags {
  readonly positional: string[];
  readonly flags: Map<string, string>;
  readonly bools: Set<string>;
}

/** One flag's alias. */
interface FlagDef {
  /** A one-letter alias: `-n` for `--namespace`. */
  readonly short?: string;
}

/**
 * What a command accepts (docs/fix/cli-strict-args.md). Closed: anything else
 * is an error, never silently ignored.
 */
export interface ArgSpec {
  /** Flags that take a value: `--k v`, `--k=v`, `-s v`, `-s=v`. */
  readonly values?: Readonly<Record<string, FlagDef>>;
  /** Flags that take none. */
  readonly bools?: Readonly<Record<string, FlagDef>>;
  /**
   * Flags whose value is optional: the next word is taken only when `accepts`
   * it (else the flag is a bool); `--k=v` is always explicit.
   */
  readonly optional?: Readonly<Record<string, { readonly accepts: (word: string) => boolean }>>;
  readonly positional: { readonly min: number; readonly max: number };
}

export type ParsedArgs =
  | ({ readonly ok: true } & ParsedFlags)
  | { readonly ok: false; readonly error: string };

/** A session uid (`--resume <uid>`): the store names sessions by UUID. */
const SESSION_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESUME = { resume: { accepts: (word: string) => SESSION_UID.test(word) } } as const;
const TOKEN = { token: {}, "token-command": {} } as const;

/** Every command's arguments: the ONE list of what each accepts. */
export const ARGS = {
  connect: { values: TOKEN, positional: { min: 1, max: 1 } },
  serve: {
    values: {
      host: {},
      port: {},
      "tls-cert": {},
      "tls-key": {},
      ...TOKEN,
      "session-ttl": {},
      "session-admin-cap": {},
      "max-sessions": {},
      "max-detached-sessions": {},
      "ws-idle-timeout": {},
    },
    bools: { stdio: {}, "model-proxy": {} },
    positional: { min: 0, max: 0 },
  },
  run: {
    values: { namespace: { short: "n" }, image: {}, "bin-dir": {} },
    optional: RESUME,
    positional: { min: 0, max: 1 },
  },
  attach: {
    values: { namespace: { short: "n" }, container: { short: "c" }, "bin-dir": {} },
    optional: RESUME,
    positional: { min: 1, max: 1 },
  },
  tui: {
    bools: { interactive: { short: "i" }, "in-process": {}, "no-worker": {} },
    optional: RESUME,
    positional: { min: 0, max: 0 },
  },
  plain: { bools: { plain: {} }, positional: { min: 0, max: 0 } },
} as const satisfies Record<string, ArgSpec>;

/**
 * Parse `args` against a closed `spec`: flags anywhere (before or after the
 * positionals), long or short, `=` or a separate word; `--` ends the options.
 * An unknown flag, a missing value, a repeat, a value on a bool, or a wrong
 * number of positionals is an error.
 */
export function parseArgs(args: readonly string[], spec: ArgSpec): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const kind = (name: string): "value" | "bool" | "optional" | undefined =>
    spec.values && Object.hasOwn(spec.values, name)
      ? "value"
      : spec.bools && Object.hasOwn(spec.bools, name)
        ? "bool"
        : spec.optional && Object.hasOwn(spec.optional, name)
          ? "optional"
          : undefined;
  const longOf = (short: string): string | undefined => {
    for (const group of [spec.values, spec.bools]) {
      for (const [name, def] of Object.entries(group ?? {})) {
        if (def.short === short) return name;
      }
    }
    return undefined;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    const isLong = arg.startsWith("--");
    const eq = arg.indexOf("=");
    const written = eq > 0 ? arg.slice(0, eq) : arg;
    const name = isLong ? written.slice(2) : longOf(written.slice(1));
    const type = name !== undefined && name !== "" ? kind(name) : undefined;
    if (name === undefined || type === undefined) {
      return { ok: false, error: `unknown option ${written}` };
    }
    if (flags.has(name) || bools.has(name)) {
      return { ok: false, error: `--${name} given more than once` };
    }
    if (type === "bool") {
      if (eq > 0) return { ok: false, error: `${written} takes no value` };
      bools.add(name);
      continue;
    }
    let value: string | undefined;
    if (eq > 0) {
      value = arg.slice(eq + 1);
    } else {
      const next = args[i + 1];
      const takes =
        next !== undefined &&
        !next.startsWith("-") &&
        (type === "value" || spec.optional?.[name]?.accepts(next) === true);
      if (takes) {
        value = next;
        i++;
      } else if (type === "optional") {
        bools.add(name);
        continue;
      }
    }
    if (value === undefined || value === "") {
      return { ok: false, error: `${written} needs a value` };
    }
    flags.set(name, value);
  }
  if (positional.length > spec.positional.max) {
    return {
      ok: false,
      error: `unexpected argument ${JSON.stringify(positional[spec.positional.max])}`,
    };
  }
  if (positional.length < spec.positional.min) {
    return { ok: false, error: "missing argument" };
  }
  return { ok: true, positional, flags, bools };
}

const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

/** `"24h"`, `"90m"`, `"45s"`, `"1500ms"` → milliseconds. A positive whole number + unit, or throws. */
export function parseDuration(text: string): number {
  const match = /^([0-9]{1,9})(ms|s|m|h)$/.exec(text.trim());
  const amount = match ? Number(match[1]) : 0;
  const unit = match?.[2] !== undefined ? DURATION_UNITS[match[2]] : undefined;
  if (unit === undefined || amount <= 0) {
    throw new Error(`invalid duration "${text}" (use e.g. 24h, 90m, 45s, 1500ms)`);
  }
  return amount * unit;
}

/** `serve`'s session bounds, as given on the command line (unset → `startDaemon`'s default). */
export interface ServeLimits {
  readonly sessionTtlMs?: number;
  readonly adminCapMs?: number;
  readonly maxSessions?: number;
  readonly maxDetachedSessions?: number;
  readonly wsIdleTimeoutSec?: number;
}

/** Bun's ceiling for a WebSocket `idleTimeout` (it throws above it). */
const MAX_WS_IDLE_TIMEOUT_SEC = 960;

/**
 * `--session-ttl <dur>`, `--session-admin-cap <dur>`, `--max-sessions <n>`,
 * `--max-detached-sessions <n>`, `--ws-idle-timeout <dur>`. Throws on an
 * invalid value — or a flag given without one — so `serve` fails before binding.
 */
export function parseServeLimits(parsed: Pick<ParsedFlags, "flags" | "bools">): ServeLimits {
  const value = (key: string): string | undefined => {
    if (parsed.bools.has(key)) {
      throw new Error(`--${key} needs a value`);
    }
    return parsed.flags.get(key);
  };
  const count = (key: string): number | undefined => {
    const raw = value(key);
    if (raw === undefined) {
      return undefined;
    }
    if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) <= 0) {
      throw new Error(`--${key} must be a positive whole number, got "${raw}"`);
    }
    return Number(raw);
  };
  const duration = (key: string): number | undefined => {
    const raw = value(key);
    if (raw === undefined) {
      return undefined;
    }
    try {
      return parseDuration(raw);
    } catch (error) {
      throw new Error(`--${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const idleMs = duration("ws-idle-timeout");
  if (idleMs !== undefined && (idleMs % 1000 !== 0 || idleMs / 1000 > MAX_WS_IDLE_TIMEOUT_SEC)) {
    throw new Error(`--ws-idle-timeout must be whole seconds, at most ${MAX_WS_IDLE_TIMEOUT_SEC}s`);
  }
  const limits = {
    sessionTtlMs: duration("session-ttl"),
    adminCapMs: duration("session-admin-cap"),
    maxSessions: count("max-sessions"),
    maxDetachedSessions: count("max-detached-sessions"),
    wsIdleTimeoutSec: idleMs !== undefined ? idleMs / 1000 : undefined,
  };
  return Object.fromEntries(
    Object.entries(limits).filter(([, v]) => v !== undefined),
  ) as ServeLimits;
}

/** Run a shell command and return its trimmed stdout (the secret). */
async function runCommand(command: string): Promise<string> {
  const proc = Bun.spawn(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(`token command failed (exit ${code}): ${command}`);
  }
  return out.trim();
}

/** Resolve the bearer token for `serve`/`connect`, or undefined if none set. */
export async function resolveToken(flags: Map<string, string>): Promise<string | undefined> {
  const direct = flags.get("token");
  if (direct) {
    return direct;
  }
  const command = flags.get("token-command");
  if (command) {
    return runCommand(command);
  }
  const env = process.env.TENTACLE_REMOTE_TOKEN;
  return env && env.length > 0 ? env : undefined;
}

export type GlobalOptions =
  | { readonly ok: true; readonly profile?: string; readonly rest: string[] }
  | { readonly ok: false; readonly error: string };

/** The first arguments that select a command or a mode; anything else starts a one-shot prompt. */
const COMMANDS = new Set([
  "serve",
  "run",
  "attach",
  "connect",
  "-i",
  "--interactive",
  "--resume",
  "--plain",
]);

const isProfileFlag = (arg: string): boolean => arg === "--profile" || arg.startsWith("--profile=");

/**
 * Take the LEADING global options off argv, before `main` dispatches on
 * `args[0]` (docs/feat/config-profiles.md). Today: `--profile <name>` /
 * `--profile=<name>`. Never silently dropped: a missing value, a repeat, a
 * `--profile` after a command or mode, or one with `connect` is an error. In
 * one-shot mode everything after the leading options is prompt text, kept as is.
 */
export function extractGlobalOptions(args: readonly string[]): GlobalOptions {
  let profile: string | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? "";
    if (!isProfileFlag(arg)) {
      break;
    }
    let value: string | undefined;
    if (arg === "--profile") {
      value = args[i + 1];
      i += 2;
    } else {
      value = arg.slice("--profile=".length);
      i += 1;
    }
    if (value === undefined || value === "" || value.startsWith("-")) {
      return { ok: false, error: "--profile needs a profile name" };
    }
    if (profile !== undefined) {
      return { ok: false, error: "--profile given more than once" };
    }
    profile = value;
  }
  const rest = args.slice(i);
  const first = rest[0];
  const isMode =
    first !== undefined && (COMMANDS.has(first) || (first.startsWith("-") && first !== "--"));
  if (isMode && rest.some(isProfileFlag)) {
    return { ok: false, error: "--profile must come before the command" };
  }
  if (profile !== undefined && first === "connect") {
    return {
      ok: false,
      error: "--profile has no effect with connect: the remote daemon uses its own config",
    };
  }
  return profile !== undefined ? { ok: true, profile, rest } : { ok: true, rest };
}

/** Which path `main` takes, decided from the first argument alone. */
export type CliMode = "connect" | "serve" | "run" | "attach" | "plain" | "tui" | "prompt" | "empty";

/**
 * A subcommand → its own arguments; `--plain` → the REPL; any other leading
 * `-…` → the TUI's options (`-i`, `--resume`, `--in-process`…); `--` or a word
 * → a one-shot prompt whose words are kept verbatim.
 */
export function cliMode(args: readonly string[]): CliMode {
  const first = args[0];
  if (first === undefined) {
    return "empty";
  }
  if (first === "connect" || first === "serve" || first === "run" || first === "attach") {
    return first;
  }
  if (first === "--plain") {
    return "plain";
  }
  if (first.startsWith("-") && first !== "-" && first !== "--") {
    return "tui";
  }
  return "prompt";
}

/** The usage line printed with an argument error. */
export const USAGE: Readonly<Record<Exclude<CliMode, "prompt" | "empty">, string>> = {
  connect: "tentacle connect ws(s)://host:port [--token T|--token-command CMD]",
  serve:
    "tentacle serve [--host H] [--port P] [--token T|--token-command CMD] [...] (see tentacle --help)",
  run: "tentacle run --image <ref> [-n|--namespace <ns>] [--bin-dir <dir>] [--resume [uid]] [<name>]",
  attach:
    "tentacle attach <pod> [-n|--namespace <ns>] [-c|--container <c>] [--bin-dir <dir>] [--resume [uid]]",
  plain: "tentacle --plain",
  tui: "tentacle [-i] [--resume [uid]] [--in-process]",
};
