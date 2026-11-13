/**
 * `bun run e2e:mobile` (docs/feat/mobile-app-shell.md steps 1-9): the harness
 * every later mobile task merges through. It runs a REAL `serve` against a mock
 * model, boots a simulator, installs a Release build pointed at a strip-origin
 * proxy, drives the Maestro flows and tears everything down in `finally`.
 *
 * Nothing here touches real infra: an own `TENTACLE_CONFIG_DIR` under
 * `.tentacle/tmp/e2e-mobile/<runId>/`, every port ephemeral (read back),
 * `serve` on 127.0.0.1 only, and the mock model is the only provider.
 *
 * Exit codes: 0 = every flow passed; 2 = a prerequisite is missing (named, with
 * its install command — never a silent skip); anything else = Maestro's own.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $, type Subprocess } from "bun";
import { startHooks } from "./hooks.ts";
import {
  type IosMajor,
  REQUIRED_IOS_MAJORS,
  missingText,
  parseRuntimes,
  preflight,
} from "./preflight.ts";
import { startStripOriginProxy } from "./proxy.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const RUNS_DIR = join(REPO, ".tentacle", "tmp", "e2e-mobile");

type Child = Subprocess<"ignore", "inherit", "inherit">;

/** Every child the run started, killed in `finally`. */
const children = new Set<Child>();

/** `--ios 18|26` picks one simulator; default is every required major (Owner Q3). */
export function parseArgs(argv: readonly string[]): { readonly only?: IosMajor } {
  const at = argv.indexOf("--ios");
  if (at === -1) {
    return {};
  }
  const value = argv[at + 1];
  if (value === undefined) {
    throw new Error("--ios needs a value (18 or 26)");
  }
  const major = Number(value);
  if (!REQUIRED_IOS_MAJORS.includes(major as IosMajor)) {
    throw new Error(`--ios must be 18 or 26 (got ${JSON.stringify(value)})`);
  }
  return { only: major as IosMajor };
}

/**
 * Run a version probe and return its output, or undefined when the tool is
 * missing. The FLAG differs per tool — `xcodebuild -version` (it exits 64 on
 * `--version`) — so it is a parameter, not a constant, and each call site names
 * the one its tool needs.
 */
async function versionOf(
  command: string,
  flag: string,
  env?: Record<string, string>,
): Promise<string | undefined> {
  const result = await $`${command} ${flag}`
    .quiet()
    .nothrow()
    .env(env ?? process.env);
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

async function simctlRuntimes(): Promise<string> {
  const result = await $`xcrun simctl list -j runtimes`.quiet().nothrow();
  return result.exitCode === 0 ? result.stdout.toString() : "";
}

async function simctlDevices(): Promise<string> {
  const result = await $`xcrun simctl list -j devices`.quiet().nothrow();
  return result.exitCode === 0 ? result.stdout.toString() : "";
}

/** Maestro needs a JDK; the owner's is keg-only, so the run supplies it. */
export function maestroEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const javaHome = base.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@17";
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, JAVA_HOME: javaHome, PATH: `${javaHome}/bin:${base.PATH ?? ""}` };
}

/** The first booted-or-bootable simulator of an iOS major, by `simctl list -j devices`. */
export function firstDevice(json: string, major: IosMajor): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const devices = (parsed as { devices?: Record<string, unknown> }).devices;
  if (devices === undefined) {
    return undefined;
  }
  for (const [runtime, list] of Object.entries(devices)) {
    if (!runtime.includes(`iOS-${major}-`) || !Array.isArray(list)) {
      continue;
    }
    for (const raw of list) {
      const device = raw as { udid?: unknown; isAvailable?: unknown };
      if (typeof device.udid === "string" && device.isAvailable !== false) {
        return device.udid;
      }
    }
  }
  return undefined;
}

