import { describe, expect, test } from "bun:test";
import { type ResourceKey, type Tool, pathResource } from "@tentacle/core";
import { z } from "zod";
import {
  type CallClass,
  classOf,
  dependencies,
  isReadClass,
  nextRunnable,
  planGroups,
  planRound,
  spawnDependencies,
  spawnKindOf,
} from "../src/round-plan.ts";

const r = (path: string): CallClass => [{ mode: "read", resource: pathResource(path) }];
const w = (path: string): CallClass => [{ mode: "write", resource: pathResource(path) }];
const x: CallClass = "exclusive";

describe("planRound (T-P, docs/feat/parallel-agents.md)", () => {
  const tools = { mode: "read-only", maxParallel: 8 } as const;
  const parallel = { mode: "parallel", cap: 4 } as const;
  const show = (groups: ReturnType<typeof planRound>) =>
    groups.map((g) => `${g.lane}:${g.indexes.join(",")}`);

  test("[a, a, read, a] → [a,a] [read] [a]", () => {
    const groups = planRound(
      [x, x, r("f"), x],
      ["writer", "read-only", undefined, "writer"],
      tools,
      parallel,
    );
    expect(show(groups)).toEqual(["agents:0,1", "tools:2", "agents:3"]);
  });

  test("read-only: writers are not admissible, and stay alone in the tools' lane", () => {
    const groups = planRound(
      [x, x, x, x],
      ["read-only", "read-only", "writer", "read-only"],
      tools,
      { mode: "read-only", cap: 4 },
    );
    expect(show(groups)).toEqual(["agents:0,1", "tools:2", "agents:3"]);
  });

  test("sequential, or a cap of one: every spawn alone", () => {
    const kinds = ["writer", "read-only"] as const;
    for (const agents of [
      { mode: "sequential", cap: 4 } as const,
      { mode: "parallel", cap: 1 } as const,
    ]) {
      expect(show(planRound([x, x], kinds, tools, agents))).toEqual(["tools:0", "tools:1"]);
    }
  });

  test("a read never joins a spawn's group, whatever the tools' mode", () => {
    const groups = planRound(
      [r("a"), x, x, r("b"), r("c")],
      [undefined, "read-only", "read-only", undefined, undefined],
      tools,
      parallel,
    );
    expect(show(groups)).toEqual(["tools:0", "agents:1,2", "tools:3,4"]);
  });

  test("with no spawn: byte-identical to planGroups, in every mode", () => {
    const round = [r("a"), r("b"), w("c"), r("d"), x, r("e")];
    const kinds = round.map(() => undefined);
    for (const mode of ["sequential", "read-only", "parallel"] as const) {
      for (const maxParallel of [1, 8]) {
        const plan = planRound(round, kinds, { mode, maxParallel }, parallel);
        expect(plan.every((g) => g.lane === "tools")).toBe(true);
        expect(plan.map((g) => [...g.indexes])).toEqual(planGroups(round, mode, maxParallel));
      }
    }
  });

  test("an empty round", () => {
    expect(planRound([], [], tools, parallel)).toEqual([]);
  });
});

describe("spawn dependencies and the cap (T-P)", () => {
  test("admissible spawns wait for nothing", () => {
    expect(spawnDependencies(["writer", "read-only", "writer"], "parallel")).toEqual([[], [], []]);
  });

  test("a kind rewritten by a hook: waits for every earlier call, every later one waits for it", () => {
    expect(spawnDependencies(["read-only", "writer", "read-only"], "read-only")).toEqual([
      [],
      [0],
      [1],
    ]);
    expect(spawnDependencies(["read-only", undefined, "read-only"], "parallel")).toEqual([
      [],
      [0],
      [1],
    ]);
    expect(spawnDependencies(["writer", "writer", "read-only"], "read-only")).toEqual([
      [],
      [0],
      [0, 1],
    ]);
  });

  test("spawnKindOf is total", () => {
    const base = { name: "t", description: "", inputSchema: z.object({}), permission: "none" };
    const tool = (spawnKind: unknown) =>
      ({ ...base, spawnKind, execute: async () => ({ content: "" }) }) as unknown as Tool;
    expect(spawnKindOf(undefined, {})).toBeUndefined();
    expect(spawnKindOf(tool(undefined), {})).toBeUndefined();
    expect(
      spawnKindOf(
        tool(() => "writer"),
        {},
      ),
    ).toBe("writer");
    expect(
      spawnKindOf(
        tool(() => "nonsense"),
        {},
      ),
    ).toBeUndefined();
    expect(
      spawnKindOf(
        tool(() => {
          throw new Error("bad input");
        }),
        {},
      ),
    ).toBeUndefined();
  });
});

