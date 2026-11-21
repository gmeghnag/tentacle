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

  test("trailing writes the outcome: ✓ 1.2 s / ✗ exit 2 · 3.4 s / ✗ · 3.4 s", () => {
    expect(
      stepRowView(row("ok", { durationMs: 1200, output: "exit=0\nfine" }), null, false),
    ).toMatchObject({ trailing: "✓ 1.2 s", shimmer: false });
    expect(
      stepRowView(row("error", { durationMs: 3400, output: "exit=2\nboom" }), null, false).trailing,
    ).toBe("✗ exit 2 · 3.4 s");
    expect(
      stepRowView(row("error", { durationMs: 3400, output: "tool failed" }), null, false).trailing,
    ).toBe("✗ · 3.4 s");
    expect(stepRowView(row("ok", { output: "exit=0\n" }), null, false).trailing).toBe("✓");
  });

  test("a spilled error reads its code from the spill head", () => {
    const spill = { path: "/x", head: "exit=3\nlots", lines: 9000, bytes: 1 } as never;
    const v = stepRowView(row("error", { output: "[spilled]\nexit=9", spill }), null, false);
    expect(v.trailing).toBe("✗ exit 3");
  });

  test("a denial keeps `denied`", () => {
    expect(stepRowView(row("denied"), null, false).trailing).toBe("denied");
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
  });

  test("the open body still has the full command (Command → Output)", () => {
    const v = stepRowView(row("ok", { output: "exit=0" }), null, false, false, true);
    expect(v.command.join("\n")).toContain("bun test apps/mobile");
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
      expect(a.shimmer).toBe(false);
      expect(a.name).toEqual({ tool: "Bash" });
      expect(a.subtitle).toBe("ls");
      expect(a.trailing).toBe(status === "denied" ? "denied" : "1.2 s");
      expect(stepRowView(described, null, false)).toEqual(a);
    }
  });
});
