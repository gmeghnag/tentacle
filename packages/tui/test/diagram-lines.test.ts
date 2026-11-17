/**
 * T3 (docs/feat/model-diagrams.md): the TUI's ASCII diagrams — snapshots of the
 * mockup diagrams, then the properties the plan names (width, connected edges,
 * no overlap, labels once, tiers, NO_COLOR, glyph audit, CJK).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { cellWidth } from "../src/cells.ts";
import { type FlowDrawing, drawFlow } from "../src/diagram-ascii-flow.ts";
import { drawSequence } from "../src/diagram-ascii-seq.ts";
import { rowText } from "../src/diagram-canvas.ts";
import { highlightMermaidLine } from "../src/diagram-highlight.ts";
import { DIAGRAM_SOURCE_PREVIEW, diagramToolBody } from "../src/diagram-lines.ts";
import {
  CJK,
  CLASSES,
  LOGIN,
  LOOP,
  PHONE,
  SUBGRAPH,
  args,
  flowOf,
  randomFlow,
  sequenceOf,
} from "./diagram-fixtures.ts";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const strip = (s: string): string => s.replace(ANSI, "");
const PICTO = /\p{Extended_Pictographic}/u;

function plain(src: string, width: number, expanded = false): string[] {
  const out = diagramToolBody(args("Titolo", src), { width, expanded, color: false, mode: "dark" });
  if (out === undefined) throw new Error("refused");
  return [...out];
}

let level: typeof chalk.level;
beforeAll(() => {
  level = chalk.level;
});
afterAll(() => {
  chalk.level = level;
});

describe("T3 frames (snapshots)", () => {
  const cases: [string, string, number, boolean][] = [
    ["login", LOGIN, 120, false],
    ["login", LOGIN, 80, false],
    ["login", LOGIN, 50, false],
    ["login", LOGIN, 80, true],
    ["phone", PHONE, 120, false],
    ["phone", PHONE, 80, false],
    ["phone", PHONE, 49, false],
    ["classes", CLASSES, 80, false],
    ["loop", LOOP, 80, false],
    ["subgraph", SUBGRAPH, 80, false],
  ];
  for (const [name, src, width, expanded] of cases) {
    test(`${name} ${width}${expanded ? " expanded" : ""} — colour off`, () => {
      expect(plain(src, width, expanded).join("\n")).toMatchSnapshot();
    });
  }
  for (const [name, src] of [
    ["login", LOGIN],
    ["phone", PHONE],
  ] as const) {
    test(`${name} 80 — colour on`, () => {
      chalk.level = 3;
      const lines = diagramToolBody(args("Titolo", src), { width: 80, color: true, mode: "dark" });
      chalk.level = level;
      expect(lines?.join("\n")).toMatchSnapshot();
    });
  }

  test("5A: the login flowchart reads as the mockup (structure, not pixels)", () => {
    const text = plain(LOGIN, 80).join("\n");
    expect(text).toContain("Titolo · flowchart");
    expect(text).toContain("◇  Token valido?  ◇");
    expect(text).toMatch(/╰─┬─+┬─╯/); // two exits from the decision
    expect(text).toMatch(/│ sì +│ no/); // labels beside their vertical runs
    expect(text).toMatch(/├─+┤/); // the cylinder's lip
  });

  test("6A: the sequence has lifelines, solid calls and dashed replies", () => {
    const text = plain(PHONE, 80).join("\n");
    expect(text).toMatch(/├─+►│/);
    expect(text).toMatch(/│◄╌+┤/);
    expect(text).toContain("╰──┬──╯");
  });
});

describe("T3.1 no line wider than the width", () => {
  const sources = [
    LOGIN,
    PHONE,
    CLASSES,
    LOOP,
    SUBGRAPH,
    CJK,
    ...Array.from({ length: 30 }, (_, i) => randomFlow(i + 1)),
  ];
  test("fuzz 20..200 cols, compact and expanded", () => {
    for (const src of sources) {
      for (let width = 20; width <= 200; width += 9) {
        for (const expanded of [false, true]) {
          const out = diagramToolBody(args("Un titolo abbastanza lungo da tagliare", src), {
            width,
            expanded,
            color: false,
          });
          if (out === undefined) continue; // a random source the lint refuses
          for (const line of out) expect(cellWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});

// ── edge walking (T3.2) ─────────────────────────────────────────────────────

const CONN: Readonly<Record<string, readonly [number, number][]>> = {
  "│": [
    [-1, 0],
    [1, 0],
  ],
  "╎": [
    [-1, 0],
    [1, 0],
  ],
  "┃": [
    [-1, 0],
    [1, 0],
  ],
  "─": [
    [0, -1],
    [0, 1],
  ],
  "╌": [
    [0, -1],
    [0, 1],
  ],
  "━": [
    [0, -1],
    [0, 1],
  ],
  "╭": [
    [1, 0],
    [0, 1],
  ],
  "╮": [
    [1, 0],
    [0, -1],
  ],
  "╰": [
    [-1, 0],
    [0, 1],
  ],
  "╯": [
    [-1, 0],
    [0, -1],
  ],
};
const HEAD: Readonly<Record<string, [number, number]>> = {
  "▼": [1, 0],
  "▲": [-1, 0],
  "►": [0, 1],
  "◄": [0, -1],
};

function boxAt(d: FlowDrawing, r: number, c: number): string | undefined {
  for (const b of d.boxes) {
    const inR = r >= b.row && r < b.row + b.height;
    const inC = c >= b.col && c < b.col + b.width;
    const onEdge =
      r === b.row || r === b.row + b.height - 1 || c === b.col || c === b.col + b.width - 1;
    if (inR && inC && onEdge) return b.id;
  }
  return undefined;
}

/** Every arrowhead walked back along the glyphs: `from>to` pairs (the arrow's meaning). */
function walkArrows(d: FlowDrawing): string[] {
  const grid = d.rows.map((row) => [...rowText(row)]);
  // wide graphemes: re-split by cell so columns line up
  const cells = d.rows.map((row) => {
    const out: string[] = [];
    for (const [, text] of row)
      for (const g of text) out.push(g, ...(cellWidth(g) === 2 ? [""] : []));
    return out;
  });
  const at = (r: number, c: number): string => cells[r]?.[c] ?? " ";
  const pairs: string[] = [];
  grid.forEach((_, r) => {
    (cells[r] ?? []).forEach((g, c) => {
      const head = HEAD[g];
      if (head === undefined) return;
      const target = boxAt(d, r + head[0], c + head[1]);
      if (target === undefined) throw new Error(`arrowhead at ${r},${c} does not touch a box`);
      let [dr, dc] = [-head[0], -head[1]];
      let [rr, cc] = [r + dr, c + dc];
      for (let step = 0; step < 10_000; step++) {
        const source = boxAt(d, rr, cc);
        if (source !== undefined) {
          pairs.push(`${source}>${target}`);
          return;
        }
        const glyph = at(rr, cc);
        if (glyph === "┼") {
          [rr, cc] = [rr + dr, cc + dc];
          continue;
        }
        if (CONN[glyph] === undefined && dr === 0 && glyph === " ") {
          // a sideways label sits ON its line (`─ yes ─►`): step over it to the line again
          let k = 1;
          while (k < 60 && CONN[at(rr, cc + k * dc)] === undefined) k++;
          if (at(rr, cc + k * dc) === "─" || at(rr, cc + k * dc) === "╌") {
            cc += k * dc;
            continue;
          }
        }
        const conn = CONN[glyph];
        if (conn === undefined)
          throw new Error(`walk from ${r},${c} hit "${glyph}" at ${rr},${cc}`);
        const back = conn.findIndex(([a, b]) => a === -dr && b === -dc);
        if (back < 0)
          throw new Error(
            `walk from ${r},${c} entered "${glyph}" at ${rr},${cc} from the wrong side`,
          );
        const next = conn[1 - back] as [number, number];
        [dr, dc] = next;
        [rr, cc] = [rr + dr, cc + dc];
      }
      throw new Error("walk did not end");
    });
  });
  return pairs.sort();
}

