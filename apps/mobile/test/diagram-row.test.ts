/**
 * T5.1/T5.3, the row's decision (docs/feat/model-diagrams.md D5): a `diagram`
 * call draws itself in the row's place, and its caption/VoiceOver text come from
 * core's ONE summary — exactly the split `chartRowSpec` makes for `chart`.
 *
 * The gate is the mirror of `chartRow`'s (`name === "diagram"`, not `error`, not
 * `denied`) PLUS the client-side re-lint: a pod can forge `rawInput`, so the
 * source is re-linted on every draw and a refused one keeps the generic row.
 */
import { describe, expect, test } from "bun:test";
import { DIAGRAM_CAPS } from "@tentacle/core";
import { chartRowSpec } from "../src/chart-row.ts";
import { diagramCacheKey } from "../src/diagram-cache.ts";
import {
  DIAGRAM_TOOL,
  type DiagramToolRow,
  diagramRowSpec,
  diagramRowView,
  diagramSummary,
} from "../src/diagram-row.ts";
import { darkPalette, lightPalette } from "../src/theme.ts";
import { REVENUE } from "./chart-fixtures.ts";

const SOURCE =
  "flowchart TD\n  A[Richiesta] --> B{Token valido?}\n  B -->|si| C[Ok]\n  B -->|no| D[Errore]";
const ARGS = JSON.stringify({ title: "Flusso di login", mermaid: SOURCE });

const chartRow = (status: string) =>
  chartRowSpec({ name: "chart", args: JSON.stringify(REVENUE), status });

const row = (over: Partial<DiagramToolRow> = {}): DiagramToolRow => ({
  name: DIAGRAM_TOOL,
  args: ARGS,
  status: "ok",
  ...over,
});

describe("diagramRowSpec — the transcript branch's decision", () => {
  test("the status half is exactly `chartRowSpec`'s, status for status (T5.1)", () => {
    // The plan's words: it "mirrors `chartRowSpec`". Pinned rather than asserted in
    // prose, so a future status added to one decision cannot silently skip the other.
    const statuses = ["queued", "running", "ok", "error", "denied", "who-knows"] as const;
    for (const status of statuses) {
      const chart = chartRow("ok") !== null && chartRow(status) !== null;
      expect({
        status,
        mirrors: chart === (diagramRowSpec(row({ status })) !== null),
      }).toEqual({ status, mirrors: true });
    }
    // …and the two cases that must NOT draw, stated as themselves.
    expect(chartRow("error")).toBeNull();
    expect(diagramRowSpec(row({ status: "error" }))).toBeNull();
  });

  test("a `diagram` call with a drawable source is drawn (ok and running)", () => {
    const spec = diagramRowSpec(row());
    expect(spec?.title).toBe("Flusso di login");
    expect(spec?.type).toBe("flowchart");
    expect(diagramRowSpec(row({ status: "running" }))?.title).toBe("Flusso di login");
  });

  test("a FAILED or DENIED call keeps the generic row, so the reason stays visible", () => {
    // `error` is the daemon's mermaid refusal AND a denial (permission-reply): our
    // re-lint cannot tell them apart from a good source, so the status decides.
    expect(diagramRowSpec(row({ status: "error" }))).toBeNull();
    expect(diagramRowSpec(row({ status: "denied" }))).toBeNull();
  });

  test("another tool with diagram-shaped arguments stays a generic row", () => {
    expect(diagramRowSpec(row({ name: "shell" }))).toBeNull();
    expect(diagramRowSpec(row({ name: "fs_write" }))).toBeNull();
    expect(diagramRowSpec(row({ name: "" }))).toBeNull();
  });

  test("forged arguments (a pod's rawInput) fall back to the generic row", () => {
    const forged: readonly string[] = [
      "",
      "{not json",
      "null",
      "[]",
      JSON.stringify({ mermaid: SOURCE }),
      JSON.stringify({ title: "", mermaid: SOURCE }),
      JSON.stringify({ title: "x".repeat(500), mermaid: SOURCE }),
      JSON.stringify({ title: "T", mermaid: 42 }),
      JSON.stringify({ title: "T", mermaid: "not a diagram at all" }),
      JSON.stringify({ title: "T", mermaid: 'pie\n  "a": 1' }),
      JSON.stringify({
        title: "T",
        mermaid: `flowchart TD\n  A[${"x".repeat(DIAGRAM_CAPS.bytes)}]`,
      }),
    ];
    for (const args of forged) {
      expect({ args: args.slice(0, 40), spec: diagramRowSpec(row({ args })) }).toEqual({
        args: args.slice(0, 40),
        spec: null,
      });
    }
  });

  test("a fenced source is accepted once the lint strips it (the tool's own rule)", () => {
    const fenced = JSON.stringify({ title: "T", mermaid: `\`\`\`mermaid\n${SOURCE}\n\`\`\`` });
    expect(diagramRowSpec(row({ args: fenced }))?.title).toBe("T");
  });

  test("a type the terminal cannot draw is still drawn on the phone (it renders it)", () => {
    const other = "classDiagram\n  class A\n  A : +x int";
    const spec = diagramRowSpec(row({ args: JSON.stringify({ title: "Classi", mermaid: other }) }));
    expect(spec?.type).toBe("classDiagram");
  });
});

