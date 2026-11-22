import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import stringWidth from "string-width";
import { transcriptRows } from "../src/render-lines.ts";
import type { ToolItem } from "../src/state.ts";
import { theme } from "../src/theme.ts";

// docs/feat/shell-intent-line.md §3 + docs/fix/tui-shell-row-uniform.md: a
// described `shell` call draws as the sentence, then ONE block whose first line
// is `$ <command>`; the outcome is never a glyph in the title and `exit=N` is
// written only when N ≠ 0 (a colour-blind owner reads the line's absence).

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const level = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = level;
});

const SENTENCE = "Run the mobile package tests";
let seq = 0;
/** A fresh item each call: the row cache is keyed by item identity. */
function shell(over: Partial<ToolItem> & { command?: string; description?: string | null }) {
  const { command = "bun test apps/mobile", description = SENTENCE, ...rest } = over;
  seq += 1;
  return {
    kind: "tool",
    id: `s${seq}`,
    name: "shell",
    args: JSON.stringify(description === null ? { command } : { command, description }),
    status: "running",
    ...rest,
  } as ToolItem;
}
const rows = (item: ToolItem, extra: Record<string, unknown> = {}) =>
  transcriptRows([item], { expandAll: false, width: 80, ...extra });

describe("a described shell row (one shape for every state)", () => {
  test("running: exactly 2 rows — the sentence (no outcome, no running… body), then `⎿ $ cmd`", () => {
    const out = rows(shell({})).map(strip);
    expect(out).toEqual([`● ${SENTENCE}`, "⎿ $ bun test apps/mobile"]);
  });

  test("settled ok: NO ✓ and NO exit=0 — the block starts with the command, then the output", () => {
    const out = rows(shell({ status: "ok", durationMs: 1200, resultText: "exit=0\nall good" })).map(
      strip,
    );
    expect(out).toEqual([`● ${SENTENCE} 1.2s`, "⎿ $ bun test apps/mobile", "  all good"]);
    expect(out.join("\n")).not.toContain("✓");
  });

  test("error exit=2: no `✗ exit 2` in the title; `exit=2` is the block's first line after the command", () => {
    const out = rows(shell({ status: "error", durationMs: 3400, resultText: "exit=2\nboom" })).map(
      strip,
    );
    expect(out).toEqual([`● ${SENTENCE} 3.4s`, "⎿ $ bun test apps/mobile", "  exit=2", "  boom"]);
    expect(out[0]).not.toContain("✗");
  });

  test("a denial: no ✗ in the title, no invented code, and no exit= line", () => {
    const out = rows(
      shell({ status: "error", resultText: "Permission denied by the user: no" }),
    ).map(strip);
    expect(out).toEqual([
      `● ${SENTENCE}`,
      "⎿ $ bun test apps/mobile",
      "  Permission denied by the user: no",
    ]);
  });

  test("a success with no output: the title line and the command, nothing else", () => {
    expect(rows(shell({ status: "ok", durationMs: 200, resultText: "exit=0" })).map(strip)).toEqual(
      [`● ${SENTENCE} 0.2s`, "⎿ $ bun test apps/mobile"],
    );
  });

  test("a multi-line command: the block's first row is its first line + …", () => {
    const out = rows(shell({ command: "cd x\nbun test\nexit 0" })).map(strip);
    expect(out).toEqual([`● ${SENTENCE}`, "⎿ $ cd x…"]);
  });

  test("every row fits the width (30 / 80 / 200), the header never wraps", () => {
    const long = "a very long sentence that keeps going on and on about what it does here";
    const cmd = `bun test ${"packages/tui/test/".repeat(12)}`;
    for (const width of [30, 80, 200]) {
      for (const status of ["running", "ok", "error"] as const) {
        const item = shell({
          description: long,
          command: cmd,
          status,
          durationMs: 1200,
          resultText: status === "error" ? "exit=2\nx" : "exit=0\nx",
        });
        const out = transcriptRows([item], { expandAll: false, width });
        for (const row of out) {
          expect(stringWidth(row)).toBeLessThanOrEqual(width);
        }
        expect(strip(out[1] ?? "").startsWith("⎿ $ bun test")).toBe(true);
      }
    }
  });

  test("expanded (click): the whole command on `  │ $ …` rows, wrapped", () => {
    const cmd = `bun test ${"packages/tui/test/".repeat(8)}`;
    const item = shell({ command: cmd });
    const out = rows(item, { expandedIds: [item.id] }).map(strip);
    expect(out[0]).toBe(`● ${SENTENCE}`);
    expect(out[1]?.startsWith("  │ $ bun test")).toBe(true);
    const joined = out
      .slice(1)
      .map((r) => r.replace(/^ {2}│ /, ""))
      .join("");
    expect(joined).toBe(`$ ${cmd}`);
  });

  test("a spilled success drops the `exit=0` in the spill head too; a spill with a code keeps it", () => {
    const spill = (head: string) => ({ chars: 40_800, head, tail: "", omitted: 0 });
    const NOTE = "40.8k chars · too large, could not be saved — the model sees only this preview";
    // The row says NO outcome, so a spill head still carrying `exit=0` would be
    // the only thing claiming a success: dropped, exactly like the plain body.
    expect(
      rows(
        shell({
          status: "ok",
          durationMs: 900,
          resultText: "banner",
          spill: spill("exit=0\nPageouts: 77"),
        }),
      ).map(strip),
    ).toEqual([`● ${SENTENCE} 0.9s`, "⎿ $ bun test apps/mobile", `  ${NOTE}`, "  Pageouts: 77"]);
    // A failure's code is read from the same head and stays (first body line).
    expect(
      rows(
        shell({ status: "error", resultText: "banner", spill: spill("exit=3\nmany lines") }),
      ).map(strip),
    ).toEqual([
      `● ${SENTENCE}`,
      "⎿ $ bun test apps/mobile",
      `  ${NOTE}`,
      "  exit=3",
      "  many lines",
    ]);
  });

  test("failure modes: a denial's reply, a killed code, a background start", () => {
    // A denial's reply (docs/feat/permission-reply.md): no code invented, and no
    // `✗` in the title — the reply is under the command.
    expect(
      rows(shell({ status: "error", denialReply: "no, use the other repo" })).map(strip),
    ).toEqual([`● ${SENTENCE}`, "⎿ $ bun test apps/mobile", "  ✗ Denied · no, use the other repo"]);
    // A timeout kill (`exit=124`) and a signal death (`exit=-1`): both written.
    for (const n of [124, -1]) {
      expect(
        rows(shell({ status: "error", resultText: `exit=${n}\n[killed]` }))
          .map(strip)
          .slice(0, 3),
      ).toEqual([`● ${SENTENCE}`, "⎿ $ bun test apps/mobile", `  exit=${n}`]);
    }
    // A background start has no `exit=` at all: the block is the command + the note.
    expect(
      rows(shell({ status: "ok", resultText: "started background job j1: `x`" })).map(strip),
    ).toEqual([`● ${SENTENCE}`, "⎿ $ bun test apps/mobile", "  started background job j1: `x`"]);
  });

  test("queued: the sentence on the dim ◌ row, then the block's `$ cmd` row", () => {
    const out = rows(shell({ status: "queued" })).map(strip);
    expect(out).toEqual([`◌ ${SENTENCE} · queued`, "⎿ $ bun test apps/mobile"]);
  });
});

