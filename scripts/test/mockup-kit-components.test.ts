/**
 * feat/workflow-editor Slice 0 (D9): the mockup-kit gaps the workflow-editor
 * mockup needs. Red before the kit change: none of these props exist, and the
 * «nuovo» wrapper is a box that breaks an extension's flex placement.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { literalViolations } from "../mockup-kit/kit-rules.ts";
import { ROOT } from "../mockup-kit/sources.ts";

type Built = { html: string; a11y: string };
type Builder = (props?: Record<string, unknown>) => Built;
const { K } = (await import("../../tools/mockup-kit/kit.js")) as unknown as {
  K: Record<string, Builder>;
};
const kitCss = readFileSync(join(ROOT, "tools/mockup-kit/kit.css"), "utf8");

/** The body of the first rule whose selector starts with `selector`. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
}

const pills = (html: string): string[] => html.match(/class="k-ask-b"/g) ?? [];
/** `K.permissionSheet`, typed loosely: its props are the thing under test. */
const permissionCard = (props: Record<string, unknown> = {}): string =>
  (K.permissionSheet as Builder)(props).html;

describe("permissionSheet: the options are a parameter (workflow_approve has two)", () => {
  test("the default is still the three permission pills, unchanged", () => {
    const html = (K.permissionSheet as Builder)({ detail: "rm -rf dist" }).html;
    expect(pills(html)).toHaveLength(3);
    expect(html).toContain("data-primary>Allow once");
    expect(html).toContain("Always allow");
    expect(html).toContain(">Deny<");
  });

  test("options renders exactly those pills, `primary` on the accent one", () => {
    const html = (K.permissionSheet as Builder)({
      title: "Run this workflow?",
      tool: "workflow_approve",
      options: [{ label: "Allow once", primary: true }, { label: "Deny" }],
    }).html;
    expect(pills(html)).toHaveLength(2);
    expect(html).toContain("data-primary>Allow once");
    expect(html).toContain(">Deny<");
    expect(html).not.toContain("Always allow");
    // The count is exact, not "≥ 2" by accident of the class appearing elsewhere.
    expect(html.match(/<span class="k-ask-b"/g) ?? []).toHaveLength(2);
  });

  test("a label is escaped, and a malformed options list throws instead of rendering", () => {
    const html = (K.permissionSheet as Builder)({ options: [{ label: "<x>" }] }).html;
    expect(html).toContain("&lt;x&gt;");
    expect(() => (K.permissionSheet as Builder)({ options: [{ primary: true }] })).toThrow(
      "options",
    );
    expect(() => (K.permissionSheet as Builder)({ options: "Deny" })).toThrow("options");
    // An empty list is a sheet with nothing to answer: refuse it, never draw it.
    expect(() => (K.permissionSheet as Builder)({ options: [] })).toThrow("options");
  });
});

describe("toast: an action span (Deleted gate · Undo)", () => {
  test("no action by default", () => {
    const html = (K.toast as Builder)({ text: "Copied" }).html;
    expect(html).toContain("Copied");
    expect(html).not.toContain("k-toast-action");
  });

  test("an action carries its label, escaped, inside the toast", () => {
    const built = (K.toast as Builder)({ text: "Deleted gate", action: "Undo" });
    expect(built.html).toContain("Deleted gate");
    expect(built.html).toContain('<span class="k-toast-action">Undo</span>');
    expect((K.toast as Builder)({ text: "x", action: "<b>" }).html).toContain("&lt;b&gt;");
    // `.k-toast` already `align-self: center`s; the action must not be a second row.
    expect(ruleBody(kitCss, ".k-toast {")).toContain("align-self: center");
  });
});

