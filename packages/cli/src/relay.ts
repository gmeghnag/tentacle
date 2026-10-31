/**
 * The relay of a detached run (docs/feat/detached-relay.md): a laptop process
 * with no TUI that keeps a pod session's model link, its one permission broker
 * and its laptop save going. The model stays on the laptop (AGENTS §7), so a run
 * with no terminal still needs a process here. It is `attachEngineRuntime`, the
 * one session path, with no Ink: the agent stays in the pod.
 *
 * `run --detach` provisions in the foreground, then `launchRelay` spawns this
 * detached and waits for it to start. The relay leaves when the session is idle
 * (`relay-state.ts`), on SIGTERM/SIGINT (the turn is cancelled and saved) or when
 * the link stops. It only ever DETACHES: a `dispose` would close the session.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@tentacle/config";
import { PermissionBroker } from "@tentacle/core";
import type { EngineHost } from "./engine-host.ts";
import { attachEngineRuntime } from "./engine-runtime.ts";
import { buildEngineHost, hostOptionsFor } from "./engine-select.ts";
import { keptDir, readKept } from "./kept-index.ts";
import type { KeptEntry } from "./kept.ts";
import type { LocalRuntime } from "./local-runtime.ts";
import { type ProcOf, acquireResidentLock, selfCommand } from "./pod-resident.ts";
import { relayPolicy } from "./relay-policy.ts";
import {
  type RelayEvent,
  type RelayView,
  finalView,
  initialRelay,
  relayExits,
  relayStep,
  relayView,
} from "./relay-state.ts";
import {
  RELAY_SPEC_ENV,
  RELAY_SUBCOMMAND,
  RUN_STATE_VERSION,
  type RelaySpec,
  createRelayLog,
  ensureRunDir,
  laptopProc,
  logTail,
  ownerPath,
  readOwner,
  readSpec,
  relayLogPath,
  runDirFor,
  runStem,
  writeOwner,
  writeSpec,
} from "./run-state.ts";
import { openTuiSessions } from "./tui-sessions.ts";
import { untrustedText } from "./untrusted-text.ts";
import { APP_VERSION } from "./version.ts";

/** How often the relay looks at its state. */
const RELAY_TICK_MS = 1000;
/** How often it reads the session's jobs once the turn is over. */
const RELAY_JOBS_POLL_MS = 30_000;
/** How long the launcher waits for the relay to start. */
const LAUNCH_TIMEOUT_MS = 60_000;

