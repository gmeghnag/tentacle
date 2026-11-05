/**
 * `attach`'s version preflight (docs/feat/version-mismatch-notice.md). Pure.
 * The container may already have a `tentacle` (a previous attach, or the
 * image ships one); it is reused only when it is exactly what this laptop
 * would inject, else replaced — so the daemon speaks this client's protocol.
 */
import { untrustedText } from "./untrusted-text.ts";
import { BUILD_ID_RE, MARKER_VERSION_RE } from "./version.ts";

/** The version in a `tentacle --version` line (`tentacle <version>`), else `undefined`. */
export function parseVersionLine(stdout: string): string | undefined {
  // The first line only: `--version --build-id` adds the build id on a second.
  const match = /^tentacle (\S+)$/.exec((stdout.trim().split("\n")[0] ?? "").trim());
  const version = match?.[1];
  return version !== undefined && MARKER_VERSION_RE.test(version) ? version : undefined;
}

export interface ExpectedVersionOptions {
  /** This tentacle's version (`"dev"` from source). */
  readonly appVersion: string;
  /** `TENTACLE_POD_BIN`, when set: the binary `resolvePodBinary` injects first. */
  readonly podBinOverride?: string;
  /** A binary's version marker, read without executing it (`readBinaryVersion`). */
  readonly readMarker: (path: string) => Promise<string | undefined>;
}

/**
 * The version this laptop would inject, or `undefined` when it cannot say
 * without resolving (or building) the binary — then the container's is reused.
 * Mirrors `resolvePodBinary`'s order: the override first, then a release
 * build injects only its own version; from source there is no fixed answer.
 */
export async function expectedContainerVersion(
  options: ExpectedVersionOptions,
): Promise<string | undefined> {
  if (options.podBinOverride) {
    try {
      return await options.readMarker(options.podBinOverride);
    } catch {
      return undefined; // unreadable: the injection itself reports it, if one runs
    }
  }
  return options.appVersion === "dev" ? undefined : options.appVersion;
}

export type ContainerDecision =
  | { readonly kind: "reuse" }
  | { readonly kind: "inject" }
  /**
   * It answers, but not with `expected`; `had` is its version when readable.
   * `reason`: its version differs, or the version agrees and its BUILD does not
   * (an older build of the same version, or one with no build id at all).
   */
  | {
      readonly kind: "replace";
      readonly had: string | undefined;
      readonly reason: "version" | "build";
    };

/**
 * The build id in a `<bin> --version --build-id` answer: exit 0 and EXACTLY two
 * lines, `tentacle <version>` then one `[0-9a-f]{12}`. An older binary ignores
 * the extra argument (`--version` exits first) and prints ONE line → none. One
 * exec carries both, so an attach pays no extra round trip.
 */
export function parseBuildFromVersionProbe(
  run: { readonly exitCode: number | null; readonly stdout: string } | null,
): string | undefined {
  if (run?.exitCode !== 0) {
    return undefined;
  }
  const lines = run.stdout.trim().split("\n");
  const id = lines[1]?.trim();
  return lines.length === 2 && id !== undefined && BUILD_ID_RE.test(id) ? id : undefined;
}

/**
 * The build id of the binary this laptop would INJECT (read laptop-side from
 * the file, like its version — never this process's own build: the config-dir
 * binary may be another build of the same version), or `undefined` for "no
 * build rule": `TENTACLE_POD_BIN` → that file; a source (`dev`) laptop → none
 * (Q3: the container's tentacle is reused; set `TENTACLE_POD_BIN`); a release →
 * the config-dir binaries' build when all of the existing ones carry the same
 * id (the pod's arch is not known yet); none when ANY existing one has no
 * readable id, or when they disagree.
 */