describe("row: a control slot and a monospace value (steppers, seg, switch, chevron)", () => {
  test("control is a raw HTML slot, not escaped text", () => {
    const html = (K.row as Builder)({
      title: "Retry",
      control: '<span class="k-stepper" data-control>− 1 +</span>',
    }).html;
    expect(html).toContain('<span class="k-stepper" data-control>− 1 +</span>');
    expect(html).toContain("Retry");
  });

  test("mono marks the value (a command, a hash); the plain row is unchanged", () => {
    expect((K.row as Builder)({ title: "bun run lint", value: "3" }).html).not.toContain(
      "data-mono",
    );
    const mono = (K.row as Builder)({ title: "Command", value: "bun run lint", mono: true }).html;
    expect(mono).toContain("data-mono>");
    expect(mono).toContain("bun run lint");
    // The mono look comes from a token, never a hand-picked size.
    expect(ruleBody(kitCss, ".k-row-value[data-mono]")).toContain("var(--t-mono-size)");
    expect(literalViolations(kitCss)).toEqual([]);
  });

  test("band passes a row's control through", () => {
    const html = (K.band as Builder)({
      rows: [{ title: "Timeout", control: '<span class="k-seg">5 s</span>' }],
    }).html;
    expect(html).toContain('<span class="k-seg">5 s</span>');
  });
});

describe("bigButton: the filled 50 pt action (Save 5 files)", () => {
  test("the builder exists, is exported on K, and uses the size token", () => {
    expect(typeof K.bigButton).toBe("function");
    const html = (K.bigButton as Builder)({ text: "Save 5 files" }).html;
    expect(html).toContain("k-big-button");
    expect(html).toContain("Save 5 files");
    expect(ruleBody(kitCss, ".k-big-button {")).toContain("min-height: var(--s-big-button)");
  });

  test("tone reaches the markup; a disabled button says so", () => {
    const html = (K.bigButton as Builder)({ text: "Save", tone: "warn" }).html;
    expect(html).toContain('data-tone="warn"');
    const off = (K.bigButton as Builder)({ text: "Save", disabled: true }).html;
    expect(off).toContain("data-disabled");
    expect(off).toContain('aria-disabled="true"');
  });
});

