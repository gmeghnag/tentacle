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
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RemoteClient, webSocketChannelFactory } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import { writePushRegistration as daemonWritePushRegistration } from "@tentacle/daemon";
import { encodeBase64Url } from "@tentacle/protocol";
import { publicKeyOf } from "@tentacle/transport/noise";
import { $, type Subprocess } from "bun";
import { createApnsClient } from "../../relay/src/apns-client.ts";
import type { ApnsJwtSource } from "../../relay/src/apns.ts";
import { type ProbeListener, escapeFixture, startProbeListener } from "./escape-probes.ts";
import {
  type AttemptStatus,
  type FlowMeta,
  type FlowResult,
  deviceChoice,
  finalStatus,
  flowMetaErrors,
  parseFlowMeta,
  shouldRetry,
  summaryText,
  verdictOf,
} from "./gate.ts";
import { startHooks } from "./hooks.ts";
import { payloadFor, sealPushMessage } from "./notify-steps.ts";
import { createPairingHooks } from "./pairing.ts";
import {
  type IosMajor,
  REQUIRED_IOS_MAJORS,
  missingText,
  parseRuntimes,
  preflight,
} from "./preflight.ts";
import { type ApnsPayload, type PushSteps, createPushSteps } from "./push-steps.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const RUNS_DIR = join(REPO, ".tentacle", "tmp", "e2e-mobile");

type Child = Subprocess<"ignore", "inherit", "inherit">;

/** Every child the run started, killed in `finally`. */
const children = new Set<Child>();

/**
 * `--ios 18|26` picks one simulator; default is every required major (Owner Q3).
 * `--only a,b` narrows the flows, like `E2E_ONLY_FLOWS` (the flag wins); it exists
 * because some shells refuse an env-prefixed command. Names are checked by
 * `selectedFlows`. `--udid X` is `E2E_SIM_UDID`'s flag form (`firstDevice`'s
 * `prefer`), for the same reason.
 */
