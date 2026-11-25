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
 *   (only with `run --rm`).
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
import { existsSync } from "node:fs";
import type { SessionRecord } from "@tentacle/agent";
import { ModelNameRefusedError, type NamedModels } from "@tentacle/client";
import { type TentacleConfig, publishedModelNames } from "@tentacle/config";
import type { ModelProvider, PermissionBroker } from "@tentacle/core";
import { createModelProvider, imageLimits } from "@tentacle/providers";
import type { DuplexChannel } from "@tentacle/transport";
import type { TargetBadge } from "@tentacle/tui";
import { carriedSettings } from "./carried-settings.ts";
import {
  containerDecision,
  expectedContainerBuild,
  expectedContainerVersion,
  parseBuildFromVersionProbe,
  parseVersionLine,
  replaceFailedWarning,
  replacedNotice,
  staleBuildBusyLine,
} from "./container-version.ts";
import {
  type EngineExecChannelOptions,
  type EngineExecTarget,
  type EngineHost,
  type EngineRunExecResult,
  RefusalError,
  StaleBuildError,
  WorkloadRemovedError,
  type WorkloadState,
} from "./engine-host.ts";
import { engineTarget } from "./engine-target.ts";
import type { HopLiveLine } from "./hop-live-line.ts";
import { type LocalRuntime, createLocalRuntime } from "./local-runtime.ts";
import {
  type ProviderFactory,
  configuredModelProvider,
  createModelProviders,
} from "./model-provider.ts";
import {
  POD_BINARY_TARGETS,
  PodBinaryError,
  checkPodBinaries,
  configBinPath,
  resolvePodBinary,
} from "./pod-binary-build.ts";
import { classifyImage, injectAgentBinary, withEngineArch } from "./pod-binary.ts";
import {
  DEFAULT_INSTALL_DIR,
  type InstallCandidate,
  type ParsedPlacement,
  choosePlacement,
  installCandidates,
  parsePlacement,
  placementScript,
} from "./pod-install-dir.ts";
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
import { readBinaryBuildId, readBinaryVersion } from "./version-marker.ts";
import { APP_RELEASE_VERSION } from "./version.ts";
import { type WorkspaceMount, attachCwdWarning } from "./workspace-mount.ts";

/**
 * The pod daemon's command line (`run` and `attach`): the BRIDGE to the pod's
 * resident daemon, started by the first exec and outliving it
 * (`pod-resident.ts`, docs/feat/detached-runs.md S1). No setting travels here:
 * the laptop's go per session on `session/open.settings`, so a resident already
 * running honours whichever laptop opens a new session
 * (docs/feat/config-carry.md).
 */
export function podDaemonCommand(bin: string): string[] {
  return [bin, "serve", "--bridge", "--model-proxy"];
}

/**
 * The laptop's models the pod reaches through us (reverse-tunnel), so the
 * endpoint and API key never leave the laptop: the main one for turns and,
 * with `model.autoTitle`, the one for the pod's title calls
 * (`model.titleModel`, else the main one). Off → no title provider: the
 * laptop refuses a title call (the gate is here, not in the pod). `namedModels`:
 * the entries this laptop published and nothing else (docs/feat/models-map-pod.md).
 */
