/**
 * `bun run docs:config` — rewrite docs/guide/configuration.md's config table from the key
 * registry (`packages/config/src/key-docs.ts`).
 *
 * The registry is the ONE place a key is documented (docs/eval/config-cli.md,
 * owner answer Q1 = (b)), so the guide's table must not be hand-kept: this
 * script owns the block between `<!-- config-keys:start -->` and
 * `<!-- config-keys:end -->`, and
 * `packages/config/test/readme-config-table.test.ts` fails when the committed
 * block differs from {@link renderConfigKeysTable}'s output (the same drift gate
 * the protocol's JSON schema has).
 *
 * Idempotent: a second run writes the same bytes. A missing marker is an ERROR
 * (exit 1), never a silent no-op — a table that quietly stops being generated
 * is exactly the rot this replaces.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderConfigKeysTable } from "../packages/config/src/key-docs.ts";

export const README_PATH = resolve(import.meta.dir, "..", "docs", "guide", "configuration.md");
export const START_MARKER = "<!-- config-keys:start -->";
export const END_MARKER = "<!-- config-keys:end -->";

/** What {@link regenerate} did. */
export type RegenerateResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * The guide text with its config block replaced by the generated one. Pure:
 * the caller reads and writes, so a test can check it without a file.
 */
export function withGeneratedBlock(
  text: string,
  block: string,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } {
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER);
  if (start < 0) {
    return { ok: false, error: `no ${START_MARKER} marker in the config guide` };
  }
  if (end < 0) {
    return { ok: false, error: `no ${END_MARKER} marker in the config guide` };
  }
  if (end < start) {
    return { ok: false, error: `${END_MARKER} comes before ${START_MARKER} in the config guide` };
  }
  const before = text.slice(0, start + START_MARKER.length);
  const after = text.slice(end);
  return { ok: true, text: `${before}\n${block}\n${after}` };
}

/** Regenerate the config block in the file at `path`. */
export function regenerate(
  path: string = README_PATH,
  block: string = renderConfigKeysTable(),
): RegenerateResult {
  const current = readFileSync(path, "utf8");
  const next = withGeneratedBlock(current, block);
  if (!next.ok) {
    return next;
  }
  if (next.text === current) {
    return { ok: true, changed: false };
  }
  writeFileSync(path, next.text);
  return { ok: true, changed: true };
}

if (import.meta.main) {
  const result = regenerate();
  if (!result.ok) {
    process.stderr.write(`docs:config: ${result.error}\n`);
    process.exit(1);
  }
  process.stdout.write(
    result.changed
      ? `docs:config: docs/guide/configuration.md's config table updated\n`
      : "docs:config: docs/guide/configuration.md's config table is up to date\n",
  );
}
