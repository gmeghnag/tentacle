/**
 * A tiny, self-contained Kubernetes client for the pod-execution runtime (F4).
 *
 * It speaks the REST API directly — no `kubectl`/`oc` — against a resolved
 * `{ server, namespace, token }`. This slice (F4.a) covers the Pod lifecycle
 * verbs the runtime needs: create, get, delete, and a readiness wait. The exec
 * WebSocket (`v4.channel.k8s.io`), kubeconfig parsing, and TLS/CA + client-cert
 * auth are later slices; `fetch` is injectable so this layer is fully testable
 * against a mock API server without any of that.
 */
import type { DuplexChannel } from "@tentacle/transport";
import {
  type ExecChannelOptions,
  type ExecTarget,
  type WebSocketLike,
  buildExecUrl,
  execChannel,
  execSubprotocols,
} from "./exec-channel.ts";
import { type RawExec, type RawExecHandlers, rawExec } from "./exec-raw.ts";
import { type RunExecOptions, type RunExecResult, runExecOverWebSocket } from "./exec-run.ts";
import { type PodTls, spawnPodDelete } from "./pod-cleanup.ts";
import { type Pod, TERMINAL_PHASES, podIsReady } from "./types.ts";

/** Thrown when the API server returns a non-2xx response. */
export class KubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`kubernetes API request failed with status ${status}: ${body.slice(0, 300)}`);
    this.name = "KubeApiError";
  }
}

export interface KubeClientOptions {
  /** API server base URL, e.g. `https://api.cluster:6443`. No trailing slash. */
  readonly server: string;
  /** Namespace all operations run against. */
  readonly namespace: string;
  /** Bearer token (one supported auth mode in this slice). */
  readonly token?: string;
  /**
   * Cluster TLS material (CA trust / client cert / key / insecure flag) carried
   * from `loadKubeClientOptions`. The async `fetch` already bakes this in, but
   * the delete-on-exit child process needs it explicitly to issue its own
   * (out-of-process) `DELETE`. Undefined for a plain non-TLS server.
   */
  readonly tls?: PodTls;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injectable WebSocket factory, for tests. Defaults to the global `WebSocket`. */
  readonly makeWebSocket?: (url: string, protocols: string[]) => WebSocketLike;
  /**
   * How long `execRefusal` waits for the apiserver's reason before giving up
   * (default below; a test seam). It runs on a failure path, so it must never
   * hang the error report (review round 1, MEDIUM 3).
   */
  readonly refusalTimeoutMs?: number;
}

export interface WaitForReadyOptions {
  /** Give up after this long (ms). Default 120000. */
  readonly timeoutMs?: number;
  /** Poll interval (ms). Default 1000. */
  readonly intervalMs?: number;
  /** Abort the wait (also aborts the in-flight poll). */
  readonly signal?: AbortSignal;
}

/** `execRefusal`'s deadline: enough for a healthy apiserver, never a hang. */
export const REFUSAL_TIMEOUT_MS = 5_000;

