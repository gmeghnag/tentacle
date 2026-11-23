/**
 * The parallel gate's decisions (docs/feat/e2e-parallel-gate.md): the split,
 * the merge, the exit code and the app cache key. Pure, so every one of them is
 * pinned here rather than chased in a live run — `parallel.ts`'s spawn/relay is
 * the only part that needs two simulators.
 *
 * Two tests read the REAL repo (the flows' texts, the app inputs): they are the
 * canaries — a new flow on a seeded session, or an app input outside the cache
 * key, fails here on purpose.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowResult } from "../e2e/gate.ts";
import { verdictOf } from "../e2e/gate.ts";
import { FLOWS, appCacheInputs } from "../e2e/run.ts";
import {
  type AppInput,
  DEFAULT_FLOW_SECONDS,
  DELETED,
  SHARED_SEED_VARS,
  appCacheKey,
  builtAppPath,
  cacheEvictions,
  flowGroups,
  flushLines,
  frameLines,
  latestDurations,
  mergeShardResults,
  parallelExitCode,
  parseUdids,
  relayLine,
  splitShards,
} from "../e2e/shard.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const FLOWS_DIR = join(REPO, "apps", "mobile", "e2e", "flows");

/** The real text of a flow plus every flow script it names (what the split reads). */
function realTextOf(flow: string): string {
  return new Map(splitFlows(flow)).get(flow) ?? "";
}

/** Every flow name a yaml names (subflows and script files), one level deep per call. */
function splitFlows(flow: string): [string, string][] {
  const seen = new Set<string>();
  const parts: string[] = [];
  const walk = (name: string) => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    let text: string;
    try {
      text = readFileSync(join(FLOWS_DIR, `${name}.yaml`), "utf8");
    } catch {
      return;
    }
    parts.push(text);
    for (const ref of referenced(text)) {
      walk(ref);
    }
  };
  walk(flow);
  return [[flow, parts.join("\n")]];
}

