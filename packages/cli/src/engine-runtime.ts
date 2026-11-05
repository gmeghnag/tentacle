/**
 * The engine runtime (F4.c, the `run` / `attach` commands): run the agent
 * daemon inside a workload — a Kubernetes pod or a Docker/Podman container,
 * behind one `EngineHost` (`engine-host.ts`) — driven from the local TUI,
 * reusing the SAME `RemoteClient` ↔ `Connection` stack as the worker and
 * remote-control paths. The only engine-specific parts are the host's transport
 * and lifecycle:
 *
 *   create → waitForReady → injectAgentBinary (F4.e: probe arch, stream the
 *   binary, verify with --version) → openExec(`tentacle serve --bridge`, a pipe
 *   to the pod's resident daemon — `pod-resident.ts`) →
 *   createLocalRuntime(handshake + persisting sessions) → …use… → remove
 *   (unless `run --keep`).
 *
 * The injection (F4.e) means the image no longer needs to contain the tool —
 * any Linux **glibc** image with `sh` + `head` works; see `pod-binary.ts`.
 *
 * The namespace is NOT pre-checked: the kubeconfig context's namespace is not
 * guaranteed to exist, but a `createPod` into a missing namespace fails with a
 * clear 404 that we translate into an actionable error (`podCreateError`) —
 * no side-effectful namespace creation by a "run" command.
 *
 * Persistence stays on the laptop (the `createLocalRuntime` saver), so the pod
 * is a stateless sandbox and `--resume` works locally.
 */
import type { SessionRecord } from "@tentacle/agent";
import type { TentacleConfig } from "@tentacle/config";
import type { ModelProvider, PermissionBroker } from "@tentacle/core";
import type { DuplexChannel } from "@tentacle/transport";
import type { TargetBadge } from "@tentacle/tui";
import {
  containerDecision,
  expectedContainerVersion,
  parseVersionLine,
  replaceFailedWarning,
  replacedNotice,
} from "./container-version.ts";
import {
  type EngineExecChannelOptions,
  type EngineExecTarget,
  type EngineHost,
  type EngineRunExecResult,
  RefusalError,
  WorkloadRemovedError,
  type WorkloadState,
} from "./engine-host.ts";
import { engineTarget } from "./engine-target.ts";
import { type LocalRuntime, createLocalRuntime } from "./local-runtime.ts";
import { configuredModelProvider } from "./model-provider.ts";
import { PodBinaryError, checkPodBinaries, resolvePodBinary } from "./pod-binary-build.ts";
import { injectAgentBinary, probePod } from "./pod-binary.ts";
import {
  residentGuard,
  residentSkewWarning,
  residentStatusCommand,
  residentStopCommand,
  residentStopVerdict,
} from "./pod-resident.ts";
import { markStillUp, openDaemonLog, recordFailure, tildePath } from "./pod-stderr-log.ts";
import type { SessionSaver } from "./session-saver.ts";
import { StatusLine } from "./status-line.ts";
import { type StreamTerm, termOf } from "./streams.ts";
import { untrustedText } from "./untrusted-text.ts";
import { readBinaryVersion } from "./version-marker.ts";
import { APP_VERSION } from "./version.ts";
import { type WorkspaceMount, attachCwdWarning } from "./workspace-mount.ts";

/**
 * The pod daemon's command line (`run` and `attach`): the BRIDGE to the pod's
 * resident daemon, started by the first exec and outliving it
 * (`pod-resident.ts`, docs/feat/detached-runs.md S1). `--auto-title` carries
 * the LAPTOP's `model.autoTitle` (docs/feat/session-titles.md): the pod's own
 * config never turns model titles on. `--context-window` carries the LAPTOP's
 * `model.contextWindow`: the window is the model's, and the model lives here
 * (docs/feat/context-awareness.md). Neither is a secret, so argv is fine. A
 * resident already running keeps the flags of the exec that started it.
 */
export function podDaemonCommand(
  bin: string,
  config: Pick<TentacleConfig, "autoTitle" | "contextWindow">,
): string[] {
  return [
    bin,
    "serve",
    "--bridge",
    "--model-proxy",
    "--context-window",
    String(config.contextWindow),
    ...(config.autoTitle ? ["--auto-title"] : []),
  ];
}

/**
 * The laptop's models the pod reaches through us (reverse-tunnel), so the
 * endpoint and API key never leave the laptop: the main one for turns and,
 * with `model.autoTitle`, the one for the pod's title calls
 * (`model.titleModel`, else the main one). Off → no title provider: the
 * laptop refuses a title call (the gate is here, not in the pod).
 */
export function laptopModels(config: TentacleConfig): {
  readonly modelProvider: ModelProvider;
  readonly titleModelProvider?: ModelProvider;
} {
  const modelProvider = configuredModelProvider(config);
  if (!config.autoTitle) {
    return { modelProvider };
  }
  const titleModelProvider =
    config.titleModel !== undefined
      ? configuredModelProvider(config, config.titleModel)
      : modelProvider;
  return { modelProvider, titleModelProvider };
}

