import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { headCells } from "../src/cells.ts";
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

describe("round 4 (MEDIUM 1): shortPath and modelBorder measure cells (CJK, emoji)", () => {
  test("shortPath: a double-width path is cut to `max` CELLS", () => {
    for (const max of [8, 10, 20, 40]) {
      const p = shortPath("/ユーザー/フォルダの名前/さらに深い場所/🚀🚀🚀", undefined, max);
      expect(stringWidth(p)).toBeLessThanOrEqual(max);
      expect(p.startsWith("…")).toBe(true);
    }
  });

  test("modelBorder: exactly `width` cells with a double-width model name, cut on the left", () => {
    for (const width of [24, 30, 40, 80]) {
      const row = modelBorder("モデル名前/とても長いモデル識別子-v4.1-Flash", width);
      expect(stringWidth(row)).toBe(width);
      expect(row.endsWith(" ─")).toBe(true);
    }
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
  const cells = (s: string): number => stringWidth(s);

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
    expect(l.plain.startsWith("docker:tentacle-ba89d072 · ")).toBe(true);
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
    expect(l.plain.startsWith("docker:")).toBe(true);
  });

  test("a badge wider than the terminal: one row, the NAME cut in the middle, prefix kept", () => {
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
    expect(l.badge?.startsWith("k8s:")).toBe(true);
    expect(l.badge?.endsWith("/sidecar")).toBe(true);
    expect(l.badge).toContain("…");
    expect(l.plain).toContain("~9k/128k)");
  });

  const owner = {
    engine: "kubernetes",
    name: "etcd-guard-sharedocp419-f84rv-master-0",
    container: "guard",
  } as const;
  const longLink = "disconnected: connection refused by the remote daemon and more";

  test("round 4 (owner rule): the link beats the badge NAME — owner's frames at 40 and 80", () => {
    const at40 = statusLayout({ ...base, columns: 40, target: owner, linkText: longLink });
    // `disconnected · k8s:… · ctx …` is 41 cells: at 40 not even `k8s:…` fits beside
    // the first word and the meter, so the badge goes whole and the link gets the room.
    expect(at40.badge).toBeNull();
    expect(at40.plain.startsWith("disconnected")).toBe(true);
    expect(at40.plain.endsWith(" · ctx ~7% (~9k/128k)")).toBe(true);
    expect(cells(at40.plain)).toBeLessThanOrEqual(40);
    const at80 = statusLayout({ ...base, columns: 80, target: owner, linkText: longLink });
    expect(cells(at80.plain)).toBeLessThanOrEqual(80);
    expect(at80.plain.startsWith("disconnected: connection refused")).toBe(true);
    expect(at80.plain).toContain("/guard · ctx ~7% (~9k/128k)");
    expect(at80.badge?.startsWith("k8s:etcd-")).toBe(true);
  });

  test("round 4: the link keeps its first word whatever else gives way; the badge may go to `k8s:…`", () => {
    for (const columns of [41, 50]) {
      const l = statusLayout({ ...base, columns, target: owner, linkText: longLink });
      expect(l.plain.startsWith("disconnected")).toBe(true);
      expect(cells(l.plain)).toBeLessThanOrEqual(columns);
      expect(l.plain).toContain("~9k/128k)");
      expect(l.badge?.startsWith("k8s:")).toBe(true);
    }
  });

  test("round 4 (7): sweep — ASCII, CJK and emoji inputs × widths 30..130: one row, ctx max, engine word whole, link present ⇒ link shown", () => {
    const names = [
      "a",
      "etcd-guard-sharedocp419-f84rv-master-0",
      "ポッド名前テスト-ポッド名前テスト",
      "🚀🚀🚀-pod-🚀🚀🚀",
    ];
    const containers = [undefined, "guard", "c".repeat(63), "コンテナ-コンテナ", "🚀x"];
    const links = [null, "reconnecting…", longLink, `切断されました: ${"接続".repeat(20)}`];
    const cwds = ["/tmp/w", "/ユーザー/フォルダの名前/さらに深い場所/🚀🚀🚀"];
    const suffixes = ["", " · ↑12 more (↓ to follow)", " · expanded"];
    let frames = 0;
    for (let columns = 30; columns <= 130; columns += 4) {
      for (const name of names) {
        for (const container of containers) {
          for (const linkText of links) {
            for (const engine of ["kubernetes", "docker"] as const) {
              const suffix = suffixes[(columns + frames) % suffixes.length] ?? "";
              const l = statusLayout({
                ...base,
                columns,
                linkText,
                suffix,
                cwd: cwds[frames % cwds.length] ?? "/",
                tokens: frames % 2 === 0 ? { prompt: 54000, completion: 1200 } : null,
                target: {
                  engine,
                  name,
                  ...(container !== undefined && engine === "kubernetes" ? { container } : {}),
                },
              });
              frames++;
              const where = JSON.stringify({
                columns,
                name,
                container,
                linkText,
                engine,
                plain: l.plain,
              });
              expect({ where, ok: cells(l.plain) <= columns }).toEqual({ where, ok: true });
              expect({ where, ok: l.plain.includes("/128k)") }).toEqual({ where, ok: true });
              if (l.badge !== null) {
                const word = engine === "kubernetes" ? "k8s:" : "docker:";
                const long = engine === "kubernetes" ? "kubernetes:" : "docker:";
                expect({ where, ok: l.badge.startsWith(word) || l.badge.startsWith(long) }).toEqual(
                  {
                    where,
                    ok: true,
                  },
                );
                // A shown hint never cut the badge name.
                expect({ where, ok: l.suffix === "" || !l.badge.includes("…") }).toEqual({
                  where,
                  ok: true,
                });
              }
              if (linkText !== null) {
                const first = /^[^\s:]+/.exec(linkText)?.[0] ?? linkText;
                expect({ where, ok: l.plain.startsWith(headCells(first, 8)) }).toEqual({
                  where,
                  ok: true,
                });
              }
              expect({ where, ok: l.suffix === "" || l.suffix === suffix }).toEqual({
                where,
                ok: true,
              });
            }
          }
        }
      }
    }
    expect(frames).toBeGreaterThan(1000);
  });

  test("round 4: the link text is the layout's own (cut with `…`, separator), and the component paints it", () => {
    const l = statusLayout({ ...base, columns: 80, linkText: longLink });
    expect(l.link.endsWith(" · ")).toBe(true);
    expect(l.plain.startsWith(l.link)).toBe(true);
    expect(cells(l.link)).toBe(l.linkCells);
  });

  test("round 4 (owner rule): below the width where the engine word, separator and meter fit, the WHOLE badge goes; ctx stays whole — every width 20..30", () => {
    const meterCells = cells("ctx ~7% (~9k/128k)");
    for (const [engine, word] of [
      ["docker", "docker:"],
      ["kubernetes", "k8s:"],
    ] as const) {
      const threshold = cells(`${word}…`) + 3 + meterCells;
      for (let columns = 20; columns <= 30; columns++) {
        const l = statusLayout({
          ...base,
          columns,
          target: { engine, name: "some-long-workload-name" },
        });
        expect(l.plain).toContain("ctx ~7% (~9k/128k)");
        expect(cells(l.plain)).toBeLessThanOrEqual(columns);
        expect({ columns, badge: l.badge !== null }).toEqual({
          columns,
          badge: columns >= threshold,
        });
      }
    }
  });

  test("round 4: the scroll hint is counted in the badge limit and never cut — whole or dropped", () => {
    const suffix = " · ↑12 more (↓ to follow)";
    for (const columns of [40, 60, 80, 100]) {
      const l = statusLayout({ ...base, columns, target: owner, suffix });
      expect(cells(l.plain)).toBeLessThanOrEqual(columns);
      expect(l.plain).toContain("~9k/128k)");
      expect(l.suffix === "" || l.suffix === suffix).toBe(true);
      expect(l.plain.includes("↑12 mor") && l.suffix === "").toBe(false);
    }
    expect(statusLayout({ ...base, columns: 101, target: owner, suffix }).suffix).toBe(suffix);
    expect(statusLayout({ ...base, columns: 100, target: owner, suffix }).suffix).toBe("");
    expect(statusLayout({ ...base, columns: 40, target: owner, suffix }).suffix).toBe("");
  });

  test("round 4 (MEDIUM 1): terminal CELLS, not code points — CJK and emoji cwd / names / link", () => {
    const wide = "/ユーザー/フォルダの名前/さらに深い場所/🚀🚀🚀/データ";
    const names = ["ポッド名前テスト-ポッド名前テスト", "🚀🚀🚀🚀🚀🚀🚀🚀-pod"];
    for (const columns of [30, 40, 80]) {
      for (const name of names) {
        for (const linkText of [null, "reconnecting…", `切断されました: ${"接続".repeat(20)}`]) {
          const l = statusLayout({
            ...base,
            columns,
            cwd: wide,
            linkText,
            target: { engine: "kubernetes", name, container: "コンテナ" },
          });
          expect(cells(l.plain)).toBeLessThanOrEqual(columns);
          expect(l.plain).toContain("(~9k/128k)");
        }
      }
      const local = statusLayout({ ...base, columns, cwd: wide });
      expect(cells(local.plain)).toBeLessThanOrEqual(columns);
      expect(local.plain).toContain("(~9k/128k)");
    }
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

describe("final pass (3, 6): the scroll hint and `expanded` never cut the badge NAME", () => {
  const meter = contextMeterView(9000, true, 128000);
  const owner = {
    engine: "kubernetes",
    name: "etcd-guard-sharedocp419-f84rv-master-0",
    container: "guard",
  } as const;
  const base = {
    linkText: null,
    target: owner,
    cwd: "/x/y",
    home: undefined,
    tokens: null,
    meter,
    hint: " ⏵⏵ auto-accept off (shift+tab) ",
    suffix: "",
  } as const;
  const scrolled = " · ↑12 more (↓ to follow)";
  const expanded = " · expanded";
  const at80 = "kubernetes:etcd-guard-sharedocp419-f84rv-master-0/guard · ctx ~7% (~9k/128k)";
  const at40 = "k8s:etcd…er-0/guard · ctx ~7% (~9k/128k)";

  test("owner frames: 80 columns whole `kubernetes:…`; 40 columns `k8s:etcd…er-0/guard`", () => {
    expect(statusLayout({ ...base, columns: 80 }).plain).toBe(at80);
    expect(statusLayout({ ...base, columns: 40 }).plain).toBe(at40);
  });

  test("scrolled and expanded, at 80 and at 40: the same frame — the name is never cut, the hint is omitted", () => {
    for (const suffix of [scrolled, expanded]) {
      const a = statusLayout({ ...base, columns: 80, suffix });
      expect(a.plain).toBe(at80);
      expect(a.suffix).toBe("");
      const b = statusLayout({ ...base, columns: 40, suffix });
      expect(b.plain).toBe(at40);
      expect(b.suffix).toBe("");
    }
  });

  test("a hint that fits WHOLE beside the whole badge is shown", () => {
    const l = statusLayout({ ...base, columns: 120, suffix: scrolled });
    expect(l.suffix).toBe(scrolled);
    expect(l.plain.startsWith("kubernetes:etcd-guard-sharedocp419-f84rv-master-0/guard · ")).toBe(
      true,
    );
    expect(l.plain.endsWith(`~9k/128k)${scrolled}`)).toBe(true);
  });

  test("a hint beside a link that cut the name is omitted too", () => {
    const link = "disconnected: connection refused by the remote daemon and more";
    for (let columns = 60; columns <= 110; columns++) {
      const l = statusLayout({ ...base, columns, linkText: link, suffix: expanded });
      expect(l.suffix === "" || !(l.badge ?? "").includes("…")).toBe(true);
    }
  });
});

describe("final pass (2, 4, 5): narrow widths, a multi-line link, no double ellipsis", () => {
  const meter = contextMeterView(9000, true, 128000);
  const base = {
    linkText: null,
    target: null,
    cwd: "/x/y",
    home: undefined,
    tokens: null,
    meter,
    hint: " ⏵⏵ auto-accept off (shift+tab) ",
    suffix: "",
  } as const;
  const CTX = "ctx ~7% (~9k/128k)";
  const link = "disconnected: connection refused by the remote daemon and more";

  test("under ~33 columns the meter stays whole and the link is a fragment — pinned (no marker)", () => {
    const frames: Record<number, string> = {};
    for (let columns = 20; columns <= 32; columns++) {
      const l = statusLayout({ ...base, columns, linkText: link });
      frames[columns] = l.plain;
      expect(l.plain.endsWith(CTX)).toBe(true);
      expect(stringWidth(l.plain)).toBeLessThanOrEqual(columns);
      expect(l.plain).not.toContain("· ·");
      expect(l.plain.startsWith(" ")).toBe(false);
    }
    expect(frames[20]).toBe(CTX);
    expect(frames[22]).toBe(`d · ${CTX}`);
    expect(frames[26]).toBe(`disco · ${CTX}`);
    expect(statusLayout({ ...base, columns: 33, linkText: link }).plain).toBe(
      `disconnected · ${CTX}`,
    );
  });

  test("a newline (or other control character) in the link text never gives a second row", () => {
    const control = /[\n\r\t]/;
    for (const text of ["disconnected: line one\nline two", "disconnected: a\r\nb\tcd"]) {
      for (const columns of [30, 40, 80, 120]) {
        const l = statusLayout({ ...base, columns, linkText: text });
        expect(control.test(l.plain)).toBe(false);
        expect(control.test(l.link)).toBe(false);
        expect(stringWidth(l.plain)).toBeLessThanOrEqual(columns);
      }
    }
    expect(
      statusLayout({ ...base, columns: 80, linkText: "disconnected: line one\nline two" }).link,
    ).toBe("disconnected: line one line two · ");
  });

  test("a cut never doubles the link's own `…` (`reconnecting……`)", () => {
    const text = "reconnecting… (attempt 3, retry in 5s)";
    let cut = 0;
    for (let columns = 20; columns <= 120; columns++) {
      for (const target of [
        null,
        { engine: "kubernetes", name: "pod-1", container: "c" } as const,
      ]) {
        const l = statusLayout({ ...base, columns, linkText: text, target });
        expect(l.plain).not.toContain("……");
        expect(l.plain).not.toContain("… …");
        if (l.link.includes("…") && !l.link.includes("(attempt 3, retry in 5s)")) {
          cut++;
        }
      }
    }
    expect(cut).toBeGreaterThan(0);
    // Exactly the case: the cut lands right after the text's own `…`.
    expect(statusLayout({ ...base, columns: 35, linkText: text }).link).toBe("reconnecting… · ");
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