function arrowPairs(src: string): string[] {
  return flowOf(src)
    .edges.filter((e) => e.arrow)
    .map((e) => `${e.from}>${e.to}`)
    .sort();
}

describe("T3.2 every edge is a connected path from its source box to its target box", () => {
  for (const [name, src] of [
    ["login", LOGIN],
    ["loop (back edge)", LOOP],
    ["subgraph", SUBGRAPH],
    ["cjk", CJK],
  ] as const) {
    test(name, () => {
      const d = drawFlow(flowOf(src), 200);
      expect(d).toBeDefined();
      if (d === undefined) return;
      expect(walkArrows(d)).toEqual(arrowPairs(src));
    });
  }

  test("fuzz: every drawn random flowchart (all four directions, cycles)", () => {
    let drawn = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const src = randomFlow(seed);
      let model: ReturnType<typeof flowOf>;
      try {
        model = flowOf(src);
      } catch {
        continue;
      }
      const d = drawFlow(model, 400);
      if (d === undefined) continue;
      drawn++;
      expect({ seed, pairs: walkArrows(d) }).toEqual({ seed, pairs: arrowPairs(src) });
    }
    // the router must draw most of them, or the property is vacuous
    expect(drawn).toBeGreaterThan(120);
  });
});

describe("T3.3 no two boxes overlap", () => {
  test("fixtures and fuzz", () => {
    const models = [
      LOGIN,
      LOOP,
      SUBGRAPH,
      CJK,
      ...Array.from({ length: 200 }, (_, i) => randomFlow(i + 1)),
    ];
    for (const src of models) {
      let model: ReturnType<typeof flowOf>;
      try {
        model = flowOf(src);
      } catch {
        continue;
      }
      const d = drawFlow(model, 400);
      if (d === undefined) continue;
      expect(d.boxes.length).toBe(model.nodes.length);
      for (const a of d.boxes) {
        for (const b of d.boxes) {
          if (a === b) continue;
          const apart =
            a.row + a.height <= b.row ||
            b.row + b.height <= a.row ||
            a.col + a.width <= b.col ||
            b.col + b.width <= a.col;
          expect({ src, a: a.id, b: b.id, apart }).toEqual({ src, a: a.id, b: b.id, apart: true });
        }
      }
    }
  });
});

