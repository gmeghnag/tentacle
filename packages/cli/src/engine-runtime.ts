/**
 * The engine runtime (F4.c, the `run` / `attach` commands): run the agent
 * daemon inside a workload — a Kubernetes pod or a Docker/Podman container,
 * behind one `EngineHost` (`engine-host.ts`) — driven from the local TUI,
 * reusing the SAME `RemoteClient` ↔ `Connection` stack as the worker and
 * remote-control paths. The only engine-specific parts are the host's transport
 * and lifecycle:
 *
 *   create → waitForReady → injectAgentBinary (F4.e: probe arch, stream the
 *   binary, verify with --version) → openExec(`tentacle serve --stdio`) →
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
import {
  containerDecision,
  expectedContainerVersion,
  parseVersionLine,
  replaceFailedWarning,
} from "./container-version.ts";
import {
  type EngineExecChannelOptions,
  type EngineExecTarget,
  type EngineHost,
  type EngineRunExecResult,
  WorkloadRemovedError,
  type WorkloadState,
} from "./engine-host.ts";
import { type LocalRuntime, createLocalRuntime } from "./local-runtime.ts";
import { configuredModelProvider } from "./model-provider.ts";
import { PodBinaryError, checkPodBinaries, resolvePodBinary } from "./pod-binary-build.ts";
import { injectAgentBinary, probePod } from "./pod-binary.ts";
import type { SessionSaver } from "./session-saver.ts";
import { StatusLine } from "./status-line.ts";
import { untrustedText } from "./untrusted-text.ts";
import { readBinaryVersion } from "./version-marker.ts";
import { APP_VERSION } from "./version.ts";
import { type WorkspaceMount, attachCwdWarning, hiddenSummary } from "./workspace-mount.ts";

/**
 * The pod daemon's command line (`run` and `attach`). `--auto-title` carries
 * the LAPTOP's `model.autoTitle` (docs/feat/session-titles.md): the pod's own
 * config never turns model titles on. `--context-window` carries the LAPTOP's
 * `model.contextWindow`: the window is the model's, and the model lives here
 * (docs/feat/context-awareness.md). Neither is a secret, so argv is fine.
 */
