/**
 * `bun run e2e:mobile` (docs/feat/mobile-app-shell.md steps 1-9; the `/e2e` dial
 * is docs/feat/mobile-pairing-screen.md 11b.1): the harness every later mobile
 * task merges through. It runs a REAL `serve` against a mock model and a real
 * `tentacle pair` in-process, boots a simulator, installs a Release build (the
 * SHIPPABLE one: no build-time computer, no token), drives the Maestro flows —
 * every one of which PAIRS the phone over `/e2e` first — and tears everything
 * down in `finally`.
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
import { createPairingHooks } from "./pairing.ts";
import {
  type IosMajor,
  REQUIRED_IOS_MAJORS,
  missingText,
  parseRuntimes,
  preflight,
} from "./preflight.ts";

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

  // The mock model runs in THIS process: no extra children to reap.
  const { startMockModel } = await import("./mock-model.ts");
  const mock = startMockModel({ holdMs: 120_000 });
  const daemonPort = freePort();

  // The real `serve`, from source, on a private config dir and the mock model.
  // Spawned through a function because flow 05 stops it and starts it again on
  // the SAME port and config (serve persists, so the sessions come back).
  const startServe = (): Child => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(REPO, "packages", "cli", "src", "main.ts"),
        "serve",
        "--port",
        `${daemonPort}`,
        "--token",
        "e2e-token",
      ],
      {
        // The daemon's cwd IS its session cwd (each session's tools are confined
        // to it), so it is the run's scratch dir — `project/<file>` (the mock
        // model's `EDIT` prompts) lands there and never in the repo.
        cwd: runDir,
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
    // The address the PHONE dials: the daemon's own `/e2e` route, no proxy in
    // between (11b.1 step 5). Loopback contributes nothing to a QR (task 9), so
    // `pair` is given it explicitly.
    const deviceAddress = `ws://127.0.0.1:${daemonPort}/e2e`;
    console.log(`serve on 127.0.0.1:${daemonPort}, phone address ${deviceAddress}`);
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({ runId, daemonPort, deviceAddress, mock: mock.baseUrl }, null, 2),
    );
    // `tentacle pair` in-process (P6): a pipe has no TTY, so the harness answers
    // the `[y/N]`. One window at a time (F-H3).
    const pairing = createPairingHooks({
      configDir: join(runDir, "config"),
      address: deviceAddress,
      log: (line) => console.log(line),
    });

    // Seed the sessions the flows assert on, through the client stack.
    const { addDelta, seedSessions, laptopLink, sessionStateOf, historyOf, fileExists } =
      await import("./seed.ts");
    const endpoint = { url: `ws://127.0.0.1:${daemonPort}/`, token: "e2e-token" };
    const seeded = await seedSessions({
      ...endpoint,
      cwd: runDir,
      holdStarted: () => mock.held(),
    });
    // The LAPTOP's own client for the flows' mid-run turns and answers: it stays
    // attached, so `attached` counts it (12c flows 09/10).
    const laptop = await laptopLink(endpoint);
    console.log(
      `seeded alpha=${seeded.alphaId} bravo=${seeded.bravoId} charlie=${seeded.charlieId} asks=${seeded.askIds.join(",")}`,
    );
    await writeFile(join(runDir, "seeded.json"), JSON.stringify(seeded, null, 2));

    // The hooks flow 03/05 call: change the world mid-run (add a session, stop
    // and restart the daemon on the same port).
    const hooks = startHooks({
      actions: {
        addDelta: () => addDelta(endpoint),
        stopServe: async () => {
          serving.kill();
          await serving.exited;
          children.delete(serving);
        },
        startServe: async () => {
          serving = startServe();
          await waitForPort(daemonPort);
        },
        laptopPrompt: (session, prompt, answer) => laptop.prompt(session, prompt, answer),
        laptopAnswer: (session, answer) => laptop.answer(session, answer),
        sessionState: (session) => sessionStateOf(endpoint, session),
        history: (session) => historyOf(endpoint, session),
        fileExists: (file) => fileExists({ cwd: runDir }, file),
        modelPrompts: () => mock.prompts,
        modelReplies: () => mock.replies,
        editCalls: () => mock.calls,
        pairStart: async (options) => {
          const started = await pairing.start(options);
          return { payload: started.payload, computerId: started.computerId };
        },
        pairConfirm: () => pairing.confirm(),
        pairAnswer: (value) => pairing.answer(value),
        pairRevoke: (name) => pairing.revoke(name),
        pairReset: () => pairing.reset(),
        pairClaimed: () => pairing.claimed(),
        pairDeviceId: () => pairing.lastDeviceId(),
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
      const buildCode = await buildAndInstall(device, runDir, major);
      if (buildCode !== 0) {
        console.error(`build/install failed for iOS ${major} (exit ${buildCode})`);
        return buildCode;
      }
      for (const flow of FLOWS) {
        // Each flow gets its own pairing scope. "One window at a time" (F-H3) is
        // a rule INSIDE a flow: a flow that failed between `pair-start` and its
        // answer leaves a window open, and the next flow's `pair-start` would be
        // refused — a red cascade with a single cause (found by the iOS 26 run:
        // `14-pair-bad-text` leaves its window unclaimed, and 15–17 all failed
        // before their first assertion). Teardown answers a waiting `ask` with
        // `n`, so nothing is ever silently registered.
        await pairing.stop();
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
    await pairing.stop();
    await hooks.stop();
    await seeded.close();
    console.log(`\n${worst === 0 ? "PASS" : "FAIL"} — logs in ${runDir}`);
    return worst;
  } finally {
    for (const child of children) {
      child.kill();
    }
    children.clear();
    mock.stop();
  }
}

/**
 * Build the app Release and install it on `device` — the SHIPPABLE build: no
 * `EXPO_PUBLIC_TENTACLE_*` exists any more (11b.1 deleted the dev source, and a
 * guard test pins that the app's sources never read one), so the phone is paired
 * at RUN time by a flow, not baked in at build time.
 *
 * `--no-bundler` and the workspace's own `expo` binary: Release bundles the JS
 * itself, and `bunx expo` would fetch an out-of-tree copy (seen in Step 0).
 */
