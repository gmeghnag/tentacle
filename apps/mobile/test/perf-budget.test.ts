/**
 * docs/feat/mobile-ui-fluidity-s0.md: the AI-free perf budget over the app's
 * `ptrace` lines, and the long seeded history the flow measures it on.
 */
import { describe, expect, test } from "bun:test";
import {
  PERF_BUDGET,
  PERF_FLOW,
  checkPerf,
  perfOutcome,
  perfReportText,
} from "../e2e/perf-budget.ts";
import { PERF_ROUNDS, longHistory } from "../e2e/seed.ts";
import { createAppLog, entriesToText } from "../src/app-log.ts";
import { createPerfProbe } from "../src/perf-probe.ts";

const AT = "2026-11-27T23:56:25.146Z info ptrace";

const jank = (worst: number | string, renders = 10, win = 1000, stream = true): string =>
  `${AT} ev=jank win=${win} gaps=1 worst=${worst} lost=40 stream=${stream} folds=90 notifies=${renders} renders=${renders} renderMs=80`;
const fan = (settle: number | string, stream = true): string =>
  `${AT} ev=fan wait=12 start=16 settle=${settle} starts=1 stream=${stream}`;
const FOUR_FANS = [fan(1068), fan(1070), fan(1090), fan(1100)];
const PANE_KEYS = ["shell", "tail", "cells", "header", "composer", "hub", "sheets"];
/** s4's healthy shape: the tail follows the stream, nothing else does. */
const panes = (over: Record<string, number>): string => {
  const f: Record<string, number> = {
    shell: 4,
    tail: 500,
    cells: 0,
    header: 0,
    composer: 0,
    hub: 0,
    sheets: 0,
    ...over,
  };
  return `${AT} ev=panes ${PANE_KEYS.map((key) => `${key}=${f[key]}`).join(" ")}`;
};
/** Four healthy streaming opens, and one stream no pane followed. */
const FANS = [...FOUR_FANS, panes({})];
const HEALTHY = [jank(60), ...FANS];

const rules = (text: string): string[] => [
  ...new Set(checkPerf(text).violations.map((v) => v.rule)),
];
const check = (...lines: string[]) => checkPerf(lines.join("\n"));

// Copied from the eval's saved simulator traces (docs/eval/mobile-ui-fluidity.md).
const S2 = [
  "2026-11-27T23:56:25.146Z info ptrace ev=jank win=10257 gaps=1 worst=10206 lost=10189 stream=true folds=869 notifies=165 renders=165 renderMs=9901",
  "2026-11-27T23:56:38.936Z info ptrace ev=fan wait=12 start=16 settle=4573 starts=1 stream=true",
  "2026-11-27T23:57:09.845Z info ptrace ev=fan wait=36 start=39 settle=4630 starts=1 stream=true",
  "2026-11-27T23:57:40.597Z info ptrace ev=fan wait=6 start=9 settle=4643 starts=1 stream=true",
  "2026-11-27T23:58:11.572Z info ptrace ev=fan wait=59 start=63 settle=4640 starts=1 stream=true",
];
const S1 = [
  "2026-11-27T23:53:54.472Z info ptrace ev=jank win=1003 gaps=3 worst=69 lost=140 stream=true folds=85 notifies=30 renders=30 renderMs=240",
  "2026-11-27T23:53:55.488Z info ptrace ev=jank win=1017 gaps=3 worst=77 lost=132 stream=true folds=86 notifies=29 renders=29 renderMs=235",
  "2026-11-27T23:54:12.505Z info ptrace ev=fan wait=21 start=34 settle=1097 starts=1 stream=true",
  "2026-11-27T23:54:35.993Z info ptrace ev=fan wait=20 start=23 settle=1074 starts=1 stream=true",
  "2026-11-27T23:54:59.572Z info ptrace ev=fan wait=25 start=42 settle=1135 starts=1 stream=true",
  "2026-11-27T23:55:22.872Z info ptrace ev=fan wait=17 start=20 settle=1067 starts=1 stream=true",
];

