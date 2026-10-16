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