export function podDaemonCommand(
  bin: string,
  config: Pick<TentacleConfig, "autoTitle" | "contextWindow">,
): string[] {
  return [
    bin,
    "serve",
    "--stdio",
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

/** A bounded stderr collector that flushes once, on teardown. */
export interface PodStderrSink {
  /** Accumulate a chunk of the pod daemon's stderr (never written live). */
  onStderr(text: string): void;
  /** Write the buffered stderr to the log (idempotent; no-op when empty). */
  flush(): void;
}

/**
 * Collect the pod daemon's stderr instead of writing it straight to stdout.
 *
 * During a live session the TUI owns the terminal (Ink's alternate screen), so
 * forwarding daemon stderr to stdout as it arrives corrupts the render (the
 * `d19f10d` TODO: a dropped-connection error leaking over the UI). Instead we
 * buffer it — tail-capped so a chatty daemon can't grow it without bound — and
 * flush it exactly once: on teardown, after Ink has left the alt-screen, and on
 * the startup-failure path (before the TUI mounts), so a daemon that never came
 * up is still diagnosable.
 */
export function createStderrSink(prefix: string, log: (line: string) => void): PodStderrSink {
  const capBytes = 16 * 1024;
  let buf = "";
  return {
    onStderr(text: string): void {
      buf += text;
      if (buf.length > capBytes) {
        buf = buf.slice(buf.length - capBytes);
      }
    },
    flush(): void {
      if (buf.length === 0) {
        return;
      }
      log(`${prefix} daemon stderr:\n${buf.endsWith("\n") ? buf : `${buf}\n`}`);
      buf = "";
    },
  };
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
  /** In-TUI notices (the session's `NoticeHub`), e.g. a reconnect that lost the last turn. */
  readonly notify?: (text: string) => void;
  /** This tentacle's version for the pod-binary check (tests); defaults to `APP_VERSION`. */
  readonly appVersion?: string;
}

/**
 * The reconnect channel factory for an engine daemon (pod-attach Layer 2,
 * docs/feat/client-reattach-frontends.md §2): check the workload, then open the
 * SAME exec again. A new exec is a new `serve --stdio` (the old one ended with
 * its stdin), so the client finds its session unknown and recreates it from the
 * laptop's history; a turn in flight is reported lost, never re-run.
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
 * Register the process-level safety net that deletes the workload on exit.
 *
 * Closing the TUI with Ctrl+C makes the terminal code call `process.exit`
 * *before* the runtime's `dispose()` runs, so the normal `remove` never
 * fires and the workload is orphaned. The `exit` handler runs on **every** exit
 * path (SIGINT / SIGTERM / normal / crash), and `removeBestEffort` spawns a
 * detached, fire-and-forget child that issues the `DELETE` — so it never
 * blocks the exit and never throws. See `k8s/pod-cleanup.ts` and
 * `docker/container-cleanup.ts`.
 */
function registerExitCleanup(host: EngineHost, name: string): void {
  process.once("exit", () => {
    host.removeBestEffort(name);
  });
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
): Promise<LocalRuntime> {
  const { host } = deps;
  const name = deps.name ?? `tentacle-${crypto.randomUUID().slice(0, 8)}`;
  // Install path in the pod: a read-only rootfs (a hardened pod) needs a writable
  // dir via --bin-dir (e.g. /tmp); the daemon is then exec'd by this absolute path.
  const binPath = `${deps.binDir ?? "/usr/local/bin"}/tentacle`;
  // The pod daemon's stderr is buffered (not written live) so it never corrupts
  // the Ink TUI; flushed once on teardown / startup failure. See `createStderrSink`.
  const stderr = createStderrSink(`[${host.noun} ${name}]`, deps.log);
  const container = host.defaultContainer;
  // Interactive (TTY) startup is ONE line: a spinner repainted per phase
  // (create → ready → inject, with the transfer bar as the bar phase's text),
  // cleared when the daemon starts. Piped (log/CI) logs one line per phase
  // (the `log` sink), so transcripts stay readable.
  const status = (process.stdout.isTTY ?? false) ? new StatusLine({ write: deps.log }) : null;
  const phase = (text: string): void => {
    if (status) {
      status.set(text);
    } else {
      deps.log(`${text}\n`);
    }
  };

  // Offline pod-binary check BEFORE any cluster mutation (D1): a missing or
  // stale <configDir>/bin binary fails here, so no pod is created and none
  // needs deleting. Both arches: the pod's is unknown until it exists.
  await checkPodBinaries({ configDir: config.configDir, appVersion: deps.appVersion });

  const { workspace } = deps;
  const hidden = workspace ? hiddenSummary(workspace) : undefined;
  const mounted = workspace
    ? ` — workspace ${workspace.target} (rw)${hidden ? `. ${hidden}` : ""}`
    : "";
  phase(`[${host.noun}] creating ${name} (image ${deps.image}) in ${host.where}${mounted}…`);
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
  const keptLine = keepHint
    ? `[${host.noun}] kept ${name} — resume with: ${keepHint(name)}${workspace ? `  # workspace ${workspace.target}` : ""}\n`
    : undefined;
  const logKept = (line: string): void => {
    deps.log(line);
    if (notRecorded) {
      deps.log(notRecorded);
    }
  };
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
      logKept(keptLine);
    } else {
      void host.remove(name).catch(() => {});
    }
  };

  // Safety net: if the process exits before `dispose()` (Ctrl+C → process.exit
  // in the terminal code, a crash, or a kill), the workload is still deleted by
  // a detached child. Registered right after it exists, so it covers
  // pre-ready failures too. Not armed with `--keep`: Ctrl+C keeps it too.
  if (!keptLine) {
    registerExitCleanup(host, name);
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
      deps.log(`[${host.noun}] ${version} ready in ${name}; starting the agent daemon\n`);
    }
    // Kept: say so BEFORE the TUI mounts too — this line stays on the main
    // screen, so a Ctrl+C exit (no `dispose`) still shows how to resume.
    if (keptLine) {
      logKept(keptLine);
    }
    const target: EngineExecTarget = {
      name,
      container,
      command: podDaemonCommand(binPath, config),
    };
    const execOptions: EngineExecChannelOptions = { onStderr: stderr.onStderr };
    // The current exec; a reconnect replaces it (and teardown closes that one).
    let channel = host.openExec(target, execOptions);
    const redial = execChannelFactory(host, target, execOptions);
    return await createLocalRuntime({
      ...laptopModels(config),
      channel,
      channelFactory: async () => {
        channel = await redial();
        return channel;
      },
      disposeTransport: () => {
        channel.close();
        // Safe here: `dispose()` runs after the TUI has unmounted (left the
        // alt-screen), so the buffered daemon stderr can go to stdout.
        stderr.flush();
        removeUnlessKept();
      },
      permissions: deps.permissions,
      saver: deps.saver,
      cwd: config.cwd,
      model: config.model,
      resume: deps.resume,
      daemonKind: "container",
      // Laptop-side RPC errors (incl. a local model failure, which the pod only
      // sees opaque) join the buffered daemon stderr: flushed after unmount.
      onPeerError: (error) => stderr.onStderr(`[laptop rpc] ${error.message}\n`),
      ...(deps.notify ? { notify: deps.notify } : {}),
    });
  } catch (error) {
    // The workload was created but never became usable — delete it before
    // surfacing (kept with `--keep`: left to inspect).
    status?.finish();
    // The TUI never mounted on this path, so flushing any daemon stderr (e.g. a
    // `serve` that failed to start) to stdout is safe and aids diagnosis.
    stderr.flush();
    removeUnlessKept(error);
    throw error;
  }
}

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
  /** In-TUI notices (the session's `NoticeHub`), e.g. a reconnect that lost the last turn. */
  readonly notify?: (text: string) => void;
}