describe("checkPerf", () => {
  test("the budget the eval set", () => {
    expect(PERF_FLOW).toBe("90-perf-stream");
    expect(PERF_BUDGET).toEqual({
      maxGapMs: 250,
      maxSettleMs: 1500,
      maxRendersPerSecond: 11,
      minStreamingFans: 4,
    });
  });

  test("the long session (S2) breaks gap, settle and rate", () => {
    const report = check(...S2, panes({}));
    expect(report.ok).toBe(false);
    expect(rules([...S2, panes({})].join("\n")).sort()).toEqual(["gap", "rate", "settle"]);
    expect(report.worstGapMs).toBe(10_206);
    expect(report.settles).toEqual([4573, 4630, 4643, 4640]);
    expect(report.rendersPerSecond).toBeCloseTo((165 * 1000) / 10_257, 5);
  });

  test("the short session (S1) breaks only the render rate", () => {
    expect(rules([...S1, panes({})].join("\n"))).toEqual(["rate"]);
  });

  test("a healthy log passes", () => {
    const report = check(...HEALTHY);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.jankLines).toBe(1);
    expect(report.fanLines).toBe(4);
    expect(report.streamingFans).toBe(4);
  });

  test("opens with no jank line at all pass: a smooth window writes none", () => {
    const report = check(...FANS);
    expect(report.ok).toBe(true);
    expect(report.rendersPerSecond).toBeNull();
    expect(report.worstGapMs).toBeNull();
  });

  test("gap: 250 passes, 251 fails, streaming or not", () => {
    expect(check(jank(250), ...FANS).ok).toBe(true);
    expect(rules([jank(251), ...FANS].join("\n"))).toEqual(["gap"]);
    expect(rules([jank(251, 0, 1000, false), ...FANS].join("\n"))).toEqual(["gap"]);
  });

  test("settle: 1500 passes; 1501 and never (-1) fail, streaming or not", () => {
    expect(check(...HEALTHY, fan(1500)).ok).toBe(true);
    expect(rules([...HEALTHY, fan(1501)].join("\n"))).toEqual(["settle"]);
    expect(rules([...HEALTHY, fan(-1)].join("\n"))).toEqual(["settle"]);
    expect(rules([...HEALTHY, fan(-1, false)].join("\n"))).toEqual(["settle"]);
  });

  test("rate: 11/s passes, above fails; one aggregate over the streaming windows", () => {
    expect(check(jank(60, 11), ...FANS).ok).toBe(true);
    expect(rules([jank(60, 12), ...FANS].join("\n"))).toEqual(["rate"]);
    // 20 + 2 renders over 2 s: the busy window alone would fail, the aggregate does not.
    expect(check(jank(60, 20), jank(60, 2), ...FANS).ok).toBe(true);
    // A window with no stream does not count.
    expect(check(jank(60, 10), jank(60, 90, 1000, false), ...FANS).ok).toBe(true);
  });

  test("not enough evidence is never a pass", () => {
    expect(rules("")).toEqual(["evidence"]);
    expect(rules([jank(60), ...FANS.slice(0, 3)].join("\n"))).toEqual(["evidence"]);
    const idle = [1, 2, 3, 4].map(() => fan(1000, false));
    expect(rules(idle.join("\n"))).toEqual(["evidence"]);
  });

  test("a missing or non-numeric needed field is a violation", () => {
    const broken = [
      `${AT} ev=jank gaps=1 worst=40 stream=true renders=1`,
      `${AT} ev=jank win=1000 gaps=1 stream=true renders=1`,
      `${AT} ev=jank win=1000 gaps=1 worst=40 stream=true`,
      `${AT} ev=jank win=1000 gaps=1 worst=40 renders=1`,
      jank("abc"),
      jank(""),
      `${AT} ev=fan wait=12 start=16 stream=true`,
      `${AT} ev=fan wait=12 start=16 settle=10`,
      fan("x"),
      `${AT} wait=12`,
      AT,
    ];
    for (const line of broken) {
      expect({ line, rules: rules([...HEALTHY, line].join("\n")) }).toEqual({
        line,
        rules: ["evidence"],
      });
    }
  });

  test("the export header, other kinds, unknown events and app-state are ignored", () => {
    const noise = [
      "tentacle 1.0.0 (7) · iOS 26.0 · iPhone17,1",
      "",
      "2026-11-27T23:56:00.000Z info app-state state=active",
      "2026-11-27T23:56:00.000Z warn link-status ev=jank worst=9999",
      `${AT} ev=later worst=9999 settle=-1`,
    ];
    const report = check(...noise, ...HEALTHY);
    expect(report.violations).toEqual([]);
    expect(report.jankLines).toBe(1);
  });

  test("reads what the app's probe and log really write", () => {
    let t = 0;
    const frames: ((t: number) => void)[] = [];
    const probe = createPerfProbe(
      () => t,
      (fn) => frames.push(fn),
    );
    const log = createAppLog({ now: () => 0, capacity: 50 });
    probe.attach(log);
    const step = (ms: number): void => {
      t += ms;
      frames.shift()?.(t);
    };
    probe.streaming(true);
    step(16);
    for (let i = 0; i < 4; i++) {
      probe.touch(undefined);
      probe.fanOpen();
      probe.fanStart();
      probe.render(5);
      step(600);
      step(600);
      probe.fanSettle(true);
    }
    for (let i = 0; i < 640; i++) {
      probe.pane("tail");
    }
    for (let i = 0; i < 60; i++) {
      probe.render(1);
    }
    probe.pane("hub");
    probe.streaming(false);
    const report = checkPerf(entriesToText(log.entries()));
    expect(report.panes).toEqual(["shell=64 tail=640 cells=0 header=0 composer=0 hub=1 sheets=0"]);
    expect(report.fanLines).toBe(4);
    expect(report.streamingFans).toBe(4);
    expect(report.settles).toEqual([1200, 1200, 1200, 1200]);
    expect(report.jankLines).toBeGreaterThan(0);
    expect(report.worstGapMs).toBe(600);
    expect(report.rendersPerSecond).not.toBeNull();
    expect(rules(entriesToText(log.entries()))).toEqual(["gap"]);
  });
});

