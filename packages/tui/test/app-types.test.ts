import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// S1 of docs/feat/app-decomposition.md: the exported types move OUT of App.tsx
// into `app-types.ts`, as a pure move. Two things are load-bearing and this file
// pins both: the type surface has ONE home and App.tsx/index.ts only name it, and
// that home carries no runtime code (a type-only module — a stray value export
// would mean behaviour rode along with the move).
//
// SCOPE (S1 review, finding 1): a LATER slice takes its own type with it to its
// hook's module (H4(1): "each hook slice takes its own types with it"), e.g. S8
// moving `RunQuit` next to `useQuitClear`. That is the plan, not a regression.
// So this file pins only what every later slice must keep:
//   - `AppProps`/`SessionController` have their home here (they are H4's
//     "extends lists", and every hook slice feeds them);
//   - the other four are re-exported — from WHEREVER they end up — so the test
//     boundary (28 test files, 6 `packages/cli` files) never changes;
//   - the package surface stays the same five (never grows);
//   - `app-types.ts` stays free of runtime exports.
// A later slice may move a non-resident type; it may not break these.
const SRC = join(import.meta.dir, "..", "src");
const TYPES_PATH = join(SRC, "app-types.ts");
const readSrc = (name: string): string => readFileSync(join(SRC, name), "utf8");

/** The types App.tsx used to declare and export; the plan's S1 payload. */
const MOVED = [
  "AppProps",
  "SessionController",
  "SessionDirectory",
  "NoticeFeed",
  "RunQuit",
  "SettingsNoticeLine",
] as const;

/**
 * The ones that stay in `app-types.ts` for the rest of the decomposition: H4(1)
 * makes them the module's `extends` lists, and every hook slice contributes to
 * them. The other four are "resident today, movable later" by design.
 */
const RESIDENT = ["AppProps", "SessionController"] as const;

/**
 * Of those, the ones `index.ts` (the package's public surface) already exported
 * before the move — `SettingsNoticeLine` never was one, so the public surface is
 * unchanged, not merely compatible.
 */
const PUBLIC = MOVED.filter((n) => n !== "SettingsNoticeLine");

const declares = (name: string): RegExp => new RegExp(`^export (?:interface|type) ${name}\\b`, "m");

/**
 * Every type a module re-exports, with the module it names: `{ name, from }`,
 * `from` resolved to the file the re-export points at. Two shapes count: a whole
 * `export type { … } from "x.ts"` block, and a `type X` member inside an
 * `export { … } from "x.ts"` block. The `from` half matters: a re-export only
 * keeps its importers working if the module it names actually DECLARES the type,
 * so that is the property the tests below check (not which file it lives in).
 */
const typeExports = (src: string): { name: string; from: string }[] => {
  const entries: { name: string; from: string }[] = [];
  for (const m of src.matchAll(/export (type )?\{([^{}]*)\} from "(\.[^"]*)";/g)) {
    const wholeBlockIsTypes = m[1] !== undefined;
    const from = join(SRC, m[3] ?? "");
    for (const raw of (m[2] ?? "").split(",")) {
      const member = raw.trim();
      if (wholeBlockIsTypes) {
        if (member !== "") entries.push({ name: member, from });
      } else if (member.startsWith("type ")) {
        entries.push({ name: member.slice("type ".length).trim(), from });
      }
    }
  }
  return entries;
};

/** The type is re-exported from a module that really declares it. */
const reexportResolves = (src: string, name: string): boolean => {
  const entry = typeExports(src).find((e) => e.name === name);
  if (entry === undefined || !existsSync(entry.from)) return false;
  return declares(name).test(readFileSync(entry.from, "utf8"));
};

describe("S1: the exported types live in app-types.ts", () => {
  test("app-types.ts exists and declares its resident types", () => {
    expect(existsSync(TYPES_PATH)).toBe(true);
    for (const name of RESIDENT) {
      // Declared AND exported HERE — H4(1) makes these the module's `extends`
      // lists, which later slices edit in place rather than move — and both
      // re-exporters resolve, so nothing downstream has to change.
      expect(readSrc("app-types.ts")).toMatch(declares(name));
      expect(reexportResolves(readSrc("App.tsx"), name)).toBe(true);
      expect(reexportResolves(readSrc("index.ts"), name)).toBe(true);
    }
  });

  test("App.tsx declares none of them any more, and takes them from app-types.ts", () => {
    const src = readSrc("App.tsx");
    for (const name of MOVED) {
      expect(src).not.toMatch(declares(name));
    }
    expect(src).toMatch(/from "\.\/app-types\.ts";/);
  });

  // The test boundary (28 test files render `<App …/>`, 22 of them import a type
  // from `../src/App.tsx`): App.tsx must keep exporting every moved name, so no
  // existing test changes. Type-level proof is `tsc` over test/; this pins that
  // the re-export reaches each name — from app-types.ts, or from a later
  // slice's own module once it moves one out.
  test("App.tsx still re-exports every moved name (no importer changes)", () => {
    const src = readSrc("App.tsx");
    for (const name of MOVED) {
      expect(reexportResolves(src, name)).toBe(true);
    }
  });

  test("index.ts exports each already-public moved type, and no more", () => {
    const src = readSrc("index.ts");
    const names = typeExports(src).map((e) => e.name);
    for (const name of PUBLIC) {
      // Present in the surface AND resolving to a real declaration, so a
      // re-export pointing at a module that lost the type is still red.
      expect(names).toContain(name);
      expect(reexportResolves(src, name)).toBe(true);
    }
    // The public surface did not grow either: exactly those five of the moved
    // names are public — including after a later slice moves one elsewhere.
    expect(names.filter((n) => MOVED.includes(n as (typeof MOVED)[number])).sort()).toEqual(
      [...PUBLIC].sort(),
    );
    // `App` + `AutoAcceptFeed` still come from App.tsx (they are runtime/UI, not
    // part of the move); formatting-tolerant, since only the source matters.
    expect(src).toMatch(/export \{[^}]*\bApp\b[^}]*\} from "\.\/App\.tsx";/);
  });
});

describe("S1: the move is type-only (no runtime code rode along)", () => {
  test("app-types.ts has no runtime exports", async () => {
    expect(existsSync(TYPES_PATH)).toBe(true);
    const mod: Record<string, unknown> = await import("../src/app-types.ts");
    expect(Object.keys(mod)).toEqual([]);
  });

  // Non-vacuity of the check above: the same reader DOES see a value export.
  test("the emptiness check is not vacuous (a value export would show)", async () => {
    const mod: Record<string, unknown> = await import("../src/index.ts");
    expect(Object.keys(mod)).toContain("App");
  });
});
