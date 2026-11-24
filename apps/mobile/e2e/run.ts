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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  type Missing,
  REQUIRED_IOS_MAJORS,
  missingText,
  parseRuntimes,
  preflight,
} from "./preflight.ts";
import { type ApnsPayload, type PushSteps, createPushSteps } from "./push-steps.ts";
import {
  type AppInput,
  DELETED,
  appCacheKey,
  builtAppPath,
  cacheEvictions,
  isHarnessOrTest,
  parseUdids,
  seedValues,
  shardLabel,
} from "./shard.ts";

export const REPO = join(import.meta.dir, "..", "..", "..");
export const RUNS_DIR = join(REPO, ".tentacle", "tmp", "e2e-mobile");

type Child = Subprocess<"ignore", "inherit", "inherit">;

/** Every child the run started, killed in `finally` (and on a signal, `reapAll`). */
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
  readonly shardOf?: string;
  readonly noAppCache?: true;
} {
  // `--shard-of <parentRunDir>`: this process is ONE shard of a parallel run
  // (docs/feat/e2e-parallel-gate.md D5). It never builds (`--app` is required,
  // the parent built once) and never runs the Swift suite (the parent did).
  const shardOfAt = argv.indexOf("--shard-of");
  let shardOf: string | undefined;
  if (shardOfAt !== -1) {
    const value = argv[shardOfAt + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--shard-of needs a value (the parent run dir)");
    }
    shardOf = value;
  }
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
    ...(shardOf === undefined ? {} : { shardOf }),
    ...(argv.includes("--no-app-cache") ? { noAppCache: true as const } : {}),
  };
  // A shard is ONE simulator on a build the parent made: without `--app` it
  // would build too (two xcodebuilds racing the same DerivedData), and a
  // comma-separated `--udid` would make it a parent again.
  if (shardOf !== undefined) {
    if (app === undefined) {
      throw new Error("--shard-of needs --app (a shard never builds its own)");
    }
    if (udid === undefined || udid.includes(",")) {
      throw new Error("--shard-of needs exactly one --udid");
    }
  }
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
export async function versionOf(
  command: string,
  flag: string,
  env?: Record<string, string>,
): Promise<string | undefined> {
  const fullEnv: Record<string, string> =
    env ??
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  const result = await $`${command} ${flag}`.quiet().nothrow().env(fullEnv);
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

export async function simctlRuntimes(): Promise<string> {
  const result = await $`xcrun simctl list -j runtimes`.quiet().nothrow();
  return result.exitCode === 0 ? result.stdout.toString() : "";
}

export async function simctlDevices(): Promise<string> {
  const result = await $`xcrun simctl list -j devices`.quiet().nothrow();
  return result.exitCode === 0 ? result.stdout.toString() : "";
}

/**
 * Every prerequisite this machine is missing, most fundamental first (empty =
 * run), with the SAME probes and the same per-major runtime rule on both paths:
 * the single-simulator one and the parallel parent's. One function, so a
 * prerequisite can never be checked by one path and not the other
 * (docs/feat/e2e-parallel-gate.md D2.1, review round 1 M3: the parent used to
 * skip it and paid for it with a 10–15 min build before the exit 2).
 *
 * `onlys` are the majors the run will actually drive (each parallel device's
 * own); empty keeps `preflight`'s default rule — every required major. The
 * probes run ONCE for all of them, and a tool missing for both is reported once.
 */
export async function missingPrerequisites(
  onlys: readonly IosMajor[] = [],
): Promise<readonly Missing[]> {
  const [xcode, cocoapods, maestro, runtimesJson] = await Promise.all([
    versionOf("xcodebuild", "-version"),
    versionOf("pod", "--version"),
    // Maestro's launcher needs a JDK BEFORE it can print its version, so the
    // probe carries the same JAVA_HOME/PATH the flows run with.
    versionOf("maestro", "--version", maestroEnv()),
    simctlRuntimes(),
  ]);
  const input = {
    platform: process.platform,
    runtimes: parseRuntimes(runtimesJson),
    ...(xcode === undefined ? {} : { xcode }),
    ...(cocoapods === undefined ? {} : { cocoapods }),
    ...(maestro === undefined ? {} : { maestro }),
  };
  const groups: readonly (IosMajor | undefined)[] =
    onlys.length === 0 ? [undefined] : [...new Set(onlys)];
  const missing = new Map<string, Missing>();
  for (const only of groups) {
    for (const item of preflight(input, ...(only === undefined ? [] : [only]))) {
      // A tool missing for both devices is one missing tool, named once.
      missing.set(item.tool, item);
    }
  }
  return [...missing.values()];
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

/** The little of a spawned child this needs: it can exit while we wait. */
export interface Servable {
  readonly exited: Promise<number>;
}

/**
 * Wait for the `serve` we JUST started to listen: the port answering is not
 * enough. `freePort()` binds `:0` and releases it, so between that and `serve`'s
 * own bind another process can take the port — and then the port DOES answer,
 * from the other run's daemon (same token, same protocol), which is silent
 * cross-talk: the flow would seed and pair against a stranger's `serve` and its
 * assertions would be about nothing (docs/feat/e2e-parallel-gate.md D7).
 * Racing the child's own exit turns that into a loud red.
 */
export async function waitForServe(
  child: Servable,
  port: number,
  timeoutMs = 20_000,
): Promise<void> {
  const died = child.exited.then((code) => {
    throw new Error(
      `serve exited (code ${code}) before listening on 127.0.0.1:${port} — port taken by another run?`,
    );
  });
  // The loser of the race stays pending; its rejection is already handled by
  // `Promise.race`, so it must not surface as an unhandled one.
  died.catch(() => {});
  await Promise.race([waitForPort(port, timeoutMs), died]);
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
  const udids = parseUdids(args.udid ?? process.env.E2E_SIM_UDID ?? "");
  const udid = udids.length === 1 ? udids[0] : undefined;
  // A parent: several simulators, in ONE run (docs/feat/e2e-parallel-gate.md D1).
  // It does no work itself — it validates the devices, builds once, splits the
  // flows and merges the halves (`parallel.ts`) — so it branches before the
  // single-simulator setup below.
  if (udids.length > 1) {
    if (args.hold === true || process.env.E2E_HOLD === "1") {
      console.error("e2e:mobile: --hold (E2E_HOLD) is a single-simulator form");
      return 2;
    }
    const { runParallel } = await import("./parallel.ts");
    return runParallel(udids, {
      flows: runFlows,
      only: args.only,
      flowTimeoutS: args.flowTimeoutS,
      noAppCache: args.noAppCache === true,
    });
  }
  const devicesJson = await simctlDevices();
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
  const missing = await missingPrerequisites(only === undefined ? [] : [only]);
  if (missing.length > 0) {
    console.error(missingText(missing));
    return 2;
  }

  // The Notification Service Extension's Swift logic, against the SAME vectors
  // the TypeScript side is pinned by (docs/feat/mobile-notifications.md N5,
  // decision 20). Run here, before any build: it takes seconds and it is the only
  // gate that exercises the extension's crypto (`swift test`, macOS only). A
  // parallel run's CHILDREN skip it: the parent already ran it once.
  const swiftCode = args.shardOf === undefined ? await runSwiftTests() : 0;
  if (swiftCode !== 0) {
    console.error("e2e:mobile: `bun run test:swift` failed (the NSE's PushCore suite)");
    return 2;
  }

  // `--shard-of <parentRunDir>`: this process is one shard, so its artefact dir
  // is the parent's, under its own label — never `RUNS_DIR/<runId>`, which is
  // how the parent finds each child's summary (docs/feat/e2e-parallel-gate.md D5).
  const runId =
    args.shardOf === undefined ? `${Date.now()}` : (args.shardOf.split(/[/\\]/).pop() ?? "");
  // The dir name comes from `shardLabel` — the SAME function the parent uses to
  // find this child's `summary.json` (`parallel.ts`). Two independent slices of
  // the udid would drift on a non-standard one and the merge would read nothing.
  const runDir =
    args.shardOf === undefined ? join(RUNS_DIR, runId) : join(args.shardOf, shardLabel(udid ?? ""));
  await mkdir(join(runDir, "project"), { recursive: true });
  await mkdir(join(runDir, "config"), { recursive: true });
  console.log(
    args.shardOf === undefined
      ? `e2e:mobile run ${runId} → ${runDir}`
      : `e2e:mobile shard of ${args.shardOf} → ${runDir}`,
  );

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
  // Flow 36's workspace files (docs/feat/mobile-file-preview-cards.md): a real
  // 7-page PDF and a real PNG, generated per run, presented by `path`.
  {
    const { pngFixture, reportPdf } = await import("./preview-fixtures.ts");
    await writeFile(join(runDir, "project", "q3-report.pdf"), reportPdf());
    await writeFile(join(runDir, "project", "hero.png"), pngFixture(1280, 720));
  }
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
  // `cwd` (flow 37): a SECOND project's serve runs in its own folder, same config.
  const startServe = (port: number = daemonPort, cwd: string = runDir): Child => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(REPO, "packages", "cli", "src", "main.ts"),
        "serve",
        "--port",
        `${port}`,
        "--token",
        "e2e-token",
        // The relay is ON for every flow, pointed at the LOCAL relay above: a
        // harness must never reach relay.tentacle.so (no real infra), and flow
        // 22's whole subject is the relay path.
        // The SIDE `serve` (flow 17's offline turn) is relay-free: on the relay the
        // phone reached it anyway — its pairing carries the relay address too
        // (docs/fix/mobile-e2e-reds.md).
        ...(port === daemonPort ? ["--relay", relayUrl] : ["--no-relay"]),
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
        cwd,
        env: {
          ...process.env,
          TENTACLE_CONFIG_DIR: join(runDir, "config"),
          TENTACLE_MODEL_BASE_URL: mock.baseUrl,
          TENTACLE_MODEL: "mock-model",
        },
        stdout: Bun.file(join(runDir, port === daemonPort ? "serve.log" : `serve-${port}.log`)),
        stderr: Bun.file(
          join(runDir, port === daemonPort ? "serve.err.log" : `serve-${port}.err.log`),
        ),
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
  // Flow 37 (docs/feat/mobile-projects.md): project B, a second `serve` in its own
  // folder on the SAME config dir (one computer, two projects). Started on demand;
  // a restart keeps its port, since the phone paired that address.
  const projectBDir = join(runDir, "project-b");
  let projectB: { child: Child | undefined; readonly port: number } | undefined;

  try {
    // `waitForServe`, not `waitForPort`: a port taken by another run would
    // answer, and every flow would then seed against a stranger's daemon.
    await waitForServe(serving, daemonPort);
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
      // `serve` runs in `runDir`: `pair` pairs that project (mobile-projects Q6).
      projectDir: runDir,
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
      turnOnce,
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
      // The SAME endpoint (url + token) as the seed's: without the token `serve`
      // answers 401 (push-placeholder, docs/fix/mobile-e2e-reds.md).
      ...endpoint,
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
          await waitForServe(serving, daemonPort);
        },
        projectBStart: async () => {
          if (projectB?.child !== undefined) {
            return;
          }
          await mkdir(projectBDir, { recursive: true });
          const port = projectB?.port ?? freePort();
          const child = startServe(port, projectBDir);
          projectB = { child, port };
          await waitForServe(child, port);
        },
        projectBStop: async () => {
          const child = projectB?.child;
          if (projectB === undefined || child === undefined) {
            return;
          }
          child.kill();
          await child.exited;
          children.delete(child);
          projectB = { child: undefined, port: projectB.port };
        },
        // Flow 17 (fix/mobile-e2e-reds): the history moves while the PHONE is
        // offline. `serve` is down (the flow stopped it); a SIDE `serve` on another
        // port, same store, runs one laptop turn and is stopped again — the phone
        // only knows the paired port, so it cannot see the change before its own
        // `up`, whatever its redial jitter.
        laptopOfflineTurn: async (session, prompt) => {
          const up = await waitForPort(daemonPort, 300).then(
            () => true,
            () => false,
          );
          if (up) {
            throw new Error("serve is up: an offline turn needs it stopped first (stop-serve)");
          }
          const port = freePort();
          const side = startServe(port);
          try {
            await waitForServe(side, port);
            await turnOnce(
              { url: `ws://127.0.0.1:${port}/`, token: endpoint.token },
              session,
              prompt,
            );
          } finally {
            side.kill();
            await side.exited;
            children.delete(side);
          }
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
        modelRelease: () => {
          const waiting = mock.gated();
          mock.release();
          return waiting;
        },
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
          if (options.project === "b") {
            if (projectB?.child === undefined) {
              throw new Error("project B's serve is not running (project-b-start first)");
            }
            const started = await pairing.start({
              projectDir: projectBDir,
              address: `ws://127.0.0.1:${projectB.port}/e2e`,
            });
            return { payload: started.payload, computerId: started.computerId, relayOnly: false };
          }
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
        escapeHits: () => ({ hits: probes.hits(), strays: probes.strays() }),
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
      const resolved = await resolveApp({
        device,
        runDir,
        major,
        app: args.app,
        // A shard never builds (it is given `--app`): the cache is the parent's.
        noAppCache: args.noAppCache === true || args.shardOf !== undefined,
      });
      if (resolved.code !== 0) {
        console.error(`build/install failed for iOS ${major} (exit ${resolved.code})`);
        return resolved.code;
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
              await waitForServe(serving, daemonPort);
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
    reapAll();
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
 * The Notification Service Extension's Swift suite (`bun run test:swift`). In a
 * function so the PARALLEL parent can run it once and its children skip it: the
 * three would share one SwiftPM `.build` lock (docs/feat/e2e-parallel-gate.md).
 */
export async function runSwiftTests(): Promise<number> {
  const child = Bun.spawn(["bun", "run", "test:swift"], {
    cwd: REPO,
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

/** Where a reused Release build lives: outside `e2e-mobile/` (a run-dir consumer reads that). */
export const APP_CACHE_DIR = join(REPO, ".tentacle", "tmp", "e2e-app-cache");

/** How many cached builds are kept (an app is ~100–200 MB). */
export const APP_CACHE_KEEP = 3;

/**
 * The files the Release build is made of — what a cached build may be reused for
 * (docs/feat/e2e-parallel-gate.md D6). Over-inclusive on purpose, and keyed by
 * CONTENT rather than by a commit: a worktree full of uncommitted edits (how
 * every task is validated) must still get an honest answer. The exclusions
 * (harness, flows, unit tests) are applied by `appCacheKey`, not here.
 */
export async function appCacheInputs(repo: string): Promise<readonly AppInput[]> {
  const listing = Bun.spawn(
    [
      "git",
      "ls-files",
      "-co",
      "--exclude-standard",
      "--",
      "apps/mobile",
      "packages",
      "package.json",
      "bun.lock",
      "patches",
    ],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  const text = await new Response(listing.stdout).text();
  if ((await listing.exited) !== 0) {
    throw new Error("git ls-files failed: the app cache key cannot be computed");
  }
  const files: AppInput[] = [];
  for (const path of text.split("\n").filter((line) => line !== "")) {
    // The harness, the flows and the unit tests are never imported by the bundle:
    // skipped here so a gate does not read ~2300 files to discard a third of them
    // (`appCacheKey` applies the same rule, so the key is the same either way).
    if (isHarnessOrTest(path)) {
      continue;
    }
    try {
      // RAW bytes, never `readFile(…, "utf8")`: fonts and PNGs are not UTF-8,
      // and a lossy decode made two different binaries hash the same.
      files.push({ path, content: await readFile(join(repo, path)) });
    } catch {
      // A tracked file deleted from the worktree: a DIFFERENT key from one that
      // never existed, so the deletion is part of what a build would see.
      files.push({ path, content: DELETED });
    }
  }
  return files;
}

/**
 * The app to install on a simulator: `--app` verbatim, else a cached build of
 * exactly this tree, else a fresh Release build (which is then cached). Returns
 * the build's exit code, or 0 when the app is installed.
 *
 * A cache failure NEVER fails a gate (a build that worked still runs); it is a
 * warning, because the goal is speed, not a new way to be red.
 */
export async function resolveApp(options: {
  readonly device: string;
  readonly runDir: string;
  /** The major whose build/prebuild logs this run writes. */
  readonly major: IosMajor;
  readonly app: string | undefined;
  readonly noAppCache: boolean;
  readonly repo?: string;
  readonly cacheDir?: string;
  readonly log?: (line: string) => void;
}): Promise<{ readonly code: number; readonly appPath: string | undefined }> {
  const repo = options.repo ?? REPO;
  const log = options.log ?? ((line: string) => console.log(line));
  const install = async (appPath: string): Promise<number> =>
    (await $`xcrun simctl install ${options.device} ${appPath}`.nothrow()).exitCode;
  if (options.app !== undefined) {
    return { code: await install(options.app), appPath: options.app };
  }
  const cacheDir = options.cacheDir ?? APP_CACHE_DIR;
  let key: string | undefined;
  let extras: { xcode: string; bun: string } | undefined;
  try {
    const xcode = await versionOf("xcodebuild", "-version");
    extras = { xcode: xcode ?? "(no xcodebuild)", bun: Bun.version };
    key = appCacheKey(await appCacheInputs(repo), extras);
  } catch (error) {
    log(`app: no cache key (${error instanceof Error ? error.message : String(error)}) — building`);
  }
  const entryDir = key === undefined ? undefined : join(cacheDir, key);
  const cached = entryDir === undefined ? undefined : join(entryDir, "tentacle.app");
  if (entryDir !== undefined && cached !== undefined && !options.noAppCache) {
    if (existsSync(join(cached, "Info.plist"))) {
      const code = await install(cached);
      if (code === 0) {
        const builtIn = readCachedRunId(entryDir) ?? "?";
        log(`app: cached ${key?.slice(0, 12)} (built in run ${builtIn})`);
        return { code, appPath: cached };
      }
      // A cached app the simulator refuses is a MISS, not a red: rebuild below.
      log(`app: cached ${key?.slice(0, 12)} failed to install (${code}) — building`);
    } else {
      // A dir without its Info.plist is a half-written entry (a crashed copy):
      // remove it so the store below is free to take the key.
      await rm(entryDir, { recursive: true, force: true });
    }
  }
  const code = await buildAndInstall(options.device, options.runDir, options.major);
  if (code !== 0) {
    return { code, appPath: undefined };
  }
  let built: string | undefined;
  try {
    built = builtAppPath(
      await readFile(join(options.runDir, `build-ios${options.major}.log`), "utf8"),
    );
  } catch {
    built = undefined;
  }
  if (built === undefined) {
    log("app not cached: no install path in build log");
    return { code, appPath: undefined };
  }
  log(`app: built ${built}`);
  if (key !== undefined && entryDir !== undefined) {
    await storeApp({
      built,
      entryDir,
      key,
      runId: options.runDir.split(/[/\\]/).pop() ?? "",
      cacheDir,
      log,
    });
  }
  return { code, appPath: built };
}

/** The run id a cached build records (`meta.json`), for the `app: cached` line. */
function readCachedRunId(entryDir: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(entryDir, "meta.json"), "utf8")) as {
      runId?: unknown;
    };
    return typeof meta.runId === "string" ? meta.runId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copy a just-built app into the cache: a tmp dir then one `rename`, so a
 * concurrent reader never sees a half-copied `.app` (and two builds of the same
 * key cannot interleave — the loser discards its tmp).
 */
async function storeApp(options: {
  readonly built: string;
  readonly entryDir: string;
  readonly key: string;
  readonly runId: string;
  readonly cacheDir: string;
  readonly log: (line: string) => void;
}): Promise<void> {
  const tmp = `${options.entryDir}.tmp-${process.pid}`;
  try {
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    const app = join(tmp, "tentacle.app");
    await cp(options.built, app, { recursive: true });
    await writeFile(
      join(tmp, "meta.json"),
      `${JSON.stringify({ key: options.key, runId: options.runId, builtAt: new Date().toISOString() }, null, 2)}\n`,
    );
    if (existsSync(options.entryDir)) {
      // Another run stored this exact key while we built: keep theirs.
      await rm(tmp, { recursive: true, force: true });
    } else {
      await rename(tmp, options.entryDir);
      options.log(`app: cached ${options.key.slice(0, 12)} for the next run`);
    }
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    options.log(
      `app not cached: ${error instanceof Error ? error.message : String(error)} (the run proceeds)`,
    );
    return;
  }
  // Eviction: keep the newest APP_CACHE_KEEP entries. Never fails the gate.
  try {
    const entries = readdirSync(options.cacheDir)
      .filter((name) => !name.includes(".tmp-"))
      .map((name) => ({ key: name, mtimeMs: statSync(join(options.cacheDir, name)).mtimeMs }));
    for (const key of cacheEvictions(entries, APP_CACHE_KEEP)) {
      await rm(join(options.cacheDir, key), { recursive: true, force: true });
    }
  } catch {
    // A cache that cannot prune itself is still a working cache.
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
  readonly token: string;
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
    promptOnce: () => promptOnce(deps.url, deps.token),
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
async function promptOnce(url: string, token: string): Promise<void> {
  const factory = webSocketChannelFactory(url, { token });
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
  // The payload is written under the run's OWN scratch dir and removed after. The
  // name carries the PID: two runs (a parallel pair, or a worktree) share
  // `RUNS_DIR`, and a same-millisecond name would let one remove the other's
  // file before `simctl push` read it (docs/feat/e2e-parallel-gate.md).
  const file = join(RUNS_DIR, `push-payload-${process.pid}-${Date.now()}.json`);
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
  // docs/feat/mobile-mascot-scenes.md: Polpetto's random scene on new empty sessions, light + dark (visual).
  "40-mascot-shots",
  // docs/feat/mobile-file-view.md: the coloured file bodies (Write, Read of an
  // html, Edit, MultiEdit), collapsed and open, light + dark (visual).
  "41-file-view-shots",
  // docs/feat/mobile-native-sheets.md S6: the five native sheets' detents, light +
  // dark — each opens at M, and Tools is dragged M → L → S (its ONE scroller is
  // what a drag expands). Its own session.
  "42-native-sheets-shots",
  "35-gallery-shots",
  // docs/feat/mobile-theme-beta.md: the Figtree try-out, OFF vs ON, light + dark.
  "36-theme-beta-shots",
  // docs/fix/mobile-transcript-type.md: the transcript's type (prose, a Bash
  // step, a Thought row, a bold list), light + dark — on a session of its own.
  "41-transcript-type-shots",
  // docs/feat/mobile-file-preview-cards.md: the transcript's preview cards (a
  // PDF page, an image, markdown lines, an HTML page), light and dark.
  "36-preview-cards",
  // docs/fix/mobile-running-row.md: the live running row (a described shell's
  // sentence, the blinking node, the Thinking footer) and its tap detail, with
  // the beta theme and compactShell off and on — on a session of its own.
  "38-running-row",
  // docs/feat/mobile-projects.md: two projects of one computer (a second `serve`
  // on the same config dir) — stop, re-probe, revoke one, the other stays.
  "37-projects",
  // docs/feat/mobile-lock.md: the lock and the log export. LAST, because these
  // are the only flows that CHANGE the lock setting (they leave `immediately`
  // behind in the Keychain, which `clearKeychain` in `_pair` resets anyway).
  "18-lock-cold-start",
  "19-lock-unlock-button",
  "20-lock-immediately",
  // docs/feat/mobile-native-sheets.md S3's L1, driven in S6: a native sheet up, the
  // app leaves the screen, and the lock cover STILL wins (the drain pops the sheet,
  // and it is back after the unlock). Here, with the other lock flows, because it
  // changes the lock setting too.
  "43-native-sheets-lock",
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
  "40-mascot-shots": "HUBITEM_ID",
  "41-file-view-shots": "FILEVIEW_ID",
  // docs/feat/mobile-native-sheets.md S6: the native sheets' shots + the lock drain,
  // one session each, created just before the flow runs.
  "42-native-sheets-shots": "NATIVESHEETS_ID",
  "43-native-sheets-lock": "SHEETLOCK_ID",
  // docs/feat/mobile-gallery-polish.md: the gallery's six chart kinds + a page.
  "35-gallery-shots": "GALLERY_ID",
  // docs/feat/mobile-theme-beta.md: the try-out's chat + gallery.
  "36-theme-beta-shots": "THEMEBETA_ID",
  "36-preview-cards": "PREVIEW_ID",
  "38-running-row": "RUNROW_ID",
  // docs/fix/mobile-transcript-type.md: the transcript's type, dark + light.
  "41-transcript-type-shots": "TRANSCRIPT_ID",
};

/** One attempt's spawn + timeout, in a form a test can drive (review round 1 F3). */
export interface AttemptOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /** The attempt is killed after this long. */
  readonly timeoutMs: number;
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
  // Ctrl+C must reach the tree this spawns, which the terminal's own SIGINT no
  // longer does (review round 2 R1). Installed here because THIS is what
  // detaches, and only for the attempt's life: `E2E_HOLD` waits on its own
  // SIGINT after the flows, then writes the summary.
  const removeSignalReap = installSignalReap();
  try {
    return await attemptOnce(argv, opts);
  } finally {
    removeSignalReap();
  }
}

async function attemptOnce(
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
  // In the reap set for as long as it lives, so a signal takes it too.
  children.add(child);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killFlowTree(child.pid);
  }, opts.timeoutMs);
  const code = await child.exited;
  children.delete(child);
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

/** Kill every child this run started, each with the group it leads. */
export function reapAll(): void {
  for (const child of children) {
    child.kill();
    // A flow attempt leads its own group (`runAttempt`, detached): reap the
    // JVM/driver it started too. A no-op for a child that leads no group.
    killFlowTree(child.pid);
  }
  children.clear();
}

/**
 * Ctrl+C (or SIGTERM) must take the attempt's tree with it (review round 2 R1).
 * `runAttempt` spawns detached, so the terminal's own SIGINT never reaches the
 * Maestro JVM and the XCTest driver: without this, a signal ends Bun without its
 * `finally` (`reapAll`) and an orphaned driver holds the simulator's driver
 * port for the next run. Reap, then exit with the conventional code. Returns
 * the remover (`runAttempt` installs it per attempt).
 */
export function installSignalReap(): () => void {
  const signals = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const;
  const handlers = signals.map(([signal, code]) => {
    const handler = () => {
      reapAll();
      process.exit(code);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
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
  // The seeded ids the flows interpolate come from ONE map (`shard.ts`), the
  // same one the splitter unions over: a new seeded session cannot be handed to
  // the flows yet stay invisible to "these flows cannot be separated".
  const seededValues = seedValues(seeded);
  const { code, timedOut } = await runAttempt(
    [
      "maestro",
      "--device",
      device,
      "test",
      // Maestro's OWN env flags (`-e K=V`): its `${VAR}` substitution reads
      // these, NOT the process environment (a shell export is invisible to it).
      ...envFlags({
        ...seededValues,
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
    },
  );
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
