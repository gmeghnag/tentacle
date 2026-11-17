/**
 * T1.1–T1.6 — `lintDiagram`: what a small model wrote, made drawable
 * (docs/feat/model-diagrams.md D3).
 *
 * The property under test is the one the tool leans on: a source is either
 * refused with every fix named, or returned as a `canonical` form plus the
 * `lineMap` that keeps a later Mermaid error pointing at the MODEL's line, plus
 * the `notes` that teach it (dropped styling, a stripped fence).
 */
import { describe, expect, test } from "bun:test";
import { DIAGRAM_CAPS, lintDiagram } from "../src/index.ts";

/** The lint's success, throwing when the fixture is refused. */
function canonical(raw: string) {
  const result = lintDiagram(raw);
  if (!result.ok) throw new Error(`fixture refused: ${result.errors.join(" | ")}`);
  return result;
}

/** The lint's refusal, throwing when the fixture was accepted. */
function refused(raw: string): readonly string[] {
  const result = lintDiagram(raw);
  if (result.ok) throw new Error(`fixture accepted: ${JSON.stringify(result.canonical)}`);
  return result.errors;
}

describe("lintDiagram: one valid source per allowed type", () => {
  const VALID: Readonly<Record<string, string>> = {
    flowchart: "flowchart TD\n  A[Start] --> B[Fine]",
    sequenceDiagram: "sequenceDiagram\n  A->>B: ciao\n  B-->>A: ok",
    classDiagram: "classDiagram\n  class A {\n    +int x\n  }",
    stateDiagram: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Run: go",
    erDiagram: "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
    gantt: "gantt\n  title Piano\n  section A\n  Task :2024-01-01, 3d",
    mindmap: "mindmap\n  root((tentacle))\n    TUI",
    timeline: "timeline\n  title Storia\n  2020 : inizio",
    journey: "journey\n  title Giornata\n  section Mattina\n    Caffe: 5: Me",
    gitGraph: "gitGraph\n  commit\n  branch dev\n  commit",
  };

  test("each one lints, naming its type, with no notes", () => {
    for (const [type, source] of Object.entries(VALID)) {
      const result = canonical(source);
      expect({ type, lintType: result.type, notes: result.notes }).toEqual({
        type,
        lintType: type as typeof result.type,
        notes: [],
      });
    }
  });

  test("an already-canonical source comes back byte-equal", () => {
    for (const source of Object.values(VALID)) {
      expect(canonical(source).canonical).toBe(source);
    }
  });

  test("a canonical source's lineMap is the identity", () => {
    for (const source of Object.values(VALID)) {
      const lines = source.split("\n").length;
      expect(canonical(source).lineMap).toEqual(Array.from({ length: lines }, (_, i) => i + 1));
    }
  });
});