describe("askCard: THE ask, drawn for each origin (S9)", () => {
  const ORIGINS: readonly { kind: string; lead: string; rest?: string }[] = [
    { kind: "main", lead: "Main agent" },
    { kind: "subagent", lead: "Sub-agent explore", rest: "Find where the feeds are parsed" },
    { kind: "workflow", lead: "rassegna-stampa", rest: "step generate · 2 of 5" },
  ];
  const origin = (kind: string): Record<string, unknown> =>
    ORIGINS.find((o) => o.kind === kind) ?? { kind: "main", lead: "Main agent" };
  const card = (p: Record<string, unknown>): string => (K.askCard as Builder)(p).html;

  test("the glyph comes from the origin KIND, never the words (a pod's text)", () => {
    // A workflow named «Main agent» must still draw the curve path, not Polpetto.
    const forged = card({
      origin: { kind: "workflow", lead: "Main agent", rest: "step generate" },
      command: "ls",
    });
    expect(forged).toContain('data-glyph="workflow"');
    expect(forged).not.toContain('data-glyph="main"');
    // The main agent IS Polpetto's silhouette, the only non-SF glyph.
    expect(card({ origin: origin("main"), command: "ls" })).toContain('class="k-ask-p"');
    expect(card({ origin: origin("workflow"), command: "ls" })).not.toContain('class="k-ask-p"');
  });

  test("the three origins each draw their own row", () => {
    for (const o of ORIGINS) {
      const html = card({ origin: o, command: "ls" });
      expect(html).toContain(`data-glyph="${o.kind}"`);
      expect(html).toContain(`<b>${o.lead}</b>`);
      if (o.rest !== undefined) expect(html).toContain(o.rest);
    }
    // An unknown/absent kind falls back to the main agent: never a blank row.
    expect(card({ origin: { kind: "nope" }, command: "ls" })).toContain('data-glyph="main"');
  });

  test("the origin words are escaped; the age is a column of its own", () => {
    const html = card({
      origin: { kind: "workflow", lead: "<img src=x>", rest: "step <b>", age: "12s" },
      command: "ls",
    });
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain('<span class="k-ask-age">12s</span>');
    expect(card({ origin: origin("main"), command: "ls" })).not.toContain("k-ask-age");
  });

  test("the command is 4 rows collapsed, with `+N lines · Show all`; short: no footer", () => {
    const long = card({ origin: origin("main"), command: "a\nb\nc\nd\ne\nf" });
    expect(long.match(/class="k-ask-ln"/g) ?? []).toHaveLength(4);
    expect(long).toContain("+2 lines");
    expect(long).toContain("Show all");
    const short = card({ origin: origin("main"), command: "a\nb" });
    expect(short.match(/class="k-ask-ln"/g) ?? []).toHaveLength(2);
    expect(short).not.toContain("k-ask-ft");
    // Expanded draws every line and `Show less`.
    const open = card({ origin: origin("main"), command: "a\nb\nc\nd\ne\nf", expanded: true });
    expect(open.match(/class="k-ask-ln"/g) ?? []).toHaveLength(6);
    expect(open).toContain("Show less");
    // An empty line still draws (a blank row shifts nothing: AGENTS §6 Ink gotcha, same for CSS rows).
    expect(card({ origin: origin("main"), command: "a\n\nb" })).toContain(
      '<div class="k-ask-ln"> </div>',
    );
  });

  test("Deny is never the primary look, and the order is Deny · Allow once", () => {
    const html = card({ origin: origin("main"), command: "ls" });
    expect(html).toContain('<span class="k-ask-b">Deny</span>');
    expect(html).toContain('<span class="k-ask-b" data-primary>Allow once</span>');
    expect(html.indexOf(">Deny<")).toBeLessThan(html.indexOf(">Allow once<"));
    expect(html).not.toMatch(/k-ask-b" data-tone="warn"/);
  });

  test("`…` only when there IS a rare option (a workflow_approve has none)", () => {
    const full = card({
      origin: origin("main"),
      command: "ls",
      menu: ["Always allow", "Deny with a reply…"],
    });
    expect(full).toContain('class="k-ask-mo"');
    expect(full).toContain("Always allow");
    expect(full).toContain("Deny with a reply…");
    const bare = card({ origin: origin("workflow"), command: "ls" });
    expect(bare).not.toContain('class="k-ask-mo"');
    // The row still holds its shape without the `…` (a spacer, so buttons stay right).
    expect(bare).toContain('<span class="k-ask-sp"></span>');
  });

  test("the other-ask line and the arming state are drawn when present", () => {
    const html = card({
      origin: origin("main"),
      command: "ls",
      alsoAsked: "Also asked on mac",
      armed: false,
    });
    expect(html).toContain("Also asked on mac");
    expect(html).toContain("k-ask-arming");
    expect(card({ origin: origin("main"), command: "ls" })).not.toContain("k-ask-arming");
  });

  test("the actions sit OUTSIDE the scrollable command box (reachable at any detent)", () => {
    const html = card({ origin: origin("main"), command: "a\nb\nc\nd\ne", expanded: true });
    const box = html.indexOf('class="k-ask-c"');
    const actions = html.indexOf('class="k-ask-a"');
    expect(box).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(box);
    // The box closes before the actions open: a sibling, not a child.
    expect(html.slice(box, actions)).toContain("</div>");
    expect(ruleBody(kitCss, ".k-ask-a {")).toContain("flex: none");
    expect(ruleBody(kitCss, ".k-ask-c[data-x] .bd {")).toContain("overflow: auto");
  });
});

describe("askSlim: the peek row / banner (S9)", () => {
  const slim = (p: Record<string, unknown>): string => (K.askSlim as Builder)(p).html;

  test("hand.raised, the title, the origin short and the action word", () => {
    const html = slim({
      title: "Run a shell command",
      origin: { short: "rassegna-stampa · generate" },
    });
    expect(html).toContain('class="k-ask-slim"');
    expect(html).toContain('<svg class="k-sym"');
    expect(html).toContain("Run a shell command");
    expect(html).toContain("rassegna-stampa · generate");
    expect(html).toContain("Review");
    expect(html).toContain('class="go"');
    expect(html).toMatch(/class="go">Review <svg class="k-sym"/);
  });

  test("never draws an answer (the command is not seen from here)", () => {
    const html = slim({ title: "t", origin: { short: "s" } });
    expect(html).not.toContain("Allow once");
    expect(html).not.toContain("Deny");
  });

  test("`go` is the caller's word (`Open` for the return banner), text escaped", () => {
    expect(slim({ title: "t", origin: { short: "s" }, go: "Open" })).toContain("Open");
    expect(slim({ title: "<x>", origin: { short: "s" } })).toContain("&lt;x&gt;");
  });
});

describe("askSheet: the ask inside the formSheet frame (S9)", () => {
  const sheet = (p: Record<string, unknown>): string => (K.askSheet as Builder)(p).html;

  test("the peek detent dims nothing (the screen behind stays usable)", () => {
    const peek = sheet({ detent: "peek", inner: "<div>slim</div>" });
    expect(peek).toContain('data-detent="peek"');
    expect(peek).not.toContain("data-dim");
    // Every higher detent is dimmed, as UIKit draws it.
    expect(sheet({ detent: "large", inner: "<div>x</div>" })).toContain("data-dim");
    expect(sheet({ detent: "ask", inner: "<div>x</div>" })).toContain("data-dim");
  });

  test("it is the sheet frame: a grabber and the caller's content, nothing else", () => {
    const html = sheet({ detent: "large", inner: '<div id="mine">x</div>' });
    expect(html).toContain('class="k-grabber"');
    expect(html).toContain('<div id="mine">x</div>');
    expect(html).toContain('class="k-ask-sheet"');
    // `inner` is a raw HTML slot, so an askCard can be composed into it.
    expect(sheet({ detent: "ask", inner: "<b>raw</b>" })).toContain("<b>raw</b>");
  });

  test("an unknown detent throws instead of drawing a wrong frame", () => {
    expect(() => sheet({ detent: "huge", inner: "" })).toThrow("detent");
  });
});

describe("permissionSheet: the ask card inside the kit's sheet (D7, realigned)", () => {
  test("it draws the ask card, not the old head/detail/pill stack", () => {
    const html = permissionCard();
    expect(html).toContain('class="k-ask"');
    expect(html).toContain('class="k-ask-a"');
    expect(html).not.toContain('class="k-perm-detail"');
    expect(html).not.toContain('class="k-perm-head"');
  });

  test("the options stay a parameter, on the card's own action row", () => {
    const html = permissionCard({
      tool: "workflow_approve",
      options: [{ label: "Allow once", primary: true }, { label: "Deny" }],
    });
    expect(pills(html)).toHaveLength(2);
    // The rare option is NOT one of them: a workflow_approve offers two answers.
    expect(html).not.toContain("Always allow");
    expect(html).not.toContain("k-perm-options");
    // A malformed list still throws: unchanged, the S9 realignment must not lose it.
    expect(() => permissionCard({ options: [] })).toThrow("options");
  });

  test("the origin reaches it by kind (the kit's own default: the main agent)", () => {
    expect(permissionCard()).toContain('data-glyph="main"');
    const wf = permissionCard({
      origin: { kind: "workflow", lead: "rassegna-stampa", rest: "step generate" },
    });
    expect(wf).toContain('data-glyph="workflow"');
    expect(wf).toContain("rassegna-stampa");
  });
});

describe("extend: display:contents, so an extension keeps its flex placement", () => {
  test("the base wrapper paints no box", () => {
    const body = ruleBody(kitCss, ".k-nuovo {");
    expect(body).toContain("display: contents");
    expect(body).not.toContain("outline");
    expect(body).not.toContain("position");
  });

  test("«nuovo» is drawn on the extension's own children, not on the contents box", () => {
    expect(kitCss).toContain("[data-nuovo-mode] .k-nuovo > *");
    expect(ruleBody(kitCss, "[data-nuovo-mode] .k-nuovo > * {")).toContain("outline");
    expect(kitCss).toContain("[data-nuovo-mode] .k-nuovo > *::after");
    // `attr(data-nuovo)` would read the CHILD, which never carries it (the name
    // sits on the contents wrapper): the badge is the fixed word only.
    expect(ruleBody(kitCss, "[data-nuovo-mode] .k-nuovo > *::after {")).not.toContain("attr(");
  });

  test("`margin-top:auto` on the extension survives (the reason for contents)", () => {
    const html = (K.extend as unknown as (n: string, b: Builder) => Builder)("footer", () => ({
      html: '<div class="k-toast" style="margin-top:auto">x</div>',
      a11y: "x",
    }))({}).html;
    expect(html).toBe(
      '<div class="k-nuovo" data-nuovo="footer"><div class="k-toast" style="margin-top:auto">x</div></div>',
    );
  });
});
