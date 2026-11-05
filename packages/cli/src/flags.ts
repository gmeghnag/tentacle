/**
 * Tiny CLI flag parser and token resolution for the remote-control commands.
 *
 * A token is resolved from (in order) `--token`, `--token-command` (a shell
 * command whose stdout is the token — so it is never stored in plaintext, like
 * `apiKeyCommand`), then `TENTACLE_REMOTE_TOKEN`.
 */
import { X509Certificate } from "node:crypto";
import type { TlsOptions } from "@tentacle/client";

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
  /** Pairs of flags that cannot be given together (either form: bool or with a value). */
  readonly conflicts?: readonly (readonly [string, string])[];
  readonly positional: { readonly min: number; readonly max: number };
}

export type ParsedArgs =
  | ({ readonly ok: true } & ParsedFlags)
  | { readonly ok: false; readonly error: string };

/** A session uid (`--resume <uid>`): the store names sessions by UUID. */
const SESSION_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESUME = { resume: { accepts: (word: string) => SESSION_UID.test(word) } } as const;
/** `--continue` resumes the newest session; `--resume` picks one (docs/feat/resume-picker.md). */
const CONTINUE = { continue: {} } as const;
/**
 * `run --keep[=true|false]`: the next word is its value only when exactly `true`/`false`
 * (`run --keep true`); any other word stays positional (`run --keep name` keeps `name`).
 */
const KEEP = { keep: { accepts: (word: string) => word === "true" || word === "false" } } as const;
/** `run --detach --auto-accept[=true|false]`, parsed like `KEEP`. */
const AUTO_ACCEPT = {
  "auto-accept": { accepts: (word: string) => word === "true" || word === "false" },
} as const;
const RESUME_CONFLICTS = [["resume", "continue"]] as const;
const TOKEN = { token: {}, "token-command": {} } as const;
/**
 * The model of a SESSION command (docs/fix/detach-live-followups.md F5): `--model
 * <id>` is `TENTACLE_MODEL`'s CLI twin, `--profile <name>` `TENTACLE_PROFILE`'s.
 * Only `run`, `attach`, `serve` and the bare local session (`tui`, `plain`, a
 * one-shot prompt) take them, written after the command. Not `ps`/`rm` (each
 * kept entry carries its own engine and location: a profile must not filter
 * them), `update`, `hooks`, `package`; `connect` refuses them (its model is the
 * `serve` daemon's).
 */
const SESSION_MODEL = { model: {}, profile: {} } as const;
/** `run`/`attach`: the engine and its docker/podman endpoint options (docs/feat/docker-engine-cli.md). */
const ENGINE = { engine: {}, context: {} } as const;
const ENGINE_BOOLS = { "insecure-docker-tcp": {} } as const;

