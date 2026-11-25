/**
 * The mascot's data is COPIED from the TUI, never imported
 * (docs/feat/mobile-mascot-scenes.md Implementation): the phone's bundle must not
 * reach `@tentacle/tui` (its `theme.ts` imports `chalk`, which Metro cannot
 * resolve, and a `node:`-style break already bit us once —
 * `node-builtins-guard.test.ts`). A copy drifts, so this file is the pin: it
 * reads the TUI's SOURCE TEXT — a runtime import is impossible here, the app is
 * React 19 and the TUI is React 18 — and compares every value.
 *
 * Both directions matter: a tone the TUI changes and the app misses (the sprite
 * would be the wrong purple on the phone), and a name/order change (the app's
 * `pickMascotPalette` index would silently mean a different palette).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MASCOT_BITMAP, MASCOT_PALETTES, PALETTE_NAMES, SPRITE_PX } from "../src/mascot-scenes.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const TUI_MASCOT = join(REPO, "packages", "tui", "src", "mascot.ts");
const TUI_THEME = join(REPO, "packages", "tui", "src", "theme.ts");

const mascotSrc = readFileSync(TUI_MASCOT, "utf8");
const themeSrc = readFileSync(TUI_THEME, "utf8");

/** The array literal of `name`, as the quoted strings it holds. */
function stringArray(src: string, name: string): string[] {
  const match = new RegExp(`${name}\\s*(?::[^=]*)?=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
  if (match === null || match[1] === undefined) {
    throw new Error(`no array literal ${name}`);
  }
  return [...match[1].matchAll(/"([^"]*)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

/** Every `{ K: "#…", E: …, … }` tone table inside `block`, in source order. */
function toneTables(src: string, block: string): { name: string; tones: Record<string, string> }[] {
  const start = src.indexOf(block);
  if (start < 0) {
    throw new Error(`no block ${block}`);
  }
  // The table's entries are the four-space-indented `name: { … },` lines (the
  // `tones: {` and `names:` members above them are two-space ones).
  const end = src.indexOf("\n  },", start);
  const body = src.slice(start, end < 0 ? src.length : end);
  return [...body.matchAll(/^ {4}(\w+):\s*\{([^}]*)\},/gm)].map((m) => {
    const tones: Record<string, string> = {};
    for (const pair of (m[2] ?? "").matchAll(/([A-Z]):\s*"([^"]+)"/g)) {
      if (pair[1] !== undefined && pair[2] !== undefined) {
        tones[pair[1]] = pair[2];
      }
    }
    return { name: m[1] ?? "", tones };
  });
}

describe("the bitmap is the owner's drawing, unchanged", () => {
  test("equals `packages/tui/src/mascot.ts` `MASCOT_BITMAP`, row for row", () => {
    expect([...MASCOT_BITMAP]).toEqual(stringArray(mascotSrc, "MASCOT_BITMAP"));
  });

  test("9 rows of 9, and the app's kept copy is the sprite's own rows", () => {
    expect(MASCOT_BITMAP.length).toBe(10);
    expect(SPRITE_PX).toBe(9);
    expect(MASCOT_BITMAP.slice(0, SPRITE_PX).every((row) => row.length === 9)).toBe(true);
  });
});

describe("the nine palettes are the TUI's, by name, order and hex", () => {
  test("the names and their order equal `MASCOT_PALETTE_NAMES`", () => {
    expect(stringArray(themeSrc, "MASCOT_PALETTE_NAMES")).toEqual([...PALETTE_NAMES]);
    expect(PALETTE_NAMES.length).toBe(9);
  });

  test("every tone of every palette equals `tokens.dark.mascot.tones`", () => {
    const tui = toneTables(themeSrc, "const MASCOT: MascotPalettes");
    expect(tui.length).toBe(9);
    const asRecord = Object.fromEntries(tui.map((t) => [t.name, t.tones]));
    expect(asRecord).toEqual({ ...MASCOT_PALETTES });
  });

  test("each palette holds exactly the five tone keys", () => {
    for (const name of PALETTE_NAMES) {
      expect({ name, keys: Object.keys(MASCOT_PALETTES[name]).sort() }).toEqual({
        name,
        keys: ["B", "E", "F", "K", "S"],
      });
    }
  });
});

describe("the phone's bundle never reaches the TUI (why the copy exists)", () => {
  test("`@tentacle/tui` is not a dependency of the app", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@tentacle/tui"]).toBeUndefined();
    expect(pkg.devDependencies["@tentacle/tui"]).toBeUndefined();
  });

  test("the module imports nothing at all", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "mascot-scenes.ts"), "utf8");
    expect(src.split("\n").filter((line) => /^import\s/.test(line))).toEqual([]);
  });
});
