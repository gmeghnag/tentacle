import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import stringWidth from "string-width";
import { transcriptRows } from "../src/render-lines.ts";
import type { ToolItem } from "../src/state.ts";
import { theme } from "../src/theme.ts";

// docs/feat/shell-intent-line.md §3 + docs/fix/tui-shell-row-collapsed: a
// described `shell` call draws as the sentence, then the command with its exit
// code on it; the outcome is never a glyph in the title, `exit=N` is written
// only when N ≠ 0 (a colour-blind owner reads the line's absence), and the
// OUTPUT is ctrl+o only — success or failure alike. The beta `compactShell` is
// retired in the TUI: one shape.

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

  test("settled ok: NO ✓, no `exit=0`, and NO output — the block is the command alone", () => {
    const out = rows(shell({ status: "ok", durationMs: 1200, resultText: "exit=0\nall good" })).map(
      strip,
    );
    expect(out).toEqual([`● ${SENTENCE} 1.2s`, "⎿ $ bun test apps/mobile"]);
    expect(out.join("\n")).not.toContain("✓");
    expect(out.join("\n")).not.toContain("all good");
  });

  test("error exit=2: no `✗ exit 2` in the title; `exit=2` ends the `$` row, no output", () => {
    const out = rows(shell({ status: "error", durationMs: 3400, resultText: "exit=2\nboom" })).map(
      strip,
    );
    expect(out).toEqual([`● ${SENTENCE} 3.4s`, "⎿ $ bun test apps/mobile  exit=2"]);
    expect(out[0]).not.toContain("✗");
  });

  test("a denial: no ✗ in the title, no invented code, and the reply is the block's line", () => {
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

  test("a multi-line command: the block's row is its first line + …", () => {
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

  test("expanded (click): the whole command in the `⎿ $` block, wrapped, no `│`", () => {
    const cmd = `bun test ${"packages/tui/test/".repeat(8)}`;
    const item = shell({ command: cmd });
    const out = rows(item, { expandedIds: [item.id] }).map(strip);
    expect(out[0]).toBe(`● ${SENTENCE}`);
    expect(out[1]?.startsWith("⎿ $ bun test")).toBe(true);
    const joined = out
      .slice(1)
      .map((r) => r.replace(/^⎿ \$ /, "").replace(/^ {4}/, ""))
      .join("");
    expect(joined).toBe(cmd);
    expect(out.some((r) => r.includes("│"))).toBe(false);
  });

  test("a spilled result: the code comes from the spill head, the output stays hidden", () => {
    const spill = (head: string) => ({ chars: 40_800, head, tail: "", omitted: 0 });
    // A success writes nothing on the `$` row, so a spill head still carrying
    // `exit=0` would be the only thing claiming one: it never reaches the row.
    expect(
      rows(
        shell({
          status: "ok",
          durationMs: 900,
          resultText: "banner",
          spill: spill("exit=0\nPageouts: 77"),
        }),
      ).map(strip),
    ).toEqual([`● ${SENTENCE} 0.9s`, "⎿ $ bun test apps/mobile"]);
    // A failure's code is read from that same head and ends the `$` row.
    expect(
      rows(
        shell({ status: "error", resultText: "banner", spill: spill("exit=3\nmany lines") }),
      ).map(strip),
    ).toEqual([`● ${SENTENCE}`, "⎿ $ bun test apps/mobile  exit=3"]);
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
          .slice(0, 2),
      ).toEqual([`● ${SENTENCE}`, `⎿ $ bun test apps/mobile  exit=${n}`]);
    }
    // A background start has no `exit=` at all, and its start note is what the
    // call says about a JOB — output, so ctrl+o only (review round 1, MEDIUM):
    // collapsed the block is the command alone.
    expect(
      rows(shell({ status: "ok", resultText: "started background job j1: `x`" })).map(strip),
    ).toEqual([`● ${SENTENCE}`, "⎿ $ bun test apps/mobile"]);
  });

  test("queued: the sentence on the dim ◌ row, then the block's `$ cmd` row", () => {
    const out = rows(shell({ status: "queued" })).map(strip);
    expect(out).toEqual([`◌ ${SENTENCE} · queued`, "⎿ $ bun test apps/mobile"]);
  });
});

