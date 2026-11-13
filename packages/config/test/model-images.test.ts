/**
 * `model.images` (docs/feat/attachments-prompt.md D4, P11): the config key that
 * decides whether a daemon advertises image input at all. It rides the exact
 * path `maxImageBytes` took — strict schema, resolve, per-entry inheritance in
 * `models`, and key docs — so an entry can override what the main model does.
 */
import { describe, expect, test } from "bun:test";
import { resolveModelEntry } from "../src/models.ts";
import { type ResolveContext, resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

const base = { model: { provider: "openai" as const, model: "a-model", baseURL: "http://x/v1" } };

function ctx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return { fileConfig: {}, env: {}, defaultCwd: "/launch", ...overrides };
}

describe("schema", () => {
  test("model.images is a boolean, and only a boolean", () => {
    expect(FileConfigSchema.safeParse({ model: { ...base.model, images: true } }).success).toBe(
      true,
    );
    expect(FileConfigSchema.safeParse({ model: { ...base.model, images: false } }).success).toBe(
      true,
    );
    expect(FileConfigSchema.safeParse({ model: { ...base.model, images: "yes" } }).success).toBe(
      false,
    );
    expect(
      FileConfigSchema.safeParse({ models: { fast: { model: "b", images: true } } }).success,
    ).toBe(true);
  });
});

describe("resolve", () => {
  test("model.images reaches the resolved config, unset stays absent", () => {
    const on = resolveConfig(ctx({ fileConfig: { model: { ...base.model, images: true } } }));
    expect(on.images).toBe(true);
    const off = resolveConfig(ctx({ fileConfig: { model: { ...base.model, images: false } } }));
    expect(off.images).toBe(false);
    const unset = resolveConfig(ctx({ fileConfig: base }));
    expect(unset.images).toBeUndefined();
  });

  test("a models entry inherits model.images unless it sets its own", () => {
    const resolved = resolveConfig(
      ctx({
        fileConfig: {
          model: { ...base.model, images: true },
          models: { inherits: { model: "b" }, off: { model: "c", images: false } },
        },
      }),
    );
    expect(resolved.models.inherits?.images).toBe(true);
    expect(resolved.models.off?.images).toBe(false);
  });
});

describe("resolveModelEntry", () => {
  test("takes the entry's images over the main model's", () => {
    const main = {
      provider: "openai" as const,
      baseURL: "http://x/v1",
      model: "m",
      contextWindow: 1024,
      images: true,
    };
    expect(resolveModelEntry(main, { images: false }).images).toBe(false);
    expect(resolveModelEntry(main, {}).images).toBe(true);
  });
});