/**
 * `attach` on any engine: attach to an EXISTING workload — inject the agent
 * binary if it does not already have it, open the daemon exec, and build the
 * same persisting local runtime as `startEngineRuntime` — with one deliberate
 * difference: the workload is USER-OWNED, so this runtime never creates,
 * starts, removes, or arms an exit net for it. `dispose` closes the exec
 * channel (the daemon dies with it); the workload stays running for reuse
 * (re-attach is a sub-second version-probe) and for cleanup by its owner.
 *
 * No `registerExitCleanup` safety net: the whole point is that a TUI exit
 * (Ctrl+C → process.exit) must NOT delete it.
 */
export async function attachEngineRuntime(
  config: TentacleConfig,
  deps: EngineAttachRuntimeDeps,
): Promise<LocalRuntime> {
  const { host } = deps;
  const { name } = deps;
  // Buffer the pod daemon's stderr so it never corrupts the Ink TUI; flushed
  // once on teardown / startup failure. See `createStderrSink`.
  const stderr = createStderrSink(`[${host.noun} ${name}]`, deps.log);
  // No `?? AGENT_CONTAINER` default: when the caller does not name a container,
  // the exec API omits the `container` parameter and picks the only/default
  // one (single-container pods need no `-c`).
  const container = deps.container;
  // Same single-line (TTY) / one-line-per-phase (piped) contract as `run`.
  const status = (process.stdout.isTTY ?? false) ? new StatusLine({ write: deps.log }) : null;
  const phase = (text: string): void => {
    if (status) {
      status.set(text);
    } else {
      deps.log(`${text}\n`);
    }
  };

  phase(`[${host.noun}] attaching to ${name} in ${host.where}…`);
  let state: WorkloadState;
  try {
    // A missing workload arrives as an actionable error (wrong name / namespace).
    state = await host.inspect(name);
  } catch (error) {
    status?.finish();
    throw error;
  }
  // A terminated / not-runnable workload can never host the daemon (and
  // `waitForReady` would just time out) — say so up front. Never started here.
  if (state.kind === "stopped") {
    status?.finish();
    throw new Error(state.detail);
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

  try {
    // Preflight: if the pod ALREADY has a working `tentacle` (a re-attach
    // after a previous attach, or an image that ships it), the whole injection
    // — 89 MB transfer — is skipped. Any failure (not on PATH, wrong arch,
    // bad libc) falls through to the injection, which re-verifies anyway.
    // One-shot execs do not go through the status line (same as in `run`):
    // `injectAgentBinary` owns its phases via `onStatus`.
    // Default exec path: the on-PATH `tentacle` when the pod already has it
    // (preflight passes). When we inject, the daemon is exec'd by the absolute
    // install path (supports a writable non-PATH dir like /tmp via --bin-dir).
    const binPath = `${deps.binDir ?? "/usr/local/bin"}/tentacle`;
    let serveBin = "tentacle";
    let probe: EngineRunExecResult;
    try {
      probe = await host.runExec(
        { name, container, command: ["tentacle", "--version"] },
        undefined,
        { timeoutMs: 15_000 },
      );
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
    let version: string;
    if (decision.kind === "reuse") {
      version = probe.stdout.trim() || "tentacle";
    } else {
      serveBin = binPath; // injected to our dir → exec by absolute path
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
        });
      } catch (error) {
        // A plain injection failure: unchanged (nothing else to run).
        if (decision.kind !== "replace") {
          throw error;
        }
        // Replacing failed (orchestrator decision, follow-up 1): do not abort —
        // go on with the container's own tentacle, IF it still answers (the
        // failure may have come after the rename), and warn. `initialize` still
        // refuses a protocol skew with its full message.
        const again = await host
          .runExec({ name, container, command: ["tentacle", "--version"] }, undefined, {
            timeoutMs: 15_000,
          })
          .catch(() => null);
        if (again?.exitCode !== 0) {
          throw error;
        }
        serveBin = "tentacle";
        version = again.stdout.trim() || "tentacle";
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
      if (decision.kind === "replace" && serveBin === binPath) {
        const line = `the container had tentacle ${decision.had ?? "of an unknown version"}; replaced with ${expected} (this laptop's)`;
        deps.notify?.(line);
        if (!status) {
          deps.log(`${line}\n`);
        }
      }
    }
    status?.finish();
    // Piped only: the TUI opening IS the confirmation in interactive mode.
    if (!status) {
      deps.log(
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
    return await createLocalRuntime({
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
        // Safe after the TUI has unmounted (left the alt-screen).
        stderr.flush();
      },
      permissions: deps.permissions,
      saver: deps.saver,
      cwd: config.cwd,
      model: config.model,
      resume: deps.resume,
      daemonKind: "container",
      // Laptop-side RPC errors (incl. a local model failure, which the pod only
      // sees opaque) join the buffered daemon stderr: flushed after unmount.
      onPeerError: (error) => stderr.onStderr(`[laptop rpc] ${error.message}\n`),
      ...(deps.notify ? { notify: deps.notify } : {}),
    });
  } catch (error) {
    status?.finish();
    // The TUI never mounted on this path, so flushing any daemon stderr is safe.
    stderr.flush();
    // NO delete here: the workload is not ours. The injection's own messages
    // (e.g. the glibc hint) surface untouched; a wrong container is translated.
    throw host.execError(error, { name, container });
  }
}
