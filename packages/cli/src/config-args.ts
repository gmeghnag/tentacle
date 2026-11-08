/**
 * `tentacle config`'s argument model (docs/feat/config-set.md, owner answers
 * Q4/Q5/Q7): pure, so every ambiguity is decided in one testable place and
 * `main.ts` only prints.
 *
 * Two forms, never confusable (a key holds no `=` or space):
 *   tentacle config set <key> <value>       tentacle config <key>=<value>
 *   tentacle config unset <key>             tentacle config --unset <key>
 *   tentacle config get <key> [--json]
 *   tentacle config list [--json]
 *   tentacle config path
 *
 * `--profile <name>` targets `profiles.<name>.` in the SAME user file (profiles
 * live inside it, `schema.ts:393-400`), so a key that already names a profile is
 * an ambiguity, not a nested profile.
 */
/** Where a `set`'s value comes from. */ export type ValueSource =
  | { readonly from: "argv"; readonly text: string }
  /** `-`: read stdin to EOF (one trailing newline trimmed). */
  | { readonly from: "stdin" }
  /** No value given: a hidden prompt on a terminal, else stdin (the caller decides). */
  | { readonly from: "prompt" };

/** What the command does. */
export type ConfigOp =
  | { readonly kind: "set"; readonly key: string; readonly value: ValueSource }
  | { readonly kind: "unset"; readonly key: string }
  | { readonly kind: "get"; readonly key: string }
  | { readonly kind: "list" }
  | { readonly kind: "path" };

export type ConfigArgs =
  | {
      readonly ok: true;
      readonly op: ConfigOp;
      /** The profile to target (`profiles.<name>.`), from `--profile`. */
      readonly profile?: string;
      readonly json: boolean;
      /** Skip the confirmation of a destructive unset. */
      readonly yes: boolean;
    }
  | { readonly ok: false; readonly error: string };

const FORMS =
  "usage: tentacle config set <key> <value> | <key>=<value> | unset <key> | get <key> | list | path";

const fail = (error: string): ConfigArgs => ({ ok: false, error });

/**
 * A key outside a profile (eval A5, `schema.ts`): `$schema` and `profiles` are
 * top-level only, so `--profile x` cannot carry them.
 */
function profileProblem(key: string): string | undefined {
  const segments = key.split(".");
  if (segments[0] === "profiles") {
    return `${key} already names a profile; --profile cannot target a profile inside a profile`;
  }
  if (segments[0] === "$schema") {
    return "$schema is a top-level key; it cannot be set inside a profile";
  }
  return undefined;
}

/** `key=value`: split at the FIRST `=`, so a URL keeps its own. */
function fromShorthand(word: string): ConfigArgs {
  const at = word.indexOf("=");
  if (at < 0) {
    return fail(`${JSON.stringify(word)}: expected <key>=<value>, or: ${FORMS}`);
  }
  const key = word.slice(0, at);
  if (key === "") {
    return fail(`${JSON.stringify(word)}: no key before the "="`);
  }
  return {
    ok: true,
    op: { kind: "set", key, value: { from: "argv", text: word.slice(at + 1) } },
    json: false,
    yes: false,
  };
}

/**
 * `config`'s arguments → one op. `flags`/`bools` are `parseArgs`' result for
 * `ARGS.config`, so an unknown flag never reaches here.
 */
export function parseConfigArgs(
  positional: readonly string[],
  flags: ReadonlyMap<string, string>,
  bools: ReadonlySet<string>,
): ConfigArgs {
  const json = bools.has("json");
  const yes = bools.has("yes");
  const profile = flags.get("profile");
  const unsetFlag = flags.get("unset");
  const out = (op: ConfigOp): ConfigArgs => ({
    ok: true,
    op,
    json,
    yes,
    ...(profile !== undefined ? { profile } : {}),
  });
  const words = [...positional];
  const first = words[0];

  if (unsetFlag !== undefined) {
    if (unsetFlag === "") {
      return fail("--unset needs a key");
    }
    if (first !== undefined) {
      return fail("--unset already names the key; give either --unset or a command, not both");
    }
    const problem = profile === undefined ? undefined : profileProblem(unsetFlag);
    return problem !== undefined ? fail(problem) : out({ kind: "unset", key: unsetFlag });
  }

  if (first === undefined) {
    return fail(`no command: ${FORMS}`);
  }

  if (first === "list" || first === "path") {
    if (words.length > 1) {
      return fail(`unexpected argument ${JSON.stringify(words[1])}; ${FORMS}`);
    }
    return out(first === "list" ? { kind: "list" } : { kind: "path" });
  }

  if (first === "get") {
    const key = words[1];
    if (key === undefined) {
      return fail(`get needs a key; ${FORMS}`);
    }
    if (words.length > 2) {
      return fail(`unexpected argument ${JSON.stringify(words[2])}; ${FORMS}`);
    }
    const problem = profile === undefined ? undefined : profileProblem(key);
    return problem !== undefined ? fail(problem) : out({ kind: "get", key });
  }

  if (first === "unset") {
    const key = words[1];
    if (key === undefined) {
      return fail(`unset needs a key; ${FORMS}`);
    }
    if (words.length > 2) {
      return fail(`unexpected argument ${JSON.stringify(words[2])}; ${FORMS}`);
    }
    const problem = profile === undefined ? undefined : profileProblem(key);
    return problem !== undefined ? fail(problem) : out({ kind: "unset", key });
  }

  // `set <key> [value]`: the value may itself be `key=value` (a key holds no `=`).
  const setWords = first === "set" ? words.slice(1) : words;
  const key = setWords[0];
  if (key === undefined) {
    return fail(`set needs a key; ${FORMS}`);
  }
  if (setWords.length > 2) {
    return fail(`unexpected argument ${JSON.stringify(setWords[2])}; ${FORMS}`);
  }
  const problem = profile === undefined ? undefined : profileProblem(key);
  if (problem !== undefined) {
    return fail(problem);
  }
  const value = setWords[1];
  if (value === undefined) {
    // The shorthand carries its own value; a bare key has none yet.
    return key.includes("=")
      ? fromShorthand(key)
      : out({ kind: "set", key, value: { from: "prompt" } });
  }
  return out({
    kind: "set",
    key,
    value: value === "-" ? { from: "stdin" } : { from: "argv", text: value },
  });
}
