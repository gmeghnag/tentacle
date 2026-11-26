/**
 * `bun run browser-extension:pack` (docs/feat/browser-extension-store.md):
 * builds `dist/tentacle-browser-extension-<version>.zip`, the package the owner
 * uploads to the Chrome Web Store.
 *
 * Single source of truth: the zip is made from `EXTENSION_ASSETS`, the SAME
 * table `tentacle browser install` embeds and writes as the unpacked copy
 * (which `packages/cli/test/browser-install.test.ts` pins byte-equal to
 * `apps/browser-extension/`). The one difference: the store manifest has no
 * `key`. The key pins the DEV id; the store assigns its own id at the first
 * upload (we hold no private key for the pinned one), and a first upload that
 * carries a `key` is reported to fail with «key field is not allowed in
 * manifest». The store id then goes in `BROWSER_EXTENSION_STORE_ID`
 * (`packages/browser/src/link-schema.ts`).
 *
 * The zip is deterministic (fixed timestamps, fixed order: manifest first, then
 * sorted), so the same sources always give the same bytes and sha256.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { EXTENSION_ASSETS } from "../packages/cli/src/browser-extension-assets.ts";

// ---- zip (PKWARE APPNOTE: local headers, central directory, end record) ------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00 in DOS format: a fixed stamp keeps the bytes reproducible. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A little-endian record of 16/32-bit fields (`[bytes, value]` pairs). */
function record(fields: readonly (readonly [2 | 4, number])[]): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, [w]) => n + w, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [w, v] of fields) {
    if (w === 2) view.setUint16(at, v, true);
    else view.setUint32(at, v, true);
    at += w;
  }
  return out;
}

/** A deflate zip of `files`, in the given key order. */
export function writeZip(files: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = utf8(name);
    const packed = new Uint8Array(deflateRawSync(data, { level: 9 }));
    const crc = crc32(data);
    // version, flags, method (8 = deflate), time, date, crc, sizes, name length
    const common = [
      [2, 20],
      [2, UTF8_NAMES],
      [2, 8],
      [2, DOS_TIME],
      [2, DOS_DATE],
      [4, crc],
      [4, packed.length],
      [4, data.length],
      [2, nameBytes.length],
    ] as const;
    const local = record([[4, 0x04034b50], ...common, [2, 0]]);
    locals.push(local, nameBytes, packed);
    // made-by, then `common`, then extra/comment/disk/internal/external = 0, offset
    const central = record([
      [4, 0x02014b50],
      [2, 20],
      ...common,
      [2, 0],
      [2, 0],
      [2, 0],
      [2, 0],
      [4, 0],
      [4, offset],
    ]);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const cd = concat(centrals);
  const count = Object.keys(files).length;
  const end = record([
    [4, 0x06054b50],
    [2, 0],
    [2, 0],
    [2, count],
    [2, count],
    [4, cd.length],
    [4, offset],
    [2, 0],
  ]);
  return concat([...locals, cd, end]);
}

/** Reads a zip written by `writeZip` (central directory order); throws on a bad entry or CRC. */
export function readZip(zip: Uint8Array): Record<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const endAt = zip.length - 22;
  if (endAt < 0 || u32(endAt) !== 0x06054b50) throw new Error("not a zip");
  const count = u16(endAt + 10);
  let p = u32(endAt + 16);
  const out: Record<string, Uint8Array> = {};
  for (let i = 0; i < count; i++) {
    if (u32(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const csize = u32(p + 20);
    const nlen = u16(p + 28);
    const skip = u16(p + 30) + u16(p + 32);
    const at = u32(p + 42);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nlen));
    if (u32(at) !== 0x04034b50) throw new Error(`bad local header: ${name}`);
    const start = at + 30 + u16(at + 26) + u16(at + 28);
    const raw = zip.subarray(start, start + csize);
    const data = new Uint8Array(method === 8 ? inflateRawSync(raw) : raw);
    if (crc32(data) !== crc) throw new Error(`crc mismatch: ${name}`);
    out[name] = data;
    p += 46 + nlen + skip;
  }
  return out;
}

// ---- the store package ---------------------------------------------------------

/** Chrome's `version`: 1–4 dot-separated integers 0–65535, no leading zeros. */
const VERSION = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

export function zipName(version: string): string {
  return `tentacle-browser-extension-${version}.zip`;
}

/** The store manifest: the embedded one without `key`; refuses a version Chrome would. */
export function storeManifest(text: string): Record<string, unknown> & { version: string } {
  const m = JSON.parse(text) as Record<string, unknown>;
  const v = m.version;
  if (
    typeof v !== "string" ||
    !VERSION.test(v) ||
    v.split(".").some((part) => Number(part) > 65535)
  ) {
    throw new Error(`manifest.json: not a Chrome extension version: ${String(v)}`);
  }
  const { key: _key, ...rest } = m;
  return { ...rest, version: v };
}

export interface PackResult {
  readonly path: string;
  readonly version: string;
  readonly files: readonly string[];
  readonly sha256: string;
}

export function packExtension(opts: {
  readonly outDir: string;
  readonly assets?: Readonly<Record<string, string | Uint8Array>>;
}): PackResult {
  const assets = opts.assets ?? EXTENSION_ASSETS;
  const manifestText = assets["manifest.json"];
  if (manifestText === undefined) throw new Error("the extension assets have no manifest.json");
  const manifest = storeManifest(
    typeof manifestText === "string" ? manifestText : new TextDecoder().decode(manifestText),
  );
  const files: Record<string, Uint8Array> = {
    "manifest.json": new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  };
  for (const rel of Object.keys(assets).sort()) {
    const content = assets[rel];
    if (rel === "manifest.json" || content === undefined) continue;
    files[rel] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  const zip = writeZip(files);
  mkdirSync(opts.outDir, { recursive: true });
  const path = join(opts.outDir, zipName(manifest.version));
  writeFileSync(path, zip);
  return {
    path,
    version: manifest.version,
    files: Object.keys(files),
    sha256: createHash("sha256").update(zip).digest("hex"),
  };
}

if (import.meta.main) {
  const outDir = resolve(import.meta.dir, "..", "dist");
  const r = packExtension({ outDir });
  process.stdout.write(
    [
      `${r.path}`,
      `version ${r.version} · ${r.files.length} files · sha256 ${r.sha256}`,
      ...r.files.map((f) => `  ${f}`),
      "",
      "Upload it at https://chrome.google.com/webstore/devconsole (docs/feat/browser-extension-store.md).",
      "A store UPDATE needs a higher manifest version than the last upload: bump",
      "apps/browser-extension/manifest.json `version` first.",
      "",
    ].join("\n"),
  );
}
