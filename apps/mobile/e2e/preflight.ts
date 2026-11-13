/**
 * The `bun run e2e:mobile` preflight (docs/feat/mobile-app-shell.md): parse what
 * `xcrun simctl`, Xcode, CocoaPods and Maestro report and say exactly what is
 * missing, with the command that installs it. A missing piece is a FAILURE
 * (exit 2), never a silent skip — the harness is the gate every mobile task
 * merges through, so "quietly ran nothing" must be impossible.
 *
 * Pure: the tools' output is injected (`Probe`), so every branch is testable
 * without a Mac, a simulator or Maestro.
 */

export interface SimRuntime {
  readonly identifier: string;
  readonly name: string;
  /** `"18.6"` — the runtime's version, not the device's. */
  readonly version: string;
  readonly available: boolean;
}

/** One missing prerequisite: what it is and how to get it. */
export interface Missing {
  readonly tool: string;
  readonly install: string;
}

export interface PreflightInput {
  readonly platform: NodeJS.Platform;
  /** `xcrun simctl list -j runtimes` (parsed here), absent when simctl failed. */
  readonly runtimes?: readonly SimRuntime[];
  /** `xcodebuild -version` output, absent when Xcode is missing. */
  readonly xcode?: string;
  readonly cocoapods?: string;
  readonly maestro?: string;
}

/** The iOS major versions this harness runs on (Owner Q3; 18 is deferred today). */
export const REQUIRED_IOS_MAJORS = [18, 26] as const;

export type IosMajor = (typeof REQUIRED_IOS_MAJORS)[number];

/**
 * Parse `xcrun simctl list -j runtimes`'s JSON. An unreadable blob yields `[]`
 * (the caller reports "no simulator runtime" rather than crashing), and only
 * AVAILABLE runtimes count.
 */
export function parseRuntimes(json: string): readonly SimRuntime[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const runtimes = (parsed as { runtimes?: unknown }).runtimes;
  if (!Array.isArray(runtimes)) {
    return [];
  }
  const out: SimRuntime[] = [];
  for (const raw of runtimes) {
    const entry = raw as {
      identifier?: unknown;
      name?: unknown;
      version?: unknown;
      isAvailable?: unknown;
    };
    if (typeof entry.identifier !== "string" || typeof entry.version !== "string") {
      continue;
    }
    out.push({
      identifier: entry.identifier,
      name: typeof entry.name === "string" ? entry.name : entry.identifier,
      version: entry.version,
      available: entry.isAvailable !== false,
    });
  }
  return out;
}

/** The iOS major a runtime serves (`"com.apple.CoreSimulator.SimRuntime.iOS-26-5"` → 26). */
export function iosMajor(runtime: SimRuntime): IosMajor | undefined {
  const match = /iOS-(\d+)/.exec(runtime.identifier);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const major = Number(match[1]);
  return (REQUIRED_IOS_MAJORS as readonly number[]).includes(major)
    ? (major as IosMajor)
    : undefined;
}

/** The iOS majors this machine can actually run, from its available runtimes. */
export function availableIosMajors(runtimes: readonly SimRuntime[]): readonly IosMajor[] {
  const found = new Set<IosMajor>();
  for (const runtime of runtimes) {
    if (!runtime.available) {
      continue;
    }
    const major = iosMajor(runtime);
    if (major !== undefined) {
      found.add(major);
    }
  }
  return REQUIRED_IOS_MAJORS.filter((major) => found.has(major));
}

/**
 * Everything wrong with this machine, most fundamental first. Empty = run.
 * `--ios <major>` narrows the runtime requirement to just that one.
 */
export function preflight(input: PreflightInput, only?: IosMajor): readonly Missing[] {
  const missing: Missing[] = [];
  if (input.platform !== "darwin") {
    missing.push({
      tool: `macOS (this is ${input.platform})`,
      install: "the iOS simulator needs macOS: run `bun run e2e:mobile` on a Mac",
    });
  }
  if (input.xcode === undefined) {
    missing.push({
      tool: "Xcode",
      install:
        "install Xcode from the App Store, then `sudo xcode-select -s /Applications/Xcode.app`",
    });
  }
  if (input.cocoapods === undefined) {
    missing.push({ tool: "CocoaPods", install: "`brew install cocoapods`" });
  }
  if (input.maestro === undefined) {
    missing.push({
      tool: "Maestro",
      install:
        '`brew install mobile-dev-inc/tap/maestro`, then run with Java 17: `JAVA_HOME=$(brew --prefix openjdk@17) PATH="$(brew --prefix openjdk@17)/bin:$PATH"`',
    });
  }
  const have = availableIosMajors(input.runtimes ?? []);
  for (const major of REQUIRED_IOS_MAJORS) {
    if (only !== undefined && major !== only) {
      continue;
    }
    if (have.includes(major)) {
      continue;
    }
    missing.push({
      tool: `the iOS ${major}.x simulator runtime`,
      install: `\`xcodebuild -downloadPlatform iOS -buildVersion ${major}.x\` (or Xcode ▸ Settings ▸ Components)`,
    });
  }
  return missing;
}

/** The report a failed preflight prints (never a bare exit code). */
export function missingText(missing: readonly Missing[]): string {
  const lines = ["e2e:mobile cannot run on this machine:"];
  for (const item of missing) {
    lines.push(`  • ${item.tool} is missing — ${item.install}`);
  }
  return lines.join("\n");
}

/** Parse `-j` runtimes JSON straight from a command's stdout (the impure edge). */
export function runtimesFromJson(stdout: string): readonly SimRuntime[] {
  return parseRuntimes(stdout);
}
