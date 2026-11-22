/**
 * The parallel form of the e2e gate (docs/feat/e2e-parallel-gate.md): ONE Release
 * build, installed on N simulators, the flows split between them by their last
 * recorded durations, and ONE merged summary + exit code.
 *
 * This file is the effectful half on purpose: every DECISION lives in
 * `shard.ts` (pure, unit-tested), and this one only does what the decisions say
 * — validate the devices, build once, spawn `run.ts --shard-of` children, relay
 * their lines, merge their summaries. AGENTS §7: a pure module decides, this
 * only acts.
 *
 * A child is the SINGLE-simulator path with three differences (`--shard-of`): it
 * owns a run dir inside the parent's, it never builds (it is given `--app`), and
 * it never runs the Swift tests (the parent does, once, for both).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { $ } from "bun";
import { type FlowResult, type Verdict, deviceChoice, summaryText, verdictOf } from "./gate.ts";
import type { IosMajor } from "./preflight.ts";
import {
  FLOWS,
  REPO,
  RUNS_DIR,
  flowMetas,
  resolveApp,
  runSwiftTests,
  selectedFlows,
  simctlDevices,
  versionOf,
} from "./run.ts";
import {
  type PastRun,
  flowGroups,
  latestDurations,
  mergeShardResults,
  parallelExitCode,
  relayLine,
  shardLabel,
  splitShards,
} from "./shard.ts";

/** The options the parallel form accepts, after `run.ts`'s own parsing. */
export interface ParallelOptions {
  /** `--only`: the flows this run drives, BEFORE the split. */
  readonly flows: readonly string[];
  /** `--ios`, already validated. */
  readonly only: IosMajor | undefined;
  readonly flowTimeoutS: number | undefined;
  readonly noAppCache: boolean;
}

/** One simulator's share: what the child is told, and what it has taken before. */
interface Shard {
  readonly label: string;
  readonly udid: string;
  readonly flows: readonly string[];
  /** The wall time its flows have taken historically; 0 when nothing is known. */
  readonly seconds: number;
}

/**
 * Run the whole suite on several simulators at once. Returns the gate's exit
 * code, with the single-simulator meanings: 0 green, 1 a counted flow is red,
 * 2 a prerequisite (before any build), anything else the build/install.
 */