export function parseArgs(argv: readonly string[]): {
  readonly only?: IosMajor;
  readonly flows?: string;
  readonly udid?: string;
  readonly hold?: true;
  readonly app?: string;
  readonly flowTimeoutS?: number;
} {
  // `--app <path.app>`: install THIS simulator build instead of building one
  // (docs/feat/mobile-e2e-gate.md) — still a clean reinstall, once per run.
  const appAt = argv.indexOf("--app");
  let app: string | undefined;
  if (appAt !== -1) {
    const value = argv[appAt + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--app needs a value (a simulator .app path)");
    }
    app = value;
  }
  // `--flow-timeout <s>`: one attempt of one flow is killed after this long.
  const timeoutAt = argv.indexOf("--flow-timeout");
  let flowTimeoutS: number | undefined;
  if (timeoutAt !== -1) {
    const value = Number(argv[timeoutAt + 1]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("--flow-timeout needs a positive number of seconds");
    }
    flowTimeoutS = value;
  }
  const udidAt = argv.indexOf("--udid");
  let udid: string | undefined;
  if (udidAt !== -1) {
    const value = argv[udidAt + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--udid needs a value (a simulator udid)");
    }
    udid = value;
  }
  const flowsAt = argv.indexOf("--only");
  let flows: string | undefined;
  if (flowsAt !== -1) {
    const value = argv[flowsAt + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--only needs a value (comma-separated flow names)");
    }
    flows = value;
  }
  // `--hold`: the env-free form of `E2E_HOLD=1` (`--udid` is `E2E_SIM_UDID`'s).
  const withFlows = {
    ...(flows === undefined ? {} : { flows }),
    ...(udid === undefined ? {} : { udid }),
    ...(argv.includes("--hold") ? { hold: true as const } : {}),
    ...(app === undefined ? {} : { app }),
    ...(flowTimeoutS === undefined ? {} : { flowTimeoutS }),
  };
  const at = argv.indexOf("--ios");
  if (at === -1) {
    return withFlows;
  }
  const value = argv[at + 1];
  if (value === undefined) {
    throw new Error("--ios needs a value (18 or 26)");
  }
  const major = Number(value);
  if (!REQUIRED_IOS_MAJORS.includes(major as IosMajor)) {
    throw new Error(`--ios must be 18 or 26 (got ${JSON.stringify(value)})`);
  }
  return { only: major as IosMajor, ...withFlows };
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

/**
 * The harness `serve`'s `config.jsonc`. `model.images` has no env var and an
 * OpenAI-shaped endpoint (the mock) defaults to no vision, so without this the
 * daemon refuses every photo `images_off` and flow 18 can never pass.
 */
export function harnessConfigText(): string {
  return `${JSON.stringify(
    {
      model: { images: true },
      // docs/feat/mobile-session-info.md flow 25: one working stdio server and one
      // that cannot start, so Session info has a `connected` row with tools AND a
      // `failed` row with an error. MCP connects OFF the start path, so this costs
      // the other flows nothing (F12: measured at flow 01).
      mcpServers: {
        demo: {
          command: "bun",
          args: [
            join(REPO, "packages", "mcp", "test", "fixtures", "strict-legacy-stdio-server.ts"),
          ],
        },
        broken: { command: "/nonexistent-tentacle-e2e" },
      },
    },
    null,
    2,
  )}\n`;
}

/** The user-scope skill flow 25 asserts on (`<configDir>/skills` is a scan root). */
export const HARNESS_SKILL_NAME = "e2e-demo";

/** Write the skill the Session info flow lists (name + one line). */
export async function writeHarnessSkill(configDir: string): Promise<void> {
  const dir = join(configDir, "skills", HARNESS_SKILL_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${HARNESS_SKILL_NAME}`,
      "description: A demo skill the Session info flow lists",
      "---",
      "",
      "Do the demo.",
      "",
    ].join("\n"),
  );
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

/**
 * The first booted-or-bootable simulator of an iOS major, by `simctl list -j devices`.
 * `prefer` (`E2E_SIM_UDID`) picks a dedicated simulator instead, so a run never
 * drives the one someone is using — only when it is an available device of that
 * major; otherwise the first one still wins.
 */
export function firstDevice(json: string, major: IosMajor, prefer?: string): string | undefined {
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
    const usable = list
      .map((raw) => raw as { udid?: unknown; isAvailable?: unknown })
      .filter((device) => typeof device.udid === "string" && device.isAvailable !== false)
      .map((device) => device.udid as string);
    const chosen = usable.find((udid) => udid === prefer) ?? usable[0];
    if (chosen !== undefined) {
      return chosen;
    }
  }
  return undefined;
}

/** A free port, by binding `:0` and reading it back. */
export function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  // 4000 is the owner's own `serve` (docs/feat/mobile-e2e-gate.md): an ephemeral
  // port never lands there on macOS, but a gate must not even be able to.
  return port === OWNER_SERVE_PORT ? freePort() : port;
}

/** The port a person's own `serve` listens on; the harness never takes it. */
export const OWNER_SERVE_PORT = 4000;

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
  // Checked before any build, so a typo fails in a second, not after one.
  const runFlows = selectedFlows(args.flows);
  // The gate's tags (docs/feat/mobile-e2e-gate.md), read from each flow's own
  // header; a tag without its reason is refused before anything runs.
  const metas = flowMetas(runFlows);
  const metaErrors = [...metas.values()].flatMap(flowMetaErrors);
  if (metaErrors.length > 0) {
    console.error(metaErrors.join("\n"));
    return 2;
  }
  const udid = args.udid ?? process.env.E2E_SIM_UDID;
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
  // A UDID names ONE simulator, so it names the major too: the gate runs that
  // simulator only (the other required runtime need not be installed), and
  // never falls back to another device — a run must not drive one it was not
  // given (parallel agents each own one). `--ios N --udid X` is checked the same
  // way: X must BE an iOS N device (docs/feat/mobile-e2e-gate.md, review F2).
  const choice = deviceChoice(devicesJson, udid, args.only);
  if (choice.kind === "unknown") {
    console.error(choice.message);
    return 2;
  }
  const only: IosMajor | undefined = choice.kind === "device" ? choice.major : choice.only;
  const missing = preflight(
    {
      platform: process.platform,
      runtimes: parseRuntimes(runtimesJson),
      ...(xcode === undefined ? {} : { xcode }),
      ...(cocoapods === undefined ? {} : { cocoapods }),
      ...(maestro === undefined ? {} : { maestro }),
    },
    ...(only === undefined ? [] : [only]),
  );
  if (missing.length > 0) {
    console.error(missingText(missing));
    return 2;
  }

  // The Notification Service Extension's Swift logic, against the SAME vectors
  // the TypeScript side is pinned by (docs/feat/mobile-notifications.md N5,
  // decision 20). Run here, before any build: it takes seconds and it is the only
  // gate that exercises the extension's crypto (`swift test`, macOS only).
  const swiftTests = Bun.spawnSync(["bun", "run", "test:swift"], {
    cwd: REPO,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (swiftTests.exitCode !== 0) {
    console.error("e2e:mobile: `bun run test:swift` failed (the NSE's PushCore suite)");
    return 2;
  }

  const runId = `${Date.now()}`;
  const runDir = join(RUNS_DIR, runId);
  await mkdir(join(runDir, "project"), { recursive: true });
  await mkdir(join(runDir, "config"), { recursive: true });
  console.log(`e2e:mobile run ${runId} → ${runDir}`);

  // The escape suite's listener (docs/feat/model-artifacts.md T8.1, flow 30): the
  // ONLY thing that can say whether a hostile artifact reached the network.
  // Started for every run (it is inert until a page loads) so the hook is always
  // answerable and flow 30 needs no special case.
  const probes: ProbeListener = startProbeListener();
  // Flow 30's artifact: the hostile fixture with the placeholder replaced by this
  // run's listener. A WORKSPACE file, because `present` reads `path` through the
  // confined reader (D3) — the fixture on disk stays port-free.
  await writeFile(
    join(runDir, "project", "escape.html"),
    escapeFixture(
      await readFile(join(REPO, "apps", "mobile", "e2e", "fixtures", "escape.html"), "utf8"),
      probes.url,
    ),
  );
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
  // The LOCAL APNs (docs/feat/mobile-push.md P10). P8's own fake, moved here:
  // an h2c server that records every request body. It is what makes the flow's
  // payload REAL rather than hand-written — the bytes `xcrun simctl push` gets
  // are the ones the daemon's sealing chain produced, through the relay, from a
  // device registration the phone just made.
  const apns = await startFakeApns();
  const relay = startRelay({
    host: "127.0.0.1",
    port: 0,
    onLog: () => {},
    // With an APNs client the relay announces `features: ["push"]`, which is the
    // ONLY thing that makes the daemon send a `push` frame (C1/F4). Without it
    // every flow would still pass and push would never be exercised at all.
    apns: {
      client: createApnsClient({
        topic: "so.tentacle.app",
        jwtSource: apns.jwtSource,
        origins: { sandbox: apns.origin, production: apns.origin },
      }),
      jwtSource: apns.jwtSource,
      topic: "so.tentacle.app",
    },
  });
  const relayUrl = relay.url;
  console.log(`relay on ${relayUrl}, fake APNs on ${apns.origin}`);

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
        // P10: an ask pushes IMMEDIATELY, so the push flow does not sit out the
        // 30 s default. Every other flow is untouched by it: none registers a
        // push key, and with no registration there is nothing to push to.
        "--push-grace",
        "0",
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
  // Images ON before the first start (flow 18): serve keeps an existing file.
  await mkdir(join(runDir, "config"), { recursive: true });
  await writeFile(join(runDir, "config", "config.jsonc"), harnessConfigText());
  // Session info's skill row (flow 25): a user-scope skill in the harness config dir.
  await writeHarnessSkill(join(runDir, "config"));
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
      capabilitiesOf,
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

    // docs/feat/mobile-push.md P10: register a push key for the paired device,
    // make the daemon push one (an ask, `--push-grace 0`), and place the
    // envelope it produced on the simulator.
    const pushSteps = harnessPushSteps({
      url: `ws://127.0.0.1:${daemonPort}/`,
      configDir: join(runDir, "config"),
      apns,
      pairDeviceId: () => pairing.lastDeviceId(),
      udid: () => currentDevice.udid,
      log: (line) => console.log(line),
    });
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
        capabilities: (session) => capabilitiesOf(endpoint, session),
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
        // docs/feat/mobile-push.md P10: the push the `push-placeholder` flow
        // places. `pushSteps.push` (below) pushed it through the daemon's own
        // chain and kept the payload, so the flow's last step reads what was
        // ACTUALLY delivered instead of the flow's own assumption.
        pushPayload: async () => {
          const placed = pushSteps.last();
          if (placed === undefined) {
            throw new Error("no push has been placed yet (the flow places it first)");
          }
          return { payload: placed.payload, token: placed.token };
        },
        pushPlace: () => pushSteps.place(),
        faceIdEnroll: () => enrollFaceId(currentDevice.udid),
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
        // The REAL pending asks: a notification flow names one, so the action it
        // injects answers the daemon's own request (not a synthetic one).
        pendingAsk: async (session) => laptop.pendingAsks(session),
        notifyPayload: async () => {
          if (lastSealed === undefined) {
            throw new Error("no `seal-push` has been placed yet");
          }
          return { payload: lastSealed.userInfo as { aps: unknown; tp: unknown } };
        },
        // docs/feat/mobile-notifications.md N8: seal a plaintext the FLOW chose to
        // the device's push key (which this harness generated and kept, so it can
        // seal for real) and place it. A forged one uses another sender key.
        sealPush: async (options) => {
          const keys = await notifyKeys();
          const message = notifyMessageOf(options.kind, options.reply === true, {
            ...(options.session !== undefined ? { sessionId: options.session } : {}),
            ...(options.request !== undefined ? { requestId: options.request } : {}),
          });
          const sealed = sealPushMessage(
            message,
            options.forged === true ? keys.forgedComputerSk : keys.computerSk,
            keys.devicePushPk,
            (length) => crypto.getRandomValues(new Uint8Array(length)),
          );
          const payload = payloadFor(
            sealed,
            options.hostileAps === true
              ? {
                  category: "tentacle.ask",
                  alert: { title: "tentacle", body: "rm -rf / — approve?" },
                }
              : {},
          );
          await placeOnSimulator(currentDevice.udid, payload, () => {});
          lastSealed = { message, userInfo: payload as unknown as Record<string, unknown> };
          return { payload };
        },
        // Owner Q7: inject the response Maestro cannot long-press. The APP runs
        // the real dispatcher (Face ID prompt included) — this only says which
        // action was "tapped" on the last placed notification.
        notifyRespond: async (options) => {
          if (lastSealed === undefined) {
            throw new Error("notify-respond: no `seal-push` has been placed yet");
          }
          const actionId = notifyActionIdOf(options.action);
          if (actionId === undefined) {
            throw new Error(`notify-respond: unknown action ${options.action}`);
          }
          await injectNotificationResponse(currentDevice.udid, {
            actionId,
            userInfo: lastSealed.userInfo,
            ...(options.text !== undefined ? { userText: options.text } : {}),
          });
          return { accepted: true };
        },
        // Flow 30's daemon truth (T8.1): what the listener RECEIVED. Nothing on
        // screen can answer this — a viewer's claim is not evidence.
        escapeHits: () => ({ hits: probes.hits() }),
        // Flow 24's light/dark pairs: `simctl ui`, not `simctl spawn` (it is a
        // simulator setting, not a process inside it).
        appearance: async (name) => {
          const child = Bun.spawn(
            ["xcrun", "simctl", "ui", currentDevice.udid, "appearance", name],
            { stdout: "pipe", stderr: "pipe" },
          );
          if ((await child.exited) !== 0) {
            const err = await new Response(child.stderr).text();
            throw new Error(`simctl ui appearance ${name} failed: ${err.trim()}`);
          }
        },
      },
    });
    await hooks.ready;

    // Every flow, on each simulator this run covers.
    const majors: readonly IosMajor[] = only === undefined ? REQUIRED_IOS_MAJORS : [only];
    const flows = `${REPO}/apps/mobile/e2e/flows`;
    const flowTimeoutMs =
      (args.flowTimeoutS ?? Number(process.env.E2E_FLOW_TIMEOUT_S ?? DEFAULT_FLOW_TIMEOUT_S)) *
      1000;
    const allResults: FlowResult[] = [];
    for (const major of majors) {
      // `--udid` / `E2E_SIM_UDID` pins the simulator (parallel agents each own one).
      const device = udid ?? firstDevice(devicesJson, major);
      if (device === undefined) {
        console.error(`no available iOS ${major} simulator (preflight passed: check simctl)`);
        return 2;
      }
      console.log(`\n=== iOS ${major} (${device}) ===`);
      currentDevice.udid = device;
      // Unattended: the simulator may be shut down. Booting a booted one is a
      // no-op error, so it is not checked; `bootstatus -b` waits for it.
      await $`xcrun simctl boot ${device}`.quiet().nothrow();
      await $`xcrun simctl bootstatus ${device} -b`.quiet().nothrow();
      // A just-booted simulator takes a while to honour the enrolment: the FIRST
      // flow of the first gate run on a cold simulator met the passcode sheet
      // instead of Face ID (docs/feat/mobile-e2e-gate.md, Execution). Enrol once
      // here, well before any flow's `_unlock` enrols again (idempotent).
      await enrollFaceId(device);
      await Bun.sleep(FACEID_SETTLE_MS);
      // 13d's flow 18 needs photos in the simulator's library: `addmedia` seeds a
      // PNG and a JPEG (fixtures, never real photos — the harness owns them under
      // its own scratch dir).
      const mediaCode = await addMedia(device, runDir);
      if (mediaCode !== 0) {
        console.error(`addmedia failed for iOS ${major} (exit ${mediaCode})`);
        return mediaCode;
      }
      // A CLEAN install once per run: whatever an earlier run (or a person) left
      // on this simulator goes first, so the run starts from the build it tests.
      await $`xcrun simctl uninstall ${device} so.tentacle.app`.quiet().nothrow();
      const buildCode =
        args.app === undefined
          ? await buildAndInstall(device, runDir, major)
          : (await $`xcrun simctl install ${device} ${args.app}`.nothrow()).exitCode;
      if (buildCode !== 0) {
        console.error(`build/install failed for iOS ${major} (exit ${buildCode})`);
        return buildCode;
      }
      for (const flow of runFlows) {
        const meta = metas.get(flow) ?? parseFlowMeta(flow, "");
        if (meta.tags.includes("quarantine")) {
          console.log(`- ${flow} (iOS ${major}) quarantined: ${meta.reasons.quarantine ?? ""}`);
          allResults.push({
            name: flow,
            status: "quarantined",
            seconds: 0,
            attempts: 0,
            tags: meta.tags,
          });
          continue;
        }
        // Each flow gets its own pairing scope. "One window at a time" (F-H3) is
        // a rule INSIDE a flow: a flow that failed between `pair-start` and its
        // answer leaves a window open, and the next flow's `pair-start` would be
        // refused — a red cascade with a single cause (found by the iOS 26 run:
        // `14-pair-bad-text` leaves its window unclaimed, and 15–17 all failed
        // before their first assertion). Teardown answers a waiting `ask` with
        // `n`, so nothing is ever silently registered.
        const attempts: AttemptStatus[] = [];
        const started = Date.now();
        let outDir = join(runDir, `ios${major}`, flow);
        do {
          await pairing.stop();
          // No state carried between flows (or attempts): the app is stopped, and
          // the flow itself relaunches with `clearState` + `clearKeychain` (`_pair`).
          await $`xcrun simctl terminate ${device} so.tentacle.app`.quiet().nothrow();
          // And its Keychain is EMPTY at the flow's launch: `_pair` clears it only
          // AFTER `launchApp`, so the app could read the previous flow's computer
          // first (the second gate run: 05 and 16 opened on `Computers`, already
          // paired). Apple keeps Keychain items across `clearState`.
          await $`xcrun simctl keychain ${device} reset`.quiet().nothrow();
          outDir = join(runDir, `ios${major}`, attempts.length === 0 ? flow : `${flow}.retry`);
          await mkdir(outDir, { recursive: true });
          // A flow that stops `serve` (05, 16, 17) and dies before its restart
          // step must not take the rest of the run with it: `serve` is brought
          // back before every attempt (the first gate run crashed whole at 17,
          // `cannot reach the daemon`, after 16 failed mid-outage).
          let outcome: AttemptStatus;
          try {
            await waitForPort(daemonPort, 1_000).catch(async () => {
              console.error(`  serve was down before ${flow}: restarting it`);
              serving = startServe();
              await waitForPort(daemonPort);
            });
            outcome = await spawnFlow(
              `${flows}/${flow}.yaml`,
              device,
              outDir,
              runDir,
              seeded,
              hooks.address,
              () => composeSessionOf(endpoint),
              flowTimeoutMs,
            );
          } catch (error) {
            // A setup step (the flow's own session, a restart) failed: this
            // flow is red, the run goes on.
            const text = error instanceof Error ? error.message : String(error);
            await writeFile(join(outDir, "setup-error.txt"), `${text}\n`);
            console.error(`  ${flow} setup failed: ${text}`);
            outcome = "fail";
          }
          attempts.push(outcome);
          const mark = outcome === "pass" ? "✓" : "✗";
          const retry = attempts.length > 1 ? " (retry)" : "";
          const line = `${mark} ${flow} (iOS ${major})${retry} ${outcome}`;
          (outcome === "pass" ? console.log : console.error)(line);
        } while (shouldRetry(meta, attempts));
        allResults.push({
          name: flow,
          status: finalStatus(attempts),
          seconds: (Date.now() - started) / 1000,
          attempts: attempts.length,
          tags: meta.tags,
          outDir,
        });
      }
    }
    // `E2E_HOLD=1`: keep serve, the mock and the hooks up after the flows, for a
    // hand-driven sweep (`maestro --device <udid> test -e MAESTRO_HOOKS=… <flow>`);
    // Ctrl+C ends it through the same teardown.
    if (args.hold === true || process.env.E2E_HOLD === "1") {
      console.log(`\nHOLD — hooks ${hooks.address}, run dir ${runDir}; Ctrl+C to end`);
      await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
    }
    await pairing.stop();
    await hooks.stop();
    await seeded.close();
    // The one summary (docs/feat/mobile-e2e-gate.md): printed AND kept in the
    // run dir with a machine-readable twin, next to every failed flow's output.
    const summary = summaryText(allResults, metas);
    await writeFile(join(runDir, "summary.txt"), summary);
    await writeFile(join(runDir, "summary.json"), `${JSON.stringify(allResults, null, 2)}\n`);
    console.log(`\n${summary}\nresults in ${runDir}`);
    return verdictOf(allResults).exitCode;
  } finally {
    for (const child of children) {
      child.kill();
      // A flow attempt leads its own group (`runAttempt`, detached): reap the
      // JVM/driver it started too. A no-op for a child that leads no group.
      killFlowTree(child.pid);
    }
    children.clear();
    mock.stop();
    // The fake APNs is in THIS process too (an h2c server keeps the loop alive).
    apns.stop();
    // And so is the escape suite's probe listener.
    probes.stop();
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
 * `JPEG fixture`; iOS 26's PHPicker shows "Photo, <date>, <time>" instead, so flow
 * 18 taps the two newest cells — this pair). The
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

