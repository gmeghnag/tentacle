/**
 * Build + cache resolution for the pod-injected `tentacle` binary (F4.e,
 * step 4). The pod is always Linux, so we only ever build the two Linux targets
 * (`bun-linux-x64` / `bun-linux-arm64`); the laptop's own platform is irrelevant
 * (cross-compilation via `Bun.build` `compile.target`).
 *
 * Resolution order for a target (see `resolvePodBinary`):
 *   1. `TENTACLE_POD_BIN` — an explicit path to a prebuilt binary (the primary
 *      "I build it myself" knob); read directly, never cached/built.
 *   2. A release build: `<configDir>/bin/tentacle-<target>`, only at exactly
 *      this tentacle's version (its marker, D2); else an error ("run
 *      `tentacle update`", D1). From source ("dev"): `<configDir>/bin`, then
 *      the cache at `dist/pod-bin/tentacle-<target>` (git-ignored), then
 *   3. build into the cache with the SAME options as the CLI build
 *      (`buildBinary`), so the pod binary and the local binary never drift.
 *
 * The build options are shared with `scripts/build.ts` (which imports
 * `buildBinary` from here) so the worker second entrypoint, the embedded
 * yoga-wasm, and the version `define` stay identical across both paths.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PodBinaryTarget } from "./pod-binary.ts";
import { readBinaryVersion } from "./version-marker.ts";
import { APP_VERSION, formatVersionMarker } from "./version.ts";

/**
 * Resolve the monorepo root so the cache/build paths work in BOTH run modes:
 * - source: this file lives at `packages/cli/src/`, so root is three up;
 * - compiled binary: `import.meta.dir` is the virtual `$bunfs` root, but
 *   `process.execPath` is the real binary path (`<repo>/dist/tentacle`),
 *   so walk up to the directory that owns `package.json`.
 *
 * The `run` flow runs the compiled binary (`./dist/tentacle run …`),
 * so this must NOT assume source mode. Last resort is the current working
 * directory (the user runs the binary from the repo; `node_modules` discovery
 * in `findYogaWasm` still works from there).
 */