export async function runParallel(
  udids: readonly string[],
  options: ParallelOptions,
): Promise<number> {
  const started = Date.now();
  const runId = started;
  const parentDir = join(RUNS_DIR, String(runId));
  const firstUdid = udids[0];
  if (firstUdid === undefined) {
    console.error("e2e:mobile: no simulator: give a udid, or a comma-separated list");
    return 2;
  }
  // Every simulator must be usable BEFORE anything is built or spawned: an
  // unknown UDID then costs a second, not a Release build (D2.1).
  const devicesJson = await simctlDevices();
  for (const udid of udids) {
    const choice = deviceChoice(devicesJson, udid, options.only);
    if (choice.kind === "unknown") {
      console.error(choice.message);
      return 2;
    }
  }
  // The Swift suite ONCE, here: two children running `swift test` would fight
  // over SwiftPM's `.build` lock, and it tests native sources, not a simulator.
  const swift = await runSwiftTests();
  if (swift !== 0) {
    console.error(`test:swift failed (${swift})`);
    return 2;
  }
  await mkdir(parentDir, { recursive: true });
  console.log(`e2e:mobile run ${runId} on ${udids.length} simulators`);

  // The app ONCE, on the first simulator: installing needs it booted, and every
  // child boots its own later (D5).
  await boot(firstUdid);
  const resolved = await resolveApp({
    device: firstUdid,
    runDir: parentDir,
    major: deviceMajor(devicesJson, firstUdid),
    app: undefined,
    noAppCache: options.noAppCache,
  });
  if (resolved.code !== 0) {
    console.error(`build/install failed (exit ${resolved.code})`);
    return resolved.code;
  }
  const appSource = resolved.appPath;
  if (appSource === undefined) {
    console.error("build/install produced no .app path");
    return 1;
  }

  // The split. Quarantined flows never reach a child: the parent reports them
  // itself, in the shape the single path uses (0 s, 0 tries).
  const metas = flowMetas(options.flows);
  const quarantined: FlowResult[] = [];
  const runnable: string[] = [];
  for (const flow of options.flows) {
    const tags = metas.get(flow)?.tags ?? [];
    if (tags.includes("quarantine")) {
      quarantined.push({ name: flow, status: "quarantined", seconds: 0, attempts: 0, tags });
      continue;
    }
    runnable.push(flow);
  }
  const durations = latestDurations(await readHistory(RUNS_DIR));
  const halves = splitShards(
    flowGroups(runnable, flowText),
    durations,
    udids.length,
    options.flows,
  );
  const shards: Shard[] = halves.map((flows, index) => ({
    label: shardLabel(udids[index] ?? ""),
    udid: udids[index] ?? "",
    flows,
    seconds: flows.reduce((sum, flow) => sum + (durations.get(flow) ?? 0), 0),
  }));
  const manifest = {
    runId,
    udids,
    appSource,
    shards: shards.map((shard) => ({
      label: shard.label,
      udid: shard.udid,
      flows: shard.flows,
      seconds: Math.round(shard.seconds),
    })),
  };
  await writeFile(join(parentDir, "parent.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const shard of shards) {
    console.log(
      `${shard.label}: ${shard.flows.length} flows, ${Math.round(shard.seconds)} s of history`,
    );
  }

  // A shard with nothing to run spawns nothing: an `--only` of one flow across
  // two simulators is not an error, the second half is simply empty.
  const spawning = shards.filter((shard) => shard.flows.length > 0);
  const codes = await runChildren(spawning, { parentDir, appSource, options });

  // The merge: every flow the parent sent appears exactly once, in `FLOWS`
  // order, and a flow a dead child never reported is RED (never skipped).
  const merged = mergeShardResults({
    order: options.flows,
    quarantined,
    tagsOf: (flow) => metas.get(flow)?.tags ?? [],
    shards: shards.map((shard) => ({
      label: shard.label,
      dir: join(parentDir, shard.label),
      flows: shard.flows,
      results: shardResults(shard, spawning, codes, parentDir),
    })),
  });
  const verdict = verdictOf(merged);
  const summary = summaryText(merged, metas);
  await writeFile(join(parentDir, "summary.txt"), summary);
  await writeFile(join(parentDir, "summary.json"), `${JSON.stringify(merged, null, 2)}\n`);
  for (const line of summary.trimEnd().split("\n")) {
    console.log(line);
  }
  const wall = Math.round((Date.now() - started) / 1000);
  console.log(
    `wall ${wall} s on ${udids.length} simulators (shards: ${shards
      .map((shard) => `${shard.label} ${Math.round(shard.seconds)} s of history`)
      .join(", ")})`,
  );
  console.log(`results in ${parentDir}`);
  return parallelExitCode(codes, verdict);
}

/** Boot a simulator and wait for it, the same two commands the single path runs. */
async function boot(udid: string): Promise<void> {
  await $`xcrun simctl boot ${udid}`.quiet().nothrow();
  await $`xcrun simctl bootstatus ${udid} -b`.quiet().nothrow();
}

/** The iOS major of a validated device (it was already accepted by `deviceChoice`). */
function deviceMajor(devicesJson: string, udid: string): IosMajor {
  const choice = deviceChoice(devicesJson, udid, undefined);
  return choice.kind === "device" ? choice.major : 26;
}

/**
 * A flow's text for the splitter: its own yaml PLUS every flow file it names,
 * recursively (`runFlow: _pair.yaml`, `file: "09-laptop-hold.js"` — the `.js`
 * scripts read a seeded id BARE, with no `${}`), so a dependency is followed at
 * any depth. A visited set stops a flow that names itself.
 */
export function flowText(flow: string, seen: Set<string> = new Set()): string {
  if (seen.has(flow)) {
    return "";
  }
  seen.add(flow);
  const dir = join(REPO, "apps", "mobile", "e2e", "flows");
  const own = readFileSync(join(dir, `${flow}.yaml`), "utf8");
  const named = new Set<string>();
  for (const line of own.split("\n")) {
    const run = /^\s*-\s*runFlow:\s*(\S+)\s*$/.exec(line);
    const file = /^\s*file:\s*"?([\w.-]+)"?\s*$/.exec(line);
    for (const match of [run?.[1], file?.[1]]) {
      if (match === undefined) {
        continue;
      }
      named.add(basename(match).replace(/\.(yaml|js)$/, ""));
    }
  }
  let text = own;
  for (const name of named) {
    for (const ext of [".yaml", ".js"]) {
      if (existsSync(join(dir, `${name}${ext}`))) {
        text += `\n${ext === ".yaml" ? flowText(name, seen) : readFileSync(join(dir, `${name}${ext}`), "utf8")}`;
        break;
      }
    }
  }
  return text;
}

/**
 * Run the children CONCURRENTLY (that is the whole point), each line relayed
 * with its shard as a SUFFIX so a launcher's `^✗` and `awk '$2'` still find the
 * flow name (P6), and one log file each. Returns their exit codes, in order.
 */
async function runChildren(
  shards: readonly Shard[],
  context: { parentDir: string; appSource: string; options: ParallelOptions },
): Promise<readonly (number | null)[]> {
  const { parentDir, appSource, options } = context;
  return Promise.all(
    shards.map(async (shard) => {
      const args = [
        "run",
        join(REPO, "apps", "mobile", "e2e", "run.ts"),
        "--udid",
        shard.udid,
        "--app",
        appSource,
        "--only",
        shard.flows.join(","),
        "--shard-of",
        parentDir,
        ...(options.flowTimeoutS === undefined
          ? []
          : ["--flow-timeout", String(options.flowTimeoutS)]),
      ];
      const child = spawn(process.execPath, args, {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const lines: string[] = [];
      const relay = (chunk: Buffer): void => {
        for (const line of chunk.toString().split("\n")) {
          if (line !== "") {
            lines.push(line);
            // A suffix, never a prefix: `✗ 07-prompt (iOS 26) fail` keeps `✗` in
            // column 0 and the flow name as the second field.
            console.log(relayLine(shard.label, line));
          }
        }
      };
      child.stdout?.on("data", relay);
      child.stderr?.on("data", relay);
      // Ctrl+C on the parent must not orphan a driver: each child reaps its own
      // Maestro group on SIGTERM (`installSignalReap`), so forward and wait.
      const forward = (): void => {
        child.kill("SIGTERM");
      };
      process.on("SIGINT", forward);
      process.on("SIGTERM", forward);
      try {
        return await new Promise<number | null>((resolve) => {
          child.on("close", (status) => resolve(status));
        });
      } finally {
        process.off("SIGINT", forward);
        process.off("SIGTERM", forward);
        await writeFile(join(parentDir, `${shard.label}.log`), `${lines.join("\n")}\n`);
      }
    }),
  );
}

/**
 * One shard's results, read from the summary its child wrote. `undefined` when
 * that child never got that far (crashed, exited 2, was killed): the merge then
 * makes every flow it was given a RED row pointing at its dir.
 */
function shardResults(
  shard: Shard,
  spawning: readonly Shard[],
  codes: readonly (number | null)[],
  parentDir: string,
): readonly FlowResult[] | undefined {
  if (shard.flows.length === 0) {
    return [];
  }
  const at = spawning.findIndex((plan) => plan.label === shard.label);
  if (at === -1 || codes[at] === undefined) {
    return undefined;
  }
  return readSummaryFile(join(parentDir, shard.label, "summary.json"));
}

function readSummaryFile(path: string): readonly FlowResult[] | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FlowResult[];
  } catch {
    return undefined;
  }
}

/**
 * The duration history: every FINISHED run's `summary.json`, one level under the
 * runs dir. That is single runs and parallel PARENTS (whose merged summary sits
 * at the top of their dir) and never a parallel child's, which lives one level
 * deeper — so no flow is ever counted twice. A missing or unreadable file is
 * skipped: history only balances the split, it never decides a verdict.
 */
export async function readHistory(runsDir: string): Promise<readonly PastRun[]> {
  if (!existsSync(runsDir)) {
    return [];
  }
  const past: PastRun[] = [];
  for (const name of await readdir(runsDir)) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const results = await readSummaryFile(join(runsDir, name, "summary.json"));
    if (results !== undefined) {
      past.push({ runId: Number(name), results });
    }
  }
  return past;
}
