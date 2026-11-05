import { describe, expect, test } from "bun:test";
import { contextMeterView, modelBorder, shortPath, statusLayout } from "../src/status-line.ts";
import { contextShown } from "../src/status-view.ts";

describe("modelBorder: the model name right-aligned on the input's top border", () => {
  test("fits: rule, space, model, space, one dash — exactly `width` cells", () => {
    const row = modelBorder("qwen3", 30);
    expect(row).toBe(`${"─".repeat(30 - 5 - 3)} qwen3 ─`);
    expect([...row].length).toBe(30);
  });

  test("too long: cut on the LEFT with an ellipsis, still `width` cells, tail kept", () => {
    const model = "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017";
    const row = modelBorder(model, 24);
    expect([...row].length).toBe(24);
    expect(row.endsWith("Flash-1017 ─")).toBe(true);
    expect(row).toContain(" …");
    expect(row).not.toContain("rits");
  });

  test("a terminal too narrow for any model: a plain rule", () => {
    expect(modelBorder("qwen3", 6)).toBe("──────");
  });

  test("no model: a plain rule", () => {
    expect(modelBorder("", 10)).toBe("─".repeat(10));
  });
});

describe("shortPath: the path shrinks to the room it is given", () => {
  test("home → ~; short paths whole", () => {
    expect(shortPath("/home/u/trash", "/home/u", 40)).toBe("~/trash");
  });
  test("over `max`: `…` + tail, exactly max cells", () => {
    const p = shortPath("/very/long/path/to/some/where", undefined, 10);
    expect([...p].length).toBe(10);
    expect(p.startsWith("…")).toBe(true);
    expect(p.endsWith("where")).toBe(true);
  });
});

describe("statusLayout (round 2, MEDIUM 2/3): one row, the path shrinks first, ctx max always visible", () => {
  const OFF = " ⏵⏵ auto-accept off (shift+tab) ";
  const meter = contextMeterView(9000, true, 128000);
  const base = {
    columns: 80,
    linkText: null,
    target: null,
    cwd: "/Users/someone/projects/deep/nested/folder",
    home: undefined,
    tokens: null,
    meter,
    hint: OFF,
    suffix: "",
  } as const;
  const cells = (s: string): number => [...s].length;

  test("80 columns, long cwd, local: fits one row, the path gives way, `(~9k/128k)` whole", () => {
    const l = statusLayout(base);
    expect(cells(l.plain)).toBeLessThanOrEqual(80);
    expect(l.plain).toContain("ctx █░░░░░░░░░ ~7% (~9k/128k)");
    expect(l.path?.startsWith("…")).toBe(true);
    expect(l.hint).toBe(OFF);
  });

  test("80 columns with a docker badge: badge whole, ctx max whole", () => {
    const l = statusLayout({
      ...base,
      target: { engine: "docker", name: "tentacle-ba89d072" },
      tokens: { prompt: 12000, completion: 700 },
    });
    expect(cells(l.plain)).toBeLessThanOrEqual(80);
    expect(l.plain.startsWith("docker tentacle-ba89d072 · ")).toBe(true);
    expect(l.plain).toContain("~9k/128k)");
  });

  test("narrower: the hint is dropped, then tokens, then the bar — ctx max stays", () => {
    const l = statusLayout({ ...base, columns: 40, tokens: { prompt: 12000, completion: 700 } });
    expect(cells(l.plain)).toBeLessThanOrEqual(40);
    expect(l.plain).toContain("~9k/128k)");
    expect(l.hint).toBeNull();
  });

  test("40 columns, docker badge: still one row, ctx max visible, badge cut only as needed", () => {
    const l = statusLayout({
      ...base,
      columns: 40,
      target: { engine: "docker", name: "tentacle-ba89d072" },
    });
    expect(cells(l.plain)).toBeLessThanOrEqual(40);
    expect(l.plain).toContain("~9k/128k)");
    expect(l.plain.startsWith("docker ")).toBe(true);
  });

  test("a badge wider than the terminal: one row, the NAME cut in the middle, engine word kept", () => {
    const l = statusLayout({
      ...base,
      columns: 40,
      target: {
        engine: "kubernetes",
        name: "a-very-long-pod-name-that-kubernetes-does-allow-here",
        container: "sidecar",
      },
    });
    expect(cells(l.plain)).toBeLessThanOrEqual(40);
    expect(l.badge?.startsWith("pod ")).toBe(true);
    expect(l.badge?.endsWith("/sidecar")).toBe(true);
    expect(l.badge).toContain("…");
    expect(l.plain).toContain("~9k/128k)");
  });

  test("round 3: a long link message gives way to the compact meter and the whole badge (40 and 80)", () => {
    const linkText = `disconnected: ${"x".repeat(47)}`;
    const target = { engine: "kubernetes", name: "dev-pod", container: "app" } as const;
    for (const columns of [40, 80]) {
      const l = statusLayout({ ...base, columns, target, linkText });
      expect(cells(l.plain)).toBeLessThanOrEqual(columns);
      expect(l.plain).toContain("~9k/128k)");
      expect(l.badge).toBe("pod dev-pod/app");
      // The same badge as with no link at all.
      expect(l.badge).toBe(statusLayout({ ...base, columns, target }).badge);
    }
  });

  test("round 3: no room left for any link text: the link is dropped, ctx stays", () => {
    const l = statusLayout({
      ...base,
      columns: 40,
      target: { engine: "kubernetes", name: "x".repeat(60) },
      linkText: "reconnecting…",
    });
    expect(cells(l.plain)).toBeLessThanOrEqual(40);
    expect(l.plain).toContain("~9k/128k)");
  });

  test("a wide terminal: nothing is cut, the full hint stays", () => {
    const l = statusLayout({ ...base, columns: 200, cwd: "/tmp/work" });
    expect(l.path).toBe("/tmp/work");
    expect(l.hint).toBe(OFF);
  });

  test("the link state's cells are accounted for (never past the line)", () => {
    const l = statusLayout({ ...base, linkText: "reconnecting…" });
    expect(cells(l.plain)).toBeLessThanOrEqual(80);
    expect(l.linkCells).toBe("reconnecting…".length + 3);
  });
});

describe("contextShown: measured beats the open figure", () => {
  test("measured wins, exact", () => {
    expect(contextShown(5000, { used: 9000, exact: false })).toEqual({ used: 5000, approx: false });
  });
  test("no turn measured: the open figure, approx unless exact", () => {
    expect(contextShown(null, { used: 9000, exact: false })).toEqual({ used: 9000, approx: true });
    expect(contextShown(null, { used: 9000, exact: true })).toEqual({ used: 9000, approx: false });
  });
  test("nothing known: null", () => {
    expect(contextShown(null, null)).toEqual({ used: null, approx: false });
  });
});

describe("contextMeterView: ctx always carries its max", () => {
  test("unknown used: `–` against the max", () => {
    expect(contextMeterView(null, false, 128000)).toEqual({ kind: "unknown", max: "128k" });
  });
  test("exact", () => {
    expect(contextMeterView(64000, false, 128000)).toEqual({
      kind: "known",
      fraction: 0.5,
      filled: 5,
      percent: "50%",
      used: "64k",
      max: "128k",
    });
  });
  test("estimate: `~` on the percent and the used count", () => {
    const v = contextMeterView(9000, true, 128000);
    expect(v).toMatchObject({ kind: "known", percent: "~7%", used: "~9k", max: "128k", filled: 1 });
  });
});
