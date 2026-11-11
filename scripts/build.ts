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
import {
  buildBinary,
  buildIdFor,
  cliVersion,
  computeBuildId,
} from "../packages/cli/src/pod-binary-build.ts";
import {
  findAllBuildMarkers,
  findAllVersionMarkers,
  readBinaryVersion,
} from "../packages/cli/src/version-marker.ts";
import { devBuildVersion } from "../packages/cli/src/version.ts";

const root = resolve(import.meta.dir, "..");
const outfile = resolve(root, "dist/tentacle");
const target = process.env.TARGET; // e.g. bun-linux-x64, bun-darwin-arm64

// What this build calls itself (docs/fix/dev-build-version-skew.md). A RELEASE
// build reports the plain version, so the release job sets TENTACLE_RELEASE=1:
// `update` installs by exact version, and build.yml refuses a tag that differs
// from `packages/cli/package.json`. Every other build (a checkout, a local
// build, the pod-binary cache) carries `+<build id>`, because otherwise two
// builds of one version are indistinguishable in a VersionMismatch — the live
// case: "client 21 (tentacle 0.3.0), daemon 16 (tentacle 0.3.0)", a `main`
// checkout against release v0.3.0. The decision itself is `buildIdFor` (tested).
const buildId = buildIdFor(process.env, computeBuildId(root));

const ok = await buildBinary(outfile, target, buildId);
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
// Exactly ONE well-formed marker (review N1): a second one could shadow it.
const expected = cliVersion();
const markers = findAllVersionMarkers(new Uint8Array(await Bun.file(outfile).arrayBuffer()));
const marked = await readBinaryVersion(outfile);
if (markers.length !== 1 || markers[0] !== expected || marked !== expected) {
  console.error(
    `error: ${outfile} carries version marker(s) [${markers.join(", ") || "none"}], expected exactly one: ${expected}`,
  );
  process.exit(1);
}
console.log(`version marker ${marked} ok`);

// The build id (docs/fix/stale-pod-binary.md): a dev build carries exactly one,
// and it is this source's; a release build carries none, and its version is
// then plain (below). Exactly one well-formed marker either way, so a second
// one can never shadow it (review N1).
const expectedBuild = buildId;
const builds = findAllBuildMarkers(new Uint8Array(await Bun.file(outfile).arrayBuffer()));
if (
  expectedBuild === undefined
    ? builds.length !== 0
    : builds.length !== 1 || builds[0] !== expectedBuild
) {
  console.error(
    `error: ${outfile} carries build marker(s) [${builds.join(", ") || "none"}], expected ${expectedBuild === undefined ? "none (a release build)" : `exactly one: ${expectedBuild}`}`,
  );
  process.exit(1);
}
console.log(
  expectedBuild === undefined
    ? "build marker none (release build) ok"
    : ["build marker", expectedBuild, "ok"].join(" "),
);

// The version the binary reports is `marked` — the package.json version, plus
// `+<build id>` for anything that is not a release build (`devBuildVersion`).
console.log(`compiled tentacle ${devBuildVersion(marked, expectedBuild)} → ${outfile}`);