/** Every command's arguments: the ONE list of what each accepts. */
export const ARGS = {
  connect: {
    values: { ...TOKEN, "ca-cert": {} },
    bools: { "insecure-skip-tls-verify": {}, ...CONTINUE },
    optional: RESUME,
    conflicts: RESUME_CONFLICTS,
    positional: { min: 1, max: 1 },
  },
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
      // The pod's resident daemon socket (docs/feat/detached-runs.md S1); default in TMPDIR.
      socket: {},
      ...SESSION_MODEL,
    },
    // `--bridge` / `--resident` / `--resident-status` / `--resident-stop`: the
    // pod's resident daemon (`pod-resident.ts`), run by `run`/`attach` execs.
    bools: {
      stdio: {},
      "model-proxy": {},
      bridge: {},
      resident: {},
      "resident-status": {},
      "resident-stop": {},
    },
    positional: { min: 0, max: 0 },
  },
  run: {
    values: {
      ...ENGINE,
      namespace: { short: "n" },
      image: {},
      "bin-dir": {},
      // The workload's name (random when omitted); the positional is the PROMPT.
      name: {},
      prompt: {},
      ...SESSION_MODEL,
    },
    // docker/podman: the cwd mount (docs/feat/docker-workspace-mount.md); `run` only.
    bools: { ...CONTINUE, ...ENGINE_BOOLS, "no-mount": {}, "confirm-mount": {}, detach: {} },
    optional: { ...RESUME, ...KEEP, ...AUTO_ACCEPT },
    conflicts: RESUME_CONFLICTS,
    positional: { min: 0, max: 1 },
  },
  attach: {
    values: {
      ...ENGINE,
      namespace: { short: "n" },
      container: { short: "c" },
      "bin-dir": {},
      ...SESSION_MODEL,
    },
    bools: { ...CONTINUE, ...ENGINE_BOOLS },
    optional: RESUME,
    conflicts: RESUME_CONFLICTS,
    positional: { min: 1, max: 1 },
  },
  tui: {
    values: SESSION_MODEL,
    bools: { interactive: { short: "i" }, "in-process": {}, "no-worker": {}, ...CONTINUE },
    optional: RESUME,
    conflicts: RESUME_CONFLICTS,
    positional: { min: 0, max: 0 },
  },
  plain: { values: SESSION_MODEL, bools: { plain: {} }, positional: { min: 0, max: 0 } },
  hooks: {
    values: { revoke: {} },
    bools: { list: {} },
    conflicts: [["list", "revoke"]],
    positional: { min: 1, max: 1 },
  },
  // Kept workloads (docs/feat/engine-ps-rm.md).
  ps: {
    values: { engine: {} },
    bools: { quiet: { short: "q" }, verbose: { short: "v" }, all: { short: "a" } },
    conflicts: [["quiet", "verbose"]],
    positional: { min: 0, max: 0 },
  },
  rm: {
    values: { engine: {} },
    bools: { force: { short: "f" } },
    positional: { min: 1, max: Number.MAX_SAFE_INTEGER },
  },
  package: { positional: { min: 1, max: 2 } },
  update: { values: { version: {} }, bools: { check: {} }, positional: { min: 0, max: 0 } },
} as const satisfies Record<string, ArgSpec>;

/**
 * `run`'s first prompt (docs/feat/run-prompt.md): the positional or `--prompt`,
 * never both. `--prompt -` is stdin and only for `--detach` (the interactive TUI
 * needs the terminal as its stdin). A lone `-` positional is a plain word.
 */
export function resolveRunPrompt(input: {
  readonly positional: string | undefined;
  readonly promptFlag: string | undefined;
  readonly detach: boolean;
}):
  | { readonly ok: true; readonly prompt: string | undefined; readonly stdin: boolean }
  | { readonly ok: false; readonly error: string } {
  if (input.positional !== undefined && input.promptFlag !== undefined) {
    return { ok: false, error: 'give the prompt once: either "<prompt>" or --prompt, not both' };
  }
  if (input.promptFlag === "-") {
    return input.detach
      ? { ok: true, prompt: undefined, stdin: true }
      : { ok: false, error: "--prompt - needs --detach (the TUI needs the terminal as its stdin)" };
  }
  return { ok: true, prompt: input.positional ?? input.promptFlag, stdin: false };
}

/**
 * `run`'s flags together (docs/feat/run-prompt.md, docs/feat/detached-relay.md):
 * the usage error, if any. `prompt`: the resolved first prompt (stdin read).
 */
