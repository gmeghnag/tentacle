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
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
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
  private readonly doFetch: typeof fetch;

  constructor(options: KubeClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.namespace = options.namespace;
    if (options.token !== undefined) {
      this.token = options.token;
    }
    this.doFetch = options.fetch ?? fetch;
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
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
