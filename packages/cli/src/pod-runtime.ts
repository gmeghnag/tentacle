/**
 * The pod-execution runtime (F4.c, the `run` command): run the agent daemon
 * inside a Kubernetes pod, driven from the local TUI, reusing the SAME
 * `RemoteClient` ↔ `Connection` stack as the worker and remote-control paths.
 * The only new parts are the transport (the exec WebSocket, F4.b) and the pod
 * lifecycle here:
 *
 *   createPod → waitForReady → injectAgentBinary (F4.e: probe arch, stream the
 *   binary, verify with --version) → openExec(`agent-harness serve --stdio`) →
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
import type { SessionRecord } from "@agent-harness/agent";
import type { JsonSessionStore } from "@agent-harness/agent";
import type { HarnessConfig } from "@agent-harness/config";
import type { PermissionBroker } from "@agent-harness/core";
import {
  AGENT_CONTAINER,
  type ExecChannelOptions,
  type ExecTarget,
  KubeApiError,
  type Pod,
  type RunExecOptions,
  type RunExecResult,
  type WaitForReadyOptions,
  buildPodManifest,
} from "@agent-harness/k8s";
import { OpenAIProvider } from "@agent-harness/providers";
import type { DuplexChannel } from "@agent-harness/transport";
import { type LocalRuntime, createLocalRuntime } from "./local-runtime.ts";
import { resolvePodBinary } from "./pod-binary-build.ts";
import { injectAgentBinary, probePodArch } from "./pod-binary.ts";
import { StatusLine } from "./status-line.ts";

/** The subset of `KubeClient` the pod runtime needs (injectable for tests). */
export interface PodCluster {
  createPod(pod: Pod, signal?: AbortSignal): Promise<Pod>;
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
  config: HarnessConfig,
  deps: PodRuntimeDeps,
): Promise<LocalRuntime> {
  const name = deps.name ?? `agent-harness-${crypto.randomUUID().slice(0, 8)}`;
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
    // `agent-harness`. Any failure here throws → the pod is deleted below.
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
        command: ["agent-harness", "serve", "--stdio", "--model-proxy"],
      },
      { onStderr: (text) => deps.log(`[pod ${name}] ${text}`) },
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
    void deps.kube.deletePod(name).catch(() => {});
    throw error;
  }
}