/** SIGTERM/SIGINT stop the relay; a second one exits at once. */
function stopOnSignals(stop: () => void): () => void {
  let stopped = false;
  const onSignal = (): void => {
    if (stopped) {
      process.exit(130);
    }
    stopped = true;
    stop();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
}

export interface RelayDeps {
  readonly config: Parameters<typeof attachEngineRuntime>[0];
  readonly spec: RelaySpec;
  readonly entry: KeptEntry;
  /** Default: the kept entry's own location. */
  readonly hostFor?: (entry: KeptEntry) => EngineHost;
  /** Default `attachEngineRuntime`; tests wire an in-memory resident. */
  readonly attach?: typeof attachEngineRuntime;
  /** Default `laptopProc`. */
  readonly procOf?: ProcOf;
  readonly now?: () => number;
  readonly tickMs?: number;
  readonly jobsPollMs?: number;
  /** Default SIGTERM/SIGINT; returns the undo. */
  readonly onStop?: (stop: () => void) => () => void;
}

/** Run one detached session to its end; the exit code. Only a run dir it cannot make throws. */
export async function runRelay(deps: RelayDeps): Promise<number> {
  const { config, spec, entry } = deps;
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? RELAY_TICK_MS;
  const jobsPollMs = deps.jobsPollMs ?? RELAY_JOBS_POLL_MS;
  const dir = ensureRunDir(runDirFor(config.configDir, entry));
  const log = createRelayLog(dir, now);

  let lock: { release(): void };
  try {
    lock = acquireResidentLock(dir, deps.procOf ?? laptopProc);
  } catch (error) {
    log(`not started: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  // AGENTS §7: an on-disk record this build cannot read is refused, never
  // rewritten. Under the lock: only a relay writes this file.
  if (readOwner(dir).kind === "unknown") {
    log(
      `not started: ${ownerPath(dir)} is not readable by this version: left untouched, delete that file to run under this name`,
    );
    lock.release();
    return 1;
  }

  let model = initialRelay;
  let written = "";
  const record = (view: RelayView): void => {
    const key = JSON.stringify(view);
    if (key === written) {
      return;
    }
    written = key;
    log(`state: ${view.state}${view.tool ? ` (${view.tool})` : ""} ${view.detail ?? ""}`);
    try {
      writeOwner(dir, {
        schemaVersion: RUN_STATE_VERSION,
        kind: "relay",
        pid: process.pid,
        appVersion: APP_VERSION,
        sessionId: spec.sessionId,
        lastActivityAt: now(),
        autoAccept: spec.autoAccept,
        ...view,
      });
    } catch (error) {
      log(`owner.json not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const emit = (event: RelayEvent): void => {
    model = relayStep(model, event);
    record(relayView(model));
  };
  record(relayView(model));

  const stopSignal = new AbortController();
  const offStop = (deps.onStop ?? stopOnSignals)(() => {
    emit({ type: "stop" });
    stopSignal.abort();
  });
  const leave = (): number => {
    offStop();
    record(finalView(model));
    log("relay exit");
    lock.release();
    return finalView(model).state === "failed" ? 1 : 0;
  };

  const policy = relayPolicy({ autoAccept: spec.autoAccept, emit, log });
  // THE broker (AGENTS §7): the runtime's `RemoteClient` asks here, and nobody
  // else may: a second one's default would silently approve everything.
  const permissions = new PermissionBroker(policy.requester, { holdUntilSet: true });
  const sessions = await openTuiSessions(
    { root: join(config.configDir, "sessions"), cwd: config.cwd },
    { wanted: false },
    log,
  );
  if ("exit" in sessions) {
    emit({ type: "turn_failed", message: "the session store could not be opened" });
    return leave();
  }
  const { saver, notices } = sessions;
  notices.onNotice(log);

  let runtime: LocalRuntime;
  try {
    runtime = await (deps.attach ?? attachEngineRuntime)(config, {
      host: (deps.hostFor ?? ((e) => buildEngineHost(e.engine, hostOptionsFor(e)).host))(entry),
      name: entry.name,
      ...(entry.binDir ? { binDir: entry.binDir } : {}),
      permissions,
      saver,
      resume: null,
      interactive: false,
      sessionId: spec.sessionId,
      log,
      notify: log,
    });
  } catch (error) {
    emit({
      type: "turn_failed",
      message: untrustedText(error instanceof Error ? error.message : String(error)),
    });
    return leave();
  }
  const offLink = runtime.link.onLinkStatus((status) => {
    emit({ type: "link", status });
  });

  const session = runtime.createSession();
  policy.bindOwnsTurn((turnId) => session.ownsTurn(turnId));
  const drive = async (): Promise<void> => {
    emit({ type: "turn_started" });
    let reason = "end_turn";
    try {
      for await (const event of session.send(spec.prompt, stopSignal.signal)) {
        if (event.type === "turn_end") {
          reason = event.reason;
        } else if (event.type === "tool_start") {
          log(`tool: ${event.name}`);
        }
      }
      log(`turn end: ${reason}`);
      emit({ type: "turn_ended", reason });
    } catch (error) {
      emit({
        type: "turn_failed",
        message: untrustedText(error instanceof Error ? error.message : String(error)),
      });
    }
  };
  if (!stopSignal.signal.aborted) {
    void drive();
  }

  let nextPoll = 0;
  let polling = false;
  const pollJobs = (): void => {
    polling = true;
    void runtime.sessionJobs(spec.sessionId).then((n) => {
      polling = false;
      // Unreadable: the last value stands, the next poll tells.
      if (n !== null) {
        emit({ type: "jobs", n });
      }
    });
  };
  // Never awaits the daemon here: a pod that stops answering cannot pin the loop.
  while (!relayExits(model, now())) {
    emit({ type: "tick", now: now() });
    if (model.turn === "over" && !polling && now() >= nextPoll) {
      nextPoll = now() + jobsPollMs;
      pollJobs();
    }
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }

  offLink();
  await runtime.release();
  for (const line of await saver.drain()) {
    log(line);
  }
  return leave();
}

/** The relay subcommand: its spec from the env, then `runRelay`. */
export async function relayMain(
  env: NodeJS.ProcessEnv = process.env,
  writeErr: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<number> {
  const path = env[RELAY_SPEC_ENV];
  if (!path) {
    writeErr(`[relay] ${RELAY_SPEC_ENV} is not set: this is not a command to run by hand\n`);
    return 1;
  }
  try {
    const spec = readSpec(path);
    rmSync(path, { force: true });
    const config = await loadConfig({
      cwd: spec.cwd,
      scaffold: false,
      ...(spec.profile !== undefined ? { profile: spec.profile } : {}),
    });
    const kept = readKept(keptDir(config.configDir));
    const entry = kept.entries.find((e) => runStem(e.entry) === spec.stem)?.entry;
    if (!entry) {
      writeErr(`[relay] kept entry ${spec.stem} not found\n`);
      return 1;
    }
    return await runRelay({ config, spec, entry });
  } catch (error) {
    writeErr(`[relay] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** A spawned relay, as the launcher watches it. */
export interface RelayChild {
  exited(): boolean;
}

/** Start the relay: its own session, stdio on the log, unref'd. */
export function spawnRelayProcess(specFile: string, cwd: string, dir: string): RelayChild {
  const fd = openSync(relayLogPath(dir), "a", 0o600);
  let exited = false;
  try {
    const [command, ...args] = [...selfCommand(), RELAY_SUBCOMMAND];
    if (command === undefined) {
      throw new Error("no relay command");
    }
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, [RELAY_SPEC_ENV]: specFile },
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    const gone = (): void => {
      exited = true;
    };
    child.once("exit", gone);
    child.once("error", gone);
    child.unref();
  } finally {
    closeSync(fd);
  }
  return { exited: () => exited };
}

export interface LaunchDeps {
  readonly write: (text: string) => void;
  /** `[noun]` of the lines. */
  readonly noun: string;
  readonly name: string;
  /** `tentacle attach …` for this workload. */
  readonly attachHint: string;
  /** Default `spawnRelayProcess`. */
  readonly spawnRelay?: (specFile: string, cwd: string, dir: string) => RelayChild;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Hand a ready workload to a relay: write the spec, spawn, and wait until it
 * left `starting` (its turn is on), so a run that could not start is said here.
 * Exit 1 with the log's tail if it died; the workload stays for `attach` or `rm`.
 */
export async function launchRelay(dir: string, spec: RelaySpec, deps: LaunchDeps): Promise<number> {
  const { write, noun, name } = deps;
  const now = deps.now ?? Date.now;
  const logPath = relayLogPath(dir);
  const failed = (): number => {
    write(`[${noun}] ${name}: the detached run did not start\n`);
    for (const line of logTail(dir)) {
      write(`  ${line}\n`);
    }
    // `rm` leaves the run dir, so it would not lift this refusal.
    const wayOut =
      readOwner(dir).kind === "unknown"
        ? `, or delete ${ownerPath(dir)} to run under this name`
        : `, or \`tentacle rm ${name}\``;
    write(`[${noun}] ${name} stays up: \`${deps.attachHint}\`${wayOut} (log: ${logPath})\n`);
    return 1;
  };
  let child: RelayChild;
  try {
    const specFile = writeSpec(ensureRunDir(dir), spec);
    child = (deps.spawnRelay ?? spawnRelayProcess)(specFile, spec.cwd, dir);
  } catch (error) {
    write(
      `[${noun}] ${name}: ${untrustedText(error instanceof Error ? error.message : String(error))}\n`,
    );
    return failed();
  }
  const deadline = now() + (deps.timeoutMs ?? LAUNCH_TIMEOUT_MS);
  while (now() < deadline) {
    const read = readOwner(dir);
    // Another run's file (the name reused) says nothing about this one.
    const owner = read.kind === "owner" && read.owner.sessionId === spec.sessionId && read.owner;
    if (owner && owner.state === "failed") {
      return failed();
    }
    if (owner && owner.state !== "starting") {
      const policy = spec.autoAccept
        ? `auto-accepting pod tool asks (allow once; logged in ${logPath})`
        : "it waits at the first permission";
      write(
        `[${noun}] ${name}: detached run started (pid ${owner.pid}), ${policy}. Re-attach once it is done: ${deps.attachHint} --resume ${spec.sessionId}\n`,
      );
      return 0;
    }
    if (child.exited()) {
      return failed();
    }
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? 100));
  }
  write(`[${noun}] ${name}: the relay has not started yet, see ${logPath}\n`);
  return 0;
}
