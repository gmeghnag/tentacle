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
}

export interface WaitForReadyOptions {
  /** Give up after this long (ms). Default 120000. */
  readonly timeoutMs?: number;
  /** Poll interval (ms). Default 1000. */
  readonly intervalMs?: number;
  /** Abort the wait (also aborts the in-flight poll). */
  readonly signal?: AbortSignal;
}

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

  constructor(options: KubeClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.namespace = options.namespace;
    if (options.token !== undefined) {
      this.token = options.token;
    }
    this.doFetch = options.fetch ?? fetch;
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
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
