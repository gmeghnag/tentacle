/**
 * The backend-neutral seam the `run`/`attach` runtime and the binary injector
 * are written against (docker-runtime slice B, docs/feat/docker-engine-seam.md).
 * One implementation per engine — Kubernetes (`engine-k8s.ts`) and
 * Docker/Podman (`engine-docker.ts`) — and ONE runtime (`engine-runtime.ts`): a new
 * engine adds a host (lifecycle + a `DuplexChannel` transport), never a second
 * session path.
 *
 * The result/option types are structural copies of the two identical package
 * shapes (`@tentacle/k8s` and `@tentacle/docker`), so the runtime imports
 * neither engine's version.
 */
import type { ChannelError } from "@tentacle/client";
import type { DuplexChannel } from "@tentacle/transport";
import type { WorkspaceMount } from "./workspace-mount.ts";
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

/**
 * What a raw exec delivers, ending exactly once. `exitCode` is the engine's
 * real code (docker/podman) or its `Success`/`Failure` mapping (k8s: 0/1), so a
 * real exit code must come from the caller's own sentinel. `null` = the stream
 * died without one.
 */
export interface EngineRawExecEnd {
  readonly exitCode: number | null;
  readonly message?: string;
  readonly error?: Error;
}

/**
 * A long-lived **raw byte** exec — stdin raw, stdout/stderr as bytes, no line
 * framing. The one primitive `workload_shell` rides; it is a tool-private
 * resource, NOT a session transport (docs/feat/workload-shell.md D1, §4).
 * Structurally identical in both engines, so the tool is written once.
 */
export interface EngineRawExec {
  write(bytes: Uint8Array): void;
  setOnStdout(fn: (bytes: Uint8Array) => void): void;
  setOnStderr(fn: (bytes: Uint8Array) => void): void;
  setOnEnd(fn: (end: EngineRawExecEnd) => void): void;
  close(): void;
}

/** `EngineHost.create`'s options (docs/feat/docker-workspace-mount.md). */
export interface EngineCreateOptions {
  /** docker/podman: the laptop folder to mount (k8s: refused — never mounts). */
  readonly workspace?: WorkspaceMount;
  /** Extra workload labels (slice E: `ps`); the host's own labels win a clash. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Free-text metadata (slice E): k8s annotations; docker/podman add them as labels. */
  readonly annotations?: Readonly<Record<string, string>>;
}

/** `describe`: what the engine says about a workload — its state and metadata (untrusted text). */
export interface WorkloadFacts {
  /** `running` | `exited` | `pending` | the engine's own word (`created`, `paused`…). */
  readonly status: string;
  readonly labels: Readonly<Record<string, string>>;
  /** k8s only. */
  readonly annotations?: Readonly<Record<string, string>>;
}

/**
 * A refusal made BEFORE anything ran in the workload (a wrong name, a terminated
 * pod, a multi-container pod with no `--container`): the message is already short
 * and complete, so it is never cut to the ~120-char one-line limit
 * (`failedLine`) and no daemon log is created for it (docs/fix/k8s-multi-container.md).
 */
export class RefusalError extends Error {}

/**
 * `attach` found an OLDER tentacle build in the container with a live daemon
 * still using it (docs/fix/stale-pod-binary.md): never killed, so it is refused
 * with `<name> runs an older … · tentacle rm <name>, then run again`. Printed
 * as `[noun] <message>` — not a "failed:", no log path (`failedLine`).
 */
export class StaleBuildError extends RefusalError {}

/**
 * The workload does not exist (a 404). `noun` / `place` ("in <namespace>" |
 * "on docker") let `attach` say, for a name that is not in `tentacle ps`, that
 * nothing by that name exists either (`notListedLine`).
 */
export class WorkloadNotFoundError extends RefusalError {
  constructor(
    message: string,
    readonly noun: "pod" | "container",
    readonly place: string,
  ) {
    super(message);
  }
}

/**
 * A startup failure after which the host ALREADY removed the workload — or
 * tried to, and said so in the message (a workspace probe that failed or
 * could not run, e.g. a visible mask): the runtime must not keep it or report
 * it kept, with or without `--rm`.
 */
export class WorkloadRemovedError extends Error {
  override readonly name = "WorkloadRemovedError";
}

