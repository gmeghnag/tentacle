/**
 * `tentacle update [--check] [--version vX.Y.Z]` (docs/feat/tentacle-update.md):
 * self-update the CLI and its two Linux pod binaries from the GitHub release.
 *
 * Stage everything, then commit: every file is downloaded to a temp next to its
 * destination and verified (SHA-256, D3) and the new CLI must answer
 * `--version` with the target; only then are the pod binaries renamed in, and
 * the CLI LAST. Anything that fails before the commit leaves the old install
 * untouched and removes every temp. The decisions live in `update-plan.ts`.
 */
import { constants, existsSync } from "node:fs";
import { access, chown as fsChown, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { POD_BINARY_TARGETS, configBinPath } from "./pod-binary-build.ts";
import {
  type FetchLike,
  HttpStatusError,
  RELEASE_REPO,
  commitDownload,
  downloadVerifiedAsset,
  fetchSha256Sums,
} from "./pod-binary-download.ts";
import type { PodBinaryTarget } from "./pod-binary.ts";
import {
  MIN_UPDATE_VERSION,
  compareVersions,
  laptopAsset,
  normalizeTag,
  planUpdate,
  tagFromLatestLocation,
} from "./update-plan.ts";
import { readBinaryVersion } from "./version-marker.ts";

/** `update --check` exit code when `update` would change something. */
export const EXIT_UPDATE_AVAILABLE = 10;

export interface UpdateOptions {
  /** Only report; change nothing. */
  readonly check: boolean;
  /** `--version`: this exact release (may be a downgrade). */
  readonly version?: string;
}

export interface UpdateDeps {
  /** This CLI's version (`APP_VERSION`); `"dev"` is refused. */
  readonly appVersion: string;
  /** The running executable (`process.execPath`), the file the CLI update replaces. */
  readonly execPath: string;
  /** `<configDir>`: the pod binaries go in `<configDir>/bin/`. */
  readonly configDir: string;
  readonly platform: string;
  readonly arch: string;
  readonly fetch: FetchLike;
  /** `owner/name` (default `RELEASE_REPO`). */
  readonly repo?: string;
  /** Run `<path> --version` and return its stdout; throw if it fails (seam). */
  readonly runVersion: (path: string) => Promise<string>;
  /** The commit rename (seam: a test crashes it); default `commitDownload`. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** Whether `dir` is writable (seam); default `access(W_OK)`. */
  readonly isWritable?: (dir: string) => Promise<boolean>;
  /**
   * Under `sudo`: the invoking user, who gets back what this run creates in
   * `<configDir>` (a new `bin/` and the pod files), so a later update without
   * sudo can still write there. Default: `SUDO_UID`/`SUDO_GID` when running
   * as root, else none.
   */
  readonly sudoOwner?: { readonly uid: number; readonly gid: number } | null;
  /** The chown seam (tests); default `fs.chown`. */
  readonly chown?: (path: string, uid: number, gid: number) => Promise<void>;
  readonly write: (text: string) => void;
}

function defaultSudoOwner(): { uid: number; gid: number } | null {
  const uid = Number(process.env.SUDO_UID);
  const gid = Number(process.env.SUDO_GID);
  return process.getuid?.() === 0 &&
    Number.isInteger(uid) &&
    Number.isInteger(gid) &&
    process.env.SUDO_UID
    ? { uid, gid }
    : null;
}

/** A staging temp of `downloadVerifiedAsset`: `.<asset>.<12 hex>.tmp`. */
const TEMP_RE = /^\.tentacle-bun-[a-z0-9-]+\.[0-9a-f]{12}\.tmp$/;
/**
 * A temp untouched for this long belongs to a killed run. A concurrent run's
 * finished temp stops changing while it downloads the next asset, so the
 * cutoff must outlast a whole slow update, not just one write.
 */
const STALE_TEMP_MS = 60 * 60_000;

/** Remove staging temps left behind by a killed `update` (best effort). */
async function removeStaleTemps(dirs: readonly string[]): Promise<void> {
  const cutoff = Date.now() - STALE_TEMP_MS;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue; // no such dir yet
    }
    for (const name of names.filter((n) => TEMP_RE.test(n))) {
      const path = join(dir, name);
      try {
        if ((await stat(path)).mtimeMs < cutoff) {
          await rm(path, { force: true });
        }
      } catch {
        // raced with another run: fine
      }
    }
  }
}

/**
 * The default `runVersion`: spawn `<path> --version`. On timeout it is sent
 * SIGTERM, then SIGKILL after `graceMs` (a binary that ignores SIGTERM must
 * not hang the update).
 */
