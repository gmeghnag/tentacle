import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_ASSETS } from "../../packages/cli/src/browser-extension-assets.ts";
import {
  crc32,
  packExtension,
  readZip,
  storeManifest,
  writeZip,
  zipName,
} from "../browser-extension-pack.ts";

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "tbx-pack-"));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

const bytes = (v: string | Uint8Array): Buffer => Buffer.from(v);
const embeddedManifest = JSON.parse(String(EXTENSION_ASSETS["manifest.json"])) as Record<
  string,
  unknown
>;

describe("browser-extension pack: the store zip", () => {
  test("its file set IS the set `tentacle browser install` embeds, manifest at the root", () => {
    const r = packExtension({ outDir: out });
    const files = readZip(new Uint8Array(readFileSync(r.path)));
    expect(Object.keys(files).sort()).toEqual(Object.keys(EXTENSION_ASSETS).sort());
    expect(Object.keys(files)[0]).toBe("manifest.json");
    for (const name of Object.keys(files)) expect(name.startsWith("/")).toBe(false);
  });

  test("every file but the manifest is byte-equal to the embedded one", () => {
    const files = readZip(new Uint8Array(readFileSync(packExtension({ outDir: out }).path)));
    for (const [rel, content] of Object.entries(EXTENSION_ASSETS)) {
      if (rel === "manifest.json") continue;
      expect(bytes(files[rel] ?? "").toString("base64")).toBe(bytes(content).toString("base64"));
    }
  });

  test("the manifest is the embedded one minus `key` (the store assigns the id)", () => {
    const files = readZip(new Uint8Array(readFileSync(packExtension({ outDir: out }).path)));
    const m = JSON.parse(Buffer.from(files["manifest.json"] ?? "").toString("utf8"));
    expect("key" in embeddedManifest).toBe(true);
    expect("key" in m).toBe(false);
    const { key: _key, ...rest } = embeddedManifest;
    expect(m).toEqual(rest);
  });

  test("named after the manifest version, under the out dir; deterministic bytes", () => {
    const a = packExtension({ outDir: out });
    expect(a.path).toBe(join(out, `tentacle-browser-extension-${embeddedManifest.version}.zip`));
    const first = readFileSync(a.path).toString("base64");
    const b = packExtension({ outDir: out });
    expect(readFileSync(b.path).toString("base64")).toBe(first);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a manifest with no valid Chrome version is refused", () => {
    for (const version of [undefined, "", "1.2.3.4.5", "v1", "1.-2", "1.99999", "01.2"]) {
      expect(() => storeManifest(JSON.stringify({ version, key: "x" }))).toThrow(/version/);
    }
    expect(storeManifest(JSON.stringify({ version: "0.2.0", key: "x" })).version).toBe("0.2.0");
    expect(zipName("0.2.0")).toBe("tentacle-browser-extension-0.2.0.zip");
  });

  test("an asset table without a manifest is refused", () => {
    expect(() => packExtension({ outDir: out, assets: { "src/a.js": "x" } })).toThrow(/manifest/);
  });
});

describe("zip writer / reader", () => {
  test("crc32 of a known string", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("round-trips text, binary and empty files; refuses a corrupted entry", () => {
    const files = {
      "a.txt": new TextEncoder().encode("hello hello hello"),
      "dir/b.bin": new Uint8Array([0, 255, 1, 254]),
      "empty.txt": new Uint8Array(),
    };
    const zip = writeZip(files);
    const back = readZip(zip);
    expect(Object.keys(back)).toEqual(Object.keys(files));
    for (const [k, v] of Object.entries(files)) expect([...(back[k] ?? [])]).toEqual([...v]);
    // Flip one byte inside the first entry's compressed data: the CRC check catches it.
    const bad = Uint8Array.from(zip);
    const at = 30 + "a.txt".length + 2;
    bad[at] = (bad[at] ?? 0) ^ 0xff;
    expect(() => readZip(bad)).toThrow();
  });
});
