/**
 * The Commands item's wiring (docs/feat/mobile-hub-commands.md C1), pinned where
 * Bun can reach it. `ui/HubFan.tsx`, `ui/FloatingActivity.tsx` and
 * `screens/SessionScreen.tsx` are `.tsx` (unimportable from Bun: React Native's
 * sources are Flow), so this pins the structure from the source — the
 * `hub-tap-wiring.test.ts` pattern. What the machine does with a dimmed tap is
 * `hub-gesture.test.ts`'s, what the pill says `hub-flash.test.ts`'s.
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

const BUTTON = code(read("src", "ui", "FloatingActivity.tsx"));
const FAN = code(read("src", "ui", "HubFan.tsx"));
const SCREEN = code(read("src", "screens", "SessionScreen.tsx"));

/** The screen's slice from `from` to the first `to` after it. */
const slice = (from: string, to: string): string => {
  const at = SCREEN.indexOf(from);
  expect(at).toBeGreaterThan(-1);
  const end = SCREEN.indexOf(to, at);
  expect(end).toBeGreaterThan(at);
  return SCREEN.slice(at, end);
};

describe("the screen wires Commands, and dims an empty Artifacts", () => {
  test("`commands` is an entry, so the item exists (P6: no callback, no item)", () => {
    const entries = slice("const hubEntries: HubEntries = {", "};");
    expect(entries).toContain("commands: openCommands,");
    expect(SCREEN).toContain("const openCommands = () => setCommandsOpen(true);");
  });

  test("`artifactsEmpty` comes from `hubContextOf`'s own `artifacts` input, never a second rule", () => {
    const ctx = slice("return hubContextOf({", "\n    });");
    // The screen hands over the LIST; `hubContextOf` is the one place that
    // decides "known and empty" (UNKNOWN never dims — the Tools D3 rule).
    expect(ctx).toContain("list: hubSlice.artifacts.list,");
    expect(ctx).not.toContain("artifactsEmpty");
    expect(SCREEN).not.toContain("artifactsEmpty");
  });

  test("a dimmed fan tap goes to `onFlash`, never to `commitHub`'s notice path", () => {
    // Through `HubPane` and the shell's actions (mobile-ui-fluidity-s3).
    expect(code(read("src", "screens", "session", "HubPane.tsx"))).toContain(
      "onFlash={(id) => actions.current.hubFlash(id)}",
    );
    expect(SCREEN).toContain("hubFlash: flashHub,");
    // The one side effect that survives: the Tools re-pull (hub-tools D4).
    const flash = slice("const flashHub = (id: HubActionId) => {", "\n  };");
    expect(flash).toContain('if (id === "tools")');
    expect(flash).toContain("void controller.pullTools()");
  });
});

describe("the fan draws the dimmed look and the in-place label", () => {
  test("a dimmed item's hairline is dashed and its glyph is faint — a shape, not a hue", () => {
    expect(FAN).toContain('borderStyle: look.dashed ? "dashed" : "solid"');
    expect(FAN).toContain("opacity: look.glyphOpacity");
  });

  test("the pill's text and its item come from `hub-flash.ts`, never inline", () => {
    expect(FAN).toContain("pillIndex(hi, flash, now)");
    expect(FAN).toContain("pillText(label, shown, flash, now)");
    // The old direct read is gone: the pill is no longer `items[hi].label`.
    expect(FAN).not.toContain("{label.label}");
  });

  test("Commands draws the bare `>_` of owner Q1 (glyph A), not an SF Symbol", () => {
    const glyph = FAN.slice(FAN.indexOf("function CommandsGlyph"), FAN.indexOf("const styles"));
    expect(glyph).toContain('d="M5 7.5l4.5 4.5L5 16.5M12 17h7"');
    expect(glyph).toContain("strokeWidth={1.5}");
    expect(FAN).toContain('item.id === "commands" ? (');
  });
});

describe("the flash's one timer lives on the button", () => {
  test("the `flash` effect arms FLASH_MS and clears it on close, a re-tap and unmount", () => {
    expect(BUTTON).toContain('import { FLASH_MS, type Flash } from "../hub-flash.ts";');
    expect(BUTTON).toContain("}, FLASH_MS);");
    // A second dimmed tap restarts the window, and a close drops it.
    expect(BUTTON.match(/disarmFlash\(\)/g)?.length).toBe(2);
    // Unmount clears the one timer too, so nothing re-renders a dead button.
    const teardown = BUTTON.slice(BUTTON.indexOf("driver.dispose();"));
    expect(teardown.slice(0, 300)).toContain("clearTimeout(flashTimer.current)");
  });

  test("the `flash` effect tells the screen once, with the fan's OWN snapshot id", () => {
    const effect = BUTTON.slice(
      BUTTON.indexOf('case "flash": {'),
      BUTTON.indexOf('case "commit":'),
    );
    // The id is the menu the fan opened with, as a commit's is — never the item
    // under the finger at the release.
    expect(effect).toContain("press.current.menu?.ids[effect.index]");
    expect(effect.match(/onFlash\(/g)?.length).toBe(1);
  });

  test("the effect carries no haptic of its own (the machine already emitted `light`)", () => {
    // `hubHaptic` answers `haptic` effects only, so a `flash` plays nothing twice.
    const effect = BUTTON.slice(
      BUTTON.indexOf('case "flash": {'),
      BUTTON.indexOf('case "commit":'),
    );
    expect(effect).not.toContain("playHaptic");
  });
});
