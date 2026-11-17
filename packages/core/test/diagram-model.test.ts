/**
 * T1.7 — `diagramModel`: a small, own reading of the flowchart and sequence
 * subset (docs/feat/model-diagrams.md D5).
 *
 * The property that matters is honesty: every construct it does not model comes
 * back as `other`, because each consumer (the TUI's ASCII drawing, the phone's
 * VoiceOver summary) prefers the source to a wrong picture.
 */
import { describe, expect, test } from "bun:test";
import { type FlowModel, type SequenceModel, diagramModel } from "../src/index.ts";

/** The model of a flowchart fixture, throwing when it is not a flowchart. */
function flow(source: string): FlowModel {
  const model = diagramModel(source, "flowchart");
  if (model.kind !== "flowchart") throw new Error(`not a flowchart: ${model.kind}`);
  return model;
}

/** The model of a sequence fixture, throwing when it is not a sequence. */
function sequence(source: string): SequenceModel {
  const model = diagramModel(source, "sequenceDiagram");
  if (model.kind !== "sequence") throw new Error(`not a sequence: ${model.kind}`);
  return model;
}

describe("diagramModel: flowchart", () => {
  test("nodes, shapes and labels", () => {
    const model = flow(
      [
        "flowchart TD",
        "  A[Start] --> B{Fine?}",
        "  B --> C(Riprova)",
        "  C --> D([Fatto])",
        "  D --> E[(Database)]",
        "  E --> F((Cerchio))",
      ].join("\n"),
    );
    expect(model.direction).toBe("TD");
    expect(model.nodes).toEqual([
      { id: "A", label: "Start", shape: "rect" },
      { id: "B", label: "Fine?", shape: "decision" },
      { id: "C", label: "Riprova", shape: "round" },
      { id: "D", label: "Fatto", shape: "stadium" },
      { id: "E", label: "Database", shape: "cylinder" },
      { id: "F", label: "Cerchio", shape: "circle" },
    ]);
    expect(model.edges).toHaveLength(5);
    expect(model.edges[0]).toEqual({ from: "A", to: "B", style: "solid", arrow: true });
  });

  test("edge labels, both spellings, and the link styles", () => {
    const model = flow(
      [
        "flowchart LR",
        "  A -->|si| B",
        "  A -- no --> C",
        "  A -.-> D",
        "  A ==> E",
        "  A --- F",
      ].join("\n"),
    );
    expect(model.direction).toBe("LR");
    expect(model.edges).toEqual([
      { from: "A", to: "B", style: "solid", arrow: true, label: "si" },
      { from: "A", to: "C", style: "solid", arrow: true, label: "no" },
      { from: "A", to: "D", style: "dotted", arrow: true },
      { from: "A", to: "E", style: "thick", arrow: true },
      { from: "A", to: "F", style: "solid", arrow: false },
    ]);
  });

  test("a chain is several edges, and a bare id keeps the label it was given", () => {
    const model = flow("flowchart TD\n  A[Start] --> B --> C[Fine]\n  B[X]");
    expect(model.nodes.map((node) => node.label)).toEqual(["Start", "X", "Fine"]);
    expect(model.edges.map((edge) => `${edge.from}${edge.to}`)).toEqual(["AB", "BC"]);
  });

  test("subgraphs collect their own nodes", () => {
    const model = flow(
      [
        "flowchart TD",
        "  A[Start] --> B[Fine]",
        "  subgraph Auth",
        "    C[Login] --> D[Token]",
        "  end",
        "  B --> C",
      ].join("\n"),
    );
    expect(model.subgraphs).toEqual([{ title: "Auth", nodes: ["C", "D"] }]);
    expect(model.nodes).toHaveLength(4);
  });

  test("a label with parentheses and a quoted label both keep their text", () => {
    const model = flow('flowchart TD\n  A[Carica (sessione)] --> B["Virgolette, e virgole"]');
    expect(model.nodes.map((node) => node.label)).toEqual([
      "Carica (sessione)",
      "Virgolette, e virgole",
    ]);
  });

  test("a statement per semicolon is read as separate statements", () => {
    const model = flow("flowchart TD\n  A --> B; B --> C");
    expect(model.edges.map((edge) => `${edge.from}${edge.to}`)).toEqual(["AB", "BC"]);
  });
});

describe("diagramModel: sequence", () => {
  test("participants, aliases, messages and their styles", () => {
    const model = sequence(
      [
        "sequenceDiagram",
        "  participant A as Utente",
        "  actor B as Servizio",
        "  A->>B: richiesta",
        "  B-->>A: token",
        "  A-xB: annulla",
      ].join("\n"),
    );
    expect(model.participants).toEqual([
      { id: "A", label: "Utente", shape: "rect" },
      { id: "B", label: "Servizio", shape: "rect" },
    ]);
    expect(model.messages).toEqual([
      { from: "A", to: "B", text: "richiesta", style: "call", note: false },
      { from: "B", to: "A", text: "token", style: "reply", note: false },
      { from: "A", to: "B", text: "annulla", style: "cross", note: false },
    ]);
  });

  test("notes are boxes, and blocks are kept with their titles", () => {
    const model = sequence(
      [
        "sequenceDiagram",
        "  A->>B: x",
        "  alt va bene",
        "    B-->>A: ok",
        "  else fallisce",
        "    B-->>A: no",
        "  end",
        "  Note over A,B: attenzione",
      ].join("\n"),
    );
    expect(model.blocks).toEqual([{ kind: "alt", title: "va bene" }]);
    expect(model.messages.at(-1)).toEqual({
      from: "A",
      to: "B",
      text: "attenzione",
      style: "call",
      note: true,
    });
  });
});

describe("diagramModel: other, never a guess", () => {
  test("a type it does not model is `other`, with its lines", () => {
    for (const type of [
      "classDiagram",
      "stateDiagram",
      "erDiagram",
      "gantt",
      "mindmap",
      "timeline",
      "journey",
      "gitGraph",
    ]) {
      const model = diagramModel(`${type}\n  a`, type);
      expect({ type, kind: model.kind }).toEqual({ type, kind: "other" });
    }
  });

  test("a flowchart construct it does not model falls back to `other`", () => {
    // `A & B` (multi-node), an unknown arrow (`--x`), a stray `end`, an
    // unclosed `subgraph`, a chained link it cannot split, junk after a label.
    for (const body of [
      "flowchart TD\n  A & B --> C",
      "flowchart TD\n  A --x B",
      "flowchart TD\n  A --> B\n  end",
      "flowchart TD\n  subgraph Auth\n    A --> B",
      "flowchart TD\n  A --> ",
      "flowchart TD\n  A[x] y --> B",
    ]) {
      const model = diagramModel(body, "flowchart");
      expect({ body, kind: model.kind }).toEqual({ body, kind: "other" });
    }
  });

  test("a sequence construct it does not model falls back to `other`", () => {
    for (const body of [
      "sequenceDiagram\n  A->>B",
      "sequenceDiagram\n  A->>B: x\n  box Aqua\n    participant C\n  end",
      "sequenceDiagram\n  loop ogni\ttick\n  end",
    ]) {
      const model = diagramModel(body, "sequenceDiagram");
      expect({ body, kind: model.kind }).toEqual({ body, kind: "other" });
    }
  });
});
