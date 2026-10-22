/**
 * Build the standalone `tentacle` binary with `bun build --compile`.
 *
 * The build options (entrypoints incl. the worker, the embedded yoga-wasm, the
 * version `define`) live in `packages/cli/src/pod-binary-build.ts`
 * (`buildBinary`) and are shared with the pod-binary cache (F4.e) so the CLI
 * build and the injected pod binary never drift. This script adds only the
 * `TARGET` env plumbing, the macOS re-sign, and the version-marker check:
 *
 * macOS note: Bun appends the JS payload *after* the linker ad-hoc signs the
 * executable, leaving an invalid signature. That runs where it was built but is
 * SIGKILLed ("killed: 9") once copied/moved to a new path on Apple Silicon. So
 * on macOS we re-sign the output ad-hoc (`codesign -s - -f`), which covers the
 * whole file and survives relocation.
 *
 * Usage: `bun run compile` (optionally `TARGET=bun-linux-x64 bun run compile`
 * to cross-compile; see `bun build --help` for target triples).
 */
import { resolve } from "node:path";
import { buildBinary, cliVersion } from "../packages/cli/src/pod-binary-build.ts";
import { readBinaryVersion } from "../packages/cli/src/version-marker.ts";

const root = resolve(import.meta.dir, "..");
const outfile = resolve(root, "dist/tentacle");
const target = process.env.TARGET; // e.g. bun-linux-x64, bun-darwin-arm64

const ok = await buildBinary(outfile, target);
if (!ok) {
  process.exit(1);
}

// Re-sign ad-hoc on macOS so the binary stays valid after being copied/moved
// (see the macOS note above). Only when producing a macOS binary.
const targetsMac = target ? target.includes("darwin") : process.platform === "darwin";
if (process.platform === "darwin" && targetsMac) {
  const signed = Bun.spawnSync(["codesign", "--sign", "-", "--force", outfile]);
  if (signed.exitCode !== 0) {
    console.error(
      `warning: codesign failed — the binary may be killed when moved on Apple Silicon.\n${signed.stderr.toString()}`,
    );
  } else {
    console.log("ad-hoc signed (codesign)");
  }
}

// The version marker (D2, docs/feat/pod-binary-download.md) must be in the
// final file (after the re-sign) and match the CLI version: `run`/`attach`
// refuse a pod binary whose marker differs from the laptop's version. Read
// only — the binary is never modified here. CI runs this for every target.
const expected = cliVersion();
const marked = await readBinaryVersion(outfile);
if (marked !== expected) {
  console.error(
    `error: ${outfile} carries version marker ${marked ?? "(none)"}, expected ${expected}`,
  );
  process.exit(1);
}
console.log(`version marker ${marked} ok`);

console.log(`compiled → ${outfile}`);
