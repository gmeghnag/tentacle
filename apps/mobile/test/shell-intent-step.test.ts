/**
 * docs/feat/shell-intent-line.md §6: a described `shell` call on the phone —
 * the sentence is the step's name, `$ cmd` a line under it, the outcome WRITTEN
 * in the trailing text. No sentence ⇒ today's view, byte-identical.
 */
import { describe, expect, test } from "bun:test";
import { stepRowView } from "../src/tool-steps.ts";
import type { ToolRow, ToolStatus } from "../src/transcript-rows.ts";

const SENTENCE = "Controllo i test del pacchetto mobile";
const row = (
  status: ToolStatus,
  extra: Partial<ToolRow> = {},
  args: Record<string, unknown> = { command: "bun test apps/mobile", description: SENTENCE },
): ToolRow => ({
  kind: "tool",
  key: "k",
  id: "c1",
  name: "shell",
  label: "Bash",
  args: JSON.stringify(args),
  status,
  ...extra,
});

describe("a described shell step", () => {
  test("the sentence is the name, the command a $ line under it, nothing after the name", () => {
    const v = stepRowView(row("running", { at: 5 }), null, false);
    expect(v.name).toEqual({ tool: SENTENCE });
    expect(v.subtitle).toBe("");
    expect(v.subline).toBe("$ bun test apps/mobile");
    expect(v.shimmer).toBe(true);
    expect(v.trailing).toBe("");
    expect(v.live).toBe(true);
  });

  test("the trailing is the duration ONLY — no ✓, no ✗ (owner 22/11, decision 1)", () => {
    expect(
      stepRowView(row("ok", { durationMs: 1200, output: "exit=0\nfine" }), null, false),
    ).toMatchObject({ trailing: "1.2 s", exitSuffix: null, shimmer: false });
    // A failure is written in TEXT at the end of the $ line, not after the name.
    const failed = stepRowView(
      row("error", { durationMs: 3400, output: "exit=2\nboom" }),
      null,
      false,
    );
    expect(failed.trailing).toBe("3.4 s");
    expect(failed.exitSuffix).toBe("exit 2");
    expect(failed.trailingRed).toBe(false);
    // A failure with no code in its result has nothing to write on the $ line: the
    // duration keeps today's red (`tool failed`).
    const noCode = stepRowView(
      row("error", { durationMs: 3400, output: "tool failed" }),
      null,
      false,
    );
    expect(noCode.trailing).toBe("3.4 s");
    expect(noCode.exitSuffix).toBeNull();
    expect(noCode.trailingRed).toBe(true);
    // No duration measured: nothing after the name at all.
    expect(stepRowView(row("ok", { output: "exit=0\n" }), null, false).trailing).toBe("");
  });

  test("a spilled error reads its code from the spill head", () => {
    const spill = { path: "/x", head: "exit=3\nlots", lines: 9000, bytes: 1 } as never;
    const v = stepRowView(row("error", { output: "[spilled]\nexit=9", spill }), null, false);
    expect(v.exitSuffix).toBe("exit 3");
  });

  test("a denial keeps `denied`", () => {
    expect(stepRowView(row("denied"), null, false).trailing).toBe("denied");
    expect(stepRowView(row("denied"), null, false).exitSuffix).toBeNull();
  });

  test("a multi-line command: its first line + …", () => {
    const v = stepRowView(
      row("ok", {}, { command: "cd x\nbun test", description: "Go" }),
      null,
      false,
    );
    expect(v.subline).toBe("$ cd x…");
  });

  test("VoiceOver reads the sentence then the outcome in words", () => {
    const v = stepRowView(row("error", { durationMs: 3400, output: "exit=2\nboom" }), null, false);
    expect(v.a11yLabel.startsWith(`${SENTENCE}, failed, exit code 2`)).toBe(true);
  });

  test("compact (beta): no $ line while running or on success; shown on error and denial", () => {
    expect(stepRowView(row("running"), null, false, false, true).subline).toBeNull();
    expect(
      stepRowView(row("ok", { output: "exit=0" }), null, false, false, true).subline,
    ).toBeNull();
    expect(stepRowView(row("error", { output: "exit=2" }), null, false, false, true).subline).toBe(
      "$ bun test apps/mobile",
    );
    expect(stepRowView(row("denied"), null, false, false, true).subline).toBe(
      "$ bun test apps/mobile",
    );
    // The beta hides the $ line only while running or on success; an error always
    // shows it (shellRowParts), so the code lands there exactly as in the default.
    const beta = stepRowView(
      row("error", { durationMs: 3400, output: "exit=2" }),
      null,
      false,
      false,
      true,
    );
    expect(beta.exitSuffix).toBe("exit 2");
    expect(beta.trailing).toBe("3.4 s");
  });

  test("the open body never repeats the command the $ line already shows", () => {
    // The default: the $ line is drawn, so the body drops the command (decision 5).
    const v = stepRowView(row("ok", { output: "exit=0" }), null, false);
    expect(v.subline).toBe("$ bun test apps/mobile");
    expect(v.command).toEqual([]);
    // The beta hides the $ line on a success: the body is then the ONLY place the
    // command can be read, so it keeps it (never silently dropped).
    const hidden = stepRowView(row("ok", { output: "exit=0" }), null, false, false, true);
    expect(hidden.subline).toBeNull();
    expect(hidden.command.join("\n")).toContain("bun test apps/mobile");
  });

  test("the open body never repeats the exit code the $ line already shows (decision 5)", () => {
    const v = stepRowView(row("error", { output: "exit=125\nError: no such pod" }), null, false);
    expect(v.exitSuffix).toBe("exit 125");
    expect(v.output?.text).toBe("Error: no such pod");
    // No `$` line (no sentence): the code has nowhere else to read, so the body
    // keeps it where it is today (decision 2).
    const plain = stepRowView(
      row("error", { output: "exit=125\nError: no such pod" }, { command: "podman ps" }),
      null,
      false,
    );
    expect(plain.exitSuffix).toBeNull();
    expect(plain.output?.text).toBe("exit=125\nError: no such pod");
  });
});

describe("no sentence: today's view", () => {
  test("byte-identical except the two new fields at their neutral values", () => {
    for (const status of ["running", "ok", "error", "denied", "queued"] as const) {
      const plain = row(
        status,
        { durationMs: 1200, output: "exit=2\nx", at: 5 },
        { command: "ls" },
      );
      const described = row(
        status,
        { durationMs: 1200, output: "exit=2\nx", at: 5 },
        {
          command: "ls",
          description: "  ",
        },
      );
      const a = stepRowView(plain, null, false);
      expect(a.subline).toBeNull();
      expect(a.exitSuffix).toBeNull();
      expect(a.shimmer).toBe(false);
      expect(a.name).toEqual({ tool: "Bash" });
      expect(a.subtitle).toBe("ls");
      expect(a.trailing).toBe(status === "denied" ? "denied" : "1.2 s");
      expect(stepRowView(described, null, false)).toEqual(a);
    }
  });
});