describe("T3.4 every label of the model appears exactly once", () => {
  const count = (text: string, s: string): number => text.split(s).length - 1;
  test("flowchart: nodes and edge labels", () => {
    const d = drawFlow(flowOf(LOGIN), 200);
    const text = d?.rows.map(rowText).join("\n") ?? "";
    for (const s of [
      "Richiesta",
      "Token valido?",
      "Carica sessione",
      "Login",
      "Database utenti",
      "Risposta",
      "sì",
      " no",
    ]) {
      expect({ s, n: count(text, s) }).toEqual({ s, n: 1 });
    }
  });
  test("sequence: participants and messages, both forms", () => {
    for (const width of [120, 40]) {
      const text = drawSequence(sequenceOf(PHONE), width).rows.map(rowText).join("\n");
      for (const s of [
        "session/prompt",
        "inoltra · E2E",
        "elabora",
        "session/update",
        "transcript",
        "ridisegna",
        "perso",
      ]) {
        expect({ width, s, n: count(text, s) }).toEqual({ width, s, n: 1 });
      }
    }
  });
});

describe("T3.5 tiers", () => {
  test("a flowchart draws when it fits, else source + the generic cut", () => {
    const wide = plain(LOGIN, 80);
    expect(wide.join("\n")).toContain("╭───────────╮");
    const narrow = plain(LOGIN, 30);
    expect(narrow.join("\n")).not.toContain("╭───────────╮");
    expect(narrow[0]).toContain("Titolo · flowchart · source"); // the caption itself is cut at 30
    expect(narrow.filter((l) => l.startsWith("│ "))).toHaveLength(DIAGRAM_SOURCE_PREVIEW);
    expect(narrow.at(-1)?.startsWith("… +2 more lines · ctrl+o")).toBe(true); // cut at 30 too
  });

  test("expanded: the drawing, then the whole source", () => {
    const lines = plain(LOGIN, 80, true);
    const at = lines.findIndex((l) => l.startsWith("│ flowchart TD"));
    expect(at).toBeGreaterThan(5);
    expect(lines.slice(at)).toHaveLength(7);
    expect(lines.slice(0, at).join("\n")).toContain("◇");
  });

  test("a type with no drawing: source only, cut, and all of it expanded", () => {
    const compact = plain(CLASSES, 80);
    expect(compact[0]).toContain("Titolo · classDiagram · source only in the terminal");
    expect(compact.at(-1)).toMatch(/^… \+\d+ more lines · ctrl\+o to expand$/);
    const expanded = plain(CLASSES, 80, true);
    expect(expanded.filter((l) => l.startsWith("│ "))).toHaveLength(CLASSES.split("\n").length);
  });

  test("a sequence under 50 cols is one line per message", () => {
    const model = sequenceOf(PHONE);
    const d = drawSequence(model, 49);
    expect(d.form).toBe("list");
    expect(d.rows).toHaveLength(model.messages.length);
    expect(drawSequence(model, 50).form).toBe("lifelines");
  });

  test("a flowchart the router cannot draw faithfully (self-loop) shows its source", () => {
    const lines = plain("flowchart TD\n  A --> A\n  A --> B", 120);
    expect(lines[0]).toContain("source only");
  });

  test("a subgraph whose frame would enclose a non-member box is not drawn (no wrong frame)", () => {
    const src = "flowchart TD\n  subgraph S\n    A --> C\n  end\n  A --> B\n  B --> C";
    expect(drawFlow(flowOf(src), 200)).toBeUndefined();
    expect(plain(src, 120)[0]).toContain("source only");
    // the same graph without the subgraph draws
    expect(drawFlow(flowOf("flowchart TD\n  A --> C\n  A --> B\n  B --> C"), 200)).toBeDefined();
  });

  test("the open hint shows only when asked (the artifacts chord exists, D7)", () => {
    expect(plain(LOGIN, 80)[0]).not.toContain("^X^O");
    const hinted = diagramToolBody(args("Titolo", LOGIN), {
      width: 80,
      color: false,
      openHint: true,
    });
    expect(hinted?.[0]).toContain("· ^X^O open");
  });
});