/** The flow/script names a yaml mentions (`runFlow: x.yaml`, `file: "x.js"`). */
function referenced(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split("\n")) {
    const file = /^\s*(?:-\s*)?file:\s*["']?([\w.-]+)\.(?:js|yaml)["']?\s*$/.exec(raw);
    const runFlow = /^\s*-\s*runFlow:\s*["']?([\w.-]+)\.yaml["']?\s*$/.exec(raw);
    const name = runFlow?.[1] ?? file?.[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

describe("parseUdids", () => {
  test("one udid is the single-simulator form", () => {
    expect(parseUdids("ABC-1")).toEqual(["ABC-1"]);
  });

  test("a comma-separated list is the parallel form", () => {
    expect(parseUdids("A,B")).toEqual(["A", "B"]);
    expect(parseUdids(" A , B ,C ")).toEqual(["A", "B", "C"]);
  });

  test("a duplicate, an empty item or nothing at all is an error", () => {
    expect(() => parseUdids("A,A")).toThrow(/twice/);
    expect(() => parseUdids("A,")).toThrow(/empty/);
    expect(() => parseUdids(",A")).toThrow(/empty/);
    expect(() => parseUdids("")).toThrow(/no simulator/);
  });
});

describe("SHARED_SEED_VARS", () => {
  test("is exactly the seeded session ids the flows interpolate", () => {
    expect(SHARED_SEED_VARS).toEqual([
      "ALPHA_ID",
      "BRAVO_ID",
      "CHARLIE_ID",
      "ASK1_ID",
      "ASK2_ID",
      "ASK3_ID",
      "ASK4_ID",
      "ASK5_ID",
    ]);
  });
});

describe("flowGroups", () => {
  const textOf = (texts: Record<string, string>) => (flow: string) => texts[flow] ?? "";

  test("two flows naming the same seeded session cannot be separated", () => {
    const groups = flowGroups(
      ["a", "b", "c"],
      textOf({ a: "id: ${ALPHA_ID}", b: "id: ${ALPHA_ID}", c: "" }),
    );
    expect(groups.map((g) => [...g])).toEqual([["a", "b"], ["c"]]);
  });

  test("a group joins through a second variable and through a referenced script", () => {
    const groups = flowGroups(
      ["a", "b", "d"],
      textOf({
        a: "id: ${ALPHA_ID}",
        // b carries BOTH vars: it is the bridge.
        b: "${ALPHA_ID} ${BRAVO_ID}",
        d: "id: ${BRAVO_ID}",
      }),
    );
    expect(groups.map((g) => [...g])).toEqual([["a", "b", "d"]]);
  });

  test("a bare var (a .js script, no ${}) counts too", () => {
    const groups = flowGroups(
      ["a", "b"],
      textOf({ a: "id: ${ASK4_ID}", b: "const id = ASK4_ID;" }),
    );
    expect(groups.map((g) => [...g])).toEqual([["a", "b"]]);
  });

  test("two DIFFERENT vars are two groups", () => {
    const groups = flowGroups(
      ["a", "b"],
      textOf({ a: "id: ${CHARLIE_ID}", b: "const id = ASK4_ID;" }),
    );
    expect(groups.map((g) => [...g])).toEqual([["a"], ["b"]]);
  });

  test("a var whose name is only a PREFIX of another does not join", () => {
    const groups = flowGroups(["a", "b"], textOf({ a: "${ASK1_ID}", b: "${ASK1_ID_ALT}" }));
    expect(groups.map((g) => [...g])).toEqual([["a"], ["b"]]);
  });

  test("a flow with no seeded var is a singleton", () => {
    expect(flowGroups(["solo"], textOf({ solo: "no vars here" }))).toEqual([["solo"]]);
  });

  test("the groups keep FLOWS order inside each one", () => {
    const groups = flowGroups(
      ["x", "a", "y", "z"],
      textOf({ x: "", a: "${ALPHA_ID}", y: "", z: "${ALPHA_ID}" }),
    );
    expect(groups.map((g) => [...g])).toEqual([["x"], ["a", "z"], ["y"]]);
  });

  test("the REAL flows: ALPHA's group is exactly the flows that read it", () => {
    const runnable = FLOWS.filter((flow) => !quarantined(flow));
    const groups = flowGroups(runnable, realTextOf);
    const alpha =
      groups.find((group) => group.includes("07-prompt"))?.filter((f) => f !== undefined) ?? [];
    expect(new Set(alpha)).toEqual(
      new Set([
        "02-session-list",
        "05-daemon-down",
        "06-session-open",
        "07-prompt",
        "11-disconnect-mid-turn",
        "17-persisted",
        "22-relay-only",
        "26-drawer",
      ]),
    );
  });

  test("the REAL flows: a CHARLIE-only flow joins ALPHA's group through 06's bridge", () => {
    // The union step's whole point, over REAL data: 06-session-open reads ALPHA
    // (06-session-left.js) AND CHARLIE, so a flow that touches only CHARLIE still
    // mutates a session 06 asserts on and may not be separated from it.
    const runnable = [...FLOWS.filter((flow) => !quarantined(flow)), "99-charlie-only"];
    const groups = flowGroups(runnable, (flow) =>
      flow === "99-charlie-only" ? "id: ${CHARLIE_ID}" : realTextOf(flow),
    );
    const withBridge = groups.find((group) => group.includes("99-charlie-only")) ?? [];
    expect(new Set(withBridge)).toEqual(
      new Set([
        "02-session-list",
        "05-daemon-down",
        "06-session-open",
        "07-prompt",
        "11-disconnect-mid-turn",
        "17-persisted",
        "22-relay-only",
        "26-drawer",
        "99-charlie-only",
      ]),
    );
  });

  test("the REAL flows: every group is a set of flows of FLOWS, in FLOWS order", () => {
    const runnable = FLOWS.filter((flow) => !quarantined(flow));
    const groups = flowGroups(runnable, realTextOf);
    expect(groups.flat().sort()).toEqual([...runnable].sort());
    expect(groups.flat().length).toBe(new Set(groups.flat()).size);
    for (const group of groups) {
      const indexes = group.map((flow) => FLOWS.indexOf(flow));
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    }
  });

  function quarantined(flow: string): boolean {
    return (
      readFileSync(join(FLOWS_DIR, `${flow}.yaml`), "utf8")
        .split(/^---$/m)[0]
        ?.includes("quarantine") === true
    );
  }
});

describe("latestDurations", () => {
  const result = (name: string, seconds: number, status: FlowResult["status"] = "pass") => ({
    name,
    status,
    seconds,
    attempts: 1,
    tags: [],
  });

  test("the newest run wins and a quarantined zero is ignored", () => {
    const durations = latestDurations([
      { runId: 1, results: [result("a", 10)] },
      { runId: 2, results: [result("a", 40), result("b", 0, "quarantined")] },
    ]);
    expect(durations.get("a")).toBe(40);
    expect(durations.has("b")).toBe(false);
  });

  test("an older run fills what the newest lacks", () => {
    const durations = latestDurations([
      { runId: 3, results: [result("a", 40)] },
      { runId: 2, results: [result("b", 20)] },
      { runId: 1, results: [result("b", 99)] },
    ]);
    expect(durations.get("a")).toBe(40);
    expect(durations.get("b")).toBe(20);
  });

  test("run ids are compared as numbers, not as their input order", () => {
    const durations = latestDurations([
      { runId: 9, results: [result("a", 1)] },
      { runId: 100, results: [result("a", 2)] },
    ]);
    expect(durations.get("a")).toBe(2);
  });
});

describe("splitShards", () => {
  const realDurations = () => {
    const parsed = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "e2e-summary-1795363693570.json"), "utf8"),
    ) as FlowResult[];
    return latestDurations([{ runId: 1795363693570, results: parsed }]);
  };
  const cost = (shard: readonly string[], durations: ReadonlyMap<string, number>) =>
    shard.reduce((sum, flow) => sum + (durations.get(flow) ?? DEFAULT_FLOW_SECONDS), 0);

  const GROUPS = [["01-shell"], ["02", "07"], ["03"], ["33-hub"]];
  const ORDER = ["01-shell", "02", "03", "07", "33-hub"];

  test("a group is never split, and every flow lands exactly once", () => {
    const shards = splitShards(GROUPS, new Map([["33-hub", 237]]), 2, ORDER);
    expect(shards.flat().sort()).toEqual([...ORDER].sort());
    for (const group of GROUPS) {
      expect(shards.filter((shard) => group.some((flow) => shard.includes(flow)))).toHaveLength(1);
    }
  });

  test("each shard comes out in FLOWS order", () => {
    const shards = splitShards(GROUPS, new Map(), 2, ORDER);
    for (const shard of shards) {
      const indexes = shard.map((flow) => ORDER.indexOf(flow));
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    }
  });

  test("is deterministic and greedy: the biggest group goes first, onto the lightest shard", () => {
    const durations = new Map([
      ["01-shell", 10],
      ["02", 10],
      ["03", 100],
      ["07", 10],
      ["33-hub", 60],
    ]);
    const once = splitShards(GROUPS, durations, 2, ORDER);
    expect(splitShards(GROUPS, durations, 2, ORDER)).toEqual(once);
    // 03 (100) takes shard 0; 33-hub (60), 02+07 (20) and 01-shell (10) fill shard 1.
    expect(once.map((shard) => [...shard])).toEqual([["03"], ["01-shell", "02", "07", "33-hub"]]);
  });

  test("the split is balanced within the largest group", () => {
    const durations = realDurations();
    const groups = flowGroups(
      FLOWS.filter((flow) => durations.has(flow)),
      realTextOf,
    );
    const shards = splitShards(groups, durations, 2, FLOWS);
    expect(shards).toHaveLength(2);
    const costs = shards.map((shard) => cost(shard, durations));
    const largestGroup = Math.max(...groups.map((group) => cost(group, durations)));
    expect(Math.abs((costs[0] ?? 0) - (costs[1] ?? 0))).toBeLessThanOrEqual(largestGroup);
    // With the last gate's own durations the halves are close (the doc's 237 s).
    expect(Math.abs((costs[0] ?? 0) - (costs[1] ?? 0))).toBeLessThanOrEqual(237);
  });

  test("no duration history: the median of the known ones, else 60 s", () => {
    const shards = splitShards(
      [["a"], ["b"], ["c"], ["d"]],
      new Map([
        ["a", 10],
        ["b", 20],
        ["c", 30],
      ]),
      2,
      ["a", "b", "c", "d"],
    );
    // Median of 10/20/30 is 20, so `d` costs like `b`: c (30) then b+d (40) and a (10).
    expect(shards.map((shard) => [...shard])).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
    const none = splitShards([["a"], ["b"]], new Map(), 2, ["a", "b"]);
    expect(none.map((shard) => shard.length)).toEqual([1, 1]);
  });

  test("more shards than groups leaves the extra ones empty (no child is spawned)", () => {
    const shards = splitShards([["a"]], new Map(), 3, ["a"]);
    expect(shards).toHaveLength(3);
    expect(shards.flat()).toEqual(["a"]);
  });
});

describe("mergeShardResults", () => {
  const result = (
    name: string,
    status: FlowResult["status"] = "pass",
    tags: FlowResult["tags"] = [],
  ): FlowResult => ({ name, status, seconds: 5, attempts: 1, tags });

  const ORDER = ["01-shell", "02", "03", "04"];

  test("rows come out in FLOWS order whatever order the shards finished in", () => {
    const merged = mergeShardResults({
      order: ORDER,
      quarantined: [],
      shards: [
        { label: "sim-a", dir: "/p/sim-a", flows: ["03"], results: [result("03")] },
        {
          label: "sim-b",
          dir: "/p/sim-b",
          flows: ["01-shell", "02"],
          results: [result("02"), result("01-shell")],
        },
      ],
    });
    expect(merged.map((r) => r.name)).toEqual(["01-shell", "02", "03"]);
  });

  test("a crashed shard's flows are RED, pointing at its dir — never skipped", () => {
    const merged = mergeShardResults({
      order: ORDER,
      quarantined: [],
      shards: [
        { label: "sim-a", dir: "/p/sim-a", flows: ["03", "04"], results: undefined },
        { label: "sim-b", dir: "/p/sim-b", flows: ["01-shell"], results: [result("01-shell")] },
      ],
    });
    expect(merged.map((r) => [r.name, r.status])).toEqual([
      ["01-shell", "pass"],
      ["03", "fail"],
      ["04", "fail"],
    ]);
    expect(merged[1]?.outDir).toBe("/p/sim-a");
    expect(verdictOf(merged).exitCode).toBe(1);
  });

  test("a flow its shard did not report is red too", () => {
    const merged = mergeShardResults({
      order: ORDER,
      quarantined: [],
      shards: [{ label: "sim-a", dir: "/p/sim-a", flows: ["03", "04"], results: [result("03")] }],
    });
    expect(merged.map((r) => [r.name, r.status])).toEqual([
      ["03", "pass"],
      ["04", "fail"],
    ]);
  });

  test("a duplicate flow throws", () => {
    expect(() =>
      mergeShardResults({
        order: ORDER,
        quarantined: [],
        shards: [
          { label: "sim-a", dir: "/p/sim-a", flows: ["03"], results: [result("03")] },
          { label: "sim-b", dir: "/p/sim-b", flows: ["03"], results: [result("03")] },
        ],
      }),
    ).toThrow(/twice|03/);
  });

  test("a flow the parent never sent throws", () => {
    expect(() =>
      mergeShardResults({
        order: ORDER,
        quarantined: [],
        shards: [
          { label: "sim-a", dir: "/p/sim-a", flows: ["03"], results: [result("03"), result("04")] },
        ],
      }),
    ).toThrow(/04/);
  });

  test("quarantined rows are kept, in FLOWS order, and are not counted", () => {
    const merged = mergeShardResults({
      order: ORDER,
      quarantined: [
        { name: "04", status: "quarantined", seconds: 0, attempts: 0, tags: ["quarantine"] },
      ],
      shards: [
        {
          label: "sim-a",
          dir: "/p/sim-a",
          flows: ["01-shell", "02", "03"],
          results: [result("01-shell"), result("02"), result("03")],
        },
      ],
    });
    expect(merged.map((r) => r.name)).toEqual(["01-shell", "02", "03", "04"]);
    expect(verdictOf(merged).quarantined.map((r) => r.name)).toEqual(["04"]);
  });

  test("the merged verdict is the same as the same results in one list", () => {
    const green = result("01-shell");
    const red = result("02", "fail");
    const slow = result("03", "timeout");
    const all = [green, red, slow];
    const merged = mergeShardResults({
      order: ORDER,
      quarantined: [],
      shards: [
        { label: "sim-a", dir: "/p/sim-a", flows: ["01-shell", "02"], results: [green, red] },
        { label: "sim-b", dir: "/p/sim-b", flows: ["03"], results: [slow] },
      ],
    });
    const one = verdictOf(all);
    const both = verdictOf(merged);
    expect(both.passed.length).toBe(one.passed.length);
    expect(both.failed.map((r) => r.name)).toEqual(one.failed.map((r) => r.name));
    expect(both.exitCode).toBe(one.exitCode);
  });
});

describe("parallelExitCode", () => {
  test("a green pair is 0 and a red one is 1", () => {
    expect(parallelExitCode([0, 0], verdictOf([]))).toBe(0);
    const red = verdictOf([{ name: "a", status: "fail", seconds: 1, attempts: 1, tags: [] }]);
    expect(parallelExitCode([1, 0], red)).toBe(1);
  });

  test("a child that says RED is red even if the merge looks green (no silent green)", () => {
    expect(parallelExitCode([1, 0], verdictOf([]))).toBe(1);
  });

  test("a prerequisite (2) and a build/install code win over the verdict", () => {
    expect(parallelExitCode([0, 2], verdictOf([]))).toBe(2);
    expect(parallelExitCode([65, 1], verdictOf([]))).toBe(65);
  });

  test("a child killed by a signal is a red gate", () => {
    expect(parallelExitCode([null, 0], verdictOf([]))).toBe(1);
  });

  test("the first non-0/1 code wins, whatever the order", () => {
    expect(parallelExitCode([0, 3, 2], verdictOf([]))).toBe(3);
  });

  test("with every child at 0/1 the verdict decides", () => {
    const red = verdictOf([{ name: "a", status: "fail", seconds: 1, attempts: 1, tags: [] }]);
    expect(parallelExitCode([0, 1], red)).toBe(1);
  });
});

describe("builtAppPath", () => {
  test("reads the install line the real build log carries", () => {
    // The exact shape from a real run's build-ios26.log (line 3546).
    const log = [
      "[Expo] Installing the build script for target tentacle",
      "› Installing /Users/someone/Library/Developer/Xcode/DerivedData/tentacle-abc/Build/Products/Release-iphonesimulator/tentacle.app",
      "› Installing on iPhone 17 Pro Max",
    ].join("\n");
    expect(builtAppPath(log)).toBe(
      "/Users/someone/Library/Developer/Xcode/DerivedData/tentacle-abc/Build/Products/Release-iphonesimulator/tentacle.app",
    );
  });

  test("the LAST match wins (a retried build prints several)", () => {
    const log = ["› Installing /old/tentacle.app", "› Installing /new/tentacle.app"].join("\n");
    expect(builtAppPath(log)).toBe("/new/tentacle.app");
  });

  test("no line at all is undefined, never a guess", () => {
    expect(builtAppPath("Build Succeeded\n")).toBeUndefined();
    expect(builtAppPath("")).toBeUndefined();
  });

  test("an ANSI-coloured line still parses", () => {
    expect(builtAppPath("\u001b[36m› Installing /x/tentacle.app\u001b[0m")).toBe("/x/tentacle.app");
  });
});

describe("appCacheKey", () => {
  const files = (entries: Record<string, Uint8Array | string>): AppInput[] =>
    Object.entries(entries).map(([path, content]) => ({
      path,
      content: typeof content === "string" ? new TextEncoder().encode(content) : content,
    }));
  const extras = { xcode: "Xcode 26.0\nBuild version 17A1", bun: "1.4.3" };

  test("order does not matter", () => {
    const a = appCacheKey(files({ "apps/mobile/App.tsx": "a", "bun.lock": "b" }), extras);
    const b = appCacheKey(files({ "bun.lock": "b", "apps/mobile/App.tsx": "a" }), extras);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("one byte changed in an app source changes the key", () => {
    const base = appCacheKey(files({ "apps/mobile/src/a.ts": "one" }), extras);
    expect(appCacheKey(files({ "apps/mobile/src/a.ts": "tw" }), extras)).not.toBe(base);
  });

  test("a JS change in packages/ changes the key (it lands in the Release bundle)", () => {
    const base = appCacheKey(files({ "packages/protocol/src/a.ts": "one" }), extras);
    expect(appCacheKey(files({ "packages/protocol/src/a.ts": "two" }), extras)).not.toBe(base);
  });

  test("the harness, the flows and the unit tests do not", () => {
    const base = appCacheKey(files({ "apps/mobile/App.tsx": "a" }), extras);
    for (const path of [
      "apps/mobile/e2e/run.ts",
      "apps/mobile/e2e/flows/01-shell.yaml",
      "apps/mobile/test/app.test.tsx",
      "packages/protocol/test/version.test.ts",
    ]) {
      expect(appCacheKey(files({ "apps/mobile/App.tsx": "a", [path]: "changed" }), extras)).toBe(
        base,
      );
    }
  });

  test("a different Xcode or Bun version changes the key", () => {
    const base = appCacheKey(files({ "apps/mobile/App.tsx": "a" }), extras);
    expect(
      appCacheKey(files({ "apps/mobile/App.tsx": "a" }), { ...extras, xcode: "Xcode 26.1" }),
    ).not.toBe(base);
    expect(
      appCacheKey(files({ "apps/mobile/App.tsx": "a" }), { ...extras, bun: "1.4.4" }),
    ).not.toBe(base);
  });

  test("a tracked file deleted from the worktree is a different key from an absent one", () => {
    const present = appCacheKey(files({ "apps/mobile/App.tsx": "a" }), extras);
    const deleted = appCacheKey(
      files({ "apps/mobile/App.tsx": "a", "apps/mobile/src/gone.ts": DELETED }),
      extras,
    );
    expect(deleted).not.toBe(present);
  });

  test("the path is part of the key (a rename is a rebuild)", () => {
    const a = appCacheKey(files({ "apps/mobile/src/a.ts": "same" }), extras);
    const b = appCacheKey(files({ "apps/mobile/src/b.ts": "same" }), extras);
    expect(a).not.toBe(b);
  });

  // Review round 1 HIGH: the inputs used to be read as UTF-8 TEXT, so two
  // different binaries whose invalid bytes decode to the same U+FFFD hashed the
  // same — and an asset change silently reused a stale `.app`.
  test("two binaries differing only in INVALID-UTF-8 bytes are different keys", () => {
    const one = Uint8Array.from([0x89, 0x50, 0xff, 0x00]);
    const two = Uint8Array.from([0x89, 0x50, 0xfe, 0x00]);
    // The bug's own premise: as text these are the same string.
    expect(new TextDecoder().decode(one)).toBe(new TextDecoder().decode(two));
    const a = appCacheKey(files({ "apps/mobile/assets/i.png": one }), extras);
    const b = appCacheKey(files({ "apps/mobile/assets/i.png": two }), extras);
    expect(a).not.toBe(b);
  });

  test("content cannot be shifted across the path boundary (length-framed)", () => {
    // `path\0content\0` framing lets "a\0b" + "c" collide with "a" + "b\0c".
    const a = appCacheKey(
      files({ "apps/mobile/x.ts": "b\u0000c", "apps/mobile/y.ts": "z" }),
      extras,
    );
    const b = appCacheKey(files({ "apps/mobile/x.ts": "b", "apps/mobile/y.ts": "z" }), extras);
    expect(a).not.toBe(b);
  });
});

describe("appCacheInputs over the REAL repo", () => {
  // The canary the plan names: what a cached build may be reused for is the app
  // SOURCE — and neither the harness that drives it nor its unit tests.
  test("the app sources are in; the harness, the flows and the tests are out", async () => {
    const repo = join(import.meta.dir, "..", "..", "..");
    const paths = (await appCacheInputs(repo)).map((file) => file.path);
    // A JS change is a rebuild: the app's own sources are in.
    expect(paths).toContain("apps/mobile/App.tsx");
    expect(paths.some((p) => p.startsWith("packages/protocol/src/"))).toBe(true);
    // The harness, the flows and the unit tests never reach the bundle.
    expect(paths.some((p) => p.startsWith("apps/mobile/e2e/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("apps/mobile/test/"))).toBe(false);
    expect(paths.some((p) => /^packages\/[^/]+\/test\//.test(p))).toBe(false);
  });

  // The canary for the HIGH above, over the REAL tree: an app input IS a binary
  // (a `.ttf` under `apps/mobile/assets/fonts/`) and its BYTES are keyed, not a
  // lossy text decode of them.
  test("a real binary input is keyed by its BYTES: flipping a lossy byte moves the key", async () => {
    const repo = join(import.meta.dir, "..", "..", "..");
    const inputs = await appCacheInputs(repo);
    const font = inputs.find((file) => file.path === "apps/mobile/assets/fonts/Figtree-Bold.ttf");
    expect(font).toBeDefined();
    if (font === undefined || typeof font.content === "string") {
      throw new Error("the font input is missing or is not bytes");
    }
    const bytes = new Uint8Array(font.content.buffer, font.content.byteOffset, font.content.length);
    // The bug's premise on real data: this font is not valid UTF-8, so the old
    // text read (`readFile(…, "utf8")`) loses bytes.
    const decode = new TextDecoder("utf-8");
    const text = decode.decode(bytes);
    expect(text).toContain("\uFFFD");
    const at = firstInvalidByte(bytes);
    expect(at).toBeGreaterThan(-1);
    const flipped = Uint8Array.from(font.content);
    const before = flipped[at] ?? 0;
    flipped[at] = before === 0xff ? 0xfe : 0xff;
    // The two files differ only in bytes the TEXT decode discards…
    expect(decode.decode(flipped)).toBe(text);
    // …and that is exactly the collision the byte key must not have.
    const extras = { xcode: "x", bun: "b" };
    const changed = inputs.map((file) =>
      file.path === font.path ? { ...file, content: flipped } : file,
    );
    expect(appCacheKey(changed, extras)).not.toBe(appCacheKey(inputs, extras));
  });
});

/** The offset of the first byte that starts an invalid UTF-8 sequence, or -1. */
function firstInvalidByte(bytes: Uint8Array): number {
  let at = 0;
  while (at < bytes.length) {
    const lead = bytes[at] ?? 0;
    const length = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0;
    if (length === 0) {
      return at;
    }
    for (let next = 1; next < length; next += 1) {
      const continuation = bytes[at + next] ?? 0;
      if (continuation < 0x80 || continuation >= 0xc0) {
        return at;
      }
    }
    at += length;
  }
  return -1;
}

describe("cacheEvictions", () => {
  const entry = (key: string, mtimeMs: number) => ({ key, mtimeMs });

  test("keeps the newest N and names the rest", () => {
    const entries = [entry("old", 1), entry("new", 3), entry("mid", 2)];
    expect(cacheEvictions(entries, 3)).toEqual([]);
    expect(cacheEvictions(entries, 2)).toEqual(["old"]);
    expect(cacheEvictions(entries, 1)).toEqual(["old", "mid"]);
    expect(cacheEvictions(entries, 0)).toEqual(["old", "mid", "new"]);
  });
});

describe("relayLine", () => {
  test("the label is a suffix, so ✗ stays in column 0 and $2 is the flow", () => {
    const line = relayLine("sim-0FA4B51F", "✗ 07-prompt (iOS 26) fail");
    expect(line.startsWith("✗")).toBe(true);
    expect(line.split(" ")[1]).toBe("07-prompt");
    expect(line.endsWith("[sim-0FA4B51F]")).toBe(true);
  });

  test("a ✓ line and a plain line keep their shape too", () => {
    expect(relayLine("sim-a", "✓ 01-shell (iOS 26) pass").split(" ")[1]).toBe("01-shell");
    expect(relayLine("sim-a", "").trim()).toBe("[sim-a]");
  });
});

// Review round 1 MEDIUM: the relay split each `data` chunk on `\n`, so a line
// cut across two pipe reads printed as two lines — and `awk '$2'` (P6) then read
// a flow name that was not there.
describe("frameLines (a pipe read is not a line)", () => {
  const feed = (chunks: readonly Uint8Array[]): string[] => {
    let carry: Uint8Array = new Uint8Array(0);
    const lines: string[] = [];
    for (const chunk of chunks) {
      const framed = frameLines(carry, chunk);
      lines.push(...framed.lines);
      carry = framed.carry;
    }
    if (carry.length > 0) {
      lines.push(...flushLines(carry));
    }
    return lines;
  };
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  test("a line cut across two chunks is ONE line", () => {
    const all = bytes("✓ 01-shell (iOS 26) pass\n✗ 07-prompt (iOS 26) fail\n");
    const cut = all.indexOf(0x30); // inside "07-prompt"
    const lines = feed([all.subarray(0, cut), all.subarray(cut)]);
    expect(lines).toEqual(["✓ 01-shell (iOS 26) pass", "✗ 07-prompt (iOS 26) fail"]);
    expect(lines[1]?.split(" ")[1]).toBe("07-prompt");
  });

  test("a multi-byte ✗ cut in half is not two replacement characters", () => {
    const all = bytes("✗ 07-prompt fail\n");
    const inside = all.indexOf(0xe2) + 1; // inside the 3-byte ✗
    const lines = feed([all.subarray(0, inside), all.subarray(inside)]);
    expect(lines).toEqual(["✗ 07-prompt fail"]);
    expect(lines[0]?.startsWith("✗")).toBe(true);
  });

  test("many chunks, one byte each: still the same two lines", () => {
    const all = bytes("a\n✗ b\n");
    const chunks = [...all].map((byte) => Uint8Array.from([byte]));
    expect(feed(chunks)).toEqual(["a", "✗ b"]);
  });

  test("the carry holds only the OPEN line (an empty line is a line)", () => {
    const framed = frameLines(new Uint8Array(0), bytes("a\n\nb"));
    expect(framed.lines).toEqual(["a", ""]);
    expect(Buffer.from(framed.carry).toString("utf8")).toBe("b");
  });

  // A last line with no `\n` is a line (a child killed mid-write), and a
  // trailing `\n` must not invent a blank one.
  test("at EOF the open line is flushed, and a trailing newline is not a blank line", () => {
    const open = frameLines(new Uint8Array(0), bytes("a\nb"));
    expect(open.lines).toEqual(["a"]);
    expect(flushLines(open.carry)).toEqual(["b"]);
    const closed = frameLines(new Uint8Array(0), bytes("a\nb\n"));
    expect(flushLines(closed.carry)).toEqual([]);
    expect(flushLines(new Uint8Array(0))).toEqual([]);
  });
});
