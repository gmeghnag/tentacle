/**
 * `toolSummary` (B3): a tool row shows the call's primary target — the TUI's
 * `toolTitle` subtitle rule — never the raw JSON arguments, and its output with
 * terminal escapes stripped.
 *
 * The TUI import is TEST-ONLY and relative (the app bundle never carries
 * `@tentacle/tui`, plan P8 — the `transcript-parity.test.ts` pattern): if the
 * phone's subtitle drifts from the TUI's, the parity case fails.
 *
 * `render-lines.ts` is loaded by a COMPUTED path: a static import would pull the
 * TUI's terminal-only modules (`marked-terminal`, …) into `tsc -p apps/mobile`,
 * which cannot type them. The runtime parity is the same; `TuiToolTitle` is the
 * one signature this test relies on.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { toolSummary } from "../src/tool-summary.ts";
import { type State, type ToolRow, apply, initialState } from "../src/transcript.ts";

type TuiToolTitle = (tool: {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly args: string;
  readonly status: "running";
}) => { readonly label: string; readonly subtitle: string };

const RENDER_LINES = join(import.meta.dir, "../../../packages/tui/src/render-lines.ts");
const { toolTitle } = (await import(RENDER_LINES)) as { readonly toolTitle: TuiToolTitle };

/** A tool call through the app's own fold: the row the screen draws. */
function foldedTool(name: string, args: string, output?: string): ToolRow {
  const inputs: Parameters<typeof apply>[1][] = [
    { type: "turn_started", turnId: "t", own: true },
    { type: "tool_start", id: "c1", name, arguments: args },
  ];
  if (output !== undefined) {
    inputs.push({ type: "tool_result", id: "c1", name, result: { content: output } });
  }
  const state = inputs.reduce<State>((s, input) => apply(s, input), initialState);
  const row = state.rows[0];
  if (row?.kind !== "tool") {
    throw new Error("expected a tool row");
  }
  return row;
}

const CASES: readonly {
  readonly name: string;
  readonly args: string;
  readonly subtitle: string;
}[] = [
  { name: "shell", args: '{"command":"bun test packages/tui"}', subtitle: "bun test packages/tui" },
  { name: "fs_read", args: '{"path":"src/App.tsx"}', subtitle: "src/App.tsx" },
  { name: "fs_edit", args: '{"path":"a.ts","old":"x","new":"y"}', subtitle: "a.ts" },
  {
    name: "fs_multi_edit",
    args: '{"path":"a.ts","edits":[{},{}]}',
    subtitle: "a.ts · 2 edits",
  },
  { name: "search", args: '{"pattern":"TODO","path":"src"}', subtitle: "TODO in src" },
  { name: "search", args: '{"glob":"*.ts"}', subtitle: "*.ts in ." },
  { name: "shell_output", args: '{"job_id":"j1"}', subtitle: "j1" },
  { name: "agent_control", args: '{"action":"kill","agent_id":"a2"}', subtitle: "kill a2" },
  { name: "skill", args: '{"name":"review"}', subtitle: "review" },
  { name: "shell", args: "not json at all", subtitle: "" },
  { name: "mystery_tool", args: "raw args", subtitle: "raw args" },
];

describe("the subtitle is the call's target, not its JSON", () => {
  test('shell → the command (the owner\'s report: no `{"command":…}`)', () => {
    const row = foldedTool("shell", '{"command":"bun test"}');
    expect(toolSummary(row).subtitle).toBe("bun test");
    expect(toolSummary(row).label).toBe("Bash");
  });

  test("fs_* → the path; search → `pattern in path`", () => {
    expect(toolSummary(foldedTool("fs_write", '{"path":"b.md","content":"…"}')).subtitle).toBe(
      "b.md",
    );
    expect(toolSummary(foldedTool("search", '{"pattern":"foo","path":"lib"}')).subtitle).toBe(
      "foo in lib",
    );
  });

  test("args that are not JSON fall back to the raw string, as in the TUI", () => {
    expect(toolSummary(foldedTool("mystery_tool", "plain words")).subtitle).toBe("plain words");
  });

  test("escapes in a raw fallback are stripped", () => {
    expect(toolSummary(foldedTool("mystery_tool", "\u001b[31mred\u001b[0m")).subtitle).toBe("red");
  });

  for (const c of CASES) {
    test(`parity with the TUI's toolTitle: ${c.name} ${c.args}`, () => {
      const row = foldedTool(c.name, c.args);
      const tui: Parameters<TuiToolTitle>[0] = {
        kind: "tool",
        id: "c1",
        name: c.name,
        args: c.args,
        status: "running",
      };
      expect(toolSummary(row).subtitle).toBe(c.subtitle);
      expect(toolSummary(row).subtitle).toBe(toolTitle(tui).subtitle);
      expect(toolSummary(row).label).toBe(toolTitle(tui).label);
    });
  }
});

describe("the output", () => {
  test("terminal escapes are stripped from what the row shows", () => {
    const row = foldedTool("shell", '{"command":"bun test"}', "\u001b[32mPASS\u001b[0m 3 tests");
    expect(toolSummary(row).output).toBe("PASS 3 tests");
  });

  test("no output is the empty string", () => {
    expect(toolSummary(foldedTool("shell", '{"command":"ls"}')).output).toBe("");
  });
});
