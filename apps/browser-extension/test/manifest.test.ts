import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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

  // The store shows it as the listing summary: Chrome caps it at 132 characters.
  test("description fits the store summary (≤ 132 characters)", () => {
    expect(typeof manifest.description).toBe("string");
    expect(String(manifest.description).length).toBeLessThanOrEqual(132);
  });

  test("MV3, module worker, nativeMessaging, scripts only on http(s)", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toContain("nativeMessaging");
    expect(manifest.background).toMatchObject({ type: "module" });
    const cs = (manifest.content_scripts as { matches: string[] }[])[0];
    expect(cs?.matches).toEqual(["http://*/*", "https://*/*"]);
  });
});

// The Chrome Web Store asks a justification per permission and rejects unused
// ones («request the minimum permissions», docs/feat/browser-extension-store.md):
// each declared permission must be reached by the source through its API.
describe("extension manifest: every permission is used", () => {
  const src = readdirSync(new URL("../src", import.meta.url))
    .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"))
    .join("\n");
  const API: Record<string, RegExp> = {
    nativeMessaging: /chrome\.runtime\.connectNative\(/,
    tabs: /chrome\.tabs\.(get|query|update|create)\(/,
    tabGroups: /chrome\.tabGroups\.update\(/,
    scripting: /chrome\.scripting\.executeScript\(/,
    webRequest: /chrome\.webRequest\.onCompleted/,
    debugger: /chrome\.debugger\.attach\(/,
  };

  test("the permission set is exactly the justified one", () => {
    expect([...(manifest.permissions as string[])].sort()).toEqual(Object.keys(API).sort());
    expect(manifest.optional_permissions).toBeUndefined();
  });

  for (const [perm, use] of Object.entries(API)) {
    test(`${perm} is used by the source`, () => {
      expect(use.test(src)).toBe(true);
    });
  }

  test("host access: <all_urls> (pages the agent opens) + http(s) content scripts", () => {
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
  });
});
