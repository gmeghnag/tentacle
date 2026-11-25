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

const pills = (html: string): string[] => html.match(/k-perm-pill/g) ?? [];

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
    expect(html.match(/<div class="k-perm-pill"/g) ?? []).toHaveLength(2);
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
