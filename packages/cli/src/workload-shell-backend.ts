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
import type {
  PrimedTarget,
  WorkloadRawExec,
  WorkloadShellBackend,
  WorkloadTarget,
} from "@tentacle/tools";
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
  /**
   * The container `prime` resolved for a target key — kept so `explain` can ask
   * the apiserver about the SAME container the exec was refused on
   * (docs/fix/workload-shell-live.md D1/D3).
   *
   * **Not a resolve cache.** It is consulted only for `explain`'s re-ask, never
   * to skip the `GET pod`: the plan's failure modes depend on `prime`
   * re-resolving on every reopen ("pod replaced → next run: shell ended →
   * reopen → `prime` resolves again", "pod terminated → `stopped` →
   * `RefusalError`"). A cached answer would keep a stale container for the rest
   * of the session and skip the `stopped` refusal entirely (review round 1,
   * MEDIUM 2).
   */
  private readonly resolvedContainers = new Map<string, string>();

  constructor(private readonly options: WorkloadShellBackendOptions = {}) {}

  /**
   * Resolve `target`'s engine NOW (the async half), so `open`/`oneShot` can be
   * synchronous — the registry writes its bootstrap line the moment it opens.
   * Idempotent for the engine (a map lookup); the pod read (k8s only) runs once
   * per target key, and its container is what `open` then names.
   *
   * On `stopped` it throws a `RefusalError`: `prime` runs BEFORE anything is
   * opened, so nothing is registered and nothing has to be cleaned up.
   */
  async prime(target: WorkloadTarget): Promise<PrimedTarget | undefined> {
    const pinned = await this.hostFor(target);
    if (target.engine !== "kubernetes") {
      return undefined; // a container IS the workload: nothing to pick
    }
    // ALWAYS re-read the pod: the container set and the annotation can change
    // between one shell's death and the next run's reopen, and a pod that is now
    // `stopped` must be refused rather than skipped (review round 1, MEDIUM 2).
    const state = await pinned.host.inspect(target.name, {
      ...(target.container !== undefined ? { container: target.container } : {}),
      pick: "kubectl-exec",
    });
    if (state.kind === "stopped") {
      this.resolvedContainers.delete(cacheKey(target));
      throw new RefusalError(state.detail);
    }
    const container = state.container;
    if (container === undefined) {
      this.resolvedContainers.delete(cacheKey(target));
      return undefined; // a named container, or a pod read with nothing to list
    }
    // Kept for `explain`'s re-ask only (never to skip the read above).
    this.resolvedContainers.set(cacheKey(target), container);
    const note = noteFor(state);
    return { container, ...(note !== undefined ? { note } : {}) };
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
   * a refused RBAC verb, a missing `/bin/sh`, a stopped container — and, since
   * docs/fix/workload-shell-live.md D3, the apiserver's OWN reason for refusing
   * an exec upgrade, which never reaches us through Bun's WebSocket.
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
    // transient — an actionable answer beats guessing from the error text. It
    // runs FIRST: a deleted pod still has to say "gone" before anything else.
    const verdict = await pinned.host.dialVerdict(target.name).catch(() => null);
    if (verdict !== null) {
      return new Error(`${target.name}: ${verdict.message}`);
    }
    // A refused UPGRADE (the apiserver said no, before any stream existed): ask
    // it, over plain HTTP, on the same exec URL — Bun dropped the status and the
    // body, so this is the only way to get the real reason out. The error class
    // comes from the LAZILY loaded engine layer: a static `@tentacle/k8s` import
    // here would put the cleanup graph back into the worker's bundle.
    if (
      causeOf(original) instanceof (await loadEngineSelect()).ExecRefusedError &&
      pinned.host.execRefusal !== undefined
    ) {
      const container = target.container ?? this.resolvedContainers.get(cacheKey(target));
      const reason = await pinned.host
        .execRefusal({
          name: target.name,
          ...(container !== undefined ? { container } : {}),
        })
        .catch(() => undefined);
      const where = container === undefined ? target.name : `${target.name}[${container}]`;
      return new Error(
        reason === undefined
          ? `cannot exec into ${where}: the API server refused the WebSocket upgrade and gave no reason over HTTP (the client cannot read the refusal body) — check \`kubectl auth can-i create pods/exec -n ${target.namespace ?? "default"}\` and that the pod is running`
          : `cannot exec into ${where}: ${reason}`,
      );
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

/**
 * The original error behind a wrapped one, across the two levels the registry
 * adds (`new Error("could not start a shell in …: …", { cause })`). `explain`
 * keys on the TYPE of the innermost cause, because the message alone cannot say
 * whether the upgrade was refused or the stream dropped.
 */
function causeOf(error: Error): Error {
  let current: Error = error;
  for (let depth = 0; depth < 4; depth++) {
    const next = (current as { cause?: unknown }).cause;
    if (!(next instanceof Error)) {
      return current;
    }
    current = next;
  }
  return current;
}

/** One cache key per target as the model wrote it (`targetKey`, spelled locally). */
function cacheKey(target: WorkloadTarget): string {
  return [target.engine, target.namespace ?? "", target.name, target.container ?? ""].join("|");
}

/**
 * The open line's explanation for a container the tool had to RESOLVE itself
 * (docs/fix/workload-shell-live.md D1): why this one, and which others exist, so
 * the model can switch with `target.container` instead of guessing.
 */
function noteFor(state: {
  readonly container?: string;
  readonly how?: "named" | "annotation" | "first" | "only";
  readonly containers?: readonly string[];
}): string | undefined {
  const containers = state.containers ?? [];
  const others = containers.filter((name) => name !== state.container);
  const rest =
    others.length === 0 ? "" : `; others: ${others.join(", ")}; set target.container to choose`;
  if (state.how === "annotation") {
    return `container ${state.container} — the pod's default-container annotation${rest}`;
  }
  if (state.how === "first") {
    return `container ${state.container} — first of ${containers.length}, no default-container annotation${rest}`;
  }
  return undefined; // named, or the pod's only container: nothing was inferred
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