describe("perfReportText", () => {
  test("the verdict first, then the numbers", () => {
    const text = perfReportText(check(...HEALTHY));
    expect(text.split("\n")[0]).toBe("PERF PASS");
    expect(text).toContain("worst gap: 60 ms");
    expect(text).toContain("fan settle ms: 1068, 1070, 1090, 1100");
    expect(text).toContain("renders/s (shell only): 10.0");
  });

  test("at most 10 violating lines, the totals per rule, and rate never cut off", () => {
    const lines = [
      ...Array.from({ length: 68 }, () => jank(900, 30)),
      ...[fan(4573), fan(4630), fan(4643), panes({})],
    ];
    const text = perfReportText(check(...lines));
    expect(text.split("\n")[0]).toBe("PERF FAIL");
    expect(text).toContain("violations: gap 68, settle 3, rate 1, evidence 1");
    expect(text.split("\n").filter((l) => l.includes("ptrace ev=")).length).toBe(10);
    expect(text).toContain("61 more violating lines");
    expect(text).toContain("rate: 30.0 renders/s > 11");
    expect(text).toContain("evidence: 3 streaming fan opens < 4");
    expect(text).toContain("fan settle ms: 4573, 4630, 4643");
  });

  test("no data says n/a", () => {
    const text = perfReportText(check(""));
    expect(text).toContain("worst gap: n/a");
    expect(text).toContain("fan settle ms: n/a");
    expect(text).toContain("renders/s (shell only): n/a");
  });
});