export async function spawnVersion(
  path: string,
  options: { readonly timeoutMs?: number; readonly graceMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const graceMs = options.graceMs ?? 2_000;
  const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    killer = setTimeout(() => proc.kill("SIGKILL"), graceMs);
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new Error(`timed out after ${timeoutMs} ms`);
    }
    if (code !== 0) {
      throw new Error(`exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
    clearTimeout(killer);
  }
}

async function defaultIsWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The latest release's tag, from the `/releases/latest` redirect (not the
 * REST API: no 60 req/h unauthenticated limit, no JSON; drafts and
 * pre-releases are never "latest").
 */
export async function resolveLatestTag(
  doFetch: FetchLike,
  repo: string = RELEASE_REPO,
): Promise<string> {
  const url = `https://github.com/${repo}/releases/latest`;
  let response: Response;
  try {
    response = await doFetch(url, { redirect: "manual" });
  } catch (error) {
    throw new Error(
      `cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await response.body?.cancel().catch(() => {});
  const tag = tagFromLatestLocation(response.headers.get("location"));
  if (response.status >= 300 && response.status < 400 && tag) {
    return tag;
  }
  // No full release: a private repo answers 404; a public one with only
  // pre-releases (or none) redirects to `…/releases`, not to a tag.
  if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
    throw new Error(
      `no published release at https://github.com/${repo}/releases (HTTP ${response.status}): the repository has no non-pre-release release yet, or it is not public. Pick a tag with --version vX.Y.Z`,
    );
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error(
      `GitHub refused ${url} (HTTP ${response.status}: rate-limited or blocked); try again later`,
    );
  }
  throw new Error(`unexpected answer from ${url}: HTTP ${response.status}`);
}

/** Explain a 404 on a release file: the tag does not exist, or the repo is not public. */
function releaseError(error: unknown, tag: string, repo: string): Error {
  if (error instanceof HttpStatusError && error.status === 404) {
    return new Error(
      `release ${tag} not found at https://github.com/${repo}/releases (${error.url}: HTTP 404): no such tag, or the repository is not public`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Run `tentacle update`; returns the process exit code. */
export async function runUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<number> {
  const write = deps.write;
  if (deps.appVersion === "dev") {
    write(
      "[update] this tentacle runs from source (version dev): it never overwrites the `bun` executable. Update the checkout instead: git pull && bun install && bun run compile\n",
    );
    return 1;
  }
  const repo = deps.repo ?? RELEASE_REPO;
  const rename = deps.rename ?? commitDownload;
  const isWritable = deps.isWritable ?? defaultIsWritable;
  const sudoOwner = deps.sudoOwner === undefined ? defaultSudoOwner() : deps.sudoOwner;
  const chown = deps.chown ?? fsChown;
  // Every temp that is not yet committed; removed in `finally` on any failure.
  const staged = new Set<string>();
  try {
    const asset = laptopAsset(deps.platform, deps.arch);
    const { tag: targetTag, version: target } = options.version
      ? normalizeTag(options.version)
      : normalizeTag(await resolveLatestTag(deps.fetch, repo));
    if (compareVersions(target, MIN_UPDATE_VERSION) < 0) {
      throw new Error(
        `versions before ${MIN_UPDATE_VERSION} cannot be installed by update (${targetTag} has no version marker)`,
      );
    }

    const binDir = join(deps.configDir, "bin");
    const installDir = dirname(deps.execPath);
    if (!options.check) {
      await removeStaleTemps([installDir, binDir]);
    }
    const pods = {} as Record<PodBinaryTarget, string | undefined>;
    for (const t of POD_BINARY_TARGETS) {
      const path = configBinPath(deps.configDir, t);
      pods[t] = existsSync(path) ? await readBinaryVersion(path) : undefined;
    }
    const plan = planUpdate({
      current: deps.appVersion,
      target,
      explicit: options.version !== undefined,
      pods,
    });

    // Report.
    const podLine = (t: PodBinaryTarget): string =>
      `  ${t}: ${pods[t] ?? (existsSync(configBinPath(deps.configDir, t)) ? "unknown version" : "missing")}${plan.podTargets.includes(t) ? ` → ${plan.podVersion}` : ""}\n`;
    if (plan.self) {
      write(`tentacle ${deps.appVersion} → ${plan.self}\n`);
    } else if (plan.status === "ahead") {
      write(`tentacle ${deps.appVersion} is newer than latest (${targetTag}); kept\n`);
    } else {
      write(`tentacle ${deps.appVersion} is up to date (${targetTag})\n`);
    }
    write(`pod binaries (${binDir}):\n${POD_BINARY_TARGETS.map(podLine).join("")}`);
    if (plan.status === "ahead" && POD_BINARY_TARGETS.some((t) => pods[t] !== deps.appVersion)) {
      // Not fetched: this version may be unreleased. Exit 0: nothing `update`
      // would do; the user decides.
      write(
        `pod binaries not at ${deps.appVersion} are left alone (it may be unreleased); if v${deps.appVersion} is a published release: tentacle update --version v${deps.appVersion}\n`,
      );
    }
    if (options.check) {
      return plan.status === "update" ? EXIT_UPDATE_AVAILABLE : 0;
    }
    if (plan.status !== "update") {
      return 0;
    }

    // Never overwrite a file that is not this very tentacle.
    if (plan.self) {
      const installed = await readBinaryVersion(deps.execPath).catch(() => undefined);
      if (installed !== deps.appVersion) {
        throw new Error(
          `${deps.execPath} is not tentacle ${deps.appVersion} (its version marker reads ${installed ?? "nothing"}); refusing to overwrite it`,
        );
      }
    }
    // D5: refuse an unwritable destination BEFORE downloading anything.
    if (plan.self && !(await isWritable(installDir))) {
      write(
        `[update error] ${installDir} is not writable, so ${deps.execPath} cannot be replaced. Re-run with the rights to write there, keeping your config dir:\n  sudo TENTACLE_CONFIG_DIR=${deps.configDir} ${deps.execPath} update${options.version ? ` --version ${targetTag}` : ""}\n`,
      );
      return 1;
    }
    // The dirs this run creates (for the sudo chown below).
    const createdDirs: string[] = [];
    if (plan.podTargets.length > 0) {
      const first = await mkdir(binDir, { recursive: true });
      if (first) {
        let dir = first;
        createdDirs.push(dir);
        for (const part of relative(first, binDir).split("/").filter(Boolean)) {
          dir = join(dir, part);
          createdDirs.push(dir);
        }
      }
      if (!(await isWritable(binDir))) {
        write(`[update error] ${binDir} is not writable; fix its permissions and re-run\n`);
        return 1;
      }
    }

    // Stage: SHA256SUMS once per tag, then each file to a verified temp.
    const sumsByTag = new Map<string, ReadonlyMap<string, string>>();
    const sumsFor = async (tag: string): Promise<ReadonlyMap<string, string>> => {
      const cached = sumsByTag.get(tag);
      if (cached) {
        return cached;
      }
      const sums = await fetchSha256Sums(tag, { fetch: deps.fetch, repo }).catch((error) => {
        throw releaseError(error, tag, repo);
      });
      sumsByTag.set(tag, sums);
      return sums;
    };
    const stage = async (tag: string, name: string, destDir: string): Promise<string> => {
      const temp = await downloadVerifiedAsset({
        tag,
        asset: name,
        destDir,
        sums: await sumsFor(tag),
        fetch: deps.fetch,
        repo,
      }).catch((error) => {
        throw releaseError(error, tag, repo);
      });
      staged.add(temp);
      return temp;
    };

    const podTag = `v${plan.podVersion}`;
    const podTemps: [string, string][] = [];
    for (const t of plan.podTargets) {
      write(`downloading ${t} (${podTag})…\n`);
      const temp = await stage(podTag, `tentacle-${t}`, binDir);
      // The marker must name exactly this release (D2): `run` would refuse
      // anything else, so an inconsistent or marker-less asset is never installed.
      const marked = await readBinaryVersion(temp);
      if (marked !== plan.podVersion) {
        throw new Error(
          marked === undefined
            ? `${podTag} ${t} carries no version marker`
            : `${podTag} ${t} carries version ${marked}, not ${plan.podVersion}`,
        );
      }
      podTemps.push([temp, configBinPath(deps.configDir, t)]);
    }
    let selfTemp: string | undefined;
    if (plan.self) {
      write(`downloading ${asset} (${targetTag})…\n`);
      selfTemp = await stage(targetTag, asset, installDir);
      // The new CLI must run here and be exactly the target version.
      let answer: string;
      try {
        answer = (await deps.runVersion(selfTemp)).trim();
      } catch (error) {
        throw new Error(
          `the downloaded ${asset} does not run: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (answer !== `tentacle ${plan.self}`) {
        throw new Error(
          `the downloaded ${asset} reports "${answer}", expected "tentacle ${plan.self}"`,
        );
      }
    }

    // Commit: pods first, the CLI LAST. A crash in between leaves new pods and
    // the old CLI: `run` then asks for `tentacle update`, which fetches only
    // the CLI (the pods already match its target) and converges.
    for (const [temp, final] of podTemps) {
      await rename(temp, final);
      staged.delete(temp);
    }
    // Under sudo, hand what we created in the user's config dir back to them.
    if (sudoOwner) {
      for (const path of [...createdDirs, ...podTemps.map(([, final]) => final)]) {
        await chown(path, sudoOwner.uid, sudoOwner.gid);
      }
    }
    if (selfTemp) {
      await rename(selfTemp, deps.execPath);
      staged.delete(selfTemp);
    }
    write(
      `updated: ${plan.self ? `tentacle ${deps.appVersion} → ${plan.self}` : `tentacle ${deps.appVersion} (unchanged)`}${plan.podTargets.length ? `; pod binaries ${plan.podTargets.join(", ")} → ${plan.podVersion}` : ""}\n`,
    );
    return 0;
  } catch (error) {
    write(`[update error] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    for (const temp of staged) {
      await rm(temp, { force: true });
    }
  }
}
