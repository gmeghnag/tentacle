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
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  // The MOBILE RELAY, locally (docs/feat/mobile-relay.md R6: "dev and tests run
  // the relay locally"). In-process, on its own ephemeral port, no TLS — the
  // daemon accepts `ws://` to a loopback host (`isRelayUrl`), and `serve` is
  // pointed at it with `--relay`.
  // Relative, not `@tentacle/relay`: the app does not (and must not) depend on
  // the deployable service — the harness imports it across apps, like the
  // daemon's own relay tests do (`packages/daemon/test/relay-link.test.ts`).
  const { startRelay } = await import("../../relay/src/server.ts");
  const relay = startRelay({ host: "127.0.0.1", port: 0, onLog: () => {} });
  const relayUrl = relay.url;
  console.log(`relay on ${relayUrl}`);

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
        // The relay is ON for every flow, pointed at the LOCAL relay above: a
        // harness must never reach relay.tentacle.so (no real infra), and flow
        // 22's whole subject is the relay path.
        "--relay",
        relayUrl,
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
    const {
      addDelta,
      seedSessions,
      laptopLink,
      sessionStateOf,
      historyOf,
      queueStateOf,
      composeSessionOf,
      fileExists,
    } = await import("./seed.ts");
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
    // The app lock's hooks (docs/feat/mobile-lock.md Step 0): the flows drive
    // Face ID and read the app's OWN log file, so the assertions are about what
    // the app really wrote — not about what the harness believes it wrote.
    // `currentDevice` is what the flow is running on RIGHT NOW (the loop below
    // boots one simulator per iOS major, and these hooks follow it).
    const currentDevice = { udid: "" };
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
        queueState: (session) => queueStateOf(endpoint, session),
        laptopEnqueue: (session, text) => laptop.enqueue(session, text),
        laptopCancel: (session) => laptop.cancel(session),
        laptopDetach: (session) => laptop.detach(session),
        fileExists: (file) => fileExists({ cwd: runDir }, file),
        modelPrompts: () => mock.prompts,
        modelReplies: () => mock.replies,
        editCalls: () => mock.calls,
        pairStart: async (options) => {
          // Flow 22 (`ttlMs=-1`, its flag for "the relay-only case") opens its
          // window WITHOUT the harness's own `--address`: `serve` here binds
          // LOOPBACK, which contributes no bind-derived address to a QR
          // (`pair-addresses.ts`), so the record's relay address is the only one
          // a phone can dial — the zero-configuration case the relay exists for,
          // and the one R5b made pairable at all. Every other flow keeps the
          // loopback address so it can be driven from the simulator directly.
          const relayOnly = options.ttlMs === -1;
          const started = relayOnly
            ? await pairing.startRelayOnly()
            : await pairing.start(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs });
          return { payload: started.payload, computerId: started.computerId, relayOnly };
        },
        pairConfirm: () => pairing.confirm(),
        pairAnswer: (value) => pairing.answer(value),
        pairRevoke: (name) => pairing.revoke(name),
        pairReset: () => pairing.reset(),
        pairClaimed: () => pairing.claimed(),
        pairDeviceId: () => pairing.lastDeviceId(),
        // Flow 22's daemon truth (docs/feat/mobile-relay.md R6): what the pairing
        // payload ACTUALLY carried. The phone can only show "1 address"; whether
        // that address is the relay is what the flow is about.
        relayQr: async () => ({ payload: pairing.lastPayload() }),
        faceIdEnroll: async () => {
          // Two commits, as Step 0 found: the `-s` alone only SETS the default;
          // the `-p` post is what makes `isEnrolledAsync()` flip to true.
          await simctl(currentDevice.udid, [
            "notifyutil",
            "-s",
            "com.apple.BiometricKit.enrollmentChanged",
            "1",
          ]);
          await simctl(currentDevice.udid, [
            "notifyutil",
            "-p",
            "com.apple.BiometricKit.enrollmentChanged",
          ]);
        },
        faceIdMatch: async () => {
          await simctl(currentDevice.udid, [
            "notifyutil",
            "-p",
            "com.apple.BiometricKit_Sim.pearl.match",
          ]);
        },
        faceIdNoMatch: async () => {
          // A REAL DEVICE item (Step 0: the simulator's nomatch leaves the
          // promise unresolved, so no flow may depend on it). The hook exists so
          // the checklist has one command, and it says so if it cannot run.
          await simctl(currentDevice.udid, [
            "notifyutil",
            "-p",
            "com.apple.BiometricKit_Sim.pearl.nomatch",
          ]);
        },
        logFile: () => appLogFile(currentDevice.udid),
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
      currentDevice.udid = device;
      // 13d's flow 18 needs photos in the simulator's library: `addmedia` seeds a
      // PNG and a JPEG (fixtures, never real photos — the harness owns them under
      // its own scratch dir).
      const mediaCode = await addMedia(device, runDir);
      if (mediaCode !== 0) {
        console.error(`addmedia failed for iOS ${major} (exit ${mediaCode})`);
        return mediaCode;
      }
      const buildCode = await buildAndInstall(device, runDir, major);
      if (buildCode !== 0) {
        console.error(`build/install failed for iOS ${major} (exit ${buildCode})`);
        return buildCode;
      }
      for (const flow of selectedFlows()) {
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
          () => composeSessionOf(endpoint),
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
    // The local relay is in THIS process, so it needs an explicit stop (a live
    // server keeps the event loop, and therefore the run, alive).
    relay.stop();
  }
}