export function repoRoot(): string {
  if (!import.meta.url.includes("$bunfs")) {
    return resolve(import.meta.dir, "../../..");
  }
  let dir = dirname(process.execPath);
  for (let i = 0; i < 8 && dir !== dirname(dir); i++) {
    if (existsSync(resolve(dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return process.cwd();
}

/** Locate the real yoga.wasm so we can embed its bytes (shared with the CLI build). */
export function findYogaWasm(): string {
  const root = repoRoot();
  const candidates: string[] = [];
  try {
    candidates.push(
      resolve(dirname(Bun.resolveSync("yoga-wasm-web/package.json", root)), "dist/yoga.wasm"),
    );
  } catch {}
  try {
    candidates.push(resolve(dirname(Bun.resolveSync("yoga-wasm-web", root)), "yoga.wasm"));
  } catch {}
  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }
  // Fallback: search the install tree (including Bun's hidden `.bun` store).
  const nm = resolve(root, "node_modules");
  const hit = [
    ...new Bun.Glob("**/yoga-wasm-web/dist/yoga.wasm").scanSync({ cwd: nm, dot: true }),
  ][0];
  if (hit) {
    return resolve(nm, hit);
  }
  throw new Error("could not locate yoga.wasm — is yoga-wasm-web installed?");
}

/**
 * Build the standalone `tentacle` binary to `outfile` for `target`. Shared
 * by `scripts/build.ts` (the `compile` script) and the pod-binary cache so the
 * two never drift. Returns `true` on success, `false` (after logging) on
 * failure — the caller decides whether to exit.
 */
export async function buildBinary(outfile: string, target: string | undefined): Promise<boolean> {
  const root = repoRoot();
  const wasmPath = findYogaWasm();
  const yogaShim = resolve(root, "scripts/yoga-auto.ts");
  const wasmBase64 = readFileSync(wasmPath).toString("base64");
  // The instantiator lives next to the wasm (dist/index.js); give the bundler
  // its absolute path so it needn't resolve the package's restricted `exports` map.
  const yogaInitPath = resolve(dirname(wasmPath), "index.js");

  const result = await Bun.build({
    // `worker.ts` is a second entrypoint on purpose: in a compiled binary the
    // daemon worker must be embedded, and `new Worker("./worker.ts")` resolves
    // against the embedded entrypoints — without it the spawn fails with
    // "ModuleNotFound resolving /$bunfs/root/worker.ts" (see local-runtime.ts).
    entrypoints: [
      resolve(root, "packages/cli/src/main.ts"),
      resolve(root, "packages/cli/src/worker.ts"),
    ],
    // @ts-expect-error - `compile` is supported by the Bun bundler
    compile: { outfile, ...(target ? { target } : {}) },
    // Inject the CLI package version as the marker literal
    // `TENTACLE_VERSION_MARKER:<version>:END` (D2): `APP_VERSION` (version.ts)
    // is parsed from it, and `readBinaryVersion` finds it in the file without
    // executing it. From source it is undefined → "dev".
    define: {
      __TENTACLE_VERSION_MARKER__: JSON.stringify(formatVersionMarker(cliVersion())),
    },
    minify: true,
    plugins: [
      {
        name: "yoga-auto-embed",
        setup(build) {
          build.onResolve({ filter: /^yoga-wasm-web\/auto$/ }, () => ({ path: yogaShim }));
          build.onResolve({ filter: /^virtual:yoga-init$/ }, () => ({ path: yogaInitPath }));
          build.onResolve({ filter: /^virtual:yoga-wasm$/ }, () => ({
            path: "virtual:yoga-wasm",
            namespace: "yoga",
          }));
          build.onLoad({ filter: /.*/, namespace: "yoga" }, () => ({
            contents: `export default ${JSON.stringify(wasmBase64)};`,
            loader: "js",
          }));
        },
      },
    ],
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    return false;
  }
  return true;
}

/** `packages/cli/package.json` `version`: the single source of a build's version. */
export function cliVersion(): string {
  return JSON.parse(readFileSync(resolve(repoRoot(), "packages/cli/package.json"), "utf8")).version;
}

/** The default pod-binary cache directory (git-ignored, next to `dist/`). */
export function podBinCacheDir(): string {
  return resolve(repoRoot(), "dist/pod-bin");
}

/**
 * The stable, cwd-independent home for a prebuilt pod binary:
 * `<configDir>/bin/tentacle-<target>`. Per-arch (x64/arm64 coexist). `bin/`
 * (not `pod-bin/`) because a future docker/podman runner reuses the same spot.
 */
export function configBinPath(configDir: string, target: PodBinaryTarget): string {
  return resolve(configDir, "bin", `tentacle-${target}`);
}

export interface ResolvePodBinaryOptions {
  /**
   * The user's config dir. The stable, cwd-independent home for prebuilt pod
   * binaries is `<configDir>/bin/tentacle-<target>` (`configBinPath`), checked
   * before the repo cache — so a daily driver run from ANY directory finds the
   * binary without a source tree (a compiled binary can't cross-compile from an
   * arbitrary cwd).
   */
  readonly configDir?: string;
  /** Override the cache directory (tests). Defaults to `dist/pod-bin`. */
  readonly cacheDir?: string;
  /** Override the build step (tests); defaults to `buildBinary`. */
  readonly build?: (outfile: string, target: string) => Promise<boolean>;
  readonly log?: (line: string) => void;
  /**
   * This tentacle's version (tests); defaults to `APP_VERSION`. `"dev"` (from
   * source) keeps the cache/build path; a release requires a
   * `<configDir>/bin` binary whose version marker equals it (D1/D2).
   */
  readonly appVersion?: string;
}

/** A pod binary that is missing or not at this tentacle's version (D1). */
export class PodBinaryError extends Error {
  override readonly name = "PodBinaryError";
}

/** The Linux targets `tentacle update` installs; `run` needs both (D1). */
export const POD_BINARY_TARGETS: readonly PodBinaryTarget[] = ["bun-linux-x64", "bun-linux-arm64"];

/**
 * Release mode: why `<configDir>/bin/tentacle-<target>` cannot be injected, or
 * `null` when it exists and its version marker equals `appVersion`. Read-only.
 */
export async function podBinaryProblem(
  target: PodBinaryTarget,
  configDir: string | undefined,
  appVersion: string,
): Promise<string | null> {
  const arch = target.slice("bun-linux-".length);
  const fix = "run `tentacle update`";
  if (!configDir) {
    return `the Linux pod binary for ${arch} is missing (no config dir): ${fix}`;
  }
  const path = configBinPath(configDir, target);
  if (!existsSync(path)) {
    return `the Linux pod binary for ${arch} is missing (${path}; this tentacle is ${appVersion}): ${fix}`;
  }
  const version = await readBinaryVersion(path);
  if (version === appVersion) {
    return null;
  }
  const at = version === undefined ? "of unknown version" : `at version ${version}`;
  return `the Linux pod binary for ${arch} is ${at} (${path}; this tentacle is ${appVersion}): ${fix}`;
}

/**
 * `run`'s preflight, BEFORE the pod is created (the pod's arch is not known
 * yet, so both targets must be ready — `tentacle update` installs both, D1).
 * A no-op from source (`"dev"`) and with `TENTACLE_POD_BIN` (an explicit
 * binary the user vouches for), the two cases `resolvePodBinary` does not check.
 * Throws a `PodBinaryError` listing every problem.
 */
export async function checkPodBinaries(
  options: Pick<ResolvePodBinaryOptions, "configDir" | "appVersion"> = {},
): Promise<void> {
  const appVersion = options.appVersion ?? APP_VERSION;
  if (appVersion === "dev" || process.env.TENTACLE_POD_BIN) {
    return;
  }
  const problems: string[] = [];
  for (const target of POD_BINARY_TARGETS) {
    const problem = await podBinaryProblem(target, options.configDir, appVersion);
    if (problem) {
      problems.push(problem);
    }
  }
  if (problems.length > 0) {
    throw new PodBinaryError(problems.join("\n"));
  }
}

/**
 * Resolve the bytes of the `tentacle` binary for `target`, in order:
 * `TENTACLE_POD_BIN` (explicit prebuilt) → then, from source (`"dev"`):
 * `<configDir>/bin/tentacle-<target>` (the stable per-arch home,
 * cwd-independent) → the repo cache → build into the cache; in a release
 * build: `<configDir>/bin/tentacle-<target>` ONLY if its version marker equals
 * this tentacle's version, else a `PodBinaryError` ("run `tentacle update`").
 * Returns the file bytes.
 */
export async function resolvePodBinary(
  target: PodBinaryTarget,
  options: ResolvePodBinaryOptions = {},
): Promise<Uint8Array> {
  const log = options.log ?? (() => {});
  const build = options.build ?? buildBinary;
  // 1) An explicit prebuilt binary wins — the primary "I build it myself" knob.
  const override = process.env.TENTACLE_POD_BIN;
  if (override) {
    log(`[pod-binary] using TENTACLE_POD_BIN → ${override}\n`);
    return new Uint8Array(readFileSync(override));
  }
  // 2r) A release build (D1/D2): only <configDir>/bin, and only at exactly this
  // version (its marker, read without executing it). Never the repo cache or a
  // build, never the network: a miss is an error pointing at `tentacle update`.
  const appVersion = options.appVersion ?? APP_VERSION;
  if (appVersion !== "dev") {
    const problem = await podBinaryProblem(target, options.configDir, appVersion);
    if (problem || !options.configDir) {
      throw new PodBinaryError(problem ?? "no config dir");
    }
    const stable = configBinPath(options.configDir, target);
    log(`[pod-binary] using ${stable} (${appVersion})\n`);
    return new Uint8Array(readFileSync(stable));
  }
  // From source ("dev"), unchanged:
  // 2) The stable, cwd-independent home: <configDir>/bin/tentacle-<target>.
  // This is what makes `run`/`exec` work from an arbitrary working directory:
  // a compiled binary there has no source tree to build from.
  if (options.configDir) {
    const stable = configBinPath(options.configDir, target);
    if (existsSync(stable)) {
      log(`[pod-binary] using ${stable}\n`);
      return new Uint8Array(readFileSync(stable));
    }
  }
  // 3/4) Repo cache, building on a miss. The cache key is the full Bun target
  // (e.g. `tentacle-bun-linux-x64`) so x64/arm64 never collide. The build only
  // works when a source tree is reachable (running from the repo).
  const cacheDir = options.cacheDir ?? podBinCacheDir();
  const outfile = resolve(cacheDir, `tentacle-${target}`);
  if (!existsSync(outfile)) {
    log(`[pod-binary] no cache for ${target}; building → ${outfile}\n`);
    // `dist/pod-bin/` may not exist yet.
    mkdirSync(cacheDir, { recursive: true });
    const ok = await build(outfile, target);
    if (!ok || !existsSync(outfile)) {
      throw new Error(
        `failed to build the ${target} tentacle binary — run \`TARGET=${target} bun run compile\`, then put it at <configDir>/bin/tentacle-${target} (or point TENTACLE_POD_BIN at it)`,
      );
    }
    log(`[pod-binary] built ${target} → ${outfile}\n`);
  } else {
    log(`[pod-binary] using cache ${outfile}\n`);
  }
  return new Uint8Array(readFileSync(outfile));
}
