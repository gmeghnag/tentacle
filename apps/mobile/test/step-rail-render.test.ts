/**
 * docs/fix/mobile-step-rail.md — the RENDER half. The decisions (the trailing,
 * the `exit N` suffix, the dropped duplicate command, the thought's look) are
 * pure and tested in `shell-intent-step.test.ts` / `tool-step-view.test.ts` /
 * `step-blink.test.ts`; this pins that `ui/StepNode.tsx` maps them:
 *
 * 1. no ✓ / ✗ is ever added to a step's trailing text;
 * 2. `exit N` sits at the END of the `$` line, in red, and never shrinks;
 * 3. a step with a `$` line grows a branch off the rail to it;
 * 4. Thinking = the running tool's filled accent dot; Thought = the dim ring.
 *
 * `StepNode.tsx` is pinned as SOURCE, not imported: it pulls React Native, and a
 * `bun:test` `mock.module` of it leaks into every other file of the same run
 * (the `tool-rows-wiring.test.ts` / `session-screen-follow-wiring.test.ts`
 * pattern). Each assertion below was checked by mutating the component and
 * watching it fail.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { darkPalette, lightPalette, petrolPalette } from "../src/theme.ts";

const source = (): string =>
  readFileSync(join(import.meta.dir, "..", "src", "ui", "StepNode.tsx"), "utf8");

describe("the `$` line: the command shrinks, `exit N` never does (owner decision 2)", () => {
  test("the code is a SECOND text in a row, pinned at the end, in red, never shrunken", () => {
    const src = source();
    const at = src.indexOf("{exitSuffix}");
    expect(at).toBeGreaterThan(0);
    // Drawn in the error colour, in the sub-line's mono face, on one line.
    const drawn = src.slice(at - 600, at);
    expect(drawn).toContain("palette.red");
    expect(drawn).toContain("typography.stepMono");
    expect(drawn).toContain("numberOfLines={1}");
    // The command is the flexible child, the code the fixed one: a long command
    // is cut with `…`, and `exit N` stays whole.
    expect(src).toMatch(/sublineRow: \{ flexDirection: "row", alignItems: "center", gap: \d+ \}/);
    expect(src).toMatch(/sublineText: \{ flexShrink: 1 \}/);
    expect(src).toMatch(/exitSuffix: \{ flexShrink: 0 \}/);
    // Drawn exactly when the view-model has one (never dropped, never invented).
    expect(src).toContain("{exitSuffix == null ? null : (");
  });

  test("the node adds no ✓ / ✗ of its own to the trailing text", () => {
    const src = source();
    expect(src).toMatch(/\{trailing\}/);
    expect(src).not.toMatch(/`\$\{[^}]*\} ✓/);
    expect(src).not.toMatch(/`✗ /);
  });
});

describe("the rail branches to a step's `$` line (owner decision 3)", () => {
  test("the branch is drawn in the GUTTER, on the sub-line's own condition, off the rail's x", () => {
    const src = source();
    const at = src.indexOf('testID="step-subline-branch"');
    expect(at).toBeGreaterThan(0);
    // Anchored by POSITION: the row ALSO tests `subline == null`, so a bare text
    // search would pass with the branch deleted.
    const gutter = src.indexOf("style={styles.gutter}");
    expect(gutter).toBeGreaterThan(0);
    expect(gutter).toBeLessThan(at);
    expect(src.slice(gutter, at)).toContain("subline == null ? null : (");
    // It hangs off the rail's own x and turns once, onto the sub-line. The box —
    // top, height, radius — is geometry, so it comes from `step-rail.ts` (pure,
    // `step-rail.test.ts`) and is mapped here per the type's scale.
    expect(src).toMatch(/branch: \{\s*position: "absolute",\s*left: GUTTER \/ 2 - 0\.5,/);
    expect(src).toContain("borderBottomLeftRadius: BRANCH_TURN");
    expect(src).toContain("height: branch.height");
    expect(src).toContain("const branch = branchGeometry(fontScale);");
  });
});

describe("the reasoning node: Thinking is the running dot, Thought a dim ring (decision 4)", () => {
  test("both kinds go through `thoughtLook`, the live one as the running dot", () => {
    const src = source();
    // The breathing ∴ is gone: the reasoning node reuses `BlinkingDot`, so the
    // blink clock is literally the same one the running tools use.
    expect(src).not.toContain("BreathingTherefore");
    expect(src).toContain("const look = thoughtLook(live);");
    expect(src).toMatch(/if \(look\.node === "thought-done"\) \{/);
    expect(src).toMatch(/return <BlinkingDot palette=\{palette\} still=\{still\} \/>;/);
  });

  test("the ring is the dot's box, outline only, in the `thought` token (never the accent)", () => {
    const src = source();
    const at = src.indexOf('testID="step-thought-ring"');
    expect(at).toBeGreaterThan(0);
    const ring = src.slice(at, src.indexOf("/>", at));
    expect(ring).toContain("styles.dot");
    expect(ring).toContain("styles.thoughtRing");
    expect(ring).toContain("borderColor: palette.thought");
    expect(ring).not.toContain("palette.accent");
    // An OUTLINE of the dot's own size, in every theme (the token, not a hex).
    expect(src).toMatch(/thoughtRing: \{ borderWidth: 2 \}/);
    for (const palette of [lightPalette, darkPalette, petrolPalette]) {
      expect(palette.thought).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(palette.thought).not.toBe(palette.accent);
    }
  });

  test("the footer's own node and the compaction slot use the live look, not a glyph", () => {
    const src = source();
    expect(src).toMatch(/node="thinking"/);
    expect(src).toMatch(/node=\{running \? "thinking" : "ok"\}/);
  });
});

/**
 * docs/feat/mobile-reset-in-timeline.md Slice 3: a context reset and a
 * compaction are rail NODES, drawn as the wake glyph's box — an SF Symbol in
 * `sec` on the page, so it masks the rail like a dot. Pinned as SOURCE (the
 * file imports React Native); the mapping itself is `context-row-render.test.ts`.
 */
describe("a context step's node: a glyph in the wake's box, `sec` on the page", () => {
  test("the two kinds are `NodeKind`s, drawn through the ONE icon seam", () => {
    const src = source();
    expect(src).toMatch(
      /export type NodeKind = StepDot \| "thought" \| "thinking" \| "wake" \| "reset" \| "compact";/,
    );
    const at = src.indexOf('case "reset":');
    expect(at).toBeGreaterThan(0);
    const drawn = src.slice(at, src.indexOf("default:", at));
    // One `case "compact"` arm with it, and the plan's two SF Symbols.
    expect(drawn).toContain('case "compact":');
    expect(drawn).toContain('"arrow.counterclockwise"');
    expect(drawn).toContain('"arrow.down.right.and.arrow.up.left"');
    // Light, the glyph box's size, `sec` on the page — the wake's own look.
    expect(drawn).toContain('weight="light"');
    expect(drawn).toContain("size={CONTEXT_NODE_SIZE}");
    expect(drawn).toContain("color={palette.sec}");
    expect(drawn).toContain("backgroundColor: palette.page");
    // The symbol is decorative: the NAME carries the fact.
    expect(src).toMatch(/contextNode: \{\s*width: CONTEXT_NODE_SIZE,\s*height: CONTEXT_NODE_SIZE,/);
  });
});
