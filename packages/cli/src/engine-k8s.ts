/**
 * The Kubernetes `EngineHost` (docs/feat/docker-engine-seam.md §3): a pod is
 * the workload, `AGENT_CONTAINER` the container `run` targets. A thin adapter
 * over `PodCluster` (the injectable subset of `KubeClient`); the k8s error
 * translations live here, verbatim from the pre-seam runtime.
 */
import { ChannelError } from "@tentacle/client";
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
import type { DuplexChannel } from "@tentacle/transport";
import type { EngineExecTarget, EngineHost } from "./engine-host.ts";

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
 * Can this pod (still) host the daemon? The reconnect preflight's verdict
 * (pure): a deleted or terminated pod is `gone` and bad cluster credentials
 * are `unauthorized` — both stop the reconnect for good; anything else (the
 * apiserver unreachable, a 5xx, a pod not yet running) is transient. `null`:
 * a running pod, dial it.
 */
export function podDialError(
  name: string,
  outcome: { readonly pod: Pod } | { readonly error: unknown },
): ChannelError | null {
  if ("pod" in outcome) {
    const phase = outcome.pod.status?.phase;
    if (phase !== undefined && TERMINAL_PHASES.has(phase)) {
      return new ChannelError("gone", `pod "${name}" is ${phase}`);
    }
    if (phase !== undefined && phase !== "Running") {
      return new ChannelError("unreachable", `pod "${name}" is ${phase}`);
    }
    return null;
  }
  const { error } = outcome;
  if (error instanceof KubeApiError && error.status === 404) {
    return new ChannelError("gone", `pod "${name}" no longer exists`);
  }
  if (error instanceof KubeApiError && (error.status === 401 || error.status === 403)) {
    return new ChannelError(
      "unauthorized",
      `the cluster refused the credentials (${error.status})`,
    );
  }
  return new ChannelError(
    "unreachable",
    `cannot reach the cluster: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const podTarget = (t: EngineExecTarget): ExecTarget => ({
  pod: t.name,
  container: t.container,
  command: t.command,
});

/** The k8s `EngineHost`: pods in `namespace`, over `kube` (a `KubeClient` in production). */
export function kubeEngineHost(kube: PodCluster, namespace: string): EngineHost {
  return {
    kind: "kubernetes",
    noun: "pod",
    where: `namespace ${namespace}`,
    defaultContainer: AGENT_CONTAINER,
    async create(name, image, options) {
      // Backstop: a pod has no access to laptop files; the planner never asks.
      if (options?.workspace) {
        throw new Error("a Kubernetes pod cannot mount a laptop folder");
      }
      const labels = options?.labels;
      const annotations = options?.annotations;
      try {
        await kube.createPod(
          buildPodManifest({
            name,
            namespace,
            image,
            ...(labels ? { labels: { ...labels } } : {}),
            ...(annotations ? { annotations: { ...annotations } } : {}),
          }),
        );
      } catch (error) {
        // A missing namespace surfaces as a 404 from the pod create (not a
        // separate preflight) — translate it into something actionable.
        throw podCreateError(error, namespace);
      }
    },
    async waitForReady(name, options) {
      await kube.waitForReady(name, options);
    },
    async inspect(name) {
      let pod: Pod;
      try {
        pod = await kube.getPod(name);
      } catch (error) {
        // A 404 from `getPod` can only mean the pod does not exist (wrong name or
        // wrong namespace — the kubeconfig context's namespace is not guaranteed
        // to be the pod's). 403 keeps its RBAC message; it is the operator's to fix.
        if (error instanceof KubeApiError && error.status === 404) {
          throw new Error(
            `pod "${name}" not found in namespace "${namespace}" — check the name (kubectl get pods -n ${namespace}) or pass --namespace <ns>; use \`run\` to create one`,
          );
        }
        throw error instanceof Error ? error : new Error(String(error));
      }
      // A terminated pod can never host the daemon (and `waitForReady` would just
      // time out) — say so up front.
      const phase = pod.status?.phase;
      if (phase !== undefined && TERMINAL_PHASES.has(phase)) {
        return {
          kind: "stopped",
          detail: `pod "${name}" is ${phase}; cannot attach to a terminated pod`,
        };
      }
      return podIsReady(pod)
        ? { kind: "ready" }
        : { kind: "starting", detail: `pod "${name}" is ${phase ?? "pending"}` };
    },
    async describe(name) {
      let pod: Pod;
      try {
        pod = await kube.getPod(name);
      } catch (error) {
        if (error instanceof KubeApiError && error.status === 404) {
          return null;
        }
        throw error instanceof Error ? error : new Error(String(error));
      }
      const phase = pod.status?.phase;
      const status =
        phase === undefined
          ? "unknown"
          : TERMINAL_PHASES.has(phase)
            ? "exited"
            : phase.toLowerCase();
      const annotations = pod.metadata?.annotations;
      return {
        status,
        labels: { ...pod.metadata?.labels },
        ...(annotations ? { annotations: { ...annotations } } : {}),
      };
    },
    async dialVerdict(name) {
      try {
        return podDialError(name, { pod: await kube.getPod(name) });
      } catch (error) {
        return podDialError(name, { error });
      }
    },
    remove(name) {
      return kube.deletePod(name);
    },
    removeBestEffort(name) {
      kube.deletePodBestEffort(name);
    },
    openExec(target, options) {
      return kube.openExec(podTarget(target), options);
    },
    runExec(target, input, options) {
      return kube.runExec(podTarget(target), input, options);
    },
    execError(error, target) {
      return containerExecError(error, target.name, target.container, namespace);
    },
  };
}
