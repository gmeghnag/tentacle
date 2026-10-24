import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG_JSONC } from "../src/defaults.ts";
import * as resolveModule from "../src/resolve.ts";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

// `model.titleModel` (docs/feat/session-titles.md): an optional model id on
// the same endpoint that names sessions; unset → the main model.
describe("model.titleModel", () => {
  test("parsed from the file and resolved; absent when unset", () => {
    const file = FileConfigSchema.parse({ model: { model: "big", titleModel: "small" } });
    const resolved = resolveConfig({ fileConfig: file, env: {}, defaultCwd: "/w" }) as unknown as {
      model: string;
      titleModel?: string;
    };
    expect(resolved.model).toBe("big");
    expect(resolved.titleModel).toBe("small");
    const plain = resolveConfig({ fileConfig: {}, env: {}, defaultCwd: "/w" });
    expect("titleModel" in plain).toBe(false);
  });

  test("an empty id is a loud validation error (the schema stays strict)", () => {
    expect(FileConfigSchema.safeParse({ model: { titleModel: "" } }).success).toBe(false);
  });
});

// `model.autoTitle` (owner decision after Review round 1): model-generated
// titles are OPT-IN. Off (default) → no title model call at all; the title
// is the automatic one (the first user message) and `/rename` is unchanged.
describe("model.autoTitle", () => {
  const resolve = (model: Record<string, unknown>) =>
    resolveConfig({
      fileConfig: FileConfigSchema.parse({ model }),
      env: {},
      defaultCwd: "/w",
    }) as unknown as { autoTitle?: unknown; titleModel?: string };

  test("default false; true only when the file says so", () => {
    expect(resolve({}).autoTitle).toBe(false);
    expect(resolve({ autoTitle: true }).autoTitle).toBe(true);
    expect(resolve({ autoTitle: false, titleModel: "small" }).autoTitle).toBe(false);
  });

  test("a non-boolean is a loud validation error (strict schema)", () => {
    expect(FileConfigSchema.safeParse({ model: { autoTitle: "yes" } }).success).toBe(false);
  });

  test("the config template documents both keys, autoTitle defaulting to false", () => {
    expect(DEFAULT_CONFIG_JSONC).toContain('// "autoTitle": false');
    expect(DEFAULT_CONFIG_JSONC).toContain('// "titleModel": ');
  });

  test("titleModel without autoTitle → exactly one startup notice; otherwise none", () => {
    const notice = (resolveModule as Record<string, unknown>).titleConfigNotice as
      | ((c: { autoTitle: boolean; titleModel?: string }) => string | null)
      | undefined;
    expect(typeof notice).toBe("function");
    const of = (c: { autoTitle: boolean; titleModel?: string }) => notice?.(c);
    expect(of({ autoTitle: false, titleModel: "small" })).toBe(
      "model.titleModel is set but model.autoTitle is false; titles are not generated",
    );
    expect(of({ autoTitle: true, titleModel: "small" })).toBeNull();
    expect(of({ autoTitle: false })).toBeNull();
    expect(of({ autoTitle: true })).toBeNull();
  });
});
