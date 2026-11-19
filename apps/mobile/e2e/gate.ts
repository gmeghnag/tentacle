/**
 * The e2e GATE's decisions (docs/feat/mobile-e2e-gate.md), pure and React-free
 * (AGENTS §7): which tags a flow carries, whether a failed attempt is retried,
 * how one run's results become a verdict, and the one summary table. `run.ts`
 * spawns Maestro and feeds the results in; nothing here touches a process.
 *
 * A flow's gate tags live in ITS OWN header (Maestro's native `tags:` list,
 * before the `---`), each with a `# <tag>: <reason>` comment line next to it —
 * so the reason travels with the flow and a tag without one is refused
 * (`flowMetaErrors`, pinned by `test/e2e-gate.test.ts`):
 *
 * - `flaky`      — fails sometimes for a reason outside the app (a simulator
 *                  race); retried ONCE, and listed in the summary.
 * - `known-bug`  — fails because of a real APP bug a fix task owns; it runs,
 *                  but its result does not count toward the verdict. Listed.
 *                  A `known-bug` that PASSES is reported, so its fix task can
 *                  drop the tag.
 * - `quarantine` — not run at all, because the FLOW cannot work today (a
 *                  harness/flow defect); listed with its reason. Each has a
 *                  `TODO.md` line.
 */

import { type IosMajor, REQUIRED_IOS_MAJORS } from "./preflight.ts";

export const GATE_TAGS = ["flaky", "known-bug", "quarantine"] as const;
export type GateTag = (typeof GATE_TAGS)[number];

export interface FlowMeta {
  readonly name: string;
  readonly tags: readonly GateTag[];
  /** The `# <tag>: <reason>` line for each tag (absent: missing, an error). */
  readonly reasons: Readonly<Partial<Record<GateTag, string>>>;
  /** Tags in the header this gate does not know (Maestro's own are allowed). */
  readonly otherTags: readonly string[];
}

/** The header of a flow: everything before its first `---` line ("" when none). */
function headerOf(yaml: string): string {
  const lines = yaml.split("\n");
  const end = lines.findIndex((line) => line.trim() === "---");
  return end === -1 ? "" : lines.slice(0, end).join("\n");
}

function isGateTag(tag: string): tag is GateTag {
  return (GATE_TAGS as readonly string[]).includes(tag);
}

/** Read a flow's gate tags and their reasons from its header. */
export function parseFlowMeta(name: string, yaml: string): FlowMeta {
  const header = headerOf(yaml).split("\n");
  const tags: GateTag[] = [];
  const otherTags: string[] = [];
  const reasons: Partial<Record<GateTag, string>> = {};
  let inTags = false;
  for (const raw of header) {
    const line = raw.trimEnd();
    const reason = /^#\s*(flaky|known-bug|quarantine):\s*(.+)$/.exec(line.trim());
    if (reason?.[1] !== undefined && reason[2] !== undefined && isGateTag(reason[1])) {
      reasons[reason[1]] = reason[2].trim();
      continue;
    }
    if (/^tags:\s*$/.test(line)) {
      inTags = true;
      continue;
    }
    // An inline list: `tags: [flaky, known-bug]`.
    const inline = /^tags:\s*\[(.*)\]\s*$/.exec(line);
    if (inline?.[1] !== undefined) {
      for (const tag of inline[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, ""))) {
        if (tag !== "") {
          (isGateTag(tag) ? tags : otherTags).push(tag as GateTag);
        }
      }
      continue;
    }
    if (inTags) {
      const item = /^\s+-\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(line);
      if (item?.[1] !== undefined) {
        (isGateTag(item[1]) ? tags : otherTags).push(item[1] as GateTag);
        continue;
      }
      if (line.trim() === "" || line.trim().startsWith("#")) {
        continue;
      }
      inTags = false;
    }
  }
  return { name, tags, reasons, otherTags };
}

/** What is wrong with a flow's gate metadata: a tag with no reason, two exclusive tags. */
export function flowMetaErrors(meta: FlowMeta): string[] {
  const errors: string[] = [];
  for (const tag of meta.tags) {
    if (meta.reasons[tag] === undefined) {
      errors.push(`${meta.name}: tag \`${tag}\` has no \`# ${tag}: <reason>\` line`);
    }
  }
  for (const tag of Object.keys(meta.reasons) as GateTag[]) {
    if (!meta.tags.includes(tag)) {
      errors.push(`${meta.name}: a \`# ${tag}:\` reason but no \`${tag}\` tag`);
    }
  }
  if (meta.tags.includes("quarantine") && meta.tags.length > 1) {
    errors.push(`${meta.name}: \`quarantine\` is not run, so no other tag can apply`);
  }
  return errors;
}

