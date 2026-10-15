/**
 * Build the standalone `agent-harness` binary with `bun build --compile`.
 *
 * Two third-party snags are handled here:
 *  - `react-devtools-core` (an optional ink dev dependency) is provided by a
 *    local no-op stub (stubs/ + the root package.json dependency).
 *  - `yoga-wasm-web/auto` reads `yoga.wasm` from disk at runtime; a compiled
 *    binary has none, so we alias it to scripts/yoga-auto.ts and feed the wasm
 *    bytes in through a `virtual:yoga-wasm` module — all embedded in the binary.
 *
 * Usage: `bun run compile` (optionally `TARGET=bun-linux-x64 bun run compile`
 * to cross-compile; see `bun build --help` for target triples).
 *
 * macOS note: Bun appends the JS payload *after* the linker ad-hoc signs the
 * executable, leaving an invalid signature. That runs where it was built but is
 * SIGKILLed ("killed: 9") once copied/moved to a new path on Apple Silicon. So
 * on macOS we re-sign the output ad-hoc (`codesign -s - -f`), which covers the
 * whole file and survives relocation.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const shim = resolve(import.meta.dir, "yoga-auto.ts");
const outfile = resolve(root, "dist/agent-harness");
const target = process.env.TARGET; // e.g. bun-linux-x64, bun-darwin-arm64

/** Locate the real yoga.wasm so we can embed its bytes. */
function findYogaWasm(): string {
  const candidates: string[] = [];
  try {
    candidates.push(resolve(dirname(Bun.resolveSync("yoga-wasm-web/package.json", root)), "dist/yoga.wasm"));
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

const wasmPath = findYogaWasm();
const wasmBase64 = readFileSync(wasmPath).toString("base64");
// The instantiator lives next to the wasm (dist/index.js); give the bundler its
// absolute path so it needn't resolve the package's restricted `exports` map.
const yogaInitPath = resolve(dirname(wasmPath), "index.js");

// Inject the CLI package version as a literal (`agent-harness --version` reads
// `process.env.HARNESS_APP_VERSION`; from source it falls back to "dev").
const cliVersion = JSON.parse(
  readFileSync(resolve(root, "packages/cli/package.json"), "utf8"),
).version as string;

const result = await Bun.build({
  // `worker.ts` is a second entrypoint on purpose: in a compiled binary the
  // daemon worker must be embedded, and `new Worker("./worker.ts")` resolves
  // against the embedded entrypoints — without it the spawn fails with
  // "ModuleNotFound resolving /$bunfs/root/worker.ts" (see local-runtime.ts).
  entrypoints: [resolve(root, "packages/cli/src/main.ts"), resolve(root, "packages/cli/src/worker.ts")],
  // @ts-expect-error - `compile` is supported by the Bun bundler
  compile: { outfile, ...(target ? { target } : {}) },
  define: { "process.env.HARNESS_APP_VERSION": JSON.stringify(cliVersion) },
  minify: true,
  plugins: [
    {
      name: "yoga-auto-embed",
      setup(build) {
        build.onResolve({ filter: /^yoga-wasm-web\/auto$/ }, () => ({ path: shim }));
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

console.log(`compiled → ${outfile}`);
