/**
 * docs/feat/app-decomposition.md S8 — the STRUCTURAL contract of the move, in the
 * S0b/S6 style: source-level properties a rendering assertion cannot see.
 *
 * The plan's payload is "`useQuitClear.ts` + App.tsx 3008–3161" (`requestQuit`,
 * `runClear`, and `requestClear` beside them), narrowed by the Fable constraints:
 *   - the DECISIONS stay pure modules' (`quitCommandStep`/`quitConfirmText`,
 *     `clearCommandStep`/`clearErrorNotice`/`clearNoopNotice`, `backgroundCount`/
 *     `backgroundNames`): they are CALLED by the hook, never re-implemented in
 *     `App.tsx` and never inlined into the hook;
 *   - the hook owns NO state and NO effect (H1: App's 20 effects stay App's, in
 *     today's order) — every ref is a port field, i.e. the App's own object;
 *   - the frozen identifiers survive (`requestQuit`, `runClear`, `requestClear`),
 *     so no use-site changed;
 *   - `RunQuit` moved WITH the hook (H4(1)) and is still reachable from
 *     `App.tsx`, `index.ts` AND `app-types.ts`, so no importer moved.
 *
 * Each assertion is red under the mutation named beside it (the slice's mutation
 * table), so none is decoration.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const readSrc = (name: string): string => readFileSync(join(SRC, name), "utf8");

const countOf = (src: string, needle: string): number => src.split(needle).length - 1;

/** The member names a module's named imports bring in from `from`. */
const importSpecs = (src: string, from: string): string[] => {
  const specs: string[] = [];
  for (const m of src.matchAll(/import \{([^{}]*)\} from "(\.\/[^"]*)";/g)) {
    if (m[2] !== from) {
      continue;
    }
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw.trim().replace(/^type /, "");
      if (name !== "") {
        specs.push(name);
      }
    }
  }
  return specs;
};

