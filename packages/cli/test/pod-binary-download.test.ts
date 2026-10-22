import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FetchLike,
  HttpStatusError,
  commitDownload,
  downloadVerifiedAsset,
  fetchSha256Sums,
  parseSha256Sums,
  releaseAssetUrl,
} from "../src/pod-binary-download.ts";

const ASSET = "tentacle-bun-linux-x64";
const BODY = new TextEncoder().encode("pretend this is an ELF binary".repeat(100));
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A fake `fetch` serving `routes` (URL → response factory); records requested URLs. */
function fakeFetch(routes: Record<string, () => Response>): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      const route = routes[url];
      return route ? route() : new Response("Not Found", { status: 404 });
    },
  };
}

/** A body that sends `first` bytes, then errors (a connection drop mid-body). */
function droppingBody(first: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(first);
      controller.error(new Error("socket hang up"));
    },
  });
}

let destDir: string;
beforeEach(async () => {
  destDir = await mkdtemp(join(tmpdir(), "tentacle-dl-"));
});
afterEach(async () => {
  await rm(destDir, { recursive: true, force: true });
});

const url = releaseAssetUrl("v0.3.0", ASSET);
const sums = new Map([[ASSET, sha(BODY)]]);
const download = (fetch: FetchLike, s: ReadonlyMap<string, string> = sums) =>
  downloadVerifiedAsset({ tag: "v0.3.0", asset: ASSET, destDir, sums: s, fetch });

describe("SHA256SUMS", () => {
  test("parses sha256sum text and fetches it from the release", async () => {
    const hex = "a".repeat(64);
    const text = `${hex}  tentacle-bun-linux-x64\n${"B".repeat(64)} *tentacle-bun-darwin-arm64\ngarbage\n`;
    expect(parseSha256Sums(text)).toEqual(
      new Map([
        ["tentacle-bun-linux-x64", hex],
        ["tentacle-bun-darwin-arm64", "b".repeat(64)],
      ]),
    );
    const { fetch, urls } = fakeFetch({
      [releaseAssetUrl("v0.3.0", "SHA256SUMS")]: () => new Response(text),
    });
    expect((await fetchSha256Sums("v0.3.0", { fetch })).get(ASSET)).toBe(hex);
    expect(urls).toEqual([
      "https://github.com/gmeghnag/tentacle/releases/download/v0.3.0/SHA256SUMS",
    ]);
  });

  test("an HTTP error fetching SHA256SUMS names the URL", async () => {
    const { fetch } = fakeFetch({});
    await expect(fetchSha256Sums("v9.9.9", { fetch })).rejects.toThrow(
      /download failed: .*v9\.9\.9\/SHA256SUMS: HTTP 404/,
    );
  });
});

describe("downloadVerifiedAsset", () => {
  test("checksum OK: a 0755 temp file in destDir; commit renames it into place", async () => {
    const { fetch } = fakeFetch({ [url]: () => new Response(BODY) });
    const temp = await download(fetch);
    expect(temp.startsWith(join(destDir, "."))).toBe(true);
    expect(statSync(temp).mode & 0o777).toBe(0o755);
    expect(readFileSync(temp, "utf8")).toBe(new TextDecoder().decode(BODY));
    const final = join(destDir, ASSET);
    await commitDownload(temp, final);
    expect(existsSync(temp)).toBe(false);
    expect(readFileSync(final, "utf8")).toBe(new TextDecoder().decode(BODY));
  });

  const failures: [string, () => Response, ReadonlyMap<string, string>, RegExp][] = [
    [
      "checksum mismatch",
      () => new Response(new TextEncoder().encode("tampered")),
      sums,
      /checksum mismatch for tentacle-bun-linux-x64/,
    ],
    ["HTTP 404", () => new Response("nope", { status: 404 }), sums, /HTTP 404/],
    ["HTTP 503", () => new Response("busy", { status: 503 }), sums, /HTTP 503/],
    [
      "network drop mid-body",
      () => new Response(droppingBody(BODY.slice(0, 100))),
      sums,
      /download failed: .*socket hang up/,
    ],
  ];
  for (const [label, respond, s, message] of failures) {
    test(`${label}: throws and leaves no temp file; the final path is untouched`, async () => {
      const final = join(destDir, ASSET);
      writeFileSync(final, "OLD"); // an existing install must survive
      const { fetch } = fakeFetch({ [url]: respond });
      await expect(download(fetch, s)).rejects.toThrow(message);
      expect(readdirSync(destDir)).toEqual([ASSET]);
      expect(readFileSync(final, "utf8")).toBe("OLD");
    });
  }

  test("an asset missing from SHA256SUMS fails before any download", async () => {
    const { fetch, urls } = fakeFetch({ [url]: () => new Response(BODY) });
    await expect(download(fetch, new Map([["other", "0".repeat(64)]]))).rejects.toThrow(
      /tentacle-bun-linux-x64 is not listed in the v0\.3\.0 SHA256SUMS \(listed: other\)/,
    );
    expect(urls).toEqual([]);
    expect(readdirSync(destDir)).toEqual([]);
  });

  test("a fetch that rejects (DNS / TLS / offline) names the URL", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND github.com");
    };
    await expect(download(fetch)).rejects.toThrow(
      /download failed: https:\/\/github\.com\/.*ENOTFOUND/,
    );
    expect(readdirSync(destDir)).toEqual([]);
  });
});

describe("hardening (review nits N3/N4)", () => {
  test("SHA256SUMS listing one name with two different digests is an error", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(() => parseSha256Sums(`${a}  x\n${b}  x\n`)).toThrow(/x twice with different digests/);
    // The same digest twice is harmless.
    expect(parseSha256Sums(`${a}  x\n${a}  x\n`).get("x")).toBe(a);
  });

  test("a body larger than maxBytes is aborted and its temp removed", async () => {
    const { fetch } = fakeFetch({ [url]: () => new Response(BODY) });
    await expect(
      downloadVerifiedAsset({ tag: "v0.3.0", asset: ASSET, destDir, sums, fetch, maxBytes: 100 }),
    ).rejects.toThrow(/larger than 100 bytes/);
    expect(readdirSync(destDir)).toEqual([]);
  });

  test("a redirect that ends on a non-HTTPS URL is refused", async () => {
    const { fetch } = fakeFetch({
      [url]: () => {
        const response = new Response(BODY);
        Object.defineProperty(response, "url", { value: "http://evil.example/asset" });
        return response;
      },
    });
    await expect(download(fetch)).rejects.toThrow(/non-HTTPS URL \(http:\/\/evil\.example/);
    expect(readdirSync(destDir)).toEqual([]);
  });

  test("an HTTP error is an HttpStatusError carrying the status", async () => {
    const { fetch } = fakeFetch({});
    const error = await fetchSha256Sums("v1.0.0", { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).status).toBe(404);
  });
});
