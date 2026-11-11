/**
 * A COMPILED DEV BUILD, for tests that need one (docs/fix/dev-build-version-skew.md,
 * fix round 1). From source `APP_VERSION` is `"dev"` — never the suffixed
 * `0.3.0+<id>` a compiled build reports — so a test that only imports
 * `version.ts` in the suite's process cannot exercise the `+` version through a
 * consumer that compares a version.
 *
 * `version.ts` reads its literals through `typeof __TENTACLE_*` (a `define` in a
 * real build), which resolves on `globalThis` when no define exists. Seeding the
 * two globals HERE, before the first import of `version.ts`, reproduces exactly
 * what `bun run compile` bakes in: a plain version marker and a build marker
 * beside it. A fresh process is required (the module cache is per run), hence
 * `Bun.spawnSync` in the tests — and `process.exitCode` carries the verdict.
 *
 * `FIXTURE` selects the scenario; `FIXTURE_CONFIG_DIR` a config dir. Both are
 * deliberately NOT `TENTACLE_*`: `scripts/test-env-guard.ts` strips those.
 */
const globals = globalThis as Record<string, unknown>;
globals.__TENTACLE_VERSION_MARKER__ = "TENTACLE_VERSION_MARKER:0.3.0:END";
globals.__TENTACLE_BUILD_MARKER__ = "TENTACLE_BUILD_MARKER:1a2b3c4d5e6f:END";

// A module, so the `await`s below are top-level ones (this file is a script).
export {};

/** The latest release this fixture pretends exists (a 404 for everything else). */
const REPO = "gmeghnag/tentacle";

const scenario = process.env.FIXTURE;
const configDir = process.env.FIXTURE_CONFIG_DIR ?? process.cwd();
// `main`'s own seam is `configDirFromEnv()`; set it here so the test passes one
// name (the guard in scripts/test-env-guard.ts strips `TENTACLE_*` from the SUITE).
process.env.TENTACLE_CONFIG_DIR = configDir;
const urls: string[] = [];

/** Every network answer is this one function: nothing real is fetched. */
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  urls.push(url);
  if (url === `https://github.com/${REPO}/releases/latest`) {
    return new Response(null, {
      status: 302,
      headers: { location: `https://github.com/${REPO}/releases/tag/v0.3.0` },
    });
  }
  return new Response("Not Found", { status: 404 });
}) as unknown as typeof fetch;

const { APP_RELEASE_VERSION, APP_VERSION } = await import("../../src/version.ts");
const out: string[] = [];
const err: string[] = [];
const report = (extra: Record<string, unknown> = {}): void => {
  console.log(
    JSON.stringify({
      appVersion: APP_VERSION,
      appReleaseVersion: APP_RELEASE_VERSION,
      out: out.join(""),
      err: err.join(""),
      downloads: urls.filter((u) => u.includes("/download/")),
      ...extra,
    }),
  );
};

if (scenario === "checkPodBinaries") {
  // The DEFAULTS, not an explicit `appVersion`: the default is what `run`/`attach`
  // take, and it is the thing that must be plain.
  const { checkPodBinaries } = await import("../../src/pod-binary-build.ts");
  try {
    await checkPodBinaries({ configDir });
    report();
  } catch (error) {
    report({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
} else if (scenario === "update") {
  const { main } = await import("../../src/main.ts");
  // `main` reads `argv.slice(2)`, like the process's own argv.
  const code = await main(["bun", "tentacle", "update", "--check"], {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    terminal: { stdin: false, stdout: false },
  });
  report({ code });
  process.exitCode = code === 0 ? 0 : 1;
} else {
  console.error(`unknown FIXTURE: ${String(scenario)}`);
  process.exitCode = 2;
}