describe("T3.6 NO_COLOR keeps the shapes that carry meaning", () => {
  test("◇ and ╌ without colour; colour on strips back to the same text", () => {
    const off = plain(`${LOGIN}\n  F -.-> A`, 80);
    const text = off.join("\n");
    expect(text).toContain("◇");
    expect(text).toContain("╎");
    expect(text).not.toContain(ESC);
    expect(plain(PHONE, 80).join("\n")).toContain("╌");
    chalk.level = 3;
    const on = diagramToolBody(args("Titolo", `${LOGIN}\n  F -.-> A`), {
      width: 80,
      color: true,
      mode: "light",
    });
    chalk.level = level;
    expect(on?.join("\n")).toContain(ESC);
    expect(on?.map(strip)).toEqual(off);
  });
});

describe("T3.7 no glyph with the emoji property", () => {
  test("fixtures and fuzz, every width", () => {
    for (const src of [
      LOGIN,
      PHONE,
      CLASSES,
      LOOP,
      SUBGRAPH,
      ...Array.from({ length: 40 }, (_, i) => randomFlow(i + 1)),
    ]) {
      for (const width of [40, 80, 120]) {
        const out = diagramToolBody(args("T", src), { width, color: false, expanded: true });
        for (const line of out ?? [])
          expect({ line, picto: PICTO.test(line) }).toEqual({ line, picto: false });
      }
    }
  });
});