describe("diagramSummary — the caption and VoiceOver text", () => {
  test("it is core's one summary, not a second wording", () => {
    const spec = diagramRowSpec(row());
    if (spec === null) throw new Error("the fixture must draw");
    expect(diagramSummary(spec)).toBe("flowchart Flusso di login: Richiesta → Token valido? → Ok");
  });

  test("a type we do not model still says what it is", () => {
    const spec = diagramRowSpec(
      row({ args: JSON.stringify({ title: "Classi", mermaid: "classDiagram\n  class A" }) }),
    );
    if (spec === null) throw new Error("the fixture must draw");
    expect(diagramSummary(spec)).toBe("classDiagram Classi: class A");
  });
});

describe("diagramRowView — what the component maps", () => {
  test("the view carries the re-validated source, the scheme and its theme", () => {
    const view = diagramRowView(row(), { palette: lightPalette, fontScale: 1 });
    expect(view?.title).toBe("Flusso di login");
    expect(view?.source.ok).toBe(true);
    expect(view?.scheme).toBe("light");
    expect(view?.accessibilityLabel).toBe(
      "flowchart Flusso di login: Richiesta → Token valido? → Ok",
    );
    expect(diagramRowView(row(), { palette: darkPalette, fontScale: 1 })?.scheme).toBe("dark");
  });

  test("the render key is the cache's, so a scheme or type-scale flip re-renders", () => {
    const spec = diagramRowSpec(row());
    if (spec === null) throw new Error("the fixture must draw");
    const light = diagramRowView(row(), { palette: lightPalette, fontScale: 1 });
    if (light === null) throw new Error("the fixture must draw");
    expect(light.renderKey).toBe(diagramCacheKey(spec.source.canonical, "light", 1));
    // Same source, different mode or scale: a different render, per the key.
    const dark = diagramRowView(row(), { palette: darkPalette, fontScale: 1 });
    const scaled = diagramRowView(row(), { palette: lightPalette, fontScale: 1.5 });
    expect(dark?.renderKey).not.toBe(light.renderKey);
    expect(scaled?.renderKey).not.toBe(light.renderKey);
    // …and a second call for the same row is the same key (it is a pure function).
    const again = diagramRowView(row(), { palette: lightPalette, fontScale: 1 });
    expect(again?.renderKey).toBe(light.renderKey);
  });

  test("a can't-draw row yields no view", () => {
    expect(
      diagramRowView(row({ status: "error" }), { palette: lightPalette, fontScale: 1 }),
    ).toBeNull();
    expect(
      diagramRowView(row({ args: "{not json" }), { palette: lightPalette, fontScale: 1 }),
    ).toBeNull();
  });

  test("the control bytes of a forged source never reach a caption", () => {
    const args = JSON.stringify({
      title: "T\u001b[31mred",
      mermaid: 'flowchart TD\n  A["x\u0007y"] --> B',
    });
    const view = diagramRowView(row({ args }), { palette: darkPalette, fontScale: 1 });
    expect(view?.title.includes("\u001b")).toBe(false);
    expect(view?.accessibilityLabel.includes("\u0007")).toBe(false);
  });
});
