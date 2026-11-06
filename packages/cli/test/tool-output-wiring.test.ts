/** `toolOutputStore()` is wired with the tmp alternative (Q1; docs/fix/tool-output-location.md). */
import { describe, expect, test } from "bun:test";
import { toolOutputStore } from "../src/wiring.ts";

describe("toolOutputStore (the real singleton, HOME = a temp dir via the test guard)", () => {
  test("a session whose cwd IS the home (HOME = the workspace) spills outside it, not to null", async () => {
    // Mutation: drop the second argument of createToolOutputStore in wiring.ts → null.
    const home = process.env.HOME;
    expect(home).toBeDefined();
    if (home === undefined) {
      return;
    }
    const path = await toolOutputStore().forProject(home).write("q1-wiring", "t", "1", "x");
    expect(path).not.toBeNull();
    expect(path?.startsWith(`${home}/`)).toBe(false);
    await toolOutputStore().removeSession("q1-wiring");
  });
});