export function detachFlagProblem(input: {
  readonly detach: boolean;
  readonly prompt: string | undefined;
  readonly resume: boolean;
}): string | null {
  if (input.prompt !== undefined && input.prompt.trim() === "") {
    return "the prompt is empty";
  }
  if (!input.detach) {
    return input.prompt !== undefined && input.resume
      ? "--resume/--continue cannot be combined with a prompt"
      : null;
  }
  if (input.prompt === undefined) {
    return '--detach needs a prompt: "<prompt>", --prompt <text>, or --prompt - for stdin';
  }
  return input.resume
    ? "--detach cannot resume a session: run it, then `tentacle attach <name> --resume <uid>`"
    : null;
}

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
      // A lone `-` is a word (`--prompt -`: stdin), as it is for a positional.
      const takes =
        next !== undefined &&
        (!next.startsWith("-") || next === "-") &&
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
  const given = (name: string): boolean => flags.has(name) || bools.has(name);
  for (const [a, b] of spec.conflicts ?? []) {
    if (given(a) && given(b)) {
      return { ok: false, error: `--${a} and --${b} cannot be used together` };
    }
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
  /** `null` = `--session-ttl never` (no idle expiry). */
  readonly sessionTtlMs?: number | null;
  readonly adminCapMs?: number;
  readonly maxSessions?: number;
  readonly maxDetachedSessions?: number;
  readonly wsIdleTimeoutSec?: number;
}

/** Bun's ceiling for a WebSocket `idleTimeout` (it throws above it). */
const MAX_WS_IDLE_TIMEOUT_SEC = 960;

/**
 * `--session-ttl <dur>|never`, `--session-admin-cap <dur>`, `--max-sessions <n>`,
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
    sessionTtlMs: parsed.flags.get("session-ttl") === "never" ? null : duration("session-ttl"),
    adminCapMs: duration("session-admin-cap"),
    maxSessions: count("max-sessions"),
    maxDetachedSessions: count("max-detached-sessions"),
    wsIdleTimeoutSec: idleMs !== undefined ? idleMs / 1000 : undefined,
  };
  return Object.fromEntries(
    Object.entries(limits).filter(([, v]) => v !== undefined),
  ) as ServeLimits;
}

/**
 * Is this `serve` a pod daemon's load (`LoadConfigOptions.podDaemon`)? With the
 * model proxy, nothing there uses the key. The status and stop probes run
 * without it, and need no key either: a failing command there would fail
 * attach's probe as well. A plain `serve --stdio` calls its own provider: no.
 */
export function isPodDaemonLoad(bools: ReadonlySet<string>): boolean {
  const tunnelled =
    bools.has("model-proxy") &&
    (bools.has("stdio") || bools.has("bridge") || bools.has("resident"));
  return tunnelled || bools.has("resident-status") || bools.has("resident-stop");
}

/** One PEM certificate block (a `--ca-cert` file may be a bundle of several). */
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * Parse every certificate in a `--ca-cert` file, so a readable but empty /
 * non-PEM / corrupt file fails here, by name — not later as a TLS error that
 * reads like "cannot reach the daemon".
 */