/** A started runtime; `markFault` reports a failure only the caller sees (the TUI throwing). */
export type EngineRuntime = LocalRuntime & {
  /** The status bar's badge: engine + workload (+ container), laptop-side facts. */
  readonly target?: TargetBadge;
  readonly markFault?: () => void;
  /**
   * Say `<name> still running · tentacle attach <name>` (a kept run): the caller
   * calls it right before the TUI opens, so the line never precedes a setup
   * failure. Once; absent for a run that is not kept.
   */
  readonly announce?: () => void;
};

/**
 * Whether a run/attach FAILED, for the daemon-stderr rule (docs/feat/run-prompt.md
 * rounds 2-4): the link dropped or stopped (the daemon or the container died;
 * not our own close, reason `"closed"`), or the caller `mark`ed a failure (the
 * TUI itself threw). A model/turn error is NOT one: it was shown in the TUI.
 * The daemon's stderr never reaches the terminal either way (`pod-stderr-log.ts`);
 * a failure only adds ONE line naming the log (`quitReport`).
 */
export function createFaultWatch(): {
  readonly mark: () => void;
  readonly faulted: () => boolean;
  readonly watch: (runtime: Pick<LocalRuntime, "link">) => void;
} {
  // `marked`/`ended` latch; `down` follows the link: a reconnect that came back
  // `up` is NOT a fault (round 5), one still down at the end is.
  let marked = false;
  let ended = false;
  let down = false;
  return {
    mark: () => {
      marked = true;
    },
    faulted: () => marked || ended || down,
    watch: (runtime) => {
      runtime.link.onLinkStatus((status) => {
        if (status.state === "up") {
          down = false;
        } else if (status.state === "reconnecting") {
          down = true;
        } else if (status.reason !== "closed") {
          ended = true;
        }
      });
    },
  };
}

/**
 * The startup spinner, on the terminal `log` writes to (stderr by default) and
 * cut to ITS width; `null` when that is not a terminal: one line per phase then.
 */
function statusLineFor(deps: Pick<EngineRuntimeDeps, "log" | "logTerm">): StatusLine | null {
  const term = deps.logTerm ?? termOf(process.stderr);
  return term.tty ? new StatusLine({ write: deps.log, columns: term.columns }) : null;
}

/**
 * The ONE line a failed run/attach prints in place of the old stderr dump:
 * `[container] <name>: daemon stopped unexpectedly · log: ~/…/daemon.log`.
 */
export function quitReport(noun: string, name: string, logPath: string | undefined): string {
  const where = logPath === undefined ? "" : ` · log: ${tildePath(logPath)}`;
  return `[${noun}] ${name}: daemon stopped unexpectedly${where}\n`;
}

/** `startEngineRuntime`'s deps (`run`). */
export interface EngineRuntimeDeps {
  readonly host: EngineHost;
  readonly image: string;
  /**
   * Install dir for the injected binary in the pod. Default `/usr/local/bin`;
   * override (`--bin-dir`) for a read-only rootfs, e.g. `/tmp` on a hardened pod.
   */
  readonly binDir?: string;
  /** Workload name (optional; a random one is generated when omitted). */
  readonly name?: string;
  /**
   * `run --keep` (owner, 2026-10-27): present → the workload is NEVER removed
   * by this runtime (no exit net, no remove on dispose or on a startup
   * failure), and `[<noun>] kept <name> — resume with: <keepHint(name)>` is
   * logged. Returns the re-attach command for `name`.
   */
  readonly keepHint?: (name: string) => string;
  /**
   * `run --detach --keep=false`, with `keepHint`: this runtime still never
   * removes it, the relay does when the run ends. Changes only the kept line.
   */
  readonly removedAtEnd?: boolean;
  /**
   * docker/podman: the laptop folder to mount (slice D, planned and confirmed
   * by the caller BEFORE this runtime starts — `workspace-mount.ts`).
   */
  readonly workspace?: WorkspaceMount;
  /** Extra workload labels (slice E: `tentacle.kept`). */
  readonly labels?: Readonly<Record<string, string>>;
  /** Workload annotations (slice E: engine, model, created; docker writes them as labels). */
  readonly annotations?: Readonly<Record<string, string>>;
  /**
   * With `keepHint` (slice E): record `name` in the laptop's kept index right
   * after the create; returns the undo, run if the host removed it anyway.
   * A throw is reported (the workload is then not in `tentacle ps`).
   */
  readonly recordKept?: (name: string) => () => void;
  readonly permissions: PermissionBroker;
  readonly saver: SessionSaver;
  readonly resume: SessionRecord | null;
  readonly log: (line: string) => void;
  /**
   * Where the INFORMATIONAL lines go (the phases, the exit line): the caller
   * greys them on a terminal. Errors, warnings and the stderr block always go
   * to `log`. Absent: they go to `log` too.
   */
  readonly info?: (line: string) => void;
  /**
   * The terminal `log` writes to (docs/fix/cli-output-streams.md): the startup
   * spinner runs only on a terminal, cut to its width. Default: stderr's.
   */
  readonly logTerm?: Pick<StreamTerm, "tty" | "columns">;
  /**
   * Where the pod daemon's stderr is kept (`daemon.log`, 0600, bounded), given the
   * workload's name: the run's state dir when it has one. Absent: nothing is kept.
   * The stderr is NEVER written to the terminal (docs/feat/run-prompt.md round 4).
   */
  readonly daemonLogPath?: (name: string) => string | undefined;
  /** In-TUI notices (the session's `NoticeHub`), e.g. a reconnect that lost the last turn. */
  readonly notify?: (text: string) => void;
  /** This tentacle's version for the pod-binary check (tests); defaults to `APP_VERSION`. */
  readonly appVersion?: string;
}

