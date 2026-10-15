/**
 * Build + cache resolution for the pod-injected `agent-harness` binary (F4.e,
 * step 4). The pod is always Linux, so we only ever build the two Linux targets
 * (`bun-linux-x64` / `bun-linux-arm64`); the laptop's own platform is irrelevant
 * (cross-compilation via `Bun.build` `compile.target`).
 *
 * Resolution order for a target (see `resolvePodBinary`):
 *   1. `HARNESS_POD_BIN` — an explicit path to a prebuilt binary (the primary
 *      "I build it myself" knob); read directly, never cached/built.
 *   2. The cache at `dist/pod-bin/agent-harness-<target>` (git-ignored).
 *   3. Build into the cache with the SAME options as the CLI build
 *      (`buildBinary`), so the pod binary and the local binary never drift.
 *
 * The build options are shared with `scripts/build.ts` (which imports
 * `buildBinary` from here) so the worker second entrypoint, the embedded
 * yoga-wasm, and the version `define` stay identical across both paths.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PodBinaryTarget } from "./pod-binary.ts";

/**
 * The monorepo root, relative to this source file. Only the source CLI runs
 * this (injection happens on the laptop); a compiled binary never reaches
 * `resolvePodBinary`, so a source-relative root is correct.
 */
const root = resolve(import.meta.dir, "../../..");
const yogaShim = resolve(root, "scripts/yoga-auto.ts");

/** Locate the real yoga.wasm so we can embed its bytes (shared with the CLI build). */
export function findYogaWasm(): string {
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
 * Build the standalone `agent-harness` binary to `outfile` for `target`. Shared
 * by `scripts/build.ts` (the `compile` script) and the pod-binary cache so the
 * two never drift. Returns `true` on success, `false` (after logging) on
 * failure — the caller decides whether to exit.
 */
export async function buildBinary(outfile: string, target: string | undefined): Promise<boolean> {
  const wasmPath = findYogaWasm();
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
    // Inject the CLI package version as a literal (`--version` reads
    // `process.env.HARNESS_APP_VERSION`; from source it falls back to "dev").
    define: {
      "process.env.HARNESS_APP_VERSION": JSON.stringify(
        JSON.parse(readFileSync(resolve(root, "packages/cli/package.json"), "utf8")).version,
      ),
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

/** The default pod-binary cache directory (git-ignored, next to `dist/`). */
export function podBinCacheDir(): string {
  return resolve(root, "dist/pod-bin");
}

export interface ResolvePodBinaryOptions {
  /** Override the cache directory (tests). Defaults to `dist/pod-bin`. */
  readonly cacheDir?: string;
  /** Override the build step (tests); defaults to `buildBinary`. */
  readonly build?: (outfile: string, target: string) => Promise<boolean>;
  readonly log?: (line: string) => void;
}

/**
 * Resolve the bytes of the `agent-harness` binary for `target`, in order:
 * `HARNESS_POD_BIN` (explicit prebuilt) → the cache → build into the cache.
 * Returns the file bytes ready to stream into the pod.
 */
export async function resolvePodBinary(
  target: PodBinaryTarget,
  options: ResolvePodBinaryOptions = {},
): Promise<Uint8Array> {
  const log = options.log ?? (() => {});
  const build = options.build ?? buildBinary;
  // 1) An explicit prebuilt binary wins — the primary "I build it myself" knob.
  const override = process.env.HARNESS_POD_BIN;
  if (override) {
    log(`[pod-binary] using HARNESS_POD_BIN → ${override}\n`);
    return new Uint8Array(readFileSync(override));
  }
  // 2/3) Cache, building on a miss. The cache key is the full Bun target
  // (e.g. `agent-harness-bun-linux-x64`) so x64/arm64 never collide.
  const cacheDir = options.cacheDir ?? podBinCacheDir();
  const outfile = resolve(cacheDir, `agent-harness-${target}`);
  if (!existsSync(outfile)) {
    log(`[pod-binary] no cache for ${target}; building → ${outfile}\n`);
    // `dist/pod-bin/` may not exist yet.
    mkdirSync(cacheDir, { recursive: true });
    const ok = await build(outfile, target);
    if (!ok || !existsSync(outfile)) {
      throw new Error(
        `failed to build the ${target} agent-harness binary — run \`TARGET=${target} bun run compile\` and point HARNESS_POD_BIN at it`,
      );
    }
    log(`[pod-binary] built ${target} → ${outfile}\n`);
  } else {
    log(`[pod-binary] using cache ${outfile}\n`);
  }
  return new Uint8Array(readFileSync(outfile));
}
