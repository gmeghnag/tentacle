/**
 * The Tools wiring (docs/feat/mobile-hub-tools.md D6), pinned where Bun can reach
 * it. `screens/SessionScreen.tsx` and `screens/ToolsSheet.tsx` are `.tsx`
 * (unimportable from Bun: React Native's sources are Flow), so this pins the
 * structure from the source — the `hub-tap-wiring.test.ts` pattern. What the
 * sheet DRAWS is `tools-view.test.ts`'s; what the controller pulls is
 * `session-info-controller.test.ts`'s. This is only that the screen hands them
 * the right facts and calls the right methods.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** The source with its comment lines removed: prose names things the code must not do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

const SCREEN = code(read("src", "screens", "SessionScreen.tsx"));
const SHEET = code(read("src", "screens", "ToolsSheet.tsx"));
// The sheet is published by `SheetsPane` (docs/feat/mobile-ui-fluidity-s3.md).
const SHEETS = code(read("src", "screens", "session", "SheetsPane.tsx"));

/** The screen's slice from `from` to the first `to` after it (a property or a call). */
const slice = (from: string, to: string): string => {
  const at = SCREEN.indexOf(from);
  expect(at).toBeGreaterThan(-1);
  const end = SCREEN.indexOf(to, at);
  expect(end).toBeGreaterThan(at);
  return SCREEN.slice(at, end);
};

describe("the entry exists only where the sheet can be drawn", () => {
  test("`tools` is wired only when the info port exists (P6: no port, no item)", () => {
    // `state.info === null` means no controller at all: a Tools item would open
    // an empty sheet, so it is not offered rather than offered-and-broken.
    const entries = slice("const hubEntries: HubEntries = {", "};");
    expect(entries).toContain("...(info === null ? {} : { tools: openTools })");
    expect(entries).toContain("info: () => openInfo(),");
  });

  test("its figures come from the sheet's own summary, and never from nothing", () => {
    const ctx = slice("return hubContextOf({", "\n    });");
    expect(ctx).toContain("...(info === null ? {} : { tools: toolsSummary(info.tools) })");
    // ONE source: the same facts the sheet's own view is built from.
    expect(SHEETS).toContain("toolsView(info.tools, {");
  });
});

describe("the commit opens the sheet and asks the controller", () => {
  test("opening sets the sheet's flag and calls the controller's pull", () => {
    const open = slice("const openTools = () => {", "};");
    expect(open).toContain("setToolsOpen(true)");
    expect(open).toContain("void controller.openInfo()");
    // The visit's controls are about the visit: they start fresh every time.
    expect(open).toContain('setToolsSegment("mcp")');
    expect(open).toContain('setToolsQuery("")');
    expect(open).toContain("setToolsExpanded(new Set())");
  });

  test("closing clears the flag and tells the controller (F5: no stale answer)", () => {
    const close = slice("const closeTools = useCallback(() => {", "}, [controller]);");
    expect(close).toContain("setToolsOpen(false)");
    expect(close).toContain("controller.closeInfo()");
  });

  test("a dimmed commit refreshes the counts and opens nothing (D4)", () => {
    // The notice path is the dimmed one: `commitPlan` answers `notice`, and no
    // entry ran. Without the pull, a server added on the laptop afterwards would
    // keep the item dimmed forever (it never opens the sheet that would learn).
    const commit = slice("const commitHub = (id: HubActionId) => {", "\n  };");
    expect(commit).toContain('if (id === "tools" && plan.kind === "notice")');
    expect(commit).toContain("void controller.pullTools()");
    // ...and it really is the no-open path: a notice runs no entry.
    expect(commit).toContain('if (plan.kind === "more")');
    expect(commit).toContain('plan.kind === "run"');
  });

  test("the switch is the ONE write the controller already owns (no second path)", () => {
    const from = SHEETS.indexOf("<ToolsSheet");
    const sheet = SHEETS.slice(from, SHEETS.indexOf("\n        />", from));
    expect(SCREEN).toMatch(/^\s*refreshTools,$/m);
    expect(SCREEN).toMatch(/^\s*closeTools,$/m);
    expect(sheet).toContain(
      "onSwitch={(kind, name, enabled) => void controller.setCapability(kind, name, enabled)}",
    );
    expect(sheet).toContain("onRefresh={() => actions.current.refreshTools()}");
    expect(sheet).toContain("onClose={() => actions.current.closeTools()}");
  });
});

describe("an open Tools sheet hides the floating button (D6)", () => {
  test("`toolsOpen` joins `covered`", () => {
    const covered = slice("const floatShown = floatVisible({", "});");
    expect(covered).toContain("toolsOpen ||");
    // The other sheets are still there: this ADDS, it does not replace.
    expect(covered).toContain("infoOpen ||");
    expect(covered).toContain("activityOpen ||");
  });
});

describe("the sheet is render-only (AGENTS §7)", () => {
  test("its bands, words and switches come from the view-model, never from the component", () => {
    expect(SHEET).toContain("export function ToolsSheet(");
    expect(SHEET).toContain("view: ToolsView");
    // No decision of its own: no capability truth, no wording, no counting.
    expect(SHEET).not.toContain("disabledMcp");
    expect(SHEET).not.toContain("disabledSkills");
    expect(SHEET).not.toContain("capabilityKey(");
    expect(SHEET).not.toContain("modelAfterReset");
    // The switch it draws is the view-model's own (a ghost stays a ghost).
    expect(SHEET).toContain("disabled={!toggle.interactive}");
    expect(SHEET).toContain("value={toggle.on}");
  });

  test("its own controls are the caller's values (the screen owns them)", () => {
    expect(SHEET).toContain("value={view.query}");
    expect(SHEET).toContain("onPress={() => onSegment(segment.id)}");
    expect(SHEET).toContain("onToggle(band.key, !band.expanded)");
  });
});
