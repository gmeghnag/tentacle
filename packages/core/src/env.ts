/**
 * Scrub secret-bearing variables from an environment before it is handed to a
 * spawned child (a shell command, an MCP server subprocess). Without this a
 * model-driven `echo $TENTACLE_MODEL_API_KEY` — or any child process — can read
 * the user's keys straight out of its inherited environment, which redaction of
 * tool *output* never catches.
 *
 * A denylist (drop anything that looks like a secret) rather than an allowlist,
 * so ordinary vars a child needs (PATH, HOME, LANG, …) still pass through.
 */
const SENSITIVE_KEY =
  /(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY|AUTH|TLS[_-]?(KEY|CERT|CA))/i;

/** Whether an environment variable name looks like it carries a secret. */
export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Set by tentacle per child, never inherited: a stale value from the parent
 * would point a non-package hook or MCP server at some package
 * (docs/feat/hook-env-dirs.md).
 */
const PER_CHILD_KEYS = new Set(["TENTACLE_PACKAGE_DIR"]);

/** A copy of `env` with secret-looking and per-child keys (and `undefined` values) removed. */
export function scrubSensitiveEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isSensitiveEnvKey(key) || PER_CHILD_KEYS.has(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}