describe("coupling: nothing but the tail follows the stream", () => {
  const log = (...lines: string[]) => check(jank(60), ...FOUR_FANS, ...lines);
  const only = (...lines: string[]) => [...new Set(log(...lines).violations.map((v) => v.rule))];

  test("the shell, a cell or a pane that renders with the tail is a violation", () => {
    for (const pane of ["shell", "cells", "header", "composer", "hub", "sheets"]) {
      expect([pane, only(panes({ [pane]: 400 }))]).toEqual([pane, ["coupling"]]);
    }
    expect(log(panes({ hub: 8 })).ok).toBe(true);
  });

  test("s3's real shape (the shell renders with the stream) fails on the shell", () => {
    const report = log(panes({ shell: 1207, tail: 1207 }));
    expect(report.violations.map((v) => v.rule)).toEqual(["coupling"]);
    expect(report.violations[0]?.detail).toStartWith("shell=1207");
  });

  test("s4's shape passes", () => {
    expect(log(panes({ shell: 4, tail: 1200, cells: 0, hub: 3 })).ok).toBe(true);
  });

  test("the boundary: max(10, a tenth of the tail's renders)", () => {
    expect(log(panes({ hub: 50 })).ok).toBe(true);
    expect(only(panes({ hub: 51 }))).toEqual(["coupling"]);
    expect(log(panes({ tail: 50, hub: 10 })).ok).toBe(true);
    expect(only(panes({ tail: 50, hub: 11 }))).toEqual(["coupling"]);
  });

  test("a short stream gives no verdict; with no other panes line that is no evidence", () => {
    expect(only(panes({ tail: 20, hub: 20 }))).toEqual(["evidence"]);
    expect(only(panes({ shell: 1200, tail: 20 }))).toEqual(["evidence"]);
    expect(log(panes({ tail: 20, hub: 20 }), panes({})).ok).toBe(true);
    expect(only()).toEqual(["evidence"]);
  });

  test("a figure missing (`tail` too) or not a number is evidence", () => {
    const noTail = `${AT} ev=panes shell=500 cells=0 header=1 composer=1 hub=1 sheets=1`;
    const missing = `${AT} ev=panes shell=4 tail=500 cells=0 header=1 composer=1 hub=1`;
    const text = `${missing} sheets=x`;
    for (const line of [noTail, missing, text]) {
      expect(only(line, panes({}))).toEqual(["evidence"]);
      expect(only(line)).toEqual(["evidence"]);
    }
  });

  test("the report prints the panes' figures", () => {
    const text = perfReportText(log(panes({ hub: 8 })));
    expect(text).toContain("panes: shell=4 tail=500 cells=0 header=0 composer=0 hub=8 sheets=0");
  });

  test("the budget turns a coupled pass into a fail", () => {
    expect(perfOutcome("pass", log(panes({ composer: 400 })))).toBe("fail");
    expect(perfOutcome("pass", log(panes({})))).toBe("pass");
  });
});

describe("perfOutcome", () => {
  test("the budget can only turn a pass into a fail", () => {
    const ok = check(...HEALTHY);
    const red = check("");
    expect(perfOutcome("pass", ok)).toBe("pass");
    expect(perfOutcome("pass", red)).toBe("fail");
    expect(perfOutcome("fail", ok)).toBe("fail");
    expect(perfOutcome("fail", red)).toBe("fail");
    expect(perfOutcome("timeout", ok)).toBe("timeout");
    expect(perfOutcome("timeout", red)).toBe("timeout");
    const coupled = check(...FOUR_FANS, panes({ shell: 1207, tail: 1207 }));
    expect(perfOutcome("pass", coupled)).toBe("fail");
  });
});

describe("longHistory", () => {
  test("120 rounds, each call answered by its toolCallId", () => {
    expect(PERF_ROUNDS).toBe(120);
    const messages = longHistory(PERF_ROUNDS);
    expect(messages[0]?.role).toBe("user");
    const calls = messages.flatMap((m, i) =>
      m.role === "assistant" ? (m.toolCalls ?? []).map((call) => ({ call, i })) : [],
    );
    expect(calls.length).toBe(120);
    expect(new Set(calls.map((c) => c.call.id)).size).toBe(120);
    for (const { call, i } of calls) {
      const answer = messages[i + 1];
      expect(call.name).toBe("fs_read");
      expect(answer?.role).toBe("tool");
      if (answer?.role === "tool") {
        expect(answer.toolCallId).toBe(call.id);
        expect(String(answer.content).split("\n").length).toBe(80);
      }
    }
    const last = messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(messages.length).toBe(1 + 120 * 2 + 1);
  });
});
