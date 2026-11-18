/**
 * T2 — the `diagram` tool (docs/feat/model-diagrams.md D2/D4, slice D2): the model
 * draws a Mermaid diagram, and the daemon checks it with mermaid's own parser.
 *
 * What this file pins, and why each one can silently rot:
 *
 * - T2.0 the load-bearing assumption, as a test: mermaid parses headless in
 *   `bun`, one valid and one broken fixture per allowed type, with the DOM shim
 *   scoped to the import (no `window` left behind in the daemon).
 * - T2.1 the result line is the SHARED summary (`summarizeDiagram`), notes included.
 * - T2.2 a broken source → `isError` with the explainer's sentence, built from a
 *   REAL mermaid error (the D1 fixtures were recorded on an older mermaid).
 * - T2.3 the result stands alone: an old client shows only it.
 * - T2.4 a build without mermaid answers "not available", never a crash.
 * - T2.5 a hanging parse is cut by the budget.
 * - T2.6 (daemon half) mermaid is pinned exact, and the pin is what is installed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionEnvironment, ToolContext } from "@tentacle/core";
import {
  diagramModel,
  explainMermaidError as explainOf,
  lintDiagram,
  summarizeDiagram,
} from "@tentacle/core";
import { type MermaidParser, cachedMermaidLoader, parseMermaid } from "../src/diagram-parse.ts";
import {
  DIAGRAM_ARGUMENTS_HINT,
  DIAGRAM_TOOL_NAME,
  createDiagramTool,
  diagramArgumentsHint,
  diagramTool,
} from "../src/diagram.ts";
import { ToolRegistry } from "../src/index.ts";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

function ctx(): ToolContext {
  return { sessionId: "s1", signal: new AbortController().signal, env };
}

/** One valid and one broken source per allowed type (the D2 probe's fixtures). */
const FIXTURES: readonly (readonly [string, string, string])[] = [
  [
    "flowchart",
    "flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|si| C[Fine]",
    "flowchart TD\n  A[Start] -> B[Fine]",
  ],
  [
    "sequenceDiagram",
    "sequenceDiagram\n  A->>B: ciao\n  B-->>A: ok",
    "sequenceDiagram\n  A->>B\n  B->>A: ok",
  ],
  [
    "classDiagram",
    "classDiagram\n  class A\n  A : +x int",
    "classDiagram\n  class A {\n  A <|-- \n",
  ],
  [
    "stateDiagram-v2",
    "stateDiagram-v2\n  [*] --> Idle\n  Idle --> [*]",
    "stateDiagram-v2\n  [*] --> Idle -->\n",
  ],
  ["erDiagram", "erDiagram\n  CUSTOMER ||--o{ ORDER : places", "erDiagram\n  A ||--o B : has"],
  [
    "gantt",
    "gantt\n  dateFormat YYYY-MM-DD\n  section A\n  t1 :a1, 2024-01-01, 3d",
    "gantt\n  dateFormat YYYY-MM-DD\n  section A\n  t1 :a1, 2024-01-01, 3d\n  ::: ::",
  ],
  ["mindmap", "mindmap\n  root((R))\n    A\n    B", "mindmap\n  root((R\n    A"],
  ["timeline", "timeline\n  title T\n  2020 : a\n  2021 : b", "timeline\n  title T\n  : : :"],
  [
    "journey",
    "journey\n  title J\n  section S\n    Do it: 5: Me",
    "journey\n  title J\n  section S\n    Do it 5 Me",
  ],
  ["gitGraph", "gitGraph\n  commit\n  branch dev\n  commit", "gitGraph\n  commit\n  branch\n"],
];

describe("T2.0 mermaid parses headless in bun (the load-bearing assumption)", () => {
  for (const [type, valid, broken] of FIXTURES) {
    test(`${type}: the valid source parses, the broken one is refused with a position`, async () => {
      const lint = lintDiagram(valid);
      expect(lint.ok).toBe(true);
      expect(await parseMermaid(valid)).toEqual({ ok: true });
      const outcome = await parseMermaid(broken);
      expect(outcome.ok).toBe(false);
      if (outcome.ok || outcome.reason !== "invalid")
        throw new Error(`expected invalid: ${JSON.stringify(outcome)}`);
      // The explainer reads a line out of mermaid's real error (never `line 1` by default).
      const brokenLint = lintDiagram(broken);
      if (!brokenLint.ok) throw new Error("the broken fixture must pass the lint");
      const [sentence] = explainOf(outcome.error, brokenLint.canonical, brokenLint.lineMap);
      expect(sentence).toMatch(/^line [2-9]/);
    });
  }

  test("the DOM shim does not outlive the import: no `window`/`document` left in the daemon", async () => {
    await parseMermaid("flowchart TD\n  A --> B");
    const g = globalThis as Record<string, unknown>;
    expect(g.window).toBeUndefined();
    expect(g.document).toBeUndefined();
  });
});

