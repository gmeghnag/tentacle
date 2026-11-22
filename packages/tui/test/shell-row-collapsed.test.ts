import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import stringWidth from "string-width";
import { transcriptRows } from "../src/render-lines.ts";
import type { ToolItem } from "../src/state.ts";

/**
 * docs/fix/tui-shell-row-collapsed (owner variant B): ONE shape for every
 * `shell` row, described or not. Collapsed it is the title plus ONE
 * `⎿ $ <command>` row, with `exit=N` at the END of that row when N ≠ 0 — and
 * NEVER the output. Expanded (ctrl+o, or the row clicked) the whole command is
 * wrapped under a `⎿ $ …` block opening with continuation rows indented 4, the
 * code ending its LAST command row, and the output at col 2 under it. No `  │ `
 * rows for a shell command anywhere.
 *
 * The owner is colour-blind: the signal is the TEXT (`exit=` present or not);
 * colour only reinforces it.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const level = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = level;
});

const SENTENCE = "Test dei componenti file";
let seq = 0;
/** A fresh item each call: the row cache is keyed by item identity. */
function shell(
  over: Partial<ToolItem> & { command?: string; description?: string | null } = {},
): ToolItem {
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
  transcriptRows([item], { expandAll: false, width: 80, ...extra }).map(strip);

describe("collapsed: the command, never the output", () => {
  test("a described success: sentence + `⎿ $ cmd`, NO output, no `exit=`", () => {
    expect(
      rows(shell({ status: "ok", durationMs: 3400, resultText: "exit=0\npass 23\nfail 1" })),
    ).toEqual([`● ${SENTENCE} 3.4s`, "⎿ $ bun test apps/mobile"]);
  });

  test("a described success with no output is the same two rows", () => {
    expect(rows(shell({ status: "ok", durationMs: 200, resultText: "exit=0" }))).toEqual([
      `● ${SENTENCE} 0.2s`,
      "⎿ $ bun test apps/mobile",
    ]);
  });

  test("a described failure: `exit=1` ends the `$` row (two spaces after the command)", () => {
    expect(rows(shell({ status: "error", durationMs: 3400, resultText: "exit=1\nboom" }))).toEqual([
      `● ${SENTENCE} 3.4s`,
      "⎿ $ bun test apps/mobile  exit=1",
    ]);
  });

  test("a multi-line command: its FIRST line, then `…`", () => {
    expect(rows(shell({ command: "cd x\nbun test\nexit 0", status: "ok", resultText: "exit=0" }))) //
      .toEqual([`● ${SENTENCE}`, "⎿ $ cd x…"]);
  });

  test("a long command is cut with `…` so `exit=N` ALWAYS fits — the code is never cut", () => {
    const cmd = `bun test ${"packages/tui/test/".repeat(12)}`;
    for (const width of [40, 80, 190]) {
      const out = rows(shell({ command: cmd, status: "error", resultText: "exit=1\nboom" }), {
        width,
      });
      expect(out).toHaveLength(2);
      expect(out[1]?.endsWith("  exit=1")).toBe(true);
      expect(out[1]?.includes("…")).toBe(true);
      for (const row of out) {
        expect(stringWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("a long command on a narrow terminal: the code still fits, the command is the cut one", () => {
    const out = rows(shell({ command: "a".repeat(200), status: "error", resultText: "exit=127" }), {
      width: 40,
    });
    // 40 − `⎿ $ ` (4) − `  exit=127` (10) = 26 cells for the command, `…` last.
    expect(out[1]).toBe(`⎿ $ ${"a".repeat(25)}…  exit=127`);
    expect(stringWidth(out[1] ?? "")).toBe(40);
  });

  test("running: `⎿ $ cmd` with no code and no `running…` body", () => {
    expect(rows(shell({}))).toEqual([`● ${SENTENCE}`, "⎿ $ bun test apps/mobile"]);
  });

  test("queued: the dim ◌ row, then the `$` row", () => {
    expect(rows(shell({ status: "queued" }))).toEqual([
      `◌ ${SENTENCE} · queued`,
      "⎿ $ bun test apps/mobile",
    ]);
  });

  test("a denial's reply rides the block under the `$` row — an OUTCOME, not output", () => {
    expect(rows(shell({ status: "error", denialReply: "no, use the other repo" }))).toEqual([
      `● ${SENTENCE}`,
      "⎿ $ bun test apps/mobile",
      "  ✗ Denied · no, use the other repo",
    ]);
  });

  test("a background start writes no `exit=`; its start note is the block's outcome line", () => {
    const out = rows(shell({ status: "ok", resultText: "started background job j1: `x`" }));
    expect(out).toEqual([
      `● ${SENTENCE}`,
      "⎿ $ bun test apps/mobile",
      "  started background job j1: `x`",
    ]);
    expect(out[1]).toBe("⎿ $ bun test apps/mobile");
  });

  test("a timeout kill and a signal death: the code is written, not hidden", () => {
    for (const n of [124, -1]) {
      expect(rows(shell({ status: "error", resultText: `exit=${n}\n[killed]` }))).toEqual([
        `● ${SENTENCE}`,
        `⎿ $ bun test apps/mobile  exit=${n}`,
      ]);
    }
  });

  test("a spilled failure reads its code from the spill's head", () => {
    const out = rows(
      shell({
        status: "error",
        resultText: "banner",
        spill: { chars: 40_800, head: "exit=3\nmany lines", tail: "", omitted: 0 },
      }),
    );
    expect(out).toEqual([`● ${SENTENCE}`, "⎿ $ bun test apps/mobile  exit=3"]);
  });

  test("the success colour reinforces the ABSENCE of `exit=` (nothing else says it)", () => {
    const ok = transcriptRows([shell({ status: "ok", resultText: "exit=0\npass" })], {
      expandAll: false,
      width: 80,
    });
    const raw = ok.join("\n");
    expect(strip(raw)).not.toContain("exit=");
    expect(strip(raw)).not.toContain("✓");
  });
});

describe("expanded: the whole command opens the block, then the output", () => {
  test("described failure: the `$` row opens the block, continuation indented 4, output at col 2", () => {
    expect(
      rows(shell({ status: "error", durationMs: 3400, resultText: "exit=1\nboom\nsecond" }), {
        expandAll: true,
      }),
    ).toEqual([`● ${SENTENCE} 3.4s`, "⎿ $ bun test apps/mobile  exit=1", "  boom", "  second"]);
  });

  test("described success: the code is absent, the output follows the command", () => {
    expect(
      rows(shell({ status: "ok", durationMs: 3400, resultText: "exit=0\nall good" }), {
        expandAll: true,
      }),
    ).toEqual([`● ${SENTENCE} 3.4s`, "⎿ $ bun test apps/mobile", "  all good"]);
  });

  test("NO `  │ ` rows for a shell command any more (collapsed or expanded)", () => {
    const item = shell({ status: "ok", resultText: "exit=0\nx" });
    for (const extra of [{}, { expandAll: true }, { expandedIds: [item.id] }]) {
      expect(rows(item, extra).some((r) => r.includes("│"))).toBe(false);
    }
  });

  test("a long command wraps at the width, continuation rows indented 4", () => {
    const cmd =
      "cd apps/mobile && bun test src/ui/FileBody.test.tsx src/ui/CodeBlock.test.tsx && echo done";
    const out = rows(shell({ command: cmd, status: "error", resultText: "exit=1\n1 fail" }), {
      width: 40,
      expandAll: true,
    });
    expect(out[1]?.startsWith("⎿ $ cd apps/mobile")).toBe(true);
    const hang = out.filter((r) => r.startsWith("    "));
    expect(hang.length).toBeGreaterThan(0);
    for (const row of out) {
      expect(stringWidth(row)).toBeLessThanOrEqual(40);
    }
    // The whole command is there once the wrap is undone (code tail excluded).
    const body = out.slice(
      1,
      out.findIndex((r) => r.startsWith("  1 fail")),
    );
    const joined = body
      .map((r) => r.replace(/^⎿ \$ /, "").replace(/^ {4}/, ""))
      .join("")
      .replace(/ {2}exit=1$/, "");
    expect(joined).toBe(cmd);
  });

  test("a multi-line command keeps every line, each hanging under the block", () => {
    const out = rows(
      shell({ command: "make build\nmake test", status: "ok", resultText: "exit=0" }),
      {
        width: 60,
        expandAll: true,
      },
    );
    expect(out.slice(1)).toEqual(["⎿ $ make build", "    make test"]);
  });

  test("`exit=N` on its OWN continuation row when it does not fit the last command row", () => {
    // 40 columns: 36 per command row, so `cccc…` (69) wraps 36 + 33 and neither
    // `4 + 33` nor `+ 6` fits the code on that last row.
    const out = rows(shell({ command: "c".repeat(69), status: "error", resultText: "exit=9" }), {
      width: 40,
      expandAll: true,
    });
    expect(out[0]).toBe(`● ${SENTENCE}`);
    expect(out.at(-1)).toBe("    exit=9");
    for (const row of out) {
      expect(stringWidth(row)).toBeLessThanOrEqual(40);
    }
  });

  test("a clicked row (`expandedIds`) behaves like ctrl+o", () => {
    const item = shell({ status: "error", resultText: "exit=2\nboom" });
    expect(rows(item, { expandedIds: [item.id] })).toEqual(
      rows(shell({ status: "error", resultText: "exit=2\nboom" }), { expandAll: true }),
    );
  });

  test("a spilled failure expands to its head/tail preview at col 2", () => {
    const out = rows(
      shell({
        status: "error",
        resultText: "banner",
        spill: {
          chars: 40_800,
          path: "/t/s.txt",
          head: "exit=3\nmany lines",
          tail: "y",
          omitted: 39_600,
        },
      }),
      { expandAll: true },
    );
    expect(out[1]).toBe("⎿ $ bun test apps/mobile  exit=3");
    expect(out[2]).toContain("40.8k chars");
    expect(out.join("\n")).toContain("  many lines");
  });

  test("a denial's reply expands under the `$` row, unchanged wording", () => {
    const out = rows(shell({ status: "error", denialReply: "no, use the other repo" }), {
      expandAll: true,
    });
    expect(out).toEqual([
      `● ${SENTENCE}`,
      "⎿ $ bun test apps/mobile",
      "  ✗ Denied · no, use the other repo",
    ]);
  });
});

describe("no sentence: the command in the title collapsed, a block expanded", () => {
  const cmd = "podman ps --format '{{.Names}} {{.Status}}' 2>&1; echo ---; docker ps 2>&1";

  test("collapsed failure: `● Bash <cmd cut>  exit=N <elapsed>`, NO body", () => {
    const out = rows(
      shell({
        command: cmd,
        description: null,
        status: "error",
        durationMs: 400,
        resultText: "exit=125\nCannot connect",
      }),
    );
    // One row: the command cut to the room the code and the duration leave, the
    // code two spaces after it, the duration last.
    expect(out).toHaveLength(1);
    expect(out[0]?.startsWith("● Bash podman ps --format")).toBe(true);
    expect(out[0]?.endsWith("…  exit=125 0.4s")).toBe(true);
    expect(stringWidth(out[0] ?? "")).toBeLessThanOrEqual(80);
    expect(out.join("\n")).not.toContain("Cannot connect");
  });

  test("collapsed success: no `exit=`, the command then the duration", () => {
    expect(
      rows(
        shell({
          command: "ls",
          description: null,
          status: "ok",
          durationMs: 100,
          resultText: "exit=0\nout",
        }),
      ),
    ).toEqual(["● Bash ls 0.1s"]);
  });

  test("collapsed running: the command alone, no duration, no `running…`", () => {
    expect(rows(shell({ command: "ls", description: null }))).toEqual(["● Bash ls"]);
  });

  test("collapsed queued: `◌ Bash <cmd> · queued` (no block)", () => {
    expect(rows(shell({ command: "ls", description: null, status: "queued" }))).toEqual([
      "◌ Bash ls · queued",
    ]);
  });

  test("expanded: `● Bash <elapsed>` + the block + the output — the command leaves the title", () => {
    expect(
      rows(
        shell({
          command: "ls",
          description: null,
          status: "error",
          durationMs: 400,
          resultText: "exit=1\nboom",
        }),
        {
          expandAll: true,
        },
      ),
    ).toEqual(["● Bash 0.4s", "⎿ $ ls  exit=1", "  boom"]);
  });

  test("expanded with no code: `● Bash <elapsed>` + `⎿ $ cmd` + output", () => {
    expect(
      rows(
        shell({
          command: "ls",
          description: null,
          status: "ok",
          durationMs: 400,
          resultText: "exit=0\nok",
        }),
        {
          expandAll: true,
        },
      ),
    ).toEqual(["● Bash 0.4s", "⎿ $ ls", "  ok"]);
  });

  test("every collapsed title row fits the width (40 / 80 / 190)", () => {
    for (const width of [40, 80, 190]) {
      for (const status of ["running", "ok", "error"] as const) {
        const out = rows(
          shell({
            command: cmd,
            description: null,
            status,
            durationMs: 400,
            resultText: status === "error" ? "exit=125\nx" : "exit=0\nx",
          }),
          { width },
        );
        expect(out).toHaveLength(1);
        for (const row of out) {
          expect(stringWidth(row)).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});

describe("other tools are untouched", () => {
  test("an `fs_read` keeps its header + `⎿` body", () => {
    seq += 1;
    const item = {
      kind: "tool",
      id: `r${seq}`,
      name: "fs_read",
      args: JSON.stringify({ path: "a.ts" }),
      status: "ok",
      resultText: "line one",
    } as ToolItem;
    expect(rows(item)).toEqual(["● Read a.ts", "⎿ line one"]);
  });
});

describe("one shape: the retired beta changes nothing", () => {
  test("`compactShell` has no effect on a TUI shell row any more", () => {
    for (const status of ["running", "ok", "error"] as const) {
      const over = {
        status,
        durationMs: 900,
        resultText: status === "error" ? "exit=2\nboom" : "exit=0\nfine",
      };
      expect(rows(shell(over), { compactShell: true })).toEqual(rows(shell(over)));
    }
  });
});

describe("widths 40 and 190: the input row never moves under the same row", () => {
  test("the collapsed -> expanded swap keeps the header on row 0", () => {
    for (const width of [40, 190]) {
      const item = shell({ status: "error", resultText: "exit=1\nboom" });
      const collapsed = transcriptRows([item], { expandAll: false, width });
      const expanded = transcriptRows([shell({ status: "error", resultText: "exit=1\nboom" })], {
        expandAll: true,
        width,
      });
      expect(strip(collapsed[0] ?? "")).toContain(SENTENCE);
      expect(strip(expanded[0] ?? "")).toContain(SENTENCE);
      expect(expanded.length).toBeGreaterThan(collapsed.length);
      for (const row of [...collapsed, ...expanded]) {
        expect(stringWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });
});
