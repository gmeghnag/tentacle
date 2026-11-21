/**
 * The mockup kit's CLI (docs/feat/mobile-mockup-kit.md):
 *   bun scripts/mockup-kit.ts gen                      regenerate tools/mockup-kit/generated/*
 *   bun scripts/mockup-kit.ts inline <in.html> [out]   a self-contained, sha-stamped snapshot
 *   bun scripts/mockup-kit.ts calibrate [--run <dir>]  kit vs real screenshots (informational)
 */
import { join } from "node:path";
import { generate } from "./mockup-kit/emit.ts";
import { formatAll } from "./mockup-kit/format.ts";
import { ROOT, loadInput } from "./mockup-kit/sources.ts";

export const GENERATED_DIR = join(ROOT, "tools/mockup-kit/generated");

async function gen(): Promise<void> {
  const out = formatAll(generate(await loadInput()));
  const paths: string[] = [];
  for (const [name, text] of Object.entries(out)) {
    const p = join(GENERATED_DIR, name);
    await Bun.write(p, text);
    paths.push(p);
  }
  console.log(`mockup-kit: wrote ${paths.length} files to tools/mockup-kit/generated`);
}

async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "gen") {
    await gen();
    return 0;
  }
  if (cmd === "inline") {
    const { inlineCommand } = await import("./mockup-kit/inline.ts");
    return inlineCommand(rest);
  }
  if (cmd === "calibrate") {
    const { calibrateCommand } = await import("./mockup-kit/calibrate.ts");
    return calibrateCommand(rest);
  }
  console.error(
    "usage: bun scripts/mockup-kit.ts gen | inline <in.html> [out.html] | calibrate [--run <dir>]",
  );
  return 2;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