/**
 * The reconnect channel factory for an engine daemon (pod-attach Layer 2,
 * docs/feat/client-reattach-frontends.md §2): check the workload, then open the
 * SAME exec again. A new exec is a new bridge to the SAME resident daemon, so
 * the client's reopen finds its session live (the turn the dropped link was
 * serving was cancelled when its last model link left; the session is intact).
 * Only a resident that died with it (a pod restart) makes the session unknown:
 * then it is recreated from the laptop's history and a turn in flight is
 * reported lost, never re-run.
 */
export function execChannelFactory(
  host: EngineHost,
  target: EngineExecTarget,
  options: EngineExecChannelOptions,
): () => Promise<DuplexChannel> {
  return async () => {
    const verdict = await host.dialVerdict(target.name);
    if (verdict) {
      throw verdict;
    }
    return host.openExec(target, options);
  };
}

/**
 * A net's save check: one that cannot tell is "not saved". Not saved, the
 * workload stays and `onKept` (synchronous, best effort) says so in the record.
 */
function confirmed(saved: () => boolean, onKept?: () => void): boolean {
  let ok = false;
  try {
    ok = saved();
  } catch {
    // Cannot tell: not saved.
  }
  if (!ok) {
    try {
      onKept?.();
    } catch {
      // A record not written: `ps` still says `lost · not saved` mid-run.
    }
  }
  return ok;
}

/**
 * Register the process-level safety net that deletes the workload on exit.
 *
 * Closing the TUI with Ctrl+C makes the terminal code call `process.exit`
 * *before* the runtime's `dispose()` runs, so the normal `remove` never
 * fires and the workload is orphaned. The `exit` handler runs on **every** exit
 * path (SIGINT / SIGTERM / normal / crash), and `removeBestEffort` spawns a
 * detached, fire-and-forget child that issues the `DELETE` — so it never
 * blocks the exit and never throws. See `k8s/pod-cleanup.ts` and
 * `docker/container-cleanup.ts`. Returns the disarm: the relay's own normal exit
 * passes here too (docs/feat/detached-relay-lifecycle.md).
 *
 * `saved()` (asked synchronously, at exit) gates the delete: false, or a throw,
 * keeps the workload and calls `onKept` (docs/fix/detach-live.md D4/R6: a
 * detached run's laptop copy not confirmed, it is the only one; `ps` says
 * `not saved`). A plain `run` passes `() => true`: it is in no index, so a
 * leftover would be silent.
 */
export function armExitNet(
  host: EngineHost,
  name: string,
  saved: () => boolean,
  onKept?: () => void,
): () => void {
  const fire = (): void => {
    if (confirmed(saved, onKept)) {
      host.removeBestEffort(name);
    }
  };
  process.once("exit", fire);
  return () => {
    process.off("exit", fire);
  };
}

/**
 * `armExitNet` for a TUI of a keep=false detached run (docs/feat/detached-handover.md):
 * every TUI of the run arms it, since any may be the last; it fires only when
 * `othersAlive()` (asked synchronously, at exit: the presence files) says no
 * other TUI of the run lives AND `saved()` confirms its laptop copy (D4/R6). So
 * the last one's crash deletes only what is saved, and another one's never
 * deletes under the rest. Returns the disarm.
 */
export function armSharedExitNet(
  host: EngineHost,
  name: string,
  othersAlive: () => boolean,
  saved: () => boolean,
  onKept?: () => void,
): () => void {
  const fire = (): void => {
    let others = true;
    try {
      others = othersAlive();
    } catch {
      // Cannot tell: the workload stays (a leftover is one `rm` away).
    }
    if (!others && confirmed(saved, onKept)) {
      host.removeBestEffort(name);
    }
  };
  process.once("exit", fire);
  return () => {
    process.off("exit", fire);
  };
}

/** A workload `provisionWorkload` made ready: its binary installed, no daemon started. */
export interface ProvisionedWorkload {
  readonly name: string;
  /** Where the binary was installed. */
  readonly binPath: string;
  /** Delete it, or (kept) say how to reach it; `error`: the failed start, if any. */
  readonly removeUnlessKept: (error?: unknown) => void;
  /** The `still running` line (kept runs; idempotent) — see `deferAnnounce`. */
  readonly announce: () => void;
}

/**
 * The lifecycle half of `run`: create the workload, wait for it, inject the
 * binary (kept: record it and say so). Throws (after cleaning up, unless kept)
 * on failure. `startEngineRuntime` goes on to the daemon; `run --detach` leaves
 * that to its relay (docs/feat/detached-relay.md).
 */
