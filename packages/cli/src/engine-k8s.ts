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
  type RawExec,
  type RunExecOptions,
  type RunExecResult,
  TERMINAL_PHASES,
  type WaitForReadyOptions,
  buildPodManifest,
  podContainerNames,
  podIsReady,
} from "@tentacle/k8s";
import type { DuplexChannel } from "@tentacle/transport";
import {
  type ContainerHow,
  type EngineExecTarget,
  type EngineHost,
  RefusalError,
  WorkloadNotFoundError,
} from "./engine-host.ts";

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
  /** A long-lived raw-byte exec (docs/feat/workload-shell.md D1). */
  openRawExec(target: ExecTarget): RawExec;
  /**
   * Optional: why the apiserver refused an exec upgrade, asked over plain HTTP
   * (docs/fix/workload-shell-live.md D3). Absent on a fake/cluster that cannot
   * answer — the caller then prints its honest fallback.
   */
  execRefusal?(target: ExecTarget): Promise<string | undefined>;
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
    return new RefusalError(
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

/** The annotation `kubectl exec` / `logs` read to pick a container of a multi-container pod. */
const DEFAULT_CONTAINER_ANNOTATION = "kubectl.kubernetes.io/default-container";

/**
 * WHICH container an exec goes to, decided laptop-side from one pod read — one
 * pure rule, used by `inspect` for both callers
 * (docs/fix/workload-shell-live.md D2). Returns the container and which clause
 * chose it, or a `RefusalError` (nothing is exec'd into).
 *
 * `mode` is the whole point of the split:
 * - **`attach`** (the default): the annotation, else a refusal naming the pod's
 *   containers. `attach` INSTALLS the daemon in that container, so a silent
 *   guess there costs more than a refusal.
 * - **`kubectl-exec`**: kubectl's own rule — the annotation (when it names a
 *   real container), else `spec.containers[0]`. This is what makes
 *   `workload_shell` work on a multi-container pod where the bare exec used to
 *   be refused by the apiserver with a message the model never saw.
 *
 * An explicitly named container always wins; in `kubectl-exec` mode a name the
 * pod does not have is refused here, with the list, rather than being left to
 * fail as an unexplained refused upgrade.
 */
export function pickExecContainer(
  names: readonly string[],
  annotation: string | undefined,
  requested: string | undefined,
  mode: "attach" | "kubectl-exec",
  podName: string,
): { readonly container: string; readonly how: ContainerHow } | RefusalError | undefined {
  if (requested !== undefined) {
    if (mode === "kubectl-exec" && !names.includes(requested)) {
      return new RefusalError(
        `container "${requested}" is not valid for pod ${podName}, choose one of: [${names.join(" ")}] · set target.container`,
      );
    }
    return { container: requested, how: "named" };
  }
  if (names.length === 0) {
    // A pod with no listed containers (a fake or a mid-creation pod): nothing to
    // pick, and nothing to refuse either — the exec behaves exactly as it did
    // before this rule existed, and D3 explains whatever the apiserver says.
    return undefined;
  }
  if (annotation !== undefined && names.includes(annotation)) {
    return { container: annotation, how: "annotation" };
  }
  if (names.length === 1) {
    const only = names[0];
    if (only !== undefined) {
      return { container: only, how: "only" };
    }
  }
  if (mode === "kubectl-exec") {
    const first = names[0];
    if (first !== undefined) {
      return { container: first, how: "first" };
    }
  }
  return new RefusalError(
    `a container name must be specified for pod ${podName}, choose one of: [${names.join(" ")}] · pass --container <c>`,
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
    async inspect(name, options) {
      let pod: Pod;
      try {
        pod = await kube.getPod(name);
      } catch (error) {
        // A 404 from `getPod` can only mean the pod does not exist (wrong name or
        // wrong namespace — the kubeconfig context's namespace is not guaranteed
        // to be the pod's). 403 keeps its RBAC message; it is the operator's to fix.
        if (error instanceof KubeApiError && error.status === 404) {
          throw new WorkloadNotFoundError(
            `pod "${name}" not found in namespace "${namespace}" — check the name (kubectl get pods -n ${namespace}) or pass --namespace <ns>; use \`run\` to create one`,
            "pod",
            `in ${namespace}`,
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
      // kubectl's rule, decided HERE from the pod read — not guessed after an
      // exec dies. With several containers, kubectl first honours the pod's
      // `default-container` annotation (silently) when it names a container of
      // `spec.containers`; `attach` then refuses (it installs the daemon
      // there), while `pick: "kubectl-exec"` falls back to the FIRST container
      // as `kubectl exec` does (docs/fix/workload-shell-live.md D2).
      const names = podContainerNames(pod);
      const requested = options?.container;
      const pick = options?.pick === "kubectl-exec" ? "kubectl-exec" : "attach";
      const chosen = pickExecContainer(
        names,
        pod.metadata?.annotations?.[DEFAULT_CONTAINER_ANNOTATION],
        requested,
        pick,
        name,
      );
      if (chosen instanceof RefusalError) {
        throw chosen;
      }
      // Told to the caller for the badge (`kubernetes:<pod>/<container>`, always)
      // and for the open line of `workload_shell` (which container, why, and
      // which others exist). Resolved laptop-side from the pod read; the exec
      // target carries `container` only when a rule actually chose one.
      //
      // `containers`/`how` are reported ONLY to `pick: "kubectl-exec"`: the
      // `attach` preflight's state stays byte-identical to before this change
      // (docs/fix/workload-shell-live.md Preconditions), and only
      // `workload_shell`'s open line needs them.
      const extra =
        chosen === undefined
          ? {}
          : pick === "kubectl-exec"
            ? {
                ...(names.length > 0 ? { containers: names } : {}),
                how: chosen.how,
                ...(chosen.how === "named" ? {} : { container: chosen.container }),
              }
            : // `attach`, unchanged: `container` only when the ANNOTATION chose it
              // (an explicit `--container` or the pod's only one already shows in
              // `inUse`, and the exec target is built by the caller).
              chosen.how === "annotation"
              ? { container: chosen.container }
              : {};
      const inUse = chosen?.container;
      const badge = inUse === undefined ? {} : { inUse };
      return podIsReady(pod)
        ? { kind: "ready", ...badge, ...extra }
        : {
            kind: "starting",
            detail: `pod "${name}" is ${phase ?? "pending"}`,
            ...badge,
            ...extra,
          };
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
    openRawExec(target) {
      return kube.openRawExec(podTarget(target));
    },
    runExec(target, input, options) {
      return kube.runExec(podTarget(target), input, options);
    },
    execError(error, target) {
      return containerExecError(error, target.name, target.container, namespace);
    },
    async execRefusal(target) {
      if (kube.execRefusal === undefined) {
        return undefined;
      }
      try {
        return await kube.execRefusal({
          pod: target.name,
          ...(target.container !== undefined ? { container: target.container } : {}),
          command: ["sh"],
        });
      } catch {
        return undefined; // never throws to the caller: a reason is a bonus
      }
    },
  };
}
