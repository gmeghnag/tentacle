/** The queued/running phase of a tool row (T-UI, docs/feat/parallel-tools.md). */
import { describe, expect, test } from "bun:test";
import { itemLines, stripAnsi, toolTitle } from "../src/render-lines.ts";
import { type DisplayState, type ToolItem, applyEvent, initialState } from "../src/state.ts";
import { nextToolStatus, queuedRow } from "../src/tool-phase-view.ts";

describe("nextToolStatus (pure)", () => {
  test("queued moves running → queued; running moves queued → running", () => {
    expect(nextToolStatus("running", "queued")).toBe("queued");
    expect(nextToolStatus("queued", "running")).toBe("running");
  });
  test("a settled row never moves; a stale move is ignored", () => {
    for (const phase of ["queued", "running"] as const) {
      expect(nextToolStatus("ok", phase)).toBe("ok");
      expect(nextToolStatus("error", phase)).toBe("error");
    }
    expect(nextToolStatus("running", "running")).toBe("running");
    expect(nextToolStatus("queued", "queued")).toBe("queued");
  });
});

describe("queuedRow (pure)", () => {
  test("◌ <tool> <arg> · queued", () => {
    const tool: ToolItem = {
      kind: "tool",
      id: "c1",
      name: "fs_read",
      args: '{"path":"a.ts"}',
      status: "queued",
    };
    const row = queuedRow(toolTitle(tool));
    expect(row.glyph).toBe("◌");
    expect(row.suffix).toBe("· queued");
    expect(`${row.glyph} ${row.label} ${row.subtitle} ${row.suffix}`).toBe("◌ Read a.ts · queued");
  });
});

describe("applyEvent: tool_phase", () => {
  const started = (): DisplayState =>
    applyEvent(
      initialState,
      { type: "tool_start", id: "c1", name: "fs_read", arguments: '{"path":"a.ts"}' },
      0,
    );
  const statusOf = (s: DisplayState, id = "c1") =>
    s.items.flatMap((i) => (i.kind === "tool" && i.id === id ? [i.status] : []));

  test("queued, then running, then the result settles it", () => {
    let s = applyEvent(started(), { type: "tool_phase", id: "c1", phase: "queued" }, 1);
    expect(statusOf(s)).toEqual(["queued"]);
    s = applyEvent(s, { type: "tool_phase", id: "c1", phase: "running" }, 2);
    expect(statusOf(s)).toEqual(["running"]);
    s = applyEvent(
      s,
      { type: "tool_result", id: "c1", name: "fs_read", result: { content: "x" } },
      3,
    );
    s = applyEvent(s, { type: "tool_phase", id: "c1", phase: "queued" }, 4);
    expect(statusOf(s)).toEqual(["ok"]);
  });

  test("a queued row settles straight from its result (cancelled, never started)", () => {
    let s = applyEvent(started(), { type: "tool_phase", id: "c1", phase: "queued" }, 1);
    s = applyEvent(
      s,
      {
        type: "tool_result",
        id: "c1",
        name: "fs_read",
        result: { content: "Cancelled", isError: true },
      },
      2,
    );
    expect(statusOf(s)).toEqual(["error"]);
  });

  test("rendered rows: queued (one dim row, no body), then running…, then the result", () => {
    let s = applyEvent(started(), { type: "tool_phase", id: "c1", phase: "queued" }, 1);
    const rows = (state: DisplayState) =>
      state.items.flatMap((i) =>
        i.kind === "tool" ? itemLines(i, { width: 80, expandAll: false }).map(stripAnsi) : [],
      );
    expect(rows(s)).toEqual(["◌ Read a.ts · queued"]);
    s = applyEvent(s, { type: "tool_phase", id: "c1", phase: "running" }, 2);
    expect(rows(s)).toEqual(["⏺ Read a.ts", "⎿ running…"]);
    s = applyEvent(
      s,
      { type: "tool_result", id: "c1", name: "fs_read", result: { content: "x" } },
      3,
    );
    expect(rows(s)[0]).toBe("⏺ Read a.ts");
    expect(rows(s)).not.toContain("⎿ running…");
  });

  test("an unknown id creates nothing (a pod is not trusted)", () => {
    const s0 = started();
    const s = applyEvent(s0, { type: "tool_phase", id: "nope", phase: "queued" }, 1);
    expect(s.items).toEqual(s0.items);
  });
});