/**
 * How a `container` was resolved for a k8s workload (`pickExecContainer`):
 * `named` — the caller named it; `annotation` — the pod's
 * `kubectl.kubernetes.io/default-container`; `first` — kubectl-exec's fallback
 * to `spec.containers[0]`; `only` — the pod has exactly one container.
 */
export type ContainerHow = "named" | "annotation" | "first" | "only";

/** The `attach` preflight's view of an existing workload. */
export type WorkloadState =
  /**
   * `workspace`: the laptop folder a tentacle-made container mounts (its label).
   * `container`: k8s only — the container to exec into when the user named none
   * and the pod has several (its `default-container` annotation, as kubectl does).
   * `containers`: k8s only — every container of the pod, so a result can name the
   * ones it did NOT choose; `how`: which rule chose `container`.
   */
  | {
      readonly kind: "ready";
      readonly workspace?: string;
      readonly container?: string;
      /** k8s: the container the TUI runs in, for the badge (`kubernetes:<pod>/<container>`). */
      readonly inUse?: string;
      readonly containers?: readonly string[];
      readonly how?: ContainerHow;
    }
  /** Pulling / restarting: worth a bounded wait. */
  | {
      readonly kind: "starting";
      readonly detail: string;
      readonly workspace?: string;
      readonly container?: string;
      readonly inUse?: string;
      readonly containers?: readonly string[];
      readonly how?: ContainerHow;
    }
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
  create(name: string, image: string, options?: EngineCreateOptions): Promise<void>;
  /** Wait until the workload can host an exec (docker: start it first). */
  waitForReady(name: string, options?: { readonly timeoutMs?: number }): Promise<void>;
  /**
   * The `attach` preflight (a missing workload throws an actionable error).
   * `container`: the `--container` the user passed, if any — k8s refuses a
   * multi-container pod when none was named (`RefusalError`, before any exec).
   * `pick`: which container-selection rule to use for a k8s pod. Unset =
   * `attach`'s (annotation, else refuse); `"kubectl-exec"` = what
   * `kubectl exec`/`oc rsh` do — annotation, else the first container
   * (docs/fix/workload-shell-live.md D2).
   */
  inspect(
    name: string,
    options?: { readonly container?: string; readonly pick?: "kubectl-exec" },
  ): Promise<WorkloadState>;
  /**
   * `ps` / `rm` (slice E): the workload's state and labels — `null` when the
   * engine says it does not exist (404); any other failure throws.
   */
  describe(name: string): Promise<WorkloadFacts | null>;
  /** The reconnect preflight: `null` → dial it; else why not (gone / unauthorized / transient). */
  dialVerdict(name: string): Promise<ChannelError | null>;
  remove(name: string): Promise<void>;
  /** The exit net: best-effort, non-blocking delete that survives `process.exit`. Never throws. */
  removeBestEffort(name: string): void;
  openExec(target: EngineExecTarget, options?: EngineExecChannelOptions): DuplexChannel;
  /**
   * Open a long-lived RAW BYTE exec (no JSON-line framing): what a stateful,
   * non-interactive shell needs. Additive next to `openExec`/`runExec`.
   */
  openRawExec(target: EngineExecTarget): EngineRawExec;
  runExec(
    target: EngineExecTarget,
    input?: Uint8Array,
    options?: EngineRunExecOptions,
  ): Promise<EngineRunExecResult>;
  /** Translate an exec failure (a wrong container, a stopped one) into an actionable error. */
  execError(error: unknown, target: { readonly name: string; readonly container?: string }): Error;
  /**
   * Ask the engine WHY it refused an exec, out of band (docs/fix/workload-shell-live.md
   * D3): Bun's WebSocket drops a refused upgrade's status and body, so k8s
   * re-asks the same URL over plain HTTP. `undefined` when it has no reason.
   * Optional: an engine whose failures are already readable does not implement it.
   */
  execRefusal?(target: { readonly name: string; readonly container?: string }): Promise<
    string | undefined
  >;
  /**
   * The engine's own CPU arch (docker/podman `GET /info` → `Architecture`):
   * what `probePod` falls back to when the in-workload probe gave no answer,
   * instead of guessing x64 (docs/fix/session-hop-live.md D3). `null` when the
   * engine cannot tell; may reject (the caller treats it as `null`).
   */
  engineArch?(): Promise<"x64" | "arm64" | null>;
}