/**
 * What a run's `--udid` / `--ios` pair means (docs/feat/mobile-e2e-gate.md,
 * Review round 1 finding 2). A UDID names ONE simulator, so it names its major
 * too — and it is honoured the same way whether `--ios` was given or not: the
 * run drives that simulator or nothing. `--ios N --udid X` where X is not an
 * available iOS N device is an error (exit 2), never "drive X and call it N".
 */
export type DeviceChoice =
  /** No UDID: every required major (`--ios` narrows to one). */
  | { readonly kind: "majors"; readonly only: IosMajor | undefined }
  /** A UDID, validated as an available device of a required major. */
  | { readonly kind: "device"; readonly udid: string; readonly major: IosMajor }
  /** Unusable: the message to print, exit 2. */
  | { readonly kind: "unknown"; readonly message: string };

export function deviceChoice(
  devicesJson: string,
  udid: string | undefined,
  only: IosMajor | undefined,
): DeviceChoice {
  if (udid === undefined) {
    return { kind: "majors", only };
  }
  const major = majorOfDevice(devicesJson, udid);
  if (major === undefined || !REQUIRED_IOS_MAJORS.includes(major as IosMajor)) {
    return {
      kind: "unknown",
      message: `e2e:mobile: simulator ${udid} is not an available iOS ${REQUIRED_IOS_MAJORS.join("/")} device (simctl list devices)`,
    };
  }
  // `--ios N` must AGREE with the simulator, not stand in for it: a run given
  // one device drives it as the major it actually is, or refuses.
  if (only !== undefined && only !== major) {
    return {
      kind: "unknown",
      message: `e2e:mobile: simulator ${udid} is an iOS ${major} device, not the iOS ${only} this run was told (--ios)`,
    };
  }
  return { kind: "device", udid, major: major as IosMajor };
}

export type AttemptStatus = "pass" | "fail" | "timeout";

/** A flaky flow gets ONE more attempt after a red one; nothing else is retried. */
export function shouldRetry(meta: FlowMeta, attempts: readonly AttemptStatus[]): boolean {
  return (
    meta.tags.includes("flaky") &&
    attempts.length === 1 &&
    attempts[0] !== undefined &&
    attempts[0] !== "pass"
  );
}

export type FlowStatus = AttemptStatus | "quarantined";

export interface FlowResult {
  readonly name: string;
  readonly status: FlowStatus;
  /** Wall time of all its attempts, seconds. */
  readonly seconds: number;
  /** 0 for a quarantined flow. */
  readonly attempts: number;
  readonly tags: readonly GateTag[];
  /** The flow's own output dir (screenshots + Maestro log), when it ran. */
  readonly outDir?: string;
}

/** The final status of a flow from its attempts: the LAST attempt decides. */
export function finalStatus(attempts: readonly AttemptStatus[]): AttemptStatus {
  return attempts[attempts.length - 1] ?? "fail";
}

export interface Verdict {
  /** Red flows that count: the gate fails on any. */
  readonly failed: readonly FlowResult[];
  readonly passed: readonly FlowResult[];
  /** `known-bug` flows still red (expected; not counted). */
  readonly knownBugs: readonly FlowResult[];
  /** `known-bug` flows that PASSED: the fix landed, drop the tag. */
  readonly knownBugsFixed: readonly FlowResult[];
  readonly quarantined: readonly FlowResult[];
  /** `flaky` flows that needed their retry to pass. */
  readonly retried: readonly FlowResult[];
  /** 0 = gate green, 1 = at least one counted flow is red. */
  readonly exitCode: 0 | 1;
}

export function verdictOf(results: readonly FlowResult[]): Verdict {
  const failed: FlowResult[] = [];
  const passed: FlowResult[] = [];
  const knownBugs: FlowResult[] = [];
  const knownBugsFixed: FlowResult[] = [];
  const quarantined: FlowResult[] = [];
  const retried: FlowResult[] = [];
  for (const result of results) {
    if (result.status === "quarantined") {
      quarantined.push(result);
      continue;
    }
    const red = result.status !== "pass";
    if (result.tags.includes("known-bug")) {
      (red ? knownBugs : knownBugsFixed).push(result);
      continue;
    }
    (red ? failed : passed).push(result);
    if (!red && result.attempts > 1) {
      retried.push(result);
    }
  }
  return {
    failed,
    passed,
    knownBugs,
    knownBugsFixed,
    quarantined,
    retried,
    exitCode: failed.length === 0 ? 0 : 1,
  };
}

