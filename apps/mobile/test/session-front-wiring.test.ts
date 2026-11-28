/**
 * docs/fix/mobile-fluidity-e2e.md (flow 44): which screen of this session is on
 * top (its run, its Workflows landing) must come from a navigator SUBSCRIPTION.
 * Read at render, it went stale once Session followed only its state slices:
 * pushing the run over the landing re-rendered nothing, and the ask's sheet never
 * came up. Pinned from the source (a `.tsx` is unimportable from Bun — the
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

/** The whole `const <name> = …;` statement. */
const declaration = (name: string): string =>
  new RegExp(`\\bconst ${name} = [^;]*;`).exec(SCREEN)?.[0] ?? "";

describe("what is on top of Session comes from the navigator's own subscription", () => {
  test.each([
    ["topRunId", "ownRunTopId"],
    ["workflowsTop", "ownWorkflowsTop"],
  ])("%s is a useNavigationState selector calling %s", (name, rule) => {
    const statement = declaration(name);
    expect(statement).toMatch(new RegExp(`^const ${name} = useNavigationState\\(`));
    expect(statement).toMatch(new RegExp(`\\b${rule}\\(\\s*state\\.routes\\b`));
    expect(statement).not.toContain("rootRoutes");
  });
});
