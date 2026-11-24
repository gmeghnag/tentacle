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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SUMMARISED_TOOLS,
  bodyCommand,
  mcpRowArgs,
  outputView,
  rowSubtitle,
  spokenDuration,
  subAgentLine,
  toolMeta,
  toolName,
  toolSummary,
} from "../src/tool-summary.ts";
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
  // docs/feat/model-charts.md D3: a chart row names the chart, never its spec.
  {
    name: "chart",
    args: '{"type":"line","title":"Ricavi 2026","datasets":[{"label":"R","data":[1]}]}',
    subtitle: "Ricavi 2026",
  },
  // docs/feat/model-diagrams.md D2 (T2.8): a diagram row names the diagram, never its source.
  {
    name: "diagram",
    args: '{"title":"Flusso di login","mermaid":"flowchart TD\\n  A --> B"}',
    subtitle: "Flusso di login",
  },
  { name: "diagram", args: '{"mermaid":"flowchart TD"}', subtitle: '{"mermaid":"flowchart TD"}' },
  // docs/feat/image-view.md T12: the ref, and ` · high` only for the costly detail.
  {
    name: "image_view",
    args: '{"ref":"a1b2c3d4e5f6","detail":"high"}',
    subtitle: "a1b2c3d4e5f6 · high",
  },
  { name: "image_view", args: '{"ref":"a1b2c3d4e5f6"}', subtitle: "a1b2c3d4e5f6" },
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

