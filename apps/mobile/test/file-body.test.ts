/**
 * A file tool's body (docs/feat/mobile-file-view.md, part 1). Every case here is
 * one of the owner's decisions, so a regression shows up as a decided fact going
 * away rather than as "the render looks different":
 *
 * - the language comes from the EXTENSION (and `.html` really is coloured,
 *   `<script>`/`<style>` included — the sub-language wrapper fix in `highlight.ts`);
 * - an unknown extension is plain, and so is a file over the cap;
 * - ONE number column: the new number, or the old one for a removed line;
 * - the header says the range ONCE and never repeats the tool's raw result line;
 * - the body is a preview until `full`.
 */
import { describe, expect, test } from "bun:test";
import type { ToolDiffDetail } from "@tentacle/core";
import {
  FILE_BODY_PREVIEW,
  FILE_HIGHLIGHT_CAP,
  fileBodyView,
  languageLabel,
  pathExtension,
} from "../src/file-body.ts";

/** A diff detail as `fs_edit`/`fs_multi_edit` build it (`builtins.ts` `makeDiff`). */
function detail(path: string, patch: string): ToolDiffDetail {
  const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removed = patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  return { kind: "diff", path, patch, added, removed };
}

const READ_ARGS = JSON.stringify({ path: "src/app.ts" });
const readRow = (output: string, path = "src/app.ts") => ({
  name: "fs_read",
  args: JSON.stringify({ path }),
  status: "ok",
  output,
});

const EDIT_PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -40,3 +40,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export {};",
].join("\n");

describe("the language comes from the extension only", () => {
  test("a known extension is coloured and named", () => {
    const view = fileBodyView(readRow("const x = 1;", "src/a.ts"), false);
    expect(view?.language).toBe("typescript");
    expect(view?.header).toContain("TypeScript");
    expect(view?.lines[0]?.spans.map((s) => s.scope)).toContain("keyword");
  });

  test("an unknown extension is plain, and its header names no language", () => {
    const view = fileBodyView(readRow("const x = 1;", "notes.what"), false);
    expect(view?.language).toBe(null);
    expect(view?.header).not.toContain("·");
    expect(view?.lines[0]?.spans.map((s) => s.scope)).toEqual(["plain"]);
  });

  test("no extension at all is plain", () => {
    expect(fileBodyView(readRow("const x = 1;", "Makefile"), false)?.language).toBe(null);
  });

  test("no auto-detection: javascript inside a .txt is NOT highlighted", () => {
    // The rule the owner fixed: only the extension decides. A recognisable
    // snippet in an unknown-typed file stays grey.
    const view = fileBodyView(
      readRow('import x from "y";\nconst a = () => 1;', "notes.txt"),
      false,
    );
    expect(view?.language).toBe(null);
  });

  test(".html IS coloured, script and style included", () => {
    const html = [
      "<style>",
      ":root { color: red; }",
      "</style>",
      "<script>",
      "const A = 1;",
      "</script>",
    ].join("\n");
    const view = fileBodyView(readRow(html, "page.html"), false);
    expect(view?.language).toBe("xml");
    expect(view?.header).toContain("HTML");
    const scopes = view?.lines.flatMap((line) => line.spans.map((s) => s.scope)) ?? [];
    // css's own scopes and javascript's own scopes: the sub-languages ran.
    expect(scopes).toContain("attribute");
    expect(scopes).toContain("keyword");
    // …and no wrapper markup leaked into the text.
    const text = view?.lines.map((line) => line.spans.map((s) => s.text).join("")).join("\n");
    expect(text).toBe(html);
  });
});

describe("the cap: a very big file stays plain", () => {
  test("over the line cap", () => {
    const big = Array.from(
      { length: FILE_HIGHLIGHT_CAP.lines + 1 },
      (_, at) => `const a${at} = 1;`,
    );
    const view = fileBodyView(readRow(big.join("\n"), "big.ts"), true);
    expect(view?.language).toBe(null);
  });

  test("over the byte cap", () => {
    const huge = "x".repeat(FILE_HIGHLIGHT_CAP.bytes + 1);
    expect(fileBodyView(readRow(huge, "big.ts"), true)?.language).toBe(null);
  });

  test("just under it is still coloured", () => {
    const fine = Array.from({ length: 10 }, (_, at) => `const a${at} = 1;`);
    expect(fileBodyView(readRow(fine.join("\n"), "fine.ts"), false)?.language).toBe("typescript");
  });
});

