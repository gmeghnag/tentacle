/**
 * T1.4–T1.5 — `explainMermaidError`: Mermaid's two error shapes, as sentences a
 * small model acts on (docs/feat/model-diagrams.md D3).
 *
 * The fixtures are the shapes the D1 probe RECORDED from mermaid 11.4.1 in Bun
 * (with the `linkedom` shim): a jison error carries `hash.loc`/`hash.token`/
 * `hash.expected`, a chevrotain one `result.parserErrors[].token.startLine`, a
 * lexical one only a line in its message. Nothing here imports mermaid.
 */
import { describe, expect, test } from "bun:test";
import { explainMermaidError, lintDiagram } from "../src/index.ts";

/** The jison shape, as mermaid throws it. */
function jison(options: {
  line: number;
  column?: number;
  token?: string;
  expected?: string[];
  got?: string;
}): unknown {
  const got = options.got === undefined ? "" : `\nExpecting 'SEMI', got '${options.got}'`;
  return {
    message: `Parse error on line ${options.line}:\n...something${got}`,
    hash: {
      token: options.token,
      line: options.line - 1,
      loc: {
        first_line: options.line,
        last_line: options.line,
        first_column: options.column ?? 0,
        last_column: (options.column ?? 0) + 1,
      },
      expected: options.expected ?? [],
    },
  };
}

/** The chevrotain (langium parser) shape, as gitGraph/pie throw it. */
function chevrotain(options: {
  line: number;
  startColumn: number;
  image: string;
  message: string;
}): unknown {
  return {
    message: `Parsing failed:  ${options.message}`,
    result: {
      parserErrors: [
        {
          name: "MismatchedTokenException",
          message: options.message,
          token: {
            startLine: options.line,
            startColumn: options.startColumn,
            image: options.image,
          },
        },
      ],
    },
  };
}

describe("explainMermaidError: the mistakes a small model actually makes", () => {
  test("a label with parentheses is quoted for it", () => {
    const source = "flowchart TD\n  A[Start] --> C[Carica (sessione)]\n  C --> D[Fine]";
    const [sentence] = explainMermaidError(
      jison({ line: 2, column: 24, token: "PS", got: "PS" }),
      source,
    );
    expect(sentence).toBe(
      'line 2, col 25: the label "Carica (sessione)" has parentheses — quote it: C["Carica (sessione)"]',
    );
  });

  test("a round-node label is legal and never explained (not every paren fails)", () => {
    // Mermaid parses `C(sessione)` — a round node — so the explainer must not
    // claim a parenthesis problem for it.
    expect(lintDiagram("flowchart TD\n  A --> C(sessione)").ok).toBe(true);
  });

  test('a node id equal to "end" is named, with a rename', () => {
    const source = "flowchart TD\n  A[Start] --> end\n  end --> D[Fine]";
    expect(explainMermaidError(jison({ line: 2, column: 10, token: "end" }), source)).toEqual([
      'line 2: "end" cannot be a node id — rename it (e.g. "endNode")',
    ]);
  });

  test("a short -> arrow points at the real arrow", () => {
    const source = "flowchart TD\n  A[Start] -> B[Fine]";
    expect(explainMermaidError(jison({ line: 2, column: 10, token: "MINUS" }), source)).toEqual([
      'line 2, col 12: "->" is not an arrow in a flowchart — use "-->" (or "-.->", "==>")',
    ]);
  });

  test("a sequence message with no text shows the shape to write", () => {
    const source = "sequenceDiagram\n  A->>B\n  B->>A: ok";
    expect(
      explainMermaidError(
        jison({ line: 2, column: 6, token: "NEWLINE", expected: ["'TXT'"] }),
        source,
      ),
    ).toEqual(['line 2: a message needs text after a colon — write it as "A->>B: richiesta"']);
  });

  test("an unclosed subgraph names the opener's line and says add end", () => {
    const source = "flowchart TD\n  subgraph Auth\n    A[Start] --> B[Fine]\n  D[x]";
    expect(explainMermaidError(jison({ line: 4, column: 0 }), source)).toEqual([
      'line 4: "subgraph Auth" (line 2) is never closed — add "end"',
    ]);
  });
});

describe("explainMermaidError: never a raw dump", () => {
  test("an unknown jison shape still gets a sentence, the line and a caret", () => {
    const source = "flowchart TD\n  A --> || B";
    const sentences = explainMermaidError(
      jison({ line: 2, column: 8, token: "PIPE", got: "PIPE", expected: ["'TEXT'", "'STR'"] }),
      source,
    );
    expect(sentences.length).toBe(3);
    expect(sentences[0]).toStartWith("line 2, col 9: Mermaid could not parse this — ");
    expect(sentences[0]).toContain('"PIPE"');
    expect(sentences[1]).toBe("  A --> || B");
    expect(sentences[2]).toBe("        ^");
    expect(explainMermaidError({ message: "Parse error" }, source)[0]).not.toContain(
      "[object Object]",
    );
  });

  test("the chevrotain shape reads its own token line, not a JSON dump", () => {
    const source = 'pie\n  "a" :';
    const [sentence] = explainMermaidError(
      chevrotain({
        line: 2,
        startColumn: 2,
        image: '"a"',
        message: "Expecting token of type 'EOF' but found `\"a\"`.",
      }),
      source,
    );
    expect(sentence).toBe(
      'line 2, col 3: Mermaid could not parse this — Mermaid expected the end of the diagram, not "\\"a\\""',
    );
    expect(sentence).not.toContain("parserErrors");
  });

  test("a lexical error names its line", () => {
    const source = "sequenceDiagram\n  participant\n  A->>B: x";
    const [sentence] = explainMermaidError(
      {
        message: "Lexical error on line 2. Unrecognized text.",
        hash: { text: "", token: null, line: 1 },
      },
      source,
    );
    expect(sentence).toStartWith("line 2: Mermaid could not parse this");
  });

  test("an error with no shape at all is still a sentence", () => {
    const [sentence] = explainMermaidError(
      { message: "No diagram type detected matching given configuration for text: grpah TB" },
      "grpah TB",
    );
    expect(sentence).toBe(
      "line 1: No diagram type detected matching given configuration for text: grpah TB — check the type line and the syntax around it",
    );
    expect(explainMermaidError(new Error("boom"), "flowchart TD")[0]).toContain("boom");
  });
});

describe("explainMermaidError: the model's lines, not the canonical ones", () => {
  test("a stripped fence and two dropped directives shift the line back", () => {
    // Canonical line 2 is the model's line 5 (fence + 2 directives + a blank).
    const source = "flowchart TD\n  A --> B";
    const lineMap = [5, 6];
    const [sentence] = explainMermaidError(
      jison({ line: 2, column: 10, token: "MINUS" }),
      source,
      lineMap,
    );
    expect(sentence).toStartWith("line 6, col 11:");
  });
});
