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
      const digest = match[1].toLowerCase();
      const seen = sums.get(match[2]);
      // One name, two digests: ambiguous, never "the last one wins" (review N3).
      if (seen !== undefined && seen !== digest) {
        throw new Error(`SHA256SUMS lists ${match[2]} twice with different digests`);
      }
      sums.set(match[2], digest);
    }
  }
  return sums;
}

/** A non-2xx HTTP status from a release URL (`status` lets callers explain a 404). */
export class HttpStatusError extends Error {
  override readonly name = "HttpStatusError";
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`download failed: ${url}: HTTP ${status}`);
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * GET `url`, following redirects (GitHub sends release assets to
 * `release-assets.githubusercontent.com` / `objects.githubusercontent.com`).
 * A non-2xx status or a redirect that ends on a non-HTTPS URL throws, and the
 * unread body is cancelled so the connection is released (review N4).
 */
async function get(url: string, doFetch: FetchLike): Promise<Response> {
  let response: Response;
  try {
    response = await doFetch(url, { redirect: "follow" });
  } catch (error) {
    throw new Error(`download failed: ${url}: ${errorText(error)}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpStatusError(url, response.status);
  }
  // `response.url` is the final URL after redirects ("" for a synthetic Response).
  if (response.url !== "" && !response.url.startsWith("https://")) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`download failed: ${url}: redirected to a non-HTTPS URL (${response.url})`);
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
    throw new Error(`download failed: ${url}: ${errorText(error)}`);
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
  /** Abort a body larger than this (default 512 MiB; a binary is ~90 MB). */
  readonly maxBytes?: number;
}

/** The default `maxBytes`: far above a tentacle binary, far below a runaway body. */
export const DEFAULT_MAX_ASSET_BYTES = 512 * 1024 * 1024;

/**
 * Download `asset` into a temp file in `destDir`, verify its SHA-256 against
 * `sums`, `chmod 755` it, and return the temp path (commit it with
 * `commitDownload`, or `rm` it). Throws, with no temp file left behind, when
 * the asset is not in `SHA256SUMS` (before any download), on an HTTP error, a
 * dropped body, a body over `maxBytes`, a write error, or a checksum mismatch.
 * The file is `fsync`ed before it is closed, so a crash after the caller's
 * rename can never leave a truncated binary in place (review N4).
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
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ASSET_BYTES;
  try {
    const hash = createHash("sha256");
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(temp, "wx", 0o600);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    let total = 0;
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
          throw new Error(`download failed: ${url}: ${errorText(error)}`);
        }
        if (chunk.done) {
          break;
        }
        total += chunk.value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`download failed: ${url}: larger than ${maxBytes} bytes`);
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
      await file.sync();
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