describe("T3.8 CJK labels are measured at width 2", () => {
  test("a box fits its CJK label exactly", () => {
    const d = drawFlow(flowOf(CJK), 120);
    expect(d).toBeDefined();
    const rows = d?.rows.map(rowText) ?? [];
    const top = rows.find((r) => r.includes("╭──────╮"));
    const mid = rows.find((r) => r.includes("│ 开始 │"));
    expect(top).toBeDefined();
    expect(mid).toBeDefined();
    expect(cellWidth((mid ?? "").trimEnd())).toBe(cellWidth((top ?? "").trimEnd()));
  });
});

describe("forged or refused arguments → the generic row", () => {
  for (const bad of [
    "not json",
    JSON.stringify({ title: "", mermaid: LOGIN }),
    JSON.stringify({ title: "x".repeat(121), mermaid: LOGIN }),
    JSON.stringify({ title: "T" }),
    JSON.stringify({ title: "T", mermaid: 'pie\n  "a": 1' }),
    JSON.stringify([1, 2]),
  ]) {
    test(bad.slice(0, 40), () => {
      expect(diagramToolBody(bad, { width: 80 })).toBeUndefined();
    });
  }
});

describe("forged control bytes never reach a drawn row (a pod is not trusted)", () => {
  // OSC 52 (clipboard write) + clear screen, plus a C1 CSI and a bare CR.
  const EVIL = `${ESC}]52;c;aGk=\u0007${ESC}[2J\u009b31m\r`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the property under test
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
  const cases: Array<[string, string, string]> = [
    ["title", `T${EVIL}x`, LOGIN],
    ["flowchart label", "T", `flowchart TD\n  A["x${EVIL}y"] --> B`],
    ["source view", "T", `classDiagram\n  class A${EVIL}`],
    ["sequence message", "T", `sequenceDiagram\n  A->>B: hi${EVIL}there`],
  ];
  for (const [name, title, src] of cases) {
    test(name, () => {
      for (const expanded of [false, true]) {
        const out = diagramToolBody(args(title, src), { width: 80, expanded, color: false });
        expect(out).toBeDefined();
        for (const line of out ?? []) expect(line).not.toMatch(CONTROL);
      }
    });
  }
});

describe("source highlighting", () => {
  test("runs join back to the line", () => {
    for (const line of [
      ...LOGIN.split("\n"),
      ...PHONE.split("\n"),
      ...CLASSES.split("\n"),
      "  %% a comment",
      "A -.-> B((x))",
    ]) {
      expect(
        highlightMermaidLine(line)
          .map(([, t]) => t)
          .join(""),
      ).toBe(line);
    }
  });
  test("keyword, id, arrow, label, comment", () => {
    expect(highlightMermaidLine("  B -- sì --> C[Carica sessione]")).toEqual([
      ["text", "  "],
      ["id", "B"],
      ["text", " "],
      ["arrow", "--"],
      ["text", " "],
      ["id", "sì"],
      ["text", " "],
      ["arrow", "-->"],
      ["text", " "],
      ["id", "C"],
      ["string", "[Carica sessione]"],
    ]);
    expect(highlightMermaidLine("flowchart TD")).toEqual([
      ["keyword", "flowchart"],
      ["text", " "],
      ["keyword", "TD"],
    ]);
    expect(highlightMermaidLine("  App->>Relay: hi")).toEqual([
      ["text", "  "],
      ["id", "App"],
      ["arrow", "->>"],
      ["id", "Relay"],
      ["arrow", ":"],
      ["string", " hi"],
    ]);
    expect(highlightMermaidLine("  %% note")).toEqual([
      ["text", "  "],
      ["comment", "%% note"],
    ]);
  });
});
