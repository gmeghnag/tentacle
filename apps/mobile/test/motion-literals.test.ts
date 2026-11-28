/**
 * The motion-literal guard (docs/feat/mobile-mockup-kit.md Slice 1a): every
 * animation timing in a component is a named constant from a pure module
 * (`src/motion.ts`, or a pure plan module), never a numeric literal at the call
 * site, so the mockup kit's generator reads every timing by name and a new
 * animation cannot bypass it silently. AST-based: a comment or a string that
 * says `duration: 900` does not trip it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import * as M from "../src/motion.ts";

interface Literal {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

const isNumber = (n: ts.Node | undefined): boolean =>
  n !== undefined &&
  (ts.isNumericLiteral(n) ||
    (ts.isPrefixUnaryExpression(n) && ts.isNumericLiteral(n.operand)) ||
    (ts.isParenthesizedExpression(n) && isNumber(n.expression)));

/** Every `duration:` / `delay:` / `setInterval(…, n)` given a numeric literal. */
function motionLiterals(file: string, source: string): Literal[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Literal[] = [];
  const at = (n: ts.Node, what: string): void => {
    out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && isNumber(n.initializer)) {
      const name = ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : "";
      if (name === "duration" || name === "delay") {
        at(n, `${name}: ${n.initializer.getText(sf)}`);
      }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "setInterval" &&
      isNumber(n.arguments[1])
    ) {
      at(n, `setInterval(…, ${n.arguments[1]?.getText(sf)})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const SRC = join(import.meta.dir, "../src");

function tsxUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsxUnder(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

describe("motion.ts keeps the values it hoisted", () => {
  // Written from the pre-hoist `rg` output (task doc, Execution): same values.
  test("each constant equals the literal it replaced", () => {
    expect({ ...M }).toEqual({
      STEP_BLINK_HALF_MS: 500, // docs/fix/mobile-running-row.md: the TUI blink (was STEP_SPINNER_TURN_MS 900)
      STEP_ELAPSED_TICK_MS: 1000, // ui/StepNode.tsx:57
      CLOCK_SAMPLE_MS: 250, // use-since.ts (docs/feat/mobile-ui-fluidity-s2.md)
      HEADER_DOT_HALF_MS: 700, // ui/HeaderDot.tsx:40
      HEADER_DOT_EASING: "inOut(ease)", // ui/HeaderDot.tsx:40 Easing.inOut(Easing.ease)
      HEADER_DOT_LOW_OPACITY: 0.3, // ui/HeaderDot.tsx:43
      COMPOSER_HALO_MS: 1200, // ui/Composer.tsx:98 HALO_MS
      COMPOSER_TRANSCRIBE_TURN_MS: 900, // ui/Composer.tsx:101 SPIN_MS
      FLOATING_ARC_TURN_MS: 1200, // ui/FloatingActivity.tsx:457
      ACTIVITY_SHEET_RESIZE_MS: 150, // screens/ActivitySheet.tsx:224
      ACTIVITY_CLOCK_TICK_MS: 1000, // screens/SessionScreen.tsx:711
      HUB_GLOW_IN_MS: 220, // hub-button-motion.ts:72
      HUB_GLOW_OUT_MS: 480, // hub-button-motion.ts:73
      DRAWER_MS: 220, // drawer-nav.ts:132
    });
  });
});

describe("motionLiterals", () => {
  test("a literal duration is flagged at its line", () => {
    const src = "const a = 1;\nAnimated.timing(t, {\n  toValue: 1,\n  duration: 900,\n});\n";
    expect(motionLiterals("x.tsx", src)).toEqual([
      { file: "x.tsx", line: 4, what: "duration: 900" },
    ]);
  });

  test("a literal delay and a literal setInterval period are flagged", () => {
    const src = "f({ delay: 50 });\nsetInterval(() => tick(), 1000);\n";
    expect(motionLiterals("x.tsx", src).map((l) => [l.line, l.what])).toEqual([
      [1, "delay: 50"],
      [2, "setInterval(…, 1000)"],
    ]);
  });

  test("a named constant, a comment and a string are clean", () => {
    const src = [
      "// duration: 900",
      'const s = "duration: 900";',
      "Animated.timing(t, { duration: STEP_SPINNER_TURN_MS, delay: plan.delay });",
      "setInterval(fn, HEARTBEAT_MS);",
    ].join("\n");
    expect(motionLiterals("x.tsx", src)).toEqual([]);
  });

  test("no component under src/ui or src/screens times an animation with a literal", () => {
    const found = [...tsxUnder(join(SRC, "ui")), ...tsxUnder(join(SRC, "screens"))].flatMap((f) =>
      motionLiterals(relative(SRC, f), readFileSync(f, "utf8")),
    );
    expect(found.map((l) => `${l.file}:${l.line} ${l.what}`)).toEqual([]);
  });
});
