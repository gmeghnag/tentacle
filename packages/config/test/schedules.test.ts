import { describe, expect, test } from "bun:test";
import { applyProfile } from "../src/profile.ts";
import { type ResolveContext, resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

// `schedules.*` (docs/feat/cron-tool.md D3, owner Q6): the HOST's limits on the
// agent's scheduled wakes — file-only, never carried to a pod (a pod is never
// offered the tools).

const ctx = (fileConfig: ResolveContext["fileConfig"] = {}): ResolveContext => ({
  fileConfig,
  env: {},
  defaultCwd: "/launch",
});

const DEFAULTS = {
  maxJobs: 10,
  minIntervalMinutes: 1,
  expiryDays: 7,
  maxAheadDays: 7,
  promptMaxChars: 2000,
};

describe("schedules config", () => {
  test("defaults: owner Q6's limits", () => {
    expect(resolveConfig(ctx()).schedules).toEqual(DEFAULTS);
  });

  test("file values, per key (an unset key keeps its default)", () => {
    expect(
      resolveConfig(ctx({ schedules: { maxJobs: 3, minIntervalMinutes: 15 } })).schedules,
    ).toEqual({ ...DEFAULTS, maxJobs: 3, minIntervalMinutes: 15 });
  });

  test("strict: zero, a fraction, out of range or an unknown key is a schema error", () => {
    for (const bad of [
      { maxJobs: 0 },
      { maxJobs: 101 },
      { minIntervalMinutes: 0.5 },
      { expiryDays: 0 },
      { expiryDays: 31 },
      { maxAheadDays: 31 },
      { promptMaxChars: 0 },
      { promptMaxChars: 20_001 },
      { every: "1m" },
    ]) {
      expect({ bad, ok: FileConfigSchema.safeParse({ schedules: bad }).success }).toEqual({
        bad,
        ok: false,
      });
    }
    expect(
      FileConfigSchema.safeParse({
        schedules: { maxJobs: 100, expiryDays: 30, maxAheadDays: 30, promptMaxChars: 20_000 },
      }).success,
    ).toBe(true);
  });

  test("a profile merges it per key", () => {
    const file = FileConfigSchema.parse({
      schedules: { maxJobs: 3, expiryDays: 2 },
      profiles: { p: { schedules: { expiryDays: 5 } } },
    });
    const applied = applyProfile(file, "p");
    expect(applied.ok ? applied.config.schedules : applied.reason).toEqual({
      maxJobs: 3,
      expiryDays: 5,
    });
  });
});
