#!/usr/bin/env bun
import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
/**
 * Build the voice helper and put it next to `tentacle` (docs/feat/voice-dictation.md
 * §7). It is a SEPARATE step from `bun run check` on purpose: the helper is a
 * Swift/SwiftPM build for macOS only, and the gate has to stay green on Linux CI.
 *
 * Usage: `bun run voice:build [--universal]` (and `bun run voice:test` for its own tests).
 * Output: `dist/tentacle-voice`, ad-hoc signed like `dist/tentacle`.
 */
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const pkg = join(root, "native", "voice-mac");
const out = join(root, "dist");

if (process.platform !== "darwin") {
  // Not a failure: the feature is macOS-only and the caller may be CI.
  console.log("voice:build: skipped (voice dictation is macOS-only)");
  process.exit(0);
}

// `--universal`: one arm64 + x86_64 binary — what CI ships as the release asset
// `tentacle-voice-darwin` (docs/feat/voice-release.md). Default: this Mac's arch.
const arch = process.argv.includes("--universal") ? ["--arch", "arm64", "--arch", "x86_64"] : [];

console.log(`voice:build: swift build -c release ${arch.join(" ")}`.trimEnd());
await $`swift build -c release ${arch} --package-path ${pkg}`;

const binPath = (
  await $`swift build -c release ${arch} --show-bin-path --package-path ${pkg}`
).stdout
  .toString()
  .trim();
const built = join(binPath, "tentacle-voice");
await mkdir(out, { recursive: true });
const target = join(out, "tentacle-voice");
await cp(built, target);

// Ad-hoc sign, exactly as `scripts/build.ts` does for `dist/tentacle`: an
// unsigned binary is refused by the microphone TCC prompt on Apple Silicon.
if (process.platform === "darwin") {
  await $`codesign --force --sign - ${target}`.quiet().nothrow();
}

const size = (await stat(target)).size;
console.log(`voice:build: wrote ${target} (${(size / 1_000_000).toFixed(1)} MB)`);
console.log(`voice:build: ${dirname(target)}`);