/** Resolve after `ms`, or reject if `signal` aborts first. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export class KubeClient {
  private readonly server: string;
  private readonly namespace: string;
  private readonly token?: string;
  private readonly tls?: PodTls;
  private readonly doFetch: typeof fetch;
  private readonly makeWebSocket: (url: string, protocols: string[]) => WebSocketLike;
  /** How long `execRefusal` waits before giving up on the apiserver's reason. */
  private readonly refusalTimeoutMs: number;

  constructor(options: KubeClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.namespace = options.namespace;
    if (options.token !== undefined) {
      this.token = options.token;
    }
    this.doFetch = options.fetch ?? fetch;
    this.refusalTimeoutMs = options.refusalTimeoutMs ?? REFUSAL_TIMEOUT_MS;
    this.tls = options.tls;
    this.makeWebSocket =
      options.makeWebSocket ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
  }

  /** `/api/v1/namespaces/<ns>/pods[/<name>]`. */
  private podsUrl(name?: string): string {
    const base = `${this.server}/api/v1/namespaces/${encodeURIComponent(this.namespace)}/pods`;
    return name ? `${base}/${encodeURIComponent(name)}` : base;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) {
      h.authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  /** Create a pod; returns the object the server accepted (with its status). */
  async createPod(pod: Pod, signal?: AbortSignal): Promise<Pod> {
    const res = await this.doFetch(this.podsUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(pod),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new KubeApiError(res.status, await safeText(res));
    }
    return (await res.json()) as Pod;
  }

  /** Fetch a pod's current state. */
  async getPod(name: string, signal?: AbortSignal): Promise<Pod> {
    const res = await this.doFetch(this.podsUrl(name), {
      method: "GET",
      headers: this.headers(),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new KubeApiError(res.status, await safeText(res));
    }
    return (await res.json()) as Pod;
  }

  /** Delete a pod. A 404 is treated as success (the delete is idempotent). */
  async deletePod(name: string, signal?: AbortSignal): Promise<void> {
    const res = await this.doFetch(this.podsUrl(name), {
      method: "DELETE",
      headers: this.headers(),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok && res.status !== 404) {
      throw new KubeApiError(res.status, await safeText(res));
    }
  }

  /**
   * Best-effort, non-blocking pod delete that survives `process.exit` — the
   * Ctrl+C / SIGTERM safety net. Spawns a detached `bun -e` child that issues
   * the `DELETE` and self-terminates on a timeout; it is `unref`'d so it never
   * delays the parent's exit. Never throws. See `pod-cleanup.ts`.
   */
  deletePodBestEffort(name: string): void {
    spawnPodDelete({
      server: this.server,
      namespace: this.namespace,
      podName: name,
      ...(this.token ? { token: this.token } : {}),
      ...(this.tls ? { tls: this.tls } : {}),
    });
  }

  /**
   * Poll until the pod is Ready, or reject. Rejects early if the pod reaches a
   * terminal phase (Succeeded/Failed) — it will never become Ready — or when the
   * timeout elapses / the signal aborts.
   */
  async waitForReady(name: string, options: WaitForReadyOptions = {}): Promise<Pod> {
    const timeoutMs = options.timeoutMs ?? 120000;
    const intervalMs = options.intervalMs ?? 1000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pod = await this.getPod(name, options.signal);
      if (podIsReady(pod)) {
        return pod;
      }
      const phase = pod.status?.phase;
      if (phase !== undefined && TERMINAL_PHASES.has(phase)) {
        throw new Error(`pod ${name} reached terminal phase ${phase} before becoming ready`);
      }
      if (Date.now() + intervalMs > deadline) {
        throw new Error(
          `pod ${name} did not become ready within ${timeoutMs}ms (phase ${phase ?? "unknown"})`,
        );
      }
      await delay(intervalMs, options.signal);
    }
  }

  /**
   * Open an exec WebSocket to `target` and return it as a `DuplexChannel` an
   * `RpcPeer` can ride. The command is typically the pod daemon, e.g.
   * `["tentacle", "serve", "--stdio"]`.
   */
  openExec(target: ExecTarget, options: ExecChannelOptions = {}): DuplexChannel {
    const url = buildExecUrl(this.server, this.namespace, target);
    const ws = this.makeWebSocket(url, execSubprotocols(this.token));
    return execChannel(ws, options);
  }

  /**
   * Run a one-shot command in the pod and resolve when it EXITS (with its exit
   * code + captured stdout/stderr), or reject on timeout / a close without a
   * status. `input` streams raw bytes to the command's stdin (the binary
   * transfer). Unlike `openExec`, this returns a `Promise` that settles on the
   * command's exit — it is for one-shot commands, not an RPC channel.
   */
  runExec(
    target: ExecTarget,
    input?: Uint8Array,
    options?: RunExecOptions,
  ): Promise<RunExecResult> {
    const url = buildExecUrl(this.server, this.namespace, target);
    return runExecOverWebSocket(
      this.makeWebSocket,
      url,
      execSubprotocols(this.token),
      input,
      options,
    );
  }

  /**
   * Open a **raw byte** exec to `target` for a long-lived, non-interactive
   * process (a `sh` that `workload_shell` drives): stdout/stderr as bytes, stdin
   * written raw. Unlike `openExec` (JSON-line RPC frames) there is no framing
   * beyond the channel byte; unlike `runExec` the stream stays open and its end
   * is a callback, not a resolved promise
   * (docs/feat/workload-shell.md D1).
   */
  openRawExec(target: ExecTarget, handlers: RawExecHandlers = {}): RawExec {
    const url = buildExecUrl(this.server, this.namespace, target);
    const ws = this.makeWebSocket(url, execSubprotocols(this.token));
    return rawExec(ws, handlers);
  }

  /**
   * Ask the apiserver WHY it refused an exec upgrade, over plain HTTP
   * (docs/fix/workload-shell-live.md D3).
   *
   * Bun's WebSocket drops both the HTTP status and the body of a refused upgrade
   * (only `error "Expected 101 status code"` + `close 1002` reach us), so the
   * only way to read the real reason is to re-ask. The apiserver checks
   * authentication, authorization (RBAC, SCC admission) and the target
   * `container` BEFORE it demands the upgrade, so a non-2xx answer here carries
   * the same `Status` the upgrade was refused with. The same URL, the same auth,
   * no upgrade — and no process ever runs.
   *
   * Never throws; `undefined` means "no reason available": 2xx (nothing to
   * explain), the generic `Upgrade request required` (the URL was ACCEPTABLE, so
   * the refusal was something else), a body that is not a k8s `Status`, or a
   * network failure.
   */
  async execRefusal(target: ExecTarget): Promise<string | undefined> {
    const url = buildExecUrl(this.server, this.namespace, target).replace(/^ws/, "http");
    let res: Response;
    // BOUNDED. This runs on the FAILURE path, where something is already wrong
    // (an apiserver or a proxy that accepts the POST and never answers), and
    // `explain` awaits it with nothing else to race against — an unbounded
    // fetch would hang the tool's error report forever (review round 1, MEDIUM 3).
    const timeoutMs = this.refusalTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await this.doFetch(url, {
        method: "POST",
        headers: this.headers(),
        signal: controller.signal,
      });
    } catch {
      return undefined; // unreachable, or timed out: nothing to report
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      return undefined;
    }
    const body = await safeText(res);
    const message = statusMessage(body);
    if (message === undefined) {
      return undefined;
    }
    // `Upgrade request required` is the apiserver SAYING the request was fine
    // apart from the missing upgrade: it explains nothing about our failure.
    if (/upgrade request required/i.test(message)) {
      return undefined;
    }
    return message;
  }
}

/** A k8s `Status` body's `message`, when the body is one. */
function statusMessage(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const shape = parsed as { kind?: unknown; status?: unknown; message?: unknown } | null;
  if (shape === null || typeof shape !== "object" || typeof shape.message !== "string") {
    return undefined;
  }
  // A `Status` names itself (`kind: "Status"`) or at least carries `status`;
  // anything else (an HTML error page, a proxy's JSON) is not ours to read.
  if (shape.kind !== "Status" && typeof shape.status !== "string") {
    return undefined;
  }
  return shape.message === "" ? undefined : shape.message;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
