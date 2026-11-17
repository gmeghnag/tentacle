/**
 * The H4a WIRING guard (docs/feat/mobile-hub.md H4a): the hub's Scheduled item
 * lands on Session info's wakes band.
 *
 * `SessionScreen.tsx` cannot run under `bun test` (React Native has no renderer
 * here), so — like `schedule-wiring.test.ts` for cron-tool S6 — the wiring is
 * pinned by reading the source. Each assertion names a fact no view-model test
 * can cover: that the sheet is handed the two seams the reveal needs, that the
 * reveal is ONE opening path (not a second way in), and that the menu's entry
 * really reaches it.
 *
 * The rule itself (`scheduledSection`/`revealStep`) and the rendering are covered
 * elsewhere — `session-info-reveal.test.ts` and
 * `session-info-schedules-render.test.ts`; this file only says the screen plugs
 * them in.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");

const screen = (): string => read("src", "screens", "SessionScreen.tsx");

describe("H4a: the sheet is handed the reveal's two seams", () => {
  test("`SessionScreen` passes `onSectionLayout` and `scrollRef` to the sheet", () => {
    const source = screen();
    // The measuring seam: the screen's handler, which reaches `revealStep`.
    expect(source).toContain("onSectionLayout={revealOnLayout}");
    // The scroll seam: a callback ref onto the screen's own scroller holder.
    expect(source).toContain("scrollRef={(node) => {");
    expect(source).toContain("infoScroller.current = node;");
    // …and the scroll is issued on that scroller, with the step's y.
    expect(source).toContain("infoScroller.current?.scrollTo({ y, animated: true });");
  });

  test("the reveal's arithmetic lives in `session-info.ts`, never in the screen", () => {
    // AGENTS §7: the screen holds no arithmetic; the RULE is pure. If the step
    // were inlined here, `revealStep`'s tests would stop covering it.
    const source = screen();
    expect(source).toContain("reportReveal(revealTrack.current, { id, y }");
    expect(read("src", "session-info.ts")).toContain("export function revealStep(");
    // …and the fold itself is the pure tracker's, so the batched-pass behaviour
    // is executable (reveal-report.test.ts) rather than a claim about a closure.
    expect(read("src", "reveal-report.ts")).toContain("export function reportReveal(");
  });

  test("fix M1: no `useState` for the reveal — a render value loses a batched pass", () => {
    // THE BUG. `onLayout` callbacks of one layout pass all saw the same rendered
    // `reveal`, so the last write won, the want was never spent, and the sheet
    // re-scrolled to the wakes band on every relayout above it. The reveal draws
    // nothing, so it must not be render state: the tracker is read and written
    // synchronously, outside React.
    const source = screen();
    expect(source).not.toContain("useState<RevealState>");
    expect(source).not.toMatch(/setReveal\(/);
    expect(source).toContain("useRef<RevealTrack>(trackReveal())");
    expect(source).toContain("startReveal(revealTrack.current, revealTo);");
    // The scroll is issued from the report's result, never from inside an
    // updater (StrictMode calls those twice).
    expect(source).toMatch(
      /reportReveal\(revealTrack\.current, \{ id, y \}, \(y\) => \{[\s\S]{0,120}scrollTo\(/,
    );
  });
});

describe("H4a: one opening path for Session info", () => {
  test("`openScheduled` goes through `openInfo` (never a second way in)", () => {
    const source = screen();
    // The hub's item resolves the band from the sheet's OWN view-model first…
    expect(source).toContain(
      "const openScheduled = () => openInfo(scheduledSection(info?.view ?? null));",
    );
    // …and `openInfo` is the only place that opens the sheet.
    expect(source).toMatch(/const openInfo = \(revealTo: SectionId \| null = null\) => \{/);
    expect(source).toContain("void controller.openInfo();");
    // No other call site opens the sheet: the header's ring and the menu both
    // come through `openInfo` with no reveal.
    expect(source.match(/setInfoOpen\(true\)/g)?.length).toBe(1);
  });

  test("the header's ring and the menu's Session info open it with NO reveal", () => {
    const source = screen();
    expect(source).toContain("onPress={() => openInfo()}");
    expect(source).toMatch(/if \(action\.id === "info"\) \{[\s\S]{0,220}openInfo\(\);/);
  });

  test("the menu's `scheduled` action calls `openScheduled`", () => {
    const source = screen();
    expect(source).toMatch(/if \(action\.id === "scheduled"\) \{[\s\S]{0,200}openScheduled\(\);/);
    // The menu is built with the wakes count, or the action could never appear.
    expect(source).toContain("sessionMenu(rows, state.schedules?.length ?? 0)");
  });

  test("the sheet hands back a real `onSectionLayout`, typed by the band id", () => {
    // The prop's type is what makes an unknown band id impossible to pass.
    const sheet = read("src", "screens", "SessionInfoSheet.tsx");
    expect(sheet).toContain("readonly onSectionLayout?: (id: SectionId, y: number) => void;");
    expect(sheet).toContain("onSectionLayout(section.id, event.nativeEvent.layout.y)");
    // The measure rides the section's own group, so a section is measured once.
    expect(sheet).toMatch(/onSectionLayout === undefined\s*\? \{\}\s*: \{\s*onLayout: \(event/);
  });
});
