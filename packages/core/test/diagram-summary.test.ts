/**
 * T1.8 — `summarizeDiagram` / `describeDiagram`: the ONE sentence a diagram
 * makes, shared by the tool's result line (what the model, and an old client,
 * reads) and the phone's VoiceOver label (docs/feat/model-diagrams.md D5).
 */
import { describe, expect, test } from "bun:test";
import { describeDiagram, diagramModel, summarizeDiagram } from "../src/index.ts";

const FLOW = [
  "flowchart TD",
  "  A[Richiesta] --> B{Token valido?}",
  "  B -->|si| C[Carica]",
  "  B -->|no| D[Rifiuta]",
  "  C --> E[Fatto]",
].join("\n");

const SEQ = [
  "sequenceDiagram",
  "  participant U as Utente",
  "  U->>S: login",
  "  S-->>U: token",
].join("\n");

describe("summarizeDiagram: the result line", () => {
  test("a multi-line (`<br/>`) label stays ONE line in the result and the a11y text", () => {
    // fix/tui-diagram-complex-flow: the model keeps a label's lines, and this
    // line is a single sentence (a `\n` would break the transcript row / a11y).
    const src = 'flowchart TD\n  A["Token in ingresso<br/>(es. ciao)"] --> B[Fine]';
    const model = diagramModel(src, "flowchart");
    const { line } = summarizeDiagram(model, "flowchart", { title: "Token" });
    expect(line).not.toContain("\n");
    const spoken = describeDiagram(model, "flowchart", { title: "Token" });
    expect(spoken).not.toContain("\n");
    expect(spoken).toContain("Token in ingresso (es. ciao)");
  });

  test("a flowchart says its size, its links and its direction", () => {
    const { line } = summarizeDiagram(diagramModel(FLOW, "flowchart"), "flowchart", {
      title: "Flusso di login",
    });
    expect(line).toBe(
      'Diagram shown to the user: flowchart "Flusso di login" · 5 nodes · 4 links · top to bottom',
    );
  });

  test("subgraphs and a sequence's participants are counted", () => {
    const withFrame = "flowchart LR\n  subgraph Auth\n    A[Login] --> B[Token]\n  end";
    expect(
      summarizeDiagram(diagramModel(withFrame, "flowchart"), "flowchart", { title: "Auth" }).line,
    ).toBe(
      'Diagram shown to the user: flowchart "Auth" · 2 nodes · 1 link · 1 subgraph · left to right',
    );

    expect(
      summarizeDiagram(diagramModel(SEQ, "sequenceDiagram"), "sequenceDiagram", { title: "Login" })
        .line,
    ).toBe('Diagram shown to the user: sequenceDiagram "Login" · 2 participants · 2 messages');
  });

  test("the notes ride the line, because that is where the model reads them", () => {
    const { line } = summarizeDiagram(diagramModel(FLOW, "flowchart"), "flowchart", {
      title: "Flusso",
      notes: ["3 style lines (the app chooses colours and fonts)"],
    });
    expect(line).toEndWith(" · 3 style lines (the app chooses colours and fonts)");
  });

  test("the gantt's line is quoted, and only the lines that say something are counted", () => {
    const gantt = "gantt\n  title Piano\n  section A\n  Task :2024-01-01, 3d";
    expect(summarizeDiagram(diagramModel(gantt, "gantt"), "gantt", { title: "Piano" }).line).toBe(
      'Diagram shown to the user: gantt "Piano" · 4 lines',
    );
  });

  test("one node reads as one node", () => {
    expect(
      summarizeDiagram(diagramModel("flowchart TD\n  A[Solo]", "flowchart"), "flowchart", {
        title: "T",
      }).line,
    ).toBe('Diagram shown to the user: flowchart "T" · 1 node · 0 links · top to bottom');
  });
});

describe("describeDiagram: what VoiceOver says", () => {
  test("the reading order walks the flow from its start to four boxes", () => {
    expect(describeDiagram(diagramModel(FLOW, "flowchart"), "flowchart", { title: "Flusso" })).toBe(
      "flowchart Flusso: Richiesta → Token valido? → Carica → Fatto",
    );
  });

  test("a sequence reads its first messages, in order", () => {
    expect(
      describeDiagram(diagramModel(SEQ, "sequenceDiagram"), "sequenceDiagram", { title: "Login" }),
    ).toBe("sequenceDiagram Login: login → token");
  });

  test("a type it does not model still says what it is", () => {
    const gantt = "gantt\n  title Piano\n  section A";
    expect(describeDiagram(diagramModel(gantt, "gantt"), "gantt", { title: "Piano" })).toBe(
      "gantt Piano: section A",
    );
  });
});
