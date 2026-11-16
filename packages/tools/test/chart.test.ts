/**
 * T2 — the `chart` tool (docs/feat/model-charts.md D3, slice C2): the model's one
 * way to draw the numbers it talks about.
 *
 * What this file pins, and why each one can silently rot:
 *
 * - T2.1 the result line is the SHARED summary (`summarizeChart`, T1.16), never a
 *   second wording: it is the model's feedback AND an old client's fallback, so a
 *   drift here is invisible on a new client and confusing on an old one. The
 *   validator's notes (dropped styling keys) ride it, because that is the one
 *   place the model reads.
 * - T2.2 a NaN/Infinity — which JSON cannot express — gets one plain sentence on
 *   top of the registry's generic "invalid JSON arguments" (a small model
 *   otherwise resends the same non-JSON).
 * - T2.4 the result text stands alone: it is everything an old client shows, and
 *   the JSON Schema the model is offered is the hand-written one (`jsonSchema`),
 *   not a zod-derived guard that lost the rules.
 *
 * T2.3 (the artifact registration) is NOT here: it needs `ToolContext.artifacts`,
 * which arrives with feat/model-artifacts (plan P8). It moved to C8 — see the
 * task doc's Execution, drift 1.
 *
 * RED before the code: `chart` did not exist and `toolLabel("chart")` was "chart".
 */
import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment, ToolContext } from "@tentacle/core";
import { z } from "zod";
import { CHART_TOOL_NAME, chartTool } from "../src/chart.ts";
import { ToolRegistry } from "../src/index.ts";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "s1",
    signal: new AbortController().signal,
    env,
    toolCallId: "c1",
    ...extra,
  };
}

/** The owner's example, in D2's form (`format` is compact|full, never "k"). */
const REVENUE = {
  type: "line",
  title: "Ricavi mensili 2025 vs 2026",
  labels: ["gen", "feb", "mar"],
  datasets: [{ label: "Ricavi", data: [11800, 14000, 20800] }],
  y: { unit: "€", format: "compact" },
};

describe("T2.1 a valid call answers with the shared summary line", () => {
  test("the result is `Chart shown to the user: …` from summarizeChart", async () => {
    const reg = new ToolRegistry().register(chartTool);
    const result = await reg.execute(CHART_TOOL_NAME, JSON.stringify(REVENUE), ctx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      // `en` is `summarizeChart`'s default and stays deterministic here: the row
      // is model-facing, and a daemon (a pod's) has no reader locale to offer.
      'Chart shown to the user: line "Ricavi mensili 2025 vs 2026" · 1 series × 3 · y €11.8k–€20.8k',
    );
  });

  test("the validator's notes are said, not refused (dropped styling keys)", async () => {
    const styled = {
      ...REVENUE,
      datasets: [{ label: "Ricavi", data: [11800, 14000, 20800], tension: 0.4 }],
    };
    const result = await chartTool.execute(styled, ctx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("ignored tension — the app chooses colours and styling");
  });

  test("an invalid spec is an error carrying the validator's sentences (one retry is enough)", async () => {
    const result = await chartTool.execute(
      { ...REVENUE, datasets: [{ label: "Ricavi", data: ["12.5", "14,1", "13.8"] }] },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('datasets[0].data[0] is the string "12.5"');
    expect(result.content).toContain("write 14.1 (dot as decimal separator");
  });

  test('`permission: "none"` — showing is never acting', () => {
    expect(chartTool.permission).toBe("none");
  });

  test("the tool touches no resource: two charts never conflict", () => {
    const concurrency = chartTool.concurrency;
    expect(typeof concurrency).toBe("function");
    if (typeof concurrency !== "function") return;
    expect(concurrency(REVENUE)).toEqual([]);
    expect(concurrency("not a spec")).toEqual([]);
  });
});

describe("T2.2 NaN / Infinity (not JSON) get the hint once", () => {
  test("the registry's JSON error carries it — the tool's execute never runs", async () => {
    const reg = new ToolRegistry().register(chartTool);
    const broken = '{"type":"line","title":"T","datasets":[{"label":"A","data":[NaN]}]}';
    const result = await reg.execute(CHART_TOOL_NAME, broken, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid JSON arguments for chart");
    expect(result.content).toContain("NaN/Infinity are not JSON — use null");
  });

  test("a plain syntax error gets NO hint: a wrong diagnosis costs a retry too", async () => {
    const reg = new ToolRegistry().register(chartTool);
    const result = await reg.execute(CHART_TOOL_NAME, "{not json", ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe("invalid JSON arguments for chart");
  });

  test("`undefined` — the other word a model writes for a gap", async () => {
    const reg = new ToolRegistry().register(chartTool);
    const result = await reg.execute(
      CHART_TOOL_NAME,
      '{"type":"line","title":"T","datasets":[{"label":"A","data":[1,undefined]}]}',
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("NaN/Infinity are not JSON — use null");
  });

  test("a tool WITHOUT a hint keeps the registry's message byte-identical", async () => {
    // The seam must be invisible to the other 123 call sites: no trailing
    // newline, no empty second line.
    const plain = new ToolRegistry().register({
      name: "plain",
      description: "d",
      inputSchema: z.object({}),
      permission: "none",
      execute: () => Promise.resolve({ content: "ok" }),
    });
    const result = await plain.execute("plain", "NaN", ctx());
    expect(result.content).toBe("invalid JSON arguments for plain");
  });
});

describe("T2.4 an old client's fallback is the result text alone, and it stands alone", () => {
  test("it names the type, the title, the shape and the y extent", async () => {
    const result = await chartTool.execute(REVENUE, ctx());
    expect(result.content).toBe(
      // `en` is `summarizeChart`'s default and stays deterministic here: the row
      // is model-facing, and a daemon (a pod's) has no reader locale to offer.
      'Chart shown to the user: line "Ricavi mensili 2025 vs 2026" · 1 series × 3 · y €11.8k–€20.8k',
    );
  });

  test("the model is offered the hand-written JSON Schema, with its rules", () => {
    const definition = new ToolRegistry().register(chartTool).definitions()[0];
    expect(definition?.name).toBe("chart");
    const parameters = JSON.stringify(definition?.parameters);
    // The rules a small model needs, in the schema it reads (`jsonSchema`, D2).
    expect(parameters).toContain("never two axes");
    expect(parameters).toContain("12.5");
    // Never the permissive runtime guard, zod would have flattened it to `{}`.
    expect(parameters).not.toBe("{}");
  });

  test("the description says when NOT to chart, and that styling is never its business", () => {
    expect(chartTool.description).toContain("two charts");
    expect(chartTool.description).toContain("colour");
  });

  test("an over-cap spec is refused with the cap's advice (never drawn half-way)", async () => {
    const huge = {
      type: "line",
      title: "T",
      labels: Array.from({ length: 1000 }, (_, i) => `etichetta-lunga-${String(i)}`),
      datasets: Array.from({ length: 8 }, (_, s) => ({
        label: `Serie ${s}`,
        data: Array.from({ length: 1000 }, (_, i) => 1234.5678 + i + s),
      })),
    };
    const refused = await chartTool.execute(huge, ctx());
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("the chart is too large (100 KiB > 64 KiB)");
  });
});
