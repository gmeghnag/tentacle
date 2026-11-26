/**
 * `previews.enabled` (docs/feat/container-apps-devices.md OD8): off by default,
 * file-only, per profile.
 */
import { describe, expect, test } from "bun:test";
import { applyProfile, resolveConfig } from "../src/index.ts";
import { FileConfigSchema } from "../src/schema.ts";

const resolve = (fileConfig: Parameters<typeof resolveConfig>[0]["fileConfig"]) =>
  resolveConfig({ fileConfig, env: {}, defaultCwd: "/work" });

describe("previews config", () => {
  test("off by default (ships OFF in S1); the file decides", () => {
    expect(resolve({}).previews).toEqual({ enabled: false, links: false });
    const set = resolve({ previews: { enabled: true } });
    expect(set.previews).toEqual({ enabled: true, links: false });
    expect(set.sources.previewsEnabled).toBe("file");
  });

  test("internet links ship OFF, and are their own switch", () => {
    expect(resolve({}).previews.links).toBe(false);
    const set = resolve({ previews: { enabled: true, links: true } });
    expect(set.previews).toEqual({ enabled: true, links: true });
    expect(set.sources.previewsLinks).toBe("file");
    expect(FileConfigSchema.safeParse({ previews: { links: "yes" } }).success).toBe(false);
  });

  test("a strict section", () => {
    expect(FileConfigSchema.safeParse({ previews: { enabled: true } }).success).toBe(true);
    expect(FileConfigSchema.safeParse({ previews: { enable: true } }).success).toBe(false);
  });

  test("a profile merges per key over the base", () => {
    const applied = applyProfile(
      { previews: { enabled: true }, profiles: { p: { previews: {} } } },
      "p",
    );
    expect(applied.ok && applied.config.previews).toEqual({ enabled: true });
    const links = applyProfile(
      { previews: { enabled: true }, profiles: { p: { previews: { links: true } } } },
      "p",
    );
    expect(links.ok && links.config.previews).toEqual({ enabled: true, links: true });
  });
});