describe("lintDiagram: forgiveness, with a note (§ sibling of chart's dropped styling)", () => {
  test("a Markdown fence is stripped, and lineMap still names the model's lines", () => {
    const result = canonical("```mermaid\nflowchart TD\n  A --> B\n```");
    expect(result.canonical).toBe("flowchart TD\n  A --> B");
    expect(result.notes).toEqual(["the ```mermaid fence"]);
    // Canonical line 2 is the model's line 3: the fence shifted it by one.
    expect(result.lineMap).toEqual([2, 3]);
  });

  test("a bare ``` fence is stripped too", () => {
    const result = canonical("```\nflowchart TD\n  A --> B\n```");
    expect(result.canonical).toBe("flowchart TD\n  A --> B");
    expect(result.notes).toEqual(["the ```mermaid fence"]);
  });

  test("%%{init}%% is dropped: the app chooses theme and fonts", () => {
    const result = canonical('%%{init: {"theme":"dark"}}%%\nflowchart TD\n  A --> B');
    expect(result.canonical).toBe("flowchart TD\n  A --> B");
    expect(result.notes).toEqual(["%%{init}%% (the app chooses theme and fonts)"]);
    expect(result.lineMap).toEqual([2, 3]);
  });

  test("a multi-line %%{init}%% before the type line is dropped too, never refused", () => {
    // The usual form spans lines; its inner lines must not read as the diagram
    // (review round 1, finding 2).
    const result = canonical('%%{init: {\n  "theme":"dark"\n}}%%\nflowchart TD\n  A --> B');
    expect(result.canonical).toBe("flowchart TD\n  A --> B");
    expect(result.notes).toEqual(["%%{init}%% (the app chooses theme and fonts)"]);
    expect(result.lineMap).toEqual([4, 5]);
  });

  test("a config front-matter is dropped", () => {
    const result = canonical("---\nconfig:\n  theme: dark\n---\nflowchart TD\n  A --> B");
    expect(result.canonical).toBe("flowchart TD\n  A --> B");
    expect(result.notes).toEqual(["the config front-matter (the app chooses theme and fonts)"]);
    expect(result.lineMap).toEqual([5, 6]);
  });

  test("style, classDef, linkStyle, class and ::: are dropped and counted", () => {
    const result = canonical(
      [
        "flowchart TD",
        "  A[Start] --> B[Fine]",
        "  style A fill:#f00",
        "  classDef bad fill:#0f0",
        "  linkStyle 0 stroke:#f00",
        "  class B bad",
        '  click B href "javascript:alert(1)"',
        "  B:::bad",
      ].join("\n"),
    );
    expect(result.canonical).toBe("flowchart TD\n  A[Start] --> B[Fine]\n  B");
    expect(result.notes).toEqual([
      // style, classDef, linkStyle, class B bad and B:::bad — five.
      "5 style lines (the app chooses colours and fonts)",
      "1 click line (a diagram is not interactive)",
    ]);
  });

  test("a single styling line is singular", () => {
    expect(canonical("flowchart TD\n  A --> B\n  style A fill:#f00").notes).toEqual([
      "1 style line (the app chooses colours and fonts)",
    ]);
  });

  test("click, style and classDef after a `;` are dropped, not smuggled through", () => {
    // A `;` joins statements: the styling/click statement goes, the rest of the
    // line stays (review round 1, finding 4).
    const result = canonical(
      [
        "flowchart TD",
        '  A[Start] --> B[Fine]; click A href "javascript:alert(1)"',
        "  B --> C; style B fill:#f00; classDef bad fill:#0f0",
      ].join("\n"),
    );
    expect(result.canonical).toBe("flowchart TD\n  A[Start] --> B[Fine]\n  B --> C");
    expect(result.notes).toEqual([
      "2 style lines (the app chooses colours and fonts)",
      "1 click line (a diagram is not interactive)",
    ]);
    expect(result.canonical).not.toContain("javascript:");
  });

  test("a `;` inside a quoted click href is not a statement separator", () => {
    const result = canonical('flowchart TD\n  A --> B; click A href "x?a=1;b=2"');
    expect(result.canonical).toBe("flowchart TD\n  A --> B");
    expect(result.notes).toEqual(["1 click line (a diagram is not interactive)"]);
  });

  test("a `;` in a comment is prose, not a statement join", () => {
    const result = canonical("flowchart TD\n  %% A --> B; style A fill:#f00\n  A --> B");
    expect(result.canonical).toBe("flowchart TD\n  %% A --> B; style A fill:#f00\n  A --> B");
    expect(result.notes).toEqual([]);
  });

  test("a click on the type line's own line is still dropped, the type kept", () => {
    const result = canonical('flowchart TD; click A href "x"');
    expect(result.canonical).toBe("flowchart TD");
    expect(result.notes).toEqual(["1 click line (a diagram is not interactive)"]);
  });

  test("tabs, CRLF, a BOM and NBSP are normalised silently", () => {
    const result = canonical("\uFEFFflowchart TD\r\n\tA[A\u00a0B] --> B\r\n");
    expect(result.canonical).toBe("flowchart TD\n  A[A B] --> B");
    expect(result.notes).toEqual([]);
  });

  test("graph is spelled flowchart canonically, keeping its direction", () => {
    expect(canonical("graph LR\n  A --> B").canonical).toBe("flowchart LR\n  A --> B");
    expect(canonical("graph\n  A --> B").canonical).toBe("flowchart TD\n  A --> B");
  });

  test("a one-liner keeps the statements after its type line", () => {
    // Only the leading keyword is canonicalised: `graph TD;A-->B` is a whole
    // diagram on one line (review round 1, finding 1).
    expect(canonical("graph TD;A-->B;B-->C").canonical).toBe("flowchart TD;A-->B;B-->C");
    expect(canonical("graph;A-->B").canonical).toBe("flowchart TD;A-->B");
  });

  test("what follows a non-flowchart type keyword stays on its line", () => {
    expect(canonical("sequenceDiagram autonumber\n  A->>B: ciao").canonical).toBe(
      "sequenceDiagram autonumber\n  A->>B: ciao",
    );
    expect(canonical("sequenceDiagram;A->>B: ciao").canonical).toBe("sequenceDiagram;A->>B: ciao");
    expect(canonical("gantt\n  title Piano").canonical).toBe("gantt\n  title Piano");
  });

  test("a habitually misspelt type is spelled canonically", () => {
    expect(canonical("stateDiagram\n  [*] --> A").canonical).toBe("stateDiagram-v2\n  [*] --> A");
    expect(canonical("sequence\n  A->>B: x").canonical).toBe("sequenceDiagram\n  A->>B: x");
    expect(canonical("er\n  A ||--o{ B : has").canonical).toBe("erDiagram\n  A ||--o{ B : has");
    expect(canonical("class\n  A : +x int").canonical).toBe("classDiagram\n  A : +x int");
  });
});