/**
 * The LOCAL APNs for the push flow (docs/feat/mobile-push.md P10; the fake is
 * P8's, from `packages/cli/test/serve-push.test.ts`, moved into the harness so
 * the payload the flow pushes is the one the daemon actually produced).
 *
 * Nothing here talks to Apple: it is an h2c server on 127.0.0.1, and the relay's
 * `createApnsClient` is pointed at it with the `origins` override P4 added for
 * exactly this. It answers `200` always, so a push always reads `sent`.
 */
async function startFakeApns(): Promise<{
  readonly origin: string;
  readonly jwtSource: ApnsJwtSource;
  /** The single object `{aps, tp}` the last push carried, as APNs would send it. */
  last(): ApnsPayload | undefined;
  /** How many requests it has answered (a flow's "exactly one push" question). */
  readonly count: () => number;
  stop(): void;
}> {
  const http2 = await import("node:http2");
  const seen: ApnsPayload[] = [];
  const server = http2.createServer();
  server.on("stream", (stream) => {
    let body = "";
    stream.on("data", (chunk: unknown) => {
      body += String(chunk);
    });
    stream.on("end", () => {
      try {
        seen.push(JSON.parse(body) as ApnsPayload);
      } catch {
        // A body that is not JSON is not a push this harness can use; the flow's
        // own assertion then fails loudly rather than pushing something odd.
      }
      stream.respond({ ":status": 200 });
      stream.end("");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    // The signature is never checked by the fake, so a constant is honest here.
    jwtSource: {
      jwt: () => Promise.resolve("header.claims.signature"),
      invalidate: () => {},
    },
    last: () => (seen.length === 0 ? undefined : seen[seen.length - 1]),
    count: () => seen.length,
    stop: () => server.close(),
  };
}

/**
 * The harness's side of P10's push flow, wired to the REAL effects.
 *
 * The orchestration itself is `createPushSteps` (`./push-steps.ts`) — pure, and
 * unit-tested, because the property the flow rests on ("the payload placed on the
 * simulator came out of the daemon's chain") must be provable without a daemon, a
 * relay or a simulator. Before that split, a mutation replacing the captured
 * payload with a hand-written literal survived every guard (the task doc's M7).
 *
 * Everything below is the effectful half: the daemon's own push store, one ask,
 * the local fake APNs above, and `xcrun simctl push`.
 */
function harnessPushSteps(deps: {
  readonly url: string;
  readonly configDir: string;
  readonly apns: { last(): ApnsPayload | undefined; count(): number };
  readonly pairDeviceId: () => string | undefined;
  readonly udid: () => string;
  readonly log: (line: string) => void;
}): PushSteps {
  return createPushSteps({
    pairedDeviceId: deps.pairDeviceId,
    // The phone's OWN push key: a fresh X25519 pair, exactly what `push-key.ts`
    // generates on the device. Nothing in this flow opens it (task 17's extension
    // would), so it is written and then unused — honestly: the envelope's SHAPE
    // is what the flow asserts, and `push-envelope.ts` says so.
    pushKey: () => encodeBase64Url(publicKeyOf(crypto.getRandomValues(new Uint8Array(32)))),
    register: ({ deviceId, token, env, key }) => {
      writePushRegistration(deps.configDir, deviceId, { token, env, key });
    },
    promptOnce: () => promptOnce(deps.url),
    apnsCount: () => deps.apns.count(),
    lastApnsPayload: () => deps.apns.last(),
    place: (payload) => placeOnSimulator(deps.udid(), payload, deps.log),
  });
}

/** The key material the notification flows generated this run (see `notifyKeys`). */
let notifyKeysCache: NotifyKeys | undefined;

/** The last plaintext `seal-push` placed: what `notify-respond` answers. */
let lastSealed: { message: unknown; userInfo: unknown } | undefined;

/**
 * Generate (once per run) the key material `seal-push` seals with: the computer's
 * static key and the device's push key. The device's PUBLIC half is what the
 * harness registers with the daemon, so a push the daemon sends goes to a key
 * this harness can actually seal for — the same real chain production has.
 */
async function notifyKeys(): Promise<NotifyKeys> {
  if (notifyKeysCache !== undefined) {
    return notifyKeysCache;
  }
  const deviceSk = crypto.getRandomValues(new Uint8Array(32));
  notifyKeysCache = {
    computerSk: crypto.getRandomValues(new Uint8Array(32)),
    forgedComputerSk: crypto.getRandomValues(new Uint8Array(32)),
    devicePushPk: publicKeyOf(deviceSk),
    devicePushPkText: encodeBase64Url(publicKeyOf(deviceSk)),
  };
  return notifyKeysCache;
}

/**
 * The notification-flow fixtures (`docs/feat/mobile-notifications.md` N8): the
 * key material the harness generates ONCE per run, the plaintexts the flows
 * seal, and the action ids they inject.
 *
 * It exists so `seal-push` seals to a REAL device push key (the harness's own,
 * registered with the daemon) and `notify-respond` names a real action id — the
 * two things a flow would otherwise fake, and prove nothing about.
 */
interface NotifyKeys {
  /** The COMPUTER's static key (what a genuine push authenticates with). */
  readonly computerSk: Uint8Array;
  /** A different sender: what a hostile relay could produce (F4). */
  readonly forgedComputerSk: Uint8Array;
  /** The device's push key pair, as a string for `device/push_register`. */
  readonly devicePushPk: Uint8Array;
  readonly devicePushPkText: string;
}

const notifyMessageOf = (
  kind: string,
  reply: boolean,
  /** The REAL ids a flow names, so an injected action answers the daemon's own ask. */
  real: { readonly sessionId?: string; readonly requestId?: string },
): {
  v: 1;
  id: string;
  at: number;
  kind: "ask" | "ask_resolved" | "turn_done" | "turn_failed";
  computer: string;
  cwd: string;
  sessionId: string;
  title: string;
  ask?: {
    requestId: string;
    tool: string;
    title: string;
    preview: string;
    options: { optionId: string; name: string; kind: "allow_once" | "reject_once" }[];
    reply?: { maxChars: number };
  };
} => {
  const at = Date.now();
  const hex = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const ask = {
    requestId: real.requestId ?? `flow-${hex().slice(0, 8)}`,
    tool: "shell",
    title: "Run a shell command",
    preview: "rm -rf build",
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" as const },
      { optionId: "reject_once", name: "Deny", kind: "reject_once" as const },
    ],
    ...(reply ? { reply: { maxChars: 1000 } } : {}),
  };
  const base = {
    v: 1 as const,
    id: hex(),
    at,
    computer: "flow-computer",
    cwd: "/home/dev/tentacle",
    sessionId: real.sessionId ?? "flow-session",
    title: "Fix the failing test",
  };
  if (kind === "ask_resolved") {
    return { ...base, kind: "ask_resolved" };
  }
  if (kind === "turn_done") {
    return { ...base, kind: "turn_done" };
  }
  if (kind === "turn_failed") {
    return { ...base, kind: "turn_failed" };
  }
  return { ...base, kind: "ask", ask };
};

/** The action id a `notify-respond` name maps to (the categories' own ids). */
const notifyActionIdOf = (name: string): string | undefined => {
  switch (name) {
    case "approve":
      return "tentacle.approve";
    case "deny":
      return "tentacle.deny";
    case "reply":
      return "tentacle.reply";
    case "open":
      return "tentacle.open";
    default:
      return undefined;
  }
};

/**
 * Hand a response to the app (Owner Q7). The app polls for it in a DEV build only
 * (`apps/mobile/src/notification-dev-inject.ts` + the `index.ts` hook): a file in
 * the app's container that the app reads on a short interval. There is no
 * production path to this, and nothing in the app's decision chain trusts it —
 * the injected response goes through the SAME dispatcher a real tap does.
 */
async function injectNotificationResponse(
  udid: string,
  response: { actionId: string; userInfo: unknown; userText?: string },
): Promise<void> {
  // The app's data container (`simctl get_app_container` is NOT a `spawn`
  // subcommand, so it is read directly).
  const child = Bun.spawnSync(
    ["xcrun", "simctl", "get_app_container", udid, "so.tentacle.app", "data"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const container = child.stdout.toString().trim();
  if (child.exitCode !== 0 || container === "") {
    throw new Error("notify-respond: the app is not installed on the simulator");
  }
  const dir = join(container, "Library", "Caches");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "notify-respond.json"), JSON.stringify(response));
}

/**
 * Write one device's push registration through the DAEMON'S OWN STORE.
 *
 * Not a hand-built `{v: 1, …, at}`: review round 1 (finding 2) found this writer
 * keeping a second copy of a persisted format, so a change to
 * `packages/daemon/src/push-store.ts` (a renamed field, a new version, a
 * different timestamp key) would leave the flow failing with the misleading
 * "the relay must announce push" error instead of the real one. The store also
 * validates the record through the wire's own schema, which is the property the
 * flow depends on and cannot check for itself.
 */
function writePushRegistration(
  configDir: string,
  deviceId: string,
  value: { readonly token: string; readonly env: "sandbox" | "production"; readonly key: string },
): void {
  const written = daemonWritePushRegistration(configDir, {
    deviceId,
    token: value.token,
    env: value.env,
    key: value.key,
    registeredAt: Date.now(),
  });
  if (!written.ok) {
    // Surfaced, never swallowed: a record the daemon's own store refuses is a
    // flow that would otherwise fail later with the wrong message.
    throw new Error(
      `cannot register the harness's push device (${written.path}): ${written.reason}`,
    );
  }
}

/**
 * Make the daemon raise one ask, which pops the local APNs at once (`--push-grace`
 * is 0 for this run). `EDIT` is the mock model's tool-call prompt — the same one
 * flows 08/08b/08c use, so nothing new is asked of the mock.
 *
 * The turn is NOT awaited to completion: it SUSPENDS on the ask by design, and
 * waiting for it would mean answering it, which cancels the push (Design 1).
 */
async function promptOnce(url: string): Promise<void> {
  const factory = webSocketChannelFactory(url, {});
  const client = new RemoteClient(
    await factory(),
    new PermissionBroker(undefined, { holdUntilSet: true }),
  );
  await client.initialize();
  const session = client.newSession(undefined, crypto.randomUUID());
  // The session is live as soon as it exists; `send` returns its event iterator
  // and the turn starts on the first pull. One pull is enough to reach the ask.
  const events = session.send("EDIT p10-push.txt");
  await events.next();
}

/**
 * Hand the payload to the simulator, exactly as APNs would.
 *
 * The bundle id is an ARGUMENT, not a field added to the payload: `simctl push`
 * accepts either, and the argument form keeps the bytes identical to what Apple
 * would deliver — which is what makes the envelope in them meaningful.
 */
async function placeOnSimulator(
  udid: string,
  payload: ApnsPayload,
  log: (line: string) => void,
): Promise<void> {
  if (udid === "") {
    throw new Error("no simulator selected yet");
  }
  // The payload is written under the run's OWN scratch dir and removed after.
  const file = join(RUNS_DIR, `push-payload-${Date.now()}.json`);
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(file, JSON.stringify({ aps: payload.aps, tp: payload.tp }, null, 2));
  try {
    const child = Bun.spawn(["xcrun", "simctl", "push", udid, "so.tentacle.app", file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await child.exited;
    const err = await new Response(child.stderr).text();
    if (code !== 0) {
      throw new Error(`simctl push failed (${code}): ${err.trim()}`);
    }
    log(`push placed on ${udid} from the daemon's own envelope`);
  } finally {
    await rm(file, { force: true });
  }
}

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
  // docs/feat/mobile-ui-polish.md Slice 6: the screenshot walk (light/dark pairs
  // for the visual review), on a session of its own.
  "24-ui-shots",
  // docs/feat/mobile-session-info.md: the "…" menu's Session info sheet — the
  // model, the context, the MCP servers and the skills, on a session of its own.
  "25-session-info",
  // docs/feat/mobile-chrome.md S6: the sessions drawer — highlight, rename by
  // id, switch — on a session of its own (it renames it).
  "26-drawer",
  // docs/feat/mobile-chrome.md S9: the Activity actions — background children
  // (steps, message, Stop) and a shell job (output, Stop), on a session of its own.
  "27-activity",
  // docs/feat/mobile-chrome.md S10: the floating Activity button (opt-in) — drag,
  // snap, kept across a relaunch, back to Header — on a session of its own.
  "28-floating-activity",
  // docs/feat/mobile-tool-rows.md S3: tool calls as a thread of steps (running,
  // collapsed, open, error) — the mock model's `TOOLROWS29` turn, on a session
  // of its own.
  "29-tool-rows",
  // docs/feat/model-artifacts.md T8.1: the HTML artifact's escape suite — the
  // hostile fixture in the isolated WebView, every probe counted by a real
  // listener. It runs the mock model's `ESCAPE30` turn on a session of its own,
  // so its card cannot leak into another flow's transcript.
  "30-artifact-escape",
  // docs/feat/model-charts.md T6: a `chart` call draws inline, live and after a
  // relaunch (from history) — on a session of its own.
  "31-chart-inline",
  // docs/feat/model-charts.md T7: the chart's table toggle and full screen
  // (series chip, table, close) — on a session of its own.
  "32-chart-interact",
  // docs/feat/mobile-hub.md H3: the floating button as the hub (sticky fan,
  // Attach, Stop on a HOLD turn, a tapped empty Activity saying "Nothing
  // running") — on a session of its own.
  "33-hub",
  // docs/feat/mobile-e2e-gate.md: one flow per hub item (fan + More), each
  // asserting the item opens what it names — on a session of its own.
  "34-hub-attach",
  "34-hub-activity",
  "34-hub-artifacts",
  "34-hub-tools",
  "34-hub-commands",
  "34-hub-sessions",
  "34-hub-info",
  "34-hub-scheduled",
  "34-hub-dictate",
  "34-hub-new",
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
  // docs/feat/mobile-push.md P10: the push placeholder banner. LAST, because it
  // is the only flow that leaves a PENDING ASK behind on its own session (an
  // ask nobody answers, by design: answering it is what cancels the push), and
  // it registers a push key so the daemon pushes to this simulator. Neither is
  // visible to another flow (each gets its own session, and every other flow
  // clears state), but a red here must not colour the flows above it.
  "push-placeholder",
  // docs/feat/mobile-notifications.md N8: the notification path. Each leaves a
  // session of its own (they share `ASK1_ID`'s seed but the ask is raised by the
  // flow itself), and each ends on DAEMON truth.
  "22-notify-render",
  "22-notify-approve",
  "22-notify-deny",
  "22-notify-reply",
  "22-notify-forged",
];

/**
 * The flows this run drives. `--only` or `E2E_ONLY_FLOWS` (comma-separated names;
 * the flag wins) narrows them: a long run degrades the simulator (every flow starts
 * its own XCTest driver), so a single flow is how one is debugged or re-proved in a
 * bounded window. Empty or absent: every flow, which is the gate.
 */
export function selectedFlows(
  flag: string | undefined,
  env: string | undefined = process.env.E2E_ONLY_FLOWS,
): readonly string[] {
  const wanted = (flag ?? env ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (wanted.length === 0) {
    return FLOWS;
  }
  for (const name of wanted) {
    if (!FLOWS.includes(name)) {
      throw new Error(`--only / E2E_ONLY_FLOWS names an unknown flow: ${name}`);
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
  "24-ui-shots": "SHOTS_ID",
  "25-session-info": "INFO_ID",
  "26-drawer": "DRAWER_ID",
  "27-activity": "ACTIVITY_ID",
  "28-floating-activity": "FLOAT_ID",
  "29-tool-rows": "TOOLROWS_ID",
  // docs/feat/model-artifacts.md T8.1 (flow 30): its own session, because the
  // `present` card is daemon-side state that outlives `clearState`.
  "30-artifact-escape": "ESCAPE_ID",
  "31-chart-inline": "CHART_ID",
  "32-chart-interact": "CHART2_ID",
  "33-hub": "HUB_ID",
  // docs/feat/mobile-e2e-gate.md: ONE variable, a fresh session per flow.
  "34-hub-attach": "HUBITEM_ID",
  "34-hub-activity": "HUBITEM_ID",
  "34-hub-artifacts": "HUBITEM_ID",
  "34-hub-tools": "HUBITEM_ID",
  "34-hub-commands": "HUBITEM_ID",
  "34-hub-sessions": "HUBITEM_ID",
  "34-hub-info": "HUBITEM_ID",
  "34-hub-scheduled": "HUBITEM_ID",
  "34-hub-dictate": "HUBITEM_ID",
  "34-hub-new": "HUBITEM_ID",
};

/** One attempt's spawn + timeout, in a form a test can drive (review round 1 F3). */
export interface AttemptOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /** The attempt is killed after this long. */
  readonly timeoutMs: number;
  /** Called with the live child, so the caller can tear it down in `finally`. */
  readonly onSpawn?: (child: Child) => void;
}

/**
 * One attempt of one flow: spawn it, bound it with a timeout, report what
 * happened. Maestro is a LAUNCHER — it starts a JVM, which starts the XCTest
 * driver — so the attempt is spawned in its OWN process group and a timeout
 * kills the GROUP, not just the leader: an orphaned driver keeps the
 * simulator's driver port, and the next flow then hangs too (review round 1 F3).
 */
export async function runAttempt(
  argv: readonly string[],
  opts: AttemptOptions,
): Promise<{ readonly code: number | null; readonly timedOut: boolean }> {
  const child = Bun.spawn([...argv], {
    cwd: opts.cwd,
    env: opts.env,
    stdout: Bun.file(opts.stdoutPath),
    stderr: Bun.file(opts.stderrPath),
    // setsid(): the attempt LEADS its own process group, so `kill(-pid)`
    // reaches the JVM and the driver too (without it, `-pid` names no group).
    detached: true,
  }) as unknown as Child;
  opts.onSpawn?.(child);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killFlowTree(child.pid);
  }, opts.timeoutMs);
  const code = await child.exited;
  clearTimeout(timer);
  if (timedOut) {
    // The leader may be gone while what it started is not.
    killFlowTree(child.pid);
  }
  return { code, timedOut };
}

/** SIGKILL the process group led by `pid`; false when it is already gone. */
export function killFlowTree(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
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
  /** Create one compose session on demand (the harness's own client). */
  newComposeSession: () => Promise<string>,
  /** One attempt is killed after this long (a hung driver must not stall the run). */
  timeoutMs: number,
): Promise<AttemptStatus> {
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
  let attempt: Child | undefined;
  const { code, timedOut } = await runAttempt(
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
      stdoutPath: join(outDir, "maestro.log"),
      stderrPath: join(outDir, "maestro.err.log"),
      timeoutMs,
      onSpawn: (child) => {
        attempt = child;
        children.add(child);
      },
    },
  );
  // Only THIS attempt: the set also holds `serve`, which must still be reaped.
  if (attempt !== undefined) {
    children.delete(attempt);
  }
  if (timedOut) {
    await writeFile(
      join(outDir, "timeout.txt"),
      `killed after ${Math.round(timeoutMs / 1000)} s (--flow-timeout / E2E_FLOW_TIMEOUT_S)\n`,
    );
    return "timeout";
  }
  return code === 0 ? "pass" : "fail";
}

/**
 * Enrol a face on the simulator (docs/feat/mobile-lock.md Step 0). Two commits:
 * the `-s` alone only SETS the default; the `-p` post is what makes
 * `isEnrolledAsync()` flip to true. Idempotent.
 */
async function enrollFaceId(udid: string): Promise<void> {
  await simctl(udid, ["notifyutil", "-s", "com.apple.BiometricKit.enrollmentChanged", "1"]);
  await simctl(udid, ["notifyutil", "-p", "com.apple.BiometricKit.enrollmentChanged"]);
}

/** How long a fresh enrolment is given to settle before the first flow. */
const FACEID_SETTLE_MS = 5_000;

/** Each flow's gate metadata, read from its yaml (docs/feat/mobile-e2e-gate.md). */
export function flowMetas(names: readonly string[]): Map<string, FlowMeta> {
  const dir = join(REPO, "apps", "mobile", "e2e", "flows");
  return new Map(
    names.map((name) => [
      name,
      parseFlowMeta(name, readFileSync(join(dir, `${name}.yaml`), "utf8")),
    ]),
  );
}

/** One attempt of one flow, by default (the longest green flow, 24-ui-shots, takes ~4 min). */
export const DEFAULT_FLOW_TIMEOUT_S = 600;

if (import.meta.main) {
  const code = await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(code);
}
