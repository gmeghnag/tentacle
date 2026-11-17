/**
 * fix/tui-diagram-complex-flow: a REAL diagram (the owner's screenshot) draws.
 *
 * The screenshot's flowchart — a `subgraph` with an id and a long title, 22
 * nodes, two back edges, `<br/>` labels, `[[ ]]` subroutines, edge labels,
 * Unicode, ~200 columns — came back as `source only in the terminal`, because
 * `drawFlow` bailed (`drawFrames`: no clear stretch on a frame's border long
 * enough for its title). DeepSeek's simpler flowchart drew.
 *
 * The properties here: it DRAWS at a realistic width (and the frame keeps an
 * honest, truncated title), multi-line labels keep their lines, and a genuine
 * refusal says why in a few words instead of the bare "source only".
 */
import { describe, expect, test } from "bun:test";
import { cellWidth } from "../src/cells.ts";
import { type FlowDrawing, drawFlow } from "../src/diagram-ascii-flow.ts";
import { rowText } from "../src/diagram-canvas.ts";
import { diagramToolBody } from "../src/diagram-lines.ts";
import { TRANSFORMER, args, flowOf } from "./diagram-fixtures.ts";

const PICTO = /\p{Extended_Pictographic}/u;
const text = (d: FlowDrawing | undefined): string => d?.rows.map(rowText).join("\n") ?? "";

describe("the owner's transformer flowchart draws", () => {
  test("at 200 cols it is a drawing, not the source", () => {
    const out = diagramToolBody(args("Il viaggio di un token", TRANSFORMER), {
      width: 200,
      color: false,
    });
    expect(out).toBeDefined();
    const rows = [...(out ?? [])];
    expect(rows[0]).toContain("Il viaggio di un token · flowchart");
    expect(rows[0]).not.toContain("source only");
    expect(rows.join("\n")).toContain("╭");
    expect(rows.join("\n")).toContain("▼");
    // the compact tier shows no source line
    expect(rows.join("\n")).not.toContain("flowchart TD");
  });

  test("every box is drawn once, inside the width, with no emoji glyph", () => {
    const model = flowOf(TRANSFORMER);
    const d = drawFlow(model, 200);
    expect(d).toBeDefined();
    if (d === undefined) return;
    expect(d.boxes).toHaveLength(model.nodes.length);
    expect(d.width).toBeLessThanOrEqual(200);
    for (const row of d.rows) expect(cellWidth(rowText(row))).toBeLessThanOrEqual(d.width);
    for (const row of d.rows) expect(PICTO.test(rowText(row))).toBe(false);
  });

  test("the frame keeps an honest title — truncated, never dropped", () => {
    const d = drawFlow(flowOf(TRANSFORMER), 200);
    const rows = text(d).split("\n");
    const titled = rows.filter((row) => row.includes("Blocco Transformer"));
    expect(titled).toHaveLength(1);
    // it sits ON a border (top `╭` or bottom `╰`), shortened with a `…`
    expect(titled[0]).toMatch(/^[╭╰]─.*Blocco Transformer.*…/);
  });

  test("a `<br/>` label is several rows in one box", () => {
    const d = drawFlow(flowOf(TRANSFORMER), 200);
    const rows = text(d).split("\n");
    expect(rows.some((row) => row.includes("Token in ingresso"))).toBe(true);
    expect(rows.some((row) => row.includes("(es. 'ciao')"))).toBe(true);
    expect(text(d)).not.toContain("<br");
  });

  test("the two back edges are drawn: every arrow reaches its box", () => {
    const model = flowOf(TRANSFORMER);
    const d = drawFlow(model, 200);
    const rows = text(d).split("\n");
    // `OUT -.-> IN`: a return run along the side, from the bottom back to the top
    expect(rows.join("\n")).toContain("re-iniettato come nuovo token");
    // `ADD2 -->|strati 1 .. N-1| LN1`: the loop inside/into the frame
    expect(rows.join("\n")).toContain("strati 1 .. N-1");
    expect(rows.join("\n")).toContain("dopo lo strato N");
  });
});