/**
 * `xcrun simctl` on the device the flows are running on, output discarded (the
 * callers are fire-and-forget notifications). Rejects on a non-zero exit so a
 * broken command shows up as a red flow, not a silent no-op.
 */
async function simctl(udid: string, args: readonly string[]): Promise<void> {
  if (udid === "") {
    throw new Error("no simulator selected yet");
  }
  const child = Bun.spawn(["xcrun", "simctl", "spawn", udid, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  if (code !== 0) {
    const err = await new Response(child.stderr).text();
    throw new Error(`simctl ${args.join(" ")} failed (${code}): ${err.trim()}`);
  }
}

/**
 * The app's OWN log file, read out of its data container (docs/feat/mobile-lock.md
 * D7). Flow 09 asserts on THIS text: the canaries are about what the app wrote,
 * not about what the harness thinks it wrote.
 *
 * `Library/` under the data container is where `Paths.document` lands on iOS.
 */
async function appLogFile(udid: string): Promise<string> {
  if (udid === "") {
    return "";
  }
  const container = Bun.spawnSync(
    ["xcrun", "simctl", "get_app_container", udid, "so.tentacle.app", "data"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const dir = container.stdout.toString().trim();
  if (container.exitCode !== 0 || dir === "") {
    return "";
  }
  // `Paths.document` on iOS is `<container>/Documents`; the app names the file
  // `tentacle-log.txt` (`app-log-fs-expo.ts`).
  for (const candidate of [
    join(dir, "Documents", "tentacle-log.txt"),
    join(dir, "Documents", "tentacle-log.1.txt"),
  ]) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // Try the next one; a missing file is "" (the flow asserts on its content).
    }
  }
  return "";
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
 * Seed the simulator's photo library with the flow 18 fixtures (`PNG fixture`,
 * `JPEG fixture` — the NAMES are what PHPicker shows, so a flow can tap them). The
 * fixtures are generated per run under the harness's scratch dir: never real
 * photos, and nothing under `/tmp` (AGENTS §6).
 */
async function addMedia(device: string, runDir: string): Promise<number> {
  const dir = join(runDir, "media");
  await mkdir(dir, { recursive: true });
  // A minimal valid PNG (1×1) and JPEG (1×1): the types are what matters here — the
  // daemon sniffs the BYTES, and `attachment/put` only carries them.
  const png = join(dir, "PNG fixture.png");
  const jpeg = join(dir, "JPEG fixture.jpg");
  await Bun.write(
    png,
    Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    ),
  );
  await Bun.write(
    jpeg,
    Uint8Array.from(
      atob(
        "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
      ),
      (c) => c.charCodeAt(0),
    ),
  );
  // `addmedia` needs the device BOOTED and past its launch state: right after a
  // reboot the import fails with LaunchdSimError 133 (how the first attempt died).
  await $`xcrun simctl bootstatus ${device} -b`.quiet().nothrow();
  const result = await $`xcrun simctl addmedia ${device} ${png} ${jpeg}`.quiet().nothrow();
  return result.exitCode;
}

/** A session handle resolved through the client's own session table (for a subscription). */
/**
 * Every flow, in order (docs/feat/mobile-session-view.md 12c supersedes 11a's
 * `04-session-placeholder`; docs/feat/mobile-compose.md 13d adds `12`–`18`). Each
 * one starts with `clearState: true`, so their order carries no state — and each
 * compose flow has its OWN seeded session, because a queued or returned row is
 * daemon-side state that `clearState` cannot clear.
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
  // 11b.2's own (camera + deep link): both need a real pairing window, and both
  // assert a path a person can take instead of a paste.
  "18-camera-denied",
  "19-deep-link",
  // Fix round 1 (finding 1): a granted Scan tap's preview can be CLOSED, and it
  // never outlives the intake.
  "20-camera-close",
  // 12c's session screens.
  "06-session-open",
  "07-prompt",
  "08-permission",
  "08b-permission-deny",
  "08c-permission-reply",
  "09-foreign-turn",
  "10-background-ask",
  "11-disconnect-mid-turn",
  // 13d's compose screen: steering, send-now, returned rows, the offline outbox,
  // a changed outbox and photos.
  "12-steer",
  "13-send-now",
  "14-returned-mine",
  "15-returned-other",
  "16-offline-outbox",
  "17-outbox-changed",
  "18-photos",
  // docs/feat/mobile-ui-polish.md Slice 0: the composer above the keyboard (B1)
  // and Return sends (B2), on a session of its own.
  "23-composer-keyboard",
  // docs/feat/mobile-lock.md: the lock and the log export. LAST, because these
  // are the only flows that CHANGE the lock setting (they leave `immediately`
  // behind in the Keychain, which `clearKeychain` in `_pair` resets anyway).
  "18-lock-cold-start",
  "19-lock-unlock-button",
  "20-lock-immediately",
  "21-export-logs",
  // docs/feat/mobile-relay.md R6: the relay-only pairing + session. LAST of all,
  // because it is the only flow that pairs over a record with no direct address
  // (the harness restarts `serve` for its window), and a failure there must not
  // colour the flows whose daemon is the shared one.
  "22-relay-only",
];

/**
 * The flows this run drives. `E2E_ONLY_FLOWS` (comma-separated names) narrows them:
 * a long run degrades the simulator (every flow starts its own XCTest driver), so a
 * single flow is how one is debugged or re-proved in a bounded window. Empty or
 * absent: every flow, which is the gate.
 */
export function selectedFlows(
  only: string | undefined = process.env.E2E_ONLY_FLOWS,
): readonly string[] {
  const wanted = (only ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (wanted.length === 0) {
    return FLOWS;
  }
  for (const name of wanted) {
    if (!FLOWS.includes(name)) {
      throw new Error(`E2E_ONLY_FLOWS names an unknown flow: ${name}`);
    }
  }
  return wanted;
}

/** Maestro's `-e K=V` flags, from a map (its `${VAR}` substitution reads these). */ export function envFlags(
  values: Record<string, string>,
): string[] {
  return Object.entries(values).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

/** The env var each 13d flow's own session id is passed as (one session per flow). */
const COMPOSE_SESSION_VARS: Readonly<Record<string, string>> = {
  "12-steer": "STEER_ID",
  "13-send-now": "SENDNOW_ID",
  "14-returned-mine": "RETURNED_ID",
  "15-returned-other": "OTHER_ID",
  "16-offline-outbox": "OUTBOX_ID",
  "17-outbox-changed": "CHANGED_ID",
  "18-photos": "PHOTO_ID",
  "23-composer-keyboard": "KEYBOARD_ID",
};

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
  /** Create one compose session on demand (the harness's own client). */
  newComposeSession: () => Promise<string>,
): Promise<number> {
  // A 13d compose flow gets a session of its OWN, created JUST BEFORE it runs: a
  // queued or returned row is daemon-side state that outlives `clearState`, and
  // seeding all of them up front pushed the earlier flows' rows off the visible
  // list (found by the first iOS 26 run: flows 02/05/06/07/08 failed).
  // `flow` is the yaml PATH: the map is keyed by the flow's name.
  const compose =
    COMPOSE_SESSION_VARS[
      flow
        .split("/")
        .pop()
        ?.replace(/\.yaml$/, "") ?? ""
    ];
  const fresh = compose === undefined ? {} : { [compose]: await newComposeSession() };
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
        ...fresh,
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
