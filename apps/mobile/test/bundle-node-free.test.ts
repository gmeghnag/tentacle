/**
 * The app's bundle reaches no Node built-in (docs/fix/mobile-bundle-node-import.md).
 *
 * Metro cannot resolve `node:crypto` & co., so one runtime import of a
 * Node-only module anywhere in the graph the app bundles fails the iOS archive —
 * and neither typecheck nor the e2e gate bundles with Metro. This walks the same
 * static graph from the app's entry: relative imports and workspace
 * `@tentacle/*` packages (their package.json `exports`, subpaths included) are
 * followed; third-party packages are leaves (Metro resolves them for RN); a
 * type-only import is skipped (it is erased before bundling). Any `node:`
 * specifier or bare Node built-in name reached fails, with its import chain.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const APP = resolve(import.meta.dir, "..");
const ROOT = resolve(APP, "../..");
const ENTRY = join(APP, "index.ts");

/** Workspace package name → { dir, exports map }. */
function workspacePackages(): Map<string, { dir: string; exports: Record<string, string> }> {
  const out = new Map<string, { dir: string; exports: Record<string, string> }>();
  const base = join(ROOT, "packages");
  for (const name of readdirSync(base)) {
    const pkgPath = join(base, name, "package.json");
    if (!existsSync(pkgPath)) {
      continue;
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name: string;
      exports?: Record<string, string>;
    };
    out.set(pkg.name, { dir: join(base, name), exports: pkg.exports ?? { ".": "./src/index.ts" } });
  }
  return out;
}

const PACKAGES = workspacePackages();
const NODE_BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));
// Metro's platform order for an iOS build, then the plain extensions.
const EXTENSIONS = [
  ".ios.ts",
  ".ios.tsx",
  ".native.ts",
  ".native.tsx",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
];

/** Code Metro transforms; anything else (an asset: .png, .html, .json) is a leaf. */
const CODE = /\.(?:[cm]?[jt]sx?)$/;

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

function resolveFile(base: string): string | undefined {
  if (isFile(base)) {
    return base;
  }
  for (const ext of EXTENSIONS) {
    if (isFile(base + ext)) {
      return base + ext;
    }
  }
  for (const ext of EXTENSIONS) {
    const index = join(base, `index${ext}`);
    if (isFile(index)) {
      return index;
    }
  }
  return undefined;
}

/** A specifier → the file it names, `"external"` (third-party leaf), or a Node built-in hit. */
function resolveSpecifier(
  spec: string,
  from: string,
): { file: string } | { external: true } | { node: true } {
  if (spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0] ?? spec)) {
    return { node: true };
  }
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const file = resolveFile(resolve(dirname(from), spec));
    if (file === undefined) {
      throw new Error(`unresolved ${spec} from ${relative(ROOT, from)}`);
    }
    return { file };
  }
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
  const pkg = PACKAGES.get(name);
  if (pkg === undefined) {
    return { external: true };
  }
  const sub = spec === name ? "." : `.${spec.slice(name.length)}`;
  const target = pkg.exports[sub];
  if (target === undefined) {
    throw new Error(`${spec} is not exported by ${name} (from ${relative(ROOT, from)})`);
  }
  return { file: join(pkg.dir, target) };
}

const transpiler = new Bun.Transpiler({ loader: "tsx" });
const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
const jsTranspiler = new Bun.Transpiler({ loader: "jsx" });

const scan = (file: string): readonly { path: string }[] => {
  const t = file.endsWith(".tsx") ? transpiler : file.endsWith(".ts") ? tsTranspiler : jsTranspiler;
  try {
    return t.scanImports(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot scan ${relative(ROOT, file)}: ${String(error)}`);
  }
};

/** Every Node-built-in reach in the graph from `entry`, each with its import chain. */
function nodeReaches(entry: string): string[][] {
  const parent = new Map<string, string | undefined>([[entry, undefined]]);
  const queue = [entry];
  const hits: string[][] = [];
  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    for (let at: string | undefined = file; at !== undefined; at = parent.get(at)) {
      chain.unshift(relative(ROOT, at));
    }
    return chain;
  };
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    // scanImports drops `import type`, `export type` and all-`type` specifier lists.
    for (const { path: spec } of scan(file)) {
      const r = resolveSpecifier(spec, file);
      if ("node" in r) {
        hits.push([...chainTo(file), spec]);
      } else if ("file" in r && CODE.test(r.file) && !parent.has(r.file)) {
        parent.set(r.file, file);
        queue.push(r.file);
      }
    }
  }
  return hits;
}

describe("mobile bundle graph", () => {
  test("no Node built-in is reachable from the app entry", () => {
    const hits = nodeReaches(ENTRY);
    const report = hits.map((chain) => chain.join("\n  → ")).join("\n\n");
    expect(report).toBe("");
  });

  test("the walker sees a planted node: import (non-vacuity)", () => {
    // The client barrel reaches workspace packages; a planted import must show.
    const planted = transpiler.scanImports('import { randomUUID } from "node:crypto";');
    expect(planted.map((i) => i.path)).toEqual(["node:crypto"]);
    expect(resolveSpecifier("node:crypto", ENTRY)).toEqual({ node: true });
    expect(resolveSpecifier("crypto", ENTRY)).toEqual({ node: true });
    expect(resolveSpecifier("expo", ENTRY)).toEqual({ external: true });
  });
});
