/**
 * Download + verify a release asset (D1/D3, docs/feat/pod-binary-download.md),
 * for `tentacle update`. Anonymous HTTPS from GitHub releases, checked against
 * the same release's `SHA256SUMS` (D3: no signature in v1). Two steps, so the
 * caller can stage every file before committing any:
 *
 * 1. `downloadVerifiedAsset` streams the asset into a temp file IN the
 *    destination directory (same filesystem → the later rename is atomic),
 *    hashing while it writes, compares the digest, and `chmod 755`s it. Every
 *    failure removes the temp file; the destination is never touched.
 * 2. `commitDownload` renames the temp file over the final path.
 *
 * No dependency: `fetch` (injected), `node:crypto`, `node:fs/promises`.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

/** The public repo releases are published from (`owner/name`). */
export const RELEASE_REPO = "gmeghnag/tentacle";

/** The `fetch` seam (tests inject a fake; no network in tests). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReleaseOptions {
  readonly fetch?: FetchLike;
  /** `owner/name`; defaults to `RELEASE_REPO`. */
  readonly repo?: string;
}

/** `https://github.com/<repo>/releases/download/<tag>/<asset>`. */
export function releaseAssetUrl(tag: string, asset: string, repo: string = RELEASE_REPO): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

/**
 * Parse `sha256sum` output (`<64 hex>  <name>`, or `<hex> *<name>` in binary
 * mode) into name → lowercase digest. Malformed lines are ignored.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) {
      sums.set(match[2], match[1].toLowerCase());
    }
  }
  return sums;
}

async function get(url: string, doFetch: FetchLike): Promise<Response> {
  let response: Response;
  try {
    response = await doFetch(url, { redirect: "follow" });
  } catch (error) {
    throw new Error(`download failed: ${url}: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) {
    throw new Error(`download failed: ${url}: HTTP ${response.status}`);
  }
  return response;
}

/** Fetch and parse a release's `SHA256SUMS`. */
export async function fetchSha256Sums(
  tag: string,
  options: ReleaseOptions = {},
): Promise<Map<string, string>> {
  const url = releaseAssetUrl(tag, "SHA256SUMS", options.repo);
  const response = await get(url, options.fetch ?? fetch);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new Error(`download failed: ${url}: ${error instanceof Error ? error.message : error}`);
  }
  return parseSha256Sums(text);
}

export interface DownloadAssetOptions extends ReleaseOptions {
  readonly tag: string;
  /** The asset's file name, e.g. `tentacle-bun-linux-x64`. */
  readonly asset: string;
  /** The directory the asset will be committed into (the temp file goes here). */
  readonly destDir: string;
  /** The release's `SHA256SUMS` (from `fetchSha256Sums`, fetched once per release). */
  readonly sums: ReadonlyMap<string, string>;
}

/**
 * Download `asset` into a temp file in `destDir`, verify its SHA-256 against
 * `sums`, `chmod 755` it, and return the temp path (commit it with
 * `commitDownload`, or `rm` it). Throws, with no temp file left behind, when
 * the asset is not in `SHA256SUMS` (before any download), on an HTTP error, a
 * dropped body, a write error, or a checksum mismatch.
 */
export async function downloadVerifiedAsset(options: DownloadAssetOptions): Promise<string> {
  const expected = options.sums.get(options.asset);
  if (!expected) {
    throw new Error(
      `${options.asset} is not listed in the ${options.tag} SHA256SUMS (listed: ${[...options.sums.keys()].join(", ") || "none"})`,
    );
  }
  const url = releaseAssetUrl(options.tag, options.asset, options.repo);
  const response = await get(url, options.fetch ?? fetch);
  const temp = join(options.destDir, `.${options.asset}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const hash = createHash("sha256");
    const file = await open(temp, "wx", 0o600);
    try {
      if (!response.body) {
        throw new Error("empty response body");
      }
      const reader = response.body.getReader();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw new Error(
            `download failed: ${url}: ${error instanceof Error ? error.message : error}`,
          );
        }
        if (chunk.done) {
          break;
        }
        hash.update(chunk.value);
        try {
          await file.write(chunk.value);
        } catch (error) {
          // A write error (e.g. disk full): release the connection too.
          await reader.cancel().catch(() => {});
          throw error;
        }
      }
    } finally {
      await file.close();
    }
    const actual = hash.digest("hex");
    if (actual !== expected) {
      throw new Error(
        `checksum mismatch for ${options.asset} (${url}): expected ${expected}, got ${actual}`,
      );
    }
    await chmod(temp, 0o755);
    return temp;
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Atomically move a verified temp file (from `downloadVerifiedAsset`) to `finalPath`. */
export async function commitDownload(tempPath: string, finalPath: string): Promise<void> {
  await rename(tempPath, finalPath);
}