function statusCell(result: FlowResult): string {
  switch (result.status) {
    case "pass":
      return result.tags.includes("known-bug") ? "PASS (known-bug)" : "PASS";
    case "fail":
      return result.tags.includes("known-bug") ? "FAIL (known-bug)" : "FAIL";
    case "timeout":
      return result.tags.includes("known-bug") ? "TIMEOUT (known-bug)" : "TIMEOUT";
    case "quarantined":
      return "QUARANTINED";
  }
}

/**
 * The one summary: a table (flow · status · seconds · attempts), then the
 * counts, then every list a reader acts on — the red flows with their output
 * dir, the known bugs, the quarantined flows with their reasons, the flaky
 * ones that needed a retry. `metas` supplies the reasons.
 */
export function summaryText(
  results: readonly FlowResult[],
  metas: ReadonlyMap<string, FlowMeta>,
): string {
  const verdict = verdictOf(results);
  const rows = results.map((r) => [
    r.name,
    statusCell(r),
    r.status === "quarantined" ? "-" : r.seconds.toFixed(0),
    r.status === "quarantined" ? "-" : String(r.attempts),
  ]);
  const head = ["flow", "result", "seconds", "tries"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const out: string[] = [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
  const ran = results.filter((r) => r.status !== "quarantined");
  const total = ran.reduce((sum, r) => sum + r.seconds, 0);
  out.push(
    "",
    `${verdict.exitCode === 0 ? "GATE PASS" : "GATE FAIL"} — ${verdict.passed.length} passed, ` +
      `${verdict.failed.length} failed, ${verdict.knownBugs.length} known-bug, ` +
      `${verdict.quarantined.length} quarantined (of ${results.length}; ${Math.round(total)} s)`,
  );
  const reason = (r: FlowResult, tag: GateTag) => metas.get(r.name)?.reasons[tag] ?? "(no reason)";
  if (verdict.failed.length > 0) {
    out.push("", "Failed (screenshots + maestro.log):");
    for (const r of verdict.failed) {
      out.push(`  ${r.name} — ${r.outDir ?? "(no output dir)"}`);
    }
  }
  if (verdict.knownBugs.length > 0) {
    out.push("", "Known bugs (not counted):");
    for (const r of verdict.knownBugs) {
      out.push(`  ${r.name} — ${reason(r, "known-bug")}`);
    }
  }
  if (verdict.knownBugsFixed.length > 0) {
    out.push("", "Known bugs that now PASS (drop the `known-bug` tag):");
    for (const r of verdict.knownBugsFixed) {
      out.push(`  ${r.name}`);
    }
  }
  if (verdict.quarantined.length > 0) {
    out.push("", "Quarantined (not run):");
    for (const r of verdict.quarantined) {
      out.push(`  ${r.name} — ${reason(r, "quarantine")}`);
    }
  }
  const flaky = results.filter((r) => r.tags.includes("flaky"));
  if (flaky.length > 0) {
    out.push("", "Flaky (one retry allowed):");
    for (const r of flaky) {
      const note = verdict.retried.includes(r) ? " — passed on retry" : "";
      out.push(`  ${r.name}${note} — ${reason(r, "flaky")}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/**
 * The iOS major of a simulator, from `simctl list -j devices` (its runtime key
 * `…SimRuntime.iOS-26-5`). The gate is given a UDID, not a major: this is how it
 * knows which one it is running. Undefined: no such (available) device.
 */
export function majorOfDevice(json: string, udid: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const devices = (parsed as { devices?: Record<string, unknown> }).devices;
  if (devices === undefined) {
    return undefined;
  }
  for (const [runtime, list] of Object.entries(devices)) {
    if (!Array.isArray(list)) {
      continue;
    }
    const found = list.some(
      (raw) =>
        (raw as { udid?: unknown }).udid === udid &&
        (raw as { isAvailable?: unknown }).isAvailable !== false,
    );
    const major = /iOS-(\d+)-/.exec(runtime)?.[1];
    if (found && major !== undefined) {
      return Number(major);
    }
  }
  return undefined;
}
