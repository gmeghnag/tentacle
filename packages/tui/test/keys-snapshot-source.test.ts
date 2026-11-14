import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * docs/feat/app-decomposition.md S3 (Fable H3, S3 review finding 1) — the
 * snapshot's SOURCE table, made executable.
 *
 * H3's rule is per field: a field the old inline handler read from a REF at key
 * time is a getter; a field it read from the handler's RENDER CLOSURE is a value.
 * `keys/snapshot.ts` carries that table as prose, and prose does not fail when a
 * field is silently re-sourced — which is exactly what the S3 review found:
 * `replyMaxChars` was moved onto `replyMaxRef.current` while `pending`/`choices`
 * stayed render values, so one decision could mix two frames.
 *
 * So the table's VALUE half is pinned here, twice over: `snapshot.ts` must
 * declare those fields as data members (not call signatures), and `App.tsx` must
 * pass them as the render value (not a ref read).
 *
 * SCOPE. Only the value half. A getter may legitimately close over the frame
 * (`() => replyMax`) and the two are indistinguishable by a text scan, while a
 * render value is never a function — so the value half is the half a scan can
 * prove. The getter half stays pinned behaviourally by the S0b freshness nets.
 */
const SRC = join(import.meta.dir, "..", "src");
const readSrc = (name: string): string => readFileSync(join(SRC, name), "utf8");

/** The snapshot fields the doc's table marks a RENDER VALUE (pre-S3 line numbers). */
const RENDER_VALUES = [
  "panel", // 3612/3682/3698
  "paletteOpen", // 3757
  "paletteNames", // 3757
  "commandSel", // 3791
  "fieldValue", // 3705
  "sessions", // 3638
  "detachOnQuit", // 3565
  // 3519 — `maxChars: replyMax` in `stepPermissionKey`'s call, NOT `replyMaxRef`
  // (that ref is read only by `insertIntoReply`, outside the key path).
  "replyMaxChars",
] as const;

/** What a getter (or a ref read) looks like as a snapshot-literal entry. */
const GETTER_SHAPE = /^(\(\)\s*=>|function\b)|\bref\b|\.current\b/i;

/** The `KeySnapshot` interface body (`snapshot.ts`). */
function interfaceBody(text: string): string {
  const start = text.indexOf("export interface KeySnapshot {");
  if (start < 0) {
    throw new Error("KeySnapshot interface not found in keys/snapshot.ts");
  }
  const end = text.indexOf("\n}", start);
  if (end < 0) {
    throw new Error("unterminated KeySnapshot interface in keys/snapshot.ts");
  }
  return text.slice(start, end);
}

/** The object literal passed to `routeKey(` in `App.tsx`. */
function snapshotLiteral(text: string): string {
  const start = text.indexOf("routeKey(\n");
  if (start < 0) {
    throw new Error("routeKey( call not found in App.tsx");
  }
  const end = text.indexOf("\n      PURE_LAYERS,", start);
  if (end < 0) {
    throw new Error("unterminated routeKey( snapshot literal in App.tsx");
  }
  return text.slice(start, end);
}

/**
 * One property's text in the App literal, up to the end of its line — either
 * `name: value,` or the shorthand `name,` (which IS the render value).
 */
function appEntry(literal: string, name: string): string | null {
  const shorthand = new RegExp(`^\\s+${name},\\s*$`, "m");
  if (shorthand.test(literal)) {
    return `${name},`;
  }
  const m = new RegExp(`^\\s+${name}: (.+)$`, "m").exec(literal);
  const value = m?.[1];
  return value === undefined ? null : value.trim();
}

describe("S3 finding 1: a render value keeps its render source", () => {
  test("snapshot.ts declares each render value as a data member, never a call signature", () => {
    const body = interfaceBody(readSrc("keys/snapshot.ts"));
    const wrong = RENDER_VALUES.filter((name) => {
      // A getter declares `name(): T;` (or `name: () => T`); a value is `readonly name: T`.
      const call = new RegExp(`^\\s+${name}\\s*\\(`, "m");
      const readonlyData = new RegExp(`^\\s+readonly ${name}\\s*:`, "m");
      return call.test(body) || !readonlyData.test(body);
    });
    expect(wrong).toEqual([]);
  });

  test("App.tsx passes each render value straight from the frame (no getter, no ref)", () => {
    const literal = snapshotLiteral(readSrc("App.tsx"));
    const offenders: string[] = [];
    for (const name of RENDER_VALUES) {
      const entry = appEntry(literal, name);
      if (entry === null) {
        offenders.push(`${name}: MISSING from the snapshot literal`);
        continue;
      }
      // A getter/ref-read: a bare thunk (`() => …`), a `function`, or a ref read
      // (`.current`). A derived render expression — `paletteCommands.map((c) =>
      // c.name)` — is a VALUE and must pass, so a plain `=>` is not enough.
      if (GETTER_SHAPE.test(entry)) {
        offenders.push(`${name}: ${entry}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the probes are not vacuous: they find the interface, the literal and a field", () => {
    // If `interfaceBody`/`snapshotLiteral` ever stop matching (a rename, a
    // reformat), the two scans above would pass by finding nothing at all.
    const body = interfaceBody(readSrc("keys/snapshot.ts"));
    expect(body).toContain("readonly panel: OpenPanel | null;");
    expect(body).toContain("dock(): DockState;");
    const literal = snapshotLiteral(readSrc("App.tsx"));
    expect(appEntry(literal, "panel")).toBe("panel,");
    // A getter IS classified as one, so the `=>` branch above is exercised.
    expect(appEntry(literal, "dock")).toBe("() => dockRef.current,");
  });
});
