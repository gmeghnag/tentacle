import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BROWSER_EXTENSION_ID } from "@tentacle/browser";

const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("extension manifest", () => {
  test("the pinned key yields BROWSER_EXTENSION_ID (U7)", () => {
    const der = Buffer.from(String(manifest.key), "base64");
    const id = [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
      .map((x) => String.fromCharCode(97 + Number.parseInt(x, 16)))
      .join("");
    expect(id).toBe(BROWSER_EXTENSION_ID);
  });

  test("MV3, module worker, nativeMessaging, scripts only on http(s)", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toContain("nativeMessaging");
    expect(manifest.background).toMatchObject({ type: "module" });
    const cs = (manifest.content_scripts as { matches: string[] }[])[0];
    expect(cs?.matches).toEqual(["http://*/*", "https://*/*"]);
  });
});