export async function expectedContainerBuild(options: {
  readonly appVersion: string;
  readonly podBinOverride?: string;
  /** The release's EXISTING `<configDir>/bin/tentacle-<target>` paths; one without a build id turns the rule off. */
  readonly binaries: readonly string[];
  readonly readBuild: (path: string) => Promise<string | undefined>;
}): Promise<string | undefined> {
  if (options.podBinOverride) {
    return options.readBuild(options.podBinOverride).catch(() => undefined);
  }
  if (options.appVersion === "dev") {
    return undefined;
  }
  const ids = new Set<string>();
  for (const path of options.binaries) {
    const id = await options.readBuild(path).catch(() => undefined);
    if (id === undefined) {
      // An existing binary that would be injected carries no id (built before
      // build ids): every attach would find the injected one "different". Off.
      return undefined;
    }
    ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

/**
 * The refusal when an older-build tentacle still has a live daemon (a detached
 * run, a resident): never killed, so the way out is `rm` and run again.
 */
export function staleBuildBusyLine(name: string): string {
  return `${untrustedText(name)} runs an older tentacle build than this one · tentacle rm ${untrustedText(name)}, then run again`;
}

/**
 * The warning when a replace failed and `attach` goes on with the container's
 * own tentacle: what is there, what we wanted, why it failed, the way out.
 * `localBinary`: this laptop's pod binary was not ready (not the container).
 */
export function replaceFailedWarning(options: {
  readonly had: string | undefined;
  readonly expected: string | undefined;
  readonly cause: string;
  readonly localBinary: boolean;
  /** The container's version after the failure (re-probed): the rename may have landed. Default `had`. */
  readonly now?: string | undefined;
}): string {
  const had = options.had ?? "of an unknown version";
  const now = options.now ?? had;
  const fix = options.localBinary
    ? 'run "tentacle update" on this laptop, then "tentacle attach" again'
    : `re-run "tentacle attach" with --bin-dir <a writable directory, e.g. /tmp>, or install tentacle ${options.expected} in the container image`;
  return `⚠ the container has tentacle ${had}, this laptop ${options.expected}; replacing it failed: ${untrustedText(options.cause)} — continuing with the container's tentacle ${now} (a protocol mismatch is still refused). To replace it: ${fix}`;
}

/**
 * What a done replace says. `installedAt`: the old binary is on PATH and ours
 * went to the install path, so the two differ from now on — named, never silent.
 */
export function replacedNotice(options: {
  readonly had: string | undefined;
  readonly expected: string | undefined;
  readonly installedAt?: string;
  /** `"build"`: the version agreed, the build did not — said, or the line reads "replaced X with X". */
  readonly reason?: "version" | "build";
}): string {
  const had =
    options.reason === "build"
      ? `${options.had ?? "of an unknown version"} (an older build)`
      : (options.had ?? "of an unknown version");
  return options.installedAt
    ? `the container's tentacle ${had} on PATH stays; installed ${options.expected} (this laptop's) at ${options.installedAt}, which this session runs`
    : `the container had tentacle ${had}; replaced with ${options.expected} (this laptop's)`;
}

/**
 * Exact string equality, not semver: the laptop injects only its own exact
 * build, so "differs" — older or newer — means "not what I would run".
 */
export function containerDecision(
  probe: { readonly exitCode: number | null; readonly stdout: string },
  expected: string | undefined,
  /** The build rule; absent / `expected` undefined → versions only (Q3). */
  build?: { readonly expected: string | undefined; readonly found: string | undefined },
): ContainerDecision {
  if (probe.exitCode !== 0) {
    return { kind: "inject" };
  }
  const found = parseVersionLine(probe.stdout);
  if (expected !== undefined && found !== expected) {
    return { kind: "replace", had: found, reason: "version" };
  }
  // The version agrees (or is not judged): the build must too. A MISSING build
  // id is every binary built before build ids — it can be older than the
  // protocol while still reporting the same version.
  if (build?.expected !== undefined && build.found !== build.expected) {
    return { kind: "replace", had: found, reason: "build" };
  }
  return { kind: "reuse" };
}
