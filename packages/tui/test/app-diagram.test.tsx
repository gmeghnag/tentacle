/**
 * T4 (docs/feat/model-diagrams.md, slice D4): a `diagram` call DRAWS in the
 * transcript through the REAL App — live and after a resume, at every width
 * (a resize re-lays it out), expanded by Ctrl+O and by a click on its caption,
 * and a forged source falls back to the generic tool row. Nothing it draws
 * writes to `process.stdout` (AGENTS §7).
 *
 * The sibling of `app.test.tsx`'s "a chart in the App (C4/T4)": same harness
 * (`ink-testing-library`, SGR stripped, AGENTS §6), separate file so the
 * diagram's frames stay in one place.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry, createDiagramTool } from "@tentacle/tools";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { App } from "../src/App.tsx";
import type { AppProps } from "../src/app-types.ts";
import { messagesToItems } from "../src/resume.ts";
import { LOGIN, args } from "./diagram-fixtures.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const rowsOf = (frame: string): string[] => frame.split("\n").map(strip);
/** The drawn glyphs of the flow renderer: a box corner and the decision mark. */
const BOX = "╭";
const DECISION = "◇";
/** The caption's tier note, cut at narrow widths — so only its head is pinned. */
const SOURCE_ONLY = "source only";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
  readFile() {
    throw new Error("unused");
  },
  writeFile() {
    throw new Error("unused");
  },
};

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const LOGIN_ARGS = args("Flusso di login", LOGIN);
/** A flowchart whose labels do NOT fit 50 columns: drawn at 120, source at 50. */
const WIDE = `flowchart TD
  A[Richiesta di autenticazione con token] --> B{Il token è valido?}
  B -- sì --> C[Carica la sessione dell'utente]
  B -- no --> D[Mostra la pagina di login]
  D --> E[(Database degli utenti)]
  C --> F[Risposta]
  E --> G[Log delle sessioni]
  F --> G`;
const WIDE_ARGS = args("Autenticazione", WIDE);

/** A `diagram` tool whose daemon-side Mermaid parse always accepts (D2's seam). */
const acceptingTool = () => createDiagramTool({ parse: async () => ({ ok: true }) });

const noAgent = (): Agent =>
  new Agent({ model: new ScriptedProvider([]), tools: new ToolRegistry(), env: noopEnv });

/** The same call as a resumed conversation (`--resume`): only `args` survive. */
function history(argsJson: string, title: string): ChatMessage[] {
  return [
    { role: "user", content: "disegna il flusso" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "d1", name: "diagram", arguments: argsJson }],
    },
    { role: "tool", content: `Diagram shown to the user: flowchart "${title}"`, toolCallId: "d1" },
  ];
}

const CTRL_O = "\u000F";
const press = (x: number, y: number): string => `\u001B[<0;${x};${y}M`;
const release = (x: number, y: number): string => `\u001B[<0;${x};${y}m`;

/**
 * `ink-testing-library`'s default terminal is 24 rows / 100 columns, and a drawn
 * diagram is taller than that: an overflowing frame loses its TOP rows (the
 * caption, and with it the click target). Every test here mounts, then commits
 * an 80-row screen at `columns` — `app.test.tsx`'s order, so the App's resize
 * subscription is already live when the new size lands.
 */