describe("S8: the quit and clear executors leave App.tsx", () => {
  // M4: a body re-inlined in App.tsx (the executor is back in the component).
  // Checked as an IMPORT plus a CALL, so the comments that name these modules
  // (which rightly stay) are not mistaken for a use.
  test("no quit/clear decision is imported or called in App.tsx any more", () => {
    const app = readSrc("App.tsx");
    for (const name of [
      "quitCommandStep",
      "clearCommandStep",
      "clearErrorNotice",
      "clearNoopNotice",
      "backgroundCount",
      "backgroundNames",
    ]) {
      expect(importSpecs(app, "./commands.ts")).not.toContain(name);
      expect(importSpecs(app, "./clear-command.ts")).not.toContain(name);
      expect(importSpecs(app, "./background-view.ts")).not.toContain(name);
      // The call, not the word: `backgroundCount(` cannot appear in a comment
      // this way, and the hook is the only caller now.
      expect(app).not.toContain(`${name}(`);
    }
    // `quitConfirmText` is NOT one of them: it formats the dialog's one line, and
    // the dialog still renders an already-made view-model (the wrapper
    // `QuitConfirm` only draws it). S10 moved that JSX — and its one formatting
    // call — verbatim into `AppView.tsx`, so the locator follows the declaration
    // (the plan's Preconditions rule: "no test changes EXCEPT a source-locator
    // that must follow the code"); the property is unchanged.
    expect(importSpecs(readSrc("AppView.tsx"), "./commands.ts")).toContain("quitConfirmText");
    expect(countOf(readSrc("AppView.tsx"), "quitConfirmText(")).toBe(1);
    // …and App no longer formats it, which is the move itself.
    expect(countOf(app, "quitConfirmText(")).toBe(0);
    // Non-vacuity: `quitConfirmText` is still exported from the module the view
    // imports it from (a dead re-export would make the two scans above pass).
    expect(readSrc("commands.ts")).toContain("export function quitConfirmText(");
  });

  test("the hook itself calls those decisions (they moved, they were not dropped)", () => {
    const hook = readSrc("useQuitClear.ts");
    for (const name of ["quitCommandStep", "clearCommandStep", "clearNoopNotice"]) {
      expect(hook).toContain(`${name}(`);
    }
    expect(importSpecs(hook, "./commands.ts")).toContain("quitCommandStep");
    expect(importSpecs(hook, "./clear-command.ts")).toContain("clearCommandStep");
    expect(importSpecs(hook, "./background-view.ts").sort()).toEqual([
      "backgroundCount",
      "backgroundNames",
    ]);
  });

  // M6: the hook called twice (two executors over one set of refs) — or not at
  // all, with the bodies left behind.
  test("exactly ONE useQuitClear call, and it destructures the three frozen identifiers", () => {
    const app = readSrc("App.tsx");
    expect(countOf(app, "useQuitClear(")).toBe(1);
    expect(app).toMatch(/const \{ requestQuit, runClear, requestClear \} = useQuitClear\(\{/);
    // The identifiers are still read at their old call sites, unchanged.
    expect(countOf(app, "requestQuit,")).toBeGreaterThanOrEqual(2);
    expect(countOf(app, "requestClear,")).toBeGreaterThanOrEqual(2);
    expect(app).toContain("runClearRef.current = runClear;");
  });

  // H1: no hook owns an effect here, so an effect's index cannot shift.
  test("App still declares its 20 effects, and the hook declares none", () => {
    expect(countOf(readSrc("App.tsx"), "\n  useEffect(")).toBe(22);
    expect(readSrc("useQuitClear.ts")).not.toContain("useEffect");
  });

  // M2 (the port trap): a callback closing over `host` would make Biome's
  // exhaustive-deps blind to every field, and a re-created ref field would break
  // the freshness rule. Destructured fields, named in deps — never the port.
  test("the hook destructures its port and its deps name fields, never `host`", () => {
    const hook = readSrc("useQuitClear.ts");
    expect(hook).toContain("} = host;");
    // `host.` may appear only in the signature/comment-free code once…
    expect(countOf(hook, "host.")).toBe(0);
    // …and no dep array may hold the whole port object.
    expect(hook).not.toMatch(/\[[^\]]*\bhost\b[^\]]*\]/);
    // Every ref the bodies read is a FIELD: a ref created here would be a second
    // latch, decoupled from the effect/`swapSession`/snapshot that also write it.
    // Three shapes count — `useRef`, `useState`, and a hand-rolled `{ current }`
    // object (which is what a "convenient" local ref becomes).
    expect(hook).not.toContain("useRef(");
    expect(hook).not.toContain("useState(");
    expect(hook).not.toMatch(/=\s*\{\s*current:/);
    const reactImport = hook.match(/import \{([^{}]*)\} from "react";/)?.[1] ?? "";
    const names = reactImport
      .split(",")
      .map((s) => s.trim().replace(/^type /, ""))
      .filter((s) => s !== "");
    expect(names).toEqual(["MutableRefObject", "useCallback"]);
  });
});

describe("S8: RunQuit moved with its hook and every importer still resolves", () => {
  // M5: the type left behind (or dropped) — `packages/cli`, `run.tsx` and 40 test
  // files name it, so the move must be a move, re-exported on both surfaces.
  test("declared in useQuitClear.ts and re-exported from App.tsx, index.ts, app-types.ts", () => {
    expect(existsSync(join(SRC, "useQuitClear.ts"))).toBe(true);
    expect(readSrc("useQuitClear.ts")).toMatch(/^export interface RunQuit\b/m);
    // Not declared a second time anywhere (one declaration, three re-exports).
    for (const file of ["App.tsx", "index.ts", "app-types.ts"]) {
      expect(readSrc(file)).not.toMatch(/^export interface RunQuit\b/m);
      expect(readSrc(file)).toContain('export type { RunQuit } from "./useQuitClear.ts";');
    }
  });

  test("the package surface and the App boundary are unchanged (no importer moves)", async () => {
    const pkg: Record<string, unknown> = await import("../src/index.ts");
    // A type export is erased at runtime: the check is that importing the
    // package still works and that `App` is reachable (the surface did not break).
    expect(Object.keys(pkg)).toContain("App");
    expect(readSrc("index.ts")).toMatch(/export \{[^}]*\bApp\b[^}]*\} from "\.\/App\.tsx";/);
  });
});
