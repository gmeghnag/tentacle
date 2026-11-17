import { describe, expect, test } from "bun:test";
import type { KnownLogEntry } from "@tentacle/protocol";
import { formatUsage, usageReport, usageRows, usageTotals } from "../src/usage-report.ts";

// docs/feat/token-usage-log.md: `tentacle logs --usage`'s deciding — the rows,
// the totals and the plain-text table. Each test names the mutation that turns
// it red (AGENTS §9).

let seq = 0;
/** One `usage` entry, chained like a real log line (the chain itself is irrelevant here). */
function usage(body: Record<string, unknown>, ts = 1000 + seq): KnownLogEntry {
  seq++;
  return {
    type: "usage",
    critical: false,
    seq,
    id: `a/${seq}`,
    ts,
    ...body,
  } as unknown as KnownLogEntry;
}

function other(body: Record<string, unknown>): KnownLogEntry {
  seq++;
  return {
    type: "turn_start",
    critical: false,
    seq,
    id: `a/${seq}`,
    ts: 1000,
    turnId: "t1",
    ...body,
  } as unknown as KnownLogEntry;
}

describe("usageRows", () => {
  test("keeps the usage entries, in log order, and ignores every other kind", () => {
    // Mutation: drop the `entry.type !== "usage"` guard → a turn marker becomes a row.
    const rows = usageRows([
      other({}),
      usage({ turnId: "t1", round: 0, model: "m", promptTokens: 100, completionTokens: 7 }),
      other({}),
      usage({ turnId: "t1", round: 1, model: "m", promptTokens: 160, completionTokens: 9 }),
    ]);
    expect(rows.map((r) => r.round)).toEqual([0, 1]);
    expect(rows.map((r) => r.promptTokens)).toEqual([100, 160]);
  });

  test("a final report keeps `final` and has no round; absent fields stay ABSENT", () => {
    // Mutation: `cachedPromptTokens: entry.cachedPromptTokens ?? 0` → `in` becomes true.
    const [row] = usageRows([usage({ final: true, promptTokens: 5, completionTokens: 1 })]);
    expect(row?.final).toBe(true);
    expect(row?.round).toBeUndefined();
    expect(row !== undefined && "cachedPromptTokens" in row).toBe(false);
    expect(row !== undefined && "messages" in row).toBe(false);
    expect(row !== undefined && "model" in row).toBe(false);
  });
});

describe("usageTotals", () => {
  test("sums the measured counts and counts the rows that reported a cache split", () => {
    const rows = usageRows([
      usage({ round: 0, promptTokens: 100, completionTokens: 7, cachedPromptTokens: 90 }),
      usage({ round: 1, promptTokens: 160, completionTokens: 9 }),
    ]);
    expect(usageTotals(rows)).toEqual({
      rounds: 2,
      promptTokens: 260,
      completionTokens: 16,
      cachedPromptTokens: 90,
      cachedRows: 1,
    });
  });

  test("no cache split at all ⇒ cachedTokens 0 but cachedRows 0 (a total is never read as a full miss)", () => {
    // Mutation: `cachedRows += 1` unconditionally → the table claims a measured 0.
    const totals = usageTotals(
      usageRows([usage({ round: 0, promptTokens: 4, completionTokens: 1 })]),
    );
    expect(totals.cachedPromptTokens).toBe(0);
    expect(totals.cachedRows).toBe(0);
  });

  test("no rows ⇒ zeroed totals and no claim about cache", () => {
    expect(usageTotals([])).toEqual({
      rounds: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      cachedRows: 0,
    });
  });
});

describe("formatUsage", () => {
  test("an aligned table, a total line, and `—` for what was not measured", () => {
    const report = usageReport([
      usage({
        round: 0,
        model: "m1",
        messages: 2,
        promptTokens: 100,
        completionTokens: 7,
        cachedPromptTokens: 90,
      }),
      usage({ final: true, messages: 6, promptTokens: 160, completionTokens: 9 }),
    ]);
    const out = formatUsage(report);
    const lines = out.trimEnd().split("\n");
    // header + 2 rows + total + the summary line
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("round  model  msgs  input  output  cached");
    expect(lines[1]).toBe("   r0     m1     2    100       7      90");
    // The second row reported neither a model nor a cache split: `—`, never 0.
    expect(lines[2]).toBe("final      —     6    160       9       —");
    expect(lines[3]).toBe("total      —     —    260      16      90");
    expect(out).toContain("2 round(s), 260 in / 16 out");
    expect(out).toContain("90 of the input served from cache (over 1 round(s))");
  });

  test("no cache split anywhere: a `—` total and a line that says so", () => {
    // Mutation: print `0` instead of `—` → the reader believes a full miss was measured.
    const out = formatUsage(
      usageReport([usage({ round: 0, promptTokens: 4, completionTokens: 1 })]),
    );
    expect(out).toContain("the provider reported no cache split");
    expect(out).not.toContain("served from cache (over");
    expect(out.trimEnd().split("\n").at(-2)).toBe("total      —     —      4       1       —");
  });

  test("an empty report says nothing was recorded, and exits happily", () => {
    // Mutation: return the table with a 0/0 total → a run that measured nothing reads as free.
    expect(formatUsage(usageReport([other({})]))).toBe(
      "[usage] no token usage was recorded in this session's current segment\n",
    );
  });
});
