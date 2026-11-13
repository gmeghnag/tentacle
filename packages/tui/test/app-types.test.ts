import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// S1 of docs/feat/app-decomposition.md: the exported types move OUT of App.tsx
// into `app-types.ts`, as a pure move. Two things are load-bearing and this file
// pins both: the module is the single source of the type surface (App.tsx and
// index.ts only name it), and it carries no runtime code (a type-only module —
// a stray value export would mean behaviour rode along with the move).
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
 * Of those, the ones `index.ts` (the package's public surface) already exported
 * before the move — `SettingsNoticeLine` never was one, so the public surface is
 * unchanged, not merely compatible.
 */
const PUBLIC = MOVED.filter((n) => n !== "SettingsNoticeLine");

const declares = (src: string, name: string): RegExp =>
  new RegExp(`^export interface ${name} \\{`, "m");

describe("S1: the exported types live in app-types.ts", () => {
  test("app-types.ts exists and declares each moved type", () => {
    expect(existsSync(TYPES_PATH)).toBe(true);
    const src = readSrc("app-types.ts");
    for (const name of MOVED) {
      expect(src).toMatch(declares(src, name));
    }
  });

  test("App.tsx declares none of them any more, and takes them from app-types.ts", () => {
    const src = readSrc("App.tsx");
    for (const name of MOVED) {
      expect(src).not.toMatch(declares(src, name));
    }
    expect(src).toMatch(/\} from "\.\/app-types\.ts";/);
  });

  // The test boundary (28 test files render `<App …/>`, 22 of them import a type
  // from `../src/App.tsx`): App.tsx must keep exporting every moved name, so no
  // existing test changes. Type-level proof is `tsc` over test/; this pins that
  // the re-export statement is actually there.
  test("App.tsx still re-exports every moved name (no importer changes)", () => {
    const src = readSrc("App.tsx");
    const reexport = /export type \{([^{}]*)\} from "\.\/app-types\.ts";/m.exec(src);
    if (!reexport?.[1]) {
      throw new Error('App.tsx has no `export type { … } from "./app-types.ts";`');
    }
    const names = reexport[1].split(",").map((n) => n.trim());
    for (const name of MOVED) {
      expect(names).toContain(name);
    }
  });

  test("index.ts exports each already-public moved type from app-types.ts", () => {
    const src = readSrc("index.ts");
    const block = /export (?:type )?\{([^{}]*)\} from "\.\/app-types\.ts";/m.exec(src);
    if (!block?.[1]) {
      throw new Error('index.ts has no `export { … } from "./app-types.ts";`');
    }
    const names = block[1].split(",").map((n) => n.trim().replace(/^type\s+/, ""));
    for (const name of PUBLIC) {
      expect(names).toContain(name);
    }
    // The public surface did not grow either: exactly those five (order-free).
    expect(names.filter((n) => MOVED.includes(n as (typeof MOVED)[number])).sort()).toEqual(
      [...PUBLIC].sort(),
    );
    expect(src).toMatch(/export \{ App, type AutoAcceptFeed \} from "\.\/App\.tsx";/);
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