/** A free port, by binding `:0` and reading it back. */
export function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Wait until a TCP port answers (the daemon binds asynchronously). */
export async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open(s) {
            s.end();
          },
        },
      });
      socket.end();
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`nothing listening on 127.0.0.1:${port} after ${timeoutMs}ms`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const [xcode, cocoapods, maestro, runtimesJson, devicesJson] = await Promise.all([
    versionOf("xcodebuild", "-version"),
    versionOf("pod", "--version"),
    // Maestro's launcher needs a JDK BEFORE it can print its version, so the
    // probe carries the same JAVA_HOME/PATH the flows run with.
    versionOf("maestro", "--version", maestroEnv()),
    // Two DIFFERENT listings: runtimes carry the iOS versions, devices carry the
    // simulators to boot (a `devices` key is absent from `-j runtimes`).
    simctlRuntimes(),
    simctlDevices(),
  ]);
  const missing = preflight(
    {
      platform: process.platform,
      runtimes: parseRuntimes(runtimesJson),
      ...(xcode === undefined ? {} : { xcode }),
      ...(cocoapods === undefined ? {} : { cocoapods }),
      ...(maestro === undefined ? {} : { maestro }),
    },
    ...(args.only === undefined ? [] : [args.only]),
  );
  if (missing.length > 0) {
    console.error(missingText(missing));
    return 2;
  }

  const runId = `${Date.now()}`;
  const runDir = join(RUNS_DIR, runId);
  await mkdir(join(runDir, "project"), { recursive: true });
  await mkdir(join(runDir, "config"), { recursive: true });
  console.log(`e2e:mobile run ${runId} → ${runDir}`);

  // The mock model and the proxy run in THIS process: no extra children to reap.
  const { startMockModel } = await import("./mock-model.ts");
  const mock = startMockModel({ holdMs: 120_000 });
  const daemonPort = freePort();
  const proxy = startStripOriginProxy({ upstream: { host: "127.0.0.1", port: daemonPort } });
  await proxy.ready;

  // The real `serve`, from source, on a private config dir and the mock model.
  // Spawned through a function because flow 05 stops it and starts it again on
  // the SAME port and config (serve persists, so the sessions come back).
  const startServe = (): Child => {
    const child = Bun.spawn(
      [
        process.execPath,
        "packages/cli/src/main.ts",
        "serve",
        "--port",
        `${daemonPort}`,
        "--token",
        "e2e-token",
      ],
      {
        cwd: REPO,
        env: {
          ...process.env,
          TENTACLE_CONFIG_DIR: join(runDir, "config"),
          TENTACLE_MODEL_BASE_URL: mock.baseUrl,
          TENTACLE_MODEL: "mock-model",
        },
        stdout: Bun.file(join(runDir, "serve.log")),
        stderr: Bun.file(join(runDir, "serve.err.log")),
      },
    ) as unknown as Child;
    children.add(child);
    return child;
  };
  let serving = startServe();

  try {
    await waitForPort(daemonPort);
    console.log(`serve on 127.0.0.1:${daemonPort}, proxy at ws://${proxy.address}/`);
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({ runId, daemonPort, proxy: proxy.address, mock: mock.baseUrl }, null, 2),
    );

    // Seed the sessions the flows assert on, through the client stack.
    const { addDelta, seedSessions } = await import("./seed.ts");
    const seeded = await seedSessions({
      url: `ws://127.0.0.1:${daemonPort}/`,
      token: "e2e-token",
      holdStarted: () => mock.held(),
    });
    console.log(
      `seeded alpha=${seeded.alphaId} bravo=${seeded.bravoId} charlie=${seeded.charlieId}`,
    );
    await writeFile(join(runDir, "seeded.json"), JSON.stringify(seeded, null, 2));

    // The hooks flow 03/05 call: change the world mid-run (add a session, stop
    // and restart the daemon on the same port).
    const hooks = startHooks({
      actions: {
        addDelta: () => addDelta({ url: `ws://127.0.0.1:${daemonPort}/`, token: "e2e-token" }),
        stopServe: async () => {
          serving.kill();
          await serving.exited;
          children.delete(serving);
        },
        startServe: async () => {
          serving = startServe();
          await waitForPort(daemonPort);
        },
      },
    });
    await hooks.ready;

    // Every flow, on each simulator this run covers.
    const majors: readonly IosMajor[] = args.only === undefined ? REQUIRED_IOS_MAJORS : [args.only];
    const flows = `${REPO}/apps/mobile/e2e/flows`;
    let worst = 0;
    for (const major of majors) {
      const device = firstDevice(devicesJson, major);
      if (device === undefined) {
        console.error(`no available iOS ${major} simulator (preflight passed: check simctl)`);
        return 2;
      }
      console.log(`\n=== iOS ${major} (${device}) ===`);
      const buildCode = await buildAndInstall(device, proxy.address, runDir, major);
      if (buildCode !== 0) {
        console.error(`build/install failed for iOS ${major} (exit ${buildCode})`);
        return buildCode;
      }
      for (const flow of [
        "01-shell",
        "02-session-list",
        "03-refresh",
        "04-session-placeholder",
        "05-daemon-down",
      ]) {
        const outDir = join(runDir, `ios${major}`, flow);
        await mkdir(outDir, { recursive: true });
        const code = await spawnFlow(
          `${flows}/${flow}.yaml`,
          device,
          outDir,
          runDir,
          seeded,
          hooks.address,
        );
        worst = Math.max(worst, code);
        if (code !== 0) {
          console.error(`✗ ${flow} (iOS ${major}) exit ${code}`);
        } else {
          console.log(`✓ ${flow} (iOS ${major})`);
        }
      }
    }
    await hooks.stop();
    await seeded.close();
    console.log(`\n${worst === 0 ? "PASS" : "FAIL"} — logs in ${runDir}`);
    return worst;
  } finally {
    for (const child of children) {
      child.kill();
    }
    children.clear();
    await proxy.stop();
    mock.stop();
  }
}

