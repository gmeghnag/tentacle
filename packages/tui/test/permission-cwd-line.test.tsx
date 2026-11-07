import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@tentacle/core";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { cellWidth } from "../src/cells.ts";
import { PermissionPrompt, permissionPromptRows } from "../src/components/PermissionPrompt.tsx";
import { WRITES_NOTE, permissionCwdLine } from "../src/permission-ui.ts";

// docs/feat/write-tmpdir.md: writes are no longer confined to the project (the
// temp dirs and `tools.writableDirs` are writable too), so the dialog's cwd row
// no longer says "writes confined here".

const REQ: PermissionRequest = {
  tool: "fs_write",
  level: "ask",
  title: "Write a file",
  detail: "/tmp/x.json",
  input: {},
};

describe("permissionCwdLine", () => {
  test("the cwd, then the honest note", () => {
    expect(WRITES_NOTE).toBe("writes limited to here + allowed dirs");
    expect(permissionCwdLine("/w", 80)).toBe("/w · writes limited to here + allowed dirs");
    expect(permissionCwdLine("/w", 80)).not.toContain("confined");
  });

  test("a long cwd is cut so the row fits the width (one row, after the leading space)", () => {
    const line = permissionCwdLine(`/${"d".repeat(200)}`, 60);
    expect(cellWidth(line)).toBeLessThanOrEqual(59);
    expect(line.endsWith(WRITES_NOTE)).toBe(true);
  });
});

describe("the dialog's cwd row", () => {
  test("drawn for a tool call with the note, and the dialog keeps permissionPromptRows", () => {
    const view = render(
      <PermissionPrompt
        req={REQ}
        options={["Yes", "No"]}
        selected={0}
        cwd={`/work/${"long-folder-name/".repeat(6)}`}
        columns={60}
      />,
    );
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain(WRITES_NOTE);
    expect(frame).not.toContain("writes confined here");
    expect(frame.split("\n").length).toBe(permissionPromptRows(2));
    view.unmount();
  });

  // Review round 1, LOW 3: below 51 columns the row wrapped (7 rows vs 6).
  for (const columns of [30, 40, 45, 50]) {
    test(`the cwd row fits ${columns} columns`, () => {
      expect(cellWidth(permissionCwdLine("/w", columns))).toBeLessThanOrEqual(columns - 2);
      expect(cellWidth(permissionCwdLine(`/${"d".repeat(80)}`, columns))).toBeLessThanOrEqual(
        columns - 2,
      );
    });
  }

  // The frame from 45 up (below ~46 the pre-existing key-hint footer wraps on its own).
  for (const columns of [45, 50]) {
    test(`never wraps at ${columns} columns: the frame keeps permissionPromptRows`, () => {
      // ink-testing-library's stdout is 100 columns wide: a Box gives Ink the
      // terminal's width, so a too-long row wraps as it would on screen.
      const view = render(
        <Box width={columns} flexDirection="column">
          <PermissionPrompt
            req={REQ}
            options={["Yes", "No"]}
            selected={0}
            cwd="/Users/someone/projects/tentacle"
            columns={columns}
          />
        </Box>,
      );
      expect((view.lastFrame() ?? "").split("\n").length).toBe(permissionPromptRows(2));
      view.unmount();
    });
  }
});