export function laptopModels(
  config: TentacleConfig,
  create: ProviderFactory = createModelProvider,
): {
  readonly modelProvider: ModelProvider;
  readonly titleModelProvider?: ModelProvider;
  readonly namedModels?: NamedModels;
  /**
   * This laptop's own vision config, decided by the SAME `imageLimits()` the
   * provider uses (docs/feat/attachments-prompt.md D4): a `client`-mode pod's
   * advertised capability must match what this laptop can actually send.
   */
  readonly localImages: { readonly vision: boolean; readonly maxBytes: number };
} {
  const limits = imageLimits(config.provider, config);
  const localImages = { vision: limits.vision, maxBytes: limits.maxBytes };
  const modelProvider = configuredModelProvider(config, config.model, create);
  const names = new Set(publishedModelNames(config));
  const providers = createModelProviders(config, create);
  const named: { readonly namedModels?: NamedModels } =
    names.size === 0
      ? {}
      : {
          namedModels: {
            resolve(name) {
              if (!names.has(name)) {
                return undefined;
              }
              const entry = config.models[name];
              // A relay whose key command failed: never a request with no key.
              if (entry?.apiKeySource === "command" && entry.apiKey === undefined) {
                return "unavailable";
              }
              return providers.forEntry(name);
            },
          },
        };
  if (!config.autoTitle) {
    return { modelProvider, localImages, ...named };
  }
  const titleModelProvider =
    config.titleModel !== undefined
      ? configuredModelProvider(config, config.titleModel, create)
      : modelProvider;
  return { modelProvider, titleModelProvider, localImages, ...named };
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
 *
 * `liveLine` WINS when present (docs/feat/session-hop-ux slice 2): a hop has no TTY
 * of its own (it must never write raw while Ink owns the screen), yet it HAS a
 * place to paint one line — its own status row. Returning it here is what makes
 * every `status`-keyed behaviour in this file take the interactive contract with
 * no further edit: phases go to `set`, the transfer is the bar, the resolver's
 * verbose path is dropped, and no `attached…`/`ready in…` line is logged.
 */
function statusLineFor(
  deps: Pick<EngineRuntimeDeps, "log" | "logTerm" | "liveLine">,
): HopLiveLine | StatusLine | null {
  if (deps.liveLine !== undefined) {
    return deps.liveLine;
  }
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
   * Install dir for the injected binary in the pod (`--bin-dir`): the only
   * candidate, no fallback. Absent: the first of /usr/local/bin,
   * $HOME/.local/bin, ${TMPDIR:-/tmp}/tentacle-<uid>/bin the ONE placement
   * probe proves writable + exec-able (docs/fix/inject-bin-dir-probe.md).
   */
  readonly binDir?: string;
  /** Workload name (optional; a random one is generated when omitted). */
  readonly name?: string;
  /**
   * A kept run (no `run --rm`; owner, 2026-10-27): present → the workload is NEVER removed
   * by this runtime (no exit net, no remove on dispose or on a startup
   * failure), and `[<noun>] kept <name> — resume with: <resumeHint(name)>` is
   * logged. Returns the re-attach command for `name`.
   */
  readonly resumeHint?: (name: string) => string;
  /**
   * `run --detach --rm`, with `resumeHint`: this runtime still never
   * removes it, the relay does when the run ends. Changes only the kept line.
   */
  readonly removedAtEnd?: boolean;
  /**
   * docker/podman: the laptop folder to mount (slice D, planned and confirmed
   * by the caller BEFORE this runtime starts — `workspace-mount.ts`).
   */
  readonly workspace?: WorkspaceMount;
  /**
   * docker/podman: the engine network of the container (feat/run-network);
   * absent = no `NetworkMode` (the engine's default). A k8s host refuses it.
   */
  readonly network?: string;
  /** Extra workload labels (slice E: `tentacle.kept`). */
  readonly labels?: Readonly<Record<string, string>>;
  /** Workload annotations (slice E: engine, model, created; docker writes them as labels). */
  readonly annotations?: Readonly<Record<string, string>>;
  /**
   * With `resumeHint` (slice E): record `name` in the laptop's kept index right
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
   * A line to paint INSTEAD of a terminal spinner (docs/feat/session-hop-ux slice
   * 2): the hop's own status row. Present → the interactive single-line contract
   * with no TTY, so `log`/`info` keep only what is really a notice (a warning, an
   * error, the dispose's `quitReport`). A hop passes `createHopLiveLine`.
   */
  readonly liveLine?: HopLiveLine;
  /**
   * Where the pod daemon's stderr is kept (`daemon.log`, 0600, bounded), given the
   * workload's name: the run's state dir when it has one. Absent: nothing is kept.
   * The stderr is NEVER written to the terminal (docs/feat/run-prompt.md round 4).
   */
  readonly daemonLogPath?: (name: string) => string | undefined;
  /** In-TUI notices (the session's `NoticeHub`), e.g. a reconnect that lost the last turn. */
  readonly notify?: (text: string, hint?: string) => void;
  /**
   * This runtime's client can put a `move_session` proposal to its owner (D8/D9):
   * a HOP target's own runtime is the one such pod client, so a session created
   * there is still offered the tool (H5 review finding 1). `run` never sets it.
   */
  readonly hop?: true;
  /**
   * This tentacle's version for the pod-binary check and the container probe
   * (tests); defaults to `APP_RELEASE_VERSION` (a plain version: it is compared).
   */
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
 * `armExitNet` for a TUI of an `--rm` detached run (docs/feat/detached-handover.md):
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

/** The ONE install-dir probe's budget: it also asks each candidate binary's `--version`. */
const PLACEMENT_TIMEOUT_MS = 30_000;

/**
 * The install-dir probe (docs/fix/inject-bin-dir-probe.md): ONE `sh -c` exec
 * that probes the image, proves which candidate dir can take the binary
 * (written to AND executed from) and asks every candidate's `tentacle` for its
 * version — all BEFORE any upload. `null`: it did not run (no `sh`: a
 * distroless image; another non-zero exit). A thrown exec is the caller's.
 */
async function probePlacement(
  host: EngineHost,
  name: string,
  container: string | undefined,
  options: {
    readonly candidates: readonly InstallCandidate[];
    readonly buildId: boolean;
    readonly mount?: string;
  },
): Promise<{ readonly parsed: ParsedPlacement | null; readonly run: EngineRunExecResult }> {
  const run = await host.runExec(
    {
      name,
      container,
      command: [
        "sh",
        "-c",
        placementScript({
          candidates: options.candidates,
          buildId: options.buildId,
          ...(options.mount !== undefined ? { mount: options.mount } : {}),
        }),
      ],
    },
    undefined,
    { timeoutMs: PLACEMENT_TIMEOUT_MS },
  );
  return {
    parsed: run.exitCode === 0 ? parsePlacement(run.stdout, options.candidates.length) : null,
    run,
  };
}

/** The error when the probe did not run and a binary must be installed: nothing is uploaded. */
function placementFailedError(prefix: string, run: EngineRunExecResult | undefined): Error {
  const detail = run
    ? untrustedText(run.stderr.trim() || run.status || `exit ${run.exitCode}`)
    : "no answer";
  return new Error(
    `${prefix} failed to inject tentacle: the install-dir probe did not run (${detail}) — the image may have no shell (sh): distroless/scratch images are unsupported; use an image with sh and head`,
  );
}

/**
 * What this laptop would inject, for the reuse rule (docs/fix/stale-pod-binary.md):
 * its version and build, read laptop-side from the files. `undefined` version
 * (from source, no override): nothing to compare.
 */
async function expectedPodBinary(
  config: Pick<TentacleConfig, "configDir">,
  appVersion: string | undefined,
): Promise<{ readonly version: string | undefined; readonly build: string | undefined }> {
  const version = appVersion ?? APP_RELEASE_VERSION;
  const podBinOverride = process.env.TENTACLE_POD_BIN;
  const build = await expectedContainerBuild({
    appVersion: version,
    ...(podBinOverride ? { podBinOverride } : {}),
    binaries: config.configDir
      ? POD_BINARY_TARGETS.map((target) =>
          configBinPath(config.configDir as string, target),
        ).filter((path) => existsSync(path)) // a missing one fails at inject (`podBinaryProblem`)
      : [],
    readBuild: (path) => readBinaryBuildId(path),
  });
  const expected = await expectedContainerVersion({
    appVersion: version,
    ...(podBinOverride ? { podBinOverride } : {}),
    readMarker: (path) => readBinaryVersion(path),
  });
  return { version: expected, build };
}

/**
 * The binary to exec `serve --bridge` with in a workload `run`/`attach` already
 * provisioned (`tentacle logs -f <run>`, docs/fix/inject-bin-dir-probe.md Q2):
 * the same ONE placement probe, read-only here (nothing is ever uploaded) — the
 * matching binary in any candidate, else the first that answers. When the probe
 * cannot tell (no shell, an exec error, nothing answers): `--bin-dir`'s path,
 * as before. Never throws.
 */
export async function findPodBinary(
  host: EngineHost,
  name: string,
  options: {
    readonly container?: string;
    readonly binDir?: string;
    readonly configDir?: string;
    readonly appVersion?: string;
  },
): Promise<string> {
  const fallback = `${options.binDir ?? DEFAULT_INSTALL_DIR}/tentacle`;
  try {
    const expected = await expectedPodBinary(
      { configDir: options.configDir ?? "" },
      options.appVersion,
    );
    const candidates = installCandidates(options.binDir);
    const { parsed } = await probePlacement(host, name, options.container, {
      candidates,
      buildId: expected.build !== undefined,
    });
    return parsed === null
      ? fallback
      : (choosePlacement(parsed, candidates, expected).found?.path ?? fallback);
  } catch {
    return fallback;
  }
}

/** A workload `provisionWorkload` made ready: its binary installed, no daemon started. */
export interface ProvisionedWorkload {
  readonly name: string;
  /** The binary the daemon runs: where it was installed, or the image's own matching one. */
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
  // The install dir is picked in the pod by ONE probe before any upload
  // (docs/fix/inject-bin-dir-probe.md): /usr/local/bin → $HOME/.local/bin →
  // ${TMPDIR:-/tmp}/tentacle-<uid>/bin, or only --bin-dir when given; the daemon
  // is then exec'd by that absolute path.
  const candidates = installCandidates(deps.binDir);
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
      ...(deps.network ? { network: deps.network } : {}),
      ...(deps.labels ? { labels: deps.labels } : {}),
      ...(deps.annotations ? { annotations: deps.annotations } : {}),
    });
  } catch (error) {
    status?.finish();
    throw error;
  }

  // A kept run (no `--rm`): tentacle never removes this workload (owner, 2026-10-27).
  const { resumeHint } = deps;
  // Slice E: a kept workload goes in the laptop index (`tentacle ps`) as soon as
  // it exists. A failed write is said with the kept line — never swallowed.
  let forgetKept: (() => void) | undefined;
  let notRecorded = "";
  if (resumeHint && deps.recordKept) {
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
  const attachText = notRecorded && resumeHint ? resumeHint(name) : `tentacle attach ${name}`;
  const keptLine = resumeHint
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
  // pre-ready failures too. Not armed for a kept run (no `--rm`): Ctrl+C keeps it too.
  if (!keptLine) {
    armExitNet(host, name, () => true);
  }

  // The workload is usable with `binPath`: the line(s) to say, then the handle.
  const ready = (binPath: string): ProvisionedWorkload => {
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
  };

  try {
    phase(`[${host.noun}] waiting for ${name} to become ready…`);
    await host.waitForReady(name);
    // Where the binary can go, and whether the image already ships THIS
    // laptop's: ONE exec, before any upload. Any failure here throws → the
    // workload is deleted below (or kept, said).
    const prefix = `[${host.noun} ${name}]`;
    const expected = await expectedPodBinary(config, deps.appVersion);
    const { parsed, run: placeRun } = await probePlacement(host, name, container, {
      candidates,
      buildId: expected.build !== undefined,
      ...(workspace ? { mount: workspace.target } : {}),
    });
    if (parsed === null) {
      throw placementFailedError(prefix, placeRun);
    }
    const choice = choosePlacement(parsed, candidates, expected);
    // Reused only when it is exactly what this laptop would inject (Owner Q4): from
    // source, with no version to compare, `run` always injects (as before).
    if (choice.decision.kind === "reuse" && choice.found && expected.version !== undefined) {
      status?.finish();
      const reused = untrustedText(choice.found.stdout.trim().split("\n")[0] ?? "") || "tentacle";
      if (!status) {
        info(
          `[${host.noun}] ${reused} found in ${name} (the image's); starting the agent daemon\n`,
        );
      }
      return ready(choice.found.path);
    }
    if (choice.installDir === undefined) {
      throw new Error(`${prefix} ${choice.noDir ?? "no install dir"}`);
    }
    const binPath = `${choice.installDir}/tentacle`;
    // Inject the tool into the sandbox (F4.e): the image need not contain
    // `tentacle`. Any failure here throws → the workload is deleted below.
    // In interactive mode the injection phases (resolve → transfer → verify)
    // drive the SAME status line via `onStatus`.
    const image = parsed.image;
    const version = await injectAgentBinary({
      host,
      name,
      noun: host.noun,
      binPath,
      container,
      probe: () => withEngineArch(host, classifyImage(image)),
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
    return ready(binPath);
  } catch (error) {
    // The workload was created but never became usable — delete it before
    // surfacing (a kept run, no `--rm`: left to inspect).
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
 * removes the workload (kept with `resumeHint`). Throws (after cleaning up any
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
      command: podDaemonCommand(binPath),
    };
    const execOptions: EngineExecChannelOptions = { onStderr: stderr.onStderr };
    // The current exec; a reconnect replaces it (and teardown closes that one).
    let channel = host.openExec(target, execOptions);
    const redial = execChannelFactory(host, target, execOptions);
    const runtime = await createLocalRuntime({
      ...laptopModels(config),
      // This daemon runs OUR model over the reverse tunnel (`podDaemonCommand`
      // always passes `--model-proxy`), so an "images are off" reason names
      // this laptop's model and points at THIS laptop's config — never at the
      // pod's, where our key does not exist (docs/feat/images-off-reason.md,
      // fix round 1 finding 1). A daemon that reports its OWN model still wins
      // (`RemoteClient.imageInput`).
      modelName: config.model,
      modelScope: "laptop",
      sessionSettings: carriedSettings(config),
      // A SEED, never a setting (docs/feat/tool-toggles.md D5): the pod daemon
      // unions it with its own config's set — off wins.
      baseDisabledTools: config.disabledTools,
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
      // D8/D9: a HOP target's runtime is the one pod client that can put a
      // proposal to its owner, so a session created here is still offered the
      // tool (H5 review finding 1). `run` never sets it.
      ...(deps.hop ? { hop: true as const } : {}),
      // Laptop-side RPC errors (incl. a local model failure, which the pod only
      // sees opaque) join the log file. They are NOT a failure of the run: the
      // TUI showed the turn's error already.
      onPeerError: (error) => stderr.onStderr(`[laptop rpc] ${error.message}\n`),
      ...(deps.notify ? { notify: deps.notify } : {}),
    });
    fault.watch(runtime);
    // A tentacle-made pod's container is `host.defaultContainer` (k8s: always
    // shown as `/container`); docker/podman have none.
    return Object.assign(runtime, {
      markFault: fault.mark,
      announce,
      target: engineTarget(host, name, host.defaultContainer),
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
  /** Install dir for the injected binary (`--bin-dir`, no fallback); absent: picked by the probe, as in `run`. */
  readonly binDir?: string;
  /**
   * This tentacle's version for the pod-binary check and the container probe
   * (tests); defaults to `APP_RELEASE_VERSION` (a plain version: it is compared).
   */
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
   * A line to paint INSTEAD of a terminal spinner (docs/feat/session-hop-ux slice
   * 2): the hop's own status row. Present → the interactive single-line contract
   * with no TTY, so `log`/`info` keep only what is really a notice (a warning, an
   * error, the dispose's `quitReport`). A hop passes `createHopLiveLine`.
   */
  readonly liveLine?: HopLiveLine;
  /**
   * Where the pod daemon's stderr is kept (`daemon.log`, 0600, bounded), given the
   * workload's name: the run's state dir when it has one. Absent: nothing is kept.
   * The stderr is NEVER written to the terminal (docs/feat/run-prompt.md round 4).
   */
  readonly daemonLogPath?: (name: string) => string | undefined;
  /** In-TUI notices (the session's `NoticeHub`), e.g. a reconnect that lost the last turn. */
  readonly notify?: (text: string, hint?: string) => void;
  /** `createLocalRuntime`'s: false in the relay, no one to ask. */
  readonly interactive?: boolean;
  /** `createLocalRuntime`'s: the first session's uid. */
  readonly sessionId?: string;
  /** `createLocalRuntime`'s: a TUI of a detached run, whose sessions others share. */
  readonly shared?: true;
  /**
   * This runtime's client can put a `move_session` proposal to its owner (D8/D9):
   * a HOP target's own runtime is the one such pod client, so the session it
   * creates there is still offered the tool (H5 review finding 1). `run`/`attach`
   * leave it unset.
   */
  readonly hop?: true;
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
    // Preflight, ONE exec (docs/fix/inject-bin-dir-probe.md): which candidate
    // dir can take the binary (written to AND executed from), and what each
    // candidate's `tentacle` (then the one on PATH) answers. A matching binary in
    // ANY candidate is reused — a re-attach, or an image that ships it — and the
    // whole injection (an ~89 MB transfer) is skipped; any binary reaches the one
    // resident (its socket does not depend on the install dir). When we inject,
    // it is to the first dir that passed, and the daemon is exec'd by that
    // absolute path. One-shot execs do not go through the status line (same as
    // in `run`): `injectAgentBinary` owns its phases via `onStatus`.
    // The BUILD rule (docs/fix/stale-pod-binary.md): a binary built before build
    // ids has none, and may reject `serve --bridge` while reporting this very
    // version. Reused only when its build id is the one of the binary THIS
    // laptop would inject (read from the file, laptop-side); from source with no
    // override there is nothing to compare (Q3: reused as before). Known before
    // the probe, so the probe asks for the build in the same exec.
    // Reused only when it is exactly what this laptop would inject (a
    // re-attach); any other version is replaced, so the daemon speaks this
    // client's protocol. From source with no override: reused as before.
    const { version: expected, build: expectedBuild } = await expectedPodBinary(
      config,
      deps.appVersion,
    );
    const candidates = installCandidates(deps.binDir);
    const versionOf = (bin: string): Promise<EngineRunExecResult> =>
      host.runExec(
        {
          name,
          container,
          command: [bin, "--version", ...(expectedBuild !== undefined ? ["--build-id"] : [])],
        },
        undefined,
        { timeoutMs: 15_000 },
      );
    // The answer is pod stdout, and it reaches the log: its first line only.
    const versionLabel = (run: { readonly stdout: string }): string =>
      untrustedText((run.stdout.trim().split("\n")[0] ?? "").trim()) || "tentacle";
    const decide = (run: { readonly exitCode: number | null; readonly stdout: string }) =>
      containerDecision(run, expected, {
        expected: expectedBuild,
        found: parseBuildFromVersionProbe(run),
      });
    let placement: ParsedPlacement | null;
    let placeRun: EngineRunExecResult;
    try {
      ({ parsed: placement, run: placeRun } = await probePlacement(host, name, container, {
        candidates,
        buildId: expectedBuild !== undefined,
        // The container's workspace mount (docker: the same path as the laptop
        // folder): never written into. A forged label only narrows the candidates.
        ...(state.workspace !== undefined ? { mount: state.workspace } : {}),
      }));
    } catch (error) {
      status?.finish();
      // A wrong container surfaces here (the first exec) — translate it.
      throw host.execError(error, { name, container });
    }
    const prefix = `[${host.noun} ${name}]`;
    let binPath: string;
    let probe: { readonly exitCode: number | null; readonly stdout: string };
    let found: string;
    let decision: ReturnType<typeof decide>;
    // Raised (inside the install's `try`, so a failed REPLACE still goes on with
    // the old binary) when a binary must be installed: never after an upload.
    let cannotInstall: Error | undefined;
    if (placement !== null) {
      const choice = choosePlacement(placement, candidates, {
        version: expected,
        build: expectedBuild,
      });
      decision = choice.decision;
      probe = choice.found ?? { exitCode: 1, stdout: "" };
      found = choice.found?.path ?? "tentacle";
      binPath = `${choice.installDir ?? deps.binDir ?? DEFAULT_INSTALL_DIR}/tentacle`;
      if (choice.installDir === undefined) {
        cannotInstall = new Error(`${prefix} ${choice.noDir ?? "no install dir"}`);
      }
    } else {
      // No shell (distroless) or the probe failed: today's direct `--version`
      // execs still find a binary to REUSE; an install cannot be proven, so none
      // is tried (never an upload that fails after the transfer).
      binPath = `${deps.binDir ?? DEFAULT_INSTALL_DIR}/tentacle`;
      cannotInstall = placementFailedError(prefix, placeRun);
      try {
        found = binPath;
        let direct = await versionOf(found);
        if (direct.exitCode !== 0) {
          found = "tentacle";
          direct = await versionOf(found);
        }
        probe = direct;
      } catch (error) {
        status?.finish();
        throw host.execError(error, { name, container });
      }
      decision = decide(probe);
    }
    let serveBin = decision.kind === "reuse" ? found : binPath;
    // A live daemon of an older build is never killed: ONE line, no log.
    const refuseLive = (message: string, busy: boolean | undefined): Error =>
      decision.kind === "replace" && decision.reason === "build" && busy
        ? new StaleBuildError(staleBuildBusyLine(name))
        : new Error(message);
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
        throw refuseLive(verdict.message, verdict.busy);
      }
      // Once the bytes are staged, so an install that cannot land stops nothing,
      // and before the rename, so `oldBin` still exists. The transfer gave a
      // client time to attach: asked again.
      const stopResident = async (): Promise<void> => {
        const again = residentGuard(await residentStatusOf(oldBin), name);
        if (again.kind === "refuse") {
          const refusal = refuseLive(again.message, again.busy);
          throw refusal instanceof StaleBuildError
            ? refusal
            : new ResidentStopRefused(again.message);
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
        if (cannotInstall !== undefined || placement === null) {
          throw cannotInstall ?? placementFailedError(prefix, placeRun);
        }
        const image = placement.image;
        version = await injectAgentBinary({
          host,
          name,
          noun: host.noun,
          binPath,
          container,
          probe: () => withEngineArch(host, classifyImage(image)),
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
        if (
          decision.kind !== "replace" ||
          error instanceof ResidentStopRefused ||
          error instanceof StaleBuildError
        ) {
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
              expected: expected ?? decision.had,
              reason: decision.reason,
              // The old binary stays where it was (on PATH, or a dir we cannot
              // write): the two differ from now on — named, never silent.
              ...(found !== binPath ? { installedAt: binPath } : {}),
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
      command: podDaemonCommand(serveBin),
    };
    const execOptions: EngineExecChannelOptions = { onStderr: stderr.onStderr };
    // The current exec; a reconnect replaces it (and teardown closes that one).
    let channel = host.openExec(target, execOptions);
    const redial = execChannelFactory(host, target, execOptions);
    const fault = createFaultWatch();
    const runtime = await createLocalRuntime({
      ...laptopModels(config),
      // The same `--model-proxy` daemon as `run`: the laptop's model and the
      // laptop's config are what an "images are off" reason names
      // (docs/feat/images-off-reason.md, fix round 1 finding 1).
      modelName: config.model,
      modelScope: "laptop",
      // This config: `attach`'s reload for the run's folder, the relay's profile.
      sessionSettings: carriedSettings(config),
      // A SEED, never a setting (docs/feat/tool-toggles.md D5): the pod daemon
      // unions it with its own config's set — off wins.
      baseDisabledTools: config.disabledTools,
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
      // The same rule as `run`: only a HOP target's client asks its owner (D8/D9).
      ...(deps.hop ? { hop: true as const } : {}),
      // Laptop-side RPC errors join the log file; a model/turn error is not a
      // failure of the attach. The TUI shows its cause as a status-only text;
      // the full error is only here.
      // No log file and no terminal (the detached relay): its own log is the
      // only place a refused name of a hostile pod can leave a trace. ONLY that
      // refusal goes there (bounded, name-only text): any other error can carry an
      // endpoint's body or a pod's junk, which must not reach an unattended log.
      onPeerError: (error) =>
        stderr.path === undefined && deps.interactive === false
          ? error instanceof ModelNameRefusedError
            ? deps.log(`[laptop rpc] ${error.message}`)
            : undefined
          : stderr.onStderr(`[laptop rpc] ${error.message}\n`),
      ...(deps.notify ? { notify: deps.notify } : {}),
      ...(deps.interactive !== undefined ? { interactive: deps.interactive } : {}),
      ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
      ...(deps.shared ? { shared: true as const } : {}),
    });
    fault.watch(runtime);
    return Object.assign(runtime, {
      markFault: fault.mark,
      target: engineTarget(host, name, state.inUse),
    });
  } catch (error) {
    status?.finish();
    // NO delete here: the workload is not ours. The injection's own messages
    // (e.g. the glibc hint) surface untouched; a wrong container is translated.
    // The whole cause goes to the log; its path rides on the error.
    throw recordFailure(host.execError(error, { name, container }), stderr);
  }
}