export async function provisionWorkload(
  config: TentacleConfig,
  deps: Omit<EngineRuntimeDeps, "permissions" | "saver" | "resume" | "notify"> & {
    /**
     * Do not say `still running` yet: the caller calls `announce()` once the TUI
     * opens (`startEngineRuntime`). Default: say it as soon as the workload is ready
     * (a detached run has no TUI).
     */
    readonly deferAnnounce?: boolean;
  },
): Promise<ProvisionedWorkload> {
  const name = deps.name ?? `tentacle-${crypto.randomUUID().slice(0, 8)}`;
  try {
    return await provisionNamed(config, deps, name);
  } catch (error) {
    // The whole cause goes to the run's log; the caller prints ONE short line.
    // A refusal (nothing ran, e.g. the namespace does not exist) creates no log.
    const path = deps.daemonLogPath?.(name);
    if (path !== undefined && !(error instanceof RefusalError)) {
      recordFailure(error, openDaemonLog(path, undefined, `run ${name}`));
    }
    throw error;
  }
}

async function provisionNamed(
  config: TentacleConfig,
  deps: Omit<EngineRuntimeDeps, "permissions" | "saver" | "resume" | "notify"> & {
    readonly deferAnnounce?: boolean;
  },
  name: string,
): Promise<ProvisionedWorkload> {
  const { host } = deps;
  // Install path in the pod: a read-only rootfs (a hardened pod) needs a writable
  // dir via --bin-dir (e.g. /tmp); the daemon is then exec'd by this absolute path.
  const binPath = `${deps.binDir ?? "/usr/local/bin"}/tentacle`;
  const container = host.defaultContainer;
  // Interactive (TTY) startup is ONE line: a spinner repainted per phase
  // (create → ready → inject, with the transfer bar as the bar phase's text),
  // cleared when the daemon starts. Piped (log/CI) logs one line per phase
  // (the `log` sink), so transcripts stay readable.
  const status = statusLineFor(deps);
  const info = deps.info ?? deps.log;
  const phase = (text: string): void => {
    if (status) {
      status.set(text);
    } else {
      info(`${text}\n`);
    }
  };

  // Offline pod-binary check BEFORE any cluster mutation (D1): a missing or
  // stale <configDir>/bin binary fails here, so no pod is created and none
  // needs deleting. Both arches: the pod's is unknown until it exists.
  await checkPodBinaries({ configDir: config.configDir, appVersion: deps.appVersion });

  const { workspace } = deps;
  // Short on purpose (round 4): no socket path / discovery note, no hidden-paths
  // list (the y/N prompt said it); the engine's place goes to the run's log file.
  const mounted = workspace ? ` — workspace ${workspace.target} (rw)` : "";
  phase(`[${host.noun}] creating ${name} (image ${deps.image})${mounted}…`);
  try {
    // Errors arrive translated (e.g. a missing k8s namespace → actionable).
    await host.create(name, deps.image, {
      ...(workspace ? { workspace } : {}),
      ...(deps.labels ? { labels: deps.labels } : {}),
      ...(deps.annotations ? { annotations: deps.annotations } : {}),
    });
  } catch (error) {
    status?.finish();
    throw error;
  }

  // `run --keep`: tentacle never removes this workload (owner, 2026-10-27).
  const { keepHint } = deps;
  // Slice E: a kept workload goes in the laptop index (`tentacle ps`) as soon as
  // it exists. A failed write is said with the kept line — never swallowed.
  let forgetKept: (() => void) | undefined;
  let notRecorded = "";
  if (keepHint && deps.recordKept) {
    try {
      forgetKept = deps.recordKept(name);
    } catch (error) {
      notRecorded = `[${host.noun}] warning: ${name} is not in \`tentacle ps\` (could not record it: ${
        error instanceof Error ? error.message : String(error)
      }) — remove it yourself when done\n`;
    }
  }
  // ONE short line (docs/feat/run-prompt.md): `attach <name>` finds the engine
  // and place in the index, so the command is just the name — unless the index
  // write failed, when only the full command (engine, place) can reach it.
  const attachText = notRecorded && keepHint ? keepHint(name) : `tentacle attach ${name}`;
  const keptLine = keepHint
    ? `[${host.noun}] ${name} still running · ${deps.removedAtEnd ? "removed when the run ends · " : ""}${attachText}\n`
    : undefined;
  // Said once, right before the TUI opens (and never before a failure): the line
  // stays on the main screen under the alt-screen, so it is there after a quit —
  // and after a signal exit, which runs no `dispose`. Not at dispose: a run whose
  // TUI never opened has nothing to resume.
  let announced = false;
  // `informational`: the exit line; the "stays up" failure is an error → `log`.
  const logKept = (line: string, informational = true): void => {
    (informational ? info : deps.log)(line);
    warnNotRecorded();
  };
  // The "not in `tentacle ps`" warning is not the exit line: said once, as soon as
  // the status line is cleared (success or failure), whether or not the TUI opens.
  let warned = false;
  function warnNotRecorded(): void {
    if (notRecorded && !warned) {
      warned = true;
      deps.log(notRecorded);
    }
  }
  const removeUnlessKept = (error?: unknown): void => {
    if (error instanceof WorkloadRemovedError) {
      // the host already removed it (a failed workspace probe): never "kept".
      try {
        forgetKept?.();
      } catch {
        // a stale entry shows as `gone` in `tentacle ps`; `rm` drops it
      }
      return;
    }
    if (keptLine) {
      // No relay will ever run to remove it: a leftover, listed in `ps` (Q2).
      if (deps.removedAtEnd && error !== undefined) {
        logKept(
          `[${host.noun}] ${name} stays up: the run never started · ${attachText} · tentacle rm ${name}\n`,
          false,
        );
      } else if (error !== undefined && !notRecorded) {
        // A kept workload the failure leaves up: the one `failed:` line says how
        // to remove it (not when the index write failed: `rm <name>` may not find it).
        markStillUp(error, name);
      }
    } else {
      void host.remove(name).catch(() => {});
    }
  };

  // Safety net: if the process exits before `dispose()` (Ctrl+C → process.exit
  // in the terminal code, a crash, or a kill), the workload is still deleted by
  // a detached child. Registered right after it exists, so it covers
  // pre-ready failures too. Not armed with `--keep`: Ctrl+C keeps it too.
  if (!keptLine) {
    armExitNet(host, name, () => true);
  }

  try {
    phase(`[${host.noun}] waiting for ${name} to become ready…`);
    await host.waitForReady(name);
    // Inject the tool into the sandbox (F4.e): the image need not contain
    // `tentacle`. Any failure here throws → the workload is deleted below.
    // In interactive mode the injection phases (probe → resolve → transfer →
    // verify) drive the SAME status line via `onStatus`.
    const version = await injectAgentBinary({
      host,
      name,
      noun: host.noun,
      binPath,
      container,
      probe: () => probePod(host, name, container),
      resolveBinary: (target) =>
        resolvePodBinary(target, {
          configDir: config.configDir,
          appVersion: deps.appVersion,
          // Keep the single-line invariant + stay concise: in interactive mode
          // the "resolving … binary…" phase line is enough, so the resolver's
          // verbose cache/build path is dropped; in piped mode log it for the
          // transcript/debug.
          log: status ? () => {} : deps.log,
        }),
      log: deps.log,
      onStatus: status ? (text) => status.set(text) : undefined,
    });
    status?.finish();
    // Piped only: in interactive mode the TUI opening IS the confirmation, so
    // no final log line (the status line was already cleared by `finish()`).
    if (!status) {
      info(`[${host.noun}] ${version} ready in ${name}; starting the agent daemon\n`);
    }
    // Kept: say so BEFORE the TUI mounts — this line stays on the main screen, so
    // a Ctrl+C exit (no `dispose`) still shows how to resume. A run with a TUI
    // calls `announce` itself once everything succeeded.
    const announce = (): void => {
      if (keptLine && !announced) {
        announced = true;
        logKept(keptLine);
      }
    };
    if (!deps.deferAnnounce) {
      announce();
    }
    warnNotRecorded();
    return { name, binPath, removeUnlessKept, announce };
  } catch (error) {
    // The workload was created but never became usable — delete it before
    // surfacing (kept with `--keep`: left to inspect).
    status?.finish();
    warnNotRecorded();
    removeUnlessKept(error);
    throw error;
  }
}