describe("lintDiagram: refusals name the fix", () => {
  test("a misspelt type gets a did-you-mean and the allowed list", () => {
    const [error] = refused("grpah TB\n  A --> B");
    expect(error).toContain('unknown diagram type "grpah"');
    expect(error).toContain('did you mean "flowchart"?');
    expect(error).toContain("Allowed: ");
  });

  test("a numbers chart points at the chart tool", () => {
    expect(refused('pie title X\n  "a" : 1')[0]).toBe(
      'line 1: "pie" draws numbers — use the chart tool (type "pie"/"doughnut")',
    );
    expect(refused("xychart-beta\n  bar [1,2]")[0]).toContain(
      'use the chart tool (type "line"/"bar")',
    );
    expect(refused("quadrantChart\n  x-axis a --> b")[0]).toContain("scatter");
    expect(refused("sankey-beta\n  A,B,1")[0]).toContain("use the chart tool");
  });

  test("an experimental or network-bound type is refused as unsupported", () => {
    expect(refused("architecture-beta\n  service a")[0]).toContain(
      '"architecture-beta" is not supported',
    );
    expect(refused("kanban\n  todo")[0]).toContain('"kanban" is not supported');
    expect(refused("C4Context\n  Person(a)")[0]).toContain("is not supported");
  });

  test("an empty or comment-only source asks for a type line", () => {
    for (const source of ["", "   ", "%% solo un commento", "\n\n"]) {
      expect(refused(source)).toEqual([
        'the diagram is empty — start with a type line, e.g. "flowchart TD"',
      ]);
    }
  });

  test("the caps hold at N and refuse N+1 with its advice", () => {
    const body = Array.from({ length: DIAGRAM_CAPS.lines - 1 }, (_, i) => `  N${i} --> N${i + 1}`);
    const atCap = `flowchart TD\n${body.join("\n")}`;
    expect(lintDiagram(atCap).ok).toBe(true);

    const overCap = `${atCap}\n  N${DIAGRAM_CAPS.lines} --> N0`;
    expect(refused(overCap)).toEqual([
      `the diagram is too large (${DIAGRAM_CAPS.lines + 1} lines > ${DIAGRAM_CAPS.lines}) — split it into two diagrams or group nodes into subgraphs`,
    ]);
  });

  test("the byte cap holds at 20 KiB and refuses 20 KiB + 1", () => {
    const pad = (bytes: number): string => {
      const head = "flowchart TD\n  A[";
      const tail = "] --> B";
      return `${head}${"x".repeat(bytes - head.length - tail.length)}${tail}`;
    };
    expect(lintDiagram(pad(DIAGRAM_CAPS.bytes)).ok).toBe(true);
    expect(refused(pad(DIAGRAM_CAPS.bytes + 1))[0]).toBe(
      "the diagram is too large (21 KiB > 20 KiB) — split it into two diagrams or group nodes into subgraphs",
    );
  });
});