// ── The guard (main added `chart` to the TUI's switch; the phone's set lagged) ──
// The TUI's `toolSubtitle` cases and `SUMMARISED_TOOLS` are two halves of one
// rule: a name the TUI summarises must reach `subtitleOf` on the phone, or
// `rowSubtitle` flattens its args as MCP JSON. Read the TUI's SOURCE (a static
// import cannot: `render-lines.ts` pulls terminal-only modules, see the header)
// and compare the case labels with the list.
describe("SUMMARISED_TOOLS is the TUI's `toolSubtitle` switch, name for name", () => {
  /** Every `case "x":` inside `toolSubtitle`, in source order. */
  function tuiToolSubtitleCases(): string[] {
    const source = readFileSync(RENDER_LINES, "utf8");
    const start = source.indexOf("function toolSubtitle(");
    const end = source.indexOf("\nfunction commandRows(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    return [...body.matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1] ?? "");
  }

  test("the TUI's cases are found (the scan is not vacuous)", () => {
    expect(tuiToolSubtitleCases()).toContain("shell");
    expect(tuiToolSubtitleCases()).toContain("chart");
  });

  test("a `toolSubtitle` case missing from SUMMARISED_TOOLS fails here", () => {
    expect([...SUMMARISED_TOOLS].sort()).toEqual([...new Set(tuiToolSubtitleCases())].sort());
  });

  test("every summarised tool reaches its TUI subtitle, never the MCP flattening", () => {
    // Args no `subtitleOf` case reads, so the switch says "" (a chart says its
    // raw args) while `mcpRowArgs` would say `zzz 1` — equal means the name was
    // routed to the MCP flattening, i.e. missing from the set.
    const args = '{"zzz":1}';
    const flattened = mcpRowArgs(args);
    for (const name of SUMMARISED_TOOLS) {
      expect(rowSubtitle(name, args)).not.toBe(flattened);
    }
  });
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

describe("toolMeta: the row's status icon tone and trailing text (Slice 3 ToolRow)", () => {
  const diff = { kind: "diff", path: "a.ts", patch: "", added: 3, removed: 5 } as const;

  test("each status maps to one tone (denied reads as an error)", () => {
    expect(toolMeta({ status: "ok" }).tone).toBe("ok");
    expect(toolMeta({ status: "error" }).tone).toBe("error");
    expect(toolMeta({ status: "denied" }).tone).toBe("error");
    expect(toolMeta({ status: "running" }).tone).toBe("running");
    expect(toolMeta({ status: "queued" }).tone).toBe("pending");
  });

  test("a diff shows its counts, ahead of any duration", () => {
    expect(toolMeta({ status: "ok", diff, durationMs: 1200 }).trailing).toBe("+3 −5");
  });

  test("a duration reads in ms under a second, then seconds, then minutes", () => {
    expect(toolMeta({ status: "ok", durationMs: 42.4 }).trailing).toBe("42 ms");
    expect(toolMeta({ status: "ok", durationMs: 1250 }).trailing).toBe("1.3 s");
    expect(toolMeta({ status: "ok", durationMs: 125_000 }).trailing).toBe("2 min 5 s");
  });

  test("denied says so; nothing known says nothing (no invented exit code)", () => {
    expect(toolMeta({ status: "denied" }).trailing).toBe("denied");
    expect(toolMeta({ status: "running" }).trailing).toBe("");
  });
});

describe("the Agent card's progress line (docs/fix/mobile-chat-glitches.md item 10, Owner Q2: TUI parity)", () => {
  const base = { activities: [], toolUses: 0, tokens: 0, done: false } as const;

  test("running: `<last activity> · <N> tool uses` (tokens hidden)", () => {
    expect(
      subAgentLine({
        ...base,
        activities: ["agent_notify", "shell: sleep 10"],
        toolUses: 3,
        tokens: 940,
      }),
    ).toBe("shell: sleep 10 · 3 tool uses");
    expect(subAgentLine({ ...base, activities: ["Read a.ts"], toolUses: 1 })).toBe(
      "Read a.ts · 1 tool use",
    );
    expect(subAgentLine(base)).toBe("0 tool uses");
  });

  test("done: `Done · <N> tool uses`; moved: `Moved to background · sa-N`", () => {
    expect(subAgentLine({ ...base, toolUses: 2, done: true, stopReason: "end_turn" })).toBe(
      "Done · 2 tool uses",
    );
    expect(
      subAgentLine({ ...base, toolUses: 1, done: true, stopReason: "background", movedTo: "sa-3" }),
    ).toBe("Moved to background · sa-3");
  });

  test("no sub-agent → no line", () => {
    expect(subAgentLine(undefined)).toBeNull();
  });

  test("the spinner stops at `done` (the call's own result may come a moment later)", () => {
    expect(toolMeta({ status: "running", sub: { ...base, done: false } }).tone).toBe("running");
    expect(toolMeta({ status: "running", sub: { ...base, done: true } }).tone).toBe("ok");
    // A failed call still says so.
    expect(toolMeta({ status: "error", sub: { ...base, done: true } }).tone).toBe("error");
  });
});

// ── mobile-tool-rows S1: what one STEP says (docs/feat/mobile-tool-rows.md §Design 1) ──

describe("toolName: the step's name, an MCP server split off", () => {
  test("a built-in keeps its label", () => {
    expect(toolName("shell", "Bash")).toEqual({ tool: "Bash" });
    expect(toolName("fs_read", "Read")).toEqual({ tool: "Read" });
  });

  test("mcp__<server>__<tool> → server + the tool name exactly (Owner Q5)", () => {
    const name = "mcp__playwright__browser_resize";
    expect(toolName(name, name)).toEqual({ server: "playwright", tool: "browser_resize" });
    // Split on the FIRST `__` after the prefix: the tool part keeps its own.
    expect(toolName("mcp__a__b__c", "mcp__a__b__c")).toEqual({ server: "a", tool: "b__c" });
  });

  test("odd MCP names fall back to the raw label, never an empty name", () => {
    for (const name of ["mcp__", "mcp__x", "mcp____y", "mcp__x__"]) {
      expect(toolName(name, name)).toEqual({ tool: name });
    }
  });
});

describe("rowSubtitle: the ONE line on a step", () => {
  test("fs_* → the basename (Owner Q4)", () => {
    const read = '{"path":"packages/daemon/test/persist.test.ts"}';
    expect(rowSubtitle("fs_read", read)).toBe("persist.test.ts");
    expect(rowSubtitle("fs_write", '{"path":"/abs/dir/a.ts","content":"x"}')).toBe("a.ts");
    expect(rowSubtitle("fs_edit", '{"path":"a.ts","old":"x","new":"y"}')).toBe("a.ts");
  });

  test("a ranged read by offset/limit → `· A–B` (1-based, as fs_read reads it)", () => {
    const ranged = '{"path":"src/persist.test.ts","offset":1,"limit":120}';
    expect(rowSubtitle("fs_read", ranged)).toBe("persist.test.ts · 1–120");
    expect(rowSubtitle("fs_read", '{"path":"a.ts","offset":40}')).toBe("a.ts · 40–");
    expect(rowSubtitle("fs_read", '{"path":"a.ts","limit":30}')).toBe("a.ts · 1–30");
  });

  test("a ranged read by a `:start:end` suffix", () => {
    expect(rowSubtitle("fs_read", '{"path":"src/a.ts:10:20"}')).toBe("a.ts · 10–20");
    expect(rowSubtitle("fs_read", '{"path":"src/a.ts:10"}')).toBe("a.ts · 10–");
  });

  test("multi-edit keeps its count", () => {
    const args = '{"path":"src/a.ts","edits":[{},{},{}]}';
    expect(rowSubtitle("fs_multi_edit", args)).toBe("a.ts · 3 edits");
  });

  test("shell, search, jobs, agents, skill: the TUI subtitle, unchanged", () => {
    const tui = CASES.filter((c) => !c.name.startsWith("fs_") && c.name !== "mystery_tool");
    expect(tui.length).toBeGreaterThan(5);
    for (const c of tui) {
      expect(rowSubtitle(c.name, c.args)).toBe(c.subtitle);
    }
  });

  test("MCP and unknown tools never show raw JSON", () => {
    const size = '{"width":430,"height":932}';
    expect(rowSubtitle("mcp__playwright__browser_resize", size)).toBe("430 × 932");
    expect(rowSubtitle("plugin_tool", '{"query":"tentacle"}')).toBe("tentacle");
  });
});

describe("mcpRowArgs: the four rules (Owner Q6)", () => {
  test("1. not a JSON object → the raw text flattened to one line", () => {
    expect(mcpRowArgs("raw\targs\n  on two lines")).toBe("raw args on two lines");
    expect(mcpRowArgs('{"url":"http')).toBe('{"url":"http');
    expect(mcpRowArgs("[1,2]")).toBe("[1,2]");
  });

  test("2. numeric width + height → `W × H`", () => {
    expect(mcpRowArgs('{"width":430,"height":932}')).toBe("430 × 932");
    // A string width is not a size: the flattened pairs instead.
    expect(mcpRowArgs('{"width":"430","height":932}')).toBe("width 430 · height 932");
  });

  test("3. the first primary key, a path or filename as its basename", () => {
    const shot = '{"type":"png","filename":"/Users/me/shots/polpo-page.png"}';
    expect(mcpRowArgs(shot)).toBe("polpo-page.png");
    expect(mcpRowArgs('{"selector":"#go","url":"https://x.dev/a"}')).toBe("https://x.dev/a");
    expect(mcpRowArgs('{"element":"Submit button","ref":"e12"}')).toBe("Submit button");
  });

  test("4. flattened: true → the key, false/null dropped, nested → `key …`", () => {
    expect(mcpRowArgs('{"fullPage":true}')).toBe("fullPage");
    const mixed = '{"scale":"device","filename":{"dir":"x"},"raw":false,"x":null}';
    expect(mcpRowArgs(mixed)).toBe("scale device · filename …");
    expect(mcpRowArgs('{"count":3,"items":[1]}')).toBe("count 3 · items …");
    expect(mcpRowArgs("{}")).toBe("");
  });
});

describe("bodyCommand: what the open body shows as the command", () => {
  test("a TUI-summarised tool → its full subtitle; a multi-line command keeps its lines", () => {
    const multi = '{"command":"cd x &&\\n  bun test"}';
    expect(bodyCommand("shell", multi)).toEqual(["cd x &&", "  bun test"]);
    const read = '{"path":"packages/a/b.ts","offset":3}';
    expect(bodyCommand("fs_read", read)).toEqual(["packages/a/b.ts"]);
  });

  test("nothing beyond the row → []", () => {
    expect(bodyCommand("shell_kill", '{"job_id":"bg-1"}')).toEqual([]);
    expect(bodyCommand("shell", "{}")).toEqual([]);
    expect(bodyCommand("mcp__x__y", "{}")).toEqual([]);
  });

  test("MCP → one `key  value` line per leaf, nested keys dotted", () => {
    const args = '{"url":"https://a","opts":{"wait":true,"tags":["a","b"]},"n":null}';
    expect(bodyCommand("mcp__x__y", args)).toEqual([
      "url  https://a",
      "opts.wait  true",
      "opts.tags[0]  a",
      "opts.tags[1]  b",
      "n  null",
    ]);
  });

  test("non-JSON MCP args → the raw lines", () => {
    expect(bodyCommand("mcp__x__y", "line one\nline two")).toEqual(["line one", "line two"]);
  });

  test("capped at 20 leaves, then `… +N more`", () => {
    const obj = (n: number): string =>
      JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i])));
    const lines = bodyCommand("mcp__x__y", obj(25));
    expect(lines).toHaveLength(21);
    expect(lines[19]).toBe("k19  19");
    expect(lines[20]).toBe("… +5 more");
    expect(bodyCommand("mcp__x__y", obj(20))).toHaveLength(20);
  });
});