/**
 * `run` on any engine: create an ephemeral workload (pod / container), connect
 * the daemon over its exec channel, and build a persisting local runtime
 * against it. The returned runtime's `dispose` closes the exec channel and
 * removes the workload (kept with `keepHint`). Throws (after cleaning up any
 * created workload, unless kept) on failure — there is no in-process fallback.
 */
export async function startEngineRuntime(
  config: TentacleConfig,
  deps: EngineRuntimeDeps,
): Promise<EngineRuntime> {
  const { host } = deps;
  const { name, binPath, removeUnlessKept, announce } = await provisionWorkload(config, {
    ...deps,
    deferAnnounce: true,
  });
  // The pod daemon's stderr goes to a per-run file, never to the terminal (the
  // TUI owns it; a routine daemon line is not an error). A FAILED run prints one
  // line naming the file (`quitReport`) — see `createFaultWatch`.
  const stderr = openDaemonLog(deps.daemonLogPath?.(name), undefined, `run ${name}`);
  const fault = createFaultWatch();
  try {
    const target: EngineExecTarget = {
      name,
      container: host.defaultContainer,
      command: podDaemonCommand(binPath, config),
    };
    const execOptions: EngineExecChannelOptions = { onStderr: stderr.onStderr };
    // The current exec; a reconnect replaces it (and teardown closes that one).
    let channel = host.openExec(target, execOptions);
    const redial = execChannelFactory(host, target, execOptions);
    const runtime = await createLocalRuntime({
      ...laptopModels(config),
      channel,
      channelFactory: async () => {
        channel = await redial();
        return channel;
      },
      disposeTransport: () => {
        channel.close();
        // Safe here: `dispose()` runs after the TUI has unmounted (left the
        // alt-screen). A failed run says so in one line; a normal quit says nothing.
        if (fault.faulted()) {
          (deps.info ?? deps.log)(quitReport(host.noun, name, stderr.path));
        }
        removeUnlessKept();
      },
      permissions: deps.permissions,
      saver: deps.saver,
      cwd: config.cwd,
      model: config.model,
      resume: deps.resume,
      daemonKind: "container",
      // Laptop-side RPC errors (incl. a local model failure, which the pod only
      // sees opaque) join the log file. They are NOT a failure of the run: the
      // TUI showed the turn's error already.
      onPeerError: (error) => stderr.onStderr(`[laptop rpc] ${error.message}\n`),
      ...(deps.notify ? { notify: deps.notify } : {}),
    });
    fault.watch(runtime);
    // A tentacle-made workload has the one container: no `/container` part.
    return Object.assign(runtime, {
      markFault: fault.mark,
      announce,
      target: engineTarget(host, name),
    });
  } catch (error) {
    // The TUI never mounted: the caller prints ONE short line; the whole cause
    // is in the log, whose path rides on the error.
    recordFailure(error, stderr);
    removeUnlessKept(error);
    throw error;
  }
}