describe("the retired beta: one shape whatever `compactShell` says", () => {
  test("success, failure and running alike: the `$` row is always there", () => {
    for (const status of ["running", "ok", "error"] as const) {
      const over = {
        status,
        durationMs: 0,
        resultText: status === "error" ? "exit=2\nboom" : "exit=0\nPageouts: 77",
      };
      const compact = rows(shell(over), { compactShell: true }).map(strip);
      expect(compact).toEqual(rows(shell(over)).map(strip));
      expect(compact[1]).toBe(
        status === "error" ? "⎿ $ bun test apps/mobile  exit=2" : "⎿ $ bun test apps/mobile",
      );
    }
  });

  test("the option is not in the row-cache key either: one layout, both flags", () => {
    const item = shell({ status: "ok", resultText: "exit=0\nfine" });
    const on = rows(item, { compactShell: true });
    const off = rows(item, { compactShell: false });
    expect(off).toEqual(on);
  });
});

describe("no sentence: the command in the title, the same exit rule", () => {
  // docs/fix/tui-shell-row-collapsed: collapsed the command stays in the title,
  // with the code before the duration and no body; expanded it moves into the
  // same `⎿ $` block a described row draws.
  test("running / ok / error / queued / expanded", () => {
    const g = theme.subtle;
    const B = (s: string) => chalk.bold(s);
    const base = { description: null, command: "bun test apps/mobile" } as const;
    const cmd = "bun test apps/mobile";
    // A running row's bullet is grey like its command (owner 2026-11-23); the outcome colours it.
    expect(rows(shell({ ...base }))).toEqual([`${theme.subtle("●")} ${B("Bash")} ${g(cmd)}`]);
    expect(
      rows(shell({ ...base, status: "ok", durationMs: 1200, resultText: "exit=0\nall good" })),
    ).toEqual([`${theme.success("●")} ${B("Bash")} ${g(cmd)}${g(" 1.2s")}`]);
    // A success with no output at all: the title row only.
    expect(rows(shell({ ...base, status: "ok", durationMs: 1200, resultText: "exit=0" }))).toEqual([
      `${theme.success("●")} ${B("Bash")} ${g(cmd)}${g(" 1.2s")}`,
    ]);
    expect(
      rows(shell({ ...base, status: "error", durationMs: 3400, resultText: "exit=2\nboom" })),
    ).toEqual([
      `${theme.error("●")} ${B("Bash")} ${g(cmd)}${theme.error("  exit=2")}${g(" 3.4s")}`,
    ]);
    expect(rows(shell({ ...base, status: "queued" }))).toEqual([g(`◌ Bash ${cmd} · queued`)]);
    const item = shell({ ...base, status: "ok", resultText: "exit=0\nx" });
    expect(rows(item, { expandedIds: [item.id] })).toEqual([
      `${theme.success("●")} ${B("Bash")}`,
      `${g("⎿")} ${g(`$ ${cmd}`)}`,
      `  ${g("x")}`,
    ]);
    const failed = shell({ ...base, status: "error", resultText: "exit=3\nx" });
    expect(rows(failed, { expandedIds: [failed.id] })).toEqual([
      `${theme.error("●")} ${B("Bash")}`,
      `${g("⎿")} ${g(`$ ${cmd}`)}${theme.error("  exit=3")}`,
      `  ${theme.error("x")}`,
    ]);
  });

  test("an empty or whitespace description is no sentence", () => {
    for (const description of ["", "   "]) {
      expect(strip(rows(shell({ description }))[0] ?? "")).toBe("● Bash bun test apps/mobile");
    }
  });
});
