/**
 * Flow 25's switch step (docs/feat/session-capabilities.md S5). The flow itself
 * needs a simulator; this pins its WIRING, so a renamed testID or a missing hook
 * fails here instead of silently on the next simulator run.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hookFor } from "../e2e/hooks.ts";

const root = join(import.meta.dir, "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");

describe("flow 25: the MCP switch step", () => {
  test("`session-capabilities` is a served hook, wired to the daemon's own snapshot", () => {
    expect(hookFor("/session-capabilities")).toBe("session-capabilities");
    expect(read("e2e", "run.ts")).toMatch(/capabilities: \(session\) => capabilitiesOf\(/);
  });

  test("the flow taps the switch, checks the daemon OFF, taps again, checks it ON", () => {
    const flow = read("e2e", "flows", "25-session-info.yaml");
    const at = (needle: string, from = 0): number => flow.indexOf(needle, from);
    const firstTap = at('tapOn:\n    id: "session-info-mcp-demo-switch"');
    const off = at('EXPECT: "off"', firstTap);
    const secondTap = at('tapOn:\n    id: "session-info-mcp-demo-switch"', off);
    const on = at('EXPECT: "on"', secondTap);
    expect(firstTap).toBeGreaterThan(-1);
    expect(off).toBeGreaterThan(firstTap);
    expect(secondTap).toBeGreaterThan(off);
    expect(on).toBeGreaterThan(secondTap);
    // It leaves the sheet before the rename step that follows.
    expect(at('id: "session-info-close"', on)).toBeGreaterThan(on);
  });

  test("the flow's testID is the one the sheet draws for a row's switch", () => {
    const sheet = read("src", "screens", "SessionInfoSheet.tsx");
    // The row's IDENTITY, not its title (S6 fix round 1: two rows may share a
    // title; `e2e-session-capabilities.test.ts` must pin what is really drawn).
    expect(sheet).toContain("testID={`session-info-${sectionId}-${rowIdentity(row)}-switch`}");
  });

  test("the script reads the hook and fails loudly on either wrong state", () => {
    const script = read("e2e", "flows", "25-session-capabilities.js");
    expect(script).toContain("/session-capabilities?session=${INFO_ID}");
    expect(script).toMatch(/EXPECT === "off" && !off[\s\S]*throw/);
    expect(script).toMatch(/EXPECT === "on" && off[\s\S]*throw/);
  });
});