describe("beta compactShell", () => {
  test("a success drops the `$` row, so `⎿` starts the output; a failure shows it in full", () => {
    const c = { compactShell: true };
    expect(rows(shell({}), c).map(strip)).toEqual([`● ${SENTENCE}`]);
    expect(
      rows(shell({ status: "ok", durationMs: 0, resultText: "exit=0\nPageouts: 77" }), c).map(
        strip,
      ),
    ).toEqual([`● ${SENTENCE} 0.0s`, "⎿ Pageouts: 77"]);
    const err = rows(shell({ status: "error", resultText: "exit=2\nboom" }), c).map(strip);
    expect(err).toEqual([`● ${SENTENCE}`, "⎿ $ bun test apps/mobile", "  exit=2", "  boom"]);
  });

  test("a successful command with no output is the title line alone", () => {
    const out = rows(shell({ status: "ok", durationMs: 0, resultText: "exit=0" }), {
      compactShell: true,
    }).map(strip);
    expect(out).toEqual([`● ${SENTENCE} 0.0s`]);
  });

  test("expanded (ctrl+o): the whole command is there, whatever the beta says", () => {
    const item = shell({ status: "ok", resultText: "exit=0\nfine" });
    const open = rows(item, { compactShell: true, expandedIds: [item.id] }).map(strip);
    expect(open[1]).toBe("  │ $ bun test apps/mobile");
  });

  test("the same item drawn compact then not compact gets different rows (cache key)", () => {
    const item = shell({ status: "ok", resultText: "exit=0\nfine" });
    const compact = rows(item, { compactShell: true }).map(strip);
    const full = rows(item, { compactShell: false }).map(strip);
    expect(full.length).toBe(compact.length + 1);
    expect(full[1]).toBe("⎿ $ bun test apps/mobile");
  });
});

