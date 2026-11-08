/**
 * The plan of ONE `tentacle config` edit (docs/feat/config-set.md): parse the
 * user's jsonc text, apply the change in memory, validate the WHOLE file
 * against the schema, and only then — if that passed — compute the text edit
 * with jsonc-parser's `modify` + `applyEdits` and RE-CHECK that the new text
 * holds exactly the value that was validated.
 *
 * Why the re-check: two separate code paths touch the value (the in-memory apply
 * that zod validated, and jsonc-parser's text edit). `config.jsonc` is the
 * user's only config file, so a mismatch between what was validated and what
 * lands on disk must be refused, never written.
 *
 * Why `modify` and not `JSON.stringify`: the scaffold is a commented guide the
 * user reads, so comments, layout and key order outside the touched node are
 * kept byte for byte (docs/eval/config-cli.md A3/Q9, pinned by T10).
 *
 * Pure: no file I/O, no env, no registry. `config-run.ts` reads and writes.
 */
import {
  type FormattingOptions,
  type ParseError,
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  stripComments,
} from "jsonc-parser";
import { type FileConfig, FileConfigSchema } from "./schema.ts";

/** What an edit does at its path. */
export type EditOp =
  | { readonly kind: "set"; readonly value: unknown }
  | { readonly kind: "delete" };

/** A refusal: one line, optional detail lines (every schema issue) and a hint. */
export interface EditFailure {
  readonly ok: false;
  readonly error: string;
  readonly details?: readonly string[];
  readonly hint?: string;
}

/** A successful plan: the new text, and what it was validated to hold. */
export interface EditPlan {
  readonly ok: true;
  /** The whole new file text, comments and layout intact outside the edit. */
  readonly text: string;
  /** The edited document's value (what `text` re-parses to). */
  readonly value: unknown;
  /** The same value after `FileConfigSchema` (zod's output, e.g. inferred `type`). */
  readonly config: FileConfig;
}

export type PlanResult = EditPlan | EditFailure;

export function fail(
  error: string,
  extra: { details?: readonly string[]; hint?: string } = {},
): EditFailure {
  return {
    ok: false,
    error,
    ...(extra.details !== undefined && extra.details.length > 0 ? { details: extra.details } : {}),
    ...(extra.hint !== undefined ? { hint: extra.hint } : {}),
  };
}

/** A plain JSON object (not an array, not `null`). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every jsonc parse error of `text`, as `CODE at offset N`, or the value. An
 * empty file — or one holding nothing but comments, which the scaffold invites a
 * user to keep — is `{}`: jsonc-parser reports a missing symbol there, but a file
 * with no setting in it means no setting, and `set` then writes a valid one.
 */
export function parseConfigText(
  text: string,
): { readonly ok: true; readonly value: unknown } | EditFailure {
  if (stripComments(text).trim() === "") {
    return { ok: true, value: {} };
  }
  const errors: ParseError[] = [];
  let value: unknown;
  try {
    value = parse(text, errors, { allowTrailingComma: true });
  } catch (error) {
    return fail(`cannot read the file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (errors.length > 0) {
    return fail("the file is not valid JSONC", {
      details: errors.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`),
      hint: "fix the file by hand (or delete it) — nothing was changed",
    });
  }
  // `null` stays `null`: a document that is not an object is refused by the caller.
  return { ok: true, value: value === undefined ? {} : value };
}

/** One zod issue as a line: `path: message` (the loader prints only `issues[0]`). */
function issueLines(error: {
  issues: readonly { path: readonly (string | number)[]; message: string }[];
}): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
}

/**
 * Validate the WHOLE document against `FileConfigSchema` — every issue, not the
 * first (`load.ts:85` prints `issues[0]`), so a cross-field rule
 * (`subagents.agentTaskDescription` vs `…File`, `schema.ts:250-257`) and a
 * second typo are all reported at once.
 */