/** The resident could not be stopped before the rename: the attach is refused. */
class ResidentStopRefused extends Error {}

/** `attachEngineRuntime`'s deps (`attach`). */
export interface EngineAttachRuntimeDeps {
  readonly host: EngineHost;
  /** The EXISTING workload's name (no create, no delete — see `attachEngineRuntime`). */
  readonly name: string;
  /** Container to exec into; undefined → the API picks the only/default one. */
  readonly container?: string;
  /** Install dir for the injected binary (default `/usr/local/bin`; `--bin-dir` for a read-only rootfs). */
  readonly binDir?: string;
  /** This tentacle's version for the pod-binary check (tests); defaults to `APP_VERSION`. */
  readonly appVersion?: string;
  readonly permissions: PermissionBroker;
  readonly saver: SessionSaver;
  readonly resume: SessionRecord | null;
  readonly log: (line: string) => void;
  /**
   * Where the INFORMATIONAL lines go (the phases, the exit line): the caller
   * greys them on a terminal. Errors, warnings and the stderr block always go
   * to `log`. Absent: they go to `log` too.
   */
  readonly info?: (line: string) => void;
  /**
   * The terminal `log` writes to (docs/fix/cli-output-streams.md): the startup
   * spinner runs only on a terminal, cut to its width. Default: stderr's.
   */
  readonly logTerm?: Pick<StreamTerm, "tty" | "columns">;
  /**
   * Where the pod daemon's stderr is kept (`daemon.log`, 0600, bounded), given the
   * workload's name: the run's state dir when it has one. Absent: nothing is kept.
   * The stderr is NEVER written to the terminal (docs/feat/run-prompt.md round 4).
   */
  readonly daemonLogPath?: (name: string) => string | undefined;
  /** In-TUI notices (the session's `NoticeHub`), e.g. a reconnect that lost the last turn. */
  readonly notify?: (text: string) => void;
  /** `createLocalRuntime`'s: false in the relay, no one to ask. */
  readonly interactive?: boolean;
  /** `createLocalRuntime`'s: the first session's uid. */
  readonly sessionId?: string;
  /** `createLocalRuntime`'s: a TUI of a detached run, whose sessions others share. */
  readonly shared?: true;
}

/**
 * `attach` on any engine: attach to an EXISTING workload — inject the agent
 * binary if it does not already have it, open the daemon exec, and build the
 * same persisting local runtime as `startEngineRuntime` — with one deliberate
 * difference: the workload is USER-OWNED, so this runtime never creates,
 * starts, removes, or arms an exit net for it. `dispose` closes the session and
 * the exec channel (its bridge ends; the pod's resident daemon stays, idle,
 * until its idle exit); the workload stays running for reuse
 * (re-attach is a sub-second version-probe) and for cleanup by its owner.
 *
 * No `armExitNet` safety net: the whole point is that a TUI exit
 * (Ctrl+C → process.exit) must NOT delete it.
 */
