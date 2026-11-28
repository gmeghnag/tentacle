/**
 * docs/fix/mobile-fluidity-e2e.md (flow 44): the navigator facts Session's render
 * and effects depend on (its run or Workflows landing on top, the routes' keys)
 * must be React state (`useNavFact`; the behaviour is `use-nav-fact.test.ts`'s).
 * Read live, a bailed-out render swallowed the sheet loop's effect and the ask's
 * sheet never came up. Pinned from the source (a `.tsx` is unimportable — the
 * `fan-jank-wiring.test.ts` pattern); the rules are `sheet-plan.ts`'s.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The source with its comment lines removed. */
const SCREEN = readFileSync(
  join(import.meta.dir, "..", "src", "screens", "SessionScreen.tsx"),
  "utf8",
)
  .split("\n")
  .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
  .join("\n");

/** The whole `const <name> = …;` statement (up to its first `;`). */
const declaration = (name: string): string =>
  new RegExp(`\\bconst ${name} = [^;]*;`).exec(SCREEN)?.[0] ?? "";

describe("the navigator facts Session's effects depend on are React state", () => {
  test.each([
    ["topRunId", "ownRunTopId"],
    ["workflowsTop", "ownWorkflowsTop"],
  ])("%s is a useNavFact selector calling %s", (name, rule) => {
    const statement = declaration(name);
    expect(statement).toMatch(new RegExp(`^const ${name} = useNavFact\\(\\s*navigation,`));
    expect(statement).toMatch(new RegExp(`\\b${rule}\\(\\s*state\\.routes\\b`));
    expect(statement).not.toContain("rootRoutes");
  });

  // `freshKey` feeds `sheetStack` (`actual`), a dependency of the sheet loop.
  test("the routes' keys come from useNavFact, never a read at render", () => {
    expect(declaration("freshKey")).toMatch(/^const freshKey = useNavFact\(\s*navigation,/);
    expect(SCREEN).not.toContain("navigation.getState()?.routes");
  });
});
