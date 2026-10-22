import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PodBinaryError,
  buildBinary,
  checkPodBinaries,
  cliVersion,
  configBinPath,
  resolvePodBinary,
} from "../src/pod-binary-build.ts";
import type { PodBinaryTarget } from "../src/pod-binary.ts";
import { readBinaryVersion } from "../src/version-marker.ts";
import { formatVersionMarker } from "../src/version.ts";

/** A fake build that "compiles" by writing a marker file (no real build). */
function fakeBuild(marker: (outfile: string) => string) {
  const built: string[] = [];
  return {
    built,
    build: async (outfile: string, _target: string): Promise<boolean> => {
      built.push(outfile);
      writeFileSync(outfile, marker(outfile));
      return true;
    },
  };
}

describe("resolvePodBinary", () => {
  test("TENTACLE_POD_BIN override is read directly (no cache, no build)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-"));
    const override = join(dir, "my-prebuilt");
    writeFileSync(override, "PREBUILT-BYTES");
    const saved = process.env.TENTACLE_POD_BIN;
    process.env.TENTACLE_POD_BIN = override;
    const logs: string[] = [];
    try {
      const bytes = await resolvePodBinary("bun-linux-x64", {
        cacheDir: join(dir, "cache"),
        build: fakeBuild(() => "SHOULD-NOT-BUILD").build,
        log: (l) => logs.push(l),
      });
      expect(Buffer.from(bytes).toString()).toBe("PREBUILT-BYTES");
      expect(logs.some((l) => l.includes("TENTACLE_POD_BIN"))).toBe(true);
      // The override wins: nothing is cached or built.
      expect(existsSync(join(dir, "cache"))).toBe(false);
    } finally {
      // `saved` is `undefined` when the var wasn't set. (Assigning `undefined`
      // would stringify to "undefined" in Bun, so delete the key instead —
      // `Reflect.deleteProperty` keeps biome's `noDelete` happy.)
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, "TENTACLE_POD_BIN");
      } else {
        process.env.TENTACLE_POD_BIN = saved;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a cache miss builds into the cache and returns the bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-"));
    const cacheDir = join(dir, "cache");
    const { built, build } = fakeBuild((o) => `BUILT:${o}`);
    const target: PodBinaryTarget = "bun-linux-arm64";
    try {
      const bytes = await resolvePodBinary(target, { cacheDir, build });
      expect(built).toHaveLength(1);
      expect(built[0]).toBe(join(cacheDir, "tentacle-bun-linux-arm64"));
      expect(Buffer.from(bytes).toString()).toBe(
        `BUILT:${join(cacheDir, "tentacle-bun-linux-arm64")}`,
      );
      expect(existsSync(join(cacheDir, "tentacle-bun-linux-arm64"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a cache hit does not rebuild", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-"));
    const cacheDir = join(dir, "cache");
    const outfile = join(cacheDir, "tentacle-bun-linux-x64");
    // Seed the cache with an existing binary (the cache dir must exist first).
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(outfile, "CACHED-BYTES");
    const { built, build } = fakeBuild(() => "SHOULD-NOT-REBUILD");
    const logs: string[] = [];
    try {
      const bytes = await resolvePodBinary("bun-linux-x64", {
        cacheDir,
        build,
        log: (l) => logs.push(l),
      });
      expect(Buffer.from(bytes).toString()).toBe("CACHED-BYTES");
      expect(built).toHaveLength(0);
      expect(logs.some((l) => l.includes("using cache"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a prebuilt in <configDir>/bin is used before the repo cache/build (cwd-independent)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-"));
    const configDir = join(dir, "config");
    const stable = configBinPath(configDir, "bun-linux-x64");
    mkdirSync(join(configDir, "bin"), { recursive: true });
    writeFileSync(stable, "STABLE-BYTES");
    const { built, build } = fakeBuild(() => "SHOULD-NOT-BUILD");
    const logs: string[] = [];
    try {
      const bytes = await resolvePodBinary("bun-linux-x64", {
        configDir,
        cacheDir: join(dir, "cache"),
        build,
        log: (l) => logs.push(l),
      });
      expect(Buffer.from(bytes).toString()).toBe("STABLE-BYTES");
      expect(built).toHaveLength(0); // not built
      expect(existsSync(join(dir, "cache"))).toBe(false); // repo cache untouched
      expect(logs.some((l) => l.includes(stable))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("configDir without the prebuilt falls through to the repo cache/build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-"));
    const configDir = join(dir, "config"); // no bin/ seeded
    const cacheDir = join(dir, "cache");
    const { built, build } = fakeBuild((o) => `BUILT:${o}`);
    try {
      const bytes = await resolvePodBinary("bun-linux-arm64", { configDir, cacheDir, build });
      expect(built).toHaveLength(1); // fell through to the build
      expect(Buffer.from(bytes).toString()).toContain("BUILT:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed build throws with a helpful hint (no stale cache entry)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-"));
    const cacheDir = join(dir, "cache");
    const build = async (): Promise<boolean> => false; // simulate a failing build
    try {
      await expect(resolvePodBinary("bun-linux-x64", { cacheDir, build })).rejects.toThrow(
        /failed to build the bun-linux-x64/,
      );
      await expect(resolvePodBinary("bun-linux-x64", { cacheDir, build })).rejects.toThrow(
        /TARGET=bun-linux-x64 bun run compile/,
      );
      // A failed build must not leave a partial cache entry.
      expect(existsSync(join(cacheDir, "tentacle-bun-linux-x64"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A fake compiled binary: filler bytes with an optional version marker near the end. */
function fakeBinary(version: string | undefined): string {
  return `ELF-HEADER-${"_".repeat(200)}${version ? formatVersionMarker(version) : ""}${"_".repeat(50)}`;
}

/** Run `fn` with `TENTACLE_POD_BIN` unset (restored after). */
async function withoutPodBinEnv(fn: () => Promise<void>): Promise<void> {
  const saved = process.env.TENTACLE_POD_BIN;
  Reflect.deleteProperty(process.env, "TENTACLE_POD_BIN");
  try {
    await fn();
  } finally {
    if (saved !== undefined) {
      process.env.TENTACLE_POD_BIN = saved;
    }
  }
}

describe("resolvePodBinary in a release build (D1/D2: offline, exact version)", () => {
  const seed = async (bins: Partial<Record<PodBinaryTarget, string>>) => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-rel-"));
    const configDir = join(dir, "config");
    mkdirSync(join(configDir, "bin"), { recursive: true });
    for (const [target, body] of Object.entries(bins)) {
      writeFileSync(configBinPath(configDir, target as PodBinaryTarget), body);
    }
    return { dir, configDir, cacheDir: join(dir, "cache") };
  };

  test("a <configDir>/bin binary whose marker equals the app version is injected", async () => {
    const { dir, configDir, cacheDir } = await seed({ "bun-linux-x64": fakeBinary("0.3.0") });
    const { built, build } = fakeBuild(() => "SHOULD-NOT-BUILD");
    try {
      await withoutPodBinEnv(async () => {
        const bytes = await resolvePodBinary("bun-linux-x64", {
          configDir,
          cacheDir,
          build,
          appVersion: "0.3.0",
        });
        expect(Buffer.from(bytes).toString()).toBe(fakeBinary("0.3.0"));
      });
      expect(built).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const [label, body, message] of [
    [
      "missing",
      undefined,
      /pod binary for x64 is missing .*this tentacle is 0\.3\.0\): run `tentacle update`/,
    ],
    [
      "stale",
      fakeBinary("0.2.0"),
      /pod binary for x64 is at version 0\.2\.0 .*this tentacle is 0\.3\.0\): run `tentacle update`/,
    ],
    [
      "unknown (no marker)",
      fakeBinary(undefined),
      /pod binary for x64 is of unknown version .*run `tentacle update`/,
    ],
  ] as const) {
    test(`a ${label} binary is an error naming \`tentacle update\` — never the repo cache or a build`, async () => {
      const { dir, configDir, cacheDir } = await seed(
        body === undefined ? {} : { "bun-linux-x64": body },
      );
      // A repo cache that dev mode WOULD use: release mode must ignore it.
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "tentacle-bun-linux-x64"), "CACHED");
      const { built, build } = fakeBuild(() => "SHOULD-NOT-BUILD");
      try {
        await withoutPodBinEnv(async () => {
          const p = resolvePodBinary("bun-linux-x64", {
            configDir,
            cacheDir,
            build,
            appVersion: "0.3.0",
          });
          await expect(p).rejects.toBeInstanceOf(PodBinaryError);
          await expect(p).rejects.toThrow(message);
        });
        expect(built).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  test("TENTACLE_POD_BIN still wins in a release build (the explicit escape hatch)", async () => {
    const { dir, configDir } = await seed({});
    const override = join(dir, "mine");
    writeFileSync(override, "MINE-NO-MARKER");
    const saved = process.env.TENTACLE_POD_BIN;
    process.env.TENTACLE_POD_BIN = override;
    try {
      const bytes = await resolvePodBinary("bun-linux-arm64", { configDir, appVersion: "0.3.0" });
      expect(Buffer.from(bytes).toString()).toBe("MINE-NO-MARKER");
      await checkPodBinaries({ configDir, appVersion: "0.3.0" }); // no throw
    } finally {
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, "TENTACLE_POD_BIN");
      } else {
        process.env.TENTACLE_POD_BIN = saved;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("checkPodBinaries: both arches at the version pass; any missing/stale one is listed", async () => {
    const { dir, configDir } = await seed({
      "bun-linux-x64": fakeBinary("0.3.0"),
      "bun-linux-arm64": fakeBinary("0.2.9"),
    });
    try {
      await withoutPodBinEnv(async () => {
        const p = checkPodBinaries({ configDir, appVersion: "0.3.0" });
        await expect(p).rejects.toBeInstanceOf(PodBinaryError);
        const message = await p.catch((error: Error) => error.message);
        expect(message).toMatch(/arm64 is at version 0\.2\.9/);
        expect(message).not.toMatch(/for x64/); // the good one is not listed
        writeFileSync(configBinPath(configDir, "bun-linux-arm64"), fakeBinary("0.3.0"));
        await checkPodBinaries({ configDir, appVersion: "0.3.0" }); // no throw
        // From source ("dev") it never checks, even with nothing there.
        await checkPodBinaries({ configDir: join(dir, "empty"), appVersion: "dev" });
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dev mode keeps today's order: a marker-less <configDir>/bin binary is still used", async () => {
    const { dir, configDir, cacheDir } = await seed({ "bun-linux-x64": "STABLE-NO-MARKER" });
    try {
      await withoutPodBinEnv(async () => {
        const bytes = await resolvePodBinary("bun-linux-x64", {
          configDir,
          cacheDir,
          appVersion: "dev",
        });
        expect(Buffer.from(bytes).toString()).toBe("STABLE-NO-MARKER");
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("version marker in a real compiled binary (D2)", () => {
  test("buildBinary embeds a marker equal to packages/cli version, read without executing it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-real-"));
    const outfile = join(dir, "tentacle");
    try {
      // Host target: no cross-compile runtime download, no network.
      expect(await buildBinary(outfile, undefined)).toBe(true);
      expect(await readBinaryVersion(outfile)).toBe(cliVersion());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
