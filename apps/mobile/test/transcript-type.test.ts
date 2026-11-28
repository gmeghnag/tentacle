/**
 * docs/fix/mobile-transcript-type.md: the transcript's type after the owner's
 * decisions — prose at 500 on a dark ground (400 on light), and a step row that
 * steps back by SIZE and LIGHTNESS, never by hue alone (the owner is
 * colour-blind).
 *
 * The pure half is asserted here; the component half (a `.tsx` importing React
 * Native cannot be called from `bun test`) is pinned as SOURCE, the
 * `step-rail-render.test.ts` pattern.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { darkPalette, lightPalette, petrolPalette, typography } from "../src/theme.ts";
import { proseFontWeight, proseStyle } from "../src/transcript-type.ts";

const SRC = join(import.meta.dir, "..", "src");
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), "utf8");

describe("prose weight follows the ground (owner decision 2)", () => {
  test("dark: 500 — today's dark and the Beta petrol page alike", () => {
    expect(proseFontWeight(darkPalette)).toBe("500");
    expect(proseFontWeight(petrolPalette)).toBe("500");
  });

  test("light: 400 (dark-on-light already reads heavy)", () => {
    expect(proseFontWeight(lightPalette)).toBe("400");
  });

  test("the style keeps the prose's own size and line height (16/23, owner decision 4)", () => {
    for (const palette of [darkPalette, petrolPalette, lightPalette]) {
      const style = proseStyle(palette);
      expect(style.fontSize).toBe(16);
      expect(style.lineHeight).toBe(23);
      expect(style.fontWeight).toBe(proseFontWeight(palette));
    }
    expect(typography.transcript).toEqual({ fontSize: 16, lineHeight: 23 });
  });
});

describe("a step row steps back by size and lightness (owner decision 3)", () => {
  test("the title token is 14 pt, regular, and keeps its 20 pt line (the rail measures it)", () => {
    expect(typography.step.fontSize).toBe(14);
    expect(typography.step.lineHeight).toBe(20);
    expect(typography.step.fontWeight).toBe("400");
  });

  test("the duration has its own smaller token (13 pt), not the 12 pt caption", () => {
    expect(typography.stepMeta.fontSize).toBe(13);
    // Spelled on the token (both step tokens state their weight) — no `?? "400"`
    // fallback: a token that forgot it must fail here, not silently read regular.
    expect(typography.stepMeta.fontWeight).toBe("400");
  });

  test("the drawn name is `sec`, not `label`, and the duration is the step token", () => {
    const source = read("ui", "StepNode.tsx");
    // The name Text's colour is the secondary grey — the row is no longer prose's peer.
    const nameAt = source.indexOf("testID={labelTestID}");
    expect(nameAt).toBeGreaterThan(0);
    const nameBlock = source.slice(nameAt, nameAt + 700);
    expect(nameBlock).toContain("color: palette.sec");
    expect(nameBlock).not.toContain("color: palette.label");
    // The trailing duration is the step's own size — and so is the live clock in
    // that slot, drawn by `ClockText` (both its JS label and its native sizes).
    for (const [text, marker] of [
      [source, "{trailing}"],
      [read("ui", "ClockText.tsx"), "{label}"],
    ] as const) {
      const at = text.indexOf(marker);
      expect(at).toBeGreaterThan(0);
      expect(text.slice(at - 400, at)).toContain("typography.stepMeta");
      expect(text.slice(at - 400, at)).not.toContain("typography.caption");
    }
    expect(read("ui", "ClockText.tsx")).toContain("= typography.stepMeta;");
  });

  test("the Thought label is 14 pt `sec` — size and lightness, never a hue", () => {
    // `TranscriptRow` gives the thought `typography.step` + the italic subtitle,
    // and `StepNode` draws that subtitle `sec`.
    const row = read("screens", "transcript", "TranscriptRow.tsx");
    expect(row).toContain('name={{ tool: "Thought" }}');
    expect(row).toContain("subtitleItalic");
    const node = read("ui", "StepNode.tsx");
    const subtitleAt = node.indexOf("{subtitle}");
    expect(subtitleAt).toBeGreaterThan(0);
    const subtitleBlock = node.slice(subtitleAt - 500, subtitleAt);
    expect(subtitleBlock).toContain("typography.step");
    expect(subtitleBlock).toContain("color: palette.sec");
  });
});

describe("bold inside prose still steps up (owner decision 2)", () => {
  test("the markdown's bold is 700: heavier than 500 prose, not a lighter SemiBold", () => {
    const source = read("screens", "transcript", "Markdown.tsx");
    expect(source).toMatch(/bold: \{ fontWeight: "700" \}/);
  });

  test("paragraphs and list bodies are drawn at the palette's prose weight", () => {
    const source = read("screens", "transcript", "Markdown.tsx");
    // ONE style object, from the palette — never a weight spelled in the component.
    expect(source).toContain("proseStyle(");
    // The blocks a reader reads as prose: paragraph, heading, list bullet and the
    // chunked text — 4 sites, each through `ctx.prose`.
    const proseUses = source.match(/ctx\.prose/g) ?? [];
    expect(proseUses.length).toBeGreaterThanOrEqual(4);
    expect(source).not.toContain("styles.paragraph, { color: ctx.palette.label }");
    expect(source).not.toContain("styles.paragraph,\n              styles.bold");
    // The bullet a list item hangs off is prose too (same size, same weight).
    expect(source).toContain("style={[ctx.prose, styles.bullet, { color: ctx.palette.sec }]}");
  });
});
