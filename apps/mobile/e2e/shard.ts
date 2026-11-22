/**
 * The parallel e2e gate's DECISIONS (docs/feat/e2e-parallel-gate.md), pure and
 * React-free (AGENTS §7): which flows may not be separated, how the shards are
 * balanced, how their summaries merge into one table and one exit code, and what
 * an app cache key covers.
 *
 * The gate runs the same suite on two simulators at once, so every choice that
 * could make the merged result differ from a single-simulator run is made HERE,
 * where a unit test can pin it: `run.ts` and `parallel.ts` only gather inputs
 * (flow texts, past durations, git listings) and act on the answers.
 */

import { createHash } from "node:crypto";

import type { FlowResult, GateTag, Verdict } from "./gate.ts";

/**
 * Where each seeded id a flow is given comes from (`run.ts` `spawnFlow`'s `-e`
 * list, built FROM this map). Key order IS the flag order, and the keys ARE
 * `SHARED_SEED_VARS` — one constant, so a new seeded session cannot be given to
 * the flows yet stay invisible to the "these flows cannot be separated" rule.
 */
export const SEED_VAR_SOURCES = {
  ALPHA_ID: "alphaId",
  BRAVO_ID: "bravoId",
  CHARLIE_ID: "charlieId",
  ASK1_ID: "ask1",
  ASK2_ID: "ask2",
  ASK3_ID: "ask3",
  ASK4_ID: "ask4",
  ASK5_ID: "ask5",
} as const satisfies Record<string, string>;

/** The seeded session ids every flow is given, in flag order. */
export const SHARED_SEED_VARS: readonly string[] = Object.keys(SEED_VAR_SOURCES);

/** The content marker of a tracked file deleted from the worktree. */
export const DELETED = "\u0000deleted";

/** A flow with no recorded duration costs this (the last gate's median, rounded). */
export const DEFAULT_FLOW_SECONDS = 60;

/**
 * The app cache key's schema tag: bump it when the BUILD's inputs change shape
 * (a new plugin, a new native dir) so every old entry is retired at once.
 */
export const KEY_SCHEMA = "e2e-app-v1";

/** One past run's results (`<runDir>/summary.json`), for the duration history. */
export interface PastRun {
  readonly runId: number;
  readonly results: readonly FlowResult[];
}

/** One file's contribution to the app cache key. */
export interface AppInput {
  readonly path: string;
  /** The file's bytes as text; `DELETED` for a tracked file gone from the worktree. */
  readonly content: string;
}

/** The non-file halves of the key: what a rebuild would also change. */
export interface AppKeyExtras {
  readonly xcode: string;
  readonly bun: string;
}

/** A cached build: its key and when it was stored (for eviction). */
export interface CacheEntry {
  readonly key: string;
  readonly mtimeMs: number;
}

/** One shard's contribution to the merged summary. */
export interface ShardResultInput {
  readonly label: string;
  /** The child's run dir, where its flows' output lives (and where a red points). */
  readonly dir: string;
  readonly flows: readonly string[];
  readonly results: readonly FlowResult[] | undefined;
}

export interface MergeInput {
  readonly order: readonly string[];
  /** The parent's own rows for the flows it never sent to a child. */
  readonly quarantined: readonly FlowResult[];
  readonly shards: readonly ShardResultInput[];
  /** A flow's gate tags, so a missing known-bug/flaky flow is not miscounted. */
  readonly tagsOf?: (flow: string) => readonly GateTag[];
}

/**
 * The simulators a run drives: `<udid>` (today's form) or `<udidA>,<udidB>[,…]`
 * (the parallel one). A duplicate or an empty item is refused BEFORE any build:
 * two children on one simulator would fight over its driver, and a typo would
 * otherwise only show up 20 minutes in.
 */
export function parseUdids(value: string): readonly string[] {
  const items = value.split(",").map((item) => item.trim());
  if (items.length === 1 && items[0] === "") {
    throw new Error("no simulator: give a udid, or a comma-separated list of udids");
  }
  if (items.some((item) => item === "")) {
    throw new Error(`empty simulator in ${JSON.stringify(value)} (a stray comma?)`);
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) {
      throw new Error(`simulator ${item} named twice`);
    }
    seen.add(item);
  }
  return items;
}

/** Whether `text` mentions `name` as a whole identifier (`${X}`, or a bare `X` in a js). */
function mentions(text: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);
}

/**
 * The flows that must stay together, as groups: a flow is with another one when
 * both mention a shared seeded session, directly or through a third flow that
 * mentions two (`06` reads ALPHA and CHARLIE, so `02` and `07` travel with it).
 * `textOf` supplies a flow's own yaml PLUS every flow script it names (the `.js`
 * files read the ids bare).
 */
