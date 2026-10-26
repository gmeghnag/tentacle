/**
 * The backend-neutral seam the `run`/`attach` runtime and the binary injector
 * are written against (docker-runtime slice B, docs/feat/docker-engine-seam.md).
 * One implementation per engine — Kubernetes (`engine-k8s.ts`) and
 * Docker/Podman (`engine-docker.ts`) — and ONE runtime (`pod-runtime.ts`): a new
 * engine adds a host (lifecycle + a `DuplexChannel` transport), never a second
 * session path.
 *
 * The result/option types are structural copies of the two identical package
 * shapes (`@tentacle/k8s` and `@tentacle/docker`), so the runtime imports
 * neither engine's version.
 */
import type { ChannelError } from "@tentacle/client";
import type { DuplexChannel } from "@tentacle/transport";

export type EngineKind = "kubernetes" | "docker" | "podman";

/** What to exec: the workload's `name` (pod / container) and, on k8s, a container in it. */
export interface EngineExecTarget {
  readonly name: string;
  /** k8s only: a container of the pod (undefined → the API picks the only/default one). */
  readonly container?: string;
  /** The command to run — one array element per argv token. */
  readonly command: readonly string[];
}

export interface EngineRunExecResult {
  /** The command's exit code (k8s reports only 0/1; consumers test `!== 0`). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The engine's raw terminal status, when it has one (k8s `Status` JSON). */
  readonly status?: string;
}

export interface EngineRunExecOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Running count of stdin bytes written. */
  readonly onProgress?: (bytesWritten: number) => void;
}

export interface EngineExecChannelOptions {
  /** The daemon's stderr (buffered by the caller, never written live). */
  readonly onStderr?: (text: string) => void;
}

/** The `attach` preflight's view of an existing workload. */
export type WorkloadState =
  | { readonly kind: "ready" }
  /** Pulling / restarting: worth a bounded wait. */
  | { readonly kind: "starting"; readonly detail: string }
  /** Terminal / not runnable: refuse with `detail` (attach never starts it). */
  | { readonly kind: "stopped"; readonly detail: string };

export interface EngineHost {
  readonly kind: EngineKind;
  /** Log/UI vocabulary (`[pod] …` / `[container] …`). */
  readonly noun: "pod" | "container";
  /** Where workloads live, for messages: `namespace dev` | `context "desktop-linux"`. */
  readonly where: string;
  /** The container `run` targets inside its workload (k8s: the agent container; docker: none). */
  readonly defaultContainer?: string;
  /** Create the workload (errors already translated into actionable ones). */
  create(name: string, image: string): Promise<void>;
  /** Wait until the workload can host an exec (docker: start it first). */
  waitForReady(name: string, options?: { readonly timeoutMs?: number }): Promise<void>;
  /** The `attach` preflight (a missing workload throws an actionable error). */
  inspect(name: string): Promise<WorkloadState>;
  /** The reconnect preflight: `null` → dial it; else why not (gone / unauthorized / transient). */
  dialVerdict(name: string): Promise<ChannelError | null>;
  remove(name: string): Promise<void>;
  /** The exit net: best-effort, non-blocking delete that survives `process.exit`. Never throws. */
  removeBestEffort(name: string): void;
  openExec(target: EngineExecTarget, options?: EngineExecChannelOptions): DuplexChannel;
  runExec(
    target: EngineExecTarget,
    input?: Uint8Array,
    options?: EngineRunExecOptions,
  ): Promise<EngineRunExecResult>;
  /** Translate an exec failure (a wrong container, a stopped one) into an actionable error. */
  execError(error: unknown, target: { readonly name: string; readonly container?: string }): Error;
}
