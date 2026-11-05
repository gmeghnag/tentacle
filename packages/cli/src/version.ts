/**
 * The app version and its binary marker (docs/feat/pod-binary-download.md, D2).
 *
 * A compiled binary carries `TENTACLE_VERSION_MARKER:<version>:END` as a string
 * literal (a `define` in `buildBinary`), so another tentacle can read the
 * version of a binary it cannot execute (a Linux pod binary on a macOS laptop)
 * by scanning its bytes (`version-marker.ts`). `APP_VERSION` is derived FROM the
 * marker, so the literal is load-bearing (never tree-shaken) and `--version`
 * and the marker can never disagree. From source there is no define: "dev".
 */

/** The marker's fixed prefix. The full marker is `<prefix><version>:END`. */
export const MARKER_PREFIX = "TENTACLE_VERSION_MARKER:";
/** The marker's fixed suffix. */
export const MARKER_SUFFIX = ":END";
/** A version is semver-ish: `[0-9A-Za-z.+-]`, 1–64 characters. */
export const MARKER_VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;

/** The marker literal for `version` (what `buildBinary` compiles in). */
export function formatVersionMarker(version: string): string {
  if (!MARKER_VERSION_RE.test(version)) {
    throw new Error(`invalid version for the binary marker: ${JSON.stringify(version)}`);
  }
  return `${MARKER_PREFIX}${version}${MARKER_SUFFIX}`;
}

/** The version in a well-formed marker string, else `undefined`. */
export function parseVersionMarker(marker: string | undefined): string | undefined {
  if (!marker?.startsWith(MARKER_PREFIX) || !marker.endsWith(MARKER_SUFFIX)) {
    return undefined;
  }
  const version = marker.slice(MARKER_PREFIX.length, marker.length - MARKER_SUFFIX.length);
  return MARKER_VERSION_RE.test(version) ? version : undefined;
}

/**
 * The marker literal, replaced at compile time by `buildBinary`'s `define`.
 * A dedicated identifier, NOT `process.env.*`: from source it is simply
 * undeclared (the `typeof` guard), so no environment variable can fake a
 * release version (review nit N2, docs/feat/tentacle-update.md).
 */
declare const __TENTACLE_VERSION_MARKER__: string | undefined;

/** The compiled-in marker, or `undefined` from source. */
export function compiledVersionMarker(): string | undefined {
  return typeof __TENTACLE_VERSION_MARKER__ === "string" ? __TENTACLE_VERSION_MARKER__ : undefined;
}

/**
 * The app version: parsed from the marker literal injected at compile time
 * (`define` in `buildBinary`), or `"dev"` when running from source.
 */
export const APP_VERSION: string = parseVersionMarker(compiledVersionMarker()) ?? "dev";

/**
 * The BUILD id (docs/fix/stale-pod-binary.md): beside the version, a second
 * compiled-in literal `TENTACLE_BUILD_MARKER:<id>:END` naming the exact source
 * a binary was built from (`computeBuildId`: 12 hex of a content hash). Two
 * builds of one version differ, so `attach` can tell a container's tentacle is
 * not this laptop's even when `--version` agrees. A separate marker, not a
 * suffix of the version: `update` compares versions exactly against the release.
 */
export const BUILD_MARKER_PREFIX = "TENTACLE_BUILD_MARKER:";
/** A build id: 12 lowercase hex characters. */
export const BUILD_ID_RE = /^[0-9a-f]{12}$/;

/** The build marker literal for `id` (what `buildBinary` compiles in). */
export function formatBuildMarker(id: string): string {
  if (!BUILD_ID_RE.test(id)) {
    throw new Error(`invalid build id for the binary marker: ${JSON.stringify(id)}`);
  }
  return `${BUILD_MARKER_PREFIX}${id}${MARKER_SUFFIX}`;
}

/** The build id in a well-formed build marker string, else `undefined`. */
export function parseBuildMarker(marker: string | undefined): string | undefined {
  if (!marker?.startsWith(BUILD_MARKER_PREFIX) || !marker.endsWith(MARKER_SUFFIX)) {
    return undefined;
  }
  const id = marker.slice(BUILD_MARKER_PREFIX.length, marker.length - MARKER_SUFFIX.length);
  return BUILD_ID_RE.test(id) ? id : undefined;
}

/** Replaced at compile time by `buildBinary`'s `define`; undeclared from source. */
declare const __TENTACLE_BUILD_MARKER__: string | undefined;

/** This binary's build id, or `undefined` from source. */
export const APP_BUILD: string | undefined = parseBuildMarker(
  typeof __TENTACLE_BUILD_MARKER__ === "string" ? __TENTACLE_BUILD_MARKER__ : undefined,
);

/** Who this CLI is in `initialize` (a daemon words a version skew with it). */
export const CLIENT_INFO = { name: "tentacle", version: APP_VERSION } as const;
