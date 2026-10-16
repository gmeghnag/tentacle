/**
 * The pod-execution runtime (F4.c, the `run` command): run the agent daemon
 * inside a Kubernetes pod, driven from the local TUI, reusing the SAME
 * `RemoteClient` ↔ `Connection` stack as the worker and remote-control paths.
 * The only new parts are the transport (the exec WebSocket, F4.b) and the pod
 * lifecycle here:
 *
 *   createPod → waitForReady → injectAgentBinary (F4.e: probe arch, stream the
 *   binary, verify with --version) → openExec(`tentacle serve --stdio`) →
 *   createLocalRuntime(handshake + persisting sessions) → …use… → deletePod.
 *
 * The injection (F4.e) means the image no longer needs to contain the tool —
 * any Linux **glibc** image with `sh` + `head` works; see `pod-binary.ts`.
 *
 * The namespace is NOT pre-checked: the kubeconfig context's namespace is not
 * guaranteed to exist, but a `createPod` into a missing namespace fails with a
 * clear 404 that we translate into an actionable error (`podCreateError`) —
 * no side-effectful namespace creation by a "run" command.
 *
 * Persistence stays on the laptop (the `createLocalRuntime` store), so the pod
 * is a stateless sandbox and `--resume` works locally.
 */
import type { SessionRecord } from "@tentacle/agent";
import type { JsonSessionStore } from "@tentacle/agent";
import type { TentacleConfig } from "@tentacle/config";
import type { PermissionBroker } from "@tentacle/core";
import {
  AGENT_CONTAINER,
  type ExecChannelOptions,
  type ExecTarget,
  KubeApiError,
  type Pod,
  type RunExecOptions,
  type RunExecResult,
  TERMINAL_PHASES,
  type WaitForReadyOptions,
  buildPodManifest,
  podIsReady,
} from "@tentacle/k8s";
import { OpenAIProvider } from "@tentacle/providers";
import type { DuplexChannel } from "@tentacle/transport";
import { type LocalRuntime, createLocalRuntime } from "./local-runtime.ts";
import { resolvePodBinary } from "./pod-binary-build.ts";
import { injectAgentBinary, probePodArch } from "./pod-binary.ts";
import { StatusLine } from "./status-line.ts";

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

/** The subset of `KubeClient` the pod runtime needs (injectable for tests). */
export interface PodCluster {
  createPod(pod: Pod, signal?: AbortSignal): Promise<Pod>;
  /** Fetch a pod's current state (the `exec` attach preflight). */
  getPod(name: string, signal?: AbortSignal): Promise<Pod>;
  waitForReady(name: string, options?: WaitForReadyOptions): Promise<Pod>;
  deletePod(name: string, signal?: AbortSignal): Promise<void>;
  /** Best-effort, non-blocking delete that survives `process.exit` (Ctrl+C). */
  deletePodBestEffort(name: string): void;
  openExec(target: ExecTarget, options?: ExecChannelOptions): DuplexChannel;
  runExec(target: ExecTarget, input?: Uint8Array, options?: RunExecOptions): Promise<RunExecResult>;
}

export interface PodRuntimeDeps {
  readonly kube: PodCluster;
  readonly namespace: string;
  readonly image: string;
  /** Pod name (optional; a random one is generated when omitted). */
  readonly name?: string;
  readonly permissions: PermissionBroker;
  readonly store: JsonSessionStore;
  readonly resume: SessionRecord | null;
  readonly log: (line: string) => void;
}

/**
 * Translate a `createPod` failure into an actionable error. The kubeconfig
 * context's namespace is not guaranteed to exist; a pod create into a missing
 * namespace fails with a 404 (`namespaces "…" not found`) — the only other
 * way a pod create 404s is the same, so it is safe to attribute. Other
 * failures (RBAC 403, quota 403/422, …) keep their (already readable)
 * `KubeApiError` message untouched.
 */
