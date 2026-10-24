/**
 * `attach`'s version preflight (docs/feat/version-mismatch-notice.md). Pure.
 * The container may already have a `tentacle` (a previous attach, or the
 * image ships one); it is reused only when it is exactly what this laptop
 * would inject, else replaced — so the daemon speaks this client's protocol.
 */
import { untrustedText } from "./untrusted-text.ts";
import { MARKER_VERSION_RE } from "./version.ts";

/** The version in a `tentacle --version` line (`tentacle <version>`), else `undefined`. */
export function parseVersionLine(stdout: string): string | undefined {
  const match = /^tentacle (\S+)$/.exec(stdout.trim());
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
  /** It answers, but not with `expected`; `had` is its version when readable. */
  | { readonly kind: "replace"; readonly had: string | undefined };

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
 * Exact string equality, not semver: the laptop injects only its own exact
 * build, so "differs" — older or newer — means "not what I would run".
 */
export function containerDecision(
  probe: { readonly exitCode: number | null; readonly stdout: string },
  expected: string | undefined,
): ContainerDecision {
  if (probe.exitCode !== 0) {
    return { kind: "inject" };
  }
  const found = parseVersionLine(probe.stdout);
  if (expected === undefined || found === expected) {
    return { kind: "reuse" };
  }
  return { kind: "replace", had: found };
}
