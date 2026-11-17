/**
 * D4 (docs/feat/model-diagrams.md): a `diagram` tool call draws ITSELF in the
 * row's place through `render-lines` — the sibling of the chart block in
 * `render-lines.test.ts`, and the narrow seam the App-level frames
 * (`app-diagram.test.tsx`) ride on.
 */
import { describe, expect, spyOn, test } from "bun:test";
import stringWidth from "string-width";
import { itemLines } from "../src/render-lines.ts";
import type { ToolItem } from "../src/state.ts";
import { LOGIN, args } from "./diagram-fixtures.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const BOX = "╭";

const diagramTool = (extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id: "d1",
  name: "diagram",
  args: args("Flusso di login", LOGIN),
  status: "ok",
  ...extra,
});

const rowsOf = (item: ToolItem, width = 120, extra: object = {}): string[] =>
  itemLines(item, { expandAll: false, width, ...extra }).map(strip);

describe("a diagram in the transcript (D4)", () => {
  test("the row IS the diagram: no tool chrome, and title · type is its caption", () => {
    // Mutation: drop the `diagramRow` branch in `toolLines` → `● Diagram …`.
    const rows = rowsOf(diagramTool());
    const text = rows.join("\n");
    expect(text).not.toContain("●");
    expect(text).not.toContain("⎿");
    expect(rows[0]?.trimEnd()).toContain("Flusso di login · flowchart");
    expect(text).toContain(BOX);
    expect(text).toContain("◇"); // the decision mark
    expect(text).not.toContain("A[Richiesta]"); // compact: no source
  });

  test("ctrl+o expands it to the drawing + the whole source", () => {
    // Mutation: pass `expanded: false` to `diagramToolBody` → no source rows.
    const compact = rowsOf(diagramTool());
    const expanded = rowsOf(diagramTool(), 120, { expandAll: true });
    expect(expanded.length).toBeGreaterThan(compact.length);
    expect(expanded.join("\n")).toContain(BOX);
    const source = expanded.filter((r) => r.trimStart().startsWith("│ ")).join("\n");
    expect(source).toContain("A[Richiesta] --> B{Token valido?}");
    expect(source).toContain("E[(Database utenti)]");
  });

  test("a click on its caption expands it (expandedIds)", () => {
    // The per-id expand the other calls use: the caption is row 0, so the click
    // target and the drawing agree by construction (`tool-hit.ts`).
    const clicked = rowsOf(diagramTool(), 120, { expandedIds: ["d1"] });
    const expanded = rowsOf(diagramTool(), 120, { expandAll: true });
    expect(clicked).toEqual(expanded);
  });

  test("the width is part of the memo key: a resize re-lays it out", () => {
    // Mutation: drop `width` from `diagramRow`'s key → the wide drawing (or its
    // source fallback) survives a width change.
    const wide = `flowchart TD
  A[Richiesta di autenticazione con token] --> B{Il token è valido?}
  B -- sì --> C[Carica la sessione dell'utente]
  B -- no --> D[Mostra la pagina di login]
  D --> E[(Database degli utenti)]
  C --> F[Risposta]
  E --> G[Log delle sessioni]
  F --> G`;
    const item = diagramTool({ args: args("Autenticazione", wide) });
    const at120 = rowsOf(item, 120).join("\n");
    const at50 = rowsOf(item, 50).join("\n");
    expect(at120).toContain(BOX);
    expect(at120).not.toContain("source only");
    expect(at50).toContain("source only");
    expect(at50).not.toContain(BOX);
    // …and back again, on the SAME item (the memo must not pin the first tier).
    expect(rowsOf(item, 120).join("\n")).toContain(BOX);
  });

  test("an invalid (forged) source falls back to the generic row, never a crash", () => {
    // Mutation: draw whatever `diagramModel` makes of the text (skip
    // `parseDiagramArgs`) → the row is drawn instead of `● Diagram`.
    for (const raw of [
      args("Grafico", "grpah TD\n  A --> B"), // unknown type line
      args("Grafico", ""), // empty
      args("", LOGIN), // no title
      '{"title":"T"}', // no source
      "not json",
      "",
    ]) {
      const rows = rowsOf(diagramTool({ args: raw }));
      expect(rows[0]).toContain("●");
      expect(rows.join("\n")).not.toContain(BOX);
    }
  });

  test("a running or queued diagram keeps the generic row (no args yet to draw)", () => {
    // Mutation: drop the `running` guard in `diagramRow` → a half row drawn from
    // args that may not exist yet.
    for (const status of ["running", "queued"] as const) {
      const rows = rowsOf(diagramTool({ status }));
      expect(rows[0]).toContain("Diagram");
      expect(rows[0]).toContain("Flusso di login"); // the subtitle, not a caption
      expect(rows.join("\n")).not.toContain(BOX);
    }
  });

  test("every OTHER tool keeps its own row (the branch is the diagram's alone)", () => {
    // Mutation: drop the `tool.name !== DIAGRAM_TOOL` guard → every call is
    // handed to the diagram renderer (a `shell` call loses its label).
    const shell: ToolItem = {
      kind: "tool",
      id: "s1",
      name: "shell",
      args: '{"command":"ls -la"}',
      status: "ok",
    };
    const rows = rowsOf(shell);
    expect(rows[0]).toContain("● Bash");
    expect(rows[0]).toContain("ls -la");
    expect(rows.join("\n")).not.toContain(BOX);
    // …and a tool whose args are diagram-shaped (an MCP server's `draw`) is
    // still not the diagram tool: the NAME decides.
    const impostor: ToolItem = { ...shell, id: "s2", name: "draw", args: args("T", LOGIN) };
    const drawn = rowsOf(impostor);
    expect(drawn[0]).toContain("●");
    expect(drawn.join("\n")).not.toContain(BOX);
  });

  test("every row fits the width, at every tier", () => {
    for (const width of [120, 100, 80, 60, 50, 40, 30, 20]) {
      for (const expanded of [false, true]) {
        const rows = rowsOf(diagramTool(), width, { expandAll: expanded });
        for (const row of rows) {
          expect(stringWidth(row)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  test("nothing is written to process.stdout while a diagram row is built (AGENTS §7)", () => {
    // Mutation: a `process.stdout.write` inside the branch → this fails.
    const spy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      rowsOf(diagramTool());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