describe("a read's header and numbers", () => {
  test("the raw `[path lines A-B of N]` line becomes `lines A–B of N · LANG`", () => {
    const output = "[src/app.ts lines 1-2 of 521]\nconst a = 1;\nconst b = 2;";
    const view = fileBodyView(readRow(output), false);
    expect(view?.header).toBe("lines 1–2 of 521 · TypeScript");
    // The raw header is NOT a line of the body, and nothing says it again.
    const text = view?.lines.map((line) => line.spans.map((s) => s.text).join("")).join("\n");
    expect(text).toBe("const a = 1;\nconst b = 2;");
  });

  test("a ranged read numbers its lines from where it starts, not from 1", () => {
    const output = "[src/app.ts lines 100-101 of 521]\nconst a = 1;\nconst b = 2;";
    const view = fileBodyView(readRow(output), false);
    expect(view?.lines.map((line) => line.no)).toEqual([100, 101]);
  });

  test("a whole-file read has no header from the tool: `N lines`", () => {
    const view = fileBodyView(readRow("a\nb\nc", "src/app.ts"), false);
    expect(view?.header).toBe("3 lines · TypeScript");
    expect(view?.lines.map((line) => line.no)).toEqual([1, 2, 3]);
  });

  test("a read line has no sign column", () => {
    expect(fileBodyView(readRow("a", "src/app.ts"), false)?.lines[0]?.sign).toBe(null);
  });
});

describe("an edit's header, one number column and its signs", () => {
  const row = {
    name: "fs_edit",
    args: EDIT_ARGS(),
    status: "ok" as const,
    output: "edited src/app.ts (+2 -1)",
    diff: detail("src/app.ts", EDIT_PATCH),
  };
  function EDIT_ARGS(): string {
    return JSON.stringify({ path: "src/app.ts" });
  }

  test("the `@@ … @@` heading is replaced by `lines A–B · LANG`", () => {
    const view = fileBodyView(row, false);
    expect(view?.header).toBe("lines 40–43 · TypeScript");
    const text = view?.lines.map((line) => line.spans.map((s) => s.text).join("")).join("\n");
    expect(text).not.toContain("@@");
    // The tool's own result line is gone from the body too.
    expect(text).not.toContain("edited ");
    expect(text).not.toContain("+2 -1");
  });

  test("ONE number column: the new number; a removed line keeps its old one", () => {
    const view = fileBodyView(row, false);
    // The new file's numbers, with the removed line keeping the OLD one it had:
    // 40 (ctx) · 41 (the removal — it is where old 41 was) · 41/42 (the two
    // additions that take new 41 and 42) · 43 (ctx).
    expect(view?.lines.map((line) => line.no)).toEqual([40, 41, 41, 42, 43]);
    // `const b = 2;` was removed, so it carries the OLD number (41) — not the
    // new one, which the line after it takes.
    const texts = view?.lines.map((line) => line.spans.map((s) => s.text).join("")) ?? [];
    const removedAt = texts.indexOf("const b = 2;");
    expect(view?.lines[removedAt]?.no).toBe(41);
    expect(view?.lines[removedAt]?.sign).toBe("−");
  });

  test("add/del signs are drawn, never colour alone", () => {
    const view = fileBodyView(row, false);
    const signs = view?.lines.map((line) => line.sign);
    expect(signs).toEqual([null, "−", "+", "+", null]);
    expect(view?.lines.map((line) => line.kind)).toEqual(["ctx", "del", "add", "add", "ctx"]);
  });

  test("a diff line is coloured by the file's extension", () => {
    const view = fileBodyView(row, false);
    const added = view?.lines[2];
    expect(added?.spans.map((s) => s.scope)).toContain("keyword");
  });
});

describe("a MultiEdit says its path ONCE (never four times)", () => {
  const row = {
    name: "fs_multi_edit",
    args: JSON.stringify({ path: "polpetto.html", edits: [{}, {}] }),
    status: "ok" as const,
    output: "edited polpetto.html with 2 edits (+78 -30)",
    diff: detail("polpetto.html", EDIT_PATCH),
  };

  test("no repeated path and no repeated counts in the body", () => {
    const view = fileBodyView(row, false);
    const all = [
      view?.header ?? "",
      ...(view?.lines ?? []).map((line) => line.spans.map((s) => s.text).join("")),
    ];
    const text = all.join("\n");
    expect(text).not.toContain("polpetto.html");
    expect(text).not.toContain("with 2 edits");
    expect(text).not.toContain("+78 -30");
  });

  test("an .html edit is coloured (JavaScript in HTML)", () => {
    expect(fileBodyView(row, false)?.language).toBe("xml");
  });
});

