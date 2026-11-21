/**
 * Biome-format generated text in memory (`biome format --stdin-file-path`), so
 * the committed files pass `biome check` and the drift test compares the SAME
 * formatted bytes `gen` writes (the `schema:export` pattern, without a temp file).
 */
import { join } from "node:path";
import type { Generated } from "./emit.ts";
import { ROOT } from "./sources.ts";

const BIOME = join(ROOT, "node_modules/.bin/biome");

export function biomeFormat(fileName: string, text: string): string {
  const r = Bun.spawnSync([BIOME, "format", `--stdin-file-path=${fileName}`], {
    cwd: ROOT,
    stdin: Buffer.from(text, "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`mockup-kit: biome format ${fileName} failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString();
}

/** The `generate` output, each file formatted as `gen` writes it. */
export function formatAll(out: Generated): Generated {
  const f = (name: keyof Generated): string =>
    biomeFormat(`tools/mockup-kit/generated/${name}`, out[name]);
  return {
    "tokens.css": f("tokens.css"),
    "tui-tokens.css": f("tui-tokens.css"),
    "kit-data.json": f("kit-data.json"),
  };
}