describe("the same diagram at narrow widths: an honest degrade, never a crash", () => {
  test("80 cols: the source, and the caption says WHY", () => {
    const out = diagramToolBody(args("Token", TRANSFORMER), { width: 80, color: false });
    expect(out).toBeDefined();
    const rows = [...(out ?? [])];
    expect(rows[0]).toContain("Token · flowchart · too wide for 80 cols");
    expect(rows[0]).toContain("^X^O"); // the reader's next move
    expect(rows.join("\n")).not.toContain("╭─ Blocco"); // no half drawing
    expect(rows.join("\n")).toContain("flowchart TD"); // the source instead
  });

  test("no row is wider than the width, at every width, compact and expanded", () => {
    let drew = 0;
    for (let width = 40; width <= 220; width += 13) {
      for (const expanded of [false, true]) {
        const out = diagramToolBody(args("Token", TRANSFORMER), { width, expanded, color: false });
        if (out?.some((line) => line.trimStart().startsWith("╭"))) drew++;
        for (const line of out ?? [])
          expect({ width, over: cellWidth(line) > width }).toEqual({ width, over: false });
      }
    }
    // the sweep must not be vacuous: it draws at the wide end
    expect(drew).toBeGreaterThan(0);
  });

  test("a flowchart's refusal never reads the bare 'source only'", () => {
    for (const width of [30, 50, 80, 150]) {
      const caption = [
        ...(diagramToolBody(args("Token", TRANSFORMER), { width, color: false }) ?? []),
      ][0];
      expect({ width, bare: caption?.includes("source only in the terminal") }).toEqual({
        width,
        bare: false,
      });
    }
  });
});

describe("a wrapped / multi-line box", () => {
  test("a long single-line label wraps inside the box instead of widening it", () => {
    const long = `flowchart TD\n  A["${"parola ".repeat(20).trim()}"] --> B[Fine]`;
    const d = drawFlow(flowOf(long), 120);
    expect(d).toBeDefined();
    if (d === undefined) return;
    const box = d.boxes.find((b) => b.id === "A");
    expect(box?.width).toBeLessThanOrEqual(120);
    // several label rows: the box is taller than the 3-row minimum
    expect(box?.height).toBeGreaterThan(3);
    // every word survives the wrap
    const all = text(d).replace(/\s+/g, " ");
    expect(all.split("parola").length - 1).toBe(20);
  });

  // Review round 1, HIGH: in LR/RL the box's HEIGHT is its cross size, and
  // `sizeVertex` kept that at the 3-row minimum while `drawBox` stacked every
  // label row — so the first and last row of the label were painted over the
  // top and bottom borders. Same bug class as TD, different axis.
  test("a sideways (LR) box is tall enough for every label row", () => {
    const cases = [
      // a `<br/>` label: 3 rows in a box that was 3 rows tall
      { src: 'flowchart LR\n  A["uno<br/>due<br/>tre"] --> B[fine]', words: ["uno", "due", "tre"] },
      // a wrapped single-line label (one wide box before this branch)
      {
        src: `flowchart LR\n  A["${"parola ".repeat(20).trim()}"] --> B[fine]`,
        words: ["parola"],
      },
    ];
    for (const { src, words } of cases) {
      const d = drawFlow(flowOf(src), 200);
      expect(d).toBeDefined();
      if (d === undefined) return;
      const box = d.boxes.find((b) => b.id === "A");
      expect(box).toBeDefined();
      if (box === undefined) return;
      const own = text(d)
        .split("\n")
        .slice(box.row, box.row + box.height)
        .map((line) => line.slice(box.col, box.col + box.width));
      // the box's outer rows are BORDERS: inside the corners, only border glyphs
      expect(own[0]).toMatch(/^[╭╮][─┬┴┼]*[╭╮]$/);
      expect(own[own.length - 1]).toMatch(/^[╰╯][─┬┴┼]*[╰╯]$/);
      // and the label's rows are strictly between them, all of it visible
      const inner = own.slice(1, -1).join(" ");
      for (const word of words) expect(inner).toContain(word);
    }
  });

  test("a `[[ ]]` subroutine keeps its brackets around the label", () => {
    const d = drawFlow(flowOf(TRANSFORMER), 200);
    expect(text(d)).toContain("[+ residuo (skip connection)]");
  });

  test("an empty label row never collapses (a blank `<Text>` measures 0×0)", () => {
    // `A["<br/>"]` has no line with text: the box still draws one row
    const d = drawFlow(flowOf('flowchart TD\n  A["<br/>"] --> B[Fine]'), 120);
    expect(d).toBeDefined();
    if (d === undefined) return;
    const box = d.boxes.find((b) => b.id === "A");
    expect(box?.height).toBe(3);
  });
});