async function buildAndInstall(device: string, runDir: string, major: IosMajor): Promise<number> {
  const env: Record<string, string> = {
    ...maestroEnv(),
    CI: "1",
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

/**
 * Every flow, in order (docs/feat/mobile-session-view.md 12c supersedes 11a's
 * `04-session-placeholder`: the placeholder is gone, so its flow is deleted and
 * `06-session-open` asserts the real screen). Each one starts with
 * `clearState: true`, so their order carries no state.
 */
export const FLOWS: readonly string[] = [
  // Every flow PAIRS the phone first (`_pair`: 11b.1 — the app has no build-time
  // computer, so nothing can be shown before a real pairing).
  "01-shell",
  "02-session-list",
  "03-refresh",
  "05-daemon-down",
  // 11b.1's own, before 12c's: the pairing paths a person hits first (a refusal,
  // an expired code, a refused paste, a revoke, a remove, a relaunch).
  "12-pair-declined",
  "13-pair-expired",
  "14-pair-bad-text",
  "15-revoked",
  "16-remove-computer",
  "17-persisted",
  // 12c's session screens.
  "06-session-open",
  "07-prompt",
  "08-permission",
  "08b-permission-deny",
  "08c-permission-reply",
  "09-foreign-turn",
  "10-background-ask",
  "11-disconnect-mid-turn",
];

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
  seeded: {
    readonly alphaId: string;
    readonly bravoId: string;
    readonly charlieId: string;
    readonly askIds: readonly string[];
  },
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
        // One session per permission flow: an ask is daemon-side state that
        // outlives a flow's `clearState`, so a shared session would leak a
        // pending sheet into the next flow (found by the iOS 26 run).
        ASK1_ID: seeded.askIds[0] ?? "",
        ASK2_ID: seeded.askIds[1] ?? "",
        ASK3_ID: seeded.askIds[2] ?? "",
        ASK4_ID: seeded.askIds[3] ?? "",
        ASK5_ID: seeded.askIds[4] ?? "",
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