describe("a write", () => {
  const createdPatch = [
    "--- a/note/palloncino.json",
    "+++ b/note/palloncino.json",
    "@@ -0,0 +1,2 @@",
    '+  "scene": "palloncino",',
    '+  "durata": 6.6',
  ].join("\n");

  test("a created file says `LANG · new file`", () => {
    const view = fileBodyView(
      {
        name: "fs_write",
        args: JSON.stringify({ path: "note/palloncino.json" }),
        status: "ok",
        output: "wrote 42 bytes to note/palloncino.json (+2 -0)",
        diff: detail("note/palloncino.json", createdPatch),
      },
      false,
    );
    expect(view?.header).toBe("JSON · new file");
    expect(view?.lines.every((line) => line.kind === "add")).toBe(true);
  });

  test("a write OVER an existing file is a real diff: it says its range", () => {
    const view = fileBodyView(
      {
        name: "fs_write",
        args: JSON.stringify({ path: "src/app.ts" }),
        status: "ok",
        output: "wrote 42 bytes to src/app.ts (+2 -1)",
        diff: detail("src/app.ts", EDIT_PATCH),
      },
      false,
    );
    expect(view?.header).toBe("lines 40–43 · TypeScript");
  });
});

describe("the preview, and the show-all seam", () => {
  const many = Array.from({ length: FILE_BODY_PREVIEW + 5 }, (_, at) => `line ${at}`).join("\n");

  test("collapsed: the first lines, and the rest counted", () => {
    const view = fileBodyView(readRow(many, "a.txt"), false);
    expect(view?.lines.length).toBe(FILE_BODY_PREVIEW);
    expect(view?.hidden).toBe(5);
  });

  test("full: everything, nothing hidden", () => {
    const view = fileBodyView(readRow(many, "a.txt"), true);
    expect(view?.lines.length).toBe(FILE_BODY_PREVIEW + 5);
    expect(view?.hidden).toBe(0);
  });

  test("a short body hides nothing", () => {
    expect(fileBodyView(readRow("a\nb", "a.txt"), false)?.hidden).toBe(0);
  });
});

describe("when there is no body at all", () => {
  test("a tool that is not a file tool", () => {
    expect(fileBodyView({ name: "shell", args: "{}", status: "ok", output: "hi" }, false)).toBe(
      null,
    );
  });

  test("a FAILED file tool keeps today's plain output (a failure must stay legible)", () => {
    // The row carries a REAL diff and output, so the status is the only thing
    // that can keep the body from being drawn (mutation-checked: dropping the
    // `status !== "ok"` guard makes this fail).
    expect(
      fileBodyView(
        {
          name: "fs_multi_edit",
          args: '{"path":"a.ts"}',
          status: "error",
          output: "edit #2 of 2 failed: old_string not found in a.ts (no changes written)",
          diff: detail("a.ts", EDIT_PATCH),
        },
        false,
      ),
    ).toBe(null);
  });

  test("a denied file tool", () => {
    expect(
      fileBodyView(
        {
          name: "fs_write",
          args: '{"path":"a.ts"}',
          status: "denied",
          output: "denied by the user",
          diff: detail("a.ts", EDIT_PATCH),
        },
        false,
      ),
    ).toBe(null);
  });

  test("a read with no content yet", () => {
    expect(fileBodyView({ name: "fs_read", args: READ_ARGS, status: "ok" }, false)).toBe(null);
  });

  test("an edit whose row carries no diff", () => {
    expect(
      fileBodyView({ name: "fs_edit", args: '{"path":"a.ts"}', status: "ok", output: "" }, false),
    ).toBe(null);
  });

  test("non-JSON args: no path, so a plain body with no language", () => {
    const view = fileBodyView(
      { name: "fs_read", args: "not json", status: "ok", output: "a" },
      false,
    );
    expect(view?.language).toBe(null);
    expect(view?.header).toBe("1 line");
  });

  test("empty content is no body", () => {
    expect(fileBodyView(readRow("", "a.ts"), false)).toBe(null);
  });
});

describe("helpers", () => {
  test("pathExtension ignores a :start:end range and lower-cases", () => {
    expect(pathExtension("src/A.TS")).toBe("ts");
    expect(pathExtension("src/a.ts:10:20")).toBe("ts");
    expect(pathExtension("Makefile")).toBe("");
    expect(pathExtension(".gitignore")).toBe("");
  });

  test("languageLabel names html as HTML (its grammar is xml)", () => {
    expect(languageLabel("a.html")).toBe("HTML");
    expect(languageLabel("a.ts")).toBe("TypeScript");
    expect(languageLabel("a.what")).toBe("");
  });
});
