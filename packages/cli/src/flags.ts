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

/**
 * `--key value` → flags, `--key=value` → flags, `--key` (no value) → bools,
 * everything else positional. Both `--namespace dev` and `--namespace=dev` work.
 */
export function parseFlags(args: readonly string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        bools.add(key);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, bools };
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
  if (first !== undefined && COMMANDS.has(first) && rest.some(isProfileFlag)) {
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