describe("T2.1 a valid diagram answers with the shared summary line", () => {
  test("the result is summarizeDiagram's line, title included", async () => {
    const source =
      "flowchart TD\n  A[Richiesta] --> B{Token valido?}\n  B -->|si| C[Ok]\n  B -->|no| D[Errore]";
    const result = await diagramTool.execute({ title: "Flusso di login", mermaid: source }, ctx());
    expect(result.isError).toBeUndefined();
    const lint = lintDiagram(source);
    if (!lint.ok) throw new Error("fixture must lint");
    const expected = summarizeDiagram(diagramModel(lint.canonical, lint.type), lint.type, {
      title: "Flusso di login",
      notes: lint.notes,
    }).line;
    expect(result.content).toBe(expected);
    expect(result.content).toBe(
      'Diagram shown to the user: flowchart "Flusso di login" · 4 nodes · 3 links · top to bottom',
    );
  });

  test("the lint's notes ride the result (a stripped fence and a dropped style)", async () => {
    const source = "```mermaid\nflowchart LR\n  A --> B\n  style A fill:#f00\n```";
    const result = await diagramTool.execute({ title: "T", mermaid: source }, ctx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toStartWith(
      'Diagram shown to the user: flowchart "T" · 2 nodes · 1 link',
    );
    expect(result.content).toContain("fence");
    expect(result.content).toContain("style");
  });
});

describe("T2.2 a broken diagram is an error the model can act on", () => {
  test("a `->` arrow: mermaid refuses it and the model reads the fix with its own line", async () => {
    const result = await diagramTool.execute(
      { title: "T", mermaid: "flowchart TD\n  A[Start] -> B[Fine]" },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('line 2, col 12: "->" is not an arrow in a flowchart');
  });

  test("a fenced source keeps the MODEL's line numbers in mermaid's error", async () => {
    const result = await diagramTool.execute(
      { title: "T", mermaid: "```mermaid\nflowchart TD\n  A[Start] -> B[Fine]\n```" },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("line 3");
  });

  test("a colon-less sequence message", async () => {
    const result = await diagramTool.execute(
      { title: "T", mermaid: "sequenceDiagram\n  A->>B\n  B->>A: ok" },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("line 2: a message needs text after a colon");
  });

  test("a lint error never reaches mermaid: pie → use the chart tool", async () => {
    let called = false;
    const tool = createDiagramTool({
      parse: async () => {
        called = true;
        return { ok: true };
      },
    });
    const result = await tool.execute({ title: "T", mermaid: 'pie\n  "a" : 3' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("chart");
    expect(called).toBe(false);
  });

  test("missing / wrong fields: every error at once, each with its fix", async () => {
    const result = await diagramTool.execute({ mermaid: 3 }, ctx());
    expect(result.isError).toBe(true);
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith('"title" is required');
    expect(lines[1]).toStartWith('"mermaid" must be the Mermaid source as one string');
  });

  test("a title over 120 characters is refused with its cap", async () => {
    const result = await diagramTool.execute(
      { title: "x".repeat(121), mermaid: "flowchart TD\n A --> B" },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("120");
  });
});

describe("T2.3 the result stands alone (an old client shows only it)", () => {
  test("it says what the user sees, without the source", async () => {
    const result = await diagramTool.execute(
      { title: "Ordini", mermaid: "erDiagram\n  CUSTOMER ||--o{ ORDER : places" },
      ctx(),
    );
    expect(result.content).toBe('Diagram shown to the user: erDiagram "Ordini" · 2 lines');
  });
});

describe("T2.4 a build without mermaid answers, never crashes", () => {
  test("a loader that throws → `not available`, as a value", async () => {
    const loader = async (): Promise<MermaidParser> => {
      throw new Error("Cannot find module 'mermaid'");
    };
    const first = await parseMermaid("flowchart TD\n A --> B", { loader });
    expect(first).toEqual({
      ok: false,
      reason: "unavailable",
      detail: "Cannot find module 'mermaid'",
    });

    const tool = createDiagramTool({ parse: (src) => parseMermaid(src, { loader }) });
    const result = await tool.execute({ title: "T", mermaid: "flowchart TD\n A --> B" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("diagrams are not available in this build");
  });

  test("the shared loader retries a FAILED load, and loads a good one once", async () => {
    let loads = 0;
    const loader = cachedMermaidLoader(async () => {
      loads += 1;
      if (loads === 1) throw new Error("transient");
      return async () => undefined;
    });
    const src = "flowchart TD\n A --> B";
    expect((await parseMermaid(src, { loader })).ok).toBe(false);
    expect(await parseMermaid(src, { loader })).toEqual({ ok: true });
    expect(await parseMermaid(src, { loader })).toEqual({ ok: true });
    expect(loads).toBe(2);
  });
});

describe("T2.5 a hanging parse is cut by the budget", () => {
  test("the parse never settles → `too complex` within the budget", async () => {
    const loader = async (): Promise<MermaidParser> => () => new Promise(() => {});
    const started = performance.now();
    const outcome = await parseMermaid("flowchart TD\n A --> B", { loader, budgetMs: 30 });
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    expect(performance.now() - started).toBeLessThan(1000);

    const tool = createDiagramTool({ parse: (src) => parseMermaid(src, { loader, budgetMs: 30 }) });
    const result = await tool.execute({ title: "T", mermaid: "flowchart TD\n A --> B" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too complex");
    expect(result.content).toContain("split it");
  });

  test("a parse that settles in time is not reported as a timeout", async () => {
    const loader = async (): Promise<MermaidParser> => async () => undefined;
    expect(await parseMermaid("flowchart TD\n A --> B", { loader, budgetMs: 30 })).toEqual({
      ok: true,
    });
  });
});

describe("T2.6 (daemon half) one mermaid version, pinned exact", () => {
  test("@tentacle/tools pins mermaid exactly, and that is the installed version", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const pin = pkg.dependencies.mermaid ?? "";
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    const installed = JSON.parse(
      readFileSync(join(import.meta.dir, "../node_modules/mermaid/package.json"), "utf8"),
    ) as { version: string };
    expect(installed.version).toBe(pin);
  });
});

describe("the tool's shape", () => {
  test("name, permission none, no resources, a hand-written schema naming `mermaid`", () => {
    expect(diagramTool.name).toBe(DIAGRAM_TOOL_NAME);
    expect(DIAGRAM_TOOL_NAME).toBe("diagram");
    expect(diagramTool.permission).toBe("none");
    const concurrency = diagramTool.concurrency;
    expect(typeof concurrency).toBe("function");
    if (typeof concurrency === "function") {
      expect(concurrency({ title: "T", mermaid: "" })).toEqual([]);
    }
    const schema = JSON.stringify(diagramTool.jsonSchema);
    expect(schema).toContain('"mermaid"');
    expect(schema).toContain('"required":["title","mermaid"]');
    expect(diagramTool.description).toContain("chart");
    expect(diagramTool.description).toContain("%%{init}%%");
  });

  test("the registry offers the hand-written schema, and answers through it", async () => {
    const registry = new ToolRegistry();
    registry.register(diagramTool);
    const definition = registry.definitions().find((d) => d.name === DIAGRAM_TOOL_NAME);
    expect(JSON.stringify(definition?.parameters)).toContain('"mermaid"');
    const result = await registry.execute(
      DIAGRAM_TOOL_NAME,
      JSON.stringify({ title: "T", mermaid: "flowchart TD\n  A --> B" }),
      ctx(),
    );
    expect(result.content).toStartWith('Diagram shown to the user: flowchart "T"');
  });
});

describe("the raw-JSON hint", () => {
  test("a literal line break inside the `mermaid` string gets the \\n hint", async () => {
    const raw = '{"title":"T","mermaid":"flowchart TD\n  A --> B"}';
    expect(diagramArgumentsHint(raw)).toBe(DIAGRAM_ARGUMENTS_HINT);
    const registry = new ToolRegistry();
    registry.register(diagramTool);
    const result = await registry.execute(DIAGRAM_TOOL_NAME, raw, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain(DIAGRAM_ARGUMENTS_HINT);
  });

  test("a backtick-quoted source gets it too", () => {
    expect(diagramArgumentsHint('{"title":"T","mermaid":`flowchart TD`}')).toBe(
      DIAGRAM_ARGUMENTS_HINT,
    );
  });

  test("a pretty-printed object (line breaks BETWEEN keys) and a plain typo get no hint", () => {
    expect(
      diagramArgumentsHint('{\n  "title": "T",\n  "mermaid": "flowchart TD\\n A --> B"\n}'),
    ).toBeUndefined();
    expect(diagramArgumentsHint('{"title":"T","mermaid":"flowchart TD"')).toBeUndefined();
  });
});