describe("outputView: the TUI's cut (Owner Q8)", () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n");

  test("8 lines → whole", () => {
    const view = outputView(lines(8), { full: false, error: false });
    expect(view).toEqual({ lines: lines(8).split("\n"), hidden: 0, error: false });
  });

  test("9 lines → the TAIL (last 6) + 3 earlier lines hidden", () => {
    const view = outputView(lines(9), { full: false, error: false });
    expect(view.lines).toEqual(["l4", "l5", "l6", "l7", "l8", "l9"]);
    expect(view.hidden).toBe(3);
  });

  test("a long log keeps its last lines; hidden counts the skipped head", () => {
    const view = outputView(lines(400), { full: false, error: false });
    expect(view.lines).toEqual(["l395", "l396", "l397", "l398", "l399", "l400"]);
    expect(view.hidden).toBe(394);
  });

  test("full → whole", () => {
    const view = outputView(lines(30), { full: true, error: false });
    expect(view.lines).toHaveLength(30);
    expect(view.hidden).toBe(0);
  });

  test("trailing newlines trimmed, escapes stripped, the error flag carried", () => {
    const view = outputView("\u001b[31mboom\u001b[0m\n\n", { full: false, error: true });
    expect(view).toEqual({ lines: ["boom"], hidden: 0, error: true });
    expect(outputView("", { full: false, error: false }).lines).toEqual([]);
  });
});

describe("spokenDuration: for VoiceOver", () => {
  test("milliseconds, seconds, minutes, singular when one", () => {
    expect(spokenDuration(14)).toBe("14 milliseconds");
    expect(spokenDuration(1)).toBe("1 millisecond");
    expect(spokenDuration(1300)).toBe("1.3 seconds");
    expect(spokenDuration(125_000)).toBe("2 minutes 5 seconds");
    expect(spokenDuration(61_000)).toBe("1 minute 1 second");
    expect(spokenDuration(120_000)).toBe("2 minutes");
  });
});
