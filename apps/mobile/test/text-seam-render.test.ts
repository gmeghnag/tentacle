/**
 * The text seam's RENDER half (docs/feat/mobile-theme-beta.md, Review round 1
 * finding 2). `theme-beta.test.ts` pins `textFont`; nothing pinned what
 * `ui/Text.tsx` DOES with it — the context it reads, the patch it appends, and
 * the inheritance it hands to nested texts. By the reviewer's mutation
 * (`inherited` → `{}`), a plain span inside a bold title drops to
 * Figtree-Regular, or a span inside a mono run gets Figtree at all, and every other
 * test stayed green.
 *
 * React Native's sources are Flow, so the seam can only run with `react-native`
 * stubbed, and a `mock.module` is process-global in Bun: run beside the sibling
 * render tests, which stub and then `mock.restore()` those same specifiers, the
 * stubbed load fails order-dependently (`Export named 'TextInput' not found`,
 * measured). So the observations are taken in a CHILD process
 * (`text-seam-harness.ts`, the `packages/exec` spawn shape) that starts from a
 * clean module registry, and every expectation is asserted here.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

interface Observed {
  readonly type: unknown;
  readonly style: unknown;
  /** The value provided to the texts nested in it, if it provided any. */
  readonly provides?: unknown;
  /** What a text nested in this one was observed to be (`null`: it provided no inheritance). */
  readonly nested?: Observed | null;
  /** The style the caller passed in, and the one the seam handed back. */
  readonly own?: unknown;
  /** True when the seam handed back the caller's very own style, untouched. */
  readonly untouched?: boolean;
  /** True when the style is `[own, patch]`, the caller's own object first. */
  readonly ownStyleFirst?: boolean;
  readonly rendered?: Observed;
  readonly children?: unknown;
}

type Cases = Record<string, Observed>;

/** Runs the harness in a clean process and returns what it observed. */
function observe(): Cases {
  const child = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "text-seam-harness.ts")],
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = child.stdout.toString();
  if (child.exitCode !== 0) {
    throw new Error(`the seam harness failed (${child.exitCode}): ${child.stderr.toString()}`);
  }
  const line = out.split("\n").find((one) => one.startsWith("SEAM "));
  if (line === undefined) throw new Error(`no SEAM line in the harness output: ${out}`);
  return JSON.parse(line.slice("SEAM ".length)) as Cases;
}

const cases = observe();

const REGULAR = { fontFamily: "Figtree-Regular", fontWeight: "400", fontStyle: "normal" };
const BOLD = { fontFamily: "Figtree-Bold", fontWeight: "700", fontStyle: "normal" };

/** The style the seam appended on top of the caller's own, if it appended one. */
function patch(rendered: Observed): unknown {
  const { style } = rendered;
  return Array.isArray(style) && style.length === 2 ? style[1] : undefined;
}

/** Every case the assertions below rely on (a harness that stops observing must fail). */
test("the harness observed every case", () => {
  expect(Object.keys(cases).sort()).toEqual(
    [
      "childOfBold",
      "childOfMono",
      "childOwnWeightWins",
      "off",
      "offInput",
      "on",
      "onBold",
      "onInput",
      "onWeight500",
    ].sort(),
  );
});

describe("with the font off the seam adds nothing", () => {
  test("a text is React Native's own component with the very props it was given", () => {
    const { rendered, own, children } = cases.off ?? {};
    if (rendered === undefined) throw new Error("no off case");
    expect(rendered.type).toBe("Text");
    expect(rendered.untouched).toBe(true);
    expect(rendered.provides).toBeUndefined();
    expect(children).toBe("Title");
  });

  test("a text input is React Native's own component, its style untouched", () => {
    const { rendered, own } = cases.offInput ?? {};
    if (rendered === undefined) throw new Error("no offInput case");
    expect(rendered.type).toBe("TextInput");
    expect(rendered.untouched).toBe(true);
  });
});

describe("with Figtree on the seam patches the face on top of the own style", () => {
  test("a plain text gets Figtree-Regular and keeps its own style first", () => {
    const { rendered, own } = cases.on ?? {};
    if (rendered === undefined) throw new Error("no on case");
    expect(rendered.type).toBe("Text");
    expect(rendered.style).toEqual([own, REGULAR]);
    expect(rendered.ownStyleFirst).toBe(true);
  });

  test("a bold text gets Figtree-Bold; a 500 is Regular, never a rounded Bold", () => {
    expect(patch(cases.onBold ?? { type: null, style: null })).toEqual(BOLD);
    expect(patch(cases.onWeight500 ?? { type: null, style: null })).toEqual(REGULAR);
  });

  test("a text input gets the face too", () => {
    const { rendered, own } = cases.onInput ?? {};
    if (rendered === undefined) throw new Error("no onInput case");
    expect(rendered.type).toBe("TextInput");
    expect(rendered.style).toEqual([own, REGULAR]);
  });
});

describe("nested texts inherit what the parent text set", () => {
  test("a bold parent hands its weight down, and a plain span stays bold", () => {
    expect(cases.childOfBold?.provides).toEqual({ weight: "700" });
    expect(patch(cases.childOfBold?.nested ?? { type: null, style: null })).toEqual(BOLD);
  });

  test("a mono run hands its family down, so a span inside it takes no face", () => {
    expect(cases.childOfMono?.provides).toEqual({ family: "ui-monospace" });
    expect(patch(cases.childOfMono?.nested ?? { type: null, style: null })).toBeUndefined();
  });

  test("a span that sets its own weight wins over the parent's", () => {
    expect(patch(cases.childOwnWeightWins?.nested ?? { type: null, style: null })).toEqual(BOLD);
  });
});