export function flowGroups(
  runnable: readonly string[],
  textOf: (flow: string) => string,
): readonly (readonly string[])[] {
  // Union-find over the VARIABLES: a flow with two of them is the bridge.
  const parent = new Map<string, string>(SHARED_SEED_VARS.map((name) => [name, name]));
  const find = (name: string): string => {
    let current = name;
    for (;;) {
      const next = parent.get(current) ?? current;
      if (next === current) {
        return current;
      }
      current = next;
    }
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      // The EARLIER var is the root, so the outcome does not depend on order.
      const [keep, drop] =
        SHARED_SEED_VARS.indexOf(rootA) <= SHARED_SEED_VARS.indexOf(rootB)
          ? [rootA, rootB]
          : [rootB, rootA];
      parent.set(drop, keep);
    }
  };
  const varsOf = new Map<string, readonly string[]>();
  for (const flow of runnable) {
    const text = textOf(flow);
    const own = SHARED_SEED_VARS.filter((name) => mentions(text, name));
    varsOf.set(flow, own);
    const [first] = own;
    if (first !== undefined) {
      for (const other of own) {
        union(first, other);
      }
    }
  }
  // Then the flows, grouped by the (settled) root of their first variable, in
  // `runnable`'s order both between groups and inside them.
  const groups = new Map<string, string[]>();
  for (const flow of runnable) {
    const [first] = varsOf.get(flow) ?? [];
    const key = first === undefined ? `solo:${flow}` : `var:${find(first)}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [flow]);
    } else {
      group.push(flow);
    }
  }
  return [...groups.values()];
}

/**
 * Each flow's last measured wall time: the NEWEST run that recorded it wins, and
 * a quarantined row (`seconds: 0`, it never ran) records nothing. An older run
 * fills the flows a newer one lacks (a `--only` run, a run with a new flow).
 */
export function latestDurations(summaries: readonly PastRun[]): ReadonlyMap<string, number> {
  const durations = new Map<string, number>();
  const newestFirst = [...summaries].sort((a, b) => b.runId - a.runId);
  for (const summary of newestFirst) {
    for (const result of summary.results) {
      if (result.status === "quarantined" || durations.has(result.name)) {
        continue;
      }
      durations.set(result.name, result.seconds);
    }
  }
  return durations;
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) {
    return DEFAULT_FLOW_SECONDS;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? DEFAULT_FLOW_SECONDS;
}

/** The seeded sessions, as `run.ts` receives them (`seedSessions`' result). */
export interface SeededSessions {
  readonly alphaId: string;
  readonly bravoId: string;
  readonly charlieId: string;
  readonly askIds: readonly string[];
}

/**
 * Maestro's `-e` values for the seeded ids: the SAME list the shard splitter
 * unions over, so "a flow reads ALPHA" and "ALPHA was passed to this flow" are
 * one fact (a drift here would split two flows that mutate one session).
 */
export function seedValues(seeded: SeededSessions): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, source] of Object.entries(SEED_VAR_SOURCES)) {
    if (source.startsWith("ask")) {
      values[name] = seeded.askIds[Number(source.slice(3)) - 1] ?? "";
      continue;
    }
    values[name] = seeded[source as "alphaId" | "bravoId" | "charlieId"];
  }
  return values;
}

/**
 * Balance `groups` over `n` shards: the biggest group first, each onto the
 * currently lightest shard (ties to the lowest index), then every shard back in
 * `order`. Deterministic — the same inputs always give the same split — and a
 * group is never separated, so a flow on a seeded session keeps its order.
 *
 * This is the classic LPT bound: the two halves cannot differ by more than the
 * largest group, which for this suite is one long flow (~4 min of ~70).
 */
export function splitShards(
  groups: readonly (readonly string[])[],
  durations: ReadonlyMap<string, number>,
  n: number,
  order: readonly string[],
): readonly (readonly string[])[] {
  const unknown = medianOf([...durations.values()]);
  const index = new Map(order.map((flow, at) => [flow, at]));
  const at = (flow: string) => index.get(flow) ?? Number.MAX_SAFE_INTEGER;
  const costOf = (group: readonly string[]) =>
    group.reduce((sum, flow) => sum + (durations.get(flow) ?? unknown), 0);
  // Biggest first; tie → the group whose earliest flow comes first in `order`.
  const queue = [...groups]
    .map((group) => ({ group, cost: costOf(group), first: Math.min(...group.map(at)) }))
    .sort((a, b) => b.cost - a.cost || a.first - b.first);
  const shards: string[][] = Array.from({ length: Math.max(n, 1) }, () => []);
  const loads = shards.map(() => 0);
  for (const { group, cost } of queue) {
    const lightest = loads.indexOf(Math.min(...loads));
    const shard = shards[lightest];
    if (shard === undefined) {
      continue;
    }
    shard.push(...group);
    loads[lightest] = (loads[lightest] ?? 0) + cost;
  }
  return shards.map((shard) => [...shard].sort((a, b) => at(a) - at(b)));
}

/**
 * The one merged result list, in the same `order` a single-simulator summary
 * uses. Every flow the parent sent appears EXACTLY once:
 *
 * - a flow missing from its shard's summary (the child crashed, or exited 2
 *   before writing one) becomes a `fail` row pointing at that shard's dir — a
 *   flow that never ran is RED, never skipped: the gate does not get weaker;
 * - a flow present twice, or one the parent never sent, is a bad merge: throw,
 *   and the parent exits 1 (a summary it cannot trust must not look green).
 */
export function mergeShardResults(input: MergeInput): readonly FlowResult[] {
  const sent = new Set(input.shards.flatMap((shard) => shard.flows));
  const byName = new Map<string, FlowResult>();
  for (const row of input.quarantined) {
    byName.set(row.name, row);
  }
  for (const shard of input.shards) {
    for (const result of shard.results ?? []) {
      if (!sent.has(result.name)) {
        throw new Error(
          `${result.name}: reported by ${shard.label} but the parent never sent it to a shard`,
        );
      }
      if (byName.has(result.name)) {
        throw new Error(`${result.name}: in two shards' results (${shard.label} is the second)`);
      }
      byName.set(result.name, result);
    }
    for (const flow of shard.flows) {
      if (byName.has(flow)) {
        continue;
      }
      byName.set(flow, {
        name: flow,
        status: "fail",
        seconds: 0,
        attempts: 0,
        tags: input.tagsOf?.(flow) ?? [],
        outDir: shard.dir,
      });
    }
  }
  const merged = [...byName.values()];
  const at = (flow: string) => input.order.indexOf(flow);
  const position = new Map(merged.map((row) => [row.name, at(row.name)]));
  return merged.sort(
    (a, b) =>
      (position.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
      (position.get(b.name) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * The parent's exit code. A child's prerequisite (2) or build/install code wins,
 * because it means that half of the run never really happened. Otherwise a child
 * that said RED — code 1, or `null` for one a signal killed — makes the gate red
 * even if the merged summary somehow looks green: a child's own failure must
 * never be washed out by the merge. Only when every child exited 0 does the
 * merged verdict decide (it is then the same 0/1 answer).
 */
export function parallelExitCode(childCodes: readonly (number | null)[], verdict: Verdict): number {
  const rest = childCodes.map((code) => code ?? 1);
  const other = rest.find((code) => code !== 0 && code !== 1);
  if (other !== undefined) {
    return other;
  }
  if (rest.some((code) => code !== 0)) {
    return 1;
  }
  return verdict.exitCode;
}

/** The ANSI SGR sequences a build log carries (the install line is coloured). */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * The `.app` the build actually produced, read from `expo run:ios`'s own log:
 * the LAST `› Installing <path>.app` line (a retried build prints several). It
 * is what makes one build installable on a second simulator; no line at all is
 * `undefined`, never a guess (the run then proceeds uncached, with a warning).
 */
export function builtAppPath(log: string): string | undefined {
  let found: string | undefined;
  for (const line of log.replace(SGR, "").split("\n")) {
    const match = /Installing (.+?\.app)\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      found = match[1];
    }
  }
  return found;
}

/**
 * What the Release build is made of, and therefore what a cached one may be
 * reused for. Over-inclusive on purpose (a stale app is the one failure that
 * would silently weaken the gate): every tracked-or-new file the app imports —
 * `apps/`, `packages/`, the lockfile, patches — minus the parts the BUNDLER
 * never sees (the harness `apps/mobile/e2e/`, the unit tests) and plus what a
 * rebuild would also change (Xcode, Bun, the configuration, the schema tag).
 */
export function appCacheKey(files: readonly AppInput[], extras: AppKeyExtras): string {
  const hash = createHash("sha256");
  hash.update(`${KEY_SCHEMA}\u0000`);
  hash.update(`xcode\u0000${extras.xcode}\u0000`);
  hash.update(`bun\u0000${extras.bun}\u0000`);
  hash.update("configuration\u0000Release\u0000");
  const kept = files
    .filter((file) => !isHarnessOrTest(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of kept) {
    hash.update(`${file.path}\u0000${file.content}\u0000`);
  }
  return hash.digest("hex");
}

/** The parts of the tree the Release bundle never imports. */
export function isHarnessOrTest(path: string): boolean {
  return (
    path.startsWith("apps/mobile/e2e/") ||
    path.startsWith("apps/mobile/test/") ||
    /^packages\/[^/]+\/test\//.test(path)
  );
}

/**
 * The cache entries to delete after a store: everything but the `keep` newest,
 * oldest first (an app is ~100–200 MB). A failed delete is the caller's to
 * ignore — a cache that cannot prune itself must not fail a gate.
 */
export function cacheEvictions(entries: readonly CacheEntry[], keep: number): readonly string[] {
  const newestFirst = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
  return newestFirst
    .slice(Math.max(keep, 0))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map((entry) => entry.key);
}

/**
 * One child's log line, tagged with its shard: the label is a SUFFIX, so `✗`
 * stays in column 0 and the flow name stays the second whitespace-separated
 * field — which is what the orchestration launchers grep and `awk '$2'`
 * (docs/feat/e2e-parallel-gate.md P6).
 */
export function relayLine(label: string, line: string): string {
  return `${line}  [${label}]`;
}

/**
 * A shard's name, from its simulator: short enough to read at the end of a log
 * line, unique per UDID (`parseUdids` refuses duplicates), and stable across
 * runs so a launcher can grep one shard's log.
 */
export function shardLabel(udid: string): string {
  return `sim-${udid.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
}