describe("no sentence: the command stays in the title, the same exit rule", () => {
  // Built through the live palette; the command stays in the title (no block
  // `$` row), and a success writes no `exit=` line (fix/tui-shell-row-uniform).
  test("running / ok / error / queued / expanded", () => {
    const g = theme.subtle;
    const B = (s: string) => chalk.bold(s);
    const base = { description: null, command: "bun test apps/mobile" } as const;
    const cmd = "bun test apps/mobile";
    expect(rows(shell({ ...base }))).toEqual([
      `${theme.accent("●")} ${B("Bash")} ${g(cmd)}`,
      `${g("⎿")} ${g("running…")}`,
    ]);
    expect(
      rows(shell({ ...base, status: "ok", durationMs: 1200, resultText: "exit=0\nall good" })),
    ).toEqual([
      `${theme.success("●")} ${B("Bash")} ${g(cmd)}${g(" 1.2s")}`,
      `${g("⎿")} ${g("all good")}`,
    ]);
    // A success with no output at all: the title row only, never `⎿ exit=0`.
    expect(rows(shell({ ...base, status: "ok", durationMs: 1200, resultText: "exit=0" }))).toEqual([
      `${theme.success("●")} ${B("Bash")} ${g(cmd)}${g(" 1.2s")}`,
    ]);
    expect(
      rows(shell({ ...base, status: "error", durationMs: 3400, resultText: "exit=2\nboom" })),
    ).toEqual([
      `${theme.error("●")} ${B("Bash")} ${g(cmd)}${g(" 3.4s")}`,
      `${g("⎿")} ${theme.error("exit=2")}`,
      `  ${theme.error("boom")}`,
    ]);
    expect(rows(shell({ ...base, status: "queued" }))).toEqual([g(`◌ Bash ${cmd} · queued`)]);
    const item = shell({ ...base, status: "ok", resultText: "exit=0\nx" });
    expect(rows(item, { expandedIds: [item.id] })).toEqual([
      `${theme.success("●")} ${B("Bash")}`,
      `${g("  │ ")}${cmd}`,
      `${g("⎿")} ${g("x")}`,
    ]);
    const failed = shell({ ...base, status: "error", resultText: "exit=3\nx" });
    expect(rows(failed, { expandedIds: [failed.id] })).toEqual([
      `${theme.error("●")} ${B("Bash")}`,
      `${g("  │ ")}${cmd}`,
      `${g("⎿")} ${theme.error("exit=3")}`,
      `  ${theme.error("x")}`,
    ]);
  });

  test("an empty or whitespace description is no sentence", () => {
    for (const description of ["", "   "]) {
      expect(strip(rows(shell({ description }))[0] ?? "")).toBe("● Bash bun test apps/mobile");
    }
  });
});
