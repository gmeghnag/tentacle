import type { WorkloadRawExec, WorkloadShellBackend, WorkloadTarget } from "@tentacle/tools";
/**
 * The `workload_shell` backend over the laptop's own engine layer
 * (docs/feat/workload-shell.md D3): `buildEngineHost` resolves the kubeconfig
 * context or the docker/podman endpoint, and `openRawExec`/`runExec` are the raw
 * primitives the tool rides.
 *
 * **Registered only where the daemon runs on the user's own host** (the worker
 * and `serve`): a pod daemon's plain `shell` already IS in its workload, and
 * reaching OTHER workloads from a pod would need cluster credentials inside the
 * pod, which AGENTS §7 forbids.
 *
 * **The engine is PINNED per session.** `buildEngineHost` runs once per
 * `(engine, namespace)` on first use and is cached for the session's life, so a
 * `kubectl config use-context` mid-session cannot move an open shell to another
 * cluster — which is what keeps `targetKey` (and therefore an "always") from
 * aliasing two clusters.
 */
import { type EngineHost, type EngineKind, RefusalError } from "./engine-host.ts";

/**
 * The engine layer is loaded ON DEMAND (a dynamic import), never at module load.
 *
 * `engine-select.ts` reaches `@tentacle/docker`'s and `@tentacle/k8s`'s cleanup
 * modules, which exist to arm the "delete the workload" exit net (`Bun.spawn` +
 * `process` exit handlers). A `worker.ts` that statically imported this file
 * therefore pulled that whole graph into the WORKER's bundle, and the worker's
 * RPC peer stopped answering at all: no error, no message, just silence — the
 * worst kind of failure, because it looks like a hang.
 *
 * A `workload_shell` backend is only needed when the tool is actually used, so
 * deferring the load costs one `await` on the first `run` and keeps the worker's
 * module graph exactly as it was.
 */
type EngineSelect = typeof import("./engine-select.ts");
let engineSelect: Promise<EngineSelect> | undefined;
function loadEngineSelect(): Promise<EngineSelect> {
  engineSelect ??= import("./engine-select.ts");
  return engineSelect;
}

/** A pinned host: the engine the session resolved, and where it points. */
interface Pinned {
  readonly host: EngineHost;
  /** `kind:namespace` | `kind` — the cache key. */
  readonly id: string;
  /** Human text for the first result (`context "kind-dev", namespace default`). */
  readonly where: string;
}

export interface WorkloadShellBackendOptions {
  /** The engine layer's surroundings (tests). */
  readonly io?: import("./engine-select.ts").EngineHostIO;
  /** The kube context a NEW session resolves (undefined → the current one). */
  readonly kubeContext?: string;
  /** Log/notice sink for a failed cleanup — never the terminal (AGENTS §7). */
  readonly log?: (line: string) => void;
}

/**
 * One session's backend. Hosts are resolved lazily and cached, so the first
 * `run` on a workload pins the cluster it talks to.
 */
export class LaptopWorkloadShellBackend implements WorkloadShellBackend {
  private readonly pinned = new Map<string, Pinned>();
  private io: import("./engine-select.ts").EngineHostIO | undefined;

  constructor(private readonly options: WorkloadShellBackendOptions = {}) {}

  /**
   * Resolve `target`'s engine NOW (the async half), so `open`/`oneShot` can be
   * synchronous — the registry writes its bootstrap line the moment it opens.
   * Idempotent: the second call for a pinned target is a map lookup.
   */
  async prime(target: WorkloadTarget): Promise<void> {
    await this.hostFor(target);
  }

  /** The pinned host for `target`, resolving it on first use (per session). */
  private async hostFor(target: WorkloadTarget): Promise<Pinned> {
    const id = this.idOf(target);
    const existing = this.pinned.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const select = await loadEngineSelect();
    this.io ??= this.options.io ?? select.defaultEngineHostIO();
    const kind: EngineKind = target.engine;
    let built: ReturnType<typeof select.buildEngineHost>;
    try {
      built = select.buildEngineHost(
        kind,
        {
          ...(target.namespace !== undefined ? { namespace: target.namespace } : {}),
          ...(this.options.kubeContext !== undefined
            ? { kubeContext: this.options.kubeContext }
            : {}),
        },
        this.io,
      );
    } catch (error) {
      throw asError(error);
    }
    const pinned: Pinned = {
      host: built.host,
      id,
      where: whereOf(built),
    };
    this.pinned.set(id, pinned);
    return pinned;
  }

  private idOf(target: WorkloadTarget): string {
    return target.engine === "kubernetes"
      ? `${target.engine}:${target.namespace ?? ""}`
      : target.engine;
  }

  /** The context/namespace/endpoint a target resolved to, for the first result. */
  async where(target: WorkloadTarget): Promise<string> {
    return (await this.hostFor(target)).where;
  }

  /** The already-primed host (a `prime` must have run for this target). */
  private primed(target: WorkloadTarget): Pinned {
    const pinned = this.pinned.get(this.idOf(target));
    if (pinned === undefined) {
      throw new Error(
        `the engine for ${target.engine} ${target.name} was not resolved before the shell was opened`,
      );
    }
    return pinned;
  }

  open(target: WorkloadTarget): WorkloadRawExec {
    const pinned = this.primed(target);
    return pinned.host.openRawExec({
      name: target.name,
      ...(target.container !== undefined ? { container: target.container } : {}),
      command: ["sh"],
    });
  }

  oneShot(
    target: WorkloadTarget,
    script: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const pinned = this.primed(target);
    return pinned.host
      .runExec(
        {
          name: target.name,
          ...(target.container !== undefined ? { container: target.container } : {}),
          command: ["sh", "-c", script],
        },
        undefined,
        { timeoutMs },
      )
      .then((result) => ({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }));
  }

  /**
   * Turn a failure into the sentence the model can act on (D5): a missing pod,
   * a refused RBAC verb, a missing `/bin/sh`, a stopped container.
   */
  async explain(error: unknown, target: WorkloadTarget): Promise<Error> {
    const original = asError(error);
    let pinned: Pinned;
    try {
      pinned = await this.hostFor(target);
    } catch (setup) {
      return asError(setup); // the engine itself could not be reached
    }
    // `dialVerdict` asks the engine whether the workload is gone / unauthorized /
    // transient — an actionable answer beats guessing from the error text.
    const verdict = await pinned.host.dialVerdict(target.name).catch(() => null);
    if (verdict !== null) {
      return new Error(`${target.name}: ${verdict.message}`);
    }
    const translated = pinned.host.execError(original, {
      name: target.name,
      ...(target.container !== undefined ? { container: target.container } : {}),
    });
    if (translated instanceof RefusalError) {
      return translated;
    }
    if (
      /no such file or directory|executable file not found|stat \/bin\/sh/i.test(original.message)
    ) {
      return new Error(
        `no /bin/sh in ${target.name} (distroless image?). workload_shell needs a POSIX sh; run the binary directly with a one-shot \`kubectl exec … -- <cmd>\` via shell, or use an ephemeral debug container`,
      );
    }
    return translated;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function whereOf(built: Awaited<ReturnType<EngineSelect["buildEngineHost"]>>): string {
  const parts: string[] = [];
  const context = built.kubeContext;
  if (context !== undefined) {
    parts.push(`context "${context}"`);
  }
  if (built.host.where !== "") {
    parts.push(built.host.where);
  }
  return parts.join(", ");
}