function assertPemCertificates(text: string, path: string): void {
  const blocks = text.match(PEM_CERTIFICATE) ?? [];
  if (blocks.length === 0) {
    throw new Error(`--ca-cert ${path} contains no PEM certificate`);
  }
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch (error) {
      throw new Error(
        `--ca-cert ${path} has an invalid PEM certificate: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * `connect`'s TLS trust (docs/feat/client-tls-trust.md): `--ca-cert` reads the
 * PEM of the CA (or self-signed cert) that signed the daemon's cert, and
 * `--insecure-skip-tls-verify` skips verification (dev-only, warned by the
 * caller). Neither set → undefined → the system store is used. Every misuse
 * fails loudly here, before any socket: a TLS flag on a non-`wss://` URL
 * (it would be silently ignored), and a missing, unreadable or non-PEM CA file.
 */
export async function resolveTls(
  url: string,
  flags: ReadonlyMap<string, string>,
  bools: ReadonlySet<string>,
): Promise<TlsOptions | undefined> {
  const caPath = flags.get("ca-cert");
  const insecure = bools.has("insecure-skip-tls-verify");
  if (caPath === undefined && !insecure) {
    return undefined;
  }
  if (!/^wss:\/\//i.test(url)) {
    const flag = caPath !== undefined ? "--ca-cert" : "--insecure-skip-tls-verify";
    throw new Error(`${flag} needs a wss:// URL (got ${url || "none"})`);
  }
  let ca: string | undefined;
  if (caPath !== undefined) {
    try {
      ca = await Bun.file(caPath).text();
    } catch (error) {
      throw new Error(
        `cannot read --ca-cert ${caPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    assertPemCertificates(ca, caPath);
  }
  return {
    ...(ca !== undefined ? { ca } : {}),
    ...(insecure ? { rejectUnauthorized: false } : {}),
  };
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

export type SessionFlags =
  | {
      readonly ok: true;
      /** From a one-shot prompt's options (`tentacle --profile P <prompt>`); else in `rest`. */
      readonly profile?: string;
      /** The same, for `--model`. */
      readonly model?: string;
      readonly rest: string[];
    }
  | { readonly ok: false; readonly error: string };

/** Every subcommand word; any other first word starts a one-shot prompt. */
const SUBCOMMANDS = new Set([
  "serve",
  "run",
  "attach",
  "ps",
  "rm",
  "connect",
  "hooks",
  "package",
  "update",
  "install",
]);
/** The subcommands that start a session, so take `--model`/`--profile` after them. */
const SESSION_COMMANDS = new Set(["serve", "run", "attach"]);

const SESSION_FLAGS = ["model", "profile"] as const;
type SessionFlag = (typeof SESSION_FLAGS)[number];
const flagOf = (arg: string): SessionFlag | undefined =>
  SESSION_FLAGS.find((key) => arg === `--${key}` || arg.startsWith(`--${key}=`));

/** Why `connect` takes neither: its model and config are the remote daemon's. */
const CONNECT_REFUSAL: Readonly<Record<SessionFlag, string>> = {
  model:
    "--model has no effect with connect: it uses the model its `tentacle serve` daemon serves — start that daemon with `tentacle serve --model <id>`",
  profile: "--profile has no effect with connect: the remote daemon uses its own config",
};

/** Leading-word aliases, expanded before dispatch: `tentacle install …` = `tentacle package install …`. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  install: ["package", "install"],
};

/**
 * What `main` does with `--model <id>` / `--profile <name>` before it dispatches
 * (docs/fix/detach-live-followups.md F5). They are flags of the session commands,
 * parsed by `parseArgs` with the rest of the command's flags (`ARGS`), so this
 * only handles what that cannot:
 *  - a one-shot prompt, which has no spec: `tentacle --model X fix it` takes the
 *    leading options off and returns them (the prompt keeps its own text, even a
 *    `--model` inside it);
 *  - the same options BEFORE a subcommand (`tentacle --model X run`): an error
 *    naming the right form for `run`/`attach`/`serve`, the normal unknown-option
 *    error for the commands that take no model (`ps`, `rm`, …);
 *  - `connect`, which refuses both wherever they are.
 * Everything else — `tentacle --model X`, `-i --profile Y`, `run … --model X` —
 * is returned as is, for `cliMode` + `parseArgs`. Also expands the `install` alias.
 */
export function extractSessionFlags(args: readonly string[]): SessionFlags {
  const lead: { model?: string; profile?: string } = {};
  let firstLead: SessionFlag | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? "";
    const key = flagOf(arg);
    if (key === undefined) {
      break;
    }
    const value = arg === `--${key}` ? args[i + 1] : arg.slice(`--${key}=`.length);
    if (value === undefined || value === "" || value.startsWith("-")) {
      break; // `parseArgs` says what is wrong with it
    }
    if (lead[key] !== undefined) {
      return { ok: false, error: `--${key} given more than once` };
    }
    lead[key] = value;
    firstLead ??= key;
    i += arg === `--${key}` ? 2 : 1;
  }
  const tail = args.slice(i);
  const alias = tail[0] !== undefined ? ALIASES[tail[0]] : undefined;
  const rest = alias !== undefined ? [...alias, ...tail.slice(1)] : tail;
  const first = rest[0];
  if (first === "connect") {
    const key = firstLead ?? rest.map(flagOf).find((k) => k !== undefined);
    return key !== undefined ? { ok: false, error: CONNECT_REFUSAL[key] } : { ok: true, rest };
  }
  if (firstLead === undefined) {
    return { ok: true, rest };
  }
  if (first !== undefined && SUBCOMMANDS.has(first)) {
    const given = lead[firstLead];
    return {
      ok: false,
      error: SESSION_COMMANDS.has(first)
        ? `--${firstLead} goes after the command: tentacle ${first} --${firstLead} ${given}`
        : `unknown option --${firstLead}`,
    };
  }
  if (first === undefined || (first.startsWith("-") && first !== "--")) {
    return { ok: true, rest: [...args] }; // the bare session: `parseArgs` takes the options
  }
  return { ok: true, ...lead, rest };
}

/**
 * `--help` / `-h` / `--version` written AFTER other options (`--model X
 * --version`, `run --profile p --help`) reach `parseArgs` as an unknown option,
 * since `main` only looks at the first word. That exact error is what asks for
 * them (owner Q-R7); nothing that parsed before changes meaning.
 */
export function infoRequest(parseError: string): "help" | "version" | undefined {
  if (parseError === "unknown option --help" || parseError === "unknown option -h") {
    return "help";
  }
  return parseError === "unknown option --version" ? "version" : undefined;
}

/** Which path `main` takes, decided from the first argument alone. */
export type CliMode =
  | "connect"
  | "serve"
  | "run"
  | "attach"
  | "ps"
  | "rm"
  | "hooks"
  | "package"
  | "update"
  | "plain"
  | "tui"
  | "prompt"
  | "empty";

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
  if (
    first === "connect" ||
    first === "serve" ||
    first === "run" ||
    first === "attach" ||
    first === "ps" ||
    first === "rm" ||
    first === "hooks" ||
    first === "package" ||
    first === "update"
  ) {
    return first;
  }
  if (first.startsWith("-") && first !== "-" && first !== "--") {
    // `--plain` wherever it is among the options (`--model X --plain`); the
    // plain spec then refuses the TUI-only ones.
    return args.includes("--plain") ? "plain" : "tui";
  }
  return "prompt";
}

/** The usage line printed with an argument error. */
export const USAGE: Readonly<Record<Exclude<CliMode, "prompt" | "empty">, string>> = {
  connect:
    "tentacle connect ws(s)://host:port [--token T|--token-command CMD] [--ca-cert PEM|--insecure-skip-tls-verify] [--resume [id]|--continue]",
  serve:
    "tentacle serve [--host H] [--port P] [--token T|--token-command CMD] [--model <id>] [--profile <name>] [...] (see tentacle --help)",
  run: 'tentacle run --image <ref> [--engine kubernetes|docker|podman] [-n|--namespace <ns>] [--context <ctx>] [--insecure-docker-tcp] [--no-mount] [--confirm-mount] [--keep[=true|false]] [--bin-dir <dir>] [--resume [uid]|--continue] [--model <id>] [--profile <name>] [--name <n>] [--detach] [--auto-accept[=true|false]] [--prompt <text|->] ["<prompt>"]',
  attach:
    "tentacle attach <name> [--engine kubernetes|docker|podman] [-n|--namespace <ns>] [-c|--container <c>] [--context <ctx>] [--insecure-docker-tcp] [--bin-dir <dir>] [--resume [uid]|--continue] [--model <id>] [--profile <name>]",
  ps: "tentacle ps [--engine kubernetes|docker|podman] [-a|--all] [-q|--quiet] [-v|--verbose]",
  rm: "tentacle rm [--engine kubernetes|docker|podman] [-f|--force] <name>...",
  plain: "tentacle --plain [--model <id>] [--profile <name>]",
  hooks: "tentacle hooks trust --list | --revoke <folder>",
  package: "tentacle package install <path|git-url>[#ref] | list | remove <name> | update [<name>]",
  update: "tentacle update [--check] [--version vX.Y.Z]",
  tui: "tentacle [-i] [--resume [uid]|--continue] [--in-process] [--model <id>] [--profile <name>]",
};