async function mountApp(props: AppProps, columns = 120) {
  const app = render(<App {...props} />);
  await delay(40);
  Object.defineProperty(app.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(app.stdout, "rows", { value: 80, configurable: true });
  app.stdout.emit("resize");
  await delay(120);
  return app;
}

/** A resumed `diagram` conversation, mounted on an 80-row screen. */
function mountHistory(argsJson = LOGIN_ARGS, title = "Flusso di login", columns = 120) {
  return mountApp(
    {
      agent: noAgent(),
      model: "qwen3",
      cwd: "/tmp/work",
      initialItems: messagesToItems(history(argsJson, title)),
    },
    columns,
  );
}

/** The 1-based screen row of the diagram's row 0 (its caption). */
function captionRow(frame: string, caption: string): number {
  return rowsOf(frame).findIndex((r) => r.includes(caption)) + 1;
}

describe("a diagram in the App (T4)", () => {
  test("live: the diagram draws in place of the tool row", async () => {
    // Mutation: drop the `diagramRow` branch in `toolLines` → the frame shows
    // `● Diagram Flusso di login` and no box.
    const agent = new Agent({
      model: new ScriptedProvider([
        [
          { type: "tool_call", toolCall: { id: "d1", name: "diagram", arguments: LOGIN_ARGS } },
          { type: "done" },
        ],
        [{ type: "text", delta: "Ecco il flusso." }, { type: "done" }],
      ]),
      tools: new ToolRegistry().register(acceptingTool()),
      env: noopEnv,
    });
    const app = await mountApp({ agent, model: "qwen3", cwd: "/tmp/work" });
    try {
      app.stdin.write("disegna il flusso");
      await delay(30);
      app.stdin.write("\r");
      await delay(400);
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Flusso di login · flowchart");
      expect(frame).toContain(BOX);
      expect(frame).toContain(DECISION);
      // No tool chrome on that row: the caption IS the row.
      expect(frame).not.toContain("● Diagram");
      // Compact draws no source.
      expect(frame).not.toContain("A[Richiesta]");
    } finally {
      app.unmount();
    }
  });

  test("live: a source mermaid REFUSES shows the generic error row, not a diagram", async () => {
    // The whole point of D2's daemon-side parse: the lint can pass and mermaid
    // still refuse. That call is `status: "error"`, and drawing it would show a
    // diagram that never existed, its reason gone (review D4 finding 1).
    // Mutation: drop the `error` guard in `diagramRow` → this frame draws the
    // box and loses the error text.
    const refusing = createDiagramTool({
      parse: async () => ({
        ok: false,
        reason: "invalid",
        error: new Error('Parse error on line 2: unknown diagram type ""theme":"dark""'),
      }),
    });
    const agent = new Agent({
      model: new ScriptedProvider([
        [
          { type: "tool_call", toolCall: { id: "d1", name: "diagram", arguments: LOGIN_ARGS } },
          { type: "done" },
        ],
        [{ type: "text", delta: "Riprovo." }, { type: "done" }],
      ]),
      tools: new ToolRegistry().register(refusing),
      env: noopEnv,
    });
    const app = await mountApp({ agent, model: "qwen3", cwd: "/tmp/work" });
    try {
      app.stdin.write("disegna il flusso");
      await delay(30);
      app.stdin.write("\r");
      await delay(400);
      const frame = app.lastFrame() ?? "";
      const text = rowsOf(frame).join("\n");
      expect(text).toContain("● Diagram");
      expect(text).not.toContain(BOX);
      expect(text).not.toContain(DECISION);
      // The reason mermaid gave is still on screen, not swallowed by a drawing.
      expect(text).toMatch(/unknown diagram type|does not seem to be a valid diagram|not valid/i);
    } finally {
      app.unmount();
    }
  });

  test("after a resume: the same diagram, from the stored arguments", async () => {
    // Mutation: draw only from a live `tool_start` item (read something other
    // than `args`) → red: a resumed row has only `args`.
    const app = await mountHistory();
    try {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Flusso di login · flowchart");
      expect(frame).toContain(BOX);
      expect(frame).not.toContain("● Diagram");
    } finally {
      app.unmount();
    }
  });

  test("ctrl+o expands to the drawing + the whole source, and collapses again", async () => {
    const app = await mountHistory();
    try {
      const collapsed = rowsOf(app.lastFrame() ?? "");
      expect(collapsed.some((r) => r.includes("A[Richiesta]"))).toBe(false);
      app.stdin.write(CTRL_O);
      await delay(120);
      const expanded = rowsOf(app.lastFrame() ?? "");
      const text = expanded.join("\n");
      // The drawing AND every source line (`│ `-prefixed, highlighted).
      expect(text).toContain(BOX);
      const sourceRows = expanded.filter((r) => r.trimStart().startsWith("│ ")).join("\n");
      expect(sourceRows).toContain("A[Richiesta] --> B{Token valido?}");
      expect(sourceRows).toContain("D --> E[(Database utenti)]");
      app.stdin.write(CTRL_O);
      await delay(120);
      const again = rowsOf(app.lastFrame() ?? "");
      expect(again.length).toBe(collapsed.length);
      expect(again.some((r) => r.includes("A[Richiesta]"))).toBe(false);
    } finally {
      app.unmount();
    }
  });

  test("a click on the caption expands that call (the caption is row 0)", async () => {
    const app = await mountHistory();
    try {
      const y = captionRow(app.lastFrame() ?? "", "Flusso di login");
      expect(y).toBeGreaterThan(0);
      expect(rowsOf(app.lastFrame() ?? "").some((r) => r.includes("A[Richiesta]"))).toBe(false);
      app.stdin.write(press(3, y));
      app.stdin.write(release(3, y));
      await delay(120);
      expect(app.lastFrame() ?? "").toContain("A[Richiesta] --> B{Token valido?}");
    } finally {
      app.unmount();
    }
  });

  test("a resize 120 → 50 → 120 re-lays it out (drawing ⇄ source)", async () => {
    // The renderer is a pure function of the width, so the memo keys on it:
    // mutation = memoise on the item alone → the 120-col drawing survives at 50.
    const app = await mountHistory(WIDE_ARGS, "Autenticazione");
    const widest = (frame: string): number =>
      rowsOf(frame).reduce((w, r) => Math.max(w, stringWidth(r.trimEnd())), 0);
    try {
      const at120 = app.lastFrame() ?? "";
      expect(at120).toContain(BOX);
      expect(at120).not.toContain(SOURCE_ONLY);

      Object.defineProperty(app.stdout, "columns", { value: 50, configurable: true });
      app.stdout.emit("resize");
      await delay(200);
      const at50 = app.lastFrame() ?? "";
      // The wide flowchart no longer fits: the source, with the generic cut.
      expect(at50).toContain(SOURCE_ONLY);
      expect(at50).not.toContain(BOX);
      expect(at50).toContain("more lines · ctrl+o to expand");
      expect(at50).toContain("A[Richiesta di autenticazione");
      expect(widest(at50)).toBeLessThanOrEqual(50);

      Object.defineProperty(app.stdout, "columns", { value: 120, configurable: true });
      app.stdout.emit("resize");
      await delay(200);
      const back = app.lastFrame() ?? "";
      expect(back).toContain(BOX);
      expect(back).not.toContain(SOURCE_ONLY);
    } finally {
      app.unmount();
    }
  });

  test("a forged source is a generic row, never a crash", async () => {
    // Mutation: `diagramToolBody` without `parseDiagramArgs` (i.e. draw whatever
    // `diagramModel` makes of the text) → red: the row is drawn instead of the
    // `● Diagram` header.
    const app = await mountHistory(args("Grafico", "grpah TD\n  A --> B"), "Grafico");
    try {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("● Diagram");
      expect(frame).toContain("Grafico");
      expect(frame).not.toContain(BOX);
      expect(frame).not.toContain(DECISION);
    } finally {
      app.unmount();
    }
  });

  test("nothing is written to process.stdout while a diagram draws (AGENTS §7)", async () => {
    const spy = spyOn(process.stdout, "write").mockImplementation(() => true);
    const app = await mountHistory();
    try {
      expect(app.lastFrame() ?? "").toContain(BOX);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      app.unmount();
      spy.mockRestore();
    }
  });
});