/**
 * Build the app Release and install it on `device`, with the dev computer's URL
 * baked in: `EXPO_PUBLIC_*` is inlined by Expo at BUILD time, so the proxy's
 * address is an input to the build, not a runtime setting.
 *
 * `--no-bundler` and the workspace's own `expo` binary: Release bundles the JS
 * itself, and `bunx expo` would fetch an out-of-tree copy (seen in Step 0).
 */
async function buildAndInstall(
  device: string,
  proxyAddress: string,
  runDir: string,
  major: IosMajor,
): Promise<number> {
  const env: Record<string, string> = {
    ...maestroEnv(),
    CI: "1",
    EXPO_PUBLIC_TENTACLE_URL: `ws://${proxyAddress}/`,
    EXPO_PUBLIC_TENTACLE_TOKEN: "e2e-token",
    EXPO_PUBLIC_TENTACLE_NAME: "e2e-mac",
  };
  // `ios/` is generated (CNG) and gitignored, so a fresh checkout has none, and
  // a stale one carries the OLD bundle id and deployment target: prebuild first,
  // every run. It is idempotent and writes only the config `app.json` names.
  const prebuild = Bun.spawn(
    ["./node_modules/.bin/expo", "prebuild", "--platform", "ios", "--no-install"],
    {
      cwd: join(REPO, "apps", "mobile"),
      env,
      stdout: Bun.file(join(runDir, `prebuild-ios${major}.log`)),
      stderr: Bun.file(join(runDir, `prebuild-ios${major}.err.log`)),
    },
  ) as unknown as Child;
  children.add(prebuild);
  const prebuildCode = await prebuild.exited;
  children.delete(prebuild);
  if (prebuildCode !== 0) {
    return prebuildCode;
  }
  const child = Bun.spawn(
    [
      "./node_modules/.bin/expo",
      "run:ios",
      "--configuration",
      "Release",
      "--device",
      device,
      "--no-bundler",
    ],
    {
      cwd: join(REPO, "apps", "mobile"),
      env,
      stdout: Bun.file(join(runDir, `build-ios${major}.log`)),
      stderr: Bun.file(join(runDir, `build-ios${major}.err.log`)),
    },
  ) as unknown as Child;
  children.add(child);
  const code = await child.exited;
  children.delete(child);
  return code;
}

/** Maestro's `-e K=V` flags, from a map (its `${VAR}` substitution reads these). */
export function envFlags(values: Record<string, string>): string[] {
  return Object.entries(values).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

/** Run one flow on one simulator with Maestro, returning its exit code. */
async function spawnFlow(
  flow: string,
  device: string,
  outDir: string,
  runDir: string,
  seeded: { readonly alphaId: string; readonly bravoId: string; readonly charlieId: string },
  hooks: string,
): Promise<number> {
  const child = Bun.spawn(
    [
      "maestro",
      "--device",
      device,
      "test",
      // Maestro's OWN env flags (`-e K=V`): its `${VAR}` substitution reads
      // these, NOT the process environment (a shell export is invisible to it).
      ...envFlags({
        ALPHA_ID: seeded.alphaId,
        BRAVO_ID: seeded.bravoId,
        CHARLIE_ID: seeded.charlieId,
        MAESTRO_HOOKS: hooks,
      }),
      flow,
      "--format",
      "JUNIT",
      "--output",
      join(outDir, "junit.xml"),
      "--test-output-dir",
      outDir,
    ],
    {
      cwd: REPO,
      env: { ...maestroEnv(), RUN_DIR: runDir },
      stdout: Bun.file(join(outDir, "maestro.log")),
      stderr: Bun.file(join(outDir, "maestro.err.log")),
    },
  ) as unknown as Child;
  children.add(child);
  const code = await child.exited;
  children.delete(child);
  return code;
}

if (import.meta.main) {
  const code = await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(code);
}
