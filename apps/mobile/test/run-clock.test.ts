/**
 * docs/fix/mobile-workflow-run-jank.md: the run screen's elapsed time ticks on its
 * own (`src/run-clock.ts`), on the run's own second boundaries.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { startRunClock } from "../src/run-clock.ts";

/** A hand-driven clock: one slot per pending timeout, fired when the test says. */
function fake(at: number) {
  let now = at;
  const pending = new Set<{ fn: () => void; due: number; ms: number }>();
  const ticks: number[] = [];
  return {
    deps: {
      now: () => now,
      schedule(fn: () => void, ms: number) {
        const entry = { fn, due: now + ms, ms };
        pending.add(entry);
        return () => {
          pending.delete(entry);
        };
      },
    },
    onTick: (t: number) => {
      ticks.push(t);
    },
    ticks,
    pending: () => [...pending],
    /** Fire the one pending timeout `late` ms after it was due. */
    fire(late = 0): void {
      const [entry, ...rest] = [...pending];
      if (entry === undefined || rest.length > 0) {
        throw new Error(`expected one pending timeout, have ${pending.size}`);
      }
      pending.delete(entry);
      now = entry.due + late;
      entry.fn();
    },
  };
}

describe("startRunClock", () => {
  test("a live run ticks 0s, 1s, 2s, 3s with late firings, without drift", () => {
    const f = fake(10_000);
    startRunClock({ startedAt: 10_000 }, f.deps, f.onTick);
    const dues: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      dues.push(...f.pending().map((p) => p.due));
      f.fire(130);
    }
    expect(f.ticks).toEqual([10_000, 11_130, 12_130, 13_130]);
    // Every wake-up is aimed at a whole second from the START, whatever the jitter.
    expect(dues).toEqual([11_000, 12_000, 13_000]);
  });

  test("shown mid-second, the first wake-up is the run's next whole second", () => {
    const f = fake(10_400);
    startRunClock({ startedAt: 10_000 }, f.deps, f.onTick);
    expect(f.ticks).toEqual([10_400]);
    expect(f.pending().map((p) => p.ms)).toEqual([600]);
  });

  test("a very late firing (backgrounded app) reads `now` and re-aligns", () => {
    const f = fake(10_000);
    startRunClock({ startedAt: 10_000 }, f.deps, f.onTick);
    f.fire(60_250);
    expect(f.ticks.at(-1)).toBe(71_250);
    expect(f.pending().map((p) => p.due)).toEqual([72_000]);
  });

  test("an ended run schedules nothing", () => {
    const f = fake(99_000);
    startRunClock({ startedAt: 10_000, endedAt: 12_000 }, f.deps, f.onTick);
    expect(f.pending()).toEqual([]);
    expect(f.ticks).toEqual([]);
  });

  test("stop() cancels the pending timeout, and a stale callback ticks nothing", () => {
    const f = fake(10_000);
    const stop = startRunClock({ startedAt: 10_000 }, f.deps, f.onTick);
    f.fire();
    const [stale] = f.pending();
    expect(stale).toBeDefined();
    stop();
    expect(f.pending()).toEqual([]);
    stale?.fn();
    expect(f.ticks).toEqual([10_000, 11_000]);
    expect(f.pending()).toEqual([]);
  });

  test("a phone clock BEHIND the daemon's still gets a delay in (0, 1000]", () => {
    for (const [now, delay] of [
      [7_500, 500],
      [8_000, 1_000],
      [9_999, 1],
    ] as const) {
      const f = fake(now);
      startRunClock({ startedAt: 10_000 }, f.deps, f.onTick);
      expect(f.pending().map((p) => p.ms)).toEqual([delay]);
    }
  });
});

/**
 * Source pins (the components have no render harness; AST, as in
 * `motion-literals.test.ts`): the strip runs the clock, and the step layer's
 * flight restarts on open and on Reduce Motion only, never on a status update.
 */
function calls(screen: string): { name: string; node: ts.CallExpression; sf: ts.SourceFile }[] {
  const source = readFileSync(join(import.meta.dir, "../src/screens", screen), "utf8");
  const sf = ts.createSourceFile(screen, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { name: string; node: ts.CallExpression; sf: ts.SourceFile }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      out.push({ name: n.expression.getText(sf), node: n, sf });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The dependency list of a hook call, as source text. */
function deps(call: { node: ts.CallExpression; sf: ts.SourceFile }): string[] {
  const list = call.node.arguments[1];
  return list !== undefined && ts.isArrayLiteralExpression(list)
    ? list.elements.map((e) => e.getText(call.sf))
    : [];
}

describe("the screens use them", () => {
  test("`WorkflowRun.tsx` runs the clock in an effect keyed on the run's two times", () => {
    const effects = calls("WorkflowRun.tsx").filter(
      (c) => c.name === "useEffect" && c.node.getText(c.sf).includes("startRunClock("),
    );
    expect(effects.map(deps)).toEqual([["startedAt", "endedAt"]]);
  });

  test("the step layer's flight effect does not depend on the table", () => {
    const flight = calls("WorkflowStep.tsx").filter(
      (c) => c.name === "useEffect" && c.node.getText(c.sf).includes("graphFade"),
    );
    expect(flight.map(deps)).toEqual([["motion", "flies", "progress", "graphFade"]]);
  });

  test("the step layer's `motion` is one object per Reduce Motion value", () => {
    const made = calls("WorkflowStep.tsx").filter(
      (c) => c.name === "useMemo" && c.node.getText(c.sf).includes("morphLook("),
    );
    expect(made.map(deps)).toEqual([["reduceMotion"]]);
  });
});