export async function attachEngineRuntime(
  config: TentacleConfig,
  deps: EngineAttachRuntimeDeps,
): Promise<EngineRuntime> {
  const { host } = deps;
  const { name } = deps;
  // No `?? AGENT_CONTAINER` default: when the caller does not name a container,
  // the exec API omits the `container` parameter and picks the only/default
  // one (single-container pods need no `-c`).
  // `let`: the preflight may resolve one (k8s `default-container` annotation).
  let container = deps.container;
  // Same single-line (TTY) / one-line-per-phase (piped) contract as `run`.
  const status = statusLineFor(deps);
  const info = deps.info ?? deps.log;
  const phase = (text: string): void => {
    if (status) {
      status.set(text);
    } else {
      info(`${text}\n`);
    }
  };

  phase(`[${host.noun}] attaching to ${name} in ${host.where}…`);
  let state: WorkloadState;
  try {
    // A missing workload arrives as an actionable error (wrong name / namespace);
    // k8s also refuses a multi-container pod when no container was named.
    state = await host.inspect(name, { container });
  } catch (error) {
    // Nothing ran: no daemon log (docs/fix/k8s-multi-container.md).
    status?.finish();
    throw error;
  }
  // A terminated / not-runnable workload can never host the daemon (and
  // `waitForReady` would just time out) — say so up front. Never started here.
  if (state.kind === "stopped") {
    status?.finish();
    throw new RefusalError(state.detail);
  }
  if (container === undefined && state.container !== undefined) {
    container = state.container; // silently, like kubectl
  }
  // M7 (owner 2026-10-27): the container's mount is fixed — attaching from
  // another folder is warned about, never refused.
  // The label is container metadata anyone can forge (`tentacle.managed` too):
  // sanitised before it reaches the terminal (Review F3).
  const moved = attachCwdWarning(
    state.workspace === undefined ? undefined : untrustedText(state.workspace),
    config.cwd,
  );
  if (moved) {
    deps.notify?.(moved);
    if (!status) {
      deps.log(`[${host.noun}] ${moved}\n`);
    }
  }

  // The workload may still be pulling (the user ran it seconds ago): a BOUNDED
  // wait — `exec` is an attach, not a create, so we do not sit for the full
  // create-flow default.
  if (state.kind === "starting") {
    phase(`[${host.noun}] waiting for ${name} to become ready…`);
    try {
      await host.waitForReady(name, { timeoutMs: 60_000 });
    } catch (error) {
      status?.finish();
      throw error;
    }
  }

  // From here a command runs in the workload, so the log exists: the pod
  // daemon's stderr goes to a per-run file, never to the terminal (as in
  // `startEngineRuntime`). Created only now — every refusal above leaves nothing.
  const stderr = openDaemonLog(deps.daemonLogPath?.(name), undefined, `attach ${name}`);
  try {
    // Preflight: if the pod ALREADY has a working `tentacle` (a re-attach
    // after a previous attach, or an image that ships it), the whole injection
    // — 89 MB transfer — is skipped. Any failure (not on PATH, wrong arch,
    // bad libc) falls through to the injection, which re-verifies anyway.
    // One-shot execs do not go through the status line (same as in `run`):
    // `injectAgentBinary` owns its phases via `onStatus`.
    // Our install path (`/usr/local/bin`, or --bin-dir) is always asked first, so
    // a re-attach finds what we installed and keeps its resident, even off PATH
    // or behind another `tentacle` earlier on it; a binary on PATH is the
    // fallback, because any binary reaches the one resident (its socket does not
    // depend on the install dir). When we inject, the daemon is exec'd by the
    // absolute install path.
    const binPath = `${deps.binDir ?? "/usr/local/bin"}/tentacle`;
    const versionOf = (bin: string): Promise<EngineRunExecResult> =>
      host.runExec({ name, container, command: [bin, "--version"] }, undefined, {
        timeoutMs: 15_000,
      });
    // The answer is pod stdout, and it reaches the log.
    const versionLabel = (run: EngineRunExecResult): string =>
      untrustedText(run.stdout.trim()) || "tentacle";
    let serveBin = binPath;
    let probe: EngineRunExecResult;
    try {
      probe = await versionOf(serveBin);
      if (probe.exitCode !== 0) {
        serveBin = "tentacle";
        probe = await versionOf(serveBin);
      }
    } catch (error) {
      status?.finish();
      // A wrong container surfaces here (the first exec) — translate it.
      throw host.execError(error, { name, container });
    }
    // Reused only when it is exactly what this laptop would inject (a
    // re-attach); any other version is replaced, so the daemon speaks this
    // client's protocol. From source with no override: reused as before.
    const expected = await expectedContainerVersion({
      appVersion: deps.appVersion ?? APP_VERSION,
      ...(process.env.TENTACLE_POD_BIN ? { podBinOverride: process.env.TENTACLE_POD_BIN } : {}),
      readMarker: (path) => readBinaryVersion(path),
    });
    const decision = containerDecision(probe, expected);
    const found = serveBin;
    const residentStatusOf = (bin: string): Promise<EngineRunExecResult | null> =>
      host
        .runExec({ name, container, command: residentStatusCommand(bin) }, undefined, {
          timeoutMs: 15_000,
        })
        .catch(() => null);
    let version: string;
    if (decision.kind === "reuse") {
      version = versionLabel(probe);
    } else {
      // Never replace a binary a running resident still uses (detached-runs
      // S1): ask the OLD one (the one that answered, else our install path).
      const oldBin = decision.kind === "replace" ? found : binPath;
      const verdict = residentGuard(await residentStatusOf(oldBin), name);
      if (verdict.kind === "refuse") {
        throw new Error(verdict.message);
      }
      // Once the bytes are staged, so an install that cannot land stops nothing,
      // and before the rename, so `oldBin` still exists. The transfer gave a
      // client time to attach: asked again.
      const stopResident = async (): Promise<void> => {
        const again = residentGuard(await residentStatusOf(oldBin), name);
        if (again.kind === "refuse") {
          throw new ResidentStopRefused(again.message);
        }
        if (again.kind === "none") {
          return;
        }
        const stopRun = await host
          .runExec({ name, container, command: residentStopCommand(oldBin) }, undefined, {
            timeoutMs: 15_000,
          })
          .catch(() => null);
        const stopped = residentStopVerdict(stopRun, name);
        if (stopped.kind === "refuse") {
          throw new ResidentStopRefused(stopped.message);
        }
      };
      serveBin = binPath; // injected to our dir → exec by absolute path
      let replaced = decision.kind === "replace";
      try {
        version = await injectAgentBinary({
          host,
          name,
          noun: host.noun,
          binPath,
          container,
          probe: () => probePod(host, name, container),
          resolveBinary: (target) =>
            resolvePodBinary(target, {
              configDir: config.configDir,
              appVersion: deps.appVersion,
              // Same single-line invariant as `run`: interactive mode folds the
              // resolver's verbose path into the "resolving … binary…" phase.
              log: status ? () => {} : deps.log,
            }),
          log: deps.log,
          onStatus: status ? (text) => status.set(text) : undefined,
          ...(verdict.kind === "stop" ? { beforeCommit: stopResident } : {}),
        });
      } catch (error) {
        // A plain injection failure: unchanged (nothing else to run). A refused
        // stop is an answer, not a failed replace: never "go on with the old one".
        if (decision.kind !== "replace" || error instanceof ResidentStopRefused) {
          throw error;
        }
        // Replacing failed (orchestrator decision, follow-up 1): do not abort —
        // go on with the container's own tentacle, IF it still answers (the
        // failure may have come after the rename), and warn. `initialize` still
        // refuses a protocol skew with its full message.
        const again = await versionOf(found).catch(() => null);
        if (again?.exitCode !== 0) {
          throw error;
        }
        serveBin = found;
        replaced = false;
        version = versionLabel(again);
        const line = replaceFailedWarning({
          had: decision.had,
          expected,
          now: parseVersionLine(again.stdout),
          cause: error instanceof Error ? error.message : String(error),
          // The laptop's own pod binary is not ready (its `tentacle update` advice).
          localBinary: error instanceof PodBinaryError,
        });
        deps.notify?.(line);
        if (!status) {
          deps.log(`${line}\n`);
        }
      }
      const line =
        decision.kind === "replace" && replaced
          ? replacedNotice({
              had: decision.had,
              expected,
              ...(found === "tentacle" ? { installedAt: binPath } : {}),
            })
          : undefined;
      if (line !== undefined) {
        deps.notify?.(line);
        if (!status) {
          deps.log(`${line}\n`);
        }
      }
    }
    // A resident this attach will join but did not start: `run` used a dir it
    // does not know, or another build left it. Not ours to stop: said, and joined.
    // From source, a reuse has no build to compare (its flow stays one exec).
    const skew =
      expected !== undefined || decision.kind === "inject"
        ? residentSkewWarning(await residentStatusOf(serveBin), name, binPath, expected)
        : undefined;
    if (skew !== undefined) {
      deps.notify?.(skew);
      if (!status) {
        deps.log(`${skew}\n`);
      }
    }
    status?.finish();
    // Piped only: the TUI opening IS the confirmation in interactive mode.
    if (!status) {
      info(
        `[${host.noun}] ${version} attached to ${name}; the agent daemon is starting (closing the TUI detaches — the ${host.noun} stays up)\n`,
      );
    }
    const target: EngineExecTarget = {
      name,
      container,
      command: podDaemonCommand(serveBin, config),
    };
    const execOptions: EngineExecChannelOptions = { onStderr: stderr.onStderr };
    // The current exec; a reconnect replaces it (and teardown closes that one).
    let channel = host.openExec(target, execOptions);
    const redial = execChannelFactory(host, target, execOptions);
    const fault = createFaultWatch();
    const runtime = await createLocalRuntime({
      ...laptopModels(config),
      channel,
      channelFactory: async () => {
        channel = await redial();
        return channel;
      },
      // User-owned pod: closing the exec detaches the daemon but the pod keeps
      // running (keepalive) — no `deletePod`, by design.
      disposeTransport: () => {
        channel.close();
        // Safe after the TUI has unmounted (left the alt-screen): a failed attach
        // says so in one line, like `run`; a normal quit says nothing.
        if (fault.faulted()) {
          info(quitReport(host.noun, name, stderr.path));
        }
      },
      permissions: deps.permissions,
      saver: deps.saver,
      cwd: config.cwd,
      model: config.model,
      resume: deps.resume,
      daemonKind: "container",
      // Laptop-side RPC errors join the log file; a model/turn error is not a
      // failure of the attach (the TUI showed it).
      onPeerError: (error) => stderr.onStderr(`[laptop rpc] ${error.message}\n`),
      ...(deps.notify ? { notify: deps.notify } : {}),
      ...(deps.interactive !== undefined ? { interactive: deps.interactive } : {}),
      ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
      ...(deps.shared ? { shared: true as const } : {}),
    });
    fault.watch(runtime);
    return Object.assign(runtime, {
      markFault: fault.mark,
      target: engineTarget(host, name, container, state.containers),
    });
  } catch (error) {
    status?.finish();
    // NO delete here: the workload is not ours. The injection's own messages
    // (e.g. the glibc hint) surface untouched; a wrong container is translated.
    // The whole cause goes to the log; its path rides on the error.
    throw recordFailure(host.execError(error, { name, container }), stderr);
  }
}
