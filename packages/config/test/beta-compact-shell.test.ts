import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import { KEY_DOCS } from "../src/key-docs.ts";
import { applyProfile } from "../src/profile.ts";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

// `beta.compactShell` (docs/feat/shell-intent-line.md §4): a LAPTOP-ONLY
// display setting, default off. The TUI no longer reads it
// (docs/fix/tui-shell-row-collapsed retired it there), but the KEY must keep
// parsing: a config file that sets it would otherwise fail `.strict()`.
describe("beta.compactShell", () => {
  test("a boolean parses in the file and a profile; anything else is refused (strict)", () => {
    for (const compactShell of [true, false]) {
      expect(FileConfigSchema.safeParse({ beta: { compactShell } }).success).toBe(true);
      expect(
        FileConfigSchema.safeParse({ profiles: { p: { beta: { compactShell } } } }).success,
      ).toBe(true);
    }
    expect(FileConfigSchema.safeParse({ beta: { compactShell: "yes" } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ beta: { x: true } }).success).toBe(false);
  });

  test("resolveConfig passes it through; absent when unset", () => {
    const on = FileConfigSchema.parse({ beta: { compactShell: true } });
    expect(resolveConfig({ fileConfig: on, env: {}, defaultCwd: "/w" }).beta).toEqual({
      compactShell: true,
    });
    const none = FileConfigSchema.parse({});
    expect(resolveConfig({ fileConfig: none, env: {}, defaultCwd: "/w" }).beta).toBeUndefined();
  });

  test("a profile's value wins", () => {
    const file = FileConfigSchema.parse({
      beta: { compactShell: false },
      profiles: { p: { beta: { compactShell: true } } },
    });
    const merged = applyProfile(file, "p");
    expect(merged.ok).toBe(true);
    if (!merged.ok) {
      return;
    }
    expect(merged.config.beta).toEqual({ compactShell: true });
  });

  test("documented: never carried to a pod, default false; the scaffold names it", () => {
    expect(KEY_DOCS.beta?.carried).toBe("no");
    expect(KEY_DOCS["beta.compactShell"]?.carried).toBe("no");
    expect(KEY_DOCS["beta.compactShell"]?.default?.()).toBe(false);
    expect(DEFAULT_CONFIG_JSONC).toContain('"beta": { "compactShell": false }');
  });
});
