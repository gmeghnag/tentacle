/**
 * The pod-execution runtime (F4.c): run the agent daemon inside a Kubernetes
 * pod, driven from the local TUI, reusing the SAME `RemoteClient` ↔ `Connection`
 * stack as the worker and remote-control paths. The only new parts are the
 * transport (the exec WebSocket, F4.b) and the pod lifecycle here:
 *
 *   createPod → waitForReady → injectAgentBinary (F4.e: probe arch, stream the
 *   binary, verify with --version) → openExec(`agent-harness serve --stdio`) →
 *   createLocalRuntime(handshake + persisting sessions) → …use… → deletePod.
 *
 * The injection (F4.e) means the image no longer needs to contain the tool —
 * any Linux image with `sh` + `head` works; see `pod-binary.ts`.
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

/** The subset of `KubeClient` the pod runtime needs (injectable for tests). */
export interface PodCluster {
  createPod(pod: Pod, signal?: AbortSignal): Promise<Pod>;
  waitForReady(name: string, options?: WaitForReadyOptions): Promise<Pod>;
  deletePod(name: string, signal?: AbortSignal): Promise<void>;
  openExec(target: ExecTarget, options?: ExecChannelOptions): DuplexChannel;
  runExec(target: ExecTarget, input?: Uint8Array, options?: RunExecOptions): Promise<RunExecResult>;
}

export interface PodRuntimeDeps {
  readonly kube: PodCluster;
  readonly namespace: string;
  readonly image: string;
  readonly permissions: PermissionBroker;
  readonly store: JsonSessionStore;
  readonly resume: SessionRecord | null;
  readonly log: (line: string) => void;
}

/**
 * Create an ephemeral pod, connect the daemon over its exec channel, and build a
 * persisting local runtime against it. The returned runtime's `dispose` closes
 * the exec channel and deletes the pod. Throws (after cleaning up any created
 * pod) on failure — unlike `--worker`, there is no in-process fallback.
 */
export async function startPodRuntime(
  config: HarnessConfig,
  deps: PodRuntimeDeps,
): Promise<LocalRuntime> {
  const name = `agent-harness-${crypto.randomUUID().slice(0, 8)}`;
  deps.log(`[pod] creating ${name} (image ${deps.image}) in namespace ${deps.namespace}…\n`);
  await deps.kube.createPod(
    buildPodManifest({ name, namespace: deps.namespace, image: deps.image }),
  );

  try {
    await deps.kube.waitForReady(name);
    // Inject the tool into the sandbox (F4.e): the image need not contain
    // `agent-harness`. Any failure here throws → the pod is deleted below.
    await injectAgentBinary({
      kube: deps.kube,
      podName: name,
      container: AGENT_CONTAINER,
      podArch: () => probePodArch(deps.kube, name, AGENT_CONTAINER),
      resolveBinary: (target) => resolvePodBinary(target, { log: deps.log }),
      log: deps.log,
    });
    deps.log(`[pod] ${name} ready; starting the agent daemon over exec\n`);
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
    void deps.kube.deletePod(name).catch(() => {});
    throw error;
  }
}
