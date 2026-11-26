/**
 * `apps.enabled` / `apps.domain` (docs/feat/session-apps-publish.md D11): off by
 * default, a bare hostname, per profile, file-only.
 */
import { describe, expect, test } from "bun:test";
import { applyProfile, resolveConfig } from "../src/index.ts";
import { FileConfigSchema } from "../src/schema.ts";

const resolve = (fileConfig: Parameters<typeof resolveConfig>[0]["fileConfig"]) =>
  resolveConfig({ fileConfig, env: {}, defaultCwd: "/work" });

describe("apps config", () => {
  test("off by default, at apps.tentacle.so; the file decides", () => {
    expect(resolve({}).apps).toEqual({ enabled: false, domain: "apps.tentacle.so" });
    const set = resolve({ apps: { enabled: true, domain: "apps.example.so" } });
    expect(set.apps).toEqual({ enabled: true, domain: "apps.example.so" });
    expect(set.sources.appsEnabled).toBe("file");
    expect(set.sources.appsDomain).toBe("file");
  });

  test("the domain is a bare hostname", () => {
    for (const domain of ["apps.tentacle.so", "a.b-c.example"]) {
      expect(FileConfigSchema.safeParse({ apps: { domain } }).success).toBe(true);
    }
    for (const domain of [
      "https://apps.tentacle.so",
      "apps.tentacle.so/",
      "apps.tentacle.so:443",
      "Apps.Tentacle.so",
      "localhost",
      "-a.so",
      "a..so",
      "a b.so",
      "1.2.3.4",
      "",
    ]) {
      expect(FileConfigSchema.safeParse({ apps: { domain } }).success).toBe(false);
    }
    expect(FileConfigSchema.safeParse({ apps: { enable: true } }).success).toBe(false);
  });

  test("a profile merges per key over the base", () => {
    const applied = applyProfile(
      { apps: { domain: "apps.example.so" }, profiles: { p: { apps: { enabled: true } } } },
      "p",
    );
    expect(applied.ok && applied.config.apps).toEqual({
      domain: "apps.example.so",
      enabled: true,
    });
  });
});
