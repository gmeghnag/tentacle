/**
 * The relay of a detached run (docs/feat/detached-relay.md): a laptop process
 * with no TUI that keeps a pod session's model link, its one permission broker
 * and its laptop save going. The model stays on the laptop (AGENTS §7), so a run
 * with no terminal still needs a process here. It is `attachEngineRuntime`, the
 * one session path, with no Ink: the agent stays in the pod.
 *
 * `run --detach` provisions in the foreground, then `launchRelay` spawns this
 * detached and waits for it to start. The relay leaves when the session is idle
 * (`relay-state.ts`), on SIGTERM/SIGINT (the turn is cancelled and saved; a turn
 * that outlives the bound is not, and the workload is then kept) or when
 * the link stops. It only ever DETACHES: a `dispose` would close the session.
 * Its exit net (a crash, a second signal) deletes only a confirmed save (R6).
 *
 * `--keep=false` (docs/feat/detached-relay-lifecycle.md): on a normal exit the
 * relay removes the workload, `exitPlan` alone deciding. The order is the safety
 * argument: the lock is taken before the net is armed (a relay refused by the
 * lock must never delete anything), the session is detached and saved before the
 * delete, and the lock outlives it, so no `attach` slips in.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@tentacle/config";
import { PermissionBroker } from "@tentacle/core";
import {
  type ControlPeer,
  type ControlReply,
  type ControlRequest,
  type ControlServer,
  controlSocketPath,
  serveControl,
} from "./control-socket.ts";
import type { EngineHost } from "./engine-host.ts";
import { armExitNet, attachEngineRuntime } from "./engine-runtime.ts";
import { buildEngineHost, hostOptionsFor } from "./engine-select.ts";
import { type KeepAwakeOptions, createKeepAwake } from "./keep-awake.ts";
import { type KeptRemoval, bounded, removalFate, removeVerifiedKept } from "./kept-cmd.ts";
import { keptDir, keptFileName, readKept } from "./kept-index.ts";
import type { KeptEntry } from "./kept.ts";
import { FLUSH_ON_EXIT_TIMEOUT_MS, type LocalRuntime } from "./local-runtime.ts";
import { type ProcOf, acquireResidentLock, selfCommand } from "./pod-resident.ts";
import { relayPolicy } from "./relay-policy.ts";
import {
  type ExitPlan,
  type RelayEvent,
  type RelayView,
  type ResidentUse,
  exitPlan,
  finalView,
  initialRelay,
  needsUse,
  relayExits,
  relayStep,
  relayView,
  wantsAwake,
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
/** How long the read before a removal may take: unanswered, the workload stays. */
const USE_READ_TIMEOUT_MS = 5000;
/** How long the removal itself may take. */
const REMOVE_TIMEOUT_MS = 30_000;
/** A prepared hand-over aborts if no `commit` came by then (docs/feat/detached-handover.md). */
const HANDOVER_LEASE_MS = 30_000;
/** The relay's last save before the `commit` ack. */
const HANDOVER_SAVE_MS = 10_000;
/** After the ack, how long the model calls the relay serves may still run. */
const HANDOVER_DRAIN_MS = 5 * 60_000;

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
  /** Default `armExitNet`; returns the disarm. */
  readonly armNet?: typeof armExitNet;
  readonly useTimeoutMs?: number;
  readonly removeTimeoutMs?: number;
  /** Default this process's platform and a real `caffeinate`. */
  readonly keepAwake?: Partial<Pick<KeepAwakeOptions, "platform" | "spawn">>;
  /** Where the control socket goes; default `controlSocketPath` (`null`: no socket). */
  readonly controlPath?: (dir: string, stem: string) => string | null;
  /** How long a prepared hand-over may wait for its `commit`. */
  readonly leaseMs?: number;
  /** How long the relay drains the model calls it serves after a hand-over. */
  readonly drainMs?: number;
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

  const awake = createKeepAwake({
    platform: deps.keepAwake?.platform ?? process.platform,
    enabled: config.detach?.keepAwake ?? true,
    pid: process.pid,
    ...(deps.keepAwake?.spawn ? { spawn: deps.keepAwake.spawn } : {}),
    log,
  });
  // The hand-over's socket (docs/feat/detached-handover.md); off its usual
  // path it is recorded, so an `attach` finds it.
  const controlAt = (
    deps.controlPath ??
    ((d: string, stem: string) =>
      controlSocketPath(d, stem, { tmp: tmpdir(), uid: process.getuid?.() ?? 0 }))
  )(dir, spec.stem);
  let model = initialRelay;
  let written = "";
  // The run's turn's id, minted here and in every record from the first: a
  // TUI that takes the run over owns that turn (docs/fix/detach-live.md B2).
  const runTurnId = crypto.randomUUID();
  const record = (view: RelayView): void => {
    // Handed over: the run's record is the TUIs' now (never two writers).
    if (model.handover === "done") {
      return;
    }
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
        keep: spec.keep,
        cwd: spec.cwd,
        created: entry.created,
        runTurnId,
        ...(controlAt !== null && controlAt !== join(dir, "control.sock")
          ? { control: controlAt }
          : {}),
        ...view,
      });
    } catch (error) {
      log(`owner.json not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const emit = (event: RelayEvent): void => {
    model = relayStep(model, event);
    record(relayView(model));
    awake.set(wantsAwake(model));
  };
  record(relayView(model));

  // The hand-over (docs/feat/detached-handover.md): who prepared it, its lease,
  // whether its commit began (irrevocable from there), and whether the exit
  // plan is final (`leaving`: a `prepare` after it is refused).
  let preparer: ControlPeer | null = null;
  let lease: ReturnType<typeof setTimeout> | undefined;
  let committing = false;
  let stopAfterCommit = false;
  let leaving = false;
  let control: ControlServer | null = null;
  /** Back to the relay: its net, its policy, its idle exit. Set once `runRelay` can. */
  let abortHandover = (_why: string): void => {};

  const stopSignal = new AbortController();
  const offStop = (deps.onStop ?? stopOnSignals)(() => {
    if (committing || model.handover === "done") {
      // Handed over: the turn is the TUIs' (P2: aborting `send` would cancel
      // it); only the drain is cut short.
      stopAfterCommit = true;
      if (model.handover === "done") {
        emit({ type: "drained" });
      }
      return;
    }
    abortHandover("the relay was stopped");
    emit({ type: "stop" });
    stopSignal.abort();
  });
  let disarmNet = (): void => {};
  /**
   * The net's save check (docs/fix/detach-live.md R6, owner 2026-11-02): a crash
   * or a second SIGTERM deletes only once the turn ended and its save is
   * confirmed on the laptop. No runtime yet: nothing is, so the workload stays.
   */
  let netSaved = (): boolean => false;
  const keptNote = `not saved — workload kept: tentacle rm ${entry.name}`;
  /** At exit, the net kept it: the record says so (synchronous write), `ps` shows it. */
  const netKept = (): void => {
    model = relayStep(model, { type: "note", detail: keptNote });
    record(finalView(model)); // the process ends here: a turn cut short is `interrupted`
  };
  /** `purge` (Q4): the workload is gone, so its run dir goes, the lock with it. */
  const leave = (purge = false): number => {
    preparer = null; // the plan is final: a socket closing now aborts nothing, re-arms nothing
    control?.close();
    clearTimeout(lease);
    disarmNet();
    offStop();
    awake.stop();
    record(finalView(model));
    log("relay exit");
    if (purge) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        log(`run dir not deleted: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    lock.release();
    return finalView(model).state === "failed" ? 1 : 0;
  };

  let host: EngineHost;
  try {
    host = (deps.hostFor ?? ((e) => buildEngineHost(e.engine, hostOptionsFor(e)).host))(entry);
  } catch (error) {
    emit({
      type: "turn_failed",
      message: untrustedText(error instanceof Error ? error.message : String(error)),
    });
    return leave();
  }
  // Under the lock: a relay refused by it must never delete a workload that
  // another relay is using. Covers a crash; a SIGKILL or a power loss leaves the
  // workload, listed in `ps`.
  if (!spec.keep) {
    disarmNet = (deps.armNet ?? armExitNet)(host, entry.name, () => netSaved(), netKept);
  }

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
      host,
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
  netSaved = () => model.turn !== "running" && runtime.saveConfirmed();

  const session = runtime.createSession();
  policy.bindOwnsTurn((turnId) => session.ownsTurn(turnId));
  const drive = async (): Promise<void> => {
    emit({ type: "turn_started" });
    let reason = "end_turn";
    try {
      for await (const event of session.send(spec.prompt, stopSignal.signal, {
        turnId: runTurnId,
      })) {
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

  abortHandover = (why) => {
    if (preparer === null || committing || model.handover !== "prepared") {
      return;
    }
    const peer = preparer;
    preparer = null;
    clearTimeout(lease);
    peer.close(); // a late `commit` finds the socket closed
    if (!spec.keep) {
      disarmNet = (deps.armNet ?? armExitNet)(host, entry.name, () => netSaved(), netKept);
    }
    policy.thaw();
    emit({ type: "handover_aborted" });
    log(`hand-over aborted: ${why}`);
  };
  const onControl = async (request: ControlRequest, peer: ControlPeer): Promise<ControlReply> => {
    if (request.op === "prepare") {
      if (model.stopping) {
        return { ok: false, reason: "stopped" };
      }
      if (committing || model.handover === "done") {
        return { ok: false, reason: "handed_over" };
      }
      if (leaving) {
        return { ok: false, reason: "leaving" };
      }
      if (preparer !== null) {
        return { ok: false, reason: "busy" };
      }
      if (request.sessionId !== spec.sessionId) {
        return { ok: false, reason: "session" };
      }
      // BEFORE the attacher opens (D5): from here the relay decides nothing.
      preparer = peer;
      disarmNet();
      disarmNet = () => {};
      policy.freeze();
      emit({ type: "handover_prepared" });
      lease = setTimeout(
        () => abortHandover("no commit within the lease"),
        deps.leaseMs ?? HANDOVER_LEASE_MS,
      );
      log("hand-over prepared");
      return { ok: true, appVersion: APP_VERSION };
    }
    if (peer !== preparer || committing || model.handover !== "prepared") {
      return { ok: false, reason: "invalid" };
    }
    // Irrevocable from here: the relay's last save is on disk before the ack,
    // and none follows it (the TUIs save from their mount on).
    committing = true;
    clearTimeout(lease);
    await bounded(runtime.flushed(), HANDOVER_SAVE_MS / 2).catch(() => {});
    runtime.stopSaving();
    for (const line of await bounded(saver.drain(), HANDOVER_SAVE_MS / 2).catch(() => [])) {
      log(line);
    }
    emit({ type: "handed_over" });
    log("handed over");
    void runtime.modelIdle(deps.drainMs ?? HANDOVER_DRAIN_MS).then(() => {
      log("drained");
      emit({ type: "drained" });
    });
    if (stopAfterCommit) {
      emit({ type: "drained" });
    }
    return { ok: true };
  };
  if (controlAt !== null && !stopSignal.signal.aborted) {
    try {
      control = await serveControl(controlAt, {
        onRequest: onControl,
        onClose: (peer) => {
          if (peer === preparer) {
            abortHandover("the attacher went away");
          }
        },
      });
    } catch (error) {
      log(`no control socket: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (controlAt === null) {
    log("no control socket: no private place for it (the run cannot be handed over)");
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
  /** One fresh read; unanswered is unreadable: the polled `jobs` may be stale. */
  const readUse = (): Promise<ResidentUse | null> =>
    bounded(runtime.residentUse(spec.sessionId), deps.useTimeoutMs ?? USE_READ_TIMEOUT_MS).catch(
      () => null,
    );
  let plan: ExitPlan;
  for (;;) {
    // Never awaits the daemon here: a pod that stops answering cannot pin the loop.
    while (!relayExits(model, now())) {
      emit({ type: "tick", now: now() });
      if (model.turn === "over" && !polling && now() >= nextPoll) {
        nextPoll = now() + jobsPollMs;
        pollJobs();
      }
      await new Promise((resolve) => setTimeout(resolve, tickMs));
    }
    const use = model.handover === "none" && needsUse(model, spec.keep) ? await readUse() : null;
    // On the state after the read: a stop, or a `prepare`, may have landed during it.
    plan = exitPlan(model, spec.keep, use);
    if (plan.kind !== "hold") {
      // In the same tick as the final plan: a `prepare` from here is `leaving`.
      leaving = true;
      break;
    }
    if (model.handover === "none") {
      log("still in use: not removed yet");
      emit({ type: "jobs", n: use?.jobs ?? 0 });
    }
    emit({ type: "busy" });
  }
  if (plan.kind === "leave" && plan.why !== undefined) {
    log(`workload kept: ${plan.why}`);
    emit({ type: "note", detail: plan.why });
  }

  // The laptop holds the session's last state only once its turn ended and
  // that save landed: `release` seals what comes later (docs/fix/detach-live.md,
  // fix round 3).
  const settled =
    model.turn !== "running" &&
    (await bounded(session.flushed(), FLUSH_ON_EXIT_TIMEOUT_MS).then(
      () => true,
      () => false,
    ));
  offLink();
  await runtime.release();
  const unsaved = await saver.drain();
  for (const line of unsaved) {
    log(line);
  }
  if (plan.kind !== "remove") {
    // keep=true (owner Q3, fix round 7): nothing is deleted here, but `ps` says
    // when the laptop copy lacks the last turn. Informational only; after a
    // hand-over the TUIs hold the save, so it is not this relay's to report.
    if (
      spec.keep &&
      model.handover === "none" &&
      finalView(model).state !== "failed" && // a failed run keeps its own reason
      (!settled || unsaved.length > 0)
    ) {
      emit({ type: "note", detail: "not saved — the laptop copy lacks the last turn" });
    }
    return leave();
  }
  // Owner decision (a): with no copy on the laptop the workload is the only
  // one, so it stays, said, never silent; `rm` converges.
  if (!settled || unsaved.length > 0) {
    log(keptNote);
    emit({ type: "note", detail: keptNote });
    return leave();
  }
  const removal = await bounded(
    removeVerifiedKept(entry, join(keptDir(config.configDir), keptFileName(entry)), {
      hostFor: () => host,
    }),
    deps.removeTimeoutMs ?? REMOVE_TIMEOUT_MS,
  ).catch(
    (error: unknown): KeptRemoval => ({
      kind: "failed",
      reason: untrustedText(error instanceof Error ? error.message : String(error)),
    }),
  );
  log(`removal: ${removal.kind}`);
  if (removal.kind === "unreachable" || removal.kind === "failed") {
    emit({ type: "note", detail: `not removed: ${removal.reason} — tentacle rm ${entry.name}` });
    return leave();
  }
  // The workload's fate is not "not removed"; only its index entry may have
  // survived, and that is NOT the same fact. Its own note, worded by what
  // actually happened (a `foreign` workload was never removed), and the run dir
  // stays (with the log) so `ps -v` shows it. It converges: `rm` sees `gone`
  // and clears both.
  if (removal.forgetError !== undefined) {
    emit({
      type: "note",
      detail: `${removalFate(removal.kind)}, but its entry in the kept index stayed: ${removal.forgetError} — tentacle rm ${entry.name}`,
    });
    return leave();
  }
  if (removal.kind === "foreign" || removal.kind === "other") {
    // Nothing was deleted: the name holds a workload this run no longer stands
    // for (R3). Said, never silent.
    emit({ type: "note", detail: removalFate(removal.kind) });
  }
  return leave(true);
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
  /** keep=false: a laptop folder is mounted, and stays. */
  readonly mounted?: boolean;
  /** The relay holds a sleep assertion during a turn (said once: the lid still sleeps it). */
  readonly keepsAwake?: boolean;
}

/** What the started line says about the workload's end. */
function endingOf(spec: RelaySpec, deps: LaunchDeps): string {
  const awake = deps.keepsAwake
    ? " The Mac stays awake while a turn runs; closing the lid still sleeps it."
    : "";
  // `attach <name>` takes a live run over at once (S3); `--resume` on it is refused.
  const attach = ` Attach any time: ${deps.attachHint}.`;
  if (spec.keep) {
    return `${attach}${awake}`;
  }
  const files = deps.mounted
    ? "files not in the mount go with it, and so does its log; the laptop folder is not touched"
    : `the ${deps.noun}'s files go with it, and so does its log`;
  return `${attach} The ${deps.noun} is removed when the run goes idle: ${files}; the transcript stays in \`tentacle --resume ${spec.sessionId}\`.${awake}`;
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
        : "a tool that needs permission waits for you";
      write(
        `[${noun}] ${name}: detached run started (pid ${owner.pid}), ${policy}.${endingOf(spec, deps)}\n`,
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