describe("planGroups (T-P)", () => {
  const round = [r("a"), r("b"), w("c"), r("d"), x, r("e")];

  test("sequential: every call alone", () => {
    expect(planGroups(round, "sequential", 8)).toEqual([[0], [1], [2], [3], [4], [5]]);
  });

  test("read-only: runs of consecutive read-class calls; a write never grouped", () => {
    expect(planGroups(round, "read-only", 8)).toEqual([[0, 1], [2], [3], [4], [5]]);
    expect(planGroups([w("a"), w("b")], "read-only", 8)).toEqual([[0], [1]]);
  });

  test("parallel: runs of non-exclusive calls (writes on different paths too)", () => {
    expect(planGroups(round, "parallel", 8)).toEqual([[0, 1, 2, 3], [4], [5]]);
    expect(planGroups([w("a"), w("b")], "parallel", 8)).toEqual([[0, 1]]);
  });

  test("maxParallel 1 → every call alone, in any mode", () => {
    expect(planGroups(round, "parallel", 1)).toEqual([[0], [1], [2], [3], [4], [5]]);
    expect(planGroups(round, "read-only", 1)).toEqual([[0], [1], [2], [3], [4], [5]]);
  });

  test("empty round → no groups; covers every call once, in order", () => {
    expect(planGroups([], "parallel", 8)).toEqual([]);
    expect(planGroups(round, "parallel", 8).flat()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("empty keys: not read-class, but not exclusive", () => {
    expect(isReadClass([])).toBe(false);
    expect(planGroups([[], r("a")], "read-only", 8)).toEqual([[0], [1]]);
    expect(planGroups([[], r("a")], "parallel", 8)).toEqual([[0, 1]]);
  });
});

describe("dependencies (T-P)", () => {
  test("[read a, edit b, read a] → none", () => {
    expect(dependencies([r("a"), w("b"), r("a")], "parallel")).toEqual([[], [], []]);
  });

  test("[edit a, read a] → 1 waits on 0", () => {
    expect(dependencies([w("a"), r("a")], "parallel")).toEqual([[], [0]]);
  });

  test("A.ts and /x/a.ts conflict (case-folded basename)", () => {
    expect(dependencies([w("A.ts"), r("/x/a.ts")], "parallel")).toEqual([[], [0]]);
    expect(dependencies([w("./x/../a.ts"), w("a.ts")], "parallel")).toEqual([[], [0]]);
  });

  test("a class that left the mode after hooks is exclusive", () => {
    // read-only: a call that became a write waits for all earlier, all later wait on it.
    expect(dependencies([r("a"), w("b"), r("c")], "read-only")).toEqual([[], [0], [1]]);
    expect(dependencies([r("a"), x, r("c")], "parallel")).toEqual([[], [0], [1]]);
  });
});

describe("nextRunnable (T-P)", () => {
  test("lowest pending whose deps settled, under the cap", () => {
    const deps = [[], [0], [], []];
    const status: ("pending" | "running" | "settled")[] = [
      "pending",
      "pending",
      "pending",
      "pending",
    ];
    expect(nextRunnable(deps, status, 2)).toBe(0);
    status[0] = "running";
    expect(nextRunnable(deps, status, 2)).toBe(2);
    status[2] = "running";
    expect(nextRunnable(deps, status, 2)).toBeUndefined(); // cap
    status[0] = "settled";
    expect(nextRunnable(deps, status, 2)).toBe(1);
  });

  test("nothing pending → undefined", () => {
    expect(nextRunnable([[]], ["settled"], 4)).toBeUndefined();
  });
});

describe("classOf (T-K)", () => {
  const base = {
    description: "t",
    inputSchema: z.unknown(),
    permission: "none" as const,
    async execute() {
      return { content: "" };
    },
  };
  test("absent tool or absent concurrency → exclusive", () => {
    expect(classOf(undefined, {})).toBe("exclusive");
    expect(classOf({ ...base, name: "t" } as Tool, {})).toBe("exclusive");
  });
  test("a throwing key function → exclusive", () => {
    const tool: Tool = {
      ...base,
      name: "t",
      concurrency: () => {
        throw new Error("boom");
      },
    };
    expect(classOf(tool, {})).toBe("exclusive");
  });
  test("keys pass through", () => {
    const keys: ResourceKey[] = [{ mode: "read", resource: "mcp:s" }];
    const tool: Tool = { ...base, name: "t", concurrency: () => keys };
    expect(classOf(tool, {})).toEqual(keys);
  });
});
