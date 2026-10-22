/**
 * The pure decisions behind `tentacle update` (docs/feat/tentacle-update.md):
 * version order, tag parsing, the laptop asset name, and what to replace.
 * No I/O, so every branch is unit-tested here; `update.ts` only executes it.
 */
import type { PodBinaryTarget } from "./pod-binary.ts";
import { MARKER_VERSION_RE } from "./version.ts";

/**
 * The oldest version `update` installs: earlier builds carry no version
 * marker, so their pod binaries could never be recognised (D2). Pre-public, no
 * compatibility with them is kept.
 */
export const MIN_UPDATE_VERSION = "0.1.0";

/** Release tags are `v<version>` (the workflow refuses any other, build.yml). */
export function normalizeTag(input: string): { tag: string; version: string } {
  const version = input.startsWith("v") ? input.slice(1) : input;
  if (!MARKER_VERSION_RE.test(version) || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`not a release version: ${JSON.stringify(input)} (expected e.g. v0.4.0)`);
  }
  return { tag: `v${version}`, version };
}

/**
 * The tag in the `Location` of `GET /releases/latest` (a 302 to
 * `…/releases/tag/<tag>`), or `undefined` if it is not that shape.
 */
export function tagFromLatestLocation(location: string | null): string | undefined {
  const match = location ? /\/releases\/tag\/([^/?#]+)$/.exec(location) : null;
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Semver precedence: `-1 | 0 | 1`. `major.minor.patch` numerically, then a
 * pre-release sorts before its release, then pre-release identifiers
 * left to right (numeric < alphanumeric, numbers numerically). Build metadata
 * (`+…`) is ignored.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre] = (v.split("+")[0] ?? "").split(/-(.*)/s);
    return { core: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) {
      return Math.sign(d);
    }
  }
  if (x.pre === undefined || y.pre === undefined) {
    return x.pre === y.pre ? 0 : x.pre === undefined ? 1 : -1;
  }
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined || q === undefined) {
      return p === undefined ? -1 : 1;
    }
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d !== 0) {
        return Math.sign(d);
      }
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/** The release asset for THIS machine (`tentacle-bun-<os>-<arch>`), or an error. */
export function laptopAsset(platform: string, arch: string): string {
  const os = platform === "darwin" || platform === "linux" ? platform : undefined;
  const cpu = arch === "x64" || arch === "arm64" ? arch : undefined;
  if (!os || !cpu) {
    throw new Error(`no tentacle release for ${platform}/${arch} (darwin|linux × x64|arm64)`);
  }
  return `tentacle-bun-${os}-${cpu}`;
}

export interface PlanInput {
  /** This CLI's version (never "dev": refused before planning). */
  readonly current: string;
  /** The resolved target version (no `v`). */
  readonly target: string;
  /** `--version` was given: move to `target` even if it is older. */
  readonly explicit: boolean;
  /** Each pod binary's marker version; `undefined` = missing or no marker. */
  readonly pods: Readonly<Record<PodBinaryTarget, string | undefined>>;
}

export interface UpdatePlan {
  /** The version to install the CLI at, or `null` to leave it alone. */
  readonly self: string | null;
  /** The version the pod binaries must be at: the version the CLI ends at (D1). */
  readonly podVersion: string;
  /** Pod binaries to (re)install: missing, unknown, or ≠ `podVersion` (never when `ahead`). */
  readonly podTargets: readonly PodBinaryTarget[];
  /**
   * `current`: nothing to do · `update`: the CLI moves (or only pods are filled
   * in, see `podTargets`) · `ahead`: this CLI is newer than the latest release
   * (no `--version`), so it stays, and its pods are NOT fetched: its own
   * version may be unreleased (`--version v<current>` fetches them if it is).
   */
  readonly status: "current" | "update" | "ahead";
}

/**
 * What `update` replaces. The CLI moves only on an explicit `--version` that
 * differs, or when latest > current (never an implicit downgrade). The pods
 * always end at the CLI's final version, whatever the CLI does (D1), so a
 * current CLI still gets missing/stale/unknown pod binaries filled in.
 */
export function planUpdate(input: PlanInput): UpdatePlan {
  const order = compareVersions(input.target, input.current);
  if (!input.explicit && order < 0) {
    return { self: null, podVersion: input.current, podTargets: [], status: "ahead" };
  }
  const moves = input.explicit ? input.target !== input.current : order > 0;
  const self = moves ? input.target : null;
  const podVersion = self ?? input.current;
  const podTargets = (Object.keys(input.pods) as PodBinaryTarget[]).filter(
    (t) => input.pods[t] !== podVersion,
  );
  const status = self !== null || podTargets.length > 0 ? "update" : "current";
  return { self, podVersion, podTargets, status };
}
