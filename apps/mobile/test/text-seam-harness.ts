/**
 * The text seam's render OBSERVATIONS, for `text-seam-render.test.ts`
 * (docs/feat/mobile-theme-beta.md, Review round 1 finding 2). Run in its own
 * process: `ui/Text.tsx` imports React Native, whose sources are Flow (Bun
 * cannot load them), so the seam can only be called with `react-native`
 * stubbed — and a `mock.module` is process-global in Bun, so in a run next to
 * the sibling render tests (which stub those same specifiers and then
 * `mock.restore()`), this module fails to load, order-dependently. A child
 * process starts from a clean module registry.
 *
 * This file only OBSERVES: which element type the seam returned, the style it
 * gave it, and the value it provided to the texts nested in it. Every
 * expectation lives in the test.
 */
import { isValidElement } from "react";
import type { AppFont } from "../src/theme-beta.ts";

interface Context<T = unknown> {
  _currentValue?: T;
}

/** Per-context values fed to the stubbed `useContext` (the seam's own reads). */
const overrides = new Map<unknown, unknown>();

const RN_STUB = {
  Text: "Text",
  TextInput: "TextInput",
  StyleSheet: {
    create: (styles: unknown) => styles,
    hairlineWidth: 0.5,
    /** What a FlatStyle resolves to: the own style, then each part on top. */
    flatten: (style: unknown) => {
      const flat: Record<string, unknown> = {};
      const add = (part: unknown): void => {
        if (Array.isArray(part)) for (const one of part) add(one);
        else if (typeof part === "object" && part !== null) Object.assign(flat, part);
      };
      add(style);
      return flat;
    },
  },
};

const { mock } = await import("bun:test");
mock.module("react-native", () => RN_STUB);

/** React 19's hook dispatcher slot: only `useContext` is replaced. */
const SLOT = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";
type Dispatcher = { useContext: (context: Context) => unknown };
const internals = (await import("react")) as unknown as Record<string, { H: Dispatcher }>;
const dispatcher = internals[SLOT];
if (dispatcher === undefined) throw new Error("no React hook dispatcher slot");
dispatcher.H = {
  useContext: (context) =>
    overrides.has(context) ? overrides.get(context) : context._currentValue,
};

const seam = await import("../src/ui/Text.tsx");

/** What a caller can observe about one rendered text (plain data only: it is serialized). */
interface Observed {
  readonly type: unknown;
  /** The style the seam handed the element (the own one, or `[own, patch]`). */
  readonly style: unknown;
  /** True when the seam handed back the caller's very own style, untouched. */
  readonly untouched: boolean;
  /** True when the style is `[own, patch]`, the caller's own object first. */
  readonly ownStyleFirst: boolean;
  /** The value provided to the texts nested in it, if it provided any. */
  readonly provides: unknown;
}

/** The context object each drawn text provided on (not serializable: kept here). */
const providesOn = new Map<Observed, unknown>();

function draw(component: "Text" | "TextInput", props: Record<string, unknown>): Observed {
  const render = seam[component] as unknown as (p: Record<string, unknown>) => unknown;
  const element = render(props);
  if (!isValidElement(element)) throw new Error("the seam did not return an element");
  const { props: rendered } = element as unknown as { props: Record<string, unknown> };
  const child = rendered.children;
  const wrapped = isValidElement(child)
    ? (child as unknown as { props: Record<string, unknown> })
    : null;
  const observed: Observed = {
    type: (element as unknown as { type: unknown }).type,
    style: rendered.style,
    untouched: rendered.style === props.style,
    ownStyleFirst: Array.isArray(rendered.style) && rendered.style[0] === props.style,
    provides: wrapped === null ? undefined : wrapped.props.value,
  };
  if (wrapped !== null) providesOn.set(observed, (child as unknown as { type: unknown }).type);
  return observed;
}

/**
 * A text nested in `parent`: it reads the context the parent provided. `null`
 * when the parent provided nothing — reported, not thrown, so a seam that stops
 * providing inheritance fails an ASSERTION and not the harness.
 */
function childOf(parent: Observed, props: Record<string, unknown>): Observed | null {
  const context = providesOn.get(parent);
  if (context === undefined) return null;
  forgetInheritance();
  overrides.set(context, parent.provides);
  return draw("Text", props);
}

/**
 * Drops what a previous case provided. The seam's inheritance context is ONE
 * object for the whole app, so a case's provided value would otherwise leak
 * into the next case's parent.
 */
function forgetInheritance(): void {
  for (const context of [...overrides.keys()]) {
    if (context !== seam.AppFontContext) overrides.delete(context);
  }
}

const font = (value: AppFont) => overrides.set(seam.AppFontContext, value);

const cases: Record<string, unknown> = {};

// Font OFF (today's default): nothing added.
font(null);
const offOwn = { fontWeight: "700" };
cases.off = {
  rendered: draw("Text", { style: offOwn, children: "Title" }),
  own: offOwn,
  children: "Title",
};
const offInputOwn = { fontSize: 16 };
cases.offInput = { rendered: draw("TextInput", { style: offInputOwn }), own: offInputOwn };

// Font ON: the face, from the text's own style.
font("lato");
const onOwn = { fontSize: 16 };
cases.on = { rendered: draw("Text", { style: onOwn, children: "hello" }), own: onOwn };
cases.onWeight500 = draw("Text", { style: { fontWeight: "500" }, children: "b" });
cases.onBold = draw("Text", { style: { fontWeight: "bold" }, children: "b" });
const onInputOwn = { fontSize: 16 };
cases.onInput = { rendered: draw("TextInput", { style: onInputOwn }), own: onInputOwn };

// Nesting: what a parent hands down, and what the child nested in it became.
forgetInheritance();
const boldTitle = draw("Text", { style: { fontWeight: "700" }, children: "Title" });
cases.childOfBold = { ...boldTitle, nested: childOf(boldTitle, { children: "span" }) };

const monoOwn = { fontFamily: "ui-monospace" };
forgetInheritance();
const monoRun = draw("Text", { style: monoOwn, children: "code" });
cases.childOfMono = { ...monoRun, own: monoOwn, nested: childOf(monoRun, { children: "span" }) };

forgetInheritance();
const plainTitle = draw("Text", { style: { fontWeight: "400" }, children: "p" });
cases.childOwnWeightWins = {
  ...plainTitle,
  nested: childOf(plainTitle, { style: { fontWeight: "700" }, children: "span" }),
};

console.log(`SEAM ${JSON.stringify(cases)}`);
