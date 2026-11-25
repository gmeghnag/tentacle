/**
 * docs/feat/mobile-file-view.md part 1 — the RENDER half. The decisions (the
 * language, the header's text, the one number column, the signs, the preview)
 * are pure and tested in `file-body.test.ts` / `highlight.test.ts` /
 * `syntax-color.test.ts`. This pins that the components actually draw them:
 *
 * 1. `ui/FileBody.tsx` draws ONE number, the sign column, the header ONCE, and
 *    the "tap to see all" row only while lines are held back;
 * 2. `ui/StepNode.tsx` has a `file` slot, so a file tool's body is not the
 *    plain-text path;
 * 3. `screens/transcript/TranscriptRow.tsx` hands a file tool's body to it and
 *    NOT the old `DiffView`, while `diff-<callId>` still exists (the id an e2e
 *    flow and a test address);
 * 4. no hex literal sneaks into either component (tokens only, owner rule).
 *
 * Pinned as SOURCE, not imported: these pull React Native, and a `bun:test`
 * `mock.module` of one leaks into every other file of the same run (the
 * `step-rail-render.test.ts` / `tool-rows-wiring.test.ts` pattern). Every
 * assertion was checked by mutating the component and watching it fail.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: readonly string[]): string =>
  readFileSync(join(import.meta.dir, "..", "src", ...path), "utf8");

const fileBody = () => source(["ui", "FileBody.tsx"]);
const stepNode = () => source(["ui", "StepNode.tsx"]);
const transcriptRow = () => source(["screens", "transcript", "TranscriptRow.tsx"]);

describe("FileBody draws the variant-B body", () => {
  test("ONE number column: a single gutter, from the line's own `no`", () => {
    const src = fileBody();
    // Exactly one `line.no` is drawn — never a second (old/new) gutter.
    expect(src.match(/\{line\.no/g)?.length).toBe(1);
    expect(src).toContain('line.no === null ? "" : String(line.no)');
  });

  test("a removed line's old number is drawn, and its sign, and its tint", () => {
    const src = fileBody();
    expect(src).toContain("{line.sign}");
    expect(src).toContain("palette.addBg");
    expect(src).toContain("palette.delBg");
    // The sign is drawn ALWAYS on a diff row (never colour alone: the owner is
    // colour-blind) — it is a sibling of the number, not a replacement.
    expect(src.indexOf("{line.sign}")).toBeGreaterThan(src.indexOf("line.no"));
  });

  test("the header is drawn once as a visible line", () => {
    const src = fileBody();
    // One <Text> draws it (the accessibility label repeats the words, but that
    // is not a second line on screen — the mockup's "said once" is about pixels).
    const visible = src.split("<Text").filter((part) => {
      const end = part.indexOf("</Text>");
      return end !== -1 && part.slice(0, end).includes("{view.header}");
    });
    expect(visible.length).toBe(1);
    expect(src).toContain("numberOfLines={1}");
  });

  test("the preview row says how many lines are held back, and only then", () => {
    const src = fileBody();
    expect(src).toContain("view.hidden === 0 ? null :");
    expect(src).toContain('more ${view.hidden === 1 ? "line" : "lines"} · tap to see all');
  });

  test("the diff block's testID is preserved (a flow and a test depend on it)", () => {
    expect(fileBody()).toContain("testID={`diff-${callId}`}");
  });

  test("a tap gives the full view, and is off once it IS full", () => {
    const src = fileBody();
    expect(src).toContain("onPress={onShowAll}");
    expect(src).toContain("disabled={full || onShowAll === undefined}");
  });

  test("scope colours come from the shared mapping, not a local switch", () => {
    expect(fileBody()).toContain('from "../syntax-color.ts"');
    expect(fileBody()).toContain("scopeColor(span.scope, palette)");
  });

  test("tokens only: no hex literal in the component", () => {
    expect(fileBody()).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("StepNode has a file slot, and StepBody draws it", () => {
  test("the props carry `file`", () => {
    const src = stepNode();
    expect(src).toContain("readonly file?: ReactNode;");
  });

  test("StepBody renders it before the command/output path", () => {
    const src = stepNode();
    const body = src.slice(src.indexOf("export function StepBody"));
    expect(body).toContain("{file}");
    expect(body.indexOf("{file}")).toBeLessThan(body.indexOf("{command.length === 0"));
  });
});

describe("TranscriptRow: a file tool gets the file body, not the old diff card", () => {
  test("FileBody is rendered for a file row", () => {
    const src = transcriptRow();
    expect(src).toContain('from "../../ui/FileBody.tsx"');
    expect(src).toContain("<FileBody");
    expect(src).toContain("view={view.file}");
  });

  test("the two are exclusive: the DiffView card is only for a row with no file body", () => {
    const src = transcriptRow();
    // `view.file === undefined ? { diff… } : { file… }` — one or the other. The
    // ternary's two branches are read here by what each one renders, so a
    // formatter's reflow cannot make this pass vacuously.
    const at = src.indexOf("{...(view.file === undefined");
    expect(at).toBeGreaterThan(0);
    const conditional = src.slice(at, src.indexOf("...(tool.denialReply", at));
    const [withoutFile, withFile] = conditional.split(": {");
    expect(withoutFile).toContain("<DiffView");
    expect(withoutFile).not.toContain("<FileBody");
    expect(withFile).toContain("<FileBody");
    expect(withFile).not.toContain("<DiffView");
  });

  test("the full view reaches the file body", () => {
    expect(transcriptRow()).toContain("full={step?.full ?? false}");
  });
});
