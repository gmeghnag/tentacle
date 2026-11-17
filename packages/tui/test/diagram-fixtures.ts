/** Mermaid sources for the TUI diagram tests (docs/feat/model-diagrams.md T3). */
import { type FlowModel, type SequenceModel, diagramModel, lintDiagram } from "@tentacle/core";

/** Mockup 5A. */
export const LOGIN = `flowchart TD
  A[Richiesta] --> B{Token valido?}
  B -- sì --> C[Carica sessione]
  B -- no --> D[Login]
  D --> E[(Database utenti)]
  C --> F[Risposta]
  E --> F`;

/** Mockup 6A (+ a note, a self-message and a lost message). */
export const PHONE = `sequenceDiagram
  participant App
  participant Relay
  participant Mac
  App->>Relay: session/prompt
  Relay->>Mac: inoltra · E2E
  Note over Mac: elabora
  Mac-->>Relay: session/update
  Relay-->>App: transcript
  App->>App: ridisegna
  Relay-xMac: perso`;

/** Mockup frame 4: a type with no terminal drawing. */
export const CLASSES = `classDiagram
  Session "1" *-- "n" ChatMessage
  Session o-- ArtifactStore
  class Session {
    +uid: string
    +title: string
    +open() void
  }
  class ChatMessage {
    +role: string
  }`;

export const LOOP = `flowchart LR
  A[Start] --> B{Ok?}
  B -->|yes| C[Done]
  B -->|no| A`;

export const SUBGRAPH = `flowchart TD
  subgraph Server
    A[API] --> B[(DB)]
  end
  C[Client] --> A`;

export const CJK = `flowchart TD
  A[开始] -.-> B[结束]
  A ==> C[其他]`;

export function flowOf(src: string): FlowModel {
  const lint = lintDiagram(src);
  if (!lint.ok) throw new Error(lint.errors.join("\n"));
  const m = diagramModel(lint.canonical, lint.type);
  if (m.kind !== "flowchart") throw new Error(`not a flowchart: ${m.kind}`);
  return m;
}

export function sequenceOf(src: string): SequenceModel {
  const lint = lintDiagram(src);
  if (!lint.ok) throw new Error(lint.errors.join("\n"));
  const m = diagramModel(lint.canonical, lint.type);
  if (m.kind !== "sequence") throw new Error(`not a sequence: ${m.kind}`);
  return m;
}

export function args(title: string, mermaid: string): string {
  return JSON.stringify({ title, mermaid });
}

/** A deterministic random flowchart source (seeded LCG): cycles, labels, styles, directions. */
export function randomFlow(seed: number): string {
  let s = seed >>> 0 || 1;
  const rnd = (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
  const dirs = ["TD", "LR", "BT", "RL"];
  const n = 2 + rnd(10);
  const lines = [`flowchart ${dirs[rnd(4)]}`];
  const shapes = [
    (l: string) => `[${l}]`,
    (l: string) => `{${l}}`,
    (l: string) => `[(${l})]`,
    (l: string) => `(${l})`,
  ];
  for (let i = 0; i < n; i++)
    lines.push(
      `  N${i}${(shapes[rnd(4)] as (l: string) => string)(`Nodo ${i}${"x".repeat(rnd(8))}`)}`,
    );
  const arrows = ["-->", "-.->", "==>", "---"];
  const edges = n + rnd(n);
  for (let e = 0; e < edges; e++) {
    const a = rnd(n);
    let b = rnd(n);
    if (b === a) b = (a + 1) % n;
    const arrow = arrows[rnd(4)] as string;
    const label = rnd(3) === 0 && arrow === "-->" ? `|e${e}|` : "";
    lines.push(`  N${a} ${arrow}${label} N${b}`);
  }
  return lines.join("\n");
}