export function validateFileConfig(
  value: unknown,
): { readonly ok: true; readonly config: FileConfig } | EditFailure {
  const parsed = FileConfigSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, config: parsed.data };
  }
  const issues = issueLines(parsed.error);
  return fail(
    `the result would not be valid config (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
    {
      details: issues,
    },
  );
}

/** A deep copy of a parsed JSON value (so the caller's document is untouched). */
const copy = (value: unknown): unknown => structuredClone(value);

/**
 * Structural equality of two parsed JSON values, ignoring object key ORDER (a
 * text edit may insert a key elsewhere than the in-memory apply did).
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
    );
  }
  return false;
}

/** Where an edit failed: the concrete path, joined back the way it was written. */
const at = (segments: readonly string[]): string => segments.join(".");

/**
 * Apply one edit to a parsed document, in memory: create missing parents for a
 * `set` (jsonc-parser's `modify` does the same in the text), refuse a parent
 * that is not an object, and refuse a `delete` of a path that is not there.
 */
export function applyEdit(
  value: unknown,
  segments: readonly string[],
  op: EditOp,
): { readonly ok: true; readonly value: unknown } | EditFailure {
  const root = copy(value);
  if (segments.length === 0) {
    return fail("no key given");
  }
  if (!isJsonObject(root)) {
    return fail("the config file's root is not a JSON object", {
      hint: "fix the file by hand — tentacle cannot edit a non-object document",
    });
  }
  let parent = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i] ?? "";
    if (!Object.hasOwn(parent, key) || parent[key] === undefined) {
      if (op.kind === "delete") {
        return fail(`${at(segments.slice(0, i + 1))} is not set`);
      }
      const child: Record<string, unknown> = {};
      parent[key] = child;
      parent = child;
      continue;
    }
    const child = parent[key];
    if (!isJsonObject(child)) {
      return fail(`${at(segments.slice(0, i + 1))} is not a JSON object`, {
        hint: "set a value inside it, or unset it first",
      });
    }
    parent = child;
  }
  const leaf = segments[segments.length - 1] ?? "";
  if (op.kind === "delete") {
    if (!Object.hasOwn(parent, leaf)) {
      return fail(`${at(segments)} is not set`);
    }
    delete parent[leaf];
    return { ok: true, value: root };
  }
  parent[leaf] = copy(op.value);
  return { ok: true, value: root };
}

/** What a path currently holds in a parsed document. */
export function readPath(
  value: unknown,
  segments: readonly string[],
): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  let node: unknown = value;
  for (const segment of segments) {
    if (!isJsonObject(node) || !Object.hasOwn(node, segment)) {
      return { found: false };
    }
    node = node[segment];
  }
  return { found: true, value: node };
}

/**
 * The indentation and line endings to write a NEW node with, read from the file
 * itself: jsonc-parser defaults to two spaces, which on a tab-indented file
 * emits a mixed-indent node (verified: `.tentacle/tmp/config-set/probe-edge2.ts`).
 */
export function formattingOf(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indented = text.split(/\r?\n/).find((line) => /^[ \t]+\S/.test(line));
  if (indented?.startsWith("\t") === true) {
    return { insertSpaces: false, tabSize: 1, eol };
  }
  const spaces = indented === undefined ? 0 : (/^ +/.exec(indented)?.[0].length ?? 0);
  return { insertSpaces: true, tabSize: spaces >= 1 && spaces <= 8 ? spaces : 2, eol };
}

/**
 * The edit plan, in the eval's order (A3 "Validate before write"): parse → apply
 * in memory → validate the whole → text edit → re-verify the text. A refusal
 * leaves the file untouched, because nothing has been written yet.
 */
export function planConfigEdit(input: {
  readonly text: string;
  readonly segments: readonly string[];
  readonly op: EditOp;
}): PlanResult {
  const parsed = parseConfigText(input.text);
  if (!parsed.ok) {
    return parsed;
  }
  const applied = applyEdit(parsed.value, input.segments, input.op);
  if (!applied.ok) {
    return applied;
  }
  const validated = validateFileConfig(applied.value);
  if (!validated.ok) {
    return validated;
  }
  let edited: string;
  try {
    edited = applyEdits(
      input.text,
      modify(
        input.text,
        [...input.segments],
        input.op.kind === "set" ? input.op.value : undefined,
        {
          formattingOptions: formattingOf(input.text),
        },
      ),
    );
  } catch (error) {
    // `modify` THROWS on a non-object document ("Can not add index to parent of
    // type number"): a refusal, never an escaping exception.
    return fail(`cannot edit the file: ${error instanceof Error ? error.message : String(error)}`, {
      hint: "fix the file by hand — nothing was changed",
    });
  }
  // A new file starts as `{}` + the key: give it the trailing newline a text
  // file should end with (jsonc-parser writes none).
  const text =
    edited === "" || /[\r\n]$/.test(edited) ? edited : `${edited}${formattingOf(input.text).eol}`;
  const recheck = parseConfigText(text);
  if (!recheck.ok) {
    return fail("the edit would not produce valid JSONC — nothing was changed");
  }
  if (!sameValue(recheck.value, applied.value)) {
    return fail("the edit would not write the value that was validated — nothing was changed");
  }
  return { ok: true, text, value: applied.value, config: validated.config };
}
