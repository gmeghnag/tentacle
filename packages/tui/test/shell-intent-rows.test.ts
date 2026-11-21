import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import stringWidth from "string-width";
import { transcriptRows } from "../src/render-lines.ts";
import type { ToolItem } from "../src/state.ts";
import { theme } from "../src/theme.ts";

// docs/feat/shell-intent-line.md §3: a described `shell` call draws as the
// sentence + a WRITTEN outcome, then a subtle `$ <command>` row.

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

describe("a described shell row (variant B)", () => {
  test("running: exactly 2 rows — the sentence (no outcome, no running… body), then `  $ cmd`", () => {
    const out = rows(shell({})).map(strip);
    expect(out).toEqual([`● ${SENTENCE}`, "  $ bun test apps/mobile"]);
  });

  test("settled ok: the header WRITES ✓ (SGR stripped) and the $ row stays", () => {
    const out = rows(shell({ status: "ok", durationMs: 1200, resultText: "exit=0\nall good" })).map(
      strip,
    );
    expect(out[0]).toBe(`● ${SENTENCE} ✓ 1.2s`);
    expect(out[1]).toBe("  $ bun test apps/mobile");
    expect(out[2]).toContain("⎿");
  });

  test("error exit=2: the header WRITES `✗ exit 2`, not only a red hue", () => {
    const out = rows(shell({ status: "error", durationMs: 3400, resultText: "exit=2\nboom" })).map(
      strip,
    );
    expect(out[0]).toBe(`● ${SENTENCE} ✗ exit 2 3.4s`);
  });

  test("a denial writes ✗ with no invented code", () => {
    const out = rows(
      shell({ status: "error", resultText: "Permission denied by the user: no" }),
    ).map(strip);
    expect(out[0]).toBe(`● ${SENTENCE} ✗`);
  });

  test("a multi-line command: row 1 is its first line + …, one row", () => {
    const out = rows(shell({ command: "cd x\nbun test\nexit 0" })).map(strip);
    expect(out).toEqual([`● ${SENTENCE}`, "  $ cd x…"]);
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
        expect(strip(out[1] ?? "").startsWith("  $ bun test")).toBe(true);
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

  test("queued: the sentence on the dim ◌ row, then the $ row", () => {
    const out = rows(shell({ status: "queued" })).map(strip);
    expect(out).toEqual([`◌ ${SENTENCE} · queued`, "  $ bun test apps/mobile"]);
  });
});

describe("beta compactShell", () => {
  test("running / ok → 1 row; error → 2 rows; expanded → command present", () => {
    const c = { compactShell: true };
    expect(rows(shell({}), c).map(strip)).toEqual([`● ${SENTENCE}`]);
    const ok = rows(shell({ status: "ok", resultText: "exit=0\nfine" }), c).map(strip);
    expect(ok.some((r) => r.includes("$ bun test"))).toBe(false);
    const err = rows(shell({ status: "error", resultText: "exit=2\nboom" }), c).map(strip);
    expect(err[1]).toBe("  $ bun test apps/mobile");
    const item = shell({ status: "ok", resultText: "exit=0\nfine" });
    const open = rows(item, { ...c, expandedIds: [item.id] }).map(strip);
    expect(open[1]).toBe("  │ $ bun test apps/mobile");
  });

  test("the same item drawn compact then not compact gets different rows (cache key)", () => {
    const item = shell({ status: "ok", resultText: "exit=0\nfine" });
    const compact = rows(item, { compactShell: true }).map(strip);
    const full = rows(item, { compactShell: false }).map(strip);
    expect(full.length).toBe(compact.length + 1);
    expect(full[1]).toBe("  $ bun test apps/mobile");
  });
});

describe("no sentence: today's row, byte-identical", () => {
  // The pre-change (`main` b875a12d) rows, built through the live palette.
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
      `${g("⎿")} ${g("exit=0")}`,
      `  ${g("all good")}`,
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
      `${g("⎿")} ${g("exit=0")}`,
      `  ${g("x")}`,
    ]);
  });

  test("an empty or whitespace description is no sentence", () => {
    for (const description of ["", "   "]) {
      expect(strip(rows(shell({ description }))[0] ?? "")).toBe("● Bash bun test apps/mobile");
    }
  });
});
