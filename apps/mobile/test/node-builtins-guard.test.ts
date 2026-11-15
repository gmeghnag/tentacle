/**
 * docs/feat/session-auto-accept.md Review round 1, HIGH 2: the phone app stopped
 * bundling because `@tentacle/client` imported `node:os`. Metro answers `null`
 * for a `node:` specifier on a native platform, so the bundle fails to build —
 * and `tsc -p apps/mobile` cannot see it, because the types resolve fine.
 *
 * So the guard is a SOURCE scan of the phone's runtime import graph: the
 * workspace packages `apps/mobile` imports (never a dev-only test dep), and the
 * app's own `src`, must hold no `node:` import outside the scripts nothing
 * loads. Mutation: put `import { hostname } from "node:os"` back in
 * `packages/client/src/remote-client.ts` → this test names the file and line.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const APP = join(import.meta.dir, "..");

/** The workspace packages a phone BUNDLE actually contains (from `package.json`). */
function bundledPackages(): string[] {
  const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  return Object.keys(pkg.dependencies)
    .filter((name) => name.startsWith("@tentacle/"))
    .map((name) => name.slice("@tentacle/".length));
}

/** Every `.ts`/`.tsx` under `dir`, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * `node:`/bare-builtin imports in a file. Only the ones that would break a
 * native bundle: a `node:` specifier, and the handful of bare builtins a Node
 * app writes. The reason a file may keep one is asserted per file below.
 */
const NODE_IMPORT = /(?:from|require\()\s*["'](node:[a-z/]+|fs|os|path|crypto|child_process)["']/;

/** The ONLY files allowed to reach a Node built-in, and why. A scripts-only module nothing bundles. */
const ALLOWED: readonly { readonly suffix: string; readonly why: string }[] = [
  {
    suffix: "packages/protocol/src/json-schema.ts",
    why: "the schema export script: nothing imports it, so no bundle contains it",
  },
];

function allowed(path: string): boolean {
  return ALLOWED.some((entry) => path.endsWith(entry.suffix));
}

describe("D7's phone half is actually wired (Review round 1, HIGH 2)", () => {
  // These are `.ts` files, but the property is a WIRING one across three of them
  // (the seam exists; somebody passes it; it reaches the handshake). Pinned from
  // the source, the way `icon-glass-wiring.test.ts` pins `.tsx` wiring — and
  // each assertion names the deletion that turns it red.
  const read = (...p: string[]) => readFileSync(join(APP, ...p), "utf8");

  test("the link passes this phone's label, and the handshake that carries it", () => {
    // Mutation: delete `hostLabel:` from `openComputer` → the label is never on
    // the wire; delete `clientInfo:` → `wireClientInfo` has nothing to extend.
    const connection = read("src", "connection.ts");
    expect(connection).toMatch(/hostLabel:\s*\(\)\s*=>/);
    expect(connection).toMatch(/clientInfo:\s*\{\s*name:/);
    // The `host` itself comes ONLY from `hostLabel` (the trust gate), never here.
    expect(connection).not.toMatch(/clientInfo:\s*\{[^}]*host:/);
  });

  test("the screen hands the sheet this phone's own name, and the own-turn test", () => {
    // Mutation: delete `ownHost:` → an ask's "also asked on" can name the phone
    // you are holding; delete `autoAcceptsTurn:` → the stricter no-turn rule is
    // all the sheet has (`permission-sheet.ts`, MEDIUM 4).
    const screen = read("src", "session-screen-controller.ts");
    expect(screen).toMatch(/ownHost:\s*\(\)\s*=>/);
    expect(screen).toMatch(/autoAcceptsTurn:\s*\(turnId: string\)\s*=>/);
  });

  test("the app supplies that name from the record it paired with", () => {
    // Mutation: delete `phoneName:` from `App.tsx`'s `createSessionScreen` →
    // `ownHost` is always undefined and the phone never drops its own label.
    expect(read("App.tsx")).toMatch(/phoneName:\s*\(\)\s*=>/);
  });
});

describe("no Node built-in in the phone's runtime bundle", () => {
  test("the packages the phone depends on hold none", () => {
    const hits: string[] = [];
    for (const name of bundledPackages()) {
      for (const file of sources(join(REPO, "packages", name, "src"))) {
        if (allowed(file)) continue;
        const text = readFileSync(file, "utf8");
        for (const [index, line] of text.split("\n").entries()) {
          if (NODE_IMPORT.test(line) && !/^\s*(\/?\*|\/\/)/.test(line)) {
            hits.push(`${file.slice(REPO.length + 1)}:${index + 1}: ${line.trim()}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test("the app's own sources hold none (it reads the platform through a dependency)", () => {
    const hits: string[] = [];
    for (const file of sources(join(APP, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        if (NODE_IMPORT.test(line) && !/^\s*(\/?\*|\/\/)/.test(line)) {
          hits.push(`${file.slice(REPO.length + 1)}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test("the allowlist names files that exist (a renamed script cannot leave a stale hole)", () => {
    for (const entry of ALLOWED) {
      expect({ suffix: entry.suffix, exists: statSync(join(REPO, entry.suffix)).isFile() }).toEqual(
        {
          suffix: entry.suffix,
          exists: true,
        },
      );
    }
  });
});