function podCreateError(error: unknown, namespace: string): Error {
  // The 404 body is a k8s `Status` JSON, so the namespace name arrives with
  // JSON-escaped quotes (`namespaces \"dev\" not found`) — strip backslashes.
  const body = error instanceof KubeApiError ? error.body.replace(/\\/g, "") : "";
  if (
    error instanceof KubeApiError &&
    error.status === 404 &&
    /namespaces\s+["']?[^"'\s]+["']?\s+not found/.test(body)
  ) {
    return new Error(
      `namespace "${namespace}" does not exist in this cluster — create it (e.g. kubectl create namespace ${namespace}) or pass --namespace <existing>`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Translate a one-shot exec that dies with "closed before the command reported
 * a status" (the apiserver closing the exec WebSocket without a k8s status —
 * the classic symptom of a WRONG CONTAINER on a multi-container pod) into an
 * actionable error. Any other failure keeps its own message untouched.
 */
function containerExecError(
  error: unknown,
  podName: string,
  container: string | undefined,
  namespace: string,
): Error {
  if (
    error instanceof Error &&
    /exec channel closed before the command reported a status/.test(error.message)
  ) {
    const where = container ? `container "${container}" of pod "${podName}"` : `pod "${podName}"`;
    return new Error(
      `cannot exec into ${where} — the exec closed before the command reported a status. The container may not exist (a multi-container pod): list them (kubectl describe pod ${podName} -n ${namespace}) and pass the right one with --container <c> (alias -c)`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Register the process-level safety net that deletes the pod on exit.
 *
 * Closing the TUI with Ctrl+C makes the terminal code call `process.exit`
 * *before* the runtime's `dispose()` runs, so the normal `deletePod` never
 * fires and the pod is orphaned. The `exit` handler runs on **every** exit
 * path (SIGINT / SIGTERM / normal / crash), and `deletePodBestEffort` spawns a
 * detached, fire-and-forget child that issues the `DELETE` — so it never
 * blocks the exit and never throws. See `k8s/pod-cleanup.ts`.
 */
function registerPodCleanup(kube: PodCluster, name: string): void {
  process.once("exit", () => {
    kube.deletePodBestEffort(name);
  });
}

/**
 * Create an ephemeral pod, connect the daemon over its exec channel, and build a
 * persisting local runtime against it. The returned runtime's `dispose` closes
 * the exec channel and deletes the pod. Throws (after cleaning up any created
 * pod) on failure — there is no in-process fallback.
 */
export async function startPodRuntime(
  config: TentacleConfig,
  deps: PodRuntimeDeps,
): Promise<LocalRuntime> {
  const name = deps.name ?? `tentacle-${crypto.randomUUID().slice(0, 8)}`;
  // The pod daemon's stderr is buffered (not written live) so it never corrupts
  // the Ink TUI; flushed once on teardown / startup failure. See `createStderrSink`.
  const stderr = createStderrSink(`[pod ${name}]`, deps.log);
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

  phase(`[pod] creating ${name} (image ${deps.image}) in namespace ${deps.namespace}…`);
  try {
    await deps.kube.createPod(
      buildPodManifest({ name, namespace: deps.namespace, image: deps.image }),
    );
  } catch (error) {
    status?.finish();
    // A missing namespace surfaces as a 404 from the pod create (not a
    // separate preflight) — translate it into something actionable.
    throw podCreateError(error, deps.namespace);
  }

  // Safety net: if the process exits before `dispose()` (Ctrl+C → process.exit
  // in the terminal code, a crash, or a kill), the pod is still deleted by a
  // detached child. Registered right after the pod exists, so it covers
  // pre-ready failures too.
  registerPodCleanup(deps.kube, name);

  try {
    phase(`[pod] waiting for ${name} to become ready…`);
    await deps.kube.waitForReady(name);
    // Inject the tool into the sandbox (F4.e): the image need not contain
    // `tentacle`. Any failure here throws → the pod is deleted below.
    // In interactive mode the injection phases (probe → resolve → transfer →
    // verify) drive the SAME status line via `onStatus`.
    const version = await injectAgentBinary({
      kube: deps.kube,
      podName: name,
      container: AGENT_CONTAINER,
      podArch: () => probePodArch(deps.kube, name, AGENT_CONTAINER),
      resolveBinary: (target) =>
        resolvePodBinary(target, {
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
      deps.log(`[pod] ${version} ready in ${name}; starting the agent daemon\n`);
    }
    const channel = deps.kube.openExec(
      {
        pod: name,
        container: AGENT_CONTAINER,
        command: ["tentacle", "serve", "--stdio", "--model-proxy"],
      },
      { onStderr: stderr.onStderr },
    );
    // The pod reaches the model through us (reverse-tunnel): serve the local
    // provider, so the endpoint and API key never leave the laptop.
    const modelProvider = new OpenAIProvider({
      baseURL: config.baseURL,
      model: config.model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
    return await createLocalRuntime({
      channel,
      disposeTransport: () => {
        channel.close();
        // Safe here: `dispose()` runs after the TUI has unmounted (left the
        // alt-screen), so the buffered daemon stderr can go to stdout.
        stderr.flush();
        void deps.kube.deletePod(name).catch(() => {});
      },
      permissions: deps.permissions,
      store: deps.store,
      cwd: config.cwd,
      model: config.model,
      resume: deps.resume,
      modelProvider,
    });
  } catch (error) {
    // The pod was created but never became usable — delete it before surfacing.
    status?.finish();
    // The TUI never mounted on this path, so flushing any daemon stderr (e.g. a
    // `serve` that failed to start) to stdout is safe and aids diagnosis.
    stderr.flush();
    void deps.kube.deletePod(name).catch(() => {});
    throw error;
  }
}

export interface PodExecRuntimeDeps {
  readonly kube: PodCluster;
  readonly namespace: string;
  /** The EXISTING pod's name (no create, no delete — see `startExecRuntime`). */
  readonly podName: string;
  /** Container to exec into; undefined → the API picks the only/default one. */
  readonly container?: string;
  readonly permissions: PermissionBroker;
  readonly store: JsonSessionStore;
  readonly resume: SessionRecord | null;
  readonly log: (line: string) => void;
}

/**
 * Attach to an EXISTING pod (the `exec` command): inject the agent binary if
 * the pod does not already have it, open the daemon exec, and build the same
 * persisting local runtime as `startPodRuntime` — with one deliberate
 * difference: the pod is USER-OWNED, so this runtime neither creates nor
 * deletes it. `dispose` closes the exec channel (the pod-side daemon dies with
 * it); the pod stays `Running` for reuse (re-attach is a sub-second
 * version-probe) and for cleanup by the owner (`kubectl delete pod`).
 *
 * No `registerPodCleanup` safety net either: the whole point is that a TUI
 * exit (Ctrl+C → process.exit) must NOT delete the pod.
 */
export async function startExecRuntime(
  config: TentacleConfig,
  deps: PodExecRuntimeDeps,
): Promise<LocalRuntime> {
  const name = deps.podName;
  // Buffer the pod daemon's stderr so it never corrupts the Ink TUI; flushed
  // once on teardown / startup failure. See `createStderrSink`.
  const stderr = createStderrSink(`[pod ${name}]`, deps.log);
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

  phase(`[pod] attaching to ${name} in namespace ${deps.namespace}…`);
  let pod: Pod;
  try {
    pod = await deps.kube.getPod(name);
  } catch (error) {
    status?.finish();
    // A 404 from `getPod` can only mean the pod does not exist (wrong name or
    // wrong namespace — the kubeconfig context's namespace is not guaranteed
    // to be the pod's). 403 keeps its RBAC message; it is the operator's to fix.
    if (error instanceof KubeApiError && error.status === 404) {
      throw new Error(
        `pod "${name}" not found in namespace "${deps.namespace}" — check the name (kubectl get pods -n ${deps.namespace}) or pass --namespace <ns>; use \`run\` to create one`,
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
  // A terminated pod can never host the daemon (and `waitForReady` would just
  // time out) — say so up front.
  const podPhase = pod.status?.phase;
  if (podPhase !== undefined && TERMINAL_PHASES.has(podPhase)) {
    status?.finish();
    throw new Error(`pod "${name}" is ${podPhase}; cannot attach to a terminated pod`);
  }

  // The pod may still be pulling (the user ran it seconds ago): a BOUNDED wait
  // — `exec` is an attach, not a create, so we do not sit for the full
  // create-flow default.
  if (!podIsReady(pod)) {
    phase(`[pod] waiting for ${name} to become ready…`);
    try {
      pod = await deps.kube.waitForReady(name, { timeoutMs: 60_000 });
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
    let probe: RunExecResult;
    try {
      probe = await deps.kube.runExec(
        { pod: name, container, command: ["tentacle", "--version"] },
        undefined,
        { timeoutMs: 15_000 },
      );
    } catch (error) {
      status?.finish();
      // A wrong container surfaces here (the first exec) — translate it.
      throw containerExecError(error, name, container, deps.namespace);
    }
    let version: string;
    if (probe.exitCode === 0) {
      version = probe.stdout.trim() || "tentacle";
    } else {
      version = await injectAgentBinary({
        kube: deps.kube,
        podName: name,
        container,
        podArch: () => probePodArch(deps.kube, name, container),
        resolveBinary: (target) =>
          resolvePodBinary(target, {
            // Same single-line invariant as `run`: interactive mode folds the
            // resolver's verbose path into the "resolving … binary…" phase.
            log: status ? () => {} : deps.log,
          }),
        log: deps.log,
        onStatus: status ? (text) => status.set(text) : undefined,
      });
    }
    status?.finish();
    // Piped only: the TUI opening IS the confirmation in interactive mode.
    if (!status) {
      deps.log(
        `[pod] ${version} attached to ${name}; the agent daemon is starting (closing the TUI detaches — the pod stays up)\n`,
      );
    }
    const channel = deps.kube.openExec(
      {
        pod: name,
        container,
        command: ["tentacle", "serve", "--stdio", "--model-proxy"],
      },
      { onStderr: stderr.onStderr },
    );
    // The pod reaches the model through us (reverse-tunnel): serve the local
    // provider, so the endpoint and API key never leave the laptop.
    const modelProvider = new OpenAIProvider({
      baseURL: config.baseURL,
      model: config.model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
    return await createLocalRuntime({
      channel,
      // User-owned pod: closing the exec detaches the daemon but the pod keeps
      // running (keepalive) — no `deletePod`, by design.
      disposeTransport: () => {
        channel.close();
        // Safe after the TUI has unmounted (left the alt-screen).
        stderr.flush();
      },
      permissions: deps.permissions,
      store: deps.store,
      cwd: config.cwd,
      model: config.model,
      resume: deps.resume,
      modelProvider,
    });
  } catch (error) {
    status?.finish();
    // The TUI never mounted on this path, so flushing any daemon stderr is safe.
    stderr.flush();
    // NO pod delete here: the pod is not ours. The injection's own messages
    // (e.g. the glibc hint) surface untouched; a wrong container is translated.
    throw containerExecError(error, name, container, deps.namespace);
  }
}
